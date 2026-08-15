import { useState } from 'react';
import type { ToolItem } from '../transcript.js';
import { DiffView, diffStats, isDiffText } from './DiffView.js';

/**
 * A collapsed one-liner per tool call, expandable to the full output.
 *
 * The expanded body is deliberately whitespace-preserving: tool output is
 * whitespace-significant (diffs, tables, tracebacks), and rendering it as
 * markdown — or letting it collapse — is precisely the regression that made
 * every tool result unreadable in the CLI once before. Whatever changes here,
 * the expanded view keeps its whitespace.
 *
 * A result that *is* a diff gets `DiffView` instead of the plain `<pre>`, for
 * the same reason the CLI colours it: an edit is the thing you most want to
 * skim, and reading `+`/`-` prefixes out of undifferentiated grey text is the
 * one job colour actually does better than layout.
 */
export function ToolChip({
  tool,
  onOpenPath,
}: {
  tool: ToolItem;
  onOpenPath?(path: string): void;
}): JSX.Element {
  const summary = describeArgs(tool.name, tool.args);
  const path = typeof tool.args.path === 'string' ? tool.args.path : undefined;
  const diff = tool.done && tool.result ? isDiffText(tool.result) : false;
  // An edit opens expanded: the diff is the whole point of the call, and
  // collapsing it means the user has to click every edit to see what changed.
  const [manual, setManual] = useState<boolean>();
  const open = manual ?? diff;
  const stats = diff ? diffStats(tool.result!) : undefined;

  return (
    <div className={`chip ${tool.parent ? 'chip-nested' : ''} ${tool.isError ? 'chip-error' : ''}`}>
      <button className="chip-head" onClick={() => setManual(!open)} aria-expanded={open}>
        <span className="chip-dot">{tool.done ? (tool.isError ? '✗' : '⏺') : '◌'}</span>
        <span className="chip-name">{tool.name}</span>
        {summary && <span className="chip-args">{summary}</span>}
        {stats && (stats.added > 0 || stats.removed > 0) && (
          <span className="chip-stats">
            <span className="stat-add">+{stats.added}</span>
            <span className="stat-del">−{stats.removed}</span>
          </span>
        )}
        {/* Live output size, so a long `npm test` visibly progresses instead of
            sitting on a static spinner. */}
        {!tool.done && tool.streamedK ? <span className="chip-progress">{tool.streamedK}k</span> : null}
        {tool.done && tool.result && <span className="chip-caret">{open ? '▾' : '▸'}</span>}
      </button>
      {open && (
        <>
          {tool.result &&
            (diff ? <DiffView diff={tool.result} /> : <pre className="chip-body">{tool.result}</pre>)}
          {path && onOpenPath && (
            <button className="chip-open" onClick={() => onOpenPath(path)}>
              Open {path} →
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The one-line argument summary.
 *
 * Mirrors the wording of the host's `WorkspaceToolExecutor.describe()` where
 * it can, so a chip and its permission card read the same. It cannot call that
 * function — it lives in Node — so the shapes are kept deliberately simple and
 * fall back to the most identifying argument rather than inventing phrasing.
 */
function describeArgs(name: string, args: Record<string, unknown>): string {
  const s = (k: string): string | undefined => (typeof args[k] === 'string' ? (args[k] as string) : undefined);
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'delete_file':
    case 'create_directory':
      return s('path') ?? '';
    case 'edit_file':
    case 'multi_edit':
      return s('path') ?? '';
    case 'rename_file':
      return `${s('path') ?? ''} → ${s('newPath') ?? ''}`;
    case 'list_dir':
      return s('path') || 'workspace root';
    case 'search':
      return s('pattern') ? `/${s('pattern')}/` : '';
    case 'semantic_search':
      return s('query') ?? '';
    case 'run_command':
    case 'run_tests':
      return s('command') ?? '';
    case 'fetch_url':
      return s('url') ?? '';
    case 'web_search':
      return s('query') ?? '';
    case 'delegate_task':
      return s('task')?.slice(0, 80) ?? '';
    case 'finish':
      return '';
    default: {
      const first = Object.values(args).find((v) => typeof v === 'string') as string | undefined;
      return first ? first.slice(0, 80) : '';
    }
  }
}
