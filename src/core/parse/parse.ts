import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import type { Root, RootContent } from "mdast";
import type { BlockType, RawBlock } from "./types.js";

// Nodes whose children nest as blocks (03 §1: parser nesting only).
// Everything else at block level maps to a leaf block; unknown → opaque.
function mapType(node: RootContent): BlockType | null {
  switch (node.type) {
    case "yaml":
      return "frontmatter";
    case "heading":
      return "heading";
    case "paragraph":
      return "paragraph";
    case "list":
      return "list";
    case "listItem":
      return node.checked === null || node.checked === undefined ? "list_item" : "task";
    case "blockquote":
      return "blockquote";
    case "code":
      return "code_fence";
    case "table":
      return "table";
    case "tableRow":
      return "table_row";
    case "thematicBreak":
      return "thematic_break";
    case "html":
      return "html_block";
    default:
      return null; // opaque fallback
  }
}

function attrsFor(node: RootContent): Record<string, unknown> {
  switch (node.type) {
    case "heading":
      return { level: node.depth };
    case "list": {
      const attrs: Record<string, unknown> = { ordered: node.ordered ?? false };
      if (node.start !== null && node.start !== undefined) attrs.start = node.start;
      return attrs;
    }
    case "listItem":
      return node.checked === null || node.checked === undefined ? {} : { checked: node.checked };
    case "code": {
      const attrs: Record<string, unknown> = {};
      if (node.lang) attrs.lang = node.lang;
      if (node.meta) attrs.info = node.meta;
      return attrs;
    }
    default:
      return {};
  }
}

// Which mdast container types expose block-level children we descend into.
const CONTAINER_TYPES = new Set(["list", "listItem", "blockquote", "table"]);

function childrenOf(node: RootContent): RootContent[] {
  if (!CONTAINER_TYPES.has(node.type)) return [];
  const kids = (node as { children?: unknown }).children;
  return Array.isArray(kids) ? (kids as RootContent[]) : [];
}

function buildBlock(node: RootContent, source: string): RawBlock {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) {
    throw new Error(`node ${node.type} missing position offsets`);
  }
  const raw = source.slice(start, end);
  const mapped = mapType(node);
  const type: BlockType = mapped ?? "opaque";
  const children = mapped === null ? [] : childrenOf(node).map((c) => buildBlock(c, source));

  return {
    type,
    span: { start, end },
    raw,
    text: normalizeText(raw, type),
    attrs: mapped === null ? {} : attrsFor(node),
    children,
    trivia: "",
    anchors: [],
    outLinks: [],
  };
}

// Provisional normalization (02 §5.2) — refined in Stage 1. Strips the raw of
// per-line surrounding whitespace and collapses internal runs; drops blanks.
function normalizeText(raw: string, _type: BlockType): string {
  return raw
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "))
    .filter((line) => line.length > 0)
    .join(" ")
    .normalize("NFC");
}

/** Parse Markdown source into a flat list of top-level blocks with byte spans. */
export function parseBlocks(source: string): RawBlock[] {
  const tree: Root = fromMarkdown(source, {
    extensions: [gfm(), frontmatter(["yaml"])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml"])],
  });
  return tree.children.map((c) => buildBlock(c, source));
}
