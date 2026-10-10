// Error reporting for the editor and the status line.
//
// Parse errors: `@omgbase/oqx` throws `OqxError` whose message carries the
// position as prose — the parser writes `… (at offset N)`, the lexer writes
// `… at N` — in Unicode CODE POINTS over the source. CodeMirror positions are
// UTF-16 code units, so the editor converts before decorating.
//
// Query (server) errors: the `query` tool answers `filter_invalid` with the
// engine's message. Since surface 1.5 a query whose hits are not store rows
// (`follow before` over a list of paths — the strings) fails with "a hit must be
// a document, block, node or edge row — the query reached <value>; to follow
// document references held in a property use refs(<field>)". The remedy names
// no field; `describeQueryError` reads the bare `follow` field off the AST and
// suggests `follow refs(before)` concretely.

import type { Query } from "@omgbase/oqx";
import { bareFollowFields } from "./hints.ts";

export interface OqxErrorInfo {
  /** The message with the position suffix removed. */
  message: string;
  /** Code-point offset into the source, or null when the message carries none. */
  offset: number | null;
  /** `lex` / `parse` / `eval` when the error is an `OqxError`, else null. */
  stage: string | null;
}

const PARSER_SUFFIX = /\s*\(at offset (\d+)\)\s*$/;
const LEXER_AT = /\bat (\d+)(?=\s—|\s*$)/;

/** Pull the offset out of an `OqxError` (or any error-ish value). */
export function describeOqxError(err: unknown): OqxErrorInfo {
  const raw = err instanceof Error ? err.message : String(err);
  const stage = typeof (err as { stage?: unknown })?.stage === "string" ? (err as { stage: string }).stage : null;
  const parser = PARSER_SUFFIX.exec(raw);
  if (parser) return { message: raw.replace(PARSER_SUFFIX, ""), offset: Number(parser[1]), stage };
  const lexer = LEXER_AT.exec(raw);
  if (lexer) return { message: raw, offset: Number(lexer[1]), stage };
  return { message: raw, offset: null, stage };
}

/** Code-point offset → UTF-16 index into `source` (clamped to the source). */
export function codePointToUtf16(source: string, offset: number): number {
  let cp = 0;
  let i = 0;
  while (i < source.length && cp < offset) {
    const code = source.codePointAt(i)!;
    i += code > 0xffff ? 2 : 1;
    cp++;
  }
  return Math.min(i, source.length);
}

// ---- server errors ----------------------------------------------------------------

export interface QueryErrorInfo {
  /** The message to show (the remedy clause removed when it became `suggestion`). */
  message: string;
  /** What the query reached (`a string ("/timeline/beta.md")`), for the hit rule. */
  reached: string | null;
  /** Source text that fixes it: `follow refs(before)` when the AST names the
   * field, else the engine's own `refs(<field>)`; null for other errors. */
  suggestion: string | null;
}

const HIT_RULE = /^a hit must be a document, block, node or edge row — the query reached (.+?); to follow document references held in a property use (refs\(<field>\))\s*$/;

/** The `query` tool's error, with the surface-1.5 hit rule's remedy made concrete. */
export function describeQueryError(err: unknown, query: Query | null): QueryErrorInfo {
  const raw = err instanceof Error ? err.message : String(err);
  const m = HIT_RULE.exec(raw);
  if (!m) return { message: raw, reached: null, suggestion: null };
  const fields = bareFollowFields(query);
  const suggestion = fields.length > 0 ? `follow ${fields.map((f) => `refs(${f.field})`).join(", ")}` : m[2]!;
  return { message: `a hit must be a document, block, node or edge row — the query reached ${m[1]}`, reached: m[1]!, suggestion };
}
