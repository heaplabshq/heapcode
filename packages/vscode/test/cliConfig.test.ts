import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetCliConfigCache, readCliApiKey, readCliConfig } from '../src/cliConfig.js';

/**
 * Configuring a provider in a terminal should not mean configuring it again in
 * the editor. The extension reads the CLI's connections; it never writes them,
 * and its own keys stay in SecretStorage.
 *
 * The case that matters most here is the absent one: plenty of people will
 * install the extension and never install the CLI.
 */

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cli-config-'));
  process.env.HEAPCODE_HOME = home;
  __resetCliConfigCache();
});

afterEach(() => {
  delete process.env.HEAPCODE_HOME;
  __resetCliConfigCache();
});

async function writeConfig(body: unknown): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.json'), JSON.stringify(body), 'utf8');
}

describe('reading the CLI’s config', () => {
  it('returns nothing when there is no CLI on the machine', () => {
    expect(readCliConfig()).toBeUndefined();
    expect(readCliApiKey('anything')).toBeUndefined();
  });

  it('returns nothing rather than throwing on a malformed file', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), '{ not json', 'utf8');
    // Someone else's broken file must not take the editor down with it.
    expect(readCliConfig()).toBeUndefined();
  });

  it('returns nothing when the CLI is installed but has no connections', async () => {
    await writeConfig({ connections: [], roles: {} });
    expect(readCliConfig()).toBeUndefined();
  });

  it('reads connections and roles', async () => {
    await writeConfig({
      connections: [{ name: 'ollama', preset: 'custom', baseUrl: 'http://localhost:11434/v1' }],
      roles: { chat: { connection: 'ollama', model: 'llama3' } },
    });
    const shared = readCliConfig();
    expect(shared?.connections.map((c) => c.name)).toEqual(['ollama']);
    expect(shared?.roles.chat?.model).toBe('llama3');
  });

  it('picks up an edit made in a terminal without a window reload', async () => {
    await writeConfig({ connections: [{ name: 'one', preset: 'custom', baseUrl: 'http://a' }], roles: {} });
    expect(readCliConfig()?.connections).toHaveLength(1);

    // mtime resolution is coarse enough on some filesystems to need a nudge.
    await new Promise((r) => setTimeout(r, 12));
    await writeConfig({
      connections: [
        { name: 'one', preset: 'custom', baseUrl: 'http://a' },
        { name: 'two', preset: 'custom', baseUrl: 'http://b' },
      ],
      roles: {},
    });
    expect(readCliConfig()?.connections).toHaveLength(2);
  });
});

describe('reading the CLI’s key for a shared connection', () => {
  it('finds the key the CLI stored', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'secrets.json'), JSON.stringify({ 'apiKey.ollama': 'sk-shared' }), 'utf8');
    expect(readCliApiKey('ollama')).toBe('sk-shared');
  });

  it('treats an empty value as absent, the way the CLI does', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'secrets.json'), JSON.stringify({ 'apiKey.ollama': '' }), 'utf8');
    expect(readCliApiKey('ollama')).toBeUndefined();
  });

  it('returns nothing for a connection the CLI has never seen', async () => {
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'secrets.json'), JSON.stringify({ 'apiKey.other': 'sk' }), 'utf8');
    expect(readCliApiKey('ollama')).toBeUndefined();
  });
});

describe('how the extension merges the two', () => {
  /** Stands in for `workspace.getConfiguration('heapcode').get`. */
  const reader =
    (values: Record<string, unknown>) =>
    <T,>(key: string, fallback: T): T =>
      (values[key] as T) ?? fallback;

  it('keeps VS Code settings authoritative and appends what they do not name', async () => {
    const { resolveModelConfig } = await import('../src/profileManager.js');
    await writeConfig({
      connections: [
        { name: 'shared', preset: 'custom', baseUrl: 'http://from-cli' },
        { name: 'both', preset: 'custom', baseUrl: 'http://from-cli' },
      ],
      roles: {},
    });

    const { connections } = resolveModelConfig(
      reader({ connections: [{ name: 'both', preset: 'custom', baseUrl: 'http://from-settings' }] }),
    );

    // Settings win on the shared name; the CLI's other one comes along.
    expect(connections.find((c) => c.name === 'both')?.baseUrl).toBe('http://from-settings');
    expect(connections.map((c) => c.name).sort()).toEqual(['both', 'shared']);
  });

  it('adopts the CLI’s connections and roles when the editor has none', async () => {
    const { resolveModelConfig } = await import('../src/profileManager.js');
    await writeConfig({
      connections: [{ name: 'ollama', preset: 'custom', baseUrl: 'http://localhost:11434/v1' }],
      roles: { chat: { connection: 'ollama', model: 'llama3' } },
    });

    const config = resolveModelConfig(reader({}));

    // Without this it synthesizes a localhost default and asks someone to set
    // up a provider they have already set up.
    expect(config.connections.map((c) => c.name)).toEqual(['ollama']);
    expect(config.roles.chat?.model).toBe('llama3');
  });

  it('still synthesizes the old default when there is no CLI either', async () => {
    const { resolveModelConfig } = await import('../src/profileManager.js');
    const config = resolveModelConfig(reader({}));
    expect(config.connections.map((c) => c.name)).toEqual(['default']);
  });
});
