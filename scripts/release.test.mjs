// node --test scripts/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspace, topoSort, readCargoManifest, ownerOf } from "./lib/workspace.mjs";
import { parseFrontmatter, parseNote, loadNotes } from "./lib/notes.mjs";
import { foldLevel, bumpVersion, computePlan, renderPlan } from "./lib/plan.mjs";
import { bumpPackageJson, bumpCargoToml, rewriteCargoPins, renderChangelogSection, prependChangelogSection, bodyAsBullet, applyPlan, changelogHeader } from "./lib/apply.mjs";
import { parseNpmJson } from "./lib/registry.mjs";
import { otpRejected } from "./lib/publish.mjs";

// ---------------------------------------------------------------- fixture workspace

const cargo = (name, version, deps = {}, dev = {}) => {
  const dep = ([k, v]) => `${k} = { version = "${v}", path = "../${k}" }`;
  const devdep = ([k]) => `${k} = { path = "../${k}" }`;
  return (
    `[package]\nname = "${name}"\nversion = "${version}"\nedition = "2024"\n\n[dependencies]\nserde = "1"\n${Object.entries(deps).map(dep).join("\n")}\n\n[dev-dependencies]\n${Object.entries(dev).map(devdep).join("\n")}\n`
  );
};
const pkgJson = (name, version, deps = {}, extra = {}) =>
  JSON.stringify({ name, version, dependencies: Object.fromEntries(Object.keys(deps).map((d) => [d, "workspace:^"])), ...extra }, null, 2) + "\n";

/** A tiny monorepo: npm @t/oqx, @t/core (→oqx), omgbase (→core, dir cli); crates oqx, t-store, t-sync (→store), omgbase (→sync, store). */
function fixture({ specs = { oqx: "0.13", store: "13.5", sync: "1.2" }, notes = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-"));
  const w = (rel, text) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  w("packages/oqx/package.json", pkgJson("@omgbase/oqx", "0.13.0"));
  w("packages/core/package.json", pkgJson("@omgbase/core", "0.4.0", { "@omgbase/oqx": 1 }));
  w("packages/cli/package.json", pkgJson("omgbase", "0.4.0", { "@omgbase/core": 1 }));
  w("packages/client/package.json", pkgJson("@omgbase/client", "0.0.0", {}, { private: true }));
  w("crates/oqx/Cargo.toml", cargo("oqx", "0.13.0"));
  w("crates/omgbase-store/Cargo.toml", cargo("omgbase-store", "13.5.1"));
  w("crates/omgbase-sync/Cargo.toml", cargo("omgbase-sync", "1.2.0", { "omgbase-store": "13.5.1" }));
  w("crates/omgbase/Cargo.toml", cargo("omgbase", "0.5.0", { "omgbase-sync": "1.2.0", "omgbase-store": "13.5.1", oqx: "0.13.0" }, { "omgbase-store": 1 }));
  // a dev-dep cycle: store's tests use omgbase-sync (must not break the topo order)
  w("crates/omgbase-store/Cargo.toml", cargo("omgbase-store", "13.5.1", {}, { "omgbase-sync": 1 }));
  for (const [dir, v] of Object.entries(specs)) w(`spec/${dir}/VERSION`, `${v}\n`);
  w("changes/README.md", "# notes\n");
  for (const [slug, text] of Object.entries(notes)) w(`changes/${slug}.md`, text);
  return root;
}

const NOTE = (fm, body = "Something changed, and here is why.") => `---\n${fm}\n---\n${body}\n`;

// ---------------------------------------------------------------- frontmatter

test("parseFrontmatter: two sections, quoted keys, comments, inline empty section", () => {
  const { sections, body } = parseFrontmatter(
    `---\n# which packages\nnpm:\n  "@omgbase/core": minor\n  omgbase: patch  # the cli\ncrates: {}\n---\n\nBody line one.\n\n- and a bullet\n`,
  );
  assert.deepEqual(sections, { npm: { "@omgbase/core": "minor", omgbase: "patch" }, crates: {} });
  assert.equal(body, "Body line one.\n\n- and a bullet");
});

test("parseFrontmatter: rejects missing fence, unknown section, nesting, duplicates", () => {
  assert.throws(() => parseFrontmatter("npm:\n  a: b\n---\n"), /starts with a `---`/);
  assert.throws(() => parseFrontmatter("---\nnpm:\n  a: b\n"), /never closed/);
  assert.throws(() => parseFrontmatter("---\ncargo:\n  a: b\n---\nx"), /unknown section `cargo`/);
  assert.throws(() => parseFrontmatter("---\nnpm: minor\n---\nx"), /must be a section/);
  assert.throws(() => parseFrontmatter("---\n  a: b\n---\nx"), /outside a section/);
  assert.throws(() => parseFrontmatter("---\nnpm:\n  a: b\n  a: c\n---\nx"), /appears twice/);
  assert.throws(() => parseFrontmatter("---\nnpm:\n  a: b\nnpm:\n  c: d\n---\nx"), /section `npm` appears twice/);
  assert.throws(() => parseFrontmatter("---\nnpm:\n  garbage\n---\nx"), /cannot parse/);
});

test("parseNote: validates names, levels and body against the workspace", () => {
  const root = fixture();
  const ws = loadWorkspace(root);
  const ok = parseNote(NOTE('npm:\n  "@omgbase/core": minor\ncrates:\n  omgbase-store: patch\n  omgbase: none'), join(root, "changes/x.md"), ws);
  assert.deepEqual(ok.bumps, [
    { key: "npm:@omgbase/core", level: "minor" },
    { key: "crate:omgbase-store", level: "patch" },
    { key: "crate:omgbase", level: "none" },
  ]);
  assert.equal(ok.slug, "x");
  assert.throws(() => parseNote(NOTE("npm:\n  @omgbase/nope: minor"), "a.md", ws), /unknown npm package `@omgbase\/nope`/);
  assert.throws(() => parseNote(NOTE("crates:\n  omgbase-store: huge"), "a.md", ws), /unknown level `huge`/);
  assert.throws(() => parseNote(NOTE("crates:\n  omgbase-store: patch", ""), "a.md", ws), /empty body/);
  assert.throws(() => parseNote(NOTE("npm:\n  omgbase-store: patch"), "a.md", ws), /unknown npm package `omgbase-store`/);
  const { errors } = loadNotes(loadWorkspace(fixture({ notes: { bad: "no frontmatter\n" } })));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /changes\/bad\.md: malformed change note/);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- workspace

test("readCargoManifest: package fields, path deps with pins, dev flag", () => {
  const m = readCargoManifest(cargo("omgbase", "0.5.0", { "omgbase-sync": "1.2.0" }, { "omgbase-store": 1 }));
  assert.equal(m.name, "omgbase");
  assert.equal(m.version, "0.5.0");
  assert.deepEqual(
    m.deps.map(({ key, pin, dev }) => ({ key, pin, dev })),
    [
      { key: "omgbase-sync", pin: "1.2.0", dev: false },
      { key: "omgbase-store", pin: null, dev: true },
    ],
  );
});

test("loadWorkspace + topoSort: dependencies first, private packages skipped, dev-dep cycles ignored", () => {
  const root = fixture();
  const ws = loadWorkspace(root);
  assert.deepEqual(
    ws.npm.map((p) => p.name),
    ["omgbase", "@omgbase/core", "@omgbase/oqx"],
  );
  assert.deepEqual(
    topoSort(ws.npm).map((p) => p.name),
    ["@omgbase/oqx", "@omgbase/core", "omgbase"],
  );
  assert.deepEqual(
    topoSort(ws.crates).map((p) => p.name),
    ["omgbase-store", "omgbase-sync", "oqx", "omgbase"],
  );
  assert.equal(ownerOf("packages/core/src/x.ts", ws), "npm:@omgbase/core");
  assert.equal(ownerOf("crates/omgbase/src/main.rs", ws), "crate:omgbase");
  assert.equal(ownerOf("packages/client/src/x.ts", ws), null);
  assert.equal(ownerOf("spec/store/VERSION", ws), null);
  assert.throws(() => topoSort([{ key: "a", deps: ["b"] }, { key: "b", deps: ["a"] }]), /dependency cycle/);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- levels + versions

test("foldLevel / bumpVersion", () => {
  assert.equal(foldLevel("patch", "minor"), "minor");
  assert.equal(foldLevel("major", "minor"), "major");
  assert.equal(foldLevel("none", "patch"), "patch");
  assert.equal(foldLevel("none", "none"), "none");
  assert.equal(bumpVersion("13.5.1", "patch"), "13.5.2");
  assert.equal(bumpVersion("13.5.1", "minor"), "13.6.0");
  assert.equal(bumpVersion("13.5.1", "major"), "14.0.0");
  assert.equal(bumpVersion("13.5.1", "none"), "13.5.1");
  assert.throws(() => bumpVersion("1.0.0-beta.1", "patch"), /unsupported version/);
});

test("computePlan: folds notes per package, `none` records without bumping, sequence in dependency order", () => {
  const root = fixture({
    notes: {
      a: NOTE('npm:\n  "@omgbase/core": patch\n  omgbase: none'),
      b: NOTE('npm:\n  "@omgbase/core": minor\n  omgbase: patch'),
    },
  });
  const ws = loadWorkspace(root);
  const { notes } = loadNotes(ws);
  const plan = computePlan(ws, notes);
  assert.deepEqual(plan.errors, []);
  const by = Object.fromEntries(plan.entries.map((e) => [e.key, e]));
  assert.equal(by["npm:@omgbase/core"].level, "minor");
  assert.equal(by["npm:@omgbase/core"].next, "0.5.0");
  assert.deepEqual(by["npm:@omgbase/core"].notes, ["a", "b"]);
  assert.equal(by["npm:omgbase"].level, "patch");
  assert.equal(by["npm:omgbase"].next, "0.4.1");
  assert.equal(by["npm:@omgbase/oqx"].level, null);
  assert.equal(by["crate:omgbase-store"].next, "13.5.1");
  assert.deepEqual(
    plan.sequence.map((e) => `${e.key}@${e.next}`),
    ["npm:@omgbase/core@0.5.0", "npm:omgbase@0.4.1"],
  );
  const table = renderPlan(plan, ws, null);
  assert.match(table, /@omgbase\/core\s+0\.4\.0 → 0\.5\.0\s+minor\s+a, b/);
  assert.match(table, /omgbase \(npm\)\s+0\.4\.0 → 0\.4\.1\s+patch\s+a, b/);
  assert.match(table, /omgbase \(crate\)\s+0\.5\.0/);
  rmSync(root, { recursive: true, force: true });
});

test("computePlan: none-only notes bump nothing", () => {
  const root = fixture({ notes: { docs: NOTE('npm:\n  "@omgbase/core": none') } });
  const ws = loadWorkspace(root);
  const plan = computePlan(ws, loadNotes(ws).notes);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.sequence, []);
  assert.equal(plan.entries.find((e) => e.key === "npm:@omgbase/core").level, "none");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- spec tracking

test("spec-tracking: a minor without a spec bump fails with the exact message", () => {
  const root = fixture({ notes: { x: NOTE("crates:\n  omgbase-store: minor") } });
  const ws = loadWorkspace(root);
  const plan = computePlan(ws, loadNotes(ws).notes);
  assert.deepEqual(plan.errors, ["omgbase-store: a minor needs spec/store/VERSION 13.6 (it is 13.5) — bump the spec or use patch"]);
  rmSync(root, { recursive: true, force: true });
});

test("spec-tracking: a minor that matches the moved spec passes; both implementations of oqx track spec/oqx", () => {
  const root = fixture({
    specs: { oqx: "0.14", store: "13.6", sync: "1.2" },
    notes: { x: NOTE('crates:\n  omgbase-store: minor\n  oqx: minor\nnpm:\n  "@omgbase/oqx": minor') },
  });
  const ws = loadWorkspace(root);
  const plan = computePlan(ws, loadNotes(ws).notes);
  assert.deepEqual(plan.errors, []);
  const by = Object.fromEntries(plan.entries.map((e) => [e.key, e]));
  assert.equal(by["crate:omgbase-store"].next, "13.6.0");
  assert.equal(by["crate:oqx"].next, "0.14.0");
  assert.equal(by["npm:@omgbase/oqx"].next, "0.14.0");
  rmSync(root, { recursive: true, force: true });
});

test("spec-tracking: the spec moved but no note bumps the crate → fail naming the missing note; a patch does not satisfy it", () => {
  const root = fixture({ specs: { oqx: "0.13", store: "13.6", sync: "1.2" } });
  const ws = loadWorkspace(root);
  let plan = computePlan(ws, []);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /^omgbase-store: spec\/store\/VERSION is 13\.6 but omgbase-store is 13\.5\.1 and no note bumps it — add a changes\/<slug>\.md with `crates:\n {2}omgbase-store: minor`/);
  writeFileSync(join(root, "changes/p.md"), NOTE("crates:\n  omgbase-store: patch"));
  plan = computePlan(ws, loadNotes(ws).notes);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /no note bumps it past a patch/);
  // a major jump in the spec asks for a major
  writeFileSync(join(root, "spec/store/VERSION"), "14.0\n");
  plan = computePlan(loadWorkspace(root), []);
  assert.match(plan.errors[0], /omgbase-store: major`$/);
  rmSync(root, { recursive: true, force: true });
});

test("spec-tracking: a crate ahead of its spec is a warning, not an error; patch never moves major.minor", () => {
  const root = fixture({ specs: { oqx: "0.13", store: "13.5", sync: "1.1" }, notes: { x: NOTE("crates:\n  omgbase-sync: patch") } });
  const ws = loadWorkspace(root);
  const plan = computePlan(ws, loadNotes(ws).notes);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.warnings, ["omgbase-sync: 1.2.0 is ahead of spec/sync/VERSION 1.1 — the spec should have moved with it"]);
  assert.equal(plan.entries.find((e) => e.key === "crate:omgbase-sync").next, "1.2.1");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- pins

test("pins: a dependent whose pinned dependency moves gets an automatic patch, transitively; dev-only pins do not", () => {
  const root = fixture({ notes: { x: NOTE("crates:\n  omgbase-store: patch") } });
  const ws = loadWorkspace(root);
  const plan = computePlan(ws, loadNotes(ws).notes);
  assert.deepEqual(plan.errors, []);
  const by = Object.fromEntries(plan.entries.map((e) => [e.key, e]));
  assert.equal(by["crate:omgbase-store"].next, "13.5.2");
  assert.equal(by["crate:omgbase-sync"].level, "patch");
  assert.equal(by["crate:omgbase-sync"].pin, true);
  assert.equal(by["crate:omgbase-sync"].next, "1.2.1");
  assert.equal(by["crate:omgbase"].pin, true);
  assert.equal(by["crate:omgbase"].next, "0.5.1");
  assert.equal(by["crate:oqx"].level, null);
  assert.deepEqual(
    plan.crateOrder.map((e) => e.name),
    ["omgbase-store", "omgbase-sync", "omgbase"],
  );
  assert.match(renderPlan(plan, ws, null), /omgbase-sync\s+1\.2\.0 → 1\.2\.1\s+patch\s+\(pin\)/);
  rmSync(root, { recursive: true, force: true });
});

test("rewriteCargoPins / bumpCargoToml / bumpPackageJson keep formatting", () => {
  const toml = cargo("omgbase", "0.5.0", { "omgbase-sync": "1.2.0", "omgbase-store": "13.5.1" }, { "omgbase-store": 1 });
  const { text, changed } = rewriteCargoPins(toml, { "omgbase-store": "13.6.0" });
  assert.equal(changed.length, 1);
  assert.match(text, /omgbase-store = \{ version = "13\.6\.0", path = "\.\.\/omgbase-store" \}/);
  assert.match(text, /omgbase-sync = \{ version = "1\.2\.0"/);
  assert.match(text, /\[dev-dependencies\]\nomgbase-store = \{ path = "\.\.\/omgbase-store" \}/);
  const bumped = bumpCargoToml(text, "0.5.1");
  assert.match(bumped, /^\[package\]\nname = "omgbase"\nversion = "0\.5\.1"\n/);
  assert.equal((bumped.match(/version = /g) ?? []).length, (text.match(/version = /g) ?? []).length);
  const pj = bumpPackageJson('{\n  "name": "x",\n  "version": "0.4.0",\n  "dependencies": { "y": "0.4.0" }\n}\n', "0.4.1");
  assert.equal(pj, '{\n  "name": "x",\n  "version": "0.4.1",\n  "dependencies": { "y": "0.4.0" }\n}\n');
});

// ---------------------------------------------------------------- changelog

test("changelog rendering: groups by level, bodies as bullets, prepends after the header", () => {
  assert.equal(bodyAsBullet("One paragraph.\nsecond line.\n\nSecond paragraph."), "- One paragraph.\n  second line.\n\n  Second paragraph.");
  assert.equal(bodyAsBullet("- a\n- b"), "- a\n- b");
  const section = renderChangelogSection("0.4.1", "2026-09-27", [
    { level: "patch", body: "Fixed a thing." },
    { level: "none", body: "Docs only." },
    { level: "minor", body: "- added x\n- added y" },
  ]);
  assert.equal(section, "## [0.4.1] - 2026-09-27\n\n### Minor\n- added x\n- added y\n\n### Patch\n- Fixed a thing.\n\n### Notes\n- Docs only.\n");
  const existing = changelogHeader("@omgbase/core") + "\n## [0.4.0] - 2026-09-20\n\n- old\n\n[0.4.0]: https://example\n";
  const out = prependChangelogSection(existing, section);
  assert.equal(out.indexOf("## [0.4.1]") < out.indexOf("## [0.4.0]"), true);
  assert.match(out, /Keep a Changelog[\s\S]*## \[0\.4\.1\] - 2026-09-27\n\n### Minor[\s\S]*\n\n## \[0\.4\.0\]/);
  assert.match(out, /\[0\.4\.0\]: https:\/\/example\n$/);
  // no heading yet: appended after the header
  assert.match(prependChangelogSection(changelogHeader("x"), section), /break\)\.\n\n## \[0\.4\.1\]/);
});

test("applyPlan on a fixture: manifests, pins, changelogs (created when missing), notes consumed; none-only notes stay", () => {
  const root = fixture({
    notes: {
      store: NOTE("crates:\n  omgbase-store: patch", "Collision-safe minting."),
      core: NOTE('npm:\n  "@omgbase/core": patch\n  omgbase: patch', "cli 1.0 fixes.\n\nMore detail."),
      docs: NOTE('npm:\n  "@omgbase/oqx": none', "README only."),
    },
  });
  const ws = loadWorkspace(root);
  const { notes } = loadNotes(ws);
  const plan = computePlan(ws, notes);
  assert.deepEqual(plan.errors, []);
  const dry = applyPlan(ws, plan, notes, { date: "2026-09-27", dryRun: true });
  assert.equal(existsSync(join(root, "changes/store.md")), true);
  assert.equal(existsSync(join(root, "packages/core/CHANGELOG.md")), false);
  const result = applyPlan(ws, plan, notes, { date: "2026-09-27" });
  assert.deepEqual(result.touched.sort(), dry.touched.sort());
  assert.deepEqual(result.removed.sort(), ["changes/core.md", "changes/store.md"]);
  assert.equal(existsSync(join(root, "changes/docs.md")), true);
  assert.equal(JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")).version, "0.4.1");
  assert.equal(JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")).version, "0.4.1");
  assert.equal(JSON.parse(readFileSync(join(root, "packages/oqx/package.json"), "utf8")).version, "0.13.0");
  const store = readFileSync(join(root, "crates/omgbase-store/Cargo.toml"), "utf8");
  assert.match(store, /^version = "13\.5\.2"$/m);
  const sync = readFileSync(join(root, "crates/omgbase-sync/Cargo.toml"), "utf8");
  assert.match(sync, /^version = "1\.2\.1"$/m);
  assert.match(sync, /omgbase-store = \{ version = "13\.5\.2"/);
  const bin = readFileSync(join(root, "crates/omgbase/Cargo.toml"), "utf8");
  assert.match(bin, /^version = "0\.5\.1"$/m);
  assert.match(bin, /omgbase-sync = \{ version = "1\.2\.1"/);
  assert.match(bin, /omgbase-store = \{ version = "13\.5\.2"/);
  assert.match(bin, /oqx = \{ version = "0\.13\.0"/);
  const coreLog = readFileSync(join(root, "packages/core/CHANGELOG.md"), "utf8");
  assert.equal(coreLog, changelogHeader("@omgbase/core") + "\n## [0.4.1] - 2026-09-27\n\n### Patch\n- cli 1.0 fixes.\n\n  More detail.\n");
  const syncLog = readFileSync(join(root, "crates/omgbase-sync/CHANGELOG.md"), "utf8");
  assert.match(syncLog, /### Patch\n- Dependency pins moved: omgbase-store 13\.5\.1 → 13\.5\.2\.\n/);
  const binLog = readFileSync(join(root, "crates/omgbase/CHANGELOG.md"), "utf8");
  assert.match(binLog, /omgbase-sync 1\.2\.0 → 1\.2\.1, omgbase-store 13\.5\.1 → 13\.5\.2/);
  assert.equal(existsSync(join(root, "packages/oqx/CHANGELOG.md")), false);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- registry parsing

test("parseNpmJson tolerates a wrapper banner before the JSON", () => {
  assert.deepEqual(parseNpmJson('Warning: some banner\n["0.4.0","0.4.1"]\n'), ["0.4.0", "0.4.1"]);
  assert.deepEqual(parseNpmJson('"0.1.0"\n'), ["0.1.0"]);
  assert.deepEqual(parseNpmJson(""), []);
});

test("isAlreadyPublished recognizes npm's and crates.io's republish refusals", async () => {
  const { isAlreadyPublished } = await import("./lib/registry.mjs");
  const npm = 'Failed to publish package @omgbase/sync@0.4.1 (status 403 Forbidden):\n{"success":false,"error":"You cannot publish over the previously published versions: 0.4.1."}';
  assert.equal(isAlreadyPublished(npm, "0.4.1"), true);
  assert.equal(isAlreadyPublished(npm, "0.4.10"), false);
  assert.equal(isAlreadyPublished("error: crate version `1.3.0` is already uploaded", "1.3.0"), true);
  assert.equal(isAlreadyPublished("ERR_PNPM_FAILED_TO_PUBLISH 401 Unauthorized", "0.4.1"), false);
});

test("computePlan: an npm dependent republishes as a (pin) patch when a workspace dependency bumps", () => {
  // `@omgbase/core` gets a minor; `omgbase` (npm) depends on core with `workspace:^`
  // and has no note of its own — pnpm would publish it as `^0.5.0`, so it must move.
  const root = fixture({ notes: { c: NOTE('npm:\n  "@omgbase/core": minor') } });
  const ws = loadWorkspace(root);
  const { notes } = loadNotes(ws);
  const plan = computePlan(ws, notes);
  assert.deepEqual(plan.errors, []);
  const by = Object.fromEntries(plan.entries.map((e) => [e.key, e]));
  assert.equal(by["npm:@omgbase/core"].next, "0.5.0");
  assert.equal(by["npm:omgbase"].level, "patch");
  assert.equal(by["npm:omgbase"].pin, true);
  assert.equal(by["npm:omgbase"].next, "0.4.1");
  assert.equal(by["npm:@omgbase/oqx"].level, null, "a dependency of core, not a dependent — untouched");
  assert.match(renderPlan(plan, ws, null), /omgbase \(npm\)\s+0\.4\.0 → 0\.4\.1\s+patch\s+\(pin\)/);
  rmSync(root, { recursive: true, force: true });
});

test("otpRejected recognizes npm's one-time-password refusals and nothing else", () => {
  assert.equal(otpRejected("npm error code EOTP\nnpm error This operation requires a one-time password from your authenticator."), true);
  assert.equal(otpRejected("npm ERR! 401 Unauthorized - PUT https://registry.npmjs.org/@omgbase%2fcore - You must provide a one-time pass. Upgrade your client to npm@latest in order to use 2FA."), true);
  assert.equal(otpRejected('Failed to publish package @omgbase/sync@0.4.1 (status 403 Forbidden):\n{"success":false,"error":"You cannot publish over the previously published versions: 0.4.1."}'), false);
  assert.equal(otpRejected("npm error code E404"), false);
});
