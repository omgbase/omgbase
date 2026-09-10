// OQX structural parser (slice 1). Parses query STRUCTURE (from/where/select +
// receiver-constrained collection ops) and captures scalar predicate/value
// interiors verbatim as source slices for the CEL layer. Throws FilterInvalid
// (from the CEL parser) so MCP/CLI error mapping is uniform.

import { lexOqx, type OqxToken, OqxLexError } from "./lexer.js";
import { FilterInvalid } from "../search/cel/parser.js";
import type {
  SurfaceQuery, SurfaceTarget, SurfaceTerm, SurfaceOp, SurfaceSubquery, SurfaceSelectItem,
} from "./ast.js";

const RECEIVER_ROOTS = new Set(["nodes", "blocks", "doc", "node", "block"]);
const OP_NAMES = new Set(["collect", "exists", "count"]);
const TARGETS = new Set(["docs", "blocks", "nodes"]);

export function parseOqx(src: string): SurfaceQuery {
  let tokens: OqxToken[];
  try {
    tokens = lexOqx(src);
  } catch (e) {
    throw new FilterInvalid(e instanceof OqxLexError ? e.message : String(e), "OQX §1");
  }
  return new OqxParser(src, tokens).parseQuery();
}

class OqxParser {
  private pos = 0;
  constructor(private src: string, private tokens: OqxToken[]) {}

  private peek(): OqxToken { return this.tokens[this.pos]!; }
  private next(): OqxToken { return this.tokens[this.pos++]!; }
  private at(type: string, value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  private fail(msg: string): never {
    throw new FilterInvalid(msg, "OQX §1");
  }

  parseQuery(): SurfaceQuery {
    if (!this.at("kw", "from")) this.fail("OQX query must start with `from`");
    this.next();
    const t = this.next();
    if (t.type !== "ident" && !(t.type === "kw")) this.fail("expected a target after `from`");
    const from = t.value as SurfaceTarget;
    if (!TARGETS.has(from)) this.fail(`unknown target '${t.value}' — use docs|blocks|nodes`);

    const q: SurfaceQuery = { from, where: [], select: [] };
    let sawWhere = false;
    let sawSelect = false;
    while (!this.at("eof")) {
      if (this.at("kw", "where")) {
        if (sawWhere) this.fail("duplicate `where` clause");
        sawWhere = true;
        this.next();
        q.where = this.parseWhereTerms();
      } else if (this.at("kw", "select")) {
        if (sawSelect) this.fail("duplicate `select` clause");
        sawSelect = true;
        this.next();
        q.select = this.parseSelectItems();
      } else {
        this.fail(`unexpected '${this.peek().value || this.peek().type}' — expected where/select`);
      }
    }
    return q;
  }

  // where := term { "&&" term }
  private parseWhereTerms(): SurfaceTerm[] {
    const terms: SurfaceTerm[] = [this.parseTerm()];
    while (this.at("and")) {
      this.next();
      terms.push(this.parseTerm());
    }
    return terms;
  }

  // A term is a collection op if it begins with a receiver root and its dotted
  // chain ends in an op keyword followed by '('. Otherwise it is a scalar run.
  private parseTerm(): SurfaceTerm {
    const op = this.tryParseOp();
    if (op) return op;
    return this.parseScalarRun();
  }

  // Detect + parse `<receiver>.<op>( <subquery> )`. Returns null (without
  // consuming) if the lookahead is not an op call.
  private tryParseOp(): SurfaceOp | null {
    const start = this.pos;
    if (!this.at("ident") || !RECEIVER_ROOTS.has(this.peek().value)) return null;
    // scan a dotted ident chain
    const segments: string[] = [this.next().value];
    while (this.at("dot")) {
      this.next();
      if (!this.at("ident")) { this.pos = start; return null; }
      segments.push(this.next().value);
    }
    // must be `... op (`
    const opName = segments[segments.length - 1]!;
    if (segments.length < 2 || !OP_NAMES.has(opName) || !this.at("lparen")) {
      this.pos = start; // not an op call — rewind, treat as scalar
      return null;
    }
    const receiver = segments.slice(0, -1).join(".");
    this.next(); // consume '('
    const sub = this.parseSubquery();
    if (!this.at("rparen")) this.fail(`expected ')' to close ${receiver}.${opName}(...)`);
    this.next();
    return { kind: "op", receiver, op: opName as SurfaceOp["op"], sub };
  }

  // Nested query body: optional `where <terms>` then optional `select <items>`.
  // An implicit leading where is also allowed (bare terms without the keyword),
  // matching the spec's `nodes.collect(where kind == "x")`. We require the
  // `where`/`select` keywords for clarity in slice 1.
  private parseSubquery(): SurfaceSubquery {
    const sub: SurfaceSubquery = { where: [], select: [] };
    let sawWhere = false;
    let sawSelect = false;
    while (!this.at("rparen") && !this.at("eof")) {
      if (this.at("kw", "where")) {
        if (sawWhere) this.fail("duplicate `where` in nested query");
        sawWhere = true;
        this.next();
        sub.where = this.parseWhereTerms();
      } else if (this.at("kw", "select")) {
        if (sawSelect) this.fail("duplicate `select` in nested query");
        sawSelect = true;
        this.next();
        sub.select = this.parseSelectItems();
      } else {
        this.fail(`unexpected '${this.peek().value || this.peek().type}' in nested query — expected where/select`);
      }
    }
    return sub;
  }

  // select := item { "," item };  item := ident | ident ":" (op | scalar)
  private parseSelectItems(): SurfaceSelectItem[] {
    const items: SurfaceSelectItem[] = [this.parseSelectItem()];
    while (this.at("comma")) {
      this.next();
      items.push(this.parseSelectItem());
    }
    return items;
  }

  private parseSelectItem(): SurfaceSelectItem {
    if (!this.at("ident") && !this.at("field")) this.fail("expected a projection name/field");
    const nameTok = this.next();
    if (this.at("colon")) {
      this.next();
      const name = nameTok.value;
      // named projection: either a nested collect op, or a scalar value expr.
      const op = this.tryParseOp();
      if (op) {
        if (op.op !== "collect") this.fail(`select projection '${name}' must use collect(...), not ${op.op}(...)`);
        return { kind: "collect", name, op };
      }
      const source = this.captureScalarUntilSelectBoundary();
      if (!source) this.fail(`projection '${name}' has no value expression`);
      return { kind: "field", name, source };
    }
    // bare field passthrough: `path`, `kind`, `$path`, …
    return { kind: "field", name: nameTok.value, source: nameTok.value };
  }

  // Capture a scalar run (verbatim source) up to the next depth-0 boundary:
  // `&&`, a where/select keyword, a comma, a ')', or eof.
  private parseScalarRun(): SurfaceTerm {
    const source = this.captureScalarUntilTermBoundary();
    if (!source) this.fail("empty predicate term");
    return { kind: "scalar", source };
  }

  private captureScalarUntilTermBoundary(): string {
    return this.captureScalar(/* stopOnComma */ false);
  }
  private captureScalarUntilSelectBoundary(): string {
    return this.captureScalar(/* stopOnComma */ true);
  }

  // Slice raw source from the current token to the stopping token, tracking
  // paren depth so structural chars inside a scalar (e.g. f(a, b), "a && b")
  // don't end the run prematurely.
  private captureScalar(stopOnComma: boolean): string {
    const startTok = this.peek();
    const startOff = startTok.pos;
    let depth = 0;
    let endOff = startOff;
    while (!this.at("eof")) {
      const t = this.peek();
      if (depth === 0) {
        if (t.type === "and") break;
        if (t.type === "kw" && (t.value === "where" || t.value === "select")) break;
        if (t.type === "rparen") break;
        if (stopOnComma && t.type === "comma") break;
      }
      if (t.type === "lparen") depth++;
      else if (t.type === "rparen") depth--;
      // advance; record end as the offset just past this token's value
      endOff = t.pos + t.value.length;
      this.next();
    }
    return this.src.slice(startOff, endOff).trim();
  }
}
