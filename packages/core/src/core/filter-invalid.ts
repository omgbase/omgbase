/**
 * The query surface's "your request is malformed" error: a reason, a hint
 * naming the rule, and — since spec/surface 4.11 — the corrected call as
 * canonical JSON when the surface can spell one (`data.fix`). Thrown by the
 * OQX binding (`oqx-js/*`), the selector compiler (`mutate/select.ts`) and the
 * argument validator; `mcp/errors.ts` maps it to `filter_invalid`. Lived in
 * `search/cel/parser.ts` (the retired CEL filter compiler, ADR-013) until
 * modular-core Phase 1 moved it under `core/` with its importers; that module
 * re-exports it for import stability.
 */
export class FilterInvalid extends Error {
  reason: string;
  hint: string;
  /** (spec/surface 4.11) a literal corrected call, canonical JSON, when the surface can spell one (`data.fix`). */
  fix: string | undefined;
  constructor(reason: string, hint = "see query-language.md §3", fix?: string) {
    super(reason);
    this.reason = reason;
    this.hint = hint;
    this.fix = fix;
  }
}
