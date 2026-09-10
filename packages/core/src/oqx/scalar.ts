// Boundary shim to the CEL scalar-expression layer. OQX owns query structure;
// everything scalar (comparisons, boolean logic, list(), string fns, absence
// semantics) is compiled by the existing CEL parser+compiler, reused verbatim.
//
// FUTURE ALIAS-PARAMETERIZATION SEAM: compile()/scalarValue() hardcode per-target
// aliases (documents=d, blocks=b, nodes=n). Slice 1 keeps at most one live scope
// per target (enforced in lower.ts), so reuse is safe. Deep nesting / traversal
// will add an alias/scope param here (n1, b2, …) — do it in this module.

import { parseFilter } from "../search/cel/parser.js";
import { compile as celCompile, scalarValue, type Target } from "../search/cel/compile.js";
import type { ScalarPredicate } from "./ir.js";

/** Compile a scalar boolean predicate to a SQL WHERE fragment. */
export function compilePredicate(p: ScalarPredicate): { sql: string; params: unknown[] } {
  return celCompile(parseFilter(p.source), p.target);
}

/** Compile a scalar VALUE expression (for projection) to a SQL scalar + params. */
export function compileValue(source: string, target: Target): { expr: string; params: unknown[] } {
  return scalarValue(parseFilter(source), target);
}
