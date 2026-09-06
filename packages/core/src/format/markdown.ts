// Markdown format adapter — wraps existing parse/render/extract modules.

import { AdapterCapability, type FormatAdapter, type AdapterEdge, type ProjectedNode, type ReconcileHints } from "./adapter.js";
import type { BlockTree, RawBlock } from "../core/parse/types.js";
import { parseTree, assertFullCoverage } from "../core/parse/tree.js";
import { render } from "../core/parse/render.js";
import { extractFromBlock, extractFromFrontmatter, type ExtractedEdge } from "../graph/extract.js";
import { parse as parseYaml } from "yaml";

export const MARKDOWN_FORMAT = "markdown";

function toAdapterEdge(e: ExtractedEdge): AdapterEdge {
  return {
    srcBlock: e.srcBlock,
    srcField: e.srcField,
    predicate: e.predicate,
    dstKind: e.dstKind,
    target: e.target,
    anchor: e.anchor,
    provenance: e.provenance,
  };
}

export const markdownAdapter: FormatAdapter = {
  format: MARKDOWN_FORMAT,
  extensions: [".md", ".markdown"],
  capabilities: new Set([
    AdapterCapability.Parse,
    AdapterCapability.Render,
    AdapterCapability.ExtractEdges,
    AdapterCapability.ExtractMetadata,
    AdapterCapability.ComputeProperties,
    AdapterCapability.StructuralMutation,
    AdapterCapability.ProjectNodes,
  ]),

  parse(source: string): BlockTree {
    return parseTree(source);
  },

  render(tree: BlockTree): string {
    return render(tree);
  },

  extractEdges(blocks: RawBlock[], metadata?: Record<string, unknown>): AdapterEdge[] {
    const edges: AdapterEdge[] = [];
    for (const block of blocks) {
      if (!block.outLinks) continue;
      const blockEdges = extractFromBlock(
        "", // srcBlock id filled in by the caller after id assignment
        block.type,
        block.raw,
      );
      for (const e of blockEdges) edges.push(toAdapterEdge(e));
    }
    if (metadata) {
      for (const e of extractFromFrontmatter(metadata)) edges.push(toAdapterEdge(e));
    }
    return edges;
  },

  extractMetadata(source: string): Record<string, unknown> | null {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (!match) return null;
    try {
      const parsed = parseYaml(match[1]!) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  },

  projectNodes(blocks: RawBlock[]): ProjectedNode[] {
    const nodes: ProjectedNode[] = [];
    const walk = (list: RawBlock[], blockId: string): void => {
      for (const b of list) {
        const id = blockId || "root";
        // Links: [text](target)
        for (const m of b.raw.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
          nodes.push({ kind: "md:link", name: m[1], value: m[2], blockId: id });
        }
        // Wikilinks: [[target]]
        for (const m of b.raw.matchAll(/\[\[([^\]]+)\]\]/g)) {
          nodes.push({ kind: "md:wikilink", value: m[1], blockId: id });
        }
        // Tasks: checkbox items
        if (b.type === "task") {
          const checked = b.attrs.checked === true;
          nodes.push({ kind: "md:task", value: b.text, blockId: id, attrs: { checked } });
        }
        // Anchors: ^ref
        const anchorRe = /\^([a-zA-Z0-9_-]+)/g;
        for (const m of b.raw.matchAll(anchorRe)) {
          nodes.push({ kind: "md:anchor", name: m[1], blockId: id });
        }
        // Inline fields: key:: value
        for (const m of b.raw.matchAll(/(?:^|\s)([a-z][a-z0-9_]*)::\s*(\S+)/gi)) {
          nodes.push({ kind: "md:inline_field", name: m[1], value: m[2], blockId: id });
        }
        if (b.children.length > 0) walk(b.children, id);
      }
    };
    walk(blocks, "");
    return nodes;
  },

  // Computed properties surfaced as $-intrinsics (12 §4). These are engine-
  // derived and never claim the authored `title`/`tags` keys.
  //   $title — text of the first level-1 heading
  //   $tags  — distinct #hashtags found in body text (order-preserving)
  computeProperties(blocks: RawBlock[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};

    const findH1 = (list: RawBlock[]): string | undefined => {
      for (const b of list) {
        if (b.type === "heading" && b.attrs.level === 1 && b.text.trim()) return b.text.trim();
        const nested = findH1(b.children);
        if (nested) return nested;
      }
      return undefined;
    };
    const title = findH1(blocks);
    if (title) out.$title = title;

    const tags: string[] = [];
    const seen = new Set<string>();
    const scan = (list: RawBlock[]): void => {
      for (const b of list) {
        // #tag — a hash followed by a word char, not inside a heading marker or
        // a code fence. Matches Obsidian-style inline tags in prose.
        if (b.type !== "heading" && b.type !== "code_fence") {
          for (const m of b.raw.matchAll(/(?:^|\s)#([a-zA-Z][\w/-]*)/g)) {
            const t = m[1]!;
            if (!seen.has(t)) { seen.add(t); tags.push(t); }
          }
        }
        scan(b.children);
      }
    };
    scan(blocks);
    if (tags.length > 0) out.$tags = tags;

    return out;
  },

  reconcileHints(): ReconcileHints {
    return {
      anchorEvidenceKeys: ["lang", "info"],
      smallBlockTokens: 8,
    };
  },
};

export { assertFullCoverage };
