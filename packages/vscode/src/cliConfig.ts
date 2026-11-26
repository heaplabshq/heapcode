import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DPAPI_FILE, globalDir, readDpapiSecretsSync, readKeychainSecretsSync } from '@heapcode/core/node';
import type { ModelRoleTable, ProviderConnection } from '@heapcode/core';

/**
 * The connections the CLI and `heapcode web` share, read from
 * `~/.heapcode/config.json`.
 *
 * Read, never written. The extension's own connections stay in VS Code
 * settings and its keys stay in SecretStorage — the OS keychain is a better
 * place for a key than a file, and moving them there would be a downgrade. So
 * this is additive: a machine that has never had the CLI installed has no such
 * file, gets `undefined` from everything here, and behaves exactly as before.
 *
 * The point is only that configuring a provider in a terminal should not mean
 * configuring it again in the editor.
 */

export interface SharedCliConfig {
  connections: ProviderConnection[];
  roles: ModelRoleTable;
}

interface Cached<T> {
  /** mtime the value was read at, so an edit in a terminal is picked up. */
  stamp?: number;
  value?: T;
}

const config: Cached<SharedCliConfig> = {};
const secrets: Cached<Record<string, string>> = {};

function configPath(): string {
  return join(globalDir(), 'config.json');
}

function secretsPath(): string {
  return join(globalDir(), 'secrets.json');
}

/**
 * Re-read only when the file has changed.
 *
 * `getModelConfig` is synchronous and called often — the status bar, every
 * run — so this cannot be an async load, and re-parsing on every call would be
 * wasteful. A stat is cheap, and comparing mtime means editing config.json in
 * a terminal shows up in an open editor without reloading the window.
 */
function readCached<T>(path: string, slot: Cached<T>, parse: (text: string) => T | undefined): T | undefined {
  let stamp: number;
  try {
    stamp = statSync(path).mtimeMs;
  } catch {
    // No file: no CLI installed, or nothing configured yet. Not an error.
    slot.stamp = undefined;
    slot.value = undefined;
    return undefined;
  }
  if (slot.stamp === stamp) return slot.value;
  try {
    slot.value = parse(readFileSync(path, 'utf8'));
  } catch {
    // Unreadable or malformed: behave as though it is not there rather than
    // taking the editor down with someone else's broken file.
    slot.value = undefined;
  }
  slot.stamp = stamp;
  return slot.value;
}

/** Connections and roles from the CLI's config, or undefined if there are none. */
export function readCliConfig(): SharedCliConfig | undefined {
  return readCached(configPath(), config, (text) => {
    const parsed = JSON.parse(text) as Partial<SharedCliConfig>;
    const connections = Array.isArray(parsed.connections) ? parsed.connections.filter((c) => c?.name) : [];
    if (connections.length === 0) return undefined;
    return { connections, roles: parsed.roles ?? {} };
  });
}

/**
 * The key the CLI holds for one connection.
 *
 * Only consulted for a connection that came from the CLI's config — a
 * connection defined in VS Code settings keeps using SecretStorage. This reads
 * a file the same user already owns and any process they run could read, so it
 * moves no key anywhere it was not: it is what makes a shared connection
 * actually usable rather than a name that fails on first use.
 */
export function readCliApiKey(connectionName: string): string | undefined {
  const all =
    readCached(secretsPath(), secrets, (text) => JSON.parse(text) as Record<string, string>) ?? readOsStoreSecrets();
  return all?.[`apiKey.${connectionName}`] || undefined;
}

/** How long a keychain read is reused; a key added in a terminal shows up within this. */
const KEYCHAIN_TTL_MS = 30_000;
const osStore: { at?: number; stamp?: number; value?: Record<string, string> } = {};

/**
 * Where the CLI keeps its keys once secrets.json is gone: the macOS login
 * keychain, or a DPAPI-encrypted secrets.dpapi on Windows (host's
 * SecretsStore; the format is shared through core/node/secretStorage.ts).
 * Synchronous because every caller here is.
 *
 * macOS reads through the same `security` tool that wrote the item, so its
 * access list already trusts the reader and no prompt appears; at most one
 * short-lived process per 30 s. Windows decrypts only when the file has
 * changed, since starting PowerShell costs a few hundred milliseconds.
 *
 * Only for the real ~/.heapcode — the CLI never uses an OS store under a
 * HEAPCODE_HOME override, so neither does this.
 */
function readOsStoreSecrets(): Record<string, string> | undefined {
  if (process.env.HEAPCODE_HOME) return undefined;
  if (process.platform === 'darwin') {
    if (osStore.at !== undefined && Date.now() - osStore.at < KEYCHAIN_TTL_MS) return osStore.value;
    osStore.at = Date.now();
    // No item (the CLI hasn't moved its keys, or isn't installed), a locked
    // keychain: same as having no CLI keys at all.
    osStore.value = readKeychainSecretsSync();
    return osStore.value;
  }
  if (process.platform === 'win32') {
    const file = join(globalDir(), DPAPI_FILE);
    let stamp: number;
    try {
      stamp = statSync(file).mtimeMs;
    } catch {
      osStore.stamp = undefined;
      osStore.value = undefined;
      return undefined;
    }
    if (osStore.stamp !== stamp) {
      osStore.stamp = stamp;
      osStore.value = readDpapiSecretsSync(file);
    }
    return osStore.value;
  }
  return undefined;
}

/** Test seam: drop what has been cached so a fresh read happens. */
export function __resetCliConfigCache(): void {
  config.stamp = undefined;
  config.value = undefined;
  secrets.stamp = undefined;
  secrets.value = undefined;
  osStore.at = undefined;
  osStore.stamp = undefined;
  osStore.value = undefined;
}
