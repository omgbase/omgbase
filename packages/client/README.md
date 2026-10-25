# @omgbase/client

A typed, browser-safe client, session and command layer over omgbase's **minimal MCP surface** — the ten tools an app and its elements share: `query`, `query_syntax`, `docs_read`, `docs_tree`, `blocks_resolve`, `changes_since`, `plan`, `execute`, `apply`, `version`. It depends on `@modelcontextprotocol/sdk` (and its required peer `zod`) alone; nothing from `@omgbase/core` enters a bundle built on it.

Still `private: true` — it is consumed from the workspace while the Explorer demos (`examples/graph-ui`, `examples/repo-explorer`, `examples/live-tail`, `examples/attn`) move onto it; each of those carries its own copy of this client today.

The registrations in `packages/core/src/mcp/server.ts` are the wire truth this package types; `spec/surface` §4 is the contract behind them.

## Install / import

```ts
import { OmgClient, OmgError, classifyError } from "@omgbase/client";
import { setBlockAttr, setFrontmatter } from "@omgbase/client/effects";
import { CommandLog, taskCheckCommand } from "@omgbase/client/commands";
```

## The client

```ts
const client = new OmgClient({
  url: "/mcp",                 // the MCP endpoint; relative URLs resolve against the page (or `baseUrl`)
  repo: "notes",               // optional: the slug every repo-scoped call carries unless the call names its own
  authProvider,                // optional: the SDK's OAuthClientProvider — a 401 runs its flow, surfaced as AuthRequiredError
  clientInfo: { name: "my-app", version: "1.0.0" },
  onSessionLost: (e) => toast("reconnected"),
});
```

### Session

- `connect()` opens the session now (every call opens it on demand); `close()` drops it; `connected` says whether one is open.
- **Recovery.** A Streamable HTTP server forgets a session (a proxy after its idle timeout or a restart) and answers the next POST with 404 — or relays a `-32000 unknown session` body. The SDK does not re-initialize; the client does: the failing call drops the session, opens a fresh one against the same URL and retries **once**. Concurrent failures share the one reconnect; `recoveries` counts them; `onSessionLost` fires once per recovered session. A second failure reaches the caller.
- `finishAuth(code)` completes an OAuth redirect through the SDK transport (the OAuth implementation itself stays in the app).
- `transportFactory` (tests) injects any `Transport` in place of the SDK's Streamable HTTP client.

### Calls

- `call<T>(name, args)` — any tool. Decodes the envelope (`{ content: [{ type: "text", text: <JSON> }], isError? }`), returns the parsed body (the text itself when it is not JSON), throws `OmgError` for an `isError` result. A repo-scoped tool gets the client's default `repo` unless `args.repo` names one; `repo: null` omits the argument (the server's default repo). A tool the server's profile hides is the JSON-RPC `unknown tool <name>`, surfaced as `OmgError` code `unknown_tool`.
- `tools()` — the names the server lists.
- `capabilities()` — one `version` + one `tools/list` per session, cached: `{ engine, version, surface, profile, tools, minimal, canWrite /* apply listed */, canPlan /* plan + execute listed */ }`.

Typed methods (each sends exactly the tool's arguments, no `undefined` keys):

| Method | Tool | Notes |
| --- | --- | --- |
| `query(oqx, { limit, cursor, bare, repo })` → `QueryResult` | `query` | a discriminated union on `consumer`: `collect`/`first`/`single` carry `hits` (and `values` for a `values` projection); `count` carries `count`; `exists`/`none` a boolean |
| `queryAll(oqx, { max = 2000, pageSize = 500, repo })` → `Hit[]` | `query` | follows `cursor` while `truncated` |
| `querySyntax(section?)` | `query_syntax` | the card `{ syntax, sections }`, or `{ section, syntax }` |
| `docsRead({ _id \| _path }, { includeIds, repo })` → `DocsReadResult` | `docs_read` | `_raw`, `properties { frontmatter, inline, computed }`, `rev`; with ids: `ids`, `hashes` (the `expect.content_hash` tokens), `parents` |
| `docsReadAt(locator, rev, { repo })` → `DocsReadAtResult` | `docs_read { at }` | bytes as of a revision; no `include_ids` |
| `docsTree({ path, depth, files, updated, limit, cursor, budgetTokens, repo })` | `docs_tree` | directory rollup `{ prefix, depth, total, files_here, entries, truncated, cursor }` |
| `blocksResolve(term, { limit, repo })` → `ResolveHit[]` | `blocks_resolve` | **the body is a bare array** `[{ _id, locator, preview, evidence }]` |
| `changesSince({ cursor, limit, origin, repo })` | `changes_since` | `{ digests, cursor, truncated, head }`; `cursor`/`head` are numeric seqs; `origin` ∈ `api \| observed \| import` |
| `apply({ effects, select, expect, reason, repo })` → `Receipt` | `apply` | `{ plan_id, commit, revisions: [{ _id, _path, _hash }], new_ids, committed, summary }` |
| `plan({ effects, select, expect, diffs, repo })` → `Plan` | `plan` | `preview.summary`; `preview.diffs` only with `diffs: true` |
| `execute({ plan_id } \| { plan_id, effects, select?, expect? } \| { plan }, reason?, repo?)` → `Receipt` | `execute` | the id form uses the server's plan memory (`plan_unknown` when it has none) |
| `version()` → `VersionInfo` | `version` | `profile: "full" \| "minimal"` |

### Errors

`OmgError { code, message, data, retriable, tool, fix }` — the server's envelope plus the tool called; `fix` is `data.fix` when the engine offered a literal corrected call (a JSON string of arguments, optionally prefixed by another tool's name).

`classifyError(e)` → one of seven classes a UI can act on:

| Class | When |
| --- | --- |
| `auth` | `AuthRequiredError` / the SDK's `UnauthorizedError` |
| `capability` | `unknown_tool` (hidden by the profile), `repo_not_found`, `provider_unavailable`, `embedder_failed`, `unsupported_plan_version` |
| `transport` | a lost session (`isSessionLost`), a network failure — any non-SDK `Error` that is not an `OmgError` |
| `stale` | `stale_plan`, `plan_mismatch`, `stale_expectation`, `plan_unknown` — read again and re-plan |
| `write` | the planner's and kernel's refusals (`conflicting_effects`, `ambiguous_target`, `selection_too_large`, `type_mismatch`, `path_taken`, …), and any read-shaped code raised by `apply`/`plan`/`execute` (a `set` on a missing document, a malformed effect's `filter_invalid`) |
| `query` | `filter_invalid`, `budget_exceeded`, `doc_missing`, `block_missing`, `target_missing`, `revision_archived`, … from a read |
| `unknown` | an unrecognized code, an SDK `McpError` that is not `unknown tool`, a non-`Error` value |

Predicates: `isSessionLost`, `isUnknownTool`, `isStale`, `isAuthRequired`, `isRepoNotFound`.

## Effects (`@omgbase/client/effects`)

Builders that return exactly the wire object of `plan`/`execute`/`apply.effects` (spec/mutate §11), targets in the explicit form:

- targets: `documentTarget("/a.md" | { _id } | { _path })`, `blockTarget(id)`, `nodeTarget(id)`, `sectionTarget(headingId)`, `newSymbol(n)` (`$new.n`)
- blocks: `setBlockAttr(id, "checked", value, { contentHash })`, `setBlockMarkdown(id, md, { contentHash })`, `insertMarkdown(into, at, md, { parentChildrenHash })`, `removeBlocks(ids, expectMap)`, `moveBlocks(ids, into, at, { parentChildrenHash })`
- documents: `setFrontmatter(doc, key, value, { revision })`, `unsetFrontmatter(doc, key, { revision })`, `setContent(doc, body, { revision })`, `createDocument(path, md, frontmatter?)`, `moveDocument(doc, to, { retargetInbound })`, `removeDocument(doc)`

A guard is spelled only when given: `expect: { content_hash }` for a block, `expect: { revision }` for a document, `expect: { parent_children_hash }` for a destination parent. A failed hash guard is `stale_expectation`; a failed revision guard is `stale_plan`.

## Commands (`@omgbase/client/commands`)

A session-local undo/redo log (nothing is persisted). Three kinds:

- **`view` / `query`** commands change client state and carry `redo()` (the forward action; `run` calls it first) and `undo()` closures — `localCommand(kind, label, redo, undo, { coalesceKey })`.
- **`repository`** commands write through `apply`:
  - `apply(ctx, { redo, previous })` performs the write and returns `Applied { receipts, revisions, state }` — the receipts, the touched revisions, and whatever post-state the compensation needs (a block's new hash, the key's previous value). On redo it runs again with **fresh preconditions** (`previous` is what the first run applied).
  - `compensate(ctx, applied)` is asked at undo time and must **re-check its preconditions against the current repository** — re-read the block's hash, the document's revision — returning `{ effects, reason }` to commit or `{ refused: why }` when the world moved on. Undo is a new forward write, never a rollback.

`CommandLog(ctx, { limit = 200 })`:

- `run(command)` — the newest history entry; consecutive commands sharing a `coalesceKey` fold into the last entry while it is still applied and unsealed (one drag = one entry with many steps). A run drops the redo stack. `seal()` ends a group.
- `undo()` — the most recent applied (or partial) entry. A repository entry's steps are compensated **in reverse, every compensation computed first**, and committed as **one** `apply`; one refusal refuses the whole undo and leaves the entry applied (`state: "refused"`, off the undo path). A `stale` error from the commit is a refusal too; any other error leaves the entry applied with `error` recorded (retry is possible).
- `redo()` — the most recently undone entry, every step re-applied in order with fresh preconditions.
- `canUndo` / `canRedo` / `nextUndo` / `nextRedo` / `history` / `subscribe((event, log) => …)` (events `run`, `undo`, `redo`, `seal`, `clear`).

Entry states are honest: `applied`, `partial` (a multi-step `apply` threw `PartialFailure(applied, cause)` after committing some steps — the entry is undoable over what landed; `ctx.report(progress)` is the per-step hook), `undone`, `failed` (nothing was applied; not undoable), `refused` (still applied; its compensation refused). The entry keeps the **intent** (`steps[].command`) apart from **what was applied** (`steps[].applied`) and from the undo's `compensation` receipt.

Two commands every Explorer needs ship with the module:

- `taskCheckCommand({ blockId, checked, contentHash, repo?, coalesceKey? })` — `set _attrs.checked` pinned to the hash the UI read (a redo re-reads it); the compensation re-reads `blocks { select _hash where _id == … }` and refuses when the block is gone or is no longer the one the write produced.
- `frontmatterCommand({ doc, key, value, repo?, coalesceKey? })` — set (or, with `value: undefined`, unset) one key, pinned to the document's revision at read time; the compensation re-reads and refuses when the key no longer holds the value the command wrote.

```ts
const log = new CommandLog({ client });
await log.run(taskCheckCommand({ blockId: hit._id, checked: true, contentHash: doc.hashes[hit._id] }));
const entry = await log.undo();           // → state "undone", or "refused" with entry.refusal
```

## Document and relation commands (`@omgbase/client/commands-documents`, `@omgbase/client/commands-relations`)

The commands the Explorers share on top of the log — one guarded `apply` each, each with a compensating undo that re-reads the repository and refuses when the write it made has moved on:

- `createDocumentCommand({ path, markdown?, frontmatter?, repo? })` — one `create` effect (`path_taken` when a document or file is already there), then a `docs_read` whose `_raw` and `rev` guard the undo (the document is removed only while its bytes are still what creation produced). `defaultMarkdown(path, title?)` is the starter body (one H1 from the file name — `titleFromPath`); `creationError(e, path)` reads the errors a create can hit into one line; `rootedPath` / `pathStem` are the path helpers.
- `relationKinds(edges, extra?)` — the kinds a connector should offer, from the RENDERED graph's edges (`{ provenance, field }`, `EdgeProvenance`): the frontmatter fields by frequency then name, then `extra` fields not already present, then the body link; never empty. `fieldCounts(edges)` is the per-field count the picker shows dimmed; `listPathFields(frontmatter)` names a document's own path-valued fields (a path or wikilink, or a non-empty list of them) — what a host passes as `extra` for the connector's source.
- `attachRelationCommand({ from, to, toTitle?, how, repo? })` — ADDITIVE, always: `how: { kind: "frontmatter", field }` makes an absent field `[to]`, appends `to` to a list, turns a scalar path into `[scalar, to]` (a non-path scalar is refused, an already-related destination fails before writing); `how: { kind: "body-link" }` appends a `[title](/to.md)` paragraph and remembers the inserted block's id and hash. Values are written as rooted paths. The forward write is pinned to the source's revision; the compensation refuses unless the field (or the block) still holds exactly what the write produced.
- `detachRelationCommand({ from, to, how, blockId?, repo? })` — the field without `to` (unset when that empties it), or the body link's block removed by its hash (`blockId` required); undo restores the field, or re-inserts the block's source at the END of the document.
- `describeRelation(how, from, to)` / `describeDetach(how, from, to)` — the one-line labels; `isPathValue`, `namesDocument`, `attachedValue`, `detachedValue` are the pure value rules.

## Facts worth knowing about the surface

- Every repo-scoped tool takes an optional `repo` slug; `query_syntax` and `version` do not. An unknown slug is `repo_not_found`.
- The error envelope always carries `retriable`.
- `blocks_resolve` returns a bare array, not `{ hits }`.
- `changes_since` cursors are numeric commit seqs (per repo), not strings; `docs_tree` and `query` cursors are opaque strings.
- `execute` also accepts `select`/`expect` (the digest form) and `reason`.

## Scripts

`pnpm --filter @omgbase/client build | test | lint | typecheck`. The tests run the client against a fake omgbase MCP server over the SDK's `InMemoryTransport` (`src/fake-server.test-support.ts`): the ten tools, the real envelope, stale guards, and a session-loss switch.

## License

MIT
