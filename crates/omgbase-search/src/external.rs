//! External embedding providers (`spec/search` §5): a spawned command spoken
//! to over newline-delimited JSON, or an http(s) endpoint (feature `http`).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::fts::split_ws;
use crate::provider::EmbeddingProvider;
use crate::vec::to_f32;

/// The `embedding.*` repo settings (§5).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EmbeddingSettings {
    /// A command to spawn or an http(s) URL; `None` → no provider.
    pub provider: Option<String>,
    pub model: Option<String>,
    pub dim: Option<usize>,
    pub max_input_tokens: Option<u32>,
}

/// The metadata a provider reports (the stdio handshake line, the HTTP `GET`).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
struct Metadata {
    model: Option<String>,
    dim: Option<f64>,
    #[serde(rename = "maxInputTokens")]
    max_input_tokens: Option<f64>,
}

/// Resolved `model`/`dim`/`max_input_tokens`: the settings, then the
/// provider's metadata over them.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    model: String,
    dim: usize,
    max_input_tokens: Option<u32>,
}

impl Identity {
    fn from_settings(settings: &EmbeddingSettings, default_model: &str) -> Self {
        Self {
            model: settings
                .model
                .clone()
                .unwrap_or_else(|| default_model.to_owned()),
            dim: settings.dim.unwrap_or(0),
            max_input_tokens: settings.max_input_tokens,
        }
    }

    fn apply(&mut self, meta: &Metadata) {
        if let Some(m) = meta.model.as_deref().filter(|m| !m.is_empty()) {
            self.model = m.to_owned();
        }
        if let Some(d) = meta.dim {
            self.dim = d as usize;
        }
        if let Some(t) = meta.max_input_tokens {
            self.max_input_tokens = Some(t as u32);
        }
    }
}

/// Whether the provider setting names an endpoint rather than a command.
#[must_use]
pub fn is_url(s: &str) -> bool {
    let t = s.trim();
    let lower: String = t.chars().take(8).collect::<String>().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// §5: the `OMGBASE_EMBEDDER_MODEL` / `_DIM` / `_MAX_TOKENS` variables a
/// spawned command receives for the settings that are set (laid over the
/// inherited environment; an unset setting leaves the inherited value).
#[must_use]
pub fn embedder_env(settings: &EmbeddingSettings) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Some(m) = &settings.model {
        env.insert("OMGBASE_EMBEDDER_MODEL".to_owned(), m.clone());
    }
    if let Some(d) = settings.dim {
        env.insert("OMGBASE_EMBEDDER_DIM".to_owned(), d.to_string());
    }
    if let Some(t) = settings.max_input_tokens {
        env.insert("OMGBASE_EMBEDDER_MAX_TOKENS".to_owned(), t.to_string());
    }
    env
}

/// Build the provider the settings name: `None` when no provider is set
/// (`semantic_unavailable` is the caller's), an error when it cannot be
/// spawned or fails its handshake (`embedder_failed`).
pub fn create_external_provider(
    settings: &EmbeddingSettings,
) -> Result<Option<Box<dyn EmbeddingProvider>>> {
    let Some(spec) = settings
        .provider
        .as_deref()
        .filter(|p| !p.trim().is_empty())
    else {
        return Ok(None);
    };
    if is_url(spec) {
        #[cfg(feature = "http")]
        {
            return Ok(Some(Box::new(HttpProvider::connect(settings)?)));
        }
        #[cfg(not(feature = "http"))]
        {
            return Err(Error::EmbedderFailed(format!(
                "embedding endpoint {spec} needs the `http` feature of omgbase-search"
            )));
        }
    }
    Ok(Some(Box::new(StdioProvider::spawn(settings)?)))
}

// ---- stdio -----------------------------------------------------------------------

#[derive(Serialize)]
struct Request<'a> {
    id: u64,
    texts: &'a [String],
}

#[derive(Deserialize)]
struct Response {
    id: Option<u64>,
    vectors: Option<Vec<Vec<f64>>>,
    error: Option<String>,
}

struct Pipes {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

/// §5 stdio: a spawned command; one handshake line, then `{id, texts}` →
/// `{id, vectors}` per request. The child is killed on drop.
pub struct StdioProvider {
    identity: Identity,
    command: String,
    child: Mutex<Child>,
    pipes: Mutex<Pipes>,
}

impl std::fmt::Debug for StdioProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StdioProvider")
            .field("command", &self.command)
            .field("model", &self.identity.model)
            .field("dim", &self.identity.dim)
            .finish_non_exhaustive()
    }
}

fn read_line(reader: &mut BufReader<ChildStdout>, command: &str) -> Result<String> {
    let mut line = String::new();
    let n = reader.read_line(&mut line)?;
    if n == 0 {
        return Err(Error::EmbedderFailed(format!(
            "embedding command '{command}' exited early"
        )));
    }
    Ok(line.trim_end_matches(['\n', '\r']).to_owned())
}

impl StdioProvider {
    /// Spawn `settings.provider` (split on whitespace: program, args) with the
    /// [`embedder_env`] over the inherited environment; read the handshake.
    pub fn spawn(settings: &EmbeddingSettings) -> Result<Self> {
        let spec = settings.provider.as_deref().unwrap_or_default();
        let mut parts = split_ws(spec);
        let Some(program) = parts.next() else {
            return Err(Error::EmbedderFailed(
                "embedding command is empty".to_owned(),
            ));
        };
        let args: Vec<&str> = parts.collect();
        let mut child = Command::new(program)
            .args(&args)
            .envs(embedder_env(settings))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| {
                Error::EmbedderFailed(format!("embedding command '{spec}' failed to spawn: {e}"))
            })?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        let mut pipes = Pipes {
            stdin,
            stdout,
            next_id: 1,
        };
        let handshake = match read_line(&mut pipes.stdout, program) {
            Ok(l) => l,
            Err(e) => {
                let _ = child.kill();
                return Err(e);
            }
        };
        let meta: Metadata = serde_json::from_str(&handshake).map_err(|_| {
            let _ = child.kill();
            Error::EmbedderFailed(format!(
                "embedding command '{program}' sent an invalid handshake line: {}",
                handshake.chars().take(120).collect::<String>()
            ))
        })?;
        let mut identity = Identity::from_settings(settings, "stdio");
        identity.apply(&meta);
        Ok(Self {
            identity,
            command: program.to_owned(),
            child: Mutex::new(child),
            pipes: Mutex::new(pipes),
        })
    }
}

impl Drop for StdioProvider {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl EmbeddingProvider for StdioProvider {
    fn model(&self) -> &str {
        &self.identity.model
    }

    fn dim(&self) -> usize {
        self.identity.dim
    }

    fn max_input_tokens(&self) -> Option<u32> {
        self.identity.max_input_tokens
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut pipes = self
            .pipes
            .lock()
            .map_err(|_| Error::EmbedderFailed("embedder pipes poisoned".to_owned()))?;
        let id = pipes.next_id;
        pipes.next_id += 1;
        let mut line = serde_json::to_string(&Request { id, texts })?;
        line.push('\n');
        pipes.stdin.write_all(line.as_bytes())?;
        pipes.stdin.flush()?;
        loop {
            let raw = read_line(&mut pipes.stdout, &self.command)?;
            let resp: Response = serde_json::from_str(&raw)?;
            if let Some(err) = resp.error {
                return Err(Error::EmbedderFailed(format!("embedder error: {err}")));
            }
            if resp.id == Some(id) {
                let vectors = resp.vectors.ok_or_else(|| {
                    Error::EmbedderFailed("embedder response missing vectors".to_owned())
                })?;
                return Ok(vectors.iter().map(|v| to_f32(v)).collect());
            }
        }
    }
}

// ---- http ---------------------------------------------------------------------------

/// §5 http: `GET url` → metadata (best-effort), `POST url {texts, model}` →
/// `{vectors}`.
#[cfg(feature = "http")]
#[derive(Debug)]
pub struct HttpProvider {
    url: String,
    identity: Identity,
}

#[cfg(feature = "http")]
impl HttpProvider {
    /// Connect: metadata is best-effort (a failure leaves the configured
    /// `model`/`dim`); `embed` failures are the real signal.
    pub fn connect(settings: &EmbeddingSettings) -> Result<Self> {
        let url = settings
            .provider
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_owned();
        let mut identity = Identity::from_settings(settings, "http");
        if let Ok(mut res) = ureq::get(&url).call() {
            if let Ok(meta) = res.body_mut().read_json::<Metadata>() {
                identity.apply(&meta);
            }
        }
        Ok(Self { url, identity })
    }
}

#[cfg(feature = "http")]
impl EmbeddingProvider for HttpProvider {
    fn model(&self) -> &str {
        &self.identity.model
    }

    fn dim(&self) -> usize {
        self.identity.dim
    }

    fn max_input_tokens(&self) -> Option<u32> {
        self.identity.max_input_tokens
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        #[derive(Serialize)]
        struct Body<'a> {
            texts: &'a [String],
            model: &'a str,
        }
        #[derive(Deserialize)]
        struct Reply {
            vectors: Option<Vec<Vec<f64>>>,
        }
        let mut res = ureq::post(&self.url)
            .send_json(Body {
                texts,
                model: &self.identity.model,
            })
            .map_err(|e| match e {
                ureq::Error::StatusCode(code) => Error::EmbedderFailed(format!(
                    "embedding endpoint {} returned {code}",
                    self.url
                )),
                other => Error::EmbedderFailed(format!("embedding endpoint {}: {other}", self.url)),
            })?;
        let reply: Reply = res
            .body_mut()
            .read_json()
            .map_err(|e| Error::EmbedderFailed(format!("embedding endpoint {}: {e}", self.url)))?;
        let vectors = reply.vectors.ok_or_else(|| {
            Error::EmbedderFailed(format!(
                "embedding endpoint {} returned no \"vectors\"",
                self.url
            ))
        })?;
        Ok(vectors.iter().map(|v| to_f32(v)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_env_and_url_detection() {
        assert!(is_url("https://x.example/embed"));
        assert!(is_url("  HTTP://x "));
        assert!(!is_url("omgbase-embedder"));
        assert!(!is_url("httpd --serve"));
        let s = EmbeddingSettings {
            provider: Some("cmd".to_owned()),
            model: Some("m".to_owned()),
            dim: Some(3),
            max_input_tokens: None,
        };
        let env = embedder_env(&s);
        assert_eq!(
            env.get("OMGBASE_EMBEDDER_MODEL").map(String::as_str),
            Some("m")
        );
        assert_eq!(
            env.get("OMGBASE_EMBEDDER_DIM").map(String::as_str),
            Some("3")
        );
        assert!(!env.contains_key("OMGBASE_EMBEDDER_MAX_TOKENS"));
        assert!(
            create_external_provider(&EmbeddingSettings::default())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn identity_precedence() {
        let s = EmbeddingSettings {
            provider: None,
            model: Some("cfg".to_owned()),
            dim: Some(2),
            max_input_tokens: Some(10),
        };
        let mut id = Identity::from_settings(&s, "stdio");
        id.apply(&Metadata {
            model: Some("hand".to_owned()),
            dim: Some(4.0),
            max_input_tokens: None,
        });
        assert_eq!(
            id,
            Identity {
                model: "hand".to_owned(),
                dim: 4,
                max_input_tokens: Some(10)
            }
        );
        let id = Identity::from_settings(&EmbeddingSettings::default(), "http");
        assert_eq!(
            id,
            Identity {
                model: "http".to_owned(),
                dim: 0,
                max_input_tokens: None
            }
        );
    }

    #[test]
    fn spawn_failure_is_embedder_failed() {
        let s = EmbeddingSettings {
            provider: Some("/definitely/not/a/program".to_owned()),
            ..EmbeddingSettings::default()
        };
        let err = create_external_provider(&s).err().expect("spawn fails");
        assert_eq!(err.code(), "embedder_failed");
        assert!(err.to_string().contains("failed to spawn"));
    }

    #[cfg(unix)]
    #[test]
    fn stdio_protocol_round_trip() {
        // A shell embedder: handshake, then one `{id, vectors}` per request
        // (two fixed vectors, so requests carry two texts). It also emits an
        // unrelated id first to prove the reader waits for its own.
        let script = r#"echo '{"model":"sh","dim":2,"maxInputTokens":32}'
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\1/')
  echo '{"id":999,"vectors":[[9,9]]}'
  echo "{\"id\":$id,\"vectors\":[[1,0.5],[0,1]]}"
done"#;
        let dir = std::env::temp_dir().join(format!("omgbase-search-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("embedder.sh");
        std::fs::write(&path, script).unwrap();
        let settings = EmbeddingSettings {
            provider: Some(format!("sh {}", path.display())),
            model: Some("cfg".to_owned()),
            dim: Some(9),
            max_input_tokens: None,
        };
        let p = StdioProvider::spawn(&settings).expect("spawns");
        assert_eq!(
            (p.model(), p.dim(), p.max_input_tokens()),
            ("sh", 2, Some(32))
        );
        let v = p.embed(&["a".to_owned(), "b".to_owned()]).unwrap();
        assert_eq!(v, vec![vec![1.0f32, 0.5], vec![0.0, 1.0]]);
        let v = p.embed(&["c".to_owned(), "d".to_owned()]).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(p.embed(&[]).unwrap(), Vec::<Vec<f32>>::new());
        drop(p);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
