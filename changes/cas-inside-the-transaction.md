---
npm:
  "@omgbase/core": patch
crates:
  omgbase-mutate: minor
  omgbase-store: patch
---
CAS inside the transaction (`spec/mutate` 2.2 §4 step 5 (c)): the commit transaction opens `BEGIN IMMEDIATE` and, before minting anything, re-reads every loaded document's `(path, current_rev, file_hash)` through the transaction and compares it with what the plan loaded — a document that moved on fails `stale_plan` with current truth, a file that changed since the file-CAS fails `sync_conflict`, and the document operations re-check `path_taken`/`doc_missing` the same way; a conflict rolls back before any id is minted. `docs_set_meta` is now under the same CAS (it checked nothing before). Until now every precondition ran on the plan-time snapshot outside the transaction, protected only by the writer lock. No fixture movement.
