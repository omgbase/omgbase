//! The corrected example an error teaches with (`spec/mutate` §8 "fix",
//! `spec/surface` §9; mutate 3.3 / surface 4.4): `data.fix` is a **literal
//! corrected call** — the arguments as canonical JSON (§11.5), prefixed by
//! the tool's name and one space only when the corrected call is to another
//! tool — rebuilt from the request that failed, never a prose template. Both
//! engines compose the same bytes; the reference is `mutate/canonical.ts`
//! (`fixRequest`, `fixTool`, `narrowedTo`) and `plan.ts` (`planningFix`,
//! `replanFix`).
//!
//! One function per error; the wording lives here and nowhere else. The
//! planner's errors are decorated where the request is at hand: the plain
//! request's in the catalog ([`attach`], over every error `apply` / `plan` /
//! `execute` return), a selector's in `select::plan_selected`
//! ([`planning_fix`] with the hits' origins). The append tools build theirs
//! at the site ([`append_after`], [`append_without_section`],
//! [`append_into_heading`]). An error the table does not cover, or a request
//! the rebuild cannot read, passes through untouched — a `fix` is never
//! wrong JSON.

use omgbase_mutate::canonical_json;
use serde_json::{Map, Value as Json, json};

use crate::error::SurfaceError;

/// A `#` locator where a target is expected (3.2 "Sugar"): the two reads
/// that yield the id.
pub const LOCATOR: &str = "resolve the locator to an id first: `blocks_resolve { locator }`, or a `query` whose hit is the block";

/// A `plan` / `apply` / `execute` request as the caller gave it: `select`
/// and `expect` only when present (the reference's `FixRequest`).
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
    pub select: Option<Json>,
    pub effects: Json,
    pub expect: Option<Json>,
}

impl Request {
    /// The request's write members from a tool's arguments (`effects` +
    /// `select?` + `expect?`); `None` without an `effects` member.
    #[must_use]
    pub fn of(args: &Json) -> Option<Self> {
        Some(Self {
            select: args.get("select").filter(|s| !s.is_null()).cloned(),
            effects: args.get("effects")?.clone(),
            expect: args.get("expect").cloned(),
        })
    }

    /// The effect templates as an array.
    fn list(&self) -> Option<&Vec<Json>> {
        self.effects.as_array()
    }

    fn with_effects(&self, effects: Vec<Json>) -> Self {
        Self {
            effects: Json::Array(effects),
            ..self.clone()
        }
    }
}

/// The `fix` for a request to the SAME tool: the corrected arguments as
/// canonical JSON (`fixRequest`).
#[must_use]
pub fn fix_request(req: &Request) -> String {
    let mut m = Map::new();
    if let Some(s) = &req.select {
        m.insert("select".to_owned(), s.clone());
    }
    m.insert("effects".to_owned(), req.effects.clone());
    if let Some(e) = &req.expect {
        m.insert("expect".to_owned(), e.clone());
    }
    canonical_json(&Json::Object(m))
}

/// The `fix` naming another tool: `<tool> <canonical args>` (`fixTool`).
#[must_use]
pub fn fix_tool(tool: &str, args: &Json) -> String {
    format!("{tool} {}", canonical_json(args))
}

/// The selector that names exactly one row: `from <root> where id == "<id>"`
/// (`narrowedTo`).
#[must_use]
pub fn narrowed_to(root: &str, id: &str) -> String {
    format!("from {root} where id == {}", Json::String(id.to_owned()))
}

/// The root a row id belongs to, by its prefix (`rootOfId`).
#[must_use]
pub fn root_of_id(id: &str) -> &'static str {
    if id.starts_with("d_") {
        "docs"
    } else if id.starts_with("n_") {
        "nodes"
    } else {
        "blocks"
    }
}

/// `value` with every string equal to `from` replaced by `to`
/// (`substituteSymbols`).
fn substitute(value: &Json, from: &str, to: &str) -> Json {
    match value {
        Json::String(s) if s == from => json!(to),
        Json::Array(a) => Json::Array(a.iter().map(|x| substitute(x, from, to)).collect()),
        Json::Object(o) => Json::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), substitute(v, from, to)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Where a concrete effect came from under a selector: the hit's row and the
/// template (the reference's `EffectOrigin`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin {
    pub row_id: String,
    pub template_index: usize,
}

// ---- planning errors (`planningFix`) ----------------------------------------------------

/// `conflicting_effects { effects: [a, b] }`: keep the later effect — the
/// request minus the earlier one. Under a selector a cross-hit collision
/// narrows the selector to the later hit (`from <root> where id == …`,
/// `expect.max: 1`) and a same-hit collision drops the earlier template.
#[must_use]
pub fn conflicting_effects(
    req: &Request,
    a: usize,
    b: usize,
    origins: Option<&[Origin]>,
) -> Option<String> {
    let effects = req.list()?;
    let Some(origins) = origins else {
        let kept = effects
            .iter()
            .enumerate()
            .filter(|(k, _)| *k != a)
            .map(|(_, e)| e.clone())
            .collect();
        return Some(fix_request(&Request {
            select: None,
            effects: Json::Array(kept),
            expect: None,
        }));
    };
    let (oa, ob) = (origins.get(a)?, origins.get(b)?);
    if oa.row_id != ob.row_id {
        return Some(fix_request(&Request {
            select: Some(json!(narrowed_to(root_of_id(&ob.row_id), &ob.row_id))),
            effects: req.effects.clone(),
            expect: Some(json!({ "max": 1 })),
        }));
    }
    let kept = effects
        .iter()
        .enumerate()
        .filter(|(k, _)| *k != oa.template_index)
        .map(|(_, e)| e.clone())
        .collect();
    Some(fix_request(&req.with_effects(kept)))
}

/// `stale_plan` at plan time (an `expect.revision` that no longer holds):
/// the same request with the current revision in that guard — effect `t`
/// (the template under a selector).
#[must_use]
pub fn stale_revision(req: &Request, t: usize, current: &str) -> Option<String> {
    let effects = req.list()?;
    let e = effects.get(t)?.as_object()?;
    let mut fixed = e.clone();
    let mut expect = e
        .get("expect")
        .and_then(Json::as_object)
        .cloned()
        .unwrap_or_default();
    expect.insert("revision".to_owned(), json!(current));
    fixed.insert("expect".to_owned(), Json::Object(expect));
    let mapped = effects
        .iter()
        .enumerate()
        .map(|(k, x)| {
            if k == t {
                Json::Object(fixed.clone())
            } else {
                x.clone()
            }
        })
        .collect();
    Some(fix_request(&req.with_effects(mapped)))
}

/// `target_missing { symbol }` for a `$new.n` no earlier effect created
/// (plain requests): the next `create` moved before the effect that uses it,
/// the symbol renamed to the one that create will allocate — `$new.<count>`,
/// `count` the symbols allocated so far.
#[must_use]
pub fn create_first(req: &Request, i: usize, symbol: &str, allocated: usize) -> Option<String> {
    let effects = req.list()?;
    let c = effects
        .iter()
        .enumerate()
        .skip(i + 1)
        .find(|(_, e)| e.get("op").and_then(Json::as_str) == Some("create"))
        .map(|(k, _)| k)?;
    let renamed = format!("$new.{allocated}");
    let mut reordered: Vec<Json> = effects
        .iter()
        .enumerate()
        .filter(|(k, _)| *k != c)
        .map(|(_, e)| e.clone())
        .collect();
    reordered.insert(i, effects[c].clone());
    let fixed = reordered
        .iter()
        .enumerate()
        .map(|(k, e)| {
            if k == i + 1 {
                substitute(e, symbol, &renamed)
            } else {
                e.clone()
            }
        })
        .collect();
    Some(fix_request(&Request {
        select: None,
        effects: Json::Array(fixed),
        expect: None,
    }))
}

/// `ambiguous_target`: the slot spelled as the **first** identity the
/// expression yielded (`here` the member's path, `effects[t].…`); under a
/// selector the selector narrowed to the row it was read from
/// (`expect.max: 1`); a plain request keeps its effects with the slot
/// rewritten (the reference's `ambiguousFix`).
#[must_use]
pub fn ambiguous_slot(
    req: &Request,
    here: &str,
    first: &str,
    narrow: (&str, &str),
) -> Option<String> {
    let mut fixed = req.clone();
    let path = here.strip_prefix("effects")?;
    *walk_mut(&mut fixed.effects, path)? = json!(first);
    if req.select.is_none() {
        return Some(fix_request(&Request {
            select: None,
            effects: fixed.effects,
            expect: None,
        }));
    }
    let (root, id) = narrow;
    Some(fix_request(&Request {
        select: Some(json!(narrowed_to(root, id))),
        effects: fixed.effects,
        expect: Some(json!({ "max": 1 })),
    }))
}

/// A refused selector source (§11.8 step 1): the same request over an
/// admitted root — `links` becomes `blocks` (a link lives in a block), any
/// other source `docs` — spliced over the source's code-point span of the
/// written query (the reference's `rootFix`).
#[must_use]
pub fn root_fix(req: &Request, select: &str, span: (usize, usize), links: bool) -> String {
    let cps: Vec<char> = select.chars().collect();
    let start = span.0.min(cps.len());
    let end = span.1.clamp(start, cps.len());
    let root = if links { "blocks" } else { "docs" };
    let spliced: String =
        cps[..start].iter().collect::<String>() + root + &cps[end..].iter().collect::<String>();
    fix_request(&Request {
        select: Some(json!(spliced)),
        ..req.clone()
    })
}

/// The planner's refusals of one request, decorated (the reference's
/// `planningFix`): `i` is the failing effect's index in the concrete list,
/// `origins` the hits' origins under a selector (`None` for a plain
/// request), `allocated` the symbols the effects before `i` allocate (read
/// only when a `$new.n` is missing). Returns the error, with `data.fix`
/// when the table covers it and none was set.
pub fn planning_fix(
    req: &Request,
    mut err: SurfaceError,
    origins: Option<&[Origin]>,
    allocated: impl FnOnce(usize) -> Option<usize>,
) -> SurfaceError {
    let Some(data) = err.data.as_ref().and_then(Json::as_object) else {
        return err;
    };
    if data.contains_key("fix") {
        return err;
    }
    let index = |v: Option<&Json>| {
        v.and_then(Json::as_u64)
            .and_then(|n| usize::try_from(n).ok())
    };
    let fix = match err.code.as_str() {
        "conflicting_effects" => {
            let pair = data.get("effects").and_then(Json::as_array);
            match (
                pair.and_then(|p| index(p.first())),
                pair.and_then(|p| index(p.get(1))),
            ) {
                (Some(a), Some(b)) => conflicting_effects(req, a, b, origins),
                _ => None,
            }
        }
        "stale_plan" => {
            let current = data
                .get("current")
                .and_then(|c| c.get("revision"))
                .and_then(Json::as_str);
            let t = match origins {
                Some(_) => index(data.get("template_index")),
                None => index(data.get("effect_index")),
            };
            match (current, t) {
                (Some(current), Some(t)) => stale_revision(req, t, current),
                _ => None,
            }
        }
        "target_missing" if origins.is_none() => {
            match (
                data.get("symbol").and_then(Json::as_str),
                index(data.get("effect_index")),
            ) {
                (Some(symbol), Some(i)) => {
                    let n = omgbase_mutate::parse_new_symbol(symbol);
                    // Only a symbol nothing allocated yet is "created later".
                    match (n, allocated(i)) {
                        (Some(n), Some(count)) if n >= count => create_first(req, i, symbol, count),
                        _ => None,
                    }
                }
                _ => None,
            }
        }
        _ => None,
    };
    if let Some(fix) = fix {
        if let Some(d) = err.data.as_mut().and_then(Json::as_object_mut) {
            d.insert("fix".to_owned(), json!(fix));
        }
    }
    err
}

// ---- execution errors (`replanFix`) -----------------------------------------------------

/// A plan that cannot be executed as it stands (`stale_plan` at execute,
/// `plan_mismatch` of the plan form): re-plan and commit in one call —
/// `apply` over the plan's selector form when it has one (`expect` as given,
/// else the selection's cardinality), else over its concrete effects.
#[must_use]
pub fn replan(plan: &Json) -> Option<String> {
    if let Some(sel) = plan.get("selection") {
        let expect = sel
            .get("expect")
            .cloned()
            .or_else(|| sel.get("cardinality").map(|c| json!({ "max": c })));
        return Some(fix_request(&Request {
            select: Some(sel.get("query")?.clone()),
            effects: sel.get("templates")?.clone(),
            expect,
        }));
    }
    let effects = plan.get("effects")?;
    if effects.as_array().is_some_and(Vec::is_empty) {
        return None;
    }
    Some(fix_request(&Request {
        select: None,
        effects: effects.clone(),
        expect: None,
    }))
}

/// `expect.max` missing on a one-shot `apply { select }`: the same call
/// bounded at the selection's actual size.
#[must_use]
pub fn bounded(req: &Request, cardinality: usize) -> String {
    fix_request(&Request {
        expect: Some(json!({ "max": cardinality })),
        ..req.clone()
    })
}

/// A `-> ` leader in a member that takes no expression (`here` the member's
/// path, `effects[t].…`): the same request with the leader dropped there —
/// the string is the literal it reads as.
#[must_use]
pub fn literal_slot(req: &Request, here: &str) -> Option<String> {
    let mut fixed = req.clone();
    let path = here.strip_prefix("effects")?;
    let slot = walk_mut(&mut fixed.effects, path)?;
    let literal = crate::select::literal_of(slot.as_str()?.strip_prefix("-> ")?);
    *slot = json!(literal);
    Some(fix_request(&fixed))
}

/// Follow a `[0].expect.content_hash` / `[1].at.after` path.
fn walk_mut<'a>(v: &'a mut Json, path: &str) -> Option<&'a mut Json> {
    let mut cur = v;
    for seg in path.split('.') {
        let (name, indices) = match seg.find('[') {
            Some(i) => (&seg[..i], &seg[i..]),
            None => (seg, ""),
        };
        if !name.is_empty() {
            cur = cur.get_mut(name)?;
        }
        for idx in indices
            .split(']')
            .filter(|s| !s.is_empty())
            .map(|s| s.trim_start_matches('['))
        {
            cur = cur.get_mut(idx.parse::<usize>().ok()?)?;
        }
    }
    Some(cur)
}

/// Decorate an effect tool's error with its corrected call (module docs):
/// `apply`, `plan` and `execute` only; every other tool's error passes
/// through, and so does one that already carries a `fix` (the selector's,
/// the compile's). `allocated(i)` plans the effects before `i` and counts
/// their symbols (read only for a missing `$new.n`).
#[must_use]
pub fn attach(
    tool: &str,
    args: &Json,
    err: SurfaceError,
    allocated: impl FnOnce(usize) -> Option<usize>,
) -> SurfaceError {
    if !matches!(tool, "apply" | "plan" | "execute") {
        return err;
    }
    let Some(data) = err.data.as_ref().and_then(Json::as_object) else {
        return err;
    };
    if data.contains_key("fix") {
        return err;
    }
    // The plan form: the plan itself is the request.
    if let Some(plan) = args.get("plan") {
        let fix = match err.code.as_str() {
            "stale_plan" | "plan_mismatch" => replan(plan),
            _ => None,
        };
        return with_fix(err, fix);
    }
    let Some(req) = Request::of(args) else {
        return err;
    };
    let fix = match err.code.as_str() {
        // The digest form's mismatch: the request as given, re-planned.
        "plan_mismatch" => Some(fix_request(&req)),
        // A selector's errors were decorated where the hits were
        // (`select::plan_selected`, the compile).
        _ if req.select.is_some() => None,
        _ => return planning_fix(&req, err, None, allocated),
    };
    with_fix(err, fix)
}

fn with_fix(mut err: SurfaceError, fix: Option<String>) -> SurfaceError {
    if let Some(fix) = fix {
        if let Some(d) = err.data.as_mut().and_then(Json::as_object_mut) {
            d.insert("fix".to_owned(), json!(fix));
        }
    }
    err
}

// ---- the append tools ---------------------------------------------------------------------

/// `blocks_append` on a leaf (`block_not_container`): append means into —
/// the `blocks_insert` that places the text right after it, under its parent
/// (the document when the leaf is top-level).
#[must_use]
pub fn append_after(parent: &str, id: &str, text: &str) -> String {
    fix_tool(
        "blocks_insert",
        &json!({ "to": parent, "at": { "after": id }, "markdown": text }),
    )
}

/// `docs_append { section }` naming no heading (`parent_missing`): the same
/// append — the call's own locator and text — without the section (the
/// document's end).
#[must_use]
pub fn append_without_section(id: Option<&str>, path: Option<&str>, text: &str) -> String {
    let mut m = Map::new();
    if let Some(id) = id {
        m.insert("id".to_owned(), json!(id));
    }
    if let Some(path) = path {
        m.insert("path".to_owned(), json!(path));
    }
    m.insert("text".to_owned(), json!(text));
    fix_tool("docs_append", &Json::Object(m))
}

/// `docs_append { section }` matching several headings
/// (`ambiguous_heading`): `blocks_append` into the first candidate by id.
#[must_use]
pub fn append_into_heading(heading_id: &str, text: &str) -> String {
    fix_tool("blocks_append", &json!({ "id": heading_id, "text": text }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn effects() -> Json {
        json!([
            { "op": "insert", "into": { "kind": "document", "path": "a.md" }, "markdown": "x" },
            { "op": "set", "target": { "kind": "document", "path": "a.md" }, "field": "frontmatter.k", "value": 1 },
            { "op": "create", "path": "c.md", "markdown": "# C" }
        ])
    }

    fn err(code: &str, data: Json) -> SurfaceError {
        SurfaceError::with_data(code, "m", data)
    }

    fn fix_of(e: &SurfaceError) -> Option<String> {
        e.data
            .as_ref()
            .and_then(|d| d.get("fix"))
            .and_then(Json::as_str)
            .map(str::to_owned)
    }

    fn canon(v: Json) -> String {
        canonical_json(&v)
    }

    fn none(_: usize) -> Option<usize> {
        None
    }

    #[test]
    fn a_fix_is_canonical_json_prefixed_only_for_another_tool() {
        let req = Request {
            select: Some(json!("from docs collect")),
            effects: json!([{ "op": "set", "field": "f", "value": 1 }]),
            expect: Some(json!({ "max": 2 })),
        };
        assert_eq!(
            fix_request(&req),
            "{\"effects\":[{\"field\":\"f\",\"op\":\"set\",\"value\":1}],\"expect\":{\"max\":2},\"select\":\"from docs collect\"}"
        );
        assert_eq!(
            fix_tool("plan", &json!({ "effects": [] })),
            "plan {\"effects\":[]}"
        );
        assert_eq!(narrowed_to("docs", "d_1"), "from docs where id == \"d_1\"");
        assert_eq!(root_of_id("d_1"), "docs");
        assert_eq!(root_of_id("n_1"), "nodes");
        assert_eq!(root_of_id("b_1"), "blocks");
    }

    #[test]
    fn conflicting_effects_keeps_the_later_effect() {
        let args = json!({ "effects": effects(), "reason": "r" });
        let e = attach(
            "apply",
            &args,
            err("conflicting_effects", json!({ "effects": [0, 1] })),
            none,
        );
        assert_eq!(
            fix_of(&e).unwrap(),
            canon(json!({ "effects": [effects()[1], effects()[2]] }))
        );
        // Under a selector: a cross-hit collision narrows to the later hit, a
        // same-hit collision drops the earlier template.
        let req = Request {
            select: Some(json!("from docs collect")),
            effects: json!([effects()[1], effects()[1]]),
            expect: Some(json!({ "max": 5 })),
        };
        let origins = [
            Origin {
                row_id: "d_1".into(),
                template_index: 0,
            },
            Origin {
                row_id: "d_1".into(),
                template_index: 1,
            },
            Origin {
                row_id: "d_2".into(),
                template_index: 0,
            },
            Origin {
                row_id: "d_2".into(),
                template_index: 1,
            },
        ];
        assert_eq!(
            conflicting_effects(&req, 1, 2, Some(&origins)).unwrap(),
            canon(
                json!({ "select": "from docs where id == \"d_2\"", "effects": [effects()[1], effects()[1]], "expect": { "max": 1 } })
            )
        );
        assert_eq!(
            conflicting_effects(&req, 0, 1, Some(&origins)).unwrap(),
            canon(
                json!({ "select": "from docs collect", "effects": [effects()[1]], "expect": { "max": 5 } })
            )
        );
    }

    #[test]
    fn a_stale_revision_at_plan_time_is_repinned_to_the_current_one() {
        let args = json!({ "effects": [
            { "op": "set", "target": { "kind": "document", "path": "a.md" }, "field": "frontmatter.k", "value": 1, "expect": { "revision": "r_0" } },
            effects()[0],
        ] });
        let e = attach(
            "apply",
            &args,
            err(
                "stale_plan",
                json!({ "doc": "d_0", "expected_revision": "r_0", "current": { "revision": "r_1", "hash": null }, "retriable": true, "effect_index": 0 }),
            ),
            none,
        );
        let mut fixed = args["effects"].clone();
        fixed[0]["expect"]["revision"] = json!("r_1");
        assert_eq!(fix_of(&e).unwrap(), canon(json!({ "effects": fixed })));
        // An effect without an `expect` gains one.
        let req = Request {
            select: None,
            effects: json!([effects()[1]]),
            expect: None,
        };
        let mut with = effects()[1].clone();
        with["expect"] = json!({ "revision": "r_9" });
        assert_eq!(
            stale_revision(&req, 0, "r_9").unwrap(),
            canon(json!({ "effects": [with] }))
        );
    }

    #[test]
    fn an_unexecutable_plan_is_replanned_from_its_core() {
        let plan = json!({ "plan_id": "p", "effects": effects(), "preconditions": {} });
        let e = attach(
            "execute",
            &json!({ "plan": plan }),
            err("stale_plan", json!({ "doc": "d_0", "retriable": true })),
            none,
        );
        assert_eq!(fix_of(&e).unwrap(), canon(json!({ "effects": effects() })));
        let e = attach(
            "execute",
            &json!({ "plan": plan }),
            err("plan_mismatch", json!({ "expected": "a", "actual": "b" })),
            none,
        );
        assert_eq!(fix_of(&e).unwrap(), canon(json!({ "effects": effects() })));
        // A query-directed plan: its selector form, `expect` as given or the cardinality.
        let selected = json!({ "effects": [], "selection": { "query": "from docs collect", "templates": [effects()[1]], "cardinality": 3, "identities": ["d_1"] } });
        assert_eq!(
            replan(&selected).unwrap(),
            canon(
                json!({ "select": "from docs collect", "effects": [effects()[1]], "expect": { "max": 3 } })
            )
        );
        let bounded = json!({ "effects": [], "selection": { "query": "from docs collect", "expect": { "max": 9 }, "templates": [effects()[1]], "cardinality": 3 } });
        assert_eq!(
            replan(&bounded).unwrap(),
            canon(
                json!({ "select": "from docs collect", "effects": [effects()[1]], "expect": { "max": 9 } })
            )
        );
        // The digest form's mismatch: the request as given.
        let e = attach(
            "execute",
            &json!({ "plan_id": "old", "effects": effects(), "reason": "r" }),
            err(
                "plan_mismatch",
                json!({ "expected": "old", "actual": "new" }),
            ),
            none,
        );
        assert_eq!(fix_of(&e).unwrap(), canon(json!({ "effects": effects() })));
        let e = attach(
            "execute",
            &json!({ "plan_id": "old", "select": "from docs collect", "effects": [effects()[1]], "expect": { "max": 2 } }),
            err(
                "plan_mismatch",
                json!({ "expected": "old", "actual": "new" }),
            ),
            none,
        );
        assert_eq!(
            fix_of(&e).unwrap(),
            canon(
                json!({ "select": "from docs collect", "effects": [effects()[1]], "expect": { "max": 2 } })
            )
        );
    }

    #[test]
    fn a_symbol_before_its_create_moves_the_create_first_and_renames_it() {
        let args = json!({ "effects": [
            { "op": "insert", "into": { "kind": "document", "path": "a.md" }, "markdown": "x" },
            { "op": "insert", "into": { "kind": "document", "id": "$new.3" }, "markdown": "y" },
            { "op": "create", "path": "c.md", "markdown": "# C" }
        ] });
        // One symbol allocated by effect 0; the create moved before effect 1
        // allocates `$new.1`, and the insert names it so.
        let e = attach(
            "plan",
            &args,
            err(
                "target_missing",
                json!({ "symbol": "$new.3", "effect_index": 1 }),
            ),
            Some,
        );
        let fixed = json!([
            args["effects"][0],
            args["effects"][2],
            { "op": "insert", "into": { "kind": "document", "id": "$new.1" }, "markdown": "y" },
        ]);
        assert_eq!(fix_of(&e).unwrap(), canon(json!({ "effects": fixed })));
        // A symbol an earlier effect DID allocate (the wrong kind) is not reordered.
        let e = attach(
            "plan",
            &args,
            err(
                "target_missing",
                json!({ "symbol": "$new.0", "effect_index": 1 }),
            ),
            Some,
        );
        assert_eq!(fix_of(&e), None);
        // No later create: nothing to teach.
        let e = attach(
            "plan",
            &json!({ "effects": [args["effects"][1]] }),
            err(
                "target_missing",
                json!({ "symbol": "$new.3", "effect_index": 0 }),
            ),
            |_| Some(0),
        );
        assert_eq!(fix_of(&e), None);
    }

    #[test]
    fn selector_requests_are_decorated_with_their_origins() {
        let req = Request {
            select: Some(json!("from docs collect")),
            effects: json!([{ "op": "insert", "into": "-> project", "markdown": "x" }]),
            expect: Some(json!({ "max": 5 })),
        };
        let origins = [Origin {
            row_id: "d_2".into(),
            template_index: 0,
        }];
        // The catalog leaves a selector request's planning errors to the selector.
        let e = attach(
            "apply",
            &json!({ "select": "from docs collect", "effects": req.effects, "expect": { "max": 5 } }),
            err("conflicting_effects", json!({ "effects": [0, 1] })),
            none,
        );
        assert_eq!(fix_of(&e), None);
        // A stale revision under a selector repins the TEMPLATE.
        let e = planning_fix(
            &req,
            err(
                "stale_plan",
                json!({ "current": { "revision": "r_2" }, "effect_index": 3, "template_index": 0, "row": { "id": "d_2", "path": "/w.md" } }),
            ),
            Some(&origins),
            none,
        );
        let mut repinned = req.effects.clone();
        repinned[0]["expect"] = json!({ "revision": "r_2" });
        assert_eq!(
            fix_of(&e).unwrap(),
            canon(
                json!({ "select": "from docs collect", "effects": repinned, "expect": { "max": 5 } })
            )
        );
    }

    #[test]
    fn an_ambiguous_slot_takes_the_first_identity() {
        let req = Request {
            select: Some(json!("from docs collect")),
            effects: json!([{ "op": "insert", "into": "-> project", "markdown": "x" }]),
            expect: Some(json!({ "max": 5 })),
        };
        assert_eq!(
            ambiguous_slot(&req, "effects[0].into", "d_7", ("docs", "d_2")).unwrap(),
            canon(
                json!({ "select": "from docs where id == \"d_2\"", "effects": [{ "op": "insert", "into": "d_7", "markdown": "x" }], "expect": { "max": 1 } })
            )
        );
        let plain = Request {
            select: None,
            effects: json!([{ "op": "set", "target": { "kind": "document", "path": "-> project" }, "field": "frontmatter.k", "value": 1 }]),
            expect: None,
        };
        assert_eq!(
            ambiguous_slot(&plain, "effects[0].target.path", "/p.md", ("docs", "d_2")).unwrap(),
            canon(
                json!({ "effects": [{ "op": "set", "target": { "kind": "document", "path": "/p.md" }, "field": "frontmatter.k", "value": 1 }] })
            )
        );
        assert_eq!(
            ambiguous_slot(&plain, "effects[3].x", "y", ("docs", "d")),
            None
        );
    }

    #[test]
    fn bounds_and_roots() {
        let req = Request {
            select: Some(json!("from docs collect")),
            effects: json!([effects()[1]]),
            expect: None,
        };
        assert_eq!(
            bounded(&req, 3),
            canon(
                json!({ "select": "from docs collect", "effects": [effects()[1]], "expect": { "max": 3 } })
            )
        );
        // The source spliced over its code-point span: `links` → `blocks`, anything else → `docs`.
        let links = Request {
            select: Some(json!("from links where x == 1 collect")),
            ..req.clone()
        };
        assert_eq!(
            root_fix(&links, "from links where x == 1 collect", (5, 10), true),
            canon(
                json!({ "select": "from blocks where x == 1 collect", "effects": [effects()[1]] })
            )
        );
        assert_eq!(
            root_fix(&req, "from ★.y collect", (5, 8), false),
            canon(json!({ "select": "from docs collect", "effects": [effects()[1]] }))
        );
    }

    #[test]
    fn a_leader_in_a_literal_slot_is_dropped_there() {
        let req = Request {
            select: None,
            effects: json!([
                { "op": "set", "target": { "kind": "block", "id": "b_1" }, "field": "markdown", "value": "x", "expect": { "content_hash": "-> hash" } }
            ]),
            expect: None,
        };
        let mut fixed = req.effects.clone();
        fixed[0]["expect"]["content_hash"] = json!("hash");
        assert_eq!(
            literal_slot(&req, "effects[0].expect.content_hash").unwrap(),
            canon(json!({ "effects": fixed }))
        );
        assert_eq!(literal_slot(&req, "effects[0].field"), None);
        assert_eq!(
            walk_mut(&mut json!({ "a": [[1, 2]] }), "a[0][1]").cloned(),
            Some(json!(2))
        );
    }

    #[test]
    fn other_tools_and_other_errors_pass_through() {
        let e = attach(
            "blocks_read",
            &json!({}),
            err("doc_missing", json!({ "doc": "x" })),
            none,
        );
        assert_eq!(fix_of(&e), None);
        let e = attach(
            "apply",
            &json!({ "effects": [] }),
            err("doc_missing", json!({ "doc": "x" })),
            none,
        );
        assert_eq!(fix_of(&e), None);
        let bare = attach(
            "apply",
            &json!({}),
            SurfaceError::new("doc_missing", "m"),
            none,
        );
        assert_eq!(bare.data, None);
        // A fix already set (the selector's) is kept.
        let e = attach(
            "apply",
            &json!({ "effects": effects() }),
            err(
                "conflicting_effects",
                json!({ "effects": [0, 1], "fix": "kept" }),
            ),
            none,
        );
        assert_eq!(fix_of(&e).unwrap(), "kept");
    }

    #[test]
    fn the_append_tools_spell_their_calls() {
        assert_eq!(
            append_after("b_parent", "b_leaf", "more"),
            "blocks_insert {\"at\":{\"after\":\"b_leaf\"},\"markdown\":\"more\",\"to\":\"b_parent\"}"
        );
        assert_eq!(
            append_without_section(None, Some("/a.md"), "t"),
            "docs_append {\"path\":\"/a.md\",\"text\":\"t\"}"
        );
        assert_eq!(
            append_into_heading("b_h", "t"),
            "blocks_append {\"id\":\"b_h\",\"text\":\"t\"}"
        );
    }
}
