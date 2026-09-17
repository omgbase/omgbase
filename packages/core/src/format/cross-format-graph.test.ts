import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { oqxRun } from "../oqx/run.js";
import { docLinks } from "../graph/links.js";
import "../format/index.js"; // register adapters

let dir: string;
let store: Store;
let repoId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omg-xformat-"));
  store = new Store({ path: ":memory:" });
  repoId = ensureRepo(store, "t", dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function save(path: string, content: string): void {
  const abs = join(dir, path);
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(abs, content);
  processCheckpoint(store, repoId, dir, [{ path }]);
}

function docId(path: string): string {
  return (store.db.prepare("SELECT doc_id FROM docs WHERE path=?").get(path) as { doc_id: string }).doc_id;
}
// Reachable doc paths from a seed via OQX `follow doc.out|in` — the traversal
// replacement for the retired graph_traverse. Default depth (8) covers these
// short chains; the walk crosses format boundaries because edges are doc-grain.
function reachable(seed: string, dir: "out" | "in"): string[] {
  const hits = oqxRun(store, repoId, `from docs where $path == "${seed}" follow doc.${dir}`, { limit: 100 }).hits;
  return hits.map((h) => h.path as string);
}

describe("cross-format graph: markdown → yaml → json", () => {
  beforeEach(() => {
    // Markdown doc links to a YAML config.
    save("docs/readme.md", "# Project\n\nSee [database config](/config/database.yaml) for setup.\n");

    // YAML config extends a base and references a JSON schema.
    save("config/database.yaml", `extends: ./base.yaml\n$schema: ./schemas/db.json\nhost: localhost\nport: 5432\n`);

    // YAML base config.
    save("config/base.yaml", `timeout: 30\nretry: true\n`);

    // JSON schema.
    save("config/schemas/db.json", `{"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object"}`);
  });

  it("markdown doc has outbound edges to YAML file", () => {
    const links = docLinks(store, docId("docs/readme.md"), { direction: "out" });
    const targets = links.out.map((e) => e.node);
    expect(targets).toContain(docId("config/database.yaml"));
  });

  it("yaml doc has outbound extends edge to base.yaml", () => {
    const links = docLinks(store, docId("config/database.yaml"), { direction: "out" });
    const extendEdge = links.out.find((e) => e.predicate === "extends");
    expect(extendEdge).toBeDefined();
    expect(extendEdge!.node).toBe(docId("config/base.yaml"));
  });

  it("yaml doc has outbound schema edge to JSON schema", () => {
    const links = docLinks(store, docId("config/database.yaml"), { direction: "out" });
    const schemaEdge = links.out.find((e) => e.predicate === "schema");
    expect(schemaEdge).toBeDefined();
    expect(schemaEdge!.node).toBe(docId("config/schemas/db.json"));
  });

  it("follow doc.out crosses markdown → yaml boundary", () => {
    expect(reachable("docs/readme.md", "out")).toContain("config/database.yaml");
  });

  it("follow doc.out crosses yaml → yaml (extends)", () => {
    const paths = reachable("docs/readme.md", "out");
    expect(paths).toContain("config/database.yaml");
    expect(paths).toContain("config/base.yaml");
  });

  it("follow doc.out crosses yaml → json (schema)", () => {
    const paths = reachable("docs/readme.md", "out");
    expect(paths).toContain("config/database.yaml");
    expect(paths).toContain("config/schemas/db.json");
  });

  it("full traversal: md → yaml → yaml + json", () => {
    const paths = new Set(reachable("docs/readme.md", "out"));
    expect(paths.has("config/database.yaml")).toBe(true);
    expect(paths.has("config/base.yaml")).toBe(true);
    expect(paths.has("config/schemas/db.json")).toBe(true);
  });

  it("follow doc.in: who references the YAML config?", () => {
    expect(reachable("config/database.yaml", "in")).toContain("docs/readme.md");
  });

  it("follow doc.in: who extends base.yaml?", () => {
    expect(reachable("config/base.yaml", "in")).toContain("config/database.yaml");
  });
});

describe("cross-format graph: json $ref chains", () => {
  beforeEach(() => {
    save("schemas/main.json", JSON.stringify({
      "$ref": "./types.json",
      "definitions": {},
    }));
    save("schemas/types.json", JSON.stringify({
      "$ref": "./primitives.json",
      "type": "object",
    }));
    save("schemas/primitives.json", JSON.stringify({
      "type": "string",
    }));
  });

  it("follows json $ref chain across files", () => {
    const paths = reachable("schemas/main.json", "out");
    expect(paths).toContain("schemas/types.json");
    expect(paths).toContain("schemas/primitives.json");
  });
});
