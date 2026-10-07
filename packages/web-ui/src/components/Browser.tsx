import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { S } from './icons.js';
import type { WebviewElement } from '../webview.js';
import type { UiBrowserResult } from '@heapcode/web-host/protocol';
import { registerBrowser } from '../browserControl.js';
import { desktopBridge } from '../desktop.js';

type ConsoleLine = NonNullable<UiBrowserResult['console']>[number];
/** How long the agent waits for a page before it is told it did not load. */
const LOAD_TIMEOUT_MS = 20_000;
const CONSOLE_KEEP = 200;

/**
 * The Browser view — desktop app only.
 *
 * For looking at what you are building next to the conversation about it: the
 * dev server, a docs page, the PR. It is an Electron <webview>, vetted in the
 * main process (desktop/src/browser.cjs): its own session, no Node, web URLs
 * only. The agent can open local pages here and read them — see
 * browserControl.ts and web-host's browserTools.ts — but not act on them yet.
 *
 * `localUrls` are dev-server addresses the shells and the agent's commands
 * printed, offered so opening one is a click rather than a copy-paste.
 */
export interface BrowserProps {
  localUrls: string[];
}

const LAST_URL_KEY = 'heapcode.browserUrl';

export function Browser({ localUrls }: BrowserProps): JSX.Element {
  const view = useRef<WebviewElement | null>(null);
  /** The first URL, fixed at mount: later navigation goes through loadURL, not src. */
  const [startUrl, setStartUrl] = useState<string | undefined>(() => readLastUrl());
  const [address, setAddress] = useState(startUrl ?? '');
  const [editing, setEditing] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false, loading: false, title: '' });
  const [failure, setFailure] = useState<string>();
  // Read inside the event handlers without re-subscribing every keystroke.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  /** What the page logged since its last navigation — for browser_console. */
  const consoleLines = useRef<ConsoleLine[]>([]);
  /** Why the current load failed, if it did — reset when a load starts. */
  const loadError = useRef<string>();
  /** The guest has had its first dom-ready, so its methods may be called. */
  const ready = useRef(false);
  /** Agent calls waiting for the page in flight to finish loading. */
  const loadWaiters = useRef(new Set<() => void>());

  const go = useCallback((raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) return;
    setFailure(undefined);
    setAddress(url);
    setEditing(false);
    rememberUrl(url);
    const w = view.current;
    if (!w) setStartUrl(url);
    // loadURL throws — synchronously — until the guest's first dom-ready.
    // Before that, pointing `src` elsewhere is the navigation that is allowed.
    else if (!ready.current) w.setAttribute('src', url);
    else void w.loadURL(url).catch(() => undefined);
  }, []);

  // Wire the webview's events once it exists. It is created on the first
  // navigation, so this re-runs when `startUrl` first gets a value.
  useEffect(() => {
    const w = view.current;
    if (!w) return;
    const sync = (): void => {
      try {
        setNav({ back: w.canGoBack(), forward: w.canGoForward(), loading: w.isLoading(), title: w.getTitle() });
        const url = w.getURL();
        if (url && url !== 'about:blank') {
          rememberUrl(url);
          setAddress((prev) => (editingRef.current ? prev : url));
        }
      } catch {
        /* not attached yet — the next event will sync */
      }
    };
    const onFail = (e: Event): void => {
      const { errorCode, errorDescription, validatedURL, isMainFrame } = e as Event & {
        errorCode: number;
        errorDescription: string;
        validatedURL: string;
        isMainFrame: boolean;
      };
      // -3 is ERR_ABORTED: a navigation replaced by another, not a failure.
      if (!isMainFrame || errorCode === -3) return;
      loadError.current = errorDescription || `error ${errorCode}`;
      setFailure(`${validatedURL} — ${loadError.current}`);
    };
    const onStart = (): void => setFailure(undefined);
    const onReady = (): void => {
      ready.current = true;
    };
    const onLoading = (): void => {
      loadError.current = undefined;
    };
    const onStopped = (): void => {
      for (const done of loadWaiters.current) done();
      loadWaiters.current.clear();
    };
    const onNavigated = (): void => {
      // A new document: what the old one logged is not this one's problem.
      consoleLines.current = [];
    };
    const onConsole = (e: Event): void => {
      const { level, message, sourceId, line } = e as Event & {
        level: number;
        message: string;
        sourceId?: string;
        line?: number;
      };
      // Electron's own development warnings (the insecure-CSP one) are logged
      // into every guest from its internal bundle. They are about the shell,
      // not the page — an agent reading them concluded the site under test
      // "is an Electron app". Dropped at the source.
      if (sourceId?.startsWith('node:electron')) return;
      const entry: ConsoleLine = {
        level: level >= 3 ? 'error' : level === 2 ? 'warning' : 'info',
        message: String(message).slice(0, 2_000),
        source: sourceId ? `${sourceId.replace(/^https?:\/\/[^/]+/, '')}${line ? `:${line}` : ''}` : undefined,
      };
      consoleLines.current = [...consoleLines.current, entry].slice(-CONSOLE_KEEP);
    };
    w.addEventListener('dom-ready', onReady);
    w.addEventListener('did-start-loading', onLoading);
    w.addEventListener('did-stop-loading', onStopped);
    w.addEventListener('did-navigate', onNavigated);
    w.addEventListener('console-message', onConsole);
    const events = ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated', 'dom-ready'];
    for (const name of events) w.addEventListener(name, sync);
    w.addEventListener('did-fail-load', onFail);
    w.addEventListener('did-start-navigation', onStart);
    return () => {
      for (const name of events) w.removeEventListener(name, sync);
      w.removeEventListener('did-fail-load', onFail);
      w.removeEventListener('did-start-navigation', onStart);
      w.removeEventListener('dom-ready', onReady);
      w.removeEventListener('did-start-loading', onLoading);
      w.removeEventListener('did-stop-loading', onStopped);
      w.removeEventListener('did-navigate', onNavigated);
      w.removeEventListener('console-message', onConsole);
    };
  }, [startUrl]);

  // What the agent's browser_* tools call (browserControl.ts). Registered for
  // as long as this view is mounted; everything goes through refs so the
  // controller is built once.
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const here = (): UiBrowserResult => {
      const w = view.current;
      try {
        return { url: w?.getURL() ?? '', title: w?.getTitle() };
      } catch {
        return { url: '' };
      }
    };
    const needPage = (): WebviewElement => {
      if (!view.current) throw new Error('Nothing is open in the Browser pane. Use browser_open first.');
      return view.current;
    };
    return registerBrowser({
      open: (url) =>
        new Promise<UiBrowserResult>((resolve) => {
          let settled = false;
          const finish = (timedOut: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            loadWaiters.current.delete(onDone);
            resolve({ ...here(), loadError: timedOut ? 'timed out waiting for the page to load' : loadError.current });
          };
          const onDone = (): void => finish(false);
          const timer = setTimeout(() => finish(true), LOAD_TIMEOUT_MS);
          loadWaiters.current.add(onDone);
          goRef.current(url);
        }),
      snapshot: async () => {
        const { text, refs } = await needPage().executeJavaScript<{ text: string; refs: Record<string, string> }>(
          SNAPSHOT_SCRIPT,
        );
        return { ...here(), text, refs };
      },
      screenshot: async () => {
        const w = needPage();
        const capture = desktopBridge()?.browser?.capture;
        if (!capture) throw new Error('Screenshots need the Heap Code desktop app.');
        return { ...here(), image: await capture(w.getWebContentsId()) };
      },
      console: () => {
        needPage();
        return Promise.resolve({ ...here(), console: consoleLines.current });
      },
      where: () => here().url,

      click: (ref) =>
        act(async (w, input) => {
          const target = await locate(w, ref);
          await input({ kind: 'click', x: target.x, y: target.y });
          return target.label;
        }),
      type: (ref, text, { clear, submit }) =>
        act(async (w, input) => {
          const target = await locate(w, ref);
          if (!target.editable) throw new Error(`[${ref}] is ${target.label}, which is not a text field.`);
          // A real click to focus, as a person would — some fields only wire
          // up their handlers on focus — then select what is there if it is
          // being replaced, and insert the text as typed input.
          await input({ kind: 'click', x: target.x, y: target.y });
          if (clear) await w.executeJavaScript(selectAllScript(ref));
          await input({ kind: 'text', text });
          if (submit) await input({ kind: 'key', key: 'Enter' });
          return target.label;
        }),
      select: (ref, option) =>
        act(async (w) => {
          // Native <select> popups are drawn by the OS, not the page, so they
          // cannot be clicked through; set the value and fire what a real
          // choice fires instead.
          const r = await w.executeJavaScript<{ ok: boolean; label?: string; reason?: string }>(selectScript(ref, option));
          if (!r.ok) throw new Error(r.reason ?? 'Could not choose that option.');
          return r.label;
        }),
      press: (key) =>
        act(async (_w, input) => {
          await input({ kind: 'key', key });
          return undefined;
        }),
    });

    /**
     * Run one action and wait for the page to settle, reporting console
     * errors that appeared while it did — "the click threw" is usually the
     * finding.
     */
    async function act(
      run: (w: WebviewElement, input: (a: BrowserInput) => Promise<void>) => Promise<string | undefined>,
    ): Promise<UiBrowserResult> {
      const w = needPage();
      const bridge = desktopBridge()?.browser;
      if (!bridge?.input) throw new Error('Acting on pages needs the Heap Code desktop app.');
      const id = w.getWebContentsId();
      const input = async (a: BrowserInput): Promise<void> => {
        await bridge.input(id, a);
      };
      const before = consoleLines.current.length;
      const acted = await run(w, input);
      await settle(w);
      const fresh = consoleLines.current.slice(Math.min(before, consoleLines.current.length));
      const newErrors = fresh.filter((l) => l.level === 'error').map((l) => l.message).slice(0, 10);
      return { ...here(), acted, newErrors };
    }

    /** Give the page a moment; if the action started a navigation, wait for it (bounded). */
    function settle(w: WebviewElement): Promise<void> {
      return new Promise((resolve) => {
        setTimeout(() => {
          let loading = false;
          try {
            loading = w.isLoading();
          } catch {
            /* detached */
          }
          if (!loading) return resolve();
          const timer = setTimeout(done, 10_000);
          function done(): void {
            clearTimeout(timer);
            loadWaiters.current.delete(done);
            setTimeout(resolve, 150);
          }
          loadWaiters.current.add(done);
        }, 350);
      });
    }
  }, []);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    go(address);
    // Enter hands focus to the page, as in any browser — left in the bar, the
    // next click did not select the old address and typing appended to it.
    (document.activeElement as HTMLElement | null)?.blur();
    view.current?.focus();
  };

  const offered = localUrls.filter((u) => u !== address);

  return (
    <div className="browser">
      <form className="browser-bar" onSubmit={submit}>
        <button type="button" className="icon-btn browser-btn" aria-label="Back" disabled={!nav.back} onClick={() => view.current?.goBack()}>
          <svg {...S}><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <button type="button" className="icon-btn browser-btn" aria-label="Forward" disabled={!nav.forward} onClick={() => view.current?.goForward()}>
          <svg {...S}><path d="m9 18 6-6-6-6" /></svg>
        </button>
        <button
          type="button"
          className="icon-btn browser-btn"
          aria-label={nav.loading ? 'Stop' : 'Reload'}
          disabled={!startUrl}
          onClick={() => (nav.loading ? view.current?.stop() : view.current?.reload())}
        >
          {nav.loading ? (
            <svg {...S}><path d="M18 6 6 18M6 6l12 12" /></svg>
          ) : (
            <svg {...S}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
          )}
        </button>
        <input
          className="browser-address"
          value={address}
          placeholder="Enter a URL, or localhost:3000"
          spellCheck={false}
          aria-label="Address"
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          onChange={(e) => setAddress(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn browser-btn"
          aria-label="Open in your browser"
          title="Open in your browser"
          disabled={!startUrl}
          onClick={() => view.current && window.open(view.current.getURL(), '_blank')}
        >
          <svg {...S}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
        </button>
      </form>

      {offered.length > 0 && startUrl && (
        <div className="browser-found" aria-label="Dev servers">
          {offered.slice(-3).map((u) => (
            <button key={u} className="browser-chip" onClick={() => go(u)} title={`Open ${u}`}>
              {shortUrl(u)}
            </button>
          ))}
        </div>
      )}

      <div className="browser-page">
        {startUrl ? (
          <webview
            ref={(el) => {
              view.current = el as WebviewElement | null;
            }}
            src={startUrl}
            allowpopups="true"
            className="browser-webview"
          />
        ) : (
          <div className="browser-start">
            <p>Open your dev server, docs, or anything else beside the chat.</p>
            {localUrls.length > 0 ? (
              <>
                <div className="panel-section">Running here</div>
                <div className="browser-start-list">
                  {[...localUrls].reverse().map((u) => (
                    <button key={u} className="browser-chip" onClick={() => go(u)}>
                      {shortUrl(u)}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="hint">Start a dev server in the Terminal and its address shows up here.</p>
            )}
          </div>
        )}
        {failure && (
          <div className="browser-failure" role="alert">
            <strong>Could not load the page.</strong>
            <span>{failure}</span>
            <button className="link-btn" onClick={() => view.current?.reload()}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Runs inside the page (in the guest, isolated from our own page) and turns it
 * into something a model can read: the parts you would use to find your way —
 * headings, links, buttons, fields — then the visible text. Capped here and
 * again by the host, so a huge page cannot flood the conversation.
 */
const SNAPSHOT_SCRIPT = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  // A <label> that wraps its control also contains the control's own text (a
  // select's options), so read the label with the controls taken out.
  const labelText = (el) => { const lab = el.labels && el.labels[0]; if (!lab) return '';
    const copy = lab.cloneNode(true); copy.querySelectorAll('select,input,textarea,button').forEach((x) => x.remove());
    return copy.textContent; };
  const label = (el) => clean(el.getAttribute('aria-label') || labelText(el)
    || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.id);
  // Numbered afresh on every snapshot: the old numbers are cleared so an
  // element that left the page cannot be acted on by a stale number.
  for (const old of document.querySelectorAll('[data-heap-ref]')) { old.removeAttribute('data-heap-ref'); old.removeAttribute('data-heap-desc'); }
  const refs = {};
  let n = 0;
  const number = (el, desc) => { n += 1; const id = String(n); el.setAttribute('data-heap-ref', id); el.setAttribute('data-heap-desc', desc); refs[id] = desc; return '[' + id + '] ' + desc; };
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[role=switch],[contenteditable=true]';
  const controls = [...document.querySelectorAll(sel)].filter(visible).slice(0, 150).map((el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const text = clean(el.innerText || el.value || '').slice(0, 80);
    if (tag === 'a' || role === 'link') return number(el, 'link "' + (text || label(el)) + '"') + ' -> ' + el.getAttribute('href');
    if (tag === 'select') return number(el, 'dropdown "' + label(el) + '"') + ' = "' + clean(el.selectedOptions[0] && el.selectedOptions[0].text) + '" (options: ' + [...el.options].slice(0, 12).map((o) => clean(o.text)).join(' | ') + ')';
    if (tag === 'textarea' || el.isContentEditable) return number(el, 'textbox "' + label(el) + '"') + (text ? ' = "' + text + '"' : '');
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(type)) return number(el, 'button "' + (clean(el.value) || label(el)) + '"');
      if (type === 'checkbox' || type === 'radio') return number(el, type + ' "' + label(el) + '"') + (el.checked ? ' (checked)' : '');
      const shown = type === 'password' ? (el.value ? '•••' : '') : clean(el.value).slice(0, 80);
      return number(el, (type === 'text' ? 'textbox' : type + ' field') + ' "' + label(el) + '"') + (shown ? ' = "' + shown + '"' : '');
    }
    return number(el, (role || (tag === 'summary' ? 'disclosure' : 'button')) + ' "' + (text || label(el)) + '"') + (el.disabled ? ' (disabled)' : '');
  });
  const parts = [];
  const h = [...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0, 30).map((el) => clean(el.innerText) && el.tagName.toLowerCase() + ': ' + clean(el.innerText)).filter(Boolean);
  if (h.length) parts.push('Headings:\\n' + h.join('\\n'));
  if (controls.length) parts.push('Elements you can act on:\\n' + controls.join('\\n'));
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  parts.push('Text:\\n' + text.slice(0, 8000));
  return { text: parts.join('\\n\\n'), refs };
})()`;

type BrowserInput =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: string };

interface Located {
  x: number;
  y: number;
  label: string;
  editable: boolean;
}

/**
 * Find a snapshot-numbered element, bring it into view, check it can actually
 * be clicked — something else on top of it (a modal, a cookie banner) means a
 * real click would land there instead — and flash an outline on it, so the
 * person watching sees what the agent is about to touch.
 */
async function locate(w: WebviewElement, ref: string): Promise<Located> {
  const r = await w.executeJavaScript<{ ok: boolean; reason?: string } & Partial<Located>>(locateScript(ref));
  if (!r.ok) throw new Error(r.reason ?? `Element [${ref}] was not found.`);
  return r as Located;
}

const js = (v: unknown): string => JSON.stringify(v);

function locateScript(ref: string): string {
  return `(async () => {
    const el = document.querySelector('[data-heap-ref=' + ${js(js(ref))} + ']');
    if (!el) return { ok: false, reason: 'Element [' + ${js(ref)} + '] is not on the page any more — take a new browser_snapshot.' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { ok: false, reason: 'Element [' + ${js(ref)} + '] is not visible.' };
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      const what = (hit.innerText || hit.getAttribute('aria-label') || hit.tagName).toString().replace(/\\s+/g, ' ').trim().slice(0, 60);
      return { ok: false, reason: 'Element [' + ${js(ref)} + '] is covered by another element ("' + what + '") — close it first.' };
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'Element [' + ${js(ref)} + '] is disabled.' };
    const prev = el.style.outline, prevOffset = el.style.outlineOffset;
    el.style.outline = '2px solid #4c8dff'; el.style.outlineOffset = '2px';
    setTimeout(() => { el.style.outline = prev; el.style.outlineOffset = prevOffset; }, 900);
    const tag = el.tagName.toLowerCase();
    const editable = el.isContentEditable || tag === 'textarea' ||
      (tag === 'input' && !['button','submit','reset','checkbox','radio','file','image','range','color','hidden'].includes(el.type));
    return { ok: true, x, y, label: el.getAttribute('data-heap-desc') || tag, editable };
  })()`;
}

function selectAllScript(ref: string): string {
  return `(() => {
    const el = document.querySelector('[data-heap-ref=' + ${js(js(ref))} + ']');
    if (!el) return false;
    el.focus();
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    return true;
  })()`;
}

function selectScript(ref: string, option: string): string {
  return `(() => {
    const el = document.querySelector('[data-heap-ref=' + ${js(js(ref))} + ']');
    if (!el) return { ok: false, reason: 'Element [' + ${js(ref)} + '] is not on the page any more — take a new browser_snapshot.' };
    if (el.tagName !== 'SELECT') return { ok: false, reason: 'Element [' + ${js(ref)} + '] is not a dropdown.' };
    const want = ${js(option)}.trim().toLowerCase();
    const opt = [...el.options].find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want)
      || [...el.options].find((o) => o.text.trim().toLowerCase().includes(want));
    if (!opt) return { ok: false, reason: 'No option like ' + ${js(js(option))} + '. Options: ' + [...el.options].map((o) => o.text.trim()).join(' | ') };
    // Through the prototype setter, so frameworks tracking the value (React) see the change.
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, label: (el.getAttribute('data-heap-desc') || 'dropdown') + ' → "' + opt.text.trim() + '"' };
  })()`;
}

/**
 * What the address bar accepts. A bare `localhost:5173` or `127.0.0.1:8000`
 * is http, since that is what a dev server speaks; a bare domain is https;
 * anything with a space, or without a dot, is a search.
 */
export function normalizeUrl(raw: string): string | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  if (/^(https?:|about:)/i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(text)) {
    return `http://${text.replace(/^0\.0\.0\.0/, 'localhost')}`;
  }
  if (!/\s/.test(text) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text)) return `https://${text}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

function shortUrl(u: string): string {
  return u.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function readLastUrl(): string | undefined {
  try {
    return localStorage.getItem(LAST_URL_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberUrl(url: string): void {
  try {
    localStorage.setItem(LAST_URL_KEY, url);
  } catch {
    /* private mode — the view still works, it just will not reopen here */
  }
}
