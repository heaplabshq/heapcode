# Changelog

## 0.6.1

- **An agent session gets 100 plan→act→observe iterations instead of 50, and reaching the limit now asks whether to keep going.** An iteration is one model turn, so a batch of parallel tool calls costs one and a read-then-edit-then-test cycle costs three — real multi-file work spent the old budget before finishing, and the session ended on a "what's done, what remains" summary that reads exactly like a completed job. Answering the question continues inside the same session, with the whole run's context intact; a follow-up message would have started the model over from that summary alone. `heapcode.agent.maxIterations` still sets the ceiling

## 0.6.0

- **Permission modes in the chat composer, with Shift+Tab to cycle them** — Plan (read-only, only read tools are offered), Confirm (ask before every write, command, and destructive action), Auto-edit (edits apply silently, commands still ask), and Auto (edits and commands run freely). The chip shows the current mode and can be changed mid-run; the permission engine reads it per request. Auto still asks before anything destructive. The mode is in-memory only, so it resets to Confirm whenever the window reloads — a permissive mode is never inherited by tomorrow's session. Shared with the `heapcode` CLI, so both behave identically
- **Changed:** in Confirm mode, a saved "Always allow" grant from an earlier session no longer skips the prompt. A mode the UI calls Confirm has to confirm — a grant saved weeks ago quietly approving edits is indistinguishable from the permission system being broken. Grants still apply in Auto-edit and Auto, where less prompting was the point, and a grant made during the current session still stands. "Heap Code: Reset Agent Permissions" clears saved grants
- **Fixed:** a model whose chat template has no tool support no longer fails the run. Many local GGUF builds — Gemma 2 and Codestral among them — reject any request carrying tool definitions, which surfaced as a 400 immediately after the planning stage, since planning sends no tools and the turn after it sends all of them. That rejection now switches the run to the text-based tool protocol and carries on. A new **Native tool calling** checkbox in the profile settings makes the switch permanent and skips the retry
- **Fixed:** a model that writes its tool call as text instead of calling the tool no longer ends the run. Several open-weight models emit `<tool_call>`, `<function=…>` or Hermes-style JSON regardless of what the endpoint supports, because they were trained on it; those replies read as narration, so the agent nudged until it gave up. Those dialects are now understood, and on an endpoint with real tool calling the model is asked once for a proper call first
- **Web search — off by default.** `web_search` is offered to the model but refuses to run until `heapcode.webSearch.provider` is set: DuckDuckGo (no key), Brave, Tavily, Serper, or a self-hosted SearXNG. Keys go to the OS keychain via **Heap Code: Set Web Search API Key**, never to settings.json. Results are treated as untrusted content, the same as `fetch_url`. Requests are spaced per provider and 429s are retried with backoff
- **Better provider errors.** A 404 from a router that names its upstream now says the model isn't being served rather than blaming a base URL that demonstrably worked. A 400 meaning "prompt longer than the context this server was started with" says so and names both settings that fix it — local servers default to a small context regardless of what the model supports
- **Fewer lost turns.** A stalled stream ("Upstream idle timeout exceeded") is retried instead of ending the run, including when it carries no status code, and 408 and Cloudflare 52x are treated as retryable. A stream that stalled after emitting only reasoning tokens can now be retried at all — reasoning is display-only, so replaying it can't duplicate an answer
- The model picker matches terms in any order — "nvidia ultra" finds `nvidia/nemotron-3-ultra-550b-a55b:free`, which a plain substring search never did
- **Fixed:** HTML entities in fetched pages and search results (`Rust&#x27;s`) are now decoded

## 0.5.0

- **PR review, rebuilt:** the reviewer now reads a large PR file by file instead of truncating the diff at a fixed size and silently reviewing only what fit — a real case had it review a plan document and never reach the code. Files it couldn't get to are reported as unreviewed rather than passed over as clean, and findings post as line-anchored inline comments with one-click suggestions instead of one long comment
- **New command — "Heap Code: Review Current PR (Deep, Verified) & Comment":** adds an independent verification pass that re-reads the code behind each finding and drops false positives before you see them, at roughly double the time and model cost. The existing single-pass command is unchanged and still the default
- **Security:** `fetch_url` can no longer reach private, loopback, or link-local addresses — including cloud metadata endpoints (`169.254.169.254`), which hand out IAM credentials. This matters because the agent reads web pages and MCP output, and text in those can steer it; redirects are re-checked at every hop, so a public URL can't bounce into your internal network. Your own model endpoint is unaffected — Ollama or LM Studio on localhost or a LAN box works exactly as before
- The review engine now lives in shared code with the new `heapcode` CLI, so the two can't drift in review quality

## 0.4.0

- **Safety:** external content (files, URLs, MCP/tool results, RAG hits) is now trust-tagged and wrapped as inert data before reaching the model, so a maliciously-crafted file or web page can't smuggle instructions into a session
- **Safety:** package installs are checked against the npm/PyPI registry first and blocked if the name looks hallucinated (`check_package_exists` tool + automatic `run_command` guard)
- **Safety:** optional `heapcode.agent.requireTestsBeforeFinish` blocks the agent from finishing while a file write hasn't been verified by a test run
- **Checkpoints:** every non-read tool call now gets its own shadow-git snapshot with a "Rewind to before this step" button, in addition to the existing per-turn/session-level restore
- **Modes:** new persona picker — Agent (full access), Architect (read-only), Debug (read + execute, no writes), Reviewer (read-only) — restricts which tools the agent is even offered
- **Plan/Act:** optional `heapcode.agent.planGate` stops after a plan and waits for an explicit "Approve & Run" before any tool executes
- Agent-side fast-apply: an `edit_file` search-replace that fails to match now falls back to the apply model instead of erroring outright
- Repo map (`repo_map` tool) now orders files by import/dependency-graph centrality personalized to open tabs and recent edits, instead of alphabetically
- **Sub-agents:** optional `heapcode.agent.subAgents` (toggle in-app under Settings → Agent, or via the setting directly) offers a `delegate_task` tool that hands a self-contained piece of work to an isolated sub-agent — its own context, optionally its own persona/model, capped at one level of nesting, never more permissive than its parent
- Agent runs now survive the chat sidebar being closed or the window reloading — reconnecting rehydrates the live transcript instead of showing a blank chat, and a native notification fires if a run finishes while the panel isn't visible
- **Team/Enterprise:** `.heapcode/` bundle export/import as a single JSON file (project instructions, memory, skills, workspace agent settings)
- **Team/Enterprise:** "Review Current PR & Comment" — generates a review via `gh`, always opens it in an editor tab first, requires explicit confirmation before posting
- **Team/Enterprise:** local usage/audit dashboard — retention stats, permission decisions, checkpoint activity — nothing leaves the machine to produce it
- Fixed: a Debug-persona agent (read + execute, no writes) could still create/edit/delete files by running a shell command like `mkdir`/`rm`/`sed -i` — `run_command` now blocks filesystem-mutating commands for any persona without write access

## 0.3.0

- **Added anonymous usage telemetry, on by default** — event names only (which commands/features are used, coarse error counts), never code/prompts/file contents/paths, tagged with a random per-install ID. Turn it off with `heapcode.telemetry.enabled` or VS Code's own `telemetry.telemetryLevel`. See the README "Telemetry" section for exactly what's sent.

## 0.2.2

- No functional changes from 0.2.1 — version bump only, to republish after 0.2.1 was already live on the Marketplace

## 0.2.1

- Fixed the Marketplace listing (Details tab) showing stale content — it's a separate README from the repo root one and had been missed, still showing the old Apache-2.0 license and an outdated feature list

## 0.2.0

- **License changed from Apache-2.0 to PolyForm Noncommercial License 1.0.0** — free for noncommercial use; `0.1.x` remains available under its original Apache-2.0 terms
- Semantic search: AST-aware chunking (tree-sitter) for TypeScript/TSX/JavaScript/JSX/Python — chunks align to real function/class boundaries instead of line windows, with the line-window chunker as fallback everywhere else
- Semantic search: hybrid retrieval — BM25 keyword search fused with embeddings (reciprocal rank fusion), on by default; catches exact-identifier queries pure embedding search misses
- Semantic search: optional contextual retrieval — an LLM-generated blurb per chunk before embedding, off by default (`heapcode.rag.contextualRetrieval`); new `contextModel` profile role
- Completions: repo-level context — a fast BM25-only lookup for typing-triggered completions, the full semantic index for manual-trigger (Alt+\\) completions (`heapcode.completion.repoContext`)
- Agent: `repo_map` tool — a persisted, incrementally-updated outline of every file's top-level symbols, so the agent can orient without a search call
- Agent: session-to-memory distillation — proposes a short note at the end of a successful session, appended to `.heapcode/memory.md` only with your confirmation (`heapcode.agent.memoryDistillation`)
- Project instructions: reads `AGENTS.md` as a fallback when there's no `.heapcode/HEAPCODE.md`
- New `/security-review` slash command and context-menu entry, focused specifically on vulnerabilities (injection, hardcoded secrets, broken auth, etc.)
- Inline edit: Accept/Reject also available as CodeLens directly above the diff
- Fixed: closing the last open editor tab while chat had focus could leave a stale file as context for `@file`/agent tasks
- Fixed: agent mode no longer forces a multi-step plan on simple lookup questions
- Fixed: plain chat (Ask mode) no longer leaks literal tool-call-like text into answers when its read-only tool budget runs out

## 0.1.1

- Wire up CI-based Marketplace publishing (no functional changes from 0.1.0)

## 0.1.0

Initial marketplace release.

- Streaming chat with history, slash commands, custom prompts, and context mentions (`@selection` `@file` `@problems` `@terminal` `@workspace`)
- Provider profiles for 11 OpenAI-compatible providers with per-role models (chat/edit/apply/completion/agent/embeddings/rerank), keys in the OS keychain, retry/backoff; in-chat settings panel
- Ghost-text completions: FIM templates per model family, native Ollama FIM, debounce/cancellation/caching, latency instrumentation
- Inline edit (Ctrl+I/Cmd+I) with native diff review and title-bar accept/reject
- Agent mode: 17 workspace-jailed tools including language-server symbols/references/definitions, `fetch_url`, `multi_edit`, and `ask_user` question cards; permission engine (Once/Session/Always + Safe Mode); tools picker; plan-first execution with live reasoning stream
- Workspace checkpoints: per-file Keep/Revert/Reapply, per-turn restore, and edit-an-earlier-prompt rewind (shadow git)
- Context management: usage meter with auto-detected context windows (provider-reported, incl. Ollama/LM Studio native APIs), automatic conversation compaction
- Vision: paste or drop screenshots into chat and agent tasks (vision-capable models)
- Semantic index (RAG): incremental background embedding index with LLM rerank stage, `@workspace` retrieval, agent `semantic_search`
- MCP client (stdio/HTTP/SSE) exposing server tools to the agent
- Project memory: `HEAPCODE.md` and `.heapcode/memory.md`
- Commit-message generation from the staged diff
