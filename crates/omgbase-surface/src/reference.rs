//! The `query_syntax` text (`spec/surface/README.md` §4: reference prose,
//! unpinned). A condensed distillation of `docs/query-language.md`.

/// The agent-facing OQX syntax reference the `query_syntax` tool returns.
pub const QUERY_SYNTAX: &str = r#"# query — OQX syntax reference

The `query` tool takes ONE plain OQX string (+ optional `limit`/`cursor`).

  [select <items>] from <target> [where <pred>] [follow <dest>, … [{ … }]]
                   [order by <expr> [asc|desc], …] [limit N] [offset N]
  $repo.<target> count|exists|none|first|single { <block> }     (scalar/one-row form)

CLAUSE ORDER IS FIXED: select, from, where, follow, order by, limit, offset —
each at most once. Only `select` may drop its keyword, and only as the first
clause. A predicate is never implicit: blocks filter with `where`
(`nodes exists { where kind == "md:task" }`).

Results are LEAN hits — {id, path} + whatever `select` projects (or `values`,
`count`, `exists`, `none`). Hydrate by id via nodes_get / docs_read.

## Paths

Every path the surface returns is `/`-rooted — the form a reference is
written in (`[x](/projects/oqx.md)`, `before: [/timeline/kickoff.md]`): a
hit's `path`, `$path`, `$dst_path`, every tool's paths. Every path it
accepts tolerates both forms (`/a.md` or `a.md`): tool arguments, `refs(x)`,
`within(...)`, and a string LITERAL compared with `$path`/`$dst_path` by
`==`/`!=` or passed to their `.startsWith(...)` (it is rooted first, so
`$path == "a.md"` and `$path == "/a.md"` both match). A property holding a
reference compares directly: `where ^$path in list(after)`,
`where customer == ^$path` — no `"/" + ...` glue.

## Targets & field namespaces

`$`-prefixed names are engine intrinsics; BARE identifiers are your content.

docs:    bare identifier = a document PROPERTY (frontmatter + inline, nested via
         dots); frontmatter.<k> / inline.<k> force a source; entries(frontmatter)
         is the whole bag; $title, $tags, format; $id, $path, $updated_at, $body,
         $content_hash; relations nodes, blocks, doc.out / doc.in,
         doc.out_edges / doc.in_edges. A bare id/path/updated_at/content_hash/
         body is rejected ("did you mean $x?").
blocks:  type, text, attrs keys flattened (`checked`); $id, $doc, $path,
         $ordinal, $depth, $updated_at, $body, $content_hash; doc.<key>;
         block.children, block.nodes, block.out_edges, section.
nodes:   kind, name, value, attrs keys flattened; $id, $doc_id, $block_id,
         $path; doc.<key>, block.<field>; section.blocks, section.children,
         section.subsections.
edges:   predicate, provenance, dst_kind, anchor, src_field; $id, $src, $dst,
         $dst_path, $dst_uri, $src_block, $via, $from_commit; $path and
         doc.<key> reach the SOURCE document.

## Functions

text("terms") — FTS prune (docs/blocks/nodes). semantic("phrase") — cosine
score (docs/blocks; needs a provider). Blocks only: under(id),
under_heading(s), within(doc id | path glob), under_kind(type[, name]),
yaml_path(p), json_pointer(p), has_anchor(), child_count(), parent_type().
has_edge(pred[, dst]) on docs and blocks. Free: list, size, has, entries,
range, refs. Methods: contains, startsWith, endsWith, matches, size, lower,
upper.

refs(x) — the live documents a property's document references name: x is a
string, a list or absent; each "/a/b.md", "a/b.md" or "d_…" element resolves
to that doc's row; dangling and non-string elements are dropped. Yields docs
rows, so it is a source, a receiver or a follow destination:
`follow refs(before), refs(after)` walks a timeline both ways. The reverse
direction needs no function: a document's $path is already the reference
form, so `$repo.docs collect { where ^$path in list(after) }` is "the
documents whose `after` names me". A HIT IS A STORE ROW: a top-level row that is not
a doc/block/node/edge fails (filter_invalid) — `follow before` over a list of
paths reaches the STRINGS; write `follow refs(before)`.

## Directives

<receiver> exists|none|count|collect|first|single { <block> } — nested,
correlated to the current row; `^name` reads one scope out; `$repo.<target>`
is an unbounded root scan from any depth. `distinct` dedups by projection;
`values` returns bare values; `limit`/`offset` bound a block before its
consumer. `follow <dest>, … { where … frontier … depth N by … }` recurses
over type-preserving destinations ($depth, $stop, $leaf, $frontier,
$ordinal): each <dest> is a relation of the current row or a
`<recv> collect|first|single [distinct] { … }` block re-evaluated per frontier
row; one step's successors are unioned by identity. Inside the follow-local
`where` and inside a destination block `^` is the row being expanded (`^^`
the walk's enclosing scope): `follow doc.in { where ^$path in list(before) }`,
`follow doc.out, $repo.docs collect { where ^$path in list(after) }`.
A custom `order by` disables the keyset cursor.
"#;
