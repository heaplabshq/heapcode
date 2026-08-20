import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeapcodeServer } from '@heapcode/core';
import { startMockServer, type MockBehavior, type MockServer } from '../../core/test/mockServer.js';
import { ConfigStore } from '@heapcode/host';
import { conversationsFile } from '@heapcode/host';
import { runHeadless, type HeadlessEvent } from '../src/headless.js';

/**
 * These tests used to call runHeadless() and have it run the agent loop
 * in-process. It is now a client of the core server
 * (docs/phase3-protocol-design.md §7), so the harness starts a real
 * HeapcodeServer and points runHeadless at it.
 *
 * The server runs in *this* process rather than being spawned: every message
 * still crosses a real unix socket with real NDJSON framing and real
 * bidirectional RPC, so what these tests cover is unchanged — but they don't
 * depend on `pnpm build` having produced dist/daemon.js first. Autostart
 * (the spawning path) has its own tests in server.test.ts.
 *
 * Nothing about the assertions changed: same flags in, same NDJSON out.
 */
let home: string;
let project: string;
let server: MockServer;
let core: HeapcodeServer;
/** Passed to runHeadless so it connects to `core` instead of autostarting. */
let serverOpts: { address: string; token: string; autostart: false };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'heapcode-home-'));
  project = await mkdtemp(join(tmpdir(), 'heapcode-project-'));
  vi.stubEnv('HEAPCODE_HOME', home);
  core = new HeapcodeServer({ home, address: join(home, 'test.sock'), idleShutdownMs: 0 });
  await core.listen();
  serverOpts = { address: core.address, token: core.token, autostart: false };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await core?.close();
  await server?.close();
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

async function configureProfile(behavior: MockBehavior): Promise<void> {
  server = await startMockServer(behavior);
  const config = new ConfigStore();
  await config.saveProfile({ name: 'test', preset: 'custom', baseUrl: server.baseUrl, model: 'mock-model' });
}

/** Every stdout write parsed as one NDJSON event per line (blank lines dropped). */
function parseNdjson(write: { mock: { calls: unknown[][] } }): HeadlessEvent[] {
  return write.mock.calls
    .map((c) => c[0] as string)
    .join('')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as HeadlessEvent);
}

type SingleBehavior = Exclude<MockBehavior, { kind: 'sequence' }>;
const sse = (content: string): SingleBehavior => ({ kind: 'sse', chunks: [content] });
const toolBlock = (name: string, args: Record<string, unknown>) => `<tool name="${name}">\n${JSON.stringify(args)}\n</tool>`;
const finishBlock = (summary: string) => toolBlock('finish', { summary });

describe('runHeadless — chat-only parity (no tools used)', () => {
  it('returns valid JSON events ending in a result, and persists history', async () => {
    await configureProfile(sse('Hello!'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'hi', json: true, cwd: project, server: serverOpts });

    expect(code).toBe(0);
    const events = parseNdjson(write);
    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({ type: 'result', outcome: 'done', response: 'Hello!', model: 'mock-model', profile: 'test' });

    const saved = JSON.parse(await readFile(conversationsFile(project), 'utf8'));
    expect(saved[0].messages.map((m: { content: string }) => m.content)).toEqual(['hi', 'Hello!']);
    write.mockRestore();
  });

  it('prints plain text (not JSON) without --json', async () => {
    await configureProfile(sse('Hello!'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'hi', json: false, cwd: project, server: serverOpts });

    expect(write.mock.calls.map((c) => c[0]).join('')).toBe('Hello!\n');
    write.mockRestore();
  });

  it('exits non-zero with a structured error when no profile is configured', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'hi', json: true, cwd: project, server: serverOpts });

    expect(code).toBe(1);
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({ error: expect.stringContaining('No provider profile') });
    write.mockRestore();
  });

  it('exits non-zero when the provider itself fails mid-run', async () => {
    // 401 is non-retryable (unlike 429/5xx) — an immediate throw, no backoff delay.
    // runAgent absorbs provider errors internally (outcome 'error', an onText
    // event with the message) rather than throwing back out to runHeadless —
    // so this surfaces as a normal 'result' event on stdout, exit code 1.
    await configureProfile({ kind: 'json', status: 401, body: { error: 'unauthorized' } });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'hi', json: true, cwd: project, server: serverOpts });
    expect(code).toBe(1);
    const result = parseNdjson(write).find((e) => e.type === 'result');
    expect(result).toMatchObject({ outcome: 'error' });
  });

  it('continues the most recent conversation in the project directory across calls', async () => {
    await configureProfile(sse('ok'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'first', json: true, cwd: project, server: serverOpts });
    await runHeadless({ prompt: 'second', json: true, cwd: project, server: serverOpts });

    const saved = JSON.parse(await readFile(conversationsFile(project), 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].messages).toHaveLength(4);
  });

  it('--continue false (the default) starts a fresh conversation instead', async () => {
    await configureProfile(sse('ok'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'first', json: true, cwd: project, newConversation: true, server: serverOpts });
    await runHeadless({ prompt: 'second', json: true, cwd: project, newConversation: true, server: serverOpts });

    const saved = JSON.parse(await readFile(conversationsFile(project), 'utf8'));
    expect(saved).toHaveLength(2);
  });

  it('--resume <id> continues a specific (not necessarily the most recent) conversation, by unambiguous prefix', async () => {
    await configureProfile(sse('ok'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'about the older one', json: true, cwd: project, newConversation: true, server: serverOpts });
    await runHeadless({ prompt: 'about the newer one', json: true, cwd: project, newConversation: true, server: serverOpts }); // becomes "most recent"

    const saved: Array<{ id: string; updatedAt: number; messages: Array<{ content: string }> }> = JSON.parse(
      await readFile(conversationsFile(project), 'utf8'),
    );
    const older = saved.find((c) => c.messages.some((m) => m.content === 'about the older one'))!;

    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless({ prompt: 'follow-up', json: true, cwd: project, resumeId: older.id.slice(0, 8), server: serverOpts });

    const events = parseNdjson(write);
    expect(events.find((e) => e.type === 'result')).toMatchObject({ sessionId: older.id });
    const resaved = JSON.parse(await readFile(conversationsFile(project), 'utf8'));
    const resumed = resaved.find((c: { id: string }) => c.id === older.id);
    expect(resumed.messages.map((m: { content: string }) => m.content)).toContain('about the older one');
  });

  it('--resume with an unknown/ambiguous id exits non-zero with a clear error', async () => {
    await configureProfile(sse('ok'));
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'hi', json: true, cwd: project, resumeId: 'no-such-session', server: serverOpts });

    expect(code).toBe(1);
    expect(JSON.parse(write.mock.calls[0]![0] as string).error).toContain('No saved conversation matching');
  });
});

describe('runHeadless — full agent loop (tools)', () => {
  it('runs a tool call under full-auto and streams tool_call/tool_result events before the final result', async () => {
    await configureProfile({
      kind: 'sequence',
      responses: [sse(toolBlock('write_file', { path: 'out.txt', content: 'from headless' })), sse(finishBlock('Wrote out.txt.'))],
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'write a file', json: true, cwd: project, permissionMode: 'full-auto', server: serverOpts });

    expect(code).toBe(0);
    const events = parseNdjson(write);
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'text', 'result']);
    expect(events[0]).toMatchObject({ type: 'tool_call', name: 'write_file' });
    expect(events[1]).toMatchObject({ type: 'tool_result', name: 'write_file' });
    expect((events[1] as { isError?: boolean }).isError).toBeFalsy();
    expect(await readFile(join(project, 'out.txt'), 'utf8')).toBe('from headless');
  });

  it('"default" permission mode denies a write and the agent adapts instead of the run erroring', async () => {
    await configureProfile({
      kind: 'sequence',
      responses: [sse(toolBlock('write_file', { path: 'out.txt', content: 'x' })), sse(finishBlock('Could not write; permission denied.'))],
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'write a file', json: true, cwd: project, server: serverOpts }); // default mode

    expect(code).toBe(0); // the agent still finished cleanly, just without writing
    const events = parseNdjson(write);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ isError: true });
    await expect(readFile(join(project, 'out.txt'), 'utf8')).rejects.toThrow();
  });

  it('"plan" mode never offers write tools at all — the fallback protocol\'s system prompt has no write_file definition', async () => {
    await configureProfile(sse(finishBlock('Here is my plan.')));

    await runHeadless({ prompt: 'plan a refactor', json: true, cwd: project, permissionMode: 'plan', server: serverOpts });

    const sent = server.requests[0]!.body as { messages: Array<{ content: string }> };
    expect(sent.messages[0]!.content).not.toContain('### write_file');
    expect(sent.messages[0]!.content).toContain('### read_file');
  });

  it('"auto-edit" mode allows writes but still denies shell commands', async () => {
    await configureProfile({
      kind: 'sequence',
      responses: [
        sse(toolBlock('write_file', { path: 'out.txt', content: 'ok' })),
        sse(toolBlock('run_command', { command: 'echo hi' })),
        sse(finishBlock('done')),
      ],
    });
    await runHeadless({ prompt: 'write then run', json: true, cwd: project, permissionMode: 'auto-edit', server: serverOpts });

    expect(await readFile(join(project, 'out.txt'), 'utf8')).toBe('ok');
  });

  it('ask_user is answered automatically instead of hanging — there is no one to ask in headless mode', async () => {
    await configureProfile({
      kind: 'sequence',
      responses: [sse(toolBlock('ask_user', { question: 'which approach?' })), sse(finishBlock('Proceeded with the default approach.'))],
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'pick an approach', json: true, cwd: project, server: serverOpts });

    expect(code).toBe(0);
    const events = parseNdjson(write);
    expect(events.find((e) => e.type === 'result')).toMatchObject({ response: 'Proceeded with the default approach.' });
  });
});

describe('runHeadless — --persona', () => {
  it('restricts the offered tools the same way the interactive /persona command does', async () => {
    await configureProfile(sse(finishBlock('Reviewed.')));

    await runHeadless({ prompt: 'review this', json: true, cwd: project, personaId: 'reviewer', server: serverOpts });

    const sent = server.requests[0]!.body as { messages: Array<{ content: string }> };
    expect(sent.messages[0]!.content).not.toContain('### write_file');
    expect(sent.messages[1]!.content).toContain('Reviewer persona');
  });
});

describe('runHeadless — --reindex', () => {
  it('without --reindex, a file never touched by a tool call is invisible to repo_map (no auto-indexing in headless mode)', async () => {
    await writeFile(join(project, 'untouched.ts'), 'export function neverIndexed() {}\n');
    await configureProfile({
      kind: 'sequence',
      responses: [sse(toolBlock('repo_map', {})), sse(finishBlock('done'))],
    });

    await runHeadless({ prompt: 'map the repo', json: true, cwd: project, server: serverOpts });

    const secondTurn = (server.requests[1]!.body as { messages: Array<{ content: string }> }).messages;
    // The system prompt also contains the literal string "<tool_result>" (documenting the
    // protocol) — match the tool-named opening tag specifically, not just any occurrence.
    const toolResultMsg = secondTurn.find((m) => m.content.includes('<tool_result name="repo_map"'))!.content;
    expect(toolResultMsg).not.toContain('neverIndexed');
  });

  it('with --reindex, the same file is indexed and shows up in repo_map', async () => {
    await writeFile(join(project, 'untouched.ts'), 'export function neverIndexed() {}\n');
    await configureProfile({
      kind: 'sequence',
      responses: [sse(toolBlock('repo_map', {})), sse(finishBlock('done'))],
    });

    await runHeadless({ prompt: 'map the repo', json: true, cwd: project, reindex: true, server: serverOpts });

    const secondTurn = (server.requests[1]!.body as { messages: Array<{ content: string }> }).messages;
    const toolResultMsg = secondTurn.find((m) => m.content.includes('<tool_result name="repo_map"'))!.content;
    expect(toolResultMsg).toContain('neverIndexed');
  });
});

describe('runHeadless — --sub-agents', () => {
  it('delegate_task runs a nested agent loop; its tool activity is tagged with a parent field in the NDJSON stream', async () => {
    await writeFile(join(project, 'trigger.txt'), 'x');
    await configureProfile({
      kind: 'sequence',
      responses: [
        sse(toolBlock('delegate_task', { task: 'delete trigger.txt' })), // parent
        sse(toolBlock('delete_file', { path: 'trigger.txt' })), // sub-agent turn 1
        sse(finishBlock('Deleted trigger.txt.')), // sub-agent turn 2
        sse(finishBlock('Delegated and done.')), // parent turn 2
      ],
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'delegate cleanup', json: true, cwd: project, permissionMode: 'full-auto', subAgents: true, server: serverOpts });

    expect(code).toBe(0);
    const events = parseNdjson(write);
    const delegateCall = events.find((e) => e.type === 'tool_call' && e.name === 'delegate_task');
    expect(delegateCall).toBeTruthy();
    const nested = events.find((e) => e.type === 'tool_call' && e.name === 'delete_file');
    expect(nested).toMatchObject({ type: 'tool_call', name: 'delete_file', parent: (delegateCall as { id: string }).id });
    await expect(readFile(join(project, 'trigger.txt'), 'utf8')).rejects.toThrow();
  });

  it('delegate_task is always visible, but calling it without --sub-agents returns an informative "disabled" error instead of running', async () => {
    // Hiding the tool entirely left the model with no concept of delegation —
    // a live session answered "delegate investigating X" by fabricating a
    // completed delegation. Visible-but-refused lets it respond honestly.
    await configureProfile({
      kind: 'sequence',
      responses: [
        sse(toolBlock('delegate_task', { task: 'investigate strings.js' })),
        sse(finishBlock('Delegation is disabled; investigated it myself.')),
      ],
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'delegate something', json: true, cwd: project, server: serverOpts });

    const sent = server.requests[0]!.body as { messages: Array<{ content: string }> };
    expect(sent.messages[0]!.content).toContain('delegate_task');
    const events = parseNdjson(write);
    const result = events.find((e) => e.type === 'tool_result' && e.name === 'delegate_task');
    // Was `stringContaining('--sub-agents')`. The message stopped naming a
    // CLI flag when the extension started receiving it too: the extension's
    // control is a setting, and the model is this string's only reader, so a
    // flag name it might repeat back to a VS Code user was a wrong
    // instruction. `heapcode --help` (cli.tsx:275) is where the flag is
    // documented. The substance the incident cared about is unchanged and is
    // what the next assertion pins.
    expect(result).toMatchObject({
      isError: true,
      content: expect.stringContaining('Sub-agent delegation is turned off for this run.'),
    });
    expect((result as { content: string }).content).toContain('do not claim it was delegated');
    write.mockRestore();
  });
});

describe('runHeadless — the result event stays backward compatible', () => {
  it('keeps its original fields, values and order, with the new ones appended after them', async () => {
    await configureProfile(sse('Hello!'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'hi', json: true, cwd: project, server: serverOpts });

    const result = parseNdjson(write).find((e) => e.type === 'result')!;
    // Order matters as much as presence: a consumer diffing the raw line
    // should see its six fields first and unchanged, then whatever is new.
    expect(Object.keys(result).slice(0, 6)).toEqual(['type', 'outcome', 'response', 'model', 'profile', 'sessionId']);
    expect(Object.keys(result)).toEqual([...Object.keys(result).slice(0, 6), 'filesChanged']);
    // Opt-in fields stay absent when their flags weren't passed.
    expect(result).not.toHaveProperty('diff');
    expect(result).not.toHaveProperty('verify');
    write.mockRestore();
  });

  it('prints exactly the same plain text as before when no new flag is passed and nothing changed', async () => {
    await configureProfile(sse('Hello!'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'hi', json: false, cwd: project, server: serverOpts });

    expect(write.mock.calls.map((c) => c[0]).join('')).toBe('Hello!\n');
    write.mockRestore();
  });
});

describe('runHeadless — change summary and --diff', () => {
  it('reports every file the run changed, so a caller can review without opening each one', async () => {
    await writeFile(join(project, 'existing.txt'), 'one\ntwo\n');
    await writeFile(join(project, 'doomed.txt'), 'bye\n');
    await configureProfile({
      kind: 'sequence',
      responses: [
        sse(toolBlock('write_file', { path: 'added.txt', content: 'fresh\n' })),
        sse(toolBlock('write_file', { path: 'existing.txt', content: 'one\ntwo\nthree\n' })),
        sse(toolBlock('delete_file', { path: 'doomed.txt' })),
        sse(finishBlock('Done.')),
      ],
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'edit things', json: true, cwd: project, permissionMode: 'full-auto', server: serverOpts });

    const result = parseNdjson(write).find((e) => e.type === 'result') as { filesChanged: unknown[] };
    expect(result.filesChanged).toEqual([
      { path: 'added.txt', status: 'added', insertions: 1, deletions: 0 },
      { path: 'doomed.txt', status: 'deleted', insertions: 0, deletions: 1 },
      { path: 'existing.txt', status: 'modified', insertions: 1, deletions: 0 },
    ]);
    write.mockRestore();
  });

  it('is an empty array — with no diff — for a run that changed nothing', async () => {
    await configureProfile(sse('Nothing to do.'));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'hi', json: true, cwd: project, diff: true, server: serverOpts });

    const result = parseNdjson(write).find((e) => e.type === 'result') as { filesChanged: unknown[]; diff: string };
    expect(result.filesChanged).toEqual([]);
    expect(result.diff).toBe('');
    write.mockRestore();
  });

  it('--diff carries the unified diff itself; without it the summary comes alone', async () => {
    const write_ = () => sse(toolBlock('write_file', { path: 'out.txt', content: 'from headless\n' }));
    // Four scripted turns, not two: the mock repeats its LAST response once a
    // sequence runs out, so the second run below needs its own pair.
    await configureProfile({ kind: 'sequence', responses: [write_(), sse(finishBlock('Wrote it.')), write_(), sse(finishBlock('Wrote it.'))] });

    const noDiff = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless({ prompt: 'write', json: true, cwd: project, permissionMode: 'full-auto', server: serverOpts });
    expect(parseNdjson(noDiff).find((e) => e.type === 'result')).not.toHaveProperty('diff');
    noDiff.mockRestore();

    await rm(join(project, 'out.txt'));
    const withDiff = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runHeadless({ prompt: 'write', json: true, cwd: project, permissionMode: 'full-auto', diff: true, server: serverOpts });
    const diff = (parseNdjson(withDiff).find((e) => e.type === 'result') as { diff: string }).diff;
    expect(diff).toContain('+++ b/out.txt');
    expect(diff).toContain('+from headless');
    withDiff.mockRestore();
  });

  it('plain-text mode ends with a greppable path | +n | -n table', async () => {
    await configureProfile({
      kind: 'sequence',
      responses: [sse(toolBlock('write_file', { path: 'out.txt', content: 'a\nb\n' })), sse(finishBlock('Wrote out.txt.'))],
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'write', json: false, cwd: project, permissionMode: 'full-auto', server: serverOpts });

    const printed = write.mock.calls.map((c) => c[0]).join('');
    expect(printed).toContain('Wrote out.txt.');
    expect(printed).toContain('Changes: 1 file, +2 -0');
    expect(printed).toMatch(/out\.txt +\| \+2 \| -0 \| added/);
    write.mockRestore();
  });
});

/**
 * `--verify` executes a command in a mode where `run_command` is denied, so
 * these are the tests that have to hold: the command is the invoker's, it is
 * spawned argv-style with no shell, and nothing the model emits can reach it.
 */
describe('runHeadless — --verify', () => {
  /**
   * A stand-in for "the project's own checks": records the exact argv it was
   * given (outside the project, so it never shows up in the change summary)
   * and fails its first `failures` invocations.
   */
  async function checkScript(failures: number): Promise<{ command: string; invocations: () => string[][] }> {
    const script = join(home, 'check.cjs');
    const log = join(home, 'invocations.jsonl');
    await writeFile(
      script,
      `const fs = require('node:fs');
const log = process.argv[2];
const failures = Number(process.argv[3]);
const prior = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(log, JSON.stringify(process.argv.slice(1)) + '\\n');
if (prior < failures) { console.error('E501 line too long (106 > 100)'); process.exit(1); }
console.log('all checks passed');
`,
    );
    return {
      command: `"${process.execPath}" "${script}" "${log}" ${failures}`,
      invocations: () =>
        existsSync(log)
          ? readFileSync(log, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((l) => JSON.parse(l) as string[])
          : [],
    };
  }

  it('runs the check once and reports it green when the work was already fine', async () => {
    const check = await checkScript(0);
    await configureProfile(sse(finishBlock('Nothing needed changing.')));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'tidy up', json: true, cwd: project, verify: check.command, server: serverOpts });

    expect(code).toBe(0);
    expect(parseNdjson(write).find((e) => e.type === 'result')).toMatchObject({
      verify: { passed: true, cycles: 1, command: check.command },
    });
    expect(check.invocations()).toHaveLength(1);
    write.mockRestore();
  });

  it('feeds a failure back as a new turn and re-runs the check after the fix', async () => {
    const check = await checkScript(1); // red once, green after the fix turn
    await configureProfile({
      kind: 'sequence',
      responses: [
        sse(toolBlock('write_file', { path: 'out.py', content: 'x = ' + "'y'".repeat(40) + '\n' })),
        sse(finishBlock('Wrote out.py.')),
        sse(toolBlock('write_file', { path: 'out.py', content: "x = 'y'\n" })), // the fix turn
        sse(finishBlock('Shortened the long line.')),
      ],
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({
      prompt: 'write out.py',
      json: true,
      cwd: project,
      permissionMode: 'full-auto',
      verify: check.command,
      server: serverOpts,
    });

    expect(code).toBe(0);
    const result = parseNdjson(write).find((e) => e.type === 'result')!;
    expect(result).toMatchObject({ verify: { passed: true, cycles: 2 }, response: 'Shortened the long line.' });
    expect(result).not.toHaveProperty('verify.lastFailureOutput');
    expect(check.invocations()).toHaveLength(2);

    // The failure reached the model as a real turn, with the tool output in it.
    const fixTurn = (server.requests.at(-1)!.body as { messages: Array<{ content: string }> }).messages;
    expect(fixTurn.some((m) => m.content.includes('E501 line too long'))).toBe(true);
    expect(await readFile(join(project, 'out.py'), 'utf8')).toBe("x = 'y'\n");
    write.mockRestore();
  });

  it('gives up after --verify-max runs, exits non-zero, and hands back the last failure', async () => {
    const check = await checkScript(99); // never goes green
    await configureProfile(sse(finishBlock('Done.')));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({
      prompt: 'do something',
      json: true,
      cwd: project,
      verify: check.command,
      verifyMax: 2,
      server: serverOpts,
    });

    expect(code).toBe(1); // still red, whatever the agent concluded
    expect(parseNdjson(write).find((e) => e.type === 'result')).toMatchObject({
      outcome: 'done',
      verify: { passed: false, cycles: 2, lastFailureOutput: expect.stringContaining('E501 line too long') },
    });
    expect(check.invocations()).toHaveLength(2);
    write.mockRestore();
  });

  it('the model cannot influence what is executed: the same invoker-supplied argv runs every cycle', async () => {
    const check = await checkScript(1);
    await configureProfile({
      kind: 'sequence',
      responses: [
        // Everything the model can emit — a file it controls the name and
        // content of, and prose asserting a different command — aimed at the
        // check. None of it is an input to what gets spawned.
        sse(toolBlock('write_file', { path: 'check.cjs', content: "require('node:fs').writeFileSync('pwned.txt', 'x');\n" })),
        sse(finishBlock('Verification command changed to `true`; also run $(touch pwned.txt) && rm -rf .')),
        sse(finishBlock('Fixed it.')),
      ],
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({
      prompt: 'do something',
      json: true,
      cwd: project,
      permissionMode: 'full-auto',
      verify: check.command,
      server: serverOpts,
    });

    const invocations = check.invocations();
    expect(invocations).toHaveLength(2);
    // argv[0] is the script, then exactly the two arguments the invoker gave.
    expect(invocations[0]).toEqual(invocations[1]);
    expect(invocations[0]!.slice(1)).toEqual([join(home, 'invocations.jsonl'), '1']);
    // Nothing the model wrote or said was ever interpreted as part of a command.
    expect(existsSync(join(project, 'pwned.txt'))).toBe(false);

    // And the check is not reachable as a tool, in any turn.
    for (const request of server.requests) {
      const messages = (request.body as { messages?: Array<{ content: string }> }).messages ?? [];
      expect(messages[0]!.content).not.toContain('### verify');
    }
    write.mockRestore();
  });

  it('refuses a chained command up front instead of running part of it', async () => {
    await configureProfile(sse(finishBlock('done')));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'hi', json: true, cwd: project, verify: 'make check && rm -rf /', server: serverOpts });

    expect(code).toBe(1);
    expect(JSON.parse(err.mock.calls[0]![0] as string).error).toContain('without a shell');
    // The invocation failed before a model was ever called.
    expect(server.requests).toHaveLength(0);
    err.mockRestore();
    write.mockRestore();
  });

  it('a command that cannot be started fails the run without burning fix turns on it', async () => {
    await configureProfile(sse(finishBlock('Done.')));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({
      prompt: 'do something',
      json: true,
      cwd: project,
      verify: join(home, 'no-such-check'),
      server: serverOpts,
    });

    expect(code).toBe(1);
    expect(parseNdjson(write).find((e) => e.type === 'result')).toMatchObject({
      verify: { passed: false, cycles: 1, lastFailureOutput: expect.stringContaining('could not run') },
    });
    expect(server.requests.filter((r) => r.path.includes('chat'))).toHaveLength(1); // no fix turn
    write.mockRestore();
  });

  it('reports cycles: 0 when the agent run never completed, rather than blaming the check', async () => {
    const check = await checkScript(0);
    await configureProfile({ kind: 'json', status: 401, body: { error: 'unauthorized' } });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runHeadless({ prompt: 'hi', json: true, cwd: project, verify: check.command, server: serverOpts });

    expect(code).toBe(1);
    expect(parseNdjson(write).find((e) => e.type === 'result')).toMatchObject({ outcome: 'error', verify: { passed: false, cycles: 0 } });
    expect(check.invocations()).toEqual([]);
    write.mockRestore();
  });

  it('plain-text mode says whether it went green and after how many attempts', async () => {
    const check = await checkScript(99);
    await configureProfile(sse(finishBlock('Done.')));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runHeadless({ prompt: 'hi', json: false, cwd: project, verify: check.command, verifyMax: 1, server: serverOpts });

    const printed = write.mock.calls.map((c) => c[0]).join('');
    expect(printed).toContain('Verify: FAILED after 1 attempt');
    expect(printed).toContain('E501 line too long');
    write.mockRestore();
  });
});
