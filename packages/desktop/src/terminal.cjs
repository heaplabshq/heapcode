// The integrated terminal: a real shell on a pty, owned by the main process.
//
// Here rather than in the web host because node-pty is a native module, and the
// CLI deliberately ships none — `npm install -g` has to work on machines with no
// compiler. The desktop app bundles its own Electron, so it can carry one.
//
// One shell per project folder, kept alive while the panel is closed or showing
// another view: closing a panel is not a request to kill what is running in it.
// Output is kept in a bounded buffer and replayed when the view comes back, so
// the scrollback survives too. The page only ever names a shell by its folder;
// everything else — which shell binary, its environment — is decided here.
const { ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');

let pty = null;
try { pty = require('node-pty'); } catch { /* reported to the page as unavailable */ }

const SCROLLBACK = 256 * 1024;

/**
 * Local addresses a shell has printed — `vite` saying "Local: http://localhost:5173/"
 * — so the Browser view can offer them without anyone copying a URL. Newest
 * last, capped, and shared by every shell: which folder started the dev server
 * does not matter to the person wanting to open it.
 */
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"\x1b)]*)?/g;
// Colour codes land in the middle of URLs often enough to matter.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
let localUrls = [];
const urlListeners = new Set();
function noteUrls(data) {
  const found = data.replace(ANSI, '').match(LOCAL_URL);
  if (!found) return;
  let changed = false;
  for (const raw of found) {
    const url = raw.replace('0.0.0.0', 'localhost').replace(/[.,;:]+$/, '');
    if (localUrls.includes(url)) continue;
    localUrls = [...localUrls, url].slice(-8);
    changed = true;
  }
  if (changed) for (const fn of urlListeners) fn(localUrls);
}
/** cwd → { proc, buffer, exited } */
const shells = new Map();

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

function start(cwd, cols, rows, send) {
  const env = { ...process.env, TERM_PROGRAM: 'HeapCode' };
  delete env.ELECTRON_RUN_AS_NODE;
  // A login shell: an app opened from the Dock inherits launchd's bare PATH,
  // and -l is what gets the person's own PATH (Homebrew, nvm, …) back.
  const proc = pty.spawn(defaultShell(), process.platform === 'win32' ? [] : ['-l'], {
    name: 'xterm-256color',
    cols, rows, cwd, env,
  });
  const entry = { proc, buffer: '', exited: false };
  proc.onData((data) => {
    entry.buffer = (entry.buffer + data).slice(-SCROLLBACK);
    noteUrls(data);
    send('heap:term-data', cwd, data);
  });
  proc.onExit(({ exitCode }) => {
    entry.exited = true;
    send('heap:term-exit', cwd, exitCode);
    if (shells.get(cwd) === entry) shells.delete(cwd);
  });
  shells.set(cwd, entry);
  return entry;
}

/**
 * @param {(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => boolean} trusted
 *   Whether a message came from the local Heap Code page — nothing else may
 *   drive a shell.
 */
function registerTerminal(trusted) {
  const sendTo = (sender) => (channel, ...args) => { if (!sender.isDestroyed()) sender.send(channel, ...args); };

  ipcMain.handle('heap:term-open', (e, { cwd, cols, rows }) => {
    if (!trusted(e)) throw new Error('not allowed');
    if (!pty) throw new Error('The terminal is unavailable: node-pty failed to load.');
    const dir = typeof cwd === 'string' && fs.existsSync(cwd) ? cwd : os.homedir();
    let entry = shells.get(dir);
    if (!entry) entry = start(dir, cols || 80, rows || 24, sendTo(e.sender));
    else entry.proc.resize(cols || 80, rows || 24);
    // Replayed so a reopened panel shows what was there, not a blank prompt.
    return { id: dir, replay: entry.buffer };
  });
  ipcMain.on('heap:term-write', (e, id, data) => {
    if (trusted(e) && typeof data === 'string') shells.get(id)?.proc.write(data);
  });
  ipcMain.on('heap:term-resize', (e, id, cols, rows) => {
    if (trusted(e) && cols > 0 && rows > 0) { try { shells.get(id)?.proc.resize(cols, rows); } catch {} }
  });
  ipcMain.handle('heap:local-urls', (e) => (trusted(e) ? localUrls : []));
  ipcMain.on('heap:local-urls-watch', (e) => {
    if (!trusted(e)) return;
    const send = sendTo(e.sender);
    const fn = (urls) => send('heap:local-urls', urls);
    urlListeners.add(fn);
    const sender = e.sender;
    // A reload re-subscribes; the old page's listener must not pile up. Only a
    // real page load counts — the app's own pushState routing is not one.
    const onNav = (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      urlListeners.delete(fn);
      sender.off('did-start-navigation', onNav);
    };
    sender.on('did-start-navigation', onNav);
    sender.once('destroyed', () => urlListeners.delete(fn));
  });
  ipcMain.on('heap:term-kill', (e, id) => {
    if (trusted(e)) killShell(id);
  });
}

function killShell(id) {
  const entry = shells.get(id);
  shells.delete(id);
  try { entry?.proc.kill(); } catch {}
}

function killAllShells() {
  for (const id of [...shells.keys()]) killShell(id);
}

module.exports = { registerTerminal, killAllShells, terminalAvailable: () => Boolean(pty) };
