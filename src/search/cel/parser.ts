import { lex, type Token, LexError } from "./lexer.js";
import type { Node, Literal, RelOp } from "./ast.js";

// Recursive-descent parser for the CEL subset (10 §3.1). Throws FilterInvalid
// with a reason + hint on anything outside the grammar.

export class FilterInvalid extends Error {
  reason: string;
  hint: string;
  constructor(reason: string, hint = "see 10-query-language.md §3") {
    super(reason);
    this.reason = reason;
    this.hint = hint;
  }
}

const RELOPS = new Set(["==", "!=", "<", "<=", ">", ">="]);

export function parseFilter(src: string): Node {
  let tokens: Token[];
  try {
    tokens = lex(src);
  } catch (e) {
    throw new FilterInvalid(e instanceof LexError ? e.message : String(e));
  }
  const p = new Parser(tokens);
  const node = p.parseExpr();
  p.expect("eof");
  return node;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token { return this.tokens[this.pos]!; }
  private next(): Token { return this.tokens[this.pos++]!; }
  expect(type: string): Token {
    const t = this.peek();
    if (t.type !== type) throw new FilterInvalid(`expected ${type} but found '${t.value || t.type}' at ${t.pos}`);
    return this.next();
  }

  parseExpr(): Node { return this.parseOr(); }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peek().type === "op" && this.peek().value === "||") {
      this.next();
      left = { kind: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseUnary();
    while (this.peek().type === "op" && this.peek().value === "&&") {
      this.next();
      left = { kind: "and", left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.peek().type === "op" && this.peek().value === "!") {
      this.next();
      return { kind: "not", operand: this.parseUnary() };
    }
    return this.parseComparison();
  }

  // comparison | membership | (primary that may stand alone as boolean)
  private parseComparison(): Node {
    const left = this.parsePostfix(this.parsePrimary());

    // membership: literal in list(field) — detect the `in` keyword
    if (this.peek().type === "ident" && this.peek().value === "in") {
      this.next();
      const listCall = this.parsePrimary();
      if (listCall.kind !== "call" || listCall.name !== "list") {
        throw new FilterInvalid("`in` is only allowed as `<literal> in list(field)`", "10 §4");
      }
      if (left.kind !== "literal") {
        throw new FilterInvalid("left side of `in list()` must be a literal", "10 §4");
      }
      const fieldArg = listCall.args[0];
      if (!fieldArg || fieldArg.kind !== "field") {
        throw new FilterInvalid("list() takes a single field argument", "10 §4");
      }
      return { kind: "membership", value: left, field: fieldArg };
    }

    if (this.peek().type === "op" && RELOPS.has(this.peek().value)) {
      const op = this.next().value as RelOp;
      const right = this.parsePostfix(this.parsePrimary());
      return { kind: "comparison", op, left, right };
    }

    if (this.peek().type === "op" && ["+", "-", "*", "/"].includes(this.peek().value)) {
      throw new FilterInvalid("arithmetic is not supported", "10 §3.1");
    }

    return left;
  }

  // handle method calls: receiver.name(args) and quantifiers .exists/.all
  private parsePostfix(node: Node): Node {
    let cur = node;
    while (this.peek().type === "dot") {
      this.next();
      const name = this.expect("ident").value;
      if (this.peek().type !== "lparen") {
        // dotted field continuation (only valid if receiver was a field)
        if (cur.kind === "field") {
          cur = { kind: "field", segments: [...cur.segments, name], intrinsic: cur.intrinsic };
          continue;
        }
        throw new FilterInvalid(`unexpected '.${name}' — method call requires '('`);
      }
      const args = this.parseArgs();
      if (name === "exists" || name === "all") {
        // first arg must be an identifier (the bound var), rest is the predicate
        const [varArg, pred] = args as [Node, Node];
        if (!varArg || varArg.kind !== "field" || varArg.segments.length !== 1 || varArg.intrinsic) {
          throw new FilterInvalid(`${name}() first argument must be a bound variable name`, "10 §3.2");
        }
        if (!pred) throw new FilterInvalid(`${name}() requires a predicate`, "10 §3.2");
        cur = { kind: "quantifier", collection: cur, op: name, varName: varArg.segments[0]!, predicate: pred };
      } else {
        cur = { kind: "method", receiver: cur, name, args };
      }
    }
    return cur;
  }

  private parseArgs(): Node[] {
    this.expect("lparen");
    const args: Node[] = [];
    if (this.peek().type !== "rparen") {
      args.push(this.parseExpr());
      while (this.peek().type === "comma") {
        this.next();
        args.push(this.parseExpr());
      }
    }
    this.expect("rparen");
    return args;
  }

  private parsePrimary(): Node {
    const t = this.peek();

    if (t.type === "lparen") {
      this.next();
      const e = this.parseExpr();
      this.expect("rparen");
      return e;
    }

    if (t.type === "string") { this.next(); return lit(t.value, "string"); }
    if (t.type === "int") { this.next(); return { kind: "literal", value: parseInt(t.value, 10), type: "int" }; }
    if (t.type === "double") { this.next(); return { kind: "literal", value: parseFloat(t.value), type: "double" }; }
    if (t.type === "bool") { this.next(); return { kind: "literal", value: t.value === "true", type: "bool" }; }
    if (t.type === "null") { this.next(); return { kind: "literal", value: null, type: "null" }; }

    if (t.type === "field") {
      this.next();
      return { kind: "field", segments: [t.value], intrinsic: true };
    }

    if (t.type === "ident") {
      if (t.value === "in") throw new FilterInvalid("unexpected keyword `in`");
      this.next();
      // function call?
      if (this.peek().type === "lparen") {
        const args = this.parseArgs();
        rejectClock(t.value);
        return { kind: "call", name: t.value, args };
      }
      // bare field (frontmatter key or bare block field)
      return { kind: "field", segments: [t.value], intrinsic: false };
    }

    if (t.type === "op" && (t.value === "+" || t.value === "-" || t.value === "*" || t.value === "/")) {
      throw new FilterInvalid("arithmetic is not supported", "10 §3.1");
    }

    throw new FilterInvalid(`unexpected token '${t.value || t.type}' at ${t.pos}`);
  }
}

function lit(value: string, type: Literal["type"]): Literal {
  return { kind: "literal", value, type };
}

function rejectClock(name: string): void {
  if (name === "now" || name === "random" || name === "rand") {
    throw new FilterInvalid(`${name}() is rejected — determinism is load-bearing`, "10 §3.1");
  }
}
