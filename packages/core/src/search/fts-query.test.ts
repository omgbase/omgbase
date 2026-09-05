import { describe, it, expect } from "vitest";
import { sanitizeFtsQuery } from "./fts-query.js";

describe("sanitizeFtsQuery", () => {
  it("quotes a bareword", () => {
    expect(sanitizeFtsQuery("onboarding")).toBe('"onboarding"');
  });

  it("neutralizes a slash so FTS5 never sees it as syntax", () => {
    expect(sanitizeFtsQuery("guides/onboarding")).toBe('"guides/onboarding"');
  });

  it("keeps multiple terms space-separated (implicit AND)", () => {
    expect(sanitizeFtsQuery("stable block identity")).toBe('"stable" "block" "identity"');
  });

  it("preserves a user phrase in double quotes", () => {
    expect(sanitizeFtsQuery('"shingle indexes"')).toBe('"shingle indexes"');
  });

  it("preserves a trailing prefix star", () => {
    expect(sanitizeFtsQuery("recon*")).toBe('"recon"*');
  });

  it("escapes embedded double quotes", () => {
    expect(sanitizeFtsQuery('say "hi')).toBe('"say" "hi"');
  });

  it("neutralizes FTS5 operator barewords (no injection)", () => {
    // AND/OR/NOT and column filters become literal quoted tokens.
    expect(sanitizeFtsQuery("cats OR dogs")).toBe('"cats" "OR" "dogs"');
    expect(sanitizeFtsQuery("col:value")).toBe('"col:value"');
  });

  it("returns empty for punctuation-only / whitespace-only input", () => {
    expect(sanitizeFtsQuery("///")).toBe("");
    expect(sanitizeFtsQuery("   ")).toBe("");
    expect(sanitizeFtsQuery("")).toBe("");
  });
});
