import { useEffect, useId, useRef, useState } from 'react';

export interface ModelInputProps {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  'aria-label': string;
  /**
   * Fetches the models this field's endpoint serves. Called on first focus,
   * never on mount — a profile editor with seven role fields would otherwise
   * fire seven provider round-trips just by being opened.
   */
  listModels(): Promise<string[]>;
}

/**
 * A text field that suggests what the endpoint actually serves.
 *
 * Type-ahead over a fetched list rather than a `<select>`, because both halves
 * are real: the list is the answer nearly every time, and a model id the
 * endpoint does not advertise still has to be typeable — a proxy that serves
 * models it will not enumerate is common enough that a closed dropdown would
 * make those profiles uneditable.
 *
 * Failure is quiet on purpose. If the endpoint is unreachable this stays a
 * plain text box with a one-line note: not being able to *list* models is no
 * reason to stop someone *naming* one, and that is exactly the moment they are
 * most likely to be fixing a broken profile.
 */
export function ModelInput({
  value,
  onChange,
  placeholder,
  listModels,
  'aria-label': label,
}: ModelInputProps): JSX.Element {
  const [models, setModels] = useState<string[]>();
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const load = (): void => {
    if (models || state === 'loading') return;
    setState('loading');
    void listModels()
      .then((list) => {
        setModels(list);
        setState('idle');
      })
      .catch(() => setState('failed'));
  };

  // Filtered by what is typed, so the field narrows as you go. An exact match
  // is not filtered away — it is simply the only thing left.
  const matches = (models ?? []).filter((m) => m.toLowerCase().includes(value.trim().toLowerCase()));
  const showList = open && matches.length > 0;

  const choose = (model: string): void => {
    onChange(model);
    setOpen(false);
  };

  return (
    <div className="mi" ref={box}>
      <input
        className="card-input mi-input"
        value={value}
        placeholder={state === 'loading' ? 'Loading models…' : placeholder}
        aria-label={label}
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        autoComplete="off"
        role="combobox"
        onFocus={() => {
          load();
          setOpen(true);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            // Stops here: the settings dialog also closes on Escape, and the
            // first press should shut the list, not the whole dialog.
            e.stopPropagation();
            setOpen(false);
            return;
          }
          if (!showList) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (i + 1) % matches.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i - 1 + matches.length) % matches.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(matches[active] ?? value);
          }
        }}
      />

      {showList && (
        <ul className="mi-list" id={listId} role="listbox">
          {matches.slice(0, 50).map((m, i) => (
            <li key={m}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={`mi-item ${i === active ? 'mi-item-active' : ''}`}
                // mousedown, not click: the input's blur would tear the list
                // down before a click ever landed.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(m);
                }}
                onMouseEnter={() => setActive(i)}
              >
                {m}
              </button>
            </li>
          ))}
        </ul>
      )}

      {state === 'failed' && <p className="hint mi-note">Could not list models — type an id.</p>}
    </div>
  );
}
