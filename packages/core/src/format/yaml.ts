// YAML format adapter. Decomposes YAML files into blocks with yaml:-prefixed
// kinds, extracts $ref/extends/$schema edges, and projects top-level mapping
// entries as metadata.

import {
  parseDocument,
  isMap,
  isSeq,
  isScalar,
  type Document,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
  type Scalar,
} from "yaml";
import { AdapterCapability, type FormatAdapter, type AdapterEdge, type ProjectedNode } from "./adapter.js";
import type { BlockTree, RawBlock, BlockKind, Span } from "../core/parse/types.js";
import { normalizeText } from "../core/hash.js";

export const YAML_FORMAT = "yaml";

// Block kinds for YAML structures.
const K = {
  document: "yaml:document" as BlockKind,
  mapping: "yaml:mapping" as BlockKind,
  mapping_entry: "yaml:mapping_entry" as BlockKind,
  sequence: "yaml:sequence" as BlockKind,
  sequence_item: "yaml:sequence_item" as BlockKind,
  scalar: "yaml:scalar" as BlockKind,
  comment: "yaml:comment" as BlockKind,
} as const;

function span(start: number, end: number): Span {
  return { start, end };
}

function emptyBlock(kind: BlockKind, s: Span, raw: string): RawBlock {
  return {
    type: kind,
    span: s,
    raw,
    text: normalizeText(raw),
    attrs: {},
    children: [],
    trivia: "",
    anchors: [],
    outLinks: [],
  };
}

// Build a block from a Pair (key: value mapping entry).
function blockFromPair(pair: Pair, source: string, depth: number): RawBlock | null {
  const keyNode = pair.key;
  const valNode = pair.value;

  // Determine the span covering the full pair (key + value).
  let start = Infinity;
  let end = 0;
  for (const n of [keyNode, valNode]) {
    if (n && isScalar(n) && n.range) {
      start = Math.min(start, n.range[0]);
      end = Math.max(end, n.range[2] ?? n.range[1]);
    } else if (n && (isMap(n) || isSeq(n)) && n.range) {
      start = Math.min(start, n.range[0]);
      end = Math.max(end, n.range[2] ?? n.range[1]);
    }
  }
  // If we can't determine span (shouldn't happen with parsed YAML), skip.
  if (!isFinite(start) || end === 0) return null;

  const raw = source.slice(start, end);
  const keyStr = isScalar(keyNode) ? String(keyNode.value) : "";
  const attrs: Record<string, unknown> = { key: keyStr };

  const children: RawBlock[] = [];

  // Recurse into nested maps/seqs as child blocks.
  if (isMap(valNode)) {
    for (const item of valNode.items) {
      const child = blockFromPair(item, source, depth + 1);
      if (child) children.push(child);
    }
  } else if (isSeq(valNode)) {
    for (let i = 0; i < valNode.items.length; i++) {
      const item = valNode.items[i]!;
      if (isScalar(item) && item.range) {
        const iStart = item.range[0];
        const iEnd = item.range[2] ?? item.range[1];
        const iRaw = source.slice(iStart, iEnd);
        const child = emptyBlock(K.sequence_item, span(iStart, iEnd), iRaw);
        child.attrs = { index: i, value: item.value };
        children.push(child);
      } else if (isMap(item) && item.range) {
        const iStart = item.range[0];
        const iEnd = item.range[2] ?? item.range[1];
        const iRaw = source.slice(iStart, iEnd);
        const child = emptyBlock(K.mapping, span(iStart, iEnd), iRaw);
        for (const sub of item.items) {
          const subBlock = blockFromPair(sub, source, depth + 2);
          if (subBlock) child.children.push(subBlock);
        }
        children.push(child);
      } else if (isSeq(item) && item.range) {
        const iStart = item.range[0];
        const iEnd = item.range[2] ?? item.range[1];
        const iRaw = source.slice(iStart, iEnd);
        const child = emptyBlock(K.sequence, span(iStart, iEnd), iRaw);
        children.push(child);
      }
    }
  }

  const block = emptyBlock(K.mapping_entry, span(start, end), raw);
  block.attrs = attrs;
  block.children = children;
  return block;
}

function parseYamlBlocks(source: string): RawBlock[] {
  let doc: Document;
  try {
    doc = parseDocument(source, { keepSourceTokens: true });
  } catch {
    // Malformed YAML: return a single opaque block.
    return [emptyBlock("yaml:opaque" as BlockKind, span(0, source.length), source)];
  }

  const contents = doc.contents;
  if (!contents) {
    return source.trim().length > 0
      ? [emptyBlock(K.scalar, span(0, source.length), source)]
      : [];
  }

  const blocks: RawBlock[] = [];

  if (isMap(contents)) {
    for (const pair of contents.items) {
      const block = blockFromPair(pair, source, 0);
      if (block) blocks.push(block);
    }
  } else if (isSeq(contents)) {
    for (let i = 0; i < contents.items.length; i++) {
      const item = contents.items[i]!;
      if (isScalar(item) && item.range) {
        const start = item.range[0];
        const end = item.range[2] ?? item.range[1];
        const block = emptyBlock(K.sequence_item, span(start, end), source.slice(start, end));
        block.attrs = { index: i, value: item.value };
        blocks.push(block);
      } else if (isMap(item) && item.range) {
        const start = item.range[0];
        const end = item.range[2] ?? item.range[1];
        const block = emptyBlock(K.mapping, span(start, end), source.slice(start, end));
        for (const sub of item.items) {
          const child = blockFromPair(sub, source, 1);
          if (child) block.children.push(child);
        }
        blocks.push(block);
      }
    }
  } else if (isScalar(contents) && contents.range) {
    const start = contents.range[0];
    const end = contents.range[2] ?? contents.range[1];
    blocks.push(emptyBlock(K.scalar, span(start, end), source.slice(start, end)));
  }

  return blocks;
}

// Attach trivia (inter-block whitespace) to blocks, same algorithm as markdown.
function buildTree(source: string): BlockTree {
  const children = parseYamlBlocks(source);
  const leadingTrivia = children.length === 0 ? source : source.slice(0, children[0]!.span.start);

  for (let i = 0; i < children.length; i++) {
    const block = children[i]!;
    const next = children[i + 1];
    const triviaEnd = next ? next.span.start : source.length;
    block.trivia = source.slice(block.span.end, triviaEnd);
  }

  return { source, leadingTrivia, children };
}

// Edge extraction: $ref, extends, $schema, and path-like string values.
function extractYamlEdges(source: string): AdapterEdge[] {
  let doc: Document;
  try {
    doc = parseDocument(source);
  } catch {
    return [];
  }
  const edges: AdapterEdge[] = [];
  const seen = new Set<string>();

  function push(e: AdapterEdge): void {
    const k = `${e.predicate}|${e.target}|${e.provenance}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push(e);
  }

  function walkValue(key: string, value: unknown): void {
    if (typeof value !== "string") return;

    if (key === "$ref" || key === "\\$ref") {
      const target = value.startsWith("#") ? "" : value.split("#")[0]!;
      if (target) {
        push({
          srcBlock: null,
          srcField: "$ref",
          predicate: "references",
          dstKind: isExternalUri(target) ? "external" : "document",
          target,
          anchor: value.includes("#") ? value.split("#")[1]! : null,
          provenance: "yaml_ref",
        });
      }
      return;
    }

    if (key === "$schema") {
      push({
        srcBlock: null,
        srcField: "$schema",
        predicate: "schema",
        dstKind: isExternalUri(value) ? "external" : "document",
        target: value,
        anchor: null,
        provenance: "yaml_schema",
      });
      return;
    }

    if (key === "extends") {
      push({
        srcBlock: null,
        srcField: "extends",
        predicate: "extends",
        dstKind: isExternalUri(value) ? "external" : "document",
        target: value,
        anchor: null,
        provenance: "yaml_extends",
      });
      return;
    }

    // Path-like string values: ./path or /path (not URLs, not bare words).
    if ((value.startsWith("./") || value.startsWith("../") || value.startsWith("/")) && !value.includes(" ")) {
      push({
        srcBlock: null,
        srcField: key,
        predicate: key,
        dstKind: "document",
        target: value,
        anchor: null,
        provenance: "yaml_ref",
      });
    }
  }

  function walkNode(node: unknown, parentKey: string): void {
    if (isMap(node)) {
      for (const pair of (node as YAMLMap).items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : parentKey;
        if (isScalar(pair.value)) {
          walkValue(key, pair.value.value);
        } else {
          walkNode(pair.value, key);
        }
      }
    } else if (isSeq(node)) {
      for (const item of (node as YAMLSeq).items) {
        if (isScalar(item)) {
          walkValue(parentKey, (item as Scalar).value);
        } else {
          walkNode(item, parentKey);
        }
      }
    }
  }

  walkNode(doc.contents, "");
  return edges;
}

function isExternalUri(s: string): boolean {
  return /^https?:\/\//.test(s);
}

export const yamlAdapter: FormatAdapter = {
  format: YAML_FORMAT,
  extensions: [".yaml", ".yml"],
  capabilities: new Set([
    AdapterCapability.Parse,
    AdapterCapability.Render,
    AdapterCapability.ExtractEdges,
    AdapterCapability.ExtractMetadata,
    AdapterCapability.ProjectNodes,
  ]),

  parse(source: string): BlockTree {
    return buildTree(source);
  },

  render(tree: BlockTree): string {
    // Splice renderer: untouched blocks emit raw verbatim, preserving comments
    // and formatting. Same strategy as the markdown adapter.
    const out: string[] = [tree.leadingTrivia];
    for (const block of tree.children) {
      out.push(block.raw);
      out.push(block.trivia);
    }
    return out.join("");
  },

  extractEdges(_blocks: RawBlock[], metadata?: Record<string, unknown>): AdapterEdge[] {
    // YAML edge extraction works from the parsed document, not individual blocks,
    // since references can appear at any nesting depth. We re-extract from the
    // full source stored in blocks[0]'s parent tree, but since we receive
    // metadata (the parsed top-level mapping), we walk that instead.
    if (!metadata) return [];
    // Walk the metadata object for edges. For full extraction we'd need the
    // source, so we implement a lightweight object-walking extractor here.
    const edges: AdapterEdge[] = [];
    const seen = new Set<string>();

    function push(e: AdapterEdge): void {
      const k = `${e.predicate}|${e.target}|${e.provenance}`;
      if (seen.has(k)) return;
      seen.add(k);
      edges.push(e);
    }

    function walk(obj: unknown, parentKey: string): void {
      if (typeof obj === "string") {
        walkStringValue(parentKey, obj, push);
      } else if (Array.isArray(obj)) {
        for (const item of obj) walk(item, parentKey);
      } else if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          walk(v, k);
        }
      }
    }

    walk(metadata, "");
    return edges;
  },

  projectNodes(blocks: RawBlock[]): ProjectedNode[] {
    const nodes: ProjectedNode[] = [];
    const walk = (list: RawBlock[]): void => {
      for (const b of list) {
        const id = b.type === "yaml:mapping_entry" ? (b.attrs.key as string ?? "") : "";
        // $ref values
        if (b.type === "yaml:mapping_entry" && b.attrs.key === "$ref") {
          const val = b.raw.replace(/^[^:]*:\s*/, "").trim();
          nodes.push({ kind: "yaml:ref", name: "$ref", value: val, blockId: id });
        }
        // $schema values
        if (b.type === "yaml:mapping_entry" && b.attrs.key === "$schema") {
          const val = b.raw.replace(/^[^:]*:\s*/, "").trim();
          nodes.push({ kind: "yaml:schema", name: "$schema", value: val, blockId: id });
        }
        // YAML anchors &name
        for (const m of b.raw.matchAll(/&([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
          nodes.push({ kind: "yaml:anchor", name: m[1], blockId: id });
        }
        // YAML aliases *name
        for (const m of b.raw.matchAll(/\*([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
          nodes.push({ kind: "yaml:alias", name: m[1], blockId: id });
        }
        // Environment variable references ${VAR}
        for (const m of b.raw.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
          nodes.push({ kind: "yaml:env_var", name: m[1], blockId: id });
        }
        if (b.children.length > 0) walk(b.children);
      }
    };
    walk(blocks);
    return nodes;
  },

  extractMetadata(source: string): Record<string, unknown> | null {
    try {
      const doc = parseDocument(source);
      const obj = doc.toJS() as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  },
};

function walkStringValue(key: string, value: string, push: (e: AdapterEdge) => void): void {
  if (key === "$ref") {
    const target = value.startsWith("#") ? "" : value.split("#")[0]!;
    if (target) {
      push({
        srcBlock: null, srcField: "$ref", predicate: "references",
        dstKind: isExternalUri(target) ? "external" : "document",
        target, anchor: value.includes("#") ? value.split("#")[1]! : null,
        provenance: "yaml_ref",
      });
    }
    return;
  }
  if (key === "$schema") {
    push({
      srcBlock: null, srcField: "$schema", predicate: "schema",
      dstKind: isExternalUri(value) ? "external" : "document",
      target: value, anchor: null, provenance: "yaml_schema",
    });
    return;
  }
  if (key === "extends") {
    push({
      srcBlock: null, srcField: "extends", predicate: "extends",
      dstKind: isExternalUri(value) ? "external" : "document",
      target: value, anchor: null, provenance: "yaml_extends",
    });
    return;
  }
  if ((value.startsWith("./") || value.startsWith("../") || value.startsWith("/")) && !value.includes(" ")) {
    push({
      srcBlock: null, srcField: key, predicate: key,
      dstKind: "document", target: value, anchor: null, provenance: "yaml_ref",
    });
  }
}

// Also export the standalone source-based extractor for direct use.
export { extractYamlEdges };
