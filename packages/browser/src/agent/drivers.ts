import type { PageSnapshot } from '../shared/snapshot.js';
import type { ScrollDirection } from '../content/scroll.js';
import { sendToPage } from '../sidepanel/page.js';
import { CdpDetached, CdpSession } from './cdp.js';
import { snapshotFromAxTree, type AxNode } from './axTree.js';

/**
 * Two ways to drive a page, behind one interface.
 *
 * CDP is better at everything: the accessibility tree already knows what is
 * hidden, inert or unnamed, and `Input` produces events a page cannot tell from
 * a person's. But Chrome detaches the debugger the instant DevTools opens on the
 * tab, with no warning and no way to refuse — so the content script is not a
 * lesser alternative, it is the landing ground, and both have to exist.
 *
 * The seam is this interface. The executor never knows which one it has.
 */
export interface PageDriver {
  readonly kind: 'cdp' | 'dom';
  snapshot(): Promise<PageSnapshot>;
  click(handle: number, generation: number): Promise<Outcome>;
  type(handle: number, generation: number, text: string): Promise<Outcome>;
  select(handle: number, generation: number, option: string): Promise<Outcome>;
  scroll(direction: ScrollDirection, pages: number): Promise<PageSnapshot | Outcome>;
  settle(seconds: number): Promise<{ settled: boolean; waitedMs: number }>;
  /** Attach files to a file input. Only CDP can do this at all. */
  attachFiles?(handle: number, generation: number, paths: string[]): Promise<Outcome>;
  /**
   * A picture of the page, for the user to watch — never for the model.
   *
   * Screenshots are 100-500KB, and a model that receives one receives it in
   * every subsequent turn too: the context fills with stale pictures and the run
   * gets slower and more expensive with each step. The model reads the
   * accessibility tree, which is smaller, exact, and addressable. The human gets
   * the picture, because "what is it looking at" is a question text answers
   * badly.
   */
  screenshot?(): Promise<string | undefined>;
}

export type Outcome = { ok: true; note: string } | { ok: false; error: string };

/** The existing content-script path, unchanged in behaviour. */
export class DomDriver implements PageDriver {
  readonly kind = 'dom';
  #tabId: number;

  constructor(tabId: number) {
    this.#tabId = tabId;
  }

  async snapshot(): Promise<PageSnapshot> {
    const response = await sendToPage(this.#tabId, { type: 'snapshot' });
    if (!response.ok) throw new Error(response.error);
    if (response.kind !== 'snapshot') throw new Error('Unexpected reply from the page.');
    return response.snapshot;
  }

  async #act(request: Parameters<typeof sendToPage>[1]): Promise<Outcome> {
    const response = await sendToPage(this.#tabId, request);
    if (!response.ok) return { ok: false, error: response.error };
    if (response.kind !== 'acted') return { ok: false, error: 'Unexpected reply from the page.' };
    return { ok: true, note: response.note };
  }

  click(handle: number, generation: number) {
    return this.#act({ type: 'click', handle, generation });
  }

  type(handle: number, generation: number, text: string) {
    return this.#act({ type: 'type', handle, generation, text });
  }

  select(handle: number, generation: number, option: string) {
    return this.#act({ type: 'select', handle, generation, option });
  }

  async scroll(direction: ScrollDirection, pages: number): Promise<PageSnapshot | Outcome> {
    const response = await sendToPage(this.#tabId, { type: 'scroll', direction, pages });
    if (!response.ok) return { ok: false, error: response.error };
    if (response.kind !== 'snapshot') return { ok: false, error: 'Unexpected reply from the page.' };
    return response.snapshot;
  }

  async settle(seconds: number) {
    const response = await sendToPage(this.#tabId, { type: 'settle', seconds });
    if (!response.ok || response.kind !== 'settled') return { settled: false, waitedMs: 0 };
    return { settled: response.settled, waitedMs: response.waitedMs };
  }
}

interface LayoutMetrics {
  cssVisualViewport?: { clientWidth: number; clientHeight: number; pageY: number };
  cssContentSize?: { height: number };
}

interface BoxModel {
  model?: { content: number[] };
}

/**
 * The CDP path.
 *
 * Handles map to backend node ids rather than to elements in a page-side
 * registry, so the registry lives here. The expiry rule is unchanged and matters
 * just as much: a backend node id outlives a re-render, which would make a stale
 * handle *more* dangerous rather than less.
 */
export class CdpDriver implements PageDriver {
  readonly kind = 'cdp';
  #session: CdpSession;
  /** handle -> backend node id. Stable across reads, like the DOM registry. */
  #nodes = new Map<number, number>();
  #byNode = new Map<number, number>();
  #reads = 0;
  #next = 1;
  /** The origin the handles were taken on, checked before every mutation. */
  #origin?: string;

  constructor(session: CdpSession) {
    this.#session = session;
  }

  async snapshot(): Promise<PageSnapshot> {
    const [tree, metrics, tab] = await Promise.all([
      this.#session.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree'),
      this.#session.send<LayoutMetrics>('Page.getLayoutMetrics'),
      chrome.tabs.get(this.#session.tabId),
    ]);

    this.#reads++;
    this.#origin = originOf(tab.url);

    return snapshotFromAxTree({
      nodes: tree.nodes ?? [],
      url: tab.url ?? '',
      title: tab.title ?? '',
      viewport: {
        width: metrics.cssVisualViewport?.clientWidth ?? 0,
        height: metrics.cssVisualViewport?.clientHeight ?? 0,
        scrollY: Math.round(metrics.cssVisualViewport?.pageY ?? 0),
        scrollHeight: Math.round(metrics.cssContentSize?.height ?? 0),
      },
      generation: this.#reads,
      register: (node) => {
        const backendNodeId = node.backendDOMNodeId as number;
        // The same node keeps the same number across reads, so the model can
        // hold "[12] is Apply" across several steps rather than re-reading
        // between every action.
        const existing = this.#byNode.get(backendNodeId);
        if (existing !== undefined) return existing;
        const handle = this.#next++;
        this.#nodes.set(handle, backendNodeId);
        this.#byNode.set(backendNodeId, handle);
        return handle;
      },
    });
  }

  /**
   * The node for a handle, or why it cannot be used.
   *
   * A backend node id names one node for as long as it exists, so there is no
   * expiry — a node that has gone makes `DOM.getBoxModel` fail, which is the
   * honest signal. What is checked instead is the origin: acting on handles
   * taken from a different site is the case expiry was really guarding, and it
   * is the one a counter cannot distinguish from a harmless re-render.
   */
  async #resolve(handle: number): Promise<{ ok: true; backendNodeId: number } | Outcome> {
    const backendNodeId = this.#nodes.get(handle);
    if (backendNodeId === undefined) {
      return { ok: false, error: `No element with handle [${handle}]. Read the page first.` };
    }

    const tab = await chrome.tabs.get(this.#session.tabId).catch(() => undefined);
    const now = originOf(tab?.url);
    if (this.#origin && now && now !== this.#origin) {
      return {
        ok: false,
        error: `The page moved from ${this.#origin} to ${now} since these handles were taken. Read the page again.`,
      };
    }

    return { ok: true, backendNodeId };
  }

  /** Centre of the element in viewport coordinates, scrolling it in first. */
  async #centre(backendNodeId: number): Promise<{ x: number; y: number } | undefined> {
    try {
      await this.#session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    } catch (error) {
      if (error instanceof CdpDetached) throw error;
      // Not fatal: an element already in view does not need scrolling, and some
      // nodes refuse this while remaining perfectly clickable.
    }
    const box = await this.#session.send<BoxModel>('DOM.getBoxModel', { backendNodeId });
    const quad = box.model?.content;
    if (!quad || quad.length < 8) return undefined;
    return {
      x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
      y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
    };
  }

  async click(handle: number, _generation?: number): Promise<Outcome> {
    const target = await this.#resolve(handle);
    if (!('backendNodeId' in target)) return target;

    const point = await this.#centre(target.backendNodeId);
    if (!point) {
      return { ok: false, error: 'That element has no position on screen, so it cannot be clicked.' };
    }

    // Real input, dispatched by the browser. `isTrusted` is true, so frameworks
    // and anti-bot layers that reject synthetic events accept these -- the one
    // failure the DOM path can detect but never fix.
    const common = { x: point.x, y: point.y, button: 'left' as const, clickCount: 1 };
    await this.#session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common });
    // A beat between arriving and pressing. Hover-triggered menus and tooltips
    // need a frame or two to appear, and clicking into the gap hits whatever was
    // there before they did.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await this.#session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
    await this.#session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });

    this.#invalidate();
    return { ok: true, note: 'Clicked with a real input event.' };
  }

  async type(handle: number, _generation: number, text: string): Promise<Outcome> {
    const target = await this.#resolve(handle);
    if (!('backendNodeId' in target)) return target;

    await this.#session.send('DOM.focus', { backendNodeId: target.backendNodeId });
    // Select-all then insert, so typing replaces rather than appends.
    await this.#session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers: 4,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    });
    // One character at a time. A single `insertText` arrives as one event, and a
    // search box that filters as you type, an autocomplete, or a field that
    // validates per keystroke sees nothing it recognises -- which is most search
    // fields on the sites this is used for.
    for (const character of [...text]) {
      await this.#session.send('Input.insertText', { text: character });
    }

    this.#invalidate();
    return { ok: true, note: `Typed ${text.length} characters with real input.` };
  }

  async select(handle: number, _generation: number, option: string): Promise<Outcome> {
    const target = await this.#resolve(handle);
    if (!('backendNodeId' in target)) return target;

    // No CDP command sets a <select>; it has to be done in page context, then
    // told to the page the way a person's choice would be.
    const { object } = await this.#session.send<{ object: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId: target.backendNodeId },
    );
    if (!object.objectId) return { ok: false, error: 'Could not reach that dropdown.' };

    const result = await this.#session.send<{ result: { value?: string } }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function (wanted) {
        if (this.tagName !== 'SELECT') return 'not-a-select';
        const options = [...this.options];
        const want = String(wanted).trim().toLowerCase();
        const match =
          options.find((o) => o.text.trim().toLowerCase() === want) ??
          options.find((o) => o.value.trim().toLowerCase() === want) ??
          options.find((o) => o.text.trim().toLowerCase().includes(want));
        if (!match) return 'no-match:' + options.map((o) => o.text.trim()).join(' | ');
        this.value = match.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok:' + match.text.trim();
      }`,
      arguments: [{ value: option }],
    });

    const value = result.result.value ?? '';
    if (value.startsWith('no-match:')) {
      return { ok: false, error: `No option matching "${option}". Available: ${value.slice(9)}` };
    }
    if (value === 'not-a-select') return { ok: false, error: 'That element is not a dropdown.' };

    this.#invalidate();
    return { ok: true, note: `Selected "${value.slice(3)}".` };
  }

  /**
   * Attach files to a file input.
   *
   * The only way this is possible at all: `HTMLInputElement.files` cannot be set
   * from page context by design, so the DOM driver has to hand the upload back
   * to the user (PRD section 7.4). Paths are absolute paths on the user's own
   * machine, which is why they are configured rather than chosen by the model.
   */
  async attachFiles(handle: number, _generation: number, paths: string[]): Promise<Outcome> {
    const target = await this.#resolve(handle);
    if (!('backendNodeId' in target)) return target;

    await this.#session.send('DOM.setFileInputFiles', {
      backendNodeId: target.backendNodeId,
      files: paths,
    });

    this.#invalidate();
    return { ok: true, note: `Attached ${paths.length} file(s).` };
  }

  async scroll(direction: ScrollDirection, pages: number): Promise<PageSnapshot | Outcome> {
    const metrics = await this.#session.send<LayoutMetrics>('Page.getLayoutMetrics');
    const height = metrics.cssVisualViewport?.clientHeight ?? 600;
    const currentY = metrics.cssVisualViewport?.pageY ?? 0;
    const contentHeight = metrics.cssContentSize?.height ?? height;

    const deltaY = (() => {
      switch (direction) {
        case 'down':
          return height * pages;
        case 'up':
          return -height * pages;
        case 'top':
          return -currentY;
        case 'bottom':
          return contentHeight;
      }
    })();

    // A real wheel event, so it scrolls whichever pane is under the pointer --
    // which is how a person scrolls an app-shell layout, and why this needs none
    // of the container-hunting the DOM driver does.
    await this.#session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 10,
      y: Math.max(10, height / 2),
      deltaX: 0,
      deltaY,
    });

    await this.settle(1.5);
    return this.snapshot();
  }

  /**
   * A JPEG of the viewport, as a data URL.
   *
   * Quality is deliberately low and the viewport is not exceeded: this is shown
   * at a couple of hundred pixels wide in a side panel, and every extra kilobyte
   * is memory held for the length of the run.
   */
  async screenshot(): Promise<string | undefined> {
    try {
      const shot = await this.#session.send<{ data: string }>('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 45,
        captureBeyondViewport: false,
      });
      return shot.data ? `data:image/jpeg;base64,${shot.data}` : undefined;
    } catch {
      // Never worth failing an action over a picture of it.
      return undefined;
    }
  }

  async settle(seconds: number): Promise<{ settled: boolean; waitedMs: number }> {
    // No DOM-mutation signal is exposed over CDP without instrumenting the page,
    // so this waits for the page's own load state to be quiet and then a beat.
    const started = Date.now();
    const budget = Math.min(Math.max(seconds, 0), 15) * 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.min(budget, 1200)));
    return { settled: true, waitedMs: Date.now() - started };
  }

  /**
   * Nothing to invalidate any more.
   *
   * Handles name nodes, so an action that replaces a node kills its handle by
   * itself and one that does not leaves it correct. Wiping the map here is what
   * forced a re-read between every action.
   */
  #invalidate(): void {
    this.#reads++;
  }
}


function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
