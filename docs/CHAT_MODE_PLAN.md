# Heap Chat mode — Build Plan

Source of truth for **bringing a second product, Heap Chat, onto the Heap Code
engine** — what we build, in what order, when it's done, and just as
importantly what we have decided *not* to build.

Companion docs: `docs/PLAN.md` (VS Code milestones), `docs/CLI_PLAN.md`,
`docs/heaplabs-roadmap.md` (cross-product phases), `../extraction-audit.md`
(the July 2026 heapcode/heapchat audit this plan supersedes in part).

---

## How to use this doc

1. **Read this whole file before starting any milestone.** The rejected
   options in "Decision" below are rejected for reasons that are not obvious
   from the code. Re-deriving them costs a day and usually ends in the wrong
   place.
2. **One milestone at a time.** Do not start C(n+1) before C(n)'s exit
   criteria are demonstrably met.
3. **New ideas go to the Backlog**, not into the current milestone.
4. **If a decision you need is not in the Decisions log, stop and ask.** Do
   not pick a default and proceed. The Open Decisions section lists the ones
   already known to be unresolved.
5. **Update checkboxes as work lands**, and append to the Decisions log
   whenever a real choice gets made. This file is the handoff between
   sessions; if it's stale, the next session drifts.

---

## The decision

**Heap Chat becomes a second product on the Heap Code engine, in this repo,
as a separate host and UI — not a mode flag inside Heap Code, and not a port
of the existing heapchat codebase.**

The mental model is Claude Code and the Claude app: shared engine, separate
products, separate surfaces. Heap Code remains the primary product and its
behavior must not change as a side effect of any work in this plan.

### Why not port `heapchat/`

A mechanical clone pass (`jscpd`, `--min-lines 10 --min-tokens 50`) over both
repos found **43 clone pairs and zero cross-repo pairs**. There is no
copy-paste lineage between the codebases — every apparent overlap is
convergent evolution:

| Concept | heapcode | heapchat |
|---|---|---|
| RAG retrieval | BM25 hybrid + LLM listwise rerank | cosine + MMR(λ=0.7) + keyword bonus |
| Chunking | AST-aware, symbol-boundary snapped | fixed 1200-char / 200 overlap |
| OpenAI-compatible client | hand-rolled over `fetch` | wraps the official `openai` SDK |
| MCP client | stdio / HTTP / SSE | StreamableHTTP session resumption |
| "Skills" | `SKILL.md` parsing | embedding-backed learned procedures |

So there is nothing to *merge*. Consolidation would be a rewrite either way,
and heapchat is the wrong thing to rewrite *from*: 16,325 lines of CommonJS
with **zero unit tests**, whose logic is welded into `server.js` (2,779
lines) and `src/agent/core.js` (1,633 lines, 38 requires spanning auth, user
stores, face detection, ComfyUI and EXIF).

heapchat has **no userbase** — it was built for personal use. That is what
makes this cheap: its 16k lines are not an asset to migrate, they are a spec
we already validated by living with it. Port the knowledge, delete the code
from the plan.

### Why not a persona / mode flag inside Heap Code

`packages/core/src/agent/personas.ts` already scopes which tools the agent is
offered, and it was the obvious first answer. It is the wrong one: a persona
filters the tool roster and leaves everything else standing — the workspace
panel (Changes, checkpoints, Terminal, Index), the "open a project folder"
framing, the coding system prompt, the settings vocabulary. The result is an
IDE with its coding tools greyed out, which is precisely the thing we do not
want to build.

### Why not keep two repos

Same license (PolyForm-NC-1.0), same org, and `packages/browser`
(heapbrowse) is already the working precedent: a different product for a
different audience, on its own domain, living in this repo on
`@heapcode/core`. This is the second instance of a decision that already
works, not a new bet.

---

## Guardrails

1. **`packages/web-host/src/session.ts` is not edited by this plan.** It is
   2,403 of web-host's 4,418 lines and it is the code path every Heap Code
   session runs through. If a milestone appears to require touching it, that
   is a signal to stop and re-scope, not to proceed carefully.
2. **Divergence starts at the session, not the UI.** Chat is a separate host
   with its own session and its own tool roster — two arrays, never one array
   behind a filter. A flag threaded through a shared session is how chat
   features end up executing during code sessions.
3. **Heavy dependencies stay in the leaf package.** `pdf-parse`, `mammoth`,
   image/media libraries and anything else chat-specific go in
   `packages/chat-host` or `packages/chat-ui`. Never in `core`, `host`, or
   `repomap` — `npm i -g @heaplabs/heapcode-cli` must not grow because of
   this work.
4. **Widen exports; do not extract.** `chat-host` imports the infra it needs
   from `@heapcode/web-host`. Adding exports is additive and changes no
   existing behavior. Extract a shared `web-kit` only if the dependency
   direction becomes genuinely embarrassing, and only as its own commit.
5. **Every feature works against a local model (Ollama)** before it is done.
   Same product promise as Heap Code.
6. **Tests land with the milestone.** heapchat's defining flaw was zero
   tests; importing that would defeat the point of moving.
7. **Extraction and deduplication are separate commits from behavior
   changes.** Carried over from `docs/heaplabs-roadmap.md`, and it applies
   with full force here.
8. **Scope changes edit this file first, then the code.**

---

## Explicit non-goals

These were in heapchat. They are **not** being rebuilt. Each was reviewed and
cut deliberately; do not treat any of them as an oversight.

- **Multi-user accounts and per-folder ACLs.** heapchat had admin/member
  roles with server-enforced grants. `web-host` is single-user by design —
  a per-launch token, and its own comment notes it runs shell commands as the
  invoking user. There is no account model to extend, this was the single
  largest item in the whole plan, and it would be built for one user.
- **Face detection and clustering, perceptual-hash duplicate finding, the
  geotagged photo map.** Genuinely nice, entirely unrelated to the AI, and
  the bulk of where heapchat's 16k lines went.
- **The masonry gallery, lightbox, and browse-as-a-board UI.** Same reason.
- **Knowledge graph** (entity graph over people/places/tags/documents).
- **Local image generation** (ComfyUI / Draw Things integration).
- **Background scheduler / digest jobs.**
- **Projects and custom agents** as separate hubs.

**The existing heapchat app keeps working and is not deleted.** Frozen is not
the same as gone: it still runs, and for the photo-centric features above,
running it is the answer. This plan governs where *new* work goes.

The `heaplabshq/heapchat` repo also **must not be archived** while
`electron/main.js` wires `electron-updater` to its GitHub releases —
archiving breaks auto-update for any installed build.

---

## Architecture: where the line falls

Sizing as of 2026-09-09.

**Shared, unchanged:**

- `packages/core` — providers, agent loop, tool-call protocol (incl. the
  text fallback for models without native function calling), MCP, context
  assembly and compaction, RAG primitives, vector store
- `packages/host` — config, secrets/keychain, history store
- `packages/repomap` — only its file-walk limits; the symbol extraction is
  code-specific and chat does not use it
- `packages/web-host` infra — `server.ts` (268), `static.ts` (129),
  `authLimit.ts` (101), `wsDuplex.ts` (85), `artifacts.ts` (175). ~758 lines
  of token auth, WebSocket plumbing and static serving that a chat host needs
  identically
- `packages/web-ui` neutral components — `Composer`, `MessageList`,
  `ToolChip`, `Palette`, `Settings`, `ModelPicker`, `ContextMeter`,
  `Sidebar`, `Preview`, `Cards`, the markdown renderer. Roughly 70% of it

**Separate, per product:**

| | Heap Code | Heap Chat |
|---|---|---|
| Session | `web-host/src/session.ts` (2,403 lines, untouched) | `chat-host/src/session.ts` (new) |
| Tool roster | 22 tools incl. `run_command`, `edit_file`, `repo_map` | small, read-only-ish roster |
| System prompt | coding | knowledge assistant |
| Workspace panel | Changes / Files / Index / Terminal / Preview | none |
| Code-specific UI | `DiffView`, `IndexView`, `WorkspacePicker`, `TaskBar` | not rendered |
| Index file policy | `CODE_EXTENSIONS` | document extensions |
| History store | per-workspace | separate store |
| Memory | project memory (`.heapcode/memory.md`) | personal memory (separate store) |

**Target layout:**

```
packages/web-host     Heap Code session. Unchanged; exports widened.
packages/chat-host    Heap Chat session (new)
packages/web-ui       Neutral components stay neutral; nothing code-specific added
packages/chat-ui      Heap Chat screens (new)
```

**Entry points.** `heapcode web` continues to land *directly* in code mode —
the primary use must not gain a click. The two-option screen is a switcher
inside the app, not a gate in front of it.

---

## Milestones

### C0 — Foundation: a chat host that is not a code editor

Goal: prove the whole pipe — separate host, separate session, shared engine,
neutral UI — with the smallest possible feature set.

- [x] `packages/chat-host` scaffolded; imports auth/WS/static/artifacts from
      `@heapcode/web-host` (widen its exports; do not move code)
- [x] `packages/chat-ui` scaffolded; renders `web-ui`'s neutral components,
      no workspace panel, no diff/index views
- [x] Chat session with a five-tool roster: `read_file`, `search`,
      `semantic_search`, `web_search`, `fetch_url` — plus `ask_user`, which is
      how a run talks back rather than a sixth capability, and without which
      `askToContinueAtLimit` and `chat/askUser` are both unreachable
- [x] Knowledge-assistant system prompt (own file, not a branch in the
      coding prompt)
- [x] Entry point (`heapcode chat` or equivalent route) that opens on a
      chosen folder rather than a project workspace
- [x] Shared provider connections and model role table — one keychain entry,
      one Ollama config, one settings screen (this is the single biggest
      ergonomic win of the plan; heapchat maintaining its own was pure
      friction)
- [x] Separate conversation history store
- [ ] Tests: session lifecycle, tool-roster scoping, that the code roster is
      not reachable from a chat session — **deferred to the end of the plan**
      at the user's instruction (2026-09-09), not skipped

**Exit criteria:** point it at `~/Documents`, ask a question about a `.md`
file in it, get a streamed answer citing that file — and
`git diff <branch point> -- packages/web-host/src/session.ts` is empty.

The baseline is the **branch point**, not `origin/main`: this branch was cut
from `feat/history-tool-result-retention`, which changes `session.ts` for
reasons that have nothing to do with Heap Chat. Diffing against `origin/main`
reports that inherited work and makes the guardrail look violated when it is
not.

### C1 — Document ingestion

Goal: the index stops being code-only. Also improves Heap Code, which
currently cannot index the docs already sitting in repos.

- [x] Extractor seam in the indexer. `packages/core/src/rag/indexer.ts`
      (~:333-339 as of 2026-09-09) already tests the extension, decodes bytes
      as UTF-8 and bails on a `\0` — the hook goes exactly there
- [x] Document extension set, separate from `CODE_EXTENSIONS`
      (`packages/repomap/src/indexer.ts:16`). Do not widen `CODE_EXTENSIONS`
      itself — Heap Code's index policy is deliberate
- [x] PDF, Word, CSV, plain text extractors, in `chat-host`, behind the seam
- [x] Chunking strategy for prose. The AST chunker is code-shaped; decide
      whether prose gets the line-window fallback or its own chunker, and
      record the choice
- [ ] Tests per extractor, incl. a malformed/encrypted file per type —
      **deferred with the rest of the testing to the end of the plan**

**Exit criteria:** ask a question whose answer is only in a PDF, get a cited
answer. `heapcode web` indexing behavior on a code repo is byte-identical to
before.

### C2 — Eval harness

Goal: a measurable baseline before touching answer quality. `extraction-audit.md`
calls heapchat's corpus "the one genuine benchmark-corpus seed in either
repo", already standalone and touching none of its untested code —
`docs/heaplabs-roadmap.md` already blessed picking it up independently.

- [ ] Port `heapchat/eval/golden.json` (12 cases) and
      `heapchat/eval/fixtures/` (7 documents) into this repo
- [ ] Runner over the chat host, asserting the corpus's existing
      `expect_contains` / `expect_not_contains` / `expect_grounded` /
      `expect_source` shapes
- [ ] Baseline numbers recorded in this file before C3 starts

**Exit criteria:** `pnpm eval:chat` runs the corpus against a local model and
reports pass/fail per case.

### C3 — Grounding and citations

Goal: the trust layer. Benefits Heap Code's `@workspace` answers and PR
review too, so it is worth doing even if this plan stops here.

- [ ] Value-level provenance — heapchat's `src/util/text.js:28-40`, ~13 pure
      lines: extract distinctive numbers from an answer, map each back to the
      evidence row containing it, tolerating thousands separators
- [ ] Self-verification pass over specific claims against retrieved evidence
      (heapchat's `VERIFY_SYS`, a 6-line prompt)
- [ ] Grounded badge with clickable sources; general-knowledge answers show
      no badge and are **never refused** — this was deliberate in heapchat
- [ ] Measured against C2's baseline; record before/after

**Exit criteria:** grounded answers carry sources, a fabricated number is
caught by the verification pass, and the C2 corpus improves or holds.

### C4 — Image understanding

- [ ] Vision describe-then-index so photos are searchable by content. Vision
      *chat* already works — `packages/core/src/providers/types.ts:14-15`
      sends images as data URLs — what is missing is indexing the
      descriptions (heapchat's `src/llm/vision.js`, 97 lines)
- [ ] EXIF read for date/camera as retrievable metadata. **No map, no face
      detection** (see non-goals)

**Exit criteria:** "find the receipt from the electronics shop" returns the
right photo and cites it.

### C5 — Personal memory

- [ ] Personal memory store, **separate from `.heapcode/memory.md`**. Same
      mechanism, different store: project memory about a repo and personal
      memory about the user must not mix in either direction
- [ ] Decide whether learned-procedure memory (heapchat's
      `src/llm/skills.js`, 139 lines — recalled by embedding similarity, with
      near-duplicate merging and LRU eviction) is in scope, and **name it
      something other than "skills"**. `extraction-audit.md` flags this
      explicitly: heapcode's `SKILL.md` skills and heapchat's learned
      procedures are unrelated concepts sharing a word

**Exit criteria:** a fact stated in one chat is recalled in a later,
unrelated one, and nothing personal leaks into a Heap Code session.

---

## Independent track — not gated on any milestone

- [ ] **Merge the two compactors.** The one genuine duplicate pair between
      the repos: `core/src/agent/loop.ts` (`compactIfNeeded`) vs
      `heapchat/server.js:1923-1971` (`compactHistory`), ~50 lines each.
      Take heapchat's sticky per-session summary cache (it extends
      incrementally instead of re-summarizing) and its guard that skips
      compaction when the user literally asked for a summary; keep heapcode's
      rule that a tool call is never split from its results. Improves Heap
      Code on its own.

---

## Open decisions

Do not resolve these by picking a default — ask.

| # | Question | Why it matters |
|---|---|---|
| 1 | **Rename the repo / binary?** `heapcode` already hosts heapbrowse; adding Heap Chat makes a binary named `heapcode` that launches Heap Chat. `heap code` / `heap chat` is the clean version. GitHub redirects old URLs; the npm name `@heaplabs/heapcode-cli` and the Marketplace listing are unaffected (neither is the repo name) | Cheapest to do **before** `chat-host` exists. Retargeting one product's links beats three |
| 2 | Does chat mode get its own desktop/Electron shell, or is `heapcode chat` in a browser tab enough? | heapchat's value as a daily app came partly from being an app. Affects whether packaging work is in scope at all |
| 3 | Prose chunking strategy (C1) | Line-window fallback may be adequate; a prose-aware chunker is real work |
| 4 | Is learned-procedure memory in scope (C5)? | It was one of heapchat's more distinctive ideas, and also one of its least-validated |

---

## Backlog — park ideas here, do not start

- Rich inline rendering of tabular/numeric tool results (tables, charts, KPI
  cards). `web-ui`'s `Preview` and artifact frame are the natural home
- Deep-work multi-agent roster (planner → researcher → drafter → critic).
  `core/src/agent/subAgent.ts` and `delegate_task` already exist; this is a
  policy layer over them
- MCP server surface (exposing the chat KB to other MCP clients) — heapchat
  had this; heapcode is currently MCP client only
- Everything in **Explicit non-goals** above. Listed there rather than here
  because those are decided, not deferred

---

## Decisions log

| Date | Decision | Why |
|------|----------|-----|
| 2026-09-09 | Heap Chat is a second product on the Heap Code engine, in this repo, not a mode inside Heap Code | Same relationship `packages/browser` (heapbrowse) already has — a proven precedent, same license, same org. A persona/flag would leave the workspace panel, coding prompt and project framing standing, producing an IDE with its tools greyed out |
| 2026-09-09 | Rebuild rather than port `heapchat/` | `jscpd` over both repos: 43 clone pairs, **zero** cross-repo. Nothing to merge, so it is a rewrite either way — and heapchat is the wrong source: 16,325 lines of untested CommonJS welded into two files |
| 2026-09-09 | Divergence starts at the session, not the UI; `web-host/src/session.ts` is never edited by this plan | It is 55% of web-host and the path every Heap Code session runs through. A shared session behind a mode flag is how chat features end up executing during code sessions |
| 2026-09-09 | Widen `web-host` exports rather than extracting a shared `web-kit` up front | Additive, zero behavior change on the hot path. Extraction is a separate commit from behavior change (`heaplabs-roadmap.md`), and premature extraction here risks recreating the cli/vscode duplication Phase 2 just finished undoing |
| 2026-09-09 | Multi-user accounts and per-folder ACLs cut entirely | `web-host` is single-user by design with no account model to extend. Largest item in the plan, and it would serve one user |
| 2026-09-09 | Faces, perceptual-hash dedup, photo map, knowledge graph, image generation, scheduler, projects and custom agents all cut | Most of heapchat's 16k lines, none of it the AI. The existing heapchat app still runs and is the answer for these |
| 2026-09-09 | The existing heapchat app is frozen, not deleted, and `heaplabshq/heapchat` is not archived | `electron/main.js` points `electron-updater` at that repo's releases; archiving breaks auto-update for installed builds. An app with no users needs to be run, not maintained |
| 2026-09-09 | Provider connections and the model role table are shared between products; conversation history and memory are not | One keychain entry and one Ollama config is the biggest ergonomic win available. But code sessions in a documents chat list, or project memory mixed with personal memory, would be actively wrong in both directions |
| 2026-09-09 | Document extensions are a separate set from `CODE_EXTENSIONS`, behind an extractor seam | Heap Code's index policy is deliberate; widening it in place would change Heap Code's behavior as a side effect of chat work |
| 2026-09-09 | `heapcode web` continues to land directly in code mode; the product switcher lives inside the app | The primary product's primary path must not gain a click |
| 2026-09-09 | Prose is chunked by the existing line-window fallback, not a new prose-aware chunker | `chunkFile` already routes anything `isAstSupported` rejects to `chunkFileByLines`, and extracted text is normalized first (form feeds to breaks, runs of blank lines collapsed) so the windows are not spent on layout. A prose chunker is real work and there is no measurement to justify it until C2 exists |
| 2026-09-09 | Extraction is a host callback (`document/extract`), by PATH, not a parser inside core | `pdf-parse` and `mammoth` are tens of megabytes and must not enter core or the CLI bundle, but the indexer is the daemon's. Sending the path rather than the bytes keeps a 12 MB PDF from becoming 16 MB of base64 per file; §6 already colocates the two. The host resolves it through realpath under its own root, because a symlink inside the folder defeats every prefix check |
| 2026-09-09 | `pdf-parse`/`mammoth` are optionalDependencies of **the CLI**, external to its bundle | The bundle that runs is `packages/cli/dist/cli.js`, so that is where node resolves an external import from. Declared on chat-host they installed into the wrong node_modules and every PDF silently failed — which first read as a passing test, because `search` had matched an uncompressed PDF's raw bytes |
| 2026-09-09 | Heap Chat indexes the folder on open; Heap Code does not | Not an oversight there: a repo opened in an editor has reason to index on demand, but the point of pointing this at a folder is that its contents become answerable. An unbuilt index answers the first question with "there is nothing about that here", which is the worst wrong answer this product can give |
| 2026-09-09 | `read_file` on a document returns extracted text, and says so plainly when it cannot | Retrieval already returns extracted text; a direct read that returned FlateDecode bytes would make the two disagree about what the file says. Failure is reported rather than returned empty — "could not read" and "is empty" lead the model to opposite conclusions |
| 2026-09-09 | `extraction-audit.md`'s structural findings stand; its line numbers and sizes do not | It measured `core` at 5,528 lines; `core` is 15,182 as of today. Re-verify any specific reference before acting on it. Its conclusions have only strengthened — heapcode roughly tripled while heapchat has had no commit since 2026-07-26 |
