// Dataview's bare date and duration literals ("Expressions" → "Literals":
// `date(today)`, `date(2021-07-14)`, `dur(1 hour 30 minutes)`), rewritten to the
// quoted OQX forms the surface 4.8 date contract takes: `date("today")`,
// `date("2021-07-14")`, `dur("1 hour 30 minutes")`. This module is the one
// place that knows the two grammars, so it is the adapter to revise if the
// engine's `date()` / `dur()` land with a different spelling.
//
// Recognition is purely lexical: the raw text between `date(` and `)` is a date
// literal when it is a named point or an ISO date/datetime; the text between
// `dur(` and `)` is a duration literal when it starts with a number (`1 hour`,
// `1h30m`, `2 weeks, 3 days`) or is an ISO 8601 duration (`PT1H30M`). Anything
// else — `date(due)`, `dur(day)` — is an ordinary function call over a field,
// exactly as Dataview parses it (a bare word that is not a named date point is
// a field reference).

/** The named date points Dataview accepts bare ("Literals: Dates"), passed to
 * OQX `date()` as the same words. */
export const NAMED_DATES: ReadonlySet<string> = new Set([
  "now", "today", "yesterday", "tomorrow", "sow", "eow", "som", "eom", "soy", "eoy",
]);

// YYYY, YYYY-MM, YYYY-MM-DD, with an optional THH:mm[:ss[.sss]] and zone.
const ISO_DATE = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/;

/** Whether `text` (trimmed) is a bare date literal: a named point or an ISO date. */
export function isDateLiteral(text: string): boolean {
  const t = text.trim();
  return NAMED_DATES.has(t.toLowerCase()) || ISO_DATE.test(t);
}

/** The canonical argument string for `date("…")`: named points lower-cased, ISO text as written. */
export function dateLiteralText(text: string): string {
  const t = text.trim();
  return NAMED_DATES.has(t.toLowerCase()) ? t.toLowerCase() : t;
}

// Dataview's duration grammar: `<number> <unit>` groups, separated by spaces
// and/or commas, with the compact form `1h30m`; units are year(s)/yr(s)/y,
// month(s)/mo, week(s)/wk(s)/w, day(s)/d, hour(s)/hr(s)/h, minute(s)/min(s)/m,
// second(s)/sec(s)/s. ISO 8601 durations (`P1DT2H`) pass through as text.
const UNIT = "(?:years?|yrs?|y|months?|mos?|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)";
const DURATION = new RegExp(`^-?\\d+(?:\\.\\d+)?\\s*${UNIT}(?:\\s*,?\\s*\\d+(?:\\.\\d+)?\\s*${UNIT})*$`, "i");
const ISO_DURATION = /^-?P(?=\d|T)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/i;

/** Whether `text` (trimmed) is a bare duration literal. */
export function isDurationLiteral(text: string): boolean {
  const t = text.trim();
  return DURATION.test(t) || ISO_DURATION.test(t);
}

/** The canonical argument string for `dur("…")`: inner whitespace collapsed to single spaces. */
export function durationLiteralText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
