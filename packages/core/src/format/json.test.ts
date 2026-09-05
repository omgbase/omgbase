import { describe, it, expect } from "vitest";
import { jsonAdapter } from "./json.js";

const SAMPLE = `{
  "name": "test-project",
  "version": "1.0.0",
  "dependencies": {
    "express": "^4.18.0",
    "yaml": "^2.9.0"
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  }
}`;

const WITH_REFS = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$ref": "./base-schema.json#/definitions/Config",
  "properties": {
    "database": {
      "$ref": "./db-schema.json"
    },
    "config_path": "/etc/app/config.yaml"
  }
}`;

describe("JSON adapter — parse", () => {
  it("decomposes a JSON object into property blocks", () => {
    const tree = jsonAdapter.parse(SAMPLE);
    expect(tree.children.length).toBe(4); // name, version, dependencies, scripts
    expect(tree.children[0]!.type).toBe("json:property");
    expect(tree.children[0]!.attrs.key).toBe("name");
  });

  it("handles nested objects", () => {
    const tree = jsonAdapter.parse(SAMPLE);
    const deps = tree.children.find((c) => c.attrs.key === "dependencies");
    expect(deps).toBeDefined();
  });

  it("handles JSON arrays", () => {
    const arr = `["a", "b", "c"]`;
    const tree = jsonAdapter.parse(arr);
    expect(tree.children.length).toBe(3);
    expect(tree.children[0]!.type).toBe("json:item");
  });

  it("handles scalar JSON", () => {
    const tree = jsonAdapter.parse(`42`);
    expect(tree.children.length).toBe(1);
    expect(tree.children[0]!.type).toBe("json:scalar");
  });

  it("handles empty object", () => {
    const tree = jsonAdapter.parse(`{}`);
    expect(tree.children.length).toBe(0);
  });

  it("handles truly unparseable JSON as opaque", () => {
    // Our simple parser tries its best; test with something that genuinely fails.
    const tree = jsonAdapter.parse(``);
    expect(tree.children.length).toBe(1);
    expect(tree.children[0]!.type).toBe("json:opaque");
  });
});

describe("JSON adapter — extractMetadata", () => {
  it("extracts root object as metadata", () => {
    const meta = jsonAdapter.extractMetadata!(SAMPLE);
    expect(meta).toBeTruthy();
    expect(meta!.name).toBe("test-project");
    expect(meta!.version).toBe("1.0.0");
  });

  it("returns null for non-object JSON", () => {
    expect(jsonAdapter.extractMetadata!(`[1, 2, 3]`)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(jsonAdapter.extractMetadata!(`{not valid}`)).toBeNull();
  });
});

describe("JSON adapter — edge extraction", () => {
  it("extracts $ref edges", () => {
    const meta = jsonAdapter.extractMetadata!(WITH_REFS);
    const edges = jsonAdapter.extractEdges!([], meta!);
    const refs = edges.filter((e) => e.predicate === "references");
    expect(refs.length).toBeGreaterThanOrEqual(2); // top-level + nested
    const topRef = refs.find((e) => e.target === "./base-schema.json");
    expect(topRef).toBeDefined();
    expect(topRef!.anchor).toBe("/definitions/Config");
    expect(topRef!.provenance).toBe("json_ref");
  });

  it("extracts $schema edges", () => {
    const meta = jsonAdapter.extractMetadata!(WITH_REFS);
    const edges = jsonAdapter.extractEdges!([], meta!);
    const schemaEdge = edges.find((e) => e.provenance === "json_schema");
    expect(schemaEdge).toBeDefined();
    expect(schemaEdge!.dstKind).toBe("external");
  });

  it("extracts path-like value edges", () => {
    const meta = jsonAdapter.extractMetadata!(WITH_REFS);
    const edges = jsonAdapter.extractEdges!([], meta!);
    const pathEdge = edges.find((e) => e.target === "/etc/app/config.yaml");
    expect(pathEdge).toBeDefined();
    expect(pathEdge!.dstKind).toBe("document");
  });

  it("does not extract non-path string values", () => {
    const meta = jsonAdapter.extractMetadata!(SAMPLE);
    const edges = jsonAdapter.extractEdges!([], meta!);
    const exprEdge = edges.find((e) => e.target === "^4.18.0");
    expect(exprEdge).toBeUndefined();
  });
});

describe("JSON adapter — no render", () => {
  it("does not expose render capability", () => {
    expect(jsonAdapter.render).toBeUndefined();
    expect(jsonAdapter.capabilities.has("render" as never)).toBe(false);
  });
});
