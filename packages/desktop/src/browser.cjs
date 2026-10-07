// The integrated browser: a <webview> in the page's Browser view, locked down here.
//
// A <webview> rather than a native WebContentsView because the page has things
// that open over the panel — the ⋮ menu, the command palette, Settings — and a
// native view always paints above the DOM, so it would cover all of them. A
// <webview> is an element, and stacks like one.
//
// The cost of enabling the tag is that any <webview> the page creates gets a
// full browser. So every attach is vetted here: only our own page may attach
// one, it gets no preload and no Node, it lives in its own session (none of
// the person's cookies, none of the app's), and it may only load web URLs.
const { app, ipcMain, shell, webContents } = require('electron');

const PARTITION = 'persist:heapcode-browser';
const WEB = /^(https?:|about:blank)/;

/** Screenshots are scaled to this width: enough to judge a layout, not a 4K payload per call. */
const SHOT_WIDTH = 1280;

/** Our own page's webview, by id — or an error. Nothing else may be driven. */
function guestOf(e, id) {
  const guest = webContents.fromId(Number(id));
  if (!guest || guest.getType() !== 'webview' || guest.hostWebContents !== e.sender) {
    throw new Error('No browser page to act on.');
  }
  return guest;
}

/**
 * Keys the agent may press, as Electron accelerator key codes. A closed list:
 * anything else is typed as text, never sent as a raw key.
 */
const KEYS = new Map(
  Object.entries({
    enter: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete',
    space: 'Space', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
    up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
    pageup: 'PageUp', pagedown: 'PageDown',
  }),
);
const MODIFIERS = new Map(Object.entries({ control: 'control', ctrl: 'control', shift: 'shift', alt: 'alt', meta: 'meta', cmd: 'meta' }));

/** "Shift+Tab", "Control+a", "Enter" → [keyCode, modifiers], or null. */
function parseKey(spec) {
  const parts = String(spec).split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const modifiers = [];
  for (const p of parts) {
    const m = MODIFIERS.get(p.toLowerCase());
    if (!m) return null;
    modifiers.push(m);
  }
  const named = KEYS.get(key.toLowerCase());
  if (named) return [named, modifiers];
  // A single character, only with a modifier (Control+a); bare characters are text.
  if (key.length === 1 && modifiers.length) return [key.toLowerCase(), modifiers];
  return null;
}

/**
 * @param {() => string | null} hostOrigin the local Heap Code page's origin
 * @param {(e: Electron.IpcMainInvokeEvent) => boolean} trusted
 */
function guardWebviews(hostOrigin, trusted) {
  // browser_screenshot. In the main process because capturing needs the
  // guest's WebContents, which the page can only name by id — so the id is
  // checked to be a webview hosted by the very page asking, not any contents.
  ipcMain.handle('heap:browser-capture', async (e, id) => {
    if (!trusted(e)) throw new Error('not allowed');
    const guest = guestOf(e, id);
    let image = await guest.capturePage();
    if (image.isEmpty()) throw new Error('The page has not painted yet (is the window hidden or minimised?).');
    if (image.getSize().width > SHOT_WIDTH) image = image.resize({ width: SHOT_WIDTH, quality: 'good' });
    return `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}`;
  });

  // The agent's browser_click / browser_type / browser_press. Real input events
  // into the guest, not element.click() from script: a page cannot tell these
  // from a person's, so what the agent tests is what a person would get.
  ipcMain.handle('heap:browser-input', async (e, id, action) => {
    if (!trusted(e)) throw new Error('not allowed');
    const guest = guestOf(e, id);
    if (action.kind === 'click') {
      const x = Math.round(Number(action.x));
      const y = Math.round(Number(action.y));
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('bad coordinates');
      guest.focus();
      guest.sendInputEvent({ type: 'mouseMove', x, y });
      guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      return true;
    }
    if (action.kind === 'text') {
      guest.focus();
      await guest.insertText(String(action.text ?? ''));
      return true;
    }
    if (action.kind === 'key') {
      const parsed = parseKey(action.key);
      if (!parsed) throw new Error(`Unknown key "${action.key}". Use e.g. Enter, Tab, Escape, ArrowDown, Shift+Tab, Control+a.`);
      const [keyCode, modifiers] = parsed;
      guest.focus();
      guest.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      // A char event is what makes Enter submit and Space toggle, as a real keypress would.
      if (keyCode === 'Enter' || keyCode === 'Space') guest.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ', modifiers });
      guest.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      return true;
    }
    throw new Error('unknown input');
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event, prefs, params) => {
      let from = null;
      try { from = new URL(contents.getURL()).origin; } catch {}
      if (!from || from !== hostOrigin() || !WEB.test(params.src || 'about:blank')) {
        event.preventDefault();
        return;
      }
      delete prefs.preload;
      prefs.nodeIntegration = false;
      prefs.nodeIntegrationInSubFrames = false;
      prefs.contextIsolation = true;
      prefs.sandbox = true;
      prefs.webSecurity = true;
      prefs.allowRunningInsecureContent = false;
      params.partition = PARTITION;
    });

    if (contents.getType() !== 'webview') return;
    // Popups (target=_blank, window.open) stay in the pane rather than
    // spawning bare Electron windows; a non-web scheme goes to the OS.
    contents.setWindowOpenHandler(({ url }) => {
      if (WEB.test(url)) contents.loadURL(url);
      else shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      if (!WEB.test(url)) { e.preventDefault(); shell.openExternal(url).catch(() => {}); }
    });
  });
}

module.exports = { guardWebviews, PARTITION };
