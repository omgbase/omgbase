//! The fixture shape of `spec/format` (§5) as `serde_json` values, behind the
//! `json` feature: every block carries exactly `type`, `span`, `text`,
//! `attrs`, `trivia`, `raw_hash`, `children`; a tree is
//! `{ "leading_trivia", "blocks" }`.

use serde_json::{Map, Value, json};

use crate::block::{AttrValue, Attrs, Block, BlockTree};
use crate::hash;

impl From<&AttrValue> for Value {
    fn from(v: &AttrValue) -> Self {
        match v {
            AttrValue::Bool(b) => Value::Bool(*b),
            AttrValue::Int(n) => Value::from(*n),
            AttrValue::Str(s) => Value::String(s.clone()),
        }
    }
}

impl From<AttrValue> for Value {
    fn from(v: AttrValue) -> Self {
        Value::from(&v)
    }
}

/// `attrs` as a JSON object (keys already sorted: `Attrs` is a `BTreeMap`).
#[must_use]
pub fn attrs_to_json(attrs: &Attrs) -> Value {
    Value::Object(
        attrs
            .iter()
            .map(|(k, v)| (k.clone(), Value::from(v)))
            .collect::<Map<_, _>>(),
    )
}

impl Block {
    /// The block in fixture shape (`raw` is not carried; §5).
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "type": self.kind.as_str(),
            "span": [self.span.start, self.span.end],
            "text": self.text,
            "attrs": attrs_to_json(&self.attrs),
            "trivia": self.trivia,
            "raw_hash": hash::hex(&self.raw_hash()),
            "children": self.children.iter().map(Block::to_json).collect::<Vec<_>>(),
        })
    }
}

impl BlockTree {
    /// The tree as a fixture `expect` object: `leading_trivia` and `blocks`.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({
            "leading_trivia": self.leading_trivia,
            "blocks": self.children.iter().map(Block::to_json).collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::parse;

    #[test]
    fn fixture_shape() {
        let tree = parse("# T\n\n- [ ] a\n");
        let v = tree.to_json();
        assert_eq!(v["leading_trivia"], "");
        let blocks = v["blocks"].as_array().expect("blocks array");
        assert_eq!(blocks.len(), 2);
        let heading = blocks[0].as_object().expect("object");
        let mut keys: Vec<&str> = heading.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "attrs", "children", "raw_hash", "span", "text", "trivia", "type"
            ]
        );
        assert_eq!(heading["type"], "heading");
        assert_eq!(heading["span"], json!([0, 3]));
        assert_eq!(heading["attrs"], json!({ "level": 1 }));
        assert_eq!(heading["trivia"], "\n\n");
        assert_eq!(heading["raw_hash"].as_str().map(str::len), Some(64));
        let task = &blocks[1]["children"][0];
        assert_eq!(task["type"], "task");
        assert_eq!(task["attrs"], json!({ "checked": false }));
        assert_eq!(task["trivia"], "");
        assert_eq!(Value::from(AttrValue::Str("x".to_owned())), json!("x"));
    }
}
