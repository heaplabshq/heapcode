import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault, relatedNotes } from '../src/index.js';

let root: string;
let vault: Vault;

function put(rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'heapnotes-related-'));
  put('Trip.md', '---\nid: TRIP\n---\n# Trip\nPorto in spring #travel\nSee [[Budget]].\n');
  put('Budget.md', '---\nid: BUDGET\n---\n# Budget\nNumbers.\n');
  put('Hotels.md', '---\nid: HOTELS\n---\n# Hotels\nAlso see [[Budget]].\n');
  put('Beaches.md', '---\nid: BEACH\n---\n# Beaches\nAlgarve #travel\n');
  put('Linked.md', '---\nid: LINKED\n---\n# Linked\nPoints at [[Trip]] #travel\n');
  put('Coast.md', '---\nid: COAST\n---\n# Coast\nThe sea.\n');
  put('Other.md', '---\nid: OTHER\n---\n# Other\nUnrelated.\n');
  vault = await Vault.open({ root, indexFile: ':memory:', staleMs: 0 });
});

afterEach(() => {
  vault.close();
  rmSync(root, { recursive: true, force: true });
});

describe('relatedNotes', () => {
  it('finds notes sharing a link or a tag, saying why, and skips ones already linked', async () => {
    const r = await relatedNotes(vault, 'TRIP');
    expect(r.map((n) => [n.id, n.reason])).toEqual([
      ['HOTELS', 'Also links to Budget'],
      ['BEACH', 'Also tagged #travel'],
    ]);
  });

  it('puts close-in-meaning first, leaving out the note itself', async () => {
    const semantic = async () =>
      [
        '--- Trip.md:1-5 (score 1.00) ---\n# Trip',
        '--- Coast.md:1-4 (score 0.70) ---\n# Coast',
        '--- Other.md:1-4 (score 0.30) ---\n# Other',
        '--- Budget.md:1-4 (score 0.31) ---\n# Budget',
        '--- Beaches.md:1-4 (score 0.32) ---\n# Beaches',
      ].join('\n\n');
    const r = await relatedNotes(vault, 'TRIP', semantic);
    expect(r[0]).toMatchObject({ id: 'COAST', kind: 'meaning', reason: 'Similar in meaning' });
    expect(r.map((n) => n.id)).not.toContain('TRIP');
    expect(r.map((n) => n.id)).not.toContain('OTHER');
  });
});
