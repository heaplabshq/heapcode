import { useState } from 'react';
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
 */
export function DataTable({ dataset }: { dataset: Dataset }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | undefined>();

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

  return (
    <div className="dataset">
      <div className="dataset-head">
        <strong>{dataset.label ?? 'Collected rows'}</strong>
        <span className="muted">
          {dataset.rows.length} row{dataset.rows.length === 1 ? '' : 's'}
          {dataset.sources.length > 1 ? ` from ${dataset.sources.length} pages` : ''}
        </span>
      </div>

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
    </div>
  );
}
