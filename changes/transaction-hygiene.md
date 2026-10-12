---
npm:
  "@omgbase/core": patch
crates:
  omgbase-store: minor
  omgbase-sync: patch
---
Transaction hygiene on the observe path (`spec/store` 13.6, `spec/sync` 2.1 §4.1): the `conflicted` flag is written inside the member's ingest transaction with the pointers update instead of as a separate autocommit afterwards; the observed tombstone (`spec/store` §5.6) is one transaction in the TypeScript engine too (it ran bare autocommit statements); a checkpoint's `checkpoints` row and the resurrection-pool sweep are one transaction in both engines. No projection or fixture changes — a crash between any of these statements can no longer leave a committed revision with a stale flag, a pooled-but-live doc, or a swept pool without its checkpoint row.
