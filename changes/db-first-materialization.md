---
npm:
  "@omgbase/core": patch
  omgbase: patch
crates:
  omgbase-store: major
  omgbase-sync: minor
  omgbase: patch
---
DB-first materialization with recorded intent (`spec/store` 14.0 §5.4 "The api path", new §5.7; `spec/mutate` 2.2 §4 step 5; `spec/sync` 2.2 §4.1/§4.3). Schema 14 adds `pending_materializations` (one row per path: write / rename / remove, the revision, the hash the file must have, the commit) with migration 13 → 14; an older engine refuses a 14 database as before. The write order becomes read → one IMMEDIATE transaction (validate, commit, insert the pending rows) → materialize (write / rename / remove each file, fsync before rename, delete its row), so a conflict found inside the transaction never touches a file, and a crash between the commit and the file write is replayed — by the next write, the freshness sweep's step 0 or `recoverRepo` — with the api intent, commit and change-feed digest intact, instead of being healed as an observed commit that lost them. An observation of a pending path treats bytes hashing to the recorded hash as an echo, a missing file as not-yet-written (no tombstone), and anything else as a human edit that wins (ADR-004). `docs_delete` unlinks only a file whose bytes still match; `docs_move` falls back to writing the destination when the rename cannot happen. The guarantee the specs now state: all-or-nothing in the database, files eventually consistent through recorded intent, no cross-resource atomicity claimed. Fixture projections gain a `pending_materializations` key; new `crash_after_commit` and `materialize` observation steps. `omg sync` / `omgbase sync` JSON gains `materialized: [path…]` (the files the sweep's step 0 wrote; `spec/cli` 3.1, an additive key).
