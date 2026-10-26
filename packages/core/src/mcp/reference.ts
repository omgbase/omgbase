// Agent-facing syntax reference, surfaced as the query_syntax MCP tool. Agents
// lean on it heavily before writing a non-trivial query. It is a condensed,
// example-led distillation of docs/query-language.md — enough to compose a
// correct call without reading the normative spec. Kept in one place so the
// tool handler stays thin. Semantics are the @omgbase/oqx contract (ADR-013);
// when this text and the corpus (corpus/oqx/alchemy.test.ts) disagree, the
// corpus wins.
//
// Three texts (spec/surface §4 `query_syntax`, 5.1): `QUERY_SYNTAX_CARD` is
// what `query_syntax {}` returns — a ~3 kB card an agent can hold in context
// (the 2026-10-21 agent-bench fetched the 38 kB manual twelve times and
// replayed it as cached prefix on every later turn); `QUERY_SYNTAX` is the
// whole manual (`section: "all"`); `querySyntaxSection(slug)` is one chapter of
// it, by the slugs of `QUERY_SYNTAX_SECTIONS` (the manual's `##` headings). The
// Rust twin (`crates/omgbase-surface/src/reference.rs`) mirrors all three byte
// for byte; its tests compare against this file.

export const QUERY_SYNTAX = `# query — OQX syntax reference

The \`query\` tool takes ONE plain OQX string (+ optional \`limit\`/\`cursor\`, and
\`bare: true\` to drop the automatic \`_id\`/\`_path\` envelope — needs a \`select\`).
There is no {from, filter, order} envelope: every concern is a clause of the
string. Two rules tell the two syntaxes apart: DOT navigation belongs to the
host object model (\`_doc.layer\`, \`_section._blocks\`, \`_dst._title\`); WHITESPACE
query directives belong to OQX — a nested query is \`<receiver> collect|exists|
count|first|single { <block> }\` (a postfix directive + a \`{ … }\` block), never a
method. Its distinctive power is the receiver-constrained nested query that
correlates to the current row: \`docs { _nodes exists { _kind == "md:task" } }\`
returns only the docs that themselves contain a matching node.

  <target> { [select <items>] [where <pred>] [frontier <pred>] [follow <dest> [{ … }], …]
             [flatten <expr> [{ … }] [as <name>]]… [group by <key>, …] [having <pred>]
             [order by <expr> [asc|desc], …] [limit N] [offset N] }
  <target> count|exists|none|first|single { <block> }     (a scalar or one row; <target> is docs, blocks, nodes, links or revisions)

THE COLLECTION HEADS THE BODY (OQX 0.26): \`docs { … }\` reads the documents and
shapes them with the clauses inside the braces; a consumer word between the
target and the brace (\`docs count { … }\`) shapes the whole result; nothing may
follow the closing brace. The pre-0.26 clause form \`select … from docs where …\`
is still read as the same query — write the braces.
CLAUSE ORDER IS FIXED: select, from, where, frontier, follow, flatten, group by, having, order by, limit, offset —
each at most once (\`flatten\` may repeat; \`from\` inside a body RE-PROJECTS the
rows through a relation, see Nested — it never names the source); an
out-of-order clause is a parse error naming the order.
Only \`select\` may drop its keyword, and only as the first clause
(\`docs { _path, era where … }\`). A body may LEAD with a predicate — \`docs { era
> 1600 }\` filters (see Sugar) — but a predicate after a projection still needs
the keyword (\`{ _name where _kind == "md:task" }\`, not \`{ _name, _kind ==
"md:task" }\`); in the clause form a top-level predicate needs \`where\` (\`era >
1600 from docs\` is the clause-order error), and \`from docs count\` is an error
(write \`docs count { … }\`). Every clause that reads a body's rows — \`where\`,
\`order by\`, \`follow\`, \`group by\` … — and the later \`select\` items may use the
body's \`select\` aliases (\`docs { select _path, old: era < 1000 where old order by
old }\`; an alias shadows a same-named field; a nested block reads it as \`^old\`).
\`and\` / \`or\` / \`not\` are the connectives;
the symbols \`&&\` / \`||\` / \`!\` are accepted synonyms (the words are canonical and
what \`print\` writes). Comments (OQX 0.28): \`// to the end of the line\` and
\`/* across lines */\` are whitespace anywhere between tokens (not inside a string
or a template's text); \`#\` is not a comment.

## Sugar (OQX 0.17)

Every form here is shorthand for an explicit directive (the AST is the explicit form):
  nodes { _kind == "md:task" }       ≡ nodes collect { where _kind == "md:task" } — a receiver block with
                                       no consumer is collect; a block whose LEADING expression is a predicate
                                       (comparison, call, !/is/not, in, literal, (…), a consumer test — anything
                                       but a bare name, a dotted path or a ^lift) is where-first. Names still
                                       project: _nodes { _name } ≡ _nodes collect { _name }; filter a bare field with
                                       _nodes { is checked }. Wherever a value stands (0.20), call arguments included:
                                       size(_children { is checked }); x distinct { … } ≡ x collect distinct { … }. After a
                                       follow destination too: follow _children { depth 2 } is that destination's block.
  (a, b)                              a tuple (0.20): two or more expressions, concatenated one level flat — a value
                                       (size((tags, aliases)), "x" in (tags, aliases)) and a receiver ((a, b) { … },
                                       follow (before, after) { depth 2 }); (a) alone is grouping
  refs(x)[0]                          ≡ refs(x) first { offset 0 }   positional (integer literal or \${binding});
                                       out of range ⇒ absent; refs(x)[0]._path navigates the row
  ^docs[_path == ^company]            ≡ ^docs first { where _path == ^company }   first match or absent
  ^docs[_path == ^company]!           ≡ … single { … } required: exactly one, else filter_invalid
  _title!                             required: _title, or an error naming the expression (and the row's $key — its _id)
                                       — never a filter, never a coercion (0!, ""! are values); tightest: a!.b vs a.b!
  is x / not x                        truthiness of x, and its negation (prefix; \`not\` ≡ \`!\`)
  x is y / x is not y                 identity ($key: a store row's id, else structural) — compares rows, which == does not;
                                       x is null = absent; for scalars is ≡ ==; comparison precedence, no chaining
  a and b / a or b                    the connectives (≡ && / ||: same precedence, short-circuit, value: title or _title coalesces)
  boss: ^docs[_path == ^manager], bossName: boss._title   a select item may use the items to its LEFT
  Reserved words (never a bare field name): from where select is not and or, true false null.
  Contextual words (limit order offset follow collect count first distinct desc by in frontier depth group having
  flatten as) parse as fields in expression position (docs { select o: order }).

Results are LEAN hits — { _id, _path } + whatever \`select\` projects (or \`values\`,
\`count\`, \`exists\`, \`none\`). The envelope keys ARE the attributes: copy a hit's
\`_id\` straight into \`where _id == "…"\` (no translation); \`select _id, _path\` is
simply the envelope (no duplicate columns); an alias \`_id:\`/\`_path:\` on any OTHER
expression is refused — \`blocks { select _path: _doc._path }\` fails ("projection
\`_path\` collides with the hit envelope — alias it (\`p: _doc._path\`)"); a row
surfacing as a value (an empty \`collect { }\`) is the same \`{ _id, _path }\`. Every
other tool spells a row the same way (\`docs_read\` → \`{ _id, _path, rev, properties,
_raw }\`, \`blocks_read\` → \`{ _id, _type, _text, _raw, _hash, … }\`, \`docs_list\` → \`{ _id,
_path, _updated_at, blocks }\`, a revision → \`{ _id, _path, _hash }\`): hydrate by \`_id\`
via blocks_read/docs_read.

## Paths

Every path the surface returns is \`/\`-rooted — the form a reference is
written in (\`[x](/projects/oqx.md)\`, \`before: [/timeline/kickoff.md]\`): a
hit's \`_path\`, an edge's \`_dst_path\`, every tool's paths. Every path it
accepts tolerates both forms (\`/a.md\` or \`a.md\`): tool arguments, \`refs(x)\`,
\`within(...)\`, and a string LITERAL compared with \`_path\`/\`_dst_path\` (on the row,
or through a row handle: \`_doc._path\`, \`_dst._path\`, \`$it._path\`) by \`==\`/\`!=\` or
passed to their \`.startsWith(...)\` (it is rooted first, so \`_path == "a.md"\` and
\`_path == "/a.md"\` both match). A property holding a reference compares directly —
and is never rooted: \`where ^_path in list(after)\`, \`where customer == ^_path\`,
\`where path == "/x.md"\` (YOUR authored \`path:\` key — the bare name — compared as
written) — no \`"/" + ...\` glue.

## Targets & field namespaces

THE NAME RULE — one rule on every record kind: a BARE name is YOURS (an authored
property: frontmatter + inline on a doc, an attrs key on a block or node), an
UNDERSCORE-prefixed name is the ENGINE's (however derived: \`_id\`, \`_path\`,
\`_title\`, \`_updated_at\`, \`_doc\`), and \`$\` belongs to OQX — $it, $key, $depth,
$stop, $leaf, $frontier, $ordinal are values the LANGUAGE injects into a scope;
omgbase adds NO $ names (a \`$id\` in a query is an unknown name, absent). Nothing
bare is reserved: \`title\`, \`tags\`, \`path\`, \`id\`, \`format\`, \`doc\` are your keys
when you wrote them. Collections stay bare (\`docs { … }\`, \`^docs\`, \`docs count { … }\`,
\`entries(^$it)\`) — the collection before a body is a root, not a row property — and so do the
row functions in call position (\`text("x")\`, \`under(…)\`, \`refs(x)\`): a call is
never an entry read. There is NO self alias (the 4.x \`doc\`/\`block\`/\`section\`):
\`$it\` is the self, and \`_doc\`/\`_block\`/\`_dst\` reach ANOTHER row. So \`_path\` is the
engine's /-rooted location and \`path\` your \`path:\` key; \`_tags\` is your tags ∪ the
body #hashtags and \`tags\` the authored list alone; \`_title\` the computed title (the
first H1) and \`title\` your \`title:\`; \`_data.<k>\` ≡ \`<k>\` (the merged authored view —
kept for \`entries(_data)\` and to reach an authored key that itself starts with
\`_\`), \`_frontmatter.<k>\` / \`_inline.<k>\` one source each. Same value, same name
everywhere: a hit's \`_id\` is docs_read's \`_id\` and the \`_id\` argument of blocks_read.

  Engine names per kind (attributes | handles | relations):
    docs    _id _path _raw _hash _updated_at _created_at _title _tags _format | _data _frontmatter _inline | _blocks _nodes _out_links _in_links _revisions
    blocks  _id _path _doc_id _raw _hash _updated_at _created_at _type _text _attrs _depth _ordinal | _doc | _children _nodes _out_links _section
    nodes   _id _path _doc_id _block_id _kind _name _value _attrs | _doc _block | _blocks _subsections _children
    links   _id _path _doc_id _block_id _via_id _dst_id _dst_path _uri _field _dst_kind _predicate _provenance _anchor | _doc _dst _block | —
    revisions  _id _path _rev _seq _doc_id _commit _ts _origin _actor _reason _hash _is_current _archived | _doc | —
    root    _id (^_id, 0^_id) | — | docs blocks nodes links revisions
  Every bare name is yours; \`_attrs.<k>\` on a block or node is the same read as
  the bare attrs key \`<k>\`.
  UNKNOWN NAMES: a bare name that no object of the kind in this repository
  carries is a property read that yields absent — on docs/blocks/nodes the result
  gains \`hints\` (one line per name, the nearest match drawn from your keys and the
  engine names: "no document in this repository carries a property \`title\`; did
  you mean \`_title\`?") and the rows still come back; in a plan/apply/execute
  selector it is refused. On links and revisions (closed: no authored data reaches
  them) a bare name is a filter_invalid error. A \`_x\` that is no engine name of
  the kind is filter_invalid naming the kind's engine names. A property some
  objects carry is known (partial presence is normal).

docs:
  - bare identifier  = a document PROPERTY (frontmatter + inline \`key:: value\`,
                       unioned; nested via dots: meta.owner). YAML/JSON docs
                       expose the parsed object's keys the same way. Nothing is
                       reserved: \`title\`, \`tags\`, \`path\`, \`id\` are your keys.
  - source handles   = _data.<k> (the merged authored view — the same read as the
                       bare key) / _frontmatter.<k> / _inline.<k>; the whole bag
                       as a collection via entries(_data) / entries(_frontmatter)
                       / entries(_inline) (see entries()).
  - attributes       = _id, _path (/-rooted, see Paths), _updated_at (ISO-8601,
                       sorts chronologically), _created_at, _raw (the whole file,
                       frontmatter included), _hash (its sha256, 64 hex), _title
                       (the computed title: the first H1; \`title\` is the authored
                       key), _tags (authored tags ∪ body #hashtags, deduped,
                       authored first; \`tags\` is the authored list), _format (the
                       doc's format — "markdown"/"yaml"/"json"; present on EVERY
                       doc, so has(_format) is always true and \`_format == "yaml"\`
                       is the filter).
  - relations        = _nodes, _blocks, _out_links / _in_links (a doc's links as
                       rows; the documents at their other end are
                       _out_links distinct { from _dst } and
                       _in_links distinct { from _doc } — there is no
                       out / in relation), _revisions (the document's stored
                       revisions, oldest first — see revisions below).

blocks:
  - bare fields      = every attrs key FLATTENED onto the row (bare \`checked\`;
                       \`_attrs.<k>\` is the same read; absent ⇒ false) — a block's
                       authored side.
  - attributes       = _id, _path (the owning doc's path), _doc_id (the owning
                       doc), _type, _text (normalized), _ordinal (0-based among
                       siblings), _depth (0 at the top level), _raw (the block's
                       raw source — a container's raw holds its children), _hash
                       (its sha256 — the value update/split expect as
                       expect.content_hash), _updated_at, _created_at, _attrs.
  - reach-through    = _doc.<key> / _doc._path / _doc._id / _doc._format = the
                       CONTAINING doc (_doc._id and _doc._path cost nothing — they
                       read the row's own _doc_id / joined path, no lookup).
  - relations        = _children, _nodes, _out_links, _section (no self alias:
                       the 4.x \`block.children\` is \`_children\`).
  NOTE: inside a \`follow\`, $depth/$ordinal are ALWAYS the walk's metadata; a
  block's own nesting is \`_depth\` / \`_ordinal\` everywhere.

nodes:
  - bare fields      = the attrs keys flattened onto the row (checked, level,
                       first_ordinal; \`_attrs.<k>\` is the same read).
  - attributes       = _id, _path, _doc_id, _block_id (null for a block-less
                       node), _kind (md:task / md:link / md:section / yaml:…),
                       _name, _value, _attrs.
  - reach-through    = _doc.<key> / _doc._id / _doc._path, _block._type /
                       _block._text / _block._id / _block._path.
  - relations        = _blocks, _children, _subsections (a section node's; the
                       4.x \`section.blocks\` is \`_blocks\`).

links:  (the authored link graph as rows — one per open link: the relation a link
        establishes; the md:link NODE is its occurrence in the text and _via_id
        points at it — a frontmatter link has a row and no node)
  - attributes       = _id, _path (the SOURCE doc's path), _doc_id (the SOURCE
                       doc), _block_id (the source block; null for a frontmatter
                       edge), _via_id, _dst_id (the destination node id: a doc id,
                       an external node id or phantom:<path>), _dst_path (target
                       doc path, /-rooted; NULL when dangling/external), _uri
                       (external URL; NULL otherwise), _predicate
                       ("references"/"embeds"/freeform), _provenance
                       ("link"/"frontmatter"/"inline_field"/…), _dst_kind
                       ("document"/"external"), _anchor, _field (the
                       frontmatter key / inline field it was authored in).
  - reach-through    = _doc.<key> (the source document), _dst.<key> (the
                       destination document; absent when dangling/external),
                       _block.<key> (the source block). Closed: links carry no
                       authored data, so a bare name is filter_invalid. There is
                       no from_commit: a query sees open edges only (history is
                       blocks_history/changes_since).
  - text()/semantic() are N/A on links.

revisions:  (history as rows — one per stored revision of every document of the
        repository, deleted documents included: what docs_history lists, queryable)
  - attributes       = _id (the revision id, r_…), _rev (= _id), _seq (1, 2, … per
                       document), _doc_id, _commit, _ts (the commit's time, sorts
                       chronologically), _origin ("observed"/"api"/"import"/
                       "projection"), _actor, _reason, _hash (the rendered file's
                       sha256 — docs_history's _hash), _is_current (true for the
                       document's current revision), _archived (true when the
                       bodies moved to an archive segment: the row stays,
                       docs_read { at } reads through the segment), _path (the
                       path the revision was committed under — a move re-paths
                       only the current revision, so earlier ones keep the old
                       path).
  - reach-through    = _doc.<key> reaches the document's CURRENT row; absent for
                       a deleted document, so where _doc == null is the revisions
                       of deleted documents. Closed: a bare name is filter_invalid.
  - on docs          = _revisions is a relation (oldest first): a document with
                       more than one version is docs { _revisions count > 1 }.
  - text()/semantic() are N/A on revisions. The body as of a revision is
    docs_read { _path, at: "<rev>" } (docs_read_at is the same call).

## Scoping (ADR-015; the root row since surface 2.0): bare names are LOCAL

  name          the CURRENT row only — never falls through to an enclosing row
                or the repository; an absent field is simply absent.
  ^name         one scope OUT (the enclosing row's fields/intrinsics/lifts);
                ^^name two scopes out. \`^_path\` = the enclosing row's path.
  ^docs ^nodes ^blocks ^links ^revisions
                THE ROOT ROW (surface 2.0, oqx 0.18): the repository is the root
                scope's row, one scope out from a top-level row, so ^docs there is
                the whole documents scan (uncorrelated until you add a ^ predicate);
                one caret per enclosing block (^^docs from depth two), or the
                absolute 0^docs from ANY depth. ^_id / 0^_id = the repository id.
                ^$it = the root object: ^$it.docs ≡ ^docs, entries(^$it) names the
                five collections. At the root scope itself a bare target is the scan
                (docs { … }, docs count { … }, entries(docs)).
                ERRORS: a bare \`docs\` INSIDE a block reads a property of the current
                row, which has none — refused ("did you mean ^docs"); so is a bare
                \`blocks\`/\`nodes\`/\`revisions\` there (a doc's own relations are
                \`_blocks\`/\`_nodes\`/\`_revisions\`); \`^docs\` AT THE TOP LEVEL reaches
                past the root — refused (write the bare \`docs\`); so is \`$repo\`
                (surface < 2.0; the message names the replacement).
  $it           the current item itself (a row, or each ELEMENT when the
                receiver is a list property); ^$it = the enclosing row, ^$it._id
                its id. $value is NOT an intrinsic (since oqx 0.15): it reads a
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
               fold with .lower(): _title.lower().contains("aurora").
               Infix regex: x ~ "re" is x.matches("re"); x ~* "re" is the
               case-insensitive match; x !~ "re" and x !~* "re" negate them.
               Unanchored unless the pattern anchors; an absent x is false
               under ~ and TRUE under !~ (not SQL's NULL).
  functions    has(f)  size(x)  list(x)  entries(x)  range(s)
  dates        a date is an ISO string, a duration a NUMBER OF SECONDS; arithmetic
               is METHODS, never + or - (+ concatenates strings).
               date("today"|"now"|"yesterday"|"tomorrow"|"sow"|"eow"|"som"|"eom"|
               "soy"|"eoy") — the host clock, UTC; date("2026-10-15") canonical ISO
               (absent if unparseable). dur("1h30m") dur("2 days, 3 hours")
               dur("P1DT2H") dur(90) → seconds (year = 365 d, month = 30 d).
               d.plus(dur("30 days"))  d.minus(86400)  d.plus("1 month") (calendar:
               Jan 31 → Feb 28)  a.until(b) → signed seconds  d.year() d.month()
               d.day() d.weekday() (1 = Mon) d.hour() d.minute() d.second()
               d.date()  d.format("EEE dd MMM yyyy")  n.dur_text() → "1h 30m"
               n.dur_iso() → "PT1H30M". Total: a non-date is absent, so
               \`where date(due) < date("today").minus(dur("30 days"))\` just
               filters. A datetime is never < its own date: compare
               _updated_at.date() == date("today"), or < date("tomorrow").
  literals     "str" 'str' 123 1.5 true false null
  determinism  no random; the only clock is date("today"/"now"/…), read once per
               query. Lists/structs are not literals; ternary is not supported.
               Errors surface as filter_invalid.
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
                       _path is already the reference form, so
                       ^docs { ^_path in list(after) } is
                       "the documents whose \`after\` names me".
  A HIT IS A STORE ROW: a top-level row that is not a doc/block/node/edge fails
                       (filter_invalid). \`follow before\` over a list of paths
                       reaches the STRINGS — write \`follow refs(before)\`.

## Nested queries & consumers

  <receiver> collect|exists|none|count|first|single { <block> }
    The block may be omitted after a consumer word (OQX 0.26): the omitted block is
    the empty block — \`_nodes exists\`, \`_revisions count > 1\`, \`_blocks first\`,
    \`docs count\` as a whole query; \`x { }\` keeps its braces (the brace is what
    makes a collect). A projection block over a lookup is the lookup's projection:
    \`_blocks[0] { _text }\` ≡ \`_blocks first { _text offset 0 }\`.
    receiver = a relation (_nodes, _blocks, _doc._out_links, _section._blocks, …), a
               reach-through row (_dst, _doc: one row — _dst { _title }), a
    list property (tags), entries(x), or a root collection (^docs; 0^docs at depth ≥ 2).
    block    = [select …] [from E] [where …] [frontier …] [follow …] [flatten …] [group by …] [having …] [order by …] [limit N] [offset N]
               — the same fixed order as the whole query, whose body is a block
               too (the target is its receiver). A leading name/alias list is the
               projection (\`select\` dropped); a predicate needs \`where\` unless
               it LEADS the block (Sugar). A \`from E\` inside a block RE-PROJECTS
               the rows through a relation (a typed flatMap):
               \`docs { from _nodes where _kind == "md:task" }\` starts at docs,
               projects each through \`_nodes\`, and queries the resulting nodes;
               a scalar relation (\`from _doc\`) contributes one row; a missing or
               non-navigable relation is a loud error, never a global scan. \`from\`
               never names the source — the collection before the body does.
  exists    ≥1 row      _nodes exists { _kind == "md:task" and not checked }
  none      0 rows      _nodes none { _kind == "md:task" and not checked }  ("every task done")
  count     a number    _nodes count { _kind == "md:task" } >= 2
  collect   rows (default) — in select for nested results; in where with a lift
  first / single   zero-or-one (single errors on >1) — lookups in select
  distinct  on any consumer: dedup by projected value — _nodes count distinct { select _kind }
  limit/offset  bound the block's rows AFTER where/order/distinct, BEFORE the
            consumer reduces: _nodes exists { offset 1 } = at least two;
            first { … offset 1 } = the second.
  lift      \`^name:\` in a where-collect binds values outward:
            docs { select _path, open where _nodes { ^open: _value where _kind == "md:task" and not checked } }
  joins     ^<t> exists { slug == ^ref }  semi-join; not … exists  anti-join;
            ^nodes single { _kind == "person" and _attrs.id == ^owner_id }  lookup;
            x in ^keys  membership over a lifted set.

## select — projection

  select a, alias: expr, nested: _nodes collect { … }
  bare key → your property (scalar-authored → scalar; list → array); _name →
  the engine's field (_id, _path, _title, …); _data.<k> is the bare key's read;
  a call/arithmetic needs an alias (n: size(tags)) unless in values mode;
  an output key of _id/_path other than the attribute itself needs an alias.
  an alias names the row for every later clause (where, order by, follow,
  flatten, group by) and the items to its right; a nested block reads it as
  ^alias; an alias shadows a same-named field ($it.name reads the field).
  _raw        whole file bytes (docs) — docs_read is cheaper for one doc.
  distinct    select distinct _type   (dedup hits by projected value)
  values      select <ONE item> values → bare values instead of records:
                docs { select distinct type values }          → values: ["hub","lab-note",…]
                docs { select _path values }                   → values: ["/index.md", …]
                tags: tags { $it values }                     → a plain array
                h: _nodes first { _name values where _kind == "md:section" order by first_ordinal }
  entries(x)  a record as a collection ($key / $it per entry), key order:
                select fm: entries(_data) { k: $key, v: $it }
                where entries(_frontmatter) exists { $key == "era" and $it > 1600 }
                entries(_inline), entries(_attrs), a nested map, or a list (index keys)
  $semantic_score is not a field — project semantic("…") under an alias instead.

## flatten (OQX 0.25)

  flatten <expr> [{ … }] [as <name>]      after follow, before group by; may repeat
  Splits one value into rows. Every hit is still the PARENT row — its _id/_path
  repeat per element, as Dataview's TABLE … FLATTEN — with <name> bound beside
  its fields at the same depth: an array → one row per element (an empty list
  yields none), a missing field → one row with the name absent (never dropped),
  an object or a scalar → one row with the value. A plain navigation names
  itself (flatten tags rebinds tags to each element); anything else needs as.
  The block is the ordinary receiver block over the elements (where, a
  projection, order by, limit, distinct), applied first. Later clauses read the
  name — a later flatten (flatten jobs as j flatten j.tags as t), group by,
  having, select, order by; where runs before it. A flattened query pages by
  position (cursor null); as _id / as _path is refused (the envelope reads them).
    docs { select _path, tags where type == "process" flatten tags order by _path, tags }
    docs { select _path, t: b._text flatten _blocks { _type == "task" and not checked } as b }
    docs { select tags, n: count() flatten tags group by tags order by count() desc }

## order by, limit/offset, pagination

  order by era desc, _path asc     absent values sort LAST (asc); ties → (_path, _id)
  limit N / offset N               define the result SET (integer literals);
                                   the tool's limit/cursor then page WITHIN it
  cursor                           opaque keyset on (_path, _id); a custom order by
                                   disables it (you get the top page + truncated)

## Graph traversal (follow) and links

  The citation graph is the LINK ROWS walked through a destination block:
  _dst is a link's destination document (absent for an external or dangling
  link — it then contributes no successor), _doc its source.
  docs { where <seed> follow _out_links { from _dst } }     docs the seed links TO
  docs { where <seed> follow _in_links { from _doc } }      backlinks
    follow _out_links { from _dst depth 3 }                  bound (1..8, default 8) — a clause of the block
    follow _out_links { from _dst where layer == "canon" }   keep only matching successors
    follow _in_links { from _doc where ^_path in list(before) }   ^ = the row being expanded
                                                   (^^ = the walk's enclosing scope)
    follow _out_links { from _dst where _predicate == "depends_on" }   one predicate only
    follow _out_links { from _dst }, _in_links { from _doc }
                                                   several destinations: their union
                                                   (one step dedups by identity)
    follow ^docs { _out_links exists { _dst_path == ^^_path } }
                                                   a destination block over the root's
                                                   documents, re-read per frontier row
                                                   (^ = that row) = the backlinks walk
    follow _out_links { from _dst frontier type == "practitioner" }   cut, keeping the frontier row
    docs { type == "process" frontier !verified follow _out_links { from _dst } }
                                                   the BODY's frontier applies to the seeds:
                                                   an unverified seed is kept, not expanded
    follow distinct _out_links { from _dst } / … { $key: group from _dst }   identity control ($key)
    follow refs(before), ^docs { ^_path in list(after) }    forward over \`before\`, backward
                                                   over every doc whose \`after\` names me
  Per-occurrence metadata: $depth (seed = 1), $stop (interior|leaf|frontier|
  depth|cycle), $leaf/$frontier, $ordinal (a deterministic 1..N rank over the
  walk, ordered by depth then path — \`order by $ordinal\` for walk order,
  \`where $ordinal <= N\` for a deterministic budget cut), $key — usable in
  select/order by and the top-level post-walk where (a where conjunct that
  reads one filters the walk's RESULT; the other conjuncts remain the seed
  predicate), NOT metadata of the candidates a destination block's where reads;
  a consumer directive may carry a follow of its own (its block yields the
  walk: \`_children count { follow _children } > 5\`). Cyclic graphs are safe: a revisited
  node is admitted once as a \`$stop == "cycle"\` occurrence and never
  re-expanded. The default keeps one occurrence per distinct walk path;
  \`follow distinct\` dedups reached rows by identity.
  Destination blocks (OQX 0.20): a brace after ANY destination opens that
  destination's block — _children { depth 2 }, refs(x) { depth 2 }, _out_links
  { from _dst depth 2 }, ^docs { ^_path in list(after) } — with the
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
  Type-preserving relations: a block's _children; a section node's _children and
  _subsections; the citation graph is _out_links { from _dst } / _in_links { from _doc }.
  links { _dst_path == "/notes/x.md" }       inbound links to a doc, as rows
  links { select d: _dst._title, k: _dst_kind }       the destination document's title
  docs { _out_links exists { _dst.layer == "draft" } }   links into drafts
  docs { select b: _in_links distinct { from _doc } }     backlinks as { _id, _path }
  links { select _doc_id, _dst_path where _predicate == "depends_on" }
  docs { not _in_links exists }      orphans (nothing links in)
  (The \`graph\` tool is a convenience wrapper that compiles to a follow query.)

## semantic grain

docs { … } ranks whole DOCUMENTS (one hit per file); blocks { … } ranks PASSAGES.
text()/where prune the candidate set; only order by reweights.

## Examples

  docs { layer == "working" }
  docs { _path.startsWith("/guides/") and _updated_at >= "2026-08-01" }
  docs { select layer, tags where "pricing" in list(tags) }
  docs { _inline.owner == "alice" }
  docs { _title.lower().contains("q3 plan") }
  docs { _format == "yaml" }
  docs { type == "practitioner" order by era desc limit 2 }
  docs { _nodes none { _kind == "md:task" and not checked } }
  docs { tags exists { $it == "tria-prima" } }
  docs { select fm: entries(_data) { k: $key, v: $it } where _path == "/x.md" }
  docs { select owner_id, owner: ^nodes single { _kind == "person" and _attrs.id == ^owner_id } }
  blocks { _type == "task" and not checked and under_heading("Launch") and _doc.layer == "working" }
  blocks { _type == "paragraph" and has_edge("references", "d_92aaaaa") }
  docs { select _path, $depth where _path == "/timeline/review.md" follow refs(before), refs(after) }
  docs { select _path, next: ^docs { _path where ^_path in list(before) } where type == "milestone" }
  docs { select _path, n: size(^docs), repo: ^_id limit 1 }
  docs { select path, title where has(path) }
  docs { type == "substance" and not verified }
  docs { select subject, process: ^docs[slug == ^subject]!._path where type == "lab-note" }
  docs { select _path, back: _nodes first { select p: 0^docs { _path where ^^_path in list(after) } values } where type == "milestone" }
  docs { select _path, prior: refs(before) { _path, when } where type == "milestone" }
  blocks { order by semantic("identity preservation across edits") desc limit 10 }
  links { select _uri where _dst_kind == "external" }
  docs count { layer == "canon" }
  revisions { select _seq, _origin, _ts, _hash where _path == "/processes/calcination.md" order by _seq desc }
  docs { _revisions count { _origin == "api" } > 0 }
  revisions { select p: _path, d: _doc._path where _doc == null }
  docs { select layer, n: count(), titles: collect(_title), open: rows count { _nodes exists { _kind == "md:task" and not checked } } group by layer having count() > 1 order by count() desc }
  docs { select _path, tag: tags where "process" in tags flatten tags order by _path, tags }

Common mistake: \`$path\`/\`$id\` — omgbase has no $ names; the engine's location and
identity are \`_path\`/\`_id\`. Another: the 4.x bare \`path\`/\`id\`/\`title\`/\`tags\` — a
bare \`path\` is now YOUR \`path:\` key (absent when you wrote none, with a hint
pointing at \`_path\`); the engine's are \`_path\`/\`_id\`/\`_title\`/\`_tags\`; \`select
data.path\` is gone — write \`path\`. Another: \`where tags == "x"\` on a list-valued
key is false — write \`"x" in tags\`. Another: \`select _path: _doc._path\` — alias it
(\`p: _doc._path\`).
`;

/**
 * The manual's chapters (spec/surface §4 `query_syntax`, 5.1): one entry per
 * `## ` heading of `QUERY_SYNTAX`, in order — the `section` argument's names.
 * `querySyntaxSection(slug)` is the text from that heading up to the next one.
 * The Rust twin pins the same table (its test checks every pair against this
 * source).
 */
export const QUERY_SYNTAX_SECTIONS: readonly { slug: string; heading: string }[] = [
  { slug: "sugar", heading: "Sugar (OQX 0.17)" },
  { slug: "paths", heading: "Paths" },
  { slug: "targets", heading: "Targets & field namespaces" },
  { slug: "scoping", heading: "Scoping (ADR-015; the root row since surface 2.0): bare names are LOCAL" },
  { slug: "scalars", heading: "Scalar semantics (@omgbase/oqx)" },
  { slug: "predicates", heading: "Domain predicates (omgbase)" },
  { slug: "nested", heading: "Nested queries & consumers" },
  { slug: "select", heading: "select — projection" },
  { slug: "flatten", heading: "flatten (OQX 0.25)" },
  { slug: "order", heading: "order by, limit/offset, pagination" },
  { slug: "follow", heading: "Graph traversal (follow) and links" },
  { slug: "semantic", heading: "semantic grain" },
  { slug: "examples", heading: "Examples" },
];

/** The `section` names a caller may pass: every slug, then `all` (the whole manual). */
export const QUERY_SYNTAX_SECTION_NAMES: readonly string[] = [...QUERY_SYNTAX_SECTIONS.map((s) => s.slug), "all"];

/**
 * One chapter of the manual: the lines from `## <heading>` up to (not
 * including) the next `## ` heading or the end, trailing blank lines dropped,
 * one trailing newline. `"all"` is the whole manual; an unknown slug is `null`.
 */
export function querySyntaxSection(slug: string): string | null {
  if (slug === "all") return QUERY_SYNTAX;
  const entry = QUERY_SYNTAX_SECTIONS.find((s) => s.slug === slug);
  if (!entry) return null;
  const lines = QUERY_SYNTAX.split("\n");
  const start = lines.indexOf(`## ${entry.heading}`);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end]!.startsWith("## ")) end++;
  while (end > start + 1 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end).join("\n") + "\n";
}

/**
 * The card `query_syntax {}` returns (5.1): the grammar skeleton, the names
 * rule and the engine names per kind, the handles, the consumers, follow in
 * one line, the examples agents reach for first, and where the chapters are.
 * Every indented example parses (reference.test.ts extracts them exactly as it
 * extracts the manual's). Keep every line earning its place: this is the most
 * read text on the surface.
 */
export const QUERY_SYNTAX_CARD = `# query — OQX card. Chapters: query_syntax { section: "<name>" }; the manual: { section: "all" }

One OQX string; limit/cursor page the hits; bare: true drops the { _id, _path } envelope.
  <target> { [select <items>] [where <pred>] [follow <dest> { … }] [order by <expr> [desc]] [limit N] [offset N] }
  <target> count|exists|none|first|single [{ <block> }]   a scalar or one row; no block = the empty block (docs count)
The collection (docs blocks nodes links revisions) heads the body; nothing follows its closing brace.
CLAUSE ORDER IS FIXED: select, from, where, frontier, follow, flatten, group by, having, order by, limit, offset.
and / or / not. Comparisons strict and typed; null == a missing field. A list key: "x" in tags, never tags == "x".
Strings .contains("s") .startsWith("p") .lower(); x ~* "re" (ci regex), x !~ "re". Dates date("today"),
date(due) < date("today").minus(dur("30 days")), _updated_at >= "2026-08-01".

NAMES: a BARE name is YOURS (frontmatter, inline key:: value, a block's attrs); an UNDERSCORE name is the ENGINE's;
$ is OQX's ($it $key $depth $stop $ordinal). title tags path id are your keys; _title _tags _path _id the engine's.
  docs       _id _path _raw _hash _updated_at _created_at _title _tags _format | _data _frontmatter _inline | _blocks _nodes _out_links _in_links _revisions
  blocks     _id _path _doc_id _raw _hash _type _text _attrs _depth _ordinal | _doc | _children _nodes _out_links _section
  nodes      _id _path _doc_id _block_id _kind _name _value _attrs | _doc _block | _blocks _subsections _children
  links      _id _path _doc_id _block_id _via_id _dst_id _dst_path _uri _dst_kind _predicate _provenance _anchor _field | _doc _dst _block
  revisions  _id _path _rev _seq _doc_id _commit _ts _origin _actor _reason _hash _is_current _archived | _doc
Handles _data.<k> ≡ <k>, _frontmatter.<k> / _inline.<k>; entries(_data) the bag as rows ($key, $it). Reach-through
_doc.<k> the owning document, _dst.<k> a link's target. Scoping: a bare name is the CURRENT row; ^name one scope
out; ^docs ^blocks ^nodes ^links the repository from a row. An unknown bare name is absent plus a hints line.

NESTED: <receiver> collect|exists|none|count|first|single { [select …] [where …] [order by …] [limit N] } over a
relation, a list key, entries(x) or ^docs; no consumer = collect, a leading predicate = where: docs { type == "x" }.
FOLLOW: docs { where <seed> follow _out_links { from _dst depth 3 } }   links out; _in_links { from _doc }
backlinks; refs(before) a property's documents; $depth per row. SEARCH: text("words") prunes; order by semantic("…") desc.

  docs { layer == "working" }
  docs { select _title, stage where "process" in tags order by _path limit 5 }
  blocks { select _type, _text where _path == "/processes/calcination.md" }
  nodes { select _path, _value where _kind == "md:task" and not checked }
  links { select _path, _block_id where _dst_path == "/processes/calcination.md" }
  docs { _title.lower().contains("salt") and _updated_at >= "2026-01-01" }
  docs { _nodes exists { _kind == "md:task" and not checked } }
  docs { select _path, $depth where _path == "/timeline/review.md" follow refs(before), refs(after) }
  docs count { layer == "canon" }
  revisions { select _seq, _ts, _hash where _path == "/processes/calcination.md" order by _seq desc }
  docs { select tags, n: count() flatten tags group by tags order by count() desc }

Every error is filter_invalid naming what to change; when the engine can correct the call, data.fix IS the call.
Chapters: sugar paths targets scoping scalars predicates nested select flatten order follow semantic examples; all.
`;
