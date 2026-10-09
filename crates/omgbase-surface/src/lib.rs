//! # omgbase-surface
//!
//! The omgbase surface, Rust implementation of `spec/surface`: the OQX
//! **query binding** over [`omgbase_store::Store`] ([`context`], [`mod@query`],
//! the tier-3 pushdown [`planner`] and its [`translate`] seam, the
//! store-backed indexes nested blocks probe — [`store_index`]),
//! the document and block **reads** ([`read`]), the **history** reads
//! ([`history`]), link health ([`links`]), the `graph` macro ([`graph`]), and
//! the **MCP tool catalog** as a library ([`catalog`]): a table of tools with
//! JSON-schema inputs and handlers dispatching into the store, with the
//! error envelope of §4. Transport-agnostic — the `omgbase` binary serves
//! [`catalog::Surface`] over MCP stdio.
//!
//! ```
//! use omgbase_store::Store;
//! use omgbase_surface::catalog::Surface;
//! use serde_json::json;
//!
//! let mut store = Store::open_in_memory()?;
//! let repo = store.create_repo("notes")?;
//! let mut surface = Surface::new(store, &repo, None);
//! let out = surface.call("observe", json!({ "path": "a.md", "content": "# Title\n\nFirst.\n" }));
//! assert!(!out.is_error);
//! let res = surface.call("query", json!({ "query": "select $title from docs" }));
//! assert_eq!(res.body["hits"][0]["$title"], "Title");
//! # Ok::<(), omgbase_store::Error>(())
//! ```

#![forbid(unsafe_code)]
// The error envelope carries a code, a message and an optional JSON `data`
// (~128 bytes); every failure is a cold path at the tool boundary, so the
// `Result` size is not worth boxing.
#![allow(clippy::result_large_err)]

pub mod catalog;
pub mod context;
pub mod cursor;
pub mod error;
pub mod graph;
pub mod history;
pub mod links;
pub mod planner;
pub mod query;
pub mod read;
pub mod reference;
pub mod store_index;
pub mod translate;
pub mod version;

pub use catalog::{Surface, ToolOutcome, ToolSpec};
pub use context::{StoreContext, Target, glob_to_like};
pub use cursor::{decode_cursor, encode_cursor};
pub use error::{Result, SurfaceError};
pub use planner::SqlitePlanner;
pub use query::{OqxResult, QueryOptions, collect_semantic_phrases, query, rewrite_query};
pub use version::{BuildInfo, MCP_PROTOCOL_VERSION, version_info};

/// The `spec/surface/VERSION` this crate implements (`major.minor`).
pub const SPEC_VERSION: &str = "1.4";

/// This crate's own version (`Cargo.toml`), for the surface's `version` tool.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
