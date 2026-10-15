// The DQL parser: shapes and error positions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DqlError, parseDql } from "../src/index.ts";

function parseError(dql: string): DqlError {
  try { parseDql(dql); } catch (e) { if (e instanceof DqlError) return e; throw e; }
  throw new Error(`expected a parse error for ${JSON.stringify(dql)}`);
}

test("a query is its type, fields, source and commands in order", () => {
  const q = parseDql('TABLE WITHOUT ID a, b AS "B" FROM #t WHERE a SORT b DESC LIMIT 2');
  assert.equal(q.type, "TABLE");
  assert.equal(q.withoutId, true);
  assert.deepEqual(q.fields.map((f) => [f.text, f.alias]), [["a", null], ["b", "B"]]);
  assert.equal(q.from?.kind, "tag");
  assert.deepEqual(q.commands.map((c) => c.kind), ["where", "sort", "limit"]);
});

test("sources nest with and/or/not and parentheses", () => {
  const q = parseDql('LIST FROM "a" AND (#b OR -[[c]])');
  const s = q.from!;
  assert.equal(s.kind, "and");
  if (s.kind !== "and") throw new Error("unreachable");
  assert.equal(s.left.kind, "folder");
  assert.equal(s.right.kind, "or");
  if (s.right.kind !== "or") throw new Error("unreachable");
  assert.equal(s.right.right.kind, "not");
});

test("bare date and duration literals are read off the raw source", () => {
  const q = parseDql("TABLE date(today), date(2026-10-15), dur(1 hour 30 minutes), dur(day), date(due) FROM \"a\"");
  assert.deepEqual(q.fields.map((f) => f.expr.kind), ["date", "date", "duration", "call", "call"]);
  const d = q.fields[2]!.expr;
  assert.equal(d.kind === "duration" ? d.text : null, "1 hour 30 minutes");
});

test("precedence: | < & < comparison < + - < * / % < unary < postfix", () => {
  const q = parseDql("LIST WHERE a | b & c = d + e * f.g[0]");
  const w = q.commands[0]!;
  if (w.kind !== "where") throw new Error("unreachable");
  const e = w.expr;
  assert.equal(e.kind === "binary" ? e.op : null, "|");
  if (e.kind !== "binary") throw new Error("unreachable");
  assert.equal(e.right.kind === "binary" ? e.right.op : null, "&");
  if (e.right.kind !== "binary") throw new Error("unreachable");
  const cmp = e.right.right;
  assert.equal(cmp.kind === "binary" ? cmp.op : null, "=");
  if (cmp.kind !== "binary") throw new Error("unreachable");
  assert.equal(cmp.right.kind === "binary" ? cmp.right.op : null, "+");
  if (cmp.right.kind !== "binary") throw new Error("unreachable");
  assert.equal(cmp.right.right.kind === "binary" ? cmp.right.right.op : null, "*");
  if (cmp.right.right.kind !== "binary") throw new Error("unreachable");
  assert.equal(cmp.right.right.right.kind, "index");
});

test("links keep their target, display and embed flag", () => {
  const q = parseDql("TABLE [[Note#Heading|shown]], ![[Img]] FROM \"a\"");
  const [a, b] = q.fields.map((f) => f.expr);
  assert.deepEqual(a?.kind === "link" ? [a.target, a.display, a.embed] : null, ["Note", "shown", false]);
  assert.deepEqual(b?.kind === "link" ? [b.target, b.display, b.embed] : null, ["Img", null, true]);
});

test("lambdas parse in both spellings", () => {
  const q = parseDql("TABLE filter(xs, (x) => x.ok), map(xs, x => x.n) FROM \"a\"");
  const [a, b] = q.fields.map((f) => f.expr);
  assert.equal(a?.kind === "call" ? a.args[1]?.kind : null, "lambda");
  assert.equal(b?.kind === "call" ? b.args[1]?.kind : null, "lambda");
});

test("parse errors carry line and column", () => {
  const e = parseError('LIST FROM "a"\nWHERE (a = 1');
  assert.equal(e.code, "parse");
  assert.deepEqual([e.position?.line, e.position?.column], [2, 13]);
  assert.match(e.message, /expected '\)'/);

  const head = parseError("SELECT x");
  assert.match(head.message, /starts with TABLE, LIST, TASK or CALENDAR/);
  assert.deepEqual([head.position?.line, head.position?.column], [1, 1]);

  const str = parseError('LIST WHERE a = "open');
  assert.match(str.message, /unterminated string/);
  assert.equal(str.position?.column, 16);

  const two = parseError("LIST a, b");
  assert.match(two.message, /LIST takes at most one expression/);
  assert.equal(two.position?.column, 9);

  const cal = parseError("CALENDAR");
  assert.match(cal.message, /CALENDAR needs exactly one date field/);

  const without = parseError("TASK WITHOUT ID");
  assert.match(without.message, /WITHOUT ID applies to TABLE and LIST/);

  const stray = parseError("LIST FROM \"a\" ORDER BY x");
  assert.match(stray.message, /expected WHERE, SORT, LIMIT, GROUP BY or FLATTEN/);
  assert.equal(stray.position?.column, 15);

  const bad = parseError("LIST WHERE a ~ b");
  assert.match(bad.message, /unexpected character '~'/);
});
