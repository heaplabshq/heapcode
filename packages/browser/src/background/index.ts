import { PORT_NAME, type PanelMessage, type WorkerMessage } from '../shared/messages.js';

/**
 * The service worker: a thin, stateless router.
 *
 * Nothing here may hold run state or drive the agent loop. Chrome kills an idle
 * MV3 worker at roughly 30 seconds and a run takes minutes, so anything durable
 * kept here is lost mid-task (PRD §7.1). PLAN guardrail 3 states the rule as a
 * location: loop code stays out of `src/background/`. Keeping this file boring
 * is how that stays true.
 */

// Clicking the toolbar icon opens the side panel. Chrome requires this be
// registered at the top level of the worker, not inside an event handler, or
// the panel fails to open from a user gesture after the worker has restarted.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
  console.error('heapbrowse: could not set side panel behavior', error);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

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
