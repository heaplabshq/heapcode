# Heap Code

**Model-agnostic AI coding assistant for VS Code.** Chat, ghost-text completions, inline edits, an autonomous agent, and semantic codebase search — with **any OpenAI-compatible API**, local or cloud.

## Privacy first

Your code never leaves your machine except to the endpoint **you** configure. No telemetry, no proprietary backend, no account, no automatic uploads. Point it at Ollama on your LAN and everything stays home.

## Works with

| Local | Cloud |
|---|---|
| Ollama, LM Studio, vLLM, LocalAI | OpenAI, Azure OpenAI, OpenRouter, Groq, Together AI, NVIDIA NIM |

…plus any custom OpenAI-spec endpoint. Providers are **named profiles** — switch from the status bar, with separate model roles for **chat / edit / apply / completion / agent / embeddings / rerank** per profile. Any role can also run on a *different* profile entirely (Settings → Model roles & tuning → "run on profile") — e.g. embeddings on a local Ollama profile while chat/agent use a cloud profile.

## Features

- **Chat** — streaming markdown with syntax highlighting; history per workspace; slash commands (`/explain`, `/fix`, `/review`, `/security-review`, …) with autocomplete; custom prompts; `@selection` `@file` `@problems` `@workspace` context mentions; code-block Copy / Insert / Apply actions
- **Completions** — ghost text with proper FIM formats per model family (Qwen, DeepSeek, StarCoder, CodeLlama, Codestral, CodeGemma), native server-side FIM on Ollama, debounced + cancellable, latency stats in the output panel; repo-level context from the semantic-search index (keyword-only while typing, full semantic search on manual trigger) alongside open-editor snippets
- **Inline edit** — select code, `Ctrl+I`/`Cmd+I`, describe the change, review a native diff, accept from the diff title bar
- **Agent mode** — reads, searches, edits files and runs commands to complete tasks autonomously; every non-read action goes through permission prompts (Allow Once / Session / Always, Safe Mode); one-click **Revert all** restores every touched file byte-identical; a persisted, incrementally-updated **repo map** (file paths + top-level symbol names, no model required) gives it a cheap way to orient before searching
- **Semantic search (RAG)** — background incremental index using your embeddings model; AST-aware chunking (TS/TSX/JS/JSX/Python, line-window fallback elsewhere); hybrid search (embeddings + BM25 keyword, fused) on by default; optional contextual retrieval (LLM blurb per chunk) via the Context model role; powers `@workspace` and the agent's `semantic_search`; degrades gracefully to text search with no embedder
- **MCP** — register Model Context Protocol servers (stdio / HTTP / SSE); their tools appear in agent mode under the same permission system
- **VS Code tool interop** — any tool another installed extension registered via VS Code's Language Model Tools API (Python, Jupyter, SonarQube, …) shows up in agent mode too, same tools picker, same permission system
- **Project memory** — `.heapcode/HEAPCODE.md` + `.heapcode/memory.md` are loaded into every chat and agent session (falls back to `AGENTS.md` if neither exists — reads the same instructions you've already written for other AI tools); add path-scoped rules with `.heapcode/instructions/*.md` files (optional front-matter `applyTo: "**/*.tsx"` glob — applies everywhere if omitted); the agent can propose short "worth remembering" notes at the end of a session, added to memory only with your confirmation (`heapcode.agent.memoryDistillation`)
- **Skills** — model-invoked capabilities from `.claude/skills/<name>/SKILL.md` (project) or `~/.claude/skills/<name>/SKILL.md` (personal) — the same convention Claude Code uses, so Skills are shared with zero setup. The agent calls `list_skills` (name + description only, cheap) then `load_skill` on whichever matches the task, including bundled reference files
- **Git** — commit-message generation from the staged diff (✨ button in Source Control)

## Quick start

1. `pnpm install && pnpm build`, then press **F5** in VS Code (or install the packaged `.vsix`).
2. Click the **✨ status bar item** → *Add profile* → pick your provider (e.g. Ollama) → pick a model.
3. Recommended local models: chat `llama3.1:8b`+ · completion `qwen2.5-coder:1.5b` · embeddings `nomic-embed-text`.
4. Open the Heap Code icon in the activity bar and start chatting; select code and hit `Cmd+I` to edit.

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
