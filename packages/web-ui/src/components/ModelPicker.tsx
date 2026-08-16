import { useEffect, useRef, useState } from 'react';

export interface ModelPickerProps {
  current: string;
  listModels(): Promise<Array<{ id: string }>>;
  onPick(model: string): void;
  /** 'up' opens the popup above the button — it lives at the bottom of the page. */
  placement?: 'down' | 'up';
}

/**
 * The model switcher.
 *
 * A plain `<select>` that fetched on focus was the first attempt and it read
 * as broken: fetching the list means a round trip to the provider, so a slow
 * or unreachable endpoint left a dropdown containing only the current model
 * and no indication that anything was happening. This version is explicit
 * about loading and failure — and, importantly, still lets you type a model id
 * by hand when the list cannot be fetched at all, which is exactly the moment
 * you most need to switch away from whatever is broken.
 */
export function ModelPicker({ current, listModels, onPick, placement = 'down' }: ModelPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('');
  const [manual, setManual] = useState('');
  const box = useRef<HTMLDivElement>(null);

  // Close on outside click and on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const load = (): void => {
    if (models || loading) return;
    setLoading(true);
    setError(undefined);
    void listModels()
      .then((list) => setModels(list.map((m) => m.id)))
      .catch((err: Error) => setError(err.message || 'Could not reach the provider.'))
      .finally(() => setLoading(false));
  };

  const choose = (id: string): void => {
    if (!id.trim()) return;
    onPick(id.trim());
    setOpen(false);
  };

  const shown = (models ?? []).filter((m) => m.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="picker" ref={box}>
      <button
        className="btn picker-btn"
        onClick={() => {
          setOpen((v) => !v);
          load();
        }}
        title={current || 'No model selected'}
        aria-expanded={open}
      >
        <span className="picker-value">{current || 'select model'}</span>
        <span className="picker-caret">▾</span>
      </button>

      {open && (
        <div className={`picker-pop ${placement === 'up' ? 'picker-pop-up' : ''}`}>
          <input
            className="picker-filter"
            autoFocus
            value={filter}
            placeholder="Filter models…"
            aria-label="Filter models"
            onChange={(e) => setFilter(e.target.value)}
          />

          {loading && <p className="hint picker-msg">Loading models…</p>}

          {error && (
            <>
              <p className="hint picker-msg">{error}</p>
              <p className="hint picker-msg">Type a model id instead:</p>
            </>
          )}

          {!loading && !error && shown.length === 0 && models && (
            <p className="hint picker-msg">No models matched.</p>
          )}

          {shown.length > 0 && (
            <ul className="picker-list">
              {shown.map((m) => (
                <li key={m}>
                  <button className={`picker-item ${m === current ? 'picker-item-active' : ''}`} onClick={() => choose(m)}>
                    {m}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="picker-manual"
            onSubmit={(e) => {
              e.preventDefault();
              choose(manual);
            }}
          >
            <input
              className="picker-filter"
              value={manual}
              placeholder="or type a model id…"
              aria-label="Model id"
              onChange={(e) => setManual(e.target.value)}
            />
            <button className="btn" type="submit" disabled={!manual.trim()}>
              Use
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
