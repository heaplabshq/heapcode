import type { PageSnapshot } from '../shared/snapshot.js';
import type { ScrollDirection } from '../content/scroll.js';
import { listFrames, sendToPage } from '../sidepanel/page.js';
import {
  bandOf,
  baseForBand,
  labelForFrame,
  mergeFrameSnapshots,
  type FramePart,
} from '../shared/frames.js';
import { CdpDetached, CdpSession, frameList } from './cdp.js';
import { snapshotFromAxTree, type AxNode } from './axTree.js';
import { pageFacts } from './domFacts.js';
import { describeKey, keySpec, modifierMask, selectAllModifier, type KeyPress } from './keys.js';

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
  /** Move the pointer onto an element, for menus and tooltips that open on it. */
  hover(handle: number, generation: number): Promise<Outcome>;
  /**
   * Press a key, optionally after focusing an element.
   *
   * Both drivers offer this, but they are not equally good at it and the note
   * that comes back says so: only CDP produces a key event the browser itself
   * acts on, so only CDP can press Enter to submit a plain HTML form or Tab to
   * move focus.
   */
  press(press: KeyPress, handle?: number, generation?: number): Promise<Outcome>;
  scroll(direction: ScrollDirection, pages: number): Promise<PageSnapshot | Outcome>;
  settle(seconds: number): Promise<{ settled: boolean; waitedMs: number }>;
  /** Drag one element onto another. Needs real pointer input, so CDP only. */
  drag?(from: number, to: number, generation: number): Promise<Outcome>;
  /** Attach files to a file input. Only CDP can do this at all. */
  attachFiles?(handle: number, generation: number, paths: string[]): Promise<Outcome>;
  /**
   * Which frame of the tab a handle belongs to.
   *
   * For the messages the panel sends to the page directly rather than through
   * the driver -- the confirmation outline. Only the DOM driver bands its
   * handles by frame; CDP handles are backend node ids, unique across the whole
   * tab, so it does not implement this and the caller falls back to frame 0.
   */
  frameOf?(handle: number | undefined): number | undefined;
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

/**
 * The content-script path.
 *
 * It also owns the frames now. The top frame used to gather its children over
 * `postMessage` and hand back one merged page; that channel could be answered
 * by any script in a frame, including the page's own in a frame we hold no
 * permission for, so the gathering moved here where each frame can be addressed
 * over the extension's own channel. See `shared/frames.ts`.
 */
export class DomDriver implements PageDriver {
  readonly kind = 'dom';
  #tabId: number;
  /**
   * frame id -> the band of handles that frame mints from.
   *
   * Assigned here and kept for the life of the driver, because a handle already
   * given to the model has to keep meaning what it meant. Band 0 is the top
   * document, which needs no entry.
   */
  #bands = new Map<number, number>();
  #nextBand = 1;

  constructor(tabId: number) {
    this.#tabId = tabId;
  }

  /**
   * A page's frames are capped, like the CDP path's are.
   *
   * A page carrying twenty advert frames would otherwise pay twenty round trips
   * per read for content nobody asked about.
   */
  static readonly MAX_CHILD_FRAMES = 8;

  #bandFor(frameId: number): number {
    const existing = this.#bands.get(frameId);
    if (existing !== undefined) return existing;
    const band = this.#nextBand++;
    this.#bands.set(frameId, band);
    return band;
  }

  /** Which frame owns a handle, from the handle alone. */
  frameOf(handle: number | undefined): number | undefined {
    if (handle === undefined) return 0;
    const band = bandOf(handle);
    if (band === 0) return 0;
    for (const [frameId, assigned] of this.#bands) {
      if (assigned === band) return frameId;
    }
    return undefined;
  }

  async snapshot(): Promise<PageSnapshot> {
    const frames = await listFrames(this.#tabId);

    const response = await sendToPage(this.#tabId, { type: 'snapshot' });
    if (!response.ok) throw new Error(response.error);
    if (response.kind !== 'snapshot') throw new Error('Unexpected reply from the page.');

    const children = frames
      .filter((frame) => frame.frameId !== 0)
      .slice(0, DomDriver.MAX_CHILD_FRAMES);
    if (children.length === 0) return response.snapshot;

    const parts: FramePart[] = await Promise.all(
      children.map(async (frame) => {
        const band = this.#bandFor(frame.frameId);
        const reply = await sendToPage(
          this.#tabId,
          { type: 'snapshot', base: baseForBand(band) },
          frame.frameId,
        );
        return {
          label: labelForFrame(frame.url),
          band,
          snapshot: reply.ok && reply.kind === 'snapshot' ? reply.snapshot : undefined,
        };
      }),
    );

    return mergeFrameSnapshots(response.snapshot, parts);
  }

  async #act(request: Parameters<typeof sendToPage>[1]): Promise<Outcome> {
    const handle = (request as { handle?: number }).handle;
    const frameId = this.frameOf(handle);
    if (frameId === undefined) {
      return {
        ok: false,
        error: `Handle [${String(handle)}] belongs to a frame that is no longer being read. Read the page again.`,
      };
    }

    const response = await sendToPage(this.#tabId, request, frameId);
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

  hover(handle: number, generation: number) {
    return this.#act({ type: 'hover', handle, generation });
  }

  press(press: KeyPress, handle?: number, generation?: number) {
    return this.#act({ type: 'press', handle, generation, press });
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

  /**
   * A picture, without the debugger.
   *
   * `captureVisibleTab` photographs whatever is in front in that window, and
   * nothing else -- it takes no tab id and cannot be pointed at a background
   * tab. So this refuses rather than returning a picture of the wrong page,
   * which is the failure that would be hardest to notice: a screenshot always
   * looks like a real answer.
   *
   * A content script cannot photograph its own page at all, which is why this
   * lives on the driver and goes through the extension API instead.
   */
  async screenshot(): Promise<string | undefined> {
    try {
      const tab = await chrome.tabs.get(this.#tabId);
      if (!tab.active || tab.windowId === undefined) return undefined;
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 45 });
    } catch {
      // No grant for this tab, a page Chrome will not let anyone capture, or the
      // tab has gone. None of them are worth failing an action over.
      return undefined;
    }
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
    const [trees, metrics, tab, facts] = await Promise.all([
      this.#trees(),
      this.#session.send<LayoutMetrics>('Page.getLayoutMetrics'),
      chrome.tabs.get(this.#session.tabId),
      // In parallel with the tree, because it is the same page read twice from
      // two angles and neither depends on the other.
      pageFacts(this.#session),
    ]);

    this.#reads++;
    this.#origin = originOf(tab.url);

    const notes = [...trees.notes];
    if (!facts) {
      // Said out loud rather than swallowed. A run that cannot tell a submit
      // from an ordinary button is a run where the user should be asked more
      // often, and `signals: 'partial'` is what makes the policy layer do that.
      notes.push(
        'The page markup could not be read, so form-submit and payment signals are unavailable ' +
          'for this read. Actions will be confirmed more cautiously.',
      );
    }

    return snapshotFromAxTree({
      nodes: trees.nodes,
      notes,
      facts,
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
   * The accessibility tree of every frame in the tab, merged into one.
   *
   * `Accessibility.getFullAXTree` with no argument returns the top document
   * only. A cookie banner, an embedded checkout, a payment field, a reCAPTCHA —
   * all of those live in an iframe, and none of them were in the page as the
   * model saw it. Asking per frame is the whole fix.
   *
   * Node ids are only unique within one tree, so each frame's ids are prefixed
   * on the way in; otherwise the second frame's "3" overwrites the first frame's
   * and the parent/child walk starts crossing documents. Backend node ids, which
   * are what handles actually point at, are unique across the tab already.
   *
   * A frame Chrome runs out of process refuses the request — it belongs to
   * another debugger target. That is reported rather than swallowed: "the page
   * has no accept button" and "the accept button is in a frame I cannot read"
   * lead a model to completely different next moves.
   */
  async #trees(): Promise<{ nodes: AxNode[]; notes: string[] }> {
    const frames = await frameList(this.#session);
    const notes: string[] = [];

    // The top document is always read. Child frames are capped, because a page
    // carrying twenty advert frames would otherwise pay twenty round trips per
    // read for content nobody wants.
    const MAX_CHILD_FRAMES = 8;
    const children = frames.filter((frame) => !frame.top).slice(0, MAX_CHILD_FRAMES);
    const skipped = frames.filter((frame) => !frame.top).length - children.length;

    const nodes: AxNode[] = [];
    let index = 0;

    for (const frame of [frames.find((f) => f.top) ?? { id: '', url: '', top: true }, ...children]) {
      const label = frame.top ? undefined : hostOf(frame.url);
      try {
        const tree = await this.#session.send<{ nodes: AxNode[] }>(
          'Accessibility.getFullAXTree',
          frame.top || !frame.id ? {} : { frameId: frame.id },
        );
        const prefix = frame.top ? '' : `f${++index}:`;
        for (const node of tree.nodes ?? []) {
          nodes.push(
            prefix
              ? {
                  ...node,
                  nodeId: prefix + node.nodeId,
                  childIds: node.childIds?.map((id) => prefix + id),
                  frameLabel: label,
                }
              : node,
          );
        }
      } catch (error) {
        if (error instanceof CdpDetached) throw error;
        if (!frame.top) {
          notes.push(
            `An embedded frame (${label ?? 'unknown origin'}) could not be read — Chrome runs it ` +
              `separately from the page. If what you need should be inside it, say so rather than ` +
              `concluding it is not there.`,
          );
        }
      }
    }

    if (skipped > 0) notes.push(`${skipped} further embedded frame(s) were not read.`);
    return { nodes, notes };
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
    // Select-all then insert, so typing replaces rather than appends. The
    // modifier is platform-dependent and getting it wrong does not error: the
    // field simply keeps its old value and the new text lands after it.
    await this.#session.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers: selectAllModifier(),
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
    });
    await this.#session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: selectAllModifier(),
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
   * Move the real pointer onto an element and leave it there.
   *
   * A hover menu is not waiting for one `mouseover`; it is waiting for the
   * pointer to arrive and stay. Two moves a beat apart is what the browser sends
   * when a hand does it, and it is the difference between a menu that opens and
   * one that flickers.
   */
  async hover(handle: number, _generation?: number): Promise<Outcome> {
    const target = await this.#resolve(handle);
    if (!('backendNodeId' in target)) return target;

    const point = await this.#centre(target.backendNodeId);
    if (!point) return { ok: false, error: 'That element has no position on screen to hover over.' };

    await this.#session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await this.#session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    // Whatever opened is new, and the page has to be read again to see it.
    await this.settle(1.5);
    return { ok: true, note: 'Moved the pointer onto it with a real mouse event.' };
  }

  /**
   * A real key press, which is a different thing from typing text.
   *
   * `Input.insertText` puts characters in a field and produces no key events, so
   * a form that submits on Enter, a combobox driven by arrow keys, and a dialog
   * that closes on Escape are all beyond it. This is the browser's own key
   * dispatch: the page cannot tell it from a keyboard, and the browser's default
   * behaviour runs.
   */
  async press(press: KeyPress, handle?: number, _generation?: number): Promise<Outcome> {
    if (handle !== undefined) {
      const target = await this.#resolve(handle);
      if (!('backendNodeId' in target)) return target;
      await this.#session.send('DOM.focus', { backendNodeId: target.backendNodeId }).catch(() => {
        // A non-focusable target is not a reason to refuse the key; it goes to
        // whatever has focus, which is what pressing Escape usually wants.
      });
    }

    const spec = keySpec(press);
    const modifiers = modifierMask(press);
    const common = {
      modifiers,
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
    };

    // `keyDown` with text is what Chrome turns into a character; `rawKeyDown`
    // is the right type when there is no text, and using the wrong one is how a
    // key arrives with no `keypress` and gets ignored by half the web.
    await this.#session.send('Input.dispatchKeyEvent', {
      ...common,
      type: spec.text && modifiers === 0 ? 'keyDown' : 'rawKeyDown',
      ...(spec.text && modifiers === 0 ? { text: spec.text, unmodifiedText: spec.text } : {}),
    });
    await this.#session.send('Input.dispatchKeyEvent', { ...common, type: 'keyUp' });

    this.#invalidate();
    return { ok: true, note: `Pressed ${describeKey(press)} with a real key event.` };
  }

  /**
   * Drag one element onto another.
   *
   * Steps rather than a jump: a drag implementation that tracks movement (every
   * sortable list, every file drop zone, every range slider) needs to see the
   * pointer travel, and a single move from source to target reads as a
   * teleport it will not respond to.
   */
  async drag(from: number, to: number, _generation?: number): Promise<Outcome> {
    const source = await this.#resolve(from);
    if (!('backendNodeId' in source)) return source;
    const destination = await this.#resolve(to);
    if (!('backendNodeId' in destination)) return destination;

    const start = await this.#centre(source.backendNodeId);
    const end = await this.#centre(destination.backendNodeId);
    if (!start || !end) {
      return { ok: false, error: 'One of those elements has no position on screen, so it cannot be dragged.' };
    }

    await this.#session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
    await this.#session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...start,
      button: 'left',
      clickCount: 1,
    });

    const STEPS = 12;
    for (let step = 1; step <= STEPS; step++) {
      await this.#session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: start.x + ((end.x - start.x) * step) / STEPS,
        y: start.y + ((end.y - start.y) * step) / STEPS,
        button: 'left',
        buttons: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 16));
    }

    await this.#session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...end,
      button: 'left',
      clickCount: 1,
    });

    this.#invalidate();
    return { ok: true, note: 'Dragged it onto the target with real pointer input.' };
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

  /**
   * Wait until the page has actually stopped, not for a fixed number of
   * milliseconds.
   *
   * This used to be `setTimeout(1200)`, which is wrong in both directions and
   * expensively so: a second and a fifth of dead time on a page that was ready
   * at once, and a read taken mid-render on a search that took two seconds to
   * come back. The agent then reported an empty result list for a page that was
   * about to have twenty items on it — the single most confusing failure this
   * product produced, because reading again immediately made it work.
   *
   * Three conditions, in the order they resolve. Requests in flight, because
   * with `Network` enabled the browser tells us exactly how many there are.
   * Document readiness, because a page can be quiet simply by not having started.
   * Then DOM quiet, because a framework renders *after* its data arrives, and
   * network idle alone lands one frame too early.
   */
  async settle(seconds: number): Promise<{ settled: boolean; waitedMs: number }> {
    const started = Date.now();
    const budget = Math.min(Math.max(seconds, 0), 15) * 1000;
    const QUIET_MS = 400;
    const remaining = () => budget - (Date.now() - started);

    while (remaining() > 0) {
      const idleFor = Date.now() - Math.max(this.#session.lastNetworkActivity, started - QUIET_MS);
      if (this.#session.pendingRequests === 0 && idleFor >= QUIET_MS && (await this.#ready())) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (remaining() <= 0) return { settled: false, waitedMs: Date.now() - started };

    const quiet = await this.#domQuiet(Math.min(remaining(), 2_000), QUIET_MS);
    return { settled: quiet, waitedMs: Date.now() - started };
  }

  /** Whether the document has finished parsing. Cheap, and often decisive. */
  async #ready(): Promise<boolean> {
    try {
      const result = await this.#session.send<{ result: { value?: string } }>('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      });
      return result.result.value !== 'loading';
    } catch (error) {
      if (error instanceof CdpDetached) throw error;
      // A page we cannot ask is not a page to keep waiting on.
      return true;
    }
  }

  /**
   * Resolve once the DOM stops changing, using the page's own MutationObserver.
   *
   * CDP exposes no mutation signal, so the observer has to run in the page. It
   * disconnects itself on both exits, including the timeout, because leaving one
   * attached to every page the agent visits is a slow leak on a long run.
   */
  async #domQuiet(capMs: number, quietMs: number): Promise<boolean> {
    const expression = `new Promise((resolve) => {
      let timer;
      const done = (settled) => { observer.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(settled); };
      const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => done(true), ${quietMs}); });
      const cap = setTimeout(() => done(false), ${capMs});
      timer = setTimeout(() => done(true), ${quietMs});
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
    })`;

    try {
      const result = await this.#session.send<{ result: { value?: boolean } }>('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return result.result.value !== false;
    } catch (error) {
      if (error instanceof CdpDetached) throw error;
      return true;
    }
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

/** A frame's origin in the shortest form worth showing the model. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}
