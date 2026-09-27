// Apply a plan to the tree: bump manifest versions, rewrite inter-crate pins,
// prepend changelog sections, delete the consumed notes. Pure file edits; the
// git side lives in release.mjs.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { labelOf } from "./workspace.mjs";

/** package.json: rewrite the top-level "version" in place (formatting preserved). */
export function bumpPackageJson(text, next) {
  const re = /^(\s*"version"\s*:\s*)"[^"]*"/m;
  if (!re.test(text)) throw new Error('package.json has no "version" line');
  return text.replace(re, `$1"${next}"`);
}

/** Cargo.toml: rewrite `version = "…"` inside [package]. */
export function bumpCargoToml(text, next) {
  const lines = text.split("\n");
  let section = null;
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(lines[i]);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section === "package" && /^\s*version\s*=\s*"/.test(lines[i])) {
      lines[i] = lines[i].replace(/^(\s*version\s*=\s*)"[^"]*"/, `$1"${next}"`);
      return lines.join("\n");
    }
  }
  throw new Error("Cargo.toml has no [package] version");
}

/**
 * Cargo.toml: rewrite the `version = "…"` pin of every inline-table dependency
 * whose path resolves to a crate in `versions` (dir name → new version).
 * `dirVersions` maps the dependency's `path` basename to its next version.
 */
export function rewriteCargoPins(text, dirVersions) {
  const lines = text.split("\n");
  const changed = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*[A-Za-z0-9_-]+\s*=\s*\{)(.*)(\}\s*)$/.exec(lines[i]);
    if (!m) continue;
    const body = m[2];
    const path = /\bpath\s*=\s*"([^"]*)"/.exec(body);
    if (!path) continue;
    const dir = path[1].split("/").filter(Boolean).at(-1);
    const next = dirVersions[dir];
    if (!next) continue;
    const pin = /(\bversion\s*=\s*)"([^"]*)"/.exec(body);
    if (!pin || pin[2] === next) continue;
    lines[i] = m[1] + body.replace(pin[0], `${pin[1]}"${next}"`) + m[3];
    changed.push({ line: i, from: pin[2], to: next });
  }
  return { text: lines.join("\n"), changed };
}

export function changelogHeader(name) {
  return (
    `# Changelog\n\nAll notable changes to \`${name}\` are recorded here. The format follows\n` +
    `[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow\n` +
    `[Semantic Versioning](https://semver.org/) (pre-1.0: a minor bump may break).\n`
  );
}

const GROUPS = [
  ["major", "### Major"],
  ["minor", "### Minor"],
  ["patch", "### Patch"],
  ["none", "### Notes"],
];

/** A note body as a list item: bullets stay bullets; prose becomes one bullet with continuation lines indented. */
export function bodyAsBullet(body) {
  const lines = body.trim().split("\n");
  const isList = lines.every((l) => l.trim() === "" || /^\s*([-*+]|\d+\.)\s/.test(l));
  if (isList) return lines.join("\n");
  return lines.map((l, i) => (i === 0 ? `- ${l}` : l.trim() === "" ? "" : `  ${l}`)).join("\n");
}

/**
 * Render one `## [version] - date` section. `items` are
 * `{ level, body }` (level is the note's level for this package).
 */
export function renderChangelogSection(version, date, items) {
  const out = [`## [${version}] - ${date}`, ""];
  for (const [level, heading] of GROUPS) {
    const group = items.filter((i) => i.level === level);
    if (!group.length) continue;
    out.push(heading);
    for (const item of group) out.push(bodyAsBullet(item.body));
    out.push("");
  }
  return out.join("\n");
}

/** Insert `section` before the first `## ` heading of an existing changelog (or at its end). */
export function prependChangelogSection(existing, section) {
  const idx = existing.search(/^## /m);
  if (idx < 0) return existing.replace(/\s*$/, "\n\n") + section;
  return existing.slice(0, idx) + section + "\n" + existing.slice(idx);
}

export function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Apply the plan to the working tree. Returns `{ touched: [paths], removed: [paths], summary: [string] }`
 * (paths repo-relative). Nothing is written when `dryRun`.
 */
export function applyPlan(ws, plan, notes, { date = today(), dryRun = false } = {}) {
  const touched = new Set();
  const removed = [];
  const summary = [];
  const write = (file, text) => {
    if (!dryRun) writeFileSync(file, text);
    touched.add(relative(ws.root, file));
  };
  const bumps = plan.entries.filter((e) => e.next !== e.current);
  if (!bumps.length) return { touched: [], removed: [], summary: ["nothing to version"] };

  // manifests
  for (const e of bumps) {
    const p = ws.byKey.get(e.key);
    const text = readFileSync(p.manifest, "utf8");
    write(p.manifest, e.kind === "npm" ? bumpPackageJson(text, e.next) : bumpCargoToml(text, e.next));
    summary.push(`${labelOf(e.key, ws)}: ${e.current} → ${e.next}`);
  }

  // inter-crate pins
  const dirVersions = {};
  for (const e of bumps) if (e.kind === "crate") dirVersions[ws.byKey.get(e.key).dirName] = e.next;
  if (Object.keys(dirVersions).length) {
    for (const c of ws.crates) {
      const current = readFileSync(c.manifest, "utf8");
      const { text, changed } = rewriteCargoPins(current, dirVersions);
      if (changed.length) {
        write(c.manifest, text);
        summary.push(`${c.name}: ${changed.length} pin${changed.length > 1 ? "s" : ""} rewritten`);
      }
    }
  }

  // changelogs
  for (const e of bumps) {
    const p = ws.byKey.get(e.key);
    const items = [];
    for (const note of notes) {
      const bump = note.bumps.find((b) => b.key === e.key);
      if (bump) items.push({ level: bump.level, body: note.body });
    }
    if (e.pin) {
      const pins = ws.byKey.get(e.key).pins
        .filter((pin) => !pin.dev && dirVersions[ws.byKey.get(pin.key)?.dirName] && dirVersions[ws.byKey.get(pin.key).dirName] !== pin.version)
        .map((pin) => `${ws.byKey.get(pin.key).name} ${pin.version} → ${dirVersions[ws.byKey.get(pin.key).dirName]}`);
      items.push({ level: "patch", body: `Dependency pins moved: ${pins.join(", ")}.` });
    }
    const section = renderChangelogSection(e.next, date, items);
    const file = join(p.dir, "CHANGELOG.md");
    const existing = existsSync(file) ? readFileSync(file, "utf8") : changelogHeader(p.name);
    write(file, prependChangelogSection(existing, section));
  }

  // consumed notes: every note that names at least one bumped package (its body is now in
  // that package's changelog). A note whose packages all stay put — only `none` levels —
  // remains pending, so it lands under "### Notes" the next time one of them ships.
  const bumpedKeys = new Set(bumps.map((e) => e.key));
  for (const note of notes) {
    if (!note.bumps.some((b) => bumpedKeys.has(b.key))) continue;
    if (!dryRun) unlinkSync(note.file);
    removed.push(relative(ws.root, note.file));
  }
  return { touched: [...touched], removed, summary };
}
