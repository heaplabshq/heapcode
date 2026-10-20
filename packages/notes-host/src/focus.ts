import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { projectStateDir } from '@heapcode/core/node';

/**
 * `open_note`: an agent, in the MCP server's process, asks whichever
 * Heapnotes app has this vault open to show a note. The two processes share
 * nothing but the vault's state folder, so the request is a small file there:
 * the app watches it, opens the note, and writes back that it did — which is
 * how the tool can say "shown" rather than hoping.
 */
interface FocusFile {
  id: string;
  nonce: string;
  requestedAt: number;
  /** The nonce of the request an app has shown. */
  shown?: string;
}

/** How long a request stays worth acting on: an app opened later shouldn't jump to it. */
export const FOCUS_TTL_MS = 10_000;

export function focusFile(vaultRoot: string): string {
  return join(projectStateDir(vaultRoot), 'notes-focus.json');
}

function read(file: string): FocusFile | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as FocusFile;
  } catch {
    return undefined;
  }
}

function write(file: string, data: FocusFile): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

/** Ask for a note to be shown; resolves true once an app says it did, false after `waitMs`. */
export async function requestFocus(vaultRoot: string, id: string, waitMs = 1500): Promise<boolean> {
  const file = focusFile(vaultRoot);
  const nonce = randomUUID();
  write(file, { id, nonce, requestedAt: Date.now() });
  for (const end = Date.now() + waitMs; Date.now() < end;) {
    await new Promise((r) => setTimeout(r, 100));
    if (read(file)?.shown === nonce) return true;
  }
  return false;
}

/**
 * The app's side: a pending, fresh request, if there is one. `markShown`
 * answers it; the caller does that only once a page has actually been told.
 */
export function pendingFocus(
  vaultRoot: string,
  now = Date.now(),
): { id: string; markShown(): void } | undefined {
  const file = focusFile(vaultRoot);
  const req = read(file);
  if (!req || req.shown === req.nonce || now - req.requestedAt > FOCUS_TTL_MS) return undefined;
  return { id: req.id, markShown: () => write(file, { ...req, shown: req.nonce }) };
}
