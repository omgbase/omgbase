// Myers' shortest edit script over two string arrays — the ONE diff algorithm
// both engines share, so an edit script is deterministic across them. Two
// consumers: the unified diff of `docs_diff_unified` (spec/surface §3;
// `graph/history.ts` re-exports it, and `crates/omgbase-surface/src/history.rs`
// is the twin) and the delta tree nodes of spec/store §4.1 (16.0;
// `core/store/delta.ts`), whose ops are this script grouped. Kept in `core/`
// because the store cannot import `graph/`.

/** One step of the edit script: `keep` consumes a line from both sides,
 * `delete` one from the old text, `insert` one from the new text. */
export interface EditOp {
  kind: "keep" | "delete" | "insert";
  line: string;
}

/**
 * Myers' O(ND) shortest edit script (forward, with a per-`d` trace for the
 * backtrack). `V[k]` is the furthest x on diagonal `k = x - y` reachable with
 * `d` edits. The canonical tie rule, identical in both engines: at each step
 * take the diagonal from `k+1` (moving down — an insertion of `b[y]`) when
 * `k == -d || (k != d && V[k-1] < V[k+1])`, else from `k-1` (moving right —
 * a deletion of `a[x]`). On a tie (`V[k-1] == V[k+1]`) that is the deletion.
 */
export function myersScript(a: string[], b: string[]): EditOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  // V is indexed by k ∈ [-max-1, max+1]; `off` maps it onto a plain array.
  const off = max + 1;
  const v = new Array<number>(2 * max + 3).fill(0);
  const trace: number[][] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
      else x = v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // Backtrack from (n, m) through the trace, emitting ops newest-first.
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1]! < vd[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "keep", line: a[x]! });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "insert", line: b[prevY]! });
      else ops.push({ kind: "delete", line: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  return ops;
}
