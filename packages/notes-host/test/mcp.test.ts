import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMANDS, Vault, checkArgs, createNotesMcpServer, findCommand } from '../src/index.js';

let root: string;
let vault: Vault;
let client: Client;

async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; json: unknown; content: unknown[] }> {
  const r = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  const text = r.content.find((c) => c.type === 'text')?.text ?? 'null';
  return { isError: r.isError === true, json: JSON.parse(text), content: r.content };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'heapnotes-mcp-'));
  vault = await Vault.open({
    root,
    indexFile: ':memory:',
    staleMs: 0,
    scope: { excludeTags: ['private'] },
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createNotesMcpServer(vault, '0.0.0-test').connect(a);
  client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
});

afterEach(async () => {
  await client.close();
  vault.close();
  rmSync(root, { recursive: true, force: true });
});

describe('heapnotes MCP', () => {
  it('lists the tools, without the ones that delete for good', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('search_notes');
    expect(names).toContain('edit_note');
    expect(names).not.toContain('delete_note');
    expect(names).not.toContain('empty_trash');
    expect(tools.find((t) => t.name === 'read_note')!.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toMatch(/pass it as base/i);
  });

  it('runs a create → read → edit with base round trip', async () => {
    const created = await call('create_note', {
      title: 'Plan',
      text: '## Steps\n- [ ] one',
      tags: ['work'],
    });
    expect(created.isError).toBe(false);
    const id = (created.json as { id: string }).id;
    const read = await call('read_note', { id, section: '## Steps' });
    const { hash } = read.json as { hash: string };
    const edited = await call('edit_note', {
      id,
      find: '- [ ] one',
      replace: '- [x] one',
      section: '## Steps',
      base: hash,
    });
    expect(edited.json).toMatchObject({ replaced: 1, done: 1, todos: 0 });
    const stale = await call('append_to_note', {
      id,
      text: 'late',
      base: hash,
      section: '## Steps',
    });
    expect(stale.isError).toBe(true);
    expect(stale.json).toMatchObject({ error: { code: 'conflict' } });
  });

  it('errors are {"error":{"code","message"}}', async () => {
    const r = await call('read_note', { id: 'nope' });
    expect(r).toMatchObject({ isError: true, json: { error: { code: 'not_found' } } });
    const bad = await call('read_note', { id: 'x', sectoin: 'oops' });
    expect(bad.json).toMatchObject({
      error: {
        code: 'invalid_argument',
        message: expect.stringContaining('no argument "sectoin"'),
      },
    });
    const two = await call('get_note', { id: 'a', title: 'b' });
    expect(two.json).toMatchObject({
      error: { message: expect.stringContaining('exactly one of id, title or path') },
    });
  });

  it('honours the scope: hidden notes are invisible', async () => {
    expect((await call('create_note', { title: 'Diary', tags: ['private'] })).json).toMatchObject({
      error: { code: 'out_of_scope' },
    });
    const unscoped = await Vault.open({ root, indexFile: ':memory:', staleMs: 0 });
    await unscoped.create({ title: 'Diary', text: 'feelings', tags: ['private'] });
    unscoped.close();
    const r = await call('search_notes', { query: 'feelings' });
    expect(r.json).toEqual({ notes: [], total: 0 });
    expect((await call('read_note', { title: 'Diary' })).json).toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('returns images as image content', async () => {
    const n = await vault.create({ title: 'Pic' });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    await call('add_attachment', { id: n.id, filename: 'dot.png', base64: png.toString('base64') });
    const r = await call('read_attachment', { id: n.id, filename: 'dot.png' });
    expect(r.content[1]).toEqual({
      type: 'image',
      data: png.toString('base64'),
      mimeType: 'image/png',
    });
  });
});

describe('the command table', () => {
  it('has unique tool and CLI names', () => {
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
    expect(new Set(COMMANDS.map((c) => c.cli)).size).toBe(COMMANDS.length);
  });

  it('every positional and required argument is in the schema', () => {
    for (const c of COMMANDS) {
      for (const k of [...(c.positional ?? []), ...(c.input.required ?? [])])
        expect(c.input.properties, `${c.name}.${k}`).toHaveProperty(k);
    }
  });

  it('coerces CLI text into the schema types', () => {
    const cmd = findCommand({ name: 'read_note' })!;
    expect(checkArgs(cmd, { id: 'x', limit: '10' })).toEqual({ id: 'x', limit: 10 });
    expect(() => checkArgs(cmd, { id: 'x', limit: 'ten' })).toThrow(/whole number/);
    expect(() => checkArgs(findCommand({ name: 'list_notes' })!, { location: 'bin' })).toThrow(
      /one of notes, archive, trash, all/,
    );
  });
});
