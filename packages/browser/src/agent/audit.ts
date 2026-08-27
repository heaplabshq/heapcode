import type { PermissionClass } from '@heapcode/core/agent';

/**
 * What did it just do?
 *
 * The question this product has to be able to answer. The agent acts inside the
 * user's own logged-in session, so "it added something to my cart and I don't
 * know when" has to be resolvable from a record rather than from memory
 * (PRD section 6.5).
 *
 * Kept in `chrome.storage.local` and never sent anywhere. It is a log of the
 * user's own browsing, which makes it more sensitive than the pages it
 * describes, not less.
 */

export interface AuditEntry {
  at: number;
  host: string;
  tool: string;
  args: Record<string, unknown>;
  permission: PermissionClass;
  /** What the user was shown, from our extraction rather than the model's words. */
  target?: string;
  decision: 'allowed' | 'denied' | 'auto-allowed' | 'blocked';
  /** Who decided: the user at a prompt, or policy without asking. */
  decidedBy: 'user' | 'policy';
  reason?: string;
  outcome?: 'ok' | 'error';
}

const KEY = 'heapbrowse.audit';
const MAX_ENTRIES = 500;

export async function recordAudit(entry: AuditEntry): Promise<void> {
  const stored = await chrome.storage.local.get(KEY);
  const log = (stored[KEY] as AuditEntry[] | undefined) ?? [];
  log.push(entry);
  // Bounded, oldest dropped. An unbounded log in extension storage eventually
  // becomes the reason the extension is slow to start.
  await chrome.storage.local.set({ [KEY]: log.slice(-MAX_ENTRIES) });
}

export async function readAudit(): Promise<AuditEntry[]> {
  const stored = await chrome.storage.local.get(KEY);
  return ((stored[KEY] as AuditEntry[] | undefined) ?? []).slice().reverse();
}

export async function clearAudit(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

/** A stable, readable line per entry, for the panel and for export. */
export function formatAudit(entry: AuditEntry): string {
  const when = new Date(entry.at).toISOString();
  const target = entry.target ? ` ${entry.target}` : '';
  const why = entry.reason ? ` (${entry.reason})` : '';
  return `${when}  ${entry.host}  ${entry.tool}${target}  ${entry.permission}  ${entry.decision} by ${entry.decidedBy}${why}`;
}

export function exportAudit(entries: AuditEntry[]): string {
  return entries.map(formatAudit).join('\n');
}
