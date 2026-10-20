/**
 * Mermaid diagrams to SVG, for any page in the app — Heapnotes' code blocks
 * and exports. Loaded on first use: it is the heaviest thing the UI can pull
 * in, and most pages never draw a diagram.
 *
 * `securityLevel: 'strict'` is what makes the SVG safe to put in the page:
 * Mermaid escapes labels and drops click handlers and scripts itself.
 */
type Mermaid = (typeof import('mermaid'))['default'];

let loading: Promise<Mermaid> | undefined;
let theme: 'dark' | 'default' | undefined;
/** Renders one at a time: Mermaid keeps global state while it lays out. */
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

/** Dark when the app is — the same rule styles.css follows. */
export function mermaidTheme(): 'dark' | 'default' {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'dark') return 'dark';
  if (set === 'light') return 'default';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'default';
}

async function load(want: 'dark' | 'default'): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => m.default);
  const mermaid = await loading;
  if (want !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: want });
    theme = want;
  }
  return mermaid;
}

/**
 * The diagram as SVG markup; throws Mermaid's own message when the source has
 * a mistake. In the app's theme unless told — an export's white page wants light.
 */
export function renderMermaid(source: string, look?: 'dark' | 'default'): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await load(look ?? mermaidTheme());
    const id = `mermaid-${Date.now().toString(36)}-${seq++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return svg;
    } finally {
      // A failed render can leave its scratch element behind.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
