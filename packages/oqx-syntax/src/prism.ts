// Prism adapter: the rule table as a Prism grammar. Prism does not scan left to
// right; it applies each token's regex over the text in definition order. Every
// token here is `greedy`, which makes Prism run its regex over the *whole* text
// (a match may only start in text no earlier token claimed), so lookahead and
// lookbehind see the neighbours the sequential scanners see — a non-greedy
// token would only see the not-yet-tokenized chunk it sits in. The sequential
// rules are then rewritten so that a match can only start where the sequential
// scanner could have started a token:
//
// - a word, identifier, intrinsic or binding may not be preceded by an identifier
//   run (`(?<![A-Za-z_$][A-Za-z0-9_$]*)`), and a number may not be preceded by an
//   identifier character or by a lone `.` (so `1.5` is one number and `xs.0` is
//   the malformed `.0`, while `1..5` still yields two numbers);
// - a multi-group rule becomes one pattern per group, with the neighbouring
//   groups turned into lookbehind and lookahead;
// - the range operator is ordered before the numbers, so `1..5` is `1`, `..`,
//   `5` here as in the scanners, which reach the range before a leading `.`.
//
// Every token key is the rule name; its aliases are the token class and Prism's
// standard class for it, so stock Prism themes color the result and the parity
// test can read the class back. A multi-group rule is a container token (alias
// `group`) whose `inside` grammar carries the per-group tokens. Lookbehind needs a modern JavaScript
// engine (every current browser; Safari since 16.4).

import { RULES, STRINGS, STRING_ESCAPE, expandCases, splitGroups, withIdent, type GroupAction, type Rule } from "./rules.js";
import { LANGUAGE, TOKEN_CLASSES, type TokenClass } from "./vocabulary.js";

export interface PrismToken {
  pattern: RegExp;
  alias: string[];
  /** Prism's own lookbehind: the first capture group is matched but not tokenized. */
  lookbehind?: boolean;
  /** Match against the whole text rather than one chunk (see the header comment). */
  greedy?: boolean;
  inside?: PrismGrammar;
}
export type PrismGrammar = Record<string, PrismToken>;

/** The alias marking a container token (a multi-group match split by `inside`). */
export const CONTAINER = "group";

const WORD_GUARD = "(?<![A-Za-z_$][A-Za-z0-9_$]*)";
const NUMBER_GUARD = "(?<![A-Za-z0-9_$])(?<!(?<!\\.)\\.)";
const LEADING_DOT_GUARD = "(?<![0-9])";

/** Aliases for a token: its class and Prism's standard class, minus the token's own key. */
function aliases(cls: TokenClass, key: string): string[] {
  const std = TOKEN_CLASSES[cls].prism;
  return [...new Set([cls, ...(std ? [std] : [])])].filter((a) => a !== key);
}

function guardFor(name: string, source: string): string {
  if (name === "number-leading-dot") return LEADING_DOT_GUARD;
  if (/^\[0-9\]/.test(source)) return NUMBER_GUARD;
  if (/^(?:[A-Za-z]|\(\?:[a-z]|\[A-Za-z_\$\]|\\\$)/.test(source)) return WORD_GUARD;
  return "";
}

/** One expanded rule → its Prism token. A multi-group rule becomes a container
 * token over the whole match whose `inside` grammar splits it into the groups.
 * Prism matches each token against one already-cut chunk of text, so a regex
 * lookbehind can only see text inside the same chunk; the inside grammar
 * therefore cuts the groups from the last to the first, each consuming the
 * groups before it through Prism's own `lookbehind` (the first capture group is
 * matched but left untokenized for the next pattern). */
function tokenOf(rule: Rule): [string, PrismToken] {
  const { groups, tail } = splitGroups(withIdent(rule.regex));
  if (groups.length !== rule.groups.length) throw new Error(`rule ${rule.name}: ${groups.length} regex groups for ${rule.groups.length} actions`);
  const guard = guardFor(rule.name, groups[0]!);
  const whole = new RegExp(`${guard}${groups.join("")}${tail}`, "m");
  if (groups.length === 1) return [rule.name, { pattern: whole, alias: aliases(rule.groups[0] as TokenClass, rule.name), greedy: true }];
  const inside: PrismGrammar = {};
  for (let i = groups.length - 1; i >= 0; i--) {
    const action = rule.groups[i] as GroupAction;
    if (action === "whitespace") continue;
    if (typeof action !== "string") throw new Error(`rule ${rule.name}: unexpanded cases`);
    const key = `${rule.name}-${i + 1}`;
    const before = groups.slice(0, i).join("");
    // Later non-whitespace groups are already cut out of the chunk; only the
    // whitespace groups directly after this one are still there to look at.
    let after = "";
    for (let j = i + 1; j < groups.length && rule.groups[j] === "whitespace"; j++) after += groups[j];
    inside[key] = { pattern: new RegExp(`(^${before})${groups[i]}(?=${after}$)`, "m"), lookbehind: true, alias: aliases(action, key) };
  }
  return [rule.name, { pattern: whole, alias: [CONTAINER], greedy: true, inside }];
}

/** Build the grammar. `inside` of a string holds its escapes. */
export function buildPrismGrammar(): PrismGrammar {
  const grammar: PrismGrammar = {};
  for (const s of STRINGS) {
    const q = s.quote;
    grammar[s.name] = {
      pattern: new RegExp(`${q}(?:\\\\(?:[\\s\\S]|$)|[^\\\\${q}])*${q}?`, "m"),
      alias: aliases("string", s.name),
      greedy: true,
      inside: { "string-escape": { pattern: new RegExp(STRING_ESCAPE, "m"), alias: aliases("stringEscape", "string-escape") } },
    };
  }
  const range = RULES.find((r) => r.name === "range")!;
  const ordered = [range, ...RULES.filter((r) => r !== range)];
  for (const rule of ordered) {
    for (const expanded of expandCases(rule)) {
      const [key, token] = tokenOf(expanded);
      if (grammar[key]) throw new Error(`duplicate Prism token ${key}`);
      grammar[key] = token;
    }
  }
  return grammar;
}

/** The OQX Prism grammar. */
export const oqxPrismGrammar: PrismGrammar = buildPrismGrammar();

/** Register with a Prism instance: `Prism.languages.oqx` (and the aliases). */
export function registerOqxPrism(prism: { languages: Record<string, unknown> }): string {
  for (const id of [LANGUAGE.id, ...LANGUAGE.aliases]) prism.languages[id] = oqxPrismGrammar;
  return LANGUAGE.id;
}
