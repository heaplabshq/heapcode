import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../src/config/store.js';
import {
  describeMcpServer,
  loadMcpServerSources,
  loadMcpServers,
  mcpNameProblem,
  parseMcpServerSpec,
} from '../src/agent/mcpConfig.js';

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

/**
 * Turning what a person types into a server definition.
 *
 * Shared between the CLI and the browser so the two cannot drift into
 * accepting different things — the way the hosts' two `clientInfo` names once
 * did. A server is either a URL or a command line, and the string already
 * says which; asking someone to pick a transport first is asking them to
 * classify something you can see.
 */
describe('parseMcpServerSpec', () => {
  it('reads a bare command as stdio', () => {
    expect(parseMcpServerSpec('my-server')).toEqual({ command: 'my-server' });
  });

  it('splits a command line into command and arguments', () => {
    expect(parseMcpServerSpec('npx -y @modelcontextprotocol/server-filesystem /code')).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/code'],
    });
  });

  it('reads an http URL as a remote server', () => {
    expect(parseMcpServerSpec('https://example.com/mcp')).toEqual({
      url: 'https://example.com/mcp',
      transport: 'http',
    });
  });

  it('takes /sse in the path as the older transport, which is how servers advertise it', () => {
    expect(parseMcpServerSpec('https://example.com/sse')).toEqual({
      url: 'https://example.com/sse',
      transport: 'sse',
    });
  });

  it('rejects a URL that is not one, rather than running it as a command', () => {
    const parsed = parseMcpServerSpec('https://exa mple.com');
    expect(parsed).toHaveProperty('error');
  });

  it('asks for something rather than storing an empty server', () => {
    expect(parseMcpServerSpec('   ')).toHaveProperty('error');
  });
});

describe('describeMcpServer', () => {
  it('round-trips what parseMcpServerSpec accepted', () => {
    const spec = 'npx -y some-server --flag';
    expect(describeMcpServer(parseMcpServerSpec(spec) as never)).toBe(spec);
  });

  it('shows a remote server as its URL', () => {
    expect(describeMcpServer({ url: 'https://example.com/mcp', transport: 'http' })).toBe('https://example.com/mcp');
  });
});

describe('mcpNameProblem', () => {
  it('accepts what can be prefixed onto a tool name', () => {
    expect(mcpNameProblem('file-system_2')).toBeUndefined();
  });

  it('rejects a name that would be mangled into something else', () => {
    // Tool names are `mcp__<name>__<tool>`, sanitized — a name with spaces or
    // dots comes back out as a different name than the one stored.
    expect(mcpNameProblem('my server')).toBeTruthy();
    expect(mcpNameProblem('')).toBeTruthy();
  });
});

/**
 * Writing servers, which nothing could do before.
 *
 * Every host could list MCP servers and none could add one: the CLI's `/mcp`
 * and the browser's Connectors page both ended in "edit this JSON yourself".
 * The extension had an add flow that wrote to VS Code's own settings, so what
 * it added was invisible to the other two.
 */
describe('ConfigStore — MCP servers', () => {
  it('adds one, and reads it back through the loader every host uses', async () => {
    await config.saveMcpServer('filesystem', { command: 'npx', args: ['-y', 'server-filesystem'] });
    expect(await loadMcpServers(root, config)).toEqual({
      filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] },
    });
  });

  it('replaces one by name instead of collecting duplicates', async () => {
    await config.saveMcpServer('api', { url: 'https://old.example.com/mcp', transport: 'http' });
    await config.saveMcpServer('api', { url: 'https://new.example.com/mcp', transport: 'http' });
    const servers = await loadMcpServers(root, config);
    expect(Object.keys(servers)).toEqual(['api']);
    expect(servers.api).toEqual({ url: 'https://new.example.com/mcp', transport: 'http' });
  });

  it('leaves the other servers alone', async () => {
    await config.saveMcpServer('a', { command: 'a' });
    await config.saveMcpServer('b', { command: 'b' });
    await config.deleteMcpServer('a');
    expect(Object.keys(await loadMcpServers(root, config))).toEqual(['b']);
  });

  it('removing one that was never there is not an error', async () => {
    await expect(config.deleteMcpServer('ghost')).resolves.toBeUndefined();
  });

  it('does not touch a project-scoped server of the same name', async () => {
    // `.heapcode/mcp.json` is meant to be committed. A settings screen writing
    // to a file under version control on someone's behalf is the one thing
    // this must not do — so a personal entry is what gets removed, and the
    // project's keeps winning.
    await mkdir(join(root, '.heapcode'), { recursive: true });
    await writeFile(join(root, '.heapcode', 'mcp.json'), JSON.stringify({ shared: { command: 'from-project' } }));
    await config.saveMcpServer('shared', { command: 'from-personal' });

    const sources = await loadMcpServerSources(root, config);
    expect(sources.global.shared).toEqual({ command: 'from-personal' });
    expect(sources.project.shared).toEqual({ command: 'from-project' });
    expect((await loadMcpServers(root, config)).shared).toEqual({ command: 'from-project' });

    await config.deleteMcpServer('shared');
    expect((await loadMcpServers(root, config)).shared).toEqual({ command: 'from-project' });
  });
});
