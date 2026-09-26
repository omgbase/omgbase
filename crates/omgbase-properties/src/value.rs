//! The JSON-shaped value the YAML parser (§4) and the computed intrinsics
//! (§3.3) produce: what `typed_value` (§2.1) and the flatteners (§2.3, §2.4)
//! consume. Unlike `serde_json::Value` it holds non-finite numbers
//! (`.inf`, `.nan` — §8) and keeps a mapping's entries in parser order.

use serde_json::{Map as JsonMap, Number as JsonNumber, Value as Json};

/// A YAML/JSON value after resolution.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    /// An IEEE double, as in both hosts; may be non-finite.
    Number(f64),
    String(String),
    Array(Vec<Value>),
    Mapping(Mapping),
}

impl Value {
    /// Neither a mapping nor an array (§2.3 "scalar").
    #[must_use]
    pub const fn is_scalar(&self) -> bool {
        !matches!(self, Value::Array(_) | Value::Mapping(_))
    }

    /// The value as JSON, the way `JSON.stringify` sees it: non-finite
    /// numbers become `null`, mapping keys keep their order.
    #[must_use]
    pub fn to_json(&self) -> Json {
        match self {
            Value::Null => Json::Null,
            Value::Bool(b) => Json::Bool(*b),
            Value::Number(n) => number_json(*n),
            Value::String(s) => Json::String(s.clone()),
            Value::Array(items) => Json::Array(items.iter().map(Value::to_json).collect()),
            Value::Mapping(m) => Json::Object(
                m.entries
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_json()))
                    .collect::<JsonMap<String, Json>>(),
            ),
        }
    }
}

/// A mapping with string keys in parser order (§2.3; §4 "Keys").
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mapping {
    pub entries: Vec<(String, Value)>,
}

impl Mapping {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    /// Append `key`; `false` (and no change) when the key is already present.
    pub fn insert(&mut self, key: String, value: Value) -> bool {
        if self.entries.iter().any(|(k, _)| *k == key) {
            return false;
        }
        self.entries.push((key, value));
        true
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }
}

impl From<Vec<(String, Value)>> for Mapping {
    fn from(entries: Vec<(String, Value)>) -> Self {
        Self { entries }
    }
}

/// A JSON number for `n`: an integer when `n` is integral and safely so
/// (|n| < 2^53; `-0` becomes `0`, as `JSON.stringify(-0)` does), otherwise
/// the double; non-finite → `null` (`JSON.stringify(Infinity)`).
#[must_use]
pub fn number_json(n: f64) -> Json {
    if !n.is_finite() {
        return Json::Null;
    }
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        // Exact by the range check; `as` cannot saturate here.
        return Json::from(n as i64);
    }
    JsonNumber::from_f64(n).map_or(Json::Null, Json::Number)
}

/// JavaScript `Number.prototype.toString()` (ECMA-262 Number::toString,
/// radix 10): the shortest round-tripping digits, positional notation for
/// exponents in `[-6, 21)`, `d.ddde±x` beyond. Mapping keys that resolve to
/// numbers are stringified this way (§4 "Keys": `1.50: x` → `"1.5"`).
#[must_use]
pub fn js_number_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    // `{:e}` prints the shortest digit string that round-trips, as `d.ddde±x`.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci
        .split_once('e')
        .expect("LowerExp always has an exponent");
    let exp: i32 = exp.parse().expect("LowerExp exponent is an integer");
    let all_digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let digits = all_digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    let k = i32::try_from(digits.len()).expect("a double has at most 17 digits");
    let n = exp + 1;

    let mut out = String::new();
    if x < 0.0 {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        let split = n as usize;
        out.push_str(&digits[..split]);
        out.push('.');
        out.push_str(&digits[split..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(digits);
    } else {
        let e = n - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if e >= 0 { '+' } else { '-' });
        out.push_str(&e.abs().to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_number_strings_match_v8() {
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (1.5, "1.5"),
            (-1.5, "-1.5"),
            (1000.0, "1000"),
            (16.0, "16"),
            (0.005, "0.005"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (1.0 / 3.0, "0.3333333333333333"),
            (9_007_199_254_740_992.0, "9007199254740992"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (f64::NAN, "NaN"),
            (2.5e25, "2.5e+25"),
            (-1e-10, "-1e-10"),
        ];
        for (x, want) in cases {
            assert_eq!(js_number_string(*x), *want, "{x:e}");
        }
    }

    #[test]
    fn number_json_is_an_integer_when_integral() {
        assert_eq!(number_json(1.0), Json::from(1));
        assert_eq!(number_json(-0.0), Json::from(0));
        assert_eq!(number_json(1.5).as_f64(), Some(1.5));
        assert_eq!(number_json(1e21).as_f64(), Some(1e21));
        assert_eq!(number_json(f64::NAN), Json::Null);
        assert_eq!(number_json(f64::INFINITY), Json::Null);
    }

    #[test]
    fn mapping_rejects_duplicates_and_keeps_order() {
        let mut m = Mapping::new();
        assert!(m.insert("b".into(), Value::Null));
        assert!(m.insert("a".into(), Value::Bool(true)));
        assert!(!m.insert("b".into(), Value::Number(1.0)));
        assert_eq!(m.len(), 2);
        assert_eq!(m.get("b"), Some(&Value::Null));
        assert_eq!(
            m.to_json_keys(),
            vec!["b", "a"],
            "insertion order, not sorted"
        );
    }

    impl Mapping {
        fn to_json_keys(&self) -> Vec<String> {
            match Value::Mapping(self.clone()).to_json() {
                Json::Object(o) => o.keys().cloned().collect(),
                _ => unreachable!(),
            }
        }
    }
}
