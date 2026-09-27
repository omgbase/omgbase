import { errorBody } from "@omgbase/core";
import { columns, visibleWidth, type IO } from "./render.js";
import type { Style } from "./style.js";
import type { OutputMode } from "./context.js";

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

/**
 * Node's `parseArgs` failures are the user's mistake, not the engine's (spec/cli
 * §2.2): an option the command does not declare, a value-taking option without
 * its value, a boolean given one. Each becomes a usage error with a portable
 * message — the wording is ours, so a port need not reproduce Node's — and the
 * hint points at the command's card. Anything else is returned untouched.
 */
export function usageFromParseArgs(err: unknown, prog: string, command: string): unknown {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object" || typeof e.code !== "string" || !e.code.startsWith("ERR_PARSE_ARGS_") || typeof e.message !== "string") return err;
  const hint = `run '${prog} ${command} --help' for the options`;
  const unknown = /^Unknown option '([^']+)'/.exec(e.message);
  if (unknown) return new CliUsageError(`unknown option '${unknown[1]}'`, hint);
  const missing = /^Option '([^']+?)(?: <value>)?' argument missing/.exec(e.message);
  if (missing) return new CliUsageError(`option '${lastSpelling(missing[1]!)}' requires a value`, hint);
  const extra = /^Option '([^']+)' does not take an argument/.exec(e.message);
  if (extra) return new CliUsageError(`option '${lastSpelling(extra[1]!)}' does not take a value`, hint);
  return new CliUsageError(e.message, hint);
}

/** Node names an option with a short alias as `-n, --name`; quote the long form. */
function lastSpelling(spellings: string): string {
  const parts = spellings.split(",").map((p) => p.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? spellings;
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

/**
 * Coerce any thrown value into a typed error body for rendering. The CLI's own
 * `EngineErrorLike` carries its code and hint; everything else goes through the
 * engine's one mapping (`errorBody`, the same the MCP server renders — spec/cli
 * §3.5): typed errors keep their code, OQX errors and a bad cursor are
 * `filter_invalid`, an unknown revision `target_missing`, and anything else the
 * catch-all `repo_not_found`.
 */
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
  const b = errorBody(err);
  return { code: b.error, message: b.message, ...(b.data !== undefined ? { data: b.data } : {}) };
}

/** A payload worth printing: anything but `undefined`, `null` and an empty record. */
function hasPayload(data: unknown): boolean {
  if (data === undefined || data === null) return false;
  if (typeof data === "object" && !Array.isArray(data) && Object.keys(data as object).length === 0) return false;
  return true;
}

/**
 * Render a thrown error to stderr and return the process exit code. `json`
 * selects machine output (typed object); otherwise the human form with any
 * current-truth payload pretty-printed. Both forms carry the hint; an empty
 * payload (`{}`) prints nothing.
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
    io.err(JSON.stringify({ error: body.code, message: body.message, ...(hasPayload(body.data) ? { data: body.data } : {}), ...(body.hint ? { hint: body.hint } : {}), retriable: false }));
    return EXIT_ERROR;
  }

  io.err(`${style.err(`error[${body.code}]`)}: ${body.message}`);
  if (body.hint) io.err(style.dim(`  hint: ${body.hint}`));
  // Conflict objects carry current truth (04 §4) — print all of it; the retry
  // is built from it.
  if (hasPayload(body.data)) {
    io.err(style.dim(indent(JSON.stringify(body.data, null, 2), "  ")));
  }
  return EXIT_ERROR;
}

// ---- machine modes (spec/cli §3.2) --------------------------------------------
//
// One rule for every verb: `--json` prints the result document; `--jsonl` prints
// one line per item when the result has a list, else the `--json` document;
// `--ids` prints one id per line when the result has an id list, else the
// `--json` document. The truncation footer (§3.4) prints in every mode but
// `--json`, whose envelope carries `truncated`/`cursor` itself.

export interface MachineShape {
  /** the list `--jsonl` streams (absent: the result is not list-shaped) */
  items?: unknown[];
  /** the ids `--ids` prints (absent: the result carries no id list) */
  ids?: string[];
  /** the cursor of a truncated result, for the footer */
  cursor?: string | number | null;
}

interface MachineIO {
  io: IO;
  style: Style;
  flags: { mode: OutputMode };
}

/** Print `doc` in the current machine mode (`--json`/`--jsonl`/`--ids`); returns EXIT_OK. */
export function emitMachine(cli: MachineIO, doc: unknown, shape: MachineShape = {}): number {
  const { io, style, flags } = cli;
  if (flags.mode === "jsonl" && shape.items) for (const item of shape.items) io.out(JSON.stringify(item));
  else if (flags.mode === "ids" && shape.ids) for (const id of shape.ids) io.out(id);
  else io.out(JSON.stringify(doc));
  if (flags.mode !== "json" && shape.cursor !== undefined && shape.cursor !== null) truncationFooter(io, style, shape.cursor);
  return EXIT_OK;
}

function indent(s: string, pad: string): string {
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

// ---- query hits (human tier) ------------------------------------------------
//
// Every OQX hit carries the injected `id` + `path` (the addressable handle and
// its locator, 06 §2) plus whatever the query's `select` projected, in select
// order. Two renderings:
//
//   * no projection → `<id>  <path>` per line, no header (the classic list; kept
//     byte-for-byte so transcripts that don't project stay valid);
//   * a projection   → an aligned table: dim header row, then per hit the id
//     (dim), the locator, and the projected columns in select order. Columns are
//     the union of projected keys across hits in first-seen order (a hit omits
//     an absent field, so no single hit is authoritative). The injected `path`
//     column is dropped when the projection itself carries `$path` — a row stays
//     locatable either way, and the same path never prints twice.
//
// Cells: strings verbatim (first line only; `…` marks a cut), numbers/booleans
// via String, null/absent → empty, arrays/objects → compact JSON. Every cell but
// the id/locator is capped at HIT_CELL_MAX visible chars. Two-space gutter,
// trailing whitespace trimmed (render.ts `columns`). Styling goes through
// `cli.style`, so NO_COLOR / non-TTY degrade to plain text like everything else.

export interface HitLike {
  id: string;
  path: string;
  [k: string]: unknown;
}

export const HIT_CELL_MAX = 60;

/** Clip `s` to `max` visible characters, marking the cut with `…`. */
export function truncateCell(s: string, max = HIT_CELL_MAX): string {
  if (visibleWidth(s) <= max) return s;
  return [...s].slice(0, Math.max(max - 1, 0)).join("") + "…";
}

/** Render one projected value as a table cell (unstyled). */
export function hitCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    const nl = v.indexOf("\n");
    return truncateCell(nl === -1 ? v : `${v.slice(0, nl)}…`);
  }
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return truncateCell(JSON.stringify(v) ?? String(v));
}

/** The projected column names across `hits`: every key but the injected id/path,
 *  in first-seen order. Empty when nothing was projected. */
export function hitColumns(hits: HitLike[]): string[] {
  const cols: string[] = [];
  const seen = new Set<string>(["id", "path"]);
  for (const h of hits) {
    for (const k of Object.keys(h)) {
      if (seen.has(k)) continue;
      seen.add(k);
      cols.push(k);
    }
  }
  return cols;
}

/** Human-tier hit list: `<id>  <path>` lines, or an aligned table when projected. */
export function renderHits(cli: { io: IO; style: Style }, hits: HitLike[]): void {
  const { io, style } = cli;
  const projected = hitColumns(hits);
  if (projected.length === 0) {
    for (const h of hits) io.out(`${style.id(h.id)}  ${style.accent(h.path)}`.trimEnd());
    return;
  }
  const cols = projected.includes("$path") ? ["id", ...projected] : ["id", "path", ...projected];
  const rows: string[][] = [cols.map((c) => style.dim(c))];
  for (const h of hits) {
    rows.push(
      cols.map((c) => {
        if (c === "id") return style.id(h.id);
        if (c === "path") return style.accent(h.path);
        if (c === "$path" && typeof h[c] === "string") return style.accent(h[c]);
        return hitCell(h[c]);
      }),
    );
  }
  for (const line of columns(rows)) io.out(line);
}

/** Loud truncation footer to stderr (§4.4). Exit code stays 0. */
export function truncationFooter(io: IO, style: Style, cursor: number | string): void {
  io.err(style.dim(`… truncated; continue with --cursor ${cursor}`));
}
