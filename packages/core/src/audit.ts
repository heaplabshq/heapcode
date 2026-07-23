export interface AuditEvent {
  name: string;
  ts: number;
  meta?: Record<string, unknown>;
}

const PERMISSION_DECISIONS = ['allow', 'session', 'always', 'deny', 'auto-session', 'auto-always'];
const CHECKPOINT_EVENTS = [
  'checkpoint.revertAll',
  'checkpoint.revertFile',
  'checkpoint.reapplyFile',
  'checkpoint.keepFile',
  'checkpoint.keepAll',
  'checkpoint.restoreTurn',
  'checkpoint.restoreStep',
];

function formatDate(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Renders a local usage/audit trail (PLAN.md M13) from Telemetry.auditHistory() —
 * retention stats (M10), permission decisions, checkpoint activity (M8), a full
 * event-count breakdown, and recent raw activity. Plain text: no rendering
 * framework needed, and it's exactly the format `Heap Code: Show Repo Map
 * Ranking (Debug)` already established for this kind of local inspection view.
 */
export function formatAuditDashboard(events: readonly AuditEvent[]): string {
  if (events.length === 0) {
    return 'Heap Code — Usage & Audit Dashboard\n\nNo activity recorded yet in this installation.';
  }

  const byName = new Map<string, number>();
  for (const e of events) byName.set(e.name, (byName.get(e.name) ?? 0) + 1);

  const lines: string[] = [
    'Heap Code — Usage & Audit Dashboard',
    'Local only — nothing on this page ever leaves your machine.',
    `${events.length} event(s) recorded, ${formatDate(events[0]!.ts)} → ${formatDate(events[events.length - 1]!.ts)}`,
    '',
  ];

  const retained = (byName.get('completion.retained') ?? 0) + (byName.get('edit.retained') ?? 0);
  const reverted = (byName.get('completion.reverted') ?? 0) + (byName.get('edit.reverted') ?? 0);
  if (retained + reverted > 0) {
    const rate = Math.round((retained / (retained + reverted)) * 100);
    lines.push(
      '== Suggestion retention (M10) ==',
      `Completions  — accepted: ${byName.get('completion.accepted') ?? 0}, retained: ${byName.get('completion.retained') ?? 0}, reverted: ${byName.get('completion.reverted') ?? 0}`,
      `Inline edits — accepted: ${byName.get('inlineEdit.accepted') ?? 0}, retained: ${byName.get('edit.retained') ?? 0}, reverted: ${byName.get('edit.reverted') ?? 0}`,
      `Overall retention rate: ${rate}% (${retained}/${retained + reverted} resolved watches kept)`,
      '',
    );
  }

  const permEvents = events.filter((e) => e.name === 'permission.decision');
  if (permEvents.length > 0) {
    lines.push('== Permission decisions ==');
    const byDecision = new Map<string, number>();
    for (const e of permEvents) {
      const d = String(e.meta?.decision ?? 'unknown');
      byDecision.set(d, (byDecision.get(d) ?? 0) + 1);
    }
    for (const d of PERMISSION_DECISIONS) {
      const n = byDecision.get(d);
      if (n) lines.push(`  ${d.padEnd(14)} ${n}`);
    }
    lines.push('');
  }

  const checkpointCount = CHECKPOINT_EVENTS.reduce((n, name) => n + (byName.get(name) ?? 0), 0);
  if (checkpointCount > 0) {
    lines.push('== Checkpoint activity (M8) ==');
    for (const name of CHECKPOINT_EVENTS) {
      const n = byName.get(name);
      if (n) lines.push(`  ${name.replace('checkpoint.', '').padEnd(14)} ${n}`);
    }
    lines.push('');
  }

  lines.push('== All events ==');
  for (const [name, count] of [...byName.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(count).padStart(4)}  ${name}`);
  }
  lines.push('');

  lines.push('== Recent activity (last 50) ==');
  for (const e of events.slice(-50).reverse()) {
    const meta = e.meta && Object.keys(e.meta).length > 0 ? ` ${JSON.stringify(e.meta)}` : '';
    lines.push(`  ${formatDate(e.ts)}  ${e.name}${meta}`);
  }

  return lines.join('\n');
}
