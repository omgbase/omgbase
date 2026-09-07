import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import {
  resolveSettings,
  workspaceSettings,
  writeWorkspaceSettings,
  writeRepoSettings,
  deepMerge,
} from "./settings.js";

let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

describe("deepMerge", () => {
  it("repo overrides workspace at the leaf; siblings inherit", () => {
    const base = { embedding: { provider: "ws-cmd", model: "m1", dim: 384 }, gc: { enabled: false } };
    const over = { embedding: { provider: "repo-cmd" } };
    expect(deepMerge(base, over)).toEqual({
      embedding: { provider: "repo-cmd", model: "m1", dim: 384 }, // model/dim inherited
      gc: { enabled: false },
    });
  });

  it("arrays and scalars replace wholesale (not merged)", () => {
    expect(deepMerge({ a: [1, 2], b: 1 }, { a: [3], b: 2 })).toEqual({ a: [3], b: 2 });
  });
});

describe("resolveSettings", () => {
  it("empty everywhere ⇒ {}", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "r", null);
    expect(resolveSettings(store, repoId)).toEqual({});
  });

  it("a repo inherits a workspace default it hasn't overridden", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "r", null);
    writeWorkspaceSettings(store, { embedding: { provider: "omgbase-embedder", dim: 384 } });
    expect(resolveSettings(store, repoId)).toEqual({ embedding: { provider: "omgbase-embedder", dim: 384 } });
  });

  it("a repo override wins at the leaf but inherits siblings", () => {
    store = new Store({ path: ":memory:" });
    const repoId = ensureRepo(store, "r", null);
    writeWorkspaceSettings(store, { embedding: { provider: "ws", model: "m1", dim: 384 } });
    writeRepoSettings(store, repoId, { embedding: { provider: "repo-only" } });
    expect(resolveSettings(store, repoId)).toEqual({ embedding: { provider: "repo-only", model: "m1", dim: 384 } });
  });

  it("repoId=null returns the workspace defaults alone", () => {
    store = new Store({ path: ":memory:" });
    writeWorkspaceSettings(store, { gc: { enabled: true } });
    expect(resolveSettings(store, null)).toEqual({ gc: { enabled: true } });
    expect(workspaceSettings(store)).toEqual({ gc: { enabled: true } });
  });

  it("fresh db seeds an empty workspace_settings singleton", () => {
    store = new Store({ path: ":memory:" });
    expect(workspaceSettings(store)).toEqual({});
  });
});
