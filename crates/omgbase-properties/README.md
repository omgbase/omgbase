# omgbase-properties

**The omgbase document properties — Rust implementation.**

A document's properties are the typed, indexed rows the engine derives from
three sources — the YAML frontmatter fence, inline `key:: value` fields in the
body, and engine-computed `$`-intrinsics (`$title`, `$tags`) — and stores in
the `properties` table so that filters, projections and `docs_read` see one
uniform surface. This crate is a pure library: a block tree (with ids) in,
property rows and the two read shapes out. No SQLite; `omgbase-store` calls it
inside the commit transaction.

```rust
use omgbase_format::{BlockKind, parse_markdown};
use omgbase_properties::{DocBlock, Source, doc_properties, merged};

let tree = parse_markdown("---\nlayer: canon\n---\n\n# Title\n\nelement:: fire\n");
let (frontmatter, body) = match tree.children.first() {
    Some(b) if b.kind == BlockKind::Frontmatter => (Some(b), &tree.children[1..]),
    _ => (None, &tree.children[..]),
};
let ids: Vec<String> = (0..DocBlock::count(body)).map(|i| format!("b_{i}")).collect();
let blocks = DocBlock::from_blocks(body, &ids);

let rows = doc_properties("d_0", frontmatter, &blocks);
assert_eq!(rows.len(), 3);
assert!(rows.iter().any(|r| r.source == Source::Inline && r.key == "element" && r.block_id.as_deref() == Some("b_1")));
assert_eq!(merged(&rows)["$title"], "Title");
```

The reference is the TypeScript engine
[`@omgbase/core`](https://github.com/omgbase/omgbase/tree/main/packages/core)
(`core/store/properties.ts`, the inline/computed parts of `core/ingest.ts`,
`format/markdown.ts`). Both conform to the language-neutral specification and
fixtures at
[`spec/properties`](https://github.com/omgbase/omgbase/tree/main/spec/properties)
in the same repository; `omgbase_properties::SPEC_VERSION` reports the spec
version this crate implements and the crate version tracks it as
`<major>.<minor>.<patch>`.

## YAML

Frontmatter is YAML 1.2 with the **core schema**, as the `yaml` npm package
(v2) reads it. The crate uses `saphyr-parser` for the document *structure*
and resolves every plain scalar itself (spec §4): `yes`/`no` are strings,
`012` is twelve, `1_000` is a string, timestamps are strings, `.inf`/`.nan`
are the non-finite floats. Duplicate keys, tab indentation, more than one
document, a non-mapping document or any syntax error yield **no rows**.

## Conformance

`tests/spec.rs` runs every case under `spec/properties/cases` (skipped when
the crate is built outside the monorepo). While the port runs behind the
fixtures, `tests/spec-passing.txt` names the cases that must pass; promote
with `PROPERTIES_SPEC_UPDATE=1 cargo test -p omgbase-properties --test spec`.

## License

MIT
