import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false });
  const clean = DOMPurify.sanitize(html);
  // Wrap code blocks with an action bar. Applied AFTER sanitization — this
  // wrapper is our own trusted markup, the inner content is already clean.
  return clean
    .replace(
      /<pre(\s[^>]*)?>/g,
      '<div class="codeblock"><div class="codeblock-actions">' +
        '<button data-action="copy">Copy</button>' +
        '<button data-action="insert">Insert</button>' +
        '<button data-action="apply">Apply</button>' +
        '</div><pre$1>',
    )
    .replace(/<\/pre>/g, '</pre></div>');
}
