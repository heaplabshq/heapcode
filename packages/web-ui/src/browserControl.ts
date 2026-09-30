import type { UiBrowserParams, UiBrowserResult } from '@heapcode/web-host/protocol';
import { NOT_LOCAL_MESSAGE, isLocalPage } from '@heapcode/web-host/browserTools';

/**
 * The seam between the agent's browser_* tools and the Browser view.
 *
 * The host's `ui/browser` request arrives at App, but the thing that can
 * answer it is a <webview> deep inside the panel — which may not even be
 * mounted yet, if the panel was closed. So the view registers a controller
 * here while it is mounted, and App opens the panel and waits for one.
 */
export interface BrowserController {
  /** Navigate and resolve once the page finished (or failed) loading. */
  open(url: string): Promise<UiBrowserResult>;
  snapshot(): Promise<UiBrowserResult>;
  screenshot(): Promise<UiBrowserResult>;
  console(): Promise<UiBrowserResult>;
  /** Act on an element numbered by the last snapshot, with real input events. */
  click(ref: string): Promise<UiBrowserResult>;
  type(ref: string, text: string, opts: { clear: boolean; submit: boolean }): Promise<UiBrowserResult>;
  select(ref: string, option: string): Promise<UiBrowserResult>;
  press(key: string): Promise<UiBrowserResult>;
  /** Where the view is right now, without touching it. */
  where(): string;
}

let current: BrowserController | undefined;
const waiting = new Set<(c: BrowserController) => void>();

export function registerBrowser(c: BrowserController): () => void {
  current = c;
  for (const resolve of waiting) resolve(c);
  waiting.clear();
  return () => {
    if (current === c) current = undefined;
  };
}

/** The mounted view's controller, waiting up to `timeoutMs` for one to appear. */
export function browserController(timeoutMs = 10_000): Promise<BrowserController> {
  if (current) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const done = (c: BrowserController): void => {
      clearTimeout(timer);
      resolve(c);
    };
    const timer = setTimeout(() => {
      waiting.delete(done);
      reject(new Error('The Browser pane did not open.'));
    }, timeoutMs);
    waiting.add(done);
  });
}

/**
 * Answer one `ui/browser` (Heap Code) or `chat/browser` (Heap Chat) request.
 * The caller opens its panel on the Browser view first, so the view exists and
 * the person watches what the agent is doing.
 *
 * Checked here as well as in the host: the host's check runs on the answer,
 * and for an action that is after the click has happened — the person may
 * have navigated the pane anywhere since the last tool call. `actions: false`
 * is Heap Chat, which never touches a page.
 */
export async function answerBrowserRequest(
  params: UiBrowserParams,
  opts: { actions: boolean },
): Promise<UiBrowserResult> {
  const browser = await browserController();
  if (params.action !== 'open' && !isLocalPage(browser.where())) {
    throw new Error(`The Browser pane is on ${browser.where() || 'no page'}. ${NOT_LOCAL_MESSAGE}`);
  }
  const ref = params.ref ?? '';
  const acting = !['open', 'snapshot', 'screenshot', 'console'].includes(params.action);
  if (acting && !opts.actions) throw new Error(`${params.action} is not available here — this assistant only reads pages.`);
  const res = await (() => {
    switch (params.action) {
      case 'open':
        return browser.open(params.url ?? '');
      case 'snapshot':
        return browser.snapshot();
      case 'screenshot':
        return browser.screenshot();
      case 'console':
        return browser.console();
      case 'click':
        return browser.click(ref);
      case 'type':
        return browser.type(ref, params.text ?? '', { clear: params.clear !== false, submit: params.submit === true });
      case 'select':
        return browser.select(ref, params.option ?? '');
      case 'press':
        return browser.press(params.key ?? '');
    }
  })();
  // Never this page: it holds the socket that runs commands.
  if (res.url.startsWith(location.origin)) throw new Error('The Browser pane is showing Heap Code itself.');
  return res;
}
