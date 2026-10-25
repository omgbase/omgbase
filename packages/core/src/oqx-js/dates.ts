// Dates and durations for the query binding (spec/surface §1.3 "Dates and
// durations", 4.8): the Dataview-parity function set, served as omgbase HOST
// functions through `@omgbase/oqx`'s `callFunction` / `callMethod` seam.
//
// Two value conventions and no new value kinds:
//   • a DATE is an ISO-8601 string — `YYYY-MM-DD` (date-only) or
//     `YYYY-MM-DDThh:mm:ss[.fff](Z|±hh:mm)` — exactly what the store writes for
//     `updated_at`/`ts` and what OQX already orders chronologically by code
//     point (spec/oqx SEMANTICS §6);
//   • a DURATION is a number of seconds.
// Arithmetic between them is METHODS (`d.plus(s)`, `a.until(b)`), never the
// `+`/`-` operators: `+` with a string operand concatenates (SEMANTICS §7), so
// `"2026-01-05" + 86400` is `"2026-01-0586400"` and must stay so.
//
// Everything is total: a value that is not a date (or a duration) yields
// absent, so a `where` over mixed data filters quietly. Only a wrong ARITY is
// an error (`filter_invalid`, the surface's eval error). The one impure input
// — the named points `today`, `now`, `sow`… — reads the HOST clock, UTC, through
// `Date.now()`, which the spec clock seam (`core/clock.ts`, `OMGBASE_SPEC_CLOCK`)
// pins; the language itself has no clock (the fixtures run under the corpus
// clock, so `date("today")` is `2026-09-27` there).
//
// The pure half (parse / render / shift / until / fields / format / the duration
// grammar) is exported for the unit tests and the Rust twin's reading; the two
// `CallResult` arms at the bottom are what context.ts and run.ts's constant fold
// call.

import type { CallResult } from "@omgbase/oqx";
import { FilterInvalid } from "../core/filter-invalid.js";

// ---- the date value -------------------------------------------------------------

/** A parsed date: the instant, the offset it was WRITTEN in (minutes east of
 * UTC; `0` for `Z` and for a date-only value), whether it is date-only, and
 * whether it carried a fraction of a second as written (kept on render). */
export interface DateValue {
  ms: number;
  offset: number;
  dateOnly: boolean;
  fraction: boolean;
}

const DAY_MS = 86_400_000;

// `YYYY-MM-DD`, optionally `T`/`t`/space + `hh:mm[:ss[.fff…]]` + optional offset
// (`Z`, `±hh:mm`, `±hhmm`); a time without an offset is UTC.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|z|[+-]\d{2}:?\d{2})?)?$/;

function daysInMonth(year: number, month: number): number {
  // month 1..12; day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parse an ISO-8601 date / datetime string; `null` for anything else (a
 * non-string, a malformed string, an out-of-range field such as month 13 or
 * hour 24). */
export function parseDate(x: unknown): DateValue | null {
  if (typeof x !== "string") return null;
  const m = ISO_RE.exec(x.trim());
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (m[4] === undefined) {
    return { ms: Date.UTC(year, month - 1, day), offset: 0, dateOnly: true, fraction: false };
  }
  const hour = Number(m[4]), minute = Number(m[5]), second = m[6] === undefined ? 0 : Number(m[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const fraction = m[7] !== undefined;
  const millis = fraction ? Number(m[7]!.padEnd(3, "0").slice(0, 3)) : 0;
  let offset = 0;
  const z = m[8];
  if (z !== undefined && z !== "Z" && z !== "z") {
    const sign = z[0] === "-" ? -1 : 1;
    const digits = z.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2)), om = Number(digits.slice(2, 4));
    if (oh > 23 || om > 59) return null;
    offset = sign * (oh * 60 + om);
  }
  const local = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  return { ms: local - offset * 60_000, offset, dateOnly: false, fraction };
}

interface Fields { year: number; month: number; day: number; hour: number; minute: number; second: number; millis: number; weekday: number }

/** The fields of the value in the offset it was written in (`weekday` 1 = Monday … 7 = Sunday). */
export function fieldsOf(d: DateValue): Fields {
  const t = new Date(d.ms + d.offset * 60_000);
  return {
    year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(),
    hour: t.getUTCHours(), minute: t.getUTCMinutes(), second: t.getUTCSeconds(), millis: t.getUTCMilliseconds(),
    weekday: ((t.getUTCDay() + 6) % 7) + 1,
  };
}

const pad = (n: number, w: number): string => String(n).padStart(w, "0");

/** The canonical string: `YYYY-MM-DD` for a date-only value; otherwise
 * `YYYY-MM-DDThh:mm:ss` + `.fff` when the value carries a fraction (as written,
 * or because arithmetic produced one) + `Z` for UTC or the written `±hh:mm`. */
export function renderDate(d: DateValue): string | null {
  if (!Number.isFinite(d.ms)) return null;
  const f = fieldsOf(d);
  const ymd = `${pad(f.year, 4)}-${pad(f.month, 2)}-${pad(f.day, 2)}`;
  if (d.dateOnly) return ymd;
  let s = `${ymd}T${pad(f.hour, 2)}:${pad(f.minute, 2)}:${pad(f.second, 2)}`;
  if (d.fraction || f.millis !== 0) s += `.${pad(f.millis, 3)}`;
  if (d.offset === 0) return `${s}Z`;
  const a = Math.abs(d.offset);
  return `${s}${d.offset < 0 ? "-" : "+"}${pad(Math.floor(a / 60), 2)}:${pad(a % 60, 2)}`;
}

/** `date(x)` on a string that is not a named point: the canonical form, or null. */
export function canonicalDate(x: unknown): string | null {
  const d = parseDate(x);
  return d === null ? null : renderDate(d);
}

// ---- named points (the host clock, UTC) --------------------------------------------

/** The named points `date()` resolves against the clock. */
export const NAMED_POINTS: ReadonlySet<string> = new Set(["now", "today", "yesterday", "tomorrow", "sow", "eow", "som", "eom", "soy", "eoy"]);

const dateOnly = (ms: number): DateValue => ({ ms, offset: 0, dateOnly: true, fraction: false });

/** Resolve a named point at the instant `nowMs` (UTC): `now` is the instant
 * with milliseconds (the form the store stamps commits in); the others are
 * date-only — `sow`/`eow` the Monday/Sunday of the current week, `som`/`eom`
 * the first/last day of the month, `soy`/`eoy` of the year. Null for a name
 * that is not a point. */
export function namedPoint(name: string, nowMs: number): DateValue | null {
  const t = new Date(nowMs);
  const y = t.getUTCFullYear(), mo = t.getUTCMonth(), d = t.getUTCDate();
  const today = Date.UTC(y, mo, d);
  switch (name) {
    case "now": return { ms: nowMs, offset: 0, dateOnly: false, fraction: true };
    case "today": return dateOnly(today);
    case "yesterday": return dateOnly(today - DAY_MS);
    case "tomorrow": return dateOnly(today + DAY_MS);
    case "sow": return dateOnly(today - ((t.getUTCDay() + 6) % 7) * DAY_MS);
    case "eow": return dateOnly(today + (6 - (t.getUTCDay() + 6) % 7) * DAY_MS);
    case "som": return dateOnly(Date.UTC(y, mo, 1));
    case "eom": return dateOnly(Date.UTC(y, mo + 1, 0));
    case "soy": return dateOnly(Date.UTC(y, 0, 1));
    case "eoy": return dateOnly(Date.UTC(y, 11, 31));
    default: return null;
  }
}

/** `date(x)`: a named point against the clock, else the canonical ISO form, else null. */
export function dateOf(x: unknown, nowMs: number = Date.now()): string | null {
  if (typeof x !== "string") return null;
  const key = x.trim().toLowerCase();
  if (NAMED_POINTS.has(key)) return renderDate(namedPoint(key, nowMs)!);
  return canonicalDate(x);
}

// ---- durations -------------------------------------------------------------------

/** A parsed duration: the calendar counts `years` and `months` kept apart from
 * the fixed-length `seconds`, so `plus` can be calendar-aware while `dur()`
 * applies the 365-day / 30-day conventions. */
export interface Duration {
  years: number;
  months: number;
  seconds: number;
}

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  w: 604_800, wk: 604_800, wks: 604_800, week: 604_800, weeks: 604_800,
  d: 86_400, day: 86_400, days: 86_400,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
};
const UNIT_YEARS: ReadonlySet<string> = new Set(["y", "yr", "yrs", "year", "years"]);
const UNIT_MONTHS: ReadonlySet<string> = new Set(["mo", "mos", "month", "months"]);

/** Days per month / year under the fixed conventions `dur()` applies. */
export const MONTH_SECONDS = 30 * 86_400;
export const YEAR_SECONDS = 365 * 86_400;

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const ISO_DUR_RE = new RegExp(`^([+-])?P(?:${NUM}Y)?(?:${NUM}M)?(?:${NUM}W)?(?:${NUM}D)?(?:T(?:${NUM}H)?(?:${NUM}M)?(?:${NUM}S)?)?$`, "i");
const PAIR_RE = /^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)/;

/** Parse a duration string: Dataview's `<number> <unit>` pairs, each pair
 * separated from the next by spaces, a comma, or nothing (`"1h30m"`, `"2 days,
 * 3 hours"`; a trailing separator is malformed), units case-insensitive:
 * y|yr|yrs|year|years, mo|mos|month|months, w|wk|wks|week|weeks, d|day|days,
 * h|hr|hrs|hour|hours, m|min|mins|minute|minutes, s|sec|secs|second|seconds —
 * or an ISO-8601 duration (`P1DT2H`, `PT90M`, `P2W`). Null when it is neither. */
export function parseDuration(x: unknown): Duration | null {
  if (typeof x !== "string") return null;
  const s = x.trim();
  if (s === "") return null;
  const iso = ISO_DUR_RE.exec(s);
  if (iso) {
    const [, sign, y, mo, w, d, h, mi, sec] = iso;
    if ([y, mo, w, d, h, mi, sec].every((v) => v === undefined)) return null;
    const n = (v: string | undefined): number => (v === undefined ? 0 : Number(v));
    const k = sign === "-" ? -1 : 1;
    return {
      years: k * n(y),
      months: k * n(mo),
      seconds: k * (n(w) * 604_800 + n(d) * 86_400 + n(h) * 3600 + n(mi) * 60 + n(sec)),
    };
  }
  let rest = s;
  let years = 0, months = 0, seconds = 0;
  for (;;) {
    const m = PAIR_RE.exec(rest);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    if (Object.hasOwn(UNIT_SECONDS, unit)) seconds += n * UNIT_SECONDS[unit]!;
    else if (UNIT_MONTHS.has(unit)) months += n;
    else if (UNIT_YEARS.has(unit)) years += n;
    else return null;
    rest = rest.slice(m[0].length);
    if (rest === "") break;
    // the separator: spaces, one comma among them, or none at all (`1h30m`)
    rest = rest.replace(/^\s*,?\s*/, "");
    if (rest === "") return null;
  }
  return { years, months, seconds };
}

/** A duration's length in seconds under the conventions: a year is 365 days, a month 30. */
export function durationSeconds(d: Duration): number {
  return d.years * YEAR_SECONDS + d.months * MONTH_SECONDS + d.seconds;
}

/** `dur(x)`: a number is that many seconds; a string is parsed; else null. */
export function durOf(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const d = parseDuration(x);
  return d === null ? null : durationSeconds(d);
}

// ---- arithmetic -------------------------------------------------------------------

/** Shift a date by a whole number of calendar `months` (the month field moves
 * and the day is clamped to the new month's length) and then by `seconds`. A
 * date-only value stays date-only when the seconds are a whole number of days;
 * otherwise it becomes a datetime in its offset (UTC for a date-only receiver). */
export function shiftDate(d: DateValue, months: number, seconds: number): DateValue {
  let ms = d.ms;
  if (months !== 0) {
    const f = fieldsOf(d);
    const total = f.year * 12 + (f.month - 1) + months;
    const year = Math.floor(total / 12), month = ((total % 12) + 12) % 12 + 1;
    const day = Math.min(f.day, daysInMonth(year, month));
    ms = Date.UTC(year, month - 1, day, f.hour, f.minute, f.second, f.millis) - d.offset * 60_000;
  }
  const deltaMs = Math.round(seconds * 1000);
  ms += deltaMs;
  const dateOnly = d.dateOnly && deltaMs % DAY_MS === 0;
  return { ms, offset: d.offset, dateOnly, fraction: d.fraction };
}

/** The argument of `plus`/`minus` as a duration: a number of seconds (never
 * calendar) or a duration string (months/years calendar-aware). Null otherwise. */
function durationArg(x: unknown): Duration | null {
  if (typeof x === "number") return Number.isFinite(x) ? { years: 0, months: 0, seconds: x } : null;
  return parseDuration(x);
}

/** A duration as `plus` applies it: the WHOLE years and months are calendar
 * months; a fractional year or month count is not calendar — its fraction is
 * 365-day / 30-day seconds — and joins the fixed-length seconds. */
export function calendarParts(dur: Duration): { months: number; seconds: number } {
  const wy = Math.trunc(dur.years), wm = Math.trunc(dur.months);
  return {
    months: wy * 12 + wm,
    seconds: dur.seconds + (dur.years - wy) * YEAR_SECONDS + (dur.months - wm) * MONTH_SECONDS,
  };
}

/** `d.plus(x)` (`sign` 1) / `d.minus(x)` (`sign` -1). */
export function plusMinus(recv: unknown, arg: unknown, sign: 1 | -1): string | null {
  const d = parseDate(recv);
  const dur = durationArg(arg);
  if (d === null || dur === null) return null;
  const { months, seconds } = calendarParts(dur);
  return renderDate(shiftDate(d, sign * months, sign * seconds));
}

/** `a.until(b)`: seconds from `a` to `b` (negative when `b` is earlier), by instant. */
export function until(a: unknown, b: unknown): number | null {
  const da = parseDate(a), db = parseDate(b);
  if (da === null || db === null) return null;
  return (db.ms - da.ms) / 1000;
}

// ---- format -------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** The `format` tokens, longest first (a scan takes the longest token at each position). */
const FORMAT_TOKENS = ["yyyy", "MMM", "EEE", "MM", "dd", "HH", "mm", "ss"] as const;

/** `d.format(pattern)`: `yyyy` year, `MM` month, `dd` day, `HH` hour, `mm`
 * minute, `ss` second (two digits each), `MMM` the English month abbreviation
 * (`Jan`), `EEE` the English weekday abbreviation (`Mon`); every other
 * character is literal. Fields are read in the written offset; a date-only
 * value has `00` time fields. */
export function formatDate(recv: unknown, pattern: unknown): string | null {
  const d = parseDate(recv);
  if (d === null || typeof pattern !== "string") return null;
  const f = fieldsOf(d);
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const tok = FORMAT_TOKENS.find((t) => pattern.startsWith(t, i));
    if (tok === undefined) { out += pattern[i]; i++; continue; }
    switch (tok) {
      case "yyyy": out += pad(f.year, 4); break;
      case "MMM": out += MONTHS[f.month - 1]; break;
      case "EEE": out += WEEKDAYS[f.weekday - 1]; break;
      case "MM": out += pad(f.month, 2); break;
      case "dd": out += pad(f.day, 2); break;
      case "HH": out += pad(f.hour, 2); break;
      case "mm": out += pad(f.minute, 2); break;
      case "ss": out += pad(f.second, 2); break;
    }
    i += tok.length;
  }
  return out;
}

// ---- duration rendering -----------------------------------------------------------------

function splitSeconds(n: number): { neg: boolean; d: number; h: number; m: number; s: number } {
  const neg = n < 0;
  const a = Math.round(Math.abs(n) * 1000) / 1000;
  const d = Math.floor(a / 86_400);
  const h = Math.floor((a % 86_400) / 3600);
  const m = Math.floor((a % 3600) / 60);
  const s = Math.round((a % 60) * 1000) / 1000;
  return { neg, d, h, m, s };
}

/** `n.dur_text()`: `"2d 3h"`, `"1h 30m"`, `"45s"` — days, hours, minutes,
 * seconds, zero parts omitted, `"0s"` for zero, a leading `-` for a negative
 * duration, a fractional second kept (`"1.5s"`). Null for a non-number. */
export function durText(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const { neg, d, h, m, s } = splitSeconds(n);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s) parts.push(`${s}s`);
  if (parts.length === 0) return "0s";
  return (neg ? "-" : "") + parts.join(" ");
}

/** `n.dur_iso()`: the ISO-8601 duration `P[nD][T[nH][nM][nS]]` — `PT1H30M`,
 * `P2DT3H`, `PT45S`, `PT0S` for zero, a leading `-` for a negative duration.
 * Null for a non-number. */
export function durIso(n: unknown): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const { neg, d, h, m, s } = splitSeconds(n);
  let out = "P";
  if (d) out += `${d}D`;
  if (h || m || s) {
    out += "T";
    if (h) out += `${h}H`;
    if (m) out += `${m}M`;
    if (s) out += `${s}S`;
  }
  if (out === "P") out = "PT0S";
  return (neg ? "-" : "") + out;
}

// ---- the OQX arms ---------------------------------------------------------------------

/** The free functions and their arity. */
export const DATE_FUNCTIONS: Readonly<Record<string, number>> = { date: 1, dur: 1 };
/** The methods and their arity: on a date string, and (`dur_text`/`dur_iso`) on a number. */
export const DATE_METHODS: Readonly<Record<string, number>> = {
  plus: 1, minus: 1, until: 1, format: 1,
  year: 0, month: 0, day: 0, weekday: 0, hour: 0, minute: 0, second: 0, date: 0,
  dur_text: 0, dur_iso: 0,
};

function arity(spelling: string, want: number, got: number): void {
  if (got !== want) throw new FilterInvalid(`${spelling} takes exactly ${want} argument${want === 1 ? "" : "s"}, got ${got}`, "OQX");
}

/** `callFunction` arm: `date(x)` / `dur(x)`; `{ handled: false }` for any other name. */
export function dateFunction(name: string, args: unknown[], nowMs: number = Date.now()): CallResult {
  if (!Object.hasOwn(DATE_FUNCTIONS, name)) return { handled: false };
  arity(`${name}()`, DATE_FUNCTIONS[name]!, args.length);
  return { handled: true, value: name === "date" ? dateOf(args[0], nowMs) : durOf(args[0]) };
}

/** `callMethod` arm: the date methods on a string receiver and the duration
 * renderers on a number; a receiver of any other kind yields absent (the
 * methods are total). `{ handled: false }` for any other name. */
export function dateMethod(name: string, recv: unknown, args: unknown[]): CallResult {
  if (!Object.hasOwn(DATE_METHODS, name)) return { handled: false };
  arity(`.${name}()`, DATE_METHODS[name]!, args.length);
  const field = (k: keyof Fields): number | null => {
    const d = parseDate(recv);
    return d === null ? null : fieldsOf(d)[k];
  };
  switch (name) {
    case "plus": return { handled: true, value: plusMinus(recv, args[0], 1) };
    case "minus": return { handled: true, value: plusMinus(recv, args[0], -1) };
    case "until": return { handled: true, value: until(recv, args[0]) };
    case "format": return { handled: true, value: formatDate(recv, args[0]) };
    case "year": case "month": case "day": case "weekday": case "hour": case "minute": case "second":
      return { handled: true, value: field(name) };
    case "date": {
      const d = parseDate(recv);
      return { handled: true, value: d === null ? null : renderDate({ ...d, dateOnly: true }) };
    }
    case "dur_text": return { handled: true, value: durText(recv) };
    case "dur_iso": return { handled: true, value: durIso(recv) };
    default: return { handled: false };
  }
}
