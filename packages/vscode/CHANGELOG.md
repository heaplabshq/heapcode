# Changelog

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
