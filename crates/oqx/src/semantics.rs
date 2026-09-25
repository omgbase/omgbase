//! Normative scalar semantics — the single source of truth for how OQX values
//! compare, combine, and coerce. This is a function-for-function port of the
//! reference `packages/oqx/src/semantics.ts` (names kept in snake_case so the
//! two can be read side by side). Both the in-memory engine and any pushdown
//! adapter must produce results consistent with these rules; a backend that
//! cannot reproduce one natively must leave that fragment as an in-memory
//! residual rather than approximate it.
//!
//! The rules (deliberately CEL-flavored):
//!
//! * **Absence**: [`Value::Undefined`] and [`Value::Null`] are the same absent
//!   value.
//! * **Equality** (`==` / `!=`): typed and strict — no cross-type coercion, so
//!   `5 == "5"` and `0 == false` are false. Two absent values are equal.
//!   Arrays and objects compare structurally (see [`equals`] for why this is
//!   the one place the port cannot be JS-faithful).
//! * **Ordering** (`<` `<=` `>` `>=`): a comparison with an absent operand is
//!   false (never throws, never orders). Numbers order numerically, strings by
//!   Unicode code point; anything else, and any mixed pair, does not order.
//! * **Truthiness**: JavaScript truthiness ([`Value::truthy`]).
//! * **`in`**: membership in an array (by `==`), substring in a string, own key
//!   in an object, or coverage by a range. An absent needle is never a
//!   substring or a key.
//! * **Arithmetic**: doubles; an absent operand makes the result absent (`+`
//!   included, even when the other side is a string); `+` with a string side
//!   concatenates the operands' [`string_form`]s.
//! * **Identity / structural keys**: [`canonical_key`] — a type-tagged
//!   serialization, so `1` and `"1"` differ and object key order is ignored.
//!
//! Where JavaScript and the spec's portability rules (`spec/oqx/README.md`)
//! disagree — string length and order by code point, no implicit coercion in
//! `<`, insertion-ordered objects — this module follows the spec.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::sync::LazyLock;

use regex::Regex;

use crate::errors::{OqxError, Result};
use crate::value::{Object, Range, Value};

// ---- equality and ordering --------------------------------------------------

/// Equality with absence-normalization (`Undefined` ≡ `Null`) and strict typing.
///
/// Scalars compare by type and value (NaN is not equal to itself, `-0 == 0`).
/// Arrays, objects, and ranges compare **structurally**: the reference uses
/// JavaScript `===`, which is reference identity for those, but a Rust value has
/// no identity to compare, and structural equality is what the spec already
/// names as the fallback identity for `distinct`/`follow`. Object key order is
/// ignored, matching the spec's result canonicalization.
pub fn equals(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Undefined | Value::Null, Value::Undefined | Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => x == y,
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| equals(p, q))
        }
        (Value::Object(x), Value::Object(y)) => objects_equal(x, y),
        (Value::Range(x), Value::Range(y)) => {
            x.exclusive_end == y.exclusive_end
                && bounds_equal(x.lo.as_ref(), y.lo.as_ref())
                && bounds_equal(x.hi.as_ref(), y.hi.as_ref())
        }
        _ => false,
    }
}

fn objects_equal(x: &Object, y: &Object) -> bool {
    x.len() == y.len()
        && x.iter()
            .all(|(k, v)| y.get(k).is_some_and(|w| equals(v, w)))
}

fn bounds_equal(x: Option<&Value>, y: Option<&Value>) -> bool {
    match (x, y) {
        (None, None) => true,
        (Some(p), Some(q)) => equals(p, q),
        _ => false,
    }
}

/// Whether `op` is one of the six relational operators [`relate`] accepts.
pub fn is_rel_op(op: &str) -> bool {
    matches!(op, "==" | "!=" | "<" | "<=" | ">" | ">=")
}

/// The six relational operators. `==`/`!=` go through [`equals`] (so
/// `absent != x` is true and `absent != absent` is false); the four ordering
/// operators yield false when either operand is absent or when the pair does
/// not order. Errors only for a string that is not a relational operator,
/// which the parser never produces.
pub fn relate(op: &str, a: &Value, b: &Value) -> Result<bool> {
    match op {
        "==" => Ok(equals(a, b)),
        "!=" => Ok(!equals(a, b)),
        "<" => Ok(compare(a, b).is_some_and(|o| o == Ordering::Less)),
        "<=" => Ok(compare(a, b).is_some_and(|o| o != Ordering::Greater)),
        ">" => Ok(compare(a, b).is_some_and(|o| o == Ordering::Greater)),
        ">=" => Ok(compare(a, b).is_some_and(|o| o != Ordering::Less)),
        _ => Err(OqxError::eval(format!("not a relational operator: {op}"))),
    }
}

/// The natural order of two present values of the same orderable type:
/// numbers numerically (`None` when either is NaN), strings by code point.
/// Everything else — absent operands, booleans, collections, mixed types —
/// is `None`: it does not order. (The reference's `compare`.)
pub fn compare(a: &Value, b: &Value) -> Option<Ordering> {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.partial_cmp(y),
        (Value::Str(x), Value::Str(y)) => Some(x.cmp(y)),
        _ => None,
    }
}

/// Total order for `order by`, with absent values sorting last.
///
/// Present values of the same type order naturally (numbers numerically with
/// NaN treated as equal to everything, strings by code point, `false < true`,
/// arrays by their `String(v)` form as JavaScript does, objects and ranges all
/// equal). Values of different types order by a fixed type rank (number, string,
/// boolean, array, object, range) so the sort is deterministic without the
/// implicit coercion JavaScript's `<` would apply.
///
/// This is ascending only. For `desc` use [`compare_for_sort_dir`]: negating
/// this result would hoist absent rows to the top, which the engine forbids.
pub fn compare_for_sort(a: &Value, b: &Value) -> Ordering {
    match (a.is_absent(), b.is_absent()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => compare_present(a, b),
    }
}

/// [`compare_for_sort`] with a direction: `desc` reverses the order of
/// **present** values only; absent values still sort last.
pub fn compare_for_sort_dir(a: &Value, b: &Value, desc: bool) -> Ordering {
    match (a.is_absent(), b.is_absent()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            let c = compare_present(a, b);
            if desc { c.reverse() } else { c }
        }
    }
}

fn compare_present(a: &Value, b: &Value) -> Ordering {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (Value::Str(x), Value::Str(y)) => x.cmp(y),
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        (Value::Array(_), Value::Array(_)) => a.to_string().cmp(&b.to_string()),
        (Value::Object(_), Value::Object(_)) | (Value::Range(_), Value::Range(_)) => {
            Ordering::Equal
        }
        _ => type_rank(a).cmp(&type_rank(b)),
    }
}

fn type_rank(v: &Value) -> u8 {
    match v {
        Value::Number(_) => 0,
        Value::Str(_) => 1,
        Value::Bool(_) => 2,
        Value::Array(_) => 3,
        Value::Object(_) => 4,
        Value::Range(_) => 5,
        Value::Undefined | Value::Null => 6,
    }
}

// ---- structural identity ----------------------------------------------------

/// A canonical, type-tagged serialization of a value, used wherever OQX needs a
/// value's IDENTITY as a key (`follow` path ordering, `distinct`, index keys):
/// two values get the same key iff they are structurally equal — absent ≡
/// null, numbers as doubles (`-0` ≡ `0`), object key order ignored. The type
/// tags keep `1`, `"1"`, and `true` apart, and `{}`/`[]` apart from every
/// scalar. Byte-for-byte the reference's `canonicalKey` for JSON-shaped values
/// (a range, which the reference has no key for, is tagged `r`).
pub fn canonical_key(v: &Value) -> String {
    let mut out = String::new();
    write_canonical_key(v, &mut out);
    out
}

fn write_canonical_key(v: &Value, out: &mut String) {
    match v {
        Value::Undefined | Value::Null => out.push('n'),
        Value::Bool(true) => out.push('t'),
        Value::Bool(false) => out.push('f'),
        Value::Number(n) => {
            out.push('d');
            out.push_str(&crate::value::js_number_to_string(if *n == 0.0 {
                0.0
            } else {
                *n
            }));
        }
        Value::Str(s) => {
            out.push('s');
            write_json_string(s, out);
        }
        Value::Array(xs) => {
            out.push('[');
            for (i, x) in xs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical_key(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&str> = o.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(k, out);
                out.push(':');
                write_canonical_key(o.get(k).unwrap_or(&Value::Undefined), out);
            }
            out.push('}');
        }
        Value::Range(r) => {
            out.push('r');
            out.push(if r.exclusive_end { 'x' } else { 'i' });
            for bound in [&r.lo, &r.hi] {
                match bound {
                    None => out.push('-'),
                    Some(b) => write_canonical_key(b, out),
                }
            }
        }
    }
}

/// `JSON.stringify(s)`: the quoted, escaped form of a string.
fn write_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---- truthiness and numeric coercion ----------------------------------------

/// JavaScript truthiness; see [`Value::truthy`].
pub fn truthy(v: &Value) -> bool {
    v.truthy()
}

/// JavaScript `Number(v)`: numbers pass through; `null` → 0, `undefined` →
/// NaN, booleans → 0/1, strings parse as a JavaScript numeric literal (trimmed,
/// `""` → 0, `0x`/`0o`/`0b` prefixes, `Infinity`, otherwise NaN), arrays go via
/// their `String(v)` form (`[]` → 0, `[5]` → 5, `[1,2]` → NaN), objects and
/// ranges are NaN.
pub fn to_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => *n,
        Value::Null => 0.0,
        Value::Undefined => f64::NAN,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Str(s) => js_string_to_number(s),
        Value::Array(_) => js_string_to_number(&v.to_string()),
        Value::Object(_) | Value::Range(_) => f64::NAN,
    }
}

static JS_DECIMAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[+-]?(?:[0-9]+\.?[0-9]*(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)$")
        .expect("static regex")
});

/// The string half of JavaScript `Number()` (`StringToNumber`).
fn js_string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if let Some(rest) = t.get(2..) {
        let radix = match &t[..2] {
            "0x" | "0X" => Some(16),
            "0o" | "0O" => Some(8),
            "0b" | "0B" => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            if rest.is_empty() {
                return f64::NAN;
            }
            let mut acc = 0.0_f64;
            for c in rest.chars() {
                match c.to_digit(radix) {
                    Some(d) => acc = acc * f64::from(radix) + f64::from(d),
                    None => return f64::NAN,
                }
            }
            return acc;
        }
    }
    if JS_DECIMAL.is_match(t) {
        t.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

// ---- arithmetic -------------------------------------------------------------

/// The string form of a scalar — the text `+` concatenates, `.lower()` maps,
/// and a substring/key test uses: a string is itself; a number renders as a
/// double with no fraction when integer-valued (`-0` is `"0"`); booleans are
/// the words. Absent has **no** string form (`None`), so the operation using
/// it yields absent (or false). Other values use their `String(v)` form.
pub fn string_form(v: &Value) -> Option<Cow<'_, str>> {
    match v {
        Value::Undefined | Value::Null => None,
        Value::Str(s) => Some(Cow::Borrowed(s)),
        other => Some(Cow::Owned(other.to_string())),
    }
}

/// Arithmetic over doubles. An absent operand on either side makes the result
/// absent (`Undefined`), even for `+` with a string on the other side. `+`
/// concatenates the two [`string_form`]s when either side is a string; every
/// other case coerces both sides with [`to_number`], so `"x" * 2` is NaN.
/// Errors only for a string that is not an arithmetic operator.
pub fn arith(op: &str, a: &Value, b: &Value) -> Result<Value> {
    if a.is_absent() || b.is_absent() {
        return Ok(Value::Undefined);
    }
    if op == "+" && (matches!(a, Value::Str(_)) || matches!(b, Value::Str(_))) {
        return Ok(Value::Str(format!("{a}{b}")));
    }
    let x = to_number(a);
    let y = to_number(b);
    let n = match op {
        "+" => x + y,
        "-" => x - y,
        "*" => x * y,
        "/" => x / y,
        "%" => x % y,
        _ => return Err(OqxError::eval(format!("not an arithmetic operator: {op}"))),
    };
    Ok(Value::Number(n))
}

// ---- membership and ranges --------------------------------------------------

/// `needle in haystack`: an absent haystack is false; a range routes to
/// [`range_covers`]; an array holds `needle` if some element [`equals`] it; a
/// string contains the needle's [`string_form`] as a substring; an object has
/// it as an own key. An absent needle is never a substring or a key (not even
/// one spelled `"null"` or `"undefined"`). Numbers and booleans hold nothing.
pub fn membership(needle: &Value, haystack: &Value) -> bool {
    match haystack {
        Value::Undefined | Value::Null => false,
        Value::Range(r) => range_covers(r, needle),
        Value::Array(xs) => xs.iter().any(|x| equals(x, needle)),
        Value::Str(s) => string_form(needle).is_some_and(|n| s.contains(n.as_ref())),
        Value::Object(o) => string_form(needle).is_some_and(|n| o.contains_key(&n)),
        Value::Bool(_) | Value::Number(_) => false,
    }
}

/// Construct a range value. An absent bound is an open end (`..hi` / `lo..`).
pub fn make_range(lo: Value, hi: Value, exclusive_end: bool) -> Range {
    let bound = |v: Value| if v.is_absent() { None } else { Some(v) };
    Range {
        lo: bound(lo),
        hi: bound(hi),
        exclusive_end,
    }
}

/// Whether a value is a range. A plain object shaped like one is not.
pub fn is_range(v: &Value) -> bool {
    matches!(v, Value::Range(_))
}

/// Whether `x` falls within `range`: `lo <= x` (when lo is present) and either
/// `x <= hi` (inclusive) or `x < hi` (exclusive end) (when hi is present). Bound
/// checks go through the ordering rules, so an absent `x` — or one that does
/// not order against a bound (mixed types) — is simply not covered (never
/// fails). This is also what makes date/time ranges work over ISO-8601 strings,
/// whose natural code-point order is chronological.
///
/// Only a number or a string can be covered: an absent `x` is covered by no
/// range, not even a fully open one (`..`), and a boolean, array, or object
/// never is.
pub fn range_covers(range: &Range, x: &Value) -> bool {
    if !matches!(x, Value::Number(_) | Value::Str(_)) {
        return false;
    }
    let ge_lo = range
        .lo
        .as_ref()
        .is_none_or(|lo| compare(x, lo).is_some_and(|o| o != Ordering::Less));
    let le_hi = range.hi.as_ref().is_none_or(|hi| {
        compare(x, hi).is_some_and(|o| {
            if range.exclusive_end {
                o == Ordering::Less
            } else {
                o != Ordering::Greater
            }
        })
    });
    ge_lo && le_hi
}

static RANGE_SPLIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(.*?)(\.\.\.?)(.*)$").expect("static regex"));
static RANGE_NUM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$").expect("static regex")
});
static RANGE_ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2})?(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?$",
    )
    .expect("static regex")
});

/// Parse a string as a range value (`1..5`, `1...5`, `..5`, `5..`, or an
/// ISO-8601 date range), or `None` if it is not a well-formed range. The
/// operator is a maximal run of 2 (`..`) or 3 (`...`) dots; a single dot is a
/// decimal point. Bounds must share a scalar domain — both numeric, or both
/// ISO-8601 — so an ordinary string is never mis-read. This is the runtime
/// counterpart of the `lo..hi` literal, for ranges that arrive as string data.
pub fn parse_range_string(s: &str) -> Option<Range> {
    let m = RANGE_SPLIT.captures(s)?;
    let lo_raw = m.get(1).map_or("", |g| g.as_str());
    let dots = m.get(2).map_or("", |g| g.as_str());
    let hi_raw = m.get(3).map_or("", |g| g.as_str());
    if lo_raw.ends_with('.') || hi_raw.starts_with('.') {
        return None; // non-maximal dot run
    }
    let lo = (!lo_raw.is_empty()).then_some(lo_raw);
    let hi = (!hi_raw.is_empty()).then_some(hi_raw);
    if lo.is_none() && hi.is_none() {
        return None;
    }
    let exclusive_end = dots.len() == 3;
    let present = [lo, hi].into_iter().flatten();
    if present.clone().all(|b| RANGE_NUM.is_match(b)) {
        let num = |b: Option<&str>| b.map(|b| Value::Number(b.parse().unwrap_or(f64::NAN)));
        return Some(Range {
            lo: num(lo),
            hi: num(hi),
            exclusive_end,
        });
    }
    if present.clone().all(|b| RANGE_ISO.is_match(b)) {
        let text = |b: Option<&str>| b.map(|b| Value::Str(b.to_owned()));
        return Some(Range {
            lo: text(lo),
            hi: text(hi),
            exclusive_end,
        });
    }
    None
}

// ---- collections ------------------------------------------------------------

/// The elements of a value as a list: absent → empty, an array → its elements,
/// anything else → a one-element list holding it (a string is a single value,
/// not its characters; an object is one row).
pub fn to_list(v: &Value) -> Cow<'_, [Value]> {
    match v {
        Value::Undefined | Value::Null => Cow::Owned(Vec::new()),
        Value::Array(xs) => Cow::Borrowed(xs),
        other => Cow::Owned(vec![other.clone()]),
    }
}

/// Normalize a host value into a queryable collection: arrays pass through,
/// absence is empty, any other single value becomes a one-element collection
/// (a to-one relation). Identical to [`to_list`]; the reference keeps both
/// names (they differ only for host iterables, which `Value` does not model).
pub fn coerce_collection(v: &Value) -> Cow<'_, [Value]> {
    to_list(v)
}

/// The size of a value: the code-point length of a string, the element count
/// of an array, the own-key count of an object; absent, booleans, numbers, and
/// ranges are 0.
pub fn size_of(v: &Value) -> f64 {
    let n = match v {
        Value::Str(s) => s.chars().count(),
        Value::Array(xs) => xs.len(),
        Value::Object(o) => o.len(),
        Value::Undefined | Value::Null | Value::Bool(_) | Value::Number(_) | Value::Range(_) => 0,
    };
    n as f64
}

// ---- entries: the explicit record → collection bridge -----------------------
//
// A plain object is NOT iterable in OQX (`from ${obj}` is one row). `entries(x)`
// converts it explicitly into a collection of ENTRY values. In the reference an
// entry is a plain `{ key, value }` object carrying a hidden (non-enumerable
// symbol) tag, so JSON and deep-equality see a two-property record while the
// engine can still recognize one: when an entry becomes a query scope, the
// scope's ROW is the property's value (`$value`, bare names) and `$key` is scope
// metadata. Arrays yield numeric index keys; absent values, scalars, and ranges
// yield nothing. (Arrays never expose an implicit `$key` — `entries(arr)` is how
// you ask for the index.)
//
// `Value` has no hidden-tag facility, so the Rust port keeps the two halves
// apart: `entries_of` returns typed `Entry`s for the engine to unwrap into
// scopes, and `Entry: Into<Value>` produces the `{ key, value }` record that is
// the entry's shape as a plain value (the `entries` builtin returns an array of
// those).

/// One `entries()` entry: a property key and its value. Converts into the
/// reference's plain-value shape, the object `{ "key": key, "value": value }`
/// with the keys in that order.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub key: Value,
    pub value: Value,
}

impl Entry {
    pub fn new(key: Value, value: Value) -> Self {
        Self { key, value }
    }

    /// Read an entry back from its plain-value shape: an object whose keys are
    /// exactly `key` then `value`. This is a **shape** test, not the reference's
    /// hidden tag, so an ordinary data record with that exact shape also matches.
    /// Engines that need the distinction should keep the typed `Entry` from
    /// [`entries_of`] instead of round-tripping through `Value`.
    pub fn from_value_shape(v: &Value) -> Option<Entry> {
        let o = v.as_object()?;
        let mut keys = o.keys();
        if keys.next() != Some("key") || keys.next() != Some("value") || keys.next().is_some() {
            return None;
        }
        Some(Entry {
            key: o.get("key")?.clone(),
            value: o.get("value")?.clone(),
        })
    }
}

impl From<Entry> for Value {
    fn from(e: Entry) -> Self {
        let mut o = Object::with_capacity(2);
        o.insert("key", e.key);
        o.insert("value", e.value);
        Value::Object(o)
    }
}

/// The entries of a value: object → its (key, value) pairs in insertion order,
/// keys as strings; array → (index, element) with numeric indices; anything
/// else (absent, scalars, ranges) → none.
pub fn entries_of(v: &Value) -> Vec<Entry> {
    match v {
        Value::Object(o) => o
            .iter()
            .map(|(k, x)| Entry::new(Value::Str(k.to_owned()), x.clone()))
            .collect(),
        Value::Array(xs) => xs
            .iter()
            .enumerate()
            .map(|(i, x)| Entry::new(Value::Number(i as f64), x.clone()))
            .collect(),
        _ => Vec::new(),
    }
}

// ---- builtins ---------------------------------------------------------------

/// The names of the free functions [`builtin_function`] handles.
pub const BUILTIN_FUNCTION_NAMES: &[&str] = &["list", "entries", "size", "has", "range"];

/// The names of the methods [`builtin_method`] handles.
pub const BUILTIN_METHOD_NAMES: &[&str] = &[
    "contains",
    "startsWith",
    "endsWith",
    "matches",
    "size",
    "lower",
    "upper",
];

/// A missing positional argument reads as `undefined`, as in JavaScript.
fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Undefined)
}

/// Free functions callable as `name(args)`. `None` means there is no such
/// builtin (the context's `{ handled: false }`), so the caller can fall back
/// or report an unknown function.
///
/// * `list(x)` — [`to_list`] as an array.
/// * `entries(x)` — [`entries_of`] as an array of `{ key, value }` records.
/// * `size(x)` — [`size_of`].
/// * `has(x)` — true when `x` is present (not absent). `has(0)`, `has("")`,
///   and `has(false)` are all true.
/// * `range(s)` — coerce a string to a range value ([`parse_range_string`]) or
///   pass a range through; anything else, or a non-range string, is `Null` so
///   `x in range(bad)` is simply false.
pub fn builtin_function(name: &str, args: &[Value]) -> Option<Result<Value>> {
    let x = arg(args, 0);
    let v = match name {
        "list" => Value::Array(to_list(x).into_owned()),
        "entries" => Value::Array(entries_of(x).into_iter().map(Value::from).collect()),
        "size" => Value::Number(size_of(x)),
        "has" => Value::Bool(!x.is_absent()),
        "range" => match x {
            Value::Range(_) => x.clone(),
            Value::Str(s) => parse_range_string(s).map_or(Value::Null, Value::from),
            _ => Value::Null,
        },
        _ => return None,
    };
    Some(Ok(v))
}

// ---- regex: the portable OQX dialect ----------------------------------------
//
// `matches(pattern)` compiles the pattern as a regular expression in the dialect
// both implementations share: literals, `.`, classes `[…]`, `\d \w \s`, the
// quantifiers `* + ? {m,n}`, alternation, grouping, anchors, escaped
// metacharacters. Lookaround and backreferences are rejected up front with the
// spec's wording (the `regex` crate would reject them too, but with its own
// message), and a pattern that does not compile is an OQX eval error.

/// Compile a `matches()` pattern, raising an eval error for an invalid pattern
/// (`invalid regular expression`) or one using a construct outside the OQX
/// dialect (`not supported in OQX`).
pub fn compile_regex(pattern: &str) -> Result<Regex> {
    if let Some(what) = find_unsupported_regex_construct(pattern) {
        return Err(OqxError::eval(format!(
            "{what} is not supported in OQX regular expressions (pattern {})",
            json_quoted(pattern)
        )));
    }
    Regex::new(pattern).map_err(|e| {
        OqxError::eval(format!(
            "invalid regular expression {}: {e}",
            json_quoted(pattern)
        ))
    })
}

fn json_quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    write_json_string(s, &mut out);
    out
}

/// Scan a pattern — outside character classes, honoring escapes — for
/// lookaround `(?= (?! (?<= (?<!` and backreferences `\1`..`\9`, `\k<name>`.
/// `\(\?=` and `[(]` stay literal.
fn find_unsupported_regex_construct(p: &str) -> Option<&'static str> {
    let chars: Vec<char> = p.chars().collect();
    let mut in_class = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            let n = chars.get(i + 1).copied();
            if !in_class {
                if n.is_some_and(|n| ('1'..='9').contains(&n)) {
                    return Some("a backreference (\\1…\\9)");
                }
                if n == Some('k') && chars.get(i + 2) == Some(&'<') {
                    return Some("a named backreference (\\k<…>)");
                }
            }
            i += 2;
            continue;
        }
        if in_class {
            if c == ']' {
                in_class = false;
            }
        } else if c == '[' {
            in_class = true;
        } else if c == '(' && chars.get(i + 1) == Some(&'?') {
            match (chars.get(i + 2), chars.get(i + 3)) {
                (Some('='), _) => return Some("lookahead (?=…)"),
                (Some('!'), _) => return Some("negative lookahead (?!…)"),
                (Some('<'), Some('=')) => return Some("lookbehind (?<=…)"),
                (Some('<'), Some('!')) => return Some("negative lookbehind (?<!…)"),
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// Methods callable as `recv.name(args)`. `None` means there is no such
/// builtin. Every method is total except `matches`, whose pattern must compile.
///
/// * `contains(v)` — substring of a string receiver (the argument's
///   [`string_form`]; an absent argument is never a substring), or an element
///   [`equals`] to `v` in an array receiver; false otherwise.
/// * `startsWith(s)` / `endsWith(s)` — string receivers only; false otherwise
///   (and for an absent argument).
/// * `matches(pattern)` — false for an absent receiver; otherwise whether the
///   pattern ([`compile_regex`]) matches anywhere in the receiver's string
///   form. An invalid or non-portable pattern is an eval error.
/// * `size()` — [`size_of`].
/// * `lower()` / `upper()` — the receiver's [`string_form`] case-mapped; an
///   absent receiver yields absent.
pub fn builtin_method(name: &str, recv: &Value, args: &[Value]) -> Option<Result<Value>> {
    let a0 = arg(args, 0);
    let v = match name {
        "contains" => Value::Bool(match recv {
            Value::Str(s) => string_form(a0).is_some_and(|n| s.contains(n.as_ref())),
            Value::Array(xs) => xs.iter().any(|x| equals(x, a0)),
            _ => false,
        }),
        "startsWith" => Value::Bool(
            recv.as_str()
                .is_some_and(|s| string_form(a0).is_some_and(|n| s.starts_with(n.as_ref()))),
        ),
        "endsWith" => Value::Bool(
            recv.as_str()
                .is_some_and(|s| string_form(a0).is_some_and(|n| s.ends_with(n.as_ref()))),
        ),
        "matches" => match string_form(recv) {
            None => Value::Bool(false),
            Some(subject) => match compile_regex(&a0.to_string()) {
                Ok(re) => Value::Bool(re.is_match(&subject)),
                Err(e) => return Some(Err(e)),
            },
        },
        "size" => Value::Number(size_of(recv)),
        "lower" => string_form(recv).map_or(Value::Undefined, |s| Value::Str(s.to_lowercase())),
        "upper" => string_form(recv).map_or(Value::Undefined, |s| Value::Str(s.to_uppercase())),
        _ => return None,
    };
    Some(Ok(v))
}

// ---- tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn num(n: f64) -> Value {
        Value::Number(n)
    }
    fn s(x: &str) -> Value {
        Value::Str(x.to_owned())
    }
    fn arr(xs: Vec<Value>) -> Value {
        Value::Array(xs)
    }
    fn obj(pairs: &[(&str, Value)]) -> Value {
        Value::Object(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        )
    }
    fn rng(lo: Value, hi: Value, exclusive: bool) -> Value {
        Value::from(make_range(lo, hi, exclusive))
    }
    fn rel(op: &str, a: &Value, b: &Value) -> bool {
        relate(op, a, b).unwrap()
    }
    fn func(name: &str, args: &[Value]) -> Value {
        builtin_function(name, args)
            .expect("known builtin")
            .expect("ok")
    }
    fn method(name: &str, recv: &Value, args: &[Value]) -> Value {
        builtin_method(name, recv, args)
            .expect("known builtin")
            .expect("ok")
    }

    // -- conformance.test.ts, assertion for assertion --

    #[test]
    fn equality_is_typed_and_strict_absence_normalizes() {
        assert!(equals(&num(5.0), &num(5.0)));
        assert!(!equals(&num(5.0), &s("5"))); // no cross-type coercion
        assert!(equals(&Value::Null, &Value::Undefined)); // absent ≡ absent
        assert!(!equals(&num(0.0), &Value::Bool(false)));
    }

    #[test]
    fn ordering_comparisons_with_an_absent_operand_are_false() {
        assert!(!rel(">", &num(3.0), &Value::Null));
        assert!(!rel("<", &Value::Undefined, &num(3.0)));
        assert!(rel(">=", &num(3.0), &num(3.0)));
        assert!(rel("<", &s("a"), &s("b")));
    }

    #[test]
    fn membership_array_string_object() {
        assert!(membership(
            &num(2.0),
            &arr(vec![num(1.0), num(2.0), num(3.0)])
        ));
        assert!(membership(&s("ell"), &s("hello")));
        assert!(membership(&s("k"), &obj(&[("k", num(1.0))])));
        assert!(!membership(&num(9.0), &arr(vec![num(1.0), num(2.0)])));
    }

    #[test]
    fn range_make_is_range_and_inclusive_vs_exclusive_coverage() {
        let inclusive = make_range(num(1.0), num(5.0), false); // 1..5
        let exclusive = make_range(num(1.0), num(5.0), true); // 1...5
        assert!(is_range(&Value::from(inclusive.clone())));
        // a plain object is not a range
        assert!(!is_range(&obj(&[("lo", num(1.0)), ("hi", num(5.0))])));
        // inclusive `1..5` covers both endpoints
        assert!(range_covers(&inclusive, &num(1.0)));
        assert!(range_covers(&inclusive, &num(5.0)));
        assert!(!range_covers(&inclusive, &num(0.0)));
        assert!(!range_covers(&inclusive, &num(6.0)));
        // exclusive `1...5` excludes the high endpoint
        assert!(!range_covers(&exclusive, &num(5.0)));
        assert!(range_covers(&exclusive, &num(4.0)));
    }

    #[test]
    fn range_open_ended_bounds() {
        let to5 = make_range(Value::Null, num(5.0), false); // ..5 (inclusive)
        assert!(range_covers(&to5, &num(5.0)));
        assert!(!range_covers(&to5, &num(6.0)));
        let before5 = make_range(Value::Null, num(5.0), true); // ...5 (exclusive)
        assert!(!range_covers(&before5, &num(5.0)));
        let from1 = make_range(num(1.0), Value::Null, false); // 1..
        assert!(range_covers(&from1, &num(1000.0)));
        assert!(!range_covers(&from1, &num(0.0)));
    }

    #[test]
    fn range_an_absent_value_is_never_covered() {
        let r = make_range(num(1.0), num(5.0), false);
        assert!(!range_covers(&r, &Value::Null));
        assert!(!range_covers(&r, &Value::Undefined));
    }

    #[test]
    fn range_date_time_ranges_compare_over_iso_8601_strings() {
        let q1 = make_range(s("2026-01-01"), s("2026-03-31"), false); // a quarter, inclusive
        assert!(range_covers(&q1, &s("2026-02-14")));
        assert!(range_covers(&q1, &s("2026-03-31")));
        assert!(!range_covers(&q1, &s("2025-12-31")));
        assert!(!range_covers(&q1, &s("2026-04-01")));
    }

    #[test]
    fn membership_routes_a_range_rhs_to_coverage() {
        assert!(membership(&num(3.0), &rng(num(1.0), num(5.0), false)));
        assert!(!membership(&num(5.0), &rng(num(1.0), num(5.0), true))); // exclusive end
        assert!(membership(
            &s("2026-02-01"),
            &rng(s("2026-01-01"), s("2026-12-31"), false)
        ));
    }

    #[test]
    fn parse_range_string_parses_numeric_date_open_ended_ranges() {
        assert_eq!(
            parse_range_string("1..5"),
            Some(make_range(num(1.0), num(5.0), false))
        );
        assert_eq!(
            parse_range_string("1...5"),
            Some(make_range(num(1.0), num(5.0), true))
        );
        assert_eq!(
            parse_range_string("..5"),
            Some(make_range(Value::Null, num(5.0), false))
        );
        assert_eq!(
            parse_range_string("1.."),
            Some(make_range(num(1.0), Value::Null, false))
        );
        assert_eq!(
            parse_range_string("2026-01-01..2026-01-31"),
            Some(make_range(s("2026-01-01"), s("2026-01-31"), false))
        );
        // not ranges → None, so `x in range(s)` is simply false
        assert_eq!(parse_range_string("hello"), None);
        assert_eq!(parse_range_string("a..z"), None);
        assert_eq!(parse_range_string("1..2026-01-01"), None); // mixed domains
        assert_eq!(parse_range_string("../foo"), None);
    }

    #[test]
    fn the_range_builtin_coerces_a_string_and_passes_ranges_through() {
        let r = func("range", &[s("1..5")]);
        assert!(is_range(&r));
        match &r {
            Value::Range(r) => assert!(range_covers(r, &num(3.0))),
            _ => unreachable!(),
        }
        assert!(membership(&num(3.0), &func("range", &[s("1..5")])));
        assert!(!membership(&num(9.0), &func("range", &[s("1..5")])));
        assert_eq!(func("range", &[s("not a range")]), Value::Null);
        assert!(is_range(&func("range", &[rng(num(1.0), num(5.0), false)]))); // pass-through
    }

    #[test]
    fn arithmetic_plus_concatenates_when_either_side_is_a_string() {
        assert_eq!(arith("+", &num(1.0), &num(2.0)).unwrap(), num(3.0));
        assert_eq!(arith("+", &s("a"), &num(1.0)).unwrap(), s("a1"));
        assert_eq!(arith("*", &num(3.0), &num(4.0)).unwrap(), num(12.0));
    }

    #[test]
    fn sort_order_places_absent_values_last() {
        let mut xs = vec![num(3.0), Value::Null, num(1.0), Value::Undefined, num(2.0)];
        xs.sort_by(compare_for_sort);
        assert_eq!(
            xs,
            vec![num(1.0), num(2.0), num(3.0), Value::Null, Value::Undefined]
        );
    }

    #[test]
    fn coerce_collection_normalizes_sources() {
        assert_eq!(coerce_collection(&Value::Null).as_ref(), &[] as &[Value]);
        assert_eq!(
            coerce_collection(&arr(vec![num(1.0), num(2.0)])).as_ref(),
            &[num(1.0), num(2.0)]
        );
        // (the `Set` case is host-only; `Value` has no iterable that is not an array)
        assert_eq!(coerce_collection(&s("x")).as_ref(), &[s("x")]); // a single value, not chars
    }

    // -- beyond the TS suite: the spec's portability rules and the port's edges --

    #[test]
    fn not_equal_with_one_absent_side() {
        assert!(rel("!=", &Value::Null, &num(5.0)));
        assert!(rel("!=", &num(5.0), &Value::Undefined));
        assert!(!rel("!=", &Value::Null, &Value::Undefined));
        assert!(!rel("!=", &Value::Undefined, &Value::Undefined));
        assert!(rel("==", &Value::Undefined, &Value::Null));
    }

    #[test]
    fn every_ordering_op_is_false_with_an_absent_side() {
        for op in ["<", "<=", ">", ">="] {
            assert!(!rel(op, &Value::Null, &num(1.0)), "{op}");
            assert!(!rel(op, &num(1.0), &Value::Undefined), "{op}");
            assert!(!rel(op, &Value::Null, &Value::Null), "{op}");
        }
    }

    #[test]
    fn ordering_never_coerces_across_types() {
        // JavaScript would say `"3" < 5` (Number("3")) and `true < 2`; the spec
        // says mixed types do not order.
        assert!(!rel("<", &s("3"), &num(5.0)));
        assert!(!rel(">", &s("10"), &num(5.0)));
        assert!(!rel("<", &Value::Bool(true), &num(2.0)));
        assert!(!rel("<", &Value::Bool(false), &Value::Bool(true)));
        assert!(!rel("<=", &arr(vec![num(1.0)]), &arr(vec![num(2.0)])));
        // NaN orders against nothing, but `<=`/`>=` still hold for equal numbers
        assert!(!rel("<=", &num(f64::NAN), &num(f64::NAN)));
        assert!(rel("<=", &num(2.0), &num(2.0)));
        assert!(rel(">=", &num(-0.0), &num(0.0)));
    }

    #[test]
    fn unknown_operators_are_eval_errors() {
        let e = relate("<>", &num(1.0), &num(2.0)).unwrap_err();
        assert_eq!(e.stage, crate::Stage::Eval);
        assert!(e.message.contains("not a relational operator"));
        let e = arith("^", &num(1.0), &num(2.0)).unwrap_err();
        assert_eq!(e.stage, crate::Stage::Eval);
        assert!(e.message.contains("not an arithmetic operator"));
        assert!(is_rel_op("!=") && !is_rel_op("+"));
    }

    #[test]
    fn equality_is_structural_for_arrays_and_objects() {
        assert!(equals(
            &arr(vec![num(1.0), s("a")]),
            &arr(vec![num(1.0), s("a")])
        ));
        assert!(!equals(
            &arr(vec![num(1.0)]),
            &arr(vec![num(1.0), num(1.0)])
        ));
        assert!(!equals(&arr(vec![num(1.0)]), &arr(vec![s("1")])));
        // key order is ignored; undefined and null properties are equal
        assert!(equals(
            &obj(&[("a", num(1.0)), ("b", Value::Null)]),
            &obj(&[("b", Value::Undefined), ("a", num(1.0))])
        ));
        assert!(!equals(
            &obj(&[("a", num(1.0))]),
            &obj(&[("a", num(1.0)), ("c", num(2.0))])
        ));
        assert!(!equals(&obj(&[]), &arr(vec![])));
        assert!(equals(
            &rng(num(1.0), num(2.0), true),
            &rng(num(1.0), num(2.0), true)
        ));
        assert!(!equals(
            &rng(num(1.0), num(2.0), true),
            &rng(num(1.0), num(2.0), false)
        ));
        // NaN is not equal to itself; -0 equals 0
        assert!(!equals(&num(f64::NAN), &num(f64::NAN)));
        assert!(equals(&num(-0.0), &num(0.0)));
        assert!(!equals(&s("true"), &Value::Bool(true)));
    }

    #[test]
    fn strings_measure_and_order_by_code_point() {
        // "héllo😀": 6 code points, 7 UTF-16 code units, 10 bytes
        assert_eq!(size_of(&s("héllo😀")), 6.0);
        assert_eq!(method("size", &s("héllo😀"), &[]), num(6.0));
        assert_eq!(size_of(&s("")), 0.0);
        // U+FFFF < U+10000 by code point (UTF-16 would say the opposite)
        assert!(rel("<", &s("\u{FFFF}"), &s("\u{10000}")));
        assert_eq!(
            compare_for_sort(&s("\u{FFFF}"), &s("\u{10000}")),
            Ordering::Less
        );
        assert!(rel("<", &s("Z"), &s("a")));
    }

    #[test]
    fn size_of_everything_else() {
        assert_eq!(size_of(&Value::Null), 0.0);
        assert_eq!(size_of(&Value::Undefined), 0.0);
        assert_eq!(size_of(&arr(vec![num(1.0), num(2.0), num(3.0)])), 3.0);
        assert_eq!(size_of(&obj(&[("a", num(1.0)), ("b", num(2.0))])), 2.0);
        assert_eq!(size_of(&num(42.0)), 0.0);
        assert_eq!(size_of(&Value::Bool(true)), 0.0);
        assert_eq!(size_of(&rng(num(1.0), num(5.0), false)), 0.0);
        assert_eq!(func("size", &[]), num(0.0));
    }

    #[test]
    fn display_is_javascript_string_of() {
        assert_eq!(num(1.0).to_string(), "1");
        assert_eq!(num(-2.5).to_string(), "-2.5");
        assert_eq!(num(1e21).to_string(), "1e+21");
        assert_eq!(
            num(123456789012345680000.0).to_string(),
            "123456789012345680000"
        );
        assert_eq!(num(1e-6).to_string(), "0.000001");
        assert_eq!(num(1e-7).to_string(), "1e-7");
        assert_eq!(num(1.5e300).to_string(), "1.5e+300");
        assert_eq!(num(0.1 + 0.2).to_string(), "0.30000000000000004");
        assert_eq!(num(-0.0).to_string(), "0");
        assert_eq!(num(100.0).to_string(), "100");
        assert_eq!(num(f64::NAN).to_string(), "NaN");
        assert_eq!(num(f64::INFINITY).to_string(), "Infinity");
        assert_eq!(num(f64::NEG_INFINITY).to_string(), "-Infinity");
        assert_eq!(Value::Undefined.to_string(), "undefined");
        assert_eq!(Value::Null.to_string(), "null");
        assert_eq!(Value::Bool(true).to_string(), "true");
        assert_eq!(
            arr(vec![num(1.0), arr(vec![num(2.0), num(3.0)])]).to_string(),
            "1,2,3"
        );
        assert_eq!(
            arr(vec![Value::Null, Value::Undefined, num(1.0)]).to_string(),
            ",,1"
        );
        assert_eq!(obj(&[("a", num(1.0))]).to_string(), "[object Object]");
    }

    #[test]
    fn concatenation_uses_the_string_form() {
        assert_eq!(arith("+", &num(1.0), &s("")).unwrap(), s("1"));
        assert_eq!(arith("+", &s("n="), &num(2.5)).unwrap(), s("n=2.5"));
        assert_eq!(arith("+", &s("n="), &num(2.0)).unwrap(), s("n=2"));
        assert_eq!(arith("+", &s("n="), &num(-0.0)).unwrap(), s("n=0"));
        // absent has no string form: the result is absent, never "xnull"
        assert_eq!(arith("+", &s("x"), &Value::Null).unwrap(), Value::Undefined);
        assert_eq!(
            arith("+", &s("x"), &Value::Undefined).unwrap(),
            Value::Undefined
        );
        assert_eq!(arith("+", &Value::Null, &s("x")).unwrap(), Value::Undefined);
        assert_eq!(arith("+", &s("x"), &Value::Bool(true)).unwrap(), s("xtrue"));
        assert_eq!(
            arith("+", &s("x"), &arr(vec![num(1.0), num(2.0)])).unwrap(),
            s("x1,2")
        );
        assert_eq!(arith("+", &s("x"), &num(1e21)).unwrap(), s("x1e+21"));
    }

    #[test]
    fn absent_propagates_through_every_arithmetic_operator() {
        for op in ["+", "-", "*", "/", "%"] {
            assert_eq!(
                arith(op, &Value::Null, &num(1.0)).unwrap(),
                Value::Undefined,
                "{op}"
            );
            assert_eq!(
                arith(op, &num(1.0), &Value::Undefined).unwrap(),
                Value::Undefined,
                "{op}"
            );
            assert_eq!(
                arith(op, &Value::Null, &Value::Null).unwrap(),
                Value::Undefined,
                "{op}"
            );
        }
        // and the absent result equals null but does not order
        let r = arith("+", &Value::Null, &num(1.0)).unwrap();
        assert!(rel("==", &r, &Value::Null));
        assert!(!rel("==", &r, &num(1.0)));
        assert!(!rel("<", &r, &num(5.0)));
    }

    #[test]
    fn string_form_of_scalars() {
        assert_eq!(string_form(&Value::Null), None);
        assert_eq!(string_form(&Value::Undefined), None);
        assert_eq!(string_form(&s("x")).as_deref(), Some("x"));
        assert_eq!(string_form(&num(2.0)).as_deref(), Some("2"));
        assert_eq!(string_form(&num(2.5)).as_deref(), Some("2.5"));
        assert_eq!(string_form(&num(-0.0)).as_deref(), Some("0"));
        assert_eq!(string_form(&Value::Bool(false)).as_deref(), Some("false"));
    }

    #[test]
    fn arithmetic_over_doubles_follows_javascript_number_coercion() {
        assert_eq!(
            arith("+", &Value::Bool(true), &Value::Bool(true)).unwrap(),
            num(2.0)
        );
        assert_eq!(arith("-", &num(1.0), &num(2.5)).unwrap(), num(-1.5));
        assert_eq!(
            arith("/", &num(1.0), &num(0.0)).unwrap(),
            num(f64::INFINITY)
        );
        assert_eq!(arith("/", &num(7.0), &num(2.0)).unwrap(), num(3.5));
        assert_eq!(arith("%", &num(5.0), &num(-3.0)).unwrap(), num(2.0));
        assert_eq!(arith("%", &num(-5.0), &num(3.0)).unwrap(), num(-2.0));
        assert!(
            arith("*", &s("x"), &num(2.0))
                .unwrap()
                .as_f64()
                .unwrap()
                .is_nan()
        );
        assert_eq!(
            arith("*", &arr(vec![num(5.0)]), &num(2.0)).unwrap(),
            num(10.0)
        );
        assert!(
            arith("*", &obj(&[]), &num(2.0))
                .unwrap()
                .as_f64()
                .unwrap()
                .is_nan()
        );
        assert!(
            arith("*", &rng(num(1.0), num(2.0), false), &num(2.0))
                .unwrap()
                .as_f64()
                .unwrap()
                .is_nan()
        );
    }

    #[test]
    fn to_number_matches_javascript_number() {
        assert_eq!(to_number(&s("")), 0.0);
        assert_eq!(to_number(&s("  12 ")), 12.0);
        assert!(to_number(&s("abc")).is_nan());
        assert_eq!(to_number(&s("0x10")), 16.0);
        assert_eq!(to_number(&s("0b101")), 5.0);
        assert_eq!(to_number(&s("0o17")), 15.0);
        assert!(to_number(&s("-0x10")).is_nan());
        assert_eq!(to_number(&s("1e3")), 1000.0);
        assert_eq!(to_number(&s("Infinity")), f64::INFINITY);
        assert_eq!(to_number(&s("-Infinity")), f64::NEG_INFINITY);
        assert!(to_number(&s("inf")).is_nan()); // Rust would parse these; JS does not
        assert!(to_number(&s("nan")).is_nan());
        assert!(to_number(&s("1_000")).is_nan());
        assert_eq!(to_number(&s("1.")), 1.0);
        assert_eq!(to_number(&s(".5")), 0.5);
        assert_eq!(to_number(&s("+1")), 1.0);
        assert_eq!(to_number(&Value::Null), 0.0);
        assert!(to_number(&Value::Undefined).is_nan());
        assert_eq!(to_number(&arr(vec![])), 0.0);
        assert_eq!(to_number(&arr(vec![s("5")])), 5.0);
        assert!(to_number(&arr(vec![num(1.0), num(2.0)])).is_nan());
    }

    #[test]
    fn membership_edges() {
        // absent haystack is false, even for an absent needle
        assert!(!membership(&Value::Null, &Value::Null));
        assert!(!membership(&num(1.0), &Value::Undefined));
        // array membership uses `equals`: absent matches absent, no coercion
        assert!(membership(
            &Value::Null,
            &arr(vec![num(1.0), Value::Undefined])
        ));
        assert!(!membership(&s("1"), &arr(vec![num(1.0)])));
        assert!(membership(
            &arr(vec![num(1.0)]),
            &arr(vec![arr(vec![num(1.0)])])
        ));
        // substring and key tests use the needle's string form
        assert!(membership(&num(1.0), &s("a1b")));
        assert!(membership(&num(1.0), &obj(&[("1", s("x"))])));
        assert!(!membership(&s("toString"), &obj(&[])));
        assert!(membership(&s(""), &s("anything")));
        // an absent needle is never a substring or a key, whatever the spelling
        assert!(!membership(&Value::Null, &s("undefined null")));
        assert!(!membership(&Value::Undefined, &s("undefined null")));
        assert!(!membership(
            &Value::Null,
            &obj(&[("null", num(1.0)), ("undefined", num(2.0))])
        ));
        assert!(!membership(
            &Value::Undefined,
            &obj(&[("null", num(1.0)), ("undefined", num(2.0))])
        ));
        // a null-valued key still counts for a present needle
        assert!(membership(&s("k"), &obj(&[("k", Value::Null)])));
        // scalars hold nothing
        assert!(!membership(&num(1.0), &num(1.0)));
        assert!(!membership(&Value::Bool(true), &Value::Bool(true)));
        // a range never covers a value of the other domain
        assert!(!membership(&s("3"), &rng(num(1.0), num(5.0), false)));
        assert!(!membership(
            &num(3.0),
            &rng(s("2026-01-01"), s("2026-12-31"), false)
        ));
    }

    #[test]
    fn make_range_normalizes_absent_bounds_to_open_ends() {
        let r = make_range(Value::Undefined, Value::Null, true);
        assert_eq!(
            r,
            Range {
                lo: None,
                hi: None,
                exclusive_end: true
            }
        );
        assert!(range_covers(&r, &num(1e9))); // fully open covers every present number
        assert!(!range_covers(&r, &Value::Null)); // but never an absent value
        assert_eq!(rng(num(1.0), Value::Null, false).to_string(), "1..");
        assert_eq!(rng(num(1.0), num(5.0), true).to_string(), "1...5");
    }

    #[test]
    fn parse_range_string_edges() {
        assert_eq!(parse_range_string(".."), None);
        assert_eq!(parse_range_string("..."), None);
        assert_eq!(
            parse_range_string("1.5..2.5"),
            Some(make_range(num(1.5), num(2.5), false))
        );
        assert_eq!(
            parse_range_string("-1..-0.5"),
            Some(make_range(num(-1.0), num(-0.5), false))
        );
        assert_eq!(
            parse_range_string("1e2..1e3"),
            Some(make_range(num(100.0), num(1000.0), false))
        );
        assert_eq!(parse_range_string("1....5"), None); // four dots: non-maximal run
        assert_eq!(parse_range_string("1..5..9"), None); // "5..9" is not a number
        assert_eq!(
            parse_range_string("...5"),
            Some(make_range(Value::Null, num(5.0), true))
        );
        assert_eq!(
            parse_range_string("2026-01-01T00:00:00Z...2026-02-01T00:00:00Z"),
            Some(make_range(
                s("2026-01-01T00:00:00Z"),
                s("2026-02-01T00:00:00Z"),
                true
            ))
        );
        assert_eq!(
            parse_range_string("2026-01-01.."),
            Some(make_range(s("2026-01-01"), Value::Null, false))
        );
        assert_eq!(parse_range_string("１..５"), None); // non-ASCII digits are not numbers
        assert_eq!(parse_range_string("1..5\n"), None); // `.` does not cross a newline
    }

    #[test]
    fn compare_for_sort_is_total_and_desc_keeps_absent_last() {
        let mut xs = vec![
            s("b"),
            Value::Null,
            num(2.0),
            Value::Bool(true),
            s("a"),
            Value::Undefined,
            num(10.0),
            Value::Bool(false),
        ];
        xs.sort_by(compare_for_sort);
        assert_eq!(
            xs,
            vec![
                num(2.0),
                num(10.0),
                s("a"),
                s("b"),
                Value::Bool(false),
                Value::Bool(true),
                Value::Null,
                Value::Undefined
            ]
        );
        let mut ys = vec![num(3.0), Value::Null, num(1.0), Value::Undefined, num(2.0)];
        ys.sort_by(|a, b| compare_for_sort_dir(a, b, true));
        assert_eq!(
            ys,
            vec![num(3.0), num(2.0), num(1.0), Value::Null, Value::Undefined]
        );
        let mut zs = vec![num(3.0), num(1.0), num(2.0)];
        zs.sort_by(|a, b| compare_for_sort_dir(a, b, false));
        assert_eq!(zs, vec![num(1.0), num(2.0), num(3.0)]);
        // NaN neither precedes nor follows; arrays order by their String() form
        assert_eq!(compare_for_sort(&num(f64::NAN), &num(1.0)), Ordering::Equal);
        assert_eq!(
            compare_for_sort(
                &arr(vec![num(1.0), num(2.0)]),
                &arr(vec![num(1.0), num(3.0)])
            ),
            Ordering::Less
        );
        assert_eq!(
            compare_for_sort(&obj(&[("a", num(1.0))]), &obj(&[])),
            Ordering::Equal
        );
        assert_eq!(
            compare_for_sort(&Value::Null, &Value::Undefined),
            Ordering::Equal
        );
    }

    #[test]
    fn to_list_and_coerce_collection_agree() {
        for v in [
            Value::Undefined,
            arr(vec![num(1.0)]),
            s("x"),
            num(1.0),
            obj(&[("a", num(1.0))]),
        ] {
            assert_eq!(to_list(&v), coerce_collection(&v));
        }
        assert_eq!(to_list(&Value::Undefined).len(), 0);
        let o = obj(&[("a", num(1.0))]);
        assert_eq!(to_list(&o).as_ref(), std::slice::from_ref(&o)); // an object is one row, not its entries
        let r = rng(num(1.0), num(2.0), false);
        assert_eq!(to_list(&r).as_ref(), std::slice::from_ref(&r));
        assert!(matches!(to_list(&arr(vec![])), Cow::Borrowed(_)));
        assert_eq!(func("list", &[Value::Null]), arr(vec![]));
        assert_eq!(func("list", &[s("x")]), arr(vec![s("x")]));
        assert_eq!(func("list", &[]), arr(vec![]));
    }

    #[test]
    fn entries_of_preserves_insertion_order_and_shapes_key_value() {
        let o = obj(&[
            ("zeta", num(1.0)),
            ("alpha", num(2.0)),
            ("mid", Value::Null),
        ]);
        let es = entries_of(&o);
        assert_eq!(
            es,
            vec![
                Entry::new(s("zeta"), num(1.0)),
                Entry::new(s("alpha"), num(2.0)),
                Entry::new(s("mid"), Value::Null),
            ]
        );
        // the plain-value shape is `{ key, value }`, keys in that order
        let v: Value = es[0].clone().into();
        assert_eq!(v, obj(&[("key", s("zeta")), ("value", num(1.0))]));
        assert_eq!(
            v.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["key", "value"]
        );
        assert_eq!(Entry::from_value_shape(&v), Some(es[0].clone()));
        assert_eq!(
            Entry::from_value_shape(&obj(&[("value", num(1.0)), ("key", s("k"))])),
            None
        );
        assert_eq!(Entry::from_value_shape(&obj(&[("key", s("k"))])), None);
        // arrays yield numeric indices
        assert_eq!(
            entries_of(&arr(vec![s("a"), s("b")])),
            vec![Entry::new(num(0.0), s("a")), Entry::new(num(1.0), s("b"))]
        );
        // absent, scalars, and ranges yield nothing
        for v in [
            Value::Null,
            Value::Undefined,
            num(1.0),
            s("ab"),
            Value::Bool(true),
            rng(num(1.0), num(2.0), false),
        ] {
            assert!(entries_of(&v).is_empty(), "{v:?}");
        }
        // the builtin returns the records as an array, in order
        assert_eq!(
            func("entries", &[obj(&[("b", num(1.0)), ("a", num(2.0))])]),
            arr(vec![
                obj(&[("key", s("b")), ("value", num(1.0))]),
                obj(&[("key", s("a")), ("value", num(2.0))]),
            ])
        );
        assert_eq!(func("entries", &[Value::Null]), arr(vec![]));
    }

    #[test]
    fn has_is_presence_not_truthiness() {
        assert_eq!(func("has", &[num(0.0)]), Value::Bool(true));
        assert_eq!(func("has", &[s("")]), Value::Bool(true));
        assert_eq!(func("has", &[Value::Bool(false)]), Value::Bool(true));
        assert_eq!(func("has", &[Value::Null]), Value::Bool(false));
        assert_eq!(func("has", &[Value::Undefined]), Value::Bool(false));
        assert_eq!(func("has", &[]), Value::Bool(false));
    }

    #[test]
    fn range_builtin_rejects_non_strings() {
        assert_eq!(func("range", &[num(5.0)]), Value::Null);
        assert_eq!(func("range", &[Value::Null]), Value::Null);
        assert_eq!(func("range", &[]), Value::Null);
        assert_eq!(
            func("range", &[obj(&[("lo", num(1.0)), ("hi", num(5.0))])]),
            Value::Null
        );
    }

    #[test]
    fn unknown_builtins_are_none() {
        assert!(builtin_function("nope", &[]).is_none());
        assert!(builtin_method("nope", &s("x"), &[]).is_none());
        // the tables are case-sensitive and use the surface spelling
        assert!(builtin_method("startswith", &s("x"), &[]).is_none());
        for n in BUILTIN_FUNCTION_NAMES {
            assert!(builtin_function(n, &[]).is_some(), "{n}");
        }
        for n in BUILTIN_METHOD_NAMES {
            assert!(builtin_method(n, &s("x"), &[s("x")]).is_some(), "{n}");
        }
    }

    #[test]
    fn string_methods() {
        assert_eq!(
            method("contains", &s("hello"), &[s("ell")]),
            Value::Bool(true)
        );
        assert_eq!(
            method("contains", &s("hello"), &[s("xyz")]),
            Value::Bool(false)
        );
        assert_eq!(
            method("contains", &s("a1b"), &[num(1.0)]),
            Value::Bool(true)
        );
        assert_eq!(
            method("contains", &arr(vec![s("admin"), s("ops")]), &[s("admin")]),
            Value::Bool(true)
        );
        assert_eq!(
            method("contains", &arr(vec![num(1.0)]), &[s("1")]),
            Value::Bool(false)
        );
        assert_eq!(
            method("contains", &num(11.0), &[num(1.0)]),
            Value::Bool(false)
        );
        assert_eq!(
            method("contains", &Value::Null, &[s("x")]),
            Value::Bool(false)
        );
        assert_eq!(
            method("startsWith", &s("Engineer"), &[s("Eng")]),
            Value::Bool(true)
        );
        assert_eq!(
            method("startsWith", &s("Engineer"), &[s("eng")]),
            Value::Bool(false)
        );
        assert_eq!(
            method("startsWith", &num(12.0), &[s("1")]),
            Value::Bool(false)
        );
        assert_eq!(
            method("endsWith", &s("Engineer"), &[s("eer")]),
            Value::Bool(true)
        );
        assert_eq!(
            method("endsWith", &Value::Null, &[s("")]),
            Value::Bool(false)
        );
        assert_eq!(method("lower", &s("DiReCtOr"), &[]), s("director"));
        assert_eq!(method("upper", &s("straße"), &[]), s("STRASSE"));
        assert_eq!(method("upper", &num(1.5), &[]), s("1.5"));
        assert_eq!(method("upper", &num(2.0), &[]), s("2"));
        assert_eq!(method("lower", &Value::Bool(true), &[]), s("true"));
        // an absent receiver yields absent, never "undefined" / "NULL"
        assert_eq!(method("lower", &Value::Undefined, &[]), Value::Undefined);
        assert_eq!(method("upper", &Value::Null, &[]), Value::Undefined);
        // an absent argument is never a substring / prefix / suffix
        assert_eq!(
            method("contains", &s("undefined"), &[Value::Undefined]),
            Value::Bool(false)
        );
        assert_eq!(
            method("startsWith", &s("null"), &[Value::Null]),
            Value::Bool(false)
        );
        assert_eq!(
            method("endsWith", &s("null"), &[Value::Null]),
            Value::Bool(false)
        );
        assert_eq!(
            method("startsWith", &s("12x"), &[num(12.0)]),
            Value::Bool(true)
        );
        assert_eq!(
            method("size", &arr(vec![num(1.0), num(2.0)]), &[]),
            num(2.0)
        );
        assert_eq!(method("size", &Value::Null, &[]), num(0.0));
    }

    #[test]
    fn matches_uses_the_regex_crate_and_surfaces_bad_patterns_as_eval_errors() {
        assert_eq!(
            method("matches", &s("hello world"), &[s("^hel+o\\b")]),
            Value::Bool(true)
        );
        assert_eq!(
            method("matches", &s("hello"), &[s("^world$")]),
            Value::Bool(false)
        );
        assert_eq!(
            method("matches", &s("hello"), &[s("ELL")]),
            Value::Bool(false)
        ); // case-sensitive
        assert_eq!(
            method("matches", &s("hello"), &[s("(?i)ELL")]),
            Value::Bool(true)
        );
        assert_eq!(
            method("matches", &num(2026.0), &[s("^20[0-9]{2}$")]),
            Value::Bool(true)
        );
        assert_eq!(
            method("matches", &Value::Null, &[s(".*")]),
            Value::Bool(false)
        );
        assert_eq!(
            method("matches", &Value::Undefined, &[s("undefined")]),
            Value::Bool(false)
        );
        // an empty / missing pattern matches everything present, as `new RegExp("")` does
        assert_eq!(method("matches", &s("x"), &[s("")]), Value::Bool(true));
        let err = builtin_method("matches", &s("x"), &[s("(unclosed")])
            .unwrap()
            .unwrap_err();
        assert_eq!(err.stage, crate::Stage::Eval);
        assert!(
            err.message.contains("invalid regular expression"),
            "{}",
            err.message
        );
        // outside the portable dialect: lookaround and backreferences are
        // rejected with the spec's wording, before the regex crate sees them
        for (pattern, what) in [
            ("a(?=b)", "lookahead (?=…)"),
            ("a(?!c)", "negative lookahead (?!…)"),
            ("(?<=a)b", "lookbehind (?<=…)"),
            ("(?<!c)b", "negative lookbehind (?<!…)"),
            ("(a)\\1", "a backreference"),
            ("(?<x>a)\\k<x>", "a named backreference"),
            ("[a]\\9", "a backreference"),
        ] {
            let err = builtin_method("matches", &s("ab"), &[s(pattern)])
                .unwrap()
                .unwrap_err();
            assert_eq!(err.stage, crate::Stage::Eval, "{pattern}");
            assert!(
                err.message.contains("not supported in OQX") && err.message.contains(what),
                "{pattern}: {}",
                err.message
            );
        }
        // the scan honors escapes and classes: these are literals, not lookaround
        assert_eq!(
            method("matches", &s("(?="), &[s("\\(\\?=")]),
            Value::Bool(true)
        );
        assert_eq!(
            method("matches", &s("(?"), &[s("[(][?]")]),
            Value::Bool(true)
        );
        assert_eq!(
            method("matches", &s("x(?=y"), &[s("[(]\\?=")]),
            Value::Bool(true)
        );
        // a named group without a backreference is fine
        assert_eq!(
            method("matches", &s("aa"), &[s("(?<x>a)a")]),
            Value::Bool(true)
        );
        // a number receiver matches on its string form
        assert_eq!(method("matches", &num(2.0), &[s("^2$")]), Value::Bool(true));
    }

    #[test]
    fn range_covers_only_numbers_and_strings() {
        let open = make_range(Value::Null, Value::Null, false);
        assert!(!range_covers(&open, &Value::Bool(true)));
        assert!(!range_covers(&open, &arr(vec![])));
        assert!(!range_covers(&open, &obj(&[])));
        assert!(range_covers(&open, &s("anything")));
        let to5 = make_range(Value::Null, num(5.0), false);
        assert!(!range_covers(&to5, &Value::Null)); // `nope in ..5` is false
        assert!(!range_covers(&to5, &s("3"))); // a string does not order against a number
    }

    #[test]
    fn canonical_key_is_structural_and_type_tagged() {
        assert_eq!(canonical_key(&Value::Null), "n");
        assert_eq!(canonical_key(&Value::Undefined), "n");
        assert_eq!(canonical_key(&Value::Bool(true)), "t");
        assert_eq!(canonical_key(&num(1.0)), "d1");
        assert_eq!(canonical_key(&num(-0.0)), "d0");
        assert_eq!(canonical_key(&num(2.5)), "d2.5");
        assert_eq!(canonical_key(&s("1")), "s\"1\"");
        assert_eq!(canonical_key(&s("a\"b")), "s\"a\\\"b\"");
        assert_ne!(canonical_key(&num(1.0)), canonical_key(&s("1")));
        assert_ne!(canonical_key(&obj(&[])), canonical_key(&arr(vec![])));
        assert_eq!(canonical_key(&arr(vec![num(1.0), s("a")])), "[d1,s\"a\"]");
        // key order ignored; undefined ≡ null
        assert_eq!(
            canonical_key(&obj(&[("b", num(2.0)), ("a", Value::Undefined)])),
            canonical_key(&obj(&[("a", Value::Null), ("b", num(2.0))]))
        );
        assert_eq!(
            canonical_key(&obj(&[("b", num(2.0)), ("a", num(1.0))])),
            "{\"a\":d1,\"b\":d2}"
        );
        assert_ne!(
            canonical_key(&obj(&[("a", num(1.0))])),
            canonical_key(&obj(&[("a", num(2.0))]))
        );
        assert_ne!(
            canonical_key(&rng(num(1.0), num(2.0), true)),
            canonical_key(&rng(num(1.0), num(2.0), false))
        );
    }

    #[test]
    fn compare_orders_only_same_kind_numbers_and_strings() {
        assert_eq!(compare(&num(9.0), &num(10.0)), Some(Ordering::Less));
        assert_eq!(compare(&s("10"), &s("9")), Some(Ordering::Less));
        assert_eq!(compare(&num(1.0), &s("2")), None);
        assert_eq!(compare(&Value::Bool(false), &Value::Bool(true)), None);
        assert_eq!(compare(&Value::Null, &num(1.0)), None);
        assert_eq!(compare(&num(f64::NAN), &num(1.0)), None);
    }

    #[test]
    fn truthiness_is_javascript() {
        for v in [
            Value::Undefined,
            Value::Null,
            Value::Bool(false),
            num(0.0),
            num(-0.0),
            num(f64::NAN),
            s(""),
        ] {
            assert!(!truthy(&v), "{v:?}");
        }
        for v in [
            Value::Bool(true),
            num(1.0),
            s("0"),
            s("false"),
            arr(vec![]),
            obj(&[]),
            rng(Value::Null, num(1.0), false),
        ] {
            assert!(truthy(&v), "{v:?}");
        }
    }
}
