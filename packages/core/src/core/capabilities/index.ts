export type {
  Capabilities, CapabilitiesFactory, HistoryRecorder, SemanticProvider, SemanticScorer, SemanticBlockRow, SemanticDrainOptions, SemanticFreshness, IdentityClaims,
  RevisionTransition, CapturedRevision, SemanticVec, BlockContextInput, BlockContextResolver,
} from "./types.js";
export { bindCapabilities, capabilitiesOf, requireHistory, requireSemantic, semanticOf, claimsOf } from "./registry.js";
export { defaultCapabilities, envCapabilities, CAPABILITIES_ENV } from "./default.js";
export { coreCapabilities } from "./core.js";
export {
  CapabilityUnavailable, SEMANTIC_DISABLED_MESSAGE, SEMANTIC_DISABLED_FIX, semanticUnavailableMessage,
  type CapabilityName, type CapabilityState,
} from "./errors.js";
export { HistoryRecorderImpl } from "./history.js";
export { SemanticProviderImpl } from "./semantic.js";
export { IdClaims, ID_TABLES, CLAIMED_PREFIXES, HOLDER_CORE, HOLDER_RECORDER, claimsRetainDays } from "./claims.js";
