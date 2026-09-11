import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetConfig, __setConfig, __setWorkspaceRoot } from './vscodeStub.js';
import { loadMcpServers, readProjectMcpServers } from '../src/mcpConfig.js';

/**
 * `<project>/.heapcode/mcp.json` is project configuration — committed, the way
 * `.vscode/` is — and every other host reads it. The extension did not, so a
 * team could add a server for their project, watch the terminal pick it up,
 * and watch the editor ignore it.
 *
 * `mcpServers` from `~/.heapcode/config.json` is deliberately NOT read here.
 * That is another host's personal config, and an MCP server is a program to
 * execute rather than a value.
 */

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'vsc-mcp-'));
  __setWorkspaceRoot(project, 'file');
  __setConfig('heapcode', {});
});

afterEach(() => {
  __setWorkspaceRoot(undefined);
  __resetConfig();
});

async function writeProjectFile(body: unknown): Promise<void> {
  await mkdir(join(project, '.heapcode'), { recursive: true });
  await writeFile(join(project, '.heapcode', 'mcp.json'), JSON.stringify(body), 'utf8');
}

describe('the project’s own mcp.json', () => {
  it('is read, which it never used to be', async () => {
    await writeProjectFile({ team: { command: 'npx', args: ['-y', 'server'] } });
    expect(Object.keys(await readProjectMcpServers())).toEqual(['team']);
  });

  it('is absent in most repos, and that is not an error', async () => {
    expect(await readProjectMcpServers()).toEqual({});
  });

  it('is ignored rather than fatal when it is not valid JSON', async () => {
    await mkdir(join(project, '.heapcode'), { recursive: true });
    await writeFile(join(project, '.heapcode', 'mcp.json'), '{ nope', 'utf8');
    expect(await readProjectMcpServers()).toEqual({});
  });

  it('drops an entry that could not start anything', async () => {
    await writeProjectFile({ good: { url: 'https://example.com/mcp' }, empty: {}, wrong: 'not an object' });
    expect(Object.keys(await readProjectMcpServers())).toEqual(['good']);
  });

  it('is skipped when no folder is open', async () => {
    __setWorkspaceRoot(undefined);
    expect(await readProjectMcpServers()).toEqual({});
  });
});

describe('what the extension ends up connecting', () => {
  it('keeps working on settings alone when the project has no file', async () => {
    __setConfig('heapcode', { mcpServers: { mine: { command: 'npx', args: ['-y', 'mine'] } } });
    expect(Object.keys(await loadMcpServers())).toEqual(['mine']);
  });

  it('adds the project’s servers to the ones in settings', async () => {
    __setConfig('heapcode', { mcpServers: { mine: { command: 'npx', args: ['-y', 'mine'] } } });
    await writeProjectFile({ team: { command: 'npx', args: ['-y', 'team'] } });
    expect(Object.keys(await loadMcpServers()).sort()).toEqual(['mine', 'team']);
  });

  it('lets the project win a name clash, as the CLI does', async () => {
    // Same rule as loadMcpServers in @heapcode/host. Diverging would mean the
    // same two files produce different rosters depending on the window.
    __setConfig('heapcode', { mcpServers: { shared: { command: 'from-settings' } } });
    await writeProjectFile({ shared: { command: 'from-project' } });
    expect((await loadMcpServers()).shared?.command).toBe('from-project');
  });
});
