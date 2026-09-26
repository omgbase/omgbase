//! Timestamps (`spec/store/README.md` §2.4): RFC 3339 UTC with exactly three
//! fractional digits and a `Z` — JavaScript's `Date.toISOString()`. Parsing
//! accepts the format the store stores (an optional fraction of any length,
//! truncated to milliseconds) so `expires_ts = ts + 30 days` can be computed
//! without a calendar dependency.

use crate::error::{Error, Result};

/// Milliseconds in 30 days: the resurrection-pool lifetime.
pub const POOL_TTL_MS: i64 = 30 * 86_400_000;

fn digits(s: &[u8], at: usize, n: usize) -> Option<i64> {
    let part = s.get(at..at + n)?;
    if !part.iter().all(u8::is_ascii_digit) {
        return None;
    }
    part.iter()
        .try_fold(0i64, |acc, &d| Some(acc * 10 + i64::from(d - b'0')))
}

/// Days from 1970-01-01 to the proleptic Gregorian `y-m-d` (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse of [`days_from_civil`].
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
    }
}

/// Parse `YYYY-MM-DDTHH:MM:SS[.fff…]Z` to milliseconds since the Unix epoch.
/// Seconds are required; a fraction of any length is truncated to
/// milliseconds; the designator must be `Z` (UTC only, as the store writes).
pub fn parse_ms(ts: &str) -> Result<i64> {
    let err = || Error::InvalidTimestamp(ts.to_owned());
    let s = ts.as_bytes();
    let year = digits(s, 0, 4).ok_or_else(err)?;
    let month = digits(s, 5, 2).ok_or_else(err)?;
    let day = digits(s, 8, 2).ok_or_else(err)?;
    let hour = digits(s, 11, 2).ok_or_else(err)?;
    let minute = digits(s, 14, 2).ok_or_else(err)?;
    let second = digits(s, 17, 2).ok_or_else(err)?;
    if s.get(4) != Some(&b'-')
        || s.get(7) != Some(&b'-')
        || !matches!(s.get(10), Some(b'T' | b't'))
        || s.get(13) != Some(&b':')
        || s.get(16) != Some(&b':')
    {
        return Err(err());
    }
    let mut i = 19;
    let mut ms = 0i64;
    if s.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < s.len() && s[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return Err(err());
        }
        let frac = &ts[start..i];
        let mut padded: String = frac.chars().take(3).collect();
        while padded.len() < 3 {
            padded.push('0');
        }
        ms = padded.parse().map_err(|_| err())?;
    }
    if !matches!(s.get(i), Some(b'Z' | b'z')) || i + 1 != s.len() {
        return Err(err());
    }
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(err());
    }
    let days = days_from_civil(year, month, day);
    Ok(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + ms)
}

/// Format milliseconds since the epoch as `YYYY-MM-DDTHH:MM:SS.fffZ`.
///
/// # Panics
///
/// If the year falls outside `0000..=9999` (JavaScript switches to an
/// extended year form there, which the store never writes).
#[must_use]
pub fn format_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    assert!(
        (0..=9999).contains(&y),
        "year {y} out of the four-digit range"
    );
    let hour = rem / 3_600_000;
    let minute = rem / 60_000 % 60;
    let second = rem / 1000 % 60;
    let milli = rem % 1000;
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// `ts` re-formatted canonically, plus `delta_ms`.
pub fn plus_ms(ts: &str, delta_ms: i64) -> Result<String> {
    Ok(format_ms(parse_ms(ts)? + delta_ms))
}

/// `expires_ts` for a block pooled at `ts`: `ts + 30 days` (§2.4).
pub fn pool_expiry(ts: &str) -> Result<String> {
    plus_ms(ts, POOL_TTL_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_the_canonical_form() {
        for ts in [
            "1970-01-01T00:00:00.000Z",
            "2026-09-26T14:03:07.250Z",
            "2000-02-29T23:59:59.999Z",
            "1969-12-31T23:59:59.999Z",
            "9999-12-31T23:59:59.999Z",
            "0001-01-01T00:00:00.000Z",
        ] {
            assert_eq!(format_ms(parse_ms(ts).unwrap()), ts);
        }
        assert_eq!(parse_ms("1970-01-01T00:00:00.000Z").unwrap(), 0);
        assert_eq!(parse_ms("1970-01-02T00:00:00.000Z").unwrap(), 86_400_000);
        assert_eq!(parse_ms("1969-12-31T23:59:59.999Z").unwrap(), -1);
        // Known epoch value (JavaScript: Date.parse("2026-09-26T14:03:07.250Z")).
        assert_eq!(
            parse_ms("2026-09-26T14:03:07.250Z").unwrap(),
            1_790_431_387_250
        );
    }

    #[test]
    fn fraction_is_optional_and_truncated_to_milliseconds() {
        assert_eq!(
            plus_ms("2026-09-26T14:03:07Z", 0).unwrap(),
            "2026-09-26T14:03:07.000Z"
        );
        assert_eq!(
            plus_ms("2026-09-26T14:03:07.2Z", 0).unwrap(),
            "2026-09-26T14:03:07.200Z"
        );
        assert_eq!(
            plus_ms("2026-09-26T14:03:07.123456Z", 0).unwrap(),
            "2026-09-26T14:03:07.123Z"
        );
    }

    #[test]
    fn rejects_malformed_timestamps() {
        for bad in [
            "",
            "2026-09-26",
            "2026-09-26T14:03:07.250",
            "2026-09-26T14:03:07.250+00:00",
            "2026-09-26 14:03:07.250Z",
            "2026-13-01T00:00:00.000Z",
            "2026-02-30T00:00:00.000Z",
            "2026-09-26T24:00:00.000Z",
            "2026-09-26T14:03:07.Z",
            "2026-09-26T14:03:07.250Zx",
            "not a date",
        ] {
            assert!(parse_ms(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn pool_expiry_is_thirty_days_later() {
        assert_eq!(
            pool_expiry("2026-09-26T10:00:00.000Z").unwrap(),
            "2026-10-26T10:00:00.000Z"
        );
        // Across a month end and a leap day.
        assert_eq!(
            pool_expiry("2024-02-10T00:00:00.000Z").unwrap(),
            "2024-03-11T00:00:00.000Z"
        );
        assert_eq!(
            pool_expiry("2026-12-15T23:59:59.999Z").unwrap(),
            "2027-01-14T23:59:59.999Z"
        );
    }

    #[test]
    fn civil_conversions_agree_over_a_wide_range() {
        let mut day = days_from_civil(1600, 1, 1);
        let end = days_from_civil(2400, 12, 31);
        let (mut y, mut m, mut d) = (1600, 1, 1);
        while day <= end {
            assert_eq!(civil_from_days(day), (y, m, d));
            assert_eq!(days_from_civil(y, m, d), day);
            d += 1;
            if d > days_in_month(y, m) {
                d = 1;
                m += 1;
                if m > 12 {
                    m = 1;
                    y += 1;
                }
            }
            day += 1;
        }
    }
}
