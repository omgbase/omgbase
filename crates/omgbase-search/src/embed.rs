//! Embeddings (`spec/search` §2): which blocks embed, the exact strings a
//! provider is asked for, the cache keys, the document input and its
//! whole-vs-pooled budget, and pooling.

use sha2::{Digest, Sha256};

use crate::fts::split_ws;

/// §2.1: the minimum token count for a block to embed on its own.
pub const MIN_EMBED_TOKENS: usize = 24;
/// §2.3: cache misses are embedded in requests of this many inputs.
pub const EMBED_BATCH: usize = 32;
/// §2.4: the whole-document budget when the provider reports no limit.
pub const DEFAULT_DOC_TOKEN_BUDGET: u32 = 512;
/// §2.4: tokens reserved for the document header line.
pub const DOC_HEADER_MARGIN_TOKENS: u32 = 16;

/// `sha256(utf8(s))`.
#[must_use]
pub fn sha256(s: &str) -> [u8; 32] {
    Sha256::digest(s.as_bytes()).into()
}

/// Lower-case hex of `bytes`.
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// §2.1: the number of non-empty pieces of `text` split on `\s+`.
#[must_use]
pub fn word_count(text: &str) -> usize {
    split_ws(text).count()
}

/// §2.1: a block embeds on its own when its text has at least
/// [`MIN_EMBED_TOKENS`] words.
#[must_use]
pub fn should_embed(text: &str) -> bool {
    word_count(text) >= MIN_EMBED_TOKENS
}

/// §2.1: `ceil(words × 1.3)`, the budget estimate and the pooling weight.
#[must_use]
pub fn estimate_tokens(text: &str) -> u64 {
    (word_count(text) as f64 * 1.3).ceil() as u64
}

/// §2.2: `doc_title · path · chain.join(" › ") · type`.
#[must_use]
pub fn context_prefix(
    doc_title: &str,
    path: &str,
    heading_chain: &[String],
    block_type: &str,
) -> String {
    format!(
        "{doc_title} \u{00B7} {path} \u{00B7} {} \u{00B7} {block_type}",
        heading_chain.join(" \u{203A} ")
    )
}

/// §2.2: what the provider is asked for: `ctx + "\n" + text`.
#[must_use]
pub fn embed_input(ctx: &str, block_text: &str) -> String {
    format!("{ctx}\n{block_text}")
}

/// §2.2: `sha256(ctx)`, the second cache key.
#[must_use]
pub fn ctx_hash(ctx: &str) -> [u8; 32] {
    sha256(ctx)
}

/// One block to embed (§2.2–§2.3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmbedTask {
    pub block_id: String,
    /// The block's `raw_hash`, hex.
    pub content_hash: String,
    pub ctx: String,
    pub text: String,
}

impl EmbedTask {
    /// The provider input for this task.
    #[must_use]
    pub fn input(&self) -> String {
        embed_input(&self.ctx, &self.text)
    }
}

/// §2.4: `[title, path, "type: " + type?, "layer: " + layer?].join(" · ")`;
/// `type`/`layer` only when given (the caller passes the merged property when
/// it is a non-blank string).
#[must_use]
pub fn doc_header(title: &str, path: &str, doc_type: Option<&str>, layer: Option<&str>) -> String {
    let mut bits = vec![title.to_owned(), path.to_owned()];
    if let Some(t) = doc_type {
        bits.push(format!("type: {t}"));
    }
    if let Some(l) = layer {
        bits.push(format!("layer: {l}"));
    }
    bits.join(" \u{00B7} ")
}

/// §2.4: `header + "\n" + body`.
#[must_use]
pub fn doc_input(header: &str, body: &str) -> String {
    format!("{header}\n{body}")
}

/// §2.4: `max(1, (max_input_tokens ?? 512) − 16)`.
#[must_use]
pub fn token_budget(max_input_tokens: Option<u32>) -> u64 {
    let budget = max_input_tokens.unwrap_or(DEFAULT_DOC_TOKEN_BUDGET);
    u64::from(budget.saturating_sub(DOC_HEADER_MARGIN_TOKENS).max(1))
}

/// How a document vector was (or would be) computed (§2.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DocEmbedMethod {
    /// The input was within budget and sent to the provider.
    Whole,
    /// Over budget: the token-weighted mean of the cached block vectors.
    Pooled,
}

impl DocEmbedMethod {
    /// The `doc_embeddings.method` spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            DocEmbedMethod::Whole => "whole",
            DocEmbedMethod::Pooled => "pooled",
        }
    }

    /// Parse the stored spelling.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "whole" => Some(DocEmbedMethod::Whole),
            "pooled" => Some(DocEmbedMethod::Pooled),
            _ => None,
        }
    }

    /// §2.4: whole when `estimate_tokens(input)` is within `budget`, else pooled.
    #[must_use]
    pub fn for_input(input: &str, budget: u64) -> Self {
        if estimate_tokens(input) <= budget {
            DocEmbedMethod::Whole
        } else {
            DocEmbedMethod::Pooled
        }
    }
}

/// A block's contribution to a pooled document vector (§2.5): where its cached
/// vector is keyed and its weight.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocEmbedBlockRef {
    /// The block's `raw_hash`, hex.
    pub content_hash: String,
    pub ctx: String,
    /// `estimate_tokens(text)`.
    pub tokens: u64,
}

/// One document to embed (§2.4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocEmbedTask {
    pub doc_id: String,
    /// The §2.4 header line.
    pub header: String,
    /// `header + "\n" + reconstruct(doc)`.
    pub input: String,
    /// The document's embeddable blocks in `(path, ordinal)` order.
    pub blocks: Vec<DocEmbedBlockRef>,
}

impl DocEmbedTask {
    /// §2.4: `sha256(input)`, the freshness key.
    #[must_use]
    pub fn input_hash(&self) -> [u8; 32] {
        sha256(&self.input)
    }
}

/// §2.5: over `refs` in order, each with weight `w = max(1, tokens)`, skip
/// blocks with no cached vector; `acc[i] += w × v[i]` over `min(dim, |v|)`
/// components in f64; `None` when nothing contributed; else `acc[i] /= Σw`,
/// `norm = √Σacc²`, `out[i] = acc[i] / norm` as float32 (zeros when the norm
/// is 0).
pub fn pool_block_vectors<F>(
    dim: usize,
    refs: &[DocEmbedBlockRef],
    mut cached: F,
) -> Option<Vec<f32>>
where
    F: FnMut(&DocEmbedBlockRef) -> Option<Vec<f32>>,
{
    let mut acc = vec![0.0f64; dim];
    let mut weight_sum = 0.0f64;
    for r in refs {
        let Some(v) = cached(r) else {
            continue;
        };
        let w = if r.tokens > 0 { r.tokens as f64 } else { 1.0 };
        let n = dim.min(v.len());
        for i in 0..n {
            acc[i] += w * f64::from(v[i]);
        }
        weight_sum += w;
    }
    if weight_sum == 0.0 {
        return None;
    }
    let mut norm = 0.0f64;
    for a in &mut acc {
        *a /= weight_sum;
        norm += *a * *a;
    }
    let norm = norm.sqrt();
    if norm == 0.0 {
        return Some(vec![0.0f32; dim]);
    }
    Some(acc.iter().map(|a| (a / norm) as f32).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_embed_threshold_and_estimate() {
        let words = |n: usize| {
            (0..n)
                .map(|i| format!("w{i}"))
                .collect::<Vec<_>>()
                .join(" ")
        };
        assert!(!should_embed(&words(23)));
        assert!(should_embed(&words(24)));
        assert!(should_embed(&format!("  {}  \n", words(24))));
        assert!(!should_embed(""));
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("one"), 2);
        assert_eq!(estimate_tokens("one two three"), 4); // ceil(3.9)
        assert_eq!(estimate_tokens(&words(10)), 13);
        assert_eq!(estimate_tokens(&words(24)), 32); // ceil(31.200000000000003)
    }

    #[test]
    fn context_prefix_shape() {
        assert_eq!(
            context_prefix(
                "T",
                "a.md",
                &["H1".to_owned(), "H2".to_owned()],
                "paragraph"
            ),
            "T · a.md · H1 › H2 · paragraph"
        );
        assert_eq!(
            context_prefix("title", "path", &[], "paragraph"),
            "title · path ·  · paragraph"
        );
        assert_eq!(embed_input("ctx", "text"), "ctx\ntext");
        assert_eq!(hex(&ctx_hash("ctx")), hex(&sha256("ctx")));
        assert_eq!(
            hex(&sha256("")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn doc_header_and_budget() {
        assert_eq!(doc_header("T", "a.md", None, None), "T · a.md");
        assert_eq!(
            doc_header("T", "a.md", Some("note"), Some("canon")),
            "T · a.md · type: note · layer: canon"
        );
        assert_eq!(doc_input("h", "body\n"), "h\nbody\n");
        assert_eq!(token_budget(None), 496);
        assert_eq!(token_budget(Some(64)), 48);
        assert_eq!(token_budget(Some(16)), 1);
        assert_eq!(token_budget(Some(0)), 1);
        assert_eq!(DocEmbedMethod::for_input("a b c", 4), DocEmbedMethod::Whole);
        assert_eq!(
            DocEmbedMethod::for_input("a b c", 3),
            DocEmbedMethod::Pooled
        );
        assert_eq!(DocEmbedMethod::parse("whole"), Some(DocEmbedMethod::Whole));
        assert_eq!(DocEmbedMethod::parse("x"), None);
    }

    fn r(hash: &str, tokens: u64) -> DocEmbedBlockRef {
        DocEmbedBlockRef {
            content_hash: hash.to_owned(),
            ctx: "c".to_owned(),
            tokens,
        }
    }

    #[test]
    fn pooling_math() {
        let refs = [r("a", 3), r("miss", 100), r("b", 1), r("zero", 0)];
        let lookup = |x: &DocEmbedBlockRef| match x.content_hash.as_str() {
            "a" => Some(vec![1.0f32, 0.0]),
            "b" => Some(vec![0.0f32, 1.0, 9.0]), // the third component is beyond dim
            "zero" => Some(vec![0.0f32, 0.0]),
            _ => None,
        };
        // acc = (3·1 + 0, 0 + 1·1) / 5 = (0.6, 0.2); normalized.
        let v = pool_block_vectors(2, &refs, lookup).unwrap();
        let norm = (0.6f64 * 0.6 + 0.2 * 0.2).sqrt();
        assert_eq!(v, vec![(0.6 / norm) as f32, (0.2 / norm) as f32]);
        // Nothing cached → stays queued.
        assert_eq!(pool_block_vectors(2, &refs, |_| None), None);
        // All-zero contributions → zeros, not None.
        assert_eq!(
            pool_block_vectors(2, &[r("zero", 2)], |_| Some(vec![0.0, 0.0])),
            Some(vec![0.0, 0.0])
        );
        // A short cached vector leaves the tail at zero.
        assert_eq!(
            pool_block_vectors(3, &[r("a", 1)], |_| Some(vec![2.0])),
            Some(vec![1.0, 0.0, 0.0])
        );
    }
}
