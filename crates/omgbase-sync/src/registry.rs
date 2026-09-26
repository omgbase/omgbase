//! The source registry (`spec/sync/README.md` §2): `adapters`, `sources`,
//! `attachments` (`sync_state` is reserved — only [`delete_source`] touches
//! it), `ensure_repo` with the `<slug>-fs` source, and the config → argv
//! rendering an adapter is spawned with.

use std::collections::BTreeMap;

use omgbase_store::Store;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value};

use crate::error::Result;

/// The `fs` adapter as `ensure_repo` registers it.
pub const FS_ADAPTER: &str = "fs";
/// Its command.
pub const FS_ADAPTER_COMMAND: &str = "omgbase-fs-adapter";

/// An `adapters` row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterRow {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
}

/// A `sources` row with its JSON columns parsed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceRow {
    pub source_id: String,
    pub name: String,
    pub adapter: String,
    pub config: Map<String, Value>,
    /// `env` values are used literally (§9: no `$VAR` indirection).
    pub env: BTreeMap<String, String>,
}

/// Insert or update an adapter by name.
pub fn ensure_adapter(store: &Store, name: &str, command: &str, args: &[String]) -> Result<()> {
    store.conn().execute(
        "INSERT INTO adapters (name, command, args) VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET command = excluded.command, args = excluded.args",
        params![name, command, Value::from(args.to_vec()).to_string()],
    )?;
    Ok(())
}

/// Every adapter, by name.
pub fn list_adapters(store: &Store) -> Result<Vec<AdapterRow>> {
    let mut stmt = store
        .conn()
        .prepare("SELECT name, command, args FROM adapters ORDER BY name")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (name, command, args) = row?;
        let args: Vec<String> = serde_json::from_str(&args)?;
        out.push(AdapterRow {
            name,
            command,
            args,
        });
    }
    Ok(out)
}

/// What [`create_source`] takes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NewSource<'a> {
    pub name: &'a str,
    pub adapter: &'a str,
    pub config: Option<&'a Map<String, Value>>,
    pub env: Option<&'a BTreeMap<String, String>>,
}

/// Create a named source over an adapter: **mints `src`**; a taken name or
/// an unknown adapter fails (UNIQUE / FK). Returns the id.
pub fn create_source(store: &mut Store, spec: &NewSource<'_>) -> Result<String> {
    let source_id = store.mint("src");
    let config = spec
        .config
        .map_or_else(|| "{}".to_owned(), |c| Value::Object(c.clone()).to_string());
    let env = spec.env.map_or_else(
        || "{}".to_owned(),
        |e| {
            Value::Object(
                e.iter()
                    .map(|(k, v)| (k.clone(), Value::String(v.clone())))
                    .collect(),
            )
            .to_string()
        },
    );
    store.conn().execute(
        "INSERT INTO sources (source_id, name, adapter, config, env) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![source_id, spec.name, spec.adapter, config, env],
    )?;
    Ok(source_id)
}

/// Delete a source: its attachments, its `sync_state` rows, the row.
pub fn delete_source(store: &Store, source_id: &str) -> Result<()> {
    let conn = store.conn();
    conn.execute(
        "DELETE FROM attachments WHERE source_id = ?1",
        params![source_id],
    )?;
    conn.execute(
        "DELETE FROM sync_state WHERE source_id = ?1",
        params![source_id],
    )?;
    conn.execute(
        "DELETE FROM sources WHERE source_id = ?1",
        params![source_id],
    )?;
    Ok(())
}

fn source_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, String, String, String)> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
}

fn parse_source(row: (String, String, String, String, String)) -> Result<SourceRow> {
    let (source_id, name, adapter, config, env) = row;
    let config: Value = serde_json::from_str(&config)?;
    let env: Value = serde_json::from_str(&env)?;
    let config = match config {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    let env = match env {
        Value::Object(m) => m
            .into_iter()
            .map(|(k, v)| {
                let s = match v {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                (k, s)
            })
            .collect(),
        _ => BTreeMap::new(),
    };
    Ok(SourceRow {
        source_id,
        name,
        adapter,
        config,
        env,
    })
}

const SOURCE_COLUMNS: &str = "source_id, name, adapter, config, env";

/// Every source, by name.
pub fn list_sources(store: &Store) -> Result<Vec<SourceRow>> {
    let mut stmt = store.conn().prepare(&format!(
        "SELECT {SOURCE_COLUMNS} FROM sources ORDER BY name"
    ))?;
    let rows = stmt.query_map([], source_row)?;
    rows.map(|r| parse_source(r?)).collect()
}

/// The source named `name`, if any.
pub fn source_by_name(store: &Store, name: &str) -> Result<Option<SourceRow>> {
    let row = store
        .conn()
        .query_row(
            &format!("SELECT {SOURCE_COLUMNS} FROM sources WHERE name = ?1"),
            params![name],
            source_row,
        )
        .optional()?;
    row.map(parse_source).transpose()
}

/// The source with `source_id`, if any.
pub fn source_by_id(store: &Store, source_id: &str) -> Result<Option<SourceRow>> {
    let row = store
        .conn()
        .query_row(
            &format!("SELECT {SOURCE_COLUMNS} FROM sources WHERE source_id = ?1"),
            params![source_id],
            source_row,
        )
        .optional()?;
    row.map(parse_source).transpose()
}

/// Attach a source to a repo (`INSERT OR IGNORE`).
pub fn attach(store: &Store, repo_id: &str, source_id: &str) -> Result<()> {
    store.conn().execute(
        "INSERT OR IGNORE INTO attachments (repo_id, source_id) VALUES (?1, ?2)",
        params![repo_id, source_id],
    )?;
    Ok(())
}

/// Detach a source from a repo.
pub fn detach(store: &Store, repo_id: &str, source_id: &str) -> Result<()> {
    store.conn().execute(
        "DELETE FROM attachments WHERE repo_id = ?1 AND source_id = ?2",
        params![repo_id, source_id],
    )?;
    Ok(())
}

/// The sources attached to a repo, ordered by `name`.
pub fn sources_for_repo(store: &Store, repo_id: &str) -> Result<Vec<SourceRow>> {
    let mut stmt = store.conn().prepare(&format!(
        "SELECT s.{} FROM sources s JOIN attachments a ON a.source_id = s.source_id
         WHERE a.repo_id = ?1 ORDER BY s.name",
        SOURCE_COLUMNS.replace(", ", ", s.")
    ))?;
    let rows = stmt.query_map(params![repo_id], source_row)?;
    rows.map(|r| parse_source(r?)).collect()
}

/// §2 `ensure_repo`: an existing slug returns its id; else **mint `rp`**,
/// insert with default settings, and with a root register the filesystem
/// source — `INSERT OR IGNORE` the `fs` adapter, find or create (**mint
/// `src`**) `<slug>-fs` with `config {"root": <root>}`, attach it.
pub fn ensure_repo(store: &mut Store, slug: &str, root_path: Option<&str>) -> Result<String> {
    if let Some(id) = store.repo_by_slug(slug)? {
        return Ok(id);
    }
    let repo_id = store.create_repo(slug)?;
    if let Some(root) = root_path.filter(|r| !r.is_empty()) {
        register_fs_source(store, &repo_id, slug, root)?;
    }
    Ok(repo_id)
}

/// The `<slug>-fs` source at `root`, registered idempotently and attached.
pub fn register_fs_source(
    store: &mut Store,
    repo_id: &str,
    slug: &str,
    root: &str,
) -> Result<String> {
    store.conn().execute(
        "INSERT OR IGNORE INTO adapters (name, command, args) VALUES (?1, ?2, '[]')",
        params![FS_ADAPTER, FS_ADAPTER_COMMAND],
    )?;
    let name = format!("{slug}-fs");
    let existing: Option<String> = store
        .conn()
        .query_row(
            "SELECT source_id FROM sources WHERE name = ?1",
            params![name],
            |r| r.get(0),
        )
        .optional()?;
    let source_id = match existing {
        Some(id) => id,
        None => {
            let id = store.mint("src");
            let config = serde_json::json!({ "root": root }).to_string();
            store.conn().execute(
                "INSERT INTO sources (source_id, name, adapter, config, env) VALUES (?1, ?2, ?3, ?4, '{}')",
                params![id, name, FS_ADAPTER, config],
            )?;
            id
        }
    };
    attach(store, repo_id, &source_id)?;
    Ok(source_id)
}

/// JavaScript `Number.prototype.toString()` for a finite double.
fn js_number(n: f64) -> String {
    if n == 0.0 {
        return "0".to_owned();
    }
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let neg = n < 0.0;
    let m = n.abs();
    // Shortest round-trip digits and the decimal exponent, from Rust's `{:e}`.
    let sci = format!("{m:e}");
    let (mantissa, exp) = sci.split_once('e').expect("{:e} has an exponent");
    let exp: i32 = exp.parse().expect("integer exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n_exp = exp + 1; // JS's `n`: the position of the decimal point
    let body = if k <= n_exp && n_exp <= 21 {
        format!("{digits}{}", "0".repeat((n_exp - k) as usize))
    } else if 0 < n_exp && n_exp <= 21 {
        let (a, b) = digits.split_at(n_exp as usize);
        format!("{a}.{b}")
    } else if -6 < n_exp && n_exp <= 0 {
        format!("0.{}{digits}", "0".repeat((-n_exp) as usize))
    } else {
        let e = n_exp - 1;
        let sign = if e < 0 { "-" } else { "+" };
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{sign}{}", e.abs())
        } else {
            format!("{first}.{rest}e{sign}{}", e.abs())
        }
    };
    if neg { format!("-{body}") } else { body }
}

/// JavaScript `String(value)` for a JSON value: strings as is, numbers as JS
/// prints them, booleans, `null` → `"null"`, arrays comma-joined (with
/// `null` elements empty, as `Array.prototype.toString`), objects
/// `[object Object]`.
#[must_use]
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|it| match it {
                Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// §2 `render_config_flags`: for each entry in the object's order, skip
/// `null`; `true` → `--key`; `false` → nothing; else `--key`,
/// `String(value)`.
#[must_use]
pub fn render_config_flags(config: &Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    for (key, value) in config {
        match value {
            Value::Null => {}
            Value::Bool(true) => out.push(format!("--{key}")),
            Value::Bool(false) => {}
            other => {
                out.push(format!("--{key}"));
                out.push(js_string(other));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use omgbase_store::SequentialMinter;
    use serde_json::json;

    fn store() -> Store {
        Store::open_in_memory_with_minter(Box::new(SequentialMinter::new())).unwrap()
    }

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn js_numbers_print_like_javascript() {
        for (n, want) in [
            (1.0, "1"),
            (-1.0, "-1"),
            (0.0, "0"),
            (1.5, "1.5"),
            (100.0, "100"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (123456789012.0, "123456789012"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (0.30000000000000004, "0.30000000000000004"),
        ] {
            assert_eq!(js_number(n), want, "{n}");
        }
        assert_eq!(js_string(&json!(750)), "750");
        assert_eq!(js_string(&json!([1, "a", null, true])), "1,a,,true");
        assert_eq!(js_string(&json!({"a": 1})), "[object Object]");
        assert_eq!(js_string(&json!(null)), "null");
    }

    #[test]
    fn render_flags_follow_the_reference() {
        let flags = render_config_flags(&obj(json!({
            "root": "/data/v", "debounce": 750, "verbose": true, "quiet": false,
            "skip": null, "ext": [".md", ".txt"], "nested": {"a": 1}, "ratio": 0.5
        })));
        assert_eq!(
            flags,
            vec![
                "--root",
                "/data/v",
                "--debounce",
                "750",
                "--verbose",
                "--ext",
                ".md,.txt",
                "--nested",
                "[object Object]",
                "--ratio",
                "0.5"
            ]
        );
        assert!(render_config_flags(&Map::new()).is_empty());
    }

    #[test]
    fn registry_round_trip() {
        let mut s = store();
        ensure_adapter(&s, "git", "omgbase-git-adapter", &["--x".to_owned()]).unwrap();
        ensure_adapter(&s, "git", "git2", &[]).unwrap();
        let adapters = list_adapters(&s).unwrap();
        assert_eq!(adapters.len(), 1);
        assert_eq!(adapters[0].command, "git2");
        assert!(adapters[0].args.is_empty());

        let cfg = obj(json!({"url": "https://x", "depth": 1}));
        let env: BTreeMap<String, String> =
            [("TOKEN".to_owned(), "t".to_owned())].into_iter().collect();
        let id = create_source(
            &mut s,
            &NewSource {
                name: "remote",
                adapter: "git",
                config: Some(&cfg),
                env: Some(&env),
            },
        )
        .unwrap();
        assert_eq!(id, "src_0");
        assert!(
            create_source(
                &mut s,
                &NewSource {
                    name: "remote",
                    adapter: "git",
                    ..NewSource::default()
                }
            )
            .is_err(),
            "taken name"
        );
        assert!(
            create_source(
                &mut s,
                &NewSource {
                    name: "other",
                    adapter: "nope",
                    ..NewSource::default()
                }
            )
            .is_err(),
            "unknown adapter (FK)"
        );
        let row = source_by_name(&s, "remote").unwrap().unwrap();
        assert_eq!(row.config, cfg);
        assert_eq!(row.env, env);
        assert_eq!(source_by_id(&s, "src_0").unwrap().unwrap().name, "remote");
        assert!(source_by_name(&s, "zzz").unwrap().is_none());

        let repo = ensure_repo(&mut s, "vault", Some("/data/vault")).unwrap();
        assert_eq!(repo, "rp_0");
        assert_eq!(
            ensure_repo(&mut s, "vault", Some("/other")).unwrap(),
            "rp_0"
        );
        let fs = source_by_name(&s, "vault-fs").unwrap().unwrap();
        assert_eq!(fs.adapter, "fs");
        assert_eq!(fs.config, obj(json!({"root": "/data/vault"})));
        assert!(fs.env.is_empty());
        assert_eq!(
            list_adapters(&s)
                .unwrap()
                .iter()
                .map(|a| a.name.as_str())
                .collect::<Vec<_>>(),
            ["fs", "git"]
        );

        attach(&s, &repo, &id).unwrap();
        attach(&s, &repo, &id).unwrap();
        let attached = sources_for_repo(&s, &repo).unwrap();
        assert_eq!(
            attached.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            ["remote", "vault-fs"]
        );
        detach(&s, &repo, &id).unwrap();
        assert_eq!(sources_for_repo(&s, &repo).unwrap().len(), 1);

        s.conn()
            .execute(
                "INSERT INTO sync_state (repo_id, source_id, path) VALUES (?1, ?2, '')",
                params![repo, fs.source_id],
            )
            .unwrap();
        delete_source(&s, &fs.source_id).unwrap();
        assert!(source_by_name(&s, "vault-fs").unwrap().is_none());
        assert!(sources_for_repo(&s, &repo).unwrap().is_empty());
        let n: i64 = s
            .conn()
            .query_row("SELECT count(*) FROM sync_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
        assert_eq!(list_sources(&s).unwrap().len(), 1);

        let headless = ensure_repo(&mut s, "head", None).unwrap();
        assert!(sources_for_repo(&s, &headless).unwrap().is_empty());
        assert_eq!(ensure_repo(&mut s, "empty-root", Some("")).unwrap(), "rp_2");
        assert!(source_by_name(&s, "empty-root-fs").unwrap().is_none());
    }
}
