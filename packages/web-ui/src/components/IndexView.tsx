import { useEffect, useMemo, useState } from 'react';
import type { UiIndexStatus, UiRepoMapFile, UiRepoMapResult } from '@heapcode/web-host/protocol';

export interface IndexViewProps {
  status?: UiIndexStatus;
  loadMap(query: string): Promise<UiRepoMapResult>;
  onRebuild(): void;
  onClear(): void;
  busy: boolean;
  /** Clicking a path opens it in the Files tab. */
  onOpenPath(path: string): void;
}

/**
 * What the agent actually knows about this workspace.
 *
 * Both indexes were previously invisible: `/index` fired a blind rebuild and
 * said "Index rebuilt", and nothing anywhere reported whether the thing had
 * ever been built, how big it was, or what was in it. When `semantic_search`
 * came back empty there was no way to tell an empty index from a bad query.
 *
 * The two are shown side by side because they fail independently. The semantic
 * index needs a reachable embeddings model and is the one that quietly stays
 * at zero when that model is misconfigured; the repo map is local tree-sitter
 * parsing that needs no provider at all. Which of the two is empty is the
 * whole diagnosis.
 */
export function IndexView({ status, loadMap, onRebuild, onClear, busy, onOpenPath }: IndexViewProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [map, setMap] = useState<UiRepoMapResult>();
  const [error, setError] = useState<string>();

  // Debounced: typing in the filter re-runs a query over every indexed file,
  // and a keystroke-per-request would ask the host thousands of times to
  // answer a question the user has not finished asking.
  const debounced = useDebounced(query, 200);
  const indexedFiles = status?.repoMap.files ?? 0;

  useEffect(() => {
    let live = true;
    setError(undefined);
    void loadMap(debounced)
      .then((r) => live && setMap(r))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
    // `indexedFiles` is a dependency on purpose: after a rebuild the map on
    // screen is stale, and refetching is cheaper than tracking what moved.
  }, [debounced, loadMap, indexedFiles]);

  const progress = status?.progress;

  return (
    <div className="idx">
      <div className="idx-cards">
        <IndexCard
          title="Semantic index"
          hint="Embedded chunks — what semantic_search queries. Needs an embeddings model."
          state={status?.semantic.available === false ? 'unavailable' : status?.semantic.state}
          rows={[
            ['Files', status?.semantic.files ?? 0],
            ['Chunks', status?.semantic.chunks ?? 0],
          ]}
        />
        <IndexCard
          title="Repo map"
          hint="Symbols and imports, parsed locally. No provider needed."
          state={status?.repoMap.ready ? 'ready' : 'not built'}
          rows={[
            ['Files', status?.repoMap.files ?? 0],
            ['Symbols', status?.repoMap.symbols ?? 0],
            ['Links', status?.repoMap.links ?? 0],
          ]}
        />
      </div>

      {progress && progress.total > 0 && (
        <div className="idx-progress">
          <div className="idx-progress-track">
            <div
              className="idx-progress-fill"
              style={{ width: `${Math.round((progress.embedded / progress.total) * 100)}%` }}
            />
          </div>
          <span className="hint">
            Embedding {progress.embedded} of {progress.total}…
          </span>
        </div>
      )}

      <div className="idx-actions">
        <button className="btn" onClick={onRebuild} disabled={busy}>
          Rebuild index
        </button>
        <button className="link-btn link-btn-danger" onClick={onClear} disabled={busy}>
          Clear
        </button>
      </div>

      <input
        className="card-input idx-filter"
        value={query}
        placeholder="Filter by path or symbol…"
        aria-label="Filter the repo map"
        onChange={(e) => setQuery(e.target.value)}
      />

      {error && <p className="banner-error">{error}</p>}

      {!error && map && (
        <>
          <p className="hint idx-count">
            {map.total === 0
              ? indexedFiles === 0
                ? 'Nothing indexed yet — rebuild to populate the map.'
                : 'No file or symbol matches.'
              : `${map.files.length} of ${map.total} file${map.total === 1 ? '' : 's'}, most depended-upon first.`}
          </p>
          <ul className="idx-list">
            {map.files.map((f) => (
              <MapFile key={f.path} file={f} onOpenPath={onOpenPath} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function IndexCard({
  title,
  hint,
  state,
  rows,
}: {
  title: string;
  hint: string;
  state?: string;
  rows: Array<[string, number]>;
}): JSX.Element {
  const bad = state === 'unavailable' || state === 'not built' || state === 'error';
  return (
    <div className="idx-card">
      <div className="idx-card-head">
        <span className="idx-card-title">{title}</span>
        <span className={`badge ${bad ? 'badge-off' : 'badge-ok'}`}>{state ?? '…'}</span>
      </div>
      {rows.map(([label, value]) => (
        <div key={label} className="idx-row">
          <span>{label}</span>
          <span className="idx-num">{value.toLocaleString()}</span>
        </div>
      ))}
      <p className="hint">{hint}</p>
    </div>
  );
}

/** One file: its symbols, and the edges in and out of it. */
function MapFile({ file, onOpenPath }: { file: UiRepoMapFile; onOpenPath(path: string): void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <li className="idx-file">
      <button className="idx-file-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="idx-caret">{open ? '▾' : '▸'}</span>
        <span className="idx-path">{file.path}</span>
        <span className="idx-meta">{file.symbols.length} sym</span>
        {/* Both directions, because "what does this pull in" and "what breaks
            if I change it" are different questions and the second is the one
            the stored map cannot answer on its own. */}
        {file.imports.length > 0 && <span className="idx-meta">→{file.imports.length}</span>}
        {file.importedBy.length > 0 && <span className="idx-meta">←{file.importedBy.length}</span>}
      </button>

      {open && (
        <div className="idx-file-body">
          <button className="link-btn" onClick={() => onOpenPath(file.path)}>
            Open {file.path} →
          </button>

          {file.symbols.length > 0 ? (
            <ul className="idx-symbols">
              {file.symbols.map((s) => (
                <li key={`${s.name}:${s.line}`}>
                  <span className="idx-sym-kind">{s.kind}</span>
                  <span className="idx-sym-name">{s.name}</span>
                  <span className="idx-sym-line">:{s.line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No symbols parsed from this file.</p>
          )}

          <Links label="Imports" paths={file.imports} onOpenPath={onOpenPath} />
          <Links label="Imported by" paths={file.importedBy} onOpenPath={onOpenPath} />
        </div>
      )}
    </li>
  );
}

function Links({
  label,
  paths,
  onOpenPath,
}: {
  label: string;
  paths: string[];
  onOpenPath(path: string): void;
}): JSX.Element | null {
  if (paths.length === 0) return null;
  return (
    <div className="idx-links">
      <span className="idx-links-label">{label}</span>
      {paths.map((p) => (
        <button key={p} className="idx-link" onClick={() => onOpenPath(p)} title={p}>
          {p}
        </button>
      ))}
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  // The first render should not wait out the delay for an empty filter.
  return useMemo(() => settled, [settled]);
}
