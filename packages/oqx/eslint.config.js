import { baseConfig } from "../../eslint.config.base.js";

// @omgbase/oqx is a standalone zero-dependency library (ADR-019). It shares the
// workspace lint baseline; the "no omgbase imports" boundary is a review rule
// (see AGENTS.md), since the package has no dependencies at all to restrict.
export default baseConfig(import.meta.dirname);
