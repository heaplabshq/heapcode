import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the CLI keeps its secrets outside secrets.json, and how to read them.
 *
 * Shared because two packages read the same storage: host's `SecretsStore`
 * owns it (reads, writes, migration), and the VS Code extension reads the
 * CLI's keys for connections it shares with the terminal. Both must agree on
 * the format byte for byte, so the format lives here once.
 *
 * Whatever the platform, the stored value is one opaque string: the whole
 * secrets map as base64 JSON.
 */

// --- macOS: the login keychain, via /usr/bin/security --------------------

export const SECURITY_TOOL = '/usr/bin/security';
export const KEYCHAIN_SERVICE = 'heapcode';
export const KEYCHAIN_ACCOUNT = 'secrets';
/** `security` exits 44 when no matching item exists. */
export const KEYCHAIN_ITEM_NOT_FOUND = 44;
/**
 * A value longer than one item can carry through `security -i` is split
 * across `<account>.1..N`, and the main item holds this marker plus N.
 * Base64 never contains ':', so the marker can't be mistaken for a value.
 */
export const KEYCHAIN_CHUNKED = 'chunked:';

// --- Windows: a DPAPI-encrypted file, via Windows PowerShell --------------

/** Beside secrets.json; holds DPAPI_HEADER, a newline, then the ciphertext as base64. */
export const DPAPI_FILE = 'secrets.dpapi';
export const DPAPI_HEADER = 'heapcode-dpapi-v1';

/**
 * Windows PowerShell 5.1, by absolute path: it ships with every Windows 10
 * and 11 install and always has System.Security's ProtectedData. A bare
 * `powershell` would be resolved through PATH, which a writable directory
 * earlier on it could hijack.
 */
export function windowsPowerShell(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Arguments for one DPAPI call. The script is fixed and carries no data; the
 * data goes in on stdin as base64 and comes back on stdout as base64, so a
 * secret is never on a command line.
 *
 * CurrentUser scope: only this Windows account on this machine can decrypt.
 * The entropy ties blobs to Heap Code, so another program's DPAPI data can't
 * be fed back in as ours.
 */
export function dpapiPowerShellArgs(op: 'Protect' | 'Unprotect'): string[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    "$entropy = [Text.Encoding]::UTF8.GetBytes('heapcode-secrets')",
    `$out = [Security.Cryptography.ProtectedData]::${op}($in, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** The ciphertext from a secrets.dpapi file's text; throws on any other format. */
export function parseDpapiFile(text: string): string {
  const newline = text.indexOf('\n');
  const header = (newline === -1 ? text : text.slice(0, newline)).trim();
  if (header !== DPAPI_HEADER) throw new Error(`Unrecognized ${DPAPI_FILE} format.`);
  return text.slice(newline + 1).trim();
}

export function formatDpapiFile(ciphertextBase64: string): string {
  return `${DPAPI_HEADER}\n${ciphertextBase64}\n`;
}

// --- The stored value ------------------------------------------------------

export function encodeSecretsMap(map: Record<string, string>): string {
  return Buffer.from(JSON.stringify(map), 'utf8').toString('base64');
}

export function decodeSecretsMap(value: string): Record<string, string> {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Record<string, string>;
}

// --- Synchronous reads, for callers that cannot await ---------------------

function keychainFindSync(service: string, account: string): string | undefined {
  try {
    return execFileSync(SECURITY_TOOL, ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).replace(/\n$/, '');
  } catch {
    return undefined;
  }
}

/** The CLI's secrets map from the macOS keychain, or undefined if there is none or it can't be read. */
export function readKeychainSecretsSync(
  service: string = KEYCHAIN_SERVICE,
  account: string = KEYCHAIN_ACCOUNT,
): Record<string, string> | undefined {
  try {
    const main = keychainFindSync(service, account);
    if (main === undefined) return undefined;
    if (!main.startsWith(KEYCHAIN_CHUNKED)) return decodeSecretsMap(main);
    const count = Number(main.slice(KEYCHAIN_CHUNKED.length));
    const parts: string[] = [];
    for (let i = 1; i <= count; i++) {
      const part = keychainFindSync(service, `${account}.${i}`);
      if (part === undefined) return undefined;
      parts.push(part);
    }
    return decodeSecretsMap(parts.join(''));
  } catch {
    return undefined;
  }
}

/** The CLI's secrets map from a secrets.dpapi file, or undefined if there is none or it can't be decrypted. */
export function readDpapiSecretsSync(file: string): Record<string, string> | undefined {
  try {
    const ciphertext = parseDpapiFile(readFileSync(file, 'utf8'));
    const plain = execFileSync(windowsPowerShell(), dpapiPowerShellArgs('Unprotect'), {
      input: ciphertext,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return decodeSecretsMap(Buffer.from(plain.trim(), 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}
