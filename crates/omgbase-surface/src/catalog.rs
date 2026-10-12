//! The MCP tool catalog (`spec/surface/README.md` §4) as a library: a table
//! of [`ToolSpec`]s (name, JSON-schema input, description) and one dispatch
//! ([`Surface::call`]) that runs a tool against the store and returns its
//! JSON result or the error envelope. Transport-agnostic — a server wraps
//! each outcome in one text content item. Port of
//! `packages/core/src/mcp/server.ts`.
//!
//! Paths (`spec/surface` §1 "Paths", 2.0): every path a tool returns is the
//! reference form (`/a/b.md`) and every path argument accepts either form.
//! The surface's own readers root their results; the results another spec
//! pins in the storage form — the store's apply / document-operation /
//! observe outcomes, opsets, change digests, search hits — are re-shaped
//! here, exactly as the reference's `surface-paths.ts` re-shapes them.

use std::path::Path;

use omgbase_format::BlockKind;
use omgbase_format::text::{normalize_text, normalize_visible_text};
use omgbase_reconcile::Config;
use omgbase_search::EmbeddingProvider;
use omgbase_store::docs_ops::diffs_json;
use omgbase_store::mutate_kernel::effects::Admission;
use omgbase_store::mutate_kernel::{At, Op, Parent, To};
use omgbase_store::{
    ApplyOrigin, ApplyRequest, ApplyResult, DocOpContext, DocStore, EffectsOutcome, Expect,
    FsDocStore, Opset, Plan, PlanContext, PublicEffect, QueryVector, Receipt, Store,
};
use omgbase_sync::{RealFileSystem, RepoRow};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::arguments::{argument_error, validate_arguments};
use crate::error::{Result, SurfaceError};
use crate::graph::{GraphArgs, graph_neighborhood};
use crate::history;
use crate::links;
use crate::paths::{reference_keyed, reference_path, root_field, storage_path};
use crate::query::{QueryOptions, query};
use crate::read::{self, Resolution, ResolvedRef};
use crate::reference::QUERY_SYNTAX;
use crate::version::{BuildInfo, version_info};

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
    /// The configured provider's name (`embedding.provider`), for the
    /// `provider_unavailable` error's `data` when the host knows it.
    provider_name: Option<String>,
    on_mutation: Option<Box<dyn FnMut()>>,
    clock: Box<dyn FnMut() -> String>,
    writes: WriteTarget,
    config: Config,
    /// The actor every write records (`ACTOR` unless a client names one).
    actor: String,
    /// What the serving binary knows about itself (the `version` tool).
    build_info: BuildInfo,
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

fn hex_field(e: &Map<String, Json>, k: &str) -> Option<String> {
    e.get(k).and_then(Json::as_str).map(str::to_owned)
}

/// A block tool's `expect { content_hash?, parent_children_hash? }` (the
/// reference's `expectSchema`, both keys optional), or `None` when absent.
fn arg_expect(args: &Json) -> Result<Option<Expect>> {
    Ok(arg_object(args, "expect")?.map(|e| Expect {
        content_hash: hex_field(e, "content_hash"),
        parent_children_hash: hex_field(e, "parent_children_hash"),
    }))
}

/// `blocks_insert` / `blocks_move`'s `expect { parent_children_hash? }` — the
/// destination-parent CAS of `spec/mutate` §1.2 (1.2). A `content_hash` has
/// no meaning on these ops and is dropped, not an error (the reference's zod
/// schema strips it).
fn arg_parent_expect(args: &Json) -> Result<Option<Expect>> {
    Ok(arg_object(args, "expect")?.map(|e| Expect {
        content_hash: None,
        parent_children_hash: hex_field(e, "parent_children_hash"),
    }))
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
/// `blocks_insert` / `blocks_move` carry the op-level expectation of
/// `spec/mutate` §1.2: only `parent_children_hash` has a meaning there (no
/// target block whose content could be checked), so the schema names that
/// key alone, as the reference's `parentExpectSchema`.
fn effects_schema() -> Json {
    json!({ "type": "array", "items": { "type": "object" } })
}

fn parent_expect_schema() -> Json {
    json!({ "type": "object", "properties": { "parent_children_hash": { "type": "string" } } })
}

/// The catalog (§4 table), in the reference's registration order. The
/// descriptions are the reference's, byte for byte, generated into
/// [`descriptions`](crate::descriptions) from `spec/surface/tool-descriptions.json`
/// (`scripts/gen-tool-descriptions.mjs`); `tests/spec.rs` pins the parity.
#[must_use]
pub fn tools() -> Vec<ToolSpec> {
    catalog().to_vec()
}

/// The catalog, built once.
pub(crate) fn catalog() -> &'static [ToolSpec] {
    static CATALOG: std::sync::OnceLock<Vec<ToolSpec>> = std::sync::OnceLock::new();
    CATALOG.get_or_init(build_catalog)
}

/// The spec of one tool, by name.
pub(crate) fn tool_spec(name: &str) -> Option<&'static ToolSpec> {
    catalog().iter().find(|t| t.name == name)
}

#[allow(clippy::too_many_lines)]
fn build_catalog() -> Vec<ToolSpec> {
    use crate::descriptions as d;
    // The document locator every `docs_*` tool takes (§4 "Arguments"): the
    // row's own attributes, at least one of them (checked by the handler).
    let doc = |extra: &[(&str, Json)], required: &[&str]| {
        let mut props = vec![("id", s()), ("path", s())];
        props.extend(extra.iter().cloned());
        schema(&props, required, true)
    };
    vec![
        ToolSpec {
            name: "docs_outline",
            description: d::DOCS_OUTLINE,
            input_schema: doc(
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
            description: d::DOCS_READ,
            input_schema: doc(&[("include_ids", b())], &[]),
        },
        ToolSpec {
            name: "docs_read_many",
            description: d::DOCS_READ_MANY,
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
            name: "blocks_read",
            description: d::BLOCKS_READ,
            input_schema: schema(
                &[("id", s()), ("resolution", resolution_schema())],
                &["id"],
                true,
            ),
        },
        ToolSpec {
            name: "nodes_block_read",
            description: d::NODES_BLOCK_READ,
            input_schema: schema(
                &[("id", s()), ("resolution", resolution_schema())],
                &["id"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_read_many",
            description: d::BLOCKS_READ_MANY,
            input_schema: schema(
                &[
                    ("ids", strings()),
                    ("resolution", resolution_schema()),
                    ("budget_tokens", i()),
                ],
                &["ids"],
                true,
            ),
        },
        ToolSpec {
            name: "docs_tree",
            description: d::DOCS_TREE,
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
            description: d::DOCS_LIST,
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
            description: d::QUERY_SYNTAX,
            input_schema: schema(&[], &[], false),
        },
        ToolSpec {
            name: "query",
            description: d::QUERY,
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
            description: d::GRAPH,
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
            name: "blocks_search",
            description: d::BLOCKS_SEARCH,
            input_schema: schema(&[("q", s()), ("limit", i())], &["q"], true),
        },
        ToolSpec {
            name: "blocks_resolve",
            description: d::BLOCKS_RESOLVE,
            input_schema: schema(&[("query", s()), ("limit", i())], &["query"], true),
        },
        ToolSpec {
            name: "apply",
            description: d::APPLY,
            input_schema: schema(
                &[
                    (
                        "ops",
                        json!({ "type": "array", "items": { "type": "object" } }),
                    ),
                    ("effects", effects_schema()),
                    ("reason", s()),
                    ("dry_run", b()),
                ],
                &[],
                true,
            ),
        },
        ToolSpec {
            name: "plan",
            description: d::PLAN,
            input_schema: schema(&[("effects", effects_schema())], &["effects"], true),
        },
        ToolSpec {
            name: "execute",
            description: d::EXECUTE,
            input_schema: schema(
                &[
                    ("plan", obj()),
                    ("plan_id", s()),
                    ("effects", effects_schema()),
                    ("reason", s()),
                ],
                &[],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_insert",
            description: d::BLOCKS_INSERT,
            input_schema: schema(
                &[
                    ("to", s()),
                    ("markdown", s()),
                    ("at", at_schema()),
                    ("expect", parent_expect_schema()),
                    ("dry_run", b()),
                ],
                &["to", "markdown"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_update",
            description: d::BLOCKS_UPDATE,
            input_schema: schema(
                &[
                    ("id", s()),
                    ("markdown", s()),
                    ("checked", b()),
                    ("attrs", obj()),
                    ("expect", expect_schema()),
                    ("dry_run", b()),
                ],
                &["id"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_move",
            description: d::BLOCKS_MOVE,
            input_schema: schema(
                &[
                    ("blocks", strings()),
                    ("to", s()),
                    ("at", at_schema()),
                    ("expect", parent_expect_schema()),
                    ("dry_run", b()),
                ],
                &["blocks", "to"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_remove",
            description: d::BLOCKS_REMOVE,
            input_schema: schema(
                &[("blocks", strings()), ("dry_run", b())],
                &["blocks"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_split",
            description: d::BLOCKS_SPLIT,
            input_schema: schema(
                &[
                    ("id", s()),
                    (
                        "at",
                        json!({ "type": "array", "items": { "type": "integer" } }),
                    ),
                    ("dry_run", b()),
                ],
                &["id", "at"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_merge",
            description: d::BLOCKS_MERGE,
            input_schema: schema(
                &[("blocks", strings()), ("separator", s()), ("dry_run", b())],
                &["blocks"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_check",
            description: d::BLOCKS_CHECK,
            input_schema: schema(
                &[("ids", strings()), ("checked", b()), ("dry_run", b())],
                &["ids"],
                true,
            ),
        },
        ToolSpec {
            name: "nodes_set",
            description: d::NODES_SET,
            input_schema: schema(
                &[("id", s()), ("prop", s()), ("value", s()), ("dry_run", b())],
                &["id", "prop", "value"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_append",
            description: d::BLOCKS_APPEND,
            input_schema: schema(
                &[("id", s()), ("text", s()), ("dry_run", b())],
                &["id", "text"],
                true,
            ),
        },
        ToolSpec {
            name: "docs_append",
            description: d::DOCS_APPEND,
            input_schema: doc(
                &[("text", s()), ("section", s()), ("dry_run", b())],
                &["text"],
            ),
        },
        ToolSpec {
            name: "links_retarget",
            description: d::LINKS_RETARGET,
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
            description: d::LINKS_STALE,
            input_schema: schema(
                &[("path_glob", s()), ("limit", i()), ("summary", b())],
                &[],
                true,
            ),
        },
        ToolSpec {
            name: "links_repair",
            description: d::LINKS_REPAIR,
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
            description: d::DOCS_CREATE,
            input_schema: schema(
                &[
                    ("path", s()),
                    ("markdown", s()),
                    ("frontmatter", obj()),
                    ("dry_run", b()),
                ],
                &["path", "markdown"],
                true,
            ),
        },
        ToolSpec {
            name: "docs_move",
            description: d::DOCS_MOVE,
            input_schema: doc(
                &[
                    ("to_path", s()),
                    ("retarget_inbound", b()),
                    ("dry_run", b()),
                ],
                &["to_path"],
            ),
        },
        ToolSpec {
            name: "docs_delete",
            description: d::DOCS_DELETE,
            input_schema: doc(&[("dry_run", b())], &[]),
        },
        ToolSpec {
            name: "docs_set_meta",
            description: d::DOCS_SET_META,
            input_schema: doc(
                &[("set", obj()), ("unset", strings()), ("dry_run", b())],
                &[],
            ),
        },
        ToolSpec {
            name: "docs_update",
            description: d::DOCS_UPDATE,
            input_schema: doc(
                &[("content", s()), ("reason", s()), ("dry_run", b())],
                &["content"],
            ),
        },
        ToolSpec {
            name: "observe",
            description: d::OBSERVE,
            input_schema: schema(
                &[("path", s()), ("content", s())],
                &["path", "content"],
                true,
            ),
        },
        ToolSpec {
            name: "observe_many",
            description: d::OBSERVE_MANY,
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
            description: d::OBSERVE_DELETE,
            input_schema: schema(&[("path", s())], &["path"], true),
        },
        ToolSpec {
            name: "blocks_history",
            description: d::BLOCKS_HISTORY,
            input_schema: schema(&[("id", s()), ("limit", i())], &["id"], false),
        },
        ToolSpec {
            name: "docs_diff",
            description: d::DOCS_DIFF,
            input_schema: doc(
                &[("from_rev", s()), ("to_rev", s())],
                &["from_rev", "to_rev"],
            ),
        },
        ToolSpec {
            name: "docs_diff_unified",
            description: d::DOCS_DIFF_UNIFIED,
            input_schema: doc(&[("from_rev", s()), ("to_rev", s())], &[]),
        },
        ToolSpec {
            name: "docs_read_at",
            description: d::DOCS_READ_AT,
            input_schema: doc(&[("rev", s())], &["rev"]),
        },
        ToolSpec {
            name: "docs_history",
            description: d::DOCS_HISTORY,
            input_schema: schema(
                &[
                    ("path_glob", s()),
                    ("id", s()),
                    ("path", s()),
                    ("include_deleted", b()),
                    ("limit", i()),
                ],
                &[],
                true,
            ),
        },
        ToolSpec {
            name: "changes_since",
            description: d::CHANGES_SINCE,
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
            description: d::REPOS_STATUS,
            input_schema: schema(&[], &[], true),
        },
        ToolSpec {
            name: "sync_status",
            description: d::SYNC_STATUS,
            input_schema: schema(&[], &[], true),
        },
        ToolSpec {
            name: "repos",
            description: d::REPOS,
            input_schema: schema(&[], &[], false),
        },
        ToolSpec {
            name: "version",
            description: d::VERSION,
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
        // Read-path tuning of the surface's own connection; neither pragma
        // changes a result. The reference runs on better-sqlite3, whose
        // bundled SQLite is compiled with a 16 MB default page cache
        // (`SQLITE_DEFAULT_CACHE_SIZE=-16000`); rusqlite's bundled build
        // keeps the stock 2 MB, so the same root scans and pushed
        // predicates over a database of tens of MB miss the cache and
        // `pread` page by page. `temp_store=MEMORY` keeps the sorter of a
        // `… ORDER BY d.path, b.block_id` scan (tens of thousands of rows)
        // from spilling its runs to temp files. A failure here only leaves
        // the connection untuned.
        let _ = store
            .conn()
            .execute_batch("PRAGMA cache_size = -16000; PRAGMA temp_store = MEMORY;");
        Self {
            store,
            default_repo: default_repo.to_owned(),
            provider,
            provider_name: None,
            on_mutation: None,
            clock: Box::new(omgbase_sync::now_ts),
            writes: WriteTarget::Derived,
            config: Config::default(),
            actor: ACTOR.to_owned(),
            build_info: BuildInfo::default(),
        }
    }

    /// Name the configured embedding provider (`embedding.provider`) so a
    /// `provider_unavailable` error can say which one cannot rank.
    #[must_use]
    pub fn with_provider_name(mut self, name: &str) -> Self {
        self.provider_name = Some(name.to_owned());
        self
    }

    /// Record `actor` on every write instead of [`ACTOR`] (the CLI's
    /// `human:<user>` / `--actor`; the MCP server keeps the default).
    #[must_use]
    pub fn with_actor(mut self, actor: &str) -> Self {
        self.set_actor(actor);
        self
    }

    /// Change the actor of the writes that follow.
    pub fn set_actor(&mut self, actor: &str) {
        self.actor = actor.to_owned();
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

    /// The serving binary's identity for the `version` tool (§4, 1.4): its
    /// own version, `spec/cli` version, build commit and time, compiler. A
    /// library embedding keeps the default (this crate's version, nulls).
    #[must_use]
    pub fn with_build_info(mut self, build_info: BuildInfo) -> Self {
        self.build_info = build_info;
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

    /// Whether `name` is a tool that can commit (a host serializes these
    /// under the writer lock of `spec/sync` §7; `dry_run` calls still count
    /// here — only the mutation hook knows a write actually happened).
    #[must_use]
    pub fn is_write_tool(name: &str) -> bool {
        matches!(
            name,
            "apply"
                | "plan"
                | "execute"
                | "blocks_insert"
                | "blocks_update"
                | "blocks_move"
                | "blocks_remove"
                | "blocks_split"
                | "blocks_merge"
                | "blocks_check"
                | "nodes_set"
                | "blocks_append"
                | "docs_append"
                | "links_retarget"
                | "links_repair"
                | "docs_create"
                | "docs_move"
                | "docs_delete"
                | "docs_set_meta"
                | "docs_update"
                | "observe"
                | "observe_many"
                | "observe_delete"
        )
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

    // ---- the document locator (§4 "Arguments") ---------------------------------------
    // `id` is the document's id, `path` its path (either form, §1 "Paths"); at
    // least one is required, and when both are given they must name the same
    // document. A tool whose prefix is not `docs` refers to a document as the
    // every `docs_*` tool — `docs_diff` and `docs_diff_unified` included — under the same
    // rules (the names are bare because the attributes themselves are becoming
    // bare — surface 3.0 attribute flip, follow-up). A miss is `doc_missing`
    // "no document with id or path "<value>"" with the arguments as given in
    // `data`; neither given is `filter_invalid` "pass id or path"; a
    // disagreement is `filter_invalid` "id "…" and path "…" name different
    // documents". The reference's `locateDoc`, byte for byte.
    fn locate_doc(&self, repo_id: &str, tool: &str, args: &Json) -> Result<String> {
        let (id_key, path_key) = ("id", "path");
        let schema = &tool_spec(tool).expect("a catalog tool").input_schema;
        let id = arg_str(args, id_key);
        let path = arg_str(args, path_key);
        if id.is_none() && path.is_none() {
            return Err(argument_error(
                tool,
                &format!("pass {id_key} or {path_key}"),
                schema,
            ));
        }
        let mut given = Map::new();
        if let Some(v) = id {
            given.insert(id_key.to_owned(), json!(v));
        }
        if let Some(v) = path {
            given.insert(path_key.to_owned(), json!(v));
        }
        let missing = |value: &str| {
            SurfaceError::with_data(
                "doc_missing",
                format!(
                    "no document with {id_key} or {path_key} {}",
                    Json::String(value.to_owned())
                ),
                Json::Object(given.clone()),
            )
        };
        let conn = self.store.conn();
        let by_id = match id {
            Some(v) => {
                let info = read::find_doc_by_id(conn, v)?.filter(|i| i.repo_id == repo_id);
                Some(info.ok_or_else(|| missing(v))?.doc_id)
            }
            None => None,
        };
        let by_path = match path {
            Some(v) => Some(
                read::find_doc_by_path(conn, repo_id, v)?
                    .ok_or_else(|| missing(v))?
                    .doc_id,
            ),
            None => None,
        };
        if let (Some(a), Some(b)) = (&by_id, &by_path)
            && a != b
        {
            return Err(argument_error(
                tool,
                &format!(
                    "{id_key} {} and {path_key} {} name different documents",
                    Json::String(id.unwrap_or_default().to_owned()),
                    Json::String(path.unwrap_or_default().to_owned())
                ),
                schema,
            ));
        }
        Ok(by_id.or(by_path).expect("one locator given"))
    }

    /// `semantic()` is loud when it cannot rank (§4, 3.0): a provider that
    /// answers but whose model has embedded NOTHING in this repository would
    /// score every row null and hand back path-ordered rows with no score, so
    /// a query naming a phrase (`semantic`) fails `provider_unavailable` up
    /// front, naming the provider and model and what to run. No provider at
    /// all is the arm's own `provider_unavailable` (checked before this).
    fn require_rankable(&self, repo_id: &str, semantic: bool) -> Result<()> {
        let Some(provider) = self.provider.as_deref().filter(|_| semantic) else {
            return Ok(());
        };
        let model = provider.model();
        let any: Option<i64> = self
            .store
            .conn()
            .query_row(
                "SELECT 1 WHERE EXISTS (SELECT 1 FROM doc_embeddings de JOIN docs d ON d.doc_id = de.doc_id WHERE d.repo_id = ?1 AND de.model = ?2) OR EXISTS (SELECT 1 FROM embeddings WHERE model = ?2)",
                params![repo_id, model],
                |r| r.get(0),
            )
            .optional()?;
        if any.is_some() {
            return Ok(());
        }
        let who = match &self.provider_name {
            Some(name) => format!("provider {} (model {model})", Json::String(name.clone())),
            None => format!("model {model}"),
        };
        Err(SurfaceError::with_data(
            "provider_unavailable",
            format!(
                "semantic(...) cannot rank: {who} is configured but nothing in this repository is embedded under it — run omg embed drain"
            ),
            json!({ "provider": self.provider_name, "model": model }),
        ))
    }

    /// The owning document of a live block (`blocks_read`).
    fn doc_of_block(&self, block_id: &str) -> Result<String> {
        self.doc_id_of_block(block_id)?
            .ok_or_else(|| block_missing(block_id))
    }

    /// `docs_append`'s `section`: a heading's TEXT, matched against the
    /// normalized heading text of the named document's live headings (an
    /// ATX-looking value, "## Title", loses its hashes). Zero →
    /// `parent_missing` naming the heading; several → `ambiguous_heading` with
    /// the candidates `[{ id, doc_id }]` (pass the heading's id to
    /// `blocks_append` instead). Never an id lookup — the id form is
    /// `blocks_append`'s (§9).
    fn resolve_section_heading(
        &self,
        doc_id: &str,
        doc_path: &str,
        section: &str,
    ) -> Result<String> {
        let conn = self.store.conn();
        let needle = if section.trim_start_matches([' ', '\t']).starts_with('#') {
            normalize_visible_text(section, BlockKind::Heading, 0)
        } else {
            normalize_text(section)
        };
        let mut stmt = conn.prepare(
            "SELECT block_id, doc_id, text FROM blocks WHERE doc_id = ?1 AND type = 'heading' AND deleted_commit IS NULL",
        )?;
        let rows: Vec<(String, String, String)> = stmt
            .query_map(params![doc_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?;
        let matches: Vec<&(String, String, String)> = rows
            .iter()
            .filter(|(_, _, text)| normalize_text(text) == needle)
            .collect();
        let shown = reference_path(doc_path);
        match matches.len() {
            0 => Err(SurfaceError::with_data(
                "parent_missing",
                format!("no heading {} in {shown}", Json::String(section.to_owned())),
                json!({ "section": section, "path": shown }),
            )),
            1 => Ok(matches[0].0.clone()),
            n => Err(SurfaceError::with_data(
                "ambiguous_heading",
                format!(
                    "heading {} matches {n} headings in {shown}; pass the heading's id to blocks_append",
                    Json::String(section.to_owned())
                ),
                json!({
                    "section": section,
                    "path": shown,
                    "candidates": matches.iter().map(|(b, d, _)| json!({ "id": b, "doc_id": d })).collect::<Vec<_>>(),
                }),
            )),
        }
    }

    /// `nodes_block_read`: the `(doc_id, block_id)` of the live block a node
    /// was projected from — `block_missing` for an unknown node ("no node with
    /// id …") or a node with no live block ("node … has no block").
    fn block_of_node(&self, node_id: &str) -> Result<(String, String)> {
        let node: Option<(String, Option<String>)> = self
            .store
            .conn()
            .query_row(
                "SELECT doc_id, block_id FROM nodes WHERE node_id = ?1",
                params![node_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((doc_id, block_id)) = node else {
            return Err(SurfaceError::with_data(
                "block_missing",
                format!("no node with id {}", Json::String(node_id.to_owned())),
                json!({ "id": node_id }),
            ));
        };
        let live = match &block_id {
            Some(b) => self.doc_id_of_block(b)?.is_some(),
            None => false,
        };
        match block_id {
            Some(b) if live => Ok((doc_id, b)),
            _ => Err(node_has_no_block(node_id, &doc_id)),
        }
    }

    /// A ref → a live block id (`block_missing` otherwise).
    fn resolve_block_ref(&self, repo_id: &str, r: &str) -> Result<String> {
        match read::resolve_ref(self.store.conn(), repo_id, r)? {
            Some(ResolvedRef::Block { block_id, .. }) => Ok(block_id),
            _ => Err(block_missing(r)),
        }
    }

    /// A parent ref: a block, or a document ref for its top level.
    fn resolve_parent_ref(&self, repo_id: &str, r: &str) -> Result<(Parent, String)> {
        match read::resolve_ref(self.store.conn(), repo_id, r)? {
            Some(ResolvedRef::Block { doc_id, block_id }) => Ok((Parent::Block(block_id), doc_id)),
            Some(ResolvedRef::Document { doc_id }) => Ok((Parent::Doc, doc_id)),
            None => Err(SurfaceError::with_data(
                "block_missing",
                format!(
                    "no block or document with id or path {}",
                    Json::String(r.to_owned())
                ),
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
            origin: ApplyOrigin::new(&self.actor, Some(reason)),
            dry_run,
            set_frontmatter: Vec::new(),
        };
        let res = self.with_writes(root, |store, ds| Ok(store.apply(&req, ds, &ts)?))?;
        if !dry_run {
            self.notify();
        }
        Ok(res)
    }

    fn plan_ctx(&mut self, repo_id: &str) -> PlanContext {
        PlanContext {
            repo_id: repo_id.to_owned(),
            ts: self.now(),
            config: self.config.clone(),
        }
    }

    fn doc_ctx(&mut self, repo_id: &str) -> DocOpContext {
        DocOpContext {
            repo_id: repo_id.to_owned(),
            actor: Some(self.actor.clone()),
            ts: self.now(),
        }
    }

    // ---- dispatch -------------------------------------------------------------------------

    /// Run a tool, returning its result or the error.
    #[allow(clippy::too_many_lines)]
    pub fn call_result(&mut self, name: &str, args: &Json) -> Result<Json> {
        // §4 "Arguments": the shape first, so a wrong name is one
        // `filter_invalid` naming the nearest valid one.
        let spec =
            tool_spec(name).ok_or_else(|| SurfaceError::other(format!("unknown tool {name}")))?;
        validate_arguments(name, &spec.input_schema, args)?;
        match name {
            "docs_outline" => {
                let (repo, _) = self.scope(args)?;
                let doc_id = self.locate_doc(&repo, name, args)?;
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
                let doc_id = self.locate_doc(&repo, name, args)?;
                read::docs_read(
                    &self.store,
                    &doc_id,
                    arg_bool(args, "include_ids")?.unwrap_or(false),
                )?
                .ok_or_else(|| {
                    SurfaceError::with_data(
                        "doc_missing",
                        format!(
                            "no document with id or path {}",
                            Json::String(
                                arg_str(args, "id")
                                    .or(arg_str(args, "path"))
                                    .unwrap_or_default()
                                    .to_owned()
                            )
                        ),
                        json!({ "id": doc_id }),
                    )
                })
            }
            "docs_read_many" => {
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
            "blocks_read" => {
                self.scope(args)?;
                let id = arg_string(args, "id")?;
                // `id` is a block id, unambiguously the `blocks_` kind's (§4
                // "Names and arguments"): an `n_` id names a NODE and is
                // `block_missing` pointing at `nodes_block_read` (the name pass
                // had dereferenced it here, §9).
                if id.starts_with("n_") {
                    return Err(SurfaceError::with_data(
                        "block_missing",
                        format!(
                            "no block with id {} (an n_ id names a node — nodes_block_read reads its block)",
                            Json::String(id.clone())
                        ),
                        json!({ "id": id }),
                    ));
                }
                let doc_id = self.doc_of_block(&id)?;
                read::blocks_read(
                    &self.store,
                    &doc_id,
                    &id,
                    resolution_arg(args, Resolution::Full)?,
                )?
                .ok_or_else(|| block_missing(&id))
            }
            "nodes_block_read" => {
                self.scope(args)?;
                let id = arg_string(args, "id")?;
                // The block a node was projected from: the node must exist and
                // name a live block (a block-less node — one derived from the
                // frontmatter — has none). Both misses are `block_missing`,
                // the message naming the node.
                let (doc_id, block_id) = self.block_of_node(&id)?;
                read::blocks_read(
                    &self.store,
                    &doc_id,
                    &block_id,
                    resolution_arg(args, Resolution::Full)?,
                )?
                .ok_or_else(|| node_has_no_block(&id, &doc_id))
            }
            "blocks_read_many" => {
                self.scope(args)?;
                let ids = arg_strings(args, "ids")?;
                read::blocks_read_many(
                    &self.store,
                    None,
                    &ids,
                    resolution_arg(args, Resolution::Text)?,
                    arg_usize(args, "budget_tokens")?,
                )
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
                // A `semantic(...)` query with no provider is `provider_unavailable`
                // here (the runner itself reports `filter_invalid`, §9).
                if self.provider.is_none()
                    && !crate::query::collect_semantic_phrases(&source).is_empty()
                {
                    return Err(provider_unavailable());
                }
                let opts = QueryOptions {
                    limit: arg_usize(args, "limit")?,
                    cursor: arg_str(args, "cursor"),
                    provider: self.provider.as_deref(),
                    in_memory: false,
                };
                self.require_rankable(
                    &repo,
                    !crate::query::collect_semantic_phrases(&source).is_empty(),
                )?;
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
                    return Err(provider_unavailable());
                }
                self.require_rankable(
                    &repo,
                    g.select.iter().any(|s| {
                        !crate::query::collect_semantic_phrases(&format!("from docs select x: {s}"))
                            .is_empty()
                    }),
                )?;
                graph_neighborhood(&self.store, &repo, &g, self.provider.as_deref())
            }
            "blocks_search" => {
                let (repo, _) = self.scope(args)?;
                let q = arg_string(args, "q")?;
                let res =
                    self.store
                        .text_search(&repo, &q, arg_usize(args, "limit")?.unwrap_or(50))?;
                Ok(json!({
                    "hits": res.hits.iter().map(|h| json!({
                        "id": h.block_id, "doc_id": h.doc_id, "path": reference_path(&h.path), "type": h.block_type, "text": h.text, "score": h.score,
                    })).collect::<Vec<_>>(),
                    "truncated": res.truncated,
                }))
            }
            "blocks_resolve" => {
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
                // The locator is `<path>#<type>[<ordinal>]`: its path half is rooted
                // (one without `#` names no path and is left alone).
                let locator = |l: &str| match l.find('#') {
                    Some(i) => format!("{}{}", reference_path(&l[..i]), &l[i..]),
                    None => l.to_owned(),
                };
                Ok(Json::Array(hits.iter().map(|h| json!({
                    "id": h.id, "locator": locator(&h.locator), "preview": h.preview, "evidence": evidence_json(&h.evidence),
                })).collect()))
            }
            "apply" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                // §11: `ops` (the kernel changeset) or `effects` (the planner),
                // exactly one.
                let (has_ops, has_effects) =
                    (args.get("ops").is_some(), args.get("effects").is_some());
                if has_ops == has_effects {
                    return Err(argument_error(
                        name,
                        "pass exactly one of `ops` or `effects`",
                        &spec.input_schema,
                    ));
                }
                if has_effects {
                    let effects = parse_effects(&args["effects"])?;
                    let dry = arg_bool(args, "dry_run")?.unwrap_or(false);
                    let reason = arg_str(args, "reason").map(str::to_owned);
                    let origin = ApplyOrigin::new(&self.actor, reason.as_deref());
                    let ctx = self.plan_ctx(&repo);
                    let out = self.with_writes(root.as_deref(), |store, ds| {
                        Ok(store.apply_effects(&ctx, &effects, &origin, ds, dry)?)
                    })?;
                    return Ok(match out {
                        EffectsOutcome::Plan(plan) => plan_json(&plan),
                        EffectsOutcome::Receipt(receipt) => {
                            self.notify();
                            receipt_json(&receipt)
                        }
                    });
                }
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
                    origin: ApplyOrigin::new(&self.actor, reason.as_deref()),
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
            "plan" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let effects = parse_effects(&args["effects"])?;
                let ctx = self.plan_ctx(&repo);
                let plan = self.with_writes(root.as_deref(), |store, ds| {
                    Ok(store.plan_effects(&ctx, &effects, ds)?)
                })?;
                Ok(plan_json(&plan))
            }
            "execute" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let reason = arg_str(args, "reason").map(str::to_owned);
                let origin = ApplyOrigin::new(&self.actor, reason.as_deref());
                let ctx = self.plan_ctx(&repo);
                // §4 (3.1): exactly one form — the plan, or `plan_id` + `effects`.
                let plan_form = args.get("plan").is_some();
                let digest_form = args.get("plan_id").is_some() || args.get("effects").is_some();
                if plan_form == digest_form {
                    return Err(argument_error(
                        name,
                        "pass exactly one of `plan` or `plan_id` + `effects`",
                        &spec.input_schema,
                    ));
                }
                let receipt = if plan_form {
                    let plan = match Plan::admit(&args["plan"]) {
                        Ok(plan) => plan,
                        Err(Admission::Refused(m)) => return Err(SurfaceError::from(m)),
                        Err(Admission::Invalid(m)) => {
                            return Err(SurfaceError::filter_invalid(m, "arguments"));
                        }
                    };
                    self.with_writes(root.as_deref(), |store, ds| {
                        Ok(store.execute_plan(&ctx, &plan, &origin, ds)?)
                    })?
                } else {
                    let (Some(plan_id), Some(effects)) =
                        (arg_str(args, "plan_id"), args.get("effects"))
                    else {
                        return Err(argument_error(
                            name,
                            "the digest form needs both `plan_id` and `effects`",
                            &spec.input_schema,
                        ));
                    };
                    let effects = parse_effects(effects)?;
                    let plan_id = plan_id.to_owned();
                    self.with_writes(root.as_deref(), |store, ds| {
                        Ok(store.execute_by_digest(&ctx, &plan_id, &effects, &origin, ds)?)
                    })?
                };
                self.notify();
                Ok(receipt_json(&receipt))
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
                    expect: arg_parent_expect(args)?,
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
                let block = self.resolve_block_ref(&repo, &arg_string(args, "id")?)?;
                let expect = match arg_expect(args)? {
                    Some(e) => Some(e),
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
                    expect: arg_parent_expect(args)?,
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
                let block = self.resolve_block_ref(&repo, &arg_string(args, "id")?)?;
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
            "blocks_check" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let blocks: Vec<String> = arg_strings(args, "ids")?
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
                    "blocks_check",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
                )?))
            }
            "nodes_set" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let node_id = arg_string(args, "id")?;
                let known: Option<i64> = self
                    .store
                    .conn()
                    .query_row(
                        "SELECT 1 FROM nodes WHERE node_id = ?1 AND repo_id = ?2",
                        params![node_id, repo],
                        |r| r.get(0),
                    )
                    .optional()?;
                if known.is_none() {
                    return Err(SurfaceError::with_data(
                        "block_missing",
                        format!("no node with id {}", Json::String(node_id.clone())),
                        json!({ "id": node_id }),
                    ));
                }
                let ops = self.store.node_set(
                    &node_id,
                    &arg_string(args, "prop")?,
                    &arg_string(args, "value")?,
                )?;
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "nodes_set",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
                )?))
            }
            "blocks_append" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let given = arg_string(args, "id")?;
                let block = self.resolve_block_ref(&repo, &given)?;
                let text = arg_string(args, "text")?;
                // By what the block is (the reference's `blocks_append`): a heading
                // → the end of its section; a container → the end of its children;
                // a leaf → `block_not_container` (append means into).
                let row: Option<(String, Option<String>, i64)> = self
                    .store
                    .conn()
                    .query_row(
                        "SELECT b.type, d.format, (SELECT count(*) FROM blocks c WHERE c.parent_block = b.block_id AND c.deleted_commit IS NULL) FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ?1 AND b.deleted_commit IS NULL",
                        params![block],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()?;
                let Some((kind, format, children)) = row else {
                    return Err(block_missing(&given));
                };
                let container = if format.as_deref().unwrap_or("markdown") == "markdown" {
                    kind.parse::<BlockKind>().is_ok_and(|k| k.is_container())
                } else {
                    children > 0
                };
                let ops = if kind == "heading" {
                    Store::sections_append(&block, &text)
                } else if container {
                    vec![Op::Insert {
                        doc: None,
                        to: To {
                            parent: Parent::Block(block.clone()),
                            at: At::End,
                        },
                        markdown: text,
                        expect: None,
                    }]
                } else {
                    return Err(SurfaceError::with_data(
                        "block_not_container",
                        format!(
                            "block {block} is a {kind}, not a heading or a container; append means into — insert after it with blocks_insert {{ to: <its parent>, at: {{ after: {} }} }}",
                            Json::String(block.clone())
                        ),
                        json!({ "id": block, "type": kind }),
                    ));
                };
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "blocks_append",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
                )?))
            }
            "docs_append" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let doc_id = self.locate_doc(&repo, name, args)?;
                let text = arg_string(args, "text")?;
                let ops = match arg_str(args, "section") {
                    Some(section) => {
                        let info = read::find_doc_by_id(self.store.conn(), &doc_id)?
                            .ok_or_else(|| block_missing(&doc_id))?;
                        let heading = self.resolve_section_heading(&doc_id, &info.path, section)?;
                        Store::sections_append(&heading, &text)
                    }
                    None => Store::docs_append(&doc_id, &text),
                };
                Ok(apply_json(&self.apply_ops(
                    &repo,
                    root.as_deref(),
                    ops,
                    "docs_append",
                    arg_bool(args, "dry_run")?.unwrap_or(false),
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
                    Json::Array(plan.hits.iter().map(|h| json!({ "id": h.block, "path": reference_path(&h.path), "oldRaw": h.old_raw, "newRaw": h.new_raw })).collect()),
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
                let dry = arg_bool(args, "dry_run")?.unwrap_or(false);
                let res = self.with_writes(root.as_deref(), |store, ds| {
                    Ok(if dry {
                        store
                            .dry_run()
                            .docs_create(&ctx, ds, &path, &markdown, fm.as_ref())?
                    } else {
                        store.docs_create(&ctx, ds, &path, &markdown, fm.as_ref())?
                    })
                })?;
                if !dry {
                    self.notify();
                }
                Ok(doc_op_json(&res))
            }
            "docs_move" => {
                let (repo, root) = self.scope(args)?;
                let doc = self.locate_doc(&repo, name, args)?;
                let ctx = self.doc_ctx(&repo);
                let to = arg_string(args, "to_path")?;
                // spec/mutate §6 (1.3): the default is `true`; `false` opts out.
                let retarget = arg_bool(args, "retarget_inbound")?.unwrap_or(true);
                let dry = arg_bool(args, "dry_run")?.unwrap_or(false);
                let res = self.with_writes(root.as_deref(), |store, ds| {
                    Ok(if dry {
                        store.dry_run().docs_move(&ctx, ds, &doc, &to, retarget)?
                    } else {
                        store.docs_move(&ctx, ds, &doc, &to, retarget)?
                    })
                })?;
                if !dry {
                    self.notify();
                }
                // `{ id, path, committed, diffs?, dangling, retargeted }` — the
                // reference spreads the planned/moved record before the link report.
                let mut m = Map::new();
                m.insert("id".to_owned(), json!(res.doc_id));
                m.insert("path".to_owned(), json!(reference_path(&res.path)));
                m.insert("committed".to_owned(), json!(res.committed));
                if let Some(diffs) = &res.diffs {
                    m.insert("diffs".to_owned(), reference_keyed(&diffs_json(diffs)));
                }
                // Each dangling link is an edge row under the `edges` target's
                // names (§1.2, 3.0) with its source `path` rooted; its `target`
                // stays as authored — that is what the link says.
                m.insert(
                    "dangling".to_owned(),
                    Json::Array(res.dangling.iter().map(dangling_json).collect()),
                );
                m.insert(
                    "retargeted".to_owned(),
                    json!(
                        res.retargeted
                            .as_ref()
                            .map(|r| json!({ "blocks": r.blocks, "docs": r.docs }))
                    ),
                );
                Ok(Json::Object(m))
            }
            "docs_delete" => {
                let (repo, root) = self.scope(args)?;
                let doc = self.locate_doc(&repo, name, args)?;
                let ctx = self.doc_ctx(&repo);
                let dry = arg_bool(args, "dry_run")?.unwrap_or(false);
                let res = self.with_writes(root.as_deref(), |store, ds| {
                    Ok(if dry {
                        store.dry_run().docs_delete(&ctx, ds, &doc)?
                    } else {
                        store.docs_delete(&ctx, ds, &doc)?
                    })
                })?;
                if !dry {
                    self.notify();
                }
                Ok(doc_op_json(&res))
            }
            "docs_set_meta" => {
                let (repo, root) = self.scope(args)?;
                let doc = self.locate_doc(&repo, name, args)?;
                let ctx = self.doc_ctx(&repo);
                let set = arg_object(args, "set")?.cloned();
                let unset = if args.get("unset").is_some() {
                    arg_strings(args, "unset")?
                } else {
                    Vec::new()
                };
                let dry = arg_bool(args, "dry_run")?.unwrap_or(false);
                let res = self.with_writes(root.as_deref(), |store, ds| {
                    Ok(if dry {
                        store
                            .dry_run()
                            .docs_set_meta(&ctx, ds, &doc, set.as_ref(), &unset)?
                    } else {
                        store.docs_set_meta(&ctx, ds, &doc, set.as_ref(), &unset)?
                    })
                })?;
                if !dry {
                    self.notify();
                }
                Ok(doc_op_json(&res))
            }
            "docs_update" => {
                let (repo, root) = self.scope(args)?;
                let doc = self.locate_doc(&repo, name, args)?;
                let content = arg_string(args, "content")?;
                let dry = arg_bool(args, "dry_run")?.unwrap_or(false);
                let reason = arg_str(args, "reason").map(str::to_owned);
                let origin = ApplyOrigin::new(&self.actor, reason.as_deref());
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
                let path = storage_path(&arg_string(args, "path")?).to_owned();
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
                            storage_path(&arg_string(f, "path")?),
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
                let path = storage_path(&arg_string(args, "path")?).to_owned();
                let ts = self.now();
                let out = self.store.observe_delete(&repo, &path, &ts)?;
                self.notify();
                Ok(
                    json!({ "id": out.doc_id, "path": reference_path(&out.path), "deleted": out.deleted() }),
                )
            }
            "blocks_history" => history::blocks_history(
                &self.store,
                &arg_string(args, "id")?,
                arg_i64(args, "limit")?,
            ),
            "docs_diff" => {
                let (repo, _) = self.scope(args)?;
                let doc_id = self.locate_doc(&repo, name, args)?;
                history::diff_blocks(
                    &self.store,
                    &doc_id,
                    &arg_string(args, "from_rev")?,
                    &arg_string(args, "to_rev")?,
                )
            }
            "docs_diff_unified" => {
                let (repo, _) = self.scope(args)?;
                let doc_ref = arg_str(args, "id")
                    .or(arg_str(args, "path"))
                    .unwrap_or_default()
                    .to_owned();
                let doc_id = self.locate_doc(&repo, name, args)?;
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
                    json!({ "id": doc_id, "path": path.as_deref().map_or_else(String::new, reference_path), "from": from, "to": to, "diff": diff }),
                )
            }
            "docs_read_at" => {
                let (repo, _) = self.scope(args)?;
                let doc_id = self.locate_doc(&repo, name, args)?;
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
                let id = arg_str(args, "id");
                let path = arg_str(args, "path");
                if glob.is_none() && id.is_none() && path.is_none() {
                    return Err(SurfaceError::new(
                        "target_missing",
                        "docs_history requires one of path_glob, id or path",
                    ));
                }
                let include_deleted = arg_bool(args, "include_deleted")?.unwrap_or(false);
                // A live document resolves through the locator; with
                // include_deleted a tombstoned one is looked up by the same attribute.
                let doc: Option<String> = if id.is_some() || path.is_some() {
                    let tomb: Option<String> = if include_deleted {
                        match (id, path) {
                            (Some(i), _) => self
                                .store
                                .conn()
                                .query_row(
                                    "SELECT doc_id FROM docs WHERE doc_id = ?1 AND repo_id = ?2",
                                    params![i, repo],
                                    |r| r.get(0),
                                )
                                .optional()?,
                            (None, Some(p)) => self
                                .store
                                .conn()
                                .query_row(
                                    "SELECT doc_id FROM docs WHERE repo_id = ?1 AND path = ?2",
                                    params![repo, storage_path(p)],
                                    |r| r.get(0),
                                )
                                .optional()?,
                            (None, None) => None,
                        }
                    } else {
                        None
                    };
                    Some(match tomb {
                        Some(d) => d,
                        None => self.locate_doc(&repo, name, args)?,
                    })
                } else {
                    None
                };
                history::docs_history(
                    &self.store,
                    &repo,
                    glob,
                    doc.as_deref(),
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
                Ok(root_changes_page(page.to_json()))
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
            "version" => version_info(Some(&self.store), &self.build_info),
            other => Err(SurfaceError::other(format!("unknown tool {other}"))),
        }
    }
}

/// `block_missing` for a block the caller named (`id` or a ref): the
/// attribute spelling, the argument as given in `data`.
fn block_missing(value: &str) -> SurfaceError {
    SurfaceError::with_data(
        "block_missing",
        format!("no block with id {}", Json::String(value.to_owned())),
        json!({ "id": value }),
    )
}

/// `nodes_block_read` on a node that names no live block.
fn node_has_no_block(node_id: &str, doc_id: &str) -> SurfaceError {
    SurfaceError::with_data(
        "block_missing",
        format!("node {} has no block", Json::String(node_id.to_owned())),
        json!({ "id": node_id, "doc_id": doc_id }),
    )
}

/// The message every tool uses for a `semantic(...)` call with no provider.
pub const PROVIDER_UNAVAILABLE_MESSAGE: &str = "semantic(...) needs an embedding provider; none is configured — set embedding.provider (omg config set embedding.provider <command|url>) and embed the repository (omg embed drain)";

/// `provider_unavailable` with no provider configured (§4, 3.0).
#[must_use]
pub fn provider_unavailable() -> SurfaceError {
    SurfaceError::with_data(
        "provider_unavailable",
        PROVIDER_UNAVAILABLE_MESSAGE,
        json!({ "provider": null }),
    )
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
    // §1 Paths: `revisions[].path` and the dry-run `diffs` keys in the
    // reference form; a revision is `{ id, path, hash }` (§4, 3.0).
    m.insert(
        "revisions".to_owned(),
        Json::Array(
            res.revisions
                .iter()
                .map(|r| json!({ "id": r.doc, "path": reference_path(&r.path), "hash": r.hash }))
                .collect(),
        ),
    );
    if let Some(diffs) = &res.diffs {
        let mut d = Map::new();
        for (path, diff) in diffs {
            d.insert(
                reference_path(path),
                json!({ "before": diff.before, "after": diff.after }),
            );
        }
        m.insert("diffs".to_owned(), Json::Object(d));
    }
    m.insert("committed".to_owned(), json!(res.committed));
    Json::Object(m)
}

/// The `effects` argument (`spec/mutate` §11.1): a malformed effect is
/// `filter_invalid { reason, hint: "arguments" }` naming `effects[i]`.
fn parse_effects(v: &Json) -> Result<Vec<PublicEffect>> {
    PublicEffect::list_from_json(v).map_err(|m| SurfaceError::filter_invalid(m, "arguments"))
}

/// A plan on the wire (`spec/mutate` §11): the digest-covered core as the
/// planner wrote it — a client echoes it back to `execute`, so no key moves
/// — and, under §1 "Paths", the preview's `revisions[].path` and `diffs`
/// keys in the reference form.
#[must_use]
pub fn plan_json(plan: &Plan) -> Json {
    let mut v = plan.to_json(true);
    if let Some(preview) = v.get_mut("preview").and_then(Json::as_object_mut) {
        if let Some(revs) = preview.get_mut("revisions").and_then(Json::as_array_mut) {
            for r in revs {
                root_field(r, "path");
            }
        }
        if let Some(diffs) = preview.get_mut("diffs") {
            *diffs = reference_keyed(diffs);
        }
    }
    v
}

/// A receipt on the wire: `revisions[].path` in the reference form.
#[must_use]
pub fn receipt_json(receipt: &Receipt) -> Json {
    let mut v = receipt.to_json();
    if let Some(revs) = v.get_mut("revisions").and_then(Json::as_array_mut) {
        for r in revs {
            root_field(r, "path");
        }
    }
    v
}

/// A dangling inbound link as an edge row (`spec/surface` §4 `docs_move`, 3.0):
/// `{ doc_id, path, block_id, target, anchor, field? }` — the source `path`
/// rooted, the `target` as authored.
fn dangling_json(l: &omgbase_store::InboundLink) -> Json {
    let mut m = Map::new();
    m.insert("doc_id".to_owned(), json!(l.doc));
    m.insert("path".to_owned(), json!(reference_path(&l.path)));
    m.insert("block_id".to_owned(), json!(l.block));
    m.insert("target".to_owned(), json!(l.target));
    m.insert("anchor".to_owned(), json!(l.anchor));
    if let Some(f) = &l.field {
        m.insert("field".to_owned(), json!(f));
    }
    Json::Object(m)
}

/// A document operation's result on the wire: `{ id, path, committed,
/// diffs? }` — the store's `{ doc, path }` re-shaped under the row rule
/// (§1.2, 3.0); `diffs` only on a dry run (1.3).
fn doc_op_json(res: &omgbase_store::DocOpResult) -> Json {
    let mut m = Map::new();
    m.insert("id".to_owned(), json!(res.doc_id));
    m.insert("path".to_owned(), json!(reference_path(&res.path)));
    m.insert("committed".to_owned(), json!(res.committed));
    if let Some(diffs) = &res.diffs {
        m.insert("diffs".to_owned(), reference_keyed(&diffs_json(diffs)));
    }
    Json::Object(m)
}

/// `changes_since` on the wire (§1 Paths, 2.0): the store renders its digests
/// in the storage form; every revision `path` is rooted here, and so is the
/// summary's subject — the reference composes `renderSummary` from rooted
/// paths, so the same line reads `observed: /a.md — 3 inserted`,
/// `api(human:spec): deleted /a.md`, `api(human:spec): moved /a.md → /b.md`,
/// `api(human:spec): moved /a.md → /b.md; /index.md — 31 edited` (a move
/// with its retarget, mutate 2.1). The subject is the text between the first
/// `: ` and the ` — ` detail (or the end): a comma-joined path list,
/// `deleted <paths>`, `moved <from> → <to>` or `moved <from> → <to>; <paths>`.
fn root_changes_page(mut page: Json) -> Json {
    let Some(digests) = page.get_mut("digests").and_then(Json::as_array_mut) else {
        return page;
    };
    for d in digests.iter_mut() {
        if let Some(revs) = d.get_mut("revisions").and_then(Json::as_array_mut) {
            for r in revs.iter_mut() {
                root_field(r, "path");
            }
        }
        if let Some(summary) = d.get("summary").and_then(Json::as_str) {
            let rooted = root_summary(summary);
            d["summary"] = Json::String(rooted);
        }
    }
    page
}

/// The summary's subject paths in the reference form (see [`root_changes_page`]).
fn root_summary(summary: &str) -> String {
    let Some(colon) = summary.find(": ") else {
        return summary.to_owned();
    };
    let (head, rest) = summary.split_at(colon + 2);
    let (subject, detail) = match rest.find(" — ") {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    let root_list = |s: &str| -> String {
        if s.is_empty() {
            return String::new();
        }
        s.split(", ")
            .map(reference_path)
            .collect::<Vec<_>>()
            .join(", ")
    };
    let subject = if let Some(paths) = subject.strip_prefix("deleted ") {
        format!("deleted {}", root_list(paths))
    } else if let Some(mv) = subject.strip_prefix("moved ") {
        // `moved <from> → <to>`, with the retarget's sources after a `; `.
        let (mv, rest) = match mv.split_once("; ") {
            Some((mv, rest)) => (mv, Some(rest)),
            None => (mv, None),
        };
        let moved = match mv.split_once(" → ") {
            Some((from, to)) => format!("moved {} → {}", reference_path(from), reference_path(to)),
            None => format!("moved {mv}"),
        };
        match rest {
            Some(rest) => format!("{moved}; {}", root_list(rest)),
            None => moved,
        }
    } else {
        root_list(subject)
    };
    format!("{head}{subject}{detail}")
}

/// `spec/mutate` §7's opset on the wire (camelCase precondition keys and
/// `matcherV`, as the reference).
#[must_use]
pub fn opset_json(opset: &Opset) -> Json {
    let mut m = Map::new();
    m.insert("version".to_owned(), json!(1));
    m.insert("kind".to_owned(), json!("doc_update"));
    // §1 Paths: the target's and the precondition's `path` in the reference
    // form; the document under the row rule (§1.2, 3.0): `{ id, path }` and
    // `{ id, path, baseRevision, hash }`.
    m.insert(
        "target".to_owned(),
        json!({ "id": opset.target_doc, "path": reference_path(&opset.target_path) }),
    );
    m.insert(
        "precondition".to_owned(),
        json!({
            "id": opset.precondition.doc,
            "path": reference_path(&opset.precondition.path),
            "baseRevision": opset.precondition.base_revision,
            "hash": opset.precondition.hash,
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
                    // The kernel's JSON spells the carried ids `child_ids`
                    // (the `spec/mutate` fixture form); the wire is camelCase
                    // like every other key here (`spec/surface` §9;
                    // `Op::from_json` accepts both on the way back in).
                    let mut op = p.op.to_json();
                    if let Some(m) = op.as_object_mut()
                        && let Some(c) = m.remove("child_ids")
                    {
                        m.insert("childIds".to_owned(), c);
                    }
                    o.insert("op".to_owned(), op);
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

/// The public `observe` result: `{ id, path, rev, commitId, converged,
/// echo, conflicted, dispositions: [{ kind, count }] }` — the store's own
/// `{ doc, commit, rev }` outcome (`spec/store` §9) re-shaped under the row
/// rule (§1.2, 3.0).
fn observe_json(o: &omgbase_store::ObserveOutcome) -> Json {
    json!({
        "id": o.doc_id,
        "path": reference_path(&o.path),
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

/// The one-line-per-op plan text of `docs_update` (its dry run is the plan).
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
            "docs_read_many",
            "blocks_read",
            "nodes_block_read",
            "blocks_read_many",
            "docs_tree",
            "docs_list",
            "query_syntax",
            "query",
            "graph",
            "blocks_search",
            "blocks_resolve",
            "apply",
            "plan",
            "execute",
            "blocks_insert",
            "blocks_update",
            "blocks_move",
            "blocks_remove",
            "blocks_split",
            "blocks_merge",
            "blocks_check",
            "nodes_set",
            "blocks_append",
            "docs_append",
            "links_retarget",
            "links_stale",
            "links_repair",
            "docs_create",
            "docs_move",
            "docs_delete",
            "docs_set_meta",
            "docs_update",
            "observe",
            "observe_many",
            "observe_delete",
            "blocks_history",
            "docs_diff",
            "docs_diff_unified",
            "docs_read_at",
            "docs_history",
            "changes_since",
            "repos_status",
            "sync_status",
            "repos",
            "version",
        ] {
            assert!(names.contains(&want), "missing {want}");
        }
        assert_eq!(names.len(), 47);
        for t in tools() {
            assert_eq!(t.input_schema["type"], "object");
        }
    }

    /// `spec/mutate` §11 at the surface: `plan` returns the frozen plan with
    /// a rooted preview, `execute` commits it (receipt with rooted paths),
    /// `apply` takes `ops` or `effects` (exactly one) and `effects` +
    /// `dry_run` is the plan; `execute` needs a plan or a digest + effects.
    #[test]
    fn plan_execute_and_apply_effects_round_trip() {
        let mut s = surface();
        let out = s.call(
            "observe",
            json!({ "path": "a.md", "content": "---\nstatus: open\n---\n\n# A\n\nAlpha.\n" }),
        );
        assert!(!out.is_error, "{}", out.body);
        let effects = json!([
            { "op": "set", "target": { "kind": "document", "path": "/a.md" }, "field": "frontmatter.status", "value": "done" },
            { "op": "insert", "into": { "kind": "section", "heading_id": "b_0" }, "markdown": "Tail." },
        ]);
        let plan = s.call("plan", json!({ "effects": effects }));
        assert!(!plan.is_error, "{}", plan.body);
        let plan = plan.body;
        assert_eq!(plan["version"], 1);
        assert_eq!(plan["plan_id"].as_str().map(str::len), Some(64));
        assert_eq!(
            plan["effects"][0]["target"],
            json!({ "kind": "document", "id": "d_0", "path": "a.md" }),
            "the core keeps storage paths"
        );
        assert_eq!(
            plan["preview"]["revisions"][0]["path"], "/a.md",
            "the preview is rooted"
        );
        assert!(
            plan["preview"]["diffs"].get("/a.md").is_some(),
            "{}",
            plan["preview"]["diffs"]
        );
        assert_eq!(
            plan["new_ids"],
            json!([{ "symbol": "$new.0", "kind": "block" }])
        );
        // A dry-run apply with effects is the same plan.
        let dry = s.call("apply", json!({ "effects": effects, "dry_run": true }));
        assert!(!dry.is_error, "{}", dry.body);
        assert_eq!(dry.body["plan_id"], plan["plan_id"]);
        // Exactly one of ops / effects.
        let both = s.call("apply", json!({ "ops": [], "effects": effects }));
        assert!(both.is_error);
        assert_eq!(both.body["error"], "filter_invalid");
        assert_eq!(both.body["data"]["hint"], "arguments");
        let neither = s.call("apply", json!({}));
        assert!(neither.is_error);
        assert_eq!(neither.body["data"]["hint"], "arguments");
        let bad = s.call("apply", json!({ "effects": [{ "op": "nope" }] }));
        assert!(bad.is_error);
        assert_eq!(bad.body["error"], "filter_invalid");
        assert_eq!(bad.body["data"]["hint"], "arguments");
        assert!(
            bad.body["message"]
                .as_str()
                .unwrap()
                .starts_with("effects[0]:"),
            "{}",
            bad.body
        );
        // `execute` needs a plan or a digest + effects.
        let empty = s.call("execute", json!({}));
        assert!(empty.is_error);
        assert_eq!(empty.body["data"]["hint"], "arguments");
        // The plan, echoed back without its preview, commits.
        let mut echoed = plan.clone();
        echoed.as_object_mut().unwrap().remove("preview");
        let receipt = s.call("execute", json!({ "plan": echoed, "reason": "slice 1" }));
        assert!(!receipt.is_error, "{}", receipt.body);
        assert_eq!(receipt.body["plan_id"], plan["plan_id"]);
        assert_eq!(receipt.body["committed"], true);
        assert_eq!(receipt.body["commit"], "c_1");
        assert_eq!(receipt.body["revisions"][0]["path"], "/a.md");
        assert_eq!(receipt.body["new_ids"], json!({ "$new.0": "b_2" }));
        let read = s.call("docs_read", json!({ "path": "a.md" }));
        assert_eq!(
            read.body["raw"],
            "---\nstatus: done\n---\n\n# A\n\nAlpha.\n\nTail.\n"
        );
        // A replay is stale; the digest form with the same effects re-plans.
        let again = s.call("execute", json!({ "plan": echoed }));
        assert!(again.is_error);
        assert_eq!(again.body["error"], "stale_plan");
        assert_eq!(again.body["retriable"], true);
        let digest = s.call(
            "execute",
            json!({ "plan_id": plan["plan_id"], "effects": effects }),
        );
        assert!(digest.is_error);
        assert_eq!(digest.body["error"], "plan_mismatch", "{}", digest.body);
        let half = s.call("execute", json!({ "plan_id": plan["plan_id"] }));
        assert!(half.is_error);
        assert!(
            half.body["message"]
                .as_str()
                .unwrap()
                .starts_with("the digest form needs both"),
            "{}",
            half.body
        );
        let v2 = s.call(
            "execute",
            json!({ "plan": { "version": 2, "plan_id": "x" } }),
        );
        assert_eq!(v2.body["error"], "unsupported_plan_version", "{}", v2.body);
        let ops_count: i64 = s
            .store()
            .conn()
            .query_row(
                "SELECT count(*) FROM commits WHERE ops IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ops_count, 1, "the effect commit recorded its intent");
        assert!(Surface::is_write_tool("plan") && Surface::is_write_tool("execute"));
    }

    #[test]
    fn observe_read_and_query_round_trip() {
        let mut s = surface();
        let out = s.call("observe", json!({ "path": "a.md", "content": "---\nlayer: canon\n---\n# Title\n\nHello world.\n\n- [ ] task one\n" }));
        assert!(!out.is_error, "{}", out.body);
        assert_eq!(out.body["id"], "d_0");
        assert_eq!(out.body["echo"], false);
        let read = s.call("docs_read", json!({ "path": "a.md", "include_ids": true }));
        assert!(!read.is_error, "{}", read.body);
        assert_eq!(read.body["path"], "/a.md");
        // either form names the document (§1 Paths)
        assert_eq!(
            s.call("docs_read", json!({ "path": "/a.md" })).body["path"],
            "/a.md"
        );
        // §4 "Arguments": the retired `doc` is refused with its replacement.
        let retired = s.call("docs_read", json!({ "doc": "a.md" }));
        assert_eq!(retired.body["error"], "filter_invalid");
        assert_eq!(
            retired.body["message"],
            "`doc` is no longer an argument — pass `id` or `path` (docs_read takes id?, include_ids?, path?, repo?)"
        );
        let neither = s.call("docs_read", json!({}));
        assert_eq!(
            neither.body["message"],
            "pass id or path (docs_read takes id?, include_ids?, path?, repo?)"
        );
        assert_eq!(
            s.call("docs_read", json!({ "path": "//a.md" })).body["id"],
            "d_0"
        );
        assert_eq!(read.body["properties"]["frontmatter"]["layer"], "canon");
        assert!(read.body["ids"].as_array().unwrap().len() >= 3);
        let q = s.call("query", json!({ "query": "select title, layer, t: nodes collect { value where kind == \"md:task\" } from docs where layer == \"canon\" && nodes count { where kind == \"md:task\" } == 1" }));
        assert!(!q.is_error, "{}", q.body);
        assert_eq!(q.body["hits"][0]["title"], "Title");
        assert_eq!(q.body["hits"][0]["layer"], "canon");
        assert_eq!(q.body["hits"][0]["t"][0]["value"], "task one");
        assert_eq!(q.body["hits"][0]["id"], "d_0");
        assert_eq!(q.body["hits"][0]["path"], "/a.md");
        assert_eq!(q.body["consumer"], "collect");
        let c = s.call(
            "query",
            json!({ "query": "blocks count { where text(\"hello\") }" }),
        );
        assert_eq!(c.body["count"], 1);
        // 3.0: a bare `path` is the attribute (no loud-error set); a
        // projection landing on the envelope must be aliased.
        let ok = s.call(
            "query",
            json!({ "query": "from docs where path == \"a.md\"" }),
        );
        assert!(!ok.is_error, "{}", ok.body);
        assert_eq!(ok.body["hits"][0]["id"], "d_0");
        let bad = s.call("query", json!({ "query": "select data.path from docs" }));
        assert!(bad.is_error);
        assert_eq!(bad.body["error"], "filter_invalid");
        assert_eq!(
            bad.body["message"],
            "projection `path` collides with the hit envelope — alias it (`p: data.path`)"
        );
        let sem = s.call(
            "query",
            json!({ "query": "from docs where semantic(\"x\") > 0.5" }),
        );
        assert_eq!(sem.body["error"], "provider_unavailable");
        assert_eq!(sem.body["data"], json!({ "provider": null }));
        let outline = s.call("docs_outline", json!({ "path": "a.md" }));
        let text = outline.body["text"].as_str().unwrap();
        assert!(text.starts_with("b_0 h1   Title  §"), "{text}");
        assert!(text.contains("☐ task one"));
        let missing = s.call("docs_read", json!({ "path": "nope.md" }));
        assert_eq!(missing.body["error"], "doc_missing");
        assert_eq!(
            missing.body["message"],
            "no document with id or path \"nope.md\""
        );
        assert_eq!(missing.body["data"], json!({ "path": "nope.md" }));
        let repos = s.call("repos", json!({}));
        assert_eq!(repos.body["repos"][0]["slug"], "fixture");
        let unknown = s.call("docs_list", json!({ "repo": "zzz" }));
        assert_eq!(unknown.body["error"], "repo_not_found");
    }

    #[test]
    fn insert_and_move_carry_the_destination_parent_cas_and_many_reads_keep_one_item() {
        let mut s = surface();
        s.call(
            "observe",
            json!({ "path": "a.md", "content": "# T\n\nOne.\n\nTwo.\n" }),
        );
        s.call("observe", json!({ "path": "b.md", "content": "# U\n" }));
        // §4 (1.2): a stale `expect.parent_children_hash` on blocks_insert is
        // the kernel's destination-parent CAS: `stale_expectation` carrying the
        // current hash, from which the caller retries without a read.
        let stale = s.call(
            "blocks_insert",
            json!({ "to": "a.md", "markdown": "Three.", "expect": { "parent_children_hash": "00" } }),
        );
        assert!(stale.is_error, "{}", stale.body);
        assert_eq!(stale.body["error"], "stale_expectation");
        assert_eq!(stale.body["retriable"], true);
        let current = stale.body["data"]["current"]["parent_children_hash"]
            .as_str()
            .expect("current hash")
            .to_owned();
        assert_eq!(current.len(), 64, "{current}");
        let ok = s.call(
            "blocks_insert",
            json!({ "to": "a.md", "markdown": "Three.", "expect": { "parent_children_hash": current, "content_hash": "dropped, not checked" } }),
        );
        assert!(!ok.is_error, "{}", ok.body);
        assert_eq!(ok.body["committed"], true);
        let read = s.call("docs_read", json!({ "path": "a.md" }));
        assert_eq!(read.body["raw"], "# T\n\nOne.\n\nTwo.\n\nThree.\n");
        // blocks_move: the destination is checked once for the whole run.
        let stale = s.call(
            "blocks_move",
            json!({ "blocks": ["b_1", "b_2"], "to": "a.md", "at": "end", "expect": { "parent_children_hash": "00" } }),
        );
        assert_eq!(stale.body["error"], "stale_expectation", "{}", stale.body);
        let current = stale.body["data"]["current"]["parent_children_hash"]
            .as_str()
            .expect("current hash")
            .to_owned();
        let ok = s.call(
            "blocks_move",
            json!({ "blocks": ["b_1", "b_2"], "to": "a.md", "at": "end", "expect": { "parent_children_hash": current } }),
        );
        assert!(!ok.is_error, "{}", ok.body);
        let read = s.call("docs_read", json!({ "path": "a.md" }));
        assert_eq!(read.body["raw"], "# T\n\nThree.\n\nOne.\n\nTwo.\n\n");
        // A `dry_run` still runs the CAS.
        let dry = s.call(
            "blocks_move",
            json!({ "blocks": ["b_1"], "to": "a.md", "at": "start", "dry_run": true, "expect": { "parent_children_hash": "00" } }),
        );
        assert_eq!(dry.body["error"], "stale_expectation", "{}", dry.body);
        // §2 (1.2): the budget is applied from the second item on — one item
        // always comes back, `truncated` says more remained.
        let many = s.call(
            "docs_read_many",
            json!({ "docs": ["a.md", "b.md"], "budget_tokens": 1 }),
        );
        assert_eq!(
            many.body["items"].as_array().unwrap().len(),
            1,
            "{}",
            many.body
        );
        assert_eq!(many.body["items"][0]["path"], "/a.md");
        assert_eq!(many.body["truncated"], true);
        let one = s.call(
            "docs_read_many",
            json!({ "docs": ["b.md"], "budget_tokens": 1 }),
        );
        assert_eq!(one.body["items"].as_array().unwrap().len(), 1);
        assert_eq!(one.body["truncated"], false);
        let nodes = s.call(
            "blocks_read_many",
            json!({ "ids": ["b_zzz", "b_1", "b_2"], "resolution": "full", "budget_tokens": 1 }),
        );
        assert_eq!(
            nodes.body["nodes"].as_array().unwrap().len(),
            1,
            "{}",
            nodes.body
        );
        assert_eq!(nodes.body["nodes"][0]["id"], "b_1");
        assert_eq!(nodes.body["truncated"], true);
        assert_eq!(nodes.body["unresolved"], json!(["b_zzz"]));
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
        let read = s.call("docs_read", json!({ "id": "d_0" }));
        assert_eq!(read.body["raw"], "# T\n\nOne.\n\nTwo.\n");
        let upd = s.call(
            "blocks_update",
            json!({ "id": "b_1", "markdown": "One, edited." }),
        );
        assert!(!upd.is_error, "{}", upd.body);
        assert_eq!(upd.body["id"], "b_1");
        let app = s.call(
            "docs_append",
            json!({ "path": "a.md", "section": "T", "text": "Three." }),
        );
        assert!(!app.is_error, "{}", app.body);
        let amb = s.call(
            "docs_append",
            json!({ "path": "a.md", "section": "Nope", "text": "x" }),
        );
        assert_eq!(amb.body["error"], "parent_missing");
        assert_eq!(amb.body["message"], "no heading \"Nope\" in /a.md");
        // blocks_append: a heading's section, a leaf is block_not_container.
        let into = s.call("blocks_append", json!({ "id": "b_0", "text": "Four." }));
        assert!(!into.is_error, "{}", into.body);
        let leaf = s.call("blocks_append", json!({ "id": "b_1", "text": "x" }));
        assert_eq!(leaf.body["error"], "block_not_container", "{}", leaf.body);
        assert_eq!(
            leaf.body["data"],
            json!({ "id": "b_1", "type": "paragraph" })
        );
        let hist = s.call("blocks_history", json!({ "id": "b_1" }));
        let entries = hist.body.as_array().unwrap();
        assert!(entries.len() >= 2, "{}", hist.body);
        assert_eq!(entries[0]["origin"], "api", "newest first");
        let du = s.call("docs_diff_unified", json!({ "path": "a.md" }));
        assert!(!du.is_error, "{}", du.body);
        assert!(du.body["diff"].as_str().unwrap().contains("+Four."));
    }

    #[test]
    fn doc_tools_dry_run_preview_diffs_and_commit_nothing() {
        use std::cell::Cell;
        use std::rc::Rc;
        let fired = Rc::new(Cell::new(0));
        let f2 = Rc::clone(&fired);
        let mut s = surface().with_mutation_hook(move || f2.set(f2.get() + 1));
        let b_src = "# B\n\nTarget.\n";
        let a_src = "# A\n\nSee [b](b.md).\n";
        let b = s.call("docs_create", json!({ "path": "b.md", "markdown": b_src }));
        assert_eq!(b.body["id"], "d_0", "{}", b.body);
        let a = s.call("docs_create", json!({ "path": "a.md", "markdown": a_src }));
        assert_eq!(a.body["id"], "d_1", "{}", a.body);
        assert_eq!(fired.get(), 2);
        let count = |s: &Surface, table: &str| -> i64 {
            s.store
                .conn()
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap()
        };
        let snapshot = |s: &Surface| {
            (
                count(s, "docs"),
                count(s, "commits"),
                count(s, "revisions"),
                count(s, "blocks"),
            )
        };
        let before = snapshot(&s);
        let keys = |v: &Json| -> Vec<String> { v.as_object().unwrap().keys().cloned().collect() };

        // docs_create: `""` → the composed file; the `d_` id minted as the real run would.
        let c = s.call(
            "docs_create",
            json!({ "path": "c.md", "markdown": "# C", "frontmatter": { "title": "C" }, "dry_run": true }),
        );
        assert!(!c.is_error, "{}", c.body);
        assert_eq!(
            serde_json::to_string(&c.body).unwrap(),
            r#"{"id":"d_2","path":"/c.md","committed":false,"diffs":{"/c.md":{"before":"","after":"---\ntitle: C\n---\n\n# C\n"}}}"#,
            "the reference's key order, byte for byte"
        );

        // docs_move with retarget_inbound: old path emptied, new path filled,
        // the rewritten source appended; `dangling`/`retargeted` previewed.
        let m = s.call(
            "docs_move",
            json!({ "path": "b.md", "to_path": "notes/b.md", "retarget_inbound": true, "dry_run": true }),
        );
        assert!(!m.is_error, "{}", m.body);
        // Byte for byte what the reference prints for
        // `docsMove(store, { ...ctx, dryRun: true }, "b.md", "notes/b.md", { retargetInbound: true })`
        // over the same two documents under the sequential minter.
        assert_eq!(
            serde_json::to_string(&m.body).unwrap(),
            r##"{"id":"d_0","path":"/notes/b.md","committed":false,"diffs":{"/b.md":{"before":"# B\n\nTarget.\n","after":""},"/notes/b.md":{"before":"","after":"# B\n\nTarget.\n"},"/a.md":{"before":"# A\n\nSee [b](b.md).\n","after":"# A\n\nSee [b](notes/b.md).\n"}},"dangling":[],"retargeted":{"blocks":["b_3"],"docs":["d_1"]}}"##
        );
        assert_eq!(
            keys(&m.body),
            ["id", "path", "committed", "diffs", "dangling", "retargeted"]
        );
        assert_eq!(keys(&m.body["diffs"]), ["/b.md", "/notes/b.md", "/a.md"]);
        assert_eq!(
            m.body["diffs"]["/a.md"],
            json!({ "before": a_src, "after": "# A\n\nSee [b](notes/b.md).\n" })
        );
        // … and with `retarget_inbound: false` (mutate 1.3 retargets by default):
        // two entries, the inbound link dangles.
        let plain = s.call(
            "docs_move",
            json!({ "path": "b.md", "to_path": "notes/b.md", "dry_run": true, "retarget_inbound": false }),
        );
        assert_eq!(
            serde_json::to_string(&plain.body).unwrap(),
            r##"{"id":"d_0","path":"/notes/b.md","committed":false,"diffs":{"/b.md":{"before":"# B\n\nTarget.\n","after":""},"/notes/b.md":{"before":"","after":"# B\n\nTarget.\n"}},"dangling":[{"doc_id":"d_1","path":"/a.md","block_id":"b_3","target":"b.md","anchor":null}],"retargeted":null}"##
        );

        // docs_delete: the file → `""`.
        let d = s.call("docs_delete", json!({ "path": "a.md", "dry_run": true }));
        assert!(!d.is_error, "{}", d.body);
        assert_eq!(
            d.body,
            json!({ "id": "d_1", "path": "/a.md", "committed": false, "diffs": { "/a.md": { "before": a_src, "after": "" } } })
        );
        assert_eq!(keys(&d.body), ["id", "path", "committed", "diffs"]);

        // docs_set_meta: before → after.
        let sm = s.call(
            "docs_set_meta",
            json!({ "path": "a.md", "set": { "status": "open" }, "dry_run": true }),
        );
        assert!(!sm.is_error, "{}", sm.body);
        assert_eq!(
            sm.body,
            json!({ "id": "d_1", "path": "/a.md", "committed": false, "diffs": { "/a.md": { "before": a_src, "after": "---\nstatus: open\n---\n\n# A\n\nSee [b](b.md).\n" } } })
        );

        // Nothing committed, no hook, no row changed; the checks still run.
        assert_eq!(fired.get(), 2, "dry runs never fire the mutation hook");
        assert_eq!(snapshot(&s), before);
        assert_eq!(
            s.call("docs_read", json!({ "id": "d_0" })).body["path"],
            "/b.md"
        );
        assert_eq!(
            s.call("docs_read", json!({ "id": "d_1" })).body["raw"],
            a_src
        );
        let taken = s.call(
            "docs_create",
            json!({ "path": "a.md", "markdown": "x", "dry_run": true }),
        );
        assert_eq!(taken.body["error"], "path_taken");
        let missing = s.call("docs_delete", json!({ "path": "nope.md", "dry_run": true }));
        assert_eq!(missing.body["error"], "doc_missing");
        // The dry-run create spent `d_2`: the next real create is `d_3` and carries no `diffs`.
        let real = s.call(
            "docs_create",
            json!({ "path": "c.md", "markdown": "# C\n" }),
        );
        assert_eq!(
            real.body,
            json!({ "id": "d_3", "path": "/c.md", "committed": true })
        );
        assert_eq!(fired.get(), 3);
    }

    #[test]
    fn change_summaries_are_rooted_like_the_reference_renders_them() {
        assert_eq!(
            root_summary("observed: a.md, b/c.md — 3 inserted, 1 edited"),
            "observed: /a.md, /b/c.md — 3 inserted, 1 edited"
        );
        assert_eq!(
            root_summary("observed: deleted a.md"),
            "observed: deleted /a.md"
        );
        assert_eq!(
            root_summary("api(human:spec): moved a.md → b/a.md"),
            "api(human:spec): moved /a.md → /b/a.md"
        );
        assert_eq!(
            root_summary("api(human:spec): moved a.md → b/a.md; index.md, c.md — 31 edited"),
            "api(human:spec): moved /a.md → /b/a.md; /index.md, /c.md — 31 edited"
        );
        assert_eq!(root_summary("api(?): x.md"), "api(?): /x.md");
        assert_eq!(root_summary("observed: "), "observed: ");
        assert_eq!(root_summary("nonsense"), "nonsense");
        let page = root_changes_page(json!({
            "digests": [{ "summary": "observed: a.md", "revisions": [{ "id": "d_0", "path": "a.md", "hash": "ff" }] }],
            "cursor": 1, "truncated": false, "head": 1
        }));
        assert_eq!(page["digests"][0]["revisions"][0]["path"], "/a.md");
        assert_eq!(page["digests"][0]["summary"], "observed: /a.md");
    }
}
