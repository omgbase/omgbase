import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store/store.js";
import { ensureRepo } from "../core/attach.js";
import { processCheckpoint } from "../sync/checkpoint.js";
import { graphTraverse } from "../graph/traverse.js";
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
  return (store.db.prepare("SELECT doc_id FROM documents WHERE path=?").get(path) as { doc_id: string }).doc_id;
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

  it("graph_traverse crosses markdown → yaml boundary", () => {
    const res = graphTraverse(store, {
      from: [docId("docs/readme.md")],
      via: ["references"],
      direction: "out",
      depth: 1,
    });
    expect(res.nodes).toContain(docId("config/database.yaml"));
  });

  it("graph_traverse crosses yaml → yaml (extends) at depth 2", () => {
    const res = graphTraverse(store, {
      from: [docId("docs/readme.md")],
      via: ["references", "extends"],
      direction: "out",
      depth: 2,
    });
    expect(res.nodes).toContain(docId("config/database.yaml"));
    expect(res.nodes).toContain(docId("config/base.yaml"));
  });

  it("graph_traverse crosses yaml → json (schema) at depth 2", () => {
    const res = graphTraverse(store, {
      from: [docId("docs/readme.md")],
      via: ["references", "schema"],
      direction: "out",
      depth: 2,
    });
    expect(res.nodes).toContain(docId("config/database.yaml"));
    expect(res.nodes).toContain(docId("config/schemas/db.json"));
  });

  it("full 3-hop traversal: md → yaml → yaml + json", () => {
    const res = graphTraverse(store, {
      from: [docId("docs/readme.md")],
      via: ["references", "extends", "schema"],
      direction: "out",
      depth: 3,
    });
    const nodeSet = new Set(res.nodes);
    expect(nodeSet.has(docId("config/database.yaml"))).toBe(true);
    expect(nodeSet.has(docId("config/base.yaml"))).toBe(true);
    expect(nodeSet.has(docId("config/schemas/db.json"))).toBe(true);
  });

  it("inbound traversal: who references the YAML config?", () => {
    const res = graphTraverse(store, {
      from: [docId("config/database.yaml")],
      via: ["references"],
      direction: "in",
      depth: 1,
    });
    expect(res.nodes).toContain(docId("docs/readme.md"));
  });

  it("inbound traversal: who extends base.yaml?", () => {
    const res = graphTraverse(store, {
      from: [docId("config/base.yaml")],
      via: ["extends"],
      direction: "in",
      depth: 1,
    });
    expect(res.nodes).toContain(docId("config/database.yaml"));
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
    const res = graphTraverse(store, {
      from: [docId("schemas/main.json")],
      via: ["references"],
      direction: "out",
      depth: 2,
    });
    expect(res.nodes).toContain(docId("schemas/types.json"));
    expect(res.nodes).toContain(docId("schemas/primitives.json"));
  });
});
