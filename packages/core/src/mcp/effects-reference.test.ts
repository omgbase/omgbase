// The write chapter of `query_syntax` (`section: "effects"`, spec/surface §4,
// 6.8) is KEPT IN SYNC with spec/mutate by this file — three links, each
// mechanical, so a key added to the vocabulary cannot reach one of them
// without the others:
//
//   spec/mutate/README.md §11.1 (the `Effect { … }` block)
//        ══ EFFECT_KEYS, the table the shape check reads its keys from and
//           reports as `valid_keys`                                  (link 1)
//        ══ the chapter's `Effect` lines, quoted verbatim              (link 2)
//   the chapter's examples ══ `spec/surface/cases/examples.json`'s second
//        case, run as `plan` over the alchemy corpus by both engines   (link 3,
//        `examples.test.ts`; here: one example per op, and the queries run)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "@omgbase/oqx";
import { EFFECT_KEYS, EFFECT_OPS, TARGET_KEYS, validateEffect, type EffectForm } from "../mutate/effects.js";
import { QUERY_SYNTAX_CARD, QUERY_SYNTAX_SECTIONS, querySyntaxSection } from "./reference.js";
import { extractLadder } from "./examples.test.js";
import { readCorpusFromDisk, runReadsCase } from "../../corpus/surface/fixture.js";

const MUTATE_SPEC = readFileSync(fileURLToPath(new URL("../../../../spec/mutate/README.md", import.meta.url)), "utf8");
const chapter = querySyntaxSection("effects")!;

/** The fenced block under `### 11.1 Vocabulary`, line by line. */
function vocabularyBlock(): string[] {
  const from = MUTATE_SPEC.indexOf("### 11.1 Vocabulary");
  const open = MUTATE_SPEC.indexOf("```text\n", from);
  const close = MUTATE_SPEC.indexOf("\n```", open + 8);
  return MUTATE_SPEC.slice(open + 8, close).split("\n");
}

/** The `Effect` lines of the block: the one led by `Effect  ` and its continuation lines. */
function effectLines(): string[] {
  const lines = vocabularyBlock();
  const start = lines.findIndex((l) => l.startsWith("Effect  "));
  return lines.slice(start).filter((l) => l.trim() !== "");
}

/** `{ op: "insert",   into: Target(…), at? = "end", markdown, expect? }` → `["op", "into", "at?", "markdown", "expect?"]`. */
function keysOfLine(line: string): string[] {
  const body = line.slice(line.indexOf("{") + 1, line.lastIndexOf("}"));
  const keys: string[] = [];
  let depth = 0;
  let member = "";
  for (const c of body + ",") {
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      const name = /^\s*([a-z_]+\??)/.exec(member);
      if (name) keys.push(name[1]!);
      member = "";
    } else member += c;
  }
  return keys;
}

/** The form a vocabulary line names: its op, and for `move`/`remove` whether it carries `targets`. */
function formOfLine(line: string): EffectForm {
  const op = /op: "([a-z]+)"/.exec(line)![1]!;
  if (op !== "move" && op !== "remove") return op as EffectForm;
  return `${op}:${/\btargets:/.test(line) ? "blocks" : "document"}` as EffectForm;
}

describe("query_syntax { section: \"effects\" } is in sync with spec/mutate §11.1", () => {
  it("link 1 — EFFECT_KEYS is the spec's vocabulary block, form by form, key by key, in order", () => {
    const lines = effectLines();
    expect(lines.length).toBe(Object.keys(EFFECT_KEYS).length);
    const fromSpec = Object.fromEntries(lines.map((l) => [formOfLine(l), keysOfLine(l)]));
    expect(fromSpec).toEqual(EFFECT_KEYS);
    // every op of the nine has a form, and no form names another op
    expect([...new Set(Object.keys(EFFECT_KEYS).map((f) => f.split(":")[0]))]).toEqual([...EFFECT_OPS]);
  });

  it("link 2 — the chapter quotes the spec's Effect lines verbatim, in order", () => {
    const lines = effectLines().map((l) => l.replace(/^Effect {2}/, "").trim());
    const quoted = chapter.split("\n").map((l) => l.replace(/^ *Effect {2}/, "").trim()).filter((l) => l.startsWith("{ op: "));
    expect(quoted).toEqual(lines);
  });

  it("the chapter names every target kind, every at form, every field handle and the three verbs", () => {
    for (const kind of Object.keys(TARGET_KEYS)) expect(chapter, `target kind ${kind}`).toContain(`kind: "${kind}"`);
    for (const at of ['"end"', '"start"', "{ before:", "{ after:"]) expect(chapter, `at ${at}`).toContain(at);
    for (const f of ["_frontmatter.<key>", "content", "markdown", "_attrs.checked"]) expect(chapter, `field ${f}`).toContain(f);
    for (const word of ["apply {", "plan {", "execute {", "$new.0", "valid_keys", "data.fix", "expect: { max }", "reason?"]) expect(chapter).toContain(word);
  });

  it("link 3 — one working example per op: every rung passes the shape check and every form is exercised", () => {
    const { rungs } = extractLadder(chapter);
    expect(rungs.length).toBeGreaterThanOrEqual(Object.keys(EFFECT_KEYS).length);
    const forms = new Set<string>();
    for (const r of rungs) {
      const effects = r.args.effects as Record<string, unknown>[];
      const templated = r.args.select !== undefined;
      effects.forEach((e, i) => {
        // a selector template may leave its target to the hit; give the shape check one to look at
        const probe = templated && e.target === undefined && e.into === undefined ? { ...e, [e.op === "insert" ? "into" : "target"]: "b_0" } : e;
        const stripped = Object.fromEntries(Object.entries(probe).map(([k, v]) => [k, typeof v === "string" && v.startsWith("-> ") ? (k === "markdown" ? "x" : "b_0") : v]));
        const checked = validateEffect(stripped, i);
        forms.add(checked.op === "move" || checked.op === "remove" ? `${checked.op}:${"targets" in checked ? "blocks" : "document"}` : checked.op);
      });
    }
    expect([...forms].sort()).toEqual(Object.keys(EFFECT_KEYS).sort());
  });

  it("the chapter's id-finding queries parse and return what the examples then use", async () => {
    const queries = chapter.split("\n").filter((l) => /^ {2}(blocks|nodes) \{/.test(l)).map((l) => l.trim());
    expect(queries.length).toBe(2);
    for (const q of queries) parse(q);
    const { expect: generated } = await runReadsCase(
      { name: "chapter-queries", workspace: true, steps: queries.map((query) => ({ read: { tool: "query", args: { query } } })) },
      readCorpusFromDisk(),
    );
    const [blocks, section] = (generated as unknown as { steps: { hits: Record<string, unknown>[] }[] }).steps;
    expect(blocks!.hits.some((h) => h._id === "b_156" && h._type === "task")).toBe(true);
    // the heading by its text: `_block_id` is the examples' heading_id, and its section holds the list they extend
    expect(section!.hits).toHaveLength(1);
    expect(section!.hits[0]!._block_id).toBe("b_153");
    expect(section!.hits[0]!.blocks).toContainEqual({ _id: "b_154", _type: "list", _depth: 0 });
  });

  it("the card points at the chapter, and the chapter is a section like any other", () => {
    expect(QUERY_SYNTAX_SECTIONS.at(-1)!.slug).toBe("effects");
    expect(QUERY_SYNTAX_CARD).toContain('WRITES (apply, plan)');
    expect(QUERY_SYNTAX_CARD).toContain('query_syntax { section: "effects" }');
    expect(chapter.startsWith("## Effects — writes (apply, plan, execute)\n")).toBe(true);
  });
});
