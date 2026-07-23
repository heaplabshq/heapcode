import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMockServer, type MockServer } from '../../core/test/mockServer.js';
import { ConfigStore } from '../src/config/store.js';
import { conversationsFile } from '../src/paths.js';
import { runHeadless } from '../src/headless.js';

let home: string;
let project: string;
let server: MockServer;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'heapcode-home-'));
  project = await mkdtemp(join(tmpdir(), 'heapcode-project-'));
  vi.stubEnv('HEAPCODE_HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await server?.close();
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

async function configureProfile(): Promise<void> {
  server = await startMockServer({ kind: 'sse', chunks: ['Hel', 'lo!'] });
  const config = new ConfigStore();
  await config.saveProfile({ name: 'test', preset: 'custom', baseUrl: server.baseUrl, model: 'mock-model' });
}

describe('runHeadless', () => {
  it('returns a valid JSON reply with no TTY and persists history', async () => {
    await configureProfile();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'hi', json: true, cwd: project });

    expect(code).toBe(0);
    const printed = write.mock.calls.map((c) => c[0]).join('');
    const parsed = JSON.parse(printed);
    expect(parsed).toMatchObject({ response: 'Hello!', model: 'mock-model', profile: 'test' });

    const saved = JSON.parse(await readFile(conversationsFile(project), 'utf8'));
    expect(saved[0].messages.map((m: { content: string }) => m.content)).toEqual(['hi', 'Hello!']);
    write.mockRestore();
  });

  it('prints plain text (not JSON) without --json', async () => {
    await configureProfile();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'hi', json: false, cwd: project });

    expect(write.mock.calls.map((c) => c[0]).join('')).toBe('Hello!\n');
    write.mockRestore();
  });

  it('exits non-zero with a structured error when no profile is configured', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'hi', json: true, cwd: project });

    expect(code).toBe(1);
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({ error: expect.stringContaining('No provider profile') });
    write.mockRestore();
  });

  it('continues the most recent conversation in the project directory across calls', async () => {
    await configureProfile();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'first', json: true, cwd: project });
    await runHeadless({ prompt: 'second', json: true, cwd: project });

    const saved = JSON.parse(await readFile(conversationsFile(project), 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].messages).toHaveLength(4);
  });
});
