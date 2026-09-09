import { useState } from 'react';
import type { Grounding } from '@heapcode/chat-host';

/**
 * What the answer above is standing on.
 *
 * Only drawn for answers that actually used the folder. A general-knowledge
 * reply carries no badge, and that absence is the point: a badge that appears
 * on everything says nothing when it appears.
 *
 * The verdict is shown, including when it is bad. An answer the checker could
 * not support is still displayed — the person asked, and hiding a shaky answer
 * behind a refusal tells them less than showing it with the doubt attached.
 */
export function GroundingBadge({ grounding }: { grounding: Grounding }): JSX.Element {
  const [open, setOpen] = useState(false);
  const { sources, provenance, verdict, issues } = grounding;

  const tone = verdict === 'unsupported' ? 'bad' : verdict === 'partial' ? 'mixed' : 'good';
  const label =
    verdict === 'unsupported'
      ? 'Not supported by these files'
      : verdict === 'partial'
        ? 'Partly supported'
        : 'Grounded';

  return (
    <div className={`grounding grounding-${tone}`}>
      <button className="grounding-line" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="grounding-mark" aria-hidden="true">
          {tone === 'good' ? '✓' : tone === 'mixed' ? '~' : '!'}
        </span>
        <span>
          {label} · {sources.length} source{sources.length === 1 ? '' : 's'}
        </span>
      </button>

      {open ? (
        <div className="grounding-body">
          {sources.length ? (
            <ul className="grounding-sources">
              {sources.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : null}

          {provenance.length ? (
            <table className="grounding-values">
              <tbody>
                {provenance.map((p) => (
                  <tr key={`${p.value}-${p.source}`}>
                    <th scope="row">{p.value}</th>
                    <td>
                      <span className="grounding-source">{p.source}</span>
                      <span className="grounding-snippet">{p.snippet}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {issues?.length ? (
            <ul className="grounding-issues">
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
