import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { globalDir } from '@heapcode/core/node';

/**
 * Which vault, when nobody says: `$HEAPNOTES_VAULT`, else the default saved by
 * `heapcode notes vault <folder>` or the app's folder picker, else ~/Heapnotes.
 * One file, so the terminal and the app open the same notes.
 */
export function notesSettingsFile(): string {
  return join(globalDir(), 'notes.json');
}

export interface NotesSettings {
  vault?: string;
  /** Editor text size in px. */
  fontSize?: number;
  /** Tags the in-app assistant can't see. Unset means `private`; empty means none. */
  aiHiddenTags?: string[];
  /** Ask's changes are made without an Apply each time. Off by default. */
  autoApply?: boolean;
}

export const DEFAULT_AI_HIDDEN_TAGS = ['private'];

export function readNotesSettings(): NotesSettings {
  try {
    const raw = JSON.parse(readFileSync(notesSettingsFile(), 'utf8')) as Record<string, unknown>;
    return {
      ...(typeof raw.vault === 'string' && raw.vault ? { vault: raw.vault } : {}),
      ...(typeof raw.fontSize === 'number' ? { fontSize: raw.fontSize } : {}),
      ...(Array.isArray(raw.aiHiddenTags)
        ? { aiHiddenTags: raw.aiHiddenTags.filter((t): t is string => typeof t === 'string') }
        : {}),
      ...(typeof raw.autoApply === 'boolean' ? { autoApply: raw.autoApply } : {}),
    };
  } catch {
    return {};
  }
}

export function writeNotesSettings(patch: NotesSettings): NotesSettings {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(readFileSync(notesSettingsFile(), 'utf8')) as Record<string, unknown>;
  } catch {
    current = {};
  }
  const next = { ...current, ...patch };
  mkdirSync(dirname(notesSettingsFile()), { recursive: true });
  writeFileSync(notesSettingsFile(), `${JSON.stringify(next, null, 2)}\n`);
  return readNotesSettings();
}

export function defaultVaultRoot(): string {
  return resolve(
    process.env.HEAPNOTES_VAULT || readNotesSettings().vault || join(homedir(), 'Heapnotes'),
  );
}
