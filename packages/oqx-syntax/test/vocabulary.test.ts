// Pin the vocabulary to the specification text and to the reference implementation,
// so a language change that adds a word shows up here before it ships unhighlighted.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LANGUAGE_VERSION as REFERENCE_LANGUAGE_VERSION } from "@omgbase/oqx";
import {
  BUILTIN_FUNCTIONS,
  BUILTIN_METHODS,
  CONSUMERS,
  CONTEXTUAL_WORDS,
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

  it("intrinsics are every $name SEMANTICS.md defines", () => {
    const names = read("SEMANTICS.md").match(/\$[a-z_]+/g) ?? [];
    expect(sorted(names)).toEqual(sorted(INTRINSICS));
  });

  it("the omgbase host vocabulary matches spec/surface §1.2–1.3", () => {
    const surface = readFileSync(join(SPEC_DIR, "..", "surface", "README.md"), "utf8");
    const s13 = surface.slice(surface.indexOf("### 1.3"), surface.indexOf("### 1.4"));
    const rowFns = s13.match(/Row\s+functions \(([^)]+)\)/)?.[1] ?? "";
    expect(sorted(rowFns.match(/`(\w+)`/g)!.map((m) => m.slice(1, -1)))).toEqual(sorted(OMGBASE.rowFunctions));
    const s1 = surface.slice(surface.indexOf("## 1."), surface.indexOf("### 1.4"));
    for (const list of Object.values(OMGBASE.intrinsics)) for (const name of list) expect(s1, name).toContain(`\`${name}\``);
    for (const rel of OMGBASE.relations) expect(s1, rel).toContain(`\`${rel}\``);
    for (const root of OMGBASE.roots) expect(s1, root).toContain(`\`${root}\``);
  });

  it("token classes have distinct TextMate scopes ending in .oqx", () => {
    const scopes = Object.values(TOKEN_CLASSES).map((c) => c.textmate);
    expect(new Set(scopes).size).toBe(scopes.length);
    for (const s of scopes) expect(s).toMatch(/\.oqx$/);
  });
});
