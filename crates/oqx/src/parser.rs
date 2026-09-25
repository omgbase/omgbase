//! OQX parser for the generic kernel (a port of `packages/oqx/src/parser.ts`).
//! Parses query STRUCTURE (source chain, where/select/order/follow, the
//! where-clause boolean tree, and postfix consumer directives) and, for scalar
//! interiors, builds an evaluable expression AST with an embedded Pratt parser
//! sharing the same token cursor.
//!
//! Two design-kernel rules (see the OQX syntax notes) shape the grammar:
//!   1. Dot navigation belongs to the host object model — a receiver/source is a
//!      dotted identifier chain (or a `${…}` binding), NOT a method call.
//!   2. Whitespace directives (collect/exists/count/first/single) belong to OQX —
//!      a consumer is `<receiver> <directive> { <block> }`, never a method.
//!
//! Clause order is FIXED (ADR-020). Within one clause body — the top level or a
//! consumer block — each clause appears at most once, in exactly this order:
//!
//! ```text
//! select <projection>  from <source>  where <predicate>  follow <relation> {…}
//! order by …  limit N  offset N
//! ```
//!
//! Every clause is optional except that a top-level body needs `from` (the
//! receiver-plus-consumer form `<receiver> <consumer> { block }` supplies the
//! source itself, so its block's `from` is an optional re-projection). Only
//! `select` may drop its keyword, and only when it is the first clause written
//! (`name, age from people`); every other clause always carries its keyword, so
//! a predicate is never implicit — a block filters with `where`. An out-of-order
//! clause is a parse error naming the order. `where` may reference the same
//! body's `select` aliases: after a body is parsed, each bare identifier in its
//! `where` that names an alias is replaced by the alias's expression (a
//! compile-time rewrite — see `inline_aliases`).
//!
//! Error messages are the TS messages verbatim (the conformance fixtures and
//! the reference tests assert on fragments of them).

use std::collections::HashMap;

use crate::ast::{
    BinaryOp, Consumer, CountCmp, Expr, Follow, LogicalOp, OpNode, OrderSpec, Query, RelOp,
    SelectItem, Subquery, UnaryOp, Where,
};
use crate::errors::{OqxError, Result};
use crate::lexer::{TokType, Token, lex_string, lex_template};
use crate::value::Value;

const CONSUMERS: [&str; 6] = ["collect", "exists", "none", "count", "first", "single"];

/// The fixed clause order of a body (ADR-020). Each clause appears at most once.
/// Declaration order is the clause order; `Ord` compares by it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Clause {
    Select,
    From,
    Where,
    Follow,
    OrderBy,
    Limit,
    Offset,
}

const CLAUSE_ORDER: [Clause; 7] = [
    Clause::Select,
    Clause::From,
    Clause::Where,
    Clause::Follow,
    Clause::OrderBy,
    Clause::Limit,
    Clause::Offset,
];

impl Clause {
    fn as_str(self) -> &'static str {
        match self {
            Clause::Select => "select",
            Clause::From => "from",
            Clause::Where => "where",
            Clause::Follow => "follow",
            Clause::OrderBy => "order by",
            Clause::Limit => "limit",
            Clause::Offset => "offset",
        }
    }
}

fn clause_order_sentence() -> String {
    CLAUSE_ORDER
        .iter()
        .map(|c| c.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

// Contextual clause words lexed as bare idents; an open-ended range must stop
// before them rather than consume them as its high bound.
const CLAUSE_WORDS: [&str; 18] = [
    "collect", "exists", "none", "count", "first", "single", "order", "by", "asc", "desc",
    "follow", "distinct", "frontier", "depth", "in", "values", "limit", "offset",
];
const RELOPS: [&str; 6] = ["==", "!=", "<", "<=", ">", ">="];
const CMP_OPS: [&str; 6] = ["==", "!=", "<", "<=", ">", ">="];
const ADD_OPS: [&str; 2] = ["+", "-"];
const MUL_OPS: [&str; 3] = ["*", "/", "%"];

/// Parse a tagged-template call into a Query: `fragments` are the cooked string
/// pieces (one more than `values`), `values` the number of `${…}` bindings,
/// which become `Expr::Binding { index: 0..values }` in fragment order.
pub fn parse_template<S: AsRef<str>>(fragments: &[S], values: usize) -> Result<Query> {
    Parser::new(lex_template(fragments, values)?).parse_query()
}

/// Parse a plain query string (no bindings) into a Query.
pub fn parse_string(src: &str) -> Result<Query> {
    Parser::new(lex_string(src)?).parse_query()
}

/// JavaScript `Number(text)` for a number token: the lexer's shape is always a
/// valid float except an exponent with no digits (`1e`), which is NaN in the TS.
fn number_value(text: &str) -> f64 {
    text.parse().unwrap_or(f64::NAN)
}

/// JavaScript `Number.isInteger`.
fn is_integer(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0
}

#[derive(Default)]
struct BodyClauses {
    froms: Vec<Expr>,
    r#where: Option<Where>,
    select: Vec<SelectItem>,
    order_by: Option<Vec<OrderSpec>>,
    follow: Option<Follow>,
    distinct: bool,
    values: bool,
    limit: Option<Expr>,
    offset: Option<Expr>,
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        debug_assert!(tokens.last().is_some_and(|t| t.kind == TokType::Eof));
        Self { tokens, pos: 0 }
    }

    // ---- cursor helpers -------------------------------------------------------
    fn peek(&self) -> &Token {
        // The stream always ends in `eof`, and the cursor never advances past a
        // token it has not inspected, so this clamp is only defensive.
        &self.tokens[self.pos.min(self.tokens.len() - 1)]
    }
    fn peek_at(&self, n: usize) -> Option<&Token> {
        self.tokens.get(self.pos + n)
    }
    fn next(&mut self) -> Token {
        let t = self.peek().clone();
        self.pos += 1;
        t
    }
    fn at(&self, kind: TokType) -> bool {
        self.peek().kind == kind
    }
    fn at_word(&self, kind: TokType, value: &str) -> bool {
        let t = self.peek();
        t.kind == kind && t.value == value
    }
    fn at_op(&self, value: &str) -> bool {
        self.at_word(TokType::Op, value)
    }
    fn fail<T>(&self, msg: impl AsRef<str>) -> Result<T> {
        Err(OqxError::parse(format!(
            "{} (at offset {})",
            msg.as_ref(),
            self.peek().pos
        )))
    }

    // ---- top level ------------------------------------------------------------
    fn parse_query(&mut self) -> Result<Query> {
        // Directive form: `<receiver> <consumer> { … }` consuming the whole query.
        if let Some(directive) = self.try_op()? {
            if self.at(TokType::Eof) {
                let sub = directive.sub;
                return Ok(Query {
                    source: directive.receiver,
                    from: sub.from,
                    r#where: sub.r#where,
                    select: sub.select,
                    order_by: sub.order_by,
                    consumer: directive.op,
                    follow: sub.follow,
                    distinct: directive.distinct,
                    values: sub.values,
                    limit: sub.limit,
                    offset: sub.offset,
                });
            }
            return self.fail(format!(
                "unexpected {} after the top-level directive",
                self.tok_desc()
            ));
        }

        // Body form: the fixed clause list; its `from` is the source.
        let mut body = self.parse_body(true)?;
        if !self.at(TokType::Eof) {
            return self.fail(format!("unexpected {} after the query", self.tok_desc()));
        }
        if body.froms.is_empty() {
            return self.fail(
                "a query must name its source with `from <collection>` (or be `<collection> <consumer> { … }`)",
            );
        }
        let source = body.froms.remove(0);
        Ok(Query {
            source,
            from: body.froms,
            r#where: body.r#where,
            select: body.select,
            order_by: body.order_by,
            consumer: Consumer::Collect,
            follow: body.follow,
            distinct: body.distinct,
            values: body.values,
            limit: body.limit,
            offset: body.offset,
        })
    }

    fn tok_desc(&self) -> String {
        let t = self.peek();
        if t.kind == TokType::Eof {
            "end of query".to_string()
        } else if t.value.is_empty() {
            format!("'{}'", t.kind.as_str())
        } else {
            format!("'{}'", t.value)
        }
    }

    // ---- clause body (shared by top level and consumer blocks) ----------------
    // An ordered state machine over the fixed clause sequence: `stage` is the
    // last clause parsed (in CLAUSE_ORDER), so a clause that sorts lower is out
    // of order and an equal one is a duplicate. The only keyword-less clause is
    // a leading projection (while `stage` is still `None`).
    fn parse_body(&mut self, order_by_allowed: bool) -> Result<BodyClauses> {
        let mut body = BodyClauses::default();
        let mut stage: Option<Clause> = None;

        while !self.at(TokType::Eof) && !self.at(TokType::RBrace) {
            if self.at_word(TokType::Kw, "select") {
                self.enter(&mut stage, Clause::Select)?;
                self.next();
                if self.at_word(TokType::Ident, "distinct") {
                    self.next();
                    body.distinct = true;
                }
                let (items, values) = self.parse_projection()?;
                body.select = items;
                body.values = values;
                continue;
            }
            if self.at_word(TokType::Kw, "from") {
                self.enter(&mut stage, Clause::From)?;
                self.next();
                let e = self.parse_value_expr()?;
                body.froms.push(e);
                continue;
            }
            if self.at_word(TokType::Kw, "where") {
                self.enter(&mut stage, Clause::Where)?;
                self.next();
                body.r#where = Some(self.parse_where()?);
                continue;
            }
            if self.at_follow() {
                self.enter(&mut stage, Clause::Follow)?;
                body.follow = Some(self.parse_follow()?);
                continue;
            }
            if order_by_allowed && self.at_order_by() {
                self.enter(&mut stage, Clause::OrderBy)?;
                self.next(); // `order`
                self.next(); // `by`
                body.order_by = Some(self.parse_order_specs()?);
                continue;
            }
            if self.at_bound() {
                let is_limit = self.peek().value == "limit";
                self.enter(
                    &mut stage,
                    if is_limit {
                        Clause::Limit
                    } else {
                        Clause::Offset
                    },
                )?;
                self.next();
                let e = self.parse_postfix()?;
                if is_limit {
                    body.limit = Some(e);
                } else {
                    body.offset = Some(e);
                }
                continue;
            }
            // A keyword-less run. Before any clause it is the projection (`select` is
            // the one keyword that may be dropped, and only in first position); after
            // any clause it is an error — a predicate is never implicit.
            if stage.is_none()
                && (self.at(TokType::Ident)
                    || self.at(TokType::Binding)
                    || self.at(TokType::Caret)
                    || self.can_start_value())
            {
                self.enter(&mut stage, Clause::Select)?;
                let (items, values) = self.parse_projection()?;
                body.select = items;
                body.values = values;
                continue;
            }
            return self.fail_unexpected_in_body(stage, order_by_allowed);
        }
        body.r#where = self.inline_aliases(&body.select, body.r#where.take())?;
        Ok(body)
    }

    fn enter(&self, stage: &mut Option<Clause>, clause: Clause) -> Result<()> {
        if *stage == Some(clause) {
            return self.fail(format!("duplicate `{}` clause", clause.as_str()));
        }
        if stage.is_some_and(|last| clause < last) {
            let last = stage.expect("checked above");
            return self.fail(format!(
                "`{}` must come before `{}` — OQX clause order is {}",
                clause.as_str(),
                last.as_str(),
                clause_order_sentence()
            ));
        }
        *stage = Some(clause);
        Ok(())
    }

    // The error for a token that starts no clause, phrased for the mistake it most
    // likely is: a bare run right after `from` (the old implicit `where`, or a
    // consumer word where a whole-query directive was meant), or a stray token.
    fn fail_unexpected_in_body<T>(
        &self,
        stage: Option<Clause>,
        order_by_allowed: bool,
    ) -> Result<T> {
        let t = self.peek();
        let first_remaining = stage.map_or(0, |s| s as usize + 1);
        let remaining = CLAUSE_ORDER[first_remaining..]
            .iter()
            .filter(|c| order_by_allowed || **c != Clause::OrderBy)
            .map(|c| c.as_str())
            .collect::<Vec<_>>()
            .join("/");
        let consumer_word = t.kind == TokType::Ident && CONSUMERS.contains(&t.value.as_str());
        let v = &t.value;
        match stage {
            Some(Clause::From) if consumer_word => self.fail(format!(
                "unexpected `{v}` after `from` — a whole-query consumer is written `<collection> {v} {{ … }}`; to project a field named {v} write `select {v} from …`; a predicate needs `where`"
            )),
            Some(Clause::From) => self.fail(format!(
                "unexpected {} after `from` — a predicate needs `where` (there is no implicit where), and a projection goes before `from` (`select … from …`); expected {remaining}",
                self.tok_desc()
            )),
            // `{ rel exists { … } }` / `{ rel count { … } >= 2 }`: the leading `rel` was
            // read as the projection, so the consumer word is where the mistake shows.
            Some(Clause::Select) if consumer_word => self.fail(format!(
                "unexpected `{v}` after a projection — a consumer test is a predicate: write `where <relation> {v} {{ … }}` — a predicate is never implicit; a nested block in a projection needs a name (`name: <relation> collect {{ … }}`)"
            )),
            None => self.fail(format!(
                "unexpected {} — expected a projection or {remaining}",
                self.tok_desc()
            )),
            Some(last) => self.fail(format!(
                "unexpected {} after `{}` — expected {remaining}",
                self.tok_desc(),
                last.as_str()
            )),
        }
    }

    // `limit <n>` / `offset <n>` — the word must be followed by something that can
    // be a bound (a number, a binding, or an outer reference), so a field that
    // happens to be called `limit` still projects/filters as a bare name.
    fn at_bound(&self) -> bool {
        let t = self.peek();
        if t.kind != TokType::Ident || (t.value != "limit" && t.value != "offset") {
            return false;
        }
        self.peek_at(1).is_some_and(|nx| {
            matches!(nx.kind, TokType::Number | TokType::Binding | TokType::Caret)
        })
    }

    // ---- alias inlining -------------------------------------------------------
    // `where` may reference the same body's `select` aliases. This is a
    // compile-time rewrite, not a second execution pass: every bare identifier in
    // the where tree that names an alias is replaced by that alias's expression,
    // so the engine and any pushdown planner see an ordinary where over row
    // fields. Rules:
    //   • an alias shadows a same-named row field inside `where`;
    //   • an alias's own name inside its own expression is the row field
    //     (`name: name.upper()` is not recursive), but a chain of aliases that
    //     comes back to one being resolved (`a: b, b: a`) is a cycle → error;
    //   • an alias whose value is a `collect`/`first`/`single { … }` block may
    //     stand alone as a where leaf (a collection in predicate position means
    //     non-empty) but not appear inside an expression;
    //   • nested blocks (consumer bodies, follow blocks) are their own scopes and
    //     are not rewritten against this body's select — each body rewrites
    //     against its own.
    fn inline_aliases(
        &self,
        select: &[SelectItem],
        r#where: Option<Where>,
    ) -> Result<Option<Where>> {
        let Some(w) = r#where else { return Ok(None) };
        if select.is_empty() {
            return Ok(Some(w));
        }
        let mut aliases: HashMap<&str, &SelectItem> = HashMap::new();
        for it in select {
            match it {
                SelectItem::Collect { name, .. } => {
                    aliases.insert(name, it);
                }
                SelectItem::Field { name, lift: 0, .. } if !name.is_empty() => {
                    aliases.insert(name, it);
                }
                SelectItem::Field { .. } => {}
            }
        }
        if aliases.is_empty() {
            return Ok(Some(w));
        }
        let mut resolving: Vec<String> = Vec::new();
        self.walk_where(&aliases, &mut resolving, w).map(Some)
    }

    fn walk_where(
        &self,
        aliases: &HashMap<&str, &SelectItem>,
        resolving: &mut Vec<String>,
        w: Where,
    ) -> Result<Where> {
        Ok(match w {
            Where::And { parts } => Where::And {
                parts: parts
                    .into_iter()
                    .map(|p| self.walk_where(aliases, resolving, p))
                    .collect::<Result<_>>()?,
            },
            Where::Or { parts } => Where::Or {
                parts: parts
                    .into_iter()
                    .map(|p| self.walk_where(aliases, resolving, p))
                    .collect::<Result<_>>()?,
            },
            Where::Not { expr } => Where::Not {
                expr: Box::new(self.walk_where(aliases, resolving, *expr)?),
            },
            Where::Scalar { expr } => {
                if let Expr::Ident { name } = &expr {
                    if let Some(SelectItem::Collect { op, .. }) = aliases.get(name.as_str()) {
                        // a collection in predicate position: non-empty
                        return Ok(Where::Op(op.clone()));
                    }
                }
                Where::Scalar {
                    expr: self.subst(aliases, resolving, expr)?,
                }
            }
            Where::Op(op) => {
                // the receiver is read in this scope; the block is its own scope
                let mut op = *op;
                op.receiver = self.subst(aliases, resolving, op.receiver)?;
                Where::Op(Box::new(op))
            }
        })
    }

    fn subst(
        &self,
        aliases: &HashMap<&str, &SelectItem>,
        resolving: &mut Vec<String>,
        e: Expr,
    ) -> Result<Expr> {
        let subst_box =
            |this: &Self, resolving: &mut Vec<String>, b: Box<Expr>| -> Result<Box<Expr>> {
                this.subst(aliases, resolving, *b).map(Box::new)
            };
        Ok(match e {
            Expr::Ident { name } => {
                let Some(a) = aliases.get(name.as_str()) else {
                    return Ok(Expr::Ident { name });
                };
                if resolving.last() == Some(&name) {
                    // its own name inside its own expression: the row field
                    return Ok(Expr::Ident { name });
                }
                if let Some(i) = resolving.iter().position(|r| *r == name) {
                    let cycle = resolving[i..]
                        .iter()
                        .map(String::as_str)
                        .chain(std::iter::once(name.as_str()))
                        .collect::<Vec<_>>()
                        .join(" → ");
                    return self.fail(format!(
                        "select aliases form a cycle: {cycle} — an alias used in `where` cannot depend on itself"
                    ));
                }
                match a {
                    SelectItem::Collect { op, .. } => {
                        return self.fail(format!(
                            "select alias '{name}' is a {} {{ … }} block — in `where` it can only stand alone as a non-empty test, not inside an expression",
                            op.op.as_str()
                        ));
                    }
                    SelectItem::Field { expr, .. } => {
                        resolving.push(name);
                        let out = self.subst(aliases, resolving, expr.clone())?;
                        resolving.pop();
                        out
                    }
                }
            }
            Expr::Member { recv, name } => Expr::Member {
                recv: subst_box(self, resolving, recv)?,
                name,
            },
            Expr::Index { recv, index } => Expr::Index {
                recv: subst_box(self, resolving, recv)?,
                index: subst_box(self, resolving, index)?,
            },
            Expr::Call { recv, name, args } => Expr::Call {
                recv: match recv {
                    Some(r) => Some(subst_box(self, resolving, r)?),
                    None => None,
                },
                name,
                args: args
                    .into_iter()
                    .map(|a| self.subst(aliases, resolving, a))
                    .collect::<Result<_>>()?,
            },
            Expr::Unary { op, expr } => Expr::Unary {
                op,
                expr: subst_box(self, resolving, expr)?,
            },
            Expr::Binary { op, left, right } => Expr::Binary {
                op,
                left: subst_box(self, resolving, left)?,
                right: subst_box(self, resolving, right)?,
            },
            Expr::Logical { op, left, right } => Expr::Logical {
                op,
                left: subst_box(self, resolving, left)?,
                right: subst_box(self, resolving, right)?,
            },
            Expr::In { left, right } => Expr::In {
                left: subst_box(self, resolving, left)?,
                right: subst_box(self, resolving, right)?,
            },
            Expr::Range {
                lo,
                hi,
                exclusive_end,
            } => Expr::Range {
                lo: match lo {
                    Some(b) => Some(subst_box(self, resolving, b)?),
                    None => None,
                },
                hi: match hi {
                    Some(b) => Some(subst_box(self, resolving, b)?),
                    None => None,
                },
                exclusive_end,
            },
            // lit, binding, outer (`^name` reads an enclosing row, never an alias)
            other @ (Expr::Lit(_) | Expr::Binding { .. } | Expr::Outer { .. }) => other,
        })
    }

    fn at_order_by(&self) -> bool {
        self.at_word(TokType::Ident, "order")
            && self
                .peek_at(1)
                .is_some_and(|nx| nx.kind == TokType::Ident && nx.value == "by")
    }

    fn at_follow(&self) -> bool {
        self.at_word(TokType::Ident, "follow")
            && self
                .peek_at(1)
                .is_some_and(|nx| matches!(nx.kind, TokType::Ident | TokType::Binding))
    }

    // ---- follow ---------------------------------------------------------------
    fn parse_follow(&mut self) -> Result<Follow> {
        self.next(); // `follow`
        let mut distinct = false;
        if self.at_word(TokType::Ident, "distinct")
            && self
                .peek_at(1)
                .is_some_and(|nx| matches!(nx.kind, TokType::Ident | TokType::Binding))
        {
            self.next();
            distinct = true;
        }
        let receiver = self.parse_receiver()?;
        let mut follow = Follow {
            receiver,
            distinct,
            r#where: None,
            frontier: None,
            depth: None,
            by: None,
        };
        if !self.at(TokType::LBrace) {
            return Ok(follow);
        }
        self.next(); // '{'
        while !self.at(TokType::Eof) && !self.at(TokType::RBrace) {
            if self.at_word(TokType::Kw, "where") {
                if follow.r#where.is_some() {
                    return self.fail("duplicate `where` in follow clause");
                }
                self.next();
                follow.r#where = Some(self.parse_value_expr()?);
            } else if self.at_word(TokType::Ident, "frontier") {
                if follow.frontier.is_some() {
                    return self.fail("duplicate `frontier` in follow clause");
                }
                self.next();
                follow.frontier = Some(self.parse_value_expr()?);
            } else if self.at_word(TokType::Ident, "by") {
                if follow.by.is_some() {
                    return self.fail("duplicate `by` in follow clause");
                }
                self.next();
                follow.by = Some(self.parse_value_expr()?);
            } else if self.at_word(TokType::Ident, "depth") {
                if follow.depth.is_some() {
                    return self.fail("duplicate `depth` in follow clause");
                }
                self.next();
                if !self.at(TokType::Number) {
                    return self.fail("expected an integer after `depth`");
                }
                let v = number_value(&self.next().value);
                if !is_integer(v) || !(1.0..=8.0).contains(&v) {
                    return self.fail("follow depth must be an integer between 1 and 8");
                }
                follow.depth = Some(v as u32);
            } else {
                return self.fail(format!(
                    "unexpected {} in follow block — expected where/frontier/depth/by",
                    self.tok_desc()
                ));
            }
        }
        if !self.at(TokType::RBrace) {
            return self.fail("expected '}' to close the follow block");
        }
        self.next();
        Ok(follow)
    }

    // A receiver/source: a `${…}` binding, or a dotted identifier navigation chain
    // whose head may be an outer reference (`^rel`, `^^root.rel`) — since a bare
    // name is the current row's own property, an enclosing row's relation or a
    // named root is only reachable as a receiver through `^` — or a free-function
    // call (`entries(prefs)`), so a computed collection can be consumed directly.
    fn parse_receiver(&mut self) -> Result<Expr> {
        if self.at(TokType::Binding) {
            return Ok(Expr::Binding {
                index: binding_index(&self.next()),
            });
        }
        let levels = self.parse_carets();
        if !self.at(TokType::Ident) {
            return self.fail("expected a collection navigation (a property/relation name)");
        }
        let head = self.next();
        Ok(self.parse_nav_from(head, levels)?.0)
    }

    // Consume a run of `^` and return its length (0 when there is none).
    fn parse_carets(&mut self) -> usize {
        let mut levels = 0;
        while self.at(TokType::Caret) {
            self.next();
            levels += 1;
        }
        levels
    }

    // A dotted navigation chain from `head`; `levels` > 0 makes the head an outer
    // reference read exactly that many scopes out. A bare head followed by `(` is
    // a free-function call (`entries(x)`), which may then be navigated further.
    // Returns the expression and the last segment's name.
    fn parse_nav_from(&mut self, head: Token, levels: usize) -> Result<(Expr, String)> {
        let mut expr = if levels > 0 {
            Expr::Outer {
                levels,
                name: head.value.clone(),
            }
        } else {
            Expr::Ident {
                name: head.value.clone(),
            }
        };
        let mut name = head.value;
        if levels == 0 && self.at(TokType::LParen) {
            expr = Expr::Call {
                recv: None,
                name: name.clone(),
                args: self.parse_args()?,
            };
        }
        while self.at(TokType::Dot) {
            self.next();
            if !self.at(TokType::Ident) {
                return self.fail("expected an identifier after '.' in a navigation");
            }
            name = self.next().value;
            expr = Expr::Member {
                recv: Box::new(expr),
                name: name.clone(),
            };
        }
        Ok((expr, name))
    }

    // ---- select ---------------------------------------------------------------
    // A projection list, optionally followed by the `values` mode word. Under
    // `values` the list must be exactly one item, which need not be named: the
    // row's result IS that value (no `{ name: value }` record), so a name would be
    // meaningless. Without `values`, every item needs a key — a bare/dotted
    // navigation supplies its own (the last segment); any other expression must be
    // aliased (`name: expr`).
    fn parse_projection(&mut self) -> Result<(Vec<SelectItem>, bool)> {
        let mut items = vec![self.parse_select_item()?];
        while self.at(TokType::Comma) {
            self.next();
            items.push(self.parse_select_item()?);
        }
        let mut values = false;
        if self.at_word(TokType::Ident, "values") {
            self.next();
            values = true;
            if items.len() != 1 {
                return self.fail(format!(
                    "`values` projects exactly one expression (got {})",
                    items.len()
                ));
            }
            if matches!(&items[0], SelectItem::Field { lift, .. } if *lift > 0) {
                return self.fail("a lift (^name: …) cannot be combined with `values`");
            }
        } else {
            for it in &items {
                if it.name().is_empty() {
                    return self.fail(
                        "a leading expression is a projection (select): an item that is not a plain name needs an alias (`name: expr`) or `values`; to filter by it write `where …` — a predicate is never implicit",
                    );
                }
            }
        }
        Ok((items, values))
    }

    fn parse_select_item(&mut self) -> Result<SelectItem> {
        // Leading `^`s mark a lift; the count is how many scopes out it binds.
        let lift = self.parse_carets();
        if self.at(TokType::Ident) && self.peek_at(1).is_some_and(|t| t.kind == TokType::Colon) {
            let name = self.next().value;
            self.next(); // ':'
            if let Some(op) = self.try_op()? {
                if !matches!(
                    op.op,
                    Consumer::Collect | Consumer::First | Consumer::Single
                ) {
                    return self.fail(format!(
                        "projection '{name}' must use collect/first/single, not {} (exists/none/count are where-position tests)",
                        op.op.as_str()
                    ));
                }
                if lift > 0 {
                    return self.fail(format!(
                        "a lift (^{name}) value must be a scalar expression, not {} {{ … }}",
                        op.op.as_str()
                    ));
                }
                return Ok(SelectItem::Collect {
                    name,
                    op: Box::new(op),
                });
            }
            let expr = self.parse_value_expr()?;
            return Ok(SelectItem::Field { name, expr, lift });
        }
        if !self.at(TokType::Ident) && !self.can_start_value() {
            return self.fail("expected a projection name");
        }
        // Unaliased item: a bare/dotted navigation keys by its last segment; any
        // other expression is unnamed ("") — legal only under `values` (checked by
        // parse_projection, which sees the whole list).
        let expr = self.parse_value_expr()?;
        let name = nav_key(&expr).unwrap_or("").to_string();
        Ok(SelectItem::Field { name, expr, lift })
    }

    // ---- order by -------------------------------------------------------------
    fn parse_order_specs(&mut self) -> Result<Vec<OrderSpec>> {
        let mut specs = vec![self.parse_order_spec()?];
        while self.at(TokType::Comma) {
            self.next();
            specs.push(self.parse_order_spec()?);
        }
        Ok(specs)
    }

    fn parse_order_spec(&mut self) -> Result<OrderSpec> {
        let expr = self.parse_value_expr()?;
        let mut desc = false;
        if self.at_word(TokType::Ident, "asc") {
            self.next();
        } else if self.at_word(TokType::Ident, "desc") {
            self.next();
            desc = true;
        }
        Ok(OrderSpec { expr, desc })
    }

    // ---- where boolean tree: or → and → not → primary -------------------------
    fn parse_where(&mut self) -> Result<Where> {
        self.parse_where_or()
    }

    fn parse_where_or(&mut self) -> Result<Where> {
        let left = self.parse_where_and()?;
        if !self.at_op("||") {
            return Ok(left);
        }
        let mut parts = vec![left];
        while self.at_op("||") {
            self.next();
            parts.push(self.parse_where_and()?);
        }
        Ok(Where::Or { parts })
    }

    fn parse_where_and(&mut self) -> Result<Where> {
        let left = self.parse_where_not()?;
        if !self.at_op("&&") {
            return Ok(left);
        }
        let mut parts = vec![left];
        while self.at_op("&&") {
            self.next();
            parts.push(self.parse_where_not()?);
        }
        Ok(Where::And { parts })
    }

    fn parse_where_not(&mut self) -> Result<Where> {
        if self.at_op("!") {
            self.next();
            return Ok(Where::Not {
                expr: Box::new(self.parse_where_not()?),
            });
        }
        self.parse_where_primary()
    }

    fn parse_where_primary(&mut self) -> Result<Where> {
        if self.at(TokType::LParen) {
            self.next();
            let e = self.parse_where()?;
            if !self.at(TokType::RParen) {
                return self.fail("expected ')' to close a grouped where expression");
            }
            self.next();
            return Ok(e);
        }
        if let Some(op) = self.try_op()? {
            return Ok(Where::Op(Box::new(self.finish_where_op(op)?)));
        }
        let expr = self.parse_cmp()?;
        Ok(Where::Scalar { expr })
    }

    // Validate a consumer op used in where position and attach any `count { … } <op> N`.
    fn finish_where_op(&mut self, mut op: OpNode) -> Result<OpNode> {
        if matches!(op.op, Consumer::First | Consumer::Single) {
            return self.fail(format!(
                "{} {{ … }} is a select-position lookup; in where use exists {{ … }} / none {{ … }} or count {{ … }} <op> N",
                op.op.as_str()
            ));
        }
        if op.op == Consumer::Collect {
            let all_lift = !op.sub.select.is_empty()
                && op
                    .sub
                    .select
                    .iter()
                    .all(|s| matches!(s, SelectItem::Field { lift, .. } if *lift > 0));
            if !all_lift {
                return self.fail(
                    "collect { … } in where must project only ^lift values (else use exists/count)",
                );
            }
        }
        if self.peek().kind == TokType::Op && RELOPS.contains(&self.peek().value.as_str()) {
            if op.op != Consumer::Count {
                return self.fail(format!(
                    "only count {{ … }} is comparable; '{} {{ … }} <op> N' is not valid",
                    op.op.as_str()
                ));
            }
            let relop = self.next().value;
            if !self.at(TokType::Number) {
                return self.fail(format!("expected an integer after 'count {{ … }} {relop}'"));
            }
            let v = number_value(&self.next().value);
            if !is_integer(v) {
                return self.fail("count comparison takes an integer");
            }
            let op_enum = RelOp::from_word(&relop).expect("RELOPS membership was checked");
            op.count_cmp = Some(CountCmp {
                op: op_enum,
                value: v,
            });
        }
        Ok(op)
    }

    // Detect + parse a postfix consumer op `<receiver> <consumer> { <sub> }`.
    // Returns None (rewinding) when the lookahead is not a consumer op.
    fn try_op(&mut self) -> Result<Option<OpNode>> {
        let start = self.pos;
        let receiver = if self.at(TokType::Binding) {
            Expr::Binding {
                index: binding_index(&self.next()),
            }
        } else if self.at(TokType::Ident) || self.at(TokType::Caret) {
            let levels = self.parse_carets();
            if !self.at(TokType::Ident) {
                self.pos = start;
                return Ok(None);
            }
            let head = self.next();
            self.parse_nav_from(head, levels)?.0
        } else {
            return Ok(None);
        };

        if self.at(TokType::Ident) && CONSUMERS.contains(&self.peek().value.as_str()) {
            let after = self.peek_at(1);
            // `<op> { … }` or `<op> distinct { … }`.
            let op_then_brace = after.is_some_and(|a| a.kind == TokType::LBrace);
            let op_distinct_brace = after
                .is_some_and(|a| a.kind == TokType::Ident && a.value == "distinct")
                && self.peek_at(2).is_some_and(|a| a.kind == TokType::LBrace);
            if op_then_brace || op_distinct_brace {
                let op = Consumer::from_word(&self.next().value)
                    .expect("CONSUMERS membership was checked");
                let mut distinct = false;
                if self.at_word(TokType::Ident, "distinct") {
                    self.next();
                    distinct = true;
                }
                self.next(); // '{'
                let (sub, body_distinct) = self.parse_subquery()?;
                if !self.at(TokType::RBrace) {
                    return self.fail(format!(
                        "expected '}}' to close the {} {{ … }} block",
                        op.as_str()
                    ));
                }
                self.next();
                return Ok(Some(OpNode {
                    receiver,
                    op,
                    sub,
                    count_cmp: None,
                    distinct: distinct || body_distinct,
                }));
            }
        }
        self.pos = start;
        Ok(None)
    }

    fn parse_subquery(&mut self) -> Result<(Subquery, bool)> {
        let body = self.parse_body(true)?;
        Ok((
            Subquery {
                from: body.froms,
                r#where: body.r#where,
                select: body.select,
                order_by: body.order_by,
                follow: body.follow,
                values: body.values,
                limit: body.limit,
                offset: body.offset,
            },
            body.distinct,
        ))
    }

    // ---- expression Pratt parser ----------------------------------------------
    // Value position (select/order/follow/source): full boolean+arithmetic.
    fn parse_value_expr(&mut self) -> Result<Expr> {
        self.parse_or()
    }

    fn parse_or(&mut self) -> Result<Expr> {
        let mut left = self.parse_and()?;
        while self.at_op("||") {
            self.next();
            let right = self.parse_and()?;
            left = Expr::Logical {
                op: LogicalOp::Or,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr> {
        let mut left = self.parse_cmp()?;
        while self.at_op("&&") {
            self.next();
            let right = self.parse_cmp()?;
            left = Expr::Logical {
                op: LogicalOp::And,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    // Comparison / membership (also the entry point for a where scalar leaf, so a
    // where leaf never swallows the where-tree's && / ||).
    fn parse_cmp(&mut self) -> Result<Expr> {
        let left = self.parse_range()?;
        if self.peek().kind == TokType::Op && CMP_OPS.contains(&self.peek().value.as_str()) {
            let op =
                BinaryOp::from_word(&self.next().value).expect("CMP_OPS membership was checked");
            let right = self.parse_range()?;
            return Ok(Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            });
        }
        if self.at_word(TokType::Ident, "in") {
            self.next();
            let right = self.parse_range()?;
            return Ok(Expr::In {
                left: Box::new(left),
                right: Box::new(right),
            });
        }
        Ok(left)
    }

    // Range literal: `lo..hi` / `lo...hi` and the open-ended forms `..hi`, `lo..`.
    // Binds looser than arithmetic (so `1+1..2*3` is the range 2..6) but tighter
    // than comparison / `in` (so `n in 1..5` reads as `n in (1..5)`). A leading
    // `..`/`...` opens the low end; a trailing `..`/`...` with no following value
    // opens the high end.
    fn parse_range(&mut self) -> Result<Expr> {
        if self.at(TokType::Range) {
            let exclusive_end = self.next().value == "...";
            let hi = self.parse_add()?;
            return Ok(Expr::Range {
                lo: None,
                hi: Some(Box::new(hi)),
                exclusive_end,
            });
        }
        let lo = self.parse_add()?;
        if self.at(TokType::Range) {
            let exclusive_end = self.next().value == "...";
            let hi = if self.can_start_value() {
                Some(Box::new(self.parse_add()?))
            } else {
                None
            };
            return Ok(Expr::Range {
                lo: Some(Box::new(lo)),
                hi,
                exclusive_end,
            });
        }
        Ok(lo)
    }

    // Whether the current token can begin a value expression — used to tell an
    // open-ended range (`5..` followed by a clause boundary) from a bounded one.
    // Clause-continuation words (`order`, `by`, `follow`, `asc/desc`, `distinct`,
    // consumers, …) are lexed as bare idents, so they must NOT count as a value
    // start, or `where age in 18.. order by name` would read `order` as the bound.
    fn can_start_value(&self) -> bool {
        let t = self.peek();
        match t.kind {
            TokType::Ident => !CLAUSE_WORDS.contains(&t.value.as_str()),
            TokType::Number
            | TokType::Str
            | TokType::Binding
            | TokType::LParen
            | TokType::Caret => true,
            TokType::Op => t.value == "-" || t.value == "!",
            _ => false,
        }
    }

    fn parse_add(&mut self) -> Result<Expr> {
        let mut left = self.parse_mul()?;
        while self.peek().kind == TokType::Op && ADD_OPS.contains(&self.peek().value.as_str()) {
            let op =
                BinaryOp::from_word(&self.next().value).expect("ADD_OPS membership was checked");
            let right = self.parse_mul()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_mul(&mut self) -> Result<Expr> {
        let mut left = self.parse_unary()?;
        while self.peek().kind == TokType::Op && MUL_OPS.contains(&self.peek().value.as_str()) {
            let op =
                BinaryOp::from_word(&self.next().value).expect("MUL_OPS membership was checked");
            let right = self.parse_unary()?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Expr> {
        if self.at_op("!") {
            self.next();
            return Ok(Expr::Unary {
                op: UnaryOp::Not,
                expr: Box::new(self.parse_unary()?),
            });
        }
        if self.at_op("-") {
            self.next();
            return Ok(Expr::Unary {
                op: UnaryOp::Neg,
                expr: Box::new(self.parse_unary()?),
            });
        }
        self.parse_postfix()
    }

    fn parse_postfix(&mut self) -> Result<Expr> {
        let mut expr = self.parse_primary()?;
        loop {
            if self.at(TokType::Dot) {
                self.next();
                if !self.at(TokType::Ident) {
                    return self.fail("expected a property name after '.'");
                }
                let name = self.next().value;
                if self.at(TokType::LParen) {
                    let args = self.parse_args()?;
                    expr = Expr::Call {
                        recv: Some(Box::new(expr)),
                        name,
                        args,
                    };
                } else {
                    expr = Expr::Member {
                        recv: Box::new(expr),
                        name,
                    };
                }
            } else if self.at(TokType::LParen) && matches!(expr, Expr::Ident { .. }) {
                // free function call: name(args)
                let Expr::Ident { name } = expr else {
                    unreachable!()
                };
                let args = self.parse_args()?;
                expr = Expr::Call {
                    recv: None,
                    name,
                    args,
                };
            } else {
                // `{` is a consumer block boundary — not part of a value expression;
                // anything else ends the postfix chain too.
                break;
            }
        }
        Ok(expr)
    }

    fn parse_args(&mut self) -> Result<Vec<Expr>> {
        self.next(); // '('
        let mut args = Vec::new();
        if !self.at(TokType::RParen) {
            args.push(self.parse_value_expr()?);
            while self.at(TokType::Comma) {
                self.next();
                args.push(self.parse_value_expr()?);
            }
        }
        if !self.at(TokType::RParen) {
            return self.fail("expected ')' to close call arguments");
        }
        self.next();
        Ok(args)
    }

    fn parse_primary(&mut self) -> Result<Expr> {
        let t = self.peek().clone();
        match t.kind {
            // `^name` / `^^name` — an outer reference reading `levels` scopes out. (As a
            // select-item head `^name:` is a lift, handled in parse_select_item; here, in
            // expression position, `^` reads an enclosing row's field even when the
            // current row shadows the name.)
            TokType::Caret => {
                let levels = self.parse_carets();
                if !self.at(TokType::Ident) {
                    return self.fail("expected an identifier after '^' (an outer reference)");
                }
                Ok(Expr::Outer {
                    levels,
                    name: self.next().value,
                })
            }
            TokType::Number => {
                self.next();
                Ok(Expr::Lit(Value::Number(number_value(&t.value))))
            }
            TokType::Str => {
                self.next();
                Ok(Expr::Lit(Value::Str(t.value)))
            }
            TokType::Binding => {
                self.next();
                Ok(Expr::Binding {
                    index: binding_index(&t),
                })
            }
            TokType::LParen => {
                self.next();
                let e = self.parse_value_expr()?;
                if !self.at(TokType::RParen) {
                    return self.fail("expected ')'");
                }
                self.next();
                Ok(e)
            }
            TokType::Ident => {
                self.next();
                Ok(match t.value.as_str() {
                    "true" => Expr::Lit(Value::Bool(true)),
                    "false" => Expr::Lit(Value::Bool(false)),
                    "null" => Expr::Lit(Value::Null),
                    _ => Expr::Ident { name: t.value },
                })
            }
            _ => self.fail(format!("unexpected {} — expected a value", self.tok_desc())),
        }
    }
}

fn binding_index(t: &Token) -> usize {
    t.index.expect("a binding token always carries its index")
}

// The default key of an unaliased projection item: the last segment of a bare /
// dotted / outer navigation (`name`, `meta.slug` → "slug", `^name`), else None.
fn nav_key(e: &Expr) -> Option<&str> {
    match e {
        Expr::Ident { name } | Expr::Outer { name, .. } | Expr::Member { name, .. } => Some(name),
        _ => None,
    }
}
