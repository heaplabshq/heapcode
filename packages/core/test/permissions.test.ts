import { describe, expect, it } from 'vitest';
import {
  PermissionEngine,
  type PermissionGrantStore,
  type ToolCall,
  type ToolDefinition,
} from '../src/index.js';

const WRITE_TOOL: ToolDefinition = { name: 'write_file', description: 'x', parameters: {}, permission: 'write' };
const DESTRUCTIVE_TOOL: ToolDefinition = { name: 'delete_file', description: 'x', parameters: {}, permission: 'destructive' };
const READ_TOOL: ToolDefinition = { name: 'read_file', description: 'x', parameters: {}, permission: 'read' };
const CALL: ToolCall = { id: '1', name: 'write_file', args: {} };

/** Stands in for the CLI's JSON file and the extension's Memento. */
function memoryGrants(): PermissionGrantStore & { keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    has: (key) => Promise.resolve(keys.has(key)),
    add: async (key) => void keys.add(key),
    clear: async () => {
      const n = keys.size;
      keys.clear();
      return n;
    },
  };
}

const EXECUTE_TOOL: ToolDefinition = { name: 'run_command', description: 'x', parameters: {}, permission: 'execute' };

/**
 * The mode is the coarse switch that sits above per-tool grants: it is
 * consulted first, so a user who just moved the session into auto is not
 * still prompted for something they never granted individually.
 */
describe('PermissionEngine permission modes', () => {
  it('auto-edit approves a write with no requester at all', async () => {
    const engine = new PermissionEngine({ grants: memoryGrants(), mode: () => 'auto-edit' });
    engine.attachRequester(() => Promise.reject(new Error('should not be called')));
    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(true);
  });

  it('auto-edit still asks before running a command', async () => {
    let asked = 0;
    const engine = new PermissionEngine({ grants: memoryGrants(), mode: () => 'auto-edit' });
    engine.attachRequester(() => {
      asked++;
      return Promise.resolve('allow');
    });
    expect(await engine.request({ id: '2', name: 'run_command', args: {} }, EXECUTE_TOOL, 'run it')).toBe(true);
    expect(asked).toBe(1);
  });

  it('full-auto approves writes and commands without asking', async () => {
    const engine = new PermissionEngine({ grants: memoryGrants(), mode: () => 'full-auto' });
    engine.attachRequester(() => Promise.reject(new Error('should not be called')));
    expect(await engine.request(CALL, WRITE_TOOL, 'write')).toBe(true);
    expect(await engine.request({ id: '2', name: 'run_command', args: {} }, EXECUTE_TOOL, 'run')).toBe(true);
  });

  /** The line that makes the Shift+Tab toggle safe to leave on. */
  it('full-auto still asks before a destructive action', async () => {
    let asked = 0;
    const engine = new PermissionEngine({ grants: memoryGrants(), mode: () => 'full-auto' });
    engine.attachRequester(() => {
      asked++;
      return Promise.resolve('deny');
    });
    const call: ToolCall = { id: '3', name: 'delete_file', args: {} };
    expect(await engine.request(call, DESTRUCTIVE_TOOL, 'rm -rf')).toBe(false);
    expect(asked).toBe(1);
  });

  it('plan mode denies a write without asking', async () => {
    const engine = new PermissionEngine({ grants: memoryGrants(), mode: () => 'plan' });
    engine.attachRequester(() => Promise.reject(new Error('should not be called')));
    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(false);
  });

  it('plan mode overrides even a persisted "always" grant', async () => {
    const grants = memoryGrants();
    grants.keys.add('write.write_file');
    const engine = new PermissionEngine({ grants, mode: () => 'plan' });
    engine.attachRequester(() => Promise.reject(new Error('should not be called')));
    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(false);
  });

  it('safe mode wins over an auto mode — every action is asked about again', async () => {
    let asked = 0;
    const engine = new PermissionEngine({
      grants: memoryGrants(),
      safeMode: () => true,
      mode: () => 'full-auto',
    });
    engine.attachRequester(() => {
      asked++;
      return Promise.resolve('allow');
    });
    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(true);
    expect(asked).toBe(1);
  });

  it('reads the mode per request, so a mid-run change takes effect', async () => {
    let mode: 'default' | 'full-auto' = 'default';
    let asked = 0;
    const engine = new PermissionEngine({ grants: memoryGrants(), mode: () => mode });
    engine.attachRequester(() => {
      asked++;
      return Promise.resolve('allow');
    });
    await engine.request(CALL, WRITE_TOOL, 'first');
    expect(asked).toBe(1);
    mode = 'full-auto';
    await engine.request(CALL, WRITE_TOOL, 'second');
    expect(asked).toBe(1); // no second prompt
  });

  it('behaves exactly as before when no mode getter is supplied', async () => {
    let asked = 0;
    const engine = new PermissionEngine({ grants: memoryGrants() });
    engine.attachRequester(() => {
      asked++;
      return Promise.resolve('allow');
    });
    expect(await engine.request(CALL, WRITE_TOOL, 'write')).toBe(true);
    expect(asked).toBe(1);
  });
});

describe('PermissionEngine', () => {
  it('read-permission tools never prompt', async () => {
    const engine = new PermissionEngine({ grants: memoryGrants() });
    engine.attachRequester(() => Promise.reject(new Error('should not be called')));
    expect(await engine.request(CALL, READ_TOOL, 'read something')).toBe(true);
  });

  it('"deny" from the requester returns false', async () => {
    const engine = new PermissionEngine({ grants: memoryGrants() });
    engine.attachRequester(() => Promise.resolve('deny'));
    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(false);
  });

  it('"session" grant auto-allows the same tool again, but not after resetSession', async () => {
    const engine = new PermissionEngine({ grants: memoryGrants() });
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

  it('"always" grant is written to the store under <permission>.<tool> and skips later prompts', async () => {
    const grants = memoryGrants();
    const engine = new PermissionEngine({ grants });
    engine.attachRequester(() => Promise.resolve('always'));
    expect(await engine.request(CALL, WRITE_TOOL, 'first')).toBe(true);
    expect([...grants.keys]).toEqual(['write.write_file']);

    const fresh = new PermissionEngine({ grants });
    fresh.attachRequester(() => Promise.reject(new Error('should not be asked — persisted grant covers this')));
    expect(await fresh.request(CALL, WRITE_TOOL, 'second')).toBe(true);
  });

  it('destructive tools are never offered "always" persistence (allowPersist=false)', async () => {
    const engine = new PermissionEngine({ grants: memoryGrants() });
    let seenAllowPersist: boolean | undefined;
    engine.attachRequester((req) => {
      seenAllowPersist = req.allowPersist;
      return Promise.resolve('allow');
    });
    await engine.request({ ...CALL, name: 'delete_file' }, DESTRUCTIVE_TOOL, 'delete something');
    expect(seenAllowPersist).toBe(false);
  });

  it('safe mode ignores persisted "always" grants, re-prompts, and refuses to persist', async () => {
    const grants = memoryGrants();
    const seeded = new PermissionEngine({ grants });
    seeded.attachRequester(() => Promise.resolve('always'));
    await seeded.request(CALL, WRITE_TOOL, 'first');

    let safeMode = false;
    let asked = 0;
    let seenAllowPersist: boolean | undefined;
    const engine = new PermissionEngine({ grants, safeMode: () => safeMode });
    engine.attachRequester((req) => {
      asked++;
      seenAllowPersist = req.allowPersist;
      return Promise.resolve('allow');
    });
    safeMode = true;
    await engine.request(CALL, WRITE_TOOL, 'second');
    expect(asked).toBe(1); // prompted despite the persisted grant
    expect(seenAllowPersist).toBe(false);
  });

  it('reset() clears both session and persisted grants', async () => {
    const engine = new PermissionEngine({ grants: memoryGrants() });
    engine.attachRequester(() => Promise.resolve('always'));
    await engine.request(CALL, WRITE_TOOL, 'first');

    expect(await engine.reset()).toBe(1);

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
    const engine = new PermissionEngine({
      grants: memoryGrants(),
      track: (name, meta) => events.push({ name, meta }),
    });
    engine.attachRequester(() => Promise.resolve('allow'));
    await engine.request(CALL, WRITE_TOOL, 'a description with a secret file path /etc/shadow');

    expect(events).toEqual([
      { name: 'permission.decision', meta: { tool: 'write_file', permission: 'write', decision: 'allow' } },
    ]);
  });
});

/**
 * The extension asks in a chat card first and falls back to a modal when the
 * chat can't ask; the CLI has one channel and fails closed. Both shapes go
 * through the same primary/fallback pair, and neither host had a test for it.
 */
describe('PermissionEngine request channels', () => {
  it('falls back to the second channel when the primary declines to ask', async () => {
    const asked: string[] = [];
    const engine = new PermissionEngine({
      grants: memoryGrants(),
      fallbackRequester: () => {
        asked.push('fallback');
        return Promise.resolve('allow');
      },
    });
    engine.attachRequester(() => {
      asked.push('primary');
      return Promise.resolve(undefined); // e.g. the chat view isn't open
    });

    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(true);
    expect(asked).toEqual(['primary', 'fallback']);
  });

  it('does not reach the fallback when the primary answers — including on a denial', async () => {
    let fallbackCalls = 0;
    const engine = new PermissionEngine({
      grants: memoryGrants(),
      fallbackRequester: () => {
        fallbackCalls++;
        return Promise.resolve('allow');
      },
    });
    engine.attachRequester(() => Promise.resolve('deny'));

    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(false);
    expect(fallbackCalls).toBe(0);
  });

  it('uses the fallback alone when no primary is attached', async () => {
    const engine = new PermissionEngine({
      grants: memoryGrants(),
      fallbackRequester: () => Promise.resolve('allow'),
    });
    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(true);
  });

  it('fails closed with nowhere to ask, and says so in the audit trail', async () => {
    const events: Array<{ meta?: Record<string, unknown> }> = [];
    const engine = new PermissionEngine({ grants: memoryGrants(), track: (_n, meta) => events.push({ meta }) });

    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(false);
    expect(events[0]?.meta?.decision).toBe('deny-no-requester');
  });

  it('a primary that declines with no fallback configured also fails closed', async () => {
    const engine = new PermissionEngine({ grants: memoryGrants() });
    engine.attachRequester(() => Promise.resolve(undefined));
    expect(await engine.request(CALL, WRITE_TOOL, 'write something')).toBe(false);
  });
});
