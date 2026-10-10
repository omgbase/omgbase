//! The `query_syntax` text (`spec/surface/README.md` §4: reference prose,
//! unpinned). A condensed distillation of `docs/query-language.md`.

/// The agent-facing OQX syntax reference the `query_syntax` tool returns.
pub const QUERY_SYNTAX: &str = r#"# query — OQX syntax reference

The `query` tool takes ONE plain OQX string (+ optional `limit`/`cursor`). There
is no {from, filter, order} envelope: every concern is a clause of the string.

  [select <items>] from <target> [where <pred>] [follow <dest>, … [{ … }]]
                   [order by <expr> [asc|desc], …] [limit N] [offset N]
  <target> count|exists|none|first|single { <block> }     (scalar/one-row form: a bare target at the root scope)

CLAUSE ORDER IS FIXED: select, from, where, follow, order by, limit, offset —
each at most once; an out-of-order clause is a parse error naming the order.
Only `select` may drop its keyword, and only as the first clause
(`$path, era from docs where …`). A top-level predicate needs `where`, because
`where` follows `from` (`era > 1600 from docs` is the clause-order error); a
block may LEAD with a predicate (see Sugar), but a predicate after a projection
still needs the keyword (`{ name where kind == "md:task" }`, not
`{ name, kind == "md:task" }`); `from docs count` is an error (write
`docs count { … }`). `where` and later `select` items may use the same body's
`select` aliases (`select $path, old: era < 1000 from docs where old`; an alias
shadows a same-named field there). `and` / `or` / `not` are the connectives;
the symbols `&&` / `||` / `!` are accepted synonyms (the words are canonical and
what `print` writes).

## Sugar (OQX 0.17)

Every form here is shorthand for an explicit directive (the AST is the explicit form):
  nodes { kind == "md:task" }        ≡ nodes collect { where kind == "md:task" } — a receiver block with
                                       no consumer is collect; a block whose LEADING expression is a predicate
                                       (comparison, call, !/is/not, in, literal, (…), a consumer test — anything
                                       but a bare name, a dotted path or a ^lift) is where-first. Bare names still
                                       project: nodes { name } ≡ nodes collect { name }; filter a bare field with
                                       nodes { is checked }. Not after follow: follow children { depth 2 } is options.
  refs(x)[0]                          ≡ refs(x) first { offset 0 }   positional (integer literal or ${binding});
                                       out of range ⇒ absent; refs(x)[0].$path navigates the row
  ^docs[$path == ^company]            ≡ ^docs first { where $path == ^company }   first match or absent
  ^docs[$path == ^company]!           ≡ … single { … } required: exactly one, else filter_invalid
  title!                              required: title, or an error naming the expression (and the row's $id)
                                       — never a filter, never a coercion (0!, ""! are values); tightest: a!.b vs a.b!
  is x / not x                        truthiness of x, and its negation (prefix; `not` ≡ `!`)
  x is y / x is not y                 identity (a row's id, else structural) — compares rows, which == does not;
                                       x is null = absent; for scalars is ≡ ==; comparison precedence, no chaining
  a and b / a or b                    the connectives (≡ && / ||: same precedence, short-circuit, value: title or $path coalesces)
  boss: ^docs[$path == ^manager], bossName: boss.$title   a select item may use the items to its LEFT
  Reserved words (never a bare field name): from where select is not and or, true false null.

Results are LEAN hits — {id, path} + whatever `select` projects (or `values`,
`count`, `exists`, `none`). Hydrate full content by id via nodes_get/docs_read.

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
form, so `^docs collect { where ^$path in list(after) }` is "the
documents whose `after` names me". A HIT IS A STORE ROW: a top-level row that is not
a doc/block/node/edge fails (filter_invalid) — `follow before` over a list of
paths reaches the STRINGS; write `follow refs(before)`.

## Directives

<receiver> exists|none|count|collect|first|single { <block> } — nested,
correlated to the current row; `^name` reads one scope out. THE ROOT ROW
(surface 2.0, oqx 0.18): the repository is the root scope's row, so from a
top-level row `^docs` / `^nodes` / `^blocks` / `^edges` are the whole
collections (unbounded until a `^` predicate correlates them) — one caret per
enclosing block (`^^docs` from depth two), or the absolute `0^docs` from any
depth; `^$id` / `0^$id` is the repository id; `^$it` the root object
(`^$it.docs` ≡ `^docs`, `entries(^$it)` names the four collections). At the
root scope a bare target is the scan (`docs count { … }`, `from docs`). A
bare `docs` INSIDE a block reads a property of the current row and is refused
("did you mean `^docs`"); `^docs` AT THE TOP LEVEL reaches past the root and is
refused (write the bare `docs`); so is `$repo` (surface < 2.0), with the
replacement named. `nodes`/`blocks` on a doc row are that doc's relations, not the root.
`distinct` dedups by projection;
`values` returns bare values; `limit`/`offset` bound a block before its
consumer. `follow <dest>, … { where … frontier … depth N by … }` recurses
over type-preserving destinations ($depth, $stop, $leaf, $frontier,
$ordinal): each <dest> is a relation of the current row or a
`<recv> collect|first|single [distinct] { … }` block re-evaluated per frontier
row; one step's successors are unioned by identity. Inside the follow-local
`where` and inside a destination block `^` is the row being expanded (`^^`
the walk's enclosing scope): `follow doc.in { where ^$path in list(before) }`,
`follow doc.out, ^docs collect { where ^$path in list(after) }`.
A custom `order by` disables the keyset cursor.
"#;
