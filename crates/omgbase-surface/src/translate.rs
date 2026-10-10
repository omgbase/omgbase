//! Semantics-faithful OQX expression → SQLite translator: the pushdown seam
//! of the tier-3 planner ([`crate::planner`]). Port of
//! `packages/core/src/oqx-js/sql/translate.ts`.
//!
//! Walks a scalar [`Expr`] and returns a SQL fragment plus its bound
//! parameters, or `None` when the construction cannot be translated
//! faithfully — in which case the planner leaves that conjunct residual
//! (correct, just slower). The cardinal rule is FIDELITY, not cleverness: the
//! SQL a fragment emits must evaluate to the same result as the `oqx`
//! in-memory semantics for every input, because the differential gate runs
//! each query both ways and asserts equality. Two consequences drive the
//! design:
//!
//! * OQX string ops are CASE-SENSITIVE, but SQLite `LIKE` is
//!   case-insensitive for ASCII, so `startsWith` / `contains` / `endsWith`
//!   translate to `substr` / `instr`, never `LIKE`;
//!   `$path.lower().startsWith("lab/")` becomes
//!   `substr(lower(d.path), 1, length(?)) = ?`.
//! * OQX `==` / `!=` are absence-normalized (two absent values are equal,
//!   `absent != v` is true). SQLite `=` / `<>` are not null-safe, so `==` →
//!   `IS` and `!=` → `IS NOT`, which reproduce `equals(a, b)` including the
//!   both-absent and negation cases while honoring SQLite's typed comparison
//!   (`5 IS '5'` is false, matching strict equality).
//!
//! Only forms that are faithful in a POSITIVE, AND-composed context are
//! translated (the only context [`oqx::partition_pushable`] pushes into):
//! `||`, `!`, `in`, `matches` (no regexp UDF) and bare content-property
//! routing are declined and stay residual.
//!
//! The surface 1.1 patch (`spec/surface` §1, §9) added two more declines
//! here, both about SQLite seeing less type than the in-memory engine does:
//!
//! * **Operand typing** ([`Ty`], [`comparable`]): JSON `true` and `1` are
//!   both `1` after `json_extract`, and a property's `val_bool` / `val_num`
//!   coalesce into one column, so two reads, or an integer intrinsic against
//!   a read, cannot be compared faithfully; `null` against a property read
//!   cannot either (a list-valued or nested key has no scalar row, so SQL
//!   reads `NULL` where the in-memory value is an array or an object). See
//!   the matrix at [`comparable`]. The 1.2 patch turned the bool/num literal
//!   (or binding) against a JSON or property read cells into **typed
//!   pushes** ([`typed_compare`]): the stored type is tested in SQL before
//!   the value (`json_type(x) = 'true'`, `json_type(x) IN ('integer',
//!   'real') AND json_extract(x) <op> ?`, `p.type = 'bool' AND p.val_bool =
//!   ?`, `p.type = 'number' AND p.val_num <op> ?`), the whole wrapped `(…)
//!   IS 1` (`IS NOT 1` for `!=`) so an absent or differently typed value
//!   compares as in memory — unequal, never ordered.
//! * **Handles are not properties** ([`non_property_handles`]): a bare
//!   identifier or `doc.<k>` head that names a relation, reach-through
//!   handle, source handle or bag (`nodes`, `doc`, `frontmatter`, `attrs`, …)
//!   resolves to rows or an object in memory, never to a property row or a
//!   JSON attribute, so it is declined rather than read as a key.

use oqx::Value;
use oqx::ast::{BinaryOp, Expr, LogicalOp};
use rusqlite::types::Value as SqlValue;

use crate::context::{Target, to_sql};
use crate::paths::storage_path;

/// The SQL aliases the planner assigned to the current scope's row (`self`)
/// and its owning document (`doc`); on the `docs` target both are the same
/// alias. `params` are the query bindings, for `${…}` interpolations.
#[derive(Clone, Copy, Debug)]
pub struct TranslateCtx<'a> {
    pub target: Target,
    pub self_alias: &'a str,
    pub doc_alias: &'a str,
    pub params: &'a [Value],
}

/// A SQL fragment plus its positional bind params, in statement order.
#[derive(Clone, Debug, PartialEq)]
pub struct Frag {
    pub sql: String,
    pub params: Vec<SqlValue>,
}

impl Frag {
    fn bare(sql: impl Into<String>) -> Self {
        Self {
            sql: sql.into(),
            params: Vec::new(),
        }
    }
}

// ---- operand typing ----------------------------------------------------------------

/// What a translated operand carries in SQL, as far as the translator can
/// tell statically. The comparison gate ([`comparable`]) declines the pairs
/// SQLite would compare with less type than the in-memory engine has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ty {
    /// A string literal or binding, a text column, a text intrinsic,
    /// `lower()` / `upper()` output.
    Text,
    /// An integer intrinsic (`$ordinal`, `$depth`).
    Int,
    /// A number literal or binding.
    Num,
    /// A boolean literal or binding.
    Bool,
    /// A `json_extract` read (an `attrs` path or a bare attribute name):
    /// JSON `true` and `1` both surface as `1`, so a bool or num against it
    /// tests `json_type` first ([`typed_compare`]).
    Json,
    /// A document property scalar (bare key on docs, `doc.<k>`): `val_bool`,
    /// `val_num` and `val_text` coalesce into one column, and a list-valued or
    /// nested key has no scalar row (`NULL`); a bool or num against it tests
    /// `p.type` first ([`typed_compare`]).
    Prop,
    /// `null` (or an absent binding).
    Null,
}

/// The comparison gate (`spec/surface` §1), stated positively: a pair pushes
/// only when it is provably compared the same way in SQLite and in memory.
///
/// **Equality** (`==`, `!=`) pushes iff one operand is `Text` (SQLite's typed
/// comparison and strict equality agree that a string equals nothing but an
/// equal string), or one is `Null` and the other is not `Prop` (a list-valued
/// or nested key has no scalar row, so SQL reads `NULL` where memory has an
/// array or an object), or both are numeric (`Int` / `Num`), or — the 1.2
/// **typed** cells — one is a `Bool` / `Num` constant and the other a `Json` /
/// `Prop` read, pushed with the stored type tested first ([`typed_compare`]):
///
/// ```text
///          Text   Int    Num    Bool   Null   Json   Prop
///   Text   push   push   push   push   push   push   push
///   Int    push   push   push   decl   push   decl   decl
///   Num    push   push   push   decl   push   typed  typed
///   Bool   push   decl   decl   decl   push   typed  typed
///   Null   push   push   push   push   push   push   decl
///   Json   push   decl   typed  typed  push   decl   decl
///   Prop   push   decl   typed  typed  decl   decl   decl
/// ```
///
/// **Relational** (`<`, `<=`, `>`, `>=`) pushes iff both operands are `Text`,
/// both are numeric, or one is a `Num` constant against a `Json` / `Prop` read
/// (typed); every other cell declines (SQLite orders every integer before
/// every text, `NULL` compares to nothing, booleans are not ordered):
///
/// ```text
///          Text   Int    Num    Bool   Null   Json   Prop
///   Text   push   decl   decl   decl   decl   decl   decl
///   Int    decl   push   push   decl   decl   decl   decl
///   Num    decl   push   push   decl   decl   typed  typed
///   Bool   decl   decl   decl   decl   decl   decl   decl
///   Null   decl   decl   decl   decl   decl   decl   decl
///   Json   decl   decl   typed  decl   decl   decl   decl
///   Prop   decl   decl   typed  decl   decl   decl   decl
/// ```
///
/// Why the declines: SQLite sees JSON `true` and `1`, `val_bool` and
/// `val_num` alike (`$ordinal == checked`, `true == 1` binds as `1 IS 1`),
/// orders every integer before every text (`$ordinal < "3"`, `level <
/// "x"`), and two JSON or property reads carry no type at plan time.
#[must_use]
pub fn comparable(op: BinaryOp, a: Ty, b: Ty) -> bool {
    use Ty::{Bool, Int, Json, Null, Num, Prop, Text};
    let numeric = |t: Ty| matches!(t, Int | Num);
    let read = |t: Ty| matches!(t, Json | Prop);
    let both_numeric = numeric(a) && numeric(b);
    // The typed cells: a constant of the given kinds against a stored read.
    let typed = |konst: fn(Ty) -> bool| (read(a) && konst(b)) || (read(b) && konst(a));
    if matches!(op, BinaryOp::Eq | BinaryOp::Ne) {
        a == Text
            || b == Text
            || (a == Null && b != Prop)
            || (b == Null && a != Prop)
            || both_numeric
            || typed(|t| matches!(t, Bool | Num))
    } else {
        (a == Text && b == Text) || both_numeric || typed(|t| t == Num)
    }
}

/// The [`Ty`] of a literal or bound value; `None` for a non-scalar (an array,
/// an object, a range), which has no faithful SQL binding.
fn const_ty(v: &Value) -> Option<Ty> {
    Some(match v {
        Value::Str(_) => Ty::Text,
        Value::Number(_) => Ty::Num,
        Value::Bool(_) => Ty::Bool,
        Value::Null | Value::Undefined => Ty::Null,
        Value::Array(_) | Value::Object(_) | Value::Range(_) => return None,
    })
}

// ---- handles -----------------------------------------------------------------------

/// The bare names that resolve to something other than a property or
/// attribute on each target — the self alias, the reach-through handles, the
/// relations and the bags (`spec/surface` §1.2) — exactly the keys
/// [`crate::StoreContext`]'s `get` answers before its property fallback. A
/// comparison against one of these is declined rather than read as a key
/// (`nodes == null` is not `NULL IS NULL`). A unit test proves the sets
/// match the context.
#[must_use]
pub fn non_property_handles(t: Target) -> &'static [&'static str] {
    match t {
        Target::Docs => &[
            "doc",
            "blocks",
            "nodes",
            "out",
            "in",
            "out_edges",
            "in_edges",
            "frontmatter",
            "inline",
        ],
        Target::Blocks => &[
            "block",
            "doc",
            "children",
            "nodes",
            "out_edges",
            "section",
            "attrs",
        ],
        Target::Nodes => &[
            "section",
            "doc",
            "block",
            "blocks",
            "subsections",
            "children",
            "attrs",
        ],
        Target::Edges => &["doc"],
    }
}

// ---- intrinsics ------------------------------------------------------------------

/// A `$`-namespaced intrinsic → a param-free SQL scalar and its type, per
/// target. Anything not mapped (docs `$body`, reconstructed; `$title` /
/// `$tags`, computed; blocks `$updated_at`; nodes `$locator`) returns `None`
/// → residual. `$updated_at` / `$dst_path` / `$dst_uri` are correlated
/// subqueries. Only `$ordinal` / `$depth` are integers; every other mapped
/// intrinsic is text. `$path` is rendered by [`Operand::path_col`] (the
/// rooted read, `spec/surface` §1 "Paths"); `$dst_path` roots its subquery.
fn intrinsic_sql(name: &str, ctx: &TranslateCtx<'_>) -> Option<(String, Ty)> {
    let (s, d) = (ctx.self_alias, ctx.doc_alias);
    let sql = match (ctx.target, name) {
        (Target::Docs, "$id") => format!("{s}.doc_id"),
        (Target::Docs, "$path") => format!("('/' || {d}.path)"),
        (Target::Docs, "$content_hash") => format!("lower(hex({s}.file_hash))"),
        (Target::Docs, "$updated_at") => format!(
            "(SELECT c.ts FROM revisions r JOIN commits c ON c.commit_id = r.commit_id WHERE r.rev_id = {s}.current_rev)"
        ),
        (Target::Blocks, "$id") => format!("{s}.block_id"),
        (Target::Blocks, "$doc") => format!("{s}.doc_id"),
        (Target::Blocks, "$path") => format!("('/' || {d}.path)"),
        (Target::Blocks, "$ordinal") => return Some((format!("{s}.ordinal"), Ty::Int)),
        (Target::Blocks, "$depth") => return Some((format!("{s}.depth"), Ty::Int)),
        (Target::Blocks, "$body") => format!("{s}.text"),
        (Target::Blocks, "$content_hash") => format!("lower(hex({s}.raw_hash))"),
        (Target::Nodes, "$id" | "$node_id") => format!("{s}.node_id"),
        (Target::Nodes, "$doc_id") => format!("{s}.doc_id"),
        (Target::Nodes, "$block_id") => format!("{s}.block_id"),
        (Target::Nodes, "$path") => format!("('/' || {d}.path)"),
        (Target::Edges, "$id") => format!("{s}.edge_id"),
        (Target::Edges, "$src") => format!("{s}.src_doc"),
        (Target::Edges, "$dst") => format!("{s}.dst_node"),
        (Target::Edges, "$src_block") => format!("{s}.src_block"),
        (Target::Edges, "$via") => format!("{s}.via_node"),
        (Target::Edges, "$from_commit") => format!("{s}.from_commit"),
        (Target::Edges, "$path") => format!("('/' || {d}.path)"),
        (Target::Edges, "$dst_path") => {
            format!("(SELECT '/' || dd.path FROM docs dd WHERE dd.doc_id = {s}.dst_node)")
        }
        (Target::Edges, "$dst_uri") => {
            format!("(SELECT xn.uri FROM external_nodes xn WHERE xn.node_id = {s}.dst_node)")
        }
        _ => return None,
    };
    Some((sql, Ty::Text))
}

/// docs intrinsics whose BARE (non-`$`) form is a loud error in-memory — not
/// pushable, so the residual raises the guard (and the planner declines the
/// whole query when such a read is left residual, see [`crate::planner`]).
pub(crate) const RESERVED_DOC_BASENAMES: [&str; 5] =
    ["id", "path", "updated_at", "content_hash", "body"];

/// An injection-safe inlined identifier: `^[A-Za-z_][A-Za-z0-9_]*$`.
fn is_seg(s: &str) -> bool {
    let mut chars = s.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The single-scalar-row property subquery (the scalar-in-scope rule):
/// `select` evaluated over the property row `p` only when the key has exactly
/// one row in scope and it is `card = 'scalar'`, else NULL — matching the
/// context's `doc_prop` for a scalar read. [`prop_scalar`] selects the value;
/// the typed pushes select a type test ([`typed_compare`]).
fn prop_row(doc_alias: &str, key: &str, select: &str) -> Option<String> {
    if !is_seg(key) {
        return None;
    }
    Some(format!(
        "(SELECT {select} FROM properties p \
         WHERE p.doc_id = {doc_alias}.doc_id AND p.key = '{key}' AND p.card = 'scalar' AND p.deleted_commit IS NULL \
         AND (SELECT COUNT(*) FROM properties p2 WHERE p2.doc_id = {doc_alias}.doc_id AND p2.key = '{key}' AND p2.deleted_commit IS NULL) = 1 \
         LIMIT 1)"
    ))
}

/// A single-valued document property's scalar value (`val_text`, `val_num`
/// and `val_bool` coalesced), or NULL.
fn prop_scalar(doc_alias: &str, key: &str) -> Option<String> {
    prop_row(
        doc_alias,
        key,
        "COALESCE(p.val_text, p.val_num, p.val_bool)",
    )
}

/// The JSON path `$.a.b` from validated segments; `None` if any segment is
/// unsafe.
fn json_path(segs: &[&str]) -> Option<String> {
    if segs.iter().any(|s| !is_seg(s)) {
        return None;
    }
    Some(format!("$.{}", segs.join(".")))
}

/// What an operand IS, beyond the SQL it renders to — the typed pushes
/// ([`typed_compare`]) rebuild a stored read as a type test and inline a
/// constant's value, which a finished [`Frag`] no longer exposes.
#[derive(Clone, Debug, PartialEq)]
enum Shape {
    /// A plain SQL scalar: a column, an intrinsic, `lower()` / `upper()`.
    Plain,
    /// The rooted path read over a storage path column (`'/' || d.path`,
    /// `spec/surface` §1 "Paths"): the bare, indexed column is kept for the
    /// equality fast path ([`path_equality`]).
    PathCol(String),
    /// A literal or binding, bound as `?`.
    Const(Value),
    /// `json_extract(col, 'path')`.
    Json { col: String, path: String },
    /// A document property read: the owning document's alias and the key.
    Prop { doc_alias: String, key: String },
}

/// A translated value-position operand: its fragment, its [`Ty`] for the
/// gate, and its [`Shape`] for the typed pushes.
#[derive(Clone, Debug, PartialEq)]
struct Operand {
    frag: Frag,
    ty: Ty,
    shape: Shape,
}

impl Operand {
    fn plain(sql: String, ty: Ty) -> Self {
        Self {
            frag: Frag::bare(sql),
            ty,
            shape: Shape::Plain,
        }
    }

    fn text(sql: String) -> Option<Self> {
        Some(Self::plain(sql, Ty::Text))
    }

    /// `$path` / `doc.$path`: the reference form over the storage column, so
    /// every comparison, `startsWith`, `contains`, `lower()`… sees exactly the
    /// string the in-memory intrinsic yields.
    fn path_col(col: String) -> Option<Self> {
        Some(Self {
            frag: Frag::bare(format!("('/' || {col})")),
            ty: Ty::Text,
            shape: Shape::PathCol(col),
        })
    }

    /// `None` for a non-scalar (an array, an object, a range), which has no
    /// faithful SQL binding.
    fn constant(v: &Value) -> Option<Self> {
        Some(Self {
            frag: Frag {
                sql: "?".to_owned(),
                params: vec![to_sql(v)],
            },
            ty: const_ty(v)?,
            shape: Shape::Const(v.clone()),
        })
    }

    fn json(col: String, segs: &[&str]) -> Option<Self> {
        let path = json_path(segs)?;
        Some(Self {
            frag: Frag::bare(format!("json_extract({col}, '{path}')")),
            ty: Ty::Json,
            shape: Shape::Json { col, path },
        })
    }

    fn prop(doc_alias: &str, key: &str) -> Option<Self> {
        Some(Self {
            frag: Frag::bare(prop_scalar(doc_alias, key)?),
            ty: Ty::Prop,
            shape: Shape::Prop {
                doc_alias: doc_alias.to_owned(),
                key: key.to_owned(),
            },
        })
    }
}

/// The dotted `attrs.a.b` / `doc.x` receiver chain as segments, or `None` if
/// it is not a plain identifier navigation.
fn member_segments(e: &Expr) -> Option<Vec<&str>> {
    match e {
        Expr::Ident { name, .. } => Some(vec![name.as_str()]),
        Expr::Member { recv, name, .. } => {
            let mut base = member_segments(recv)?;
            base.push(name.as_str());
            Some(base)
        }
        _ => None,
    }
}

// ---- value position ----------------------------------------------------------------

/// Translate an expression used as a VALUE (comparison operand, method
/// receiver, function argument) to a SQL scalar. `None` if not faithfully
/// translatable.
pub fn translate_value(e: &Expr, ctx: &TranslateCtx<'_>) -> Option<Frag> {
    typed_value(e, ctx).map(|(frag, _)| frag)
}

/// [`translate_value`] plus the operand's [`Ty`], for the comparison gate.
pub fn typed_value(e: &Expr, ctx: &TranslateCtx<'_>) -> Option<(Frag, Ty)> {
    operand(e, ctx).map(|o| (o.frag, o.ty))
}

/// The full [`Operand`] of a value-position expression.
fn operand(e: &Expr, ctx: &TranslateCtx<'_>) -> Option<Operand> {
    let (s, d, target) = (ctx.self_alias, ctx.doc_alias, ctx.target);
    match e {
        Expr::Lit { value: v, .. } => Operand::constant(v),
        Expr::Binding { index, .. } => {
            Operand::constant(ctx.params.get(*index).unwrap_or(&Value::Undefined))
        }
        Expr::Ident { name, .. } => {
            if name == "$path" {
                return Operand::path_col(format!("{d}.path"));
            }
            if name.starts_with('$') {
                return intrinsic_sql(name, ctx).map(|(sql, ty)| Operand::plain(sql, ty));
            }
            let name = name.as_str();
            // A relation, reach-through handle, source handle or bag is not a
            // property read (§1): rows or an object in memory, never a key.
            if non_property_handles(target).contains(&name) {
                return None;
            }
            match target {
                Target::Docs => {
                    // `format` is a column, not a property.
                    if name == "format" {
                        return Operand::text(format!("{s}.format"));
                    }
                    // A reserved basename stays residual so the guard fires.
                    if RESERVED_DOC_BASENAMES.contains(&name) {
                        return None;
                    }
                    Operand::prop(d, name)
                }
                Target::Blocks => {
                    if name == "type" || name == "text" {
                        return Operand::text(format!("{s}.{name}"));
                    }
                    // A bare non-structural identifier flattens into attrs —
                    // the same pushdown as the `attrs.<k>` member form.
                    Operand::json(format!("{s}.attrs"), &[name])
                }
                Target::Nodes => {
                    if matches!(name, "kind" | "name" | "value") {
                        return Operand::text(format!("{s}.{name}"));
                    }
                    Operand::json(format!("{s}.attrs"), &[name])
                }
                Target::Edges => {
                    if matches!(
                        name,
                        "predicate" | "provenance" | "dst_kind" | "anchor" | "src_field"
                    ) {
                        return Operand::text(format!("{s}.{name}"));
                    }
                    None
                }
            }
        }
        Expr::Member { .. } => {
            let segs = member_segments(e)?;
            let (head, rest) = segs.split_first()?;
            if rest.is_empty() {
                return None;
            }
            // attrs.<path> → json_extract on the row's attrs (blocks/nodes).
            if *head == "attrs" && matches!(target, Target::Blocks | Target::Nodes) {
                return Operand::json(format!("{s}.attrs"), rest);
            }
            // doc.<x> reach-through — the owning doc (alias `doc`). On the docs
            // target `doc` is the row itself; either way it resolves against `d`.
            if *head == "doc" {
                if rest.len() != 1 {
                    return None;
                }
                let k = rest[0];
                if k == "$path" {
                    return Operand::path_col(format!("{d}.path"));
                }
                if k == "format" {
                    return Operand::text(format!("{d}.format"));
                }
                // `doc.nodes`, `doc.frontmatter`, `doc.doc`… are the doc's
                // handles, not its properties.
                if k.starts_with('$')
                    || RESERVED_DOC_BASENAMES.contains(&k)
                    || non_property_handles(Target::Docs).contains(&k)
                {
                    return None;
                }
                return Operand::prop(d, k);
            }
            // block.type / block.text reach-through from a node.
            if *head == "block"
                && target == Target::Nodes
                && rest.len() == 1
                && matches!(rest[0], "type" | "text")
            {
                return Operand::text(format!(
                    "(SELECT bb.{} FROM blocks bb WHERE bb.block_id = {s}.block_id)",
                    rest[0]
                ));
            }
            None
        }
        // `.lower()` / `.upper()` are the value-position string methods.
        Expr::Call {
            recv: Some(recv),
            name,
            args,
            ..
        } if args.is_empty() && (name == "lower" || name == "upper") => {
            let recv = translate_value(recv, ctx)?;
            Some(Operand {
                frag: Frag {
                    sql: format!("{name}({})", recv.sql),
                    params: recv.params,
                },
                ty: Ty::Text,
                shape: Shape::Plain,
            })
        }
        _ => None,
    }
}

// ---- predicate position --------------------------------------------------------------

/// `==` / `!=` → null-safe `IS` / `IS NOT`; the relational ops as plain SQL.
fn is_op(op: BinaryOp) -> Option<&'static str> {
    Some(match op {
        BinaryOp::Eq => "IS",
        BinaryOp::Ne => "IS NOT",
        BinaryOp::Lt => "<",
        BinaryOp::Le => "<=",
        BinaryOp::Gt => ">",
        BinaryOp::Ge => ">=",
        // Identity (`is` / `is not`, SEMANTICS §5b) compares the engine's
        // structural identities — not provably SQL's `IS` over typed cells —
        // so it stays residual, like arithmetic in predicate position.
        BinaryOp::Is
        | BinaryOp::IsNot
        | BinaryOp::Add
        | BinaryOp::Sub
        | BinaryOp::Mul
        | BinaryOp::Div
        | BinaryOp::Mod => {
            return None;
        }
    })
}

/// The typed pushes (`spec/surface` §1, 1.2 patch): a bool or num constant
/// against a JSON or property read, with the stored type tested in SQL
/// before the value so SQLite cannot conflate JSON `true` with `1` or
/// `val_bool` with `val_num`. `None` when the pair is not a typed cell (the
/// plain `IS` / relational form applies) — the gate ([`comparable`]) has
/// already declined the cells neither form can push.
///
/// * json × bool (`==`/`!=`): `(json_type(x) = 'true' | 'false') IS 1`;
/// * json × num (all six): `(json_type(x) IN ('integer', 'real') AND
///   json_extract(x) <op> ?) IS 1`;
/// * prop × bool (`==`/`!=`): the single-scalar-row subquery selecting
///   `p.type = 'bool' AND p.val_bool = ?` (`spec/properties` §2.1 type
///   names; booleans bind as 1/0), `(…) IS 1`;
/// * prop × num (all six): the same subquery selecting `p.type = 'number'
///   AND p.val_num <op> ?`, `(…) IS 1`.
///
/// `!=` wraps `IS NOT 1` around the equality test. `json_type` is NULL for
/// an absent path and the subquery is NULL for an absent, list-valued or
/// nested key, so `IS 1` is false and `IS NOT 1` true — the in-memory
/// absence semantics (unequal, never ordered). The test is normalized to
/// `read <op> ?`, a relational op flipping when the constant is on the left
/// (`800 < era` ⇔ `era > 800`), as the reference does.
fn typed_compare(op: BinaryOp, sql_op: &str, l: &Operand, r: &Operand) -> Option<Frag> {
    let (read, konst, read_left) = match (&l.shape, &r.shape) {
        (Shape::Json { .. } | Shape::Prop { .. }, Shape::Const(v)) => (&l.shape, v, true),
        (Shape::Const(v), Shape::Json { .. } | Shape::Prop { .. }) => (&r.shape, v, false),
        _ => return None,
    };
    let equality = matches!(op, BinaryOp::Eq | BinaryOp::Ne);
    let wrap = if op == BinaryOp::Ne {
        "IS NOT 1"
    } else {
        "IS 1"
    };
    // Normalized to `read <op> ?`: a relational op flips when the constant is
    // on the left (`800 < era` ⇔ `era > 800`), as in the reference.
    let inner_op = match (equality, read_left, sql_op) {
        (true, _, _) => "=",
        (false, true, _) => sql_op,
        (false, false, "<") => ">",
        (false, false, "<=") => ">=",
        (false, false, ">") => "<",
        (false, false, ">=") => "<=",
        (false, false, _) => return None,
    };
    let sides = |read_sql: &str| format!("{read_sql} {inner_op} ?");
    let (sql, params) = match (read, konst) {
        // Booleans are only ever equal; the gate declines them relational.
        (_, Value::Bool(_)) if !equality => return None,
        (Shape::Json { col, path }, Value::Bool(b)) => (
            format!("(json_type({col}, '{path}') = '{b}') {wrap}"),
            Vec::new(),
        ),
        (Shape::Json { col, path }, Value::Number(_)) => (
            format!(
                "(json_type({col}, '{path}') IN ('integer', 'real') AND {}) {wrap}",
                sides(&format!("json_extract({col}, '{path}')"))
            ),
            vec![to_sql(konst)],
        ),
        (Shape::Prop { doc_alias, key }, Value::Bool(_)) => (
            format!(
                "{} {wrap}",
                prop_row(
                    doc_alias,
                    key,
                    &format!("p.type = 'bool' AND {}", sides("p.val_bool"))
                )?
            ),
            vec![to_sql(konst)],
        ),
        (Shape::Prop { doc_alias, key }, Value::Number(_)) => (
            format!(
                "{} {wrap}",
                prop_row(
                    doc_alias,
                    key,
                    &format!("p.type = 'number' AND {}", sides("p.val_num"))
                )?
            ),
            vec![to_sql(konst)],
        ),
        _ => return None,
    };
    Some(Frag {
        sql: format!("({sql})"),
        params,
    })
}

/// The path equality fast path (`spec/surface` §1 "Paths"): `$path == "/a.md"`
/// (or `!=`, either side) against a ROOTED text constant is `d.path IS ?` with
/// the constant's storage form, so the `(repo_id, path)` index serves it;
/// `'/' || d.path IS ?` — what the general form emits — is the same predicate
/// without the index. Only a rooted constant qualifies (the runner roots every
/// literal compared with a path read, so that is every literal); a bare
/// binding stays on the general form, where `'/' || d.path` can never equal
/// it — exactly the in-memory answer.
fn path_equality(op: BinaryOp, l: &Operand, r: &Operand) -> Option<Frag> {
    if !matches!(op, BinaryOp::Eq | BinaryOp::Ne) {
        return None;
    }
    let (col, konst) = match (&l.shape, &r.shape) {
        (Shape::PathCol(c), Shape::Const(Value::Str(s))) if s.starts_with('/') => (c, s),
        (Shape::Const(Value::Str(s)), Shape::PathCol(c)) if s.starts_with('/') => (c, s),
        _ => return None,
    };
    Some(Frag {
        sql: format!("({col} {} ?)", is_op(op)?),
        params: vec![SqlValue::Text(storage_path(konst).to_owned())],
    })
}

/// Translate an expression used as a boolean PREDICATE to a SQL boolean, or
/// `None` if it cannot be pushed faithfully. Only positive, AND-safe forms
/// are handled: `unary` (`!`), `in`, bare truthy idents and member
/// reach-through in predicate position stay residual.
pub fn translate_predicate(e: &Expr, ctx: &TranslateCtx<'_>) -> Option<Frag> {
    match e {
        // Only `&&` composes faithfully in a positive context; `||` is
        // declined (its NULL / short-circuit interaction stays residual).
        Expr::Logical {
            op: LogicalOp::And,
            left,
            right,
            ..
        } => join2(
            translate_predicate(left, ctx),
            translate_predicate(right, ctx),
            "AND",
        ),
        Expr::Binary {
            op, left, right, ..
        } => {
            // An arithmetic operator in predicate position → residual.
            let sql_op = is_op(*op)?;
            let l = operand(left, ctx)?;
            let r = operand(right, ctx)?;
            if let Some(fast) = path_equality(*op, &l, &r) {
                return Some(fast);
            }
            // The operand-typing gate (§1): the pairs SQLite would compare
            // with less type than the engine has stay residual.
            if !comparable(*op, l.ty, r.ty) {
                return None;
            }
            // A bool/num constant against a JSON or property read pushes with
            // the stored type tested first (the 1.2 typed cells).
            if let Some(typed) = typed_compare(*op, sql_op, &l, &r) {
                return Some(typed);
            }
            let op = sql_op;
            // `==`/`!=` → IS / IS NOT (absence-normalized equality, faithful in
            // any context). Relational ops → plain SQL: a NULL operand yields
            // NULL, which is excluded in the positive AND context these
            // fragments are pushed into, matching the absent-operand ⇒ false rule.
            let mut params = l.frag.params;
            params.extend(r.frag.params);
            Some(Frag {
                sql: format!("({} {op} {})", l.frag.sql, r.frag.sql),
                params,
            })
        }
        Expr::Call {
            recv: Some(recv),
            name,
            args,
            ..
        } if args.len() == 1 => {
            // startsWith / contains / endsWith — CASE-SENSITIVE, via
            // substr/instr (never LIKE). `matches` (regex) is declined.
            let recv = translate_value(recv, ctx)?;
            let arg = translate_value(&args[0], ctx)?;
            let mut params = recv.params;
            let sql = match name.as_str() {
                "startsWith" => {
                    // recv begins with arg ⇔ its first length(arg) chars equal arg.
                    params.extend(arg.params.iter().cloned());
                    params.extend(arg.params);
                    format!("(substr({}, 1, length({a})) = {a})", recv.sql, a = arg.sql)
                }
                "endsWith" => {
                    // recv ends with arg ⇔ its last length(arg) chars equal arg.
                    // When arg is longer than recv, substr clamps to the whole
                    // (shorter) string, so the equality is false.
                    params.extend(arg.params.iter().cloned());
                    params.extend(arg.params);
                    format!("(substr({}, -length({a})) = {a})", recv.sql, a = arg.sql)
                }
                "contains" => {
                    params.extend(arg.params);
                    format!("(instr({}, {}) > 0)", recv.sql, arg.sql)
                }
                _ => return None,
            };
            Some(Frag { sql, params })
        }
        _ => None,
    }
}

/// Combine two optional fragments with a boolean connective; `None` if either
/// is untranslatable (the whole conjunct then stays residual).
fn join2(a: Option<Frag>, b: Option<Frag>, connective: &str) -> Option<Frag> {
    let (a, b) = (a?, b?);
    let mut params = a.params;
    params.extend(b.params);
    Some(Frag {
        sql: format!("({} {connective} {})", a.sql, b.sql),
        params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use oqx::ast::Where;

    const DOCS: TranslateCtx<'static> = TranslateCtx {
        target: Target::Docs,
        self_alias: "d",
        doc_alias: "d",
        params: &[],
    };

    fn text(s: &str) -> SqlValue {
        SqlValue::Text(s.to_owned())
    }

    fn frag(sql: &str, params: &[SqlValue]) -> Option<Frag> {
        Some(Frag {
            sql: sql.to_owned(),
            params: params.to_vec(),
        })
    }

    /// Parse `from docs where <src>` and return the single scalar predicate.
    fn pred(src: &str) -> Expr {
        let q = oqx::parse_string(&format!("from docs where {src}")).expect("parses");
        match q.r#where {
            Some(Where::Scalar { expr, .. }) => expr,
            other => panic!("expected a single scalar predicate, got {other:?}"),
        }
    }

    fn ident(name: &str) -> Box<Expr> {
        Box::new(Expr::Ident {
            name: name.to_owned(),
            span: oqx::Span::EMPTY,
        })
    }

    fn lit(s: &str) -> Box<Expr> {
        Box::new(Expr::Lit {
            value: Value::from(s),
            span: oqx::Span::EMPTY,
        })
    }

    fn eq(l: Box<Expr>, r: Box<Expr>) -> Box<Expr> {
        Box::new(Expr::Binary {
            op: BinaryOp::Eq,
            left: l,
            right: r,
            span: oqx::Span::EMPTY,
        })
    }

    // -- equality is absence-normalized (IS / IS NOT) --

    #[test]
    fn equality_is_null_safe_is() {
        assert_eq!(
            translate_predicate(&pred("$path == \"index.md\""), &DOCS),
            frag("(('/' || d.path) IS ?)", &[text("index.md")])
        );
    }

    // `spec/surface` §1 "Paths" (2.0): `$path` is the reference form,
    // `'/' || d.path` in SQL; a ROOTED text constant under `==`/`!=` takes the
    // indexed fast path on the bare column with its storage form bound, a bare
    // one (never equal to a rooted path) stays on the general form.
    #[test]
    fn a_rooted_path_literal_is_the_indexed_fast_path() {
        assert_eq!(
            translate_predicate(&pred("$path == \"/index.md\""), &DOCS),
            frag("(d.path IS ?)", &[text("index.md")])
        );
        assert_eq!(
            translate_predicate(&pred("\"/x.md\" != $path"), &DOCS),
            frag("(d.path IS NOT ?)", &[text("x.md")])
        );
        assert_eq!(
            translate_predicate(&pred("$path < \"/m\""), &DOCS),
            frag("(('/' || d.path) < ?)", &[text("/m")])
        );
        assert_eq!(
            translate_predicate(&pred("$path == \"index.md\""), &DOCS),
            frag("(('/' || d.path) IS ?)", &[text("index.md")])
        );
    }

    #[test]
    fn inequality_is_null_safe_is_not() {
        assert_eq!(
            translate_predicate(&pred("$path != \"x\""), &DOCS),
            frag("(('/' || d.path) IS NOT ?)", &[text("x")])
        );
    }

    #[test]
    fn intrinsic_column_mapping() {
        assert_eq!(
            translate_predicate(&pred("$id == \"d_1\""), &DOCS),
            frag("(d.doc_id IS ?)", &[text("d_1")])
        );
    }

    // -- relational ops (plain SQL) --

    #[test]
    fn relational_ops_are_plain_comparisons() {
        assert_eq!(
            translate_predicate(&pred("$path < \"m\""), &DOCS),
            frag("(('/' || d.path) < ?)", &[text("m")])
        );
        assert_eq!(
            translate_predicate(&pred("$path >= \"m\""), &DOCS),
            frag("(('/' || d.path) >= ?)", &[text("m")])
        );
        // arithmetic in predicate position → residual
        assert_eq!(translate_predicate(&pred("$path + 1"), &DOCS), None);
    }

    // -- string ops are case-sensitive (substr/instr, never LIKE) --

    #[test]
    fn starts_with_is_substr_equality() {
        assert_eq!(
            translate_predicate(&pred("$path.startsWith(\"lab/\")"), &DOCS),
            frag(
                "(substr(('/' || d.path), 1, length(?)) = ?)",
                &[text("lab/"), text("lab/")]
            )
        );
    }

    #[test]
    fn lower_then_starts_with_pushes_with_explicit_lower() {
        assert_eq!(
            translate_predicate(&pred("$path.lower().startsWith(\"lab/\")"), &DOCS),
            frag(
                "(substr(lower(('/' || d.path)), 1, length(?)) = ?)",
                &[text("lab/"), text("lab/")]
            )
        );
    }

    #[test]
    fn contains_is_instr() {
        assert_eq!(
            translate_predicate(&pred("$path.contains(\"notes\")"), &DOCS),
            frag("(instr(('/' || d.path), ?) > 0)", &[text("notes")])
        );
    }

    #[test]
    fn ends_with_is_negative_substr_equality() {
        assert_eq!(
            translate_predicate(&pred("$path.endsWith(\".md\")"), &DOCS),
            frag(
                "(substr(('/' || d.path), -length(?)) = ?)",
                &[text(".md"), text(".md")]
            )
        );
    }

    #[test]
    fn upper_wraps_the_receiver_in_value_position() {
        assert_eq!(
            translate_value(&pred("$path.upper()"), &DOCS),
            frag("upper(('/' || d.path))", &[])
        );
    }

    // -- bare document properties push via the properties table --

    #[test]
    fn bare_doc_property_is_the_scalar_in_scope_subquery() {
        let f = translate_predicate(&pred("layer == \"canon\""), &DOCS).expect("pushable");
        assert!(f.sql.contains("FROM properties p"), "{}", f.sql);
        assert!(f.sql.contains("p.key = 'layer'"), "{}", f.sql);
        assert!(f.sql.contains("p.card = 'scalar'"), "{}", f.sql);
        assert!(
            f.sql.starts_with('(') && f.sql.contains(" IS ?)"),
            "{}",
            f.sql
        );
        assert_eq!(f.params, vec![text("canon")]);
    }

    #[test]
    fn updated_at_pushes_as_its_revisions_subquery() {
        let f =
            translate_predicate(&pred("$updated_at >= \"2026-01-01\""), &DOCS).expect("pushable");
        assert!(
            f.sql.contains("FROM revisions r JOIN commits c"),
            "{}",
            f.sql
        );
    }

    #[test]
    fn format_is_a_column_not_a_property() {
        assert_eq!(
            translate_predicate(&pred("format == \"markdown\""), &DOCS),
            frag("(d.format IS ?)", &[text("markdown")])
        );
    }

    #[test]
    fn booleans_bind_as_one_and_zero() {
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        // (against a text column — against a JSON or property read the
        // boolean pushes typed, see the typed-shape tests)
        assert_eq!(
            translate_predicate(&pred("type == true"), &blocks).map(|f| f.params),
            Some(vec![SqlValue::Integer(1)])
        );
        assert_eq!(
            translate_predicate(&pred("type == false"), &blocks).map(|f| f.params),
            Some(vec![SqlValue::Integer(0)])
        );
        assert_eq!(
            translate_predicate(&pred("$ordinal < 1000"), &blocks).map(|f| f.params),
            Some(vec![SqlValue::Real(1000.0)])
        );
        assert_eq!(
            translate_predicate(&pred("$path == null"), &DOCS).map(|f| f.params),
            Some(vec![SqlValue::Null])
        );
    }

    // -- decline (a): operand typing (spec/surface §1) --

    /// One representative expression per [`Ty`] on the blocks target (the only
    /// target with an integer intrinsic; `doc.<k>` is its property read).
    const REPRESENTATIVES: [(Ty, &str); 7] = [
        (Ty::Text, "$path"),
        (Ty::Int, "$ordinal"),
        (Ty::Num, "1"),
        (Ty::Bool, "true"),
        (Ty::Null, "null"),
        (Ty::Json, "checked"),
        (Ty::Prop, "doc.layer"),
    ];

    #[test]
    fn representatives_carry_their_type() {
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        for (ty, src) in REPRESENTATIVES {
            let (_, got) = typed_value(&pred(src), &blocks).expect(src);
            assert_eq!(got, ty, "{src}");
        }
        assert_eq!(
            typed_value(&pred("attrs.a.b"), &blocks).map(|(_, t)| t),
            Some(Ty::Json)
        );
        assert_eq!(
            typed_value(&pred("$depth"), &blocks).map(|(_, t)| t),
            Some(Ty::Int)
        );
        assert_eq!(
            typed_value(&pred("type.lower()"), &blocks).map(|(_, t)| t),
            Some(Ty::Text)
        );
        assert_eq!(
            typed_value(&pred("checked.upper()"), &blocks).map(|(_, t)| t),
            Some(Ty::Text)
        );
        assert_eq!(
            typed_value(&pred("layer"), &DOCS).map(|(_, t)| t),
            Some(Ty::Prop)
        );
        assert_eq!(
            typed_value(&pred("format"), &DOCS).map(|(_, t)| t),
            Some(Ty::Text)
        );
    }

    #[test]
    fn the_comparison_matrix_decides_every_cell() {
        // Row/column order: Text Int Num Bool Null Json Prop.
        const P: bool = true;
        const D: bool = false;
        // Typed (1.2): a bool/num constant against a JSON or property read.
        const T: bool = true;
        // Equality: one side text, or null against a non-property, or both
        // numeric, or a typed cell.
        #[rustfmt::skip]
        const EQUALITY: [[bool; 7]; 7] = [
            /* Text */ [P, P, P, P, P, P, P],
            /* Int  */ [P, P, P, D, P, D, D],
            /* Num  */ [P, P, P, D, P, T, T],
            /* Bool */ [P, D, D, D, P, T, T],
            /* Null */ [P, P, P, P, P, P, D],
            /* Json */ [P, D, T, T, P, D, D],
            /* Prop */ [P, D, T, T, D, D, D],
        ];
        // Relational: both text, both numeric, or a num constant against a
        // read (typed); nothing else.
        #[rustfmt::skip]
        const RELATIONAL: [[bool; 7]; 7] = [
            /* Text */ [P, D, D, D, D, D, D],
            /* Int  */ [D, P, P, D, D, D, D],
            /* Num  */ [D, P, P, D, D, T, T],
            /* Bool */ [D, D, D, D, D, D, D],
            /* Null */ [D, D, D, D, D, D, D],
            /* Json */ [D, D, T, D, D, D, D],
            /* Prop */ [D, D, T, D, D, D, D],
        ];
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        let ops = [
            (BinaryOp::Eq, "==", &EQUALITY),
            (BinaryOp::Ne, "!=", &EQUALITY),
            (BinaryOp::Lt, "<", &RELATIONAL),
            (BinaryOp::Le, "<=", &RELATIONAL),
            (BinaryOp::Gt, ">", &RELATIONAL),
            (BinaryOp::Ge, ">=", &RELATIONAL),
        ];
        for (i, (a, l)) in REPRESENTATIVES.iter().enumerate() {
            for (j, (b, r)) in REPRESENTATIVES.iter().enumerate() {
                for (op, spelled, matrix) in ops {
                    let want = matrix[i][j];
                    assert_eq!(matrix[j][i], want, "the matrix is symmetric ({a:?}, {b:?})");
                    assert_eq!(
                        comparable(op, *a, *b),
                        want,
                        "comparable({spelled}, {a:?}, {b:?})"
                    );
                    let src = format!("{l} {spelled} {r}");
                    assert_eq!(
                        translate_predicate(&pred(&src), &blocks).is_some(),
                        want,
                        "{src}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_spec_shapes_of_decline_a() {
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        // a boolean or number against a JSON read pushes TYPED (1.2): the
        // json_type is tested first, so the SQL cannot read JSON `true` as 1
        let typed = |src: &str, ctx: &TranslateCtx<'_>| {
            let f = translate_predicate(&pred(src), ctx).expect(src);
            assert!(
                f.sql.contains("json_type(") || f.sql.contains("p.type = "),
                "{src}: {}",
                f.sql
            );
            assert!(
                f.sql.ends_with(" IS 1)") || f.sql.ends_with(" IS NOT 1)"),
                "{src}: {}",
                f.sql
            );
        };
        typed("checked == 1", &blocks);
        typed("checked == true", &blocks);
        typed("attrs.checked == true", &blocks);
        // … or a property read (bare on docs, `doc.<k>` elsewhere)
        typed("verified == 1", &DOCS);
        typed("verified == true", &DOCS);
        typed("era < 1000", &DOCS);
        typed("doc.era < 1000", &blocks);
        // a boolean against an integer intrinsic; a number stays pushable
        assert_eq!(
            translate_predicate(&pred("$ordinal == true"), &blocks),
            None
        );
        assert_eq!(
            translate_predicate(&pred("$ordinal == 1"), &blocks),
            frag("(b.ordinal IS ?)", &[SqlValue::Real(1.0)])
        );
        // null against a property read; against a JSON read or a column it pushes
        assert_eq!(translate_predicate(&pred("tags != null"), &DOCS), None);
        assert_eq!(translate_predicate(&pred("tags == null"), &DOCS), None);
        assert_eq!(
            translate_predicate(&pred("doc.tags == null"), &blocks),
            None
        );
        assert_eq!(
            translate_predicate(&pred("checked == null"), &blocks),
            frag(
                "(json_extract(b.attrs, '$.checked') IS ?)",
                &[SqlValue::Null]
            )
        );
        assert_eq!(
            translate_predicate(&pred("$ordinal != null"), &blocks),
            frag("(b.ordinal IS NOT ?)", &[SqlValue::Null])
        );
        // a string literal against anything pushes under equality
        assert_eq!(
            translate_predicate(&pred("checked == \"x\""), &blocks),
            frag("(json_extract(b.attrs, '$.checked') IS ?)", &[text("x")])
        );
        assert!(translate_predicate(&pred("layer == \"canon\""), &DOCS).is_some());
        assert!(translate_predicate(&pred("$ordinal == \"1\""), &blocks).is_some());
        assert!(translate_predicate(&pred("$ordinal != \"1\""), &blocks).is_some());
        // … but a relational comparison across text and a number / integer
        // declines (the fifth shape): SQLite orders integers before text
        assert_eq!(
            translate_predicate(&pred("$ordinal < \"3\""), &blocks),
            None
        );
        assert_eq!(
            translate_predicate(&pred("\"3\" >= $ordinal"), &blocks),
            None
        );
        assert_eq!(translate_predicate(&pred("$path > 5"), &DOCS), None);
        assert_eq!(translate_predicate(&pred("type <= 1"), &blocks), None);
        assert_eq!(
            translate_predicate(&pred("$ordinal < 3"), &blocks),
            frag("(b.ordinal < ?)", &[SqlValue::Real(3.0)])
        );
        assert_eq!(
            translate_predicate(&pred("$path > \"m\""), &DOCS),
            frag("(('/' || d.path) > ?)", &[text("m")])
        );
        // two reads carry no type at plan time; a boolean equals only text/null
        assert_eq!(
            translate_predicate(&pred("$ordinal == checked"), &blocks),
            None
        );
        assert_eq!(
            translate_predicate(&pred("checked == level"), &blocks),
            None
        );
        assert_eq!(
            translate_predicate(&pred("doc.era == doc.year"), &blocks),
            None
        );
        assert_eq!(translate_predicate(&pred("level < \"x\""), &blocks), None);
        typed("level < 3", &blocks);
        assert_eq!(translate_predicate(&pred("true == false"), &blocks), None);
        assert_eq!(translate_predicate(&pred("checked < true"), &blocks), None);
        assert_eq!(
            translate_predicate(&pred("doc.verified >= false"), &blocks),
            None
        );
        assert_eq!(translate_predicate(&pred("$ordinal > null"), &blocks), None);
        assert!(translate_predicate(&pred("$ordinal == $depth"), &blocks).is_some());
        assert!(translate_predicate(&pred("$ordinal <= $depth"), &blocks).is_some());
        assert!(translate_predicate(&pred("type == null"), &blocks).is_some());
    }

    // -- the typed pushes (spec/surface §1, 1.2 patch) --

    /// The properties subquery's scope: the same single-scalar-row conditions
    /// as the scalar read, so a list-valued or nested key yields NULL.
    const PROP_SCOPE: &str = "FROM properties p WHERE p.doc_id = d.doc_id AND p.key = 'K' AND p.card = 'scalar' AND p.deleted_commit IS NULL AND (SELECT COUNT(*) FROM properties p2 WHERE p2.doc_id = d.doc_id AND p2.key = 'K' AND p2.deleted_commit IS NULL) = 1 LIMIT 1";

    fn prop_sql(key: &str, select: &str, wrap: &str) -> String {
        format!(
            "((SELECT {select} {}) {wrap})",
            PROP_SCOPE.replace('K', key)
        )
    }

    #[test]
    fn json_against_a_boolean_tests_json_type_for_the_literal() {
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        // The boolean is inlined as the JSON type name; nothing binds.
        assert_eq!(
            translate_predicate(&pred("checked == true"), &blocks),
            frag("((json_type(b.attrs, '$.checked') = 'true') IS 1)", &[])
        );
        assert_eq!(
            translate_predicate(&pred("checked == false"), &blocks),
            frag("((json_type(b.attrs, '$.checked') = 'false') IS 1)", &[])
        );
        assert_eq!(
            translate_predicate(&pred("checked != true"), &blocks),
            frag("((json_type(b.attrs, '$.checked') = 'true') IS NOT 1)", &[])
        );
        assert_eq!(
            translate_predicate(&pred("false == attrs.checked"), &blocks),
            frag("((json_type(b.attrs, '$.checked') = 'false') IS 1)", &[])
        );
        // a bound boolean is the same shape
        let params = [Value::Bool(true)];
        let e = Expr::Binary {
            op: BinaryOp::Ne,
            left: ident("checked"),
            right: Box::new(Expr::Binding {
                index: 0,
                span: oqx::Span::EMPTY,
            }),
            span: oqx::Span::EMPTY,
        };
        assert_eq!(
            translate_predicate(
                &e,
                &TranslateCtx {
                    params: &params,
                    ..blocks
                }
            ),
            frag("((json_type(b.attrs, '$.checked') = 'true') IS NOT 1)", &[])
        );
    }

    #[test]
    fn json_against_a_number_tests_the_numeric_types_then_compares() {
        let nodes = TranslateCtx {
            target: Target::Nodes,
            self_alias: "n",
            ..DOCS
        };
        let shape = |op: &str, wrap: &str| {
            format!(
                "((json_type(n.attrs, '$.level') IN ('integer', 'real') AND json_extract(n.attrs, '$.level') {op} ?) {wrap})"
            )
        };
        let two = [SqlValue::Real(2.0)];
        for (src, op, wrap) in [
            ("level == 2", "=", "IS 1"),
            ("level != 2", "=", "IS NOT 1"),
            ("level < 2", "<", "IS 1"),
            ("level <= 2", "<=", "IS 1"),
            ("level > 2", ">", "IS 1"),
            ("level >= 2", ">=", "IS 1"),
        ] {
            assert_eq!(
                translate_predicate(&pred(src), &nodes),
                frag(&shape(op, wrap), &two),
                "{src}"
            );
        }
        // a constant on the left is normalized to the right, the op flipped
        assert_eq!(
            translate_predicate(&pred("2 <= attrs.level"), &nodes),
            frag(&shape(">=", "IS 1"), &two)
        );
        assert_eq!(
            translate_predicate(&pred("2 > level"), &nodes),
            frag(&shape("<", "IS 1"), &two)
        );
        assert_eq!(
            translate_predicate(&pred("2 != level"), &nodes),
            frag(&shape("=", "IS NOT 1"), &two)
        );
    }

    #[test]
    fn property_against_a_boolean_tests_p_type_bool_in_the_scalar_row_subquery() {
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        assert_eq!(
            translate_predicate(&pred("verified == true"), &DOCS),
            frag(
                &prop_sql("verified", "p.type = 'bool' AND p.val_bool = ?", "IS 1"),
                &[SqlValue::Integer(1)]
            )
        );
        assert_eq!(
            translate_predicate(&pred("verified != false"), &DOCS),
            frag(
                &prop_sql("verified", "p.type = 'bool' AND p.val_bool = ?", "IS NOT 1"),
                &[SqlValue::Integer(0)]
            )
        );
        // `doc.<k>` from a block reads the owning document's row
        assert_eq!(
            translate_predicate(&pred("doc.verified == false"), &blocks),
            frag(
                &prop_sql("verified", "p.type = 'bool' AND p.val_bool = ?", "IS 1"),
                &[SqlValue::Integer(0)]
            )
        );
        assert_eq!(
            translate_predicate(&pred("true == verified"), &DOCS),
            frag(
                &prop_sql("verified", "p.type = 'bool' AND p.val_bool = ?", "IS 1"),
                &[SqlValue::Integer(1)]
            )
        );
    }

    #[test]
    fn property_against_a_number_tests_p_type_number_in_the_scalar_row_subquery() {
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        let thousand = [SqlValue::Real(1000.0)];
        for (src, op, wrap) in [
            ("era == 1000", "=", "IS 1"),
            ("era != 1000", "=", "IS NOT 1"),
            ("era < 1000", "<", "IS 1"),
            ("era <= 1000", "<=", "IS 1"),
            ("era > 1000", ">", "IS 1"),
            ("era >= 1000", ">=", "IS 1"),
        ] {
            assert_eq!(
                translate_predicate(&pred(src), &DOCS),
                frag(
                    &prop_sql(
                        "era",
                        &format!("p.type = 'number' AND p.val_num {op} ?"),
                        wrap
                    ),
                    &thousand
                ),
                "{src}"
            );
        }
        assert_eq!(
            translate_predicate(&pred("doc.era >= 1000"), &blocks),
            frag(
                &prop_sql("era", "p.type = 'number' AND p.val_num >= ?", "IS 1"),
                &thousand
            )
        );
        // a constant on the left is normalized to the right, the op flipped
        assert_eq!(
            translate_predicate(&pred("1000 > era"), &DOCS),
            frag(
                &prop_sql("era", "p.type = 'number' AND p.val_num < ?", "IS 1"),
                &thousand
            )
        );
        assert_eq!(
            translate_predicate(&pred("1000 <= era"), &DOCS),
            frag(
                &prop_sql("era", "p.type = 'number' AND p.val_num >= ?", "IS 1"),
                &thousand
            )
        );
    }

    #[test]
    fn typed_pushes_compose_under_and_and_keep_the_untyped_forms() {
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        let e = Expr::Logical {
            op: LogicalOp::And,
            left: eq(ident("type"), lit("task")),
            right: Box::new(Expr::Binary {
                op: BinaryOp::Eq,
                left: ident("checked"),
                right: Box::new(Expr::Lit {
                    value: Value::Bool(false),
                    span: oqx::Span::EMPTY,
                }),
                span: oqx::Span::EMPTY,
            }),
            span: oqx::Span::EMPTY,
        };
        assert_eq!(
            translate_predicate(&e, &blocks),
            frag(
                "((b.type IS ?) AND ((json_type(b.attrs, '$.checked') = 'false') IS 1))",
                &[text("task")]
            )
        );
        // text and null against a read stay the plain IS form
        assert_eq!(
            translate_predicate(&pred("checked == \"x\""), &blocks),
            frag("(json_extract(b.attrs, '$.checked') IS ?)", &[text("x")])
        );
        assert_eq!(
            translate_predicate(&pred("checked != null"), &blocks),
            frag(
                "(json_extract(b.attrs, '$.checked') IS NOT ?)",
                &[SqlValue::Null]
            )
        );
        // an unsafe key never inlines, typed or not
        assert_eq!(
            prop_row("d", "x'y", "p.type = 'number' AND p.val_num = ?"),
            None
        );
    }

    #[test]
    fn bindings_are_typed_by_their_value() {
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        let params = [
            Value::from("s"),
            Value::from(1.0),
            Value::Bool(true),
            Value::Null,
            Value::Array(vec![]),
        ];
        let ctx = TranslateCtx {
            params: &params,
            ..blocks
        };
        let against = |i: usize, rhs: &str| {
            let e = Expr::Binary {
                op: BinaryOp::Eq,
                left: Box::new(Expr::Binding {
                    index: i,
                    span: oqx::Span::EMPTY,
                }),
                right: Box::new(pred(rhs)),
                span: oqx::Span::EMPTY,
            };
            translate_predicate(&e, &ctx).is_some()
        };
        // text binding pushes against anything; number/boolean push typed
        // against JSON (1.2), a boolean not against an integer intrinsic
        assert!(against(0, "checked"));
        assert!(against(1, "checked"));
        assert!(against(2, "checked"));
        assert!(!against(2, "$ordinal"));
        assert!(against(1, "$ordinal"));
        // a null binding pushes against JSON, not against a property
        assert!(against(3, "checked"));
        assert!(!against(3, "doc.tags"));
        // an absent binding (past the end) is null
        assert!(against(9, "checked"));
        assert!(!against(9, "doc.tags"));
        // a non-scalar binding has no faithful SQL value
        assert!(!against(4, "type"));
    }

    // -- decline (b): handles are not property reads --

    #[test]
    fn relation_and_handle_names_are_not_property_reads() {
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        let nodes = TranslateCtx {
            target: Target::Nodes,
            self_alias: "n",
            ..DOCS
        };
        let edges = TranslateCtx {
            target: Target::Edges,
            self_alias: "e",
            ..DOCS
        };
        for (ctx, target) in [
            (&DOCS, Target::Docs),
            (&blocks, Target::Blocks),
            (&nodes, Target::Nodes),
            (&edges, Target::Edges),
        ] {
            for name in non_property_handles(target) {
                let src = format!("{name} == null");
                assert_eq!(
                    translate_predicate(&pred(&src), ctx),
                    None,
                    "{target:?}: {src}"
                );
                let src = format!("{name} == \"x\"");
                assert_eq!(
                    translate_predicate(&pred(&src), ctx),
                    None,
                    "{target:?}: {src}"
                );
            }
        }
        // the fixtures' shapes
        assert_eq!(translate_predicate(&pred("nodes == null"), &DOCS), None);
        assert_eq!(
            translate_predicate(&pred("frontmatter == null"), &DOCS),
            None
        );
        assert_eq!(translate_predicate(&pred("nodes == null"), &blocks), None);
        assert_eq!(translate_predicate(&pred("attrs == null"), &blocks), None);
        // `doc.<handle>` is the doc's handle, not its property; `doc.<k>` still pushes
        assert_eq!(
            translate_predicate(&pred("doc.nodes == null"), &blocks),
            None
        );
        assert_eq!(
            translate_predicate(&pred("doc.frontmatter == null"), &blocks),
            None
        );
        assert_eq!(translate_predicate(&pred("doc.doc == null"), &DOCS), None);
        assert!(translate_predicate(&pred("doc.layer == \"canon\""), &blocks).is_some());
        // a plain attribute or property of the same spelling elsewhere still pushes
        assert!(translate_predicate(&pred("section == \"x\""), &DOCS).is_some());
        assert!(translate_predicate(&pred("frontmatter == \"x\""), &blocks).is_some());
    }

    /// The handle sets are exactly the keys the store context resolves to
    /// rows, a row or a bag before its property fallback: over a small
    /// observed corpus, on every row of a target, a name in the set never
    /// reads as a scalar, and at least one row resolves it to rows / a row /
    /// an object; a name outside the set never does.
    #[test]
    fn handle_sets_match_the_store_context() {
        use std::collections::HashMap;

        use omgbase_reconcile::Config;
        use omgbase_store::{BatchItem, Store};
        use oqx::DataContext;

        use crate::context::StoreContext;

        let mut store = Store::open_in_memory().expect("store");
        let repo = store.create_repo("handles").expect("repo");
        let items = [
            BatchItem::observed(
                "a.md",
                "---\ntitle: A\nlayer: canon\nverified: true\n---\n# Heading\n\nSee [b](b.md) and [[b]].\n\n- [ ] task\n  - nested\n\nkey:: value\n\n## Sub\n\ntext\n",
            ),
            BatchItem::observed("b.md", "# B\n\nBack to [a](a.md).\n"),
        ];
        store
            .observe_batch(
                &repo,
                &items,
                "2026-09-26T00:00:00.000Z",
                &Config::default(),
            )
            .expect("observe");
        let ctx = StoreContext::new(store.conn(), &repo, HashMap::new());

        let mut universe: Vec<&str> = [Target::Docs, Target::Blocks, Target::Nodes, Target::Edges]
            .into_iter()
            .flat_map(|t| non_property_handles(t).iter().copied())
            .collect();
        universe.extend([
            "layer",
            "title",
            "verified",
            "checked",
            "level",
            "format",
            "type",
            "text",
            "kind",
            "name",
            "value",
            "predicate",
            "key",
            "nope",
        ]);
        universe.sort_unstable();
        universe.dedup();

        let is_shape = |v: &Value| matches!(v, Value::Array(_) | Value::Object(_));
        for target in [Target::Docs, Target::Blocks, Target::Nodes, Target::Edges] {
            // a root is a lazy scan marker; `to_rows` reads it
            let rows = ctx.to_rows(&ctx.root(target.as_str()));
            assert!(!rows.is_empty(), "{target:?} has rows");
            let set = non_property_handles(target);
            for name in &universe {
                let mut shaped = 0;
                for row in &rows {
                    let v = ctx.get(row, name).expect("get");
                    if set.contains(name) {
                        assert!(
                            v.is_absent() || is_shape(&v),
                            "{target:?}.{name} read as a scalar: {v:?}"
                        );
                    } else {
                        assert!(!is_shape(&v), "{target:?}.{name} is a handle: {v:?}");
                    }
                    shaped += usize::from(is_shape(&v));
                }
                if set.contains(name) {
                    assert!(
                        shaped > 0,
                        "{target:?}.{name} never resolved to rows or a bag"
                    );
                }
            }
        }
    }

    // -- declines (left residual) return None --

    #[test]
    fn reserved_bare_basename_is_not_pushed() {
        assert_eq!(translate_predicate(&pred("path == \"x\""), &DOCS), None);
        assert_eq!(translate_predicate(&pred("body == \"x\""), &DOCS), None);
        assert_eq!(translate_predicate(&pred("doc.path == \"x\""), &DOCS), None);
    }

    #[test]
    fn docs_body_and_computed_intrinsics_are_not_columns() {
        assert_eq!(translate_predicate(&pred("$body == \"x\""), &DOCS), None);
        assert_eq!(translate_predicate(&pred("$title == \"x\""), &DOCS), None);
        assert_eq!(translate_predicate(&pred("$tags == \"x\""), &DOCS), None);
    }

    #[test]
    fn matches_needs_a_regexp_udf() {
        assert_eq!(
            translate_predicate(&pred("$path.matches(\"^lab/\")"), &DOCS),
            None
        );
    }

    #[test]
    fn negation_as_a_nested_expr_is_not_and_safe() {
        let e = Expr::Unary {
            op: oqx::ast::UnaryOp::Not,
            expr: ident("$path"),
            span: oqx::Span::EMPTY,
        };
        assert_eq!(translate_predicate(&e, &DOCS), None);
    }

    #[test]
    fn disjunction_as_a_nested_expr_is_declined() {
        let e = Expr::Logical {
            op: LogicalOp::Or,
            left: eq(ident("$path"), lit("a")),
            right: eq(ident("$path"), lit("b")),
            span: oqx::Span::EMPTY,
        };
        assert_eq!(translate_predicate(&e, &DOCS), None);
    }

    #[test]
    fn unmapped_node_intrinsic_is_not_pushed() {
        let nodes = TranslateCtx {
            target: Target::Nodes,
            self_alias: "n",
            ..DOCS
        };
        assert_eq!(
            translate_predicate(&pred("$locator == \"x\""), &nodes),
            None
        );
        // `$updated_at` is mapped on docs only.
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        assert_eq!(
            translate_predicate(&pred("$updated_at == \"x\""), &blocks),
            None
        );
    }

    #[test]
    fn range_membership_in_and_bare_idents_are_declined() {
        assert_eq!(translate_predicate(&pred("era in 800..1680"), &DOCS), None);
        assert_eq!(
            translate_predicate(&pred("\"a\" in list(tags)"), &DOCS),
            None
        );
        assert_eq!(translate_predicate(&pred("verified"), &DOCS), None);
        assert_eq!(translate_predicate(&pred("doc.verified"), &DOCS), None);
        assert_eq!(translate_predicate(&pred("size(tags) > 1"), &DOCS), None);
        assert_eq!(translate_predicate(&pred("$self.text(\"x\")"), &DOCS), None);
        assert_eq!(translate_predicate(&pred("$it == \"x\""), &DOCS), None);
        assert_eq!(translate_predicate(&pred("^slug == \"x\""), &DOCS), None);
        assert_eq!(
            translate_predicate(&pred("frontmatter.era == 1"), &DOCS),
            None
        );
    }

    // -- conjunction and bindings via constructed AST --

    #[test]
    fn and_composes_two_pushable_comparisons() {
        let e = Expr::Logical {
            op: LogicalOp::And,
            left: eq(ident("$path"), lit("a")),
            right: Box::new(Expr::Binary {
                op: BinaryOp::Ne,
                left: ident("$id"),
                right: lit("d_2"),
                span: oqx::Span::EMPTY,
            }),
            span: oqx::Span::EMPTY,
        };
        assert_eq!(
            translate_predicate(&e, &DOCS),
            frag(
                "((('/' || d.path) IS ?) AND (d.doc_id IS NOT ?))",
                &[text("a"), text("d_2")]
            )
        );
    }

    #[test]
    fn and_declines_wholesale_if_either_side_is_not_pushable() {
        let e = Expr::Logical {
            op: LogicalOp::And,
            left: eq(ident("$path"), lit("a")),
            // $body is reconstructed, not a column → the whole && declines.
            right: eq(ident("$body"), lit("x")),
            span: oqx::Span::EMPTY,
        };
        assert_eq!(translate_predicate(&e, &DOCS), None);
    }

    #[test]
    fn resolves_a_binding_to_its_param_value() {
        let e = eq(
            ident("$path"),
            Box::new(Expr::Binding {
                index: 0,
                span: oqx::Span::EMPTY,
            }),
        );
        let params = [Value::from("from-binding.md")];
        let ctx = TranslateCtx {
            params: &params,
            ..DOCS
        };
        assert_eq!(
            translate_predicate(&e, &ctx),
            frag("(('/' || d.path) IS ?)", &[text("from-binding.md")])
        );
        // A binding past the end reads as absent → NULL.
        assert_eq!(
            translate_predicate(&e, &DOCS),
            frag("(('/' || d.path) IS ?)", &[SqlValue::Null])
        );
    }

    // -- per-target fields --

    #[test]
    fn blocks_and_nodes_flatten_bare_identifiers_into_attrs() {
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        // (a top-level `&&` is a `Where::And` of scalars; the nested form is
        // reached through constructed AST, as in the reference's tests)
        let both = Expr::Logical {
            op: LogicalOp::And,
            left: eq(ident("type"), lit("task")),
            right: eq(ident("marker"), lit("x")),
            span: oqx::Span::EMPTY,
        };
        assert_eq!(
            translate_predicate(&both, &blocks),
            frag(
                "((b.type IS ?) AND (json_extract(b.attrs, '$.marker') IS ?))",
                &[text("task"), text("x")]
            )
        );
        assert_eq!(
            translate_predicate(&pred("attrs.marker == \"x\""), &blocks),
            frag("(json_extract(b.attrs, '$.marker') IS ?)", &[text("x")])
        );
        // (a boolean or number against a JSON read pushes typed — see the
        // typed-shape tests)
        assert_eq!(
            translate_predicate(&pred("attrs.checked == true"), &blocks),
            frag("((json_type(b.attrs, '$.checked') = 'true') IS 1)", &[])
        );
        let nodes = TranslateCtx {
            target: Target::Nodes,
            self_alias: "n",
            ..DOCS
        };
        assert_eq!(
            translate_predicate(&pred("kind == \"md:section\""), &nodes),
            frag("(n.kind IS ?)", &[text("md:section")])
        );
        assert_eq!(
            translate_predicate(&pred("level == \"1\""), &nodes),
            frag("(json_extract(n.attrs, '$.level') IS ?)", &[text("1")])
        );
        assert_eq!(
            translate_predicate(&pred("level == 1"), &nodes),
            frag(
                "((json_type(n.attrs, '$.level') IN ('integer', 'real') AND json_extract(n.attrs, '$.level') = ?) IS 1)",
                &[SqlValue::Real(1.0)]
            )
        );
        assert_eq!(
            translate_predicate(&pred("attrs.a.b == \"c\""), &nodes),
            frag("(json_extract(n.attrs, '$.a.b') IS ?)", &[text("c")])
        );
        // `attrs.<k>` is a blocks/nodes form; on docs it is not a column.
        assert_eq!(
            translate_predicate(&pred("attrs.marker == \"x\""), &DOCS),
            None
        );
    }

    #[test]
    fn doc_and_block_reach_through() {
        let blocks = TranslateCtx {
            target: Target::Blocks,
            self_alias: "b",
            ..DOCS
        };
        let f = translate_predicate(&pred("doc.type == \"lab-note\""), &blocks).expect("pushable");
        assert!(
            f.sql.contains("p.doc_id = d.doc_id AND p.key = 'type'"),
            "{}",
            f.sql
        );
        assert_eq!(
            translate_predicate(&pred("doc.$path == \"a.md\""), &blocks),
            frag("(('/' || d.path) IS ?)", &[text("a.md")])
        );
        // a rooted literal (what the runner's rewrite always produces) takes
        // the indexed fast path on the storage column
        assert_eq!(
            translate_predicate(&pred("doc.$path == \"/a.md\""), &blocks),
            frag("(d.path IS ?)", &[text("a.md")])
        );
        assert_eq!(
            translate_predicate(&pred("doc.format == \"markdown\""), &blocks),
            frag("(d.format IS ?)", &[text("markdown")])
        );
        assert_eq!(
            translate_predicate(&pred("doc.$id == \"d_1\""), &blocks),
            None
        );
        assert_eq!(translate_predicate(&pred("doc.a.b == 1"), &blocks), None);
        let nodes = TranslateCtx {
            target: Target::Nodes,
            self_alias: "n",
            ..DOCS
        };
        assert_eq!(
            translate_predicate(&pred("block.type == \"task\""), &nodes),
            frag(
                "((SELECT bb.type FROM blocks bb WHERE bb.block_id = n.block_id) IS ?)",
                &[text("task")]
            )
        );
        assert_eq!(
            translate_predicate(&pred("block.type == \"task\""), &blocks),
            None
        );
        assert_eq!(
            translate_predicate(&pred("section.level == 1"), &nodes),
            None
        );
    }

    #[test]
    fn edges_push_their_five_fields_and_intrinsics() {
        let edges = TranslateCtx {
            target: Target::Edges,
            self_alias: "e",
            ..DOCS
        };
        assert_eq!(
            translate_predicate(&pred("predicate == \"references\""), &edges),
            frag("(e.predicate IS ?)", &[text("references")])
        );
        assert_eq!(
            translate_predicate(&pred("$dst_path == \"index.md\""), &edges),
            frag(
                "((SELECT '/' || dd.path FROM docs dd WHERE dd.doc_id = e.dst_node) IS ?)",
                &[text("index.md")]
            )
        );
        assert_eq!(translate_predicate(&pred("weight == 1"), &edges), None);
    }

    #[test]
    fn unsafe_identifier_segments_are_never_inlined() {
        assert!(is_seg("layer") && is_seg("_x9"));
        assert!(!is_seg("") && !is_seg("9a") && !is_seg("a-b") && !is_seg("a'b"));
        assert_eq!(json_path(&["ok", "no-pe"]), None);
        assert_eq!(json_path(&["ok", "a_1"]).as_deref(), Some("$.ok.a_1"));
        assert_eq!(prop_scalar("d", "x'y"), None);
    }
}
