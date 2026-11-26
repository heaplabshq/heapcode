import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { McpAuthRecord, McpAuthStore } from '@heapcode/core';
import {
  decodeSecretsMap,
  DPAPI_FILE,
  dpapiPowerShellArgs,
  encodeSecretsMap,
  formatDpapiFile,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_CHUNKED,
  KEYCHAIN_ITEM_NOT_FOUND,
  KEYCHAIN_SERVICE,
  parseDpapiFile,
  SECURITY_TOOL,
  windowsPowerShell,
} from '@heapcode/core/node';
import { secretsFile } from '../paths.js';

/**
 * Somewhere safer than a plain file to keep the secrets map.
 *
 * The whole map is one opaque string (base64 JSON; the format lives in
 * core/node/secretStorage.ts, shared with the VS Code extension), so a
 * backend stores a single value: one read per process, one write per change,
 * and nothing platform-specific about what the secrets are.
 */
export interface SecretBackend {
  /** Shown to the user as where their keys live. */
  readonly label: string;
  /** The stored value, or undefined when there is none yet. Throws when the store can't be used. */
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
}

const COMMAND_TIMEOUT_MS = 10_000;
/**
 * `security -i` reads commands a line at a time from a fixed-size buffer
 * (about 4 KB; a longer line is split into garbage commands), and the value
 * travels hex-encoded, at twice its length. Values longer than this are
 * stored across several items. Measured: 2,000 bytes went through intact,
 * 4,000 did not.
 */
const CHUNK = 1_500;

/**
 * The macOS login keychain, through the system's own `security` tool — no
 * native module (guardrail #5), so nothing to rebuild per Node version.
 *
 * The value never appears on a command line, where any process could read
 * it: writes go through `security -i` on stdin, hex-encoded so no quoting
 * can break the command. Items created by `security` list it as a trusted
 * app, so reading them back raises no keychain prompt.
 *
 * Errors never include `security`'s own output: on a failed command it
 * echoes the command back, value and all.
 */
export class MacKeychain implements SecretBackend {
  readonly label = `macOS Keychain (service "${KEYCHAIN_SERVICE}")`;

  constructor(
    private readonly service = KEYCHAIN_SERVICE,
    private readonly account = KEYCHAIN_ACCOUNT,
  ) {}

  private find(account: string): Promise<string | undefined> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        SECURITY_TOOL,
        ['find-generic-password', '-s', this.service, '-a', account, '-w'],
        { timeout: COMMAND_TIMEOUT_MS },
        (err, stdout) => {
          if (!err) return resolvePromise(stdout.replace(/\n$/, ''));
          if ((err as { code?: unknown }).code === KEYCHAIN_ITEM_NOT_FOUND) return resolvePromise(undefined);
          const reason = (err as { killed?: boolean }).killed ? 'timed out' : `exit ${String((err as { code?: unknown }).code)}`;
          reject(new Error(`Keychain read failed (${reason}); the keychain may be locked.`));
        },
      );
    });
  }

  async read(): Promise<string | undefined> {
    const main = await this.find(this.account);
    if (main === undefined || !main.startsWith(KEYCHAIN_CHUNKED)) return main;
    const count = Number(main.slice(KEYCHAIN_CHUNKED.length));
    const parts: string[] = [];
    for (let i = 1; i <= count; i++) {
      const part = await this.find(`${this.account}.${i}`);
      if (part === undefined) throw new Error(`Keychain item is incomplete (part ${i} of ${count} missing).`);
      parts.push(part);
    }
    return parts.join('');
  }

  async write(value: string): Promise<void> {
    // How many parts the current value uses, so the ones a shorter value no
    // longer needs can be deleted. Unreadable counts as none: a part left
    // behind is unreferenced, never read, and overwritten by the next long
    // value.
    const previous = await this.find(this.account).catch(() => undefined);
    const previousParts = previous?.startsWith(KEYCHAIN_CHUNKED) ? Number(previous.slice(KEYCHAIN_CHUNKED.length)) || 0 : 0;
    const add = (account: string, data: string) =>
      `add-generic-password -U -s ${this.service} -a ${account} -X ${Buffer.from(data, 'utf8').toString('hex')}\n`;
    const lines: string[] = [];
    let count = 0;
    if (value.length <= CHUNK) {
      lines.push(add(this.account, value));
    } else {
      for (let i = 0; i < value.length; i += CHUNK) lines.push(add(`${this.account}.${++count}`, value.slice(i, i + CHUNK)));
      // Last, so a reader never sees a marker pointing at parts not yet written.
      lines.push(add(this.account, `${KEYCHAIN_CHUNKED}${count}`));
    }
    // Parts the previous, longer value used and this one doesn't. Written
    // after the main item, so a reader never sees it point at a deleted part.
    for (let i = count + 1; i <= previousParts; i++) {
      lines.push(`delete-generic-password -s ${this.service} -a ${this.account}.${i}\n`);
    }
    return new Promise((resolvePromise, reject) => {
      const child = spawn(SECURITY_TOOL, ['-i'], { stdio: ['pipe', 'ignore', 'ignore'], timeout: COMMAND_TIMEOUT_MS });
      child.on('error', () => reject(new Error(`Keychain write failed: could not run ${SECURITY_TOOL}.`)));
      // Interactive mode exits with the status of its last command, which is
      // can be a cleanup delete of a part that is already gone (44). Whether
      // the value landed is decided by the store reading it back, not here.
      child.on('close', (code) =>
        code === 0 || code === KEYCHAIN_ITEM_NOT_FOUND
          ? resolvePromise()
          : reject(new Error(`Keychain write failed (exit ${String(code)}).`)),
      );
      child.stdin.end(lines.join(''));
    });
  }
}

/** One DPAPI call: base64 in, base64 out. A seam so the plumbing is testable off Windows. */
export type DpapiRunner = (op: 'Protect' | 'Unprotect', inputBase64: string) => Promise<string>;

/**
 * DPAPI through Windows PowerShell 5.1 — built into every Windows 10/11, so
 * no native module (guardrail #5). The script is fixed; data goes in on
 * stdin and out on stdout, never on a command line. A failure reports
 * PowerShell's exception message, which names the error (a corrupt blob, a
 * profile whose keys changed) and never contains the data.
 */
export const powershellDpapi: DpapiRunner = (op, inputBase64) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(windowsPowerShell(), dpapiPowerShellArgs(op), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 15_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', () => reject(new Error('Could not run Windows PowerShell for DPAPI.')));
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) return resolvePromise(stdout.trim());
      const reason = stderr.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) ?? `exit ${String(code)}`;
      reject(new Error(`DPAPI ${op.toLowerCase()} failed: ${reason}`));
    });
    child.stdin.end(inputBase64);
  });

/**
 * Windows: the secrets map encrypted with DPAPI (CurrentUser scope) in
 * ~/.heapcode/secrets.dpapi. Windows has no built-in command that hands a
 * stored password back, which rules out Credential Manager without a native
 * module or a slow compiled helper (and its 2.5 KB-per-entry limit); DPAPI is
 * the same per-user encryption Credential Manager itself uses.
 *
 * What it protects: the file is useless to other Windows accounts, on
 * another machine, or in a backup or a copied home folder. What it does not:
 * any program running as this user can decrypt it, as it could read
 * Credential Manager — Windows has no per-app prompt like the macOS keychain.
 */
export class WindowsDpapi implements SecretBackend {
  readonly label: string;

  constructor(
    private readonly file: string,
    private readonly run: DpapiRunner = powershellDpapi,
  ) {
    this.label = `Windows DPAPI-encrypted file (${file})`;
  }

  async read(): Promise<string | undefined> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return undefined;
      throw err;
    }
    const plain = await this.run('Unprotect', parseDpapiFile(text));
    return Buffer.from(plain, 'base64').toString('utf8');
  }

  async write(value: string): Promise<void> {
    const ciphertext = await this.run('Protect', Buffer.from(value, 'utf8').toString('base64'));
    await mkdir(dirname(this.file), { recursive: true });
    // Write beside, then rename over: a crash mid-write must not leave a
    // half-written file that no longer decrypts.
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, formatDpapiFile(ciphertext), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, this.file);
  }
}

/**
 * The OS store is used only for the real ~/.heapcode, unless
 * HEAPCODE_SECRETS=file: the keychain on macOS, DPAPI on Windows, the plain
 * file elsewhere. A HEAPCODE_HOME override or any other path is a test or a
 * deliberately separate setup (guardrail #12), and must never read or
 * overwrite the user's real keys.
 */
export function defaultSecretBackend(path: string): SecretBackend | null {
  if (process.env.HEAPCODE_SECRETS === 'file') return null;
  if (process.env.HEAPCODE_HOME) return null;
  if (resolve(path) !== join(homedir(), '.heapcode', 'secrets.json')) return null;
  if (process.platform === 'darwin') return new MacKeychain();
  if (process.platform === 'win32') return new WindowsDpapi(join(dirname(path), DPAPI_FILE));
  return null;
}

const encode = encodeSecretsMap;
const decode = decodeSecretsMap;

/**
 * API keys and MCP OAuth tokens, keyed `apiKey.<profileName>` /
 * `mcpAuth.<server>` — the CLI's equivalent of the extension's
 * vscode.SecretStorage.
 *
 * On macOS they live in the login keychain; on Windows, in a DPAPI-encrypted
 * file. Everywhere else — Linux, CI, SSH sessions, any machine where those
 * can't be reached — in a chmod-600 JSON file (~/.heapcode/secrets.json), the
 * same posture as the gh and aws CLIs. An OS-store-only design would break
 * headless machines (guardrail #5), so the file is always the fallback.
 *
 * Keys found in the file while an OS store is in use are moved into it and
 * the file is deleted, but only after the store has been read back and
 * matches — a failed move leaves the file exactly as it was.
 */
export class SecretsStore {
  private cache?: Record<string, string>;
  private backend: SecretBackend | null;
  /** Why the OS store was abandoned for this process, when it was. */
  private backendError?: string;

  constructor(
    private readonly path: string = secretsFile(),
    backend: SecretBackend | null = defaultSecretBackend(path),
  ) {
    this.backend = backend;
  }

  /** Where the keys are kept, for settings and /config. */
  location(): string {
    return this.backend ? this.backend.label : `${this.path} (chmod 600)`;
  }

  /** Set when the OS store could not be used and the file took over. */
  fallbackReason(): string | undefined {
    return this.backendError;
  }

  private async readFileMap(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private async writeFileMap(map: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(map, null, 2), { encoding: 'utf8', mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  /** The OS store is unusable (locked, denied, timed out): the file takes over for this process. */
  private abandonBackend(err: unknown): void {
    this.backendError = err instanceof Error ? err.message : String(err);
    this.backend = null;
  }

  /** Write the map to the OS store and confirm it reads back identically. */
  private async writeBackend(backend: SecretBackend, map: Record<string, string>): Promise<void> {
    const value = encode(map);
    await backend.write(value);
    if ((await backend.read()) !== value) throw new Error('Keychain write did not read back the same value.');
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    const backend = this.backend;
    if (!backend) return (this.cache = await this.readFileMap());

    let stored: Record<string, string> = {};
    try {
      const raw = await backend.read();
      if (raw) stored = decode(raw);
    } catch (err) {
      this.abandonBackend(err);
      return (this.cache = await this.readFileMap());
    }

    // Anything still in the file: from before the OS store, or written by an
    // older heapcode that only knows the file. Fold it in (the file wins for
    // a key in both — it was written by something that could not see the
    // OS store, so it is the newer value), then delete the file.
    const fromFile = await this.readFileMap();
    if (Object.keys(fromFile).length === 0) return (this.cache = stored);
    const merged = { ...stored, ...fromFile };
    try {
      await this.writeBackend(backend, merged);
    } catch (err) {
      // Keep using the file, untouched; nothing has been lost.
      this.abandonBackend(err);
      return (this.cache = fromFile);
    }
    await unlink(this.path).catch(() => undefined);
    return (this.cache = merged);
  }

  private async persist(): Promise<void> {
    const map = this.cache ?? {};
    if (this.backend) {
      try {
        await this.writeBackend(this.backend, map);
        return;
      } catch (err) {
        // The change must not be lost: it goes to the file instead.
        this.abandonBackend(err);
      }
    }
    await this.writeFileMap(map);
  }

  async getApiKey(profileName: string): Promise<string | undefined> {
    return (await this.load())[`apiKey.${profileName}`];
  }

  async setApiKey(profileName: string, key: string): Promise<void> {
    const secrets = await this.load();
    secrets[`apiKey.${profileName}`] = key;
    await this.persist();
  }

  async deleteApiKey(profileName: string): Promise<void> {
    const secrets = await this.load();
    delete secrets[`apiKey.${profileName}`];
    await this.persist();
  }

  /**
   * OAuth records for MCP servers, keyed `mcpAuth.<server>`.
   *
   * Here rather than in `config.json` because these are bearer tokens and
   * that file is read straight into a settings panel. They are stored
   * alongside the API keys, which is what they are.
   */
  async getMcpAuth(server: string): Promise<McpAuthRecord | undefined> {
    const raw = (await this.load())[`mcpAuth.${server}`];
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as McpAuthRecord;
    } catch {
      // A record we cannot read is a record we cannot use; reporting absence
      // asks for a fresh sign-in instead of failing the connection.
      return undefined;
    }
  }

  async setMcpAuth(server: string, record: McpAuthRecord): Promise<void> {
    const secrets = await this.load();
    secrets[`mcpAuth.${server}`] = JSON.stringify(record);
    await this.persist();
  }

  async deleteMcpAuth(server: string): Promise<void> {
    const secrets = await this.load();
    delete secrets[`mcpAuth.${server}`];
    await this.persist();
  }
}

/** `SecretsStore` as the shape core's OAuth provider reads and writes. */
export class SecretsMcpAuthStore implements McpAuthStore {
  constructor(private readonly secrets: SecretsStore) {}
  read(server: string): Promise<McpAuthRecord | undefined> {
    return this.secrets.getMcpAuth(server);
  }
  write(server: string, record: McpAuthRecord): Promise<void> {
    return this.secrets.setMcpAuth(server, record);
  }
  clear(server: string): Promise<void> {
    return this.secrets.deleteMcpAuth(server);
  }
}
