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
//! select <projection>  from <source>  where <predicate>  follow <dest>, … {…}
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
//! body's `select` aliases: the parser VALIDATES those references (a cycle or a
//! block alias inside an expression is a parse error) but keeps the surface
//! form; [`crate::resolve::resolve_aliases`] substitutes them before evaluation.
//!
//! Every node carries its [`Span`] — `[start, end)` in code points over the raw
//! source, from the first token that produced it to the end of the last; a
//! parenthesized operand's span includes its parentheses (`spec/oqx/AST.md`).
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
//! `follow` (since 0.14) takes a comma-separated list of destinations: a plain
//! destination is a relation of the current row (an outer reference or a
//! literal word is a parse error); a destination block is a receiver — which
//! MAY be an outer reference — followed by `collect`/`first`/`single`
//! [`distinct`] `{ body }`, exactly what `try_op` recognizes in select position
//! (`exists`/`none`/`count` are rejected: they are where-position tests).
//!
//! Error messages are the TS messages verbatim (the conformance fixtures and
//! the reference tests assert on fragments of them).

use std::collections::HashSet;

use crate::ast::{
    BinaryOp, Consumer, CountCmp, Expr, Follow, FollowDestination, LogicalOp, OpNode, OrderSpec,
    Query, RelOp, SelectItem, Span, Subquery, UnaryOp, Where,
};
use crate::errors::{OqxError, Result};
use crate::lexer::{TokType, Token, lex_string, lex_template};
use crate::resolve::resolve_where;
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
    /// Code-point offset of the next token (the start of a node about to be parsed).
    fn start(&self) -> usize {
        self.peek().pos
    }
    /// Code-point offset just past the last consumed token (the end of a node just parsed).
    fn end(&self) -> usize {
        if self.pos == 0 {
            0
        } else {
            self.tokens[self.pos - 1].end
        }
    }
    fn sp(&self, start: usize) -> Span {
        Span::new(start, self.end())
    }

    // ---- top level ------------------------------------------------------------
    fn parse_query(&mut self) -> Result<Query> {
        let start = self.start();
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
                    span: self.sp(start),
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
            span: self.sp(start),
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
        // Validate the alias references of this body's `where` (cycles, a block
        // alias inside an expression); the surface form is kept.
        if let Some(w) = &body.r#where {
            if let Err(msg) = resolve_where(&body.select, w.clone()) {
                return self.fail(msg);
            }
        }
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
    // `follow [distinct] dest { "," dest } [ "{" options "}" ]`.
    fn parse_follow(&mut self) -> Result<Follow> {
        let start = self.start();
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
        let mut destinations = vec![self.parse_follow_destination()?];
        while self.at(TokType::Comma) {
            self.next();
            if !matches!(
                self.peek().kind,
                TokType::Ident | TokType::Binding | TokType::Caret
            ) {
                return self
                    .fail("expected a relation after ',' (`follow <relation>, <relation>`)");
            }
            destinations.push(self.parse_follow_destination()?);
        }
        let mut follow = Follow {
            destinations,
            distinct,
            r#where: None,
            frontier: None,
            depth: None,
            by: None,
            span: self.sp(start),
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
        follow.span = self.sp(start);
        Ok(follow)
    }

    // One `follow` destination. The receiver is parsed first so that a block over an
    // outer reference (`^people collect { … }`) is recognized before the plain-form
    // rule — a relation of the current row, never `^rel` — rejects the caret.
    fn parse_follow_destination(&mut self) -> Result<FollowDestination> {
        let outer = self.at(TokType::Caret);
        let receiver = self.parse_receiver()?;
        if let Some(op) = self.at_consumer_block() {
            if !matches!(op, Consumer::Collect | Consumer::First | Consumer::Single) {
                return self.fail(format!(
                    "a follow destination must use collect/first/single, not `{}` (exists/none/count are where-position tests)",
                    op.as_str()
                ));
            }
            let block = self.parse_consumer_block(receiver, op, false)?;
            return Ok(FollowDestination::Block(Box::new(block)));
        }
        if outer {
            return self.fail(
                "`follow` takes a relation of the current row (`follow <relation>`); an outer reference `^name` is not allowed there — it may only head a destination block (`follow ^name collect { … }`)",
            );
        }
        Ok(FollowDestination::Relation(receiver))
    }

    // A receiver/source: a `${…}` binding, or a dotted identifier navigation chain
    // whose head may be an outer reference (`^rel`, `^^root.rel`) — since a bare
    // name is the current row's own property, an enclosing row's relation or a
    // named root is only reachable as a receiver through `^` — or a free-function
    // call (`entries(prefs)`), so a computed collection can be consumed directly.
    fn parse_receiver(&mut self) -> Result<Expr> {
        if self.at(TokType::Binding) {
            return Ok(binding_node(&self.next()));
        }
        let start = self.start();
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
        Ok(self.parse_nav_from(head, levels, start)?.0)
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
    // reference read exactly that many scopes out (`start` is then the position
    // of the first caret). A bare head followed by `(` is a free-function call
    // (`entries(x)`), which may then be navigated further. Returns the
    // expression and the last segment's name.
    fn parse_nav_from(
        &mut self,
        head: Token,
        levels: usize,
        start: usize,
    ) -> Result<(Expr, String)> {
        let mut expr = if levels > 0 {
            Expr::Outer {
                levels,
                name: head.value.clone(),
                span: Span::new(start, head.end),
            }
        } else {
            Expr::Ident {
                name: head.value.clone(),
                span: Span::new(start, head.end),
            }
        };
        let mut name = head.value;
        if levels == 0 && self.at(TokType::LParen) {
            let args = self.parse_args()?;
            expr = Expr::Call {
                recv: None,
                name: name.clone(),
                args,
                span: self.sp(start),
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
                span: self.sp(start),
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
        let start = self.start();
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
                    span: self.sp(start),
                });
            }
            let expr = self.parse_value_expr()?;
            return Ok(SelectItem::Field {
                name,
                expr,
                lift,
                span: self.sp(start),
            });
        }
        // Unaliased item: a bare/dotted navigation keys by its last segment; any
        // other expression is unnamed ("") — legal only under `values` (checked by
        // parse_projection, which sees the whole list).
        let expr = self.parse_value_expr()?;
        let name = nav_key(&expr).unwrap_or("").to_string();
        Ok(SelectItem::Field {
            name,
            expr,
            lift,
            span: self.sp(start),
        })
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
        let start = self.start();
        let expr = self.parse_value_expr()?;
        let mut desc = false;
        if self.at_word(TokType::Ident, "asc") {
            self.next();
        } else if self.at_word(TokType::Ident, "desc") {
            self.next();
            desc = true;
        }
        Ok(OrderSpec {
            expr,
            desc,
            span: self.sp(start),
        })
    }

    // ---- where boolean tree: or → and → primary --------------------------------
    // `!` is handled in `parse_where_primary`: it applies to the operand right after
    // it (a consumer test, a parenthesized group, or a scalar primary), never to a
    // whole comparison — `!a == b` is `(!a) == b`, exactly as in value position.
    fn parse_where(&mut self) -> Result<Where> {
        self.parse_where_or()
    }

    fn parse_where_or(&mut self) -> Result<Where> {
        let start = self.start();
        let left = self.parse_where_and()?;
        if !self.at_op("||") {
            return Ok(left);
        }
        let mut parts = vec![left];
        while self.at_op("||") {
            self.next();
            parts.push(self.parse_where_and()?);
        }
        Ok(Where::Or {
            parts,
            span: self.sp(start),
        })
    }

    fn parse_where_and(&mut self) -> Result<Where> {
        let start = self.start();
        let left = self.parse_where_primary()?;
        if !self.at_op("&&") {
            return Ok(left);
        }
        let mut parts = vec![left];
        while self.at_op("&&") {
            self.next();
            parts.push(self.parse_where_primary()?);
        }
        Ok(Where::And {
            parts,
            span: self.sp(start),
        })
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
        let mut not_starts: Vec<usize> = Vec::new();
        while self.at_op("!") {
            not_starts.push(self.next().pos);
        }
        if self.at(TokType::LParen) {
            let lparen = self.next().pos;
            let inner = self.parse_where()?;
            if !self.at(TokType::RParen) {
                return self.fail("expected ')' to close a grouped where expression");
            }
            self.next();
            let group = Span::new(lparen, self.end());
            if self.at_scalar_continuation() {
                let promoted = self.where_to_expr(inner)?.with_span(group);
                let mut e = self.parse_postfix(Some(promoted))?;
                for &at in not_starts.iter().rev() {
                    let span = Span::new(at, e.span().end);
                    e = Expr::Unary {
                        op: UnaryOp::Not,
                        expr: Box::new(e),
                        span,
                    };
                }
                let expr = self.parse_cmp(Some(e))?;
                let span = expr.span();
                return Ok(Where::Scalar { expr, span });
            }
            return Ok(wrap_not(inner.with_span(group), &not_starts));
        }
        if let Some(op) = self.try_op(true)? {
            let op = self.finish_where_op(op)?;
            return Ok(wrap_not(Where::Op(Box::new(op)), &not_starts));
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
            Where::Scalar { expr, .. } => expr,
            Where::Not { expr, span } => Expr::Unary {
                op: UnaryOp::Not,
                expr: Box::new(self.where_to_expr(*expr)?),
                span,
            },
            Where::And { parts, .. } => self.fold_logical(LogicalOp::And, parts)?,
            Where::Or { parts, .. } => self.fold_logical(LogicalOp::Or, parts)?,
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
            let right = self.where_to_expr(p)?;
            let span = Span::new(acc.span().start, right.span().end);
            acc = Expr::Logical {
                op,
                left: Box::new(acc),
                right: Box::new(right),
                span,
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
            op.span = Span::new(op.span.start, self.end());
        }
        Ok(op)
    }

    // Detect + parse a postfix consumer op `<receiver> <consumer> { <sub> }`.
    // Returns None (rewinding) when the lookahead is not a consumer op. `in_where`
    // says whether the op sits in where position, where a `collect` block may
    // bind lifts.
    fn try_op(&mut self, in_where: bool) -> Result<Option<OpNode>> {
        let start = self.pos;
        let start_pos = self.start();
        let receiver = if self.at(TokType::Binding) {
            binding_node(&self.next())
        } else if self.at(TokType::Ident) || self.at(TokType::Caret) {
            let levels = self.parse_carets();
            if !self.at(TokType::Ident) {
                self.pos = start;
                return Ok(None);
            }
            let head = self.next();
            self.parse_nav_from(head, levels, start_pos)?.0
        } else {
            return Ok(None);
        };

        if let Some(op) = self.at_consumer_block() {
            if let Expr::Ident { name, .. } = &receiver
                && LITERAL_WORDS.contains(&name.as_str())
            {
                return self.fail(format!("`{name}` is a literal, not a collection"));
            }
            return Ok(Some(self.parse_consumer_block(receiver, op, in_where)?));
        }
        self.pos = start;
        Ok(None)
    }

    // The cursor is at a consumer word that opens a block — `<op> {` or
    // `<op> distinct {`. Consumes nothing.
    fn at_consumer_block(&self) -> Option<Consumer> {
        if !self.at(TokType::Ident) {
            return None;
        }
        let op = Consumer::from_word(&self.peek().value)?;
        let after = self.peek_at(1);
        let op_then_brace = after.is_some_and(|a| a.kind == TokType::LBrace);
        let op_distinct_brace = after
            .is_some_and(|a| a.kind == TokType::Ident && a.value == "distinct")
            && self.peek_at(2).is_some_and(|a| a.kind == TokType::LBrace);
        (op_then_brace || op_distinct_brace).then_some(op)
    }

    // `<op> [distinct] { <sub> }` over an already-parsed receiver; the cursor is
    // at the consumer word (`at_consumer_block` returned `op`). `in_where` says
    // whether the op sits in where position, where a `collect` block may bind
    // lifts.
    fn parse_consumer_block(
        &mut self,
        receiver: Expr,
        op: Consumer,
        in_where: bool,
    ) -> Result<OpNode> {
        let start = receiver.span().start;
        self.next(); // the consumer word
        let mut distinct = false;
        if self.at_word(TokType::Ident, "distinct") {
            self.next();
            distinct = true;
        }
        let lbrace = self.next().pos; // '{'
        let ctx = BodyCtx::Block {
            op,
            lifts_allowed: in_where && op == Consumer::Collect,
        };
        let body = self.parse_body(ctx)?;
        if !self.at(TokType::RBrace) {
            return self.fail(format!(
                "expected '}}' to close the {} {{ … }} block",
                op.as_str()
            ));
        }
        self.next();
        let sub = Subquery {
            from: body.froms,
            r#where: body.r#where,
            select: body.select,
            order_by: body.order_by,
            follow: body.follow,
            values: body.values,
            limit: body.limit,
            offset: body.offset,
            span: self.sp(lbrace),
        };
        Ok(OpNode {
            receiver,
            op,
            sub,
            count_cmp: None,
            distinct: distinct || body.distinct,
            span: self.sp(start),
        })
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
            let span = Span::new(left.span().start, right.span().end);
            left = Expr::Logical {
                op: LogicalOp::Or,
                left: Box::new(left),
                right: Box::new(right),
                span,
            };
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr> {
        let mut left = self.parse_cmp(None)?;
        while self.at_op("&&") {
            self.next();
            let right = self.parse_cmp(None)?;
            let span = Span::new(left.span().start, right.span().end);
            left = Expr::Logical {
                op: LogicalOp::And,
                left: Box::new(left),
                right: Box::new(right),
                span,
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
        let span = Span::new(lhs.span().start, rhs.span().end);
        let result = if first == "in" {
            Expr::In {
                left: Box::new(lhs),
                right: Box::new(rhs),
                span,
            }
        } else {
            Expr::Binary {
                op: BinaryOp::from_word(&first).expect("CMP_OPS membership was checked"),
                left: Box::new(lhs),
                right: Box::new(rhs),
                span,
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
            let tok = self.next();
            let exclusive_end = tok.value == "...";
            if !self.can_start_value() {
                return self.fail("a range needs at least one bound: `lo..hi`, `lo..`, or `..hi`");
            }
            let hi = self.parse_add(None)?;
            let span = Span::new(tok.pos, hi.span().end);
            return Ok(Expr::Range {
                lo: None,
                hi: Some(Box::new(hi)),
                exclusive_end,
                span,
            });
        }
        let lo = self.parse_add(left)?;
        if self.at(TokType::Range) {
            let tok = self.next();
            let exclusive_end = tok.value == "...";
            let hi = if self.can_start_value() {
                Some(Box::new(self.parse_add(None)?))
            } else {
                None
            };
            let span = Span::new(
                lo.span().start,
                hi.as_ref().map_or(tok.end, |h| h.span().end),
            );
            return Ok(Expr::Range {
                lo: Some(Box::new(lo)),
                hi,
                exclusive_end,
                span,
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
            let span = Span::new(left.span().start, right.span().end);
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
                span,
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
            let span = Span::new(left.span().start, right.span().end);
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
                span,
            };
        }
        Ok(left)
    }

    fn parse_unary(&mut self, left: Option<Expr>) -> Result<Expr> {
        if left.is_some() {
            return self.parse_postfix(left);
        }
        if self.at_op("!") || self.at_op("-") {
            let tok = self.next();
            let op = UnaryOp::from_word(&tok.value).expect("checked above");
            let expr = self.parse_unary(None)?;
            let span = Span::new(tok.pos, expr.span().end);
            return Ok(Expr::Unary {
                op,
                expr: Box::new(expr),
                span,
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
        let start = expr.span().start;
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
                        span: self.sp(start),
                    };
                } else {
                    expr = Expr::Member {
                        recv: Box::new(expr),
                        name,
                        span: self.sp(start),
                    };
                }
            } else if self.at(TokType::LParen) && bare_head && matches!(expr, Expr::Ident { .. }) {
                // free function call: name(args)
                let Expr::Ident { name, .. } = expr else {
                    unreachable!()
                };
                let args = self.parse_args()?;
                expr = Expr::Call {
                    recv: None,
                    name,
                    args,
                    span: self.sp(start),
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
                let name = self.next();
                Ok(Expr::Outer {
                    levels,
                    name: name.value,
                    span: Span::new(t.pos, name.end),
                })
            }
            TokType::Number => {
                self.next();
                Ok(Expr::Lit {
                    value: Value::Number(number_value(&t.value)),
                    span: Span::new(t.pos, t.end),
                })
            }
            TokType::Str => {
                self.next();
                Ok(Expr::Lit {
                    value: Value::Str(t.value),
                    span: Span::new(t.pos, t.end),
                })
            }
            TokType::Binding => {
                self.next();
                Ok(binding_node(&t))
            }
            TokType::LParen => {
                self.next();
                let e = self.parse_value_expr()?;
                if !self.at(TokType::RParen) {
                    return self.fail("expected ')'");
                }
                self.next();
                Ok(e.with_span(Span::new(t.pos, self.end())))
            }
            TokType::Ident => {
                self.next();
                let span = Span::new(t.pos, t.end);
                Ok(match t.value.as_str() {
                    "true" => Expr::Lit {
                        value: Value::Bool(true),
                        span,
                    },
                    "false" => Expr::Lit {
                        value: Value::Bool(false),
                        span,
                    },
                    "null" => Expr::Lit {
                        value: Value::Null,
                        span,
                    },
                    _ => Expr::Ident {
                        name: t.value,
                        span,
                    },
                })
            }
            _ => self.fail(format!("unexpected {} — expected a value", self.tok_desc())),
        }
    }
}

fn binding_node(t: &Token) -> Expr {
    Expr::Binding {
        index: t.index.expect("a binding token always carries its index"),
        span: Span::new(t.pos, t.end),
    }
}

// `!` applied once per recorded `!` position to a where node, innermost first.
fn wrap_not(mut w: Where, not_starts: &[usize]) -> Where {
    for &at in not_starts.iter().rev() {
        let span = Span::new(at, w.span().end);
        w = Where::Not {
            expr: Box::new(w),
            span,
        };
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
            span,
        } => Where::Not {
            expr: Box::new(scalar_leaf(*expr)),
            span,
        },
        expr => {
            let span = expr.span();
            Where::Scalar { expr, span }
        }
    }
}

// The default key of an unaliased projection item: the last segment of a bare /
// dotted / outer navigation (`name`, `meta.slug` → "slug", `^name`), else None.
fn nav_key(e: &Expr) -> Option<&str> {
    match e {
        Expr::Ident { name, .. } | Expr::Outer { name, .. } | Expr::Member { name, .. } => {
            Some(name)
        }
        _ => None,
    }
}
