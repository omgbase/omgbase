// Parse-error reporting for the editor: `@omgbase/oqx` throws `OqxError` whose
// message carries the position as prose — the parser writes `… (at offset N)`,
// the lexer writes `… at N` — in Unicode CODE POINTS over the source. CodeMirror
// positions are UTF-16 code units, so the editor converts before decorating.

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
