// Agent-facing syntax references, surfaced as MCP tools (query_syntax,
// graph_syntax). mrplex ships a query_syntax reference tool; agents lean on it
// heavily before writing a non-trivial filter. These are condensed, example-led
// distillations of docs/10-query-language.md and docs/05-graph-and-query.md —
// enough to compose a correct call without reading the normative specs. Kept in
// one place so the two tool handlers stay thin.

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
  - link-graph       = $in(glob), $has(glob), $links(), $backlinks() (+ _static)

blocks:
  - bare fields      = type, text, attrs.<key> (attrs.checked, attrs.lang, ...)
  - intrinsics       = $id, $doc, $path, $ordinal, $depth, $updated_at,
                       $content_hash (projectable in select — the block's OWN
                       raw hash, i.e. the value update/split expect; not the
                       containing doc's)
  - doc reach-through= doc.<key> reads the CONTAINING doc's properties
                       (e.g. doc.layer == "canon"); doc.$path / doc.$title etc. work

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
               matches("^re$")            RE2 (post-filter; pair with an indexed term)
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

## Link-graph predicates (docs target)

  $in("moc/**")               some doc matching the glob links TO this doc
  $has("guides/*")            this doc links to a target matching the glob
  $links().size() == 0        leaf docs (no outgoing links)
  $backlinks().exists(d, d.layer == "draft")   quantify over linking docs;
                              inside, d.<key> reads the other doc's metadata

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
  from=docs       filter: !$in("**")                    (orphans)
  from=blocks     filter: type == "task" && !attrs.checked && under_heading("Launch") && doc.layer == "working"
  from=blocks     filter: type == "paragraph" && has_edge("references", "d_92aaaaa")
  from=blocks     semantic: "identity preservation across edits"   select: ["$ordinal","$semantic_score"]

Common mistake: writing \`path.startsWith(...)\` (bare) meant the intrinsic. This
now fails loud (bare \`path\` collides with the intrinsic base name) with a hint
to use \`$path\` — no more misleading empty result. Use the intrinsic \`$path\`.
`;

export const GRAPH_SYNTAX = `# graph_traverse / graph_path — syntax reference

Traverse the authored edge graph (links, metadata relations, inline fields — in
markdown, metadata relations come from frontmatter).

## Grain — the #1 gotcha

Traversal is DOC-GRAIN: nodes are documents, edges are keyed by source document.
Seeds in \`from\` should be document ids (d_...). A BLOCK id (b_...) is
auto-normalized to its owning document, so ids straight from query/docs_outline
work. Unknown ids simply touch no edges (empty result, not an error).

Node ids you'll see:
  d_......      a document
  phantom:PATH  a link target with no file yet (dangling) — the path is in the id
  x_......      an external node (URL); resolve its uri via select

## graph_traverse { from, via?, direction?, depth?, select?, as_of? }

  from        array of seed ids (doc or block; blocks normalize to their doc)
  via         predicates to follow; omit = any authored predicate. Common
              predicates are authored: "references" (plain links), "embeds"
              (images), plus any metadata/inline-field key ("project",
              "type", "depends_on", ...; frontmatter keys in markdown).
  direction   "out" (default) | "in" (backlinks) | "both"
  depth       hops, ≤ 8 (default 3)
  select      project per-node metadata into result.nodeInfo (see below)
  as_of       commit seq — traverse the graph as it was at that point in time
  budget      { maxNodes, maxEdges } — caps; result.truncated flags a cutoff

Returns: { nodes: id[], edges: {src,predicate,dst}[], nodeInfo?, truncated, frontier }

## select — make nodes actionable without hydrating each id

Without select the result is opaque ids. With it, result.nodeInfo maps each node
id → metadata:
  "$path"      the doc path (or phantom target path, or external uri)
  "$kind"      always present: "document" | "phantom" | "external"
  bare key     a metadata value from that node's document ("type","layer",...)

Example:
  graph_traverse from=["d_abc"] via=["references"] direction="both" depth=2
                 select=["$path","type","layer"]
  → nodeInfo: { "d_def": { kind:"document", path:"guides/x.md", type:"guide", layer:"working" }, ... }

## graph_path { from, to, via?, direction?, max_len?, k? }

Up to k shortest paths (BFS) between two node ids. max_len ≤ 8, k ≤ 5 (default 1).
from/to accept block ids (normalized to docs) just like traverse.

## Composing with query

To do "expand from these blocks, keep targets where layer=='canon'": use \`query\`
to find the seed blocks, then graph_traverse from their ids with select=["layer"]
and filter the returned nodeInfo. Traversal has no CEL filter of its own — the
node projection is how you triage the frontier.
`;
