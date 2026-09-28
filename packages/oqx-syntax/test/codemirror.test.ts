// CodeMirror: class-level parity with the TextMate grammar over the corpus and
// every spec fixture (driving the tokenizer line by line exactly as a
// StreamLanguage does), and the real @codemirror/language + @lezer/highlight
// wiring: StreamLanguage.define, tokenTable → tags, highlightTree.

import { describe, expect, it } from "vitest";
import { StreamLanguage, StringStream } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { copyState, nextToken, oqxLegacyMode, oqxStreamParser, resolveTag, startState } from "../src/codemirror.js";
import { TOKEN_CLASSES, type TokenClass } from "../src/vocabulary.js";
import { CORPUS } from "./corpus.js";
import { specQueries } from "./spec-fixtures.js";
import { tokenizeTextMate } from "./textmate-runtime.js";
import { normalize, render, type ClassToken } from "./tokens.js";

/** Drive the tokenizer the way StreamLanguage does: per line, state carried. */
function tokenizeStream(source: string): ClassToken[] {
  const out: Array<{ text: string; cls: TokenClass | null }> = [];
  let state = startState();
  source.split("\n").forEach((line, i) => {
    if (i > 0) out.push({ text: "\n", cls: null });
    const stream = { string: line, pos: 0 };
    while (stream.pos < line.length) {
      const start = stream.pos;
      const cls = nextToken(stream, state);
      if (stream.pos === start) throw new Error(`no progress at ${line.slice(start)}`);
      out.push({ text: line.slice(start, stream.pos), cls });
    }
    state = copyState(state);
    state.pending = []; // a line never ends mid-match
  });
  return normalize(out);
}

describe("CodeMirror stream parser", () => {
  it("agrees with TextMate over the corpus", () => {
    for (const sample of CORPUS) expect(render(tokenizeStream(sample.source)), sample.name).toBe(sample.tokens);
  });

  it("agrees with TextMate over every spec/oqx fixture query", async () => {
    for (const q of specQueries()) {
      expect(render(tokenizeStream(q.source)), `${q.suite} / ${q.name}: ${q.source}`).toBe(render(await tokenizeTextMate(q.source)));
    }
  });

  it("every token class resolves to a @lezer/highlight tag", () => {
    for (const v of Object.values(TOKEN_CLASSES)) expect(resolveTag(tags, v.codemirror)).toBeTruthy();
    expect(resolveTag(tags, "special(variableName)")).toBe(tags.special(tags.variableName));
  });

  it("StreamLanguage.define accepts the parser and highlights through the tag table", () => {
    const language = StreamLanguage.define(oqxStreamParser(tags));
    const source = 'name from people where $depth > 1 && text("x")';
    const tree = language.parser.parse(source);
    const highlighter = tagHighlighter([
      { tag: tags.keyword, class: "kw" },
      { tag: tags.special(tags.variableName), class: "intrinsic" },
      { tag: tags.standard(tags.function(tags.variableName)), class: "builtin" },
      { tag: tags.string, class: "str" },
    ]);
    const spans: Array<[string, string]> = [];
    highlightTree(tree, highlighter, (from, to, classes) => spans.push([source.slice(from, to), classes]));
    expect(spans).toContainEqual(["from", "kw"]);
    expect(spans).toContainEqual(["$depth", "intrinsic"]);
    expect(spans).toContainEqual(["text", "builtin"]);
    expect(spans.some(([t, c]) => t.includes('"x"') && c === "str")).toBe(true);
    expect(language.name).toBe("oqx");
  });

  it("works on a real StringStream and as a CodeMirror 5 mode", () => {
    const mode = oqxLegacyMode();
    const stream = new StringStream("from r where $x == 'a'", 4, 2);
    const state = mode.startState();
    const styles: Array<string | null> = [];
    while (stream.pos < stream.string.length) styles.push(mode.token(stream, state));
    expect(styles.filter((s) => s !== null)).toEqual(["keyword", "variable", "keyword", "variable-2", "operator", "string", "string", "string"]);
  });
});
