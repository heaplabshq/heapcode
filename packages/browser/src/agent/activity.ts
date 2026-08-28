/**
 * A visible sign, on the page itself, that something else is driving it.
 *
 * Chrome's "being debugged" banner is not this. It says a debugger is attached,
 * which is equally true while a run is thinking and while it is clicking; it
 * says nothing at all on the content-script path, where the agent can click
 * just as well; and it cannot be moved, restyled or told what the agent is
 * currently doing. So the page carries its own mark, at the bottom, where the
 * user's attention already is when the agent is operating something: a bar
 * naming the step in progress, and a stop button that works from the page
 * rather than requiring a trip back to the side panel.
 *
 * Two elements, and they answer two different questions. The glow around the
 * edges answers "is something driving this page", from the corner of the eye,
 * without being read; the bar answers "what is it doing", and is read. A hard
 * 2px border -- what the glow used to be -- boxed the content in and looked
 * like an error, and a beam travelling along the top edge was a second thing
 * moving on a page someone is trying to read. What is here now has no edge of
 * its own: it fades to nothing about thirty pixels in, and breathes slowly
 * enough to register as alive rather than as urgent.
 *
 * The bar is dark glass in both themes, because it has to sit legibly on a page
 * whose colours it cannot know.
 *
 * Injected with `chrome.scripting.executeScript` rather than sent to the
 * content script. It shares no channel with the driver, which matters more than
 * it sounds: routing it through `sendToPage` put an extra request-and-reply in
 * front of every driver acquisition, on a protocol whose whole job is
 * one-request-one-answer.
 *
 * Every function below is serialized and runs in the page's isolated world, so
 * it may close over nothing. Everything they need is inside them or in `args`.
 */

const HOST_ID = '__heapbrowse_activity';

/** Runs in the page. Self-contained by necessity -- see the note above. */
function paint(id: string, label: string, detail: string): void {
  if (document.getElementById(id)) return;

  const host = document.createElement('div');
  host.id = id;
  // A closed shadow root: the page's CSS cannot restyle this, and none of this
  // can leak out and restyle the page the agent is in the middle of reading.
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    /*
     * The glow. Four edges, no border: an inset shadow with a large blur and no
     * spread has no line anywhere in it, so it reads as light coming in from
     * outside the page rather than as a frame drawn around it.
     *
     * Promoted to its own compositor layer, so the browser animates the
     * opacity without repainting the page underneath -- this sits on top of a
     * site the agent is in the middle of reading, and it must cost that site
     * nothing.
     */
    .glow {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483646;
      box-shadow:
        inset 0 0 34px -6px rgba(99, 102, 241, 0.75),
        inset 0 0 90px -30px rgba(168, 85, 247, 0.6);
      opacity: 0;
      will-change: opacity;
      animation:
        hb-glow-in 0.6s cubic-bezier(0.22, 0.61, 0.36, 1) forwards,
        hb-glow 3.4s ease-in-out 0.6s infinite;
    }

    .bar {
      position: fixed;
      left: 50%;
      bottom: 16px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: min(520px, calc(100vw - 32px));
      padding: 7px 7px 7px 13px;
      border-radius: 999px;
      background: rgba(20, 22, 27, 0.86);
      -webkit-backdrop-filter: blur(14px) saturate(1.5);
      backdrop-filter: blur(14px) saturate(1.5);
      box-shadow:
        0 0 0 1px rgba(255, 255, 255, 0.1),
        0 12px 34px -10px rgba(0, 0, 0, 0.65);
      color: #f4f5f7;
      font: 500 12.5px/1.25 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      transform: translate(-50%, 130%);
      animation: hb-bar-in 0.42s cubic-bezier(0.34, 1.4, 0.64, 1) 0.06s forwards;
      pointer-events: auto;
      user-select: none;
    }

    .mark {
      width: 15px;
      height: 15px;
      border-radius: 5px;
      flex: none;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      animation: hb-breathe 2.2s ease-in-out infinite;
    }

    .text { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
    .label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .detail {
      color: rgba(244, 245, 247, 0.58);
      font-weight: 400;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .detail:empty { display: none; }

    /* Each new step fades its own line in, so the bar reads as progressing
       rather than as one label being overwritten. */
    .swap { animation: hb-swap 0.24s cubic-bezier(0.22, 0.61, 0.36, 1); }

    .stop {
      flex: none;
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 11px 4px 9px;
      border: none;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.12);
      color: #f4f5f7;
      font: inherit;
      font-size: 11.5px;
      cursor: pointer;
      transition: background 0.14s ease, color 0.14s ease;
    }
    .stop:hover { background: #ef4444; color: #fff; }
    .stop:focus-visible { outline: 2px solid #a5b4fc; outline-offset: 2px; }
    .stop svg { display: block; }

    @keyframes hb-glow-in { to { opacity: 0.85; } }
    @keyframes hb-glow {
      0%, 100% { opacity: 0.45; }
      50% { opacity: 1; }
    }
    @keyframes hb-bar-in { to { transform: translate(-50%, 0); } }
    @keyframes hb-breathe {
      0%, 100% { transform: scale(0.86); opacity: 0.7; }
      50% { transform: scale(1); opacity: 1; }
    }
    @keyframes hb-swap { from { opacity: 0; transform: translateY(3px); } }
    @keyframes hb-out {
      to { opacity: 0; transform: translate(-50%, 130%); }
    }

    /* Someone who has asked for less movement gets a bar that simply is there.
       Nothing above carries information that is not also in the text. */
    @media (prefers-reduced-motion: reduce) {
      /* Still there, still saying the same thing, just not moving. */
      .glow { animation: none; opacity: 0.8; }
      .bar { animation: none; transform: translate(-50%, 0); }
      .mark, .swap { animation: none; }
    }
  `;

  const glow = document.createElement('div');
  glow.className = 'glow';

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');

  const mark = document.createElement('span');
  mark.className = 'mark';

  const text = document.createElement('span');
  text.className = 'text';
  const labelEl = document.createElement('span');
  labelEl.className = 'label';
  labelEl.textContent = label;
  const detailEl = document.createElement('span');
  detailEl.className = 'detail';
  detailEl.textContent = detail;
  text.append(labelEl, detailEl);

  const stop = document.createElement('button');
  stop.className = 'stop';
  stop.type = 'button';
  stop.innerHTML =
    '<svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">' +
    '<rect width="9" height="9" rx="2" fill="currentColor"/></svg>Stop';
  stop.addEventListener('click', () => {
    // The page cannot reach the side panel, and the panel is where the run
    // lives. The worker routes it; a failure here means the panel has already
    // gone, which is itself the end of the run.
    try {
      void chrome.runtime.sendMessage({ __heapbrowse: 'stop' });
    } catch {
      /* The extension context went away. Nothing left to stop. */
    }
    stop.disabled = true;
    labelEl.textContent = 'Stopping…';
    detailEl.textContent = '';
  });

  bar.append(mark, text, stop);
  root.append(style, glow, bar);

  // Updating without re-injecting: the setter is hung off the host element,
  // which is the only handle a later `executeScript` has on this shadow root.
  Object.defineProperty(host, '__hbSet', {
    value: (nextLabel: string, nextDetail: string) => {
      if (labelEl.textContent === nextLabel && detailEl.textContent === nextDetail) return;
      labelEl.textContent = nextLabel;
      detailEl.textContent = nextDetail;
      text.classList.remove('swap');
      // Reading `offsetWidth` restarts the animation; without it the class goes
      // back on in the same frame and nothing replays.
      void text.offsetWidth;
      text.classList.add('swap');
    },
    configurable: true,
  });

  // On `documentElement`, not `body`: a page mid-navigation may not have a body
  // yet, and that is exactly when this is most worth showing. Nothing here is in
  // the layout flow, so it cannot reflow the page underneath it.
  document.documentElement.appendChild(host);
}

/** Runs in the page. Retitles the bar in place rather than rebuilding it. */
function relabel(id: string, label: string, detail: string): void {
  const host = document.getElementById(id) as (HTMLElement & { __hbSet?: unknown }) | null;
  const set = host?.__hbSet;
  if (typeof set === 'function') (set as (a: string, b: string) => void)(label, detail);
}

/** Runs in the page. Lets the bar leave before it is removed. */
function erase(id: string): void {
  const host = document.getElementById(id);
  if (!host) return;
  // A closed shadow root is not reachable from out here, so the exit is driven
  // by fading the host itself. Removal is on a timer rather than on
  // `animationend`, which never fires for a user who has asked for no motion.
  host.style.transition = 'opacity 220ms ease';
  host.style.opacity = '0';
  setTimeout(() => host.remove(), 240);
}

/**
 * Show the mark on a tab.
 *
 * Silent on failure throughout. A tab we have no grant for, a page Chrome will
 * not let anyone script, a tab that closed mid-run -- none of those are worth
 * interrupting a run over, and none of them are worth telling the user about:
 * the mark is reassurance, and a missing one costs nothing.
 */
export async function showActivity(
  tabId: number,
  label = 'heapbrowse is working',
  detail = '',
): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: paint,
      args: [HOST_ID, label, detail],
    });
  } catch {
    // See above.
  }
}

/** Say what is happening now, on a tab that is already marked. */
export async function noteActivity(tabId: number, label: string, detail = ''): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: relabel,
      args: [HOST_ID, label, detail],
    });
  } catch {
    // See above.
  }
}

export async function hideActivity(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: erase, args: [HOST_ID] });
  } catch {
    // See above.
  }
}
