import { useEffect, useState } from 'react';
import { clearAudit, exportAudit, readAudit, type AuditEntry } from '../../agent/audit.js';

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
  allowed: 'you allowed',
  denied: 'you refused',
  'auto-allowed': 'allowed by settings',
  blocked: 'blocked',
};

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
        <p className="muted">Nothing yet. Actions on a page are recorded here as they happen.</p>
      )}

      {entries && entries.length > 0 && (
        <>
          <ul className="audit-list">
            {entries.map((entry, i) => (
              <li key={i} className={`audit-row audit-${entry.decision}`}>
                <div className="audit-line">
                  <span className="audit-tool">{entry.tool}</span>
                  {entry.target && <span className="audit-target">{entry.target}</span>}
                </div>
                <div className="audit-meta">
                  {new Date(entry.at).toLocaleString()} · {entry.host} · {entry.permission} ·{' '}
                  {DECISION_LABEL[entry.decision]}
                </div>
                {entry.reason && <div className="audit-reason">{entry.reason}</div>}
              </li>
            ))}
          </ul>
          <div className="row">
            <button type="button" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy all'}
            </button>
            <button
              type="button"
              className="danger"
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
