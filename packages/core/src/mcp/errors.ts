// Error codes (06 §5). Shape: { error, message, data?, retriable }. Codes are
// stable; prose is free to improve. FilterInvalid from the query compiler maps
// to filter_invalid with its reason/hint in data.

export type ErrorCode =
  | "stale_expectation" | "parent_missing" | "target_missing" | "block_missing"
  | "doc_missing" | "cycle_move" | "opaque_block" | "not_contiguous"
  | "type_mismatch" | "conflicted_document" | "path_taken" | "create_conflict"
  | "ambiguous_locator" | "ambiguous_heading" | "filter_invalid" | "budget_exceeded"
  | "semantic_unavailable" | "sync_conflict" | "repo_not_found" | "node_not_editable";

export interface EngineErrorBody {
  error: ErrorCode;
  message: string;
  data?: unknown;
  retriable: boolean;
}

export class EngineError extends Error {
  code: ErrorCode;
  data: unknown;
  retriable: boolean;
  constructor(code: ErrorCode, message: string, opts: { data?: unknown; retriable?: boolean } = {}) {
    super(message);
    this.code = code;
    this.data = opts.data;
    this.retriable = opts.retriable ?? false;
  }
  body(): EngineErrorBody {
    return { error: this.code, message: this.message, data: this.data, retriable: this.retriable };
  }
}
