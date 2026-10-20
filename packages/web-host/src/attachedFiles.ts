/**
 * Documents attached to a message, carried inside the message's own text.
 *
 * A file attached in the composer is read to text by the host when it is
 * attached (`readAttachedFile`), and travels with the message as a block
 * after what the person typed:
 *
 *     What does clause 4 mean?
 *
 *     <attached-file name="lease.pdf">
 *     …the document's text…
 *     </attached-file>
 *
 * In the text rather than beside it on purpose. The model reads the same
 * string the conversation stores, so a follow-up turn ("and clause 7?") still
 * has the document in its history; nothing new has to be persisted, replayed
 * or sent to the daemon; and editing a sent message brings its files back
 * with it. Pages split the blocks out again to show file chips instead of the
 * text — see `splitAttachedFiles`.
 *
 * Browser-safe: no Node imports, because the pages use it too.
 */

export interface AttachedFile {
  name: string;
  text: string;
}

const OPEN = (name: string): string => `<attached-file name="${escapeName(name)}">`;
const CLOSE = '</attached-file>';
const BLOCK = /\n*<attached-file name="([^"]*)">\n([\s\S]*?)\n<\/attached-file>/g;

/** The message as sent: what was typed, then one block per file. */
export function withAttachedFiles(text: string, files: readonly AttachedFile[]): string {
  if (files.length === 0) return text;
  const blocks = files.map((f) => `${OPEN(f.name)}\n${escapeBody(f.text)}\n${CLOSE}`);
  return [text.trim(), ...blocks].filter(Boolean).join('\n\n');
}

/** A message back into what was typed and the files that came with it. */
export function splitAttachedFiles(message: string): { text: string; files: AttachedFile[] } {
  if (!message.includes('<attached-file ')) return { text: message, files: [] };
  const files: AttachedFile[] = [];
  const text = message
    .replace(BLOCK, (_m, name: string, body: string) => {
      files.push({ name: unescapeName(name), text: unescapeBody(body) });
      return '';
    })
    .trim();
  return { text, files };
}

/**
 * A conversation's title from its first message: what was typed, or — for a
 * message that was only a file — the file's name, never the start of a block.
 */
export function titleFromMessage(message: string): string {
  const { text, files } = splitAttachedFiles(message);
  return (text || files.map((f) => f.name).join(', ')).slice(0, 60);
}

// A document that itself contains the closing tag must not end its block early.
const escapeBody = (s: string): string => s.replaceAll(CLOSE, '<\\/attached-file>');
const unescapeBody = (s: string): string => s.replaceAll('<\\/attached-file>', CLOSE);
const escapeName = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('\n', ' ');
const unescapeName = (s: string): string => s.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
