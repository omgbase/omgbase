//! Query-directed planning (`spec/mutate/README.md` §11.8, mutate 3.1;
//! `spec/surface` 4.1): an OQX **selector** plus effect **templates** compiled
//! into the concrete effect list the planner lowers. The selector is a
//! producer of effects, never a second write engine — the plan that comes
//! out has today's shape plus a frozen [`Selection`]. The reference is
//! `packages/core/src/mutate/select.ts`; every rule and message here mirrors
//! it.
//!
//! **Pipeline.** `parse(select)` → `check_root_spellings` → the static
//! admission ([`compile`]: consumer, root, clauses, reserved aliases, the
//! templates' shapes) → the **AST rewrite** (one select item per `{ oqx }`
//! slot appended **after** the user's items, named `__omg_sel_<t>_<slot>`,
//! on the raw tree so the runner's `resolve_aliases` inlines a user alias a
//! template reads) → the runner's AST entry ([`crate::query::query_ast`],
//! `limit = bound + 1`) → the hits → the row binding ([`bind`]: hits in
//! result order × templates in order, `k = h·T + t`), which the store's
//! lowering loop consumes **unchanged**, so the conflict tracker gives the
//! cross-hit semantics for free (two hits writing one scalar with equal
//! values dedupe with a diagnostic, different values are
//! `conflicting_effects`, inserts into one shared target are positional in
//! hit order).
//!
//! **Expressions.** OQX has no expression entry point: each `{ oqx: e }` is
//! parsed through the wrapper `select __omg_x: <e> from docs` and its one
//! item taken — a top-level item is scope depth 1, exactly the hit's scope,
//! so `^` and `N^` validate as they will evaluate. Parse-error offsets are
//! shifted back by the wrapper's head (16 code points).
//!
//! **Binding** (§11.8's table). A template's primary target that is absent
//! (`target` / `into` / `targets`) is the hit by the root's kind (`document`
//! / `block` / `node`; `targets` → the one-element list); a `{ kind, id: {
//! oqx } }` or `{ kind: "document", path: { oqx } }` slot evaluates to a
//! string (that member as written) or a row-as-value `{ id, path }` (→ `{
//! kind, id }` whichever member held the expression); absent / `null` / `[]`
//! → `target_missing { effect_index, template_index, row, expression }`; a
//! list of one or more → **new** `ambiguous_target { …, count }` (a
//! one-element list is still a list); any other type → `filter_invalid {
//! hint: "selection" }`. `at.before` / `at.after`, `markdown`, `to`, `path`,
//! `separator` must be strings; `value` and a `create`'s top-level
//! frontmatter values may be any JSON as the runner rendered it (a row value
//! lands as the record `{ id, path }`), never absent. Every error raised from
//! an expanded effect carries `effect_index` (the expanded position) plus
//! `template_index` and `row`.
//!
//! **Sugar** (`spec/mutate` §11.8 "Sugar", 3.2). In every expression slot a
//! JSON string beginning exactly [`LEADER`] (`-> `) desugars to `{ oqx: rest
//! }` before the admission — typing follows the value as `{ oqx }` does; a
//! string not beginning `-> ` is literal, always (no escaping, no `${`
//! scanning; `-> "-> …"` spells a literal that begins with the leader). A
//! leader whose expression is a bare string literal or a template literal
//! without an interpolation **folds** to the plain literal before planning
//! (`-> "x"` and `"x"` give one `plan_id`). A **bare target** string (with or
//! without a selector) normalizes before resolution: a path-looking string
//! (a `/` or ending `.md`) is `{ kind: "document", path }`, a `b_` / `d_` /
//! `n_` id its kind, `"$new.n"` the symbol's kind (an `into` is settled from
//! the prefix plan's `new_ids`, [`settle_into_symbols`]), `"-> expr"` the
//! identity the value names (a row → kind by id prefix, a path string → a
//! document), a `#` locator is refused with a fix. **Without a selector** a
//! `-> ` / `{ oqx }` slot evaluates in its own target's row scope: the
//! effects are grouped by resolved target identity and one synthetic query
//! per identity (`from <root> where id == "<id>"`, the slot items appended as
//! `__omg_sel_<effectIndex>_<slot>`) runs through the AST runner; the plan
//! has no `selection`, `planner_v` stays p3 and the intent record gains
//! `templates` (the effects as written) — a plain request without the leader
//! produces none, so no existing digest moves. A `-> ` slot on a `create`
//! without a selector, a `-> ` target without a selector, an unparsable
//! expression (offsets relative to the slot string, past the leader) and a
//! leader in `expect` / `field` / `op` are `filter_invalid { hint:
//! "selection" }`.
//!
//! **Cardinality.** `expect.max` (a non-negative integer; required on a
//! one-shot `apply`, optional on `plan` / `execute`) bounds the selection; the
//! query runs with `limit = max + 1` (or `SELECTION_CEILING + 1` without a
//! `max`) and more hits than the bound is `selection_too_large { cardinality,
//! max, implicit? }` — the engine never plans a partial set. Zero hits are a
//! plan with no effects (execute / apply → `commit: null`).

use std::collections::HashMap;

use omgbase_mutate::effects::{SELECTION_CEILING, Selection, SelectionExpect, js_number};
use omgbase_mutate::{Effect, ErrorCode, MutationError, ParentRow, ShapeError, ShapeFixContext};
use omgbase_store::effects_plan::PlanContext;
use omgbase_store::mutate::is_id_ref;
use omgbase_store::{DocStore, Store};
use oqx::Consumer;
use oqx::ast::{Expr, Query, SelectItem, TemplatePart};
use serde_json::{Map, Value as Json, json};

use crate::context::{SemanticVec, Target};
use crate::dates;
use crate::error::{Result, SurfaceError};
use crate::fixes;
use crate::names;
use crate::paths::storage_path;
use crate::planner::root_target;
use crate::query::{
    HIT_ID, HIT_PATH, QueryOptions, RESERVED_ALIAS_PREFIXES, TUPLE_HINT, bracket_list_as_tuple,
    check_reserved_aliases, check_root_spellings, query_ast,
};

/// The `hint` of every `filter_invalid` the selector admission raises.
pub const HINT: &str = "selection";
/// The prefix of the slot projections the rewrite appends: `__omg_sel_<t>_<slot>`.
pub const SLOT_PREFIX: &str = "__omg_sel_";
const WRAP_HEAD: &str = "select __omg_x: ";
const WRAP_TAIL: &str = " from docs";
/// The stand-in a slot takes in the template's static shape check (the
/// reference's `$sel`).
const PROBE: &str = "$sel";
const OPS: &str = "create/insert/set/unset/move/remove/split/merge";
/// §11.8 "Sugar" (3.2): the leader a string slot begins with to be an
/// expression — exactly dash, greater-than, space.
pub const LEADER: &str = "-> ";

/// The admission pass's refusal: `filter_invalid { reason, hint: "selection" }`
/// (the reference's `selectionInvalid`), with extra `data` members when given.
fn refused_with(message: impl Into<String>, extra: Json) -> SurfaceError {
    let message = message.into();
    let mut data = json!({ "reason": message, "hint": HINT });
    if let (Some(d), Some(x)) = (data.as_object_mut(), extra.as_object()) {
        for (k, v) in x {
            d.insert(k.clone(), v.clone());
        }
    }
    SurfaceError::with_data("filter_invalid", message, data)
}

fn refused(message: impl Into<String>) -> SurfaceError {
    refused_with(message, json!({}))
}

/// A §11.1 shape error of a template (probe) or an expanded effect: the
/// ordinary `filter_invalid { hint: "arguments" }` naming `effects[i]`.
fn shape_error(message: String) -> SurfaceError {
    SurfaceError::filter_invalid(message, "arguments")
}

/// A shape error with its `fix` (§8, 3.4) when the shape check spelled one.
fn shape_error_of(e: ShapeError) -> SurfaceError {
    let mut err = shape_error(e.message);
    if let Some(fix) = e.fix
        && let Some(d) = err.data.as_mut().and_then(Json::as_object_mut)
    {
        d.insert("fix".to_owned(), json!(fix));
    }
    err
}

/// The live-row lookup behind the anchor fix (§8, 3.4; the reference's
/// `parentLookup`): a block's parent id (`None` at the top level) and its
/// document's path, from the `blocks` row that is not deleted; `None` for an
/// id the store does not know (a `$new.n`, a typo) — then there is no fix.
fn parent_lookup(store: &Store) -> impl Fn(&str) -> Option<ParentRow> + '_ {
    move |id: &str| {
        store
            .conn()
            .query_row(
                "SELECT b.parent_block, d.path FROM blocks b JOIN docs d ON d.doc_id = b.doc_id WHERE b.block_id = ? AND b.deleted_commit IS NULL",
                [id],
                |row| {
                    Ok(ParentRow {
                        parent: row.get(0)?,
                        path: row.get(1)?,
                    })
                },
            )
            .ok()
    }
}

/// A template's `into` is bound per hit, so the anchor fix (a parent lookup)
/// does not apply under a selector: `parent_of` finds nothing.
fn no_parent(_: &str) -> Option<ParentRow> {
    None
}

/// The shape check's context over a request (the reference's
/// `ShapeFixContext`): the request as written and a row lookup.
fn shape_fix<'a>(
    request: &'a fixes::Request,
    parent_of: &'a dyn Fn(&str) -> Option<ParentRow>,
) -> ShapeFixContext<'a> {
    ShapeFixContext {
        select: request.select.as_ref(),
        effects: &request.effects,
        expect: request.expect.as_ref(),
        parent_of,
    }
}

/// The plain `effects` of a request (no selector, no sugar: the catalog's
/// `parse_effects` path) shape-checked with the §8 fixes of 3.4 — the
/// reference's `compilePlain` over effects without an expression, where the
/// fix context reads the store for the anchor fix.
pub fn validate_plain(store: &Store, effects: &Json) -> Result<Vec<Effect>> {
    let list = effects
        .as_array()
        .ok_or_else(|| shape_error("`effects` must be an array of effects".to_owned()))?;
    if list.is_empty() {
        return Err(shape_error(
            "`effects` must name at least one effect".to_owned(),
        ));
    }
    let request = fixes::Request {
        select: None,
        effects: effects.clone(),
        expect: None,
    };
    let lookup = parent_lookup(store);
    let fix = shape_fix(&request, &lookup);
    list.iter()
        .enumerate()
        .map(|(i, e)| Effect::validate_with(e, i, Some(&fix)).map_err(shape_error_of))
        .collect()
}

// ---- sugar (§11.8 "Sugar", 3.2) --------------------------------------------------------

/// The expression a `-> ` string spells (`None`: not a string, or a string
/// that does not begin exactly with the leader — `->x`, ` -> x`, `-->` and a
/// mid-string `-> ` are literals).
fn leader_of(v: &Json) -> Option<&str> {
    v.as_str()?.strip_prefix(LEADER)
}

/// A string anywhere under `v` begins with the leader.
fn contains_leader(v: &Json) -> bool {
    match v {
        Json::String(_) => leader_of(v).is_some(),
        Json::Array(a) => a.iter().any(contains_leader),
        Json::Object(o) => o.values().any(contains_leader),
        _ => false,
    }
}

/// A path-looking string: contains `/` or ends `.md` (the reference's
/// `looksLikePath`).
fn path_looking(s: &str) -> bool {
    s.contains('/') || s.ends_with(".md")
}

/// A node id: `n_` + 12 lower-case hex (the reference's `NODE_ID_RE`).
fn is_node_id(s: &str) -> bool {
    s.len() == 14
        && s.starts_with("n_")
        && s[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A bare id of the three target kinds (the reference's `isTargetId`; the
/// `b_` / `d_` rule is the reference's `ID_RE` — one to seven alphabet
/// characters, so the fixture minter's `b_5` is an id too).
fn is_target_id(s: &str) -> bool {
    is_id_ref(s, "b") || is_id_ref(s, "d") || is_node_id(s)
}

/// Which target member a bare string sits in: the member decides the
/// provisional kind a `$new.n` takes until the symbol table settles it (an
/// `into` is ambiguous — document or block; `set`'s follows its field;
/// `targets[k]` is a block).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Member {
    Target,
    Into,
    Targets(usize),
}

/// The provisional kind of a bare `$new.n` in `member` — always one the
/// slot admits, so the first shape check passes and the settled kind is
/// what the slot's kind table judges ([`finish`]).
fn symbol_kind(member: Member, op: &str, field: Option<&str>) -> &'static str {
    match member {
        Member::Targets(_) => "block",
        Member::Into => "document",
        Member::Target => match op {
            "split" => "block",
            "set" => match field {
                Some(f) if f == "markdown" || f == "attrs.checked" => "block",
                _ => "document",
            },
            _ => "document",
        },
    }
}

/// A bare target string → the target object (the reference's `bareTarget`,
/// in its order): a `#` anywhere is a locator (`filter_invalid { hint:
/// "arguments", fix }`), a `$new.n` the symbol (provisional kind), a `b_` /
/// `d_` id by validity, an `n_` id, a path-looking string a document by
/// path; anything else is no target (hint `arguments`).
fn bare_target(s: &str, here: &str, member: Member, op: &str, field: Option<&str>) -> Result<Json> {
    if s.contains('#') {
        let message = format!(
            "{here}: {} is a locator, not a target — a bare target is a document path, a `b_`/`d_`/`n_` id or `$new.n`",
            Json::String(s.to_owned())
        );
        return Err(SurfaceError::with_data(
            "filter_invalid",
            message.clone(),
            json!({ "reason": message, "hint": "arguments", "fix": crate::fixes::LOCATOR }),
        ));
    }
    if omgbase_mutate::parse_new_symbol(s).is_some() {
        return Ok(json!({ "kind": symbol_kind(member, op, field), "id": s }));
    }
    if is_id_ref(s, "b") {
        return Ok(json!({ "kind": "block", "id": s }));
    }
    if is_id_ref(s, "d") {
        return Ok(json!({ "kind": "document", "id": s }));
    }
    if is_node_id(s) {
        return Ok(json!({ "kind": "node", "id": s }));
    }
    if path_looking(s) {
        return Ok(json!({ "kind": "document", "path": s }));
    }
    Err(shape_error(format!(
        "{here}: a target is {{ kind: …, … }} or a bare document path, a `b_`/`d_`/`n_` id or `$new.n` (got {})",
        Json::String(s.to_owned())
    )))
}

/// `"-> <expr>"` → `{ oqx: "<expr>" }`, or the folded literal when the
/// expression is a bare string literal or a template literal without an
/// interpolation (the reference's `desugarLeader`). A parse error is
/// `filter_invalid { hint: "selection" }` with its offset counted from the
/// start of the written string (past the leader).
fn desugar_expression(src: &str, here: &str) -> Result<Json> {
    let wrapped = format!("{WRAP_HEAD}{src}{WRAP_TAIL}");
    let head = WRAP_HEAD.chars().count();
    let shift = LEADER.chars().count() as isize - head as isize;
    let q = oqx::parse_string(&wrapped)
        .map_err(|e| refused(format!("{here}: {}", shift_offsets(&e.message, shift))))?;
    let one = q.select.len() == 1
        && matches!(&q.source, Expr::Ident { name, .. } if name == "docs")
        && q.from.is_empty()
        && q.r#where.is_none()
        && q.order_by.is_none()
        && q.follow.is_none()
        && q.frontier.is_none()
        && q.limit.is_none()
        && q.offset.is_none()
        && !q.distinct
        && !q.values
        && q.consumer == Consumer::Collect;
    if !one {
        return Err(refused(format!(
            "{here}: `oqx` must be one expression over the hit, not a query"
        )));
    }
    let folded = match q.select.first() {
        Some(SelectItem::Field { expr, .. }) => match expr {
            Expr::Lit {
                value: oqx::Value::Str(text),
                ..
            } => Some(text.clone()),
            Expr::Template { parts, .. } if parts.len() == 1 => match &parts[0] {
                TemplatePart::Text(text) => Some(text.clone()),
                TemplatePart::Expr(_) => None,
            },
            _ => None,
        },
        _ => None,
    };
    Ok(match folded {
        Some(text) => Json::String(text),
        None => json!({ "oqx": src }),
    })
}

/// The literal a `-> ` string reads as when its leader is dropped (the
/// reference's `literalOf`): a quoted string or an interpolation-free
/// template folds to its text; anything else is the rest of the string.
pub(crate) fn literal_of(src: &str) -> String {
    match desugar_expression(src, "") {
        Ok(Json::String(text)) => text,
        _ => src.to_owned(),
    }
}

/// What the desugar of one effect saw: the target members written as a
/// bare `$new.n` (provisional kinds, settled against the symbol table).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Desugared {
    symbols: Vec<Member>,
}

/// A `-> ` string where no expression is admitted — anywhere under `v`
/// (the reference's `refuseLeader`). The fix (3.3): the literal form, the
/// same request with the leader dropped from that member.
fn refuse_leader(v: &Json, here: &str, request: Option<&fixes::Request>) -> Result<()> {
    match v {
        Json::String(_) if leader_of(v).is_some() => {
            let message =
                format!("{here}: `-> ` is not allowed here — this member takes no expression");
            Err(match request.and_then(|r| fixes::literal_slot(r, here)) {
                Some(fix) => refused_with(message, json!({ "fix": fix })),
                None => refused(message),
            })
        }
        Json::Array(a) => a
            .iter()
            .enumerate()
            .try_for_each(|(k, x)| refuse_leader(x, &format!("{here}[{k}]"), request)),
        Json::Object(o) => o
            .iter()
            .try_for_each(|(k, x)| refuse_leader(x, &format!("{here}.{k}"), request)),
        _ => Ok(()),
    }
}

/// The desugar of one effect as written (the reference's `desugarEffect`):
/// in the slots of its op a leader becomes `{ oqx }` or folds, a bare target
/// string normalizes ([`bare_target`]; a leader target is the whole-target
/// directive, a folded one a bare string), and a leader anywhere else —
/// `op`, `field`, `expect`, a target's other members, a whole `at`, an
/// unknown key — is refused. An unknown `op` is left for the shape check.
fn desugar_effect(
    raw: &Json,
    index: usize,
    request: Option<&fixes::Request>,
) -> Result<(Json, Desugared)> {
    let mut d = Desugared::default();
    let Some(o) = raw.as_object() else {
        return Ok((raw.clone(), d));
    };
    let Some(op) = o.get("op").and_then(Json::as_str).map(str::to_owned) else {
        return Ok((raw.clone(), d));
    };
    let here = format!("effects[{index}]");
    let field = o.get("field").and_then(Json::as_str).map(str::to_owned);
    let mut out = o.clone();
    let mut slot_keys: Vec<&str> = vec!["op"];

    fn leader_at(
        out: &mut Map<String, Json>,
        slot_keys: &mut Vec<&str>,
        key: &'static str,
        here: &str,
    ) -> Result<()> {
        slot_keys.push(key);
        if let Some(src) = out.get(key).and_then(leader_of).map(str::to_owned) {
            let v = desugar_expression(&src, &format!("{here}.{key}"))?;
            out.insert(key.to_owned(), v);
        }
        Ok(())
    }
    // One target member: a bare string normalizes (a leader → the whole-target
    // directive, or its folded literal normalized); an object's `id` / `path`
    // take a leader, its other members may not.
    fn one_target(
        v: &Json,
        here: &str,
        member: Member,
        op: &str,
        field: Option<&str>,
        d: &mut Desugared,
        request: Option<&fixes::Request>,
    ) -> Result<Json> {
        match v {
            Json::String(s) => {
                let literal = match leader_of(v) {
                    Some(src) => match desugar_expression(src, here)? {
                        Json::String(folded) => folded,
                        directive => return Ok(directive),
                    },
                    None => s.clone(),
                };
                let t = bare_target(&literal, here, member, op, field)?;
                if omgbase_mutate::parse_new_symbol(&literal).is_some() {
                    d.symbols.push(member);
                }
                Ok(t)
            }
            Json::Object(t) => {
                let mut out = t.clone();
                for m in ["id", "path"] {
                    if let Some(src) = t.get(m).and_then(leader_of) {
                        let v = desugar_expression(src, &format!("{here}.{m}"))?;
                        out.insert(m.to_owned(), v);
                    }
                }
                for (k, x) in t {
                    if k != "id" && k != "path" {
                        refuse_leader(x, &format!("{here}.{k}"), request)?;
                    }
                }
                Ok(Json::Object(out))
            }
            other => Ok(other.clone()),
        }
    }
    let target = |out: &mut Map<String, Json>,
                  slot_keys: &mut Vec<&str>,
                  key: &'static str,
                  member: Member,
                  d: &mut Desugared|
     -> Result<()> {
        slot_keys.push(key);
        if let Some(v) = out.get(key).cloned() {
            let t = one_target(
                &v,
                &format!("{here}.{key}"),
                member,
                &op,
                field.as_deref(),
                d,
                request,
            )?;
            out.insert(key.to_owned(), t);
        }
        Ok(())
    };
    let targets =
        |out: &mut Map<String, Json>, slot_keys: &mut Vec<&str>, d: &mut Desugared| -> Result<()> {
            slot_keys.push("targets");
            if let Some(Json::Array(list)) = out.get("targets").cloned() {
                let mut items = Vec::with_capacity(list.len());
                for (k, v) in list.iter().enumerate() {
                    items.push(one_target(
                        v,
                        &format!("{here}.targets[{k}]"),
                        Member::Targets(k),
                        &op,
                        field.as_deref(),
                        d,
                        request,
                    )?);
                }
                out.insert("targets".to_owned(), Json::Array(items));
            }
            Ok(())
        };
    let at = |out: &mut Map<String, Json>, slot_keys: &mut Vec<&str>| -> Result<()> {
        slot_keys.push("at");
        let Some(a) = out.get("at").cloned() else {
            return Ok(());
        };
        let Some(a) = a.as_object() else {
            return refuse_leader(&a, &format!("{here}.at"), request);
        };
        let mut next = a.clone();
        for m in ["before", "after"] {
            if let Some(src) = a.get(m).and_then(leader_of) {
                let v = desugar_expression(src, &format!("{here}.at.{m}"))?;
                next.insert(m.to_owned(), v);
            }
        }
        for (k, x) in a {
            if k != "before" && k != "after" {
                refuse_leader(x, &format!("{here}.at.{k}"), request)?;
            }
        }
        out.insert("at".to_owned(), Json::Object(next));
        Ok(())
    };
    match op.as_str() {
        "create" => {
            leader_at(&mut out, &mut slot_keys, "path", &here)?;
            leader_at(&mut out, &mut slot_keys, "markdown", &here)?;
            slot_keys.push("frontmatter");
            if let Some(Json::Object(fm)) = o.get("frontmatter") {
                let mut next = fm.clone();
                for (k, v) in fm {
                    if let Some(src) = leader_of(v) {
                        let x = desugar_expression(src, &format!("{here}.frontmatter.{k}"))?;
                        next.insert(k.clone(), x);
                    }
                }
                out.insert("frontmatter".to_owned(), Json::Object(next));
            }
        }
        "insert" => {
            target(&mut out, &mut slot_keys, "into", Member::Into, &mut d)?;
            at(&mut out, &mut slot_keys)?;
            leader_at(&mut out, &mut slot_keys, "markdown", &here)?;
        }
        "set" => {
            target(&mut out, &mut slot_keys, "target", Member::Target, &mut d)?;
            leader_at(&mut out, &mut slot_keys, "value", &here)?;
        }
        "unset" => target(&mut out, &mut slot_keys, "target", Member::Target, &mut d)?,
        "move" => {
            if o.contains_key("targets") || o.contains_key("into") {
                targets(&mut out, &mut slot_keys, &mut d)?;
                target(&mut out, &mut slot_keys, "into", Member::Into, &mut d)?;
                at(&mut out, &mut slot_keys)?;
            } else {
                target(&mut out, &mut slot_keys, "target", Member::Target, &mut d)?;
                leader_at(&mut out, &mut slot_keys, "to", &here)?;
            }
        }
        "remove" => {
            if o.contains_key("targets") {
                targets(&mut out, &mut slot_keys, &mut d)?;
            } else {
                target(&mut out, &mut slot_keys, "target", Member::Target, &mut d)?;
            }
        }
        // `at` is byte offsets: no expression
        "split" => target(&mut out, &mut slot_keys, "target", Member::Target, &mut d)?,
        "merge" => {
            targets(&mut out, &mut slot_keys, &mut d)?;
            leader_at(&mut out, &mut slot_keys, "separator", &here)?;
        }
        // not row-shaped: no slot
        "retarget" => {}
        // an unknown op: the shape check names it
        _ => return Ok((Json::Object(out), d)),
    }
    for (key, v) in o {
        if !slot_keys.contains(&key.as_str()) {
            refuse_leader(v, &format!("{here}.{key}"), request)?;
        }
    }
    Ok((Json::Object(out), d))
}

/// Does a request's `effects` carry any sugar — a bare string target, a `-> `
/// leader anywhere, or an `{ oqx }` directive — so that a selector-less
/// call must take the sugar path instead of the plain `effects` one? (The
/// reference always desugars; without sugar the desugar is the identity, so
/// the plain path stays byte-identical.)
fn needs_sugar(effects: &Json) -> bool {
    let Some(list) = effects.as_array() else {
        return false;
    };
    list.iter().any(|e| {
        let Some(o) = e.as_object() else {
            return false;
        };
        o.get("target").is_some_and(Json::is_string)
            || o.get("into").is_some_and(Json::is_string)
            || o.get("targets")
                .and_then(Json::as_array)
                .is_some_and(|a| a.iter().any(Json::is_string))
            || contains_leader(e)
            || contains_oqx(e)
    })
}

// ---- the request ----------------------------------------------------------------------

/// `plan` / `apply` / `execute` with a `select` — the selector, the
/// templates (the call's `effects`) and the optional bound, as given — or,
/// since 3.2, a selector-less call whose `effects` carry sugar (`select` is
/// `null`: the effects are desugared and their `-> ` / `{ oqx }` slots
/// evaluated in their own targets' row scopes).
#[derive(Clone, Debug, PartialEq)]
pub struct SelectRequest {
    pub select: Json,
    pub templates: Json,
    pub expect: Option<Json>,
}

impl SelectRequest {
    /// Read a tool's or a fixture step's arguments: `None` when the call
    /// names neither `select` nor `expect` and its `effects` carry no sugar
    /// (the plain `effects` path, untouched); `expect` without `select` is
    /// refused as the reference's planner refuses it. Nothing else is
    /// checked here — [`compile`] does, in the reference's order.
    pub fn from_args(args: &Json) -> Result<Option<Self>> {
        let select = args.get("select").filter(|v| !v.is_null());
        let expect = args.get("expect").filter(|v| !v.is_null());
        let effects = args.get("effects").cloned().unwrap_or(Json::Null);
        if select.is_none() && expect.is_none() {
            if needs_sugar(&effects) {
                return Ok(Some(Self {
                    select: Json::Null,
                    templates: effects,
                    expect: None,
                }));
            }
            return Ok(None);
        }
        let Some(select) = select else {
            return Err(refused(
                "`expect` bounds a selection — pass `select` with it",
            ));
        };
        Ok(Some(Self {
            select: select.clone(),
            templates: effects,
            expect: expect.cloned(),
        }))
    }

    /// The call names a selector (else it is the selector-less sugar path).
    #[must_use]
    pub fn has_selector(&self) -> bool {
        !self.select.is_null()
    }

    /// The selector as given, when it is a string.
    #[must_use]
    pub fn select_str(&self) -> &str {
        self.select.as_str().unwrap_or_default()
    }

    /// How many templates were given (0 unless an array).
    #[must_use]
    pub fn templates(&self) -> usize {
        self.templates.as_array().map_or(0, Vec::len)
    }
}

/// `expect`: absent, or `{ max: <non-negative integer> }` and nothing else.
fn validate_expect(v: Option<&Json>) -> Result<Option<SelectionExpect>> {
    let Some(v) = v else {
        return Ok(None);
    };
    let obj = v
        .as_object()
        .ok_or_else(|| refused("`expect` must be an object { max }"))?;
    let extra: Vec<String> = obj
        .keys()
        .filter(|k| *k != "max")
        .map(|k| format!("`{k}`"))
        .collect();
    if !extra.is_empty() {
        return Err(refused(format!(
            "`expect`: unknown key{} {}",
            if extra.len() > 1 { "s" } else { "" },
            extra.join(", ")
        )));
    }
    let max = obj
        .get("max")
        .and_then(Json::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| refused("`expect.max` must be a non-negative integer"))?;
    Ok(Some(SelectionExpect { max }))
}

// ---- templates -------------------------------------------------------------------------

/// What a slot's value must be, and how it lands.
#[derive(Clone, Debug, PartialEq, Eq)]
enum SlotKind {
    /// A target's `id` or `path` member (`target` / `into`): a string lands
    /// as that member, a row ref as `id`.
    Identity { key: String, member: String },
    /// `targets[k].id`.
    TargetsIdentity { k: usize },
    /// A whole target (`target` / `into`) as one expression (3.2): the value
    /// names the identity — a row by its id, a string as [`bare_target`]
    /// reads it.
    WholeTarget { key: String, member: Member },
    /// `targets[k]` as one expression: a block.
    WholeTargets { k: usize },
    /// `markdown`, `to`, `path`, `separator` — a top-level string member.
    Str { key: String },
    /// `at.before` / `at.after`.
    At { member: String },
    /// `value`: any JSON, never absent.
    Value,
    /// A `create`'s `frontmatter.<key>`: any JSON, never absent.
    Frontmatter { key: String },
}

#[derive(Clone, Debug)]
struct Slot {
    /// The suffix of the reserved item name (`target`, `into`, `markdown`,
    /// `fm_<j>`, `targets_<k>`, `at`, …).
    name: String,
    kind: SlotKind,
    /// `effects[t].<path>` for messages.
    here: String,
    expression: String,
    /// The parsed item (a field or a value-position directive), renamed on
    /// the rewrite.
    item: SelectItem,
}

/// Where the hit's identity lands when the template names no primary target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DefaultTarget {
    Target,
    Into,
    Targets,
}

/// One admitted template: the template with every slot removed (the binder
/// copies it and fills the slots), its slots, the default target and the
/// target members written as a bare `$new.n`.
#[derive(Clone, Debug)]
pub struct Template {
    index: usize,
    base: Map<String, Json>,
    slots: Vec<Slot>,
    default_target: Option<DefaultTarget>,
    symbols: Vec<Member>,
    op: String,
}

impl Template {
    /// The slot projections this template appends, in order.
    #[must_use]
    pub fn slot_names(&self) -> Vec<String> {
        self.slots
            .iter()
            .map(|s| slot_name(self.index, &s.name))
            .collect()
    }
}

fn slot_name(t: usize, slot: &str) -> String {
    format!("{SLOT_PREFIX}{t}_{slot}")
}

/// `{ oqx: "<expression>" }` — exactly that one key.
fn oqx_of(v: &Json) -> Option<&str> {
    let obj = v.as_object()?;
    if obj.len() != 1 {
        return None;
    }
    obj.get("oqx")?.as_str()
}

fn contains_oqx(v: &Json) -> bool {
    if oqx_of(v).is_some() {
        return true;
    }
    match v {
        Json::Array(a) => a.iter().any(contains_oqx),
        Json::Object(o) => o.values().any(contains_oqx),
        _ => false,
    }
}

/// A row rendered as a value by the runner (`{ id, path }` and nothing else,
/// `spec/surface` §1.4).
fn row_ref(v: &Json) -> Option<(&str, &str)> {
    let o = v.as_object()?;
    if o.len() != 2 {
        return None;
    }
    Some((o.get(HIT_ID)?.as_str()?, o.get(HIT_PATH)?.as_str()?))
}

/// The reference's `describeValue`.
fn describe(v: Option<&Json>) -> String {
    match v {
        None | Some(Json::Null) => "absent".to_owned(),
        Some(Json::String(s)) => format!("a string ({})", Json::String(s.clone())),
        Some(Json::Number(n)) => format!(
            "a number ({})",
            n.as_f64().map_or_else(|| n.to_string(), js_number)
        ),
        Some(Json::Bool(b)) => format!("a boolean ({b})"),
        Some(Json::Array(a)) => format!("a list of {}", a.len()),
        Some(Json::Object(_)) => "an object".to_owned(),
    }
}

/// Shift the `(at offset N)` of a parse error by `delta` (back by the
/// wrapper's head; a `-> ` slot's forward by the leader).
fn shift_offsets(message: &str, delta: isize) -> String {
    const MARK: &str = "(at offset ";
    let Some(i) = message.find(MARK) else {
        return message.to_owned();
    };
    let rest = &message[i + MARK.len()..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return message.to_owned();
    }
    let n: isize = digits.parse().unwrap_or(0);
    format!(
        "{}{MARK}{}{}",
        &message[..i],
        (n + delta).max(0),
        &rest[digits.len()..]
    )
}

/// Parse one `{ oqx }` expression through the wrapper (module docs): the one
/// select item of an otherwise empty query over `docs`.
fn parse_expression(source: &str, here: &str) -> Result<SelectItem> {
    let wrapped = format!("{WRAP_HEAD}{source}{WRAP_TAIL}");
    let head = WRAP_HEAD.chars().count();
    let mut q = oqx::parse_string(&wrapped).map_err(|e| {
        refused(format!(
            "{here}: {}",
            shift_offsets(&e.message, -(head as isize))
        ))
    })?;
    let one = q.select.len() == 1
        && matches!(&q.source, Expr::Ident { name, .. } if name == "docs")
        && q.from.is_empty()
        && q.r#where.is_none()
        && q.order_by.is_none()
        && q.follow.is_none()
        && q.frontier.is_none()
        && q.limit.is_none()
        && q.offset.is_none()
        && !q.distinct
        && !q.values
        && q.consumer == Consumer::Collect;
    if !one {
        return Err(refused(format!(
            "{here}: `oqx` must be one expression over the hit, not a query"
        )));
    }
    Ok(q.select.pop().expect("one item"))
}

fn renamed(item: &SelectItem, name: &str) -> SelectItem {
    match item {
        SelectItem::Field {
            expr, lift, span, ..
        } => SelectItem::Field {
            name: name.to_owned(),
            expr: expr.clone(),
            lift: *lift,
            span: *span,
        },
        SelectItem::Collect { op, span, .. } => SelectItem::Collect {
            name: name.to_owned(),
            op: op.clone(),
            span: *span,
        },
    }
}

/// The kind word of the hit a root yields.
fn hit_kind(root: Target) -> &'static str {
    match root {
        Target::Docs => "document",
        Target::Blocks => "block",
        Target::Nodes => "node",
        Target::Links => "link",
        Target::Revisions => "revision",
    }
}

fn hit_ref(root: Target, id: &str) -> Json {
    json!({ "kind": hit_kind(root), "id": id })
}

/// The selector-less refusal of an expression where the row would come from
/// (the reference's `needsSelector`).
fn needs_selector(where_: &str) -> SurfaceError {
    refused(format!(
        "{where_}: an expression target needs a selector — without `select` there is no row to read it from"
    ))
}

/// The reference's `admitTemplate`, member by member.
struct Admit<'a> {
    here: String,
    raw: &'a Map<String, Json>,
    root: Target,
    /// A plain effect (no selector, 3.2): an absent target is not the hit's
    /// (there is none), and an expression as the primary target is refused.
    plain: bool,
    base: Map<String, Json>,
    probe: Map<String, Json>,
    slots: Vec<Slot>,
    /// The keys the op reads (an expression anywhere else is refused).
    slot_keys: Vec<&'static str>,
}

impl Admit<'_> {
    fn push(&mut self, name: String, kind: SlotKind, at: &str, expression: &str) -> Result<()> {
        let here = format!("{}.{at}", self.here);
        let item = parse_expression(expression, &here)?;
        self.slots.push(Slot {
            name,
            kind,
            here,
            expression: expression.to_owned(),
            item,
        });
        Ok(())
    }

    /// A string-valued member that may be an expression.
    fn string_slot(&mut self, key: &'static str) -> Result<()> {
        self.slot_keys.push(key);
        let Some(src) = self.raw.get(key).and_then(oqx_of) else {
            return Ok(());
        };
        let src = src.to_owned();
        self.base.remove(key);
        self.probe.insert(key.to_owned(), json!(PROBE));
        self.push(
            key.to_owned(),
            SlotKind::Str {
                key: key.to_owned(),
            },
            key,
            &src,
        )
    }

    /// `value`: the top-level `{ oqx }` is the expression; nested ones are data.
    fn value_slot(&mut self) -> Result<()> {
        self.slot_keys.push("value");
        let Some(src) = self.raw.get("value").and_then(oqx_of) else {
            return Ok(());
        };
        let src = src.to_owned();
        self.base.remove("value");
        self.probe.insert("value".to_owned(), Json::Null);
        self.push("value".to_owned(), SlotKind::Value, "value", &src)
    }

    /// A target member: `{ kind, id: { oqx } }` or `{ kind: "document", path:
    /// { oqx } }`, or (3.2) the whole target `{ oqx }` — the identity the
    /// value names, `probe_kind` standing in for its unknown kind; absent →
    /// the hit when `defaultable` (never on a plain effect).
    fn target_slot(
        &mut self,
        key: &'static str,
        defaultable: bool,
        probe_kind: &str,
        primary: bool,
    ) -> Result<bool> {
        self.slot_keys.push(key);
        let Some(t) = self.raw.get(key) else {
            if !defaultable || self.plain {
                return Ok(false);
            }
            self.probe.insert(key.to_owned(), hit_ref(self.root, PROBE));
            return Ok(true);
        };
        if let Some(src) = oqx_of(t).map(str::to_owned) {
            if self.plain && primary {
                return Err(needs_selector(&format!("{}.{key}", self.here)));
            }
            self.base.remove(key);
            self.probe
                .insert(key.to_owned(), json!({ "kind": probe_kind, "id": PROBE }));
            let member = if key == "into" {
                Member::Into
            } else {
                Member::Target
            };
            self.push(
                key.to_owned(),
                SlotKind::WholeTarget {
                    key: key.to_owned(),
                    member,
                },
                key,
                &src,
            )?;
            return Ok(false);
        }
        if let Some(t) = t.as_object() {
            let id_x = t.get("id").and_then(oqx_of).map(str::to_owned);
            let path_x = t.get("path").and_then(oqx_of).map(str::to_owned);
            if id_x.is_some() && path_x.is_some() {
                return Err(refused(format!(
                    "{}.{key}: give `id` or `path` as an expression, not both",
                    self.here
                )));
            }
            if let Some((member, src)) = id_x
                .map(|s| ("id", s))
                .or_else(|| path_x.map(|s| ("path", s)))
            {
                if self.plain && primary {
                    return Err(needs_selector(&format!("{}.{key}", self.here)));
                }
                let mut literal = t.clone();
                literal.remove(member);
                self.base.insert(key.to_owned(), Json::Object(literal));
                if let Some(p) = self.probe.get_mut(key).and_then(Json::as_object_mut) {
                    p.insert(member.to_owned(), json!(PROBE));
                }
                self.push(
                    key.to_owned(),
                    SlotKind::Identity {
                        key: key.to_owned(),
                        member: member.to_owned(),
                    },
                    &format!("{key}.{member}"),
                    &src,
                )?;
            }
            for (k, v) in t {
                if k != "id" && k != "path" && contains_oqx(v) {
                    return Err(refused(format!(
                        "{}.{key}.{k}: `{{ oqx }}` is not allowed here",
                        self.here
                    )));
                }
            }
        }
        Ok(false)
    }

    /// `targets[]`: each element `{ kind: "block", id: { oqx } }` (or, 3.2, a
    /// whole `{ oqx }`) yields one block; absent → `[the hit]` when
    /// `defaultable`. The list is always the primary target of its op.
    fn targets_slot(&mut self, defaultable: bool) -> Result<bool> {
        self.slot_keys.push("targets");
        let Some(list) = self.raw.get("targets") else {
            if !defaultable || self.plain {
                return Ok(false);
            }
            self.probe
                .insert("targets".to_owned(), json!([hit_ref(self.root, PROBE)]));
            return Ok(true);
        };
        let Some(list) = list.as_array() else {
            return Ok(false);
        };
        for (k, t) in list.iter().enumerate() {
            if let Some(src) = oqx_of(t).map(str::to_owned) {
                if self.plain {
                    return Err(needs_selector(&format!("{}.targets[{k}]", self.here)));
                }
                if let Some(arr) = self.base.get_mut("targets").and_then(Json::as_array_mut) {
                    arr[k] = json!({});
                }
                if let Some(arr) = self.probe.get_mut("targets").and_then(Json::as_array_mut) {
                    arr[k] = json!({ "kind": "block", "id": PROBE });
                }
                self.push(
                    format!("targets_{k}"),
                    SlotKind::WholeTargets { k },
                    &format!("targets[{k}]"),
                    &src,
                )?;
                continue;
            }
            let Some(t) = t.as_object() else {
                continue;
            };
            if t.get("path").and_then(oqx_of).is_some() {
                return Err(refused(format!(
                    "{}.targets[{k}]: a block target has `id`, not `path`",
                    self.here
                )));
            }
            if let Some(src) = t.get("id").and_then(oqx_of).map(str::to_owned) {
                if self.plain {
                    return Err(needs_selector(&format!("{}.targets[{k}].id", self.here)));
                }
                let mut literal = t.clone();
                literal.remove("id");
                if let Some(arr) = self.base.get_mut("targets").and_then(Json::as_array_mut) {
                    arr[k] = Json::Object(literal);
                }
                if let Some(p) = self
                    .probe
                    .get_mut("targets")
                    .and_then(Json::as_array_mut)
                    .and_then(|a| a.get_mut(k))
                    .and_then(Json::as_object_mut)
                {
                    p.insert("id".to_owned(), json!(PROBE));
                }
                self.push(
                    format!("targets_{k}"),
                    SlotKind::TargetsIdentity { k },
                    &format!("targets[{k}].id"),
                    &src,
                )?;
            }
            for (key, v) in t {
                if key != "id" && contains_oqx(v) {
                    return Err(refused(format!(
                        "{}.targets[{k}].{key}: `{{ oqx }}` is not allowed here",
                        self.here
                    )));
                }
            }
        }
        Ok(false)
    }

    /// `at.before` / `at.after` may be an expression yielding a block id.
    fn at_slot(&mut self) -> Result<()> {
        self.slot_keys.push("at");
        let Some(at) = self.raw.get("at").and_then(Json::as_object) else {
            return Ok(());
        };
        for member in ["before", "after"] {
            let Some(src) = at.get(member).and_then(oqx_of).map(str::to_owned) else {
                continue;
            };
            self.base.insert("at".to_owned(), json!({}));
            self.probe.insert("at".to_owned(), json!({ member: PROBE }));
            self.push(
                "at".to_owned(),
                SlotKind::At {
                    member: member.to_owned(),
                },
                &format!("at.{member}"),
                &src,
            )?;
        }
        Ok(())
    }

    fn frontmatter_slots(&mut self) -> Result<()> {
        self.slot_keys.push("frontmatter");
        let Some(fm) = self.raw.get("frontmatter").and_then(Json::as_object) else {
            return Ok(());
        };
        for (j, (k, v)) in fm.iter().enumerate() {
            let Some(src) = oqx_of(v).map(str::to_owned) else {
                continue;
            };
            if let Some(b) = self
                .base
                .get_mut("frontmatter")
                .and_then(Json::as_object_mut)
            {
                b.remove(k);
            }
            if let Some(p) = self
                .probe
                .get_mut("frontmatter")
                .and_then(Json::as_object_mut)
            {
                p.insert(k.clone(), Json::Null);
            }
            self.push(
                format!("fm_{j}"),
                SlotKind::Frontmatter { key: k.clone() },
                &format!("frontmatter.{k}"),
                &src,
            )?;
        }
        Ok(())
    }
}

/// Admit `effects[t]` statically (before the query runs): a row-shaped op,
/// the `{ oqx }` directives only in the slots, every expression parseable,
/// and the template's shape valid with a probe value in each slot (§11.1's
/// `effects[i]` messages, `hint: "arguments"`). `plain` is the
/// selector-less mode (3.2); `sugar` what the desugar saw.
fn admit_template(
    index: usize,
    raw: &Json,
    root: Target,
    plain: bool,
    sugar: &Desugared,
    fix: Option<&ShapeFixContext<'_>>,
) -> Result<Template> {
    let here = format!("effects[{index}]");
    let Some(op) = raw
        .as_object()
        .and_then(|o| o.get("op"))
        .and_then(Json::as_str)
    else {
        return Err(refused(format!(
            "{here}: a template is an effect object whose `op` is one of {OPS}"
        )));
    };
    let raw = raw.as_object().expect("checked");
    if op == "retarget" {
        return Err(refused(format!(
            "{here}: `retarget` is not row-shaped — it cannot be a selector template"
        )));
    }
    if !matches!(
        op,
        "create" | "insert" | "set" | "unset" | "move" | "remove" | "split" | "merge"
    ) {
        return Err(refused(format!(
            "{here}: `op` must be one of {OPS} (got \"{op}\")"
        )));
    }
    let mut a = Admit {
        here: here.clone(),
        raw,
        root,
        plain,
        base: raw.clone(),
        probe: raw.clone(),
        slots: Vec::new(),
        slot_keys: Vec::new(),
    };
    let mut default_target = None;
    match op {
        "create" => {
            a.string_slot("path")?;
            a.string_slot("markdown")?;
            a.frontmatter_slots()?;
        }
        "insert" => {
            if a.target_slot("into", true, "document", true)? {
                default_target = Some(DefaultTarget::Into);
            }
            a.at_slot()?;
            a.string_slot("markdown")?;
        }
        "set" => {
            if a.target_slot("target", true, "document", true)? {
                default_target = Some(DefaultTarget::Target);
            }
            a.value_slot()?;
        }
        "unset" => {
            if a.target_slot("target", true, "document", true)? {
                default_target = Some(DefaultTarget::Target);
            }
        }
        "move" => {
            if raw.contains_key("into") {
                // the block form: `targets` default to the hit, `into` is the destination
                if a.targets_slot(true)? {
                    default_target = Some(DefaultTarget::Targets);
                }
                a.target_slot("into", false, "document", false)?;
                a.at_slot()?;
            } else {
                if a.target_slot("target", true, "document", true)? {
                    default_target = Some(DefaultTarget::Target);
                }
                a.string_slot("to")?;
            }
        }
        "remove" => {
            let doc_form = raw.contains_key("target")
                || (!raw.contains_key("targets") && root == Target::Docs);
            if doc_form {
                if a.target_slot("target", true, "document", true)? {
                    default_target = Some(DefaultTarget::Target);
                }
            } else if a.targets_slot(true)? {
                default_target = Some(DefaultTarget::Targets);
            }
        }
        "split" => {
            if a.target_slot("target", true, "block", true)? {
                default_target = Some(DefaultTarget::Target);
            }
        }
        "merge" => {
            if !raw.contains_key("targets") {
                return Err(refused(format!(
                    "{here}: `merge` needs `targets` — one hit cannot be merged with itself"
                )));
            }
            a.targets_slot(false)?;
            a.string_slot("separator")?;
        }
        _ => unreachable!("the ops above"),
    }
    // Everything else is literal: an expression anywhere else is refused.
    for (key, v) in raw {
        if key == "op" || a.slot_keys.contains(&key.as_str()) {
            continue;
        }
        if contains_oqx(v) {
            return Err(refused(format!(
                "{here}.{key}: `{{ oqx }}` is not allowed here"
            )));
        }
    }
    let Admit {
        base, probe, slots, ..
    } = a;
    // The shape, with a probe in every slot (the §11.1 messages, naming
    // `effects[i]`; the §8 shape fixes rewrite the template as written).
    Effect::validate_with(&Json::Object(probe), index, fix).map_err(shape_error_of)?;
    Ok(Template {
        index,
        base,
        slots,
        default_target,
        symbols: sugar.symbols.clone(),
        op: op.to_owned(),
    })
}

// ---- the compile -----------------------------------------------------------------------

/// A compiled request: the selector as parsed, its root, the admitted
/// templates, the rewritten tree and the bound.
#[derive(Clone, Debug)]
pub struct Compiled {
    pub raw: Query,
    pub root: Target,
    pub templates: Vec<Template>,
    pub rewritten: Query,
    pub expect: Option<SelectionExpect>,
    /// The most hits allowed (`expect.max`, or the ceiling).
    pub bound: usize,
    /// The request as given (`select`, the templates, `expect?`), for the
    /// corrected examples (3.3).
    pub request: fixes::Request,
}

impl Compiled {
    /// The bound is the implicit ceiling (no `expect.max`).
    #[must_use]
    pub fn implicit(&self) -> bool {
        self.expect.is_none()
    }
}

/// The static admission of the selector itself (the reference's
/// `admitSelector`): every refusal is prefixed `select: `.
fn admit_selector(select: &str, request: Option<&fixes::Request>) -> Result<(Query, Target)> {
    let raw = oqx::parse_string(select).map_err(|e| {
        // (`spec/surface` 4.11) `id in ["a", "b"]` — the bracket list rewritten
        // to a tuple is the `fix` (the same request over the corrected selector).
        match bracket_list_as_tuple(select, &e.message) {
            None => refused(format!("select: {}", e.message)),
            Some(rewritten) => refused_with(
                format!("select: {}{TUPLE_HINT}", e.message),
                match request {
                    Some(r) => json!({ "fix": fixes::fix_request(&fixes::Request {
                        select: Some(Json::String(rewritten)),
                        ..r.clone()
                    }) }),
                    None => json!({}),
                },
            ),
        }
    })?;
    // The fix of a refused source (3.3): the same request over an admitted
    // root, spliced over the source's span of the written query.
    let root_fix = |links: bool| -> Json {
        let span = raw.source.span();
        match request {
            Some(r) => json!({ "fix": fixes::root_fix(r, select, (span.start, span.end), links) }),
            None => json!({}),
        }
    };
    check_root_spellings(&raw).map_err(|e| refused(format!("select: {}", e.message)))?;
    check_reserved_aliases(&raw).map_err(|e| refused(format!("select: {}", e.message)))?;
    if !matches!(
        raw.consumer,
        Consumer::Collect | Consumer::First | Consumer::Single
    ) {
        return Err(refused(format!(
            "select: `{}` yields no rows — a selector's consumer is collect, first or single",
            raw.consumer.as_str()
        )));
    }
    if raw.values {
        return Err(refused("select: a selector yields rows, not `values`"));
    }
    let root = match root_target(&raw.source) {
        None => {
            return Err(refused_with(
                "select: a selector scans a root collection — `from docs`, `from blocks` or `from nodes`",
                root_fix(false),
            ));
        }
        Some(Target::Links) => {
            return Err(refused_with(
                "select: `links` rows have no effect target — select docs, blocks or nodes",
                root_fix(true),
            ));
        }
        // the history (spec/surface 4.7, spec/mutate §11.8): refused by name, the fix over `docs`
        Some(Target::Revisions) => {
            return Err(refused_with(
                "select: `revisions` rows have no effect target — select docs, blocks or nodes",
                root_fix(false),
            ));
        }
        Some(t) => t,
    };
    if raw.follow.is_some() {
        return Err(refused(
            "select: `follow` is not allowed in a selector — a hit must be a row of the root",
        ));
    }
    if !raw.from.is_empty() {
        return Err(refused(
            "select: a body `from` re-projects the rows — a hit must be a row of the root",
        ));
    }
    if raw.offset.is_some() {
        return Err(refused(
            "select: `offset` is not allowed — a selection is a set, not a page",
        ));
    }
    if raw.distinct {
        return Err(refused("select: `distinct` is not allowed in a selector"));
    }
    Ok((raw, root))
}

/// The static half (§11.8 steps 1 and 2; the reference's `validateExpect` +
/// `admitRequest`): `expect`, then `select` and the templates, then the
/// selector's admission, the templates' desugar (3.2) and admission, and
/// the rewrite. Nothing is read.
pub fn compile(req: &SelectRequest) -> Result<Compiled> {
    let expect = validate_expect(req.expect.as_ref())?;
    let select = req
        .select
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| refused("`select` must be an OQX query (a non-empty string)"))?;
    let templates = req
        .templates
        .as_array()
        .ok_or_else(|| refused("`effects` must be an array of effect templates"))?;
    if templates.is_empty() {
        return Err(refused("`effects` must name at least one template"));
    }
    // The request as given, for every fix the compile composes (3.3).
    let request = fixes::Request {
        select: Some(req.select.clone()),
        effects: req.templates.clone(),
        expect: req.expect.clone(),
    };
    let (raw, root) = admit_selector(select, Some(&request))?;
    // Under a selector a template's `into` is bound per hit, so the anchor
    // fix (a parent lookup) does not apply: `parent_of` finds nothing.
    let fix = shape_fix(&request, &no_parent);
    let templates = templates
        .iter()
        .enumerate()
        .map(|(t, v)| {
            let (v, d) = desugar_effect(v, t, Some(&request))?;
            admit_template(t, &v, root, false, &d, Some(&fix))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut rewritten = raw.clone();
    for tpl in &templates {
        for slot in &tpl.slots {
            rewritten
                .select
                .push(renamed(&slot.item, &slot_name(tpl.index, &slot.name)));
        }
    }
    let bound = expect.map_or(SELECTION_CEILING, |e| e.max);
    Ok(Compiled {
        raw,
        root,
        templates,
        rewritten,
        expect,
        bound,
        request,
    })
}

// ---- the binding -----------------------------------------------------------------------

/// A hit's `(id, path)`.
pub type Row = (String, String);

/// `{ effect_index, template_index?, row, expression }` — what every error
/// from a slot carries (`template_index` only under a selector).
fn slot_data(k: usize, t: Option<usize>, row: &Row, expression: &str) -> Json {
    let mut d = json!({
        "effect_index": k,
        "row": { "id": row.0, "path": row.1 },
        "expression": expression,
    });
    if let Some(t) = t {
        d["template_index"] = json!(t);
    }
    d
}

/// Where a slot's binding reports: the expanded index, the template index
/// under a selector, the row.
struct Origin<'a> {
    k: usize,
    template: Option<usize>,
    row: &'a Row,
    /// The root the row belongs to (the selector's; a plain effect's scope).
    root: Target,
    /// The request as given, for an `ambiguous_target` fix (3.3).
    request: Option<&'a fixes::Request>,
}

/// A bound identity slot's value → the identity (a string or a row) or the
/// §11.8 refusals (`target_missing`, `ambiguous_target`, a typed
/// `filter_invalid`).
fn identity_value<'v>(v: Option<&'v Json>, s: &Slot, o: &Origin<'_>) -> Result<&'v Json> {
    let data = || slot_data(o.k, o.template, o.row, &s.expression);
    let absent = v.is_none_or(Json::is_null);
    if absent || v.and_then(Json::as_array).is_some_and(Vec::is_empty) {
        return Err(MutationError::with_data(
            ErrorCode::TargetMissing,
            format!(
                "{}: the expression yielded no identity for row {}",
                s.here, o.row.0
            ),
            data(),
        )
        .into());
    }
    let v = v.expect("not absent");
    if let Some(a) = v.as_array() {
        let mut d = data();
        d["count"] = json!(a.len());
        // The fix (3.3): the slot spelled as the FIRST identity the
        // expression yielded (a row by its id); under a selector the
        // selector narrowed to this row.
        let first = a
            .first()
            .and_then(|h| row_ref(h).map(|(id, _)| id).or_else(|| h.as_str()));
        if let (Some(req), Some(first)) = (o.request, first)
            && let Some(fix) =
                fixes::ambiguous_slot(req, &s.here, first, (o.root.as_str(), &o.row.0))
        {
            d["fix"] = json!(fix);
        }
        return Err(MutationError::with_data(
            ErrorCode::AmbiguousTarget,
            format!(
                "{}: the expression yielded {} identities for row {}; a target resolves to exactly one",
                s.here,
                a.len(),
                o.row.0
            ),
            d,
        )
        .into());
    }
    if v.as_str().is_none() && row_ref(v).is_none() {
        return Err(refused_with(
            format!(
                "{}: the expression yielded {}, not an identity (a string or a row)",
                s.here,
                describe(Some(v))
            ),
            data(),
        ));
    }
    Ok(v)
}

/// A whole-target slot's value → the target object (3.2): a row by its id,
/// a string as [`bare_target`] reads it (a path → a document, an id → its
/// kind, a `$new.n` → the symbol, provisional). `Ok((target, symbol))`.
fn whole_target(
    v: &Json,
    s: &Slot,
    o: &Origin<'_>,
    member: Member,
    op: &str,
    field: Option<&str>,
) -> Result<(Json, bool)> {
    let is_row = row_ref(v).is_some();
    let r = match row_ref(v) {
        Some((id, _)) => id,
        None => v
            .as_str()
            .expect("identity_value admitted a string or a row"),
    };
    if !is_row
        && !path_looking(r)
        && !is_target_id(r)
        && omgbase_mutate::parse_new_symbol(r).is_none()
    {
        return Err(refused_with(
            format!(
                "{}: the expression yielded {}, not an identity (a document path, an id or a row)",
                s.here,
                describe(Some(v))
            ),
            slot_data(o.k, o.template, o.row, &s.expression),
        ));
    }
    let t = bare_target(r, &s.here, member, op, field)?;
    Ok((t, omgbase_mutate::parse_new_symbol(r).is_some()))
}

/// One hit × one template → the effect JSON with every slot filled and the
/// target members holding a bare `$new.n` (§11.8's table; the reference's
/// `bind`). `root` is the selector's (the hit's kind for a defaulted
/// target). The shape is checked once here with the provisional kinds;
/// [`finish`] settles the symbols and checks again.
fn bind_one(root: Target, hit: &Json, t: &Template, o: &Origin<'_>) -> Result<(Json, Vec<Member>)> {
    let mut e = Json::Object(t.base.clone());
    let mut symbols = t.symbols.clone();
    match t.default_target {
        Some(DefaultTarget::Target) => e["target"] = hit_ref(root, &o.row.0),
        Some(DefaultTarget::Into) => e["into"] = hit_ref(root, &o.row.0),
        Some(DefaultTarget::Targets) => e["targets"] = json!([hit_ref(root, &o.row.0)]),
        None => {}
    }
    let field = t
        .base
        .get("field")
        .and_then(Json::as_str)
        .map(str::to_owned);
    for s in &t.slots {
        let v = hit.get(slot_name(t.index, &s.name));
        let absent = v.is_none_or(Json::is_null);
        let data = || slot_data(o.k, o.template, o.row, &s.expression);
        match &s.kind {
            SlotKind::Identity { .. } | SlotKind::TargetsIdentity { .. } => {
                let v = identity_value(v, s, o)?;
                // A string lands as the member that held the expression; a
                // row ref as `id` (the reference's `identityMember`).
                let (member, value) = match (v.as_str(), row_ref(v)) {
                    (Some(s), _) => (None, json!(s)),
                    (None, Some((id, _))) => (Some("id".to_owned()), json!(id)),
                    (None, None) => unreachable!("identity_value admitted it"),
                };
                let (target, written) = match &s.kind {
                    SlotKind::Identity { key, member } => (e.get_mut(key), member.clone()),
                    SlotKind::TargetsIdentity { k } => (
                        e.get_mut("targets")
                            .and_then(Json::as_array_mut)
                            .and_then(|a| a.get_mut(*k)),
                        "id".to_owned(),
                    ),
                    _ => unreachable!("identity kinds"),
                };
                if let Some(obj) = target.and_then(Json::as_object_mut) {
                    obj.insert(member.unwrap_or(written), value);
                }
            }
            SlotKind::WholeTarget { key, member } => {
                let v = identity_value(v, s, o)?;
                let (target, symbol) = whole_target(v, s, o, *member, &t.op, field.as_deref())?;
                if symbol {
                    symbols.push(*member);
                }
                e[key] = target;
            }
            SlotKind::WholeTargets { k } => {
                let v = identity_value(v, s, o)?;
                let (target, symbol) = whole_target(v, s, o, Member::Targets(*k), &t.op, None)?;
                if symbol {
                    symbols.push(Member::Targets(*k));
                }
                if let Some(slot) = e
                    .get_mut("targets")
                    .and_then(Json::as_array_mut)
                    .and_then(|a| a.get_mut(*k))
                {
                    *slot = target;
                }
            }
            SlotKind::Str { .. } | SlotKind::At { .. } => {
                if absent {
                    return Err(refused_with(
                        format!(
                            "{}: the expression yielded absent for row {}",
                            s.here, o.row.0
                        ),
                        data(),
                    ));
                }
                let Some(text) = v.and_then(Json::as_str) else {
                    return Err(refused_with(
                        format!(
                            "{}: the expression yielded {}, expected a string",
                            s.here,
                            describe(v)
                        ),
                        data(),
                    ));
                };
                match &s.kind {
                    SlotKind::At { member } => e["at"] = json!({ member: text }),
                    SlotKind::Str { key } => e[key] = json!(text),
                    _ => unreachable!("string kinds"),
                }
            }
            SlotKind::Value | SlotKind::Frontmatter { .. } => {
                if absent {
                    return Err(refused_with(
                        format!(
                            "{}: the expression yielded absent for row {}{}",
                            s.here,
                            o.row.0,
                            if s.kind == SlotKind::Value {
                                " — use `unset` to remove a key"
                            } else {
                                ""
                            }
                        ),
                        data(),
                    ));
                }
                let v = v.expect("not absent").clone();
                match &s.kind {
                    SlotKind::Frontmatter { key } => {
                        if let Some(fm) = e.get_mut("frontmatter").and_then(Json::as_object_mut) {
                            fm.insert(key.clone(), v);
                        }
                    }
                    _ => e["value"] = v,
                }
            }
        }
    }
    Effect::validate(&e, o.k).map_err(shape_error)?;
    Ok((e, symbols))
}

/// The settlement of bare `$new.n` targets (3.2): given the effect JSON, the
/// members holding a symbol and the concrete effects before it, rewrite
/// each symbol's `kind` to the one the symbol table records — the kind
/// `plan` over that prefix allocated to `$new.n` (`new_ids[n].kind`).
pub type Settle<'a> = dyn FnMut(&mut Json, &[Member], &[Effect]) + 'a;

/// A settlement that leaves every provisional kind in place (tests; a path
/// with no store at hand).
pub fn no_settle(_: &mut Json, _: &[Member], _: &[Effect]) {}

/// The settlement over a store: `plan` the prefix (nothing written, no id
/// minted) and read the symbols' kinds off its `new_ids`. A prefix that does
/// not plan, or a symbol it did not mint, is left provisional — the real
/// plan reports it (`target_missing { symbol }` for one nothing created).
pub fn settle_symbols(
    store: &mut Store,
    ctx: &PlanContext,
    doc_store: &dyn DocStore,
    e: &mut Json,
    members: &[Member],
    prefix: &[Effect],
) {
    if prefix.is_empty() {
        return;
    }
    let Ok(plan) = store.plan_selected(ctx, prefix, None, doc_store) else {
        return;
    };
    for m in members {
        let slot = match m {
            Member::Target => e.get_mut("target"),
            Member::Into => e.get_mut("into"),
            Member::Targets(k) => e
                .get_mut("targets")
                .and_then(Json::as_array_mut)
                .and_then(|a| a.get_mut(*k)),
        };
        let Some(obj) = slot.and_then(Json::as_object_mut) else {
            continue;
        };
        let Some(n) = obj
            .get("id")
            .and_then(Json::as_str)
            .and_then(omgbase_mutate::parse_new_symbol)
        else {
            continue;
        };
        if let Some(x) = plan.new_ids.get(n) {
            obj.insert("kind".to_owned(), json!(x.kind.as_str()));
        }
    }
}

/// The concrete effect of a bound (or literal) effect JSON: settle its bare
/// `$new.n` members against the effects before it, then the shape check
/// again — a settled kind the slot does not admit, or a `field` the settled
/// kind does not take, is the §11.1 message with `effect_index` (the
/// reference resolves the symbol in the lowering, where every error gains
/// it).
fn finish(
    e: &mut Json,
    k: usize,
    symbols: &[Member],
    prefix: &[Effect],
    settle: &mut Settle<'_>,
    first: Effect,
) -> Result<Effect> {
    if symbols.is_empty() || prefix.is_empty() {
        return Ok(first);
    }
    settle(e, symbols, prefix);
    Effect::validate(e, k).map_err(|m| {
        let mut err = shape_error(m);
        if let Some(d) = err.data.as_mut().and_then(Json::as_object_mut) {
            d.insert("effect_index".to_owned(), json!(k));
        }
        err
    })
}

/// The hit's `(id, path)` as the envelope spells it.
fn row_of(hit: &Json) -> Row {
    (
        hit.get(HIT_ID)
            .and_then(Json::as_str)
            .unwrap_or_default()
            .to_owned(),
        hit.get(HIT_PATH)
            .and_then(Json::as_str)
            .unwrap_or_default()
            .to_owned(),
    )
}

/// What [`bind`] produced: the concrete effects and each hit's `(id, path)`
/// in result order.
#[derive(Clone, Debug, Default)]
pub struct Bound {
    pub effects: Vec<Effect>,
    pub rows: Vec<Row>,
}

/// The concrete effects of `hits × templates` (§11.8's expansion rule);
/// `settle` resolves the bare `$new.n` kinds ([`settle_symbols`]).
pub fn bind(c: &Compiled, hits: &[Json], settle: &mut Settle<'_>) -> Result<Bound> {
    let mut b = Bound::default();
    for hit in hits {
        let row = row_of(hit);
        for t in &c.templates {
            let k = b.effects.len();
            let o = Origin {
                k,
                template: Some(t.index),
                row: &row,
                root: c.root,
                request: Some(&c.request),
            };
            let (mut e, symbols) = bind_one(c.root, hit, t, &o)?;
            let first = Effect::validate(&e, k).map_err(shape_error)?;
            let effect = finish(&mut e, k, &symbols, &b.effects, settle, first)?;
            b.effects.push(effect);
        }
        b.rows.push(row);
    }
    Ok(b)
}

/// `selection_too_large { cardinality, max, implicit? }`: `cardinality` is
/// `">max"` when the page was truncated at the bound, the exact count when
/// it was `bound + 1` (`first`/`single` under `max: 0`).
fn too_large(truncated: bool, hits: usize, c: &Compiled, count: usize) -> SurfaceError {
    let mut data = json!({
        "cardinality": if truncated { json!(format!(">{}", c.bound)) } else { json!(hits) },
        "max": c.bound,
    });
    if c.implicit() {
        data["implicit"] = json!(true);
    }
    // The fix (3.3): the same request bounded at the selection's actual size.
    data["fix"] = json!(fixes::bounded(&c.request, count));
    let message = format!(
        "the selection has {} hits, over the bound of {}{} — narrow the selector or raise `expect.max`",
        if truncated {
            format!("more than {}", c.bound)
        } else {
            hits.to_string()
        },
        c.bound,
        if c.implicit() {
            " (the implicit ceiling; pass expect.max to raise it)"
        } else {
            ""
        }
    );
    MutationError::with_data(ErrorCode::SelectionTooLarge, message, data).into()
}

/// What the selector (or the selector-less sugar) produced: the concrete
/// effects, the frozen record (a selector's), the hits' identities for error
/// annotation, and the effects as written when a selector-less request
/// evaluated an expression (the plan's and the intent record's
/// `templates`).
#[derive(Clone, Debug)]
pub struct Expansion {
    pub effects: Vec<Effect>,
    pub selection: Option<Selection>,
    pub rows: Vec<Row>,
    pub templates: Option<Vec<Json>>,
}

/// Run the selector and expand it (module docs; the reference's
/// `compileSelection`), or — without a selector (3.2) — desugar the effects
/// and evaluate their slots in their own targets' row scopes
/// ([`expand_plain`]). `semantic` is the embedded phrases of the selector
/// ([`crate::query::embed_phrases`]). The store is borrowed mutably only for
/// the prefix plans that settle bare `$new.n` kinds; nothing is written.
pub fn expand(
    store: &mut Store,
    ctx: &PlanContext,
    doc_store: &dyn DocStore,
    req: &SelectRequest,
    semantic: HashMap<String, SemanticVec>,
) -> Result<Expansion> {
    if !req.has_selector() {
        return expand_plain(store, ctx, doc_store, req);
    }
    let c = compile(req)?;
    // Unknown names (spec/surface §1.5, 4.6; spec/mutate §11.8): a name no row
    // of the selector's kind carries would select every row or none, so the
    // selector's OWN text is judged before the run and refused under the
    // admission's prefix and hint like every other refusal (the reference's
    // `runQuery` rewraps the runner's `filter_invalid`). The slot items the
    // rewrite appended are not the selector. The vocabulary read here is
    // handed to the run, whose own `Refuse` pass (the AST entry's default)
    // then finds nothing new to read.
    let vocabulary = names::VocabularyCache::default();
    {
        let own = Query {
            select: c
                .rewritten
                .select
                .iter()
                .filter(|it| {
                    !RESERVED_ALIAS_PREFIXES
                        .iter()
                        .any(|p| it.name().starts_with(p))
                })
                .cloned()
                .collect(),
            ..c.rewritten.clone()
        };
        names::check_names(
            store,
            &ctx.repo_id,
            &own,
            names::UnknownNames::Refuse,
            &vocabulary,
        )
        .map_err(|e| refused(format!("select: {}", e.message)))?;
    }
    // `date("today")` in a selector reads the plan's clock (§1.3, 4.8).
    let now_ms = Some(dates::stamp_ms(&ctx.ts));
    let opts = QueryOptions {
        limit: Some(c.bound.saturating_add(1)),
        cursor: None,
        provider: None,
        in_memory: false,
        bare: false,
        unknown_names: None,
        vocabulary: Some(&vocabulary),
        now_ms,
        request: None,
    };
    let res = query_ast(store, &ctx.repo_id, &c.rewritten, opts, semantic)?;
    if res.truncated || res.hits.len() > c.bound {
        // The exact size for the fix: a second, unbounded run when the first
        // page was cut (the engine never plans a partial set; the count is
        // for the example).
        let count = if res.truncated {
            let unbounded = QueryOptions {
                limit: Some(usize::MAX >> 2),
                cursor: None,
                provider: None,
                in_memory: false,
                bare: false,
                unknown_names: None,
                vocabulary: Some(&vocabulary),
                now_ms,
                request: None,
            };
            query_ast(store, &ctx.repo_id, &c.rewritten, unbounded, HashMap::new())?
                .hits
                .len()
        } else {
            res.hits.len()
        };
        return Err(too_large(res.truncated, res.hits.len(), &c, count));
    }
    let mut settle = |e: &mut Json, m: &[Member], p: &[Effect]| {
        settle_symbols(store, ctx, doc_store, e, m, p);
    };
    let b = bind(&c, &res.hits, &mut settle)?;
    let selection = Selection {
        query: req.select_str().to_owned(),
        expect: c.expect,
        templates: req.templates.as_array().cloned().unwrap_or_default(),
        cardinality: b.rows.len(),
        identities: b.rows.iter().map(|(id, _)| id.clone()).collect(),
    };
    Ok(Expansion {
        effects: b.effects,
        selection: Some(selection),
        rows: b.rows,
        templates: None,
    })
}

// ---- the selector-less path (3.2) -----------------------------------------------------

/// The error when a plain effect's row is gone (the reference's
/// `Scope.missing`).
#[derive(Clone, Debug, PartialEq, Eq)]
enum Missing {
    Doc(String),
    Block(String),
    Parent(String),
    Node(String),
}

impl Missing {
    fn error(&self) -> SurfaceError {
        let (code, message, data) = match self {
            Missing::Doc(id) => (
                ErrorCode::DocMissing,
                format!("doc {id} not found"),
                json!({ "doc": id }),
            ),
            Missing::Block(id) => (
                ErrorCode::BlockMissing,
                format!("block {id} not found"),
                json!({ "block": id }),
            ),
            Missing::Parent(id) => (
                ErrorCode::ParentMissing,
                format!("parent {id} not found"),
                json!({}),
            ),
            Missing::Node(id) => (
                ErrorCode::BlockMissing,
                format!("node {id} not found"),
                json!({}),
            ),
        };
        MutationError::with_data(code, message, data).into()
    }
}

/// The row a plain effect's expressions read: its primary target's root and
/// id, and the error when that row is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Scope {
    root: Target,
    id: String,
    missing: Missing,
}

/// The primary target of a plain effect (the §11.8 table's: `target` of
/// set/unset/split and of a document move/remove, `into` of insert, the
/// first of `targets` for the block forms) as a row (the reference's
/// `scopeOf`): a `create` has none; an expression there needs a selector; a
/// bare `$new.n` has no row yet; a document is looked up (`doc_missing`).
fn scope_of(
    store: &Store,
    repo_id: &str,
    e: &Map<String, Json>,
    i: usize,
    sugar: &Desugared,
) -> Result<Scope> {
    let here = format!("effects[{i}]");
    let op = e.get("op").and_then(Json::as_str).unwrap_or_default();
    let first = |kinds: &'static [&'static str]| -> Result<(String, Option<Json>, &'static [&'static str], Member)> {
        let list = e.get("targets").and_then(Json::as_array);
        if list.is_none_or(Vec::is_empty) {
            // the shape check's `targets` message
            Effect::validate(&Json::Object(e.clone()), i).map_err(shape_error)?;
        }
        Ok((
            "targets[0]".to_owned(),
            list.and_then(|l| l.first()).cloned(),
            kinds,
            Member::Targets(0),
        ))
    };
    const PLACEMENT: &[&str] = &["document", "section", "block"];
    const DOCUMENT: &[&str] = &["document"];
    const BLOCK: &[&str] = &["block"];
    const SET: &[&str] = &["document", "block", "node"];
    let target = |kinds: &'static [&'static str]| {
        (
            "target".to_owned(),
            e.get("target").cloned(),
            kinds,
            Member::Target,
        )
    };
    let mut placement = false;
    let (key, v, kinds, member) = match op {
        "create" => {
            return Err(refused(format!(
                "{here}: a `create` has no row — an expression on a create needs a selector (`select`)"
            )));
        }
        "insert" => {
            placement = true;
            (
                "into".to_owned(),
                e.get("into").cloned(),
                PLACEMENT,
                Member::Into,
            )
        }
        "set" => target(SET),
        "unset" => target(DOCUMENT),
        "move" => {
            if e.contains_key("targets") || e.contains_key("into") {
                first(BLOCK)?
            } else {
                target(DOCUMENT)
            }
        }
        "remove" => {
            if e.contains_key("targets") {
                first(BLOCK)?
            } else {
                target(DOCUMENT)
            }
        }
        "split" => target(BLOCK),
        "merge" => first(BLOCK)?,
        _ => {
            // an unknown op (or `retarget`): the shape check refuses it
            Effect::validate(&Json::Object(e.clone()), i).map_err(shape_error)?;
            return Err(shape_error(format!(
                "{here}: `op` {} is not row-shaped",
                Json::String(op.to_owned())
            )));
        }
    };
    let where_ = format!("{here}.{key}");
    if v.as_ref().is_some_and(|v| {
        oqx_of(v).is_some()
            || v.as_object().is_some_and(|o| {
                o.get("id").is_some_and(|x| oqx_of(x).is_some())
                    || o.get("path").is_some_and(|x| oqx_of(x).is_some())
            })
    }) {
        return Err(needs_selector(&where_));
    }
    let kinds_text = kinds
        .iter()
        .map(|k| format!("\"{k}\""))
        .collect::<Vec<_>>()
        .join(" | ");
    let Some(t) = v
        .as_ref()
        .and_then(Json::as_object)
        .filter(|o| o.get("kind").is_some_and(Json::is_string))
    else {
        return Err(shape_error(format!(
            "{where_}: a target is {{ kind: {kinds_text}, … }}"
        )));
    };
    let kind = t["kind"].as_str().expect("checked");
    let id_of = |key: &str| t.get(key).and_then(Json::as_str).map(str::to_owned);
    // A bare `$new.n` (the desugar's record) has no row yet.
    if sugar.symbols.contains(&member)
        && let Some(sym) = id_of("id").filter(|id| omgbase_mutate::parse_new_symbol(id).is_some())
    {
        return Err(refused(format!(
            "{where_}: {sym} has no row yet — it is created by this plan; use a literal target or a selector"
        )));
    }
    if !kinds.contains(&kind) {
        return Err(shape_error(format!(
            "{where_}: `kind` must be one of {} (got \"{kind}\")",
            kinds.join(", ")
        )));
    }
    Ok(match kind {
        "document" => {
            let id = id_of("id");
            let path = id_of("path");
            if id.is_none() && path.is_none() {
                return Err(shape_error(format!(
                    "{where_}: a document target needs `id` or `path`"
                )));
            }
            let by_id = match &id {
                Some(id) => {
                    let found = store.find_doc_by_ref(repo_id, id)?;
                    Some(found.ok_or_else(|| Missing::Doc(id.clone()).error())?)
                }
                None => None,
            };
            let by_path = match &path {
                Some(path) => {
                    let found = store.find_doc_by_ref(repo_id, storage_path(path))?;
                    Some(found.ok_or_else(|| Missing::Doc(path.clone()).error())?)
                }
                None => None,
            };
            if let (Some(a), Some(b)) = (&by_id, &by_path)
                && a.doc_id != b.doc_id
            {
                return Err(shape_error(format!(
                    "id {} and path {} name different documents",
                    Json::String(id.clone().unwrap_or_default()),
                    Json::String(path.clone().unwrap_or_default())
                )));
            }
            let info = by_id.or(by_path).expect("one of the two");
            Scope {
                root: Target::Docs,
                id: info.doc_id.clone(),
                missing: Missing::Doc(info.doc_id),
            }
        }
        "block" => {
            let id = id_of("id").unwrap_or_default();
            Scope {
                root: Target::Blocks,
                id: id.clone(),
                missing: if placement {
                    Missing::Parent(id)
                } else {
                    Missing::Block(id)
                },
            }
        }
        "section" => {
            let id = id_of("heading_id").unwrap_or_default();
            Scope {
                root: Target::Blocks,
                id: id.clone(),
                missing: Missing::Parent(id),
            }
        }
        _ => {
            let id = id_of("id").unwrap_or_default();
            Scope {
                root: Target::Nodes,
                id: id.clone(),
                missing: Missing::Node(id),
            }
        }
    })
}

/// What a plain effect becomes before the final shape check.
enum Plain {
    /// Validated as written (no expression): the JSON and its bare symbols.
    Literal(Json, Vec<Member>),
    /// Bound from its scope's row.
    Bound(Json, Vec<Member>),
}

/// Compile a plain `effects` list (no selector; the reference's
/// `compilePlain`): desugar the `-> ` leaders, then — when nothing is an
/// expression — the shape check as before (3.1-identical, no `templates`).
/// Otherwise each effect with expression slots is admitted as a template
/// over its own primary target's row ([`scope_of`]): the effects are grouped
/// by that row's identity, one synthetic query per identity — `from <root>
/// where id == "<id>"` with the slot items appended, named
/// `__omg_sel_<effectIndex>_<slot>` — runs (`limit 2`), and the row binds the
/// slots exactly as a selector's hit would. Bare `$new.n` kinds are settled
/// last, in request order, each against the effects before it.
pub fn expand_plain(
    store: &mut Store,
    ctx: &PlanContext,
    doc_store: &dyn DocStore,
    req: &SelectRequest,
) -> Result<Expansion> {
    let raw = req
        .templates
        .as_array()
        .ok_or_else(|| shape_error("`effects` must be an array of effects".to_owned()))?;
    if raw.is_empty() {
        return Err(shape_error(
            "`effects` must name at least one effect".to_owned(),
        ));
    }
    // The request as given (the effects alone), for every fix (3.3).
    let request = fixes::Request {
        select: None,
        effects: Json::Array(raw.clone()),
        expect: None,
    };
    let mut desugared = Vec::with_capacity(raw.len());
    for (i, v) in raw.iter().enumerate() {
        desugared.push(desugar_effect(v, i, Some(&request))?);
    }
    let any_expression = desugared.iter().any(|(v, _)| contains_oqx(v));
    let mut staged: Vec<Option<Plain>> = (0..raw.len()).map(|_| None).collect();
    if any_expression {
        // Scope and admit the effects with expressions; group them by row.
        struct Group {
            scope: Scope,
            members: Vec<Template>,
        }
        let mut groups: Vec<Group> = Vec::new();
        for (i, (v, d)) in desugared.iter().enumerate() {
            let Some(o) = v.as_object().filter(|_| contains_oqx(v)) else {
                staged[i] = Some(Plain::Literal(v.clone(), d.symbols.clone()));
                continue;
            };
            let scope = scope_of(store, &ctx.repo_id, o, i, d)?;
            let lookup = parent_lookup(store);
            let fix = shape_fix(&request, &lookup);
            let t = admit_template(i, v, scope.root, true, d, Some(&fix))?;
            if t.slots.is_empty() {
                // `{ oqx }` only inside data (a nested `value`): literal, as for a template.
                staged[i] = Some(Plain::Literal(v.clone(), d.symbols.clone()));
                continue;
            }
            match groups.iter_mut().find(|g| g.scope == scope) {
                Some(g) => g.members.push(t),
                None => groups.push(Group {
                    scope,
                    members: vec![t],
                }),
            }
        }
        for g in &groups {
            let src = format!(
                "from {} where id == {}",
                g.scope.root.as_str(),
                Json::String(g.scope.id.clone())
            );
            let mut q = oqx::parse_string(&src)?;
            for t in &g.members {
                for s in &t.slots {
                    q.select
                        .push(renamed(&s.item, &slot_name(t.index, &s.name)));
                }
            }
            let opts = QueryOptions {
                limit: Some(2),
                cursor: None,
                provider: None,
                in_memory: false,
                bare: false,
                unknown_names: None,
                vocabulary: None,
                now_ms: Some(dates::stamp_ms(&ctx.ts)),
                request: None,
            };
            let res = query_ast(store, &ctx.repo_id, &q, opts, HashMap::new())?;
            let Some(hit) = res.hits.first() else {
                return Err(g.scope.missing.error());
            };
            let row = row_of(hit);
            for t in &g.members {
                let o = Origin {
                    k: t.index,
                    template: None,
                    row: &row,
                    root: g.scope.root,
                    request: Some(&request),
                };
                let (e, symbols) = bind_one(g.scope.root, hit, t, &o)?;
                staged[t.index] = Some(Plain::Bound(e, symbols));
            }
        }
    } else {
        for (i, (v, d)) in desugared.into_iter().enumerate() {
            staged[i] = Some(Plain::Literal(v, d.symbols));
        }
    }
    // The final shape check in request order, each effect's bare `$new.n`
    // settled against the effects before it.
    let mut effects: Vec<Effect> = Vec::with_capacity(raw.len());
    for (i, p) in staged.into_iter().enumerate() {
        let (mut e, symbols) = match p.expect("every effect staged") {
            Plain::Literal(e, s) | Plain::Bound(e, s) => (e, s),
        };
        // The shape check with the §8 fixes (3.4) reads the store for the
        // anchor fix; the settlement that follows plans through it.
        let first = {
            let lookup = parent_lookup(store);
            let fix = shape_fix(&request, &lookup);
            Effect::validate_with(&e, i, Some(&fix)).map_err(shape_error_of)?
        };
        let mut settle = |e: &mut Json, m: &[Member], p: &[Effect]| {
            settle_symbols(store, ctx, doc_store, e, m, p);
        };
        let effect = finish(&mut e, i, &symbols, &effects, &mut settle, first)?;
        effects.push(effect);
    }
    Ok(Expansion {
        effects,
        selection: None,
        rows: Vec::new(),
        templates: any_expression.then(|| raw.clone()),
    })
}

/// An error from the lowering of an expanded effect gains `template_index`
/// and `row` next to the planner's `effect_index` (module docs).
#[must_use]
pub fn annotate(mut e: SurfaceError, rows: &[Row], templates: usize) -> SurfaceError {
    if templates == 0 {
        return e;
    }
    if let Some(data) = e.data.as_mut().and_then(Json::as_object_mut)
        && let Some(k) = data
            .get("effect_index")
            .and_then(Json::as_u64)
            .and_then(|k| usize::try_from(k).ok())
        && !data.contains_key("template_index")
        && let Some((id, path)) = rows.get(k / templates)
    {
        data.insert("template_index".to_owned(), json!(k % templates));
        data.insert("row".to_owned(), json!({ "id": id, "path": path }));
    }
    e
}

/// Expand and plan in one write scope: the store callback the catalog hands
/// to [`Store::plan_selected`], [`Store::execute_replanned`] and
/// [`Store::apply_planned`]. Without a selector (3.2) the plan carries no
/// `selection` but records the effects as written as `templates` when one
/// evaluated an expression.
pub fn plan_selected(
    store: &mut Store,
    doc_store: &dyn DocStore,
    ctx: &PlanContext,
    req: &SelectRequest,
    semantic: HashMap<String, SemanticVec>,
) -> Result<omgbase_mutate::Plan> {
    let x = expand(store, ctx, doc_store, req, semantic)?;
    let templates = if req.has_selector() {
        req.templates()
    } else {
        0
    };
    let concrete = x.effects.len();
    let plan = store
        .plan_selected(ctx, &x.effects, x.selection, doc_store)
        .map_err(|e| annotate(SurfaceError::from(e), &x.rows, templates));
    let mut plan = match plan {
        Ok(plan) => plan,
        // §8 "fix" (3.3): the corrected example, from the request as given
        // — under a selector with the hits' origins; the selector-less
        // sugar as a plain request, its symbols counted by a prefix plan.
        Err(e) => {
            let req_fix = fixes::Request {
                select: req.has_selector().then(|| req.select.clone()),
                effects: req.templates.clone(),
                expect: req.expect.clone(),
            };
            let origins: Option<Vec<fixes::Origin>> = (templates > 0).then(|| {
                (0..concrete)
                    .map(|k| fixes::Origin {
                        row_id: x
                            .rows
                            .get(k / templates)
                            .map(|(id, _)| id.clone())
                            .unwrap_or_default(),
                        template_index: k % templates,
                    })
                    .collect()
            });
            let allocated = |i: usize| -> Option<usize> {
                if i == 0 {
                    return Some(0);
                }
                store
                    .plan_selected(ctx, &x.effects[..i.min(concrete)], None, doc_store)
                    .ok()
                    .map(|p| p.new_ids.len())
            };
            return Err(fixes::planning_fix(
                &req_fix,
                e,
                origins.as_deref(),
                allocated,
            ));
        }
    };
    plan.templates = x.templates;
    Ok(plan)
}

/// The one-shot `apply` rule's refusal with its corrected example (3.3): the
/// same call bounded at the selection's actual size — the caller never saw
/// the hits, so the engine counts them (the selector compiled, nothing
/// written) and spells the bound.
#[must_use]
pub fn unbounded_apply(req: &SelectRequest, cardinality: usize) -> SurfaceError {
    refused_with(
        UNBOUNDED,
        json!({
            "fix": fixes::bounded(
                &fixes::Request {
                    select: Some(req.select.clone()),
                    effects: req.templates.clone(),
                    expect: None,
                },
                cardinality,
            )
        }),
    )
}

const UNBOUNDED: &str = "`expect.max` is required on `apply` with `select` — bound the selection, or preview it with `plan`";

/// The one-shot `apply` rule (§11.8): a selector must be bounded — the
/// caller never saw the hits (a preview is a `plan`, which needs no bound).
/// The selector-less sugar path names its targets and needs none.
pub fn require_max(req: &SelectRequest) -> Result<()> {
    if req.has_selector() && req.expect.is_none() {
        return Err(refused(UNBOUNDED));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(select: &str, templates: Json, max: Option<usize>) -> SelectRequest {
        SelectRequest {
            select: json!(select),
            templates,
            expect: max.map(|max| json!({ "max": max })),
        }
    }

    const ROLLUP: &str = "from docs where type == \"workstream\" and status == \"completed\"";

    fn rollup_templates() -> Json {
        json!([
            { "op": "insert", "into": { "kind": "document", "path": { "oqx": "project" } }, "at": "end",
              "markdown": { "oqx": "\"- completed: [\" + title + \"](\" + path + \")\"" } },
            { "op": "set", "field": "frontmatter.rolled_up", "value": true },
        ])
    }

    fn hit(id: &str, path: &str, slots: Json) -> Json {
        let mut h = json!({ "id": id, "path": path });
        if let Some(o) = slots.as_object() {
            for (k, v) in o {
                h[k] = v.clone();
            }
        }
        h
    }

    fn data(e: &SurfaceError) -> &Json {
        e.data.as_ref().expect("data")
    }

    /// `spec/mutate` §11.8's worked example: slot items appended after the
    /// user's, named `__omg_sel_<t>_<slot>`, the all-literal template
    /// contributing none; a user alias resolves into a slot.
    #[test]
    fn the_rewrite_appends_slot_projections_after_the_users_items() {
        let c = compile(&req(ROLLUP, rollup_templates(), None)).unwrap();
        assert_eq!(
            oqx::print_query(&c.rewritten).unwrap(),
            "select __omg_sel_0_into: project, __omg_sel_0_markdown: \"- completed: [\" + title + \"](\" + path + \")\" from docs where type == \"workstream\" and status == \"completed\""
        );
        assert_eq!(
            c.templates[0].slot_names(),
            ["__omg_sel_0_into", "__omg_sel_0_markdown"]
        );
        assert!(c.templates[1].slot_names().is_empty());
        assert_eq!(c.templates[1].default_target, Some(DefaultTarget::Target));
        assert_eq!((c.bound, c.implicit()), (SELECTION_CEILING, true));
        let c = compile(&req(
            "select hub: project from docs",
            json!([{ "op": "insert", "into": { "kind": "document", "path": { "oqx": "hub" } }, "markdown": "x" }]),
            Some(5),
        ))
        .unwrap();
        assert_eq!(
            oqx::print_query(&c.rewritten).unwrap(),
            "select hub: project, __omg_sel_0_into: hub from docs"
        );
        assert_eq!(
            oqx::print_query(&oqx::resolve_aliases(&c.rewritten).unwrap()).unwrap(),
            "select hub: project, __omg_sel_0_into: project from docs"
        );
        assert_eq!((c.bound, c.implicit()), (5, false));
        // A value-position directive is an expression too; `^` validates at depth 1.
        let c = compile(&req(
            "from docs",
            json!([{ "op": "set", "target": { "kind": "document", "id": { "oqx": "^docs single { id values where data.slug == ^hub_slug }" } }, "field": "frontmatter.x", "value": 1 }]),
            None,
        ))
        .unwrap();
        assert!(
            oqx::print_query(&c.rewritten)
                .unwrap()
                .starts_with("select __omg_sel_0_target: ^docs single {"),
        );
    }

    /// `id in ["a", "b"]` in a selector (`spec/surface` 4.11; `spec/mutate`
    /// §8): the parser's error under `select: ` gains the tuple hint and the
    /// same request over the rewritten selector as its `fix`.
    #[test]
    fn a_bracket_list_in_a_selector_is_fixed_to_a_tuple() {
        let t = json!([{ "op": "set", "field": "frontmatter.rolled_up", "value": true }]);
        let e = compile(&req(
            "from docs where stage in [\"nigredo\", \"albedo\"]",
            t.clone(),
            None,
        ))
        .unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(
            e.message,
            "select: unexpected '[' — expected a value (at offset 25); a list is written as a tuple: (…)"
        );
        let d = e.data.unwrap();
        assert_eq!(d["hint"], HINT);
        assert_eq!(
            d["fix"],
            r#"{"effects":[{"field":"frontmatter.rolled_up","op":"set","value":true}],"select":"from docs where stage in (\"nigredo\", \"albedo\")"}"#
        );
        // `expect` rides along; one member is a grouping — no hint, no fix
        let e = compile(&req(
            "from docs where stage in [\"a\", \"b\"]",
            t.clone(),
            Some(2),
        ))
        .unwrap_err();
        assert!(
            e.data.unwrap()["fix"]
                .as_str()
                .unwrap()
                .contains("\"expect\":{\"max\":2}")
        );
        let e = compile(&req("from docs where stage in [\"nigredo\"]", t, None)).unwrap_err();
        assert_eq!(
            e.message,
            "select: unexpected '[' — expected a value (at offset 25)"
        );
        assert!(e.data.unwrap().get("fix").is_none());
    }

    #[test]
    fn the_static_pass_refuses_what_cannot_be_a_selection() {
        let t = json!([{ "op": "set", "field": "frontmatter.x", "value": 1 }]);
        let refuse = |select: &str, templates: Json, max: Option<usize>| -> SurfaceError {
            let e = compile(&req(select, templates, max)).unwrap_err();
            assert_eq!(e.code, "filter_invalid", "{select}");
            e
        };
        let selector: [(&str, &str); 11] = [
            (
                "docs count { }",
                "select: `count` yields no rows — a selector's consumer is collect, first or single",
            ),
            (
                "select title values from docs",
                "select: a selector yields rows, not `values`",
            ),
            (
                "from links",
                "select: `links` rows have no effect target — select docs, blocks or nodes",
            ),
            (
                "from revisions where origin == \"api\"",
                "select: `revisions` rows have no effect target — select docs, blocks or nodes",
            ),
            (
                "entries(docs) collect { }",
                "select: a selector scans a root collection — `from docs`, `from blocks` or `from nodes`",
            ),
            (
                "from docs follow refs(\"a\")",
                "select: `follow` is not allowed in a selector — a hit must be a row of the root",
            ),
            (
                "from docs offset 2",
                "select: `offset` is not allowed — a selection is a set, not a page",
            ),
            (
                "select distinct type from docs",
                "select: `distinct` is not allowed in a selector",
            ),
            (
                "select __omg_x: 1 from docs",
                "select: projection `__omg_x` uses the reserved prefix `__omg_` — choose another alias",
            ),
            (
                "select __oqx_id: 1 from docs",
                "select: projection `__oqx_id` uses the reserved prefix `__oqx_` — choose another alias",
            ),
            (
                "from docs where $repo",
                "select: `$repo` was removed in surface 2.0 — reach the repository's collections through the root row: `^docs` from a top-level row (one caret per enclosing block, or the absolute `0^docs`), and the repository id as `^id` / `0^id`",
            ),
        ];
        for (select, message) in selector {
            let e = refuse(select, t.clone(), None);
            assert_eq!(data(&e)["hint"], HINT, "{select}");
            assert_eq!(e.message, message, "{select}");
        }
        // a parse error of the selector is prefixed too
        let e = refuse("from docs where (", t.clone(), None);
        assert!(e.message.starts_with("select: "), "{}", e.message);
        assert_eq!(data(&e)["hint"], HINT);
        // a filter, an order, a limit, first/single: admitted
        for ok in [
            "from docs where x exists { } order by title limit 3",
            "docs first { where status == \"a\" }",
            "docs single { }",
        ] {
            compile(&req(ok, t.clone(), None)).unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
        // the request
        let e = compile(&SelectRequest {
            select: json!(" "),
            templates: t.clone(),
            expect: None,
        })
        .unwrap_err();
        assert_eq!(
            e.message,
            "`select` must be an OQX query (a non-empty string)"
        );
        let e = compile(&SelectRequest {
            select: json!("from docs"),
            templates: json!({}),
            expect: None,
        })
        .unwrap_err();
        assert_eq!(e.message, "`effects` must be an array of effect templates");
        let e = refuse("from docs", json!([]), None);
        assert_eq!(e.message, "`effects` must name at least one template");
        for (expect, message) in [
            (json!(3), "`expect` must be an object { max }"),
            (json!({ "max": 1, "x": 2 }), "`expect`: unknown key `x`"),
            (
                json!({ "max": 1, "x": 2, "y": 3 }),
                "`expect`: unknown keys `x`, `y`",
            ),
            (json!({}), "`expect.max` must be a non-negative integer"),
            (
                json!({ "max": -1 }),
                "`expect.max` must be a non-negative integer",
            ),
            (
                json!({ "max": 1.5 }),
                "`expect.max` must be a non-negative integer",
            ),
        ] {
            let e = compile(&SelectRequest {
                select: json!("from docs"),
                templates: t.clone(),
                expect: Some(expect),
            })
            .unwrap_err();
            assert_eq!(e.message, message);
        }
        // templates
        let templates: [(Json, &str); 9] = [
            (
                json!([{ "op": "retarget", "repairs": [] }]),
                "effects[0]: `retarget` is not row-shaped — it cannot be a selector template",
            ),
            (
                json!([{ "op": "merge", "separator": " " }]),
                "effects[0]: `merge` needs `targets` — one hit cannot be merged with itself",
            ),
            (
                json!([{ "op": "nope" }]),
                "effects[0]: `op` must be one of create/insert/set/unset/move/remove/split/merge (got \"nope\")",
            ),
            (
                json!(["x"]),
                "effects[0]: a template is an effect object whose `op` is one of create/insert/set/unset/move/remove/split/merge",
            ),
            (
                json!([{ "op": "set", "field": { "oqx": "\"frontmatter.x\"" }, "value": 1 }]),
                "effects[0].field: `{ oqx }` is not allowed here",
            ),
            (
                json!([{ "op": "set", "target": { "kind": "document", "id": { "oqx": "a" }, "path": { "oqx": "b" } }, "field": "frontmatter.x", "value": 1 }]),
                "effects[0].target: give `id` or `path` as an expression, not both",
            ),
            (
                json!([{ "op": "set", "target": { "kind": { "oqx": "k" }, "id": "d_1" }, "field": "frontmatter.x", "value": 1 }]),
                "effects[0].target.kind: `{ oqx }` is not allowed here",
            ),
            (
                json!([{ "op": "remove", "targets": [{ "kind": "block", "path": { "oqx": "p" } }] }]),
                "effects[0].targets[0]: a block target has `id`, not `path`",
            ),
            (
                json!([{ "op": "set", "field": "frontmatter.x", "value": { "oqx": "a, b" } }]),
                "effects[0].value: `oqx` must be one expression over the hit, not a query",
            ),
        ];
        for (templates, message) in templates {
            let e = refuse("from docs", templates, None);
            assert_eq!(e.message, message);
            assert_eq!(data(&e)["hint"], HINT);
        }
        // a nested `{ oqx }` under `value` or a frontmatter value is data
        compile(&req(
            "from docs",
            json!([{ "op": "set", "field": "frontmatter.x", "value": { "k": { "oqx": "x" } } }]),
            None,
        ))
        .unwrap();
        compile(&req("from docs", json!([{ "op": "create", "path": "n.md", "markdown": "x", "frontmatter": { "k": { "deep": { "oqx": "x" } } } }]), None)).unwrap();
        // the shape with the probe is the ordinary §11.1 error (hint: arguments)
        let e = refuse(
            "from nodes",
            json!([{ "op": "insert", "markdown": "x" }]),
            None,
        );
        assert_eq!(
            e.message,
            "effects[0].into: `kind` must be one of document, section, block (got \"node\")"
        );
        assert_eq!(data(&e)["hint"], "arguments");
        let e = refuse("from docs", json!([{ "op": "split", "at": [1] }]), None);
        assert_eq!(data(&e)["hint"], "arguments");
        let e = refuse(
            "from blocks",
            json!([{ "op": "unset", "field": "frontmatter.x" }]),
            None,
        );
        assert!(e.message.contains("(got \"block\")"), "{}", e.message);
        // (3.2) a whole `{ oqx }` element of `targets` is a whole-target slot
        let c = compile(&req(
            "from blocks",
            json!([{ "op": "remove", "targets": [{ "oqx": "x" }] }]),
            None,
        ))
        .unwrap();
        assert_eq!(c.templates[0].slot_names(), ["__omg_sel_0_targets_0"]);
        assert!(matches!(
            c.templates[0].slots[0].kind,
            SlotKind::WholeTargets { k: 0 }
        ));
        // an expression that does not parse names the slot; the offset is shifted by 16
        let e = refuse(
            "from docs",
            json!([{ "op": "set", "field": "frontmatter.x", "value": { "oqx": "1 +" } }]),
            None,
        );
        assert_eq!(
            e.message,
            "effects[0].value: unexpected 'from' — expected a value (at offset 4)"
        );
        let e = refuse(
            "from docs",
            json!([{ "op": "set", "field": "frontmatter.x", "value": { "oqx": "a from blocks" } }]),
            None,
        );
        assert_eq!(
            e.message,
            "effects[0].value: duplicate `from` clause (at offset 14)"
        );
    }

    #[test]
    fn the_request_reads_expect_only_with_a_select() {
        assert_eq!(
            SelectRequest::from_args(&json!({ "effects": [] })).unwrap(),
            None
        );
        let r = SelectRequest::from_args(
            &json!({ "select": "from docs", "effects": [{ "op": "x" }], "expect": { "max": 3 } }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(r.expect, Some(json!({ "max": 3 })));
        assert_eq!(r.templates(), 1);
        let e = SelectRequest::from_args(&json!({ "effects": [], "expect": { "max": 1 } }))
            .unwrap_err();
        assert_eq!(
            e.message,
            "`expect` bounds a selection — pass `select` with it"
        );
        assert!(require_max(&r.clone()).is_ok());
        let e = require_max(&SelectRequest { expect: None, ..r }).unwrap_err();
        assert_eq!(
            e.message,
            "`expect.max` is required on `apply` with `select` — bound the selection, or preview it with `plan`"
        );
        assert_eq!(data(&e)["hint"], HINT);
    }

    #[test]
    fn binding_types_each_slot_and_names_the_row() {
        let c = compile(&req(ROLLUP, rollup_templates(), Some(10))).unwrap();
        let hits = vec![
            hit(
                "d_2",
                "/workstreams/a.md",
                json!({ "__omg_sel_0_into": "/projects/x.md", "__omg_sel_0_markdown": "- completed: [A](/workstreams/a.md)" }),
            ),
            hit(
                "d_5",
                "/workstreams/b.md",
                json!({ "__omg_sel_0_into": { "id": "d_9", "path": "/projects/y.md" }, "__omg_sel_0_markdown": "- completed: [B](/workstreams/b.md)" }),
            ),
        ];
        let Bound { effects, rows, .. } = bind(&c, &hits, &mut no_settle).unwrap();
        assert_eq!(
            rows,
            [
                ("d_2".to_owned(), "/workstreams/a.md".to_owned()),
                ("d_5".to_owned(), "/workstreams/b.md".to_owned())
            ]
        );
        let json: Vec<Json> = effects.iter().map(Effect::to_json).collect();
        assert_eq!(
            json,
            [
                json!({ "op": "insert", "into": { "kind": "document", "path": "/projects/x.md" }, "at": "end", "markdown": "- completed: [A](/workstreams/a.md)" }),
                json!({ "op": "set", "target": { "kind": "document", "id": "d_2" }, "field": "frontmatter.rolled_up", "value": true }),
                // a row-as-value binds by its id, whichever member held the expression
                json!({ "op": "insert", "into": { "kind": "document", "id": "d_9" }, "at": "end", "markdown": "- completed: [B](/workstreams/b.md)" }),
                json!({ "op": "set", "target": { "kind": "document", "id": "d_5" }, "field": "frontmatter.rolled_up", "value": true }),
            ]
        );
        // absent / null / [] → target_missing with the row and the expression
        for absent in [
            json!({}),
            json!({ "__omg_sel_0_into": null }),
            json!({ "__omg_sel_0_into": [] }),
        ] {
            let mut h = hit("d_2", "/w.md", absent);
            h["__omg_sel_0_markdown"] = json!("x");
            let e = bind(&c, &[h], &mut no_settle).unwrap_err();
            assert_eq!(e.code, "target_missing");
            assert_eq!(
                e.message,
                "effects[0].into.path: the expression yielded no identity for row d_2"
            );
            assert_eq!(
                *data(&e),
                json!({ "effect_index": 0, "template_index": 0, "row": { "id": "d_2", "path": "/w.md" }, "expression": "project" })
            );
        }
        // a list of one or more → ambiguous_target with the count
        let h = hit(
            "d_2",
            "/w.md",
            json!({ "__omg_sel_0_into": ["/a.md"], "__omg_sel_0_markdown": "x" }),
        );
        let e = bind(&c, &[h], &mut no_settle).unwrap_err();
        assert_eq!(e.code, "ambiguous_target");
        assert_eq!(
            e.message,
            "effects[0].into.path: the expression yielded 1 identities for row d_2; a target resolves to exactly one"
        );
        assert_eq!(data(&e)["count"], 1);
        assert_eq!(data(&e)["expression"], "project");
        // a number as a target → filter_invalid { hint: selection } with the origin
        let h = hit(
            "d_2",
            "/w.md",
            json!({ "__omg_sel_0_into": 3, "__omg_sel_0_markdown": "x" }),
        );
        let e = bind(&c, &[h], &mut no_settle).unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(
            e.message,
            "effects[0].into.path: the expression yielded a number (3), not an identity (a string or a row)"
        );
        assert_eq!(
            *data(&e),
            json!({ "reason": e.message, "hint": HINT, "effect_index": 0, "template_index": 0, "row": { "id": "d_2", "path": "/w.md" }, "expression": "project" })
        );
        // markdown must be a string
        let h = hit(
            "d_2",
            "/w.md",
            json!({ "__omg_sel_0_into": "/p.md", "__omg_sel_0_markdown": 7.5 }),
        );
        let e = bind(&c, &[h], &mut no_settle).unwrap_err();
        assert_eq!(
            e.message,
            "effects[0].markdown: the expression yielded a number (7.5), expected a string"
        );
        let h = hit("d_2", "/w.md", json!({ "__omg_sel_0_into": "/p.md" }));
        let e = bind(&c, &[h], &mut no_settle).unwrap_err();
        assert_eq!(
            e.message,
            "effects[0].markdown: the expression yielded absent for row d_2"
        );
        // an object that is not a row ref
        let c = compile(&req("from docs", json!([{ "op": "set", "field": "frontmatter.x", "value": 1 }, { "op": "insert", "into": { "kind": "document", "path": { "oqx": "p" } }, "markdown": "x" }]), None)).unwrap();
        let e = bind(
            &c,
            &[hit(
                "d_1",
                "/a.md",
                json!({ "__omg_sel_1_into": { "id": "d_2", "path": "/p.md", "extra": 1 } }),
            )],
            &mut no_settle,
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "effects[1].into.path: the expression yielded an object, not an identity (a string or a row)"
        );
        assert_eq!(data(&e)["effect_index"], 1);
        assert_eq!(data(&e)["template_index"], 1);
    }

    #[test]
    fn binding_the_hit_by_kind_and_the_other_slots() {
        // blocks: a targetless block move/remove is `targets: [hit]`; `at`
        // anchors are strings; `value` takes any JSON but never absent;
        // `targets[k].id` takes a string or a row ref's id.
        let c = compile(&req(
            "from blocks",
            json!([
                { "op": "move", "into": { "kind": "block", "id": { "oqx": "parent" } }, "at": { "after": { "oqx": "anchor" } } },
                { "op": "set", "field": "attrs.checked", "value": { "oqx": "done" } },
                { "op": "remove", "targets": [{ "kind": "block", "id": { "oqx": "sibling" } }, { "kind": "block", "id": { "oqx": "other" } }] },
                { "op": "remove" },
                { "op": "merge", "targets": [{ "kind": "block", "id": { "oqx": "a" } }, { "kind": "block", "id": "b_5" }], "separator": { "oqx": "sep" } },
                { "op": "split", "at": [2] },
            ]),
            Some(1),
        ))
        .unwrap();
        assert_eq!(c.templates[0].default_target, Some(DefaultTarget::Targets));
        assert_eq!(c.templates[1].default_target, Some(DefaultTarget::Target));
        assert_eq!(c.templates[2].default_target, None);
        assert_eq!(c.templates[3].default_target, Some(DefaultTarget::Targets));
        assert_eq!(c.templates[5].default_target, Some(DefaultTarget::Target));
        assert_eq!(
            c.templates
                .iter()
                .flat_map(Template::slot_names)
                .collect::<Vec<_>>(),
            [
                "__omg_sel_0_into",
                "__omg_sel_0_at",
                "__omg_sel_1_value",
                "__omg_sel_2_targets_0",
                "__omg_sel_2_targets_1",
                "__omg_sel_4_targets_0",
                "__omg_sel_4_separator",
            ]
        );
        let h = hit(
            "b_1",
            "/a.md",
            json!({
                "__omg_sel_0_into": { "id": "b_9", "path": "/a.md" }, "__omg_sel_0_at": "b_8",
                "__omg_sel_1_value": false,
                "__omg_sel_2_targets_0": "b_2", "__omg_sel_2_targets_1": { "id": "b_3", "path": "/a.md" },
                "__omg_sel_4_targets_0": "b_4", "__omg_sel_4_separator": " / ",
            }),
        );
        let Bound { effects, .. } = bind(&c, &[h], &mut no_settle).unwrap();
        let json: Vec<Json> = effects.iter().map(Effect::to_json).collect();
        assert_eq!(
            json[0],
            json!({ "op": "move", "targets": [{ "kind": "block", "id": "b_1" }], "into": { "kind": "block", "id": "b_9" }, "at": { "after": "b_8" } })
        );
        assert_eq!(
            json[1],
            json!({ "op": "set", "target": { "kind": "block", "id": "b_1" }, "field": "attrs.checked", "value": false })
        );
        assert_eq!(
            json[2],
            json!({ "op": "remove", "targets": [{ "kind": "block", "id": "b_2" }, { "kind": "block", "id": "b_3" }] })
        );
        assert_eq!(
            json[3],
            json!({ "op": "remove", "targets": [{ "kind": "block", "id": "b_1" }] })
        );
        assert_eq!(
            json[4],
            json!({ "op": "merge", "targets": [{ "kind": "block", "id": "b_4" }, { "kind": "block", "id": "b_5" }], "separator": " / " })
        );
        assert_eq!(
            json[5],
            json!({ "op": "split", "target": { "kind": "block", "id": "b_1" }, "at": [2] })
        );
        // over docs a targetless `remove`/`move` is the document form
        let c = compile(&req("from docs", json!([{ "op": "remove" }, { "op": "move", "to": { "oqx": "\"archive/\" + title + \".md\"" } }]), None)).unwrap();
        assert_eq!(c.templates[0].default_target, Some(DefaultTarget::Target));
        assert_eq!(c.templates[1].slot_names(), ["__omg_sel_1_to"]);
        let Bound { effects, .. } = bind(
            &c,
            &[hit(
                "d_1",
                "/a.md",
                json!({ "__omg_sel_1_to": "archive/A.md" }),
            )],
            &mut no_settle,
        )
        .unwrap();
        assert_eq!(
            effects[0].to_json(),
            json!({ "op": "remove", "target": { "kind": "document", "id": "d_1" } })
        );
        assert_eq!(
            effects[1].to_json(),
            json!({ "op": "move", "target": { "kind": "document", "id": "d_1" }, "to": "archive/A.md", "retarget_inbound": true })
        );
        // an absent value is refused (use `unset`); a row ref lands as a record
        let c = compile(&req(
            "from docs",
            json!([{ "op": "set", "field": "frontmatter.hub", "value": { "oqx": "hub" } }]),
            None,
        ))
        .unwrap();
        let e = bind(&c, &[hit("d_1", "/a.md", json!({}))], &mut no_settle).unwrap_err();
        assert_eq!(
            e.message,
            "effects[0].value: the expression yielded absent for row d_1 — use `unset` to remove a key"
        );
        let Bound { effects, .. } = bind(
            &c,
            &[hit(
                "d_1",
                "/a.md",
                json!({ "__omg_sel_0_value": { "id": "d_2", "path": "/p.md" } }),
            )],
            &mut no_settle,
        )
        .unwrap();
        assert_eq!(
            effects[0].to_json()["value"],
            json!({ "id": "d_2", "path": "/p.md" })
        );
        // a `create` per hit: path / markdown / frontmatter values (an absent one is refused too)
        let c = compile(&req(
            "from docs",
            json!([{ "op": "create", "path": { "oqx": "\"/notes/\" + slug + \".md\"" }, "markdown": { "oqx": "\"# \" + title" }, "frontmatter": { "source": { "oqx": "path" }, "layer": "draft" } }]),
            None,
        ))
        .unwrap();
        assert_eq!(
            c.templates[0].slot_names(),
            [
                "__omg_sel_0_path",
                "__omg_sel_0_markdown",
                "__omg_sel_0_fm_0"
            ]
        );
        let Bound { effects, .. } = bind(&c, &[hit("d_1", "/a.md", json!({ "__omg_sel_0_path": "/notes/a.md", "__omg_sel_0_markdown": "# A", "__omg_sel_0_fm_0": "/a.md" }))], &mut no_settle).unwrap();
        assert_eq!(
            effects[0].to_json(),
            json!({ "op": "create", "path": "/notes/a.md", "markdown": "# A", "frontmatter": { "layer": "draft", "source": "/a.md" } })
        );
        let e = bind(
            &c,
            &[hit(
                "d_1",
                "/a.md",
                json!({ "__omg_sel_0_path": "/notes/a.md", "__omg_sel_0_markdown": "# A" }),
            )],
            &mut no_settle,
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "effects[0].frontmatter.source: the expression yielded absent for row d_1"
        );
        // zero hits bind to nothing
        let Bound { effects, rows, .. } = bind(&c, &[], &mut no_settle).unwrap();
        assert!(effects.is_empty() && rows.is_empty());
    }

    #[test]
    fn lowering_errors_gain_the_template_and_the_row() {
        let rows = vec![
            ("d_1".to_owned(), "/a.md".to_owned()),
            ("d_2".to_owned(), "/b.md".to_owned()),
        ];
        let e = SurfaceError::with_data(
            "conflicting_effects",
            "x",
            json!({ "effects": [1, 3], "effect_index": 3 }),
        );
        let a = annotate(e, &rows, 2);
        let d = a.data.unwrap();
        assert_eq!(d["template_index"], 1);
        assert_eq!(d["row"], json!({ "id": "d_2", "path": "/b.md" }));
        // already annotated, or no effect index: untouched
        let e = SurfaceError::with_data("doc_missing", "x", json!({ "doc": "d" }));
        assert_eq!(annotate(e.clone(), &rows, 2), e);
        let e = SurfaceError::new("filter_invalid", "x");
        assert_eq!(annotate(e.clone(), &rows, 0), e);
    }

    #[test]
    fn offsets_shift_back_by_the_wrapper() {
        assert_eq!(
            shift_offsets("unexpected ')' (at offset 20)", -16),
            "unexpected ')' (at offset 4)"
        );
        assert_eq!(shift_offsets("no offset here", -16), "no offset here");
        assert_eq!(shift_offsets("x (at offset 3)", -16), "x (at offset 0)");
        assert_eq!(shift_offsets("x (at offset 3)", 3), "x (at offset 6)");
        assert_eq!(describe(Some(&json!(2.0))), "a number (2)");
        assert_eq!(describe(Some(&json!([1, 2]))), "a list of 2");
        assert_eq!(describe(Some(&json!("q"))), "a string (\"q\")");
        assert_eq!(describe(None), "absent");
    }

    // ---- §11.8 "Sugar" (3.2) ----------------------------------------------------------

    fn desugar(v: Json) -> Result<Json> {
        desugar_effect(&v, 0, None).map(|(v, _)| v)
    }

    /// The leader is exactly `-> ` at the start; `->x`, ` -> x`, `-->`, a
    /// bare `->` and a mid-string `-> ` are literals; `-> "-> …"` spells a
    /// literal that begins with the leader.
    #[test]
    fn the_leader_is_exact_and_everything_else_is_literal() {
        for literal in ["->x", " -> x", "-->", "->", "a -> b", "${HOME}", "x"] {
            let e = json!({ "op": "insert", "into": { "kind": "document", "path": "hub.md" }, "markdown": literal });
            assert_eq!(desugar(e.clone()).unwrap(), e, "{literal}");
            assert!(!needs_sugar(&json!([e])), "{literal}");
        }
        assert_eq!(
            desugar(json!({ "op": "insert", "into": { "kind": "document", "path": "hub.md" }, "markdown": "-> \"-> note\"" })).unwrap(),
            json!({ "op": "insert", "into": { "kind": "document", "path": "hub.md" }, "markdown": "-> note" })
        );
        assert_eq!(
            desugar(json!({ "op": "insert", "into": { "kind": "document", "path": "hub.md" }, "markdown": "-> title" })).unwrap(),
            json!({ "op": "insert", "into": { "kind": "document", "path": "hub.md" }, "markdown": { "oqx": "title" } })
        );
        // typing follows the value: `-> 1` stays an expression (a number lands as one)
        assert_eq!(
            desugar(json!({ "op": "set", "target": "d_0", "field": "frontmatter.priority", "value": "-> priority + 1" })).unwrap(),
            json!({ "op": "set", "target": { "kind": "document", "id": "d_0" }, "field": "frontmatter.priority", "value": { "oqx": "priority + 1" } })
        );
        // nested strings of a `value` are data
        let nested = json!({ "op": "set", "target": "d_0", "field": "frontmatter.x", "value": { "a": "-> b" } });
        assert_eq!(desugar(nested.clone()).unwrap()["value"], nested["value"]);
        // the request routes through the sugar path exactly when something is sugar
        assert!(needs_sugar(
            &json!([{ "op": "insert", "into": "hub.md", "markdown": "x" }])
        ));
        assert!(needs_sugar(
            &json!([{ "op": "insert", "into": { "kind": "document", "path": "hub.md" }, "markdown": "-> title" }])
        ));
        assert!(needs_sugar(
            &json!([{ "op": "remove", "targets": ["b_1"] }])
        ));
        let plain = SelectRequest::from_args(&json!({ "effects": [{ "op": "insert", "into": { "kind": "document", "path": "hub.md" }, "markdown": "->x" }] })).unwrap();
        assert!(plain.is_none());
        let sugar = SelectRequest::from_args(
            &json!({ "effects": [{ "op": "insert", "into": "hub.md", "markdown": "-> x" }] }),
        )
        .unwrap()
        .unwrap();
        assert!(!sugar.has_selector());
        assert!(require_max(&sugar).is_ok());
    }

    /// A bare string literal or an interpolation-free template literal folds
    /// to the plain literal (no `{ oqx }`); anything else is an expression.
    #[test]
    fn constant_folding_of_literal_leaders() {
        assert_eq!(desugar_expression("\"x\"", "h").unwrap(), json!("x"));
        assert_eq!(desugar_expression("`x`", "h").unwrap(), json!("x"));
        assert_eq!(desugar_expression("`a\\`b`", "h").unwrap(), json!("a`b"));
        assert_eq!(
            desugar_expression("`${title} (${era})`", "h").unwrap(),
            json!({ "oqx": "`${title} (${era})`" })
        );
        assert_eq!(desugar_expression("1", "h").unwrap(), json!({ "oqx": "1" }));
        assert_eq!(
            desugar_expression("\"a\" + \"b\"", "h").unwrap(),
            json!({ "oqx": "\"a\" + \"b\"" })
        );
        // a folded leader in a target is a bare string, then normalized
        assert_eq!(
            desugar(json!({ "op": "insert", "into": "-> \"hub.md\"", "markdown": "x" })).unwrap(),
            json!({ "op": "insert", "into": { "kind": "document", "path": "hub.md" }, "markdown": "x" })
        );
        // an unparsable expression: the offset counts from the written string
        let e =
            desugar(json!({ "op": "insert", "into": "hub.md", "markdown": "-> 1 +" })).unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(data(&e)["hint"], HINT);
        assert_eq!(
            e.message,
            "effects[0].markdown: unexpected 'from' — expected a value (at offset 7)"
        );
        let e =
            desugar(json!({ "op": "insert", "into": "hub.md", "markdown": "-> a from blocks" }))
                .unwrap_err();
        assert!(e.message.ends_with("(at offset 17)"), "{}", e.message);
    }

    /// Bare targets: a path, an id by its prefix, a `$new.n` (provisional
    /// kind, recorded for the settlement), a `-> ` expression as the whole
    /// target; a locator is refused with the fix; anything else is no target.
    #[test]
    fn bare_targets_normalize_before_the_shape_check() {
        let d = |v: Json| desugar(v).unwrap();
        assert_eq!(
            d(json!({ "op": "insert", "into": "hub.md", "markdown": "x" }))["into"],
            json!({ "kind": "document", "path": "hub.md" })
        );
        assert_eq!(
            d(json!({ "op": "insert", "into": "/notes/a", "markdown": "x" }))["into"],
            json!({ "kind": "document", "path": "/notes/a" })
        );
        assert_eq!(
            d(json!({ "op": "insert", "into": "d_2", "markdown": "x" }))["into"],
            json!({ "kind": "document", "id": "d_2" })
        );
        assert_eq!(
            d(json!({ "op": "set", "target": "b_5", "field": "attrs.checked", "value": true }))["target"],
            json!({ "kind": "block", "id": "b_5" })
        );
        assert_eq!(
            d(json!({ "op": "set", "target": "n_0123456789ab", "field": "value", "value": 1 }))["target"],
            json!({ "kind": "node", "id": "n_0123456789ab" })
        );
        assert_eq!(
            d(json!({ "op": "remove", "targets": ["b_8", { "kind": "block", "id": "b_9" }] }))["targets"],
            json!([{ "kind": "block", "id": "b_8" }, { "kind": "block", "id": "b_9" }])
        );
        // `$new.n`: a provisional kind the slot admits, and the member recorded
        let (v, sugar) = desugar_effect(
            &json!({ "op": "insert", "into": "$new.0", "markdown": "x" }),
            0,
            None,
        )
        .unwrap();
        assert_eq!(v["into"], json!({ "kind": "document", "id": "$new.0" }));
        assert_eq!(sugar.symbols, [Member::Into]);
        let (v, sugar) = desugar_effect(
            &json!({ "op": "set", "target": "$new.2", "field": "markdown", "value": "x" }),
            0,
            None,
        )
        .unwrap();
        assert_eq!(v["target"], json!({ "kind": "block", "id": "$new.2" }));
        assert_eq!(sugar.symbols, [Member::Target]);
        let (v, sugar) =
            desugar_effect(&json!({ "op": "remove", "targets": ["$new.1"] }), 0, None).unwrap();
        assert_eq!(v["targets"], json!([{ "kind": "block", "id": "$new.1" }]));
        assert_eq!(sugar.symbols, [Member::Targets(0)]);
        // a `-> ` whole target is the directive; a leader in `id` / `path` too
        assert_eq!(
            d(json!({ "op": "insert", "into": "-> project", "markdown": "x" }))["into"],
            json!({ "oqx": "project" })
        );
        assert_eq!(
            d(
                json!({ "op": "insert", "into": { "kind": "document", "path": "-> project" }, "markdown": "x" })
            )["into"],
            json!({ "kind": "document", "path": { "oqx": "project" } })
        );
        // a locator: hint arguments, with the fix
        let e = desugar(json!({ "op": "insert", "into": "hub.md#Status", "markdown": "x" }))
            .unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(data(&e)["hint"], "arguments");
        assert_eq!(data(&e)["fix"], crate::fixes::LOCATOR);
        assert_eq!(
            e.message,
            "effects[0].into: \"hub.md#Status\" is a locator, not a target — a bare target is a document path, a `b_`/`d_`/`n_` id or `$new.n`"
        );
        // anything else is no target
        let e = desugar(json!({ "op": "insert", "into": "hub", "markdown": "x" })).unwrap_err();
        assert_eq!(data(&e)["hint"], "arguments");
        assert_eq!(
            e.message,
            "effects[0].into: a target is { kind: …, … } or a bare document path, a `b_`/`d_`/`n_` id or `$new.n` (got \"hub\")"
        );
        // the op's kind table still applies to the normalized kind (the probe check)
        let e = compile(&req(
            "from docs",
            json!([{ "op": "split", "target": "d_0", "at": [1] }]),
            None,
        ))
        .unwrap_err();
        assert_eq!(
            e.message,
            "effects[0].target: `kind` must be one of block (got \"document\")"
        );
        assert_eq!(data(&e)["hint"], "arguments");
    }

    /// A leader where no expression is admitted — `op`, `field`, `expect`, a
    /// target's other members, a whole `at`, `split.at`, an unknown key — is
    /// refused with `hint: "selection"`.
    #[test]
    fn a_leader_in_a_non_expression_slot_is_refused() {
        let refuse = |v: Json| -> SurfaceError {
            let e = desugar(v).unwrap_err();
            assert_eq!(e.code, "filter_invalid");
            assert_eq!(data(&e)["hint"], HINT);
            e
        };
        for (v, here) in [
            (
                json!({ "op": "set", "target": "d_0", "field": "-> f", "value": 1 }),
                "effects[0].field",
            ),
            (
                json!({ "op": "set", "target": "d_0", "field": "frontmatter.x", "value": 1, "expect": { "revision": "-> r" } }),
                "effects[0].expect.revision",
            ),
            (
                json!({ "op": "insert", "into": { "kind": "section", "heading_id": "-> h" }, "markdown": "x" }),
                "effects[0].into.heading_id",
            ),
            (
                json!({ "op": "insert", "into": "hub.md", "at": "-> end", "markdown": "x" }),
                "effects[0].at",
            ),
            (
                json!({ "op": "insert", "into": "hub.md", "at": { "before": "b_1", "x": "-> y" }, "markdown": "x" }),
                "effects[0].at.x",
            ),
            (
                json!({ "op": "split", "target": "b_1", "at": ["-> 2"] }),
                "effects[0].at[0]",
            ),
            (
                json!({ "op": "set", "target": "d_0", "field": "frontmatter.x", "value": 1, "bogus": "-> z" }),
                "effects[0].bogus",
            ),
            (
                json!({ "op": "retarget", "repairs": [{ "from": "-> a", "to": "b" }] }),
                "effects[0].repairs[0].from",
            ),
        ] {
            let e = refuse(v);
            assert_eq!(
                e.message,
                format!("{here}: `-> ` is not allowed here — this member takes no expression")
            );
        }
        // an unknown op — `-> set` included — is left for the shape check (hint arguments)
        for v in [
            json!({ "op": "frobnicate", "x": "-> y" }),
            json!({ "op": "-> set", "target": "d_0", "field": "frontmatter.x", "value": 1 }),
        ] {
            assert_eq!(desugar(v.clone()).unwrap(), v);
            let e = Effect::validate(&v, 0).map_err(shape_error).unwrap_err();
            assert!(e.message.contains("`op` must be one of"), "{}", e.message);
            assert_eq!(data(&e)["hint"], "arguments");
        }
    }

    /// The whole-target binding: a row by its id, a string as a bare target,
    /// anything else refused; a `$new.n` string is a symbol to settle.
    #[test]
    fn binding_a_whole_target() {
        let c = compile(&req(
            "from docs",
            json!([{ "op": "insert", "into": "-> project", "markdown": "x" }, { "op": "set", "target": "-> hub", "field": "frontmatter.x", "value": 1 }]),
            None,
        ))
        .unwrap();
        let Bound { effects, .. } = bind(
            &c,
            &[hit("d_1", "/a.md", json!({ "__omg_sel_0_into": "hub.md", "__omg_sel_1_target": { "id": "d_7", "path": "/hub.md" } }))],
            &mut no_settle,
        )
        .unwrap();
        assert_eq!(
            effects.iter().map(Effect::to_json).collect::<Vec<_>>(),
            [
                json!({ "op": "insert", "into": { "kind": "document", "path": "hub.md" }, "at": "end", "markdown": "x" }),
                json!({ "op": "set", "target": { "kind": "document", "id": "d_7" }, "field": "frontmatter.x", "value": 1 }),
            ]
        );
        let Bound { effects, .. } = bind(
            &c,
            &[hit(
                "d_1",
                "/a.md",
                json!({ "__omg_sel_0_into": "b_3", "__omg_sel_1_target": "d_2" }),
            )],
            &mut no_settle,
        )
        .unwrap();
        assert_eq!(
            effects[0].to_json()["into"],
            json!({ "kind": "block", "id": "b_3" })
        );
        let e = bind(
            &c,
            &[hit(
                "d_1",
                "/a.md",
                json!({ "__omg_sel_0_into": "hub", "__omg_sel_1_target": "d_2" }),
            )],
            &mut no_settle,
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "effects[0].into: the expression yielded a string (\"hub\"), not an identity (a document path, an id or a row)"
        );
        assert_eq!(data(&e)["hint"], HINT);
        assert_eq!(data(&e)["template_index"], 0);
        // a `$new.n` is a symbol: provisional kind, settled by the caller
        let mut seen: Vec<(Vec<Member>, usize)> = Vec::new();
        let mut settle =
            |_: &mut Json, m: &[Member], p: &[Effect]| seen.push((m.to_vec(), p.len()));
        let Bound { effects, .. } = bind(
            &c,
            &[hit(
                "d_1",
                "/a.md",
                json!({ "__omg_sel_0_into": "$new.0", "__omg_sel_1_target": "d_2" }),
            )],
            &mut settle,
        )
        .unwrap();
        assert_eq!(
            effects[0].to_json()["into"],
            json!({ "kind": "document", "id": "$new.0" })
        );
        // the prefix is empty for the first effect: nothing to settle against yet
        assert!(seen.is_empty());
    }

    // ---- the selector-less path, over a store ----------------------------------------

    use omgbase_store::{Config, MemDocStore, SequentialMinter};

    const TS: &str = "2026-10-13T10:00:00.000Z";

    fn seeded() -> (Store, PlanContext, MemDocStore) {
        let mut store =
            Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap();
        let repo = store.create_repo("fixture").unwrap();
        for (path, source) in [
            (
                "hub.md",
                "---\ntype: project\n---\n\n# Hub\n\n## Status\n\nNothing yet.\n",
            ),
            (
                "ws/alpha.md",
                "---\ntype: workstream\nstatus: completed\nproject: hub.md\n---\n\n# Alpha\n",
            ),
        ] {
            store
                .observe_one(&repo, path, source, TS, &Config::default())
                .unwrap();
        }
        let ctx = PlanContext {
            repo_id: repo,
            ts: "2026-10-13T10:01:00.000Z".to_owned(),
            config: Config::default(),
        };
        (store, ctx, MemDocStore::new())
    }

    fn plan_plain(
        store: &mut Store,
        ctx: &PlanContext,
        ds: &MemDocStore,
        effects: Json,
    ) -> Result<omgbase_mutate::Plan> {
        let req = SelectRequest::from_args(&json!({ "effects": effects }))
            .unwrap()
            .expect("sugar");
        plan_selected(store, ds, ctx, &req, HashMap::new())
    }

    /// Without a selector a `-> ` slot evaluates in its own target's row:
    /// the plan has no `selection`, records the effects as written as
    /// `templates`, and its core equals the literal plan's (`plan_id`); a
    /// folded leader needs no row and yields no `templates`.
    #[test]
    fn the_selector_less_path_evaluates_in_the_targets_row() {
        let (mut store, ctx, ds) = seeded();
        let plan = plan_plain(
            &mut store,
            &ctx,
            &ds,
            json!([
                { "op": "insert", "into": "hub.md", "markdown": "-> `## ${title} (${type})`" },
                { "op": "set", "target": "/ws/alpha.md", "field": "frontmatter.hub", "value": "-> project" },
                { "op": "set", "target": "d_1", "field": "frontmatter.n", "value": "-> 1 + 1" },
            ]),
        )
        .unwrap();
        assert!(plan.selection.is_none());
        assert_eq!(plan.planner_v, "p3");
        let effects: Vec<Json> = plan.effects.iter().map(Effect::to_json).collect();
        assert_eq!(effects[0]["markdown"], "## Hub (project)");
        assert_eq!(effects[1]["value"], "hub.md");
        assert_eq!(
            effects[1]["target"],
            json!({ "kind": "document", "id": "d_1", "path": "ws/alpha.md" })
        );
        assert_eq!(effects[2]["value"], 2);
        let templates = plan.templates.clone().expect("templates");
        assert_eq!(templates[0]["markdown"], "-> `## ${title} (${type})`");
        assert_eq!(templates[1]["target"], "/ws/alpha.md");
        let wire = plan.to_json(false);
        assert!(wire.get("templates").is_some());
        assert!(plan.core_json().get("templates").is_none());
        // the literal spelling (no sugar: the plain path) digests identically
        let literal = store
            .plan_effects(
                &ctx,
                &omgbase_mutate::Effect::list_from_json(&json!([
                    { "op": "insert", "into": { "kind": "document", "path": "hub.md" }, "markdown": "## Hub (project)" },
                    { "op": "set", "target": { "kind": "document", "path": "ws/alpha.md" }, "field": "frontmatter.hub", "value": "hub.md" },
                    { "op": "set", "target": { "kind": "document", "id": "d_1" }, "field": "frontmatter.n", "value": 2 },
                ]))
                .unwrap(),
                &ds,
            )
            .unwrap();
        assert_eq!(literal.plan_id, plan.plan_id);
        assert!(literal.templates.is_none());
        // folded leaders and bare targets alone: no expression, no `templates`, same digest
        let folded = plan_plain(
            &mut store,
            &ctx,
            &ds,
            json!([
                { "op": "insert", "into": "hub.md", "markdown": "-> \"## Hub (project)\"" },
                { "op": "set", "target": "/ws/alpha.md", "field": "frontmatter.hub", "value": "-> `hub.md`" },
                { "op": "set", "target": "d_1", "field": "frontmatter.n", "value": 2 },
            ]),
        )
        .unwrap();
        assert_eq!(folded.plan_id, plan.plan_id);
        assert!(folded.templates.is_none());
        // the intent record carries `templates` only when the plan does
        let record = omgbase_mutate::effects::intent_record(
            &plan.plan_id,
            &plan.effects,
            None,
            plan.templates.as_deref(),
        );
        assert!(
            record.contains("\"templates\":[{\"into\":\"hub.md\""),
            "{record}"
        );
    }

    /// The selector-less refusals and the row scope's errors.
    #[test]
    fn the_selector_less_path_refuses_what_has_no_row() {
        let (mut store, ctx, ds) = seeded();
        let refuse = |store: &mut Store, effects: Json| -> SurfaceError {
            plan_plain(store, &ctx, &ds, effects).unwrap_err()
        };
        let e = refuse(
            &mut store,
            json!([{ "op": "create", "path": "n.md", "markdown": "-> title" }]),
        );
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(data(&e)["hint"], HINT);
        assert_eq!(
            e.message,
            "effects[0]: a `create` has no row — an expression on a create needs a selector (`select`)"
        );
        // a folded leader on a create is a literal and fine
        let plan = plan_plain(
            &mut store,
            &ctx,
            &ds,
            json!([{ "op": "create", "path": "n.md", "markdown": "-> \"# N\"" }]),
        )
        .unwrap();
        assert_eq!(plan.effects[0].to_json()["markdown"], "# N");
        assert!(plan.templates.is_none());
        let e = refuse(
            &mut store,
            json!([{ "op": "insert", "into": "-> project", "markdown": "-> title" }]),
        );
        assert_eq!(
            e.message,
            "effects[0].into: an expression target needs a selector — without `select` there is no row to read it from"
        );
        let e = refuse(
            &mut store,
            json!([{ "op": "set", "target": { "kind": "document", "id": "-> x" }, "field": "frontmatter.a", "value": "-> title" }]),
        );
        assert!(
            e.message
                .starts_with("effects[0].target: an expression target needs a selector"),
            "{}",
            e.message
        );
        let e = refuse(
            &mut store,
            json!([
                { "op": "create", "path": "n.md", "markdown": "# N" },
                { "op": "insert", "into": "$new.0", "markdown": "-> title" },
            ]),
        );
        assert_eq!(
            e.message,
            "effects[1].into: $new.0 has no row yet — it is created by this plan; use a literal target or a selector"
        );
        // a literal target that names no row is the lowering's own error
        let e = refuse(
            &mut store,
            json!([{ "op": "set", "target": "gone.md", "field": "frontmatter.a", "value": "-> title" }]),
        );
        assert_eq!(e.code, "doc_missing");
        assert_eq!(data(&e)["doc"], "gone.md");
        let e = refuse(
            &mut store,
            json!([{ "op": "insert", "into": "b_99", "markdown": "-> text" }]),
        );
        assert_eq!(e.code, "parent_missing");
        let e = refuse(
            &mut store,
            json!([{ "op": "set", "target": "b_99", "field": "markdown", "value": "-> text" }]),
        );
        assert_eq!(e.code, "block_missing");
        // a binding error names the effect and the row, never a template
        let e = refuse(
            &mut store,
            json!([{ "op": "insert", "into": "hub.md", "markdown": "-> nope" }]),
        );
        assert_eq!(
            e.message,
            "effects[0].markdown: the expression yielded absent for row d_0"
        );
        assert_eq!(
            *data(&e),
            json!({ "reason": e.message, "hint": HINT, "effect_index": 0, "row": { "id": "d_0", "path": "/hub.md" }, "expression": "nope" })
        );
    }

    /// A bare `$new.n` takes the kind the symbol table recorded; the slot's
    /// kind table then applies to it (with `effect_index`); a symbol nothing
    /// created is the planner's `target_missing { symbol }`.
    #[test]
    fn bare_new_symbols_settle_against_the_prefix_plan() {
        let (mut store, ctx, ds) = seeded();
        let plan = plan_plain(
            &mut store,
            &ctx,
            &ds,
            json!([
                { "op": "create", "path": "n.md", "markdown": "# N\n\nBody." },
                { "op": "insert", "into": "$new.0", "markdown": "Tail." },
                { "op": "set", "target": "$new.2", "field": "markdown", "value": "Body, edited." },
                { "op": "remove", "targets": ["$new.1"] },
            ]),
        )
        .unwrap();
        let effects: Vec<Json> = plan.effects.iter().map(Effect::to_json).collect();
        assert_eq!(
            effects[1]["into"],
            json!({ "kind": "document", "id": "$new.0", "path": "n.md" })
        );
        assert_eq!(
            effects[2]["target"],
            json!({ "kind": "block", "id": "$new.2" })
        );
        assert_eq!(
            effects[3]["targets"],
            json!([{ "kind": "block", "id": "$new.1" }])
        );
        assert!(plan.templates.is_none());
        let e = plan_plain(
            &mut store,
            &ctx,
            &ds,
            json!([
                { "op": "create", "path": "n.md", "markdown": "# N" },
                { "op": "unset", "target": "$new.1", "field": "frontmatter.k" },
            ]),
        )
        .unwrap_err();
        assert_eq!(e.code, "filter_invalid");
        assert_eq!(
            e.message,
            "effects[1].target: `kind` must be one of document (got \"block\")"
        );
        assert_eq!(data(&e)["effect_index"], 1);
        assert_eq!(data(&e)["hint"], "arguments");
        let e = plan_plain(
            &mut store,
            &ctx,
            &ds,
            json!([{ "op": "insert", "into": "$new.3", "markdown": "x" }]),
        )
        .unwrap_err();
        assert_eq!(e.code, "target_missing");
        assert_eq!(data(&e)["symbol"], "$new.3");
    }
}
