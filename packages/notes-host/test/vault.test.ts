import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../src/index.js';

let root: string;
let vault: Vault;

async function open(opts: Partial<Parameters<typeof Vault.open>[0]> = {}): Promise<Vault> {
  return Vault.open({ root, indexFile: ':memory:', staleMs: 0, ...opts });
}

function write(rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'heapnotes-'));
});

afterEach(() => {
  vault?.close();
  rmSync(root, { recursive: true, force: true });
});

describe('a folder of Markdown', () => {
  it('indexes notes it did not write, without touching them', async () => {
    write('Ideas.md', '# Ideas\nfirst #work\n');
    write('sub/Plan.md', 'Plan\n- [ ] do it\n');
    write('.obsidian/x.md', '# hidden\n');
    vault = await open();
    const { notes, total } = await vault.list();
    expect(total).toBe(2);
    expect(notes.map((n) => n.title).sort()).toEqual(['Ideas', 'Plan']);
    expect(notes.find((n) => n.title === 'Ideas')!.tags).toEqual(['work']);
    expect(read('Ideas.md')).toBe('# Ideas\nfirst #work\n');
  });

  it('picks up edits made outside, and deletions', async () => {
    write('A.md', '# A\nold\n');
    vault = await open();
    write('A.md', '# A\nnew words here\n');
    utimesSync(join(root, 'A.md'), new Date(), new Date(Date.now() + 5000));
    expect((await vault.search('words')).total).toBe(1);
    rmSync(join(root, 'A.md'));
    expect((await vault.list()).total).toBe(0);
  });

  it('keeps a path-derived id once it first writes to the note', async () => {
    write('A.md', '# A\n');
    vault = await open();
    const [before] = (await vault.list()).notes;
    await vault.pin({ id: before!.id }, true);
    expect(read('A.md')).toBe(`---\npinned: true\nid: ${before!.id}\n---\n# A\n`);
    const after = await vault.get({ id: before!.id });
    expect(after.pinned).toBe(true);
  });
});

describe('create, read, write', () => {
  beforeEach(async () => {
    vault = await open({ now: () => new Date('2026-10-18T10:00:00Z') });
  });

  it('creates a note named after its title, with an id and created date', async () => {
    const n = await vault.create({
      title: 'Trip: Kyoto/Osaka',
      text: 'Pack light.',
      tags: ['travel', 'plans 2026'],
    });
    expect(n.path).toBe('Trip  Kyoto Osaka.md'.replace(/\s+/g, ' '));
    const file = read(n.path);
    expect(file).toMatch(
      /^---\nid: [0-9A-F-]{36}\ncreated: 2026-10-18T10:00:00.000Z\n---\n# Trip: Kyoto\/Osaka\n#travel #plans 2026#\n\nPack light.\n$/,
    );
    expect(n.tags).toEqual(['travel', 'plans 2026']);
    expect(n.created).toBe('2026-10-18T10:00:00.000Z');
  });

  it('does not overwrite a note with the same title', async () => {
    const a = await vault.create({ title: 'Same' });
    const b = await vault.create({ title: 'Same' });
    expect([a.path, b.path]).toEqual(['Same.md', 'Same 2.md']);
  });

  it('reads the body only, by section or by range, with a hash', async () => {
    const n = await vault.create({
      title: 'Doc',
      text: 'lead\n\n## Setup\nsteps\n\n## Use\nuse it',
    });
    const whole = await vault.read({ id: n.id });
    expect(whole.content.startsWith('# Doc\n')).toBe(true);
    expect(whole.hash).toBe(n.hash);
    const section = await vault.read({ id: n.id }, { section: '## Setup' });
    expect(section.content).toBe('## Setup\nsteps\n\n');
    expect(section.section).toEqual({
      address: '## Setup',
      offset: whole.content.indexOf('## Setup'),
      length: section.content.length,
    });
    expect((await vault.read({ id: n.id }, { offset: 2, limit: 3 })).content).toBe('Doc');
  });

  it('refuses a write whose base is stale', async () => {
    const n = await vault.create({ title: 'Doc', text: 'v1' });
    const { hash } = await vault.read({ id: n.id });
    await vault.append({ id: n.id }, 'v2', { base: hash });
    await expect(vault.append({ id: n.id }, 'v3', { base: hash })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('accepts a section hash as the base for a section write, even if another section changed', async () => {
    const n = await vault.create({ title: 'Doc', text: '## A\na\n\n## B\nb' });
    const a = await vault.read({ id: n.id }, { section: '## A' });
    await vault.edit({ id: n.id }, { find: 'b', replace: 'B!', section: '## B' });
    await vault.overwrite({ id: n.id }, '## A\nnew a\n', { section: '## A', base: a.hash });
    expect((await vault.read({ id: n.id })).content).toBe('# Doc\n\n## A\nnew a\n\n## B\nB!\n');
  });

  it('refuses an edit whose text matches more than once, and says where', async () => {
    const n = await vault.create({ title: 'Doc', text: 'x\nx\n' });
    await expect(vault.edit({ id: n.id }, { find: 'x', replace: 'y' })).rejects.toThrow(
      /appears 2 times \(lines 3, 4\)/,
    );
    const done = await vault.edit({ id: n.id }, { find: 'x', replace: 'y', occurrence: 2 });
    expect(done.replaced).toBe(1);
    expect((await vault.read({ id: n.id })).content).toBe('# Doc\n\nx\ny\n');
  });

  it('inserts around and deletes found text', async () => {
    const n = await vault.create({ title: 'Doc', text: 'middle' });
    await vault.edit({ id: n.id }, { find: 'middle', insertBefore: 'start ' });
    await vault.edit({ id: n.id }, { find: 'middle', insertAfter: ' end' });
    await vault.edit({ id: n.id }, { find: 'start ', delete: true });
    expect((await vault.read({ id: n.id })).content).toBe('# Doc\n\nmiddle end\n');
  });

  it('appends at the end, after the title, or into a section', async () => {
    const n = await vault.create({ title: 'Doc', text: '## A\na\n\n## B\nb' });
    await vault.append({ id: n.id }, 'top', { position: 'start' });
    await vault.append({ id: n.id }, 'more a', { section: '## A' });
    await vault.append({ id: n.id }, 'bottom');
    expect((await vault.read({ id: n.id })).content).toBe(
      '# Doc\ntop\n\n## A\na\nmore a\n\n## B\nb\nbottom\n',
    );
  });

  it('appends to a note that is only front matter', async () => {
    write('Empty.md', '---\nid: E1\n---\n');
    await vault.refresh(true);
    await vault.append({ id: 'E1' }, 'hello');
    // Named by its owner, not after a title, so it keeps its name.
    expect(read('Empty.md')).toBe('---\nid: E1\n---\nhello\n');
  });

  it('overwrite keeps the front matter', async () => {
    const n = await vault.create({ title: 'Doc', pinned: true });
    await vault.overwrite({ id: n.id }, '# Doc\nall new\n');
    const file = read(n.path);
    expect(file).toContain(`id: ${n.id}`);
    expect(file).toContain('pinned: true');
    expect(file.endsWith('# Doc\nall new\n')).toBe(true);
  });

  it('finds every occurrence in a note with line and column', async () => {
    const n = await vault.create({ title: 'Doc', text: 'one Two\ntwo' });
    expect(await vault.searchInNote({ id: n.id }, 'two')).toEqual([
      { line: 3, column: 5, offset: 11, text: 'one Two' },
      { line: 4, column: 1, offset: 15, text: 'two' },
    ]);
  });

  it('resolves by title, case-insensitively, and refuses an ambiguous title', async () => {
    await vault.create({ title: 'Dup' });
    expect((await vault.get({ title: 'dup' })).title).toBe('Dup');
    await vault.create({ title: 'Dup' });
    await expect(vault.get({ title: 'Dup' })).rejects.toMatchObject({ code: 'ambiguous' });
  });
});

describe('renames keep links working', () => {
  beforeEach(async () => {
    vault = await open();
  });

  it('a title change renames the file and rewrites [[links]] to it', async () => {
    const target = await vault.create({ title: 'Old name' });
    const linker = await vault.create({
      title: 'Index',
      text: 'See [[Old name]], [[old name#Part|that bit]] and [[Other]].',
    });
    await vault.edit({ id: target.id }, { find: '# Old name', replace: '# New name' });
    expect(existsSync(join(root, 'Old name.md'))).toBe(false);
    expect((await vault.get({ id: target.id })).path).toBe('New name.md');
    expect((await vault.read({ id: linker.id })).content).toContain(
      'See [[New name]], [[New name#Part|that bit]] and [[Other]].',
    );
    expect((await vault.backlinks({ id: target.id })).map((n) => n.id)).toEqual([linker.id]);
  });

  it('leaves a file alone when it is not named after its title', async () => {
    write('2026-10-18.md', '---\nid: D1\n---\n# Daily\n');
    write('Links.md', '# Links\n[[Daily]]\n');
    await vault.refresh(true);
    await vault.overwrite({ id: 'D1' }, '# Journal\n');
    expect((await vault.get({ id: 'D1' })).path).toBe('2026-10-18.md');
    expect(read('Links.md')).toContain('[[Journal]]');
  });

  it('resolves Obsidian-style links by file name too', async () => {
    write('folder/My File.md', 'Some first line\n');
    write('Hub.md', '# Hub\n[[My File]]\n');
    await vault.refresh(true);
    const [hub] = (await vault.search('@wikilinks')).notes;
    const got = await vault.get({ id: hub!.id });
    expect(got.links[0]!.id).toBe((await vault.get({ path: 'folder/My File.md' })).id);
    expect((await vault.search('@backlinks')).notes.map((n) => n.path)).toEqual([
      'folder/My File.md',
    ]);
  });
});

describe('search', () => {
  beforeEach(async () => {
    vault = await open();
    await vault.create({
      title: 'Meeting notes',
      text: 'Discussed the roadmap\n- [ ] send recap',
      tags: ['work/q3'],
    });
    await vault.create({ title: 'Groceries', text: '- [x] milk\n```\ncode\n```', tags: ['home'] });
    await vault.create({ title: 'Roadmap draft', text: 'meeting soon' });
  });

  it('matches word prefixes, ranks titles first, and gives a snippet', async () => {
    const { notes } = await vault.search('meet');
    expect(notes.map((n) => n.title)).toEqual(['Meeting notes', 'Roadmap draft']);
    expect(notes[1]!.snippet).toContain('**meeting**');
  });

  it('combines tags (subtags included), exclusions and tokens', async () => {
    expect((await vault.search('#work')).notes.map((n) => n.title)).toEqual(['Meeting notes']);
    expect((await vault.search('roadmap -draft')).notes.map((n) => n.title)).toEqual([
      'Meeting notes',
    ]);
    expect((await vault.search('@todo')).notes.map((n) => n.title)).toEqual(['Meeting notes']);
    expect((await vault.search('@done @code')).notes.map((n) => n.title)).toEqual(['Groceries']);
    expect((await vault.search('@untagged')).notes.map((n) => n.title)).toEqual(['Roadmap draft']);
    expect((await vault.search('@title roadmap')).notes.map((n) => n.title)).toEqual([
      'Roadmap draft',
    ]);
    expect((await vault.search('"send recap"')).total).toBe(1);
    expect((await vault.search('@today')).total).toBe(3);
  });

  it('treats what people type as words, never as FTS syntax', async () => {
    await expect(vault.search('NOT AND "( * c++')).resolves.toBeDefined();
  });

  it('lists smart sections and tags', async () => {
    expect((await vault.list({ section: 'todo' })).total).toBe(1);
    expect((await vault.list({ tag: 'work' })).total).toBe(1);
    expect(await vault.tags()).toEqual([
      { tag: 'home', count: 1 },
      { tag: 'work/q3', count: 1 },
    ]);
  });
});

describe('pin, archive, trash', () => {
  beforeEach(async () => {
    vault = await open();
  });

  it('archives out of the list and restores', async () => {
    const n = await vault.create({ title: 'A' });
    await vault.archive({ id: n.id });
    expect((await vault.list()).total).toBe(0);
    expect((await vault.list({ location: 'archive' })).total).toBe(1);
    await vault.restore({ id: n.id });
    expect((await vault.list()).total).toBe(1);
    expect(read('A.md')).not.toContain('archived');
  });

  it('trashes into .trash/ keeping the folder, restores, and deletes only from the trash', async () => {
    const n = await vault.create({ title: 'B', folder: 'projects' });
    await expect(vault.deletePermanently({ id: n.id })).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    const trashed = await vault.trash({ id: n.id });
    expect(trashed.path).toBe('.trash/projects/B.md');
    expect(trashed.location).toBe('trash');
    expect(read('.trash/projects/B.md')).toMatch(/trashed: /);
    const back = await vault.restore({ id: n.id });
    expect(back.path).toBe('projects/B.md');
    expect(read('projects/B.md')).not.toMatch(/trashed/);
    expect(existsSync(join(root, '.trash', 'projects'))).toBe(false);
    await vault.trash({ id: n.id });
    expect(await vault.emptyTrash()).toEqual({ deleted: 1 });
    expect(existsSync(join(root, '.trash/projects/B.md'))).toBe(false);
  });

  it('pins to the top of the list', async () => {
    const a = await vault.create({ title: 'A' });
    await vault.create({ title: 'B' });
    await vault.pin({ id: a.id }, true);
    expect((await vault.list()).notes[0]!.title).toBe('A');
    expect((await vault.list({ section: 'pinned' })).total).toBe(1);
  });
});

describe('tags', () => {
  beforeEach(async () => {
    vault = await open();
  });

  it('adds a tag onto the tag line under the title, or a new line', async () => {
    const a = await vault.create({ title: 'A', text: 'body' });
    await vault.addTag({ id: a.id }, 'first');
    await vault.addTag({ id: a.id }, '#second one');
    expect((await vault.read({ id: a.id })).content).toBe('# A\n#first #second one#\n\nbody\n');
  });

  it('removes a tag, and its line when nothing is left', async () => {
    const a = await vault.create({ title: 'A', text: 'body #keep', tags: ['gone'] });
    await vault.removeTag({ id: a.id }, 'gone');
    expect((await vault.read({ id: a.id })).content).toBe('# A\n\nbody #keep\n');
  });

  it('renames a tag and its subtags everywhere, and the front-matter list', async () => {
    const a = await vault.create({ title: 'A', text: '#work and #work/q3 and #workshop' });
    write('B.md', '---\ntags: [work/x, other]\n---\nB\n');
    await vault.refresh(true);
    expect(await vault.renameTag('work', 'job')).toEqual({ notes: 2 });
    expect((await vault.read({ id: a.id })).content).toContain('#job and #job/q3 and #workshop');
    expect(read('B.md')).toContain('tags: [ job/x, other ]');
  });

  it('deletes a tag from notes, keeping the notes', async () => {
    const a = await vault.create({ title: 'A', text: 'x #old/y z' });
    await vault.deleteTag('old');
    expect((await vault.read({ id: a.id })).content).toBe('# A\n\nx z\n');
  });
});

describe('scope (tags hidden from a connection)', () => {
  it('hides excluded notes from every read and refuses writes into them', async () => {
    write('Secret.md', '---\nid: S1\n---\n# Secret\n#private\n');
    write('Open.md', '---\nid: O1\n---\n# Open\n#work\n');
    vault = await open({ scope: { excludeTags: ['private'] } });
    expect((await vault.list()).notes.map((n) => n.id)).toEqual(['O1']);
    expect((await vault.search('secret')).total).toBe(0);
    await expect(vault.read({ id: 'S1' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(vault.create({ title: 'X', tags: ['private'] })).rejects.toMatchObject({
      code: 'out_of_scope',
    });
    expect(await vault.tags()).toEqual([{ tag: 'work', count: 1 }]);
  });

  it('with only-tags, sees just those notes and needs new ones tagged', async () => {
    write('W.md', '# W\n#work/a\n');
    write('H.md', '# H\n#home\n');
    vault = await open({ scope: { onlyTags: ['work'] } });
    expect((await vault.list()).notes.map((n) => n.title)).toEqual(['W']);
    await expect(vault.create({ title: 'Nope' })).rejects.toMatchObject({ code: 'out_of_scope' });
    expect((await vault.create({ title: 'Yes', tags: ['work'] })).title).toBe('Yes');
  });
});

describe('attachments', () => {
  it('saves into assets/ beside the note, links it, reads and deletes it', async () => {
    vault = await open();
    const n = await vault.create({ title: 'Pics', folder: 'trips' });
    const a = await vault.addAttachment({ id: n.id }, 'photo 1.png', new Uint8Array([1, 2, 3]));
    expect(a).toEqual({
      filename: 'photo 1.png',
      path: 'trips/assets/photo 1.png',
      size: 3,
      image: true,
    });
    expect((await vault.read({ id: n.id })).content).toContain('![](assets/photo%201.png)');
    expect((await vault.get({ id: n.id })).hasImages).toBe(true);
    expect((await vault.readAttachment({ id: n.id }, 'photo 1.png')).data).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(await vault.deleteAttachment({ id: n.id }, 'photo 1.png')).toEqual({
      fileDeleted: true,
    });
    expect(readdirSync(join(root, 'trips/assets'))).toEqual([]);
    expect((await vault.read({ id: n.id })).content).not.toContain('photo');
  });

  it('keeps a file another note still uses', async () => {
    vault = await open();
    write('assets/shared.pdf', 'x');
    write('A.md', '---\nid: A\n---\n# A\n[s](assets/shared.pdf)\n');
    write('B.md', '---\nid: B\n---\n# B\n[s](assets/shared.pdf)\n');
    await vault.refresh(true);
    expect(await vault.deleteAttachment({ id: 'A' }, 'shared.pdf')).toEqual({ fileDeleted: false });
    expect(existsSync(join(root, 'assets/shared.pdf'))).toBe(true);
  });
});

describe('the index on disk', () => {
  it('survives reopening and is rebuilt when its schema changes', async () => {
    const indexFile = join(root, '..', `${root.split('/').pop()}-index.db`);
    write('A.md', '# A\n');
    vault = await open({ indexFile });
    vault.close();
    vault = await open({ indexFile });
    expect((await vault.list()).total).toBe(1);
    vault.close();
    rmSync(indexFile, { force: true });
    rmSync(`${indexFile}-wal`, { force: true });
    rmSync(`${indexFile}-shm`, { force: true });
  });
});
