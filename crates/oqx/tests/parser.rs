//! Parser conformance against the TypeScript reference: every parse-related
//! assertion in `packages/oqx/test/oqx.test.ts`, plus AST-shape tests for the
//! README tutorial examples so the engine can trust the tree.

use oqx::{
    BinaryOp, Consumer, CountCmp, Expr, Follow, LogicalOp, OpNode, OqxError, OrderSpec, Query,
    RelOp, SelectItem, Stage, Subquery, UnaryOp, Value, Where, parse_string, parse_template,
};

// ---- AST builders -------------------------------------------------------------

fn ident(name: &str) -> Expr {
    Expr::Ident {
        name: name.to_string(),
    }
}
fn outer(levels: usize, name: &str) -> Expr {
    Expr::Outer {
        levels,
        name: name.to_string(),
    }
}
fn binding(index: usize) -> Expr {
    Expr::Binding { index }
}
fn num(n: f64) -> Expr {
    Expr::Lit(Value::Number(n))
}
fn str_(s: &str) -> Expr {
    Expr::Lit(Value::Str(s.to_string()))
}
fn member(recv: Expr, name: &str) -> Expr {
    Expr::Member {
        recv: Box::new(recv),
        name: name.to_string(),
    }
}
fn call(recv: Option<Expr>, name: &str, args: Vec<Expr>) -> Expr {
    Expr::Call {
        recv: recv.map(Box::new),
        name: name.to_string(),
        args,
    }
}
fn bin(op: BinaryOp, l: Expr, r: Expr) -> Expr {
    Expr::Binary {
        op,
        left: Box::new(l),
        right: Box::new(r),
    }
}
fn logical(op: LogicalOp, l: Expr, r: Expr) -> Expr {
    Expr::Logical {
        op,
        left: Box::new(l),
        right: Box::new(r),
    }
}
fn not(e: Expr) -> Expr {
    Expr::Unary {
        op: UnaryOp::Not,
        expr: Box::new(e),
    }
}
fn neg(e: Expr) -> Expr {
    Expr::Unary {
        op: UnaryOp::Neg,
        expr: Box::new(e),
    }
}
fn in_(l: Expr, r: Expr) -> Expr {
    Expr::In {
        left: Box::new(l),
        right: Box::new(r),
    }
}
fn range(lo: Option<Expr>, hi: Option<Expr>, exclusive_end: bool) -> Expr {
    Expr::Range {
        lo: lo.map(Box::new),
        hi: hi.map(Box::new),
        exclusive_end,
    }
}
fn field(name: &str, expr: Expr) -> SelectItem {
    SelectItem::Field {
        name: name.to_string(),
        expr,
        lift: 0,
    }
}
fn lifted(lift: usize, name: &str, expr: Expr) -> SelectItem {
    SelectItem::Field {
        name: name.to_string(),
        expr,
        lift,
    }
}
fn bare(name: &str) -> SelectItem {
    field(name, ident(name))
}
fn scalar(e: Expr) -> Where {
    Where::Scalar { expr: e }
}
fn and(parts: Vec<Where>) -> Where {
    Where::And { parts }
}
fn or(parts: Vec<Where>) -> Where {
    Where::Or { parts }
}
fn wnot(w: Where) -> Where {
    Where::Not { expr: Box::new(w) }
}
fn asc(e: Expr) -> OrderSpec {
    OrderSpec {
        expr: e,
        desc: false,
    }
}
fn desc(e: Expr) -> OrderSpec {
    OrderSpec {
        expr: e,
        desc: true,
    }
}

/// An empty block body.
fn sub() -> Subquery {
    Subquery {
        from: vec![],
        r#where: None,
        select: vec![],
        order_by: None,
        follow: None,
        values: false,
        limit: None,
        offset: None,
    }
}
fn op(receiver: Expr, consumer: Consumer, sub: Subquery) -> OpNode {
    OpNode {
        receiver,
        op: consumer,
        sub,
        count_cmp: None,
        distinct: false,
    }
}
fn wop(o: OpNode) -> Where {
    Where::Op(Box::new(o))
}
fn collect_item(name: &str, o: OpNode) -> SelectItem {
    SelectItem::Collect {
        name: name.to_string(),
        op: Box::new(o),
    }
}

/// A bare `from <source>` collect query with nothing else set.
fn query(source: Expr) -> Query {
    Query {
        source,
        from: vec![],
        r#where: None,
        select: vec![],
        order_by: None,
        consumer: Consumer::Collect,
        follow: None,
        distinct: false,
        values: false,
        limit: None,
        offset: None,
    }
}

fn parse(src: &str) -> Query {
    parse_string(src).unwrap_or_else(|e| panic!("{src:?} should parse: {e}"))
}

fn parse_err(src: &str) -> OqxError {
    let e = parse_string(src)
        .err()
        .unwrap_or_else(|| panic!("{src:?} should fail to parse"));
    assert_eq!(e.stage, Stage::Parse, "{src:?}: {}", e.message);
    e
}

/// Assert a parse error whose message contains every fragment.
fn assert_parse_error(src: &str, fragments: &[&str]) -> OqxError {
    let e = parse_err(src);
    for f in fragments {
        assert!(
            e.message.contains(f),
            "{src:?}: expected {f:?} in {:?}",
            e.message
        );
    }
    e
}

// ---- the acceptance example (tagged-template form) ----------------------------

#[test]
fn acceptance_template_parses_bindings_as_values() {
    // oqx`name, id, title from ${people} where jobs exists { where employer == ${company} && !end_date }`
    let q = parse_template(
        &[
            "name, id, title from ",
            " where jobs exists { where employer == ",
            " && !end_date }",
        ],
        2,
    )
    .unwrap();
    let mut expected = query(binding(0));
    expected.select = vec![bare("name"), bare("id"), bare("title")];
    let mut block = sub();
    // `!end_date` in where position is the where-tree `Not`, not a scalar unary
    block.r#where = Some(and(vec![
        scalar(bin(BinaryOp::Eq, ident("employer"), binding(1))),
        wnot(scalar(ident("end_date"))),
    ]));
    expected.r#where = Some(wop(op(ident("jobs"), Consumer::Exists, block)));
    assert_eq!(q, expected);
}

#[test]
fn template_is_whitespace_insensitive() {
    let a = parse_template(
        &[
            "\n    name, id, title\n    from ",
            "\n    where jobs exists { where employer == ",
            " && !end_date }\n  ",
        ],
        2,
    )
    .unwrap();
    let b = parse_template(
        &[
            "name, id, title from ",
            " where jobs exists { where employer == ",
            " && !end_date }",
        ],
        2,
    )
    .unwrap();
    assert_eq!(a, b);
}

#[test]
fn template_arity_mismatch_is_a_lex_error() {
    let e = parse_template(&["from ", ""], 3).unwrap_err();
    assert_eq!(e.stage, Stage::Lex);
    assert!(e.message.contains("template arity mismatch"));
}

#[test]
fn a_binding_is_a_value_never_source_text() {
    // oqx`name from ${people} where name == ${evil}` with evil = "Bob || true"
    let q = parse_template(&["name from ", " where name == ", ""], 2).unwrap();
    assert_eq!(
        q.r#where,
        Some(scalar(bin(BinaryOp::Eq, ident("name"), binding(1))))
    );
    // a binding in `from` is the source; one after `where age >=` is a value
    let q = parse_template(&["name from ", " where age >= ", ""], 2).unwrap();
    assert_eq!(q.source, binding(0));
    assert_eq!(
        q.r#where,
        Some(scalar(bin(BinaryOp::Ge, ident("age"), binding(1))))
    );
}

// ---- basic collect / projection ----------------------------------------------

#[test]
fn bare_source_with_no_projection() {
    let q = parse("from people where active");
    let mut expected = query(ident("people"));
    expected.r#where = Some(scalar(ident("active")));
    assert_eq!(q, expected);
}

#[test]
fn dotted_projection_keys_default_to_the_last_segment() {
    let q = parse("meta.slug from data");
    assert_eq!(q.select, vec![field("slug", member(ident("meta"), "slug"))]);
    let q = parse("a.b.c from data");
    assert_eq!(
        q.select,
        vec![field("c", member(member(ident("a"), "b"), "c"))]
    );
}

#[test]
fn named_projections_and_value_expressions() {
    let q = parse("label: name, decade: age from people where name == \"Bob\"");
    assert_eq!(
        q.select,
        vec![field("label", ident("name")), field("decade", ident("age"))]
    );
    assert_eq!(
        q.r#where,
        Some(scalar(bin(BinaryOp::Eq, ident("name"), str_("Bob"))))
    );
    let q = parse("label: name, decade: age / 10 from people");
    assert_eq!(
        q.select,
        vec![
            field("label", ident("name")),
            field("decade", bin(BinaryOp::Div, ident("age"), num(10.0)))
        ]
    );
}

#[test]
fn the_optional_select_keyword_is_accepted() {
    let explicit = parse("select name, id from people where name == \"Bob\"");
    let implicit = parse("name, id from people where name == \"Bob\"");
    assert_eq!(explicit, implicit);
    assert_eq!(explicit.select, vec![bare("name"), bare("id")]);
}

// ---- the fixed clause order (ADR-020) ----------------------------------------

#[test]
fn each_of_the_four_legal_leading_forms_parses() {
    let where_age = Some(scalar(bin(BinaryOp::Gt, ident("age"), num(50.0))));
    // select-first, keyword
    let q = parse("select name from people where age > 50");
    assert_eq!(q.select, vec![bare("name")]);
    assert_eq!(q.r#where, where_age);
    // select-first, keyword dropped
    assert_eq!(parse("name from people where age > 50"), q);
    // from-first (no projection)
    let q = parse("from people where age > 50");
    assert_eq!(q.select, vec![]);
    assert_eq!(q.r#where, where_age);
    assert_eq!(q.consumer, Consumer::Collect);
    // receiver + consumer
    let q = parse("people count { where age > 50 }");
    assert_eq!(q.source, ident("people"));
    assert_eq!(q.consumer, Consumer::Count);
    assert_eq!(q.r#where, where_age);
    // inside a block the same rule holds: a leading run is the projection
    let a = parse("people first { name where age > 50 }");
    let b = parse("people first { select name where age > 50 }");
    assert_eq!(a, b);
    assert_eq!(a.consumer, Consumer::First);
    assert_eq!(a.select, vec![bare("name")]);
    assert_eq!(a.r#where, where_age);
}

#[test]
fn out_of_order_clauses_fail_naming_the_fixed_order() {
    const ORDERING: &str =
        "OQX clause order is select, from, where, follow, order by, limit, offset";
    let out_of_order = |src: &str, first: &str, second: &str| {
        assert_parse_error(
            src,
            &[ORDERING, &format!("`{first}` must come before `{second}`")],
        );
    };
    out_of_order("from people select name", "select", "from");
    out_of_order("from people where age > 50 select name", "select", "where");
    out_of_order(
        "name from people order by age where age > 50",
        "where",
        "order by",
    );
    out_of_order(
        "name from people follow jobs where age > 50",
        "where",
        "follow",
    );
    out_of_order("name from people limit 1 order by age", "order by", "limit");
    out_of_order("name from people offset 1 limit 1", "limit", "offset");
    out_of_order(
        "people count { where age > 50 select name }",
        "select",
        "where",
    );
    // a clause appears at most once
    assert_parse_error("from people from jobs", &["duplicate `from`"]);
    assert_parse_error("name from people where a where b", &["duplicate `where`"]);
}

#[test]
fn a_bare_predicate_in_a_block_fails_asking_for_where() {
    let wants_where = |src: &str| {
        assert_parse_error(src, &["write `where ", "never implicit"]);
    };
    wants_where("people exists { age > 50 }");
    wants_where("people exists { !active }");
    wants_where("name from people where jobs exists { employer == \"X\" && !end_date }");
    wants_where("people exists { jobs count {} >= 2 }");
    // …and a bare leading predicate at the top level is the same mistake
    wants_where("!active from people");
    wants_where("age > 40 from people");
    // a bare NAME is a projection, at the top level and in a block alike
    assert_eq!(parse("active from people").select, vec![bare("active")]);
    let q = parse("people first { active }");
    assert_eq!(q.consumer, Consumer::First);
    assert_eq!(q.select, vec![bare("active")]);
    assert_eq!(q.r#where, None);
}

#[test]
fn a_bare_run_after_from_is_an_error_with_the_consumer_hint() {
    assert_parse_error(
        "from people count",
        &[
            "unexpected `count` after `from`",
            "`<collection> count { … }`",
            "`select count from …`",
        ],
    );
    assert_parse_error(
        "from people exists { where active }",
        &["unexpected `exists` after `from`"],
    );
    assert_parse_error(
        "from people active",
        &["unexpected 'active' after `from`", "no implicit where"],
    );
    assert_parse_error("from people name, id", &["unexpected 'name' after `from`"]);
    // the legal spellings of what those meant
    let q = parse("people count { where active }");
    assert_eq!(q.consumer, Consumer::Count);
    assert_eq!(q.r#where, Some(scalar(ident("active"))));
    let q = parse("select count from xs");
    assert_eq!(q.select, vec![bare("count")]);
}

// ---- alias inlining -----------------------------------------------------------

#[test]
fn where_may_reference_select_aliases_inlined_at_parse_time() {
    let q = parse("select name, adult: age >= 30 from people where adult");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(BinaryOp::Ge, ident("age"), num(30.0))))
    );
    let q = parse("select name, decade: age / 10 from people where decade > 5");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(
            BinaryOp::Gt,
            bin(BinaryOp::Div, ident("age"), num(10.0)),
            num(5.0)
        )))
    );
    // the rewrite is inline substitution: the where AST is an ordinary scalar tree
    let q = parse("select adult: age >= 18 from people where adult && name == \"x\"");
    assert_eq!(
        q.r#where,
        Some(and(vec![
            scalar(bin(BinaryOp::Ge, ident("age"), num(18.0))),
            scalar(bin(BinaryOp::Eq, ident("name"), str_("x"))),
        ]))
    );
    // the select itself is untouched by the rewrite
    assert_eq!(
        q.select,
        vec![field("adult", bin(BinaryOp::Ge, ident("age"), num(18.0)))]
    );
    // an alias chain resolves through (s → senior's expression)
    let q = parse("select senior: age > 50, s: senior from people where s");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(BinaryOp::Gt, ident("age"), num(50.0))))
    );
    // an unaliased dotted item is an alias for its key
    let q = parse("select meta.slug from data where slug == \"b\"");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(
            BinaryOp::Eq,
            member(ident("meta"), "slug"),
            str_("b")
        )))
    );
    // inside a block, the rewrite is against THAT block's select only
    let q = parse(
        "name, cur: jobs collect { e: employer, open: !end_date where open } from people where name == \"Bob\"",
    );
    let SelectItem::Collect { op: cur, .. } = &q.select[1] else {
        panic!("expected a collect item")
    };
    assert_eq!(cur.sub.r#where, Some(scalar(not(ident("end_date")))));
    assert_eq!(
        q.r#where,
        Some(scalar(bin(BinaryOp::Eq, ident("name"), str_("Bob"))))
    );
    // a collect alias in predicate position means non-empty: the where IS the op node
    let q =
        parse("name, current: jobs collect { employer where !end_date } from people where current");
    let mut block = sub();
    block.select = vec![bare("employer")];
    block.r#where = Some(wnot(scalar(ident("end_date"))));
    let expected = op(ident("jobs"), Consumer::Collect, block);
    assert_eq!(q.select[1], collect_item("current", expected.clone()));
    assert_eq!(q.r#where, Some(wop(expected)));
    // …but not inside an expression
    assert_parse_error(
        "select n: jobs collect { employer } from people where n.size() > 1",
        &["alias 'n' is a collect"],
    );
}

#[test]
fn an_alias_shadows_a_same_named_field_inside_where() {
    let q = parse("select name, active: age > 50 from people where active");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(BinaryOp::Gt, ident("age"), num(50.0))))
    );
    // `^name` is never an alias — it reads the enclosing ROW
    let q = parse(
        "name, peers: xs collect { name values where age > ^age } from people where name == \"Bob\"",
    );
    let SelectItem::Collect { op, .. } = &q.select[1] else {
        panic!("expected a collect item")
    };
    assert!(op.sub.values);
    assert_eq!(
        op.sub.r#where,
        Some(scalar(bin(BinaryOp::Gt, ident("age"), outer(1, "age"))))
    );
    // inside its own expression an alias's name is the row field (not recursion)
    let q = parse("select name: name.upper() from people where name == \"BOB\"");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(
            BinaryOp::Eq,
            call(Some(ident("name")), "upper", vec![]),
            str_("BOB")
        )))
    );
    let q = parse("select name from people where name == \"Bob\"");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(BinaryOp::Eq, ident("name"), str_("Bob"))))
    );
    // a lifted item is not an alias; a `^name` in where still reads the outer scope
    let q = parse("people exists { ^x: a where x == 1 }");
    assert_eq!(q.select, vec![lifted(1, "x", ident("a"))]);
    assert_eq!(
        q.r#where,
        Some(scalar(bin(BinaryOp::Eq, ident("x"), num(1.0))))
    );
}

#[test]
fn alias_inlining_reaches_into_every_expression_shape() {
    // the receiver of a where-position op is rewritten; its block is not
    let q = parse("select j: jobs from people where j exists { where j }");
    let Some(Where::Op(o)) = &q.r#where else {
        panic!("expected an op")
    };
    assert_eq!(o.receiver, ident("jobs"));
    assert_eq!(o.sub.r#where, Some(scalar(ident("j"))));
    // members, calls, unary, logical, in, range, not, or
    let q = parse("select a: x from t where !(a.b || f(a) in ..a) || -a.c() > 1");
    assert_eq!(
        q.r#where,
        Some(or(vec![
            wnot(or(vec![
                scalar(member(ident("x"), "b")),
                scalar(in_(
                    call(None, "f", vec![ident("x")]),
                    range(None, Some(ident("x")), false)
                )),
            ])),
            scalar(bin(
                BinaryOp::Gt,
                neg(call(Some(ident("x")), "c", vec![])),
                num(1.0)
            )),
        ]))
    );
}

#[test]
fn a_cycle_among_aliases_referenced_from_where_is_a_parse_error() {
    assert_parse_error(
        "select a: b, b: a from people where a",
        &["select aliases form a cycle: a → b → a"],
    );
    assert_parse_error(
        "select a: b + 1, b: c, c: a from people where c > 1",
        &["cycle: c → a → b → c"],
    );
    // unreferenced, the same select is fine (it swaps two fields)
    let q = parse("select a: b, b: a from xs");
    assert_eq!(
        q.select,
        vec![field("a", ident("b")), field("b", ident("a"))]
    );
}

#[test]
fn order_by_is_not_rewritten_against_the_select_aliases() {
    let q = parse("select name, decade: age / 10 from people order by decade");
    assert_eq!(q.order_by, Some(vec![asc(ident("decade"))]));
    let q = parse("select name, age: 0 from people order by age desc");
    assert_eq!(q.order_by, Some(vec![desc(ident("age"))]));
}

// ---- nested consumers ---------------------------------------------------------

#[test]
fn count_with_a_comparison_in_where() {
    let q = parse("name from people where jobs count {} >= 2");
    let mut expected = op(ident("jobs"), Consumer::Count, sub());
    expected.count_cmp = Some(CountCmp {
        op: RelOp::Ge,
        value: 2.0,
    });
    assert_eq!(q.r#where, Some(wop(expected)));
    for (src, relop) in [
        ("== 1", RelOp::Eq),
        ("!= 1", RelOp::Ne),
        ("< 1", RelOp::Lt),
        ("<= 1", RelOp::Le),
        ("> 1", RelOp::Gt),
        (">= 1", RelOp::Ge),
    ] {
        let q = parse(&format!("from xs where ys count {{}} {src}"));
        let Some(Where::Op(o)) = q.r#where else {
            panic!()
        };
        assert_eq!(
            o.count_cmp,
            Some(CountCmp {
                op: relop,
                value: 1.0
            })
        );
    }
    // the count test is a leaf of the boolean tree
    let q = parse("from xs where a && ys count {} == 0 || !b");
    let mut cnt = op(ident("ys"), Consumer::Count, sub());
    cnt.count_cmp = Some(CountCmp {
        op: RelOp::Eq,
        value: 0.0,
    });
    assert_eq!(
        q.r#where,
        Some(or(vec![
            and(vec![scalar(ident("a")), wop(cnt)]),
            wnot(scalar(ident("b")))
        ]))
    );
}

#[test]
fn count_comparison_requires_an_integer_literal() {
    assert_parse_error(
        "from xs where ys count {} >= 1.5",
        &["count comparison takes an integer"],
    );
    assert_parse_error(
        "from xs where ys count {} >= n",
        &["expected an integer after 'count { … } >='"],
    );
    assert_parse_error(
        "from xs where ys count {} >= -1",
        &["expected an integer after 'count { … } >='"],
    );
}

#[test]
fn select_position_collect_projects_a_nested_block() {
    let q = parse(
        "\n    name,\n    current: jobs collect { employer where !end_date }\n    from people\n    where name == \"Bob\"\n  ",
    );
    let mut block = sub();
    block.select = vec![bare("employer")];
    block.r#where = Some(wnot(scalar(ident("end_date"))));
    assert_eq!(
        q.select,
        vec![
            bare("name"),
            collect_item("current", op(ident("jobs"), Consumer::Collect, block))
        ]
    );
}

#[test]
fn select_position_first_and_single() {
    let q = parse("name, firstJob: jobs first { employer } from people where name == \"Alice\"");
    let mut block = sub();
    block.select = vec![bare("employer")];
    assert_eq!(
        q.select[1],
        collect_item(
            "firstJob",
            op(ident("jobs"), Consumer::First, block.clone())
        )
    );
    let q = parse("name, j: jobs single { employer } from people");
    assert_eq!(
        q.select[1],
        collect_item("j", op(ident("jobs"), Consumer::Single, block))
    );
}

#[test]
fn a_dotted_receiver_and_a_call_receiver() {
    let q = parse("from xs where author.books exists { where x }");
    let Some(Where::Op(o)) = q.r#where else {
        panic!()
    };
    assert_eq!(o.receiver, member(ident("author"), "books"));
    let q = parse("from users where entries(prefs) exists { where $key == \"dark\" && $value }");
    let Some(Where::Op(o)) = q.r#where else {
        panic!()
    };
    assert_eq!(o.receiver, call(None, "entries", vec![ident("prefs")]));
    assert_eq!(
        o.sub.r#where,
        Some(and(vec![
            scalar(bin(BinaryOp::Eq, ident("$key"), str_("dark"))),
            scalar(ident("$value"))
        ]))
    );
    // a call receiver may be navigated further
    let q = parse("from xs where f(a).b collect { ^c: d }");
    let Some(Where::Op(o)) = q.r#where else {
        panic!()
    };
    assert_eq!(o.receiver, member(call(None, "f", vec![ident("a")]), "b"));
}

// ---- outer references (explicit `^`; bare names never climb) ------------------

#[test]
fn caret_outer_references_in_expressions() {
    let q = parse("owner from accounts where orders exists { where amount > ^budget }");
    let Some(Where::Op(o)) = q.r#where else {
        panic!()
    };
    assert_eq!(
        o.sub.r#where,
        Some(scalar(bin(
            BinaryOp::Gt,
            ident("amount"),
            outer(1, "budget")
        )))
    );
    // one level per caret
    let q = parse(
        "m: mid collect { l: leaf collect { own: v, one: ^v, two: ^^v, three: ^^^v, four: ^^^^v } } from rows",
    );
    let SelectItem::Collect { op: m, .. } = &q.select[0] else {
        panic!()
    };
    let SelectItem::Collect { op: l, .. } = &m.sub.select[0] else {
        panic!()
    };
    assert_eq!(
        l.sub.select,
        vec![
            field("own", ident("v")),
            field("one", outer(1, "v")),
            field("two", outer(2, "v")),
            field("three", outer(3, "v")),
            field("four", outer(4, "v")),
        ]
    );
    // `^$value` / `^$depth` — the enclosing row's intrinsic
    let q = parse("id, kids: children collect { id, own: $depth, parentDepth: ^$depth } from tree");
    let SelectItem::Collect { op, .. } = &q.select[1] else {
        panic!()
    };
    assert_eq!(
        op.sub.select,
        vec![
            bare("id"),
            field("own", ident("$depth")),
            field("parentDepth", outer(1, "$depth"))
        ]
    );
    let q = parse("from xs where scores.size() > ^$value.scores.size()");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(
            BinaryOp::Gt,
            call(Some(ident("scores")), "size", vec![]),
            call(Some(member(outer(1, "$value"), "scores")), "size", vec![]),
        )))
    );
}

#[test]
fn caret_receivers_reach_named_roots_and_enclosing_relations() {
    let q = parse(
        "name, peers: ^people collect { name where city == ^city && name != ^name } from people",
    );
    let SelectItem::Collect { op, .. } = &q.select[1] else {
        panic!()
    };
    assert_eq!(op.receiver, outer(1, "people"));
    assert_eq!(
        op.sub.r#where,
        Some(and(vec![
            scalar(bin(BinaryOp::Eq, ident("city"), outer(1, "city"))),
            scalar(bin(BinaryOp::Ne, ident("name"), outer(1, "name"))),
        ]))
    );
    let q = parse("name from people where ^people exists { where city == ^city }");
    let Some(Where::Op(o)) = q.r#where else {
        panic!()
    };
    assert_eq!(o.receiver, outer(1, "people"));
    // a dotted outer receiver
    let q = parse("from xs where ^^root.rel exists { }");
    let Some(Where::Op(o)) = q.r#where else {
        panic!()
    };
    assert_eq!(o.receiver, member(outer(2, "root"), "rel"));
    // a whole-query directive over an outer receiver (odd at the top level, but legal)
    let q = parse("^xs count { }");
    assert_eq!(q.source, outer(1, "xs"));
}

// ---- top-level consumers ------------------------------------------------------

#[test]
fn top_level_directives() {
    let q = parse("people exists { where jobs exists { where employer == \"Initech\" } }");
    assert_eq!(q.consumer, Consumer::Exists);
    let mut inner = sub();
    inner.r#where = Some(scalar(bin(
        BinaryOp::Eq,
        ident("employer"),
        str_("Initech"),
    )));
    assert_eq!(
        q.r#where,
        Some(wop(op(ident("jobs"), Consumer::Exists, inner)))
    );
    let q = parse("people count { where active }");
    assert_eq!(q.consumer, Consumer::Count);
    let q = parse("people first { name where age > 50 }");
    assert_eq!(q.consumer, Consumer::First);
    let q = parse("people single { name values where name == \"Carol\" }");
    assert_eq!(q.consumer, Consumer::Single);
    assert!(q.values);
    let q = parse("xs none { where $value > 2 }");
    assert_eq!(q.consumer, Consumer::None);
    let q = parse("people collect { }");
    assert_eq!(q.consumer, Consumer::Collect);
    // a binding as the directive receiver
    let q = parse_template(&["", " count { where active }"], 1).unwrap();
    assert_eq!(q.source, binding(0));
    assert_eq!(q.consumer, Consumer::Count);
}

#[test]
fn a_directive_block_may_re_project_with_from() {
    let q = parse("people count { from jobs where active }");
    assert_eq!(q.source, ident("people"));
    assert_eq!(q.from, vec![ident("jobs")]);
    // a body form with several `from`s is one source plus re-projections… but `from`
    // appears at most once, so that is a duplicate error
    assert_parse_error("from people from jobs", &["duplicate `from`"]);
}

#[test]
fn trailing_tokens_after_a_directive_or_query_are_errors() {
    assert_parse_error(
        "people count { } order by x",
        &["unexpected 'order' after the top-level directive"],
    );
    assert_parse_error("name from people }", &["unexpected '}' after the query"]);
    // only `}` escapes the body loop; any other stray token is an in-body error
    assert_parse_error("name from people )", &["unexpected ')' after `from`"]);
}

// ---- order by -----------------------------------------------------------------

#[test]
fn order_by_specs() {
    let q = parse("name from people order by age desc");
    assert_eq!(q.order_by, Some(vec![desc(ident("age"))]));
    let q = parse("name from people order by age desc, name, city asc");
    assert_eq!(
        q.order_by,
        Some(vec![
            desc(ident("age")),
            asc(ident("name")),
            asc(ident("city"))
        ])
    );
    let q = parse("id from tree follow children order by $depth, id");
    assert_eq!(
        q.order_by,
        Some(vec![asc(ident("$depth")), asc(ident("id"))])
    );
    // an expression may be ordered by
    let q = parse("from xs order by a.b.size() desc");
    assert_eq!(
        q.order_by,
        Some(vec![desc(call(
            Some(member(ident("a"), "b")),
            "size",
            vec![]
        ))])
    );
}

// ---- lifts --------------------------------------------------------------------

#[test]
fn lift_binds_a_per_row_collection_from_a_where_position_collect() {
    let q = parse(
        "\n    name, currentEmployers\n    from people\n    where jobs collect { ^currentEmployers: employer where !end_date }\n  ",
    );
    assert_eq!(q.select, vec![bare("name"), bare("currentEmployers")]);
    let mut block = sub();
    block.select = vec![lifted(1, "currentEmployers", ident("employer"))];
    block.r#where = Some(wnot(scalar(ident("end_date"))));
    assert_eq!(
        q.r#where,
        Some(wop(op(ident("jobs"), Consumer::Collect, block)))
    );
}

#[test]
fn multi_level_lifts() {
    let q = parse(
        "name, teamIds, allMembers from departments where teams collect { ^teamIds: id where members collect { ^^allMembers: name } }",
    );
    let Some(Where::Op(outer_op)) = &q.r#where else {
        panic!()
    };
    assert_eq!(outer_op.sub.select, vec![lifted(1, "teamIds", ident("id"))]);
    let Some(Where::Op(inner)) = &outer_op.sub.r#where else {
        panic!()
    };
    assert_eq!(inner.receiver, ident("members"));
    assert_eq!(
        inner.sub.select,
        vec![lifted(2, "allMembers", ident("name"))]
    );
    let q = parse(
        "name, everyone from orgs where divisions collect { ^divs: d where teams collect { ^^tc: 1 where members collect { ^^^everyone: name } } }",
    );
    let Some(Where::Op(a)) = &q.r#where else {
        panic!()
    };
    let Some(Where::Op(b)) = &a.sub.r#where else {
        panic!()
    };
    assert_eq!(b.sub.select, vec![lifted(2, "tc", num(1.0))]);
    let Some(Where::Op(c)) = &b.sub.r#where else {
        panic!()
    };
    assert_eq!(c.sub.select, vec![lifted(3, "everyone", ident("name"))]);
}

#[test]
fn collect_in_where_must_project_only_lifts() {
    assert_parse_error(
        "from people where jobs collect { employer }",
        &["collect { … } in where must project only ^lift values (else use exists/count)"],
    );
    assert_parse_error(
        "from people where jobs collect { }",
        &["must project only ^lift values"],
    );
    assert_parse_error(
        "from people where jobs collect { ^a: x, b: y }",
        &["must project only ^lift values"],
    );
    // a lift cannot carry a block
    assert_parse_error(
        "from people where jobs collect { ^a: xs collect { } }",
        &["a lift (^a) value must be a scalar expression, not collect { … }"],
    );
}

// ---- follow (recursion) -------------------------------------------------------

#[test]
fn follow_collects_descendants() {
    let q = parse(
        "\n    id, depth: $depth\n    from tree\n    follow children\n    order by $depth, id\n  ",
    );
    assert_eq!(q.select, vec![bare("id"), field("depth", ident("$depth"))]);
    assert_eq!(
        q.follow,
        Some(Follow {
            receiver: ident("children"),
            distinct: false,
            r#where: None,
            frontier: None,
            depth: None,
            by: None,
        })
    );
    assert_eq!(
        q.order_by,
        Some(vec![asc(ident("$depth")), asc(ident("id"))])
    );
}

#[test]
fn follow_block_options() {
    let q = parse("id, stop: $stop from tree follow children { depth 2 } order by id");
    assert_eq!(q.follow.as_ref().unwrap().depth, Some(2));
    let q =
        parse("from tree follow children { where active frontier kind == \"leaf\" depth 8 by id }");
    assert_eq!(
        q.follow,
        Some(Follow {
            receiver: ident("children"),
            distinct: false,
            r#where: Some(ident("active")),
            frontier: Some(bin(BinaryOp::Eq, ident("kind"), str_("leaf"))),
            depth: Some(8),
            by: Some(ident("id")),
        })
    );
    // options in any order
    let q = parse("from tree follow children { by id depth 1 }");
    let f = q.follow.unwrap();
    assert_eq!((f.depth, f.by), (Some(1), Some(ident("id"))));
    // a dotted relation and a binding relation
    let q = parse("from tree follow rel.children");
    assert_eq!(q.follow.unwrap().receiver, member(ident("rel"), "children"));
    let q = parse_template(&["from tree follow ", " { depth 3 }"], 1).unwrap();
    assert_eq!(q.follow.unwrap().receiver, binding(0));
}

#[test]
fn follow_distinct() {
    let q = parse("id from xs follow distinct next order by id");
    let f = q.follow.unwrap();
    assert!(f.distinct);
    assert_eq!(f.receiver, ident("next"));
    // `follow distinct { … }` — `distinct` is the relation's name when nothing follows it
    let q = parse("from xs follow distinct { depth 2 }");
    let f = q.follow.unwrap();
    assert!(!f.distinct);
    assert_eq!(f.receiver, ident("distinct"));
    assert_eq!(f.depth, Some(2));
}

#[test]
fn follow_block_errors() {
    assert_parse_error(
        "from tree follow children { depth 9 }",
        &["follow depth must be an integer between 1 and 8"],
    );
    assert_parse_error(
        "from tree follow children { depth 0 }",
        &["follow depth must be an integer between 1 and 8"],
    );
    assert_parse_error(
        "from tree follow children { depth 1.5 }",
        &["follow depth must be an integer between 1 and 8"],
    );
    assert_parse_error(
        "from tree follow children { depth x }",
        &["expected an integer after `depth`"],
    );
    assert_parse_error(
        "from tree follow children { depth 1 depth 2 }",
        &["duplicate `depth` in follow clause"],
    );
    assert_parse_error(
        "from tree follow children { where a where b }",
        &["duplicate `where` in follow clause"],
    );
    assert_parse_error(
        "from tree follow children { frontier a frontier b }",
        &["duplicate `frontier` in follow clause"],
    );
    assert_parse_error(
        "from tree follow children { by a by b }",
        &["duplicate `by` in follow clause"],
    );
    assert_parse_error(
        "from tree follow children { limit 1 }",
        &["unexpected 'limit' in follow block — expected where/frontier/depth/by"],
    );
    assert_parse_error(
        "from tree follow children { depth 1",
        &["expected '}' to close the follow block"],
    );
    // `follow` not followed by a relation name is not a follow clause at all
    assert_parse_error("from tree follow", &["unexpected 'follow' after `from`"]);
    assert_parse_error("from tree follow 1", &["unexpected 'follow' after `from`"]);
    // …including a `^`-headed relation: at_follow only admits an ident or a binding,
    // so parse_receiver's caret support is unreachable from `follow` (as in the TS)
    assert_parse_error(
        "from tree follow ^rel",
        &["unexpected 'follow' after `from`"],
    );
    // `depth 2.0` is an integer-valued number, so it passes the integer check
    assert_eq!(
        parse("from tree follow children { depth 2.0 }")
            .follow
            .unwrap()
            .depth,
        Some(2)
    );
}

// ---- distinct -----------------------------------------------------------------

#[test]
fn select_distinct() {
    let q = parse("select distinct id from dupes");
    assert!(q.distinct);
    assert_eq!(q.select, vec![bare("id")]);
    let q = parse("select distinct employer values from jobs");
    assert!(q.distinct);
    assert!(q.values);
    // `distinct` without `select` is a field called distinct
    let q = parse("distinct from xs");
    assert!(!q.distinct);
    assert_eq!(q.select, vec![bare("distinct")]);
}

#[test]
fn collect_distinct_and_count_distinct() {
    let q = parse("select n: jobs collect distinct { select employer } from people");
    let SelectItem::Collect { op, .. } = &q.select[0] else {
        panic!()
    };
    assert!(op.distinct);
    assert_eq!(op.sub.select, vec![bare("employer")]);
    let q = parse("people exists { where jobs count distinct { select employer } == 1 }");
    let Some(Where::Op(o)) = q.r#where else {
        panic!()
    };
    assert!(o.distinct);
    assert_eq!(
        o.count_cmp,
        Some(CountCmp {
            op: RelOp::Eq,
            value: 1.0
        })
    );
}

#[test]
fn distinct_is_also_spellable_inside_the_block() {
    let a = parse("select n: jobs collect distinct { select employer } from people");
    let b = parse("select n: jobs collect { select distinct employer } from people");
    assert_eq!(a, b);
    // a top-level directive lifts the block's `select distinct` onto the query
    let q = parse("people collect { select distinct name }");
    assert!(q.distinct);
    let q = parse("people collect distinct { name }");
    assert!(q.distinct);
}

// ---- ranges -------------------------------------------------------------------

#[test]
fn range_parses_to_a_range_node_with_the_exclusive_end_flag() {
    let q = parse("from xs where n in 1...5");
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            ident("n"),
            range(Some(num(1.0)), Some(num(5.0)), true)
        )))
    );
    let q = parse("name from people where age in 30..50");
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            ident("age"),
            range(Some(num(30.0)), Some(num(50.0)), false)
        )))
    );
}

#[test]
fn open_ended_ranges() {
    let q = parse("name from people where age in 41..");
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            ident("age"),
            range(Some(num(41.0)), None, false)
        )))
    );
    let q = parse("name from people where age in ..29");
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            ident("age"),
            range(None, Some(num(29.0)), false)
        )))
    );
    let q = parse("name from people where age in ...29");
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            ident("age"),
            range(None, Some(num(29.0)), true)
        )))
    );
    // Faithful to the TS: a leading `..` always takes a high bound, so `..` alone
    // before a clause word reads that word as the bound and fails on the next token.
    assert_parse_error(
        "from xs where n in .. order by a",
        &["unexpected 'by' after `where`"],
    );
}

#[test]
fn an_open_ended_bound_does_not_swallow_a_following_clause() {
    let q = parse("name from people where age in 40.. order by age");
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            ident("age"),
            range(Some(num(40.0)), None, false)
        )))
    );
    assert_eq!(q.order_by, Some(vec![asc(ident("age"))]));
    let q = parse("name from people where age in 40.. limit 1");
    assert_eq!(q.limit, Some(num(1.0)));
    // …and a block boundary
    let q = parse("people count { where age in 40.. }");
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            ident("age"),
            range(Some(num(40.0)), None, false)
        )))
    );
}

#[test]
fn range_bounds_may_be_bindings_strings_or_arithmetic() {
    let q = parse_template(&["name from ", " where age in ", "..", ""], 3).unwrap();
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            ident("age"),
            range(Some(binding(1)), Some(binding(2)), false)
        )))
    );
    let q = parse("label from events where on in \"2026-01-01\"..\"2026-03-31\"");
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            ident("on"),
            range(Some(str_("2026-01-01")), Some(str_("2026-03-31")), false)
        )))
    );
    // a range binds looser than arithmetic, tighter than comparison / `in`
    let q = parse("from xs where n in 1+1..2*3");
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            ident("n"),
            range(
                Some(bin(BinaryOp::Add, num(1.0), num(1.0))),
                Some(bin(BinaryOp::Mul, num(2.0), num(3.0))),
                false
            )
        )))
    );
    // a range as a plain value
    let q = parse("r: 1..5 from xs");
    assert_eq!(
        q.select,
        vec![field("r", range(Some(num(1.0)), Some(num(5.0)), false))]
    );
}

#[test]
fn range_function_is_just_a_call() {
    let q = parse("label from rows where \"2026-01-15\" in range(window)");
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            str_("2026-01-15"),
            call(None, "range", vec![ident("window")])
        )))
    );
}

// ---- errors -------------------------------------------------------------------

#[test]
fn a_missing_source_is_a_parse_error() {
    assert_parse_error(
        "name where active",
        &["a query must name its source with `from <collection>`"],
    );
    assert_parse_error("name", &["a query must name its source"]);
    let e = parse_string("").unwrap_err();
    assert_eq!(e.stage, Stage::Parse);
    assert!(e.message.contains("a query must name its source"));
}

#[test]
fn first_and_single_in_where_position_are_rejected() {
    assert_parse_error(
        "name from people where jobs first { employer }",
        &[
            "first { … } is a select-position lookup; in where use exists { … } / none { … } or count { … } <op> N",
        ],
    );
    assert_parse_error(
        "name from people where jobs single { employer }",
        &["single { … } is a select-position lookup"],
    );
}

#[test]
fn unclosed_blocks_and_groups() {
    assert_parse_error(
        "people count { where active",
        &["expected '}' to close the count { … } block"],
    );
    assert_parse_error(
        "from xs where (a || b",
        &["expected ')' to close a grouped where expression"],
    );
    assert_parse_error("x: (a + b from xs", &["expected ')'"]);
    assert_parse_error(
        "x: f(a, b from xs",
        &["expected ')' to close call arguments"],
    );
    assert_parse_error(
        "from xs where",
        &["unexpected end of query — expected a value"],
    );
    assert_parse_error(
        "from xs where a.",
        &["expected an identifier after '.' in a navigation"],
    );
    // `try_op` runs first on an ident head and throws (it does not rewind) on `a.`
    assert_parse_error(
        "x: a. from xs",
        &["expected an identifier after '.' in a navigation"],
    );
    // the value parser's own message needs a head try_op does not take, e.g. a paren
    assert_parse_error("x: (a). from xs", &["expected a property name after '.'"]);
    assert_parse_error(
        "x: ^ from xs",
        &["expected an identifier after '^' (an outer reference)"],
    );
    assert_parse_error("select from xs", &["expected a projection name"]);
    assert_parse_error("select name, from xs", &["expected a projection name"]);
}

#[test]
fn errors_carry_an_offset() {
    let e = parse_err("from people select name");
    assert!(e.message.ends_with("(at offset 12)"), "{}", e.message);
}

#[test]
fn stray_tokens_name_the_remaining_clauses() {
    assert_parse_error(
        "name from people where a > 1 name",
        &["unexpected 'name' after `where` — expected follow/order by/limit/offset"],
    );
    assert_parse_error(
        "name from people order by a 5",
        &["unexpected '5' after `order by` — expected limit/offset"],
    );
    assert_parse_error(
        "people count { where a x }",
        &["unexpected 'x' after `where` — expected follow/order by/limit/offset"],
    );
    assert_parse_error(
        ") from xs",
        &[
            "unexpected ')' — expected a projection or select/from/where/follow/order by/limit/offset",
        ],
    );
}

// ---- `$value` and `values` ----------------------------------------------------

#[test]
fn dollar_value_is_an_ordinary_identifier() {
    let q = parse("$value values from scores where $value > 50");
    assert!(q.values);
    assert_eq!(q.select, vec![bare("$value")]);
    assert_eq!(
        q.r#where,
        Some(scalar(bin(BinaryOp::Gt, ident("$value"), num(50.0))))
    );
    let q = parse("$value values from xs order by $value desc");
    assert_eq!(q.order_by, Some(vec![desc(ident("$value"))]));
    let q = parse("employee: $value from people where name == \"Bob\"");
    assert_eq!(q.select, vec![field("employee", ident("$value"))]);
    // bare `$value` keys by its own name, like any other bare projection
    let q = parse("$value from xs");
    assert_eq!(q.select, vec![bare("$value")]);
    assert!(!q.values);
    let q = parse("xs exists { where $value == ^$value }");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(
            BinaryOp::Eq,
            ident("$value"),
            outer(1, "$value")
        )))
    );
}

#[test]
fn values_makes_a_record_projection_the_bare_value() {
    let q = parse("name values from people");
    assert!(q.values);
    assert_eq!(q.select, vec![bare("name")]);
    let q = parse("select name values from people where age > 40");
    assert!(q.values);
    // an unaliased expression is legal under values (a name would be meaningless)
    let q = parse("name.upper() values from people where age < 30");
    assert_eq!(
        q.select,
        vec![field("", call(Some(ident("name")), "upper", vec![]))]
    );
    let q = parse("age * 2 values from people");
    assert_eq!(
        q.select,
        vec![field("", bin(BinaryOp::Mul, ident("age"), num(2.0)))]
    );
    // an alias is accepted (the engine ignores it)
    let q = parse("n: name values from people");
    assert_eq!(q.select, vec![field("n", ident("name"))]);
    assert!(q.values);
}

#[test]
fn values_composes_with_distinct_blocks_and_bounds() {
    let q = parse("people first { name values where age > 50 }");
    assert!(q.values);
    assert_eq!(q.consumer, Consumer::First);
    let q = parse("name, employers: jobs collect distinct { employer values } from people");
    let SelectItem::Collect { op, .. } = &q.select[1] else {
        panic!()
    };
    assert!(op.distinct);
    assert!(op.sub.values);
    let q = parse(
        "name, latest: jobs first { start_date values order by start_date desc } from people",
    );
    let SelectItem::Collect { op, .. } = &q.select[1] else {
        panic!()
    };
    assert!(op.sub.values);
    assert_eq!(op.sub.order_by, Some(vec![desc(ident("start_date"))]));
    // a nested collect can itself be the value
    let q = parse("e: jobs collect { employer values } values from people where name == \"Alice\"");
    assert!(q.values);
    let SelectItem::Collect { op, .. } = &q.select[0] else {
        panic!()
    };
    assert!(op.sub.values);
}

#[test]
fn values_takes_exactly_one_item_and_rejects_lifts() {
    assert_parse_error(
        "name, id values from people",
        &[
            "exactly one",
            "`values` projects exactly one expression (got 2)",
        ],
    );
    assert_parse_error(
        "from people where jobs collect { ^x: employer values }",
        &["lift", "a lift (^name: …) cannot be combined with `values`"],
    );
}

#[test]
fn an_unaliased_non_navigation_item_needs_an_alias_unless_values() {
    assert_parse_error("size(jobs) from people", &["needs an alias"]);
    assert_parse_error("select age > 40 from people", &["needs an alias"]);
    // a call-shaped leading expression is a projection, not an implicit where
    assert_parse_error("people exists { has(budget) }", &["needs an alias"]);
    assert_parse_error("1 from xs", &["needs an alias"]);
    assert_parse_error("\"s\" from xs", &["needs an alias"]);
    assert_parse_error("(a + 1) from xs", &["needs an alias"]);
    // Faithful to the TS: parentheses are transparent to the default key, so a
    // parenthesized bare name still projects under its own name.
    assert_eq!(parse("(a) from xs").select, vec![bare("a")]);
    let q = parse("n: size(jobs) from people");
    assert_eq!(
        q.select,
        vec![field("n", call(None, "size", vec![ident("jobs")]))]
    );
}

// ---- `none` -------------------------------------------------------------------

#[test]
fn none_is_a_where_position_test_and_a_whole_query_consumer() {
    let q = parse("owner from accounts where orders none { where amount > 200 }");
    let mut block = sub();
    block.r#where = Some(scalar(bin(BinaryOp::Gt, ident("amount"), num(200.0))));
    assert_eq!(
        q.r#where,
        Some(wop(op(ident("orders"), Consumer::None, block.clone())))
    );
    // ≡ !orders exists { … }
    let q = parse("owner from accounts where !orders exists { where amount > 200 }");
    assert_eq!(
        q.r#where,
        Some(wnot(wop(op(ident("orders"), Consumer::Exists, block))))
    );
    // an empty block
    let q = parse("name values from players where scores none { }");
    assert_eq!(
        q.r#where,
        Some(wop(op(ident("scores"), Consumer::None, sub())))
    );
    let q = parse("people none { where age > 90 }");
    assert_eq!(q.consumer, Consumer::None);
}

#[test]
fn none_is_not_comparable_and_not_a_projection() {
    assert_parse_error(
        "from people where jobs none { } > 0",
        &[
            "only count",
            "only count { … } is comparable; 'none { … } <op> N' is not valid",
        ],
    );
    assert_parse_error(
        "from people where jobs exists { } >= 1",
        &["only count { … } is comparable; 'exists { … } <op> N' is not valid"],
    );
    assert_parse_error(
        "n: jobs none { } from people",
        &[
            "collect/first/single",
            "projection 'n' must use collect/first/single, not none (exists/none/count are where-position tests)",
        ],
    );
    assert_parse_error(
        "n: jobs exists { } from people",
        &["projection 'n' must use collect/first/single, not exists"],
    );
    assert_parse_error(
        "n: jobs count { } from people",
        &["projection 'n' must use collect/first/single, not count"],
    );
}

// ---- `limit` / `offset` -------------------------------------------------------

#[test]
fn limit_and_offset_are_value_expressions() {
    let q = parse("name values from people order by age desc limit 2");
    assert_eq!(q.limit, Some(num(2.0)));
    assert_eq!(q.offset, None);
    let q = parse("name values from people order by age desc limit 1 offset 1");
    assert_eq!((q.limit, q.offset), (Some(num(1.0)), Some(num(1.0))));
    let q = parse("name values from people offset 5");
    assert_eq!((q.limit, q.offset), (None, Some(num(5.0))));
    let q = parse("name values from people limit 0");
    assert_eq!(q.limit, Some(num(0.0)));
    // the bound may be a binding
    let q = parse_template(
        &[
            "name values from ",
            " where age > 30 order by name limit ",
            "",
        ],
        2,
    )
    .unwrap();
    assert_eq!(q.limit, Some(binding(1)));
    // or an outer reference (inside a block)
    let q = parse(
        "name, top: scores collect { $value values order by $value desc limit ^n } from ranked",
    );
    let SelectItem::Collect { op, .. } = &q.select[1] else {
        panic!()
    };
    assert_eq!(op.sub.limit, Some(outer(1, "n")));
}

#[test]
fn limit_and_offset_inside_blocks() {
    let q = parse("people count { limit 2 }");
    assert_eq!(q.limit, Some(num(2.0)));
    let q = parse("people count { where age > 30 offset 1 }");
    assert_eq!(q.offset, Some(num(1.0)));
    let q = parse("name values from people where jobs count { limit 1 } == 1");
    let Some(Where::Op(o)) = q.r#where else {
        panic!()
    };
    assert_eq!(o.sub.limit, Some(num(1.0)));
    assert_eq!(
        o.count_cmp,
        Some(CountCmp {
            op: RelOp::Eq,
            value: 1.0
        })
    );
    let q = parse("id values from tree follow children order by $depth, id limit 2");
    assert!(q.follow.is_some());
    assert_eq!(q.limit, Some(num(2.0)));
}

#[test]
fn a_field_named_limit_is_still_a_field() {
    assert_parse_error("name from people limit 1 limit 2", &["duplicate `limit`"]);
    assert_parse_error(
        "name from people offset 1 offset 2",
        &["duplicate `offset`"],
    );
    let q = parse("limit from xs");
    assert_eq!(q.select, vec![bare("limit")]);
    assert_eq!(q.limit, None);
    let q = parse("from xs where limit > 2");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(BinaryOp::Gt, ident("limit"), num(2.0))))
    );
    let q = parse("offset, limit from xs");
    assert_eq!(q.select, vec![bare("offset"), bare("limit")]);
    // `limit` followed by something that cannot be a bound is not a bound
    assert_parse_error(
        "name from people limit x",
        &["unexpected 'limit' after `from`"],
    );
    assert_parse_error(
        "name from people limit (1)",
        &["unexpected 'limit' after `from`"],
    );
}

// ---- `entries()` + `$key` -----------------------------------------------------

#[test]
fn entries_is_a_free_function_call_usable_as_a_source() {
    let q = parse_template(&["key: $key, value: $value from entries(", ")"], 1).unwrap();
    assert_eq!(q.source, call(None, "entries", vec![binding(0)]));
    assert_eq!(
        q.select,
        vec![field("key", ident("$key")), field("value", ident("$value"))]
    );
    let q = parse("from entries(settings)");
    assert_eq!(q.source, call(None, "entries", vec![ident("settings")]));
    let q = parse("name, on: entries(prefs) collect { $key values where $value } from users");
    let SelectItem::Collect { op, .. } = &q.select[1] else {
        panic!()
    };
    assert_eq!(op.receiver, call(None, "entries", vec![ident("prefs")]));
    assert_eq!(op.sub.select, vec![bare("$key")]);
    assert!(op.sub.values);
    let q = parse("entries(settings) count { }");
    assert_eq!(q.source, call(None, "entries", vec![ident("settings")]));
    assert_eq!(q.consumer, Consumer::Count);
    let q = parse(
        "g: $key, big: $value collect { $value values where $value > 1 } from entries(groups)",
    );
    let SelectItem::Collect { op, .. } = &q.select[1] else {
        panic!()
    };
    assert_eq!(op.receiver, ident("$value"));
    // as a plain value it is just a call
    let q = parse("e: entries(prefs) from xs");
    assert_eq!(
        q.select,
        vec![field("e", call(None, "entries", vec![ident("prefs")]))]
    );
}

// ---- expression grammar: precedence and associativity -------------------------

#[test]
fn arithmetic_precedence_and_associativity() {
    let q = parse("x: 1 + 2 * 3 - 4 from xs");
    assert_eq!(
        q.select,
        vec![field(
            "x",
            bin(
                BinaryOp::Sub,
                bin(
                    BinaryOp::Add,
                    num(1.0),
                    bin(BinaryOp::Mul, num(2.0), num(3.0))
                ),
                num(4.0)
            )
        )]
    );
    let q = parse("x: 8 / 2 / 2 % 3 from xs");
    assert_eq!(
        q.select,
        vec![field(
            "x",
            bin(
                BinaryOp::Mod,
                bin(
                    BinaryOp::Div,
                    bin(BinaryOp::Div, num(8.0), num(2.0)),
                    num(2.0)
                ),
                num(3.0)
            )
        )]
    );
    let q = parse("x: (1 + 2) * 3 from xs");
    assert_eq!(
        q.select,
        vec![field(
            "x",
            bin(
                BinaryOp::Mul,
                bin(BinaryOp::Add, num(1.0), num(2.0)),
                num(3.0)
            )
        )]
    );
}

#[test]
fn unary_binds_tighter_than_arithmetic_and_comparison_in_value_position() {
    let q = parse("x: -a.b * 2 from xs");
    assert_eq!(
        q.select,
        vec![field(
            "x",
            bin(BinaryOp::Mul, neg(member(ident("a"), "b")), num(2.0))
        )]
    );
    let q = parse("x: !a == b from xs");
    assert_eq!(
        q.select,
        vec![field("x", bin(BinaryOp::Eq, not(ident("a")), ident("b")))]
    );
    let q = parse("x: !!a from xs");
    assert_eq!(q.select, vec![field("x", not(not(ident("a"))))]);
    let q = parse("x: - -1 from xs");
    assert_eq!(q.select, vec![field("x", neg(neg(num(1.0))))]);
}

#[test]
fn comparison_then_and_then_or_in_value_position() {
    let q = parse("x: a == b && c || d from xs");
    assert_eq!(
        q.select,
        vec![field(
            "x",
            logical(
                LogicalOp::Or,
                logical(
                    LogicalOp::And,
                    bin(BinaryOp::Eq, ident("a"), ident("b")),
                    ident("c")
                ),
                ident("d")
            )
        )]
    );
    let q = parse("x: a || b || c from xs");
    assert_eq!(
        q.select,
        vec![field(
            "x",
            logical(
                LogicalOp::Or,
                logical(LogicalOp::Or, ident("a"), ident("b")),
                ident("c")
            )
        )]
    );
    // comparison is non-associative: a second comparator is a stray token
    assert_parse_error("x: a == b == c from xs", &["unexpected '=='"]);
}

#[test]
fn where_owns_the_boolean_tree() {
    let q = parse("from xs where a || b && !c");
    assert_eq!(
        q.r#where,
        Some(or(vec![
            scalar(ident("a")),
            and(vec![scalar(ident("b")), wnot(scalar(ident("c")))])
        ]))
    );
    let q = parse("from xs where (a || b) && c");
    assert_eq!(
        q.r#where,
        Some(and(vec![
            or(vec![scalar(ident("a")), scalar(ident("b"))]),
            scalar(ident("c"))
        ]))
    );
    // n-ary: `a && b && c` is one And with three parts, not nested pairs
    let q = parse("from xs where a && b && c");
    assert_eq!(
        q.r#where,
        Some(and(vec![
            scalar(ident("a")),
            scalar(ident("b")),
            scalar(ident("c"))
        ]))
    );
    // `!` in where position wraps the whole comparison leaf
    let q = parse("from xs where !a == b");
    assert_eq!(
        q.r#where,
        Some(wnot(scalar(bin(BinaryOp::Eq, ident("a"), ident("b")))))
    );
    // a consumer op nests inside the tree and the tree nests inside its block
    let q = parse("from xs where a && (ys exists { where b || zs none { } })");
    let mut inner = sub();
    inner.r#where = Some(or(vec![
        scalar(ident("b")),
        wop(op(ident("zs"), Consumer::None, sub())),
    ]));
    assert_eq!(
        q.r#where,
        Some(and(vec![
            scalar(ident("a")),
            wop(op(ident("ys"), Consumer::Exists, inner))
        ]))
    );
}

#[test]
fn a_parenthesized_arithmetic_head_in_where_is_a_grouped_where() {
    // Faithful to the TS: `(` in where position opens a grouped WHERE, so the
    // scalar `(a + 1)` closes the group and the `>` that follows is a stray token.
    assert_parse_error(
        "from xs where (a + 1) > 2",
        &["unexpected '>' after `where`"],
    );
    // whereas the comparison the other way round is fine
    let q = parse("from xs where 2 < (a + 1)");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(
            BinaryOp::Lt,
            num(2.0),
            bin(BinaryOp::Add, ident("a"), num(1.0))
        )))
    );
}

#[test]
fn literals() {
    let q = parse("a: true, b: false, c: null, d: 1.5, e: 1e3, f: 'single', g: \"dq\" from xs");
    assert_eq!(
        q.select,
        vec![
            field("a", Expr::Lit(Value::Bool(true))),
            field("b", Expr::Lit(Value::Bool(false))),
            field("c", Expr::Lit(Value::Null)),
            field("d", num(1.5)),
            field("e", num(1000.0)),
            field("f", str_("single")),
            field("g", str_("dq")),
        ]
    );
    // an exponent with no digits is one number token whose value is NaN (`Number("1e")`)
    let q = parse("x: 1e from xs");
    let SelectItem::Field {
        expr: Expr::Lit(Value::Number(n)),
        ..
    } = &q.select[0]
    else {
        panic!()
    };
    assert!(n.is_nan());
    // a leading-dot numeral is accepted by the lexer's number rule
    assert_eq!(parse("x: .5 from xs").select, vec![field("x", num(0.5))]);
    // `true` etc. as a directive receiver are identifiers (parse_nav_from does not
    // special-case them); as a value they are literals
    let q = parse("true count { }");
    assert_eq!(q.source, ident("true"));
    let q = parse("from true");
    assert_eq!(q.source, Expr::Lit(Value::Bool(true)));
}

#[test]
fn calls_and_navigation() {
    let q = parse("from people where title.startsWith(\"Eng\")");
    assert_eq!(
        q.r#where,
        Some(scalar(call(
            Some(ident("title")),
            "startsWith",
            vec![str_("Eng")]
        )))
    );
    let q = parse("from people where title.lower() == \"director\"");
    assert_eq!(
        q.r#where,
        Some(scalar(bin(
            BinaryOp::Eq,
            call(Some(ident("title")), "lower", vec![]),
            str_("director")
        )))
    );
    let q = parse("from people where has(age) && !has(nickname)");
    assert_eq!(
        q.r#where,
        Some(and(vec![
            scalar(call(None, "has", vec![ident("age")])),
            wnot(scalar(call(None, "has", vec![ident("nickname")]))),
        ]))
    );
    let q = parse("x: a.b(1, c.d).e.f() from xs");
    assert_eq!(
        q.select,
        vec![field(
            "x",
            call(
                Some(member(
                    call(
                        Some(ident("a")),
                        "b",
                        vec![num(1.0), member(ident("c"), "d")]
                    ),
                    "e"
                )),
                "f",
                vec![]
            )
        )]
    );
    // a call result cannot be called again (`f(x)(y)` stops after the first call)
    assert_parse_error("x: f(a)(b) from xs", &["unexpected '('"]);
}

#[test]
fn projection_items_with_carets() {
    // `^name: expr` is a lift; `name: ^x` is an outer read
    let q = parse("people exists { ^a: x, b: ^y, c: ^^z.w }");
    assert_eq!(
        q.select,
        vec![
            lifted(1, "a", ident("x")),
            field("b", outer(1, "y")),
            field("c", member(outer(2, "z"), "w"))
        ]
    );
    // Faithful to the TS: a bare `^name` item has its carets read as a LIFT count,
    // so the expression is the row's own `name` (not an outer reference).
    let q = parse("people exists { ^name }");
    assert_eq!(q.select, vec![lifted(1, "name", ident("name"))]);
    // …while a parenthesized `(^name)` is an outer read keyed by its name.
    let q = parse("(^name) from xs");
    assert_eq!(q.select, vec![field("name", outer(1, "name"))]);
}

// ---- README tutorial examples (AST shapes) -----------------------------------

#[test]
fn readme_full_query_shape() {
    let q = parse(
        "select name, id, title: label from people where age >= 18 && jobs exists { where !end } follow children { depth 4 } order by age desc, name limit 10 offset 20",
    );
    let mut block = sub();
    block.r#where = Some(wnot(scalar(ident("end"))));
    assert_eq!(
        q,
        Query {
            source: ident("people"),
            from: vec![],
            r#where: Some(and(vec![
                scalar(bin(BinaryOp::Ge, ident("age"), num(18.0))),
                wop(op(ident("jobs"), Consumer::Exists, block)),
            ])),
            select: vec![bare("name"), bare("id"), field("title", ident("label"))],
            order_by: Some(vec![desc(ident("age")), asc(ident("name"))]),
            consumer: Consumer::Collect,
            follow: Some(Follow {
                receiver: ident("children"),
                distinct: false,
                r#where: None,
                frontier: None,
                depth: Some(4),
                by: None,
            }),
            distinct: false,
            values: false,
            limit: Some(num(10.0)),
            offset: Some(num(20.0)),
        }
    );
}

#[test]
fn readme_siblings_correlated_subquery() {
    let q = parse_template(
        &[
            "\n  name,\n  siblings: ",
            " collect { name where parent == ^parent && name != ^name }\n  from ",
            "\n",
        ],
        2,
    )
    .unwrap();
    let mut block = sub();
    block.select = vec![bare("name")];
    block.r#where = Some(and(vec![
        scalar(bin(BinaryOp::Eq, ident("parent"), outer(1, "parent"))),
        scalar(bin(BinaryOp::Ne, ident("name"), outer(1, "name"))),
    ]));
    let mut expected = query(binding(1));
    expected.select = vec![
        bare("name"),
        collect_item("siblings", op(binding(0), Consumer::Collect, block)),
    ];
    assert_eq!(q, expected);
}

#[test]
fn readme_membership_against_a_binding_and_negation() {
    let q = parse_template(&["name from ", " where city in ", ""], 2).unwrap();
    assert_eq!(q.r#where, Some(scalar(in_(ident("city"), binding(1)))));
    let q = parse("name from people where !active");
    assert_eq!(q.r#where, Some(wnot(scalar(ident("active")))));
}

#[test]
fn readme_cheat_sheet_lines() {
    let q = parse("where_alias: 1 from xs");
    assert_eq!(q.select, vec![field("where_alias", num(1.0))]);
    let q = parse("from xs where x in range(field)");
    assert_eq!(
        q.r#where,
        Some(scalar(in_(
            ident("x"),
            call(None, "range", vec![ident("field")])
        )))
    );
    let q = parse("from xs where entries(rel) exists { }");
    let Some(Where::Op(o)) = q.r#where else {
        panic!()
    };
    assert_eq!(o.receiver, call(None, "entries", vec![ident("rel")]));
    let q = parse("from xs follow rel { where a frontier b depth 3 by c }");
    let f = q.follow.unwrap();
    assert_eq!(
        (f.r#where, f.frontier, f.depth, f.by),
        (
            Some(ident("a")),
            Some(ident("b")),
            Some(3),
            Some(ident("c"))
        )
    );
}

// ---- operator spellings match the TS strings ---------------------------------

#[test]
fn operator_enums_round_trip_their_ts_spelling() {
    for (word, op) in [
        ("==", BinaryOp::Eq),
        ("!=", BinaryOp::Ne),
        ("<", BinaryOp::Lt),
        ("<=", BinaryOp::Le),
        (">", BinaryOp::Gt),
        (">=", BinaryOp::Ge),
        ("+", BinaryOp::Add),
        ("-", BinaryOp::Sub),
        ("*", BinaryOp::Mul),
        ("/", BinaryOp::Div),
        ("%", BinaryOp::Mod),
    ] {
        assert_eq!(op.as_str(), word);
        assert_eq!(BinaryOp::from_word(word), Some(op));
        assert_eq!(op.is_comparison(), RelOp::from_word(word).is_some());
    }
    for (word, op) in [
        ("==", RelOp::Eq),
        ("!=", RelOp::Ne),
        ("<", RelOp::Lt),
        ("<=", RelOp::Le),
        (">", RelOp::Gt),
        (">=", RelOp::Ge),
    ] {
        assert_eq!(op.as_str(), word);
        assert_eq!(RelOp::from_word(word), Some(op));
    }
    for (word, c) in [
        ("collect", Consumer::Collect),
        ("exists", Consumer::Exists),
        ("none", Consumer::None),
        ("count", Consumer::Count),
        ("first", Consumer::First),
        ("single", Consumer::Single),
    ] {
        assert_eq!(c.as_str(), word);
        assert_eq!(Consumer::from_word(word), Some(c));
    }
    assert_eq!(Consumer::from_word("all"), None);
    assert_eq!(UnaryOp::Not.as_str(), "!");
    assert_eq!(UnaryOp::Neg.as_str(), "-");
    assert_eq!(LogicalOp::And.as_str(), "&&");
    assert_eq!(LogicalOp::Or.as_str(), "||");
}
