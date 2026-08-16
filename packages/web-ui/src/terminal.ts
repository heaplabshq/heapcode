import type { TerminalEntry } from './components/Panel.js';
import type { Item, ToolItem } from './transcript.js';

/** Tools whose output belongs in the Terminal tab rather than a chip body. */
const COMMAND_TOOLS = new Set(['run_command', 'run_tests']);

/**
 * The Terminal tab, derived from the transcript rather than stored separately.
 *
 * Command output already arrives as `tool_call`/`tool_result` and is already
 * folded into the transcript, so keeping a second copy would mean two things
 * to keep in sync — and would lose the mapping the moment replay rebuilt one
 * of them. Deriving means the tab is correct after a reconnect for free.
 */
export function terminalEntries(items: Item[]): TerminalEntry[] {
  const out: TerminalEntry[] = [];
  for (const item of items) {
    if (item.kind !== 'tool') continue;
    const tool = item as ToolItem;
    if (!COMMAND_TOOLS.has(tool.name)) continue;
    const command = typeof tool.args.command === 'string' ? tool.args.command : tool.name;
    out.push({
      id: tool.id,
      command,
      output: tool.result,
      isError: tool.isError,
      done: tool.done,
    });
  }
  return out;
}
