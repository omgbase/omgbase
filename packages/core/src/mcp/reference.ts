// Agent-facing syntax reference, surfaced as the query_syntax MCP tool. Agents
// lean on it heavily before writing a non-trivial query. It is a condensed,
// example-led distillation of docs/query-language.md — enough to compose a
// correct call without reading the normative spec. Kept in one place so the
// tool handler stays thin. Semantics are the @omgbase/oqx contract (ADR-013);
// when this text and the corpus (corpus/oqx/alchemy.test.ts) disagree, the
// corpus wins.

export const QUERY_SYNTAX = `# query — OQX syntax reference

The \`query\` tool takes ONE plain OQX string (+ optional \`limit\`/\`cursor\`). There
is no {from, filter, order} envelope: every concern is a clause of the string.

  from <target> [where <pred>] [select <items>] [order by <expr> [asc|desc], …]
                [limit N] [offset N] [follow <relation> [{ … }]]
  $repo.<target> count|exists|none|first|single { <block> }     (scalar/one-row form)

Results are LEAN hits — {id, path} + whatever \`select\` projects (or \`values\`,
\`count\`, \`exists\`, \`none\`). Hydrate full content by id via nodes_get/docs_read.

## Targets & field namespaces

The sigil rule: \`$\`-prefixed names are engine intrinsics; BARE identifiers are
your content. On docs a bare first segment that collides with an intrinsic base
name (id/path/repo/updated_at/content_hash/body) is REJECTED with a "did you mean
$X?" hint (bare \`path\` would silently read an absent frontmatter key). Force the
property with \`frontmatter.<k>\`. \`title\`/\`tags\` are NOT reserved: \`$title\`/\`$tags\`
are computed and never shadow an authored \`title:\`/\`tags:\` key.

docs:
  - bare identifier  = a document PROPERTY (frontmatter + inline \`key:: value\`,
                       unioned; nested via dots: meta.owner). YAML/JSON docs
                       expose the parsed object's keys the same way.
  - source-scoped    = frontmatter.<k> / inline.<k>; the whole bag as a collection
                       via entries(frontmatter) / entries(inline) (see entries()).
  - computed         = $title (first H1), $tags (body #hashtags), format
                       (the doc's format — "markdown"/"yaml"/"json"; a bare
                       computed field, present on EVERY doc, so has(format) is
                       always true and \`format == "yaml"\` is the filter).
  - intrinsics       = $id, $path, $updated_at (ISO-8601, sorts chronologically),
                       $body (whole file), $content_hash.
  - relations        = nodes, blocks, doc.out / doc.in (citation graph),
                       doc.out_edges / doc.in_edges (a doc's edges as rows).

blocks:
  - bare fields      = type, text, and every attrs key FLATTENED onto the row
                       (bare \`checked\` reads attrs.checked; \`attrs.<k>\` still
                       works; type/text win on collision; absent ⇒ false).
  - intrinsics       = $id, $doc, $path, $ordinal, $depth, $updated_at, $body
                       (the block text), $content_hash (the block's OWN raw hash —
                       the value update/split expect).
  - reach-through    = doc.<key> / doc.$path / doc.format = the CONTAINING doc.
  - relations        = block.children, block.nodes, block.out_edges, section.

nodes:
  - bare fields      = kind (md:task / md:link / md:section / yaml:…), name,
                       value, + attrs keys flattened (checked, level).
  - intrinsics       = $id (=$node_id), $doc_id, $block_id, $path.
  - reach-through    = doc.<key>, block.type / block.text.
  - relations        = section.blocks, section.children, section.subsections.

edges:  (the authored link graph as rows — one per open edge)
  - bare fields      = predicate ("references"/"embeds"/freeform), provenance
                       ("link"/"frontmatter"/"inline_field"/…), dst_kind
                       ("document"/"external"/"collection"), anchor, src_field
  - intrinsics       = $id, $src, $dst, $dst_path (target doc path; NULL when
                       dangling/external), $dst_uri (external URL; NULL
                       otherwise), $src_block, $via, $from_commit; $path and
                       doc.<key> reach the SOURCE document.
  - text()/semantic() are N/A on edges.

## Scoping (ADR-015): bare names are LOCAL

  name          the CURRENT row only — never falls through to an enclosing row
                or the repository; an absent field is simply absent.
  ^name         one scope OUT (the enclosing row's fields/intrinsics/lifts);
                ^^name two scopes out. \`^$path\` = the enclosing row's path.
  $repo.<t>     the root scan — $repo.docs / $repo.nodes / $repo.blocks /
                $repo.edges — available from ANY depth (uncorrelated until you
                add a ^ predicate). $repo.$id = the repository id.
  $value        the current item itself (a row, or each ELEMENT when the
                receiver is a list property); ^$value = the enclosing row.
  $key          inside an entries(x) block: the entry's key.

## Scalar semantics (@omgbase/oqx)

  comparisons  ==  !=  <  <=  >  >=    strict & typed (5 == "5" is false); either
                                       side may be a field (field-vs-field OK).
  absence      null and a missing field are the same "absent" value; two absents
               are EQUAL, so \`absent != "x"\` is TRUE and \`absent == null\` is TRUE.
               Relational (< <= > >=) on an absent operand → FALSE. Bare \`f\` in
               boolean position uses JS truthiness (absent/false/0/"" ⇒ false;
               NOTE: "false", [] and {} are truthy). has(f) = explicit presence.
  boolean      &&  ||  !    grouping ( … )
  arithmetic   + - * / %    (+ concatenates if either side is a string)
  membership   x in y       array → typed membership; string → substring;
                            object → key exists; range → coverage. Any list
                            property works directly: "pricing" in tags. list(f)
                            coerces scalar-or-list (absent → []) — use it when a
                            key is sometimes scalar, sometimes a list.
  ranges       lo..hi (inclusive)  lo...hi (exclusive hi)  ..hi  lo..
               era in 800..1680; works over ISO dates. range(prop) reads a
               range-shaped STRING property as an interval: "2026-01-15" in range(window).
  strings      x.contains("s") x.startsWith("p") x.endsWith("s") x.matches("^re$")
               (real regex) x.lower() x.upper() size(x). ALL CASE-SENSITIVE —
               fold with .lower(): $title.lower().contains("aurora").
  functions    has(f)  size(x)  list(x)  entries(x)  range(s)
  literals     "str" 'str' 123 1.5 true false null
  determinism  no now()/clock/random. Lists/structs are not literals; ternary is
               not supported. Errors surface as filter_invalid.
  scalars vs lists  a list-authored key never == a scalar (tags == "x" is false
               when tags is a list) — use \`"x" in tags\` / \`in list(tags)\`.

## Domain predicates (omgbase)

  text("terms")        FTS5 PRUNING predicate (docs match via their blocks, nodes
                       via the node index); composes anywhere, incl. nested scopes.
  semantic("phrase")   embedding cosine SCORE (docs/blocks): threshold it
                       (semantic("x") > 0.6), project it, or \`order by semantic("x")
                       desc\` for top-K. Needs a provider; else semantic_unavailable.
  blocks target only:
    under(id_or_heading)      block in the containment subtree / section range
    under_heading("Launch")   an ancestor section heading contains the text (ci)
    under_kind(type[, name])  an ancestor block has that type (name: its text
                              contains / its key equals name)
    within("path" | "d_..")   containing doc = id, exact path, or path glob (*)
    yaml_path("a.b")          YAML docs: the block at that key path
    json_pointer("#/a/b")     JSON docs: the block at that pointer
    has_edge("pred"[, target])  an open authored edge with that predicate leaves here
    has_anchor()              block carries an authored ^ref
    parent_type() == "x"      parent block's type (must be compared)
    child_count() > 0         number of direct children (must be compared)

## Nested queries & consumers

  <receiver> collect|exists|none|count|first|single { <block> }
    receiver = a relation (nodes, blocks, doc.out_edges, section.blocks, …), a
    list property (tags), entries(x), or a root ($repo.docs).
    block    = [where …] [select …] [order by …] [limit N] [offset N]; a leading
               predicate is an implicit where, a leading name/alias list an
               implicit select.
  exists    ≥1 row      nodes exists { where kind == "md:task" && !checked }
  none      0 rows      nodes none { where kind == "md:task" && !checked }  ("every task done")
  count     a number    nodes count { where kind == "md:task" } >= 2
  collect   rows (default) — in select for nested results; in where with a lift
  first / single   zero-or-one (single errors on >1) — lookups in select
  distinct  on any consumer: dedup by projected value — nodes count distinct { select kind }
  limit/offset  bound the block's rows AFTER where/order/distinct, BEFORE the
            consumer reduces: nodes exists { offset 1 } = at least two;
            first { … offset 1 } = the second.
  lift      \`^name:\` in a where-collect binds values outward:
            from docs where nodes collect { ^open: value where kind == "md:task" && !checked } select $path, open
  joins     $repo.<t> exists { where slug == ^ref }  semi-join; !… exists  anti-join;
            $repo.nodes single { where kind == "person" && attrs.id == ^owner_id }  lookup;
            x in ^keys  membership over a lifted set.

## select — projection

  select a, alias: expr, nested: nodes collect { … }
  bare key → the property (scalar-authored → scalar; list → array); $-intrinsics;
  a call/arithmetic needs an alias (n: size(tags)) unless in values mode.
  "$body"     whole file bytes (docs) — docs_read is cheaper for one doc.
  distinct    select distinct type   (dedup hits by projected value)
  values      select <ONE item> values → bare values instead of records:
                from docs select distinct type values          → values: ["hub","lab-note",…]
                tags: tags collect { $value values }             → a plain array
                h: nodes first { name values where kind == "md:section" order by first_ordinal }
  entries(x)  a record as a collection ($key / $value per entry), key order:
                select fm: entries(frontmatter) collect { k: $key, v: $value }
                where entries(frontmatter) exists { where $key == "era" && $value > 1600 }
                entries(inline), entries(attrs), a nested map, or a list (index keys)
  $semantic_score is not a field — project semantic("…") under an alias instead.

## order by, limit/offset, pagination

  order by era desc, $path asc     absent values sort LAST (asc); ties → (path, id)
  limit N / offset N               define the result SET (integer literals);
                                   the tool's limit/cursor then page WITHIN it
  cursor                           opaque keyset on (path,id); a custom order by
                                   disables it (you get the top page + truncated)

## Graph traversal (follow) and edges

  from docs where <seed> follow doc.out            docs the seed links TO
  from docs where <seed> follow doc.in             backlinks
    follow doc.out { depth 3 }                     bound (1..8, default 8)
    follow doc.out { where layer == "canon" }      keep only matching successors
    follow doc.out { frontier type == "practitioner" }   cut, keeping the frontier row
    follow distinct doc.out / follow doc.out { by group } identity control
  Per-occurrence metadata: $depth (seed = 1), $stop (interior|leaf|frontier|
  depth|cycle), $leaf/$frontier, $ordinal — usable in select/order by and the
  top-level post-walk where, NOT in the follow-local where/frontier.
  Type-preserving relations: doc.out/doc.in, block.children, section.children,
  section.subsections.
  from edges where $dst_path == "notes/x.md"       inbound edges to a doc, as rows
  from edges where predicate == "depends_on" select $src, $dst_path
  from docs where !doc.in_edges exists { }         orphans (nothing links in)
  (The \`graph\` tool is a convenience wrapper that compiles to a follow query.)

## semantic grain

from docs ranks whole DOCUMENTS (one hit per file); from blocks ranks PASSAGES.
text()/where prune the candidate set; only order by reweights.

## Examples

  from docs where layer == "working"
  from docs where $path.startsWith("guides/") && $updated_at >= "2026-08-01"
  from docs where "pricing" in list(tags) select layer, tags
  from docs where inline.owner == "alice"
  from docs where $title.lower().contains("q3 plan")
  from docs where format == "yaml"
  from docs where type == "practitioner" order by era desc limit 2
  from docs where nodes none { where kind == "md:task" && !checked }
  from docs where tags exists { where $value == "tria-prima" }
  from docs where $path == "x.md" select fm: entries(frontmatter) collect { k: $key, v: $value }
  from docs select owner_id, owner: $repo.nodes single { where kind == "person" && attrs.id == ^owner_id }
  from blocks where type == "task" && !checked && under_heading("Launch") && doc.layer == "working"
  from blocks where type == "paragraph" && has_edge("references", "d_92aaaaa")
  from blocks order by semantic("identity preservation across edits") desc limit 10
  from edges where dst_kind == "external" select $dst_uri
  $repo.docs count { where layer == "canon" }

Common mistake: bare \`path.startsWith(...)\` meant the intrinsic — it fails loud
with a hint; write \`$path.startsWith(...)\`. Another: \`where tags == "x"\` on a
list-valued key is false — write \`"x" in tags\`.
`;
