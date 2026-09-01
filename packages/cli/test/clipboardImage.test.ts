import { afterEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile }));

const { readClipboardImage, isFailure, MAX_IMAGE_BYTES } = await import('../src/clipboardImage.js');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A byte-valid minimal PNG — magic plus enough bytes to clear the length floor. */
const PNG = Buffer.concat([PNG_MAGIC, Buffer.alloc(64, 7)]);

/**
 * Stand in for the OS helpers.
 *
 * `which`/`where` is answered by `present`, so a test can say what is installed
 * without caring which probe this platform uses.
 */
function stubShell(handler: (cmd: string, args: string[]) => Buffer | Error, present = new Set<string>()) {
  execFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: unknown) => {
    const done = (typeof _opts === 'function' ? _opts : cb) as (e: Error | null, out?: Buffer) => void;
    if (cmd === 'which' || cmd === 'where') {
      return done(present.has(args[0]!) ? null : new Error('not found'));
    }
    const result = handler(cmd, args);
    if (result instanceof Error) return done(result);
    done(null, result);
  });
}

function onPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

const realPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  execFile.mockReset();
});

describe('reading a clipboard image on macOS', () => {
  it('decodes what AppleScript returns, guillemets and all', async () => {
    onPlatform('darwin');
    // The real reply is `«data PNGf<hex>»`, and those brackets are multi-byte
    // UTF-8 — decoding them as ASCII turns `«` into two bytes of noise, which
    // is exactly what broke this the first time. The parse keys on the marker
    // rather than on stripping the brackets.
    stubShell(() => Buffer.from(`«data PNGf${PNG.toString('hex').toUpperCase()}»`, 'utf8'));
    const result = await readClipboardImage();
    expect(isFailure(result)).toBe(false);
    expect(result).toMatchObject({ bytes: PNG.length });
    expect((result as { dataUrl: string }).dataUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('says nothing when the clipboard holds text', async () => {
    onPlatform('darwin');
    // osascript fails with -1700 ("can't make some data into the expected
    // type"). That is the ordinary case for a key pressed out of habit, so it
    // must not produce a banner.
    stubShell(() => new Error('execution error: -1700'));
    expect(await readClipboardImage()).toBeUndefined();
  });

  it('rejects a reply that is not actually a PNG', async () => {
    onPlatform('darwin');
    stubShell(() => Buffer.from('«data PNGfdeadbeefdeadbeef»', 'utf8'));
    const result = await readClipboardImage();
    expect(isFailure(result)).toBe(true);
    expect((result as { reason: string }).reason).toMatch(/could not be read/);
  });

  it('refuses an image past the size cap', async () => {
    onPlatform('darwin');
    const huge = Buffer.concat([PNG_MAGIC, Buffer.alloc(MAX_IMAGE_BYTES, 1)]);
    stubShell(() => Buffer.from(`«data PNGf${huge.toString('hex')}»`, 'utf8'));
    const result = await readClipboardImage();
    expect(isFailure(result)).toBe(true);
    expect((result as { reason: string }).reason).toMatch(/the limit is/);
  });
});

describe('reading a clipboard image on Linux', () => {
  it('prefers wl-paste where a Wayland session provides it', async () => {
    onPlatform('linux');
    const seen: string[] = [];
    stubShell((cmd) => {
      seen.push(cmd);
      return cmd === 'wl-paste' ? PNG : new Error('no');
    }, new Set(['wl-paste', 'xclip']));
    const result = await readClipboardImage();
    expect(result).toMatchObject({ bytes: PNG.length });
    expect(seen).toContain('wl-paste');
    expect(seen).not.toContain('xclip');
  });

  it('falls back to xclip on X11', async () => {
    onPlatform('linux');
    stubShell((cmd) => (cmd === 'xclip' ? PNG : new Error('no')), new Set(['xclip']));
    expect(await readClipboardImage()).toMatchObject({ bytes: PNG.length });
  });

  it('names the package to install when neither helper exists', async () => {
    onPlatform('linux');
    // The alternative is a key that silently does nothing, which reads as a
    // broken feature rather than a missing package.
    stubShell(() => new Error('no'), new Set());
    const result = await readClipboardImage();
    expect(isFailure(result)).toBe(true);
    expect((result as { reason: string }).reason).toMatch(/wl-clipboard.*xclip/);
  });
});

describe('reading a clipboard image on Windows', () => {
  it('decodes the base64 PowerShell prints', async () => {
    onPlatform('win32');
    // Base64 rather than raw bytes: PowerShell's stdout re-encodes binary in a
    // way that is invisible until the image fails to decode.
    stubShell(() => Buffer.from(PNG.toString('base64'), 'ascii'));
    expect(await readClipboardImage()).toMatchObject({ bytes: PNG.length });
  });

  it('says nothing when the clipboard holds no image', async () => {
    onPlatform('win32');
    stubShell(() => new Error('exit 1'));
    expect(await readClipboardImage()).toBeUndefined();
  });
});
