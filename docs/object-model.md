# omgbase — The Object Model (Documents, Blocks, Nodes, Edges)

**Status:** orientation (conceptual). This is the mental-model guide, not a
spec — it explains *how to think about* what omgbase stores and which part of
the surface touches which layer. For the normative details it points at the
specs: `architecture.md` (kernel concepts), `data-model.md` (schema),
`graph-and-query.md` (edges + traversal), `mutation-and-concurrency.md` (writes),
and `surface-map.md` (the full operation catalog).

---

## The one-paragraph model

Your files stay ordinary files. omgbase parses each one into a **tree of
blocks** with stable identities, keeps the **history** of every block, and
derives a **graph** of the relationships your text asserts. On top of the blocks
it projects **nodes** — the meaningful things inside them (a link, a task, a
heading-as-section) — which is what you *read and query*. The relationships
between things are **edges**. Four words carry the whole model:

```
Document   a file (markdown / yaml / json) — the unit of identity + history
  └─ Block   a stable, addressable piece of a document — the unit you EDIT
       └─ Node   a semantic projection over a block — the unit you READ/QUERY
Edge   a relationship between documents/blocks/external things — the GRAPH
```

The load-bearing rule that makes this safe: **identity (the stable `b_` id) only
ever answers "is this the same block over time?"** Everything operational — the
graph, search, rendered bytes, edit safety — is recomputed from the *current
parsed content*, never inherited through identity. A reconciliation slip can
therefore muddle a block's *biography*; it can never corrupt the graph, a search
result, or a write target (ADR-003).

---

## Documents

A **document** is one file the engine tracks: a Markdown note, a YAML config, a
JSON file. It has a repo-relative `path`, a `format` (which adapter parses it),
optional frontmatter, and a linear chain of **revisions** (its history).

The file on disk is canonical for *content* (ADR-004); the database is canonical
for *identity and history*. The engine can reconstruct the file's exact bytes
from the database, which is why a remote/headless server needs no working tree.

A document is not a bag of text — it is a **tree of blocks** plus a little
document-level trivia (leading whitespace, the frontmatter separator).

> **Surface:** `new` / `mv` / `rm --doc` / `meta` (lifecycle:
> `docs_create`/`docs_move`/`docs_delete`/`docs_set_meta`), `cat` / `ls` /
> `outline` (reads: `read_ref`/`docs_read`, `docs_list`, `docs_outline`),
> `update <doc>` (whole-document identity-preserving reconcile: `docs_update`).

---

## Blocks — the things you edit

A **block** is an addressable piece of a document with a stable, opaque id
(`b_k7z2p9q`). A document parses into a tree of blocks:

```markdown
# Project Hub          ← heading   b_1
                          (a section is DERIVED from this heading, not a block)
Intro paragraph.       ← paragraph b_2

## Tasks               ← heading   b_3
- [ ] wire it up       ← task      b_5   (child of the list b_4)
- [x] write the spec   ← task      b_6
```

Key properties:

- **Stable identity across edits.** Reconciliation matches re-parsed content back
  to existing block ids, so editing a paragraph keeps its `b_` id — links,
  history, and comments that point at it survive. Identity is scoped to the
  **repo**, not the document, so a block keeps its id when moved between files.
- **A flat CommonMark tree.** Headings are leaves (siblings of the content that
  follows), not containers. Lists/list-items/blockquotes/tables nest as the
  parser nests them. **Sections** (a heading + everything under it until the next
  peer heading) are *derived*, addressed by the heading block's id with
  `scope: "section"` — not a separate block.
- **Block types:** `heading`, `paragraph`, `list`, `list_item`, `task` (a list
  item with a GFM checkbox → `attrs.checked`), `blockquote`, `code_fence`,
  `table`, `table_row`, `thematic_break`, `html_block`, `frontmatter` (at most
  one, first), and `opaque` (unrecognized syntax — preserved byte-perfectly,
  addressable, but refusing typed edits).
- **Two content hashes.** `raw_hash` = the exact source bytes (the compare-and-swap
  key for safe edits); `norm_hash` = normalized text (used only by
  reconciliation). Inline constructs — links, emphasis, images — are *not* blocks;
  they are content of blocks (and surface as nodes and edges, below).

Blocks are the **mutation anchors**: every write targets a block (or the document
top level). All writes funnel through the six-op kernel (`insert`, `update`,
`move`, `remove`, `split`, `merge`) applied as one atomic changeset with
compare-and-swap — there is no other way to write (`mutation-and-concurrency.md`).

> **Surface:** `insert` / `update <block>` / `move` / `rm <blocks>` / `split` /
> `merge` (tools `blocks_insert`/`blocks_update`/`blocks_move`/`blocks_remove`/
> `blocks_split`/`blocks_merge`), `apply` (the raw changeset primitive), and the
> macros `done` (`tasks_complete`) / `append` (`sections_append`). Read a block
> with `nodes_get` (see the next section for why the read is named for *nodes*).

---

## Nodes — the things you read

A **node** is a *semantic projection over a block* (or a whole document): the
meaningful thing the block contains, lifted into a queryable, typed row. A node
is **derived and read-only**, with a deterministic id computed from
`(doc, block, kind, ordinal)` — recomputed every time the block is re-parsed.

Node **kinds** are format-qualified: `md:link`, `md:wikilink`, `md:task`,
`md:inline_field`, `md:section`, `json:ref`, `json:schema`, and so on. Where a
block is "a paragraph of source bytes," its nodes are "the link to `/design.md`
at offset 12" and "the task that is unchecked."

This is the answer to *why writes are `blocks_*` but the block read is
`nodes_get`*: **you edit the anchor (a block); you read the projection (its
nodes).** The two names track the two layers on purpose. `nodes_get` keys off a
block id and hydrates that block's projected view — which is also why a separate
`blocks_get` would be redundant.

Nodes are read-only, with **one deliberate exception**: `node set` edits an
*editable property* of a node (a link's target, a task's `checked`) by rewriting
the underlying block's span — i.e. it resolves node → block and emits one
`update` op. You never mutate the projection directly; you mutate the block the
projection is a view of.

> **Surface:** `query "from nodes …"` (the projection query surface),
> `nodes_get` / `nodes_get_many` (hydrate a block's node view), `node set`
> (`node_set` — the editable-property escape hatch), `node props` (list what's
> editable, local-only).

---

## Edges — the graph

An **edge** is a relationship your content asserts, extracted at ingest as a pure
function of the current bytes. An edge runs from a **source** (a block, or a
frontmatter/inline field) through a **predicate** to a **destination**:

```
[see the plan](/design.md)          →  b_2 —references→ d_(design.md)      (provenance: link)
depends_on: [/infra.md]  (frontmatter)  d_ —depends_on→ d_(infra.md)       (provenance: frontmatter)
owner:: [[Alice]]        (inline field) b_7 —owner→ d_(Alice.md)           (provenance: inline_field)
https://example.com                  →  b_9 —references→ x_(example.com)   (an external node)
```

- **Destinations have kinds:** `document`, `block`, `external` (a normalized URI,
  minted as an `x_` node), or `collection` (a named/queried set, `col_`).
- **A link is both a node and an edge.** The same `[text](/doc.md)` in your source
  appears as a `md:link` **node** (its local, editable representation) *and*
  produces a `references` **edge** (the relationship it asserts in the graph). The
  node is the thing in the block; the edge is its graph consequence.
- **Authored, block-grain, temporal.** Edges are append-only with a validity
  interval (`from_commit` … `to_commit`); the graph is queryable at any point in
  history. A doc-level rollup (`doc_edges`) exists for speed.
- **Phantom targets.** A link to a file that doesn't exist yet still creates an
  edge to a placeholder document node, so backlinks light up the moment the target
  is created (phantoms are flagged in results).
- **Two things are *not* edges.** (1) **Structural** relations — parent/child,
  sibling order, section containment — live in the block tree, not the edge
  tables; you navigate them with the query `follow` operator (`block.children`,
  `doc.out`/`doc.in`) rather than edge rows. (2) **Inferred** relations
  (similarity, co-occurrence) are quarantined in a separate `inferred_edges`
  table, never mixed into the authored graph (as-built: a reserved stub).

> **Surface:** `query "… follow doc.out"` (traverse the authored graph),
> `links` (`links_stale`), `retarget` (`links_retarget`), `links_repair`. Edges
> aren't created by an "add edge" call — you write a link/field in a block and the
> engine extracts the edge.

---

## A note on the word "node"

omgbase uses "node" in two nearby senses; keep them apart:

1. **Graph node / vertex** — the things edges connect: documents, blocks,
   external URIs, collections. This is the sense in "the knowledge graph."
2. **Projected node** — a row in the projections layer (`from nodes`,
   `nodes_get`): a semantic view over a block (`md:link`, `md:task`). This is the
   sense in the four-word model above.

They meet at links: a link is a projected **node** *and* an edge to a graph
**node** (the target document). When this doc says "node" unqualified, it means
sense 2 (the projection layer).

---

## Properties (the fifth thing, briefly)

Alongside the four is the **property** index: typed key/value pairs extracted
from frontmatter, inline `key:: value` fields, and computed values (`$title`,
`$tags`). Properties are scoped to a document (frontmatter/computed) or a block
(inline), and are the backing for property filters in queries
(`from docs where layer == "working"`). See `properties-table.md`. They are
mentioned here only so the boundary is clear: properties are *values on*
documents/blocks; edges are *relationships between* them.

---

## How it all gets built (and stays fresh)

One pass, at ingest, inside the commit transaction:

1. **Parse** the file into a block tree (the reconciler matches re-parsed blocks
   back to existing `b_` ids — that is the *only* place identity is decided).
2. From the **current content** of each block, re-derive everything else:
   **nodes** (projections), **edges** (the graph), **properties** (the index),
   plus search/section indexes.

Because step 2 is a pure function of current content, the derived layers are
disposable and rebuildable (`omg rebuild-index`); only the block identities and
the commit history are precious. That is the whole reason the model is safe to
mutate through agents: the thing that could go wrong (identity matching) is
walled off from the things that must stay correct (graph, search, bytes).

---

## Which layer does each verb touch?

| Layer | You… | CLI | MCP |
|---|---|---|---|
| **Document** | create/rename/delete/retitle, read whole | `new` `mv` `rm --doc` `meta` `cat` `ls` `outline` `update <doc>` | `docs_*`, `read_ref`, `docs_list`, `docs_outline`, `docs_update` |
| **Block** | edit structure (the anchors) | `insert` `update <block>` `move` `rm <blocks>` `split` `merge` `done` `append` `apply` | `blocks_*`, `tasks_complete`, `sections_append`, `apply` |
| **Node** | read/query projections; edit one property | `query "from nodes"` `node set` | `query`, `nodes_get(_many)`, `node_set` |
| **Edge** | assert (by writing links/fields); traverse; retarget | `query "… follow"` `links` `retarget` | `query`, `links_stale`, `links_retarget`, `links_repair` |

The full, authoritative correspondence — every operation across library, CLI, and
MCP, plus what runs over `--server` — is `surface-map.md`.
