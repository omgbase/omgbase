//! The current-state core (`docs/modular-core/README.md`, Phase 1 "isolate
//! interfaces"): identity ([`ids`], [`mint`], [`claims`]), time and order
//! keys, the document and block rows the observe commit writes
//! ([`observe`], [`writers`], [`properties`], [`graph`], [`derived`]), the
//! change feed and its retention ([`feed`], 17.0 — D7/M5) over the settings
//! layers ([`settings`]), the capability manifest and the alert channel
//! ([`manifest`], [`alerts`] — 17.0, 3e-ii), the
//! current reads ([`read`], [`text_search`]), the mutation host side
//! ([`mutate`], [`effects_plan`], [`docs_ops`], [`macros`], [`links`],
//! [`sugar`], [`plan`]), recovery ([`materialize`]) and the size report
//! ([`size`]) — and the seams it reaches its extensions through
//! ([`capabilities`], with the vocabulary of [`history_shapes`] and
//! [`semantic_shapes`]) and the test-only fault hook ([`fault`], 17.3). Nothing here names `crate::history` or
//! `crate::semantic`, and no SQL here names a vector table: `tests/boundaries.rs` checks every `crate::` path of
//! this directory against the extensions' module stems, with
//! `boundary-allowlist.txt` listing what Phase 3 still has to remove.

pub mod alerts;
pub mod capabilities;
pub mod claims;
pub mod codec;
pub mod derived;
pub mod doc_store;
pub mod docs_ops;
pub(crate) mod effects;
pub mod effects_plan;
pub mod fault;
pub mod feed;
pub mod graph;
pub mod history_shapes;
pub mod ids;
pub mod legacy_bytes;
pub mod links;
pub mod macros;
pub mod manifest;
pub mod materialize;
pub mod mint;
pub mod mutate;
pub mod observe;
pub mod order_key;
pub mod plan;
pub mod properties;
pub mod read;
pub mod semantic_shapes;
pub mod settings;
pub mod size;
pub mod sugar;
pub mod text_search;
pub mod time;
pub mod writers;
pub mod yaml_emit;

pub use capabilities::{
    CAPABILITIES_ENV, COMPOSITIONS, Capabilities, CapabilityState, Composition, HistoryRecorder,
    IdentityClaims, SemanticProvider, require_history, require_semantic,
};
pub use claims::{ClaimScope, IdClaims};
pub use fault::{
    ArmedFault, FAULT_ENV, FAULT_SITES, FaultSite, armed_fault, fault_passes, fault_point,
    injected_fault_message, parse_fault, reset_faults, set_armed_fault,
};
