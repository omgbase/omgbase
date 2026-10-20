// End-state checks, run through the same MCP server after the loop ends (the
// server has already re-ingested anything the hook wrote to disk). Every check
// returns a list of failure strings; empty = passed.
import { isDeepStrictEqual } from "node:util";
import type { OmgServer } from "./mcp.ts";
import type { Check, Task } from "./types.ts";
import { fixtureBytes } from "./workspace.ts";

export interface CheckContext {
  server: OmgServer;
  /** the model's final assistant text */
  finalText: string;
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

export async function runCheck(check: Check, ctx: CheckContext): Promise<string[]> {
  const { server } = ctx;
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
      const raw = await readRaw(server, check.path);
      if (raw === null) return [`${check.path}: not readable (missing?)`];
      if (raw !== fixtureBytes(check.path)) failures.push(`${check.path}: bytes differ from the fixture`);
      const r = await server.call("changes_since", { origin: "api", limit: 500 });
      if (!r.ok) return [...failures, `changes_since failed: ${describe(r.result)}`];
      // A digest's `revisions` are rows: `{ _id, _path, _hash }` (spec/sync 3.0).
      const digests = (r.result as { digests: { commit: string; revisions: { _path: string }[] }[] }).digests;
      const touched = digests.filter((d) => d.revisions.some((rev) => rev._path === check.path));
      if (touched.length > 0) failures.push(`${check.path}: ${touched.length} api commit(s) touched it (${touched.map((d) => d.commit).join(", ")})`);
      return failures;
    }
    case "final_text": {
      if (!new RegExp(check.matches, "is").test(ctx.finalText)) failures.push(`final text does not match /${check.matches}/: ${describe(ctx.finalText)}`);
      return failures;
    }
  }
}

/** Every check of the task; the failures of all of them. */
export async function runChecks(task: Task, ctx: CheckContext): Promise<string[]> {
  const failures: string[] = [];
  for (const c of task.checks) failures.push(...(await runCheck(c, ctx)));
  return failures;
}
