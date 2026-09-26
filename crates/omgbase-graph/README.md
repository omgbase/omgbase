# omgbase-graph

**The omgbase graph layer — Rust implementation (the pure half).**

The graph layer projects semantic **nodes** out of a Markdown document's
blocks (links, wikilinks, tasks, anchors, inline fields; the store adds
sections) and extracts the authored **edges** between documents (Markdown
links and images, wikilinks, autolinks and bare URLs, `key:: [[relation]]`
inline fields, frontmatter relations). This crate is the part that is a pure
function of a revision's blocks and frontmatter: projected nodes with byte
spans and `node_id`s, edge descriptors, WHATWG URI normalization and relative
path resolution. Resolving targets to node ids, minting, the edge validity
intervals and the `doc_edges` rollup read and write the database and live in
`omgbase-store`, which calls this crate inside its commit transaction.

```rust
use omgbase_format::parse_markdown;
use omgbase_graph::{DstKind, NodeKind, extract_doc_edges, node_rows, normalize_uri, project_nodes};
use omgbase_properties::DocBlock;

let tree = parse_markdown("# T\n\nSee [x](./x.md#H) and <https://A.com/>\n");
let ids: Vec<String> = (0..DocBlock::count(&tree.children)).map(|i| format!("b_{i}")).collect();
let blocks = DocBlock::from_blocks(&tree.children, &ids);

let nodes = project_nodes(&blocks);
assert_eq!(nodes[0].kind, NodeKind::Link);
assert_eq!(nodes[0].span, Some((4, 17))); // bytes into the block's raw
let rows = node_rows("d_0", &nodes);
assert!(rows[0].node_id.starts_with("n_"));

let edges = extract_doc_edges(&blocks, None);
assert_eq!((edges[0].target.as_str(), edges[0].anchor.as_deref()), ("./x.md", Some("H")));
assert_eq!((edges[1].dst_kind, edges[1].target.as_str()), (DstKind::External, "https://a.com"));
assert_eq!(normalize_uri("https://a.com/./x/../y#f"), "https://a.com/y");
```

The reference is the TypeScript engine
[`@omgbase/core`](https://github.com/omgbase/omgbase/tree/main/packages/core)
(`graph/extract.ts`, `format/markdown.ts`'s `projectNodes`,
`core/store/{nodes,edges}.ts`). Both conform to the language-neutral
specification and fixtures at
[`spec/graph`](https://github.com/omgbase/omgbase/tree/main/spec/graph) in
the same repository; `omgbase_graph::SPEC_VERSION` reports the spec version
this crate implements and the crate version tracks it as
`<major>.<minor>.<patch>`.

## Scanning

Block-level scanning works on the block's `raw` with fenced code and inline
code spans blanked (`omgbase_properties::mask_code`, widened here to preserve
**byte** length so spans index the original), and skips `code_fence` blocks.
The regular expressions are the reference's, with JavaScript's `\s` and
ASCII `\b` spelled out; the bare-URL lookbehind is a preceding-character
check. URIs go through the `url` crate, a WHATWG implementation like Node's
`URL`.

## Conformance

`tests/spec.rs` runs every case under `spec/graph/cases` by driving
`omgbase-store` (a path-only dev-dependency) exactly as the store runner does,
then projects and checks the graph tables per the spec's §7. Skipped when the
fixtures are not present (outside the monorepo). While the port runs behind
the fixtures, `tests/spec-passing.txt` names the cases that must pass;
promote with `GRAPH_SPEC_UPDATE=1 cargo test -p omgbase-graph --test spec`.

## License

MIT
