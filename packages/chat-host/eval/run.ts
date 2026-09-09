/**
 * Heap Chat's grounded-QA benchmark.
 *
 * The corpus is heapchat's, ported whole: twelve cases over seven fixture
 * documents (`docs/CHAT_MODE_PLAN.md` C2). It is the one thing in that
 * codebase `extraction-audit.md` called a genuine benchmark seed, and it
 * survives the move because it never touched heapchat's untested code — it is
 * questions, expected substrings, and traps.
 *
 * What it is for: a number to point at before C3 changes how answers are
 * grounded. Answer quality regressions are otherwise invisible until someone
 * notices the assistant has started making things up.
 *
 * Deliberately runs against a REAL model and a REAL index, not a mock. A
 * mocked run would test the plumbing this repo already tests elsewhere and
 * would say nothing about whether the assistant answers correctly, which is
 * the only question the corpus asks.
 *
 *   HEAPCODE_HOME=/path/to/config node eval/run.ts [--json out.json]
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeapcodeServer, RpcPeer, connectToServer, type AgentEvent } from '@heapcode/core';
import { ConfigStore, SecretsStore, configFile, secretsFile } from '@heapcode/host';
import { WorkspaceStore, webSocketDuplex } from '@heapcode/web-host';
import { startChatHost } from '../src/server.js';
import { CHAT_METHODS, CHAT_PROTOCOL_VERSION } from '../src/protocol.js';
import WebSocket from 'ws';

// The bundle lands in eval/.out/, so `import.meta.url` is one level deeper
// than the corpus it has to read. Resolved rather than copied: golden.json and
// the fixtures are the artefact under version control, and a build step that
// duplicated them would let the two drift.
const here = dirname(fileURLToPath(import.meta.url));
const evalDir = here.endsWith('.out') ? dirname(here) : here;

interface GoldenCase {
  id: string;
  q: string;
  /** Each entry is a regex; alternation is used for "any of these spellings". */
  expect_contains?: string[];
  expect_not_contains?: string[];
  /** The answer should be grounded in the files rather than general knowledge. */
  expect_grounded?: boolean;
  /** A file the run should actually have consulted. */
  expect_source?: string;
  note?: string;
}

interface CaseResult {
  id: string;
  passed: boolean;
  failures: string[];
  /** Recorded, not asserted, until C3 gives the host a grounding signal. */
  groundedPending?: boolean;
  answer: string;
  toolCalls: string[];
  ms: number;
}

async function main(): Promise<void> {
  const cases = JSON.parse(await readFile(join(evalDir, 'golden.json'), 'utf8')) as GoldenCase[];
  const fixtures = realpathSync(join(evalDir, 'fixtures'));

  const home = await mkdtemp(join(tmpdir(), 'heapchat-eval-'));
  const daemon = new HeapcodeServer({ home, address: join(home, 'eval.sock'), idleShutdownMs: 0 });
  await daemon.listen();

  const config = new ConfigStore(configFile());
  if (!(await config.getActiveProfile())) {
    process.stderr.write('No provider connection configured. Set HEAPCODE_HOME or run `heapcode connection add`.\n');
    process.exit(1);
  }

  const host = await startChatHost({
    root: fixtures,
    config,
    secrets: new SecretsStore(secretsFile()),
    // Under the throwaway home, so a benchmark run never edits the recent list.
    workspaces: new WorkspaceStore(join(home, 'workspaces.json')),
    port: 0,
    connect: (hello) =>
      connectToServer(
        { client: { name: 'heapchat-eval' }, ...hello },
        { address: daemon.address, token: daemon.token, autostart: false },
      ),
  });

  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/rpc?token=${host.token}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const peer = new RpcPeer(webSocketDuplex(ws as never), 'eval');

  /** Tool calls for the case in flight — `expect_source` asks what was consulted. */
  let toolCalls: string[] = [];
  peer.onNotification(CHAT_METHODS.event, (raw) => {
    const { event } = raw as { event: AgentEvent };
    if (event.type === 'tool_call') toolCalls.push(`${event.name}(${JSON.stringify(event.args)})`);
  });
  // ask_user has no one to ask in a benchmark; answering nothing is the honest
  // stand-in and lets the run finish rather than hanging on a question.
  peer.onRequest(CHAT_METHODS.askUser, async () => ({ answer: '' }));

  await peer.request(CHAT_METHODS.hello, {
    protocolVersion: CHAT_PROTOCOL_VERSION,
    client: { name: 'heapchat-eval' },
  });

  process.stdout.write(`\n  Heap Chat eval — ${cases.length} cases over ${fixtures}\n\n`);
  await waitForIndex(peer);

  const results: CaseResult[] = [];
  for (const c of cases) {
    toolCalls = [];
    const started = Date.now();
    // A fresh conversation per case: one case's answer must never be context
    // for the next, or the corpus stops measuring retrieval and starts
    // measuring whether the transcript happened to carry the answer along.
    await peer.request(CHAT_METHODS.newConversation, undefined);

    let answer = '';
    try {
      await peer.request(CHAT_METHODS.sendMessage, { text: c.q });
      answer = await lastAnswer(peer);
    } catch (err) {
      answer = `[run failed: ${err instanceof Error ? err.message : String(err)}]`;
    }

    const failures: string[] = [];
    for (const pattern of c.expect_contains ?? []) {
      if (!new RegExp(pattern, 'i').test(answer)) failures.push(`missing /${pattern}/`);
    }
    for (const pattern of c.expect_not_contains ?? []) {
      if (new RegExp(pattern, 'i').test(answer)) failures.push(`should not match /${pattern}/`);
    }
    if (c.expect_source) {
      const consulted = toolCalls.some((t) => t.includes(c.expect_source!)) || answer.includes(c.expect_source);
      if (!consulted) failures.push(`never consulted ${c.expect_source}`);
    }

    const result: CaseResult = {
      id: c.id,
      passed: failures.length === 0,
      failures,
      // Recorded, not asserted: the host has no grounding signal to check
      // until C3, and a check that always passes is worse than an absent one.
      groundedPending: c.expect_grounded !== undefined,
      answer,
      toolCalls,
      ms: Date.now() - started,
    };
    results.push(result);
    process.stdout.write(
      `  ${result.passed ? 'pass' : 'FAIL'}  ${c.id.padEnd(24)} ${String(result.ms).padStart(6)}ms` +
        `${result.passed ? '' : `\n        ${failures.join('\n        ')}`}\n`,
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const pending = results.filter((r) => r.groundedPending).length;
  process.stdout.write(`\n  ${passed}/${results.length} passed`);
  process.stdout.write(pending ? `  (${pending} also assert grounding, not checked until C3)\n\n` : '\n\n');

  const jsonFlag = process.argv.indexOf('--json');
  if (jsonFlag >= 0 && process.argv[jsonFlag + 1]) {
    await writeFile(process.argv[jsonFlag + 1]!, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  }

  ws.close();
  await host.close();
  await daemon.close();
  process.exit(passed === results.length ? 0 : 1);
}

/** Block until the folder is searchable — a run against an empty index measures nothing. */
async function waitForIndex(peer: RpcPeer): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const status = (await peer.request(CHAT_METHODS.indexStatus, undefined).catch(() => undefined)) as
      | { state?: string; files?: number }
      | undefined;
    if (status?.files && status.state !== 'indexing') {
      process.stdout.write(`  index ready: ${status.files} files\n\n`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  process.stdout.write('  index never became ready — running anyway, expect failures\n\n');
}

/** The assistant text of the turn that just finished, from the stored conversation. */
async function lastAnswer(peer: RpcPeer): Promise<string> {
  const convos = (await peer.request(CHAT_METHODS.conversations, undefined)) as Array<{ id: string; active: boolean }>;
  const active = convos.find((c) => c.active);
  if (!active) return '';
  const opened = (await peer.request(CHAT_METHODS.openConversation, { id: active.id })) as {
    messages: Array<{ role: string; content: string; ui?: unknown }>;
  };
  // Prose only: tool chips and thinking blocks are transcript furniture, and
  // matching against them would let a case pass on a search query that merely
  // contained the expected string.
  return opened.messages
    .filter((m) => m.role === 'assistant' && !m.ui && m.content.trim())
    .map((m) => m.content)
    .join('\n');
}

await main();
