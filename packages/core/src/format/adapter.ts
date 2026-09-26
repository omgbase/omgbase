// Format adapter contract. Each format (markdown, yaml, json, …) implements
// this interface to participate in the omgbase versioned block graph.

import type { BlockTree, RawBlock, ExtractedLink } from "../core/parse/types.js";

export const enum AdapterCapability {
  Parse = "parse",
  Render = "render",
  ExtractEdges = "extract_edges",
  ProjectNodes = "project_nodes",
  ExtractMetadata = "extract_metadata",
  ComputeProperties = "compute_properties",
  StructuralMutation = "structural_mutation",
  SemanticChunking = "semantic_chunking",
}

export interface ProjectedNode {
  kind: string;
  name?: string | undefined;
  value?: string | undefined;
  blockId: string;
  /**
   * `[spanStart, spanEnd)` of the feature within the block's raw, as JavaScript
   * string indices (UTF-16 code units). Ingest converts to UTF-8 byte offsets
   * before the `nodes` row is written (spec/graph §2.3), and `node_set`
   * converts back before an editor slices the raw.
   */
  spanStart?: number | undefined;
  spanEnd?: number | undefined;
  attrs?: Record<string, unknown> | undefined;
}

export interface EmbeddingChunk {
  blockId: string;
  text: string;
  context?: string;
}

/** The block-scoped context an editable node property is rewritten against. */
export interface NodeEditContext {
  /** The block's current raw bytes (what the edit rewrites). */
  blockRaw: string;
  /** The node's span within blockRaw as string indices — the stored byte span converted back (null when unrecorded). */
  span: { start: number; end: number } | null;
  /** The node's current name/value/attrs, for editors that need them. */
  node: { kind: string; name?: string | undefined; value?: string | undefined; attrs: Record<string, unknown> };
}

/**
 * The result of a node-property edit: how it maps onto a block `update` op.
 * `markdown` replaces the block's bytes; `attrs` sets typed block attributes
 * (e.g. a task's `checked`). Editors return exactly one.
 */
export type NodeEditResult =
  | { markdown: string }
  | { attrs: Record<string, unknown> };

/** Rewrite one editable property of a node into a block update (node-editability). */
export type NodeEditor = (ctx: NodeEditContext, newValue: string) => NodeEditResult;

/**
 * Per-node-kind editable properties (node-editability). An adapter declares, for
 * a node kind, which properties can be set and how each compiles down to a block
 * `update` — so a caller edits a link's text or a task's checkbox surgically
 * while the write still goes through the block. Nodes stay read-only projections;
 * this is the affordance layer, not a second source of truth.
 */
export type NodeEditors = Record<string, Record<string, NodeEditor>>;

export interface ReconcileHints {
  anchorEvidenceKeys?: string[];
  smallBlockTokens?: number;
}

export interface AdapterEdge {
  srcBlock: string | null;
  srcField: string | null;
  predicate: string;
  dstKind: "document" | "block" | "external" | "collection";
  target: string;
  anchor: string | null;
  provenance: string;
}

export interface FormatAdapter {
  readonly format: string;
  readonly extensions: string[];
  readonly capabilities: ReadonlySet<AdapterCapability>;

  parse(source: string): BlockTree;
  render?(tree: BlockTree): string;
  extractEdges?(blocks: RawBlock[], metadata?: Record<string, unknown>): AdapterEdge[];
  projectNodes?(blocks: RawBlock[]): ProjectedNode[];
  extractMetadata?(source: string): Record<string, unknown> | null;
  /**
   * Computed properties (properties-table §4): engine-derived facts surfaced
   * as `$`-intrinsics ($title, $tags, ...), distinct from authored frontmatter/
   * inline keys. Each entry is a $-prefixed key mapped to a scalar or a list of
   * scalars. Stored as source='computed' property rows.
   */
  computeProperties?(blocks: RawBlock[], metadata: Record<string, unknown>): Record<string, unknown>;
  reconcileHints?(): ReconcileHints;
  chunkForEmbedding?(blocks: RawBlock[]): EmbeddingChunk[];
  /** Editable node properties, keyed by node kind then property (node-editability). */
  nodeEditors?: NodeEditors;
}

export type { BlockTree, RawBlock, ExtractedLink };
