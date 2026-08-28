import { useState } from 'react';
import type { ToolActivity } from '../useChat.js';
import { toolLabel } from '../../shared/toolLabels.js';
import { Icon } from './Icon.js';

/**
 * What the agent did, inline in the transcript.
 *
 * Collapsed to a single unboxed line and expandable. A run is ten of these, and
 * ten bordered cards stacked in a 350px column is a wall -- so the border and
 * the fill arrive only when one is opened, which is when it has a body worth
 * containing. The summary line has to carry the useful information on its own,
 * because that is what most users will ever read, and on this product "what did
 * it just do?" is the question that matters most: the agent is acting inside
 * the user's own logged-in session.
 *
 * Results are rendered as plain text, never as markdown. They are page content,
 * which is to say arbitrary text from an untrusted source; putting it through a
 * markdown renderer inside the extension origin would be handing it a way to
 * shape the panel.
 */

/** The one argument worth showing on the collapsed line, per tool. */
function detail(tool: ToolActivity): string | undefined {
  const args = tool.args;
  const text = (key: string): string | undefined =>
    typeof args[key] === 'string' && args[key] ? (args[key] as string) : undefined;

  if (tool.name === 'get_elements') {
    const filter = text('filter') ? `"${text('filter')}"` : undefined;
    return [text('role'), filter].filter(Boolean).join(' ') || undefined;
  }
  if (tool.name === 'scroll') {
    const pages = typeof args.pages === 'number' ? ` ${args.pages}x` : '';
    return text('direction') ? `${text('direction')}${pages}` : undefined;
  }
  if (tool.name === 'wait') {
    return typeof args.seconds === 'number' ? `${args.seconds}s` : undefined;
  }
  if (tool.name === 'navigate' || tool.name === 'open_tab') {
    const url = text('url');
    if (!url) return undefined;
    // The host, not the whole URL. A tracking-laden product link is 300
    // characters of noise on a line with room for forty.
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  if (tool.name === 'type') return text('text');
  if (tool.name === 'select') return text('option');
  if (tool.name === 'press_key') return text('key');
  if (tool.name === 'fill_form') {
    const count = Array.isArray(args.fields) ? args.fields.length : 0;
    return count ? `${count} field${count === 1 ? '' : 's'}` : undefined;
  }
  if (tool.name === 'read_page' && args.full === true) return 'full';
  if (typeof args.handle === 'number') return `[${args.handle}]`;
  return undefined;
}

export function ToolChip({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const running = tool.result === undefined;
  const label = toolLabel(tool.name);
  const info = detail(tool);

  const state = tool.isError ? 'failed' : running ? 'running' : 'done';

  return (
    <div className={`tool-chip ${state}`} data-open={open}>
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon name={tool.isError ? 'ask' : label.icon} className="tool-icon" />
        <span className="tool-name">{label.past}</span>
        {info && <span className="tool-detail">{info}</span>}
        <Icon name="chevron" size={12} className="tool-caret" />
      </button>
      {open && <pre className="tool-body">{tool.result ?? 'Running…'}</pre>}
    </div>
  );
}
