# Heap Code — Product Requirements Document (PRD)

**Version:** 1.1.0 (enhanced from v1.0.0 draft PDF)
**Status:** Active — this markdown file is the source of truth; the PDF is the original draft.
**Product Name:** Heap Code

Target platforms: VS Code (Phase 1), JetBrains IDEs (Phase 2), Neovim (Phase 3).

---

## 1. Vision

Heap Code is an AI-powered coding assistant comparable to GitHub Copilot, Claude Code, and Cursor, while remaining **model-agnostic**. It works with any OpenAI-compatible API, cloud or local:

OpenAI, Ollama, NVIDIA NIM, OpenRouter, Together AI, Groq, LM Studio, vLLM, LocalAI, Azure OpenAI, and any custom OpenAI-spec endpoint.

## 2. Goals

- Fast AI coding assistance
- Agentic coding workflows
- Project-wide understanding
- Multi-file editing
- Inline code completion
- Local-first compatibility
- Secure tool execution
- Extensible architecture
- MCP support
- RAG support
- Provider-independent API

## 3. Non-Goals

- No proprietary backend required
- No provider lock-in
- No automatic project upload
- No dangerous command execution without permission
- **(added)** No custom editor fork — we live inside the host IDE's extension APIs
- **(added)** No account system, billing, or server-side state in v1–v2

---

## 4. Architecture (enhanced)

### 4.1 Monorepo layout — the key decision for multi-IDE support

All AI logic lives in an IDE-agnostic core package. IDE plugins are thin adapters. This is what makes Phase 2/3 (JetBrains, Neovim) feasible without a rewrite.

```
heapcode/
├── packages/
│   ├── core/            # IDE-agnostic: providers, agent engine, tools, RAG, MCP client
│   │   └── src/
│   │       ├── providers/     # Provider interface + implementations
│   │       ├── agent/         # Agent loop, planning, tool dispatch
│   │       ├── tools/         # Tool definitions + executors (fs, search, git, terminal)
│   │       ├── context/       # Context collection & token budgeting
│   │       ├── completion/    # FIM prompting, caching, debounce logic
│   │       ├── rag/           # Indexing, chunking, embeddings, vector store
│   │       ├── mcp/           # MCP client (stdio/HTTP/SSE)
│   │       └── config/        # Settings schema, profiles
│   ├── vscode/          # VS Code extension (activation, commands, webview host, editor glue)
│   └── webview-ui/      # React + Vite chat UI (built to static assets, loaded in webview)
├── docs/
└── PLAN.md              # Build plan & progress tracker
```

Rule: `core` never imports `vscode`. All IDE capabilities `core` needs (read editor state, show diff, run terminal) are injected through interfaces defined in `core` and implemented in the adapter.

### 4.2 Runtime layers

```
VS Code Extension Host (Node)
├── UI Layer (webview: React chat; native: status bar, quick picks, diff editor)
├── Context Manager      — collects & budgets context
├── Agent Engine         — plan → act → observe loop
├── Tool Executor        — permission-gated tool dispatch
├── Provider Layer       — OpenAI-compatible client + per-provider quirks
├── Completion Engine    — inline ghost text
├── RAG Engine           — background indexer + retrieval
├── MCP Client           — external tool servers
└── Storage              — SQLite (history, cache, vectors), SecretStorage (keys)
```

---

## 5. Core Features

### 5.1 AI Chat

Capabilities: general chat, explain, generate, debug, refactor, architecture discussion, docs generation, test generation, error explanation, performance optimization.

Requirements:
- Markdown rendering with syntax highlighting (Shiki, matching VS Code themes)
- Streaming responses (SSE), stop/continue/regenerate
- Code block actions: copy, insert at cursor, apply as diff to file
- Conversation history persisted per workspace (SQLite)
- **(added)** Token/context indicator; per-message model/provider label
- **(added)** Webview ↔ extension communication over a typed message protocol (single versioned schema shared between `vscode` and `webview-ui`)

### 5.2 Code Completion (ghost text)

Requirements: single-line, multi-line, function, import, class, comment completion. Tab accept, partial (word/line) accept, next/previous suggestion, auto + manual trigger.

**(added) Prompting strategy — the part most clones get wrong:**
- Use **FIM (fill-in-middle)** prompt format when the model supports it (per-model FIM templates: Qwen-coder, DeepSeek-coder, StarCoder, Codestral, CodeLlama). Maintain a model→template registry; user-overridable.
- Fall back to chat-based completion with strict stop sequences for models without FIM.
- Context: prefix/suffix around cursor + snippets from recently edited/open files, trimmed to a fixed token budget.

**(added) Performance reality check:** the PDF's "<150 ms" is only achievable with local/edge models. Targets:
- Debounce 150–300 ms (configurable); cancel in-flight request on keystroke.
- Local models (Ollama/LM Studio): time-to-first-token p50 < 200 ms.
- Cloud: p50 < 600 ms; show nothing rather than stale suggestions.
- Cache: exact-prefix reuse of the previous suggestion while the user types through it.

### 5.3 Inline Edit (Ctrl+I / Cmd+I)

Flow: select code → prompt input appears → LLM generates edit → **native VS Code diff** shown → accept/reject (also per-hunk when multi-hunk).

**(added) Edit application format:** the model is instructed to return full replacement for the selected range (v1). For whole-file edits use *search/replace blocks* with fuzzy matching (whitespace-tolerant, then Levenshtein-nearest-anchor) — unified diffs from LLMs are too brittle to `patch` directly.

### 5.4 Agent Mode

Loop: understand task → search workspace → read files → plan → modify files → run tests → fix failures → finish.

Capabilities: read/search/edit/create/delete/rename files, execute terminal commands, run tests, read diagnostics, observe outputs, iterate.

**(added) Tool-calling compatibility:** many OpenAI-compatible endpoints/models lack native function calling. The agent engine supports two dispatch modes with automatic detection + manual override:
1. **Native tool calls** (OpenAI `tools` schema) when supported.
2. **Structured-text fallback**: XML-tagged tool blocks parsed from the response (ReAct-style), with a repair re-prompt on malformed output.

**(added) Safety & recoverability:**
- Every agent session snapshots changed files (shadow checkpoint dir or `git stash create`-style object) → one-click **revert all**.
- All file ops are workspace-root-jailed (no `..` escape, symlink-resolved).
- Terminal commands go through the permission system (§10).
- Hard caps: max iterations, max tokens per session, max file size read — all configurable.

### 5.5 Multi-file Editing

Examples: JS→TS conversion, renames, add logging, upgrade React, fix lint errors.
Requirements: diff preview per file, batch accept/reject, per-file accept/reject, undo support (single undo step via `WorkspaceEdit`).

### 5.6 Workspace Understanding

Index files, symbols, imports, classes, functions, variables, dependencies (Tree-sitter via **web-tree-sitter WASM** — native node modules break across VS Code Electron versions).
Answers: "Where is authentication?", "Where is login implemented?", "Show payment flow."

### 5.7 Terminal Integration

Supported tools: npm, yarn, pnpm, cargo, python, pip, poetry, docker, git, make.
Always ask before execution (see §10). Show stdout, stderr, exit code. **(added)** Timeout + kill support; output truncated to a token budget with head+tail preserved.

### 5.8 Git Integration

Status, diff, blame, commit-message generation, branch info, review changes, explain commits, PR review. **(added)** Use VS Code's built-in git extension API where possible; shell out for the rest.

### 5.9 Prompt Library

Built-in: Explain, Optimize, Review, Fix, Test, Docs, Refactor. User prompts: save/edit/delete/share (export/import JSON). **(added)** Prompts support variables: `{selection}`, `{file}`, `{diagnostics}`, `{diff}`.

---

## 6. Context Collection & Token Budgeting

Automatically collect: current file, open files, selected text, cursor position, diagnostics, git diff, workspace structure, recent edits, terminal output, README, package files, dependency graph.

**(added)** A **Context Manager** assembles each request under an explicit token budget derived from the model's context window (user-configurable per model, sane default 8k when unknown):
- Priority order: system prompt > user message > selection > current file (windowed around cursor) > diagnostics > retrieved RAG chunks > open files > workspace map.
- Deterministic truncation, never silent mid-item cuts; each dropped source is logged.
- Token counting: heuristic (chars/4) with per-model correction factor — exact tokenizers per model are not feasible provider-agnostically.

## 7. Tool System

- **File:** read, write, append, delete, rename, move, copy
- **Directory:** list, create, delete
- **Search:** ripgrep (bundled via `@vscode/ripgrep`), regex, semantic (RAG), symbol
- **Git:** status, diff, commit, checkout, branch, log
- **Terminal:** execute, kill, stream output
- **IDE:** diagnostics, hover, references, rename symbol, format document

**(added)** Every tool declares: JSON schema, permission class (read / write / execute / destructive), and a human-readable "what will happen" summary used in the approval UI.

## 8. MCP Support (v2.0)

Transports: stdio, HTTP, SSE (use the official `@modelcontextprotocol/sdk`). Users register custom servers in settings/JSON config. MCP tools appear in the agent's tool list under the same permission system.

## 9. Provider System

```ts
interface Provider {
  chat(req): Promise<ChatResponse>
  streamChat(req): AsyncIterable<ChatChunk>
  completion(req): Promise<CompletionResponse>   // FIM when available
  embeddings(req): Promise<EmbeddingResponse>
  listModels(): Promise<ModelInfo[]>
  capabilities(): ProviderCapabilities            // (added)
  cancel(requestId): void
}
```

**(added)** `ProviderCapabilities` — detected once and cached, overridable by the user: `{ nativeToolCalls, fim, embeddings, vision, maxContext, parallelToolCalls }`. This drives agent dispatch mode, completion strategy, and RAG availability per provider.

**(added)** One `OpenAICompatibleProvider` base class + thin subclasses for quirks (Azure URL/auth scheme, Ollama's `/api` endpoints + keep-alive, Groq rate-limit headers, OpenRouter headers). Retries with exponential backoff on 429/5xx; clear surfaced errors (auth, model-not-found, context-overflow) — never silent failures.

Configuration per provider profile: base URL, API key, model, headers, timeout, temperature, max tokens. **Multiple named profiles** with quick switch (status bar), and separate model selections for **chat / completion / embeddings** roles.

**(added) Secrets:** API keys are stored in VS Code `SecretStorage` (OS keychain), never in `settings.json`. Settings hold only a reference to the profile name.

## 10. Security & Permissions

Never execute without permission. Protected operations: delete files, git push, git commit, install packages, shell execution, network requests.

Permission modes per operation class: **Ask Every Time / Allow This Session / Always Allow**, plus a global **Safe Mode** that forces Ask-Every-Time. Decisions persisted per workspace. Approval UI shows exact command / file paths / diff before running.

**(added) Webview security:** strict CSP, `localResourceRoots` only, nonce'd scripts, no remote content, all webview→extension messages validated against the typed protocol.

## 11. RAG (v1.5)

- Chunking: Tree-sitter-aware (function/class boundaries), fallback to sliding window.
- Store: SQLite + **sqlite-vec** (ship prebuilt binaries; **fallback to pure-JS brute-force cosine over Float32Arrays if the native module fails to load** — fine up to ~50k chunks).
- Embeddings via the provider's OpenAI-compatible `/embeddings`; local default recommendation: `nomic-embed-text` on Ollama.
- Ignore: node_modules, dist, build, target, .git, coverage, vendor, out + `.gitignore` + `.heapcodeignore`.
- Incremental indexing keyed on file mtime+hash; background, throttled; embedding cache keyed by chunk hash.
- **Degrade gracefully:** if no embedding model configured, semantic search falls back to ripgrep + symbol index. RAG is an enhancement, never a dependency.

## 12. Memory (v2.0)

Workspace memory (`.heapcode/memory.md`, human-editable): coding style, architecture, framework preferences, ignore folders, naming conventions. Also honor `HEAPCODE.md` at repo root as project instructions. Global memory optional.

## 13. Slash Commands & Mentions

Slash: `/explain /fix /refactor /review /test /docs /search /git /terminal /new /optimize`
Mentions: `@workspace @file @folder @terminal @git @diff @clipboard @selection @docs @problems`
**(added)** Mentions resolve through the Context Manager with the same token budgeting.

## 14. Commands (palette)

Heap Code Chat, Heap Code Agent, Explain, Fix, Refactor, Optimize, Generate Tests, Generate Docs, Review Code, Rename, Summarize, Commit Message, Toggle Completion.

## 15. Settings

- **General:** provider profile, base URL, API key (→ SecretStorage), model
- **Generation:** temperature, max tokens, top-p
- **Completion:** enable, delay, trigger mode, model role override
- **Agent:** enable, auto-approvals, safe mode, max iterations
- **RAG:** auto-index, embedding model
- **UI:** theme (inherit VS Code), font size, streaming

## 16. UI Components

- **Sidebar (webview):** chat, history, prompt library, agent task view (live plan/steps/tool calls)
- **Editor:** inline completion, code actions, hover actions, inline-edit input
- **Status bar:** provider, model, token usage, completion toggle
- **Output panel:** logs (leveled), agent execution trace
- **Settings UI:** native VS Code settings + webview panel for profiles/prompts

## 17. Tech Stack

TypeScript (strict), pnpm workspaces + monorepo, `esbuild` for the extension bundle, React + Vite for webview UI, web-tree-sitter (WASM), `@vscode/ripgrep`, SQLite (`better-sqlite3` or `node:sqlite`) + sqlite-vec, official MCP SDK, `@vscode/test-electron` + vitest for tests. Communication: HTTP + SSE.

**(added) Engineering baseline:** ESLint + Prettier, CI (GitHub Actions: lint, typecheck, unit tests, extension test, package `.vsix`), changesets or conventional commits for versioning, MIT or Apache-2.0 license (decide before publishing).

## 18. Testing Strategy (added)

- **Unit (vitest, `core`):** provider request building, FIM templates, tool-call parsing (native + fallback), context budgeting, search/replace fuzzy matcher, permission engine.
- **Mock provider:** an in-repo OpenAI-compatible fake server (records requests, replays fixtures) — all integration tests run offline and deterministic.
- **Extension tests (`@vscode/test-electron`):** activation, commands registered, completion provider wired, webview loads.
- **Manual test matrix per release:** Ollama (local), OpenRouter (cloud), LM Studio — one smoke run each for chat, completion, inline edit.

## 19. Performance Requirements

- Chat first token < 2 s (network dependent)
- Completion: see §5.2 targets; debounce + cancellation mandatory
- Indexing: background, incremental, < 60 s for medium projects (~5k files)
- Extension activation < 500 ms (lazy-load everything heavy; activate on view/command, not `*`)
- Memory: lazy loading, cache eviction; streaming + cancellation required everywhere

## 20. Telemetry & Privacy (added)

No telemetry in v1. If ever added: opt-in only, anonymous, documented. Code content never leaves the machine except to the user-configured LLM endpoint. State this prominently in the README — it's the product's core trust promise.

## 21. Roadmap

- **v0.1 (added — walking skeleton):** extension activates, one provider profile, streaming chat in sidebar. Publishable to a test audience.
- **v1.0:** chat, completion, inline edits, provider system (all listed providers), streaming, git integration, prompt library, settings, permissions.
- **v1.5:** agent mode, multi-file edits, terminal integration, RAG, workspace indexing.
- **v2.0:** MCP, memory, documentation search, image understanding (vision-capable models), voice commands.
- **v3.0:** team collaboration, cloud sync, shared prompts, AI PR reviews, distributed agents; JetBrains port begins (core is already IDE-agnostic).

## 22. Success Metrics

- First response latency < 2 s
- Completion acceptance rate > 35 %
- Crash-free sessions > 99 %
- Indexing < 60 s for medium projects
- Multi-provider compatibility across all supported OpenAI-compatible APIs
- Zero destructive actions without explicit user approval
- **(added)** Extension activation < 500 ms; works fully offline with Ollama

## 23. Future Ideas

Browser automation, mobile companion, AI code-review pipelines, visual architecture diagrams, local fine-tuned models, plugin marketplace, custom agent workflows, multi-agent collaboration, voice-driven development, project health dashboards.
