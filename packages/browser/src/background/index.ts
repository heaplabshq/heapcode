import {
  PENDING_PROMPT_KEY,
  PORT_NAME,
  type PanelMessage,
  type WorkerMessage,
} from '../shared/messages.js';

/**
 * The service worker: a thin, stateless router.
 *
 * Nothing here may hold run state or drive the agent loop. Chrome kills an idle
 * MV3 worker at roughly 30 seconds and a run takes minutes, so anything durable
 * kept here is lost mid-task (PRD §7.1). PLAN guardrail 3 states the rule as a
 * location: loop code stays out of `src/background/`. Keeping this file boring
 * is how that stays true.
 *
 * The context menu lives here because it has to: menu registration and the
 * click that follows are worker events, and the click is the user gesture that
 * `sidePanel.open` requires. The prompt it produces is handed straight on and
 * nothing about it is remembered here.
 */

// Clicking the toolbar icon opens the side panel. Chrome requires this be
// registered at the top level of the worker, not inside an event handler, or
// the panel fails to open from a user gesture after the worker has restarted.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
  console.error('heapbrowse: could not set side panel behavior', error);
});

/**
 * Panels currently listening.
 *
 * Not state in the sense the guardrail forbids: it is a list of live
 * connections, it is worthless once the worker restarts, and everything sent
 * through it is also written to session storage so a panel that was not
 * listening still gets it.
 */
const panels = new Set<chrome.runtime.Port>();

/** How much selected text is worth carrying. A whole article is not a question. */
const MAX_SELECTION = 500;

const MENU = {
  selection: 'heapbrowse-selection',
  link: 'heapbrowse-link',
  page: 'heapbrowse-page',
} as const;

/**
 * Registered on install rather than on every worker start.
 *
 * `contextMenus.create` throws on a duplicate id, and the worker starts many
 * times a session — registering there means an exception on every wake, which
 * Chrome surfaces as an extension error the user can see.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU.selection,
      title: 'Ask heapbrowse about "%s"',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU.link,
      title: 'Ask heapbrowse about this link',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: MENU.page,
      title: 'Ask heapbrowse about this page',
      contexts: ['page'],
    });
  });
});

/**
 * What a right-click means, as a request the user can read and edit.
 *
 * Deliberately a complete sentence rather than a bare fragment: it lands in the
 * composer, not in the model, and the user presses Enter. That gap is also the
 * safety property — selected text is page content, and page content must never
 * reach the model wearing the user's authority without the user having looked
 * at it. It is quoted so that it reads as a quotation when it does get sent.
 */
function promptFor(info: chrome.contextMenus.OnClickData): string | undefined {
  switch (info.menuItemId) {
    case MENU.selection: {
      const text = (info.selectionText ?? '').trim().slice(0, MAX_SELECTION);
      return text ? `Explain this, from the page I am on: "${text}"` : undefined;
    }
    case MENU.link:
      return info.linkUrl ? `What is at this link, and is it worth opening? ${info.linkUrl}` : undefined;
    case MENU.page:
      return 'What is this page, and what can I do on it?';
    default:
      return undefined;
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const prompt = promptFor(info);
  if (!prompt) return;

  // Written first, so a panel opening for the first time in response to this
  // very click finds it waiting rather than racing the port.
  void chrome.storage.session.set({ [PENDING_PROMPT_KEY]: prompt }).then(() => {
    if (tab?.id !== undefined) {
      // The menu click is the user gesture `open` requires; there is no second
      // chance at one later.
      void chrome.sidePanel.open({ tabId: tab.id }).catch(() => {
        // Already open, or a window that cannot host it. The storage write
        // above still reaches the panel.
      });
    }
    for (const panel of panels) {
      try {
        panel.postMessage({ type: 'prompt', text: prompt } satisfies WorkerMessage);
      } catch {
        // A port that has gone. The next connect cleans it up.
      }
    }
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  panels.add(port);
  port.onDisconnect.addListener(() => panels.delete(port));

  port.onMessage.addListener((message: PanelMessage) => {
    const reply = (response: WorkerMessage) => port.postMessage(response);
    switch (message.type) {
      case 'ping':
        reply({ type: 'pong' });
        break;
      case 'origin':
        reply({ type: 'origin', origin: `chrome-extension://${chrome.runtime.id}` });
        break;
    }
  });
});
