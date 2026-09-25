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
//! Principle of least surprise, applied to the grammar: a rule a careful user
//! would not predict is a bug. Hence `!` binds tighter than comparison in every
//! position (`!a == b` is `(!a) == b`, as in C); parentheses in `where` group a
//! predicate OR a scalar, decided by what follows the `)`; a range's open end
//! stops at a clause word; duplicate projection names, a `follow distinct` with
//! no relation, a lift outside a where-position `collect`, and a top-level
//! `limit ^n` (there is no enclosing scope) are parse errors rather than silent
//! misreads.
//!
//! Error messages are the TS messages verbatim (the conformance fixtures and
//! the reference tests assert on fragments of them).

use std::collections::{HashMap, HashSet};

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
// `true`/`false`/`null` are literals in every position, so they can never name a
// receiver (`true exists { … }`, `follow null`).
const LITERAL_WORDS: [&str; 3] = ["true", "false", "null"];

/// Where a clause body sits, for error messages and position-dependent rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BodyCtx {
    /// The top-level body form (a stray token there is "after the query").
    Top,
    /// The block of a consumer directive.
    Block {
        /// The consumer of the enclosing block.
        op: Consumer,
        /// Whether `^name: expr` lift items are legal: only in a where-position
        /// `collect { … }`.
        lifts_allowed: bool,
    },
}

impl BodyCtx {
    fn lifts_allowed(self) -> bool {
        matches!(
            self,
            BodyCtx::Block {
                lifts_allowed: true,
                ..
            }
        )
    }
}

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

/// JavaScript `Number(text)` for a number token. The lexer rejects every
/// malformed numeral (`1.`, `1e`, `.5`), so the text is always a valid float;
/// the fallback is only defensive.
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
        if let Some(directive) = self.try_op(false)? {
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
        let mut body = self.parse_body(BodyCtx::Top)?;
        if !self.at(TokType::Eof) {
            return self.fail(format!(
                "unexpected {} after the query — nothing may follow the last clause",
                self.tok_desc()
            ));
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
    fn parse_body(&mut self, ctx: BodyCtx) -> Result<BodyClauses> {
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
                let (items, values) = self.parse_projection(ctx)?;
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
            if self.at_order_by() {
                self.enter(&mut stage, Clause::OrderBy)?;
                self.next(); // `order`
                self.next(); // `by`
                body.order_by = Some(self.parse_order_specs()?);
                continue;
            }
            if self.at_bound() {
                let is_limit = self.peek().value == "limit";
                let clause = if is_limit {
                    Clause::Limit
                } else {
                    Clause::Offset
                };
                self.enter(&mut stage, clause)?;
                self.next();
                // A top-level bound is evaluated at the root scope itself, so `^n` there
                // has nothing to read: say so now instead of an "absent" error at eval.
                if ctx == BodyCtx::Top && self.at(TokType::Caret) {
                    return self.fail(format!(
                        "`{} ^…` at the top level has no enclosing scope — a top-level bound is a number literal or a binding; inside a block `^name` reads the enclosing row",
                        clause.as_str()
                    ));
                }
                let e = self.parse_postfix(None)?;
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
                let (items, values) = self.parse_projection(ctx)?;
                body.select = items;
                body.values = values;
                continue;
            }
            return self.fail_unexpected_in_body(stage, ctx);
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
    fn fail_unexpected_in_body<T>(&self, stage: Option<Clause>, ctx: BodyCtx) -> Result<T> {
        let t = self.peek();
        let first_remaining = stage.map_or(0, |s| s as usize + 1);
        let remaining = CLAUSE_ORDER[first_remaining..]
            .iter()
            .map(|c| c.as_str())
            .collect::<Vec<_>>()
            .join("/");
        let consumer_word = t.kind == TokType::Ident && CONSUMERS.contains(&t.value.as_str());
        let v = &t.value;
        if let Some(last) = stage {
            let last = last.as_str();
            // Punctuation, an operator, or a literal after a complete clause is a stray
            // token, not a misplaced predicate: name where the body ends. (A comma keeps
            // the projection hint below — `name from r, id` almost always meant a
            // projection.)
            let is_word = matches!(
                t.kind,
                TokType::Ident | TokType::Kw | TokType::Binding | TokType::Caret
            );
            if !is_word && t.kind != TokType::Comma {
                return match ctx {
                    BodyCtx::Top => self.fail(format!(
                        "unexpected {} after the query — nothing may follow the last clause (expected {remaining} or the end of the query)",
                        self.tok_desc()
                    )),
                    BodyCtx::Block { op, .. } => self.fail(format!(
                        "unexpected {} in the {} {{ … }} block — expected {remaining} or '}}' to close the block",
                        self.tok_desc(),
                        op.as_str()
                    )),
                };
            }
            // Clause words that did not form a clause: say what the clause needs.
            if t.kind == TokType::Ident {
                match v.as_str() {
                    "order" => {
                        return self.fail(format!(
                            "unexpected 'order' after `{last}` — an ordering is written `order by <expr> [asc|desc]`"
                        ));
                    }
                    "follow" => {
                        return self.fail(format!(
                            "unexpected 'follow' after `{last}` — `follow` needs a relation: `follow <relation>` or `follow distinct <relation>`"
                        ));
                    }
                    "limit" | "offset" => {
                        return self.fail(format!(
                            "unexpected '{v}' after `{last}` — a bound is a non-negative number literal, a binding, or (inside a block) an outer reference `^name`"
                        ));
                    }
                    _ => {}
                }
            }
        }
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

    // `follow` is a clause when a relation (or something that tries to be one —
    // `distinct`, an outer reference) follows; otherwise it is a field name.
    fn at_follow(&self) -> bool {
        self.at_word(TokType::Ident, "follow")
            && self.peek_at(1).is_some_and(|nx| {
                matches!(nx.kind, TokType::Ident | TokType::Binding | TokType::Caret)
            })
    }

    // ---- follow ---------------------------------------------------------------
    fn parse_follow(&mut self) -> Result<Follow> {
        self.next(); // `follow`
        let mut distinct = false;
        // After `follow`, `distinct` is a keyword (a relation literally named
        // `distinct` is not supported); it must be followed by the relation.
        if self.at_word(TokType::Ident, "distinct") {
            self.next();
            distinct = true;
            if !matches!(
                self.peek().kind,
                TokType::Ident | TokType::Binding | TokType::Caret
            ) {
                return self.fail(
                    "expected a relation after `follow distinct` (`follow distinct <relation>`)",
                );
            }
        }
        if self.at(TokType::Caret) {
            return self.fail(
                "`follow` takes a relation of the current row (`follow <relation>`); an outer reference `^name` is not allowed there",
            );
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
        if LITERAL_WORDS.contains(&self.peek().value.as_str()) {
            return self.fail(format!(
                "`{}` is a literal, not a collection",
                self.peek().value
            ));
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
                return self.fail("expected a property name after '.'");
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
    fn parse_projection(&mut self, ctx: BodyCtx) -> Result<(Vec<SelectItem>, bool)> {
        let mut items = vec![self.parse_select_item(ctx)?];
        while self.at(TokType::Comma) {
            self.next();
            items.push(self.parse_select_item(ctx)?);
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
            // Every item needs a distinct key: two items with one name would silently
            // overwrite each other in the record. Lifts are keyed per scope (`^x` and
            // `^^x` bind different rows), so the lift depth is part of the key.
            let mut seen: HashSet<String> = HashSet::new();
            for it in &items {
                if it.name().is_empty() {
                    return self.fail(
                        "a leading expression is a projection (select): an item that is not a plain name needs an alias (`name: expr`) or `values`; to filter by it write `where …` — a predicate is never implicit",
                    );
                }
                let lift = match it {
                    SelectItem::Field { lift, .. } => *lift,
                    SelectItem::Collect { .. } => 0,
                };
                let key = format!("{}{}", "^".repeat(lift), it.name());
                if !seen.insert(key) {
                    return self.fail(format!(
                        "duplicate projection name '{}' — each projected item needs its own name (alias one: `other: expr`)",
                        it.name()
                    ));
                }
            }
        }
        Ok((items, values))
    }

    fn parse_select_item(&mut self, ctx: BodyCtx) -> Result<SelectItem> {
        // Leading `^`s mark a lift; the count is how many scopes out it binds. A
        // lift is bound by a `collect { … }` in where position and nowhere else — at
        // the top level, in a select-position block, or in an exists/none/count
        // block it would silently do nothing (or act as a plain field), so it is an
        // error there.
        let lift = self.parse_carets();
        if !self.at(TokType::Ident) && !self.can_start_value() {
            return self.fail("expected a projection name");
        }
        if lift > 0 && !ctx.lifts_allowed() {
            let what = if self.at(TokType::Ident) {
                format!("^{}", self.peek().value)
            } else {
                "^name".to_string()
            };
            return self.fail(format!(
                "a lift ({what}) binds a value into the enclosing row and is only valid in a `collect {{ … }}` in where position (`where <relation> collect {{ {what}: … }}`)"
            ));
        }
        if self.at(TokType::Ident) && self.peek_at(1).is_some_and(|t| t.kind == TokType::Colon) {
            let name = self.next().value;
            self.next(); // ':'
            if let Some(op) = self.try_op(false)? {
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

    // ---- where boolean tree: or → and → primary --------------------------------
    // `!` is handled in `parse_where_primary`: it applies to the operand right after
    // it (a consumer test, a parenthesized group, or a scalar primary), never to a
    // whole comparison — `!a == b` is `(!a) == b`, exactly as in value position.
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
        let left = self.parse_where_primary()?;
        if !self.at_op("&&") {
            return Ok(left);
        }
        let mut parts = vec![left];
        while self.at_op("&&") {
            self.next();
            parts.push(self.parse_where_primary()?);
        }
        Ok(Where::And { parts })
    }

    // A where operand: `[!…] ( where )`, `[!…] <receiver> <consumer> { … }`, or a
    // scalar leaf (a cmp-level expression, which handles its own `!`).
    //
    // Parentheses group EITHER a predicate or a scalar, decided by what follows
    // the `)`: a comparison, arithmetic, `in`, a range, or `.`-navigation means
    // the group is a scalar operand (`(a + 1) > 2`, `(a || b) == 5`,
    // `(x).size() > 1`); anything else means it is a predicate group
    // (`(a > 1) && b`). A group that contains a consumer test can only be a
    // predicate.
    fn parse_where_primary(&mut self) -> Result<Where> {
        let start = self.pos;
        let mut nots = 0;
        while self.at_op("!") {
            self.next();
            nots += 1;
        }
        if self.at(TokType::LParen) {
            self.next();
            let inner = self.parse_where()?;
            if !self.at(TokType::RParen) {
                return self.fail("expected ')' to close a grouped where expression");
            }
            self.next();
            if self.at_scalar_continuation() {
                let group = self.where_to_expr(inner)?;
                let mut e = self.parse_postfix(Some(group))?;
                for _ in 0..nots {
                    e = Expr::Unary {
                        op: UnaryOp::Not,
                        expr: Box::new(e),
                    };
                }
                let expr = self.parse_cmp(Some(e))?;
                return Ok(Where::Scalar { expr });
            }
            return Ok(wrap_not(inner, nots));
        }
        if let Some(op) = self.try_op(true)? {
            let op = self.finish_where_op(op)?;
            return Ok(wrap_not(Where::Op(Box::new(op)), nots));
        }
        // A scalar leaf, re-read from the first `!` so the scalar grammar gives `!`
        // its one precedence (tighter than comparison). A leaf whose whole value is
        // a negation keeps the `not` node shape (`where !active`).
        self.pos = start;
        let expr = self.parse_cmp(None)?;
        Ok(scalar_leaf(expr))
    }

    // Whether the token after a `)` continues a scalar expression.
    fn at_scalar_continuation(&self) -> bool {
        let t = self.peek();
        match t.kind {
            TokType::Op => {
                let v = t.value.as_str();
                CMP_OPS.contains(&v) || ADD_OPS.contains(&v) || MUL_OPS.contains(&v)
            }
            TokType::Dot | TokType::Range => true,
            TokType::Ident => t.value == "in",
            _ => false,
        }
    }

    // A parenthesized where-group that turned out to be a scalar operand, as an
    // expression. A consumer test has no scalar value, so it cannot be operated on.
    fn where_to_expr(&self, w: Where) -> Result<Expr> {
        Ok(match w {
            Where::Scalar { expr } => expr,
            Where::Not { expr } => Expr::Unary {
                op: UnaryOp::Not,
                expr: Box::new(self.where_to_expr(*expr)?),
            },
            Where::And { parts } => self.fold_logical(LogicalOp::And, parts)?,
            Where::Or { parts } => self.fold_logical(LogicalOp::Or, parts)?,
            Where::Op(op) => {
                let hint = if op.op == Consumer::Count {
                    format!(
                        " — write `<relation> count {{ … }} {} N` without the parentheses",
                        self.peek().value
                    )
                } else {
                    String::new()
                };
                return self.fail(format!(
                    "a consumer test ({} {{ … }}) is a predicate, not a value, so it cannot be compared or operated on{hint}",
                    op.op.as_str()
                ));
            }
        })
    }

    // `parts` joined left-to-right with one logical operator (`And`/`Or` nodes
    // are n-ary; the scalar `Logical` node is binary).
    fn fold_logical(&self, op: LogicalOp, parts: Vec<Where>) -> Result<Expr> {
        let mut iter = parts.into_iter();
        let first = iter
            .next()
            .expect("an And/Or node always has at least one part");
        let mut acc = self.where_to_expr(first)?;
        for p in iter {
            acc = Expr::Logical {
                op,
                left: Box::new(acc),
                right: Box::new(self.where_to_expr(p)?),
            };
        }
        Ok(acc)
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
    // Returns None (rewinding) when the lookahead is not a consumer op. `in_where`
    // says whether the op sits in where position, where a `collect` block may
    // bind lifts.
    fn try_op(&mut self, in_where: bool) -> Result<Option<OpNode>> {
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
                if let Expr::Ident { name } = &receiver
                    && LITERAL_WORDS.contains(&name.as_str())
                {
                    return self.fail(format!("`{name}` is a literal, not a collection"));
                }
                let op = Consumer::from_word(&self.next().value)
                    .expect("CONSUMERS membership was checked");
                let mut distinct = false;
                if self.at_word(TokType::Ident, "distinct") {
                    self.next();
                    distinct = true;
                }
                self.next(); // '{'
                let ctx = BodyCtx::Block {
                    op,
                    lifts_allowed: in_where && op == Consumer::Collect,
                };
                let (sub, body_distinct) = self.parse_subquery(ctx)?;
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

    fn parse_subquery(&mut self, ctx: BodyCtx) -> Result<(Subquery, bool)> {
        let body = self.parse_body(ctx)?;
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
        let mut left = self.parse_cmp(None)?;
        while self.at_op("&&") {
            self.next();
            let right = self.parse_cmp(None)?;
            left = Expr::Logical {
                op: LogicalOp::And,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    // Comparison / membership (also the entry point for a where scalar leaf, so a
    // where leaf never swallows the where-tree's && / ||). Non-associative: a
    // second comparison in a row is an error, not a silent stray token.
    //
    // Each level from here down takes an optional already-parsed `left` operand,
    // so a parenthesized where-group promoted to a scalar continues into the
    // operator tail without re-reading its tokens.
    fn parse_cmp(&mut self, left: Option<Expr>) -> Result<Expr> {
        let lhs = self.parse_range(left)?;
        if !self.at_cmp() {
            return Ok(lhs);
        }
        let first = self.next().value;
        let rhs = self.parse_range(None)?;
        let result = if first == "in" {
            Expr::In {
                left: Box::new(lhs),
                right: Box::new(rhs),
            }
        } else {
            Expr::Binary {
                op: BinaryOp::from_word(&first).expect("CMP_OPS membership was checked"),
                left: Box::new(lhs),
                right: Box::new(rhs),
            }
        };
        if self.at_cmp() {
            return self.fail(format!(
                "comparisons do not chain: `a {first} b {} c` — write two comparisons joined with `&&`",
                self.peek().value
            ));
        }
        Ok(result)
    }

    // Whether the current token is a comparison operator or `in`.
    fn at_cmp(&self) -> bool {
        let t = self.peek();
        (t.kind == TokType::Op && CMP_OPS.contains(&t.value.as_str()))
            || self.at_word(TokType::Ident, "in")
    }

    // Range literal: `lo..hi` / `lo...hi` and the open-ended forms `..hi`, `lo..`.
    // Binds looser than arithmetic (so `1+1..2*3` is the range 2..6) but tighter
    // than comparison / `in` (so `n in 1..5` reads as `n in (1..5)`). A leading
    // `..`/`...` opens the low end; a trailing `..`/`...` with no following value
    // opens the high end. At least one bound is required.
    fn parse_range(&mut self, left: Option<Expr>) -> Result<Expr> {
        if left.is_none() && self.at(TokType::Range) {
            let exclusive_end = self.next().value == "...";
            if !self.can_start_value() {
                return self.fail("a range needs at least one bound: `lo..hi`, `lo..`, or `..hi`");
            }
            let hi = self.parse_add(None)?;
            return Ok(Expr::Range {
                lo: None,
                hi: Some(Box::new(hi)),
                exclusive_end,
            });
        }
        let lo = self.parse_add(left)?;
        if self.at(TokType::Range) {
            let exclusive_end = self.next().value == "...";
            let hi = if self.can_start_value() {
                Some(Box::new(self.parse_add(None)?))
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

    fn parse_add(&mut self, left: Option<Expr>) -> Result<Expr> {
        let mut left = self.parse_mul(left)?;
        while self.peek().kind == TokType::Op && ADD_OPS.contains(&self.peek().value.as_str()) {
            let op =
                BinaryOp::from_word(&self.next().value).expect("ADD_OPS membership was checked");
            let right = self.parse_mul(None)?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_mul(&mut self, left: Option<Expr>) -> Result<Expr> {
        let mut left = self.parse_unary(left)?;
        while self.peek().kind == TokType::Op && MUL_OPS.contains(&self.peek().value.as_str()) {
            let op =
                BinaryOp::from_word(&self.next().value).expect("MUL_OPS membership was checked");
            let right = self.parse_unary(None)?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }

    fn parse_unary(&mut self, left: Option<Expr>) -> Result<Expr> {
        if left.is_some() {
            return self.parse_postfix(left);
        }
        if self.at_op("!") {
            self.next();
            return Ok(Expr::Unary {
                op: UnaryOp::Not,
                expr: Box::new(self.parse_unary(None)?),
            });
        }
        if self.at_op("-") {
            self.next();
            return Ok(Expr::Unary {
                op: UnaryOp::Neg,
                expr: Box::new(self.parse_unary(None)?),
            });
        }
        self.parse_postfix(None)
    }

    // The postfix chain (`.name`, `.name(args)`, a free-function call) on a
    // primary, or on an already-parsed `left` operand — which is never a bare
    // name read here, so `(f)(x)` is not a call.
    fn parse_postfix(&mut self, left: Option<Expr>) -> Result<Expr> {
        let bare_head = left.is_none();
        let mut expr = match left {
            Some(e) => e,
            None => self.parse_primary()?,
        };
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
            } else if self.at(TokType::LParen) && bare_head && matches!(expr, Expr::Ident { .. }) {
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

// `!` applied `n` times to a where node.
fn wrap_not(mut w: Where, n: usize) -> Where {
    for _ in 0..n {
        w = Where::Not { expr: Box::new(w) };
    }
    w
}

// A scalar where leaf. A leading `!` on the whole leaf becomes a `Not` node (so
// `where !active` keeps its shape); inside a comparison it stays a unary `!`.
fn scalar_leaf(e: Expr) -> Where {
    match e {
        Expr::Unary {
            op: UnaryOp::Not,
            expr,
        } => Where::Not {
            expr: Box::new(scalar_leaf(*expr)),
        },
        expr => Where::Scalar { expr },
    }
}

// The default key of an unaliased projection item: the last segment of a bare /
// dotted / outer navigation (`name`, `meta.slug` → "slug", `^name`), else None.
fn nav_key(e: &Expr) -> Option<&str> {
    match e {
        Expr::Ident { name } | Expr::Outer { name, .. } | Expr::Member { name, .. } => Some(name),
        _ => None,
    }
}
