/**
 * The pure text helpers the agent's web surface needs, kept apart from
 * `workspaceTools` so a browser bundle can have them without the
 * `node:child_process` that module drags in. `webSearch` — which a non-Node
 * host (heapbrowse) also imports — is the reason this file exists: it used to
 * reach these through `workspaceTools`, which was the whole reason the
 * browser-safe barrel excluded it.
 *
 * Everything here is string-in string-out with no imports at all.
 */

export const MAX_FETCH_CHARS = 20_000;

/**
 * Decode the HTML entities that show up in page text and search snippets.
 * Hex escapes matter as much as decimal ones: DuckDuckGo emits `&#x27;` for
 * an apostrophe, so a decoder that only handled `&#39;` left "Rust&#x27;s"
 * in front of the model.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => safeCodePoint(Number(n)))
    // Ampersand last, so "&amp;lt;" decodes to "&lt;" rather than to "<".
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** Crude but dependency-free HTML → text: drop script/style, strip tags, decode entities. */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n');
}