# Heap Code

**Model-agnostic AI coding assistant for VS Code and the terminal.** Chat, ghost-text completions, inline edits, an autonomous agent, AI PR review, and semantic codebase search — with **any OpenAI-compatible API**, local or cloud.

Two surfaces over one shared engine:

| | Install |
|---|---|
| **VS Code extension** | [Marketplace](https://marketplace.visualstudio.com/items?itemName=heapcode.heap-code) |
| **Terminal CLI** | `npm install -g @heaplabs/heapcode-cli` — see [packages/cli/README.md](packages/cli/README.md) |

## Privacy first

Your code never leaves your machine except to the model endpoint **you** configure — no proprietary backend, no account. Point it at Ollama on your LAN and your code stays home.

Heap Code does send anonymous usage telemetry by default (which features get used, coarse error counts — never code, prompts, or file contents/paths). Turn it off via `heapcode.telemetry.enabled` or VS Code's own `telemetry.telemetryLevel`. See [packages/vscode/README.md](packages/vscode/README.md#telemetry) for details.

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
- **AI PR review** — reviews the current branch's pull request file by file (never a blind truncation of a large diff), then posts a real GitHub review with line-anchored inline comments and one-click suggestions, always after an explicit confirmation. Deep mode adds an independent verification pass that re-reads the code and drops false positives first. Uses your existing `gh auth login` session. Available as `/pr-review [deep]` in the CLI and as the *Review Current PR* commands in VS Code — same engine, same result
- **Terminal CLI** — the same agent, permissions, checkpoints, RAG, and MCP in a standalone `heapcode` binary, plus a headless `-p "task"` mode (`--json` events, four permission modes, non-zero exit on failure) for CI
- **Git** — commit-message generation from the staged diff (✨ button in Source Control)

## Quick start

**CLI:** `npm install -g @heaplabs/heapcode-cli`, then run `heapcode` — it walks you through picking a provider and model on first run. `heapcode -p "task"` runs the same agent headlessly.

**VS Code:**

1. `pnpm install && pnpm build`, then press **F5** in VS Code (or install the packaged `.vsix`).
2. Click the **✨ status bar item** → *Add profile* → pick your provider (e.g. Ollama) → pick a model.
3. Recommended local models: chat `llama3.1:8b`+ · completion `qwen2.5-coder:1.5b` · embeddings `nomic-embed-text`.
4. Open the Heap Code icon in the activity bar and start chatting; select code and hit `Cmd+I` to edit.

API keys are stored in the OS keychain via VS Code SecretStorage — never in settings files. The CLI has no keychain dependency (so headless and CI machines work): it uses a `chmod 600` file under `~/.heapcode`.

## Repository layout

```
packages/core        IDE-agnostic engine: providers, agent loop, tools, RAG, prompts
packages/vscode      VS Code extension (thin adapter over core)
packages/cli         Terminal CLI over core — published as @heaplabs/heapcode-cli
packages/webview-ui  React chat UI
docs/PRD.md          Product requirements (source of truth)
docs/PLAN.md         VS Code extension milestone tracker + decisions log
docs/CLI_PLAN.md     CLI milestone tracker + decisions log
```

`core` never imports `vscode` (lint-enforced) — the CLI and any future JetBrains/Neovim adapters reuse it wholesale.

## Development

```bash
pnpm install
pnpm build        # webview + extension
pnpm test         # core unit tests (offline mock provider)
pnpm typecheck && pnpm lint
cd packages/vscode && pnpm package   # build the .vsix
```

## License

[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) —
free to use, modify, and share for any noncommercial purpose (personal use, private/internal
use, research, nonprofits, education, government). Commercial use — selling it, hosting it as
a paid service, bundling it into a commercial product — isn't permitted under this license.
Versions `0.1.x` were released under Apache-2.0 and remain available under those original
terms; this license applies from `0.2.0` onward.
