import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall, ToolDefinition } from '@heapcode/core';
import { PermissionEngine } from '../src/agent/permissions.js';

const WRITE_TOOL: ToolDefinition = { name: 'write_file', description: 'x', parameters: {}, permission: 'write' };
const CALL: ToolCall = { id: '1', name: 'write_file', args: {} };

let dir: string;
let grantsFile: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heapcode-perm-'));
  grantsFile = join(dir, 'permissions.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * The engine's own semantics are covered in packages/core; what's specific to
 * the CLI is the grants file — its on-disk shape is a compatibility surface
 * (users' existing permissions.json must keep working), and where the
 * extension has a Memento the CLI has to survive a process restart.
 */
describe('PermissionEngine grants file', () => {
  it('persists an "always" grant as <permission>.<tool> and honors it in a fresh process', async () => {
    const engine = new PermissionEngine(grantsFile);
    engine.attachRequester(() => Promise.resolve('always'));
    expect(await engine.request(CALL, WRITE_TOOL, 'first')).toBe(true);

    const saved = JSON.parse(await readFile(grantsFile, 'utf8')) as Record<string, string>;
    expect(saved['write.write_file']).toBe('always');

    const fresh = new PermissionEngine(grantsFile);
    fresh.attachRequester(() => Promise.reject(new Error('should not be asked — persisted grant covers this')));
    expect(await fresh.request(CALL, WRITE_TOOL, 'second')).toBe(true);
  });

  it('reads a grants file written by an earlier version', async () => {
    await writeFile(grantsFile, JSON.stringify({ 'write.write_file': 'always' }), 'utf8');

    const engine = new PermissionEngine(grantsFile);
    engine.attachRequester(() => Promise.reject(new Error('should not be asked')));
    expect(await engine.request(CALL, WRITE_TOOL, 'covered by the existing file')).toBe(true);
  });

  it('a missing or corrupt grants file is empty, not fatal', async () => {
    await writeFile(grantsFile, 'not json at all', 'utf8');
    const engine = new PermissionEngine(grantsFile);
    engine.attachRequester(() => Promise.resolve('deny'));
    expect(await engine.request(CALL, WRITE_TOOL, 'asked because nothing was loaded')).toBe(false);

    const absent = new PermissionEngine(join(dir, 'nested', 'never-written.json'));
    absent.attachRequester(() => Promise.resolve('allow'));
    expect(await absent.request(CALL, WRITE_TOOL, 'still works')).toBe(true);
  });

  it('reset() empties the file and reports how many grants it cleared', async () => {
    const engine = new PermissionEngine(grantsFile);
    engine.attachRequester(() => Promise.resolve('always'));
    await engine.request(CALL, WRITE_TOOL, 'first');

    expect(await engine.reset()).toBe(1);
    expect(JSON.parse(await readFile(grantsFile, 'utf8'))).toEqual({});
  });

  it('with no prompt attached, the terminal has nowhere to ask and fails closed', async () => {
    const engine = new PermissionEngine(grantsFile);
    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(false);
  });
});
