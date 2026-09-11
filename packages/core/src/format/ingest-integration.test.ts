import { describe, it, expect, afterEach } from "vitest";
import { Store } from "../core/store/store.js";
import { ingestFile } from "../core/ingest.js";
import { docPropertiesMerged } from "../core/store/properties.js";
import { oqxRun } from "../oqx/run.js";
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

    const doc = store.db.prepare("SELECT format FROM docs WHERE doc_id = ?").get(result.docId) as { format: string };
    expect(doc.format).toBe("yaml");
  });

  it("ingests a JSON file with format=json", () => {
    const { store, repoId } = setup();
    const content = `{"name": "test", "version": "1.0.0"}`;
    const result = ingestFile(store, repoId, "package.json", content);
    expect(result.blockCount).toBeGreaterThan(0);

    const doc = store.db.prepare("SELECT format FROM docs WHERE doc_id = ?").get(result.docId) as { format: string };
    expect(doc.format).toBe("json");
  });

  it("ingests a Markdown file with format=markdown", () => {
    const { store, repoId } = setup();
    const content = `# Hello\n\nWorld.\n`;
    const result = ingestFile(store, repoId, "readme.md", content);
    expect(result.blockCount).toBeGreaterThan(0);

    const doc = store.db.prepare("SELECT format FROM docs WHERE doc_id = ?").get(result.docId) as { format: string };
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

  it("queries by format on docs target", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "readme.md", "# Hello\n");
    ingestFile(store, repoId, "config.yaml", "key: value\n");
    ingestFile(store, repoId, "data.json", `{"a": 1}`);

    const yamlDocs = oqxRun(store, repoId, 'from docs where format == "yaml"');
    expect(yamlDocs.hits.length).toBe(1);
    expect(yamlDocs.hits[0]!.path).toBe("config.yaml");

    const jsonDocs = oqxRun(store, repoId, 'from docs where format == "json"');
    expect(jsonDocs.hits.length).toBe(1);
    expect(jsonDocs.hits[0]!.path).toBe("data.json");

    const mdDocs = oqxRun(store, repoId, 'from docs where format == "markdown"');
    expect(mdDocs.hits.length).toBe(1);
    expect(mdDocs.hits[0]!.path).toBe("readme.md");
  });

  it("queries by block kind across formats", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "readme.md", "# Hello\n\nParagraph.\n");
    ingestFile(store, repoId, "config.yaml", "key: value\n");

    const yamlBlocks = oqxRun(store, repoId, 'from blocks where type.startsWith("yaml:")');
    expect(yamlBlocks.hits.length).toBeGreaterThan(0);

    const headings = oqxRun(store, repoId, 'from blocks where type == "heading"');
    expect(headings.hits.length).toBe(1);
  });

  it("queries blocks by doc.format", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "readme.md", "# Hello\n");
    ingestFile(store, repoId, "config.yaml", "key: value\n");

    const yamlBlocks = oqxRun(store, repoId, 'from blocks where doc.format == "yaml"');
    expect(yamlBlocks.hits.length).toBeGreaterThan(0);
  });

  it("populates properties from YAML adapter extractMetadata", () => {
    const { store, repoId } = setup();
    const { docId } = ingestFile(store, repoId, "config.yaml", "database:\n  host: localhost\n  port: 5432\n");

    const props = docPropertiesMerged(store.db, docId);
    expect(props["database.host"]).toBe("localhost");
    expect(props["database.port"]).toBe(5432);
  });

  it("populates properties from JSON adapter extractMetadata", () => {
    const { store, repoId } = setup();
    const { docId } = ingestFile(store, repoId, "package.json", `{"name": "test", "version": "1.0.0"}`);

    const props = docPropertiesMerged(store.db, docId);
    expect(props.name).toBe("test");
    expect(props.version).toBe("1.0.0");
  });

  it("queries YAML document metadata with CEL filters", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "config.yaml", "database:\n  host: localhost\nlogging:\n  level: debug\n");
    ingestFile(store, repoId, "other.yaml", "database:\n  host: remote\nlogging:\n  level: info\n");

    const debugDocs = oqxRun(store, repoId, 'from docs where logging.level == "debug"');
    expect(debugDocs.hits.length).toBe(1);
    expect(debugDocs.hits[0]!.path).toBe("config.yaml");
  });

  it("queries JSON document metadata with CEL filters", () => {
    const { store, repoId } = setup();
    ingestFile(store, repoId, "a.json", `{"name": "alpha", "private": true}`);
    ingestFile(store, repoId, "b.json", `{"name": "beta", "private": false}`);

    const privateDocs = oqxRun(store, repoId, 'from docs where name == "alpha"');
    expect(privateDocs.hits.length).toBe(1);
    expect(privateDocs.hits[0]!.path).toBe("a.json");
  });
});
