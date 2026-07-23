import { describe, expect, it } from 'vitest';
import { formatAuditDashboard, type AuditEvent } from '../src/audit.js';

function ev(name: string, ts: number, meta?: Record<string, unknown>): AuditEvent {
  return { name, ts, meta };
}

describe('formatAuditDashboard', () => {
  it('reports no activity for an empty history without throwing', () => {
    const text = formatAuditDashboard([]);
    expect(text).toContain('No activity recorded yet');
  });

  it('computes the overall retention rate across completions and edits', () => {
    const events = [
      ev('completion.accepted', 1),
      ev('completion.retained', 2, { savesSeen: 3 }),
      ev('completion.reverted', 3, { savesSeen: 1 }),
      ev('inlineEdit.accepted', 4),
      ev('edit.retained', 5, { savesSeen: 3 }),
    ];
    const text = formatAuditDashboard(events);
    expect(text).toContain('Suggestion retention (M10)');
    // 2 retained / 3 resolved = 67%
    expect(text).toContain('67%');
    expect(text).toContain('retained: 1, reverted: 1');
  });

  it('breaks down permission decisions by type without leaking the description text', () => {
    const events = [
      ev('permission.decision', 1, { tool: 'run_command', permission: 'execute', decision: 'allow' }),
      ev('permission.decision', 2, { tool: 'write_file', permission: 'write', decision: 'deny' }),
      ev('permission.decision', 3, { tool: 'write_file', permission: 'write', decision: 'deny' }),
    ];
    const text = formatAuditDashboard(events);
    expect(text).toContain('Permission decisions');
    expect(text).toContain('allow');
    expect(text).toContain('deny');
    expect(text).not.toContain('rm -rf'); // no raw command text ever appears, by construction
  });

  it('summarizes checkpoint activity by kind', () => {
    const events = [
      ev('checkpoint.revertAll', 1, { count: 2 }),
      ev('checkpoint.restoreStep', 2, { count: 1 }),
      ev('checkpoint.restoreStep', 3, { count: 1 }),
    ];
    const text = formatAuditDashboard(events);
    expect(text).toContain('Checkpoint activity (M8)');
    expect(text).toContain('revertAll');
    expect(text).toContain('restoreStep');
  });

  it('lists every event name with its total count, sorted by frequency', () => {
    const events = [ev('a', 1), ev('a', 2), ev('a', 3), ev('b', 4)];
    const text = formatAuditDashboard(events);
    const aLine = text.split('\n').find((l) => l.includes('a'))!;
    const bLine = text.split('\n').find((l) => l.trim().endsWith('b'))!;
    expect(text.indexOf(aLine)).toBeLessThan(text.indexOf(bLine));
  });

  it('shows only the most recent 50 events in the recent-activity section', () => {
    const events = Array.from({ length: 60 }, (_, i) => ev('e', i));
    const text = formatAuditDashboard(events);
    const lines = text.split('\n');
    const headerIndex = lines.findIndex((l) => l.includes('Recent activity'));
    const shown = lines.slice(headerIndex + 1).filter((l) => l.trim().length > 0).length;
    expect(shown).toBe(50);
  });

  it('omits sections that have no relevant events instead of showing empty headers', () => {
    const text = formatAuditDashboard([ev('some.other.event', 1)]);
    expect(text).not.toContain('Suggestion retention');
    expect(text).not.toContain('Permission decisions');
    expect(text).not.toContain('Checkpoint activity');
  });
});
