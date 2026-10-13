// Agent-facing syntax reference, surfaced as the query_syntax MCP tool. Agents
// lean on it heavily before writing a non-trivial query. It is a condensed,
// example-led distillation of docs/query-language.md — enough to compose a
// correct call without reading the normative spec. Kept in one place so the
// tool handler stays thin. Semantics are the @omgbase/oqx contract (ADR-013);
// when this text and the corpus (corpus/oqx/alchemy.test.ts) disagree, the
// corpus wins.

export const QUERY_SYNTAX = `# query — OQX syntax reference

The \`query\` tool takes ONE plain OQX string (+ optional \`limit\`/\`cursor\`, and
\`bare: true\` to drop the automatic \`id\`/\`path\` envelope — needs a \`select\`).
There is no {from, filter, order} envelope: every concern is a clause of the
string. Two rules tell the two syntaxes apart: DOT navigation belongs to the
host object model (\`doc.layer\`, \`section.blocks\`, \`dst.title\`); WHITESPACE
query directives belong to OQX — a nested query is \`<receiver> collect|exists|
count|first|single { <block> }\` (a postfix directive + a \`{ … }\` block), never a
method. Its distinctive power is the receiver-constrained nested query that
correlates to the current row: \`from docs where nodes exists { where kind ==
"md:task" }\` returns only the docs that themselves contain a matching node.

  [select <items>] from <target> [where <pred>] [frontier <pred>] [follow <dest> [{ … }], …]
                   [order by <expr> [asc|desc], …] [limit N] [offset N]
  <target> count|exists|none|first|single { <block> }     (scalar/one-row form: a bare target at the root scope)

CLAUSE ORDER IS FIXED: select, from, where, frontier, follow, order by, limit, offset —
each at most once; an out-of-order clause is a parse error naming the order.
Only \`select\` may drop its keyword, and only as the first clause
(\`path, era from docs where …\`). A top-level predicate needs \`where\`, because
\`where\` follows \`from\` (\`era > 1600 from docs\` is the clause-order error); a
block may LEAD with a predicate (see Sugar), but a predicate after a projection
still needs the keyword (\`{ name where kind == "md:task" }\`, not
\`{ name, kind == "md:task" }\`); \`from docs count\` is an error (write
\`docs count { … }\`). \`where\` and later \`select\` items may use the same body's
\`select\` aliases (\`select path, old: era < 1000 from docs where old\`; an alias
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
                                       nodes { is checked }. Wherever a value stands (0.20), call arguments included:
                                       size(children { is checked }); x distinct { … } ≡ x collect distinct { … }. After a
                                       follow destination too: follow children { depth 2 } is that destination's block.
  (a, b)                              a tuple (0.20): two or more expressions, concatenated one level flat — a value
                                       (size((tags, aliases)), "x" in (tags, aliases)) and a receiver ((a, b) { … },
                                       follow (before, after) { depth 2 }); (a) alone is grouping
  refs(x)[0]                          ≡ refs(x) first { offset 0 }   positional (integer literal or \${binding});
                                       out of range ⇒ absent; refs(x)[0].path navigates the row
  ^docs[path == ^company]             ≡ ^docs first { where path == ^company }   first match or absent
  ^docs[path == ^company]!            ≡ … single { … } required: exactly one, else filter_invalid
  title!                              required: title, or an error naming the expression (and the row's $key — its id)
                                       — never a filter, never a coercion (0!, ""! are values); tightest: a!.b vs a.b!
  is x / not x                        truthiness of x, and its negation (prefix; \`not\` ≡ \`!\`)
  x is y / x is not y                 identity ($key: a store row's id, else structural) — compares rows, which == does not;
                                       x is null = absent; for scalars is ≡ ==; comparison precedence, no chaining
  a and b / a or b                    the connectives (≡ && / ||: same precedence, short-circuit, value: data.title or path coalesces)
  boss: ^docs[path == ^manager], bossName: boss.title   a select item may use the items to its LEFT
  Reserved words (never a bare field name): from where select is not and or, true false null.
  Contextual words (limit order offset follow collect count first distinct desc by in frontier depth) parse as
  fields in expression position (select o: order from docs).

Results are LEAN hits — { id, path } + whatever \`select\` projects (or \`values\`,
\`count\`, \`exists\`, \`none\`). The envelope keys ARE the attributes: copy a hit's
\`id\` straight into \`where id == "…"\` (no translation); \`select id, path\` is simply
the envelope (no duplicate columns); any OTHER projection whose output key would
be \`id\` or \`path\` must be aliased — \`select data.path\` is refused ("projection
\`path\` collides with the hit envelope — alias it (\`p: data.path\`)"); a row
surfacing as a value (an empty \`collect { }\`) is the same \`{ id, path }\`. Every
other tool spells a row the same way (\`docs_read\` → \`{ id, path, rev, properties,
raw }\`, \`blocks_read\` → \`{ id, type, text, raw, hash, … }\`, \`docs_list\` → \`{ id,
path, updated_at, blocks }\`, a revision → \`{ id, path, hash }\`): hydrate by id via
blocks_read/docs_read.

## Paths

Every path the surface returns is \`/\`-rooted — the form a reference is
written in (\`[x](/projects/oqx.md)\`, \`before: [/timeline/kickoff.md]\`): a
hit's \`path\`, an edge's \`dst_path\`, every tool's paths. Every path it
accepts tolerates both forms (\`/a.md\` or \`a.md\`): tool arguments, \`refs(x)\`,
\`within(...)\`, and a string LITERAL compared with \`path\`/\`dst_path\` (bare, or
through a row handle: \`doc.path\`) by \`==\`/\`!=\` or passed to their
\`.startsWith(...)\` (it is rooted first, so \`path == "a.md"\` and \`path == "/a.md"\`
both match). A property holding a reference compares directly — and is never
rooted: \`where ^path in list(after)\`, \`where customer == ^path\`,
\`where data.path == "/x.md"\` (the author's \`path:\` key, as written) — no
\`"/" + ...\` glue.

## Targets & field namespaces

THE NAME RULE: \`$\` belongs to OQX — $it, $key, $depth, $stop, $leaf, $frontier,
$ordinal are values the LANGUAGE injects into a scope; omgbase adds NO $ names
(a \`$id\` in a query is an unknown name, absent). Every engine attribute is a BARE
snake_case name that WINS on collision — the convention the relations (children,
blocks, out, in, doc, frontmatter, …) always followed: a bare name that is an
engine attribute reads the engine's value, never yours. Your data is bare too;
where a key of yours collides with an engine name, reach it through a source
handle: \`data.<k>\` (the merged authored view — frontmatter + inline, exactly the
read a bare non-colliding key performs), \`frontmatter.<k>\`, \`inline.<k>\`. So
\`path\` is the engine's /-rooted location and \`data.path\` your \`path:\` key;
\`tags\` is your tags ∪ the body #hashtags and \`data.tags\` the authored list alone;
\`title\` the computed title (the first H1) and \`data.title\` your \`title:\`;
\`entries(data)\` lists every authored top-level key. Same value, same name
everywhere: a hit's \`id\` is docs_read's \`id\` and the \`id\` argument of blocks_read.

  Reserved bare names per kind (engine attributes; handles; self; relations):
    docs    id path raw hash updated_at title tags format | data frontmatter inline | doc | blocks nodes out in out_links in_links
    blocks  id path doc_id raw hash updated_at type text attrs depth ordinal | block doc | children nodes out_links section
    nodes   id path doc_id block_id kind name value attrs | section doc block | blocks subsections children
    links   id path doc_id block_id via_id dst_id dst_path uri field dst_kind predicate provenance anchor | doc
  A key of yours with any of these names is \`data.<k>\` (or frontmatter.<k> /
  inline.<k> by source; attrs.<k> on a block or node).

docs:
  - bare identifier  = a document PROPERTY (frontmatter + inline \`key:: value\`,
                       unioned; nested via dots: meta.owner). YAML/JSON docs
                       expose the parsed object's keys the same way.
  - source handles   = data.<k> (merged authored view) / frontmatter.<k> /
                       inline.<k>; the whole bag as a collection via entries(data)
                       / entries(frontmatter) / entries(inline) (see entries()).
  - attributes       = id, path (/-rooted, see Paths), updated_at (ISO-8601,
                       sorts chronologically), raw (the whole file, frontmatter
                       included), hash (its sha256, 64 hex), title (the computed
                       title: the first H1; data.title is the authored key), tags
                       (authored tags ∪ body #hashtags, deduped, authored first;
                       data.tags is the authored list), format (the doc's format —
                       "markdown"/"yaml"/"json"; present on EVERY doc, so
                       has(format) is always true and \`format == "yaml"\` is the
                       filter).
  - relations        = nodes, blocks, doc.out_links / doc.in_links (a doc's
                       links as rows; the documents at their other end are
                       out_links collect distinct { from dst } and
                       in_links collect distinct { from doc } — there is no
                       out / in relation).

blocks:
  - bare fields      = doc_id (the owning doc), type, text (normalized), ordinal
                       (0-based among siblings), depth (0 at the top level), and
                       every attrs key FLATTENED onto the row (bare \`checked\`
                       reads attrs.checked; \`attrs.<k>\` still works; the
                       structural fields win on collision; absent ⇒ false).
  - attributes       = id, path (the owning doc's path), raw (the block's raw
                       source — a container's raw holds its children), hash
                       (its sha256 — the value update/split expect as
                       expect.content_hash), updated_at.
  - reach-through    = doc.<key> / doc.path / doc.id / doc.format = the
                       CONTAINING doc (doc.id and doc.path cost nothing — they
                       read the row's own doc_id / joined path, no lookup).
  - relations        = block.children, block.nodes, block.out_links, section.
  NOTE: inside a \`follow\`, $depth/$ordinal are ALWAYS the walk's metadata; a
  block's own nesting is \`depth\` / \`ordinal\` (no $) everywhere.

nodes:
  - bare fields      = doc_id, block_id (null for a block-less node), kind
                       (md:task / md:link / md:section / yaml:…), name, value,
                       + attrs keys flattened (checked, level).
  - attributes       = id, path.
  - reach-through    = doc.<key> / doc.id / doc.path, block.type / block.text
                       / block.id / block.path.
  - relations        = section.blocks, section.children, section.subsections.

links:  (the authored link graph as rows — one per open link: the relation a link
        establishes; the md:link NODE is its occurrence in the text and via_id
        points at it — a frontmatter link has a row and no node)
  - bare fields      = doc_id (the SOURCE doc), block_id (the source block; null
                       for a frontmatter edge), via_id, dst_id (the destination
                       node id: a doc id, an external node id or phantom:<path>),
                       dst_path (target doc path, /-rooted; NULL when
                       dangling/external), uri (external URL; NULL otherwise),
                       predicate ("references"/"embeds"/freeform), provenance
                       ("link"/"frontmatter"/"inline_field"/…), dst_kind
                       ("document"/"external"/"collection"), anchor, field (the
                       frontmatter key / inline field it was authored in).
  - attributes       = id, path (the SOURCE doc's path); doc.<key> reaches the
                       source document. There is no from_commit: a query sees
                       open edges only (history is blocks_history/changes_since).
  - text()/semantic() are N/A on links.

## Scoping (ADR-015; the root row since surface 2.0): bare names are LOCAL

  name          the CURRENT row only — never falls through to an enclosing row
                or the repository; an absent field is simply absent.
  ^name         one scope OUT (the enclosing row's fields/intrinsics/lifts);
                ^^name two scopes out. \`^path\` = the enclosing row's path.
  ^docs ^nodes ^blocks ^links
                THE ROOT ROW (surface 2.0, oqx 0.18): the repository is the root
                scope's row, one scope out from a top-level row, so ^docs there is
                the whole documents scan (uncorrelated until you add a ^ predicate);
                one caret per enclosing block (^^docs from depth two), or the
                absolute 0^docs from ANY depth. ^id / 0^id = the repository id.
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
  $key          the row's identity (0.20): a store row's id (doc/block/node/edge), an entries(x)
                entry's key, a follow occurrence's walk identity; project $key: <expr> to rekey the
                rows a block yields (a destination block's $key: is not a column).

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
               fold with .lower(): title.lower().contains("aurora").
               Infix regex: x ~ "re" is x.matches("re"); x ~* "re" is the
               case-insensitive match; x !~ "re" and x !~* "re" negate them.
               Unanchored unless the pattern anchors; an absent x is false
               under ~ and TRUE under !~ (not SQL's NULL).
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
                       desc\` for top-K. Needs a provider that has embedded the repository; else provider_unavailable.
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
                       path is already the reference form, so
                       ^docs { where ^path in list(after) } is
                       "the documents whose \`after\` names me".
  A HIT IS A STORE ROW: a top-level row that is not a doc/block/node/edge fails
                       (filter_invalid). \`follow before\` over a list of paths
                       reaches the STRINGS — write \`follow refs(before)\`.

## Nested queries & consumers

  <receiver> collect|exists|none|count|first|single { <block> }
    receiver = a relation (nodes, blocks, doc.out_links, section.blocks, …), a
               reach-through row (dst, doc: one row — dst { title }), a
    list property (tags), entries(x), or a root collection (^docs; 0^docs at depth ≥ 2).
    block    = [select …] [from E] [where …] [frontier …] [follow …] [order by …] [limit N] [offset N]
               — the same fixed order as the top level (\`from\` optional; the
               receiver supplies the rows). A leading name/alias list is the
               projection (\`select\` dropped); a predicate always needs \`where\`.
               A \`from E\` inside a block RE-PROJECTS the rows through a relation
               (a typed flatMap): \`docs collect { from nodes where kind == "md:task" }\`
               starts at docs, projects each through \`nodes\`, and queries the
               resulting nodes; a scalar relation (\`from doc\`) contributes one
               row; a missing or non-navigable relation is a loud error, never a
               global scan.
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
            select path, open from docs where nodes collect { ^open: value where kind == "md:task" and not checked }
  joins     ^<t> exists { where slug == ^ref }  semi-join; not … exists  anti-join;
            ^nodes single { where kind == "person" and attrs.id == ^owner_id }  lookup;
            x in ^keys  membership over a lifted set.

## select — projection

  select a, alias: expr, nested: nodes collect { … }
  bare key → the attribute when it is one (id, path, title, …), else the property
  (scalar-authored → scalar; list → array); data.<k> forces the property;
  a call/arithmetic needs an alias (n: size(tags)) unless in values mode;
  an output key of id/path other than the attribute itself needs an alias.
  raw         whole file bytes (docs) — docs_read is cheaper for one doc.
  distinct    select distinct type   (dedup hits by projected value)
  values      select <ONE item> values → bare values instead of records:
                select distinct type values from docs          → values: ["hub","lab-note",…]
                select path values from docs                   → values: ["/index.md", …]
                tags: tags collect { $it values }             → a plain array
                h: nodes first { name values where kind == "md:section" order by first_ordinal }
  entries(x)  a record as a collection ($key / $it per entry), key order:
                select fm: entries(data) collect { k: $key, v: $it }
                where entries(frontmatter) exists { where $key == "era" and $it > 1600 }
                entries(inline), entries(attrs), a nested map, or a list (index keys)
  $semantic_score is not a field — project semantic("…") under an alias instead.

## order by, limit/offset, pagination

  order by era desc, path asc      absent values sort LAST (asc); ties → (path, id)
  limit N / offset N               define the result SET (integer literals);
                                   the tool's limit/cursor then page WITHIN it
  cursor                           opaque keyset on (path,id); a custom order by
                                   disables it (you get the top page + truncated)

## Graph traversal (follow) and links

  The citation graph is the LINK ROWS walked through a destination block:
  dst is a link's destination document (absent for an external or dangling
  link — it then contributes no successor), doc its source.
  from docs where <seed> follow out_links collect { from dst }     docs the seed links TO
  from docs where <seed> follow in_links collect { from doc }      backlinks
    follow out_links collect { from dst depth 3 }                  bound (1..8, default 8) — a clause of the block
    follow out_links collect { from dst where layer == "canon" }   keep only matching successors
    follow in_links collect { from doc where ^path in list(before) }   ^ = the row being expanded
                                                   (^^ = the walk's enclosing scope)
    follow out_links collect { from dst where predicate == "depends_on" }   one predicate only
    follow out_links collect { from dst }, in_links collect { from doc }
                                                   several destinations: their union
                                                   (one step dedups by identity)
    follow ^docs { where out_links exists { where dst_path == ^^path } }
                                                   a destination block over the root's
                                                   documents, re-read per frontier row
                                                   (^ = that row) = the backlinks walk
    follow out_links collect { from dst frontier type == "practitioner" }   cut, keeping the frontier row
    from docs where type == "process" frontier !verified follow out_links collect { from dst }
                                                   the BODY's frontier applies to the seeds:
                                                   an unverified seed is kept, not expanded
    follow distinct out_links collect { from dst } / … { $key: group from dst }   identity control ($key)
    follow refs(before), ^docs { where ^path in list(after) }    forward over \`before\`, backward
                                                   over every doc whose \`after\` names me
  Per-occurrence metadata: $depth (seed = 1), $stop (interior|leaf|frontier|
  depth|cycle), $leaf/$frontier, $ordinal (a deterministic 1..N rank over the
  walk, ordered by depth then path — \`order by $ordinal\` for walk order,
  \`where $ordinal <= N\` for a deterministic budget cut), $key — usable in
  select/order by and the top-level post-walk where (a where conjunct that
  reads one filters the walk's RESULT; the other conjuncts remain the seed
  predicate), NOT metadata of the candidates a destination block's where reads,
  nor valid inside a consumer directive. Cyclic graphs are safe: a revisited
  node is admitted once as a \`$stop == "cycle"\` occurrence and never
  re-expanded. The default keeps one occurrence per distinct walk path;
  \`follow distinct\` dedups reached rows by identity.
  Destination blocks (OQX 0.20): a brace after ANY destination opens that
  destination's block — children { depth 2 }, refs(x) { depth 2 }, out_links
  collect { from dst depth 2 }, ^docs { where ^path in list(after) } — with the
  0.17 body rules (where-first, projections) and two clauses of its own after
  \`where\`: frontier <pred> (occurrences reached through this destination that
  match are frontiers; ^ there is the walk's enclosing scope) and depth <n>
  (this destination expands a frontier row only while $depth < n). The body
  that carries the follow may write frontier <pred> too, after its where and
  before follow: it applies to the SEEDS (read like the body's where) — a
  matching seed stays in the result with $stop == "frontier" and is not
  expanded; each destination's frontier is its own. There is no options block;
  the old \`by\` is $key. A bare follow ^docs (no brace, no consumer) is an
  error naming both block spellings.
  Type-preserving relations: block.children, section.children, section.subsections;
  the citation graph is out_links collect { from dst } / in_links collect { from doc }.
  from links where dst_path == "/notes/x.md"       inbound links to a doc, as rows
  select d: dst.title, k: dst_kind from links       the destination document's title
  from docs where out_links exists { where dst.layer == "draft" }   links into drafts
  select b: in_links collect distinct { from doc } from docs     backlinks as { id, path }
  select doc_id, dst_path from links where predicate == "depends_on"
  from docs where not doc.in_links exists { }      orphans (nothing links in)
  (The \`graph\` tool is a convenience wrapper that compiles to a follow query.)

## semantic grain

from docs ranks whole DOCUMENTS (one hit per file); from blocks ranks PASSAGES.
text()/where prune the candidate set; only order by reweights.

## Examples

  from docs where layer == "working"
  from docs where path.startsWith("/guides/") and updated_at >= "2026-08-01"
  select layer, tags from docs where "pricing" in list(tags)
  from docs where inline.owner == "alice"
  from docs where title.lower().contains("q3 plan")
  from docs where format == "yaml"
  from docs where type == "practitioner" order by era desc limit 2
  from docs where nodes none { where kind == "md:task" and not checked }
  from docs where tags exists { where $it == "tria-prima" }
  select fm: entries(data) collect { k: $key, v: $it } from docs where path == "/x.md"
  select owner_id, owner: ^nodes single { where kind == "person" and attrs.id == ^owner_id } from docs
  from blocks where type == "task" and not checked and under_heading("Launch") and doc.layer == "working"
  from blocks where type == "paragraph" and has_edge("references", "d_92aaaaa")
  select path, $depth from docs where path == "/timeline/review.md" follow refs(before), refs(after)
  select path, next: ^docs collect { path where ^path in list(before) } from docs where type == "milestone"
  select path, n: size(^docs), repo: ^id from docs limit 1
  select p: data.path, t: data.title from docs where has(data.path)
  docs { type == "substance" and not verified }
  select subject, process: ^docs[slug == ^subject]!.path from docs where type == "lab-note"
  select path, back: nodes first { select p: 0^docs collect { path where ^^path in list(after) } values } from docs where type == "milestone"
  select path, prior: refs(before) collect { path, when } from docs where type == "milestone"
  from blocks order by semantic("identity preservation across edits") desc limit 10
  select uri from links where dst_kind == "external"
  docs count { where layer == "canon" }

Common mistake: \`$path\`/\`$id\` (the 2.x spelling) — omgbase has no $ names; write
\`path\`/\`id\`. Another: \`where tags == "x"\` on a list-valued key is false — write
\`"x" in tags\`. Another: \`select data.path\` — alias it (\`p: data.path\`).
`;
