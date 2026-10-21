// End-state checks, run through an omg MCP server after the loop ends — under an
// omgbase profile the run's own server (it has already re-ingested anything the
// hook wrote to disk); under `fs` a `full` server spawned after `omg sync` has
// observed the agent's disk writes (src/bench.ts). The oracle is the same for every
// profile. Every check returns a list of failure strings; empty = passed.
import { isDeepStrictEqual } from "node:util";
import type { OmgServer } from "./mcp.ts";
import { answerRegex } from "./tasks.ts";
import type { AnswerCheck, Check, Task } from "./types.ts";
import { DEFAULT_CORPUS, fixtureBytes, vaultDiff, type Workspace } from "./workspace.ts";

export interface CheckContext {
  server: OmgServer;
  /** the model's final assistant text */
  finalText: string;
  /** the run's workspace — names the corpus the `unchanged` checks compare against and the vault `unchanged_all` walks (alchemy when absent) */
  workspace?: Workspace;
}

function describe(v: unknown, max = 300): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** `docs_read { _path }` → `_raw` (spec/surface 5.0: a row attribute is `_`-prefixed in the argument and the result alike). */
async function readRaw(server: OmgServer, path: string): Promise<string | null> {
  const r = await server.call("docs_read", { _path: path });
  if (!r.ok) return null;
  return (r.result as { _raw: string })._raw;
}

/** The `api`-origin commits, each with the paths it touched (`changes_since`; a digest's `revisions` are rows `{ _id, _path, _hash }`, spec/sync 3.0). */
async function apiCommits(server: OmgServer): Promise<{ commit: string; paths: string[] }[] | string> {
  const r = await server.call("changes_since", { origin: "api", limit: 500 });
  if (!r.ok) return `changes_since failed: ${describe(r.result)}`;
  const digests = (r.result as { digests: { commit: string; revisions: { _path: string }[] }[] }).digests;
  return digests.map((d) => ({ commit: d.commit, paths: d.revisions.map((rev) => rev._path) }));
}

/** Does the text mention the entry — as a case-insensitive substring, or by the `/…/` regex? */
export function mentions(text: string, entry: string): boolean {
  const re = answerRegex(entry);
  return re ? re.test(text) : text.toLowerCase().includes(entry.toLowerCase());
}

/** The `answer` check over a final text (pure; exported for the tests). */
export function checkAnswer(check: AnswerCheck, finalText: string): string[] {
  const failures: string[] = [];
  for (const e of check.must_mention) if (!mentions(finalText, e)) failures.push(`answer does not mention ${JSON.stringify(e)}`);
  for (const e of check.must_not_mention ?? []) if (mentions(finalText, e)) failures.push(`answer mentions the decoy ${JSON.stringify(e)}`);
  if (check.count) {
    const n = (finalText.match(new RegExp(check.count.pattern, "gis")) ?? []).length;
    if (n !== check.count.equals) failures.push(`answer matches /${check.count.pattern}/ ${n} time(s) ≠ ${check.count.equals}`);
  }
  if (failures.length > 0) failures.push(`answer was: ${describe(finalText)}`);
  return failures;
}

export async function runCheck(check: Check, ctx: CheckContext): Promise<string[]> {
  const { server } = ctx;
  const corpus = ctx.workspace?.corpus ?? DEFAULT_CORPUS;
  const failures: string[] = [];
  switch (check.kind) {
    case "query": {
      const r = await server.call("query", { query: check.query, limit: 500 });
      if (!r.ok) return [`query failed: ${describe(r.result)}`];
      const v = r.result as { hits: Record<string, unknown>[]; count?: number };
      if (check.count !== undefined && v.count !== check.count) failures.push(`count ${v.count} ≠ ${check.count} for ${check.query}`);
      if (check.hits) {
        if (v.hits.length !== check.hits.length) {
          failures.push(`${v.hits.length} hit(s) ≠ ${check.hits.length} for ${check.query}: ${describe(v.hits)}`);
        } else {
          check.hits.forEach((want, i) => {
            const got = v.hits[i]!;
            for (const [k, val] of Object.entries(want)) {
              if (!isDeepStrictEqual(got[k], val)) failures.push(`hit ${i}.${k} = ${describe(got[k])} ≠ ${describe(val)} for ${check.query}`);
            }
          });
        }
      }
      return failures;
    }
    case "read": {
      const raw = await readRaw(server, check.path);
      if (raw === null) return [`${check.path}: not readable (missing?)`];
      if (check.equals !== undefined && raw !== check.equals) failures.push(`${check.path}: bytes differ from the expected content`);
      for (const re of check.matches ?? []) if (!new RegExp(re, "s").test(raw)) failures.push(`${check.path}: does not match /${re}/`);
      for (const re of check.not_matches ?? []) if (new RegExp(re, "s").test(raw)) failures.push(`${check.path}: matches /${re}/ but must not`);
      return failures;
    }
    case "unchanged": {
      // Bytes first; then no `api`-origin commit. Under `fs` the second half is vacuous
      // (the sweep's commits are observed, never api) and the bytes carry the check.
      const raw = await readRaw(server, check.path);
      if (raw === null) return [`${check.path}: not readable (missing?)`];
      if (raw !== fixtureBytes(check.path, corpus)) failures.push(`${check.path}: bytes differ from the fixture`);
      const commits = await apiCommits(server);
      if (typeof commits === "string") return [...failures, commits];
      const touched = commits.filter((c) => c.paths.includes(check.path));
      if (touched.length > 0) failures.push(`${check.path}: ${touched.length} api commit(s) touched it (${touched.map((c) => c.commit).join(", ")})`);
      return failures;
    }
    case "final_text": {
      if (!new RegExp(check.matches, "is").test(ctx.finalText)) failures.push(`final text does not match /${check.matches}/: ${describe(ctx.finalText)}`);
      return failures;
    }
    case "answer":
      return checkAnswer(check, ctx.finalText);
  }
}

/**
 * `unchanged_all`: the vault equals the corpus file for file (nothing added, removed
 * or edited — compared on disk, so it holds under every profile) and no `api`-origin
 * commit exists anywhere (vacuous under `fs`, where the bytes carry it).
 */
export async function checkUnchangedAll(ctx: CheckContext): Promise<string[]> {
  if (!ctx.workspace) return ["unchanged_all needs the run's workspace"];
  const failures: string[] = [];
  const diff = vaultDiff(ctx.workspace);
  if (diff.length > 0) failures.push(`the vault differs from the ${ctx.workspace.corpus} corpus in ${diff.length} file(s): ${diff.slice(0, 5).join(", ")}${diff.length > 5 ? ", …" : ""}`);
  const commits = await apiCommits(ctx.server);
  if (typeof commits === "string") return [...failures, commits];
  if (commits.length > 0) failures.push(`${commits.length} api commit(s) were made (${commits.map((c) => c.commit).join(", ")}) touching ${[...new Set(commits.flatMap((c) => c.paths))].join(", ")}`);
  return failures;
}

/** Every check of the task (and `unchanged_all` when set); the failures of all of them. */
export async function runChecks(task: Task, ctx: CheckContext): Promise<string[]> {
  const failures: string[] = [];
  for (const c of task.checks) failures.push(...(await runCheck(c, ctx)));
  if (task.unchanged_all) failures.push(...(await checkUnchangedAll(ctx)));
  return failures;
}
