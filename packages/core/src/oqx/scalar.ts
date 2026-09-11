// Boundary shim to the CEL scalar-expression layer. OQX owns query structure;
// everything scalar (comparisons, boolean logic, list(), string fns, absence
// semantics) is compiled by the existing CEL parser+compiler, reused verbatim.
//
// ALIAS-PARAMETERIZATION SEAM: compile()/scalarValue() take an AliasCtx naming
// the scope's row alias (self) and its correlated docs alias (doc). OQX assigns
// a distinct `self` per nested scope (n1, b1, …) so same-target nesting and
// self-relations do not shadow the outer row; the top-level scope uses the
// canonical per-target defaults.

import { parseFilter } from "../search/cel/parser.js";
import {
  compile as celCompile, scalarValue,
  type Target, type AliasCtx, type OuterBinding, type OuterResolver,
} from "../search/cel/compile.js";
import type { ScalarPredicate } from "./ir.js";

export type { AliasCtx, OuterBinding, OuterResolver };

/** Compile a scalar boolean predicate to a SQL WHERE fragment. */
export function compilePredicate(p: ScalarPredicate, ctx?: AliasCtx): { sql: string; params: unknown[] } {
  return celCompile(parseFilter(p.source), p.target, ctx);
}

/** Compile a scalar VALUE expression (for projection) to a SQL scalar + params. */
export function compileValue(source: string, target: Target, ctx?: AliasCtx): { expr: string; params: unknown[] } {
  return scalarValue(parseFilter(source), target, ctx);
}
