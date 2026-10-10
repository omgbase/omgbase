import { describe, expect, it } from "vitest";
import { parse } from "@omgbase/oqx";
import type { Candidate, Row } from "../src/lib/candidates.ts";
import {
  DEFAULT_FORM, ID_FORM, classifyRef, dedupeRefs, describeForm, describePatch, dominantForm, editability, formatRef, inferRefForm, inferShape,
  isDocId, ownerFor, planToggle, projectedFields, refKey, refValuedFields, sameRef, setMetaArgs, type RefForm,
} from "../src/lib/edit.ts";

const alpha = { id: "d_alpha00", path: "timeline/alpha.md" };
const beta = { id: "d_beta000", path: "timeline/beta.md" };
const gamma = { id: "d_gamma00", path: "timeline/gamma.md" };
const ROOTED: RefForm = DEFAULT_FORM;
const BARE_MD: RefForm = { kind: "path", rooted: false, md: true };
const ROOTED_NO_MD: RefForm = { kind: "path", rooted: true, md: false };
const LIST = { shape: "list" as const, emptyListBehavior: "unset" as const };
const SCALAR = { shape: "scalar" as const, emptyListBehavior: "unset" as const };

const cand = (name: string, kind: Candidate["kind"] = "frontmatter"): Candidate => ({
  name, kind, sources: ["inferred"], spans: [], defaults: { edge: true, layout: false, direction: "forward" },
});

describe("reference classification", () => {
  it("recognizes doc ids, rooted and bare paths, with and without .md", () => {
    expect(isDocId("d_77ptprj")).toBe(true);
    expect(isDocId("d_0")).toBe(true);
    expect(isDocId("d_77ptprjx")).toBe(false); // too long
    expect(isDocId("d_ilou")).toBe(false); // letters outside the alphabet
    expect(isDocId("b_77ptprj")).toBe(false); // a block id is not a doc
    expect(classifyRef("/projects/oqx.md")).toEqual(ROOTED);
    expect(classifyRef("projects/oqx.md")).toEqual(BARE_MD);
    expect(classifyRef("/projects/oqx")).toEqual(ROOTED_NO_MD);
    expect(classifyRef("projects/oqx")).toEqual({ kind: "path", rooted: false, md: false });
    expect(classifyRef("kickoff.md")).toEqual(BARE_MD);
    expect(classifyRef("d_77ptprj")).toEqual(ID_FORM);
  });

  it("rejects plain words, numbers, urls, other file types", () => {
    for (const v of ["build", "Alpha", "", 3, null, undefined, ["x"], "https://example.com/a.md", "a b/c.md", "image.png", "v1.2", "a/b.png"]) {
      expect(classifyRef(v), JSON.stringify(v)).toBeNull();
    }
  });

  it("refKey normalizes forms; sameRef matches any spelling or the id", () => {
    expect(refKey("/timeline/alpha.md")).toBe("timeline/alpha");
    expect(refKey("timeline/alpha")).toBe("timeline/alpha");
    expect(refKey("d_alpha00")).toBe("d_alpha00");
    for (const v of ["/timeline/alpha.md", "timeline/alpha.md", "/timeline/alpha", "timeline/alpha", "d_alpha00"]) expect(sameRef(v, alpha), v).toBe(true);
    expect(sameRef("/timeline/beta.md", alpha)).toBe(false);
    expect(sameRef(42, alpha)).toBe(false);
  });

  it("formatRef spells a node in a form", () => {
    expect(formatRef(alpha, ROOTED)).toBe("/timeline/alpha.md");
    expect(formatRef(alpha, BARE_MD)).toBe("timeline/alpha.md");
    expect(formatRef(alpha, ROOTED_NO_MD)).toBe("/timeline/alpha");
    expect(formatRef(alpha, { kind: "path", rooted: false, md: false })).toBe("timeline/alpha");
    expect(formatRef(alpha, ID_FORM)).toBe("d_alpha00");
    expect(describeForm(ROOTED)).toBe("/path.md");
    expect(describeForm(ID_FORM)).toBe("doc id");
  });
});

describe("form inference", () => {
  it("takes the one form the field uses, across scalars and lists", () => {
    expect(inferRefForm(["/a.md", ["/b.md", "/c.md"]])).toEqual(ROOTED);
    expect(inferRefForm([["a/b.md"], "c.md"])).toEqual(BARE_MD);
    expect(inferRefForm(["d_0", ["d_1"]])).toEqual(ID_FORM);
  });

  it("is null with no values and 'mixed' when forms disagree", () => {
    expect(inferRefForm([])).toBeNull();
    expect(inferRefForm([[]])).toBeNull();
    expect(inferRefForm(["/a.md", "b.md"])).toBe("mixed");
    expect(inferRefForm(["/a.md", "/b"])).toBe("mixed");
    expect(inferRefForm(["/a.md", "d_0"])).toBe("mixed");
  });

  it("infers the dominant shape, ties to list", () => {
    expect(inferShape([])).toBeNull();
    expect(inferShape(["/a.md"])).toBe("scalar");
    expect(inferShape([["/a.md"], "/b.md"])).toBe("list");
    expect(inferShape([["/a.md"], "/b.md", "/c.md"])).toBe("scalar");
  });

  it("finds reference fields and the dominant form among them", () => {
    const rows: Row[] = [
      { id: "d_0", path: "a.md", title: "A", owner: "/people/ada.md", before: ["/t/b.md"], phase: "plan" },
      { id: "d_1", path: "b.md", title: "B", owner: "/people/grace.md", before: ["/t/c.md", "/t/d.md"], tags: ["x/y.md", "plain"] },
    ];
    expect(refValuedFields(rows).sort()).toEqual(["before", "owner"]);
    expect(dominantForm(rows)).toEqual({ form: ROOTED, shape: "list" });
    expect(dominantForm([{ id: "d_0", path: "a.md", title: "A" }])).toBeNull();
  });
});

describe("editability (rule 1)", () => {
  const rows: Row[] = [
    { id: "d_0", path: "t/a.md", title: "A", after: ["/t/z.md"], owner: "/people/ada.md", phase: "plan" },
    { id: "d_1", path: "t/b.md", title: "B", owner: "p/grace.md", phase: "build" },
  ];

  it("rejects links, backlinks, sequences, nested paths, non-reference values", () => {
    expect(editability(cand("doc.out", "links"), rows)).toEqual({ writable: false, reason: "links live in the body" });
    expect(editability(cand("doc.in", "backlinks"), rows)).toEqual({ writable: false, reason: "links live in the body" });
    expect(editability(cand("arc_order", "sequence"), rows)).toEqual({ writable: false, reason: "derived from order by arc_order" });
    expect(editability(cand("meta.rel"), rows)).toEqual({ writable: false, reason: "not a frontmatter field" });
    expect(editability(cand("phase"), rows)).toEqual({ writable: false, reason: "values are not document references" });
  });

  it("refuses a field with mixed forms, naming them", () => {
    const e = editability(cand("owner"), rows);
    expect(e.writable).toBe(false);
    if (!e.writable) expect(e.reason).toMatch(/mixed value forms in owner \(\/path\.md, path\.md\)/);
  });

  it("accepts a reference field with its own form and shape", () => {
    expect(editability(cand("after"), rows)).toEqual({ writable: true, form: ROOTED, shape: "list", formSource: "field" });
  });

  it("falls back to the rows' dominant form, then to a rooted .md path", () => {
    // `before` was not projected: no values, so borrow from `after`/`owner`.
    const r2: Row[] = [{ id: "d_0", path: "t/a.md", after: ["z.md"], owner: "p/ada.md" }];
    expect(editability(cand("before"), r2)).toEqual({ writable: true, form: BARE_MD, shape: "list", formSource: "rows" });
    expect(editability(cand("before"), [{ id: "d_0", path: "t/a.md", title: "A" }])).toEqual({ writable: true, form: ROOTED, shape: "list", formSource: "default" });
    expect(editability(cand("before"), [])).toEqual({ writable: true, form: ROOTED, shape: "list", formSource: "default" });
  });

  it("is read-only when the server offers no docs_set_meta", () => {
    const e = editability(cand("after"), rows, false);
    expect(e.writable).toBe(false);
    if (!e.writable) expect(e.reason).toMatch(/docs_set_meta.*allowlist/);
  });
});

describe("direction → owner (rule 2)", () => {
  it("forward edits the selected document, backward the target", () => {
    expect(ownerFor("forward", alpha, beta)).toEqual({ owner: alpha, other: beta });
    expect(ownerFor("backward", alpha, beta)).toEqual({ owner: beta, other: alpha });
  });

  it("reads the faithfully projected fields off the AST", () => {
    const q = parse(`select $path, title, before, b2: after, n: title.size() from docs where phase == "plan"`);
    expect(projectedFields(q)).toEqual(["title", "before"]);
    expect(projectedFields(null)).toEqual([]);
    expect(projectedFields(parse(`$path from docs`))).toEqual([]);
  });
});

describe("planToggle (rule 4)", () => {
  it("list: append in the field's form, order preserved, deduped", () => {
    expect(planToggle(["/timeline/alpha.md"], beta, false, ROOTED, LIST)).toEqual({ kind: "set", value: ["/timeline/alpha.md", "/timeline/beta.md"] });
    expect(planToggle(["timeline/alpha.md", "timeline/alpha.md"], beta, false, BARE_MD, LIST)).toEqual({ kind: "set", value: ["timeline/alpha.md", "timeline/beta.md"] });
    expect(planToggle(["d_alpha00"], beta, false, ID_FORM, LIST)).toEqual({ kind: "set", value: ["d_alpha00", "d_beta000"] });
  });

  it("list: adding a member already there (in any spelling) is a no-op", () => {
    expect(planToggle(["timeline/beta"], beta, false, ROOTED, LIST)).toEqual({ kind: "noop", reason: "already present" });
    expect(planToggle(["d_beta000"], beta, false, ROOTED, LIST)).toEqual({ kind: "noop", reason: "already present" });
  });

  it("list: remove keeps order, drops every spelling, dedupes the rest", () => {
    const cur = ["/timeline/alpha.md", "/timeline/beta.md", "timeline/beta", "/timeline/gamma.md", "/timeline/alpha.md"];
    expect(planToggle(cur, beta, true, ROOTED, LIST)).toEqual({ kind: "set", value: ["/timeline/alpha.md", "/timeline/gamma.md"] });
    expect(planToggle(["/timeline/alpha.md"], beta, true, ROOTED, LIST)).toEqual({ kind: "noop", reason: "/timeline/beta.md is not in the list" });
  });

  it("list: emptying it unsets by default, or keeps [] when asked", () => {
    expect(planToggle(["/timeline/beta.md"], beta, true, ROOTED, LIST)).toEqual({ kind: "unset" });
    expect(planToggle(["/timeline/beta.md"], beta, true, ROOTED, { ...LIST, emptyListBehavior: "keep" })).toEqual({ kind: "set", value: [] });
  });

  it("scalar: set, replace, unset, and no-ops", () => {
    expect(planToggle(undefined, beta, false, ROOTED, SCALAR)).toEqual({ kind: "set", value: "/timeline/beta.md" });
    expect(planToggle("/timeline/alpha.md", beta, false, ROOTED, SCALAR)).toEqual({ kind: "set", value: "/timeline/beta.md" });
    expect(planToggle("timeline/beta.md", beta, false, ROOTED, SCALAR)).toEqual({ kind: "noop", reason: "already present" });
    expect(planToggle("/timeline/beta.md", beta, true, ROOTED, SCALAR)).toEqual({ kind: "unset" });
    expect(planToggle("/timeline/alpha.md", beta, true, ROOTED, SCALAR)).toEqual({ kind: "noop", reason: "the field names /timeline/alpha.md, not /timeline/beta.md" });
    expect(planToggle(null, beta, true, ROOTED, SCALAR)).toEqual({ kind: "noop", reason: "nothing to remove — the field is empty" });
  });

  it("no value yet: the inferred shape decides list vs scalar", () => {
    expect(planToggle(undefined, gamma, false, ROOTED, LIST)).toEqual({ kind: "set", value: ["/timeline/gamma.md"] });
    expect(planToggle(undefined, gamma, false, BARE_MD, SCALAR)).toEqual({ kind: "set", value: "timeline/gamma.md" });
  });

  it("the id-vs-path cases: an id-form field gets ids, a path-form field gets paths, matching is by identity either way", () => {
    expect(planToggle("d_alpha00", beta, false, ID_FORM, SCALAR)).toEqual({ kind: "set", value: "d_beta000" });
    expect(planToggle(["/timeline/alpha.md"], beta, true, ID_FORM, LIST)).toEqual({ kind: "noop", reason: "d_beta000 is not in the list" });
    expect(planToggle(["/timeline/beta.md"], beta, true, ID_FORM, LIST)).toEqual({ kind: "unset" });
    expect(planToggle(["d_beta000", "d_alpha00"], beta, true, ROOTED, LIST)).toEqual({ kind: "set", value: ["d_alpha00"] });
  });

  it("refuses values it cannot edit", () => {
    expect(planToggle(42, beta, false, ROOTED, SCALAR)).toEqual({ kind: "refuse", reason: "the field holds a number value, not a reference" });
    expect(planToggle(["/a.md", 1], beta, false, ROOTED, LIST)).toEqual({ kind: "refuse", reason: "the list holds non-string values" });
    expect(planToggle({ a: 1 }, beta, false, ROOTED, LIST).kind).toBe("refuse");
  });

  it("dedupeRefs keeps the first spelling", () => {
    expect(dedupeRefs(["/a.md", "a.md", "/b.md", "d_0", "b"])).toEqual(["/a.md", "/b.md", "d_0"]);
  });

  it("setMetaArgs and describePatch", () => {
    expect(setMetaArgs("after", { kind: "set", value: ["/x.md"] })).toEqual({ set: { after: ["/x.md"] } });
    expect(setMetaArgs("after", { kind: "unset" })).toEqual({ unset: ["after"] });
    expect(setMetaArgs("after", { kind: "noop", reason: "r" })).toBeNull();
    expect(setMetaArgs("after", { kind: "refuse", reason: "r" })).toBeNull();
    expect(describePatch(beta, "after", { kind: "set", value: ["/x.md"] }, ["/y.md"])).toBe('timeline/beta.md · set after: ["/x.md"] (was ["/y.md"])');
    expect(describePatch(beta, "after", { kind: "unset" }, "/x.md")).toBe('timeline/beta.md · unset after (was "/x.md")');
    expect(describePatch(beta, "after", { kind: "noop", reason: "already present" }, undefined)).toBe("timeline/beta.md · after unchanged — already present");
    expect(describePatch(beta, "after", { kind: "refuse", reason: "no" }, undefined)).toBe("timeline/beta.md · after cannot be edited — no");
  });
});
