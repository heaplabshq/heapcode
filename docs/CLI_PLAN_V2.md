# Heap Code CLI — Build Plan v2

Supersedes `docs/CLI_PLAN.md` (kept unchanged as the historical record of the original plan and its decisions log — read it first for the architecture rationale, Ink decision, and CLI-M0/M1 implementation notes). This document is the **current** source of truth for what's done, what's left, and *how* to build what's left. Same rules as v1: update checkboxes as work lands, never start a milestone before the previous one's exit criteria are met.

## Status at a glance (2026-07-24)

| Milestone | Status |
|---|---|
| CLI-M0 — Walking skeleton | ✅ shipped |
| CLI-M1 — Agent mode: tools, permissions, checkpoints | ✅ shipped |
| CLI-M1.5 — Terminal product experience *(added in v2 — was not in v1)* | ✅ shipped |
| CLI-M2 — Personas, memory, Skills, commands & mentions | ✅ shipped |
| CLI-M3 — RAG + MCP | ⬜ next |
| CLI-M4 — Parity, sub-agents & real headless mode | ⬜ |
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

## CLI-M3 — RAG + MCP ⬜

Scope unchanged from v1 (indexer port with `chokidar`-or-`fs.watch` decision, `RepoMapIndexer`, `@workspace`/`/search`, `.heapcodeignore`, MCP client with config-scope decision). Additional guidance:
- MCP tools appear in the same permission system and the same tool-chip UI — no separate rendering path.
- Index progress belongs in the status footer (dim "indexing… n/m files"), not in the transcript.
- `/search <query>` output is a system transcript item (file:line list), not an agent turn.
- Exit criteria unchanged from v1.

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
| 2026-07-24 | Launch starts a fresh conversation; continuing is explicit (`--continue`/`-c`, `/resume`) — reversing CLI-M0's continue-by-default | Auto-replaying a long stored transcript on every launch is confusing (a replayed pre-fix session read as "the bug is still there") and non-standard; every reference CLI starts fresh and makes continuation opt-in |
| 2026-07-24 | Multi-turn context threaded into the agent loop via a new `runAgent({ history })` option, capped host-side (last 12 turns, 4k chars each) | Each agent run previously received only the current message — conversation "continuity" existed in the UI and on disk but never reached the model, so follow-up messages were interpreted as context-free new tasks (a real cause of the "ok what shall we do" → explore-everything behavior, alongside the nudge bug). Host-side capping keeps the core option simple; compaction already guards long transcripts |
