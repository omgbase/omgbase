// Agent-facing syntax reference, surfaced as the query_syntax MCP tool. Agents
// lean on it heavily before writing a non-trivial filter. It is a condensed,
// example-led distillation of docs/query-language.md — enough to compose a
// correct call without reading the normative spec. Kept in one place so the
// tool handler stays thin.

export const QUERY_SYNTAX = `# query — syntax reference

The \`query\` tool runs structured retrieval over one target. Modes intersect (AND):
\`filter\` (CEL), \`text\` (FTS5 keyword), \`semantic\` (embedding similarity). Results
are LEAN projected hits — always {id, path}, plus whatever \`select\` projects.
Hydrate full content by id via nodes_get.

## Targets & field namespaces

The sigil rule: \`$\`-prefixed names are engine intrinsics; BARE identifiers are
your content (metadata keys / block fields). A bare identifier whose FIRST
segment collides with an intrinsic base name (path/id/repo/updated_at/
content_hash/body) is REJECTED with a "did you mean \$X?" hint — it is almost
always a typo for the intrinsic (bare \`path\` would silently read an absent
frontmatter key and match nothing). Force the property with \`frontmatter.<k>\`.
The exceptions are \`title\`/\`tags\`: their \$-forms are computed (H1 / body
#hashtags) and do NOT shadow authored frontmatter, so bare \`title\`/\`tags\`
stay frontmatter-key access.

docs:
  - bare identifier  = a document PROPERTY key (nested via dots: meta.owner).
                       Bare keys span the AUTHORED sources — frontmatter and
                       inline (dataview-style key:: value) — unioned. For
                       markdown a bare key is usually a frontmatter key; YAML/JSON
                       docs expose the parsed object's keys the same way.
  - source-scoped    = frontmatter.<k> / inline.<k> narrow a property to one
                       authored source (e.g. inline.owner == "alice").
  - computed         = $title (first H1), $tags (body #hashtags) — engine-derived
                       $-intrinsics. They do NOT shadow an authored title/tags
                       key: $title is the H1, title is the frontmatter value.
  - intrinsics       = $id, $path, $repo, $updated_at (ISO-8601, sorts
                       chronologically), $body, $content_hash
  - link-graph       = there are NO CEL link predicates. Traverse the authored
                       link graph with OQX \`follow doc.out\` / \`follow doc.in\`
                       (see "Link-graph traversal" below), or query the \`edges\`
                       target / the doc.out_edges / doc.in_edges relations.

blocks:
  - bare fields      = type, text, attrs.<key> (attrs.checked, attrs.lang, ...)
  - intrinsics       = $id, $doc, $path, $ordinal, $depth, $updated_at,
                       $content_hash (projectable in select — the block's OWN
                       raw hash, i.e. the value update/split expect; not the
                       containing doc's)
  - doc reach-through= doc.<key> reads the CONTAINING doc's properties
                       (e.g. doc.layer == "canon"); doc.$path / doc.$title etc. work

edges:  (the authored link graph as first-class rows — one row per open edge)
  - bare fields      = predicate ("references"/"depends_on"/… — freeform, or the
                       reserved "references"/"embeds"), provenance
                       ("link"/"frontmatter"/"inline_field"/…), dst_kind
                       ("document"/"external"/"collection"), anchor, src_field
  - intrinsics       = $id (edge id), $src (source doc id), $dst (raw target node
                       id), $dst_path (target DOCUMENT's path, NULL if unresolved
                       / external — dangling links show NULL), $dst_uri (external
                       URL, NULL if not external), $src_block, $via, $from_commit
  - $path / doc.<key>= reach the SOURCE document (edges scan joins their src_doc):
                       $path is the source path; doc.layer reads its frontmatter
  - relations        = a doc's edges via doc.out_edges / doc.in_edges (backlinks);
                       predicate-filter a follow walk with follow doc.out { via
                       predicate == "depends_on" }. text()/semantic() are N/A here.

## CEL subset

  comparisons  ==  !=  <  <=  >  >=      (one side must be a literal)
                                         (matches only a SINGLE-VALUED key: one
                                          scalar value in scope. A list, a
                                          repeated inline key, or a bare key that
                                          collides across frontmatter + inline is
                                          multi-valued → use list(). A lone inline
                                          key:: value IS scalar-comparable.)
  boolean      &&  ||  !
  grouping     ( ... )
  membership   "v" in list(field)        (field may be scalar OR list; the way
                                          to match any multi-valued key)
  functions    has(f)                     field exists (the explicit presence test)
               size(x)                    string length / list length
               contains/startsWith/endsWith  free or method form:
                 $path.startsWith("guides/")   x.contains("s")
               matches("^re$")            RE2 regex — NOT yet wired (errors
                                         filter_invalid); use contains/startsWith/
                                         endsWith for indexed substring matches
               text("terms")             full-text (FTS5) match — a PRUNING predicate,
                                         not a ranker; blocks/nodes match their own
                                         text, docs match when any block does
               semantic("phrase")        embedding cosine SCORE vs the phrase (docs/blocks
                                         only); a value — threshold it (semantic("x") > 0.6)
                                         or project it; ORDER BY does the ranking. Needs an
                                         embedding provider; absent ⇒ semantic_unavailable
  literals     "str"  'str'  123  1.5  true  false  null

NOT supported (→ filter_invalid): arithmetic (+ - * /), ternary, list/struct
literals, bare \`in\` without list(), now()/clock/random (determinism is required).

## Absence semantics (memorize this)

A missing key NEVER matches and NEVER errors:
  - any comparison on an absent field (incl. !=) → FALSE
  - bare \`f\` in boolean position               → FALSE;  \`!f\` → TRUE
  - "v" in list(missing)                        → FALSE (list = [])
  - has(f)                                      → the explicit existence test

## Structural functions (blocks target only)

  under(id_or_locator)        block in the containment subtree / section range
  under_heading("Launch")     an ancestor section heading contains the text
  within("path" | "d_..")     containing doc = id, exact path, or path glob (*)
  has_edge("pred" [, target]) an open authored edge with that predicate leaves here
  has_anchor()                block carries an authored ^ref
  parent_type() == "x"        parent block's type (must be compared)
  child_count() > 0           number of direct children (must be compared)

## Link-graph traversal (OQX \`follow\`, not CEL predicates)

There are NO CEL link predicates: $in / $has / $links / $backlinks are NOT
wired — they error as filter_invalid (unknown function). Walk the authored
citation graph with the OQX \`follow\` operator over the doc→doc relations
\`doc.out\` / \`doc.in\`, or read the edges directly:

  from docs where <seed> follow doc.out    docs the seed links TO (outgoing)
  from docs where <seed> follow doc.in     docs that link to the seed (backlinks)
    follow doc.out { depth N }              bound the walk (1..8, default 8)
    follow doc.out { via predicate == "depends_on" }   restrict the licensing
                                            edge by predicate/provenance
    follow doc.out { where layer == "canon" }   keep only matching successors
  from edges filter: $dst_path == "notes/x.md"   inbound edges to a doc (as rows)
  from edges filter: predicate == "depends_on"    the edge graph directly

A doc's own edges are also reachable as relations: doc.out_edges (leaving) /
doc.in_edges (arriving/backlinks), e.g. \`doc.in_edges exists { }\` tests for any
backlink. (The \`graph\` tool is a convenience wrapper that compiles to a
\`follow doc.out\`/\`doc.in\` query for the neighborhood around root docs.)

## select — projection (avoids N hydration round-trips)

Project fields onto each hit. Default hit is {id, path}. select adds:
  - bare key            → that property value from the doc  ("layer","type","tracking")
                          (scalar-authored → scalar; list-authored → array)
  - on blocks           → also "type", "attrs.<k>", "$ordinal"
  - "$body"             → whole reconstructed file bytes (docs target only;
                          same content docs_read returns). For a single doc,
                          docs_read is cheaper than a $body query.
  - "$semantic_score"   → cosine similarity to the query vector, 1 = identical
                          (semantic queries only). Ordering is by this cosine;
                          text/filter only prune candidates, they don't reweight.
Absent keys are simply omitted from the hit.

## semantic grain (docs vs blocks)

\`semantic\` scores at the TARGET's grain. from=docs ranks whole DOCUMENTS by a
per-document embedding — "which document is about X", one hit per file (never
several blocks of the same file). from=blocks ranks PASSAGES — "which block is
about X". Pick docs to find the right note, blocks to find the right passage
within notes. text/filter prune the candidate set (AND); they never reweight.

## order & pagination

  order: ["$path", "-$updated_at"]   (- = descending; ties break by $id)
  limit + opaque cursor; each result carries {truncated, cursor}.

## Examples

  from=docs       filter: layer == "working"
  from=docs       filter: $path.startsWith("guides/") && $updated_at >= "2026-08-01"
  from=docs       filter: "pricing" in list(tags)      select: ["layer","tags"]
  from=docs       filter: inline.owner == "alice"       (only inline key:: fields)
  from=docs       filter: $title == "Q3 Plan"           (computed: first H1)
  from=docs       filter: "urgent" in list($tags)       (computed: body #hashtags)
  from docs       where !doc.in_edges exists { }        (orphans — nothing links in)
  from docs       where $id == "d_92aaaaa" follow doc.out   (walk outgoing links)
  from=blocks     filter: type == "task" && !attrs.checked && under_heading("Launch") && doc.layer == "working"
  from=blocks     filter: type == "paragraph" && has_edge("references", "d_92aaaaa")
  from=blocks     semantic: "identity preservation across edits"   select: ["$ordinal","$semantic_score"]
  from=edges      filter: predicate == "depends_on"     select: ["$src","$dst_path"]
  from=edges      filter: dst_kind == "external"        select: ["$dst_uri"]
  from=edges      filter: dst_kind == "document" && provenance == "link"   (dangling ⇒ $dst_path is null)

Common mistake: writing \`path.startsWith(...)\` (bare) meant the intrinsic. This
now fails loud (bare \`path\` collides with the intrinsic base name) with a hint
to use \`$path\` — no more misleading empty result. Use the intrinsic \`$path\`.
`;
