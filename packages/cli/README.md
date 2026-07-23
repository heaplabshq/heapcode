# @heapcode/cli

The terminal adapter over `@heapcode/core` — same model-agnostic, local-first agent engine as the VS Code extension, no editor required. Status: CLI-M0 (walking skeleton) — chat only, no agent tools yet. See [`docs/CLI_PLAN.md`](../../docs/CLI_PLAN.md) for the full roadmap.

## Development

```bash
pnpm install
pnpm --filter @heapcode/cli build
node packages/cli/dist/cli.js --help
```

Or `pnpm --filter @heapcode/cli dev` to build and run in one step.

## Usage

```bash
heapcode profile add              # configure a provider (Ollama, OpenAI, OpenRouter, ...)
heapcode profile list
heapcode profile use NAME

heapcode                          # interactive chat in the current directory
heapcode --new                    # start a new conversation instead of continuing the last one
heapcode -p "message" [--json]    # headless: one message in, one reply out, no TTY required
```

## Storage

- `~/.heapcode/config.json` — provider profiles, active profile (override the directory via `HEAPCODE_HOME`)
- `~/.heapcode/secrets.json` — API keys, `chmod 600`, never an OS keychain (see `docs/CLI_PLAN.md`'s decisions log — must work headless/CI with no keychain available)
- `<project>/.heapcode/conversations.json` — chat history, per project

## Testing

`pnpm test` from the repo root runs `packages/cli/test/**` alongside every other package (shared `vitest.config.ts`, shared mock provider fixture in `packages/core/test/mockServer.ts`).
