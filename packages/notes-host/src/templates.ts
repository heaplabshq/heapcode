/**
 * Templates are ordinary notes tagged #template (or #template/meeting…), the
 * way tags already sort everything else — no folder to set up, and a
 * template stays a note you can find and edit. A new note from one gets its
 * text with the tag taken out and these filled in:
 *
 *   {{date}} 2026-10-19   {{time}} 14:05   {{weekday}} Monday
 */
export const TEMPLATE_TAG = 'template';

const TAG = /(^|[\s(])#template(?:\/[^\s#]+)?(?=$|[\s),.;:!?])/gi;

export function fillTemplate(body: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const values: Record<string, string> = {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
  };
  const lines = body.split('\n').map((line) => {
    if (!TAG.test(line)) return line;
    TAG.lastIndex = 0;
    // Close the gap the tag leaves, without touching indentation it didn't make.
    let cleaned = line
      .replace(TAG, '$1')
      .replace(/(\S)[ \t]{2,}(?=\S)/g, '$1 ')
      .replace(/[ \t]+$/, '');
    if (!/^\s/.test(line)) cleaned = cleaned.trimStart();
    // A line that held only the tag goes altogether.
    return cleaned.trim() === '' ? null : cleaned;
  });
  TAG.lastIndex = 0;
  return lines
    .filter((l): l is string => l !== null)
    .join('\n')
    .replace(/\{\{\s*(date|time|weekday)\s*\}\}/gi, (_m, k: string) => values[k.toLowerCase()]!);
}
