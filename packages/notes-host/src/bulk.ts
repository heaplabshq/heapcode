import { posix } from 'node:path';
import { NoteError } from './errors.js';
import type { NoteSummary, Vault } from './vault.js';

/**
 * Several notes at once — what Bear does with a ⌘/⇧-click selection.
 *
 * Each note is its own write, so one that can't change (gone, read-only,
 * hidden) is reported and the rest still happen; nothing is half-done
 * within a note.
 */
export type BulkAction =
  'pin' | 'unpin' | 'archive' | 'restore' | 'trash' | 'delete' | 'addTag' | 'removeTag';

export const BULK_ACTIONS: readonly BulkAction[] = [
  'pin',
  'unpin',
  'archive',
  'restore',
  'trash',
  'delete',
  'addTag',
  'removeTag',
];

export interface BulkResult {
  done: number;
  failed: { id: string; reason: string }[];
}

export async function bulkAction(
  vault: Vault,
  ids: string[],
  action: BulkAction,
  tag?: string,
): Promise<BulkResult> {
  if (!BULK_ACTIONS.includes(action))
    throw new NoteError('invalid_argument', `No bulk action “${action}”.`);
  if ((action === 'addTag' || action === 'removeTag') && !tag?.trim())
    throw new NoteError('invalid_argument', 'Give the tag.');
  const result: BulkResult = { done: 0, failed: [] };
  for (const id of new Set(ids)) {
    const ref = { id };
    try {
      switch (action) {
        case 'pin':
        case 'unpin':
          await vault.pin(ref, action === 'pin');
          break;
        case 'archive':
          await vault.archive(ref);
          break;
        case 'restore':
          await vault.restore(ref);
          break;
        case 'trash':
          await vault.trash(ref);
          break;
        case 'delete':
          await vault.deletePermanently(ref);
          break;
        case 'addTag':
          await vault.addTag(ref, tag!);
          break;
        case 'removeTag':
          await vault.removeTag(ref, tag!);
          break;
      }
      result.done++;
    } catch (err) {
      result.failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** A local link's target, from a note in `fromDir` as seen from a note in `toDir`. */
function relink(markdown: string, fromDir: string, toDir: string): string {
  if (fromDir === toDir) return markdown;
  return markdown.replace(
    /(!?\[[^\]]*\]\()(<[^>]+>|[^)\s]+)/g,
    (whole, open: string, raw: string) => {
      const target = raw.replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/'))
        return whole;
      let decoded = target;
      try {
        decoded = decodeURI(target);
      } catch {
        // Literal.
      }
      const moved = posix.relative(toDir || '.', posix.join(fromDir || '.', decoded)) || '.';
      return `${open}${encodeURI(moved)}`;
    },
  );
}

/**
 * Merge notes into one, in the order given — Bear's "Merge notes". The first
 * note's title stays the title; each later note keeps its own as a `##`
 * heading, so nothing is lost and the joins are easy to see. Links to files
 * are re-pointed for the merged note's folder. The originals go to the
 * trash (restorable), not away.
 */
export async function mergeNotes(vault: Vault, ids: string[]): Promise<NoteSummary> {
  const order = [...new Set(ids)];
  if (order.length < 2) throw new NoteError('invalid_argument', 'Pick two or more notes to merge.');
  const notes = await Promise.all(
    order.map(async (id) => {
      const [meta, read] = await Promise.all([vault.get({ id }), vault.read({ id })]);
      if (meta.location === 'trash')
        throw new NoteError('invalid_argument', `“${meta.title || 'Untitled'}” is in the trash.`);
      return { meta, body: read.content };
    }),
  );
  const dirOf = (path: string) => {
    const d = posix.dirname(path);
    return d === '.' ? '' : d;
  };
  const home = dirOf(notes[0]!.meta.path);
  const parts = notes.map(({ meta, body }, i) => {
    let text = relink(body.replace(/\s+$/, ''), dirOf(meta.path), home);
    // A later note's title becomes a section heading in the merged one.
    if (i > 0) text = text.replace(/^# (?=\S)/, '## ');
    return text;
  });
  // The originals go first, so the merged note can take the first one's file
  // name rather than "Alpha 2"; if the merge can't be written they come back.
  for (const { meta } of notes) await vault.trash({ id: meta.id });
  try {
    return await vault.createRaw(`${parts.join('\n\n')}\n`, home ? { folder: home } : {});
  } catch (err) {
    for (const { meta } of notes) await vault.restore({ id: meta.id }).catch(() => undefined);
    throw err;
  }
}
