// Which commit `release check` diffs against when no `--base` is given.
//
// The question the check answers is "does every change that a release would
// ship have a pending note?", so the base is the newest of:
//   - where this branch leaves origin/main (the unpushed work), or, when
//     there is no unpushed work, HEAD itself if the working tree is dirty
//     (the change about to be committed) and HEAD~1 otherwise (the commit
//     just made or just pushed);
//   - the last `release: …` commit, which consumed every note before it —
//     diffing across it would demand notes for the release's own bumps.

import { spawnSync } from "node:child_process";

/** `git` runner bound to a directory; returns { status, stdout }. */
export function gitIn(cwd) {
  return (args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "" };
  };
}

/** @returns {{ base: string, label: string, why: string }} */
export function defaultCheckBase(git) {
  const rev = (ref) => {
    const r = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const head = rev("HEAD");
  const mbRun = git(["merge-base", "HEAD", "origin/main"]);
  const mb = mbRun.status === 0 ? mbRun.stdout.trim() : null;

  let base, label, why;
  if (mb && mb !== head) {
    [base, label, why] = [mb, "origin/main", "unpushed commits + working tree"];
  } else {
    const dirty = git(["status", "--porcelain"]).stdout.trim() !== "";
    const parent = rev("HEAD~1");
    if (dirty || !parent) [base, label, why] = [head, "HEAD", "working tree"];
    else [base, label, why] = [parent, "HEAD~1", "the last commit"];
  }

  // Never look past the newest release commit in base..HEAD.
  const log = git(["log", "--format=%H%x00%s", `${base}..HEAD`]).stdout.split("\n");
  const release = log.map((l) => l.split("\0")).find(([, subject]) => subject?.startsWith("release: "));
  if (release) [base, label, why] = [release[0], release[0].slice(0, 8), `since the last release commit`];

  return { base, label, why };
}
