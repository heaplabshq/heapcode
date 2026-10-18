import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault, importNotion, parseCsv, readFrontMatter, zip } from '../src/index.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const D = 'd'.repeat(32);
const R = '1'.repeat(32);

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'heapnotes-notion-'));
  vault = await Vault.open({ root: join(dir, 'vault'), indexFile: ':memory:', staleMs: 0 });
});
afterEach(() => {
  vault.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A Notion "Markdown & CSV" export, zipped inside a zip as large ones are. */
function exportZip(): string {
  const files: Record<string, string | Buffer> = {
    [`Export-1234/Private & Shared/Plans ${A}.md`]: [
      '# Plans',
      '',
      `See [Trip](Plans%20${A}/Trip%20${B}.md) and [the tracker](https://www.notion.so/Tracker-${D}).`,
      '',
      '<aside>',
      '💡 Book early.',
      '</aside>',
    ].join('\n'),
    [`Export-1234/Private & Shared/Plans ${A}/Trip ${B}.md`]: `# Trip\n\n![map](Trip%20${B}/map.png)\n`,
    [`Export-1234/Private & Shared/Plans ${A}/Trip ${B}/map.png`]: Buffer.from('png'),
    [`Export-1234/Private & Shared/Tracker ${D}.csv`]: 'Name,Status\nKyoto,Done\n',
    [`Export-1234/Private & Shared/Tracker ${D}_all.csv`]:
      'Name,Status,Notes\nKyoto,Done,"has, comma"\n"Osaka ""2""",Todo,\n',
    [`Export-1234/Private & Shared/Tracker ${D}/Kyoto ${R}.md`]: '# Kyoto\n\nStatus: Done\n',
  };
  const inner = zip(
    Object.entries(files).map(([path, data]) => ({ path, data: Buffer.from(data) })),
  );
  const outer = zip([{ path: 'Export-1234-Part-1.zip', data: inner }]);
  const file = join(dir, 'Export.zip');
  writeFileSync(file, outer);
  return file;
}

describe('parseCsv', () => {
  it('reads quotes, doubled quotes, commas and line breaks inside cells', () => {
    expect(parseCsv('﻿a,b\n"x, y","say ""hi""\nthere"\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ]);
  });
});

describe('importNotion', () => {
  it('cleans names, links pages, keeps images, tables databases, and skips a second time', async () => {
    const file = exportZip();
    const r = await importNotion(vault, file);
    expect(r).toEqual({ notes: 4, attachments: 1, skipped: [] });

    const read = (rel: string) => readFileSync(join(vault.root, rel), 'utf8');
    const plans = read('Plans.md');
    expect(plans).toContain('See [[Trip]] and [[Tracker|the tracker]].');
    expect(plans).toContain('> 💡 Book early.');
    expect(readFrontMatter(plans).data).toMatchObject({ id: `notion-${A}`, source: 'notion' });

    expect(read('Plans/Trip.md')).toContain('![map](Trip/map.png)');
    expect(existsSync(join(vault.root, 'Plans/Trip/map.png'))).toBe(true);

    // The fuller _all.csv, its first column linked where a row page came along.
    expect(read('Tracker.md')).toContain(
      '| Name | Status | Notes |\n| --- | --- | --- |\n| [[Kyoto]] | Done | has, comma |\n| Osaka "2" | Todo |  |',
    );
    expect(read('Tracker/Kyoto.md')).toContain('Status: Done');

    const again = await importNotion(vault, file);
    expect(again.notes).toBe(0);
    expect(again.skipped.map((s) => s.reason)).toEqual(Array(4).fill('already imported'));
    expect(again.skipped.map((s) => s.source)).toContain('Plans/Trip.md');
  });

  it('says so when a folder is not a Notion export', async () => {
    await expect(importNotion(vault, dir)).rejects.toThrow(/Notion export/);
  });
});
