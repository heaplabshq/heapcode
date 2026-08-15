import { useEffect, useRef, useState } from 'react';
import type {
  UiBrowseFoldersResult,
  UiFolderEntry,
  UiWorkspacesResult,
} from '@heapcode/web-host/protocol';

export interface WorkspacePickerProps {
  /** Absolute path of the folder the session is pointed at. */
  current: string;
  /** Disabled while a run is in flight — switching would move the ground under it. */
  busy: boolean;
  loadWorkspaces(): Promise<UiWorkspacesResult>;
  browse(path?: string): Promise<UiBrowseFoldersResult>;
  onPick(path: string): Promise<void>;
}

/**
 * Which folder the agent is working in, and how to change it.
 *
 * Two ways in, because the two cases are genuinely different: the folder you
 * were in yesterday should be one click (Recent), and a folder you have never
 * opened should not require typing an absolute path from memory (Browse).
 *
 * Switching is not a display preference — it rebuilds the session against the
 * new root — so this reports failure inline rather than closing optimistically
 * and leaving the chip naming a folder the host never moved to.
 */
export function WorkspacePicker({
  current,
  busy,
  loadWorkspaces,
  browse,
  onPick,
}: WorkspacePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'recent' | 'browse'>('recent');
  const [workspaces, setWorkspaces] = useState<UiWorkspacesResult>();
  const [listing, setListing] = useState<UiBrowseFoldersResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<string>();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const openPicker = (): void => {
    setOpen((v) => !v);
    if (workspaces) return;
    setError(undefined);
    void loadWorkspaces()
      .then(setWorkspaces)
      .catch((err: Error) => setError(err.message));
  };

  const goto = (path?: string): void => {
    setError(undefined);
    void browse(path)
      .then(setListing)
      .catch((err: Error) => setError(err.message));
  };

  const showBrowse = (): void => {
    setTab('browse');
    // Start beside the folder you are in, not at home — the sibling of the
    // current project is overwhelmingly where the next one is.
    if (!listing) goto(parentOf(current) ?? workspaces?.home);
  };

  const choose = (path: string): void => {
    if (path === current) {
      setOpen(false);
      return;
    }
    setPending(path);
    setError(undefined);
    void onPick(path)
      .then(() => {
        setOpen(false);
        // Recents and the browse listing are both stale now.
        setWorkspaces(undefined);
        setListing(undefined);
        setTab('recent');
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setPending(undefined));
  };

  return (
    <div className="wsp" ref={box}>
      <button
        className="wsp-chip"
        onClick={openPicker}
        aria-expanded={open}
        title={busy ? 'Stop the current run before switching folder' : current}
        disabled={busy}
      >
        <IconFolder />
        <span className="wsp-name">{nameOf(current)}</span>
        <span className="wsp-caret">▾</span>
      </button>

      {open && (
        <div className="wsp-pop">
          <div className="wsp-tabs">
            <button
              className={`wsp-tab ${tab === 'recent' ? 'wsp-tab-on' : ''}`}
              onClick={() => setTab('recent')}
            >
              Recent
            </button>
            <button className={`wsp-tab ${tab === 'browse' ? 'wsp-tab-on' : ''}`} onClick={showBrowse}>
              Browse
            </button>
          </div>

          {error && <p className="wsp-msg wsp-error">{error}</p>}

          {tab === 'recent' && (
            <ul className="wsp-list">
              {!workspaces && !error && <li className="wsp-msg">Loading…</li>}
              {workspaces?.recent.map((w) => (
                <li key={w.path}>
                  <button
                    className={`wsp-row ${w.path === current ? 'wsp-row-on' : ''}`}
                    onClick={() => choose(w.path)}
                    disabled={Boolean(pending)}
                  >
                    <span className="wsp-row-name">{w.name}</span>
                    <span className="wsp-row-path">{shorten(parentOf(w.path) ?? w.path, workspaces.home)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {tab === 'browse' && (
            <>
              <div className="wsp-crumb">
                <button
                  className="wsp-up"
                  onClick={() => goto(listing?.parent)}
                  disabled={!listing?.parent}
                  title="Up one level"
                >
                  ↑
                </button>
                <span className="wsp-crumb-path" title={listing?.path}>
                  {listing ? shorten(listing.path, workspaces?.home) : '…'}
                </span>
              </div>
              {listing && (
                <button
                  className="wsp-use"
                  onClick={() => choose(listing.path)}
                  disabled={Boolean(pending) || listing.path === current}
                >
                  {listing.path === current ? 'Already open' : `Open ${nameOf(listing.path)}`}
                </button>
              )}
              <ul className="wsp-list">
                {listing?.entries.length === 0 && <li className="wsp-msg">No sub-folders.</li>}
                {listing?.entries.map((e: UiFolderEntry) => (
                  <li key={e.path}>
                    <button className="wsp-row" onClick={() => goto(e.path)}>
                      <IconFolder />
                      <span className="wsp-row-name">{e.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {pending && <p className="wsp-msg">Opening {nameOf(pending)}…</p>}
        </div>
      )}
    </div>
  );
}

function nameOf(path: string): string {
  return path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path;
}

function parentOf(path: string): string | undefined {
  const parts = path.replace(/[/\\]+$/, '').split('/');
  parts.pop();
  const parent = parts.join('/');
  return parent && parent !== path ? parent : undefined;
}

/** `/Users/you/code/app` → `~/code/app`, so a row fits without a tooltip. */
function shorten(path: string, home?: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function IconFolder(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
