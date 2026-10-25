# Modular core — Phase 0 baseline (store 16, 2026-10-24)

What the store is made of today and what one edit costs, measured — the
numbers Phase 3–5 of the modular-core plan are judged against (the plan's
economic gate: "set numerical budgets from Phase 0, before implementation is
judged"; the October 13 snapshot of 131 MB predates store 14.2 and 16 and is
not a baseline). Everything here is the engine as it is at this commit; nothing
was changed to take it. "Measured" is a `doctor --size --json` report
(spec/store §7.2: bytes per table from `dbstat`, the file, the WAL) or a wall
clock; "derived" is arithmetic on those.

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
