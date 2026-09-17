// OQX is now served by `@omgbase/oqx` (ADR-013). This module is a thin re-export
// of the store-backed engine in ../oqx-js so every caller and the corpus keep
// importing `../oqx/run.js` unchanged. The former in-tree compiler
// (lexer/parser/lower/ir/compile/relations/scalar) is superseded.
export {
  oqxRun, oqxRunAsync, collectSemanticPhrases, parseOqx,
  type OqxResult, type OqxHit, type OqxOptions, type EmbedQuery, type OqxConsumer,
} from "../oqx-js/run.js";
