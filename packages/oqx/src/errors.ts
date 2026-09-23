// A single error type for every OQX failure — lex, parse, and evaluation. `stage`
// distinguishes where it came from so callers (and tests) can branch without
// string-matching messages. Mirrors the reference impl's FilterInvalid, but the
// generic kernel has no SQL/CEL layer to name.

export type OqxStage = "lex" | "parse" | "eval";

export class OqxError extends Error {
  readonly stage: OqxStage;
  constructor(message: string, stage: OqxStage) {
    super(message);
    this.name = "OqxError";
    this.stage = stage;
  }
}
