// CodeMirror adapter: the rule table as a CodeMirror 6 `StreamParser` (the
// line-oriented tokenizer behind `StreamLanguage`), plus the same tokenizer in
// CodeMirror 5's mode shape for hosts that still take one (Obsidian's editor
// registers code-block languages that way). No CodeMirror import: the parser is
// a plain object, and the highlight tags are resolved from the `tags` export of
// `@lezer/highlight` that the caller passes in.
//
//   import { StreamLanguage } from "@codemirror/language";
//   import { tags } from "@lezer/highlight";
//   import { oqxStreamParser } from "@omgbase/oqx-syntax/codemirror";
//   const oqx = StreamLanguage.define(oqxStreamParser(tags));
//
// Execution model (identical to Monarch's, and to what the parity tests hold the
// TextMate grammar to): at each position the rules are tried in order against
// the rest of the line, the first match wins, a multi-group match is emitted as
// consecutive tokens, and a string carries its state across lines.

import { RULES, STRINGS, STRING_ESCAPE, WHITESPACE, withIdent, type GroupAction, type Rule } from "./rules.js";
import { LANGUAGE, TOKEN_CLASSES, type TokenClass } from "./vocabulary.js";

/** The part of a CodeMirror `StringStream` (5 or 6) the tokenizer touches. */
export interface StreamLike {
  string: string;
  pos: number;
}

export interface OqxStreamState {
  /** The quote of the string being lexed, or null. */
  quote: string | null;
  /** Remaining tokens of a multi-group match on this line: `[length, class]`. */
  pending: Array<[number, TokenClass | null]>;
}

interface CompiledRule {
  regex: RegExp;
  groups: readonly GroupAction[];
}

const compiled: CompiledRule[] = RULES.map((r: Rule) => ({ regex: new RegExp(`^(?:${withIdent(r.regex)})`), groups: r.groups }));
const whitespace = new RegExp(`^${WHITESPACE}`);
const escape = new RegExp(`^${STRING_ESCAPE}`);
const stringBodies = new Map<string, RegExp>(STRINGS.map((s) => [s.quote, new RegExp(`^${s.body}`)]));

function resolve(g: GroupAction, text: string): TokenClass | null {
  if (g === "whitespace") return null;
  if (typeof g === "string") return g;
  for (const c of g.cases) if (c.words.includes(text)) return c.token;
  return g.default;
}

/** Tokenize one step; returns the token class (or null for whitespace) and
 * advances `stream.pos`. This is the engine both adapters wrap. */
export function nextToken(stream: StreamLike, state: OqxStreamState): TokenClass | null {
  const pending = state.pending.shift();
  if (pending) {
    stream.pos += pending[0];
    return pending[1];
  }
  const rest = stream.string.slice(stream.pos);
  if (state.quote !== null) {
    let m = stringBodies.get(state.quote)!.exec(rest);
    if (m) {
      stream.pos += m[0].length;
      return "string";
    }
    m = escape.exec(rest);
    if (m) {
      stream.pos += m[0].length;
      return "stringEscape";
    }
    if (rest.startsWith(state.quote)) {
      stream.pos += 1;
      state.quote = null;
      return "string";
    }
    stream.pos += 1; // unreachable in practice: every character is a body, an escape or the quote
    return "string";
  }
  let m = whitespace.exec(rest);
  if (m) {
    stream.pos += m[0].length;
    return null;
  }
  for (const s of STRINGS) {
    if (rest.startsWith(s.quote)) {
      stream.pos += 1;
      state.quote = s.quote;
      return "string";
    }
  }
  for (const rule of compiled) {
    m = rule.regex.exec(rest);
    if (!m) continue;
    if (rule.groups.length === 1) {
      stream.pos += m[0].length;
      return resolve(rule.groups[0]!, m[0]);
    }
    const parts = m.slice(1).map((text, i) => [text.length, resolve(rule.groups[i]!, text)] as [number, TokenClass | null]);
    const first = parts.shift()!;
    state.pending = parts.filter((p) => p[0] > 0);
    stream.pos += first[0];
    return first[1];
  }
  stream.pos += 1; // unreachable: the last rule matches any non-whitespace character
  return "illegal";
}

export function startState(): OqxStreamState {
  return { quote: null, pending: [] };
}

export function copyState(state: OqxStreamState): OqxStreamState {
  return { quote: state.quote, pending: [...state.pending] };
}

/** The shape of `@lezer/highlight`'s `tags` export this adapter relies on:
 * base tags by name, and the modifier functions. */
export interface HighlightTagsLike<Tag = unknown> {
  [name: string]: Tag | ((tag: Tag) => Tag) | undefined;
}

/** Resolve a tag expression such as `special(variableName)` against `tags`. */
export function resolveTag<Tag>(tags: HighlightTagsLike<Tag>, expression: string): Tag {
  const m = /^(\w+)\((.+)\)$/.exec(expression);
  if (m) {
    const modifier = tags[m[1]!];
    if (typeof modifier !== "function") throw new Error(`unknown tag modifier ${m[1]}`);
    return (modifier as (t: Tag) => Tag)(resolveTag(tags, m[2]!));
  }
  const tag = tags[expression];
  if (tag === undefined || typeof tag === "function") throw new Error(`unknown highlight tag ${expression}`);
  return tag as Tag;
}

/** `tokenTable` for `StreamLanguage`: token class → highlight tag. */
export function oqxTokenTable<Tag>(tags: HighlightTagsLike<Tag>): Record<TokenClass, Tag> {
  const table = {} as Record<TokenClass, Tag>;
  for (const [cls, v] of Object.entries(TOKEN_CLASSES) as Array<[TokenClass, { codemirror: string }]>) {
    table[cls] = resolveTag(tags, v.codemirror);
  }
  return table;
}

/** A CodeMirror 6 `StreamParser<OqxStreamState>`; pass `tags` from `@lezer/highlight`. */
export function oqxStreamParser<Tag>(tags: HighlightTagsLike<Tag>): {
  name: string;
  startState: () => OqxStreamState;
  copyState: (state: OqxStreamState) => OqxStreamState;
  token: (stream: StreamLike, state: OqxStreamState) => string | null;
  tokenTable: Record<TokenClass, Tag>;
  languageData: Record<string, unknown>;
} {
  return {
    name: LANGUAGE.id,
    startState,
    copyState,
    token: nextToken,
    tokenTable: oqxTokenTable(tags),
    languageData: {
      closeBrackets: { brackets: ["(", "{", '"', "'"] },
      wordChars: "$",
    },
  };
}

/** The same tokenizer as a CodeMirror 5 mode: `token` returns CodeMirror 5 style
 * classes (`keyword`, `string`, `variable-2`, `builtin`, `error`, …). */
export function oqxLegacyMode(): {
  name: string;
  startState: () => OqxStreamState;
  copyState: (state: OqxStreamState) => OqxStreamState;
  token: (stream: StreamLike, state: OqxStreamState) => string | null;
} {
  return {
    name: LANGUAGE.id,
    startState,
    copyState,
    token: (stream, state) => {
      const cls = nextToken(stream, state);
      return cls === null ? null : TOKEN_CLASSES[cls].legacy;
    },
  };
}
