//! Dates and durations for the query binding (`spec/surface` §1.3 "Dates and
//! durations", 4.8): the Dataview-parity function set, served as omgbase HOST
//! functions through `oqx`'s `call_function` / `call_method` seam. Port of the
//! reference's `oqx-js/dates.ts`, function for function.
//!
//! Two value conventions and no new value kinds:
//!   • a DATE is an ISO-8601 string — `YYYY-MM-DD` (date-only) or
//!     `YYYY-MM-DDThh:mm:ss[.fff](Z|±hh:mm)` — exactly what the store writes
//!     for `updated_at`/`ts` and what OQX already orders chronologically by
//!     code point (`spec/oqx` SEMANTICS §6);
//!   • a DURATION is a number of seconds.
//!
//! Arithmetic between them is METHODS (`d.plus(s)`, `a.until(b)`), never the
//! `+`/`-` operators: `+` with a string operand concatenates (SEMANTICS §7),
//! so `"2026-01-05" + 86400` is `"2026-01-0586400"` and must stay so.
//!
//! Everything is total: a value that is not a date (or a duration) yields
//! absent (`Null`), so a `where` over mixed data filters quietly. Only a wrong
//! ARITY is an error (`filter_invalid`, the surface's eval error). The one
//! impure input — the named points `today`, `now`, `sow`… — reads the HOST
//! clock, UTC, as the instant `now_ms` the caller threads in: the `Surface`
//! passes the clock it stamps commits with (`OMGBASE_SPEC_CLOCK` pins it; the
//! fixtures run under the corpus clock, so `date("today")` is `2026-09-27`
//! there). The language itself has no clock.
//!
//! The pure half (parse / render / shift / until / fields / format / the
//! duration grammar) is public for the unit tests; the two arms at the bottom
//! ([`date_function`], [`date_method`]) are what `context.rs` and the constant
//! fold in `query.rs` call. Calendar arithmetic is done by hand (proleptic
//! Gregorian, days-from-civil) — no date crate, no new dependency.

use oqx::{OqxError, Value};

// ---- the date value -------------------------------------------------------------

/// A parsed date: the instant (milliseconds since the Unix epoch), the offset
/// it was WRITTEN in (minutes east of UTC; `0` for `Z` and for a date-only
/// value), whether it is date-only, and whether it carried a fraction of a
/// second as written (kept on render).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DateValue {
    pub ms: i64,
    pub offset: i64,
    pub date_only: bool,
    pub fraction: bool,
}

const DAY_MS: i64 = 86_400_000;
const MINUTE_MS: i64 = 60_000;

/// Days since 1970-01-01 of a proleptic Gregorian civil date (Hinnant's
/// `days_from_civil`; `month` 1–12, `day` 1–31 — an out-of-range day rolls
/// over, as `Date.UTC` does).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date `(year, month, day)` of a day count since 1970-01-01
/// (Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `Date.UTC(year, month - 1, day, hour, minute, second, millis)`.
fn utc_ms(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    millis: i64,
) -> i64 {
    days_from_civil(year, month, day) * DAY_MS
        + hour * 3_600_000
        + minute * MINUTE_MS
        + second * 1000
        + millis
}

/// The day of the week of a day count: 0 = Sunday … 6 = Saturday
/// (`getUTCDay`; 1970-01-01 was a Thursday).
fn dow_of_days(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

/// `n` ASCII digits at the head of `s`: their value and the rest.
fn digits(s: &str, n: usize) -> Option<(i64, &str)> {
    let b = s.as_bytes();
    if b.len() < n || !b[..n].iter().all(u8::is_ascii_digit) {
        return None;
    }
    // All ASCII digits, so `n` is a char boundary.
    Some((s[..n].parse().ok()?, &s[n..]))
}

/// Parse an ISO-8601 date / datetime string; `None` for anything else (a
/// non-string, a malformed string, an out-of-range field such as month 13 or
/// hour 24). The shape: `YYYY-MM-DD`, optionally `T`/`t`/space +
/// `hh:mm[:ss[.fff…]]` + an optional offset (`Z`, `±hh:mm`, `±hhmm`); a time
/// without an offset is UTC; the fraction (1–9 digits, `.` or `,`) is
/// truncated to milliseconds.
#[must_use]
pub fn parse_date(x: &Value) -> Option<DateValue> {
    let Value::Str(s) = x else { return None };
    let s = s.trim();
    let (year, s) = digits(s, 4)?;
    let s = s.strip_prefix('-')?;
    let (month, s) = digits(s, 2)?;
    let s = s.strip_prefix('-')?;
    let (day, s) = digits(s, 2)?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if s.is_empty() {
        return Some(DateValue {
            ms: utc_ms(year, month, day, 0, 0, 0, 0),
            offset: 0,
            date_only: true,
            fraction: false,
        });
    }
    let s = s
        .strip_prefix('T')
        .or_else(|| s.strip_prefix('t'))
        .or_else(|| s.strip_prefix(' '))?;
    let (hour, s) = digits(s, 2)?;
    let s = s.strip_prefix(':')?;
    let (minute, s) = digits(s, 2)?;
    let (second, fraction, millis, s) = match s.strip_prefix(':') {
        Some(rest) => {
            let (second, rest) = digits(rest, 2)?;
            match rest.strip_prefix('.').or_else(|| rest.strip_prefix(',')) {
                Some(after) => {
                    let n = after.bytes().take_while(u8::is_ascii_digit).count();
                    if !(1..=9).contains(&n) {
                        return None;
                    }
                    let frac = &after[..n];
                    let mut three = String::from(&frac[..n.min(3)]);
                    while three.len() < 3 {
                        three.push('0');
                    }
                    (second, true, three.parse::<i64>().ok()?, &after[n..])
                }
                None => (second, false, 0, rest),
            }
        }
        None => (0, false, 0, s),
    };
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let mut offset = 0;
    let s = if let Some(rest) = s.strip_prefix('Z').or_else(|| s.strip_prefix('z')) {
        rest
    } else if let Some(sign) = s.chars().next().filter(|c| *c == '+' || *c == '-') {
        let rest = &s[1..];
        let (oh, rest) = digits(rest, 2)?;
        let rest = rest.strip_prefix(':').unwrap_or(rest);
        let (om, rest) = digits(rest, 2)?;
        if oh > 23 || om > 59 {
            return None;
        }
        offset = (oh * 60 + om) * if sign == '-' { -1 } else { 1 };
        rest
    } else {
        s
    };
    if !s.is_empty() {
        return None;
    }
    let local = utc_ms(year, month, day, hour, minute, second, millis);
    Some(DateValue {
        ms: local - offset * MINUTE_MS,
        offset,
        date_only: false,
        fraction,
    })
}

/// The fields of a value in the offset it was written in (`weekday` 1 =
/// Monday … 7 = Sunday).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fields {
    pub year: i64,
    pub month: i64,
    pub day: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub millis: i64,
    pub weekday: i64,
}

/// The fields of the value in the offset it was written in.
#[must_use]
pub fn fields_of(d: &DateValue) -> Fields {
    let t = d.ms + d.offset * MINUTE_MS;
    let days = t.div_euclid(DAY_MS);
    let rem = t.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    Fields {
        year,
        month,
        day,
        hour: rem / 3_600_000,
        minute: rem % 3_600_000 / MINUTE_MS,
        second: rem % MINUTE_MS / 1000,
        millis: rem % 1000,
        weekday: (dow_of_days(days) + 6) % 7 + 1,
    }
}

/// The canonical string: `YYYY-MM-DD` for a date-only value; otherwise
/// `YYYY-MM-DDThh:mm:ss` + `.fff` when the value carries a fraction (as
/// written, or because arithmetic produced one) + `Z` for UTC or the written
/// `±hh:mm`.
#[must_use]
pub fn render_date(d: &DateValue) -> String {
    let f = fields_of(d);
    let ymd = format!("{:04}-{:02}-{:02}", f.year, f.month, f.day);
    if d.date_only {
        return ymd;
    }
    let mut s = format!("{ymd}T{:02}:{:02}:{:02}", f.hour, f.minute, f.second);
    if d.fraction || f.millis != 0 {
        s.push_str(&format!(".{:03}", f.millis));
    }
    if d.offset == 0 {
        s.push('Z');
    } else {
        let a = d.offset.abs();
        s.push_str(&format!(
            "{}{:02}:{:02}",
            if d.offset < 0 { '-' } else { '+' },
            a / 60,
            a % 60
        ));
    }
    s
}

/// `date(x)` on a string that is not a named point: the canonical form, or `None`.
#[must_use]
pub fn canonical_date(x: &Value) -> Option<String> {
    parse_date(x).as_ref().map(render_date)
}

// ---- named points (the host clock, UTC) --------------------------------------------

/// The named points `date()` resolves against the clock.
pub const NAMED_POINTS: [&str; 10] = [
    "now",
    "today",
    "yesterday",
    "tomorrow",
    "sow",
    "eow",
    "som",
    "eom",
    "soy",
    "eoy",
];

const fn date_only(ms: i64) -> DateValue {
    DateValue {
        ms,
        offset: 0,
        date_only: true,
        fraction: false,
    }
}

/// Resolve a named point at the instant `now_ms` (UTC): `now` is the instant
/// with milliseconds (the form the store stamps commits in); the others are
/// date-only — `sow`/`eow` the Monday/Sunday of the current week, `som`/`eom`
/// the first/last day of the month, `soy`/`eoy` of the year. `None` for a
/// name that is not a point.
#[must_use]
pub fn named_point(name: &str, now_ms: i64) -> Option<DateValue> {
    let days = now_ms.div_euclid(DAY_MS);
    let (y, mo, _) = civil_from_days(days);
    let today = days * DAY_MS;
    let dow = dow_of_days(days);
    Some(match name {
        "now" => DateValue {
            ms: now_ms,
            offset: 0,
            date_only: false,
            fraction: true,
        },
        "today" => date_only(today),
        "yesterday" => date_only(today - DAY_MS),
        "tomorrow" => date_only(today + DAY_MS),
        "sow" => date_only(today - ((dow + 6) % 7) * DAY_MS),
        "eow" => date_only(today + (6 - (dow + 6) % 7) * DAY_MS),
        "som" => date_only(utc_ms(y, mo, 1, 0, 0, 0, 0)),
        "eom" => date_only(utc_ms(y, mo, days_in_month(y, mo), 0, 0, 0, 0)),
        "soy" => date_only(utc_ms(y, 1, 1, 0, 0, 0, 0)),
        "eoy" => date_only(utc_ms(y, 12, 31, 0, 0, 0, 0)),
        _ => return None,
    })
}

/// `date(x)`: a named point against the clock, else the canonical ISO form, else `None`.
#[must_use]
pub fn date_of(x: &Value, now_ms: i64) -> Option<String> {
    let Value::Str(s) = x else { return None };
    let key = s.trim().to_lowercase();
    if NAMED_POINTS.contains(&key.as_str()) {
        return named_point(&key, now_ms).as_ref().map(render_date);
    }
    canonical_date(x)
}

// ---- durations -------------------------------------------------------------------

/// A parsed duration: the calendar counts `years` and `months` kept apart
/// from the fixed-length `seconds`, so `plus` can be calendar-aware while
/// `dur()` applies the 365-day / 30-day conventions.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Duration {
    pub years: f64,
    pub months: f64,
    pub seconds: f64,
}

/// Days per month / year under the fixed conventions `dur()` applies.
pub const MONTH_SECONDS: f64 = 30.0 * 86_400.0;
pub const YEAR_SECONDS: f64 = 365.0 * 86_400.0;

fn unit_seconds(unit: &str) -> Option<f64> {
    Some(match unit {
        "w" | "wk" | "wks" | "week" | "weeks" => 604_800.0,
        "d" | "day" | "days" => 86_400.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 60.0,
        "s" | "sec" | "secs" | "second" | "seconds" => 1.0,
        _ => return None,
    })
}

fn is_year_unit(unit: &str) -> bool {
    matches!(unit, "y" | "yr" | "yrs" | "year" | "years")
}

fn is_month_unit(unit: &str) -> bool {
    matches!(unit, "mo" | "mos" | "month" | "months")
}

/// An unsigned decimal `\d+(?:\.\d+)?` at the head of `s`: its value and the rest.
fn take_number(s: &str) -> Option<(f64, &str)> {
    let int = s.bytes().take_while(u8::is_ascii_digit).count();
    if int == 0 {
        return None;
    }
    let mut end = int;
    if s[end..].starts_with('.') {
        let frac = s[end + 1..].bytes().take_while(u8::is_ascii_digit).count();
        if frac > 0 {
            end += 1 + frac;
        }
    }
    Some((s[..end].parse().ok()?, &s[end..]))
}

/// One ISO component `<number><designator>` at the head of `s` (the
/// designator case-insensitive); the number and the rest, or `None` when the
/// head is not that component (nothing consumed).
fn iso_component(s: &str, designator: char) -> Option<(f64, &str)> {
    let (n, rest) = take_number(s)?;
    let c = rest.chars().next()?;
    if c.eq_ignore_ascii_case(&designator) {
        Some((n, &rest[1..]))
    } else {
        None
    }
}

/// The ISO-8601 duration `[+-]PnYnMnWnDTnHnMnS` (components in order, any
/// omitted, decimals allowed, case-insensitive). `Err(())` when `s` is not
/// of that shape at all; `Ok(None)` when it is but names no component (a
/// bare `P` / `PT`).
fn parse_iso_duration(s: &str) -> Result<Option<Duration>, ()> {
    let (sign, rest) = match s.strip_prefix('-') {
        Some(r) => (-1.0, r),
        None => (1.0, s.strip_prefix('+').unwrap_or(s)),
    };
    let mut rest = rest
        .strip_prefix('P')
        .or_else(|| rest.strip_prefix('p'))
        .ok_or(())?;
    let mut parts = [None; 7];
    for (i, designator) in ['Y', 'M', 'W', 'D'].into_iter().enumerate() {
        if let Some((n, r)) = iso_component(rest, designator) {
            parts[i] = Some(n);
            rest = r;
        }
    }
    if let Some(r) = rest.strip_prefix('T').or_else(|| rest.strip_prefix('t')) {
        rest = r;
        for (i, designator) in ['H', 'M', 'S'].into_iter().enumerate() {
            if let Some((n, r)) = iso_component(rest, designator) {
                parts[4 + i] = Some(n);
                rest = r;
            }
        }
    }
    if !rest.is_empty() {
        return Err(());
    }
    if parts.iter().all(Option::is_none) {
        return Ok(None);
    }
    let n = |i: usize| parts[i].unwrap_or(0.0);
    Ok(Some(Duration {
        years: sign * n(0),
        months: sign * n(1),
        seconds: sign * (n(2) * 604_800.0 + n(3) * 86_400.0 + n(4) * 3600.0 + n(5) * 60.0 + n(6)),
    }))
}

/// Parse a duration string: Dataview's `<number> <unit>` pairs, each pair
/// separated from the next by spaces, a comma, or nothing (`"1h30m"`, `"2
/// days, 3 hours"`; a trailing separator is malformed), units
/// case-insensitive: y|yr|yrs|year|years, mo|mos|month|months,
/// w|wk|wks|week|weeks, d|day|days, h|hr|hrs|hour|hours,
/// m|min|mins|minute|minutes, s|sec|secs|second|seconds — or an ISO-8601
/// duration (`P1DT2H`, `PT90M`, `P2W`). `None` when it is neither.
#[must_use]
pub fn parse_duration(x: &Value) -> Option<Duration> {
    let Value::Str(s) = x else { return None };
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(iso) = parse_iso_duration(s) {
        return iso;
    }
    let mut rest = s;
    let mut d = Duration {
        years: 0.0,
        months: 0.0,
        seconds: 0.0,
    };
    loop {
        // `^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)`
        let (sign, after_sign) = match rest.strip_prefix('-') {
            Some(r) => (-1.0, r),
            None => (1.0, rest),
        };
        let (n, after_num) = take_number(after_sign)?;
        let after_space = after_num.trim_start();
        let unit_len = after_space
            .bytes()
            .take_while(u8::is_ascii_alphabetic)
            .count();
        if unit_len == 0 {
            return None;
        }
        let unit = after_space[..unit_len].to_ascii_lowercase();
        let n = sign * n;
        if let Some(secs) = unit_seconds(&unit) {
            d.seconds += n * secs;
        } else if is_month_unit(&unit) {
            d.months += n;
        } else if is_year_unit(&unit) {
            d.years += n;
        } else {
            return None;
        }
        rest = &after_space[unit_len..];
        if rest.is_empty() {
            break;
        }
        // the separator: spaces, one comma among them, or none at all (`1h30m`)
        rest = rest.trim_start();
        rest = rest.strip_prefix(',').unwrap_or(rest).trim_start();
        if rest.is_empty() {
            return None;
        }
    }
    Some(d)
}

/// A duration's length in seconds under the conventions: a year is 365 days, a month 30.
#[must_use]
pub fn duration_seconds(d: &Duration) -> f64 {
    d.years * YEAR_SECONDS + d.months * MONTH_SECONDS + d.seconds
}

/// `dur(x)`: a number is that many seconds; a string is parsed; else `None`.
#[must_use]
pub fn dur_of(x: &Value) -> Option<f64> {
    match x {
        Value::Number(n) => n.is_finite().then_some(*n),
        other => parse_duration(other).as_ref().map(duration_seconds),
    }
}

// ---- arithmetic -------------------------------------------------------------------

/// JavaScript's `Math.round`: half rounds toward +∞.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Shift a date by a whole number of calendar `months` (the month field moves
/// and the day is clamped to the new month's length) and then by `seconds`.
/// A date-only value stays date-only when the seconds are a whole number of
/// days; otherwise it becomes a datetime in its offset (UTC for a date-only
/// receiver).
#[must_use]
pub fn shift_date(d: &DateValue, months: i64, seconds: f64) -> DateValue {
    let mut ms = d.ms;
    if months != 0 {
        let f = fields_of(d);
        let total = f.year * 12 + (f.month - 1) + months;
        let year = total.div_euclid(12);
        let month = total.rem_euclid(12) + 1;
        let day = f.day.min(days_in_month(year, month));
        ms = utc_ms(year, month, day, f.hour, f.minute, f.second, f.millis) - d.offset * MINUTE_MS;
    }
    // Saturating on the way to i64: a shift this large is absurd anyway.
    let delta_ms = js_round(seconds * 1000.0) as i64;
    ms += delta_ms;
    DateValue {
        ms,
        offset: d.offset,
        date_only: d.date_only && delta_ms % DAY_MS == 0,
        fraction: d.fraction,
    }
}

/// The argument of `plus`/`minus` as a duration: a number of seconds (never
/// calendar) or a duration string (months/years calendar-aware). `None` otherwise.
fn duration_arg(x: &Value) -> Option<Duration> {
    match x {
        Value::Number(n) => n.is_finite().then_some(Duration {
            years: 0.0,
            months: 0.0,
            seconds: *n,
        }),
        other => parse_duration(other),
    }
}

/// A duration as `plus` applies it: the WHOLE years and months are calendar
/// months; a fractional year or month count is not calendar — its fraction is
/// 365-day / 30-day seconds — and joins the fixed-length seconds.
#[must_use]
pub fn calendar_parts(dur: &Duration) -> (i64, f64) {
    let wy = dur.years.trunc();
    let wm = dur.months.trunc();
    (
        (wy * 12.0 + wm) as i64,
        dur.seconds + (dur.years - wy) * YEAR_SECONDS + (dur.months - wm) * MONTH_SECONDS,
    )
}

/// `d.plus(x)` (`sign` 1) / `d.minus(x)` (`sign` -1).
#[must_use]
pub fn plus_minus(recv: &Value, arg: &Value, sign: i64) -> Option<String> {
    let d = parse_date(recv)?;
    let dur = duration_arg(arg)?;
    let (months, seconds) = calendar_parts(&dur);
    Some(render_date(&shift_date(
        &d,
        sign * months,
        sign as f64 * seconds,
    )))
}

/// `a.until(b)`: seconds from `a` to `b` (negative when `b` is earlier), by instant.
#[must_use]
pub fn until(a: &Value, b: &Value) -> Option<f64> {
    let da = parse_date(a)?;
    let db = parse_date(b)?;
    Some((db.ms - da.ms) as f64 / 1000.0)
}

// ---- format -------------------------------------------------------------------------

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/// The `format` tokens, longest first (a scan takes the longest token at each position).
const FORMAT_TOKENS: [&str; 8] = ["yyyy", "MMM", "EEE", "MM", "dd", "HH", "mm", "ss"];

/// `d.format(pattern)`: `yyyy` year, `MM` month, `dd` day, `HH` hour, `mm`
/// minute, `ss` second (two digits each), `MMM` the English month
/// abbreviation (`Jan`), `EEE` the English weekday abbreviation (`Mon`);
/// every other character is literal. Fields are read in the written offset;
/// a date-only value has `00` time fields.
#[must_use]
pub fn format_date(recv: &Value, pattern: &Value) -> Option<String> {
    let d = parse_date(recv)?;
    let Value::Str(pattern) = pattern else {
        return None;
    };
    let f = fields_of(&d);
    let mut out = String::new();
    let mut rest = pattern.as_str();
    while !rest.is_empty() {
        match FORMAT_TOKENS.iter().find(|t| rest.starts_with(**t)) {
            Some(tok) => {
                match *tok {
                    "yyyy" => out.push_str(&format!("{:04}", f.year)),
                    "MMM" => out.push_str(MONTHS[(f.month - 1) as usize]),
                    "EEE" => out.push_str(WEEKDAYS[(f.weekday - 1) as usize]),
                    "MM" => out.push_str(&format!("{:02}", f.month)),
                    "dd" => out.push_str(&format!("{:02}", f.day)),
                    "HH" => out.push_str(&format!("{:02}", f.hour)),
                    "mm" => out.push_str(&format!("{:02}", f.minute)),
                    _ => out.push_str(&format!("{:02}", f.second)),
                }
                rest = &rest[tok.len()..];
            }
            None => {
                let c = rest.chars().next()?;
                out.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    Some(out)
}

// ---- duration rendering -----------------------------------------------------------------

struct Split {
    neg: bool,
    d: f64,
    h: f64,
    m: f64,
    s: f64,
}

fn split_seconds(n: f64) -> Split {
    let neg = n < 0.0;
    let a = js_round(n.abs() * 1000.0) / 1000.0;
    Split {
        neg,
        d: (a / 86_400.0).floor(),
        h: (a % 86_400.0 / 3600.0).floor(),
        m: (a % 3600.0 / 60.0).floor(),
        s: js_round(a % 60.0 * 1000.0) / 1000.0,
    }
}

/// A number as JavaScript prints it (`2`, `1.5`).
fn num(n: f64) -> String {
    Value::Number(n).to_string()
}

/// `n.dur_text()`: `"2d 3h"`, `"1h 30m"`, `"45s"` — days, hours, minutes,
/// seconds, zero parts omitted, `"0s"` for zero, a leading `-` for a negative
/// duration, a fractional second kept (`"1.5s"`). `None` for a non-number.
#[must_use]
pub fn dur_text(n: &Value) -> Option<String> {
    let Value::Number(n) = n else { return None };
    if !n.is_finite() {
        return None;
    }
    let p = split_seconds(*n);
    let mut parts = Vec::new();
    if p.d != 0.0 {
        parts.push(format!("{}d", num(p.d)));
    }
    if p.h != 0.0 {
        parts.push(format!("{}h", num(p.h)));
    }
    if p.m != 0.0 {
        parts.push(format!("{}m", num(p.m)));
    }
    if p.s != 0.0 {
        parts.push(format!("{}s", num(p.s)));
    }
    if parts.is_empty() {
        return Some("0s".to_owned());
    }
    Some(format!(
        "{}{}",
        if p.neg { "-" } else { "" },
        parts.join(" ")
    ))
}

/// `n.dur_iso()`: the ISO-8601 duration `P[nD][T[nH][nM][nS]]` — `PT1H30M`,
/// `P2DT3H`, `PT45S`, `PT0S` for zero, a leading `-` for a negative duration.
/// `None` for a non-number.
#[must_use]
pub fn dur_iso(n: &Value) -> Option<String> {
    let Value::Number(n) = n else { return None };
    if !n.is_finite() {
        return None;
    }
    let p = split_seconds(*n);
    let mut out = String::from("P");
    if p.d != 0.0 {
        out.push_str(&format!("{}D", num(p.d)));
    }
    if p.h != 0.0 || p.m != 0.0 || p.s != 0.0 {
        out.push('T');
        if p.h != 0.0 {
            out.push_str(&format!("{}H", num(p.h)));
        }
        if p.m != 0.0 {
            out.push_str(&format!("{}M", num(p.m)));
        }
        if p.s != 0.0 {
            out.push_str(&format!("{}S", num(p.s)));
        }
    }
    if out == "P" {
        out = "PT0S".to_owned();
    }
    Some(format!("{}{out}", if p.neg { "-" } else { "" }))
}

// ---- the clock --------------------------------------------------------------------------

/// The process wall clock in milliseconds since the Unix epoch — what a
/// caller without a pinned clock resolves the named points against.
#[must_use]
pub fn wall_clock_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// A clock stamp (`YYYY-MM-DDThh:mm:ss.fffZ`, the form the `Surface` stamps
/// commits in; any ISO datetime accepted) as milliseconds, or the wall clock
/// when it does not parse.
#[must_use]
pub fn stamp_ms(ts: &str) -> i64 {
    parse_date(&Value::Str(ts.to_owned())).map_or_else(wall_clock_ms, |d| d.ms)
}

// ---- the OQX arms ---------------------------------------------------------------------

/// The free functions and their arity.
pub const DATE_FUNCTIONS: [(&str, usize); 2] = [("date", 1), ("dur", 1)];
/// The methods and their arity: on a date string, and (`dur_text`/`dur_iso`) on a number.
pub const DATE_METHODS: [(&str, usize); 14] = [
    ("plus", 1),
    ("minus", 1),
    ("until", 1),
    ("format", 1),
    ("year", 0),
    ("month", 0),
    ("day", 0),
    ("weekday", 0),
    ("hour", 0),
    ("minute", 0),
    ("second", 0),
    ("date", 0),
    ("dur_text", 0),
    ("dur_iso", 0),
];

/// The arity of `date`/`dur`, or `None` for any other name.
#[must_use]
pub fn date_function_arity(name: &str) -> Option<usize> {
    DATE_FUNCTIONS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, a)| *a)
}

/// The arity of a date method, or `None` for any other name.
#[must_use]
pub fn date_method_arity(name: &str) -> Option<usize> {
    DATE_METHODS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, a)| *a)
}

fn arity(spelling: &str, want: usize, got: usize) -> Result<(), OqxError> {
    if got == want {
        Ok(())
    } else {
        Err(OqxError::eval(format!(
            "{spelling} takes exactly {want} argument{}, got {got}",
            if want == 1 { "" } else { "s" }
        )))
    }
}

fn str_or_null(s: Option<String>) -> Value {
    s.map_or(Value::Null, Value::Str)
}

fn num_or_null(n: Option<f64>) -> Value {
    n.map_or(Value::Null, Value::Number)
}

/// `call_function` arm: `date(x)` / `dur(x)`; `None` for any other name.
#[must_use]
pub fn date_function(name: &str, args: &[Value], now_ms: i64) -> Option<oqx::Result<Value>> {
    let want = date_function_arity(name)?;
    if let Err(e) = arity(&format!("{name}()"), want, args.len()) {
        return Some(Err(e));
    }
    let x = args.first().unwrap_or(&Value::Undefined);
    Some(Ok(if name == "date" {
        str_or_null(date_of(x, now_ms))
    } else {
        num_or_null(dur_of(x))
    }))
}

/// `call_method` arm: the date methods on a string receiver and the duration
/// renderers on a number; a receiver of any other kind yields absent (the
/// methods are total). `None` for any other name.
#[must_use]
pub fn date_method(name: &str, recv: &Value, args: &[Value]) -> Option<oqx::Result<Value>> {
    let want = date_method_arity(name)?;
    if let Err(e) = arity(&format!(".{name}()"), want, args.len()) {
        return Some(Err(e));
    }
    let arg = args.first().unwrap_or(&Value::Undefined);
    let field = |pick: fn(&Fields) -> i64| {
        num_or_null(parse_date(recv).map(|d| pick(&fields_of(&d)) as f64))
    };
    Some(Ok(match name {
        "plus" => str_or_null(plus_minus(recv, arg, 1)),
        "minus" => str_or_null(plus_minus(recv, arg, -1)),
        "until" => num_or_null(until(recv, arg)),
        "format" => str_or_null(format_date(recv, arg)),
        "year" => field(|f| f.year),
        "month" => field(|f| f.month),
        "day" => field(|f| f.day),
        "weekday" => field(|f| f.weekday),
        "hour" => field(|f| f.hour),
        "minute" => field(|f| f.minute),
        "second" => field(|f| f.second),
        "date" => str_or_null(parse_date(recv).map(|d| {
            render_date(&DateValue {
                date_only: true,
                ..d
            })
        })),
        "dur_text" => str_or_null(dur_text(recv)),
        _ => str_or_null(dur_iso(recv)),
    }))
}

#[cfg(test)]
mod tests {
    // Mirrors the reference's `dates.test.ts` (the fold's two tests live beside
    // `fold_dates` in `query.rs`).
    use super::*;

    /// 2026-09-27T00:00:00.000Z — the corpus clock, a Sunday.
    const NOW: i64 = 1_790_467_200_000;

    fn s(x: &str) -> Value {
        Value::Str(x.to_owned())
    }
    fn n(x: f64) -> Value {
        Value::Number(x)
    }
    fn canon(x: &str) -> Option<String> {
        canonical_date(&s(x))
    }
    fn utc(y: i64, mo: i64, d: i64, h: i64, mi: i64, sec: i64, ms: i64) -> i64 {
        utc_ms(y, mo, d, h, mi, sec, ms)
    }

    #[test]
    fn corpus_clock_constant_is_the_instant() {
        assert_eq!(NOW, utc(2026, 9, 27, 0, 0, 0, 0));
        assert_eq!(stamp_ms("2026-09-27T00:00:00.000Z"), NOW);
    }

    // ---- parse and render ----

    #[test]
    fn date_only_stays_date_only_and_a_datetime_is_canonical() {
        assert_eq!(canon("2026-10-15").as_deref(), Some("2026-10-15"));
        assert_eq!(
            canon("2026-10-15T09:00:00Z").as_deref(),
            Some("2026-10-15T09:00:00Z")
        );
        assert_eq!(
            canon("2026-10-15T09:00:00+00:00").as_deref(),
            Some("2026-10-15T09:00:00Z")
        );
        assert_eq!(
            canon("2026-10-15T09:00:00+02:00").as_deref(),
            Some("2026-10-15T09:00:00+02:00")
        );
        assert_eq!(
            canon("2026-10-15T09:00:00-0500").as_deref(),
            Some("2026-10-15T09:00:00-05:00")
        );
        assert_eq!(
            canon("2026-10-15T09:00").as_deref(),
            Some("2026-10-15T09:00:00Z")
        );
        assert_eq!(
            canon("2026-10-15 09:00:00").as_deref(),
            Some("2026-10-15T09:00:00Z")
        );
        assert_eq!(
            canon("2026-10-15t09:00:00z").as_deref(),
            Some("2026-10-15T09:00:00Z")
        );
        assert_eq!(
            canon("2026-10-15T09:00:00.5Z").as_deref(),
            Some("2026-10-15T09:00:00.500Z")
        );
        assert_eq!(
            canon("2026-10-15T09:00:00.123456Z").as_deref(),
            Some("2026-10-15T09:00:00.123Z")
        );
        assert_eq!(
            canon("2026-09-27T00:00:00.000Z").as_deref(),
            Some("2026-09-27T00:00:00.000Z")
        );
        assert_eq!(canon(" 2026-10-15 ").as_deref(), Some("2026-10-15"));
    }

    #[test]
    fn rejects_what_is_not_an_iso_date() {
        for bad in [
            "15/10/2026",
            "2026-13-01",
            "2026-02-30",
            "2026-00-10",
            "2026-10-15T24:00:00Z",
            "2026-10-15T09:60:00Z",
            "2026-10-15T09:00:60Z",
            "2026-10-15T09:00:00+24:00",
            "",
            "today",
            "2026-1-5",
            "20261015",
            "2026-10-15T09:00:00.Z",
            "2026-10-15T09:00:00.1234567890Z",
        ] {
            assert!(parse_date(&s(bad)).is_none(), "{bad}");
        }
        assert!(parse_date(&n(5.0)).is_none());
        assert!(parse_date(&Value::Null).is_none());
        assert!(parse_date(&Value::Undefined).is_none());
        assert!(parse_date(&Value::Bool(true)).is_none());
    }

    #[test]
    fn leap_days_parse_in_leap_years_only() {
        assert_eq!(canon("2024-02-29").as_deref(), Some("2024-02-29"));
        assert_eq!(canon("2026-02-29"), None);
        assert_eq!(canon("2000-02-29").as_deref(), Some("2000-02-29"));
        assert_eq!(canon("1900-02-29"), None);
    }

    #[test]
    fn keeps_the_written_offset_as_the_values_fields() {
        let d = parse_date(&s("2026-10-15T23:30:00-05:00")).unwrap();
        assert_eq!(d.offset, -300);
        assert_eq!(d.ms, utc(2026, 10, 16, 4, 30, 0, 0));
        assert_eq!(render_date(&d), "2026-10-15T23:30:00-05:00");
    }

    // ---- named points ----

    #[test]
    fn resolves_every_point_at_the_corpus_clock() {
        let at = |name: &str| render_date(&named_point(name, NOW).unwrap());
        assert_eq!(at("now"), "2026-09-27T00:00:00.000Z");
        assert_eq!(at("today"), "2026-09-27");
        assert_eq!(at("yesterday"), "2026-09-26");
        assert_eq!(at("tomorrow"), "2026-09-28");
        assert_eq!(at("sow"), "2026-09-21");
        assert_eq!(at("eow"), "2026-09-27");
        assert_eq!(at("som"), "2026-09-01");
        assert_eq!(at("eom"), "2026-09-30");
        assert_eq!(at("soy"), "2026-01-01");
        assert_eq!(at("eoy"), "2026-12-31");
        assert!(NAMED_POINTS.iter().all(|p| named_point(p, NOW).is_some()));
        assert!(named_point("noon", NOW).is_none());
    }

    #[test]
    fn week_and_month_edges_on_other_instants() {
        let wed = utc(2026, 10, 14, 15, 0, 0, 0); // Wednesday
        assert_eq!(render_date(&named_point("sow", wed).unwrap()), "2026-10-12");
        assert_eq!(render_date(&named_point("eow", wed).unwrap()), "2026-10-18");
        let mon = utc(2026, 10, 12, 0, 0, 0, 0);
        assert_eq!(render_date(&named_point("sow", mon).unwrap()), "2026-10-12");
        assert_eq!(
            render_date(&named_point("eom", utc(2024, 2, 10, 0, 0, 0, 0)).unwrap()),
            "2024-02-29"
        );
        assert_eq!(
            render_date(&named_point("eom", utc(2026, 12, 10, 0, 0, 0, 0)).unwrap()),
            "2026-12-31"
        );
        assert_eq!(
            render_date(&named_point("now", utc(2026, 10, 14, 15, 0, 7, 250)).unwrap()),
            "2026-10-14T15:00:07.250Z"
        );
    }

    #[test]
    fn date_of_a_named_point_trimmed_case_insensitive_else_canonical_else_none() {
        assert_eq!(date_of(&s("Today"), NOW).as_deref(), Some("2026-09-27"));
        assert_eq!(
            date_of(&s(" now "), NOW).as_deref(),
            Some("2026-09-27T00:00:00.000Z")
        );
        assert_eq!(
            date_of(&s("2026-01-05"), NOW).as_deref(),
            Some("2026-01-05")
        );
        assert_eq!(date_of(&s("nope"), NOW), None);
        assert_eq!(date_of(&n(5.0), NOW), None);
        assert_eq!(date_of(&Value::Undefined, NOW), None);
    }

    // ---- the duration grammar ----

    fn dur(x: &str) -> Option<f64> {
        dur_of(&s(x))
    }

    #[test]
    fn dataview_pairs_spaces_commas_no_spaces_every_unit_case_decimals() {
        assert_eq!(dur("1h30m"), Some(5400.0));
        assert_eq!(dur("1 hour 30 minutes"), Some(5400.0));
        assert_eq!(dur("2 days, 3 hours"), Some(2.0 * 86400.0 + 3.0 * 3600.0));
        assert_eq!(dur("1 week"), Some(604_800.0));
        assert_eq!(dur("1 month"), Some(30.0 * 86400.0));
        assert_eq!(dur("1 year"), Some(365.0 * 86400.0));
        assert_eq!(dur("90 seconds"), Some(90.0));
        assert_eq!(dur("1.5h"), Some(5400.0));
        assert_eq!(dur("2 YRS"), Some(2.0 * 365.0 * 86400.0));
        assert_eq!(dur("3 wks 2 d"), Some(3.0 * 604_800.0 + 2.0 * 86400.0));
        assert_eq!(dur("2mo"), Some(60.0 * 86400.0));
        assert_eq!(dur("5 mins, 10 secs"), Some(310.0));
        assert_eq!(
            dur("1y 1mo 1w 1d 1h 1m 1s"),
            Some(365.0 * 86400.0 + 30.0 * 86400.0 + 604_800.0 + 86400.0 + 3600.0 + 61.0)
        );
        assert_eq!(dur("-1 day"), Some(-86400.0));
    }

    #[test]
    fn iso_8601_durations_and_numbers() {
        assert_eq!(dur("PT1H30M"), Some(5400.0));
        assert_eq!(dur("P1DT2H"), Some(86400.0 + 7200.0));
        assert_eq!(dur("P2W"), Some(2.0 * 604_800.0));
        assert_eq!(dur("P1M"), Some(30.0 * 86400.0));
        assert_eq!(
            dur("P1Y2M3DT4H5M6S"),
            Some(
                365.0 * 86400.0 + 60.0 * 86400.0 + 3.0 * 86400.0 + 4.0 * 3600.0 + 5.0 * 60.0 + 6.0
            )
        );
        assert_eq!(dur("PT0S"), Some(0.0));
        assert_eq!(dur("pt90m"), Some(5400.0));
        assert_eq!(dur("-PT1H"), Some(-3600.0));
        assert_eq!(dur_of(&n(90.0)), Some(90.0));
        assert_eq!(dur_of(&n(1.5)), Some(1.5));
        assert_eq!(dur_of(&n(-60.0)), Some(-60.0));
        assert_eq!(dur_of(&n(f64::NAN)), None);
        assert_eq!(dur_of(&n(f64::INFINITY)), None);
    }

    #[test]
    fn keeps_calendar_months_apart_from_seconds() {
        assert_eq!(
            parse_duration(&s("1 year 2 months 3 days")),
            Some(Duration {
                years: 1.0,
                months: 2.0,
                seconds: 3.0 * 86400.0
            })
        );
        assert_eq!(
            parse_duration(&s("P1Y2M")),
            Some(Duration {
                years: 1.0,
                months: 2.0,
                seconds: 0.0
            })
        );
        assert_eq!(
            duration_seconds(&Duration {
                years: 1.0,
                months: 1.0,
                seconds: 1.0
            }),
            365.0 * 86400.0 + 30.0 * 86400.0 + 1.0
        );
    }

    #[test]
    fn rejects_what_is_not_a_duration() {
        for bad in [
            "",
            "   ",
            "abc",
            "3 fortnights",
            "90",
            "P",
            "PT",
            "1h 2x",
            "h1",
            "1 h,",
            ",1h",
            "1h,,2m",
            "1,5h",
            "one hour",
            "P1X",
            "1.",
        ] {
            assert!(parse_duration(&s(bad)).is_none(), "{bad:?}");
        }
        assert_eq!(dur_of(&Value::Null), None);
        assert_eq!(dur_of(&Value::Bool(true)), None);
        assert_eq!(dur_of(&Value::Undefined), None);
        assert_eq!(dur_of(&Value::Object(oqx::Object::default())), None);
    }

    // ---- plus / minus ----

    fn pm(recv: &str, arg: Value, sign: i64) -> Option<String> {
        plus_minus(&s(recv), &arg, sign)
    }

    #[test]
    fn seconds_date_only_stays_date_only_for_whole_days_else_a_utc_datetime() {
        assert_eq!(
            pm("2026-01-31", n(86400.0), 1).as_deref(),
            Some("2026-02-01")
        );
        assert_eq!(
            pm("2026-01-31", n(2.0 * 86400.0), 1).as_deref(),
            Some("2026-02-02")
        );
        assert_eq!(
            pm("2026-01-31", n(3600.0), 1).as_deref(),
            Some("2026-01-31T01:00:00Z")
        );
        assert_eq!(
            pm("2026-01-31", n(30.0 * 86400.0), 1).as_deref(),
            Some("2026-03-02")
        ); // dur("1 month") is 30 days
        assert_eq!(pm("2026-01-31", n(0.0), 1).as_deref(), Some("2026-01-31"));
        assert_eq!(
            pm("2026-01-01", n(86400.0), -1).as_deref(),
            Some("2025-12-31")
        );
        assert_eq!(
            pm("2026-01-01", n(-86400.0), 1).as_deref(),
            Some("2025-12-31")
        );
    }

    #[test]
    fn a_duration_string_is_calendar_aware_in_the_month_year_part_clamping_the_day() {
        assert_eq!(
            pm("2026-01-31", s("1 month"), 1).as_deref(),
            Some("2026-02-28")
        );
        assert_eq!(
            pm("2024-01-31", s("1 month"), 1).as_deref(),
            Some("2024-02-29")
        );
        assert_eq!(
            pm("2026-03-31", s("1 month"), -1).as_deref(),
            Some("2026-02-28")
        );
        assert_eq!(
            pm("2026-02-28", s("1 year"), 1).as_deref(),
            Some("2027-02-28")
        );
        assert_eq!(
            pm("2024-02-29", s("1 year"), 1).as_deref(),
            Some("2025-02-28")
        );
        assert_eq!(
            pm("2026-01-31", s("1 month 1 day"), 1).as_deref(),
            Some("2026-03-01")
        );
        assert_eq!(pm("2026-01-31", s("P1M"), 1).as_deref(), Some("2026-02-28"));
        assert_eq!(
            pm("2026-11-15", s("3 months"), 1).as_deref(),
            Some("2027-02-15")
        );
        assert_eq!(
            pm("2026-01-15", s("13 months"), -1).as_deref(),
            Some("2024-12-15")
        );
        assert_eq!(
            pm("2026-01-31T09:00:00Z", s("1 month"), 1).as_deref(),
            Some("2026-02-28T09:00:00Z")
        );
        assert_eq!(
            pm("2026-01-31T09:00:00+02:00", s("1 month"), 1).as_deref(),
            Some("2026-02-28T09:00:00+02:00")
        );
        assert_eq!(
            pm("2026-01-31", s("-1 month"), 1).as_deref(),
            Some("2025-12-31")
        );
        // a fractional month or year is not calendar: its fraction is 30-day / 365-day seconds
        assert_eq!(
            pm("2026-01-01", s("0.5 months"), 1).as_deref(),
            Some("2026-01-16")
        );
        assert_eq!(
            pm("2026-01-01", s("1.5 years"), 1).as_deref(),
            Some("2027-07-02T12:00:00Z")
        ); // 1 calendar year, then 182.5 days
        assert_eq!(
            pm("2026-01-01", s("1.5 years"), 1),
            pm("2027-01-01", n(182.5 * 86400.0), 1)
        );
    }

    #[test]
    fn a_datetime_keeps_its_offset_and_shows_a_fraction_when_one_appears() {
        assert_eq!(
            pm("2026-10-15T09:00:00Z", n(5400.0), 1).as_deref(),
            Some("2026-10-15T10:30:00Z")
        );
        assert_eq!(
            pm("2026-10-15T09:00:00+02:00", n(86400.0), 1).as_deref(),
            Some("2026-10-16T09:00:00+02:00")
        );
        assert_eq!(
            pm("2026-10-15T23:30:00Z", n(3600.0), 1).as_deref(),
            Some("2026-10-16T00:30:00Z")
        );
        assert_eq!(
            pm("2026-10-15T09:00:00Z", n(0.5), 1).as_deref(),
            Some("2026-10-15T09:00:00.500Z")
        );
        assert_eq!(
            pm("2026-10-15T09:00:00.000Z", n(60.0), 1).as_deref(),
            Some("2026-10-15T09:01:00.000Z")
        );
        assert_eq!(
            pm("2026-10-15T09:00:00Z", n(1.0), -1).as_deref(),
            Some("2026-10-15T08:59:59Z")
        );
        assert_eq!(
            pm("2026-01-01", n(0.5), 1).as_deref(),
            Some("2026-01-01T00:00:00.500Z")
        );
    }

    #[test]
    fn is_total_absent_on_a_non_date_receiver_or_a_non_duration_argument() {
        assert_eq!(pm("x", n(1.0), 1), None);
        assert_eq!(pm("2026-01-01", s("bogus"), 1), None);
        assert_eq!(pm("2026-01-01", Value::Null, 1), None);
        assert_eq!(plus_minus(&Value::Undefined, &n(1.0), 1), None);
        assert_eq!(plus_minus(&n(5.0), &n(1.0), 1), None);
        assert_eq!(pm("2026-01-01", n(f64::NAN), 1), None);
    }

    #[test]
    fn shift_date_keeps_the_receivers_fraction_flag() {
        let d = parse_date(&s("2026-10-15T09:00:00.000Z")).unwrap();
        assert_eq!(
            render_date(&shift_date(&d, 0, 60.0)),
            "2026-10-15T09:01:00.000Z"
        );
        assert_eq!(
            render_date(&shift_date(
                &parse_date(&s("2026-10-15T09:00:00Z")).unwrap(),
                1,
                0.0
            )),
            "2026-11-15T09:00:00Z"
        );
    }

    // ---- until, fields, format ----

    #[test]
    fn until_is_seconds_by_instant_signed_fractional_absent_propagating() {
        let u = |a: &str, b: &str| until(&s(a), &s(b));
        assert_eq!(u("2026-01-01", "2026-01-02"), Some(86400.0));
        assert_eq!(u("2026-01-02", "2026-01-01"), Some(-86400.0));
        assert_eq!(u("2026-01-01", "2026-01-01"), Some(0.0));
        assert_eq!(
            u("2026-10-15T09:00:00Z", "2026-10-15T10:30:00Z"),
            Some(5400.0)
        );
        assert_eq!(
            u("2026-01-01T10:00:00+02:00", "2026-01-01T10:00:00Z"),
            Some(7200.0)
        );
        assert_eq!(u("2026-01-01", "2026-01-01T06:00:00Z"), Some(21600.0));
        assert_eq!(
            u("2026-01-01T00:00:00Z", "2026-01-01T00:00:00.500Z"),
            Some(0.5)
        );
        assert_eq!(until(&s("2026-01-01"), &Value::Undefined), None);
        assert_eq!(until(&Value::Undefined, &s("2026-01-01")), None);
        assert_eq!(u("x", "2026-01-01"), None);
    }

    #[test]
    fn fields_read_the_written_offset_weekday_is_1_monday_to_7_sunday() {
        let f = |name: &str, recv: Value| date_method(name, &recv, &[]).unwrap().unwrap();
        let d = "2026-10-15T09:05:07Z";
        assert_eq!(
            [
                f("year", s(d)),
                f("month", s(d)),
                f("day", s(d)),
                f("weekday", s(d)),
                f("hour", s(d)),
                f("minute", s(d)),
                f("second", s(d))
            ],
            [n(2026.0), n(10.0), n(15.0), n(4.0), n(9.0), n(5.0), n(7.0)]
        );
        assert_eq!(f("hour", s("2026-10-15")), n(0.0));
        assert_eq!(f("weekday", s("2026-09-21")), n(1.0));
        assert_eq!(f("weekday", s("2026-09-27")), n(7.0));
        assert_eq!(f("date", s(d)), s("2026-10-15"));
        assert_eq!(f("date", s("2026-10-15")), s("2026-10-15"));
        assert_eq!(f("date", s("2026-10-15T23:30:00-05:00")), s("2026-10-15"));
        assert_eq!(f("hour", s("2026-10-15T23:30:00-05:00")), n(23.0));
        assert_eq!(f("second", s("2026-10-15T09:05:07.900Z")), n(7.0));
        assert_eq!(f("year", Value::Undefined), Value::Null);
        assert_eq!(f("year", s("abc")), Value::Null);
        assert_eq!(f("year", n(5.0)), Value::Null);
        assert_eq!(f("date", s("2026-13-01")), Value::Null);
    }

    #[test]
    fn format_the_token_set_longest_first_everything_else_literal() {
        let fmt = |recv: &str, p: &str| format_date(&s(recv), &s(p));
        let d = "2026-10-15T09:05:07Z";
        assert_eq!(
            fmt(d, "yyyy-MM-dd HH:mm:ss").as_deref(),
            Some("2026-10-15 09:05:07")
        );
        assert_eq!(
            fmt(d, "EEE dd MMM yyyy").as_deref(),
            Some("Thu 15 Oct 2026")
        );
        assert_eq!(fmt(d, "dd/MM/yyyy").as_deref(), Some("15/10/2026"));
        assert_eq!(fmt(d, "MMMM").as_deref(), Some("OctM"));
        assert_eq!(fmt(d, "yyyy 'at' HH").as_deref(), Some("2026 'at' 09"));
        assert_eq!(fmt(d, "").as_deref(), Some(""));
        assert_eq!(fmt(d, "yyyyyyyy").as_deref(), Some("20262026"));
        assert_eq!(fmt("2026-01-05", "EEE").as_deref(), Some("Mon"));
        assert_eq!(fmt("2026-01-05", "HH:mm").as_deref(), Some("00:00"));
        assert_eq!(
            fmt("2026-10-15T23:30:00-05:00", "dd HH").as_deref(),
            Some("15 23")
        );
        assert_eq!(fmt("2026-12-31", "MMM EEE").as_deref(), Some("Dec Thu"));
        assert_eq!(fmt(d, "année → yyyy").as_deref(), Some("année → 2026"));
        assert_eq!(format_date(&s(d), &n(5.0)), None);
        assert_eq!(format_date(&Value::Undefined, &s("yyyy")), None);
        assert_eq!(fmt("x", "yyyy"), None);
    }

    // ---- dur_text / dur_iso ----

    #[test]
    fn dur_text_renders() {
        let t = |x: f64| dur_text(&n(x));
        assert_eq!(t(5400.0).as_deref(), Some("1h 30m"));
        assert_eq!(t(2.0 * 86400.0 + 3.0 * 3600.0).as_deref(), Some("2d 3h"));
        assert_eq!(t(45.0).as_deref(), Some("45s"));
        assert_eq!(t(0.0).as_deref(), Some("0s"));
        assert_eq!(t(-90.0).as_deref(), Some("-1m 30s"));
        assert_eq!(t(1.5).as_deref(), Some("1.5s"));
        assert_eq!(t(604_800.0).as_deref(), Some("7d"));
        assert_eq!(t(86401.0).as_deref(), Some("1d 1s"));
        assert_eq!(t(0.0004).as_deref(), Some("0s"));
        assert_eq!(dur_text(&s("x")), None);
        assert_eq!(dur_text(&Value::Undefined), None);
        assert_eq!(t(f64::NAN), None);
    }

    #[test]
    fn dur_iso_renders() {
        let t = |x: f64| dur_iso(&n(x));
        assert_eq!(t(5400.0).as_deref(), Some("PT1H30M"));
        assert_eq!(t(2.0 * 86400.0 + 3.0 * 3600.0).as_deref(), Some("P2DT3H"));
        assert_eq!(t(45.0).as_deref(), Some("PT45S"));
        assert_eq!(t(0.0).as_deref(), Some("PT0S"));
        assert_eq!(t(-90.0).as_deref(), Some("-PT1M30S"));
        assert_eq!(t(30.0 * 86400.0).as_deref(), Some("P30D"));
        assert_eq!(t(86400.0).as_deref(), Some("P1D"));
        assert_eq!(t(1.5).as_deref(), Some("PT1.5S"));
        assert_eq!(dur_iso(&s("x")), None);
        assert_eq!(dur_iso(&Value::Undefined), None);
    }

    #[test]
    fn round_trips_through_dur() {
        for x in [
            0.0,
            1.0,
            45.0,
            5400.0,
            86401.0,
            2.0 * 86400.0 + 3.0 * 3600.0,
            1.5,
        ] {
            assert_eq!(dur_of(&s(&dur_iso(&n(x)).unwrap())), Some(x));
            assert_eq!(dur_of(&s(&dur_text(&n(x)).unwrap())), Some(x));
        }
    }

    // ---- the OQX arms ----

    fn msg(r: Option<oqx::Result<Value>>) -> String {
        r.unwrap().unwrap_err().to_string()
    }

    #[test]
    fn date_function_date_dur_handled_anything_else_deferred_arity_is_the_one_error() {
        assert_eq!(
            date_function("date", &[s("2026-01-05")], NOW),
            Some(Ok(s("2026-01-05")))
        );
        assert_eq!(
            date_function("date", &[s("today")], NOW),
            Some(Ok(s("2026-09-27")))
        );
        assert_eq!(date_function("dur", &[s("1h")], NOW), Some(Ok(n(3600.0))));
        assert!(date_function("size", &[Value::Array(vec![])], NOW).is_none());
        assert!(date_function("date", &[], NOW).unwrap().is_err());
        assert!(
            msg(date_function("date", &[s("a"), s("b")], NOW))
                .contains("date() takes exactly 1 argument, got 2")
        );
        assert!(
            msg(date_function("dur", &[], NOW)).contains("dur() takes exactly 1 argument, got 0")
        );
    }

    #[test]
    fn date_method_every_method_handled_on_its_receiver_kind_total_on_others_arity_checked() {
        assert_eq!(
            date_method("plus", &s("2026-01-01"), &[n(86400.0)]),
            Some(Ok(s("2026-01-02")))
        );
        assert_eq!(
            date_method("minus", &s("2026-01-01"), &[s("1 day")]),
            Some(Ok(s("2025-12-31")))
        );
        assert_eq!(
            date_method("until", &s("2026-01-01"), &[s("2026-01-02")]),
            Some(Ok(n(86400.0)))
        );
        assert_eq!(
            date_method("format", &s("2026-01-01"), &[s("yyyy")]),
            Some(Ok(s("2026")))
        );
        assert_eq!(
            date_method("dur_text", &n(5400.0), &[]),
            Some(Ok(s("1h 30m")))
        );
        assert_eq!(
            date_method("dur_iso", &n(5400.0), &[]),
            Some(Ok(s("PT1H30M")))
        );
        assert_eq!(
            date_method("dur_text", &s("2026-01-01"), &[]),
            Some(Ok(Value::Null))
        );
        assert_eq!(
            date_method("plus", &n(5.0), &[n(1.0)]),
            Some(Ok(Value::Null))
        );
        assert!(date_method("lower", &s("X"), &[]).is_none());
        assert!(
            msg(date_method("plus", &s("2026-01-01"), &[]))
                .contains(".plus() takes exactly 1 argument, got 0")
        );
        assert!(
            msg(date_method("dur_text", &n(1.0), &[n(1.0)]))
                .contains(".dur_text() takes exactly 0 arguments, got 1")
        );
        assert!(
            date_method("year", &s("2026-01-01"), &[n(1.0)])
                .unwrap()
                .is_err()
        );
        for (name, arity) in DATE_METHODS {
            let args = vec![n(1.0); arity];
            assert!(
                date_method(name, &Value::Undefined, &args).is_some(),
                "{name}"
            );
        }
    }

    #[test]
    fn civil_arithmetic_round_trips_across_eras() {
        for days in [-719_468, -1, 0, 1, 10_957, 20_724, 2_932_896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days, "{y}-{m}-{d}");
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(dow_of_days(0), 4); // Thursday
        assert_eq!(civil_from_days(days_from_civil(2026, 9, 27)), (2026, 9, 27));
    }
}
