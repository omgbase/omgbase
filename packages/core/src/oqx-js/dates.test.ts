// The pure half of spec/surface §1.3 "Dates and durations" (4.8): parsing and
// canonical rendering, the named points at a fixed instant, the duration
// grammar, calendar vs fixed-length shifts, `until`, the fields, `format`, the
// duration renderers, the arity rule, and run.ts's constant fold. The fixture
// suite (`spec/surface/cases/query-dates.json`) pins the same behavior through
// the query runner under the corpus clock.
import { describe, it, expect } from "vitest";
import { parse, build } from "@omgbase/oqx";
import type { Expr } from "@omgbase/oqx";
import {
  parseDate, renderDate, canonicalDate, namedPoint, dateOf, parseDuration, durationSeconds, durOf,
  shiftDate, plusMinus, until, formatDate, durText, durIso, dateFunction, dateMethod, NAMED_POINTS, DATE_METHODS,
} from "./dates.js";
import { foldDates } from "./run.js";
import { FilterInvalid } from "../search/cel/parser.js";

// 2026-09-27T00:00:00.000Z — the corpus clock, a Sunday.
const NOW = Date.UTC(2026, 8, 27);

describe("dates — parse and render", () => {
  it("date-only stays date-only; a datetime is canonical", () => {
    expect(canonicalDate("2026-10-15")).toBe("2026-10-15");
    expect(canonicalDate("2026-10-15T09:00:00Z")).toBe("2026-10-15T09:00:00Z");
    expect(canonicalDate("2026-10-15T09:00:00+00:00")).toBe("2026-10-15T09:00:00Z");
    expect(canonicalDate("2026-10-15T09:00:00+02:00")).toBe("2026-10-15T09:00:00+02:00");
    expect(canonicalDate("2026-10-15T09:00:00-0500")).toBe("2026-10-15T09:00:00-05:00");
    expect(canonicalDate("2026-10-15T09:00")).toBe("2026-10-15T09:00:00Z");
    expect(canonicalDate("2026-10-15 09:00:00")).toBe("2026-10-15T09:00:00Z");
    expect(canonicalDate("2026-10-15t09:00:00z")).toBe("2026-10-15T09:00:00Z");
    expect(canonicalDate("2026-10-15T09:00:00.5Z")).toBe("2026-10-15T09:00:00.500Z");
    expect(canonicalDate("2026-10-15T09:00:00.123456Z")).toBe("2026-10-15T09:00:00.123Z");
    expect(canonicalDate("2026-09-27T00:00:00.000Z")).toBe("2026-09-27T00:00:00.000Z");
    expect(canonicalDate(" 2026-10-15 ")).toBe("2026-10-15");
  });

  it("rejects what is not an ISO date", () => {
    for (const bad of ["15/10/2026", "2026-13-01", "2026-02-30", "2026-00-10", "2026-10-15T24:00:00Z", "2026-10-15T09:60:00Z", "2026-10-15T09:00:60Z", "2026-10-15T09:00:00+24:00", "", "today", "2026-1-5", "20261015"]) {
      expect(parseDate(bad), bad).toBeNull();
    }
    expect(parseDate(5)).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate(true)).toBeNull();
  });

  it("leap days parse in leap years only", () => {
    expect(canonicalDate("2024-02-29")).toBe("2024-02-29");
    expect(canonicalDate("2026-02-29")).toBeNull();
    expect(canonicalDate("2000-02-29")).toBe("2000-02-29");
    expect(canonicalDate("1900-02-29")).toBeNull();
  });

  it("keeps the written offset as the value's fields", () => {
    const d = parseDate("2026-10-15T23:30:00-05:00")!;
    expect(d.offset).toBe(-300);
    expect(d.ms).toBe(Date.UTC(2026, 9, 16, 4, 30));
    expect(renderDate(d)).toBe("2026-10-15T23:30:00-05:00");
  });
});

describe("dates — named points (UTC, the host clock)", () => {
  it("resolves every point at the corpus clock", () => {
    const at = (n: string): string | null => renderDate(namedPoint(n, NOW)!);
    expect(at("now")).toBe("2026-09-27T00:00:00.000Z");
    expect(at("today")).toBe("2026-09-27");
    expect(at("yesterday")).toBe("2026-09-26");
    expect(at("tomorrow")).toBe("2026-09-28");
    expect(at("sow")).toBe("2026-09-21");
    expect(at("eow")).toBe("2026-09-27");
    expect(at("som")).toBe("2026-09-01");
    expect(at("eom")).toBe("2026-09-30");
    expect(at("soy")).toBe("2026-01-01");
    expect(at("eoy")).toBe("2026-12-31");
    expect([...NAMED_POINTS].every((n) => namedPoint(n, NOW) !== null)).toBe(true);
    expect(namedPoint("noon", NOW)).toBeNull();
  });

  it("week and month edges on other instants", () => {
    const wed = Date.UTC(2026, 9, 14, 15, 0); // Wednesday
    expect(renderDate(namedPoint("sow", wed)!)).toBe("2026-10-12");
    expect(renderDate(namedPoint("eow", wed)!)).toBe("2026-10-18");
    const mon = Date.UTC(2026, 9, 12);
    expect(renderDate(namedPoint("sow", mon)!)).toBe("2026-10-12");
    expect(renderDate(namedPoint("eom", Date.UTC(2024, 1, 10))!)).toBe("2024-02-29");
    expect(renderDate(namedPoint("eom", Date.UTC(2026, 11, 10))!)).toBe("2026-12-31");
    expect(renderDate(namedPoint("now", Date.UTC(2026, 9, 14, 15, 0, 7, 250))!)).toBe("2026-10-14T15:00:07.250Z");
  });

  it("dateOf: a named point (trimmed, case-insensitive), else canonical, else null", () => {
    expect(dateOf("Today", NOW)).toBe("2026-09-27");
    expect(dateOf(" now ", NOW)).toBe("2026-09-27T00:00:00.000Z");
    expect(dateOf("2026-01-05", NOW)).toBe("2026-01-05");
    expect(dateOf("nope", NOW)).toBeNull();
    expect(dateOf(5, NOW)).toBeNull();
    expect(dateOf(undefined, NOW)).toBeNull();
  });
});

describe("durations — the grammar", () => {
  it("Dataview pairs: spaces, commas, no spaces, every unit, case, decimals", () => {
    expect(durOf("1h30m")).toBe(5400);
    expect(durOf("1 hour 30 minutes")).toBe(5400);
    expect(durOf("2 days, 3 hours")).toBe(2 * 86400 + 3 * 3600);
    expect(durOf("1 week")).toBe(604800);
    expect(durOf("1 month")).toBe(30 * 86400);
    expect(durOf("1 year")).toBe(365 * 86400);
    expect(durOf("90 seconds")).toBe(90);
    expect(durOf("1.5h")).toBe(5400);
    expect(durOf("2 YRS")).toBe(2 * 365 * 86400);
    expect(durOf("3 wks 2 d")).toBe(3 * 604800 + 2 * 86400);
    expect(durOf("2mo")).toBe(60 * 86400);
    expect(durOf("5 mins, 10 secs")).toBe(310);
    expect(durOf("1y 1mo 1w 1d 1h 1m 1s")).toBe(365 * 86400 + 30 * 86400 + 604800 + 86400 + 3600 + 61);
    expect(durOf("-1 day")).toBe(-86400);
  });

  it("ISO-8601 durations and numbers", () => {
    expect(durOf("PT1H30M")).toBe(5400);
    expect(durOf("P1DT2H")).toBe(86400 + 7200);
    expect(durOf("P2W")).toBe(2 * 604800);
    expect(durOf("P1M")).toBe(30 * 86400);
    expect(durOf("P1Y2M3DT4H5M6S")).toBe(365 * 86400 + 60 * 86400 + 3 * 86400 + 4 * 3600 + 5 * 60 + 6);
    expect(durOf("PT0S")).toBe(0);
    expect(durOf("pt90m")).toBe(5400);
    expect(durOf("-PT1H")).toBe(-3600);
    expect(durOf(90)).toBe(90);
    expect(durOf(1.5)).toBe(1.5);
    expect(durOf(-60)).toBe(-60);
    expect(durOf(Number.NaN)).toBeNull();
    expect(durOf(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("keeps calendar months apart from seconds", () => {
    expect(parseDuration("1 year 2 months 3 days")).toEqual({ years: 1, months: 2, seconds: 3 * 86400 });
    expect(parseDuration("P1Y2M")).toEqual({ years: 1, months: 2, seconds: 0 });
    expect(durationSeconds({ years: 1, months: 1, seconds: 1 })).toBe(365 * 86400 + 30 * 86400 + 1);
  });

  it("rejects what is not a duration", () => {
    for (const bad of ["", "   ", "abc", "3 fortnights", "90", "P", "PT", "1h 2x", "h1", "1 h,", ",1h", "1h,,2m", "1,5h", "one hour"]) {
      expect(parseDuration(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(durOf(null)).toBeNull();
    expect(durOf(true)).toBeNull();
    expect(durOf(undefined)).toBeNull();
    expect(durOf({})).toBeNull();
  });
});

describe("dates — plus / minus", () => {
  it("seconds: date-only stays date-only for whole days, else a UTC datetime", () => {
    expect(plusMinus("2026-01-31", 86400, 1)).toBe("2026-02-01");
    expect(plusMinus("2026-01-31", 2 * 86400, 1)).toBe("2026-02-02");
    expect(plusMinus("2026-01-31", 3600, 1)).toBe("2026-01-31T01:00:00Z");
    expect(plusMinus("2026-01-31", 30 * 86400, 1)).toBe("2026-03-02"); // dur("1 month") is 30 days
    expect(plusMinus("2026-01-31", 0, 1)).toBe("2026-01-31");
    expect(plusMinus("2026-01-01", 86400, -1)).toBe("2025-12-31");
    expect(plusMinus("2026-01-01", -86400, 1)).toBe("2025-12-31");
  });

  it("a duration string is calendar-aware in the month/year part, clamping the day", () => {
    expect(plusMinus("2026-01-31", "1 month", 1)).toBe("2026-02-28");
    expect(plusMinus("2024-01-31", "1 month", 1)).toBe("2024-02-29");
    expect(plusMinus("2026-03-31", "1 month", -1)).toBe("2026-02-28");
    expect(plusMinus("2026-02-28", "1 year", 1)).toBe("2027-02-28");
    expect(plusMinus("2024-02-29", "1 year", 1)).toBe("2025-02-28");
    expect(plusMinus("2026-01-31", "1 month 1 day", 1)).toBe("2026-03-01");
    expect(plusMinus("2026-01-31", "P1M", 1)).toBe("2026-02-28");
    expect(plusMinus("2026-11-15", "3 months", 1)).toBe("2027-02-15");
    expect(plusMinus("2026-01-15", "13 months", -1)).toBe("2024-12-15");
    expect(plusMinus("2026-01-31T09:00:00Z", "1 month", 1)).toBe("2026-02-28T09:00:00Z");
    expect(plusMinus("2026-01-31T09:00:00+02:00", "1 month", 1)).toBe("2026-02-28T09:00:00+02:00");
    expect(plusMinus("2026-01-31", "-1 month", 1)).toBe("2025-12-31");
    // a fractional month or year is not calendar: its fraction is 30-day / 365-day seconds
    expect(plusMinus("2026-01-01", "0.5 months", 1)).toBe("2026-01-16");
    expect(plusMinus("2026-01-01", "1.5 years", 1)).toBe("2027-07-02T12:00:00Z"); // 1 calendar year, then 182.5 days
    expect(plusMinus("2026-01-01", "1.5 years", 1)).toBe(plusMinus("2027-01-01", 182.5 * 86400, 1));
  });

  it("a datetime keeps its offset and shows a fraction when one appears", () => {
    expect(plusMinus("2026-10-15T09:00:00Z", 5400, 1)).toBe("2026-10-15T10:30:00Z");
    expect(plusMinus("2026-10-15T09:00:00+02:00", 86400, 1)).toBe("2026-10-16T09:00:00+02:00");
    expect(plusMinus("2026-10-15T23:30:00Z", 3600, 1)).toBe("2026-10-16T00:30:00Z");
    expect(plusMinus("2026-10-15T09:00:00Z", 0.5, 1)).toBe("2026-10-15T09:00:00.500Z");
    expect(plusMinus("2026-10-15T09:00:00.000Z", 60, 1)).toBe("2026-10-15T09:01:00.000Z");
    expect(plusMinus("2026-10-15T09:00:00Z", 1, -1)).toBe("2026-10-15T08:59:59Z");
    expect(plusMinus("2026-01-01", 0.5, 1)).toBe("2026-01-01T00:00:00.500Z");
  });

  it("is total: absent on a non-date receiver or a non-duration argument", () => {
    expect(plusMinus("x", 1, 1)).toBeNull();
    expect(plusMinus("2026-01-01", "bogus", 1)).toBeNull();
    expect(plusMinus("2026-01-01", null, 1)).toBeNull();
    expect(plusMinus(undefined, 1, 1)).toBeNull();
    expect(plusMinus(5, 1, 1)).toBeNull();
    expect(plusMinus("2026-01-01", Number.NaN, 1)).toBeNull();
  });

  it("shiftDate keeps the receiver's fraction flag", () => {
    const d = parseDate("2026-10-15T09:00:00.000Z")!;
    expect(renderDate(shiftDate(d, 0, 60))).toBe("2026-10-15T09:01:00.000Z");
    expect(renderDate(shiftDate(parseDate("2026-10-15T09:00:00Z")!, 1, 0))).toBe("2026-11-15T09:00:00Z");
  });
});

describe("dates — until, fields, format", () => {
  it("until is seconds by instant, signed, fractional, absent-propagating", () => {
    expect(until("2026-01-01", "2026-01-02")).toBe(86400);
    expect(until("2026-01-02", "2026-01-01")).toBe(-86400);
    expect(until("2026-01-01", "2026-01-01")).toBe(0);
    expect(until("2026-10-15T09:00:00Z", "2026-10-15T10:30:00Z")).toBe(5400);
    expect(until("2026-01-01T10:00:00+02:00", "2026-01-01T10:00:00Z")).toBe(7200);
    expect(until("2026-01-01", "2026-01-01T06:00:00Z")).toBe(21600);
    expect(until("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.500Z")).toBe(0.5);
    expect(until("2026-01-01", undefined)).toBeNull();
    expect(until(undefined, "2026-01-01")).toBeNull();
    expect(until("x", "2026-01-01")).toBeNull();
  });

  it("fields read the written offset; weekday is 1 = Monday … 7 = Sunday", () => {
    const f = (name: string, recv: unknown): unknown => dateMethod(name, recv, []).value;
    const d = "2026-10-15T09:05:07Z";
    expect([f("year", d), f("month", d), f("day", d), f("weekday", d), f("hour", d), f("minute", d), f("second", d)]).toEqual([2026, 10, 15, 4, 9, 5, 7]);
    expect(f("hour", "2026-10-15")).toBe(0);
    expect(f("weekday", "2026-09-21")).toBe(1);
    expect(f("weekday", "2026-09-27")).toBe(7);
    expect(f("date", d)).toBe("2026-10-15");
    expect(f("date", "2026-10-15")).toBe("2026-10-15");
    expect(f("date", "2026-10-15T23:30:00-05:00")).toBe("2026-10-15");
    expect(f("hour", "2026-10-15T23:30:00-05:00")).toBe(23);
    expect(f("second", "2026-10-15T09:05:07.900Z")).toBe(7);
    expect(f("year", undefined)).toBeNull();
    expect(f("year", "abc")).toBeNull();
    expect(f("year", 5)).toBeNull();
    expect(f("date", "2026-13-01")).toBeNull();
  });

  it("format: the token set, longest first, everything else literal", () => {
    const d = "2026-10-15T09:05:07Z";
    expect(formatDate(d, "yyyy-MM-dd HH:mm:ss")).toBe("2026-10-15 09:05:07");
    expect(formatDate(d, "EEE dd MMM yyyy")).toBe("Thu 15 Oct 2026");
    expect(formatDate(d, "dd/MM/yyyy")).toBe("15/10/2026");
    expect(formatDate(d, "MMMM")).toBe("OctM");
    expect(formatDate(d, "yyyy 'at' HH")).toBe("2026 'at' 09");
    expect(formatDate(d, "")).toBe("");
    expect(formatDate(d, "yyyyyyyy")).toBe("20262026");
    expect(formatDate("2026-01-05", "EEE")).toBe("Mon");
    expect(formatDate("2026-01-05", "HH:mm")).toBe("00:00");
    expect(formatDate("2026-10-15T23:30:00-05:00", "dd HH")).toBe("15 23");
    expect(formatDate("2026-12-31", "MMM EEE")).toBe("Dec Thu");
    expect(formatDate(d, 5)).toBeNull();
    expect(formatDate(undefined, "yyyy")).toBeNull();
    expect(formatDate("x", "yyyy")).toBeNull();
  });
});

describe("durations — dur_text / dur_iso", () => {
  it("dur_text", () => {
    expect(durText(5400)).toBe("1h 30m");
    expect(durText(2 * 86400 + 3 * 3600)).toBe("2d 3h");
    expect(durText(45)).toBe("45s");
    expect(durText(0)).toBe("0s");
    expect(durText(-90)).toBe("-1m 30s");
    expect(durText(1.5)).toBe("1.5s");
    expect(durText(604800)).toBe("7d");
    expect(durText(86401)).toBe("1d 1s");
    expect(durText(0.0004)).toBe("0s");
    expect(durText("x")).toBeNull();
    expect(durText(undefined)).toBeNull();
    expect(durText(Number.NaN)).toBeNull();
  });

  it("dur_iso", () => {
    expect(durIso(5400)).toBe("PT1H30M");
    expect(durIso(2 * 86400 + 3 * 3600)).toBe("P2DT3H");
    expect(durIso(45)).toBe("PT45S");
    expect(durIso(0)).toBe("PT0S");
    expect(durIso(-90)).toBe("-PT1M30S");
    expect(durIso(30 * 86400)).toBe("P30D");
    expect(durIso(86400)).toBe("P1D");
    expect(durIso(1.5)).toBe("PT1.5S");
    expect(durIso("x")).toBeNull();
    expect(durIso(undefined)).toBeNull();
  });

  it("round-trips through dur()", () => {
    for (const n of [0, 1, 45, 5400, 86401, 2 * 86400 + 3 * 3600, 1.5]) {
      expect(durOf(durIso(n))).toBe(n);
      expect(durOf(durText(n))).toBe(n);
    }
  });
});

describe("dates — the OQX arms", () => {
  it("dateFunction: date/dur handled, anything else deferred, arity is the one error", () => {
    expect(dateFunction("date", ["2026-01-05"], NOW)).toEqual({ handled: true, value: "2026-01-05" });
    expect(dateFunction("date", ["today"], NOW)).toEqual({ handled: true, value: "2026-09-27" });
    expect(dateFunction("dur", ["1h"])).toEqual({ handled: true, value: 3600 });
    expect(dateFunction("size", [[]])).toEqual({ handled: false });
    expect(() => dateFunction("date", [])).toThrow(FilterInvalid);
    expect(() => dateFunction("date", ["a", "b"])).toThrow(/date\(\) takes exactly 1 argument, got 2/);
    expect(() => dateFunction("dur", [])).toThrow(/dur\(\) takes exactly 1 argument, got 0/);
  });

  it("dateMethod: every method handled on its receiver kind, total on others, arity checked", () => {
    expect(dateMethod("plus", "2026-01-01", [86400])).toEqual({ handled: true, value: "2026-01-02" });
    expect(dateMethod("minus", "2026-01-01", ["1 day"])).toEqual({ handled: true, value: "2025-12-31" });
    expect(dateMethod("until", "2026-01-01", ["2026-01-02"])).toEqual({ handled: true, value: 86400 });
    expect(dateMethod("format", "2026-01-01", ["yyyy"])).toEqual({ handled: true, value: "2026" });
    expect(dateMethod("dur_text", 5400, [])).toEqual({ handled: true, value: "1h 30m" });
    expect(dateMethod("dur_iso", 5400, [])).toEqual({ handled: true, value: "PT1H30M" });
    expect(dateMethod("dur_text", "2026-01-01", [])).toEqual({ handled: true, value: null });
    expect(dateMethod("plus", 5, [1])).toEqual({ handled: true, value: null });
    expect(dateMethod("lower", "X", [])).toEqual({ handled: false });
    expect(() => dateMethod("plus", "2026-01-01", [])).toThrow(/\.plus\(\) takes exactly 1 argument, got 0/);
    expect(() => dateMethod("dur_text", 1, [1])).toThrow(/\.dur_text\(\) takes exactly 0 arguments, got 1/);
    expect(() => dateMethod("year", "2026-01-01", [1])).toThrow(FilterInvalid);
    for (const name of Object.keys(DATE_METHODS)) {
      const args = new Array<unknown>(DATE_METHODS[name]!).fill(1);
      expect(dateMethod(name, undefined, args).handled, name).toBe(true);
    }
  });
});

describe("dates — the constant fold (run.ts)", () => {
  const expr = (src: string): Expr => parse(`from docs where ${src}`).where!.kind === "scalar" ? (parse(`from docs where ${src}`).where as { expr: Expr }).expr : (() => { throw new Error("not a scalar where"); })();
  const fold = (src: string): Expr => {
    // fold inside-out as `transform` does: children first
    const go = (e: Expr): Expr => {
      if (e.kind !== "call") return e;
      return foldDates({ ...e, recv: e.recv === null ? null : go(e.recv), args: e.args.map(go) });
    };
    return go(expr(src));
  };

  it("folds date()/dur() over literals and date methods over literal receivers and arguments", () => {
    const restore = pin(NOW);
    try {
      expect(fold('date("2026-01-05")')).toEqual(build.lit("2026-01-05"));
      expect(fold('date("today")')).toEqual(build.lit("2026-09-27"));
      expect(fold('dur("30 days")')).toEqual(build.lit(30 * 86400));
      expect(fold('date("today").minus(dur("30 days"))')).toEqual(build.lit("2026-08-28"));
      expect(fold('date("x")')).toEqual(build.lit(null));
      expect(fold('date(5)')).toEqual(build.lit(null));
      expect(fold('dur(60).dur_text()')).toEqual(build.lit("1m"));
    } finally {
      restore();
    }
  });

  it("leaves a non-literal argument, an unknown name and a wrong arity in place", () => {
    expect(fold("date(when)").kind).toBe("call");
    expect(fold('date("today").until(when)').kind).toBe("call");
    expect(fold('size("x")').kind).toBe("call");
    expect(fold("date()").kind).toBe("call");
    expect(fold('date("2026-01-01").plus()').kind).toBe("call");
    expect(fold('"x".lower()').kind).toBe("call");
  });
});

// A local pin for the fold test: `Date.now()` is what `dateOf` reads by default.
function pin(ms: number): () => void {
  const real = Date.now;
  Date.now = () => ms;
  return () => { Date.now = real; };
}
