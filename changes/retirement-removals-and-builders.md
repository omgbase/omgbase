---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-mutate: patch
  omgbase-store: patch
  omgbase-surface: patch
  omgbase: minor
---
Retirement release, part B (ADR-021; `spec/surface` 4.0, `spec/cli` 4.0, `spec/mutate` 3.0). Removed from the surface: raw `ops` on `apply` (it takes `effects`; the six kernel ops remain the library and fixture contract), `dry_run` on `apply` and every sugar tool (preview with `plan { effects }` — a plan writes nothing and burns no ids, so the "dry runs consume ids" oddity is closed), `blocks_update`'s `attrs` bag (`checked`), and `links_retarget`/`links_repair`'s dry-run-by-default and `applied` key (they commit like every other tool and return the receipt with `hits` and `pairs`). Each retired argument fails `filter_invalid` with a message naming its replacement, and unknown arguments are no longer silently dropped. Every sugar tool returns the receipt. The document operations and the sugar tools are built from one set of shared effect builders used by the MCP server, both CLIs and the fixture runners, so the library's own `docsCreate`/`docsMove`/`docsDelete`/`docsSetMeta` paths are gone and their commits carry the intent record; the kernel `Request` loses the `set_frontmatter` side channel (a plan's frontmatter is a file head). CLI: `omg apply -f` takes effects only; every verb's `--dry-run` prints the plan with `$new.n` ids; `omg edit` writes through effects with the pre-read hash as its guard.
