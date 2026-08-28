import { useEffect, useState } from 'react';
import { clearAudit, exportAudit, readAudit, type AuditEntry } from '../../agent/audit.js';
import { Icon } from './Icon.js';

/**
 * What it did, and who let it.
 *
 * The record already existed; without something that shows it, "what did it
 * just do?" was answerable in principle and not in practice, which is the same
 * as not at all (PRD section 6.5).
 *
 * Shows the decision and the decider as prominently as the action, because the
 * interesting question is rarely "did it click something" -- it is "did I agree
 * to that, or did a setting agree on my behalf".
 */

const DECISION_LABEL: Record<AuditEntry['decision'], string> = {
  allowed: 'You allowed',
  denied: 'You refused',
  'auto-allowed': 'Auto-allowed',
  blocked: 'Blocked',
};

/** "2h ago", "just now" — enough to tell recent from old without a wall of dates. */
function relative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void readAudit().then(setEntries);
  }, []);

  const copy = async () => {
    await navigator.clipboard.writeText(exportAudit(entries ?? []));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="pane">
      {entries === undefined && <p className="muted">Loading…</p>}
      {entries?.length === 0 && (
        <div className="audit-empty">
          <Icon name="log" className="audit-empty-icon" />
          <p className="muted">
            Nothing yet. Actions on a page are recorded here as they happen.
          </p>
        </div>
      )}

      {entries && entries.length > 0 && (
        <>
          <ul className="audit-list">
            {entries.map((entry, i) => {
              const denied = entry.decision === 'denied' || entry.decision === 'blocked';
              return (
                <li
                  key={i}
                  className={`audit-entry${denied ? ' is-denied' : ''}`}
                >
                  <span className="audit-node" aria-hidden="true" />
                  <div className="audit-body">
                    <div className="audit-line">
                      <span className="audit-tool">{entry.tool}</span>
                      {entry.target && <span className="audit-target">{entry.target}</span>}
                      <span
                        className={`audit-decision${denied ? ' is-denied' : ''}`}
                      >
                        {DECISION_LABEL[entry.decision]}
                      </span>
                    </div>
                    <div className="audit-meta">
                      <span className="audit-when" title={new Date(entry.at).toLocaleString()}>
                        {relative(entry.at)}
                      </span>
                      <span className="audit-host">{entry.host}</span>
                      <span className="audit-perm">{entry.permission}</span>
                    </div>
                    {entry.reason && <div className="audit-reason">{entry.reason}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="audit-actions">
            <button type="button" className="ghost" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy all'}
            </button>
            <button
              type="button"
              className="ghost danger"
              onClick={async () => {
                await clearAudit();
                setEntries([]);
              }}
            >
              Clear
            </button>
          </div>
        </>
      )}
    </div>
  );
}