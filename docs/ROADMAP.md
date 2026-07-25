# Heap Code — Roadmap / Open Investigations

Local-only notes for things worth revisiting later. Not gitignored content of substance — just a parking lot so open threads don't get lost. See also `docs/PRD.md`.

---

## MCP: use VS Code's native MCP support instead of our own client?

**Status:** Open — needs an empirical test, not just docs reading.

Heap Code currently runs its own MCP client (`packages/vscode/src/agent/mcp.ts`) — connects to servers configured via `heapcode.mcpServers` (stdio/SSE/HTTP transports via `@modelcontextprotocol/sdk` directly), independent of VS Code's own MCP support.

Separately, `packages/vscode/src/agent/lmTools.ts` already bridges VS Code's shared `vscode.lm.tools` registry (tools contributed via `contributes.languageModelTools`) into the agent, gated through the same permission system as everything else.

**The question:** does VS Code's *native* MCP support (`.vscode/mcp.json`, "MCP: Add Server", servers the user configures centrally) also surface through `vscode.lm.tools` — the same registry `lmTools.ts` already reads? If so, we might not need our own MCP client at all; we'd just extend the existing bridge.

**What we found (docs search, not yet verified empirically):** genuinely unclear. VS Code's native MCP support is built primarily for GitHub Copilot Chat's own agent mode. There's a community extension ("VS Code LM Tools → MCP Bridge") that goes the *opposite* direction — exposing `vscode.lm.tools` outward as an MCP server for other clients — which suggests the reverse path (VS Code's own MCP-managed servers flowing into `vscode.lm.tools` for arbitrary third-party extensions) isn't a well-established, documented pattern. Could be wrong/stale — worth an actual test, not just search results.

**Next step:** in the Extension Development Host, configure a test server in `.vscode/mcp.json`, then check whether `vscode.lm.tools` (already read by `getLmToolDefinitions()` in `lmTools.ts`) picks it up.

**If it works:** `agent/mcp.ts`, the `heapcode.mcpServers` setting, and `heapcode.addMcpServer` command could potentially be retired in favor of users configuring MCP servers the standard VS Code way, with Heap Code consuming them through the existing `lmTools.ts` bridge — one less thing to maintain, and consistent with how any other VS Code MCP-aware tool behaves.

**If it doesn't:** keep the current custom client — it works today and there's no free replacement.
