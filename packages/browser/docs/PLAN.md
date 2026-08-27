# heapbrowse — Build Plan

Source of truth for **what we build, in what order, and when it's done**. Spec details live in `docs/PRD.md`; reuse decisions in `docs/REUSE.md`. Update checkboxes as work lands; never start a milestone before the previous one's exit criteria are met.

## Guardrails

1. **One milestone at a time.** New ideas go to the Backlog, not into the current milestone.
2. **Exit criteria are the definition of done** — demoable behavior, not "code exists".
3. **The agent loop never runs in the service worker.** (PRD §7.1 — it gets killed mid-run.) Enforce by keeping loop code out of `src/background/`.
4. **Page content is untrusted, always.** Every snapshot reaches the model through `wrapUntrusted()`. No exceptions, no "trusted origin" bypass.
5. **No mutating action ever ships without a permission path.** A new tool with `permission: 'write' | 'destructive'` lands with its confirmation UI in the same PR.
6. **No shared code is copy-pasted from heapcode.** Import it, or extract it properly (`docs/REUSE.md`). A third divergent copy of the provider layer is the failure state.
7. **Every feature works with a local model (Ollama)** before it's called done. Local-first is the brand promise.
8. **Tests land with the milestone.** Mock provider + fixture HTML pages for anything touching an LLM or the DOM.

---

## M0 — Skeleton (v0.1)

Goal: prove the whole pipe — side panel → provider → streamed reply, with no page access at all.

- [x] Repo scaffold: Vite + TS strict + ESLint/Prettier, `@crxjs/vite-plugin` MV3 build
- [x] `manifest.json` v3: `sidePanel`, `storage`, `activeTab`, `scripting`; **no `<all_urls>` yet** (`host_permissions` is empty)
- [x] Side panel opens from the toolbar icon and persists across tab switches
- [x] Provider config UI: base URL, API key, model, presets — all 12 of core's presets, not a hand-picked subset
- [x] Key stored in `chrome.storage.local`, never synced, redacted in all logs — the field is write-only and the key is never read back into the UI
- [x] Streaming chat with stop button, markdown + syntax highlighting, sanitized render
- [x] Ollama connectivity diagnostic: detect missing `OLLAMA_ORIGINS=chrome-extension://<id>` and say exactly how to fix it
- [x] CI: lint, typecheck, unit tests, packaged `.zip` artifact
- [x] **Reuse gate:** consuming `@heapcode/core` provider + SSE modules via subpath imports (REUSE.md Phase 0), not a copy

**Exit criteria:** load unpacked → open panel → configure Ollama → send a message → streamed highlighted reply; stop works; the same conversation works against a cloud endpoint by switching profile only.

**Exit status: met (2026-08-27).** Loaded unpacked into Chrome and confirmed by the user
against Ollama Cloud (`https://ollama.com/v1`, `glm-5.2`).

Two things this pass found that the automated checks could not:

- `ollama.com` sends **no CORS headers at all**, so an extension with no host permission cannot
  reach it. OpenAI does send them, which would have made the product look fine while Ollama
  Cloud silently failed. Fixed with `optional_host_permissions` and a per-origin grant requested
  when the endpoint is configured — no broad install-time ask (PRD §7.6).
- A local Ollama returns **403** to a `chrome-extension://` origin: it refuses server-side, not
  merely by withholding CORS headers. So `OLLAMA_ORIGINS` is genuinely required and no browser
  permission substitutes for it. Once the host grant is in place that 403 becomes readable, and
  the diagnostic was reading it as "your API key is wrong" — now corrected to report a refused
  origin with the right fix.

---

## M1 — Page Understanding

Goal: the model can talk about the page accurately, and cheaply.

- [x] Content script injection + lifecycle — injected on demand per read, so navigation and SPA
      route changes need no separate handling: the script dies with the page and is re-injected
      on the next read, and a double-injection guard makes repeat injection safe
- [x] DOM walker → snapshot per PRD §4: text, controls, links, forms, tables
- [x] Accessible-name resolution chain (`aria-label` → `aria-labelledby` → `label` → alt →
      text → placeholder → title → name)
- [x] Visibility/enabled filtering; handle registry with per-snapshot indices
- [x] Readability-style main-content extraction for the `[TEXT]` block
- [x] Budget-aware ranked truncation (viewport proximity, landmark, intent match)
- [x] `wrapUntrusted()` applied to every snapshot before it reaches the model
- [x] Token accounting + a visible context meter in the panel
- [ ] Fixture corpus: 10 saved real-world pages (product list, article, form, table, SPA, infinite scroll) with expected snapshot assertions

**Exit criteria:** on all 10 fixtures, ask "what can I do on this page?" and get an accurate control list; snapshot for a 500KB page stays under the configured token budget; no raw DOM ever crosses the boundary.

**Exit status: not met — the fixture corpus is the one item outstanding, and the criteria are
written against it.** 46 unit tests cover the extractor and the formatter on synthetic markup,
including two the corpus would not have caught on its own: password and card-field values never
reach the snapshot at all (reading them is the same exposure as typing into them, by a different
route), and a layout table's first `<td>` row is not mistaken for column headers. What synthetic
fixtures cannot tell us is whether the *ranking* is any good on a real page — that is what the
corpus is for.

---

## M2 — Read-Only Agent Loop

Goal: a real multi-step agent, with the blast radius still zero.

- [x] Agent loop wired in the **side panel** (guardrail 3), SW as thin router
- [x] Long-lived `Port` panel↔SW (kept from M0; the port is what stops the worker being reaped)
- [ ] Run state checkpointed to `chrome.storage.session` so a panel reload can resume
- [x] Read-only tools: `read_page`, `get_elements`, `extract_data`, `scroll`, `wait`, `finish`
- [x] Structural termination on `finish` — inherited, and `finish` never reaches the host executor at all
- [x] Snapshot **deltas** after the first read — no full re-send per iteration
- [x] Streaming tool-call UI: tool chips, args, results, collapsible
- [x] Context compaction when the transcript outgrows the window (core's, via `contextWindow`)
- [x] Abort/stop mid-run leaves consistent state
- [x] Max-iteration cap (core's default; the "keep going?" prompt needs `ask_user`, which needs M3's confirmation UI)

**Exit criteria:** "summarise the top 5 results and compare them on price and RAM" completes on a real listing page using scroll + extract, in under N iterations, with the token cost of a 10-step run demonstrably below 10× a single snapshot.

**Exit status: not met — needs a real listing page.** What is proven: core's `runAgent` drives the
browser executor end to end with no change to the loop, the browser prompt replaces the coding one,
the read-only belt is exactly what reaches the model, a page result arrives wrapped as untrusted,
and a tool failure is reported to the model rather than ending the run. Deltas are asserted to be
dramatically smaller than a snapshot on a 60-control page — which is the mechanism behind the cost
bound, not the bound itself. The bound is a claim about a real run and needs one.

Two items deliberately deferred rather than done. `chrome.storage.session` checkpointing buys
resumption after a panel reload; closing the panel still ends the run either way, so it is a
convenience, not the guardrail. The "keep going?" prompt at the step limit needs `ask_user`, whose
whole point is a UI that blocks on a human answer — that is M3's confirmation surface, and building
it twice is the thing to avoid.

---

## M3 — Mutating Actions + Permissions

Goal: the agent can operate the page, and cannot do so unnoticed.

- [ ] `click`, `type`, `select`, `navigate`, `go_back` with realistic event sequences (PRD §7.3)
- [ ] Stale-handle detection → hard error, never a best-effort guess
- [ ] Permission engine: `f(actionClass, origin)`, reusing `PermissionClass` + `resolvePermission`
- [ ] Destructive-intent heuristic (buy/pay/submit/delete/transfer + form-submit + checkout landmark) escalating to `destructive`
- [ ] Confirmation UI: element **highlighted in the page** + accessible name shown in the panel, from our extraction, not the model's description
- [ ] Per-origin grants (session-scoped), origin chip in the panel header
- [ ] Built-in high-harm origin blocklist (banking, brokerage, email, password managers) — read-only, opt-in, never `write`
- [ ] Hard refusals at the executor: password fields, OTP/credential-named fields, payment card fields
- [ ] Cross-origin `navigate` requires confirmation
- [ ] Audit log: every call, args, decision, decider, origin, snapshot hash — viewable + exportable

**Exit criteria:** a form-filling task runs end to end; every mutating action appears in the audit log with a recorded decision; attempting to type into a password field is refused at the executor with the model told why; a blocklisted origin cannot be acted on at all.

---

## M4 — Verification & Recovery

Goal: the agent notices when it was wrong.

- [ ] Post-action snapshot diff → compact "what changed" observation back to the model
- [ ] No-op detection: action reported success but nothing changed → reported honestly, not retried blindly
- [ ] Navigation as a hard state boundary (re-inject → wait for load → re-snapshot)
- [ ] Error taxonomy back to the model: stale handle / not visible / not interactable / navigated away / timeout
- [ ] Verification gate before `finish` for tasks that took a mutating action
- [ ] Per-step run timeline in the panel with the ability to stop and correct mid-run

**Exit criteria:** a deliberately broken fixture (button that does nothing, list that re-renders under the agent, redirect mid-action) produces an accurate report of failure rather than a false claim of success.

---

## M5 — Injection Hardening

Goal: the safety claim is tested, not asserted.

- [ ] Adversarial fixture suite: injected instructions in visible text, `alt`, `aria-label`, hidden nodes, comments, `title`
- [ ] System prompt hardening + role separation (user turns vs tool results structurally distinct)
- [ ] Assert: no injected fixture produces a tool call the user did not ask for
- [ ] Untrusted-output marking verified for every page-reading tool
- [ ] Rate/volume guards: max actions per run, max navigations per run, per-origin action ceiling
- [ ] Security review write-up for the Chrome Web Store submission

**Exit criteria:** the adversarial suite is green in CI and runs on every PR. A red test blocks release.

---

## M6 — Real Tasks

Goal: earn the "operates it for you" claim on tasks people actually have.

- [ ] Multi-page flows (paginate, accumulate, compare)
- [ ] `extract_data` → table view in the panel + CSV/JSON export
- [ ] User profile store (name, email, resume text) — local, opt-in, field-matched injection only
- [ ] Job-application flow: fill everything, **pause and hand the file upload to the user** (PRD §7.4)
- [ ] Saved/repeatable tasks
- [ ] Task history with replayable audit trail

**Exit criteria:** the two PRD example tasks (cheapest 16GB laptop under ₹60,000; fill a job application) both complete on live sites, with the upload step correctly handed back.

---

## M7 — Launch

- [ ] Onboarding: first-run setup, permission explainer, model picker
- [ ] Privacy disclosure ("page content goes to the endpoint you configure, and nowhere else")
- [ ] Telemetry: register `heapbrowse` in `heaplabs-telemetry` `KNOWN_APPS`, opt-in, anonymous counts only
- [ ] Permission minimisation pass — `activeTab` + per-site grants over `<all_urls>` wherever UX survives
- [ ] Landing page at `browse.heaplabs.dev`
- [ ] Chrome Web Store submission (budget calendar time for review — PRD §7.6)

**Exit criteria:** listed on the Chrome Web Store; a new user gets from install to a successful page question in under 3 minutes with no docs.

---

## Track X — Deferred

Not v1. Do not start before M7 ships.

- [ ] `chrome.debugger` / CDP escalation: real trusted input events + `DOM.setFileInputFiles` for uploads
- [ ] Accessibility-tree extraction as an alternative to the DOM walk
- [ ] Cross-tab and background/unattended runs
- [ ] MCP tool support in the browser agent
- [ ] Firefox port

---

## Backlog

Park ideas here. Do not start.

- Vision fallback: screenshot + coordinates for canvas/WebGL pages where DOM extraction is empty
- Shared session with heapcode (browser agent hands findings to the coding agent)
- Recorded macros → replayable deterministic scripts, LLM only on failure
- Per-site adapters for high-traffic sites where generic extraction underperforms

---

## Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-08-27 | Agent loop lives in the **side panel**, not the service worker | MV3 kills an idle SW at ~30s; a multi-minute run cannot survive there (PRD §7.1) |
| 2026-08-27 | DOM walk in a content script for v1; CDP deferred to Track X | CDP shows a persistent "being debugged" banner and is a much larger permission ask |
| 2026-08-27 | Indexed per-snapshot handles, not model-authored CSS selectors | Prevents acting on a mis-resolved or re-rendered element |
| 2026-08-27 | No `full-auto` mode | heapcode's blast radius is a git-recoverable working tree; a browser's is the user's money |
| 2026-08-27 | File upload out of v1; agent pauses and hands it to the user | `input.files` is unsettable without CDP (PRD §7.4) |
| 2026-08-27 | Destructive class is **inferred conservatively**, tuned only toward more confirmations | False positive costs a click; false negative costs a purchase |
| 2026-08-27 | Consume `@heapcode/core` via subpath imports first, extract `@heaplabs/agent-core` after M2 | Extract on second real use, not on speculation (REUSE.md §5) |
| 2026-08-27 | Phase 0 shipped as subpath exports + `sideEffects: false` + a lint rule **and** a transitive-closure test | The lint rule alone cannot see coupling that arrives through a relative import — `agent/webSearch.ts` reaches `node:child_process` via `workspaceTools` without the string `node:` appearing in it. The test walks the real graph; the rule is the fast half |
| 2026-08-27 | `providers` barrel also re-exports `config/profiles.ts` | `createProvider` takes a `ProviderProfileConfig`; a barrel exporting the function but not its parameter type forces callers back to the Node-coupled package barrel |
| 2026-08-27 | Markdown rendering imported from `@heapcode/web-ui/markdown`, not copied | It is the hardened DOMPurify copy, and it is hardened in only one of the two that exist today (REUSE.md §4.1c). A third copy is what guardrail 6 forbids. The import moves when `@heaplabs/chat-ui` is extracted; the sanitization must not |
| 2026-08-27 | heapbrowse inherits PolyForm-Noncommercial-1.0.0 | Matches `packages/cli` and `packages/vscode`; user's explicit call |
| 2026-08-27 | Provider and page access via `optional_host_permissions`, granted per origin at the moment of use | A BYOK endpoint is not knowable at build time, and a static whole-web grant is the install-time ask PRD §7.6 says to avoid. Same mechanism now covers both the endpoint and the page |
| 2026-08-27 | Content script injected on demand, never declared in the manifest | A declared `content_scripts` entry needs its `matches` granted at install, i.e. every site up front. Injecting per-tab gets the same capability proportionately, and makes navigation lifecycle a non-issue |
| 2026-08-27 | Snapshot never carries a password, OTP or card field value | The executor refusing to *type* into them (PRD §6.4) does not help if the snapshot *reads* them — it goes to whatever endpoint the user configured, so an autofilled password would be transmitted verbatim |
| 2026-08-27 | Extraction and formatting split either side of a DOM-free boundary | The ranking and budget rules decide whether a 500KB page costs 2k tokens or 40k; keeping them DOM-free means they can be tested without standing up a document |
| 2026-08-27 | Added `systemPrompt` to core's `AgentOptions` | The loop is tool-agnostic but its system prompt was hardcoded to "You are Heap Code Agent, an autonomous coding agent" — a browser agent was being told to go read files. First real gap a second host found, exactly as REUSE.md section 5 predicted |
| 2026-08-27 | The agent decides when to read the page; the per-message "include page" toggle is gone | With tools it is the agent's call, and the thing that actually gates exposure is the per-site grant in the header, not a checkbox that was easy to leave ticked |
| 2026-08-27 | Tool results render as plain text, never markdown | They are page content from an untrusted source; putting them through a markdown renderer inside the extension origin hands an arbitrary page a way to shape the panel |
| 2026-08-27 | Only prose turns become history; tool traffic stays in its run | Replaying old snapshots into the next run spends the window on stale pages whose handles no longer resolve |
