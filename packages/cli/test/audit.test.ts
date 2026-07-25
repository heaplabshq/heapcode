import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-audit-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('AuditLog', () => {
  it('tracks events and persists them across instances', async () => {
    const path = join(root, 'audit.json');
    const log = new AuditLog(path);
    await log.track('permission.decision', { tool: 'write_file', decision: 'allow' });

    const reloaded = new AuditLog(path);
    const history = await reloaded.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ name: 'permission.decision', meta: { tool: 'write_file', decision: 'allow' } });
  });

  it('caps at 500 events, dropping the oldest first', async () => {
    const log = new AuditLog(join(root, 'audit.json'));
    for (let i = 0; i < 505; i++) await log.track('event', { i });
    const history = await log.history();
    expect(history).toHaveLength(500);
    expect(history[0]!.meta).toEqual({ i: 5 }); // the first 5 were dropped
  });

  it('never records anything when disabled — the local audit opt-out', async () => {
    const log = new AuditLog(join(root, 'audit.json'), () => false);
    await log.track('permission.decision', {});
    expect(await log.history()).toEqual([]);
  });
});
