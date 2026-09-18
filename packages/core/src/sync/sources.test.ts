import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import {
  ensureAdapter,
  listAdapters,
  createSource,
  deleteSource,
  listSources,
  getSourceByName,
  attachSourceToRepo,
  detachSourceFromRepo,
  sourcesForRepo,
  renderConfigFlags,
} from "./sources.js";

let store: Store;
let repoId: string;

beforeEach(() => {
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", null);
});
afterEach(() => store.close());

describe("source registry", () => {
  it("ensureAdapter is idempotent and upserts the command", () => {
    ensureAdapter(store, "fs", "omgbase-fs-adapter", []);
    ensureAdapter(store, "fs", "omgbase-fs-adapter-v2", ["--x"]);
    const adapters = listAdapters(store);
    expect(adapters).toHaveLength(1);
    expect(adapters[0]).toEqual({ name: "fs", command: "omgbase-fs-adapter-v2", args: ["--x"] });
  });

  it("createSource requires an existing adapter (FK enforced)", () => {
    expect(() => createSource(store, { name: "missing", adapter: "nope" })).toThrow();
  });

  it("creates, looks up, attaches, and lists sources per repo", () => {
    ensureAdapter(store, "fs", "omgbase-fs-adapter");
    const id = createSource(store, { name: "notes-fs", adapter: "fs", config: { root: "/vault/notes" } });

    expect(getSourceByName(store, "notes-fs")).toMatchObject({ sourceId: id, adapter: "fs", config: { root: "/vault/notes" } });
    expect(listSources(store)).toHaveLength(1);
    expect(sourcesForRepo(store, repoId)).toHaveLength(0);

    attachSourceToRepo(store, repoId, id);
    attachSourceToRepo(store, repoId, id); // idempotent
    const attached = sourcesForRepo(store, repoId);
    expect(attached).toHaveLength(1);
    expect(attached[0]!.config.root).toBe("/vault/notes");

    detachSourceFromRepo(store, repoId, id);
    expect(sourcesForRepo(store, repoId)).toHaveLength(0);
  });

  it("deleteSource cascades its attachments", () => {
    ensureAdapter(store, "fs", "omgbase-fs-adapter");
    const id = createSource(store, { name: "s", adapter: "fs", config: { root: "/x" } });
    attachSourceToRepo(store, repoId, id);
    deleteSource(store, id);
    expect(getSourceByName(store, "s")).toBeNull();
    expect(sourcesForRepo(store, repoId)).toHaveLength(0);
  });

  it("renderConfigFlags maps config to argv (--key value; bare --key for true)", () => {
    expect(renderConfigFlags({ root: "/vault" })).toEqual(["--root", "/vault"]);
    expect(renderConfigFlags({ watch: true, quiet: false })).toEqual(["--watch"]);
    expect(renderConfigFlags({ root: "/v", depth: 3 })).toEqual(["--root", "/v", "--depth", "3"]);
    expect(renderConfigFlags({ skip: null, gone: undefined })).toEqual([]);
  });
});
