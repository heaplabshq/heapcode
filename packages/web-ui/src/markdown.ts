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
const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      try {
        return language ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
      } catch {
        return code;
      }
    },
  }),
);

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(source: string): string {
  const html = marked.parse(source ?? '', { async: false });
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
