// AST for the CEL subset (10-query-language §3.1).

export type Node =
  | Or
  | And
  | Not
  | Comparison
  | Membership
  | OuterMembership
  | Call
  | MethodCall
  | Quantifier
  | FieldRef
  | OuterRef
  | Literal;

export interface Or { kind: "or"; left: Node; right: Node }
export interface And { kind: "and"; left: Node; right: Node }
export interface Not { kind: "not"; operand: Node }

export type RelOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
export interface Comparison { kind: "comparison"; op: RelOp; left: Node; right: Node }

/** literal in list(field) */
export interface Membership { kind: "membership"; value: Literal; field: FieldRef }

/** value in ^name — membership over a one-scope-outward collection binding (a
 * lift). `value` is the current scope's operand (a field/value/literal); the
 * collection is resolved from the enclosing scope. */
export interface OuterMembership { kind: "outerMembership"; value: Node; collection: OuterRef }

/** ^name — a reference to a binding one query scope outward (OQX correlation).
 * Resolved by the compiler against the AliasCtx's outer-binding resolver. */
export interface OuterRef { kind: "outerref"; name: string }

/** free-standing call: ident(args) — e.g. under("x"), has(field), size(x) */
export interface Call { kind: "call"; name: string; args: Node[] }

/** method call: receiver.name(args) — e.g. x.contains("s") */
export interface MethodCall { kind: "method"; receiver: Node; name: string; args: Node[] }

/** collection.exists(v, pred) / .all(v, pred) over list() or graph predicates */
export interface Quantifier {
  kind: "quantifier";
  collection: Node;
  op: "exists" | "all";
  varName: string;
  predicate: Node;
}

/** dotted field path; `$` set when intrinsic ($id, $path, doc.$path handled by segments) */
export interface FieldRef { kind: "field"; segments: string[]; intrinsic: boolean }

export interface Literal { kind: "literal"; value: string | number | boolean | null; type: "string" | "int" | "double" | "bool" | "null" }
