import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config/store.js';
import { mergeMcpServerEnv } from '../src/agent/mcpConfig.js';

/** `/mcp env` end to end: the command's own merge, against a real config file. */
async function mcpEnv(store: ConfigStore, name: string, pairs: string): Promise<string[]> {
  const server = (await store.load()).mcpServers![name]!;
  const merged = mergeMcpServerEnv(server, pairs.split(/\s+/).join('\n'));
  if ('error' in merged) throw new Error(merged.error);
  await store.saveMcpServer(name, merged);
  return Object.keys(merged.env ?? {});
}

describe('/mcp env against a real config file', () => {
  it('sets, merges, removes one, and leaves the command alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcpenv-'));
    const store = new ConfigStore(join(dir, 'config.json'));
    await store.saveMcpServer('svc', { command: 'npx', args: ['-y', 'thing'] });

    expect(await mcpEnv(store, 'svc', 'API_KEY=abc')).toEqual(['API_KEY']);
    expect(await mcpEnv(store, 'svc', 'OTHER=def')).toEqual(['API_KEY', 'OTHER']);
    expect(await mcpEnv(store, 'svc', 'API_KEY=')).toEqual(['OTHER']);

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(onDisk.mcpServers.svc).toEqual({ command: 'npx', args: ['-y', 'thing'], env: { OTHER: 'def' } });

    expect(await mcpEnv(store, 'svc', 'OTHER=')).toEqual([]);
    const cleared = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(cleared.mcpServers.svc).toEqual({ command: 'npx', args: ['-y', 'thing'] });
  });
});
