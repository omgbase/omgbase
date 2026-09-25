//! A single error type for every OQX failure — lex, parse, and evaluation.
//! `stage` distinguishes where it came from so callers (and the conformance
//! fixtures, which assert on `stage` plus stable message fragments) can branch
//! without matching whole messages.

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Stage {
    Lex,
    Parse,
    Eval,
}

impl Stage {
    /// The spec's spelling: `"lex" | "parse" | "eval"`.
    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Lex => "lex",
            Stage::Parse => "parse",
            Stage::Eval => "eval",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OqxError {
    pub stage: Stage,
    pub message: String,
}

impl OqxError {
    pub fn new(stage: Stage, message: impl Into<String>) -> Self {
        Self {
            stage,
            message: message.into(),
        }
    }
    pub fn lex(message: impl Into<String>) -> Self {
        Self::new(Stage::Lex, message)
    }
    pub fn parse(message: impl Into<String>) -> Self {
        Self::new(Stage::Parse, message)
    }
    pub fn eval(message: impl Into<String>) -> Self {
        Self::new(Stage::Eval, message)
    }
}

impl fmt::Display for OqxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "OqxError({}): {}", self.stage.as_str(), self.message)
    }
}

impl std::error::Error for OqxError {}

pub type Result<T> = std::result::Result<T, OqxError>;
