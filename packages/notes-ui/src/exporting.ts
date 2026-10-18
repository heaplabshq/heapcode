import { renderMarkdown } from '@heapcode/web-ui/markdown';
import { renderMermaid } from '@heapcode/web-ui/mermaid';
import { imageSrc } from './editor/live.js';
import { widthOf } from './editor/images.js';

/**
 * Getting notes out. Markdown and .zip come from the host — the files as they
 * are on disk, images and all. HTML and PDF are made here, from the same
 * renderer the app uses, with the images folded into the page so the one
 * file stands alone.
 */

export function download(filename: string, data: Blob): void {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function base64Blob(base64: string, type: string): Blob {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** `![[photo.png|300]]` as plain Markdown, which the renderer turns into an <img>. */
function embedsAsImages(markdown: string, attachmentBase: string): string {
  return markdown.replace(
    /!\[\[([^\]|#]+\.(?:png|jpe?g|gif|webp|svg|avif))(\|[^\]]*)?\]\]/gi,
    (_m, name: string, size?: string) =>
      `![${size ?? ''}](${attachmentBase}${encodeURIComponent(name.trim())})`,
  );
}

async function asDataUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => resolve(undefined);
      r.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

const PAGE_CSS = `
  body { font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1f2328; max-width: 720px; margin: 40px auto; padding: 0 24px; }
  h1, h2, h3, h4 { line-height: 1.3; }
  img { max-width: 100%; border-radius: 6px; }
  pre { background: #f6f8fa; padding: 12px 14px; border-radius: 6px; overflow-x: auto; font-size: 0.88em; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  :not(pre) > code { background: #f6f8fa; padding: 0 4px; border-radius: 4px; font-size: 0.9em; }
  blockquote { margin: 0; padding-left: 14px; border-left: 3px solid #d0d7de; color: #59636e; }
  table { border-collapse: collapse; } th, td { border: 1px solid #d0d7de; padding: 5px 10px; }
  .wikilink { color: #0969da; }
  .mermaid { text-align: center; margin: 1em 0; } .mermaid svg { max-width: 100%; height: auto; }
  @media print { body { margin: 0; } a { color: inherit; } }
`;

/** One note as a page of its own: rendered, its images inside it. */
export async function noteHtml(
  title: string,
  markdown: string,
  ctx: { dir: string; attachmentBase: string },
): Promise<string> {
  const body = renderMarkdown(embedsAsImages(markdown, ctx.attachmentBase), {
    highlight: false,
    wikiLinks: true,
  });
  const doc = new DOMParser().parseFromString(`<div>${body}</div>`, 'text/html');
  for (const img of [...doc.querySelectorAll('img')]) {
    const raw = img.getAttribute('src') ?? '';
    const src = raw.startsWith(ctx.attachmentBase) ? raw : imageSrc(raw, ctx);
    const data = src ? await asDataUrl(src) : undefined;
    if (data) img.setAttribute('src', data);
    // `![alt|300](…)`: the size it has in the note, and the alt without the number.
    const width = widthOf(`![${img.getAttribute('alt') ?? ''}]()`);
    if (width) img.setAttribute('width', String(width));
    img.setAttribute('alt', (img.getAttribute('alt') ?? '').replace(/\|\s*\d+(x\d+)?\s*$/, ''));
  }
  // Diagrams as drawings; one with a mistake stays as its code.
  for (const code of [...doc.querySelectorAll('pre > code.language-mermaid')]) {
    try {
      const figure = doc.createElement('div');
      figure.className = 'mermaid';
      figure.innerHTML = await renderMermaid(code.textContent ?? '', 'default');
      code.parentElement!.replaceWith(figure);
    } catch {
      // Left as code.
    }
  }
  // A [[link]] goes nowhere outside the app: keep its words, drop the link.
  for (const a of [...doc.querySelectorAll('a[data-wikilink]')]) {
    const span = doc.createElement('span');
    span.className = 'wikilink';
    span.textContent = a.textContent;
    a.replaceWith(span);
  }
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || 'Untitled')}</title><style>${PAGE_CSS}</style></head>
<body>${doc.body.firstElementChild?.innerHTML ?? ''}</body></html>`;
}

/** The system's print dialog on the note — where "Save as PDF" lives on every platform. */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.srcdoc = html;
  frame.onload = () => {
    const win = frame.contentWindow;
    if (!win) return frame.remove();
    win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 0));
    win.focus();
    win.print();
    // Some engines never fire afterprint; don't leave the frame behind for long.
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}
