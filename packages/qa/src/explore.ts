import type { RecordedTarget } from '@heapcode/page/recording';
import type { DomNode, DomTree } from '@heapcode/page/tree';
import { classifyBrowserAction } from '@heapcode/web-host/browserTools';
import { locate, type ConsoleLine, type Driver, type FailedRequest, type Target } from './driver.js';
import type { Flow, Locator, Step } from './flow.js';
import { describeLocator } from './run.js';
import { isAllowedTarget } from './targets.js';
import type { Templates } from './template.js';

/**
 * Finding bugs with no script: visit every page that can be reached from the
 * start, press what is safe to press, fill each form with ordinary and with
 * awkward input — and report only what is wrong on any page: server errors,
 * broken links, uncaught exceptions, console errors, error screens and
 * unformatted values on screen, content wider than a phone, and buttons that
 * do nothing at all.
 *
 * No model and no guessing about what a page *should* do — that is what a
 * flow is for. Each finding that an action set off comes with a draft flow
 * that reproduces it, so it can be checked again once fixed.
 *
 * Safe by default: never presses what reads like it commits something
 * ("Delete", "Pay", "Submit order" — Heap Code's classifier) or ends the
 * session ("Log out"), and never submits a form with a password field.
 * `allowCommits` lifts the first for a disposable environment.
 */

export type FindingKind = 'server-error' | 'broken-link' | 'crash' | 'error-text' | 'console-error' | 'failed-request' | 'layout' | 'dead-button';

export interface Finding {
  id: string;
  kind: FindingKind;
  severity: 'high' | 'medium' | 'low';
  /** One line. */
  title: string;
  detail: string;
  /** Where it was first seen. */
  page: string;
  /** Every page it was seen on (the same console error on ten pages is one finding). */
  pages: string[];
  /** What was done to set it off, when it was not just opening the page. */
  action?: string;
  console: ConsoleLine[];
  requests: FailedRequest[];
  screenshot?: Uint8Array;
  /** A flow that does the same thing again. */
  repro?: Flow;
}

export interface ExploreOptions {
  driver: Driver;
  startUrl: string;
  baseUrl?: string;
  /** Non-local origins allowed (heapqa.yaml `targets`) — links elsewhere are not followed. */
  targets: readonly string[];
  /** Redacts secrets from everything kept. */
  templates: Templates;
  /** Default 20. */
  maxPages?: number;
  /** Link hops from the start. Default 3. */
  maxDepth?: number;
  /** Default 15 per page. */
  maxButtons?: number;
  /** Default 3 per page. */
  maxForms?: number;
  /** Submissions per form. Default 12. */
  maxSubmits?: number;
  forms?: boolean;
  buttons?: boolean;
  /** Check each page at phone width. Default true. */
  layout?: boolean;
  /** Also press what reads like it commits something. Only for disposable data. */
  allowCommits?: boolean;
  screenshots?: boolean;
  onPage?(url: string, index: number): void;
  onFinding?(finding: Finding): void;
  signal?: AbortSignal;
}

export interface ExploreResult {
  pages: { url: string; status?: number; title: string }[];
  findings: Finding[];
  /** What was deliberately not tried, and why — so a clean result is not over-read. */
  skipped: string[];
}

const PHONE = { width: 375, height: 812 };
const LEAVES = /\b(log ?out|sign ?out|log ?off|sign ?off)\b/i;
const FILES = /\.(pdf|zip|gz|tar|dmg|exe|msi|png|jpe?g|gif|svg|webp|mp4|mp3|csv|xlsx?|docx?)$/i;

interface Control {
  target: RecordedTarget;
  label: string;
}

interface FormInfo {
  name: string;
  fields: { target: RecordedTarget; kind: FieldKind; options?: string[] }[];
  submit: Control;
}

type FieldKind = 'email' | 'number' | 'tel' | 'url' | 'date' | 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'password' | 'other';

type Variant = 'ordinary' | 'empty' | 'long' | 'unicode' | 'wrong format';
const AWKWARD: Variant[] = ['long', 'unicode', 'wrong format'];
const TYPED = new Set<FieldKind>(['email', 'number', 'tel', 'url', 'date', 'text', 'textarea', 'other']);

/**
 * What to submit a form with: all ordinary, all empty, then each typed field
 * awkward in turn while the rest stay ordinary. One field at a time, as a
 * person testing would: junk in every field at once mostly tests the
 * browser's own validation (an invalid email stops the submit), not the app.
 */
function attempts(form: FormInfo): { label: string; variants: Variant[] }[] {
  const all = (v: Variant): Variant[] => form.fields.map(() => v);
  const out = [
    { label: 'with ordinary input', variants: all('ordinary') },
    { label: 'empty', variants: all('empty') },
  ];
  for (const [i, field] of form.fields.entries()) {
    if (!TYPED.has(field.kind)) continue;
    const name = field.target.field ?? describeLocator(field.target.locator);
    for (const v of AWKWARD) {
      out.push({ label: `with ${v === 'wrong format' ? 'a wrongly formatted' : v === 'long' ? 'a long' : 'a unicode'} ${name}`, variants: form.fields.map((_, j) => (j === i ? v : 'ordinary')) });
    }
  }
  return out;
}

export async function explore(options: ExploreOptions): Promise<ExploreResult> {
  const { driver, templates } = options;
  const maxPages = options.maxPages ?? 20;
  const maxDepth = options.maxDepth ?? 3;
  const result: ExploreResult = { pages: [], findings: [], skipped: [] };
  const byKey = new Map<string, Finding>();
  const queue: { url: string; depth: number; from?: string }[] = [{ url: options.startUrl, depth: 0 }];
  const seen = new Set<string>([normalise(options.startUrl)]);
  const origin = new URL(options.startUrl).origin;
  const path = (url: string): string => relativeTo(url, options.baseUrl ?? origin);

  const report = async (f: Omit<Finding, 'id' | 'pages'>): Promise<void> => {
    // The same problem on many pages is one finding with many pages.
    const key = `${f.kind}|${f.detail}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.pages.includes(f.page)) existing.pages.push(f.page);
      return;
    }
    const finding: Finding = { ...f, id: `F${byKey.size + 1}`, pages: [f.page] };
    if (options.screenshots !== false) finding.screenshot = await driver.screenshot().catch(() => undefined);
    byKey.set(key, finding);
    result.findings.push(finding);
    options.onFinding?.(finding);
  };

  /** Read what the last thing done left behind, and report what is wrong with it. */
  const observe = async (page: string, action: string | undefined, repro: Step[] | undefined, ignoreUrl?: string): Promise<void> => {
    await driver.settle?.();
    const consoleLines = driver.drainConsole().map((l) => ({ ...l, message: templates.redact(l.message) }));
    const requests = driver
      .drainFailedRequests()
      .filter((r) => r.url !== ignoreUrl && !(action && r.status !== undefined && r.status < 500 && r.method !== 'GET'))
      .map((r) => ({ ...r, url: templates.redact(r.url) }));
    const health = (await driver.health?.().catch(() => undefined)) ?? { errorTexts: [], overflowX: 0 };
    const flow = (assert: Step | undefined): Flow | undefined =>
      repro ? { name: `explore: ${action ?? `open ${path(page)}`}`, inputs: {}, steps: [...repro, ...(assert ? [assert] : [])] } : undefined;
    const common = { page, ...(action ? { action } : {}) };

    for (const line of consoleLines.filter((l) => l.level === 'error')) {
      // Failed loads are reported as requests, with their status; not twice.
      if (/^Failed to load resource/.test(line.message)) continue;
      const crash = /^Uncaught\b/.test(line.message);
      await report({
        kind: crash ? 'crash' : 'console-error',
        severity: crash ? 'high' : 'medium',
        title: crash ? `The page threw an error${action ? ` after ${action}` : ''}` : `Console error${action ? ` after ${action}` : ''}`,
        detail: line.message.slice(0, 300),
        console: [line],
        requests: [],
        ...common,
        ...(flow({ kind: 'expect', expect: { kind: 'noConsoleErrors' } }) ? { repro: flow({ kind: 'expect', expect: { kind: 'noConsoleErrors' } })! } : {}),
      });
    }
    for (const r of requests) {
      const server = r.status !== undefined && r.status >= 500;
      await report({
        kind: server ? 'server-error' : 'failed-request',
        severity: server ? 'high' : 'medium',
        title: `${r.method} ${shortUrl(r.url, origin)} ${r.status ? `returned ${r.status}` : `failed (${r.error})`}${action ? ` after ${action}` : ''}`,
        detail: `${r.method} ${shortUrl(r.url, origin)} → ${r.status ?? r.error}`,
        console: [],
        requests: [r],
        ...common,
        // Fails while the request still fails. (A 4xx is not a server error; its repro checks the console.)
        ...(flow({ kind: 'expect', expect: { kind: server || r.status === undefined ? 'noServerErrors' : 'noConsoleErrors' } })
          ? { repro: flow({ kind: 'expect', expect: { kind: server || r.status === undefined ? 'noServerErrors' : 'noConsoleErrors' } })! }
          : {}),
      });
    }
    for (const text of health.errorTexts) {
      const redacted = templates.redact(text);
      // The repro checks the text is gone: an unformatted value exactly, an error screen by its words.
      const value = /^"(.+)" shown on the page/.exec(redacted)?.[1];
      const gone: Step = { kind: 'expect', expect: { kind: 'hidden', target: { text: value ?? redacted } } };
      await report({
        kind: 'error-text',
        severity: 'high',
        title: `${value ? `"${value}" shown on the page` : `Error on the page: ${redacted.slice(0, 60)}${redacted.length > 60 ? '…' : ''}`}${action ? ` after ${action}` : ''}`,
        detail: redacted,
        console: [],
        requests: [],
        ...common,
        ...(flow(gone) ? { repro: flow(gone)! } : {}),
      });
    }
  };

  while (queue.length && result.pages.length < maxPages) {
    if (options.signal?.aborted) break;
    const { url, depth, from } = queue.shift()!;
    options.onPage?.(url, result.pages.length + 1);
    driver.drainConsole();
    driver.drainFailedRequests();

    // 1. Open it.
    let info;
    try {
      info = await driver.open(url);
    } catch (err) {
      await report({
        kind: 'broken-link',
        severity: 'high',
        title: `${path(url)} could not be opened`,
        detail: (err instanceof Error ? err.message : String(err)).split('\n')[0]!,
        page: from ?? url,
        console: [],
        requests: [],
      });
      continue;
    }
    result.pages.push({ url: info.url, ...(info.status !== undefined ? { status: info.status } : {}), title: info.title });
    const open: Step = { kind: 'goto', url: path(info.url) };
    if (info.status !== undefined && info.status >= 400) {
      await report({
        kind: info.status >= 500 ? 'server-error' : 'broken-link',
        severity: 'high',
        title: info.status >= 500 ? `${path(url)} returned ${info.status}` : `Broken link: ${path(url)} returned ${info.status}`,
        detail: `${path(url)} → ${info.status}${from ? ` (linked from ${path(from)})` : ''}`,
        page: from ?? url,
        console: [],
        requests: [],
      });
      continue;
    }
    await observe(info.url, undefined, [open], info.url);

    // 2. At phone width.
    if (options.layout !== false && driver.viewport && driver.health) {
      await driver.viewport(PHONE);
      const narrow = await driver.health().catch(() => undefined);
      if (narrow && narrow.overflowX > 1) {
        await report({
          kind: 'layout',
          severity: 'medium',
          title: `${path(info.url)} scrolls sideways at phone width`,
          detail: `${narrow.overflowX}px wider than a ${PHONE.width}px screen${narrow.overflowCulprit ? `; widest: ${narrow.overflowCulprit}` : ''}`,
          page: info.url,
          console: [],
          requests: [],
        });
      }
      await driver.viewport();
    }

    // 3. What there is to follow, press and fill.
    const tree = await driver.inspect();
    if (depth < maxDepth) {
      for (const link of links(tree, info.url)) {
        if (!isAllowedTarget(link, options.targets) || new URL(link).origin !== origin) continue;
        const key = normalise(link);
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ url: link, depth: depth + 1, from: info.url });
      }
    }
    const { buttons, forms, skipped } = await controls(driver, tree, options);
    result.skipped.push(...skipped.map((s) => `${path(info.url)}: ${s}`));

    // 4. Press each button, from a fresh page each time it changed something.
    let fresh = true;
    for (const button of options.buttons === false ? [] : buttons.slice(0, options.maxButtons ?? 15)) {
      if (options.signal?.aborted) break;
      if (!fresh) {
        await driver.open(info.url).catch(() => undefined);
        driver.drainConsole();
        driver.drainFailedRequests();
      }
      const target = await find(driver, button.target.locator);
      if (!target) continue;
      await driver.watch?.();
      try {
        await driver.click(target);
      } catch {
        fresh = false;
        continue;
      }
      const action = `pressing ${describeLocator(button.target.locator)}`;
      const before = result.findings.length + countPages(byKey);
      await observe(info.url, action, [open, { kind: 'click', target: button.target.locator }]);
      const activity = await driver.watched?.();
      fresh = !activity || (activity.mutations === 0 && !activity.navigated);
      // A button that threw did something — the wrong thing, already reported.
      const reported = result.findings.length + countPages(byKey) > before;
      if (!reported && activity && activity.mutations === 0 && activity.requests === 0 && !activity.navigated) {
        await report({
          kind: 'dead-button',
          severity: 'low',
          title: `${describeLocator(button.target.locator)} does nothing`,
          detail: `Pressing ${describeLocator(button.target.locator)} on ${path(info.url)} changed nothing on the page, made no request and went nowhere`,
          page: info.url,
          action,
          console: [],
          requests: [],
        });
      }
    }

    // 5. Fill each form, ordinary and awkward.
    for (const form of options.forms === false ? [] : forms.slice(0, options.maxForms ?? 3)) {
      for (const attempt of attempts(form).slice(0, options.maxSubmits ?? 12)) {
        if (options.signal?.aborted) break;
        await driver.open(info.url).catch(() => undefined);
        driver.drainConsole();
        driver.drainFailedRequests();
        const steps: Step[] = [open];
        let ok = true;
        for (const [i, field] of form.fields.entries()) {
          const step = await fill(driver, field, attempt.variants[i]!);
          if (step === false) {
            ok = false;
            break;
          }
          if (step) steps.push(step);
        }
        if (!ok) break;
        const submit = await find(driver, form.submit.target.locator);
        if (!submit) break;
        try {
          await driver.click(submit);
        } catch {
          continue;
        }
        steps.push({ kind: 'click', target: form.submit.target.locator });
        await observe(info.url, `submitting ${form.name} ${attempt.label}`, steps);
      }
    }
  }

  if (queue.length && result.pages.length >= maxPages) result.skipped.push(`${queue.length} more page(s) not visited — the limit is ${maxPages} (--pages)`);
  return result;
}

/** Same-page-or-site links, absolute, without fragments; files and leaving links dropped. */
function links(tree: DomTree, base: string): string[] {
  const out: string[] = [];
  for (const node of tree.nodes) {
    if (node.tag !== 'a' || !node.visible || !node.attrs.href) continue;
    const href = node.attrs.href.trim();
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    if (LEAVES.test(node.name ?? node.text ?? '')) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (FILES.test(url.pathname)) continue;
    url.hash = '';
    out.push(url.toString());
  }
  return out;
}

/** The page's buttons and forms, each described so it can be found again on a reloaded page. */
async function controls(driver: Driver, tree: DomTree, options: ExploreOptions): Promise<{ buttons: Control[]; forms: FormInfo[]; skipped: string[] }> {
  const skipped: string[] = [];
  const buttons: Control[] = [];
  const forms: FormInfo[] = [];
  const inForm = new Set<number>();
  const formOf = new Map<number, number>();
  for (const node of tree.nodes) {
    if (node.tag === 'form') inForm.add(node.id);
    if (node.parent !== null && (inForm.has(node.parent) || formOf.has(node.parent))) formOf.set(node.id, formOf.get(node.parent) ?? node.parent);
  }
  const label = (n: DomNode): string => n.name ?? n.text ?? '';
  const commits = (text: string): boolean => classifyBrowserAction({ id: '', name: 'browser_click', args: {} }, text) === 'destructive';
  const describe = async (n: DomNode): Promise<RecordedTarget | undefined> => driver.describe?.(n.id).catch(() => undefined);

  for (const node of tree.nodes) {
    if (node.role !== 'button' || !node.visible || node.disabled) continue;
    const text = label(node);
    const isSubmit = formOf.has(node.id) && (node.attrs.type === undefined || node.attrs.type === 'submit') && node.tag !== 'summary';
    if (isSubmit) continue; // pressed as the form's submit, with input
    if (LEAVES.test(text)) {
      skipped.push(`did not press "${text}" (it would end the session)`);
      continue;
    }
    if (commits(text) && !options.allowCommits) {
      skipped.push(`did not press "${text}" (reads like it commits something; --allow-commits to include)`);
      continue;
    }
    const target = await describe(node);
    if (target) buttons.push({ target, label: text });
  }

  for (const formId of inForm) {
    const formNode = tree.nodes[formId]!;
    if (!formNode.visible) continue;
    const members = tree.nodes.filter((n) => formOf.get(n.id) === formId);
    const fieldNodes = members.filter((n) => ['input', 'textarea', 'select'].includes(n.tag) && n.visible && !n.disabled && !['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(n.attrs.type ?? ''));
    const submitNode = members.find((n) => n.role === 'button' && n.visible && !n.disabled && (n.attrs.type === undefined || n.attrs.type === 'submit'));
    if (!submitNode || !fieldNodes.length) continue;
    // Named by its button: a form's own accessible name is all the text inside it.
    const name = `the "${label(submitNode)}" form`;
    if (fieldNodes.some((n) => n.attrs.type === 'password')) {
      skipped.push(`did not submit ${name} (it has a password field)`);
      continue;
    }
    if (commits(label(submitNode)) && !options.allowCommits) {
      skipped.push(`did not submit ${name} ("${label(submitNode)}" reads like it commits something; --allow-commits to include)`);
      continue;
    }
    const submit = await describe(submitNode);
    if (!submit) continue;
    const fields: FormInfo['fields'] = [];
    for (const n of fieldNodes) {
      const target = await describe(n);
      if (!target) continue;
      const options =
        n.tag === 'select'
          ? n.children.map((c) => tree.nodes[c]!).filter((c) => c.tag === 'option' && !c.disabled).map((c) => c.text || c.attrs.value || '')
          : undefined;
      fields.push({ target, kind: fieldKind(n), ...(options ? { options } : {}) });
    }
    forms.push({ name, fields, submit: { target: submit, label: label(submitNode) } });
  }
  return { buttons, forms, skipped };
}

function fieldKind(n: DomNode): FieldKind {
  if (n.tag === 'textarea') return 'textarea';
  if (n.tag === 'select') return 'select';
  const type = (n.attrs.type ?? 'text').toLowerCase();
  if (['email', 'number', 'tel', 'url', 'date', 'checkbox', 'radio', 'password'].includes(type)) return type as FieldKind;
  if (['text', 'search', ''].includes(type)) return 'text';
  return 'other';
}

const LONG = 'Heap QA long input '.repeat(30).trim();
const UNICODE = 'Zoë Ünïcödé 😀 测试 עברית';

function valueFor(kind: FieldKind, variant: Variant): string | undefined {
  if (variant === 'empty') return '';
  if (variant === 'long') return kind === 'number' ? '9'.repeat(40) : LONG;
  if (variant === 'unicode') return kind === 'number' ? '٣' : UNICODE;
  if (variant === 'wrong format') {
    return { email: 'not-an-email', number: 'abc', tel: 'call me', url: 'not a url', date: '2026-13-45' }[kind as string] ?? '<b>"quotes" & \'tags\'</b>';
  }
  return { email: 'qa@example.test', number: '3', tel: '+1 555 0100', url: 'https://example.test', date: '2026-01-15', textarea: 'A short note from Heap QA.' }[kind as string] ?? 'Heap QA';
}

/** Fill one field for a variant. Returns the step taken, undefined if none was needed, false if the field is gone. */
async function fill(driver: Driver, field: FormInfo['fields'][number], variant: Variant): Promise<Step | undefined | false> {
  const target = await find(driver, field.target.locator);
  if (!target) return false;
  const locator = field.target.locator;
  if (field.kind === 'select') {
    const choice = field.options?.find((o) => o.trim()) ?? field.options?.[0];
    if (!choice || variant === 'empty') return undefined;
    await driver.select(target, choice).catch(() => undefined);
    return { kind: 'select', target: locator, option: choice };
  }
  if (field.kind === 'checkbox' || field.kind === 'radio') {
    if (variant !== 'ordinary') return undefined;
    await driver.click(target).catch(() => undefined);
    return { kind: 'click', target: locator };
  }
  const value = valueFor(field.kind, variant);
  if (value === undefined) return undefined;
  await driver.type(target, value, { clear: true }).catch(() => undefined);
  return { kind: 'type', target: locator, text: value, clear: true };
}

async function find(driver: Driver, locator: Locator): Promise<Target | undefined> {
  const located = await locate(driver, locator).catch(() => undefined);
  return located?.found ? located.target : undefined;
}

/** Pages a finding was seen on, summed — grows when a known finding is seen again. */
function countPages(byKey: Map<string, Finding>): number {
  let n = 0;
  for (const f of byKey.values()) n += f.pages.length;
  return n;
}

function normalise(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

function relativeTo(url: string, base: string): string {
  try {
    const u = new URL(url);
    return u.origin === new URL(base).origin ? `${u.pathname}${u.search}` : url;
  } catch {
    return url;
  }
}

function shortUrl(url: string, origin: string): string {
  return url.startsWith(origin) ? url.slice(origin.length) || '/' : url;
}
