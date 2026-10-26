//! `log` (§6): `changes_since` from a feed cursor; `--since` is resolved
//! client-side to the highest retained feed `seq` strictly before the
//! instant. A cursor is `(epoch, seq)` since store 17.0 (D7): `--cursor <n>`
//! continues from a seq of the current epoch unless `--epoch <ep>` names the
//! one it came from; a cursor the feed no longer serves is `expired_cursor`
//! (exit 1).

use omgbase_store::time::format_ms;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value as Json, json};

use crate::cli::argv::{Mode, Opt, number, parse_args};
use crate::cli::context::Cli;
use crate::cli::help::{render_help_for, wants_help};
use crate::cli::output::{CliError, EXIT_OK, Result, truncation_footer};
use crate::cli::seams::canonical_instant;

use super::{machine_out, str_of};

/// A relative age (`24h`, `7d`, `2w`, `1m` = 30 days) or an absolute instant
/// → the instant, against "now". §9 Fixed: an unparsable value is a usage error.
fn since_instant(since: &str, now_ms: i64) -> Result<String> {
    let s = since.trim();
    let digits: String = s.chars().take_while(char::is_ascii_digit).collect();
    let unit = &s[digits.len()..];
    if !digits.is_empty() && matches!(unit, "h" | "d" | "w" | "m") {
        let n: i64 = digits.parse().unwrap_or(0);
        let ms = match unit {
            "h" => 3_600_000,
            "d" => 86_400_000,
            "w" => 7 * 86_400_000,
            _ => 30 * 86_400_000,
        };
        return Ok(format_ms(now_ms - n * ms));
    }
    canonical_instant(s).ok_or_else(|| {
        CliError::usage(format!(
            "bad --since '{since}' (use a relative age like 24h or 7d, or an ISO timestamp)"
        ))
    })
}

pub fn log(cli: &mut Cli, args: &[String]) -> Result<i32> {
    if wants_help(args) {
        return render_help_for(cli, "log");
    }
    let a = parse_args(
        args,
        &[
            Opt::value("since"),
            Opt::value("cursor"),
            Opt::value("epoch"),
            Opt::value("origin"),
            Opt::value_short("n", 'n'),
        ],
    )?;
    let cursor = match (number(&a, "cursor")?, a.value("since")) {
        (Some(c), _) => c,
        // §2.3: `--since` resolves a timestamp against the local commits
        // table, which a remote client lacks — `--cursor` is the remote form.
        (None, Some(_)) if cli.remote_mode() => {
            return Err(CliError::usage(
                "--since is not supported with --server; use --cursor <seq>",
            ));
        }
        (None, Some(since)) => {
            // The instant resolves through the FEED of the current epoch
            // (store 17.0, D7): the highest retained seq strictly before it;
            // a `--since` before the oldest retained row means "everything
            // the feed holds" — cursor `oldest − 1` (cursor 0 on a feed
            // pruned to `oldest ≥ 2` is `expired_cursor`, spec/surface §3).
            let iso = since_instant(since, cli.now_ms())?;
            let repo = cli.repo()?;
            let conn = cli.store()?.conn();
            let seq: Option<i64> = conn
                .query_row(
                    "SELECT MAX(seq) FROM feed WHERE repo_id = ?1 AND epoch = (SELECT epoch FROM repos WHERE repo_id = ?1) AND ts < ?2",
                    params![repo.repo_id, iso],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            let oldest: i64 = conn.query_row(
                "SELECT COALESCE(MIN(seq), 0) FROM feed WHERE repo_id = ?1 AND epoch = (SELECT epoch FROM repos WHERE repo_id = ?1)",
                params![repo.repo_id],
                |r| r.get(0),
            )?;
            let seq = seq.unwrap_or(0);
            if seq < oldest - 1 {
                (oldest - 1).max(0)
            } else {
                seq
            }
        }
        (None, None) => 0,
    };
    let mut req = serde_json::Map::new();
    req.insert("cursor".to_owned(), json!(cursor));
    if let Some(e) = a.value("epoch") {
        req.insert("epoch".to_owned(), json!(e));
    }
    if let Some(n) = number(&a, "n")? {
        req.insert("limit".to_owned(), json!(n));
    }
    if let Some(o) = a.value("origin") {
        req.insert("origin".to_owned(), json!(o));
    }
    let result = cli.call("changes_since", Json::Object(req))?;
    let digests: Vec<Json> = result
        .get("digests")
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    let truncated = result
        .get("truncated")
        .and_then(Json::as_bool)
        .unwrap_or(false);
    let next = result
        .get("cursor")
        .map(super::fmt_value)
        .unwrap_or_default();
    let ids: Vec<String> = digests.iter().map(|d| str_of(d, "commit")).collect();
    let style = cli.style;
    if let Some(code) = machine_out(cli, &result, Some(&digests), Some(&ids)) {
        // §9 Fixed: the footer prints in every list mode (`--ids` too).
        if truncated && cli.flags.mode != Mode::Json {
            truncation_footer(cli.io, &style, &next);
        }
        return code;
    }
    if digests.is_empty() {
        cli.io.err(&style.dim("  no changes"));
        return Ok(EXIT_OK);
    }
    for d in &digests {
        let origin = str_of(d, "origin");
        let padded = format!("{origin:<8}");
        let origin = if origin == "observed" {
            style.accent(&padded)
        } else {
            style.warn(&padded)
        };
        cli.io.out(&format!(
            "{} {origin} {}",
            style.dim(&format!(
                "#{}",
                super::fmt_value(d.get("seq").unwrap_or(&Json::Null))
            )),
            str_of(d, "summary")
        ));
    }
    if truncated {
        truncation_footer(cli.io, &style, &next);
    }
    Ok(EXIT_OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn since() {
        let now = omgbase_store::time::parse_ms("2026-09-27T00:00:00.000Z").unwrap();
        assert_eq!(
            since_instant("24h", now).unwrap(),
            "2026-09-26T00:00:00.000Z"
        );
        assert_eq!(
            since_instant("1w", now).unwrap(),
            "2026-09-20T00:00:00.000Z"
        );
        assert_eq!(
            since_instant("2026-09-26T00:00:00Z", now).unwrap(),
            "2026-09-26T00:00:00.000Z"
        );
        assert!(since_instant("garbage", now).is_err());
    }
}
