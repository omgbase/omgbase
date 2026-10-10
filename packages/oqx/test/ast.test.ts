// The first-class AST contract (spec/oqx/AST.md, language 0.16): spans, the
// traversal (`visit` / `transform`), the canonical printer, template printing,
// alias resolution, the JSON form and the builders. The fixture suites
// `ast.json` / `ast-spans.json` pin the shape; this file pins the API around it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parse, parseTemplate, print, printTemplate, visit, transform, stripSpans, toJSON, toUtf16, resolveAliases,
  rawSource, CHILDREN, build, OqxError, LANGUAGE_VERSION, run,
} from "../src/index.ts";
import type { AstNode, Clause, Expr, Query } from "../src/index.ts";

// ---- spans ---------------------------------------------------------------------

test("spans count code points over the raw source", () => {
  const src = 'from p where s == "😀" && n > 1';
  const q = parse(src);
  // `"😀"` is three code points: the quotes and one astral character.
  const w = q.where!;
  assert.equal(w.kind, "and");
  if (w.kind !== "and") throw new Error("unreachable");
  const cmp = w.parts[0]!;
  assert.deepEqual(cmp.span, [13, 21]);
  const cps = Array.from(src);
  assert.equal(cps.slice(13, 21).join(""), 's == "😀"');
  // The next conjunct starts after the astral character — one code point, two UTF-16 units.
  assert.deepEqual(w.parts[1]!.span, [25, 30]);
  assert.deepEqual(toUtf16(w.parts[1]!.span, src), [26, 31]);
  assert.equal(src.slice(26, 31), "n > 1");
  assert.deepEqual(toUtf16([0, cps.length], src), [0, src.length]);
});

test("parse errors report code-point offsets", () => {
  assert.throws(() => parse('from p where s == "😀" from'), (e: unknown) => e instanceof OqxError && /at offset 22\)/.test(e.message));
});

test("a template's spans are measured over rawSource, where a binding occupies its marker", () => {
  const strings = ["name from ", " where id == ", ""];
  const q = parseTemplate(strings, 2);
  assert.equal(rawSource(strings), "name from ${0} where id == ${1}");
  assert.deepEqual(q.source.span, [10, 14]);
  const w = q.where!;
  if (w.kind !== "scalar" || w.expr.kind !== "binary") throw new Error("unreachable");
  assert.deepEqual(w.expr.right.span, [27, 31]);
});

// ---- visit ---------------------------------------------------------------------

test("visit: canonical order, path, clause and scope depth", () => {
  const q = parse("select n: jobs collect { employer where !end limit ^k } from people where active follow kids { where x > ^id } order by name limit 2");
  const seen: [string, Clause | null, number, number][] = [];
  visit(q, {
    enter(node, ctx) { seen.push([node.kind, ctx.clause, ctx.depth, ctx.path.length]); },
  });
  const expectRows: [string, Clause | null, number, number][] = [
    ["query", null, 0, 0],
    ["collect", "select", 1, 1],
    ["op", "select", 1, 2],
    ["ident", "select", 1, 3], // the receiver `jobs`, read in the row scope
    ["subquery", "select", 2, 3], // the block's rows, one deeper
    ["field", "select", 2, 4],
    ["ident", "select", 2, 5],
    ["not", "where", 2, 4],
    ["scalar", "where", 2, 5],
    ["ident", "where", 2, 6],
    ["outer", "limit", 2, 4], // a block's bound is read at the block's depth
    ["ident", "source", 0, 1], // the source, at the root scope
    ["scalar", "where", 1, 1],
    ["ident", "where", 1, 2],
    ["follow", "follow", 1, 1],
    ["ident", "follow.destination", 1, 2],
    ["binary", "follow.where", 2, 2], // a successor is tested one scope deeper than the frontier row
    ["ident", "follow.where", 2, 3],
    ["outer", "follow.where", 2, 3],
    ["order", "orderBy", 1, 1],
    ["ident", "orderBy", 1, 2],
    ["lit", "limit", 0, 1], // a top-level bound is read at the root scope
  ];
  assert.deepEqual(seen, expectRows);
});

test("visit: enter may skip a subtree; leave is still called", () => {
  const q = parse("select n: jobs collect { employer } from people where active");
  const entered: string[] = [];
  const left: string[] = [];
  visit(q, {
    enter(node) { entered.push(node.kind); return node.kind !== "op"; },
    leave(node) { left.push(node.kind); },
  });
  assert.deepEqual(entered, ["query", "collect", "op", "ident", "scalar", "ident"]);
  assert.deepEqual(left, ["op", "collect", "ident", "ident", "scalar", "query"]);
});

test("CHILDREN names every node kind and every child slot", () => {
  const kinds = Object.keys(CHILDREN).sort();
  assert.deepEqual(kinds, [
    "and", "binary", "binding", "call", "collect", "field", "follow", "ident", "in", "lit", "logical", "member", "not", "op",
    "or", "order", "outer", "query", "range", "required", "scalar", "subquery", "unary",
  ]);
  // Every node reached by the walk has exactly the children the table names
  // (no slot holding a node is missing from the table).
  const q = parse("select distinct a, b: x.y(1, -2), c: r collect { $it values where k in 1..3 || !(^z == 3) order by m limit 1 offset ^o } from p where q exists { } && !t follow ^p collect { where w }, u { where x frontier y depth 2 by z } order by a desc limit 1 offset 0");
  const isNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && "kind" in v && "span" in v;
  visit(q, {
    enter(node) {
      const named = new Set(CHILDREN[node.kind].map((c) => c.key));
      for (const [k, v] of Object.entries(node)) {
        const holds = isNode(v) || (Array.isArray(v) && v.some(isNode));
        if (holds) assert.ok(named.has(k), `${node.kind}.${k} holds a node but is not in CHILDREN`);
      }
    },
  });
});

// ---- transform -------------------------------------------------------------------

test("transform maps every expression bottom-up and keeps untouched nodes by reference", () => {
  const q = parse("select n: jobs collect { employer where text(\"a\") } from people where text(\"b\") && size(x) > 1 order by text(\"c\")");
  const self: Expr = build.ident("$self");
  const out = transform(q, (e) => (e.kind === "call" && e.recv === null && e.name === "text" ? { ...e, recv: self } : e));
  assert.equal(print(out), 'select n: jobs collect { employer: employer where $self.text("a") } from people where $self.text("b") && size(x) > 1 order by $self.text("c")');
  assert.notEqual(out, q);
  // the source and the select item's `employer` field were not touched
  assert.equal(out.source, q.source);
  assert.equal(out.select[0]!.kind, "collect");
  const before = q.select[0]!.kind === "collect" ? q.select[0].op.sub.select[0] : null;
  const after = out.select[0]!.kind === "collect" ? out.select[0].op.sub.select[0] : null;
  assert.equal(after, before);
  // an identity transform returns the same object
  assert.equal(transform(q, (e) => e), q);
  // spans survive on every untouched node and on a rebuilt parent
  assert.deepEqual(out.span, q.span);
});

// ---- print -----------------------------------------------------------------------

test("print is canonical: keyword, spacing, quotes, minimal parentheses", () => {
  const canon = (src: string): string => print(parse(src));
  assert.equal(canon("name,id   from people where (age>=18)&&!(x==1)"), "select name: name, id: id from people where age >= 18 && !(x == 1)");
  assert.equal(canon("from p where a && (b || c)"), "from p where a && (b || c)");
  assert.equal(canon("from p where (a && b) || c"), "from p where a && b || c");
  assert.equal(canon("from p where (a || b) && c"), "from p where (a || b) && c");
  assert.equal(canon("select v: (a + b) * c - (d - e), w: a - (b - c), x: -(a + 1), y: (a.b).c() from p"), "select v: (a + b) * c - (d - e), w: a - (b - c), x: -(a + 1), y: a.b.c() from p");
  assert.equal(canon("select s: 'it\\'s', t: \"a\\nb\\\"c\" from p"), 'select s: "it\'s", t: "a\\nb\\"c" from p');
  assert.equal(canon("select a: 'q', b: 1e3, c: 2.50, d: true, e: null from p"), 'select a: "q", b: 1000, c: 2.5, d: true, e: null from p');
  assert.equal(canon("from p where n in 1+1..2*3 && (m in ..5) && k in 5.."), "from p where n in 1 + 1..2 * 3 && m in ..5 && k in 5..");
  assert.equal(canon("people count distinct { select employer }"), "people count distinct { employer: employer }");
  assert.equal(canon("select n: jobs collect { select distinct employer } from p"), "select n: jobs collect distinct { employer: employer } from p");
  assert.equal(canon("people collect { name }"), "select name: name from people");
  assert.equal(canon("r collect { $it values from jobs }"), "r collect { $it: $it values from jobs }");
  assert.equal(canon("x: (1).size() from r"), "select x: (1).size() from r");
  assert.equal(canon("id from t follow distinct a, ^t collect { where p == ^id } { depth 3 by id where x frontier y }"), "select id: id from t follow distinct a, ^t collect { where p == ^id } { where x frontier y depth 3 by id }");
  assert.equal(canon("select name, adult: age >= 18 from people where adult"), "select name: name, adult: age >= 18 from people where adult");
  assert.equal(canon("from p where !jobs count { } > 1 && jobs none { }"), "from p where !jobs count { } > 1 && jobs none { }");
  assert.equal(canon("distinct from r"), "distinct: distinct from r");
  assert.equal(canon("name, employers from p where jobs collect { ^employers: employer where !end }"), "select name: name, employers: employers from p where jobs collect { ^employers: employer where !end }");
});

test("print accepts any node", () => {
  const q = parse("select n: jobs collect { employer } from people where a > 1 order by name desc");
  assert.equal(print(q.where!), "a > 1");
  assert.equal(print(q.select[0]!), "n: jobs collect { employer: employer }");
  assert.equal(print(q.orderBy![0]!), "name desc");
  if (q.select[0]!.kind !== "collect") throw new Error("unreachable");
  assert.equal(print(q.select[0].op.sub), "{ employer: employer }");
  assert.equal(print(build.subquery()), "{ }");
});

test("print throws on a binding; printTemplate emits fragments and the binding order", () => {
  const q = parseTemplate(["name from ", " where id == ", ""], 2);
  assert.throws(() => print(q), (e: unknown) => e instanceof OqxError && e.stage === "print" && /printTemplate/.test(e.message));
  assert.deepEqual(printTemplate(q), { strings: ["select name: name from ", " where id == ", ""], count: 2, indices: [0, 1] });
  // the canonical clause order can move a binding past another; `indices` says so
  const r = parseTemplate(["", " collect { x: ", " }"], 2);
  assert.deepEqual(printTemplate(r), { strings: ["select x: ", " from ", ""], count: 2, indices: [1, 0] });
});

// ---- resolveAliases ------------------------------------------------------------------

test("resolveAliases substitutes once, keeps untouched nodes, and is what the entry points apply", () => {
  const q = parse("select name: name.upper(), cur: jobs collect { employer where !end } from people where name == \"BOB\" && cur");
  const r = resolveAliases(q);
  assert.equal(print(r), 'select name: name.upper(), cur: jobs collect { employer: employer where !end } from people where name.upper() == "BOB" && jobs collect { employer: employer where !end }');
  assert.equal(r.select, q.select);
  const plain = parse("from p where a");
  assert.equal(resolveAliases(plain), plain); // nothing to resolve: the same object
  const people = [{ name: "Bob", jobs: [{ employer: "x" }] }, { name: "Al", jobs: [] }];
  assert.deepEqual(run(q, { roots: { people } }), { consumer: "collect", rows: [{ name: "BOB", cur: [{ employer: "x" }] }] });
  assert.throws(() => resolveAliases(build.query(build.ident("p"), {
    select: [build.field("a", build.ident("b")), build.field("b", build.ident("a"))],
    where: build.scalar(build.ident("a")),
  })), (e: unknown) => e instanceof OqxError && e.stage === "parse" && /cycle/.test(e.message));
});

// ---- JSON / builders / stripSpans ---------------------------------------------------

test("toJSON stamps the language version on the plain-data tree", () => {
  const q = parse("name from p");
  const j = toJSON(q);
  assert.equal(j.oqx, LANGUAGE_VERSION);
  assert.equal(j.kind, "query");
  assert.deepEqual(JSON.parse(JSON.stringify(j)), { oqx: "0.17", ...q });
});

test("builders make nodes with the empty span and materialized fields, and print them", () => {
  const q: Query = build.query(build.ident("docs"), {
    select: [
      build.field("_depth", build.ident("$depth")),
      build.collect("_edges", build.op(build.path("doc", "out_edges"), "collect", build.subquery({ select: [build.field("id", build.ident("$id"))] }))),
    ],
    where: build.or([build.scalar(build.binary("==", build.ident("$id"), build.lit("d_0"))), build.scalar(build.binary("==", build.ident("$id"), build.lit("d_1")))]),
    follow: build.follow([build.path("doc", "out")], { distinct: true, depth: 2 }),
  });
  assert.deepEqual(q.span, [0, 0]);
  assert.equal(q.limit, null);
  assert.equal(print(q), 'select _depth: $depth, _edges: doc.out_edges collect { id: $id } from docs where $id == "d_0" || $id == "d_1" follow distinct doc.out { depth 2 }');
  assert.deepEqual(stripSpans(parse(print(q))), stripSpans(q));
});
