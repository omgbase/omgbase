---
npm:
  "@omgbase/core": patch
  omgbase: patch
crates:
  omgbase-sync: minor
  omgbase: patch
---
Writer-lock discipline (`spec/sync` 2.1 §7): every host takes `writer.lock` once, at its outermost write boundary, for the write's whole duration. `omg mcp` now takes it around every write tool call (dry runs included) — before, the TypeScript server took none and relied on in-process serialization, which a concurrent one-shot CLI writer or a Rust `omgbase mcp` on the same workspace defeats — and `docs_move` holds one lock across the rename and the inbound-link retarget instead of two with a gap. The TypeScript watcher's priming sweep and checkpoint ingests are under the lock as in Rust, and in both engines a one-shot command's pre-verb freshness sweep and a one-shot `sync` now take it too (they ingest observed checkpoints and ran unlocked). The Rust binary gains a test seam, `OMGBASE_WRITER_LOCK_TIMEOUT_MS`, honoured by the CLI and `omgbase mcp`. `withWriterLock` is re-entrant within a process (a nested acquisition is a no-op; the outermost holder releases), so library callers that pass `omgbaseDir` keep working under a boundary lock. The Rust CLI's local write verbs now take the lock as the TypeScript CLI always did (`--server` leaves locking to the remote server). The spec's §9 pins the scope and records the fixed divergences.
