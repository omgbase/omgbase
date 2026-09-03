// AST for the CEL subset (10-query-language §3.1).

export type Node =
  | Or
  | And
  | Not
  | Comparison
  | Membership
  | Call
  | MethodCall
  | Quantifier
  | FieldRef
  | Literal;

export interface Or { kind: "or"; left: Node; right: Node }
export interface And { kind: "and"; left: Node; right: Node }
export interface Not { kind: "not"; operand: Node }

export type RelOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
export interface Comparison { kind: "comparison"; op: RelOp; left: Node; right: Node }

/** literal in list(field) */
export interface Membership { kind: "membership"; value: Literal; field: FieldRef }

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
