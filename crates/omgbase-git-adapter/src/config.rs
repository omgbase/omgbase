//! The git provider's manifest config (`spec/store` §3.1 `capabilities.config`,
//! §5.12): what `history enable --provider git` writes and every later call
//! reads. Pinned keys and defaults. `remote` (17.6, Phase 6b) is the remote
//! binding `history remote set` writes — `{ name, url, branch, push, fetch }`,
//! null until one is bound; nothing is automatic until it is (`push`/`fetch`
//! default `off`). The per-document id-map ref `ids_ref` is written by the
//! worker since 6b (one commit chain beside the content branch).

use omgbase_store::{Error, Result};
use serde_json::{Map, Value as Json, json};

/// The provider's name — the manifest row's `config.provider`.
pub const GIT_PROVIDER: &str = "git";
/// Where the bare repository lives, relative to the workspace root.
pub const DEFAULT_GIT_DIR: &str = ".omgbase/git";
/// The branch the commits go on unless `--branch` says otherwise.
pub const DEFAULT_BRANCH: &str = "omgbase";
/// The per-document id-map ref (option 3's second half, 17.6): one blob per
/// live document at `.omgbase/ids/<doc_id>`, a commit chain beside the branch.
pub const IDS_REF: &str = "refs/omgbase/ids";
/// The git remote's name in the bare repository unless `--name` says otherwise.
pub const DEFAULT_REMOTE_NAME: &str = "origin";
/// `--push`'s values (`spec/store` §5.12 "The remote binding").
pub const PUSH_POLICIES: [&str; 3] = ["off", "on-checkpoint", "periodic"];
/// `--fetch`'s values.
pub const FETCH_POLICIES: [&str; 3] = ["off", "periodic", "webhook"];

/// When the engine pushes: never by itself, after every checkpoint that
/// committed, or on every freshness sweep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushPolicy {
    Off,
    OnCheckpoint,
    Periodic,
}

impl PushPolicy {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            PushPolicy::Off => "off",
            PushPolicy::OnCheckpoint => "on-checkpoint",
            PushPolicy::Periodic => "periodic",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "off" => Some(PushPolicy::Off),
            "on-checkpoint" => Some(PushPolicy::OnCheckpoint),
            "periodic" => Some(PushPolicy::Periodic),
            _ => None,
        }
    }
}

/// When the engine fetches: never, on every sweep, or (RESERVED) when an
/// external caller runs `history fetch`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchPolicy {
    Off,
    Periodic,
    Webhook,
}

impl FetchPolicy {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            FetchPolicy::Off => "off",
            FetchPolicy::Periodic => "periodic",
            FetchPolicy::Webhook => "webhook",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "off" => Some(FetchPolicy::Off),
            "periodic" => Some(FetchPolicy::Periodic),
            "webhook" => Some(FetchPolicy::Webhook),
            _ => None,
        }
    }
}

/// The remote binding (`spec/store` §5.12 "The remote binding", 17.6): `name`
/// the git remote's name in the bare repository (`origin`), `url` what `git`
/// is given — never with credentials ([`refuse_credentials`]) — `branch` the
/// remote branch (the local branch's name by default), `push` when the engine
/// pushes, `fetch` when it fetches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitRemoteConfig {
    pub name: String,
    pub url: String,
    pub branch: String,
    pub push: PushPolicy,
    pub fetch: FetchPolicy,
}

impl GitRemoteConfig {
    /// `{ name, url, branch, push, fetch }`, in that key order (the verb's
    /// receipt; the manifest canonicalizes it).
    #[must_use]
    pub fn to_json(&self) -> Json {
        json!({
            "name": self.name,
            "url": self.url,
            "branch": self.branch,
            "push": self.push.as_str(),
            "fetch": self.fetch.as_str(),
        })
    }
}

/// `history remote set`'s options.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteOptions {
    pub url: String,
    pub name: Option<String>,
    pub branch: Option<String>,
    pub push: Option<String>,
    pub fetch: Option<String>,
}

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
    /// The remote binding, `None` until `history remote set` binds one (17.6).
    pub remote: Option<GitRemoteConfig>,
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
        m.insert(
            "remote".to_owned(),
            self.remote
                .as_ref()
                .map_or(Json::Null, GitRemoteConfig::to_json),
        );
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
        remote: None,
    })
}

/// A git remote name (`git check-ref-format`'s rules, roughly): no spaces,
/// no `..`, no leading `-`, no `.lock` suffix.
#[must_use]
pub fn valid_remote_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !name.starts_with('-')
        && !name.contains("..")
        && !name.ends_with(".lock")
}

/// The remote binding `history remote set` writes, from the verb's options
/// (defaults: `origin`, the local branch, `off`, `off`); the URL refused when
/// it carries credentials; the messages the reference's, byte for byte.
pub fn remote_config_for(opts: &RemoteOptions, local_branch: &str) -> Result<GitRemoteConfig> {
    if opts.url.trim().is_empty() {
        return Err(Error::Other(
            "--url is required (a git URL or a local path; credentials never enter omgbase)"
                .to_owned(),
        ));
    }
    refuse_credentials(&opts.url, "the remote URL")?;
    let name = opts
        .name
        .clone()
        .unwrap_or_else(|| DEFAULT_REMOTE_NAME.to_owned());
    if !valid_remote_name(&name) {
        return Err(Error::Other(format!(
            "not a remote name: {}",
            Json::String(name)
        )));
    }
    let branch = opts
        .branch
        .clone()
        .unwrap_or_else(|| local_branch.to_owned());
    if !valid_branch(&branch) {
        return Err(Error::Other(format!(
            "not a branch name: {}",
            Json::String(branch)
        )));
    }
    let push_raw = opts.push.as_deref().unwrap_or("off");
    let Some(push) = PushPolicy::parse(push_raw) else {
        return Err(Error::Other(format!(
            "--push must be one of {} (got {})",
            PUSH_POLICIES.join("|"),
            Json::String(push_raw.to_owned())
        )));
    };
    let fetch_raw = opts.fetch.as_deref().unwrap_or("off");
    let Some(fetch) = FetchPolicy::parse(fetch_raw) else {
        return Err(Error::Other(format!(
            "--fetch must be one of {} (got {})",
            FETCH_POLICIES.join("|"),
            Json::String(fetch_raw.to_owned())
        )));
    };
    Ok(GitRemoteConfig {
        name,
        url: opts.url.clone(),
        branch,
        push,
        fetch,
    })
}

/// A row's `remote` member read back: the binding when it is well-formed,
/// else `None` (a row without one, or one an older engine wrote).
#[must_use]
pub fn read_remote_config(v: Option<&Json>) -> Option<GitRemoteConfig> {
    let o = v?.as_object()?;
    let text = |k: &str| o.get(k).and_then(Json::as_str).map(str::to_owned);
    Some(GitRemoteConfig {
        name: text("name")?,
        url: text("url")?,
        branch: text("branch")?,
        push: o
            .get("push")
            .and_then(Json::as_str)
            .and_then(PushPolicy::parse)
            .unwrap_or(PushPolicy::Off),
        fetch: o
            .get("fetch")
            .and_then(Json::as_str)
            .and_then(FetchPolicy::parse)
            .unwrap_or(FetchPolicy::Off),
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
        remote: read_remote_config(config.get("remote")),
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
    fn the_remote_binding_defaults_validates_and_reads_back() {
        let r = remote_config_for(
            &RemoteOptions {
                url: "/tmp/remote.git".into(),
                ..RemoteOptions::default()
            },
            "omgbase",
        )
        .unwrap();
        assert_eq!(
            r.to_json(),
            json!({ "name": "origin", "url": "/tmp/remote.git", "branch": "omgbase", "push": "off", "fetch": "off" })
        );
        assert_eq!(read_remote_config(Some(&r.to_json())), Some(r.clone()));
        assert_eq!(read_remote_config(Some(&Json::Null)), None);
        let mut c = git_config_for(&Map::new()).unwrap();
        c.remote = Some(r);
        assert_eq!(read_git_config(&c.to_map()), c);
        let e = remote_config_for(
            &RemoteOptions {
                url: "https://user:secret@example.com/notes.git".into(),
                ..RemoteOptions::default()
            },
            "omgbase",
        )
        .unwrap_err();
        assert_eq!(
            e.to_string(),
            "the remote URL carries credentials (a user or password in the URL) — omgbase never stores credentials; let git resolve access through the host (ssh keys, a credential helper)"
        );
        let e = remote_config_for(
            &RemoteOptions {
                url: "/tmp/r.git".into(),
                push: Some("always".into()),
                ..RemoteOptions::default()
            },
            "omgbase",
        )
        .unwrap_err();
        assert_eq!(
            e.to_string(),
            "--push must be one of off|on-checkpoint|periodic (got \"always\")"
        );
        let e = remote_config_for(
            &RemoteOptions {
                url: "/tmp/r.git".into(),
                fetch: Some("hourly".into()),
                ..RemoteOptions::default()
            },
            "omgbase",
        )
        .unwrap_err();
        assert_eq!(
            e.to_string(),
            "--fetch must be one of off|periodic|webhook (got \"hourly\")"
        );
        assert!(
            remote_config_for(
                &RemoteOptions {
                    url: "/tmp/r.git".into(),
                    name: Some("-x".into()),
                    ..RemoteOptions::default()
                },
                "omgbase",
            )
            .unwrap_err()
            .to_string()
            .contains("remote name")
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
