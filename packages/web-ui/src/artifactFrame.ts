/**
 * Building the sandboxed document an artifact renders inside.
 *
 * This is the security boundary of the whole artifact feature, so it lives in
 * one pure function with its own tests rather than inline in a component.
 *
 * Two layers, and BOTH are required:
 *
 * 1. **`sandbox="allow-scripts"` with NO `allow-same-origin`.** That exact
 *    pair gives the frame a unique opaque origin: scripts run, but they cannot
 *    reach the parent document, its cookie (which holds the session token), or
 *    its `localStorage`. Adding `allow-same-origin` alongside `allow-scripts`
 *    is the classic mistake — together they let the frame remove its own
 *    sandbox attribute and escape, which is strictly worse than no sandbox at
 *    all because it *looks* protected. Never add it.
 *
 * 2. **A CSP `<meta>` inside the document.** `srcdoc` content cannot carry
 *    response headers, so the policy has to be in the markup. It blocks every
 *    network destination — no CDN scripts, no remote images, no `fetch` back
 *    to the host — which means a generated page cannot exfiltrate whatever it
 *    can see, and cannot quietly call the host's own API.
 *
 * Model output is untrusted input. It may also be *attacker-influenced* input,
 * since a fetched page or an MCP result can steer what the model writes.
 */

/** `script-src 'unsafe-inline'` is deliberate: artifacts are inline scripts by design. */
const CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data:; " +
  "font-src data:; " +
  "connect-src 'none'; " +
  "form-action 'none'; " +
  "base-uri 'none'; " +
  "frame-src 'none'; " +
  "object-src 'none'";

/** The sandbox token list. Exported so a test can assert what is NOT in it. */
export const SANDBOX = 'allow-scripts';

export interface FrameInput {
  kind: string;
  content: string;
  language?: string;
  /** Rendered SVG for a mermaid artifact, when the renderer produced one. */
  mermaidSvg?: string;
}

/** The full `srcdoc` for an artifact. */
export function buildFrameDocument(input: FrameInput): string {
  const body = bodyFor(input);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 16px; background: Canvas; color: CanvasText;
  }
  pre { overflow-x: auto; background: rgba(127,127,127,0.12); padding: 10px; border-radius: 6px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
  img, svg { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid rgba(127,127,127,0.4); padding: 4px 8px; }
</style>
</head>
<body>${body}</body>
</html>`;
}

function bodyFor(input: FrameInput): string {
  switch (input.kind) {
    case 'html':
      // Inserted verbatim — the point of an HTML artifact — which is exactly
      // why the sandbox and CSP above are not optional.
      return input.content;
    case 'svg':
      return input.content;
    case 'mermaid':
      return input.mermaidSvg ?? `<pre><code>${escapeHtml(input.content)}</code></pre>`;
    case 'json':
      return `<pre><code>${escapeHtml(format(input.content))}</code></pre>`;
    case 'code':
    case 'markdown':
    default:
      // Markdown arrives pre-rendered by the parent (already sanitized there);
      // anything else is shown as source rather than guessed at.
      return `<pre><code>${escapeHtml(input.content)}</code></pre>`;
  }
}

function format(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/**
 * Fills a freshly opened tab with one artifact, full-bleed.
 *
 * The point is width: a dashboard or a wide table is unreadable in a 420px
 * panel, and the panel cannot grow past about half the window without taking
 * the conversation with it.
 *
 * The artifact still renders inside a sandboxed frame, with the same
 * `allow-scripts`-and-nothing-else token list and the same CSP. That is not
 * belt-and-braces, it is the whole point: the obvious implementation —
 * `window.open(URL.createObjectURL(new Blob([doc], { type: 'text/html' })))` —
 * is a hole. A `blob:` URL inherits the origin of whoever created it, so the
 * artifact's inline scripts would run **as the app**, with its cookie (which
 * holds the session token) and its `localStorage` in reach. A `data:` URL is
 * refused for top-level navigation by browsers for the same family of reason.
 * So the new tab gets a page of ours, and the artifact stays behind the same
 * boundary it has in the panel.
 */
export function mountStandalone(win: Window, title: string, frameDocument: string): void {
  const doc = win.document;
  doc.title = title;
  doc.documentElement.style.colorScheme = 'light dark';
  doc.body.style.margin = '0';
  const frame = doc.createElement('iframe');
  frame.title = title;
  frame.setAttribute('sandbox', SANDBOX);
  // Assigned as a property, not written into markup: no attribute escaping to
  // get wrong, and nothing to get wrong it in.
  frame.srcdoc = frameDocument;
  frame.style.cssText = 'display:block;border:0;width:100vw;height:100vh';
  doc.body.appendChild(frame);
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
