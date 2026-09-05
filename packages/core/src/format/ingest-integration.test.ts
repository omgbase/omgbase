import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ingestFile } from "../core/ingest.js";
import { query } from "../search/query.js";
import "../format/index.js"; // register adapters

let store: Store | undefined;
afterEach(() => { store?.close(); store = undefined; });

function setup(): { store: Store; repoId: string } {
  store = new Store({ path: ":memory:" });
  store.db.prepare("INSERT INTO repos (repo_id, slug, root_path) VALUES ('rp_1','test','/tmp')").run();
  return { store, repoId: "rp_1" };
}

describe("multiformat ingest integration", () => {
  it("ingests a YAML file with format=yaml", () => {
    const { store, repoId } = setup();
    const content = `database:\n  host: localhost\n  port: 5432\n`;
    const result = ingestFile(store, repoId, "config/database.yaml", content);
    expect(result.blockCount).toBeGreaterThan(0);

    const doc = store.db.prepare("SELECT format FROM documents WHERE doc_id = ?").get(result.docId) as { format: string };
    expect(doc.format).toBe("yaml");
  });

  it("ingests a JSON file with format=json", () => {
    const { store, repoId } = setup();
    const content = `{"name": "test", "version": "1.0.0"}`;
    const result = ingestFile(store, repoId, "package.json", content);
    expect(result.blockCount).toBeGreaterThan(0);

    const doc = store.db.prepare("SELECT format FROM documents WHERE doc_id = ?").get(result.docId) as { format: string };
    expect(doc.format).toBe("json");
  });

  it("ingests a Markdown file with format=markdown", () => {
    const { store, repoId } = setup();
    const content = `# Hello\n\nWorld.\n`;
    const result = ingestFile(store, repoId, "readme.md", content);
    expect(result.blockCount).toBeGreaterThan(0);

    const doc = store.db.prepare("SELECT format FROM documents WHERE doc_id = ?").get(result.docId) as { format: string };
    expect(doc.format).toBe("markdown");
  });

  it("stores YAML blocks with yaml: prefixed types", () => {
    const { store, repoId } = setup();
    const content = `server:\n  host: 0.0.0.0\n  port: 8080\n`;
    const result = ingestFile(store, repoId, "config.yaml", content);

    const blocks = store.db
      .prepare("SELECT type FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL")
      .all(result.docId) as { type: string }[];
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.type.startsWith("yaml:"))).toBe(true);
  });

  it("stores JSON blocks with json: prefixed types", () => {
    const { store, repoId } = setup();
    const content = `{"a": 1, "b": 2}`;
    const result = ingestFile(store, repoId, "data.json", content);

    const blocks = store.db
      .prepare("SELECT type FROM blocks WHERE doc_id = ? AND deleted_commit IS NULL")
      .all(result.docId) as { type: string }[];
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.type.startsWith("json:"))).toBe(true);
  });

  it("queries by format on documents target", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "readme.md", "# Hello\n");
    ingestFile(store, repoId, "config.yaml", "key: value\n");
    ingestFile(store, repoId, "data.json", `{"a": 1}`);

    const yamlDocs = query(store, repoId, { from: "documents", filter: 'format == "yaml"' });
    expect(yamlDocs.hits.length).toBe(1);
    expect(yamlDocs.hits[0]!.path).toBe("config.yaml");

    const jsonDocs = query(store, repoId, { from: "documents", filter: 'format == "json"' });
    expect(jsonDocs.hits.length).toBe(1);
    expect(jsonDocs.hits[0]!.path).toBe("data.json");

    const mdDocs = query(store, repoId, { from: "documents", filter: 'format == "markdown"' });
    expect(mdDocs.hits.length).toBe(1);
    expect(mdDocs.hits[0]!.path).toBe("readme.md");
  });

  it("queries by block kind across formats", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "readme.md", "# Hello\n\nParagraph.\n");
    ingestFile(store, repoId, "config.yaml", "key: value\n");

    const yamlBlocks = query(store, repoId, {
      from: "blocks",
      filter: 'type.startsWith("yaml:")',
    });
    expect(yamlBlocks.hits.length).toBeGreaterThan(0);

    const headings = query(store, repoId, {
      from: "blocks",
      filter: 'type == "heading"',
    });
    expect(headings.hits.length).toBe(1);
  });

  it("queries blocks by doc.format", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "readme.md", "# Hello\n");
    ingestFile(store, repoId, "config.yaml", "key: value\n");

    const yamlBlocks = query(store, repoId, {
      from: "blocks",
      filter: 'doc.format == "yaml"',
    });
    expect(yamlBlocks.hits.length).toBeGreaterThan(0);
  });

  it("populates metadata from YAML adapter extractMetadata", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "config.yaml", "database:\n  host: localhost\n  port: 5432\n");

    const row = store.db.prepare("SELECT metadata FROM documents WHERE path = 'config.yaml'").get() as { metadata: string };
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(meta.database).toBeDefined();
    expect((meta.database as Record<string, unknown>).host).toBe("localhost");
    expect((meta.database as Record<string, unknown>).port).toBe(5432);
  });

  it("populates metadata from JSON adapter extractMetadata", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "package.json", `{"name": "test", "version": "1.0.0"}`);

    const row = store.db.prepare("SELECT metadata FROM documents WHERE path = 'package.json'").get() as { metadata: string };
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(meta.name).toBe("test");
    expect(meta.version).toBe("1.0.0");
  });

  it("queries YAML document metadata with CEL filters", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "config.yaml", "database:\n  host: localhost\nlogging:\n  level: debug\n");
    ingestFile(store, repoId, "other.yaml", "database:\n  host: remote\nlogging:\n  level: info\n");

    const debugDocs = query(store, repoId, {
      from: "documents",
      filter: 'logging.level == "debug"',
    });
    expect(debugDocs.hits.length).toBe(1);
    expect(debugDocs.hits[0]!.path).toBe("config.yaml");
  });

  it("queries JSON document metadata with CEL filters", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "a.json", `{"name": "alpha", "private": true}`);
    ingestFile(store, repoId, "b.json", `{"name": "beta", "private": false}`);

    const privateDocs = query(store, repoId, {
      from: "documents",
      filter: 'name == "alpha"',
    });
    expect(privateDocs.hits.length).toBe(1);
    expect(privateDocs.hits[0]!.path).toBe("a.json");
  });
});
