import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REVIEW_CLIENT,
  HeapcodeServer,
  METHODS,
  PROTOCOL_VERSION,
  RpcPeer,
  type HelloParams,
  type ProviderProfileConfig,
  type ReviewConfirmParams,
  type ReviewConfirmResult,
  type ReviewEvent,
  type ReviewEventParams,
  type ReviewRunParams,
  type ReviewRunResult,
  type ToolDefinition,
  type ToolExecuteParams,
  type ToolResult,
} from '../src/index.js';

/**
 * `review/run` over a real socket.
 *
 * PR review is not a one-shot call — it is a multi-pass read-only tool loop
 * with its own structural-termination policy (prReview.ts:181-257), so it gets
 * its own method rather than going through agent/run, exactly as chat/send did.
 * The loop itself was already host-agnostic in core, so what these tests
 * exercise is the wiring: the Provider coming from the session, the five host
 * callbacks crossing as messages, the read-only tools running host-side over
 * tool/execute, and the confirm gate before anything posts.
 *
 * `gh` is stubbed as a script on PATH — that is the only way to drive the real
 * orchestrator end to end without touching GitHub, and it also pins that the
 * server runs `gh` in the session's root rather than its own cwd.
 */

interface Endpoint {
  baseUrl: string;
  close(): Promise<void>;
  requests: Array<{ model?: string; messages?: unknown[]; tools?: Array<{ function?: { name?: string } }> }>;
  /** Replies handed out in order; the last one repeats. */
  script: Array<{ content?: string; toolCalls?: Array<{ name: string; args: unknown }> }>;
}

async function startEndpoint(): Promise<Endpoint> {
  const requests: Endpoint['requests'] = [];
  const script: Endpoint['script'] = [];
  let turn = 0;
  const server: HttpServer = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      requests.push(raw ? JSON.parse(raw) : {});
      const next = script[Math.min(turn++, script.length - 1)] ?? {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: next.content ?? '',
                tool_calls: next.toolCalls?.map((c, i) => ({
                  id: `call-${turn}-${i}`,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    script,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '+const b = parseInt(input);',
  ' const c = 3;',
].join('\n');

/**
 * A `gh` stub on PATH. `pr view`/`pr diff` answer from fixtures; every posting
 * verb records its argv and stdin to a file so a test can assert whether — and
 * with what — the review posted.
 */
async function installGhStub(
  binDir: string,
  postLog: string,
  opts: { version?: boolean; oversized?: boolean } = {},
): Promise<void> {
  // `oversized` reproduces what GitHub actually does above 20,000 diff lines:
  // it refuses the `.diff` media type outright, while the per-file endpoint
  // keeps answering. That combination is not hypothetical -- it is what a
  // real PR in this repo did, and it used to end the review with "no changes,
  // or gh failed".
  const prDiff = opts.oversized
    ? `  echo "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)" >&2
  exit 1`
    : `  cat <<'DIFF_EOF'
${DIFF}
DIFF_EOF
  exit 0`;
  const script = `#!/bin/sh
case "$1 $2" in
  "--version ") ${opts.version === false ? 'exit 1' : 'echo "gh version 2.0.0"; exit 0'} ;;
esac
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo '{"number":42,"title":"Add b","url":"https://github.com/o/r/pull/42","headRefOid":"abc123","baseRefName":"main"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
${prDiff}
fi
case "$1 $2" in
  # Only the file-listing call. Posting a review also goes through \`gh api\`,
  # and swallowing that here would make every posting assertion pass vacuously.
  "api "*"/files") ${
    opts.oversized
      ? // A heredoc rather than echo: /bin/sh on macOS expands backslash
        // escapes, which would turn the newline escapes inside a JSON patch
        // into real newlines and split the line into unparseable fragments.
        `cat <<'FILES_EOF'
{"filename":"src/a.ts","status":"modified","patch":"@@ -1,3 +1,4 @@\\n const a = 1;\\n+const b = parseInt(input);\\n const c = 3;"}
{"filename":"assets/logo.png","status":"added"}
FILES_EOF
    exit 0`
      : `exit 0`
  } ;;
esac
{ echo "ARGV: $@"; echo "PWD: $(pwd)"; echo "STDIN:"; cat; } >> "${postLog}"
exit 0
`;
  await writeFile(join(binDir, 'gh'), script, 'utf8');
  await chmod(join(binDir, 'gh'), 0o755);
}

const READ_TOOL: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  permission: 'read',
};
const WRITE_TOOL: ToolDefinition = {
  name: 'write_file',
  description: 'Write a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  permission: 'write',
};

let root: string;
let home: string;
let binDir: string;
let postLog: string;
let server: HeapcodeServer;
let endpoint: Endpoint;
let sockets: Socket[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-review-ws-'));
  home = await mkdtemp(join(tmpdir(), 'heapcode-review-home-'));
  binDir = await mkdtemp(join(tmpdir(), 'heapcode-review-bin-'));
  postLog = join(binDir, 'posts.log');
  await installGhStub(binDir, postLog);
  vi.stubEnv('PATH', `${binDir}:${process.env.PATH ?? ''}`);
  endpoint = await startEndpoint();
  sockets = [];
  server = new HeapcodeServer({ home, address: join(home, 't.sock'), idleShutdownMs: 0 });
  await server.listen();
});

afterEach(async () => {
  for (const s of sockets) s.destroy();
  await server?.close();
  await endpoint?.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
  await rm(binDir, { recursive: true, force: true });
});

function profile(extra: Partial<ProviderProfileConfig> = {}): ProviderProfileConfig {
  return { name: 'test', preset: 'custom', baseUrl: endpoint.baseUrl, model: 'chat', ...extra };
}

interface Client {
  peer: RpcPeer;
  events: ReviewEvent[];
  executed: string[];
  confirmations: ReviewConfirmParams['confirmation'][];
  /** What the host answers at the confirm gate. */
  approve: boolean;
  run(params?: Partial<ReviewRunParams>): Promise<ReviewRunResult>;
  runId: string;
}

async function client(hello: Partial<HelloParams> = {}): Promise<Client> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect(server.address);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  sockets.push(socket);
  const peer = new RpcPeer(socket, 'c');
  const state: Client = {
    peer,
    events: [],
    executed: [],
    confirmations: [],
    approve: true,
    runId: 'review-1',
    run: (params = {}) =>
      peer.request<ReviewRunResult>(METHODS.reviewRun, {
        model: 'chat',
        contextWindow: 32_000,
        tools: [READ_TOOL, WRITE_TOOL],
        client: DEFAULT_REVIEW_CLIENT,
        runId: state.runId,
        ...params,
      } satisfies ReviewRunParams),
  };

  peer.onRequest(METHODS.toolExecute, async (raw) => {
    const { call } = raw as ToolExecuteParams;
    state.executed.push(call.name);
    return { id: call.id, name: call.name, content: 'const b = parseInt(input);' } satisfies ToolResult;
  });
  peer.onRequest(METHODS.reviewConfirm, async (raw) => {
    const { confirmation } = raw as ReviewConfirmParams;
    state.confirmations.push(confirmation);
    return { ok: state.approve } satisfies ReviewConfirmResult;
  });
  peer.onNotification(METHODS.reviewEvent, (raw) => {
    state.events.push((raw as ReviewEventParams).event);
  });

  await peer.request(METHODS.hello, {
    token: server.token,
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test' },
    root,
    profiles: [profile()],
    activeProfile: 'test',
    ...hello,
  } satisfies HelloParams);
  return state;
}

/** A scripted reply whose terminal call ends a batch pass with one finding. */
const REPORT_ONE_FINDING = { toolCalls: [{
  name: 'report_findings',
  args: {
    summary: 'Adds b without validating the parse.',
    findings: [
      {
        file: 'src/a.ts',
        line: 2,
        severity: 'medium',
        category: 'correctness',
        summary: 'parseInt can return NaN',
        failure_scenario: 'input is "abc" → b is NaN → downstream arithmetic silently yields NaN.',
      },
    ],
  },
}] };

describe('review/run', () => {
  it('runs the review and posts on confirmation, with no Provider in the host', async () => {
    endpoint.script.push(REPORT_ONE_FINDING);
    const c = await client();

    const result = await c.run();

    expect(result).toEqual({
      status: 'posted',
      pr: {
        number: 42,
        title: 'Add b',
        url: 'https://github.com/o/r/pull/42',
        headRefOid: 'abc123',
        // Carried so the diff fetcher can fall back to the local checkout for
        // files the API declines to patch.
        baseRefName: 'main',
      },
    });
    expect(c.confirmations).toHaveLength(1);
    expect(c.confirmations[0]!.findingCount).toBe(1);
    expect(c.confirmations[0]!.preview).toContain('parseInt can return NaN');
  });

  it('runs gh in the session root, not the server\'s own cwd', async () => {
    endpoint.script.push(REPORT_ONE_FINDING);
    const c = await client();

    await c.run();

    const { readFile, realpath } = await import('node:fs/promises');
    const log = await readFile(postLog, 'utf8');
    expect(log).toContain(`PWD: ${await realpath(root)}`);
  });

  it('posts nothing when the host declines at the confirm gate', async () => {
    endpoint.script.push(REPORT_ONE_FINDING);
    const c = await client();
    c.approve = false;

    const result = await c.run();

    expect(result).toEqual({ status: 'cancelled' });
    const { access } = await import('node:fs/promises');
    // The gh stub only writes this file on a posting verb.
    await expect(access(postLog)).rejects.toThrow();
  });

  it('reports progress and warnings as review/event notifications', async () => {
    endpoint.script.push(REPORT_ONE_FINDING);
    const c = await client();

    await c.run();

    expect(c.events.some((e) => e.kind === 'progress' && e.message.includes('reviewing the diff'))).toBe(true);
  });

  it('executes the review\'s read-only tools host-side over tool/execute', async () => {
    // First model turn calls read_file; the second terminates the pass.
    endpoint.script.push({ toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts' } }] }, REPORT_ONE_FINDING);
    const c = await client();

    await c.run();

    expect(c.executed).toEqual(['read_file']);
  });

  it('offers the model only read-only tools, never the host\'s write tools', async () => {
    // prReview filters on permission; write_file was in the sent list and must
    // not reach the model.
    endpoint.script.push(REPORT_ONE_FINDING);
    const c = await client();

    await c.run();

    const offered = (endpoint.requests[0]!.tools ?? []).map((t) => t.function?.name);
    expect(offered).toContain('read_file');
    expect(offered).toContain('report_findings');
    expect(offered).not.toContain('write_file');
  });

  it('skips with a warning when gh is unavailable', async () => {
    await installGhStub(binDir, postLog, { version: false });
    const c = await client();

    const result = await c.run();

    expect(result).toEqual({ status: 'skipped' });
    expect(c.events.some((e) => e.kind === 'error' && e.message.includes('GitHub CLI'))).toBe(true);
    expect(endpoint.requests).toEqual([]);
  });

  it('skips when the workspace is not a directory the server can read', async () => {
    // The same guard RAG uses — gh needs a real checkout.
    const c = await client({ localRoot: false });

    const result = await c.run();

    expect(result).toEqual({ status: 'skipped' });
    expect(c.events.some((e) => e.kind === 'warn' && e.message.includes('local checkout'))).toBe(true);
  });

  it('uses the model the host resolved, so agentModel wins where the host applied it', async () => {
    endpoint.script.push(REPORT_ONE_FINDING);
    const c = await client();

    await c.run({ model: 'big-agent-model' });

    expect(endpoint.requests[0]!.model).toBe('big-agent-model');
  });

  it('makes a single pass in fast mode', async () => {
    endpoint.script.push(REPORT_ONE_FINDING);
    const c = await client();

    await c.run();

    expect(endpoint.requests).toHaveLength(1);
    expect(c.events.some((e) => e.kind === 'progress' && e.message.includes('verifying'))).toBe(false);
    // Fast mode says so in the preview rather than implying the findings were
    // adjudicated (ReviewNotes.singlePass).
    expect(c.confirmations[0]!.preview).toMatch(/single|unverified|not verified/i);
  });

  it('adds a verification pass in deep mode', async () => {
    endpoint.script.push(REPORT_ONE_FINDING, {
      toolCalls: [
        {
          name: 'report_verdicts',
          args: { overall_summary: 'One real issue.', verdicts: [{ index: 0, verdict: 'confirmed' }] },
        },
      ],
    });
    const c = await client();

    const result = await c.run({ deep: true });

    expect(result.status).toBe('posted');
    expect(endpoint.requests).toHaveLength(2);
    expect(c.events.some((e) => e.kind === 'progress' && e.message.includes('verifying'))).toBe(true);
    expect(c.confirmations[0]!.preview).toContain('One real issue.');
  });
});

describe('review/run — when GitHub refuses the diff', () => {
  /**
   * GitHub caps the `.diff` media type at 20,000 lines, and a branch that adds
   * a feature reaches that. `gh pr diff` then fails, and the review used to
   * stop there and report "no changes, or gh failed" -- which is neither of the
   * two things that had happened, and sends whoever is debugging it to check
   * their `gh` install.
   *
   * These drive the whole orchestrator over that refusal, because the failure
   * was not in any one function: every piece worked, and the only thing wrong
   * was that nothing tried the endpoint that would have answered.
   */

  it('reviews and posts anyway, from the per-file endpoint', async () => {
    await installGhStub(binDir, postLog, { oversized: true });
    endpoint.script.push(REPORT_ONE_FINDING);
    const c = await client();

    const result = await c.run();

    expect(result.status).toBe('posted');
    expect(c.confirmations[0]!.findingCount).toBe(1);
  });

  it('still sends the model the changed code, not an empty diff', async () => {
    await installGhStub(binDir, postLog, { oversized: true });
    endpoint.script.push(REPORT_ONE_FINDING);
    const c = await client();

    await c.run();

    const sent = JSON.stringify(endpoint.requests[0]?.messages ?? []);
    expect(sent).toContain('src/a.ts');
    expect(sent).toContain('parseInt(input)');
  });

  it('names the files it could not get a patch for', async () => {
    // The binary in the stub's file list. A file nobody reviewed must not read
    // as a file with nothing wrong in it.
    await installGhStub(binDir, postLog, { oversized: true });
    endpoint.script.push(REPORT_ONE_FINDING);
    const c = await client();

    await c.run();

    expect(
      c.events.some((e) => e.kind === 'warn' && e.message.includes('assets/logo.png')),
    ).toBe(true);
  });

  it('verifies in deep mode over the same fallback', async () => {
    await installGhStub(binDir, postLog, { oversized: true });
    endpoint.script.push(REPORT_ONE_FINDING, {
      toolCalls: [
        {
          name: 'report_verdicts',
          args: { overall_summary: 'One real issue.', verdicts: [{ index: 0, verdict: 'confirmed' }] },
        },
      ],
    });
    const c = await client();

    const result = await c.run({ deep: true });

    expect(result.status).toBe('posted');
    expect(endpoint.requests).toHaveLength(2);
    expect(c.events.some((e) => e.kind === 'progress' && e.message.includes('verifying'))).toBe(true);
    expect(c.confirmations[0]!.preview).toContain('One real issue.');
  });

  it('reports what gh said when nothing can produce a diff', async () => {
    // `pr diff` refuses and the file listing is not stubbed to answer, so both
    // sources fail -- the case the old message described badly.
    const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo '{"number":42,"title":"Add b","url":"https://github.com/o/r/pull/42","headRefOid":"abc123","baseRefName":"main"}'
  exit 0
fi
echo "HTTP 403: rate limit exceeded" >&2
exit 1
`;
    const { writeFile: wf, chmod: cm } = await import('node:fs/promises');
    await wf(join(binDir, 'gh'), script, 'utf8');
    await cm(join(binDir, 'gh'), 0o755);

    const c = await client();
    const result = await c.run();

    expect(result.status).toBe('skipped');
    expect(
      c.events.some((e) => e.kind === 'warn' && e.message.includes('rate limit exceeded')),
    ).toBe(true);
  });
});

describe('review/run — cancellation', () => {
  it('stops an in-flight tool call, not just the model call', async () => {
    // The standard prior migrations set: aborting must reach whatever the host
    // is running, which here is a tool/execute that never returns on its own.
    endpoint.script.push({ toolCalls: [{ name: 'read_file', args: { path: 'src/a.ts' } }] }, REPORT_ONE_FINDING);
    const c = await client();
    let toolAborted = false;
    let toolStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (toolStarted = resolve));
    c.peer.onRequest(METHODS.toolExecute, async (raw, signal) => {
      const { call } = raw as ToolExecuteParams;
      toolStarted?.();
      await new Promise<void>((resolve) => {
        // Never settles on its own — only the server's $/cancelRequest ends it.
        signal.addEventListener('abort', () => {
          toolAborted = true;
          resolve();
        });
      });
      return { id: call.id, name: call.name, content: 'aborted' } satisfies ToolResult;
    });

    const pending = c.run();
    await started;
    c.peer.notify(METHODS.agentCancel, { runId: c.runId });

    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(toolAborted).toBe(true);
    const { access } = await import('node:fs/promises');
    await expect(access(postLog)).rejects.toThrow();
  });

  it('treats a cancellation during the confirm gate as "do not post"', async () => {
    // Both hosts already turned an abort at the prompt into false rather than
    // an error; over the socket that has to keep holding.
    endpoint.script.push(REPORT_ONE_FINDING);
    const c = await client();
    c.peer.onRequest(METHODS.reviewConfirm, async () => {
      c.peer.notify(METHODS.agentCancel, { runId: c.runId });
      // Never answers — the server's own cancellation has to settle this.
      return new Promise<ReviewConfirmResult>(() => {});
    });

    await expect(c.run()).resolves.toEqual({ status: 'cancelled' });
    const { access } = await import('node:fs/promises');
    await expect(access(postLog)).rejects.toThrow();
  });
});
