import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '@heapcode/host';
import { isRoleName, modelClear, modelSet, profileRemove, profileUse } from '../src/profileCli.js';

/**
 * `heapcode model` — the CLI's surface on the global role table.
 *
 * It replaces `heapcode profile set NAME <role>Model VALUE`, which could only
 * ever configure a role *on one profile*. Setting embeddings meant setting it
 * again on every other profile, and switching profiles silently changed which
 * one was in force.
 */

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hcps-'));
  process.env.HEAPCODE_HOME = home;
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      connections: [
        { name: 'local', preset: 'ollama', baseUrl: 'http://localhost:11434/v1' },
        { name: 'cloud', preset: 'openai', baseUrl: 'https://api.openai.com/v1' },
      ],
      roles: { chat: { connection: 'local', model: 'llama' } },
    }),
    'utf8',
  );
});

afterEach(async () => {
  delete process.env.HEAPCODE_HOME;
  await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const store = (): ConfigStore => new ConfigStore(join(home, 'config.json'));

const written = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as Record<string, unknown>;

describe('model set', () => {
  it('assigns a role to a model on a named connection', async () => {
    await modelSet('apply', 'local', 'fast-apply-1.5b');
    expect((await store().getRoles()).apply).toEqual({ connection: 'local', model: 'fast-apply-1.5b' });
  });

  it('lets a role run on a different connection than chat', async () => {
    // The whole point. Embeddings on the local box while chat stays on the
    // cloud used to need a `<role>Profile` redirect on the active profile,
    // duplicated onto every other profile the user might switch to.
    await modelSet('embeddings', 'local', 'nomic-embed-text');
    await modelSet('chat', 'cloud', 'gpt-4o');

    const config = await store().modelConfig();
    expect((await store().resolve('embeddings'))?.baseUrl).toBe('http://localhost:11434/v1');
    expect((await store().resolve('chat'))?.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.roles.embeddings).toEqual({ connection: 'local', model: 'nomic-embed-text' });
  });

  it('leaves every other role alone', async () => {
    await modelSet('apply', 'local', 'fast-apply');
    await modelSet('embeddings', 'local', 'nomic-embed');

    expect(await store().getRoles()).toMatchObject({
      chat: { connection: 'local', model: 'llama' },
      apply: { connection: 'local', model: 'fast-apply' },
      embeddings: { connection: 'local', model: 'nomic-embed' },
    });
  });

  it('refuses an unknown connection instead of writing an assignment nothing can serve', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await modelSet('apply', 'nope', 'x');

    expect(err).toHaveBeenCalledWith(expect.stringContaining('No connection named "nope"'));
    expect((await store().getRoles()).apply).toBeUndefined();
  });

  it('sets chat through the path that keeps connection and model together', async () => {
    await modelSet('chat', 'cloud', 'gpt-4o');
    expect((await written()).roles).toMatchObject({ chat: { connection: 'cloud', model: 'gpt-4o' } });
  });
});

describe('model clear', () => {
  it('drops the assignment, so the role inherits again', async () => {
    // Absent means "inherit". An empty model string would point the role at a
    // model with no name and fail much later, at the provider.
    await modelSet('edit', 'cloud', 'gpt-4o-mini');
    await modelClear('edit');

    expect((await store().getRoles()).edit).toBeUndefined();
    expect((await store().resolve('edit'))?.model).toBe('llama');
  });

  it('refuses to clear chat, which is what the chain bottoms out at', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await modelClear('chat');

    expect(err).toHaveBeenCalledWith(expect.stringContaining('cannot be cleared'));
    expect((await store().getRoles()).chat).toBeTruthy();
  });

  it('leaves embeddings off rather than inheriting, because a chat model cannot embed', async () => {
    await modelSet('embeddings', 'local', 'nomic-embed');
    await modelClear('embeddings');

    expect(await store().resolve('embeddings')).toBeUndefined();
  });
});

describe('role names', () => {
  it('accepts every role and rejects a typo, so nothing junk is ever written', () => {
    for (const role of ['chat', 'agent', 'edit', 'apply', 'completion', 'embeddings', 'rerank', 'context']) {
      expect(isRoleName(role)).toBe(true);
    }
    expect(isRoleName('applyModel')).toBe(false);
    expect(isRoleName('__proto__')).toBe(false);
  });
});

describe('connection remove', () => {
  it('takes the assignments that pointed at it, and says where those roles went', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await modelSet('embeddings', 'cloud', 'text-embedding-3-small');
    await modelSet('edit', 'cloud', 'gpt-4o-mini');

    await profileRemove('cloud');

    expect((await store().getRoles()).embeddings).toBeUndefined();
    expect((await store().getRoles()).edit).toBeUndefined();
    // Edit falls back to chat; embeddings has nothing to fall back to.
    expect(log.mock.calls.flat().join('\n')).toMatch(/edit.*llama/s);
    expect(log.mock.calls.flat().join('\n')).toMatch(/semantic search is off/);
  });
});

describe('connection use', () => {
  it('moves chat without carrying a model id onto an endpoint that may not serve it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await profileUse('cloud');

    expect((await store().getRoles()).chat).toEqual({ connection: 'cloud', model: '' });
  });
});
