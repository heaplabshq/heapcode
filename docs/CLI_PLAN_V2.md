# Heap Code CLI — Build Plan v2

Supersedes `docs/CLI_PLAN.md` (kept unchanged as the historical record of the original plan and its decisions log — read it first for the architecture rationale, Ink decision, and CLI-M0/M1 implementation notes). This document is the **current** source of truth for what's done, what's left, and *how* to build what's left. Same rules as v1: update checkboxes as work lands, never start a milestone before the previous one's exit criteria are met.

## Status at a glance (2026-07-24)

| Milestone | Status |
|---|---|
| CLI-M0 — Walking skeleton | ✅ shipped |
| CLI-M1 — Agent mode: tools, permissions, checkpoints | ✅ shipped |
| CLI-M1.5 — Terminal product experience *(added in v2 — was not in v1)* | ✅ shipped |
| CLI-M2 — Personas, memory, Skills, commands & mentions | ✅ shipped |
| CLI-M3 — RAG + MCP | ✅ shipped |
| CLI-M4 — Parity, sub-agents & real headless mode | ⬜ next |
| CLI-M5 — Distribution | ⬜ |

Live verification note: v1 flagged CLI-M0/M1 as "code-complete, not yet verified against a real model." That verification has now started — real sessions against a LAN Ollama endpoint surfaced two real bugs (both fixed, see CLI-M1.5): the Ctrl+C terminal-state corruption and the agent answering its own question instead of waiting for the user. Keep running the manual smoke matrix each milestone; live usage finds what `ink-testing-library` can't.

## Guardrails (v1's eight, plus what live usage taught us)

Guardrails 1–8 from `docs/CLI_PLAN.md` carry over verbatim (one milestone at a time; exit criteria = done; `core` never imports `vscode` or CLI-specific code; every feature works on local Ollama; no native deps without JS fallback; tests land with the milestone; scope changes → docs first; headless is not a bolt-on). New, learned the hard way:

9. **Every feature is reachable in-session.** If a capability exists, it has a slash command, appears in the `/` autocomplete menu, in `/help`, and in `--help`. Telling the user to quit and run a subcommand (`heapcode profile add`) is a product bug — subcommands exist for scripting, not as the primary UX.
10. **The key protocol is sacred.** Esc interrupts the running agent; Ctrl+C clears typed input; Ctrl+C twice (2s window) exits; Esc/Ctrl+C cancel any open picker or wizard overlay. Never re-enable Ink's `exitOnCtrlC`; never add a feature that hijacks these keys. Any new overlay (picker, wizard, prompt) must wire into the existing `useInput` chain in `ink/App.tsx`.
11. **The interactive loop must never run away.** The agent asking the user a question is a turn boundary — enforced both prompt-side (`core/src/agent/prompts.ts`: "ask ONE clear question then STOP") and loop-side (`core/src/agent/loop.ts` `asksTheUser()`: a tool-free reply ending in a question finishes the turn instead of being continue-nudged). Conversational messages ("hi") never trigger workspace exploration. Any prompt or nudge change must keep the regression tests in `core/test/agent.test.ts` green.
12. **Test isolation via `HEAPCODE_HOME`.** Any test or script that touches config/secrets sets `HEAPCODE_HOME` to a temp dir, in the same shell invocation as the command — otherwise it reads/writes the real `~/.heapcode`.

## Implementation patterns to follow (learned in M0–M1.5 — reuse, don't rediscover)

- **`<Static>` never shrinks.** To reset the transcript (`/new`, `/clear`, `/resume`), remount `<Static>` with a fresh React `key` (`staticKey` state in `App.tsx`) and, on a TTY, clear screen + scrollback with `\x1b[2J\x1b[3J\x1b[H`. Replacing the items array with a shorter one silently breaks Static's internal append index.
- **One store instance, threaded through.** `ConfigStore` caches its file per instance; two instances silently diverge (bit us when the in-session Setup wizard created its own store — freshly added profiles were invisible to `/profile list`). Same lesson as v1's canonicalized-root threading: construct once in `cli.tsx`, pass down as props.
- **Refs beside state for raw-stdin handlers.** `useInput` fires outside React batching; anything read at submit/keypress time lives in a `useRef` mirrored to state (see `Composer.tsx`'s buffer+cursor and v1's decisions-log entry).
- **Session state is mutable state, not props.** `/model` and `/profile` switch provider/model mid-session — `App.tsx` holds `{provider, profile, contextWindow}` in state seeded from props, and `cli.tsx` supplies a `switchProvider` callback for re-resolution. New features that depend on the provider must read the state, not the props.
- **Overlays follow the picker pattern.** One `picker` state (`{title, items, onPick}`) renders a bordered `SelectInput` with Esc-cancel; the Setup wizard renders the same way via `setupActive`. New interactive flows should reuse these, not invent parallel mechanisms.
- **Every command lands in four places:** `COMMANDS` array in `App.tsx` (menu + `/help`), the `handleCommand` switch, `printHelp()` in `cli.tsx`, and a test in `app.test.tsx`.

---

## CLI-M1.5 — Terminal product experience ✅ (added in v2; shipped 2026-07-24)

Not in the v1 plan — added after live usage showed the M0/M1 skeleton UI wasn't a usable product ("make the interface of the CLI first before making more features"). Recorded so the plan reflects reality.

- [x] Ctrl+C fix: Ink's default `exitOnCtrlC` disabled; full key protocol (guardrail 10) owned by `App.tsx`; clean process teardown via `waitUntilExit()` + explicit `process.exit`
- [x] Composer rewrite: visible cursor, arrow-key movement, readline chords (Ctrl+A/E/U/K/W), per-session input history (Up/Down), slash-command autocomplete menu (filter as you type, Tab completes, Enter runs)
- [x] Slash-command foundation: `/help /model /profile /settings /clear /new /resume /rewind /revert /checkpoints /exit` — all in the menu, `/help`, and `--help`
- [x] In-session config: `/model` (picker fed by `listModels()`, or direct id; persists to profile), `/profile` (switch picker with "+ Add new", `add` = Setup wizard as an overlay, `list`, `remove` incl. API-key cleanup)
- [x] Conversation management: `/clear`//`/new` (fresh conversation, screen reset), `/resume` (picker over saved conversations), titles auto-derived from the first user message
- [x] Launch experience: banner (version, model, profile, endpoint, cwd), getting-started tips on empty conversations, "↩ continuing last conversation (N messages)" line otherwise; first-run welcome + step indicators (Step n/4) in the setup wizard; status footer with contextual hints
- [x] Agent behavior fixes in `core` (benefit the extension too): conversational messages answered directly (no exploration on "hi"); a question to the user ends the turn (`asksTheUser()` beats `looksUnfinished()` and the finish-reminder); prompt rule "never answer your own question"
- [x] Launch default: fresh conversation (matching Claude Code); continuing is explicit — `--continue`/`-c` on launch, `/resume` in-session; fresh-start banner hints at `/resume` when earlier conversations exist
- [x] Real multi-turn context: `runAgent` gained a `history` option (`core/src/agent/loop.ts`) and the CLI threads the last 12 trimmed turns into every run — before this, "continuing a conversation" was purely cosmetic (each agent run saw only the current message, so follow-ups like "ok what shall we do" arrived context-free)
- [x] `.heapcode/` gitignored; tests: 301 across the repo, 24 in `app.test.tsx` covering menu, commands, pickers, wizard overlay, tips/continuation, history threading

**Exit criteria (met):** a fresh user with no config runs `heapcode` and reaches a working chat purely through the in-CLI wizard; every capability is discoverable via `/`; Ctrl+C never corrupts the terminal; "hi" gets a one-line reply with zero tool calls; a model that asks "would you like 1/2/3" stops and waits.

---

## CLI-M2 — Personas, Memory, Skills, Commands & Mentions ✅ (shipped 2026-07-24)

Goal unchanged from v1: the CLI feels like the same product as the extension. All items were ports of already-tested, already-`vscode`-free logic.

**Scope (v1 items, carried):**
- [x] Personas: `packages/vscode/src/agent/personas.ts` ported verbatim to `packages/cli/src/agent/personas.ts` (verified zero `vscode` imports). `/persona [name]` command + picker over Agent/Architect/Debug/Reviewer, footer + `/settings` show the active persona, `filterToolsForPersona` scopes the offered tools, and the `looksFilesystemMutating` guard blocks `run_command` escapes for write-restricted personas (same guard as the extension's controller). Architect-can't-write verified in `app.test.tsx` (write_file's definition absent from the offered set) and `personas.test.ts`
- [x] Project memory: `packages/cli/src/memory.ts` — Node port of the extension's `loadProjectInstructions` (`.heapcode/HEAPCODE.md` with root fallback, `AGENTS.md` only when no HEAPCODE.md, `.heapcode/memory.md`, path-scoped `.heapcode/instructions/*.md` via `applyTo` globs) + `appendMemoryNote`. Injected into every agent task via the same preamble shape as the extension (`persona.taskAddendum` + instructions + `Task:`); `/memory` shows what's loaded. Injection verified by asserting on the provider's recorded request
- [x] Skills: `/skills` lists project + personal skills (`listSkillsFormatted`); `list_skills`/`load_skill` tools already landed in CLI-M1
- [x] Prompt slash commands: `/explain /fix /refactor /review /security-review /test /docs /optimize` via core's `builtinPrompts`/`parseSlashCommand`/`renderTemplate` — in the autocomplete menu with titles, rendered into the task while the transcript shows what the user typed; bare command → usage message, not an empty-template run
- [x] `@file` / `@folder` mentions: `@`-triggered path autocomplete in `Composer.tsx` (same filtered-menu mechanics as the slash menu; Tab/Enter inserts, folders end with `/`), candidates lazy-loaded on first `@` via an ignore-aware fast-glob in `cli.tsx` (`.gitignore` + `.heapcodeignore`, capped at 2000 entries); a task-preamble note tells the model `@`-paths are workspace references. `@workspace` still deferred to CLI-M3 (needs RAG)
- [x] Sub-agent groundwork: `intersectPersonas` ported + tested (parent restrictions always win)

**Exit criteria: met.** Persona honored and verified (Architect's offered tool set contains no write tools; fs-mutating commands blocked for write-restricted personas); HEAPCODE.md/memory.md content demonstrably reaches the agent task without the user repeating it (asserted on the provider's recorded request); `/security-review` and 7 other prompt commands work with autocomplete; Skills discoverable via `/skills` and loadable via the CLI-M1 tool pair; everything is in the `/` menu, `/help`, and `--help`. Tests: 317 across the repo (97 in `packages/cli` — new `memory.test.ts`, `personas.test.ts`, and 27 in `app.test.tsx`). One learned detail worth keeping: the agent system prompt's fixed prose mentions `write_file` by name, so "tool absent" assertions must match the `### write_file` definition block, not the bare string.

## CLI-M3 — RAG + MCP ✅ (shipped 2026-07-24)

Scope from v1, with one resolved decision: the `chokidar`-or-`fs.watch` question was decided as **neither** — see the decisions log. Everything else shipped as planned.

- [x] RAG indexer (`rag/indexer.ts`): fs/promises + fast-glob port of `packages/vscode/src/rag/indexer.ts`. Same algorithm (chunk → embed → VectorStore, hybrid BM25+vector search, LLM rerank), unchanged core logic. Role resolution (`embeddingsModel`/`rerankModel`/`contextModel`, each with an optional `<role>Profile` redirect to a different configured profile) ported to `provider/roles.ts`'s `RoleResolver` — the extension's `ProfileManager.resolveRoleProfile`/`resolveRole`, rebuilt on `ConfigStore`/`SecretsStore` instead of `vscode.workspace.getConfiguration`
- [x] `RepoMapIndexer` (`rag/repoMapIndexer.ts`): same fs/promises + fast-glob port. The extension's "open editor tabs" ranking boost has no CLI equivalent (no editor) and is simply omitted; its "recently saved" boost is driven by the agent's own successful writes instead of `onDidSaveTextDocument` (`noteRecent()`, called from `App.tsx`'s post-write sync hook)
- [x] **No filesystem watcher** — decided against both chokidar and `fs.watch` (see decisions log). `write_file`/`edit_file`/`multi_edit`/`rename_file`/`delete_file` tool calls sync both indexes directly right after they succeed (`App.tsx`'s `syncIndexesAfterTool`); `/index` is the manual catch-all for changes made outside the session
- [x] `semantic_search`/`repo_map` agent tools: CLI-M1 had already declared these with `semanticSearch`/`repoMap` callback injection points on `WorkspaceToolExecutor` — CLI-M3 just had to wire real callbacks in `cli.tsx`. Falls back to plain text search automatically when no embeddings model is configured (`semanticSearch` returns `''`, and `workspaceTools.ts`'s existing fallback takes over) — no new fallback logic needed
- [x] `@workspace` mention: pulls `ragIndexer.queryFormatted()` into the task preamble when ready; falls back to `repoMapIndexer.format()` (structural outline) when no embeddings model is configured, so the mention still does *something* useful either way
- [x] `/search <query>`: semantic when the index is ready, otherwise a plain regex text search via the existing `search` tool (words extracted from the query, regex-escaped) — output is a system transcript item (file:line list), never sent to the model
- [x] `/index`: manual rebuild of both indexes, reports status
- [x] Index status: `/settings` shows state/file/chunk counts and flags a missing `embeddingsModel`; a live rebuild shows `indexing… n/m files` in the status footer (never the transcript, per the original plan's guidance)
- [x] `.heapcodeignore` + real `.gitignore`-awareness: already existed from CLI-M1 (`agent/ignoreFiles.ts`), reused as-is by both indexers
- [x] MCP client (`agent/mcp.ts`): port of `packages/vscode/src/agent/mcp.ts` — its only `vscode` surface was the `Disposable` interface and an `OutputChannel` logger, swapped for a plain `dispose()` method and an optional callback. Config source: `agent/mcpConfig.ts`'s `loadMcpServers()` merges `mcpServers` from the global `~/.heapcode/config.json` with project-scoped `<cwd>/.heapcode/mcp.json` — a name in both takes the project-scoped definition (same "closest specificity wins" rule as scoped instructions). Reconnects (idempotent) at the start of every task rather than once at launch, matching the extension controller's own pattern — config edits and dropped servers take effect on the next message, no restart
- [x] MCP tools go through the exact same permission system and tool-chip UI as workspace tools — no separate rendering path. They're merged into the offered tool list per-task (`[...tools, ...mcpTools]`) and intercepted in `execute()` before falling through to the workspace executor; `permission: 'execute'` + `untrustedOutput: true` on each generated `ToolDefinition` (unchanged from the extension) is what puts them through the normal prompt
- [x] `/mcp`: lists connected servers and total tool count

**Exit criteria: met, with one item flagged the same way CLI-M0/M1 flagged their own live-model gaps.** "Where is authentication handled?" returns correct file+line hits — verified in `ragIndexer.test.ts` against a real (mock-server-backed) embeddings round trip. Editing a file re-indexes only that file — verified for both indexes (`indexOne`/`removeFile`/`renameFile` tests, plus an `app.test.tsx` test proving a real `write_file` tool call triggers exactly that). A filesystem MCP server's tools show up and go through a permission prompt — verified against a **real stdio child-process MCP server** (`test/fixtures/mcpFixtureServer.mjs`), not a mock: connects, lists tools, calls a tool, drops a removed server, logs (not throws) on a failed connection. **Still open, not yet verified:** the sub-60-second full-index budget on an actually-large real-world repo — the test suite proves correctness on small fixtures, not that budget, the same posture CLI-M0/M1 took on "code-complete vs. verified against a real model."

Tests: 352 across the repo (+35 for CLI-M3 — `ragIndexer.test.ts` (8), `repoMapIndexer.test.ts` (8), `mcp.test.ts` (6, real stdio server), `mcpConfig.test.ts` (5), plus 7 new `app.test.tsx` cases). `packages/vscode` untouched by this milestone (`git diff --stat -- packages/vscode` is empty) — every change is additive in `packages/cli` plus the `@modelcontextprotocol/sdk` dependency.

## CLI-M4 — Parity, Sub-Agents & Real Headless Mode ⬜

Scope unchanged from v1 (`delegate_task`, full headless agent loop with `--permission-mode` + NDJSON events, audit log + `heapcode audit`, checkpoint UX polish). Additional guidance:
- Headless permission modes are a closed enum (`plan|auto-edit|full-auto|default`) — resist a permissions DSL.
- The NDJSON event shape should mirror `AgentEvents` 1:1 (`tool_call`, `tool_result`, `text_delta`, `result`) so the interactive and headless paths stay one runner (guardrail 8).
- Sub-agent activity renders as an indented tool-chip group in the transcript; headless emits it as nested events with a `parent` field.
- Exit criteria unchanged from v1.

## CLI-M5 — Distribution ⬜

Scope unchanged from v1 (name/bin availability check first, production bundle, publish under the license decision, README, opt-out update check, tag-triggered CI). Additional guidance:
- The first-run experience shipped in CLI-M1.5 *is* the onboarding the README documents — screenshot it, don't invent a parallel quick-start.
- Update-check result renders as one dim line under the banner, never a blocking prompt.
- Exit criteria unchanged from v1.

---

## Backlog

Carried from v1 unchanged (LSP diagnostics, `node-pty` streaming, short bin alias, vision input, PR/CI review, single-binary packaging, JetBrains). Additions:
- **Multi-line composer input** (Shift+Enter or paste with newlines) — the Composer is deliberately single-line through CLI-M2; revisit when prompt commands make long input common.
- **Input history across sessions** (persist composer history to `.heapcode/`) — in-session history shipped in CLI-M1.5.
- **Themed/branded ASCII wordmark on first run** — current banner is deliberately modest; polish once, in CLI-M5, alongside the README screenshots.

## Decisions log (v2 additions — v1's log remains in `docs/CLI_PLAN.md`)

| Date | Decision | Why |
|------|----------|-----|
| 2026-07-24 | Ink's `exitOnCtrlC` disabled; the app owns the full Esc/Ctrl+C protocol (guardrail 10) | Ink's built-in handler unmounted the UI on the first Ctrl+C even mid-agent-run — the agent kept running with no UI, terminal left in a broken half-rendered state (reported live). One owner for the protocol, zero double-handling |
| 2026-07-24 | Interface-first milestone (CLI-M1.5) inserted before CLI-M2, out of the original plan's order | Direct user feedback after M0/M1: the feature skeleton without product-grade interaction reads as broken, not as progress. The benchmark is Claude Code/Copilot CLI/Codex CLI |
| 2026-07-24 | Agent turn-boundary enforcement lives in **both** the prompt and the loop (`asksTheUser()` in `core/src/agent/loop.ts`) | Observed live with a local model: prompt-only guidance lost to the continue-nudge — the model asked "Would you like to: 1/2/3" then picked an option itself. The loop heuristic makes the boundary structural; small local models don't reliably follow prompt rules alone |
| 2026-07-24 | Profile management is in-session first (`/profile add` mounts the Setup wizard as an overlay); `heapcode profile …` subcommands remain for scripting | Sending an interactive user out of the session to a shell subcommand breaks the product experience (guardrail 9's origin) |
| 2026-07-24 | Transcript resets remount `<Static>` via a React `key` + explicit ANSI clear on TTY | Ink's `Static` only appends; shrinking its items array desyncs its internal index. Remount is the supported reset |
| 2026-07-24 | Conversation titles derived from the first user message at persist time | `/resume` is useless when every entry is called "New conversation" |
| 2026-07-24 | CLI-M3's file-watcher question (chokidar vs. `fs.watch`) resolved as **neither** — indexes are synced directly from the agent's own tool calls instead | The CLI has no persistent "open editor" the way the extension does (`onDidSaveTextDocument`); the only mutations that matter in practice are the agent's own `write_file`/`edit_file`/`rename_file`/`delete_file` calls, which the host already observes synchronously with the exact path involved — watching the filesystem for changes it already knows about firsthand would just add debounce latency and duplicate-event risk for no benefit. `/index` remains the manual catch-all for changes made outside the session (another editor, git checkout) |
| 2026-07-24 | Role resolution (embeddings/rerank/context models, each optionally redirected to a different configured profile) ported to a small new `RoleResolver` class rather than folding it into `ConfigStore` | `ConfigStore` is a plain file-backed store (load/save/list); role resolution is domain logic with its own fallback chain (`<role>Profile` redirect → active profile) that the extension already isolated in `ProfileManager` for the same reason — keeping it a separate class matches that precedent and keeps `ConfigStore` simple |
| 2026-07-24 | MCP servers are reconnected (idempotently) at the start of every task, not once at CLI launch | Matches the extension controller's own pattern exactly (`await this.mcp?.ensureConnected()` inside every task call, not in the constructor) — config edits and dropped servers take effect on the very next message with no restart required, and connecting is cheap when nothing changed (config unchanged → no new connections attempted) |
| 2026-07-24 | MCP client tests spawn a real fixture MCP server as a child process over stdio (`test/fixtures/mcpFixtureServer.mjs`), rather than mocking the SDK's `Client` | `packages/vscode/src/agent/mcp.ts` has zero existing tests — vscode's config surface made it hard to test before. A real two-process stdio round trip (connect, list tools, call a tool, observe a dropped/failed server) is only slightly more setup than mocking and actually proves the transport works, not just that the code calls the SDK correctly |
| 2026-07-24 | Launch starts a fresh conversation; continuing is explicit (`--continue`/`-c`, `/resume`) — reversing CLI-M0's continue-by-default | Auto-replaying a long stored transcript on every launch is confusing (a replayed pre-fix session read as "the bug is still there") and non-standard; every reference CLI starts fresh and makes continuation opt-in |
| 2026-07-24 | Multi-turn context threaded into the agent loop via a new `runAgent({ history })` option, capped host-side (last 12 turns, 4k chars each) | Each agent run previously received only the current message — conversation "continuity" existed in the UI and on disk but never reached the model, so follow-up messages were interpreted as context-free new tasks (a real cause of the "ok what shall we do" → explore-everything behavior, alongside the nudge bug). Host-side capping keeps the core option simple; compaction already guards long transcripts |
