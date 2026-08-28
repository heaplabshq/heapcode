import { useState } from 'react';
import { Icon } from './Icon.js';
import {
  suggestedFilename,
  toCsv,
  toJson,
  type Dataset,
} from '../../shared/dataset.js';

/**
 * The rows the agent collected, for the person who asked for them.
 *
 * The point of the whole collection mechanism. Before this the answer to
 * "compare these fifty listings" was a paragraph of prose the model wrote from
 * rows it had read once — plausible, unverifiable, and impossible to sort. The
 * table is the actual data, it did not pass through the model on its way here,
 * and it leaves as a file.
 *
 * Rendered in a side panel about 400 pixels wide, so it scrolls in both
 * directions inside its own box rather than making the conversation scroll
 * sideways.
 *
 * Folded away unless it was asked for. Collecting rows is worth doing whenever
 * the page has them -- it costs a call the agent was making anyway, and the set
 * is there if it turns out to be wanted. Putting a hundred rows on screen is a
 * different decision, and the honest answer to "what is in my saved list" is a
 * sentence, not a spreadsheet nobody asked to see. So it opens itself when the
 * request sounds like data and stays a single line when it does not, and either
 * way it is one press from the other.
 */
export function DataTable({ dataset, wanted }: { dataset: Dataset; wanted?: boolean }) {
  const [choice, setChoice] = useState<boolean>();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | undefined>();
  const shownTable = choice ?? Boolean(wanted);

  if (dataset.rows.length === 0) return null;

  const PREVIEW = 6;
  const shown = open ? dataset.rows : dataset.rows.slice(0, PREVIEW);

  const copy = async (what: 'csv' | 'json') => {
    await navigator.clipboard.writeText(what === 'csv' ? toCsv(dataset) : toJson(dataset));
    setCopied(what);
    setTimeout(() => setCopied(undefined), 1500);
  };

  /**
   * Saving is a blob URL and a synthetic click.
   *
   * `chrome.downloads` would be tidier and wants a permission of its own for
   * something an ordinary anchor already does from an extension page. The
   * object URL is revoked immediately after; Chrome has already taken its copy
   * by the time the click returns.
   */
  const save = (what: 'csv' | 'json') => {
    const blob = new Blob([what === 'csv' ? toCsv(dataset) : toJson(dataset)], {
      type: what === 'csv' ? 'text/csv;charset=utf-8' : 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = suggestedFilename(dataset, what);
    link.click();
    URL.revokeObjectURL(url);
  };

  const count = `${dataset.rows.length} row${dataset.rows.length === 1 ? '' : 's'}`;
  const from = dataset.sources.length > 1 ? ` from ${dataset.sources.length} pages` : '';

  return (
    <div className="dataset" data-open={shownTable}>
      <button
        type="button"
        className="dataset-head"
        onClick={() => setChoice(!shownTable)}
        aria-expanded={shownTable}
      >
        <Icon name="table" size={13} className="dataset-icon" />
        <strong>{dataset.label ?? 'Collected rows'}</strong>
        <span className="muted">
          {count}
          {from}
        </span>
        <Icon name="chevron" size={12} className="dataset-caret" />
      </button>

      {shownTable && (
        <>
      <div className="dataset-scroll">
        <table>
          <thead>
            <tr>
              {dataset.headers.map((header, index) => (
                <th key={`${header}-${index}`}>{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={`row-${r}`}>
                {dataset.headers.map((_, c) => (
                  <td key={`cell-${r}-${c}`}>{row[c] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="dataset-actions">
        {dataset.rows.length > PREVIEW && (
          <button type="button" className="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? 'Show fewer' : `Show all ${dataset.rows.length}`}
          </button>
        )}
        <button type="button" className="ghost" onClick={() => save('csv')}>
          Save CSV
        </button>
        <button type="button" className="ghost" onClick={() => save('json')}>
          Save JSON
        </button>
        <button type="button" className="ghost" onClick={() => void copy('csv')}>
          {copied === 'csv' ? 'Copied' : 'Copy'}
        </button>
      </div>
        </>
      )}
    </div>
  );
}
