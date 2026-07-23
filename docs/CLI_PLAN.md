# Heap Code CLI — Build Plan

Source of truth for **what we build, in what order, and when it's done**, for `packages/cli` — the standalone terminal adapter over the existing agent engine. Sibling to `docs/PLAN.md` (the VS Code extension's build plan, M0–M13 shipped as v0.4.0), which parked this work under "Track X — Distribution" until the extension's current release was out. It's out. This is that work.

Spec framing lives in `docs/PRD.md` (model-agnostic, local-first, privacy-first — the CLI honors the same promises, not a lesser version of them). Update checkboxes as work lands; never start a milestone before the previous one's exit criteria are met.

## Guardrails (how we stay on track)

1. **One milestone at a time.** New ideas go to the Backlog section, not into the current milestone.
2. **Exit criteria are the definition of done** — demoable behavior, not "code exists".
3. **`packages/core` never imports `vscode` — and never imports anything CLI-specific either.** The lint rule already enforced for guardrail 3 in `docs/PLAN.md` stays exactly as-is; `packages/cli` is a second thin adapter next to `packages/vscode`, not a reason to loosen `core`'s IDE-agnostic boundary. Anything the CLI needs that isn't already in `core` gets built in `packages/cli`.
4. **Every feature works with a local model (Ollama)** before we call it done. Local-first is the product promise — doubly so for a CLI, which is where headless/CI/server use actually lives.
5. **No native-module dependencies without a JS fallback.** The CLI must never fail to start. This also rules out an OS-keychain binding for secrets by default (see decisions log) — a CLI that only works when a keychain is available (and unlocked, and the right one on Linux) fails guardrail 5 the same way a native vector-search binary would.
6. **Tests land with the milestone**, not "later". Mock provider fixtures for anything touching an LLM (reuse `packages/core/test/mockServer.ts` — no CLI-specific duplicate).
7. Scope changes → edit `docs/PRD.md` + this file first, then code.
8. **Headless mode is not a v2 feature bolted onto the interactive UI later.** The interactive Ink UI and the `-p`/`--json` headless path both call the same runner underneath from CLI-M0 onward, so headless is exercised (and tested) continuously instead of retrofitted once and hoping it still works.

---

## Architecture decision: Ink, not a custom terminal renderer

**Decision: Ink (React for CLIs).** This is what Claude Code's own CLI, Gemini CLI, and other current-generation agentic coding CLIs use, and it's the right call independent of imitation: the team already has React fluency (`packages/webview-ui`), and the actual hard parts of a chat-agent TUI — a scrolling transcript that re-renders as streamed tokens arrive, a live tree of tool-call status chips, conditional panels (permission prompts, plan-approval banners) — are exactly the problems React's component model already solves for the webview. Rebuilding that state management on top of raw ANSI cursor control (the `blessed`/hand-rolled alternative) would be reinventing a worse version of what `packages/webview-ui` already proves out.

**What ports directly vs. what's new:**

| Concern | Webview (`packages/webview-ui`) | CLI (`packages/cli`) |
|---|---|---|
| Component model | React + DOM | React + Ink (`Box`/`Text`/`Static`) |
| Markdown parsing | `marked` + `marked-highlight` | `marked` — same parser, same AST |
| Syntax highlighting | `highlight.js` (via `marked-highlight`) | `cli-highlight` — also built on `highlight.js`, same grammar set |
| Markdown→terminal rendering | n/a (browser renders the HTML) | `marked-terminal` (a `marked` renderer emitting ANSI), code blocks handed to `cli-highlight` |
| Streaming transcript | React state, DOM diffing | Ink's `<Static>` for finalized turns (never re-rendered — keeps scrollback cheap and correct) + a live `<Text>` for the in-flight streaming turn |
| Multi-line input + slash autocomplete | plain `<textarea>`-derived composer | custom component on Ink's `useInput` raw-mode hook — `ink-text-input` is single-line only, doesn't fit; needs its own small text-buffer component (cursor position, multi-line, autocomplete popover) |
| Permission prompt (Allow Once / Session / Always / Deny) | modal webview component | `ink-select-input` list, same four options, same semantics as the extension's `PermissionEngine` |
| Tool-call status chips | React list with ✓/✗ | `<Static>`-appended rows, live spinner (`ink-spinner`) while a call is in flight |
| Spinner / status line | CSS | `ink-spinner` + a `<Box>` status line (model, profile, token count) |

**Headless mode is architecturally separate from Ink, not a flag on top of it.** `heapcode -p "task" --json` never mounts an Ink tree — it calls the same underlying runner (`runAgent`/a thin CLI-side `session.ts`) and streams plain text or newline-delimited JSON straight to `stdout`. Ink assumes a reasonably real terminal (raw mode, a stable width, interactive `stdin`); none of that holds in CI, in a pipe (`heapcode -p "..." | jq`), or writing to a redirected file. Two thin front ends over one shared core session loop is simpler and more robust than one front end trying to serve two audiences — and standing the split up from CLI-M0 is what keeps headless mode from silently rotting while the interactive UI gets all the attention through CLI-M1–M3.

**Non-decision, deliberately deferred:** a live-streaming pty (`node-pty`) for `run_command` so the user can *watch* a long-running command execute in real time. Genuine UX upgrade over plain `child_process.spawn`, but `node-pty` is a native module with prebuilt-binary-per-platform packaging risk — guardrail 5 says that needs a JS fallback before it ships, and the plain-spawn path is that fallback already, so it's the CLI-M1 default and `node-pty` streaming is Backlog.

---

## Package & bin name — open decision

Package: **`@heapcode/cli`** — matches `@heapcode/core`/`@heapcode/webview-ui`, not actually in question.

Bin command: **genuinely open, flagged rather than picked silently.**

- `heapcode` — unambiguous, matches the product name and the extension's own command-palette prefix (`Heap Code: …`), zero collision risk. Costs more keystrokes on every invocation of a tool used dozens of times a session.
- `hc` — fast to type, but a real collision-risk name (contested two-letter `$PATH` namespace, e.g. HashiCorp Consul-family tooling on some machines). Needs a pre-launch check it doesn't silently shadow something already on a typical dev machine's `PATH`.

Ship `heapcode` as the only bin through CLI-M0–CLI-M4; decide on a short alias as a deliberate, separately-verified choice in CLI-M5 once real usage has an opinion, rather than baking a possibly-colliding short name in from the start.

---

## Milestones

### CLI-M0 — Walking Skeleton ✅ (code-complete; live Ollama/cloud-provider verification still open)

Goal: prove the entire pipe — bin entry → provider → streaming response → terminal UI — for chat only, no tools yet, matching what `docs/PLAN.md`'s own M0 proved for the extension.

- [x] `packages/cli` scaffold: `package.json` (`@heapcode/cli`, `bin: { heapcode: "./dist/cli.js" }`), TypeScript strict (extends `tsconfig.base.json`, `types: ["node"]`, no `vscode` types), depends on `@heapcode/core` via `workspace:*`
- [x] esbuild bundle to a single Node-targeted, ESM `dist/cli.js` with a `#!/usr/bin/env node` shebang (ESM to match `core`'s `"type": "module"`/`moduleResolution: bundler`, unlike the extension's CJS bundle which is CJS only because VS Code's extension host requires it). Needed two extra esbuild workarounds beyond the extension's own `esbuild.mjs`: a `createRequire` banner (bundled CJS deps calling `require('assert')`-style on Node builtins hit esbuild's throwing `__require` shim under ESM output otherwise) and an `alias` for `react-devtools-core` (Ink's optional DEV-mode hook; esbuild hoists the import to top-level regardless of the runtime env-var guard around it, so `external` alone still leaves an unresolvable import in the shipped bundle) — see `esbuild.mjs` comments and `react-devtools-core-stub.js`
- [x] Ink app shell: `<App>` renders a scrolling transcript (`<Static>` for finished turns) + composer; Ctrl+C wired to `useApp().exit()`
- [x] Config store: `~/.heapcode/config.json` (profiles, active profile, settings) — reuses `ProviderProfileConfig`/`createProvider`/provider presets from `core` completely unchanged; `heapcode profile add/list/use/remove` subcommands (an interactive wizard using a single shared `readline.Interface` for the whole flow — see decisions log on why one-per-question doesn't work)
- [x] Secrets store: `~/.heapcode/secrets.json`, `chmod 600`, keyed by profile name — same shape as the extension's `SecretStorage` keys (`heapcode.apiKey.${profileName}`) conceptually, plain-file per guardrail 5
- [x] Chat loop (`session.ts`'s `sendMessage`, shared by both Ink and headless), streaming, markdown + syntax-highlighted rendering (`marked` + `marked-terminal`), Ctrl+C wired to exit. Verified end-to-end against a scripted OpenAI-compatible mock server (streamed SSE, `listModels`, full `profile add` → chat → history round trip); **not yet verified against a real Ollama or cloud endpoint** — no local Ollama install or cloud API key was available in the environment this milestone was built in. Flagging explicitly rather than assuming, same posture `docs/PLAN.md` uses for its own "needs live testing" notes
- [x] History persistence: `<cwd>/.heapcode/conversations.json` via a Node-native port of `core`'s `ConversationStore` interface (`fs/promises` instead of `vscode.workspace.fs` — no interface change needed); verified continuing the same conversation across separate process invocations
- [x] Minimal headless path: `heapcode -p "message" [--json]` — no Ink mount, request/response against the active profile, plain text or `{ "response", "model", "profile" }` JSON to stdout, non-zero exit + structured error on failure. Chat-only in CLI-M0 (no tools yet — CLI-M1); exists now specifically to force the runner/UI split from day one, not to be feature-complete yet
- [x] CI: `pnpm lint`/`typecheck`/`test`/`build` at the repo root already cover `packages/cli` with zero workflow changes (existing `no-vscode-import-in-core` rule unaffected — `packages/cli` is outside its `files` glob); `npm pack --dry-run` verified the tarball contents (a `files: ["dist"]` restriction is in place so a real publish won't ship `src`/`test`)
- [x] Unit tests (12 in `config.test.ts`/`history.test.ts`/`headless.test.ts`, 3 more in `app.test.tsx` for the Ink UI itself via `ink-testing-library`) — config store read/write/chmod, history store CRUD, headless runner against the mock provider server, composer input + streaming transcript + history save via a real (mocked-stdio) Ink render. `vitest.config.ts`'s include glob widened from `*.test.ts` to `*.test.{ts,tsx}` for the last of these — the one real config change needed, since Ink components require `.tsx`

**Exit criteria:** met against a mock provider (locally linked `heapcode` → `heapcode profile add` walks through picking a provider → send a message → streamed, syntax-highlighted markdown reply in the terminal; `heapcode -p "hi" --json` returns valid JSON with no TTY attached, verified piped through a driver script, not just run interactively; history survives process restart and continues the same conversation across invocations). **Still open:** the same walkthrough against a real Ollama install and a real cloud profile (OpenRouter/Groq) — do this before calling CLI-M0 fully done, not just code-complete.

### CLI-M1 — Agent Mode: Tools, Permissions, Checkpoints

Goal: autonomous task completion in a real terminal, with the same airtight permissions the extension's M4/M7/M8 already proved out — ported, not redesigned.

- [ ] `WorkspaceToolExecutor` ported to `packages/cli/src/agent/workspaceTools.ts`: `read_file`/`list_dir`/`write_file`/`edit_file`/`multi_edit`/`rename_file`/`delete_file`/`create_directory` on `fs/promises`; `search` on `fast-glob` (replacing `vscode.workspace.findFiles`); `check_package_exists`/`fetch_url`/`detectPackageInstall` unchanged (already pure Node); workspace-root jail + symlink-safe resolve preserved exactly — a security property, so it gets its own explicit test, not just inherited confidence
- [ ] `run_command` ported with the hidden-fallback path (`runCommandHidden`) promoted from "VS Code's fallback" to **the CLI's only/primary path**: plain `child_process.spawn`, SIGKILL on timeout/abort, the `$PWD`-marker trick for cwd persistence across calls, head/tail output truncation to a token budget, exit code reported
- [ ] `get_symbols` ported using `core`'s tree-sitter symbol extraction (`rag/symbols.ts`) instead of a VS Code document-symbol provider — degraded precision (no real LSP), fully portable, no daemon. `get_diagnostics`/`find_references`/`go_to_definition` explicitly **dropped from v1**, not silently missing — see Backlog
- [ ] Permission engine ported: Allow Once / Session / Always / Deny as an `ink-select-input` prompt, exact command/paths shown before running, Safe Mode flag, decisions persisted per-project (same `<cwd>/.heapcode/` convention as history)
- [ ] `SessionCheckpoint` (per-turn revert-all) and `ShadowGit` (per-tool-call checkpoints, M8-equivalent from day one — no reason to re-walk the extension's per-turn→per-tool-call staging now that the finer-grained version already exists and works) ported: `fs/promises` + plain string paths + a plain logger callback instead of `vscode.OutputChannel`
- [ ] Agent loop wiring: `runAgent`'s `beforeToolCall`/`execute`/`requestPermission`/events callbacks implemented by the CLI host (this piece needed zero porting — `loop.ts` was already host-agnostic); live tool-call status chips in the transcript (name, args summary, ✓/✗, elapsed time); a `/rewind <n>` command backed by `ShadowGit.restore(hash)`
- [ ] Iteration cap, native tool-calling **and** structured-text fallback with repair re-prompt (already in `core`, unchanged) — verified against both a tool-calling and a non-tool-calling local model
- [ ] Scripted agent-session tests: happy path, malformed tool call repair, permission denial, iteration cap, checkpoint restore — same shape as the extension's M4 tests, now runnable against real temp directories instead of a mocked `vscode.workspace.fs`

**Exit criteria:** "add a `/health` endpoint with a test" on a sample Express repo, run from `heapcode` in that repo's directory, completes end-to-end with terminal permission prompts; `/revert` restores the workspace byte-identical; a no-tool-call local model completes the same task via the fallback protocol; a destructive command shows the exact command before running and is deny-able.

### CLI-M2 — Personas, Memory, Skills, Commands & Mentions

Goal: the CLI feels like the same product as the extension, not a stripped-down cousin — everything here is porting logic that already exists and is already tested, scoped as its own milestone specifically to keep CLI-M1 (genuinely new I/O-layer work) from ballooning.

- [ ] Personas (`agent/personas.ts`) — zero `vscode` import already, drop-in as-is: Agent/Architect/Debug/Reviewer + `intersectPersonas`/`looksFilesystemMutating`; a `/persona architect` picker
- [ ] Project memory: `.heapcode/HEAPCODE.md` + `.heapcode/memory.md`, `AGENTS.md` fallback — already core logic via `instructions.ts`, just needs a Node file-read host call
- [ ] Skills: `.claude/skills/<name>/SKILL.md` (project) / `~/.claude/skills/<name>/SKILL.md` (personal) — already core logic via `skills.ts`, same `list_skills`/`load_skill` tool pair as the extension, zero format divergence
- [ ] Slash commands with autocomplete in the composer: `/explain /fix /refactor /review /test /docs /security-review /optimize /persona /profile /rewind /revert`
- [ ] Mentions scoped to what a terminal can actually provide: `@file` `@folder` `@workspace` (deferred to CLI-M3, needs the RAG index). `@selection`/`@problems` excluded (no editor, no diagnostics) — see decisions log
- [ ] Sub-agent delegation groundwork: port `intersectPersonas`-based safety logic in prep for `delegate_task` (full tool ships in CLI-M4, genuinely new host-side glue, not a straight port)

**Exit criteria:** an agent session honors a picked persona (Architect can't write, verified); `.heapcode/HEAPCODE.md`/`memory.md` content visibly shapes a response without repeating it in-prompt; `/security-review` and at least 3 other slash commands work with autocomplete; a Skill with a bundled reference file loads and its content reaches the model.

### CLI-M3 — RAG + MCP

Goal: project-wide understanding and external tool servers, matching the extension's M5/M6.

- [ ] RAG indexer ported: file-walk/watch moves from `vscode.workspace.fs`/`vscode.Disposable` to `fs/promises` + `chokidar` (or `fs.watch`, evaluated for cross-platform reliability before committing) for incremental re-index; the indexing algorithm itself (`chunkFile`, AST chunker, `VectorStore`, BM25, hybrid fusion, rerank) is already 100% `core`, unchanged
- [ ] `RepoMapIndexer` ported the same way — import-graph-ranked (already core logic, M11-equivalent from day one, same reasoning as pulling `ShadowGit`'s per-tool-call granularity into CLI-M1 rather than re-staging history)
- [ ] `@workspace` mention / a `/search <query>` slash command wired to `semantic_search`; graceful text-search fallback when no embedder configured (already core behavior)
- [ ] `.heapcodeignore` + real `.gitignore`-awareness (the `ignore` npm package, same as the extension's `ignoreFiles.ts` — port the module, don't re-derive the ignore-glob list a third time)
- [ ] MCP client (`agent/mcp.ts`) ported: fully portable except its logger param (→ a plain callback) and its config source (→ `mcpServers` in `~/.heapcode/config.json` or `<cwd>/.heapcode/mcp.json`, decide scope explicitly in CLI-M3); MCP tools appear under the same permission system as workspace tools

**Exit criteria:** "where is authentication handled?" returns correct files+lines on a medium repo run from the CLI; index completes in the same sub-60s budget as the extension on a comparable repo; editing a file re-indexes only that file; a filesystem MCP server's tools show up in an agent session and go through a permission prompt like any other tool.

### CLI-M4 — Parity, Sub-Agents & Real Headless Mode

Goal: close the remaining gaps against the extension, and make headless mode actually production-usable for CI/scripting — a real differentiator, not just a `-p` flag that only handles a single chat turn.

- [ ] `delegate_task` tool: mirrors the extension's M12 sub-agent orchestration — isolated fresh-context `runAgent()` call, persona-intersected (never more permissive than the parent), shares the parent's tool executor/checkpoint/abort signal, sequential (same local-model-contention reasoning as the extension's decisions log), one level of nesting only
- [ ] Full headless mode: `heapcode -p "task" --json [--persona X] [--permission-mode <plan|auto-edit|full-auto|default>]` runs the **full agent loop** (tools, checkpoints, RAG if configured), not just chat — a small, closed set of non-interactive permission modes (not a free-form allowlist DSL, to keep the safety surface reviewable); streams newline-delimited JSON events (`tool_call`, `tool_result`, `text_delta`, `result`) so a CI script can tail progress, not just get a final blob
- [ ] Telemetry/audit parity: local capped audit log (`~/.heapcode/audit.json` or per-project) ported from `Telemetry`'s storage-backend-only vscode coupling; same privacy bar (never code/prompts/paths — event+metadata only); a `heapcode audit` subcommand
- [ ] Git checkpoint UX polish: `/checkpoints` to list, `/rewind <id>` refined from CLI-M1's minimal version now that real usage exists to react to
- [ ] Non-interactive permission-mode tests specifically (new surface, not a port — needs its own coverage)

**Exit criteria:** a CI job runs `heapcode -p "fix the failing test in src/foo.ts" --json --permission-mode auto-edit`, produces valid streamed JSON events, exits non-zero on failure/denial, makes no network call beyond the configured model endpoint; a delegated sub-agent task shows up distinctly in both interactive and headless output; `heapcode audit` shows local usage with nothing having left the machine; telemetry opt-out honored (`--no-telemetry` or config).

### CLI-M5 — Distribution

Goal: `npm i -g @heapcode/cli` (name pending the open decision above) is a real, documented, one-command install.

- [ ] Confirm npm package-name/bin-name availability before anything else here locks in
- [ ] Production esbuild bundle: single-file `dist/cli.js`; `web-tree-sitter` WASM assets copied alongside, same pattern as the extension's `esbuild.mjs`
- [ ] `npm publish` under the same license as current extension releases (`PolyForm-Noncommercial-1.0.0`) — confirm this is the intended license for the CLI too rather than assuming continuity silently
- [ ] README (`packages/cli/README.md`): install, quick start, headless/CI usage examples, same privacy-first framing as the root README
- [ ] Version/update-check: lightweight, opt-out-able check against the published npm version (never phones anything but npm's own registry)
- [ ] Optional: one-line curl installer as a convenience wrapper around `npm i -g`, not a replacement packaging mechanism
- [ ] CI: tag-triggered publish workflow mirroring the extension's `VSCE_PAT`-gated release CI, using an `NPM_TOKEN` secret

**Exit criteria:** `npm i -g @heapcode/cli` on a clean machine → `heapcode` runs; version-check surfaces an available update with no network call beyond npm's registry; README's quick-start steps work verbatim for someone who has never seen the repo.

---

## Backlog (do not start — park ideas here)

- **LSP-backed diagnostics/references/go-to-definition** — no portable fallback exists anywhere in the codebase for these (deep `vscode.languages.*`/LSP-command-bus coupling). A real fix is a CLI-side LSP client (spawn `typescript-language-server`, `pyright`, etc. per-project, speak LSP over stdio) — genuinely new subsystem, out of scope until there's concrete need beyond parity-for-parity's-sake.
- **`node-pty` live-streaming terminal** — watch a long `run_command` execute in real time. Native-module packaging risk per guardrail 5; plain-`spawn` is the permanent JS-fallback baseline, this is a UX layer on top.
- **`hc` (or other) short bin alias** — deferred to CLI-M5 pending an actual namespace-collision check.
- **Vision/image input in the terminal** — no meaningful "paste a screenshot" in a TTY; would need a file-path/URL-based attachment flow, a different interaction model from the extension's paste/drop.
- **PR/CI-integrated review, team bundle export/import** (extension M13) — likely *more* natural in a CLI than the extension (a CI job calling `heapcode` to review a PR is a very CLI-shaped use case), deliberately not pulled into CLI-M0–M5 to avoid competing for scope with the CLI's own foundational milestones.
- **Cross-platform packaged single-binary** (`pkg`/Bun-compiled, no Node runtime required) — attractive for a "curl one binary" install story, real per-OS/arch packaging complexity beyond what CLI-M5 needs for a first working `npm i -g`. Revisit once npm distribution is proven.
- **JetBrains plugin** (still parked in `docs/PLAN.md`'s own Track X) — unaffected by this plan; `core`'s IDE-agnostic boundary keeps it possible whenever picked up, independent of the CLI landing first.

---

## Testing strategy

Same conventions as `packages/core`/`packages/vscode` — `pnpm test` (vitest), mock-provider-fixture discipline, tests land with the milestone (guardrail 6), not after.

- **Zero new test-runner config needed:** the root `vitest.config.ts` already globs `packages/*/test/**/*.test.ts` — `packages/cli/test/*.test.ts` is picked up automatically the moment the directory exists.
- **Reuse, don't duplicate, the mock provider:** `packages/core/test/mockServer.ts` (an in-repo OpenAI-compatible fake HTTP server, scripted SSE/JSON/hang/sequence behaviors) is already package-agnostic — CLI tests import it exactly like `packages/core/test/agent.test.ts` does, no CLI-specific fake server.
- **A genuine testing upgrade over the extension, not just parity:** in `packages/vscode`, most of the vscode-coupled modules being ported here (`workspaceTools`, `checkpoint`, `shadowGit`, `mcp`, `profileManager`, `historyStore`, `telemetry`) have **no unit tests today** — `packages/vscode/test/` has exactly two files (`personas.test.ts`, `retentionTracker.test.ts`), and several M8–M13 exit-criteria notes in `docs/PLAN.md` say "needs live F5 testing (not yet done)" for exactly these modules, because there was never a cheap way to mock `vscode.workspace.fs` for them. Their Node-native CLI ports (`fs/promises` against real temp directories) have no such excuse — every one gets real vitest coverage in the milestone that ports it, closing a gap the extension never closed.
- **Ink component testing:** `ink-testing-library` (`render()`, `lastFrame()`, `stdin.write()` to simulate keypresses) for the composer, permission-prompt select list, and transcript rendering.
- **Headless-mode tests are the cheap, high-leverage lever:** the headless runner never touches Ink or a real TTY, so its tests are plain function calls against the mock provider + a temp workspace directory, asserting on emitted JSON events — no terminal simulation needed. Existing from CLI-M0, this path accumulates the most test coverage per line of test code across the whole plan.
- **Fixture-driven agent-session tests** (CLI-M1 onward): happy path, malformed tool call repair, permission denial, iteration cap, checkpoint restore/rewind — same shape as `packages/core/test/agent.test.ts`'s scripted-provider pattern, run against real temp directories instead of a `vscode`-mocked filesystem.
- **Manual smoke matrix per release** (mirroring `docs/PRD.md`'s existing manual matrix): Ollama (local, both tool-calling and non-tool-calling models), one cloud provider, one MCP server — one smoke run each for chat, agent mode, and headless mode, before tagging a release.

---

## Decisions log

| Date | Decision | Why |
|------|----------|-----|
| 2026-07-23 | Ink (React for CLIs) for the interactive TUI | Matches the team's existing React fluency (`packages/webview-ui`) and the actual hard problems (streaming transcript, live tool-call chips, conditional prompt panels) are the same class of problem React already solves for the webview; also the toolkit current-generation agentic coding CLIs converge on |
| 2026-07-23 | Headless (`-p`/`--json`) mode never mounts Ink — it's a separate thin front end over the same shared runner as the interactive UI, present from CLI-M0 (minimal) rather than retrofitted at the end | Ink assumes a real terminal (raw mode, stable width, interactive stdin); none of that holds in CI or a pipe. Splitting early keeps headless mode continuously exercised by both usage and tests instead of rotting until CLI-M4 forces a rewrite to make it robust |
| 2026-07-23 | Markdown rendering: `marked` (same parser as `packages/webview-ui`) + `marked-terminal` for ANSI rendering + `cli-highlight` (same `highlight.js` grammar family as the webview) for code blocks | Reuses the same parser and highlighter *family* the extension already uses, so markdown that renders correctly in the webview has the best chance of rendering correctly in the terminal too |
| 2026-07-23 | `run_command`'s plain `child_process.spawn` hidden-fallback path (already built for the extension) is the CLI's primary and only execution path in CLI-M1; a `node-pty` live-streaming terminal is backlog, not blocking | The extension needed the spawn path only as a fallback behind its integrated-terminal streaming path, which doesn't exist in a CLI at all — for the CLI this *is* the primary path, and it's already fully built, tested-shape, and native-module-free per guardrail 5 |
| 2026-07-23 | `get_diagnostics`/`find_references`/`go_to_definition` dropped from CLI v1; `get_symbols` ships using `core`'s tree-sitter symbol extraction instead of a VS Code document-symbol-provider port | No portable fallback exists anywhere in the codebase for the first three (deep `vscode.languages.*`/LSP-command-bus coupling) — a real fix means a genuinely new CLI-side LSP client, not worth building speculatively. `get_symbols` already has a fully portable tree-sitter-based implementation via the repo-map indexer |
| 2026-07-23 | Secrets in a plain `~/.heapcode/secrets.json` (`chmod 600`), not an OS-keychain binding | Guardrail 5 applies just as much to the CLI as the extension; a keychain-only design fails on headless/CI machines and anywhere the keychain is locked or unavailable (common on Linux). Matches how `gh`/`aws` and most CLIs already handle this |
| 2026-07-23 | Config at `~/.heapcode/config.json` (profiles, active profile, settings, global), history/checkpoints at `<cwd>/.heapcode/` (per-project) | Provider profiles are a personal, cross-project setup concern; conversation history, checkpoints, and project memory are inherently project-scoped and already live under `<cwd>/.heapcode/` by existing convention |
| 2026-07-23 | Agent-mode milestone split into CLI-M1 (tools, permissions, checkpoints) and CLI-M2 (personas, memory, Skills, slash commands, mentions) | CLI-M1 is where genuinely new I/O-layer work happens (vscode→Node fs/spawn/glob swap, terminal permission-prompt component); CLI-M2's items are close-to-zero-porting-cost reuse of already-`vscode`-free or already-pure core logic. Bundling both would obscure which parts carry real risk |
| 2026-07-23 | `ShadowGit`'s per-tool-call granularity (extension M8) and `RepoMapIndexer`'s import-graph ranking (extension M11) built into CLI-M1/CLI-M3 directly, not re-staged incrementally like the extension's own history | The CLI is porting code that already proved these decisions worth making; re-staging the same incremental discovery here would just re-derive a conclusion the project already reached |
| 2026-07-23 | Bin name (`heapcode` vs. `hc` vs. other) left an open decision, deferred to CLI-M5 | `heapcode` carries zero collision risk but costs more keystrokes on a tool meant to be typed dozens of times a session; short aliases carry real `$PATH`-collision risk that needs an actual availability check, not a guess made now |
| 2026-07-23 | `@problems`/diagnostics-dependent mentions and `@selection` (no editor) excluded from CLI-M2's mention set rather than stubbed | Both depend on capabilities that don't exist in a terminal — scoping mentions to what the CLI can actually provide (`@file`/`@folder`/`@workspace`) avoids shipping a mention that silently does nothing |
| 2026-07-23 | CLI package uses ESM output (matching `core`'s `"type": "module"`), unlike the VS Code extension's CJS bundle | The extension is CJS only because VS Code's extension host historically required it; the CLI has no such constraint and importing `@heapcode/core` (ESM-only, `moduleResolution: bundler`) is simplest when the whole chain stays ESM |
| 2026-07-23 | Found during CLI-M0 implementation: `ConfigStore`'s "no config file yet" fallback returned `{ ...EMPTY }` where `EMPTY` was a module-level `{ profiles: [] }` constant — the spread is shallow, so every fresh `ConfigStore` shared and mutated the *same* `profiles` array, leaking profiles across unrelated instances (surfaced as cross-test contamination, would equally have hit two real config files created back-to-back in the same process). Fixed with a factory function returning a new object (and new array) every call | Classic shallow-clone-of-a-shared-mutable-default pitfall — worth recording since the same pattern (a module-level default merged via spread) shows up anywhere a store class has a "file doesn't exist yet" fallback, e.g. the history store's equivalent path, which was written carefully enough the first time to already avoid it (`[]` literal per call, not a shared constant) |
| 2026-07-23 | Found during CLI-M0 implementation: `profileAdd()`'s wizard originally called `readline.createInterface()` fresh per question. Fixed to one shared `Prompter`/`readline.Interface` for the whole flow (`prompt.ts`) | Piped/non-TTY stdin delivers multiple answered lines in one chunk; the first `readline.Interface` reads the chunk, resolves only its own pending question, and discards whatever else of that chunk it had already buffered when `.close()` is called — a second `createInterface` then waits forever for input that already arrived and is gone. A real interactive TTY session (keystrokes arriving one at a time) never hits this, but a shared interface is correct either way and is what makes scripted verification (and any future non-interactive setup path) possible at all |
| 2026-07-23 | Found during CLI-M0 implementation: `Composer`'s Enter handler read `value` from the `useInput` callback's closure; back-to-back keystroke events in the same tick (a paste immediately followed by Enter — same shape as a test driving `stdin.write` synchronously) could read a stale, pre-update closure and silently no-op the submit. Fixed by tracking the current text in a `useRef` alongside the rendered `useState`, and reading the ref (always current) at submit time | `useInput` fires from a raw stdin event outside React's own event/batching system, so there's no guarantee a prior `setValue` in the same tick has committed before the next event's handler runs. This isn't just a test artifact — anything that delivers input faster than a human types (paste, or piped/scripted input) could hit the same stale-read race in real usage |
| 2026-07-23 | Two esbuild-specific workarounds needed for a Node-ESM-output Ink bundle, beyond what the VS Code extension's CJS `esbuild.mjs` ever needed: (1) a `createRequire` banner, because bundled CJS deps calling `require('some-builtin')` (e.g. `signal-exit` → `require('assert')`) hit esbuild's synthesized `__require` shim, which throws at runtime under ESM output; (2) aliasing `react-devtools-core` to a local no-op stub, because esbuild hoists that import to top-level regardless of the runtime `DEV`-env-var guard Ink wraps it in, so `external` alone still ships an unresolvable import | Both are well-known esbuild+ESM-output rough edges, not CLI-specific design choices — recorded here so CLI-M1+ (or any future Node-ESM esbuild target in this repo) doesn't have to rediscover them from scratch |
