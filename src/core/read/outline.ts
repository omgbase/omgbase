import type { Store } from "../store/store.js";
import { loadDocBlocks, type BlockNode } from "./reader.js";

// Outline wire format (06 §6, frozen). Each line:
//   <alias> <type-abbr> <label>            [§ for section-owning headings]
// Aliases (b01…) map to full ids in a trailing `ids` table to halve token cost.

const TYPE_ABBR: Record<string, string> = {
  heading: "h",
  paragraph: "p",
  list: "ul",
  list_item: "li",
  task: "li",
  blockquote: "bq",
  code_fence: "code",
  table: "tbl",
  table_row: "tr",
  thematic_break: "hr",
  html_block: "html",
  opaque: "raw",
};

function typeLabel(node: BlockNode): string {
  if (node.type === "heading") return `h${node.attrs.level ?? ""}`;
  return TYPE_ABBR[node.type] ?? node.type;
}

// Structural containers carry no label of their own; their content is in
// children (matches the frozen format example, 06 §6: `b03 ul` has no label).
const CONTAINER_TYPES = new Set(["list", "blockquote", "table"]);

function labelFor(node: BlockNode): string {
  if (CONTAINER_TYPES.has(node.type)) return "";
  if (node.type === "task") {
    const glyph = node.attrs.checked ? "☑" : "☐";
    return `${glyph} ${truncateWords(node.text, 10)}`;
  }
  return truncateWords(node.text, 10);
}

function truncateWords(text: string, n: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= n) return words.join(" ");
  return words.slice(0, n).join(" ") + "…";
}

export interface OutlineResult {
  text: string;
  ids: Record<string, string>; // alias → full id
  truncated: boolean;
}

export interface OutlineOptions {
  resolution?: "skeleton" | "outline";
  depth?: number;
  budgetTokens?: number;
}

/** Render a document outline in the frozen wire format. */
export function docsOutline(store: Store, docId: string, opts: OutlineOptions = {}): OutlineResult {
  const roots = loadDocBlocks(store, docId);
  const resolution = opts.resolution ?? "outline";
  const maxDepth = opts.depth ?? Infinity;
  const budget = opts.budgetTokens ?? Infinity;

  const ids: Record<string, string> = {};
  const lines: string[] = [];
  let alias = 0;
  let tokens = 0;
  let truncated = false;

  const walk = (nodes: BlockNode[], indent: number): void => {
    for (const node of nodes) {
      if (truncated) return;
      if (indent > maxDepth) continue;
      const aliasId = `b${String(++alias).padStart(2, "0")}`;
      ids[aliasId] = node.blockId;
      const pad = "  ".repeat(indent);
      const sectionMark = node.type === "heading" ? "  §" : "";
      const label = resolution === "skeleton" ? "" : labelFor(node);
      const line = `${pad}${aliasId} ${typeLabel(node).padEnd(4)} ${label}${sectionMark}`.trimEnd();

      const lineTokens = Math.ceil(line.length / 4);
      if (tokens + lineTokens > budget) {
        truncated = true;
        return;
      }
      tokens += lineTokens;
      lines.push(line);
      if (node.children.length > 0) walk(node.children, indent + 1);
    }
  };

  walk(roots, 0);
  return { text: lines.join("\n"), ids, truncated };
}
