import { execFile } from 'node:child_process';

/**
 * Reading an image off the system clipboard, from a terminal.
 *
 * A terminal cannot be handed bytes. Cmd+V (or a middle-click) makes the
 * terminal emulator type the clipboard's *text* into stdin as keystrokes, and
 * an image has no keystrokes — so a pasted screenshot arrives as nothing at
 * all, or as a file path if the user happened to copy one from a file manager.
 * The only way to get the picture is to ask the OS for it out of band, which
 * is what this does: Ctrl+V is bound as an explicit "attach what is on the
 * clipboard" command rather than as paste.
 *
 * Every backend here shells out to something already on the machine. Adding a
 * native clipboard dependency would mean a compiled addon in a CLI that is
 * currently installable anywhere Node runs, which is a bad trade for one
 * convenience key.
 *
 * The honest failure is the point. Where no helper exists — a bare Linux box
 * with neither wl-clipboard nor xclip — this says so and names what to install,
 * because the alternative is a key that silently does nothing and reads as a
 * broken feature rather than a missing package.
 */

/** Matches the web composer's own cap, so the two hosts agree on what is too big. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export type ClipboardImage = { dataUrl: string; bytes: number };

/** Why no image was attached — a sentence to show the user, never a thrown error. */
export type ClipboardFailure = { reason: string };

export type ClipboardResult = ClipboardImage | ClipboardFailure | undefined;

export function isFailure(result: ClipboardResult): result is ClipboardFailure {
  return result !== undefined && 'reason' in result;
}

/** Run a command and return stdout as bytes; undefined when it fails or is absent. */
function run(cmd: string, args: string[], maxBytes: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer: maxBytes * 2, timeout: 5_000 }, (err, stdout) => {
      if (err || !stdout || stdout.length === 0) return resolve(undefined);
      resolve(stdout);
    });
  });
}

/** Whether a command exists, so a missing helper can be named rather than guessed at. */
function have(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFile(probe, [cmd], { timeout: 3_000 }, (err) => resolve(!err));
  });
}

/**
 * macOS, with no dependency at all.
 *
 * `pbpaste` handles text only, so the picture comes through AppleScript, which
 * returns it as `«data PNGf<hex>»`. Verified round-tripping a PNG
 * byte-for-byte. The hex is the whole file, so this is bounded by maxBuffer
 * above rather than trusted.
 */
async function readMac(): Promise<Buffer | undefined> {
  const out = await run('osascript', ['-e', 'the clipboard as «class PNGf»'], MAX_IMAGE_BYTES);
  if (!out) return undefined;
  // Matched on the `data PNGf` marker rather than by stripping the guillemets
  // that surround it. Those are multi-byte UTF-8, so a decode that guesses
  // wrong turns `«` into two bytes of noise and a prefix test fails against a
  // reply that was perfectly good — which is exactly what it did.
  const hex = /data\s+PNGf([0-9A-Fa-f]+)/.exec(out.toString('utf8'))?.[1];
  if (!hex || hex.length < 16) return undefined;
  return Buffer.from(hex, 'hex');
}

/** Wayland first, then X11 — a Wayland session commonly has both, and wl-paste is the accurate one there. */
async function readLinux(): Promise<Buffer | ClipboardFailure | undefined> {
  if (await have('wl-paste')) {
    const out = await run('wl-paste', ['--type', 'image/png'], MAX_IMAGE_BYTES);
    if (out) return out;
  }
  if (await have('xclip')) {
    const out = await run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], MAX_IMAGE_BYTES);
    if (out) return out;
  }
  if (!(await have('wl-paste')) && !(await have('xclip'))) {
    return { reason: 'No clipboard image tool found. Install wl-clipboard (Wayland) or xclip (X11), or pass a file path instead.' };
  }
  return undefined;
}

/**
 * Windows, through PowerShell's own clipboard API.
 *
 * Base64 rather than raw bytes down the pipe: PowerShell's stdout is a text
 * stream that re-encodes what passes through it, which corrupts binary in a
 * way that is invisible until an image fails to decode.
 */
async function readWindows(): Promise<Buffer | undefined> {
  const script =
    'Add-Type -AssemblyName System.Windows.Forms;' +
    '$i=[Windows.Forms.Clipboard]::GetImage();' +
    'if($i -eq $null){exit 1};' +
    '$m=New-Object IO.MemoryStream;' +
    '$i.Save($m,[Drawing.Imaging.ImageFormat]::Png);' +
    '[Convert]::ToBase64String($m.ToArray())';
  const out = await run('powershell', ['-NoProfile', '-STA', '-Command', script], MAX_IMAGE_BYTES);
  if (!out) return undefined;
  const b64 = out.toString('ascii').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length < 24) return undefined;
  return Buffer.from(b64, 'base64');
}

/**
 * The image on the clipboard as a data URL, or a reason there isn't one.
 *
 * `undefined` means "nothing to attach" — the clipboard holds text, or is
 * empty. That is the ordinary case for a key the user may press by habit, so
 * it is not an error and should not produce a banner.
 */
export async function readClipboardImage(): Promise<ClipboardResult> {
  let result: Buffer | ClipboardFailure | undefined;
  if (process.platform === 'darwin') result = await readMac();
  else if (process.platform === 'win32') result = await readWindows();
  else result = await readLinux();

  if (result === undefined) return undefined;
  if (!Buffer.isBuffer(result)) return result;

  if (result.length > MAX_IMAGE_BYTES) {
    return { reason: `That image is ${Math.round(result.length / 1024 / 1024)} MB — the limit is ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.` };
  }
  // Checked rather than assumed: every backend above is asked for PNG, so a
  // reply that is not one means the helper returned something unexpected, and
  // a malformed data URL fails at the provider with a far worse message.
  if (!result.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { reason: 'The clipboard held an image in a format that could not be read.' };
  }
  return { dataUrl: `data:image/png;base64,${result.toString('base64')}`, bytes: result.length };
}
