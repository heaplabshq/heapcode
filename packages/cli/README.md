# @heaplabs/heapcode-cli

**Model-agnostic AI coding agent for your terminal.** Chat, autonomous agent mode, semantic codebase search, and MCP — with any OpenAI-compatible API, local or cloud. Same engine as the Heap Code VS Code extension ([`@heapcode/core`](../core)), no editor required.

## Privacy first

Your code never leaves your machine except to the model endpoint **you** configure — no proprietary backend, no account. Point it at Ollama on your LAN and your code stays home.

A local, capped usage log (`~/.heapcode/audit.json`, event names + coarse metadata only — never code, prompts, or file contents/paths) is kept for your own reference (`heapcode audit`). Nothing is sent anywhere; there's no remote telemetry to opt out of. Skip even the local entry for a single run with `--no-telemetry`.

## Works with

| Local | Cloud |
|---|---|
| Ollama, LM Studio, vLLM, LocalAI | OpenAI, Azure OpenAI, OpenRouter, Groq, Together AI, NVIDIA NIM |

…plus any custom OpenAI-spec endpoint. Providers are named profiles, each with its own model roles (chat / agent / embeddings / rerank) — switch anytime with `/profile` or `--profile NAME`.

## Install

```bash
npm install -g @heaplabs/heapcode-cli
heapcode
```

Or, as a convenience wrapper around the same `npm install -g` (not a separate packaging mechanism — reads it directly from this repo, and never uses `sudo`):

```bash
curl -fsSL https://raw.githubusercontent.com/heaplabshq/heapcode/main/packages/cli/install.sh | sh
```

The first run walks you through adding a provider profile — no separate setup command needed.

Building from source instead:

```bash
pnpm install
pnpm --filter @heaplabs/heapcode-cli build
node packages/cli/dist/cli.js
```

## Quick start

```bash
heapcode                          # interactive agent session in the current directory
heapcode --continue                # continue this directory's most recent conversation
heapcode -p "add error handling to src/api.ts"   # headless: one task in, full agent loop, no TTY
```

Recommended local models: chat/agent `llama3.1:8b`+ · embeddings `nomic-embed-text` (enables semantic search).

## Features

- **Agent mode** — reads, searches, edits files and runs commands to complete tasks autonomously; every non-read action goes through a permission prompt (Allow Once / Session / Always, `--safe-mode` to ask every time); `/revert` restores every file the session touched, `/rewind [n]`/`/checkpoints` step back through individual tool calls — all backed by a shadow git history, independent of your repo's own git state
- **Personas** — `agent` (default), `architect` (read-only), `debug` (no edits), `reviewer` — scopes which tools are offered
- **Project memory** — `.heapcode/HEAPCODE.md` + `.heapcode/memory.md` load into every session automatically (falls back to `AGENTS.md`); path-scoped rules via `.heapcode/instructions/*.md`
- **Skills** — model-invoked capabilities from `.claude/skills/<name>/SKILL.md` (project) or `~/.claude/skills/<name>/SKILL.md` (personal) — the same convention Claude Code uses
- **Semantic search (RAG)** — background index over your embeddings model, hybrid keyword + vector search; powers `@workspace` mentions and `/search`; degrades to plain text search with no embedder configured
- **MCP** — register Model Context Protocol servers (stdio / HTTP / SSE) in `~/.heapcode/config.json` or a project's `.heapcode/mcp.json`; their tools go through the same permission system as everything else
- **Sub-agent delegation** — the agent can hand off a self-contained sub-task to a fresh-context sub-agent (`/subagents on`, or `--sub-agents` headlessly); off by default
- **PR review** — `/pr-review` reviews the current branch's pull request per-file (never a blind truncation), then posts a real GitHub review with line-anchored inline comments and one-click suggestions; `/pr-review deep` adds an independent verification pass that drops false positives first. Uses your existing `gh auth login` session, and always shows the full review for confirmation before anything is posted. Shared with the VS Code extension, so both give the same review
- **Headless / CI mode** — `-p "<task>"` runs the complete agent loop with no TTY: plain text or `--json` (newline-delimited events), four permission modes for unattended runs, non-zero exit on failure
- **Slash commands & mentions** — `/` autocomplete menu, prompt templates (`/explain /fix /refactor /review /security-review /test /docs /optimize`), `@file`/`@folder`/`@workspace` context mentions

## Usage

```
heapcode                          Start an interactive agent session (fresh conversation) in the current directory
heapcode --continue | -c          Continue this directory's most recent conversation (in-session: /resume picks any)
heapcode --resume <id>            Continue a specific past conversation by id or unambiguous prefix
heapcode --profile NAME           Use a specific provider profile for this session
heapcode --safe-mode              Ask for permission on every action, even ones with a persisted "Always allow" grant
heapcode --no-update-check        Skip the startup check against npm for a newer published version
heapcode -p "<task>" [flags]      Headless: runs the full agent loop (tools, RAG, MCP) with no TTY required

heapcode profile <add|list|use|remove>   Scriptable profile management (also available in-session via /profile)
heapcode audit                            Local usage/audit dashboard
```

### Headless (`-p`) flags

| Flag | Effect |
|---|---|
| `--json` | Stream newline-delimited JSON events (`tool_call`, `tool_result`, `text_delta`, `plan`, `result`) instead of plain text |
| `--verify "<command>"` | Run the project's own checks once the agent is done; on failure, feed the output back and let it fix its own work ([below](#--verify--self-checking-runs)) |
| `--verify-max <n>` | Cap how many times the verify command runs — so at most `n - 1` fix turns (default 3) |
| `--diff` | Include the run's unified diff in the result (the changed-file summary is always included) |
| `--persona NAME` | `agent` (default), `architect`, `debug`, `reviewer` |
| `--permission-mode MODE` | `plan` \| `default` \| `auto-edit` \| `full-auto` — see below; default `default` |
| `--sub-agents` | Let `delegate_task` actually run |
| `--reindex` | Rebuild the semantic search + repo map indexes before running (headless never auto-indexes) |
| `--continue` / `-c` | Continue this directory's most recent conversation |
| `--resume <id>` | Continue a specific conversation by id or unambiguous prefix |
| `--no-telemetry` | Skip the local audit-log entry for this run |

#### What every run reports

Every `-p` run says what it changed, so a caller — a script, or another agent supervising this one — can review the work without reopening each file:

- `--json`: the existing `result` event gains `filesChanged` (always) and `diff` (with `--diff`). Existing fields are untouched, in the same order, so anything already parsing this stream keeps working.

  ```json
  {"type":"result","outcome":"done","response":"Added retries.","model":"…","profile":"…","sessionId":"…",
   "filesChanged":[{"path":"src/client.ts","status":"modified","insertions":18,"deletions":2}]}
  ```

- plain text: the response, then a table (and the diff, with `--diff`):

  ```
  Changes: 1 file, +18 -2
    src/client.ts | +18 | -2 | modified
  ```

`status` is `added`, `modified`, or `deleted`; a binary file reports as changed with zero line counts. The summary comes from the same shadow-git history that backs `/rewind` and `/checkpoints`, so it covers everything the run touched — including files a `--verify` command reformatted.

#### `--verify` — self-checking runs

A model that never learns it failed the project's lint can't fix it; the caller pays for that round trip instead. `--verify` closes the loop:

```bash
heapcode -p "add retries to src/client.ts" --permission-mode auto-edit --verify "make check"
```

The command runs once the agent believes it's finished. If it fails, its output comes back to the agent as a new turn, the agent fixes the code, and the command runs again — up to `--verify-max` runs (default 3). The result reports whether it went green and after how many attempts, with the last failure output when it never did, and **the exit code is non-zero while the checks are still red**:

```json
"verify": {"command":"make check","passed":true,"cycles":2}
"verify": {"command":"make check","passed":false,"cycles":3,"lastFailureOutput":"E501 line too long (106 > 100)"}
```

`cycles: 0` means the command never ran because the agent run itself errored or was interrupted — nothing was checked.

**The command is yours, not the model's.** It's captured from your command line, parsed once, and spawned directly — no shell, ever. Nothing the model produces is interpolated into it, it isn't offered as a tool, and it can't be read, changed, or disabled from inside the run. That's what makes `--verify "make check"` safe to hand to a run whose permission mode denies `run_command` outright.

The no-shell rule is the load-bearing part, so it's enforced rather than assumed: `&&`, `|`, `;`, redirection and `$(…)` are rejected up front instead of being passed through as literal arguments. Put chains in a script or a make target and point `--verify` at that. Quoting works as you'd expect (`--verify "pytest -k 'not slow'"`), and a check that hangs is killed after 10 minutes.

Permission modes (headless has no one to prompt, so every mode resolves on its own):

| Mode | Behavior |
|---|---|
| `plan` | Read-only tools only — nothing offered that could mutate anything |
| `default` | Every tool is visible, but writes/commands are denied — the agent adapts or reports what it would need |
| `auto-edit` | File edits auto-approved; shell commands still denied |
| `full-auto` | Everything auto-approved — for CI automation that should finish the task unattended |

### In-session commands

Type `/` for the full autocomplete menu; highlights:

| Command | Effect |
|---|---|
| `/help` | Show available commands |
| `/model [id]` | Switch the model |
| `/profile [add\|list\|remove\|name]` | Switch, add, list, or remove provider profiles |
| `/persona [name]` | Switch persona |
| `/memory` | Show loaded project instructions & memory |
| `/skills` | List available Skills |
| `/search <query>` | Search the workspace (semantic if indexed, plain text otherwise) |
| `/index` | Rebuild the semantic search + repo map indexes |
| `/pr-review [deep]` | Review the current branch's PR and, on confirmation, post it to GitHub |
| `/mcp` | List configured MCP servers and their connection status |
| `/subagents [on\|off]` | Toggle sub-agent delegation |
| `/clear`, `/new` | Start a new conversation |
| `/resume` | Pick an earlier conversation to continue |
| `/rewind [n]` | Undo the last n tool-call checkpoints |
| `/revert` | Restore every file this session touched |
| `/checkpoints` | List recent checkpoints for this project |
| `/exit` | Quit (also: Ctrl+C twice) |

Keys: `Esc` interrupts the running agent · `Ctrl+C` clears typed input, twice exits · `Up`/`Down` recall input history (or move within a multi-line message, line by line) · `Tab` completes a slash command · `\` then `Enter` inserts a newline instead of submitting · pasting multi-line text keeps it as one message.

## Storage

```
~/.heapcode/config.json                                       Provider profiles, active profile, settings
~/.heapcode/secrets.json                                      API keys, chmod 600, never an OS keychain
~/.heapcode/audit.json                                        Local usage log
~/.heapcode/projects/<name>-<hash>/                            Per-project session state: conversations, permissions,
                                                                shadow-git checkpoint history, search index — never in
                                                                your repo, never at risk of being committed
<project>/.heapcode/{HEAPCODE.md, memory.md,
  instructions/*.md, mcp.json}                                 Per-project CONFIG — meant to live alongside your code,
                                                                safe to commit and share with a team
```

Override the config directory with the `HEAPCODE_HOME` environment variable.

A startup check against npm's own registry surfaces an available update as one dim line, never a blocking prompt — nothing else is contacted. Opt out with `--no-update-check` or `{ "updateCheckEnabled": false }` in `~/.heapcode/config.json`.

## Development

```bash
pnpm install
pnpm --filter @heaplabs/heapcode-cli build      # or: pnpm --filter @heaplabs/heapcode-cli dev  (build + run)
pnpm test                              # from the repo root — runs packages/cli/test alongside every other package
pnpm --filter @heaplabs/heapcode-cli typecheck
```

## License

[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — see [`LICENSE`](../../LICENSE) at the repository root.
