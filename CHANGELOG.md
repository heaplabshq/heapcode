# Changelog

## 0.1.0 (unreleased)

Initial release.

- Streaming chat with history, slash commands, custom prompts, and context mentions
- Provider profiles for 11 OpenAI-compatible providers with per-role models (chat/completion/embeddings), keys in the OS keychain, retry/backoff
- Ghost-text completions: FIM templates per model family, native Ollama FIM, debounce/cancellation/caching, latency instrumentation
- Inline edit (Ctrl+I/Cmd+I) with native diff review and title-bar accept/reject
- Agent mode: 10 workspace-jailed tools, permission engine (Once/Session/Always + Safe Mode), session checkpoints with revert-all, native tool-calling and text fallback
- Semantic index (RAG): incremental background embedding index, @workspace retrieval, agent semantic_search
- MCP client (stdio/HTTP/SSE) exposing server tools to the agent
- Project memory: CORTEX.md and .cortex/memory.md
- Commit-message generation from the staged diff
