import { FilterInvalid } from "../search/cel/parser.js";
import { CursorInvalid } from "../core/cursor.js";
import { MutationError } from "../mutate/tree.js";
import { RevisionNotFound } from "../graph/history.js";

// Error codes (06 §5). Shape: { error, message, data?, retriable }. Codes are
// stable; prose is free to improve. FilterInvalid from the query compiler maps
// to filter_invalid with its reason/hint in data.

export type ErrorCode =
  | "stale_expectation" | "parent_missing" | "target_missing" | "block_missing"
  | "doc_missing" | "cycle_move" | "opaque_block" | "not_contiguous"
  | "type_mismatch" | "conflicted_document" | "path_taken" | "create_conflict"
  | "ambiguous_locator" | "ambiguous_heading" | "filter_invalid" | "budget_exceeded"
  | "semantic_unavailable" | "embedder_failed" | "sync_conflict" | "repo_not_found" | "node_not_editable" | "seed_unresolved";

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

// ---- the one error → body mapping -------------------------------------------
//
// Every client of the engine renders a thrown error the same way (spec/surface
// §4's envelope; spec/cli §3.5): the MCP server's `fail` and the CLI's error
// renderer both call this, so a code can never differ between the two. Typed
// errors keep their code; the query layer's `FilterInvalid`/`CursorInvalid` are
// `filter_invalid`; a diff against an unknown revision is `target_missing`; and
// anything else — including a plain `Error` such as a write on a repo without a
// working tree — is the pinned catch-all `repo_not_found` (spec/surface §9).

/** The rendered body of any thrown error (`error` is the code). */
export interface ErrorBody {
  error: string;
  message: string;
  data?: unknown;
  retriable: boolean;
}

export function errorBody(err: unknown): ErrorBody {
  if (err instanceof EngineError) return { error: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}), retriable: err.retriable };
  if (err instanceof FilterInvalid) return { error: "filter_invalid", message: err.message, data: { reason: err.reason, hint: err.hint }, retriable: false };
  if (err instanceof CursorInvalid) return { error: "filter_invalid", message: err.message, data: { reason: `cursor was not issued by ${err.surface}`, hint: "resume only with a `cursor` returned by a truncated page of the same tool" }, retriable: false };
  if (err instanceof MutationError) return { error: err.code, message: err.message, data: err.data, retriable: Boolean((err.data as { retriable?: boolean }).retriable) };
  if (err instanceof RevisionNotFound) return { error: "target_missing", message: err.message, data: { doc: err.docId, rev: err.rev }, retriable: false };
  return { error: "repo_not_found", message: String(err), retriable: false };
}
