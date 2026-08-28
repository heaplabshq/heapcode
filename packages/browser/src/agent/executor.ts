import type { ToolCall, ToolResult } from '@heapcode/core/agent';
import { formatSnapshot, type Control, type PageSnapshot } from '../shared/snapshot.js';
import { describeChanges } from '../shared/delta.js';
import { currentTab, tabTarget, waitForLoad } from '../sidepanel/page.js';
import { DriverPool } from './driverPool.js';
import type { PageDriver } from './drivers.js';
import {
  classifyClick,
  classifyNavigate,
  classifyPress,
  classifyType,
  worstOf,
} from './destructive.js';
import type { Classification } from './destructive.js';
import { parseKey, KNOWN_KEYS } from './keys.js';
import { matchAll, PROFILE_FIELDS, type UserProfile } from '../shared/profile.js';
import { canDownload } from '../shared/settings.js';
import { mergeTable, sameHeaders, type Dataset } from '../shared/dataset.js';
import { RepetitionGuard } from './repetition.js';
import { findNextControl, nextIsExhausted, nextPageUrl } from './pagination.js';

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
/** Tools that change the page. Repetition means something different for these. */
const MUTATING = new Set([
  'click',
  'type',
  'fill_form',
  'autofill_form',
  'select',
  'press_key',
  'drag',
  'navigate',
  'go_back',
  'next_page',
  'open_tab',
  'close_tab',
  'switch_tab',
  'attach_file',
  'download',
]);

export class BrowserToolExecutor {
  /**
   * The last snapshot of each tab the run has read, keyed by tab.
   *
   * One field was enough while a run could only ever be in one tab. It is not
   * now: handles are minted per tab, so `[12]` in the results tab and `[12]` in
   * the product tab are different elements, and a single `#last` would hand the
   * second tab's handle to the first tab's driver. Keeping them apart also means
   * switching back to a tab restores what the agent already knew about it,
   * instead of paying for a fresh read.
   */
  #snapshots = new Map<number, PageSnapshot>();
  /**
   * The page text already handed to the model, per tab.
   *
   * `get_page_text` returns up to sixty thousand characters and had no memory
   * of having done so, so a run that read a page, looked at it another way, and
   * came back paid for the same sixty thousand characters twice. That is by far
   * the largest thing that enters the context on this product, and it was the
   * one entering it repeatedly -- a page read three times cost more than every
   * other step of the run put together.
   *
   * Keyed by tab for the same reason the snapshots are: two tabs are two pages,
   * and having read one says nothing about the other.
   */
  #delivered = new Map<number, string>();
  /**
   * Tabs whose model has been told it already has the text.
   *
   * Told once, then given it. The context can be compacted out from under a
   * long run, and a model that has genuinely lost the page must be able to get
   * it back -- being refused twice with "you already have this" when it demonstrably
   * does not is how a run stalls with nothing to work from.
   */
  #reminded = new Set<number>();
  /** The tab the snapshots above are being read and written against. */
  #tabId?: number;

  get #last(): PageSnapshot | undefined {
    return this.#tabId === undefined ? undefined : this.#snapshots.get(this.#tabId);
  }

  set #last(snapshot: PageSnapshot | undefined) {
    if (this.#tabId === undefined) return;
    if (snapshot) this.#snapshots.set(this.#tabId, snapshot);
    else this.#snapshots.delete(this.#tabId);
  }

  /** The user's request, used to rank controls so the relevant ones survive. */
  #intent: string;
  /** How long to wait for a navigation to land. Injectable so tests are fast. */
  #loadTimeoutMs: number;
  #pool: DriverPool;
  /** Absolute paths the agent may attach, configured by the user. */
  #files: string[];
  /**
   * The user's saved details, held here and never passed to the model.
   *
   * The substitution happens inside the executor, after the permission decision
   * and after the confirmation the user read. The model asks for "Email address"
   * and is told an email address was filled in; it never learns which one.
   */
  #profile: UserProfile;
  /** Hands the panel a picture of the page. Shown to the user every read. */
  #onView?: (dataUrl: string) => void;
  /**
   * Whether the page has been read since it last changed.
   *
   * The camera is the most expensive tool on the belt -- an image goes into the
   * context and is carried for every turn after it -- and the model reaches for
   * it out of habit, right after a read that already answered the question. So
   * the first such request is turned down with a reminder of what it already
   * has. Asking again goes through: a chart, a canvas or a layout question is a
   * real reason, and a tool that can be refused twice is a tool the model stops
   * trusting and stops using when it genuinely needs it.
   */
  #readSinceAction = false;
  #pictureRefused = false;
  /** Hands the panel the accumulated rows. Shown to the user, never to the model. */
  #onData?: (dataset: Dataset) => void;
  /**
   * Rows collected so far this run.
   *
   * Here rather than in the transcript, which is the whole point: page five is
   * reasoned about against a count, not against a re-sent copy of pages one to
   * four. The user gets the table; the model gets a receipt.
   */
  #dataset?: Dataset;
  /**
   * Whether the run is getting anywhere.
   *
   * Core has no repetition detection and its step limit is a hundred turns, so
   * an agent that has started going in circles does so expensively and without
   * anyone being told. See repetition.ts for the run this was written from.
   */
  #repetition = new RepetitionGuard();

  constructor(
    intent: string,
    options: {
      loadTimeoutMs?: number;
      pool?: DriverPool;
      files?: string[];
      profile?: UserProfile;
      onView?: (dataUrl: string) => void;
      onData?: (dataset: Dataset) => void;
    } = {},
  ) {
    this.#intent = intent;
    this.#loadTimeoutMs = options.loadTimeoutMs ?? 15_000;
    this.#pool = options.pool ?? new DriverPool(false);
    this.#files = options.files ?? [];
    this.#profile = options.profile ?? {};
    this.#onView = options.onView;
    this.#onData = options.onData;
  }

  /**
   * Show the user what the agent just did.
   *
   * After an action, and no longer after a read. A read produces a photograph
   * of the page the user already has open in front of them, and it was being
   * taken on every `read_page` and every `get_page_text` -- several hundred
   * kilobytes of CDP capture per step, for a picture that now sits behind a
   * collapsed chip inside a collapsed run. What a picture is actually for here
   * is the product's core question, "what did it just do", and that has an
   * answer only where the page changed.
   *
   * Best-effort and fire-and-forget: a missing picture is a cosmetic loss, and
   * waiting on one would slow every step of the run.
   */
  async #capture(): Promise<void> {
    if (!this.#onView) return;
    const target = await this.#pool.forActiveTab();
    if (!target.ok || !target.driver.screenshot) return;
    const shot = await target.driver.screenshot();
    if (shot) this.#onView(shot);
  }

  /** Which path is in use, for the panel to show and the audit log to record. */
  async driverKind(): Promise<'cdp' | 'dom' | 'none'> {
    const target = await this.#pool.forActiveTab();
    return target.ok ? target.driver.kind : 'none';
  }

  /** The most recent snapshot, for a host that wants to show what the agent saw. */
  get lastSnapshot(): PageSnapshot | undefined {
    return this.#last;
  }

  /**
   * Forget everything read so far, because someone else changed the page.
   *
   * Called after the user has taken a turn at the keyboard. They may have
   * logged in, dismissed a wall, picked a file, or navigated somewhere else
   * entirely -- and every snapshot, every handle in it, and every claim about
   * what the page text says belongs to a page that no longer exists.
   *
   * Cheaper alternatives are all wrong. Keeping the snapshot leaves the model
   * addressing controls by handles that now point at different elements or at
   * nothing; keeping the delivered text means the next `get_page_text` answers
   * "this has not changed" about a page that has changed completely.
   */
  forgetPage(): void {
    this.#snapshots.clear();
    this.#delivered.clear();
    this.#reminded.clear();
    this.#readSinceAction = false;
    this.#pictureRefused = false;
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
      const result = await this.#dispatch(call, ok, fail);
      return this.#guard(call, result, fail);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Notice a run going in circles, and say so in the result it asked for.
   *
   * Never applied to an action: a click repeated is a different question (the
   * no-op detection in `#observe` covers that, and blind retries are already
   * refused there), and a failed call is not a loop -- it is a failure, and the
   * error explains itself.
   */
  #guard(call: ToolCall, result: ToolResult, fail: (s: string) => ToolResult): ToolResult {
    if (MUTATING.has(call.name)) {
      this.#repetition.acted();
      return result;
    }
    if (result.isError) return result;

    const verdict = this.#repetition.check(call.name, call.args, result.content);
    if (verdict.kind === 'refuse') return fail(verdict.reason);
    // Warned, not withheld. The model asked a legitimate question and gets its
    // answer; the observation rides along with it.
    if (verdict.kind === 'warn') return { ...result, content: `${result.content}\n\n${verdict.note}` };
    return result;
  }

  async #dispatch(
    call: ToolCall,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    {
      switch (call.name) {
        case 'read_page':
          return await this.#readPage(call.args.full === true, ok, fail);
        case 'get_page_text':
          return await this.#pageText(call.args, ok, fail);
        case 'screenshot': {
          const shot = await this.#screenshot(ok, fail);
          // Keep the call's own id so the tool message pairs correctly.
          return { ...shot, id: call.id, name: call.name };
        }
        case 'get_elements':
          return await this.#getElements(call.args, ok, fail);
        case 'extract_data':
          return await this.#extractData(call.args, ok, fail);
        case 'scroll':
          return await this.#scroll(call.args, ok, fail);
        case 'wait':
          return await this.#wait(call.args, ok, fail);
        case 'hover':
          return await this.#hover(call.args, ok, fail);
        case 'press_key':
          return await this.#pressKey(call.args, ok, fail);
        case 'drag':
          return await this.#drag(call.args, ok, fail);
        case 'fill_form':
          return await this.#fillForm(call.args, ok, fail);
        case 'autofill_form':
          return await this.#autofill(ok, fail);
        case 'next_page':
          return await this.#nextPage(ok, fail);
        case 'download':
          return await this.#download(call.args, ok, fail);
        case 'list_tabs':
          return await this.#listTabs(ok);
        case 'switch_tab':
          return await this.#switchTab(call.args, ok, fail);
        case 'open_tab':
          return await this.#openTab(call.args, ok, fail);
        case 'close_tab':
          return await this.#closeTab(call.args, ok, fail);
        case 'click':
        case 'type':
        case 'select':
        case 'navigate':
        case 'go_back':
          return await this.#act(call, ok, fail);
        case 'attach_file':
          return await this.#attachFile(call, ok, fail);
        default:
          return fail(`Unknown tool "${call.name}".`);
      }
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
    // Navigation only needs the tab, never permission to read what is on it.
    // Requiring the latter turned any redirect to an ungranted site into a trap
    // with no way back.
    const leaving = call.name === 'navigate' || call.name === 'go_back';
    const target = leaving ? await this.#addressOnly() : await this.#pool.forActiveTab();
    if (!target.ok) return fail(target.reason);

    if (call.name === 'go_back') {
      const before = this.#last;
      // `chrome.tabs.goBack` rather than the content script: the script may not
      // be in the page at all, which is exactly the case where going back
      // matters most.
      try {
        await chrome.tabs.goBack(target.tabId);
      } catch {
        return fail('There is nothing to go back to in this tab.');
      }
      await waitForLoad(target.tabId, this.#loadTimeoutMs);
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

    const driven = await this.#pool.forActiveTab();
    if (!driven.ok) return fail(driven.reason);

    const before = this.#last;
    const result =
      call.name === 'click'
        ? await driven.driver.click(handle, generation)
        : call.name === 'type'
          ? await driven.driver.type(handle, generation, String(call.args.text ?? ''))
          : await driven.driver.select(handle, generation, String(call.args.option ?? ''));

    if (!result.ok) return fail(result.error);
    return this.#observe(before, driven.tabId, result.note, ok);
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
    // The action has happened, so whatever was read before it is stale --
    // including on the paths below that never get a fresh snapshot.
    this.#readSinceAction = false;
    this.#pictureRefused = false;

    // Give the page a moment to react before judging it. Without this every
    // action looks like a no-op on anything that re-renders asynchronously.
    const settling = await this.#pool.forActiveTab();
    if (settling.ok) await settling.driver.settle(2);

    const after = await this.#snapshot();
    if (!after.ok) {
      // The page going away mid-action is itself the observation.
      this.#last = undefined;
      return ok(`${note} The page then became unreadable: ${after.reason}`);
    }

    this.#last = after.snapshot;
    await this.#capture();

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
  async classify(call: ToolCall): Promise<{
    classification: Classification;
    target?: Control;
    url?: string;
    /**
     * What to show the user instead of the generic description.
     *
     * Needed once a call's real effect is decided here rather than being visible
     * in its arguments: `autofill_form` takes no arguments at all, and a
     * `fill_form` field may name a saved detail whose value the model does not
     * have. The user still has to see exactly what is about to be typed, so the
     * executor -- which does know -- writes that line.
     */
    describe?: string;
  }> {
    // Only the address is needed here, and asking for read permission to
    // classify an action would make an ungranted page unclassifiable rather
    // than merely unreadable.
    const page = await this.#addressOnly();
    const url = page.ok ? page.url : undefined;

    if (call.name === 'navigate' || call.name === 'open_tab') {
      // A new tab is a navigation that happens to keep the old page. Leaving the
      // site is the part that matters, and it matters identically either way.
      return {
        classification: classifyNavigate(url ?? '', String(call.args.url ?? '')),
        url,
      };
    }
    if (call.name === 'go_back' || call.name === 'close_tab') {
      return { classification: { permission: 'write' }, url };
    }

    if (call.name === 'download') {
      const control =
        call.args.handle === undefined
          ? undefined
          : this.#last?.controls.find((c) => c.handle === Number(call.args.handle));
      return {
        classification: { permission: 'write' },
        target: control,
        url,
        describe: `download ${control?.href ?? String(call.args.url ?? '')}`,
      };
    }

    if (call.name === 'next_page') {
      const control = findNextControl(this.#last?.controls ?? []);
      return {
        classification: control ? classifyClick(control) : { permission: 'write' },
        target: control,
        url,
        describe: control ? `the next page, via "${control.name}"` : 'the next page',
      };
    }

    if (call.name === 'press_key') {
      const key = parseKey(String(call.args.key ?? ''))?.key ?? '';
      const focused =
        call.args.handle === undefined
          ? undefined
          : this.#last?.controls.find((c) => c.handle === Number(call.args.handle));
      return {
        classification: classifyPress(key, focused, this.#last?.controls ?? []),
        target: focused,
        url,
      };
    }

    if (call.name === 'autofill_form') {
      const matches = matchAll(this.#last?.controls ?? [], this.#profile);
      if (matches.length === 0) {
        return { classification: { permission: 'write' }, url, describe: 'nothing that matches' };
      }
      return {
        classification: worstOf(matches.map((match) => classifyType(match.control))),
        url,
        // Every field and the actual value. This is the user's own data on the
        // user's own screen, and "fills 6 fields from your details" is not
        // something anyone can check before approving it.
        describe: `${matches.length} field(s) from your saved details:\n${matches
          .map((match) => `  "${match.control.name}" <- ${JSON.stringify(match.value)}`)
          .join('\n')}`,
      };
    }

    if (call.name === 'fill_form') {
      const fields = Array.isArray(call.args.fields) ? call.args.fields : [];
      const controls = fields.map((entry) => {
        const handle = Number((entry as { handle?: unknown }).handle);
        return this.#last?.controls.find((c) => c.handle === handle);
      });
      // One unknown field is enough to treat the whole batch as unknown: the
      // user is approving the batch, and a batch is only as identified as its
      // least identified member.
      if (controls.some((control) => !control)) {
        return {
          classification: {
            permission: 'destructive',
            reason: 'one of the fields could not be identified from the last read of the page',
          },
          url,
        };
      }
      const lines = fields.map((entry, index) => {
        const field = entry as { handle?: unknown; value?: unknown; detail?: unknown };
        const resolved =
          typeof field.detail === 'string' ? this.#detail(field.detail) : undefined;
        const shown = resolved ? resolved.value : String(field.value ?? '');
        const name = controls[index]?.name;
        return `  ${name ? JSON.stringify(name) : `[${String(field.handle)}]`} <- ${JSON.stringify(shown)}`;
      });

      return {
        classification: worstOf(controls.map((control) => classifyType(control!))),
        url,
        describe: `${fields.length} field(s):\n${lines.join('\n')}`,
      };
    }

    if (call.name === 'drag') {
      const from = this.#last?.controls.find((c) => c.handle === Number(call.args.from));
      return { classification: { permission: 'write' }, target: from, url };
    }

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
    const target = await this.#pool.forActiveTab();
    if (!target.ok) return { ok: false, reason: target.reason };
    // Everything read or written through `#last` from here belongs to this tab.
    this.#tabId = target.tabId;
    try {
      return { ok: true, snapshot: await target.driver.snapshot() };
    } catch (error) {
      if (DriverPool.isLostSession(error)) {
        // The pool has already switched to the DOM driver; one retry lands there.
        const retry = await this.#pool.forActiveTab();
        if (retry.ok) return { ok: true, snapshot: await retry.driver.snapshot() };
      }
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Attach a file the user has configured.
   *
   * Only possible over CDP: `input.files` cannot be set from page context by
   * design, which is why the PRD (section 7.4) kept uploads out of v1 entirely.
   * The model chooses *which* configured file, never a path -- a model that
   * could name arbitrary paths could read arbitrary files off the machine.
   */
  async #attachFile(
    call: ToolCall,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    if (this.#files.length === 0) {
      return fail(
        'No files are configured for attachment. Ask the user to add one in Settings, or ask them ' +
          'to attach it themselves.',
      );
    }

    const target = await this.#pool.forActiveTab();
    if (!target.ok) return fail(target.reason);
    if (!target.driver.attachFiles) {
      return fail(
        'Attaching files needs the debugger, which is not active on this tab. Ask the user to turn ' +
          'it on in Settings, or to attach the file themselves.',
      );
    }

    const generation = this.#last?.generation;
    if (generation === undefined) return fail('Read the page first.');
    const handle = Number(call.args.handle);
    if (!Number.isInteger(handle)) return fail(`"${call.args.handle}" is not a handle number.`);

    const wanted = String(call.args.file ?? '');
    const path =
      this.#files.find((candidate) => candidate.endsWith(wanted)) ??
      (this.#files.length === 1 ? this.#files[0] : undefined);
    if (!path) {
      return fail(
        `No configured file matches "${wanted}". Available: ${this.#files.join(', ')}`,
      );
    }

    const result = await target.driver.attachFiles(handle, generation, [path]);
    if (!result.ok) return fail(result.error);
    return this.#observe(this.#last, target.tabId, result.note, ok);
  }

  /**
   * The tab's address, without needing permission to read what is on it.
   *
   * Follows the run's pinned tab when there is one. Leaving a page must never
   * need that page's consent, which is why this exists separately from
   * `forActiveTab` -- an application that redirects to an ungranted portal
   * would otherwise be a trap with no way back.
   */
  async #addressOnly(): Promise<{ ok: true; tabId: number; url: string } | { ok: false; reason: string }> {
    const pinned = this.#pool.target;
    if (pinned !== undefined) {
      const target = await tabTarget(pinned);
      if (target.ok) return target;
    }
    return currentTab();
  }

  async #hover(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const generation = this.#last?.generation;
    if (generation === undefined) return fail('Read the page first -- handles only exist after a read.');
    const handle = Number(args.handle);
    if (!Number.isInteger(handle)) return fail(`"${args.handle}" is not a handle number.`);

    const target = await this.#pool.forActiveTab();
    if (!target.ok) return fail(target.reason);

    const before = this.#last;
    const result = await target.driver.hover(handle, generation);
    if (!result.ok) return fail(result.error);
    // A hover that opened nothing is worth saying so: the model's next move is
    // to click instead, not to hover again.
    return this.#observe(before, target.tabId, result.note, ok);
  }

  async #pressKey(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const press = parseKey(String(args.key ?? ''));
    if (!press) {
      return fail(
        `"${String(args.key ?? '')}" is not a key I can press. Use one of ${KNOWN_KEYS.join(', ')}, ` +
          `a single character, or a chord such as "Ctrl+A".`,
      );
    }

    const target = await this.#pool.forActiveTab();
    if (!target.ok) return fail(target.reason);

    let handle: number | undefined;
    if (args.handle !== undefined && args.handle !== null) {
      const parsed = Number(args.handle);
      if (!Number.isInteger(parsed)) return fail(`"${args.handle}" is not a handle number.`);
      if (this.#last?.generation === undefined) return fail('Read the page first.');
      handle = parsed;
    }

    const before = this.#last;
    const result = await target.driver.press(press, handle, this.#last?.generation);
    if (!result.ok) return fail(result.error);
    return this.#observe(before, target.tabId, result.note, ok);
  }

  async #drag(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const generation = this.#last?.generation;
    if (generation === undefined) return fail('Read the page first.');
    const from = Number(args.from);
    const to = Number(args.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      return fail('drag needs a "from" handle and a "to" handle.');
    }

    const target = await this.#pool.forActiveTab();
    if (!target.ok) return fail(target.reason);
    if (!target.driver.drag) {
      return fail(
        'Dragging needs the debugger, which is not active on this tab. A synthetic drag is ignored ' +
          'by every implementation worth dragging in, so this is refused rather than pretended. ' +
          'Ask the user to turn the debugger on in Settings, or to do the drag themselves.',
      );
    }

    const before = this.#last;
    const result = await target.driver.drag(from, to, generation);
    if (!result.ok) return fail(result.error);
    return this.#observe(before, target.tabId, result.note, ok);
  }

  /**
   * Fill a batch of fields, stopping at the first one that fails.
   *
   * Stopping rather than pressing on, because the fields of a form are rarely
   * independent: a country dropdown decides which state list exists, and
   * carrying on past a failure fills the rest of the form against assumptions
   * that no longer hold. What has already been entered is reported by name, so
   * the model retries the remainder rather than the whole thing.
   */
  async #fillForm(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const fields = Array.isArray(args.fields) ? args.fields : [];
    if (fields.length === 0) return fail('fill_form needs at least one field.');

    const generation = this.#last?.generation;
    if (generation === undefined) return fail('Read the page first -- handles only exist after a read.');

    const target = await this.#pool.forActiveTab();
    if (!target.ok) return fail(target.reason);

    const before = this.#last;
    const filled: string[] = [];

    for (const entry of fields) {
      const field = entry as { handle?: unknown; value?: unknown; detail?: unknown };
      const handle = Number(field.handle);
      if (!Number.isInteger(handle)) {
        return this.#partial(filled, `"${String(field.handle)}" is not a handle number.`, fail);
      }

      const control = this.#last?.controls.find((candidate) => candidate.handle === handle);

      // A detail reference is resolved here and nowhere else. The model asked
      // for "Email address" and never receives the address itself.
      let value: string;
      let from = '';
      if (typeof field.detail === 'string' && field.detail.trim()) {
        const resolved = this.#detail(field.detail);
        if (!resolved) {
          return this.#partial(
            filled,
            `There is no saved detail called "${field.detail}". Saved: ${this.#savedLabels().join(', ') || 'none'}.`,
            fail,
          );
        }
        value = resolved.value;
        from = ` from your saved ${resolved.label.toLowerCase()}`;
      } else {
        value = String(field.value ?? '');
      }

      const result =
        control?.role === 'select'
          ? await target.driver.select(handle, generation, value)
          : await target.driver.type(handle, generation, value);

      if (!result.ok) return this.#partial(filled, result.error, fail);
      filled.push(`${control?.name ? `"${control.name}"` : `[${handle}]`}${from}`);
    }

    return this.#observe(
      before,
      target.tabId,
      `Filled ${filled.length} field(s): ${filled.join(', ')}.`,
      ok,
    );
  }

  /**
   * Advance a list by one page.
   *
   * The control first when the page has a real one, because clicking what the
   * page provides works on sites whose paging is entirely client-side and never
   * touches the address. The URL second, which is the more precise route but
   * only exists when the page put the number there in the first place.
   *
   * Saying "there is no next page" is a first-class outcome, not a failure. A
   * collection loop needs a stop signal, and an error here reads to a model as
   * something to work around.
   */
  async #nextPage(
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const snapshot = this.#last;
    if (!snapshot) return fail('Read the page first, so I can see how this list paginates.');

    const target = await this.#pool.forActiveTab();
    if (!target.ok) return fail(target.reason);

    const control = findNextControl(snapshot.controls);
    if (control) {
      const before = this.#last;
      const result = await target.driver.click(control.handle, snapshot.generation);
      if (!result.ok) return fail(result.error);
      // Paging usually replaces the list in place rather than navigating, so
      // the wait matters more here than for an ordinary click.
      await target.driver.settle(3);
      return this.#observe(
        before,
        target.tabId,
        `Went to the next page using "${control.name}". Call extract_data to add this page to what ` +
          `you have collected.`,
        ok,
      );
    }

    if (nextIsExhausted(snapshot.controls)) {
      return ok(
        'This is the last page — the next control is there but disabled. Stop paginating and use ' +
          'what you have collected.',
      );
    }

    const url = nextPageUrl(snapshot.url, snapshot.tables[0]?.sample.length);
    if (url) {
      const before = this.#last;
      await chrome.tabs.update(target.tabId, { url });
      const loaded = await waitForLoad(target.tabId, this.#loadTimeoutMs);
      if (!loaded) {
        this.#last = undefined;
        return ok(`Started loading ${url}, but it had not finished. Read the page to see where it got to.`);
      }
      return this.#observe(
        before,
        target.tabId,
        `Went to the next page by changing the page number in the address (${url}). Call ` +
          `extract_data to add it. If this page shows the same rows as the last one, the list has ` +
          `ended.`,
        ok,
      );
    }

    // Third route: the list has no pages at all and simply grows as you reach
    // the bottom. Left to the model this was the worst of the three -- "scroll
    // and see" has no stopping rule, so it either gave up after one screen or
    // scrolled a feed forever. Growth is measurable, so measure it.
    const grew = await this.#scrollForMore(target.driver, snapshot);
    if (grew.added > 0) {
      this.#last = grew.snapshot;
      // More of the list exists than the model has read, so it is not reading
      // a page it has already seen.
      this.#readSinceAction = false;
      this.#pictureRefused = false;
      await this.#capture();
      return ok(
        `This list has no pages — it loads more as you scroll. Scrolled down and ${grew.added} more ` +
          `control(s) appeared. Call extract_data to add what is now on the page, then next_page ` +
          `again for more.`,
      );
    }

    this.#last = grew.snapshot;
    return ok(
      'There is no next page: no pagination control, no page number in the address, and scrolling ' +
        'to the bottom loaded nothing new. This is the whole list. Stop paginating and use what you ' +
        'have collected.',
    );
  }

  /**
   * Scroll to the bottom and see whether the page put anything there.
   *
   * Two scrolls, not one. A single scroll to the bottom fires the page's
   * loader and returns before it has finished, so the measurement is taken
   * against a page that is still fetching and reports no growth on a list that
   * was about to grow. The settle between them is the fix, and it is the same
   * network-and-DOM-quiet wait every other action uses.
   *
   * Growth is counted in controls rather than in pixels: a page whose height
   * changed because a footer advert loaded has not given us more list.
   */
  async #scrollForMore(
    driver: { scroll: PageDriver['scroll']; settle: PageDriver['settle'] },
    before: PageSnapshot,
  ): Promise<{ snapshot: PageSnapshot; added: number }> {
    const seen = new Set(before.controls.map((control) => control.handle));

    for (let attempt = 0; attempt < 2; attempt++) {
      const scrolled = await driver.scroll('bottom', 1);
      await driver.settle(3);
      if ('ok' in scrolled) continue;

      const added = scrolled.controls.filter((control) => !seen.has(control.handle)).length;
      if (added > 0) return { snapshot: scrolled, added };
      // Keep the newest view even when nothing arrived, so the caller is not
      // holding a snapshot from before the scroll.
      if (attempt === 1) return { snapshot: scrolled, added: 0 };
    }

    return { snapshot: before, added: 0 };
  }

  /**
   * Save something the page is offering.
   *
   * Resolved from the page, never from the model's imagination: a handle
   * becomes that element's own `href`, and a bare URL is made absolute against
   * the page it came from. Chrome names the file from the response, which is
   * both more accurate than anything guessable here and one less thing the
   * model gets to choose.
   */
  async #download(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const here = await this.#addressOnly();
    const base = here.ok ? here.url : undefined;

    let raw: string | undefined;
    if (args.handle !== undefined && args.handle !== null) {
      const handle = Number(args.handle);
      if (!Number.isInteger(handle)) return fail(`"${args.handle}" is not a handle number.`);
      const control = this.#last?.controls.find((candidate) => candidate.handle === handle);
      if (!control) return fail(`No element with handle [${handle}]. Read the page first.`);
      if (!control.href) {
        return fail(
          `"${control.name}" is not a link to a file. If it downloads by script rather than by ` +
            `address, click it instead.`,
        );
      }
      raw = control.href;
    } else if (typeof args.url === 'string' && args.url.trim()) {
      raw = args.url.trim();
    } else {
      return fail('download needs the handle of a link, or a url.');
    }

    let resolved: string;
    try {
      resolved = new URL(raw, base).href;
    } catch {
      return fail(`"${raw}" is not a URL that can be downloaded.`);
    }
    if (!/^https?:$/.test(new URL(resolved).protocol)) {
      return fail('Only http and https addresses can be downloaded.');
    }

    // Optional, and asked for in Settings. The model cannot ask on its own --
    // `permissions.request` needs a user gesture and a tool call is not one --
    // so the failure names where the switch is rather than pretending it can.
    if (!(await canDownload())) {
      return fail(
        'heapbrowse has not been allowed to save files. Ask the user to turn on "Let it save ' +
          'files" in Settings, or give them the link and let them save it themselves.',
      );
    }

    try {
      const id = await chrome.downloads.download({ url: resolved });
      return ok(
        `Started downloading ${resolved} (download ${id}). It goes to the user's usual downloads ` +
          `folder; you cannot read it back.`,
      );
    } catch (error) {
      return fail(
        `The download was refused: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** A saved detail, by the label or key the model used to name it. */
  #detail(name: string): { key: string; label: string; value: string } | undefined {
    const wanted = name.trim().toLowerCase();
    const field =
      PROFILE_FIELDS.find((candidate) => candidate.key.toLowerCase() === wanted) ??
      PROFILE_FIELDS.find((candidate) => candidate.label.toLowerCase() === wanted) ??
      PROFILE_FIELDS.find((candidate) => candidate.label.toLowerCase().includes(wanted));
    if (!field) return undefined;
    const value = this.#profile[field.key];
    if (!value) return undefined;
    return { key: field.key, label: field.label, value };
  }

  #savedLabels(): string[] {
    return PROFILE_FIELDS.filter((field) => this.#profile[field.key]).map((field) => field.label);
  }

  /**
   * Fill everything the page has asked for that the user has already told us.
   *
   * The matching is local and so is the substitution: what comes back names the
   * details that were used, never their values. Fields with no match are
   * reported by name, because those are precisely the ones worth asking the
   * user about, and reporting them is what stops the model inventing answers.
   */
  async #autofill(
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const snapshot = this.#last;
    if (!snapshot) return fail('Read the page first -- handles only exist after a read.');
    if (Object.keys(this.#profile).length === 0) {
      return fail(
        'The user has not saved any details. Ask them for what the form needs, or ask them to fill ' +
          'in their details in Settings.',
      );
    }

    const matches = matchAll(snapshot.controls, this.#profile);
    const fillable = snapshot.controls.filter(
      (control) =>
        (control.role === 'input' || control.role === 'textarea' || control.role === 'select') &&
        !control.disabled,
    );

    if (matches.length === 0) {
      return ok(
        `None of the ${fillable.length} field(s) on this page match the user's saved details ` +
          `(${this.#savedLabels().join(', ')}). Fill them another way, or ask the user.`,
      );
    }

    const target = await this.#pool.forActiveTab();
    if (!target.ok) return fail(target.reason);

    const before = this.#last;
    const filled: string[] = [];

    for (const match of matches) {
      const result =
        match.control.role === 'select'
          ? await target.driver.select(match.control.handle, snapshot.generation, match.value)
          : await target.driver.type(match.control.handle, snapshot.generation, match.value);
      if (!result.ok) return this.#partial(filled, result.error, fail);
      filled.push(`"${match.control.name}" <- your ${match.label.toLowerCase()}`);
    }

    const missed = fillable
      .filter((control) => !matches.some((match) => match.control.handle === control.handle))
      .filter((control) => !control.sensitive)
      .map((control) => `[${control.handle}] "${control.name}"`);

    const rest =
      missed.length > 0
        ? `\n\nStill empty, with no saved detail to match: ${missed.join(', ')}. Ask the user about ` +
          `any of these the form requires -- do not guess a value.`
        : '';

    return this.#observe(
      before,
      target.tabId,
      `Filled ${filled.length} field(s) from the user's saved details:\n${filled.map((line) => `  ${line}`).join('\n')}${rest}`,
      ok,
    );
  }

  #partial(filled: string[], error: string, fail: (s: string) => ToolResult): ToolResult {
    const done =
      filled.length > 0
        ? `${filled.length} field(s) were filled first (${filled.join(', ')}) and are still filled in. `
        : 'No fields were filled. ';
    return fail(`${done}Then it stopped: ${error}`);
  }

  /**
   * The user's open tabs.
   *
   * Titles and addresses only. That is enough to choose a tab and nothing of
   * what is inside one -- reading a tab still needs that origin to have been
   * granted, and this deliberately does not become a way around it.
   */
  async #listTabs(ok: (s: string) => ToolResult): Promise<ToolResult> {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const working = this.#pool.target;

    const lines = tabs
      .filter((tab) => tab.id !== undefined)
      .map((tab) => {
        const marks = [
          tab.active ? 'in front' : undefined,
          tab.id === working ? 'working here' : undefined,
        ].filter(Boolean);
        const suffix = marks.length > 0 ? `  (${marks.join(', ')})` : '';
        return `  [${tab.id}] ${JSON.stringify(tab.title ?? '')} — ${tab.url ?? 'unknown address'}${suffix}`;
      });

    return ok(
      lines.length > 0
        ? `${lines.length} open tab(s):\n${lines.join('\n')}`
        : 'There are no tabs in this window.',
    );
  }

  async #switchTab(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const tabId = Number(args.tab);
    if (!Number.isInteger(tabId)) return fail(`"${args.tab}" is not a tab number. Use list_tabs.`);

    const target = await tabTarget(tabId);
    if (!target.ok) return fail(target.reason);

    this.#pool.focus(tabId);
    this.#tabId = tabId;
    // Bring it to the front. The user should be able to see where the agent is
    // working; an agent operating a tab nobody can see is the thing this
    // product most needs not to be.
    await chrome.tabs.update(tabId, { active: true }).catch(() => {
      // A tab that refuses to come forward is still a tab we can work in.
    });

    const known = this.#last;
    return ok(
      known
        ? `Now working in tab ${tabId} (${target.url}). This tab was read earlier, so its handles ` +
            `still apply -- read it again if it may have changed.`
        : `Now working in tab ${tabId} (${target.url}). Read the page to see what is on it.`,
    );
  }

  async #openTab(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const url = String(args.url ?? '');
    if (!url) return fail('open_tab needs a url.');

    const here = await this.#addressOnly();
    let resolved: string;
    try {
      resolved = new URL(url, here.ok ? here.url : undefined).href;
    } catch {
      return fail(`"${url}" is not a URL that can be opened.`);
    }

    const tab = await chrome.tabs.create({ url: resolved, active: args.background !== true });
    if (tab.id === undefined) return fail('Chrome did not open the tab.');

    this.#pool.focus(tab.id);
    this.#tabId = tab.id;

    const loaded = await waitForLoad(tab.id, this.#loadTimeoutMs);
    if (!loaded) {
      return ok(
        `Opened tab ${tab.id} at ${resolved}, but it had not finished loading. Read the page to ` +
          `see where it got to. Work now happens in this tab until you switch.`,
      );
    }
    // No `before` snapshot: this tab is new, so there is nothing to diff against
    // and the model needs the whole page rather than a list of changes.
    return this.#observe(
      undefined,
      tab.id,
      `Opened tab ${tab.id} at ${resolved}. Work now happens in this tab until you switch.`,
      ok,
    );
  }

  async #closeTab(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const tabId = Number(args.tab);
    if (!Number.isInteger(tabId)) return fail(`"${args.tab}" is not a tab number. Use list_tabs.`);

    const target = await tabTarget(tabId);
    if (!target.ok) return fail(target.reason);

    try {
      await chrome.tabs.remove(tabId);
    } catch (error) {
      return fail(`Could not close tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    await this.#pool.forget(tabId);
    this.#snapshots.delete(tabId);
    if (this.#tabId === tabId) this.#tabId = undefined;

    const back = this.#pool.target;
    return ok(
      `Closed tab ${tabId}. ` +
        (back === undefined
          ? 'Work now follows whichever tab the user is looking at; read the page to see it.'
          : `Still working in tab ${back}.`),
    );
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
    this.#readSinceAction = true;

    if (full || !previous) {
      return ok(formatSnapshot(result.snapshot, { intent: this.#intent }));
    }
    // The delta is what keeps a ten-step run from costing ten pages: after the
    // first read the model is told what changed rather than being handed the
    // page again (PRD section 4.2).
    return ok(describeChanges(previous, result.snapshot, { intent: this.#intent }));
  }

  /**
   * The page's text, generously budgeted, optionally filtered.
   *
   * Ten times `read_page`'s text allowance, because this is the tool for
   * answering questions rather than choosing what to click, and the detail
   * wanted is usually the part ranking would discard.
   *
   * And exactly once per version of a page. The allowance is what makes this
   * tool worth having and also what makes repeating it ruinous: a model that
   * reads a page, reads it another way, and comes back to check pays sixty
   * thousand characters each time for text that has not changed a byte. So the
   * text is remembered, and an unchanged page is answered with the fact that it
   * is unchanged -- which is a true answer to the question that was asked, and
   * a hundred times smaller than repeating it.
   *
   * A filtered read always runs: a search over text the model already has is
   * new information, and it is a handful of lines rather than a page.
   */
  async #pageText(
    args: Record<string, unknown>,
    ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    const result = await this.#snapshot();
    if (!result.ok) return fail(result.reason);
    this.#last = result.snapshot;
    this.#readSinceAction = true;

    const text = result.snapshot.text;
    if (!text.trim()) {
      return ok('This page has no readable text. Try read_page, or screenshot if it is an image.');
    }

    const find = typeof args.find === 'string' ? args.find.trim() : '';

    // Unchanged, and already sent. Say so rather than sending it again -- once.
    // Asking a second time gets the text: see `#reminded`.
    const tabId = this.#tabId;
    if (
      !find &&
      tabId !== undefined &&
      this.#delivered.get(tabId) === text &&
      !this.#reminded.has(tabId)
    ) {
      this.#reminded.add(tabId);
      return ok(
        `This page has not changed since you read it, so its text is the same text you already ` +
          `have — use that rather than re-reading. If you want something specific out of it, call ` +
          `get_page_text with a find argument and you will get the matching lines. If you expected ` +
          `the page to have changed, act on it or scroll first. If you genuinely no longer have ` +
          `the text, ask again and you will get it.`,
      );
    }

    if (find) {
      const lines = text.split('\n');
      const needle = find.toLowerCase();
      const hits: string[] = [];
      lines.forEach((line, index) => {
        if (!line.toLowerCase().includes(needle)) return;
        // A line either side, because a value is often on the line after its
        // label -- "Seat Height" and "17 inches" are rarely the same line.
        hits.push([lines[index - 1], line, lines[index + 1]].filter(Boolean).join('\n'));
      });
      if (hits.length === 0) {
        return ok(
          `Nothing on this page mentions "${find}". The page has ${text.length} characters of text; ` +
            `call get_page_text without a filter to read it.`,
        );
      }
      return ok(`${hits.length} match(es) for "${find}":\n\n${hits.join('\n---\n')}`);
    }

    // Recorded only where the whole text was handed over, so a filtered read
    // never makes the model look as though it has seen the page.
    if (tabId !== undefined) {
      this.#delivered.set(tabId, text);
      this.#reminded.delete(tabId);
    }

    const BUDGET = 60_000;
    if (text.length <= BUDGET) return ok(text);
    return ok(
      `${text.slice(0, BUDGET)}\n…[${text.length - BUDGET} more characters — use the find argument to search the rest]`,
    );
  }

  /**
   * A picture, when text has not answered the question.
   *
   * Only reachable over CDP: a content script cannot photograph its own page.
   */
  async #screenshot(
    _ok: (s: string) => ToolResult,
    fail: (s: string) => ToolResult,
  ): Promise<ToolResult> {
    if (this.#readSinceAction && !this.#pictureRefused) {
      this.#pictureRefused = true;
      return fail(
        'You have already read this page and nothing has changed since, so the text you have is ' +
          'the same page this picture would show — and a picture costs far more, because it stays ' +
          'in the conversation for every turn after this one. Answer from what you read. If the ' +
          'thing you need is genuinely only in an image, a chart or a canvas, or you need to see ' +
          'how the page is laid out, ask again and you will get it.',
      );
    }

    const target = await this.#pool.forActiveTab();
    if (!target.ok) return fail(target.reason);
    if (!target.driver.screenshot) {
      return fail(
        'Taking a picture needs the debugger, which is not active on this tab. Read the page ' +
          'instead, or ask the user to turn it on in Settings.',
      );
    }

    const shot = await target.driver.screenshot();
    if (!shot) {
      return fail(
        target.driver.kind === 'dom'
          ? 'Without the debugger, Chrome will only photograph the tab that is in front, and this ' +
              'one is not. Switch to it first, or read the page instead.'
          : 'The page could not be captured.',
      );
    }
    this.#onView?.(shot);
    return {
      id: 'screenshot',
      name: 'screenshot',
      content: 'Screenshot of the visible part of the page.',
      images: [shot],
    };
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

      // And show what *is* here. A bare "nothing matched" is a dead end, and a
      // dead end is what makes a model try the same call with a synonym, then
      // another synonym -- which is precisely the loop this cost a real run.
      // Seeing the actual names ends the guessing in one step: either the thing
      // is there under another word, or it plainly is not on the page.
      const present = [...result.snapshot.controls]
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((control) => `[${control.handle}] ${control.role} ${JSON.stringify(control.name)}`);

      const sample =
        present.length > 0
          ? `\n\nWhat is here, most prominent first:\n${present.map((line) => `  ${line}`).join('\n')}`
          : '';

      return ok(
        `No controls ${scope || 'found'} on this page. It has ${result.snapshot.controls.length} ` +
          `controls in total.${sample}\n\nIf what you want is not among these, do not try another ` +
          `word for it -- it is not on the page as read. It may be below the fold (scroll), inside ` +
          `a list that only renders what is on screen (scroll the list itself), or behind something ` +
          `that has to be opened first.`,
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
        'Nothing on this page reads as a table or as a repeated list of items. Use read_page or ' +
          'get_page_text and pull the values out of the text and controls instead.',
      );
    }

    // Which table, when the caller did not say.
    //
    // Not simply the first. A collection in progress has a shape, and the page
    // it has just moved to may rank a different block above the one being
    // collected -- a sponsored carousel, a "customers also bought" strip. Taking
    // the first would hand `mergeTable` a table with different columns, and its
    // answer to that is to start again: every row gathered so far, silently
    // discarded, halfway through the one task this feature exists for.
    //
    // So an explicit index is obeyed, and otherwise a collection already under
    // way keeps to its own shape.
    const asked = typeof args.table === 'number' ? args.table : undefined;
    const continuing =
      asked === undefined && this.#dataset
        ? tables.find((candidate) => sameHeaders(candidate.headers, this.#dataset!.headers))
        : undefined;
    const index = asked ?? 0;
    const table = continuing ?? tables[index];
    if (!table) {
      return fail(`There is no table ${index}. The page has ${tables.length}.`);
    }

    // The whole table, not the preview. `sample` is five rows because it is
    // rendered into `read_page`; this tool exists to return all of them, and
    // reading `sample` here is why "compare these forty listings" answered with
    // five and then advised scrolling for the rest of a table that was already
    // complete on the page.
    const available = table.body ?? table.sample;
    const limit = typeof args.limit === 'number' ? Math.min(args.limit, 200) : 50;
    const rows = available.slice(0, limit);

    // Accumulate. The user's copy of the data lives outside the transcript, so
    // paginating through ten pages costs ten extractions rather than ten
    // re-sends of everything seen so far.
    const merged = mergeTable(
      this.#dataset,
      { headers: table.headers, rows, label: table.label },
      result.snapshot.url,
    );
    this.#dataset = merged.dataset;
    this.#onData?.(merged.dataset);

    // Say which of the two reasons stopped it, because they have different
    // answers: a limit the model set is raised by asking again, and a page that
    // genuinely holds more is advanced with next_page.
    const sampled =
      table.rows > rows.length
        ? rows.length < available.length
          ? `\n(${rows.length} of ${table.rows} rows, limited by this call. Ask again with a ` +
            `higher limit for the rest.)`
          : `\n(${rows.length} of ${table.rows} rows -- the page holds more than was captured. ` +
            `Use next_page, or scroll, then extract_data again.)`
        : '';

    const collected =
      merged.dataset.sources.length > 1 || merged.duplicates > 0
        ? `\n\nCollected so far: ${merged.dataset.rows.length} row(s) across ` +
          `${merged.dataset.sources.length} page(s). This call added ${merged.added}` +
          (merged.duplicates > 0 ? `, and skipped ${merged.duplicates} already seen` : '') +
          `. The user has the full set in the panel and can export it; you do not need to repeat ` +
          `these rows back.`
        : `\n\nCollected: ${merged.dataset.rows.length} row(s). Use next_page and extract_data ` +
          `again to add more; the rows accumulate for the user and are de-duplicated.`;

    const restarted = merged.restarted
      ? `\n\nThis table has different columns from the one being collected, so the collection was ` +
        `started again from here.`
      : '';

    return ok(
      [
        `${table.label ?? 'table'}: ${table.rows} rows x ${table.columns} columns`,
        table.headers.join(' | '),
        ...rows.map((row) => row.join(' | ')),
      ].join('\n') +
        sampled +
        collected +
        restarted,
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

    const target = await this.#pool.forActiveTab();
    if (!target.ok) return fail(target.reason);

    const scrolled = await target.driver.scroll(
      direction,
      typeof args.pages === 'number' ? args.pages : 1,
    );
    if ('ok' in scrolled) return fail(scrolled.ok ? 'Unexpected reply from the page.' : scrolled.error);

    const previous = this.#last;
    this.#last = scrolled;
    const response = { snapshot: scrolled };

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
    const target = await this.#pool.forActiveTab();
    if (!target.ok) return fail(target.reason);

    const seconds = typeof args.seconds === 'number' ? args.seconds : 3;
    const response = await target.driver.settle(seconds);

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
