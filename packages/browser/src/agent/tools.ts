import { sharedAgentTools, type ToolDefinition } from '@heapcode/core/agent';

/**
 * What the agent can do to a page.
 *
 * M2 is read-only on purpose: this is where the loop first runs against a
 * browser, and the blast radius stays exactly zero while that is proven. The
 * mutating half — click, type, select, navigate — lands in M3 together with the
 * permission engine and confirmation UI, because PLAN guardrail 5 says a tool
 * with `permission: 'write'` does not ship without the path that confirms it.
 *
 * Every page-reading tool is `untrustedOutput: true`. The results are whatever
 * an arbitrary website chose to put on screen, arriving while the agent sits
 * beside the user's logged-in session, so core wraps them as data before the
 * model sees them (PRD §6.1).
 */

export const READ_PAGE: ToolDefinition = {
  name: 'read_page',
  description:
    'Read the page the user is currently viewing: its text, its interactive controls with their ' +
    'handles, and any tables. Call this first. After the first call, later calls return only what ' +
    'has changed.',
  parameters: {
    type: 'object',
    properties: {
      full: {
        type: 'boolean',
        description:
          'Force a complete re-read instead of the changes since the last read. Use only if the ' +
          'change summary is not enough to work out the current state.',
      },
    },
  },
  permission: 'read',
  untrustedOutput: true,
  /**
   * Reading counts as verifying. Core will block `finish` once, with a nudge,
   * if a mutating tool has run since the last successful read -- so an agent
   * that clicks and then declares success without ever looking at the result
   * gets sent back to look. The same mechanism that stops heapcode finishing
   * with untested edits (PLAN M4).
   */
  verifies: true,
};

export const GET_ELEMENTS: ToolDefinition = {
  name: 'get_elements',
  description:
    'List the page controls, optionally filtered by a word in their name — cheaper than a full ' +
    're-read when you only need to find a particular button, field, or link.',
  parameters: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        description: 'Only return controls whose name or context contains this text.',
      },
      role: {
        type: 'string',
        enum: ['button', 'link', 'input', 'textarea', 'select', 'checkbox', 'radio'],
        description: 'Only return controls of this kind.',
      },
    },
  },
  permission: 'read',
  untrustedOutput: true,
};

export const EXTRACT_DATA: ToolDefinition = {
  name: 'extract_data',
  description:
    'Pull the page\'s data out as structured rows — use this for "list every…", "compare…" or ' +
    '"put these in a table" requests rather than reading the whole page. It reads real tables and ' +
    'also the repeated blocks a page uses instead of one: search results, product grids, job ' +
    'listings. Rows accumulate across pages, de-duplicated, and the user gets the whole set to ' +
    'read and export — so do not repeat them back in your answer.',
  parameters: {
    type: 'object',
    properties: {
      table: {
        type: 'number',
        description: 'Which table to pull, when the page has more than one. Defaults to the first.',
      },
      limit: {
        type: 'number',
        description: 'Maximum rows to return. Defaults to 50.',
      },
    },
  },
  permission: 'read',
  untrustedOutput: true,
};

/**
 * The whole page as text, with no control list and a generous budget.
 *
 * `read_page` is built for *acting*: ranked, budgeted, truncated, and mostly
 * spent on controls. That is the wrong shape for answering a question about
 * something written far down the page -- a specification table, a returns
 * policy, the small print -- where the detail wanted is exactly what ranking
 * throws away.
 *
 * Observed directly: asked for a sofa's seat measurements, Claude in Chrome
 * reached for its page-text tool and had the answer in one step. `read_page`
 * would have truncated the spec table before the model ever saw it.
 */
export const GET_PAGE_TEXT: ToolDefinition = {
  name: 'get_page_text',
  description:
    'Read the full text of the page, without the control list. Use this to answer questions about ' +
    'what the page says — specifications, descriptions, policies, prices, small print — especially ' +
    'when the detail is likely below the fold or in a table. Prefer this over read_page when you ' +
    'need to know something rather than do something. It is the largest thing you can put in the ' +
    'conversation, so read a page once: if it has not changed you will be told so rather than ' +
    'handed it twice. To pull one detail out of a page you have already read, pass find instead — ' +
    'it returns the matching lines and costs almost nothing.',
  parameters: {
    type: 'object',
    properties: {
      find: {
        type: 'string',
        description:
          'Only return the parts mentioning this word or phrase, with surrounding context. Use it ' +
          'on a long page to go straight to the relevant section.',
      },
    },
  },
  permission: 'read',
  untrustedOutput: true,
  verifies: true,
};

/**
 * A picture of the page, for the model.
 *
 * Deliberately a tool the model calls rather than an image attached to every
 * turn. A screenshot is a few hundred kilobytes and, once in the transcript, is
 * re-sent on every subsequent request -- attaching one automatically is how a
 * browser agent becomes slow and expensive by the fifth step. Asked for only
 * when text has failed, the cost is paid once and for a reason: a chart, a
 * canvas, an image, or a layout question the accessibility tree cannot express.
 */
export const SCREENSHOT: ToolDefinition = {
  name: 'screenshot',
  description:
    'Take a picture of what is currently on screen. The most expensive tool here by a wide ' +
    'margin: the image stays in the conversation for every turn after it. Use it only when ' +
    'reading has already failed to answer the question — something shown only in an image, a ' +
    'chart or a canvas, or a layout you have to see. Never use it to check what a page says, to ' +
    'confirm an action worked, or to look at a page you have just read; read_page and ' +
    'get_page_text are cheaper, more precise, and give you addressable handles.',
  parameters: { type: 'object', properties: {} },
  permission: 'read',
  untrustedOutput: true,
};

export const SCROLL: ToolDefinition = {
  name: 'scroll',
  description:
    'Scroll the page and report what became visible. Use this to reach content below the fold, ' +
    'including pages that load more as you scroll.',
  parameters: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] },
      pages: {
        type: 'number',
        description: 'How many viewport heights to move. Defaults to 1. Ignored for top/bottom.',
      },
    },
    required: ['direction'],
  },
  // Scrolling changes what is visible but nothing about the page's state, and
  // it is how the agent reads a long document at all. Treating it as a write
  // would put a confirmation in front of ordinary reading.
  permission: 'read',
  untrustedOutput: true,
};

export const WAIT: ToolDefinition = {
  name: 'wait',
  description:
    'Wait for the page to settle before reading again — after triggering something that loads ' +
    'content. Returns as soon as the page stops changing, or when the timeout is reached.',
  parameters: {
    type: 'object',
    properties: {
      seconds: { type: 'number', description: 'How long to wait at most. Defaults to 3, max 15.' },
    },
  },
  permission: 'read',
};

/**
 * Asking the user something only they know.
 *
 * A browser agent runs into this constantly and in a way a coding agent does
 * not: filling in a form needs facts that are not on the page and not in the
 * repo — a notice period, a salary expectation, which of two addresses to use.
 * Without this the model either stops and reports that it needs something, or
 * invents a plausible value and types it into a real application form. The
 * second is much worse and is what it will do by default.
 *
 * The definition is core's, imported rather than restated, so the semantics the
 * loop already relies on — `blocksAction`, the idle rules in askUser.ts — mean
 * here exactly what they mean in the CLI.
 */
export const ASK_USER: ToolDefinition = {
  ...sharedAgentTools.ask_user,
  description:
    'Ask the user for something only they can tell you — a fact that is not on the page (their ' +
    'notice period, expected salary, which option they prefer), or a decision between real ' +
    'alternatives. Use this instead of guessing a value you are about to type into a form. Ask one ' +
    'question at a time, and prefer a sensible default where one obviously exists.',
};

/**
 * The user's other tabs.
 *
 * A browser agent without this is stuck comparing three sites by navigating one
 * tab back and forth and losing its place each time. It is also the first tool
 * here that reports something outside the page the user pointed at, which is
 * why it reports only titles and addresses -- enough to choose a tab, and
 * nothing of what is in one.
 */
export const LIST_TABS: ToolDefinition = {
  name: 'list_tabs',
  description:
    'List the open tabs in this window, with their numbers, titles and addresses. Use this to find ' +
    'a tab you opened earlier, or to check where you are working.',
  parameters: { type: 'object', properties: {} },
  permission: 'read',
  untrustedOutput: true,
};

export const SWITCH_TAB: ToolDefinition = {
  name: 'switch_tab',
  description:
    'Work in a different tab from now on. Reading and acting all follow the tab you switch to, ' +
    'until you switch again. Use the tab number from list_tabs or open_tab.',
  parameters: {
    type: 'object',
    properties: { tab: { type: 'number', description: 'The tab number, from list_tabs.' } },
    required: ['tab'],
  },
  // Switching changes nothing on any page; it changes where this run is
  // looking. Putting a confirmation in front of that would ask the user to
  // approve the agent's bookkeeping.
  permission: 'read',
  untrustedOutput: true,
};

/**
 * Hovering, which is how a large part of the web opens.
 *
 * Read-permission for the same reason `scroll` is: it reveals things without
 * changing anything. A hover cannot submit, buy or delete -- the worst it does
 * is open a menu, which is exactly what it is for.
 */
export const HOVER: ToolDefinition = {
  name: 'hover',
  description:
    'Move the pointer onto a control without clicking it. Use this for menus, tooltips and ' +
    'previews that only appear on hover. Read the page afterwards to see what opened.',
  parameters: {
    type: 'object',
    properties: {
      handle: { type: 'number', description: 'The handle number of the control to hover over.' },
    },
    required: ['handle'],
  },
  permission: 'read',
  untrustedOutput: true,
};

/**
 * Handing the page back to the person sitting at it.
 *
 * The hardest category of real web task is not reasoning -- it is the wall that
 * was deliberately built to require a human. Logging in, a one-time code, a
 * CAPTCHA, a file that has to come off this machine. Web Bench, which is the
 * benchmark that bothers to separate reading from doing, finds those are where
 * agents fail, and an entire product category exists to hand a cloud browser
 * back to a person for that one step and resume without losing the session.
 *
 * heapbrowse does not have that problem to solve. It is already in the user's
 * browser, in the user's session, on the tab they are looking at -- the human
 * is not somewhere else, they are right there. So the agent stops, says what is
 * needed in one sentence, and waits. The person does it on the page in front of
 * them, presses a button, and the run continues from where it stopped.
 *
 * Deliberately not `ask_user`. That one asks for a *fact* and gets a string
 * back; this asks for an *act* and gets the page changed underneath it, which
 * is why the result says in as many words that everything read before it is now
 * stale.
 */
export const HAND_OVER: ToolDefinition = {
  name: 'hand_over',
  description:
    'Stop and let the user do one step themselves on the page, then carry on. Use this the moment ' +
    'you meet something built to need a person: a login or password, a one-time code, a CAPTCHA, ' +
    'a bank or card confirmation, choosing a file to upload, or any wall you cannot get past. Say ' +
    'in one plain sentence what they should do — they are looking at this page. Never try to work ' +
    'around such a wall, and never ask for a password or a code so you can type it: ask them to do ' +
    'it. Everything you read before this is stale afterwards, so read the page again.',
  parameters: {
    type: 'object',
    properties: {
      what: {
        type: 'string',
        description:
          'What the user should do, in one plain sentence addressed to them. For example: "Sign in ' +
          'to your account, then press Done." or "Choose your CV in the file picker, then press Done."',
      },
    },
    required: ['what'],
  },
  // It touches nothing. The user is the one acting, on their own page, by hand.
  permission: 'read',
  untrustedOutput: false,
};

/** The read-only belt, in the order the model should generally reach for them. */
export const READ_ONLY_TOOLS: ToolDefinition[] = [
  READ_PAGE,
  GET_PAGE_TEXT,
  GET_ELEMENTS,
  EXTRACT_DATA,
  SCROLL,
  HOVER,
  WAIT,
  LIST_TABS,
  SWITCH_TAB,
  ASK_USER,
  HAND_OVER,
];
