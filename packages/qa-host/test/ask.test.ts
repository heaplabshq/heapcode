import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResponse, Provider } from '@heapcode/core/providers';
import { Templates, chainRecordings, initWorkspace, loadWorkspace, parseFlow, type Flow, type SavedFingerprints } from '@heapcode/qa';
import { AskConversation, compact } from '../src/ask.js';
import type { AgentModel } from '../src/orchestrate.js';

const LOGIN = `<!doctype html><title>Log in</title><h1>Log in</h1><form action="/home">
  <label for="e">Email</label><input id="e" name="email"><button>Log in</button></form>`;
const HOME = (email: string): string => `<!doctype html><title>Home</title><h1>Home</h1><p>Signed in as ${email}</p><a href="/cart?email=${encodeURIComponent(email)}">Cart</a>`;
const CART = `<!doctype html><title>Cart</title><h1>Your cart</h1><p>2 items</p>`;

let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/login') return res.end(LOGIN);
    if (url.pathname === '/home') return res.end(HOME(url.searchParams.get('email') ?? ''));
    if (url.pathname === '/cart') return res.end(CART);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(() => new Promise((r) => server.close(r)), 60_000);

/**
 * A model scripted per request, reading the outline it was last shown — and
 * recording what it was told, so the test can see the conversation reach it.
 */
function scripted(scripts: Array<Array<(outline: string) => [string, Record<string, unknown>]>>): { model: AgentModel; prompts: ChatRequest[] } {
  const prompts: ChatRequest[] = [];
  let request = -1;
  let turn = 0;
  const provider = {
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const system = typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '';
      // Naming the flow afterwards: not the tester. No name → the task becomes it.
      if (!system.includes("You are Heap QA's tester")) return { content: 'no' };
      if (!req.messages.some((m) => m.role === 'tool')) {
        request += 1;
        turn = 0;
        prompts.push(req);
      }
      const last = [...req.messages].reverse().find((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('Page: '));
      const outline = typeof last?.content === 'string' ? last.content : '';
      const step = scripts[request]![turn++];
      if (!step) return { content: 'done' };
      const [name, args] = step(outline);
      return { content: '', toolCalls: [{ id: `c${request}-${turn}`, name, args }] };
    },
  } as unknown as Provider;
  return { model: { provider, model: 'scripted', nativeToolCalls: true, contextWindow: 32_000, vision: false }, prompts };
}

const ref = (outline: string, pattern: RegExp): string => {
  const m = pattern.exec(outline);
  if (!m) throw new Error(`not in outline: ${pattern}\n${outline}`);
  return m[1]!;
};
const page = (): [string, Record<string, unknown>] => ['page', {}];

describe('Ask AI remembers the conversation', { timeout: 120_000 }, () => {
  it('carries a follow-up on in the same browser, builds one test, and gets back there after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heapqa-ask-'));
    initWorkspace(dir, { baseUrl: base });
    const file = join(dir, 'state', 'qa-ask.json');
    const { model, prompts } = scripted([
      [
        page,
        (o) => ['type', { ref: ref(o, /\[(\d+)\] textbox "Email"/), text: 'ai@example.test' }],
        (o) => ['click', { ref: ref(o, /\[(\d+)\] button "Log in"/) }],
        (o) => ['check_visible', { ref: ref(o, /\[(\d+)\] # Home/) }],
        () => ['finish', { summary: 'Logged in.' }],
      ],
      [
        page,
        (o) => ['click', { ref: ref(o, /\[(\d+)\] link "Cart"/) }],
        (o) => ['check_visible', { ref: ref(o, /\[(\d+)\] # Your cart/) }],
        () => ['finish', { summary: 'The cart shows.' }],
      ],
      [page, (o) => ['check_visible', { ref: ref(o, /\[(\d+)\] # Your cart/) }], () => ['finish', { summary: 'Still in the cart.' }]],
    ]);
    const ask = (conv: AskConversation, task: string) =>
      conv.ask({
        ws: loadWorkspace(dir),
        model,
        task,
        start: '/login',
        baseUrl: base,
        templates: new Templates({ inputs: {}, secret: () => undefined, env: {}, runId: 'r' }),
        headless: true,
        confirm: async () => false,
        onNote: (text) => notes.push(text),
      });
    const notes: string[] = [];

    const conv = new AskConversation(dir, file);
    const first = await ask(conv, 'log in as ai@example.test');
    expect(first.saved, first.error).toBeTruthy();
    const second = await ask(conv, 'now open the cart');
    expect(second.saved, second.error).toBe(first.saved);

    // The follow-up started where the first stopped — no second visit to /login —
    // and was told what came before.
    expect(prompts[1]!.messages.map((m) => m.content).join('\n')).toContain('log in as ai@example.test');
    expect(String(prompts[1]!.messages[0]!.content)).toMatch(/follow-up/);

    // One test, both requests' steps, which replayed without the model to be saved.
    const flow = parseFlow(readFileSync(second.saved!, 'utf8'));
    expect(flow.ok).toBe(true);
    if (!flow.ok) return;
    expect(flow.value.steps.map((s) => s.kind)).toEqual(['goto', 'type', 'click', 'expect', 'click', 'expect']);
    expect(flow.value.steps.filter((s) => s.kind === 'goto')).toHaveLength(1);

    // A restart: the browser is gone, the conversation is on disk. The next
    // request replays the test to get back to the cart, then carries on.
    await conv.close();
    const again = new AskConversation(dir, file);
    expect(again.turns).toHaveLength(0); // turns are the page's record; the session adds them
    const third = await ask(again, 'check the cart is still there');
    expect(notes.some((n) => /Getting back/.test(n)), notes.join('\n')).toBe(true);
    expect(third.saved, third.error).toBe(first.saved);
    await again.reset();
    expect(new AskConversation(dir, file).testName).toBeUndefined();
  });
});

describe('chainRecordings', () => {
  it('appends steps, renames clashing inputs and moves fingerprints', () => {
    const fp = (step: number): SavedFingerprints['steps'][number] => ({ step, locator: { label: 'Email' }, fingerprint: {} as never });
    const a: { flow: Flow; fingerprints: SavedFingerprints } = {
      flow: { name: 'a', inputs: { email: 'one@x' }, steps: [{ kind: 'goto', url: '/' }, { kind: 'type', target: { label: 'Email' }, text: '{{email}}', clear: true }] },
      fingerprints: { version: 1, steps: [fp(2)] },
    };
    const b: { flow: Flow; fingerprints: SavedFingerprints } = {
      flow: { name: 'b', inputs: { email: 'two@x' }, steps: [{ kind: 'type', target: { label: 'Email' }, text: '{{email}}', clear: true }] },
      fingerprints: { version: 1, steps: [fp(1)] },
    };
    const c = chainRecordings(a, b);
    expect(c.flow.name).toBe('a');
    expect(c.flow.inputs).toEqual({ email: 'one@x', email2: 'two@x' });
    expect(c.flow.steps.map((s) => (s.kind === 'type' ? s.text : s.kind))).toEqual(['goto', '{{email}}', '{{email2}}']);
    expect(c.fingerprints.steps.map((s) => s.step)).toEqual([2, 3]);
  });
});

describe('compact', () => {
  it('keeps whole messages and tool calls, not stream fragments or thinking', () => {
    const kept = compact([
      { type: 'reasoning_delta', text: 'hm' },
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'text_end' },
      { type: 'tool_call', id: '1', name: 'page', args: {} },
      { type: 'tool_result', id: '1', name: 'page', content: 'x'.repeat(5000) },
    ]);
    expect(kept.map((e) => e.type)).toEqual(['text', 'tool_call', 'tool_result']);
    expect(kept[0]).toEqual({ type: 'text', text: 'Hello' });
    expect((kept[2] as { content: string }).content).toHaveLength(1500);
  });
});
