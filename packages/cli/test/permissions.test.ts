import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall, ToolDefinition } from '@heapcode/core';
import { PermissionEngine } from '../src/agent/permissions.js';

const WRITE_TOOL: ToolDefinition = { name: 'write_file', description: 'x', parameters: {}, permission: 'write' };
const DESTRUCTIVE_TOOL: ToolDefinition = { name: 'delete_file', description: 'x', parameters: {}, permission: 'destructive' };
const READ_TOOL: ToolDefinition = { name: 'read_file', description: 'x', parameters: {}, permission: 'read' };
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

describe('PermissionEngine', () => {
  it('read-permission tools never prompt', async () => {
    const engine = new PermissionEngine(grantsFile);
    engine.attachRequester(() => Promise.reject(new Error('should not be called')));
    expect(await engine.request(CALL, READ_TOOL, 'read something')).toBe(true);
  });

  it('"deny" from the requester returns false', async () => {
    const engine = new PermissionEngine(grantsFile);
    engine.attachRequester(() => Promise.resolve('deny'));
    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(false);
  });

  it('"session" grant auto-allows subsequent calls to the same tool within the session, but not a fresh session', async () => {
    const engine = new PermissionEngine(grantsFile);
    let asked = 0;
    engine.attachRequester(() => {
      asked++;
      return Promise.resolve('session');
    });

    expect(await engine.request(CALL, WRITE_TOOL, 'first')).toBe(true);
    expect(await engine.request(CALL, WRITE_TOOL, 'second')).toBe(true);
    expect(asked).toBe(1); // second call was auto-allowed, no prompt

    engine.resetSession();
    engine.attachRequester(() => Promise.resolve('deny'));
    expect(await engine.request(CALL, WRITE_TOOL, 'third')).toBe(false);
  });

  it('"always" grant persists to disk and survives a fresh PermissionEngine instance', async () => {
    const engine = new PermissionEngine(grantsFile);
    engine.attachRequester(() => Promise.resolve('always'));
    expect(await engine.request(CALL, WRITE_TOOL, 'first')).toBe(true);

    const saved = JSON.parse(await readFile(grantsFile, 'utf8'));
    expect(saved['write.write_file']).toBe('always');

    const fresh = new PermissionEngine(grantsFile);
    fresh.attachRequester(() => Promise.reject(new Error('should not be asked — persisted grant covers this')));
    expect(await fresh.request(CALL, WRITE_TOOL, 'second')).toBe(true);
  });

  it('destructive tools are never offered "always" persistence (allowPersist=false)', async () => {
    const engine = new PermissionEngine(grantsFile);
    let seenAllowPersist: boolean | undefined;
    engine.attachRequester((req) => {
      seenAllowPersist = req.allowPersist;
      return Promise.resolve('allow');
    });
    await engine.request({ ...CALL, name: 'delete_file' }, DESTRUCTIVE_TOOL, 'delete something');
    expect(seenAllowPersist).toBe(false);
  });

  it('safe mode ignores persisted "always" grants and re-prompts every time', async () => {
    const engine = new PermissionEngine(grantsFile);
    engine.attachRequester(() => Promise.resolve('always'));
    await engine.request(CALL, WRITE_TOOL, 'first'); // persists an "always" grant

    let safeMode = false;
    let asked = 0;
    const safeEngine = new PermissionEngine(grantsFile, () => safeMode);
    safeEngine.attachRequester(() => {
      asked++;
      return Promise.resolve('allow');
    });
    safeMode = true;
    await safeEngine.request(CALL, WRITE_TOOL, 'second');
    expect(asked).toBe(1); // prompted despite the persisted grant
  });

  it('reset() clears both session and persisted grants', async () => {
    const engine = new PermissionEngine(grantsFile);
    engine.attachRequester(() => Promise.resolve('always'));
    await engine.request(CALL, WRITE_TOOL, 'first');

    const cleared = await engine.reset();
    expect(cleared).toBe(1);

    let asked = 0;
    engine.attachRequester(() => {
      asked++;
      return Promise.resolve('deny');
    });
    await engine.request(CALL, WRITE_TOOL, 'second');
    expect(asked).toBe(1);
  });

  it('audits every decision with tool/permission/decision only — never the description text', async () => {
    const events: Array<{ name: string; meta?: Record<string, unknown> }> = [];
    const engine = new PermissionEngine(grantsFile, undefined, undefined, (name, meta) => events.push({ name, meta }));
    engine.attachRequester(() => Promise.resolve('allow'));
    await engine.request(CALL, WRITE_TOOL, 'a description with a secret file path /etc/shadow');

    expect(events).toEqual([{ name: 'permission.decision', meta: { tool: 'write_file', permission: 'write', decision: 'allow' } }]);
  });
});
