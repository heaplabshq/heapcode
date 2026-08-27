import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAudit,
  exportAudit,
  formatAudit,
  readAudit,
  recordAudit,
  type AuditEntry,
} from '../src/agent/audit.js';

/**
 * The record behind "what did it just do?".
 *
 * The question that has to be answerable, because the agent acts inside the
 * user's own logged-in session. What matters most in each entry is not the
 * action but the decision and who made it -- whether the user agreed, or a
 * setting agreed on their behalf.
 */

function stubStorage() {
  const store: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(store, values)),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
    },
  });
  return store;
}

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  at: Date.UTC(2026, 7, 27, 12, 0, 0),
  host: 'amazon.in',
  tool: 'click',
  args: { handle: 4 },
  permission: 'write',
  decision: 'allowed',
  decidedBy: 'user',
  ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('recording decisions', () => {
  it('keeps entries and returns them newest first', async () => {
    stubStorage();
    await recordAudit(entry({ tool: 'click' }));
    await recordAudit(entry({ tool: 'type', at: Date.UTC(2026, 7, 27, 12, 5, 0) }));

    const log = await readAudit();
    expect(log.map((e) => e.tool)).toEqual(['type', 'click']);
  });

  it('records who decided, not just what happened', async () => {
    // The interesting question is rarely "did it click something" but "did I
    // agree to that, or did a setting agree for me".
    stubStorage();
    await recordAudit(entry({ decision: 'auto-allowed', decidedBy: 'policy' }));
    const [recorded] = await readAudit();
    expect(recorded?.decision).toBe('auto-allowed');
    expect(recorded?.decidedBy).toBe('policy');
  });

  it('records refusals and blocks, not only the things that happened', async () => {
    stubStorage();
    await recordAudit(entry({ decision: 'blocked', decidedBy: 'policy', reason: 'banking site' }));
    await recordAudit(entry({ decision: 'denied', decidedBy: 'user' }));
    const log = await readAudit();
    expect(log.map((e) => e.decision)).toEqual(['denied', 'blocked']);
  });

  it('is bounded, so it cannot become the reason the extension starts slowly', async () => {
    const store = stubStorage();
    for (let i = 0; i < 520; i++) await recordAudit(entry({ at: i }));
    expect((store['heapbrowse.audit'] as AuditEntry[]).length).toBe(500);
    // The oldest go, not the newest.
    const log = await readAudit();
    expect(log[0]?.at).toBe(519);
  });

  it('can be cleared', async () => {
    stubStorage();
    await recordAudit(entry());
    await clearAudit();
    expect(await readAudit()).toEqual([]);
  });

  it('reads as empty before anything has happened', async () => {
    stubStorage();
    expect(await readAudit()).toEqual([]);
  });
});

describe('exporting', () => {
  it('puts the decision and the decider on every line', () => {
    const line = formatAudit(entry({ target: '[4] "Add to cart"' }));
    expect(line).toContain('amazon.in');
    expect(line).toContain('click');
    expect(line).toContain('[4] "Add to cart"');
    expect(line).toContain('allowed by user');
  });

  it('is one line per entry', () => {
    expect(exportAudit([entry(), entry()]).split('\n')).toHaveLength(2);
  });
});
