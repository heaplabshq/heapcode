import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RpcPeer } from '@heapcode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NOTES_METHODS,
  NotesSession,
  pendingFocus,
  requestFocus,
  type NoteOpenResult,
  type NoteSaveResult,
} from '../src/index.js';

let root: string;
let session: NotesSession;
let handlers: Map<string, (p: unknown) => Promise<unknown>>;
let notified: { method: string; params: unknown }[];

function ask<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const h = handlers.get(method);
  if (!h) throw new Error(`no handler for ${method}`);
  return h(params) as Promise<T>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'heapnotes-session-'));
  session = new NotesSession({ basePath: '/notes', vault: root, indexFile: ':memory:' });
  handlers = new Map();
  notified = [];
  const peer = {
    onRequest: (m: string, h: (p: unknown) => Promise<unknown>) => handlers.set(m, h),
    notify: (method: string, params: unknown) => notified.push({ method, params }),
  } as unknown as RpcPeer;
  session.attach(peer);
});

afterEach(async () => {
  await session.close();
  rmSync(root, { recursive: true, force: true });
});

describe('NotesSession', () => {
  it('creates an empty titled note in the current tag, saves it, and lists it', async () => {
    const created = await ask<NoteOpenResult>(NOTES_METHODS.create, { tag: 'work/q3' });
    expect(created.content).toBe('# \n#work/q3\n');
    const saved = await ask<NoteSaveResult>(NOTES_METHODS.save, {
      id: created.note.id,
      content: '# Plan\n#work/q3\n',
      base: created.hash,
    });
    expect(saved).toMatchObject({ ok: true, note: { title: 'Plan', path: 'Plan.md' } });
    const page = await ask<{ notes: { title: string }[] }>(NOTES_METHODS.list, { tag: 'work' });
    expect(page.notes.map((n) => n.title)).toEqual(['Plan']);
  });

  it('answers a stale save with the conflict and the current text, not an error', async () => {
    const n = await ask<NoteOpenResult>(NOTES_METHODS.create, { text: '# A\nv1\n' });
    await ask(NOTES_METHODS.save, { id: n.note.id, content: '# A\nv2\n', base: n.hash });
    const stale = await ask<NoteSaveResult>(NOTES_METHODS.save, {
      id: n.note.id,
      content: '# A\nmine\n',
      base: n.hash,
    });
    expect(stale).toMatchObject({ ok: false, conflict: true, content: '# A\nv2\n' });
  });

  it('follows a [[link]], making the note when there is none', async () => {
    const r = await ask<NoteOpenResult>(NOTES_METHODS.followLink, { target: 'Ideas#Later' });
    expect(r.note.title).toBe('Ideas');
    const again = await ask<NoteOpenResult>(NOTES_METHODS.followLink, { target: 'ideas' });
    expect(again.note.id).toBe(r.note.id);
  });

  it('searches when there is a query, inside the tag', async () => {
    writeFileSync(join(root, 'A.md'), '# A\nroadmap #work\n');
    writeFileSync(join(root, 'B.md'), '# B\nroadmap #home\n');
    const page = await ask<{ notes: { title: string; snippet?: string }[] }>(NOTES_METHODS.list, {
      tag: 'work',
      query: 'road',
    });
    expect(page.notes.map((n) => n.title)).toEqual(['A']);
    expect(page.notes[0]!.snippet).toContain('**roadmap**');
  });

  it('serves vault images but never notes or anything outside', async () => {
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'a b.png'), 'png');
    writeFileSync(join(root, 'N.md'), '# N\n');
    expect(await session.attachment('assets/a b.png')).toMatchObject({ mediaType: 'image/png' });
    expect(await session.attachment('N.md')).toBeUndefined();
    expect(await session.attachment('../x.png')).toBeUndefined();
  });

  it('tells the page about edits made in another app', async () => {
    const n = await ask<NoteOpenResult>(NOTES_METHODS.create, { text: '# Watched\n' });
    appendFileSync(join(root, n.note.path), 'outside\n');
    for (let i = 0; i < 40 && notified.length === 0; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(notified[0]).toEqual({ method: NOTES_METHODS.changed, params: { ids: [n.note.id] } });
  });

  it('shows a note an agent asked for with open_note, and says so', async () => {
    const n = await ask<NoteOpenResult>(NOTES_METHODS.create, { text: '# Shown\n' });
    const shown = await requestFocus(root, n.note.id, 3000);
    expect(shown).toBe(true);
    expect(notified).toContainEqual({ method: NOTES_METHODS.focus, params: { id: n.note.id } });
    // Answered once: a page opened later doesn't jump to it.
    expect(pendingFocus(root)).toBeUndefined();
  });
});

describe('open_note with no app', () => {
  it('reports not shown, and the request goes stale', async () => {
    const lone = mkdtempSync(join(tmpdir(), 'heapnotes-focus-'));
    expect(await requestFocus(lone, 'X', 300)).toBe(false);
    expect(pendingFocus(lone)?.id).toBe('X');
    expect(pendingFocus(lone, Date.now() + 60_000)).toBeUndefined();
    rmSync(lone, { recursive: true, force: true });
  });
});
