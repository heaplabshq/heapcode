# Phase 3 design note — moving RAG behind the server

**Status:** design note for review. No code has been written or changed.
**Depends on:** `docs/phase3-provider-custody-design.md` (custody **A2**),
`docs/phase3-protocol-design.md` (§4 shape 5 recommends RAG server-side).
**Decision owner:** Sid.

---

## Corrections to this task's framing, up front

Both prior design notes found real errors in their own framing, and the chat
migration found more by checking shapes instead of assuming them. Four
things in this task's framing do not survive contact with the current code.
The first one changes the whole shape of the question.

### 1. `Float32Array` already serialises to JSON, in production, today

The framing says "embeddings are `Float32Array`, and `Float32Array` doesn't
serialize into JSON cleanly across the socket." The conversion it describes
as the hard problem is already the *on-disk format*:

- `VectorStore.serialize()` writes every vector as a plain JSON number array
  — `Array.from(r.vector)` (`packages/core/src/rag/store.ts:141`).
- `VectorStore.deserialize()` reads it back with `Float32Array.from(r.vector)`
  (`:151`).
- `Provider.embeddings` never returns a `Float32Array` at all. Its response
  type is `number[][]` (`packages/core/src/providers/types.ts:77-79`),
  produced by `data.map((d) => d.embedding ?? [])`
  (`packages/core/src/providers/openaiCompatible.ts:275`). The indexers are
  what convert *into* `Float32Array`, at
  `packages/cli/src/rag/indexer.ts:209` and
  `packages/vscode/src/rag/indexer.ts:214`.

So a JSON round-trip of every vector in the index is not a hypothetical
cost of the protocol. It is what happens every time the index is saved or
loaded, on both hosts, and there is a 15.6 MB file on this machine that is
the result (`~/.heapcode/projects/Users-air-Documents-github-heapcode-94ecfc30/rag-index.json`).

The real problem is **size**, and it is measurable rather than arguable.
Measured on that file (198 files, 852 chunks, 768-dim vectors):

| One 768-dim vector | Bytes |
|---|---|
| Raw `Float32Array` | 3,072 |
| Base64 of those bytes | 4,096 |
| **JSON number array — the encoding in use today** | **16,199** |

Base64 is not a 33% tax on top of JSON. Base64 is **4× smaller than the
encoding this codebase already uses for the same data**. The framing's
option 2a has its sign backwards, and §2 below is written against the real
numbers rather than the assumed ones.

### 2. The cited lines are close but point at the wrong layer

`rag/indexer.ts:193-254` is roughly right for the extension (the model-call
region is `:192-260`); the CLI's equivalent region is `:163-258`. But
neither indexer constructs a `Provider`. Both call a *role resolver* —
`this.roles.resolveRole('embeddingsModel')`
(`packages/cli/src/rag/indexer.ts:163`, `:185`, `:238`, `:251`) and
`this.profiles.resolveRole(...)` (`packages/vscode/src/rag/indexer.ts:193`,
`:200`, `:237`, `:254`) — and construction happens one level down, at
`packages/cli/src/provider/roles.ts:40` and
`packages/vscode/src/profileManager.ts:155`/`:175`.

This matters for scoping: what has to move server-side is not four
`createProvider` calls, it is **role-redirect resolution**, which the server
does not have yet (§4).

### 3. RAG is not the last host-side `Provider`

The framing says RAG "is the last major feature still constructing a
host-side `Provider`". Four others still do, and three of them do so by
explicit prior decision:

- Ghost text — `packages/vscode/src/completionProvider.ts:104`, `:116`,
  `:127` (host-side per protocol §4, latency).
- Inline edit — `packages/vscode/src/inlineEdit.ts:129`, `:332` (same).
- Commit messages — `packages/vscode/src/gitCommit.ts:67` (protocol §4 says
  server-side; not migrated yet).
- Key-validation probes — `packages/cli/src/ink/Setup.tsx:161-162` and the
  extension's `settingsTestConnection`, both deliberately host-side (the
  bootstrap case, settled by protocol §4's setup caveat and re-confirmed in
  the chat-migration commit).

"The last major *stateful* subsystem" would be accurate. Nothing downstream
depends on the difference, but it changes what "finishing Phase 3" means.

### 4. The framing's guess about where the answer lands is right, but for a
different reason than it expects

The framing hopes the vector store can live server-side and dissolve the
serialization question. It can, and it does — but not for free, and not
because the store needs moving. `VectorStore` is *already* in
`packages/core` and already fully host-agnostic (`store.ts`, zero host
imports). What is host-side is that **each host constructs and owns an
instance** (`packages/cli/src/agentSession.ts:39`,
`packages/vscode/src/extension.ts:81`), and one consumer has a real reason
to keep owning one — see §2.3 and §4.

---

## 1. What actually crosses the wire, concretely

### 1.1 The three model calls

There are exactly three, and they are shaped very differently.

**Embedding — indexing.** `provider.embeddings({ model, input })` in batches
of `EMBED_BATCH = 16` (`packages/cli/src/rag/indexer.ts:22`, `:196-204`;
`packages/vscode/src/rag/indexer.ts:21`, `:201-209`).

- In: up to 16 strings, each `context + path + text` for one chunk. Measured
  average chunk text is 1,972 chars (max 28,991) — so a batch is roughly
  **30 KB of text**.
- Out: `number[][]` — 16 × 768 floats.
- Volume: the index is built one file at a time
  (`indexOne`, CLI `:146`, ext `:150`), and only chunks whose hash changed
  are embedded (the cache at CLI `:174-181`, ext `:175-182`). Per-file
  chunk counts on this repo: median 2, p90 8, max 118. So the common call
  is **one batch of 1-8 chunks**, not a bulk upload.
- A cold full index of this repo is 852 chunks ≈ **54 embedding HTTP calls**
  and ~1.7 MB of chunk text in, ~2.6 MB of raw vector out.

**Embedding — query.** `provider.embeddings({ model, input: [text] })`
(CLI `:241`, ext `:238`). One string in, **one 768-float vector out**. Once
per semantic search.

**Reranking.** `rerankHits(provider, model, query, hits, k)`
(`packages/core/src/rag/rerank.ts:16`, called at CLI `:258`, ext `:260`).

- In: the query plus `RERANK_CANDIDATES = 20` snippet previews truncated to
  `PREVIEW_CHARS = 500` (`rerank.ts:5`, `:7`, `:26-31`) — about **10 KB of
  prose**, built from `SearchHit[]`.
- Out: `maxTokens: 64` of comma-separated integers (`:50`), parsed into
  picked indices (`:54-57`). **It returns a permutation, not scores** — the
  returned `SearchHit`s are the same objects passed in.
- Volume: at most one call per semantic search, skipped entirely when
  `hits.length <= keep` (`:24`) or no rerank model is configured (CLI `:253`,
  ext `:256`).

**Contextualisation.** `contextualizeChunks(provider, model, path, content, chunks)`
(`packages/core/src/rag/contextualize.ts:16`, called at CLI `:189`, ext `:196`).

- In: a `MAX_FILE_CONTEXT_CHARS = 4,000` slice of the file plus batches of
  `BATCH = 10` chunk previews at `MAX_CHUNK_PREVIEW_CHARS = 400` (`:4-6`,
  `:27-39`) — about **8 KB per call**.
- Out: one short line per chunk, `maxTokens: 60 * batch.length` (`:58`).
  Returns `string[]`, one blurb per chunk, `''` on any failure (`:24`,
  `:68-71`).
- Volume: only for chunks that need re-embedding anyway. **Off by default in
  the extension** (`heapcode.rag.contextualRetrieval`, default `false`,
  `packages/vscode/package.json:520-524`), **always on in the CLI** (no
  gate; the call is unconditional at `:187-194`). Only 4 of 852 records in
  the measured index carry a blurb.

### 1.2 What the *callers* actually consume

This is the part that decides §2, and it is easy to miss by reading the
indexer instead of its callers.

| Caller | Wants | Touches `record.vector`? |
|---|---|---|
| `semantic_search` tool, CLI (`packages/cli/src/agent/workspaceTools.ts:236-246`) and ext (`packages/vscode/src/agent/workspaceTools.ts:389-398`) | `queryFormatted()` — **a formatted string** | No |
| Agent-run `@workspace` preamble (`packages/cli/src/ink/App.tsx:1105`) | `queryFormatted()` — a string | No |
| Chat `@mentions` and chat's own executor (`packages/vscode/src/chatViewProvider.ts:981`, `:1246`) | `queryFormatted()` — a string | No |
| Inline edit's related-code block (`packages/vscode/src/inlineEdit.ts:120`) | `queryFormatted()` — a string | No |
| CLI `/search` (`packages/cli/src/ink/App.tsx:814-817`) | `SearchHit[]`, reads only `path`, `startLine`, `endLine`, `score` | No |
| Ghost text (`packages/vscode/src/completionProvider.ts:208-221`) | `SearchHit[]`, reads only `path`, `startLine`, `endLine`, `text` | No |
| Status bar / `/index` (`packages/vscode/src/extension.ts:123`, CLI `:59-66`) | `{ state, files, chunks }` | No |

**Not one consumer of RAG reads a vector.** Every single one wants either a
formatted string or a hit's path/lines/text. The vectors exist purely as
`VectorStore`'s internal scoring input (`store.ts:83-95`, `:103-122`).

A concrete size check, on the measured index: 20 candidate hits serialised
as JSON with their vectors is **374,856 bytes**; the same 20 hits with
`vector` omitted is **50,530 bytes**. The vectors are 87% of a payload
nobody reads.

---

## 2. The serialization question

### 2.1 Base64 in the JSON message

Evaluated against §1's real numbers rather than the assumed ones:

- **Query path:** one 768-dim vector, 4,096 base64 chars vs 16,199 JSON
  chars. Utterly irrelevant either way over a unix socket, once per search.
- **Indexing path:** a full cold index of this repo is 2.6 MB of vectors —
  3.5 MB base64, 13.8 MB as JSON numbers. Over a unix socket, spread across
  54 calls, even the 13.8 MB figure is not a performance problem; NDJSON has
  no line-length limit (`packages/core/src/server/ndjson.ts:32-49`) and
  backpressure is already honored (`:57-59`, wired through in the server per
  protocol §5).

**So base64 is acceptable at these sizes — comfortably.** It is also
strictly better than the status quo encoding, which is a good argument for
adopting it in `VectorStore.serialize()` *regardless* of what the protocol
does: it would cut the on-disk index from 15.6 MB to about 5 MB.

But note what this does and does not buy. It only matters if vectors cross
at all, and §2.3 says they need not.

### 2.2 A binary sideband

What this would concretely cost, against the framing that exists:

- `NdjsonChannel` (`packages/core/src/server/ndjson.ts`) is 65 lines and
  assumes one JSON object per line, with `\n` as an unambiguous separator
  because `JSON.stringify` never emits a raw newline (`:9-12`). Interleaving
  length-prefixed binary frames breaks that assumption outright — the parser
  would need a mode switch and a byte-count state machine, and the "you can
  `tee` the stream to a file and read it" property that protocol §1 chose
  NDJSON *for* would be gone.
- A second socket avoids touching `NdjsonChannel`, but adds a second
  address, a second accept path, a second auth handshake (the per-launch
  token check, `server.ts:114` and protocol §3), correlation ids between the
  two channels, and a new failure mode where one channel is up and the other
  is not.
- Either way `RpcPeer` grows a reference/claim mechanism, and every client
  — including the Kotlin one Phase 4 assumes is thin — has to implement it.

For a payload whose worst case is a few megabytes on a **local socket**,
this is straightforwardly not worth it. I don't think this is a close call
and I don't think it needs Sid's time.

### 2.3 Vectors never leave the server

**This is what the code actually supports, and it makes §2.1 and §2.2
mostly moot.** The evidence, re-verified:

- `VectorStore` is already in `packages/core` and already host-agnostic
  (`packages/core/src/rag/store.ts` — no host imports, no fs, no vscode).
  Phase 1's extraction claim holds; nothing needs extracting.
- Its persistence is a single string in and a single string out
  (`serialize()` `:137`, `deserialize()` `:146`) — exactly the shape
  `RepoMapStore` already uses (`packages/repomap/src/indexer.ts:32-35`).
- Every consumer wants text or hit metadata, never a vector (§1.2).

So the server can hold the store, run `hybridSearch` (`:103`) and the rerank
against it, and return formatted text or vector-free hits. Nothing about
that requires an encoding decision. **The hard problem does mostly dissolve
— say so plainly, because it does.**

**But there is one genuine exception, and it is load-bearing.**

Ghost text calls `rag.keywordSearch()` on the **automatic** (typing) trigger
(`packages/vscode/src/completionProvider.ts:208-210`). That path is:

- purely in-memory — `store.keywordSearch` (`:129-135`) → `bm25Scores`
  (`packages/core/src/rag/bm25.ts:29`), which reads only `record.context`
  and `record.text` (`:34`) and **never touches `record.vector`**;
- synchronous, zero I/O, zero model calls — chosen precisely so it fits
  inside the typing debounce window (the comment at
  `completionProvider.ts:192-194` says so, and `store.ts:124-128` repeats
  it);
- on a path protocol §4 deliberately kept host-side on latency grounds.

Moving the store server-side puts a socket round-trip on a keystroke
deadline — the exact thing §4 refused to do for the model call. That is the
one real tension in this whole note, and it is not resolved by any encoding.

The good news is that BM25 needs no vectors, so the split is clean if it is
wanted: a host could keep a **vector-free** copy of the records (path,
lines, text, context, hash) purely for `keywordSearch`. On the measured
index that is 1.8 MB rather than 15.6 MB, and it is a projection of data the
host is already sending up anyway (§3). It is also, honestly, a second copy
of an index — see Open Question 2.

One cost worth knowing before assuming the local path is obviously faster:
`bm25Scores` re-tokenises **every record on every call** (`bm25.ts:34-43`)
— on this repo that is 852 records × ~2,000 chars per keystroke-triggered
completion. It is "free" only in the sense of not doing I/O. A socket
round-trip to a server holding a warm index is not obviously worse, but
nobody has measured either, and I am not going to assert a winner from
reading the code.

---

## 3. Where the indexer's other host-specific pieces sit

### 3.1 `repomap`'s seam covers RAG's file access almost exactly

Re-verified against the current tree rather than assumed. `FileSource` is
`list(): Promise<string[]>` + `read(rel): Promise<Uint8Array>`
(`packages/repomap/src/indexer.ts:26-29`). Compare what RAG's indexers do:

| Need | `RepoMapIndexer` | `RagIndexer` |
|---|---|---|
| Enumerate | `opts.files.list()` (`:143`) | CLI: `fg(...)` inline (`indexer.ts:112-122`); ext: `findFiles` + `filterIgnored` (`:121-122`) |
| Read one file | `opts.files.read(rel)` (`:165`) | CLI: `readFile(join(root, rel))` (`:150`); ext: `workspace.fs.readFile(uri)` (`:154`) |
| Size guard | `MAX_FILE_BYTES` 200 KB (`:12`, `:166`) | identical constant and check (CLI `:20`, `:151`; ext `:19`, `:155`) |
| Binary guard | `content.includes('\0')` (`:168`) | identical (CLI `:153`, ext `:157`) |
| Change detection | `fnv1a(content)` vs stored hash (`:175-176`) | identical (CLI `:160-161`, ext `:163-164`) |
| Extension filter | same `CODE_EXTENSIONS` regex (`:10-11`) | byte-identical regex (CLI `:18-19`, ext `:17-18`) |
| Persistence | `RepoMapStore` — string in/out (`:32-35`) | `VectorStore.serialize()`/`deserialize()` — string in/out |
| Incremental update | `indexOne` / `removeFile` / `renameFile` (`:161`, `:186`, `:191`) | same three methods, same names (CLI `:146`, `:219`, `:224`) |

**The framing's specific worry — that incremental re-indexing on file change
is something repo mapping "may not have had to handle the same way" — is
wrong.** Both handle it identically, by the same mechanism, and both hosts
already drive them from the same call sites in lockstep:
`packages/cli/src/ink/App.tsx:340-350` and
`packages/cli/src/headless.ts:364-374` call
`ragIndexer.indexOne`/`renameFile`/`removeFile` and
`repoMapIndexer.indexOne`/`renameFile`/`removeFile` in the same `switch`.
The extension drives both from `onDidSaveTextDocument`
(`packages/vscode/src/rag/indexer.ts:41-45`,
`packages/vscode/src/rag/repoMapIndexer.ts:45-52`).

`RagIndexer` predates the seam and simply was not converted. It has no
requirement the seam does not already meet.

### 3.2 But the seam is a *host-process* interface, not a protocol one

This is the part that actually needs designing, and it is bigger than the
serialization question the task was framed around.

**The server has never touched the workspace filesystem.** `session.root` is
stored (`packages/core/src/server/session.ts:34`) and logged
(`server.ts:152`) and used nowhere else. The only `node:fs` in the whole
server directory is the token file (`server.ts:114`), the daemon log
(`daemon.ts:24`), and the client reading the token (`client.ts:135`). Every
file the agent reads or writes goes back to the host over `tool/execute`.

Moving indexing server-side breaks that invariant. Two ways out:

**(a) The server reads the filesystem directly** (`nodeFileSource` from
`@heapcode/repomap/node` already exists and would work as-is). Justified by
protocol §6's colocation rule — the server runs where the extension host
runs, including under Remote-SSH/WSL/Dev Containers. Cheap, no new protocol.
Two caveats: it silently assumes the workspace is a real `file:` path, which
the extension checks elsewhere (`extension.ts:92` gates `ShadowGit` on
`scheme === 'file'`) but `RagIndexer` does not; and it means ignore-rule
evaluation moves too, where the CLI uses `loadIgnoreMatcher`
(`packages/cli/src/agent/ignoreFiles.js`) and the extension uses
`findFiles` + `DEFAULT_IGNORE_GLOB` + `filterIgnored` — two different
implementations that would have to converge on one.

**(b) `FileSource` becomes a protocol seam** — `files/list` and `files/read`
as server→host requests. Preserves the invariant and works for virtual
filesystems, at the cost of ~200-3,000 round-trips per full index (files
enumerated, then read one at a time). Over a unix socket that is survivable
but it is a lot of chatter for a background job, and it puts 1.5 MB of file
content on the wire that (a) avoids entirely.

I lean to **(a)**, with an explicit `file:`-scheme gate that falls back to
"no RAG" the way the extension already falls back to "no shadow git".

### 3.3 Two more prerequisites that are easy to miss

**Chunking needs tree-sitter wasm in the server process.** `chunkFile`
(`packages/core/src/rag/chunker.ts:75`) tries AST chunking first, and
`configureAstChunker` is a **module-global** (`astChunker.ts:38-52`) that
each host sets at startup: `packages/cli/src/cli.tsx:24` and
`packages/vscode/src/extension.ts:49`. Neither `packages/core/src/server/daemon.ts`
nor either host's `src/daemon.ts` calls it. Left unfixed, server-side
indexing would silently fall back to the line-window chunker for every
`.ts`/`.tsx`/`.js`/`.py` file, changing chunk boundaries — and since the
embedding cache key is `fnv1a(path:text)` (`chunker.ts:60`), **that
invalidates the entire cache and re-embeds the whole repo**, with no error
message anywhere. The fix is one line in the daemon; both hosts' esbuild
already copy the wasm to `dist/wasm/` next to `dist/daemon.js`
(`packages/cli/esbuild.mjs:17-24`, `:32`;
`packages/vscode/esbuild.mjs:17-23`, `:34`).

**Role-redirect resolution does not exist server-side.** `Session` resolves a
profile *by name* (`session.ts:50-58`), and `agentRun.ts:37`/`:79` and
`chatSend.ts:33` are its only callers. Nothing implements the
`<role>Profile` redirect that `RoleResolver.resolveRoleProfile`
(`packages/cli/src/provider/roles.ts:30-33`) and
`ProfileManager.resolveRoleProfile` (`packages/vscode/src/profileManager.ts:164-169`)
do today — and RAG is the feature that uses it most (`embeddingsProfile`,
`rerankProfile`, `contextProfile`;
`packages/core/src/config/profiles.ts:48-55`). The server has the profile
list already (`HelloParams.profiles`,
`packages/core/src/server/protocol.ts:104`), so this is a small addition —
`session.providerForRole(role)` — and it is exactly the collapse of two
duplicate resolvers the custody note predicted as an incidental win
(custody §recommendation, point 4). But it is work, and it is a prerequisite,
not a consequence.

---

## 4. What moves server-side, what doesn't

Protocol §4 shape 5 says server-side. That still holds, and §1-§3 strengthen
it: indexing is a background batch job with no latency budget, it makes the
index shareable between two windows on one workspace (protocol §6's main
argument for a shared process), and the vectors genuinely never have to
cross.

**Moves server-side:**

| Piece | Why |
|---|---|
| `buildIndex` / `indexOne` / `removeFile` / `renameFile` | Background, batch, no latency budget |
| The embedding calls, both index and query | Needs the key; that's the whole point |
| `contextualizeChunks`, `rerankHits` | Already in core, already provider-only, invisible to hosts (protocol §4 shapes 3-4) |
| `VectorStore` ownership + `hybridSearch` / `search` | Where the vectors are produced and consumed |
| `queryFormatted` | Every consumer wants exactly this string (§1.2) |
| Index persistence | Follows the store |

**Has a genuine reason to stay host-side:**

| Piece | Why |
|---|---|
| `keywordSearch` on the ghost-text automatic trigger (`completionProvider.ts:210`) | Keystroke deadline; same reason §4 kept ghost text's model call host-side. Needs no vectors and no key, so keeping it host-side costs nothing in custody terms. |
| The `indexOne`/`removeFile`/`renameFile` **triggers** | The host is what knows a file changed — `onDidSaveTextDocument` (ext `indexer.ts:41`) and post-tool sync (`App.tsx:340-350`, `headless.ts:364-374`). The work moves; the trigger stays and becomes a notification. |
| The status surface | `extension.ts:121-123` status bar, `App.tsx:1002` `/index`, `:316` progress. Rendering. Becomes an event. |

Everything else in RAG is host-agnostic already.

---

## 5. Recommendation

**Move RAG server-side with the vector store, and do not add any binary
encoding to the protocol.** Concretely:

### 5.1 Serialization: nothing new is needed

Vectors never cross. If a future feature needs them to, base64 is the answer
and §2.1's numbers say it is comfortable — but adding it now would be
designing for a caller that doesn't exist.

Separately, and independently of the protocol: **switch
`VectorStore.serialize()` to base64** (`store.ts:137-153`). It is a 4×
on-disk saving (15.6 MB → ~5 MB on this repo) with a `version: 2` bump
alongside the existing `version: 1` guard at `:149`. Not a prerequisite, not
part of this migration, worth its own small commit.

### 5.2 Protocol surface: three methods, following the existing patterns

```
→  rag/query      { text, k? }                    →  { formatted, hits: HitMeta[] }
→  rag/index      { paths?, full? }               →  { files, chunks, embedded }
→  rag/status     {}                              →  { state, files, chunks }
←  rag/event      { kind: 'progress'|'state', … }    (notification)
```

- `rag/query` is request/response with no callbacks — the shape
  `provider/listModels` has (`protocol.ts:220-227`). `HitMeta` is
  `SearchHit` minus `record.vector`: `{ path, startLine, endLine, text,
  score }`. `formatted` is exactly today's `queryFormatted` output, so the
  `semantic_search` tool's host half becomes one call and the CLI's
  `/search` reads `hits`.
- `rag/index` covers both `buildIndex` (`full: true`) and the incremental
  triggers (`paths: [...]`). A rename is a `removeFile` plus an `indexOne`
  today (CLI `:224-227`), so it needs no third shape.
- `rag/status` is request/response; `rag/event` carries the progress the
  CLI's `onProgress` (`App.tsx:316`) and the extension's `onStatus`
  (`extension.ts:182`) render today. Progress is a notification for the same
  reason deltas are (protocol §5).
- Cancellation: `agent/cancel` is run-scoped; a long index run wants the same
  treatment. Simplest is `rag/index` carrying a `runId` and reusing
  `agent/cancel`, rather than a fourth method.

`semantic_search` inside `tool/execute` becomes: server issues
`tool/execute` → host calls `rag/query` back to the server → host returns
the string. That is a needless out-and-back. Better: the server dispatches
`semantic_search` **itself**, the way it already dispatches the persona
`run_command` guard and sub-agent recursion, and the hosts drop the
`semanticSearch` injection at `agentSession.ts:45`,
`controller.ts:357`, `chatViewProvider.ts:981` and `:1246`. That is a real
simplification, and it is the same shape the delegate/persona work already
took.

### 5.3 Prerequisites, in order

1. **`configureAstChunker` in the daemon** (§3.3). One line. Must land
   first, or the first server-side index silently re-embeds everything with
   different chunk boundaries.
2. **Role-redirect resolution in `Session`** (§3.3) — `providerForRole(role)`
   honouring `<role>Profile`, falling back to `key/request` for a redirect
   target whose key wasn't pushed at hello (protocol §2 already designed this
   path, and named RAG as the case that would need it first).
3. **A `FileSource` for the server** (§3.2) — recommend option (a), the
   existing `nodeFileSource`, plus a `file:`-scheme gate. This also decides
   whose ignore rules win.
4. **Convert `RagIndexer` to the `repomap` seams** (§3.1) so the two
   indexers stop being two file-access implementations. This is a Phase-2
   style extraction and should be **its own commit before the protocol
   work**, per the roadmap's one rule.
5. **Then** the protocol methods.

`VectorStore` itself needs nothing — it is already in the right package with
the right shape. That part of the framing's worry is simply already done.

### 5.4 One behavior decision the migration cannot avoid making

The two hosts' RAG do not behave the same, and a single server-side
implementation has to pick:

| | CLI | Extension |
|---|---|---|
| Contextual retrieval | always on (`indexer.ts:187-194`) | off by default (`package.json:520-524`, gate at `indexer.ts:190`) |
| Hybrid search | always on (`:247`) | setting, default on (`:245-247`) |
| Rerank | always on when a model exists (`:253`) | setting, default on (`:252`, `:256`) |
| Auto-index at startup | always (`App.tsx:314-320`) | setting `rag.autoIndex`, default on (`extension.ts:360-363`) |
| `ready` | `chunkCount > 0` (`:69`) | `embeddingsModel && chunkCount > 0` (`:64`) |
| Index location | `~/.heapcode/projects/<hash>/rag-index.json` (`agentSession.ts:38-39`) | `context.storageUri` (`extension.ts:67`, `:81`) |

Per the roadmap's one rule ("silent unification is a product change wearing
a refactor's clothes"), these are decisions, not details. My reading: push
the toggles to the host as `rag/index` and `rag/query` parameters — they are
policy, and the chat migration set the precedent of leaving host policy
host-side (the toolset, the resolved persona). The index *location* is
different: it has to become one path keyed by workspace root, which orphans
existing extension indexes and costs those users one silent re-index. That
is small (54 embedding calls here) but it is a real one-time cost and should
be logged, not hidden.

---

## Open questions — need a human decision

1. **Does ghost text keep a host-side BM25 index, take the round-trip, or
   lose repo context on the automatic trigger?** (§2.3.) This is the one
   genuine tradeoff in the note and I'm not going to pick for you. Keeping a
   host-side copy means two indexes and a sync question. Taking the
   round-trip puts I/O on a keystroke deadline that protocol §4 explicitly
   protected. Dropping the context degrades a shipped feature. It also
   deserves a measurement first: `bm25Scores` re-tokenises all 852 records
   per call (`bm25.ts:34-43`), so "local is faster" is an assumption, not a
   fact.

2. **If ghost text keeps a host-side index, who owns keeping it fresh?**
   The vector-free projection is ~1.8 MB and changes on every `indexOne`.
   Pushing it eagerly is chatty; rebuilding it lazily means it is stale
   exactly when the user is typing fastest.

3. **Direct filesystem access from the server, or `FileSource` over the
   protocol?** (§3.2.) I recommend direct. It is a real widening of what the
   server touches — today it touches nothing in the workspace — and that is
   Sid's call, not mine, especially given how carefully §6 drew the
   colocation line.

4. **Whose ignore rules win?** The CLI uses `loadIgnoreMatcher`; the
   extension uses `findFiles` + `DEFAULT_IGNORE_GLOB` + `filterIgnored`. One
   server-side implementation means one answer, and the two are not
   obviously equivalent.

5. **Where does the shared index live, and is a one-time re-index for
   extension users acceptable?** (§5.4.) `~/.heapcode/projects/<hash>/` is
   the obvious answer given protocol §6's shared-server decision, but it
   moves data out of VS Code's own storage.

6. **Do the four behavior toggles stay host policy or become server
   defaults?** (§5.4.) I lean host policy, matching the chat migration, but
   contextual retrieval in particular is a genuine divergence — one host does
   it always, the other never — and somebody has to say which is right.
