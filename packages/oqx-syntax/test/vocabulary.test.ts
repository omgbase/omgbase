// Pin the vocabulary to the specification text and to the reference implementation,
// so a language change that adds a word shows up here before it ships unhighlighted.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LANGUAGE_VERSION as REFERENCE_LANGUAGE_VERSION } from "@omgbase/oqx";
import {
  AGGREGATES,
  BUILTIN_FUNCTIONS,
  BUILTIN_METHODS,
  COMMENT,
  CONSUMERS,
  CONTEXTUAL_WORDS,
  GROUP_ROWS,
  IDENTIFIER,
  ILLEGAL_CHARACTERS,
  INTRINSICS,
  KEYWORDS,
  LANGUAGE_VERSION,
  LITERALS,
  OMGBASE,
  TOKEN_CLASSES,
} from "../src/vocabulary.js";
import { SPEC_DIR } from "./spec-fixtures.js";

const read = (rel: string): string => readFileSync(join(SPEC_DIR, rel), "utf8");
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

describe("vocabulary", () => {
  it("LANGUAGE_VERSION is spec/oqx/VERSION and the reference's", () => {
    expect(LANGUAGE_VERSION).toBe(read("VERSION").trim());
    expect(LANGUAGE_VERSION).toBe(REFERENCE_LANGUAGE_VERSION);
  });

  it("keywords are GRAMMAR §1's reserved words", () => {
    const row = read("GRAMMAR.md").match(/^\| keyword \| ([^—]+) —/m)?.[1] ?? "";
    expect(sorted(row.match(/`(\w+)`/g)!.map((m) => m.slice(1, -1)))).toEqual(sorted(KEYWORDS));
  });

  it("contextual words are GRAMMAR §1's list", () => {
    const grammar = read("GRAMMAR.md");
    const para = grammar.slice(grammar.indexOf("**Contextual words**"));
    const list = para.match(/`([^`]+)`/)?.[1] ?? "";
    expect(sorted(list.split(/\s+/))).toEqual(sorted(CONTEXTUAL_WORDS));
    for (const c of CONSUMERS) expect(CONTEXTUAL_WORDS).toContain(c);
  });

  it("comments are GRAMMAR §1's `//` and `/* … */` (0.28); `#` stays a lex error", () => {
    const grammar = read("GRAMMAR.md");
    const para = grammar.slice(grammar.indexOf("**Comments**"), grammar.indexOf("Tokens:"));
    expect(para).toContain("since 0.28");
    expect(para).toContain(`\`${COMMENT.line}\` runs to the end of the line`);
    expect(para).toContain(`\`${COMMENT.blockOpen} … ${COMMENT.blockClose}\``);
    expect(para).toContain("does not nest");
    expect(para).toContain("neither is recognised inside a string literal or a\ntemplate's text");
    expect(para).toContain("`#` is not a comment: it is a\nlex error");
    expect(ILLEGAL_CHARACTERS).toContain("#");
    // The lex-error list after "as are": every character in it is one of ours.
    const listed = para.slice(para.indexOf("as are")).match(/`(.)`/g)!.map((m) => m.slice(1, -1));
    for (const c of listed) expect(ILLEGAL_CHARACTERS).toContain(c);
    expect(sorted(ILLEGAL_CHARACTERS)).toEqual(sorted(["#", ...listed]));
  });

  it("literals are GRAMMAR §1's literal words", () => {
    expect(read("GRAMMAR.md")).toMatch(/`true`, `false`, and `null` are \*\*literals in every position\*\*/);
    expect(sorted(LITERALS)).toEqual(["false", "null", "true"]);
  });

  it("builtin functions and methods are SEMANTICS §11's tables", () => {
    const sem = read("SEMANTICS.md");
    const s11 = sem.slice(sem.indexOf("## 11."), sem.indexOf("## 12."));
    const functions = [...s11.matchAll(/^\| `([a-z]+)\(/gm)].map((m) => m[1]!);
    expect(sorted(functions)).toEqual(sorted(BUILTIN_FUNCTIONS));
    const methods = [...s11.matchAll(/`[sx]\.([A-Za-z]+)\(/g)].map((m) => m[1]!);
    expect(sorted(methods)).toEqual(sorted(BUILTIN_METHODS));
  });

  it("aggregates are SEMANTICS §24's table and GRAMMAR §1's reserved function names; rows is §2's group value", () => {
    const sem = read("SEMANTICS.md");
    const s24 = sem.slice(sem.indexOf("## 24."));
    // The first cell of each table row names one or two aggregates (`min(e)` / `max(e)`).
    const cells = [...s24.matchAll(/^\| ([^|]+) \|/gm)].map((m) => m[1]!);
    const table = cells.flatMap((c) => [...c.matchAll(/`([a-z]+)\(/g)].map((m) => m[1]!));
    expect(sorted(table)).toEqual(sorted(AGGREGATES));
    const grammar = read("GRAMMAR.md");
    const para = grammar.slice(grammar.indexOf("**Reserved function names**"));
    const list = para.match(/`([^`]+)`/)?.[1] ?? "";
    expect(sorted(list.split(/\s+/))).toEqual(sorted(AGGREGATES));
    const s2 = sem.slice(sem.indexOf("## 2."), sem.indexOf("## 3."));
    expect(s2).toMatch(new RegExp(`\`${GROUP_ROWS}\` — the group's rows`));
  });

  it("intrinsics are the $names SEMANTICS §2 resolves before the row (steps 1-3)", () => {
    // §2's resolution list: steps 1-3 are the language's intrinsics; step 4 is
    // lifts, step 5 the row. Names mentioned elsewhere in the prose are not
    // intrinsics by virtue of being mentioned (`$value` is named there as an
    // ordinary property since 0.15).
    const sem = read("SEMANTICS.md");
    const s2 = sem.slice(sem.indexOf("## 2."), sem.indexOf("## 3."));
    const steps = s2.slice(s2.search(/^1\. /m), s2.search(/^4\. /m));
    const names = steps.match(/\$[a-z_]+/g) ?? [];
    expect(sorted(names)).toEqual(sorted(INTRINSICS));
    expect(INTRINSICS).not.toContain("$value");
  });

  it("the omgbase host vocabulary matches spec/surface §1.2–1.3", () => {
    const surface = readFileSync(join(SPEC_DIR, "..", "surface", "README.md"), "utf8");
    const s13 = surface.slice(surface.indexOf("### 1.3"), surface.indexOf("### 1.4"));
    const rowFns = s13.match(/Row\s+functions \(([^)]+)\)/)?.[1] ?? "";
    expect(sorted(rowFns.match(/`(\w+)`/g)!.map((m) => m.slice(1, -1)))).toEqual(sorted(OMGBASE.rowFunctions));
    const s1 = surface.slice(surface.indexOf("## 1."), surface.indexOf("### 1.4"));
    for (const list of Object.values(OMGBASE.attributes)) for (const name of list) expect(s1, name).toContain(`\`${name}\``);
    for (const h of OMGBASE.handles) expect(s1, h).toContain(`\`${h}\``);
    for (const rel of OMGBASE.relations) expect(s1, rel).toContain(`\`${rel}\``);
    for (const root of OMGBASE.roots) expect(s1, root).toContain(`\`${root}\``);
  });

  it("the omgbase host vocabulary follows surface 5.0's rule: engine names are `_`-prefixed, collections and row functions bare, no `$` names", () => {
    // "underscore = engine" (spec/surface §1.2, 5.0): every attribute, handle,
    // reach-through and relation starts with `_`; a collection (`from docs`)
    // and a row function (`text("x")`) never do; omgbase adds no `$` names.
    const engine = [...Object.values(OMGBASE.attributes).flat(), ...OMGBASE.handles, ...OMGBASE.reachThroughs, ...OMGBASE.relations];
    for (const name of engine) expect(name).toMatch(/^_[a-z][a-z_]*$/);
    for (const name of [...OMGBASE.roots, ...OMGBASE.rowFunctions]) expect(name).toMatch(/^[a-z][a-z_]*$/);
    for (const r of OMGBASE.reachThroughs) expect(OMGBASE.relations).toContain(r);
    // The self aliases of 4.x are gone: `$it` is the self (an OQX intrinsic).
    for (const gone of ["doc", "block", "section", "dst"]) expect(engine).not.toContain(gone);
    expect(INTRINSICS).toContain("$it");
    // Every engine name is an identifier to the lexer (a leading `_` is in the shape).
    const ident = new RegExp(`^(?:${IDENTIFIER})$`);
    for (const name of engine) expect(name).toMatch(ident);
  });

  it("token classes have distinct TextMate scopes ending in .oqx", () => {
    const scopes = Object.values(TOKEN_CLASSES).map((c) => c.textmate);
    expect(new Set(scopes).size).toBe(scopes.length);
    for (const s of scopes) expect(s).toMatch(/\.oqx$/);
  });
});
