---
crates:
  oqx: patch
---
`cargo publish` verifies a crate with its default features, and `oqx` has none: the five `WORDS` tables on `Consumer`, `RelOp`, `BinaryOp`, `UnaryOp` and `LogicalOp` are read only by the serde `Deserialize` impl behind the `json` feature, so the packaged 0.28.0 build printed five `dead_code` warnings that the workspace gates (`--all-features`, `-D warnings`) never saw. The constants carry `#[cfg_attr(not(feature = "json"), allow(dead_code))]`; `cargo check -p oqx --no-default-features` is warning-free. No behaviour change.
