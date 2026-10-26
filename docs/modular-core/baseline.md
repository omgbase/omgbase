# Modular core — Phase 0 baseline (store 16, 2026-10-24)

What the store is made of today and what one edit costs, measured — the
numbers Phase 3–5 of the modular-core plan are judged against (the plan's
economic gate: "set numerical budgets from Phase 0, before implementation is
judged"; the October 13 snapshot of 131 MB predates store 14.2 and 16 and is
not a baseline). Everything here is the engine as it is at this commit; nothing
was changed to take it. "Measured" is a `doctor --size --json` report
(spec/store §7.2: bytes per table from `dbstat`, the file, the WAL) or a wall
clock; "derived" is arithmetic on those.

**Column legend.** The per-stage tables name the size report's categories
by name. Runs through 17.0 (3d) have the four categories of store 14.1–16.x
(`content`, `history`, `search`, `sync`), with `id_claims`, `resurrection_pool`
and `pending_materializations` filed under `history`; runs from 17.0 (3e-i)
have the six of `spec/store` §7.2 — `content`, `identity` (`id_claims`,
`resurrection_pool`), `recovery` (`pending_materializations`), `history`,
`search`, `sync` — so a `history` figure before 3e-i includes the identity
and recovery bytes a later run reports separately. The harness
(`scripts/baseline/modular-core-baseline.mjs`) prints every category it is
given; an older report leaves the `identity`/`recovery` columns empty.

## 1. Three real workspaces (size reports only)

Taken with the Rust CLI 0.27.3 against databases at `user_version` 16. No
content was read; the reports hold table names, bytes and row counts.

| workspace | docs | Markdown | database | × source | content | history | search | sync |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a real notes corpus, two months of daily use, embeddings on | 853 (8,959 live blocks) | 1.86 MB | 73.1 MB | 39× | 12.9 MB (17.7 %) | 36.4 MB (49.8 %) | 22.6 MB (30.9 %) | 1.2 MB |
| a second, younger copy of a similar corpus, no embeddings | 116 (1,771 blocks) | 0.24 MB | 2.8 MB (+1.0 MB WAL) | 11.6× | 1.28 MB (43.2 %) | 1.29 MB (43.6 %) | 0.27 MB | 0.11 MB |
| the alchemy sample (repo-explorer's dev workspace, after a day of demo writes) | 21 (328 blocks) | — | 0.95 MB | — | 0.41 MB (45.1 %) | 0.32 MB (34.8 %) | 0.09 MB | 0.09 MB |

The first row is the one that matters. Its history is **19.5× the Markdown it
remembers** and its live content tables **6.9×**; its 1,778 commits span
2026-09 (433) and 2026-10 (1,345). Where the history bytes sit:

| table | MB | rows | bytes / row | note |
| --- | --- | --- | --- | --- |
| `blobs` | 17.94 | 10,660 | 1,683 | every distinct block raw, container raw, trivia and frontmatter string; a nested block's raw is a substring of its container's, stored once per nesting level |
| `tree_nodes` | 7.79 | 4,631 | 1,682 | one sibling list per revision subtree (store 16 deltas apply only to revisions written after the 16 upgrade — this database predates it, so these are mostly full checkpoint forms) |
| `dispositions` | 4.61 | 52,928 | 87 | 6,808 of them are pre-14.2 `same` rows the default `gc` sweep would remove (`gc` has not been run) |
| `block_changes` | 3.91 | 52,928 | 74 | the projection of dispositions; the `b_` id mint oracle reads it |
| `commits` | 1.41 | 1,778 | 793 | one row per write, with its `ops`/summary JSON |
| `revisions` | 0.61 | 2,367 | 258 | |

Search is the other half: `embeddings` 17.6 MB over 4,175 rows (4.2 KB per
block vector) plus `doc_embeddings` 3.6 MB — 12× the Markdown on their own —
against 1.4 MB of FTS. Content: `blocks` 6.0 MB (8,959 rows, 672 B each, the
raw bytes live here too), `properties` 3.2 MB (9,337), `nodes` 1.5 MB,
`edges` 1.2 MB (5,395 rows — closed intervals kept), `doc_edges` 0.6 MB.
`VACUUM` would reclaim nothing (6 free pages).

## 2. The synthetic workload, both engines

`scripts/baseline/modular-core-baseline.mjs --engine rust|ts --docs 200 --edits 50`:
a seeded corpus (201 documents in three folders, six frontmatter keys, ~17
blocks each with headings, a list, three tasks, a quote and three rooted
links; 0.22 MB of Markdown), `init --no-embedder`, one filesystem source, then
six write workloads of 50 operations (20 for delete/recreate), four read shapes
× 20, and the default `gc`. The two engines produce the same database to within
a few KB (the one apparent divergence of a first run was the harness, below).

### Growth per stage (Rust 0.27.3; TS 0.26.3 within ±10 KB per stage, final database 5.68 vs 5.74 MB)

| stage | ops | db MB | grew KB | KB / op | content | history | where the history bytes went (KB, Rust) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 5.15 | 5,149 | 25.6 / doc | 2.67 | 2.11 | blobs 565 (3,009 rows), tree_nodes 860 (802), dispositions 311 + block_changes 266 (3,404 each), commits ~50, revisions ~50 |
| frontmatter hot update (`meta --set counter=i`, one doc) | 50 | 5.23 | 82 | 1.6 | +4 | +60 | commits 33, revisions 25, blobs 4 (+50 one-key frontmatter deltas), tree_nodes 0 |
| block edit (`update <paragraph>`, one block) | 50 | 5.33 | 98 | 2.0 | 0 | +70 | tree_nodes 29 (+50), blobs 12 (+52), commits 20, revisions 8, dispositions 4 + block_changes 4 (+50 each) |
| rolling journal (`append` under a heading) | 50 | 5.51 | 180 | 3.6 | +20 | +150 | blobs 57 (+101: the list and the new item), tree_nodes 41 (+100: the root list and the list), commits 16, dispositions 8 + block_changes 12 (+100) |
| task churn (`done` / `--undo`) | 50 | 5.55 | 41 | 0.8 | 0 | +40 | commits 16, revisions 8, dispositions 4 + block_changes 8 (+100), blobs 0 (+2: the two states dedupe), tree_nodes 4 (+5) |
| link churn (`meta --set-json related=[…]`, alternating) | 50 | 5.64 | 90 | 1.8 | +29 | +40 | commits 25, revisions 12, blobs 0 (+4), tree_nodes 0; content: `edges` intervals closed and reopened, `properties` rows |
| delete / recreate (`rm --doc` + `new`, 10 pairs) | 20 | 5.72 | 82 | 4.1 | +4 | +70 | tree_nodes 41 (+40), dispositions 8 + block_changes 8 (+170: 17 `inserted` rows per recreate), commits 20, revisions 0 (+10); blobs +0 (every byte string already known) |
| gc (default sweep) | | 5.73 | 8 | | 0 | 0 | nothing swept: with retention off every history row is reachable |

Derived: the import costs **23.8× the source** (content 12.1×, history 9.6×);
a one-key frontmatter change costs **1.6 KB**, of which 1.2 KB is the
`commits` + `revisions` rows and 80 bytes is the store-16 frontmatter delta;
one paragraph edit 2.0 KB; one journal line 3.6 KB (two sibling lists are
re-encoded, the root's and the list's, plus the item and the list raws);
checking a task 0.8 KB. After every workload and the sweep the database is
**26.5× the source**, and the sweep reclaimed nothing because nothing is
unreachable — growth under the current policy is linear in edits, with the
per-commit constant (`commits` ≈ 660 B, `revisions` ≈ 500 B) the largest
single term for small edits.

### 17.0 (3a), TS — the head and its bytes on the current rows (`ts-2026-10-25T18-43-36`)

The same harness over the Phase 3a reference (store 17.0: `docs.head`,
`frontmatter_raw`, `blocks.raw`/`trivia` inline, the time columns — legacy
capture still on), TS CLI, node 24; the 16.0 TS row above is the comparison.

| stage | ops | db MB | grew KB | KB / op | content | history | 16.0 TS (KB / op) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 5.62 | 5,624 | 28.0 / doc | 3.15 | 2.10 | 25.6 / doc (db 5.15) |
| frontmatter hot update | 50 | 5.71 | 86 | 1.7 | +10 | +70 | 1.6 |
| block edit | 50 | 5.79 | 82 | 1.6 | 0 | +70 | 2.0 |
| rolling journal | 50 | 5.95 | 160 | 3.2 | +20 | +130 | 3.6 |
| task churn | 50 | 5.98 | 25 | 0.5 | 0 | +30 | 0.8 |
| link churn | 50 | 6.05 | 78 | 1.6 | +30 | +40 | 1.8 |
| delete / recreate | 20 | 6.17 | 115 | 5.7 | +10 | +100 | 4.1 |
| gc (default sweep) | | 6.18 | 8 | | 0 | 0 | 8 KB, nothing swept |

The import costs **25.7× the source** (16.0: 23.8×) and the database after
every workload **28.3×** (26.5×): **+475 KB at import (+9 %) and +440 KB at
the end (+7.7 %)**, all of it in `content` (3.15 vs 2.67 MB; `history` is
2.10 vs 2.11 MB). That is the expected price of D10 with legacy capture on:
every live block's `raw` and trivia and every frontmatter raw now sit on the
current rows **and** in the recorder's `blobs`, so the live content's bytes
exist twice — the `blobs` table of the live subset is ≈ 0.5 MB, which is the
growth. The per-operation cost is unchanged within the harness's ±10 KB per
stage (several workloads read lower than 16.0, which is page-allocation
noise, not a saving); the one real increase is delete/recreate (+1.6 KB per
op): a recreated document writes its 17 blocks' bytes onto the new rows,
where 16.0 wrote 32-byte hashes against blobs that already existed. Nothing
else changed shape — `commits` + `revisions` are still the per-edit floor, the
sweep still reclaims nothing. The halving comes when capture is switched off
for a repository (Phase 3e's manifest, Phase 4): the inline rows then carry
the only copy and `blobs`/`tree_nodes` are not written at all.

Latency (p50 / p95 ms, process start ~165 / 540 included): import 949;
one write 245–293 / 265–328; `query` docs 236 / 267, blocks filter 228 /
268, `text("furnace")` 316 / 382, links 222 / 262; `outline` 217 / 272;
`gc` 241 — every row within the 16.0 TS run's spread (writes 246–270 / 267–
344, queries 236–336 / 370–415): the hot `docs_read`/`apply` paths now read
the rows without a `blobs` join or a frontmatter resolve, but node's start
dominates every CLI round trip, so the harness cannot see it.

### 17.0 (3b), TS — identity claims (`ts-2026-10-25T20-41-16`)

The same harness over the Phase 3b reference (store 17.0 + `id_claims`: one
row per id the core has minted, written with the row that carries it, the
recorder's bit set by its capture; the pool's `deleted_at`; the squash
without the earliest-`block_changes`-row rule — legacy capture still on),
TS CLI, node 24; the 17.0 (3a) TS row above is the comparison.

| stage | ops | db MB | grew KB | KB / op | content | history | 3a TS (KB / op) | `id_claims` rows / KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.25 | 6,250 | 31.1 / doc | 3.17 | 2.71 | 28.0 / doc (db 5.62) | 4,608 / 580 |
| frontmatter hot update | 50 | 6.34 | 86 | 1.7 | 0 | +70 | 1.7 | +50 / +4 |
| block edit | 50 | 6.43 | 90 | 1.8 | 0 | +80 | 1.6 | +50 / +8 |
| rolling journal | 50 | 6.59 | 160 | 3.2 | +20 | +130 | 3.2 | +100 / +12 |
| task churn | 50 | 6.63 | 45 | 0.9 | 0 | +50 | 0.5 | +50 / +8 |
| link churn | 50 | 6.74 | 111 | 2.2 | +30 | +60 | 1.6 | +175 / +24 |
| delete / recreate | 20 | 6.87 | 131 | 6.6 | +20 | +120 | 5.7 | +210 / +20 |
| gc (default sweep) | | 6.88 | 8 | | 0 | 0 | 8 KB, nothing swept | 0 / 0 (no `identity.claims_retain_days`) |

The import costs **28.6× the source** (3a: 25.7×) and the database after
every workload **31.5×** (28.3×): **+626 KB at import (+11 %) and +700 KB
at the end (+11 %)**, all of it `id_claims` — 4,608 rows / 580 KB after the
import, 5,243 / 656 KB at the end, which is **≈ 130 B per id ever minted**
(the row itself is ~60 B; the primary-key b-tree and the `(repo_id, prefix,
minted_at)` index the contracts name are the other half). `content` is
unchanged (3.17 vs 3.15 MB); every other history table is row for row the
3a run's (`blobs` 3,218, `tree_nodes` 1,001, `dispositions`/`block_changes`
3,822 — two fewer than 3a's 3,824, noise in the seeded churn), and the
sweep still reclaims nothing. Per operation the claims cost exactly the ids
an operation mints: a frontmatter update or a block edit mints one head
(+1 claim, ~0.1 KB — the block edit also re-mints nothing: carried ids are
claimed already); a journal append two (the head and the new item); task
churn one; link churn 3.5 (the head plus the edges and external nodes it
opens — the one place the claims are a visible share, +0.6 KB/op); a
recreate 10.5 (17 blocks + a head per `new`, nothing per `rm`, +1 KB/op).
Nothing else changed shape. The number to watch is the one `doctor --size`
now prints — `id claims  <n> ids claimed` — since the table is the one that
never shrinks on its own: `identity.claims_retain_days` is the knob, and a
repository with the recorder on keeps every row anyway (bit 1), so the
realistic reduction is Phase 3e's `history purge` plus the prune, or a
cheaper row (dropping the composite index would save a third; the prune can
scan).

Latency (p50 / p95 ms, process start ~163 / 224 included): import 997;
one write 209–224 / 224–270; `query` docs 204 / 242, blocks filter 194 /
228, `text("furnace")` 285 / 329, links 194 / 246; `outline` 207 / 223;
`gc` 217 — every row at or below the 3a TS run's (writes 245–293 / 265–
328): the claim writes are one `INSERT … ON CONFLICT` per minted id inside
the commit transaction and do not register against node's start.

### 17.0 (3c), TS — the self-contained pending row (`ts-2026-10-25T22-13-16`)

The same harness over the Phase 3c reference (store 17.0 + the
`pending_materializations` row that carries `head`, `prior_hash` and
`created_at` with no foreign key into the recorder's tables; the
materializer rendering from the current rows; the retention pin retired),
TS CLI, node 24; the 17.0 (3b) TS row above is the comparison.

| stage | ops | db MB | grew KB | KB / op | content | history | 3b TS (db MB / KB / op) | `pending_materializations` rows / KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.24 | 6,242 | 31.1 / doc | 3.17 | 2.70 | 6.25 / 31.1 | 0 / 8 |
| frontmatter hot update | 50 | 6.33 | 86 | 1.7 | 0 | +60 | 6.34 / 1.7 | 0 / 8 |
| block edit | 50 | 6.42 | 90 | 1.8 | 0 | +80 | 6.43 / 1.8 | 0 / 8 |
| rolling journal | 50 | 6.59 | 168 | 3.4 | +20 | +140 | 6.59 / 3.2 | 0 / 8 |
| task churn | 50 | 6.64 | 57 | 1.1 | 0 | +60 | 6.63 / 0.9 | 0 / 8 |
| link churn | 50 | 6.75 | 102 | 2.0 | +30 | +60 | 6.74 / 2.2 | 0 / 8 |
| delete / recreate | 20 | 6.87 | 127 | 6.3 | +10 | +120 | 6.87 / 6.6 | 0 / 8 |
| gc (default sweep) | | 6.88 | 8 | | 0 | 0 | 6.88 / 8 KB | 0 / 8 |

**No measurable change, as expected.** The import is **28.6× the source**
and the final database **31.5×** — the 3b numbers to the decimal; the file
is −8 KB after the import (one page), +12 KB after the task churn and equal
after the journal, the recreate and the gc. The two new columns live only
between a commit and its file write: `pending_materializations` holds 0
rows at every stage (the CLI materializes each row in the same process,
phase B′) and its 8 KB is the empty table's one page, as in every run since
14.0. `id_claims` is identical to 3b at every stage (4,608 after the
import, 5,243 at the end); the history tables are row for row the 3b run's
except the seeded churn's usual ±2 (`dispositions`/`block_changes` 3,824
vs 3,822, `tree_nodes` 1,000 vs 1,001 — the 3a run had 3,824 and 1,001
too). Nothing in this slice adds a row to a steady-state database: what it
removes is a *dependency* — the materializer, recovery and the retention
plan no longer read `revisions` to render or recognise a pending file — and
a dependency weighs nothing in `doctor --size`.

Latency (p50 / p95 ms, process start ~270 / 492 included): import 1,416;
one write 258–285 / 278–357; `query` docs 247 / 291, blocks filter 237 /
274, `text("furnace")` 337 / 361, links 232 / 248; `outline` 276 / 336;
`gc` 308. Every row sits ~50–110 ms above the 3b TS run's, and so does the
process start itself (`spawn-baseline` 270 vs 163 ms p50, 492 vs 224 p95)
— the machine, not the engine: net of the spawn the writes are 0–15 ms
over it (3b: ~60 ms), the reads the same, and the commit path gained one
`SELECT` of the pending row at the path (the supersession read) and lost a
`revisions` self-join per materialized file.

### 17.0 (3a), Rust — the twin, same harness (`rust-2026-10-25T19-55-20`)

The Rust twin of 3a (`crates/omgbase-store` at schema 17, release build of
the `omgbase` crate 0.27.3 + the working tree), the same seeded corpus; the
TS 3a row above and the 16.0 Rust row at the top of §2 are the comparisons.

| stage | ops | db MB | grew KB | KB / op | content | history | TS 3a (KB / op) | 16.0 Rust (KB / op) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 5.65 | 5,652 | 28.1 / doc | 3.17 | 2.11 | 28.0 / doc (db 5.62) | 25.6 / doc (db 5.15) |
| frontmatter hot update | 50 | 5.74 | 90 | 1.8 | 0 | +60 | 1.7 | 1.6 |
| block edit | 50 | 5.83 | 86 | 1.7 | 0 | +70 | 1.6 | 2.0 |
| rolling journal | 50 | 6.00 | 168 | 3.4 | +20 | +130 | 3.2 | 3.6 |
| task churn | 50 | 6.05 | 57 | 1.1 | 0 | +50 | 0.5 | 0.8 |
| link churn | 50 | 6.14 | 82 | 1.6 | +30 | +30 | 1.6 | 1.8 |
| delete / recreate | 20 | 6.24 | 102 | 5.1 | +10 | +100 | 5.7 | 4.1 |
| gc (default sweep) | | 6.25 | 8 | | 0 | 0 | 8 KB, nothing swept | 8 KB, nothing swept |

The two engines write the same database: import **5.65 vs 5.62 MB (25.9× vs
25.7× the source)**, the end **6.25 vs 6.18 MB (28.6× vs 28.3×)**, `content`
3.17 vs 3.15 MB and `history` 2.11 vs 2.10 MB — the 30–70 KB spread is the
harness's page-allocation noise (the 16.0 rows differed by the same amount),
and the per-operation costs match the TS 3a row within ±0.6 KB with the same
shape: the +9 % at import over 16.0 is the live bytes held twice under legacy
capture (`content` 3.17 vs 2.67 MB; `history` unchanged), delete/recreate is
the one operation that costs more (+1.0 KB/op over 16.0: the recreated rows
carry their bytes), and the sweep still reclaims nothing. The history tables
after gc are the TS 3a run's and the 16.0 run's row for row — `blobs` 0.63 MB
(3,218 rows), `tree_nodes` 0.98 MB (1,000), `dispositions` 0.35 MB +
`block_changes` 0.30 MB (3,824 each), `revisions` 0.11 MB (461), `commits`
0.16 MB (471): the recorder captures exactly what it did, and the workload
has no `docs_move`, so D11's extra revision per move does not show here.

Latency (p50 / p95 ms, process start 5 / 258 included): import 848; one write
21–24 / 26–30; `query` docs 12 / 21, blocks filter 11 / 14, `text("furnace")`
78 / 116, links 9 / 35; `outline` 8 / 10; `gc` 15. Against the 16.0 Rust run
(writes 16–20 / 19–38, docs 10 / 11, text 62 / 75, outline 7 / 10) every row
reads 2–5 ms higher at p50, the untouched read-only shapes included, so the
gap is the day's machine state rather than the engine (a first run taken
while the test suite was building read 28–33 ms per write and was discarded);
the p95s sit inside the 16.0 spread. The hot `docs_read`/`apply` paths now
read the rows without a `blobs` join or a frontmatter resolve; at these sizes
the saving is below the harness's resolution.

### 17.0 (3b), Rust — identity claims, the twin (`rust-2026-10-25T21-31-51`)

The Rust twin of 3b (`crates/omgbase-store` at schema 17 with `id_claims`,
release build of the `omgbase` crate 0.27.3 + the working tree), the same
seeded corpus; the TS 3b row above is the comparison, the Rust 3a row the
cost of the slice.

| stage | ops | db MB | grew KB | KB / op | content | history | TS 3b (KB / op) | Rust 3a (KB / op) | `id_claims` rows / KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.25 | 6,250 | 31.1 / doc | 3.18 | 2.71 | 31.1 / doc (db 6.25) | 28.1 / doc (db 5.65) | 4,608 / 580 |
| frontmatter hot update | 50 | 6.35 | 98 | 2.0 | 0 | +70 | 1.7 | 1.8 | +50 / +4 |
| block edit | 50 | 6.44 | 94 | 1.9 | 0 | +80 | 1.8 | 1.7 | +50 / +8 |
| rolling journal | 50 | 6.62 | 176 | 3.5 | +20 | +130 | 3.2 | 3.4 | +100 / +12 |
| task churn | 50 | 6.67 | 53 | 1.1 | 0 | +60 | 0.9 | 1.1 | +50 / +8 |
| link churn | 50 | 6.78 | 111 | 2.2 | +30 | +60 | 2.2 | 1.6 | +175 / +24 |
| delete / recreate | 20 | 6.90 | 115 | 5.7 | +10 | +110 | 6.6 | 5.1 | +210 / +20 |
| gc (default sweep) | | 6.91 | 8 | | 0 | 0 | 8 KB, nothing swept | 8 KB, nothing swept | 0 / 0 (no `identity.claims_retain_days`) |

The two engines write the same database again: import **6.25 vs 6.25 MB
(28.6× the source, both)**, the end **6.91 vs 6.88 MB (31.6× vs 31.5×)**,
`content` 3.18 vs 3.17 MB and `history` 2.71 vs 2.71 MB — and the
`id_claims` table is **byte-identical at every stage** (4,608 rows / 593,920 B
after the import, 5,243 / 671,744 B at the end, the same +50 / +50 / +100 /
+50 / +175 / +210 rows per workload as the TS run: the twin claims exactly the
ids the reference claims, at the same sites). Against the Rust 3a row the
slice costs **+600 KB at import (+11 %) and +660 KB at the end (+11 %)**,
which is the claims table to within page noise (580 / 656 KB) — ≈ 130 B per
id ever minted, as measured on the reference; per operation the difference to
3a is the ids an operation mints (a head +0.1–0.2 KB; link churn's edges and
external nodes +0.6; a recreate's 17 blocks + head +0.6 here, where the TS run
read +0.9 — allocation noise on a 20-op stage). Every other history table is
row for row the Rust 3a run's — `blobs` 0.63 MB (3,218), `tree_nodes` 0.97 MB
(1,000), `dispositions` 0.34 MB + `block_changes` 0.30 MB (3,824 each),
`revisions` 0.11 MB (461), `commits` 0.16 MB (471) — the TS 3b run's 3,822 /
1,001 being the seeded-churn noise its section notes; the sweep still reclaims
nothing, and `doctor --size` prints the new line as `id claims  5243 ids
claimed`.

Latency (p50 / p95 ms, process start 5 / 490 included — the p95 is one cold
spawn of ten): import 632; one write 20–23 / 26–32; `query` docs 15 / 204,
blocks filter 15 / 274, `text("furnace")` 99 / 351, links 12 / 296; `outline`
10 / 11; `gc` 16. Against the Rust 3a run (writes 21–24 / 26–30, docs 12 / 21,
text 78 / 116, outline 8 / 10, gc 15) every p50 is within 1–3 ms — the claim
writes are one cached `INSERT … ON CONFLICT` per minted id inside the commit
transaction and the `hold` one `UPDATE` per captured id, neither of which
registers at this size — while the read p95s are each a single outlier (at
n = 20 the p95 IS the max, and max equals p95 in every read row), the day's
machine state rather than the engine, as the 3a section found; the 20 ms
write p50 at the end of the run is below the 3a run's.

### 17.0 (3c), Rust — the self-contained pending row, the twin (`rust-2026-10-25T22-52-08`)

The Rust twin of 3c (`crates/omgbase-store` at schema 17 with the
`pending_materializations` row carrying `head`, `prior_hash` and `created_at`
and no foreign key into the recorder's tables; the materializer rendering
from the current rows; the retention pin retired), release build of the
`omgbase` crate 0.27.3 + the working tree, the same seeded corpus; the TS 3c
row above is the comparison, the Rust 3b row the cost of the slice.

| stage | ops | db MB | grew KB | KB / op | content | history | TS 3c (db MB / KB / op) | Rust 3b (KB / op) | `pending_materializations` rows / KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.25 | 6,250 | 31.1 / doc | 3.17 | 2.71 | 6.24 / 31.1 | 31.1 / doc (db 6.25) | 0 / 8 |
| frontmatter hot update | 50 | 6.34 | 94 | 1.9 | 0 | +60 | 6.33 / 1.7 | 2.0 | 0 / 8 |
| block edit | 50 | 6.43 | 90 | 1.8 | 0 | +80 | 6.42 / 1.8 | 1.9 | 0 / 8 |
| rolling journal | 50 | 6.61 | 172 | 3.4 | +20 | +130 | 6.59 / 3.4 | 3.5 | 0 / 8 |
| task churn | 50 | 6.66 | 53 | 1.1 | 0 | +60 | 6.64 / 1.1 | 1.1 | 0 / 8 |
| link churn | 50 | 6.77 | 115 | 2.3 | +30 | +60 | 6.75 / 2.0 | 2.2 | 0 / 8 |
| delete / recreate | 20 | 6.91 | 135 | 6.8 | +10 | +120 | 6.87 / 6.3 | 5.7 | 0 / 8 |
| gc (default sweep) | | 6.92 | 8 | | 0 | 0 | 6.88 / 8 KB | 8 KB | 0 / 8 |

Import **6.25 vs 6.24 MB (28.6× the source, both)**, the end **6.92 vs
6.88 MB (31.6× vs 31.5×)**; against the Rust 3b run the database is the same
to the page at every stage (6.25 / 6.34 / 6.43 / 6.61 / 6.66 / 6.77 / 6.91 /
6.92 vs 6.25 / 6.35 / 6.44 / 6.62 / 6.67 / 6.78 / 6.90 / 6.91). The
`pending_materializations` table holds **0 rows / 8,192 B at every stage in
both engines** (phase B′ materializes every row in the same process; the one
page is the empty table's). `id_claims` is row for row the TS 3c run's at
every stage (4,608 → 4,658 → 4,708 → 4,808 → 4,858 → 5,033 → 5,243; 593,920 B
after the import and 671,744 B at the end in both, three intermediate stages
±4,096 B — one page). The history tables after gc are row for row the TS 3c
and Rust 3b runs': `blobs` 3,218 (634,880 B vs TS 630,784), `tree_nodes`
1,000 (974,848 both), `dispositions` 3,824 (348,160 vs 339,968),
`block_changes` 3,824 (294,912 vs 303,104), `revisions` 461 (110,592 both),
`commits` 471 (159,744 both); `content` 3.23 MB and `history` 3.22 MB at the
end in both engines.

Latency (p50 / p95 ms, process start 5 / 6 included): import 777; one write
24–29 / 29–35 (frontmatter 26 / 31, block edit 26 / 34, journal 24 / 29, task
churn 24 / 31, link churn 29 / 35, recreate 25 / 33); `query` docs 13 / 16,
blocks filter 12 / 17, `text("furnace")` 101 / 180, links 10 / 14; `outline`
8 / 11; `gc` 17. Against the Rust 3b run (writes 20–23 / 26–32, import 632,
docs 15, text 99, outline 10, gc 16) the write p50s sit 2–6 ms above and every
read within 1–3 ms. A first run of the same binary in the same session
(`spawn-baseline` 266 / 580, writes 32–37 / 43–47, import 1,122, identical
sizes and rows) was discarded as machine state — the process start itself
was 260 ms slower — and is not kept under `baseline/`.

### 17.0 (3d), TS — the slim feed and the checkpoints collapse (`ts-2026-10-26T00-23-18`)

The same harness over the Phase 3d reference (store 17.0 + the core's
`feed`/`feed_entries` written in every commit transaction, the repository
epoch on `repos`, the recorder's `commits` row with `epoch`/`batch_id` and
no `checkpoint_id`, `checkpoints` collapsed into the `sync_state` status
row, `c` and `ep` claimed in `id_claims`), TS CLI, node 24; the 17.0 (3c)
TS row above is the comparison.

| stage | ops | db MB | grew KB | KB / op | content | history | sync KB | 3c TS (db MB / KB / op) | `feed` rows / KB | `feed_entries` rows / KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.34 | 6,345 | 31.6 / doc | 3.17 | 2.73 | 212 | 6.24 / 31.1 | 201 / 56 | 201 / 40 |
| frontmatter hot update | 50 | 6.46 | 119 | 2.4 | 0 | +80 | 240 | 6.33 / 1.7 | 251 / 72 | 251 / 52 |
| block edit | 50 | 6.59 | 127 | 2.5 | 0 | +90 | 268 | 6.42 / 1.8 | 301 / 92 | 301 / 60 |
| rolling journal | 50 | 6.75 | 164 | 3.3 | +20 | +130 | 284 | 6.59 / 3.4 | 351 / 100 | 351 / 68 |
| task churn | 50 | 6.85 | 98 | 2.0 | 0 | +70 | 308 | 6.64 / 1.1 | 401 / 116 | 401 / 76 |
| link churn | 50 | 6.96 | 111 | 2.2 | +20 | +70 | 324 | 6.75 / 2.0 | 451 / 128 | 451 / 80 |
| delete / recreate | 20 | 7.10 | 135 | 6.8 | +20 | +110 | 336 | 6.87 / 6.3 | 471 / 136 | 471 / 84 |
| gc (default sweep) | | 7.10 | 0 | | 0 | 0 | 336 | 6.88 / 8 KB | 471 / 136 | 471 / 84 |

**The feed costs about one slim row and one entry per commit, and nothing
else moved.** The import is **29.0× the source** (3c: 28.6×) and the final
database **32.5×** (31.5×): +100 KB after the import and +220 KB at the end,
all of it the feed and its claims. Per commit the growth is **+0.6–0.9 KB
over 3c** on the small-edit stages (frontmatter 2.4 vs 1.7 KB/op, block
edit 2.5 vs 1.8, task churn 2.0 vs 1.1, link churn 2.2 vs 2.0) — a `feed`
row (≈ 290 B with its two indexes: the `(repo, epoch, seq)` key, the UNIQUE
commit id and `idx_feed_ts`), a `feed_entries` row (≈ 180 B) and the `c`
claim the core now writes (≈ 130 B, the 3b figure per id) — and within the
seed's noise on the journal (3.3 vs 3.4) and the recreate (6.8 vs 6.3).
Table by table at the end: `feed` 471 rows / 139,264 B and `feed_entries`
471 / 86,016 B (one row and one entry per commit — every stage here commits
one document per op, so the two tables grow in lockstep; an observed batch
of *n* files writes *n* rows under one `batch_id`); `commits` 471 rows /
172,032 B vs 159,744 (the two new columns, +12 KB flat); `id_claims` 5,715
rows / 737,280 B vs 5,243 / 671,744 (+472 rows: the 471 commit ids and the
epoch, ≈ 139 B each); `sync_state` 1 row / 8,192 B — the status row — where
3c's `checkpoints` held 384 rows / 61,440 B (one per sweep, including every
read's empty pre-verb sweep: the collapse saves the row the cap would have
let grow unbounded). The `sync` category therefore doubles (336 vs 168 KB)
while `content` is identical at every stage (3.17 → 3.24 MB) and `history`
is +30–60 KB (the `commits` columns and the usual seeded ±2 rows). What the
slice removes is again a *dependency*: `changes_since`, `repos_status`,
`sync_status`, the vocabulary cache's clock and the semantic drain's
watermark read the feed, and `commits`/`revisions` are read by the history
tools alone — a dependency that weighs nothing in `doctor --size` until
Phase 4 stops writing the recorder's rows for a repository without history,
when the feed's ≈ 470 B per commit is all a commit costs.

Latency (p50 / p95 ms, process start 213 / 487 included): import 1,306;
one write 257–273 / 273–307; `query` docs 240 / 268, blocks filter 229 /
314, `text("furnace")` 329 / 361, links 227 / 261; `outline` 268 / 304;
`gc` 302. Every row is within the 3c run's spread or below it (the spawn
itself was 57 ms faster this run); the commit path gained one `INSERT` into
`feed`, one into `feed_entries`, the `c` claim and the cap's `SELECT` over
the feed, and lost the `checkpoints` insert — none of which registers.

### 17.0 (3d), Rust — the slim feed and the checkpoints collapse, the twin (`rust-2026-10-26T01-47-09`)

The Rust twin of 3d (`crates/omgbase-store` at schema 17 with the core's
`feed`/`feed_entries` written in every commit transaction, the repository
epoch on `repos`, the recorder's `commits` row with `epoch`/`batch_id` and
no `checkpoint_id`, `checkpoints` collapsed into the `sync_state` status
row, `c` and `ep` claimed in `id_claims`), release build of the `omgbase`
crate 0.27.3 + the working tree, the same seeded corpus; the TS 3d row
above is the comparison, the Rust 3c row the cost of the slice.

| stage | ops | db MB | grew KB | KB / op | content | history | sync KB | TS 3d (db MB / KB / op) | Rust 3c (db MB / KB / op) | `feed` rows / KB | `feed_entries` rows / KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.35 | 6,204 | 30.9 / doc | 3.17 | 2.72 | 212 | 6.34 / 30.8 | 6.25 / 30.4 | 201 / 56 | 201 / 40 |
| frontmatter hot update | 50 | 6.44 | 84 | 1.7 | 0 | +68 | 240 | 6.46 / 2.3 | 6.34 / 1.8 | 251 / 72 | 251 / 52 |
| block edit | 50 | 6.57 | 132 | 2.6 | 0 | +96 | 268 | 6.59 / 2.5 | 6.43 / 1.8 | 301 / 92 | 301 / 60 |
| rolling journal | 50 | 6.76 | 180 | 3.6 | +20 | +144 | 284 | 6.75 / 3.2 | 6.61 / 3.4 | 351 / 100 | 351 / 68 |
| task churn | 50 | 6.85 | 88 | 1.8 | 0 | +68 | 308 | 6.85 / 1.9 | 6.66 / 1.0 | 401 / 116 | 401 / 76 |
| link churn | 50 | 6.96 | 108 | 2.2 | +28 | +64 | 324 | 6.96 / 2.2 | 6.77 / 2.2 | 451 / 128 | 451 / 80 |
| delete / recreate | 20 | 7.09 | 128 | 6.4 | +8 | +108 | 336 | 7.10 / 6.6 | 6.91 / 6.6 | 471 / 136 | 471 / 84 |
| gc (default sweep) | | 7.09 | 0 | | 0 | 0 | 336 | 7.10 / 0 | 6.92 / 8 KB | 471 / 136 | 471 / 84 |

Import **6.35 vs 6.34 MB (29.1× the source vs 29.0×)**, the end **7.09 vs
7.10 MB (32.4× vs 32.5×)**; against the TS 3d run the database is within
8–24 KB (two to six pages) at every stage, the `sync` category identical at
every stage (212 / 240 / 268 / 284 / 308 / 324 / 336 KB) and `content` the
same to the 10 KB. **`feed` and `feed_entries` are byte-identical to the TS
run within a page at every stage**: 201 / 201 rows after the import (57,344 /
40,960 B in both engines) through 251, 301, 351, 401, 451 to **471 / 471 rows
at the end (139,264 / 86,016 B — 136 / 84 KB — in both)**, one row and one
entry per commit. `commits` is 471 rows / 172,032 B in both (the two new
columns, +12 KB over the Rust 3c run's 159,744); `id_claims` is row for row
the TS run's at every stage (4,810 → 4,910 → 5,010 → 5,160 → 5,260 → 5,485 →
5,715; +472 rows over Rust 3c's 5,243 — the 471 commit ids and the epoch;
733,184 vs TS 737,280 B, one page); **`sync_state` 1 row / 8,192 B in both
engines — the status row — where the Rust 3c run's `checkpoints` held 384
rows / 106,496 B** (one per sweep, every read's empty pre-verb sweep
included). Against Rust 3c the per-commit growth is **+0.5–0.8 KB** on the
small-edit stages (block edit 2.6 vs 1.8 KB/op, task churn 1.8 vs 1.0) and
flat on the frontmatter (1.7 vs 1.8), the journal (3.6 vs 3.4), the links
(2.2 vs 2.2) and the recreate (6.4 vs 6.6) — the `feed` row, the entry and
the `c` claim, within the seed's noise. The history tables after gc are row
for row the TS 3d run's: `blobs` 3,218 (634,880 B vs TS 630,784),
`tree_nodes` 1,000 (974,848 both), `dispositions` 3,824 (339,968 both),
`block_changes` 3,824 (294,912 vs 290,816), `revisions` 461 (110,592 both),
`commits` 471 (172,032 both); `content` 3.24 MB and `history` 3.28 MB at the
end in both engines.

Latency (p50 / p95 ms, process start 5 / 7 included): import 1,113; one
write 26–32 / 33–44 (frontmatter 26 / 33, block edit 31 / 35, journal 30 /
37, task churn 31 / 37, link churn 32 / 38, recreate 29 / 44); `query` docs
18 / 28, blocks filter 16 / 22, `text("furnace")` 88 / 111, links 14 / 17;
`outline` 14 / 16; `gc` 28. Against the Rust 3c run (writes 24–29 / 29–35,
import 777, docs 13, text 101, outline 8, gc 17) the write p50s sit 2–6 ms
above and the reads 4–6 ms above — the run followed a full workspace test
pass and a release build on the same machine, and the spread is the same
size as the 3b → 3c one; the commit path gained one `INSERT` into `feed`,
one into `feed_entries`, the `c` claim and the cap's `SELECT` over the feed,
and lost the `checkpoints` insert.

### 17.0 (3e-i), TS — open-only edges, the D9 drops, the six categories (`ts-2026-10-26T03-14-33`)

The same harness over the Phase 3e-i reference (store 17.0 with `edges` as the
open set — a closed edge deletes its row and the recorder keeps the interval
in the history bundle's `edge_transitions` — `properties` without its two
commit columns, `collections` and `inferred_edges` dropped, the three DDL
files, the six size categories), TS CLI, node 24; the 17.0 (3d) TS row above
is the comparison. The report now has six categories, so the table below
carries `identity` and `recovery` beside the four; against the 3d rows,
`identity + recovery + history` here is what `history` was there.

| stage | ops | db MB | grew KB | KB / op | content | identity | recovery | history | sync KB | 3d TS (db MB / KB / op) | `edges` rows / KB | `edge_transitions` rows / KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.43 | 6,435 | 32.0 / doc | 3.10 | 0.63 | 0.01 | 2.25 | 212 | 6.34 / 31.6 | 800 / 164 | 800 / 132 |
| frontmatter hot update | 50 | 6.55 | 119 | 2.4 | 3.11 | 0.64 | 0.01 | 2.31 | 240 | 6.46 / 2.4 | 800 / 164 | 800 / 132 |
| block edit | 50 | 6.68 | 127 | 2.5 | 3.11 | 0.66 | 0.01 | 2.38 | 268 | 6.59 / 2.5 | 800 / 164 | 800 / 132 |
| rolling journal | 50 | 6.87 | 188 | 3.8 | 3.14 | 0.67 | 0.01 | 2.51 | 284 | 6.75 / 3.3 | 800 / 164 | 800 / 132 |
| task churn | 50 | 6.94 | 74 | 1.5 | 3.14 | 0.68 | 0.01 | 2.56 | 308 | 6.85 / 2.0 | 800 / 164 | 800 / 132 |
| link churn | 50 | 7.06 | 115 | 2.3 | 3.15 | 0.72 | 0.01 | 2.61 | 324 | 6.96 / 2.2 | 800 / 168 | 950 / 156 |
| delete / recreate | 20 | 7.18 | 123 | 6.1 | 3.15 | 0.74 | 0.01 | 2.70 | 336 | 7.10 / 6.8 | 803 / 168 | 955 / 156 |
| gc (default sweep) | | 7.18 | 0 | | 3.15 | 0.74 | 0.01 | 2.70 | 336 | 7.10 / 8 KB | 803 / 168 | 955 / 156 |

**The current state got smaller; the history bundle took the intervals.**
`content` is **3.10 → 3.15 MB (3d: 3.17 → 3.24)** — 70–90 KB less at every
stage: `edges` 196,608 → 167,936 B at import (two columns and
`idx_edges_temporal` gone, 800 rows both) and 221,184 → 172,032 B at the end
(**955 → 803 rows**: the 152 rows link churn and the recreate closed are
deleted now, not kept), `properties` 442,368 → 421,888 B (the two commit
columns and the four partial predicates), `collections` and `inferred_edges`
(8,192 B each, 0 rows) gone. The `history` category is **2.25 → 2.70 MB**
where 3d's was 2.73 → 3.28 — the 0.63–0.74 MB of `id_claims` and the one
page of `resurrection_pool`/`pending_materializations` now file under
`identity`/`recovery`, and `edge_transitions` adds 135,168 B (800 rows) at
import and 159,744 B (955 rows) at the end — the interval record that used
to sit inside `edges`. Summed, `identity + recovery + history` is 2.89 →
3.45 MB against 3d's `history` 2.73 → 3.28: **+160 KB**, which is
`edge_transitions` itself (the rows exist twice while an edge is open — the
open row in the core table and its transition in the recorder's — the same
"stored twice under legacy capture" shape as the block bytes since 3a) minus
the 30 KB the closed rows no longer occupy in `edges`. The whole database
is 6.43 vs 6.34 MB at import (29.4× vs 29.0×) and 7.18 vs 7.10 MB at the end
(32.8× vs 32.5×): +90 / +80 KB, all `edge_transitions`. Per operation
nothing moved beyond the seed's noise (frontmatter 2.4 = 2.4, block edit
2.5 = 2.5, link churn 2.3 vs 2.2, task churn 1.5 vs 2.0, journal 3.8 vs 3.3,
recreate 6.1 vs 6.8): a link edit that used to UPDATE a `to_commit` and
INSERT a row now DELETEs a row and INSERTs one in `edges` plus one INSERT
and one UPDATE in `edge_transitions`. `identity` grows 0.63 → 0.74 MB
exactly as `id_claims` did in 3d (4,810 → 5,715 rows); `sync` is identical
(212 → 336 KB); `search` identical. What the slice removes is again a
*dependency*: no reader of `edges` filters an interval, `has_anchor()`
included, and when Phase 4 stops writing the recorder's rows for a
repository without history, `edge_transitions` is 156 KB this database
will not carry.

Latency (p50 / p95 ms, process start 262 / 320 included): import 1,365; one
write 209–247 / 228–259; `query` docs 205 / 275, blocks filter 202 / 367,
`text("furnace")` 282 / 350, links 202 / 267; `outline` 183 / 213; `gc` 210.
Every write is 25–60 ms *faster* than the 3d run at p50 (the spawn was 49 ms
slower, so the engine's share dropped more) — the edge indexes lost their
partial predicates and the readers their `to_commit IS NULL` clause, and the
links query (`_dst_path == …`) no longer carries the interval filter; the
difference is within what two runs on one laptop show, and nothing got
slower.

### 17.0 (3e-i), Rust — open-only edges, the D9 drops, the six categories, the twin (`rust-2026-10-26T04-20-11`)

The Rust twin of 3e-i (`crates/omgbase-store` with `edges` as the open set —
a closed edge deletes its row and the recorder's `edge_transitions` keeps the
interval — `properties` without its two commit columns, `collections` and
`inferred_edges` dropped, the three DDL files executed on open, the six size
categories; `omgbase-graph` 3.0), release build of the `omgbase` crate 0.27.3
+ the working tree, the same seeded corpus; the TS 3e-i row above is the
comparison, the Rust 3d row the cost of the slice.

| stage | ops | db MB | grew KB | KB / op | content | identity | recovery | history | sync KB | TS 3e-i (db MB / KB / op) | Rust 3d (db MB / KB / op) | `edges` rows / KB | `edge_transitions` rows / KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.44 | 6,438 | 32.0 / doc | 3.11 | 0.63 | 0.01 | 2.24 | 212 | 6.43 / 32.0 | 6.35 / 31.6 | 800 / 164 | 800 / 132 |
| frontmatter hot update | 50 | 6.55 | 106 | 2.1 | 3.11 | 0.65 | 0.01 | 2.30 | 240 | 6.55 / 2.4 | 6.44 / 1.7 | 800 / 164 | 800 / 132 |
| block edit | 50 | 6.67 | 126 | 2.5 | 3.11 | 0.66 | 0.01 | 2.38 | 268 | 6.68 / 2.5 | 6.57 / 2.7 | 800 / 164 | 800 / 132 |
| rolling journal | 50 | 6.84 | 167 | 3.4 | 3.13 | 0.68 | 0.01 | 2.50 | 284 | 6.87 / 3.8 | 6.76 / 3.7 | 800 / 164 | 800 / 132 |
| task churn | 50 | 6.92 | 77 | 1.6 | 3.13 | 0.69 | 0.01 | 2.54 | 308 | 6.94 / 1.5 | 6.85 / 1.8 | 800 / 164 | 800 / 132 |
| link churn | 50 | 7.03 | 114 | 2.3 | 3.13 | 0.72 | 0.01 | 2.60 | 324 | 7.06 / 2.3 | 6.96 / 2.2 | 803 / 164 | 925 / 152 |
| delete / recreate | 20 | 7.18 | 147 | 7.4 | 3.14 | 0.75 | 0.01 | 2.71 | 336 | 7.18 / 6.1 | 7.09 / 6.6 | 803 / 164 | 955 / 156 |
| gc (default sweep) | | 7.18 | 0 | | 3.14 | 0.75 | 0.01 | 2.71 | 336 | 7.18 / 0 | 7.09 / 0 | 803 / 164 | 955 / 156 |

Import **6.44 vs 6.43 MB (29.5× the source vs 29.4×)**, the end **7.18 vs
7.18 MB (32.8× in both)** — 7,180,288 B in both engines; against the TS 3e-i
run the database is within 4–29 KB (one to seven pages) at every stage, the
`sync` category identical at every stage (212 / 240 / 268 / 284 / 308 / 324
/ 336 KB), `content` within 4–12 KB, `identity` within 4 KB, `history` within
4–12 KB. **`edges` and `edge_transitions` are row for row the TS run's at
every stage**: 800 / 800 rows after the import (167,936 / 135,168 B in both
engines), 800 / 800 through the frontmatter, block, journal and task stages,
803 / 925 after link churn (the 125 edges the churn closed are deleted from
`edges` and kept as closed transitions), **803 / 955 at the end** (167,936 /
159,744 B here, 172,032 / 159,744 B in TS — one page on `edges`); against
Rust 3d's `edges` 196,608 B / 800 rows at import and 221,184 B / 955 rows at
the end, the core table lost the two interval columns, `idx_edges_temporal`
and the 152 closed rows. `properties` is 421,888 B / 1,606 rows in both
engines (Rust 3d: 438,272 — the two commit columns and the four partial
predicates); `collections` and `inferred_edges` are gone from the table list
(Rust 3d: 8,192 B each). The history tables after gc are row for row the TS
run's: `blobs` 3,218 (634,880 vs 630,784 B), `tree_nodes` 1,000 (974,848 vs
978,944), `dispositions` 3,824 (348,160 vs 339,968), `block_changes` 3,824
(299,008 vs 294,912), `revisions` 461 (110,592 both), `commits` 471 (172,032
both), `edge_transitions` 955 (159,744 both); `id_claims` 5,715 (737,280 vs
733,184 — one page) growing 4,810 → 4,910 → 5,010 → 5,160 → 5,260 → 5,485 →
5,715 exactly as the TS run's; `feed` 471 / 139,264 B and `feed_entries` 471
/ 86,016 B in both; `sync_state` 1 row. `content` 3.11 → 3.14 MB (3d: 3.17 →
3.24), `history` 2.24 → 2.71 (3d: 2.73 → 3.28, with `id_claims`, the pool
and the pending row now under `identity`/`recovery`) — the same shape the TS
section above describes. Per operation nothing moved beyond the seed's noise
(frontmatter 2.1 vs 3d's 1.7, block edit 2.5 vs 2.7, journal 3.4 vs 3.7,
task churn 1.6 vs 1.8, link churn 2.3 vs 2.2, recreate 7.4 vs 6.6).

Latency (p50 / p95 ms, process start 5 / 257 included — one slow spawn):
import 979; one write 21–24 / 28–34 (frontmatter 24 / 31, block edit 24 /
30, journal 23 / 28, task churn 23 / 30, link churn 23 / 31, recreate 21 /
34); `query` docs 13 / 20, blocks filter 12 / 16, `text("furnace")` 70 / 92,
links 10 / 12; `outline` 8 / 10; `gc` 16. Against the Rust 3d run (writes
26–32 / 33–44, import 1,113, docs 18, text 88, links 14, outline 14, gc 28)
every write is 2–9 ms faster at p50 and every read 4–18 ms — the edge
indexes lost their partial predicates, the readers their `to_commit IS NULL`
clause, the links query its interval filter — within what two runs on one
laptop show, and nothing got slower. A first run of this harness
(`rust-2026-10-26T04-14-51`, not recorded) came out with `dispositions`
3,822 / `tree_nodes` 1,001 — two verdicts fewer at the task-churn stage, one
extra tree node after it — while every edge figure matched; the re-run
recorded here reproduces TS's 3,824 / 1,000 row for row, so the first run's
gap was the harness's own (its spawn p95 was 525 ms), not the slice's.

### 17.0 (3e-ii), TS — the capability manifest and the alert channel (`ts-2026-10-26T05-20-26`)

The same harness over the Phase 3e-ii reference (store 17.0 with the two new
core tables — the per-repository `capabilities` manifest and the `alerts`
channel — the `writer_requires` check as step 0 of every write, the alert
channel re-derived on every read of it), TS CLI, node 24; the 17.0 (3e-i) TS
row above is the comparison. Nothing in the workload raises an alert and
nothing flips the manifest, so the slice's whole footprint is two tables of
one page each.

| stage | ops | db MB | grew KB | KB / op | content | identity | recovery | history | sync KB | 3e-i TS (db MB / KB / op / sync KB) | `capabilities` rows / KB | `alerts` rows / KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.47 | 6,468 | 32.2 / doc | 3.12 | 0.63 | 0.01 | 2.24 | 232 | 6.43 / 32.0 / 212 | 2 / 8 | 0 / 8 |
| frontmatter hot update | 50 | 6.58 | 115 | 2.3 | 3.13 | 0.64 | 0.01 | 2.30 | 260 | 6.55 / 2.4 / 240 | 2 / 8 | 0 / 8 |
| block edit | 50 | 6.70 | 119 | 2.4 | 3.13 | 0.66 | 0.01 | 2.37 | 288 | 6.68 / 2.5 / 268 | 2 / 8 | 0 / 8 |
| rolling journal | 50 | 6.89 | 184 | 3.7 | 3.15 | 0.68 | 0.01 | 2.50 | 304 | 6.87 / 3.8 / 284 | 2 / 8 | 0 / 8 |
| task churn | 50 | 6.97 | 82 | 1.6 | 3.15 | 0.69 | 0.01 | 2.55 | 328 | 6.94 / 1.5 / 308 | 2 / 8 | 0 / 8 |
| link churn | 50 | 7.08 | 111 | 2.2 | 3.15 | 0.72 | 0.01 | 2.61 | 344 | 7.06 / 2.3 / 324 | 2 / 8 | 0 / 8 |
| delete / recreate | 20 | 7.22 | 139 | 7.0 | 3.15 | 0.75 | 0.01 | 2.70 | 356 | 7.18 / 6.1 / 336 | 2 / 8 | 0 / 8 |
| gc (default sweep) | | 7.22 | 0 | | 3.15 | 0.75 | 0.01 | 2.70 | 356 | 7.18 / 8 KB / 336 | 2 / 8 | 0 / 8 |

**Two tiny tables, as expected.** `capabilities` holds its two rows (the
repository's `history` row, `enabled` from the import's clock with
`writer_requires = 1`, and its `semantic` row, `disabled` — `init
--no-embedder`) in one 8,192 B page at every stage; `alerts` holds no row and
its one page. The `sync` category is **+20 KB at every stage** (212 → 232 KB
at import, 336 → 356 KB at the end): the two tables' 16 KB plus the schema
page their DDL pushed `sqlite_schema` over. Every other category is the
3e-i run's to within the seed's noise — `content` 3.12 → 3.15 MB (3e-i 3.10
→ 3.15), `identity` 0.63 → 0.75 (0.63 → 0.74; `id_claims` 4,810 → 5,715
rows, as before), `recovery` one page, `history` 2.24 → 2.70 (2.25 → 2.70;
`blobs` 3,218, `tree_nodes` 1,000, `dispositions`/`block_changes` 3,824,
`revisions` 461, `commits` 471, `edge_transitions` 955 — row for row the
3e-i figures), `search` 0.23–0.24 MB; `edges` 800 → 803 rows, `feed` /
`feed_entries` 471 each. The database is **6.47 vs 6.43 MB at import (29.6×
the source vs 29.4×) and 7.22 vs 7.18 MB at the end (33.0× vs 32.8×)**:
+40 KB, the two pages and the schema page plus one page of noise. Per
operation nothing moved (frontmatter 2.3 vs 2.4, block edit 2.4 vs 2.5,
journal 3.7 vs 3.8, task churn 1.6 vs 1.5, link churn 2.2 vs 2.3, recreate
7.0 vs 6.1 — the recreate stage is the noisiest in every run): the
`writer_requires` check is one indexed read of the manifest and one no-op
`UPDATE` of a channel with no active row per write, and the channel's
re-derivation on a read is one aggregate over an empty
`pending_materializations`.

Latency (p50 / p95 ms, process start 165 / 203 included): import 1,069; one
write 231–264 / 245–281 (frontmatter 231 / 245, block edit 259 / 273,
journal 264 / 281, task churn 259 / 379, link churn 254 / 270, recreate 258
/ 273); `query` docs 236 / 312, blocks filter 226 / 342, `text("furnace")`
329 / 476, links 223 / 284; `outline` 219 / 268; `gc` 241. Against the
3e-i run (writes 209–247 / 228–259, import 1,365, spawn 262 / 320) every
write is 20–50 ms slower at p50 while the spawn is 100 ms faster — the two
runs did not share a machine state (this one ran alongside a fixture
regeneration's tail), and the engine's own share — a write minus the spawn
— is 66–99 ms here against 3e-i's −53 to −15 ms by the same subtraction,
which says the spawn-baseline, not the write, moved; the reads (docs 236 vs
205, text 329 vs 282) show the same offset. Nothing in the slice touches a
read path beyond the one aggregate per MCP result (the CLI's alert line
reads the channel once after the verb). Re-measure the two side by side
before reading anything into the 20–50 ms.

### 17.0 (3e-ii), Rust — the capability manifest and the alert channel, the twin (`rust-2026-10-26T06-34-57`)

The Rust twin of 3e-ii (`crates/omgbase-store` with the two new core tables —
the per-repository `capabilities` manifest written at `create_repo` and by
migration 17 step (13), the `alerts` channel re-derived on every read of it —
`require_writer` as step 0 of every write, the alert line after every CLI
verb), release build of the `omgbase` crate 0.27.3 + the working tree, the
same seeded corpus; the TS 3e-ii row above is the comparison, the Rust 3e-i
row the cost of the slice. Nothing in the workload raises an alert and
nothing flips the manifest.

| stage | ops | db MB | grew KB | KB / op | content | identity | recovery | history | sync KB | TS 3e-ii (db MB / KB / op / sync KB) | Rust 3e-i (db MB / KB / op / sync KB) | `capabilities` rows / KB | `alerts` rows / KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.45 | 6,447 | 32.1 / doc | 3.10 | 0.63 | 0.01 | 2.24 | 232 | 6.47 / 32.2 / 232 | 6.44 / 32.0 / 212 | 2 / 8 | 0 / 8 |
| frontmatter hot update | 50 | 6.56 | 111 | 2.2 | 3.10 | 0.64 | 0.01 | 2.30 | 260 | 6.58 / 2.3 / 260 | 6.55 / 2.1 / 240 | 2 / 8 | 0 / 8 |
| block edit | 50 | 6.67 | 115 | 2.3 | 3.10 | 0.66 | 0.01 | 2.37 | 288 | 6.70 / 2.4 / 288 | 6.67 / 2.5 / 268 | 2 / 8 | 0 / 8 |
| rolling journal | 50 | 6.86 | 188 | 3.8 | 3.13 | 0.67 | 0.01 | 2.50 | 304 | 6.89 / 3.7 / 304 | 6.84 / 3.4 / 284 | 2 / 8 | 0 / 8 |
| task churn | 50 | 6.94 | 82 | 1.6 | 3.13 | 0.68 | 0.01 | 2.55 | 328 | 6.97 / 1.6 / 328 | 6.92 / 1.6 / 308 | 2 / 8 | 0 / 8 |
| link churn | 50 | 7.05 | 111 | 2.2 | 3.13 | 0.72 | 0.01 | 2.61 | 344 | 7.08 / 2.2 / 344 | 7.03 / 2.3 / 324 | 2 / 8 | 0 / 8 |
| delete / recreate | 20 | 7.19 | 135 | 6.8 | 3.14 | 0.75 | 0.01 | 2.70 | 356 | 7.22 / 7.0 / 356 | 7.18 / 7.4 / 336 | 2 / 8 | 0 / 8 |
| gc (default sweep) | | 7.19 | 0 | | 3.14 | 0.75 | 0.01 | 2.70 | 356 | 7.22 / 0 KB / 356 | 7.18 / 0 KB / 336 | 2 / 8 | 0 / 8 |

**The same two pages.** `capabilities` holds its two rows (the repository's
`history` row, `enabled` from the import's clock with `writer_requires = 1`,
and its `semantic` row, `disabled` — `init --no-embedder`) in one 8,192 B
page at every stage; `alerts` holds no row and its one page — 8,192 / 8,192 B
in both engines. The `sync` category is **identical to the TS 3e-ii run at
every stage** (232 / 260 / 288 / 304 / 328 / 344 / 356 KB) and **+20 KB over
Rust 3e-i at every stage** (212 → 232 at import, 336 → 356 at the end): the
two tables' 16 KB plus the schema page their DDL pushed `sqlite_schema` over
(24,576 → 28,672 B, 92 → 96 rows — the same 96 rows TS reports). The
database is **6.45 vs 6.47 MB at import (29.5× the source vs 29.6×) and 7.19
vs 7.22 MB at the end (32.9× vs 33.0×)** — 20–28 KB (five to seven pages)
under TS at every stage, on the content and search pages as in every earlier
round (`blocks` 1,835,008 vs 1,851,392 B and `blocks_fts` 122,880 vs 131,072
B at import; `properties`, `edges`, `doc_edges`, `docs` byte-identical) — and
8–24 KB over Rust 3e-i (6,438,912 → 6,447,104 B at import, 7,180,288 →
7,188,480 at the end: the two pages, the schema page, the rest the seed's
noise). Every other category is row for row the TS run's: `content` 3.10 →
3.14 MB (TS 3.12 → 3.15), `identity` 0.63 → 0.75 (0.63 → 0.75; `id_claims`
4,810 → 4,910 → 5,010 → 5,160 → 5,260 → 5,485 → 5,715 rows, the TS sequence
exactly, 737,280 vs 741,376 B at the end), `recovery` one page, `history`
2.24 → 2.70 (2.24 → 2.70) with the tables after gc row for row — `blobs`
3,218 (634,880 vs 630,784 B), `tree_nodes` 1,000 (974,848 both),
`dispositions` 3,824 (335,872 vs 344,064), `block_changes` 3,824 (299,008 vs
294,912), `revisions` 461 (110,592 both), `commits` 471 (172,032 both),
`edge_transitions` 800 → 925 → 955 (163,840 both) — `edges` 800 → 803
(172,032 both), `feed` / `feed_entries` 471 each (139,264 / 86,016 both),
`search` 0.23–0.24 MB. Per operation nothing moved beyond the seed's noise
(frontmatter 2.2 vs TS 2.3 vs Rust 3e-i 2.1, block edit 2.3 / 2.4 / 2.5,
journal 3.8 / 3.7 / 3.4, task churn 1.6 / 1.6 / 1.6, link churn 2.2 / 2.2 /
2.3, recreate 6.8 / 7.0 / 7.4).

Latency (p50 / p95 ms, process start 6 / 8 included): import 876; one write
24–27 / 29–38 (frontmatter 27 / 31, block edit 27 / 33, journal 24 / 29, task
churn 25 / 31, link churn 25 / 31, recreate 24 / 38); `query` docs 14 / 15,
blocks filter 13 / 16, `text("furnace")` 81 / 145, links 11 / 12; `outline`
11 / 18; `gc` 21. Against the Rust 3e-i run (writes 21–24 / 28–34, import
979, docs 13, blocks filter 12, text 70 / 92, links 10, outline 8, gc 16)
every write is 1–3 ms slower at p50 and every read 1–3 ms: what the slice
adds to a CLI run is one indexed read of the manifest and one no-op `UPDATE`
of the empty channel per write (`require_writer`), and one aggregate over the
empty `pending_materializations` after every verb (the alert line) — the
text p95 (145 vs 92) is one slow sample of twenty. Against the TS 3e-ii run
the picture is the one every round shows (writes 231–264 / 245–281 there,
spawn 165 / 203).

### 17.0 (release prep), TS — `idx_claims_repo_prefix` dropped, cursor 0 expires on a pruned feed (`ts-2026-10-26T07-17-32`)

The same harness over the release-prep reference (store 17.0 without the
`(repo_id, prefix, minted_at)` index on `id_claims`; `changes_since` expiring
cursor 0 on a feed pruned to `oldest ≥ 2` — nothing in the workload reads the
feed, so the second decision has no footprint here), TS CLI, node 24; the
17.0 (3e-ii) TS row above (`ts-2026-10-26T05-20-26`) is the comparison.

| stage | ops | db MB | grew KB | KB / op | content | identity | recovery | history | sync KB | 3e-ii TS (db MB / KB / op / identity MB) | `id_claims` rows / B (B per row) | 3e-ii TS `id_claims` B (B per row) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.17 | 6,024 | 30.0 / doc | 3.09 | 0.38 | 0.01 | 2.23 | 232 | 6.47 / 31.4 / 0.63 | 4,810 / 368,640 (76.6) | 618,496 (128.6) |
| frontmatter hot update | 50 | 6.28 | 104 | 2.1 | 3.10 | 0.39 | 0.01 | 2.29 | 260 | 6.58 / 2.2 / 0.64 | 4,910 / 376,832 (76.7) | 634,880 (129.3) |
| block edit | 50 | 6.41 | 128 | 2.6 | 3.10 | 0.40 | 0.01 | 2.37 | 288 | 6.70 / 2.3 / 0.66 | 5,010 / 389,120 (77.7) | 651,264 (130.0) |
| rolling journal | 50 | 6.58 | 168 | 3.4 | 3.12 | 0.41 | 0.01 | 2.49 | 304 | 6.89 / 3.6 / 0.68 | 5,160 / 401,408 (77.8) | 667,648 (129.4) |
| task churn | 50 | 6.66 | 80 | 1.6 | 3.12 | 0.41 | 0.01 | 2.55 | 328 | 6.97 / 1.6 / 0.69 | 5,260 / 405,504 (77.1) | 679,936 (129.3) |
| link churn | 50 | 6.75 | 92 | 1.8 | 3.12 | 0.43 | 0.01 | 2.60 | 344 | 7.08 / 2.2 / 0.72 | 5,485 / 421,888 (76.9) | 716,800 (130.7) |
| delete / recreate | 20 | 6.88 | 124 | 6.2 | 3.13 | 0.45 | 0.01 | 2.70 | 356 | 7.22 / 6.8 / 0.75 | 5,715 / 446,464 (78.1) | 741,376 (129.7) |
| gc (default sweep) | | 6.88 | 0 | | 3.13 | 0.45 | 0.01 | 2.70 | 356 | 7.22 / 0 KB / 0.75 | 5,715 / 446,464 (78.1) | 741,376 (129.7) |

**`id_claims` lost 40 % of its bytes at every row count — 51–52 B per
id.** 618,496 → 368,640 B at import (4,810 rows: 128.6 → 76.6 B per row,
−249,856 B) and 741,376 → 446,464 B at the end (5,715 rows: 129.7 → 78.1
B per row, −294,912 B); the table's bytes grow 15.7 KB per 100 new ids
where 3e-ii's grew 26.3 KB. What remains is the row and its primary key
(`id` is `TEXT PRIMARY KEY`, so the key is its own B-tree): the ≈ 130 B the
3b note measured split roughly 78 / 52 between the two, not 65 / 65 — the
index carried `repo_id` + `prefix` + `minted_at` + the rowid, the primary
key the 9-byte id alone. The `identity` category follows (0.63 → 0.38 MB at
import, 0.75 → 0.45 MB at the end), the database is **6.17 vs 6.47 MB at
import (28.2× the source vs 29.6×) and 6.88 vs 7.22 MB at the end (31.5× vs
33.0×)** — −292 KB and −328 KB, the index's pages. `sqlite_schema` has 95
rows (96), still 28,672 B — the `sync` category is byte-identical to 3e-ii
at every stage (232 → 356 KB). Every other category is the 3e-ii run's to
within the seed's noise: `content` 3.09 → 3.13 MB (3.12 → 3.15), `history`
2.23 → 2.70 (2.24 → 2.70; `blobs` 3,218, `tree_nodes` 1,001 vs 1,000,
`dispositions` / `block_changes` 3,822 vs 3,824, `revisions` 461, `commits`
471, `edge_transitions` 955 — the two-row difference in the matcher's
projection is the delete/recreate stage's and not this round's: nothing
here touches a commit), `search` 0.23 MB, `edges` 803, `feed` /
`feed_entries` 471 each. Per operation: frontmatter 2.1 vs 2.2, block edit
2.6 vs 2.3, journal 3.4 vs 3.6, task churn 1.6 vs 1.6, link churn 1.8 vs
2.2, recreate 6.2 vs 6.8 — every write that mints ids (the journal, the
link churn, the recreate) is 0.2–0.6 KB cheaper, the index's share of its
claims; the block edit's +0.3 is one page.

Latency (p50 / p95 ms, process start 339 / 672 included): import 2,037; one
write 346–407 / 390–446 (frontmatter 400 / 444, block edit 407 / 446,
journal 399 / 443, task churn 346 / 397, link churn 356 / 396, recreate 352
/ 390); `query` docs 311 / 354, blocks filter 301 / 315, `text("furnace")`
417 / 485, links 300 / 325; `outline` 287 / 316; `gc` 320. The re-measure
the 3e-ii section asked for says what it suspected: the spawn-baseline
moved again — 339 / 672 against 3e-ii's 165 / 203 and 3e-i's 262 / 320 —
and every row moved with it (writes +115 to +150 ms at p50, reads +75 to
+90). A write minus the spawn is 7–68 ms here (frontmatter 61, block edit
68, journal 60, task churn 7, link churn 17, recreate 13) against 3e-ii's
66–99 ms by the same subtraction: the engine's own share did not grow. The
TS latency column of this harness measures node's start on the machine of
the day; compare the Rust rows below for the engine.

### 17.0 (release prep), Rust — the twin, same harness (`rust-2026-10-26T07-21-00`)

The Rust twin of the release-prep round (`crates/omgbase-store` without
`idx_claims_repo_prefix`, migration 17 dropping it at both entry points;
`changes_since` expiring cursor 0 on a pruned feed), release build of the
`omgbase` crate 0.27.3 + the working tree, the same seeded corpus; the TS
release-prep row above is the comparison, the Rust 3e-ii row
(`rust-2026-10-26T06-34-57`) the cost of the round.

| stage | ops | db MB | grew KB | KB / op | content | identity | recovery | history | sync KB | TS rp (db MB / KB / op / identity MB) | Rust 3e-ii (db MB / KB / op / identity MB) | `id_claims` rows / B (B per row) | Rust 3e-ii `id_claims` B (B per row) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.21 | 6,060 | 30.1 / doc | 3.11 | 0.38 | 0.01 | 2.24 | 232 | 6.17 / 30.0 / 0.38 | 6.45 / 31.3 / 0.63 | 4,810 / 372,736 (77.5) | 622,592 (129.4) |
| frontmatter hot update | 50 | 6.31 | 100 | 2.0 | 3.11 | 0.39 | 0.01 | 2.29 | 260 | 6.28 / 2.1 / 0.39 | 6.56 / 2.2 / 0.64 | 4,910 / 376,832 (76.7) | 634,880 (129.3) |
| block edit | 50 | 6.43 | 116 | 2.3 | 3.11 | 0.39 | 0.01 | 2.37 | 288 | 6.41 / 2.6 / 0.40 | 6.67 / 2.2 / 0.66 | 5,010 / 385,024 (76.9) | 651,264 (130.0) |
| rolling journal | 50 | 6.62 | 192 | 3.8 | 3.14 | 0.41 | 0.01 | 2.50 | 304 | 6.58 / 3.4 / 0.41 | 6.86 / 3.7 / 0.67 | 5,160 / 405,504 (78.6) | 663,552 (128.6) |
| task churn | 50 | 6.69 | 64 | 1.3 | 3.14 | 0.42 | 0.01 | 2.55 | 328 | 6.66 / 1.6 / 0.41 | 6.94 / 1.6 / 0.68 | 5,260 / 409,600 (77.9) | 675,840 (128.5) |
| link churn | 50 | 6.78 | 88 | 1.8 | 3.14 | 0.43 | 0.01 | 2.61 | 344 | 6.75 / 1.8 / 0.43 | 7.05 / 2.2 / 0.72 | 5,485 / 425,984 (77.7) | 708,608 (129.2) |
| delete / recreate | 20 | 6.90 | 120 | 6.0 | 3.15 | 0.45 | 0.01 | 2.69 | 356 | 6.88 / 6.2 / 0.45 | 7.19 / 6.6 / 0.75 | 5,715 / 442,368 (77.4) | 737,280 (129.0) |
| gc (default sweep) | | 6.90 | 0 | | 3.15 | 0.45 | 0.01 | 2.69 | 356 | 6.88 / 0 KB / 0.45 | 7.19 / 0 KB / 0.75 | 5,715 / 442,368 (77.4) | 737,280 (129.0) |

**The same 40 %, row for row.** `id_claims` is 4,810 → 4,910 → 5,010 →
5,160 → 5,260 → 5,485 → 5,715 rows in both engines — the TS sequence
exactly, as in every round — at 372,736 → 442,368 B here against the TS
run's 368,640 → 446,464 (one 4,096 B page apart at either end, the
direction flipping with the page split) and the Rust 3e-ii run's 622,592 →
737,280: −249,856 B at import and −294,912 B at the end, the TS deltas to
the byte. Per row 77.5 → 77.4 B against 129.4 → 129.0. `identity` 0.38 →
0.45 MB (TS 0.38 → 0.45; Rust 3e-ii 0.63 → 0.75); `sqlite_schema` 95 rows
(96), 28,672 B; the `sync` category byte-identical to both comparison runs
at every stage (232 / 260 / 288 / 304 / 328 / 344 / 356 KB). The database
is **6.21 vs 6.17 MB at import (28.4× the source vs 28.2×) and 6.90 vs 6.88
MB at the end (31.6× vs 31.5×)** — 36 KB over TS at import and 20 KB at the
end, where every earlier round had Rust 20–28 KB under: the content and
search pages fell the other way this time (`blocks` 1,880,064 vs 1,867,776
B at the end, `blocks_fts` 131,072 vs 126,976; `tree_nodes` 970,752 vs
974,848, `edge_transitions` 159,744 vs 155,648 — a page each, the seed's
noise) — and 242 KB / 287 KB under Rust 3e-ii (6,447,104 → 6,205,440 B at
import, 7,188,480 → 6,901,760 at the end): the index's pages. Every other
table is row for row the TS run's after gc — `blobs` 3,218 (634,880 vs
630,784 B), `tree_nodes` 1,000 vs the TS run's 1,001, `dispositions` /
`block_changes` 3,824 vs 3,822 (the recreate stage's two rows, above; the
Rust counts are the 3e-ii counts of both engines), `revisions` 461,
`commits` 471 (172,032 both), `edge_transitions` 955, `edges` 803 (167,936
both), `feed` / `feed_entries` 471 each (139,264 / 86,016 both). Per
operation: frontmatter 2.0 (TS 2.1, Rust 3e-ii 2.2), block edit 2.3 (2.6 /
2.2), journal 3.8 (3.4 / 3.7), task churn 1.3 (1.6 / 1.6), link churn 1.8
(1.8 / 2.2), recreate 6.0 (6.2 / 6.6).

Latency (p50 / p95 ms, process start 7 / 549 included — the p95 is the one
cold first spawn of ten): import 778; one write 22–31 / 25–41 (frontmatter
23 / 25, block edit 31 / 41, journal 24 / 29, task churn 22 / 29, link churn
30 / 38, recreate 24 / 36); `query` docs 20 / 28, blocks filter 19 / 26,
`text("furnace")` 117 / 138, links 15 / 30; `outline` 11 / 27; `gc` 23.
Against the Rust 3e-ii run (import 876, writes 24–27 / 29–38, docs 14 / 15,
blocks filter 13 / 16, text 81 / 145, links 11 / 12, outline 11 / 18, gc 21)
the writes are within ±4 ms at p50 — the claims insert lost an index
maintenance per minted id and gained nothing — while the four reads are 4–6
ms slower at p50 and the text query 36: no read in this harness touches
`id_claims` or the feed, and the import is 98 ms faster, so the read rows
moved with the machine (the same session's TS run shows the spawn at twice
its 3e-ii value). Against the TS release-prep run the picture is the one
every round shows (writes 346–407 / 390–446 there, spawn 339 / 672).

### 17.1 (Phase 4a), TS — capture optional: history ON vs history OFF (`ts-2026-10-26T09-07-08`, `ts-history-off-2026-10-26T09-08-54`)

The same harness over the Phase 4a reference (store 17.1: the history bundle
follows the manifest, a commit hands the recorder its rows only while the
repository's `history` row is `enabled`), TS CLI, node 24, the same seeded
corpus (0.22 MB of Markdown, 201 documents). Two rows: **history ON** (the
default — capture from the first commit, as every run above) and **history
OFF** (`--history off`: the harness runs `source add <dir> --repo bench -y
--no-history`, so the repository is born `disabled`, the import itself is
uncaptured, no history table is ever created). The 17.0 release-prep TS row
(`ts-2026-10-26T07-17-32`) is the comparison for the ON row.

| stage | ops | OFF db MB | OFF grew KB | OFF KB / op | ON db MB | ON KB / op | 17.0 db MB / KB / op | OFF content | OFF identity | OFF history | OFF search | OFF sync KB | ON history MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 3.95 | 3,953 | 19.7 / doc | 6.20 | 30.8 / doc | 6.17 / 30.0 | 3.11 | 0.37 | 0 | 0.24 | 232 | 2.24 |
| frontmatter hot update | 50 | 4.01 | 57 | 1.1 | 6.30 | 2.1 | 6.28 / 2.1 | 3.12 | 0.38 | 0 | 0.24 | 256 | 2.29 |
| block edit | 50 | 4.05 | 37 | 0.7 | 6.43 | 2.6 | 6.41 / 2.6 | 3.12 | 0.39 | 0 | 0.24 | 284 | 2.38 |
| rolling journal | 50 | 4.11 | 61 | 1.2 | 6.60 | 3.4 | 6.58 / 3.4 | 3.14 | 0.41 | 0 | 0.24 | 300 | 2.49 |
| task churn | 50 | 4.14 | 33 | 0.7 | 6.68 | 1.6 | 6.66 / 1.6 | 3.14 | 0.42 | 0 | 0.24 | 324 | 2.54 |
| link churn | 50 | 4.17 | 29 | 0.6 | 6.78 | 2.0 | 6.75 / 1.8 | 3.14 | 0.43 | 0 | 0.24 | 340 | 2.60 |
| delete / recreate | 20 | 4.20 | 33 | 1.6 | 6.89 | 5.7 | 6.88 / 6.2 | 3.15 | 0.45 | 0 | 0.24 | 352 | 2.70 |
| gc (default sweep) | | 4.20 | 0 | | 6.89 | | 6.88 / 0 | 3.15 | 0.45 | 0 | 0.24 | 352 | 2.70 |

**History off is the number the program exists for: 4.20 MB at the end
against 6.89 MB with capture on — 19.2× the source against 31.5×, −2.69 MB
(−39 %), and the `history` category reads 0 B / 0 rows at every stage (no
table exists).** The import is 3.95 MB (18.1×) against 6.20 (28.3×) — the
2.24 MB the recorder wrote at import in the ON run is exactly the gap. Per
operation the small edits cost a third to a quarter: frontmatter 2.1 → 1.1
KB, block edit 2.6 → 0.7, journal 3.4 → 1.2, task churn 1.6 → 0.7, link
churn 2.0 → 0.6, delete/recreate 5.7 → 1.6 — what remains is the core's own
growth: `content` 3.11 → 3.15 MB (identical in both runs: the rows are the
same), `identity` 0.37 → 0.45 (`id_claims` 5,715 rows, 438 KB — the same
count: every id is minted and claimed with capture off too, with bit 0
alone), `sync` 232 → 352 KB (the feed: 471 rows + 471 entries, identical),
`search` 0.24. The ON row is the 17.0 row to within the seed's noise
(6.20 / 6.89 vs 6.17 / 6.88 MB; `history` 2.24 → 2.70 both; the recorder's
rows identical: `blobs` 3,218, `tree_nodes` 1,000, `dispositions` /
`block_changes` 3,824, `revisions` 461, `commits` 471, `edge_transitions`
955) — making capture conditional cost nothing when it is on: `captureFor`
is one manifest read per commit. No `commits`/`revisions`/`blobs`/
`tree_nodes`/`dispositions`/`block_changes`/`edge_transitions`/`archives`
table exists in the OFF database; `doctor --size` lists the `history`
category empty.

Latency (p50 / p95 ms, the process start 220 / 263 OFF, 207 / 258 ON): OFF
import 1,088; one write 269–313 / 310–355 (frontmatter 313 / 355, block edit
276 / 320, journal 280 / 322, task churn 274 / 310, link churn 293 / 330,
recreate 269 / 314); `query` docs 312; ON import 1,209, writes 244–296 /
292–332. The machine of the day was faster than the 17.0 run's (spawn 207–220
vs 339); OFF and ON are within each other's noise — the recorder's share of
a small write was never the latency's bulk. Reproduce: `node
scripts/baseline/modular-core-baseline.mjs --engine ts --history off`.

### 17.1 (Phase 4a), Rust — history on, the twin (`rust-2026-10-26T10-46-00`)

The Rust twin of Phase 4a (`crates/omgbase-store` 17.1: the history bundle
follows the manifest, `capture_for` hands the recorder its rows only while
the repository's `history` row is `enabled`), release build of the `omgbase`
crate 0.28.0 + the working tree, the same seeded corpus (0.22 MB of Markdown,
201 documents), capture on from the first commit. The TS 4a ON row
(`ts-2026-10-26T09-07-08`) is the comparison; the Rust 17.0 release-prep row
(`rust-2026-10-26T07-21-00`, 6.21 / 6.90 MB) the cost of making capture
conditional.

| stage | ops | db MB | grew KB | KB / op | content | identity | recovery | history | search | sync | TS 4a ON (db MB / KB / op / history MB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.20 | 6,201 | 30.9 / doc | 3.11 | 0.38 | 0.01 | 2.24 | 0.23 | 0.24 | 6.20 / 30.8 / 2.24 |
| frontmatter hot update | 50 | 6.30 | 102 | 2.0 | 3.11 | 0.39 | 0.01 | 2.29 | 0.24 | 0.27 | 6.30 / 2.1 / 2.29 |
| block edit | 50 | 6.42 | 115 | 2.3 | 3.11 | 0.40 | 0.01 | 2.37 | 0.23 | 0.29 | 6.43 / 2.6 / 2.38 |
| rolling journal | 50 | 6.61 | 188 | 3.8 | 3.13 | 0.41 | 0.01 | 2.51 | 0.24 | 0.31 | 6.60 / 3.4 / 2.49 |
| task churn | 50 | 6.68 | 74 | 1.5 | 3.13 | 0.41 | 0.01 | 2.55 | 0.23 | 0.34 | 6.68 / 1.6 / 2.54 |
| link churn | 50 | 6.77 | 94 | 1.9 | 3.14 | 0.43 | 0.01 | 2.61 | 0.23 | 0.35 | 6.78 / 2.0 / 2.60 |
| delete / recreate | 20 | 6.92 | 143 | 7.2 | 3.15 | 0.45 | 0.01 | 2.71 | 0.23 | 0.36 | 6.89 / 5.7 / 2.70 |
| gc (default sweep) | | 6.92 | 0 | | 3.15 | 0.45 | 0.01 | 2.71 | 0.23 | 0.36 | 6.89 / 0 / 2.70 |

**Row for row the TS run.** Every category holds the same row count as the
TS 4a ON run at every stage (`content` 9,612 → 9,671, `identity` 4,810 →
5,715, `history` 11,821 → 13,753, `search` 4,805 → 4,855, `sync` 706 →
1,246), and so does every table after gc — `blobs` 3,218, `tree_nodes`
1,000, `dispositions` / `block_changes` 3,824, `revisions` 461, `commits`
471, `edge_transitions` 955, `edges` 803, `id_claims` 5,715, `feed` /
`feed_entries` 471 — the bytes a page apart here and there (`blobs` 634,880
vs 630,784, `dispositions` 339,968 vs 348,160, `block_changes` 303,104 vs
290,816, `edge_transitions` 163,840 vs 159,744, `id_claims` 438,272 vs
434,176; `tree_nodes` 974,848, `revisions` 110,592, `commits` 172,032,
`blocks` 1,871,872, `feed` 139,264 / `feed_entries` 86,016 byte-identical).
The database is **6.20 MB at import (28.4× the source) and 6.92 MB at the
end (31.6×)** against the TS run's 6.20 / 6.89 (+4 KB / +24 KB, five pages
of index layout) and the Rust 17.0 release-prep run's 6.21 / 6.90: making
capture conditional cost nothing when it is on — `capture_for` is one
manifest read per commit. Per operation: frontmatter 2.0 (TS 2.1), block
edit 2.3 (2.6), journal 3.8 (3.4), task churn 1.5 (1.6), link churn 1.9
(2.0), recreate 7.2 (5.7 — the page split fell on the Rust side this time;
the release-prep rows were 6.0 / 6.2).

Latency (p50 / p95 ms, the process start 5 / 265 included — the p95 the one
cold first spawn of ten): import 803; one write 24 / 27–34 (frontmatter 24 /
29, block edit 24 / 28, journal 24 / 27, task churn 24 / 29, link churn 24 /
28, recreate 24 / 34); `query` docs 14 / 16, blocks filter 13 / 17,
`text("furnace")` 69 / 94, links 11 / 15; `outline` 10 / 12; `gc` 17 —
within the Rust release-prep run's noise (writes 22–31 / 25–41).

### 17.1 (Phase 4a), Rust — history off, the twin (`rust-history-off-2026-10-26T10-46-11`)

The same binary and corpus with `--history off` (`source add <dir> --repo
bench -y --no-history`: the repository is born `disabled`, the import itself
is uncaptured, no history table is ever created). The TS 4a OFF row
(`ts-history-off-2026-10-26T09-08-54`) is the comparison, the Rust ON row
above the cost of capture.

| stage | ops | db MB | grew KB | KB / op | content | identity | recovery | history | search | sync | TS 4a OFF (db MB / KB / op) | Rust ON (db MB / KB / op) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 3.94 | 3,940 | 19.6 / doc | 3.10 | 0.37 | 0.01 | 0 | 0.23 | 0.23 | 3.95 / 19.7 | 6.20 / 30.9 |
| frontmatter hot update | 50 | 4.01 | 66 | 1.3 | 3.10 | 0.39 | 0.01 | 0 | 0.23 | 0.26 | 4.01 / 1.1 | 6.30 / 2.0 |
| block edit | 50 | 4.04 | 33 | 0.7 | 3.10 | 0.39 | 0.01 | 0 | 0.24 | 0.29 | 4.05 / 0.7 | 6.42 / 2.3 |
| rolling journal | 50 | 4.09 | 53 | 1.1 | 3.12 | 0.40 | 0.01 | 0 | 0.23 | 0.31 | 4.11 / 1.2 | 6.61 / 3.8 |
| task churn | 50 | 4.12 | 25 | 0.5 | 3.12 | 0.41 | 0.01 | 0 | 0.23 | 0.33 | 4.14 / 0.7 | 6.68 / 1.5 |
| link churn | 50 | 4.15 | 33 | 0.7 | 3.13 | 0.43 | 0.01 | 0 | 0.24 | 0.35 | 4.17 / 0.6 | 6.77 / 1.9 |
| delete / recreate | 20 | 4.18 | 29 | 1.4 | 3.13 | 0.44 | 0.01 | 0 | 0.24 | 0.36 | 4.20 / 1.6 | 6.92 / 7.2 |
| gc (default sweep) | | 4.18 | 0 | | 3.13 | 0.44 | 0.01 | 0 | 0.24 | 0.36 | 4.20 / 0 | 6.92 / 0 |

**The number, in the second engine: 4.18 MB at the end against 6.92 MB with
capture on — 19.1× the source against 31.6×, −2.74 MB (−40 %); the TS pair
is 4.20 vs 6.89 (−39 %).** The import is 3.94 MB (18.0×) against 6.20
(28.4×). The `history` category reads 0 B / 0 rows at every stage — no
`commits`, `revisions`, `blobs`, `tree_nodes`, `dispositions`,
`block_changes`, `edge_transitions` or `archives` table exists in the
database (the core bundle, the semantic bundle's two empty tables, and
`sqlite_schema` are its whole table set; `doctor --size` lists the `history`
category empty). Every other category is the TS OFF run's row for row at
every stage (`content` 9,612 → 9,671, `identity` 4,810 → 5,715, `search`
4,805 → 4,855, `sync` 687 → 1,227) and `sync` is byte-identical to it at
every stage (233,472 → 360,448 B: the feed's 471 rows + 471 entries, the
status row); the database is 12–24 KB under the TS run throughout (`blocks`
1,867,776 vs 1,880,064 B at the end, three pages; `id_claims` 434,176 vs
438,272, one). Against the Rust ON run the core's own tables are the same
rows and within a page (`id_claims` 434,176 vs 438,272 B for the same 5,715
claims — every id is minted and claimed with capture off too, with bit 0
alone; `blocks` 1,867,776 vs 1,871,872; `feed` / `feed_entries` / `edges`
byte-identical). Per operation the small edits cost a third to a quarter of
the ON row: frontmatter 2.0 → 1.3 KB, block edit 2.3 → 0.7, journal 3.8 →
1.1, task churn 1.5 → 0.5, link churn 1.9 → 0.7, recreate 7.2 → 1.4 (TS:
2.1 → 1.1, 2.6 → 0.7, 3.4 → 1.2, 1.6 → 0.7, 2.0 → 0.6, 5.7 → 1.6).

Latency (p50 / p95 ms, the process start 5 / 6): import 563 — 240 ms under
the ON run's 803, the recorder's share of a 201-document import (TS 1,088 vs
1,209); one write 21–25 / 26–33 (frontmatter 25 / 29, block edit 25 / 30,
journal 23 / 26, task churn 22 / 26, link churn 23 / 26, recreate 21 / 27);
`query` docs 13 / 19, blocks filter 13 / 17, `text("furnace")` 82 / 124,
links 12 / 13; `outline` 9 / 11; `gc` 10 — the writes within the ON run's
noise, as in TS: the recorder's share of a small write was never the
latency's bulk. Reproduce: `node scripts/baseline/modular-core-baseline.mjs
--engine rust --bin target/release/omgbase --history off`.

### 17.2 (Phase 4b), TS — history on, no regression (`ts-2026-10-26T11-42-15`)

The same harness over the Phase 4b reference (store 17.2: `history purge`,
the semantic lifecycle, the `feed_capped` alert, the read-state table — none
of which a workload here exercises), history ON. Against the 4a run
(`ts-2026-10-26T09-07-08`): import 6.20 vs 6.20 MB, the end 6.91 vs 6.89
MB (+20 KB, within the page noise of the 17.0 rows), every per-op cost
identical to the tenth of a KB — frontmatter 2.2, block edit 2.6, journal
3.4, task 1.4, link 1.9, doc churn 6.8 KB/op; `history` 2.70 MB at the end
in both. Nothing moved.

| stage | ops | db MB | grew KB | KB / op | content | identity | recovery | history | search | sync | same_dispositions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import | 201 docs | 6.20 | 6,201 | 30.9 / doc | 3.12 | 0.38 | 0.01 | 2.23 | 0.23 | 0.24 | 0 |
| frontmatter hot update | 50 | 6.31 | 111 | 2.2 | 3.13 | 0.39 | 0.01 | 2.29 | 0.23 | 0.27 | 0 |
| block edit | 50 | 6.44 | 131 | 2.6 | 3.13 | 0.40 | 0.01 | 2.38 | 0.23 | 0.29 | 0 |
| rolling journal | 50 | 6.62 | 172 | 3.4 | 3.15 | 0.41 | 0.01 | 2.49 | 0.23 | 0.31 | 0 |
| task churn | 50 | 6.68 | 70 | 1.4 | 3.15 | 0.41 | 0.01 | 2.54 | 0.23 | 0.34 | 0 |
| link churn | 50 | 6.78 | 94 | 1.9 | 3.15 | 0.43 | 0.01 | 2.60 | 0.23 | 0.35 | 0 |
| delete / recreate | 20 | 6.91 | 135 | 6.8 | 3.16 | 0.44 | 0.01 | 2.70 | 0.23 | 0.36 | 0 |
| gc | — | 6.91 | 0 | — | 3.16 | 0.44 | 0.01 | 2.70 | 0.23 | 0.36 | 0 |

### Latency (CLI round trips, p50 / p95 ms)

| op | Rust 0.27.3 (release build) | TS 0.26.3 (node 24) |
| --- | --- | --- |
| process start (`--version`) | 6 / 267 (the first run cold) | 209 / 356 |
| import 201 docs (`source add`) | 510 | 1,219 |
| one write (meta / update / append / done) | 16–20 / 19–38 | 246–270 / 267–344 |
| `query` docs projection, 201 rows | 10 / 11 | 245 / 1,442 (one outlier) |
| `query` blocks filter | 9 / 10 | 236 / 370 |
| `query` with `text("furnace")` | 62 / 75 | 336 / 415 |
| `query` links by destination | 8 / 10 | 238 / 381 |
| `outline` | 7 / 10 | 197 / 214 |
| `gc` | 16 | 233 |

The TS numbers are dominated by node's start (~210 ms with the CLI's imports);
subtract the process start to compare the engines on the work itself: a write
is ~12 ms in Rust and ~50 ms in TS, the FTS query ~55 ms and ~130 ms. (The
debug Rust build measured 34–37 ms per write and 207 ms for the text query —
do not read debug numbers as the engine's.)

### Nested blocks cost twice (and a harness lesson)

A first run of the harness picked the edited paragraph with an unordered
`limit 1`, and the two engines landed on different paragraphs: the TS edited
one nested in a list item, and each of its 50 edits wrote **two** dispositions,
two `block_changes`, two tree nodes and two blobs — the item's raw contains the
paragraph's, so the item is re-encoded too. Named by a marker
(`_text.startsWith("Abstract:")`) both engines write exactly one row of each
per edit, as store 14.2 pins. Two things worth keeping: a block edit inside a
container costs roughly twice a top-level one under the current encoding (the
container-duplication finding of the history note, seen per edit), and the
engines are byte-for-byte consistent on this path — the earlier "divergence"
was the harness's.

## 3. Real corpora

The measurement the program exists for (Phase 4b): a real directory of
Markdown imported four ways into fresh workspaces — history on and off,
with and without the embedder — `scripts/baseline/real-corpus.mjs`
(`--source <dir> [--embedder <cmd>] [--out docs/modular-core/baseline]`;
the directory is copied into a temporary workspace and never touched; the
table prints numbers only). Below: this repository's `docs/` (a public
corpus — 42 Markdown files, 0.91 MB, 4,009 blocks; the baseline tables under
`docs/modular-core/baseline/` are part of it), TS CLI 0.27.0 at store 17.2,
`@omgbase/embedder` (`Xenova/gte-base`, 768-dim); run
`real-corpus-ts-2026-10-26T11-54-02`.

| composition | docs | blocks | Markdown MB | database MB | × source | content | identity | recovery | history | search | sync |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| history on, embedder off | 42 | 4009 | 0.91 | 9.42 | 10.4× | 5.04 (53.5 %) | 0.36 | 0.01 | 3.29 (34.9 %) | 0.56 (5.9 %) | 0.14 |
| history off, embedder off | 42 | 4009 | 0.91 | 6.05 | 6.7× | 5.02 (83.0 %) | 0.32 | 0.01 | 0.00 (0.0 %) | 0.56 (9.3 %) | 0.14 |
| history on, embedder on | 42 | 4009 | 0.91 | 14.98 | 16.5× | 5.05 (33.7 %) | 0.36 | 0.01 | 3.27 (21.8 %) | 6.14 (41.0 %) | 0.14 |
| history off, embedder on | 42 | 4009 | 0.91 | 11.64 | 12.8× | 5.03 (43.2 %) | 0.32 | 0.01 | 0.00 (0.0 %) | 6.14 (52.7 %) | 0.14 |

History off saves 3.38 MB — 36 % of the history-on database, 10.4× → 6.7×
the Markdown. The embedder adds 5.55 MB of vectors (6.1× the Markdown on its
own: 4,009 block vectors + 42 document vectors at 768 floats), so the four
compositions span 6.7× – 16.5×. Content is 5.0 MB (5.5× the Markdown) on
this corpus because the baseline tables are wide Markdown tables — every
cell row a block with its raw, properties, nodes and FTS — a shape the
synthetic workload (§2, ≈ 14× for content) does not have; the history share
(35 %) is below the 50 % of the two-month notes corpus (§1) because an
import is one revision per document — the per-commit constant has not
started accumulating. Import took 2.2 s / 2.0 s without the embedder; with
it the `source add` drains the queue (≈ 4.5 min for 4,000 blocks on this
machine). To run it on a private repository (numbers only — the script
prints no path and no content):

```
node scripts/baseline/real-corpus.mjs --source /path/to/notes --embedder "node $PWD/packages/embedder/dist/src/bin.js"
```

## 4. What the baseline says for the plan

- **History is half the bytes on a real corpus, and growth is per commit,
  not per byte changed.** The fixed cost of a commit (`commits` + `revisions`
  ≈ 1.2 KB) exceeds the content delta of every small edit measured; the
  store-16 frontmatter delta is 80 bytes. Any "history off" that still writes
  `commits`/`revisions` rows for the feed keeps most of the small-edit cost —
  the feed record of §3 "Change delivery" must be the compact one.
- **Containers are stored once per nesting level.** A journal line costs 3.6
  KB because the list's raw and the root's list are re-encoded; `blobs` on the
  real corpus average 1.7 KB per row against 672 B per live block.
- **The id oracle's table is the fourth-largest history table** (`block_changes`
  3.9 MB) and grows one row per block per change; Phase 3's identity claims
  replace a read, not a write — the write must stop too (Phase 4).
- **Embeddings are the other half.** 21 MB of vectors for 1.9 MB of text; Phase
  2's sidecar is where a smaller model or a per-document-only policy becomes a
  choice rather than a rebuild.
- **gc reclaims nothing without retention** — the sweep is not a growth control.

## 5. Reproduce

```
cargo build -p omgbase && pnpm --filter omgbase build        # both CLIs
node scripts/baseline/modular-core-baseline.mjs --engine rust   # → docs/modular-core/baseline/rust-<stamp>.{json,md}
node scripts/baseline/modular-core-baseline.mjs --engine ts
node scripts/baseline/modular-core-baseline.mjs --engine ts --history off   # Phase 4a: the repository born with capture off (source add --no-history)
node scripts/baseline/real-corpus.mjs --source <dir> [--embedder <cmd>]       # Phase 4b: a real directory, four compositions, numbers only (§3)
<cli> -C <workspace> doctor --size --json                       # a real workspace, read-only
```

The JSON keeps every stage's full table list and every operation's timing; the
Markdown is the tables above. Change `--docs`, `--edits`, `--seed` to scale;
`--keep` leaves the temp workspace for inspection. The runs recorded here are
`baseline/rust-2026-10-25T03-29-38` (the release build, `--bin target/release/omgbase`) and
`baseline/ts-2026-10-25T03-29-46`; `cargo build --release -p omgbase` for the release binary.
