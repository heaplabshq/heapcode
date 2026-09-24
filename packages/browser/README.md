# heapbrowse

An AI browser agent as a Chrome extension: a side-panel assistant that reads the page
you are on and can operate it for you. Sibling of heapcode — same promise, different
surface: **model-agnostic, BYOK, any OpenAI-compatible endpoint, local or cloud.**

- Spec: [`docs/PRD.md`](docs/PRD.md)
- Milestones and status: [`docs/PLAN.md`](docs/PLAN.md)
- What it borrows from heapcode, and why: [`docs/REUSE.md`](docs/REUSE.md)

## Status: M7

Feature-complete for v1; the one item left in `docs/PLAN.md` is the Chrome Web Store
submission. It reads the page you are on, answers questions grounded in it, extracts
structured data from it, and operates it — click, type, fill a whole form in one
confirmation, select, press keys, navigate, work across tabs, download a file the page is
offering. Every mutating action is classified, and in the default mode shown to you
against the real element on the page before it happens; `auto` lifts the asking and
nothing else. Banking, brokerage, government, primary-email and password-manager origins
cannot be acted on at all, whatever the mode. `web_search` and `fetch_url` are offered
when a search backend is configured. Turning on the debugger escalation buys real trusted
input events, the accessibility tree instead of a DOM walk, `drag`, and attaching one of
your configured files to a file input.

`host_permissions` is still empty: sites are granted one at a time, and `downloads` is
optional.

A local or LAN Ollama works without setting `OLLAMA_ORIGINS`: the extension removes its own
Origin header on requests to the endpoints you configure — only its own requests, only to
those addresses (`declarativeNetRequestWithHostAccess`, which adds nothing to the install
prompt).

## Build and load

```sh
pnpm install          # from the repo root
pnpm --filter @heapcode/browser build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `packages/browser/dist`. Click the toolbar icon to open the side panel.

`pnpm --filter @heapcode/browser package` additionally produces the
`heapbrowse-<version>.zip` that the Chrome Web Store accepts.

## Connecting a local Ollama

Ollama refuses cross-origin requests from origins it has not been told about, and this
extension is one. Point the panel at `http://localhost:11434/v1`, press **Test
connection**, and it will tell you which of the two possible problems you have —
"nothing is listening" or "running but refusing this origin" — and print the exact
command for your platform. The browser reports both as an identical `Failed to fetch`,
which is why the check exists.

## Architecture, in one paragraph

The agent loop **does not run in the service worker**. Chrome terminates an idle MV3
worker after about 30 seconds and a run takes minutes, so the loop lives in the side
panel, which is a real document with a normal lifetime; the worker is a thin stateless
router, kept alive by a long-lived `Port` the panel holds open. Consequence: closing the
panel ends the run, and the UI says so rather than letting it be discovered. See PRD
§7.1.

The agent itself is heapcode's — `@heapcode/core`'s loop takes tools as data and
execution as a callback and knows nothing about files, so heapbrowse supplies a new tool
belt rather than a new agent. Core is imported through its browser-safe subpaths
(`@heapcode/core/agent`, `/providers`, `/context`); the package barrel is Node-coupled
and will not bundle here. Two tests hold that line: `packages/core/test/browserSafety.test.ts`
walks core's import graph, and `test/reuseGate.test.ts` bundles the subpaths for a browser
target and asserts the barrel still fails.
