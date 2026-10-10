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

  [select <items>] from <target> [where <pred>] [follow <dest>, … [{ … }]]
                   [order by <expr> [asc|desc], …] [limit N] [offset N]
  <target> count|exists|none|first|single { <block> }     (scalar/one-row form: a bare target at the root scope)

CLAUSE ORDER IS FIXED: select, from, where, follow, order by, limit, offset —
each at most once; an out-of-order clause is a parse error naming the order.
Only \`select\` may drop its keyword, and only as the first clause
(\`$path, era from docs where …\`). A top-level predicate needs \`where\`, because
\`where\` follows \`from\` (\`era > 1600 from docs\` is the clause-order error); a
block may LEAD with a predicate (see Sugar), but a predicate after a projection
still needs the keyword (\`{ name where kind == "md:task" }\`, not
\`{ name, kind == "md:task" }\`); \`from docs count\` is an error (write
\`docs count { … }\`). \`where\` and later \`select\` items may use the same body's
\`select\` aliases (\`select $path, old: era < 1000 from docs where old\`; an alias
shadows a same-named field there). \`and\` / \`or\` / \`not\` are the connectives;
the symbols \`&&\` / \`||\` / \`!\` are accepted synonyms (the words are canonical and
what \`print\` writes).

## Sugar (OQX 0.17)

Every form here is shorthand for an explicit directive (the AST is the explicit form):
  nodes { kind == "md:task" }        ≡ nodes collect { where kind == "md:task" } — a receiver block with
                                       no consumer is collect; a block whose LEADING expression is a predicate
                                       (comparison, call, !/is/not, in, literal, (…), a consumer test — anything
                                       but a bare name, a dotted path or a ^lift) is where-first. Bare names still
                                       project: nodes { name } ≡ nodes collect { name }; filter a bare field with
                                       nodes { is checked }. Not after follow: follow children { depth 2 } is options.
  refs(x)[0]                          ≡ refs(x) first { offset 0 }   positional (integer literal or \${binding});
                                       out of range ⇒ absent; refs(x)[0].$path navigates the row
  ^docs[$path == ^company]            ≡ ^docs first { where $path == ^company }   first match or absent
  ^docs[$path == ^company]!           ≡ … single { … } required: exactly one, else filter_invalid
  title!                              required: title, or an error naming the expression (and the row's $id)
                                       — never a filter, never a coercion (0!, ""! are values); tightest: a!.b vs a.b!
  is x / not x                        truthiness of x, and its negation (prefix; \`not\` ≡ \`!\`)
  x is y / x is not y                 identity (a row's id, else structural) — compares rows, which == does not;
                                       x is null = absent; for scalars is ≡ ==; comparison precedence, no chaining
  a and b / a or b                    the connectives (≡ && / ||: same precedence, short-circuit, value: title or $path coalesces)
  boss: ^docs[$path == ^manager], bossName: boss.$title   a select item may use the items to its LEFT
  Reserved words (never a bare field name): from where select is not and or, true false null.

Results are LEAN hits — {id, path} + whatever \`select\` projects (or \`values\`,
\`count\`, \`exists\`, \`none\`). Hydrate full content by id via nodes_get/docs_read.

## Paths

Every path the surface returns is \`/\`-rooted — the form a reference is
written in (\`[x](/projects/oqx.md)\`, \`before: [/timeline/kickoff.md]\`): a
hit's \`path\`, \`$path\`, \`$dst_path\`, every tool's paths. Every path it
accepts tolerates both forms (\`/a.md\` or \`a.md\`): tool arguments, \`refs(x)\`,
\`within(...)\`, and a string LITERAL compared with \`$path\`/\`$dst_path\` by
\`==\`/\`!=\` or passed to their \`.startsWith(...)\` (it is rooted first, so
\`$path == "a.md"\` and \`$path == "/a.md"\` both match). A property holding a
reference compares directly: \`where ^$path in list(after)\`,
\`where customer == ^$path\` — no \`"/" + ...\` glue.

## Targets & field namespaces

The sigil rule: \`$\`-prefixed names are engine intrinsics; BARE identifiers are
your content. On docs a bare first segment that collides with an intrinsic base
name (id/path/updated_at/content_hash/body) is REJECTED with a "did you mean
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
  - intrinsics       = $id, $path (/-rooted, see Paths), $updated_at (ISO-8601,
                       sorts chronologically), $body (whole file), $content_hash.
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
  - intrinsics       = $id, $src, $dst, $dst_path (target doc path, /-rooted;
                       NULL when dangling/external), $dst_uri (external URL;
                       NULL otherwise), $src_block, $via, $from_commit; $path
                       and doc.<key> reach the SOURCE document.
  - text()/semantic() are N/A on edges.

## Scoping (ADR-015; the root row since surface 2.0): bare names are LOCAL

  name          the CURRENT row only — never falls through to an enclosing row
                or the repository; an absent field is simply absent.
  ^name         one scope OUT (the enclosing row's fields/intrinsics/lifts);
                ^^name two scopes out. \`^$path\` = the enclosing row's path.
  ^docs ^nodes ^blocks ^edges
                THE ROOT ROW (surface 2.0, oqx 0.18): the repository is the root
                scope's row, one scope out from a top-level row, so ^docs there is
                the whole documents scan (uncorrelated until you add a ^ predicate);
                one caret per enclosing block (^^docs from depth two), or the
                absolute 0^docs from ANY depth. ^$id / 0^$id = the repository id.
                ^$it = the root object: ^$it.docs ≡ ^docs, entries(^$it) names the
                four collections. At the root scope itself a bare target is the scan
                (docs count { … }, from docs, entries(docs)).
                ERRORS: a bare \`docs\` INSIDE a block reads a property of the current
                row, which has none — refused ("did you mean ^docs"); \`^docs\` AT THE
                TOP LEVEL reaches past the root — refused (write the bare \`docs\`);
                so is \`$repo\` (surface < 2.0; the message names the replacement).
                nodes/blocks on a doc row are that doc's RELATIONS, not the root.
  $it           the current item itself (a row, or each ELEMENT when the
                receiver is a list property); ^$it = the enclosing row.
                $value is NOT an intrinsic (since oqx 0.15): it reads a
                property literally named $value, absent when there is none.
  $key          inside an entries(x) block: the entry's key.

## Scalar semantics (@omgbase/oqx)

  comparisons  ==  !=  <  <=  >  >=    strict & typed (5 == "5" is false); either
                                       side may be a field (field-vs-field OK).
  absence      null and a missing field are the same "absent" value; two absents
               are EQUAL, so \`absent != "x"\` is TRUE and \`absent == null\` is TRUE.
               Relational (< <= > >=) on an absent operand → FALSE. Bare \`f\` in
               boolean position uses JS truthiness (absent/false/0/"" ⇒ false;
               NOTE: "false", [] and {} are truthy). has(f) = explicit presence.
  boolean      and  or  not    grouping ( … )   — && || ! are accepted synonyms
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
    within("path" | "d_..")   containing doc = id, exact path, or path glob (*);
                              either path form
    yaml_path("a.b")          YAML docs: the block at that key path
    json_pointer("#/a/b")     JSON docs: the block at that pointer
    has_edge("pred"[, target])  an open authored edge with that predicate leaves here
    has_anchor()              block carries an authored ^ref
    parent_type() == "x"      parent block's type (must be compared)
    child_count() > 0         number of direct children (must be compared)
  refs(x)              the live documents a property's document references name:
                       x is a string, a list or absent; each "/a/b.md", "a/b.md"
                       or "d_…" element resolves to that doc's row; dangling and
                       non-string elements are dropped. Yields docs rows, so it is
                       a source, a receiver or a follow destination:
                       follow refs(before), refs(after) walks a timeline both ways.
                       The reverse direction needs no function: a document's
                       $path is already the reference form, so
                       ^docs collect { where ^$path in list(after) } is
                       "the documents whose \`after\` names me".
  A HIT IS A STORE ROW: a top-level row that is not a doc/block/node/edge fails
                       (filter_invalid). \`follow before\` over a list of paths
                       reaches the STRINGS — write \`follow refs(before)\`.

## Nested queries & consumers

  <receiver> collect|exists|none|count|first|single { <block> }
    receiver = a relation (nodes, blocks, doc.out_edges, section.blocks, …), a
    list property (tags), entries(x), or a root collection (^docs; 0^docs at depth ≥ 2).
    block    = [select …] [where …] [follow …] [order by …] [limit N] [offset N]
               — the same fixed order as the top level (\`from\` optional; the
               receiver supplies the rows). A leading name/alias list is the
               projection (\`select\` dropped); a predicate always needs \`where\`.
  exists    ≥1 row      nodes exists { where kind == "md:task" and not checked }
  none      0 rows      nodes none { where kind == "md:task" and not checked }  ("every task done")
  count     a number    nodes count { where kind == "md:task" } >= 2
  collect   rows (default) — in select for nested results; in where with a lift
  first / single   zero-or-one (single errors on >1) — lookups in select
  distinct  on any consumer: dedup by projected value — nodes count distinct { select kind }
  limit/offset  bound the block's rows AFTER where/order/distinct, BEFORE the
            consumer reduces: nodes exists { offset 1 } = at least two;
            first { … offset 1 } = the second.
  lift      \`^name:\` in a where-collect binds values outward:
            select $path, open from docs where nodes collect { ^open: value where kind == "md:task" and not checked }
  joins     ^<t> exists { where slug == ^ref }  semi-join; not … exists  anti-join;
            ^nodes single { where kind == "person" and attrs.id == ^owner_id }  lookup;
            x in ^keys  membership over a lifted set.

## select — projection

  select a, alias: expr, nested: nodes collect { … }
  bare key → the property (scalar-authored → scalar; list → array); $-intrinsics;
  a call/arithmetic needs an alias (n: size(tags)) unless in values mode.
  "$body"     whole file bytes (docs) — docs_read is cheaper for one doc.
  distinct    select distinct type   (dedup hits by projected value)
  values      select <ONE item> values → bare values instead of records:
                from docs select distinct type values          → values: ["hub","lab-note",…]
                select $path values from docs                  → values: ["/index.md", …]
                tags: tags collect { $it values }             → a plain array
                h: nodes first { name values where kind == "md:section" order by first_ordinal }
  entries(x)  a record as a collection ($key / $it per entry), key order:
                select fm: entries(frontmatter) collect { k: $key, v: $it }
                where entries(frontmatter) exists { where $key == "era" and $it > 1600 }
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
    follow doc.in { where ^$path in list(before) }    ^ = the row being expanded
                                                   (^^ = the walk's enclosing scope)
    follow doc.out, doc.in                         several destinations: their union
                                                   (one step dedups by identity)
    follow ^docs collect { where doc.out exists { where $path == ^^$path } }
                                                   a destination block, re-read per
                                                   frontier row (^ = that row; ^docs
                                                   is the root's documents) = doc.in
    follow doc.out { frontier type == "practitioner" }   cut, keeping the frontier row
    follow distinct doc.out / follow doc.out { by group } identity control
  Per-occurrence metadata: $depth (seed = 1), $stop (interior|leaf|frontier|
  depth|cycle), $leaf/$frontier, $ordinal — usable in select/order by and the
  top-level post-walk where, NOT metadata of the candidates the follow-local
  where/frontier read.
  Type-preserving relations: doc.out/doc.in, block.children, section.children,
  section.subsections.
  from edges where $dst_path == "/notes/x.md"      inbound edges to a doc, as rows
  from edges where predicate == "depends_on" select $src, $dst_path
  from docs where not doc.in_edges exists { }      orphans (nothing links in)
  (The \`graph\` tool is a convenience wrapper that compiles to a follow query.)

## semantic grain

from docs ranks whole DOCUMENTS (one hit per file); from blocks ranks PASSAGES.
text()/where prune the candidate set; only order by reweights.

## Examples

  from docs where layer == "working"
  from docs where $path.startsWith("/guides/") and $updated_at >= "2026-08-01"
  from docs where "pricing" in list(tags) select layer, tags
  from docs where inline.owner == "alice"
  from docs where $title.lower().contains("q3 plan")
  from docs where format == "yaml"
  from docs where type == "practitioner" order by era desc limit 2
  from docs where nodes none { where kind == "md:task" and not checked }
  from docs where tags exists { where $it == "tria-prima" }
  from docs where $path == "/x.md" select fm: entries(frontmatter) collect { k: $key, v: $it }
  from docs select owner_id, owner: ^nodes single { where kind == "person" and attrs.id == ^owner_id }
  from blocks where type == "task" and not checked and under_heading("Launch") and doc.layer == "working"
  from blocks where type == "paragraph" and has_edge("references", "d_92aaaaa")
  select $path, $depth from docs where $path == "/timeline/review.md" follow refs(before), refs(after)
  select $path, next: ^docs collect { $path where ^$path in list(before) } from docs where type == "milestone"
  select $path, n: size(^docs), repo: ^$id from docs limit 1
  docs { type == "substance" and not verified }
  select subject, process: ^docs[slug == ^subject]!.$path from docs where type == "lab-note"
  select $path, back: nodes first { select p: 0^docs collect { $path where ^^$path in list(after) } values } from docs where type == "milestone"
  select $path, prior: refs(before) collect { $path, when } from docs where type == "milestone"
  from blocks order by semantic("identity preservation across edits") desc limit 10
  from edges where dst_kind == "external" select $dst_uri
  docs count { where layer == "canon" }

Common mistake: bare \`path.startsWith(...)\` meant the intrinsic — it fails loud
with a hint; write \`$path.startsWith(...)\`. Another: \`where tags == "x"\` on a
list-valued key is false — write \`"x" in tags\`.
`;
