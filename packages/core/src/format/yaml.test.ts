import { describe, it, expect } from "vitest";
import { yamlAdapter, extractYamlEdges } from "./yaml.js";

const SAMPLE = `# top comment
database:
  host: localhost
  port: 5432
  replicas:
    - host: replica1
    - host: replica2

auth:
  provider: oauth
  config: ./auth/config.yaml
`;

const WITH_REFS = `$schema: https://json-schema.org/draft/2020-12/schema
extends: ./base-config.yaml
database:
  $ref: "./db-schema.yaml#/definitions/Database"
  backup: ../backups/config.yaml
`;

describe("YAML adapter — parse", () => {
  it("decomposes a YAML mapping into top-level mapping_entry blocks", () => {
    const tree = yamlAdapter.parse(SAMPLE);
    expect(tree.children.length).toBe(2); // database, auth
    expect(tree.children[0]!.type).toBe("yaml:mapping_entry");
    expect(tree.children[0]!.attrs.key).toBe("database");
    expect(tree.children[1]!.type).toBe("yaml:mapping_entry");
    expect(tree.children[1]!.attrs.key).toBe("auth");
  });

  it("nests child blocks for nested mappings", () => {
    const tree = yamlAdapter.parse(SAMPLE);
    const db = tree.children[0]!;
    expect(db.children.length).toBeGreaterThan(0);
    const hostChild = db.children.find((c) => c.attrs.key === "host");
    expect(hostChild).toBeDefined();
  });

  it("handles sequence items as children", () => {
    const tree = yamlAdapter.parse(SAMPLE);
    const db = tree.children[0]!;
    const replicas = db.children.find((c) => c.attrs.key === "replicas");
    expect(replicas).toBeDefined();
    expect(replicas!.children.length).toBe(2);
  });

  it("round-trips via render", () => {
    const tree = yamlAdapter.parse(SAMPLE);
    expect(yamlAdapter.render!(tree)).toBe(SAMPLE);
  });

  it("handles empty YAML", () => {
    const tree = yamlAdapter.parse("");
    expect(tree.children.length).toBe(0);
    expect(tree.leadingTrivia).toBe("");
  });

  it("handles scalar-only YAML", () => {
    const tree = yamlAdapter.parse("42\n");
    expect(tree.children.length).toBe(1);
    expect(tree.children[0]!.type).toBe("yaml:scalar");
  });

  it("handles unusual YAML gracefully", () => {
    // YAML is very permissive — most strings parse as scalars.
    const odd = ":::not valid yaml\n  [[[[";
    const tree = yamlAdapter.parse(odd);
    expect(tree.children.length).toBeGreaterThan(0);
  });
});

describe("YAML adapter — extractMetadata", () => {
  it("extracts top-level mapping as metadata", () => {
    const meta = yamlAdapter.extractMetadata!(SAMPLE);
    expect(meta).toBeTruthy();
    expect(meta!.auth).toBeDefined();
    expect((meta!.database as Record<string, unknown>).host).toBe("localhost");
  });

  it("returns null for non-mapping YAML", () => {
    expect(yamlAdapter.extractMetadata!("- a\n- b\n")).toBeNull();
  });
});

describe("YAML adapter — edge extraction (source-based)", () => {
  it("extracts $ref edges", () => {
    const edges = extractYamlEdges(WITH_REFS);
    const refEdge = edges.find((e) => e.provenance === "yaml_ref" && e.predicate === "references");
    expect(refEdge).toBeDefined();
    expect(refEdge!.target).toBe("./db-schema.yaml");
    expect(refEdge!.anchor).toBe("/definitions/Database");
  });

  it("extracts $schema edges", () => {
    const edges = extractYamlEdges(WITH_REFS);
    const schemaEdge = edges.find((e) => e.provenance === "yaml_schema");
    expect(schemaEdge).toBeDefined();
    expect(schemaEdge!.dstKind).toBe("external");
  });

  it("extracts extends edges", () => {
    const edges = extractYamlEdges(WITH_REFS);
    const extendsEdge = edges.find((e) => e.provenance === "yaml_extends");
    expect(extendsEdge).toBeDefined();
    expect(extendsEdge!.target).toBe("./base-config.yaml");
  });

  it("extracts path-like value edges", () => {
    const edges = extractYamlEdges(WITH_REFS);
    const backupEdge = edges.find((e) => e.target === "../backups/config.yaml");
    expect(backupEdge).toBeDefined();
    expect(backupEdge!.dstKind).toBe("document");
  });
});

describe("YAML adapter — edge extraction (metadata-based)", () => {
  it("extracts edges from metadata object", () => {
    const meta = yamlAdapter.extractMetadata!(WITH_REFS);
    const edges = yamlAdapter.extractEdges!([], meta!);
    expect(edges.length).toBeGreaterThan(0);
    const extendsEdge = edges.find((e) => e.predicate === "extends");
    expect(extendsEdge).toBeDefined();
  });
});
