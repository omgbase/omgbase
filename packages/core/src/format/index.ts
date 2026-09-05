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
export { markdownAdapter, MARKDOWN_FORMAT } from "./markdown.js";
export { yamlAdapter, YAML_FORMAT } from "./yaml.js";
export { jsonAdapter, JSON_FORMAT } from "./json.js";

// Register built-in adapters.
import { registerAdapter } from "./registry.js";
import { markdownAdapter } from "./markdown.js";
import { yamlAdapter } from "./yaml.js";
import { jsonAdapter } from "./json.js";
registerAdapter(markdownAdapter);
registerAdapter(yamlAdapter);
registerAdapter(jsonAdapter);
