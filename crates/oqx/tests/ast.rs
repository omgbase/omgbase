//! The first-class AST contract (`spec/oqx/AST.md`, language 0.16): spans, the
//! traversal (`visit` / `transform`), the canonical printer, template printing,
//! alias resolution, the JSON form and the builders — the API around the shape
//! the `ast.json` / `ast-spans.json` fixtures pin. Mirrors the reference's
//! `test/ast.test.ts`.

use oqx::walk::{Clause, Node, VisitContext, Visitor};
use oqx::{
    BinaryOp, Expr, LANGUAGE_VERSION, OqxError, Span, Stage, Value, ast_to_json, build,
    parse_string, parse_template, print, print_query, print_template, query_from_json,
    resolve_aliases, strip_spans, transform, visit,
};
use serde_json::json;

fn parse(src: &str) -> oqx::Query {
    parse_string(src).unwrap_or_else(|e| panic!("{src:?} should parse: {e}"))
}

fn canon(src: &str) -> String {
    print_query(&parse(src)).unwrap()
}

#[test]
fn spans_count_code_points_over_the_raw_source() {
    let src = "from p where s == \"😀\" && n > 1";
    let q = parse(src);
    let Some(oqx::Where::And { parts, .. }) = &q.r#where else {
        panic!("and")
    };
    assert_eq!(parts[0].span(), Span::new(13, 21));
    let cps: Vec<char> = src.chars().collect();
    assert_eq!(cps[13..21].iter().collect::<String>(), "s == \"😀\"");
    assert_eq!(parts[1].span(), Span::new(25, 30));
    // parse errors quote the same offsets
    let e = parse_string("from p where s == \"😀\" from").unwrap_err();
    assert!(e.message.ends_with("(at offset 22)"), "{}", e.message);
}

#[test]
fn a_template_binding_spans_its_marker() {
    let q = parse_template(&["name from ", " where id == ", ""], 2).unwrap();
    assert_eq!(q.source.span(), Span::new(10, 14));
    let Some(oqx::Where::Scalar {
        expr: Expr::Binary { right, .. },
        ..
    }) = &q.r#where
    else {
        panic!("scalar binary")
    };
    assert_eq!(right.span(), Span::new(27, 31));
}

#[test]
fn visit_reports_order_path_clause_and_depth() {
    let q = parse(
        "select n: jobs collect { employer where !end limit ^k } from people where active follow kids { where x > ^id } order by name limit 2",
    );
    struct Seen(Vec<(&'static str, Option<Clause>, usize, usize)>);
    impl Visitor for Seen {
        fn enter(&mut self, node: Node<'_>, ctx: &VisitContext<'_>) -> bool {
            self.0
                .push((node.kind(), ctx.clause, ctx.depth, ctx.path.len()));
            true
        }
    }
    let mut seen = Seen(Vec::new());
    visit(Node::Query(&q), &mut seen);
    assert_eq!(
        seen.0,
        vec![
            ("query", None, 0, 0),
            ("collect", Some(Clause::Select), 1, 1),
            ("op", Some(Clause::Select), 1, 2),
            ("ident", Some(Clause::Select), 1, 3),
            ("subquery", Some(Clause::Select), 2, 3),
            ("field", Some(Clause::Select), 2, 4),
            ("ident", Some(Clause::Select), 2, 5),
            ("not", Some(Clause::Where), 2, 4),
            ("scalar", Some(Clause::Where), 2, 5),
            ("ident", Some(Clause::Where), 2, 6),
            ("outer", Some(Clause::Limit), 2, 4),
            ("ident", Some(Clause::Source), 0, 1),
            ("scalar", Some(Clause::Where), 1, 1),
            ("ident", Some(Clause::Where), 1, 2),
            ("follow", Some(Clause::Follow), 1, 1),
            ("ident", Some(Clause::FollowDestination), 1, 2),
            ("binary", Some(Clause::FollowWhere), 2, 2),
            ("ident", Some(Clause::FollowWhere), 2, 3),
            ("outer", Some(Clause::FollowWhere), 2, 3),
            ("order", Some(Clause::OrderBy), 1, 1),
            ("ident", Some(Clause::OrderBy), 1, 2),
            ("lit", Some(Clause::Limit), 0, 1),
        ]
    );
}

#[test]
fn visit_enter_may_skip_a_subtree_and_leave_still_runs() {
    let q = parse("select n: jobs collect { employer } from people where active");
    struct Skip {
        entered: Vec<&'static str>,
        left: Vec<&'static str>,
    }
    impl Visitor for Skip {
        fn enter(&mut self, node: Node<'_>, _ctx: &VisitContext<'_>) -> bool {
            self.entered.push(node.kind());
            node.kind() != "op"
        }
        fn leave(&mut self, node: Node<'_>, _ctx: &VisitContext<'_>) {
            self.left.push(node.kind());
        }
    }
    let mut v = Skip {
        entered: Vec::new(),
        left: Vec::new(),
    };
    visit(Node::Query(&q), &mut v);
    assert_eq!(
        v.entered,
        ["query", "collect", "op", "ident", "scalar", "ident"]
    );
    assert_eq!(
        v.left,
        ["op", "collect", "ident", "ident", "scalar", "query"]
    );
}

#[test]
fn transform_maps_every_expression_bottom_up() {
    let q = parse(
        "select n: jobs collect { employer where text(\"a\") } from people where text(\"b\") && size(x) > 1 order by text(\"c\")",
    );
    let out = transform(&q, &mut |e, _| match e {
        Expr::Call {
            recv: None,
            name,
            args,
            span,
        } if name == "text" => Expr::Call {
            recv: Some(Box::new(build::ident("$self"))),
            name,
            args,
            span,
        },
        other => other,
    });
    assert_eq!(
        print_query(&out).unwrap(),
        "select n: jobs collect { employer: employer where $self.text(\"a\") } from people where $self.text(\"b\") && size(x) > 1 order by $self.text(\"c\")"
    );
    // spans survive: the untouched source and the rebuilt root keep theirs
    assert_eq!(out.source.span(), q.source.span());
    assert_eq!(out.span, q.span);
    assert_eq!(transform(&q, &mut |e, _| e), q);
}

#[test]
fn print_is_canonical() {
    assert_eq!(
        canon("name,id   from people where (age>=18)&&!(x==1)"),
        "select name: name, id: id from people where age >= 18 && !(x == 1)"
    );
    assert_eq!(
        canon("from p where (a && b) || c"),
        "from p where a && b || c"
    );
    assert_eq!(
        canon("from p where (a || b) && c"),
        "from p where (a || b) && c"
    );
    assert_eq!(
        canon("select v: (a + b) * c - (d - e), w: a - (b - c), x: -(a + 1), y: (a.b).c() from p"),
        "select v: (a + b) * c - (d - e), w: a - (b - c), x: -(a + 1), y: a.b.c() from p"
    );
    assert_eq!(
        canon("select s: 'it\\'s', t: \"a\\nb\\\"c\" from p"),
        "select s: \"it's\", t: \"a\\nb\\\"c\" from p"
    );
    assert_eq!(
        canon("select a: 'q', b: 1e3, c: 2.50, d: true, e: null, f: 1e21 from p"),
        "select a: \"q\", b: 1000, c: 2.5, d: true, e: null, f: 1e+21 from p"
    );
    assert_eq!(
        canon("from p where n in 1+1..2*3 && (m in ..5) && k in 5.."),
        "from p where n in 1 + 1..2 * 3 && m in ..5 && k in 5.."
    );
    assert_eq!(
        canon("people count distinct { select employer }"),
        "people count distinct { employer: employer }"
    );
    assert_eq!(
        canon("people collect { name }"),
        "select name: name from people"
    );
    assert_eq!(
        canon("r collect { $it values from jobs }"),
        "r collect { $it: $it values from jobs }"
    );
    assert_eq!(canon("x: (1).size() from r"), "select x: (1).size() from r");
    assert_eq!(
        canon(
            "id from t follow distinct a, ^t collect { where p == ^id } { depth 3 by id where x frontier y }"
        ),
        "select id: id from t follow distinct a, ^t collect { where p == ^id } { where x frontier y depth 3 by id }"
    );
    assert_eq!(
        canon("select name, adult: age >= 18 from people where adult"),
        "select name: name, adult: age >= 18 from people where adult"
    );
    assert_eq!(canon("distinct from r"), "distinct: distinct from r");
    assert_eq!(
        canon("from p where !jobs count { } > 1 && jobs none { }"),
        "from p where !jobs count { } > 1 && jobs none { }"
    );
    // any node prints
    let q = parse("select n: jobs collect { employer } from people where a > 1 order by name desc");
    assert_eq!(
        print(Node::Where(q.r#where.as_ref().unwrap())).unwrap(),
        "a > 1"
    );
    assert_eq!(
        print(Node::Select(&q.select[0])).unwrap(),
        "n: jobs collect { employer: employer }"
    );
    assert_eq!(
        print(Node::Order(&q.order_by.as_ref().unwrap()[0])).unwrap(),
        "name desc"
    );
    assert_eq!(print(Node::Subquery(&build::subquery())).unwrap(), "{ }");
}

#[test]
fn print_fails_on_a_binding_and_print_template_emits_fragments() {
    let q = parse_template(&["name from ", " where id == ", ""], 2).unwrap();
    let e = print_query(&q).unwrap_err();
    assert_eq!(e.stage, Stage::Print);
    assert!(e.message.contains("print_template"), "{}", e.message);
    let t = print_template(Node::Query(&q));
    assert_eq!(t.strings, ["select name: name from ", " where id == ", ""]);
    assert_eq!((t.count, t.indices), (2, vec![0, 1]));
    // the canonical clause order can move a binding past another; `indices` says so
    let r = parse_template(&["", " collect { x: ", " }"], 2).unwrap();
    let t = print_template(Node::Query(&r));
    assert_eq!(t.strings, ["select x: ", " from ", ""]);
    assert_eq!(t.indices, [1, 0]);
}

#[test]
fn resolve_aliases_substitutes_once() {
    let q = parse(
        "select name: name.upper(), cur: jobs collect { employer where !end } from people where name == \"BOB\" && cur",
    );
    let r = resolve_aliases(&q).unwrap();
    assert_eq!(
        print_query(&r).unwrap(),
        "select name: name.upper(), cur: jobs collect { employer: employer where !end } from people where name.upper() == \"BOB\" && jobs collect { employer: employer where !end }"
    );
    assert_eq!(r.select, q.select);
    let plain = parse("from p where a");
    assert_eq!(resolve_aliases(&plain).unwrap(), plain);
    let mut cyclic = build::query(build::ident("p"));
    cyclic.select = vec![
        build::field("a", build::ident("b")),
        build::field("b", build::ident("a")),
    ];
    cyclic.r#where = Some(build::scalar(build::ident("a")));
    let e: OqxError = resolve_aliases(&cyclic).unwrap_err();
    assert_eq!(e.stage, Stage::Parse);
    assert!(e.message.contains("cycle"), "{}", e.message);
}

#[test]
fn ast_to_json_stamps_the_language_version_and_reads_back() {
    let src = "select name, n: jobs collect { } from p where a in 1..5 limit 2";
    let q = parse(src);
    let j = ast_to_json(&q);
    assert_eq!(j["oqx"], json!(LANGUAGE_VERSION));
    assert_eq!(j["kind"], json!("query"));
    assert_eq!(j["consumer"], json!("collect"));
    assert_eq!(j["limit"]["value"], json!(2));
    assert_eq!(j["offset"], json!(null));
    assert_eq!(j["select"][1]["op"]["kind"], json!("op"));
    assert_eq!(j["select"][1]["op"]["countCmp"], json!(null));
    assert_eq!(j["where"]["expr"]["right"]["exclusiveEnd"], json!(false));
    assert_eq!(j["span"], json!([0, src.chars().count()]));
    let back = query_from_json(&j).unwrap();
    assert_eq!(back, q);
}

#[test]
fn builders_make_empty_span_nodes_that_print() {
    let mut edges_body = build::subquery();
    edges_body.select = vec![build::field("id", build::ident("$id"))];
    let mut q = build::query(build::ident("docs"));
    q.select = vec![
        build::field("_depth", build::ident("$depth")),
        build::collect(
            "_edges",
            build::op(
                build::path(&["doc", "out_edges"]),
                oqx::Consumer::Collect,
                edges_body,
            ),
        ),
    ];
    q.r#where = Some(build::or(vec![
        build::scalar(build::binary(
            BinaryOp::Eq,
            build::ident("$id"),
            build::lit("d_0"),
        )),
        build::scalar(build::binary(
            BinaryOp::Eq,
            build::ident("$id"),
            build::lit("d_1"),
        )),
    ]));
    let mut walk = build::follow(vec![oqx::FollowDestination::Relation(build::path(&[
        "doc", "out",
    ]))]);
    walk.distinct = true;
    walk.depth = Some(2);
    q.follow = Some(walk);
    assert_eq!(q.span, Span::EMPTY);
    assert_eq!(q.limit, None);
    let printed = print_query(&q).unwrap();
    assert_eq!(
        printed,
        "select _depth: $depth, _edges: doc.out_edges collect { id: $id } from docs where $id == \"d_0\" || $id == \"d_1\" follow distinct doc.out { depth 2 }"
    );
    assert_eq!(strip_spans(&parse(&printed)), q);
    assert_eq!(
        build::lit(1.5),
        Expr::Lit {
            value: Value::Number(1.5),
            span: Span::EMPTY
        }
    );
}
