---
npm:
  "@omgbase/core": patch
crates:
  omgbase-mutate: minor
  omgbase-store: minor
  omgbase-surface: patch
---
One transaction per request (`spec/mutate` 2.1 §4 step 5, `spec/store` 13.7 §5.4 "The api path"): a changeset over N documents, a `docs_move` with its inbound-link retarget, `links_repair`/`links_retarget` and the document operations now commit in ONE SQLite transaction with ONE `commits` row and N `revisions`, all-or-nothing — through 2.0 the commit phase ran per document, so a `sync_conflict` on the n-th document left the earlier ones committed (`commit::conflict-on-third-doc-keeps-first-two`, now `…-commits-nothing`). The commit phase is file-CAS every touched document first (a mismatch writes nothing and raises `sync_conflict`), then write every file, then the single transaction; a failure inside it rolls every document back and leaves the written files ahead of the database until the next observation heals them (pinned; DB-first materialization is the following step). `docs_move` is one commit under `move <from> -> <to>` carrying the rewritten sources' revisions (the separate `retarget inbound links …` changeset is gone), and `changes_since` renders `moved a → b; <paths> — …` for it. A request that touches no document records no commit row. `changes_since` reports a multi-document request as one digest with every revision (`write-cross-doc-move`, `write-docs-create-move`, `write-links-retarget-repair` interop cases). Request/response shapes are unchanged; the six block ops and `b_` minting at parse time are untouched.
