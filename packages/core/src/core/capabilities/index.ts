export type {
  Capabilities, CapabilitiesFactory, HistoryRecorder, HistoryReader, HistoryProvider, HistoryProviderConfig, HistoryProviderAvailability, HistoryCheckpointResult, CommitRecord, SemanticProvider, SemanticScorer, SemanticBlockRow, SemanticDrainOptions, SemanticFreshness, IdentityClaims,
  RevisionTransition, CapturedRevision, RevisionQueryRow, SemanticVec, BlockContextInput, BlockContextResolver,
} from "./types.js";
export { bindCapabilities, capabilitiesOf, requireHistory, requireSemantic, semanticOf, claimsOf } from "./registry.js";
export { defaultCapabilities, historyCapabilities, semanticCapabilities, gitCapabilities, envCapabilities, envComposition, compositionCapabilities, compositionHasHistory, compositionHasSemantic, compositionHasGitProvider, CAPABILITIES_ENV, COMPOSITIONS, type Composition } from "./default.js";
export { registerHistoryProvider, unregisterHistoryProvider, registeredHistoryProviders, attachedProviders, type HistoryProviderFactory } from "./providers.js";
export { coreCapabilities } from "./core.js";
export {
  CapabilityUnavailable, SEMANTIC_DISABLED_MESSAGE, SEMANTIC_DISABLED_FIX, HISTORY_WRITER_REQUIRED_MESSAGE, HISTORY_UNAVAILABLE_MESSAGE, HISTORY_DISABLED_MESSAGE, semanticUnavailableMessage,
  historyProviderUnavailableMessage, historyUnsupportedMessage, historyProviderNotAttachedMessage, HISTORY_PROVIDER_UNAVAILABLE_ALERT,
  CaptureFailed, captureFailedMessage,
  type CapabilityName, type CapabilityState, type HistoryReadState,
} from "./errors.js";
export { HistoryRecorderImpl } from "./history.js";
export { SemanticProviderImpl } from "./semantic.js";
export { IdClaims, ID_TABLES, CLAIMED_PREFIXES, HOLDER_CORE, HOLDER_RECORDER, claimsRetainDays } from "./claims.js";
