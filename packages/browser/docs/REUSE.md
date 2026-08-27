# Cross-product reuse — what heapbrowse should import, and what to extract

Written 2026-08-27, from a read of `heapcode`, `heapchat`, `heapkit`, `heapedit`, `heaplabs-telemetry`. Updates and partially supersedes the July extraction audit (`extraction-audit.md`, kept outside this repo at `~/Documents/github/`, dated 2026-07-26), which predates `packages/host`.

---

## 1. The headline

**You do not need to build a new agent for heapbrowse. You need to build a new tool belt.**

`heapcode/packages/core/src/agent/loop.ts` (937 lines) is already host-agnostic by construction. It takes tools as data and execution as a callback:

```ts
// packages/core/src/agent/loop.ts
tools: ToolDefinition[];
execute(call: ToolCall): Promise<ToolResult>;
requestPermission(call, tool): Promise<boolean>;
events: AgentEvents;
```

Nothing in it knows what a file is. Its own comment says it: *"The host decides whether/how to persist it; core never writes files."* Swap `read_file`/`edit_file` for `read_page`/`click` and the loop is heapbrowse's loop — including plan mode, compaction, streaming, sub-agents, the untrusted-content wrapper, structural `finish` termination, and the verification gate.

Verified reusable as-is (zero Node imports, browser-safe):

| Module | Lines | What heapbrowse gets |
|---|---|---|
| `agent/loop.ts` | 937 | The entire agent loop |
| `agent/tools.ts` | 74 | `ToolDefinition`, `PermissionClass`, `wrapUntrusted`, `FINISH_TOOL` |
| `agent/textProtocol.ts` | 177 | Tool-call fallback for endpoints without native function calling |
| `agent/permissionModes.ts` | 118 | `resolvePermission`, mode semantics |
| `agent/permissions.ts` | 162 | Permission engine |
| `agent/personas.ts` | 134 | Capability ceilings |
| `agent/prompts.ts`, `subAgent.ts`, `askUser.ts` | 382 | Prompts, delegation, user questions |
| `providers/*` (minus nothing) | ~1,180 | OpenAI-compatible client, SSE, retry/backoff, error taxonomy, 11 presets, Azure |
| `context/tokens.ts`, `contextManager.ts` | 81 | Token estimation, compaction thresholds |
| `edit/*`, `rag/repoMap.ts` (partial) | — | Budgeted ranked truncation — see §3 |

That's **~3,200 lines of hardened, tested agent infrastructure** heapbrowse should not write. Realistically it turns a 3-month build into a 3–4 week one, and the part that's left — DOM extraction, browser actions, MV3 plumbing, permission UI — is the part that's genuinely new.

---

## 2. The one blocker: the barrel export

`packages/core/src/index.ts` re-exports **everything**, including:

```
export * from './node/fs.js';        // node:fs/promises, node:path
export * from './server/index.js';   // node:net, node:crypto, node:child_process
export * from './review/prReview.js';// node:child_process
export * from './net/safeFetch.js';  // node:net, node:dns/promises
export * from './agent/workspaceTools.js'; // node:child_process
```

and `packages/core/package.json` does **not** set `"sideEffects": false`.

So `import { runAgent } from '@heapcode/core'` inside an MV3 service worker or side panel pulls `node:child_process` into the bundle and fails to build. This is the single thing standing between heapbrowse and a week-one skeleton.

**The precedent for the fix is already in the file.** Two subpath exports exist — `./modelFilter` and `./permissionModes` — added exactly because someone needed a leaf without the barrel. Scale that up:

```jsonc
// packages/core/package.json
{
  "sideEffects": false,
  "exports": {
    ".":         "./src/index.ts",        // unchanged — Node hosts keep working
    "./agent":   "./src/agent/index.ts",  // NEW: loop, tools, permissions, prompts — browser-safe
    "./providers":"./src/providers/index.ts", // NEW: browser-safe
    "./context": "./src/context/index.ts",
    "./node":    "./src/node/index.ts"    // NEW: explicit home for Node-only surface
  }
}
```

Then add a `no-restricted-imports` rule mirroring the existing core-must-not-import-`vscode` guardrail (`heapcode/eslint.config.mjs:13-20`): **`core/src/agent/**` and `core/src/providers/**` may not import `node:*`.** That's what keeps this true in six months, and it's the same guardrail discipline `heapcode/docs/PLAN.md` already uses.

**Cost: half a day. No refactor, no behaviour change.** Do this before heapbrowse M0.

---

## 3. The parallel worth noticing: repo map ≡ page map

heapcode's hardest solved problem is *"compress a structure far too large for the context window into a ranked, budget-truncated, AI-legible text map."* That's `formatRepoMap(entries, {pathPrefix, budgetChars, rank})` plus `rankByCentrality`.

heapbrowse's hardest problem is **the same problem** with different inputs:

| | repo map | page map |
|---|---|---|
| Units | files, symbols | text blocks, controls, tables |
| Ranking signal | import-graph centrality, open/recent files | viewport proximity, landmark role, intent match |
| Budget | chars → tokens | chars → tokens |
| Output | ranked, truncated text map | ranked, truncated text map |

The ranking *signal* is domain-specific; the **budgeted rank-ordered truncation is not**. Extract `formatMap(entries, {rank, budgetChars})` as a shared primitive and both products feed it their own scorer. Small — maybe 80 lines — but it's the piece that decides whether a 500KB page costs 2k tokens or 40k, and getting it right once is worth more than getting it approximately right twice.

---

## 4. What the survey actually found across all products

### 4.1 Real duplication that already exists (fix this before it becomes three copies)

**(a) The provider layer exists twice, at very different maturity.**

- `heapcode/packages/core/src/providers/` — 1,180 lines TS: SSE parsing, retry/backoff honouring `Retry-After`, error taxonomy, Azure, 11 presets, model filtering.
- `heapchat/src/llm/openai-compat.js` — 97 lines CJS: `completeJSON`, `completeText`, `streamChatTurn`, `completeWithTools`.

Two independent implementations of the same protocol. heapchat's is thinner and lacks the retry/error handling that took heapcode real production time to earn. heapbrowse would be the **third**. Guardrail 6 in `PLAN.md` exists to stop that.

**(b) `packages/host` was built but VS Code never adopted it.**

`packages/host` (created after the July audit) consolidates `workspaceTools`, `checkpoint`, `shadowGit`, `permissions`, `skills`, `repoMapIndexer`, `agentSession`. The CLI uses it — 7 files import `@heapcode/host`. **VS Code imports it zero times** and still carries its own copies:

| Module | `host/` | `vscode/` |
|---|---|---|
| `agent/workspaceTools.ts` | 625 | **960** |
| `agent/checkpoint.ts` | ✓ | ✓ (dup) |
| `agent/shadowGit.ts` | ✓ | ✓ (dup) |
| `agent/permissions.ts` | ✓ | ✓ (dup) |
| `agent/skills.ts` | ✓ | ✓ (dup) |
| `rag/repoMapIndexer.ts` | ✓ | ✓ (dup) |

That is ~2,000 lines of live drift, and it's the highest-value cleanup in the portfolio — but note it does **not** block heapbrowse, which needs none of it.

**(c) The chat UI exists twice, and has already diverged in a way that matters.**

`webview-ui/src/App.tsx` is **1,890 lines with zero component extraction**. `web-ui/` is 1,041 lines plus 19 extracted components (`MessageList`, `Composer`, `ToolChip`, `ContextMeter`, `ModelPicker`, `Settings`, `DiffView`, `WorkingIndicator`…).

Both have a `markdown.ts`. They are **not** the same file:

```
webview-ui: DOMPurify.sanitize(html)                    // defaults
web-ui:     DOMPurify.sanitize(html, {
              FORBID_TAGS: ['form','iframe','object','embed','style','script'],
              FORBID_ATTR: ['style','srcdoc','formaction'], ... })
```

`web-ui`'s version is hardened and carries a comment explaining that model output is untrusted and executes with the page's privileges. `webview-ui`'s does not have that hardening. **A security fix landed in one copy and not the other** — which is the concrete argument for extraction, better than any abstract one.

heapbrowse needs a chat UI. It should be the third consumer of an extracted `@heaplabs/chat-ui`, not the third copy.

### 4.2 Already shared correctly — copy this pattern

`heaplabs-telemetry` is the model: one Cloudflare Worker + D1, apps register a name in `KNOWN_APPS` and start sending. Anonymous counts only, per-app opt-out owned by the app. heapbrowse joins by adding one string (PLAN M7). Nothing to build.

### 4.3 Not reusable, and that's fine

- **heapchat** — CommonJS, no unit tests, `src/agent/core.js` is 1,633 lines with 32 `require`s spanning auth, user stores, face detection, ComfyUI, EXIF. The July audit's verdict holds: nothing here is extractable in its current shape. Its *ideas* (provider routing, memory, skills) are worth reading; its code is not worth lifting.
- **heapedit** (React/zustand image editor), **heapkit** (static tool site), **portfolio-os**, **pin-folder** — different domains, no agent surface. No overlap beyond telemetry and eventually design tokens.

---

## 5. Recommended sequencing

The temptation is a big-bang `@heaplabs/*` extraction before starting heapbrowse. Don't. Extraction ahead of a second real consumer produces APIs shaped by imagination. **heapbrowse is the forcing function that reveals the true seam** — so let it pull.

**Phase 0 — before heapbrowse M0 (½ day).** Add subpath exports + `sideEffects: false` + the `no-node-import-in-agent-core` lint rule (§2). No code moves. **heapbrowse starts life inside the heapcode workspace** (`packages/browser`), because `@heapcode/core` is source-only (`exports` → `src/index.ts`, no build, no `dist`), is `private: true`, and depends on `@heapcode/repomap` via `workspace:*` — which resolves only inside a pnpm workspace. A git dependency or `npm install` from GitHub fails on all three. Publishing properly is Phase 2 work, not Phase 0 work.

**Phase 1 — heapbrowse M0–M2.** Import the leaves. Build `BrowserToolExecutor` (the analogue of `WorkspaceToolExecutor`) and the page snapshotter. Change nothing in heapcode except bug fixes found by the second consumer — and expect a few; a second host always finds them.

**Phase 2 — after heapbrowse M2 proves the seam (2–3 days).** Promote the actually-shared set into `@heaplabs/agent-core` + `@heaplabs/providers` under the `heaplabshq` org. By then the boundary is evidence, not a guess: whatever both products imported is the package, and nothing else is.

**Phase 3 — independent of heapbrowse.** Close the `packages/host` ↔ `vscode/` drift (§4.1b), then extract `@heaplabs/chat-ui` from `web-ui`'s already-componentised version — with the hardened `markdown.ts` as the one true copy, and `webview-ui` + heapbrowse migrated onto it.

**Naming.** `@heapkit/*` is reserved for the tools site; `@heaplabs/heapcode-cli` is already published on npm. Use `@heaplabs/agent-core`, `@heaplabs/providers`, `@heaplabs/chat-ui`.

---

## 6. Target shape

```
@heaplabs/providers    ── OpenAI-compatible, SSE, retry, presets, Azure     [browser-safe]
@heaplabs/agent-core   ── loop, tools, permissions, personas, prompts,
                          textProtocol, context/compaction, budgeted maps   [browser-safe]
@heaplabs/chat-ui      ── React: MessageList, Composer, ToolChip, Settings,
                          ContextMeter, hardened markdown, theme tokens
        │
        ├── heapcode/host      ── fs, workspaceTools, checkpoint, shadowGit  [Node only]
        │      ├── heapcode-cli
        │      ├── heapcode-vscode        ← still needs to adopt host (§4.1b)
        │      └── heapcode-web
        │
        └── heapbrowse/browser ── snapshotter, BrowserToolExecutor,
                                  origin policy, MV3 plumbing              [browser only]
```

heapbrowse writes only the bottom-right box. Everything above it already exists and is already tested.
