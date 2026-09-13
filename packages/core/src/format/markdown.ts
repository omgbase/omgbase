// Markdown format adapter — wraps existing parse/render/extract modules.

import { AdapterCapability, type FormatAdapter, type AdapterEdge, type ProjectedNode, type ReconcileHints, type NodeEditors } from "./adapter.js";
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
    // Walk every block (recursing into list/blockquote/table nesting) and scan
    // its raw for links. srcBlock is the block's OWN assigned id — the caller
    // passes id-assigned blocks (blockId zipped on), mirroring projectNodes; a
    // block-grain edge without it is useless, so fall back to "" only for the
    // pre-identity callers. extractFromBlock returns [] for link-free blocks, so
    // no per-block gate is needed (matches the non-adapter fallback path).
    const walk = (list: RawBlock[]): void => {
      for (const block of list) {
        for (const e of extractFromBlock(block.blockId ?? "", block.type, block.raw)) {
          edges.push(toAdapterEdge(e));
        }
        if (block.children.length > 0) walk(block.children);
      }
    };
    walk(blocks);
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
    // Byte span of a regex match within the block's raw bytes (node-locates the
    // feature inside its block; disambiguates multiple same-kind nodes — 13/nodes).
    const span = (m: RegExpMatchArray): { spanStart: number; spanEnd: number } => ({
      spanStart: m.index ?? 0,
      spanEnd: (m.index ?? 0) + m[0].length,
    });
    const walk = (list: RawBlock[], parentId: string): void => {
      for (const b of list) {
        // Anchor to the block's OWN assigned id (zipped on by ingest); fall back
        // to the parent's id, then "root", for pre-identity/parse-time callers.
        const id = b.blockId || parentId || "root";
        // Links: [text](target)
        for (const m of b.raw.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
          nodes.push({ kind: "md:link", name: m[1], value: m[2], blockId: id, ...span(m) });
        }
        // Wikilinks: [[target]]
        for (const m of b.raw.matchAll(/\[\[([^\]]+)\]\]/g)) {
          nodes.push({ kind: "md:wikilink", value: m[1], blockId: id, ...span(m) });
        }
        // Tasks: checkbox items (the whole block; span covers its raw)
        if (b.type === "task") {
          const checked = b.attrs.checked === true;
          nodes.push({ kind: "md:task", value: b.text, blockId: id, attrs: { checked }, spanStart: 0, spanEnd: b.raw.length });
        }
        // Anchors: ^ref
        const anchorRe = /\^([a-zA-Z0-9_-]+)/g;
        for (const m of b.raw.matchAll(anchorRe)) {
          nodes.push({ kind: "md:anchor", name: m[1], blockId: id, ...span(m) });
        }
        // Inline fields (dataview forms). Two shapes, so a multi-word value is
        // captured whole instead of truncated at the first space:
        //   line form  `key:: value`  — key at line start, value to end of line
        //   bracketed  `[key:: value]` / `(key:: value)` — value ends at closer
        // Bracketed matches first; the line form is anchored to a line start
        // (leading whitespace only), so a `[key:: …]`/`(key:: …)` sitting on its
        // own line is not double-counted (a bracket is not `[a-z]`).
        for (const m of b.raw.matchAll(/[[(]([a-z][a-z0-9_]*)::[ \t]*([^\]\n)]*?)[ \t]*[\])]/gi)) {
          nodes.push({ kind: "md:inline_field", name: m[1], value: m[2], blockId: id, ...span(m) });
        }
        for (const m of b.raw.matchAll(/^[ \t]*([a-z][a-z0-9_]*)::[ \t]*([^\n]*?)[ \t]*$/gim)) {
          const start = (m.index ?? 0) + (m[0].match(/^[ \t]*/)?.[0].length ?? 0);
          const end = (m.index ?? 0) + m[0].replace(/[ \t]+$/, "").length;
          nodes.push({ kind: "md:inline_field", name: m[1], value: m[2], blockId: id, spanStart: start, spanEnd: end });
        }
        if (b.children.length > 0) walk(b.children, id);
      }
    };
    walk(blocks, "");
    return nodes;
  },

  // Editable node properties (node-editability). Each editor rewrites ONLY the
  // node's own span within the block's raw bytes, then returns a block `update`
  // (markdown or attrs). The span pins the exact occurrence, so editing the
  // first of several same-kind nodes in one block is unambiguous.
  nodeEditors: {
    "md:link": {
      // Retype the link text: [OLD](target) → [NEW](target), this occurrence only.
      name: ({ blockRaw, span, node }, newValue) => {
        if (!span) throw new Error("md:link.name requires a recorded span");
        const seg = blockRaw.slice(span.start, span.end);
        const rebuilt = seg.replace(/^\[[^\]]*\]/, `[${newValue}]`);
        if (rebuilt === seg) throw new Error(`could not locate link text in ${JSON.stringify(seg)}`);
        void node;
        return { markdown: blockRaw.slice(0, span.start) + rebuilt + blockRaw.slice(span.end) };
      },
      // Retarget the link: [text](OLD) → [text](NEW), this occurrence only.
      value: ({ blockRaw, span }, newValue) => {
        if (!span) throw new Error("md:link.value requires a recorded span");
        const seg = blockRaw.slice(span.start, span.end);
        const rebuilt = seg.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)$/, (_m, _url, title) => `](${newValue}${title ?? ""})`);
        if (rebuilt === seg) throw new Error(`could not locate link target in ${JSON.stringify(seg)}`);
        return { markdown: blockRaw.slice(0, span.start) + rebuilt + blockRaw.slice(span.end) };
      },
    },
    "md:task": {
      // A task's checkbox is a typed block attribute, not a byte edit.
      checked: (_ctx, newValue) => ({ attrs: { checked: newValue === "true" || newValue === "1" } }),
    },
  } as NodeEditors,

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
