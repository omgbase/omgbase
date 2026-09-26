//! The MCP tool catalog (`spec/surface/README.md` §4) as a library: a table
//! of [`ToolSpec`]s (name, JSON-schema input, description) and one dispatch
//! ([`Surface::call`]) that runs a tool against the store and returns its
//! JSON result or the error envelope. Transport-agnostic — a server wraps
//! each outcome in one text content item. Port of
//! `packages/core/src/mcp/server.ts`.

use std::path::Path;

use omgbase_format::BlockKind;
use omgbase_format::text::{normalize_text, normalize_visible_text};
use omgbase_reconcile::Config;
use omgbase_search::EmbeddingProvider;
use omgbase_store::mutate_kernel::{At, Op, Parent, To};
use omgbase_store::{
    ApplyOrigin, ApplyRequest, ApplyResult, DocOpContext, DocStore, Expect, FsDocStore, Opset,
    QueryVector, Store,
};
use omgbase_sync::{RealFileSystem, RepoRow};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::error::{Result, SurfaceError};
use crate::graph::{GraphArgs, graph_neighborhood};
use crate::history;
use crate::links;
use crate::query::{QueryOptions, query};
use crate::read::{self, Resolution, ResolvedRef};
use crate::reference::QUERY_SYNTAX;

/// The actor every write from this surface records.
pub const ACTOR: &str = "agent:mcp";

/// One tool of the catalog.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// The JSON schema of the arguments object.
    pub input_schema: Json,
}

/// What a tool call produced: its JSON result, or the error envelope with
/// `is_error` set.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolOutcome {
    pub body: Json,
    pub is_error: bool,
}

/// Where a mutating tool writes files.
enum WriteTarget {
    /// Derive the repo's root from its `fs` source and write through the
    /// filesystem (a sourceless repo cannot mutate).
    Derived,
    /// Write through this store whatever the repo's sources say (a runner's
    /// in-memory store).
    Fixed(Box<dyn DocStore>),
}

/// The catalog bound to a store, a default repo and optional providers.
pub struct Surface {
    store: Store,
    default_repo: String,
    provider: Option<Box<dyn EmbeddingProvider>>,
    on_mutation: Option<Box<dyn FnMut()>>,
    clock: Box<dyn FnMut() -> String>,
    writes: WriteTarget,
    config: Config,
}

// ---- argument helpers ----------------------------------------------------------------

fn bad_args(msg: impl Into<String>) -> SurfaceError {
    SurfaceError::filter_invalid(msg, "arguments")
}

fn arg_str<'a>(args: &'a Json, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Json::as_str)
}

fn arg_string(args: &Json, key: &str) -> Result<String> {
    arg_str(args, key)
        .map(str::to_owned)
        .ok_or_else(|| bad_args(format!("`{key}` must be a string")))
}

fn arg_i64(args: &Json, key: &str) -> Result<Option<i64>> {
    match args.get(key) {
        None | Some(Json::Null) => Ok(None),
        Some(v) => v
            .as_f64()
            .filter(|n| n.fract() == 0.0)
            .map(|n| Some(n as i64))
            .ok_or_else(|| bad_args(format!("`{key}` must be an integer"))),
    }
}

fn arg_usize(args: &Json, key: &str) -> Result<Option<usize>> {
    Ok(arg_i64(args, key)?.map(|n| usize::try_from(n).unwrap_or(0)))
}

fn arg_bool(args: &Json, key: &str) -> Result<Option<bool>> {
    match args.get(key) {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(bad_args(format!("`{key}` must be a boolean"))),
    }
}

fn arg_strings(args: &Json, key: &str) -> Result<Vec<String>> {
    let Some(arr) = args.get(key).and_then(Json::as_array) else {
        return Err(bad_args(format!("`{key}` must be an array of strings")));
    };
    arr.iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| bad_args(format!("`{key}` must be an array of strings")))
        })
        .collect()
}

fn arg_object<'a>(args: &'a Json, key: &str) -> Result<Option<&'a Map<String, Json>>> {
    match args.get(key) {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Object(o)) => Ok(Some(o)),
        Some(_) => Err(bad_args(format!("`{key}` must be an object"))),
    }
}

fn resolution_arg(args: &Json, default: Resolution) -> Result<Resolution> {
    match arg_str(args, "resolution") {
        None => Ok(default),
        Some(s) => Resolution::parse(s).ok_or_else(|| {
            bad_args("`resolution` must be one of skeleton, outline, text, raw, full")
        }),
    }
}

/// `{ ...a, ...b }` (b wins).
fn merge(mut a: Map<String, Json>, b: Json) -> Json {
    if let Json::Object(o) = b {
        for (k, v) in o {
            a.insert(k, v);
        }
    }
    Json::Object(a)
}

fn schema(props: &[(&str, Json)], required: &[&str], repo: bool) -> Json {
    let mut p = Map::new();
    for (k, v) in props {
        p.insert((*k).to_owned(), v.clone());
    }
    if repo {
        p.insert("repo".to_owned(), json!({ "type": "string" }));
    }
    json!({ "type": "object", "properties": p, "required": required })
}

fn s() -> Json {
    json!({ "type": "string" })
}
fn i() -> Json {
    json!({ "type": "integer" })
}
fn b() -> Json {
    json!({ "type": "boolean" })
}
fn strings() -> Json {
    json!({ "type": "array", "items": { "type": "string" } })
}
fn obj() -> Json {
    json!({ "type": "object" })
}
fn nullable_string() -> Json {
    json!({ "type": ["string", "null"] })
}
fn resolution_schema() -> Json {
    json!({ "type": "string", "enum": ["skeleton", "outline", "text", "raw", "full"] })
}
fn at_schema() -> Json {
    json!({ "oneOf": [
        { "const": "start" }, { "const": "end" },
        { "type": "object", "properties": { "before": { "type": "string" } }, "required": ["before"] },
        { "type": "object", "properties": { "after": { "type": "string" } }, "required": ["after"] }
    ] })
}
fn expect_schema() -> Json {
    json!({ "type": "object", "properties": { "content_hash": { "type": "string" }, "parent_children_hash": { "type": "string" } } })
}

/// The catalog (§4 table), in the reference's registration order.
#[must_use]
pub fn tools() -> Vec<ToolSpec> {
    let dp = |extra: &[(&str, Json)], required: &[&str]| {
        let mut props = vec![("doc", s()), ("path", s())];
        props.extend(extra.iter().cloned());
        schema(&props, required, true)
    };
    vec![
        ToolSpec {
            name: "docs_outline",
            description: "A document's compact indented outline (id, type, label per line; § marks headings). Args take a doc id or path.",
            input_schema: dp(
                &[
                    (
                        "resolution",
                        json!({ "type": "string", "enum": ["skeleton", "outline"] }),
                    ),
                    ("depth", i()),
                    ("budget_tokens", i()),
                ],
                &[],
            ),
        },
        ToolSpec {
            name: "docs_read",
            description: "Read a whole document: verbatim `content`, `properties` grouped by source, `path`/`docId`/`rev`; include_ids adds `ids`, `hashes` (CAS tokens) and `parents`.",
            input_schema: dp(&[("include_ids", b())], &[]),
        },
        ToolSpec {
            name: "docs_get_many",
            description: "Batch docs_read over `docs` (ids or paths): `{ items, errors, truncated }`, capped at 100 refs, optional token budget.",
            input_schema: schema(
                &[
                    ("docs", strings()),
                    ("include_ids", b()),
                    ("budget_tokens", i()),
                ],
                &["docs"],
                true,
            ),
        },
        ToolSpec {
            name: "nodes_get",
            description: "Hydrate one block subtree at a resolution (skeleton|outline|text|raw|full); the owning doc is inferred from `id` when `doc`/`path` are omitted.",
            input_schema: dp(&[("id", s()), ("resolution", resolution_schema())], &["id"]),
        },
        ToolSpec {
            name: "nodes_get_many",
            description: "Fetch up to 100 blocks by id in request order with budget truncation; `doc`/`path` is an optional scope. Returns `nodes`, `truncated`, `unresolved`.",
            input_schema: dp(
                &[
                    ("ids", strings()),
                    ("resolution", resolution_schema()),
                    ("budget_tokens", i()),
                ],
                &["ids"],
            ),
        },
        ToolSpec {
            name: "read_ref",
            description: "Read any ref — a document (id or path) or a block (`b_` id, or an `n_` node id) — classified as `{ kind: \"document\", … }` or `{ kind: \"block\", … }` (block `resolution` defaults to raw).",
            input_schema: schema(
                &[("ref", s()), ("resolution", resolution_schema())],
                &["ref"],
                true,
            ),
        },
        ToolSpec {
            name: "docs_tree",
            description: "The directory-aware shape of a repo: live docs under `path` collapsed at `depth` segments into dir/doc entries with totals, ordered by path and paged.",
            input_schema: schema(
                &[
                    ("path", s()),
                    ("depth", i()),
                    ("limit", i()),
                    ("cursor", nullable_string()),
                    ("budget_tokens", i()),
                ],
                &[],
                true,
            ),
        },
        ToolSpec {
            name: "docs_list",
            description: "Enumerate live documents as a page `{ items: [{ path, blocks, ts }], truncated, cursor }`, ordered by path; `path_glob` is a LIKE match (`*` matches across `/`).",
            input_schema: schema(
                &[
                    ("path_glob", s()),
                    ("limit", i()),
                    ("cursor", nullable_string()),
                    ("budget_tokens", i()),
                ],
                &[],
                true,
            ),
        },
        ToolSpec {
            name: "query_syntax",
            description: "The OQX syntax reference for the `query` tool.",
            input_schema: schema(&[], &[], false),
        },
        ToolSpec {
            name: "query",
            description: "Run one OQX query (`select … from docs|blocks|nodes|edges where … follow … order by … limit N`). Returns lean hits `{ id, path, …projections }` with `truncated` + `cursor`, or a `count`/`exists`/`none` scalar, or `values`. See query_syntax.",
            input_schema: schema(
                &[
                    ("query", s()),
                    ("limit", i()),
                    ("cursor", nullable_string()),
                ],
                &["query"],
                true,
            ),
        },
        ToolSpec {
            name: "graph",
            description: "The bounded neighborhood around root documents in one call — `{ documents, edges, frontier }` — compiled to an OQX `follow doc.out`/`doc.in` walk.",
            input_schema: schema(
                &[
                    ("roots", strings()),
                    ("degrees", i()),
                    (
                        "direction",
                        json!({ "type": "string", "enum": ["in", "out", "both"] }),
                    ),
                    ("predicate", s()),
                    ("select", strings()),
                    ("max_documents", i()),
                ],
                &["roots"],
                true,
            ),
        },
        ToolSpec {
            name: "text_search",
            description: "Full-text (FTS5, bm25-ranked) search over block text.",
            input_schema: schema(&[("q", s()), ("limit", i())], &["q"], true),
        },
        ToolSpec {
            name: "resolve",
            description: "Resolve a name/title/phrase to the blocks it refers to: ranked `{ id, locator, preview, evidence }` (FTS, fused with the vector ranking when a provider exists).",
            input_schema: schema(&[("query", s()), ("limit", i())], &["query"], true),
        },
        ToolSpec {
            name: "apply",
            description: "Apply a changeset of kernel ops (insert/update/move/remove/split/merge) atomically; `dry_run` previews diffs.",
            input_schema: schema(
                &[
                    (
                        "ops",
                        json!({ "type": "array", "items": { "type": "object" } }),
                    ),
                    ("reason", s()),
                    ("dry_run", b()),
                ],
                &["ops"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_insert",
            description: "Insert blocks parsed from `markdown` under `to` (a block ref, or a document ref for its top level) at `at` (end|start|{before|after}).",
            input_schema: schema(
                &[
                    ("to", s()),
                    ("markdown", s()),
                    ("at", at_schema()),
                    ("dry_run", b()),
                ],
                &["to", "markdown"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_update",
            description: "Replace a block's markdown and/or set attrs (`checked` folds into attrs) with CAS pinned server-side when `expect` is omitted. Returns `id`, `ids` and the apply result.",
            input_schema: schema(
                &[
                    ("block", s()),
                    ("markdown", s()),
                    ("checked", b()),
                    ("attrs", obj()),
                    ("expect", expect_schema()),
                    ("dry_run", b()),
                ],
                &["block"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_move",
            description: "Move blocks under a new parent at a position; `to` is a block ref or the blocks' own document.",
            input_schema: schema(
                &[
                    ("blocks", strings()),
                    ("to", s()),
                    ("at", at_schema()),
                    ("dry_run", b()),
                ],
                &["blocks", "to"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_remove",
            description: "Remove blocks (and their subtrees).",
            input_schema: schema(
                &[("blocks", strings()), ("dry_run", b())],
                &["blocks"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_split",
            description: "Split a block at UTF-8 byte offsets; CAS pinned server-side.",
            input_schema: schema(
                &[
                    ("block", s()),
                    (
                        "at",
                        json!({ "type": "array", "items": { "type": "integer" } }),
                    ),
                    ("dry_run", b()),
                ],
                &["block", "at"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_merge",
            description: "Merge adjacent blocks into the first, joined by `separator`.",
            input_schema: schema(
                &[("blocks", strings()), ("separator", s()), ("dry_run", b())],
                &["blocks"],
                true,
            ),
        },
        ToolSpec {
            name: "tasks_complete",
            description: "Check (or uncheck with checked:false) task blocks.",
            input_schema: schema(
                &[("blocks", strings()), ("checked", b()), ("dry_run", b())],
                &["blocks"],
                true,
            ),
        },
        ToolSpec {
            name: "node_set",
            description: "Set one editable property of a projected node (a link's name/value, a task's checked).",
            input_schema: schema(
                &[
                    ("node", s()),
                    ("prop", s()),
                    ("value", s()),
                    ("dry_run", b()),
                ],
                &["node", "prop", "value"],
                true,
            ),
        },
        ToolSpec {
            name: "sections_append",
            description: "Append markdown at the end of a heading's section; `heading` is a heading block id or its text (scoped by `doc`/`path`).",
            input_schema: schema(
                &[
                    ("heading", s()),
                    ("markdown", s()),
                    ("doc", s()),
                    ("path", s()),
                    ("dry_run", b()),
                ],
                &["heading", "markdown"],
                true,
            ),
        },
        ToolSpec {
            name: "docs_append",
            description: "Append markdown at the end of a document as new top-level blocks (existing ids preserved).",
            input_schema: schema(
                &[("doc", s()), ("path", s()), ("text", s())],
                &["text"],
                true,
            ),
        },
        ToolSpec {
            name: "links_retarget",
            description: "Rewrite one link destination everywhere it is linked (dry run by default).",
            input_schema: schema(
                &[
                    ("from_target", s()),
                    ("to_target", s()),
                    ("path_glob", s()),
                    ("dry_run", b()),
                ],
                &["from_target", "to_target"],
                true,
            ),
        },
        ToolSpec {
            name: "links_stale",
            description: "Dangling internal links (open edges to a `phantom:` target) plus external and total counts; `summary:true` returns counts only.",
            input_schema: schema(
                &[("path_glob", s()), ("limit", i()), ("summary", b())],
                &[],
                true,
            ),
        },
        ToolSpec {
            name: "links_repair",
            description: "Bulk link repair: `repairs` ([{from,to}]) or one `from_target`/`to_target` pair, in one changeset (dry run by default).",
            input_schema: schema(
                &[
                    (
                        "repairs",
                        json!({ "type": "array", "items": { "type": "object", "properties": { "from": { "type": "string" }, "to": { "type": "string" } }, "required": ["from", "to"] } }),
                    ),
                    ("from_target", s()),
                    ("to_target", s()),
                    ("path_glob", s()),
                    ("dry_run", b()),
                ],
                &[],
                true,
            ),
        },
        ToolSpec {
            name: "docs_create",
            description: "Create a document at `path` from `markdown` with optional `frontmatter`.",
            input_schema: schema(
                &[("path", s()), ("markdown", s()), ("frontmatter", obj())],
                &["path", "markdown"],
                true,
            ),
        },
        ToolSpec {
            name: "docs_move",
            description: "Rename a document to `to_path`, identity preserved; `retarget_inbound` rewrites inbound links.",
            input_schema: schema(
                &[("doc", s()), ("to_path", s()), ("retarget_inbound", b())],
                &["doc", "to_path"],
                true,
            ),
        },
        ToolSpec {
            name: "docs_delete",
            description: "Delete a document: tombstone it and remove the file.",
            input_schema: schema(&[("doc", s())], &["doc"], true),
        },
        ToolSpec {
            name: "docs_set_meta",
            description: "Set and/or unset frontmatter keys, re-ingesting the document.",
            input_schema: schema(
                &[("doc", s()), ("set", obj()), ("unset", strings())],
                &["doc"],
                true,
            ),
        },
        ToolSpec {
            name: "docs_plan_update",
            description: "Plan a whole-document update without applying: the opset and a one-line-per-op plan.",
            input_schema: schema(&[("doc", s()), ("content", s())], &["doc", "content"], true),
        },
        ToolSpec {
            name: "docs_update",
            description: "Whole-document update with identity preservation: plan then apply (`dry_run` returns the plan only).",
            input_schema: schema(
                &[
                    ("doc", s()),
                    ("content", s()),
                    ("reason", s()),
                    ("dry_run", b()),
                ],
                &["doc", "content"],
                true,
            ),
        },
        ToolSpec {
            name: "observe",
            description: "Record `content` as the authoritative bytes at `path` (an observed-origin commit; an echo when unchanged).",
            input_schema: schema(
                &[("path", s()), ("content", s())],
                &["path", "content"],
                true,
            ),
        },
        ToolSpec {
            name: "observe_many",
            description: "Observe several files under one timestamp and one pool sweep.",
            input_schema: schema(
                &[(
                    "files",
                    json!({ "type": "array", "items": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string" } }, "required": ["path", "content"] } }),
                )],
                &["files"],
                true,
            ),
        },
        ToolSpec {
            name: "observe_delete",
            description: "Record that `path` left the source: an observed, pooled tombstone.",
            input_schema: schema(&[("path", s())], &["path"], true),
        },
        ToolSpec {
            name: "history_node",
            description: "A block's biography: the commits that touched it, newest first.",
            input_schema: schema(&[("id", s()), ("limit", i())], &["id"], false),
        },
        ToolSpec {
            name: "diff",
            description: "Block-grain diff between two revisions of a document.",
            input_schema: schema(
                &[("doc", s()), ("from_rev", s()), ("to_rev", s())],
                &["doc", "from_rev", "to_rev"],
                true,
            ),
        },
        ToolSpec {
            name: "diff_unified",
            description: "Line-based +/- diff between two revisions (default: the previous and current).",
            input_schema: schema(
                &[("doc", s()), ("from_rev", s()), ("to_rev", s())],
                &["doc"],
                true,
            ),
        },
        ToolSpec {
            name: "docs_read_at",
            description: "The whole document as of a past revision.",
            input_schema: dp(&[("rev", s())], &["rev"]),
        },
        ToolSpec {
            name: "docs_history",
            description: "Version history of the docs matching `path_glob` or `doc`, grouped by document.",
            input_schema: schema(
                &[
                    ("path_glob", s()),
                    ("doc", s()),
                    ("include_deleted", b()),
                    ("limit", i()),
                ],
                &[],
                true,
            ),
        },
        ToolSpec {
            name: "changes_since",
            description: "The change feed: commit digests after `cursor` (a repo commit seq).",
            input_schema: schema(
                &[
                    ("cursor", i()),
                    (
                        "origin",
                        json!({ "type": "string", "enum": ["api", "observed", "import"] }),
                    ),
                    ("limit", i()),
                ],
                &[],
                true,
            ),
        },
        ToolSpec {
            name: "repos_status",
            description: "Repo counts, unconverged docs and on-disk drift.",
            input_schema: schema(&[], &[], true),
        },
        ToolSpec {
            name: "sync_status",
            description: "Sync state: last commit seq, last checkpoint, convergence.",
            input_schema: schema(&[], &[], true),
        },
        ToolSpec {
            name: "repos",
            description: "The repos in this workspace: `{ repos: [{ slug, hasSource }] }`.",
            input_schema: schema(&[], &[], false),
        },
    ]
}

impl Surface {
    /// A surface over `store` whose default repo is `default_repo` (an id).
    /// Mutations derive each repo's root from its `fs` source.
    #[must_use]
    pub fn new(
        store: Store,
        default_repo: &str,
        provider: Option<Box<dyn EmbeddingProvider>>,
    ) -> Self {
        Self {
            store,
            default_repo: default_repo.to_owned(),
            provider,
            on_mutation: None,
            clock: Box::new(omgbase_sync::now_ts),
            writes: WriteTarget::Derived,
            config: Config::default(),
        }
    }

    /// Route every mutation's file writes through `doc_store` regardless of
    /// the repo's sources (a runner's in-memory store).
    #[must_use]
    pub fn with_doc_store(mut self, doc_store: Box<dyn DocStore>) -> Self {
        self.writes = WriteTarget::Fixed(doc_store);
        self
    }

    /// Stamp commits with `clock()` instead of the wall clock.
    #[must_use]
    pub fn with_clock(mut self, clock: impl FnMut() -> String + 'static) -> Self {
        self.clock = Box::new(clock);
        self
    }

    /// Called after every successful write (never after a dry run).
    #[must_use]
    pub fn with_mutation_hook(mut self, hook: impl FnMut() + 'static) -> Self {
        self.on_mutation = Some(Box::new(hook));
        self
    }

    /// The matcher thresholds the observe tools pass through.
    #[must_use]
    pub fn with_config(mut self, config: Config) -> Self {
        self.config = config;
        self
    }

    #[must_use]
    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn store_mut(&mut self) -> &mut Store {
        &mut self.store
    }

    #[must_use]
    pub fn default_repo(&self) -> &str {
        &self.default_repo
    }

    /// The catalog.
    #[must_use]
    pub fn tools(&self) -> Vec<ToolSpec> {
        tools()
    }

    /// Run a tool: its JSON result, or the error envelope.
    pub fn call(&mut self, name: &str, args: Json) -> ToolOutcome {
        match self.call_result(name, &args) {
            Ok(body) => ToolOutcome {
                body,
                is_error: false,
            },
            Err(e) => ToolOutcome {
                body: e.to_json(),
                is_error: true,
            },
        }
    }

    fn now(&mut self) -> String {
        (self.clock)()
    }

    fn notify(&mut self) {
        if let Some(hook) = &mut self.on_mutation {
            hook();
        }
    }

    // ---- repo scoping (§4) ------------------------------------------------------------

    fn repo_rows(&self) -> Result<Vec<RepoRow>> {
        Ok(omgbase_sync::workspace::list_repos(&self.store)?)
    }

    /// `(repo id, derived root)` for the `repo` argument; omitted → the default.
    fn scope(&self, args: &Json) -> Result<(String, Option<String>)> {
        let rows = self.repo_rows()?;
        match arg_str(args, "repo") {
            None => {
                let root = rows
                    .iter()
                    .find(|r| r.repo_id == self.default_repo)
                    .and_then(|r| r.root_path.clone());
                Ok((self.default_repo.clone(), root))
            }
            Some(slug) => rows
                .iter()
                .find(|r| r.slug == slug)
                .map(|r| (r.repo_id.clone(), r.root_path.clone()))
                .ok_or_else(|| {
                    SurfaceError::with_data(
                        "repo_not_found",
                        format!("no repo '{slug}' in this workspace"),
                        json!({ "repo": slug }),
                    )
                }),
        }
    }

    fn require_root(&self, root: Option<&str>) -> Result<()> {
        if matches!(self.writes, WriteTarget::Fixed(_)) || root.is_some() {
            Ok(())
        } else {
            Err(SurfaceError::new(
                "repo_not_found",
                "repo has no filesystem source; mutation disabled",
            ))
        }
    }

    /// Run `f` with the store and the write target for `root`.
    fn with_writes<T>(
        &mut self,
        root: Option<&str>,
        f: impl FnOnce(&mut Store, &mut dyn DocStore) -> Result<T>,
    ) -> Result<T> {
        self.require_root(root)?;
        match &mut self.writes {
            WriteTarget::Fixed(ds) => f(&mut self.store, ds.as_mut()),
            WriteTarget::Derived => {
                let mut fs = FsDocStore::new(root.expect("checked by require_root"));
                f(&mut self.store, &mut fs)
            }
        }
    }

    // ---- ref resolution (§4) ---------------------------------------------------------

    /// The owning doc from `doc` (id or path) / `path` / `block`; `doc_missing` when none.
    fn resolve_doc_id(
        &self,
        repo_id: &str,
        doc: Option<&str>,
        path: Option<&str>,
        block: Option<&str>,
    ) -> Result<String> {
        let conn = self.store.conn();
        let found = if let Some(d) = doc.filter(|d| !d.is_empty()) {
            read::find_doc_by_ref(conn, repo_id, d)?.map(|i| i.doc_id)
        } else if let Some(p) = path.filter(|p| !p.is_empty()) {
            read::find_doc_by_path(conn, repo_id, p)?.map(|i| i.doc_id)
        } else if let Some(b) = block.filter(|b| !b.is_empty()) {
            conn.query_row(
                "SELECT doc_id FROM blocks WHERE block_id = ?1",
                params![b],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        } else {
            None
        };
        found.ok_or_else(|| {
            let mut m = Map::new();
            if let Some(d) = doc {
                m.insert("doc".to_owned(), json!(d));
            }
            if let Some(p) = path {
                m.insert("path".to_owned(), json!(p));
            }
            if let Some(b) = block {
                m.insert("block".to_owned(), json!(b));
            }
            SurfaceError::with_data(
                "doc_missing",
                format!("no document for {}", Json::Object(m.clone())),
                Json::Object(m),
            )
        })
    }

    fn resolve_doc_from_args(&self, repo_id: &str, args: &Json) -> Result<String> {
        self.resolve_doc_id(repo_id, arg_str(args, "doc"), arg_str(args, "path"), None)
    }

    /// `heading` (a heading block id or heading text) → the heading block id.
    fn resolve_heading_id(
        &self,
        repo_id: &str,
        heading: &str,
        doc: Option<&str>,
        path: Option<&str>,
    ) -> Result<String> {
        let conn = self.store.conn();
        let as_block: Option<String> = conn
            .query_row(
                "SELECT block_id FROM blocks WHERE block_id = ?1 AND type = 'heading' AND deleted_commit IS NULL",
                params![heading],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(b) = as_block {
            return Ok(b);
        }
        let want_doc = if doc.is_some_and(|d| !d.is_empty()) || path.is_some_and(|p| !p.is_empty())
        {
            Some(self.resolve_doc_id(repo_id, doc, path, None)?)
        } else {
            None
        };
        let needle = if heading.trim_start_matches([' ', '\t']).starts_with('#') {
            normalize_visible_text(heading, BlockKind::Heading, 0)
        } else {
            normalize_text(heading)
        };
        let rows: Vec<(String, String, String)> = match &want_doc {
            Some(d) => {
                let mut stmt = conn.prepare(
                    "SELECT block_id, doc_id, text FROM blocks WHERE repo_id = ?1 AND type = 'heading' AND doc_id = ?2 AND deleted_commit IS NULL",
                )?;
                let it = stmt.query_map(params![repo_id, d], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
                it.collect::<std::result::Result<_, _>>()?
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT block_id, doc_id, text FROM blocks WHERE repo_id = ?1 AND type = 'heading' AND deleted_commit IS NULL",
                )?;
                let it =
                    stmt.query_map(params![repo_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
                it.collect::<std::result::Result<_, _>>()?
            }
        };
        let matches: Vec<&(String, String, String)> = rows
            .iter()
            .filter(|(_, _, text)| normalize_text(text) == needle)
            .collect();
        match matches.len() {
            0 => {
                let mut data = Map::new();
                data.insert("heading".to_owned(), json!(heading));
                if let Some(d) = want_doc {
                    data.insert("doc".to_owned(), json!(d));
                }
                Err(SurfaceError::with_data(
                    "parent_missing",
                    format!("no heading matching {}", Json::String(heading.to_owned())),
                    Json::Object(data),
                ))
            }
            1 => Ok(matches[0].0.clone()),
            n => Err(SurfaceError::with_data(
                "ambiguous_heading",
                format!(
                    "heading {} matches {n} headings; pass its block id or a doc/path scope",
                    Json::String(heading.to_owned())
                ),
                json!({
                    "heading": heading,
                    "candidates": matches.iter().map(|(b, d, _)| json!({ "block": b, "doc": d })).collect::<Vec<_>>(),
                }),
            )),
        }
    }

    /// A ref → a live block id (`block_missing` otherwise).
    fn resolve_block_ref(&self, repo_id: &str, r: &str) -> Result<String> {
        match read::resolve_ref(self.store.conn(), repo_id, r)? {
            Some(ResolvedRef::Block { block_id, .. }) => Ok(block_id),
            _ => Err(SurfaceError::with_data(
                "block_missing",
                format!("not a block: {r}"),
                json!({ "ref": r }),
            )),
        }
    }

    /// A parent ref: a block, or a document ref for its top level.
    fn resolve_parent_ref(&self, repo_id: &str, r: &str) -> Result<(Parent, String)> {
        match read::resolve_ref(self.store.conn(), repo_id, r)? {
            Some(ResolvedRef::Block { doc_id, block_id }) => Ok((Parent::Block(block_id), doc_id)),
            Some(ResolvedRef::Document { doc_id }) => Ok((Parent::Doc, doc_id)),
            None => Err(SurfaceError::with_data(
                "block_missing",
                format!("not a block or document: {r}"),
                json!({ "ref": r }),
            )),
        }
    }

    fn doc_id_of_block(&self, block_id: &str) -> Result<Option<String>> {
        Ok(self
            .store
            .conn()
            .query_row(
                "SELECT doc_id FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
                params![block_id],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// The live block's raw hash (hex) for CAS pinning; `None` when unknown.
    fn pin_hash(&self, block_id: &str) -> Result<Option<String>> {
        let h: Option<Vec<u8>> = self
            .store
            .conn()
            .query_row(
                "SELECT raw_hash FROM blocks WHERE block_id = ?1 AND deleted_commit IS NULL",
                params![block_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(h.map(|h| omgbase_format::hash::hex(&h)))
    }

    /// The `at` spec with its anchor ref resolved; absent → end.
    fn resolve_at(&self, repo_id: &str, at: Option<&Json>) -> Result<At> {
        match at {
            None | Some(Json::Null) => Ok(At::End),
            Some(Json::String(s)) if s == "start" => Ok(At::Start),
            Some(Json::String(s)) if s == "end" => Ok(At::End),
            Some(Json::Object(o)) => {
                if let Some(b) = o.get("before").and_then(Json::as_str) {
                    return Ok(At::Before(self.resolve_block_ref(repo_id, b)?));
                }
                if let Some(a) = o.get("after").and_then(Json::as_str) {
                    return Ok(At::After(self.resolve_block_ref(repo_id, a)?));
                }
                Err(bad_args(
                    "`at` must be \"start\", \"end\", {before} or {after}",
                ))
            }
            Some(_) => Err(bad_args(
                "`at` must be \"start\", \"end\", {before} or {after}",
            )),
        }
    }

    // ---- the apply tail -----------------------------------------------------------------

    fn apply_ops(
        &mut self,
        repo_id: &str,
        root: Option<&str>,
        ops: Vec<Op>,
        reason: &str,
        dry_run: bool,
    ) -> Result<ApplyResult> {
        let ts = self.now();
        let req = ApplyRequest {
            repo_id: repo_id.to_owned(),
            ops,
            origin: ApplyOrigin::new(ACTOR, Some(reason)),
            dry_run,
            set_frontmatter: Vec::new(),
        };
        let res = self.with_writes(root, |store, ds| Ok(store.apply(&req, ds, &ts)?))?;
        if !dry_run {
            self.notify();
        }
        Ok(res)
    }

    fn doc_ctx(&mut self, repo_id: &str) -> DocOpContext {
        DocOpContext {
            repo_id: repo_id.to_owned(),
            actor: Some(ACTOR.to_owned()),
            ts: self.now(),
        }
    }

    // ---- dispatch -------------------------------------------------------------------------

    /// Run a tool, returning its result or the error.
    #[allow(clippy::too_many_lines)]
    pub fn call_result(&mut self, name: &str, args: &Json) -> Result<Json> {
        match name {
            "docs_outline" => {
                let (repo, _) = self.scope(args)?;
                let doc_id = self.resolve_doc_from_args(&repo, args)?;
                let skeleton = match arg_str(args, "resolution") {
                    None | Some("outline") => false,
                    Some("skeleton") => true,
                    Some(_) => return Err(bad_args("`resolution` must be skeleton or outline")),
                };
                read::docs_outline(
                    &self.store,
                    &doc_id,
                    skeleton,
                    arg_i64(args, "depth")?,
                    arg_usize(args, "budget_tokens")?,
                )
            }
            "docs_read" => {
                let (repo, _) = self.scope(args)?;
                let doc_id = self.resolve_doc_from_args(&repo, args)?;
                read::docs_read(
                    &self.store,
                    &doc_id,
                    arg_bool(args, "include_ids")?.unwrap_or(false),
                )?
                .ok_or_else(|| SurfaceError::new("doc_missing", format!("no document for {args}")))
            }
            "docs_get_many" => {
                let (repo, _) = self.scope(args)?;
                let refs = arg_strings(args, "docs")?;
                read::docs_read_many(
                    &self.store,
                    &repo,
                    &refs,
                    arg_bool(args, "include_ids")?.unwrap_or(false),
                    arg_usize(args, "budget_tokens")?,
                )
            }
            "nodes_get" => {
                let (repo, _) = self.scope(args)?;
                let id = arg_string(args, "id")?;
                let doc_id = self.resolve_doc_id(
                    &repo,
                    arg_str(args, "doc"),
                    arg_str(args, "path"),
                    Some(&id),
                )?;
                read::nodes_get(
                    &self.store,
                    &doc_id,
                    &id,
                    resolution_arg(args, Resolution::Full)?,
                )?
                .ok_or_else(|| SurfaceError::new("block_missing", format!("no block {id}")))
            }
            "nodes_get_many" => {
                let (repo, _) = self.scope(args)?;
                let ids = arg_strings(args, "ids")?;
                let scoped = arg_str(args, "doc").is_some_and(|d| !d.is_empty())
                    || arg_str(args, "path").is_some_and(|p| !p.is_empty());
                let doc_id = if scoped {
                    Some(self.resolve_doc_from_args(&repo, args)?)
                } else {
                    None
                };
                read::nodes_get_many(
                    &self.store,
                    doc_id.as_deref(),
                    &ids,
                    resolution_arg(args, Resolution::Text)?,
                    arg_usize(args, "budget_tokens")?,
                )
            }
            "read_ref" => {
                let (repo, _) = self.scope(args)?;
                let r = arg_string(args, "ref")?;
                let resolved =
                    read::resolve_ref(self.store.conn(), &repo, &r)?.ok_or_else(|| {
                        SurfaceError::new(
                            "doc_missing",
                            format!("no document or block for {}", Json::String(r.clone())),
                        )
                    })?;
                match resolved {
                    ResolvedRef::Document { doc_id } => {
                        let res =
                            read::docs_read(&self.store, &doc_id, false)?.ok_or_else(|| {
                                SurfaceError::new(
                                    "doc_missing",
                                    format!("no document for {}", Json::String(r.clone())),
                                )
                            })?;
                        let mut m = Map::new();
                        m.insert("kind".to_owned(), json!("document"));
                        Ok(merge(m, res))
                    }
                    ResolvedRef::Block { doc_id, block_id } => {
                        let node = read::nodes_get(
                            &self.store,
                            &doc_id,
                            &block_id,
                            resolution_arg(args, Resolution::Raw)?,
                        )?
                        .ok_or_else(|| {
                            SurfaceError::new("block_missing", format!("no block {block_id}"))
                        })?;
                        let mut m = Map::new();
                        m.insert("kind".to_owned(), json!("block"));
                        Ok(merge(m, node))
                    }
                }
            }
            "docs_tree" => {
                let (repo, _) = self.scope(args)?;
                read::docs_tree(
                    &self.store,
                    &repo,
                    arg_str(args, "path"),
                    arg_i64(args, "depth")?,
                    arg_i64(args, "limit")?,
                    arg_str(args, "cursor"),
                    arg_usize(args, "budget_tokens")?,
                )
            }
            "docs_list" => {
                let (repo, _) = self.scope(args)?;
                read::docs_list(
                    &self.store,
                    &repo,
                    arg_str(args, "path_glob"),
                    arg_i64(args, "limit")?,
                    arg_str(args, "cursor"),
                    arg_usize(args, "budget_tokens")?,
                )
            }
            "query_syntax" => Ok(json!({ "syntax": QUERY_SYNTAX })),
            "query" => {
                let (repo, _) = self.scope(args)?;
                let source = arg_string(args, "query")?;
                // A `semantic(...)` query with no provider is `semantic_unavailable`
                // here (the runner itself reports `filter_invalid`, §9).
                if self.provider.is_none()
                    && !crate::query::collect_semantic_phrases(&source).is_empty()
                {
                    return Err(SurfaceError::new(
                        "semantic_unavailable",
                        "no embedding provider configured for this server",
                    ));
                }
                let opts = QueryOptions {
                    limit: arg_usize(args, "limit")?,
                    cursor: arg_str(args, "cursor"),
                    provider: self.provider.as_deref(),
                };
                Ok(query(&self.store, &repo, &source, opts)?.to_json())
            }
            "graph" => {
                let (repo, _) = self.scope(args)?;
                let g = GraphArgs {
                    roots: arg_strings(args, "roots")?,
                    degrees: arg_i64(args, "degrees")?,
                    direction: arg_str(args, "direction").map(str::to_owned),
                    predicate: arg_str(args, "predicate").map(str::to_owned),
                    select: if args.get("select").is_some() {
                        arg_strings(args, "select")?
                    } else {
                        Vec::new()
                    },
                    max_documents: arg_i64(args, "max_documents")?,
                };
                if self.provider.is_none()
                    && g.select.iter().any(|s| {
                        !crate::query::collect_semantic_phrases(&format!("from docs select x: {s}"))
                            .is_empty()
                    })
                {
                    return Err(SurfaceError::new(
                        "semantic_unavailable",
                        "no embedding provider configured for this server",
                    ));
                }
                graph_neighborhood(&self.store, &repo, &g, self.provider.as_deref())
            }
            "text_search" => {
                let (repo, _) = self.scope(args)?;
                let q = arg_string(args, "q")?;
                let res =
                    self.store
                        .text_search(&repo, &q, arg_usize(args, "limit")?.unwrap_or(50))?;
                Ok(json!({
                    "hits": res.hits.iter().map(|h| json!({
                        "blockId": h.block_id, "docId": h.doc_id, "path": h.path, "type": h.block_type, "text": h.text, "score": h.score,
                    })).collect::<Vec<_>>(),
                    "truncated": res.truncated,
                }))
            }
            "resolve" => {
                let (repo, _) = self.scope(args)?;
                let q = arg_string(args, "query")?;
                let vector = match &self.provider {
                    Some(p) => Some(QueryVector {
                        model: p.model().to_owned(),
                        vec: p
                            .embed_query(&q)
                            .map_err(|e| SurfaceError::new(e.code(), e.to_string()))?,
                    }),
                    None => None,
                };
                let hits = self
                    .store
                    .resolve(&repo, &q, vector, arg_usize(args, "limit")?)?;
                Ok(Json::Array(hits.iter().map(|h| json!({
                    "id": h.id, "locator": h.locator, "preview": h.preview, "evidence": evidence_json(&h.evidence),
                })).collect()))
            }
            "apply" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let ops = args
                    .get("ops")
                    .and_then(Json::as_array)
                    .ok_or_else(|| bad_args("`ops` must be an array"))?;
                let ops: Vec<Op> = ops
                    .iter()
                    .map(|o| Op::from_json(o).map_err(bad_args))
                    .collect::<Result<_>>()?;
                let dry = arg_bool(args, "dry_run")?.unwrap_or(false);
                let reason = arg_str(args, "reason").map(str::to_owned);
                let ts = self.now();
                let req = ApplyRequest {
                    repo_id: repo.clone(),
                    ops,
                    origin: ApplyOrigin::new(ACTOR, reason.as_deref()),
                    dry_run: dry,
                    set_frontmatter: Vec::new(),
                };
                let res =
                    self.with_writes(root.as_deref(), |store, ds| Ok(store.apply(&req, ds, &ts)?))?;
                if !dry {
                    self.notify();
                }
                Ok(apply_json(&res))
            }
            "blocks_insert" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let (parent, doc_id) = self.resolve_parent_ref(&repo, &arg_string(args, "to")?)?;
                let at = self.resolve_at(&repo, args.get("at"))?;
                let doc = if parent == Parent::Doc {
                    Some(doc_id)
                } else {
                    None
                };
                let ops = vec![Op::Insert {
                    doc,
                    to: To { parent, at },
                    markdown: arg_string(args, "markdown")?,
                }];
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "blocks_insert",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
                )?))
            }
            "blocks_update" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let block = self.resolve_block_ref(&repo, &arg_string(args, "block")?)?;
                let expect = match arg_object(args, "expect")? {
                    Some(e) => Some(Expect {
                        content_hash: e
                            .get("content_hash")
                            .and_then(Json::as_str)
                            .map(str::to_owned),
                        parent_children_hash: e
                            .get("parent_children_hash")
                            .and_then(Json::as_str)
                            .map(str::to_owned),
                    }),
                    None => self.pin_hash(&block)?.map(Expect::content),
                };
                let checked = arg_bool(args, "checked")?;
                let extra = arg_object(args, "attrs")?;
                let attrs = if checked.is_some() || extra.is_some() {
                    let mut a = Map::new();
                    if let Some(c) = checked {
                        a.insert("checked".to_owned(), json!(c));
                    }
                    if let Some(x) = extra {
                        for (k, v) in x {
                            a.insert(k.clone(), v.clone());
                        }
                    }
                    Some(a)
                } else {
                    None
                };
                let ops = vec![Op::Update {
                    block: block.clone(),
                    markdown: arg_str(args, "markdown").map(str::to_owned),
                    attrs,
                    expect,
                    trivia: None,
                    child_ids: None,
                }];
                let dry = arg_bool(args, "dry_run")?.unwrap_or(false);
                let res = self.apply_ops(&repo, root.as_deref(), ops, "blocks_update", dry)?;
                let ids: Vec<String> = res
                    .results
                    .first()
                    .map_or_else(|| vec![block.clone()], |r| r.ids.clone());
                let mut m = Map::new();
                m.insert(
                    "id".to_owned(),
                    json!(ids.first().cloned().unwrap_or(block)),
                );
                m.insert("ids".to_owned(), json!(ids));
                Ok(merge(m, apply_json(&res)))
            }
            "blocks_move" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let blocks: Vec<String> = arg_strings(args, "blocks")?
                    .iter()
                    .map(|b| self.resolve_block_ref(&repo, b))
                    .collect::<Result<_>>()?;
                let to_ref = arg_string(args, "to")?;
                let (parent, doc_id) = self.resolve_parent_ref(&repo, &to_ref)?;
                if parent == Parent::Doc {
                    if let Some(first) = blocks.first() {
                        if self.doc_id_of_block(first)? != Some(doc_id) {
                            return Err(SurfaceError::with_data(
                                "target_missing",
                                format!(
                                    "blocks_move cannot target another document's root ({to_ref}); anchor on a block in that document with at.before/at.after"
                                ),
                                json!({ "to": to_ref }),
                            ));
                        }
                    }
                }
                let at = self.resolve_at(&repo, args.get("at"))?;
                let ops = vec![Op::Move {
                    blocks,
                    to: To { parent, at },
                }];
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "blocks_move",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
                )?))
            }
            "blocks_remove" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let blocks: Vec<String> = arg_strings(args, "blocks")?
                    .iter()
                    .map(|b| self.resolve_block_ref(&repo, b))
                    .collect::<Result<_>>()?;
                let ops = vec![Op::Remove {
                    blocks,
                    expect: None,
                }];
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "blocks_remove",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
                )?))
            }
            "blocks_split" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let block = self.resolve_block_ref(&repo, &arg_string(args, "block")?)?;
                let at: Vec<usize> = args
                    .get("at")
                    .and_then(Json::as_array)
                    .ok_or_else(|| bad_args("`at` must be an array of byte offsets"))?
                    .iter()
                    .map(|v| {
                        v.as_u64()
                            .map(|n| usize::try_from(n).unwrap_or(usize::MAX))
                            .ok_or_else(|| bad_args("`at` must be an array of byte offsets"))
                    })
                    .collect::<Result<_>>()?;
                // §9: an empty hash when the block has no live row.
                let expect = Some(Expect::content(self.pin_hash(&block)?.unwrap_or_default()));
                let ops = vec![Op::Split { block, at, expect }];
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "blocks_split",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
                )?))
            }
            "blocks_merge" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let blocks: Vec<String> = arg_strings(args, "blocks")?
                    .iter()
                    .map(|b| self.resolve_block_ref(&repo, b))
                    .collect::<Result<_>>()?;
                let ops = vec![Op::Merge {
                    blocks,
                    separator: arg_str(args, "separator").map(str::to_owned),
                    expect: None,
                }];
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "blocks_merge",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
                )?))
            }
            "tasks_complete" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let blocks: Vec<String> = arg_strings(args, "blocks")?
                    .iter()
                    .map(|b| self.resolve_block_ref(&repo, b))
                    .collect::<Result<_>>()?;
                let ops = if arg_bool(args, "checked")?.unwrap_or(true) {
                    self.store.tasks_complete(&blocks)?
                } else {
                    let mut ops = Vec::with_capacity(blocks.len());
                    for b in &blocks {
                        let mut a = Map::new();
                        a.insert("checked".to_owned(), json!(false));
                        ops.push(Op::Update {
                            block: b.clone(),
                            markdown: None,
                            attrs: Some(a),
                            expect: self.pin_hash(b)?.map(Expect::content),
                            trivia: None,
                            child_ids: None,
                        });
                    }
                    ops
                };
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "tasks_complete",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
                )?))
            }
            "node_set" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let ops = self.store.node_set(
                    &arg_string(args, "node")?,
                    &arg_string(args, "prop")?,
                    &arg_string(args, "value")?,
                )?;
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "node_set",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
                )?))
            }
            "sections_append" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let heading = self.resolve_heading_id(
                    &repo,
                    &arg_string(args, "heading")?,
                    arg_str(args, "doc"),
                    arg_str(args, "path"),
                )?;
                let ops = Store::sections_append(&heading, &arg_string(args, "markdown")?);
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "sections_append",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
                )?))
            }
            "docs_append" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let doc_id = self.resolve_doc_from_args(&repo, args)?;
                let ops = Store::docs_append(&doc_id, &arg_string(args, "text")?);
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "docs_append",
                    false,
                )?))
            }
            "links_retarget" | "links_repair" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let repairs: Vec<omgbase_store::LinkRepair> = if name == "links_retarget" {
                    vec![omgbase_store::LinkRepair {
                        from: arg_string(args, "from_target")?,
                        to: arg_string(args, "to_target")?,
                    }]
                } else if let Some(list) = args.get("repairs").and_then(Json::as_array) {
                    list.iter()
                        .map(|r| {
                            Ok(omgbase_store::LinkRepair {
                                from: arg_string(r, "from")?,
                                to: arg_string(r, "to")?,
                            })
                        })
                        .collect::<Result<_>>()?
                } else if let (Some(f), Some(t)) =
                    (arg_str(args, "from_target"), arg_str(args, "to_target"))
                {
                    vec![omgbase_store::LinkRepair {
                        from: f.to_owned(),
                        to: t.to_owned(),
                    }]
                } else {
                    Vec::new()
                };
                if repairs.is_empty() {
                    return Err(SurfaceError::new(
                        "target_missing",
                        "links_repair requires `repairs` (array of {from,to}) or a `from_target`+`to_target` pair",
                    ));
                }
                let plan = self.store.links_repair(
                    &repo,
                    &repairs,
                    arg_str(args, "path_glob").filter(|g| !g.is_empty()),
                )?;
                let dry = arg_bool(args, "dry_run")?.unwrap_or(true);
                let res = self.apply_ops(&repo, root.as_deref(), plan.ops.clone(), name, dry)?;
                let mut m = Map::new();
                m.insert(
                    "hits".to_owned(),
                    Json::Array(plan.hits.iter().map(|h| json!({ "block": h.block, "path": h.path, "oldRaw": h.old_raw, "newRaw": h.new_raw })).collect()),
                );
                m.insert(
                    "pairs".to_owned(),
                    Json::Array(
                        plan.pairs
                            .iter()
                            .map(|p| json!({ "from": p.from, "to": p.to, "hits": p.hits }))
                            .collect(),
                    ),
                );
                m.insert("applied".to_owned(), json!(!dry));
                Ok(merge(m, apply_json(&res)))
            }
            "links_stale" => {
                let (repo, _) = self.scope(args)?;
                let glob = arg_str(args, "path_glob").filter(|g| !g.is_empty());
                if arg_bool(args, "summary")?.unwrap_or(false) {
                    return links::links_stale_summary(&self.store, &repo, glob);
                }
                links::links_stale(&self.store, &repo, glob, arg_i64(args, "limit")?)
            }
            "docs_create" => {
                let (repo, root) = self.scope(args)?;
                let ctx = self.doc_ctx(&repo);
                let path = arg_string(args, "path")?;
                let markdown = arg_string(args, "markdown")?;
                let fm = arg_object(args, "frontmatter")?.cloned();
                let res = self.with_writes(root.as_deref(), |store, ds| {
                    Ok(store.docs_create(&ctx, ds, &path, &markdown, fm.as_ref())?)
                })?;
                self.notify();
                Ok(doc_op_json(&res))
            }
            "docs_move" => {
                let (repo, root) = self.scope(args)?;
                let ctx = self.doc_ctx(&repo);
                let doc = arg_string(args, "doc")?;
                let to = arg_string(args, "to_path")?;
                let retarget = arg_bool(args, "retarget_inbound")?.unwrap_or(false);
                let res = self.with_writes(root.as_deref(), |store, ds| {
                    Ok(store.docs_move(&ctx, ds, &doc, &to, retarget)?)
                })?;
                self.notify();
                Ok(json!({
                    "docId": res.doc_id,
                    "path": res.path,
                    "committed": res.committed,
                    "dangling": res.dangling.iter().map(omgbase_store::InboundLink::to_json).collect::<Vec<_>>(),
                    "retargeted": res.retargeted.as_ref().map(|r| json!({ "blocks": r.blocks, "docs": r.docs })),
                }))
            }
            "docs_delete" => {
                let (repo, root) = self.scope(args)?;
                let ctx = self.doc_ctx(&repo);
                let doc = arg_string(args, "doc")?;
                let res = self.with_writes(root.as_deref(), |store, ds| {
                    Ok(store.docs_delete(&ctx, ds, &doc)?)
                })?;
                self.notify();
                Ok(doc_op_json(&res))
            }
            "docs_set_meta" => {
                let (repo, root) = self.scope(args)?;
                let ctx = self.doc_ctx(&repo);
                let doc = arg_string(args, "doc")?;
                let set = arg_object(args, "set")?.cloned();
                let unset = if args.get("unset").is_some() {
                    arg_strings(args, "unset")?
                } else {
                    Vec::new()
                };
                let res = self.with_writes(root.as_deref(), |store, ds| {
                    Ok(store.docs_set_meta(&ctx, ds, &doc, set.as_ref(), &unset)?)
                })?;
                self.notify();
                Ok(doc_op_json(&res))
            }
            "docs_plan_update" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let doc = arg_string(args, "doc")?;
                let content = arg_string(args, "content")?;
                let opset = self
                    .store
                    .plan_update(&repo, &doc, &content, &self.config.clone())?;
                Ok(json!({ "opset": opset_json(&opset), "plan": render_opset_plan(&opset) }))
            }
            "docs_update" => {
                let (repo, root) = self.scope(args)?;
                let doc = arg_string(args, "doc")?;
                let content = arg_string(args, "content")?;
                let dry = arg_bool(args, "dry_run")?.unwrap_or(false);
                let reason = arg_str(args, "reason").map(str::to_owned);
                let origin = ApplyOrigin::new(ACTOR, reason.as_deref());
                let config = self.config.clone();
                let ts = self.now();
                let (opset, result) = self.with_writes(root.as_deref(), |store, ds| {
                    Ok(store.docs_update(&repo, &doc, &content, &config, &origin, dry, ds, &ts)?)
                })?;
                if !dry {
                    self.notify();
                }
                Ok(json!({
                    "opset": opset_json(&opset),
                    "plan": render_opset_plan(&opset),
                    "result": result.map(|r| apply_json(&r)),
                }))
            }
            "observe" => {
                let (repo, _) = self.scope(args)?;
                let path = arg_string(args, "path")?;
                let content = arg_string(args, "content")?;
                let ts = self.now();
                let config = self.config.clone();
                let out = self
                    .store
                    .observe_one(&repo, &path, &content, &ts, &config)?;
                self.store.sweep_pool(&ts)?;
                self.notify();
                Ok(observe_json(&out))
            }
            "observe_many" => {
                let (repo, _) = self.scope(args)?;
                let files = args
                    .get("files")
                    .and_then(Json::as_array)
                    .ok_or_else(|| bad_args("`files` must be an array of {path, content}"))?;
                let items: Vec<omgbase_store::BatchItem> = files
                    .iter()
                    .map(|f| {
                        Ok(omgbase_store::BatchItem::observed(
                            &arg_string(f, "path")?,
                            &arg_string(f, "content")?,
                        ))
                    })
                    .collect::<Result<_>>()?;
                let ts = self.now();
                let config = self.config.clone();
                let outcomes = self.store.observe_batch(&repo, &items, &ts, &config)?;
                self.store.sweep_pool(&ts)?;
                self.notify();
                let mut out = Vec::with_capacity(outcomes.len());
                for o in &outcomes {
                    match o.as_observed() {
                        Some(obs) => out.push(observe_json(obs)),
                        None => {
                            return Err(SurfaceError::other(format!(
                                "observe_many: unexpected outcome for {}",
                                o.path()
                            )));
                        }
                    }
                }
                Ok(Json::Array(out))
            }
            "observe_delete" => {
                let (repo, _) = self.scope(args)?;
                let path = arg_string(args, "path")?;
                let ts = self.now();
                let out = self.store.observe_delete(&repo, &path, &ts)?;
                self.notify();
                Ok(json!({ "docId": out.doc_id, "path": out.path, "deleted": out.deleted() }))
            }
            "history_node" => history::history_node(
                &self.store,
                &arg_string(args, "id")?,
                arg_i64(args, "limit")?,
            ),
            "diff" => {
                let (repo, _) = self.scope(args)?;
                let doc_id = self.resolve_doc_id(&repo, arg_str(args, "doc"), None, None)?;
                history::diff_blocks(
                    &self.store,
                    &doc_id,
                    &arg_string(args, "from_rev")?,
                    &arg_string(args, "to_rev")?,
                )
            }
            "diff_unified" => {
                let (repo, _) = self.scope(args)?;
                let doc_ref = arg_string(args, "doc")?;
                let doc_id = self.resolve_doc_id(&repo, Some(&doc_ref), None, None)?;
                let revs = history::recent_revs(self.store.conn(), &doc_id)?;
                let to_rev = arg_str(args, "to_rev")
                    .map(str::to_owned)
                    .or_else(|| revs.first().cloned());
                let from_rev = arg_str(args, "from_rev")
                    .map(str::to_owned)
                    .or_else(|| revs.get(1).cloned())
                    .or_else(|| revs.first().cloned());
                let (Some(from), Some(to)) = (from_rev, to_rev) else {
                    return Err(SurfaceError::new(
                        "target_missing",
                        format!("no revisions to diff for {}", Json::String(doc_ref)),
                    ));
                };
                let path: Option<String> = self
                    .store
                    .conn()
                    .query_row(
                        "SELECT path FROM docs WHERE doc_id = ?1",
                        params![doc_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                let diff = history::diff_unified_text(&self.store, &doc_id, &from, &to)?;
                Ok(
                    json!({ "doc": doc_id, "path": path.unwrap_or_default(), "from": from, "to": to, "diff": diff }),
                )
            }
            "docs_read_at" => {
                let (repo, _) = self.scope(args)?;
                let doc_id = self.resolve_doc_from_args(&repo, args)?;
                let rev = arg_string(args, "rev")?;
                read::docs_read_at(&self.store, &doc_id, &rev)?.ok_or_else(|| {
                    SurfaceError::with_data(
                        "target_missing",
                        format!(
                            "no revision {} for document {doc_id}",
                            Json::String(rev.clone())
                        ),
                        json!({ "doc": doc_id, "rev": rev }),
                    )
                })
            }
            "docs_history" => {
                let (repo, _) = self.scope(args)?;
                let glob = arg_str(args, "path_glob").filter(|g| !g.is_empty());
                let doc = arg_str(args, "doc").filter(|d| !d.is_empty());
                if glob.is_none() && doc.is_none() {
                    return Err(SurfaceError::new(
                        "target_missing",
                        "docs_history requires one of path_glob or doc",
                    ));
                }
                let include_deleted = arg_bool(args, "include_deleted")?.unwrap_or(false);
                if let Some(d) = doc {
                    if history::resolve_doc_row(self.store.conn(), &repo, d, include_deleted)?
                        .is_none()
                    {
                        return Err(SurfaceError::new(
                            "doc_missing",
                            format!("no document for {}", Json::String(d.to_owned())),
                        ));
                    }
                }
                history::docs_history(
                    &self.store,
                    &repo,
                    glob,
                    doc,
                    include_deleted,
                    arg_i64(args, "limit")?,
                )
            }
            "changes_since" => {
                let (repo, _) = self.scope(args)?;
                let page = self.store.changes_since(
                    &repo,
                    arg_i64(args, "cursor")?.unwrap_or(0),
                    arg_usize(args, "limit")?.unwrap_or(50),
                    arg_str(args, "origin").filter(|o| !o.is_empty()),
                )?;
                Ok(page.to_json())
            }
            "repos_status" => {
                let (repo, root) = self.scope(args)?;
                let fs = RealFileSystem;
                let disk = root
                    .as_deref()
                    .map(|r| (&fs as &dyn omgbase_sync::FileSystem, Path::new(r)));
                Ok(omgbase_sync::repos_status(&self.store, &repo, disk)?.to_json())
            }
            "sync_status" => {
                let (repo, root) = self.scope(args)?;
                let fs = RealFileSystem;
                let disk = root
                    .as_deref()
                    .map(|r| (&fs as &dyn omgbase_sync::FileSystem, Path::new(r)));
                Ok(omgbase_sync::sync_status(&self.store, &repo, disk)?.to_json())
            }
            "repos" => {
                let rows = self.repo_rows()?;
                Ok(json!({
                    "repos": rows.iter().map(|r| json!({ "slug": r.slug, "hasSource": r.root_path.is_some() })).collect::<Vec<_>>(),
                }))
            }
            other => Err(SurfaceError::other(format!("unknown tool {other}"))),
        }
    }
}

/// `spec/mutate` §4's result on the wire: `{ results: [{ ids, removed?,
/// mergedInto? }], revisions, diffs?, committed }` (camelCase, as the
/// reference).
#[must_use]
pub fn apply_json(res: &ApplyResult) -> Json {
    let mut m = Map::new();
    m.insert(
        "results".to_owned(),
        Json::Array(
            res.results
                .iter()
                .map(|r| {
                    let mut o = Map::new();
                    o.insert("ids".to_owned(), json!(r.ids));
                    if let Some(rm) = &r.removed {
                        o.insert("removed".to_owned(), json!(rm));
                    }
                    if let Some(mi) = &r.merged_into {
                        o.insert("mergedInto".to_owned(), json!(mi));
                    }
                    Json::Object(o)
                })
                .collect(),
        ),
    );
    m.insert(
        "revisions".to_owned(),
        Json::Array(
            res.revisions
                .iter()
                .map(|r| json!({ "doc": r.doc, "path": r.path }))
                .collect(),
        ),
    );
    if let Some(diffs) = &res.diffs {
        let mut d = Map::new();
        for (path, diff) in diffs {
            d.insert(
                path.clone(),
                json!({ "before": diff.before, "after": diff.after }),
            );
        }
        m.insert("diffs".to_owned(), Json::Object(d));
    }
    m.insert("committed".to_owned(), json!(res.committed));
    Json::Object(m)
}

/// A document operation's result: `{ docId, path, committed }`.
fn doc_op_json(res: &omgbase_store::DocOpResult) -> Json {
    json!({ "docId": res.doc_id, "path": res.path, "committed": res.committed })
}

/// `spec/mutate` §7's opset on the wire (camelCase precondition keys and
/// `matcherV`, as the reference).
#[must_use]
pub fn opset_json(opset: &Opset) -> Json {
    let mut m = Map::new();
    m.insert("version".to_owned(), json!(1));
    m.insert("kind".to_owned(), json!("doc_update"));
    m.insert(
        "target".to_owned(),
        json!({ "doc": opset.target_doc, "path": opset.target_path }),
    );
    m.insert(
        "precondition".to_owned(),
        json!({
            "doc": opset.precondition.doc,
            "path": opset.precondition.path,
            "baseRevision": opset.precondition.base_revision,
            "baseContentHash": opset.precondition.base_content_hash,
        }),
    );
    m.insert("matcherV".to_owned(), json!(opset.matcher_v));
    m.insert(
        "ops".to_owned(),
        Json::Array(
            opset
                .ops
                .iter()
                .map(|p| {
                    let mut o = Map::new();
                    o.insert("op".to_owned(), p.op.to_json());
                    o.insert("disposition".to_owned(), json!(p.disposition.as_str()));
                    o.insert("blocks".to_owned(), json!(p.blocks));
                    o.insert("confidence".to_owned(), json!(p.confidence));
                    o.insert("reason".to_owned(), json!(p.reason));
                    if let Some(d) = &p.detail {
                        o.insert("detail".to_owned(), d.clone());
                    }
                    Json::Object(o)
                })
                .collect(),
        ),
    );
    if let Some(fm) = &opset.frontmatter {
        m.insert("frontmatter".to_owned(), json!({ "raw": fm }));
    }
    m.insert("summary".to_owned(), opset.summary.to_json());
    m.insert("converges".to_owned(), json!(opset.converges));
    m.insert("diagnostics".to_owned(), json!(opset.diagnostics));
    Json::Object(m)
}

/// `spec/search` §4's evidence on the wire: `{ rrf, boosts, ftsRank?,
/// vectorRank?, cosine? }`.
fn evidence_json(e: &omgbase_store::Evidence) -> Json {
    let mut m = Map::new();
    m.insert("rrf".to_owned(), json!(e.rrf));
    m.insert("boosts".to_owned(), e.boosts.to_json());
    if let Some(r) = e.fts_rank {
        m.insert("ftsRank".to_owned(), json!(r));
    }
    if let Some(r) = e.vector_rank {
        m.insert("vectorRank".to_owned(), json!(r));
        if let Some(c) = e.cosine {
            m.insert("cosine".to_owned(), json!(c));
        }
    }
    Json::Object(m)
}

/// The public `observe` result: `{ docId, path, rev, commitId, converged,
/// echo, conflicted, dispositions: [{ kind, count }] }`.
fn observe_json(o: &omgbase_store::ObserveOutcome) -> Json {
    json!({
        "docId": o.doc_id,
        "path": o.path,
        "rev": o.rev,
        "commitId": o.commit_id,
        "converged": o.converged,
        "echo": o.echo,
        "conflicted": o.conflicted,
        "dispositions": o.dispositions.iter().map(|(k, n)| json!({ "kind": k, "count": n })).collect::<Vec<_>>(),
    })
}

fn verb(d: omgbase_store::mutate_kernel::PlanDisposition) -> &'static str {
    use omgbase_store::mutate_kernel::PlanDisposition as D;
    match d {
        D::Same => "KEEP  ",
        D::Edited | D::EditedMoved => "UPDATE",
        D::Moved => "MOVE  ",
        D::Inserted => "INSERT",
        D::Deleted => "REMOVE",
        D::SplitFrom => "SPLIT ",
        D::MergedInto => "MERGE ",
        D::CopiedFrom => "COPY  ",
        D::Resurrected => "RESURR",
        D::BulkRewrite => "REWRITE",
        D::Retiled => "RETILE",
    }
}

/// The one-line-per-op plan text of `docs_plan_update` / `docs_update`.
#[must_use]
pub fn render_opset_plan(opset: &Opset) -> String {
    let mut lines = Vec::new();
    for p in &opset.ops {
        let subject = p.blocks.first().map_or("(new)", String::as_str);
        let conf = p.confidence.map_or(String::new(), |c| format!(" ~{c:.2}"));
        let why = p
            .reason
            .as_ref()
            .map_or(String::new(), |r| format!(" [{r}]"));
        lines.push(format!(
            "{} {:<9} {}{conf}{why}",
            verb(p.disposition),
            subject,
            p.disposition.as_str()
        ));
    }
    let s = &opset.summary;
    lines.push(String::new());
    lines.push(format!(
        "preserved: {}  updated: {}  moved: {}  created: {}  removed: {}  split: {}  merged: {}  ambiguous: {}",
        s.preserved, s.updated, s.moved, s.created, s.removed, s.split, s.merged, s.ambiguous
    ));
    if !opset.converges {
        lines.push(
            "WARNING: plan does not reproduce the proposed content exactly — will not apply."
                .to_owned(),
        );
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_store::{MemDocStore, SequentialMinter};

    fn surface() -> Surface {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        let mut n = 0;
        Surface::new(store, &repo, None)
            .with_doc_store(Box::new(MemDocStore::new()))
            .with_clock(move || {
                n += 1;
                format!("2026-09-26T10:{n:02}:00.000Z")
            })
    }

    #[test]
    fn catalog_lists_every_tool_of_the_table() {
        let names: Vec<&str> = tools().iter().map(|t| t.name).collect();
        for want in [
            "docs_outline",
            "docs_read",
            "docs_get_many",
            "nodes_get",
            "nodes_get_many",
            "read_ref",
            "docs_tree",
            "docs_list",
            "query_syntax",
            "query",
            "graph",
            "text_search",
            "resolve",
            "apply",
            "blocks_insert",
            "blocks_update",
            "blocks_move",
            "blocks_remove",
            "blocks_split",
            "blocks_merge",
            "tasks_complete",
            "node_set",
            "sections_append",
            "docs_append",
            "links_retarget",
            "links_stale",
            "links_repair",
            "docs_create",
            "docs_move",
            "docs_delete",
            "docs_set_meta",
            "docs_plan_update",
            "docs_update",
            "observe",
            "observe_many",
            "observe_delete",
            "history_node",
            "diff",
            "diff_unified",
            "docs_read_at",
            "docs_history",
            "changes_since",
            "repos_status",
            "sync_status",
            "repos",
        ] {
            assert!(names.contains(&want), "missing {want}");
        }
        assert_eq!(names.len(), 45);
        for t in tools() {
            assert_eq!(t.input_schema["type"], "object");
        }
    }

    #[test]
    fn observe_read_and_query_round_trip() {
        let mut s = surface();
        let out = s.call("observe", json!({ "path": "a.md", "content": "---\nlayer: canon\n---\n# Title\n\nHello world.\n\n- [ ] task one\n" }));
        assert!(!out.is_error, "{}", out.body);
        assert_eq!(out.body["docId"], "d_0");
        assert_eq!(out.body["echo"], false);
        let read = s.call("docs_read", json!({ "doc": "a.md", "include_ids": true }));
        assert!(!read.is_error);
        assert_eq!(read.body["path"], "a.md");
        assert_eq!(read.body["properties"]["frontmatter"]["layer"], "canon");
        assert!(read.body["ids"].as_array().unwrap().len() >= 3);
        let q = s.call("query", json!({ "query": "select $title, layer, t: nodes collect { value where kind == \"md:task\" } from docs where layer == \"canon\" && nodes count { where kind == \"md:task\" } == 1" }));
        assert!(!q.is_error, "{}", q.body);
        assert_eq!(q.body["hits"][0]["$title"], "Title");
        assert_eq!(q.body["hits"][0]["layer"], "canon");
        assert_eq!(q.body["hits"][0]["t"][0]["value"], "task one");
        assert_eq!(q.body["hits"][0]["id"], "d_0");
        assert_eq!(q.body["consumer"], "collect");
        let c = s.call(
            "query",
            json!({ "query": "$repo.blocks count { where text(\"hello\") }" }),
        );
        assert_eq!(c.body["count"], 1);
        let bad = s.call(
            "query",
            json!({ "query": "from docs where path == \"a.md\"" }),
        );
        assert!(bad.is_error);
        assert_eq!(bad.body["error"], "filter_invalid");
        assert!(
            bad.body["message"]
                .as_str()
                .unwrap()
                .contains("did you mean the intrinsic $path")
        );
        let sem = s.call(
            "query",
            json!({ "query": "from docs where semantic(\"x\") > 0.5" }),
        );
        assert_eq!(sem.body["error"], "semantic_unavailable");
        let outline = s.call("docs_outline", json!({ "path": "a.md" }));
        let text = outline.body["text"].as_str().unwrap();
        assert!(text.starts_with("b_0 h1   Title  §"), "{text}");
        assert!(text.contains("☐ task one"));
        let missing = s.call("docs_read", json!({ "doc": "nope.md" }));
        assert_eq!(missing.body["error"], "doc_missing");
        let repos = s.call("repos", json!({}));
        assert_eq!(repos.body["repos"][0]["slug"], "fixture");
        let unknown = s.call("docs_list", json!({ "repo": "zzz" }));
        assert_eq!(unknown.body["error"], "repo_not_found");
    }

    #[test]
    fn writes_go_through_the_fixed_doc_store_and_fire_the_hook() {
        use std::cell::Cell;
        use std::rc::Rc;
        let fired = Rc::new(Cell::new(0));
        let f2 = Rc::clone(&fired);
        let mut s = surface().with_mutation_hook(move || f2.set(f2.get() + 1));
        s.call(
            "observe",
            json!({ "path": "a.md", "content": "# T\n\nOne.\n" }),
        );
        assert_eq!(fired.get(), 1);
        let dry = s.call(
            "blocks_insert",
            json!({ "to": "a.md", "markdown": "Two.", "dry_run": true }),
        );
        assert!(!dry.is_error, "{}", dry.body);
        assert_eq!(dry.body["committed"], false);
        assert_eq!(fired.get(), 1, "a dry run never fires the hook");
        let wet = s.call("blocks_insert", json!({ "to": "a.md", "markdown": "Two." }));
        assert!(!wet.is_error, "{}", wet.body);
        assert_eq!(fired.get(), 2);
        let read = s.call("docs_read", json!({ "doc": "d_0" }));
        assert_eq!(read.body["content"], "# T\n\nOne.\n\nTwo.\n");
        let upd = s.call(
            "blocks_update",
            json!({ "block": "b_1", "markdown": "One, edited." }),
        );
        assert!(!upd.is_error, "{}", upd.body);
        assert_eq!(upd.body["id"], "b_1");
        let app = s.call(
            "sections_append",
            json!({ "heading": "T", "markdown": "Three." }),
        );
        assert!(!app.is_error, "{}", app.body);
        let amb = s.call(
            "sections_append",
            json!({ "heading": "Nope", "markdown": "x" }),
        );
        assert_eq!(amb.body["error"], "parent_missing");
        let hist = s.call("history_node", json!({ "id": "b_1" }));
        let entries = hist.body.as_array().unwrap();
        assert!(entries.len() >= 2, "{}", hist.body);
        assert_eq!(entries[0]["origin"], "api", "newest first");
        let du = s.call("diff_unified", json!({ "doc": "a.md" }));
        assert!(!du.is_error, "{}", du.body);
        assert!(du.body["diff"].as_str().unwrap().contains("+ Three."));
    }
}
