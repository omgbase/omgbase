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
//! **Cardinality.** `expect.max` (a non-negative integer; required on a
//! one-shot `apply`, optional on `plan` / `execute`) bounds the selection; the
//! query runs with `limit = max + 1` (or `SELECTION_CEILING + 1` without a
//! `max`) and more hits than the bound is `selection_too_large { cardinality,
//! max, implicit? }` — the engine never plans a partial set. Zero hits are a
//! plan with no effects (execute / apply → `commit: null`).

use std::collections::HashMap;

use omgbase_mutate::effects::{SELECTION_CEILING, Selection, SelectionExpect, js_number};
use omgbase_mutate::{Effect, ErrorCode, MutationError};
use omgbase_store::effects_plan::PlanContext;
use omgbase_store::{DocStore, Store};
use oqx::Consumer;
use oqx::ast::{Expr, Query, SelectItem};
use serde_json::{Map, Value as Json, json};

use crate::context::{SemanticVec, Target};
use crate::error::{Result, SurfaceError};
use crate::planner::root_target;
use crate::query::{
    HIT_ID, HIT_PATH, QueryOptions, check_reserved_aliases, check_root_spellings, query_ast,
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

// ---- the request ----------------------------------------------------------------------

/// `plan` / `apply` / `execute` with a `select`: the selector, the templates
/// (the call's `effects`) and the optional bound, as given.
#[derive(Clone, Debug, PartialEq)]
pub struct SelectRequest {
    pub select: Json,
    pub templates: Json,
    pub expect: Option<Json>,
}

impl SelectRequest {
    /// Read a tool's or a fixture step's arguments: `None` when the call
    /// names neither `select` nor `expect` (the plain `effects` path);
    /// `expect` without `select` is refused as the reference's planner
    /// refuses it. Nothing else is checked here — [`compile`] does, in the
    /// reference's order.
    pub fn from_args(args: &Json) -> Result<Option<Self>> {
        let select = args.get("select").filter(|v| !v.is_null());
        let expect = args.get("expect").filter(|v| !v.is_null());
        if select.is_none() && expect.is_none() {
            return Ok(None);
        }
        let Some(select) = select else {
            return Err(refused(
                "`expect` bounds a selection — pass `select` with it",
            ));
        };
        Ok(Some(Self {
            select: select.clone(),
            templates: args.get("effects").cloned().unwrap_or(Json::Null),
            expect: expect.cloned(),
        }))
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
/// copies it and fills the slots), its slots and the default target.
#[derive(Clone, Debug)]
pub struct Template {
    index: usize,
    base: Map<String, Json>,
    slots: Vec<Slot>,
    default_target: Option<DefaultTarget>,
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

/// Shift the `(at offset N)` of a parse error back by the wrapper's head.
fn shift_offsets(message: &str, by: usize) -> String {
    const MARK: &str = "(at offset ";
    let Some(i) = message.find(MARK) else {
        return message.to_owned();
    };
    let rest = &message[i + MARK.len()..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return message.to_owned();
    }
    let n: usize = digits.parse().unwrap_or(0);
    format!(
        "{}{MARK}{}{}",
        &message[..i],
        n.saturating_sub(by),
        &rest[digits.len()..]
    )
}

/// Parse one `{ oqx }` expression through the wrapper (module docs): the one
/// select item of an otherwise empty query over `docs`.
fn parse_expression(source: &str, here: &str) -> Result<SelectItem> {
    let wrapped = format!("{WRAP_HEAD}{source}{WRAP_TAIL}");
    let head = WRAP_HEAD.chars().count();
    let mut q = oqx::parse_string(&wrapped)
        .map_err(|e| refused(format!("{here}: {}", shift_offsets(&e.message, head))))?;
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
    }
}

fn hit_ref(root: Target, id: &str) -> Json {
    json!({ "kind": hit_kind(root), "id": id })
}

/// The reference's `admitTemplate`, member by member.
struct Admit<'a> {
    here: String,
    raw: &'a Map<String, Json>,
    root: Target,
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
    /// { oqx } }`; absent → the hit when `defaultable`.
    fn target_slot(&mut self, key: &'static str, defaultable: bool) -> Result<bool> {
        self.slot_keys.push(key);
        let Some(t) = self.raw.get(key) else {
            if !defaultable {
                return Ok(false);
            }
            self.probe.insert(key.to_owned(), hit_ref(self.root, PROBE));
            return Ok(true);
        };
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

    /// `targets[]`: each element `{ kind: "block", id: { oqx } }` yields one
    /// block id; absent → `[the hit]` when `defaultable`.
    fn targets_slot(&mut self, defaultable: bool) -> Result<bool> {
        self.slot_keys.push("targets");
        let Some(list) = self.raw.get("targets") else {
            if !defaultable {
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
/// `effects[i]` messages, `hint: "arguments"`).
fn admit_template(index: usize, raw: &Json, root: Target) -> Result<Template> {
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
            if a.target_slot("into", true)? {
                default_target = Some(DefaultTarget::Into);
            }
            a.at_slot()?;
            a.string_slot("markdown")?;
        }
        "set" => {
            if a.target_slot("target", true)? {
                default_target = Some(DefaultTarget::Target);
            }
            a.value_slot()?;
        }
        "unset" | "split" => {
            if a.target_slot("target", true)? {
                default_target = Some(DefaultTarget::Target);
            }
        }
        "move" => {
            if raw.contains_key("into") {
                // the block form: `targets` default to the hit, `into` is the destination
                if a.targets_slot(true)? {
                    default_target = Some(DefaultTarget::Targets);
                }
                a.target_slot("into", false)?;
                a.at_slot()?;
            } else {
                if a.target_slot("target", true)? {
                    default_target = Some(DefaultTarget::Target);
                }
                a.string_slot("to")?;
            }
        }
        "remove" => {
            let doc_form = raw.contains_key("target")
                || (!raw.contains_key("targets") && root == Target::Docs);
            if doc_form {
                if a.target_slot("target", true)? {
                    default_target = Some(DefaultTarget::Target);
                }
            } else if a.targets_slot(true)? {
                default_target = Some(DefaultTarget::Targets);
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
    // The shape, with a probe in every slot (the §11.1 messages, naming `effects[i]`).
    Effect::validate(&Json::Object(probe), index).map_err(shape_error)?;
    Ok(Template {
        index,
        base,
        slots,
        default_target,
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
fn admit_selector(select: &str) -> Result<(Query, Target)> {
    let raw = oqx::parse_string(select).map_err(|e| refused(format!("select: {}", e.message)))?;
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
            return Err(refused(
                "select: a selector scans a root collection — `from docs`, `from blocks` or `from nodes`",
            ));
        }
        Some(Target::Links) => {
            return Err(refused(
                "select: `links` rows have no effect target — select docs, blocks or nodes",
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
/// selector's admission, the templates' admission and the rewrite. Nothing
/// is read.
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
    let (raw, root) = admit_selector(select)?;
    let templates = templates
        .iter()
        .enumerate()
        .map(|(t, v)| admit_template(t, v, root))
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
    })
}

// ---- the binding -----------------------------------------------------------------------

/// A hit's `(id, path)`.
pub type Row = (String, String);

/// `{ effect_index, template_index, row, expression }` — what every error
/// from a slot carries.
fn slot_data(k: usize, t: usize, row: &Row, expression: &str) -> Json {
    json!({
        "effect_index": k,
        "template_index": t,
        "row": { "id": row.0, "path": row.1 },
        "expression": expression,
    })
}

/// One hit × one template → the concrete effect (§11.8's table; the
/// reference's `bind`).
fn bind_one(c: &Compiled, hit: &Json, t: &Template, k: usize, row: &Row) -> Result<Effect> {
    let mut e = Json::Object(t.base.clone());
    match t.default_target {
        Some(DefaultTarget::Target) => e["target"] = hit_ref(c.root, &row.0),
        Some(DefaultTarget::Into) => e["into"] = hit_ref(c.root, &row.0),
        Some(DefaultTarget::Targets) => e["targets"] = json!([hit_ref(c.root, &row.0)]),
        None => {}
    }
    for s in &t.slots {
        let v = hit.get(slot_name(t.index, &s.name));
        let absent = v.is_none_or(Json::is_null);
        let data = || slot_data(k, t.index, row, &s.expression);
        match &s.kind {
            SlotKind::Identity { .. } | SlotKind::TargetsIdentity { .. } => {
                if absent || v.and_then(Json::as_array).is_some_and(Vec::is_empty) {
                    return Err(MutationError::with_data(
                        ErrorCode::TargetMissing,
                        format!(
                            "{}: the expression yielded no identity for row {}",
                            s.here, row.0
                        ),
                        data(),
                    )
                    .into());
                }
                let v = v.expect("not absent");
                if let Some(a) = v.as_array() {
                    let mut d = data();
                    d["count"] = json!(a.len());
                    return Err(MutationError::with_data(
                        ErrorCode::AmbiguousTarget,
                        format!(
                            "{}: the expression yielded {} identities for row {}; a target resolves to exactly one",
                            s.here,
                            a.len(),
                            row.0
                        ),
                        d,
                    )
                    .into());
                }
                // A string lands as the member that held the expression; a
                // row ref as `id` (the reference's `identityMember`).
                let (member, value) = match (v.as_str(), row_ref(v)) {
                    (Some(s), _) => (None, json!(s)),
                    (None, Some((id, _))) => (Some("id".to_owned()), json!(id)),
                    (None, None) => {
                        return Err(refused_with(
                            format!(
                                "{}: the expression yielded {}, not an identity (a string or a row)",
                                s.here,
                                describe(Some(v))
                            ),
                            data(),
                        ));
                    }
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
            SlotKind::Str { .. } | SlotKind::At { .. } => {
                if absent {
                    return Err(refused_with(
                        format!(
                            "{}: the expression yielded absent for row {}",
                            s.here, row.0
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
                            row.0,
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
    Effect::validate(&e, k).map_err(shape_error)
}

/// The concrete effects of `hits × templates` (§11.8's expansion rule), with
/// each hit's `(id, path)` in result order.
pub fn bind(c: &Compiled, hits: &[Json]) -> Result<(Vec<Effect>, Vec<Row>)> {
    let mut effects = Vec::with_capacity(hits.len() * c.templates.len());
    let mut rows = Vec::with_capacity(hits.len());
    for hit in hits {
        let row: Row = (
            hit.get(HIT_ID)
                .and_then(Json::as_str)
                .unwrap_or_default()
                .to_owned(),
            hit.get(HIT_PATH)
                .and_then(Json::as_str)
                .unwrap_or_default()
                .to_owned(),
        );
        for t in &c.templates {
            let k = effects.len();
            effects.push(bind_one(c, hit, t, k, &row)?);
        }
        rows.push(row);
    }
    Ok((effects, rows))
}

/// `selection_too_large { cardinality, max, implicit? }`: `cardinality` is
/// `">max"` when the page was truncated at the bound, the exact count when
/// it was `bound + 1` (`first`/`single` under `max: 0`).
fn too_large(truncated: bool, hits: usize, c: &Compiled) -> SurfaceError {
    let mut data = json!({
        "cardinality": if truncated { json!(format!(">{}", c.bound)) } else { json!(hits) },
        "max": c.bound,
    });
    if c.implicit() {
        data["implicit"] = json!(true);
    }
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

/// What the selector produced: the concrete effects, the frozen record, and
/// the hits' identities for error annotation.
#[derive(Clone, Debug)]
pub struct Expansion {
    pub effects: Vec<Effect>,
    pub selection: Selection,
    pub rows: Vec<Row>,
}

/// Run the selector and expand it (module docs; the reference's
/// `compileSelection`). `semantic` is the embedded phrases of the selector
/// ([`crate::query::embed_phrases`]).
pub fn expand(
    store: &Store,
    repo_id: &str,
    req: &SelectRequest,
    semantic: HashMap<String, SemanticVec>,
) -> Result<Expansion> {
    let c = compile(req)?;
    let opts = QueryOptions {
        limit: Some(c.bound.saturating_add(1)),
        cursor: None,
        provider: None,
        in_memory: false,
    };
    let res = query_ast(store, repo_id, &c.rewritten, opts, semantic)?;
    if res.truncated || res.hits.len() > c.bound {
        return Err(too_large(res.truncated, res.hits.len(), &c));
    }
    let (effects, rows) = bind(&c, &res.hits)?;
    let selection = Selection {
        query: req.select_str().to_owned(),
        expect: c.expect,
        templates: req.templates.as_array().cloned().unwrap_or_default(),
        cardinality: rows.len(),
        identities: rows.iter().map(|(id, _)| id.clone()).collect(),
    };
    Ok(Expansion {
        effects,
        selection,
        rows,
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
/// [`Store::apply_planned`].
pub fn plan_selected(
    store: &mut Store,
    doc_store: &dyn DocStore,
    ctx: &PlanContext,
    req: &SelectRequest,
    semantic: HashMap<String, SemanticVec>,
) -> Result<omgbase_mutate::Plan> {
    let x = expand(store, &ctx.repo_id, req, semantic)?;
    store
        .plan_selected(ctx, &x.effects, Some(x.selection), doc_store)
        .map_err(|e| annotate(SurfaceError::from(e), &x.rows, req.templates()))
}

/// The one-shot `apply` rule (§11.8): a selector must be bounded — the
/// caller never saw the hits (a preview is a `plan`, which needs no bound).
pub fn require_max(req: &SelectRequest) -> Result<()> {
    if req.expect.is_none() {
        return Err(refused(
            "`expect.max` is required on `apply` with `select` — bound the selection, or preview it with `plan`",
        ));
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

    #[test]
    fn the_static_pass_refuses_what_cannot_be_a_selection() {
        let t = json!([{ "op": "set", "field": "frontmatter.x", "value": 1 }]);
        let refuse = |select: &str, templates: Json, max: Option<usize>| -> SurfaceError {
            let e = compile(&req(select, templates, max)).unwrap_err();
            assert_eq!(e.code, "filter_invalid", "{select}");
            e
        };
        let selector: [(&str, &str); 10] = [
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
        // a bare `{ oqx }` element of `targets` is a target shape error
        let e = refuse(
            "from blocks",
            json!([{ "op": "remove", "targets": [{ "oqx": "x" }] }]),
            None,
        );
        assert!(
            e.message.starts_with("effects[0].targets[0]: a target is"),
            "{}",
            e.message
        );
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
        let (effects, rows) = bind(&c, &hits).unwrap();
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
            let e = bind(&c, &[h]).unwrap_err();
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
        let e = bind(&c, &[h]).unwrap_err();
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
        let e = bind(&c, &[h]).unwrap_err();
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
        let e = bind(&c, &[h]).unwrap_err();
        assert_eq!(
            e.message,
            "effects[0].markdown: the expression yielded a number (7.5), expected a string"
        );
        let h = hit("d_2", "/w.md", json!({ "__omg_sel_0_into": "/p.md" }));
        let e = bind(&c, &[h]).unwrap_err();
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
        let (effects, _) = bind(&c, &[h]).unwrap();
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
        let (effects, _) = bind(
            &c,
            &[hit(
                "d_1",
                "/a.md",
                json!({ "__omg_sel_1_to": "archive/A.md" }),
            )],
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
        let e = bind(&c, &[hit("d_1", "/a.md", json!({}))]).unwrap_err();
        assert_eq!(
            e.message,
            "effects[0].value: the expression yielded absent for row d_1 — use `unset` to remove a key"
        );
        let (effects, _) = bind(
            &c,
            &[hit(
                "d_1",
                "/a.md",
                json!({ "__omg_sel_0_value": { "id": "d_2", "path": "/p.md" } }),
            )],
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
        let (effects, _) = bind(&c, &[hit("d_1", "/a.md", json!({ "__omg_sel_0_path": "/notes/a.md", "__omg_sel_0_markdown": "# A", "__omg_sel_0_fm_0": "/a.md" }))]).unwrap();
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
        )
        .unwrap_err();
        assert_eq!(
            e.message,
            "effects[0].frontmatter.source: the expression yielded absent for row d_1"
        );
        // zero hits bind to nothing
        let (effects, rows) = bind(&c, &[]).unwrap();
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
            shift_offsets("unexpected ')' (at offset 20)", 16),
            "unexpected ')' (at offset 4)"
        );
        assert_eq!(shift_offsets("no offset here", 16), "no offset here");
        assert_eq!(shift_offsets("x (at offset 3)", 16), "x (at offset 0)");
        assert_eq!(describe(Some(&json!(2.0))), "a number (2)");
        assert_eq!(describe(Some(&json!([1, 2]))), "a list of 2");
        assert_eq!(describe(Some(&json!("q"))), "a string (\"q\")");
        assert_eq!(describe(None), "absent");
    }
}
