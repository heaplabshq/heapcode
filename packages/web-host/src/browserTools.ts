import type { PermissionClass, ToolCall, ToolDefinition, ToolResult } from '@heapcode/core';
import type { UiBrowserParams, UiBrowserResult } from './protocol.js';

/**
 * The agent's view of the desktop app's Browser pane — so it can look at the
 * thing it just built instead of assuming the change worked.
 *
 * Offered by this host only, and only while the attached client is the desktop
 * app (hello's `capabilities.browser`): the pane is an Electron <webview>, and
 * a plain browser tab has nothing to answer these with.
 *
 * **Local pages only.** A coding agent that runs shell commands reading
 * arbitrary websites is the textbook prompt-injection path, so every tool here
 * refuses a page that is not a local dev server — including one the person
 * navigated to themselves, which is also the page most likely to hold their
 * own signed-in data. `fetch_url` remains for reading the public web as text.
 * Results are still `untrustedOutput`: a local page renders whatever data the
 * app under development shows, and that is not the user speaking either.
 *
 * Acting on the page (click, type, select, press) goes through the ordinary
 * permission cards: the tools are `execute`, and a click whose target reads
 * like it commits something ("Delete", "Pay", "Submit") is raised to
 * `destructive` — see `classifyBrowserAction`.
 */
export const BROWSER_OPEN_TOOL: ToolDefinition = {
  name: 'browser_open',
  description:
    "Open a local page (a dev server on localhost / 127.0.0.1) in the user's Browser pane and wait for it to load. " +
    'Use it to check your own work after changing a web app: open the page, then browser_snapshot to read it, ' +
    'browser_console for errors, or browser_screenshot to see it. Only local addresses are allowed — for public ' +
    'websites use fetch_url. Start the dev server with run_command first if nothing is listening.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'e.g. http://localhost:5173/settings. A bare localhost:5173 also works.' },
    },
    required: ['url'],
  },
  permission: 'read',
  untrustedOutput: true,
};

export const BROWSER_SNAPSHOT_TOOL: ToolDefinition = {
  name: 'browser_snapshot',
  description:
    "Read the page currently open in the Browser pane as text: its title, headings, links, buttons, form fields and " +
    'visible text. Every element you can act on is numbered, e.g. [7] button "Save" — pass that number as `ref` to ' +
    'browser_click, browser_type or browser_select. Numbers change when the page does: take a new snapshot after ' +
    'anything that changes the page. Cheaper than a screenshot and works with any model. Local pages only.',
  parameters: { type: 'object', properties: {} },
  permission: 'read',
  untrustedOutput: true,
};

/** The same tool as offered where the page can only be looked at (Heap Chat). */
export const BROWSER_SNAPSHOT_READ_ONLY_TOOL: ToolDefinition = {
  ...BROWSER_SNAPSHOT_TOOL,
  description:
    "Read the page currently open in the Browser pane as text: its title, headings, links, buttons, form fields and " +
    'visible text. You can look at pages but not act on them — you cannot click, type or submit anything, so do ' +
    'not offer to. Cheaper than a screenshot and works with any model. Local pages only.',
};

export const BROWSER_SCREENSHOT_TOOL: ToolDefinition = {
  name: 'browser_screenshot',
  description:
    'Take a screenshot of the page currently open in the Browser pane, to check layout and styling. Images are ' +
    'large and stay in the conversation, so prefer browser_snapshot unless how it LOOKS is the question. Local ' +
    'pages only.',
  parameters: { type: 'object', properties: {} },
  permission: 'read',
  untrustedOutput: true,
};

export const BROWSER_CONSOLE_TOOL: ToolDefinition = {
  name: 'browser_console',
  description:
    'Read what the page in the Browser pane logged to its console since it loaded — errors and warnings first. ' +
    'Use it when a page is blank or broken. Local pages only.',
  parameters: { type: 'object', properties: {} },
  permission: 'read',
  untrustedOutput: true,
};

const REF = { type: 'string', description: 'The element number from the last browser_snapshot, e.g. "7".' };

export const BROWSER_CLICK_TOOL: ToolDefinition = {
  name: 'browser_click',
  description:
    'Click an element on the page in the Browser pane, by its number from browser_snapshot. Sent as a real mouse ' +
    'click. The user is asked first. Local pages only.',
  parameters: { type: 'object', properties: { ref: REF }, required: ['ref'] },
  permission: 'execute',
  untrustedOutput: true,
};

export const BROWSER_TYPE_TOOL: ToolDefinition = {
  name: 'browser_type',
  description:
    'Type into a text field on the page in the Browser pane, by its number from browser_snapshot. Set clear to ' +
    'replace what is there, submit to press Enter afterwards. The user is asked first. Local pages only.',
  parameters: {
    type: 'object',
    properties: {
      ref: REF,
      text: { type: 'string', description: 'What to type.' },
      clear: { type: 'boolean', description: 'Replace the current contents instead of adding to them. Default true.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
    },
    required: ['ref', 'text'],
  },
  permission: 'execute',
  untrustedOutput: true,
};

export const BROWSER_SELECT_TOOL: ToolDefinition = {
  name: 'browser_select',
  description:
    'Choose an option in a dropdown (<select>) on the page in the Browser pane, by the dropdown\'s number from ' +
    'browser_snapshot and the option\'s visible text or value. The user is asked first. Local pages only.',
  parameters: {
    type: 'object',
    properties: { ref: REF, option: { type: 'string', description: "The option's visible text or its value." } },
    required: ['ref', 'option'],
  },
  permission: 'execute',
  untrustedOutput: true,
};

export const BROWSER_PRESS_TOOL: ToolDefinition = {
  name: 'browser_press',
  description:
    'Press a key on the page in the Browser pane, into whatever has focus: Enter, Tab, Escape, Backspace, ' +
    'ArrowDown, and combinations like Shift+Tab or Control+a. The user is asked first. Local pages only.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: 'e.g. Enter, Escape, ArrowDown, Shift+Tab' } },
    required: ['key'],
  },
  permission: 'execute',
  untrustedOutput: true,
};

export const BROWSER_ACTION_TOOLS = [BROWSER_CLICK_TOOL, BROWSER_TYPE_TOOL, BROWSER_SELECT_TOOL, BROWSER_PRESS_TOOL];

export const BROWSER_TOOL_NAMES = new Set([
  BROWSER_OPEN_TOOL.name,
  BROWSER_SNAPSHOT_TOOL.name,
  BROWSER_SCREENSHOT_TOOL.name,
  BROWSER_CONSOLE_TOOL.name,
  ...BROWSER_ACTION_TOOLS.map((t) => t.name),
]);

/** The look-only tools — all a read-only product (Heap Chat) is given. */
export const BROWSER_READ_TOOL_NAMES = new Set([
  BROWSER_OPEN_TOOL.name,
  BROWSER_SNAPSHOT_TOOL.name,
  BROWSER_SCREENSHOT_TOOL.name,
  BROWSER_CONSOLE_TOOL.name,
]);

/**
 * The tools to offer, given what the attached client and the model can do.
 * `actions: false` is Heap Chat: it can look at a page but never touch one,
 * the same promise it makes about the folder.
 */
export function browserTools(opts: { clientHasBrowser: boolean; vision: boolean; actions?: boolean }): ToolDefinition[] {
  if (!opts.clientHasBrowser) return [];
  const readOnly = opts.actions === false;
  return [
    BROWSER_OPEN_TOOL,
    // Without the action tools, a snapshot description that says "pass the
    // number to browser_click" has the model offering to fill in forms it
    // cannot touch.
    readOnly ? BROWSER_SNAPSHOT_READ_ONLY_TOOL : BROWSER_SNAPSHOT_TOOL,
    BROWSER_CONSOLE_TOOL,
    // A screenshot is useless to a model that cannot see it, and costs the
    // same context whether it is looked at or not.
    ...(opts.vision ? [BROWSER_SCREENSHOT_TOOL] : []),
    ...(readOnly ? [] : BROWSER_ACTION_TOOLS),
  ];
}

/**
 * Words that mean an action commits something — the idea from heapbrowse's
 * classifier (browser/src/agent/destructive.ts), cut down to what a dev page
 * needs. Word-boundary matched, so "Apply filters" is not a purchase. Tuned to
 * over-match: a false positive is one more confirmation, a false negative is a
 * dropped table on the dev database.
 *
 * Two tiers. A commit verb is a commit whatever follows it ("Delete order
 * history" deletes). A noun only suggests one, and loses to wording that says
 * the element goes somewhere rather than does something ("Payment history",
 * "Order details").
 */
const COMMIT_VERBS =
  /\b(buy|purchase|checkout|pay|transfer|send|delete|remove|destroy|drop|wipe|reset|revoke|unsubscribe|publish|deploy|donate|place order|clear all)\b/i;
const COMMIT_NOUNS = /\b(order|payment|subscribe|submit|confirm|cancel|sign up|register|book|reserve|archive)\b/i;
const NAVIGATIONAL =
  /\b(history|details?|status|list|page|settings|summary|options|methods?|info|overview|policy|terms|help|faq|view|learn more)\b/i;

function commits(label: string): boolean {
  if (COMMIT_VERBS.test(label)) return true;
  return COMMIT_NOUNS.test(label) && !NAVIGATIONAL.test(label);
}

/**
 * The permission class for one browser action: `execute`, like run_command —
 * or `destructive` for a click on something that reads like it commits
 * ("Delete project", "Pay now"), so the modes that auto-approve ordinary
 * actions still stop and ask for those.
 *
 * Only clicks are escalated, and only by their target's own words. Treating
 * every Enter as a commit would turn each search box into a destructive card,
 * and a card that is always red is one people stop reading.
 */
export function classifyBrowserAction(call: ToolCall, target: string | undefined): PermissionClass {
  if (call.name === 'browser_click' && target && commits(target)) return 'destructive';
  return 'execute';
}

/** The permission card's sentence: what will happen, to which element, where. */
export function describeBrowserAction(call: ToolCall, target: string | undefined, page: string | undefined): string {
  const args = call.args as { ref?: unknown; text?: unknown; option?: unknown; key?: unknown; submit?: unknown };
  const el = target ?? `element [${String(args.ref ?? '?')}] (not in the last snapshot)`;
  const where = page ? ` on ${page.replace(/^https?:\/\//, '').replace(/\/$/, '')}` : '';
  const quote = (v: unknown): string => JSON.stringify(String(v ?? '').slice(0, 120));
  switch (call.name) {
    case 'browser_click':
      return `Click ${el}${where}`;
    case 'browser_type':
      return `Type ${quote(args.text)} into ${el}${args.submit === true ? ' and press Enter' : ''}${where}`;
    case 'browser_select':
      return `Choose ${quote(args.option)} in ${el}${where}`;
    case 'browser_press':
      return `Press ${String(args.key ?? '')}${where}`;
    default:
      return call.name;
  }
}

/**
 * Whether the agent may open or read this address: http(s) on a loopback
 * host, or a name reserved for local development (`*.localhost`, `*.test`).
 * The heapcode host's own origin is excluded — that page holds the socket that
 * runs commands, and reading it is not checking your work.
 */
export function isLocalPage(raw: string, hostOrigin?: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (hostOrigin && url.origin === hostOrigin) return false;
  const host = url.hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test')
  );
}

/** A bare `localhost:5173` becomes a URL; anything else is left for isLocalPage to judge. */
export function normalizeLocalUrl(raw: string): string {
  const text = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
  return `http://${text.replace(/^0\.0\.0\.0/, 'localhost')}`;
}

export const NOT_LOCAL_MESSAGE =
  'The Browser tools only work on local pages (localhost, 127.0.0.1, *.localhost, *.test). ' +
  'For a public website, use fetch_url to read it as text.';

/** Snapshot text is capped: a long page must not eat the context window. */
export const SNAPSHOT_CHARS = 12_000;

/**
 * Run one browser_* call against whatever can answer `ui/browser` — shared by
 * Heap Code's session and Heap Chat's, which reach their page by different
 * method names but ask it the same question.
 *
 * The local-only rule is enforced here, on both sides of the round trip: the
 * URL the model asked for before navigating, and the URL the view reports it
 * is actually on before anything it read is returned — a local page can
 * redirect somewhere that is not, and the person can navigate the pane
 * anywhere between two tool calls. (The page checks again before acting.)
 */
export async function runBrowserTool(
  call: ToolCall,
  host: {
    /** Whether a client that can answer is attached right now. */
    available: boolean;
    request(params: Omit<UiBrowserParams, 'runId'>): Promise<UiBrowserResult>;
    /** Every answer that passed the local check — for the host's own bookkeeping. */
    onResult?(action: UiBrowserParams['action'], res: UiBrowserResult): void;
  },
): Promise<ToolResult> {
  const fail = (message: string): ToolResult => ({ id: call.id, name: call.name, content: message, isError: true });
  if (!host.available) {
    return fail('The Browser pane is not available — it needs the Heap Code desktop app to be open.');
  }
  const action = call.name.slice('browser_'.length) as UiBrowserParams['action'];
  const args = call.args as { ref?: unknown; text?: unknown; clear?: unknown; submit?: unknown; option?: unknown; key?: unknown };
  let url: string | undefined;
  if (action === 'open') {
    url = normalizeLocalUrl(String((call.args as { url?: unknown }).url ?? ''));
    if (!isLocalPage(url)) return fail(NOT_LOCAL_MESSAGE);
  }

  let res: UiBrowserResult;
  try {
    res = await host.request({
      callId: call.id,
      action,
      url,
      ref: args.ref === undefined ? undefined : String(args.ref).replace(/[[\]\s]/g, ''),
      text: args.text === undefined ? undefined : String(args.text),
      // Default to replacing: "type the email" means the field should hold the email.
      clear: args.clear !== false,
      submit: args.submit === true,
      option: args.option === undefined ? undefined : String(args.option),
      key: args.key === undefined ? undefined : String(args.key),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  if (!isLocalPage(res.url)) {
    return fail(`The Browser pane is on ${res.url || 'no page'}, which is not a local page. ${NOT_LOCAL_MESSAGE}`);
  }
  host.onResult?.(action, res);
  const where = `${res.title ? `"${res.title}" — ` : ''}${res.url}`;
  const ok = (content: string, images?: string[]): ToolResult => ({ id: call.id, name: call.name, content, images });
  const errorsNote = res.newErrors?.length
    ? `\nNew console errors:\n${res.newErrors.map((e) => `  ${e}`).join('\n')}`
    : '';

  switch (action) {
    case 'open':
      return res.loadError
        ? fail(`Could not load ${url}: ${res.loadError}. Is the dev server running?`)
        : ok(`Opened ${where}. Use browser_snapshot to read it or browser_console for errors.`);
    case 'snapshot': {
      const text = res.text ?? '';
      const clipped = text.length > SNAPSHOT_CHARS ? `${text.slice(0, SNAPSHOT_CHARS)}\n… (page text clipped)` : text;
      return ok(`Page: ${where}\n\n${clipped || '(the page has no visible text)'}`);
    }
    case 'screenshot':
      return res.image ? ok(`Screenshot of ${where}.`, [res.image]) : fail('The screenshot came back empty.');
    case 'console': {
      const lines = res.console ?? [];
      if (!lines.length) return ok(`Nothing logged on ${where}.`);
      const order = { error: 0, warning: 1, info: 2 } as const;
      const sorted = [...lines].sort((a, b) => order[a.level] - order[b.level]);
      return ok(
        `Console of ${where} (${lines.length} message${lines.length === 1 ? '' : 's'}):\n` +
          sorted.map((l) => `[${l.level}] ${l.message}${l.source ? `  (${l.source})` : ''}`).join('\n'),
      );
    }
    case 'click':
    case 'type':
    case 'select':
    case 'press': {
      const verb = { click: 'Clicked', type: 'Typed into', select: 'Chose an option in', press: `Pressed ${String(args.key)} on` }[action];
      const target = action === 'press' ? '' : ` ${res.acted ?? 'the element'}`;
      return ok(
        `${verb}${target}. Now on ${where}.${errorsNote}\n` +
          'Take a new browser_snapshot to see the result — element numbers may have changed.',
      );
    }
  }
}
