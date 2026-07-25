import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

/**
 * Same parser as packages/webview-ui (marked) + a terminal ANSI renderer
 * instead of HTML, so markdown that renders correctly in the webview has
 * the best chance of rendering correctly here too (see docs/CLI_PLAN.md
 * decisions log).
 */
const renderer = new Marked();
renderer.use(markedTerminal());

/** Renders a complete markdown string to ANSI for terminal display. */
export function renderMarkdown(text: string): string {
  const out = renderer.parse(text, { async: false });
  return typeof out === 'string' ? out.trimEnd() : text;
}
