import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config/store.js';
import { loadMcpServers } from '../src/agent/mcpConfig.js';

let root: string;
let config: ConfigStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-mcpconfig-'));
  config = new ConfigStore(join(root, 'config.json'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadMcpServers', () => {
  it('returns empty when neither global nor project config defines any servers', async () => {
    expect(await loadMcpServers(root, config)).toEqual({});
  });

  it('reads global servers from ~/.heapcode/config.json (mcpServers)', async () => {
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({ profiles: [], mcpServers: { global: { command: 'npx', args: ['-y', 'server'] } } }),
    );
    expect(await loadMcpServers(root, config)).toEqual({ global: { command: 'npx', args: ['-y', 'server'] } });
  });

  it('reads project-scoped servers from <cwd>/.heapcode/mcp.json', async () => {
    await mkdir(join(root, '.heapcode'), { recursive: true });
    await writeFile(join(root, '.heapcode', 'mcp.json'), JSON.stringify({ project: { url: 'http://localhost:1234', transport: 'sse' } }));
    expect(await loadMcpServers(root, config)).toEqual({ project: { url: 'http://localhost:1234', transport: 'sse' } });
  });

  it('merges global and project servers; a name defined in both takes the project-scoped definition', async () => {
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        profiles: [],
        mcpServers: {
          shared: { command: 'global-command' },
          globalOnly: { command: 'g' },
        },
      }),
    );
    await mkdir(join(root, '.heapcode'), { recursive: true });
    await writeFile(
      join(root, '.heapcode', 'mcp.json'),
      JSON.stringify({ shared: { command: 'project-command' }, projectOnly: { command: 'p' } }),
    );

    const merged = await loadMcpServers(root, config);
    expect(merged.shared).toEqual({ command: 'project-command' });
    expect(merged.globalOnly).toEqual({ command: 'g' });
    expect(merged.projectOnly).toEqual({ command: 'p' });
  });

  it('a malformed project mcp.json is ignored rather than throwing', async () => {
    await mkdir(join(root, '.heapcode'), { recursive: true });
    await writeFile(join(root, '.heapcode', 'mcp.json'), '{ not valid json');
    await expect(loadMcpServers(root, config)).resolves.toEqual({});
  });
});
