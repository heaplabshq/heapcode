# Phase 3 design note — the core-as-server protocol

**Status:** design note for review. No code has been written or changed.
**Depends on:** `docs/phase3-provider-custody-design.md` — custody decided as
**A2** (server holds and uses keys; hosts push key material at session setup;
in-memory only, never persisted), server confirmed **local-only**.
**Decision owner:** Sid.

---

## Correction to this task's framing, up front

The custody note found two things wrong in its own task framing, so in the
same spirit: **one premise in this task's framing is incomplete, and it
changes the protocol's shape more than any other single fact.**

The framing treats the protocol as "host asks the server to run an agent,
server streams events back". That is only half of it. `runAgent` takes
**three host callbacks that are not events** and that it cannot proceed
without:

- `execute(call)` — `packages/core/src/agent/loop.ts:66`
- `requestPermission(call, tool)` — `:68`
- `beforeToolCall(call, tool)` — `:74`

`execute` is the tool executor, and for the extension it is **irreducibly
host-side**: it creates terminals (`packages/vscode/src/agent/workspaceTools.ts:60`),
waits on shell integration (`:68`, `:685-688`), and reads language-server
diagnostics (`:407-408`). None of that exists outside the extension host.
Phase 2 kept the executors per-host for exactly this reason.

So the protocol is **not** request → event-stream. It is **bidirectional
RPC**: the host calls the server to start a run, and the server calls back
into the host — with a response expected — for *every tool call and every
permission prompt* in that run. A 20-tool agent turn is ~40 server→host
round-trips.

This is not a consequence of custody Option A; it would be true under B as
well. But it means the framing's "server-initiated messages, not just
request/response" understates the requirement: the server needs
server-initiated **requests**, not just notifications.

The good news is that this is exactly the Language Server Protocol's shape,
which the roadmap already reaches for as the analogy
(`docs/heaplabs-roadmap.md:124-126`). Everything below leans on that.

Everything else in the framing checks out. Cited line numbers were
re-verified against the current tree; `loop.ts:75` (`events`),
`loop.ts:284-290` (`chatStreamed`'s `onDelta`),
`delegate.ts:58-81` and `controller.ts:399` are all still accurate.

---

## 1. Transport and message shape

### Transport

**Unix domain socket on macOS/Linux; named pipe on Windows.** Both are the
same Node API — `net.createServer()` / `net.connect()` — and Node accepts a
`\\.\pipe\<name>` path on Windows wherever it accepts a socket path, so a
single implementation covers both with a platform-dependent address.

Addresses:

| Platform | Address |
|---|---|
| macOS / Linux | `$HEAPCODE_HOME/daemon-<v>.sock`, default `~/.heapcode/daemon-<v>.sock` (`globalDir()`, `packages/cli/src/paths.ts:31-33`) |
| Windows | `\\.\pipe\heapcode-<v>-<sid-hash>` |

`<v>` is the protocol major version, so an old client and a new server never
meet on the same address. On Windows the pipe name includes a per-user
component because the pipe namespace is machine-global — see §3.

Two judgment calls worth naming:

- **Socket in `~/.heapcode` rather than `$XDG_RUNTIME_DIR`.** `globalDir()`
  is already the one place this product puts per-user state and is already
  `HEAPCODE_HOME`-overridable (`packages/cli/src/paths.ts:32`), which makes
  test isolation work the way the rest of the CLI's tests already rely on.
  `$XDG_RUNTIME_DIR` is more correct on Linux (tmpfs, cleaned on logout) but
  doesn't exist on macOS and would need a fallback anyway. Not a strong
  preference; happy to be overruled.
- **No TCP fallback, at all.** Once a TCP listener exists, someone will
  bind it to `0.0.0.0` and the local-only decision quietly stops holding.
  Leaving it unimplemented is the enforcement mechanism.

### Framing: newline-delimited JSON

**Recommend NDJSON — one JSON object per line — over length-prefixed
JSON-RPC.**

The justification is specific to this codebase rather than general:

1. **This product already ships an NDJSON agent event stream, and it
   already solved the hard part.** `packages/cli/src/headless.ts:79-93`
   defines exactly the event union this protocol needs — `text`,
   `text_delta`, `plan`, `tool_call`, `tool_result`, `result` — emitted one
   JSON object per line (`:176-177`). It even carries the sub-agent nesting
   field (`parent`, `:83`, `:91-92`, populated at `:217`/`:219`) that §2
   otherwise would have had to invent. That schema is tested and shipping.
   Starting from it means the server→host event half of the protocol is
   largely a *relocation*, not a design.
2. **Payloads are text, and one of them is unbounded.** Tool results carry
   file contents and command output; `MAX_OUTPUT_CHARS` is 8,000
   (`packages/core/src/agent/workspaceTools.ts:24`) but `read_file` allows
   50,000 (`:19`). Length-prefixing buys correctness for binary payloads,
   and there are none — with one exception noted below.
3. **Debuggability.** An NDJSON stream can be `tee`'d to a file and read.
   For a local dev tool where the failure mode is "the agent did something
   strange", that is worth more than framing elegance.

The cost, stated honestly: JSON escaping inflates payloads with lots of
newlines and quotes, which is most tool results. Length-prefixing would
avoid re-escaping. I do not think it matters at the volumes involved — a
50KB read is a fraction of a millisecond over a unix socket — but it *is* a
trade, not a free win.

**JSON-RPC 2.0 message semantics over NDJSON framing.** Framing and
semantics are separable, and JSON-RPC's `id`/`method`/`params`/`result`/
`error` plus its notification form gives exactly the three message kinds
needed — and crucially, **it is symmetric**: either side may send a request.
That is what §1's correction requires.

```
→  {"jsonrpc":"2.0","id":1,"method":"agent/run","params":{…}}      host → server, request
←  {"jsonrpc":"2.0","method":"agent/event","params":{…}}            server → host, notification
←  {"jsonrpc":"2.0","id":"s1","method":"tool/execute","params":{…}} server → host, REQUEST
→  {"jsonrpc":"2.0","id":"s1","result":{…}}                         host → server, response
←  {"jsonrpc":"2.0","id":1,"result":{"outcome":"done",…}}           server → host, response
```

Request ids from the two directions must not collide; simplest is that the
server prefixes its own (`"s1"`) or that ids are namespaced by origin. Worth
fixing in the spec rather than leaving to implementation.

**The one binary exception.** Embeddings are `Float32Array`
(`packages/core/src/rag/store.ts:10`, `:49`, `:83`, converted from JSON at
`:151`). Under §4's recommendation, RAG lives server-side and vectors never
cross the boundary — which is the whole reason the custody note preferred
Option A. If that recommendation is rejected and embeddings must cross,
NDJSON is the wrong framing for that one method and it should get a
side-channel rather than bloating the main framing decision.

---

## 2. Session model

### What a session is

A session is **one host's connection**, and it owns:

| State | Notes |
|---|---|
| Pushed key material | `Map<profileName, apiKey>`, in memory only, never written to disk |
| Constructed `Provider` instances | Lazily built via `createProvider` (`packages/core/src/providers/factory.ts:7`), cached per profile |
| Profile configuration | Pushed by the host (see below) |
| The workspace root | One per session |
| In-flight agent runs | The `AbortController` whose `signal` goes to `runAgent` (`packages/core/src/agent/loop.ts:102`) |
| Server-side subsystems | Per §4: the RAG index, the MCP manager, the `PermissionEngine` |

**Lifecycle: created at connect, destroyed at disconnect.** On socket close
the server must synchronously drop the key map, abort in-flight runs, and
dispose MCP connections (`McpManager.dispose`, which closes each client).
No session survives its connection — a reconnecting host pushes keys again.

This is a judgment call and it has a real cost: a VS Code window reloading
its extension host loses the warm RAG index and has to re-establish MCP
subprocess connections, which is the slow part of startup. The alternative
— sessions outliving connections with a resume token — buys warm-start at
the cost of "how long does a key live in memory with nobody attached?",
which is the exact question A2 exists to keep simple. **Recommend
connection-scoped sessions**, and if warm-start turns out to matter,
solve it by keeping the *index* process-global and keyed by workspace root
while keeping *keys* connection-scoped. Those are separable and should stay
separable.

### Profile configuration is pushed, not read

The server must not read either host's config. The CLI's lives in
`~/.heapcode/config.json` (`packages/cli/src/paths.ts:70-72`); the
extension's lives in workspace settings
(`packages/vscode/src/profileManager.ts:104`). These are genuinely
different and neither is authoritative for the other. The host sends
`ProviderProfileConfig` objects (minus secrets) at session setup, and
re-sends on change.

### Invariant: session isolation

**No session may read another session's key, `Provider` instance, or
profile configuration.** Stated as an invariant the implementation must
enforce structurally, not by convention:

- All of the above hang off a per-connection session object. There is no
  process-global key map, and no global "current provider".
- `createProvider` is called with a key drawn from **the requesting
  session's** map only.
- Anything genuinely process-global (a workspace RAG index, if the
  warm-start refinement above is adopted) must hold **no key material and
  no `Provider`**. That is the line: caches keyed by workspace may be
  shared; anything holding a secret may not.

This matters concretely because two VS Code windows on two workspaces, or
VS Code plus a JetBrains client, may legitimately run different profiles
with different keys at the same time — see §3 of the custody note.

### Sub-agent key resolution

Sub-agents can name a different profile than the session's active one — the
CLI resolves it via an injected `resolveProfile(name)`
(`packages/cli/src/agent/delegate.ts:76`, used at `:101-109`), the
extension via `createProvider(named, await this.profiles.getApiKey(named))`
(`packages/vscode/src/agent/controller.ts:426`).

The custody note offered (a) push all candidate keys up front, or (b) ask
the host for a key by profile name mid-run.

**Recommend (b): a `key/request` server→host request, with the answer
cached in the session for its lifetime.**

Three reasons, and the third is the one that decides it:

1. **It adds no new machinery.** §1's correction establishes that the
   protocol already needs server→host *requests* for tool execution and
   permission prompts. A key request is one more method on a channel that
   has to exist regardless. Option (a) would be simpler only if the
   protocol were one-directional, and it isn't.
2. **Least exposure.** Only keys for profiles actually used reach the
   server. Under (a), a user with eight configured profiles pushes eight
   keys to run an agent that uses one.
3. **Sub-agents are not the only case — role profiles are, and they're
   more common.** `RoleResolver.resolveRole`
   (`packages/cli/src/provider/roles.ts:37-41`) and the extension's
   equivalent (`packages/vscode/src/profileManager.ts:148-152`) redirect
   the embeddings / rerank / context models to *other named profiles* with
   their own keys. Since §4 recommends RAG moves server-side, the server
   will need a second profile's key on the ordinary indexing path, with no
   sub-agent anywhere in sight. Option (a) would have to push every
   role-redirect target too — at which point "push all candidate keys" is
   just "push all keys", and the session-setup message becomes a full key
   dump.

Failure mode: the host answers `key/request` with "no such profile" or "no
key stored", and the server falls back to the parent's provider — which is
what both hosts already do today for an unknown profile name
(`packages/cli/src/agent/delegate.ts:107-108`,
`packages/vscode/src/agent/controller.ts:430-431`). Behavior preserved.

### The extension's delegation entanglement — a prerequisite, but not extra work

The custody note's correction 3 stands: the extension's `runSubAgent` is
still a private method on `AgentController`
(`packages/vscode/src/agent/controller.ts:399`) reaching for
`this.profiles` (`:426`), `this.permissions` and `this.shadowGit`
(`:495-506`), and `this.abort?.signal` (`:488`).

**Stating it plainly: yes, this must be untangled before the extension can
be a protocol client — but it is not additional work, because moving to the
server deletes it rather than refactoring it.**

Under this design, recursion happens entirely server-side: a sub-agent is a
nested `runAgent` whose tool calls go back over the *same* `tool/execute`
channel as the parent's, tagged with the parent call id — precisely the
`parent` field `headless.ts:91-92` already defines. The extension's
`runSubAgent` method does not get refactored; it ceases to exist, along
with the CLI's `runSubAgent`
(`packages/cli/src/agent/delegate.ts:94`), both replaced by one server-side
implementation.

What the host retains is the UI half — the CLI's indented sub-tool
rendering (`packages/cli/src/ink/App.tsx:1022-1041`) becomes "render
`tool_call` events that carry a `parent`". That is a rendering change, not
an entanglement.

The one thing that *is* genuine new work: `this.abort` (`:488`) is how the
extension cancels today, and cancellation has to become a protocol message
— see §5.

---

## 3. Authentication

A local key-holding server is a new privilege boundary: any process running
on the machine that can reach the socket can spend the user's API budget
without ever seeing a key.

**Recommend both peer-credential checks and a per-launch token — they
defend against different things.**

### Layer 1 — filesystem permissions and peer credentials

- Socket file created mode `0600` in a `0700` directory. On Linux this
  alone is close to sufficient; on macOS, socket-file permissions are
  honored, but relying on that alone is thin.
- On connect, check the peer's uid via `SO_PEERCRED` (Linux) /
  `LOCAL_PEERCRED` (macOS) and reject anything not matching the server's
  own uid. Node does not expose this natively, so it needs a small native
  addon or a platform-specific syscall — which collides with guardrail #5
  ("no native-module dependencies without a JS fallback",
  `packages/cli/src/config/secrets.ts:5-12`). **The JS fallback is layer 2**,
  which is why both are recommended rather than either alone.
- **Windows has no uid equivalent here and its named-pipe namespace is
  machine-global**, so any user's process can *see* the pipe. On Windows,
  layer 1 is the pipe's security descriptor (owner-only ACL), and layer 2
  carries proportionally more weight.

### Layer 2 — per-launch token

- On start, the server generates a random token (≥32 bytes, `randomUUID`
  is not enough entropy for this — use `randomBytes`) and writes it to
  `$HEAPCODE_HOME/daemon-<v>.token`, mode `0600` — the same posture the CLI
  already uses for its API keys (`packages/cli/src/config/secrets.ts:30-31`,
  which writes mode `0600` and then `chmod`s again).
- The first message on any connection must be `session/hello` carrying the
  token. Compare in constant time.
- The token is per-launch, not persisted across restarts.

This is exactly as strong as the file permissions on the token file, which
is the same assumption the CLI's existing key storage already makes. It
does not defend against a same-uid attacker — but neither does anything
else at this layer, and a same-uid attacker can already read
`~/.heapcode/secrets.json` directly.

### On failed authentication

- **Close the connection immediately**, with a single
  `{"error":{"code":-32001,"message":"unauthorized"}}` before close. Not
  silent: a silent drop is indistinguishable from a crash and will cost
  hours of debugging when the real cause is a stale token file after a
  server restart.
- **Log to the server's own log with a timestamp and the peer uid if
  obtainable. Do not log the presented token.**
- **Do not surface to the user by default.** A failed auth is much more
  likely a stale token than an attack, and a scary modal on every server
  restart trains users to dismiss it. Rate-limit and surface only on
  repeated failures from a *different* uid, which is the case that is
  actually interesting.
- No retry backoff on the server side; the client's reconnect path (§6)
  handles a stale token by re-reading the token file once, then failing
  loudly.

---

## 4. The protocol surface

Mapping the custody note's nine call shapes, re-verified.

### Shapes 1-4 — move fully server-side

| Shape | Today | Protocol |
|---|---|---|
| 1. `runAgent` | `packages/core/src/agent/loop.ts:241`; called at `packages/cli/src/ink/App.tsx:967`, `packages/cli/src/headless.ts:259`, `packages/cli/src/agent/delegate.ts:153`, `packages/vscode/src/agent/controller.ts:211`, `:495` | `agent/run` request → `agent/event` notifications + `tool/execute`, `permission/request`, `snapshot/before` server→host requests → response carrying `AgentOutcome` (`loop.ts:19`) |
| 2. `reviewCurrentPr` | `packages/core/src/review/prReview.ts:401`, opts at `:130` | `review/run` request, same event/callback pattern; `PrReviewHost` (warn/error/progress) becomes notifications, its confirm step becomes a server→host request |
| 3. `contextualizeChunks` | `packages/core/src/rag/contextualize.ts:16` | Not directly exposed — internal to `rag/index` below |
| 4. `rerankHits` | `packages/core/src/rag/rerank.ts:16` | Not directly exposed — internal to `rag/query` below |

`agent/run` params carry what `AgentOptions` needs minus the non-
serialisable parts: `profileName`, `model`, `task`, `history`, `images`,
`workspaceName`, `tools`, `nativeToolCalls`, `contextWindow`, `plan`,
`planOnly`, `resumePlan`, `proposeMemoryNote`,
`requireVerificationBeforeFinish`, `maxIterations`, `temperature`,
`maxTokens` (`loop.ts:48-103`). Dropped: `provider` (server resolves it),
`signal` (§5), and the three callbacks (server→host requests).

`agent/event` reuses the `HeadlessEvent` union
(`packages/cli/src/headless.ts:88-93`) as its starting schema, extended
with the events that union doesn't yet carry but `AgentEvents` defines —
`reasoning_delta`/`reasoning_end` (`loop.ts:32-33`), `tool_stream`
(`:35`), `context_usage` (`:37`), `compaction` (`:39`),
`memory_candidate` (`:45`), and `text_end` (`:30`). That union should move
from `packages/cli` into `packages/core` as part of this work — it is a
protocol type, not a CLI type.

### Shapes 5-9 — recommendations

The custody note left these open. Recommendations, with reasoning per
shape:

| Shape | Recommendation | Reasoning |
|---|---|---|
| 5. `embeddings` / RAG index + query (`packages/cli/src/rag/indexer.ts:198`, `:241`; `packages/vscode/src/rag/indexer.ts:203`, `:238`) | **Server-side** | This is the one that most repays moving. Vectors stay `Float32Array` server-side and never serialise (`packages/core/src/rag/store.ts:151`), which is the concrete benefit the custody note's recommendation rested on. It also makes the index shareable across two windows on one workspace. Indexing is a background batch job with no interactive latency budget. |
| 6. `listModels` (`packages/cli/src/ink/App.tsx:523`, `Setup.tsx:162`; `packages/vscode/src/chatViewProvider.ts:510`, `:570`, `profileManager.ts:172`, `:475`) | **Server-side** | Used to populate model pickers and probe context windows. Human-speed, already awaits a network round-trip. But see the setup caveat below. |
| 7. Ghost text (`packages/vscode/src/completionProvider.ts:104`, `:116`, `:127`) | **Host-side** | On a keystroke deadline. Adding a socket round-trip in *both* directions to a path that is already racing the user's next keypress is a real product risk for no benefit — it has almost no stateful surface to justify centralising. `docs/heaplabs-roadmap.md:112-114` already leans this way. |
| 8. Inline edit (`packages/vscode/src/inlineEdit.ts:129`, `:332`) | **Host-side** | Interactive, single-shot, holds no state worth centralising. Lower latency pressure than ghost text but the same shape, and keeping 7 and 8 together avoids the extension needing both a host-side provider *and* a rule about which features may use it. |
| 8b. Commit messages (`packages/vscode/src/gitCommit.ts:67`) | **Server-side** | One-shot, user-initiated, tolerates a round-trip. No reason to keep it host-side once 7 and 8 have drawn the latency line. |
| 9. `chatStreamed` — the chat view's turn (`packages/vscode/src/chatViewProvider.ts:1252`, `:1261`) | **Server-side** | Same streaming path as the agent loop; §5 covers it. |

**The tradeoff this creates, stated rather than buried: under this
recommendation the extension keeps a host-side `Provider` for ghost text
and inline edit, which means the API key exists in two processes at once —
the extension host and the server.** That is an accepted cost, not an
oversight. It is worth being precise about what it does and does not
change:

- It does **not** weaken the server's posture. The server holds keys either
  way.
- It does mean "hosts never see the key" — Option A's cleanest claim in the
  custody note — is **false as stated** for the extension. The accurate
  claim is "hosts do not need the key for agent, review, RAG, or chat".
- The CLI is unaffected: none of shapes 7-8 exist there
  (`completionProvider` and `inlineEdit` are extension-only), so the CLI
  genuinely can run with no key in its own process.

If that asymmetry is unacceptable, the honest alternative is moving ghost
text server-side and accepting the latency, **not** pretending the two-place
key doesn't happen.

**Setup caveat on `listModels`.** `packages/cli/src/ink/Setup.tsx:161-162`
calls `createProvider` with a key the user has *just typed* and has not yet
saved, to validate it before storing. That is a bootstrap case: there is no
session and no stored key yet. Either the protocol grows a
`provider/probe` method taking a full inline config including the key
(which is a key crossing the boundary before any session exists), or setup
keeps a host-side provider for that one call. **Recommend the latter** — it
is one call, on a path that by definition already has the key in host
memory.

**MCP.** `McpManager` moved to core in Phase 2 and is constructed with an
injected config loader (`packages/cli/src/agentSession.ts:52`,
`packages/vscode/src/extension.ts:77`). Since MCP servers are stdio
subprocesses and their tools are offered to the agent loop, they should be
**server-side**, with MCP configuration pushed at session setup like
profiles. Not free: MCP subprocesses would then be children of the server,
so §6's shared-server decision determines whether two windows share MCP
connections. Flagging rather than deciding — it deserves its own look during
implementation.

---

## 5. Streaming and cancellation

### The path today

`runAgent` prefers `chatStreamed` (`packages/core/src/agent/loop.ts:278-290`),
whose `onDelta` callback (`packages/core/src/providers/types.ts:100-103`)
fires per token and fans out to three different event kinds by `kind`:
`reasoning` → `onReasoningDelta` (`loop.ts:290-292`), `tool` →
`onToolStream` with a cumulative char count (`:294-297`), and text →
`onTextDelta`. The host then renders: the CLI accumulates into `acc` and
calls `setLiveText` (`packages/cli/src/ink/App.tsx:1084-1086`).

### Over the protocol

Deltas become `agent/event` **notifications** — no id, no response, fire and
forget. This is the right shape: a response per token would double the
message count on the hottest path for no benefit, and JSON-RPC
notifications exist precisely for this.

Ordering is guaranteed by the transport: a unix socket is an ordered byte
stream, and NDJSON preserves that, so `text_delta` … `text_end` arrive in
order without sequence numbers. Worth stating explicitly because it is the
reason no sequencing machinery is needed.

Three things that need deliberate attention:

**Backpressure.** A fast local model can emit tokens faster than a host
renders them. `socket.write()` returning `false` must be honored — the
server should pause reading from the provider stream until `drain`. If it
doesn't, a slow host inflates the server's memory with buffered deltas.
This is the one place where "it's just a socket" bites.

**Coalescing.** Per-token notifications on a local socket are cheap but not
free, and the CLI already re-renders on every delta
(`packages/cli/src/ink/App.tsx:1084-1086`) — which is a full Ink repaint.
Recommend the server coalesce text deltas on a short timer (~16ms) into
single notifications, preserving order. This is a judgment call: it trades
a frame of latency for a large reduction in message and repaint count, and
it can be tuned or disabled later. It should be *server-side* so every host
benefits without reimplementing it.

**`tool_stream` is already a counter, not content.** `onToolStream` sends
cumulative chars (`loop.ts:35`, `:294-297`), so it is already cheap and
needs no special handling — worth noting so nobody "optimises" it into
sending fragments.

### Cancellation

Today: an `AbortController` in the host, its `signal` passed into
`runAgent` (`loop.ts:102`), reaching the provider via `ChatRequest.signal`
(`packages/core/src/providers/types.ts:37`). The CLI aborts at
`packages/cli/src/ink/App.tsx:370`/`:375`; the extension uses `this.abort`
(`packages/vscode/src/agent/controller.ts:488`).

Under this design the server holds the real `AbortController`, so
cancellation is **one host→server notification**:

```
→  {"jsonrpc":"2.0","method":"agent/cancel","params":{"runId":1}}
```

The server calls `abort()`; the in-flight `fetch` unwinds; `runAgent`
returns `'stopped'` (`loop.ts:19`) as the response to the original
`agent/run` request. This is exactly the shape the custody note predicted,
and it is the concrete payoff of the server holding the signal.

Three details:

- **`agent/cancel` is a notification, not a request.** The acknowledgement
  the host actually cares about is the `agent/run` response arriving with
  outcome `'stopped'`. A separate ack would be a second thing to get wrong.
- **In-flight `tool/execute` requests must be cancelled too.** If the server
  aborts mid-tool, the host may still be running a 60-second command. The
  server should send `$/cancelRequest` (LSP's convention) for the
  outstanding `tool/execute` id, and the host should thread that into the
  signal it already passes to `executor.execute(call, signal)`
  (`packages/cli/src/ink/App.tsx:1068`). Without this, Stop stops the model
  but not the command — which is the exact class of bug Phase 0's
  `killTree` work just fixed on the local path.
- **Disconnect implies cancel.** Socket close aborts every in-flight run in
  that session (§2).

---

## 6. When the server isn't running

### Starting it

**Recommend: hosts autostart the server, racing on the socket rather than
locking.**

The sequence:
1. Try to connect to the address.
2. On `ENOENT` / `ECONNREFUSED`, spawn the server detached, with stdio
   redirected to a log file in `globalDir()`.
3. Poll-connect with a short backoff up to a few seconds.
4. If still unreachable, fail with a message naming the log path.

Two races have to be handled, and both are handled by the socket rather
than by a lock file:
- **Two hosts start simultaneously.** Both spawn; the second server fails
  to bind (`EADDRINUSE`) and exits quietly. The loser's client connects to
  the winner. No lock file, no cleanup problem.
- **Stale socket file after a crash.** A connect attempt gets `ECONNREFUSED`
  (not `ENOENT`) on a socket file with no listener. The starting server
  must unlink and rebind — but only after a failed *connect*, never
  unconditionally, or two servers will stomp each other.

The alternative — the host requires the user to start a daemon — is worse
for a tool whose CLI is `npx`-installable. Autostart is the judgment call
here; I'd take it.

### Detecting unreachability and reporting it

- **CLI**: connection failure is fatal for agent commands, with the log
  path in the error. `heapcode --version` and config commands should not
  need the server at all.
- **Extension**: surface once in the status bar plus one notification with
  a "Show Log" action; do not retry-loop silently. A dead server with a
  spinner forever is the worst outcome.
- **Version mismatch**: the address embeds the protocol major version, so a
  mismatched client simply finds nothing at its address and starts its own
  server. That is the mechanism, and it is why `<v>` is in the address at
  all.

### One server or many?

**Recommend one server process per user, shared by all hosts and windows —
with per-connection sessions (§2) providing the isolation.**

Reasons:
- The RAG index is the expensive shared thing. Two VS Code windows on the
  same workspace should not each build one. Sharing requires one process.
- MCP subprocesses are per-config; sharing avoids spawning duplicates.
- Session isolation (§2) already makes concurrent hosts safe, so the
  multi-tenancy work is the same either way.

The cost, honestly: one process is a shared failure domain — a crash takes
down every window's agent at once — and it makes the server long-lived,
which means the memory-only key promise has to hold across a longer
lifetime and more sessions. The invariant in §2 is what carries that
weight, which is why it is stated as an invariant rather than a guideline.

**Idle shutdown**: exit after N minutes with no connections, so a
long-lived process isn't holding keys and MCP subprocesses forever after
the user closes their editor. Recommend it; N is tunable.

### The remote-extension-host subtlety

Worth stating because "local-only" is easy to misread: in VS Code
Remote-SSH, WSL, or Dev Containers, the **extension host runs on the remote
machine**, not on the laptop showing the UI. The extension's executor
already assumes this — it spawns child processes
(`packages/vscode/src/agent/workspaceTools.ts:1`) and reads the workspace
through `vscode.workspace.fs`, both of which resolve remotely.

So the rule is: **the server must be colocated with the extension host, not
with the UI.** Autostart via the extension gets this right for free, since
the extension spawns it from where it itself runs. That is also where the
workspace and any localhost Ollama would be — so the model story stays
consistent.

One thing I could not verify from this repo and which needs confirming
before implementation: whether `vscode.SecretStorage`
(`packages/vscode/src/profileManager.ts:82`) resolves against the remote
extension host or is proxied to the local client in these setups. A2 works
either way — the extension host reads the key and pushes it, wherever the
key physically lives — but it is worth knowing rather than assuming.

---

## 7. Migration shape for `cli`

The proof step. Sketch only.

**Today**, `packages/cli/src/ink/App.tsx:967-1103` is one `runAgent({…})`
call whose options object mixes four different kinds of thing:

1. **Model config** — `provider`, `model`, `contextWindow`, `nativeToolCalls`
   (`:968-975`).
2. **Task input** — `task`, `history`, `tools` (`:970-974`).
3. **Host capabilities the loop calls back into** — `execute` (`:977`),
   `requestPermission` (`:1072`), `beforeToolCall` (`:1079`).
4. **UI event handlers** — `events` (`:1082+`).

**Under the protocol**, these split cleanly along the process boundary:

- (1) and (2) become the `agent/run` request payload, with `provider`
  replaced by `profileName`.
- (3) becomes a **server→host request handler** — one dispatcher on the
  client that answers `tool/execute`, `permission/request`, and
  `snapshot/before` by calling exactly the code that is inline in the
  options object today. The bodies barely change: `executor.execute(call,
  abort.signal)` (`:1068`), `permissions.request(...)` (`:1077`),
  `shadowGit.snapshot(...)` (`:1080`).
- (4) becomes an `agent/event` notification handler — a switch over the
  event union that calls the same `pushItem`/`setLiveText` it does now.

What moves server-side and disappears from the CLI: the MCP dispatch branch
(`:1044-1050`), the persona `run_command` guard (`:1051-1065`), and the
whole `delegate_task` branch (`:989-1043`) including `runSubAgent`.

What stays in the CLI: `WorkspaceToolExecutor`, `SessionCheckpoint`,
`ShadowGit`, the Ink UI, and — per §4 — nothing provider-shaped except
`Setup.tsx`'s key-validation probe.

Two things to watch, which the sketch shouldn't hide:

- **`ask_user` inverts.** It is handled inside `execute` today
  (`:978-988`) by setting React state and awaiting a promise the UI
  resolves. Over the protocol it becomes a `tool/execute` request the host
  answers slowly — possibly minutes later, while the user reads. The
  request must have **no timeout**, which means `tool/execute` cannot have
  a blanket timeout, which means a wedged host is indistinguishable from a
  thinking user. That needs an explicit design answer (a heartbeat, or
  `ask_user` promoted to its own method with different semantics). I lean
  toward the latter.
- **`headless.ts` is the better first client, not `App.tsx`.** Its
  `runAgent` call (`packages/cli/src/headless.ts:259`) has no React state,
  and it already serialises exactly this event stream to NDJSON
  (`:176-177`). Porting it first proves the protocol end-to-end against
  something whose correct output is already defined and tested, before any
  UI is involved.

---

## Open questions

1. **NDJSON vs length-prefixed framing** — §1 recommends NDJSON on
   debuggability and existing-precedent grounds. Reversible early, painful
   later.
2. **`ask_user`'s unbounded wait** — §7. Needs an answer before
   `tool/execute` semantics are fixed.
3. **Shared server vs per-window** — §6 recommends shared. The counter-case
   is blast radius.
4. **MCP server-side** — §4 flags it; the interaction with a shared server
   process needs its own look.
5. **`SecretStorage` under VS Code Remote** — §6. Doesn't change A2, but
   should be known rather than assumed.
6. **Whether the two-place key for ghost text is acceptable** — §4. If not,
   the honest fix is moving ghost text server-side and paying the latency,
   not restating the claim.
