import type { RecordedTarget } from '@heapcode/page/recording';
import { TEST_ID_ATTRS, type DomTree } from '@heapcode/page/tree';
import {
  DEFAULT_TIMEOUT,
  isAllowedTarget,
  notAllowedMessage,
  type ConsoleLine,
  type Driver,
  type FailedRequest,
  type PageInfo,
  type Probe,
  type RecordListener,
  type Target,
} from '@heapcode/qa';
import type { Browser, BrowserContext, ElementHandle, Locator, Page } from 'playwright-core';
import { INSPECT_BUNDLE, RECORDER_BUNDLE } from './inspectBundle.generated.js';

export interface LaunchOptions {
  /**
   * `chrome` / `msedge`: the browser already installed on the machine — no
   * download. `chromium`: Playwright's own build (`heapcode qa install`).
   * Default: chrome, falling back to chromium.
   */
  channel?: 'chrome' | 'msedge' | 'chromium';
  headless?: boolean;
  /** Per-action timeout in ms. */
  timeout?: number;
  /** Non-local origins the driver may open — `heapqa.yaml`'s `targets`. */
  targets?: readonly string[];
  viewport?: { width: number; height: number };
  /**
   * Let Playwright close the browser and exit on Ctrl+C (its default). The
   * recorder turns this off: there, Ctrl+C means "finish and save".
   */
  exitOnSigint?: boolean;
}

export class BrowserMissingError extends Error {
  constructor(cause: string) {
    super(
      'No browser to test with. Heap QA uses an installed Google Chrome or Microsoft Edge, ' +
        'or its own Chromium — install that with `heapcode qa install`.\n' +
        `(${cause.split('\n')[0]})`,
    );
  }
}

/**
 * The `Driver` on Playwright.
 *
 * Its own browser profile every launch: none of the person's cookies, none of
 * their logins — a test starts from what a new visitor sees, every time.
 * `@heapcode/page`'s inspect script is installed into every frame before the
 * page's own scripts run, so `inspect()` is always available.
 */
export class PlaywrightDriver implements Driver {
  private consoleLines: ConsoleLine[] = [];
  private failed: FailedRequest[] = [];
  private lastTitle = '';

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly targets: readonly string[],
  ) {
    page.on('console', (msg) => {
      // The browser asks every site for /favicon.ico by itself; a 404 there is
      // not the app's doing, and counting it fails nearly every app's
      // "no console errors" check.
      if (isFavicon(msg.location().url)) return;
      const type = msg.type();
      const level = type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
      const loc = msg.location();
      this.consoleLines.push({ level, message: msg.text(), ...(loc.url ? { source: `${loc.url}:${loc.lineNumber}` } : {}) });
    });
    // An uncaught exception is the page's most serious console error.
    page.on('pageerror', (err) => this.consoleLines.push({ level: 'error', message: `Uncaught ${err.name}: ${err.message}` }));
    page.on('requestfailed', (req) => {
      if (isFavicon(req.url())) return;
      this.failed.push({ url: req.url(), method: req.method(), error: req.failure()?.errorText ?? 'failed' });
    });
    page.on('response', (res) => {
      if (res.status() >= 400 && !isFavicon(res.url())) this.failed.push({ url: res.url(), method: res.request().method(), status: res.status() });
    });
  }

  static async launch(options: LaunchOptions = {}): Promise<PlaywrightDriver> {
    const browser = await launchBrowser(options.channel ?? 'chrome', options.headless ?? true, options.exitOnSigint ?? true);
    const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 } });
    context.setDefaultTimeout(options.timeout ?? DEFAULT_TIMEOUT);
    await context.addInitScript({ content: INSPECT_BUNDLE });
    const page = await context.newPage();
    return new PlaywrightDriver(browser, context, page, options.targets ?? []);
  }

  async open(url: string): Promise<PageInfo> {
    if (!isAllowedTarget(url, this.targets)) throw new Error(notAllowedMessage(url));
    await this.page.goto(url, { waitUntil: 'load' });
    // A redirect can land somewhere nobody listed.
    if (!isAllowedTarget(this.page.url(), this.targets)) throw new Error(notAllowedMessage(this.page.url()));
    this.lastTitle = await this.page.title();
    return this.current();
  }

  /** The title as of the last `open` — `current()` is synchronous, and a title needs a round trip. */
  current(): PageInfo {
    return { url: this.page.url(), title: this.lastTitle };
  }

  async inspect(): Promise<DomTree> {
    await this.ensureInspector();
    return this.page.evaluate(() => (globalThis as unknown as { __heapqa: { inspect(): DomTree } }).__heapqa.inspect());
  }

  async count(probe: Probe): Promise<number> {
    return this.locator(probe).count();
  }

  async click(target: Target): Promise<void> {
    await this.withTarget(target, (t) => t.click());
  }

  async type(target: Target, text: string, options: { clear: boolean }): Promise<void> {
    await this.withTarget(target, async (t) => {
      if (options.clear) return t.fill(text);
      // Appending is typing key by key, as a person would after the existing text.
      if ('pressSequentially' in t) return t.pressSequentially(text);
      return t.type(text);
    });
  }

  async select(target: Target, option: string): Promise<void> {
    await this.withTarget(target, async (t) => {
      try {
        await t.selectOption({ label: option });
      } catch {
        await t.selectOption({ value: option });
      }
    });
  }

  async press(key: string, target?: Target): Promise<void> {
    if (target) await this.withTarget(target, (t) => t.press(key));
    else await this.page.keyboard.press(key);
  }

  async textOf(target: Target): Promise<string> {
    return this.withTarget(target, async (t) => ((await t.innerText()) ?? '').replace(/\s+/g, ' ').trim());
  }

  async isVisible(target: Target): Promise<boolean> {
    return this.withTarget(target, (t) => t.isVisible());
  }

  async screenshot(): Promise<Uint8Array> {
    return this.page.screenshot({ type: 'png' });
  }

  drainConsole(): ConsoleLine[] {
    const out = this.consoleLines;
    this.consoleLines = [];
    return out;
  }

  drainFailedRequests(): FailedRequest[] {
    const out = this.failed;
    this.failed = [];
    return out;
  }

  async startTrace(): Promise<void> {
    await this.context.tracing.start({ screenshots: true, snapshots: true });
  }

  async stopTrace(path: string | undefined): Promise<void> {
    await this.context.tracing.stop(path ? { path } : {});
  }

  async describeTarget(target: Target): Promise<RecordedTarget | undefined> {
    if ('nodeId' in target) return this.describe(target.nodeId);
    await this.ensureInspector();
    const found = this.locator(target.probe).nth(target.index);
    return (await found.evaluate((el) => (globalThis as unknown as { __heapqa: { describeElement(el: unknown): unknown } }).__heapqa.describeElement(el))) as RecordedTarget;
  }

  async settle(): Promise<void> {
    // A click's navigation starts a moment after the click returns; give it
    // that moment, then wait for whatever it started to load.
    await new Promise((r) => setTimeout(r, 200));
    await this.page.waitForLoadState('load').catch(() => {});
  }

  async describe(nodeId: number): Promise<RecordedTarget | undefined> {
    await this.ensureInspector();
    const target = await this.page.evaluate(
      (id) => (globalThis as unknown as { __heapqa: { describe(id: number): unknown } }).__heapqa.describe(id),
      nodeId,
    );
    return (target ?? undefined) as RecordedTarget | undefined;
  }

  async record(listener: RecordListener): Promise<() => Promise<void>> {
    let total = 0;
    let stopped = false;
    // A binding survives navigations, and the init script re-installs the
    // recorder on every page, so recording follows the person across the site.
    await this.context.exposeBinding('__heapqaRecord', (_source, event: { kind: string }) => {
      if (stopped) return total;
      if (event.kind === 'count') return total;
      total = listener.event(event as Parameters<RecordListener['event']>[0]);
      return total;
    });
    await this.context.addInitScript({ content: RECORDER_BUNDLE });
    const onNavigate = (frame: import('playwright-core').Frame): void => {
      if (!stopped && frame === this.page.mainFrame()) listener.navigated(frame.url());
    };
    const onClose = (): void => {
      if (!stopped) listener.closed();
    };
    this.page.on('framenavigated', onNavigate);
    this.page.on('close', onClose);
    return async () => {
      stopped = true;
      this.page.off('framenavigated', onNavigate);
      this.page.off('close', onClose);
    };
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }

  /** A Playwright locator for one strategy. Exact matching: a test means the words it recorded. */
  locator(probe: Probe): Locator {
    switch (probe.strategy) {
      case 'testId':
        return this.page.locator(TEST_ID_ATTRS.map((a) => `[${a}="${cssString(probe.testId)}"]`).join(', '));
      case 'role':
        return this.page.getByRole(probe.role as Parameters<Page['getByRole']>[0], {
          ...(probe.name !== undefined ? { name: probe.name, exact: true } : {}),
        });
      case 'label':
        return this.page.getByLabel(probe.label, { exact: true });
      case 'placeholder':
        return this.page.getByPlaceholder(probe.placeholder, { exact: true });
      case 'text':
        return this.page.getByText(probe.text, { exact: true });
      case 'css':
        return this.page.locator(probe.css);
    }
  }

  private async withTarget<T>(target: Target, act: (t: Locator | ElementHandle) => Promise<T>): Promise<T> {
    if ('probe' in target) return act(this.locator(target.probe).nth(target.index));
    await this.ensureInspector();
    const handle = await this.page.evaluateHandle(
      (id) => (globalThis as unknown as { __heapqa: { element(id: number): unknown } }).__heapqa.element(id),
      target.nodeId,
    );
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      throw new Error(`Node ${target.nodeId} is no longer on the page — inspect it again.`);
    }
    try {
      return await act(element);
    } finally {
      await element.dispose();
    }
  }

  /** The init script covers every navigation; this covers a page opened before it was added. */
  private async ensureInspector(): Promise<void> {
    const present = await this.page.evaluate(() => '__heapqa' in globalThis);
    if (!present) await this.page.addScriptTag({ content: INSPECT_BUNDLE });
  }
}

async function launchBrowser(channel: 'chrome' | 'msedge' | 'chromium', headless: boolean, handleSIGINT: boolean): Promise<Browser> {
  // Loaded on first launch, not at import: the CLI carries Heap QA in the same
  // bundle as everything else, and playwright-core is an optional dependency
  // there — a static import would make every `heapcode` command need it.
  let chromium: typeof import('playwright-core').chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error('Heap QA needs the playwright-core package, which is not installed. Reinstall Heap Code, or run `npm install -g playwright-core`.');
  }
  if (channel !== 'chromium') {
    try {
      return await chromium.launch({ channel, headless, handleSIGINT });
    } catch {
      // Not installed — fall back to Playwright's own build below.
    }
  }
  try {
    return await chromium.launch({ headless, handleSIGINT });
  } catch (err) {
    throw new BrowserMissingError(err instanceof Error ? err.message : String(err));
  }
}

function isFavicon(url: string): boolean {
  try {
    return new URL(url).pathname === '/favicon.ico';
  } catch {
    return false;
  }
}

function cssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
