---
npm:
  "@omgbase/core": minor
  omgbase: minor
crates:
  omgbase-properties: minor
  omgbase-store: patch
  omgbase-surface: patch
  omgbase: minor
---
YAML and JSON documents join the properties pipeline (spec/properties 1.2, §3.4): a `yaml`/`json` document's whole top-level mapping is its frontmatter — written as `source = frontmatter` rows, the same source a Markdown fence uses, so bare keys (`select focused_intent from docs where path == "/attn/focus.yaml"`), `data.<k>`/`frontmatter.<k>`, `entries(frontmatter)`, the `where` pushdown and `docs_read.properties.frontmatter` read it unchanged, on the observe path and the API path (`create`, `set content`) alike. A YAML stream's first document is the mapping; a parse error (the reference no longer takes a lenient parser's recovered mapping), a non-mapping root or an empty file yields no rows. No inline and no computed rows for these formats (`title`/`tags` are authored keys; no basename title). The frontmatter effects stay Markdown's for now: `set`/`unset frontmatter.<key>`, `docs_set_meta` and `create { frontmatter }` on a `yaml`/`json` document are refused with `type_mismatch` instead of fencing the file. New fixtures `spec/properties/cases/whole-document.json` (a `format` field per case) and `spec/surface` `reads::yaml-json-documents`. The Rust twin follows: `omgbase-properties` (unchanged rows), `omgbase-store`'s observe properties step over `omgbase-format`'s YAML/JSON mappings, and `omgbase-surface`'s refusal.
