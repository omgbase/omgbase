import { baseConfig } from "../../eslint.config.base.js";

// @omgbase/dataview is a standalone translator (DQL → OQX): its only runtime
// dependency is @omgbase/oqx (the AST builders and the canonical printer). It
// never imports omgbase internals, so the whole directory can move into an
// Obsidian plugin as is — a review rule, like oqx's (see AGENTS.md).
export default baseConfig(import.meta.dirname);
