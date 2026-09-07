# omgbase — Sync Plugins (Source Reconciliation Protocol)

**Status:** normative design, `proposed`. As-built: the **filesystem** source is implemented behind this seam in `packages/core/src/sync/` (§7); the git/github/linear sources of §8 are illustrative and unbuilt.
**Depends on:** `01-architecture.md` §6 (checkpoints), `03-reconciliation-spec.md` §8 (sync pipeline placement), `02-data-model.md` §3 (repos), `11-cli.md` §3.3 (freshness sweep, watch lease).

---

## 1. Purpose

`sync` in omgbase is not "read files from disk." It is **reconciliation between an external source scope and an omgbase repo**. The filesystem is one source among many; git, GitHub, and Linear are others. This document defines the plugin seam that makes the source pluggable while the engine's storage, identity, history, graph, and query model stay source-independent.

```text
external source scope
        ↓
   sync source (plugin)
        ↓
   omgbase repo  (blocks · revisions · commits · edges · properties)
```

A **repo** is therefore defined by a **source plugin + a source-specific scope + a sync policy**. The repo remains the authority/namespace/versioning boundary regardless of which plugin backs it (`02-data-model.md` §3: the `repos` table).

## 2. What is engine-owned vs source-owned

The single most important boundary in this design. The engine already computes everything it needs from `(repoId, path, content)` — `ingestFile` hashes the content itself (`file_hash = sha256(content)`), reconciles against the prior revision, writes blocks/revisions/commits/edges/properties, and runs the convergence check. **None of that is filesystem-specific and none of it moves into a plugin.**

| Concern | Owner | Why |
|---|---|---|
| Enumerate the scope | **source** | only the source knows its members |
| Transport bytes (`content`) | **source** | only the source can read upstream |
| Change feed (what changed since when) | **source** | only the source observes its own events |
| Cheap-change token (`revision`) | **source** | the source's own idea of "did this change" |
| Content-hash echo suppression | **engine** | `sha256(content)` vs stored `file_hash` |
| Reconciliation (block identity) | **engine** | only when the source's identity is *inferred* (§4) |
| Commit boundaries + checkpoint row | **engine** | the durable log is engine truth |
| Convergence check | **engine** | `file_hash == rendered_hash` is an engine invariant |
| Format decomposition (bytes → blocks) | **engine** (format adapter) | a *different* axis, chosen by path/format |

Corollary: **format adapters and sync sources are orthogonal plugin axes.** A source transports bytes; a format adapter decomposes them. A Linear issue arrives via the `linear` source and its markdown `description` is still decomposed by the markdown adapter.

## 3. The contract

A sync source is a value implementing `SyncSource`. Its filesystem-only surface — the operations `attach`, `checkpoint`, `freshness`, and `watch` actually exercise today — is:

```ts
interface SyncSource {
  capabilities(): SourceCapabilities;

  /** The full current scope as (path, revision) pairs. Replaces the initial walk. */
  enumerate(): Iterable<SourceEntry>;

  /** Current state of one member, or null if it left the scope (a delete). */
  fetch(path: string): SourceItem | null;

  /** Subscribe to change batches; returns a stopper. Push sources implement this. */
  watch?(onBatch: (paths: string[]) => void, opts?: { debounceMs?: number }): SourceWatch;

  // --- write-through (only when capabilities().writeThrough) ---
  /** Persist engine-authored bytes back to the source. */
  write?(path: string, content: string): void;
  /** Remove a member from the source. */
  remove?(path: string): void;
}

interface SourceEntry {
  /** Storage key: repo-relative canonical path (documents.path). */
  path: string;
  /** The source's cheap change-token. Equal ⇒ unchanged ⇒ engine no-op. */
  revision: string;
  /** Source locator, when it differs from `path`. Defaults to `path`. (§6) */
  sourceId?: string;
}

interface SourceItem extends SourceEntry {
  /** The bytes handed to ingestFile. The engine hashes these itself. */
  content: string;
}

interface SourceWatch {
  stop(): Promise<void> | void;
  /** Force any pending batch to flush now (sync_flush). */
  flush(): void;
}
```

Sources need not implement every operation; `capabilities()` advertises what is real. A read-only source omits `write`/`remove`. A poll-only source omits `watch` and the driver polls `enumerate` instead.

### 3.1 The `revision` token is the pivot

`revision` is the source's answer to "did this member change, cheaply?" It powers **echo suppression at the source layer**, before any byte read:

- filesystem: `revision` derives from `(mtime_ns, size)` (a stat, no read); the content hash is the engine's second, authoritative gate.
- git: the blob SHA.
- GitHub/Linear: the entity's `updated_at` / version field / ETag.

The driver stores the last-observed `revision` per member. On a change signal it compares tokens; equal ⇒ skip without fetching. This is the generalization of the filesystem freshness sweep's `(mtime_ns, size)` cache — which is why that cache belongs **inside** the filesystem source (§7), not in the engine.

## 4. Capabilities: the two flags that change engine behavior

```ts
interface SourceCapabilities {
  /** Does the source carry stable per-member identity, or must the engine infer it? */
  identity: "inferred" | "borne";
  /** Can the engine push its own mutations back to the source? */
  writeThrough: boolean;
  /** Optional: kinds/resources the source exposes (for future multi-resource sources). */
  resources?: string[];
}
```

- **`identity: "inferred"`** — the source hands over anonymous bytes with no stable sub-document identity (filesystem, raw git blobs). Block continuity across revisions must be *inferred* by the reconciler (`03-reconciliation-spec.md`): the probabilistic matcher, dispositions, the ≥0.995 precision gate. This is the *only* reason that machinery exists.
- **`identity: "borne"`** — the source hands over stable IDs (Linear UUIDs, GitHub node IDs). The engine maps `sourceId → block/doc identity` deterministically and **skips the matcher entirely**. Running it would be wrong, not merely wasteful. (Borne-identity ingestion is closer to the API-mutation "operations" path than the filesystem "dispositions" path — `01-architecture.md` correction #2 turns out to be a special case of this rule.)

  *v1 status:* the driver has one code path (`inferred`), matching filesystem. `borne` is defined here so the reconcile call is written as *conditional on capability* rather than unconditional — the hook a future source slots into — but no `borne` source ships in v1.

- **`writeThrough: true`** — engine-authored writes (`apply`, doc ops) round-trip to the source. Filesystem writes files; the resulting change event is then **echo-suppressed** by revision/hash match (that is the whole reason echo suppression exists). A read-only source is `writeThrough: false`, and local edits to its projection are proposals subject to a future `validate`/`update` path (§8), not authority.

## 5. The driver: one reconciliation loop for every source

The engine exposes a source-agnostic **driver** that consumes a `SyncSource`. It replaces the filesystem bodies of `attachRepo` and `processCheckpoint` with one implementation:

```text
reconcile(source, repoId, paths?):
  members = paths ? paths.map(source.fetch) : source.enumerate()+fetch
  for each member:
    if member == null:                      → deleted   (tombstone doc)
    else if revision == last_observed:      → no-op      (source-layer echo)
    else:
      content = member.content
      if sha256(content) == stored file_hash: → suppressed (engine-layer echo)
      else if capabilities.identity == "inferred":
        ingestFile(reconcilingResolver)     → observed commit + dispositions
      else: /* borne */
        ingestFile(deterministic id map)    → observed commit (no matcher)
      record last_observed = revision
  one checkpoint row over the batch
  convergence check per ingested doc (engine invariant, unchanged)
```

The two-layer echo suppression (cheap `revision`, then authoritative content hash) is deliberate: `revision` avoids a fetch; the content hash is the correctness gate that guarantees convergence even if a source's token is coarse or lies.

## 6. `path` vs `sourceId`

Today `documents.path` is both the storage key and the filesystem locator; they coincide. For a borne-identity source they will not (Linear's locator is a UUID; its `path` is synthesized, e.g. `issues/ENG-123.md`). The contract returns both as distinct fields — `SourceEntry.path` (storage key) and `SourceEntry.sourceId` (source locator, defaulting to `path`) — so:

- filesystem sets them equal and nothing changes;
- a borne source can map `sourceId → path` however it likes **without a storage-schema migration**.

This one bit of hygiene is what keeps §8 additive. Persisting the `sourceId ↔ path ↔ last_revision` mapping durably is a §8 concern (borne sources need it); v1 filesystem keeps its map in the source's private cache (§7) because path *is* the locator.

## 7. Filesystem source (as-built v1)

`FilesystemSource implements SyncSource`, absorbing every `node:fs` touch that previously lived in `attach.ts`, `checkpoint.ts`, `freshness.ts`, and `watcher.ts`:

- `capabilities()` → `{ identity: "inferred", writeThrough: true }`.
- `enumerate()` → recursive walk of the root for `*.md` (skipping `.omgbase`/`.git`/`node_modules`), yielding `{ path, revision }` where `revision = "${mtime_ns}:${size}"`.
- `fetch(path)` → `existsSync` ? `{ path, revision, content: readFileSync }` : `null`.
- `watch(onBatch)` → chokidar, debounced to quiescence (default 750ms), emitting repo-relative `.md` paths.
- `write(path, content)` / `remove(path)` → the file-first write protocol (`04 §6`).
- **Cheap-change cache** — the `file_stats` table (`(mtime_ns, size, hash)`) stays exactly as-is but is now conceptually **owned by the filesystem source**: it is that source's private implementation of the `revision` comparison in §3.1. No schema change. The freshness sweep becomes "the filesystem source's `enumerate` + revision-diff feeding the generic driver."

The public library exports consumers already depend on — `attachRepo`, `processCheckpoint`/`CheckpointResult`, `freshnessSweep`/`rebuildFileStats`/`recordFileStat`/`SweepResult`, `Watcher`/`WatcherOptions` — are **preserved as thin wrappers**: each constructs a `FilesystemSource` and calls the generic driver. Behavior, results, and the CLI surface are unchanged. The refactor is internal.

## 8. Future sources (illustrative, unbuilt)

Sketches to validate that the seam generalizes; none ship in v1.

```yaml
# repo config carries the plugin + scope + policy (a future repos.settings shape)
repo: product-source
sync: { plugin: filesystem, source: { root: ~/src/product }, include: ["**/*.md"] }
---
repo: product-github
sync: { plugin: github, source: { owner: acme, repository: product }, include: [files, pull_requests, issues] }
---
repo: product-linear
sync: { plugin: linear, source: { workspace: acme }, scope: { teams: [ENG] }, include: [issues, documents] }
```

Additional contract operations these need, deferred out of v1:

- `changesSince(cursor)` — poll-based incremental feed (webhook/API sources) as an alternative to push `watch`.
- `normalize(resource)` — project an upstream representation into Doc/Block/Node records (delegating markdown fields to the format adapter).
- `validate(localState)` — can a local projection be represented upstream? Produces the `invalid-local-projection` outcome.
- `create` / `update(sourceId, patch, expectedRevision)` / `delete` / `move` — capability-gated write-through with the source's own concurrency semantics.
- `materialize(resource, format)` — optional local file projection. **Explicitly not the default mental model:** for non-filesystem sources the graph/query value exists without ever writing a local file; materialization is a convenience, and treating it as central drags filesystem assumptions back in.

Reconciliation outcomes generalize beyond the filesystem's create/update/delete to: `create · update · move/reparent · remove-from-scope · delete/archive · conflict · invalid-local-projection · no-op`. Different systems have different notions of identity, deletion, movement, revision, and authority; the outcome set is where that variety surfaces.

## 9. Multi-repo is the payoff

One workspace DB already holds many repos (`02 §3`). Once a repo = (plugin + scope + policy), a single workspace can hold `product-source` (filesystem), `product-github`, and `product-linear` side by side, and the prize is **cross-repo edges**: a Linear issue → a GitHub PR → a markdown doc, traversed in one `graph_traverse`. That requires cross-repo query, which today's `query(store, repoId, …)` hard-scopes against and the MCP server binds one repo per session. Cross-repo addressing is out of scope for this document (it is a query/MCP surface change, not a sync-plugin change) but is the reason the seam matters: **the source plugin makes heterogeneous repos possible; a cross-repo query surface makes them useful.**

## 10. Invariants (unchanged by this seam)

The engine invariants of `README.md` §Invariants hold identically regardless of source. In particular: convergence (`sha256(file) == rendered_hash`) is checked by the engine after every ingest; identity dispositions are stamped only on the `inferred` path; commits/dispositions remain append-only. A sync source can only *report* changes and *transport* bytes — it can never write a commit, mint identity, or bypass the convergence check.
