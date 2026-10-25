export type {
  Capabilities, CapabilitiesFactory, HistoryRecorder, SemanticProvider, IdentityClaims,
  RevisionTransition, CapturedRevision, SemanticVec, BlockContextInput, BlockContextResolver,
} from "./types.js";
export { bindCapabilities, capabilitiesOf, requireHistory, semanticOf } from "./registry.js";
export { defaultCapabilities } from "./default.js";
export { HistoryRecorderImpl } from "./history.js";
export { SemanticProviderImpl } from "./semantic.js";
export { TableUnionClaims, ID_TABLES } from "./claims.js";
