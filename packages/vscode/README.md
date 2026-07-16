# Heap Code

Model-agnostic AI coding assistant for VS Code. Works with **any OpenAI-compatible API** — local (Ollama, LM Studio, vLLM, LocalAI) or cloud (OpenAI, OpenRouter, Groq, Together, Azure OpenAI, NVIDIA NIM).

## Privacy

Your code never leaves your machine except to the endpoint **you** configure. No telemetry, no proprietary backend, no account. Point it at Ollama on your LAN and everything stays home. API keys live in your OS keychain, never in settings files.

## Quick start

1. Open the **Heap Code** icon in the activity bar.
2. Click the **⚙ gear** in the chat header → add a provider profile (Ollama works out of the box at `http://localhost:11434/v1`).
3. Pick a model, chat. Switch to **Agent** mode for autonomous multi-file tasks.

## Features

- **Chat** — streaming markdown; history; slash commands (`/explain`, `/fix`, `/review`, `/security-review`…); `@selection` `@file` `@problems` `@terminal` `@workspace` mentions; attach files, folders, or a line-range selection; paste screenshots for vision models; code-block Copy / Insert / Apply
- **Agent mode** — plans, then reads, searches, edits files and runs commands autonomously; language-server tools (symbols, references, definitions) plus a persisted `repo_map` outline of the workspace; every non-read action behind permission prompts; per-file Keep / Revert / Reapply and per-turn workspace restore; a 🔧 picker chooses which tools it may use; proposes short "worth remembering" notes at the end of a session, saved only with your confirmation
- **Completions** — ghost text with proper FIM formats per model family (Qwen, DeepSeek, StarCoder, CodeLlama, Codestral, CodeGemma), native Ollama FIM, debounced + cancellable; repo-level context from the semantic index (fast keyword-only while typing, full semantic search on manual trigger)
- **Inline edit** — select code, `Ctrl+I`/`Cmd+I`, describe the change, review in a native diff, accept from its title bar or the Accept/Reject CodeLens above the diff
- **Semantic search (RAG)** — background incremental index with your embeddings model; AST-aware chunking (TypeScript/TSX/JavaScript/JSX/Python) so results align to real function/class boundaries; hybrid retrieval (embeddings + BM25 keyword search, fused) on by default; optional contextual retrieval for even better recall; powers `@workspace` and the agent's search
- **Context management** — usage meter with auto-detected model context windows; automatic conversation compaction; edit any earlier prompt to rewind conversation *and* workspace
- **MCP** — register Model Context Protocol servers (stdio / HTTP / SSE); their tools join agent mode under the same permissions
- **Project memory** — `HEAPCODE.md` (or `AGENTS.md`, if that's what your project already uses) + `.heapcode/memory.md` load into every session
- **Git** — commit-message generation from the staged diff (✨ in Source Control)

## Provider profiles

Named profiles with per-role models — chat, edit, apply, autocomplete, agent, embeddings, rerank, context — managed in the in-chat settings panel or via the status bar. Capabilities (vision, tool calling, context window) resolve per preset and per model, with per-profile overrides.

## License

[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for any noncommercial use (personal, private/internal, research, nonprofit, education, government); not for commercial productization. `0.1.x` remains available under its original Apache-2.0 terms. Source: [github.com/sid7631/heapcode](https://github.com/sid7631/heapcode)
