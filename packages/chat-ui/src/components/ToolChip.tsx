import type { ToolItem } from '@heapcode/web-ui/transcript';
import { useState } from 'react';

/**
 * One tool call, as a line you can open.
 *
 * Heap Chat's roster is small and all of it is reading, so the chip says what
 * was read rather than what was done — and its summary line is the
 * evidence trail the answer above it depends on.
 */
export function ToolChip({ item }: { item: ToolItem }): JSX.Element {
  const [open, setOpen] = useState(false);
  const a = item.args as Record<string, unknown>;

  const label = ((): string => {
    switch (item.name) {
      case 'read_file':
        return `Read ${String(a.path ?? '')}`;
      case 'search':
        return `Search for “${String(a.pattern ?? '')}”`;
      case 'semantic_search':
        return `Looked for “${String(a.query ?? '')}”`;
      case 'web_search':
        return `Searched the web for “${String(a.query ?? '')}”`;
      case 'fetch_url':
        return `Read ${String(a.url ?? '')}`;
      case 'ask_user':
        return 'Asked you a question';
      default:
        return item.name;
    }
  })();

  return (
    <div className={`chip${item.isError ? ' chip-error' : ''}`}>
      <button className="chip-line" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="chip-mark" aria-hidden="true">
          {item.done ? (item.isError ? '!' : '·') : '…'}
        </span>
        <span className="chip-label">{label}</span>
      </button>
      {open && item.result ? <pre className="chip-body">{item.result}</pre> : null}
    </div>
  );
}
