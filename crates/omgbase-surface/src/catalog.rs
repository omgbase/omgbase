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

use std::collections::{HashMap, VecDeque};
use std::path::Path;

use omgbase_format::BlockKind;
use omgbase_format::text::{normalize_text, normalize_visible_text};
use omgbase_reconcile::Config;
use omgbase_search::EmbeddingProvider;
use omgbase_store::docs_ops::{canonical, retargeted_json};
use omgbase_store::links::inbound_links_to;
use omgbase_store::mutate_kernel::effects::{Admission, EffectExpect, Target as EffectTarget};
use omgbase_store::mutate_kernel::{At, ErrorCode, Parent};
use omgbase_store::{
    ApplyOrigin, CapabilityState, DocStore, Expect, FsDocStore, MutationError, Plan, PlanContext,
    PublicEffect, QueryVector, Receipt, Retargeted, Store, sugar,
};
use omgbase_sync::{RealFileSystem, RepoRow};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value as Json, json};

use crate::arguments::{argument_error, validate_arguments};
use crate::dates;
use crate::error::{Result, SurfaceError};
use crate::fixes;
use crate::graph::{GraphArgs, graph_neighborhood};
use crate::history;
use crate::links;
use crate::names::VocabularyCache;
use crate::paths::{reference_keyed, reference_path, root_field, storage_path};
use crate::query::{QueryOptions, embed_phrases, query};
use crate::read::{self, Resolution, ResolvedRef};
use crate::reference;
use crate::select::{self, SelectRequest};
use crate::version::{BuildInfo, version_info_for};

/// The actor every write from this surface records.
pub const ACTOR: &str = "agent:mcp";

/// How many plans a surface remembers for `execute { plan_id }` alone (§4
/// `execute`, 5.1): the most recent `plan` results of this process, by
/// `plan_id`, the least recently produced evicted first. The same bound as
/// the reference's `PLAN_MEMORY` (`packages/core/src/mcp/server.ts`).
pub const PLAN_MEMORY: usize = 64;

/// The message of `plan_unknown` (5.1), spelled alike by both engines.
#[must_use]
pub fn plan_unknown_message(plan_id: &str) -> String {
    format!(
        "this server has no plan {plan_id} — re-run plan, or pass the plan (or `plan_id` + `effects`) with execute"
    )
}

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
    /// [`Surface::preview_call`] is running: a sugar tool plans its effects
    /// and answers with the Plan instead of committing (the CLI's local
    /// `--dry-run`, `spec/cli` §3.6). Never set by a tool call.
    preview: bool,
    /// The Plan the last sugar tool or `apply` planned (its preview realizes
    /// the committed ids through the receipt's `new_ids`), for
    /// [`Surface::call_result_with_plan`].
    last_plan: Option<Plan>,
    /// The plans this surface produced (§4 `execute`, 5.1): `plan`'s results
    /// in production order, the last [`PLAN_MEMORY`] of them, so `execute {
    /// plan_id }` alone runs the FULL plan form — `stale_plan` and
    /// `plan_mismatch` told apart exactly as if the client had echoed the
    /// Plan. A re-planned id moves to the back; an id this surface never
    /// produced is `plan_unknown`.
    plans: VecDeque<Plan>,
    /// Which tools this surface lists and accepts ([`Surface::tools`]);
    /// `Full` unless the host chose otherwise (`omgbase mcp --tools`).
    profile: Profile,
    /// The unknown-names vocabulary of this store (`spec/surface` §1.5
    /// "Caching"): per repository, keyed on the head commit; it lives here
    /// because it describes exactly the store this surface owns.
    vocabulary: VocabularyCache,
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

// ---- the sugar tools over effects (ADR-021; `spec/surface` §4, 4.0) ---------------------
//
// Every write tool but `apply`/`plan`/`execute` and the observe tools is
// sugar over `apply { effects }`: each handler keeps its own pre-checks (so
// every pinned error `data` is unchanged), builds its effects with the shared
// builders (`omgbase_store::sugar`, the reference's `mutate/sugar.ts`) and
// hands them to [`Surface::apply_sugar`], which plans and commits them in one
// transaction under the tool's name as the commit `reason` and answers with
// the Receipt. There is no `dry_run` (4.0): the preview is `plan`.

/// An empty block list is an argument error (3.2, §9): `filter_invalid`
/// "`blocks` must name at least one block (… takes …)" — it used to reach
/// the kernel as a malformed op (`block_missing "block undefined not
/// found"`), or commit nothing and report success (`blocks_check`). The
/// reference's `requireSome`, raised after the root check and before any
/// ref resolves.
fn require_some(tool: &str, arg: &str, list: Vec<String>, spec: &ToolSpec) -> Result<Vec<String>> {
    if list.is_empty() {
        return Err(argument_error(
            tool,
            &format!("`{arg}` must name at least one block"),
            &spec.input_schema,
        ));
    }
    Ok(list)
}

/// A block tool's kernel `expect` as an effect's (`revision` is never set
/// by the sugar tools).
fn effect_expect(e: Option<Expect>) -> Option<EffectExpect> {
    e.map(|e| EffectExpect {
        content_hash: e.content_hash,
        parent_children_hash: e.parent_children_hash,
        revision: None,
    })
}

/// A resolved placement parent as the effect target it names.
fn placement_target(parent: Parent, doc_id: String) -> EffectTarget {
    match parent {
        Parent::Doc => EffectTarget::Document {
            id: Some(doc_id),
            path: None,
        },
        Parent::Block(id) => EffectTarget::Block { id },
        Parent::Section { heading } => EffectTarget::Section {
            heading_id: heading,
        },
    }
}

/// What [`Surface::apply_sugar_with`] hands a sugar tool: the plan and, unless
/// the surface is previewing, the receipt.
type SugarOutcome = (Plan, Option<Receipt>);

/// The planner stamps `effect_index` on every error it raises; a sugar
/// tool's caller never passed effects, so the key goes (the kernel's own
/// `op_index`, `block`, `current`… stay as pinned).
fn strip_effect_index(e: omgbase_store::Error) -> omgbase_store::Error {
    match e {
        omgbase_store::Error::Mutation(mut m) => {
            m.data.remove("effect_index");
            omgbase_store::Error::Mutation(m)
        }
        other => other,
    }
}

/// A sugar tool's answer: the Receipt (§4, 4.0), or — previewing — the Plan.
fn sugar_json((plan, receipt): &SugarOutcome) -> Json {
    match receipt {
        Some(r) => receipt_json(r),
        None => plan_json(plan),
    }
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

/// A catalog profile (§4 "Profiles", surface 4.3): which tools a server
/// lists and accepts. A profile filters listing and calling, never
/// semantics — every tool it keeps behaves exactly as under `Full`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Profile {
    /// Every tool of the table (the default).
    #[default]
    Full,
    /// The ten tools an agent works a knowledge base with: the reads not
    /// covered by `query`, the one writer and its preview, `version`.
    Minimal,
}

/// The `minimal` profile's tools (§4 "Profiles"); [`Profile::tools`] lists
/// them in the catalog's registration order.
pub const MINIMAL_TOOLS: &[&str] = &[
    "query",
    "query_syntax",
    "docs_read",
    "docs_tree",
    "blocks_resolve",
    "changes_since",
    "plan",
    "execute",
    "apply",
    "version",
];

impl Profile {
    /// The profile's name as the flag and the `version` tool spell it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Minimal => "minimal",
        }
    }

    /// Whether `tool` is listed (and callable) under this profile.
    #[must_use]
    pub fn includes(self, tool: &str) -> bool {
        match self {
            Self::Full => true,
            Self::Minimal => MINIMAL_TOOLS.contains(&tool),
        }
    }

    /// The catalog filtered to this profile, in catalog order.
    #[must_use]
    pub fn tools(self) -> Vec<ToolSpec> {
        catalog()
            .iter()
            .filter(|t| self.includes(t.name))
            .cloned()
            .collect()
    }
}

impl std::str::FromStr for Profile {
    type Err = String;

    /// `full` | `minimal`; anything else is the error naming both.
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        match s {
            "full" => Ok(Self::Full),
            "minimal" => Ok(Self::Minimal),
            other => Err(format!(
                "unknown tools profile {} (expected full|minimal)",
                Json::String(other.to_owned())
            )),
        }
    }
}

impl std::fmt::Display for Profile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
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
        let mut props = vec![("_id", s()), ("_path", s())];
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
            input_schema: doc(&[("include_ids", b()), ("at", s())], &[]),
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
                &[("_id", s()), ("resolution", resolution_schema())],
                &["_id"],
                true,
            ),
        },
        ToolSpec {
            name: "nodes_block_read",
            description: d::NODES_BLOCK_READ,
            input_schema: schema(
                &[("_id", s()), ("resolution", resolution_schema())],
                &["_id"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_read_many",
            description: d::BLOCKS_READ_MANY,
            input_schema: schema(
                &[
                    ("_ids", strings()),
                    ("resolution", resolution_schema()),
                    ("budget_tokens", i()),
                ],
                &["_ids"],
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
                    ("files", b()),
                    ("updated", b()),
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
            input_schema: schema(&[("section", s())], &[], false),
        },
        ToolSpec {
            name: "query",
            description: d::QUERY,
            input_schema: schema(
                &[
                    ("query", s()),
                    ("limit", i()),
                    ("cursor", nullable_string()),
                    ("bare", b()),
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
                    ("effects", effects_schema()),
                    ("select", s()),
                    ("expect", obj()),
                    ("reason", s()),
                ],
                &["effects"],
                true,
            ),
        },
        ToolSpec {
            name: "plan",
            description: d::PLAN,
            input_schema: schema(
                &[
                    ("effects", effects_schema()),
                    ("select", s()),
                    ("expect", obj()),
                    ("diffs", b()),
                ],
                &["effects"],
                true,
            ),
        },
        ToolSpec {
            name: "execute",
            description: d::EXECUTE,
            input_schema: schema(
                &[
                    ("plan", obj()),
                    ("plan_id", s()),
                    ("effects", effects_schema()),
                    ("select", s()),
                    ("expect", obj()),
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
                    ("_id", s()),
                    ("markdown", s()),
                    ("checked", b()),
                    ("expect", expect_schema()),
                ],
                &["_id"],
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
                ],
                &["blocks", "to"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_remove",
            description: d::BLOCKS_REMOVE,
            input_schema: schema(&[("blocks", strings())], &["blocks"], true),
        },
        ToolSpec {
            name: "blocks_split",
            description: d::BLOCKS_SPLIT,
            input_schema: schema(
                &[
                    ("_id", s()),
                    (
                        "at",
                        json!({ "type": "array", "items": { "type": "integer" } }),
                    ),
                ],
                &["_id", "at"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_merge",
            description: d::BLOCKS_MERGE,
            input_schema: schema(
                &[("blocks", strings()), ("separator", s())],
                &["blocks"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_check",
            description: d::BLOCKS_CHECK,
            input_schema: schema(&[("_ids", strings()), ("checked", b())], &["_ids"], true),
        },
        ToolSpec {
            name: "nodes_set",
            description: d::NODES_SET,
            input_schema: schema(
                &[("_id", s()), ("prop", s()), ("value", s())],
                &["_id", "prop", "value"],
                true,
            ),
        },
        ToolSpec {
            name: "blocks_append",
            description: d::BLOCKS_APPEND,
            input_schema: schema(&[("_id", s()), ("text", s())], &["_id", "text"], true),
        },
        ToolSpec {
            name: "docs_append",
            description: d::DOCS_APPEND,
            input_schema: doc(&[("text", s()), ("section", s())], &["text"]),
        },
        ToolSpec {
            name: "links_retarget",
            description: d::LINKS_RETARGET,
            input_schema: schema(
                &[("from_target", s()), ("to_target", s()), ("path_glob", s())],
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
                ],
                &[],
                true,
            ),
        },
        ToolSpec {
            name: "docs_create",
            description: d::DOCS_CREATE,
            input_schema: schema(
                &[("path", s()), ("markdown", s()), ("frontmatter", obj())],
                &["path", "markdown"],
                true,
            ),
        },
        ToolSpec {
            name: "docs_move",
            description: d::DOCS_MOVE,
            input_schema: doc(&[("to_path", s()), ("retarget_inbound", b())], &["to_path"]),
        },
        ToolSpec {
            name: "docs_delete",
            description: d::DOCS_DELETE,
            input_schema: doc(&[], &[]),
        },
        ToolSpec {
            name: "docs_set_meta",
            description: d::DOCS_SET_META,
            input_schema: doc(&[("set", obj()), ("unset", strings())], &[]),
        },
        ToolSpec {
            name: "docs_update",
            description: d::DOCS_UPDATE,
            input_schema: doc(&[("content", s()), ("reason", s())], &["content"]),
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
            input_schema: schema(&[("_id", s()), ("limit", i())], &["_id"], false),
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
                    ("_id", s()),
                    ("_path", s()),
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
                    ("epoch", s()),
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
            preview: false,
            last_plan: None,
            plans: VecDeque::new(),
            profile: Profile::Full,
            vocabulary: VocabularyCache::default(),
        }
    }

    /// Remember a `plan` result for `execute { plan_id }` alone (5.1): the
    /// newest at the back, a re-planned id moved there, the oldest dropped
    /// past [`PLAN_MEMORY`].
    fn remember_plan(&mut self, plan: &Plan) {
        self.plans.retain(|p| p.plan_id != plan.plan_id);
        self.plans.push_back(plan.clone());
        while self.plans.len() > PLAN_MEMORY {
            self.plans.pop_front();
        }
    }

    /// The remembered plan under `plan_id`, or `plan_unknown` (retriable).
    fn remembered_plan(&self, plan_id: &str) -> Result<Plan> {
        self.plans
            .iter()
            .find(|p| p.plan_id == plan_id)
            .cloned()
            .ok_or_else(|| {
                let mut e = SurfaceError::with_data(
                    "plan_unknown",
                    plan_unknown_message(plan_id),
                    json!({ "plan_id": plan_id }),
                );
                e.retriable = true;
                e
            })
    }

    /// Serve `profile` (§4 "Profiles"): [`Surface::tools`] lists only its
    /// tools, so a host's `tools/list` and its membership check follow;
    /// nothing else changes — the dispatch, the schemas and
    /// [`Surface::is_write_tool`] stay the full table's.
    #[must_use]
    pub fn with_profile(mut self, profile: Profile) -> Self {
        self.profile = profile;
        self
    }

    /// The profile this surface serves.
    #[must_use]
    pub fn profile(&self) -> Profile {
        self.profile
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

    /// The catalog this surface serves: the table filtered by its
    /// [`Profile`] (the whole table under `Full`).
    #[must_use]
    pub fn tools(&self) -> Vec<ToolSpec> {
        self.profile.tools()
    }

    /// Whether `name` is a tool that can commit (a host serializes these
    /// under the writer lock of `spec/sync` §7; `plan` counts — it reads the
    /// working tree the writes race for).
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
    // `_id` is the document's id, `_path` its path (either form, §1 "Paths");
    // at least one is required, and when both are given they must name the
    // same document. Every `docs_*` tool — `docs_diff` and `docs_diff_unified`
    // included — locates under the same rules (5.0: the arguments are the
    // row's engine attributes, spelled exactly; a bare `id`/`path` never
    // reaches here — `validate_arguments` refuses it with the `_` spelling and
    // a `fix`). A miss is `doc_missing` "no document with _id or _path
    // "<value>"" with the arguments as given in `data`; neither given is
    // `filter_invalid` "pass _id or _path"; a disagreement is `filter_invalid`
    // "_id "…" and _path "…" name different documents". The reference's
    // `locateDoc`, byte for byte.
    /// A document locator (`_id` or `_path`, either form) resolved to the live
    /// document's id under the `docs_update` tool's rules — the error a
    /// `docs_update` with that locator would raise (`doc_missing` with the
    /// given keys as `data`). The CLI's local `update <doc>` resolves its
    /// target here before planning, as the reference's `requireDoc` does.
    pub fn locate_document(&self, repo_id: &str, args: &Json) -> Result<String> {
        self.locate_doc(repo_id, "docs_update", args)
    }

    /// `docs_read { at }` and its sugar `docs_read_at` (`spec/surface` §2,
    /// 4.7): the document AS OF a revision, `spec/store` §6.2 reconstruct; a
    /// revision that is not the document's — unknown, or another document's —
    /// is `target_missing { doc, rev }`. The reference's `docsReadAt`.
    fn docs_read_at(&self, doc_id: &str, rev: &str) -> Result<Json> {
        read::docs_read_at(&self.store, doc_id, rev)?.ok_or_else(|| {
            SurfaceError::with_data(
                "target_missing",
                format!(
                    "no revision {} for document {doc_id}",
                    Json::String(rev.to_owned())
                ),
                json!({ "doc": doc_id, "rev": rev }),
            )
        })
    }

    fn locate_doc(&self, repo_id: &str, tool: &str, args: &Json) -> Result<String> {
        let (id_key, path_key) = ("_id", "_path");
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
        // Through the store's semantic capability (`SemanticProvider::available`,
        // `docs/modular-core/README.md` §6), never the tables.
        let rankable = match self.store.semantic() {
            Some(semantic) => semantic.available(self.store.conn(), repo_id, model)?,
            None => false,
        };
        if rankable {
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

    /// Phase 2 (`spec/surface` 6.0 §2.1 draft, D3): a tool that needs the
    /// semantic capability on a store that has none — `disabled` when the
    /// store runs without the module (`OMGBASE_CAPABILITIES=core`),
    /// `unavailable` (retriable) when the host's configured provider failed
    /// to start. A store with the module and no provider configured stays
    /// `provider_unavailable` (3.0, pinned) — the two codes sit side by side
    /// as the contracts put it: `capability_unavailable` is "the module is
    /// not here", `provider_unavailable` "the module is here and has nothing
    /// to score with".
    fn require_semantic_capability(&self) -> Result<()> {
        match self.store.semantic_state() {
            CapabilityState::Enabled => Ok(()),
            state => Err(semantic_capability_unavailable(
                state,
                self.provider_name.as_deref(),
                self.store.semantic_fault(),
            )),
        }
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
    /// the candidates `[{ _id, _doc_id }]` (pass the heading's id to
    /// `blocks_append` instead). Never an id lookup — the id form is
    /// `blocks_append`'s (§9).
    ///
    /// Each miss carries a `fix` (§9, 4.4): several matches → `blocks_append`
    /// with the first candidate's id; none → the one heading whose text
    /// matches up to ASCII case, as `blocks_append`, else the same
    /// `docs_append` without `section` (the document's end). `call` is the
    /// tool's own locator and text.
    fn resolve_section_heading(
        &self,
        doc_id: &str,
        doc_path: &str,
        section: &str,
        call: (Option<&str>, Option<&str>, &str),
    ) -> Result<String> {
        let conn = self.store.conn();
        let needle = if section.trim_start_matches([' ', '\t']).starts_with('#') {
            normalize_visible_text(section, BlockKind::Heading, 0)
        } else {
            normalize_text(section)
        };
        let mut stmt = conn.prepare(
            "SELECT block_id, doc_id, text FROM blocks WHERE doc_id = ?1 AND type = 'heading' AND deleted_at IS NULL",
        )?;
        let rows: Vec<(String, String, String)> = stmt
            .query_map(params![doc_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?;
        let matches: Vec<&(String, String, String)> = rows
            .iter()
            .filter(|(_, _, text)| normalize_text(text) == needle)
            .collect();
        let shown = reference_path(doc_path);
        let (id, path, text) = call;
        match matches.len() {
            0 => {
                let near: Vec<&(String, String, String)> = rows
                    .iter()
                    .filter(|(_, _, t)| normalize_text(t).eq_ignore_ascii_case(&needle))
                    .collect();
                let fix = match near.as_slice() {
                    [one] => fixes::append_into_heading(&one.0, text),
                    _ => fixes::append_without_section(id, path, text),
                };
                Err(SurfaceError::with_data(
                    "parent_missing",
                    format!("no heading {} in {shown}", Json::String(section.to_owned())),
                    json!({ "section": section, "_path": shown, "fix": fix }),
                ))
            }
            1 => Ok(matches[0].0.clone()),
            n => Err(SurfaceError::with_data(
                "ambiguous_heading",
                format!(
                    "heading {} matches {n} headings in {shown}; pass the heading's id to blocks_append",
                    Json::String(section.to_owned())
                ),
                json!({
                    "section": section,
                    "_path": shown,
                    "candidates": matches.iter().map(|(b, d, _)| json!({ "_id": b, "_doc_id": d })).collect::<Vec<_>>(),
                    "fix": fixes::append_into_heading(&matches[0].0, text),
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
                json!({ "_id": node_id }),
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
                "SELECT doc_id FROM blocks WHERE block_id = ?1 AND deleted_at IS NULL",
                params![block_id],
                |r| r.get(0),
            )
            .optional()?)
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

    /// A sugar tool's effects through the planner (ADR-021): `plan` +
    /// `execute` in one call under one write scope and one transaction,
    /// `reason` the tool's name — the Receipt (§4, 4.0); previewing
    /// ([`Surface::preview_call`]) the Plan alone, nothing committed. The
    /// mutation hook fires on a commit.
    fn apply_sugar(
        &mut self,
        repo_id: &str,
        root: Option<&str>,
        effects: Vec<PublicEffect>,
        reason: &str,
    ) -> Result<Json> {
        let out = self.apply_sugar_with(repo_id, root, reason, |_, _| Ok(effects))?;
        Ok(sugar_json(&out))
    }

    /// [`Surface::apply_sugar`]'s seam for the tools whose result carries
    /// more than the Receipt (`docs_move`, `links_*`): `build` runs under the
    /// write scope with the store and the doc store — the tool's own
    /// pre-checks, then its effects — and the plan and the receipt (`None`
    /// when previewing) come back for the tool to shape. The plan is kept for
    /// [`Surface::call_result_with_plan`].
    fn apply_sugar_with(
        &mut self,
        repo_id: &str,
        root: Option<&str>,
        reason: &str,
        build: impl FnOnce(&mut Store, &mut dyn DocStore) -> Result<Vec<PublicEffect>>,
    ) -> Result<SugarOutcome> {
        let origin = ApplyOrigin::new(&self.actor, Some(reason));
        let ctx = self.plan_ctx(repo_id);
        let preview = self.preview;
        let out = self.with_writes(root, |store, ds| {
            let effects = build(store, ds)?;
            if preview {
                let plan = store
                    .plan_effects(&ctx, &effects, ds)
                    .map_err(strip_effect_index)?;
                return Ok((plan, None));
            }
            let (plan, receipt) = store
                .apply_effects_detailed(&ctx, &effects, &origin, ds)
                .map_err(strip_effect_index)?;
            Ok((plan, Some(receipt)))
        })?;
        self.last_plan = Some(out.0.clone());
        if out.1.is_some() {
            self.notify();
        }
        Ok(out)
    }

    /// A located document's row (`locate_doc` has already resolved it, so a
    /// miss here is a race) as `{ doc_id, path, head }`.
    fn doc_info(&self, repo_id: &str, doc_ref: &str) -> Result<omgbase_store::DocInfo> {
        self.store
            .find_doc_by_ref(repo_id, doc_ref)?
            .ok_or_else(|| {
                SurfaceError::from(MutationError::new(
                    ErrorCode::DocMissing,
                    format!("no document {doc_ref}"),
                ))
            })
    }

    /// Run a write tool and hand back its result **with the Plan it
    /// committed** (`spec/cli` §4, the Receipt confirmation): a sugar tool's
    /// or `apply`'s plan, whose `preview.results[].ids` realized through the
    /// receipt's `new_ids` are the ids the CLI prints; `None` for a tool that
    /// planned nothing (a read, `execute`, an error). Not a tool: the CLI's
    /// local seam, as the reference's library-bound verbs hold the plan from
    /// `applyEffectsDetailed`.
    pub fn call_result_with_plan(
        &mut self,
        name: &str,
        args: &Json,
    ) -> Result<(Json, Option<Json>)> {
        self.last_plan = None;
        let result = self.call_result(name, args);
        let plan = self.last_plan.take().map(|p| plan_json(&p));
        Ok((result?, plan))
    }

    /// The Plan a sugar tool would commit (`spec/cli` §3.6: every dry run is
    /// a `plan`) — the tool's own ref resolution and pre-checks run, its
    /// effects are planned under the symbolic minter, nothing is written and
    /// no id is minted; the mutation hook stays quiet. `apply` previews its
    /// effects the same way. Not a tool: the catalog has no `dry_run` (4.0),
    /// a client previews with `plan { effects }`.
    pub fn preview_call(&mut self, name: &str, args: &Json) -> Result<Json> {
        self.preview = true;
        let out = self.call_result(name, args);
        self.preview = false;
        out
    }

    /// The `apply` tool's effects: `(plan, receipt)` on the wire — plan +
    /// execute in one write scope and one transaction; previewing, the plan
    /// and nothing else. With a `select` (§11.8, 4.1) the effects are the
    /// templates, the selector is run and expanded under the same write
    /// scope, and `expect.max` is required: a one-shot write must bound what
    /// it touches (a `plan` first needs no bound).
    fn apply_effects_detailed(
        &mut self,
        repo: &str,
        root: Option<&str>,
        args: &Json,
    ) -> Result<(Json, Option<Json>)> {
        let reason = arg_str(args, "reason").map(str::to_owned);
        let origin = ApplyOrigin::new(&self.actor, reason.as_deref());
        let ctx = self.plan_ctx(repo);
        let preview = self.preview;
        let (plan, receipt) = match SelectRequest::from_args(args)? {
            Some(req) => {
                let semantic = self.selector_semantic(repo, req.select_str())?;
                self.with_writes(root, |store, ds| {
                    if preview {
                        return Ok((
                            select::plan_selected(store, ds, &ctx, &req, semantic)?,
                            None,
                        ));
                    }
                    // One-shot `apply` with a selector must bound it (§11.8):
                    // the caller never saw the hits. The fix (3.3) is the same
                    // call bounded at the selection's actual size — the
                    // selector compiled (reads only) to count it; a selection
                    // the compile itself refuses reports its own error and fix.
                    if req.has_selector() && req.expect.is_none() {
                        let x = select::expand(store, &ctx, ds, &req, semantic)?;
                        let cardinality = x.selection.map_or(0, |s| s.cardinality);
                        return Err(select::unbounded_apply(&req, cardinality));
                    }
                    let (plan, receipt) = store.apply_planned(&ctx, &origin, ds, |store, ds| {
                        select::plan_selected(store, ds, &ctx, &req, semantic)
                    })?;
                    Ok((plan, Some(receipt)))
                })?
            }
            None => {
                self.with_writes(root, |store, ds| {
                    // The shape check with the §8 fixes (3.4): the anchor fix
                    // reads the block's live row, so it runs over the store.
                    let effects = select::validate_plain(store, &args["effects"])?;
                    if preview {
                        return Ok((store.plan_effects(&ctx, &effects, ds)?, None));
                    }
                    let (plan, receipt) =
                        store.apply_effects_detailed(&ctx, &effects, &origin, ds)?;
                    Ok((plan, Some(receipt)))
                })?
            }
        };
        self.last_plan = Some(plan.clone());
        if receipt.is_some() {
            self.notify();
        }
        Ok((plan_json(&plan), receipt.as_ref().map(receipt_json)))
    }

    /// A selector's `semantic(...)` phrases embedded ahead of the write scope
    /// (the provider is the surface's, the expansion runs with the store
    /// borrowed): no provider is `provider_unavailable`, an unrankable repo
    /// is refused as the `query` tool refuses it.
    fn selector_semantic(
        &self,
        repo_id: &str,
        select: &str,
    ) -> Result<HashMap<String, crate::context::SemanticVec>> {
        let phrases = crate::query::collect_semantic_phrases(select);
        if !phrases.is_empty() {
            self.require_semantic_capability()?;
        }
        if self.provider.is_none() && !phrases.is_empty() {
            return Err(provider_unavailable());
        }
        self.require_rankable(repo_id, !phrases.is_empty())?;
        embed_phrases(self.provider.as_deref(), phrases)
    }

    fn plan_ctx(&mut self, repo_id: &str) -> PlanContext {
        PlanContext {
            repo_id: repo_id.to_owned(),
            ts: self.now(),
            config: self.config.clone(),
        }
    }

    // ---- dispatch -------------------------------------------------------------------------

    /// Run a tool, returning its result or the error — every error of the
    /// effect tools carrying its corrected call (`data.fix`, `spec/surface`
    /// §4 "Teaching", 4.4; [`crate::fixes`]).
    pub fn call_result(&mut self, name: &str, args: &Json) -> Result<Json> {
        self.call_result_inner(name, args)
            .map_err(|e| fixes::attach(name, args, e, |i| self.allocated_before(args, i)))
    }

    /// The symbols the first `i` effects of a plain request allocate (a
    /// `$new.n` fix renames the symbol to the next one): a symbolic plan over
    /// that prefix, nothing written; `None` when it cannot be planned.
    fn allocated_before(&mut self, args: &Json, i: usize) -> Option<usize> {
        if i == 0 {
            return Some(0);
        }
        let prefix = args.get("effects")?.as_array()?.get(..i)?.to_vec();
        let effects = parse_effects(&Json::Array(prefix)).ok()?;
        let (repo, root) = self.scope(args).ok()?;
        let ctx = self.plan_ctx(&repo);
        self.with_writes(root.as_deref(), |store, ds| {
            Ok(store.plan_effects(&ctx, &effects, ds)?)
        })
        .ok()
        .map(|p| p.new_ids.len())
    }

    #[allow(clippy::too_many_lines)]
    fn call_result_inner(&mut self, name: &str, args: &Json) -> Result<Json> {
        // §4 "Arguments": the shape first, so a wrong name is one
        // `filter_invalid` naming the nearest valid one.
        let spec =
            tool_spec(name).ok_or_else(|| SurfaceError::other(format!("unknown tool {name}")))?;
        // (4.5) a bare string in a string-list slot reaches the handler as `[s]`.
        let normalized = validate_arguments(name, &spec.input_schema, args)?;
        let args = normalized.as_ref().unwrap_or(args);
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
                if let Some(rev) = arg_str(args, "at") {
                    // `at` (4.7): the document AS OF that revision —
                    // `docs_read_at`'s code path, so the two return the same
                    // bytes. Block ids at a past revision are a later
                    // question: `include_ids` is refused with `at`, after the
                    // locator (each argument is valid on its own).
                    if arg_bool(args, "include_ids")?.unwrap_or(false) {
                        return Err(argument_error(
                            name,
                            "`include_ids` is not available with `at`",
                            &tool_spec(name).expect("a catalog tool").input_schema,
                        ));
                    }
                    return self.docs_read_at(&doc_id, rev);
                }
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
                                arg_str(args, "_id")
                                    .or(arg_str(args, "_path"))
                                    .unwrap_or_default()
                                    .to_owned()
                            )
                        ),
                        json!({ "_id": doc_id }),
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
                let id = arg_string(args, "_id")?;
                // `_id` is a block id, unambiguously the `blocks_` kind's (§4
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
                        json!({ "_id": id }),
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
                let id = arg_string(args, "_id")?;
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
                let ids = arg_strings(args, "_ids")?;
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
                    args.get("files").and_then(Json::as_bool) == Some(true),
                    args.get("updated").and_then(Json::as_bool) == Some(true),
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
            "query_syntax" => {
                // (5.1) The card by default; a chapter by its slug; `all` the
                // manual. An unknown name is an argument error naming the
                // chapters, its `fix` the call respelled with the nearest name
                // (or `all`).
                let Some(section) = arg_str(args, "section") else {
                    return Ok(json!({
                        "syntax": reference::QUERY_SYNTAX_CARD,
                        "sections": reference::QUERY_SYNTAX_SECTIONS.iter().map(|(slug, _)| *slug).collect::<Vec<_>>(),
                    }));
                };
                let Some(syntax) = reference::query_syntax_section(section) else {
                    let names = reference::QUERY_SYNTAX_SECTION_NAMES;
                    let fix = omgbase_mutate::canonical_json(&json!({
                        "section": crate::arguments::nearest(section, names).unwrap_or("all"),
                    }));
                    return Err(crate::arguments::argument_error_fix(
                        name,
                        &format!(
                            "unknown section `{section}`; the sections are {}",
                            names.join(", ")
                        ),
                        &spec.input_schema,
                        Some(fix),
                    ));
                };
                Ok(json!({ "section": section, "syntax": syntax }))
            }
            "query" => {
                let (repo, _) = self.scope(args)?;
                let source = arg_string(args, "query")?;
                // A `semantic(...)` query on a store without the semantic
                // capability is `capability_unavailable` (Phase 2: `disabled`
                // when no provider is configured, `unavailable` when the
                // configured one failed); with the capability and no provider
                // it stays `provider_unavailable` (the pinned 3.0 case; the
                // runner itself reports `filter_invalid`, §9).
                let semantic = !crate::query::collect_semantic_phrases(&source).is_empty();
                if semantic {
                    self.require_semantic_capability()?;
                }
                if self.provider.is_none() && semantic {
                    return Err(provider_unavailable());
                }
                // The named points of `date()` read the clock this surface
                // stamps commits with (§1.3, 4.8) — pinned under
                // `OMGBASE_SPEC_CLOCK`, the wall clock otherwise.
                let now_ms = dates::stamp_ms(&self.now());
                let opts = QueryOptions {
                    limit: arg_usize(args, "limit")?,
                    cursor: arg_str(args, "cursor"),
                    provider: self.provider.as_deref(),
                    in_memory: false,
                    bare: arg_bool(args, "bare")?.unwrap_or(false),
                    unknown_names: None,
                    vocabulary: Some(&self.vocabulary),
                    now_ms: Some(now_ms),
                    // (4.11) the call as received, for a parse error's corrected `fix`.
                    request: Some(args),
                };
                self.require_rankable(&repo, semantic)?;
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
                let semantic = g.select.iter().any(|s| {
                    !crate::query::collect_semantic_phrases(&format!("from docs select x: {s}"))
                        .is_empty()
                });
                if semantic {
                    self.require_semantic_capability()?;
                }
                if self.provider.is_none() && semantic {
                    return Err(provider_unavailable());
                }
                self.require_rankable(&repo, semantic)?;
                let now_ms = dates::stamp_ms(&self.now());
                graph_neighborhood(
                    &self.store,
                    &repo,
                    &g,
                    self.provider.as_deref(),
                    Some(now_ms),
                )
            }
            "blocks_search" => {
                let (repo, _) = self.scope(args)?;
                let q = arg_string(args, "q")?;
                let res =
                    self.store
                        .text_search(&repo, &q, arg_usize(args, "limit")?.unwrap_or(50))?;
                Ok(json!({
                    "hits": res.hits.iter().map(|h| json!({
                        "_id": h.block_id, "_doc_id": h.doc_id, "_path": reference_path(&h.path), "_type": h.block_type, "_text": h.text, "score": h.score,
                    })).collect::<Vec<_>>(),
                    "truncated": res.truncated,
                }))
            }
            "blocks_resolve" => {
                let (repo, _) = self.scope(args)?;
                let q = arg_string(args, "query")?;
                let limit = arg_usize(args, "limit")?;
                // The hybrid leg runs through the store's semantic capability
                // (Phase 2): a host with a provider but a store without the
                // capability is `capability_unavailable`; without a provider
                // the FTS-only `resolve` is the core's (`find --no-semantic`,
                // open point 13: it degrades, never errors).
                let hits = match &self.provider {
                    None if self.store.semantic_state() == CapabilityState::Unavailable => {
                        return Err(semantic_capability_unavailable(
                            CapabilityState::Unavailable,
                            self.provider_name.as_deref(),
                            self.store.semantic_fault(),
                        ));
                    }
                    Some(p) => {
                        self.require_semantic_capability()?;
                        let vector = QueryVector {
                            model: p.model().to_owned(),
                            vec: p
                                .embed_query(&q)
                                .map_err(|e| SurfaceError::new(e.code(), e.to_string()))?,
                        };
                        self.store.require_semantic()?.resolve(
                            self.store.conn(),
                            &repo,
                            &q,
                            Some(vector),
                            limit,
                        )?
                    }
                    None => self.store.resolve(&repo, &q, limit)?,
                };
                // The locator is `<path>#<type>[<ordinal>]`: its path half is rooted
                // (one without `#` names no path and is left alone).
                let locator = |l: &str| match l.find('#') {
                    Some(i) => format!("{}{}", reference_path(&l[..i]), &l[i..]),
                    None => l.to_owned(),
                };
                Ok(Json::Array(hits.iter().map(|h| json!({
                    "_id": h.id, "locator": locator(&h.locator), "preview": h.preview, "evidence": evidence_json(&h.evidence),
                })).collect()))
            }
            "apply" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                // §4 (4.0): `effects` only — `ops` and `dry_run` are retired
                // names the shape check above refused with their replacements.
                let (plan, receipt) = self.apply_effects_detailed(&repo, root.as_deref(), args)?;
                Ok(receipt.unwrap_or(plan))
            }
            "plan" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let ctx = self.plan_ctx(&repo);
                // §11.8 (4.1): with a `select` the effects are templates over
                // the selector's hits; the Plan carries the `selection`.
                let plan = match SelectRequest::from_args(args)? {
                    Some(req) => {
                        let semantic = self.selector_semantic(&repo, req.select_str())?;
                        self.with_writes(root.as_deref(), |store, ds| {
                            select::plan_selected(store, ds, &ctx, &req, semantic)
                        })?
                    }
                    None => self.with_writes(root.as_deref(), |store, ds| {
                        let effects = select::validate_plain(store, &args["effects"])?;
                        Ok(store.plan_effects(&ctx, &effects, ds)?)
                    })?,
                };
                // (5.1) remembered for `execute { plan_id }` alone — the Plan
                // as planned, preview included (its `summary` is the
                // Receipt's).
                self.remember_plan(&plan);
                let mut plan = plan_json(&plan);
                // (4.5) `preview.diffs` — whole before/after bodies of every
                // touched document — only on request: `diffs: true`. The
                // digest is over the core, never the preview, so `plan_id`
                // is the same either way.
                if args.get("diffs").and_then(Json::as_bool) != Some(true)
                    && let Some(preview) = plan.get_mut("preview").and_then(Json::as_object_mut)
                {
                    preview.remove("diffs");
                }
                Ok(plan)
            }
            "execute" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let reason = arg_str(args, "reason").map(str::to_owned);
                let origin = ApplyOrigin::new(&self.actor, reason.as_deref());
                let ctx = self.plan_ctx(&repo);
                // §4 (3.1; 5.1): exactly one form — the plan, the id alone
                // (5.1: the plan this surface remembers under it, run as the
                // plan form), or `plan_id` + `effects` (+ `select` / `expect`,
                // 4.1: the re-plan runs the selector again; a hit that came or
                // went is `plan_mismatch`).
                let plan_form = args.get("plan").is_some();
                let selector = args.get("select").is_some() || args.get("expect").is_some();
                let id_form =
                    args.get("plan_id").is_some() && args.get("effects").is_none() && !selector;
                let digest_form = !id_form
                    && (args.get("plan_id").is_some() || args.get("effects").is_some() || selector);
                if plan_form == (id_form || digest_form) {
                    return Err(argument_error(
                        name,
                        "pass exactly one of `plan`, `plan_id` or `plan_id` + `effects`",
                        &spec.input_schema,
                    ));
                }
                let receipt = if plan_form || id_form {
                    let plan = if id_form {
                        self.remembered_plan(arg_str(args, "plan_id").unwrap_or_default())?
                    } else {
                        match Plan::admit(&args["plan"]) {
                            Ok(plan) => plan,
                            Err(Admission::Refused(m)) => return Err(SurfaceError::from(m)),
                            Err(Admission::Invalid(m)) => {
                                return Err(SurfaceError::filter_invalid(m, "arguments"));
                            }
                        }
                    };
                    self.with_writes(root.as_deref(), |store, ds| {
                        Ok(store.execute_plan(&ctx, &plan, &origin, ds)?)
                    })
                    .map_err(|e: SurfaceError| {
                        // The id form's `stale_plan` carries the re-plan `fix` the
                        // plan form's does (`fixes::attach` reads the plan from
                        // the arguments, which hold only the id here).
                        if id_form && matches!(e.code.as_str(), "stale_plan" | "plan_mismatch") {
                            fixes::with_fix(e, fixes::replan(&plan.to_json(true)))
                        } else {
                            e
                        }
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
                    let plan_id = plan_id.to_owned();
                    match SelectRequest::from_args(args)? {
                        Some(req) => {
                            let semantic = self.selector_semantic(&repo, req.select_str())?;
                            self.with_writes(root.as_deref(), |store, ds| {
                                store.execute_replanned(&ctx, &plan_id, &origin, ds, |store, ds| {
                                    select::plan_selected(store, ds, &ctx, &req, semantic)
                                })
                            })?
                        }
                        None => self.with_writes(root.as_deref(), |store, ds| {
                            let effects = select::validate_plain(store, effects)?;
                            Ok(store.execute_by_digest(&ctx, &plan_id, &effects, &origin, ds)?)
                        })?,
                    }
                };
                self.notify();
                Ok(receipt_json(&receipt))
            }
            // ---- the sugar tools (ADR-021 migration: `apply { effects }` sugar) ----
            "blocks_insert" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let (parent, doc_id) = self.resolve_parent_ref(&repo, &arg_string(args, "to")?)?;
                let at = self.resolve_at(&repo, args.get("at"))?;
                let effects = sugar::insert(
                    placement_target(parent, doc_id),
                    at,
                    &arg_string(args, "markdown")?,
                    effect_expect(arg_parent_expect(args)?),
                );
                self.apply_sugar(&repo, root.as_deref(), effects, "blocks_insert")
            }
            "blocks_update" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let block = self.resolve_block_ref(&repo, &arg_string(args, "_id")?)?;
                let markdown = arg_str(args, "markdown");
                let checked = arg_bool(args, "checked")?;
                // `set markdown` then `set _attrs.checked` (4.0: `checked` is
                // the one editable attribute — `attrs` is a retired name);
                // the caller's `expect` rides the first, a missing
                // `content_hash` is pinned from the live block (3.2).
                let effects = sugar::update_block(
                    &block,
                    markdown,
                    checked,
                    effect_expect(arg_expect(args)?),
                );
                if effects.is_empty() {
                    return Err(argument_error(
                        name,
                        "pass `markdown` and/or `checked`",
                        &spec.input_schema,
                    ));
                }
                self.apply_sugar(&repo, root.as_deref(), effects, "blocks_update")
            }
            "blocks_move" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let blocks: Vec<String> =
                    require_some(name, "blocks", arg_strings(args, "blocks")?, spec)?
                        .iter()
                        .map(|b| self.resolve_block_ref(&repo, b))
                        .collect::<Result<_>>()?;
                let to_ref = arg_string(args, "to")?;
                let (parent, doc_id) = self.resolve_parent_ref(&repo, &to_ref)?;
                if parent == Parent::Doc
                    && let Some(first) = blocks.first()
                    && self.doc_id_of_block(first)? != Some(doc_id.clone())
                {
                    return Err(SurfaceError::with_data(
                        "target_missing",
                        format!(
                            "blocks_move cannot target another document's root ({to_ref}); anchor on a block in that document with at.before/at.after"
                        ),
                        json!({ "to": to_ref }),
                    ));
                }
                let at = self.resolve_at(&repo, args.get("at"))?;
                let effects = sugar::move_blocks(
                    blocks,
                    placement_target(parent, doc_id),
                    at,
                    effect_expect(arg_parent_expect(args)?),
                );
                self.apply_sugar(&repo, root.as_deref(), effects, "blocks_move")
            }
            "blocks_remove" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let blocks: Vec<String> =
                    require_some(name, "blocks", arg_strings(args, "blocks")?, spec)?
                        .iter()
                        .map(|b| self.resolve_block_ref(&repo, b))
                        .collect::<Result<_>>()?;
                let effects = sugar::remove_blocks(blocks);
                self.apply_sugar(&repo, root.as_deref(), effects, "blocks_remove")
            }
            "blocks_split" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let block = self.resolve_block_ref(&repo, &arg_string(args, "_id")?)?;
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
                let effects = sugar::split_block(&block, at);
                self.apply_sugar(&repo, root.as_deref(), effects, "blocks_split")
            }
            "blocks_merge" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let blocks: Vec<String> =
                    require_some(name, "blocks", arg_strings(args, "blocks")?, spec)?
                        .iter()
                        .map(|b| self.resolve_block_ref(&repo, b))
                        .collect::<Result<_>>()?;
                let effects = sugar::merge_blocks(blocks, arg_str(args, "separator"));
                self.apply_sugar(&repo, root.as_deref(), effects, "blocks_merge")
            }
            "blocks_check" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let blocks: Vec<String> =
                    require_some(name, "_ids", arg_strings(args, "_ids")?, spec)?
                        .iter()
                        .map(|b| self.resolve_block_ref(&repo, b))
                        .collect::<Result<_>>()?;
                // N × `set _attrs.checked`, each pinned by the planner; an id
                // named twice is one identical scalar write — the planner
                // drops the duplicate (a pinned 3.2 fix: the second op no
                // longer fails `stale_expectation`).
                let effects =
                    sugar::check_blocks(&blocks, arg_bool(args, "checked")?.unwrap_or(true));
                self.apply_sugar(&repo, root.as_deref(), effects, "blocks_check")
            }
            "nodes_set" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let node_id = arg_string(args, "_id")?;
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
                        json!({ "_id": node_id }),
                    ));
                }
                let effects = sugar::set_node(
                    &node_id,
                    &arg_string(args, "prop")?,
                    &arg_string(args, "value")?,
                );
                self.apply_sugar(&repo, root.as_deref(), effects, "nodes_set")
            }
            "blocks_append" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let given = arg_string(args, "_id")?;
                let block = self.resolve_block_ref(&repo, &given)?;
                let text = arg_string(args, "text")?;
                // By what the block is (the reference's `blocks_append`): a heading
                // → the end of its section; a container → the end of its children;
                // a leaf → `block_not_container` (append means into).
                type AppendRow = (String, Option<String>, i64, Option<String>, String);
                let row: Option<AppendRow> = self
                    .store
                    .conn()
                    .query_row(
                        "SELECT b.type, d.format, (SELECT count(*) FROM blocks c WHERE c.parent_block = b.block_id AND c.deleted_at IS NULL), b.parent_block, d.path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ?1 AND b.deleted_at IS NULL",
                        params![block],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
                    )
                    .optional()?;
                let Some((kind, format, children, parent, doc_path)) = row else {
                    return Err(block_missing(&given));
                };
                let container = if format.as_deref().unwrap_or("markdown") == "markdown" {
                    kind.parse::<BlockKind>().is_ok_and(|k| k.is_container())
                } else {
                    children > 0
                };
                let into = if kind == "heading" {
                    EffectTarget::Section { heading_id: block }
                } else if container {
                    EffectTarget::Block { id: block }
                } else {
                    return Err(SurfaceError::with_data(
                        "block_not_container",
                        format!(
                            "block {block} is a {kind}, not a heading or a container; append means into — insert after it with blocks_insert {{ to: <its parent>, at: {{ after: {} }} }}",
                            Json::String(block.clone())
                        ),
                        json!({
                            "_id": block,
                            "_type": kind,
                            // §4 "Teaching" (4.4): the sibling insert, under the
                            // leaf's parent (the document when top-level).
                            "fix": fixes::append_after(
                                parent.as_deref().unwrap_or(&reference_path(&doc_path)),
                                &block,
                                &text,
                            ),
                        }),
                    ));
                };
                let effects = sugar::insert(into, At::End, &text, None);
                self.apply_sugar(&repo, root.as_deref(), effects, "blocks_append")
            }
            "docs_append" => {
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let doc_id = self.locate_doc(&repo, name, args)?;
                let text = arg_string(args, "text")?;
                // The heading-TEXT resolution (and `ambiguous_heading`) stays
                // the tool's; the effect names the heading by id.
                let into = match arg_str(args, "section") {
                    Some(section) => {
                        let info = read::find_doc_by_id(self.store.conn(), &doc_id)?
                            .ok_or_else(|| block_missing(&doc_id))?;
                        let heading = self.resolve_section_heading(
                            &doc_id,
                            &info.path,
                            section,
                            (arg_str(args, "_id"), arg_str(args, "_path"), &text),
                        )?;
                        EffectTarget::Section {
                            heading_id: heading,
                        }
                    }
                    None => EffectTarget::Document {
                        id: Some(doc_id),
                        path: None,
                    },
                };
                let effects = sugar::insert(into, At::End, &text, None);
                self.apply_sugar(&repo, root.as_deref(), effects, "docs_append")
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
                // `hits` / `pairs` come from the store's plan as before; the
                // `retarget` effect re-plans the same rewrite for the commit
                // (4.0: committed like every other tool, no `applied`; the
                // preview is `plan { retarget }` → `preview.retarget`).
                let path_glob = arg_str(args, "path_glob").filter(|g| !g.is_empty());
                let plan = self.store.links_repair(&repo, &repairs, path_glob)?;
                let pairs: Vec<(String, String)> = repairs
                    .iter()
                    .map(|r| (r.from.clone(), r.to.clone()))
                    .collect();
                let effects = sugar::retarget(&pairs, path_glob);
                let out =
                    self.apply_sugar_with(&repo, root.as_deref(), name, |_, _| Ok(effects))?;
                let mut m = Map::new();
                m.insert(
                    "hits".to_owned(),
                    Json::Array(plan.hits.iter().map(|h| json!({ "_id": h.block, "_path": reference_path(&h.path), "oldRaw": h.old_raw, "newRaw": h.new_raw })).collect()),
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
                Ok(merge(m, sugar_json(&out)))
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
                let fm = arg_object(args, "frontmatter")?.cloned();
                let sugar::Sugar { effects, reason } = sugar::create_document(
                    &arg_string(args, "path")?,
                    &arg_string(args, "markdown")?,
                    fm.as_ref(),
                );
                let rel = canonical(&arg_string(args, "path")?);
                // The library's own checks first, in its order and with its
                // messages (`path_taken` with an empty `data`, as pinned); the
                // planner's `check_absent` would name the path in `data`.
                let out = self.apply_sugar_with(&repo, root.as_deref(), &reason, |store, ds| {
                    if store.live_doc_at(&repo, &rel)? {
                        return Err(path_taken(format!("document already exists at {rel}")));
                    }
                    if ds.exists(&rel) {
                        return Err(path_taken(format!("file already exists on disk at {rel}")));
                    }
                    Ok(effects)
                })?;
                Ok(sugar_json(&out))
            }
            "docs_move" => {
                let (repo, root) = self.scope(args)?;
                let doc = self.locate_doc(&repo, name, args)?;
                let to_rel = canonical(&arg_string(args, "to_path")?);
                // spec/mutate §6 (1.3): the default is `true`; `false` opts out.
                let retarget = arg_bool(args, "retarget_inbound")?.unwrap_or(true);
                let info = self.doc_info(&repo, &doc)?;
                let sugar::Sugar { effects, reason } =
                    sugar::move_document(&info.doc_id, &info.path, &to_rel, retarget);
                // `dangling`/`retargeted` as the library reported them: planned
                // over the current blocks before anything moves; the planner
                // lowers the same plan.
                let mut report: Option<(Vec<omgbase_store::InboundLink>, Option<Retargeted>)> =
                    None;
                let out = self.apply_sugar_with(&repo, root.as_deref(), &reason, |store, ds| {
                    if store.live_doc_at(&repo, &to_rel)? {
                        return Err(path_taken(format!("a document already exists at {to_rel}")));
                    }
                    let inbound = inbound_links_to(store.conn(), &repo, &info.doc_id, &info.path)?;
                    if ds.exists(&to_rel) {
                        return Err(path_taken(format!(
                            "file already exists on disk at {to_rel}"
                        )));
                    }
                    report = Some(if retarget && !inbound.is_empty() {
                        let p = store.plan_inbound_retarget(
                            &info.doc_id,
                            &info.path,
                            &to_rel,
                            &inbound,
                        )?;
                        (
                            p.dangling,
                            Some(Retargeted {
                                blocks: p.blocks,
                                docs: p.docs,
                            }),
                        )
                    } else {
                        (inbound, None)
                    });
                    Ok(effects)
                })?;
                let (dangling, retargeted) = report.expect("set before the effects were built");
                if out.1.is_none() {
                    // Previewing: the Plan alone (`spec/cli` §3.6).
                    return Ok(sugar_json(&out));
                }
                // The Receipt, then the link report (§4, the reference's key
                // order): `retargeted`, then each dangling link as a link row
                // under the `links` target's names (§1.2, 5.0) with its source
                // `_path` rooted; its `target` stays as authored — that is what
                // the link says.
                let mut m = Map::new();
                m.insert(
                    "retargeted".to_owned(),
                    retargeted_json(retargeted.as_ref()),
                );
                m.insert(
                    "dangling".to_owned(),
                    Json::Array(dangling.iter().map(dangling_json).collect()),
                );
                let Json::Object(receipt) = sugar_json(&out) else {
                    unreachable!("a receipt is an object")
                };
                Ok(merge(receipt, Json::Object(m)))
            }
            "docs_delete" => {
                let (repo, root) = self.scope(args)?;
                let doc = self.locate_doc(&repo, name, args)?;
                let info = self.doc_info(&repo, &doc)?;
                let sugar::Sugar { effects, reason } =
                    sugar::delete_document(&info.doc_id, &info.path);
                self.apply_sugar(&repo, root.as_deref(), effects, &reason)
            }
            "docs_set_meta" => {
                let (repo, root) = self.scope(args)?;
                let doc = self.locate_doc(&repo, name, args)?;
                let set = arg_object(args, "set")?.cloned();
                let unset = if args.get("unset").is_some() {
                    arg_strings(args, "unset")?
                } else {
                    Vec::new()
                };
                let info = self.doc_info(&repo, &doc)?;
                // One `set`/`unset _frontmatter.<key>` per key, `unset` winning
                // a key named in both (`sugar::set_meta`).
                let sugar::Sugar { effects, reason } =
                    sugar::set_meta(&info.doc_id, &info.path, set.as_ref(), &unset);
                if effects.is_empty() {
                    // Nothing to set or unset: the library path rewrote the
                    // frontmatter through the YAML emitter anyway (a
                    // normalizing no-op commit); with no effect to plan this is
                    // an argument error in both engines (3.3).
                    return Err(argument_error(
                        name,
                        "pass `set` and/or `unset`",
                        &spec.input_schema,
                    ));
                }
                self.apply_sugar(&repo, root.as_deref(), effects, &reason)
            }
            "docs_update" => {
                // Surface 4.0: sugar for `set { document, field: "content" }`
                // — the whole-document planner's opset lowered into one plan
                // and committed as one receipt (the identity decision is the
                // Plan's `preview.identity`; preview with `plan`). A content
                // already current plans nothing and commits nothing.
                let (repo, root) = self.scope(args)?;
                self.require_root(root.as_deref())?;
                let doc = self.locate_doc(&repo, name, args)?;
                let info = self.doc_info(&repo, &doc)?;
                let content = arg_string(args, "content")?;
                let reason = arg_str(args, "reason").map(str::to_owned);
                let origin = ApplyOrigin::new(&self.actor, reason.as_deref());
                let ctx = self.plan_ctx(&repo);
                let effects = sugar::update_content(&info.doc_id, &content);
                let preview = self.preview;
                let (plan, receipt) = self.with_writes(root.as_deref(), |store, ds| {
                    if preview {
                        return Ok((store.plan_effects(&ctx, &effects, ds)?, None));
                    }
                    let (plan, receipt) = store
                        .apply_effects_detailed(&ctx, &effects, &origin, ds)
                        .map_err(strip_effect_index)?;
                    Ok((plan, Some(receipt)))
                })?;
                self.last_plan = Some(plan.clone());
                if receipt.as_ref().is_some_and(|r| r.commit.is_some()) {
                    self.notify();
                }
                Ok(sugar_json(&(plan, receipt)))
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
                    json!({ "_id": out.doc_id, "_path": reference_path(&out.path), "deleted": out.deleted() }),
                )
            }
            "blocks_history" => history::blocks_history(
                &self.store,
                &arg_string(args, "_id")?,
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
                let doc_ref = arg_str(args, "_id")
                    .or(arg_str(args, "_path"))
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
                    json!({ "_id": doc_id, "_path": path.as_deref().map_or_else(String::new, reference_path), "from": from, "to": to, "diff": diff }),
                )
            }
            // sugar for `docs_read { _id | _path, at: rev }` (4.7): the same code
            // path, the identical result.
            "docs_read_at" => {
                let (repo, _) = self.scope(args)?;
                let doc_id = self.locate_doc(&repo, name, args)?;
                let rev = arg_string(args, "rev")?;
                self.docs_read_at(&doc_id, &rev)
            }
            "docs_history" => {
                let (repo, _) = self.scope(args)?;
                let glob = arg_str(args, "path_glob").filter(|g| !g.is_empty());
                let id = arg_str(args, "_id");
                let path = arg_str(args, "_path");
                if glob.is_none() && id.is_none() && path.is_none() {
                    return Err(SurfaceError::new(
                        "target_missing",
                        "docs_history requires one of path_glob, _id or _path",
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
                    &omgbase_store::ChangesSinceOptions {
                        cursor: arg_i64(args, "cursor")?.unwrap_or(0),
                        epoch: arg_str(args, "epoch"),
                        limit: arg_usize(args, "limit")?.unwrap_or(50),
                        origin: arg_str(args, "origin").filter(|o| !o.is_empty()),
                    },
                )?;
                Ok(root_changes_page(page))
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
            // §4 "Profiles": the tool reports which profile the host serves;
            // `epoch` (6.0) the default repository's feed epoch.
            "version" => version_info_for(
                Some(&self.store),
                Some(&self.default_repo),
                &self.build_info,
                self.profile,
            ),
            other => Err(SurfaceError::other(format!("unknown tool {other}"))),
        }
    }
}

/// `block_missing` for a block the caller named (`_id` or a ref): the
/// attribute spelling, the argument as given in `data`.
fn block_missing(value: &str) -> SurfaceError {
    SurfaceError::with_data(
        "block_missing",
        format!("no block with id {}", Json::String(value.to_owned())),
        json!({ "_id": value }),
    )
}

/// `nodes_block_read` on a node that names no live block.
fn node_has_no_block(node_id: &str, doc_id: &str) -> SurfaceError {
    SurfaceError::with_data(
        "block_missing",
        format!("node {} has no block", Json::String(node_id.to_owned())),
        json!({ "_id": node_id, "_doc_id": doc_id }),
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

/// `capability_unavailable { capability: "semantic", state: "disabled" }`'s
/// message (Phase 2): the module is not installed because nothing is
/// configured. Byte for byte the reference's (`core/capabilities/errors.ts`).
pub const SEMANTIC_DISABLED_MESSAGE: &str = "semantic search is disabled for this repository — configure an embedding provider (omg config set embedding.provider <command|url>) and embed the repository (omg embed drain)";

/// The `disabled` envelope's `fix`.
pub const SEMANTIC_DISABLED_FIX: &str = "omg config set embedding.provider <command|url>";

/// The `unavailable` message: the configured provider (JSON-quoted) and its
/// failure (the OS's text, unpinned).
#[must_use]
pub fn semantic_unavailable_message(provider: &str, reason: &str) -> String {
    format!(
        "semantic search is unavailable — the configured embedding provider {} failed to start: {reason}",
        Json::String(provider.to_owned())
    )
}

/// `capability_unavailable` for the semantic capability (Phase 2, D3): the
/// envelope of `docs/modular-core/phase-1-contracts.md` §2.1 as both engines
/// spell it — `data { capability, state, provider?, reason?, fix? }`,
/// `retriable` only for `unavailable`. `Enabled` is not an error; a caller
/// never passes it (it is rendered as `disabled`).
#[must_use]
pub fn semantic_capability_unavailable(
    state: CapabilityState,
    provider: Option<&str>,
    fault: Option<&str>,
) -> SurfaceError {
    match state {
        CapabilityState::Unavailable => {
            let provider = provider.unwrap_or("");
            let reason = fault.unwrap_or("no reason recorded");
            let mut e = SurfaceError::with_data(
                "capability_unavailable",
                semantic_unavailable_message(provider, reason),
                json!({
                    "capability": "semantic",
                    "state": "unavailable",
                    "provider": provider,
                    "reason": reason,
                }),
            );
            e.retriable = true;
            e
        }
        CapabilityState::Disabled | CapabilityState::Enabled => SurfaceError::with_data(
            "capability_unavailable",
            SEMANTIC_DISABLED_MESSAGE,
            json!({
                "capability": "semantic",
                "state": "disabled",
                "fix": SEMANTIC_DISABLED_FIX,
            }),
        ),
    }
}

/// The `effects` argument (`spec/mutate` §11.1): a malformed effect is
/// `filter_invalid { reason, hint: "arguments" }` naming `effects[i]`.
fn parse_effects(v: &Json) -> Result<Vec<PublicEffect>> {
    PublicEffect::list_from_json(v).map_err(|m| SurfaceError::filter_invalid(m, "arguments"))
}

/// A plan on the wire (`spec/mutate` §11): the digest-covered core as the
/// planner wrote it — a client echoes it back to `execute`, so no key moves
/// — and, under §1 "Paths", the preview's `revisions[]._path` and `diffs`
/// keys in the reference form.
#[must_use]
pub fn plan_json(plan: &Plan) -> Json {
    let mut v = plan.to_json(true);
    if let Some(preview) = v.get_mut("preview").and_then(Json::as_object_mut) {
        if let Some(revs) = preview.get_mut("revisions").and_then(Json::as_array_mut) {
            for r in revs {
                root_field(r, "_path");
            }
        }
        // The kernel results spell `merged_into` (the `spec/mutate` fixture
        // spelling); on the wire a result is `{ ids, removed?, mergedInto? }`,
        // as the reference's `OpResult` is — the 3.x apply result's spelling.
        if let Some(results) = preview.get_mut("results").and_then(Json::as_array_mut) {
            for r in results {
                if let Some(o) = r.as_object_mut()
                    && let Some(m) = o.shift_remove("merged_into")
                {
                    o.insert("mergedInto".to_owned(), m);
                }
            }
        }
        if let Some(diffs) = preview.get_mut("diffs") {
            *diffs = reference_keyed(diffs);
        }
        // 4.0: a `retarget` effect's hits name their document's path.
        if let Some(retargets) = preview.get_mut("retarget").and_then(Json::as_array_mut) {
            for r in retargets {
                if let Some(hits) = r.get_mut("hits").and_then(Json::as_array_mut) {
                    for h in hits {
                        root_field(h, "_path");
                    }
                }
            }
        }
    }
    v
}

/// A receipt on the wire: `revisions[]._path` in the reference form.
#[must_use]
pub fn receipt_json(receipt: &Receipt) -> Json {
    let mut v = receipt.to_json();
    if let Some(revs) = v.get_mut("revisions").and_then(Json::as_array_mut) {
        for r in revs {
            root_field(r, "_path");
        }
    }
    v
}

/// A dangling inbound link as a link row (`spec/surface` §4 `docs_move`, 5.0):
/// `{ _doc_id, _path, _block_id, target, _anchor, _field? }` — the source
/// `_path` rooted, the `target` (a role) as authored.
fn dangling_json(l: &omgbase_store::InboundLink) -> Json {
    let mut m = Map::new();
    m.insert("_doc_id".to_owned(), json!(l.doc));
    m.insert("_path".to_owned(), json!(reference_path(&l.path)));
    m.insert("_block_id".to_owned(), json!(l.block));
    m.insert("target".to_owned(), json!(l.target));
    m.insert("_anchor".to_owned(), json!(l.anchor));
    if let Some(f) = &l.field {
        m.insert("_field".to_owned(), json!(f));
    }
    Json::Object(m)
}

/// `path_taken` as the library's document operations raise it: the message
/// alone, an empty `data` (`spec/surface` §7 pins `path_taken {}`).
fn path_taken(message: String) -> SurfaceError {
    SurfaceError::from(MutationError::new(ErrorCode::PathTaken, message))
}

/// `changes_since` on the wire (§1 Paths, 2.0; §3, 6.0): the store renders
/// its digests in the storage form; every document's `_path` and `from_path`
/// is rooted here, and the summary is re-rendered over the rooted paths with
/// the digest's disposition counts (the reference composes `renderSummary`
/// from rooted paths), so the same line reads `observed: /a.md — created — 3
/// inserted`, `api(human:spec): deleted /a.md`, `api(human:spec): moved
/// /a.md → /b.md; /index.md — changed — 31 edited`.
fn root_changes_page(mut page: omgbase_store::ChangesPage) -> Json {
    for d in &mut page.digests {
        for r in &mut d.revisions {
            r.path = reference_path(&r.path);
            if let Some(from) = &r.from_path {
                r.from_path = Some(reference_path(from));
            }
        }
        d.summary = omgbase_store::render_summary(
            &d.origin,
            d.actor.as_deref(),
            &d.revisions,
            d.counts.as_deref(),
        );
    }
    page.to_json()
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

/// The public `observe` result: `{ _id, _path, rev, commitId, converged,
/// echo, conflicted, dispositions: [{ kind, count }] }` — the store's own
/// `{ doc, commit, rev }` outcome (`spec/store` §9) re-shaped under the row
/// rule (§1.2, 5.0).
fn observe_json(o: &omgbase_store::ObserveOutcome) -> Json {
    json!({
        "_id": o.doc_id,
        "_path": reference_path(&o.path),
        "rev": o.rev,
        "commitId": o.commit_id,
        "converged": o.converged,
        "echo": o.echo,
        "conflicted": o.conflicted,
        "dispositions": o.dispositions.iter().map(|(k, n)| json!({ "kind": k, "count": n })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod sugar_tests;

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

    /// §4 "Profiles" (4.3): `minimal` lists exactly the ten in catalog
    /// order; `full` the whole table; a profile filters listing and calling
    /// only — the schemas, the write set and the dispatch stay the table's.
    #[test]
    fn profiles_filter_the_listing_not_the_semantics() {
        let full = surface();
        assert_eq!(full.profile(), Profile::Full);
        assert_eq!(full.tools(), tools());
        let minimal = surface().with_profile(Profile::Minimal);
        assert_eq!(minimal.profile(), Profile::Minimal);
        let names: Vec<&str> = minimal.tools().iter().map(|t| t.name).collect();
        // The ten, in the table's registration order (not the list's).
        let mut sorted_names = names.clone();
        sorted_names.sort_unstable();
        let mut sorted_set = MINIMAL_TOOLS.to_vec();
        sorted_set.sort_unstable();
        assert_eq!(sorted_names, sorted_set);
        assert_eq!(
            names,
            [
                "docs_read",
                "docs_tree",
                "query_syntax",
                "query",
                "blocks_resolve",
                "apply",
                "plan",
                "execute",
                "changes_since",
                "version",
            ]
        );
        for t in minimal.tools() {
            assert_eq!(
                Some(&t),
                tool_spec(t.name),
                "{} is the full table's spec",
                t.name
            );
        }
        assert!(
            Surface::is_write_tool("docs_create"),
            "the write set is static"
        );
        assert_eq!("full".parse::<Profile>(), Ok(Profile::Full));
        assert_eq!("minimal".parse::<Profile>(), Ok(Profile::Minimal));
        assert_eq!(
            "lite".parse::<Profile>(),
            Err("unknown tools profile \"lite\" (expected full|minimal)".to_owned())
        );
        assert_eq!(Profile::Minimal.to_string(), "minimal");
        // `version` reports the profile; a tool the profile hides still
        // dispatches at the library level (the host's membership check is the
        // gate: `tools/call` on an unlisted name is `unknown tool <name>`).
        let mut minimal = minimal;
        let v = minimal.call("version", json!({}));
        assert_eq!(v.body["profile"], "minimal");
        let mut full = full;
        assert_eq!(full.call("version", json!({})).body["profile"], "full");
        let listed = minimal.call("docs_list", json!({}));
        assert!(!listed.is_error);
        let unknown = minimal.call("docs_lits", json!({}));
        assert!(unknown.is_error);
        assert_eq!(unknown.body["message"], "unknown tool docs_lits");
    }

    /// `spec/mutate` §11.8 at the surface (4.1): `plan` / `apply` / `execute`
    /// take `select` + `expect`; the Plan carries the digested `selection`;
    /// the digest form re-runs the selector; a one-shot `apply` needs
    /// `expect.max`; `expect` without `select` is refused; zero hits commit
    /// nothing; the refusals carry `hint: "selection"`.
    #[test]
    fn plan_apply_and_execute_take_a_selector() {
        let mut s = surface();
        for (path, content) in [
            ("hub.md", "---\ntype: project\n---\n\n# Hub\n\nIntro.\n"),
            (
                "ws/alpha.md",
                "---\ntype: workstream\nstatus: completed\nproject: hub.md\n---\n\n# Alpha\n",
            ),
            (
                "ws/beta.md",
                "---\ntype: workstream\nstatus: completed\nproject: hub.md\n---\n\n# Beta\n",
            ),
            (
                "ws/gamma.md",
                "---\ntype: workstream\nstatus: active\nproject: hub.md\n---\n\n# Gamma\n",
            ),
        ] {
            let out = s.call("observe", json!({ "path": path, "content": content }));
            assert!(!out.is_error, "{}", out.body);
        }
        let select = "from docs where type == \"workstream\" and status == \"completed\"";
        let templates = json!([
            { "op": "insert", "into": { "kind": "document", "_path": { "oqx": "project" } }, "markdown": { "oqx": "\"- [\" + _title + \"](\" + _path + \")\"" } },
            { "op": "set", "field": "_frontmatter.rolled_up", "value": true },
        ]);
        let plan = s.call(
            "plan",
            json!({ "select": select, "effects": templates, "diffs": true }),
        );
        assert!(!plan.is_error, "{}", plan.body);
        let plan = plan.body;
        assert_eq!(plan["planner_v"], "p3");
        assert_eq!(plan["effects"].as_array().map(Vec::len), Some(4));
        assert_eq!(
            plan["effects"][0]["into"],
            json!({ "kind": "document", "_id": "d_0", "_path": "hub.md" })
        );
        assert_eq!(plan["effects"][0]["markdown"], "- [Alpha](/ws/alpha.md)");
        assert_eq!(
            plan["effects"][1]["target"],
            json!({ "kind": "document", "_id": "d_1", "_path": "ws/alpha.md" })
        );
        assert_eq!(
            plan["selection"],
            json!({ "query": select, "templates": templates, "cardinality": 2, "identities": ["d_1", "d_2"] })
        );
        assert!(
            plan["preview"]["diffs"]["/hub.md"]["after"]
                .as_str()
                .unwrap()
                .contains("- [Beta](/ws/beta.md)")
        );
        // the plan form carries its selection; the receipt commits all three documents
        let receipt = s.call(
            "execute",
            json!({ "plan": plan.clone(), "reason": "rollup" }),
        );
        assert!(!receipt.is_error, "{}", receipt.body);
        assert_eq!(receipt.body["plan_id"], plan["plan_id"]);
        assert_eq!(receipt.body["revisions"].as_array().map(Vec::len), Some(3));
        let ops: String = s
            .store()
            .conn()
            .query_row(
                "SELECT ops FROM commits WHERE commit_id = ?1",
                [receipt.body["commit"].as_str().unwrap()],
                |r| r.get(0),
            )
            .unwrap();
        assert!(ops.contains("\"selection\":{\"cardinality\":2"), "{ops}");
        // the digest form re-runs the selector: the marked hits no longer match (the
        // selector is the same but `rolled_up` is not in it, so they still do — a new
        // completed workstream changes the identities → plan_mismatch)
        let again = s.call(
            "plan",
            json!({ "select": select, "effects": templates, "expect": { "max": 5 } }),
        );
        assert!(!again.is_error, "{}", again.body);
        assert_eq!(again.body["selection"]["expect"], json!({ "max": 5 }));
        let out = s.call("observe", json!({ "path": "ws/delta.md", "content": "---\ntype: workstream\nstatus: completed\nproject: hub.md\n---\n\n# Delta\n" }));
        assert!(!out.is_error);
        let stale = s.call("execute", json!({ "plan_id": again.body["plan_id"], "select": select, "effects": templates, "expect": { "max": 5 } }));
        assert!(stale.is_error);
        assert_eq!(stale.body["error"], "plan_mismatch", "{}", stale.body);
        assert_eq!(stale.body["data"]["expected"], again.body["plan_id"]);
        // a one-shot apply needs the bound; too small a bound is selection_too_large and writes nothing
        let unbounded = s.call("apply", json!({ "select": select, "effects": templates }));
        assert!(unbounded.is_error);
        assert_eq!(unbounded.body["error"], "filter_invalid");
        assert_eq!(unbounded.body["data"]["hint"], "selection");
        assert_eq!(
            unbounded.body["message"],
            "`expect.max` is required on `apply` with `select` — bound the selection, or preview it with `plan`"
        );
        let small = s.call(
            "apply",
            json!({ "select": select, "effects": templates, "expect": { "max": 2 } }),
        );
        assert!(small.is_error);
        assert_eq!(small.body["error"], "selection_too_large", "{}", small.body);
        // three hits under `max: 2`: the page is `bound + 1`, so the count is
        // exact — and the fix (4.4) is the same call bounded at it.
        assert_eq!(
            small.body["data"],
            json!({
                "cardinality": 3,
                "max": 2,
                "fix": omgbase_mutate::canonical_json(&json!({ "select": select, "effects": templates, "expect": { "max": 3 } })),
            })
        );
        let one = s.call(
            "apply",
            json!({ "select": select, "effects": templates, "expect": { "max": 1 } }),
        );
        // the page was cut at the bound: the count for the fix comes from a
        // second, unbounded run — the same three.
        assert_eq!(
            one.body["data"],
            json!({
                "cardinality": ">1",
                "max": 1,
                "fix": omgbase_mutate::canonical_json(&json!({ "select": select, "effects": templates, "expect": { "max": 3 } })),
            }),
            "{}",
            one.body
        );
        // zero hits: an empty plan, a receipt with commit null
        let none = s.call("apply", json!({ "select": "from docs where type == \"nope\"", "effects": templates, "expect": { "max": 10 } }));
        assert!(!none.is_error, "{}", none.body);
        assert_eq!(none.body["commit"], Json::Null);
        assert_eq!(none.body["revisions"], json!([]));
        let empty = s.call(
            "plan",
            json!({ "select": "from docs where type == \"nope\"", "effects": templates }),
        );
        assert_eq!(empty.body["effects"], json!([]));
        assert_eq!(empty.body["selection"]["cardinality"], 0);
        // `expect` without `select`; a refused selector; the argument hint tail names both
        let e = s.call(
            "plan",
            json!({ "effects": templates, "expect": { "max": 1 } }),
        );
        assert_eq!(
            e.body["message"],
            "`expect` bounds a selection — pass `select` with it"
        );
        let e = s.call(
            "plan",
            json!({ "select": "from links", "effects": templates }),
        );
        assert_eq!(e.body["error"], "filter_invalid");
        assert_eq!(e.body["data"]["hint"], "selection");
        assert!(
            e.body["message"]
                .as_str()
                .unwrap()
                .starts_with("select: `links` rows")
        );
        let e = s.call("execute", json!({ "plan": plan, "select": select }));
        assert!(
            e.body["message"]
                .as_str()
                .unwrap()
                .starts_with("pass exactly one of `plan`, `plan_id` or `plan_id` + `effects`"),
            "{}",
            e.body
        );
        let e = s.call(
            "plan",
            json!({ "select": select, "effects": templates, "expect": 3 }),
        );
        assert!(
            e.body["message"]
                .as_str()
                .unwrap()
                .starts_with("`expect` must be"),
            "{}",
            e.body
        );
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
            { "op": "set", "target": { "kind": "document", "_path": "/a.md" }, "field": "_frontmatter.status", "value": "done" },
            { "op": "insert", "into": { "kind": "section", "heading_id": "b_0" }, "markdown": "Tail." },
        ]);
        let plan = s.call("plan", json!({ "effects": effects, "diffs": true }));
        assert!(!plan.is_error, "{}", plan.body);
        let plan = plan.body;
        assert_eq!(plan["version"], 1);
        assert_eq!(plan["plan_id"].as_str().map(str::len), Some(64));
        assert_eq!(
            plan["effects"][0]["target"],
            json!({ "kind": "document", "_id": "d_0", "_path": "a.md" }),
            "the core keeps storage paths"
        );
        assert_eq!(
            plan["preview"]["revisions"][0]["_path"], "/a.md",
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
        // 4.0: the retired inputs name their replacement (`spec/surface` §4);
        // `effects` is required; nothing is stripped silently.
        let dry = s.call("apply", json!({ "effects": effects, "dry_run": true }));
        assert_eq!(dry.body["error"], "filter_invalid", "{}", dry.body);
        assert_eq!(
            dry.body["message"],
            "`dry_run` is no longer an argument — preview with `plan { effects: [...] }` (apply takes effects, expect?, reason?, repo?, select?)"
        );
        let ops = s.call("apply", json!({ "ops": [] }));
        assert_eq!(ops.body["error"], "filter_invalid");
        assert_eq!(
            ops.body["message"],
            "`ops` is no longer an argument — `apply` takes `effects` (the kernel ops are a library/fixture contract since spec/mutate 3.0) (apply takes effects, expect?, reason?, repo?, select?)"
        );
        assert_eq!(ops.body["data"]["hint"], "arguments");
        let neither = s.call("apply", json!({}));
        assert_eq!(neither.body["error"], "filter_invalid");
        assert_eq!(
            neither.body["message"],
            "`effects` is required (apply takes effects, expect?, reason?, repo?, select?)"
        );
        // The CLI's preview seam plans the same effects: the same plan, no
        // commit, nothing minted.
        let previewed = s
            .preview_call("apply", &json!({ "effects": effects }))
            .unwrap();
        assert_eq!(previewed["plan_id"], plan["plan_id"]);
        assert!(previewed.get("preview").is_some());
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
        assert_eq!(receipt.body["revisions"][0]["_path"], "/a.md");
        assert_eq!(receipt.body["new_ids"], json!({ "$new.0": "b_2" }));
        let read = s.call("docs_read", json!({ "_path": "a.md" }));
        assert_eq!(
            read.body["_raw"],
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
        // (5.1) The id alone is the remembered plan — already executed, so its
        // own preconditions fail it (stale_plan, not plan_mismatch); the half
        // digest form is `plan_id` + `expect` without `effects`, or `effects`
        // alone; an id this surface never planned is plan_unknown.
        let by_id = s.call("execute", json!({ "plan_id": plan["plan_id"] }));
        assert!(by_id.is_error);
        assert_eq!(by_id.body["error"], "stale_plan", "{}", by_id.body);
        for half_args in [
            json!({ "plan_id": plan["plan_id"], "expect": { "max": 1 } }),
            json!({ "effects": effects }),
        ] {
            let half = s.call("execute", half_args);
            assert!(half.is_error);
            assert!(
                half.body["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("the digest form needs both"),
                "{}",
                half.body
            );
        }
        let unknown = s.call("execute", json!({ "plan_id": "0".repeat(64) }));
        assert!(unknown.is_error);
        assert_eq!(unknown.body["error"], "plan_unknown");
        assert_eq!(unknown.body["retriable"], true);
        assert_eq!(unknown.body["data"], json!({ "plan_id": "0".repeat(64) }));
        assert_eq!(
            unknown.body["message"],
            format!(
                "this server has no plan {} — re-run plan, or pass the plan (or `plan_id` + `effects`) with execute",
                "0".repeat(64)
            )
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

    /// `bare: true` (§1.4, 4.2): hits are their projection only; identity
    /// stays internal, so paging is unchanged.
    #[test]
    fn bare_hits_are_the_projection_only() {
        let mut s = surface();
        for (path, content) in [
            ("a.md", "---\nlayer: canon\nid: authored-a\n---\n# Alpha\n"),
            ("b.md", "---\nlayer: canon\n---\n# Beta\n"),
            ("c.md", "---\nlayer: working\n---\n# Gamma\n"),
        ] {
            let out = s.call("observe", json!({ "path": path, "content": content }));
            assert!(!out.is_error, "{}", out.body);
        }
        // the default envelope is untouched
        let plain = s.call("query", json!({ "query": "select _title from docs" }));
        assert_eq!(
            plain.body["hits"][0],
            json!({ "_id": "d_0", "_path": "/a.md", "_title": "Alpha" })
        );
        // bare: the projection only, `truncated`/`cursor` as before
        let bare = s.call(
            "query",
            json!({ "query": "select _title from docs", "bare": true }),
        );
        assert!(!bare.is_error, "{}", bare.body);
        assert_eq!(
            bare.body["hits"],
            json!([{ "_title": "Alpha" }, { "_title": "Beta" }, { "_title": "Gamma" }])
        );
        assert_eq!(bare.body["truncated"], false);
        assert_eq!(bare.body["cursor"], Json::Null);
        assert_eq!(bare.body["consumer"], "collect");
        // `select _id`/`_path` under bare is the attribute, an ordinary
        // column in the query's own order; the authored `id:` key is the
        // bare `id` (5.0); with no envelope there is nothing to collide with
        let intrinsic = s.call(
            "query",
            json!({ "query": "select i: id, _id, _path from docs where _path == \"a.md\"", "bare": true }),
        );
        assert_eq!(
            intrinsic.body["hits"].to_string(),
            r#"[{"i":"authored-a","_id":"d_0","_path":"/a.md"}]"#
        );
        let no_collision = s.call(
            "query",
            json!({ "query": "select _path: layer from docs where _title == \"Alpha\"", "bare": true }),
        );
        assert_eq!(no_collision.body["hits"], json!([{ "_path": "canon" }]));
        assert_eq!(
            s.call("query", json!({ "query": "select _path: layer from docs" }))
                .body["error"],
            "filter_invalid"
        );
        // the scalar consumers have no hits and ignore it
        let count = s.call("query", json!({ "query": "docs count { }", "bare": true }));
        assert_eq!(count.body["count"], 3, "{}", count.body);
        // paging keeps the keyset cursor: identity is kept until the result is shaped
        let page1 = s.call(
            "query",
            json!({ "query": "select _title from docs", "bare": true, "limit": 2 }),
        );
        assert_eq!(page1.body["truncated"], true);
        assert_eq!(
            page1.body["hits"],
            json!([{ "_title": "Alpha" }, { "_title": "Beta" }])
        );
        let cursor = page1.body["cursor"].as_str().expect("a cursor").to_owned();
        let page2 = s.call(
            "query",
            json!({ "query": "select _title from docs", "bare": true, "limit": 2, "cursor": cursor }),
        );
        assert_eq!(page2.body["hits"], json!([{ "_title": "Gamma" }]));
        assert_eq!(page2.body["truncated"], false);
        // first/single and distinct are shaped the same way
        let first = s.call(
            "query",
            json!({ "query": "docs first { select layer where layer == \"working\" }", "bare": true }),
        );
        assert_eq!(first.body["hits"], json!([{ "layer": "working" }]));
        let distinct = s.call(
            "query",
            json!({ "query": "select distinct layer from docs", "bare": true }),
        );
        assert_eq!(
            distinct.body["hits"],
            json!([{ "layer": "canon" }, { "layer": "working" }])
        );
        // nested rows keep their `{ _id, _path }` reference shape
        let nested = s.call(
            "query",
            json!({ "query": "select b: _blocks collect { } from docs where _path == \"b.md\"", "bare": true }),
        );
        assert_eq!(
            nested.body["hits"],
            json!([{ "b": [{ "_id": "b_1", "_path": "/b.md" }] }])
        );
        // refused: no select, values, a non-boolean
        let no_select = s.call("query", json!({ "query": "from docs", "bare": true }));
        assert_eq!(no_select.body["error"], "filter_invalid");
        assert_eq!(
            no_select.body["message"],
            "`bare` needs a `select` — without a projection a hit is only its envelope"
        );
        let values = s.call(
            "query",
            json!({ "query": "select _title values from docs", "bare": true }),
        );
        assert_eq!(values.body["error"], "filter_invalid");
        assert_eq!(
            values.body["message"],
            crate::query::BARE_WITH_VALUES_MESSAGE
        );
        let typed = s.call(
            "query",
            json!({ "query": "select _title from docs", "bare": "yes" }),
        );
        assert_eq!(typed.body["error"], "filter_invalid");
        assert_eq!(
            typed.body["message"],
            "`bare` must be a boolean (query takes bare?, cursor?, limit?, query, repo?)"
        );
        // `bare: false` is the default envelope
        let off = s.call(
            "query",
            json!({ "query": "select _title from docs", "bare": false }),
        );
        assert_eq!(off.body["hits"][0]["_id"], "d_0");
        assert!(s.tools().iter().any(
            |t| t.name == "query" && t.input_schema["properties"]["bare"]["type"] == "boolean"
        ));
    }

    #[test]
    fn observe_read_and_query_round_trip() {
        let mut s = surface();
        let out = s.call("observe", json!({ "path": "a.md", "content": "---\nlayer: canon\n---\n# Title\n\nHello world.\n\n- [ ] task one\n" }));
        assert!(!out.is_error, "{}", out.body);
        assert_eq!(out.body["_id"], "d_0");
        assert_eq!(out.body["echo"], false);
        let read = s.call("docs_read", json!({ "_path": "a.md", "include_ids": true }));
        assert!(!read.is_error, "{}", read.body);
        assert_eq!(read.body["_path"], "/a.md");
        // either form names the document (§1 Paths)
        assert_eq!(
            s.call("docs_read", json!({ "_path": "/a.md" })).body["_path"],
            "/a.md"
        );
        // §4 "Arguments": the retired `doc` is refused with its replacement;
        // (5.0) a bare `id`/`path` is refused with the `_` spelling and a fix.
        let retired = s.call("docs_read", json!({ "doc": "a.md" }));
        assert_eq!(retired.body["error"], "filter_invalid");
        assert_eq!(
            retired.body["message"],
            "`doc` is no longer an argument — pass `_id` or `_path` (docs_read takes _id?, _path?, at?, include_ids?, repo?)"
        );
        let neither = s.call("docs_read", json!({}));
        assert_eq!(
            neither.body["message"],
            "pass _id or _path (docs_read takes _id?, _path?, at?, include_ids?, repo?)"
        );
        let bare_path = s.call("docs_read", json!({ "path": "a.md" }));
        assert_eq!(
            bare_path.body["message"],
            "`path` is not an argument — the engine field is `_path` (the bare namespace is the user's); pass `_path` (docs_read takes _id?, _path?, at?, include_ids?, repo?)"
        );
        assert_eq!(bare_path.body["data"]["fix"], r#"{"_path":"a.md"}"#);
        assert_eq!(
            s.call("docs_read", json!({ "_path": "//a.md" })).body["_id"],
            "d_0"
        );
        assert_eq!(read.body["properties"]["frontmatter"]["layer"], "canon");
        assert!(read.body["ids"].as_array().unwrap().len() >= 3);
        let q = s.call("query", json!({ "query": "select _title, layer, t: _nodes collect { _value where _kind == \"md:task\" } from docs where layer == \"canon\" && _nodes count { where _kind == \"md:task\" } == 1" }));
        assert!(!q.is_error, "{}", q.body);
        assert_eq!(q.body["hits"][0]["_title"], "Title");
        assert_eq!(q.body["hits"][0]["layer"], "canon");
        assert_eq!(q.body["hits"][0]["t"][0]["_value"], "task one");
        assert_eq!(q.body["hits"][0]["_id"], "d_0");
        assert_eq!(q.body["hits"][0]["_path"], "/a.md");
        assert_eq!(q.body["consumer"], "collect");
        let c = s.call(
            "query",
            json!({ "query": "blocks count { where text(\"hello\") }" }),
        );
        assert_eq!(c.body["count"], 1);
        // 5.0: `_path` is the attribute; a projection landing on the
        // envelope must be aliased.
        let ok = s.call(
            "query",
            json!({ "query": "from docs where _path == \"a.md\"" }),
        );
        assert!(!ok.is_error, "{}", ok.body);
        assert_eq!(ok.body["hits"][0]["_id"], "d_0");
        let bad = s.call("query", json!({ "query": "select _path: layer from docs" }));
        assert!(bad.is_error);
        assert_eq!(bad.body["error"], "filter_invalid");
        assert_eq!(
            bad.body["message"],
            "projection `_path` collides with the hit envelope — alias it (`p: …`)"
        );
        let sem = s.call(
            "query",
            json!({ "query": "from docs where semantic(\"x\") > 0.5" }),
        );
        assert_eq!(sem.body["error"], "provider_unavailable");
        assert_eq!(sem.body["data"], json!({ "provider": null }));
        let outline = s.call("docs_outline", json!({ "_path": "a.md" }));
        let text = outline.body["text"].as_str().unwrap();
        assert!(text.starts_with("b_0 h1   Title  §"), "{text}");
        assert!(text.contains("☐ task one"));
        let missing = s.call("docs_read", json!({ "_path": "nope.md" }));
        assert_eq!(missing.body["error"], "doc_missing");
        assert_eq!(
            missing.body["message"],
            "no document with _id or _path \"nope.md\""
        );
        assert_eq!(missing.body["data"], json!({ "_path": "nope.md" }));
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
        let read = s.call("docs_read", json!({ "_path": "a.md" }));
        assert_eq!(read.body["_raw"], "# T\n\nOne.\n\nTwo.\n\nThree.\n");
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
        let read = s.call("docs_read", json!({ "_path": "a.md" }));
        assert_eq!(read.body["_raw"], "# T\n\nThree.\n\nOne.\n\nTwo.\n\n");
        // The preview (`plan`, or the CLI's seam) still runs the CAS.
        let dry = s.call(
            "plan",
            json!({ "effects": [{ "op": "move", "targets": [{ "kind": "block", "_id": "b_1" }], "into": { "kind": "document", "_path": "a.md" }, "at": "start", "expect": { "parent_children_hash": "00" } }] }),
        );
        assert_eq!(dry.body["error"], "stale_expectation", "{}", dry.body);
        let dry = s
            .preview_call(
                "blocks_move",
                &json!({ "blocks": ["b_1"], "to": "a.md", "at": "start", "expect": { "parent_children_hash": "00" } }),
            )
            .unwrap_err();
        assert_eq!(dry.code, "stale_expectation");
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
        assert_eq!(many.body["items"][0]["_path"], "/a.md");
        assert_eq!(many.body["truncated"], true);
        let one = s.call(
            "docs_read_many",
            json!({ "docs": ["b.md"], "budget_tokens": 1 }),
        );
        assert_eq!(one.body["items"].as_array().unwrap().len(), 1);
        assert_eq!(one.body["truncated"], false);
        let nodes = s.call(
            "blocks_read_many",
            json!({ "_ids": ["b_zzz", "b_1", "b_2"], "resolution": "full", "budget_tokens": 1 }),
        );
        assert_eq!(
            nodes.body["nodes"].as_array().unwrap().len(),
            1,
            "{}",
            nodes.body
        );
        assert_eq!(nodes.body["nodes"][0]["_id"], "b_1");
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
        let dry = s
            .preview_call(
                "blocks_insert",
                &json!({ "to": "a.md", "markdown": "Two." }),
            )
            .unwrap();
        assert!(dry.get("committed").is_none(), "a Plan: {dry}");
        assert_eq!(
            dry["new_ids"],
            json!([{ "symbol": "$new.0", "kind": "block" }])
        );
        assert_eq!(fired.get(), 1, "a preview never fires the hook");
        let plan = s.call("plan", json!({ "effects": [{ "op": "insert", "into": { "kind": "document", "_path": "a.md" }, "markdown": "Two." }] }));
        assert_eq!(
            plan.body["plan_id"], dry["plan_id"],
            "the preview IS the plan"
        );
        assert_eq!(fired.get(), 1, "`plan` never fires the hook");
        let wet = s.call("blocks_insert", json!({ "to": "a.md", "markdown": "Two." }));
        assert!(!wet.is_error, "{}", wet.body);
        assert_eq!(fired.get(), 2);
        // The Receipt (4.0), the preview's symbol realized.
        assert_eq!(wet.body["plan_id"], dry["plan_id"]);
        assert_eq!(wet.body["committed"], true);
        assert_eq!(wet.body["commit"], "c_1");
        assert_eq!(wet.body["new_ids"], json!({ "$new.0": "b_2" }));
        assert_eq!(wet.body["revisions"][0]["_path"], "/a.md");
        assert!(wet.body.get("results").is_none() && wet.body.get("diffs").is_none());
        let read = s.call("docs_read", json!({ "_id": "d_0" }));
        assert_eq!(read.body["_raw"], "# T\n\nOne.\n\nTwo.\n");
        let upd = s.call(
            "blocks_update",
            json!({ "_id": "b_1", "markdown": "One, edited." }),
        );
        assert!(!upd.is_error, "{}", upd.body);
        assert!(
            upd.body.get("_id").is_none() && upd.body.get("ids").is_none(),
            "{}",
            upd.body
        );
        assert_eq!(upd.body["revisions"].as_array().map(Vec::len), Some(1));
        let attrs = s.call(
            "blocks_update",
            json!({ "_id": "b_1", "attrs": { "checked": true } }),
        );
        assert_eq!(
            attrs.body["message"],
            "`attrs` is no longer an argument — pass `checked` (blocks_update takes _id, checked?, expect?, markdown?, repo?)"
        );
        let dry = s.call(
            "blocks_update",
            json!({ "_id": "b_1", "markdown": "x", "dry_run": true }),
        );
        assert_eq!(
            dry.body["message"],
            "`dry_run` is no longer an argument — preview with `plan { effects: [...] }` (blocks_update takes _id, checked?, expect?, markdown?, repo?)"
        );
        let nothing = s.call("blocks_update", json!({ "_id": "b_1" }));
        assert_eq!(
            nothing.body["message"],
            "pass `markdown` and/or `checked` (blocks_update takes _id, checked?, expect?, markdown?, repo?)"
        );
        // (5.0) the bare `id` is refused — never an alias — with the fix.
        let bare = s.call("blocks_update", json!({ "id": "b_1", "markdown": "x" }));
        assert_eq!(
            bare.body["message"],
            "`id` is not an argument — the engine field is `_id` (the bare namespace is the user's); pass `_id` (blocks_update takes _id, checked?, expect?, markdown?, repo?)"
        );
        assert_eq!(bare.body["data"]["fix"], r#"{"_id":"b_1","markdown":"x"}"#);
        let app = s.call(
            "docs_append",
            json!({ "_path": "a.md", "section": "T", "text": "Three." }),
        );
        assert!(!app.is_error, "{}", app.body);
        let amb = s.call(
            "docs_append",
            json!({ "_path": "a.md", "section": "Nope", "text": "x" }),
        );
        assert_eq!(amb.body["error"], "parent_missing");
        assert_eq!(amb.body["message"], "no heading \"Nope\" in /a.md");
        // blocks_append: a heading's section, a leaf is block_not_container.
        let into = s.call("blocks_append", json!({ "_id": "b_0", "text": "Four." }));
        assert!(!into.is_error, "{}", into.body);
        let leaf = s.call("blocks_append", json!({ "_id": "b_1", "text": "x" }));
        assert_eq!(leaf.body["error"], "block_not_container", "{}", leaf.body);
        // The fix (4.4): the sibling insert under the leaf's parent — the
        // document itself for a top-level leaf.
        assert_eq!(
            leaf.body["data"],
            json!({ "_id": "b_1", "_type": "paragraph", "fix": "blocks_insert {\"at\":{\"after\":\"b_1\"},\"markdown\":\"x\",\"to\":\"/a.md\"}" })
        );
        let hist = s.call("blocks_history", json!({ "_id": "b_1" }));
        let entries = hist.body.as_array().unwrap();
        assert!(entries.len() >= 2, "{}", hist.body);
        assert_eq!(entries[0]["origin"], "api", "newest first");
        let du = s.call("docs_diff_unified", json!({ "_path": "a.md" }));
        assert!(!du.is_error, "{}", du.body);
        assert!(du.body["diff"].as_str().unwrap().contains("+Four."));
    }

    /// The document operations (§4, 4.0): each answers with the Receipt —
    /// `docs_move` adding `dangling`/`retargeted` — and previews through
    /// `plan` (the CLI's seam runs the tool's own checks): a create `"" →
    /// bytes`, a move two entries + the rewritten sources, a delete `bytes →
    /// ""`, a meta patch before → after; a preview commits nothing, fires no
    /// hook and burns no id.
    #[test]
    fn doc_tools_return_receipts_and_preview_through_plan() {
        use std::cell::Cell;
        use std::rc::Rc;
        let fired = Rc::new(Cell::new(0));
        let f2 = Rc::clone(&fired);
        let mut s = surface().with_mutation_hook(move || f2.set(f2.get() + 1));
        let b_src = "# B\n\nTarget.\n";
        let a_src = "# A\n\nSee [b](b.md).\n";
        let b = s.call("docs_create", json!({ "path": "b.md", "markdown": b_src }));
        assert!(!b.is_error, "{}", b.body);
        assert_eq!(
            b.body,
            json!({ "plan_id": b.body["plan_id"], "commit": "c_0", "revisions": [{ "_id": "d_0", "_path": "/b.md", "_hash": b.body["revisions"][0]["_hash"] }], "new_ids": { "$new.0": "d_0", "$new.1": "b_0", "$new.2": "b_1" }, "committed": true, "summary": ["create /b.md (2 blocks)"] }),
            "the created document is revisions[0], its symbols the document then its blocks"
        );
        let a = s.call("docs_create", json!({ "path": "a.md", "markdown": a_src }));
        assert_eq!(a.body["new_ids"]["$new.0"], "d_1", "{}", a.body);
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

        // docs_create preview: `""` → the composed file; the `d_` is a symbol.
        let c = s
            .preview_call(
                "docs_create",
                &json!({ "path": "c.md", "markdown": "# C", "frontmatter": { "title": "C" } }),
            )
            .unwrap();
        assert_eq!(
            c["preview"]["diffs"],
            json!({ "/c.md": { "before": "", "after": "---\ntitle: C\n---\n\n# C\n" } })
        );
        assert_eq!(c["preview"]["revisions"][0]["_id"], "$new.0");
        assert_eq!(
            c["new_ids"],
            json!([{ "symbol": "$new.0", "kind": "document" }, { "symbol": "$new.1", "kind": "block" }])
        );

        // docs_move preview with retarget_inbound: the rewritten source, the
        // old path emptied, the new path filled — the planner's order.
        let m = s
            .preview_call(
                "docs_move",
                &json!({ "_path": "b.md", "to_path": "notes/b.md", "retarget_inbound": true }),
            )
            .unwrap();
        assert_eq!(
            keys(&m["preview"]["diffs"]),
            ["/a.md", "/b.md", "/notes/b.md"]
        );
        assert_eq!(
            m["preview"]["diffs"]["/a.md"],
            json!({ "before": a_src, "after": "# A\n\nSee [b](notes/b.md).\n" })
        );
        assert_eq!(
            m["preview"]["diffs"]["/b.md"],
            json!({ "before": b_src, "after": "" })
        );
        assert_eq!(
            m["preview"]["diffs"]["/notes/b.md"],
            json!({ "before": "", "after": b_src })
        );
        assert!(
            m.get("dangling").is_none(),
            "a preview is the Plan alone: {m}"
        );
        // … and with `retarget_inbound: false`: two entries.
        let plain = s
            .preview_call(
                "docs_move",
                &json!({ "_path": "b.md", "to_path": "notes/b.md", "retarget_inbound": false }),
            )
            .unwrap();
        assert_eq!(keys(&plain["preview"]["diffs"]), ["/b.md", "/notes/b.md"]);

        // docs_delete preview: the file → `""`.
        let d = s
            .preview_call("docs_delete", &json!({ "_path": "a.md" }))
            .unwrap();
        assert_eq!(
            d["preview"]["diffs"],
            json!({ "/a.md": { "before": a_src, "after": "" } })
        );

        // docs_set_meta preview: before → after.
        let sm = s
            .preview_call(
                "docs_set_meta",
                &json!({ "_path": "a.md", "set": { "status": "open" } }),
            )
            .unwrap();
        assert_eq!(
            sm["preview"]["diffs"],
            json!({ "/a.md": { "before": a_src, "after": "---\nstatus: open\n---\n\n# A\n\nSee [b](b.md).\n" } })
        );

        // Nothing committed, no hook, no row changed, no id burned; the
        // checks still run; `dry_run` is a retired name.
        assert_eq!(fired.get(), 2, "previews never fire the mutation hook");
        assert_eq!(snapshot(&s), before);
        let taken = s.preview_call("docs_create", &json!({ "path": "a.md", "markdown": "x" }));
        assert_eq!(taken.unwrap_err().code, "path_taken");
        let missing = s.preview_call("docs_delete", &json!({ "_path": "nope.md" }));
        assert_eq!(missing.unwrap_err().code, "doc_missing");
        let dry = s.call("docs_delete", json!({ "_path": "a.md", "dry_run": true }));
        assert_eq!(
            dry.body["message"],
            "`dry_run` is no longer an argument — preview with `plan { effects: [...] }` (docs_delete takes _id?, _path?, repo?)"
        );
        let real = s.call(
            "docs_create",
            json!({ "path": "c.md", "markdown": "# C\n" }),
        );
        assert_eq!(
            real.body["new_ids"]["$new.0"], "d_2",
            "the preview burned no `d`"
        );
        assert_eq!(fired.get(), 3);

        // The committed move: the Receipt (store 17.0 D11 — the moved
        // document's revision first, then the rewritten source's), then
        // `dangling` and `retargeted`.
        let moved = s.call(
            "docs_move",
            json!({ "_path": "b.md", "to_path": "notes/b.md" }),
        );
        assert!(!moved.is_error, "{}", moved.body);
        assert_eq!(
            keys(&moved.body),
            [
                "plan_id",
                "commit",
                "revisions",
                "new_ids",
                "committed",
                "summary",
                "retargeted",
                "dangling"
            ]
        );
        assert_eq!(
            moved.body["revisions"],
            json!([
                { "_id": "d_0", "_path": "/notes/b.md", "_hash": moved.body["revisions"][0]["_hash"] },
                { "_id": "d_1", "_path": "/a.md", "_hash": moved.body["revisions"][1]["_hash"] },
            ])
        );
        assert_eq!(moved.body["dangling"], json!([]));
        assert_eq!(
            moved.body["retargeted"],
            json!({ "blocks": ["b_3"], "docs": ["d_1"] })
        );
        assert_eq!(
            s.call("docs_read", json!({ "_id": "d_0" })).body["_path"],
            "/notes/b.md"
        );
        // Opted out: the link dangles, as a link row with its source rooted.
        let back = s.call(
            "docs_move",
            json!({ "_path": "notes/b.md", "to_path": "b.md", "retarget_inbound": false }),
        );
        // 17.0 (D11): a move alone is still a revision of the moved document.
        assert_eq!(
            back.body["revisions"],
            json!([{ "_id": "d_0", "_path": "/b.md", "_hash": back.body["revisions"][0]["_hash"] }]),
            "{}",
            back.body
        );
        assert_eq!(
            back.body["dangling"],
            json!([{ "_doc_id": "d_1", "_path": "/a.md", "_block_id": "b_3", "target": "notes/b.md", "_anchor": null }])
        );
        assert_eq!(back.body["retargeted"], Json::Null);
        // A set_meta and a delete: Receipts; the delete has no revision.
        let sm = s.call(
            "docs_set_meta",
            json!({ "_path": "a.md", "set": { "status": "open" } }),
        );
        assert_eq!(
            sm.body["revisions"].as_array().map(Vec::len),
            Some(1),
            "{}",
            sm.body
        );
        assert_eq!(sm.body["committed"], true);
        let d = s.call("docs_delete", json!({ "_path": "a.md" }));
        assert_eq!(d.body["revisions"], json!([]), "{}", d.body);
        assert!(d.body["commit"].is_string());
        assert_eq!(
            s.call("docs_read", json!({ "_path": "a.md" })).body["error"],
            "doc_missing"
        );
    }

    #[test]
    fn change_summaries_are_rooted_like_the_reference_renders_them() {
        use omgbase_store::{ChangesPage, CommitDigest, DigestRevision, FeedEntryKind};
        let rev = |path: &str, kind: FeedEntryKind, from: Option<&str>| DigestRevision {
            doc: "d_0".into(),
            path: path.into(),
            hash: Some("ff".into()),
            kind,
            from_path: from.map(str::to_owned),
        };
        let digest = |origin: &str, actor: Option<&str>, revisions: Vec<DigestRevision>, counts| {
            CommitDigest {
                commit: "c_0".into(),
                seq: 1,
                ts: "t".into(),
                origin: origin.into(),
                actor: actor.map(str::to_owned),
                batch_id: "c_0".into(),
                plan_id: None,
                summary: String::new(),
                counts,
                revisions,
            }
        };
        let page = root_changes_page(ChangesPage {
            digests: vec![
                digest(
                    "observed",
                    None,
                    vec![
                        rev("a.md", FeedEntryKind::Created, None),
                        rev("b/c.md", FeedEntryKind::Changed, None),
                    ],
                    Some(vec![("edited".into(), 1), ("inserted".into(), 3)]),
                ),
                digest(
                    "observed",
                    None,
                    vec![rev("a.md", FeedEntryKind::Deleted, None)],
                    None,
                ),
                digest(
                    "api",
                    Some("human:spec"),
                    vec![
                        rev("b/a.md", FeedEntryKind::Moved, Some("a.md")),
                        rev("index.md", FeedEntryKind::Changed, None),
                    ],
                    Some(vec![("edited".into(), 31), ("same".into(), 2)]),
                ),
            ],
            cursor: 3,
            epoch: "ep_0".into(),
            oldest: 1,
            head: 3,
            truncated: false,
        });
        assert_eq!(
            page["digests"][0]["summary"],
            "observed: /a.md — created; /b/c.md — changed — 1 edited, 3 inserted"
        );
        assert_eq!(page["digests"][0]["revisions"][0]["_path"], "/a.md");
        assert_eq!(page["digests"][1]["summary"], "observed: deleted /a.md");
        assert_eq!(
            page["digests"][2]["summary"],
            "api(human:spec): moved /a.md → /b/a.md; /index.md — changed — 31 edited"
        );
        assert_eq!(page["digests"][2]["revisions"][0]["from_path"], "/a.md");
        assert_eq!(page["digests"][2]["revisions"][0]["kind"], "moved");
        assert_eq!(page["epoch"], "ep_0");
        assert_eq!(page["oldest"], 1);
    }

    /// `spec/surface` §4 (4.5): `plan` returns `preview.diffs` only on
    /// `diffs: true`; the preview is otherwise identical and `plan_id` the
    /// same either way (the digest is over the core).
    #[test]
    fn plan_returns_diffs_only_on_request() {
        let mut s = surface();
        let out = s.call(
            "observe",
            json!({ "path": "a.md", "content": "# A\n\nOne.\n" }),
        );
        assert!(!out.is_error, "{}", out.body);
        let effects = json!([{ "op": "insert", "into": "/a.md", "markdown": "Two." }]);
        let bare = s.call("plan", json!({ "effects": effects }));
        assert!(!bare.is_error, "{}", bare.body);
        assert!(bare.body["preview"].get("diffs").is_none(), "{}", bare.body);
        assert!(bare.body["preview"].get("summary").is_some());
        let with = s.call("plan", json!({ "effects": effects, "diffs": true }));
        assert_eq!(
            with.body["preview"]["diffs"]["/a.md"]["after"],
            "# A\n\nOne.\n\nTwo.\n"
        );
        assert_eq!(with.body["plan_id"], bare.body["plan_id"]);
        let mut p = with.body["preview"].as_object().unwrap().clone();
        p.remove("diffs");
        assert_eq!(Json::Object(p), bare.body["preview"]);
        let off = s.call("plan", json!({ "effects": effects, "diffs": false }));
        assert!(off.body["preview"].get("diffs").is_none());
    }

    /// `spec/surface` §4 "Arguments" (4.5): a bare string in a string-list
    /// slot reaches the handler as a one-element list; a comma-joined one is
    /// refused with the split call as its `fix`.
    #[test]
    fn string_list_arguments_take_one_bare_string() {
        let mut s = surface();
        for (path, content) in [("a.md", "# A\n\nOne.\n"), ("b.md", "# B\n")] {
            let out = s.call("observe", json!({ "path": path, "content": content }));
            assert!(!out.is_error, "{}", out.body);
        }
        let one = s.call("docs_read_many", json!({ "docs": "a.md" }));
        assert!(!one.is_error, "{}", one.body);
        assert_eq!(one.body["items"][0]["_path"], "/a.md");
        let ids = s.call("blocks_read_many", json!({ "_ids": "b_1" }));
        assert_eq!(ids.body["nodes"][0]["_id"], "b_1");
        let roots = s.call("graph", json!({ "roots": "a.md", "degrees": 0 }));
        assert_eq!(roots.body["roots"], json!(["d_0"]));
        let joined = s.call(
            "docs_read_many",
            json!({ "docs": "a.md, b.md", "include_ids": true }),
        );
        assert!(joined.is_error);
        assert_eq!(joined.body["error"], "filter_invalid");
        assert_eq!(
            joined.body["data"]["fix"],
            r#"{"docs":["a.md","b.md"],"include_ids":true}"#
        );
    }

    /// `spec/mutate` §8 (3.4): the shape fixes reach the catalog's plain
    /// `effects` path — the anchor fix reads the block's live row.
    #[test]
    fn plain_shape_errors_carry_their_fix() {
        let mut s = surface();
        let out = s.call(
            "observe",
            json!({ "path": "a.md", "content": "# A\n\n- one\n  - nested\n" }),
        );
        assert!(!out.is_error, "{}", out.body);
        for tool in ["plan", "apply"] {
            let e = s.call(tool, json!({ "effects": [{ "op": "insert", "into": { "kind": "block", "_id": "b_3" }, "at": "after", "markdown": "x" }] }));
            assert!(e.is_error, "{tool}: {}", e.body);
            assert_eq!(e.body["error"], "filter_invalid");
            assert_eq!(
                e.body["data"]["fix"],
                r#"{"effects":[{"at":{"after":"b_3"},"into":{"_id":"b_2","kind":"block"},"markdown":"x","op":"insert"}]}"#,
                "{tool}"
            );
        }
        let e = s.call("plan", json!({ "effects": [{ "op": "set", "target": { "kind": "block", "_id": "b_1" }, "field": "text", "value": "x" }] }));
        assert_eq!(
            e.body["data"]["fix"],
            r#"{"effects":[{"field":"markdown","op":"set","target":{"_id":"b_1","kind":"block"},"value":"x"}]}"#
        );
    }
}
