import { FilterInvalid } from "../core/filter-invalid.js";
import { CursorInvalid } from "../core/cursor.js";
import { MutationError } from "../mutate/tree.js";
import { RevisionNotFound } from "../graph/history.js";
import { RevisionArchived } from "../core/store/archive.js";
import { WriterLockTimeout } from "../sync/writer-lock.js";
import { CapabilityUnavailable } from "../core/capabilities/errors.js";
import { ExpiredCursor } from "../core/store/feed.js";

// Error codes (06 §5). Shape: { error, message, data?, retriable }. Codes are
// stable; prose is free to improve. FilterInvalid from the query compiler maps
// to filter_invalid with its reason/hint in data.

export type ErrorCode =
  | "stale_expectation" | "parent_missing" | "target_missing" | "block_missing"
  | "doc_missing" | "cycle_move" | "opaque_block" | "not_contiguous"
  | "type_mismatch" | "conflicted_document" | "path_taken" | "create_conflict"
  | "ambiguous_locator" | "ambiguous_heading" | "filter_invalid" | "budget_exceeded"
  | "provider_unavailable" | "embedder_failed" | "sync_conflict" | "repo_not_found" | "node_not_editable" | "seed_unresolved"
  | "block_not_container"
  // spec/mutate §8 (2.3): the effect planner's and `execute`'s own codes
  | "stale_plan" | "plan_not_convergent" | "conflicting_effects" | "unsupported_plan_version" | "plan_mismatch"
  // spec/mutate §11.8 (3.1): the selector binding's codes
  | "ambiguous_target" | "selection_too_large"
  // spec/surface 4.9 / spec/store 15.0: a read of an archived revision whose segment is not attached or not on disk
  | "revision_archived"
  // spec/surface 5.1: `execute { plan_id }` alone names a plan this server does not remember
  | "plan_unknown"
  // modular-core Phase 2 (phase-1-contracts §2.1, D3): a capability the store does not run with — `data: { capability, state, fix? }`, retriable only for `unavailable`
  | "capability_unavailable"
  // spec/surface 6.0 / spec/store 17.0 (D7): a `changes_since` cursor the feed no longer serves — another epoch, past the head, behind the oldest retained row — `data: { epoch, oldest, head }`, never retriable: the consumer rescans (spec/sync §6)
  | "expired_cursor";

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
// `filter_invalid`; a diff against an unknown revision is `target_missing`; a
// read of an archived revision whose segment is unavailable is
// `revision_archived` (spec/surface 4.9); a
// writer-lock wait that ran out (spec/sync §7) is the catch-all `repo_not_found`
// too — the code the Rust host emits for it (`SurfaceError::other`) — carrying
// the lock's own message so both engines render the identical envelope; and
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
  if (err instanceof CapabilityUnavailable) return { error: "capability_unavailable", message: err.message, data: err.data(), retriable: err.retriable };
  if (err instanceof ExpiredCursor) return { error: "expired_cursor", message: err.message, data: err.data(), retriable: false };
  if (err instanceof FilterInvalid) return { error: "filter_invalid", message: err.message, data: { reason: err.reason, hint: err.hint, ...(err.fix !== undefined ? { fix: err.fix } : {}) }, retriable: false };
  if (err instanceof CursorInvalid) return { error: "filter_invalid", message: err.message, data: { reason: err.reason ?? `cursor was not issued by ${err.surface}`, hint: "resume only with a `cursor` returned by a truncated page of the same tool" }, retriable: false };
  if (err instanceof MutationError) return { error: err.code, message: err.message, data: err.data, retriable: Boolean((err.data as { retriable?: boolean }).retriable) };
  if (err instanceof RevisionNotFound) return { error: "target_missing", message: err.message, data: { doc: err.docId, rev: err.rev }, retriable: false };
  // spec/surface 4.9: `{ rev, archive, path? }` — `path` only when the segment is recorded (then it is the file that is not on disk).
  if (err instanceof RevisionArchived) return { error: "revision_archived", message: err.message, data: { rev: err.rev, archive: err.archive, ...(err.path !== null ? { path: err.path } : {}) }, retriable: false };
  if (err instanceof WriterLockTimeout) return { error: "repo_not_found", message: err.message, retriable: false };
  return { error: "repo_not_found", message: String(err), retriable: false };
}
