// The one error type the translator raises. `code` tells a parse failure (the
// DQL text is malformed) from an `unsupported` construct (well-formed Dataview
// with no OQX spelling — the translator refuses rather than emitting a query
// that means something else). `construct` names the Dataview construct in the
// second case (`FLATTEN`, `regexreplace()`, `file.ctime`, …) so a client can
// group or document the gaps. Positions are code-unit offsets into the DQL
// source with the 1-based line/column a user reads.

export type DqlErrorCode = "parse" | "unsupported";

export interface DqlPosition {
  offset: number;
  line: number;
  column: number;
}

export class DqlError extends Error {
  readonly code: DqlErrorCode;
  readonly position: DqlPosition | null;
  readonly construct: string | null;

  constructor(code: DqlErrorCode, message: string, position: DqlPosition | null = null, construct: string | null = null) {
    const where = position ? ` (at line ${position.line}, column ${position.column})` : "";
    super(`${message}${where}`);
    this.name = "DqlError";
    this.code = code;
    this.position = position;
    this.construct = construct;
  }
}

/** Line/column for an offset into `source`. */
export function positionAt(source: string, offset: number): DqlPosition {
  let line = 1;
  let column = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i++) {
    if (source.charCodeAt(i) === 10) { line++; column = 1; }
    else column++;
  }
  return { offset, line, column };
}

export function unsupported(construct: string, message: string, position: DqlPosition | null = null): DqlError {
  return new DqlError("unsupported", `${construct}: ${message}`, position, construct);
}
