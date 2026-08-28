/**
 * A visible sign, on the page itself, that something else is driving it.
 *
 * Chrome's "being debugged" banner is not this. It says a debugger is attached,
 * which is equally true while a run is thinking and while it is clicking, and
 * it says nothing at all on the content-script path — where the agent can click
 * just as well. So the page carries its own mark: a breathing outline at the
 * edge of the viewport and a small label naming what is doing it.
 *
 * Injected with `chrome.scripting.executeScript` rather than sent to the
 * content script. It shares no channel with the driver, which matters more than
 * it sounds: routing it through `sendToPage` put an extra request-and-reply in
 * front of every driver acquisition, on a protocol whose whole job is
 * one-request-one-answer.
 *
 * Both functions are serialized and run in the page's isolated world, so they
 * may close over nothing. Everything they need is inside them or in `args`.
 */

/** Runs in the page. Self-contained by necessity — see the note above. */
function paint(label: string): void {
  const ID = '__heapbrowse_activity';
  const existing = document.getElementById(ID);
  if (existing) return;

  const host = document.createElement('div');
  host.id = ID;
  // A closed shadow root: the page's CSS cannot restyle this, and none of this
  // can leak out and restyle the page the agent is in the middle of reading.
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .frame {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483646;
      border: 2px solid rgba(37, 99, 235, 0.85);
      box-shadow: inset 0 0 20px rgba(37, 99, 235, 0.2);
      animation: hb-breathe 2.4s ease-in-out infinite;
    }
    .pill {
      position: fixed;
      right: 14px;
      bottom: 14px;
      pointer-events: none;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 6px 11px;
      border-radius: 999px;
      background: rgba(17, 24, 39, 0.92);
      color: #f9fafb;
      font: 500 12px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
      animation: hb-in 0.2s ease-out;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #60a5fa;
      animation: hb-pulse 1.1s ease-in-out infinite;
    }
    @keyframes hb-breathe { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
    @keyframes hb-pulse { 0%, 100% { transform: scale(0.7); opacity: 0.5; } 50% { transform: scale(1.15); opacity: 1; } }
    @keyframes hb-in { from { opacity: 0; transform: translateY(4px); } }
    @media (prefers-reduced-motion: reduce) {
      .frame { animation: none; opacity: 0.75; }
      .dot, .pill { animation: none; }
    }
  `;

  const frame = document.createElement('div');
  frame.className = 'frame';

  const pill = document.createElement('div');
  pill.className = 'pill';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const text = document.createElement('span');
  text.textContent = label;
  pill.append(dot, text);

  root.append(style, frame, pill);
  // On `documentElement`, not `body`: a page mid-navigation may not have a body
  // yet, and that is exactly when this is most worth showing. Nothing here is in
  // the layout flow, so it cannot reflow the page underneath it.
  document.documentElement.appendChild(host);
}

/** Runs in the page. */
function erase(): void {
  document.getElementById('__heapbrowse_activity')?.remove();
}

/**
 * Show the mark on a tab.
 *
 * Silent on failure throughout. A tab we have no grant for, a page Chrome will
 * not let anyone script, a tab that closed mid-run — none of those are worth
 * interrupting a run over, and none of them are worth telling the user about:
 * the mark is reassurance, and a missing one costs nothing.
 */
export async function showActivity(tabId: number, label = 'heapbrowse is working'): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: paint, args: [label] });
  } catch {
    // See above.
  }
}

export async function hideActivity(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: erase });
  } catch {
    // See above.
  }
}
