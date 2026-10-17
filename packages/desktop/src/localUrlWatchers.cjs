// Which pages want to hear about dev-server addresses the shells print.
//
// One entry per page, not per request: the preload fans a single push out to
// however many listeners the page has, and the page asks again every time its
// Browser view mounts. Keying by request is what leaked — each ask added a
// 'destroyed' listener to the window that nothing removed until it closed,
// and after ten Electron warned of a memory leak.

/**
 * @typedef {{ id: number, on: Function, off: Function, once: Function }} Sender
 *   An Electron WebContents, or anything with the same events.
 */

function createLocalUrlWatchers() {
  /** webContents id → push */
  const watchers = new Map();

  /**
   * Subscribe a page until it navigates away or closes. A page that is
   * already subscribed is left as it is.
   * @param {Sender} sender
   * @param {(urls: string[]) => void} push
   */
  function watch(sender, push) {
    if (watchers.has(sender.id)) return;
    watchers.set(sender.id, push);
    const stop = () => {
      watchers.delete(sender.id);
      sender.off('did-start-navigation', onNav);
      sender.off('destroyed', stop);
    };
    // A reload is a new page that will ask for itself. Only a real page load
    // counts — the app's own pushState routing is not one.
    const onNav = (details) => {
      if (!details?.isMainFrame || details.isSameDocument) return;
      stop();
    };
    sender.on('did-start-navigation', onNav);
    sender.once('destroyed', stop);
  }

  /** @param {string[]} urls */
  function notify(urls) {
    for (const push of watchers.values()) push(urls);
  }

  return { watch, notify, size: () => watchers.size };
}

module.exports = { createLocalUrlWatchers };
