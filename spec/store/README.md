# The omgbase store specification

The store is the embedded SQLite database that owns the **current state and
the identity** of a repository of authored files and — through the history
**recorder**, a capability the core calls inside its own transaction — an
append-only **capture** of every accepted transition (revisions, commits,
the dispositions the matcher recorded). Files stay the source of truth for
*content*; the core adds stable block ids, the current bytes of every
document on its own rows, and the derived indexes the query surfaces read.
At quiescence `sha256(file) == docs.file_hash`. **Since 17.0 no current-state
read touches a history table** (`docs/modular-core/`, Phase 3): the head
token, the frontmatter raw, every block's bytes and every timestamp are
columns of the current rows, and the recorder's tables are checked to
*agree* with them (§8 H1–H3) rather than consulted. Through Phase 3 legacy
capture stays on for every repository, so the recorder's rows are still
written on every commit. This directory
specifies the database so that more than one engine can open the **same
file** and, given the same sequence of observed changes, write the **same
rows**. It is owned by neither implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/core` (TypeScript, npm) | `packages/core/src/core/store`, `core/ingest.ts`, `core/hash.ts`, `core/ids.ts`, `core/order-key.ts`, `core/read/document.ts`, `sync/observe.ts`, `sync/reconciling-ingest.ts`, `sync/tombstone.ts`, `mutate/materialize.ts` | **Reference.** Store decisions land here first. |
| `omgbase-store` (Rust, crates.io) | `crates/omgbase-store` | Conformance-first port. Opens the same databases, passes the same fixtures. |

The spec is four artifacts, versioned together by `VERSION`:

- this `README.md` — what the tables mean, the canonical encodings, the
  observe/commit procedure as an exact rule, the invariants, the fixture
  contract;
- `schema.sql` — **the DDL**, verbatim. Both implementations embed this text
  and execute it on a fresh database. It is the one artifact that is already
  language-neutral; nothing may paraphrase it.
- `archive.sql` (15.0) — the DDL of an **archive segment** (§7 "Retention"),
  verbatim, embedded the same way: the file `history export` writes.
- `cases/*.json` — the executable fixtures. **When prose and fixtures
  disagree, the fixtures win**, and the prose gets fixed.

The design rationale is `docs/data-model.md` and `docs/architecture.md`; this
document is the as-built contract.

## What "language-neutral" means for a database

Three things, in decreasing order of how much they pin:

1. **One file, two engines.** The database is the interface. An engine opens a
   database the other engine created, at the same `user_version`, and reads
   and writes it without migration. So the DDL is shared text (`schema.sql`),
   the meaning of every column is fixed here, and the encodings that both
   engines must compute identically (hashes, canonical tree serialization,
   order keys, timestamps, visible text) are exact rules.
2. **Durable state is a function of the observed events.** Given an empty
   database and a sequence of observations — "the bytes at `path` are now
   `source`", "`path` is gone", "sweep the pool at time *t*" — the durable
   tables (§3.1) are determined **up to the values of minted ids**, and the
   derived tables (§3.2) are determined by the durable ones. Fixtures are
   therefore *scripts* of observations with a reference-generated projection
   of the resulting tables, run with a deterministic id minter (§2.2) so ids
   compare too.
3. **Invariants every runner checks** on every resulting database (§8): the
   convergence law `sha256(source) == rendered_hash == docs.file_hash`, byte
   reconstruction from both the live blocks and the Merkle tree, hash
   integrity of blobs and tree nodes, full reachability (nothing to collect),
   dense sequences and ordinals, and rebuild equivalence of the derived
   tables.

What this spec does **not** cover, because those are other components with
their own inputs: the rows of the **properties** table (`spec/properties`
owns them; §5.4 step 9b says when the store writes them), **nodes**,
**external_nodes**, **edges** and **doc_edges** (`spec/graph` owns them;
step 9c), **FTS** and **embeddings** (search), the **sync registry**
(`adapters`, `sources`, `attachments`, `sync_state`, `workspace_settings`,
`file_stats`, `checkpoints`) and the mutation kernel's **`api`-origin
commits**. Their tables are part of `schema.sql` (an engine must create them
and leave them alone), but their semantics are not pinned here; a runner
ignores their rows. Fixtures are Markdown only (`format = 'markdown'`).

## Versioning

`VERSION` is `<major>.<minor>`. **The major is the schema version** — the
`PRAGMA user_version` every database carries (`17`), so a reader of a
database knows which spec it conforms to. The minor counts semantic changes
that need no migration: how a row is filled, an encoding, the observe
procedure. The `omgbase-store` crate is `<major>.<minor>.<patch>`, exactly as
`oqx`, `omgbase-format` and `omgbase-reconcile` track their specs; its first
release is on the 13.x line. The reference lives inside `@omgbase/core`,
which has its own version line; its `SCHEMA_VERSION` equals the major here.
A major ships both engines together: an engine that opens a database from a
newer major refuses it (§1 step 3) rather than reading tables it does not
know, so a mixed-version workspace fails safely and no published engine can
corrupt a newer one's database.

- **DDL changes** (a table, column, index or constraint added, removed or
  changed) bump the major, add a migration (§3.4) and a `migrations` fixture.
- **An encoding an older engine cannot read** bumps the major too, DDL or
  not: 16.0 changed no DDL, but a `{`-form tree node (§4.1 "Delta nodes") is
  garbage to a 15.x reader, and only `user_version` keeps that reader out
  (§1 step 3). Its migration step is empty (§3.4).
- **Semantic changes** without DDL (a column filled differently, an encoding
  an older engine still reads, the observe procedure, the pool expiry) bump
  the minor.
- A fixture that pins existing behavior is neither.

## The rule for changing the store

**Fixture first, TypeScript (reference) second, Rust third.** A behavior
change without a fixture is not done. Fixture *inputs* (observation scripts,
migration pre-states) are authored by hand; each case's `expect` is
*generated* by the reference (§9) and reviewed as code — a changed `expect` is
the statement of the change. A divergence found by the port is adjudicated by
the prose here: when the prose is silent, write the rule, and fix whichever
implementation disagrees with it (§10 records the reference oddities the port
has surfaced and the decisions taken on them).

## 1. Placement and connection

One database per workspace at `<workspace>/.omgbase/omgbase.db`. An engine
opens it with `journal_mode = WAL`, `synchronous = NORMAL`,
`foreign_keys = ON`, and registers one SQL function, `cosine(a, b) → REAL`
(the similarity over two float32 vector blobs that the query layer's
`semantic()` uses; deterministic; `NULL`-safe). All writes go through a single
serialized writer connection; one transaction per commit. `:memory:` is a
valid path (tests, fixtures); the WAL pragma is still issued and SQLite
answers `memory`.

Opening a database:

1. Read `user_version`. `0` → execute `schema.sql`, set `user_version` to the
   major of `VERSION`.
2. Equal to the major → done.
3. Greater → refuse: `database schema (v<n>) is newer than this build
   (v<major>); upgrade omgbase`.
4. Less → apply the migrations §3.4 in order, each in its own transaction,
   then set `user_version`.

## 2. Identifiers, hashes, time

### 2.1 Ids

Minted ids are `<prefix>_<7 chars>`, the characters lowercase Crockford
base32 (`0123456789abcdefghjkmnpqrstvwxyz`, no `i l o u`) from a CSPRNG.
Prefixes: `d` document, `b` block, `c` commit, `r` revision — since 17.0
the **head token** the core mints on every change to a document (§5.4 step
6, D1), which the recorder's `revisions.rev_id` equals while capture is on
— `x` external node, `col` collection (reserved, no table), `e` edge, `rp`
repo, `v` projection (reserved), `src` source, `s` archive segment (15.0, §7
"Retention"), `ep` the repository **epoch** (17.0, §3.1 `repos`, §7.4 — the
feed's `seq` is dense within it). `cp` (checkpoint) is retired with the
`checkpoints` table (17.0, D4): nothing mints it. Ids are repo-scoped, never reused, never re-assigned. An id is opaque: nothing may parse anything but its prefix out
of it, and `isValidId` accepts exactly `^[a-z]+_[alphabet]{7}$`.

**Uniqueness at mint (13.5; 17.0 over `id_claims`).** 32⁷ ≈ 3.4 × 10¹⁰ is
small enough for the birthday bound to matter: two random draws among *n*
collide with probability about n² / (2 · 32⁷) — 5 % at 60,000 blocks,
near-certain at 360,000 (§10: a 3,000-document corpus failed its first
ingest on a duplicate `block_id`). The store therefore never lets a
production mint return an id that is **in use**: one it has already issued
in this process, or one that is **claimed** — and redraws until it finds one
that is not. Since 17.0 (`docs/modular-core/` Phase 3b — M3, D5) the claim
is a row of **`id_claims`** (§3.1): `(id, repo_id, prefix, minted_at,
holders)`, one per id the core has minted. **Every core mint writes its
claim in the transaction that writes the row carrying the id, before that
row** — `d` with the doc row (§5.4 step 2), `c` with the feed row (step 5),
`r` with the head (step 6), `b` with the block rows (step 9: an id that was
neither a live row of the document, nor pooled, nor evicted from another
document is new), `x` and `e` with the graph rows (step 9c), `rp`, `ep` and
`src` with the registry rows (`minted_at` the clock there; a source is
workspace-scoped, so its `repo_id` is NULL) — with `minted_at = ts` and
`holders = 1`. A mint whose
transaction rolls back leaves no claim (the id is simply never used); the
claim is written **after** the minter yielded, so the fixture minter's
sequence (§2.2) is exactly what it was. `holders` is a bitmask: **bit 0
(`1`) the core**, set at mint and released only by the claims prune (§7.3);
**bit 1 (`2`) the recorder**, set when the capture first writes a row
naming the id — its `revisions` row names the head and the document, its
`block_changes` rows the blocks, its `commits` row the commit — and released only by `history purge`
(Phase 3e), never by the squash. A row leaves `id_claims` only when no
holder remains. **An id whose rows are gone stays in use as long as any
holder keeps its claim**: this replaces the `blocks ∪ block_changes ∪
resurrection_pool` probe of 13.5–16.x and the squash's
keep-the-earliest-`block_changes`-row rule (15.0), so `block_changes` is a
pure projection again (§7.1). The probe is **one statement** for every
core-minted prefix — `SELECT 1 FROM id_claims WHERE id = ?` — for `d`, `b`,
`c` (17.0, slice 3d: the core mints the commit id with the feed row, §5.4
step 5, and claims it there; the recorder's `commits` row sets bit 1), `r`,
`x`, `e`, `rp`, `src` and `ep` (the epoch, claimed with the repo row at the
clock). One prefix is still claimed by the row it lands in, probed in its
table: `s` in `archives` (the recorder mints it for the export; its row is
its own evidence). `cp` is retired (D4: `checkpoints` is gone). `col` and `v`
have no table and no check. A redraw is unobservable except through the
fixture device of §9.4 (`"minter": "repeat"`). The fixture minter itself
(§2.2) is sequential over a fresh database and never collides; the check
runs for it too, at no cost to the ids.

**Reuse (D5).** With the recorder on, a pruned claim keeps its row under
bit 1 and the id can never be minted again. With history off — or after
`history purge` — a claim the prune deletes (§7.3) is unknown to the probe
and the id MAY be minted again, once nothing in the store names it and the
installation's `identity.claims_retain_days` has passed. This is the
documented consequence of making claims prunable: a reused id can only
misdirect an **unguarded** read by name — every guarded write fails
`stale_expectation`/`target_missing` (`spec/mutate` §4), since the head
token and the content hashes of the old row are gone with it.
`claims::pruned-claim-with-no-holder-is-deleted` pins the row's absence; the
reference's `claims.test.ts` pins the re-mint.

### 2.2 The fixture minter

Fixtures cannot carry CSPRNG ids, and the store's hashes (§4.1) *contain*
block ids, so the ids must agree for the tree hashes to agree. A runner
therefore replaces the minter with a **sequential per-prefix counter**:
`d_0, d_1, …`, `b_0, b_1, …`, `c_0, …`, `r_0, …`, each prefix counting from 0
independently, reset at the start of every case. Every implementation must
let its minter be replaced (the reference through a seam in `core/ids.ts`;
the crate through a `Minter` trait). The **order of mint calls** is part of
this spec and is stated where each id is minted (§5). Production ids are
opaque; the fixture minter is a runner device that makes them comparable.

### 2.3 Hashes

Every hash is SHA-256. Columns of type `BLOB` hold the 32 raw bytes; fixtures
carry 64 lowercase hex characters; a "hex" in prose means that. `raw_hash` is
over a block's `raw` bytes and `norm_hash` over its visible `text`
(`spec/format` §4.2); the tree-node hash is over the canonical entries
serialization (§4.1); `rendered_hash`/`file_hash` are over the whole file's
UTF-8 bytes. Display form (where a surface shows a hash) is the first 16 hex
characters; nothing in the store truncates.

### 2.4 Time

Every timestamp column (`docs.created_at`/`updated_at`/`deleted_at`,
`blocks.created_at`/`updated_at`/`deleted_at`, `resurrection_pool.created_at`/
`deleted_at`/`expires_ts`, `id_claims.minted_at` — 17.0 — `commits.ts`,
`checkpoints.ts`) is RFC 3339 UTC with
exactly three fractional digits and a `Z`: `2026-09-26T14:03:07.250Z`
(JavaScript's `Date.toISOString()`). A caller supplies `ts` for an
observation; the store stores it verbatim — every `*_at` column of the rows
a commit writes is that `ts` (§5.4) — and derives `expires_ts = ts + 30
days` (30 × 86 400 000 ms), formatted the same way.
Timestamps compare as strings, so the format is load-bearing. A `ts` not in
this format is a caller error; the reference only notices when it derives
`expires_ts` (a pool write), a port may reject it up front.

## 3. Schema

### 3.1 Durable tables

The tables of `schema.sql` this spec fills:

| Table | One row per | Meaning |
| --- | --- | --- |
| `repos` | repository | `repo_id`, unique `slug`, `settings` JSON (defaults `{}`), **`epoch`** (17.0, D7 — a minted `ep_` id, claimed with the row (§2.1): the feed's `seq` is dense **within an epoch**, a cursor is the pair `(epoch, seq)`, and a cursor from another epoch is expired (`spec/surface` §3). Minted at `ensure_repo`; a **restore** or a **rebuild-from-files** re-mints it and starts the feed over (§7.5 — the rule and the store's `remint_epoch`; no production path of the reference takes it yet). A repo owns identity and history, not a filesystem; where its bytes come from is the sync registry's business. |
| `docs` | path ever seen in a repo | `doc_id`; `path` (repo-relative, no leading slash, unique per repo); `format`; **`head`** (17.0, D1 — the head token: an `r_` id the core mints on every change to the document — content, structure, path or liveness, §5.4 step 6; `NULL` only before a new row's first commit, never for a live doc; equal to the recorder's `revisions.rev_id` while capture is on; `current_rev` through 16.x); `file_hash` (of the bytes the head renders to — §5.4 step 12); `conflicted` (0/1, git conflict markers seen); `leading_trivia` (bytes before the first block); **`frontmatter_raw`** (17.0, D10/M1 — the frontmatter block's raw, fences included, `NULL` when the document has none: the current value, never a delta — through 16.x the current frontmatter lived only in the head revision's `frontmatter_blob`); `frontmatter_trivia` (the frontmatter block's trailing trivia, `NULL` when the document has no frontmatter); **`created_at`** (17.0, D6 — the identity's birth: the first commit's `ts`; survives tombstone and revival); **`updated_at`** (the `ts` of the commit that last minted the head — content, structure, path or liveness: a move and a tombstone count); **`deleted_at`** (the tombstone's `ts`, `NULL` = live; `deleted_commit` through 16.x). A path keeps its `doc_id` across deletion and re-creation (§5.6). |
| `blocks` | live block of the **current** head | The hot table: `block_id`, `doc_id`, `parent_block` (`NULL` at top level), `order_key` (§4.3), `ordinal`, `depth`, `ancestor_path` (§4.3), `type`, `attrs` JSON, `text` (visible text, `spec/format` §4.1), **`raw`** (17.0, D10 — the block's raw source, inline; through 16.x only `blobs` held it), `raw_hash` (= `sha256(raw)`: the CAS and dedup key), `norm_hash`, **`trivia`** (the trailing trivia, `NULL` = none), `trivia_hash` (= `sha256(trivia)`, `NULL` when `trivia` is), **`created_at`** (17.0, D6 — the identity's birth, carried: the previous live row's for a carried block, the pool row's for a resurrected one, the evicted row's for a cross-document move, the commit's `ts` for an inserted or lineage-minted one — §5.4 step 9), **`updated_at`** (the block's own last change: the commit's `ts` unless the block's verdict is `same`, 14.2's rule), **`deleted_at`** (always `NULL` since 17.3 — a tombstone DELETES the document's rows, D2 step two; 17.0–17.2 wrote the tombstone's `ts` here and the 17.x finish step deletes those rows on open, §3.4 step 17 (15); the column stays for the two partial indexes). `created_commit`/`deleted_commit` are gone (M2). Rebuilt wholesale by every commit to the document (§5.4); a tombstoned document keeps **no** `blocks` row — its pool rows (§5.6 step 2), its claims (§2.1) and the recorder's last captured revision carry what revival, identity and history need. |
| `blobs` | distinct byte string | **The recorder's** (17.0, D10): content-addressed, `hash = sha256(bytes)`, `size = |bytes|`. Holds every block `raw`, every non-empty trivia, every frontmatter block — and, since 16.0, every **frontmatter delta** (§4.1 "Delta nodes": a `{"f":…}` text a revision's `frontmatter_blob` may name instead of the raw). Written only by the capture (§5.4 step 15), read only by the history reads (§6.2) — no current read touches it; with legacy capture on the head's bytes are therefore stored twice, on the rows and here. Never deleted except by the §7 sweep. |
| `tree_nodes` | distinct sibling list, full or delta | Content-addressed Merkle node: `hash = sha256(entries)`, `entries` the canonical serialization §4.1 — a `[`-form full list, or (16.0) a `{"d":…}` **delta** over the same list of the document's previous revision. Identical subtrees share a row; identical deltas do too. |
| `revisions` | (document, commit) | `rev_id`, `doc_id`, per-document `seq` from 1, `root_tree` (a `tree_nodes.hash` — a full or a delta node), `frontmatter_blob` (a `blobs.hash` — the raw or a delta — or `NULL`), `rendered_hash`, `path` at this revision, `commit_id`, `archive` (15.0: `NULL` for a live revision; the `segment_id` of the archive segment holding its bodies once the retention squash moved them — then `root_tree` and `frontmatter_blob` are `NULL` too, §7 "Retention"; the row itself never leaves). Since 15.0 the two body columns are nullable and carry no foreign key. A `{`-form body is meaningful only in this row's context (`doc_id`, `seq`): §6 resolves it against revision `seq − 1`. |
| `archives` | archive segment the repo knows (15.0) | The registry `history list` reads: `segment_id` (a minted `s_` id, the segment's manifest id), `repo_id`, `path` (the file as recorded; `attach` re-records it), `seq_lo`/`seq_hi` (the `commits.seq` span of the segment's commits), `created_at`, `revision_count`, `bytes` (the file's size when recorded). Written by the squash transaction and by `attach`, deleted by `detach`; a revision's `archive` column may name a segment this table no longer carries (detached). |
| `feed` | commit to the repo, within retention (17.0, D7/M5) | **The core's change feed** — the delivery record `changes_since` pages (`spec/surface` §3) and the sync base rests on (`spec/sync` §6): `repo_id`, `epoch` (the repo's), `seq` (dense from 1 per `(repo, epoch)`), `commit_id` (the minted `c`, UNIQUE — the recorder's `commits.commit_id` is the same id), `ts`, `origin ∈ {api, observed, import, projection}`, `actor`, `reason`, `batch_id` (D4: the `commit_id` of the **first committing member of the same observed batch**, so a batch of one and every `api` commit have `batch_id = commit_id`), `plan_id` (the admitted plan's digest, 64 hex, for an effect-driven `api` commit — so a Receipt correlates with the documents it touched when history is off; NULL otherwise). Written by the core in the commit transaction (§5.4 step 5, §5.6 step 1); pruned by its own retention (§7.4) — "the feed is catch-up, a rescan is recovery, the log is history". Index `idx_feed_ts (repo_id, ts)` for the day floor. |
| `feed_entries` | document touched by a feed row (17.0) | `repo_id`, `epoch`, `seq` (the feed row's), `doc_id`, `path` (as of the commit), `head` (the token minted — NULL for `deleted`), `hash` (`docs.file_hash` after the commit — NULL for `deleted`), `kind ∈ {created, changed, deleted, moved}` (`created`: the doc row was inserted or revived; `moved`: the path changed, with or without a content change — D11; `deleted`: a tombstone; `changed`: everything else that minted a head), `from_path` (`moved` only). PK `(repo_id, epoch, seq, doc_id)`; leaves with its feed row. |
| `commits` | captured commit (**the recorder's**, 17.0) | `commit_id` (= the feed row's), `repo_id`, `epoch`, `seq` (= the feed row's — the two agree on every retained `seq`, H4), `ts`, `origin ∈ {api, observed, import, projection}`, `actor`, `reason`, `batch_id` (= the feed row's), `ops` (the ADR-003 intent record of an effect-driven `api` commit, M5 — the recorder's alone). Written by the recorder inside the commit transaction under the id the core minted (§5.4 step 15); never pruned (the log is history; `history purge` is Phase 3e's). `UNIQUE (repo_id, epoch, seq)`; `checkpoint_id` is gone (D4/D9). Observations write `observed` (§5); the mutation kernel writes `api`; `import` is bulk ingest with no retro history; `projection` is reserved. |
| `dispositions` | (commit, block, kind) | The matcher's decisions as persisted: `kind` (the `spec/reconcile` §2 kinds), `confidence`, `reason`, `matcher_v`, `detail` JSON. Immutable once committed (R6). `INSERT OR IGNORE` on the primary key (§10). |
| `id_claims` | id the core has minted (17.0, M3/D5) | §2.1: `id` (the primary key), `repo_id` (`NULL` for a workspace-scoped `src`), `prefix`, `minted_at` (the minting commit's `ts`; the clock for `rp`/`src`), `holders` (the bitmask: bit 0 the core, bit 1 the recorder). Written by the core with the row that carries the id, held by the recorder's capture, probed by every mint; a row leaves only when no holder remains — the claims prune (§7.3) releases the core's hold, `history purge` (Phase 3e) the recorder's. **No secondary index** (2026-10-26, §10): the primary key serves the probe; the prune (§7.3, gc-time) and the size line (§7.2, on demand) scan the table — the `(repo_id, prefix, minted_at)` index of slices 3b–3e-ii was half the bytes of every minted id. |
| `resurrection_pool` | block deleted in an earlier commit | `block_id`, `doc_id` it left, `raw_hash`, `norm_hash`, `type`, **`created_at`** (17.0, D6 — carried from the deleted row so a resurrection restores the block's birth), **`deleted_at`** (17.0 — the deleting commit's `ts`; `deleted_commit` through 16.x), `expires_ts` (= `deleted_at + 30 days`, I6 — anchored on the row's own timestamp, so the pool depends on no history table). Feeds `spec/reconcile` phase 6b; rows leave when consumed, evicted or swept; a pooled id keeps its claim (§2.1) whatever happens to the row. |
| `pending_materializations` | file the `api` path still owes the disk (14.0; self-contained since 17.0 — M4) | `repo_id`, `path` (where the file must end up; one row per path), `kind ∈ {write, rename, remove}`, `from_path` (rename: the old path, else `NULL`), `doc_id`, **`head`** (17.0 — the document's head token whose bytes `write`/`rename` leave at `path`, always its CURRENT head (C8); `NULL` for `remove`; no foreign key — `rev_id → revisions` through 16.x), `rendered_hash` (the bytes expected at `path` — for `remove`, the bytes it is safe to unlink), **`prior_hash`** (17.0 — the bytes the engine itself last wrote at `path`: the `file_hash` the commit validated the file against, captured at commit time, or inherited from the row it superseded; `NULL` when the engine never wrote there — a created document, a `remove`), `commit_id` (the `api` commit that recorded it; no foreign key since 17.0 — `commits` is the recorder's), **`created_at`** (17.0 — that commit's `ts`). Inserted by the commit transaction, deleted per file by the materializer once the file is as recorded (§5.7); the replay reads only this row and the document's current rows. Empty at quiescence; the observe path never inserts; no cap — a row lives until its path is settled. |
| `edges` | **open** link relation (17.0, M6) | `spec/graph` §3.3's table: `edge_id`, `repo_id`, `src_doc`, `src_block`, `src_field`, `predicate`, `dst_kind ∈ {document, block, external}` (`collection` struck with the `collections` table, D9), `dst_node`, `anchor`, `provenance`, `via_node`. **Open rows only**: closing an edge deletes its row; `from_commit`/`to_commit` and `idx_edges_temporal` are gone (through 16.x a closed edge stayed with `to_commit` set and every reader filtered on it), `idx_edges_src`/`idx_edges_dst` lose their `WHERE`. The interval record is the recorder's `edge_transitions`, below. Written by the reference during the commit transaction (§5.4 step 9c); pinned by `spec/graph`'s fixtures, not compared here. |
| `edge_transitions` | edge interval (**the recorder's**, 17.0 — M6) | 16.x's `edges` row verbatim — `edge_id`, `repo_id`, `src_doc`, `src_block`, `src_field`, `predicate`, `dst_kind`, `dst_node`, `anchor`, `provenance`, `via_node`, `from_commit`, `to_commit` — written when the core opens an edge (`to_commit = NULL`) and closed (`to_commit` = the commit) when it deletes one (§5.4 step 15); `dst_node` follows the open edge's in-place rewrites (phantom adoption, a move's re-phantoming — `spec/graph` §3.5) so the record reads as 16.x's table did. Index `idx_edge_transitions_temporal (from_commit, to_commit)`. Pinned by `cases/history/edge-transitions.json` (§9.5). |
| `capabilities` | (repository, capability) — the **capability manifest** (17.0, slice 3e-ii) | `repo_id`, `capability ∈ {history, semantic}`, `state ∈ {enabled, disabled}`, `interface_v` (the capability interface the writer implements: history 1, semantic 1), `data_v` (the bundle's own schema version: history 1 = 16.0's tables + `edge_transitions`, semantic 1), `config` (canonical JSON — keys sorted bytewise at every level — of the configuration the data was produced under: semantic `{ model?, dim? }` from the effective `embedding.*`, history `{}`), `config_hash` (= `sha256(config)`, the fingerprint; a change while `enabled` is a rebuild of the capability's data — semantic: a model switch, history: never), `coverage` (JSON `[{ "from": ts, "to": ts | null }, …]`: the intervals capture was on, the last open — `to: null` — iff `state = 'enabled'`), `writer_requires` (1: a writer without this module must refuse writes on the repository, §5.4 step 0 — resolution 17), `updated_at`. Rules: (1) a repository with no row for a capability is `disabled` with no coverage; (2) `coverage_from` — what `version` and `doctor --size` report — is the first interval's `from`, null when none; (3) the row is engine state, never derived from the settings on read. **Who writes it:** `ensure_repo` (§1 — both rows: `history` `enabled`, coverage from the repository's birth, `writer_requires = 1`; `semantic` `enabled` iff `embedding.provider` resolves for the repository, else `disabled` — resolution 1: stored vectors are never consulted), migration 17 (§3.4 step (13), the same for every existing repository with the history interval anchored on its first commit), the verbs `history enable|disable` (§5.9; 17.1) and `embed enable|disable` (§5.10; 17.2), and a settings write that CHANGES a repository's effective `embedding.provider` (17.2: it re-derives the `semantic` row — set → `enabled` with a new interval, unset → `disabled` with the interval closed; a write that leaves the provider as it was moves the row's `config` and hash alone and keeps its state, so `embed disable` is sticky — through 17.1 every settings write re-derived the row). `history purge` (§7.6) touches neither `state` nor `coverage`: coverage records when capture was ON, which is what tells a purged token (`pruned`) from one minted while capture was off (`outside_coverage`, `spec/surface` §2.1). A table, not settings keys: engine-written state that survives a settings rewrite, typed, projected row for row, read by `doctor` without resolving settings. |
| `alerts` | (repository, condition) — the **alert channel** (17.0, slice 3e-ii; §5.8) | `repo_id`, `code` (the condition), `severity ∈ {info, warning, error}`, `message` (one line for a human, both engines byte for byte), `since` (first raised; kept while the condition stands), `detail` (canonical JSON, `{}` when none), `cleared_at` (`NULL` = active). Raised by the engine when a condition needs a human and cleared when it ends; every MCP tool result carries the active alerts of the call's repository (`spec/surface` §4 "Alerts"), the CLI prints them to stderr (`spec/cli` §3.1), `doctor` lists them. |
| `external_nodes`, `properties`, `adapters`, `sources`, `attachments`, `sync_state`, `workspace_settings`, `file_stats` | — | Created by `schema.sql`; semantics belong to other specs. `properties` (17.0, D9: no `created_commit`/`deleted_commit` — a property row is live exactly while its document's rows are, since the commit deletes and rewrites them per document; the four indexes lose their partial predicates) is written by the reference during the same commit transaction; a runner does not compare it. `collections` and `inferred_edges` — created and never written through 16.x — are gone (D9). `sync_state` (17.0, D4) carries, beside the per-attachment rows, one reserved **status row** per repository — `(repo_id, '', '')` with `last_batch_ts`, `last_batch_id`, `last_batch_files` — written by every observed batch together with the pool sweep (`spec/sync` §4.1); the `checkpoints` table it replaces is gone. |

**The three bundles (17.0, slice 3e-i).** Every table belongs to one of
three bundles, each its own DDL file (§3.3): the **core bundle**
(`schema.sql`) — `repos`, `docs`, `blocks`, `id_claims`, `resurrection_pool`,
`pending_materializations`, `feed`, `feed_entries`, `edges`, `external_nodes`,
`capabilities`, `alerts` (3e-ii), `sections`, `doc_edges`, `blocks_fts`,
`nodes`, `nodes_fts`, `file_stats`, `properties`, `adapters`, `sources`,
`attachments`, `sync_state`, `workspace_settings` — is the current state and
the identity, read and written by the core, depending on no table of the
other two; the **history
bundle** (`schema-history.sql`) — `commits`, `revisions`, `blobs`,
`tree_nodes`, `dispositions`, `block_changes`, `edge_transitions`, `archives`
— is the **capture**, written by the recorder inside the commit transaction
(§5.4 step 15, §5.6 step 4 — since slice 3d the core mints the commit id and
writes the **feed** row, and hands the recorder its `commits` row with the
same id, epoch and seq; since 3e-i it hands it the transition's edge list
too), read by the history reads (§6.2, `docs_history`, `blocks_history`; the
disposition counts a `changes_since` summary appends when the recorder holds
the commit) and by the invariants that check they agree with the head (§8
H1–H6); the **semantic bundle** (`schema-semantic.sql`) — `embeddings`,
`doc_embeddings` — is `spec/search`'s, reached only through the semantic
provider. `changes_since` reads `feed`/`feed_entries` and never
`commits`/`revisions`; the recorder touches `id_claims` in one way: it sets
bit 1 on the claims its capture names (§2.1). **Which bundles a database
holds (17.1, Phase 4a).** The core bundle is executed on every fresh
database — alone. The **history bundle follows the manifest**: its DDL is
executed at the moment a repository's `history` row becomes `enabled` —
`ensure_repo` with the recorder present (§1), `history enable` (§5.9) — and
by the opener as a safety net when **any** repository of the database has
`history.state = 'enabled'` and the tables are absent (one database holds
every repository, so one enabled repository brings the bundle for all; the
tables are harmless when present and unused — a disabled repository's
commits never write them). A database no repository of which ever enabled
capture has no history table; a repository whose capture was switched off
keeps its rows until `history purge` (§7.6), which may drop the bundle's tables again when nothing is left. The **semantic bundle
follows the composition**, not the manifest: its DDL is executed on every
open by an engine that carries the semantic module (the module's reads —
the `available` gate, the vector cache, `omg status`'s stale count — probe
the tables without consulting the manifest, so the tables exist iff the
module is loaded); a core-only build creates none. Hence a fresh database's
fingerprint (`cases/schema.json`) is the core bundle plus the semantic
bundle: the history tables appear with the first enabled repository.

### 3.2 Derived tables

Rebuildable from §3.1 with zero information loss (§7): `sections` (§4.6),
`block_changes` (§5.4 step 15 — since 17.0 a pure projection of
`dispositions` again: no row of it is an identity claim, §2.1), `doc_edges`,
`embeddings`, `doc_embeddings`, `nodes`, and the FTS5 virtual tables
`blocks_fts`, `nodes_fts` (`inferred_edges`, never written, left with D9). This spec pins `sections` and
`block_changes`; the rest are the graph and search components'.

### 3.3 `schema.sql`, `schema-history.sql`, `schema-semantic.sql`

Three files since 17.0 (slice 3e-i), one per bundle of §3.1: `schema.sql`
(the core bundle — `DDL` in `schema.ts`, with its sub-DDL constants
expanded), `schema-history.sql` (the history bundle — `HISTORY_DDL`) and
`schema-semantic.sql` (the semantic bundle — `SEMANTIC_DDL`). The exact
statements the reference executes on a fresh database, in that order,
followed by nothing: `user_version` is set by the opener, not by a file.
Every statement is `CREATE … IF NOT EXISTS` so each file is idempotent and
can also serve as a migration target; the three table sets are disjoint and
their union is the table set 17.0's single file created minus the D9 drops
plus `edge_transitions` (the reference pins the partition in its runner). A
capability bundle's tables reference the core's (`commits.repo_id →
repos`, `revisions.doc_id → docs`), never the other way. Both
implementations embed the three texts and test that each embedded copy
equals its file byte for byte (the crate skips that test when built outside
the monorepo, like the other conformance tests). Since 17.1 (Phase 4a) the
opener executes `schema.sql` alone on a fresh database and the two bundle
files as §3.1 "Which bundles a database holds" says — `schema-history.sql`
when a repository's `history` row becomes `enabled` (and when any is, on
open), `schema-semantic.sql` on every open by an engine with the semantic
module. The FTS5 extension must be
compiled into the SQLite the engine links (both `better-sqlite3` and
`rusqlite`'s `bundled` feature include it).

`archive.sql` (15.0) is the second DDL artifact: the tables of an archive
segment (§7 "Retention") — `manifest`, and `revisions`, `commits`, `blobs`,
`tree_nodes`, `dispositions`, `block_changes` with the same columns as
`schema.sql`'s minus the foreign keys (a segment holds no `repos` or `docs`
rows; its `revisions.root_tree` is `NOT NULL`, since a segment holds bodies).
Both implementations embed it and test the embedded copy against the file
the same way; `history export` executes it on every new segment file.

`cases/schema.json` carries the **schema fingerprint** of a fresh database —
for every table (`sqlite_master.type = 'table'`, including virtual tables
**and the FTS5 shadow tables** `blocks_fts_config/_data/_docsize/_idx` and
`nodes_fts_*`, whose set the linked SQLite must reproduce; excluding
`sqlite_%` internals) its `PRAGMA table_info` rows `(cid, name,
type, notnull, dflt_value, pk)`; for every index its `PRAGMA index_list` entry
`(unique, origin, partial)` and `index_info` column names; every
`foreign_key_list` row; and `user_version` — so an implementation can be
checked without trusting its own copy of the DDL.

### 3.4 Migrations

A database at `user_version` *n* < 17 is upgraded one version at a time, each
step idempotent (it inspects before it alters), each in a transaction:

| To | Step |
| --- | --- |
| 2 | create `file_stats` |
| 3 | `documents` gains `format TEXT NOT NULL DEFAULT 'markdown'` if missing |
| 4 | `documents.frontmatter` renamed to `metadata` if present and `metadata` absent |
| 5 | create `nodes` + `nodes_fts` and their indexes |
| 6 | `documents` gains `leading_trivia TEXT NOT NULL DEFAULT ''`; `blocks` gains `trivia_hash BLOB` (each if missing) |
| 7 | `documents` gains `frontmatter_trivia TEXT` if missing |
| 8 | create `properties` and its indexes |
| 9 | create `adapters`, `sources`, `attachments`, `sync_state` |
| 10 | create `workspace_settings` and its singleton row |
| 11 | `ALTER TABLE documents RENAME TO docs` when `documents` exists and `docs` does not (SQLite rewrites the FK references) |
| 12 | create `doc_embeddings` |
| 13 | if `repos.root_path` exists: ensure the `fs` adapter row (`INSERT OR IGNORE … ('fs', 'omgbase-fs-adapter', '[]')`, even when there are no repos); for each repo with a non-empty `root_path`, find or create a source named `<slug>-fs` (`source_id` minted with prefix `src`, `adapter = 'fs'`, `config = {"root": <root_path>}`, `env = '{}'`) and `INSERT OR IGNORE` the attachment; then `ALTER TABLE repos DROP COLUMN root_path` |
| 14 | create `pending_materializations` (§5.7) |
| 15 | if `revisions` exists without an `archive` column: rebuild it — with `foreign_keys = OFF` for the duration (`pending_materializations.rev_id` references it, and the DROP would otherwise be an implicit DELETE under the FK), `CREATE TABLE revisions_v15` with `schema.sql`'s 15.0 columns (`root_tree`/`frontmatter_blob` nullable, no foreign keys on them, `archive TEXT`), copy every row with `archive = NULL`, `DROP TABLE revisions`, `ALTER TABLE revisions_v15 RENAME TO revisions`, `PRAGMA foreign_key_check` must be empty; then create `archives` (§7 "Retention"). Rows keep their `rowid` order; nothing else moves |
| 17 | **the head and its bytes on the current rows** (17.0; `docs/modular-core/` Phase 3a — M1, M2, D10, D6). In one transaction with `foreign_keys = OFF` for its duration and `PRAGMA foreign_key_check` empty at its end, three table rebuilds (`<table>_v17`, copy, drop, rename — SQLite cannot rename a column a partial index names nor add a `NOT NULL` column without a default), each copying `rowid` (`blocks_fts` is an external-content index keyed by `blocks.rowid`): (1) **`docs`** — `head = current_rev`; `frontmatter_raw` = the live head's frontmatter **resolved once** through the 16.x delta chain (§6.1 "Resolving" of 16.0; the recorder's `frontmatterAtRevision`), `NULL` without one; `created_at` = the `ts` of the commit of the doc's `seq = 1` revision; `updated_at` = the `ts` of `current_rev`'s commit (a doc with no revision: the migration's clock for both); `deleted_at` = the `ts` of `deleted_commit`'s commit, else `NULL`; `current_rev` and `deleted_commit` dropped. (2) **`blocks`** — `raw` = `blobs.bytes` of `raw_hash`, `trivia` = `blobs.bytes` of `trivia_hash` (`NULL` when `NULL`) — a hash with no `blobs` row (impossible under I5; checked) **aborts the migration**; `created_at` = `MIN(commits.ts)` over the block's `block_changes`, falling back to the `ts` of `created_commit`'s commit; `updated_at` = `MAX(commits.ts)` over them, same fallback; `deleted_at` = the `ts` of `deleted_commit`'s commit, else `NULL`; `created_commit`/`deleted_commit` dropped; `idx_blocks_doc`/`idx_blocks_type` re-created over `deleted_at IS NULL`; then, when `blocks_fts` exists, **the FTS index is rebuilt** over the new rows (17.4 — §7's rebuild: `delete-all`, then every live leaf of every live document; a 16.x index may hold every block, containers and tombstones included — the rule before `spec/search` 1.2 — and `doctor`'s `fts rows == live leaf blocks` would otherwise fail on the migrated database until a `rebuild-index --fts`; the rows keep their `rowid`s, so the external-content index stays keyed the same way). (3) **`resurrection_pool`** — `deleted_at` = the `ts` of `deleted_commit`'s commit (else `expires_ts − 30 days`, which I6 made the same value); `created_at` = `MIN(commits.ts)` over the block's `block_changes`, else `deleted_at`; `deleted_commit` dropped. (4) **`id_claims`** (3b — M3/D5) created and **backfilled** with one row per distinct id the current rows and the history still name — `d` from `docs` (`minted_at = created_at`), `b` from `blocks` and `resurrection_pool` (their `created_at`) and from `block_changes`/`dispositions` (`MIN(commits.ts)` over the rows naming it, the migration's clock when the commit is gone), `r` from `docs.head` (`minted_at = updated_at`) and `revisions` (the commit's `ts`), `x` from `external_nodes` (the earliest `edges.from_commit` naming it, else the clock), `e` from `edges` (its `from_commit`'s `ts`), `rp` from `repos` (the repo's first commit's `ts`, else the clock), `src` from `sources` (the clock, `repo_id` NULL); `holders` = bit 0 for every id a core row names (`docs`, `blocks`, `resurrection_pool`, `docs.head`, `external_nodes`, `edges`, `repos`, `sources`) plus bit 1 for every id a history row names (`revisions.rev_id`/`doc_id`, `block_changes.block_id`, `dispositions.block_id`); a source the pre-state lacks contributes nothing (the fixture pre-states are partial). So a live block's `b` is `3`, a block known only to `block_changes` `2`, a tombstoned block's with no history row `1`, an old revision's `r` `2`, a head's `3`, a repo's `rp` `1`. `c`/`s`/`cp` get no claim (§2.1). The step also runs `DROP INDEX IF EXISTS idx_claims_repo_prefix` — unconditionally, at both entry points (the 16 → 17 step and the on-open finish of a database a 3b–3e-ii build already moved to 17), so the `(repo_id, prefix, minted_at)` index those builds created leaves on the next open (2026-10-26, §10; idempotent). (5) **`pending_materializations`** (3c — M4) rebuilt self-contained, `rowid`s kept: `head` = the row's `rev_id` (the same `r_` token — the head IS the revision id the core minted), `prior_hash` = the `rendered_hash` of the revision before `rev_id` (`seq − 1` of the same document) **resolved once** from the 16.x `revisions` — `NULL` for a `remove` row, a first revision or an unknown one, `created_at` = the `ts` of `commit_id`'s commit (the migration's clock when the commit is gone); `rev_id` and both foreign keys (`revisions`, `commits`) dropped. (6) **`repos`** (3d — D7) rebuilt with **`epoch`**: one `ep` minted per repository in `rowid` order (the fixture minter: `ep_0`, …), its claim at the repo's first commit's `ts` (the epoch is as old as the feed it scopes), else the migration's clock, `holders = 1`. (7) **`feed` + `feed_entries`** created and **backfilled** from the 16.x `commits` and `revisions` (resolution 12 — what the rows say, no path reconstruction): one feed row per `commits` row `(epoch = the new one, seq = commits.seq, commit_id, ts, origin, actor, reason, batch_id = commit_id — no checkpoint grouped them, plan_id = NULL)`; entries from `revisions` joined on `commit_id` in `rowid` order `(doc_id, path = revisions.path, head = rev_id, hash = rendered_hash, kind = created when revisions.seq = 1 else changed)`; one `deleted` entry `(doc_id, path = docs.path, head NULL, hash NULL)` per `docs` row whose `deleted_at` is the commit's `ts` (a revived document's earlier deletion leaves none — its tombstone is gone); a commit with **no entry so far** whose `reason` parses as `move <from> -> <to>` (a 16.x `retarget_inbound: false` move) gets one `moved` entry for the document now at `<to>` — its current `head` and `file_hash`, `from_path = <from>` — and none when no live document is at `<to>`. Then the feed prune under the defaults at the migration's clock (§7.4 — a 1,778-commit corpus keeps every row); the `c` claims: bit 0 for every commit the feed holds (`minted_at` the commit's `ts`), bit 1 for every `commits` row. (8) **`commits`** rebuilt as the recorder's row — `epoch` (the repo's new one), `batch_id = commit_id`, `checkpoint_id` dropped, `UNIQUE (repo_id, epoch, seq)` — `rowid`s kept. (9) **`sync_state`** gains `last_batch_ts`, `last_batch_id`, `last_batch_files`; per repository the reserved status row `('', '')` is inserted from the latest `checkpoints` row by `ts` (`last_batch_ts` its `ts`, `last_batch_id` NULL — the batch id is unknowable — `last_batch_files` the `files` array's length; no row when the repository had no checkpoint); then **`checkpoints` is dropped** (its `cp_` ids get no claim — the prefix is retired). (10) **`edges`** (3e-i — M6) becomes open-only: when the history bundle is present (`commits` exists) `edge_transitions` is created (`schema-history.sql`'s text) and every `edges` row copied into it verbatim, `rowid` order; then `edges` is rebuilt with the rows whose `to_commit IS NULL` minus the two interval columns (`rowid`s kept — the rollup's sample order), `idx_edges_src`/`idx_edges_dst` re-created without their `WHERE`, `idx_edges_temporal` dropped. The `e` claims follow the rows: bit 1 on every id a transition names, bit 0 only on the ids an open row still carries (a closed edge's claim is the recorder's alone — the rule of step (4) applied to the moved rows), a claim left with no holder deleted. (11) **`properties`** (D9) rebuilt without `created_commit`/`deleted_commit`, `rowid`s kept, its four indexes re-created without their partial predicates. (12) **`collections`** and **`inferred_edges`** dropped (D9). (13) **`capabilities`** (3e-ii) created (`schema.sql`'s text) and, per repository without a `history` row (`rowid` order), the manifest written: `history` = `(enabled, interface_v 1, data_v 1, config '{}', config_hash sha256('{}'), coverage [{ from: <the ts of the repository's earliest commits row — the feed's oldest row when the history bundle is absent — else the migration's clock>, to: null }], writer_requires 1, updated_at = the clock)` — **existing repositories keep capturing** (resolution 17); `semantic` = `enabled` with `config` `{ model?, dim? }` from the effective `embedding.*` settings and one open interval from the clock when `embedding.provider` resolves for the repository, else `disabled` with `coverage []` and `config '{}'` (resolution 1 — stored vectors are never consulted; a row is always written). (14) **`alerts`** (3e-ii) created, empty. (15) **tombstoned `blocks` rows deleted** (17.3, Phase 5a — D2 step two): `DELETE FROM blocks WHERE deleted_at IS NOT NULL`, AFTER the claims backfill of (4) so a tombstoned block's identity stays claimed (`holders = 1`) and its pool row stays; run at both entry points and idempotent — a 17.0–17.2 database loses its tombstoned rows on its first open by a 17.3 engine (a data-only finish of the unreleased 17.x line, no version spent; `migrations::v16-to-v17-heads-inline-bytes-time` projects `blocks` without `b_3` and `id_claims` with it). **With their FTS entries** (17.4 — qualification finding F2): `blocks_fts` is an external-content index keyed by `blocks.rowid`, so a row deleted without the index's `delete` command leaves an orphan the index still counts. BEFORE the DELETE, in the same transaction, every tombstoned row **the index holds** — its `rowid` has a `blocks_fts_docsize` row — gets `INSERT INTO blocks_fts(blocks_fts, rowid, text) VALUES('delete', <rowid>, <the row's text>)`, in `rowid` order; a tombstoned row the index does not hold is skipped (a `delete` for an unindexed row corrupts the index's statistics). The live path's `ftsDeleteDoc` purges LIVE leaves and is not the rule here — it would purge nothing. (16) **the fidelity check** (17.4, Phase 5a-ii — qualification finding F1; §5.11): per repository in `rowid` order, for every live document with a `file_hash`, `sha256(reconstruct(doc)) == file_hash` (§6.1); the documents that fail it, in bytewise `path` order, raise the repository's **`legacy_bytes`** alert (§5.8: `warning`, the pinned message with their count, detail `{ docs: <count>, sample: [<the first 20 doc ids>] }`) at the migration's clock; none → the alert is cleared if active. Runs after (13)–(15) (the `alerts` table exists, the tombstoned rows are gone). At the 16 → 17 entry point the check runs over **every** live document (one pass of the repository's bytes, a one-time cost of the migration: step (2) copies a block's bytes from the recorder's blobs as they are, so a document ingested before block trivia was stored — schema v6 added `blocks.trivia_hash`, v7 `docs.frontmatter_trivia` — comes out with rows that do not reproduce its file, exactly as the 16.x reader read it; the file and `file_hash` were right all along). At the on-open entry point (a 17.0–17.3 database a released 17.x engine already migrated, and every later open) it runs only for a repository that carries the cheap **signature** of legacy rows — a live top-level block with a NULL `trivia` and a later top-level sibling in its document, or a live document with a `frontmatter_raw` and no `frontmatter_trivia`; `spec/format` §1 rule 4 makes both impossible for the current ingest (a `raw` never ends in a line ending, so the bytes between two top-level blocks are at least one) — so a healthy database pays one metadata scan of `blocks` per open and never hashes its bytes; a repository without the signature whose alert is active is left to the sweep and `doctor`, which re-derive the full set (§5.11). Idempotent (the raise refreshes an active row in place). `migrations::v16-to-v17-legacy-trivia` pins it over a pre-state with a legacy document and a healthy one; `v16-to-v17-heads-inline-bytes-time`'s authored `file_hash` (X'06') is not the hash of its raws, so the check names its `d_1` too — the one place the fixture's fake hash is observable. The history tables are read for the backfill and not touched (`edge_transitions` is created, not read). A 16.x reader of a 17.0 database would find no `current_rev`/`deleted_commit` column (`migrations::v16-to-v17-heads-inline-bytes-time`, which also carries a `write` and a `remove` pending row, two checkpoints, an attachment cursor row, a `move old.md -> a.md` commit with no revision — the one `moved` entry the backfill writes — and (3e-i) a closed and an open edge, two property rows with the commit columns, and empty `collections`/`inferred_edges` tables: it projects `edges` (the open row alone, no interval columns), `edge_transitions` (both rows verbatim), `properties` (without the columns) and the `e` claims — the closed edge's `2`, the open one's `3`). (A database a pre-3b, pre-3c, pre-3d, pre-3e-i or pre-3e-ii 17.0 build already moved to 17 — `docs` present, `id_claims` absent, `pending_materializations.rev_id` present, `feed` absent / `checkpoints` present / `commits.checkpoint_id` present, `edges.from_commit` / `properties.created_commit` / `collections` / `inferred_edges` present, or `capabilities` / `alerts` absent (or a repository without its manifest rows) — runs the missing parts on open; 17.0 is unreleased and each part is idempotent, so no version is spent on those states.) |
| 16 | **nothing** — no DDL, no data pass. Every node a 15.x store holds is a `[`-form list and every frontmatter blob a raw: exactly the 16.0 **checkpoint forms** (§4.4), so every existing revision is a checkpoint and the store is already a valid 16.0 database; deltas appear with the next commit to each document (§4.4 decides per revision). The step only lets the opener move `user_version`. Compare the per-key-parts branch `2f7b286`, whose migration had to split every frontmatter blob in a verified full pass: there the old encoding was *not* a valid new one; here it is, by construction (§10 Decisions, 16.0) |

The "create" steps execute the same sub-DDL text that `schema.sql` contains
for those tables. After the last step the opener sets `user_version = 17`.
`cases/migrations.json` pins these on authored pre-states (§9.3). Because
every pre-state in the fixtures is a *partial* old schema (the tables the
step touches, not a whole historical database), the expectation is the
migrated database's own fingerprint and rows, not equality with a fresh one.

## 4. Canonical encodings

### 4.1 Tree-node entries

A revision's block tree is stored bottom-up as Merkle nodes: one `tree_nodes`
row per sibling list. A node's `entries` is the UTF-8 JSON text

```text
[ [block_id, raw_hash_hex, child_tree_hash_hex | null, type, attrs_canonical, trivia_hash_hex | null], … ]
```

— an array of six-element arrays, one per block in sibling order, **no
whitespace anywhere**, strings JSON-escaped, `null` literal for a missing
child tree (a leaf) or missing trivia (empty trailing trivia).
`attrs_canonical` is the block's `attrs` as a JSON object with keys sorted
bytewise ascending (recursively), no whitespace, numbers as JSON integers
(attrs are booleans, integers and strings — `spec/format` §3). `type` is the
`spec/format` §3 kind name. The node hash is `sha256(entries)`.

Writing a tree **is the recorder's** (17.0, §5.4 step 15 — the current-state
ingest writes a block's bytes on its own row, §3.1, and puts no blob): for
each block in sibling order, put the `raw` blob, put the trivia blob when
trivia is non-empty, write the children's node first when there are
children, then build this node's entry; when every entry is built, put the
node. `INSERT OR IGNORE` on `blobs` and `tree_nodes` gives structural
sharing: an unchanged subtree is the same row. Nested blocks carry `""`
trivia (`spec/format` §1), so `trivia_hash_hex` is `null` below the top level.
The text above is a node's **full form** (`[`-form). Since 16.0 a node may
instead be stored in a **delta form**; §4.4 says when, and a writer that
always writes the full form (a 15.x engine's output) is a valid 16.0 writer.

**Delta nodes (16.0).** A sibling list — the body root, a container's
children — and a revision's frontmatter may be stored as a **delta against
the same list (the same frontmatter) of the document's previous revision**:
the revision with `seq − 1` and the same `doc_id`. The base is **implicit** —
no base hash is stored; the row's `(doc_id, seq)` is the context — which is
what keeps a delta at tens of bytes. The two forms are told apart by the
**first byte**: `[` is a full node, `{` a delta; a frontmatter blob starting
with `-` (the `---` fence `spec/format` §3 guarantees) is the raw, one
starting with `{` a delta. A body delta's `entries` is the UTF-8 JSON text

```text
{"d":[ op, … ]}
```

and a frontmatter delta's `blobs.bytes` is

```text
{"f":[ op, … ]}
```

— **no whitespace anywhere**, strings JSON-escaped as above — where an *op*
is one of

| op | meaning |
| --- | --- |
| `["=",n]` | keep the next *n* ≥ 1 items of the base |
| `["+",x]` | insert *x* |
| `["-"]` | drop the next item of the base |
| `["~",x]` | replace the next item of the base with *x* |

and *x* is, in a body delta, a **six-element entry** exactly as a full node
spells it (spliced verbatim: `["~",["b_7","<raw_hex>",null,"paragraph",{},"<trivia_hex>"]]`),
or, in a frontmatter delta, a **line** of the raw with its line ending as a
JSON string (`["~","layer: working\n"]`). The ops **consume exactly the base**
(the `=` counts, `-`s and `~`s sum to the base's length); applying them in
order yields the new list — the entries of the sibling list, or the lines
whose concatenation is the new frontmatter raw. The **items** a delta is
over: for a body node, the base list's entries as their canonical texts;
for a frontmatter, the raw's lines split after every `\n` (a `\r\n` ending
stays with its line; the last line has no ending; `""` is one empty line).

**The ops are determined.** They are Myers' shortest edit script over the
item texts — the same algorithm, with the same tie rule, that
`docs_diff_unified` uses (`spec/surface` §3; the reference's
`core/edit-script.ts`, the port's `history.rs`): the diagonal from `k+1`
(an insertion) when `k == −d || (k != d && V[k−1] < V[k+1])`, else from
`k−1` (a deletion) — grouped: a run of keeps is one `["=",n]`; inside a run
of edits the *k*-th deletion and the *k*-th insertion pair into `["~",x]`,
the surplus deletions are `["-"]`, the surplus insertions `["+",x]`. Both
engines therefore produce the same text and the same hash; the fixtures pin
it (`delta::*`), and §8 I10 re-derives every delta it finds.

**Hash and sharing.** A delta node's hash is `sha256(entries)` like any
node — content-addressed; two revisions (of one document or two) producing
the same delta text share the row (`{"d":[["=",3]]}` is one row however
often a three-entry list is carried unchanged over a non-self-contained
base). A delta is **meaningful only in the context of the revision that
names it** — directly as `root_tree`/`frontmatter_blob`, or through the
child hash of an entry its own nodes carry — because its base is "the same
list one revision earlier". Hence the one rule a writer must keep (§4.4):
**a revision reuses a node of its predecessor only when that node is
self-contained** — a `[`-form node whose every child list is self-contained
(context-free, so it means the same thing anywhere). A `{`-form node, or a
`[`-form node with a `{`-form descendant, is never referenced from a later
revision; an unchanged list over such a base writes the identity delta
`{"d":[["=",n]]}` instead.

**The child-list base.** A container's children at revision *s* are a delta
over *the children of the block with the same `block_id`* in revision
*s − 1*'s resolved tree, wherever that block sits there (a moved block keeps
its base); a block with no children in *s − 1*, or not in *s − 1* at all (a
new block, a block carried in from another document), has no base and its
children are written full. The root's base is *s − 1*'s root list; the
frontmatter's base is *s − 1*'s frontmatter raw (none when *s − 1* has
none).

**I2 restated** for a `{`-node: the hashes it must name are those of its own
`+`/`~` entries; what `=` keeps is the base revision's to name (§7 "mark").

### 4.2 Blob bytes

`blobs.bytes` is the UTF-8 encoding of the string (a block `raw`, a trivia,
the frontmatter block's `raw` including its `---` fences). `size` is the byte
length. The core's `blocks.raw`/`trivia` and `docs.frontmatter_raw` (17.0)
are the **same strings stored inline** as `TEXT`; `raw_hash`/`trivia_hash`
are their SHA-256 (§8 C2), so a row's bytes and the recorder's blob of the
same hash are byte-identical. The reference and any port must agree on UTF-8, so a lone surrogate
in the source (impossible in a valid UTF-8 file) is out of scope.

### 4.3 Sibling order and containment

`order_key` is a base-62 fractional index over the alphabet
`0-9 A-Z a-z` (`0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`,
so `'0' < 'A' < 'a'` bytewise and keys sort as strings). `key_between(a, b)`:

- `a = b = null` → `"V"` (the alphabet's middle digit, index 31).
- `b = null` (append after `a`): if `a`'s last digit is not `z`, replace it
  with the next digit; else append `"V"`.
- `a = null` (before `b`): if `b`'s first digit *d* > `0`, the single digit at
  index ⌊*d*/2⌋; else `"0" + key_between(null, b[1:] or null)`.
- Both: walk the digits from the left; while they agree, copy; at the first
  difference *da* < *db*: if *db* − *da* > 1, emit the prefix plus the digit at
  *da* + ⌊(*db* − *da*)/2⌋; otherwise emit the prefix plus *da* followed by
  `key_between(a[i+1:] or null, null)`. (A missing digit of `a` counts as `0`,
  of `b` as 62.) It is an error to call with `a ≥ b`.

Ingest appends: the *n*-th sibling (from 0) gets `key_between(previous,
null)`, so the sequence is `V, W, X, …, z` (31 one-digit keys, indices
31–61), then `zV, zW, …` from the 32nd sibling
(`structure::thirty-four-siblings`). `ordinal` is the
sibling index from 0; `depth` is 0 at the top level and parent + 1 below;
`ancestor_path` is `"/"` at the top level and the parent's `ancestor_path` +
parent `block_id` + `"/"` below (`/b_0/b_3/`). The fractional keys exist for
the mutation kernel's arbitrary inserts; observation never exposes them.

### 4.4 Checkpoints (16.0)

A **checkpoint** is a revision whose bodies are entirely in full form: a
`[`-form root whose every descendant list is `[`-form (self-contained, §4.1),
and a raw frontmatter blob. A reader resolving a delta walks back one
revision at a time until it meets a full form (§6), so checkpoints bound the
walk and the squash (§7.1) needs them to cut the chain. A revision is a
checkpoint when any of these holds, and the writer (§5.4 steps 1 and 4)
decides it before writing anything:

1. **Cadence**: `(seq − 1) mod 16 == 0` — revisions 1, 17, 33, … So a walk
   back from any revision reads at most 16 nodes per list (15 deltas and the
   checkpoint), and a document's history costs one full tree per sixteen
   revisions plus its deltas. Why 16: the reconstruct of a delta is a chain
   of primary-key point reads (measured at 0.5 ms for the full 15-step chain,
   §10), so the bound is not what limits N; the amortized full node per
   revision is `full / N` — for the 40-block journal of §10, 6.6 KB / 16 ≈
   420 B against a 380 B delta, so at N = 16 the checkpoint already costs
   about as much as the deltas it anchors and a larger N buys little
   (N = 32: 210 B); and a smaller N means the squash re-checkpoints
   less often (below). Both engines use 16; it is not a setting.
2. **No live base**: the first revision of a document (`seq = 1`), or a
   revision whose predecessor `seq − 1` is archived (`archive IS NOT NULL`)
   — which cannot happen at write time, since the predecessor is the
   document's current revision and retention rule 1 (§7.1) never archives
   that, but the rule is stated for the general case and I10 checks it.
3. **Never larger**: a list (or the frontmatter) whose delta would not be
   **strictly smaller in UTF-8 bytes** than its full form is written full
   even at a non-checkpoint revision — a bulk rewrite, a tombstoned path
   re-created with different content, a two-key frontmatter (whose raw is
   shorter than the ops that would replace a line: the `delta::` fixtures
   show a 25-byte raw staying raw). This rule is per list: a delta revision
   may hold full nodes; what makes a *checkpoint* is rule 1 or 2, which
   force every list full.

Rules 1–3 are decided from `seq`, the previous revision's row and the two
texts' byte lengths — nothing a port could compute differently. An
**unchanged** list is handled before the three rules: when its entries equal
the base list's entries text for text and the base's node is self-contained,
the base's hash is reused and nothing is written (the 15.x structural
sharing, unchanged); when the base's node is not self-contained, rule 3
applies and the identity delta wins (at a checkpoint, rule 1: full).

**Base liveness.** A delta's base must be readable for as long as the delta
is live: **the previous revision of a live delta revision is live**. The
writer guarantees it at commit time (rule 2); the retention squash (§7.1)
maintains it — when it archives revision *s* and revision *s + 1* stays
live, it **re-writes *s + 1* in checkpoint form first** (every list full and
self-contained, the frontmatter raw; `root_tree`/`frontmatter_blob`
repointed), inside the squash transaction and before *s* loses its bodies.
Revision *s + 2* needs nothing: its deltas are over *s + 1*'s **resolved**
content, which re-encoding does not change, and by the reuse rule it never
names a non-self-contained node of *s + 1*. The alternative — refusing to
archive a base while a delta depends on it — would make the retention
policy's output depend on the encoding (every kept representative would
pin its predecessor), so it was not chosen (§10 Decisions). The segment a
squash writes holds checkpoint forms only (§7.1), so a segment never walks
back into the store or another segment.

### 4.5 Block text and attrs

`blocks.text` is the block's visible text per `spec/format` §4.1, computed in
tree context (children compose; nested raws lose up to *q* blockquote
markers), and `norm_hash = sha256(text)`. `blocks.attrs` is the block's attrs
as JSON — compared as JSON, key order not significant (the reference writes
insertion order; a port may write canonical order, §10). `type` is the kind
name.

### 4.6 Sections

For a document, over its **top-level** live blocks in `ordinal` order: each
`heading` block *h* (level = `attrs.level`, 1 if absent) yields a row
`(heading_block = h.block_id, doc_id, level, first_ordinal = h.ordinal,
last_ordinal)` where `last_ordinal` is one less than the ordinal of the next
top-level heading with `level ≤ h.level`, or the last top-level ordinal when
there is none. Rebuilt per document inside the commit transaction.

## 5. Observation: bytes at a path become a commit

The single write primitive this spec pins is **observe**: "the bytes at
`path` in repo *R* are now `source` (or the path is gone), at time `ts`".
A batch of members is one checkpoint. The procedure has two passes so that a
block cut from one member and pasted into another keeps its id (the
cross-document phase of `spec/reconcile` §7 runs between them). A batch of
one is the same procedure without the middle.

### 5.1 Pass 1 — echo gate and reconcile, no writes

Load the pool once: every `resurrection_pool` row of the repo with
`expires_ts > ts`, **in `rowid` order**, as `spec/reconcile` pool entries
`{ id, type, raw_hash, norm_hash }`. The order matters: phase 6b lets the
later of two entries sharing a key win, and `INSERT OR REPLACE` gives a
re-pooled block a fresh `rowid` (it moves to the end). Keep a shared
**consumed** set, initially empty. Then for each
member in batch order:

1. **Look up the live doc**: the `docs` row with this `path` and
   `deleted_at IS NULL`; remember its `file_hash` as `old_hash`.
2. **Gone** (`source` is null): if there is a live doc, its whole live tree
   (§5.2) is the member's *deleted* list and it contributes to the
   cross-document phase as such; otherwise the member is a no-op. Nothing
   is minted.
3. **Echo**: if the live doc exists and `file_hash = sha256(source)`, the
   member is an echo — no commit, no mint, outcome `{ echo: true,
   converged: true, conflicted: false }`. This is the loop-breaker a
   synchronizer relies on: re-observing what the store holds does nothing.
4. **Reconcile**: otherwise parse `source` per `spec/format`; split off the
   `frontmatter` block if the first block is one — `rest` is the body. Find
   the doc row for `path` **regardless of tombstone** (a tombstoned path
   still owns its identity): old tree = its live blocks (§5.2), or empty
   when no row exists. Run `spec/reconcile` `reconcile_document(old, new =
   flatten(rest), { config, pool minus consumed })` — the pool is offered
   only when a doc row exists, so a pooled block never resurrects into a
   brand-new path (`pool::new-path-is-not-offered-the-pool`); a
   cross-document *move* can still land on one (§5.3) — and add the
   result's `consumed_pool` to *consumed*. **Block ids are minted here**, in the order `spec/reconcile`
   phase 7 mints them (lineage dispositions in recorded order, then
   `inserted` in document order; every new block in document order under a
   bulk rewrite). Nothing else is minted in pass 1. (The reference's
   `assignFromMap` has a mint fallback for an unassigned key; it is dead
   code — the matcher assigns every key.)

### 5.2 The old tree, from the store

The matcher's old side is rebuilt from the current rows, never from a parse:
the doc's `blocks` with `deleted_at IS NULL`, `raw` **from the row** (17.0;
`blobs` by `raw_hash` through 16.x), children grouped by `parent_block` and sorted by `ordinal` (a
row whose `parent_block` names no loaded row counts as top-level),
positional keys `(parent_key ?? "") + "/" + ordinal`, `text` recomputed by
the `spec/format` §4.1 tree rule (so it equals what was stored), `norm_hash =
sha256(text)`, `anchors = []` (the store does not persist anchors), `index =
ordinal`. The flattened order is `ORDER BY parent_block, ordinal` as the
reference emits it — the matcher's phases are insensitive to it beyond
sibling order and document-order tie-breaks among same-parent blocks, and the
fixtures pin the result.

### 5.3 Cross-document phase

When more than one member reconciled or is gone, pool the leftovers exactly
as `spec/reconcile` §7 says (deleted = each member's `deleted` ids resolved
to its old blocks, in that order; inserted = each member's `inserted`
dispositions resolved to new blocks with their minted ids, in disposition
order; a gone member contributes its whole live tree as deleted; a member
whose path has no doc row yet is keyed by `new:<path>` and can only be a
destination), run `cross_doc_match`, apply the moves to the per-member
results, and record on each destination member the ids carried into it
(`cross_doc_ids`). The replaced minted ids are simply never used — the
counter does not roll back.

### 5.4 Pass 2 — commit, in batch order, one transaction per member

An echo emits its outcome. A gone member with a live doc runs §5.6.
Otherwise the member commits as follows (the reference: `ingestFile` with the
prepared result):

0. **Nothing to read (17.0); the refusal (17.1, Phase 4a — resolution 17).**
   The core numbers and hashes the head without a previous revision (M1):
   16.0's step 0 — the previous revision, its resolved tree and raw as the
   delta bases, the checkpoint rule — is the recorder's own, run inside step
   15 from **its** previous captured revision. Before anything is written,
   the writer checks the repository's manifest (§3.1 `capabilities`): a
   repository whose `history` row is `enabled` with `writer_requires = 1`
   **refuses** a writer whose composition carries no history module —
   `capability_unavailable { capability: "history", state: "unavailable" }`
   (retriable: an engine with the module can) with the `writer_refused`
   alert raised (§5.8); the check runs **outside** the member's transaction
   so the alert survives the refusal (the reference: once per batch before
   pass 2 commits anything, once per api request, once per `ingest_file`),
   and a write that passes clears the alert. A repository whose row is
   `disabled` (or `enabled` best-effort, `writer_requires = 0`) is written
   by any composition.
1. **Frontmatter.** `frontmatter_raw` = the frontmatter block's `raw`
   (fences included), or `NULL` without one — a current value on the doc
   row (step 2), never a delta. The recorder's delta encoding of it (16.0
   step 1: the raw at a checkpoint or with no base, else the smaller of the
   line delta and the raw; the planner's per-entry `set`/`unset
   frontmatter.<k>` landing as a few line ops) is step 15's.
2. **Doc row.** If no `docs` row exists for `(repo, path)`: **mint `d`**,
   **claim it** (§2.1: `INSERT INTO id_claims (id, repo_id, prefix = 'd',
   minted_at = ts, holders = 1)`), then
   insert `(doc_id, repo_id, path, format, head = NULL, leading_trivia =
   tree.leading_trivia, frontmatter_raw, frontmatter_trivia, created_at =
   ts, updated_at = ts, deleted_at = NULL)`; else update `format`,
   `leading_trivia`, `frontmatter_raw`, `frontmatter_trivia` on the
   existing row **and set `deleted_at = NULL`** (§5.6 "Re-creation") —
   `created_at` is left alone: a revival keeps the identity's birth (D6).
   `frontmatter_trivia` is the frontmatter block's `trivia` when there is
   one, else `NULL`. `format` is the adapter's for the path in the reference
   (`markdown` for `.md`); a port without an adapter registry writes
   `markdown`, which is all the fixtures exercise.
3. **Assign ids** onto the body tree from the reconcile assignment (new key →
   id); every key is assigned, so nothing mints here.
4. **(struck, 17.0)** — the Merkle tree is the recorder's (step 15; 16.0's
   step 4 verbatim, run against the recorder's own base tree).
5. **Feed row (17.0, slice 3d — D7/M5).** **Mint `c`**, **claim it** (`c`,
   `minted_at = ts`, §2.1); `seq = 1 + max(seq)` over the repo's `feed`
   rows of the current `epoch` (0 when none); insert `(repo_id, epoch,
   seq, commit_id, ts, origin = 'observed', actor = NULL, reason = NULL,
   batch_id, plan_id = NULL)` — `batch_id` = this batch's first committing
   member's `commit_id` (this one, when it is the first; an echo commits
   nothing and names none). Hand the recorder its `commits` row — the same
   `commit_id`, `epoch`, `seq`, `ts`, `origin`, `actor`, `reason`,
   `batch_id`, `ops = NULL` — which sets bit 1 on the commit's claim (part
   of step 15's capture; skipped when the store runs without the recorder).
   Then enforce the cap (§7.4: a feed never exceeds `feed.max_entries + 1`
   rows). **The entry**, written after step 6 mints the token, inside the
   same transaction: `(repo_id, epoch, seq, doc_id, path, head = step 6's
   token, hash = sha256(source), kind, from_path = NULL)` — `kind` is
   `created` when step 2 inserted or revived the row, else `changed`
   (`moved` is the api path's, below).
6. **Head token (17.0, D1).** **Mint `r`** — the document's new `head`,
   minted by the core at exactly the point the recorder's revision row was
   minted through 16.x (so the mint order and every fixture id hold), and
   minted on **every** commit that renders the document: content,
   structure, path (D11 — `docs_move`, `spec/mutate` §6) or liveness (a
   revival). A tombstone (§5.6) mints none. **Claim it** (`r`, `minted_at
   = ts`, §2.1) before anything else names it. The recorder is handed the
   token in step 15 and writes its `revisions` row under it.
7. **Pool the deleted.** For each id in the result's `deleted`, in order:
   `INSERT OR REPLACE` into `resurrection_pool` the doc's `blocks` row of
   that id (any `deleted_at`) as `(block_id, repo_id, doc_id, raw_hash,
   norm_hash, type, created_at = the row's, deleted_at = ts, expires_ts =
   ts + 30 days)`. (A row that does not exist inserts nothing.) The deleted
   id keeps its claim (§2.1): nothing in this procedure releases one.
8. **Evict foreign rows.** For each id in `cross_doc_ids` then
   `consumed_pool`: delete the `blocks` row with that id whose `doc_id` is
   **not** this doc (its FTS entry first when it was an indexed live leaf,
   `spec/search` §1.1 — decided over the table before any of the batch's
   rows goes, and a live parent the eviction leaves childless is
   re-indexed, since it is a leaf now), and delete the
   id's `resurrection_pool` row — **remembering the evicted row's and the
   pool row's `created_at`** for step 9 (D6). The id is live here now;
   `block_id` is a primary key, and the source document — which commits
   later in the batch or was tombstoned — never lists a carried id as
   deleted. A live foreign row exists only for a cross-document move whose
   source commits later in the batch (`batch::cross-doc-move-b-then-a`); a
   pooled id never has a live row (I6), so a resurrection evicts only
   tombstoned rows (`pool::resurrect-into-another-doc-evicts-tombstoned-row`).
9. **Refresh the blocks.** Read the doc's live rows' `created_at`/`updated_at`
   (the carry source), then delete every `blocks` row of this doc
   (tombstoned included; FTS entries of the live leaves first —
   `spec/search` §1.1 owns which rows are indexed), then insert one row per
   body block in pre-order with `parent_block`, `order_key`, `ordinal`,
   `depth`, `ancestor_path` (§4.3), `type`, `attrs`, `text`, **`raw`**,
   `raw_hash`, `norm_hash`, **`trivia`** and `trivia_hash` (both `NULL` when
   the trivia is empty; nested blocks always), and (17.0, D6) **`created_at`**
   = (a) the previous live row's when the block's verdicts are a carry
   (`same`, `edited`, `moved`, `edited_moved`); (b) the pool row's when they
   include `resurrected`; (c) the evicted foreign row's for a cross-document
   move; (d) `ts` for `inserted` and the lineage kinds (`split_from`,
   `merged_into`, `copied_from`, `bulk_rewrite`) — a new identity is born
   now; **`updated_at`** = the previous live row's when the block's one
   verdict is `same`, else `ts` (14.2's rule: a block is updated when IT
   changes — a container's raw changes when a child's does, so it is
   `edited` and moves); `deleted_at = NULL`. **Claim every new id** (17.0,
   §2.1): a block whose id was neither a live row of this doc (the carry
   source), nor a pool row, nor an evicted foreign row was minted for this
   commit — in pass 1, §5.1 step 4 — and gets its `id_claims` row here,
   `minted_at = ts` (idempotent, so an id that arrived by any of the three
   paths adds nothing). Then rebuild `sections` (§4.6)
   and the FTS rows for the doc (live leaves).
10. **(struck, 17.0)** — the dispositions are the recorder's (step 15; 16.0's
    step 10 verbatim: every verdict whose `kind` is not `same`, 14.2).
11. **Consume the pool.** Delete the `resurrection_pool` row of every id in
    `consumed_pool`.
12. **Pointers.** `UPDATE docs SET head = <step 6>, file_hash =
    sha256(source), updated_at = ts` — `file_hash` is the hash of the bytes
    the head renders to: on the observe path the observed source; on the
    api path (below) the bytes the engine is materializing, which the file
    holds once §5.7 has run. The echo gate (§5.1 step 3) is unchanged: the
    materialized file hashes to `file_hash` and is an echo. `updated_at`
    moves with the head (D6): the document's own last change.
13. **Converged** = `file_hash == rendered_hash` (trivially) **and**
    `render(tree) == source` (`spec/format` §1 inv. 1) **and**
    `reconstruct(doc) == source` (§6.1, read back from the rows just
    written — since 17.0 from the rows alone). Reported in the outcome; a
    `false` is a bug in one of the three, never a normal state.
14. **Conflict flag**, inside the same transaction, with step 12's pointers
    (13.6; 13.5 ran it after the transaction): `UPDATE docs SET conflicted =
    1|0` for the path, 1 iff `source` has a line starting with `<<<<<<<`
    **and** a line starting with `>>>>>>>`. Only an observed member sets the
    flag; an `api` ingest (`spec/mutate` §4) leaves it untouched.
15. **Capture (17.0, M1/D1).** The core hands the recorder the accepted
    transition — the head token of step 6, `doc_id`, `path`, `commit_id`,
    the id-assigned body tree (every block's `raw`, `trivia`, `type`, `attrs`,
    children, pre-order), `frontmatter_raw`, `rendered_hash = sha256(source)`
    — and the verdict list, inside the same transaction, after step 14 and
    before COMMIT (the reference: `HistoryRecorder.captureRevision` at the
    point of step 6, `recordDispositions` after step 9c; the order of the
    recorder's statements within the transaction is not pinned). The
    recorder writes 16.0's steps 0, 1, 4, 6 and 10 **from its own state**:
    its previous captured revision of the document (the greatest `seq`,
    tombstoned or not; none for a new path) as the delta base and the
    checkpoint decision (§4.4), the frontmatter blob (the raw or its line
    delta), the blobs and nodes (§4.1 — this is where every `blobs` row is
    put), the `revisions` row `(rev_id = head, doc_id, seq = 1 + its greatest
    for the doc, root_tree, frontmatter_blob, rendered_hash, path,
    commit_id)`, and every verdict whose kind is not `same` into
    `dispositions`/`block_changes`, and (17.0, 3e-i — M6) **the edge
    transitions** from step 9c's list: one `edge_transitions` row per
    opened edge (the `edges` row verbatim, `from_commit` = this commit,
    `to_commit = NULL`) and `to_commit` = this commit on every row it
    closed — and sets **bit 1** on the `id_claims` rows its new rows name:
    the head and the document (the `revisions` row), every block a
    `block_changes` row names, every opened edge (§2.1; `UPDATE id_claims
    SET holders = holders | 2 WHERE id = ?`, an id with no claim row left
    alone). **Conditional since 17.1 (Phase 4a):** the recorder is handed
    the transition — and the `commits` row of step 5, the edge transitions
    of step 9c — only while the repository's `history` row is `enabled`
    (`capture_for(repo)`: the module when the row says so, else nothing);
    with capture off the head is minted, the feed row and its entry written,
    the blocks, pool, claims (bit 0 alone), properties and edges maintained
    exactly as above, and **no history row appears** — the `revisions`/
    `commits`/`blobs`/`tree_nodes`/`dispositions`/`block_changes`/
    `edge_transitions` tables are untouched (and may not exist, §3.1). **A
    failure inside the recorder rolls the member back (resolution 18):** the
    recorder's throw aborts the member's transaction — nothing of the member
    lands, not the feed row, not the head — the transaction's owner then
    raises the **`capture_failed`** alert (`error`; detail `{ path, reason }`,
    the path in the reference form; §5.8) and the member is **retried by the
    next sweep** (its stat is not recorded, so it stays a candidate); on the
    observe path the batch goes on with its other members (the failed one's
    outcome is `{ path, failed: true, doc, error }`), on the api path the
    request fails with the envelope `capture_failed { path, reason }`
    (`retriable: true`). The next capture that lands for that path clears the
    alert. Nothing is ever written without its capture; a persistently
    failing recorder makes a file un-ingestable until the recorder is fixed
    or `history disable` is run — the alert says so. While capture is on,
    `revisions.rev_id == docs.head` on every live document whose head was
    minted within coverage (§8 H1).

The member's outcome is `{ echo: false, doc, commit, rev, converged,
conflicted, dispositions: kind → count over this commit }`. The counts are
over **every verdict the matcher produced**, `same` included — the outcome
describes what the matcher saw; the tables describe what changed (step
10) — so an implementation counts the in-memory result, never the rows
(14.2; through 14.1 the two were the same list).

**The api path (13.7; the feed row 17.0).** `spec/mutate` §4 step 5(c) runs this procedure for
every document of a changeset inside **one transaction**: step 5 runs once,
before the first document, with `origin = 'api'`, the request's `actor` and
`reason`, `batch_id = commit_id`, `plan_id` = the admitted plan's digest
for an effect-driven request (`spec/mutate` §11.5; NULL otherwise) — and
the recorder's row with `ops` = the intent record of that plan (NULL
otherwise); every document's step 15 names that commit (so N revisions, every `dispositions.commit_id` and every edge
transition's `from_commit`/`to_commit` of the request share one `commit_id`,
and every document's `updated_at` is its `ts`), and every document writes its **feed entry** under that row —
`created`/`changed` as step 5 says, **`moved`** with `from_path` for a
document the request moved (`docs_move`: the `move_path` effect writes the
entry with the head it mints; a moved document the same request also
rewrites gets its one entry from its ingest, `moved`, since it was loaded
under the old path — `spec/mutate` §6), **`deleted`** (`head` and `hash`
NULL) for a document it tombstoned (`docs_delete`); steps 1–3, 6–9 and 11–13 run per document in load order with the
known-id resolver, step 15 per document; step 8
is unchanged (in one transaction the eviction and the pool insert of a
cross-document move run in load order, so only their visibility changes —
`spec/mutate` §10); step 14 never runs. The observe path is unchanged: one
transaction per member, one commit per member (the per-member commit ids
`spec/store` fixtures pin). Mint order on the api path: one `c`, then per
document `r`, `x`, `e` — a `docs_move` mints its `r` first (D11, below) and
claims it as step 6 does. The known-id resolver's verdicts are
`spec/mutate` §4 step 5(b)'s — since 14.2 a carried block is classified
exactly as `spec/reconcile` §2 classifies a carry, so an untouched block is
`same` and step 10 drops it there too; a one-block edit writes one row.

**The api path (14.0; the self-contained row 17.0, M4).** The same
transaction records the file half as intent, after every document's steps
and before COMMIT: one `pending_materializations` row per path the request
owes the disk (§3.1) — `write` for every ingested document (`head` = its
new head, `rendered_hash` = `sha256(source)`, **`prior_hash`** = the
`file_hash` the transaction validated the file at `path` against
(`spec/mutate` §4 step 5 (b) — the bytes the engine itself last wrote
there; `NULL` for a created document, whose guard is `path_taken` and whose
path had no file)), `rename` for a moved document (`from_path` = the old
path, `path` = the new one, `head` = the **new head the move minted**
(17.0, D11: `docs_move` is a transition — `UPDATE docs SET path, head =
mint r, updated_at = ts` and a captured revision of the unchanged tree at
the new path; `spec/mutate` §6), `rendered_hash` = `docs.file_hash`,
`prior_hash` = the same hash — what the engine last wrote at `from_path` —
or the head and bytes the retarget gives it when it is a self-linking
source, which then mints the one head and keeps the move's `prior_hash`),
`remove` for a deleted document (`head = NULL`, `prior_hash = NULL`,
`rendered_hash` = `docs.file_hash` before the tombstone — the bytes its
head renders to, I1); every row `commit_id` = this commit, `created_at =
ts`. A row the path already owes is **superseded** by §5.7's rules (a
later write replaces the target and keeps the earliest `prior_hash`; a
rename carries the obligation of the row at `from_path` and deletes it; a
remove drops the write), then `INSERT OR REPLACE`. No file is touched
inside the transaction; §5.7 says how the rows become files.

9b. **Properties (store 13.1).** After the blocks and sections: delete the
    doc's `properties` rows and insert the document's property rows as
    `spec/properties` defines them (`INSERT OR REPLACE` on `prop_id`, with
    `repo_id`, `doc_id`; 17.0, D9: no commit column — a property is live
    exactly while its document's rows are, which this delete-and-rewrite
    keeps true). The rows are `spec/properties`' output, pinned by its
    fixtures; this spec's fixtures do not project them.

9c. **Graph (store 13.2; open-only edges 17.0, M6).** After the properties:
    the doc's `nodes` (and their FTS rows) are replaced by the projection
    `spec/graph` §2 defines; its edges are extracted, resolved and
    maintained as the **open set** per `spec/graph` §3.3 — a wanted key not
    open inserts a row (**mints `e`** during insertion, after every `x` a
    new external URI minted during resolution, before the dispositions,
    each claimed with the row, `minted_at = ts`, §2.1), a row no longer
    wanted is **deleted**, an unchanged row keeps its id; the core writes no
    `from_commit`/`to_commit` — the transition's edge list (the rows
    opened, the ids closed) goes to the recorder in step 15 — and
    `doc_edges` is rebuilt. Phantom adoption (`spec/graph` §3.5) happens in
    step 2 when a doc row is created or revived and rewrites the open
    edges' `dst_node` in place (the recorder's open transition rows
    follow). Those tables are `spec/graph`'s output, pinned by its
    fixtures; this spec's fixtures do not project them — `edge_transitions`
    is pinned by §9.5. The mint order pinned above is complete
    for the prefixes `d`, `b`, `c`, `r`; `x` and `e` are `spec/graph`'s.

### 5.5 Sweep

`sweep(ts)`: `DELETE FROM resurrection_pool WHERE expires_ts <= ts`. The
batch procedure itself (§5.1–§5.4) never sweeps; the reference's convenience
entry points `observeFile`, `observeMany` and `observeDelete` sweep once
after their batch, while `observeOne`/`observeBatch` leave it to the caller.
The fixtures make it an explicit step so its effect is pinned on its own.

### 5.6 Observed deletion (tombstone)

For a live doc whose path is gone, in one transaction (13.6; through 13.5
the reference ran bare autocommit statements, so a failure mid-way could
leave a pooled, half-tombstoned doc):

1. **Mint `c`** and claim it; insert the **feed row** `(epoch, seq, commit_id,
   ts, origin = 'observed', actor = NULL, reason = 'observed deletion',
   batch_id)` as step 5 does, and one **entry** `(doc_id, path, head = NULL,
   hash = NULL, kind = 'deleted')`; the recorder's `commits` row under the
   same id (17.0, slice 3d).
2. `INSERT OR REPLACE` every live block of the doc into `resurrection_pool`
   with `created_at` = the row's, `deleted_at = ts`, `expires_ts = ts + 30
   days`. No claim moves (§2.1).
3. Delete the doc's FTS rows; **`DELETE FROM blocks WHERE doc_id = ?`** (17.3,
   D2 step two: deleted content is history — the recorder's last captured
   revision of the head holds it, the pool rows of step 2 hold what revival
   needs, the claims stay; 17.0–17.2 tombstoned the rows in place with
   `deleted_at = ts`, and §3.4 step 17 (15) deletes those on open); `UPDATE
   docs SET deleted_at = ts, updated_at = ts` — **`head` is kept** (the token of the last rendered state; a CAS
   against it fails on liveness, `spec/mutate` §4) and **no head is minted**
   (D11: a delete is no revision).

4. Capture (step 15) receives the transition with `kind = 'deleted'`: the
   recorder writes the commit and no revision (D11: a delete mints none) —
   while the repository's capture is on (17.1); off, the feed row alone
   records the deletion.

No revision, no dispositions. The doc's `sections` rows are left in place
(§10). The blocks are pooled because a vanished file
is overwhelmingly a move or a transient; the intentional API delete pools
nothing (mutation kernel, not this spec). A gone path with no live doc is a
no-op with outcome `{ deleted: false }`.

**Re-creation.** When bytes are observed again at a tombstoned path, §5.1
step 4 reconciles against an empty old tree (the tombstone left no block
row) with the pool offered, so identical blocks resurrect (`spec/reconcile`
phase 6b — each restoring its `created_at` from the pool row), and §5.4
step 2 reuses the doc row — **and clears its `deleted_at`**, keeping
`created_at`: the row is live again, a new head is minted (a revival is a
transition, D11), and the next observation of the same bytes is an echo. (§10: the reference did
not clear the tombstone; found while writing this section.)

### 5.7 Materialization and pending rows (14.0; self-contained 17.0)

The api path is **DB-first**: its transaction commits the rows (§5.4 "The
api path") and the files follow, one `pending_materializations` row each.
The guarantee this buys, stated honestly: all-or-nothing in the database;
files eventually consistent through recorded intent that any materializer
replays; no cross-resource atomicity between the database and the disk; a
file a human changes meanwhile wins (ADR-004). A conflict found inside the
transaction (`spec/mutate` §4 step 5) therefore touches no file, and a
process that dies between COMMIT and the file half loses nothing: the
commit, its revisions and the change-feed digest are durable, and the rows
say what each file must become.

**The row is self-contained (17.0, M4).** A pending row names everything
its replay needs and nothing a history table has to answer: `head` — the
document's **current** head token, whose bytes the row renders (C8; a later
commit to the path replaces the row, so the row never names an older
head); `rendered_hash` — the bytes expected at `path`; `prior_hash` — the
bytes **the engine itself last wrote at `path`**, captured at commit time
from the `file_hash` the transaction validated the file against (or
inherited from the row it superseded, below), `NULL` when the engine never
wrote there; `commit_id` and `created_at` for the record. Through 16.x the
row named `rev_id` with a foreign key into `revisions`, the bytes were
`reconstruct at rev_id` through the Merkle tree and the prior bytes a
`revisions` self-join on `seq − 1` — a crash-recovery path that could not
run without the recorder's tables. Retention pinned the revision for it
(§7.1 rule 2, retired).

**Materializing a row** (`materialize_row`), through the repo's doc store,
then `DELETE` the row — autocommit per file, so partial progress is durable.
Bytes are **`reconstruct(doc)` — from current state** (§6.1; a row always
names its document's current head, and §6.1 is byte-exact for the head). A
materializer never overwrites bytes it does not recognise as the engine's
own: at `path` it accepts nothing, the bytes the row names
(`rendered_hash`), or the **prior** bytes — **`prior_hash`**, what the file
holds when the process died after COMMIT. Anything else is **foreign** — a
human edit that landed meanwhile — and the row is kept: the next
observation of the path decides (below), so the api intent is superseded by
a later edit, never silently reverted and never overwriting it.

| Row | At `path` | Action |
| --- | --- | --- |
| `write` | absent, or the prior bytes | write the document's bytes; delete the row |
| `write` | the row's bytes | already there (another materializer, or a human wrote the same); delete the row |
| `write` | foreign bytes | keep the row (the observation applies "file wins") |
| `rename` | absent; `from_path` present | rename `from_path` → `path`; if the renamed file holds the prior bytes rather than the row's (a self-linking source), write the document's bytes over it; delete the row. (Foreign bytes at `from_path` travel with the rename unrewritten — the human's edit of the document follows the document — and the next observation of `path` lets them win) |
| `rename` | absent; `from_path` absent | write the document's bytes at `path`; delete the row |
| `rename` | the row's bytes | done; a stale copy of the engine's own bytes (the row's or the prior) still at `from_path` is removed; delete the row |
| `rename` | foreign bytes | keep the row (`path` wins; `from_path` becomes an untracked file) |
| `remove` | the row's bytes | unlink; delete the row |
| `remove` | absent, or foreign bytes | leave the file (a rewritten file is untracked now — the next sweep re-creates the path, §5.6); delete the row |

A row whose bytes cannot be rendered (the document is gone, or its
reconstruction does not hash to `rendered_hash` — the head moved under the
row, impossible while the replace rule holds and checked anyway) is kept for
a later materializer rather than guessed. `materialize_pending(repo)` replays every
row of a repo in insertion order and returns the paths cleared; it is step 0
of the freshness sweep and of recovery (`spec/sync` §4.3) — the production
recovery points — and `spec/mutate` §4 step 5 (a) replays the rows of the
paths a request touches before reading their files.

**Supersession (17.0).** One row per path; a commit that owes a path a row
already owes records the row §5.4 describes and then applies, in this
order, before `INSERT OR REPLACE`:

- a **`write`** over a `write` **replaces the target** (`head`,
  `rendered_hash`, `commit_id`, `created_at`) and **keeps the earliest
  `prior_hash`** — the bytes that can still be on the disk are the ones the
  engine wrote before the first unfinished commit, never a superseded row's
  own target (which never reached the disk, or the row would be gone); a
  `write` over a `remove` inherits as `prior_hash` the bytes the remove owed
  an unlink (`rendered_hash` — the engine's bytes, still on the disk); a
  `write` over a `rename` keeps the **rename**, its `from_path` and its
  `prior_hash`, and replaces its target (the self-linking source of a
  `docs_move`, whose retarget renders new bytes at the new path:
  `spec/mutate` `materialize::move-self-link-crash-row-is-a-rename-with-the-
  retargets-target`);
- a **`rename`** whose `from_path` still owes a `write` or `rename`
  **carries its obligation**: the rename's `prior_hash` is that row's
  `prior_hash` (the earliest bytes the engine must still recognise at
  `from_path`) and that row is deleted in the same transaction — one
  obligation per path, none lost (`materialize::move-after-crashed-write-
  carries-the-write-obligation`); a `rename` replaces whatever `path` owed;
- a **`remove`** drops whatever the path owed — a write the human overtook
  is never written (`materialize::delete-after-crashed-write-drops-the-
  write`).

A `write` over a `write` across two requests has no fixture by
construction: `spec/mutate` §4 step 5 (a) replays an owed row before any
commit, and a row the replay keeps holds foreign bytes, which step 5 (b)
refuses (`sync_conflict`, the row dropped with the observed ingest); the
rule is reachable within one request (the self-linking move) and is
otherwise a unit-tested property of the row writer. **No limit.** There is
no cap on pending rows and no age at which one is dropped: unresolved
recovery work is never discarded for a storage limit — a row lives until a
materializer or an observation settles its path.

**The gate rule.** An observation (§5.1) of a path that has a pending row
runs this check first, before the echo gate, keyed by the `(repo, path)` row
— and reads **the row's `rendered_hash`**, never a history row:

- the bytes hash to `rendered_hash` → an **echo** of the row's `doc_id`
  (`{ echo: true, converged: true }`, nothing minted): the observation
  confirmed the intent; the row is deleted — except a `remove` row, which
  stays until a materializer unlinks the file (the observe path never
  touches a file);
- the member is **gone** (`source` is null) and the row is a `write` or
  `rename` → **no tombstone**, outcome `{ deleted: false }`, nothing minted,
  row kept: the materializer still owes the file. A gone member with a
  `remove` row is the intended state: the row is deleted and the member is
  the §5.1 step 2 no-op;
- anything else is **foreign bytes → the file wins**: the normal reconciling
  ingest (§5.1 step 4, §5.4) commits them as `observed`, and the row is
  deleted in that member's transaction. In particular a file still holding
  the **prior** bytes after a crash is foreign to this rule — it does not
  hash to `rendered_hash`, and the observation does not consult
  `prior_hash`: a file the engine wrote and a human who reverted the file to
  it are indistinguishable from the disk alone — so observing it commits the
  old bytes as a new observed revision over the api one (`spec/mutate`
  `materialize::crash-then-observe-of-stale-file-is-foreign`). The api
  revision stays in history; nothing is reverted silently. This is why the
  materializer, not the observation, is the recovery point: the sweep runs
  step 0 before it walks the disk, and a watcher batch that reaches the gate
  first is a human's intent as far as the engine can tell.

`observe_delete` applies the gone-member rule the same way. Recovery
(`spec/sync` §4.3) compares the disk to `docs.file_hash` after step 0 and
drops a kept row with the heal (the file won). The disk-drift counters
(`spec/sync` §4.3) may transiently count a path with a pending row as
`changed`; they are read-only and the next sweep settles it.

### 5.8 The alert channel (17.0, slice 3e-ii)

`alerts` (§3.1) is where the engine tells a human that a condition needs
them — where they work, not on a dashboard (`docs/modular-core/
phase-1-contracts.md` §7 "+"). One row per `(repo_id, code)`:

- **Raise** `(code, severity, message, detail)` at `now` is **idempotent**: a
  row that is absent or cleared is written with `since = now` and
  `cleared_at = NULL`; an active row keeps its `since` and takes the new
  severity, message and detail — and is **not written at all** when they are
  unchanged, so a read-only path that lists alerts writes nothing. `detail`
  is stored as canonical JSON (keys sorted bytewise at every level).
- **Clear** `(code)` at `now` sets `cleared_at = now` on an active row and
  touches nothing else; the row stays as the record of the last episode and
  is re-raised in place.
- **Active** = `cleared_at IS NULL`; listed by (`since`, `code`) as `{ code,
  severity, message, since, detail? }` — `detail` omitted when `{}`.
- **Derivable conditions are re-derived whenever the channel is read**
  (`active_alerts`): the table remembers `since` and the message, the
  condition itself is always current — except a condition whose derivation
  is a pass over the repository's bytes (`legacy_bytes`, 17.4), which the
  table's row names say for; its raisers are listed with it.

The raisers of 17.0, each with its condition and its end:

| code | severity | raised when | cleared when | detail |
| --- | --- | --- | --- | --- |
| `materialization_backlog` | `warning` | some `pending_materializations` row of the repository has `created_at ≤ now − recovery.alert_after_minutes` (a setting, `spec/sync` §3; default **10** — the api path still owes the working tree files a replay has not been able to leave there). Re-derived on every read of the channel and after every replay (§5.7 step 0, recovery). Message: `<n> pending materialization[s] older than <m> minutes (oldest <ts>): the api path still owes the working tree these files — omg sync replays them` | no such row | `{ pending: <n>, oldest: <the earliest created_at>, threshold_minutes: <m> }` |
| `materialization_failed` | `error` | a pending row's replay **threw** (the doc store refused the write; the row is intact and retried by the next sweep — resolution 18: retry forever, surface loudly). The error still propagates. Message: `replaying the pending materialization of <path> failed: <reason> — the row is kept and retried on the next sweep` | the next replay pass of the repository completes without a failure | `{ path: </-rooted>, kind, reason }` |
| `writer_refused` | `error` | a writer without the history module was refused by `writer_requires` (§5.4 step 0; the write is `capability_unavailable { capability: history, state: unavailable }`, `spec/surface` §4). Unreachable through 17.0: every composition carries the recorder. Message: `a writer without the history module was refused: this repository requires capture (writer_requires) — write through an engine that carries the history module, or run omg history disable` | a write by an engine that carries the module passes the check | `{ capability: "history" }` |
| `capture_failed` | `error` | (17.1, Phase 4a; resolution 18) the recorder threw inside a member's transaction: the member was rolled back, the next sweep retries. Message: `history capture of <path \| a commit> failed: <reason> — the write was rolled back and is retried by the next sweep; fix the recorder or run omg history disable` | a later capture of the same path succeeds | `{ path?, reason }` |
| `feed_capped` | `warning` | (17.2, Phase 4b) the write-time cap pruned feed rows inside a commit's transaction (§7.4: more than `feed.max_entries` rows of the epoch were newer than them) — rows the floors promised a consumer are leaving because the cap is too low for the write rate. Raised in the committing transaction at the commit's `ts`. Message: `the feed reached feed.max_entries (<max>) and pruned <n> row[s] a consumer may not have read: raise feed.max_entries or shorten the sync interval` | a `gc` (§7, §7.4) whose cap pass prunes nothing — the feed is within the cap again (the floors did the work, or the cap was raised); a gc whose cap pass prunes re-raises it | `{ pruned: <the rows this write pruned>, oldest, head }` (the feed's position after the prune) |
| `legacy_bytes` | `warning` | (17.4, Phase 5a-ii; §5.11) some live document's rows do not reproduce its `file_hash` — `sha256(reconstruct(doc)) != file_hash` — because they were imported before block trivia was stored (the 16 → 17 migration copies such rows as they are). Raised by the migration at both entry points (§3.4 step 17 (16)), re-derived IN FULL by `doctor` (`spec/cli` §6 `bytes reproducible`) and by every freshness sweep while it is active (`spec/sync` §4.3 step 5 — the sweep repairs the documents whose files are present); **not** re-derived on an ordinary read of the channel (`active_alerts`): the check is a pass over the repository's bytes. Message, with the count: `<n> document(s) carry bytes the engine cannot reproduce from its rows (imported before block trivia was stored); omg sync repairs them from the files` (the literal `document(s)`, whatever `n`) | a re-derivation finds no such document — the sweep repaired them from their files, or re-ingested the ones whose files moved on | `{ docs: <n>, sample: [<the first 20 doc ids, bytewise path order>] }` |

Nothing else raises; a code outside this table is a newer engine's. The
conditions the contracts name beyond these — a detached segment a read
needs, a recorder with an unknown schema — have no raiser yet and are
listed so both engines spell the codes alike when they do:
`segment_detached`, `recorder_schema_unknown`. `doctor --size` reads the
channel for its feed-cap advice line (§7.2).

**Step 0 of every write (resolution 17).** Before a write entry point —
observation (§5.4), the api commit (`spec/mutate` §4), the observed
tombstone (§5.6) — touches a row, it reads the repository's `history`
manifest row: when `state = 'enabled'` and `writer_requires = 1` and the
engine runs without the history module, the write is refused with
`capability_unavailable { capability: "history", state: "unavailable" }`
(retriable — an engine carrying the module can) and `writer_refused` is
raised; a write that passes with the module present clears it. The check
is trivially true on every 17.0 composition and pinned by the reference's
unit tests for Phase 4.

### 5.9 The capture lifecycle (17.1, Phase 4a)

Per repository, capture is switched by two verbs over the manifest row
(§3.1 `capabilities`; `phase-1-contracts.md` §1.14; `omg history
enable|disable`, `spec/cli`). Both are idempotent and run under the writer
lock, outside any member transaction.

**`history enable`**, in one transaction: (1) execute the history bundle's
DDL when absent (§3.3); (2) write the **baseline** — one feed row (§5.4
step 5) with `origin = 'import'`, `reason = 'history enabled'`, `actor =
NULL`, its own `batch_id`, and one entry `(doc_id, path, head, hash =
file_hash, kind = 'changed')` per **live** document under its EXISTING head
(no head is minted: every `_rev` a client holds stays valid, `docs_read {
at: <head> }` works at once, the interop tokens hold); (3) hand the recorder
the baseline: the `commits` row of that feed row; for every live document
whose head has **no** `revisions` row — one changed while capture was off,
or never captured — a **checkpoint** revision under the existing head
(`rev_id = head`, `seq = 1 + the document's greatest captured seq`, the
current body tree and `frontmatter_raw` read from the rows, every node full
and the frontmatter raw, `rendered_hash = file_hash`, `path = docs.path`,
`commit_id` = the baseline's); the recorder's hold (bit 1) on every live
document, head and live block id; and the **edge record reconciled** with
the open edges (§8 H6): every open `edge_transitions` row whose edge no
longer exists is closed at the baseline commit (`to_commit`), every open
edge without an open transition gets one from it (`from_commit`), an open
transition whose `dst_node` was rewritten while capture was off follows the
edge. No dispositions (nothing was reconciled); a tombstoned document gets
no entry and no revision. (4) The manifest row: `state = 'enabled'`,
`coverage += { from: ts, to: null }`, `writer_requires` per the flag
(default 1 — resolution 17; `--best-effort` writes 0). An already `enabled`
row is returned unchanged — no second baseline, and the flag is the
enable's, not a setting. A composition without the history module refuses
(`capability_unavailable { history, unavailable }`): nothing could capture.
The outcome is the row and, when something changed, `{ commit, revisions }`
of the baseline.

**`history disable`**: the open interval closes — `coverage[last].to = ts`
— `state = 'disabled'`, `writer_requires = 0`. **The rows stay** (`history
purge`, §7.6, removes them); reads of what was captured keep working
(§6.2, `docs_history`, the `revisions` root — `spec/surface` §2.1: a
disabled repository lists what it captured); step 15 stops for this
repository from the next commit on, in this process and every other (every
commit reads the row). A `disabled` or absent row is a no-op (an absent one
is written `disabled` with no coverage, rule 1 made explicit). Needs no
module: a core-only build may switch capture off on a repository it cannot
write.

**Who creates a repository with capture off.** `ensure_repo` (§1) writes
the `history` row `enabled` with coverage from the repository's birth and
`writer_requires = 1` when the composition carries the recorder and the
caller did not opt out; `disabled` with `coverage = []` and `writer_requires
= 0` when the composition has no module (a build that cannot capture does
not require what it cannot do) or the caller asked (`omg source add
--no-history`; a fixture's `capabilities: { history: false }`, §9.4).

**What the composition means (test override).** The TypeScript engine always
carries both modules; `OMGBASE_CAPABILITIES=core` is a **test-only
override** that runs it as a core-only build — no recorder, no semantic
module — so every fixture suite can run its observation scripts with
history off and assert the core invariants alone (§9.6). It is not a
production switch: in production whether a repository's commits are
captured is its manifest row, flipped by the two verbs above.

### 5.10 The semantic lifecycle (17.2, Phase 4b)

The `semantic` manifest row is flipped by two verbs over it (`omg embed
enable [--provider <p>] | disable`, `spec/cli`; `phase-1-contracts.md`
§1.14) and by a change of the effective `embedding.provider` setting
(§3.1). Both verbs are idempotent and run under the writer lock.

**`embed enable`** needs the module (a core-only build refuses with
`capability_unavailable { semantic, disabled }`) and a configured provider
(`embedding.provider` resolving for the repository — else the refusal `no
embedding provider configured — pass --provider <command|url>, or set one
with omg config set embedding.provider <command|url>`, which the CLI renders
as a usage error; `--provider` writes the setting at the WORKSPACE layer
first, as `init --embedder` does — one vector space per workspace — and
that write itself re-derives every repository's row whose effective
provider changed). Then `state = 'enabled'`, `coverage += { from: ts, to:
null }`, `config = { model?, dim? }` from the effective `embedding.*`. An
`enabled` row is returned unchanged (a config change moves the config
alone). **`embed disable`**: `coverage[last].to = ts`, `state =
'disabled'`; the vectors stay (`embed drain --prune` is the vectors' purge)
and the provider setting stays. The outcome is the row's `{ state,
coverage, provider, changed }`.

**What `disabled` means with a provider configured** — the state only
`embed disable` leaves (a row born `disabled` has no provider; a provider
change re-derives the row): every explicit semantic path refuses with
`capability_unavailable { capability: "semantic", state: "disabled", fix:
"omg embed enable" }` and the message `` semantic search is disabled for
this repository — enable it with `omg embed enable` (the embedding
provider stays configured) `` (byte for byte in both engines): `semantic()`
in a query, `blocks_resolve`'s vector leg and `embed status|drain`; the
host spawns no embedder for such a repository, so an opportunistic caller
(`find`, the MCP server's `blocks_resolve` without a query vector) is
FTS-only. With NO provider configured the row is `disabled` too, and every
path keeps its 5.1 answer (`provider_unavailable` — "the module is here
and has nothing to score with", `spec/surface` §4); `version` and
`sync_status` read `disabled` in both cases.

### 5.11 Legacy bytes and their repair (17.4, Phase 5a-ii)

The Phase 5 qualification (`docs/modular-core/migration-runbook.md`) ran
the 16 → 17 migration on copies of two real workspaces and found, in one of
them, 115 of 116 live documents whose rows did **not** reproduce their
`file_hash` after the migration — while the files on disk hashed to
`file_hash` for every one of them. Their blocks had been ingested before
the store kept block trivia (schema v6 added `blocks.trivia_hash`, v7
`docs.frontmatter_trivia`): every block's `trivia_hash` was NULL, the 16.x
reader took a NULL for "empty trailing bytes" (so `---\n# H\n\n## T\n` read
as `---# H## T`), and step 17 (2) copied the rows as they were. The 16.x
engine had been serving those bytes all along; what changed is that the
store now says so.

**The condition.** For a live document *d* with a `file_hash`:
`sha256(reconstruct(d)) != file_hash` (§6.1). The set of such documents of
a repository, in bytewise `path` order, is the repository's **legacy
set**; it is non-empty only by this cause (a current-state ingest checks
`reconstruct(d) == source` as it commits, C1). The store records it as the
`legacy_bytes` alert (§5.8) with the count and the first 20 ids, and
nothing else — no column is spent: the condition is re-derived where a
pass over the repository's bytes is affordable — by the migration (§3.4
step 17 (16): in full at the 16 → 17 entry point, behind the cheap
signature of legacy rows at the on-open one), by `doctor` (`spec/cli` §6
`bytes reproducible`, in full, on demand) and by the freshness sweep while
the alert is active (`spec/sync` §4.3 step 5). An ordinary read of the
channel does not re-derive it. Recovery (`spec/sync` §4.3) does not look
at it: a legacy document's file hashes to `file_hash`, so recovery sees
nothing to heal.

**The repair** (the sweep's step 5; `spec/sync` §4.3) — for each document
of the legacy set whose file is present and hashes to `file_hash` (the
bytes the store already agrees with, I1):

1. Parse the file (`spec/format`); split off the `frontmatter` block.
2. The parse must have the rows' **exact shape**: the same number of
   top-level blocks, and recursively the same children; at every position
   the same `type` and the same `raw`; the frontmatter block's `raw` equal
   to `docs.frontmatter_raw` (both absent, or equal). Identical texts map to
   the same ids **positionally** — no matcher runs; a parse that differs
   anywhere leaves the document in the set (it is not a pure separator
   loss) and nothing is written.
3. Rewrite the **separator columns from the parse, and nothing else**:
   `blocks.trivia`/`trivia_hash` of every paired block (`NULL`/`NULL` when
   the parsed trivia is empty, else the bytes and their sha256 — C2),
   `docs.leading_trivia`, `docs.frontmatter_trivia` (the frontmatter block's
   trivia; NULL without one). `raw`, `raw_hash`, `text`, `norm_hash`,
   `attrs`, the ids, `parent_block`, `order_key`, `ordinal`, the FTS index
   (it indexes `text`), the nodes (byte spans into `raw`), the sections,
   the properties and the edges are untouched.
4. `sha256(reconstruct(d)) == file_hash` must hold afterwards, or the
   rewrite is rolled back and the document stays in the set.

A repair mints **nothing**: no feed row, no feed entry, no head (content,
structure, path and liveness did not change — D1), no `updated_at` on the
document or its blocks (D6), no revision, no disposition. **Legacy
fidelity:** the recorder's capture of the head stays what the 16.x engine
captured — a tree whose entries name no trivia — so `docs_read { at:
<head> }` (§6.2) renders the legacy bytes with `rendered_hash_match:
false`, as it did through 16.x, until the document's next commit captures
a fresh revision; the head's `revisions.rendered_hash` was right all along.
A document whose file is **gone** (a database migrated beside a tree that
no longer holds it) stays in the set and listed; one whose file **moved
on** is a changed candidate of the same sweep and is re-ingested by the
ordinary path (a new head, a `changed` entry, rows written from the file)
before the repair pass looks, so it is no longer in the set. After the
pass the alert follows the remainder: refreshed with the new count, or
cleared when none is left. The sweep's result carries the repaired paths
(`repaired`). `checkpoint::legacy-bytes-repaired-by-the-sweep`,
`-missing-file-stays-listed` and `-diverged-file-is-ingested-not-repaired`
of `spec/sync` pin the three outcomes; the migration fixtures pin the
check (§9.3).

## 6. Reads this spec pins

### 6.1 Reconstruct (current bytes)

`reconstruct(doc)` for a live doc: `leading_trivia`, then — when
`frontmatter_raw` is not `NULL` — `frontmatter_raw` followed by
`frontmatter_trivia`, then for each **top-level** live block in `order_key`
order its `raw` followed by its `trivia` when not `NULL`. **Every byte comes
from the `docs` and `blocks` rows** (17.0, D10/M1): nothing resolves and no
history table is read — through 16.x the frontmatter was the head revision's
`frontmatter_blob` resolved through its delta chain, and the body bytes were
`blobs` rows named by the live rows' hashes. A container's `raw` already
contains its children (`spec/format` §1 inv. 3), so only roots are walked.
Equals `source` by construction (§5.4 step 13). `NULL` for a tombstoned or
unknown doc.

**Resolving (16.0; the recorder's since 17.0).** A revision's **frontmatter raw** is its
`frontmatter_blob`'s bytes when they start with `-`; when they start with
`{` (a delta, §4.1) it is the ops applied to the lines of revision
`seq − 1`'s frontmatter raw, recursively — at most 15 steps (§4.4). A
revision's **root list** (and any list of its tree) is its node's entries
when the node is `[`-form; when `{`-form, the ops applied to the **same
list of revision `seq − 1`** — the root for the root, the children of the
same `block_id` for a container (found by resolving `seq − 1`'s tree) —
each entry text parsed back to its six elements. A `{`-form met where no
base exists (`seq − 1` missing, archived, without a frontmatter, without
the block's children), ops that do not consume exactly the base, or a
`{`-form inside an archive segment, is a corrupt store: the read fails
(`DeltaError` in the reference) rather than guessing. The reference's
`TreeResolver` memoizes per `(doc, seq, hash, position)` so a whole tree
costs one walk per list.

### 6.2 Reconstruct at a revision

The same assembly sourced from the revision's Merkle root: the revision's
frontmatter raw (§6.1 "Resolving"), then the entries of its **resolved**
root list in order, each `raw_hash_hex` blob followed by its
`trivia_hash_hex` blob when non-null (children not walked). The block-grain
reads (`docs_diff`'s id → raw maps) resolve the whole tree the same way. `leading_trivia` and `frontmatter_trivia`
come from the **current** doc row — they are not versioned — so the result
is byte-exact for the current revision and best-effort for older ones; the
read reports `rendered_hash_match = sha256(result) == rendered_hash` as the
honest signal. This is a **history read** (17.0): `docs_read { at }`,
`docs_diff*` and the §8 agreement checks use it; the materializer (§5.7)
renders from current state and no longer calls it.

**Through a segment (15.0).** For a revision with `archive IS NOT NULL` the
bodies are not in the store: the read looks the segment up in `archives` by
`segment_id`, `ATTACH`es its file on demand under an alias of its own
(`arc_<segment_id>`; read-only — the file is written with mode `0444` and an
engine never writes through an alias; attached aliases stay for the
connection's life, the oldest detached past eight), checks that the file's
`manifest.segment_id` is the one asked for, and then runs the same assembly
over `<alias>.revisions` (a `root_tree`/`frontmatter_blob` in **checkpoint
form** — the store's own columns were NULLed, §7.1), `<alias>.tree_nodes`
and `<alias>.blobs` — the segment is self-contained, so nothing falls back
to the store's tables and nothing in it is a delta. `leading_trivia`/`frontmatter_trivia`
still come from the `docs` row. When the segment is **not recorded** (never
attached, or detached) or **recorded but not on disk**, the read fails with
`revision_archived { rev, archive, path? }` (`path` only when a row records
one) rather than returning anything; `spec/surface` carries the error code.
The block-grain reads (`docs_diff`'s id → raw maps) resolve the same way.
Dispositions and block changes that moved to a segment are **not** read
back through it in this round: `blocks_history` and the change-feed
summaries see the live rows only (§7).

## 7. Rebuild and garbage

**Rebuild.** `sections` is recomputed per live doc from `blocks` (§4.6);
`block_changes` is `INSERT OR IGNORE … SELECT block_id, commit_id, kind FROM
dispositions` after a `DELETE FROM block_changes` (17.0: the whole table —
through 16.x the rows of wholly archived commits were kept, since each was
its block's mint claim; the claim is an `id_claims` row now, §2.1); the FTS index is `INSERT INTO
blocks_fts(blocks_fts) VALUES('delete-all')` followed by one insert per
live leaf of every live doc (`spec/search` §1.1; FTS5's `'rebuild'` would
index the whole content table, containers included); `doc_edges` is the graph
component's. A rebuilt deterministic table equals the maintained one row for
row (§8 I8).

**Garbage collection** is the recorder's (17.0, M7/D10): the core owns **no
byte GC** — a live or tombstoned block's bytes are on its row and a
document's frontmatter on its row, so `blobs` reachability is purely a
question of the recorder's revisions. It is mark-and-sweep from every
**live** revision's `root_tree` (`WHERE root_tree IS NOT NULL`, walking
`child_tree_hash_hex`) and every non-NULL `frontmatter_blob`: reachable tree
nodes and blobs (raw, trivia, frontmatter) are kept, the rest deleted —
nothing in the current rows roots a blob, and nothing a `blocks` row holds
can be swept. The two collections the core owns are the **feed prune**
(§7.4) and the **claims prune** (§7.3), which the same `gc` runs — the
feed first, so a commit id whose last feed row went this run can be
released by the same run once its window has passed. **The mark is explicit
(16.0):** a node marks the objects its own text names — every entry of a
`[`-node, the `+`/`~` entries of a `{`-node (their raw and trivia blobs,
and their child hashes, walked the same way) — and never resolves a delta.
What a delta keeps "as the base" is named by the base revision's own nodes,
and the base-liveness rule (§4.4) makes that revision live whenever the
delta is, so the explicit mark reaches everything a resolve would. The
frontmatter column marks the blob it names, raw or delta; the raw a delta
is over is the base revision's blob. It ships behind a flag, **off**. Through 14.x nothing was ever unreachable (revisions were never
pruned); since 15.0 the retention squash below NULLs an archived revision's
body columns after copying the bodies to a segment and runs this very sweep
inside its own transaction, so `omg gc` still finds nothing — §8 I5 checks
exactly that over the live revisions. The only routine collection is the
pool sweep (§5.5).

**The `same` sweep** (14.2). The same collection — the default sweep, under
the same flag, no option — also deletes every `block_changes` row and every
`dispositions` row with `kind = 'same'`: what a store through 14.1 wrote for
every untouched block of every commit (§5.4 step 10) and nothing reads. The
result reports the three counts side by side — `blobs`, `tree_nodes`,
`same_dispositions` (the reference's `GcResult` spells them `blobsSwept`,
`treeNodesSwept`, `sameDispositionsSwept`; the CLI prints `swept <b> blobs,
<t> tree nodes, <s> same dispositions`, `spec/cli` §6). A **dry run** counts
all three and deletes nothing. A fresh 14.2 store never has such rows, so
the sweep is a no-op there; on a 14.1 database it is the whole reduction.
It is a sweep and not a migration on purpose: a data-only change needs no
`user_version` (a store major for nothing), opening a database must never
bulk-delete (writer lock, WAL growth and startup time on a 130 MB file),
gc already has the fixture device in both engines and runs on the user's
schedule, and `gc --vacuum` is what returns the pages afterwards. Rebuild
(above) is unchanged — `block_changes` is still derived from `dispositions`
— and since the sweep deletes the same rows from both tables, §8 I8 holds
before and after it. `garbage::sweep-removes-pre-14.2-same-rows` pins it.

### 7.1 Retention: plan, export, squash (15.0)

History is never lost, but it need not all stay hot. A **retention policy**
says which revisions of a document stay in the store and which move to an
**archive segment** — a separate SQLite file holding their bodies — while
every `revisions` and `commits` row stays where it is, so the `revisions`
query target, `docs_history` and `changes_since` keep listing an archived
revision and only a read of its *bytes* needs the segment. The measurement
behind it: a 131 MB database over 5 MB of Markdown held 57 MB of history,
read almost never and worth keeping forever.

**The policy** lives in the repository's effective settings under
`history.retention` (`spec/sync` settings: the workspace layer, a repo's
over it), each key defaulting as shown; a run may pass a partial policy that
replaces keys for that run only (`omg history … --policy`):

```yaml
history.retention:
  keep_days: 30            # every revision younger than this is kept
  ladder:                  # beyond keep_days, one revision per period per rung
    - { after_days: 30,  keep: "one per day" }
    - { after_days: 365, keep: "one per month" }
  per_doc_max: 200         # the newest N revisions of a document are kept regardless of age
  keep_origins: ["api"]    # a revision whose commit has this origin AND a non-empty reason is kept
  overrides:               # the first glob that matches the document's current path replaces the keys it names
    - { glob: "/attn/focus.md", keep_days: 7, per_doc_max: 50 }
    - { glob: "/projects/**", keep_days: 36500 }
```

`keep` is one of `one per day`, `one per week`, `one per month`, `one per
year`; a ladder is sorted by `after_days`, two rungs may not share one;
every count is a non-negative integer; a glob is matched against the
`/`-rooted reference path (`**` any run of characters, `*` any run without
`/`, `?` one character; a glob without a leading `/` is rooted). A malformed
policy is refused before anything is evaluated.

**The plan** (`evaluate_retention(repo, now, before?, policy)`) is the policy
as an exact rule — deterministic in the store, the policy and the clock
`now` (the process clock, `OMGBASE_SPEC_CLOCK` in a conformance run). For
every document of the repository, over its **live** revisions (`archive IS
NULL`) in `seq` order, with the document's policy (the base, or the first
matching override's keys over it), a revision is **kept** when any of these
holds, and **archived** otherwise:

1. it is the document's `head` (a tombstoned document's last revision is
   its `head` — §5.6 never clears it);
2. *(retired in 17.0 — M4: a `pending_materializations` row renders from
   the current rows and names no revision; through 16.x a revision a
   pending row named as `rev_id` was kept here. The slot is kept so the
   rule numbers below do not move.)*
3. its age — `floor((now − commit.ts) / 86 400 000 ms)` in whole days — is
   less than `keep_days`;
4. it is among the newest `per_doc_max` live revisions of the document;
5. its commit's `origin` is in `keep_origins` and its `reason` is non-null
   and non-empty;
6. `before` was given and `commit.ts >= before`;
7. no ladder rung applies to its age — the rung of a revision is the one
   with the greatest `after_days` not above its age; a revision older than
   `keep_days` but younger than the first rung's `after_days` (the gap, and
   every revision under an empty ladder) is kept, since nothing says to thin
   it;
8. it is the **representative** of its bucket: among every live revision of
   the document whose rung is the same and whose commit `ts` falls in the
   same period of that rung's grain — the UTC calendar day `YYYY-MM-DD`, the
   ISO week (keyed by its Monday's date), the month `YYYY-MM`, the year
   `YYYY` — the one with the greatest `seq`. Kept-by-other-rules revisions
   count toward the bucket, so a bucket whose newest revision is already
   kept keeps nothing extra.

The never-prunable set is rules 1–2. The first revision of a document is
**not** in it: a block minted in an archived commit stays an id in use
whichever revision minted it, because its `id_claims` row carries the
recorder's hold (§2.1, bit 1), which the squash never releases. (Through
16.x the same guarantee rested on the squash keeping each block's earliest
`block_changes` row.)

The plan's **bytes** are what archiving would reclaim, by the GC mark: mark
every tree node and blob reachable from the revisions that stay live in the
**whole store** (every repository — blobs and tree nodes are shared); per
document, the bytes (`blobs.size`, the byte length of `tree_nodes.entries`)
of what its archived revisions reach and that mark does not; the total over
the union of the archived revisions' exclusive objects (a blob two archived
documents share counts once in the total and in both documents). The mark
is the explicit one of §7 (16.0), so the figure is what the squash's sweep
will delete; it does not subtract the checkpoint forms the squash writes for
the dependents (§7.1 "The squash", step 0) — the result's `gc` counts are
the truth after the fact. The plan
is `{ policy, now, before, docs: [{ id, path, revisions, keep: [rev…],
archive: [rev…], bytes }], totals: { docs, revisions, keep, archive, bytes }
}` — `docs` holds only the documents with something to archive, by path;
`totals.revisions` is every live revision of the repository.

**Segments.** `history export` writes **one new file per run, never
appending**: a SQLite database with `archive.sql`'s DDL at
`<dest>/<repo_id>-<seq_lo>-<seq_hi>-<segment_id>.omgarchive.db` (`dest`
defaults to `<workspace>/.omgbase/archives/`), holding

- `manifest` — one row: `segment_id` (**minted** with the `s` prefix, so the
  fixture minter makes it `s_0`, `s_1`, …; a content hash would depend on
  the file's page layout), `repo_id`, `created_at` (= `now`), `policy` (the
  effective policy as JSON), `seq_lo`/`seq_hi` (the smallest and greatest
  `commits.seq` among the archived revisions' commits), `revision_count`,
  `previous_segment` (the repo's `history.last_segment` setting at the
  time, `NULL` for the first — the chain), `schema_user_version` (16);
- `revisions` — the archived revisions' rows **with** a `root_tree` and
  `frontmatter_blob` in **checkpoint form** (16.0, §4.4): the hash of the
  revision's resolved tree written as self-contained full nodes, and of its
  resolved frontmatter raw — not the store's columns, which may name deltas
  over revisions the segment does not hold;
- `commits` — the distinct commits of those revisions (copies; the store's
  rows stay hot);
- `blobs` and `tree_nodes` — **everything** the archived revisions' checkpoint
  forms name, shared with live revisions or not: the full nodes (computed
  from the resolved trees — a delta revision's full nodes were never rows of
  the store), the raw and trivia blobs they reference (rows of the store,
  since the bases are live), and each resolved frontmatter raw as a blob;
  so a segment is readable on its own and holds no delta;
- `dispositions` and `block_changes` — every row of the **wholly archived
  commits**: a commit each of whose revisions is in this export or already
  archived (one revision per commit on the observe path; an `api` commit
  over several documents moves only when all of them have).

The file is written to `<name>.partial`, with `synchronous = FULL`, in one
transaction, closed (fsynced), made read-only (`0444`) and **renamed** to
its final name: a complete segment is exactly a file bearing the final
name, and a stale `.partial` under `dest` is deleted at the start of a run.
Compression is at rest and the user's (`zstd` the file after export);
attaching a compressed file is not supported in this round. Nothing to
archive → no file.

**The squash** (`history export --prune`), one transaction on the store,
**after** the segment is durable:

0. **(16.0) re-checkpoint the dependents**: for every archived revision *s*
   whose revision *s + 1* (same document) exists, is live and is not itself
   archived by this squash — in `rev_id` order, each once — resolve *s + 1*'s
   tree and frontmatter (its bases are still intact), put its checkpoint
   forms (`INSERT OR IGNORE`: every list a self-contained full node, the
   frontmatter raw a blob) and `UPDATE revisions SET root_tree, frontmatter_blob`
   to them; a revision already in checkpoint form is left alone and not
   counted. This is the base-liveness rule of §4.4 maintained;
1. for every archived revision: `UPDATE revisions SET root_tree = NULL,
   frontmatter_blob = NULL, archive = <segment_id>`;
2. for every wholly archived commit: `DELETE FROM dispositions WHERE
   commit_id = ?` and `DELETE FROM block_changes WHERE commit_id = ?` —
   **every row** (17.0; 15.0–16.x kept each block's earliest row so the
   mint oracle still knew the id — the `id_claims` row does that now, §2.1,
   and the squash touches no claim);
3. the garbage sweep above (mark from the live revisions, delete the rest —
   exactly the bodies the segment now holds alone);
4. `INSERT OR REPLACE INTO archives (segment_id, repo_id, path, seq_lo,
   seq_hi, created_at, revision_count, bytes)` and the repo's own settings
   gain `history.last_segment = <segment_id>`.

The result reports `segment { id, path, seq_lo, seq_hi, created_at,
revision_count, bytes, previous_segment }`, `squashed { revisions, commits,
dispositions, block_changes, checkpointed }` (rows changed, the
block_changes count being the rows deleted, `checkpointed` the dependents
step 0 re-wrote — 16.0) and `gc { blobs, tree_nodes }`.

**The crash rule.** A complete segment under `dest` whose `segment_id` no
`archives` row carries is classified by its revisions: all still live →
**pending** (the export crashed, or ran without `--prune`) and the next run
finishes it — the same squash over the file's revision list, `reused:
true`, no new file, no new mint — before considering a new export; all
archived → **detached** (a `detach` left the file; `attach` brings it back;
the run ignores it); a mix → **stale** (the file belongs to another store
or predates a different squash) and the run refuses with the offending
revision named, touching nothing. `history list` shows every recorded
segment as `attached` (file present) or `missing`, and the unrecorded ones
under `dest` by these three states.

**Attach / detach** record and forget segments in `archives`: `attach
<file>` reads the manifest (a non-segment or another repository's is
refused), `INSERT OR REPLACE`s the row with the file's current size (so a
moved file is re-recorded by attaching it again) and drops any stale alias;
`attach <dir>` does so for every `.omgarchive.db` of the directory whose
manifest `repo_id` matches, skipping the rest; `detach <segment_id|path>`
deletes the row and detaches the alias. The revisions keep their `archive`
pointer either way — detaching changes what a read answers (§6.2), never
what the history says.

### 7.2 Size and vacuum (14.1)

**Size** (14.1). The store answers "what is this database made of" with
one report, `size_report`, both engines computing it the same way from the
open connection:

- *File*: `path` (the connection's; `:memory:` when none), `bytes` (the
  main file's size on disk; `page_count × page_size` in memory),
  `wal_bytes` (the `-wal` file's, 0 when absent), `page_size`,
  `page_count`, `freelist_count` (the pragmas), and `reclaimable =
  freelist_count × page_size` — the bytes a `VACUUM` returns.
- *Tables*: every b-tree's pages from the `dbstat` virtual table
  (`SELECT name, sum(pgsize) FROM dbstat GROUP BY name`). An index's pages
  count toward its table (`sqlite_master.tbl_name`; `indexes` reports that
  part); an FTS5 virtual table's shadow tables (`<name>_data`, `_idx`,
  `_docsize`, `_config`) fold into it, and its `rows` are its `_docsize`
  rows — the rows it indexes (a `count(*)` on an external-content table
  answers from the content table); every other table's `rows` is its
  `count(*)`. The table set is `sqlite_master`'s tables (shadows folded)
  plus `sqlite_schema` itself. Without `SQLITE_ENABLE_DBSTAT_VTAB` in the
  build every `bytes`, `share` and `indexes` is null, the report carries
  `detail: "dbstat unavailable"`, and the tables order by rows.
- *Categories*, always the **six** (17.0, D9 — four through 16.x), in this
  order, each with `bytes` (its tables' sum), `share` (one decimal of the
  dbstat total, rounded half up), `rows` (its tables' sum) and its tables by
  bytes desc then name: **content** — the live state: `docs`, `blocks`,
  `sections`, `nodes`, `edges`, `doc_edges`, `external_nodes`, `properties`;
  **identity** — the ids and the pool: `id_claims`, `resurrection_pool`;
  **recovery** — the payloads a crash replays: `pending_materializations`;
  **history** — the recorder's capture: `blobs`, `tree_nodes`, `revisions`,
  `commits`, `dispositions`, `block_changes`, `edge_transitions`, `archives`;
  **search** — the derived indexes: `blocks_fts`, `nodes_fts` (the core's),
  `embeddings`, `doc_embeddings` (the semantic bundle's — one category, two
  owners); **sync** — the workspace bookkeeping: `repos`, `capabilities` (the
  manifest, 3e-ii — the contracts' §7.5 assignment), `alerts` (3e-ii —
  unassigned by the contracts; filed here as bookkeeping about the
  workspace, not content), `sources`, `adapters`, `attachments`, `feed`,
  `feed_entries` (the change feed is delivery bookkeeping, not history;
  `checkpoints` left with D4), `file_stats`, `sync_state`,
  `workspace_settings`, and *anything this spec does not name* (`sqlite_schema`, a `sqlite_stat1`, a table from a newer
  schema). A table added to any of the three DDL files is assigned here in
  the same change (both engines' tests check the assignment covers them).
  Through slice 3d `id_claims`, `resurrection_pool` and
  `pending_materializations` were filed under `history`, `collections` and
  `inferred_edges` under `content`.
- *`same_dispositions`* (14.2): `count(*)` of `dispositions` rows with
  `kind = 'same'` — the rows a store through 14.1 wrote and the `same`
  sweep removes; 0 on a fresh 14.2 store. A top-level integer beside
  `categories`.
- *`archived`* (15.0): `{ revisions, segments, bytes }` — the `revisions`
  rows with `archive IS NOT NULL`, the `archives` rows, and the recorded
  segment files' bytes on disk (a missing file counts 0). The history that
  already left the file.
- *`id_claims`* (17.0): `count(*)` of `id_claims` — one row per id ever
  minted and still held (§2.1), the identity's own growth: the claims
  table is what remains of a deleted block after its row, its pool entry
  and its history are gone. A top-level integer beside `same_dispositions`;
  the CLI's human report prints it as `id claims  <n> ids claimed`
  (`spec/cli` §6). `identity.claims_retain_days` (§7.3) is the knob that
  bounds it.
- *`feed`* (17.0, slice 3e-i): the change feed's position and policy —
  `{ epoch, oldest, head, entries, retain_days, retain_entries, max_entries }`
  (§7.4: the repository's epoch, the oldest and greatest retained `seq`, the
  retained rows of the current epoch, the effective policy). The report is
  store-wide and the feed is a repository's, so the member is the
  repository the caller names, else the store's only one, else `null` (a
  store with several repositories and no selection — never an error). The
  CLI's human report prints it as `feed  epoch <ep>, <n> entries, seq
  <oldest>..<head>` (`spec/cli` §6).
- *`capabilities`* (17.0, slice 3e-ii): the manifest (§3.1) of the same
  repository as `feed` (the named one, else the only one, else `null`), as
  `[{ capability, state, coverage_from, config }]` — `history` then
  `semantic`, `coverage_from` rule 2 of §3.1 (null when none), `config` the
  row's object (`{}` for history, `{ model?, dim? }` for semantic); a
  repository with no row for a capability reports `{ state: "disabled",
  coverage_from: null, config: {} }`. The CLI's human report prints two
  lines, `history  enabled since <coverage_from> | disabled` and `semantic
  enabled (<model>) | enabled | disabled` (`spec/cli` §6).
- *Advice*, deterministic strings in this order, each conditional: `run
  \`omg gc --vacuum\` to return <bytes> of free pages to the filesystem`
  when `reclaimable` exceeds 1 MiB *and* 10 % of `page_count ×
  page_size`; `history dominates (<share>): blobs, tree nodes and
  dispositions grow with every commit — enable gc (\`omg config set
  gc.enabled true\`) and run \`omg gc --vacuum\`` when `history`'s share
  exceeds 50; `<n> same dispositions are history nothing reads (store
  14.2): \`omg gc\` removes them, \`--vacuum\` reclaims the pages` when
  `same_dispositions` is positive and exceeds 25 % of the `dispositions`
  table's `rows` (a share over rows, so it holds without `dbstat` too;
  14.2); `<n> revisions older than the policy would archive <bytes>: \`omg
  history export --prune\`` (15.0) when the retention plan (§7.1) of every
  repository of the store under its effective policy at the report's clock,
  summed, would archive at least one revision and its `bytes` exceed 10 %
  of the `history` category's bytes (dbstat only: the comparison needs the
  pages); `embeddings are <share> of the database: a smaller model
  (\`embedding.model\` / \`embedding.dim\`) or \`omg embed drain --prune\`
  after a model switch shrinks them` when `embeddings` + `doc_embeddings`
  exceed 25 % of the total; `identity claims are <share> of the database:
  set identity.claims_retain_days to release old ids` (17.0, slice 3e-ii —
  the contracts' §7.5) when `id_claims`' bytes exceed 10 % of the total
  (dbstat only); else the single line `nothing to reclaim`. The feed-cap
  line (17.2, Phase 4b) reads the alert channel: `` the feed holds <n>
  entries over <d> day[s] (floors <retain_entries> / <retain_days>): raise
  feed.max_entries or shorten the sync interval `` is emitted, after the
  claims line, when the report's repository has an active `feed_capped`
  alert (§5.8 — the write-time cap pruned rows) — `<n>` the feed's retained
  rows, `<d>` the days its retained rows span (`ceil((max(ts) − min(ts)) /
  1 day)`), the floors the effective settings'.
  `<bytes>` is humanized — `<n> B` under 1024, else one decimal of a
  1024-based KB/MB/GB/TB with the tenths rounded half up (`4096` →
  `4.0 KB`) — and `<share>` is `<n>.<d>%`; both engines format from the
  integer tenths so no rounding mode can differ.

### 7.3 Claims prune (17.0)

The one collection the core owns (D5). Setting **`identity.claims_retain_days`**
(`spec/sync` settings — the workspace layer with the repo's own over it, as
`history.retention`; a non-negative integer, **default null = never**;
anything else is a malformed policy and refused). When set for a
repository, the default `gc` sweep (§7 — enabled, never a dry run, at the
clock `now`) releases the **core's hold** (clears bit 0) on every claim of
that repository whose `minted_at` is older than `now − claims_retain_days`
**and** whose id names **no core row**: no `docs.doc_id` or `docs.head`, no
`blocks.block_id`, no `resurrection_pool.block_id`, no
`pending_materializations.head`, no `external_nodes.node_id`, no
`edges.edge_id`, no `repos.repo_id`, no `sources.source_id`. A
workspace-scoped claim (`repo_id` NULL — a `src`) is judged by the
workspace layer's setting alone. Then every claim with `holders = 0` is
deleted. The prune **scans** `id_claims` (no secondary index since
2026-10-26, §10 — gc-time work, run once per sweep). Consequences, by construction: a `d` is never released (its
tombstone row is the identity and stays); a live block's `b`, the head's
`r`, an open edge's `e` never are; a block deleted long ago, an old head, a
closed edge are released once the window has passed; while the recorder
holds the id (bit 1) the row stays and the id stays in use — only a
repository without history (or after `history purge`) ever sees a row
leave, and then the id may be minted again (§2.1 "Reuse"). The result
reports `claims_released` (the holds released; the `GcResult`'s
`claimsReleased`, the CLI's `, <n> id claims released` suffix when
non-zero — `spec/cli` §6); a dry run releases and counts nothing. The
squash (§7.1), the pool sweep (§5.5) and `history purge` never touch bit 0.
`claims::prune-releases-the-core-hold-and-keeps-the-recorders` and
`claims::pruned-claim-with-no-holder-is-deleted` pin it.

### 7.4 Feed retention (17.0)

The feed is **catch-up, not history** (D7): a consumer that is behind reads
what the feed still holds; one that has fallen past it **rescans**
(`spec/sync` §6) — and the log, when the history capability is on, is the
recorder's `commits`, never pruned by this rule. Three settings
(`spec/sync` §3 — the workspace layer with the repository's own over it),
each a non-negative integer: **`feed.retain_days`** (default **10**, a
floor), **`feed.retain_entries`** (default **10 000**, a floor),
**`feed.max_entries`** (default **100 000**, a cap). A feed row is
**prunable** when it is older than `retain_days` (by `ts` against the
clock) **and** more than `retain_entries` rows of its epoch are newer than
it; it is **pruned regardless** when more than `max_entries` rows of its
epoch are newer. "More than" is literal: a row with exactly `retain_entries`
newer rows is kept, so a floor of *n* leaves at least *n* + 1 rows and the
cap at most `max_entries` + 1. Pruning deletes the row and its entries,
oldest first, and never the row with the greatest `seq` (it has no newer
row). The cap is enforced **inside the transaction that appends a feed row**
(§5.4 step 5); the floors run in `gc` (§7, enabled, never a dry run, at the
clock `now`), before the claims prune, and report **`feed_pruned`** (the
rows deleted; the `GcResult`'s `feedPruned`, the CLI's `, <n> feed rows
pruned` suffix when non-zero — `spec/cli` §6). A `max_entries` below
`retain_entries` is a malformed policy and refused, as is any other value.
Rows of a **previous epoch** are deleted whole by the epoch re-mint (§7.5
— a restore or a rebuild-from-files). The **bootstrap lease** (D7, resolution 2) is the floor
itself: a consumer that reads `head` at the start of a rescan and finishes
within both floors is guaranteed `(epoch, head)` is still a valid cursor
(`spec/surface` §3); no server-side lease object exists, and retention never
waits on a consumer. A pruned row's commit id stays claimed while the
recorder holds it (§2.1); with history off the claims prune (§7.3) may
release it once nothing names it. `feed::retention-floors-prune-old-rows-
beyond-the-entry-floor`, `feed::retention-days-floor-keeps-young-rows`,
`feed::cap-prunes-at-write-time-regardless-of-the-floors` and
`feed::prune-never-takes-the-newest-row` pin it.

### 7.5 Epoch re-mint (17.0)

`ensure_repo` mints the repository's `ep` and writes `repos.epoch` (§3.1).
A **restore** (a database recreated from elsewhere — `omg restore`, a
`source add --rebuild`; opening a copied file is not detectable) and a
**rebuild-from-files** (a recovery that re-ingests every file as a fresh
batch — not `rebuild-index`, which re-derives from the rows) **re-mint the
epoch**: in one transaction, mint and claim a new `ep` at the clock (§2.1,
`holders = 1`), delete the repository's `feed` and `feed_entries` rows of
**every** epoch — the old epoch is unreachable by any cursor (`spec/surface`
§3: a cursor of another epoch is `expired_cursor`, and the consumer rescans)
and its rows would never be served — and write the new epoch on the `repos`
row; the next commit is `seq = 1` of the new epoch. The recorder's `commits`
keep their old `epoch` (the log is history: `UNIQUE (repo_id, epoch, seq)`
lets the sequences restart), and every earlier `ep` stays claimed. No
production path of the reference takes it yet (neither restore nor
rebuild-from-files exists there); the store exposes it as
`remint_epoch(repo, ts)` and the fixtures pin it through the `remint_epoch`
step (§9.4; `feed::remint-epoch-starts-the-feed-over`): two commits under
`ep_0`, the re-mint, then a commit at `seq = 1` of `ep_1` with the feed
holding that row alone, `commits` keeping `c_0`/`c_1` under `ep_0`.

### 7.6 History purge (17.2, Phase 4b)

`omg history purge [--before <ts>]` (`spec/cli`; `phase-1-contracts.md`
§1.14, D2 step two) is the recorder's collection the operator asks for:
the repository's **captured history leaves the store**, in one transaction
under the writer lock. Needs the module (`capability_unavailable { history,
unavailable }` otherwise); a database without the bundle has nothing to
purge (every count 0). The steps, in order:

1. **The purged commits** are the repository's `commits` rows — all of them,
   or those with `ts < before` — EXCEPT, **while the repository's capture is
   `enabled`**, the commit a live document's head revision belongs to: the
   head's row is the present, not the past, so an enabled repository trims
   its history and keeps H1, I4 and `docs_history`'s retained head; a
   `disabled` repository owes nothing and purges all.
2. **Re-checkpoint first** (§4.4 base liveness, the squash's rule): every
   retained revision whose predecessor (`seq − 1`, same document) is purged
   is re-written in checkpoint form while its base is still readable.
3. The purged commits' `revisions`, `dispositions` and `block_changes` rows
   go.
4. **The interval record is trimmed to the cut**: an `edge_transitions`
   row whose `to_commit` is purged goes (the interval closed before the
   cut); a row whose `from_commit` is purged but which is open or closes
   after the cut is **re-anchored** — `from_commit` = the earliest retained
   commit of the repository in (`ts`, `seq`) order (the interval was already
   open at the cut, as `history enable`'s baseline records an edge it finds
   open); when no commit remains every row of the repository goes.
5. The purged `commits` rows go; then every `archives` row of the repository
   no revision names any more (the segment is detached, its file untouched).
6. The unreachable bodies are swept (§7's mark from the live revision roots).
7. **The holds**: bit 1 is released on every claim of the repository that no
   history row names (`revisions.rev_id`/`doc_id`, `block_changes.block_id`,
   `dispositions.block_id`, `edge_transitions.edge_id`, `commits.commit_id`)
   — while capture is `enabled` the hold SURVIVES on every id a live core
   row names (a live document and its head, a live block, an open edge:
   exactly the set a baseline holds, §5.9, so I7 and H6 keep holding); with
   capture off every unreferenced hold goes. A claim left with no holder is
   deleted. The core's bit 0 is never touched (§7.3).
8. **The drop**: when NO repository of the database is `enabled` and every
   history table is empty after the purge, the bundle's tables are dropped
   (indexes with them) — a workspace-wide decision taken automatically and
   reported, so a database that purged its last history is a core database
   again; the next `history enable` re-executes the DDL (§3.1).

**The manifest is untouched** — neither `state` nor `coverage` moves.
Coverage records when capture was ON; a purge changes what is retained, not
what happened, and the distinction is what `spec/surface` §2.1's read states
rest on: a token minted inside an interval whose row is gone reads `pruned`
("was captured but its history has been purged"), one minted outside every
interval `outside_coverage` ("capture started <coverage_from>"). (The
contracts' §7.3 sketched `coverage = []`; that would make every purged token
read as never captured and leave `pruned` unreachable — §10.) `history
disable` never implies a purge.

The receipt: `{ purged: { commits, revisions, blobs, tree_nodes,
dispositions, block_changes, edge_transitions, archives }, claims_released,
coverage, tables_dropped }` — the rows removed per table (`blobs`/`tree_nodes`
the sweep's), the holds released, the manifest's coverage as it stands, and
whether step 8 ran. The §8 family reads after a purge as §8's preamble says
(H4 and I4 from the log's oldest retained row). Fixtures: `purge::purge-all-
on-a-disabled-repository-drops-the-bundle` (three captured commits, disable,
purge → every history table `[]`, the holds released, the tables dropped, a
second purge finds nothing, a core-only write after it) and `purge::purge-
before-trims-an-enabled-repository` (three revisions of one document, a
`--before` between the second and the third → the first two go, the head's
revision is re-checkpointed and reads back byte for byte, the open edge is
re-anchored at the retained commit, the holds on the two purged revision ids
released and the live set's kept; the next edit is a delta on the
re-checkpointed row) — `cases/history/purge.json`; `spec/surface`
`reads::history-coverage` pins the read states; `spec/cli`
`history::history-purge-disabled`/`history-purge-before-enabled` the verb.

**Vacuum** (14.1). `vacuum` runs SQLite's `VACUUM` on the bare connection
(never inside a transaction, which SQLite refuses) and returns the free
pages' bytes measured just before — what the file shrinks by. It rewrites
the whole file; the CLI exposes it as `gc --vacuum` behind gc's flag
(`spec/cli` §6). The pinned behavior: afterwards `freelist_count` is 0, the
content and history are intact (`integrity_check` is `ok`), and a second
vacuum returns 0.

## 8. Invariants

A runner checks these on the database after every observe step and at the
end of every case; an implementation may assert them in its own tests.
Since 17.0 they come in two groups: the **core** invariants (C1–C8, F1–F3,
A1) hold on the current rows alone, under every composition; the
**history** invariants (H1–H6 and I2, I4–I10 as restated) say the
recorder's capture **agrees** with the head and are checked when the
composition carries the history module and the bundle's tables exist — and
(17.1, Phase 4a) **within the repository's coverage**: what capture
promised is bounded by the manifest's `coverage` intervals (§3.1). Reading
the H*/I* family under optional capture, with `in_coverage(ts)` = some
interval has `from ≤ ts` and (`to IS NULL` or `ts < to`): **H1/H3** are
owed for a live document whose head was minted within coverage
(`updated_at` in coverage); a head minted while capture was off has a row
only when a later `history enable`'s baseline wrote one — then the row's
commit is the baseline's, so C7's "`updated_at` equals the head commit's
`ts`" is not compared for it (its `updated_at` is outside coverage).
**H4**: a retained feed row owes a `commits` row only when its `ts` is in
coverage AND its `seq` is at or after the log's oldest retained row of the
epoch (17.2: a `history purge` trims the log's head, §7.6 — a feed row older
than every retained commit owes none, a repository with no commit owes
none); every `commits` row of the current epoch at or after the oldest
retained feed row IS a feed row (the log is a subsequence of the feed).
**I4**: `commits.seq` is strictly increasing in (`ts`, `seq`) order per
epoch, and consecutive from the log's oldest retained row only when capture
was never off (one open interval from the repository's birth — dense `1..n`
unless a purge trimmed the head); `revisions.seq` stays consecutive per
document, from 1 unless a purge trimmed the document's history (17.2); a
live document's head is its greatest-seq revision when its `updated_at` is
in coverage; "a head with no revision" is a problem only in coverage. **H6**
(the edges agree with the open transitions) holds while capture is on —
the edges move freely while it is off and the next baseline reconciles them
(§5.9). **I7**'s "a live block has a `block_changes` row or the recorder's
hold" is owed for a block born in coverage (a baseline holds every live
block). Under a core-only composition (§5.9, §9.6) only C*, F* and A1 are
checked. (`docs/modular-core/phase-1-contracts.md` §1.15 is the source.)

- **C1 Convergence.** For every live doc: `docs.file_hash == sha256(last
  observed source)` and `reconstruct(doc) == source` (§6.1) — from the rows
  alone. (On the api path the file lags the store while a pending row
  exists — §5.7; the `spec/mutate` runner compares such a path against the
  store's own reconstruction, as it does for a `disk` edit.)
- **C2 Row hashes (17.0).** Every `blocks` row: `raw_hash == sha256(raw)`;
  `trivia` and `trivia_hash` are both `NULL` or `trivia_hash ==
  sha256(trivia)` (never an empty `trivia`); `norm_hash == sha256(text)`.
- **C3 Blocks are the head.** For every live doc the live `blocks` rows read
  as a tree (children by `parent_block`, `order_key` order) are exactly the
  parse of `source` with the assigned ids: `ordinal` dense from 0 per parent
  and agreeing with `order_key` order, `depth`/`ancestor_path` per §4.3,
  every `parent_block` a live row. (Through 16.x this was I3's structural
  half; the mirror against the recorder's tree is H3.)
- **C4 The head and the dense feed (17.0).** Every live doc has a non-NULL
  `head`; the repository has an `ep_` epoch. The retained `feed.seq` of
  `(repo, epoch)` is a **contiguous** range `oldest..head` in `ts`-then-`seq`
  order, every row's `epoch` equals `repos.epoch`, every `commit_id` and
  `batch_id` is a `c` id, a row's `batch_id` names a row at or before it
  (unless pruned), a `plan_id` is 64 hex and only on an `api` row.
- **C5 Claims (17.0).** Every id a core row of the repository carries —
  `docs.doc_id`, `docs.head`, `blocks.block_id` (live or tombstoned),
  `resurrection_pool.block_id`, `external_nodes.node_id`, `edges.edge_id`,
  the repo's own `repo_id` and `epoch`, every `feed.commit_id` and
  `batch_id`, every `feed_entries.head` — names an `id_claims` row with bit 0 set; no
  claim has `holders = 0`; a claim's `id` starts with its `prefix` and its
  `minted_at` is a §2.4 timestamp.
- **C6 Pool (I6 restated, 17.0).** Every `resurrection_pool` row has a §2.4
  `deleted_at`, `expires_ts == deleted_at + 30 days` exactly, `created_at ≤
  deleted_at`, and a block id with no live `blocks` row. (Through 16.x the
  row named a `deleted_commit` and the expiry was checked against that
  commit's `ts`.)
- **C7 Timestamps.** `created_at ≤ updated_at` on every doc and block; a
  live doc's `updated_at` equals the `ts` of the commit that minted its head
  (H1's commit; 17.0: the `ts` of the feed row whose entry carries its
  head, when that row is within retention); a block's `updated_at ≤` its document's; `docs.deleted_at` is
  `NULL` on every live doc and non-NULL on every tombstoned one; every
  `blocks` row has `deleted_at IS NULL` and belongs to a live document (17.3,
  D2 step two — a tombstone deletes the rows; through 17.2 a tombstoned doc
  kept its rows tombstoned and no live doc had one); and a tombstoned doc's
  `deleted_at == updated_at`.
- **C8 Pending rows (17.0, M4).** Every `pending_materializations` row's
  `doc_id` names a `docs` row of the repository; `kind = rename` ⇔
  `from_path IS NOT NULL`; `created_at` is a §2.4 timestamp (with capture
  on, the `ts` of the `commits` row `commit_id` names) and `commit_id` a `c`
  id. A `write`/`rename` row names a **live** document, `head == docs.head`
  (the row always names the document's CURRENT head — the supersession
  rules of §5.7 are what keep this true), and `rendered_hash ==
  docs.file_hash == sha256(reconstruct(doc))` (§6.1). A `remove` row names a
  **tombstoned** document with `head IS NULL`, `prior_hash IS NULL` and
  `rendered_hash == docs.file_hash` (the bytes before the tombstone, which
  §5.6 keeps). `prior_hash` is defined, not derivable — it names bytes the
  engine wrote at the path that no current row holds — so only its nullness
  is checked.
- **C9 Bytes reproducible, or named (17.4, §5.11).** For every live doc
  with a `file_hash`: `sha256(reconstruct(doc)) == file_hash`, **or** the
  repository's `legacy_bytes` alert is active and names it — then
  `detail.docs` is the count of such documents and every id of
  `detail.sample` is one of them (A1's reading of the code). A document the
  active alert names is a legacy document until the sweep repairs it: C1's
  `reconstruct(doc) == source` clause is what C9 relaxes for it, and H3's
  trivia-hash clause is not owed for it (its capture is the 16.x one — the
  recorder's tree names no trivia, as the rows name none). After the repair
  the rows carry the trivia and the recorder's tree still does not: H3's
  trivia clause is not owed for a **repaired** legacy head either, and
  neither is H1's "reconstruct at it `== source`" — the capture is the 16.x
  capture until the document's next commit. A runner cannot tell such a head
  apart (no column records the repair), so the fixtures reach the legacy
  state through `spec/sync`'s `sql` device, which erases the rows'
  separators and leaves the recorder's tree whole; on them H1/H3 hold again
  after the repair. (The 16 → 17 migration itself never produces a
  repaired head — the state exists only after a sweep.)
- **F1 Every head is in the feed (17.0).** Every live doc's `head` appears
  as some retained entry's `head`, and every tombstoned doc has a retained
  `deleted` entry — for the documents whose `updated_at` is **not older
  than the oldest retained row's `ts`**: a prune takes rows from the front
  (`oldest > 1`), and an epoch re-mint (§7.5) empties the feed, after which
  the documents committed before it have no entry and none is owed (an
  empty feed makes the rule vacuous). Every entry's `seq` has a feed row,
  its `epoch` is the repository's, its `doc_id` a `docs` row.
- **F2 Oldest and head.** `oldest ≤ head`, and `oldest = 0` iff `head = 0`
  (an empty feed).
- **F3 Entry shape.** A `deleted` entry has NULL `head` and `hash`; every
  other kind has both (the head an `r` id); `from_path` is non-NULL iff the
  kind is `moved`, and then `from_path ≠ path`. Per document, over the
  retained feed in `seq` order: a `created` entry follows nothing or a
  `deleted` one, and a `changed`/`moved` entry never directly follows a
  `deleted` one (a revival is `created`).
- **A1 Alerts re-derive (17.0, slice 3e-ii).** Every active `alerts` row
  has a §2.4 `since` and a severity of `info`/`warning`/`error`, and names a
  condition the store can re-derive — or is advisory. The runner first
  re-derives the channel at its own clock (`active_alerts`, §5.8 — what every
  reader does; a pending row superseded since the last read leaves the
  backlog alert stale until then, by design), then checks: a
  `materialization_backlog` row's `detail.oldest` is the `created_at` of a
  `pending_materializations` row of the repository and `detail.pending ≥
  1`; `materialization_failed` and `writer_refused` are advisory (a past
  event, cleared by the next success); a `legacy_bytes` row's
  `detail.docs` equals the size of the repository's legacy set (§5.11) and
  its `sample` names members of it (C9). A cleared row is not checked.
- **H1 Capture agrees with the head (I1 restated).** For every live doc
  `docs.head` names a live `revisions` row with `path == docs.path`,
  `rendered_hash == file_hash == sha256(source)` and its commit's `ts ==
  updated_at`; reconstruct at it (§6.2) `== source` with
  `rendered_hash_match = true`; and `docs.frontmatter_raw` equals the
  revision's resolved frontmatter raw (`NULL` when it has none).
- **I2 Hash integrity.** Every `blobs` row: `hash == sha256(bytes)`, `size ==
  |bytes|`. Every `tree_nodes` row: `hash == sha256(entries)` and `entries`
  parses as §4.1 — a `[`-form list, or a `{"d":…}` delta — with every
  `raw_hash_hex`/`trivia_hash_hex` **it names** present in `blobs` and every
  `child_tree_hash_hex` it names present in `tree_nodes` (every entry of a
  full node; the `+`/`~` entries of a delta — 16.0). Every non-NULL
  `revisions.root_tree` present in `tree_nodes`; every non-NULL
  `frontmatter_blob` in `blobs`, its bytes a raw (`-`) or a `{"f":…}` delta
  that parses (15.0: an archived revision's are NULL).
- **H3 Blocks mirror the head revision (I3 restated as agreement).** For
  every live doc, the live `blocks` rows, read as a tree (children by
  `parent_block`, `order_key` order), have exactly the ids, types,
  `raw_hash`es, trivia hashes and `attrs` of the head revision's
  **resolved** tree (§6.2; walking `child_tree_hash_hex`), in the same
  order. Through 16.x this was a dependency (the rows' bytes were readable
  only through the tree's hashes); since 17.0 it is a check that the
  recorder captured what the core committed.
- **I4 Dense sequences.** `commits.seq` is `1..n` per `(repo, epoch)` in
  `ts`-then-seq order (17.0: a re-mint restarts the sequence, §7.5);
  `revisions.seq` is `1..k` per doc; `head` is the revision with the
  greatest `seq`.
- **H4 The log agrees with the feed (17.0).** For every retained feed row
  a `commits` row exists with the same `commit_id`, `epoch`, `seq` and
  `batch_id`; every `commits` row's `epoch` is the repository's or a
  claimed earlier `ep` of it (a re-mint, §7.5 — the feed's `seq` is a
  subsequence of the current epoch's log; the prune takes rows from the
  feed only).
- **I5 Nothing to collect.** The **explicit** mark set of §7 — from the
  **live** revisions (15.0: `root_tree IS NOT NULL`, plus every non-NULL
  `frontmatter_blob`; 16.0: a `{`-node contributes only the entries it
  carries) — equals all of `blobs` and `tree_nodes` (GC would sweep zero
  rows). Over
  live + archived history the statement is: every body is either reachable
  from a live revision in the store or held by the segment its revision's
  `archive` names; the runner checks the first half on the store and the
  second through `read_at` (§9.4).
- **H6 The recorder's hold (17.0).** Every id a history row of the
  repository names — `revisions.rev_id`, `revisions.doc_id`,
  `block_changes.block_id` (`DOC` excepted), `commits.commit_id`,
  `edge_transitions.edge_id` (3e-i) — names an `id_claims` row with bit 1
  set. **The edges agree (M6):** every `edge_transitions` row with
  `to_commit IS NULL` has an `edges` row of the same `edge_id` with the same
  `dst_node`, and every `edges` row such an open transition. (I6 is C6
  since 17.0.)
- **I7 Dispositions.** Every disposition's `commit_id` exists. For every
  commit that is the *current* commit of at least one live doc, over the live
  docs whose current revision it wrote (one on the observe path; N for an
  `api` changeset, §5.4 "The api path" — 13.7, one doc before): every
  disposition of that commit whose kind is not `deleted` or `merged_into`
  (and whose block is not `"DOC"`) names a live `blocks` row of one of those
  docs, and every `deleted`/`merged_into` one names no live row of any of
  them. (Older commits are not checked against `blocks`: a block `inserted`
  under one doc may legitimately be live in another after a later
  cross-document resurrection.) No row has `kind = 'same'` (14.2; §5.4
  step 10 never writes one and the §7 sweep removes a 14.1 store's), and
  `block_changes` is exactly the `(block_id, commit_id, kind)` projection
  of `dispositions` (I8) — so every live block has at least its `inserted`
  (or lineage/resurrection) row **unless the commit that wrote it is wholly
  archived** (17.0: the squash deletes every row of such a commit, §7.1
  step 2 — the recorder's hold on the block's claim, H6, is what remains),
  and a block's rows are the commits that changed it.
- **I8 Rebuild equivalence.** `sections` and `block_changes` recomputed per
  §7 equal the stored rows — `block_changes` over every commit (17.0: a
  wholly archived commit has no `dispositions` and no `block_changes` rows,
  so the whole-table rebuild reproduces the table; 15.0–16.x exempted the
  archived commits' surviving earliest rows).
- **I9 Archived revisions (15.0).** `archive IS NOT NULL` ⇔ `root_tree IS
  NULL`, and an archived revision's `frontmatter_blob` is NULL; a document's
  `head` is never archived. A wholly archived commit (one with at
  least one revision and no live one) has no `dispositions` row and (17.0)
  **no `block_changes` row** — through 16.x each block's earliest row
  survived for the mint oracle; the claim (§2.1) holds the id now.
- **I10 Deltas resolve (16.0).** For every live revision: its root list and
  its frontmatter **resolve** (§6 — every `{`-form met has a base, and its
  ops consume exactly that base); when its root node or frontmatter blob is
  a `{`-form, revision `seq − 1` of the document exists and is live (the
  base-liveness rule, §4.4); when it is a **checkpoint** by §4.4 rules 1–2
  (`(seq − 1) mod 16 == 0`, or no live predecessor), its root is
  self-contained and its frontmatter blob a raw; every `{`-form list of its
  resolved tree, and a `{`-form frontmatter, is **strictly smaller** in UTF-8
  bytes than its full form (rule 3); and a `{`-form root or frontmatter is
  byte for byte the §4.1 encoding against the predecessor's resolved list or
  raw (the Myers script, grouped). I5 and I10 together are what makes the
  explicit mark complete.

## 9. Fixtures

### 9.1 Layout

`cases/<suite>.json`, `suite` = file stem. Three kinds of suite, told apart
by the case shape: `schema.json` (§9.2, one case), `migrations.json` (§9.3),
and observation suites (§9.4) — `observe.json`, `identity.json`,
`deletion.json`, `pool.json`, `structure.json`, `frontmatter.json`,
`batch.json`, `claims.json` (17.0:
the `id_claims` table — a mint writes a claim, a deleted block's id stays
claimed after its pool row expires, the recorder's hold, the prune under
`identity.claims_retain_days`, a pruned claim's deletion, a tombstone and
revival), `feed.json` (17.0: the change feed, its retention, the epoch
re-mint), … as the coverage grows. A fourth kind lives under
`cases/history/` — the **recorder suites** (§9.5), whose cases observe the
recorder alone: `edge-transitions.json` (projecting `edge_transitions`),
and since slice 3e-ii the observation scripts `garbage.json` (the GC
sweep), `delta.json` (16.0: the measurement scenarios of §10 as
observation scripts) and `retention.json` (the archive squash), moved
there with the §9.4 projection they always had, and (17.1, Phase 4a)
`capture.json` — the capture lifecycle (§5.9): capture switched off and
writes that record nothing but the feed, a repository born disabled and the
baseline an `enable` writes, the edge record reconciled, a recorder that
throws rolling the member back. Case ids are `<suite>::<name>` (the suite
is the file's base name, the directory is not part of it).

### 9.2 Schema fingerprint

```jsonc
{
  "suite": "schema",
  "cases": [ { "name": "fresh", "notes": "optional", "expect": { "user_version": 13, "tables": { "<name>": { "columns": [ { "cid": 0, "name": "…", "type": "TEXT", "notnull": 1, "dflt_value": null, "pk": 1 }, … ], "foreign_keys": [ { "from": "repo_id", "table": "repos", "to": "repo_id" } ] } }, "indexes": { "<name>": { "table": "…", "unique": 0, "origin": "c", "partial": 1, "columns": ["…"] } } } } ]
}
```

Generated by the reference from a fresh `:memory:` store. A runner opens a
fresh database and compares its own fingerprint; `origin` is `c` (explicit),
`u` (UNIQUE) or `pk`; auto-indexes (`sqlite_autoindex_<table>_<n>`) are
keyed by their names like any other index, since SQLite assigns them
deterministically from the DDL.

### 9.3 Migrations

```jsonc
{
  "suite": "migrations",
  "cases": [
    {
      "name": "v12-to-v13-root-path-becomes-fs-source",
      "notes": "…",
      "setup": [ "CREATE TABLE repos (repo_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, root_path TEXT, settings TEXT NOT NULL DEFAULT '{}')", "…", "INSERT INTO repos (repo_id, slug, root_path) VALUES ('rp_1','vault','/data/vault')" ],
      "user_version": 12,
      "rows": ["adapters", "sources", "attachments", "repos"],
      "expect": {                     // GENERATED
        "user_version": 13,
        "tables": { "<name>": ["<column>", …], … },   // every table, column names in cid order
        "rows": { "sources": [ { "source_id": "src_0", "name": "vault-fs", "adapter": "fs", "config": "{\"root\":\"/data/vault\"}", "env": "{}" } ], … }
      }
    }
  ]
}
```

`setup` statements run on an empty database (a temp file or an in-memory
connection the implementation then adopts), then `PRAGMA user_version` is
set, then the database is opened by the implementation (which migrates;
repos are visited in `rowid` order) **under the fixture clock**
`2026-09-27T00:00:00.000Z` (17.0, slice 3e-ii — the reference pins its
process clock, the crate's opener takes `now`): wherever §3.4 says "the
migration's clock" — the manifest's `updated_at`, a coverage start with
no commit to anchor on, a `created_at` with no commit — that instant is
what the projection carries.
`setup` and `rows` may be empty. `rows` names the tables whose full contents
(every column, `ORDER BY rowid`) the `expect` carries; blobs are hex;
`tables` maps every table to its column names in `cid` order. The fixture
minter (§2.2) is active, so ids minted by a migration (`src_0`) compare.
When opening must fail (a newer `user_version`), `expect` is instead
`{ "error": "<the exact message>" }` — `migrations::newer-version-is-refused`
pins `database schema (v18) is newer than this build (v17); upgrade omgbase`.
`migrations::v16-to-v17-heads-inline-bytes-time` pins step 17 over a 16.x
pre-state with a frontmatter delta chain, a tombstone and two pool rows —
and, since 3b, the pool's `deleted_at` and the `id_claims` backfill: a
live block's `3`, a tombstoned block's `1`, a pooled block known to
`block_changes` `3`, an old revision's `2`, the heads' `3`, the repo's `1`;
since 3e-ii it projects `capabilities` (the `history` row `enabled` with
its interval from the first commit's `ts` and `updated_at` the fixture
clock; the `semantic` row `disabled` — the pre-state configures no
provider) and — since 17.4 — the one `alerts` row step 17 (16) raises over
it (its authored `file_hash` X'06' is not the hash of its raws, so the
fidelity check names `d_1`: `legacy_bytes`, `warning`, the message with the
count 1, `since` the fixture clock, detail `{"docs":1,"sample":["d_1"]}`).
`migrations::v16-to-v17-legacy-trivia` (17.4) pins the check on purpose: a
pre-state with a legacy document (both blocks' `trivia_hash` NULL, the
document's `file_hash` the real sha256 of `# A\n\nPara.\n`) and a healthy
one (its trivia blobs stored, the real hash of its file) comes out with the
alert naming the legacy document alone and the rows untouched.
`migrations::v15-to-v16-is-lazy` pins step 16: a 15.x pre-state with two
revisions, a full node and a raw frontmatter blob comes out at
`user_version` 16 with every `revisions`, `tree_nodes` and `blobs` row
unchanged.

### 9.4 Observation scripts

```jsonc
{
  "suite": "identity",
  "cases": [
    {
      "name": "edit-carries-ids",
      "notes": "optional prose",
      "config": { "theta_accept": 0.62 },          // optional spec/reconcile §6 overrides
      "steps": [
        { "observe": { "ts": "2026-09-26T10:00:00.000Z", "items": [ { "path": "a.md", "source": "# Title\n\nFirst.\n" } ] } },
        { "observe": { "ts": "2026-09-26T10:01:00.000Z", "items": [ { "path": "a.md", "source": "# Title\n\nFirst, edited.\n" }, { "path": "b.md", "source": null } ] } },
        { "sweep": { "ts": "2026-11-01T00:00:00.000Z" } }
      ],
      "expect": {                                    // GENERATED
        "steps": [
          [ { "path": "a.md", "echo": false, "doc": "d_0", "commit": "c_0", "rev": "r_0", "converged": true, "conflicted": false, "dispositions": { "inserted": 2 } } ],
          [ { "path": "a.md", "echo": false, "doc": "d_0", "commit": "c_1", "rev": "r_1", "converged": true, "conflicted": false, "dispositions": { "same": 1, "edited": 1 } },
            { "path": "b.md", "deleted": false, "doc": null } ],
          { "swept": 0 }
        ],
        "docs":        [ { "doc_id": "d_0", "path": "a.md", "format": "markdown", "head": "r_1", "file_hash": "<hex>", "conflicted": 0, "leading_trivia": "", "frontmatter_raw": null, "frontmatter_trivia": null, "created_at": "…", "updated_at": "…", "deleted_at": null } ],
        "commits":     [ { "commit_id": "c_0", "epoch": "ep_0", "seq": 1, "ts": "…", "origin": "observed", "actor": null, "reason": null, "batch_id": "c_0", "ops": null }, … ],
        "feed":        [ { "epoch": "ep_0", "seq": 1, "commit_id": "c_0", "ts": "…", "origin": "observed", "actor": null, "reason": null, "batch_id": "c_0", "plan_id": null }, … ],
        "feed_entries": [ { "epoch": "ep_0", "seq": 1, "doc_id": "d_0", "path": "a.md", "head": "r_0", "hash": "<hex>", "kind": "created", "from_path": null }, … ],
        "revisions":   [ { "rev_id": "r_0", "doc_id": "d_0", "seq": 1, "root_tree": "<hex>", "frontmatter_blob": null, "rendered_hash": "<hex>", "path": "a.md", "commit_id": "c_0" }, … ],
        "blobs":       [ { "hash": "<hex>", "size": 7, "bytes": "# Title" }, … ],
        "tree_nodes":  [ { "hash": "<hex>", "entries": "[[\"b_0\",\"…\",null,\"heading\",{\"level\":1},\"…\"],…]" }, … ],
        "blocks":      [ { "block_id": "b_0", "doc_id": "d_0", "parent_block": null, "order_key": "V", "ordinal": 0, "depth": 0, "ancestor_path": "/", "type": "heading", "attrs": { "level": 1 }, "text": "Title", "raw": "# Title", "raw_hash": "<hex>", "norm_hash": "<hex>", "trivia": "\n\n", "trivia_hash": "<hex>", "created_at": "…", "updated_at": "…", "deleted_at": null }, … ],
        "dispositions": [ { "commit_id": "c_0", "block_id": "b_0", "kind": "inserted", "confidence": null, "reason": null, "matcher_v": "m2.3", "detail": {} }, … ],
        "block_changes": [ { "block_id": "b_0", "commit_id": "c_0", "kind": "inserted" }, … ],
        "resurrection_pool": [ { "block_id": "b_1", "doc_id": "d_0", "raw_hash": "<hex>", "norm_hash": "<hex>", "type": "paragraph", "created_at": "…", "deleted_at": "…", "expires_ts": "…" } ],
        "id_claims":   [ { "prefix": "b", "id": "b_0", "minted_at": "…", "holders": 3 }, … ],
        "sections":    [ { "doc_id": "d_0", "heading_block": "b_0", "level": 1, "first_ordinal": 0, "last_ordinal": 1 } ],
        "pending_materializations": []
      }
    }
  ]
}
```

**Inputs** (authored):

- Every case runs on a fresh database with one repo `rp_0` (slug `fixture`)
  created before the first step; `repo_id` is therefore omitted from every
  projected row. The fixture minter (§2.2) is installed before the repo is
  created (the repo id is its first `rp` mint).
- `"minter": "repeat"` (optional, 13.5) installs the **repeating** fixture
  minter instead: the sequential counter whose every id is offered twice
  (`rp_0, rp_0, b_0, b_0, b_1, b_1, …`). Because the store rejects an id in
  use (§2.1), the case's projection must equal the same case run with the
  plain sequential minter — the fixture pins the redraw, and a store that
  does not check would fail on the primary key (`identity::repeat-minter-
  redraws-on-collision`). Ids issued and rejected are not counted anywhere.
- `steps` is a non-empty list. `observe` carries `ts` (§2.4 format, checked
  by the validator) and `items` in batch order; an item is `{ path, source }`
  with `source` a string (the exact file content) or `null` (the path is
  gone). Paths are repo-relative, no leading slash, end in `.md`, and are
  distinct within one batch. `sweep` carries `ts`. `gc` (14.2) is `{}` or
  (17.0) `{ ts }`: the §7 collection, enabled, never a dry run, `ts` the
  claims prune's clock (§7.3; the runner's own clock without it — a case
  whose `gc` must release a claim names its `ts`, and sets the policy with
  an `exec` step on `repos.settings`). `exec` (14.2) is `{ sql: [
  "<statement>", … ] }`: authored SQL run verbatim, in order, in one
  transaction — the device that puts rows a 14.2 store never writes (a 14.1
  store's `same` dispositions) into a case; a statement may not reference
  anything the fixture minter has not issued, and the invariants are not
  checked after it (only after the next `observe`/`gc`/`history_export`).
  The retention steps (15.0, §7.1) run against the case's own **archive
  directory** — a temporary directory the runner creates on the first of
  them and removes with the store; `<dest>` stands for it in a projected
  path: `history_plan { ts, policy?, before? }` (the plan at `ts`; `policy`
  a partial over the defaults — a fixture repo has no settings; `before`
  as §7.1), `history_export { ts, policy?, before?, prune }` (the export at
  `ts` into `<dest>`), `history_attach { segment }` / `history_detach {
  segment }` (by segment id; `attach` resolves the id to the file under
  `<dest>` named `…-<segment>.omgarchive.db`), `read_at { doc, rev }` (§6.2,
  through a segment when the revision is archived). `remint_epoch { ts }`
  (17.0, §7.5) re-mints the repository's epoch at `ts` → `{ epoch: "<ep>"
  }`. **The lifecycle steps (17.1, Phase 4a; §5.9):** `history_enable { ts,
  writer_requires? }` and `history_disable { ts }` run the two verbs at `ts`
  → `{ history: { state, coverage, writer_requires, changed, baseline?:
  { commit, revisions } } }` (the manifest row's capture state after the
  verb; `baseline` on an `enable` that changed something); `history_purge {
  ts, before? }` (17.2, §7.6) runs `history purge [--before]` at `ts` → `{
  purge: { purged: { <table>: n }, claims_released, coverage, tables_dropped
  } }` (the receipt); `recorder_fault
  { fail }` is the runner's **fault device** (§5.4 step 15, resolution 18):
  `fail: true` makes every capture call of the store's recorder throw until
  `fail: false` → `{ fault: boolean }` — the next `observe` then records a
  rolled-back member as `{ path, failed: true, doc, error }` (`error` the
  `capture_failed` message with the fixture's reason `recorder fault
  (fixture device)`), and the ids that member minted before the rollback
  are consumed (the minter is a process counter). `expect.steps` has one
  entry per step.
- `capabilities` (optional, 17.1): the case's composition — `{ history:
  false }` creates the repository with capture off (`disabled`, no coverage,
  `writer_requires 0`, no history table), as a core-only build or `omg
  source add --no-history` would; absent, capture is on from the
  repository's birth as before.
- `config` overrides any subset of `spec/reconcile` §6 for every observe step
  of the case (the store passes it through).

**Expect** (generated) is the projection of the database after the last step:

- `steps`: one entry per step. For `observe`, a list of outcomes in item
  order — observed items as `{ path, echo, doc, commit, rev, converged,
  conflicted, dispositions }` (`commit`/`rev` `null` on an echo;
  `dispositions` a kind → count object over every verdict, `same` included
  — §5.4; `{}` on an echo), gone items as
  `{ path, deleted, doc }` (`doc` null when nothing was live). For `sweep`,
  `{ swept: <rows deleted> }`. For `gc` (14.2, 17.0), `{ gc: { blobs,
  tree_nodes, same_dispositions, claims_released, feed_pruned } }` — the
  three counts of §7, the claims prune's of §7.3 and the feed prune's of
  §7.4 (`ts` is both prunes' clock). An `exec` step is also the fixture's
  device for a settings write (`UPDATE repos SET settings = …` — the
  `feed.*` policy of §7.4 in `feed.json`). For `exec` (14.2),
  `{ changes: <rows changed, summed over the statements> }`. For the
  retention steps (15.0): `history_plan` → `{ plan: <the §7.1 plan
  verbatim> }`; `history_export` → `{ export: { segment: { id, seq_lo,
  seq_hi, revision_count, previous_segment } | null, reused, squashed: {
  revisions, commits, dispositions, block_changes, checkpointed } | null,
  gc: { blobs, tree_nodes } | null } }` (`squashed`/`gc` null without
  `prune`; `checkpointed` since 16.0, §7.1 step 0; the file's path and
  bytes are not projected); `history_attach` → `{
  attached: [{ segment_id, seq_lo, seq_hi, revision_count }] }`;
  `history_detach` → `{ detached: <segment id> | null }`; `read_at` → `{
  raw, rendered_hash_match }`, or `{ error: "revision_archived", rev,
  archive, path? }` with `path` as `<dest>/<file name>` when the segment is
  recorded but not on disk, or `{ error: "target_missing" }` when `rev` is
  not the document's.
- `docs` ordered by `path`; `commits` by (`ts`, `seq`) — the order `seq`
  alone gives while one epoch exists, the chronological one across a
  re-mint (17.0: `{ commit_id, epoch, seq, ts, origin, actor, reason,
  batch_id, ops }`); `feed` (17.0, slice 3d)
  by `seq` as `{ epoch, seq, commit_id, ts, origin, actor, reason,
  batch_id, plan_id }` and `feed_entries` by (`seq`, insertion order — the
  member order of the commit) as `{ epoch, seq, doc_id, path, head, hash,
  kind, from_path }`, both emitted after `commits` — the rows of the repo's
  current epoch (a fixture database has one; `ep_0`, the minter's first);
  `revisions` by `(doc_id
  bytewise, seq)`; `blobs` and `tree_nodes` by `hash`; `blocks` by doc (in
  `docs` order) then **pre-order** over the doc's rows (children by
  `parent_block`, `ordinal` order; since 17.3 no tombstoned row exists to
  project);
  `dispositions` and `block_changes` by (the commit's rank in the `commits`
  projection, `block_id` bytewise,
  `kind` bytewise); `resurrection_pool` by (`expires_ts`, `block_id`
  bytewise), as `{ block_id, doc_id, raw_hash, norm_hash, type, created_at,
  deleted_at, expires_ts }`; `id_claims` (17.0) by (`prefix` bytewise, `id`
  bytewise) as `{ prefix, id, minted_at, holders }` — the repository's own
  `rp` claim and its epoch's `ep` claim omitted, like `repo_id` is from
  every row (the runner minted the first two before the first step, at its
  own clock; a `remint_epoch` step's `ep` is omitted the same way) — emitted after
  `resurrection_pool`; `sections` by (`doc_id` bytewise, `first_ordinal`);
  `pending_materializations` (14.0; 17.0's columns) by `path`, as `{ path,
  kind, from_path, doc_id, head, rendered_hash, prior_hash, commit_id,
  created_at }` (hashes as hex, `prior_hash` `null` when NULL) — `[]` here
  unless an `exec` step put a row in (`retention::never-prunable-current-
  and-tombstone-pending-row-pins-nothing` does), since only the api path
  inserts rows; the `spec/mutate` scripts (its §9), which share
  this shape, pin the rows through their `crash_after_commit` modifier and
  `materialize {}` step; `revisions` rows carry `archive` (15.0; `null`
  until a squash) and `archives` (15.0) is projected by (`seq_lo`,
  `segment_id`) as `{ segment_id, file, seq_lo, seq_hi, created_at,
  revision_count }` — `file` the recorded path's file name (the directory is
  the run's), `bytes` omitted (a page layout, not a behavior).
- Hash columns as hex; `attrs` and `detail` as JSON objects (compared with
  key order ignored); `bytes` as the decoded string; `raw`, `trivia` and
  `frontmatter_raw` (17.0) as the strings they are; every other column as
  its SQLite value (`INTEGER` → number, `NULL` → `null`). A `tree_nodes`
  row's `entries` is projected as its text whatever its form (16.0: a
  `{"d":…}` delta reads as the string it is — the fixture pins the
  encoding, not an interpretation), and a frontmatter delta is a `blobs`
  row like any other.
- Tables outside §3.1/§3.2's pinned set are not projected; neither are
  `capabilities` and `alerts` (3e-ii) — the lifecycle steps project the
  manifest's capture state in their outcomes, and an observation script's
  only alerts are advisory (`capture_failed` after the fault device; the §8
  A1 check runs over them). **The fixture birth clock (17.1):** the runner
  creates the case's repository under the pinned clock
  `2000-01-01T00:00:00.000Z`, before every authored `ts`, so the manifest's
  first coverage interval covers the whole script and the history
  invariants apply to every captured document (the `rp`/`ep` claims minted
  then are omitted as before; `coverage[0].from` reads that instant in a
  `history_disable` outcome). `migrations.json` projects both tables (§9.3),
  the surface fixtures pin the channel on the wire (`spec/surface` §6
  `reads::alerts`). A history table that does not exist (a repository born
  disabled, never enabled) projects as `[]`.

**Runner checks, per case**: after each observe step and at the end, the
invariants of §8; then the projection deep-equals `expect` (numbers exactly —
nothing here is floating point except `confidence`, compared within 1e-9 as
in `spec/reconcile`).

**Generation.** `packages/core/corpus/store/spec.test.ts` asserts the
reference reproduces every committed `expect` and, with
`STORE_SPEC_UPDATE=1`, rewrites each case's `expect` in place from its inputs
(inputs, `notes` and case order untouched); the diff is reviewed like code.
`schema.json` is regenerated the same way from a fresh store.

**Allowlist (Rust).** `crates/omgbase-store/tests/spec-passing.txt` names the
case ids that must pass while the port runs behind the fixtures (a listed
case failing, an unlisted case passing, or a stale id all fail the build);
`STORE_SPEC_UPDATE=1 cargo test -p omgbase-store --test spec` rewrites it
from the passing set and deletes it once everything passes. When the file is
absent, every case must pass. Same mechanism as the other specs.

### 9.5 Recorder suites (17.0)

`cases/history/<suite>.json` — observation scripts exactly as §9.4
(`steps`, the fixture minter, repo `rp_0`; `config` allowed, `minter` not)
whose `expect` projects **history-bundle tables alone**, so a runner compares
them only when the composition under test includes the bundle (through
Phase 3 every runner does). `edge-transitions.json` (slice 3e-i — M6; the 21
scripts of `spec/graph` 2.x's `intervals.json`) projects

```jsonc
"expect": { "edge_transitions": [ { "edge_id": "e_0", "src_doc": "d_0", "src_block": "b_0", "src_field": null, "predicate": "references", "dst_kind": "document", "dst_node": "phantom:x.md", "anchor": null, "provenance": "link", "via_node": null, "from_commit": "c_0", "to_commit": "c_1" }, … ] }
```

— every column but `repo_id`, sorted by (`from_commit`'s rank in the
`commits` order, `edge_id` bytewise), `to_commit` as the commit id or
`null`: row for row what `spec/graph` 2.x projected as `edges`, since the
recorder's row is 16.x's edges row verbatim and follows adoption. **Runner
checks** beyond §8: every `from_commit`/`to_commit` names a `commits` row
(the check that moved here from `spec/graph` §7) and H6's agreement with the
open edges. **The recorder-only observation scripts** (slice 3e-ii) —
`garbage.json`, `delta.json`, `retention.json` — live here too, **with the
full §9.4 projection they always had** (their core tables are the context
the recorder's rows are read against; moving them changed no `expect`): a
runner for a composition without the history bundle skips the whole
directory, and a composition with it runs them exactly as §9.4. The capture
lifecycle's suites are `capture.json` (17.1) and `purge.json` (17.2, §7.6).

### 9.6 The four compositions (17.1, Phase 4a; generalised 17.3, Phase 5a)

Every fixture runner must be able to run the SAME scripts on each of the
plan's four compositions and assert the invariants that composition owns.
The reference selects the composition with `OMGBASE_CAPABILITIES` (§5.9 —
the test-only override; `envComposition()`): **`full`** (the default; the
fixtures are its record), **`history`** (the recorder, no semantic module),
**`semantic`** (the semantic module, no recorder) and **`core`** (neither).
`pnpm conformance` (`scripts/conformance.mjs`) runs every suite under all
four in sequence and prints the suite × composition matrix from each
runner's ledger line — `[<suite> spec] composition=<name>: compared=<n>
mapped=<n> skipped=<n>` (compared = as recorded, mapped = compared through
the composition's mapping, skipped = needs the absent module) — failing on
any red cell. Every runner refuses its `*_SPEC_UPDATE` under a reduced
composition: the fixtures are the full composition's.

**Without the history module** (`core`, `semantic`): a case's repository is
born `disabled`, no history table exists, no history row is written. The
store runner (1) runs the cases whose steps are `observe` / `sweep` /
`remint_epoch` only and **skips** — reporting them — the ones that need the
module (a retention step, a lifecycle step, the fault device, a `gc` whose
counts and claims prune see the recorder's holds, an `exec` that may name a
history table); (2) checks C*, F*, A1 (§8); (3) compares the projection on
the **core tables** — `docs`, `feed`, `feed_entries`, `blocks`,
`resurrection_pool`, `sections`, `pending_materializations`, `steps` — with
the history tables `[]` on both sides and `id_claims` compared with bit 1
masked off (a claim the recorder alone held drops out); (4) skips
`migrations.json` (a build without the module does not upgrade a 16.x
database — its frontmatter deltas resolve through the recorder; the opener
refuses with "upgraded by an engine that carries the history module") and
`cases/history/` wholesale. The `spec/mutate` runner does the same over its
projection (`commits`/`revisions`/`dispositions` emptied) and skips a case
with a retention or lifecycle step; the `spec/surface` runner maps the
history tools' answers and skips the `revisions`-root queries and the
retention/lifecycle cases (`spec/surface` §7.3); the `spec/sync` checkpoint
runner compares with the history tables emptied (`spec/sync` §8); the
`spec/graph` and `spec/search` suites reach no history table and compare as
recorded; the `spec/cli` runner skips the cases whose inputs or recorded
outputs carry an observable of the module (`spec/cli` §8).

**Without the semantic module** (`core`, `history`): a fresh database holds no
semantic table (§3.1 — the bundle follows the composition) while a migrated
one keeps whatever its older schema carried (a 16.x `doc_embeddings` stays;
`history` upgrades a 16.x database but executes no semantic DDL). The store
runner therefore compares the schema fingerprint and a migration case's table
list with `embeddings`/`doc_embeddings` and their indexes removed from BOTH
sides; nothing else in this spec touches the module. The `spec/surface` runner maps a semantic case's
`provider_unavailable`/"needs an embedding provider" to `capability_unavailable
{ semantic, disabled }` and skips the `embed_*`-step cases; the `spec/search`
runner runs its pure cases, skips the scripts with a `drain`, a `resolve` or
a `semantic` search, and compares the text-only scripts with the four
semantic projections emptied (`spec/search` §7); the `spec/cli` runner skips
the cases whose inputs or recorded outputs carry an observable of the module.

**Rust.** The Rust runners mirror the rules for the composition their binary
is built or run with; the counts of each cell are part of the contract (the
reference's matrix is in `docs/modular-core/README.md` §6a).

### 9.7 Fault injection (17.3, Phase 5a)

Outside the fixture runners (whose `recorder_fault` device wraps a store's
recorder, §9.4) the engine honours **`OMGBASE_FAULT=<site>[:<nth>]`** — a
TEST-ONLY hook read from the environment on every pass through a named
site: the `nth` pass (default 1, counted per site and per process) throws
an `InjectedFault` (message `injected fault at <site> (pass <n>)`), every
other pass is a no-op; an unknown site or a non-positive count is a
configuration error. The sites, spelled identically by both engines:

| site | where | the acceptance-matrix outcome (plan §8) |
| --- | --- | --- |
| `recorder.capture` | inside the recorder's capture wrapper (§5.4 step 15), before the recorder runs | a recorder throw: the member is ROLLED BACK (`CaptureFailed` whose reason is the fault's message), the `capture_failed` alert is raised, the next capture of the path clears it |
| `feed.append` | inside the commit transaction, before the feed row is inserted (§5.4 step 5, §5.6 step 1) | the whole transaction ROLLS BACK — no feed row, no claim, no row, no file, no alert; the retry lands |
| `commit.after-commit` | the api path, after its transaction committed and before any file is written (`spec/mutate` §4) | the rows are durable, the pending rows owe the files (§5.7); `recoverRepo` replays them and is then a no-op |
| `materialize.before-write` | inside the materializer (§5.7), before a file is written | the pending row stays, the disk is untouched; a replay from `materializePending` raises `materialization_failed` (§5.8) and keeps the row; the next passing replay writes the file and clears the alert |
| `materialize.after-write` | inside the materializer, after the file was written and before its row is deleted | the file holds the new bytes while the row stays; the next replay finds them as recorded and clears the row without rewriting |

The reference pins each outcome in `packages/core/src/fault-injection.test.ts`
(the arming, the counting, the pinned message, and a write driven through
each site). The hook costs one environment read per site when unset.

## 10. Reference oddities surfaced while specifying, and decisions

Each is **pinned** (a fixture asserts it; changing it is a store change under
"Versioning") or **fixed** (the prose above is the fix and the reference is
brought to it).

- **Changed (17.4, Phase 5a-ii) — the migration's fidelity check, the
  `legacy_bytes` alert and the sweep's repair; the FTS index through the
  migration.** Found by running the Phase 5a script on copies of two real
  16.x workspaces (116 and 853 documents; numbers only here). **F1:** in
  the 116-document database every block carried a NULL `trivia_hash` (an
  ingest older than schema v6); 16.x `reconstruct` had assumed NULL meant
  empty trailing bytes and read the documents without the newlines between
  their blocks, while the files and `docs.file_hash` were right; step 17
  (2) copied the rows as they were, so 115 of 116 documents came out with
  `sha256(reconstruct) != file_hash` (the 853-document database, whose
  blocks had their trivia, migrated with no diff). Decided: no column —
  the condition is re-derived where a pass over the bytes is affordable
  (the migration, `doctor`, the sweep while the alert is active) and
  recorded as the `legacy_bytes` alert with a bounded sample (§5.8, §5.11,
  §3.4 step 17 (16)); the on-open entry point is gated by the cheap
  signature of legacy rows so a healthy database never hashes its bytes on
  open; the repair rewrites the separator columns alone, positionally,
  mints nothing and leaves the recorder's capture of the head as the 16.x
  capture (legacy fidelity, C9). Verified on the 116-document copy: the
  alert names 115 documents and the repair rule's structural match holds
  for the parse of every file whose hash equals `file_hash`. **F2:** the
  17.3 finish step deleted a 17.0–17.2 database's tombstoned rows without
  the FTS `delete` command, and a 16.x index built under the rule before
  `spec/search` 1.2 held every block (containers included: 1771 index rows
  for 1547 live leaves on the 116-document copy), so `doctor`'s `fts rows
  == live leaf blocks` failed on every migrated database. Decided: step 17
  (2) rebuilds the index once at the 16 → 17 entry point; the finish step
  purges exactly the tombstoned rows the index holds (`blocks_fts_docsize`
  says which) before the DELETE, since a `delete` for an unindexed row
  corrupts the index. Fixtures: `migrations::v16-to-v17-heads-inline-bytes-
  time` moved (its `alerts` projection gains the row the fake hash earns),
  `migrations::v16-to-v17-legacy-trivia` new; `spec/sync` `checkpoint::`
  three new cases and the `sql`/`legacy_bytes`/`alerts` steps; `spec/cli`
  every `doctor` rendering (the `bytes reproducible` line) and the
  `sync --json` shape (`repaired`).
- **Changed (17.3, Phase 5a) — D2 step two: a tombstone deletes the block
  rows.** No DDL change (`blocks.deleted_at` stays, always NULL). Both
  tombstone paths — the observed deletion (§5.6) and the api `docs_delete`
  (`spec/mutate` §6) — run `DELETE FROM blocks WHERE doc_id = ?` where
  17.0–17.2 ran `UPDATE blocks SET deleted_at = ts`; the finish step of §3.4
  step 17 (15) deletes a 17.0–17.2 database's tombstoned rows on open, after
  the claims backfill. Found while making the change: the only reader of a
  tombstoned row was the primary-key eviction on resurrection (§5.4 step 8 —
  a pooled id re-homed into another document evicted the tombstoned row
  carrying it, and took `created_at` from it), and the pool row already
  carries `created_at` (D6), so revival works with history off without any
  change to the pool; the recorder needed no new seam — the head's last
  captured revision is the deleted content, and §5.6 step 4 already hands it
  the `deleted` transition. Fixtures moved by removal alone: `deletion::`
  ×2, `pool::` ×2, `batch::gone-member-as-move-source`, `capture::disable-
  then-write-captures-nothing`, `retention::never-prunable-current-and-
  tombstone-pending-row-pins-nothing`, `migrations::v16-to-v17-heads-inline-
  bytes-time` (`b_3` leaves `blocks`, keeps its claim and its pool row);
  `spec/mutate` `docs::delete-pools-nothing`, `effects::remove-document-
  effect`, `materialize::` ×4; `spec/sync` `checkpoint::` ×3; `spec/cli`
  `admin::doctor-size-after-rm` (the size table's `blocks` rows 327 → 315
  after an `rm` — the one CLI observable of the change). C7 restated (§8). The runner's `pool::resurrect-into-another-doc-evicts-tombstoned-row`
  keeps its name (the Rust allowlists carry it) and its notes say what it
  pins now.

- **Changed (17.2, Phase 4b) — `history purge`, the semantic lifecycle, the
  feed-cap alert.** No DDL change. (1) **§7.6 `history purge [--before]`**:
  the recorder's rows leave the store per commit — a live head's revision is
  protected while capture is on, the first retained revision after a cut is
  re-checkpointed (the squash's rule), the interval record is trimmed to the
  cut with open intervals re-anchored at the earliest retained commit, the
  recorder's holds released except — with capture on — on the live set, the
  bundle's tables dropped automatically when no repository is enabled and
  nothing is left. **Coverage is not rewritten** (the contracts' §7.3 sketched
  `coverage = []`, `state = 'disabled'`): decided here so that the four read
  states of D3 stay truthful and reachable — a purged token reads `pruned`
  because its claim's `minted_at` falls inside an interval capture was on
  and no row exists; with coverage emptied it would read `outside_coverage`
  ("capture started …") and `pruned` would have no producer. `version`'s
  `coverage_from` therefore still names when capture began, not where
  readable history begins; the receipt reports what left. (2) **§5.10 the
  semantic row is the verbs'**: `embed enable|disable` flip it; a settings
  write re-derives it only when the effective provider CHANGED (17.0–17.1:
  on every settings write), so a `disable` survives unrelated writes and the
  simple path — set the provider, semantic is on; unset it, off — stays. The
  state "disabled with a provider configured" is new and refuses the
  explicit semantic paths with `capability_unavailable { semantic, disabled,
  fix: "omg embed enable" }`; "disabled without a provider" keeps the 5.1
  `provider_unavailable`, so no fixture of the no-provider case moved. The
  reference's `ensure_repo` used to re-derive an existing semantic row on
  every open (it derived `enabled` from the provider) — it now creates the
  row only; a disabled row survives a re-open. (3) **§5.8 `feed_capped`**: the
  write-time cap raises it in the committing transaction, a gc whose cap
  pass prunes nothing clears it; `doctor --size`'s feed-cap advice (§7.2)
  reads the alert instead of the counter the contracts assumed. (4) **§8
  under a purge**: H4 and I4 are owed from the log's oldest retained row; a
  document's `revisions.seq` is consecutive, from 1 unless trimmed. (5) The
  `spec/surface` §2.1 decision table over the claims (`outside_coverage`,
  `pruned`) reads `id_claims.minted_at` of the `r` token — the claim is the
  core's record of when a token was minted, which is exactly what tells the
  two states apart; a token with no claim (never minted here, or pruned by
  `identity.claims_retain_days`) is `target_missing` on an enabled repository
  and `disabled` on one whose capture is off, as 17.1 pinned.
- **Changed (17.1, Phase 4a) — capture is optional: the bundle follows the
  manifest, `history enable|disable`, the reachable refusal, the rollback.**
  (`docs/modular-core/` Phase 4a; `phase-1-contracts.md` §1.14, §1.15,
  §2.1, §2.3, §7 resolutions 17 and 18.) §3.1 "Which bundles a database
  holds" (the history DDL executed when a repository's row becomes
  `enabled`; the semantic DDL with the module); §5.4 step 0 (the refusal,
  outside the transaction) and step 15 (capture only while `enabled`; a
  recorder's throw rolls the member back under `capture_failed`); §5.9 (the
  two verbs, the baseline, who creates a repository disabled, the test
  override); §8 (the H*/I* family within coverage); §9.4 (`capabilities`,
  the lifecycle steps, the fault device, the birth clock); §9.6 (the
  core-only run). Fixtures: `schema::fresh` loses the history tables (a
  fresh database holds the core and semantic bundles); `migrations::v12-to-
  v13-*` ×3 and `v13-to-v14-pending-materializations` gain the history
  tables (their repositories' rows are written `enabled`, and the bundle
  follows), `v16-to-v17-heads-inline-bytes-time` gains `embeddings`/
  `doc_embeddings` (the module's tables on open); `capture.json` new. **The
  baseline is kept from the contracts** (§1.14) rather than dropped: without
  it the edge record and the holds would disagree with the rows after a
  disabled interval (H6, I7), and the invariants would need a per-row
  coverage clause instead of one per family. **No baseline is written when
  nothing changed while capture was off** — the enable still writes its
  feed row and `commits` row (`revisions: 0`), so the log records the
  switch. **Ids minted by a rolled-back member are consumed** (the minter is
  a process counter; the fixture's `recorder-fault-rolls-the-member-back`
  shows `c_1`/`c_2` skipped). **The fixture birth clock**
  `2000-01-01T00:00:00.000Z` is what makes coverage cover an authored script
  (§9.4) — a runner anchoring the repository's birth on its wall clock would
  find every authored `ts` outside coverage and check nothing.
- **Changed (17.0, slice 3e-ii) — the capability manifest, the alert
  channel, the recorder suites' move** (`docs/modular-core/`, Phase 3e-ii —
  the last Phase 3 slice; `phase-1-contracts.md` §1.5, §1.14, §1.16 step
  11, §2.1, §2.3, §2.7, §7 resolutions 1, 17, 18 and "+"). Two core tables:
  **`capabilities`** (§3.1 — the per-repository manifest, written at
  `ensure_repo` and by migration 17 step (13); `version.capabilities` and
  `capability_unavailable`'s state are its rendering, the wire shape
  unchanged — `{ history: { state }, semantic: { state } }`) and **`alerts`**
  (§3.1, §5.8 — raised when a human is needed, cleared when the condition
  ends, carried on every MCP result, printed by the CLI, listed by
  `doctor`). Step 0 of every write is the `writer_requires` check (§5.8;
  trivially true on every 17.0 composition). `doctor --size` files both
  under `sync` and gains the `capabilities` member and the claims-share
  advice (§7.2). Migration 17 steps (13)–(14); the migration fixtures run
  under the fixture clock (§9.3). `garbage.json`, `delta.json` and
  `retention.json` moved under `cases/history/` unchanged (§9.5). Fixtures:
  `schema::fresh` and every `migrations::` case's `tables` gain the two
  tables, `migrations::v16-to-v17-…` projects both; no observation script
  moved. **Decided in the implementation, where the contracts were
  silent:** the coverage encoding is the contracts' `[{ from, to }]` over
  timestamps (not a `(seq, ts)` pair — the feed's `seq` is epoch-scoped and
  re-mintable, §7.5, so a sequence boundary would not survive a restore);
  the semantic row is **always written** (`disabled` when no provider
  resolves — resolution 1 read with rule 1, so a reader never has to tell
  "no row" from "disabled") and **follows every settings write** until the
  Phase 4 `embed` verbs own it (the only way the live state can stay
  truthful without the verbs; a flip opens/closes an interval, a config
  change moves the hash alone); the manifest's `interface_v`/`data_v` are
  the constants 1/1 of §1.5 (the recorder exports them); `alerts` is
  re-derived on read for its derivable condition so the channel is never
  stale and never written when quiet; the backlog threshold is the setting
  `recovery.alert_after_minutes` (default 10, `spec/sync` §3); `since` is
  the clock of the raising read, not the condition's onset; `doctor`'s
  `alerts` check fails on ANY active alert (an alert is by definition a
  condition for a human, so CI should see it); the migration fixtures run
  under the fixture clock because the manifest's `updated_at` is otherwise
  unprojectable; the feed-cap advice line of the contracts' §7.5 is not
  emitted (no counter in the DDL; §7.2); `coverage_from` and
  `writer_requires` stay off the `version` wire until Phase 4 (the brief's
  byte-identity rule for the enabled/enabled fixture workspace). Not here,
  by design (Phase 4): the `history enable|disable|purge` and `embed
  enable|disable` verbs, the conditional execution of a capability's DDL,
  the refusal's reachability, the three codes §5.8 reserves.
- **Changed (17.0, slice 3e-i) — open-only edges, the D9 drops, the six
  size categories, the three-file schema and the epoch re-mint**
  (`docs/modular-core/`, Phase 3e-i: M6, D8, D9; `spec/graph` 3.0). `edges`
  holds the asserted relations alone — closing an edge deletes its row,
  `from_commit`/`to_commit` and `idx_edges_temporal` are gone, no reader
  filters an interval (`has_anchor` included; `reads::has-anchor-open-edges`
  stays as the pin) — and the interval record is the recorder's
  `edge_transitions` (§3.1), written from the transition's edge list the
  core hands it in step 15 and following an open edge's in-place destination
  rewrite; the recorder holds the opened edge's claim (H6). Dropped (D9):
  `properties.created_commit`/`deleted_commit` with the four partial
  predicates and every `IS NULL` filter (a property is live while its
  document's rows are — the per-document rewrite of step 9b keeps that
  true, so no read changed), `collections` (and `edges.dst_kind`'s
  `'collection'`, resolution 9), `inferred_edges`, `idx_edges_temporal`.
  The size report has **six** categories (§7.2 — `content`, `identity`,
  `recovery`, `history`, `search`, `sync`) and a `feed` member. `schema.sql`
  is three files (§3.3: core / history / semantic), the reference pinning
  the partition. The epoch re-mint is §7.5 (`remint_epoch`; the
  `remint_epoch` fixture step; F1, H4 and I4 restated per epoch). Migration
  17 extended in place (steps (10)–(12)). Fixtures: every `spec/graph`
  `edges` row lost the two columns and the one closed row a non-interval
  suite projected is gone; `intervals.json` → `cases/history/
  edge-transitions.json` (§9.5, every row as 2.x projected it) and the
  scripts re-cut as `spec/graph` `open-edges.json`; `feed::remint-epoch-
  starts-the-feed-over` new; `migrations::v16-to-v17-…` gains a closed and
  an open edge, two property rows and the two dead tables; `schema::fresh`
  regenerated; no other store case moved. Decided in the implementation,
  where the contracts were silent: **the recorder mirrors adoption and a
  move's re-phantoming on the open transition** (`retargetEdges`), so the
  moved suite's rows are byte for byte 2.x's and the interval record agrees
  with the edge it describes; **the migration files a closed edge's claim
  under the recorder alone** (bit 0 only for an open row's id — the step
  (4) rule applied to the moved rows; a live close keeps bit 0 until the
  claims prune releases it, as before); **the re-mint deletes the old
  epoch's feed rows** (the contracts' §7.4 says so; no cursor can reach
  them) and keeps every earlier `ep` claimed; **`commits` project by (`ts`,
  `seq`)** — the order `seq` gives while one epoch exists; **the size
  report's `feed` is the named repository's, else the only one's, else
  `null`** (the report is store-wide, the feed a repository's; the
  contracts assume one). Not done here, by design (3e-ii): the
  `capabilities` manifest table and the report's `capabilities` member, the
  `alerts` table and channel, the interop runner's core-composition
  mapping, the recorder-only move of `garbage`/`delta`/`retention`.

- **Changed (17.0, slice 3d) — the slim feed is the core's change record;
  `checkpoints` collapses into the sync status row** (`docs/modular-core/`,
  Phase 3d: M5/D7, D4). `feed` and `feed_entries` (§3.1) are written by the
  core in every commit transaction (§5.4 step 5, §5.6 step 1 — one row per
  commit, one entry per touched document with its `kind` and, on a move,
  `from_path`); `changes_since` reads them and never `commits`/`revisions`
  (`spec/surface` §3: `cursor?`, `epoch?`, `limit?`, `origin?` → `{ digests,
  cursor, epoch, oldest, head, truncated }`, `expired_cursor` under exactly
  three conditions); the repository EPOCH (`repos.epoch`, an `ep` id) scopes
  every `seq`; the commit id is minted and claimed by the core (`c` joins the
  claimed prefixes, §2.1) and the recorder's `commits` row — `epoch`,
  `batch_id`, no `checkpoint_id` — is its twin under the same id and seq
  (H4); `batch_id` is the first committing member's commit id (resolution
  6); `plan_id` rides the feed row (resolution 3); feed retention is §7.4
  (floors `feed.retain_days` 10 / `feed.retain_entries` 10 000, cap
  `feed.max_entries` 100 000, `gc` reports `feed_pruned`); `checkpoints`
  and `commits.checkpoint_id` are dropped, the batch's record is
  `sync_state`'s reserved status row (`spec/sync` §4.1; the result is `{
  batch_id, ingested, suppressed, deleted, conflicted }`, no `cp` is
  minted); the claims prune (§7.3) also protects `feed.commit_id`/`batch_id`,
  `feed_entries.head`, `pending_materializations.commit_id` and
  `repos.epoch`. New invariants C4 (the dense feed), F1–F3, H4; C5/C7/H6
  extended. Migration 17 extended in place (steps (6)–(9)); `migrations::
  v16-to-v17-heads-inline-bytes-time` extended with two checkpoints, a
  16.x `sync_state` row and a `move <from> -> <to>` commit. Fixtures:
  every observation case gains `feed`/`feed_entries` and its `c` claims,
  `commits` rows carry `epoch`/`batch_id`; `feed.json` new (six cases).
  Decided in the implementation, where the contracts were silent: **the
  `ep` claim is minted at the repo's first commit's `ts`** in the migration
  (the epoch is as old as the feed it scopes; the clock when there is none)
  and at the clock in `ensure_repo`, like `rp`; **the entry order of a row
  is its write order** (the member order of an api commit, `revisions`'
  `rowid` order in the backfill); **a backfilled `moved` entry carries the
  document's current head and hash** (what the rows say; none when no live
  document is at `<to>`); **"more than" is literal** in §7.4 (a floor of *n*
  keeps *n* + 1 rows, matching the contracts' own `max_entries + 1`); **the
  migration's prune runs only when the settings layers exist** (a partial
  fixture pre-state may lack `workspace_settings`); **the fixture omits the
  `ep` claim** as it omits `rp` (minted at the runner's clock). Not done
  here, by design: the six size categories (`feed`/`feed_entries` file under
  `sync`, where `checkpoints` was, as the contracts' §7.5 has them), the
  size report's `feed` line, the three-file schema split, the epoch re-mint
  on restore/rebuild-from-files (no such path exists in the reference) — 3e.

- **Changed (17.0, slice 3c) — the pending row is self-contained; the
  materializer reads no history table** (`docs/modular-core/`, Phase 3c:
  M4). `pending_materializations` carries `head` (the token whose bytes it
  renders; `rev_id` with a foreign key into `revisions` through 16.x),
  `prior_hash` (the bytes the engine itself last wrote at the path — the
  `file_hash` the commit validated the file against, captured at commit
  time; through 16.x the materializer derived it from the revision before
  the row's by a `revisions` self-join) and `created_at`; `commit_id` loses
  its foreign key (`commits` is the recorder's). The materializer renders
  `reconstruct(doc)` from the current rows and recognises the engine's own
  stale file by the row; recovery compares the disk to `docs.file_hash`;
  §7.1 rule 2 (the pin on a pending row's revision) is retired; the claims
  prune (§7.3) probes `pending_materializations.head`. Supersession is
  stated and pinned (§5.7): a later write replaces the target and keeps the
  earliest `prior_hash`, a rename carries the obligation of the row at
  `from_path`, a remove drops the write; no limit on pending rows. New
  invariant C8. Migration 17 extended in place (step (5)); `migrations::
  v16-to-v17-heads-inline-bytes-time` carries a `write` and a `remove`
  pending row; `retention::never-prunable-current-and-tombstone-pending-row-
  pins-nothing` replaces the case that pinned a revision for a pending row
  (the revision is archived now and the row survives the squash). The
  gate rule's outcomes are unchanged — it reads `rendered_hash` and does
  not consult `prior_hash` (a reverted file and a crash-stale file are the
  same bytes). Fixtures: the pending-row columns in every projection, the
  two migration and retention cases above, `schema.json`; `spec/mutate`
  `materialize.json` +3 cases.
- **Changed (17.0) — the head and its bytes live on the current rows; no
  current-state read touches a history table** (`docs/modular-core/`, Phase
  3a: M1, M2, D10, D6, D11). `docs.head` (the `r_` token, minted by the core
  on every change — content, structure, path, liveness; `current_rev`
  renamed, resolution 15), `docs.frontmatter_raw`, `blocks.raw`/`trivia`,
  `created_at`/`updated_at`/`deleted_at` on docs and blocks
  (`created_commit`/`deleted_commit` gone; every `deleted_commit IS NULL`
  filter reads `deleted_at IS NULL`), `resurrection_pool.created_at`; §5.4
  restated as the core's steps plus a capture step 15; §5.6 keeps the head
  and mints none; a `docs_move` mints a head and is captured as a revision
  of the unchanged tree at the new path (`revisions.path` immutable — the
  fidelity note: a 16.x move rewrote the current revision's path in place,
  so a document moved before 17.0 keeps every older revision at the old
  path and the then-current one at the new); §6.1 reconstructs from the
  rows; §5.7 renders from current state; §7 the core has no byte GC; §8 is
  C1–C7 + H1/H3 (I3 restated as agreement). Migration 17 rebuilds the three
  tables from the 16.x history (§3.4). What moved in the fixtures: every
  observation case's `docs`/`blocks`/`resurrection_pool` rows gained the
  columns and lost the renamed ones (no id, hash, order or outcome moved —
  the head is minted at the recorder's old mint point); `spec/mutate` and
  `spec/surface` cases with a `docs_move` gained the moved document's
  revision (and its Receipt entry; the older revision keeps its path);
  `spec/cli` `doctor` renders `head present` / `capture complete`. New:
  `migrations::v16-to-v17-heads-inline-bytes-time`; `v1-to-v16-minimal`
  continues to `v1-to-v17-minimal`; the refusal pins `v18`/`v17`. The Rust
  twin follows in its own round (a store major ships both engines together;
  until then a 17.0 database is unreadable by the published Rust binary).
- **Changed (17.0, slice 3b) — identity claims.** `id_claims` (§2.1, §3.1)
  replaces the `blocks ∪ block_changes ∪ resurrection_pool` probe and the
  squash's earliest-row rule (M3, D5): a claim is written by the core with
  the row that carries the id, held by the recorder's capture (bit 1),
  probed with one statement, released per holder — the core's by the
  claims prune under `identity.claims_retain_days` (§7.3, default never),
  the recorder's by `history purge` — and deleted only at `holders = 0`.
  `resurrection_pool.deleted_commit` → `deleted_at`, `expires_ts` anchored
  on it (C6 = I6 restated). The squash deletes every `block_changes` row
  of a wholly archived commit (§7.1 step 2) and the rebuild re-derives the
  whole table (§7); I7's "every live block has a row" is qualified by H6.
  Migration 17 extended in place (the pool rebuild, the claims backfill —
  §3.4; 17.0 is unreleased, so no step 18). The size report gains the
  top-level `id_claims` count (§7.2). Three decisions taken in the
  implementation: **the claim is the writer's, not the minter's** — `mintId`
  has no store or transaction in hand, so the row-writing site writes the
  claim after the minter yielded, which keeps every fixture id and the
  §5.4 mint order; **`repo_id` is nullable** — a `src` is attached to
  repositories through `attachments` and belongs to none, and the contracts'
  `NOT NULL` would have had nothing to put there (the prune judges a NULL
  claim by the workspace setting); **`c` and `s` are not claimed** — the
  recorder mints them and its rows are its evidence, and `c` leaves the core
  with the feed (3d). What moved in the fixtures: every observation case
  gained an `id_claims` projection (`holders = 3` throughout — legacy capture
  is on), the pool rows' `deleted_commit` became `deleted_at`, the retention
  cases lost the archived commits' earliest `block_changes` rows and their
  `squashed.block_changes` counts rose by them, every `gc` outcome gained
  `claims_released: 0`; `migrations::v16-to-v17-heads-inline-bytes-time`
  projects the claims and the pool's `deleted_at`; `claims.json` is new.
  `spec/mutate`/`spec/sync` pool rows, `spec/surface`/`spec/cli` squash
  counts and `spec/cli`'s `doctor --size`/`gc --json` regenerated. Measured
  (`docs/modular-core/baseline.md` §2): the claims table and its index cost
  about 130 B per id ever minted (row, primary key and the `(repo_id, prefix, minted_at)` index together — the index, half of it, dropped on 2026-10-26: see the release-prep decision above). The Rust twin follows in its own round.
- **Retired (17.0) — `created_commit` is "last written by".** The column is
  gone; `created_at` is the identity's birth (carried) and `updated_at` the
  block's own last change (§3.1, §5.4 step 9) — the meanings a reader
  wanted and the write stamp never gave (`identity::created-commit-is-last-written`
  now shows the carried `created_at`).
- **Changed (16.0) — a node may be a delta over the previous revision.**
  `tree_nodes.entries` is a `[`-form list or a `{"d":…}` delta, a
  `frontmatter_blob` a raw or a `{"f":…}` delta (§4.1 "Delta nodes"); a
  revision is a checkpoint by cadence, no live base, or per list when the
  delta is not smaller (§4.4); readers resolve by walking back (§6); the
  mark is explicit and the squash re-checkpoints a kept dependent (§7, §7.1
  step 0); I2/I3/I5 are restated and I10 added (§8). No DDL; the migration
  step is empty (§3.4). What moved in the fixtures: every multi-revision
  case's later `root_tree` (and some `frontmatter_blob`) hashes, since the
  rows they name are now deltas — in `spec/store`, `spec/sync`
  (`checkpoint.json` projects `tree_nodes`) and `spec/mutate` (every case
  projects `revisions`); `retention.json`'s `squashed` gained
  `checkpointed`; the two `spec/surface` `reads` cases with an export gained
  it too and sweep one more blob and node (the dependent's old delta forms).
  New: `delta.json` (5 cases: the five measurement scenarios minus the YAML
  one, which the Markdown-only fixture contract cannot carry — it is a
  reference test, `core/store/delta.test.ts`), `migrations::v15-to-v16-is-lazy`.
- **Changed (15.0) — history can be archived.** `revisions.root_tree` and
  `frontmatter_blob` are nullable, `revisions.archive` and the `archives`
  table exist, and §7.1 says how a revision's bodies move to a segment and
  back into reach. Three things the code decided while the design was being
  implemented, each a refinement of the brief: the first revision of a
  document is *not* in the never-prunable set — the oracle reads
  `block_changes`, so the squash keeps each block's earliest row instead
  (§2.1, §7.1), which protects every minted id and not only the first
  revision's; `archives` carries `repo_id` (a workspace holds several
  repositories, so `history list` must scope) and the chain pointer
  `history.last_segment` lives in the repository's own settings for the
  same reason; a wholly archived commit's `block_changes` keep the earliest
  rows, so I7/I8 are restated over the commits that are not wholly archived
  and I9 pins the rest. Fixtures: `retention.json` (12 cases),
  `migrations::v14-to-v15-revisions-nullable-and-archives`, every
  observation case's `revisions` rows gained `archive: null` and its
  projection `archives: []`.
- **Changed (14.2) — `same` dispositions are not persisted.** Through 14.1
  both engines wrote one `dispositions` row and one `block_changes` row for
  every verdict of every commit, `same` included — and the api path stamped
  every carried block `edited` even when the changeset never touched it. So
  a block's `updated_at` (`MAX(commits.ts)` over its `block_changes`) was
  the document's, and `blocks_history` listed every commit to the document.
  §5.4 step 10 now drops `same`, the known-id resolver classifies carries
  as the matcher does, and §7's default sweep removes a 14.1 store's rows.
  What is lost: `blocks_history` can no longer say "present and unchanged
  in commit X" — derivable on demand by diffing two trees, as `docs_diff`
  does. The observe outcome still counts `same` (it reports the matcher).
  Fixtures: every observation case's `dispositions`/`block_changes` lost
  exactly its `same` rows and nothing else; `identity::edit-one-of-three-
  writes-one-row`, `::move-only-change-writes-moved-rows` and
  `garbage::sweep-removes-pre-14.2-same-rows` pin the new rule.
- **Fixed (13.6) — two observe-path writes sat outside their transaction.**
  §5.4 step 14's `conflicted` flag was an autocommit after the member's
  transaction in both engines, and §5.6's observed tombstone was bare
  autocommit statements in the reference (the port had it in one
  transaction). A crash between them left a committed revision with a stale
  flag, or a pooled doc still live. Both now run inside the transaction they
  belong to; no projection changes (the fixtures are unchanged), so this is a
  procedure minor.
- **Fixed (13.5) — a random block id collided at 360,338 blocks.** The
  reference's `mintId` and the port's `RandomMinter` drew 7 Crockford
  characters and trusted the primary key; the first ingest of a synthetic
  3,000-document corpus (about 120 blocks each) failed with `UNIQUE
  constraint failed: blocks.block_id` after 149 s, exactly where the
  birthday bound predicts (§2.1). Neither engine retried. The store now
  redraws an id in use (§2.1); the fixture device `"minter": "repeat"` pins
  it (§9.4). Lengthening ids would have been a major (the id shape is
  pinned) and would not have removed the need to check.
- **Fixed — a re-created path stayed tombstoned.** `ingestFile` reused the
  tombstoned `docs` row for a path (identity kept, correctly) but never
  cleared `deleted_commit`, so a file deleted and re-created on disk was
  live in `blocks` and invisible to every read that filters
  `deleted_commit IS NULL`, and never echo-gated (each observation
  re-ingested). §5.6 "Re-creation" is the rule; `deletion::recreate-revives-doc-row`
  pins it. (The existing `checkpoint.test.ts` recreate test checked the
  block ids only.)
- **Pinned (through 16.x) — `created_commit` was "last written by".** Every
  `blocks` row was rewritten by every commit to its document, and all of
  them carried the committing commit as `created_commit`; retired in 17.0
  (above).
- **Pinned — `blocks.attrs` is not canonical JSON.** The reference writes
  the attrs object in insertion order; the tree entries (§4.1) canonicalize.
  Compared as JSON; the Rust crate writes sorted keys.
- **Pinned — an unknown block `type` gets whitespace-only text.** Recomputing
  `text` for a stored row of a kind outside `spec/format` §3 (a YAML/JSON
  adapter's kinds) applies only the whitespace normalization, no kind
  syntax; unreachable with Markdown fixtures.
- **Pinned — `rendered_hash` is `sha256(source)`.** It is not computed from a
  render; the convergence check (§5.4 step 13) separately verifies that the
  render and the reconstruction reproduce `source`, so the three are equal
  whenever `converged` is true.
- **Pinned — doc-level trivia is not versioned.** `leading_trivia` and
  `frontmatter_trivia` live on the `docs` row only, so a read at an older
  revision (§6.2) can differ from that revision's bytes exactly there.
- **Pinned — `dispositions` uses `INSERT OR IGNORE`.** A second disposition
  with the same `(commit, block, kind)` is dropped silently. The matcher
  never produces one.
- **Pinned — observe writes no `checkpoint_id`.** The reference's checkpoint
  layer records `checkpoints` rows separately and does not link commits to
  them.
- **Pinned — minted ids are not collision-checked.** `docs/data-model.md`
  said "mint with retry on unique-constraint violation"; the reference
  relies on the primary keys and a 32⁷ space (the doc now says so).
- **Pinned — mint order surprises.** Lineage fragments (`split_from`,
  `merged_into`, `copied_from`) mint before `inserted` blocks even when the
  inserted block precedes them in the document
  (`identity::split-lineage-mints-before-inserted`); a cross-document move's
  replaced minted id is simply skipped, the counter never rolls back
  (`batch::new-path-destination`).
- **Pinned — a tombstone leaves the doc's `sections` rows.** §5.6 does not
  delete them and `rebuild_index` iterates live docs only, so a tombstoned
  document keeps stale section rows although §4.6 defines sections over
  live blocks (`deletion::gone-path-tombstones-and-pools`). Harmless — every
  consumer joins live blocks — and kept as built; I8 checks live docs only.
- **Observed — the old tree is loaded `ORDER BY parent_block, ordinal`.**
  That is neither document order nor pre-order (top-level rows, whose
  `parent_block` is `NULL`, sort first; then by parent id bytewise). The
  matcher's document-order tie-breaks among *same-parent* blocks are
  unaffected, but its cross-parent document-order walks (phases 4b, 5 and
  6a visit "unmatched old blocks in document order") see this order. Pinned
  as built; a port must load the same order. Recorded for a possible future
  matcher-minor that specifies pre-order.

## Decisions

- 2026-10-26, store 17.4 (Phase 5a-ii of `docs/modular-core/`): **legacy
  bytes are named, not spent a column on; the sweep repairs them.** A
  procedure minor — no DDL change. Decided in the implementation (§10
  "Changed (17.4)"): the fidelity check `sha256(reconstruct) == file_hash`
  runs in full at the 16 → 17 entry point and behind the cheap signature of
  legacy rows at the on-open one (the alternative — a per-document flag
  column — was a store major for a transient condition, and a full check
  on every open an O(bytes) cost forever); the `legacy_bytes` alert carries
  the count and the first 20 ids, and `doctor` and the active-alert sweep
  re-derive the set in full; the repair is positional and separator-only
  (the matcher would match identical texts to the same ids anyway, and
  running it would be a re-ingest in disguise), mints nothing and leaves
  the recorder's capture alone — a repaired head's capture is the 16.x
  capture until the next commit (legacy fidelity, pinned by C9's reading
  of H1/H3). The 16 → 17 step also rebuilds the FTS index once, and the
  tombstone finish step purges the index entries it holds before deleting
  the rows (the rule the 17.3 twin must correct to).
- 2026-10-26, store 17.3 (Phase 5a of `docs/modular-core/`): **D2 step two,
  the four compositions, fault injection.** A procedure minor — no DDL change.
  Decided in the implementation: a tombstone DELETES the document's `blocks`
  rows in both tombstone paths (D2 B's second step — the recorder already
  holds the head's last captured revision, the pool and the claims carry
  revival and identity; no new recorder seam), and a 17.0–17.2 database's
  tombstoned rows leave on open as a finish step of the unreleased 17.x line
  rather than as a `gc` count (which would have moved every `gc` fixture and
  the CLI's `gc` line for a legacy sweep); `OMGBASE_CAPABILITIES` names the
  plan's four compositions and every runner carries per-composition rules
  with one ledger line (§9.6) so `pnpm conformance` is one matrix;
  `OMGBASE_FAULT` names five sites both engines spell alike (§9.7). Phase 5b
  inherits the migration of real repositories through
  `scripts/qualify/migrate-copy.mjs` (`docs/modular-core/migration-runbook.md`).
- 2026-10-26, store 17.2 (Phase 4b of `docs/modular-core/`): **`history
  purge`, `embed enable|disable`, `feed_capped`.** A procedure minor — no
  DDL change. Decided in the implementation (§10 "Changed (17.2)"): a purge
  does not rewrite coverage (it is the record capture rests on; `pruned`
  needs it), protects a live head's revision only while capture is on,
  re-anchors open edge intervals at the earliest retained commit, keeps the
  recorder's hold on the live set while capture is on, and drops the
  bundle's tables automatically when nothing is left and no repository is
  enabled (no `--drop-tables` flag: the condition is checkable and the
  outcome reported); the semantic row follows a provider CHANGE rather than
  every settings write, so `embed disable` is sticky; "disabled with a
  provider" is the one new refusal and the no-provider case keeps
  `provider_unavailable`; the feed-cap advice is read from the alert. The
  `capability_unavailable` envelope does not gain `repo` (the contracts' §2.1
  sketched it): adding it would move every pinned semantic
  `capability_unavailable` fixture for a key the client already knows (it
  named the repository). Phase 5 inherits D2 step two's write side (the
  core still writes a tombstoned document's `blocks` rows) and the migration
  of real repositories.
- 2026-10-26, store 17.1 (Phase 4a of `docs/modular-core/`): **capture is
  optional.** A procedure minor — no DDL changes; which bundles a database
  holds and when a commit writes a history row do. The decisions were
  Brendan's (resolution 17: `writer_requires` defaults to required;
  resolution 18: a failed capture rolls the member back, retried forever,
  surfaced through `capture_failed`); decided in the implementation: the
  history bundle's DDL follows the manifest while the semantic bundle's
  follows the composition (its reads probe the tables unguarded — §3.1 says
  why); `OMGBASE_CAPABILITIES=core` is a test-only override and a repository
  it creates starts disabled; the baseline of §1.14 is written on `enable`
  (§10 says why it was kept); the refusal runs outside the member
  transaction so its alert survives. Phase 4b inherits `history purge`, the
  `outside_coverage`/`pruned` read states, `embed enable|disable`, the
  feed-cap alert and `docs_history`'s `retained` flag (resolution 11).
- 2026-10-25, store 17.0 (Phase 3a of `docs/modular-core/`): **the current
  state is self-contained.** The decisions were Brendan's (`docs/modular-core/
  README.md` §4: D1 the head token is the `r_` id minted by the core; D6
  `created_at` is the identity's birth and `updated_at` the entity's own
  last change; D10 bytes inline on the rows, `blobs` entirely the
  recorder's; D11 a move is a transition, a delete is not; resolution 15
  `current_rev` renamed `head`), and the contracts
  (`phase-1-contracts.md` §1.7, §1.11, §1.12, §1.15, §1.16) are the text
  §3–§8 follow. Three things decided in the implementation: **the head is
  minted where the revision id was** (so no fixture id moves and the
  per-prefix mint order of §5.4 holds — the recorder receives the token
  rather than returning one); **a self-linking moved document gets one
  revision, not two** (its retarget's `ingest_known` mints the head and
  carries the new path; a bare `move_path` mints it); and **the migration
  resolves each live head's frontmatter through the recorder's own read**
  (`frontmatterAtRevision`) rather than importing the delta module into the
  store, keeping the dependency direction the Phase 1 gate pinned. What
  this slice does not do, by design (the later slices of Phase 3): the id
  claims and the pool's `deleted_at` (3b), the self-contained pending row
  (3c), the feed and `commits`' retirement from the core (3d), open-only
  edges, the manifest, the alert channel and the dropped objects (3e) —
  and the capture is still unconditional. Measured (`docs/modular-core/
  baseline.md` §2): with legacy capture on the head's bytes exist twice, so
  the import grows by the live content's inline bytes and nothing else
  changes shape.
- 2026-10-25, store 17.0 slice 3b (Phase 3b of `docs/modular-core/`):
  **identity claims are a table, released per holder.** D5 as decided
  (`README.md` §4) with the contracts (`phase-1-contracts.md` §1.2, §1.7,
  §1.13 §7.2, §1.15 C5/H6, §1.16 step 10) as the text §2.1, §3.1, §7.3 and
  §8 follow; the prune's knob and its rule — `identity.claims_retain_days`,
  a pruned claim must name no core row — are the contracts' resolution 10.
  Decided in the implementation (§10 "Changed (17.0, slice 3b)"): the claim
  is written by the row's writer, `repo_id` is nullable, `c`/`s` are not
  claimed. Not done here, by design: the six size categories with
  `identity` as one (3e — `id_claims` is filed under `history` meanwhile),
  `history purge` and the recorder's release (3e), the manifest that would
  let a repository run without a recorder (3e) — until then every claim in
  every fixture carries both bits.
- 2026-10-25, store 17.0 slice 3d (Phase 3d of `docs/modular-core/`):
  **the feed is catch-up, a rescan is recovery, the log is history.** D7/M5
  and D4 as decided (`README.md` §4) with the contracts
  (`phase-1-contracts.md` §1.4, §1.6, §1.7, §1.11, §1.13 §7.1, §1.15, §1.16
  step 8, §2.4, §4.1–§4.5, §7 resolutions 3, 5, 6, 7, 12) as the text §2.1,
  §3.1, §3.4, §5.4, §5.6, §7.4, §8 and §9.4 follow — the slim `feed` row
  plus one entry per touched document, the integer cursor with a sibling
  `epoch`, `batch_id` the first committing member's commit id, the status
  row on `sync_state`, `plan_id` on the feed row, the backfill "what the
  rows say". Decided in the implementation: see §10 "Changed (17.0, slice
  3d)". One thing the contracts' §2.4 left open, this slice implemented as
  written — `cursor = 0` always valid, the rule `0 < cursor < oldest − 1`
  excluding zero by construction, a consumer with no stored cursor served
  from `oldest` and left to read `oldest > 1` for the gap — and flagged as a
  product question; **Brendan decided it on 2026-10-26** (the release-prep
  entry above): cursor 0 is not special, the condition is `cursor < oldest −
  1` for every cursor, and a first-time consumer of a pruned feed rescans.
  Not done here, by design: the six size categories and the
  size report's `feed` line, the three-file split, the epoch re-mint paths
  (3e).
- 2026-10-26, store 17.0 release prep (Brendan's two decisions for the
  release; both engines in one round, fixture first): **(a) cursor 0 on a
  pruned feed is expired.** `changes_since` (`spec/surface` §3) fails
  `expired_cursor { epoch, oldest, head }` when the given epoch is not the
  repository's, or `cursor > head`, or **`cursor < oldest − 1` — for every
  cursor, 0 included**. Through the slices the third condition was `0 <
  cursor < oldest − 1`, so cursor 0 was always valid and a consumer with no
  stored cursor on a pruned feed was silently served from `oldest` — and
  never saw the deletions the pruned rows carried. Now an empty feed
  (`oldest = 0, head = 0`) still serves cursor 0, a feed that begins at 1
  serves it, and a feed pruned to `oldest ≥ 2` expires it: the first-time
  consumer bootstraps by the `spec/sync` §6 rescan, like any consumer whose
  cursor fell behind the retention floor. Reason: "a first-time consumer
  must not silently miss deletions" — the feed is catch-up, a rescan is
  recovery (3d), and a bootstrap from nothing is recovery. Consequences:
  the CLI's `log --since <instant before the oldest row>` resolves to
  `oldest − 1` ("everything the feed holds") instead of 0; the semantic
  drain's watermark follows the same rule (a watermark of 0 on a pruned
  feed rescans); the `changes_since` tool description says so. Fixtures:
  `reads::changes-since-epoch-and-expiry`'s `{}` after the gc moved from
  the two-digest page with `oldest: 3` to the envelope (`cursor 0 of epoch
  ep_0 has expired — the feed now begins at (ep_0, 3); rescan the
  repository and resume from head 4`); `protocol::sync-out-cursor-0-on-a-
  pruned-feed-rescans` is new (the coordinator's `sync_out {}` over a feed
  pruned to its head row rescans and removes the document whose deletion
  the pruned rows carried; the `engine { gc }` step is new with it). **(b)
  `idx_claims_repo_prefix` is dropped.** The `id_claims` table and its
  primary key stay; the secondary index `(repo_id, prefix, minted_at)` of
  slices 3b–3e-ii goes from `schema.sql` (§3.1), and migration 17 runs
  `DROP INDEX IF EXISTS idx_claims_repo_prefix` at both entry points (§3.4
  step 17 (4) — a 3b–3e-ii database at 17 loses it on open). Reason:
  measured in `docs/modular-core/baseline.md` §2, about half of the ≈ 130 B
  every minted id costs was this index; its two readers — the claims prune
  (§7.3) and the size line (§7.2) — are gc-time and on-demand work and both
  scan; the mint probe is the primary key's. Re-adding an index later is
  additive (a `CREATE INDEX` in a step, no table rebuild). Fixtures:
  `schema::fresh` loses the index entry; `spec/cli`'s five size reports
  (`doctor-size`, `doctor-size-json`, `doctor-size-jsonl`,
  `doctor-size-after-rm`, `gc-vacuum`) lose the index's `sqlite_schema` row
  (96 → 95, the `sync` category's row total with it — the bytes are masked
  there). No migration case projects the index. Both decisions are pinned
  byte for byte in both engines.
- 2026-10-25, store 17.0 slice 3e-ii (Phase 3e-ii of `docs/modular-core/`,
  the last Phase 3 slice): **the manifest says what is on; the channel says
  what needs a human.** The contracts (`phase-1-contracts.md` §1.5 the
  manifest, §1.14 the lifecycle it will carry, §1.16 step 11 the migration
  rows, §2.3 `version`, §2.7 `doctor`, §7 resolutions 1 — semantic
  `enabled` iff a provider is configured — 17 — `writer_requires` defaults
  to required — 18 — retry forever, surface loudly — and "+" the alert
  channel) are the text §3.1, §3.4 step (13)–(14), §5.8, §7.2, §8 A1, §9.1,
  §9.3, §9.5 follow. Where they were silent the implementation decided —
  see §10 "Changed (17.0, slice 3e-ii)". The Rust twin follows in its own
  round; these fixtures are its contract.
- 2026-10-25, store 17.0 slice 3e-i (Phase 3e-i of `docs/modular-core/`):
  **the current state asserts; the recorder remembers.** M6, D8 and D9 as
  decided (`README.md` §3–§4) with the contracts (`phase-1-contracts.md`
  §1.4, §1.7–§1.9 the three DDL files, §1.11 step 15's edge half, §1.13
  §7.4–§7.5, §1.15, §1.16, §2.7, §5, §7 resolutions 8 and 9) as the text
  §3.1, §3.3, §3.4, §5.4, §7.2, §7.5, §8, §9.4 and §9.5 follow. Where the
  landed DDL of slices 3a–3d and the contracts' verbatim files differed, the
  landed DDL won: `id_claims.repo_id` nullable (3b), `feed.plan_id` (3d), the
  DDL comments, `sync_state`'s column comments, the `repos` ADR-014 note,
  and `pending_materializations`' column order — the contracts' tables and
  columns are otherwise the files'. Decided in the implementation: see §10
  "Changed (17.0, slice 3e-i)". The Rust twin follows in its own round.
- 2026-10-25, store 17.0 slice 3c (Phase 3c of `docs/modular-core/`):
  **the recovery payload is the row.** M4 as planned (`README.md` §2.11,
  §3) with the contracts (`phase-1-contracts.md` §1.7 the DDL, §1.11 §5.7,
  §1.15 C10 — numbered C8 here, after C7 — §1.16 step 7, §3.4) as the text
  §3.1, §3.4, §5.4, §5.7 and §8 follow. Decided in the implementation:
  **`prior_hash` is inherited, not recomputed** — a superseding write keeps
  the earliest prior because the superseded target never reached the disk
  (a row that survives the replay holds foreign bytes), and a write over a
  `remove` inherits the bytes the remove owed an unlink; **a rename carries
  the obligation at `from_path` and deletes that row** rather than leaving
  two rows for one file; **the gate rule does not consult `prior_hash`**
  (the 14.0 reasoning holds: from the disk alone a crash-stale file and a
  human revert are the same bytes, so the observation must treat them the
  same, and the materializer stays the recovery point); **the projection
  carries `created_at`** although the contracts' §3.4 omits it (it is
  pinned by the commit's `ts` and lets the Rust twin's value be checked);
  **recovery drops a kept row with the heal** (the §5.7 "file wins" rule
  applied to the one materializer that also ingests). Not done here, by
  design: `repos_status.unconverged` keeps its `revisions` join until D9
  retires it (3e); `pending_materializations` stays filed under `history`
  in the size report until the six categories (3e). Measured
  (`docs/modular-core/baseline.md` §2): no change — pending rows are
  transient and the two new columns live only between a commit and its
  file write.

- 2026-10-17, store 16.0: **delta tree nodes** (§4.1, §4.4, §6, §7). The
  math that decided it, from the per-key-parts branch `2f7b286` (built,
  measured, not merged): a Merkle list of hash references costs about 77 B
  per part per revision (64 hex + JSON), so decomposing a six-key
  frontmatter into parts wrote ~630 B of node per one-key edit against the
  ~100 B monolithic blob it replaced — parts pay only when the mean part is
  longer than ~80 B. The same arithmetic already governs the body: the root
  node costs ~170 B per top-level block per revision, so a 40-block journal
  rewrites ~6.8 KB of root per logline and a six-key YAML file (one block
  per entry) ~740 B per edit. **One mechanism fixes all three**: store a
  list as a delta over the same list one revision earlier, and let the
  frontmatter be a list of lines so it rides the same encoding. The
  measurement (the reference's `core/store/delta.test.ts`, `delta::*`
  fixtures; bytes of new `blobs` + `tree_nodes` rows per revision, revision
  1 identical under both and excluded; "15.x" is the same writer with every
  revision a checkpoint):

  | scenario | 15.x per revision | 16.0 per revision | of which nodes |
  | --- | --- | --- | --- |
  | (a) six-key frontmatter, one-key edit | 99–103 B (the whole raw) | 44–63 B (one `{"f":…}` blob, no node) | 0 |
  | (a′) the same with blob references instead of inlined lines | — | 107–126 B (ops with 64-hex refs + the line as a blob) — **not chosen** | 0 |
  | (b) 40-block journal, one logline appended to its list | 6.9–7.3 KB nodes (+ ~115 B blobs) | 379 B nodes (257 root `=39,~list` + 122 list `=n,+item`; the same blobs) | 379 B |
  | (c) six-key YAML file, one-key edit | 738–739 B root | 145–154 B root (`=k,~entry,=m`) | all |
  | (d) ten-paragraph document, 20 one-paragraph edits (21 revisions) | 21 × 1.79 KB ≈ 37.6 KB nodes | 2 × 1.8 KB checkpoints (seq 1, 17) + 19 × 185–192 B ≈ 7.2 KB nodes | all |
  | (e) squash of a live delta's base | — | the kept dependent re-checkpointed (`checkpointed: 1`); every revision reconstructs, archived through the segment and live by resolution; gc 0 afterwards | — |

  Reconstruct through the chain: 0.5–0.9 ms at seq 16 (fifteen deltas back
  to the checkpoint), 0.35–0.5 ms at the checkpoint itself, on the ten-
  paragraph document (point reads by primary key; the hot `docs_read` path
  reads `blocks` and resolves only the frontmatter). Decisions taken, each
  a refinement of the brief: **implicit base** (the row's `(doc_id, seq −
  1)`) rather than a stored base hash, because the hash would cost 70 B per
  node per revision — the exact figure the round set out to remove — and
  the revision row already pins the context; the price is that a `{`-node
  means nothing outside its revision, hence the **reuse-only-self-contained
  rule** (a `[`-node with a `{`-descendant is not context-free either; the
  identity delta `{"d":[["=",n]]}` is one shared row and costs ~17 B once).
  **Myers over item texts**, not a prefix/suffix scheme or a per-key `set`/
  `unset` vocabulary: both engines already share the Myers tie rule byte
  for byte through `docs_diff_unified`, the script is minimal for scattered
  edits where prefix/suffix degrades to a full rewrite, and positional ops
  express what a key vocabulary cannot (a reordered or duplicated key, a
  comment or fence change, a CRLF conversion) with no fallback — the
  planner's per-entry edit (`spec/mutate` §11.10) lands as one `~`/`+`/`-`
  per changed line. **Lines, not §11.10 parts**, as the frontmatter's
  items: the store needs no YAML-shaped rule and no dependency on
  `spec/mutate`; a multi-line entry costs one op per changed line, a few
  bytes more than one op per entry. **Inlined lines, not blob references**,
  per (a′): a reference costs 68 B against lines of 11–30 B, and a changed
  line is new (nothing to share). **A frontmatter delta is a `blobs` row**,
  not a `tree_nodes` row: `frontmatter_blob` keeps its name and I2 its
  "in `blobs`" clause, the discriminator is the first byte either way (a
  raw always begins `---`), and the GC mark is unchanged for the column.
  **Checkpoints every 16** (§4.4) as the brief proposed; the reconstruct
  cost says the bound could be looser, the amortized full node per revision
  (6.8 KB / 16 ≈ 420 B on the journal) says it should not be much tighter,
  and the squash's re-checkpointing is bounded by the same N. **Re-
  checkpoint on squash**, not "never archive a base": the alternative makes
  the policy's output depend on the encoding and would pin every kept
  representative's predecessor; re-writing the dependent costs one full tree
  per archived run and the `delta::squash-rechecks-the-dependent` fixture
  proves every revision still reconstructs. **Segments hold checkpoint
  forms**, so `archive.sql` is untouched and a reader of a segment never
  walks back into the store or another file. **The lazy migration** is
  correct here and was not in `2f7b286` because the old encoding *is* the
  new checkpoint encoding — a 15.x database is a 16.0 database whose every
  revision is a checkpoint, so nothing is rewritten and deltas begin with
  the next commit; the major exists only to keep a 15.x reader out (§1 step
  3 — a 15.x engine would `JSON.parse` an object where it expects an array
  and read garbage). What the design does **not** fix: the per-revision
  `revisions`/`commits`/`block_changes` rows (~200–300 B) and the property
  row churn, which are now the floor a one-key edit costs; the attn hotspot
  (a timestamp key rewritten every minute) goes from ~400 B to ~250 B per
  write — the body deltas, where whole roots were rewritten, are where the
  tens-of-× savings are. **Recommendation**: ship as designed, both engines
  together (a store major), with the Rust twin reading and writing the same
  forms before the TypeScript half is released — until then a 16.0
  database is unreadable by the published Rust binary.
- 2026-10-15, store 15.0: history retention — `omg history export --prune`,
  archive segments, `attach` (§7.1). The measurement: a 131 MB database
  over 5 MB of Markdown held 57 MB of history — tree nodes with no sharing
  across revisions (a whole root per revision), uncompressed blobs — that
  nobody reads but nobody may lose. Five decisions. **Squash, not delete**:
  an archived revision keeps its `revisions` row (and its commit) and loses
  only its bodies, so the `revisions` target, `docs_history` and
  `changes_since` keep listing it, I4's dense `revisions.seq` stays dense
  (nothing is deleted anywhere, so the invariant did not have to relax to
  "strictly increasing"), and the one visible seam is a read of the bytes,
  which either goes through the segment or says `revision_archived`.
  **Segments, not an appended archive**: one new file per run is complete
  the moment it is renamed into place, needs no locking against a reader,
  can be copied, compressed and shipped as a unit, and makes the crash rule
  a file-system fact — a complete file whose id no `archives` row carries
  is unfinished work, and the next run finishes it (a run without `--prune`
  leaves exactly that state on purpose, so the rule has a fixture). **The
  manifest carries the commit range** (`seq_lo`/`seq_hi`) so `history list`
  and a reader of a bare file can place a segment in the feed without
  opening the store or re-deriving it from the rows; the ranges of
  successive segments usually tile (an age-driven policy archives older
  commits first) but are not a partition — a policy change can archive a
  revision an earlier run kept — so the chain (`previous_segment`) is the
  order and the range is the span. **Compression is at rest**: SQLite's
  page format compresses well with `zstd` and the user keeps the knob; an
  engine that decompressed on attach would own a cache and a format
  question this round does not need, so a compressed segment is simply not
  attachable yet. **The attn tension**: a pointer document (one whose body
  is mostly links) has a history that is mostly small revisions, and the
  per-document ladder archives it as readily as any other; reconstructing
  its past then needs its segments attached — the `/attn/focus.md`
  override in the example policy (`keep_days 7, per_doc_max 50`) is the
  knob for a document whose recent history is read often, and
  `keep_origins` keeps every reasoned `api` revision hot regardless. DDL:
  a major; both engines ship together, and §1 step 3 keeps a 14.x engine
  out of a 15.0 database.
- 2026-10-13, store 14.2: `same` dispositions are not persisted (§5.4 step
  10), the api path classifies carries as the matcher does, and the default
  gc sweep removes a 14.1 store's `same` rows (§7). The measurement: on a
  real repository the matcher wrote about 18.5 disposition rows per
  revision, nine in ten of them `same` — 11 MB of `dispositions` and an
  estimated 5–7 MB of `block_changes` that nothing read afterwards, since
  every reader (`updated_at`, `blocks_history`, the change-feed summary,
  which already filtered `same`) asks what changed. The meaning chosen: a
  block's `updated_at` is the block's own last change — inserted, edited,
  moved, split/merge lineage, resurrection — not its siblings'; a block is
  updated only when it is updated, and a one-paragraph `plan`/`execute`
  edit moves one timestamp (through 14.1 the api path stamped every carried
  block `edited`, so it moved them all). `blocks_history` lists the commits
  that changed the block. What is lost: the table can no longer say "present
  and unchanged in commit X" — derivable on demand by diffing two trees, as
  `docs_diff` does, and never asked of the rows. The outcome keeps counting
  `same` because it reports the matcher, not the table, and `spec/sync`'s
  summary buckets read it. Shedding a 14.1 database's rows is gc's default
  sweep rather than a migration or a flag: a data-only change would need a
  `user_version` bump (a store major) for nothing, opening a database must
  never bulk-delete (writer lock, WAL growth, startup time on a 130 MB
  file), gc already has the fixture device in both engines and runs on the
  user's schedule, and `gc --vacuum` (14.1) is what returns the pages. The
  size report gains `same_dispositions` and an advice line past 25 % of the
  table so `omg doctor --size` says when the sweep is worth running. No
  DDL: a procedure minor.
- 2026-10-13, store 14.1: the size report and `vacuum` (§7). Measured by
  hand, a 100 MB database over 2 MB of Markdown was history — blobs, tree
  nodes, dispositions, block changes — not embeddings; the report makes
  that answer a store operation both engines compute identically (the
  `dbstat` virtual table, which both bundled SQLite builds enable — checked,
  not assumed; a build without it degrades to row counts and says so) with
  one categorization of every table in `schema.sql`, so `omg doctor --size`
  needs no hand SQL. Indexes count toward their table and FTS5 shadow tables
  fold into their virtual table because a reader asks about `blocks` and
  `blocks_fts`, not `idx_blocks_rawhash` or `blocks_fts_data`; `sqlite_schema`
  and anything unassigned land in `sync` rather than a fifth category, so
  the four names are stable. `VACUUM` becomes a store operation (it was
  nothing before: `gc` sweeps rows, never pages) because the free pages a
  sweep leaves are what the operator wants back. No DDL: a minor.
- 2026-10-12, store 14.0: the api path commits DB-first. The commit
  transaction records each file it owes as a `pending_materializations` row
  (§3.1, migration 14) and the files are materialized after COMMIT from
  `reconstruct at rev_id`, each row deleted as its file lands (§5.7); the
  observe path gains the gate rule for a path with a pending row, the
  freshness sweep and recovery a step 0 that replays the rows (`spec/sync`
  §4.3). `file_hash` is now defined as the hash of the bytes the current
  revision renders to (§5.4 step 12; on the observe path, the observed
  source — unchanged). Last foundation step of the effect planner: without
  it a conflict found inside the transaction had already overwritten a
  file, and a crash after the files were written healed them as `observed`
  commits that lost the api intent. The intent table was chosen over
  inferring "file behind" from the previous revision's hash because that
  inference cannot tell a crash from a human revert (ADR-004) and cannot
  express a pending rename or remove. A DDL change: a major; both engines
  ship together, and §1 step 3 keeps an older engine out of the newer
  database.
- 2026-10-12, store 13.7: the `api` path (`spec/mutate` §4) runs §5.4 for
  every document of a request inside one transaction under one commit row
  (§5.4 "The api path"). No DDL change; a procedure minor. The observe path
  and its fixtures are untouched (a whole-batch mode for `observe_many` is
  deferred). One side effect in both engines: the commit row is minted by the
  caller before the per-document steps, so on every path `c` is now minted
  before step 2's `d` of a new document — unobservable under the per-prefix
  fixture minter (§2.2), which is why no observe fixture moved.
- 2026-10-12, store 13.6: the `conflicted` flag (§5.4 step 14) and the
  observed tombstone (§5.6) run inside their transactions in both engines.
  No DDL change; a procedure minor. First of the transaction-hygiene steps
  that precede the effect planner (the `api` path's single transaction over
  a whole changeset is the next).
- 2026-09-26, store 13.5: a production mint never returns an id in use
  (issued in this process, or present in the prefix's table); the repeating
  fixture minter pins the redraw. No DDL change; a procedure minor.
- 2026-09-26, store 13.4: the store applies `spec/mutate` changesets —
  loading the working tree, the commit protocol with the known-id `api`
  ingest, macros, document operations, the update planner. `api` commits
  are `spec/mutate` §4's; this spec's observe procedure is unchanged.
- 2026-09-26, store 13.3: the store runs `spec/search` — `text_search`, the
  embedding drain over the `embeddings`/`doc_embeddings` caches, vector and
  hybrid search. Nothing new is written in the commit; the caches are filled
  by the drain. No DDL change.
- 2026-09-26, store 13.2: the store writes the `spec/graph` tables in the
  commit (§5.4 step 9c) and adopts phantoms whenever a doc row becomes live.
  No DDL change.
- 2026-09-26, store 13.1: the store writes `spec/properties` rows in the
  commit (§5.4 step 9b). No DDL change; a semantic minor.
- 2026-09-26, store 13.0 specified as built: the schema version is the spec
  major (a database says which spec it conforms to); the crate starts on the
  13.x line for the same reason `omgbase-reconcile` started on 2.x.
- 2026-09-26: the store's language-neutral surface is the DDL plus the
  observe procedure over a block tree — not the TypeScript `Store` API.
  Properties, graph and search stay out of this spec and get their own.
