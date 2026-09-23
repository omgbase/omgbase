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

/** A CLI-level usage error (bad flag, missing argument) → exit 2. An optional
 *  `hint` is a one-line pointer at the fix (e.g. "run 'omg --help' …"). */
export class CliUsageError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

// Per-command `--help` (11 §2.2). One shape for every command so the reader
// learns it once: a `name — summary` line, a `usage:` line (prefixed with the
// invoked binary name), then aligned `options:`, then any free-form notes
// (examples, sub-command tables). Help goes to stdout — it is the requested
// output — and never needs a workspace.

export interface HelpSpec {
  name: string;
  summary: string;
  /** Usage form(s) WITHOUT the program name (`cat <node…|-> [--resolution r]`). */
  usage: string | string[];
  /** `[flag, description]` rows; `-h, --help` is appended automatically. */
  options?: [string, string][];
  /** Extra lines printed verbatim under the options (examples, sub-commands). */
  notes?: string[];
}

interface HelpIO {
  io: IO;
  style: Style;
  prog: string;
}

export function renderHelp(cli: HelpIO, spec: HelpSpec): number {
  const { io, style, prog } = cli;
  io.out(`  ${style.bold(spec.name)} — ${spec.summary}`);
  const usages = Array.isArray(spec.usage) ? spec.usage : [spec.usage];
  usages.forEach((u, i) => io.out(`  ${style.dim(i === 0 ? "usage:" : "      ")} ${prog} ${u}`));
  const options: [string, string][] = [...(spec.options ?? []), ["-h, --help", "show this help"]];
  const width = Math.max(...options.map(([f]) => f.length));
  io.out(`  ${style.dim("options:")}`);
  for (const [flag, desc] of options) io.out(`    ${style.accent(flag.padEnd(width))}  ${desc}`);
  if (spec.notes && spec.notes.length > 0) {
    io.out("");
    for (const n of spec.notes) io.out(`  ${n}`);
  }
  return EXIT_OK;
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
    if (json) io.err(JSON.stringify({ error: "usage", message: err.message, ...(err.hint ? { hint: err.hint } : {}), retriable: false }));
    else {
      io.err(`${style.err("usage")}: ${err.message}`);
      if (err.hint) io.err(style.dim(`  hint: ${err.hint}`));
    }
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
