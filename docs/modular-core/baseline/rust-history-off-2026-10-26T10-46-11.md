# Baseline — rust (0.28.0), 201 docs, 50 edits, seed 1, history OFF (`source add --no-history`)

Source: 0.22 MB of Markdown. Database after import: 3.94 MB (18.0× the source); after every workload and a gc: 4.18 MB (19.1×). Run 2026-10-26T10-46-11.

## Growth per stage

| stage | ops | db MB | wal MB | grew KB | KB / op | content MB | identity MB | recovery MB | history MB | search MB | sync MB | same_dispositions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| import |  | 3.94 | 0.00 | 3940 |  | 3.10 | 0.37 | 0.01 | 0.00 | 0.23 | 0.23 | 0 |
| frontmatter-hot | 50 | 4.01 | 0.00 | 66 | 1.3 | 3.10 | 0.39 | 0.01 | 0.00 | 0.23 | 0.26 | 0 |
| block-edit | 50 | 4.04 | 0.00 | 33 | 0.7 | 3.10 | 0.39 | 0.01 | 0.00 | 0.24 | 0.29 | 0 |
| journal-append | 50 | 4.09 | 0.00 | 53 | 1.1 | 3.12 | 0.40 | 0.01 | 0.00 | 0.23 | 0.31 | 0 |
| task-churn | 50 | 4.12 | 0.00 | 25 | 0.5 | 3.12 | 0.41 | 0.01 | 0.00 | 0.23 | 0.33 | 0 |
| link-churn | 50 | 4.15 | 0.00 | 33 | 0.7 | 3.13 | 0.43 | 0.01 | 0.00 | 0.24 | 0.35 | 0 |
| doc-churn | 20 | 4.18 | 0.00 | 29 | 1.4 | 3.13 | 0.44 | 0.01 | 0.00 | 0.24 | 0.36 | 0 |
| gc |  | 4.18 | 0.00 | 0 |  | 3.13 | 0.44 | 0.01 | 0.00 | 0.24 | 0.36 | 0 |

## History, identity, recovery and feed tables after gc

| table | MB | rows |
| --- | --- | --- |
| id_claims | 0.43 | 5715 |
| resurrection_pool | 0.01 | 0 |
| pending_materializations | 0.01 | 0 |
| edges | 0.17 | 803 |
| feed | 0.14 | 471 |
| feed_entries | 0.09 | 471 |

## Latency (CLI round trips, ms)

| op | n | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| spawn-baseline | 10 | 5 | 6 | 6 |
| init | 1 | 10 | 10 | 10 |
| import | 1 | 563 | 563 | 563 |
| frontmatter-hot | 50 | 25 | 29 | 32 |
| block-edit | 50 | 25 | 30 | 33 |
| journal-append | 50 | 23 | 26 | 28 |
| task-churn | 50 | 22 | 26 | 30 |
| link-churn | 50 | 23 | 26 | 31 |
| doc-churn | 20 | 21 | 27 | 27 |
| query-docs | 20 | 13 | 19 | 19 |
| query-blocks-filter | 20 | 13 | 17 | 17 |
| query-text | 20 | 82 | 124 | 124 |
| query-links | 20 | 12 | 13 | 13 |
| outline | 20 | 9 | 11 | 11 |
| gc | 1 | 10 | 10 | 10 |

The process start (`spawn-baseline`, `--version`) is included in every row above. Workspace: a fresh temp directory, `init --no-embedder`, one filesystem source; no embedder, so `search` is FTS only.
