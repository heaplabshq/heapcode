import { spawn } from 'node:child_process';

/**
 * A file in this computer's default app — a report in the browser.
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
