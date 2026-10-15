import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';

/**
 * Model output → HTML, sanitized.
 *
 * The sanitize step is not optional and not defense-in-depth: model output is
 * untrusted text that routinely contains HTML, and anything it emits would
 * otherwise execute with the page's privileges — the same page holding the
 * WebSocket that runs shell commands. Injected content from a fetched page or
 * an MCP result can reach here too, so treat every byte as hostile.
 */
/**
 * Guessing a block's language means trying every grammar in the bundle: ~36ms
 * for an 11KB block, against ~4ms when the language is named. Fine once, ruinous
 * on every chunk of a streaming reply — so only small unlabelled blocks are
 * guessed, and nothing is highlighted while a reply is still streaming.
 */
const AUTO_DETECT_MAX = 2_000;

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      try {
        if (language) return hljs.highlight(code, { language }).value;
        return code.length <= AUTO_DETECT_MAX ? hljs.highlightAuto(code).value : escapeHtml(code);
      } catch {
        return escapeHtml(code);
      }
    },
  }),
);
marked.setOptions({ gfm: true, breaks: false });

/** The same markdown, no highlighting: for text still streaming in, re-rendered on every chunk. */
const plain = new Marked();
plain.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(source: string, options: { highlight?: boolean } = {}): string {
  const html = (options.highlight === false ? plain : marked).parse(source ?? '', { async: false });
  return DOMPurify.sanitize(html, {
    // No <form>, no <iframe>, no event handlers. Artifact rendering (W7) is
    // where sandboxed HTML belongs — it gets its own iframe and CSP, and must
    // never be achieved by loosening this.
    FORBID_TAGS: ['form', 'iframe', 'object', 'embed', 'style', 'script'],
    FORBID_ATTR: ['style', 'srcdoc', 'formaction'],
    ADD_ATTR: ['target', 'rel'],
  });
}

/** Escape for the places we build HTML by hand (tool output, args). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
