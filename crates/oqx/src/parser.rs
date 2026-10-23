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
//! flatten <expr> [{…}] [as <name>] …  group by <key>, …  having <predicate>
//! order by …  limit N  offset N
//! ```
//!
//! A query names its source BEFORE its body (0.26, the collection-scoped form):
//! `<collection> [<consumer>] [distinct] { body }` — the receiver supplies the
//! rows, so the body never names its source and its `from` is the re-projection
//! (a flatMap). The clause form `select … from S …` is still read as the same
//! tree (its top-level body needs `from`); the printer never writes it.
//! Every clause is optional except that a clause-form top-level body needs `from` (the
//! receiver-plus-consumer form `<receiver> <consumer> { block }` supplies the
//! source itself, so its block's `from` is an optional re-projection). Only
//! `select` may drop its keyword, and only when it is the first clause written
//! (`name, age from people`); every other clause always carries its keyword. A
//! BLOCK may instead lead with a predicate (since 0.17): a leading expression
//! that is syntactically a predicate — not a bare name, a dotted navigation or a
//! lift — opens a `where`-first body (`people exists { age > 50 }`); at the top
//! level a leading predicate is still an error, since `where` would precede
//! `from`. An out-of-order clause is a parse error naming the order.
//!
//! Sugar (0.17) desugars HERE, to existing nodes: `x { … }` is `x collect { … }`
//! wherever a value stands (a select item, a where leaf, a follow destination, a
//! call argument — since 0.20 without exception) and `x distinct { … }` is
//! `x collect distinct { … }` (0.20); `x[p]` is `x first { where p }`, `x[n]` is `x first { offset n }`, with a
//! trailing `!` making the first a `single` (predicate) or a `required` (index);
//! `is x` is `!!x`, `not x` is `!x`. Two shapes are new: the postfix `required`
//! (`x!`, tightest) and the identity operators `is` / `is not` (comparison
//! level). A directive may stand in value position (`jobs first { }.pay`), which
//! is how the canonical printer writes a bracket chain back. `where` may reference the same
//! body's `select` aliases: the parser VALIDATES those references (a cycle or a
//! block alias inside an expression is a parse error) but keeps the surface
//! form; [`crate::resolve::resolve_aliases`] substitutes them before evaluation.
//!
//! Absolute scope references (0.18) desugar HERE too: `N^name` — an unsigned
//! integer literal immediately followed by `^` — is the `outer` reference (or
//! the lift) reaching scope N, i.e. `levels = depth − N`, where `depth` is the
//! syntactic scope depth of the position being parsed (SEMANTICS §2: the root
//! is 0, a top-level row 1, a block's body one deeper than its receiver, a
//! follow `where` one deeper than the frontier row). The parser tracks that
//! depth (`self.depth`) exactly as the `visit` walk computes it; `N >= depth`
//! is a parse error. There is no new node: `print` writes the carets back.
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
//! MAY be an outer reference or a tuple `(a, b)` — followed by `{ body }`, or by
//! `collect`/`first`/`single` [`distinct`] `{ body }`, exactly what `try_op`
//! recognizes in select position (`exists`/`none`/`count` are rejected: they are
//! where-position tests). Since 0.20 there is no options block: a brace after
//! ANY destination opens that destination's block, whose body admits `depth n`
//! (no other block does) and `frontier P` as the destination's own clause, after
//! `where`. Any body that has a `follow` may carry `frontier P` too, marking its
//! seeds (read in the seed's scope, like `where`).
//!
//! Tuples (0.20): `(e1, e2, …)` with two or more elements is a `Tuple` node — a
//! value and a receiver; one expression in parentheses stays grouping.
//!
//! Grouping (0.24): `group by <key>, …` and `having <pred>` sit after `follow`
//! in the clause order; a key is shaped like a select item (an expression key
//! needs its alias, names are unique); a free call by an aggregate name
//! (`count()`, `sum(e)`, `collect(distinct e)`) parses to an `Aggregate` node
//! wherever it is written and may stand only in a select item, `having` or
//! `order by` of a grouped body; every bare name read at the group scope must
//! be a key, an alias, or `rows`; a grouped body with no `select` carries the
//! synthesized projection (its keys and `count: count()`); `distinct` with
//! `group by` is refused; and `count { … }` is a value-position directive like
//! `collect`/`first`/`single`.
//!
//! Flatten (0.25): `flatten <expr> [{ … }] [as <name>]` sits after `follow` and
//! before `group by` and is the ONE clause that may repeat — each fans out the
//! rows the previous produced (SEMANTICS §25). The value is read on each row
//! like `where`; a brace after a receiver is the receiver-block sugar (the
//! `collect` op), so the block needs no slot of its own. The name defaults to a
//! plain navigation's last segment; anything else needs `as`; names are unique
//! within the body, never a keyword, a literal word or a `$`-name. `flatten` is
//! a clause only when a value can follow it, `as` only after a flatten
//! expression — both contextual words.
//!
//! Error messages are the TS messages verbatim (the conformance fixtures and
//! the reference tests assert on fragments of them).

use std::collections::HashSet;

use crate::ast::{
    AggregateName, BinaryOp, Consumer, CountCmp, Expr, Flatten, Follow, FollowDestination, GroupBy,
    GroupKey, LogicalOp, OpNode, OrderSpec, Query, RelOp, SelectItem, Span, Subquery, TemplatePart,
    UnaryOp, Where,
};
use crate::errors::{OqxError, Result};
use crate::lexer::{TokType, Token, lex_string, lex_template};
use crate::print::print_template;
use crate::resolve::{resolve_select, resolve_where};
use crate::value::Value;
use crate::walk::{Node, VisitContext, Visitor, template_exprs, visit};

const CONSUMERS: [&str; 6] = ["collect", "exists", "none", "count", "first", "single"];

/// The fixed clause order of a body (ADR-020). Each clause appears at most once.
/// Declaration order is the clause order; `Ord` compares by it. `Frontier` and
/// `Depth` are legal only in a follow destination block (0.20); the order
/// sentence names them only there. `GroupBy` and `Having` (0.24) sit after
/// `Follow`: the rows a body yields — the walk's occurrences, when it has one —
/// are what gets grouped, and the bound and the ordering then apply to the
/// groups. `Flatten` (0.25) sits between them: it fans the rows a body yields —
/// the occurrences, after a walk — out per element, and is the one clause that
/// may repeat (each `flatten` fans out the rows the previous produced,
/// SEMANTICS §25).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Clause {
    Select,
    From,
    Where,
    Frontier,
    Depth,
    Follow,
    Flatten,
    GroupBy,
    Having,
    OrderBy,
    Limit,
    Offset,
}

const CLAUSE_ORDER: [Clause; 12] = [
    Clause::Select,
    Clause::From,
    Clause::Where,
    Clause::Frontier,
    Clause::Depth,
    Clause::Follow,
    Clause::Flatten,
    Clause::GroupBy,
    Clause::Having,
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
            Clause::Frontier => "frontier",
            Clause::Depth => "depth",
            Clause::Follow => "follow",
            Clause::Flatten => "flatten",
            Clause::GroupBy => "group by",
            Clause::Having => "having",
            Clause::OrderBy => "order by",
            Clause::Limit => "limit",
            Clause::Offset => "offset",
        }
    }

    /// `depth` is a clause of a follow destination block only; `frontier` is a
    /// clause of every body that has a `follow` (a destination block's marks
    /// the occurrences it reaches, any other body's its seeds — 0.20).
    fn destination_only(self) -> bool {
        matches!(self, Clause::Depth)
    }
}

/// The clauses a body may hold, in order.
fn clauses_of(ctx: BodyCtx) -> impl Iterator<Item = Clause> {
    let dest = ctx.is_destination();
    CLAUSE_ORDER
        .into_iter()
        .filter(move |c| dest || !c.destination_only())
}

fn clause_order_sentence(ctx: BodyCtx) -> String {
    clauses_of(ctx)
        .map(|c| c.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

// Contextual clause words lexed as bare idents; an open-ended range must stop
// before them rather than consume them as its high bound.
const CLAUSE_WORDS: [&str; 22] = [
    "collect", "exists", "none", "count", "first", "single", "order", "by", "asc", "desc",
    "follow", "distinct", "frontier", "depth", "in", "values", "limit", "offset", "group",
    "having", "flatten", "as",
];
// The names a group scope resolves besides its keys (SEMANTICS §24): the
// group's rows, the key record itself, and its identity.
const GROUP_SCOPE_NAMES: [&str; 3] = ["rows", "$it", "$key"];
const RELOPS: [&str; 6] = ["==", "!=", "<", "<=", ">", ">="];
// The comparison level (GRAMMAR §4): the six relational operators and, since
// 0.22, the four regex operators — sugar over `matches`, non-associative like
// the rest of the level.
const CMP_OPS: [&str; 10] = ["==", "!=", "<", "<=", ">", ">=", "~", "~*", "!~", "!~*"];
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
        /// A `follow` destination block (0.20): the only body that admits
        /// `depth`, and the one whose `frontier` marks the occurrences it
        /// reaches (read one level out) rather than the seeds of its own
        /// `follow`.
        destination: bool,
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

    fn is_destination(self) -> bool {
        matches!(
            self,
            BodyCtx::Block {
                destination: true,
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
    frontier: Option<Expr>,
    depth: Option<u32>,
    flatten: Vec<Flatten>,
    group_by: Option<GroupBy>,
    having: Option<Where>,
    distinct: bool,
    values: bool,
    limit: Option<Expr>,
    offset: Option<Expr>,
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
    /// While a block's leading run is read speculatively as a predicate, a bare
    /// `first`/`single` leaf is not rejected on sight: the body decides after
    /// the run is classified (`reject_bare_lookups`).
    defer_lookup: bool,
    /// Whether a consumer word with no block is read as a directive over the
    /// empty block (`jobs first` ≡ `jobs first { }`, since 0.26). Off only while
    /// the clause form's top-level `from` expression is read, so `from people
    /// count` keeps its whole-query hint (a count is never a source).
    bare_directives: bool,
    /// The scope depth (SEMANTICS §2) at which the construct being parsed is
    /// evaluated: 0 at the root (the top-level source and bounds), 1 for a
    /// top-level row's clauses, one deeper per block body and per follow
    /// `where`. An absolute reference `N^name` reads `depth − N` scopes out.
    depth: usize,
}

/// The keyword-less run that opens a body: a `where`-first predicate or the
/// projection.
enum LeadingRun {
    Where(Where),
    Projection(Vec<SelectItem>, bool),
}

/// Whether a block holds nothing but its projection (the merge of
/// `merge_projection_block`).
fn projection_only(sub: &Subquery) -> bool {
    sub.from.is_empty()
        && sub.r#where.is_none()
        && sub.order_by.is_none()
        && sub.follow.is_none()
        && sub.frontier.is_none()
        && sub.depth.is_none()
        && sub.flatten.is_empty()
        && sub.group_by.is_none()
        && sub.having.is_none()
        && sub.limit.is_none()
        && sub.offset.is_none()
}

/// The names a projection would shadow in a `where` of the same body: every
/// item's name except a plain self-projection (`pay: pay`, `pay`), which
/// substitutes a name for itself.
fn shadowing_names(items: &[SelectItem]) -> Vec<&str> {
    items
        .iter()
        .filter_map(|it| match it {
            SelectItem::Field {
                name,
                expr: Expr::Ident { name: e, .. },
                lift: 0,
                ..
            } if e == name => None,
            SelectItem::Field { name, .. } | SelectItem::Collect { name, .. }
                if name.is_empty() =>
            {
                None
            }
            SelectItem::Field { name, .. } | SelectItem::Collect { name, .. } => {
                Some(name.as_str())
            }
        })
        .collect()
}

/// Whether a bare identifier anywhere under `w` has one of `names` (the alias
/// guard of the projection-block merge; conservative: nested blocks included).
fn reads_any_of(w: &Where, names: &[&str]) -> bool {
    struct Reads<'n> {
        names: &'n [&'n str],
        found: bool,
    }
    impl<'a> Visitor<'a> for Reads<'_> {
        fn enter(&mut self, node: Node<'a>, _ctx: &VisitContext<'a>) -> bool {
            if let Node::Expr(Expr::Ident { name, .. }) = node
                && self.names.contains(&name.as_str())
            {
                self.found = true;
            }
            !self.found
        }
    }
    if names.is_empty() {
        return false;
    }
    let mut v = Reads {
        names,
        found: false,
    };
    let root = match w {
        Where::Op(op) => Node::Op(op),
        other => Node::Where(other),
    };
    visit(root, &mut v);
    v.found
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        debug_assert!(tokens.last().is_some_and(|t| t.kind == TokType::Eof));
        Self {
            tokens,
            pos: 0,
            defer_lookup: false,
            bare_directives: true,
            depth: 0,
        }
    }

    /// Run `f` with the scope depth set to `d`, restoring it afterwards (also on
    /// the error path, so a speculative read that fails leaves the depth intact).
    fn with_depth<T>(&mut self, d: usize, f: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        let saved = self.depth;
        self.depth = d;
        let out = f(self);
        self.depth = saved;
        out
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
        self.fail_at(self.peek().pos, msg)
    }
    /// A parse error positioned at `pos` (a node already read) rather than at
    /// the cursor.
    fn fail_at<T>(&self, pos: usize, msg: impl AsRef<str>) -> Result<T> {
        Err(OqxError::parse(format!(
            "{} (at offset {pos})",
            msg.as_ref()
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
        if let Some(mut directive) = self.try_op(false, false)? {
            if !self.at(TokType::Eof) && (self.at(TokType::LBracket) || self.at_block().is_some()) {
                // A longer chain whose outermost node is still a directive
                // (`people first { } first { }` — how `people[p][0]` prints back).
                let save = self.pos;
                match self.parse_postfix(Some(Expr::Op(Box::new(directive.clone())))) {
                    Ok(Expr::Op(op)) if self.at(TokType::Eof) => directive = *op,
                    Ok(_) => self.pos = save,
                    Err(e) if e.stage == crate::errors::Stage::Parse => self.pos = save,
                    Err(e) => return Err(e),
                }
            }
            if self.at(TokType::Eof) {
                return Ok(self.query_from_op(directive, start));
            }
            return self.fail(format!(
                "unexpected {} after the top-level directive",
                self.tok_desc()
            ));
        }
        // A bracket chain whose outermost node is a directive is the whole query
        // too (`people[age > 40]` ≡ `people first { where age > 40 }`). Read
        // speculatively: anything else is the body form's business.
        if matches!(
            self.peek().kind,
            TokType::Ident | TokType::Caret | TokType::Binding
        ) {
            let save = self.pos;
            match self.parse_postfix(None) {
                Ok(Expr::Op(op)) if self.at(TokType::Eof) => {
                    return Ok(self.query_from_op(*op, start));
                }
                Ok(_) => {}
                Err(e) if e.stage == crate::errors::Stage::Parse => {}
                Err(e) => return Err(e),
            }
            self.pos = save;
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
                "a query must name its source before its body: `<collection> { … }` (or `<collection> <consumer> { … }`; the clause form `select … from <collection> …` is still read)",
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
            frontier: body.frontier,
            flatten: body.flatten,
            group_by: body.group_by,
            having: body.having,
            distinct: body.distinct,
            values: body.values,
            limit: body.limit,
            offset: body.offset,
            span: self.sp(start),
        })
    }

    // The whole-query form of a directive: its receiver is the source, its block
    // the body, its consumer the query's.
    fn query_from_op(&self, directive: OpNode, start: usize) -> Query {
        let sub = directive.sub;
        Query {
            source: directive.receiver,
            from: sub.from,
            r#where: sub.r#where,
            select: sub.select,
            order_by: sub.order_by,
            consumer: directive.op,
            follow: sub.follow,
            frontier: sub.frontier,
            flatten: sub.flatten,
            group_by: sub.group_by,
            having: sub.having,
            distinct: directive.distinct,
            values: sub.values,
            limit: sub.limit,
            offset: sub.offset,
            span: self.sp(start),
        }
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
        // A top-level body's row clauses (select/where/follow/order by) are read
        // at depth 1, its source and bounds at the root (0); a block's clauses
        // are all at the block's depth, which `parse_consumer_block` set.
        let row_depth = if ctx == BodyCtx::Top { 1 } else { self.depth };

        while !self.at(TokType::Eof) && !self.at(TokType::RBrace) {
            if self.at_word(TokType::Kw, "select") {
                self.enter(&mut stage, Clause::Select, ctx)?;
                self.next();
                if self.at_word(TokType::Ident, "distinct") {
                    self.next();
                    body.distinct = true;
                }
                let (items, values) = self.with_depth(row_depth, |p| p.parse_projection(ctx))?;
                body.select = items;
                body.values = values;
                continue;
            }
            if self.at_word(TokType::Kw, "from") {
                self.enter(&mut stage, Clause::From, ctx)?;
                self.next();
                // At the clause form's top level a consumer word after the source
                // is the whole-query mistake (`from people count`): kept as the
                // hint below, not read as a braceless directive (a count is never
                // a source).
                let bare = self.bare_directives;
                if ctx == BodyCtx::Top {
                    self.bare_directives = false;
                }
                let e = self.parse_value_expr();
                self.bare_directives = bare;
                body.froms.push(e?);
                continue;
            }
            if self.at_word(TokType::Kw, "where") {
                self.enter(&mut stage, Clause::Where, ctx)?;
                self.next();
                body.r#where = Some(self.with_depth(row_depth, |p| p.parse_where())?);
                continue;
            }
            // `frontier P` (0.20) — in a follow destination block the
            // destination's own clause, read in the occurrence's scope whose
            // parent is the walk's enclosing scope: one level OUT of the block's
            // rows (SEMANTICS §20), so `^` there is the enclosing scope, not the
            // frontier row. In any other body it marks the seeds of the body's
            // own `follow` (checked at the end) and is read in the seed's scope,
            // like `where`.
            if self.at_word(TokType::Ident, "frontier") && self.peek_at(1).is_some_and(starts_value)
            {
                self.enter(&mut stage, Clause::Frontier, ctx)?;
                self.next();
                let d = if ctx.is_destination() {
                    row_depth.saturating_sub(1)
                } else {
                    row_depth
                };
                body.frontier = Some(self.with_depth(d, |p| p.parse_value_expr())?);
                continue;
            }
            // `depth n` — a follow destination block's own clause (0.20).
            if ctx.is_destination()
                && self.at_word(TokType::Ident, "depth")
                && self.peek_at(1).is_some_and(|t| t.kind == TokType::Number)
            {
                self.enter(&mut stage, Clause::Depth, ctx)?;
                self.next();
                let v = number_value(&self.next().value);
                if !is_integer(v) || !(1.0..=8.0).contains(&v) {
                    return self.fail("follow depth must be an integer between 1 and 8");
                }
                body.depth = Some(v as u32);
                continue;
            }
            if self.at_follow() {
                self.enter(&mut stage, Clause::Follow, ctx)?;
                body.follow = Some(self.with_depth(row_depth, |p| p.parse_follow())?);
                continue;
            }
            // `flatten <expr> [{ … }] [as <name>]` (0.25): the value is read on
            // each row, like `where`; a brace after a receiver is the
            // receiver-block sugar (the `collect` op), so the block needs no
            // slot of its own.
            if self.at_flatten() {
                self.enter(&mut stage, Clause::Flatten, ctx)?;
                let f = self.with_depth(row_depth, |p| p.parse_flatten(&body.flatten))?;
                body.flatten.push(f);
                continue;
            }
            // `group by k, name: expr` (0.24): the keys are read on the rows, like `where`.
            if self.at_group_by() {
                self.enter(&mut stage, Clause::GroupBy, ctx)?;
                body.group_by = Some(self.with_depth(row_depth, |p| p.parse_group_by())?);
                continue;
            }
            // `having P` (0.24): a predicate over each GROUP, read at the row
            // depth (the group scope sits where the rows did).
            if self.at_having() {
                self.enter(&mut stage, Clause::Having, ctx)?;
                self.next();
                body.having = Some(self.with_depth(row_depth, |p| p.parse_where())?);
                continue;
            }
            if self.at_order_by() {
                self.enter(&mut stage, Clause::OrderBy, ctx)?;
                self.next(); // `order`
                self.next(); // `by`
                body.order_by = Some(self.with_depth(row_depth, |p| p.parse_order_specs())?);
                continue;
            }
            if self.at_bound() {
                let is_limit = self.peek().value == "limit";
                let clause = if is_limit {
                    Clause::Limit
                } else {
                    Clause::Offset
                };
                self.enter(&mut stage, clause, ctx)?;
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
            // the one keyword that may be dropped, and only in first position) — or,
            // in a block, a leading predicate that opens a `where`-first body. After
            // any clause it is an error.
            if stage.is_none()
                && (self.at(TokType::Ident)
                    || self.at(TokType::Binding)
                    || self.at(TokType::Caret)
                    || self.can_start_value())
            {
                match self.with_depth(row_depth, |p| p.parse_leading_run(ctx))? {
                    LeadingRun::Where(w) => {
                        self.enter(&mut stage, Clause::Where, ctx)?;
                        body.r#where = Some(w);
                    }
                    LeadingRun::Projection(items, values) => {
                        self.enter(&mut stage, Clause::Select, ctx)?;
                        body.select = items;
                        body.values = values;
                    }
                }
                continue;
            }
            return self.fail_unexpected_in_body(stage, ctx);
        }
        // Validate the alias references of this body (cycles, a block alias inside
        // a `where` expression, a `select` item naming an item to its right); the
        // surface form is kept. `where` first: its cycle report follows its own path.
        // A grouped body without a projection yields its keys and a count (0.24);
        // the items are synthesized before the alias validation sees the select.
        if let Some(g) = &body.group_by
            && body.select.is_empty()
        {
            body.select = self.default_group_projection(g)?;
        }
        let resolved_where = match &body.r#where {
            Some(w) => match resolve_where(&body.select, w.clone()) {
                Ok(w) => Some(w),
                Err(msg) => return self.fail(msg),
            },
            None => None,
        };
        let resolved_having = match &body.having {
            Some(h) => match resolve_where(&body.select, h.clone()) {
                Ok(h) => Some(h),
                Err(msg) => return self.fail(msg),
            },
            None => None,
        };
        // The resolved items: an aggregate reached through an alias (`n: count(),
        // xs: collect(n)`) is judged where it will be evaluated.
        let resolved_select = match resolve_select(&body.select) {
            Ok(items) => items,
            Err(msg) => return self.fail(msg),
        };
        // Outside a destination block `frontier` marks the seeds of this body's
        // walk, so it needs one.
        if body.frontier.is_some() && body.follow.is_none() && !ctx.is_destination() {
            return self.fail(
                "`frontier` needs a `follow` — a body's `frontier <expr>` marks which of its rows (the walk's seeds) are frontiers; a destination block's marks the occurrences reached through it",
            );
        }
        // Grouping (0.24): `having` needs a `group by`; `distinct` is redundant
        // with one; aggregates may stand only in the post-group clauses; and
        // every bare name read at the group scope must be a key, an alias, or
        // the group's rows.
        if let Some(h) = &body.having
            && body.group_by.is_none()
        {
            return self.fail_at(
                h.span().start,
                "`having` needs a `group by` — `having <pred>` filters the groups a body yields; a per-row filter is `where`",
            );
        }
        let check = GroupCheck {
            select: &body.select,
            resolved_select: &resolved_select,
            having: body.having.as_ref(),
            resolved_having: resolved_having.as_ref(),
            order_by: body.order_by.as_deref(),
            froms: &body.froms,
            r#where: resolved_where.as_ref(),
            frontier: body.frontier.as_ref(),
            flatten: &body.flatten,
            limit: body.limit.as_ref(),
            offset: body.offset.as_ref(),
            group_by: body.group_by.as_ref(),
        };
        match &body.group_by {
            Some(g) => {
                if body.distinct {
                    return self.fail_at(g.span.start, DISTINCT_WITH_GROUP);
                }
                self.check_grouped_body(&check)?;
            }
            None => self.reject_aggregates(&check)?,
        }
        Ok(body)
    }

    // ---- flatten (0.25) -------------------------------------------------------

    // `flatten` is a clause when a value can follow the word; otherwise it is a
    // field name (`select flatten from r`). A value start — or an aggregate call
    // whose name is a consumer word (`flatten collect(x)`), admitted so the
    // aggregate check can name it.
    fn at_flatten(&self) -> bool {
        if !self.at_word(TokType::Ident, "flatten") {
            return false;
        }
        let Some(nx) = self.peek_at(1) else {
            return false;
        };
        starts_value(nx)
            || (nx.kind == TokType::Ident
                && AggregateName::from_word(&nx.value).is_some()
                && self.peek_at(2).is_some_and(|t| t.kind == TokType::LParen))
    }

    // `flatten <expr> [as <name>]`. The expression is any value — a block after
    // a receiver is read by the postfix grammar as the implicit `collect` op
    // (0.20), which is exactly the block over the coerced collection SEMANTICS
    // §25 wants. The name defaults to a plain navigation's last segment (as a
    // select item's or a group key's does); anything else needs `as`. Names are
    // unique within the body, never a `$`-name (the language's), a keyword or a
    // literal word.
    fn parse_flatten(&mut self, earlier: &[Flatten]) -> Result<Flatten> {
        let start = self.start();
        self.next(); // `flatten`
        let expr = self.parse_value_expr()?;
        let name = if self.at_word(TokType::Ident, "as") {
            self.next();
            let t = self.peek();
            if t.kind != TokType::Ident {
                return self.fail("expected a name after `as` (`flatten <expr> as <name>`)");
            }
            if LITERAL_WORDS.contains(&t.value.as_str()) {
                return self.fail(format!(
                    "`{}` is a literal and cannot name a flattened value (`flatten <expr> as <name>`)",
                    t.value
                ));
            }
            if t.value.starts_with('$') {
                return self.fail(format!(
                    "a flattened value cannot be bound to a `$`-name (`{}`) — `$` belongs to the language; choose another name",
                    t.value
                ));
            }
            self.next().value
        } else {
            match nav_key(&expr) {
                Some(key) => key.to_owned(),
                None => {
                    let shown = describe(Node::Expr(&expr));
                    return self.fail_at(
                        start,
                        format!(
                            "`flatten {shown}` needs a name (`flatten {shown} as <name>`) — only a plain navigation names itself by its last segment"
                        ),
                    );
                }
            }
        };
        if earlier.iter().any(|f| f.name == name) {
            return self.fail_at(
                start,
                format!(
                    "duplicate flatten name '{name}' — each flatten binds its own name (`flatten <expr> as <other>`)"
                ),
            );
        }
        Ok(Flatten {
            expr,
            name,
            span: self.sp(start),
        })
    }

    // ---- grouping (0.24) ------------------------------------------------------

    // `group by` is a clause only as the two-word sequence (a field named `group`
    // stays a name: `select group from r`).
    fn at_group_by(&self) -> bool {
        self.at_word(TokType::Ident, "group")
            && self
                .peek_at(1)
                .is_some_and(|nx| nx.kind == TokType::Ident && nx.value == "by")
    }

    // `having` is a clause when a predicate can follow it — a value start, or an
    // aggregate call whose name is a consumer word (`having count() > 1`:
    // `count` alone cannot begin a value, `count(` can); otherwise a field name.
    fn at_having(&self) -> bool {
        if !self.at_word(TokType::Ident, "having") {
            return false;
        }
        let Some(nx) = self.peek_at(1) else {
            return false;
        };
        starts_value(nx)
            || (nx.kind == TokType::Ident
                && AggregateName::from_word(&nx.value).is_some()
                && self.peek_at(2).is_some_and(|t| t.kind == TokType::LParen))
    }

    fn parse_group_by(&mut self) -> Result<GroupBy> {
        let start = self.start();
        self.next(); // `group`
        self.next(); // `by`
        let mut keys = vec![self.parse_group_key()?];
        while self.at(TokType::Comma) {
            self.next();
            keys.push(self.parse_group_key()?);
        }
        let mut seen: HashSet<&str> = HashSet::new();
        for k in &keys {
            if !seen.insert(&k.name) {
                return self.fail_at(
                    k.span.start,
                    format!(
                        "duplicate group key '{}' — each key needs its own name (alias one: `other: expr`)",
                        k.name
                    ),
                );
            }
        }
        Ok(GroupBy {
            keys,
            span: self.sp(start),
        })
    }

    // One key, shaped like a select item: `name: expr`, or an unaliased navigation
    // keyed by its last segment; any other expression needs the alias, because the
    // alias is how the post-group clauses refer to the key.
    fn parse_group_key(&mut self) -> Result<GroupKey> {
        let start = self.start();
        if self.at(TokType::Ident) && self.peek_at(1).is_some_and(|t| t.kind == TokType::Colon) {
            let name = self.next().value;
            self.next(); // ':'
            let expr = self.parse_value_expr()?;
            return Ok(GroupKey {
                name,
                expr,
                span: self.sp(start),
            });
        }
        if !self.can_start_value() {
            return self.fail(
                "expected a group key after `group by` (`group by <name>` or `group by <alias>: <expr>`)",
            );
        }
        let expr = self.parse_value_expr()?;
        let Some(name) = nav_key(&expr).map(str::to_owned) else {
            return self.fail_at(
                start,
                format!(
                    "a group key that is not a plain name needs an alias (`group by key: {}`) — the alias is the name the select, `having` and `order by` read it by",
                    describe(Node::Expr(&expr))
                ),
            );
        };
        Ok(GroupKey {
            name,
            expr,
            span: self.sp(start),
        })
    }

    // `name(` where `name` is an aggregate: `count()`, `sum(e)`, `collect(distinct
    // e)`. The cursor is at the `(`. Arity and the `distinct` modifier are checked
    // here; WHERE the aggregate may stand is the body's business (`check_grouped_body`).
    fn parse_aggregate(&mut self, name: AggregateName, start: usize) -> Result<Expr> {
        self.next(); // '('
        let mut distinct = false;
        if self.at_word(TokType::Ident, "distinct") && self.peek_at(1).is_some_and(starts_value) {
            self.next();
            distinct = true;
        }
        let mut arg: Option<Box<Expr>> = None;
        if !self.at(TokType::RParen) {
            arg = Some(Box::new(self.parse_value_expr()?));
            if self.at(TokType::Comma) {
                return self.fail(format!(
                    "`{}(…)` takes one argument — an aggregate reduces one expression over the group's rows",
                    name.as_str()
                ));
            }
        }
        if !self.at(TokType::RParen) {
            return self.fail(format!("expected ')' to close `{}(…)`", name.as_str()));
        }
        self.next();
        if arg.is_none() && name != AggregateName::Count {
            return self.fail(format!(
                "`{n}()` needs an argument (`{n}(<expr>)`) — only `count()` counts the group's rows without one",
                n = name.as_str()
            ));
        }
        if distinct && name.is_predicate() {
            return self.fail(format!(
                "`{}(distinct …)`: `distinct` applies to a value aggregate (count, sum, min, max, avg, collect, first, last), not to a predicate aggregate",
                name.as_str()
            ));
        }
        Ok(Expr::Aggregate {
            name,
            arg,
            distinct,
            span: Span::new(start, self.end()),
        })
    }

    // A free call: an aggregate node for an aggregate name (reserved since 0.24),
    // an ordinary `call` otherwise. The cursor is at the `(`.
    fn parse_free_call(&mut self, name: String, start: usize) -> Result<Expr> {
        if let Some(agg) = AggregateName::from_word(&name) {
            return self.parse_aggregate(agg, start);
        }
        let args = self.parse_args()?;
        Ok(Expr::Call {
            recv: None,
            name,
            args,
            span: self.sp(start),
        })
    }

    // The clauses an aggregate may NOT stand in — every clause read before the
    // rows are grouped (`from`, `where`, `frontier`, the keys, the bound) — and,
    // in a body without `group by`, every clause. The `where` is the alias-resolved
    // one, so an aggregate reached through a select alias is caught too.
    fn reject_aggregates(&self, b: &GroupCheck<'_>) -> Result<()> {
        let mut found: Vec<(&Expr, &'static str)> = Vec::new();
        fn push_all<'a>(
            found: &mut Vec<(&'a Expr, &'static str)>,
            exprs: impl IntoIterator<Item = &'a Expr>,
            clause: &'static str,
        ) {
            let mut out = Vec::new();
            for e in exprs {
                aggregates_in(e, &mut out);
            }
            found.extend(out.into_iter().map(|a| (a, clause)));
        }
        if let Some(w) = b.r#where {
            let mut out = Vec::new();
            where_aggregates(w, &mut out);
            found.extend(out.into_iter().map(|a| (a, "`where`")));
        }
        push_all(&mut found, b.froms, "`from`");
        push_all(&mut found, b.frontier, "`frontier`");
        push_all(&mut found, b.flatten.iter().map(|f| &f.expr), "`flatten`");
        push_all(&mut found, b.limit, "`limit`");
        push_all(&mut found, b.offset, "`offset`");
        if let Some(g) = b.group_by {
            push_all(
                &mut found,
                g.keys.iter().map(|k| &k.expr),
                "a `group by` key",
            );
        }
        if b.group_by.is_none() {
            push_all(
                &mut found,
                b.resolved_select.iter().filter_map(|it| match it {
                    SelectItem::Field { expr, .. } => Some(expr),
                    SelectItem::Collect { .. } => None,
                }),
                "a select item",
            );
            if let Some(o) = b.order_by {
                push_all(&mut found, o.iter().map(|o| &o.expr), "`order by`");
            }
        }
        let Some((agg, clause)) = found.first() else {
            return Ok(());
        };
        if b.group_by.is_none() {
            return self.fail_at(
                agg.span().start,
                format!(
                    "`{}` is an aggregate: it is read after grouping and may stand only in a select item, `having` or `order by` of a body with `group by` — this body has none",
                    describe(Node::Expr(agg))
                ),
            );
        }
        self.fail_at(
            agg.span().start,
            format!(
                "`{}` is an aggregate and cannot be read in {clause}{} — the rows are not grouped yet there; aggregates stand in a select item, `having` or `order by`",
                describe(Node::Expr(agg)),
                if *clause == "`where`" {
                    " (a select alias standing for one included)"
                } else {
                    ""
                }
            ),
        )
    }

    // A grouped body: aggregates only after the grouping (and never nested), and
    // every bare name at the group scope a key, an alias, or the group's rows.
    fn check_grouped_body(&self, b: &GroupCheck<'_>) -> Result<()> {
        self.reject_aggregates(b)?;
        // An aggregate's argument is read on the group's rows, where there is no
        // group to aggregate: `sum(count())` is an error, not a double reduction.
        let mut post: Vec<&Expr> = Vec::new();
        for it in b.resolved_select {
            if let SelectItem::Field { expr, .. } = it {
                aggregates_in(expr, &mut post);
            }
        }
        if let Some(h) = b.resolved_having {
            where_aggregates(h, &mut post);
        }
        if let Some(o) = b.order_by {
            for s in o {
                aggregates_in(&s.expr, &mut post);
            }
        }
        if let Some(nested) = nested_aggregate(&post) {
            return self.fail_at(
                nested.span().start,
                format!(
                    "`{}`: an aggregate cannot nest — its argument is read on each of the group's rows, where there is no group to reduce",
                    describe(Node::Expr(nested))
                ),
            );
        }
        let group_by = b.group_by.expect("a grouped body");
        // The names a position at the group scope may read: the keys, the
        // group values (`rows`, `$it`, `$key`) and the aliases given.
        fn valid<'k>(group_by: &'k GroupBy, aliases: &[&'k str]) -> HashSet<&'k str> {
            group_by
                .keys
                .iter()
                .map(|k| k.name.as_str())
                .chain(GROUP_SCOPE_NAMES)
                .chain(aliases.iter().copied())
                .collect()
        }
        let mut aliases: Vec<&str> = Vec::new();
        for it in b.select {
            let names = valid(group_by, &aliases);
            match it {
                SelectItem::Field { expr, .. } => {
                    self.check_group_expr(expr, &names, "a select item", None)?;
                }
                SelectItem::Collect { op, .. } => {
                    self.check_group_expr(&op.receiver, &names, "a select item", None)?;
                }
            }
            let own = match it {
                SelectItem::Collect { name, .. } => (!name.is_empty()).then_some(name.as_str()),
                SelectItem::Field { name, lift: 0, .. } => {
                    (!name.is_empty()).then_some(name.as_str())
                }
                SelectItem::Field { .. } => None,
            };
            if let Some(o) = own {
                aliases.push(o);
            }
        }
        if let Some(h) = b.having {
            self.check_group_where(h, &valid(group_by, &aliases), "`having`")?;
        }
        if let Some(o) = b.order_by {
            let names = valid(group_by, &[]);
            for s in o {
                self.check_group_expr(&s.expr, &names, "`order by`", None)?;
            }
        }
        Ok(())
    }

    fn check_group_where(&self, w: &Where, valid: &HashSet<&str>, clause: &str) -> Result<()> {
        match w {
            Where::And { parts, .. } | Where::Or { parts, .. } => parts
                .iter()
                .try_for_each(|p| self.check_group_where(p, valid, clause)),
            Where::Not { expr, .. } => self.check_group_where(expr, valid, clause),
            Where::Scalar { expr, .. } => self.check_group_expr(expr, valid, clause, None),
            // the block is its own scope
            Where::Op(op) => self.check_group_expr(&op.receiver, valid, clause, None),
        }
    }

    // Every bare name `e` reads at the group scope (an aggregate's argument reads
    // the group's rows and is not checked; a nested block is its own scope, only
    // its receiver is read here). `in_call` names the enclosing non-aggregate free
    // call, for the "not an aggregate" hint.
    fn check_group_expr(
        &self,
        e: &Expr,
        valid: &HashSet<&str>,
        clause: &str,
        in_call: Option<&str>,
    ) -> Result<()> {
        let again = |x: &Expr| self.check_group_expr(x, valid, clause, in_call);
        match e {
            Expr::Ident { name, span } => {
                if valid.contains(name.as_str()) {
                    return Ok(());
                }
                let hint = match in_call {
                    None => String::new(),
                    Some(c) => format!(
                        "; `{c}(…)` is not an aggregate — the aggregates are {}",
                        AggregateName::WORDS.join(", ")
                    ),
                };
                self.fail_at(
                    span.start,
                    format!(
                        "`{name}` is not a group key or aggregate — {clause} of a grouped body reads the group: a key (`group by {name}`), an aggregate over its rows (`collect({name})`), or the rows themselves (`rows collect {{ select {name} }}`){hint}"
                    ),
                )
            }
            Expr::Lit { .. }
            | Expr::Binding { .. }
            | Expr::Outer { .. }
            | Expr::Aggregate { .. } => Ok(()),
            Expr::Member { recv, .. } => again(recv),
            Expr::Call {
                recv, name, args, ..
            } => {
                if let Some(r) = recv {
                    again(r)?;
                }
                let inner = if recv.is_none() {
                    Some(name.as_str())
                } else {
                    in_call
                };
                args.iter()
                    .try_for_each(|a| self.check_group_expr(a, valid, clause, inner))
            }
            Expr::Unary { expr, .. } | Expr::Required { expr, .. } => again(expr),
            Expr::Binary { left, right, .. }
            | Expr::Logical { left, right, .. }
            | Expr::In { left, right, .. } => {
                again(left)?;
                again(right)
            }
            Expr::Range { lo, hi, .. } => [lo, hi].into_iter().flatten().try_for_each(|b| again(b)),
            Expr::Tuple { items, .. } => items.iter().try_for_each(again),
            Expr::Template { parts, .. } => template_exprs(parts).try_for_each(again),
            Expr::Op(op) => again(&op.receiver),
        }
    }

    // The projection of a grouped body that writes none (SEMANTICS §24): every key
    // by its name, then `count: count()`. Synthesized here so the tree shows what
    // the body projects and the engine has no grouped "row itself" to define; the
    // nodes carry the empty span (they did not come from source).
    fn default_group_projection(&self, group_by: &GroupBy) -> Result<Vec<SelectItem>> {
        if group_by.keys.iter().any(|k| k.name == "count") {
            return self.fail_at(
                group_by.span.start,
                "a group key named `count` needs an explicit `select` — the default projection of a grouped body is its keys plus `count: count()`",
            );
        }
        let mut items: Vec<SelectItem> = group_by
            .keys
            .iter()
            .map(|k| SelectItem::Field {
                name: k.name.clone(),
                expr: Expr::Ident {
                    name: k.name.clone(),
                    span: Span::EMPTY,
                },
                lift: 0,
                span: Span::EMPTY,
            })
            .collect();
        items.push(SelectItem::Field {
            name: "count".to_owned(),
            expr: Expr::Aggregate {
                name: AggregateName::Count,
                arg: None,
                distinct: false,
                span: Span::EMPTY,
            },
            lift: 0,
            span: Span::EMPTY,
        });
        Ok(items)
    }

    // The keyword-less run that opens a body. At the top level it is always the
    // projection. In a block it is a `where`-first body when the leading
    // expression is SYNTACTICALLY a predicate (GRAMMAR §2): the run is read as a
    // where tree first; if that tree is predicate-shaped — anything but a bare
    // name, a dotted navigation or a lift, with a parenthesized expression
    // counting as a predicate — and is not the item of a `values` projection, it
    // is the `where`. Otherwise the tokens are re-read as the projection. When
    // both readings fail, the error that got further wins (the farthest-failure
    // rule), so a mistake deep inside `{ jobs exists { … } }` is reported where it is.
    fn parse_leading_run(&mut self, ctx: BodyCtx) -> Result<LeadingRun> {
        if ctx != BodyCtx::Top {
            let save = self.pos;
            let first_kind = self.peek().kind;
            self.defer_lookup = true;
            let speculative = self.parse_where();
            self.defer_lookup = false;
            let mut spec_err: Option<(OqxError, usize)> = None;
            match speculative {
                Ok(w) => {
                    if predicate_shaped(&w, first_kind) && !self.at_word(TokType::Ident, "values") {
                        if self.at(TokType::Comma) {
                            return self.fail(format!(
                                "a leading predicate starts a `where`-first body, which has no projection — write the projection first: `{{ <projection> where {} }}`",
                                describe(Node::Where(&w))
                            ));
                        }
                        self.reject_bare_lookups(&w)?;
                        return Ok(LeadingRun::Where(w));
                    }
                }
                Err(e) if e.stage == crate::errors::Stage::Parse => spec_err = Some((e, self.pos)),
                Err(e) => return Err(e),
            }
            self.pos = save;
            if let Some((err, spec_pos)) = spec_err {
                return match self.parse_projection(ctx) {
                    Ok((items, values)) => Ok(LeadingRun::Projection(items, values)),
                    Err(e) if e.stage == crate::errors::Stage::Parse && self.pos < spec_pos => {
                        Err(err)
                    }
                    Err(e) => Err(e),
                };
            }
        }
        let (items, values) = self.parse_projection(ctx)?;
        Ok(LeadingRun::Projection(items, values))
    }

    fn enter(&self, stage: &mut Option<Clause>, clause: Clause, ctx: BodyCtx) -> Result<()> {
        // `flatten` is the one clause that may repeat (0.25): each fans out the
        // rows the previous produced.
        if *stage == Some(clause) && clause != Clause::Flatten {
            return self.fail(format!("duplicate `{}` clause", clause.as_str()));
        }
        if stage.is_some_and(|last| clause < last) {
            let last = stage.expect("checked above");
            return self.fail(format!(
                "`{}` must come before `{}` — OQX clause order is {}",
                clause.as_str(),
                last.as_str(),
                clause_order_sentence(ctx)
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
        let remaining = clauses_of(ctx)
            .filter(|c| stage.is_none_or(|s| *c > s))
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
                    "depth" if !ctx.is_destination() => {
                        return self.fail(format!(
                            "unexpected 'depth' after `{last}` — `depth` is a clause of a follow destination block only (`follow <relation> {{ depth 2 }}`)"
                        ));
                    }
                    "depth" => {
                        return self
                            .fail("expected an integer after `depth` (`depth 1`..`depth 8`)");
                    }
                    "frontier" => {
                        return self.fail(format!(
                            "unexpected 'frontier' after `{last}` — `frontier` takes an expression (`frontier <expr>`) and belongs to a body that has a `follow`"
                        ));
                    }
                    "flatten" => {
                        return self.fail(format!(
                            "unexpected 'flatten' after `{last}` — `flatten` takes a value to split into rows (`flatten <expr> [{{ … }}] [as <name>]`)"
                        ));
                    }
                    "group" => {
                        return self.fail(format!(
                            "unexpected 'group' after `{last}` — a grouping is written `group by <key>[, <key>…]` (a key is a name or `alias: <expr>`)"
                        ));
                    }
                    "having" => {
                        return self.fail(format!(
                            "unexpected 'having' after `{last}` — `having` takes a predicate over each group (`having count() > 1`) and belongs to a body that has a `group by`"
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
            // `{ name, rel exists { … } }`: the leading items were read as the
            // projection, so the consumer word is where the mistake shows.
            Some(Clause::Select) if consumer_word => self.fail(format!(
                "unexpected `{v}` after a projection — a consumer test is a predicate: write `where <relation> {v} {{ … }}` after the projection (a block may lead with a predicate only when nothing is projected); a nested block in a projection needs a name (`name: <relation> collect {{ … }}`)"
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

    /// Whether the token `n` ahead can head a scope reference: a `^` run, or
    /// the `N^` of an absolute reference.
    fn at_scope_ref_at(&self, n: usize) -> bool {
        self.peek_at(n).is_some_and(|t| t.kind == TokType::Caret) || self.at_absolute_ref_at(n)
    }

    /// `N^` — an unsigned integer literal (digits only) immediately followed by
    /// a caret, no whitespace between: an absolute scope reference (GRAMMAR §4).
    /// `1 ^x` is not one (the `^` then fails as a stray token), nor is `1.0^x`.
    fn at_absolute_ref(&self) -> bool {
        self.at_absolute_ref_at(0)
    }
    fn at_absolute_ref_at(&self, n: usize) -> bool {
        let (Some(t), Some(nx)) = (self.peek_at(n), self.peek_at(n + 1)) else {
            return false;
        };
        t.kind == TokType::Number
            && !t.value.is_empty()
            && t.value.bytes().all(|b| b.is_ascii_digit())
            && nx.kind == TokType::Caret
            && nx.pos == t.end
    }

    /// The head of an outer reference or a lift: a run of carets (one scope out
    /// per caret), or an absolute reference `N^` (scope N, GRAMMAR §4), both as
    /// the number of scopes out from the current depth. Returns 0 when there is
    /// none. The absolute form is checked before anything is consumed, so a
    /// failing lookahead (`try_op`) leaves the cursor on the integer.
    fn parse_scope_ref(&mut self) -> Result<usize> {
        if self.at_absolute_ref() {
            let n = self.peek().clone();
            let target: usize = n.value.parse().unwrap_or(usize::MAX);
            if target >= self.depth {
                return self.fail(format!(
                    "scope {} does not enclose this block (the current scope is depth {})",
                    n.value, self.depth
                ));
            }
            self.next(); // the integer
            self.next(); // the caret
            return Ok(self.depth - target);
        }
        Ok(self.parse_carets())
    }

    /// Whether the cursor is at something that can begin a `follow` destination:
    /// a name, a binding, a scope reference, or a tuple's `(`.
    fn at_destination_start(&self) -> bool {
        matches!(
            self.peek().kind,
            TokType::Ident | TokType::Binding | TokType::LParen
        ) || self.at_scope_ref_at(0)
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
            && (self.peek_at(1).is_some_and(|nx| {
                matches!(nx.kind, TokType::Ident | TokType::Binding | TokType::LParen)
            }) || self.at_scope_ref_at(1))
    }

    // ---- follow ---------------------------------------------------------------
    // `follow [distinct] dest { "," dest }` — since 0.20 without an options block.
    fn parse_follow(&mut self) -> Result<Follow> {
        let start = self.start();
        self.next(); // `follow`
        let mut distinct = false;
        // After `follow`, `distinct` is a keyword (a relation literally named
        // `distinct` is not supported); it must be followed by the relation.
        if self.at_word(TokType::Ident, "distinct") {
            self.next();
            distinct = true;
            if !self.at_destination_start() {
                return self.fail(
                    "expected a relation after `follow distinct` (`follow distinct <relation>`)",
                );
            }
        }
        let mut destinations = vec![self.parse_follow_destination()?];
        while self.at(TokType::Comma) {
            self.next();
            if !self.at_destination_start() {
                return self
                    .fail("expected a relation after ',' (`follow <relation>, <relation>`)");
            }
            destinations.push(self.parse_follow_destination()?);
        }
        Ok(Follow {
            destinations,
            distinct,
            span: self.sp(start),
        })
    }

    // One `follow` destination: a receiver (a binding, a dotted name — headed by
    // a bare name, an outer reference or a free-function call — or a tuple) that
    // is either a plain relation of the current row or, when a block follows, a
    // destination block. The block is what `try_op` recognizes in select
    // position — `{ … }` (the implicit `collect`), `distinct { … }`, or a
    // consumer word and `{` / `distinct {` — read with the destination flag so
    // its body admits `frontier` and `depth`. Only collect/first/single yield
    // rows to walk; the where-position tests are rejected by name. A receiver
    // headed by an outer reference can never be a plain destination (plain
    // destinations are relations of the current row), so without a block it is
    // an error naming the block spellings.
    fn parse_follow_destination(&mut self) -> Result<FollowDestination> {
        let outer = self.at_scope_ref_at(0);
        if let Some(op) = self.try_op(false, true)? {
            if !matches!(
                op.op,
                Consumer::Collect | Consumer::First | Consumer::Single
            ) {
                return self.fail(format!(
                    "a follow destination must use collect/first/single, not `{}` (exists/none/count are where-position tests)",
                    op.op.as_str()
                ));
            }
            return Ok(FollowDestination::Block(Box::new(op)));
        }
        if outer {
            return self.fail(
                "`follow` takes a relation of the current row (`follow <relation>`); an outer reference walks a root collection only as a destination block — `follow ^docs { where … }` or `follow ^docs collect { … }`",
            );
        }
        Ok(FollowDestination::Relation(self.parse_receiver()?))
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
        if self.at(TokType::LParen) {
            if let Some(t) = self.try_tuple()? {
                return Ok(t);
            }
            return self.fail(
                "expected a collection navigation (a property/relation name) or a tuple `(a, b)`",
            );
        }
        let start = self.start();
        let levels = self.parse_scope_ref()?;
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
            expr = self.parse_free_call(name.clone(), start)?;
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
                    if matches!(it, SelectItem::Collect { .. }) {
                        return self.fail(
                            "a nested block in a projection needs a name (`name: <relation> collect { … }`); as a predicate, a consumer test is written `where <relation> exists { … }`",
                        );
                    }
                    if ctx == BodyCtx::Top {
                        return self.fail(
                            "a leading expression is a projection (select): an item that is not a plain name needs an alias (`name: expr`) or `values`; to filter by it write `<collection> { <predicate> }`, or write `where …` after `from` — at the top level of the clause form a predicate is never implicit (the clause order puts `from` first)",
                        );
                    }
                    return self.fail(
                        "an item that is not a plain name needs an alias (`name: expr`) or `values`; to filter by it write `where …` after the projection (a block may lead with a predicate only when nothing is projected: `{ age > 18 }`)",
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
        // error there. `N^name:` is the lift into scope N (GRAMMAR §4).
        let lift = self.parse_scope_ref()?;
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
            if let Some(op) = self.try_op(false, false)? {
                // `name: jobs first { }.pay`: the directive is the head of a longer value.
                if self.at_scalar_continuation() || self.at_block().is_some() {
                    let expr = self.parse_or(Some(Expr::Op(Box::new(op))))?;
                    return self.finish_item(name, expr, lift, start);
                }
                if !matches!(
                    op.op,
                    Consumer::Collect | Consumer::First | Consumer::Single | Consumer::Count
                ) {
                    return self.fail(format!(
                        "projection '{name}' must use collect/first/single/count, not {} (exists/none are where-position tests; `count {{ … }}` is a value since 0.24)",
                        op.op.as_str()
                    ));
                }
                return self.finish_item(name, Expr::Op(Box::new(op)), lift, start);
            }
            let expr = self.parse_value_expr()?;
            return self.finish_item(name, expr, lift, start);
        }
        // Unaliased item: a bare/dotted navigation (under any `!`) keys by its
        // last segment; any other expression is unnamed ("") — legal only under
        // `values` (checked by parse_projection, which sees the whole list).
        let expr = self.parse_value_expr()?;
        let name = nav_key(&expr).unwrap_or("").to_string();
        self.finish_item(name, expr, lift, start)
    }

    // An item from its value: exactly a directive (written out, or the bracket
    // sugar) is the `collect` item kind; anything else is a `field`.
    fn finish_item(
        &self,
        name: String,
        expr: Expr,
        lift: usize,
        start: usize,
    ) -> Result<SelectItem> {
        if let Expr::Op(op) = expr {
            if lift > 0 {
                return self.fail(format!(
                    "a lift (^{name}) value must be a scalar expression, not {} {{ … }}",
                    op.op.as_str()
                ));
            }
            return Ok(SelectItem::Collect {
                name,
                op,
                span: self.sp(start),
            });
        }
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
        if !self.at_or() {
            return Ok(left);
        }
        let mut parts = vec![left];
        while self.at_or() {
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
        if !self.at_and() {
            return Ok(left);
        }
        let mut parts = vec![left];
        while self.at_and() {
            self.next();
            parts.push(self.parse_where_primary()?);
        }
        Ok(Where::And {
            parts,
            span: self.sp(start),
        })
    }

    // `&&` / `and` and `||` / `or` are one operator each (0.17): the words are
    // exact synonyms of the symbols, parsed to the same nodes.
    fn at_and(&self) -> bool {
        self.at_op("&&") || self.at_word(TokType::Kw, "and")
    }
    fn at_or(&self) -> bool {
        self.at_op("||") || self.at_word(TokType::Kw, "or")
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
        // Leading negations: `!`, `not` (one each) and `is` (two — `is x` ≡ `!!x`).
        let mut not_starts: Vec<usize> = Vec::new();
        loop {
            if self.at_op("!") || self.at_word(TokType::Kw, "not") {
                not_starts.push(self.next().pos);
            } else if self.at_word(TokType::Kw, "is") {
                let p = self.next().pos;
                not_starts.push(p);
                not_starts.push(p);
            } else {
                break;
            }
        }
        if self.at(TokType::LParen) {
            // A tuple (0.20) is a value, not a group: the receiver of a consumer
            // test (`(a, b) exists { }`) or a scalar operand (`(a, b).size() > 1`).
            if let Some(tuple) = self.try_tuple()? {
                if let Some(op) = self.at_block() {
                    let op = self.parse_consumer_block(tuple, op, true, false)?;
                    let op = self.finish_where_op(op)?;
                    return Ok(wrap_not(Where::Op(Box::new(op)), &not_starts));
                }
                let mut e = self.parse_postfix(Some(tuple))?;
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
        // A `first`/`single` directive is a value, never a test: the scalar
        // grammar reads it (as a value-position directive) with whatever follows
        // it, and `reject_bare_lookup` turns a bare one into the lookup error.
        if let Some(op) = self.try_op(true, false)?
            && !matches!(op.op, Consumer::First | Consumer::Single)
        {
            let op = self.finish_where_op(op)?;
            return Ok(wrap_not(Where::Op(Box::new(op)), &not_starts));
        }
        // A scalar leaf, re-read from the first `!` so the scalar grammar gives `!`
        // its one precedence (tighter than comparison). A leaf whose whole value is
        // a negation keeps the `not` node shape (`where !active`).
        self.pos = start;
        let expr = self.parse_cmp(None)?;
        let leaf = scalar_leaf(expr);
        if !self.defer_lookup {
            self.reject_bare_lookup(&leaf)?;
        }
        Ok(leaf)
    }

    // A where leaf that is exactly a `first`/`single` directive (under any `!`)
    // is the select-position lookup error: a lookup is a value, and alone in
    // `where` the writer almost certainly meant `exists`.
    fn reject_bare_lookup(&self, w: &Where) -> Result<()> {
        let mut core = w;
        while let Where::Not { expr, .. } = core {
            core = expr;
        }
        let Where::Scalar { expr, .. } = core else {
            return Ok(());
        };
        let mut e = expr;
        while let Expr::Unary {
            op: UnaryOp::Not,
            expr,
            ..
        } = e
        {
            e = expr;
        }
        if let Expr::Op(op) = e
            && matches!(op.op, Consumer::First | Consumer::Single)
        {
            return self.fail(format!(
                "{} {{ … }} is a select-position lookup; in where use exists {{ … }} / none {{ … }} or count {{ … }} <op> N (`x[p]` is `x first {{ where p }}`; a lookup is a value — compare it, navigate it or require it: `x[p].name == …`, `x[0]!`)",
                op.op.as_str()
            ));
        }
        Ok(())
    }

    // `reject_bare_lookup` over every leaf of a tree read with `defer_lookup` on.
    fn reject_bare_lookups(&self, w: &Where) -> Result<()> {
        match w {
            Where::And { parts, .. } | Where::Or { parts, .. } => {
                parts.iter().try_for_each(|p| self.reject_bare_lookups(p))
            }
            Where::Not { .. } | Where::Scalar { .. } => self.reject_bare_lookup(w),
            Where::Op(_) => Ok(()),
        }
    }

    // Whether the token after a `)` (or a directive) continues a scalar
    // expression: an operator, `.`-navigation, a bracket, a postfix `!`, a
    // range, `in`, or `is`.
    fn at_scalar_continuation(&self) -> bool {
        let t = self.peek();
        match t.kind {
            TokType::Op => {
                let v = t.value.as_str();
                CMP_OPS.contains(&v) || ADD_OPS.contains(&v) || MUL_OPS.contains(&v) || v == "!"
            }
            TokType::Kw => t.value == "is",
            TokType::Dot | TokType::Range | TokType::LBracket => true,
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

    // Detect + parse a postfix consumer op `<receiver> <consumer> { <sub> }` —
    // or its implicit-`collect` forms `<receiver> { <sub> }` and `<receiver>
    // distinct { <sub> }` (0.20). Returns None (rewinding) when the lookahead
    // is not a consumer op. `in_where` says whether the op sits in where
    // position, where a `collect` block may bind lifts; `destination` marks a
    // follow destination block (its body admits `frontier`/`depth`).
    fn try_op(&mut self, in_where: bool, destination: bool) -> Result<Option<OpNode>> {
        let start = self.pos;
        let start_pos = self.start();
        // An absolute reference that does not enclose this scope is an error only
        // if the tokens do form a directive (`0^docs collect { }` at the root);
        // otherwise the expression grammar gets to read them (a top-level
        // `0^name` item is a lift, with the lift's own error), so the failure is
        // held back until the lookahead has decided.
        let mut scope_err: Option<OqxError> = None;
        let receiver = if self.at(TokType::Binding) {
            binding_node(&self.next())
        } else if self.at(TokType::LParen) {
            // A tuple receiver, `(a, b) { … }`; a single parenthesized expression
            // is grouping and never a receiver.
            match self.try_tuple()? {
                Some(t) => t,
                None => {
                    self.pos = start;
                    return Ok(None);
                }
            }
        } else if self.at(TokType::Ident) || self.at_scope_ref_at(0) {
            let levels = match self.parse_scope_ref() {
                Ok(levels) => levels,
                Err(e) if e.stage == crate::errors::Stage::Parse => {
                    scope_err = Some(e);
                    self.next(); // the integer and the caret, as if it had parsed
                    self.next();
                    1
                }
                Err(e) => return Err(e),
            };
            if !self.at(TokType::Ident) {
                self.pos = start;
                return Ok(None);
            }
            let head = self.next();
            self.parse_nav_from(head, levels, start_pos)?.0
        } else {
            return Ok(None);
        };

        if let Some(op) = self.at_block() {
            if let Some(e) = scope_err {
                return Err(e);
            }
            if let Expr::Ident { name, .. } = &receiver {
                if LITERAL_WORDS.contains(&name.as_str()) {
                    return self.fail(format!("`{name}` is a literal, not a collection"));
                }
                // `count { }` with nothing before it: the consumer word is not a receiver.
                if op == Consumer::Collect
                    && CONSUMERS.contains(&name.as_str())
                    && self.at(TokType::LBrace)
                {
                    return self.fail(format!(
                        "unexpected '{{' after `{name}` — a consumer needs a receiver: `<collection> {name} {{ … }}`"
                    ));
                }
            }
            return Ok(Some(self.parse_consumer_block(
                receiver,
                op,
                in_where,
                destination,
            )?));
        }
        self.pos = start;
        Ok(None)
    }

    // The cursor is at what opens a block over an already-read receiver: `{` or
    // `distinct {` (the implicit `collect`), or a consumer word and `{` /
    // `distinct {`. Consumes nothing.
    fn at_block(&self) -> Option<Consumer> {
        if self.at(TokType::LBrace) {
            return Some(Consumer::Collect);
        }
        if self.at_word(TokType::Ident, "distinct")
            && self.peek_at(1).is_some_and(|t| t.kind == TokType::LBrace)
        {
            return Some(Consumer::Collect);
        }
        self.at_consumer_block()
    }

    // A tuple `(e1, e2, …)` at the cursor's `(` (0.20): two or more
    // comma-separated expressions. A single parenthesized expression is
    // grouping, not a tuple — the cursor is rewound and `None` returned (also
    // on a parse error, so the caller's own reading reports its own error).
    fn try_tuple(&mut self) -> Result<Option<Expr>> {
        let save = self.pos;
        let lparen = self.next().pos; // '('
        let attempt = (|| -> Result<Option<Expr>> {
            let mut items = vec![self.parse_value_expr()?];
            if !self.at(TokType::Comma) {
                return Ok(None);
            }
            while self.at(TokType::Comma) {
                self.next();
                items.push(self.parse_value_expr()?);
            }
            if !self.at(TokType::RParen) {
                return self.fail("expected ')' to close the tuple");
            }
            self.next();
            Ok(Some(Expr::Tuple {
                items,
                span: Span::new(lparen, self.end()),
            }))
        })();
        match attempt {
            Ok(Some(t)) => Ok(Some(t)),
            Ok(None) => {
                self.pos = save;
                Ok(None)
            }
            Err(e) if e.stage == crate::errors::Stage::Parse => {
                self.pos = save;
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    // The cursor is at a consumer word that opens a VALUE-position block —
    // `collect`/`first`/`single`, and since 0.24 `count` (the number of rows
    // the block yields) — then `{` or `distinct {`. `exists`/`none` are
    // predicates only. Consumes nothing.
    fn at_value_directive(&self) -> bool {
        matches!(
            self.at_consumer_block(),
            Some(Consumer::Collect | Consumer::First | Consumer::Single | Consumer::Count)
        )
    }

    // A bracket suffix on `recv` (GRAMMAR §4): `[n]` / `[${…}]` is positional —
    // `recv first { offset n }` — and anything else a predicate —
    // `recv first { where p }`; a trailing `!` makes the index required and the
    // predicate a `single` (required too, so that zero matches is an error).
    fn parse_bracket(&mut self, recv: Expr) -> Result<Expr> {
        if matches!(recv, Expr::Lit { .. } | Expr::Template { .. }) {
            return self.fail(format!(
                "`{}` is a literal, not a collection",
                describe(Node::Expr(&recv))
            ));
        }
        let start = recv.span().start;
        let lbracket = self.next().pos; // '['
        let mut index: Option<Expr> = None;
        let mut r#where: Option<Where> = None;
        let next_is = |p: &Self, n: usize, k: TokType| p.peek_at(n).is_some_and(|t| t.kind == k);
        if self.at(TokType::Number) && next_is(self, 1, TokType::RBracket) {
            let t = self.next();
            let v = number_value(&t.value);
            if !is_integer(v) {
                return self.fail(format!(
                    "an index is a non-negative integer literal or a binding (got {})",
                    t.value
                ));
            }
            index = Some(Expr::Lit {
                value: Value::Number(v),
                span: Span::new(t.pos, t.end),
            });
        } else if self.at(TokType::Binding) && next_is(self, 1, TokType::RBracket) {
            index = Some(binding_node(&self.next()));
        } else if self.at_op("-")
            && next_is(self, 1, TokType::Number)
            && next_is(self, 2, TokType::RBracket)
        {
            return self.fail(
                "negative indices are not supported (`x[-1]`): an index is a non-negative integer literal or a binding",
            );
        } else {
            let defer = self.defer_lookup;
            self.defer_lookup = false;
            // The predicate is the block's `where`: read in the rows' scope, one deeper.
            let depth = self.depth + 1;
            let w = self.with_depth(depth, |p| p.parse_where());
            self.defer_lookup = defer;
            r#where = Some(w?);
        }
        if !self.at(TokType::RBracket) {
            return self.fail("expected ']' to close the bracket");
        }
        self.next();
        let sub_span = Span::new(lbracket, self.end());
        let sub = |r#where: Option<Where>, offset: Option<Expr>| Subquery {
            from: Vec::new(),
            r#where,
            select: Vec::new(),
            order_by: None,
            follow: None,
            frontier: None,
            depth: None,
            flatten: Vec::new(),
            group_by: None,
            having: None,
            values: false,
            limit: None,
            offset,
            span: sub_span,
        };
        let bang = if self.at_op("!") {
            Some(self.next())
        } else {
            None
        };
        let op = |consumer: Consumer, sub: Subquery, end: usize| OpNode {
            receiver: recv,
            op: consumer,
            sub,
            count_cmp: None,
            distinct: false,
            span: Span::new(start, end),
        };
        if let Some(index) = index {
            let first = op(Consumer::First, sub(None, Some(index)), sub_span.end);
            return Ok(match bang {
                Some(b) => Expr::Required {
                    expr: Box::new(Expr::Op(Box::new(first))),
                    span: Span::new(start, b.end),
                },
                None => Expr::Op(Box::new(first)),
            });
        }
        Ok(match bang {
            Some(b) => Expr::Required {
                expr: Box::new(Expr::Op(Box::new(op(
                    Consumer::Single,
                    sub(r#where, None),
                    b.end,
                )))),
                span: Span::new(start, b.end),
            },
            None => Expr::Op(Box::new(op(
                Consumer::First,
                sub(r#where, None),
                sub_span.end,
            ))),
        })
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
        // Since 0.26 the word alone is the directive over the empty block
        // (`jobs first` ≡ `jobs first { }`): a consumer word right after a
        // complete receiver can be nothing else — except inside the clause
        // form's top-level `from` (`bare_directives`).
        (op_then_brace || op_distinct_brace || self.bare_directives).then_some(op)
    }

    // `[<op>] [distinct] { <sub> }` over an already-parsed receiver; the cursor
    // is at the consumer word, at `distinct`, or at the `{` of the implicit
    // `collect`. `in_where` says whether the op sits in where position, where a
    // `collect` block may bind lifts; `destination` marks a follow destination
    // block (0.20): its body may carry `frontier` and `depth`.
    fn parse_consumer_block(
        &mut self,
        receiver: Expr,
        op: Consumer,
        in_where: bool,
        destination: bool,
    ) -> Result<OpNode> {
        let start = receiver.span().start;
        if self.at(TokType::Ident) && CONSUMERS.contains(&self.peek().value.as_str()) {
            self.next(); // the consumer word (absent for `x { … }`)
        }
        let mut distinct = false;
        if self.at_word(TokType::Ident, "distinct") {
            self.next();
            distinct = true;
        }
        let (body, sub_span) = if self.at(TokType::LBrace) {
            let lbrace = self.next().pos; // '{'
            let ctx = BodyCtx::Block {
                op,
                lifts_allowed: in_where && op == Consumer::Collect,
                destination,
            };
            let defer = self.defer_lookup;
            self.defer_lookup = false;
            // The receiver was read at the enclosing depth; the block's rows are one deeper.
            let depth = self.depth + 1;
            let body = self.with_depth(depth, |p| p.parse_body(ctx));
            self.defer_lookup = defer;
            let body = body?;
            if !self.at(TokType::RBrace) {
                return self.fail(format!(
                    "expected '}}' to close the {} {{ … }} block",
                    op.as_str()
                ));
            }
            self.next();
            // `x collect distinct { group by k }`: the directive's distinct is as
            // redundant as the body's own (checked in parse_body).
            if distinct && let Some(g) = &body.group_by {
                return self.fail_at(g.span.start, DISTINCT_WITH_GROUP);
            }
            (body, self.sp(lbrace))
        } else {
            // A consumer word with no block (0.26) is the directive over the
            // empty block `{ }` — the word was written (only a brace makes a
            // bare `collect`), so nothing more is consumed; the block spans
            // nothing, at the end of the word.
            let end = self.end();
            (BodyClauses::default(), Span::new(end, end))
        };
        let distinct = distinct || body.distinct;
        let sub = Subquery {
            from: body.froms,
            r#where: body.r#where,
            select: body.select,
            order_by: body.order_by,
            follow: body.follow,
            frontier: body.frontier,
            depth: body.depth,
            flatten: body.flatten,
            group_by: body.group_by,
            having: body.having,
            values: body.values,
            limit: body.limit,
            offset: body.offset,
            span: sub_span,
        };
        Ok(self.merge_projection_block(receiver, op, distinct, sub, start))
    }

    // A projection-only block over a `collect`/`first`/`single` directive whose
    // own block projects nothing IS that directive's projection (0.26):
    // `jobs[0] { name }` ≡ `jobs first { name offset 0 }`, `jobs[p] { name }` ≡
    // `jobs first { name where p }`, `jobs[0] { }` ≡ `jobs[0]`. The outer items
    // are read on the very rows the inner block filtered, at the same depth, so
    // the merge is exact — except when the outer block carries a clause of its
    // own (those run AFTER the pick: `jobs[0] { name where pay > 2 }` is the
    // first job, kept only if it pays), when the inner directive dedups
    // (`distinct` compares the projection), or when an outer alias would shadow
    // a bare name the inner `where` reads (`jobs[pay > 2] { pay: employer }`):
    // then the two directives stay.
    fn merge_projection_block(
        &self,
        receiver: Expr,
        op: Consumer,
        distinct: bool,
        sub: Subquery,
        start: usize,
    ) -> OpNode {
        let span = self.sp(start);
        let inner = match receiver {
            Expr::Op(inner)
                if op == Consumer::Collect
                    && matches!(
                        inner.op,
                        Consumer::Collect | Consumer::First | Consumer::Single
                    )
                    && !inner.distinct
                    && inner.count_cmp.is_none()
                    && inner.sub.select.is_empty()
                    && !inner.sub.values
                    && projection_only(&sub)
                    && !inner
                        .sub
                        .r#where
                        .as_ref()
                        .is_some_and(|w| reads_any_of(w, &shadowing_names(&sub.select))) =>
            {
                *inner
            }
            other => {
                return OpNode {
                    receiver: other,
                    op,
                    sub,
                    count_cmp: None,
                    distinct,
                    span,
                };
            }
        };
        let mut merged = inner.sub;
        merged.select = sub.select;
        merged.values = sub.values;
        merged.span = Span::new(merged.span.start, sub.span.end);
        OpNode {
            receiver: inner.receiver,
            op: inner.op,
            sub: merged,
            count_cmp: None,
            distinct,
            span,
        }
    }

    // ---- expression Pratt parser ----------------------------------------------
    // Value position (select/order/follow/source): full boolean+arithmetic. Each
    // level takes an optional already-parsed `left` operand (a directive read by
    // `try_op`, a promoted where-group), so it continues into the operator tail
    // without re-reading its tokens.
    fn parse_value_expr(&mut self) -> Result<Expr> {
        self.parse_or(None)
    }

    fn parse_or(&mut self, left: Option<Expr>) -> Result<Expr> {
        let mut left = self.parse_and(left)?;
        while self.at_or() {
            self.next();
            let right = self.parse_and(None)?;
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

    fn parse_and(&mut self, left: Option<Expr>) -> Result<Expr> {
        let mut left = self.parse_cmp(left)?;
        while self.at_and() {
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
        // `is` / `is not` — identity (SEMANTICS §5b); `is not` is the compound.
        let word = if first == "is" && self.at_word(TokType::Kw, "not") {
            self.next();
            "is not".to_string()
        } else {
            first.clone()
        };
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
                op: BinaryOp::from_word(&word).expect("CMP_OPS membership was checked"),
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

    // Whether the current token is a comparison operator, `in`, or `is`.
    fn at_cmp(&self) -> bool {
        let t = self.peek();
        (t.kind == TokType::Op && CMP_OPS.contains(&t.value.as_str()))
            || self.at_word(TokType::Ident, "in")
            || self.at_word(TokType::Kw, "is")
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
        starts_value(self.peek())
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
        if self.at_op("!")
            || self.at_op("-")
            || self.at_word(TokType::Kw, "is")
            || self.at_word(TokType::Kw, "not")
        {
            let tok = self.next();
            let expr = self.parse_unary(None)?;
            let span = Span::new(tok.pos, expr.span().end);
            // `is x` ≡ `!!x`, `not x` ≡ `!x`: pure sugar, both nodes spanning the sugar.
            if tok.kind == TokType::Kw {
                let not = Expr::Unary {
                    op: UnaryOp::Not,
                    expr: Box::new(expr),
                    span,
                };
                return Ok(if tok.value == "is" {
                    Expr::Unary {
                        op: UnaryOp::Not,
                        expr: Box::new(not),
                        span,
                    }
                } else {
                    not
                });
            }
            let op = UnaryOp::from_word(&tok.value).expect("checked above");
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
                // free function call: name(args) — a bare name read here, not
                // `(f)(x)`; an aggregate name makes it an `Aggregate` node (0.24)
                let Expr::Ident { name, .. } = expr else {
                    unreachable!()
                };
                expr = self.parse_free_call(name, start)?;
            } else if self.at(TokType::LBracket) {
                expr = self.parse_bracket(expr)?;
            } else if self.at_op("!") {
                // Postfix `!`: a `!` right after a complete chain is `required` — OQX
                // never places two operands side by side, so it cannot begin one here.
                let bang = self.next();
                expr = Expr::Required {
                    expr: Box::new(expr),
                    span: Span::new(start, bang.end),
                };
            } else if self.at_value_directive()
                || self.at(TokType::LBrace)
                || (self.at_word(TokType::Ident, "distinct")
                    && self.peek_at(1).is_some_and(|t| t.kind == TokType::LBrace))
            {
                // A value-position directive, `recv first { … }` — how a bracket
                // chain prints back — or the implicit `collect` of a bare `{ … }` /
                // `distinct { … }` (0.20: the receiver-block sugar stands wherever
                // a value does, `size(children { is checked })`), or `count { … }`
                // (a value since 0.24). exists/none have no value form and are
                // left to the body's own error.
                if matches!(expr, Expr::Lit { .. } | Expr::Template { .. }) {
                    return self.fail(format!(
                        "`{}` is a literal, not a collection",
                        describe(Node::Expr(&expr))
                    ));
                }
                let op = self.at_block().expect("checked above");
                expr = Expr::Op(Box::new(self.parse_consumer_block(expr, op, false, false)?));
            } else {
                // Anything else ends the postfix chain.
                break;
            }
        }
        Ok(expr)
    }

    // A template literal (GRAMMAR §4, since 0.21): the cursor is at the opening
    // backtick. The lexer has already split the literal into text runs and
    // `${ … }` interpolations (with balanced braces, so an interpolation may
    // hold a block or another template literal); each interpolation holds one
    // full value expression, read at the current scope depth. `parts`
    // alternates strictly — text, expression, text, … — with a (possibly empty)
    // text part first and last.
    fn parse_template_literal(&mut self) -> Result<Expr> {
        let open = self.next(); // the backtick
        let mut parts = Vec::new();
        let mut text = String::new();
        loop {
            let t = self.peek().clone();
            match t.kind {
                TokType::TmplText => {
                    self.next();
                    text.push_str(&t.value);
                }
                TokType::TmplEnd => {
                    self.next();
                    break;
                }
                TokType::TmplInterpStart => {
                    self.next();
                    if self.at(TokType::TmplInterpEnd) {
                        return Err(OqxError::parse(format!(
                            "empty interpolation `${{}}` in a template literal — an interpolation holds an expression (`${{name}}`) (at offset {})",
                            t.pos
                        )));
                    }
                    let e = self.parse_value_expr()?;
                    if !self.at(TokType::TmplInterpEnd) {
                        return self.fail(
                            "expected '}' to close the `${…}` interpolation of a template literal",
                        );
                    }
                    self.next();
                    parts.push(TemplatePart::Text(std::mem::take(&mut text)));
                    parts.push(TemplatePart::Expr(e));
                }
                // Unreachable: the lexer closes every literal it opens or fails.
                _ => {
                    return self.fail(format!(
                        "unexpected {} in a template literal",
                        self.tok_desc()
                    ));
                }
            }
        }
        parts.push(TemplatePart::Text(text));
        Ok(Expr::Template {
            parts,
            span: Span::new(open.pos, self.end()),
        })
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
            // `^name` / `^^name` — an outer reference reading `levels` scopes out — or
            // the absolute `N^name` (0.18). (As a select-item head `^name:` is a lift,
            // handled in parse_select_item; here, in expression position, `^` reads an
            // enclosing row's field even when the current row shadows the name.)
            TokType::Caret | TokType::Number
                if t.kind == TokType::Caret || self.at_absolute_ref() =>
            {
                let levels = self.parse_scope_ref()?;
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
            TokType::TmplStart => self.parse_template_literal(),
            TokType::LParen => {
                self.next();
                let e = self.parse_value_expr()?;
                if self.at(TokType::Comma) {
                    // A tuple `(e1, e2, …)` (0.20): two or more elements.
                    let mut items = vec![e];
                    while self.at(TokType::Comma) {
                        self.next();
                        items.push(self.parse_value_expr()?);
                    }
                    if !self.at(TokType::RParen) {
                        return self.fail("expected ')' to close the tuple");
                    }
                    self.next();
                    return Ok(Expr::Tuple {
                        items,
                        span: Span::new(t.pos, self.end()),
                    });
                }
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

/// Whether a token can begin a value expression (see `Parser::can_start_value`).
fn starts_value(t: &Token) -> bool {
    match t.kind {
        TokType::Ident => !CLAUSE_WORDS.contains(&t.value.as_str()),
        TokType::Kw => t.value == "is" || t.value == "not", // the prefix operators
        TokType::Number
        | TokType::Str
        | TokType::Binding
        | TokType::LParen
        | TokType::Caret
        | TokType::TmplStart => true,
        TokType::Op => t.value == "-" || t.value == "!",
        _ => false,
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

// ---- grouping helpers (0.24) --------------------------------------------------

const DISTINCT_WITH_GROUP: &str = "`distinct` is redundant with `group by` — a grouped body already yields one row per distinct key tuple; drop `distinct`";

/// The clauses `check_grouped_body` / `reject_aggregates` look at: the body's
/// own expressions, with `where` (and `resolved_having`) already alias-resolved.
struct GroupCheck<'a> {
    select: &'a [SelectItem],
    /// The items with their aliases substituted (`resolve_select`), for the aggregate checks.
    resolved_select: &'a [SelectItem],
    having: Option<&'a Where>,
    resolved_having: Option<&'a Where>,
    order_by: Option<&'a [OrderSpec]>,
    froms: &'a [Expr],
    r#where: Option<&'a Where>,
    frontier: Option<&'a Expr>,
    flatten: &'a [Flatten],
    limit: Option<&'a Expr>,
    offset: Option<&'a Expr>,
    group_by: Option<&'a GroupBy>,
}

// Every aggregate node in `e` read at THIS scope (a nested block's body is its
// own scope and is not entered; a block's receiver is). An aggregate's argument
// is entered too, so a nested aggregate is found by `nested_aggregate`.
fn aggregates_in<'a>(e: &'a Expr, out: &mut Vec<&'a Expr>) {
    match e {
        Expr::Aggregate { arg, .. } => {
            out.push(e);
            if let Some(a) = arg {
                aggregates_in(a, out);
            }
        }
        Expr::Lit { .. } | Expr::Ident { .. } | Expr::Outer { .. } | Expr::Binding { .. } => {}
        Expr::Member { recv, .. } => aggregates_in(recv, out),
        Expr::Call { recv, args, .. } => {
            if let Some(r) = recv {
                aggregates_in(r, out);
            }
            args.iter().for_each(|a| aggregates_in(a, out));
        }
        Expr::Unary { expr, .. } | Expr::Required { expr, .. } => aggregates_in(expr, out),
        Expr::Binary { left, right, .. }
        | Expr::Logical { left, right, .. }
        | Expr::In { left, right, .. } => {
            aggregates_in(left, out);
            aggregates_in(right, out);
        }
        Expr::Range { lo, hi, .. } => {
            for b in [lo, hi].into_iter().flatten() {
                aggregates_in(b, out);
            }
        }
        Expr::Tuple { items, .. } => items.iter().for_each(|x| aggregates_in(x, out)),
        Expr::Template { parts, .. } => template_exprs(parts).for_each(|x| aggregates_in(x, out)),
        Expr::Op(op) => aggregates_in(&op.receiver, out),
    }
}

fn where_aggregates<'a>(w: &'a Where, out: &mut Vec<&'a Expr>) {
    match w {
        Where::And { parts, .. } | Where::Or { parts, .. } => {
            parts.iter().for_each(|p| where_aggregates(p, out));
        }
        Where::Not { expr, .. } => where_aggregates(expr, out),
        Where::Scalar { expr, .. } => aggregates_in(expr, out),
        Where::Op(op) => aggregates_in(&op.receiver, out),
    }
}

// The first aggregate whose argument holds another (`sum(count())`), if any.
fn nested_aggregate<'a>(found: &[&'a Expr]) -> Option<&'a Expr> {
    found.iter().copied().find(|a| {
        let Expr::Aggregate { arg: Some(arg), .. } = a else {
            return false;
        };
        let mut inner = Vec::new();
        aggregates_in(arg, &mut inner);
        !inner.is_empty()
    })
}

// The default key of an unaliased projection item: the last segment of a bare /
// dotted / outer navigation (`name`, `meta.slug` → "slug", `^name`), else None.
fn nav_key(e: &Expr) -> Option<&str> {
    match e {
        Expr::Ident { name, .. } | Expr::Outer { name, .. } | Expr::Member { name, .. } => {
            Some(name)
        }
        Expr::Required { expr, .. } => nav_key(expr),
        _ => None,
    }
}

// Whether a block's leading run, read as a where tree, is syntactically a
// predicate (GRAMMAR §2): anything but a bare name, a dotted navigation or a
// lift (an `Outer`), with a parenthesized leading expression always a predicate.
fn predicate_shaped(w: &Where, first: TokType) -> bool {
    if first == TokType::LParen {
        return true;
    }
    match w {
        Where::Scalar { expr, .. } => !is_navigation(expr),
        _ => true,
    }
}

fn is_navigation(e: &Expr) -> bool {
    match e {
        Expr::Ident { .. } | Expr::Outer { .. } => true,
        Expr::Member { recv, .. } => is_navigation(recv),
        _ => false,
    }
}

// The canonical text of a node for an error message; a binding shows as its
// `${n}` marker (the printer refuses to turn a bound value into source).
fn describe(node: Node<'_>) -> String {
    let t = print_template(node);
    let mut out = String::new();
    for (i, s) in t.strings.iter().enumerate() {
        out.push_str(s);
        if i < t.count {
            out.push_str(&format!("${{{}}}", t.indices[i]));
        }
    }
    out
}
