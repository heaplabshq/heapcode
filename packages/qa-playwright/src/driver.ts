import { TEST_ID_ATTRS, type DomTree } from '@heapcode/page';
import {
  DEFAULT_TIMEOUT,
  isAllowedTarget,
  notAllowedMessage,
  type ConsoleLine,
  type Driver,
  type FailedRequest,
  type PageInfo,
  type Probe,
  type Target,
} from '@heapcode/qa';
import { chromium, type Browser, type BrowserContext, type ElementHandle, type Locator, type Page } from 'playwright-core';
import { INSPECT_BUNDLE } from './inspectBundle.generated.js';

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
      const type = msg.type();
      const level = type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
      const loc = msg.location();
      this.consoleLines.push({ level, message: msg.text(), ...(loc.url ? { source: `${loc.url}:${loc.lineNumber}` } : {}) });
    });
    // An uncaught exception is the page's most serious console error.
    page.on('pageerror', (err) => this.consoleLines.push({ level: 'error', message: `Uncaught ${err.name}: ${err.message}` }));
    page.on('requestfailed', (req) => {
      this.failed.push({ url: req.url(), method: req.method(), error: req.failure()?.errorText ?? 'failed' });
    });
    page.on('response', (res) => {
      if (res.status() >= 400) this.failed.push({ url: res.url(), method: res.request().method(), status: res.status() });
    });
  }

  static async launch(options: LaunchOptions = {}): Promise<PlaywrightDriver> {
    const browser = await launchBrowser(options.channel ?? 'chrome', options.headless ?? true);
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

  private async withTarget<T>(target: Target, act: (t: Locator | ElementHandle<Element>) => Promise<T>): Promise<T> {
    if ('probe' in target) return act(this.locator(target.probe).nth(target.index));
    await this.ensureInspector();
    const handle = await this.page.evaluateHandle(
      (id) => (globalThis as unknown as { __heapqa: { element(id: number): Element | null } }).__heapqa.element(id),
      target.nodeId,
    );
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      throw new Error(`Node ${target.nodeId} is no longer on the page — inspect it again.`);
    }
    try {
      return await act(element as ElementHandle<Element>);
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

async function launchBrowser(channel: 'chrome' | 'msedge' | 'chromium', headless: boolean): Promise<Browser> {
  if (channel !== 'chromium') {
    try {
      return await chromium.launch({ channel, headless });
    } catch {
      // Not installed — fall back to Playwright's own build below.
    }
  }
  try {
    return await chromium.launch({ headless });
  } catch (err) {
    throw new BrowserMissingError(err instanceof Error ? err.message : String(err));
  }
}

function cssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
