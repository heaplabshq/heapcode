import type { ToolCall, ToolResult } from '@heapcode/core/agent';
import { formatSnapshot, type Control, type PageSnapshot } from '../shared/snapshot.js';
import { describeChanges } from '../shared/delta.js';
import { ensurePage, sendToPage, waitForLoad } from '../sidepanel/page.js';
import type { ContentRequest } from '../content/index.js';
import { classifyClick, classifyNavigate, classifyType } from './destructive.js';
import type { Classification } from './destructive.js';

/**
 * Runs the agent's tool calls against the page.
 *
 * The analogue of heapcode's `WorkspaceToolExecutor`: the loop hands over a
 * `ToolCall` and gets a `ToolResult` back, and knows nothing about what
 * happened in between. That seam is why heapbrowse needs no loop of its own
 * (REUSE.md section 1) -- swapping `read_file` for `read_page` is the whole
 * change.
 *
 * Holding the last snapshot is what makes deltas possible: after the first read
 * the model gets what changed rather than the page again, which is the
 * difference between a ten-step run costing ten pages and costing one.
 */
export class BrowserToolExecutor {
  #last?: PageSnapshot;
  /** The user's request, used to rank controls so the relevant ones survive. */
  #intent: string;
  /** How long to wait for a navigation to land. Injectable so tests are fast. */
  #loadTimeoutMs: number;

  constructor(intent: string, options: { loadTimeoutMs?: number } = {}) {
    this.#intent = intent;
    this.#loadTimeoutMs = options.loadTimeoutMs ?? 15_000;
  }

  /** The most recent snapshot, for a host that wants to show what the agent saw. */
  get lastSnapshot(): PageSnapshot | undefined {
    return this.#last;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const fail = (content: string): ToolResult => ({
      id: call.id,
      name: call.name,
      content,
      isError: true,
    });
    const ok = (content: string): ToolResult => ({ id: call.id, name: call.name, content });

    try {
      switch (call.name) {
        case 'read_page':
          return await this.#readPage(call.args.full === true, ok, fail);
        case 'get_elements':
          return await this.#getElements(call.args, ok, fail);
        case 'extract_data':
          return await this.#extractData(call.args, ok, fail);
        case 'scroll':
          return await this.#scroll(call.args, ok, fail);
        case 'wait':
          return await this.#wait(call.args, ok, fail);
        case 'click':
        case 'type':
        case 'select':
        case 'navigate':
        case 'go_back':
          return await this.#act(call, ok, fail);
        default:
          return fail(`Unknown tool "${call.name}".`);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Perform a mutating action.
   *
   * The permission decision has already been made by the time this runs -- the
   * loop calls `requestPermission` first, and the host answers it using the
   * same classification computed here. This is the execution half only.
   */
  async #act(
    call: ToolCall,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const target = await ensurePage();
    if (!target.ok) return fail(target.reason);

    if (call.name === 'go_back') {
      const before = this.#last;
      const response = await sendToPage(target.tabId, { type: 'back' });
      if (!response.ok) return fail(response.error);
      return this.#observe(before, target.tabId, 'Went back.', ok);
    }

    if (call.name === 'navigate') {
      const url = String(call.args.url ?? '');
      if (!url) return fail('navigate needs a url.');
      let resolved: string;
      try {
        resolved = new URL(url, target.url).href;
      } catch {
        return fail(`"${url}" is not a URL that can be opened.`);
      }
      const before = this.#last;
      await chrome.tabs.update(target.tabId, { url: resolved });

      // Wait for the new document before doing anything else. The content
      // script did not survive the navigation, and `ensurePage` inside
      // `#observe` re-injects into whatever has actually arrived.
      const loaded = await waitForLoad(target.tabId, this.#loadTimeoutMs);
      if (!loaded) {
        this.#last = undefined;
        return ok(
          `Started navigating to ${resolved}, but the page had not finished loading. ` +
            `Read the page to see where it got to.`,
        );
      }
      return this.#observe(before, target.tabId, `Navigated to ${resolved}.`, ok);
    }

    const generation = this.#last?.generation;
    if (generation === undefined) {
      // Acting without having read is how a model guesses a handle number.
      return fail('Read the page first -- handles only exist after a read.');
    }
    const handle = Number(call.args.handle);
    if (!Number.isInteger(handle)) return fail(`"${call.args.handle}" is not a handle number.`);

    const request: ContentRequest =
      call.name === 'click'
        ? { type: 'click', handle, generation }
        : call.name === 'type'
          ? { type: 'type', handle, generation, text: String(call.args.text ?? '') }
          : { type: 'select', handle, generation, option: String(call.args.option ?? '') };

    const before = this.#last;
    const response = await sendToPage(target.tabId, request);
    if (!response.ok) return fail(response.error);
    if (response.kind !== 'acted') return fail('Unexpected reply from the page.');

    return this.#observe(before, target.tabId, response.note, ok);
  }

  /**
   * Look at what the action actually did, and say so.
   *
   * Without this the agent clicks, is told "handles are void, read again",
   * spends a turn reading, and only then learns whether anything happened. Worse
   * -- if it does not bother reading, it reports success for an action that did
   * nothing at all, which is the failure hardest to tell apart from a broken
   * agent (PRD section 7.3).
   *
   * A synthetic click on a page that ignores untrusted events returns perfectly
   * normally. The only way to know is to look.
   */
  async #observe(
    before: PageSnapshot | undefined,
    tabId: number,
    note: string,
    ok: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    // Give the page a moment to react before judging it. Without this every
    // action looks like a no-op on anything that re-renders asynchronously.
    await sendToPage(tabId, { type: 'settle', seconds: 2 });

    const after = await this.#snapshot();
    if (!after.ok) {
      // The page going away mid-action is itself the observation.
      this.#last = undefined;
      return ok(`${note} The page then became unreadable: ${after.reason}`);
    }

    this.#last = after.snapshot;

    if (!before) return ok(`${note}\n\n${formatSnapshot(after.snapshot, { intent: this.#intent })}`);

    if (before.url !== after.snapshot.url) {
      return ok(
        `${note} The page navigated to ${after.snapshot.url}.\n\n${formatSnapshot(after.snapshot, { intent: this.#intent })}`,
      );
    }

    const changes = describeChanges(before, after.snapshot, { intent: this.#intent });
    if (changes === 'Nothing on the page changed.') {
      // Reported plainly, and NOT retried. A page that ignored one synthetic
      // click will ignore the next one, and blind retries are how an agent
      // orders three of something.
      return ok(
        `${note} But nothing on the page changed, so the action appears to have had no effect. ` +
          `The page may ignore synthetic clicks, or the control may do nothing. Do not simply retry ` +
          `the same action -- look for another route, or tell the user it did not work.`,
      );
    }

    return ok(`${note}\n\n${changes}`);
  }

  /**
   * How dangerous this call is, decided from the page rather than the tool name.
   *
   * Returned to the host so the confirmation and the audit record describe the
   * same thing the executor is about to do.
   */
  async classify(call: ToolCall): Promise<{ classification: Classification; target?: Control; url?: string }> {
    const page = await ensurePage();
    const url = page.ok ? page.url : undefined;

    if (call.name === 'navigate') {
      return {
        classification: classifyNavigate(url ?? '', String(call.args.url ?? '')),
        url,
      };
    }
    if (call.name === 'go_back') return { classification: { permission: 'write' }, url };

    const control = this.#last?.controls.find((c) => c.handle === Number(call.args.handle));
    if (!control) {
      // Unknown target: assume the worst rather than the best.
      return {
        classification: {
          permission: 'destructive',
          reason: 'the target could not be identified from the last read of the page',
        },
        url,
      };
    }

    const classification =
      call.name === 'type' ? classifyType(control) : classifyClick(control);
    return { classification, target: control, url };
  }

  async #snapshot(): Promise<{ ok: true; snapshot: PageSnapshot } | { ok: false; reason: string }> {
    const target = await ensurePage();
    if (!target.ok) return { ok: false, reason: target.reason };

    const response = await sendToPage(target.tabId, { type: 'snapshot' });
    if (!response.ok) return { ok: false, reason: response.error };
    if (response.kind !== 'snapshot') return { ok: false, reason: 'Unexpected reply from the page.' };
    return { ok: true, snapshot: response.snapshot };
  }

  async #readPage(
    full: boolean,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const result = await this.#snapshot();
    if (!result.ok) return fail(result.reason);

    const previous = this.#last;
    this.#last = result.snapshot;

    if (full || !previous) {
      return ok(formatSnapshot(result.snapshot, { intent: this.#intent }));
    }
    return ok(describeChanges(previous, result.snapshot, { intent: this.#intent }));
  }

  async #getElements(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const result = await this.#snapshot();
    if (!result.ok) return fail(result.reason);
    this.#last = result.snapshot;

    const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : undefined;
    const role = typeof args.role === 'string' ? args.role : undefined;

    const matches = result.snapshot.controls.filter((control) => {
      if (role && control.role !== role) return false;
      if (!filter) return true;
      return `${control.name} ${control.context ?? ''}`.toLowerCase().includes(filter);
    });

    if (matches.length === 0) {
      // Say what was searched, so the model narrows rather than repeating the
      // same call with the same words.
      const scope = [role && `role ${role}`, filter && `matching "${filter}"`]
        .filter(Boolean)
        .join(' ');
      return ok(
        `No controls ${scope || 'found'} on this page. It has ${result.snapshot.controls.length} controls in total; call read_page to see them.`,
      );
    }

    return ok(
      [
        `${matches.length} control(s) on ${result.snapshot.url}:`,
        ...matches.map((c) => `  ${describeControl(c)}`),
      ].join('\n'),
    );
  }

  async #extractData(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const result = await this.#snapshot();
    if (!result.ok) return fail(result.reason);
    this.#last = result.snapshot;

    const tables = result.snapshot.tables;
    if (tables.length === 0) {
      return ok(
        'This page has no table with column headers. Use read_page and pull the values out of the ' +
          'text and controls instead.',
      );
    }

    const index = typeof args.table === 'number' ? args.table : 0;
    const table = tables[index];
    if (!table) {
      return fail(`There is no table ${index}. The page has ${tables.length}.`);
    }

    const limit = typeof args.limit === 'number' ? Math.min(args.limit, 200) : 50;
    const rows = table.sample.slice(0, limit);
    const note =
      table.rows > rows.length
        ? `\n(${rows.length} of ${table.rows} rows -- the snapshot samples the leading rows; scroll for more.)`
        : '';

    return ok(
      [
        `${table.label ?? 'table'}: ${table.rows} rows x ${table.columns} columns`,
        table.headers.join(' | '),
        ...rows.map((row) => row.join(' | ')),
      ].join('\n') + note,
    );
  }

  async #scroll(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const direction = args.direction;
    if (direction !== 'down' && direction !== 'up' && direction !== 'top' && direction !== 'bottom') {
      return fail('scroll needs a direction of "down", "up", "top" or "bottom".');
    }

    const target = await ensurePage();
    if (!target.ok) return fail(target.reason);

    const request: ContentRequest = {
      type: 'scroll',
      direction,
      pages: typeof args.pages === 'number' ? args.pages : undefined,
    };
    const response = await sendToPage(target.tabId, request);
    if (!response.ok) return fail(response.error);
    if (response.kind !== 'snapshot') return fail('Unexpected reply from the page.');

    const previous = this.#last;
    this.#last = response.snapshot;

    // Scrolling to the same place is how an agent loops forever on a page that
    // has hit its end, so it is reported as the fact it is.
    if (previous && previous.viewport.scrollY === response.snapshot.viewport.scrollY) {
      return ok(
        `The page did not move -- already at ${response.snapshot.viewport.scrollY} of ${response.snapshot.viewport.scrollHeight}. There is nothing further in that direction.`,
      );
    }

    if (!previous) return ok(formatSnapshot(response.snapshot, { intent: this.#intent }));
    return ok(describeChanges(previous, response.snapshot, { intent: this.#intent }));
  }

  async #wait(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const target = await ensurePage();
    if (!target.ok) return fail(target.reason);

    const seconds = typeof args.seconds === 'number' ? args.seconds : 3;
    const response = await sendToPage(target.tabId, { type: 'settle', seconds });
    if (!response.ok) return fail(response.error);
    if (response.kind !== 'settled') return fail('Unexpected reply from the page.');

    return ok(
      response.settled
        ? `The page settled after ${response.waitedMs}ms. Read it again to see the current state.`
        : `The page was still changing after ${response.waitedMs}ms. It may be loading continuously.`,
    );
  }
}

function describeControl(control: Control): string {
  const parts = [`[${control.handle}]`, control.role, JSON.stringify(control.name)];
  if (control.value !== undefined) parts.push(`value=${JSON.stringify(control.value)}`);
  if (control.options?.length) parts.push(`options: ${control.options.join('|')}`);
  if (control.href) parts.push(`-> ${control.href}`);
  if (control.checked !== undefined) parts.push(control.checked ? 'checked' : 'unchecked');
  if (control.disabled) parts.push('DISABLED');
  if (control.context) parts.push(`(${control.context})`);
  return parts.join('  ');
}
