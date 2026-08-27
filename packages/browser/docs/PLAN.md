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
- [x] Max-iteration cap with a "keep going?" prompt (landed once `ask_user` existed)

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

- [x] `click`, `type`, `select`, `navigate`, `go_back` with realistic event sequences (PRD §7.3)
- [x] Stale-handle detection → hard error, never a best-effort guess; every handle retires after any mutating action
- [x] Permission engine: `f(actionClass, origin)`, reusing `PermissionClass` + `resolvePermission`
- [x] Destructive-intent heuristic (committing language + form-submit + checkout landmark) escalating to `destructive`
- [x] Confirmation UI: element **highlighted in the page** + accessible name shown in the panel, from our extraction, not the model's description
- [x] Per-origin grants (session-scoped); mode selector in the panel header
- [x] Built-in high-harm origin blocklist (banking, brokerage, government, email, password managers) — read-only, never actionable, not overridable
- [x] Hard refusals at the executor: password fields, OTP/credential-named fields, payment card fields
- [x] Cross-origin `navigate` requires confirmation
- [x] Audit log: every call, args, decision, decider, origin — recorded locally
- [x] Audit log viewer + export in the panel

**Exit criteria:** a form-filling task runs end to end; every mutating action appears in the audit log with a recorded decision; attempting to type into a password field is refused at the executor with the model told why; a blocklisted origin cannot be acted on at all.

**Exit status: not met — needs a real form-filling run, and the audit viewer.** What is tested:
84 unit tests across the safety logic, the action performer and the policy. A password, OTP or card
field is refused at the executor with the model told why; a blocklisted host is denied under every
mode and even with an explicit grant; destructive stays `ask` on a trusted site; the click sequence
is asserted phase by phase, since a bare `.click()` is `isTrusted: false` and silently ignored by
many frameworks.

Two bugs the tests caught, both from substring matching: `/pass/` matched `passenger_name` on every
flight-booking form, and `/card/` matched `discard`. The credential rule existed in two copies at
that point, which is how one of them would eventually have stopped matching — it is now one shared
module with whole-word matching. Over-refusing is not the safe direction it looks like: an agent
that refuses ordinary fields gets switched off, and protects nobody.

---

## M4 — Verification & Recovery

Goal: the agent notices when it was wrong.

- [x] Post-action snapshot diff → compact "what changed" observation back to the model
- [x] No-op detection: action reported success but nothing changed → reported honestly, not retried blindly
- [x] Navigation as a hard state boundary (wait for load → re-inject → re-snapshot)
- [x] Error taxonomy back to the model: stale handle / removed / disabled / hidden / no size / navigated away / timeout
- [x] Verification gate before `finish` for tasks that took a mutating action
- [x] Per-step run timeline in the panel (shipped with the transcript fix); mid-run correction is stop-and-reask, not inline editing

**Exit status: the mechanisms are in and tested; the exit criteria need a real broken page.**

The shape of the fix mattered more than the checklist. Every mutating action now *observes* its own
result: settle, re-snapshot, diff. Before this a click returned "handles are void, read again" and
the agent spent a whole turn discovering whether anything had happened — or skipped the read and
reported success for an action that did nothing, which is the failure hardest to tell apart from a
broken agent. A synthetic click on a page that ignores untrusted events returns perfectly normally;
looking is the only way to know.

A no-op is reported as one, with an explicit instruction not to retry. A page that ignored one
synthetic click will ignore the next, and blind retries are how an agent orders three of something.

The verification gate is core's, not a new one: `read_page` is marked `verifies: true` and the run
sets `requireVerificationBeforeFinish`, so the loop blocks `finish` once, with a nudge, if a mutating
tool ran since the last read. The same machinery that stops heapcode finishing with untested edits.

---

## M5 — Injection Hardening

Goal: the safety claim is tested, not asserted.

- [x] Adversarial fixture suite: injected instructions in visible text, `alt`, `aria-label`, `title`, table cells, select options, hidden nodes, comments, and text impersonating the user / a system prompt / a tool result
- [x] System prompt hardening + role separation (user turns vs tool results structurally distinct)
- [x] Untrusted-output marking verified for every page-reading tool
- [x] Rate/volume guards: max actions per run, max navigations per run, per-host action ceiling
- [ ] Security review write-up for the Chrome Web Store submission

**Exit criteria:** the adversarial suite is green in CI and runs on every PR. A red test blocks release.

**Exit status: met for the suite, one item outstanding (the write-up).** The suite runs in `pnpm test`,
which CI already runs on every PR, so a red test blocks release today.

The suite deliberately does **not** test "the model resisted". That would be testing a model, and it
would pass or fail differently on every endpoint a user might configure — which makes it worthless as
a release gate. It tests the properties that hold whatever the model decides: the payload never
arrives unlabelled, the notice precedes the content rather than trailing it, page text never occupies
a role that carries authority, a destructive action always reaches a human under every mode and
grant, a bank is refused outright, and a run cannot take unbounded actions. A section of the suite
assumes the injection **fully succeeded** and asserts all of that still holds.

It immediately found a real hole. `extractText` stripped scripts, nav and footers but never checked
visibility, so a `display:none` payload was invisible to the user and fully visible to the model —
the most valuable place on a page to hide an instruction, since nobody will ever notice it. Controls
had been visibility-filtered from the start; the text block had not. It was cloning the subtree
first, and a detached clone has no layout, so `display:none` was undetectable in it by construction.
Now walked live.

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

- [x] `chrome.debugger` / CDP escalation: real trusted input events + `DOM.setFileInputFiles` for uploads
- [x] Accessibility-tree extraction as an alternative to the DOM walk
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
| 2026-08-27 | **Brought forward:** CDP shipped as an opt-in driver, DOM walk retained as fallback | Every per-site break so far — scroll containers, inert modals, a `display:none` injection, silent no-op clicks — was our estimate of something the browser computes exactly. The banner is real but it was the user's cost to accept, and they did. The DOM walk stays because Chrome detaches the debugger the instant DevTools opens, with no warning and no refusal: the fallback is forced, not cautious |
| 2026-08-27 | Indexed per-snapshot handles, not model-authored CSS selectors | Prevents acting on a mis-resolved or re-rendered element |
| 2026-08-27 | No `full-auto` mode | heapcode's blast radius is a git-recoverable working tree; a browser's is the user's money |
| 2026-08-27 | **Reversed:** an `auto` mode exists, off by default | The reasoning above still holds for the *default*, but it was decided on the user's behalf. After real use they asked for it twice, having understood the trade. Refusing a capability someone has understood and asked for is paternalism — and the practical result was worse, since a confirmation on every wizard step is what teaches people to click through the one that matters. `auto` does not lift the blocklist, the per-run ceilings, or the credential refusal: those are floors, not preferences |
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
| 2026-08-27 | The permission class is inferred per call, not read off the tool | `click` on a filter and `click` on "Place order" are the same call. heapcode can classify by tool name because the tool names the intent; a browser cannot |
| 2026-08-27 | Handles retire after **any** mutating action, not just navigation | The page may have re-rendered under the indices. Costs a re-read between actions, which deltas make cheap; the alternative is clicking the wrong row |
| 2026-08-27 | The blocklist is checked before the mode, and cannot be overridden | A per-site grant is never offered on a bank. A floor that a setting can lift is not a floor |
| 2026-08-27 | Credential matching is whole-word, in one shared module | Substring matching refused `passenger_name` and `discard`. Two copies of a security rule is how one stops matching — this repo already has that bug in its two `markdown.ts` files |
| 2026-08-27 | Read-only mode does not offer the mutating tools at all | The model spends no turns proposing what it cannot do, and there is no path where a refused tool is half-executed |
| 2026-08-27 | The injection suite tests the guarantees, never "the model resisted" | Model behaviour varies by endpoint and BYOK means we do not choose the endpoint, so a suite that tested it would be a release gate that passes or fails for reasons outside the code |
| 2026-08-27 | Hostile page text is labelled, never stripped | The user may want to know a page tried, and a sanitiser that removes text is one an attacker can probe and evade |
| 2026-08-27 | Per-run ceilings on actions, navigations and per-host actions | Every other defence runs through the model's judgement or the user's attention, and both wear down — forty confirmations in front of a tiring user is its own attack. Arithmetic does not wear down |
| 2026-08-27 | Ceilings are spent on the attempt, and never on reads | Retrying must not buy more budget; and counting reads would discourage looking before acting, which is the behaviour most worth having |
| 2026-08-27 | Every mutating action observes its own result before returning | Otherwise the agent spends a turn finding out whether it worked, or skips that and reports success for a click the page ignored — which returns normally and is indistinguishable from success |
| 2026-08-27 | The verification gate reuses core's `verifies` / `requireVerificationBeforeFinish` | The rule "do not declare success without checking" is not browser-specific, and heapcode had already built and tested it for untested edits |
| 2026-08-27 | A no-op is reported with an explicit do-not-retry | A page that ignored one synthetic click will ignore the next; blind retries are how an agent orders three of something |
| 2026-08-27 | The navigation load timeout is injectable | It was 15s of real waiting in a CI test. A slow test is a test people stop running |
| 2026-08-27 | A bare form-submit with continuation wording is `write`, not `destructive` | Found applying for a job: multi-step wizards submit on every step just to advance, so every "Next" asked. Committing language and checkout landmarks are checked first and still escalate |
| 2026-08-27 | Mode renamed `trusted-site` → `auto-approve`, labelled "Ask only for risky" | It applies everywhere, not to one site; per-site trust is the separate `trustedHosts` grant. A label describing a narrower behaviour than the code has is how a user grants more than they meant to |
| 2026-08-27 | Checkout detection matches whole tokens on id/class/action path, never substrings | Found on LinkedIn: a generated class name put "this cannot be undone" on the Apply button. `closest` means every element inherits every ancestor's classes, so substring matching there is hopeless on a real site |
| 2026-08-27 | `cart` is not a money signal | Adding to a cart is reversible — it is the checkout that is not — and the token appears in too many unrelated class names to earn its false positives |
| 2026-08-27 | The escalation reason names what matched | A warning that explains itself is one the user can tell us is wrong. The LinkedIn report was actionable because the message said "is inside a checkout or payment area", which was visibly false |
| 2026-08-27 | A money-area name now needs corroboration — a card field or a money form action in the same container | Twice a name alone was wrong on LinkedIn. Class names are chosen by people who never heard of this heuristic, and `closest` searches the whole ancestor chain, so a matching word is always findable somewhere on a large app. A real checkout has card fields by construction; a job board has none |
| 2026-08-27 | Continuation wording matched as a prefix, not exactly | Real buttons read "Continue to next step", not "Continue". Safe as a prefix because committing language is checked first, so "Continue to payment" has already escalated |
| 2026-08-27 | `ask_user` added, reusing core's definition and idle semantics | A browser agent hits this constantly where a coding agent does not: a form needs facts that are not on the page. Without it the model invents a plausible value and types it into a real application. Also unlocks the step-limit prompt, which needs `ask_user` to exist |
| 2026-08-27 | `toolDefinitions` added to core's browser-safe barrel | `ask_user` lives there and is not workspace-specific; restating its schema would put two definitions of one protocol tool in the portfolio |
| 2026-08-27 | `requestPermission` may return a reason (core change) | Returning false says "the user denied this", so a model hunts for a route the user might accept. When the refusal was a rate ceiling that is wrong and expensive — a real run spent its last third insisting the user had denied things they had approved |
| 2026-08-27 | Ceilings raised to 150/40/120, and human-approved actions are not charged | A five-job application run is naturally dozens of clicks and tens of navigations. The ceiling exists for *unattended* action; when someone is approving each request they are a better limit than any number |
| 2026-08-27 | Navigating away never requires permission to read the page being left | An application redirected to an external Workday portal and the agent could not get back to LinkedIn, because leaving required reading. Any ungranted redirect was a dead end |
| 2026-08-27 | `go_back` uses `chrome.tabs.goBack`, not the content script | The case where going back matters most is exactly the one where the script was never injected |
| 2026-08-27 | Scrolling drives the pane that actually moves, not always the window | LinkedIn's shell is pinned to the viewport and the list is an inner pane, so every `window.scrollBy` was a silently successful no-op. The snapshot said so all along — "scrolled 0/979" on a 979px viewport means the document cannot move |
| 2026-08-27 | The snapshot reports that pane's scroll position | Reporting the document's position on an app-shell layout makes every scroll look like a no-op, so the agent concludes a list has ended when it has barely started |
| 2026-08-27 | The verification nudge names the host's own `verifies` tool | It said "run the tests (run_tests)", and heapbrowse verifies by reading the page. The model spent a turn explaining it had no such tool, which reads as the product being confused about itself |
| 2026-08-27 | An open modal dialog is the whole snapshot | Everything behind a modal is inert, so listing it hands the model a menu of things that cannot be clicked, indistinguishable from the ones that can — and a click on the backdrop dismisses the dialog. Observed as the agent losing LinkedIn's filter panel |
| 2026-08-27 | Scrolling looks inside the dialog first | The document is usually locked while a modal is open, and the largest scrollable pane on screen is the (inert) list behind it |
| 2026-08-27 | The prompt prefers URL parameters over filter UI | It spent a dozen turns on LinkedIn's all-filters dialog having already used the URL parameters successfully in an earlier run. A filter panel opens in a dialog and closes when anything else is clicked; a URL does neither |
| 2026-08-27 | One `PageDriver` interface, two implementations | The executor must not know which path it has, because it can change mid-run when Chrome detaches |
| 2026-08-27 | A lost session falls back for the rest of the run, and says what it costs | Re-attaching would fight whatever took it, and DevTools being open is a deliberate act. Switching silently would leave the user wondering why clicks started failing |
| 2026-08-27 | The pool detaches on every run end, however it ended | A "Chrome is being debugged" banner still up after the agent has stopped reads as something watching them |
| 2026-08-27 | The model names a *configured* file, never a path | `DOM.setFileInputFiles` takes a real path on the machine. A model free to invent paths could upload any file it can guess the location of — prompted, potentially, by the page it is reading |
| 2026-08-27 | `attach_file` is only offered when it can work | A tool advertised and then refused every time is worse than no tool: it spends turns proposing it and explaining the failure |
| 2026-08-27 | The debugger setting defaults **on** | Defaulting it off meant the strictly better path was the one nobody was on, while every per-site failure came from the path that estimates what CDP knows |
| 2026-08-27 | **Corrected:** `debugger` is a *required* permission, not optional | Chrome refuses it as optional — it is silently dropped from the manifest ("Permission 'debugger' cannot be listed as optional") and `permissions.request` then throws for it. The whole runtime-grant design was built on a premise Chrome does not support, and no amount of fixing the gesture would have helped. It is held from install or not at all; using it stays a setting |
| 2026-08-27 | The install prompt shows the debugger warning, unavoidably | The alternative is not having the capability. Noted for M7: this is the single biggest Chrome Web Store review risk in the extension |
| 2026-08-27 | One driver instance per tab, kept for the run | `CdpDriver` holds the handle registry and generation as instance state, because handles map to backend node ids rather than to anything in the page. A fresh instance per call gave every action an empty registry — every click failed with "generation 1, now 0". `DomDriver` is stateless and hid the bug until CDP was switched on |
| 2026-08-27 | Screenshots go to the user, never to the model | A picture is 100–500KB and stays in the context for every remaining turn, which is how these agents get slow and expensive. The model reads the accessibility tree: smaller, exact, addressable. The human gets the picture, because "what is it looking at" is a question text answers badly |
