//! The row shape of `spec/properties` §1 and the enumerations it carries.

use std::fmt;

/// Where a row came from (§3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Source {
    Frontmatter,
    Inline,
    Computed,
}

impl Source {
    /// Every source, in rank order (§5: frontmatter 0, inline 1, computed 2).
    pub const ALL: [Source; 3] = [Source::Frontmatter, Source::Inline, Source::Computed];

    /// The stored string (`properties.source`).
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Source::Frontmatter => "frontmatter",
            Source::Inline => "inline",
            Source::Computed => "computed",
        }
    }

    /// The §5 rank.
    #[must_use]
    pub const fn rank(self) -> u8 {
        match self {
            Source::Frontmatter => 0,
            Source::Inline => 1,
            Source::Computed => 2,
        }
    }

    /// Parse the stored string.
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|v| v.as_str() == s)
    }
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The authored shape (§2.3, §3.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Card {
    Scalar,
    List,
}

impl Card {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Card::Scalar => "scalar",
            Card::List => "list",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "scalar" => Some(Card::Scalar),
            "list" => Some(Card::List),
            _ => None,
        }
    }
}

impl fmt::Display for Card {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The `type` column (§2.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ValueType {
    String,
    Number,
    Bool,
    Null,
    Json,
}

impl ValueType {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            ValueType::String => "string",
            ValueType::Number => "number",
            ValueType::Bool => "bool",
            ValueType::Null => "null",
            ValueType::Json => "json",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "string" => Some(ValueType::String),
            "number" => Some(ValueType::Number),
            "bool" => Some(ValueType::Bool),
            "null" => Some(ValueType::Null),
            "json" => Some(ValueType::Json),
            _ => None,
        }
    }
}

impl fmt::Display for ValueType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The typed columns of a row (§2.1): exactly one of the `val_*` columns is
/// set for `string`/`number`/`bool`/`json`; none for `null`; a range-shaped
/// string sets `val_text` **and** `val_json` (§2.2).
#[derive(Clone, Debug, PartialEq)]
pub struct Typed {
    pub ty: ValueType,
    pub val_text: Option<String>,
    /// May be non-finite (§8): `NaN` stores as `NULL` with `type = number`.
    pub val_num: Option<f64>,
    pub val_bool: Option<bool>,
    /// JSON text.
    pub val_json: Option<String>,
}

impl Typed {
    #[must_use]
    pub const fn null() -> Self {
        Self {
            ty: ValueType::Null,
            val_text: None,
            val_num: None,
            val_bool: None,
            val_json: None,
        }
    }

    #[must_use]
    pub fn bool(b: bool) -> Self {
        Self {
            ty: ValueType::Bool,
            val_bool: Some(b),
            ..Self::null()
        }
    }

    #[must_use]
    pub fn number(n: f64) -> Self {
        Self {
            ty: ValueType::Number,
            val_num: Some(n),
            ..Self::null()
        }
    }

    #[must_use]
    pub fn string(s: impl Into<String>) -> Self {
        Self {
            ty: ValueType::String,
            val_text: Some(s.into()),
            ..Self::null()
        }
    }

    #[must_use]
    pub fn json(text: impl Into<String>) -> Self {
        Self {
            ty: ValueType::Json,
            val_json: Some(text.into()),
            ..Self::null()
        }
    }
}

/// A row before it is attributed to a source and a document: what the
/// flatteners (§2.3, §2.4) and the inline pass (§3.2) produce.
#[derive(Clone, Debug, PartialEq)]
pub struct FlatRow {
    pub key: String,
    pub card: Card,
    pub ord: u32,
    pub typed: Typed,
}

/// One property row (§1).
#[derive(Clone, Debug, PartialEq)]
pub struct PropertyRow {
    /// `"p_"` + the first 12 hex characters of
    /// `sha256(doc_id + "|" + source + "|" + key + "|" + ord)`.
    pub prop_id: String,
    /// The authoring block for inline rows; `None` for frontmatter and computed.
    pub block_id: Option<String>,
    pub source: Source,
    /// Dotted, flattened; computed keys carry `$`.
    pub key: String,
    pub card: Card,
    /// Position within a multi-value key, from 0; 0 for a scalar.
    pub ord: u32,
    pub ty: ValueType,
    pub val_text: Option<String>,
    /// May be non-finite (§8).
    pub val_num: Option<f64>,
    pub val_bool: Option<bool>,
    /// JSON text: the `json` value, or the range side channel (§2.2).
    pub val_json: Option<String>,
}
