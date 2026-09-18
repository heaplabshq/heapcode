import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Images sent with a turn, kept beside the conversation rather than in it.
 *
 * They used to be noted and discarded — `_(1 image attached)_` in place of the
 * screenshot — for a good reason: a screenshot is a couple of megabytes of
 * base64, `conversations.json` is read whole on every load, and now re-read on
 * every save. Putting the bytes in there would make every conversation list
 * pay for every screenshot anyone ever pasted.
 *
 * The answer is not to discard them but to move them out: the message holds an
 * id, the bytes live in one file each, and nothing reads a file it is not
 * about to show. Content-addressed, so pasting the same screenshot into ten
 * turns costs one copy.
 */

/** Extensions, keyed by the media types `acceptImages` already allows. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * How much of this project's attachments to keep.
 *
 * A cap rather than reference counting: an id is reachable from any
 * conversation, conversations are themselves capped and rotate, and walking
 * every conversation to decide whether one JPEG is still referenced would cost
 * more than the JPEG. Oldest first, which is also least-recently-sent.
 */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** `att_<hash>.<ext>` — an id that cannot escape the directory it names. */
const ID_PATTERN = /^att_[0-9a-f]{32}\.(png|jpg|gif|webp)$/;

export class AttachmentStore {
  constructor(private readonly dir: string) {}

  /**
   * Store one `data:` URL and return its id.
   *
   * Undefined for anything that is not one of the accepted image types — the
   * caller has already filtered through `acceptImages`, so this is the second
   * of two checks rather than the only one.
   */
  async put(dataUrl: string): Promise<string | undefined> {
    const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    const ext = match && EXTENSIONS[match[1]!];
    if (!match || !ext) return undefined;

    const bytes = Buffer.from(match[2]!, 'base64');
    const id = `att_${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
    const path = join(this.dir, id);
    // Content-addressed: identical bytes are the same file, so a re-paste is a
    // no-op rather than a second copy.
    if (await exists(path)) return id;
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, bytes);
    void this.prune().catch(() => undefined);
    return id;
  }

  /** The bytes and media type for an id, or undefined if it is gone. */
  async read(id: string): Promise<{ bytes: Buffer; mediaType: string } | undefined> {
    // Validated rather than joined blindly: this id arrives from a URL, and
    // `../` in it would otherwise read anything the process can.
    if (!ID_PATTERN.test(id)) return undefined;
    try {
      const bytes = await readFile(join(this.dir, id));
      return { bytes, mediaType: MEDIA_TYPES[id.split('.').pop()!] ?? 'application/octet-stream' };
    } catch {
      // Pruned, or never written. A missing attachment is a missing image, not
      // a broken conversation.
      return undefined;
    }
  }

  /** Store several, dropping any that could not be stored. */
  async putAll(dataUrls: readonly string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const url of dataUrls) {
      const id = await this.put(url);
      if (id) ids.push(id);
    }
    return ids;
  }

  /** Drop the oldest files once the directory is over its cap. */
  private async prune(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    const stats = await Promise.all(
      entries.map(async (name) => {
        try {
          const s = await stat(join(this.dir, name));
          return { name, size: s.size, at: s.mtimeMs };
        } catch {
          return undefined;
        }
      }),
    );
    const files = stats.filter((f): f is { name: string; size: number; at: number } => f !== undefined);
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= MAX_TOTAL_BYTES) return;

    for (const file of files.sort((a, b) => a.at - b.at)) {
      if (total <= MAX_TOTAL_BYTES) break;
      await rm(join(this.dir, file.name), { force: true }).catch(() => undefined);
      total -= file.size;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
