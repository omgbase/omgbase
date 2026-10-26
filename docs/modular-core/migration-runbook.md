# Modular core — the migration and rollback runbook (Phase 5)

The plan's §7 "Migration and rollback" as an operator procedure over
`scripts/qualify/migrate-copy.mjs` (Phase 5a). It migrates a COPY, never the
workspace it is pointed at; the original is not opened, let alone written.
Everything below is the TypeScript reference; the Rust binary is the second
opener in step 4. Numbers only in anything you paste from a run — the JSON
report names document paths in its `diff` entries when something differs.

## 0. The one-line invocation

```
pnpm build                                   # the TS CLI + core dist the script drives
cargo build --release -p omgbase             # the Rust opener for the compatible-open check (optional)
node scripts/qualify/migrate-copy.mjs --workspace <dir> --rust-bin target/release/omgbase --compositions --out /tmp/qualify-<name>.json
```

`<dir>` is the workspace root (`<dir>/.omgbase/omgbase.db`). Exit 0 and
`"ok": true` is the gate; the stdout is the six-category size table (before,
after, the four compositions) and the report with `diff` as a count. Add
`--before-bin <path to the omg that wrote the workspace>` when one is
installed: it supplies the BEFORE bytes per document (otherwise the byte
check is hash-level, below) and proves the old engine refuses the migrated
copy. `--keep` leaves the temporary directory for inspection.

## 1. Before you run it — a consistent backup (plan §7 step 1)

1. **Quiesce the writers**: stop `omg mcp`, `omg watch`, every editor
   integration and cron that writes through `omg`. The script copies the
   database file and its WAL byte for byte and checkpoints the WAL into the
   copy; a writer mid-transaction would be copied mid-transaction.
2. **Resolve or preserve pending operations**: `omg sync` once (it replays
   the pending materialization rows — `spec/store` §5.7 — and ingests any
   out-of-band edit), then `omg doctor` must be `ok` (no active alert). A
   pending row that cannot be replayed (a foreign file at its path) is
   preserved by the migration and reported by the script as "present" — that
   is fine; one that disappeared without its file is a red diff.
3. **Back up**: `cp -R <dir>/.omgbase <somewhere>/omgbase-<date>` with the
   writers still quiesced (the `.omgbase` directory holds the database, its
   WAL and the archives). This is the rollback artefact of §5.

## 2. Migrate on a copy (plan §7 steps 2–3)

The script does this. What it does, so the report reads right:

- **(a) the copy** — the workspace's files are copied (the CAS and recovery
  checks need a working tree), the database and its WAL copied byte for byte,
  then `VACUUM INTO` from a read-only connection on the copy writes the final,
  WAL-free database. The original is never opened.
- **(b) BEFORE** — a schema-aware snapshot of the copy's rows: every live
  document `{ _id, _path, _hash, head, created_at, updated_at }`, every live
  block `{ _id, doc, parent, ordinal, hash }`, the property and link rows
  sorted, the id-claim count, the pending rows, `user_version`, the
  six-category sizes (`dbstat`). A 16.x database reads `current_rev`/
  `deleted_commit`; its timestamps are null (they are commit joins the
  migration computes — not compared). With `--before-bin` the old engine
  renders every document's bytes (`q 'docs { _path, _raw }'`).
- **(c) the migration** — the copy is opened by the current TypeScript
  engine (`omg doctor --json`; the open runs `spec/store` §3.4 — a 16.x
  database materializes its live heads out of the recorder's Merkle tree
  ONCE and backfills the claims, the feed, the manifest with capture
  `enabled` so prior behaviour continues, resolution 17; a 17.0–17.2
  database runs the finish steps, 17.3's being the deletion of its tombstoned
  `blocks` rows). The legacy fidelity limit is recorded by the manifest's
  coverage interval (`coverage_from` = the earliest commit) and by `doctor`'s
  "capture complete".
- **AFTER** — the same snapshot through the TypeScript engine, plus its
  rendered bytes and the three read queries (docs, blocks, links) both
  engines must answer alike.

## 3. Compare before/after (plan §7 step 4)

`diff` must be `[]`. The kinds the script knows, each a named invariant:

| kind | what moved |
| --- | --- |
| `hash`, `path`, `head`, `doc_missing`, `doc_extra` | a live document's identity, path, head token or `file_hash` |
| `created_at`, `updated_at` | a 17.x document's timestamps (not compared from a 16.x BEFORE) |
| `block_missing`, `block_extra`, `block_doc`, `block_parent`, `block_ordinal`, `block_hash` | the id / parent / order / content map of the live blocks |
| `property_missing`, `property_extra`, `link_missing`, `link_extra` | a property or link row |
| `claims` | fewer id claims after than before |
| `pending_lost` | a pre-migration pending row neither present nor materialized |
| `bytes_hash` | AFTER's rendered bytes do not hash to the document's `file_hash` (the hash-level byte check, always on) |
| `bytes`, `bytes_unreadable` | AFTER's bytes differ from the old engine's (`--before-bin`), or a document could not be rendered |

Beside the diff: **CAS** — on the copy a block is updated with a stale
`expect.content_hash` (refused `stale_expectation`) and then with the fresh
one (accepted); **recovery** — `recoverRepo` runs twice, the first pass
records what it replayed/healed/missed, the second must be a no-op.

**Limitation without `--before-bin`.** A pre-17 database's current bytes
live in the recorder's Merkle tree and cannot be rendered without the old
engine, so the byte check is the hash check: AFTER's bytes must hash to
BEFORE's `docs.file_hash`, which under I1 is the same promise the old engine
made about its file. With `--before-bin` the bytes are compared directly.

## 4. Compatible-open and the compatibility matrix (plan §7 steps 4–5)

With `--rust-bin` the Rust binary opens the migrated copy: `version.schema`
must agree, `doctor` must be `ok`, and the docs/blocks/links queries must
answer byte-identically to the TypeScript engine (`compatible_open.rust`).
With `--before-bin` the old binary must REFUSE the copy with the pinned
`database schema (v17) is newer than this build (v16); upgrade omgbase`
(`compatible_open.before_bin.refused`); a 17.x `--before-bin` shares the
schema major and opens it (`opened_same_major` — reported, not a failure).

| engine / version | schema 16 (store 16.x) | schema 17 (store 17.0–17.3) |
| --- | --- | --- |
| TypeScript `omgbase` ≤ 0.27 (store 16.x) | read / write | **refused** ("newer than this build") |
| TypeScript `omgbase` ≥ 0.28 (store 17.x, this repository) | **migrates on open** to 17 (one-way; needs the history module — a `core`/`semantic` composition refuses with "upgraded by an engine that carries the history module") | read / write; a 17.0–17.2 database runs the finish steps on first open (17.3: tombstoned block rows deleted) |
| Rust `omgbase` ≥ 0.28 (store 17.x) | migrates on open (the twin of the same step) | read / write (the 17.3 finish step with its twin) |
| any engine, a database with a HIGHER `user_version` | — | refused: an unknown version never writes |

The four compositions of either engine open the same 17 database: a
composition without the history module refuses writes on a repository whose
manifest says `writer_requires` (the `writer_refused` alert) and serves the
history tools `capability_unavailable { history, unavailable }`; one without
the semantic module answers `semantic()` with `{ semantic, disabled }`. Which
bundles a database holds is the manifest's business (`spec/store` §3.1), not
the opener's.

## 5. Cut over, and the rollback rule (plan §7 steps 5–6)

Cut over only when the report says `"ok": true` with `diff: []` and the
compatible-open block is green. Then, writers still quiesced: run the
current engine once against the ORIGINAL (`omg doctor` — the same migration,
now on the real database), re-run `migrate-copy.mjs` against it (a 17 → 17
run: no diff, `doctor` ok, CAS and recovery hold), start the writers.

- **A failed pre-cutover run leaves the original intact.** The script never
  opens the original; a red report costs nothing but a temporary directory.
  Fix, re-run, repeat.
- **After the cutover, before any new write**, rollback is the §1 backup:
  stop the writers, replace `.omgbase/` with the copy, start the old engine.
- **After new writes have been accepted**, rollback is forward repair or
  export/replay: the 17 database cannot be read by a 16.x engine (the
  matrix), and the writes since the cutover exist only in it. Either keep the
  new engine and repair forward (`omg doctor`, `omg sync`, `omg
  rebuild-index`), or export the files (`omg sync` materializes every
  pending row; the working tree IS the content) and replay them into a fresh
  workspace of the old engine — losing the identities and the history the
  new database holds. Decide this BEFORE the first write, not after.
- **`history disable` changes future capture only** (plan §7 step 6): the
  rows stay readable, the coverage interval closes, `history purge` is the
  separate, explicit removal. `--compositions` measures what each choice
  costs on your own copy before you make it.

## 6. The four compositions (`--compositions`)

After the migration the copy is cloned four times and the plan's compositions
are produced ON DISK by the verbs an operator would run — `full` (as
migrated), `history` (`embed disable`), `semantic` (`history disable` +
`history purge`), `core` (both) — then each clone is read (the snapshot must
equal AFTER's), CAS-checked, recovered and sized. The size rows are the
measured amplification of the gate; their `history` column is 0 for
`semantic` and `core`.

## 7. What 5b runs on a real repository copy

```
node scripts/qualify/migrate-copy.mjs --workspace <the workspace> --rust-bin target/release/omgbase --compositions --out /tmp/qualify-<name>.json
```

and, when the `omg` that wrote the workspace is still installed,
`--before-bin "$(which omg)"` before upgrading it. Record the size table and
the `ok` flags (numbers only) in `baseline.md` §3's style; keep the JSON out
of the repository.
