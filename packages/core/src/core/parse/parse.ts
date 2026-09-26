import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { frontmatter } from "micromark-extension-frontmatter";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import type { Root, RootContent } from "mdast";
import type { BlockType, RawBlock } from "./types.js";
import { childQuoteDepth, visibleText } from "../hash.js";

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

function isLineEnding(code: number): boolean {
  return code === 0x0a /* \n */ || code === 0x0d /* \r */;
}

// `quoteDepth` = number of blockquote ancestors, which the §4.1 text rule needs
// because a nested block's raw keeps the `> ` prefixes of its continuation lines.
function buildBlock(node: RootContent, source: string, shift: number, quoteDepth: number): RawBlock {
  const rawStart = node.position?.start.offset;
  const rawEnd = node.position?.end.offset;
  if (rawStart === undefined || rawEnd === undefined) {
    throw new Error(`node ${node.type} missing position offsets`);
  }
  const start = rawStart + shift;
  let end = rawEnd + shift;
  // Spans exclude the terminating line ending (spec/format §1 inv. 4). micromark
  // already ends most blocks before it, but a construct that runs to EOF without
  // a closer (an unclosed fence, an unclosed HTML comment, and the list items
  // holding one) is handed every trailing line ending, blank lines included.
  // Those bytes belong to the trivia that follows the block.
  while (end > start && isLineEnding(source.charCodeAt(end - 1))) end--;
  const raw = source.slice(start, end);
  const mapped = mapType(node);
  const type: BlockType = mapped ?? "opaque";
  let children =
    mapped === null ? [] : childrenOf(node).map((c) => buildBlock(c, source, shift, childQuoteDepth(type, quoteDepth)));

  // Fold a tight list item's lone paragraph: the item block carries the text
  // directly (frozen outline format, 06 §6). Loose/multi-block items keep them.
  if ((type === "list_item" || type === "task") && children.length === 1 && children[0]!.type === "paragraph") {
    children = [];
  }

  return {
    type,
    span: { start, end },
    raw,
    text: visibleText({ type, raw, children }, quoteDepth),
    attrs: mapped === null ? {} : attrsFor(node),
    children,
    trivia: "",
    anchors: [],
    outLinks: [],
  };
}

// micromark's preprocessor (micromark/lib/preprocess.js) drops exactly one
// leading U+FEFF before tokenizing and never emits it as a chunk, so every
// position it reports is an index into the stripped string. Spans must index
// the true source (spec/format §1 inv. 6: the BOM is leading trivia), so all
// offsets move by one code unit when — and only when — the source starts with
// a BOM. A second BOM, or one anywhere else, is ordinary content and unshifted.
const BOM = 0xfeff;

/** Parse Markdown source into a flat list of top-level blocks with spans into `source`. */
export function parseBlocks(source: string): RawBlock[] {
  const tree: Root = fromMarkdown(source, {
    extensions: [gfm(), frontmatter(["yaml"])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml"])],
  });
  const shift = source.charCodeAt(0) === BOM ? 1 : 0;
  return tree.children.map((c) => buildBlock(c, source, shift, 0));
}
