import { useState } from 'react';
import type { ToolActivity } from '../useChat.js';

/**
 * What the agent did, inline in the transcript.
 *
 * Collapsed by default and expandable. The summary line has to carry the useful
 * information on its own, because that is what most users will ever read -- and
 * on this product "what did it just do?" is the question that matters most,
 * since the agent is acting inside the user's own logged-in session.
 *
 * Results are rendered as plain text, never as markdown. They are page content,
 * which is to say arbitrary text from an untrusted source; putting it through a
 * markdown renderer inside the extension origin would be handing it a way to
 * shape the panel.
 */

const LABELS: Record<string, string> = {
  read_page: 'Read the page',
  get_elements: 'Looked for controls',
  extract_data: 'Extracted table data',
  scroll: 'Scrolled',
  wait: 'Waited for the page',
  finish: 'Finished',
};

/** The one argument worth showing on the collapsed line, per tool. */
function detail(tool: ToolActivity): string | undefined {
  const args = tool.args;
  if (tool.name === 'get_elements') {
    const filter = typeof args.filter === 'string' ? `"${args.filter}"` : undefined;
    const role = typeof args.role === 'string' ? args.role : undefined;
    return [role, filter].filter(Boolean).join(' ') || undefined;
  }
  if (tool.name === 'scroll') {
    const pages = typeof args.pages === 'number' ? ` ${args.pages}x` : '';
    return typeof args.direction === 'string' ? `${args.direction}${pages}` : undefined;
  }
  if (tool.name === 'wait') {
    return typeof args.seconds === 'number' ? `${args.seconds}s` : undefined;
  }
  if (tool.name === 'read_page' && args.full === true) return 'full';
  return undefined;
}

export function ToolChip({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const running = tool.result === undefined;
  const info = detail(tool);

  return (
    <div className={`chip${tool.isError ? ' chip-error' : ''}`}>
      <button type="button" className="chip-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`chip-dot${running ? ' spinning' : ''}`} aria-hidden="true" />
        <span className="chip-name">{LABELS[tool.name] ?? tool.name}</span>
        {info && <span className="chip-detail">{info}</span>}
        <span className="chip-toggle">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <pre className="chip-body">{tool.result ?? 'Running…'}</pre>
      )}
    </div>
  );
}
