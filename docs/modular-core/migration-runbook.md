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
node scripts/qualify/migrate-copy.mjs --workspace <dir> --rust-bin target/release/omgbase --with-files --repair --compositions --out /tmp/qualify-<name>.json
```

`<dir>` is the workspace root (`<dir>/.omgbase/omgbase.db`). Exit 0 and
`"ok": true` is the gate; the stdout is the six-category size table (before,
after, the four compositions) and the report with `diff` as a count. Add
`--before-bin <path to the omg that wrote the workspace>` when one is
installed: it supplies the BEFORE bytes per document (otherwise the byte
check is hash-level, below) and proves the old engine refuses the migrated
copy. `--with-files` copies a source tree that lies OUTSIDE the workspace
directory (a database-only copy of a workspace, as 5b's copies are) beside
the copied database — the byte count is printed — so recovery and the
repair have files to work from; without it such a root is replaced by an
empty directory and recovery is skipped. `--repair` runs `omg sync` on the
copy after the migration (§2a below). `--keep` leaves the temporary
directory for inspection. A directory whose database has no `docs` table is
not a workspace: the script prints `{ ok: false, reason }` and exits 2.
Every `omg` the script runs passes `--stale`, and the copy's `fs` sources
are re-pointed at the copied tree before anything opens it: nothing the
script does can read or write the original directory.

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
  `enabled` so prior behaviour continues, resolution 17, rebuilds the FTS
  index over the new rows and runs the fidelity check of step 17 (16); a
  17.0–17.3 database runs the finish steps — 17.3's the deletion of its
  tombstoned `blocks` rows, with their FTS entries since 17.4; 17.4's the
  fidelity check behind the cheap signature of legacy rows). The legacy
  fidelity limit is recorded by the manifest's coverage interval
  (`coverage_from` = the earliest commit) and by `doctor`'s "capture
  complete".
- **(c′) legacy bytes and the repair (`--repair`)** — `spec/store` §5.11.
  A document ingested before block trivia was stored (schema v6) has
  rows that do not reproduce its file: the 16.x reader already served it
  without the newlines between its blocks, while the file and `file_hash`
  were right. The migration names such documents in the `legacy_bytes`
  alert (`<n> document(s) carry bytes the engine cannot reproduce from its
  rows …`), `doctor` fails `bytes reproducible` with the count, and the
  report carries it as `after.ts.legacy_bytes`. The REPAIR is `omg sync`:
  the sweep rewrites the separator bytes of every named document whose file
  is present and hashes to `file_hash` — every block keeps its id, the head
  stays, no commit, no revision — and clears the alert when none is left.
  With `--repair` the script runs it on the copy (the files must be there:
  a root inside the workspace is copied with it, an outside root needs
  `--with-files`) and reports `repair: { legacy_bytes_before, repaired,
  remaining, synced_from_disk }` — `synced_from_disk` counts the documents
  the sweep ingested because their files were NEWER than the database
  (ordinary sync activity on the copy, not a migration effect); the
  differences those documents cause, and the `bytes` entries of repaired
  legacy documents (the old engine misread them, AFTER reproduces
  `file_hash`), are set aside in the report's `informational` member, so
  `diff` holds only the unexpected and alone decides `ok`. `remaining > 0` means documents whose files are gone (they
  stay listed — `doctor` keeps showing the count — until the file comes
  back or the document is deleted) or whose parse no longer matches their
  rows. **On the real workspace, run `omg sync` once right after the
  migration and before cutting over** (§5): until then every read of a
  legacy document returns the legacy bytes, as it did through 16.x. A
  document's history keeps the 16.x capture: `docs_read { at: <head> }`
  renders the legacy bytes with `renderedHashMatch: false` until its next
  commit.
- **AFTER** — the same snapshot through the TypeScript engine (after the
  repair, when `--repair` ran), plus its rendered bytes and the three read
  queries (docs, blocks, links) both engines must answer alike.

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
| `bytes_hash` | AFTER's rendered bytes do not hash to the document's `file_hash` (the hash-level byte check, always on). A legacy document (§2 c′) is exactly this diff until `--repair` / `omg sync` repairs it; the migration names them (`after.ts.legacy_bytes`) |
| `bytes`, `bytes_unreadable` | AFTER's bytes differ from the old engine's (`--before-bin`), or a document could not be rendered. A `bytes` entry on a document whose hash did not move and whose AFTER bytes hash to `file_hash` is the legacy repair improving on the old engine's read — reported under `informational.legacy_bytes_repaired`, not here |

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
(`compatible_open.before_bin.refused` — recognised by the message on either
stream whatever the exit status: omgbase 0.27.3 prints it as a JSON error
object and exits 0 under `--json`; the exit is recorded beside it); a 17.x
`--before-bin` shares the schema major and opens it (`opened_same_major` —
reported, not a failure). **Known limitation of the 0.27.3 Rust binary as a
`--before-bin`:** its `markdown` crate panics on some real content when it
renders the BEFORE bytes (`q 'docs { _path, _raw }'`), so the byte check may
fall back to hash-level (`before.through` says so) — the refusal check does
not render and still works. Not ours to fix; the TypeScript 0.27.x `omg` is
the better `--before-bin`.

| engine / version | schema 16 (store 16.x) | schema 17 (store 17.0–17.3) |
| --- | --- | --- |
| TypeScript `omgbase` ≤ 0.27 (store 16.x) | read / write | **refused** ("newer than this build") |
| TypeScript `omgbase` ≥ 0.28 (store 17.x, this repository) | **migrates on open** to 17 (one-way; needs the history module — a `core`/`semantic` composition refuses with "upgraded by an engine that carries the history module"); rebuilds the FTS index; names the legacy documents (`legacy_bytes`) | read / write; a 17.0–17.3 database runs the finish steps on first open (17.3: tombstoned block rows deleted, with their FTS entries since 17.4; 17.4: the fidelity check behind the signature of legacy rows) |
| Rust `omgbase` ≥ 0.28 (store 17.x) | migrates on open (the twin of the same step) | read / write (the finish steps with their twins) |
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
compatible-open block is green (a legacy workspace is green only with
`--repair`). Then, writers still quiesced: run the current engine once
against the ORIGINAL (`omg doctor --stale` — the same migration, now on the
real database; expect the `legacy_bytes` alert the copy showed), **then `omg
sync`** (the repair: `repaired <n>`; a document whose file is gone stays
listed — `omg doctor` keeps the count under `bytes reproducible` until the
file returns or the document is removed), then `omg doctor` must be `ok`
(an FTS check that fails on a database a 17.0–17.2 engine migrated earlier
is `omg rebuild-index --fts`), re-run `migrate-copy.mjs` against it (a 17 →
17 run: no diff, `doctor` ok, CAS and recovery hold), start the writers.

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
node scripts/qualify/migrate-copy.mjs --workspace <the workspace> --rust-bin target/release/omgbase --with-files --repair --compositions --out /tmp/qualify-<name>.json
```

and, when the `omg` that wrote the workspace is still installed,
`--before-bin "$(which omg)"` before upgrading it. Record the size table and
the `ok` flags (numbers only) in `baseline.md` §3's style; keep the JSON out
of the repository.

**What the first run (5a-ii, 2026-10-26) found on two copies** — numbers
only: the 853-document copy migrated with no diff and a green `doctor`; the
116-document copy came out with 115 documents in the `legacy_bytes` alert
(every block had been ingested before trivia was stored) and, before the
fixes of 5a-ii, a failing FTS check (1771 index rows for 1547 live leaves —
the 16.x index held every block) and a `--before-bin` refusal the script
did not recognise (exit 0). After the fixes: FTS clean on both, the alert
raised with the count, the refusal recognised by its message, and the
repair verified on fixture databases (the real copies' files were not
available to the run).
