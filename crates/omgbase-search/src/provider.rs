//! The embedding provider seam (`spec/search` §5) and the fixture embedder
//! (§6).

use crate::embed::sha256;
use crate::error::Result;

/// An embedding model: an external process or endpoint (see
/// [`crate::external`]) or, in a runner, the [`FixtureEmbedder`].
pub trait EmbeddingProvider {
    /// The model name the cache is keyed by.
    fn model(&self) -> &str;
    /// The vector length written to `dim`.
    fn dim(&self) -> usize;
    /// The model's input limit in tokens, when it reports one (§2.4).
    fn max_input_tokens(&self) -> Option<u32>;
    /// Embed a batch of inputs → one float32 vector per input.
    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;

    /// Embed a bare query string (no context prefix).
    fn embed_query(&self, query: &str) -> Result<Vec<f32>> {
        let mut vectors = self.embed(&[query.to_owned()])?;
        vectors.pop().ok_or_else(|| {
            crate::Error::EmbedderFailed("embedder returned no vector for the query".to_owned())
        })
    }
}

/// The fixture embedder's model name.
pub const FIXTURE_MODEL: &str = "fixture-hash-8";
/// The fixture embedder's dimension.
pub const FIXTURE_DIM: usize = 8;
/// The fixture embedder's input limit.
pub const FIXTURE_MAX_INPUT_TOKENS: u32 = 64;

/// §6: the deterministic hash embedder every runner implements. It is a
/// runner device, never a product path.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FixtureEmbedder;

impl FixtureEmbedder {
    /// §6 for one string: `h = sha256(utf8(s))`; `u = h[2i] × 256 + h[2i+1]`,
    /// `raw[i] = u / 65535 × 2 − 1` in f64 for `i < 8`; L2-normalized in
    /// f64; each component stored as float32.
    #[must_use]
    pub fn vector(s: &str) -> Vec<f32> {
        let h = sha256(s);
        let raw: Vec<f64> = (0..FIXTURE_DIM)
            .map(|i| {
                let u = f64::from(h[2 * i]) * 256.0 + f64::from(h[2 * i + 1]);
                u / 65535.0 * 2.0 - 1.0
            })
            .collect();
        let norm = raw.iter().map(|x| x * x).sum::<f64>().sqrt();
        raw.iter()
            .map(|x| if norm == 0.0 { 0.0 } else { (x / norm) as f32 })
            .collect()
    }
}

impl EmbeddingProvider for FixtureEmbedder {
    fn model(&self) -> &str {
        FIXTURE_MODEL
    }

    fn dim(&self) -> usize {
        FIXTURE_DIM
    }

    fn max_input_tokens(&self) -> Option<u32> {
        Some(FIXTURE_MAX_INPUT_TOKENS)
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|t| Self::vector(t)).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_embedder_is_the_readme_construction() {
        // sha256("") = e3b0c442 98fc1c14 9afbf4c8 996fb924 27ae41e4 649b934c a495991b 7852b855
        let h = sha256("");
        let raw: Vec<f64> = (0..8)
            .map(|i| (f64::from(h[2 * i]) * 256.0 + f64::from(h[2 * i + 1])) / 65535.0 * 2.0 - 1.0)
            .collect();
        assert_eq!(raw[0], (0xe3b0 as f64) / 65535.0 * 2.0 - 1.0);
        let norm = raw.iter().map(|x| x * x).sum::<f64>().sqrt();
        let want: Vec<f32> = raw.iter().map(|x| (x / norm) as f32).collect();
        assert_eq!(FixtureEmbedder::vector(""), want);
        let v = FixtureEmbedder::vector("hello");
        assert_eq!(v.len(), 8);
        let n: f64 = v.iter().map(|x| f64::from(*x) * f64::from(*x)).sum();
        assert!((n.sqrt() - 1.0).abs() < 1e-6);
        assert_ne!(FixtureEmbedder::vector("a"), FixtureEmbedder::vector("b"));
        let p = FixtureEmbedder;
        assert_eq!(
            (p.model(), p.dim(), p.max_input_tokens()),
            ("fixture-hash-8", 8, Some(64))
        );
        assert_eq!(p.embed(&["a".to_owned(), "b".to_owned()]).unwrap().len(), 2);
        assert_eq!(p.embed_query("a").unwrap(), FixtureEmbedder::vector("a"));
    }
}
