// The write surface is discoverable from the tools alone (spec/surface 6.8,
// spec/mutate 4.5). An agent on the MINIMAL profile sees ten tool descriptions
// and `query_syntax`; in one recorded session that was not enough, and five
// routine writes failed in a row. Two halves here, both over a real MCP client:
//
//  1. THE ACCEPTANCE SCRIPT — the three routine writes, each written from
//     nothing but a shape the descriptions or the write chapter publish, each
//     right on the first call: a new Markdown document with frontmatter, a
//     bullet appended under a named heading, a bullet inserted after a specific
//     nested list item. The calls below are the published examples with only
//     their paths, ids and texts replaced — the test asserts that, shape by
//     shape, so the script cannot drift ahead of what an agent can read.
//  2. THE FIVE ERRORS OF THAT SESSION, replayed: each now either succeeds or
//     answers with the corrected call in `data.fix`, and that call succeeds.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { setIdMinter, sequentialMinter } from "../core/ids.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { buildServer, MINIMAL_TOOLS } from "./server.js";
import { extractLadder } from "./examples.test.js";

let dir: string;
let store: Store;
let client: Client;

type Res = { payload: Record<string, unknown>; isError: boolean };
async function call(name: string, args: Record<string, unknown>): Promise<Res> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { payload: JSON.parse(r.content[0]!.text), isError: r.isError ?? false };
}
/** A successful call's payload; a refusal fails the test with the whole error. */
async function ok(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { payload, isError } = await call(name, args);
  expect(isError, `${name} ${JSON.stringify(args)} → ${JSON.stringify(payload)}`).toBe(false);
  return payload;
}
/** A refusal's `{ error, data }`. */
async function refused(name: string, args: Record<string, unknown>): Promise<{ error: string; message: string; data: Record<string, unknown> }> {
  const { payload, isError } = await call(name, args);
  expect(isError, `${name} ${JSON.stringify(args)} was expected to be refused`).toBe(true);
  return payload as { error: string; message: string; data: Record<string, unknown> };
}
const file = (p: string): string => readFileSync(join(dir, p), "utf8");

const JOURNAL = "---\ntype: journal\n---\n\n# Tuesday\n\n## Plan\n\n- write the spec\n  - fixtures first\n  - then the reference\n- ship it\n\n## Log\n\n- 09:00 started\n";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "omgbase-write-discoverability-"));
  store = new Store({ path: ":memory:" });
  setIdMinter(sequentialMinter());
  const repoId = ensureRepo(store, "t", dir);
  writeFileSync(join(dir, "journal.md"), JOURNAL);
  processCheckpoint(store, repoId, dir, [{ path: "journal.md" }]);
  const server = buildServer({ store, repoId, rootPath: dir, tools: "minimal" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "agent", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});
afterEach(() => {
  setIdMinter(null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** What an agent can read: the ten descriptions, the card, the write chapter. */
async function published(): Promise<{ descriptions: Record<string, string>; card: string; sections: string[]; chapter: string }> {
  const { tools } = await client.listTools();
  const descriptions = Object.fromEntries(tools.map((t) => [t.name, t.description ?? ""]));
  const card = await ok("query_syntax", {});
  const chapter = await ok("query_syntax", { section: "effects" });
  return { descriptions, card: card.syntax as string, sections: card.sections as string[], chapter: chapter.syntax as string };
}

/** The SHAPE of a value: its keys, recursively, with every string, number and boolean leaf erased — what a published example teaches independent of its paths, ids and texts. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, k === "op" || k === "kind" || k === "field" ? x : shape(x)]));
  return typeof v;
}
/** Every effect shape the text publishes as a rung. */
function publishedShapes(...texts: string[]): string[] {
  return texts.flatMap((t) => extractLadder(t).rungs).flatMap((r) => (r.args.effects as unknown[] | undefined) ?? []).map((e) => JSON.stringify(shape(e)));
}

describe("the write surface is discoverable from the tools alone", () => {
  it("the minimal profile lists the ten tools; the card says where write help lives; the chapter is one call away", async () => {
    const { descriptions, card, sections, chapter } = await published();
    expect(Object.keys(descriptions).sort()).toEqual([...MINIMAL_TOOLS].sort());
    expect(sections).toContain("effects");
    expect(card).toContain('query_syntax { section: "effects" }');
    for (const tool of ["apply", "plan"]) expect(descriptions[tool]).toContain('query_syntax { section: "effects" }');
    expect(descriptions.query_syntax).toContain('{"section":"effects"}');
    expect(chapter).toContain("One working example per op");
  });

  it("the acceptance script: create with frontmatter, append under a named heading, insert after a nested item — each from a published shape, each right the first time", async () => {
    const { descriptions, chapter } = await published();
    const shapes = new Set(publishedShapes(descriptions.apply!, descriptions.plan!, chapter));
    const fromPublished = (effect: unknown): void => expect(shapes.has(JSON.stringify(shape(effect))), `not a published shape: ${JSON.stringify(effect)}`).toBe(true);

    // 1. A new Markdown document with frontmatter (apply's first rung).
    const create = { op: "create", path: "/notes/retro.md", markdown: "---\ntype: retro\nstatus: open\n---\n\n# Retro\n\n## Went well\n" };
    fromPublished(create);
    const created = await ok("apply", { effects: [create], reason: "open the retro" });
    expect(created.committed).toBe(true);
    expect(file("notes/retro.md")).toBe(create.markdown);
    const read = await ok("docs_read", { _path: "/notes/retro.md" });
    expect((read.properties as { frontmatter: unknown }).frontmatter).toEqual({ type: "retro", status: "open" });

    // 2. A bullet under a named heading. The chapter's id query, with the name
    //    and path replaced, yields the heading's block id and the section's
    //    list; the list is what an item joins (the chapter's INTO paragraph).
    const idQuery = chapter.split("\n").find((l) => /^ {2}nodes \{/.test(l))!.trim();
    const found = await ok("query", { query: idQuery.replace('"Tasks"', '"Log"').replace('"/processes/calcination.md"', '"/journal.md"') });
    const hit = (found.hits as { _block_id: string; blocks: { _id: string; _type: string }[] }[])[0]!;
    const list = hit.blocks.find((b) => b._type === "list")!;
    const append = { op: "insert", into: list._id, markdown: "- 09:30 wrote the fixtures" };
    fromPublished(append);
    await ok("apply", { effects: [append] });
    expect(file("journal.md")).toContain("## Log\n\n- 09:00 started\n- 09:30 wrote the fixtures\n");
    // …and the section form (plan's rung) lands under the heading too, as its own block.
    const intoSection = { op: "insert", into: { kind: "section", heading_id: hit._block_id }, markdown: "Done for the day." };
    fromPublished(intoSection);
    await ok("apply", { effects: [intoSection] });
    expect(file("journal.md")).toContain("- 09:30 wrote the fixtures\n\nDone for the day.\n");

    // 3. A bullet after a specific NESTED list item: the document as `into`,
    //    the item as the anchor (apply's third rung) — no parent lookup.
    const blocks = await ok("query", { query: 'blocks { select _type, _depth, _text where _path == "/journal.md" }' });
    const nested = (blocks.hits as { _id: string; _text: string; _depth: number }[]).find((b) => b._text === "fixtures first")!;
    expect(nested._depth).toBeGreaterThan(1);
    const after = { op: "insert", into: "/journal.md", at: { after: nested._id }, markdown: "- with a sweep" };
    fromPublished(after);
    const receipt = await ok("apply", { effects: [after] });
    expect(receipt.summary).toEqual([`insert 1 block after list_item ${nested._id} in /journal.md`]);
    expect(file("journal.md")).toContain("- write the spec\n  - fixtures first\n  - with a sweep\n  - then the reference\n- ship it\n");
  });

  it("complaint 1 — set content on a new path: doc_missing, and data.fix is the create", async () => {
    const whole = "---\ntype: note\n---\n\n# New\n";
    const err = await refused("apply", { effects: [{ op: "set", target: "/notes/new.md", field: "content", value: whole }] });
    expect(err.error).toBe("doc_missing");
    expect(err.message).toContain("create { path, markdown }");
    await ok("apply", JSON.parse(err.data.fix as string) as Record<string, unknown>);
    expect(file("notes/new.md")).toBe(whole);
    // the published `set content` examples say the document must exist
    const { descriptions, chapter } = await published();
    expect(descriptions.apply).toMatch(/"field":"content".*EXISTING/);
    expect(chapter).toMatch(/"field":"content".*EXISTING/);
  });

  it("complaint 2 — create with `content`: the valid keys, and data.fix spells markdown", async () => {
    const err = await refused("apply", { effects: [{ op: "create", path: "/notes/x.md", content: "# X\n" }] });
    expect(err.error).toBe("filter_invalid");
    expect(err.data.valid_keys).toEqual(["op", "path", "markdown", "frontmatter?"]);
    expect(err.message).toContain("create takes op, path, markdown, frontmatter?");
    await ok("apply", JSON.parse(err.data.fix as string) as Record<string, unknown>);
    expect(file("notes/x.md")).toBe("# X\n");
  });

  it("complaint 3 — plan takes reason, and the commit carries it through execute { plan_id }", async () => {
    const plan = await ok("plan", { effects: [{ op: "set", target: "/journal.md", field: "_frontmatter.mood", value: "fine" }], reason: "note the mood" });
    expect(plan.reason).toBe("note the mood");
    expect(Object.keys(plan).at(-1)).toBe("reason");
    // the reason is not digested: the same effects without one are the same plan
    const bare = await ok("plan", { effects: [{ op: "set", target: "/journal.md", field: "_frontmatter.mood", value: "fine" }] });
    expect(bare.plan_id).toBe(plan.plan_id);
    expect("reason" in bare).toBe(false);
    // …and re-planning without one cleared the remembered reason; plan it again with one
    await ok("plan", { effects: [{ op: "set", target: "/journal.md", field: "_frontmatter.mood", value: "fine" }], reason: "note the mood" });
    await ok("execute", { plan_id: plan.plan_id });
    const reasonOf = async (): Promise<unknown> => ((await ok("query", { query: 'revisions { select _reason where _path == "/journal.md" order by _seq desc limit 1 }' })).hits as { _reason: unknown }[])[0]!._reason;
    expect(await reasonOf()).toBe("note the mood");

    // the plan form carries it in the Plan; execute's own reason wins
    const second = await ok("plan", { effects: [{ op: "set", target: "/journal.md", field: "_frontmatter.mood", value: "better" }], reason: "the plan's" });
    await ok("execute", { plan: second });
    expect(await reasonOf()).toBe("the plan's");
    const third = await ok("plan", { effects: [{ op: "set", target: "/journal.md", field: "_frontmatter.mood", value: "best" }], reason: "the plan's" });
    await ok("execute", { plan: third, reason: "execute's own" });
    expect(await reasonOf()).toBe("execute's own");
    const fourth = await ok("plan", { effects: [{ op: "unset", target: "/journal.md", field: "_frontmatter.mood" }] });
    await ok("execute", { plan_id: fourth.plan_id });
    expect(await reasonOf()).toBeNull();
  });

  it("complaint 4 — insert with `after` as a key: the valid keys, and data.fix moves it under at", async () => {
    const err = await refused("apply", { effects: [{ op: "insert", into: "/journal.md", after: "b_1", markdown: "Lead paragraph." }] });
    expect(err.error).toBe("filter_invalid");
    expect(err.data.valid_keys).toEqual(["op", "into", "at?", "markdown", "expect?"]);
    const fix = JSON.parse(err.data.fix as string) as { effects: Record<string, unknown>[] };
    expect(fix.effects[0]).toEqual({ op: "insert", into: "/journal.md", at: { after: "b_1" }, markdown: "Lead paragraph." });
    await ok("apply", fix);
    expect(file("journal.md")).toContain("## Plan\n\nLead paragraph.\n\n- write the spec\n");
  });

  it("complaint 5 — a nested anchor under a document into now works; under a section it names the real parent, and data.fix uses it", async () => {
    const blocks = (await ok("query", { query: 'blocks { select _type, _text where _path == "/journal.md" }' })).hits as { _id: string; _text: string; _type: string }[];
    const item = blocks.find((b) => b._text === "then the reference")!;
    // the call of the session, verbatim in shape: into the document path, at after the nested item
    await ok("apply", { effects: [{ op: "insert", into: "/journal.md", at: { after: item._id }, markdown: "- then the port" }] });
    expect(file("journal.md")).toContain("  - then the reference\n  - then the port\n- ship it\n");

    const heading = blocks.find((b) => b._type === "heading" && b._text === "Plan")!;
    const err = await refused("apply", { effects: [{ op: "insert", into: { kind: "section", heading_id: heading._id }, at: { after: item._id }, markdown: "- and the docs" }] });
    expect(err.error).toBe("target_missing");
    expect(err.data.anchor).toBe(item._id);
    expect(typeof err.data.parent).toBe("string");
    expect(err.message).toContain(err.data.parent as string);
    const fix = JSON.parse(err.data.fix as string) as { effects: { into: unknown }[] };
    expect(fix.effects[0]!.into).toEqual({ kind: "block", _id: err.data.parent });
    await ok("apply", fix);
    expect(file("journal.md")).toContain("  - then the reference\n  - and the docs\n  - then the port\n");
    expect(existsSync(join(dir, "journal.md"))).toBe(true);
  });
});

// Found by the live acceptance run (a fresh agent, the tools alone): the
// insert was right, and the read-back showed the PARENT task unchecked-box-less.
describe("a write beneath a task leaves the parent task a task (spec/mutate §3, 4.5)", () => {
  it("inserting after a nested task, and editing one, keep `- [ ] parent`", async () => {
    const GARDEN = "# Garden\n\n## Tasks\n\n- [ ] order seeds\n  - [ ] tomatoes\n  - [x] basil\n- [ ] turn the compost\n";
    await ok("apply", { effects: [{ op: "create", path: "/garden.md", markdown: GARDEN }] });
    const blocks = (await ok("query", { query: 'blocks { select _type, _text where _path == "/garden.md" }' })).hits as { _id: string; _text: string; _type: string }[];
    const tomatoes = blocks.find((b) => b._text === "tomatoes")!;
    await ok("apply", { effects: [{ op: "insert", into: "/garden.md", at: { after: tomatoes._id }, markdown: "- [ ] peppers" }] });
    expect(file("garden.md")).toBe("# Garden\n\n## Tasks\n\n- [ ] order seeds\n  - [ ] tomatoes\n  - [ ] peppers\n  - [x] basil\n- [ ] turn the compost\n");
    await ok("apply", { effects: [{ op: "set", target: tomatoes._id, field: "_attrs.checked", value: true }] });
    expect(file("garden.md")).toContain("- [ ] order seeds\n  - [x] tomatoes\n  - [ ] peppers\n");
    const after = (await ok("query", { query: 'blocks { select _type where _path == "/garden.md" and _text.startsWith("order seeds") and _type == "task" }' })).hits as unknown[];
    expect(after).toHaveLength(1);
  });
});
