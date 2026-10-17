import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Vault,
  importBear,
  importBearExport,
  importMarkdownFolder,
  importObsidian,
  readFrontMatter,
  type BearCli,
} from '../src/index.js';

let base: string;
let src: string;
let vault: Vault;

function put(root: string, rel: string, data: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), data);
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'heapnotes-import-'));
  src = join(base, 'src');
  mkdirSync(src);
  vault = await Vault.open({ root: join(base, 'vault'), indexFile: ':memory:', staleMs: 0 });
});

afterEach(() => {
  vault.close();
  rmSync(base, { recursive: true, force: true });
});

describe('Markdown folder', () => {
  it('copies notes with their layout, ids, dates and linked files; leaves the source alone', async () => {
    put(src, 'Top.md', '# Top\n![](img/a.png) [doc](../outside.pdf)\n');
    put(src, 'img/a.png', 'png');
    put(src, 'img/unused.png', 'png');
    put(src, 'deep/Inner.md', '---\nid: KEEP\n---\n# Inner\n');
    put(src, '.hidden/Skip.md', '# Skip\n');
    const old = new Date('2024-01-02T03:04:05Z');
    utimesSync(join(src, 'Top.md'), old, old);

    const r = await importMarkdownFolder(vault, src);
    expect(r).toEqual({ notes: 2, attachments: 1, skipped: [] });
    expect(readFileSync(join(src, 'Top.md'), 'utf8')).toBe(
      '# Top\n![](img/a.png) [doc](../outside.pdf)\n',
    );
    const top = readFileSync(join(vault.root, 'Top.md'), 'utf8');
    expect(readFrontMatter(top).data.id).toMatch(/^[0-9A-F-]{36}$/);
    expect(existsSync(join(vault.root, 'img/a.png'))).toBe(true);
    expect(existsSync(join(vault.root, 'img/unused.png'))).toBe(false);
    expect((await vault.get({ id: 'KEEP' })).path).toBe('deep/Inner.md');
    expect(statSync(join(vault.root, 'Top.md')).mtime.toISOString()).toBe(old.toISOString());
    expect((await vault.get({ path: 'Top.md' })).modified).toBe(old.toISOString());
  });

  it('imports into a folder and never overwrites what is there', async () => {
    put(vault.root, 'in/A.md', '# mine\n');
    put(src, 'A.md', '# theirs\n');
    await importMarkdownFolder(vault, src, { into: 'in' });
    expect(readFileSync(join(vault.root, 'in/A.md'), 'utf8')).toBe('# mine\n');
    expect(readFileSync(join(vault.root, 'in/A 2.md'), 'utf8')).toContain('# theirs');
  });

  it('refuses a source inside the vault', async () => {
    await expect(importMarkdownFolder(vault, join(vault.root, 'x'))).rejects.toThrow();
  });
});

describe('Obsidian', () => {
  it('brings every attachment and skips .obsidian', async () => {
    put(src, '.obsidian/app.json', '{}');
    put(
      src,
      'Daily/2026-10-18.md',
      '---\ntags: [journal]\n---\nToday ![[photo.jpg]] and [[Project]]\n',
    );
    put(src, 'Project.md', '# Project\n');
    put(src, 'attachments/photo.jpg', 'jpg');
    const r = await importObsidian(vault, src);
    expect(r).toMatchObject({ notes: 2, attachments: 1 });
    expect(existsSync(join(vault.root, '.obsidian'))).toBe(false);
    const daily = await vault.get({ path: 'Daily/2026-10-18.md' });
    expect(daily.tags).toEqual(['journal']);
    expect(daily.hasImages).toBe(true);
    expect(daily.links[0]!.id).toBe((await vault.get({ title: 'Project' })).id);
    expect((await vault.listAttachments({ id: daily.id })).map((a) => a.path)).toEqual([
      'attachments/photo.jpg',
    ]);
  });
});

describe('Bear', () => {
  const notes = [
    {
      id: 'B-1',
      title: 'Welcome',
      created: '2025-01-01T00:00:00Z',
      modified: '2025-02-01T00:00:00Z',
      pins: ['global'],
      locked: 'no',
      location: 'notes',
      attachments: ['My Pic.png'],
      content: '# Welcome\n#bear\n![](My%20Pic.png)\n',
    },
    {
      id: 'B-2',
      title: 'Old',
      created: '2025-01-01T00:00:00Z',
      modified: '2025-01-01T00:00:00Z',
      pins: [],
      location: 'archive',
      attachments: [],
      content: '# Old\n',
    },
    {
      id: 'B-3',
      title: 'Gone',
      created: '2025-01-01T00:00:00Z',
      modified: '2025-01-01T00:00:00Z',
      pins: [],
      location: 'trash',
      attachments: [],
      content: '# Gone\n',
    },
    { id: 'B-4', title: 'Secret', locked: 'yes', location: 'notes', content: '' },
  ];
  const cli: BearCli = async (args) => {
    if (args[0] === 'list') return Buffer.from(JSON.stringify(notes));
    if (args[0] === 'attachments' && args[1] === 'save') return Buffer.from(`bytes of ${args[4]}`);
    throw new Error(`unexpected ${args.join(' ')}`);
  };

  it('imports through bearcli with dates, pins, archive, trash and attachments', async () => {
    const r = await importBear(vault, { cli });
    expect(r.notes).toBe(3);
    expect(r.attachments).toBe(1);
    expect(r.skipped).toEqual([{ source: 'Secret', reason: 'locked in Bear' }]);

    const welcome = await vault.get({ id: 'B-1' });
    expect(welcome).toMatchObject({
      pinned: true,
      tags: ['bear'],
      created: '2025-01-01T00:00:00.000Z',
      modified: '2025-02-01T00:00:00.000Z',
      hasImages: true,
    });
    expect((await vault.read({ id: 'B-1' })).content).toContain('![](assets/My%20Pic.png)');
    expect(readFileSync(join(vault.root, 'assets/My Pic.png'), 'utf8')).toBe('bytes of My Pic.png');
    expect((await vault.get({ id: 'B-2' })).location).toBe('archive');
    expect((await vault.get({ id: 'B-3' })).path).toBe('.trash/Gone.md');
  });

  it('skips what it already imported when run again', async () => {
    await importBear(vault, { cli });
    const again = await importBear(vault, { cli });
    expect(again.notes).toBe(0);
    expect(again.skipped.filter((s) => s.reason === 'already imported')).toHaveLength(3);
  });

  it('says how to export instead when bearcli is missing', async () => {
    const missing: BearCli = async () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    };
    await expect(importBear(vault, { cli: missing })).rejects.toThrow(/File → Export Notes/);
  });

  it('imports a Bear export folder, TextBundles included', async () => {
    put(src, 'Plain.md', '# Plain\n![](Plain/x.png)\n');
    put(src, 'Plain/x.png', 'x');
    put(src, 'Bundled.textbundle/text.md', '# Bundled\n![](assets/pic%201.png)\n');
    put(src, 'Bundled.textbundle/assets/pic 1.png', 'p');
    put(src, 'Bundled.textbundle/info.json', '{}');
    const r = await importBearExport(vault, src);
    expect(r).toMatchObject({ notes: 2, attachments: 2 });
    expect((await vault.read({ title: 'Bundled' })).content).toContain('![](assets/pic%201.png)');
    expect(existsSync(join(vault.root, 'assets/pic 1.png'))).toBe(true);
    expect((await vault.listAttachments({ title: 'Plain' })).map((a) => a.path)).toEqual([
      'Plain/x.png',
    ]);
  });
});
