// Format adapter contract. Each format (markdown, yaml, json, …) implements
// this interface to participate in the omgbase versioned block graph.

import type { BlockTree, RawBlock, ExtractedLink } from "../core/parse/types.js";

export const enum AdapterCapability {
  Parse = "parse",
  Render = "render",
  ExtractEdges = "extract_edges",
  ProjectNodes = "project_nodes",
  ExtractMetadata = "extract_metadata",
  StructuralMutation = "structural_mutation",
  SemanticChunking = "semantic_chunking",
}

export interface ProjectedNode {
  kind: string;
  name?: string | undefined;
  value?: string | undefined;
  blockId: string;
  spanStart?: number | undefined;
  spanEnd?: number | undefined;
  attrs?: Record<string, unknown> | undefined;
}

export interface EmbeddingChunk {
  blockId: string;
  text: string;
  context?: string;
}

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
  reconcileHints?(): ReconcileHints;
  chunkForEmbedding?(blocks: RawBlock[]): EmbeddingChunk[];
}

export type { BlockTree, RawBlock, ExtractedLink };
