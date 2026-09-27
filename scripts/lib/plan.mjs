// The release plan: fold the pending notes into one level per package, compute
// the next versions, enforce the spec-tracking rule, auto-patch crates whose
// pins move, and order the publish sequence.
import { LEVELS, SPEC_TRACKED, labelOf, topoSort } from "./workspace.mjs";

/** The higher of two levels (`major > minor > patch > none`). */
export function foldLevel(a, b) {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`unsupported version \`${v}\` (the release tool handles plain major.minor.patch)`);
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

export function bumpVersion(v, level) {
  const { major, minor, patch } = parseVersion(v);
  switch (level) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "none":
      return v;
    default:
      throw new Error(`unknown level ${level}`);
  }
}

export const majorMinor = (v) => v.split(".").slice(0, 2).join(".");

/** Compare two "major.minor" strings numerically. */
export function compareMajorMinor(a, b) {
  const [am, an] = a.split(".").map(Number);
  const [bm, bn] = b.split(".").map(Number);
  return am - bm || an - bn;
}

/**
 * Compute the plan.
 *
 *   ws:    loadWorkspace() result (root, npm, crates, all, byKey, specs)
 *   notes: parsed notes ({ slug, bumps: [{ key, level }] })
 *
 * Returns `{ entries, errors, warnings, sequence }`. `entries` has one row per
 * workspace package: `{ key, kind, name, current, next, level, notes, pin }`;
 * `sequence` lists the bumped entries in publish order (crates, then npm).
 */
export function computePlan(ws, notes) {
  const errors = [];
  const warnings = [];
  const entries = new Map();
  for (const p of ws.all) {
    entries.set(p.key, { key: p.key, kind: p.kind, name: p.name, current: p.version, next: p.version, level: null, notes: [], pin: false });
  }

  // 1. fold levels
  for (const note of notes) {
    for (const { key, level } of note.bumps) {
      const e = entries.get(key);
      if (!e) continue;
      e.notes.push(note.slug);
      e.level = e.level ? foldLevel(e.level, level) : level;
    }
  }

  // 2. pins: a dependent crate whose pinned dependency moves needs at least a patch
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of ws.crates) {
      const e = entries.get(c.key);
      if (e.level && e.level !== "none") continue;
      const moved = c.pins.filter((pin) => !pin.dev && ["patch", "minor", "major"].includes(entries.get(pin.key)?.level));
      if (moved.length) {
        e.level = "patch";
        e.pin = true;
        changed = true;
      }
    }
  }

  // 3. next versions
  for (const e of entries.values()) {
    try {
      e.next = e.level ? bumpVersion(e.current, e.level) : e.current;
    } catch (err) {
      errors.push(`${labelOf(e.key, ws)}: ${err.message}`);
    }
  }

  // 4. spec-tracking rule
  for (const [key, specDir] of Object.entries(SPEC_TRACKED)) {
    const e = entries.get(key);
    const spec = ws.specs[key];
    if (!e || !spec) continue;
    const label = labelOf(key, ws);
    const cur = majorMinor(e.current);
    const bumped = e.level === "minor" || e.level === "major";
    if (bumped) {
      const next = majorMinor(e.next);
      if (compareMajorMinor(next, spec) !== 0) {
        const hint = compareMajorMinor(spec, cur) > 0 ? `use ${spec.split(".")[0] !== cur.split(".")[0] ? "major" : "minor"}` : "bump the spec or use patch";
        errors.push(`${label}: a ${e.level} needs spec/${specDir}/VERSION ${next} (it is ${spec}) — ${hint}`);
      }
      continue;
    }
    const cmp = compareMajorMinor(spec, cur);
    if (cmp > 0) {
      const need = spec.split(".")[0] !== cur.split(".")[0] ? "major" : "minor";
      const section = e.kind === "npm" ? "npm" : "crates";
      const name = e.kind === "npm" ? `"${e.name}"` : e.name;
      errors.push(
        `${label}: spec/${specDir}/VERSION is ${spec} but ${label} is ${e.current} and no note bumps it${e.level === "patch" ? " past a patch" : ""} — add a changes/<slug>.md with \`${section}:\n  ${name}: ${need}\``,
      );
    } else if (cmp < 0) {
      warnings.push(`${label}: ${e.current} is ahead of spec/${specDir}/VERSION ${spec} — the spec should have moved with it`);
    }
  }

  // 5. sequence: crates by cargo dependency order, then npm by workspace deps
  const isBump = (e) => e.level && e.level !== "none" && e.next !== e.current;
  const crateOrder = topoSort(ws.crates).map((c) => entries.get(c.key)).filter(isBump);
  const npmOrder = topoSort(ws.npm).map((p) => entries.get(p.key)).filter(isBump);
  return { entries: [...entries.values()], errors, warnings, sequence: [...crateOrder, ...npmOrder], crateOrder, npmOrder };
}

/** Render the plan table: `package  current → next  level  notes`. */
export function renderPlan(plan, ws, registry) {
  const rows = plan.entries.map((e) => {
    const label = labelOf(e.key, ws);
    const version = e.next !== e.current ? `${e.current} → ${e.next}` : e.current;
    const level = e.level ?? "";
    const notes = e.pin ? [...e.notes, "(pin)"].join(", ") : e.notes.join(", ");
    let status = "";
    if (registry) {
      const r = registry.get(e.key);
      if (!r) status = "";
      else if (r.error) status = `registry: ${r.error}`;
      else if (r.versions.length === 0) status = "registry: never published";
      else if (r.versions.includes(e.current)) status = "current";
      else status = `unpublished (registry has ${r.versions.at(-1)})`;
    }
    return [label, version, level, notes, status];
  });
  const headers = ["package", "version", "level", "notes", registry ? "registry" : ""];
  const width = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(width[i])).join("  ").trimEnd();
  return [line(headers), line(width.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}
