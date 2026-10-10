// A small interpreter for the subset of Monarch this grammar uses, modelling the
// documented Monaco semantics: each line is tokenized on its own with the state
// stack carried over; at every position the rules of the top state are tried in
// order, each regex compiled as `^(?:…)` against the rest of the line, and the
// first match wins; an action is a token, `{ token, next }` (push `@state` / pop
// `@pop`), `{ cases }` over `@wordList` attributes with `@default`, or an array
// of those for consecutive capture groups; `tokenPostfix` is appended to every
// token; an unmatched character takes `defaultToken`. Nothing else is supported —
// a construct outside the subset throws, so the grammar cannot quietly rely on
// behavior this test does not model.
//
// monaco-editor itself is not a test dependency: its Monarch runtime is bound to
// the editor's services and DOM. The parity test with the TextMate engine is what
// keeps this grammar honest.

import type { MonarchAction, MonarchGrammar, MonarchRule } from "../src/monarch.js";
import { TOKEN_CLASSES, type TokenClass } from "../src/vocabulary.js";
import { normalize, type ClassToken } from "./tokens.js";

interface Compiled {
  regex: RegExp;
  action: MonarchAction;
}

export class MonarchTokenizer {
  private readonly states = new Map<string, Compiled[]>();

  constructor(private readonly grammar: MonarchGrammar) {
    for (const name of Object.keys(grammar.tokenizer)) this.states.set(name, this.compileState(name, new Set()));
  }

  private compileState(name: string, seen: Set<string>): Compiled[] {
    if (seen.has(name)) throw new Error(`include cycle at @${name}`);
    seen.add(name);
    const rules = this.grammar.tokenizer[name];
    if (!rules) throw new Error(`unknown state @${name}`);
    const out: Compiled[] = [];
    for (const rule of rules as MonarchRule[]) {
      if ("include" in rule) {
        out.push(...this.compileState(rule.include.replace(/^@/, ""), new Set(seen)));
        continue;
      }
      const [regex, action] = rule;
      if (typeof regex !== "string") throw new Error(`rule regex must be a string in @${name}`);
      if (/(^|[^\\])@/.test(regex.replaceAll("\\\\", ""))) throw new Error(`unsupported @attribute reference in regex: ${regex}`);
      out.push({ regex: new RegExp(`^(?:${regex})`, this.grammar.ignoreCase ? "i" : ""), action });
    }
    return out;
  }

  /** Raw tokens (`type` includes the postfix), whitespace as `white.oqx`. */
  tokenize(source: string): Array<{ text: string; type: string }> {
    const out: Array<{ text: string; type: string }> = [];
    const stack: string[] = ["root"];
    const lines = source.split("\n");
    lines.forEach((line, li) => {
      let pos = 0;
      while (pos < line.length) {
        const rest = line.slice(pos);
        const state = stack[stack.length - 1]!;
        const rules = this.states.get(state);
        if (!rules) throw new Error(`unknown state @${state}`);
        let matched = false;
        for (const { regex, action } of rules) {
          const m = regex.exec(rest);
          if (!m) continue;
          if (m[0].length === 0) throw new Error(`rule ${regex} matched the empty string`);
          this.apply(m, action, stack, out);
          pos += m[0].length;
          matched = true;
          break;
        }
        if (!matched) {
          out.push({ text: rest[0]!, type: this.postfix(this.grammar.defaultToken) });
          pos += 1;
        }
      }
      if (li < lines.length - 1) out.push({ text: "\n", type: "white" });
    });
    return out;
  }

  private apply(m: RegExpExecArray, action: MonarchAction, stack: string[], out: Array<{ text: string; type: string }>): void {
    if (Array.isArray(action)) {
      const groups = m.slice(1);
      if (groups.length !== action.length) throw new Error(`group action length ${action.length} != ${groups.length} groups for ${m[0]}`);
      if (groups.join("") !== m[0]) throw new Error(`capture groups must cover the match: ${JSON.stringify(m[0])}`);
      groups.forEach((g, i) => {
        if (g !== "") this.apply(Object.assign([g], { index: 0, input: g }) as RegExpExecArray, action[i]!, stack, out);
      });
      return;
    }
    if (typeof action === "string") {
      out.push({ text: m[0], type: this.postfix(action) });
      return;
    }
    if ("cases" in action) {
      out.push({ text: m[0], type: this.postfix(this.resolveCases(m[0], action.cases)) });
      return;
    }
    out.push({ text: m[0], type: this.postfix(action.token) });
    if (action.next) {
      if (action.next === "@pop") stack.pop();
      else if (action.next === "@push") stack.push(stack[stack.length - 1]!);
      else if (action.next.startsWith("@")) stack.push(action.next.slice(1));
      else throw new Error(`unsupported next: ${action.next}`);
    }
  }

  private resolveCases(text: string, cases: Record<string, string>): string {
    for (const [guard, token] of Object.entries(cases)) {
      if (guard === "@default") continue;
      if (!guard.startsWith("@")) throw new Error(`unsupported case guard ${guard}`);
      const list = this.grammar[guard.slice(1)];
      if (!Array.isArray(list)) throw new Error(`case guard ${guard} names no word list`);
      if ((list as string[]).includes(text)) return token;
    }
    const def = cases["@default"];
    if (def === undefined) throw new Error(`no @default case for ${JSON.stringify(text)}`);
    return def;
  }

  private postfix(token: string): string {
    return token === "" || token === "white" ? token : token + this.grammar.tokenPostfix;
  }
}

const byToken: Array<[string, TokenClass]> = (Object.entries(TOKEN_CLASSES) as Array<[TokenClass, { monarch: string }]>)
  .map(([cls, v]) => [v.monarch, cls] as [string, TokenClass])
  .sort((a, b) => b[0].length - a[0].length);

/** The class whose Monarch token the type names (longest match; `delimiter.curly`
 * is shared by both braces, so a brace resolves by its text). */
export function classOfMonarchType(type: string, text: string): TokenClass | null {
  if (type === "white" || type === "") return null;
  const bare = type.replace(/\.oqx$/, "");
  if (bare === "delimiter.curly") return text === "{" ? "braceOpen" : "braceClose";
  if (bare === "delimiter.parenthesis") return text === "(" ? "parenOpen" : "parenClose";
  if (bare === "delimiter.square") return text === "[" ? "bracketOpen" : "bracketClose";
  for (const [token, cls] of byToken) if (bare === token) return cls;
  throw new Error(`Monarch type ${type} names no token class`);
}

export function tokenizeMonarch(grammar: MonarchGrammar, source: string): ClassToken[] {
  const tk = new MonarchTokenizer(grammar);
  return normalize(tk.tokenize(source).map((t) => ({ text: t.text, cls: classOfMonarchType(t.type, t.text) })));
}
