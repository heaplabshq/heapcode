# Cortex Code

**Model-agnostic AI coding assistant for VS Code.** Chat, ghost-text completions, inline edits, an autonomous agent, and semantic codebase search — with **any OpenAI-compatible API**, local or cloud.

## Privacy first

Your code never leaves your machine except to the endpoint **you** configure. No telemetry, no proprietary backend, no account, no automatic uploads. Point it at Ollama on your LAN and everything stays home.

## Works with

| Local | Cloud |
|---|---|
| Ollama, LM Studio, vLLM, LocalAI | OpenAI, Azure OpenAI, OpenRouter, Groq, Together AI, NVIDIA NIM |

…plus any custom OpenAI-spec endpoint. Providers are **named profiles** — switch from the status bar, with separate model roles for **chat / completion / embeddings** per profile.

## Features

- **Chat** — streaming markdown with syntax highlighting; history per workspace; slash commands (`/explain`, `/fix`, `/review`, …) with autocomplete; custom prompts; `@selection` `@file` `@problems` `@workspace` context mentions; code-block Copy / Insert / Apply actions
- **Completions** — ghost text with proper FIM formats per model family (Qwen, DeepSeek, StarCoder, CodeLlama, Codestral, CodeGemma), native server-side FIM on Ollama, debounced + cancellable, latency stats in the output panel
- **Inline edit** — select code, `Ctrl+I`/`Cmd+I`, describe the change, review a native diff, accept from the diff title bar
- **Agent mode** — reads, searches, edits files and runs commands to complete tasks autonomously; every non-read action goes through permission prompts (Allow Once / Session / Always, Safe Mode); one-click **Revert all** restores every touched file byte-identical
- **Semantic search (RAG)** — background incremental index using your embeddings model; powers `@workspace` and the agent's `semantic_search`; degrades gracefully to text search with no embedder
- **MCP** — register Model Context Protocol servers (stdio / HTTP / SSE); their tools appear in agent mode under the same permission system
- **Project memory** — `CORTEX.md` + `.cortex/memory.md` are loaded into every chat and agent session
- **Git** — commit-message generation from the staged diff (✨ button in Source Control)

## Quick start

1. `pnpm install && pnpm build`, then press **F5** in VS Code (or install the packaged `.vsix`).
2. Click the **✨ status bar item** → *Add profile* → pick your provider (e.g. Ollama) → pick a model.
3. Recommended local models: chat `llama3.1:8b`+ · completion `qwen2.5-coder:1.5b` · embeddings `nomic-embed-text`.
4. Open the Cortex icon in the activity bar and start chatting; select code and hit `Cmd+I` to edit.

API keys are stored in the OS keychain via VS Code SecretStorage — never in settings files.

## Repository layout

```
packages/core        IDE-agnostic engine: providers, agent loop, tools, RAG, prompts
packages/vscode      VS Code extension (thin adapter over core)
packages/webview-ui  React chat UI
docs/PRD.md          Product requirements (source of truth)
PLAN.md              Milestone tracker + decisions log
```

`core` never imports `vscode` (lint-enforced) — JetBrains/Neovim adapters can reuse it wholesale.

## Development

```bash
pnpm install
pnpm build        # webview + extension
pnpm test         # core unit tests (offline mock provider)
pnpm typecheck && pnpm lint
cd packages/vscode && pnpm package   # build the .vsix
```

## License

TBD before marketplace publication (MIT or Apache-2.0 — see PLAN.md).
