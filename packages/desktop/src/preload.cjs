// The little the desktop app adds to the web UI. Kept to named calls rather
// than a raw ipcRenderer, so a page that somehow runs untrusted script gets
// these and nothing else. See web-ui/src/desktop.ts.
const { contextBridge, ipcRenderer } = require('electron');

/** Subscribe to one channel for one shell; returns the unsubscribe. */
const listen = (channel, id, cb) => {
  const handler = (_e, from, payload) => { if (from === id) cb(payload); };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('heapDesktop', {
  keepAwake: (on) => ipcRenderer.invoke('heap:keep-awake', Boolean(on)),
  keepAwakeState: () => ipcRenderer.sendSync('heap:keep-awake-state'),
  terminal: {
    open: (cwd, cols, rows) => ipcRenderer.invoke('heap:term-open', { cwd, cols, rows }),
    write: (id, data) => ipcRenderer.send('heap:term-write', id, String(data)),
    resize: (id, cols, rows) => ipcRenderer.send('heap:term-resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('heap:term-kill', id),
    onData: (id, cb) => listen('heap:term-data', id, cb),
    onExit: (id, cb) => listen('heap:term-exit', id, cb),
  },
});
