---
npm:
  "@omgbase/core": none
crates:
  omgbase-surface: none
---

Investigated a report that `docs_read.properties.frontmatter.<list-of-mappings>`
comes back double-wrapped (`[[{…}, …]]`) and that using such a property as a
nested-query receiver (`people { select name where active == true }`) then
matches nothing, while `people[0] { … }` "fixes" it.

Confirmed this is working as designed, reproduced identically in both engines
(TypeScript `@omgbase/core` and the Rust `omgbase`/`omgbase-surface` binary):
a frontmatter list whose elements are mappings or lists is the properties
layer's named json-escape-hatch shape (`spec/properties` §5,
`shapes::json-escape-hatch-reads-as-nested-array`) — it is stored as one row
and its read shape wraps it in an extra array. OQX's receiver coercion then
sees that outer array's one element (the real list) as a single row; since an
array has no named properties of its own (`spec/oqx` SEMANTICS §1/§3), a
projection off it is absent, and `prop[0]` (a lookup, not special indexing)
is what reaches the real rows. Both the reference TypeScript engine and the
Rust twin behave identically, as expected from the shared spec.

No behavior changed. Added a clarifying `NOTE:` to the `query_syntax` tool's
"Nested queries & consumers" chapter (`packages/core/src/mcp/reference.ts`,
mirrored byte-for-byte in `crates/omgbase-surface/src/reference.rs`) and a
cross-reference from `spec/properties/README.md` §5 to the query-layer
consequence, so the next person hitting this does not mistake it for a bug.
