import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpManager, childEnv, explainConnectFailure, type McpServerConfig } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = join(__dirname, 'fixtures', 'mcpFixtureServer.mjs');

/**
 * Spawns the real fixture server (test/fixtures/mcpFixtureServer.mjs) as a
 * child process over stdio — a genuine two-process integration test, not a
 * mock, proving the stdio transport, tool listing, and tool calling all
 * work end to end.
 *
 * Written against the CLI's copy of McpManager, and inherited by the
 * extension when the two copies merged into core — the extension's own
 * mcp.ts had zero tests, since mocking vscode.workspace.getConfiguration for
 * it was the hard part. Injecting the config source is what removed that
 * obstacle: both hosts now run on the code these tests cover.
 */
describe('McpManager', () => {
  it('connects to a configured stdio server and lists its tools with the mcp__<server>__<tool> naming', async () => {
    const manager = new McpManager(() =>
      Promise.resolve({ fixture: { command: process.execPath, args: [FIXTURE_SERVER] } }),
    );
    try {
      await manager.ensureConnected();
      expect(manager.connectedServerNames()).toEqual(['fixture']);
      const tools = manager.getToolDefinitions();
      expect(tools.map((t) => t.name)).toEqual(['mcp__fixture__echo', 'mcp__fixture__whoami']);
      expect(tools[0]!.permission).toBe('execute');
      expect(tools[0]!.untrustedOutput).toBe(true);
      expect(manager.isMcpTool('mcp__fixture__echo')).toBe(true);
      expect(manager.isMcpTool('read_file')).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  it('calls a tool through the server and returns its text content', async () => {
    const manager = new McpManager(() =>
      Promise.resolve({ fixture: { command: process.execPath, args: [FIXTURE_SERVER] } }),
    );
    try {
      await manager.ensureConnected();
      const result = await manager.call('mcp__fixture__echo', { text: 'hello from the test' });
      expect(result).toBe('hello from the test');
    } finally {
      manager.dispose();
    }
  });

  it('identifies itself to servers as "heapcode" in the initialize handshake', async () => {
    // Both hosts now send this. The extension used to send 'heap-code' and
    // the CLI 'heapcode'; unifying them was a deliberate choice, and this is
    // what third-party servers actually observe, so it is asserted against a
    // real handshake rather than against the constant.
    const manager = new McpManager(
      () => Promise.resolve({ fixture: { command: process.execPath, args: [FIXTURE_SERVER] } }),
      undefined,
      '9.9.9',
    );
    try {
      await manager.ensureConnected();
      expect(await manager.call('mcp__fixture__whoami', {})).toBe('heapcode@9.9.9');
    } finally {
      manager.dispose();
    }
  });

  it('falls back to 0.0.0 when the host does not supply its version', async () => {
    const manager = new McpManager(() =>
      Promise.resolve({ fixture: { command: process.execPath, args: [FIXTURE_SERVER] } }),
    );
    try {
      await manager.ensureConnected();
      expect(await manager.call('mcp__fixture__whoami', {})).toBe('heapcode@0.0.0');
    } finally {
      manager.dispose();
    }
  });

  it('ensureConnected is idempotent — a second call does not reconnect an already-connected server', async () => {
    let loads = 0;
    const manager = new McpManager(() => {
      loads++;
      return Promise.resolve({ fixture: { command: process.execPath, args: [FIXTURE_SERVER] } });
    });
    try {
      await manager.ensureConnected();
      await manager.ensureConnected();
      expect(loads).toBe(2); // config is re-read each time (so edits take effect)…
      expect(manager.connectedServerNames()).toEqual(['fixture']); // …but the server itself isn't reconnected/duplicated
    } finally {
      manager.dispose();
    }
  });

  it('drops a server that disappears from config on the next ensureConnected', async () => {
    let includeFixture = true;
    const manager = new McpManager(() => {
      const servers: Record<string, McpServerConfig> = includeFixture
        ? { fixture: { command: process.execPath, args: [FIXTURE_SERVER] } }
        : {};
      return Promise.resolve(servers);
    });
    try {
      await manager.ensureConnected();
      expect(manager.connectedServerNames()).toEqual(['fixture']);
      includeFixture = false;
      await manager.ensureConnected();
      expect(manager.connectedServerNames()).toEqual([]);
      expect(manager.getToolDefinitions()).toEqual([]);
    } finally {
      manager.dispose();
    }
  });

  it('a server that fails to connect is logged and simply contributes no tools', async () => {
    const logs: string[] = [];
    const manager = new McpManager(
      () => Promise.resolve({ broken: { command: 'this-binary-does-not-exist-12345' } }),
      (line) => logs.push(line),
    );
    try {
      await manager.ensureConnected();
      expect(manager.connectedServerNames()).toEqual([]);
      expect(manager.getToolDefinitions()).toEqual([]);
      expect(logs.some((l) => l.includes('broken'))).toBe(true);
    } finally {
      manager.dispose();
    }
  });

  it('records why a server failed, so a settings panel can say more than "not connected"', async () => {
    const manager = new McpManager(() => Promise.resolve({ broken: { command: 'this-binary-does-not-exist-12345' } }));
    try {
      await manager.ensureConnected();
      expect(manager.failureFor('broken')).toBeTruthy();
      expect(manager.failureFor('never-configured')).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

  it('a server that answers 401 is explained as needing sign-in, not as a typo', () => {
    // What StreamableHTTPClientTransport throws for a hosted connector behind
    // OAuth (mcp.notion.com and friends) when no auth provider is configured.
    const err = Object.assign(new Error('Error POSTing to endpoint: {"error":"invalid_token"}'), { code: 401 });
    expect(explainConnectFailure(err)).toMatch(/sign-in \(OAuth\)/);

    // A missing command must not be swept into the same bucket.
    expect(explainConnectFailure(Object.assign(new Error('spawn foo ENOENT'), { code: 'ENOENT' }))).toMatch(/on PATH/);
  });

  it('does not hand a third-party server the whole environment', () => {
    // These servers are usually fetched from a registry at the moment they
    // start, so "whatever is exported in the shell" is the wrong grant.
    const env = childEnv({
      PATH: '/usr/bin',
      HOME: '/home/me',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GITHUB_TOKEN: 'ghp-secret',
      DATABASE_URL: 'postgres://user:pw@host/db',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me' });
  });

  it('keeps what a program needs to run and to reach the network', () => {
    // Dropping a proxy or a CA bundle does not fail loudly — it fails as a
    // timeout inside someone else's code.
    const env = childEnv({
      PATH: '/usr/bin',
      https_proxy: 'http://proxy:3128',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      LANG: 'en_GB.UTF-8',
      TMPDIR: '/tmp',
      // Windows spelling, and Node's spawn misbehaves without it.
      SystemRoot: 'C:\\Windows',
    });
    expect(Object.keys(env).sort()).toEqual(['LANG', 'NODE_EXTRA_CA_CERTS', 'PATH', 'SystemRoot', 'TMPDIR', 'https_proxy']);
  });

  it('lets a server declare the one variable it does need', async () => {
    // The remedy for the allowlist: say so per server, rather than exporting
    // it into every process on the machine.
    const manager = new McpManager(() =>
      Promise.resolve({ fixture: { command: 'node', args: [FIXTURE_SERVER], env: { NOTION_TOKEN: 'ntn_x' } } }),
    );
    try {
      await manager.ensureConnected();
      expect(manager.connectedServerNames()).toEqual(['fixture']);
    } finally {
      manager.dispose();
    }
  });

  it('calling an unconnected server raises a clear error instead of throwing on undefined', async () => {
    const manager = new McpManager(() => Promise.resolve({}));
    await expect(manager.call('mcp__nope__tool', {})).rejects.toThrow(/not connected/);
    manager.dispose();
  });
});
