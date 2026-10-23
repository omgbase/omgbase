//! The canonical printer (`spec/oqx/AST.md` §6; port of
//! `packages/oqx/src/print.ts`): the one source text of a tree. Single spaces,
//! double-quoted strings with GRAMMAR §1 escapes, the minimal parentheses the
//! precedence table (GRAMMAR §4) needs, the collection-scoped form `<source> { … }`
//! for every query whose source can head a block (since 0.26; `collect` is the
//! bare brace, every other consumer its word), the projection leading its body
//! without `select`, every clause in its canonical position (a destination
//! block's `frontier` and `depth` after its `where`, since 0.20). The law both spec runners enforce over
//! every fixture query:
//!
//! ```text
//! strip(parse(print(parse(q)))) ≡ strip(parse(q))
//! ```
//!
//! `print(parse(q)) == q` is NOT a law — the printer normalizes spelling. A
//! binding is a value, never source text: [`print`] fails on one (stage
//! `print`); [`print_template`] emits template fragments around each binding
//! instead.

use crate::ast::{
    BinaryOp, Consumer, Expr, Flatten, Follow, FollowDestination, GroupBy, GroupKey, LogicalOp,
    OpNode, OrderSpec, Query, SelectItem, Subquery, TemplatePart, Where,
};
use crate::errors::{OqxError, Result};
use crate::value::{Value, js_number_to_string};
use crate::walk::Node;

/// The template form of a tree: `strings` has `count + 1` fragments; the i-th gap
/// stands for the binding `indices[i]` of the printed tree, so a caller re-runs
/// it as `parse_template(&strings, count)` with the values permuted by
/// `indices`. In a tree straight from `parse_template`, `indices` is
/// `0..count` unless the canonical clause order moved a binding past another
/// (`select x: ${1} from ${0}` prints as `${0} { x: ${1} }`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Template {
    pub strings: Vec<String>,
    pub count: usize,
    pub indices: Vec<usize>,
}

/// The canonical source of a node. Fails (stage `print`) on a binding.
pub fn print(node: Node<'_>) -> Result<String> {
    let mut text = String::new();
    for p in render(node) {
        match p {
            Piece::Text(s) => text.push_str(&s),
            Piece::Binding(i) => {
                return Err(OqxError::print(format!(
                    "cannot print binding ${{{i}}}: a binding is a value, not source text — use print_template"
                )));
            }
        }
    }
    Ok(text)
}

/// [`print`] of a whole query.
pub fn print_query(q: &Query) -> Result<String> {
    print(Node::Query(q))
}

/// The canonical source of a node as template fragments, one gap per binding.
pub fn print_template(node: Node<'_>) -> Template {
    let mut strings = Vec::new();
    let mut indices = Vec::new();
    let mut current = String::new();
    for p in render(node) {
        match p {
            Piece::Text(s) => current.push_str(&s),
            Piece::Binding(i) => {
                strings.push(std::mem::take(&mut current));
                indices.push(i);
            }
        }
    }
    strings.push(current);
    Template {
        strings,
        count: indices.len(),
        indices,
    }
}

// Output is a list of pieces: source text, or a binding index standing where the
// binding goes (so a template can be split exactly there).
#[derive(Clone, Debug)]
enum Piece {
    Text(String),
    Binding(usize),
}

type Out = Vec<Piece>;

fn text(s: impl Into<String>) -> Out {
    vec![Piece::Text(s.into())]
}

fn cat(parts: Vec<Out>) -> Out {
    parts.into_iter().flatten().collect()
}

fn join(parts: Vec<Out>, sep: &str) -> Out {
    let mut out = Vec::new();
    for (i, p) in parts.into_iter().enumerate() {
        if i > 0 {
            out.push(Piece::Text(sep.to_owned()));
        }
        out.extend(p);
    }
    out
}

fn paren(o: Out, yes: bool) -> Out {
    if yes {
        cat(vec![text("("), o, text(")")])
    } else {
        o
    }
}

// Precedence levels of GRAMMAR §4, loosest to tightest. A child is
// parenthesized when its level is below what its position requires.
const OR: u8 = 1;
const AND: u8 = 2;
const CMP: u8 = 3;
const RANGE: u8 = 4;
const ADD: u8 = 5;
const MUL: u8 = 6;
const UNARY: u8 = 7;
const POSTFIX: u8 = 8;
const PRIMARY: u8 = 9;

fn prec(e: &Expr) -> u8 {
    match e {
        Expr::Lit { .. }
        | Expr::Ident { .. }
        | Expr::Outer { .. }
        | Expr::Binding { .. }
        | Expr::Tuple { .. }
        | Expr::Template { .. } => PRIMARY,
        Expr::Member { .. }
        | Expr::Call { .. }
        | Expr::Aggregate { .. }
        | Expr::Required { .. }
        | Expr::Op(_) => POSTFIX,
        Expr::Unary { .. } => UNARY,
        Expr::Binary { op, .. } => match op {
            BinaryOp::Add | BinaryOp::Sub => ADD,
            BinaryOp::Mul | BinaryOp::Div | BinaryOp::Mod => MUL,
            _ => CMP,
        },
        Expr::In { .. } => CMP,
        Expr::Range { .. } => RANGE,
        Expr::Logical { op, .. } => match op {
            LogicalOp::And => AND,
            LogicalOp::Or => OR,
        },
    }
}

fn render(n: Node<'_>) -> Out {
    match n {
        Node::Query(q) => query(q),
        Node::Subquery(s) => block(s),
        Node::Op(op) => op_node(op),
        Node::Follow(f) => follow(f),
        Node::Flatten(f) => flatten(f),
        Node::GroupBy(g) => group_by(g),
        Node::Key(k) => key(k),
        Node::Order(o) => order(o),
        Node::Select(it) => item(it),
        Node::Where(w) => where_tree(w),
        Node::Expr(e) => expr(e),
    }
}

// ---- query / bodies -----------------------------------------------------------

fn query(q: &Query) -> Out {
    // The collection-scoped form (since 0.26): `<source> [<consumer>] [distinct]
    // { body }` — the source heads the body, `collect` is the bare brace (the
    // directive word is written after an `op` source, where a bare brace is not
    // read as a block), `distinct` stays on the head.
    if can_head_block(&q.source) {
        let mut body_clauses: Vec<Out> = Vec::new();
        if !q.select.is_empty() {
            body_clauses.push(projection(&q.select, q.values));
        }
        body_clauses.extend(tail(
            &q.from,
            q.r#where.as_ref(),
            q.frontier.as_ref(),
            None,
            q.follow.as_ref(),
            &q.flatten,
            q.group_by.as_ref(),
            q.having.as_ref(),
            q.order_by.as_deref(),
            q.limit.as_ref(),
            q.offset.as_ref(),
        ));
        return cat(vec![
            expr(&q.source),
            directive(q.consumer, q.distinct, &q.source, body_clauses),
        ]);
    }
    // A source that cannot head a block — a literal, a template, a range,
    // arithmetic, a logical or `in` operand, a unary, an aggregate: every one an
    // eval error or a degenerate query — keeps the clause form `select … from S …`
    // (a `collect`; another consumer over such a source is unparseable either
    // way). `select` is always written — except for a leading bare item literally
    // named `distinct`, which the keyword would swallow as the modifier.
    let bare_distinct = !q.distinct
        && matches!(
            q.select.first(),
            Some(SelectItem::Field { name, expr: Expr::Ident { name: e, .. }, .. })
                if name == "distinct" && e == "distinct"
        );
    let mut clauses: Vec<Out> = Vec::new();
    if !q.select.is_empty() {
        let items = projection(&q.select, q.values);
        clauses.push(if bare_distinct {
            items
        } else {
            cat(vec![
                text(format!(
                    "select {}",
                    if q.distinct { "distinct " } else { "" }
                )),
                items,
            ])
        });
    }
    clauses.push(cat(vec![text("from "), expr(&q.source)]));
    clauses.extend(tail(
        &q.from,
        q.r#where.as_ref(),
        q.frontier.as_ref(),
        None,
        q.follow.as_ref(),
        &q.flatten,
        q.group_by.as_ref(),
        q.having.as_ref(),
        q.order_by.as_deref(),
        q.limit.as_ref(),
        q.offset.as_ref(),
    ));
    join(clauses, " ")
}

/// Whether `e { … }` parses with `e` as the receiver (GRAMMAR §5 and the postfix
/// chain of §4): a tuple, or a chain — navigation, calls, `!`, directives —
/// whose head is a bare name, an outer reference, a binding or a free call. A
/// literal or template head is "not a collection"; an operator (`-x`, `a + b`,
/// `a..b`, `a in b`, `a or b`) or an aggregate cannot head a receiver.
fn can_head_block(e: &Expr) -> bool {
    match e {
        Expr::Ident { .. } | Expr::Outer { .. } | Expr::Binding { .. } | Expr::Tuple { .. } => true,
        Expr::Call { recv, .. } => recv.as_deref().is_none_or(chain_head),
        Expr::Member { recv, .. } => chain_head(recv),
        Expr::Required { expr, .. } => chain_head(expr),
        Expr::Op(op) => chain_head(&op.receiver),
        _ => false,
    }
}

/// The head of a postfix chain that may take a block: as [`can_head_block`], but
/// a tuple is a receiver only on its own (`(a, b).x { … }` is not read as one).
fn chain_head(e: &Expr) -> bool {
    !matches!(e, Expr::Tuple { .. }) && can_head_block(e)
}

/// The text between a receiver and its block: ` ` for the bare-brace `collect`
/// (since 0.26 the canonical spelling), ` distinct ` for a distinct collect,
/// ` <op> [distinct] ` for the other consumers — and for a `collect` over an
/// `op` receiver, where a bare brace right after a written directive is not
/// read as a block (`jobs first { offset 0 } collect { … }`).
fn directive_word(consumer: Consumer, distinct: bool, receiver: &Expr) -> String {
    if consumer == Consumer::Collect && !matches!(receiver, Expr::Op(_)) {
        return if distinct { " distinct " } else { " " }.to_string();
    }
    format!(
        " {}{} ",
        consumer.as_str(),
        if distinct { " distinct" } else { "" }
    )
}

// The clauses after `from` (a query) or after the projection (a block): the
// fixed clause order, each present clause once. `depth` exists only on a follow
// destination block's body (a `Query` has none); `frontier` on any body that
// has a `follow` (0.20); every `flatten` after `follow` (0.25); `group by` and
// `having` after them (0.24).
#[allow(clippy::too_many_arguments)]
fn tail(
    from: &[Expr],
    r#where: Option<&Where>,
    frontier: Option<&Expr>,
    depth: Option<u32>,
    follow_clause: Option<&Follow>,
    flatten_clauses: &[Flatten],
    group_by_clause: Option<&GroupBy>,
    having: Option<&Where>,
    order_by: Option<&[OrderSpec]>,
    limit: Option<&Expr>,
    offset: Option<&Expr>,
) -> Vec<Out> {
    let mut out = Vec::new();
    for e in from {
        out.push(cat(vec![text("from "), expr(e)]));
    }
    if let Some(w) = r#where {
        out.push(cat(vec![text("where "), where_tree(w)]));
    }
    if let Some(e) = frontier {
        out.push(cat(vec![text("frontier "), expr(e)]));
    }
    if let Some(d) = depth {
        out.push(text(format!("depth {d}")));
    }
    if let Some(f) = follow_clause {
        out.push(follow(f));
    }
    for f in flatten_clauses {
        out.push(flatten(f));
    }
    if let Some(g) = group_by_clause {
        out.push(group_by(g));
    }
    if let Some(h) = having {
        out.push(cat(vec![text("having "), where_tree(h)]));
    }
    if let Some(o) = order_by.filter(|o| !o.is_empty()) {
        out.push(cat(vec![
            text("order by "),
            join(o.iter().map(order).collect(), ", "),
        ]));
    }
    if let Some(e) = limit {
        out.push(cat(vec![text("limit "), expr(e)]));
    }
    if let Some(e) = offset {
        out.push(cat(vec![text("offset "), expr(e)]));
    }
    out
}

// A block body: the projection leads without its keyword (the body's first
// clause is always the projection, so the keyword adds nothing there).
fn block(s: &Subquery) -> Out {
    braces(block_clauses(s))
}

fn block_clauses(s: &Subquery) -> Vec<Out> {
    let mut clauses: Vec<Out> = Vec::new();
    if !s.select.is_empty() {
        clauses.push(projection(&s.select, s.values));
    }
    clauses.extend(tail(
        &s.from,
        s.r#where.as_ref(),
        s.frontier.as_ref(),
        s.depth,
        s.follow.as_ref(),
        &s.flatten,
        s.group_by.as_ref(),
        s.having.as_ref(),
        s.order_by.as_deref(),
        s.limit.as_ref(),
        s.offset.as_ref(),
    ));
    clauses
}

// A directive's word and block after its receiver: the bare brace for
// `collect`, the word for every other consumer — and, when the word is written
// and the block is empty, the word alone (`jobs first`, `_nodes exists`, `jobs
// count distinct`; since 0.26 an omitted block is the empty block).
fn directive(consumer: Consumer, distinct: bool, receiver: &Expr, clauses: Vec<Out>) -> Out {
    let word = directive_word(consumer, distinct, receiver);
    if word != " " && word != " distinct " && clauses.is_empty() {
        return text(word.trim_end().to_owned());
    }
    cat(vec![text(word), braces(clauses)])
}

fn braces(clauses: Vec<Out>) -> Out {
    if clauses.is_empty() {
        text("{ }")
    } else {
        cat(vec![text("{ "), join(clauses, " "), text(" }")])
    }
}

fn projection(items: &[SelectItem], values: bool) -> Out {
    cat(vec![
        join(items.iter().map(item).collect(), ", "),
        text(if values { " values" } else { "" }),
    ])
}

fn item(it: &SelectItem) -> Out {
    match it {
        // An unnamed directive item exists only under `values` (`jobs[0] values`).
        SelectItem::Collect { name, op, .. } if name.is_empty() => op_node(op),
        SelectItem::Collect { name, op, .. } => cat(vec![text(format!("{name}: ")), op_node(op)]),
        SelectItem::Field {
            name,
            expr: e,
            lift,
            ..
        } => cat(vec![
            text("^".repeat(*lift)),
            text(if name.is_empty() {
                String::new()
            } else {
                format!("{name}: ")
            }),
            expr(e),
        ]),
    }
}

fn order(o: &OrderSpec) -> Out {
    cat(vec![expr(&o.expr), text(if o.desc { " desc" } else { "" })])
}

fn op_node(o: &OpNode) -> Out {
    cat(vec![
        receiver(&o.receiver),
        directive(o.op, o.distinct, &o.receiver, block_clauses(&o.sub)),
        text(match &o.count_cmp {
            Some(c) => format!(" {} {}", c.op.as_str(), js_number_to_string(c.value)),
            None => String::new(),
        }),
    ])
}

fn follow(f: &Follow) -> Out {
    let dests = join(
        f.destinations
            .iter()
            .map(|d| match d {
                FollowDestination::Relation(e) => expr(e),
                FollowDestination::Block(op) => op_node(op),
            })
            .collect(),
        ", ",
    );
    cat(vec![
        text(format!(
            "follow{} ",
            if f.distinct { " distinct" } else { "" }
        )),
        dests,
    ])
}

// `as <name>` is always written (0.25), as every select item and group key is
// aliased: the tree does not record whether it was, and the name is what the
// later clauses read.
fn flatten(f: &Flatten) -> Out {
    cat(vec![
        text("flatten "),
        expr(&f.expr),
        text(format!(" as {}", f.name)),
    ])
}

// Every key aliased, as every select item is (`group by layer: layer`).
fn group_by(g: &GroupBy) -> Out {
    cat(vec![
        text("group by "),
        join(g.keys.iter().map(key).collect(), ", "),
    ])
}

fn key(k: &GroupKey) -> Out {
    cat(vec![text(format!("{}: ", k.name)), expr(&k.expr)])
}

// ---- where --------------------------------------------------------------------

fn where_tree(w: &Where) -> Out {
    match w {
        Where::And { parts, .. } => join(
            parts
                .iter()
                .map(|p| {
                    paren(
                        where_tree(p),
                        matches!(p, Where::Or { .. } | Where::And { .. }),
                    )
                })
                .collect(),
            " and ",
        ),
        Where::Or { parts, .. } => join(
            parts
                .iter()
                .map(|p| paren(where_tree(p), matches!(p, Where::Or { .. })))
                .collect(),
            " or ",
        ),
        Where::Not { expr: inner, .. } => {
            // The operand of `!` is a consumer test, a group, or a scalar primary —
            // a comparison or anything looser must be grouped (`!(a == b)`).
            let grouped = match &**inner {
                Where::And { .. } | Where::Or { .. } => true,
                Where::Scalar { expr: e, .. } => prec(e) < UNARY,
                _ => false,
            };
            cat(vec![text("!"), paren(where_tree(inner), grouped)])
        }
        Where::Scalar { expr: e, .. } => expr(e),
        Where::Op(op) => op_node(op),
    }
}

// ---- expressions --------------------------------------------------------------

fn expr(e: &Expr) -> Out {
    match e {
        Expr::Lit { value, .. } => text(literal(value)),
        Expr::Ident { name, .. } => text(name.clone()),
        Expr::Outer { levels, name, .. } => text(format!("{}{name}", "^".repeat(*levels))),
        Expr::Binding { index, .. } => vec![Piece::Binding(*index)],
        Expr::Member { recv, name, .. } => cat(vec![receiver(recv), text(format!(".{name}"))]),
        Expr::Call {
            recv, name, args, ..
        } => {
            let args = cat(vec![
                text("("),
                join(args.iter().map(expr).collect(), ", "),
                text(")"),
            ]);
            match recv {
                None => cat(vec![text(name.clone()), args]),
                Some(r) => cat(vec![receiver(r), text(format!(".{name}")), args]),
            }
        }
        // An aggregate prints as the call it is written as (`count()`, `sum(distinct x)`).
        Expr::Aggregate {
            name,
            arg,
            distinct,
            ..
        } => cat(vec![
            text(format!(
                "{}({}",
                name.as_str(),
                if *distinct { "distinct " } else { "" }
            )),
            arg.as_deref().map_or_else(Vec::new, expr),
            text(")"),
        ]),
        Expr::Unary { op, expr: x, .. } => cat(vec![text(op.as_str()), operand(x, UNARY)]),
        // Postfix, tightest: anything below postfix level is grouped (`(a + 1)!`).
        Expr::Required { expr: x, .. } => cat(vec![operand(x, POSTFIX), text("!")]),
        Expr::Op(op) => op_node(op),
        Expr::Binary {
            op, left, right, ..
        } => {
            let p = prec(e);
            // Left-associative arithmetic keeps an equal-level left operand bare and
            // groups an equal-level right one; a comparison is non-associative, so a
            // nested comparison is grouped on either side.
            let left_min = if p == CMP { p + 1 } else { p };
            cat(vec![
                operand(left, left_min),
                text(format!(" {} ", op.as_str())),
                operand(right, p + 1),
            ])
        }
        Expr::Logical {
            op, left, right, ..
        } => {
            // The connectives print as the words (`and` / `or`, since 0.18); the
            // symbols parse to the same nodes.
            let p = prec(e);
            let word = match op {
                LogicalOp::And => " and ",
                LogicalOp::Or => " or ",
            };
            cat(vec![operand(left, p), text(word), operand(right, p + 1)])
        }
        Expr::In { left, right, .. } => cat(vec![
            operand(left, CMP + 1),
            text(" in "),
            operand(right, CMP + 1),
        ]),
        Expr::Range {
            lo,
            hi,
            exclusive_end,
            ..
        } => cat(vec![
            lo.as_deref().map_or_else(Vec::new, |l| operand(l, ADD)),
            text(if *exclusive_end { "..." } else { ".." }),
            hi.as_deref().map_or_else(Vec::new, |h| operand(h, ADD)),
        ]),
        // A tuple is self-delimiting; its elements are full expressions.
        Expr::Tuple { items, .. } => cat(vec![
            text("("),
            join(items.iter().map(expr).collect(), ", "),
            text(")"),
        ]),
        // A template literal: its texts escaped for the backtick form, each
        // interpolation a full expression between `${` and `}`.
        Expr::Template { parts, .. } => {
            let mut out = text("`");
            for part in parts {
                match part {
                    TemplatePart::Text(t) => out.push(Piece::Text(template_text(t))),
                    TemplatePart::Expr(e) => {
                        out.extend(cat(vec![text("${"), expr(e), text("}")]));
                    }
                }
            }
            out.push(Piece::Text("`".to_owned()));
            out
        }
    }
}

// A child expression, parenthesized when its level is below `min`.
fn operand(e: &Expr, min: u8) -> Out {
    paren(expr(e), prec(e) < min)
}

// The value a `.name` navigates: postfix level, and a number literal is grouped
// too (`1.size()` would lex as a malformed number).
fn receiver(e: &Expr) -> Out {
    let number = matches!(
        e,
        Expr::Lit {
            value: Value::Number(_),
            ..
        }
    );
    paren(expr(e), prec(e) < POSTFIX || number)
}

fn literal(v: &Value) -> String {
    match v {
        Value::Null | Value::Undefined => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(*n),
        Value::Str(s) => quote(s),
        other => other.to_string(),
    }
}

/// The text piece of a template literal, escaped for the backtick form: the
/// backtick, the backslash and a `${` opener (as `\${`) with the GRAMMAR §1
/// control-character escapes; everything else verbatim.
fn template_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '`' => out.push_str("\\`"),
            '\\' => out.push_str("\\\\"),
            '$' if chars.peek() == Some(&'{') => out.push_str("\\$"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '\0' => out.push_str("\\0"),
            c => out.push(c),
        }
    }
    out
}

/// A double-quoted string literal with the GRAMMAR §1 escapes.
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => out.push_str("\\r"),
            '\0' => out.push_str("\\0"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
