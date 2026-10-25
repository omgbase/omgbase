//! History retention (`spec/store/README.md` §7.1 "Retention: plan, export,
//! squash", 15.0): the policy, its effective form over the repository's
//! settings, and [`evaluate_retention`] — the policy as an exact rule over one
//! repository, deterministic in the store, the policy and the clock, so both
//! engines produce the same plan and the fixtures pin it. Nothing here
//! writes: [`crate::archive`] turns a plan into a segment and a squash. Port
//! of `packages/core/src/core/store/retention.ts`.

use std::collections::{HashMap, HashSet};

use omgbase_format::hash::hex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value as Json};

use crate::error::{Error, Result};
use crate::time::{civil_from_days, parse_ms};
use crate::tree::from_hex;

pub use crate::core::history_shapes::{
    LADDER_KEEPS, LadderKeep, LadderRung, RetentionDocPlan, RetentionOptions, RetentionOverride,
    RetentionPlan, RetentionPolicy, RetentionTotals,
};

/// The settings key the policy lives under (`history.retention`).
pub const RETENTION_SETTINGS_KEY: &str = "history";
/// The repo-settings key naming the last segment this repo recorded (`history.last_segment`).
pub const LAST_SEGMENT_SETTINGS_KEY: &str = "last_segment";

const DAY_MS: i64 = 86_400_000;

fn policy_err(msg: String) -> Error {
    Error::RetentionPolicy(msg)
}

/// JavaScript's `Number.isInteger(v) && v >= 0` over a JSON value.
fn non_negative_int(v: Option<&Json>, at: &str) -> Result<u64> {
    let ok = v.and_then(|v| match v {
        Json::Number(n) => n.as_u64().or_else(|| {
            n.as_f64()
                .filter(|f| f.fract() == 0.0 && *f >= 0.0)
                .map(|f| f as u64)
        }),
        _ => None,
    });
    ok.ok_or_else(|| policy_err(format!("{at} must be a non-negative integer")))
}

fn parse_ladder(v: Option<&Json>, at: &str) -> Result<Vec<LadderRung>> {
    let Some(arr) = v.and_then(Json::as_array) else {
        return Err(policy_err(format!(
            "{at} must be an array of {{ after_days, keep }}"
        )));
    };
    let mut rungs = Vec::with_capacity(arr.len());
    for (i, r) in arr.iter().enumerate() {
        let Some(obj) = r.as_object() else {
            return Err(policy_err(format!("{at}[{i}] must be an object")));
        };
        if let Some(extra) = obj.keys().find(|k| *k != "after_days" && *k != "keep") {
            return Err(policy_err(format!("{at}[{i}]: unknown key {extra}")));
        }
        let keep = obj
            .get("keep")
            .and_then(Json::as_str)
            .and_then(LadderKeep::parse)
            .ok_or_else(|| {
                policy_err(format!(
                    "{at}[{i}].keep must be one of {}",
                    LADDER_KEEPS
                        .iter()
                        .map(|k| Json::String((*k).to_owned()).to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
            })?;
        let after_days = non_negative_int(obj.get("after_days"), &format!("{at}[{i}].after_days"))?;
        rungs.push(LadderRung { after_days, keep });
    }
    // Sorted by after_days (stable); two rungs at the same age would be ambiguous.
    rungs.sort_by_key(|r| r.after_days);
    for w in rungs.windows(2) {
        if w[0].after_days == w[1].after_days {
            return Err(policy_err(format!(
                "{at}: two rungs share after_days {}",
                w[1].after_days
            )));
        }
    }
    Ok(rungs)
}

fn parse_origins(v: Option<&Json>, at: &str) -> Result<Vec<String>> {
    let strings = v.and_then(Json::as_array).and_then(|a| {
        a.iter()
            .map(|o| o.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
    });
    strings.ok_or_else(|| policy_err(format!("{at} must be an array of strings")))
}

const POLICY_KEYS: [&str; 5] = [
    "keep_days",
    "ladder",
    "per_doc_max",
    "keep_origins",
    "overrides",
];
const OVERRIDE_KEYS: [&str; 5] = ["glob", "keep_days", "ladder", "per_doc_max", "keep_origins"];

/// A partial policy (a settings blob, a `--policy` argument) over `base`:
/// every key given replaces the base's; a malformed value is
/// [`Error::RetentionPolicy`] with the reference's message. `None` (or JSON
/// `null`) is the base unchanged.
pub fn merge_retention_policy(
    base: &RetentionPolicy,
    partial: Option<&Json>,
    at: &str,
) -> Result<RetentionPolicy> {
    let Some(partial) = partial.filter(|p| !p.is_null()) else {
        return Ok(base.clone());
    };
    let Some(obj) = partial.as_object() else {
        return Err(policy_err(format!("{at} must be an object")));
    };
    if let Some(k) = obj.keys().find(|k| !POLICY_KEYS.contains(&k.as_str())) {
        return Err(policy_err(format!("{at}: unknown key {k}")));
    }
    let mut out = base.clone();
    if obj.contains_key("keep_days") {
        out.keep_days = non_negative_int(obj.get("keep_days"), &format!("{at}.keep_days"))?;
    }
    if obj.contains_key("per_doc_max") {
        out.per_doc_max = non_negative_int(obj.get("per_doc_max"), &format!("{at}.per_doc_max"))?;
    }
    if obj.contains_key("ladder") {
        out.ladder = parse_ladder(obj.get("ladder"), &format!("{at}.ladder"))?;
    }
    if obj.contains_key("keep_origins") {
        out.keep_origins = parse_origins(obj.get("keep_origins"), &format!("{at}.keep_origins"))?;
    }
    if let Some(overrides) = obj.get("overrides") {
        let Some(arr) = overrides.as_array() else {
            return Err(policy_err(format!("{at}.overrides must be an array")));
        };
        let mut parsed = Vec::with_capacity(arr.len());
        for (i, o) in arr.iter().enumerate() {
            let here = format!("{at}.overrides[{i}]");
            let Some(om) = o.as_object() else {
                return Err(policy_err(format!("{here} must be an object")));
            };
            if let Some(k) = om.keys().find(|k| !OVERRIDE_KEYS.contains(&k.as_str())) {
                return Err(policy_err(format!("{here}: unknown key {k}")));
            }
            let glob = match om.get("glob").and_then(Json::as_str) {
                Some(g) if !g.is_empty() => g.to_owned(),
                _ => {
                    return Err(policy_err(format!(
                        "{here}.glob must be a non-empty string"
                    )));
                }
            };
            let mut r = RetentionOverride {
                glob,
                keep_days: None,
                per_doc_max: None,
                ladder: None,
                keep_origins: None,
            };
            if om.contains_key("keep_days") {
                r.keep_days = Some(non_negative_int(
                    om.get("keep_days"),
                    &format!("{here}.keep_days"),
                )?);
            }
            if om.contains_key("per_doc_max") {
                r.per_doc_max = Some(non_negative_int(
                    om.get("per_doc_max"),
                    &format!("{here}.per_doc_max"),
                )?);
            }
            if om.contains_key("ladder") {
                r.ladder = Some(parse_ladder(om.get("ladder"), &format!("{here}.ladder"))?);
            }
            if om.contains_key("keep_origins") {
                r.keep_origins = Some(parse_origins(
                    om.get("keep_origins"),
                    &format!("{here}.keep_origins"),
                )?);
            }
            parsed.push(r);
        }
        out.overrides = parsed;
    }
    Ok(out)
}

/// A settings blob as stored (`workspace_settings.settings`, `repos.settings`):
/// an object, or `{}` for anything else.
#[must_use]
pub fn parse_settings_json(json: Option<&str>) -> Map<String, Json> {
    json.and_then(|s| serde_json::from_str::<Json>(s).ok())
        .and_then(|v| match v {
            Json::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

fn deep_merge(base: &Map<String, Json>, over: &Map<String, Json>) -> Map<String, Json> {
    let mut out = base.clone();
    for (k, v) in over {
        let merged = match (out.get(k), v) {
            (Some(Json::Object(b)), Json::Object(o)) => Json::Object(deep_merge(b, o)),
            _ => v.clone(),
        };
        out.insert(k.clone(), merged);
    }
    out
}

/// The repo's own settings blob (`repos.settings`, the repo layer of
/// `spec/sync`'s two-layer settings).
pub(crate) fn repo_settings(conn: &Connection, repo_id: &str) -> Result<Map<String, Json>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT settings FROM repos WHERE repo_id = ?1",
            params![repo_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(parse_settings_json(raw.as_deref()))
}

/// The repo's effective settings (`spec/sync` settings: the workspace layer
/// with the repo's own deep-merged over it at the leaf).
pub fn effective_settings(conn: &Connection, repo_id: &str) -> Result<Map<String, Json>> {
    let ws: Option<String> = conn
        .query_row(
            "SELECT settings FROM workspace_settings WHERE id = 0",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let ws = parse_settings_json(ws.as_deref());
    let own = repo_settings(conn, repo_id)?;
    Ok(deep_merge(&ws, &own))
}

/// The repo's effective policy: the defaults, the settings' `history.retention`
/// over them, then `override` (a CLI `--policy`, a fixture's partial).
pub fn retention_policy(
    conn: &Connection,
    repo_id: &str,
    override_: Option<&Json>,
) -> Result<RetentionPolicy> {
    let settings = effective_settings(conn, repo_id)?;
    let configured = settings
        .get(RETENTION_SETTINGS_KEY)
        .and_then(Json::as_object)
        .and_then(|h| h.get("retention"));
    let base =
        merge_retention_policy(&RetentionPolicy::default(), configured, "history.retention")?;
    match override_ {
        None => Ok(base),
        Some(o) => merge_retention_policy(&base, Some(o), "policy"),
    }
}

/// An override glob against a reference path: `**` any run of characters,
/// `*` any run without `/`, `?` one character, everything else literal; a
/// glob without a leading `/` is rooted (`projects/**` ≡ `/projects/**`).
#[must_use]
pub fn glob_to_regex(glob: &str) -> regex::Regex {
    let g = if glob.starts_with('/') {
        glob.to_owned()
    } else {
        format!("/{glob}")
    };
    let mut re = String::from("^");
    let chars: Vec<char> = g.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if chars.get(i + 1) == Some(&'*') {
                re.push_str(".*");
                i += 1;
            } else {
                re.push_str("[^/]*");
            }
        } else if c == '?' {
            re.push_str("[^/]");
        } else {
            re.push_str(&regex::escape(&c.to_string()));
        }
        i += 1;
    }
    re.push('$');
    regex::Regex::new(&re).expect("an escaped glob is a valid regex")
}

/// The policy for one document: the first matching override's keys over the base.
#[must_use]
pub fn policy_for(base: &RetentionPolicy, reference_path: &str) -> RetentionPolicy {
    for o in &base.overrides {
        if !glob_to_regex(&o.glob).is_match(reference_path) {
            continue;
        }
        return RetentionPolicy {
            keep_days: o.keep_days.unwrap_or(base.keep_days),
            per_doc_max: o.per_doc_max.unwrap_or(base.per_doc_max),
            ladder: o.ladder.clone().unwrap_or_else(|| base.ladder.clone()),
            keep_origins: o
                .keep_origins
                .clone()
                .unwrap_or_else(|| base.keep_origins.clone()),
            overrides: Vec::new(),
        };
    }
    base.clone()
}

/// Whole days between a commit's `ts` (milliseconds) and `now` (negative when
/// the commit is in the future): `floor((now − ts) / 86 400 000)`.
#[must_use]
pub fn age_days(ts_ms: i64, now_ms: i64) -> i64 {
    (now_ms - ts_ms).div_euclid(DAY_MS)
}

/// The period key of an instant under a rung's grain (UTC; a week starts on
/// Monday and is keyed by the Monday's date).
#[must_use]
pub fn period_key(ts_ms: i64, keep: LadderKeep) -> String {
    let days = ts_ms.div_euclid(DAY_MS);
    let (y, m, d) = civil_from_days(days);
    match keep {
        LadderKeep::Day => format!("{y:04}-{m:02}-{d:02}"),
        LadderKeep::Month => format!("{y:04}-{m:02}"),
        LadderKeep::Year => format!("{y:04}"),
        LadderKeep::Week => {
            // 1970-01-01 was a Thursday (JavaScript's getUTCDay() = 4).
            let js_dow = (days + 4).rem_euclid(7);
            let since_monday = (js_dow + 6) % 7;
            let (wy, wm, wd) = civil_from_days(days - since_monday);
            format!("{wy:04}-{wm:02}-{wd:02}")
        }
    }
}

// ---- the plan -----------------------------------------------------------------------

/// A revision's two body hashes (raw bytes), as the mark walks them.
pub type RevBodies = (Option<Vec<u8>>, Option<Vec<u8>>);

/// The sizes of the blobs and tree nodes of a store, and the walk that marks
/// what a set of revisions reaches (§7: the GC mark, run twice — once from
/// what stays, once from what goes — to cost a plan).
pub struct ReachMarker<'c> {
    conn: &'c Connection,
    tree_sizes: HashMap<String, u64>,
    blob_sizes: HashMap<String, u64>,
}

impl<'c> ReachMarker<'c> {
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self {
            conn,
            tree_sizes: HashMap::new(),
            blob_sizes: HashMap::new(),
        }
    }

    fn entries_of(&self, hash_hex: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .prepare_cached("SELECT entries FROM tree_nodes WHERE hash = ?1")?
            .query_row(params![from_hex(hash_hex)?], |r| r.get(0))
            .optional()?)
    }

    /// Mark every tree node and blob the given revisions name EXPLICITLY
    /// (§7, 16.0: a `{`-node's own entries, not its base's) into
    /// `trees`/`blobs` (hex).
    pub fn mark(
        &mut self,
        revs: &[RevBodies],
        trees: &mut HashSet<String>,
        blobs: &mut HashSet<String>,
    ) -> Result<()> {
        let mut stack: Vec<String> = Vec::new();
        for (root, fm) in revs {
            if let Some(r) = root {
                stack.push(hex(r));
            }
            if let Some(f) = fm {
                blobs.insert(hex(f));
            }
        }
        let sizes = &mut self.tree_sizes;
        crate::history::gc::walk_explicit(self.conn, stack, trees, blobs, |h, text| {
            sizes.insert(h.to_owned(), u64::try_from(text.len()).unwrap_or(0));
        })
    }

    /// Bytes of the given tree nodes (their `entries`) and blobs (`size`); a
    /// missing row counts 0.
    pub fn bytes_of<'a>(
        &mut self,
        trees: impl IntoIterator<Item = &'a String>,
        blobs: impl IntoIterator<Item = &'a String>,
    ) -> Result<u64> {
        let mut n = 0u64;
        for t in trees {
            let size = match self.tree_sizes.get(t) {
                Some(s) => *s,
                None => {
                    let s = self
                        .entries_of(t)?
                        .map_or(0, |e| u64::try_from(e.len()).unwrap_or(0));
                    self.tree_sizes.insert(t.clone(), s);
                    s
                }
            };
            n += size;
        }
        for b in blobs {
            let size = match self.blob_sizes.get(b) {
                Some(s) => *s,
                None => {
                    let s: Option<i64> = self
                        .conn
                        .prepare_cached("SELECT size FROM blobs WHERE hash = ?1")?
                        .query_row(params![from_hex(b)?], |r| r.get(0))
                        .optional()?;
                    let s = s.map_or(0, |v| u64::try_from(v).unwrap_or(0));
                    self.blob_sizes.insert(b.clone(), s);
                    s
                }
            };
            n += size;
        }
        Ok(n)
    }
}

struct RevRow {
    rev_id: String,
    seq: i64,
    root_tree: Option<Vec<u8>>,
    frontmatter_blob: Option<Vec<u8>>,
    ts_ms: i64,
    origin: String,
    reason: Option<String>,
}

pub use crate::core::docs_ops::reference_path;

/// The plan (§7.1 "The plan", the policy as an exact rule). Per document,
/// over its live revisions oldest → newest: a revision is KEPT when any rule
/// keeps it — it is the document's current revision (a tombstoned document's
/// last revision is its current one), a `pending_materializations` row names
/// it, it is younger than `keep_days`, it is among the newest `per_doc_max`,
/// its commit's origin is in `keep_origins` with a non-empty reason, it is
/// not before `before`, no ladder rung applies to its age (the gap below the
/// first rung keeps everything), or it is the newest revision of its rung's
/// period; every other revision is ARCHIVED. Bytes are the GC mark from the
/// archived revisions minus the mark from every revision that stays live in
/// the store (all repositories — blobs and tree nodes are shared).
pub fn evaluate_retention(
    conn: &Connection,
    repo_id: &str,
    opts: &RetentionOptions,
) -> Result<RetentionPlan> {
    let now_ms = parse_ms(&opts.now)?;
    let before_ms = opts.before.as_deref().map(parse_ms).transpose()?;
    let base = &opts.policy;

    let docs: Vec<(String, String, Option<String>)> = {
        let mut stmt =
            conn.prepare("SELECT doc_id, path, head FROM docs WHERE repo_id = ?1 ORDER BY path")?;
        let it = stmt.query_map(params![repo_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let pinned: HashSet<String> = {
        let mut stmt = conn.prepare(
            "SELECT rev_id FROM pending_materializations WHERE repo_id = ?1 AND rev_id IS NOT NULL",
        )?;
        let it = stmt.query_map(params![repo_id], |r| r.get::<_, String>(0))?;
        it.collect::<std::result::Result<HashSet<_>, _>>()?
    };
    let mut rev_stmt = conn.prepare(
        "SELECT r.rev_id, r.seq, r.root_tree, r.frontmatter_blob, c.ts, c.origin, c.reason
         FROM revisions r JOIN commits c ON c.commit_id = r.commit_id
         WHERE r.doc_id = ?1 AND r.archive IS NULL ORDER BY r.seq",
    )?;

    struct PerDoc {
        doc_id: String,
        path: String,
        live: usize,
        keep: Vec<String>,
        archive: Vec<RevRow>,
    }
    let mut archive_set: HashSet<String> = HashSet::new();
    let mut per_doc: Vec<PerDoc> = Vec::new();
    let mut total_live = 0usize;
    for (doc_id, path, current_rev) in &docs {
        let rows: Vec<RevRow> = rev_stmt
            .query_map(params![doc_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<Vec<u8>>>(2)?,
                    r.get::<_, Option<Vec<u8>>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(
                |(rev_id, seq, root_tree, frontmatter_blob, ts, origin, reason)| {
                    Ok(RevRow {
                        rev_id,
                        seq,
                        root_tree,
                        frontmatter_blob,
                        ts_ms: parse_ms(&ts)?,
                        origin,
                        reason,
                    })
                },
            )
            .collect::<Result<Vec<_>>>()?;
        let live = rows.len();
        total_live += live;
        if rows.is_empty() {
            continue;
        }
        let policy = policy_for(base, &reference_path(path));
        let mut kept: HashSet<&str> = HashSet::new();
        // Rules 1–6: the per-revision keeps.
        for (i, r) in rows.iter().enumerate() {
            let rank = u64::try_from(rows.len() - i).unwrap_or(u64::MAX); // 1 = the newest
            let keep = current_rev.as_deref() == Some(r.rev_id.as_str())
                || pinned.contains(&r.rev_id)
                || age_days(r.ts_ms, now_ms) < i64::try_from(policy.keep_days).unwrap_or(i64::MAX)
                || rank <= policy.per_doc_max
                || (policy.keep_origins.contains(&r.origin)
                    && r.reason.as_deref().is_some_and(|s| !s.is_empty()))
                || before_ms.is_some_and(|b| r.ts_ms >= b);
            if keep {
                kept.insert(r.rev_id.as_str());
            }
        }
        // Rule 7–8: the ladder. Each remaining revision belongs to the rung
        // with the greatest `after_days` not above its age; the newest
        // revision of each (rung, period) bucket — over every live revision
        // of the document in that bucket, kept or not — is the bucket's
        // representative and is kept.
        let mut representative: HashMap<(u64, LadderKeep, String), (i64, &str)> = HashMap::new();
        let keep_days = i64::try_from(policy.keep_days).unwrap_or(i64::MAX);
        for r in &rows {
            let age = age_days(r.ts_ms, now_ms);
            if age < keep_days {
                continue;
            }
            let rung = policy
                .ladder
                .iter()
                .rev()
                .find(|l| i64::try_from(l.after_days).unwrap_or(i64::MAX) <= age);
            let Some(rung) = rung else {
                kept.insert(r.rev_id.as_str()); // the gap below the first rung: nothing says to thin it
                continue;
            };
            let key = (rung.after_days, rung.keep, period_key(r.ts_ms, rung.keep));
            match representative.get(&key) {
                Some((seq, _)) if *seq >= r.seq => {}
                _ => {
                    representative.insert(key, (r.seq, r.rev_id.as_str()));
                }
            }
        }
        for (_, id) in representative.values() {
            kept.insert(id);
        }
        let kept: HashSet<String> = kept.into_iter().map(str::to_owned).collect();
        let mut keep = Vec::new();
        let mut archive = Vec::new();
        for r in rows {
            if kept.contains(r.rev_id.as_str()) {
                keep.push(r.rev_id);
            } else {
                archive_set.insert(r.rev_id.clone());
                archive.push(r);
            }
        }
        per_doc.push(PerDoc {
            doc_id: doc_id.clone(),
            path: path.clone(),
            live,
            keep,
            archive,
        });
    }

    // Costing: the mark from everything that stays live in the whole store.
    let mut marker = ReachMarker::new(conn);
    let mut kept_trees = HashSet::new();
    let mut kept_blobs = HashSet::new();
    let live_revs: Vec<RevBodies> = {
        let mut stmt = conn.prepare(
            "SELECT rev_id, root_tree, frontmatter_blob FROM revisions WHERE archive IS NULL",
        )?;
        let it = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<Vec<u8>>>(1)?,
                r.get::<_, Option<Vec<u8>>>(2)?,
            ))
        })?;
        it.collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|(id, _, _)| !archive_set.contains(id))
            .map(|(_, root, fm)| (root, fm))
            .collect()
    };
    marker.mark(&live_revs, &mut kept_trees, &mut kept_blobs)?;
    let mut union_trees: HashSet<String> = HashSet::new();
    let mut union_blobs: HashSet<String> = HashSet::new();
    let mut planned = Vec::new();
    let mut keep_total = 0usize;
    for p in per_doc {
        keep_total += p.keep.len();
        if p.archive.is_empty() {
            continue;
        }
        let mut trees = HashSet::new();
        let mut blobs = HashSet::new();
        let bodies: Vec<RevBodies> = p
            .archive
            .iter()
            .map(|r| (r.root_tree.clone(), r.frontmatter_blob.clone()))
            .collect();
        marker.mark(&bodies, &mut trees, &mut blobs)?;
        let only_trees: Vec<String> = trees
            .into_iter()
            .filter(|t| !kept_trees.contains(t))
            .collect();
        let only_blobs: Vec<String> = blobs
            .into_iter()
            .filter(|b| !kept_blobs.contains(b))
            .collect();
        union_trees.extend(only_trees.iter().cloned());
        union_blobs.extend(only_blobs.iter().cloned());
        let bytes = marker.bytes_of(only_trees.iter(), only_blobs.iter())?;
        planned.push(RetentionDocPlan {
            id: p.doc_id,
            path: reference_path(&p.path),
            revisions: p.live,
            keep: p.keep,
            archive: p.archive.into_iter().map(|r| r.rev_id).collect(),
            bytes,
        });
    }
    let bytes = marker.bytes_of(union_trees.iter(), union_blobs.iter())?;
    Ok(RetentionPlan {
        policy: base.clone(),
        now: opts.now.clone(),
        before: opts.before.clone(),
        totals: RetentionTotals {
            docs: planned.len(),
            revisions: total_live,
            keep: keep_total,
            archive: archive_set.len(),
            bytes,
        },
        docs: planned,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ms(ts: &str) -> i64 {
        parse_ms(ts).unwrap()
    }

    #[test]
    fn defaults_and_json_order() {
        let p = RetentionPolicy::default();
        assert_eq!(
            p.to_json().to_string(),
            r#"{"keep_days":30,"ladder":[{"after_days":30,"keep":"one per day"},{"after_days":365,"keep":"one per month"}],"per_doc_max":200,"keep_origins":["api"],"overrides":[]}"#
        );
    }

    #[test]
    fn merge_replaces_keys_and_refuses_malformed_values() {
        let base = RetentionPolicy::default();
        let p = merge_retention_policy(
            &base,
            Some(&json!({ "keep_days": 0, "per_doc_max": 1, "ladder": [{ "after_days": 400, "keep": "one per year" }, { "after_days": 0, "keep": "one per day" }] })),
            "policy",
        )
        .unwrap();
        assert_eq!(p.keep_days, 0);
        assert_eq!(p.per_doc_max, 1);
        assert_eq!(p.ladder[0].after_days, 0, "sorted by after_days");
        assert_eq!(p.keep_origins, vec!["api"]);
        let err = |v: Json| {
            merge_retention_policy(&base, Some(&v), "policy")
                .unwrap_err()
                .to_string()
        };
        assert_eq!(
            err(json!({ "keep_days": "soon" })),
            "policy.keep_days must be a non-negative integer"
        );
        assert_eq!(
            err(json!({ "keep_days": -1 })),
            "policy.keep_days must be a non-negative integer"
        );
        assert_eq!(err(json!({ "nope": 1 })), "policy: unknown key nope");
        assert_eq!(err(json!([])), "policy must be an object");
        assert_eq!(
            err(json!({ "ladder": [{ "after_days": 1, "keep": "one per hour" }] })),
            "policy.ladder[0].keep must be one of \"one per day\", \"one per week\", \"one per month\", \"one per year\""
        );
        assert_eq!(
            err(
                json!({ "ladder": [{ "after_days": 1, "keep": "one per day" }, { "after_days": 1, "keep": "one per week" }] })
            ),
            "policy.ladder: two rungs share after_days 1"
        );
        assert_eq!(
            err(json!({ "overrides": [{ "keep_days": 1 }] })),
            "policy.overrides[0].glob must be a non-empty string"
        );
        assert_eq!(
            err(json!({ "overrides": [{ "glob": "x", "nope": 1 }] })),
            "policy.overrides[0]: unknown key nope"
        );
        assert_eq!(
            err(json!({ "keep_origins": ["api", 1] })),
            "policy.keep_origins must be an array of strings"
        );
        // null / absent is the base unchanged.
        assert_eq!(merge_retention_policy(&base, None, "policy").unwrap(), base);
        assert_eq!(
            merge_retention_policy(&base, Some(&Json::Null), "policy").unwrap(),
            base
        );
    }

    #[test]
    fn globs_and_overrides() {
        assert!(glob_to_regex("/projects/**").is_match("/projects/a/b.md"));
        assert!(
            glob_to_regex("projects/**").is_match("/projects/a.md"),
            "rooted"
        );
        assert!(!glob_to_regex("/projects/*").is_match("/projects/a/b.md"));
        assert!(glob_to_regex("/projects/*").is_match("/projects/a.md"));
        assert!(glob_to_regex("/attn/focus.md").is_match("/attn/focus.md"));
        assert!(!glob_to_regex("/attn/focus.md").is_match("/attn/focus.mdx"));
        assert!(glob_to_regex("/a?.md").is_match("/ab.md"));
        assert!(!glob_to_regex("/a?.md").is_match("/a/.md"));
        let base = merge_retention_policy(
            &RetentionPolicy::default(),
            Some(&json!({ "overrides": [{ "glob": "/attn/focus.md", "keep_days": 7, "per_doc_max": 50 }, { "glob": "/attn/**", "keep_days": 1 }] })),
            "policy",
        )
        .unwrap();
        let focus = policy_for(&base, "/attn/focus.md");
        assert_eq!(
            (focus.keep_days, focus.per_doc_max),
            (7, 50),
            "the first match wins"
        );
        assert_eq!(focus.ladder, base.ladder);
        assert!(focus.overrides.is_empty());
        assert_eq!(policy_for(&base, "/attn/other.md").keep_days, 1);
        assert_eq!(policy_for(&base, "/x.md"), base);
    }

    #[test]
    fn ages_and_period_keys() {
        let now = ms("2026-01-10T00:00:00.000Z");
        assert_eq!(age_days(ms("2026-01-09T00:00:00.001Z"), now), 0);
        assert_eq!(age_days(ms("2026-01-09T00:00:00.000Z"), now), 1);
        assert_eq!(
            age_days(ms("2026-01-11T00:00:00.000Z"), now),
            -1,
            "the future is negative"
        );
        let t = ms("2026-01-01T12:00:00.000Z"); // a Thursday
        assert_eq!(period_key(t, LadderKeep::Day), "2026-01-01");
        assert_eq!(period_key(t, LadderKeep::Month), "2026-01");
        assert_eq!(period_key(t, LadderKeep::Year), "2026");
        assert_eq!(
            period_key(t, LadderKeep::Week),
            "2025-12-29",
            "the ISO week's Monday"
        );
        assert_eq!(
            period_key(ms("2026-01-04T23:59:59.999Z"), LadderKeep::Week),
            "2025-12-29",
            "Sunday closes the week"
        );
        assert_eq!(
            period_key(ms("2026-01-05T00:00:00.000Z"), LadderKeep::Week),
            "2026-01-05",
            "Monday opens one"
        );
        assert_eq!(
            period_key(ms("1970-01-01T00:00:00.000Z"), LadderKeep::Week),
            "1969-12-29"
        );
    }
}
