// Desktop shell around `heapcode web`. It runs the CLI's own web host as a child
// process (Electron's bundled Node, so no separate Node install), reads the
// one-time-token URL it prints, and shows that page in a BrowserWindow. All the
// product lives in @heapcode/web-host + web-ui; this file only owns the window,
// the workspace folder, and the child's lifetime.
const { app, BrowserWindow, Menu, dialog, ipcMain, powerSaveBlocker, shell } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const { registerTerminal, killAllShells } = require('./terminal.cjs');
const { guardWebviews } = require('./browser.cjs');

app.setName('Heap Code');

// Packaged: electron-builder copies packages/cli/dist to Resources/cli.
const CLI_ENTRY = app.isPackaged
  ? path.join(process.resourcesPath, 'cli', 'cli.js')
  : path.join(__dirname, '..', '..', 'cli', 'dist', 'cli.js');

const stateFile = () => path.join(app.getPath('userData'), 'state.json');
const readState = () => {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
};
const writeState = (s) => {
  try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch {}
};

let server = null;
let win = null;
let origin = null;
let quitting = false;

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const p = server;
    server = null;
    p.once('exit', resolve);
    try { p.kill(); } catch { return resolve(); }
    setTimeout(resolve, 3000);
  });
}

/** Start `heapcode web` in `folder`; resolves to the tokened URL it prints. */
async function startServer(folder) {
  const port = await freePort();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, 'web', '--port', String(port)], {
      cwd: folder,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server = child;
    let out = '';
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error(`Server did not start in time.\n\n${out.slice(-800)}`)), 30000);
    const onData = (b) => {
      out += b.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+/);
      if (m) finish(resolve, m[0]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => finish(reject, e));
    child.on('exit', (code) => {
      const wasRunning = settled && server === child;
      if (server === child) server = null;
      finish(reject, new Error(`heapcode web exited (${code}).\n\n${out.slice(-800)}`));
      if (!quitting && wasRunning && code) dialog.showErrorBox('Heap Code', `The Heap Code server stopped (exit ${code}).`);
    });
  });
}

const MAC_CHROME_CSS = `
  html .rail { padding-top: 6px !important; }
  /* The rail's header row becomes the title-bar row: traffic lights on the left
     (native), switcher on the right, the rest drags the window. */
  html .rail-top { height: 28px; margin-bottom: 10px; padding: 0 2px 0 0; justify-content: flex-end; -webkit-app-region: drag; }
  html .rail-logo, html .rail-brand { display: none; }
  html .rail-top > * { -webkit-app-region: no-drag; }
  /* Pinned beside the lights so it stays put when the rail collapses to 56px. */
  html .rail-collapse { position: fixed; left: 84px; top: 8px; z-index: 50; }
`;

// "Keep computer awake" in the ⋮ menu. prevent-app-suspension stops the system
// sleeping but lets the display turn off; it dies with the process, which is
// what "only for this session" promises.
let awakeId = null;
const isAwake = () => awakeId !== null && powerSaveBlocker.isStarted(awakeId);
const fromLocalHost = (e) => Boolean(origin) && e.senderFrame && new URL(e.senderFrame.url).origin === origin;
ipcMain.handle('heap:keep-awake', (e, on) => {
  if (!fromLocalHost(e)) return isAwake();
  if (on && !isAwake()) awakeId = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && isAwake()) { powerSaveBlocker.stop(awakeId); awakeId = null; }
  return isAwake();
});
ipcMain.on('heap:keep-awake-state', (e) => { e.returnValue = isAwake(); });
registerTerminal(fromLocalHost);
guardWebviews(() => origin, fromLocalHost);

function createWindow() {
  const state = readState();
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 500,
    title: 'Heap Code',
    backgroundColor: '#111111',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } } : {}),
    ...(state.bounds || {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      // For the Browser view; every attach is vetted in browser.cjs.
      webviewTag: true,
    },
  });
  // No header bar: the page's own left rail is the top-left of the window, so on
  // macOS it gives up a strip for the traffic lights and that strip drags the
  // window. Injected rather than added to web-ui, which is also a plain website.
  if (process.platform === 'darwin') {
    win.webContents.on('dom-ready', () => { win?.webContents.insertCSS(MAC_CHROME_CSS).catch(() => {}); });
  }
  win.on('close', () => { if (!win.isMaximized()) writeState({ ...readState(), bounds: win.getBounds() }); });
  win.on('closed', () => { win = null; });
  // Anything that is not the local host opens in the real browser, never in here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (origin && new URL(url).origin === origin) return;
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
}

async function openFolder(folder) {
  await stopServer();
  writeState({ ...readState(), folder });
  try {
    const url = await startServer(folder);
    origin = new URL(url).origin;
    if (!win) createWindow();
    win.setTitle(`Heap Code — ${path.basename(folder)}`);
    await win.loadURL(url);
  } catch (err) {
    dialog.showErrorBox('Heap Code', err.message || String(err));
    if (!win) app.quit();
  }
}

async function chooseFolder() {
  const r = await dialog.showOpenDialog(win ?? undefined, {
    title: 'Open a project folder',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: readState().folder,
  });
  return r.canceled ? null : r.filePaths[0];
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: async () => { const f = await chooseFolder(); if (f) openFolder(f); } },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    if (!fs.existsSync(CLI_ENTRY)) {
      dialog.showErrorBox('Heap Code', `CLI bundle not found at ${CLI_ENTRY}.\nRun \`pnpm build\` first.`);
      return app.quit();
    }
    buildMenu();
    // Folder: a path passed on the command line, else the last one, else ask.
    const argPath = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && isDir(a));
    let folder = argPath || readState().folder;
    if (!folder || !isDir(folder)) folder = await chooseFolder();
    if (!folder) return app.quit();
    await openFolder(path.resolve(folder));
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; killAllShells(); if (server) { try { server.kill(); } catch {} } });
}
