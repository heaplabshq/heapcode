import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  PermissionEngine as CorePermissionEngine,
  type PermissionGrantStore,
  type PermissionMode,
  type PermissionRequester,
} from '@heapcode/core';

export type { PermissionRequester };

/**
 * The shared permission engine (@heapcode/core) with persisted "Always"
 * grants in a project-scoped JSON file — the extension keeps its own in
 * vscode.Memento's workspaceState, which is the same scope.
 *
 * The terminal has one place to ask, so no fallback requester is passed:
 * with no prompt attached, a request fails closed.
 */
export class PermissionEngine extends CorePermissionEngine {
  constructor(
    grantsFile: string,
    safeMode: () => boolean = () => false,
    log: (message: string) => void = () => {},
    track?: (name: string, meta?: Record<string, unknown>) => void,
    mode?: () => PermissionMode,
  ) {
    super({ grants: jsonGrantStore(grantsFile), safeMode, log, track, mode, resetHint: '/permissions reset' });
  }
}

/** The saved grant keys for a project, for "/permissions" to display. */
export async function listPermissionGrants(file: string): Promise<string[]> {
  try {
    const grants = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>;
    return Object.keys(grants).sort();
  } catch {
    return [];
  }
}

function jsonGrantStore(file: string): PermissionGrantStore {
  let grants: Record<string, 'always'> | undefined;

  const load = async (): Promise<Record<string, 'always'>> => {
    if (!grants) {
      try {
        grants = JSON.parse(await readFile(file, 'utf8')) as Record<string, 'always'>;
      } catch {
        grants = {};
      }
    }
    return grants;
  };
  const persist = async (): Promise<void> => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(grants ?? {}, null, 2), 'utf8');
  };

  return {
    has: async (key) => (await load())[key] === 'always',
    add: async (key) => {
      (await load())[key] = 'always';
      await persist();
    },
    clear: async () => {
      const cleared = Object.keys(await load()).length;
      grants = {};
      await persist();
      return cleared;
    },
  };
}
