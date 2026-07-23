/**
 * marked-terminal 7.x ships no .d.ts of its own, and the @types/marked-terminal
 * package on npm still targets the older 6.x API shape (a TerminalRenderer
 * class) which doesn't match what markedTerminal() actually returns in 7.x
 * (a MarkedExtension — see node_modules/marked-terminal/index.js's
 * `markedTerminal()`, which returns `{ renderer: {...}, useNewRenderer: true }`
 * for `marked.use(...)`). A minimal local declaration matching the real
 * runtime shape beats depending on mismatched community types.
 */
declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  export function markedTerminal(options?: Record<string, unknown>, highlightOptions?: Record<string, unknown>): MarkedExtension;
}
