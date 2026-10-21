// Every OQX example the `query_syntax` text shows must parse. The text states
// in capitals that the clause order is fixed and that only `select` may lead;
// through 3.0 six of its own examples were pre-0.11 `from … select …` relics
// that no sweep had ever run through the parser. The examples are extracted
// MECHANICALLY (the rule below, mirrored by the Rust twin's test in
// crates/omgbase-surface/src/reference.rs) so that an example added or edited
// later is checked the same way.
//
// Extraction rule:
//  1. Only indented lines (two or more leading spaces) are candidates. Prose is
//     never one, so an error example quoted in prose with backticks —
//     `era > 1600 from docs` (the clause-order error), `from docs count`,
//     `$path` — is excluded by POSITION: an error example belongs in prose, a
//     code line is a valid query. That is the convention this test enforces.
//  2. Inside `## Examples` every indented line is a whole query.
//  3. Elsewhere the query is the text before the first run of three or more
//     spaces (the commentary column), trimmed. A candidate holding a grammar
//     placeholder (`<seed>`, `<pred>`) or an ellipsis (`…`) is a schema line,
//     not a query; one carrying sentence punctuation (`. `, `; `, a trailing
//     `.` `:` `;`) is commentary wrapped under the column. Both are skipped.
//  4. A candidate is a query when it begins `select `, `from `, or a root
//     target (`docs` `blocks` `nodes` `links` `revisions`) followed by a
//     consumer directive or `{`. A `^`-led line is an expression fragment (a lift or an outer
//     reference is only meaningful inside a block), never a query.
//  5. A `select`-led candidate with no ` from ` at brace depth 0 is a FRAGMENT
//     (a projection shown on its own: `select fm: entries(data) collect { … }`)
//     and is skipped — which is what makes a select-last relic unskippable: it
//     carries its `from`, so it is a query and must parse.
import { describe, it, expect } from "vitest";
import { parse } from "@omgbase/oqx";
import { QUERY_SYNTAX, QUERY_SYNTAX_CARD, QUERY_SYNTAX_SECTIONS, QUERY_SYNTAX_SECTION_NAMES, querySyntaxSection } from "./reference.js";

const PLACEHOLDER = /<[A-Za-z][A-Za-z_| …]*>/;
const ROOT_CONSUMER = /^(docs|blocks|nodes|links|revisions) (collect|exists|none|count|first|single|distinct|\{)/;
const PROSE = /\. |; |[.:;]$/;

/** `true` when `q` has a ` from ` at brace depth 0 (outside string literals). */
export function hasTopLevelFrom(q: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0 && q.startsWith(" from ", i)) return true;
  }
  return false;
}

export interface Extracted {
  /** Every query line the rule admits, with its section and line number. */
  queries: { line: number; section: string; query: string }[];
  /** `select`-led fragments the rule skipped (rule 5), for the record. */
  fragments: string[];
}

export function extractExamples(text: string): Extracted {
  const queries: Extracted["queries"] = [];
  const fragments: string[] = [];
  let section = "";
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (raw.startsWith("## ")) { section = raw.slice(3).trim(); return; }
    if (!/^ {2,}\S/.test(raw)) return;
    const trimmed = raw.trim();
    if (section === "Examples") { queries.push({ line, section, query: trimmed }); return; }
    const query = trimmed.split(/ {3,}/)[0]!.trim();
    if (PLACEHOLDER.test(query) || query.includes("…") || PROSE.test(query)) return;
    const leads = query.startsWith("select ") || query.startsWith("from ") || ROOT_CONSUMER.test(query);
    if (!leads) return;
    if (query.startsWith("select ") && !hasTopLevelFrom(query)) { fragments.push(query); return; }
    queries.push({ line, section, query });
  });
  return { queries, fragments };
}

describe("query_syntax (reference.ts)", () => {
  const { queries, fragments } = extractExamples(QUERY_SYNTAX);

  it("extracts a substantial example set (the rule did not silently match nothing)", () => {
    const inExamples = queries.filter((q) => q.section === "Examples");
    expect(inExamples.length).toBeGreaterThanOrEqual(20);
    expect(queries.length - inExamples.length, `${queries.length - inExamples.length} outside Examples`).toBeGreaterThanOrEqual(10);
    // Fragments are projections shown on their own; the rule names them so a
    // reviewer can see what was NOT checked.
    for (const f of fragments) expect(f, "a fragment must not carry a top-level from").not.toMatch(/ from (docs|blocks|nodes|links|revisions)\b/);
  });

  it("every extracted example parses", () => {
    const failures: string[] = [];
    for (const { line, section, query } of queries) {
      try {
        parse(query);
      } catch (e) {
        failures.push(`line ${line} (${section}): ${query}\n    ${(e as Error).message}`);
      }
    }
    expect(failures, `query_syntax examples that do not parse:\n${failures.join("\n")}`).toEqual([]);
  });

  it("the error examples live in prose, not in code lines (the convention the rule relies on)", () => {
    const all = queries.map((q) => q.query);
    for (const bad of ["era > 1600 from docs", "from docs count", "from docs where \"pricing\" in list(tags) select layer, tags"]) {
      expect(() => parse(bad)).toThrow();
      expect(all).not.toContain(bad);
    }
  });

  it("states the clause order exactly as the parser's own error does", () => {
    let message = "";
    try { parse("from docs where x select y"); } catch (e) { message = (e as Error).message; }
    const m = /OQX clause order is ([a-z, ]+?)(?: \(|$)/.exec(message);
    expect(m, message).not.toBeNull();
    expect(QUERY_SYNTAX).toContain(`CLAUSE ORDER IS FIXED: ${m![1]}`);
    expect(QUERY_SYNTAX_CARD).toContain(`CLAUSE ORDER IS FIXED: ${m![1]}`);
  });
});

// The card and the chapters (spec/surface §4 `query_syntax`, 5.1).
describe("query_syntax card and sections (reference.ts)", () => {
  it("the card is small, every one of its examples parses, and it names the chapters", () => {
    expect(QUERY_SYNTAX_CARD.length).toBeLessThan(4000);
    const { queries } = extractExamples(QUERY_SYNTAX_CARD);
    expect(queries.length).toBeGreaterThanOrEqual(10);
    const failures: string[] = [];
    for (const { line, query } of queries) {
      try {
        parse(query);
      } catch (e) {
        failures.push(`line ${line}: ${query}\n    ${(e as Error).message}`);
      }
    }
    expect(failures, `card examples that do not parse:\n${failures.join("\n")}`).toEqual([]);
    for (const s of QUERY_SYNTAX_SECTIONS) expect(QUERY_SYNTAX_CARD).toContain(s.slug);
    expect(QUERY_SYNTAX_CARD).toContain("data.fix");
  });

  it("the section table is exactly the manual's `##` headings, in order, each slug unique; `all` closes the names", () => {
    const headings = QUERY_SYNTAX.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
    expect(QUERY_SYNTAX_SECTIONS.map((s) => s.heading)).toEqual(headings);
    const slugs = QUERY_SYNTAX_SECTIONS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z]+$/);
    expect(QUERY_SYNTAX_SECTION_NAMES).toEqual([...slugs, "all"]);
  });

  it("a section is its heading through the line before the next heading, trailing blanks dropped; the sections concatenate back to the manual's body", () => {
    for (const { slug, heading } of QUERY_SYNTAX_SECTIONS) {
      const text = querySyntaxSection(slug)!;
      expect(text.startsWith(`## ${heading}\n`)).toBe(true);
      expect(text.endsWith("\n")).toBe(true);
      expect(text.endsWith("\n\n")).toBe(false);
      expect(text.indexOf("\n## "), `${slug} holds a second heading`).toBe(-1);
    }
    expect(querySyntaxSection("all")).toBe(QUERY_SYNTAX);
    expect(querySyntaxSection("nope")).toBeNull();
    // Every line of the manual after the intro belongs to exactly one section.
    const body = QUERY_SYNTAX.slice(QUERY_SYNTAX.indexOf("\n## ") + 1);
    const joined = QUERY_SYNTAX_SECTIONS.map((s) => querySyntaxSection(s.slug)!).join("\n");
    expect(joined.replace(/\n+/g, "\n")).toBe(body.replace(/\n+/g, "\n"));
  });
});
