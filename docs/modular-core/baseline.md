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

## 3. What the baseline says for the plan

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

## 4. Reproduce

```
cargo build -p omgbase && pnpm --filter omgbase build        # both CLIs
node scripts/baseline/modular-core-baseline.mjs --engine rust   # → docs/modular-core/baseline/rust-<stamp>.{json,md}
node scripts/baseline/modular-core-baseline.mjs --engine ts
<cli> -C <workspace> doctor --size --json                       # a real workspace, read-only
```

The JSON keeps every stage's full table list and every operation's timing; the
Markdown is the tables above. Change `--docs`, `--edits`, `--seed` to scale;
`--keep` leaves the temp workspace for inspection. The runs recorded here are
`baseline/rust-2026-10-25T03-29-38` (the release build, `--bin target/release/omgbase`) and
`baseline/ts-2026-10-25T03-29-46`; `cargo build --release -p omgbase` for the release binary.
