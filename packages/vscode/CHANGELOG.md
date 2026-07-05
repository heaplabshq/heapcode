# Changelog

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
