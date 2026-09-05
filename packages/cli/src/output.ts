import type { IO } from "./render.js";
import type { Style } from "./style.js";

// Output contract + error rendering (11 §2.4, §4).
//
// Exit codes:  0 success (incl. truncated)  ·  1 typed engine error / conflict
//              2 CLI usage error (unknown flag, missing arg)
//
// Errors always go to stderr. Human form: `error[code]: message` + any
// current-truth payload pretty-printed. With --json: the typed error object as
// JSON on stderr, nothing on stdout.

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

/** A CLI-level usage error (bad flag, missing argument) → exit 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/**
 * An engine-style typed error the CLI raises directly (mirrors core's
 * EngineError body shape, 06 §5) — used for repo_not_found, ambiguous repo,
 * etc., that originate in the CLI layer rather than the engine.
 */
export class EngineErrorLike extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: { data?: unknown; hint?: string; retriable?: boolean } = {},
  ) {
    super(message);
    this.name = "EngineErrorLike";
  }
  body(): { error: string; message: string; data?: unknown; retriable: boolean } {
    return {
      error: this.code,
      message: this.message,
      ...(this.extra.data !== undefined ? { data: this.extra.data } : {}),
      retriable: this.extra.retriable ?? false,
    };
  }
}

interface ErrorBodyLike {
  error?: string;
  code?: string;
  message?: string;
  data?: unknown;
  retriable?: boolean;
  hint?: string;
}

/** Coerce any thrown value into a typed error body for rendering. */
function toBody(err: unknown): { code: string; message: string; data?: unknown; hint?: string } {
  if (err instanceof EngineErrorLike) {
    const b = err.body();
    return {
      code: b.error,
      message: b.message,
      ...(b.data !== undefined ? { data: b.data } : {}),
      ...(err.extra.hint ? { hint: err.extra.hint } : {}),
    };
  }
  // core EngineError / MutationError / FilterInvalid all carry a code + message
  // (and often a body()); duck-type them.
  const anyErr = err as { code?: string; message?: string; data?: unknown; body?: () => ErrorBodyLike; reason?: string; hint?: string };
  if (typeof anyErr?.body === "function") {
    const b = anyErr.body();
    return { code: b.error ?? b.code ?? "error", message: b.message ?? String(err), data: b.data };
  }
  if (anyErr?.code) {
    return {
      code: anyErr.code,
      message: anyErr.message ?? String(err),
      ...(anyErr.data !== undefined ? { data: anyErr.data } : {}),
      ...(anyErr.hint ? { hint: anyErr.hint } : {}),
    };
  }
  return { code: "error", message: anyErr?.message ?? String(err) };
}

/**
 * Render a thrown error to stderr and return the process exit code. `json`
 * selects machine output (typed object); otherwise the human form with any
 * current-truth payload pretty-printed.
 */
export function renderError(err: unknown, io: IO, style: Style, json: boolean): number {
  if (err instanceof CliUsageError) {
    if (json) io.err(JSON.stringify({ error: "usage", message: err.message, retriable: false }));
    else io.err(`${style.err("usage")}: ${err.message}`);
    return EXIT_USAGE;
  }

  const body = toBody(err);
  if (json) {
    io.err(JSON.stringify({ error: body.code, message: body.message, ...(body.data !== undefined ? { data: body.data } : {}), retriable: false }));
    return EXIT_ERROR;
  }

  io.err(`${style.err(`error[${body.code}]`)}: ${body.message}`);
  if (body.hint) io.err(style.dim(`  hint: ${body.hint}`));
  // Conflict objects carry current truth (04 §4) — print all of it; the retry
  // is built from it.
  if (body.data !== undefined && body.data !== null) {
    io.err(style.dim(indent(JSON.stringify(body.data, null, 2), "  ")));
  }
  return EXIT_ERROR;
}

function indent(s: string, pad: string): string {
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

/** Loud truncation footer to stderr (§4.4). Exit code stays 0. */
export function truncationFooter(io: IO, style: Style, cursor: number | string): void {
  io.err(style.dim(`… truncated; continue with --cursor ${cursor}`));
}
