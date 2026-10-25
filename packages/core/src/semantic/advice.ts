import { formatShare, shareOf } from "../core/store/size.js";

// The size report's vector lines (spec/store §7.5 — the `search` category has
// two owners: FTS is the core's, the vectors the semantic bundle's). The core's
// `sizeAdvice` takes these through `SemanticProvider.sizeAdvice`; a store
// without the module prints none.

/** The vectors' share of the database past which `doctor --size` advises (14.1). */
export const EMBEDDINGS_ADVICE_MIN_SHARE = 25;

export function vectorSizeAdvice(vectorBytes: number, totalBytes: number): string[] {
  const share = shareOf(vectorBytes, totalBytes);
  if (share <= EMBEDDINGS_ADVICE_MIN_SHARE) return [];
  return [`embeddings are ${formatShare(share)} of the database: a smaller model (\`embedding.model\` / \`embedding.dim\`) or \`omg embed drain --prune\` after a model switch shrinks them`];
}
