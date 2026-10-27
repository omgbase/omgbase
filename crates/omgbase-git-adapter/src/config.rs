//! The git provider's manifest config (`spec/store` §3.1 `capabilities.config`,
//! §5.12): what `history enable --provider git` writes and every later call
//! reads. Pinned keys and defaults; `remote` is null in 6a (6b wires it) and
//! the per-document id-map ref `ids_ref` is RESERVED — named here and in the
//! spec, nothing is written to it yet.

use omgbase_store::{Error, Result};
use serde_json::{Map, Value as Json, json};

/// The provider's name — the manifest row's `config.provider`.
pub const GIT_PROVIDER: &str = "git";
/// Where the bare repository lives, relative to the workspace root.
pub const DEFAULT_GIT_DIR: &str = ".omgbase/git";
/// The branch the commits go on unless `--branch` says otherwise.
pub const DEFAULT_BRANCH: &str = "omgbase";
/// The RESERVED per-document id-map ref (option 3: the trailers are the
/// identity record in 6a).
pub const IDS_REF: &str = "refs/omgbase/ids";

/// The worker's cadence: one commit per feed row, or the rows pending when
/// the worker runs folded into one commit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cadence {
    Every,
    Debounce { debounce_ms: u64 },
}

impl Cadence {
    /// The config value: `"every"` or `{ debounce_ms }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        match self {
            Cadence::Every => json!("every"),
            Cadence::Debounce { debounce_ms } => json!({ "debounce_ms": debounce_ms }),
        }
    }
}

/// The git provider's config as the manifest row carries it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitHistoryConfig {
    pub git_dir: String,
    pub branch: String,
    pub cadence: Cadence,
    pub ids_ref: String,
    /// `null` in 6a.
    pub remote: Json,
}

impl GitHistoryConfig {
    /// The row's `config`: `{ provider: "git", git_dir, branch, cadence,
    /// ids_ref, remote }` (the store canonicalizes the key order).
    #[must_use]
    pub fn to_map(&self) -> Map<String, Json> {
        let mut m = Map::new();
        m.insert("provider".to_owned(), json!(GIT_PROVIDER));
        m.insert("git_dir".to_owned(), json!(self.git_dir));
        m.insert("branch".to_owned(), json!(self.branch));
        m.insert("cadence".to_owned(), self.cadence.to_json());
        m.insert("ids_ref".to_owned(), json!(self.ids_ref));
        m.insert("remote".to_owned(), self.remote.clone());
        m
    }
}

/// A URL (or anything that looks like one) with embedded credentials is
/// refused everywhere: `git` resolves access through the host.
pub fn refuse_credentials(value: &str, what: &str) -> Result<()> {
    // `^[a-z][a-z0-9+.-]*://` then a user (and optional password) before `@`.
    let Some((scheme, rest)) = value.split_once("://") else {
        return Ok(());
    };
    let scheme_ok = scheme
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    if !scheme_ok {
        return Ok(());
    }
    let authority = rest
        .split(['/', '\u{20}', '\t', '\n', '\r'])
        .next()
        .unwrap_or("");
    if authority.contains('@') && !authority.starts_with('@') {
        return Err(Error::Other(format!(
            "{what} carries credentials (a user or password in the URL) — omgbase never stores credentials; let git resolve access through the host (ssh keys, a credential helper)"
        )));
    }
    Ok(())
}

fn valid_branch(branch: &str) -> bool {
    !branch.is_empty()
        && branch
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
        && !branch.starts_with('-')
        && !branch.contains("..")
        && !branch.ends_with('/')
        && !branch.ends_with(".lock")
}

/// The config `history enable --provider git` writes, from the verb's options
/// (`branch`, `cadence`); a bad branch or cadence is refused.
pub fn git_config_for(options: &Map<String, Json>) -> Result<GitHistoryConfig> {
    let branch = match options.get("branch") {
        None | Some(Json::Null) => DEFAULT_BRANCH.to_owned(),
        Some(Json::String(b)) => b.clone(),
        Some(other) => {
            return Err(Error::Other(format!("not a branch name: {other}")));
        }
    };
    if !valid_branch(&branch) {
        return Err(Error::Other(format!(
            "not a branch name: {}",
            Json::String(branch)
        )));
    }
    let cadence = match options.get("cadence") {
        None | Some(Json::Null) => Cadence::Every,
        Some(Json::String(s)) if s == "every" => Cadence::Every,
        Some(Json::Object(o))
            if o.get("debounce_ms")
                .and_then(Json::as_u64)
                .is_some_and(|n| n > 0)
                && o.get("debounce_ms").is_some_and(|v| v.is_u64()) =>
        {
            Cadence::Debounce {
                debounce_ms: o["debounce_ms"].as_u64().unwrap_or(0),
            }
        }
        Some(_) => {
            return Err(Error::Other(
                "cadence must be \"every\" or { debounce_ms: <positive integer> }".to_owned(),
            ));
        }
    };
    Ok(GitHistoryConfig {
        git_dir: DEFAULT_GIT_DIR.to_owned(),
        branch,
        cadence,
        ids_ref: IDS_REF.to_owned(),
        remote: Json::Null,
    })
}

/// Parse the `--cadence every|<ms>` flag; the error is the CLI's usage message.
pub fn parse_cadence(raw: &str) -> std::result::Result<Cadence, String> {
    if raw == "every" {
        return Ok(Cadence::Every);
    }
    let ms = if !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) {
        raw.parse::<u64>().ok()
    } else {
        None
    };
    match ms {
        Some(ms) if ms > 0 => Ok(Cadence::Debounce { debounce_ms: ms }),
        _ => Err(format!(
            "--cadence must be \"every\" or a positive number of milliseconds (got {})",
            Json::String(raw.to_owned())
        )),
    }
}

/// Read a manifest row's config as the git config, defaults filled (a row
/// written by a later 6.x may carry more keys).
#[must_use]
pub fn read_git_config(config: &Map<String, Json>) -> GitHistoryConfig {
    let text = |k: &str, default: &str| -> String {
        match config.get(k) {
            Some(Json::String(s)) if !s.is_empty() => s.clone(),
            _ => default.to_owned(),
        }
    };
    let cadence = match config.get("cadence") {
        Some(Json::Object(o)) => match o.get("debounce_ms").and_then(Json::as_u64) {
            Some(ms) => Cadence::Debounce { debounce_ms: ms },
            None => Cadence::Every,
        },
        _ => Cadence::Every,
    };
    GitHistoryConfig {
        git_dir: text("git_dir", DEFAULT_GIT_DIR),
        branch: text("branch", DEFAULT_BRANCH),
        cadence,
        ids_ref: match config.get("ids_ref") {
            Some(Json::String(s)) => s.clone(),
            _ => IDS_REF.to_owned(),
        },
        remote: config.get("remote").cloned().unwrap_or(Json::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(v: Json) -> Map<String, Json> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn writes_the_pinned_defaults_refuses_a_bad_branch_or_cadence_parses_cadence_and_reads_back() {
        let c = git_config_for(&Map::new()).unwrap();
        assert_eq!(
            Json::Object(c.to_map()),
            json!({ "provider": "git", "git_dir": ".omgbase/git", "branch": "omgbase", "cadence": "every", "ids_ref": "refs/omgbase/ids", "remote": null })
        );
        assert_eq!(
            git_config_for(&opts(
                json!({ "branch": "notes", "cadence": { "debounce_ms": 500 } })
            ))
            .unwrap()
            .cadence,
            Cadence::Debounce { debounce_ms: 500 }
        );
        let e = git_config_for(&opts(json!({ "branch": "-x" }))).unwrap_err();
        assert!(e.to_string().contains("branch"), "{e}");
        let e = git_config_for(&opts(json!({ "cadence": { "debounce_ms": 0 } }))).unwrap_err();
        assert!(e.to_string().contains("cadence"), "{e}");
        assert_eq!(parse_cadence("every").unwrap(), Cadence::Every);
        assert_eq!(
            parse_cadence("250").unwrap(),
            Cadence::Debounce { debounce_ms: 250 }
        );
        assert_eq!(
            parse_cadence("soon").unwrap_err(),
            "--cadence must be \"every\" or a positive number of milliseconds (got \"soon\")"
        );
        assert_eq!(
            read_git_config(&opts(json!({ "provider": "git" }))),
            git_config_for(&Map::new()).unwrap()
        );
    }

    #[test]
    fn refuses_credentials_in_a_url_anywhere() {
        assert!(refuse_credentials("https://user:secret@example.com/x.git", "remote").is_err());
        assert!(refuse_credentials("https://token@example.com/x.git", "remote").is_err());
        assert!(refuse_credentials("https://example.com/x.git", "remote").is_ok());
        assert!(refuse_credentials("git@example.com:x/y.git", "remote").is_ok());
    }
}
