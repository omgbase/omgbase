# The omgbase store specification

The store is the embedded SQLite database that owns **identity, history and
the current state** of a repository of authored files. Files stay the source
of truth for *content*; the store adds stable block ids, an append-only
history of revisions and commits, the dispositions the matcher recorded, and
the derived indexes the query surfaces read. At quiescence
`sha256(file) == the current revision's rendered hash`. This directory
specifies the database so that more than one engine can open the **same
file** and, given the same sequence of observed changes, write the **same
rows**. It is owned by neither implementation.

| Implementation | Where | Role |
| --- | --- | --- |
| `@omgbase/core` (TypeScript, npm) | `packages/core/src/core/store`, `core/ingest.ts`, `core/hash.ts`, `core/ids.ts`, `core/order-key.ts`, `core/read/document.ts`, `sync/observe.ts`, `sync/reconciling-ingest.ts`, `sync/tombstone.ts`, `mutate/materialize.ts` | **Reference.** Store decisions land here first. |
| `omgbase-store` (Rust, crates.io) | `crates/omgbase-store` | Conformance-first port. Opens the same databases, passes the same fixtures. |

The spec is three artifacts, versioned together by `VERSION`:

- this `README.md` — what the tables mean, the canonical encodings, the
  observe/commit procedure as an exact rule, the invariants, the fixture
  contract;
- `schema.sql` — **the DDL**, verbatim. Both implementations embed this text
  and execute it on a fresh database. It is the one artifact that is already
  language-neutral; nothing may paraphrase it.
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
`PRAGMA user_version` every database carries (`14`), so a reader of a
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
- **Semantic changes** without DDL (a column filled differently, an encoding,
  the observe procedure, the pool expiry) bump the minor.
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
Prefixes: `d` document, `b` block, `c` commit, `r` revision, `x` external
node, `col` collection, `cp` checkpoint, `e` edge, `rp` repo, `v` projection
(reserved), `src` source. Ids are repo-scoped, never reused, never
re-assigned. An id is opaque: nothing may parse anything but its prefix out
of it, and `isValidId` accepts exactly `^[a-z]+_[alphabet]{7}$`.

**Uniqueness at mint (13.5).** 32⁷ ≈ 3.4 × 10¹⁰ is small enough for the
birthday bound to matter: two random draws among *n* collide with
probability about n² / (2 · 32⁷) — 5 % at 60,000 blocks, near-certain at
360,000 (§10: a 3,000-document corpus failed its first ingest on a
duplicate `block_id`). The store therefore never lets a production mint
return an id that is **in use**: one it has already issued in this process,
or one that names a row of the prefix's table — `d` in `docs`, `b` in
`blocks`, `block_changes` or `resurrection_pool` (a block id lives on in
history after its row is gone), `c` in `commits`, `r` in `revisions`, `x`
in `external_nodes`, `e` in `edges`, `cp` in `checkpoints`, `rp` in
`repos`, `src` in `sources` — and redraws until it finds one that is not
(`col` and `v` have no table and no check). A redraw is unobservable
except through the fixture device of §9.4 (`"minter": "repeat"`). The
fixture minter itself (§2.2) is sequential over a fresh database and never
collides; the check runs for it too, at no cost to the ids.

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

Every timestamp column (`commits.ts`, `resurrection_pool.expires_ts`,
`checkpoints.ts`) is RFC 3339 UTC with exactly three fractional digits and a
`Z`: `2026-09-26T14:03:07.250Z` (JavaScript's `Date.toISOString()`). A caller
supplies `ts` for an observation; the store stores it verbatim and derives
`expires_ts = ts + 30 days` (30 × 86 400 000 ms), formatted the same way.
Timestamps compare as strings, so the format is load-bearing. A `ts` not in
this format is a caller error; the reference only notices when it derives
`expires_ts` (a pool write), a port may reject it up front.

## 3. Schema

### 3.1 Durable tables

The tables of `schema.sql` this spec fills:

| Table | One row per | Meaning |
| --- | --- | --- |
| `repos` | repository | `repo_id`, unique `slug`, `settings` JSON (defaults `{}`). A repo owns identity and history, not a filesystem; where its bytes come from is the sync registry's business. |
| `docs` | path ever seen in a repo | `doc_id`; `path` (repo-relative, no leading slash, unique per repo); `format`; `current_rev`; `file_hash` (of the bytes the current revision renders to — §5.4 step 12); `conflicted` (0/1, git conflict markers seen); `leading_trivia` (bytes before the first block); `frontmatter_trivia` (the frontmatter block's trailing trivia, `NULL` when the document has no frontmatter); `deleted_commit` (tombstone, `NULL` = live). A path keeps its `doc_id` across deletion and re-creation (§5.6). |
| `blocks` | live or tombstoned block of the **current** revision | The hot table: `block_id`, `doc_id`, `parent_block` (`NULL` at top level), `order_key` (§4.3), `ordinal`, `depth`, `ancestor_path` (§4.3), `type`, `attrs` JSON, `text` (visible text, `spec/format` §4.1), `raw_hash`, `norm_hash`, `trivia_hash` (`NULL` = no trailing trivia), `created_commit`, `deleted_commit`. Rebuilt wholesale by every commit to the document (§5.4); a tombstoned document keeps its rows with `deleted_commit` set. |
| `blobs` | distinct byte string | Content-addressed: `hash = sha256(bytes)`, `size = |bytes|`. Holds every block `raw`, every non-empty trivia, every frontmatter block. Never deleted in v1. |
| `tree_nodes` | distinct sibling list | Content-addressed Merkle node: `hash = sha256(entries)`, `entries` the canonical serialization §4.1. Identical subtrees share a row. |
| `revisions` | (document, commit) | `rev_id`, `doc_id`, per-document `seq` from 1, `root_tree` (a `tree_nodes.hash`), `frontmatter_blob` (a `blobs.hash` or `NULL`), `rendered_hash`, `path` at this revision, `commit_id`. |
| `commits` | write to the repo | `commit_id`, per-repo `seq` from 1 (the change-feed cursor), `ts`, `origin ∈ {api, observed, import, projection}`, `actor`, `reason`, `checkpoint_id`, `ops`. Observations write `observed` (§5); the mutation kernel writes `api`; `import` is bulk ingest with no retro history; `projection` is reserved. |
| `dispositions` | (commit, block, kind) | The matcher's decisions as persisted: `kind` (the `spec/reconcile` §2 kinds), `confidence`, `reason`, `matcher_v`, `detail` JSON. Immutable once committed (R6). `INSERT OR IGNORE` on the primary key (§10). |
| `resurrection_pool` | block deleted in an earlier commit | `block_id`, `doc_id` it left, `raw_hash`, `norm_hash`, `type`, `deleted_commit`, `expires_ts`. Feeds `spec/reconcile` phase 6b; rows leave when consumed, evicted or swept. |
| `pending_materializations` | file the `api` path still owes the disk (14.0) | `repo_id`, `path` (where the file must end up; one row per path), `kind ∈ {write, rename, remove}`, `from_path` (rename: the old path, else `NULL`), `doc_id`, `rev_id` (the revision whose bytes `write`/`rename` leave at `path`; `NULL` for `remove`), `rendered_hash` (the bytes expected at `path` — for `remove`, the bytes it is safe to unlink), `commit_id` (the `api` commit that recorded it). Inserted by the commit transaction, deleted per file by the materializer once the file is as recorded (§5.7). Empty at quiescence; the observe path never inserts. |
| `external_nodes`, `collections`, `checkpoints`, `properties`, `edges`, `adapters`, `sources`, `attachments`, `sync_state`, `workspace_settings`, `file_stats` | — | Created by `schema.sql`; semantics belong to other specs. `properties`, `edges` and `checkpoints` are written by the reference during the same commit transaction; a runner does not compare them. |

### 3.2 Derived tables

Rebuildable from §3.1 with zero information loss (§7): `sections` (§4.5),
`block_changes` (§5.4 step 10), `doc_edges`, `inferred_edges`, `embeddings`,
`doc_embeddings`, `nodes`, and the FTS5 virtual tables `blocks_fts`,
`nodes_fts`. This spec pins `sections` and `block_changes`; the rest are the
graph and search components'.

### 3.3 `schema.sql`

The exact statements the reference executes on a fresh database (`DDL` in
`schema.ts`, with its sub-DDL constants expanded), followed by nothing:
`user_version` is set by the opener, not by the file. Every statement is
`CREATE … IF NOT EXISTS` so the file is idempotent and can also serve as a
migration target. Both implementations embed the text and test that the
embedded copy equals the file byte for byte (the crate skips that test when
built outside the monorepo, like the other conformance tests). The FTS5
extension must be compiled into the SQLite the engine links (both
`better-sqlite3` and `rusqlite`'s `bundled` feature include it).

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

A database at `user_version` *n* < 14 is upgraded one version at a time, each
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

The "create" steps execute the same sub-DDL text that `schema.sql` contains
for those tables. After the last step the opener sets `user_version = 14`.
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

Writing a tree: for each block in sibling order, put the `raw` blob, put the
trivia blob when trivia is non-empty, write the children's node first when
there are children, then build this node's entry; when every entry is built,
put the node. `INSERT OR IGNORE` on `blobs` and `tree_nodes` gives structural
sharing: an unchanged subtree is the same row. Nested blocks carry `""`
trivia (`spec/format` §1), so `trivia_hash_hex` is `null` below the top level.

### 4.2 Blob bytes

`blobs.bytes` is the UTF-8 encoding of the string (a block `raw`, a trivia,
the frontmatter block's `raw` including its `---` fences). `size` is the byte
length. The reference and any port must agree on UTF-8, so a lone surrogate
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

### 4.4 Block text and attrs

`blocks.text` is the block's visible text per `spec/format` §4.1, computed in
tree context (children compose; nested raws lose up to *q* blockquote
markers), and `norm_hash = sha256(text)`. `blocks.attrs` is the block's attrs
as JSON — compared as JSON, key order not significant (the reference writes
insertion order; a port may write canonical order, §10). `type` is the kind
name.

### 4.5 Sections

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
   `deleted_commit IS NULL`; remember its `file_hash` as `old_hash`.
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
the doc's `blocks` with `deleted_commit IS NULL`, `raw` fetched from `blobs`
by `raw_hash`, children grouped by `parent_block` and sorted by `ordinal` (a
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

1. **Frontmatter blob.** Put the frontmatter block's `raw` as a blob when
   there is one; `frontmatter_blob_hex` is its hash or `null`.
2. **Doc row.** If no `docs` row exists for `(repo, path)`: **mint `d`**,
   insert `(doc_id, repo_id, path, format, leading_trivia =
   tree.leading_trivia, frontmatter_trivia)`; else update `format`,
   `leading_trivia`, `frontmatter_trivia` on the existing row **and set
   `deleted_commit = NULL`** (§5.6 "Re-creation"). `frontmatter_trivia` is
   the frontmatter block's `trivia` when there is one, else `NULL`. `format`
   is the adapter's for the path in the reference (`markdown` for `.md`); a
   port without an adapter registry writes `markdown`, which is all the
   fixtures exercise.
3. **Assign ids** onto the body tree from the reconcile assignment (new key →
   id); every key is assigned, so nothing mints here.
4. **Write the tree** (§4.1) for the body blocks → `root_tree_hex`.
5. **Commit row.** **Mint `c`**; `seq = 1 + max(seq)` over the repo's
   commits (0 when none); insert `(commit_id, repo_id, seq, ts, origin =
   'observed', actor = NULL, reason = NULL, checkpoint_id = NULL, ops =
   NULL)`.
6. **Revision row.** **Mint `r`**; `seq = 1 + max(seq)` over the doc's
   revisions; insert `(rev_id, doc_id, seq, root_tree, frontmatter_blob,
   rendered_hash = sha256(source), path, commit_id)`.
7. **Pool the deleted.** For each id in the result's `deleted`, in order:
   `INSERT OR REPLACE` into `resurrection_pool` the doc's `blocks` row of
   that id (any `deleted_commit`) with `deleted_commit = this commit` and
   `expires_ts = ts + 30 days`. (A row that does not exist inserts nothing.)
8. **Evict foreign rows.** For each id in `cross_doc_ids` then
   `consumed_pool`: delete the `blocks` row with that id whose `doc_id` is
   **not** this doc (its FTS entry first when it was an indexed live leaf,
   `spec/search` §1.1 — decided over the table before any of the batch's
   rows goes, and a live parent the eviction leaves childless is
   re-indexed, since it is a leaf now), and delete the
   id's `resurrection_pool` row. The id is live here now; `block_id` is a
   primary key, and the source document — which commits later in the batch
   or was tombstoned — never lists a carried id as deleted. A live foreign
   row exists only for a cross-document move whose source commits later in
   the batch (`batch::cross-doc-move-b-then-a`); a pooled id never has a
   live row (I6), so a resurrection evicts only tombstoned rows
   (`pool::resurrect-into-another-doc-evicts-tombstoned-row`).
9. **Refresh the blocks.** Delete every `blocks` row of this doc (tombstoned
   included; FTS entries of the live leaves first — `spec/search` §1.1 owns
   which rows are indexed), then insert one row per
   body block in pre-order with `parent_block`, `order_key`, `ordinal`,
   `depth`, `ancestor_path` (§4.3), `type`, `attrs`, `text`, `raw_hash`,
   `norm_hash`, `trivia_hash` (`NULL` when the trivia is empty; nested blocks
   always), `created_commit = this commit`, `deleted_commit = NULL`. Then
   rebuild `sections` (§4.5) and the FTS rows for the doc (live leaves).
10. **Dispositions.** For each disposition of the result: `INSERT OR IGNORE`
    `(commit_id, block_id, kind, confidence, reason, matcher_v, detail as
    JSON)` into `dispositions`, and `INSERT OR IGNORE (block_id, commit_id,
    kind)` into `block_changes`. `detail` keeps the matcher's key spelling
    (`spec/reconcile` §10).
11. **Consume the pool.** Delete the `resurrection_pool` row of every id in
    `consumed_pool`.
12. **Pointers.** `UPDATE docs SET current_rev = rev_id, file_hash =
    sha256(source)` — `file_hash` is the hash of the bytes the current
    revision renders to: on the observe path the observed source; on the
    api path (below) the bytes the engine is materializing, which the file
    holds once §5.7 has run. The echo gate (§5.1 step 3) is unchanged: the
    materialized file hashes to `file_hash` and is an echo.
13. **Converged** = `file_hash == rendered_hash` (trivially) **and**
    `render(tree) == source` (`spec/format` §1 inv. 1) **and**
    `reconstruct(doc) == source` (§6.1, read back from the rows just
    written). Reported in the outcome; a `false` is a bug in one of the
    three, never a normal state.
14. **Conflict flag**, inside the same transaction, with step 12's pointers
    (13.6; 13.5 ran it after the transaction): `UPDATE docs SET conflicted =
    1|0` for the path, 1 iff `source` has a line starting with `<<<<<<<`
    **and** a line starting with `>>>>>>>`. Only an observed member sets the
    flag; an `api` ingest (`spec/mutate` §4) leaves it untouched.

The member's outcome is `{ echo: false, doc, commit, rev, converged,
conflicted, dispositions: kind → count over this commit }`.

**The api path (13.7).** `spec/mutate` §4 step 5(c) runs this procedure for
every document of a changeset inside **one transaction**: step 5 runs once,
before the first document, with `origin = 'api'`, the request's `actor` and
`reason`, `checkpoint_id = NULL`, `ops = NULL`; every document's step 6
names that commit (so N revisions and every `blocks.created_commit`,
`dispositions.commit_id`, `properties.created_commit` and edge
`from_commit`/`to_commit` of the request share one `commit_id`); steps 1–4
and 6–13 run per document in load order with the known-id resolver; step 8
is unchanged (in one transaction the eviction and the pool insert of a
cross-document move run in load order, so only their visibility changes —
`spec/mutate` §10); step 14 never runs. The observe path is unchanged: one
transaction per member, one commit per member (the per-member commit ids
`spec/store` fixtures pin). Mint order on the api path: one `c`, then per
document `r`, `x`, `e`.

**The api path (14.0).** The same transaction records the file half as
intent, after every document's steps and before COMMIT: one
`pending_materializations` row per path the request owes the disk (§3.1) —
`write` for every ingested document (`rev_id` = its new revision,
`rendered_hash` = `sha256(source)`), `rename` for a moved document
(`from_path` = the old path, `path` = the new one, `rev_id` = its current
revision and `rendered_hash` that revision's — or the revision the retarget
gives it when it is a self-linking source), `remove` for a deleted document
(`rev_id = NULL`, `rendered_hash` = its last revision's rendered hash, or
`file_hash` when it has no revision). `INSERT OR REPLACE`: a later request
for the same path supersedes the earlier intent. No file is touched inside
the transaction; §5.7 says how the rows become files.

9b. **Properties (store 13.1).** After the blocks and sections: delete the
    doc's `properties` rows and insert the document's property rows as
    `spec/properties` defines them (`INSERT OR REPLACE` on `prop_id`, with
    `repo_id`, `doc_id`, `created_commit = this commit`, `deleted_commit =
    NULL`). The rows are `spec/properties`' output, pinned by its fixtures;
    this spec's fixtures do not project them.

9c. **Graph (store 13.2).** After the properties: the doc's `nodes` (and
    their FTS rows) are replaced by the projection `spec/graph` §2 defines;
    its edges are extracted, resolved and interval-maintained per
    `spec/graph` §3 — this **mints `x` per new external URI during
    resolution and `e` per newly opened edge during insertion**, before the
    dispositions — and `doc_edges` is rebuilt. Phantom adoption
    (`spec/graph` §3.5) happens in step 2 when a doc row is created. Those
    tables are `spec/graph`'s output, pinned by its fixtures; this spec's
    fixtures do not project them. The mint order pinned above is complete
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

1. **Mint `c`**; insert a commit `(seq, ts, origin = 'observed', actor =
   NULL, reason = 'observed deletion')`.
2. `INSERT OR REPLACE` every live block of the doc into `resurrection_pool`
   with `deleted_commit = this commit`, `expires_ts = ts + 30 days`.
3. Delete the doc's FTS rows; `UPDATE blocks SET deleted_commit = this commit
   WHERE doc_id = ? AND deleted_commit IS NULL`; `UPDATE docs SET
   deleted_commit = this commit`.

No revision, no dispositions. The doc's `sections` rows are left in place
(§10). The blocks are pooled because a vanished file
is overwhelmingly a move or a transient; the intentional API delete pools
nothing (mutation kernel, not this spec). A gone path with no live doc is a
no-op with outcome `{ deleted: false }`.

**Re-creation.** When bytes are observed again at a tombstoned path, §5.1
step 4 reconciles against an empty old tree (the tombstoned rows are not
live) with the pool offered, so identical blocks resurrect (`spec/reconcile`
phase 6b), and §5.4 step 1 reuses the doc row — **and clears its
`deleted_commit`**: the row is live again, its `current_rev` advances, and
the next observation of the same bytes is an echo. (§10: the reference did
not clear the tombstone; found while writing this section.)

### 5.7 Materialization and pending rows (14.0)

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

**Materializing a row** (`materialize_row`), through the repo's doc store,
then `DELETE` the row — autocommit per file, so partial progress is durable.
Bytes are `reconstruct at rev_id` (§6.2 — byte-exact for a current revision,
and a row always names its document's current revision because a later
commit to the path replaces the row). A materializer never overwrites bytes
it does not recognise as the engine's own: at `path` it accepts nothing, the
bytes the row names (`rendered_hash`), or the **prior** bytes — the rendered
hash of the revision before `rev_id` (what the file holds when the process
died after COMMIT; the commit phase itself passes the `file_hash` it
validated the file against). Anything else is **foreign** — a human edit
that landed meanwhile — and the row is kept: the next observation of the
path decides (below), so the api intent is superseded by a later edit, never
silently reverted and never overwriting it.

| Row | At `path` | Action |
| --- | --- | --- |
| `write` | absent, or the prior bytes | write the revision's bytes; delete the row |
| `write` | the row's bytes | already there (another materializer, or a human wrote the same); delete the row |
| `write` | foreign bytes | keep the row (the observation applies "file wins") |
| `rename` | absent; `from_path` present | rename `from_path` → `path`; if the renamed file holds the prior bytes rather than the row's (a self-linking source), write the revision's bytes over it; delete the row |
| `rename` | absent; `from_path` absent | write the revision's bytes at `path`; delete the row |
| `rename` | the row's bytes | done; a stale copy of the engine's own bytes still at `from_path` is removed; delete the row |
| `rename` | foreign bytes | keep the row (`path` wins; `from_path` becomes an untracked file) |
| `remove` | the row's bytes | unlink; delete the row |
| `remove` | absent, or foreign bytes | leave the file (a rewritten file is untracked now — the next sweep re-creates the path, §5.6); delete the row |

A row whose bytes cannot be rendered (`rev_id` names no revision, the
reconstruction does not hash to `rendered_hash`) is kept for a later
materializer rather than guessed. `materialize_pending(repo)` replays every
row of a repo in insertion order and returns the paths cleared; it is step 0
of the freshness sweep and of recovery (`spec/sync` §4.3) — the production
recovery points — and `spec/mutate` §4 step 5 (a) replays the rows of the
paths a request touches before reading their files.

**The gate rule.** An observation (§5.1) of a path that has a pending row
runs this check first, before the echo gate, keyed by the `(repo, path)` row:

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
  the **previous** revision's bytes after a crash is foreign to this rule —
  it does not hash to `rendered_hash`, and it is indistinguishable from a
  human who reverted the file — so observing it commits the old bytes as a
  new observed revision over the api one (`spec/mutate`
  `materialize::crash-then-observe-of-stale-file-is-foreign`). The api
  revision stays in history; nothing is reverted silently. This is why the
  materializer, not the observation, is the recovery point: the sweep runs
  step 0 before it walks the disk, and a watcher batch that reaches the gate
  first is a human's intent as far as the engine can tell.

`observe_delete` applies the gone-member rule the same way. The disk-drift
counters (`spec/sync` §4.3) may transiently count a path with a pending row
as `changed`; they are read-only and the next sweep settles it.

## 6. Reads this spec pins

### 6.1 Reconstruct (current bytes)

`reconstruct(doc)` for a live doc: `leading_trivia`, then — if the current
revision has a `frontmatter_blob` — that blob's bytes followed by
`frontmatter_trivia`, then for each **top-level** live block in `order_key`
order the `raw` blob's bytes followed by the trivia blob's bytes when
`trivia_hash` is not `NULL`. A container's `raw` already contains its
children (`spec/format` §1 inv. 3), so only roots are walked. Equals `source`
by construction (§5.4 step 13). `NULL` for a tombstoned or unknown doc.

### 6.2 Reconstruct at a revision

The same assembly sourced from the revision's Merkle root: the revision's
`frontmatter_blob`, then the entries of `tree_nodes[root_tree]` in array
order, each `raw_hash_hex` blob followed by its `trivia_hash_hex` blob when
non-null (children not walked). `leading_trivia` and `frontmatter_trivia`
come from the **current** doc row — they are not versioned — so the result
is byte-exact for the current revision and best-effort for older ones; the
read reports `rendered_hash_match = sha256(result) == rendered_hash` as the
honest signal. The materializer (§5.7) and recovery render a pending row's
bytes with this read at the row's `rev_id`, and refuse the row when the
result does not hash to `rendered_hash`.

## 7. Rebuild and garbage

**Rebuild.** `sections` is recomputed per live doc from `blocks` (§4.5);
`block_changes` is `INSERT OR IGNORE … SELECT block_id, commit_id, kind FROM
dispositions` after a `DELETE`; the FTS index is `INSERT INTO
blocks_fts(blocks_fts) VALUES('delete-all')` followed by one insert per
live leaf of every live doc (`spec/search` §1.1; FTS5's `'rebuild'` would
index the whole content table, containers included); `doc_edges` is the graph
component's. A rebuilt deterministic table equals the maintained one row for
row (§8 I8).

**Garbage collection** is mark-and-sweep from every `revisions.root_tree`
(walking `child_tree_hash_hex`) and `frontmatter_blob`: reachable tree nodes
and blobs (raw, trivia, frontmatter) are kept, the rest deleted. It ships
behind a flag, **off**, and because revisions are never pruned in v1 nothing
is ever unreachable — §8 I5 checks exactly that. The only routine collection
is the pool sweep (§5.5).

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
- *Categories*, always the four, in this order, each with `bytes`
  (its tables' sum), `share` (one decimal of the dbstat total, rounded
  half up), `rows` (its tables' sum) and its tables by bytes desc then
  name: **content** — the live state: `docs`, `blocks`, `sections`,
  `nodes`, `edges`, `doc_edges`, `inferred_edges`, `external_nodes`,
  `properties`, `collections`; **history** — the append-only record:
  `blobs`, `tree_nodes`, `revisions`, `commits`, `dispositions`,
  `block_changes`, `resurrection_pool`, `pending_materializations`;
  **search** — the derived indexes: `blocks_fts`, `nodes_fts`,
  `embeddings`, `doc_embeddings`; **sync** — the workspace bookkeeping:
  `repos`, `sources`, `adapters`, `attachments`, `checkpoints`,
  `file_stats`, `sync_state`, `workspace_settings`, and *anything this
  spec does not name* (`sqlite_schema`, a `sqlite_stat1`, a table from a
  newer schema). A table added to `schema.sql` is assigned here in the same
  change (both engines' tests check the assignment covers the DDL).
- *Advice*, deterministic strings in this order, each conditional: `run
  \`omg gc --vacuum\` to return <bytes> of free pages to the filesystem`
  when `reclaimable` exceeds 1 MiB *and* 10 % of `page_count ×
  page_size`; `history dominates (<share>): blobs, tree nodes and
  dispositions grow with every commit — enable gc (\`omg config set
  gc.enabled true\`) and run \`omg gc --vacuum\`` when `history`'s share
  exceeds 50; `embeddings are <share> of the database: a smaller model
  (\`embedding.model\` / \`embedding.dim\`) or \`omg embed drain --prune\`
  after a model switch shrinks them` when `embeddings` + `doc_embeddings`
  exceed 25 % of the total; else the single line `nothing to reclaim`.
  `<bytes>` is humanized — `<n> B` under 1024, else one decimal of a
  1024-based KB/MB/GB/TB with the tenths rounded half up (`4096` →
  `4.0 KB`) — and `<share>` is `<n>.<d>%`; both engines format from the
  integer tenths so no rounding mode can differ.

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

- **I1 Convergence.** For every live doc with a current revision:
  `docs.file_hash == revisions.rendered_hash == sha256(last observed
  source)`; `reconstruct(doc) == source` (§6.1); reconstruct at the current
  revision (§6.2) `== source` with `rendered_hash_match = true`. (On the
  api path the file lags the store while a pending row exists — §5.7; the
  `spec/mutate` runner compares such a path against the store's own
  reconstruction, as it does for a `disk` edit.)
- **I2 Hash integrity.** Every `blobs` row: `hash == sha256(bytes)`, `size ==
  |bytes|`. Every `tree_nodes` row: `hash == sha256(entries)` and `entries`
  parses as §4.1 with every `raw_hash_hex`/`trivia_hash_hex` present in
  `blobs` and every `child_tree_hash_hex` present in `tree_nodes`. Every
  `revisions.root_tree` present in `tree_nodes`; every `frontmatter_blob` in
  `blobs`.
- **I3 Blocks mirror the current revision.** For every live doc, the live
  `blocks` rows, read as a tree (children by `parent_block`, `order_key`
  order), have exactly the ids, types, `raw_hash`es and trivia hashes of the
  current revision's tree (walking `child_tree_hash_hex`), in the same
  order; `ordinal` is dense from 0 per parent and agrees with `order_key`
  order; `depth` and `ancestor_path` follow §4.3; `norm_hash ==
  sha256(text)`; `attrs` as JSON equals the tree entry's attrs.
- **I4 Dense sequences.** `commits.seq` is `1..n` per repo in `ts`-then-seq
  order; `revisions.seq` is `1..k` per doc; `current_rev` is the revision
  with the greatest `seq`.
- **I5 Nothing to collect.** The mark set of §7 equals all of `blobs` and
  `tree_nodes` (GC would sweep zero rows).
- **I6 Pool.** Every `resurrection_pool` row names a `deleted_commit` that
  exists, an `expires_ts` exactly 30 days after that commit's `ts`, and a
  block id that has no live `blocks` row.
- **I7 Dispositions.** Every disposition's `commit_id` exists. For every
  commit that is the *current* commit of at least one live doc, over the live
  docs whose current revision it wrote (one on the observe path; N for an
  `api` changeset, §5.4 "The api path" — 13.7, one doc before): every
  disposition of that commit whose kind is not `deleted` or `merged_into`
  (and whose block is not `"DOC"`) names a live `blocks` row of one of those
  docs, and every `deleted`/`merged_into` one names no live row of any of
  them. (Older commits are not checked against `blocks`: a block `inserted`
  under one doc may legitimately be live in another after a later
  cross-document resurrection.)
- **I8 Rebuild equivalence.** `sections` and `block_changes` recomputed per
  §7 equal the stored rows.

## 9. Fixtures

### 9.1 Layout

`cases/<suite>.json`, `suite` = file stem. Three kinds of suite, told apart
by the case shape: `schema.json` (§9.2, one case), `migrations.json` (§9.3),
and observation suites (§9.4) — `observe.json`, `identity.json`,
`deletion.json`, `pool.json`, `structure.json`, `frontmatter.json`,
`batch.json`, … as the coverage grows. Case ids are `<suite>::<name>`.

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
repos are visited in `rowid` order).
`setup` and `rows` may be empty. `rows` names the tables whose full contents
(every column, `ORDER BY rowid`) the `expect` carries; blobs are hex;
`tables` maps every table to its column names in `cid` order. The fixture
minter (§2.2) is active, so ids minted by a migration (`src_0`) compare.
When opening must fail (a newer `user_version`), `expect` is instead
`{ "error": "<the exact message>" }` — `migrations::newer-version-is-refused`
pins `database schema (v15) is newer than this build (v14); upgrade omgbase`.

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
        "docs":        [ { "doc_id": "d_0", "path": "a.md", "format": "markdown", "current_rev": "r_1", "file_hash": "<hex>", "conflicted": 0, "leading_trivia": "", "frontmatter_trivia": null, "deleted_commit": null } ],
        "commits":     [ { "commit_id": "c_0", "seq": 1, "ts": "…", "origin": "observed", "actor": null, "reason": null, "checkpoint_id": null, "ops": null }, … ],
        "revisions":   [ { "rev_id": "r_0", "doc_id": "d_0", "seq": 1, "root_tree": "<hex>", "frontmatter_blob": null, "rendered_hash": "<hex>", "path": "a.md", "commit_id": "c_0" }, … ],
        "blobs":       [ { "hash": "<hex>", "size": 7, "bytes": "# Title" }, … ],
        "tree_nodes":  [ { "hash": "<hex>", "entries": "[[\"b_0\",\"…\",null,\"heading\",{\"level\":1},\"…\"],…]" }, … ],
        "blocks":      [ { "block_id": "b_0", "doc_id": "d_0", "parent_block": null, "order_key": "V", "ordinal": 0, "depth": 0, "ancestor_path": "/", "type": "heading", "attrs": { "level": 1 }, "text": "Title", "raw_hash": "<hex>", "norm_hash": "<hex>", "trivia_hash": "<hex>", "created_commit": "c_1", "deleted_commit": null }, … ],
        "dispositions": [ { "commit_id": "c_0", "block_id": "b_0", "kind": "inserted", "confidence": null, "reason": null, "matcher_v": "m2.3", "detail": {} }, … ],
        "block_changes": [ { "block_id": "b_0", "commit_id": "c_0", "kind": "inserted" }, … ],
        "resurrection_pool": [ { "block_id": "b_1", "doc_id": "d_0", "raw_hash": "<hex>", "norm_hash": "<hex>", "type": "paragraph", "deleted_commit": "c_1", "expires_ts": "…" } ],
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
  distinct within one batch. `sweep` carries `ts`. `expect.steps` has one
  entry per step.
- `config` overrides any subset of `spec/reconcile` §6 for every observe step
  of the case (the store passes it through).

**Expect** (generated) is the projection of the database after the last step:

- `steps`: one entry per step. For `observe`, a list of outcomes in item
  order — observed items as `{ path, echo, doc, commit, rev, converged,
  conflicted, dispositions }` (`commit`/`rev` `null` on an echo;
  `dispositions` a kind → count object, `{}` on an echo), gone items as
  `{ path, deleted, doc }` (`doc` null when nothing was live). For `sweep`,
  `{ swept: <rows deleted> }`.
- `docs` ordered by `path`; `commits` by `seq`; `revisions` by `(doc_id
  bytewise, seq)`; `blobs` and `tree_nodes` by `hash`; `blocks` by doc (in
  `docs` order) then **pre-order** over the doc's rows (children by
  `parent_block`, `ordinal` order — tombstoned rows keep their tree shape);
  `dispositions` and `block_changes` by (commit `seq`, `block_id` bytewise,
  `kind` bytewise); `resurrection_pool` by (`expires_ts`, `block_id`
  bytewise); `sections` by (`doc_id` bytewise, `first_ordinal`);
  `pending_materializations` (14.0) by `path`, as `{ path, kind, from_path,
  doc_id, rev_id, rendered_hash, commit_id }` — always `[]` here, since only
  the api path inserts rows; the `spec/mutate` scripts (its §9), which share
  this shape, pin the rows through their `crash_after_commit` modifier and
  `materialize {}` step.
- Hash columns as hex; `attrs` and `detail` as JSON objects (compared with
  key order ignored); `bytes` as the decoded string; every other column as
  its SQLite value (`INTEGER` → number, `NULL` → `null`).
- Tables outside §3.1/§3.2's pinned set are not projected.

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

## 10. Reference oddities surfaced while specifying, and decisions

Each is **pinned** (a fixture asserts it; changing it is a store change under
"Versioning") or **fixed** (the prose above is the fix and the reference is
brought to it).

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
- **Pinned — `created_commit` is "last written by".** Every `blocks` row is
  rewritten by every commit to its document, and all of them carry the
  committing commit as `created_commit` — a carried block does not keep its
  birth commit. The block's history lives in `dispositions`/`block_changes`;
  the column is a write stamp. Kept as built; a fixture with two revisions
  shows it.
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
  document keeps stale section rows although §4.5 defines sections over
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
