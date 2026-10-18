//! The block model (`spec/format/README.md` §1): a source-backed tree of
//! blocks with byte spans, trailing trivia, typed attributes and normalized
//! visible text.

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use crate::hash;

/// Half-open `[start, end)` byte offsets into the UTF-8 encoding of the
/// source (§1 inv. 5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    #[must_use]
    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    #[must_use]
    pub const fn len(&self) -> usize {
        self.end.saturating_sub(self.start)
    }

    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.end <= self.start
    }

    /// `other` lies within `self` (§1 inv. 3).
    #[must_use]
    pub const fn contains(&self, other: &Span) -> bool {
        self.start <= other.start && other.end <= self.end
    }
}

/// The block kinds of §3, unqualified for Markdown (`heading`, not
/// `md:heading`), then the kinds of the two whole-document formats, which
/// carry their format as a namespace (`yaml:mapping_entry`, `json:property`)
/// exactly as the reference adapters spell them (`format/yaml.ts`,
/// `format/json.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum BlockKind {
    Frontmatter,
    Heading,
    Paragraph,
    List,
    ListItem,
    Task,
    Blockquote,
    CodeFence,
    Table,
    TableRow,
    ThematicBreak,
    HtmlBlock,
    Opaque,
    /// `yaml:mapping` — a mapping that is a sequence item.
    YamlMapping,
    /// `yaml:mapping_entry` — a `key: value` pair; nested pairs and sequence
    /// elements are its children.
    YamlMappingEntry,
    /// `yaml:sequence` — a sequence that is a sequence item (not walked).
    YamlSequence,
    /// `yaml:sequence_item` — a scalar element of a sequence.
    YamlSequenceItem,
    /// `yaml:scalar` — a scalar root, or a comment-only document.
    YamlScalar,
    /// `yaml:opaque` — a document the parser could not read, as one block.
    YamlOpaque,
    /// `json:object` — an object member (or an object element) one level
    /// below a root property.
    JsonObject,
    /// `json:property` — a member of the root object.
    JsonProperty,
    /// `json:array` — an array element one level below a root property.
    JsonArray,
    /// `json:item` — an element of a root array.
    JsonItem,
    /// `json:scalar` — a scalar element one level below a root property, or
    /// a scalar root.
    JsonScalar,
    /// `json:opaque` — a text the scanner could not read, as one block.
    JsonOpaque,
}

impl BlockKind {
    /// Every kind: the §3 table in order, then the `yaml:` kinds, then the
    /// `json:` kinds.
    pub const ALL: [BlockKind; 25] = [
        BlockKind::Frontmatter,
        BlockKind::Heading,
        BlockKind::Paragraph,
        BlockKind::List,
        BlockKind::ListItem,
        BlockKind::Task,
        BlockKind::Blockquote,
        BlockKind::CodeFence,
        BlockKind::Table,
        BlockKind::TableRow,
        BlockKind::ThematicBreak,
        BlockKind::HtmlBlock,
        BlockKind::Opaque,
        BlockKind::YamlMapping,
        BlockKind::YamlMappingEntry,
        BlockKind::YamlSequence,
        BlockKind::YamlSequenceItem,
        BlockKind::YamlScalar,
        BlockKind::YamlOpaque,
        BlockKind::JsonObject,
        BlockKind::JsonProperty,
        BlockKind::JsonArray,
        BlockKind::JsonItem,
        BlockKind::JsonScalar,
        BlockKind::JsonOpaque,
    ];

    /// The spec's string form (the fixture `type` field).
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            BlockKind::Frontmatter => "frontmatter",
            BlockKind::Heading => "heading",
            BlockKind::Paragraph => "paragraph",
            BlockKind::List => "list",
            BlockKind::ListItem => "list_item",
            BlockKind::Task => "task",
            BlockKind::Blockquote => "blockquote",
            BlockKind::CodeFence => "code_fence",
            BlockKind::Table => "table",
            BlockKind::TableRow => "table_row",
            BlockKind::ThematicBreak => "thematic_break",
            BlockKind::HtmlBlock => "html_block",
            BlockKind::Opaque => "opaque",
            BlockKind::YamlMapping => "yaml:mapping",
            BlockKind::YamlMappingEntry => "yaml:mapping_entry",
            BlockKind::YamlSequence => "yaml:sequence",
            BlockKind::YamlSequenceItem => "yaml:sequence_item",
            BlockKind::YamlScalar => "yaml:scalar",
            BlockKind::YamlOpaque => "yaml:opaque",
            BlockKind::JsonObject => "json:object",
            BlockKind::JsonProperty => "json:property",
            BlockKind::JsonArray => "json:array",
            BlockKind::JsonItem => "json:item",
            BlockKind::JsonScalar => "json:scalar",
            BlockKind::JsonOpaque => "json:opaque",
        }
    }

    /// The format whose adapter produces this kind: `markdown` for the §3
    /// table, else the namespace (`yaml`, `json`).
    #[must_use]
    pub fn format(&self) -> &'static str {
        match self.as_str().split_once(':') {
            Some(("yaml", _)) => "yaml",
            Some(("json", _)) => "json",
            _ => "markdown",
        }
    }

    /// The Markdown kinds whose children are blocks (§1: parser nesting
    /// only). A `yaml:`/`json:` kind nests too (a mapping entry's pairs, a
    /// property's members) but is not a container in the Markdown sense:
    /// its text is its own raw, and nothing is inserted "into" it.
    #[must_use]
    pub const fn is_container(&self) -> bool {
        matches!(
            self,
            BlockKind::List
                | BlockKind::ListItem
                | BlockKind::Task
                | BlockKind::Blockquote
                | BlockKind::Table
        )
    }
}

impl fmt::Display for BlockKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An unrecognized kind name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnknownKind(pub String);

impl fmt::Display for UnknownKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown block kind {:?}", self.0)
    }
}

impl std::error::Error for UnknownKind {}

impl FromStr for BlockKind {
    type Err = UnknownKind;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        BlockKind::ALL
            .iter()
            .copied()
            .find(|k| k.as_str() == s)
            .ok_or_else(|| UnknownKind(s.to_owned()))
    }
}

/// An attribute value (§3: booleans, integers or strings).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum AttrValue {
    Bool(bool),
    Int(i64),
    Str(String),
}

impl From<bool> for AttrValue {
    fn from(b: bool) -> Self {
        AttrValue::Bool(b)
    }
}

impl From<i64> for AttrValue {
    fn from(n: i64) -> Self {
        AttrValue::Int(n)
    }
}

impl From<&str> for AttrValue {
    fn from(s: &str) -> Self {
        AttrValue::Str(s.to_owned())
    }
}

impl From<String> for AttrValue {
    fn from(s: String) -> Self {
        AttrValue::Str(s)
    }
}

/// Typed attributes with sorted keys (§1: "an object with sorted keys").
pub type Attrs = BTreeMap<String, AttrValue>;

/// One block (§1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub kind: BlockKind,
    /// `[start, end)` byte offsets into the source.
    pub span: Span,
    /// The source bytes at `span`; never ends in a line ending (§1 inv. 4).
    pub raw: String,
    /// Normalized visible text (§4.1).
    pub text: String,
    /// Typed attributes (§3).
    pub attrs: Attrs,
    /// Nested blocks — parser nesting only (lists, items, blockquotes, tables).
    pub children: Vec<Block>,
    /// Bytes between this block's end and the next block's start. Top level
    /// only; nested blocks carry `""` (§1, §2).
    pub trivia: String,
}

impl Block {
    /// `raw_hash`: SHA-256 of the block's raw bytes (§4.2).
    #[must_use]
    pub fn raw_hash(&self) -> [u8; 32] {
        hash::raw_hash(&self.raw)
    }

    /// `norm_hash`: SHA-256 of the UTF-8 encoding of `text` (§4.2).
    #[must_use]
    pub fn norm_hash(&self) -> [u8; 32] {
        hash::norm_hash(&self.text)
    }

    /// This block and every descendant, depth first, in document order.
    pub fn iter(&self) -> impl Iterator<Item = &Block> {
        Walk { stack: vec![self] }
    }
}

/// A parsed source (§1).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct BlockTree {
    /// The decoded source text the tree was parsed from.
    pub source: String,
    /// Bytes before the first block (`""` when a block starts at 0; the whole
    /// source when there are no blocks).
    pub leading_trivia: String,
    /// Top-level blocks in document order.
    pub children: Vec<Block>,
}

impl BlockTree {
    /// Every block at every depth, depth first, in document order.
    pub fn iter(&self) -> impl Iterator<Item = &Block> {
        Walk {
            stack: self.children.iter().rev().collect(),
        }
    }
}

struct Walk<'a> {
    stack: Vec<&'a Block>,
}

impl<'a> Iterator for Walk<'a> {
    type Item = &'a Block;

    fn next(&mut self) -> Option<&'a Block> {
        let block = self.stack.pop()?;
        self.stack.extend(block.children.iter().rev());
        Some(block)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_names_round_trip() {
        for k in BlockKind::ALL {
            assert_eq!(k.as_str().parse::<BlockKind>(), Ok(k));
            assert_eq!(k.to_string(), k.as_str());
        }
        assert!("md:heading".parse::<BlockKind>().is_err());
        assert_eq!(
            "yaml:mapping_entry".parse::<BlockKind>(),
            Ok(BlockKind::YamlMappingEntry)
        );
        assert_eq!(BlockKind::YamlMappingEntry.format(), "yaml");
        assert_eq!(BlockKind::JsonProperty.format(), "json");
        assert_eq!(BlockKind::Heading.format(), "markdown");
        assert!(!BlockKind::YamlMappingEntry.is_container());
    }

    #[test]
    fn span_containment() {
        let outer = Span::new(2, 10);
        assert!(outer.contains(&Span::new(2, 10)));
        assert!(outer.contains(&Span::new(4, 4)));
        assert!(!outer.contains(&Span::new(1, 3)));
        assert!(!outer.contains(&Span::new(9, 11)));
        assert_eq!(outer.len(), 8);
        assert!(Span::new(3, 3).is_empty());
    }

    #[test]
    fn walk_is_depth_first_document_order() {
        let leaf = |raw: &str| Block {
            kind: BlockKind::Paragraph,
            span: Span::new(0, 0),
            raw: raw.to_owned(),
            text: raw.to_owned(),
            attrs: Attrs::new(),
            children: Vec::new(),
            trivia: String::new(),
        };
        let mut list = leaf("list");
        list.children = vec![leaf("a"), leaf("b")];
        let tree = BlockTree {
            source: String::new(),
            leading_trivia: String::new(),
            children: vec![list, leaf("p")],
        };
        let order: Vec<&str> = tree.iter().map(|b| b.raw.as_str()).collect();
        assert_eq!(order, ["list", "a", "b", "p"]);
    }
}
