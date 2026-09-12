import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "../core/store/store.js";
import { docsOutline } from "../core/read/outline.js";
import { docsRead, readDocumentAtRevision } from "../core/read/document.js";
import { nodesGet, nodesGetMany } from "../core/read/nodes.js";
import { findDoc, findDocByRef } from "../core/read/reader.js";
import { isValidId } from "../core/ids.js";
import { normalizeText, normalizeVisibleText } from "../core/hash.js";
import { oqxRunAsync, collectSemanticPhrases } from "../oqx/run.js";
import { textSearch } from "../search/text.js";
import { FilterInvalid } from "../search/cel/parser.js";
import { EngineError } from "./errors.js";
import { apply, type Op } from "../mutate/apply.js";
import { MutationError } from "../mutate/tree.js";
import { tasksComplete, sectionsAppend, linksRetarget, linksRepair, nodeSet } from "../mutate/macros.js";
import { docsCreate, docsMove, docsDelete, docsSetMeta } from "../mutate/docs.js";
import { planUpdate, docsUpdate } from "../mutate/plan-update.js";
import { renderOpsetPlan } from "../mutate/opset.js";
import { historyNode, diffBlocks, changesSince, docHistory } from "../graph/history.js";
import { linksStale } from "../graph/link-health.js";
import { resolve as resolveThing } from "../search/resolve.js";
import { reposStatus, syncStatus } from "../sync/admin.js";
import { QUERY_SYNTAX } from "./reference.js";

// MCP server (06-mcp-api). The full tool surface wired to the engine: read
// (docs_outline, nodes_get(_many), query, text_search, resolve), mutate (apply
// + macros), graph (traverse, path), history (history_node, diff,
// changes_since), admin (repos_status, sync_status). Uniform truncated+cursor
// on lists; stable error-code mapping.

export interface ServerContext {
  store: Store;
  /** default repo for calls that omit one (single-repo v1 convenience). */
  repoId: string;
  /** working-tree root, required for mutation tools that write files. */
  rootPath?: string;
  /**
   * Embed a query string to a vector for semantic search. Absent ⇒ the `query`
   * tool's `semantic` param yields `semantic_unavailable` (no provider). The
   * host (CLI `omg mcp`) supplies this from the repo's configured embedder.
   */
  embedQuery?: (text: string) => Promise<{ model: string; vec: Float32Array }>;
  /**
   * Called after any successful write tool (apply/macros/doc ops). The host
   * (CLI `omg mcp`) uses this to schedule a background embed drain so a block's
   * vector stays fresh without a manual `omg embed drain`. Must be cheap and
   * non-blocking — it fires on the mutation's response path; the actual
   * embedding happens off it. Absent ⇒ mutations don't auto-drain.
   */
  onMutation?: () => void;
}

// Kernel-op schemas (04 §1) published as the `apply` tool's op grammar. Giving
// each op a real schema (rather than z.any()) makes the required fields
// discoverable in the tool's JSON schema and turns a malformed op — e.g. an
// `update` missing its `block` id — into a boundary validation error naming the
// field, instead of a downstream `block_missing` for "block undefined".
const atSchema = z.union([
  z.literal("start"),
  z.literal("end"),
  z.object({ before: z.string() }),
  z.object({ after: z.string() }),
]);
const toSchema = z.object({
  parent: z.union([
    z.string().describe("a block id to nest under"),
    z.object({ doc: z.literal(true) }).describe("the document's top level"),
    z.object({ heading: z.string(), scope: z.literal("section") }).describe("a heading's section range"),
  ]),
  at: atSchema,
});
const expectSchema = z.object({
  content_hash: z.string().optional(),
  parent_children_hash: z.string().optional(),
});
const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), doc: z.string().optional(), to: toSchema, markdown: z.string() }),
  z.object({ op: z.literal("update"), block: z.string(), markdown: z.string().optional(), attrs: z.record(z.string(), z.unknown()).optional(), expect: expectSchema.optional() }),
  z.object({ op: z.literal("move"), blocks: z.array(z.string()), to: toSchema }),
  z.object({ op: z.literal("remove"), blocks: z.array(z.string()), expect: z.record(z.string(), expectSchema).optional() }),
  z.object({ op: z.literal("split"), block: z.string(), at: z.array(z.number().int()), expect: expectSchema.optional() }),
  z.object({ op: z.literal("merge"), blocks: z.array(z.string()), separator: z.string().optional(), expect: z.record(z.string(), expectSchema).optional() }),
]);

function ok(payload: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  let body: unknown;
  if (err instanceof EngineError) body = err.body();
  else if (err instanceof FilterInvalid) body = { error: "filter_invalid", message: err.message, data: { reason: err.reason, hint: err.hint }, retriable: false };
  else if (err instanceof MutationError) body = { error: err.code, message: err.message, data: err.data, retriable: Boolean((err.data as { retriable?: boolean }).retriable) };
  else body = { error: "repo_not_found", message: String(err), retriable: false };
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError: true };
}

export function buildServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: "omgbase", version: "0.0.0" });
  const { store, repoId } = ctx;

  // Wrap a successful write's result: notify the host so it can schedule a
  // background embed drain. onMutation must be cheap/non-blocking (see
  // ServerContext); we never await it, keeping it off the response path.
  function okMutated(payload: unknown): { content: { type: "text"; text: string }[] } {
    ctx.onMutation?.();
    return ok(payload);
  }

  // Resolve the owning document id from an explicit doc/path, or — when neither
  // is given — infer it from a block id. The MCP schemas mark `doc`/`path`
  // optional precisely so a caller holding only a block id (e.g. from
  // docs_outline or query) can hydrate it without a separate lookup.
  //
  // `doc` is id-OR-path: an agent holding a path from a prior query/outline hit
  // routinely reaches for the most obvious field, so it must accept both (via
  // the shared findDocByRef). `path` stays explicit-path; `block` infers the
  // owning doc. An unresolvable ref throws doc_missing (loud), never a silent
  // empty — including a d_-shaped id that doesn't exist (findDocByRef won't fall
  // through to a path lookup for it).
  function resolveDocId(ref: { doc?: string | undefined; path?: string | undefined; block?: string | undefined }): string {
    if (ref.doc) {
      const info = findDocByRef(store, repoId, ref.doc);
      if (info) return info.docId;
    } else if (ref.path) {
      const info = findDoc(store, { repoId, path: ref.path });
      if (info) return info.docId;
    } else if (ref.block) {
      const row = store.db
        .prepare("SELECT doc_id FROM blocks WHERE block_id = ?")
        .get(ref.block) as { doc_id: string } | undefined;
      if (row) return row.doc_id;
    }
    throw new EngineError("doc_missing", `no document for ${JSON.stringify(ref)}`, { data: ref });
  }

  // Resolve `heading` (a block id or heading text) to a heading block id, for
  // macros that address a section. A value that already names a live heading
  // block is returned as-is; otherwise it's matched as heading text (normalized
  // the same way the parser stores block.text), scoped to a doc/path when given.
  // Repo-wide text that isn't unique fails ambiguous_heading with candidate ids.
  function resolveHeadingId(heading: string, scope: { doc?: string; path?: string }): string {
    const asBlock = store.db
      .prepare("SELECT block_id FROM blocks WHERE block_id = ? AND type = 'heading' AND deleted_commit IS NULL")
      .get(heading) as { block_id: string } | undefined;
    if (asBlock) return asBlock.block_id;

    const wantDoc = scope.doc || scope.path ? resolveDocId(scope) : undefined;
    const needle = normalizeVisibleText(heading, "heading");
    const rows = (wantDoc
      ? store.db.prepare("SELECT block_id, doc_id, text FROM blocks WHERE repo_id = ? AND type = 'heading' AND doc_id = ? AND deleted_commit IS NULL")
        .all(repoId, wantDoc)
      : store.db.prepare("SELECT block_id, doc_id, text FROM blocks WHERE repo_id = ? AND type = 'heading' AND deleted_commit IS NULL")
        .all(repoId)) as { block_id: string; doc_id: string; text: string }[];
    const matches = rows.filter((r) => normalizeText(r.text) === needle);
    if (matches.length === 0) throw new EngineError("parent_missing", `no heading matching ${JSON.stringify(heading)}`, { data: { heading, ...(wantDoc ? { doc: wantDoc } : {}) } });
    if (matches.length > 1) {
      throw new EngineError("ambiguous_heading", `heading ${JSON.stringify(heading)} matches ${matches.length} headings; pass its block id or a doc/path scope`, {
        data: { heading, candidates: matches.map((m) => ({ block: m.block_id, doc: m.doc_id })) },
      });
    }
    return matches[0]!.block_id;
  }

  server.registerTool(
    "docs_outline",
    {
      description:
        "Orientation call. Returns a document's compact indented outline (alias/type/label per line, § marks section headings). IDs are stable; prefer them in follow-ups. Args take a doc id or path. For the whole document body in one call, use docs_read.",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        resolution: z.enum(["skeleton", "outline"]).optional(),
        depth: z.number().int().optional(),
        budget_tokens: z.number().int().optional(),
      },
    },
    async (args) => {
      try {
        const docId = resolveDocId(args);
        const res = docsOutline(store, docId, {
          ...(args.resolution ? { resolution: args.resolution } : {}),
          ...(args.depth !== undefined ? { depth: args.depth } : {}),
          ...(args.budget_tokens !== undefined ? { budgetTokens: args.budget_tokens } : {}),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_read",
    {
      description:
        "Read a whole document in one call: `content` is the complete file bytes verbatim (fences/tables/list markers preserved), `metadata` is the document's structured property bag, plus `path`/`docId`/`rev`. What `metadata` holds is format-dependent: for markdown it's the parsed frontmatter (and, as adapters grow, merged intrinsics like inline fields or an h1-derived title); for YAML/JSON it's the parsed object the file represents; other adapters extract per their format. The cold-start 'read the guide before doing anything' call. Args take a doc id or path. Pass include_ids:true to also get the document's block ids in order for follow-up edits. For structure-only orientation use docs_outline; to hydrate a single block use nodes_get.",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        include_ids: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const docId = resolveDocId(args);
        const res = docsRead(store, docId, args.include_ids ? { includeIds: true } : {});
        if (!res) throw new EngineError("doc_missing", `no document for ${JSON.stringify(args)}`);
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "nodes_get",
    {
      description: "Hydrate one block subtree at a resolution (skeleton|outline|text|raw|full). Pass a block `id`; `doc`/`path` are optional — the owning document is inferred from the block id when omitted. The raw and full resolutions include the block's `content_hash` (its own raw hash) — the value update/split need in expect.content_hash, so you can fetch it before editing rather than reading it back from a conflict. Use this to expand the lean ids returned by query/resolve. To read a whole document in one call, use docs_read (nodes_get on a doc/heading id returns only that block, not the document).",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        id: z.string(),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
      },
    },
    async (args) => {
      try {
        const docId = resolveDocId({ doc: args.doc, path: args.path, block: args.id });
        const node = nodesGet(store, docId, args.id, args.resolution ? { resolution: args.resolution } : {});
        if (!node) throw new EngineError("block_missing", `no block ${args.id}`);
        return ok(node);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "nodes_get_many",
    {
      description: "Fetch up to 100 blocks by id with budget truncation. Result carries truncated.",
      inputSchema: {
        doc: z.string().optional(),
        path: z.string().optional(),
        ids: z.array(z.string()),
        resolution: z.enum(["skeleton", "outline", "text", "raw", "full"]).optional(),
        budget_tokens: z.number().int().optional(),
      },
    },
    async (args) => {
      try {
        const docId = resolveDocId({ doc: args.doc, path: args.path, block: args.ids[0] });
        const res = nodesGetMany(store, docId, args.ids, {
          ...(args.resolution ? { resolution: args.resolution } : {}),
          ...(args.budget_tokens !== undefined ? { budgetTokens: args.budget_tokens } : {}),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "query_syntax",
    {
      description:
        "Reference: the full `query` syntax — targets, the CEL filter subset, absence semantics, structural + link-graph functions, `select` projection, and worked examples. Call this before writing a non-trivial filter. No arguments.",
      inputSchema: {},
    },
    async () => ok({ syntax: QUERY_SYNTAX }),
  );

  server.registerTool(
    "query",
    {
      description:
        "OQX (omgbase Query eXpressions) — composable query in ONE expression: `from docs|blocks|nodes`, `where`, `select`. Its distinctive power is receiver-constrained nested queries that correlate to the current row: `from docs where nodes.exists(where kind == \"md:task\")` returns only the docs that themselves contain a matching node (not a global scan). Ops: `.exists(...)` / `.count(...)` in where — with an optional count comparison `nodes.count(where kind == \"md:task\") >= 2`; `.collect(...)` in select for hierarchical results, nestable (`select secs: nodes.collect(where kind == \"md:section\" select h: name, items: section.blocks.collect(where type == \"list_item\"))`). The where clause is a boolean tree: compose scalar predicates and collection ops with `&&`, `||`, `!`, and grouping (`layer == \"canon\" || nodes.exists(where kind == \"md:task\")`). One-scope lift: a `collect` in `where` with a `^name` both filters (non-empty) and binds the matching values into the parent select in one expression — `from docs where nodes.collect(^open: value where kind == \"md:task\" && !attrs.checked) select $path, open` returns the docs with an open task, each carrying its open-task texts. Correlation / joins (the `^` sigil, symmetric with the lift): a nested query may READ a name bound one scope outward — bind it in the parent (a select value or a lift), then reference `^name` inside a nested query's where. Combined with the explicit root relations `repo.docs` / `repo.nodes` / `repo.blocks` (an UNBOUNDED repository scan, uncorrelated until you add a `^` predicate) this expresses lateral/dependent joins without a JOIN keyword: `repo.<t>.exists(where … == ^k)` = semi-join, `!…exists` = anti-join, `.collect(…)` in select = nested left-join, and the select-only lookups `.first(…)` / `.single(…)` (zero-or-one / one-to-one; `single` errors if it matches >1) — e.g. `from docs select owner_id, owner: repo.nodes.single(where kind == \"person\" && attrs.id == ^owner_id)`. Membership over a lifted set: `<value> in ^keys`. `^` reads exactly ONE scope out (no arbitrary-ancestor search). Top-level consumers: wrap the WHOLE query to change its result shape — `repo.count(from … )` and `repo.exists(from … )` reduce to a scalar (returned as `count`/`exists`, no hits), `repo.first(from … )` / `repo.single(from … )` return zero-or-one hit (`single` errors if the query matches >1); a bare `from …` is `repo.collect(…)`. (Distinct from the `repo.<target>` root RELATION, which is a receiver inside where/select.) Scalar predicates use the same CEL grammar as `query` (see query_syntax), including doc.<key> reach-through and `text(\"terms\")` — a full-text (FTS5) PRUNING predicate that, because it is an ordinary predicate, composes inside correlated subqueries and collects (e.g. `nodes.exists(where kind == \"md:task\" && text(\"ship\"))`), which the flat `query` tool cannot express. (`text` prunes; relevance ranking is separate.) And `semantic(\"phrase\")` — an embedding cosine SCORE (docs/blocks only) usable as a threshold prune (`semantic(\"the great work\") > 0.6`) or a projection (`select score: semantic(\"…\")`); it needs an embedding provider (else semantic_unavailable) and, like `text`, composes inside nested scopes. Ranking: `order by <expr> [asc|desc], …` sorts the result (`order by semantic(\"the great work\") desc` = semantic top-K; also orders by any frontmatter field / `$path`), always tie-broken by (path, id) for a total order — this is how score functions become a ranking. A custom order disables the keyset cursor (you still get the top `limit` with `truncated`). Recursion (`follow`): make the query recursive over a TYPE-PRESERVING relation (the relation's successor type must equal the query target). `from blocks where $id == \"b_x\" follow block.children` walks the block subtree from a seed; the `where` picks the SEED rows and `follow <relation>` expands them. Two orthogonal knobs shape it: a follow-local `follow <rel> where <pred>` filters which successors keep participating at each hop (running out ⇒ a leaf), and `frontier <pred>` cuts a relation that could otherwise continue (⇒ a frontier); `depth <n>` bounds the walk (1..8, default 8). `follow distinct` dedups reached rows by identity (the default keeps one occurrence per distinct walk path). `follow … by <expr>` sets the node identity used for cycle detection + dedup to a field/intrinsic (default: the entity id) — e.g. `follow doc.out by group` treats same-`group` documents as one node. Each reached row carries recursion metadata: `$depth` (seed = 1), the categorical `$stop` (interior | leaf | frontier | depth | cycle) with `$leaf`/`$frontier` boolean sugar, and `$ordinal` (a deterministic 1..N rank over the walk, ordered by depth then path — `order by $ordinal` for walk order, `where $ordinal <= N` for a deterministic budget cut). It is queryable in select / order by AND filterable post-walk in the top-level `where` (a `where` conjunct referencing a recursion intrinsic filters the walk's RESULT — `from blocks where type == \"list_item\" && $leaf follow block.children` = the leaves; the non-recursion conjuncts remain the seed predicate). Recursion intrinsics are NOT valid in the follow-local successor `where` or `frontier` (those run mid-walk, before the metadata exists), nor inside a collection op. Cyclic graphs are safe: a revisited node is admitted once as a `$stop == \"cycle\"` occurrence and never re-expanded. Type-preserving relations today: `block.children` (blocks→blocks, immediate child blocks), `section.children` (nodes→nodes, immediate child sections — a true outline depth ladder) and `section.subsections` (nodes→nodes, the whole transitive sub-tree — flattens to depth 2), and `doc.out` / `doc.in` (docs→docs, the authored citation graph — outgoing links / backlinks). Consumers compose over the walk (`repo.count(from blocks where … follow block.children)`). A `follow` may also nest inside a select-position `collect` for a per-row recursive subtree: `from docs select outline: nodes.collect(where kind == \"md:section\" && name == \"Overview\" select n: name, d: $depth follow section.children)` (the collect's `where` seeds, correlated to the row; `follow` recurses; the collect's `select` projects each occurrence). Receivers: from docs — `nodes`, `blocks`, `doc.out`/`doc.in`; from nodes — `section.blocks` (content under an `md:section` node's heading, transitively including deeper headings), `section.children` (immediate child sections), and `section.subsections` (all contained sections); from blocks — `section` (enclosing `md:section` node(s)) and `block.children` (child blocks); from any scope — `repo.docs` / `repo.nodes` / `repo.blocks`. Returns lean hits {id, path, ...projections} with truncated + cursor (or a `count`/`exists` scalar for those consumers). Covers structural + section navigation + ad-hoc correlation + bounded recursive traversal (`follow`).",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().optional(),
        cursor: z.string().nullable().optional(),
      },
    },
    async (args) => {
      try {
        // A `semantic(...)` query with no provider is semantic_unavailable (not a
        // generic filter error) — surface that specific code, mirroring resolve.
        if (!ctx.embedQuery && collectSemanticPhrases(args.query).length > 0) {
          throw new EngineError("semantic_unavailable", "no embedding provider configured for this server");
        }
        return ok(await oqxRunAsync(store, repoId, args.query, {
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
        }, ctx.embedQuery));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "text_search",
    {
      description: "Full-text (FTS5, bm25-ranked) keyword search over block text. Input is treated as a search box — plain words are ANDed, \"quoted phrases\" match adjacency, punctuation like / is safe (no query DSL). For structured filtering or frontmatter projection use `query` instead (see query_syntax).",
      inputSchema: { q: z.string(), limit: z.number().int().optional() },
    },
    async (args) => {
      try {
        return ok(textSearch(store, repoId, args.q, args.limit !== undefined ? { limit: args.limit } : {}));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "resolve",
    {
      description: "Resolve a name/title/concept to the concrete blocks it refers to — 'the id of the thing I mean'. Hybrid ranker (FTS + semantic when a provider is configured); best on short, entity-shaped inputs (a title, term, or phrase). Returns ranked {id, locator, preview, evidence}; prefer the returned ids in follow-up calls. For open natural-language questions or passage retrieval, use `query` with `semantic` instead.",
      inputSchema: { query: z.string(), limit: z.number().int().optional() },
    },
    async (args) => {
      try {
        const input: Parameters<typeof resolveThing>[1] = { repoId, query: args.query, ...(args.limit !== undefined ? { limit: args.limit } : {}) };
        // Hybrid: fuse the query vector into the ranking when a provider is
        // configured (mirrors CLI `omg find`). Absent ⇒ FTS-only.
        if (ctx.embedQuery) input.vector = await ctx.embedQuery(args.query);
        return ok(resolveThing(store, input));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "apply",
    {
      description:
        "The only real writer. Applies a changeset of kernel ops (insert/update/move/remove/split/merge) atomically — all apply or none. Each op is a tagged object keyed by \"op\"; the block an op targets is named by its `block` (update/split) or `blocks` (move/remove/merge) field, never `id`/`target`. Ops apply in order; later ops see earlier effects; minted ids are referenceable via \"$n.ids[i]\". Pass dry_run:true first for multi-doc changes to preview diffs. Conflicts carry current truth — retry from the error, don't re-read.",
      inputSchema: {
        ops: z.array(opSchema),
        reason: z.string().optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const res = apply(store, {
          repoId, rootPath: ctx.rootPath,
          ops: args.ops as Op[],
          origin: { actor: "agent:mcp", ...(args.reason ? { reason: args.reason } : {}) },
          ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
        });
        // A dry run previews without writing — don't schedule a drain for it.
        return args.dry_run ? ok(res) : okMutated(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "tasks_complete",
    {
      description: "Macro: mark the given task blocks checked. Expands to update(attrs:{checked:true}) per block; the expansion is applied via the same changeset machinery.",
      inputSchema: { blocks: z.array(z.string()) },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const ops = tasksComplete(store, args.blocks);
        return okMutated(apply(store, { repoId, rootPath: ctx.rootPath, ops, origin: { actor: "agent:mcp", reason: "tasks_complete" } }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "node_set",
    {
      description:
        "Macro: surgically set one editable property of a projected node (e.g. a link's `name` text or `value` target, a task's `checked`). Takes the node id (from query from:nodes), a property, and its new value. Resolves the node to its block and rewrites only that node's span, applying one update op. Nodes are read-only projections — this is the affordance to edit what a node represents without hand-rewriting the block. Errors node_not_editable (with the editable prop list) when the kind/prop has no editor.",
      inputSchema: { node: z.string(), prop: z.string(), value: z.string() },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const ops = nodeSet(store, args.node, args.prop, args.value);
        return okMutated(apply(store, { repoId, rootPath: ctx.rootPath, ops, origin: { actor: "agent:mcp", reason: "node_set" } }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "sections_append",
    {
      description:
        "Macro: append markdown at the end of a heading's section range. `heading` accepts the heading's block id (preferred, from docs_outline) OR its text — text is resolved to an id, scoped to `doc`/`path` when given. Heading text without a doc scope is repo-wide and errors ambiguous_heading (with candidate ids) when it isn't unique. Expands to a single insert op.",
      inputSchema: { heading: z.string(), markdown: z.string(), doc: z.string().optional(), path: z.string().optional() },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const headingId = resolveHeadingId(args.heading, { ...(args.doc ? { doc: args.doc } : {}), ...(args.path ? { path: args.path } : {}) });
        const ops = sectionsAppend(headingId, args.markdown);
        return okMutated(apply(store, { repoId, rootPath: ctx.rootPath, ops, origin: { actor: "agent:mcp", reason: "sections_append" } }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "links_retarget",
    {
      description: "Macro: rewrite a link/reference destination across all blocks that contain it. ALWAYS call with dry_run:true first to preview the hits, then dry_run:false to apply.",
      inputSchema: { from_target: z.string(), to_target: z.string(), dry_run: z.boolean().optional() },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const { ops, hits } = linksRetarget(store, repoId, args.from_target, args.to_target);
        if (args.dry_run !== false) return ok({ hits, applied: false });
        const res = apply(store, { repoId, rootPath: ctx.rootPath, ops, origin: { actor: "agent:mcp", reason: "links_retarget" } });
        return okMutated({ hits, applied: true, ...res });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "links_stale",
    {
      description:
        "READ-ONLY link health: surfaces DANGLING internal links — links whose target path has NO live document (stored as a `phantom:` edge; a doc created at that path auto-resolves them). Returns `stale[]` (each with srcPath, srcBlock, predicate, provenance, `target` = the human-readable missing path, and reason `dangling_doc`), plus `externalCount` (http(s) links — UNVERIFIABLE here, never marked broken, since reachability needs network I/O the engine won't do), `totalOpenEdges`, and `truncated`. Scope the SOURCE docs with `path_glob` (e.g. \"journal/*\"; `*` matches across `/`). Fix the reported targets with `links_repair` (batch) or `links_retarget` (single). Anchors (#heading/^ref) into an existing doc are NOT verified in v1. Contrast docs_read/query which answer 'what does this doc say', not 'which of its links are broken'.",
      inputSchema: { path_glob: z.string().optional(), limit: z.number().int().optional() },
    },
    async (args) => {
      try {
        return ok(linksStale(store, repoId, {
          ...(args.path_glob ? { pathGlob: args.path_glob } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "links_repair",
    {
      description:
        "Macro: BULK stale-link repair — rewrite one or MANY link-destination substrings across all blocks that contain them, in ONE changeset. This is links_retarget generalized to a batch: pass `repairs` (an array of {from,to}) to fix several dangling targets — e.g. those surfaced by links_stale — at once; a single {from_target,to_target} pair is also accepted for the one-off case. A block matched by multiple pairs gets a single coalesced update op (CAS-safe). ALWAYS call with dry_run:true first to preview `hits`, then dry_run:false to apply.",
      inputSchema: {
        repairs: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
        from_target: z.string().optional(),
        to_target: z.string().optional(),
        dry_run: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const repairs = args.repairs
          ? args.repairs
          : args.from_target !== undefined && args.to_target !== undefined
            ? [{ from: args.from_target, to: args.to_target }]
            : null;
        if (!repairs || repairs.length === 0) {
          throw new EngineError("target_missing", "links_repair requires `repairs` (array of {from,to}) or a `from_target`+`to_target` pair");
        }
        const { ops, hits } = linksRepair(store, repoId, repairs);
        if (args.dry_run !== false) return ok({ hits, applied: false });
        const res = apply(store, { repoId, rootPath: ctx.rootPath, ops, origin: { actor: "agent:mcp", reason: "links_repair" } });
        return okMutated({ hits, applied: true, ...res });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // Doc-level operations (06 §API). The MCP server serializes writes in-process,
  // so these pass no omgbaseDir (the flock is for cross-process CLI writers);
  // MCP-originated writes are actor agent:mcp.
  const docCtx = () => {
    if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
    return { repoId, rootPath: ctx.rootPath, actor: "agent:mcp" };
  };

  server.registerTool(
    "docs_create",
    {
      description: "Create a new document at `path` from complete file bytes (`markdown`), with optional structured `frontmatter`. Fails path_taken if it already exists.",
      inputSchema: { path: z.string(), markdown: z.string(), frontmatter: z.record(z.string(), z.unknown()).optional() },
    },
    async (args) => {
      try {
        return okMutated(docsCreate(store, docCtx(), args.path, args.markdown, args.frontmatter));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_move",
    {
      description: "Rename a document to a new repo-relative path; block identity and history are preserved. Fails path_taken if the destination exists.",
      inputSchema: { doc: z.string(), to_path: z.string() },
    },
    async (args) => {
      try {
        return okMutated(docsMove(store, docCtx(), args.doc, args.to_path));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_delete",
    {
      description: "Delete a document: tombstone it and its live blocks (resurrection-poolable) and remove the file. Requires the explicit doc id/path.",
      inputSchema: { doc: z.string() },
    },
    async (args) => {
      try {
        return okMutated(docsDelete(store, docCtx(), args.doc));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_set_meta",
    {
      description: "Surgical frontmatter patch: set the given keys and/or unset named keys, re-ingesting the document. Other frontmatter is preserved.",
      inputSchema: { doc: z.string(), set: z.record(z.string(), z.unknown()).optional(), unset: z.array(z.string()).optional() },
    },
    async (args) => {
      try {
        return okMutated(docsSetMeta(store, docCtx(), args.doc, {
          ...(args.set ? { set: args.set } : {}),
          ...(args.unset ? { unset: args.unset } : {}),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_plan_update",
    {
      description:
        "Plan a whole-document update WITHOUT applying it. Given a doc (id or path) and the proposed complete `content`, reconciles the new representation against the current stable block tree and returns an executable *opset*: the exact kernel ops (insert/update/move/remove) it would run, each annotated with its identity consequence (disposition, confidence, reason), plus a summary (preserved/updated/moved/created/removed) and a human-readable plan. The opset carries preconditions (base revision + content hash); a stale plan is refused at apply. Use this to inspect identity effects before committing, or as the reviewable half of docs_update.",
      inputSchema: { doc: z.string(), content: z.string() },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const opset = planUpdate(store, repoId, ctx.rootPath, args.doc, args.content);
        return ok({ opset, plan: renderOpsetPlan(opset) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_update",
    {
      description:
        "Whole-document update with smart identity preservation. Submit the complete proposed `content` for a doc (id or path); the engine reconciles it against the current tree, preserving stable block ids for structure that is recognizably the same (edits, moves, reorders), minting for new structure, and tombstoning removals — then commits the derived opset through the kernel write path. Frontmatter changes are applied too. dry_run:true returns the opset + plan without writing (identical to docs_plan_update). Conflicts (the doc changed since planning) fail stale_plan — re-run. This is docs_plan_update + apply(opset).",
      inputSchema: { doc: z.string(), content: z.string(), reason: z.string().optional(), dry_run: z.boolean().optional() },
    },
    async (args) => {
      try {
        if (!ctx.rootPath) throw new EngineError("repo_not_found", "server has no rootPath; mutation disabled");
        const { opset, result } = docsUpdate(store, docCtx(), args.doc, args.content, {
          ...(args.dry_run !== undefined ? { dryRun: args.dry_run } : {}),
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        const payload = { opset, plan: renderOpsetPlan(opset), result };
        return args.dry_run ? ok(payload) : okMutated(payload);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "history_node",
    {
      description: "A block's biography: the commits that touched it with disposition kind/confidence/reason, newest first.",
      inputSchema: { id: z.string(), limit: z.number().int().optional() },
    },
    async (args) => {
      try {
        return ok(historyNode(store, args.id, args.limit !== undefined ? { limit: args.limit } : {}));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "diff",
    {
      description: "Block-grain diff between two revisions of a document: added/removed/changed blocks.",
      inputSchema: { doc: z.string(), from_rev: z.string(), to_rev: z.string() },
    },
    async (args) => {
      try {
        // Resolve `doc` id-or-path FIRST: diffBlocks keys its SQL on the doc id,
        // so a raw path here would silently return an empty diff (no error) —
        // the misleading-empty trap. resolveDocId throws doc_missing when the
        // ref names no document.
        const docId = resolveDocId({ doc: args.doc });
        return ok(diffBlocks(store, docId, args.from_rev, args.to_rev));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_read_at",
    {
      description:
        "TIME-TRAVEL read: the whole file bytes of a document AS OF a past revision — `content` is the reconstructed source at that `rev` (fences/tables/list markers preserved), plus `path`/`docId`/`rev`. Use this to audit or answer 'what did this doc say at revision N', or to fetch the exact prior text before reverting. Get a `rev` from diff, history_node, or changes_since. Contrast: docs_read = current bytes; diff = block-grain changes BETWEEN two revisions. `renderedHashMatch` is true when the reconstruction is byte-for-byte the file at that revision; it can be false for an old revision ONLY when the document's leading/frontmatter trivia (separator bytes, not block content) changed since — block content always reconstructs faithfully. `properties` are CURRENT values (propertiesAreCurrent:true), since property history is not stored. Args take a doc id or path plus a rev id.",
      inputSchema: { doc: z.string().optional(), path: z.string().optional(), rev: z.string() },
    },
    async (args) => {
      try {
        const docId = resolveDocId(args);
        const res = readDocumentAtRevision(store, docId, args.rev);
        if (!res) throw new EngineError("target_missing", `no revision ${JSON.stringify(args.rev)} for document ${docId}`, { data: { doc: docId, rev: args.rev } });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "docs_history",
    {
      description:
        "VERSION HISTORY of matching documents, grouped BY DOCUMENT: for each doc, its ordered revision list (oldest→newest) with `rev`/`seq`/`commit`/`ts`/`origin`/`actor`/`contentHash`/`isCurrent`. Give `path_glob` (e.g. \"journal/*\" — `*` matches ACROSS `/`, so journal/* and journal/** are equivalent) OR a single `doc` (id or path); at least one is required. `contentHash` (hex of the revision's rendered file hash) lets you spot no-op vs real changes. Feed a returned `rev` into `docs_read_at` (whole doc AT that rev) or `diff` (block-grain changes BETWEEN two revs). By default only live docs; `include_deleted:true` also returns tombstoned docs (their history is intact for audit). `limit` caps DOCUMENTS returned (default 50) with a `truncated` flag. Contrast `changes_since`: a repo-wide COMMIT feed, not this per-document view.",
      inputSchema: {
        path_glob: z.string().optional(),
        doc: z.string().optional(),
        include_deleted: z.boolean().optional(),
        limit: z.number().int().optional(),
      },
    },
    async (args) => {
      try {
        if (!args.path_glob && !args.doc) {
          throw new EngineError("target_missing", "docs_history requires one of path_glob or doc");
        }
        if (args.doc) {
          // Validate the ref resolves (or, when include_deleted, a tombstoned doc
          // exists). findDocByRef does the id-or-path dispatch (isValidId); the
          // tombstone fallback uses the same dispatch.
          const info = findDocByRef(store, repoId, args.doc);
          const asId = isValidId(args.doc, "d");
          const known = info || (args.include_deleted
            ? store.db.prepare(asId ? "SELECT 1 FROM docs WHERE doc_id = ?" : "SELECT 1 FROM docs WHERE repo_id = ? AND path = ?").get(...(asId ? [args.doc] : [repoId, args.doc]))
            : undefined);
          if (!known) throw new EngineError("doc_missing", `no document for ${JSON.stringify(args.doc)}`);
        }
        return ok(docHistory(store, repoId, {
          ...(args.path_glob ? { pathGlob: args.path_glob } : {}),
          ...(args.doc ? { doc: args.doc } : {}),
          ...(args.include_deleted !== undefined ? { includeDeleted: args.include_deleted } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "changes_since",
    {
      description: "The change feed: commit digests after a cursor (repo commit seq) with one-line summaries. Poll with your last cursor to cheaply re-orient after time away.",
      inputSchema: { cursor: z.number().int().optional(), origin: z.enum(["api", "observed", "import"]).optional(), limit: z.number().int().optional() },
    },
    async (args) => {
      try {
        return ok(changesSince(store, repoId, {
          ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
          ...(args.origin ? { origin: args.origin } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "repos_status",
    {
      description:
        "Repo counts: docs, blocks, commits, open edges, unconverged doc count, and on-disk drift. " +
        "`disk` reports a READ-ONLY scan of the working tree vs the DB: `changed` (files edited on disk but not re-ingested), " +
        "`deleted` (docs whose file is gone from disk), `untracked` (new *.md not yet ingested), and `checked` " +
        "(false when the server has no working-tree path — disk agreement is then UNVERIFIED, not clean).",
      inputSchema: {},
    },
    async () => {
      try { return ok(reposStatus(store, repoId, ctx.rootPath)); } catch (e) { return fail(e); }
    },
  );

  server.registerTool(
    "sync_status",
    {
      description:
        "Watcher/sync state: last commit seq, last checkpoint, and whether the repo is convergent. " +
        "`convergent` is true ONLY when the DB is internally converged AND a working-tree scan ran (`diskChecked`) AND found no drift " +
        "(`disk.changed`/`deleted`/`untracked` all 0). If the server has no working-tree path, `diskChecked` is false and `convergent` is " +
        "false — a green light is never shown while disk freshness is unverified, so an agent can trust `convergent: true` to mean not stale.",
      inputSchema: {},
    },
    async () => {
      try { return ok(syncStatus(store, repoId, ctx.rootPath)); } catch (e) { return fail(e); }
    },
  );

  return server;
}
