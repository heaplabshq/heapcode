# Changelog

## 0.2.0

- **PR review** — `/pr-review` reviews the current branch's pull request and, only after you confirm, posts a real GitHub review with line-anchored inline comments and one-click suggestions. Large PRs are reviewed per file rather than truncated, so nothing goes unreviewed silently; anything that couldn't be reviewed is reported as unreviewed rather than passed over as clean. `/pr-review deep` adds an independent verification pass that re-reads the code and drops false positives before you see them. Uses your existing `gh auth login` session — no separate token to configure. The review engine is shared with the VS Code extension, so both give the same review
- **Security:** `fetch_url` can no longer reach private, loopback, or link-local addresses — including cloud metadata endpoints (`169.254.169.254`), which hand out IAM credentials. This matters because the agent reads web pages and MCP output, and text in those can steer it; redirects are now re-checked at every hop, so a public URL can't bounce into your internal network. Connections to your own model endpoint are unaffected — running Ollama or LM Studio on localhost or a LAN box works exactly as before
- **Fixed:** a command that hit the timeout, or that you stopped with Esc, was reported as killed while it kept running. Only the wrapper shell was being killed, so the real process survived — a dev server would hold its port, and because it also held the output pipe, the agent stayed blocked until that process exited on its own rather than for the length of the timeout. The whole process tree is now terminated
- Multi-line composer input — Option/Shift+Enter inserts a newline instead of submitting

## 0.1.0

- First release of the standalone `heapcode` CLI: agent mode with tools, permission prompts, and shadow-git checkpoints; semantic search (RAG) and repo map; MCP servers; personas, memory, Skills, prompt commands, and `@file`/`@folder`/`@workspace` mentions; opt-in sub-agent delegation; and a headless `-p` mode with `--json` output for CI
