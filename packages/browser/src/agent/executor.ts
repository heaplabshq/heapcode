import type { ToolCall, ToolResult } from '@heapcode/core/agent';
import { formatSnapshot, type Control, type PageSnapshot } from '../shared/snapshot.js';
import { describeChanges } from '../shared/delta.js';
import { ensurePage, sendToPage } from '../sidepanel/page.js';
import type { ContentRequest } from '../content/index.js';

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

  constructor(intent: string) {
    this.#intent = intent;
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
        default:
          return fail(`Unknown tool "${call.name}".`);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
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
