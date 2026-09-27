// Format adapter system. Importing this module registers the built-in adapters.

export type {
  FormatAdapter,
  AdapterEdge,
  ProjectedNode,
  EmbeddingChunk,
  ReconcileHints,
} from "./adapter.js";
export { AdapterCapability } from "./adapter.js";
export {
  registerAdapter,
  adapterForFormat,
  adapterForPath,
  registeredFormats,
  detectFormat,
} from "./registry.js";
export { markdownAdapter, MARKDOWN_FORMAT, MARKDOWN_CONTAINER_KINDS } from "./markdown.js";
export { yamlAdapter, YAML_FORMAT } from "./yaml.js";
export { jsonAdapter, JSON_FORMAT } from "./json.js";

import { MARKDOWN_FORMAT, MARKDOWN_CONTAINER_KINDS } from "./markdown.js";

/**
 * May this block take children (spec/mutate §1.1)? Markdown decides by kind —
 * the parser only ever nests under `list`, `list_item`, `task`, `blockquote`
 * and `table`, so an empty `children` on a heading or paragraph is structural,
 * not "an empty container". The other formats have no kind table for this yet:
 * a block that has children is a container, a childless one a leaf.
 */
export function isContainerBlock(format: string, block: { type: string; children: readonly unknown[] }): boolean {
  if (format === MARKDOWN_FORMAT) return MARKDOWN_CONTAINER_KINDS.has(block.type);
  return block.children.length > 0;
}

// Register built-in adapters.
import { registerAdapter } from "./registry.js";
import { markdownAdapter } from "./markdown.js";
import { yamlAdapter } from "./yaml.js";
import { jsonAdapter } from "./json.js";
registerAdapter(markdownAdapter);
registerAdapter(yamlAdapter);
registerAdapter(jsonAdapter);
