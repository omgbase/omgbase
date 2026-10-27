//! The surface spec conformance runner: executes every fixture under
//! `spec/surface/cases` against this crate — the corpus-backed query suites
//! through [`omgbase_surface::query`] over one store per suite (the corpus
//! observed with the fixture minter, `spec/store` §9.4), each query run
//! BOTH planned (the tier-3 pushdown) and purely in memory, which must agree
//! (§1: a planner is invisible), `reads.json` as observation scripts whose
//! `read` steps call the catalog in-process ([`Surface::call`]),
//! `examples.json` (4.3) as a corpus-backed reads script — the example rungs
//! of the minimal tools' descriptions, which a test below re-extracts from
//! the catalog's text and pins against the suite's steps — `profiles.json`
//! (4.3) as each catalog profile's listing, and `cursor.json` through the
//! cursor codec — and compares each outcome to the case's `expect`.
//! `interop.json` (§7) is run by the `omgbase` binary's `tests/interop.rs`;
//! here its top-level shape is validated and its cases are skipped. The
//! fixture contract is `spec/surface/README.md` §6; the reference runner this
//! mirrors is `packages/core/corpus/surface/spec.test.ts`.
//!
//! Allowlist (`tests/spec-passing.txt`, one `<file-stem>::<name>` per line):
//! while the port is incomplete it names the cases that must pass. A listed
//! case that fails, an unlisted case that passes, or a listed id that no
//! longer exists all fail the build. If the file is absent, every case must
//! pass. Promote cases by rewriting the list to the currently passing set:
//!
//! ```text
//! SURFACE_SPEC_UPDATE=1 cargo test -p omgbase-surface --test spec
//! ```

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use omgbase_git_adapter::{GitHistoryProvider, fixture_identity};
use omgbase_reconcile::Config;
use omgbase_store::Composition;
use omgbase_store::manifest::{NATIVE_PROVIDER, provider_config_of, read_capability};
use omgbase_store::{
    BatchItem, BatchOutcome, Capabilities, ExportOptions, RetentionOptions, SequentialMinter, Store,
};
use omgbase_surface::dates;
use omgbase_surface::{
    MINIMAL_TOOLS, OqxResult, Profile, QueryOptions, Surface, SurfaceError, decode_cursor,
    encode_cursor, query,
};
use serde_json::{Map as JsonMap, Value as Json, json};

const SPEC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/surface");
const CASES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/surface/cases");
const PASSING_FILE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/spec-passing.txt");
/// A wrong `CASES_DIR` must not pass by finding some other, smaller directory.
const MIN_CASE_FILES: usize = 3;
const MAX_REPORT_LINES: usize = 400;
const EPS: f64 = 1e-9;
/// The repo every case runs in (`spec/store` §9.4 "Inputs").
const FIXTURE_REPO_SLUG: &str = "fixture";
/// When the corpus of a query suite is observed (§6).
const CORPUS_TS: &str = "2026-09-27T00:00:00.000Z";
/// §4 "Descriptions" (4.3): the clock a writing rung of `examples.json` runs
/// under (the reference's `EXAMPLES_TS`), so the suite's commits are
/// deterministic.
const EXAMPLES_TS: &str = "2026-10-13T00:00:00.000Z";
/// The one case of `examples.json` (the reference's `EXAMPLES_CASE`).
const EXAMPLES_CASE: &str = "ladders";

const PASSING_HEADER: &str = "\
# Surface spec cases (spec/surface/cases) that the Rust port must pass, one
# `<file-stem>::<name>` id per line, sorted. Maintained by tests/spec.rs:
# a listed case failing fails the build; an unlisted case passing also fails
# the build (add it here). Regenerate from the currently passing set with
#
#     SURFACE_SPEC_UPDATE=1 cargo test -p omgbase-surface --test spec
#
# When every case passes, delete this file (the runner then requires all).
";

// ---- fixture shape -----------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Query,
    Reads,
    Cursor,
    /// §7 cross-engine interop: shape-checked here, run by `crates/omgbase`.
    Interop,
    /// 4.3: the description ladders as a corpus-backed reads script.
    Examples,
    /// 4.3: each catalog profile's tool names in registration order; one
    /// synthetic case per profile (`profiles::full`, `profiles::minimal`).
    Profiles,
}

#[derive(Debug)]
struct SpecCase {
    id: String,
    kind: Kind,
    case: Json,
}

#[derive(Debug)]
struct SpecFile {
    stem: String,
    kind: Kind,
    /// The suite's corpus (query suites only): `path → source`, bytewise by path.
    corpus: Vec<(String, String)>,
    cases: Vec<SpecCase>,
}

struct Loaded {
    file_names: Vec<String>,
    files: Vec<SpecFile>,
    problems: Vec<String>,
}

fn validate(file: &str, doc: &Json) -> Result<SpecFile, Vec<String>> {
    let stem = file.trim_end_matches(".json");
    let mut problems = Vec::new();
    let Some(obj) = doc.as_object() else {
        return Err(vec![format!("{file}: not an object")]);
    };
    if obj.get("suite").and_then(Json::as_str) != Some(stem) {
        problems.push(format!(
            "{file}: `suite` must equal the file stem '{stem}' (got {:?})",
            obj.get("suite")
        ));
    }
    let kind = match stem {
        "cursor" => Kind::Cursor,
        "reads" => Kind::Reads,
        "interop" => Kind::Interop,
        "examples" => Kind::Examples,
        "profiles" => Kind::Profiles,
        s if s.starts_with("query-") => Kind::Query,
        _ => {
            problems.push(format!("{file}: unknown suite"));
            return Err(problems);
        }
    };
    if kind == Kind::Interop && !obj.get("corpus").is_some_and(Json::is_object) {
        problems.push(format!(
            "{file}: the interop suite carries a `corpus` object"
        ));
    }
    if kind == Kind::Profiles {
        return validate_profiles(file, stem, obj, problems);
    }
    let mut corpus = Vec::new();
    if matches!(kind, Kind::Query | Kind::Examples) {
        match obj.get("corpus").and_then(Json::as_object) {
            Some(c) if !c.is_empty() => {
                for (path, source) in c {
                    match source.as_str() {
                        Some(s) => corpus.push((path.clone(), s.to_owned())),
                        None => problems.push(format!("{file}: corpus[{path}] must be a string")),
                    }
                }
                corpus.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            }
            _ => problems.push(format!(
                "{file}: a corpus-backed suite carries a non-empty `corpus`"
            )),
        }
    }
    let cases = match obj.get("cases").and_then(Json::as_array) {
        Some(cases) if !cases.is_empty() => cases,
        _ => {
            problems.push(format!("{file}: `cases` must be a non-empty array"));
            return Err(problems);
        }
    };
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(cases.len());
    for (i, c) in cases.iter().enumerate() {
        let at = format!("{file}#{i}");
        let Some(cobj) = c.as_object() else {
            problems.push(format!("{at}: not an object"));
            continue;
        };
        let name = match cobj.get("name").and_then(Json::as_str) {
            Some(n) if !n.is_empty() => {
                if !seen.insert(n.to_owned()) {
                    problems.push(format!("{at}: duplicate name '{n}'"));
                }
                n.to_owned()
            }
            _ => {
                problems.push(format!("{at}: missing `name`"));
                String::new()
            }
        };
        match kind {
            Kind::Query => {
                if !cobj.get("query").is_some_and(Json::is_string) {
                    problems.push(format!("{at}: `query` must be a string"));
                }
            }
            Kind::Reads | Kind::Examples => {
                if !cobj
                    .get("steps")
                    .and_then(Json::as_array)
                    .is_some_and(|s| !s.is_empty())
                {
                    problems.push(format!("{at}: `steps` must be a non-empty array"));
                }
            }
            Kind::Cursor => {
                if !(cobj.contains_key("parts") || cobj.contains_key("cursor")) {
                    problems.push(format!("{at}: a cursor case has `parts` or `cursor`"));
                }
            }
            // Only the top-level shape is this runner's business (§7).
            Kind::Interop => continue,
            Kind::Profiles => unreachable!("validated above"),
        }
        if !cobj.contains_key("expect") {
            problems.push(format!(
                "{at}: missing `expect` (run SURFACE_SPEC_UPDATE=1)"
            ));
        }
        out.push(SpecCase {
            id: format!("{stem}::{name}"),
            kind,
            case: c.clone(),
        });
    }
    if problems.is_empty() {
        Ok(SpecFile {
            stem: stem.to_owned(),
            kind,
            corpus,
            cases: out,
        })
    } else {
        Err(problems)
    }
}

/// README §6 (4.3): `profiles.json` is `{ suite: "profiles", profiles: {
/// full: [names…], minimal: [names…] } }` — distinct names, `minimal` ⊆
/// `full`, exactly those two keys in that order; one case per profile.
fn validate_profiles(
    file: &str,
    stem: &str,
    obj: &JsonMap<String, Json>,
    mut problems: Vec<String>,
) -> Result<SpecFile, Vec<String>> {
    if let Some(extra) = obj
        .keys()
        .find(|k| !["suite", "profiles"].contains(&k.as_str()))
    {
        problems.push(format!("{file}: unknown top-level key {extra}"));
    }
    let Some(profiles) = obj.get("profiles").and_then(Json::as_object) else {
        problems.push(format!(
            "{file}: `profiles` must be an object (profile → tool names)"
        ));
        return Err(problems);
    };
    if profiles.keys().map(String::as_str).collect::<Vec<_>>() != ["full", "minimal"] {
        problems.push(format!(
            "{file}: `profiles` has exactly the keys full, minimal (in that order)"
        ));
    }
    let mut lists: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (name, list) in profiles {
        let Some(names) = list
            .as_array()
            .and_then(|l| l.iter().map(Json::as_str).collect::<Option<Vec<_>>>())
            .filter(|l| l.iter().all(|t| !t.is_empty()))
        else {
            problems.push(format!(
                "{file}: profiles.{name} must be an array of tool names"
            ));
            continue;
        };
        if names.iter().collect::<BTreeSet<_>>().len() != names.len() {
            problems.push(format!("{file}: profiles.{name} repeats a name"));
        }
        lists.insert(name, names);
    }
    if let (Some(full), Some(minimal)) = (lists.get("full"), lists.get("minimal")) {
        for t in minimal {
            if !full.contains(t) {
                problems.push(format!(
                    "{file}: profiles.minimal names {t}, which profiles.full does not"
                ));
            }
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(SpecFile {
        stem: stem.to_owned(),
        kind: Kind::Profiles,
        corpus: Vec::new(),
        cases: profiles
            .iter()
            .map(|(name, tools)| SpecCase {
                id: format!("{stem}::{name}"),
                kind: Kind::Profiles,
                case: json!({ "name": name, "tools": tools }),
            })
            .collect(),
    })
}

/// The fixtures live in the monorepo, outside this crate, and are not shipped
/// in the published package: built on its own (or before the fixtures land),
/// every conformance test skips.
fn spec_available() -> bool {
    if Path::new(CASES_DIR).is_dir() {
        return true;
    }
    eprintln!("spec: fixtures not present at {CASES_DIR}; skipping");
    false
}

fn load() -> Loaded {
    let dir = Path::new(CASES_DIR);
    let mut file_names: Vec<String> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|entry| {
            entry
                .expect("readable directory entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".json"))
        .collect();
    file_names.sort();
    let mut files = Vec::new();
    let mut problems = Vec::new();
    for name in &file_names {
        let text = match fs::read_to_string(dir.join(name)) {
            Ok(t) => t,
            Err(e) => {
                problems.push(format!("{name}: {e}"));
                continue;
            }
        };
        let doc: Json = match serde_json::from_str(&text) {
            Ok(d) => d,
            Err(e) => {
                problems.push(format!("{name}: {e}"));
                continue;
            }
        };
        match validate(name, &doc) {
            Ok(f) => files.push(f),
            Err(found) => problems.extend(found),
        }
    }
    Loaded {
        file_names,
        files,
        problems,
    }
}

// ---- helpers ----------------------------------------------------------------------

/// A fresh store with the capabilities `OMGBASE_CAPABILITIES` names (Phase
/// 2's gate: `core` runs every case without the semantic bundle).
fn fresh_store() -> Store {
    fresh_store_with(None)
}

/// [`fresh_store`] with the git history provider attached over `git_root`
/// (README §7.3, Phase 6a): on a composition that attaches it (`full`, `git`)
/// a case that drives the provider gets it under the fixture identity
/// `omgbase <omgbase@fixture>` (`spec/store` §9.4), so every sha the outcomes
/// carry is pinned.
fn fresh_store_with(git_root: Option<&Path>) -> Store {
    let mut capabilities = Capabilities::standard_from_env().expect("OMGBASE_CAPABILITIES");
    if let Some(root) = git_root
        && composition().has_git_provider()
    {
        capabilities = capabilities.with_provider(Box::new(GitHistoryProvider::new(
            root.to_path_buf(),
            fixture_identity(),
        )));
    }
    Store::open_in_memory_with_capabilities(Box::new(SequentialMinter::new()), capabilities)
        .expect("in-memory store")
}

// ---- the composition ledger (README §7.3, `spec/store` §9.6; modular-core Phase 5a) --------------------
//
// `OMGBASE_CAPABILITIES` names one of the plan's four compositions — `core`,
// `history`, `semantic`, `full` (the default) — and this runner opens its stores
// through `Capabilities::standard_from_env()`, so the SAME scripts run on the
// composition named and the runner decides, per case, whether it is compared
// as recorded, compared through a MAPPING keyed on the module the composition
// lacks (the mapping lives here, never in a fixture), or SKIPPED because the
// case needs the absent module. One machine-readable line at the end —
// `[<suite> spec] composition=<name>: compared=<n> mapped=<n> skipped=<n>` —
// is what `pnpm conformance` (`scripts/conformance.mjs`) collects into the
// suite × composition matrix; the reference's `corpus/composition.ts`.

/// The composition this process runs under (`OMGBASE_CAPABILITIES`, default `full`).
fn composition() -> Composition {
    Composition::from_env().expect("OMGBASE_CAPABILITIES")
}

/// One runner's ledger: `compared` = cases compared exactly as recorded,
/// `mapped` = cases compared through a composition mapping (with a note of
/// what moved), `skipped` = cases not run because they need an absent module
/// (with the reason).
struct Ledger {
    suite: &'static str,
    composition: Composition,
    compared: Vec<String>,
    mapped: Vec<String>,
    skipped: Vec<String>,
}

impl Ledger {
    fn new(suite: &'static str) -> Self {
        Self {
            suite,
            composition: composition(),
            compared: Vec::new(),
            mapped: Vec::new(),
            skipped: Vec::new(),
        }
    }

    /// A case compared: `mapped` names what the mapping changed (`None` = compared as recorded).
    fn record(&mut self, id: &str, mapped: Option<&str>) {
        match mapped {
            Some(m) => self.mapped.push(format!("{id} ({m})")),
            None => self.compared.push(id.to_owned()),
        }
    }

    fn skip(&mut self, id: &str, reason: &str) {
        self.skipped.push(format!("{id} — {reason}"));
    }

    /// A `<X>_SPEC_UPDATE` under a reduced composition would record that composition's answers: refused.
    fn refuse_update(&self, update: bool, env_var: &str) {
        assert!(
            !(update && self.composition != Composition::Full),
            "{env_var} under OMGBASE_CAPABILITIES={} would record the {} composition's answers; run it on the full one",
            self.composition,
            self.composition
        );
    }

    /// The line (+ the mapped and skipped lists under a reduced composition), to stderr.
    fn report(&self) {
        let mut text = format!(
            "[{} spec] composition={}: compared={} mapped={} skipped={}\n",
            self.suite,
            self.composition,
            self.compared.len(),
            self.mapped.len(),
            self.skipped.len()
        );
        if self.composition != Composition::Full {
            for m in &self.mapped {
                text.push_str(&format!("  mapped {m}\n"));
            }
            for s in &self.skipped {
                text.push_str(&format!("  skip {s}\n"));
            }
        }
        eprint!("{text}");
    }
}

/// What the composition carries — the key of every mapping below (the
/// reference's `CompositionFlags`): the mappings are keyed on the MODULE the
/// composition lacks, never on its name.
#[derive(Clone, Copy, Debug)]
struct Flags {
    history: bool,
    semantic: bool,
}

impl Flags {
    fn of(c: Composition) -> Self {
        Self {
            history: c.has_history(),
            semantic: c.has_semantic(),
        }
    }
}

/// README §7.3: a query case's expectation on a composition without the
/// semantic module — the runner-level "needs an embedding provider"
/// (`filter_invalid`) becomes the capability error (the reference's
/// `compositionQueryExpect`). Returns the case with its `expect` mapped and
/// whether it was.
fn composition_query_case(case: &Json, flags: Flags) -> (Json, bool) {
    let expect = &case["expect"];
    let needle = expect.get("message_includes").and_then(Json::as_str);
    if !flags.semantic
        && expect.get("error").and_then(Json::as_str) == Some("filter_invalid")
        && needle.is_some_and(|m| m.contains("embedding provider"))
    {
        let mut out = case.clone();
        out["expect"] = json!({ "error": "capability_unavailable", "message_includes": needle });
        return (out, true);
    }
    (case.clone(), false)
}

/// `spec/store` §9.4 (17.1): the instant every fixture repository is born —
/// before every authored `ts`, so the manifest's coverage covers the whole
/// script; what `sync_status.capabilities.coverage_from` reads on the wire.
const FIXTURE_BIRTH: &str = "2000-01-01T00:00:00.000Z";

/// `spec/store` §9.4 (Phase 4a/4b): the lifecycle steps a reads script may
/// carry; (Phase 6a) the git provider's steps.
const LIFECYCLE_STEP_KINDS: [&str; 8] = [
    "history_enable",
    "history_disable",
    "history_purge",
    "recorder_fault",
    "git_checkpoint",
    "git_log",
    "git_tree",
    "git_fault",
];

/// README §7.3 (6.4, Phase 6a): does the case drive the git history provider
/// (a `history_enable` naming `provider: "git"`, a `git_*` step) — run on
/// `full` and `git` as recorded, skipped elsewhere?
fn is_git_case(c: &Json) -> bool {
    c["steps"].as_array().is_some_and(|steps| {
        steps.iter().any(|s| {
            ["git_checkpoint", "git_log", "git_tree", "git_fault"]
                .iter()
                .any(|k| s.get(*k).is_some())
                || s.get("history_enable")
                    .and_then(|e| e.get("provider"))
                    .and_then(Json::as_str)
                    .is_some_and(|p| p != NATIVE_PROVIDER)
        })
    })
}

/// README §6 (6.2 — `spec/store` §5.10, Phase 4b): the surface's own `embed`
/// lifecycle devices: `embed_enable { ts, provider? }` sets
/// `embedding.provider` at the workspace layer when given (directly, as the
/// fixture's device — no settings-write refresh) then runs `embed enable` at
/// `ts`; `embed_disable { ts }` runs `embed disable`. Outcome `{ semantic: {
/// state, coverage, provider, changed } }` or `{ error: "provider_unavailable",
/// message }` for an enable with no provider. Need the semantic module:
/// skipped without it (README §7.3).
const EMBED_STEP_KINDS: [&str; 2] = ["embed_enable", "embed_disable"];

/// The history capability's `version`/`sync_status` answer on a composition
/// without the history module (Phase 4a): no module, so `unavailable`; a
/// repository it created has no coverage and requires nothing.
fn core_history_state() -> Json {
    json!({ "state": "unavailable", "provider": "native", "coverage_from": null, "writer_requires": false, "completeness": "every" })
}

/// Does the query text reach the `revisions` root or the `_revisions`
/// relation (whose rows are the recorder's)?
fn touches_revisions(query: &str) -> bool {
    let bytes = query.as_bytes();
    let mut from = 0;
    while let Some(pos) = query[from..].find("revisions") {
        let end = from + pos + "revisions".len();
        if bytes
            .get(end)
            .is_none_or(|c| !(c.is_ascii_alphanumeric() || *c == b'_'))
        {
            return true;
        }
        from = end;
    }
    false
}

/// Is the outcome a history read refused by a composition without the
/// history module (`capability_unavailable { history, unavailable }`)?
fn is_history_unavailable(o: &Json) -> bool {
    o.get("error").and_then(Json::as_str) == Some("capability_unavailable")
        && o.get("data").is_some_and(|d| {
            d.get("capability") == Some(&json!("history"))
                && d.get("state") == Some(&json!("unavailable"))
        })
}

/// README §7.3 (Phase 2 → 4a → 5a): a reads case's expectation under a
/// reduced composition, step by step against what the run answered — the
/// reference's `compositionReadsExpect`, keyed on `flags`. WITHOUT the
/// semantic module: every `provider_unavailable { provider: null }` outcome
/// becomes the semantic capability error (`capability_unavailable { semantic,
/// disabled }`, byte for byte). WITHOUT the history module (the composition
/// has no recorder): a step the run answered `capability_unavailable {
/// history, unavailable }` is accepted as such, a `sync_status` reads the
/// core history state, a `version` shape reads `coverage_from` as `<null>`,
/// and a `query` that reaches `revisions` is accepted when the run returned
/// rows (the root lists what the recorder holds — nothing here). The mapping
/// lives in the RUNNER, keyed on the composition it runs under, never in the
/// fixture. Returns the expectation and how many step outcomes were rewritten.
fn composition_expectation(
    expect: &Json,
    steps: &[Json],
    actual: &[Json],
    flags: Flags,
) -> (Json, usize) {
    let mut out = expect.clone();
    let mut mapped = 0usize;
    if let Some(items) = out.get_mut("steps").and_then(Json::as_array_mut) {
        for (i, o) in items.iter_mut().enumerate() {
            let read = steps.get(i).and_then(|s| s.get("read"));
            let got = actual.get(i);
            if !flags.history
                && let (Some(read), Some(got)) = (read, got)
            {
                let tool = read.get("tool").and_then(Json::as_str).unwrap_or("");
                if is_history_unavailable(got) {
                    mapped += 1;
                    *o = got.clone();
                    continue;
                }
                if tool == "sync_status" && o.get("capabilities").is_some() {
                    mapped += 1;
                    o["capabilities"]["history"] = core_history_state();
                    continue;
                }
                if tool == "version"
                    && o.get("capabilities")
                        .and_then(|c| c.get("history"))
                        .is_some()
                {
                    mapped += 1;
                    o["capabilities"]["history"]["coverage_from"] = json!("<null>");
                    continue;
                }
                if tool == "query"
                    && read
                        .get("args")
                        .and_then(|a| a.get("query"))
                        .and_then(Json::as_str)
                        .is_some_and(touches_revisions)
                    && got.get("hits").is_some_and(Json::is_array)
                {
                    mapped += 1;
                    *o = got.clone();
                    continue;
                }
            }
            if !flags.semantic {
                rewrite_semantic_pins(o, &mut mapped);
            }
        }
    }
    (out, mapped)
}

/// Every `provider_unavailable { provider: null }` under `v` becomes the
/// semantic capability error (counted in `mapped`).
fn rewrite_semantic_pins(v: &mut Json, mapped: &mut usize) {
    match v {
        Json::Object(o) => {
            if o.get("error").and_then(Json::as_str) == Some("provider_unavailable")
                && o.get("data") == Some(&json!({ "provider": null }))
            {
                *mapped += 1;
                *o = json!({
                    "error": "capability_unavailable",
                    "retriable": false,
                    "data": {
                        "capability": "semantic",
                        "state": "disabled",
                        "fix": omgbase_surface::SEMANTIC_DISABLED_FIX,
                    },
                })
                .as_object()
                .cloned()
                .expect("object");
                return;
            }
            for x in o.values_mut() {
                rewrite_semantic_pins(x, mapped);
            }
        }
        Json::Array(a) => {
            for x in a {
                rewrite_semantic_pins(x, mapped);
            }
        }
        _ => {}
    }
}

/// `spec/store` §9.4's outcome shape for an observe step.
fn outcome_json(o: &BatchOutcome) -> Json {
    match o {
        BatchOutcome::Deleted(d) => {
            json!({ "path": d.path, "deleted": d.doc_id.is_some(), "doc": d.doc_id })
        }
        // `spec/store` §9.4 (Phase 4a): a member rolled back because its capture failed.
        BatchOutcome::Failed(f) => {
            json!({ "path": f.path, "failed": true, "doc": f.doc_id, "error": f.error })
        }
        BatchOutcome::Observed(o) => json!({
            "path": o.path, "echo": o.echo, "doc": o.doc_id, "commit": o.commit_id, "rev": o.rev,
            "converged": o.converged, "conflicted": o.conflicted,
            "dispositions": o.dispositions.iter().map(|(k, n)| (k.clone(), json!(n))).collect::<JsonMap<_, _>>(),
        }),
    }
}

fn config_from(overrides: Option<&Json>) -> Result<Config, String> {
    let mut c = Config::default();
    let Some(obj) = overrides.and_then(Json::as_object) else {
        return Ok(c);
    };
    for (k, v) in obj {
        let num = || {
            v.as_f64()
                .ok_or_else(|| format!("config.{k} must be a number"))
        };
        let count = || {
            v.as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| format!("config.{k} must be a non-negative integer"))
        };
        match k.as_str() {
            "matcher_v" => {
                c.matcher_v = v
                    .as_str()
                    .ok_or("config.matcher_v must be a string")?
                    .to_owned()
            }
            "theta_accept" => c.theta_accept = num()?,
            "theta_small" => c.theta_small = num()?,
            "small_block_tokens" => c.small_block_tokens = count()?,
            "context_sim_floor" => c.context_sim_floor = num()?,
            "children_vouch_frac" => c.children_vouch_frac = num()?,
            "split_coverage" => c.split_coverage = num()?,
            "split_dominant_share" => c.split_dominant_share = num()?,
            "copy_sim" => c.copy_sim = num()?,
            "bulk_unmatched_frac" => c.bulk_unmatched_frac = num()?,
            "bulk_min_blocks" => c.bulk_min_blocks = count()?,
            "max_scored_blocks" => c.max_scored_blocks = count()?,
            "theta_xdoc" => c.theta_xdoc = num()?,
            other => return Err(format!("unknown config key {other}")),
        }
    }
    Ok(c)
}

// ---- query suites -------------------------------------------------------------------

/// One store per suite: the corpus observed once (`spec/store` §9.4 minter,
/// one batch in path order at [`CORPUS_TS`]); queries are read-only.
fn corpus_store(corpus: &[(String, String)]) -> Result<(Store, String), String> {
    let mut store = fresh_store();
    let repo = store
        .create_repo_at(FIXTURE_REPO_SLUG, FIXTURE_BIRTH)
        .map_err(|e| e.to_string())?;
    let items: Vec<BatchItem> = corpus
        .iter()
        .map(|(p, s)| BatchItem::observed(p, s))
        .collect();
    store
        .observe_batch(&repo, &items, CORPUS_TS, &Config::default())
        .map_err(|e| e.to_string())?;
    Ok((store, repo))
}

thread_local! {
    /// Wall time spent in the query suites' cases: (planned, in-memory).
    static QUERY_TIME: RefCell<(Duration, Duration)> = const { RefCell::new((Duration::ZERO, Duration::ZERO)) };
}

/// One `query` through the runner, planned or purely in memory, timed.
fn run_once(
    store: &Store,
    repo: &str,
    c: &Json,
    in_memory: bool,
) -> Result<Result<OqxResult, SurfaceError>, String> {
    let source = c["query"].as_str().ok_or("query")?;
    // The case's arguments ARE the `query` tool's (README §6), so a corrected
    // call (4.11, `fix`) is spelled from them exactly as the tool spells it.
    let mut request = JsonMap::new();
    request.insert("query".to_owned(), json!(source));
    for key in ["limit", "cursor", "bare"] {
        if let Some(v) = c.get(key) {
            request.insert(key.to_owned(), v.clone());
        }
    }
    let request = Json::Object(request);
    let opts = QueryOptions {
        limit: c.get("limit").and_then(Json::as_u64).map(|n| n as usize),
        cursor: c.get("cursor").and_then(Json::as_str),
        provider: None,
        in_memory,
        bare: c.get("bare").and_then(Json::as_bool).unwrap_or(false),
        unknown_names: None,
        vocabulary: None,
        // README §6 (4.8): a query case runs under the corpus clock — the
        // reference pins `CORPUS_TS` around every run, so `date("today")`
        // is `2026-09-27` (a Sunday) in both engines.
        now_ms: Some(dates::stamp_ms(CORPUS_TS)),
        request: Some(&request),
    };
    let started = Instant::now();
    let out = query(store, repo, source, opts);
    let took = started.elapsed();
    QUERY_TIME.with(|t| {
        let mut t = t.borrow_mut();
        if in_memory {
            t.1 += took;
        } else {
            t.0 += took;
        }
    });
    Ok(out)
}

/// The reference's `runQueryCase`: the case runs planned AND purely in
/// memory; the two must agree (result or error, `spec/surface` §1 — the
/// planner is invisible), and the planned outcome is what `expect` pins.
fn run_query_case(store: &Store, repo: &str, c: &Json) -> Result<(), String> {
    let planned = run_once(store, repo, c, false)?;
    let memory = run_once(store, repo, c, true)?;
    match (&planned, &memory) {
        (Ok(p), Ok(m)) => {
            if let Some(diff) = deep_eq_tol(&p.to_json(), &m.to_json(), "planned", EPS) {
                return Err(clip(format!("planned != in-memory: {diff}")));
            }
        }
        (Err(p), Err(m)) => {
            if p.code != m.code || p.message != m.message || error_fix(p) != error_fix(m) {
                return Err(clip(format!(
                    "planned error {} {:?} != in-memory error {} {:?}",
                    p.code, p.message, m.code, m.message
                )));
            }
        }
        (Ok(p), Err(m)) => {
            return Err(clip(format!(
                "planned returned a result but in-memory failed ({} {}): {}",
                m.code,
                m.message,
                p.to_json()
            )));
        }
        (Err(p), Ok(m)) => {
            return Err(clip(format!(
                "planned failed ({} {}) but in-memory returned a result: {}",
                p.code,
                p.message,
                m.to_json()
            )));
        }
    }
    let expect = &c["expect"];
    match planned {
        Ok(res) => {
            if let Some(code) = expect.get("error") {
                return Err(clip(format!(
                    "expected error {code}, got a result {}",
                    res.to_json()
                )));
            }
            match deep_eq_tol(&res.to_json(), expect, "expect", EPS) {
                None => Ok(()),
                Some(diff) => Err(clip(diff)),
            }
        }
        Err(e) => {
            let Some(code) = expect.get("error").and_then(Json::as_str) else {
                return Err(clip(format!("unexpected error {}: {}", e.code, e.message)));
            };
            if e.code != code {
                return Err(clip(format!(
                    "error code {} (expected {code}): {}",
                    e.code, e.message
                )));
            }
            if let Some(needle) = expect.get("message_includes").and_then(Json::as_str)
                && !e.message.contains(needle)
            {
                return Err(clip(format!(
                    "message {:?} does not include {needle:?}",
                    e.message
                )));
            }
            // (4.11) the corrected call, recorded verbatim — equal on both
            // sides, absent on both sides. The reference records `fix` for a
            // `filter_invalid` alone (a capability refusal's `data.fix` is the
            // envelope's, not the corrected call), so only that code compares it.
            let expected_fix = expect.get("fix").and_then(Json::as_str);
            let actual_fix = (e.code == "filter_invalid")
                .then(|| error_fix(&e))
                .flatten();
            if actual_fix != expected_fix {
                return Err(clip(format!(
                    "fix {actual_fix:?} (expected {expected_fix:?})"
                )));
            }
            Ok(())
        }
    }
}

/// A query error's `data.fix` (`spec/surface` §4 "Error data", 4.11).
fn error_fix(e: &SurfaceError) -> Option<&str> {
    e.data.as_ref()?.get("fix")?.as_str()
}

// ---- cursor.json ------------------------------------------------------------------

fn run_cursor_case(c: &Json) -> Result<Json, String> {
    if let Some(parts) = c.get("parts").and_then(Json::as_array) {
        let parts: Vec<&str> = parts.iter().filter_map(Json::as_str).collect();
        return Ok(json!({ "cursor": encode_cursor(&parts) }));
    }
    let cursor = c["cursor"].as_str().ok_or("cursor")?;
    let arity = c
        .get("arity")
        .and_then(Json::as_u64)
        .map_or(2, |n| n as usize);
    Ok(match decode_cursor(cursor, "spec", arity) {
        Ok(parts) => json!({ "parts": parts }),
        Err(e) => json!({ "error": e.code }),
    })
}

// ---- reads.json -------------------------------------------------------------------

/// A scratch directory that is removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let unique = format!(
            "omgbase-surface-spec-{}-{}-{}",
            std::process::id(),
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        );
        let dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&dir).expect("temp dir");
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// README §6: a `version` read is recorded by shape — leaves → `"<string>"` /
/// `"<number>"` / `"<null>"` / `"<boolean>"`; objects keep their keys, arrays
/// their length; the top-level `components` is one `"<object>"`, `mcp.sdk` is
/// dropped, and the top-level `commit`/`built` — null or not by build
/// environment (a git checkout or not), which no fixture can pin — are one
/// token either way, `"<string|null>"` (the reference runner's `typeShape`).
fn type_shape(v: &Json, path: &[String]) -> Json {
    let child = |k: &str| {
        let mut p = path.to_vec();
        p.push(k.to_owned());
        p
    };
    match v {
        Json::Null => json!("<null>"),
        Json::Bool(_) => json!("<boolean>"),
        Json::Number(_) => json!("<number>"),
        Json::String(_) => json!("<string>"),
        Json::Array(items) => Json::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, x)| type_shape(x, &child(&i.to_string())))
                .collect(),
        ),
        Json::Object(_) if path == ["components"] => json!("<object>"),
        Json::Object(m) => Json::Object(
            m.iter()
                .filter(|(k, _)| !(path == ["mcp"] && *k == "sdk"))
                .map(|(k, x)| {
                    let shape = if path.is_empty() && (k == "commit" || k == "built") {
                        json!("<string|null>")
                    } else {
                        type_shape(x, &child(k))
                    };
                    (k.clone(), shape)
                })
                .collect(),
        ),
    }
}

/// `spec/cli/VERSION`: the CLI spec the workspace's binary renders.
fn cli_spec_version() -> String {
    fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../spec/cli/VERSION"
    ))
    .expect("spec/cli/VERSION")
    .trim()
    .to_owned()
}

/// README §6: an error whose `data` names the argument it could not honor
/// (`id`, `path`, `doc_id`, `doc_path`, `ref`, `section`, `provider`,
/// `plan_id`, `epoch` — the last is `expired_cursor`'s, 6.0) or an
/// argument-shape error (`hint: "arguments"`) is the surface's own; its
/// message is pinned.
fn surface_composed(data: Option<&Json>) -> bool {
    let Some(o) = data.and_then(Json::as_object) else {
        return false;
    };
    if o.get("hint").and_then(Json::as_str) == Some("arguments") {
        return true;
    }
    [
        "_id", "_path", "_doc_id", "doc_path", "ref", "section", "provider", "plan_id", "epoch",
    ]
    .iter()
    .any(|k| o.contains_key(*k))
}

/// The fixture's view of an outcome: an error envelope without its
/// `message` (and without `data` for `filter_invalid`, save a `fix` — 4.5); `changes_since`
/// digests without `summary`; a `version` result by shape (§6).
fn normalize_outcome(tool: &str, out: &omgbase_surface::ToolOutcome) -> Json {
    let mut body = out.body.clone();
    if out.is_error {
        if let Some(o) = body.as_object_mut() {
            // README §6: the surface's own errors keep their message (both
            // engines spell them alike); a kernel's or store's does not.
            if !surface_composed(o.get("data")) {
                o.remove("message");
            }
            // (4.5) a `filter_invalid`'s `data` restates the message — except
            // its `fix`, a corrected call both engines must compose alike:
            // recorded as `data: { fix }`.
            if o.get("error").and_then(Json::as_str) == Some("filter_invalid") {
                let fix = o
                    .get("data")
                    .and_then(|d| d.get("fix"))
                    .filter(|f| f.is_string())
                    .cloned();
                o.remove("data");
                if let Some(fix) = fix {
                    o.insert("data".to_owned(), json!({ "fix": fix }));
                }
            }
        }
    } else if tool == "version" {
        return type_shape(&body, &[]);
    } else if tool == "changes_since"
        && let Some(digests) = body.get_mut("digests").and_then(Json::as_array_mut)
    {
        for d in digests {
            if let Some(o) = d.as_object_mut() {
                o.remove("summary");
            }
        }
    }
    body
}

/// README §6: a `reads` case over a fresh store (and a workspace directory
/// when `workspace`); an `examples` case (4.3) the same, after the suite's
/// corpus is observed as one batch in bytewise path order at `CORPUS_TS` (so
/// `d_0` is `index.md`, as in every corpus-backed suite) and mirrored into
/// the workspace, since the ladders write.
fn run_reads_case(c: &Json, corpus: Option<&[(String, String)]>) -> Result<Json, String> {
    let config = config_from(c.get("config"))?;
    let workspace = c.get("workspace").and_then(Json::as_bool).unwrap_or(false);
    let name = c["name"].as_str().unwrap_or("case");
    let temp = workspace.then(|| TempDir::new(name));
    // Phase 6a: a case that drives the git provider needs a workspace directory
    // for its bare repository — the working tree's `.omgbase` when there is
    // one (the shape of a real workspace), else a directory of its own.
    let git_root: Option<TempDir> =
        (is_git_case(c) && !workspace).then(|| TempDir::new(&format!("{name}-git")));
    let git_dir: Option<&Path> = if is_git_case(c) {
        Some(
            temp.as_ref()
                .or(git_root.as_ref())
                .map(|t| t.0.as_path())
                .expect("a git root"),
        )
    } else {
        None
    };
    if let Some(root) = git_dir {
        fs::create_dir_all(root.join(".omgbase")).map_err(|e| e.to_string())?;
    }
    let mut store = fresh_store_with(git_dir);
    // README §6 (6.4): `capabilities: { history: false }` creates the repository
    // with capture off (as `spec/store` §9.4's), the state a `history_enable {
    // provider: "git" }` needs on the full composition.
    let history = c
        .get("capabilities")
        .and_then(|caps| caps.get("history"))
        .and_then(Json::as_bool)
        .unwrap_or(true);
    let repo_id = store
        .create_repo_with(FIXTURE_REPO_SLUG, FIXTURE_BIRTH, history)
        .map_err(|e| e.to_string())?;
    if let Some(dir) = &temp {
        omgbase_sync::registry::register_fs_source(
            &mut store,
            &repo_id,
            FIXTURE_REPO_SLUG,
            &dir.0.to_string_lossy(),
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(corpus) = corpus {
        let items: Vec<BatchItem> = corpus
            .iter()
            .map(|(p, s)| BatchItem::observed(p, s))
            .collect();
        store
            .observe_batch(&repo_id, &items, CORPUS_TS, &config)
            .map_err(|e| format!("corpus: {e}"))?;
        if let Some(dir) = &temp {
            for (path, source) in corpus {
                let file = dir.0.join(path);
                if let Some(parent) = file.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(&file, source).map_err(|e| e.to_string())?;
            }
        }
    }
    let clock: Rc<RefCell<String>> = Rc::new(RefCell::new(CORPUS_TS.to_owned()));
    let tick = Rc::clone(&clock);
    // The runner is this surface's host: like the reference's library
    // embedding it has no build (commit/built null) but does render a CLI
    // spec, so `specs.cli` is a string in both engines' recordings.
    let build = omgbase_surface::BuildInfo {
        cli_spec: Some(cli_spec_version()),
        ..omgbase_surface::BuildInfo::default()
    };
    let mut surface = Surface::new(store, &repo_id, None)
        .with_config(config.clone())
        .with_clock(move || tick.borrow().clone())
        .with_build_info(build);

    // `spec/store` §9.4 (15.0): the retention steps around the reads that show
    // `archived` and `revision_archived`; the segments go to a directory of
    // the case's own, removed with it.
    let mut archives: Option<TempDir> = None;
    let mut steps = Vec::new();
    for (i, step) in c["steps"].as_array().ok_or("steps")?.iter().enumerate() {
        if let Some(kind) = HISTORY_STEP_KINDS.iter().find(|k| step.get(**k).is_some()) {
            let dir = archives.get_or_insert_with(|| TempDir::new(&format!("{name}-archives")));
            let out = run_history_step(surface.store_mut(), &repo_id, kind, &step[*kind], &dir.0)
                .map_err(|e| format!("step {i}: {e}"))?;
            steps.push(out);
        } else if let Some(kind) = LIFECYCLE_STEP_KINDS
            .iter()
            .find(|k| step.get(**k).is_some())
        {
            // `spec/store` §9.4 (Phase 4a): `history_disable` / `history_enable`
            // around the reads — the D3 states on the wire.
            let body = &step[*kind];
            let out = match *kind {
                "history_enable" => {
                    let ts = body["ts"].as_str().ok_or("history_enable.ts")?;
                    *clock.borrow_mut() = ts.to_owned();
                    let writer_requires = body
                        .get("writer_requires")
                        .and_then(Json::as_bool)
                        .unwrap_or(true);
                    // `spec/store` §9.4 (Phase 6a): `provider: "git"` with `branch?` / `cadence?`.
                    let provider = body
                        .get("provider")
                        .and_then(Json::as_str)
                        .filter(|p| *p != NATIVE_PROVIDER);
                    let mut options = JsonMap::new();
                    for k in ["branch", "cadence"] {
                        if let Some(v) = body.get(k) {
                            options.insert(k.to_owned(), v.clone());
                        }
                    }
                    match surface.store_mut().enable_history_with(
                        &repo_id,
                        ts,
                        writer_requires,
                        provider,
                        &options,
                    ) {
                        Ok(r) => json!({ "history": r.to_json() }),
                        Err(e @ omgbase_store::Error::HistoryProviderConflict { .. }) => {
                            json!({ "history": { "error": e.to_string() } })
                        }
                        Err(e) => return Err(format!("step {i}: {e}")),
                    }
                }
                "history_disable" => {
                    let ts = body["ts"].as_str().ok_or("history_disable.ts")?;
                    *clock.borrow_mut() = ts.to_owned();
                    let r = surface
                        .store_mut()
                        .disable_history(&repo_id, ts)
                        .map_err(|e| format!("step {i}: {e}"))?;
                    json!({ "history": {
                        "state": r.row.state.as_str(),
                        "coverage": r.row.coverage.iter().map(|c| json!({ "from": c.from, "to": c.to })).collect::<Vec<_>>(),
                        "writer_requires": r.row.writer_requires,
                        "changed": r.changed,
                    } })
                }
                // `spec/store` §9.4 (Phase 4b; §7.6): `history purge [--before]` → the receipt;
                // (Phase 6a) `provider: { name, removed }` on a git-provider repository.
                "history_purge" => {
                    let ts = body["ts"].as_str().ok_or("history_purge.ts")?;
                    *clock.borrow_mut() = ts.to_owned();
                    let before = body.get("before").and_then(Json::as_str);
                    let r = surface
                        .store_mut()
                        .purge_history_at(&repo_id, before, ts)
                        .map_err(|e| format!("step {i}: {e}"))?;
                    let mut out = r.to_json();
                    if let Some(p) = &r.provider {
                        out["provider"] = json!({ "name": p.name, "removed": p.removed });
                    }
                    json!({ "purge": out })
                }
                // `spec/store` §9.4 (Phase 6a; §5.12): the worker once — the receipt or its error.
                "git_checkpoint" => {
                    let ts = body["ts"].as_str().ok_or("git_checkpoint.ts")?;
                    *clock.borrow_mut() = ts.to_owned();
                    match surface.store().history_checkpoint(&repo_id, ts) {
                        Ok(r) => json!({ "checkpoint": r.to_json() }),
                        Err(e) => json!({ "checkpoint": { "error": e.to_string() } }),
                    }
                }
                "git_log" | "git_tree" => {
                    let store = surface.store();
                    let row = read_capability(store.conn(), &repo_id, "history")
                        .map_err(|e| format!("step {i}: {e}"))?;
                    let branch = row
                        .as_ref()
                        .and_then(|r| r.config.get("branch"))
                        .and_then(Json::as_str)
                        .unwrap_or("omgbase")
                        .to_owned();
                    let attached = store.providers().iter().any(|p| p.name() == "git");
                    let git = match (&row, git_dir) {
                        (Some(row), Some(root)) if attached => Some(
                            GitHistoryProvider::new(root.to_path_buf(), fixture_identity())
                                .git_repo(&provider_config_of(row)),
                        ),
                        _ => None,
                    };
                    let text = |args: &[&str]| -> Result<String, String> {
                        match &git {
                            Some(g) if g.exists() => g.text(args).map_err(|e| e.to_string()),
                            _ => Ok(String::new()),
                        }
                    };
                    if *kind == "git_log" {
                        json!({ "git_log": text(&["log", "--reverse", "--format=%H%n%s%n%(trailers)", &format!("refs/heads/{branch}")])? })
                    } else {
                        json!({ "git_tree": text(&["ls-tree", "-r", &format!("refs/heads/{branch}")])? })
                    }
                }
                "git_fault" => {
                    let fail = body["fail"].as_bool().ok_or("git_fault.fail")?;
                    omgbase_store::set_armed_fault(fail.then_some(omgbase_store::ArmedFault {
                        site: omgbase_store::FaultSite::GitCommit,
                        nth: 1,
                    }));
                    omgbase_store::reset_faults();
                    json!({ "fault": fail })
                }
                _ => {
                    return Err(format!(
                        "step {i}: the recorder fault device (spec/store §9.4) is the store runner's"
                    ));
                }
            };
            steps.push(out);
        } else if let Some(kind) = EMBED_STEP_KINDS.iter().find(|k| step.get(**k).is_some()) {
            let body = &step[*kind];
            let ts = body["ts"].as_str().ok_or("embed step ts")?;
            *clock.borrow_mut() = ts.to_owned();
            let store = surface.store_mut();
            let outcome = |r: omgbase_store::SemanticLifecycleResult| -> Result<Json, String> {
                let provider = omgbase_store::semantic_provider_of(store.conn(), &repo_id)
                    .map_err(|e| e.to_string())?;
                Ok(json!({ "semantic": r.to_json(provider.as_deref()) }))
            };
            let out = if *kind == "embed_enable" {
                if let Some(provider) = body.get("provider").and_then(Json::as_str) {
                    // The device writes the workspace layer directly: a settings
                    // write would refresh the row at the wall clock.
                    let current: Option<String> =
                        rusqlite::OptionalExtension::optional(store.conn().query_row(
                            "SELECT settings FROM workspace_settings WHERE id = 0",
                            [],
                            |r| r.get::<_, String>(0),
                        ))
                        .map_err(|e| e.to_string())?;
                    let mut settings = current
                        .and_then(|t| serde_json::from_str::<Json>(&t).ok())
                        .and_then(|v| v.as_object().cloned())
                        .unwrap_or_default();
                    let mut embedding = settings
                        .get("embedding")
                        .and_then(Json::as_object)
                        .cloned()
                        .unwrap_or_default();
                    embedding.insert("provider".to_owned(), json!(provider));
                    settings.insert("embedding".to_owned(), Json::Object(embedding));
                    store
                        .conn()
                        .execute(
                            "INSERT INTO workspace_settings (id, settings) VALUES (0, ?1) ON CONFLICT(id) DO UPDATE SET settings = excluded.settings",
                            [Json::Object(settings).to_string()],
                        )
                        .map_err(|e| e.to_string())?;
                }
                match store.enable_semantic(&repo_id, ts) {
                    Ok(r) => outcome(r)?,
                    Err(e @ omgbase_store::Error::SemanticProviderMissing) => {
                        json!({ "error": "provider_unavailable", "message": e.to_string() })
                    }
                    Err(e) => return Err(format!("step {i}: {e}")),
                }
            } else {
                outcome(
                    store
                        .disable_semantic(&repo_id, ts)
                        .map_err(|e| format!("step {i}: {e}"))?,
                )?
            };
            steps.push(out);
        } else if let Some(observe) = step.get("observe") {
            let ts = observe["ts"].as_str().ok_or("observe.ts")?;
            *clock.borrow_mut() = ts.to_owned();
            let items: Vec<BatchItem> = observe["items"]
                .as_array()
                .ok_or("observe.items")?
                .iter()
                .map(|it| BatchItem {
                    path: it["path"].as_str().unwrap_or_default().to_owned(),
                    source: it["source"].as_str().map(str::to_owned),
                })
                .collect();
            if let Some(dir) = &temp {
                for it in &items {
                    let file = dir.0.join(&it.path);
                    match &it.source {
                        Some(s) => {
                            if let Some(parent) = file.parent() {
                                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                            }
                            fs::write(&file, s).map_err(|e| e.to_string())?;
                        }
                        None => {
                            let _ = fs::remove_file(&file);
                        }
                    }
                }
            }
            let outcomes = surface
                .store_mut()
                .observe_batch(&repo_id, &items, ts, &config)
                .map_err(|e| format!("step {i}: {e}"))?;
            steps.push(Json::Array(outcomes.iter().map(outcome_json).collect()));
        } else if let Some(sweep) = step.get("sweep") {
            let ts = sweep["ts"].as_str().ok_or("sweep.ts")?;
            let swept = surface
                .store_mut()
                .sweep_pool(ts)
                .map_err(|e| format!("step {i}: {e}"))?;
            steps.push(json!({ "swept": swept }));
        } else if let Some(gc) = step.get("gc") {
            // `spec/store` §9.4 (14.2, 17.0): the §7 collection, enabled,
            // never a dry run, `ts` the clock of the claims prune (§7.3) and
            // the feed prune (§7.4) — the runner's clock without it.
            let store = surface.store_mut();
            let r = match gc.get("ts").and_then(Json::as_str) {
                Some(ts) => store.gc_at(true, ts),
                None => store.gc(true),
            }
            .map_err(|e| format!("step {i}: {e}"))?;
            steps.push(json!({ "gc": {
                "blobs": r.blobs_swept,
                "tree_nodes": r.tree_nodes_swept,
                "same_dispositions": r.same_dispositions_swept,
                "claims_released": r.claims_released,
                "feed_pruned": r.feed_pruned,
            } }));
        } else if let Some(exec) = step.get("exec") {
            // `spec/store` §9.4 (14.2): authored SQL, verbatim, one transaction.
            let sql = exec["sql"].as_array().ok_or("exec.sql")?;
            let conn = surface.store_mut().conn();
            let tx = conn
                .unchecked_transaction()
                .map_err(|e| format!("step {i}: {e}"))?;
            let mut changes = 0usize;
            for statement in sql {
                let s = statement.as_str().ok_or("exec.sql[]")?;
                changes += tx
                    .execute(s, [])
                    .map_err(|e| format!("step {i}: {s}: {e}"))?;
            }
            tx.commit().map_err(|e| format!("step {i}: {e}"))?;
            steps.push(json!({ "changes": changes }));
        } else if let Some(read) = step.get("read") {
            let tool = read["tool"].as_str().ok_or("read.tool")?;
            let args = read.get("args").cloned().unwrap_or_else(|| json!({}));
            if let Some(ts) = read.get("ts").and_then(Json::as_str) {
                *clock.borrow_mut() = ts.to_owned();
            }
            let out = surface.call(tool, args);
            steps.push(normalize_outcome(tool, &out));
        } else if let Some(recover) = step.get("recover") {
            // README §6 (6.0): crash recovery over the case's working tree
            // under the step's clock (`spec/sync` §4.3) — the pending rows
            // replayed (the alert channel re-derived with them), the disk
            // compared to the heads; the outcome is `recover_repo`'s.
            let ts = recover["ts"].as_str().ok_or("recover.ts")?;
            if !recover
                .as_object()
                .is_some_and(|o| o.keys().all(|k| k == "ts"))
            {
                return Err(format!("step {i}: recover takes only `ts`"));
            }
            let Some(dir) = &temp else {
                return Err(format!("step {i}: a recover step needs `workspace: true`"));
            };
            *clock.borrow_mut() = ts.to_owned();
            let r = omgbase_sync::recover_repo(
                surface.store_mut(),
                &repo_id,
                &omgbase_sync::RealFileSystem,
                &dir.0,
                ts,
                &config,
            )
            .map_err(|e| format!("step {i}: {e}"))?;
            steps.push(json!({ "recovered": {
                "materialized": r.materialized,
                "healed": r.healed,
                "missing": r.missing,
            } }));
        } else {
            return Err(format!(
                "step {i}: none of observe, sweep, gc, exec, read, recover, history_*, read_at, history_enable, history_disable, history_purge, git_checkpoint, git_log, git_tree, git_fault, embed_enable, embed_disable"
            ));
        }
    }
    omgbase_store::set_armed_fault(None);
    drop(archives);
    drop(git_root);
    Ok(json!({ "steps": steps }))
}

/// `spec/store` §9.4 (15.0): the retention step kinds a reads script may carry.
const HISTORY_STEP_KINDS: [&str; 5] = [
    "history_plan",
    "history_export",
    "history_attach",
    "history_detach",
    "read_at",
];

/// The file of a segment under the case's archive directory, by id.
fn segment_file(dest: &Path, segment_id: &str) -> Result<PathBuf, String> {
    let suffix = format!("-{segment_id}.omgarchive.db");
    let found = fs::read_dir(dest)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .find(|n| n.ends_with(&suffix))
        .ok_or_else(|| format!("no segment file for {segment_id} under {}", dest.display()))?;
    Ok(dest.join(found))
}

/// `spec/store` §9.4 (15.0): the retention steps as the store runner runs
/// them, through the production paths.
fn run_history_step(
    store: &mut Store,
    repo_id: &str,
    kind: &str,
    body: &Json,
    dest: &Path,
) -> Result<Json, String> {
    let retention = |store: &Store, body: &Json| -> Result<RetentionOptions, String> {
        let now = body["ts"].as_str().ok_or("ts")?.to_owned();
        let policy = store
            .retention_policy(repo_id, body.get("policy"))
            .map_err(|e| e.to_string())?;
        Ok(RetentionOptions {
            now,
            before: body.get("before").and_then(Json::as_str).map(str::to_owned),
            policy,
        })
    };
    match kind {
        "history_plan" => {
            let opts = retention(store, body)?;
            let plan = store
                .retention_plan(repo_id, &opts)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "plan": plan.to_json() }))
        }
        "history_export" => {
            let opts = ExportOptions {
                retention: retention(store, body)?,
                dest: dest.to_path_buf(),
                prune: body["prune"].as_bool().unwrap_or(false),
            };
            let r = store
                .export_history(repo_id, &opts)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "export": {
                "segment": r.segment.as_ref().map(|s| json!({
                    "id": s.id, "seq_lo": s.seq_lo, "seq_hi": s.seq_hi,
                    "revision_count": s.revision_count, "previous_segment": s.previous_segment,
                })),
                "reused": r.reused,
                "squashed": r.squashed.map(|q| json!({
                    "revisions": q.revisions, "commits": q.commits,
                    "dispositions": q.dispositions, "block_changes": q.block_changes,
                    "checkpointed": q.checkpointed,
                })),
                "gc": r.gc.map(|g| json!({ "blobs": g.blobs, "tree_nodes": g.tree_nodes })),
            } }))
        }
        "history_attach" => {
            let file = segment_file(dest, body["segment"].as_str().ok_or("segment")?)?;
            let r = store
                .attach_archive(repo_id, &file)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "attached": r.attached.iter().map(|a| json!({
                "segment_id": a.segment_id, "seq_lo": a.seq_lo, "seq_hi": a.seq_hi,
                "revision_count": a.revision_count,
            })).collect::<Vec<_>>() }))
        }
        "history_detach" => {
            let detached = store
                .detach_archive(repo_id, body["segment"].as_str().ok_or("segment")?)
                .map_err(|e| e.to_string())?;
            Ok(json!({ "detached": detached }))
        }
        _ => {
            let doc = body["doc"].as_str().ok_or("doc")?;
            let rev = body["rev"].as_str().ok_or("rev")?;
            match store.read_at_revision(doc, rev) {
                Ok(Some(r)) => {
                    Ok(json!({ "raw": r.content, "rendered_hash_match": r.rendered_hash_match }))
                }
                Ok(None) => Ok(json!({ "error": "target_missing" })),
                Err(omgbase_store::Error::RevisionArchived { rev, archive, path }) => {
                    let mut m = serde_json::Map::new();
                    m.insert("error".to_owned(), json!("revision_archived"));
                    m.insert("rev".to_owned(), json!(rev));
                    m.insert("archive".to_owned(), json!(archive));
                    if let Some(p) = path {
                        m.insert(
                            "path".to_owned(),
                            json!(format!("<dest>/{}", omgbase_store::segment_basename(&p))),
                        );
                    }
                    Ok(Json::Object(m))
                }
                Err(e) => Err(e.to_string()),
            }
        }
    }
}

// ---- driving ------------------------------------------------------------------------

struct SuiteState<'a> {
    /// The corpus store of the suite (query suites).
    store: Option<(Store, String)>,
    /// The suite's corpus (corpus-backed suites; empty otherwise).
    corpus: &'a [(String, String)],
}

/// README §4 "Profiles" (4.3): the tool names a surface under `profile`
/// lists, in registration order, equal the suite's list for it.
fn run_profile_case(c: &Json) -> Result<(), String> {
    let name = c["name"].as_str().ok_or("name")?;
    let profile: Profile = name.parse()?;
    let want: Vec<&str> = c["tools"]
        .as_array()
        .ok_or("tools")?
        .iter()
        .filter_map(Json::as_str)
        .collect();
    let (mut store, _) = corpus_store(&[])?;
    let repo = store.create_repo("profiled").map_err(|e| e.to_string())?;
    let surface = Surface::new(store, &repo, None).with_profile(profile);
    let listed: Vec<&str> = surface.tools().iter().map(|t| t.name).collect();
    if listed != want {
        return Err(format!(
            "profile {name} lists {listed:?}, the suite pins {want:?}"
        ));
    }
    Ok(())
}

fn check(c: &SpecCase, suite: &SuiteState<'_>, ledger: &mut Ledger) -> Result<(), String> {
    let flags = Flags::of(ledger.composition);
    match c.kind {
        Kind::Query => {
            // Phase 4a: a query that reaches `revisions` reads the recorder's
            // rows — nothing without the history module; skipped and counted.
            if !flags.history && c.case["query"].as_str().is_some_and(touches_revisions) {
                ledger.skip(&c.id, "reaches the revisions root");
                return Ok(());
            }
            let (case, mapped) = composition_query_case(&c.case, flags);
            ledger.record(&c.id, mapped.then_some("semantic → capability_unavailable"));
            let (store, repo) = suite.store.as_ref().ok_or("suite store")?;
            run_query_case(store, repo, &case)
        }
        // The cursor and profile cases are outside the ledger: the reference's
        // records its query and reads cases alone (they reach no store), so the
        // cell counts the same cases in both engines.
        Kind::Cursor => {
            let actual = run_cursor_case(&c.case)?;
            deep_eq_tol(&actual, &c.case["expect"], "expect", EPS).map_or(Ok(()), |d| Err(clip(d)))
        }
        Kind::Reads | Kind::Examples => {
            // README §7.3 (6.4, Phase 6a): a case driving the git provider runs
            // where the provider is attached (`full`, `git`) and is compared as
            // recorded — no composition mapping.
            if is_git_case(&c.case) {
                if !ledger.composition.has_git_provider() {
                    ledger.skip(&c.id, "needs the git history provider");
                    return Ok(());
                }
                let corpus = (c.kind == Kind::Examples).then_some(suite.corpus);
                let actual = run_reads_case(&c.case, corpus)?;
                ledger.record(&c.id, None);
                return deep_eq_tol(&actual, &c.case["expect"], "expect", EPS)
                    .map_or(Ok(()), |d| Err(clip(d)));
            }
            // Phase 4a: a retention or lifecycle step needs the history
            // module; the embed steps the semantic one. Skipped and counted.
            let steps = c.case["steps"].as_array().cloned().unwrap_or_default();
            let has_step = |kinds: &[&str]| {
                steps
                    .iter()
                    .any(|s| kinds.iter().any(|k| s.get(*k).is_some()))
            };
            if !flags.history && (has_step(&HISTORY_STEP_KINDS) || has_step(&LIFECYCLE_STEP_KINDS))
            {
                ledger.skip(&c.id, "needs the history module");
                return Ok(());
            }
            if !flags.semantic && has_step(&EMBED_STEP_KINDS) {
                ledger.skip(&c.id, "needs the semantic module");
                return Ok(());
            }
            let corpus = (c.kind == Kind::Examples).then_some(suite.corpus);
            let actual = run_reads_case(&c.case, corpus)?;
            let got = actual["steps"].as_array().cloned().unwrap_or_default();
            let (expect, n) = composition_expectation(&c.case["expect"], &steps, &got, flags);
            let note = format!("{n} step outcome{}", if n == 1 { "" } else { "s" });
            ledger.record(&c.id, (n > 0).then_some(note.as_str()));
            deep_eq_tol(&actual, &expect, "expect", EPS).map_or(Ok(()), |d| Err(clip(d)))
        }
        Kind::Profiles => run_profile_case(&c.case),
        Kind::Interop => Err("interop cases are run by crates/omgbase/tests/interop.rs".to_owned()),
    }
}

thread_local! {
    static IN_CASE: Cell<bool> = const { Cell::new(false) };
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_owned()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".to_owned()
    }
}

fn run_case(c: &SpecCase, suite: &SuiteState<'_>, ledger: &mut Ledger) -> Result<(), String> {
    IN_CASE.with(|f| f.set(true));
    let outcome = panic::catch_unwind(AssertUnwindSafe(|| check(c, suite, ledger)));
    IN_CASE.with(|f| f.set(false));
    match outcome {
        Ok(r) => r,
        Err(payload) => Err(clip(format!("panicked: {}", panic_message(payload)))),
    }
}

// ---- allowlist ------------------------------------------------------------------

fn read_allowlist(path: &Path) -> Option<BTreeSet<String>> {
    let text = fs::read_to_string(path).ok()?;
    Some(
        text.lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(str::to_owned)
            .collect(),
    )
}

fn write_allowlist(path: &Path, ids: &BTreeSet<String>) {
    let mut text = String::from(PASSING_HEADER);
    for id in ids {
        text.push_str(id);
        text.push('\n');
    }
    fs::write(path, text).unwrap_or_else(|e| panic!("cannot write {}: {e}", path.display()));
}

fn update_requested() -> bool {
    std::env::var("SURFACE_SPEC_UPDATE").is_ok_and(|v| !v.is_empty() && v != "0")
}

fn report(title: &str, ids: &[(String, Option<String>)]) {
    if ids.is_empty() {
        return;
    }
    eprintln!("\n{title} ({}):", ids.len());
    let mut by_file: BTreeMap<&str, Vec<&(String, Option<String>)>> = BTreeMap::new();
    for item in ids {
        let stem = item.0.split("::").next().unwrap_or("");
        by_file.entry(stem).or_default().push(item);
    }
    let mut printed = 0;
    'outer: for (stem, items) in by_file {
        eprintln!("  {stem}.json:");
        for (id, reason) in items {
            if printed >= MAX_REPORT_LINES {
                eprintln!("  … {} more not shown", ids.len() - printed);
                break 'outer;
            }
            match reason {
                Some(r) => eprintln!("    {id}\n        {r}"),
                None => eprintln!("    {id}"),
            }
            printed += 1;
        }
    }
}

// ---- tests -----------------------------------------------------------------------

#[test]
fn spec() {
    if !spec_available() {
        return;
    }
    let loaded = load();
    assert!(
        loaded.problems.is_empty(),
        "fixture files are not well-formed:\n{}",
        loaded.problems.join("\n")
    );
    assert!(
        loaded.file_names.len() >= MIN_CASE_FILES,
        "found only {} case files under {CASES_DIR} (expected at least {MIN_CASE_FILES}); wrong path?",
        loaded.file_names.len()
    );

    let prev = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        if !IN_CASE.with(Cell::get) {
            prev(info);
        }
    }));

    // README §7.3: the two mappings keyed on the absent module, the skipped
    // cases counted, one ledger line for `pnpm conformance`; the fixtures are
    // never regenerated from a reduced composition.
    let mut ledger = Ledger::new("surface");
    ledger.refuse_update(update_requested(), "SURFACE_SPEC_UPDATE");
    let mut all_ids = BTreeSet::new();
    let mut passing = BTreeSet::new();
    let mut failing: Vec<(String, Option<String>)> = Vec::new();
    for file in &loaded.files {
        let suite = SuiteState {
            store: match file.kind {
                Kind::Query => match corpus_store(&file.corpus) {
                    Ok(s) => Some(s),
                    Err(e) => {
                        for c in &file.cases {
                            all_ids.insert(c.id.clone());
                            failing
                                .push((c.id.clone(), Some(format!("corpus did not observe: {e}"))));
                        }
                        continue;
                    }
                },
                _ => None,
            },
            corpus: &file.corpus,
        };
        for c in &file.cases {
            all_ids.insert(c.id.clone());
            match run_case(c, &suite, &mut ledger) {
                Ok(()) => {
                    passing.insert(c.id.clone());
                }
                Err(reason) => failing.push((c.id.clone(), Some(reason))),
            }
        }
    }
    let _ = panic::take_hook();
    ledger.report();
    QUERY_TIME.with(|t| {
        let (planned, memory) = *t.borrow();
        eprintln!(
            "spec: query cases took {planned:?} planned vs {memory:?} in memory (every case ran both ways)"
        );
    });

    let passing_path = PathBuf::from(PASSING_FILE);
    let listed = read_allowlist(&passing_path);
    let listed_count = listed.as_ref().map_or(0, BTreeSet::len);
    eprintln!(
        "spec: {} passed, {} failed, {} listed{}",
        passing.len(),
        failing.len(),
        listed_count,
        if listed.is_none() {
            " (no spec-passing.txt: every case must pass)"
        } else {
            ""
        }
    );
    assert!(
        all_ids.len() == passing.len() + failing.len(),
        "case ids are unique across files"
    );

    if update_requested() {
        let before = listed.clone().unwrap_or_default();
        let removed: Vec<(String, Option<String>)> = failing
            .iter()
            .filter(|(id, _)| before.contains(id))
            .cloned()
            .collect();
        let added = passing.difference(&before).count();
        if passing == all_ids {
            let _ = fs::remove_file(&passing_path);
            eprintln!(
                "spec: every case passes; removed {}",
                passing_path.display()
            );
        } else {
            write_allowlist(&passing_path, &passing);
            eprintln!(
                "spec: wrote {} ({} ids; +{added}, -{})",
                passing_path.display(),
                passing.len(),
                removed.len()
            );
        }
        report(
            "regressions dropped from spec-passing.txt (were listed, now fail)",
            &removed,
        );
        report("still failing (not listed)", &failing);
        return;
    }

    let Some(listed) = listed else {
        report(
            "failing cases (no spec-passing.txt: every case must pass)",
            &failing,
        );
        assert!(
            failing.is_empty(),
            "{} spec case(s) failed; see the report above (stderr)",
            failing.len()
        );
        return;
    };

    let regressions: Vec<(String, Option<String>)> = failing
        .iter()
        .filter(|(id, _)| listed.contains(id))
        .cloned()
        .collect();
    let unlisted_passing: Vec<(String, Option<String>)> = loaded
        .files
        .iter()
        .flat_map(|f| f.cases.iter())
        .filter(|c| passing.contains(&c.id) && !listed.contains(&c.id))
        .map(|c| (c.id.clone(), None))
        .collect();
    let stale: Vec<(String, Option<String>)> = listed
        .difference(&all_ids)
        .map(|id| {
            (
                id.clone(),
                Some("listed in spec-passing.txt but no such case exists".to_owned()),
            )
        })
        .collect();

    report("listed cases that FAIL (regressions)", &regressions);
    report(
        "cases that pass but are not listed in spec-passing.txt — add them (or run SURFACE_SPEC_UPDATE=1 cargo test -p omgbase-surface --test spec)",
        &unlisted_passing,
    );
    report("stale allowlist entries", &stale);
    if passing == all_ids {
        eprintln!(
            "spec: every case passes — delete tests/spec-passing.txt (or run with SURFACE_SPEC_UPDATE=1)"
        );
    }
    assert!(
        regressions.is_empty() && unlisted_passing.is_empty() && stale.is_empty(),
        "spec allowlist out of date: {} regression(s), {} unlisted passing, {} stale — see the report above (stderr); \
         promote with `SURFACE_SPEC_UPDATE=1 cargo test -p omgbase-surface --test spec`",
        regressions.len(),
        unlisted_passing.len(),
        stale.len()
    );
}

#[test]
fn fixture_files_are_well_formed_and_every_case_file_was_loaded() {
    if !spec_available() {
        return;
    }
    let loaded = load();
    assert_eq!(loaded.problems, Vec::<String>::new());
    let loaded_names: Vec<String> = loaded
        .files
        .iter()
        .map(|f| format!("{}.json", f.stem))
        .collect();
    assert_eq!(loaded_names, loaded.file_names, "every case file must load");
    for f in &loaded.files {
        assert!(
            f.kind == Kind::Interop || !f.cases.is_empty(),
            "{}.json has no cases",
            f.stem
        );
    }
}

#[test]
fn case_names_are_unique_per_file() {
    if !spec_available() {
        return;
    }
    let loaded = load();
    let mut seen = BTreeSet::new();
    for f in &loaded.files {
        for c in &f.cases {
            assert!(seen.insert(&c.id), "duplicate case id {}", c.id);
        }
    }
}

/// The §7 interop suite has its own runner (`crates/omgbase/tests/interop.rs`);
/// this one checks its top-level shape — suite name, `corpus` object, `cases`
/// with unique names — and loads it with no cases to run.
#[test]
fn interop_suite_is_shape_checked_and_skipped() {
    let doc = json!({
        "suite": "interop",
        "corpus": { "a.md": "# A\n" },
        "cases": [
            { "name": "read-tools", "reads": [{ "tool": "docs_list", "args": {} }], "expect": { "writes": [], "reads": [] } },
            { "name": "with-writes", "ts": "2026-09-27T00:00:00.000Z", "writes": [], "reads": [], "expect": { "writes": [], "reads": [] } }
        ]
    });
    let file = validate("interop.json", &doc).expect("well-formed");
    assert_eq!(file.kind, Kind::Interop);
    assert_eq!(file.stem, "interop");
    assert!(file.cases.is_empty(), "interop cases are not run here");
    assert!(file.corpus.is_empty());

    let mut dup = doc.clone();
    dup["cases"][1]["name"] = json!("read-tools");
    let problems = validate("interop.json", &dup).expect_err("duplicate names");
    assert!(
        problems.iter().any(|p| p.contains("duplicate name")),
        "{problems:?}"
    );

    let mut no_corpus = doc.clone();
    no_corpus.as_object_mut().unwrap().remove("corpus");
    let problems = validate("interop.json", &no_corpus).expect_err("corpus required");
    assert!(
        problems.iter().any(|p| p.contains("`corpus` object")),
        "{problems:?}"
    );

    let mut wrong_suite = doc.clone();
    wrong_suite["suite"] = json!("interop-x");
    assert!(validate("interop.json", &wrong_suite).is_err());

    let mut no_cases = doc;
    no_cases["cases"] = json!([]);
    assert!(validate("interop.json", &no_cases).is_err());
}

/// `spec/surface/VERSION` is the version this crate implements.
#[test]
fn version_agrees_with_the_spec() {
    let version_file = Path::new(SPEC_DIR).join("VERSION");
    if !version_file.is_file() {
        eprintln!("spec: {} not present; skipping", version_file.display());
        return;
    }
    let version = fs::read_to_string(version_file).expect("VERSION");
    assert_eq!(omgbase_surface::SPEC_VERSION, version.trim());
}

/// README §4: every tool's description is the reference's, byte for byte —
/// `spec/surface/tool-descriptions.json` (written by the reference) against
/// the generated `descriptions.rs` the catalog carries; names in order too.
#[test]
fn tool_descriptions_match_the_reference() {
    let text = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../spec/surface/tool-descriptions.json"
    ))
    .expect("spec/surface/tool-descriptions.json");
    let pinned: Json = serde_json::from_str(&text).expect("json");
    let pinned = pinned.as_object().expect("an object");
    let tools = omgbase_surface::catalog::tools();
    let names: Vec<&str> = tools.iter().map(|t| t.name).collect();
    let want: Vec<&str> = pinned.keys().map(String::as_str).collect();
    assert_eq!(names, want, "tool names and order");
    for t in &tools {
        assert_eq!(
            Some(t.description),
            pinned[t.name].as_str(),
            "description of {} drifted — run SURFACE_SPEC_UPDATE=1 on the reference, then node scripts/gen-tool-descriptions.mjs",
            t.name
        );
    }
}

// ---- the example ladders (§4 "Descriptions", 4.3) ----------------------------------------

/// One rung of a description's ladder: the call's arguments (parsed) and
/// the comment after the three spaces.
struct Rung {
    args: Json,
    comment: String,
    line: String,
}

/// The rungs of one description — the reference's `extractLadder`, rule for
/// rule: (1) only lines beginning `{` are candidates; (2) a rung is the
/// arguments as JSON, then three or more spaces, then a comment — the JSON
/// ends where the first run of three spaces begins; (3) a candidate holding
/// `…` or an angle-bracket placeholder (`<64 hex>`) is a schema line,
/// skipped (and listed).
fn extract_ladder(description: &str) -> (Vec<Rung>, Vec<String>) {
    let mut rungs = Vec::new();
    let mut skipped = Vec::new();
    for line in description.split('\n') {
        if !line.starts_with('{') {
            continue;
        }
        if line.contains('…') || has_placeholder(line) {
            skipped.push(line.to_owned());
            continue;
        }
        let (json, comment) = match line.find("   ") {
            Some(i) => (&line[..i], line[i..].trim_start_matches(' ')),
            None => (line, ""),
        };
        let args: Json = serde_json::from_str(json)
            .unwrap_or_else(|e| panic!("a rung's arguments are not JSON ({e}): {line}"));
        rungs.push(Rung {
            args,
            comment: comment.to_owned(),
            line: line.to_owned(),
        });
    }
    (rungs, skipped)
}

/// `<…>` with no `>` inside (the reference's `/<[^>]*>/`).
fn has_placeholder(line: &str) -> bool {
    line.find('<')
        .is_some_and(|open| line[open + 1..].contains('>'))
}

/// Rule 4: the suite's steps from the catalog's descriptions — tool by tool
/// in registration order, the minimal tools only, a tool's rungs in
/// description order; a write tool's steps carry the fixed clock.
fn example_steps() -> Vec<Json> {
    let mut steps = Vec::new();
    for t in omgbase_surface::catalog::tools() {
        if !MINIMAL_TOOLS.contains(&t.name) {
            continue;
        }
        for rung in extract_ladder(t.description).0 {
            let mut read = JsonMap::new();
            read.insert("tool".to_owned(), json!(t.name));
            read.insert("args".to_owned(), rung.args);
            if Surface::is_write_tool(t.name) {
                read.insert("ts".to_owned(), json!(EXAMPLES_TS));
            }
            steps.push(json!({ "read": read }));
        }
    }
    steps
}

/// README §4 "Descriptions" (4.3): every minimal tool's description is a
/// ladder — a summary line `<tool> — …`, at least one rung, a last line naming
/// `query_syntax` — whose rungs parse as the call's arguments followed by a
/// comment; and `examples.json`'s one case holds exactly the extraction,
/// bytewise (the drift gate: an example edited in the description without
/// regenerating the suite fails here, in both engines).
#[test]
fn example_ladders_are_well_formed_and_match_the_suite_bytewise() {
    let tools = omgbase_surface::catalog::tools();
    for t in tools.iter().filter(|t| MINIMAL_TOOLS.contains(&t.name)) {
        let lines: Vec<&str> = t.description.split('\n').collect();
        assert!(
            lines[0].starts_with(&format!("{} — ", t.name)),
            "{}: the first line is the summary",
            t.name
        );
        let last = lines.last().expect("a line");
        assert!(
            last.contains("query_syntax") && !last.starts_with('{'),
            "{}: the last line is prose pointing at query_syntax",
            t.name
        );
        let (rungs, skipped) = extract_ladder(t.description);
        assert!(!rungs.is_empty(), "{}: no example rung", t.name);
        for r in &rungs {
            assert!(r.args.is_object(), "{}: {}", t.name, r.line);
            assert!(
                !r.comment.is_empty(),
                "{}: a rung needs its comment — {}",
                t.name,
                r.line
            );
        }
        for s in &skipped {
            assert!(s.contains('…') || has_placeholder(s), "{}: {s}", t.name);
        }
    }
    let extracted = example_steps();
    let mut seen: Vec<&str> = Vec::new();
    for s in &extracted {
        let tool = s["read"]["tool"].as_str().unwrap();
        if seen.last() != Some(&tool) {
            seen.push(tool);
        }
    }
    let order: Vec<&str> = tools
        .iter()
        .map(|t| t.name)
        .filter(|n| MINIMAL_TOOLS.contains(n))
        .collect();
    assert_eq!(
        seen, order,
        "the ladders cover every minimal tool, in catalog order"
    );

    let path = Path::new(CASES_DIR).join("examples.json");
    if !path.is_file() {
        eprintln!(
            "spec: {} not present; skipping the drift gate",
            path.display()
        );
        return;
    }
    let file: Json =
        serde_json::from_str(&fs::read_to_string(&path).expect("examples.json")).expect("json");
    assert_eq!(file["suite"], "examples");
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(
        cases
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [EXAMPLES_CASE]
    );
    assert_eq!(cases[0]["workspace"], true);
    let pinned = serde_json::to_string_pretty(&cases[0]["steps"]).unwrap();
    let ours = serde_json::to_string_pretty(&Json::Array(extracted)).unwrap();
    assert!(
        pinned == ours,
        "spec/surface/cases/examples.json's steps drifted from the descriptions' rungs (SURFACE_SPEC_UPDATE=1 on mcp/examples.test.ts regenerates)\n--- suite\n{pinned}\n--- extracted\n{ours}"
    );
}

#[test]
fn ladder_extraction_follows_the_rung_grammar() {
    let text = "tool — Summary.\n{\"a\":1}   one\n{\"b\":\"x  y\"}    two spaces inside, four after\n{\"c\":\"<64 hex>\"}   schema\n{\"d\":[1]}   with … ellipsis\nprose { not a rung }\n{}   empty\nGrammar: query_syntax.";
    let (rungs, skipped) = extract_ladder(text);
    assert_eq!(
        rungs.iter().map(|r| r.args.clone()).collect::<Vec<_>>(),
        [json!({ "a": 1 }), json!({ "b": "x  y" }), json!({})]
    );
    assert_eq!(rungs[0].comment, "one");
    // Two spaces do not end the JSON; the first run of three or more does
    // (the reference's rule — a rung's JSON never holds one, by its own test).
    assert_eq!(rungs[1].comment, "two spaces inside, four after");
    assert_eq!(rungs[2].comment, "empty");
    assert_eq!(skipped.len(), 2);
    assert!(has_placeholder("{\"x\":\"<a>\"}") && !has_placeholder("{\"x\":\"a < b\"}"));
}

// ---- comparison ----------------------------------------------------------------------

/// Deep-compare two JSON values, object key order ignored, numbers within
/// `eps`. `None` when equal, else the path and values of the first difference.
fn deep_eq_tol(a: &Json, b: &Json, path: &str, eps: f64) -> Option<String> {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => {
            let (x, y) = (
                x.as_f64().unwrap_or(f64::NAN),
                y.as_f64().unwrap_or(f64::NAN),
            );
            if (x - y).abs() <= eps || (x.is_nan() && y.is_nan()) {
                None
            } else {
                Some(format!("{path}: {x} vs {y}"))
            }
        }
        (Json::Array(x), Json::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{path}: length {} vs {}", x.len(), y.len()));
            }
            x.iter()
                .zip(y)
                .enumerate()
                .find_map(|(i, (p, q))| deep_eq_tol(p, q, &format!("{path}[{i}]"), eps))
        }
        (Json::Object(x), Json::Object(y)) => {
            let ka: BTreeSet<&String> = x.keys().collect();
            let kb: BTreeSet<&String> = y.keys().collect();
            if ka != kb {
                return Some(format!(
                    "{path}: keys {{{}}} vs {{{}}}",
                    ka.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(","),
                    kb.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(",")
                ));
            }
            ka.into_iter()
                .find_map(|k| deep_eq_tol(&x[k], &y[k], &format!("{path}.{k}"), eps))
        }
        (Json::Array(_), _) | (_, Json::Array(_)) => Some(format!("{path}: array vs non-array")),
        (Json::Object(_), _) | (_, Json::Object(_)) => {
            Some(format!("{path}: object vs non-object"))
        }
        _ => (a != b).then(|| format!("{path}: {a} vs {b}")),
    }
}

fn clip(s: impl Into<String>) -> String {
    const MAX: usize = 400;
    let s: String = s.into();
    let s = s.replace('\n', " ");
    if s.chars().count() <= MAX {
        return s;
    }
    let cut: String = s.chars().take(MAX).collect();
    format!("{cut}…")
}
