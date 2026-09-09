// JSON format adapter. Decomposes JSON files into blocks with json:-prefixed
// kinds, extracts $ref/$schema edges, and projects the root object as metadata.
// Read-only: no StructuralMutation (JSON formatting is not reliably preserved).

import { AdapterCapability, type FormatAdapter, type AdapterEdge, type ProjectedNode } from "./adapter.js";
import type { BlockTree, RawBlock, BlockKind, Span } from "../core/parse/types.js";
import { normalizeText } from "../core/hash.js";

export const JSON_FORMAT = "json";

const K = {
  object: "json:object" as BlockKind,
  property: "json:property" as BlockKind,
  array: "json:array" as BlockKind,
  item: "json:item" as BlockKind,
  scalar: "json:scalar" as BlockKind,
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

// A simple JSON parser that tracks character positions of top-level and
// nested object properties/array items. We parse the JSON string ourselves
// rather than using JSON.parse because we need source spans.

interface JsonNode {
  kind: "object" | "array" | "string" | "number" | "boolean" | "null";
  start: number;
  end: number;
  key?: string | undefined;
  value?: unknown;
  children?: JsonNode[] | undefined;
}

function parseJsonStructure(source: string): JsonNode | null {
  let pos = 0;

  function skipWhitespace(): void {
    while (pos < source.length && /\s/.test(source[pos]!)) pos++;
  }

  function parseValue(): JsonNode | null {
    skipWhitespace();
    if (pos >= source.length) return null;
    const ch = source[pos]!;
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber();
    if (source.startsWith("true", pos)) { const n: JsonNode = { kind: "boolean", start: pos, end: pos + 4, value: true }; pos += 4; return n; }
    if (source.startsWith("false", pos)) { const n: JsonNode = { kind: "boolean", start: pos, end: pos + 5, value: false }; pos += 5; return n; }
    if (source.startsWith("null", pos)) { const n: JsonNode = { kind: "null", start: pos, end: pos + 4, value: null }; pos += 4; return n; }
    return null;
  }

  function parseString(): JsonNode {
    const start = pos;
    pos++; // skip opening "
    while (pos < source.length) {
      if (source[pos] === "\\") { pos += 2; continue; }
      if (source[pos] === '"') { pos++; break; }
      pos++;
    }
    const raw = source.slice(start, pos);
    let value: string;
    try { value = JSON.parse(raw) as string; } catch { value = raw.slice(1, -1); }
    return { kind: "string", start, end: pos, value };
  }

  function parseNumber(): JsonNode {
    const start = pos;
    if (source[pos] === "-") pos++;
    while (pos < source.length && source[pos]! >= "0" && source[pos]! <= "9") pos++;
    if (pos < source.length && source[pos] === ".") { pos++; while (pos < source.length && source[pos]! >= "0" && source[pos]! <= "9") pos++; }
    if (pos < source.length && (source[pos] === "e" || source[pos] === "E")) { pos++; if (pos < source.length && (source[pos] === "+" || source[pos] === "-")) pos++; while (pos < source.length && source[pos]! >= "0" && source[pos]! <= "9") pos++; }
    const value = Number(source.slice(start, pos));
    return { kind: "number", start, end: pos, value };
  }

  function parseObject(): JsonNode {
    const start = pos;
    pos++; // skip {
    const children: JsonNode[] = [];
    skipWhitespace();
    while (pos < source.length && source[pos] !== "}") {
      skipWhitespace();
      const keyNode = parseString();
      const key = keyNode.value as string;
      skipWhitespace();
      if (pos < source.length && source[pos] === ":") pos++;
      skipWhitespace();
      const propStart = keyNode.start;
      const val = parseValue();
      const propEnd = val ? val.end : pos;
      const child: JsonNode = {
        kind: "object",
        start: propStart,
        end: propEnd,
        key,
        value: val?.value,
        children: val?.children,
      };
      children.push(child);
      skipWhitespace();
      if (pos < source.length && source[pos] === ",") pos++;
    }
    if (pos < source.length) pos++; // skip }
    return { kind: "object", start, end: pos, children };
  }

  function parseArray(): JsonNode {
    const start = pos;
    pos++; // skip [
    const children: JsonNode[] = [];
    skipWhitespace();
    let index = 0;
    while (pos < source.length && source[pos] !== "]") {
      skipWhitespace();
      const val = parseValue();
      if (val) {
        val.key = String(index);
        children.push(val);
      }
      index++;
      skipWhitespace();
      if (pos < source.length && source[pos] === ",") pos++;
    }
    if (pos < source.length) pos++; // skip ]
    return { kind: "array", start, end: pos, children };
  }

  return parseValue();
}

function jsonNodeToBlocks(node: JsonNode, source: string): RawBlock[] {
  if (node.kind === "object" && node.children) {
    return node.children.map((child) => {
      const raw = source.slice(child.start, child.end);
      const block = emptyBlock(K.property, span(child.start, child.end), raw);
      block.attrs = { key: child.key ?? "" };
      if (child.children) {
        block.children = child.children.map((sub) => {
          const subRaw = source.slice(sub.start, sub.end);
          const subBlock = emptyBlock(
            sub.kind === "object" ? K.object :
            sub.kind === "array" ? K.array : K.scalar,
            span(sub.start, sub.end), subRaw,
          );
          subBlock.attrs = { key: sub.key ?? "" };
          return subBlock;
        });
      }
      return block;
    });
  }

  if (node.kind === "array" && node.children) {
    return node.children.map((child, i) => {
      const raw = source.slice(child.start, child.end);
      const block = emptyBlock(K.item, span(child.start, child.end), raw);
      block.attrs = { index: i };
      return block;
    });
  }

  // Scalar root: single block.
  return [emptyBlock(K.scalar, span(node.start, node.end), source.slice(node.start, node.end))];
}

function buildTree(source: string): BlockTree {
  const root = parseJsonStructure(source);
  if (!root) {
    // Unparseable: one opaque block.
    const block = emptyBlock("json:opaque" as BlockKind, span(0, source.length), source);
    return { source, leadingTrivia: "", children: [block] };
  }

  const children = jsonNodeToBlocks(root, source);
  const leadingTrivia = children.length === 0 ? source : source.slice(0, children[0]!.span.start);

  for (let i = 0; i < children.length; i++) {
    const block = children[i]!;
    const next = children[i + 1];
    const triviaEnd = next ? next.span.start : source.length;
    block.trivia = source.slice(block.span.end, triviaEnd);
  }

  return { source, leadingTrivia, children };
}

function isExternalUri(s: string): boolean {
  return /^https?:\/\//.test(s);
}

function extractJsonEdges(obj: unknown, parentKey: string, edges: AdapterEdge[], seen: Set<string>): void {
  function push(e: AdapterEdge): void {
    const k = `${e.predicate}|${e.target}|${e.provenance}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push(e);
  }

  if (typeof obj === "string") {
    if (parentKey === "$ref") {
      const target = obj.startsWith("#") ? "" : obj.split("#")[0]!;
      if (target) {
        push({
          srcBlock: null, srcField: "$ref", predicate: "references",
          dstKind: isExternalUri(target) ? "external" : "document",
          target, anchor: obj.includes("#") ? obj.split("#")[1]! : null,
          provenance: "json_ref",
        });
      }
    } else if (parentKey === "$schema") {
      push({
        srcBlock: null, srcField: "$schema", predicate: "schema",
        dstKind: isExternalUri(obj) ? "external" : "document",
        target: obj, anchor: null, provenance: "json_schema",
      });
    } else if ((obj.startsWith("./") || obj.startsWith("../") || obj.startsWith("/")) && !obj.includes(" ")) {
      push({
        srcBlock: null, srcField: parentKey, predicate: parentKey,
        dstKind: "document", target: obj, anchor: null, provenance: "json_ref",
      });
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) extractJsonEdges(item, parentKey, edges, seen);
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      extractJsonEdges(v, k, edges, seen);
    }
  }
}

export const jsonAdapter: FormatAdapter = {
  format: JSON_FORMAT,
  extensions: [".json"],
  capabilities: new Set([
    AdapterCapability.Parse,
    AdapterCapability.Render,
    AdapterCapability.ExtractEdges,
    AdapterCapability.ExtractMetadata,
    AdapterCapability.ProjectNodes,
    AdapterCapability.StructuralMutation,
  ]),

  parse(source: string): BlockTree {
    return buildTree(source);
  },

  render(tree: BlockTree): string {
    const out: string[] = [tree.leadingTrivia];
    for (const block of tree.children) {
      out.push(block.dirty ? block.raw : block.raw);
      out.push(block.trivia);
    }
    return out.join("");
  },

  projectNodes(blocks: RawBlock[]): ProjectedNode[] {
    const nodes: ProjectedNode[] = [];
    const walk = (list: RawBlock[]): void => {
      for (const b of list) {
        const key = b.attrs.key as string ?? "";
        const id = b.blockId ?? "";
        if (b.type === "json:property" && key === "$ref") {
          const val = b.text.replace(/^"[^"]*"\s*:\s*/, "").replace(/^"|"$/g, "").trim();
          nodes.push({ kind: "json:ref", name: "$ref", value: val, blockId: id });
        }
        if (b.type === "json:property" && key === "$schema") {
          const val = b.text.replace(/^"[^"]*"\s*:\s*/, "").replace(/^"|"$/g, "").trim();
          nodes.push({ kind: "json:schema", name: "$schema", value: val, blockId: id });
        }
        if (b.children.length > 0) walk(b.children);
      }
    };
    walk(blocks);
    return nodes;
  },

  extractEdges(_blocks: RawBlock[], metadata?: Record<string, unknown>): AdapterEdge[] {
    if (!metadata) return [];
    const edges: AdapterEdge[] = [];
    extractJsonEdges(metadata, "", edges, new Set());
    return edges;
  },

  extractMetadata(source: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(source) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  },
};
