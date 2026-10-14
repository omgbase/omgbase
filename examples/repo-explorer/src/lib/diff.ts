// A line diff in the browser, so history needs no `docs_diff_unified` (which the
// minimal profile does not serve): `docs_read { at }` gives both revisions'
// bytes and this computes the unified diff between them. It follows
// spec/surface §3's rule for `docs_diff_unified` so its output is the same text
// a full server would return: lines are `text.split("\n")` exactly (an empty
// text has NO lines), the shortest edit script by Myers' O(ND) algorithm with
// the canonical tie rule (at each step take the diagonal from k+1 — an
// insertion — when k == -d, or when k != d and V[k-1] < V[k+1]; else from k-1 —
// a deletion; so on a tie the script prefers the deletion), hunks with 3 lines
// of context (two changes whose contexts touch or overlap share a hunk), each
// `@@ -a,b +c,d @@` (1-based start and length; a length of 1 written as the
// start alone; 0 lines as `a,0` with `a` the line before the insertion point),
// lines prefixed `-`, `+` or a space, hunks joined by `\n`, no file header,
// identical texts → "".

export type EditKind = "ctx" | "del" | "add";

export interface EditLine { kind: EditKind; text: string }

/** `text.split("\n")` exactly; an empty text has no lines. */
export function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/** The shortest edit script (Myers, the spec's tie rule) as one sequence of lines. */
export function editScript(a: readonly string[], b: readonly string[]): EditLine[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  // V[k] indexed by k + max; one copy per d for the backtrack.
  const offset = max;
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 2);
  v[offset + 1] = 0;
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    const snapshot = Int32Array.from(v);
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      const down = k === -d || (k !== d && snapshot[offset + k - 1]! < snapshot[offset + k + 1]!);
      x = down ? snapshot[offset + k + 1]! : snapshot[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
    v = Int32Array.from(v);
  }
  // Backtrack from (n, m) through the snapshots.
  const out: EditLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && snapshot[offset + k - 1]! < snapshot[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = snapshot[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push({ kind: "ctx", text: a[x - 1]! }); x--; y--; }
    if (d > 0) {
      if (down) { out.push({ kind: "add", text: b[y - 1]! }); y--; }
      else { out.push({ kind: "del", text: a[x - 1]! }); x--; }
    }
  }
  return out.reverse();
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: EditLine[];
}

/** Group an edit script into hunks with `context` lines around each change. */
export function hunksOf(script: readonly EditLine[], context = 3): Hunk[] {
  const hunks: Hunk[] = [];
  const changed = script.map((l) => l.kind !== "ctx");
  let i = 0;
  let oldLine = 0;
  let newLine = 0;
  while (i < script.length) {
    if (!changed[i]) {
      oldLine++;
      newLine++;
      i++;
      continue;
    }
    // A change: the hunk starts `context` lines before it.
    const start = Math.max(0, i - context);
    let end = i;
    // Extend over changes whose contexts touch or overlap.
    let last = i;
    while (end < script.length) {
      if (changed[end]) { last = end; end++; continue; }
      // ctx run: does another change begin within 2*context lines?
      let j = end;
      while (j < script.length && !changed[j] && j - last - 1 < 2 * context) j++;
      if (j < script.length && changed[j]) { end = j; continue; }
      break;
    }
    end = Math.min(script.length, last + 1 + context);
    // Line numbers at `start`: count back the ctx/del and ctx/add lines between start and i.
    let oStart = oldLine;
    let nStart = newLine;
    for (let k = i - 1; k >= start; k--) {
      const l = script[k]!;
      if (l.kind !== "add") oStart--;
      if (l.kind !== "del") nStart--;
    }
    const lines = script.slice(start, end);
    const oldCount = lines.filter((l) => l.kind !== "add").length;
    const newCount = lines.filter((l) => l.kind !== "del").length;
    hunks.push({ oldStart: oStart, oldCount, newStart: nStart, newCount, lines });
    for (let k = i; k < end; k++) {
      const l = script[k]!;
      if (l.kind !== "add") oldLine++;
      if (l.kind !== "del") newLine++;
    }
    i = end;
  }
  return hunks;
}

function range(start0: number, count: number): string {
  // 1-based start; a count of 0 names the line before the insertion point.
  if (count === 0) return `${start0},0`;
  const start = start0 + 1;
  return count === 1 ? `${start}` : `${start},${count}`;
}

export function formatHunk(h: Hunk): string {
  const head = `@@ -${range(h.oldStart, h.oldCount)} +${range(h.newStart, h.newCount)} @@`;
  const body = h.lines.map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text);
  return [head, ...body].join("\n");
}

/** The unified diff of two texts (identical texts → ""). */
export function unifiedDiff(before: string, after: string, context = 3): string {
  if (before === after) return "";
  return hunksOf(editScript(splitLines(before), splitLines(after)), context).map(formatHunk).join("\n");
}

export type DiffLineKind = "hunk" | "add" | "del" | "ctx";

/** Classify a unified-diff line by its first character (no file header is ever present). */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

export interface Stats { added: number; removed: number }

/** `+n −m` over an edit script. */
export function diffStats(script: readonly EditLine[]): Stats {
  let added = 0;
  let removed = 0;
  for (const l of script) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}

export function formatStats(s: Stats): string {
  return `+${s.added} −${s.removed}`;
}
