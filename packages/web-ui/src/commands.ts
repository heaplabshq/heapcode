/**
 * The slash-command surface, and the ⌘K palette's contents.
 *
 * Mirrors the CLI's list (packages/cli/src/ink/App.tsx:106-129) so the two
 * hosts stay recognisably the same tool. Rows the web UI answers with a
 * control instead of a command still appear here — discoverability is the
 * point of a palette, and "/settings opens the settings panel" is a better
 * answer than "unknown command".
 */

export type CommandKind =
  /** Runs as an agent task via `ui/runCommand`. */
  | 'task'
  /** Handled entirely in the browser (opens a panel, clears a view). */
  | 'ui'
  /** Not implemented in the web UI yet — says so rather than failing silently. */
  | 'pending';

export interface Command {
  name: string;
  description: string;
  kind: CommandKind;
  /** For 'pending': which milestone brings it. */
  milestone?: string;
  /**
   * Placeholder for what follows the name, e.g. `<query>`. Its presence is
   * what tells the composer's menu to complete to `/search ` and wait, rather
   * than firing a command that can only answer "usage: …".
   */
  args?: string;
}

export const COMMANDS: Command[] = [
  { name: '/help', description: 'Show available commands', kind: 'ui' },
  { name: '/settings', description: 'Open settings', kind: 'ui' },
  { name: '/model', description: 'Switch the model', kind: 'ui' },
  { name: '/profile', description: 'Switch, add, or remove provider profiles', kind: 'ui' },
  { name: '/persona', description: 'Switch persona: agent, architect, debug, reviewer', kind: 'ui' },
  { name: '/mode', description: 'Permission mode: plan, default, auto-edit, full-auto', kind: 'ui' },
  { name: '/context', description: 'Set the context window and max output tokens', kind: 'ui' },
  { name: '/websearch', description: 'Configure web search for the agent', kind: 'ui' },
  { name: '/permissions', description: 'Show or clear saved "Always allow" grants', kind: 'ui' },
  { name: '/nativetools', description: 'Native tool calling vs the text protocol', kind: 'ui' },
  { name: '/subagents', description: 'Toggle delegate_task', kind: 'ui' },
  { name: '/mcp', description: 'List configured MCP servers and their status', kind: 'ui' },
  { name: '/new', description: 'Start a new conversation', kind: 'ui' },
  { name: '/clear', description: 'Start a new conversation', kind: 'ui' },
  { name: '/resume', description: 'Pick an earlier conversation to continue', kind: 'ui' },
  { name: '/init', description: 'Set up .heapcode/HEAPCODE.md & memory.md (runs as an agent task)', kind: 'task' },

  { name: '/memory', description: 'Show the project instructions & memory the agent sees', kind: 'ui' },
  { name: '/skills', description: 'List available Skills', kind: 'ui' },
  { name: '/search', description: 'Search the workspace (semantic if indexed, text otherwise)', kind: 'ui', args: '<query>' },
  { name: '/index', description: 'Rebuild the semantic search + repo map indexes', kind: 'ui' },
  { name: '/rewind', description: 'Jump back to a checkpoint', kind: 'ui' },
  { name: '/revert', description: 'Restore every file this session touched', kind: 'ui' },
  { name: '/checkpoints', description: 'List recent checkpoints for this project', kind: 'ui' },

  {
    name: '/pr-review',
    description: "Review the current branch's PR — add \"deep\" for the verification pass",
    kind: 'ui',
    args: '[deep]',
  },
];

/** Case-insensitive prefix/substring match, exact-prefix first. */
export function matchCommands(query: string): Command[] {
  const q = query.trim().toLowerCase().replace(/^\//, '');
  if (!q) return COMMANDS;
  const starts = COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
  const contains = COMMANDS.filter(
    (c) => !starts.includes(c) && (c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)),
  );
  return [...starts, ...contains];
}

export function findCommand(name: string): Command | undefined {
  const n = name.trim().split(/\s+/)[0]?.toLowerCase();
  return COMMANDS.find((c) => c.name === n);
}
