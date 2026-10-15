import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A file in this computer's default app — a report or an artifact in the browser.
 *
 * Opening the file rather than a URL is what makes it work from the desktop
 * app: a link to the page's own server opens in the system browser, which has
 * never seen the sign-in token, and is refused. The report is one page with no
 * server needed, so the file is the thing to open.
 */
export function openFile(path: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/**
 * An HTML page opened in this computer's browser, by way of a temporary file.
 *
 * For the desktop app, which refuses new windows of its own and whose pages'
 * links reach a browser that is not signed in: the page is written out whole
 * and the file is opened instead. Named by a hash of its content, so opening
 * the same thing twice reuses one file rather than piling them up.
 */
export async function openHtmlInBrowser(title: string, html: string): Promise<string> {
  const dir = join(tmpdir(), 'heapcode-open');
  await mkdir(dir, { recursive: true });
  const name = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page';
  const file = join(dir, `${name}-${createHash('sha256').update(html).digest('hex').slice(0, 10)}.html`);
  await writeFile(file, html, 'utf8');
  openFile(file);
  return file;
}

/**
 * A page's "open this in the browser" request, checked: on this computer only
 * (a page reached over the network would open it here, not there), and a
 * real, bounded page. Heap Code's and Heap Chat's hosts both answer with it.
 */
export async function openPageRequest(raw: unknown, lan: boolean | undefined, product: string): Promise<null> {
  if (lan) throw new Error(`Reached over the network: open it from the computer running ${product}.`);
  const { title, html } = (raw ?? {}) as { title?: unknown; html?: unknown };
  if (typeof html !== 'string' || !html) throw new Error('Nothing to open.');
  if (html.length > 20_000_000) throw new Error('That page is too large to open.');
  await openHtmlInBrowser(String(title ?? 'page'), html);
  return null;
}
