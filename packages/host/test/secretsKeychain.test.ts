import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DPAPI_HEADER,
  dpapiPowerShellArgs,
  readDpapiSecretsSync,
  readKeychainSecretsSync,
  windowsPowerShell,
} from '@heapcode/core/node';
import {
  defaultSecretBackend,
  MacKeychain,
  powershellDpapi,
  SecretsStore,
  WindowsDpapi,
  type DpapiRunner,
  type SecretBackend,
} from '../src/config/secrets.js';

/** An in-memory keychain that can be told to fail in each of the ways a real one does. */
class FakeKeychain implements SecretBackend {
  readonly label = 'Fake keychain';
  value: string | undefined;
  failRead = false;
  failWrite = false;
  /** Accepts the write but stores something else, like a silently failed `security -i`. */
  corruptWrite = false;
  writes = 0;

  async read(): Promise<string | undefined> {
    if (this.failRead) throw new Error('User interaction is not allowed.');
    return this.value;
  }
  async write(value: string): Promise<void> {
    if (this.failWrite) throw new Error('Keychain write failed: denied');
    this.writes++;
    this.value = this.corruptWrite ? 'garbage' : value;
  }
  map(): Record<string, string> {
    return JSON.parse(Buffer.from(this.value ?? '', 'base64').toString('utf8')) as Record<string, string>;
  }
}

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heapcode-secrets-'));
  path = join(dir, 'secrets.json');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const seedFile = (map: Record<string, string>) => writeFile(path, JSON.stringify(map), { mode: 0o600 });

describe('defaultSecretBackend', () => {
  const real = join(homedir(), '.heapcode', 'secrets.json');

  it('never uses the keychain for any path but the real ~/.heapcode', () => {
    expect(defaultSecretBackend(path)).toBeNull();
  });

  it('never uses the keychain under a HEAPCODE_HOME override (test isolation)', () => {
    vi.stubEnv('HEAPCODE_HOME', dir);
    expect(defaultSecretBackend(real)).toBeNull();
  });

  it('can be forced back to the file with HEAPCODE_SECRETS=file', () => {
    vi.stubEnv('HEAPCODE_HOME', '');
    vi.stubEnv('HEAPCODE_SECRETS', 'file');
    expect(defaultSecretBackend(real)).toBeNull();
  });

  it('picks the keychain on macOS, DPAPI on Windows, and the plain file elsewhere', () => {
    vi.stubEnv('HEAPCODE_HOME', '');
    vi.stubEnv('HEAPCODE_SECRETS', '');
    const original = process.platform;
    const as = (platform: string) => {
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        return defaultSecretBackend(real);
      } finally {
        Object.defineProperty(process, 'platform', { value: original });
      }
    };
    expect(as('darwin')).toBeInstanceOf(MacKeychain);
    const windows = as('win32');
    expect(windows).toBeInstanceOf(WindowsDpapi);
    expect(windows!.label).toContain(join(homedir(), '.heapcode', 'secrets.dpapi'));
    expect(as('linux')).toBeNull();
  });
});

/** Stands in for PowerShell off Windows: reversible, and visibly not the plaintext. */
const fakeDpapi: DpapiRunner = async (op, input) =>
  op === 'Protect'
    ? Buffer.from(`sealed:${input}`).toString('base64')
    : Buffer.from(input, 'base64').toString('utf8').replace(/^sealed:/, '');

describe('WindowsDpapi (plumbing, any OS)', () => {
  it('reports nothing stored until written, then round-trips through a headed file with no plaintext in it', async () => {
    const file = join(dir, 'secrets.dpapi');
    const backend = new WindowsDpapi(file, fakeDpapi);
    expect(await backend.read()).toBeUndefined();

    await backend.write('c2VjcmV0LXZhbHVl');
    expect(await backend.read()).toBe('c2VjcmV0LXZhbHVl');
    const text = await readFile(file, 'utf8');
    expect(text.startsWith(`${DPAPI_HEADER}\n`)).toBe(true);
    expect(text).not.toContain('c2VjcmV0LXZhbHVl');
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
  });

  it('moves keys out of secrets.json into secrets.dpapi', async () => {
    await seedFile({ 'apiKey.claude': 'sk-ant-1' });
    const file = join(dir, 'secrets.dpapi');
    const store = new SecretsStore(path, new WindowsDpapi(file, fakeDpapi));
    expect(await store.getApiKey('claude')).toBe('sk-ant-1');
    expect(existsSync(path)).toBe(false);
    expect(await readFile(file, 'utf8')).not.toContain('sk-ant-1');
    expect(await new SecretsStore(path, new WindowsDpapi(file, fakeDpapi)).getApiKey('claude')).toBe('sk-ant-1');
  });

  it('falls back to the file, untouched, when the encrypted file cannot be decrypted', async () => {
    const file = join(dir, 'secrets.dpapi');
    await writeFile(file, `${DPAPI_HEADER}\nAAAA\n`);
    await seedFile({ 'apiKey.claude': 'sk-ant-1' });
    const failing: DpapiRunner = async () => {
      throw new Error('DPAPI unprotect failed: Key not valid for use in specified state.');
    };
    const store = new SecretsStore(path, new WindowsDpapi(file, failing));
    expect(await store.getApiKey('claude')).toBe('sk-ant-1');
    expect(store.fallbackReason()).toMatch(/Key not valid/);
    expect(existsSync(path)).toBe(true);
  });

  it('rejects a secrets.dpapi in any other format', async () => {
    const file = join(dir, 'secrets.dpapi');
    await writeFile(file, '{"apiKey.x":"plaintext"}');
    await expect(new WindowsDpapi(file, fakeDpapi).read()).rejects.toThrow(/Unrecognized/);
  });

  it('runs a fixed PowerShell script by absolute path, with no data on the command line', () => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    expect(windowsPowerShell()).toBe(join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    for (const op of ['Protect', 'Unprotect'] as const) {
      const args = dpapiPowerShellArgs(op);
      expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
      const script = Buffer.from(args[4]!, 'base64').toString('utf16le');
      expect(script).toContain(`ProtectedData]::${op}(`);
      expect(script).toContain('DataProtectionScope]::CurrentUser');
      expect(script).toContain('[Console]::In.ReadToEnd()');
    }
  });
});

// Real DPAPI through Windows PowerShell; runs on Windows (CI has a job for it).
describe.runIf(process.platform === 'win32')('WindowsDpapi (real DPAPI)', () => {
  it('encrypts and decrypts, including non-ASCII and a large value', async () => {
    const value = Buffer.from(JSON.stringify({ 'apiKey.x': `sk-"q" ü ${'z'.repeat(100_000)}` })).toString('base64');
    const sealed = await powershellDpapi('Protect', Buffer.from(value).toString('base64'));
    expect(sealed).not.toContain(value.slice(0, 40));
    expect(Buffer.from(await powershellDpapi('Unprotect', sealed), 'base64').toString()).toBe(value);
  }, 60_000);

  it('fails cleanly on data DPAPI did not produce', async () => {
    await expect(powershellDpapi('Unprotect', Buffer.from('not a dpapi blob').toString('base64'))).rejects.toThrow(
      /DPAPI unprotect failed/,
    );
  }, 60_000);

  it("writes what the VS Code extension's synchronous reader reads", async () => {
    await seedFile({ 'apiKey.claude': 'sk-ant-win' });
    const file = join(dir, 'secrets.dpapi');
    const store = new SecretsStore(path, new WindowsDpapi(file));
    expect(await store.getApiKey('claude')).toBe('sk-ant-win');
    expect(existsSync(path)).toBe(false);
    expect(readDpapiSecretsSync(file)).toEqual({ 'apiKey.claude': 'sk-ant-win' });
  }, 60_000);
});

describe('SecretsStore with a keychain', () => {
  it('moves keys from the file into the keychain, then deletes the file', async () => {
    await seedFile({ 'apiKey.claude': 'sk-ant-1', 'mcpAuth.github': '{"access_token":"t"}' });
    const keychain = new FakeKeychain();
    const store = new SecretsStore(path, keychain);

    expect(await store.getApiKey('claude')).toBe('sk-ant-1');
    expect(keychain.map()).toEqual({ 'apiKey.claude': 'sk-ant-1', 'mcpAuth.github': '{"access_token":"t"}' });
    expect(existsSync(path)).toBe(false);
    expect(store.location()).toBe('Fake keychain');
  });

  it('writes new keys to the keychain and never recreates the file', async () => {
    const keychain = new FakeKeychain();
    const store = new SecretsStore(path, keychain);
    await store.setApiKey('a', 'key-a');
    await store.setApiKey('b', 'key-b');
    await store.deleteApiKey('a');
    expect(keychain.map()).toEqual({ 'apiKey.b': 'key-b' });
    expect(existsSync(path)).toBe(false);
    // A fresh process sees the same keys.
    expect(await new SecretsStore(path, keychain).getApiKey('b')).toBe('key-b');
  });

  it('folds in keys an older heapcode wrote to the file, the file winning', async () => {
    const keychain = new FakeKeychain();
    await new SecretsStore(path, keychain).setApiKey('a', 'old');
    await seedFile({ 'apiKey.a': 'new', 'apiKey.b': 'b' });
    const store = new SecretsStore(path, keychain);
    expect(await store.getApiKey('a')).toBe('new');
    expect(keychain.map()).toEqual({ 'apiKey.a': 'new', 'apiKey.b': 'b' });
    expect(existsSync(path)).toBe(false);
  });

  it('leaves the file untouched when the move fails', async () => {
    await seedFile({ 'apiKey.claude': 'sk-ant-1' });
    const keychain = new FakeKeychain();
    keychain.failWrite = true;
    const store = new SecretsStore(path, keychain);

    expect(await store.getApiKey('claude')).toBe('sk-ant-1');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'apiKey.claude': 'sk-ant-1' });
    expect(store.fallbackReason()).toMatch(/denied/);
    expect(store.location()).toContain(path);
  });

  it('does not trust a write that does not read back identically', async () => {
    await seedFile({ 'apiKey.claude': 'sk-ant-1' });
    const keychain = new FakeKeychain();
    keychain.corruptWrite = true;
    const store = new SecretsStore(path, keychain);

    expect(await store.getApiKey('claude')).toBe('sk-ant-1');
    expect(existsSync(path)).toBe(true);
    expect(store.fallbackReason()).toMatch(/read back/);
  });

  it('uses the file when the keychain is locked or unreachable', async () => {
    await seedFile({ 'apiKey.claude': 'sk-ant-1' });
    const keychain = new FakeKeychain();
    keychain.failRead = true;
    const store = new SecretsStore(path, keychain);

    expect(await store.getApiKey('claude')).toBe('sk-ant-1');
    await store.setApiKey('other', 'x');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'apiKey.claude': 'sk-ant-1', 'apiKey.other': 'x' });
    expect(keychain.writes).toBe(0);
  });

  it('saves a change to the file rather than losing it when a keychain write fails later', async () => {
    const keychain = new FakeKeychain();
    const store = new SecretsStore(path, keychain);
    await store.setApiKey('a', 'key-a');
    keychain.failWrite = true;
    await store.setApiKey('b', 'key-b');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'apiKey.a': 'key-a', 'apiKey.b': 'key-b' });
  });

  it('stays a plain chmod-600 file with no backend', async () => {
    const store = new SecretsStore(path, null);
    await store.setApiKey('a', 'key-a');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ 'apiKey.a': 'key-a' });
    expect(store.location()).toBe(`${path} (chmod 600)`);
  });
});

// The real `security` tool, against a throwaway item that is deleted after.
describe.runIf(process.platform === 'darwin' && !process.env.CI)('MacKeychain (real login keychain)', () => {
  const service = `heapcode-test-${randomBytes(6).toString('hex')}`;
  const exists = (account: string): boolean => {
    try {
      execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  afterEach(() => {
    for (const account of ['secrets', ...Array.from({ length: 20 }, (_, i) => `secrets.${i + 1}`)]) {
      try {
        execFileSync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], { stdio: 'ignore' });
      } catch {
        // Already gone.
      }
    }
  });

  it('splits a large value across items, and clears the extra items when it shrinks', async () => {
    const keychain = new MacKeychain(service, 'secrets');
    const big = Buffer.from(JSON.stringify({ x: 'x'.repeat(9_000) })).toString('base64'); // ~12,000 chars -> 9 parts
    await keychain.write(big);
    expect(await keychain.read()).toBe(big);
    expect(exists('secrets.9')).toBe(true);
    // The VS Code extension's synchronous reader reassembles the same parts.
    expect(readKeychainSecretsSync(service, 'secrets')).toEqual({ x: 'x'.repeat(9_000) });
    await keychain.write('small');
    expect(await keychain.read()).toBe('small');
    expect(exists('secrets.1')).toBe(false);
    expect(exists('secrets.9')).toBe(false);
  });

  it('never puts the value in an error message', async () => {
    const keychain = new MacKeychain(service, 'secrets');
    await keychain.write('chunked:3'); // a marker whose parts don't exist
    const err: unknown = await keychain.read().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/incomplete/);
  });

  it('reports no item, then round-trips a value with quotes, spaces and non-ASCII', async () => {
    const keychain = new MacKeychain(service, 'secrets');
    expect(await keychain.read()).toBeUndefined();
    const value = Buffer.from(JSON.stringify({ 'apiKey.x': `sk-"quoted" key ü ${'z'.repeat(2000)}` })).toString('base64');
    await keychain.write(value);
    expect(await keychain.read()).toBe(value);
    await keychain.write('second');
    expect(await keychain.read()).toBe('second');
  });

  it('works end to end through SecretsStore', async () => {
    await seedFile({ 'apiKey.claude': 'sk-ant-real-test' });
    const store = new SecretsStore(path, new MacKeychain(service, 'secrets'));
    expect(await store.getApiKey('claude')).toBe('sk-ant-real-test');
    expect(existsSync(path)).toBe(false);
    expect(await new SecretsStore(path, new MacKeychain(service, 'secrets')).getApiKey('claude')).toBe('sk-ant-real-test');
  });
});
