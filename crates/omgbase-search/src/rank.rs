//! Fusion and boosts (`spec/search` §4) as pure functions over ranked id
//! lists and per-document facts, plus the `resolve` shaping.

use serde_json::Value as Json;

use crate::fts::split_ws;

/// §4: the reciprocal-rank constant.
pub const RRF_K: f64 = 60.0;
/// §4: `hybrid`'s FTS and vector passes both ask for this many hits.
pub const HYBRID_PASS_LIMIT: usize = 200;
/// §4: `resolve`'s default limit.
pub const RESOLVE_DEFAULT_LIMIT: usize = 10;
/// §4: words in a `resolve` preview.
pub const PREVIEW_WORDS: usize = 12;

pub const TITLE_BOOST: f64 = 1.25;
pub const HEADING_BOOST: f64 = 1.15;
pub const PATH_BOOST: f64 = 1.10;

/// §4 step 4: the `layer` boost; `None` for `proposed` (×1.0, not recorded)
/// and unknown layers.
#[must_use]
pub fn layer_boost(layer: &str) -> Option<f64> {
    match layer {
        "canon" => Some(1.3),
        "working" => Some(1.15),
        "draft" => Some(0.85),
        _ => None,
    }
}

/// The multiplicative boosts of a hit, each present only when it applies.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Boosts {
    pub title: Option<f64>,
    pub heading: Option<f64>,
    pub path: Option<f64>,
    pub layer: Option<f64>,
    /// Reserved; never set.
    pub recency: Option<f64>,
}

impl Boosts {
    /// The boosts as the `evidence.boosts` object (present keys only).
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = serde_json::Map::new();
        for (k, v) in [
            ("title", self.title),
            ("heading", self.heading),
            ("path", self.path),
            ("layer", self.layer),
            ("recency", self.recency),
        ] {
            if let Some(v) = v {
                m.insert(k.to_owned(), Json::from(v));
            }
        }
        Json::Object(m)
    }
}

/// The per-document and per-block facts the boosts read (§4 step 4).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BoostFacts {
    /// The merged `title` property rendered with [`property_to_string`]
    /// (`""` when absent).
    pub title: String,
    /// The merged `layer` property rendered likewise.
    pub layer: String,
    pub path: String,
    /// The texts of the section headings whose range contains the block.
    pub headings: Vec<String>,
}

/// §4 step 4: `terms` default to `text` split on `\s+`.
#[must_use]
pub fn default_terms(text: Option<&str>) -> Vec<String> {
    text.map(|t| split_ws(t).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// §4 step 4: lower-cased for matching, empties dropped.
#[must_use]
pub fn lower_terms(terms: &[String]) -> Vec<String> {
    terms
        .iter()
        .map(|t| t.to_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

/// JavaScript's `String(value ?? "")` over a merged property value: strings
/// verbatim, numbers and booleans as JavaScript prints them, `null` → `""`,
/// arrays joined by `,` (a null element is empty), objects `[object Object]`.
#[must_use]
pub fn property_to_string(value: Option<&Json>) -> String {
    fn element(v: &Json) -> String {
        match v {
            Json::Null => String::new(),
            Json::Array(items) => items.iter().map(element).collect::<Vec<_>>().join(","),
            other => scalar(other),
        }
    }
    fn scalar(v: &Json) -> String {
        match v {
            Json::Null => String::new(),
            Json::Bool(b) => b.to_string(),
            Json::Number(n) => n.as_f64().map_or_else(|| n.to_string(), js_number),
            Json::String(s) => s.clone(),
            Json::Array(items) => items.iter().map(element).collect::<Vec<_>>().join(","),
            Json::Object(_) => "[object Object]".to_owned(),
        }
    }
    value.map_or_else(String::new, scalar)
}

/// JavaScript `Number.prototype.toString()` for the values a property holds:
/// integers without a fraction, otherwise the shortest round-trip form.
fn js_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if n == n.trunc() && n.abs() < 1e21 {
        return format!("{}", n as i128);
    }
    format!("{n}")
}

/// §4 step 4: the boosts for one hit from its facts and the lower-cased terms.
#[must_use]
pub fn compute_boosts(facts: &BoostFacts, lower_terms: &[String]) -> Boosts {
    let mut b = Boosts::default();
    let title = facts.title.to_lowercase();
    if !title.is_empty() && lower_terms.iter().any(|t| title.contains(t.as_str())) {
        b.title = Some(TITLE_BOOST);
    }
    if facts.headings.iter().any(|h| {
        let h = h.to_lowercase();
        lower_terms.iter().any(|t| h.contains(t.as_str()))
    }) {
        b.heading = Some(HEADING_BOOST);
    }
    let path = facts.path.to_lowercase();
    if lower_terms.iter().any(|t| path.contains(t.as_str())) {
        b.path = Some(PATH_BOOST);
    }
    b.layer = layer_boost(&facts.layer);
    b
}

/// §4 step 3: `(fts_rank ? 1/(60+fts_rank) : 0) + (vec_rank ? 1/(60+vec_rank) : 0)`.
#[must_use]
pub fn rrf_score(fts_rank: Option<usize>, vector_rank: Option<usize>) -> f64 {
    let term = |r: Option<usize>| r.map_or(0.0, |r| 1.0 / (RRF_K + r as f64));
    term(fts_rank) + term(vector_rank)
}

/// §4 step 5: `rrf × Π boosts`, multiplied left to right in the reference's
/// order (title, heading, path, layer, recency) so the rounding is the same.
#[must_use]
pub fn apply_boosts(rrf: f64, boosts: &Boosts) -> f64 {
    rrf * boosts.title.unwrap_or(1.0)
        * boosts.heading.unwrap_or(1.0)
        * boosts.path.unwrap_or(1.0)
        * boosts.layer.unwrap_or(1.0)
        * boosts.recency.unwrap_or(1.0)
}

/// A fused candidate before boosts (§4 steps 1–3).
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub block_id: String,
    /// 1-based rank of the first FTS occurrence.
    pub fts_rank: Option<usize>,
    /// 1-based vector rank.
    pub vector_rank: Option<usize>,
    pub cosine: Option<f64>,
    pub rrf: f64,
}

/// §4 steps 1–3 over the two ranked lists: `fts` in FTS order and `vector`
/// in cosine order with each cosine; in both, the first occurrence of an id
/// ranks it. Candidates come out in first-seen order (FTS ids, then new
/// vector ids).
#[must_use]
pub fn fuse(fts: &[String], vector: &[(String, f64)]) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    for (i, id) in fts.iter().enumerate() {
        if out.iter().any(|c| &c.block_id == id) {
            continue;
        }
        out.push(Candidate {
            block_id: id.clone(),
            fts_rank: Some(i + 1),
            vector_rank: None,
            cosine: None,
            rrf: 0.0,
        });
    }
    for (i, (id, cos)) in vector.iter().enumerate() {
        match out.iter_mut().find(|c| &c.block_id == id) {
            Some(c) => {
                if c.vector_rank.is_none() {
                    c.vector_rank = Some(i + 1);
                    c.cosine = Some(*cos);
                }
            }
            None => out.push(Candidate {
                block_id: id.clone(),
                fts_rank: None,
                vector_rank: Some(i + 1),
                cosine: Some(*cos),
                rrf: 0.0,
            }),
        }
    }
    for c in &mut out {
        c.rrf = rrf_score(c.fts_rank, c.vector_rank);
    }
    out
}

/// The evidence a hybrid hit carries (§4 step 5).
#[derive(Clone, Debug, PartialEq)]
pub struct Evidence {
    pub fts_rank: Option<usize>,
    pub vector_rank: Option<usize>,
    pub cosine: Option<f64>,
    pub rrf: f64,
    pub boosts: Boosts,
}

impl Evidence {
    /// `{ fts_rank?, vector_rank?, cosine?, rrf, boosts }`.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut m = serde_json::Map::new();
        if let Some(r) = self.fts_rank {
            m.insert("fts_rank".to_owned(), Json::from(r));
        }
        if let Some(r) = self.vector_rank {
            m.insert("vector_rank".to_owned(), Json::from(r));
        }
        if let Some(c) = self.cosine {
            m.insert("cosine".to_owned(), Json::from(c));
        }
        m.insert("rrf".to_owned(), Json::from(self.rrf));
        m.insert("boosts".to_owned(), self.boosts.to_json());
        Json::Object(m)
    }
}

/// §4 step 5's order: score descending, then `block_id` bytewise ascending.
pub fn sort_by_score<T>(hits: &mut [T], score: impl Fn(&T) -> f64, id: impl Fn(&T) -> &str) {
    hits.sort_by(|a, b| {
        score(b)
            .partial_cmp(&score(a))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| id(a).as_bytes().cmp(id(b).as_bytes()))
    });
}

/// §4 `resolve`: `path + "#" + type + "[" + ordinal + "]"`.
#[must_use]
pub fn locator(path: &str, block_type: &str, ordinal: i64) -> String {
    format!("{path}#{block_type}[{ordinal}]")
}

/// §4 `resolve`: the first `words` whitespace-separated words of `text`,
/// `…` appended when cut.
#[must_use]
pub fn preview(text: &str, words: usize) -> String {
    let w: Vec<&str> = split_ws(text).collect();
    if w.len() <= words {
        w.join(" ")
    } else {
        format!("{}\u{2026}", w[..words].join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn rrf_arithmetic() {
        assert_eq!(rrf_score(None, None), 0.0);
        assert_eq!(rrf_score(Some(1), None), 1.0 / 61.0);
        assert_eq!(rrf_score(Some(1), Some(1)), 2.0 / 61.0);
        assert_eq!(rrf_score(Some(3), Some(200)), 1.0 / 63.0 + 1.0 / 260.0);
    }

    #[test]
    fn fusion_ranks_first_occurrence() {
        let fts = s(&["b_1", "b_2", "b_1", "b_3"]);
        let vec = vec![("b_3".to_owned(), 0.9), ("b_4".to_owned(), 0.5)];
        let c = fuse(&fts, &vec);
        assert_eq!(c.len(), 4);
        assert_eq!(
            (c[0].block_id.as_str(), c[0].fts_rank, c[0].vector_rank),
            ("b_1", Some(1), None)
        );
        assert_eq!((c[1].block_id.as_str(), c[1].fts_rank), ("b_2", Some(2)));
        assert_eq!(
            (
                c[2].block_id.as_str(),
                c[2].fts_rank,
                c[2].vector_rank,
                c[2].cosine
            ),
            ("b_3", Some(4), Some(1), Some(0.9))
        );
        assert_eq!(c[2].rrf, 1.0 / 64.0 + 1.0 / 61.0);
        assert_eq!(
            (c[3].block_id.as_str(), c[3].fts_rank, c[3].vector_rank),
            ("b_4", None, Some(2))
        );
        assert_eq!(c[3].rrf, 1.0 / 62.0);
        // A repeated vector id keeps its first rank and cosine.
        let c = fuse(&[], &[("b_9".to_owned(), 0.9), ("b_9".to_owned(), 0.1)]);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].vector_rank, c[0].cosine), (Some(1), Some(0.9)));
    }

    #[test]
    fn boosts_each_and_product() {
        let facts = BoostFacts {
            title: "Guides Index".to_owned(),
            layer: "canon".to_owned(),
            path: "guides/onboarding.md".to_owned(),
            headings: s(&["Setup", "First Steps"]),
        };
        let b = compute_boosts(&facts, &lower_terms(&s(&["STEPS"])));
        assert_eq!(
            b,
            Boosts {
                title: None,
                heading: Some(1.15),
                path: None,
                layer: Some(1.3),
                recency: None
            }
        );
        let b = compute_boosts(&facts, &lower_terms(&s(&["guides"])));
        assert_eq!((b.title, b.heading, b.path), (Some(1.25), None, Some(1.1)));
        assert_eq!(apply_boosts(0.5, &b), 0.5 * 1.25 * 1.0 * 1.1 * 1.3 * 1.0);
        assert_eq!(apply_boosts(0.5, &Boosts::default()), 0.5);
        assert_eq!(
            b.to_json(),
            json!({"title": 1.25, "path": 1.1, "layer": 1.3})
        );
        // proposed / unknown layers leave `layer` absent; an empty title never matches.
        let facts = BoostFacts {
            layer: "proposed".to_owned(),
            ..BoostFacts::default()
        };
        assert_eq!(
            compute_boosts(&facts, &lower_terms(&s(&[""]))),
            Boosts::default()
        );
        assert_eq!(layer_boost("draft"), Some(0.85));
        assert_eq!(layer_boost("working"), Some(1.15));
        assert_eq!(layer_boost("weird"), None);
    }

    #[test]
    fn terms_and_strings() {
        assert_eq!(
            default_terms(Some("  Foo  bar\tBAZ ")),
            s(&["Foo", "bar", "BAZ"])
        );
        assert_eq!(default_terms(None), Vec::<String>::new());
        assert_eq!(lower_terms(&s(&["Foo", "", "É"])), s(&["foo", "é"]));
        assert_eq!(property_to_string(None), "");
        assert_eq!(property_to_string(Some(&json!(null))), "");
        assert_eq!(property_to_string(Some(&json!("T"))), "T");
        assert_eq!(property_to_string(Some(&json!(3))), "3");
        assert_eq!(property_to_string(Some(&json!(1.5))), "1.5");
        assert_eq!(property_to_string(Some(&json!(true))), "true");
        assert_eq!(
            property_to_string(Some(&json!(["a", null, 2, ["x", "y"]]))),
            "a,,2,x,y"
        );
        assert_eq!(
            property_to_string(Some(&json!({"a": 1}))),
            "[object Object]"
        );
    }

    #[test]
    fn evidence_json_and_sort() {
        let e = Evidence {
            fts_rank: Some(2),
            vector_rank: None,
            cosine: None,
            rrf: 1.0 / 62.0,
            boosts: Boosts::default(),
        };
        assert_eq!(
            e.to_json(),
            json!({"fts_rank": 2, "rrf": 1.0 / 62.0, "boosts": {}})
        );
        let mut hits = vec![("b_2", 0.5), ("b_1", 0.5), ("b_0", 0.7)];
        sort_by_score(&mut hits, |h| h.1, |h| h.0);
        assert_eq!(hits, vec![("b_0", 0.7), ("b_1", 0.5), ("b_2", 0.5)]);
    }

    #[test]
    fn resolve_shaping() {
        assert_eq!(locator("a.md", "paragraph", 3), "a.md#paragraph[3]");
        let twelve = "1 2 3 4 5 6 7 8 9 10 11 12";
        assert_eq!(preview(twelve, PREVIEW_WORDS), twelve);
        assert_eq!(
            preview(&format!("{twelve} 13"), PREVIEW_WORDS),
            format!("{twelve}…")
        );
        assert_eq!(preview("  a \n b ", PREVIEW_WORDS), "a b");
        assert_eq!(preview("", PREVIEW_WORDS), "");
    }
}
