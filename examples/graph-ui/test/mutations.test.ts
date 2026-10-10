import { describe, expect, it } from "vitest";
import { DEFAULT_FORM } from "../src/lib/edit.ts";
import { PerKeyQueue, applyToggle, currentFieldValue, describeMutationError, prepareToggle, type MetaClient } from "../src/lib/mutations.ts";

const alpha = { id: "d_alpha00", path: "timeline/alpha.md" };
const beta = { id: "d_beta000", path: "timeline/beta.md" };

function fakeClient(frontmatter: Record<string, Record<string, unknown>>) {
  const reads: string[] = [];
  const writes: { doc: string; patch: unknown; repo?: string }[] = [];
  const client: MetaClient = {
    async docsRead(doc) {
      reads.push(doc);
      const fm = frontmatter[doc];
      if (!fm) throw new Error(`doc_missing: ${doc}`);
      return { properties: { frontmatter: fm } };
    },
    async docsSetMeta(doc, patch, repo) {
      writes.push({ doc, patch, ...(repo ? { repo } : {}) });
      return { docId: "d_x", path: doc, committed: true };
    },
  };
  return { client, reads, writes };
}

describe("PerKeyQueue", () => {
  it("serializes jobs per key and lets different keys interleave", async () => {
    const q = new PerKeyQueue();
    const log: string[] = [];
    const gate: (() => void)[] = [];
    const slow = (name: string) => () => new Promise<string>((resolve) => { gate.push(() => { log.push(name); resolve(name); }); });
    const a1 = q.run("a", slow("a1"));
    const a2 = q.run("a", slow("a2"));
    const b1 = q.run("b", slow("b1"));
    await Promise.resolve();
    // a1 and b1 started; a2 waits for a1.
    expect(gate).toHaveLength(2);
    expect(q.busy.sort()).toEqual(["a", "b"]);
    gate[1]!(); // b1
    gate[0]!(); // a1
    await a1;
    await b1;
    await Promise.resolve();
    expect(gate).toHaveLength(3);
    gate[2]!(); // a2
    await a2;
    expect(log).toEqual(["b1", "a1", "a2"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(q.busy).toEqual([]);
  });

  it("a failed job does not block the next on the same key", async () => {
    const q = new PerKeyQueue();
    await expect(q.run("a", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await q.run("a", () => Promise.resolve("ok"))).toBe("ok");
  });
});

describe("currentFieldValue", () => {
  it("uses the row when the field was projected, even when the row lacks the key", async () => {
    const { client, reads } = fakeClient({});
    expect(await currentFieldValue(client, beta, "after", { id: "d_beta000", path: "timeline/beta.md", after: ["/x.md"] }, true)).toEqual(["/x.md"]);
    expect(await currentFieldValue(client, beta, "after", { id: "d_beta000", path: "timeline/beta.md" }, true)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("reads the owner when the query did not project the field", async () => {
    const { client, reads } = fakeClient({ "timeline/beta.md": { after: ["/timeline/alpha.md"], title: "Beta" } });
    expect(await currentFieldValue(client, beta, "after", { id: "d_beta000", path: "timeline/beta.md" }, false)).toEqual(["/timeline/alpha.md"]);
    expect(await currentFieldValue(client, beta, "owner", undefined, false)).toBeUndefined();
    expect(reads).toEqual(["timeline/beta.md", "timeline/beta.md"]);
  });
});

describe("prepareToggle + applyToggle", () => {
  const options = { shape: "list" as const, emptyListBehavior: "unset" as const };

  it("plans an add from a docs_read and writes set", async () => {
    const { client, writes } = fakeClient({ "timeline/beta.md": { after: ["/timeline/alpha.md"] } });
    const plan = await prepareToggle(client, { owner: beta, target: { id: "d_gamma00", path: "timeline/gamma.md" }, field: "after", present: false, form: DEFAULT_FORM, options, row: undefined, projected: false, repo: "sample" });
    expect(plan.previous).toEqual(["/timeline/alpha.md"]);
    expect(plan.args).toEqual({ set: { after: ["/timeline/alpha.md", "/timeline/gamma.md"] } });
    await applyToggle(client, new PerKeyQueue(), plan, "sample");
    expect(writes).toEqual([{ doc: "timeline/beta.md", patch: { set: { after: ["/timeline/alpha.md", "/timeline/gamma.md"] } }, repo: "sample" }]);
  });

  it("plans a remove that empties the list as unset; no-ops write nothing", async () => {
    const { client, writes } = fakeClient({});
    const row = { id: "d_beta000", path: "timeline/beta.md", after: ["/timeline/alpha.md"] };
    const plan = await prepareToggle(client, { owner: beta, target: alpha, field: "after", present: true, form: DEFAULT_FORM, options, row, projected: true });
    expect(plan.args).toEqual({ unset: ["after"] });
    const noop = await prepareToggle(client, { owner: beta, target: alpha, field: "after", present: false, form: DEFAULT_FORM, options, row, projected: true });
    expect(noop.patch).toEqual({ kind: "noop", reason: "already present" });
    expect(noop.args).toBeNull();
    expect(await applyToggle(client, new PerKeyQueue(), noop)).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe("describeMutationError", () => {
  it("adds the gateway allowlist hint to a refusal", () => {
    expect(describeMutationError(new Error("MCP error -32602: Tool docs_set_meta not found"))).toMatch(/allowlist must include docs_set_meta/);
    expect(describeMutationError(new Error("tool not allowed by policy"))).toMatch(/gateway/);
  });

  it("passes other errors through", () => {
    expect(describeMutationError(new Error("doc_missing: no document x"))).toBe("doc_missing: no document x");
    expect(describeMutationError("plain")).toBe("plain");
  });
});
