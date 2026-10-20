import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolResult } from '@heapcode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CHANGES_PER_QUESTION, Vault, notesPersona, visibleHits } from '../src/index.js';

let root: string;
let vault: Vault;
let view: Vault;

function put(rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const call = (name: string, args: Record<string, unknown>) => ({ id: 'c1', name, args });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'heapnotes-ask-'));
  put('Plan.md', '---\nid: PLAN\n---\n# Plan\nLaunch on Friday.\n');
  put('Diary.md', '---\nid: DIARY\n---\n# Diary\n#private\nLaunch nerves.\n');
  vault = await Vault.open({ root, indexFile: ':memory:', staleMs: 0 });
  view = vault.scoped({ excludeTags: ['private'] });
});

afterEach(() => {
  vault.close();
  rmSync(root, { recursive: true, force: true });
});

const persona = () => notesPersona({ vault: () => view, hiddenTags: () => ['private'] });
const noSearch = {
  vision: true,
  semanticSearch: async (): Promise<ToolResult> => ({
    id: 'x',
    name: 'semantic_search',
    content: '',
  }),
};

describe('the notes persona', () => {
  it('offers reads and changes, and asks only for changes', () => {
    const p = persona();
    const names = p.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'search_by_meaning',
        'search_notes',
        'read_note',
        'edit_note',
        'create_note',
      ]),
    );
    expect(names).not.toContain('trash_note');
    expect(names).not.toContain('delete_tag');
    expect(p.permission(call('read_note', {}))).toBe('grant');
    expect(p.permission(call('edit_note', {}))).toBe('ask');
  });

  it('cannot read a hidden note, by any tool', async () => {
    const p = persona();
    const read = await p.execute(call('read_note', { id: 'DIARY' }), noSearch);
    expect(read.isError).toBe(true);
    const search = await p.execute(call('search_notes', { query: 'launch' }), noSearch);
    expect(JSON.parse(search.content).notes.map((n: { id: string }) => n.id)).toEqual(['PLAN']);
  });

  it('drops hidden, trashed and non-note hits from meaning search, and names the note', async () => {
    const raw = [
      '--- Plan.md:1-3 (score 0.91) ---\nLaunch on Friday.',
      '--- Diary.md:1-3 (score 0.88) ---\nLaunch nerves.',
      '--- assets/notes.txt:1-1 (score 0.5) ---\nstray',
    ].join('\n\n');
    const out = await visibleHits(view, raw);
    expect(out).toBe('--- Plan (id PLAN, lines 1-3) ---\nLaunch on Friday.');
    const p = persona();
    const r = await p.execute(call('search_by_meaning', { query: 'launch' }), {
      vision: false,
      semanticSearch: async () => ({ id: 'x', name: 'semantic_search', content: raw }),
    });
    expect(r.content).not.toContain('nerves');
  });

  it('previews a change as a diff, and refuses one that cannot apply', async () => {
    const p = persona();
    const prev = await p.preview!(
      call('edit_note', { id: 'PLAN', find: 'Friday', replace: 'Monday' }),
    );
    expect(prev).toEqual({
      title: 'Edit “Plan”',
      before: '# Plan\nLaunch on Friday.\n',
      after: '# Plan\nLaunch on Monday.\n',
    });
    await expect(
      p.preview!(call('edit_note', { id: 'PLAN', find: 'Sunday', replace: 'x' })),
    ).rejects.toThrow(/isn't in/);
    await expect(
      p.preview!(call('edit_note', { id: 'DIARY', find: 'nerves', replace: 'x' })),
    ).rejects.toThrow();
  });

  it('runs an applied change through the vault', async () => {
    const p = persona();
    const r = await p.execute(
      call('edit_note', { id: 'PLAN', find: 'Friday', replace: 'Monday' }),
      noSearch,
    );
    expect(r.isError).toBeFalsy();
    expect((await vault.read({ id: 'PLAN' })).content).toContain('Monday');
  });

  it('stops a question after a few changes, and starts again on the next', async () => {
    const p = persona();
    const edit = (n: number) =>
      p.execute(call('append_to_note', { id: 'PLAN', text: `line ${n}` }), noSearch);
    await p.turnContext!();
    for (let n = 0; n < MAX_CHANGES_PER_QUESTION; n++) expect((await edit(n)).isError).toBeFalsy();
    // No Apply card for a call that will only be refused.
    expect(p.permission(call('edit_note', {}))).toBe('grant');
    const over = await edit(99);
    expect(over.isError).toBe(true);
    expect(over.content).toMatch(/finish now/);
    expect((await vault.read({ id: 'PLAN' })).content).not.toContain('line 99');
    await p.turnContext!();
    expect(p.permission(call('edit_note', {}))).toBe('ask');
    expect((await edit(100)).isError).toBeFalsy();
  });

  it('applies changes without asking when the person turned Apply off', () => {
    const p = notesPersona({ vault: () => view, hiddenTags: () => [], autoApply: () => true });
    expect(p.permission(call('edit_note', {}))).toBe('grant');
  });

  it("shows the model a note's image, and only when it can see", async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    put('assets/chart.png', png.toString('latin1'));
    writeFileSync(join(root, 'assets/chart.png'), png);
    put('Plan.md', '---\nid: PLAN\n---\n# Plan\nLaunch on Friday.\n![](assets/chart.png)\n');
    put('Diary.md', '---\nid: DIARY\n---\n# Diary\n#private\n![](assets/chart.png)\n');
    const p = persona();
    const seen = await p.execute(
      call('view_image', { id: 'PLAN', filename: 'chart.png' }),
      noSearch,
    );
    expect(seen.isError).toBeFalsy();
    expect(seen.images).toEqual([`data:image/png;base64,${png.toString('base64')}`]);
    const blind = await p.execute(call('view_image', { id: 'PLAN', filename: 'chart.png' }), {
      ...noSearch,
      vision: false,
    });
    expect(blind.isError).toBe(true);
    expect(blind.images).toBeUndefined();
    const hidden = await p.execute(
      call('view_image', { id: 'DIARY', filename: 'chart.png' }),
      noSearch,
    );
    expect(hidden.isError).toBe(true);
  });

  it('asked over a tag, sees only notes with it, and says so', async () => {
    put('Trip.md', '---\nid: TRIP\n---\n# Trip\n#travel/japan\nKyoto launch.\n');
    const p = notesPersona({
      vault: () => vault.scoped({ excludeTags: ['private'], onlyTags: ['travel'] }, 'ask'),
      hiddenTags: () => ['private'],
      scopeTag: () => 'travel',
      openNote: () => 'PLAN',
    });
    const context = await p.turnContext!();
    expect(context).toMatch(/tagged #travel/);
    // The open note isn't in the tag, so it isn't named either.
    expect(context).not.toMatch(/Plan/);
    const search = await p.execute(call('search_notes', { query: 'launch' }), noSearch);
    expect(JSON.parse(search.content).notes.map((n: { id: string }) => n.id)).toEqual(['TRIP']);
    expect((await p.execute(call('read_note', { id: 'PLAN' }), noSearch)).isError).toBe(true);
  });

  it('says what is hidden in its prompt, and cites notes as links', () => {
    const prompt = persona().systemPrompt();
    expect(prompt).toContain('#private');
    expect(prompt).toContain('[[Note title]]');
  });
});

describe('asking about the open note', () => {
  it('names the open note with each question', async () => {
    const p = notesPersona({
      vault: () => view,
      hiddenTags: () => ['private'],
      openNote: () => 'PLAN',
    });
    expect(await p.turnContext!()).toMatch(
      /open the note "Plan" \(id PLAN\)|note "Plan" \(id PLAN\) open/,
    );
  });

  it('says nothing about a hidden note, or when none is open', async () => {
    const hidden = notesPersona({
      vault: () => view,
      hiddenTags: () => ['private'],
      openNote: () => 'DIARY',
    });
    expect(await hidden.turnContext!()).toBeUndefined();
    const none = notesPersona({
      vault: () => view,
      hiddenTags: () => ['private'],
      openNote: () => undefined,
    });
    expect(await none.turnContext!()).toBeUndefined();
  });
});

describe('closeEnough (related by meaning)', () => {
  it('keeps what stands out, on any model’s scale', async () => {
    const { closeEnough } = await import('../src/related.js');
    const hits = (s: number[]) => s.map((score, i) => ({ score, i }));
    // nomic-like: the right note well above a bunch near 0.4.
    expect(closeEnough(hits([0.658, 0.479, 0.41, 0.399, 0.391])).map((h) => h.i)).toEqual([0]);
    // Same shape, a lower scale.
    expect(closeEnough(hits([0.33, 0.18, 0.12, 0.11, 0.1])).map((h) => h.i)).toEqual([0]);
    // Two that both stand out.
    expect(closeEnough(hits([0.68, 0.62, 0.4, 0.35, 0.33])).map((h) => h.i)).toEqual([0, 1]);
    // Too few to average: near the best.
    expect(closeEnough(hits([0.6, 0.55, 0.3])).map((h) => h.i)).toEqual([0, 1]);
  });

  it('drops front matter from a passage', async () => {
    const out = await visibleHits(
      view,
      '--- Plan.md:1-6 (score 0.9) ---\n---\nid: PLAN\n---\n# Plan\nLaunch on Friday.',
    );
    expect(out).toBe('--- Plan (id PLAN, lines 1-6) ---\n# Plan\nLaunch on Friday.');
  });
});
