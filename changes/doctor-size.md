---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-store: minor
  omgbase: minor
---
`omg doctor --size` answers "what is this database made of, and what would reclaim space" (spec/cli 4.3, spec/store 14.1 §7 "Size"): bytes and rows per table through SQLite's `dbstat` virtual table (indexes counted toward their table, FTS5 shadow tables folded into theirs), grouped into `content` / `history` / `search` / `sync` with each category's three biggest tables, the file's bytes, WAL, pages and free pages (`reclaimable = freelist_count × page_size`), and deterministic advice (a `VACUUM` past 1 MiB and 10 % free pages; `history` past 50 %; embeddings past 25 %; else `nothing to reclaim`). `--json` is the store's `sizeReport` / `size_report` verbatim; a SQLite build without `dbstat` reports row counts only and says so. `omg gc --vacuum` runs `VACUUM` after the sweep under gc's flag (`--dry-run --vacuum` measures); the result gains `vacuum: { reclaimable, applied }`. Library: `@omgbase/core` exports `sizeReport`, `vacuum`, `reclaimableBytes`, `humanBytes`, `formatShare`, `TABLE_CATEGORY`; `omgbase-store` gains `Store::size_report`, `Store::vacuum`, `Store::reclaimable_bytes` and the `size` module. Fixtures `admin.json` 60 → 68 and the `doctor`/`gc` help cards; the byte counts are recorded by shape in both harnesses.
