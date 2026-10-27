// The commit message of a git history commit (spec/store §5.12 "Trailers"):
// a SUBJECT line, a blank line, then the trailers — `token: value` lines the
// reader parses back (never through `git interpret-trailers`: both engines
// parse the same text the same way). The trailers carry what replay and the
// reader need: the feed position (`omgbase-seq`), the exact instant
// (`omgbase-ts`), the feed row(s) folded (`omgbase-commit`), the provenance
// (`omgbase-origin`, `omgbase-actor`, `omgbase-plan`), one `omgbase-doc` per
// touched document (`<doc_id> <path> <head>`, a deleted document's head `-`)
// and, on a rescan, `omgbase-rescan: <epoch>:<head>`. Since 17.6 (Phase 6b) a
// merge commit carries `omgbase-merge: <remote tip>` and a commit of the ids
// ref `omgbase-content: <content commit sha>` (the content commit it records
// the identities of).

export interface DocTrailer {
  docId: string;
  /** the storage path (no leading slash) as of the commit */
  path: string;
  /** the head token minted, or null for a deleted document (`-` on the wire) */
  head: string | null;
}

export interface CommitTrailers {
  epoch: string;
  /** the feed seq this commit covers — `from === to` for a single row */
  from: number;
  to: number;
  ts: string;
  commits: string[];
  origin: string | null;
  actor: string | null;
  plan: string | null;
  docs: DocTrailer[];
  /** `omgbase-rescan: <epoch>:<head>` — the commit is a full snapshot */
  rescan: { epoch: string; head: number } | null;
  /** `omgbase-merge: <remote tip>` (17.6) — the commit merged the remote's tip */
  merge: string | null;
  /** `omgbase-content: <sha>` (17.6) — on the ids ref: the content commit this ids commit belongs to */
  content: string | null;
}

export const TRAILER_PREFIX = "omgbase-";

/** `<epoch>:<seq>` or `<epoch>:<from>-<to>`. */
export function seqValue(epoch: string, from: number, to: number): string {
  return from === to ? `${epoch}:${from}` : `${epoch}:${from}-${to}`;
}

function parseSeq(v: string): { epoch: string; from: number; to: number } | null {
  const m = /^(\S+):(\d+)(?:-(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const from = Number(m[2]);
  return { epoch: m[1]!, from, to: m[3] !== undefined ? Number(m[3]) : from };
}

/** Render the message: subject, blank line, trailers in the pinned order, a final newline. */
export function renderMessage(subject: string, t: CommitTrailers): string {
  const lines: string[] = [];
  lines.push(`omgbase-seq: ${seqValue(t.epoch, t.from, t.to)}`);
  lines.push(`omgbase-ts: ${t.ts}`);
  for (const c of t.commits) lines.push(`omgbase-commit: ${c}`);
  if (t.origin !== null) lines.push(`omgbase-origin: ${t.origin}`);
  if (t.actor !== null) lines.push(`omgbase-actor: ${t.actor}`);
  if (t.plan !== null) lines.push(`omgbase-plan: ${t.plan}`);
  if (t.rescan !== null) lines.push(`omgbase-rescan: ${t.rescan.epoch}:${t.rescan.head}`);
  if (t.merge !== null) lines.push(`omgbase-merge: ${t.merge}`);
  if (t.content !== null) lines.push(`omgbase-content: ${t.content}`);
  for (const d of t.docs) lines.push(`omgbase-doc: ${d.docId} ${d.path} ${d.head ?? "-"}`);
  // A subject never holds a newline (the feed's `reason` may: it is flattened).
  const subjectLine = subject.replace(/\s*\n\s*/g, " ").trim();
  return `${subjectLine}\n\n${lines.join("\n")}\n`;
}

/** The subject line (the first line) of a message. */
export function subjectOf(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

/**
 * Parse a message's trailers. Every `omgbase-*: value` line after the subject
 * is read (other lines are ignored); a message without `omgbase-seq` is not one
 * of ours → null.
 */
export function parseMessage(message: string): CommitTrailers | null {
  const lines = message.split("\n");
  let seq: ReturnType<typeof parseSeq> = null;
  let ts: string | null = null;
  const commits: string[] = [];
  let origin: string | null = null;
  let actor: string | null = null;
  let plan: string | null = null;
  const docs: DocTrailer[] = [];
  let rescan: CommitTrailers["rescan"] = null;
  let merge: string | null = null;
  let content: string | null = null;
  for (const line of lines.slice(1)) {
    const m = /^omgbase-([a-z]+): (.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m as unknown as [string, string, string];
    switch (key) {
      case "seq": seq = parseSeq(value); break;
      case "ts": ts = value.trim(); break;
      case "commit": commits.push(value.trim()); break;
      case "origin": origin = value.trim(); break;
      case "actor": actor = value.trim(); break;
      case "plan": plan = value.trim(); break;
      case "rescan": { const r = parseSeq(value); if (r) rescan = { epoch: r.epoch, head: r.to }; break; }
      case "merge": merge = value.trim(); break;
      case "content": content = value.trim(); break;
      case "doc": {
        // `<doc_id> <path> <head>`: the id is the first token, the head the last; the path is everything between (it may hold spaces).
        const first = value.indexOf(" ");
        const last = value.lastIndexOf(" ");
        if (first < 0 || last <= first) break;
        const head = value.slice(last + 1).trim();
        docs.push({ docId: value.slice(0, first), path: value.slice(first + 1, last), head: head === "-" ? null : head });
        break;
      }
      default: break;
    }
  }
  if (!seq) return null;
  return { epoch: seq.epoch, from: seq.from, to: seq.to, ts: ts ?? "", commits, origin, actor, plan, docs, rescan, merge, content };
}
