import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { Store } from "./core/store/store.js";
import { SPEC_VERSIONS } from "./spec-versions.js";

// The `version` tool (spec/surface §4, 1.4) and `omg version` (spec/cli §6,
// 1.1): which engine, its own version, every component's version, the spec
// versions it was built against, the database schema version, the MCP
// protocol, runtime, commit and build time.
//
// Who knows what. Core knows the specs (SPEC_VERSIONS), the schema (the open
// store), the MCP protocol and SDK (its own dependency) and the runtime. It
// does NOT know the serving binary: the `omgbase` npm package depends on core,
// not the other way round, and under pnpm's strict layout core cannot even
// resolve `@omgbase/sync` or `@omgbase/fs-adapter` (they are the CLI's
// dependencies). So the host — `omg mcp` / `omg version` — passes a `HostInfo`:
// its version, its `build-info.json` fields, and the module URL its dependency
// graph resolves from. Without a host (a library embedding, the surface fixture
// runner) `version` falls back to the nearest `omgbase` package the engine can
// see, else to core's own version, and `components` holds whatever resolves
// from core (in the workspace: `@omgbase/core` and `@omgbase/oqx`).

export interface HostInfo {
  /** the serving binary's own version — `omgbase`'s package.json (what `--version` prints) */
  version: string;
  /** the build's short git revision, from `build-info.json`; null when unknown */
  commit: string | null;
  /** the build's RFC 3339 time, from `build-info.json`; null when unknown */
  built: string | null;
  /** the host module's `import.meta.url`: the component packages are resolved from its dependency graph */
  resolveFrom?: string;
}

export interface VersionInfo {
  engine: "typescript";
  version: string;
  /** every omgbase package the binary is built from, keys sorted bytewise */
  components: Record<string, string>;
  specs: typeof SPEC_VERSIONS;
  /** `PRAGMA user_version` of the open store; null without one */
  schema: number | null;
  mcp: { protocol: string; sdk: string };
  runtime: string;
  commit: string | null;
  built: string | null;
}

/** The omgbase packages the reference binary is built from (spec/surface §4). */
export const COMPONENT_PACKAGES = ["omgbase", "@omgbase/core", "@omgbase/oqx", "@omgbase/sync", "@omgbase/fs-adapter"] as const;

const MCP_SDK = "@modelcontextprotocol/sdk";

/** The nearest `package.json` named `name` at or above `fromUrl`'s directory, or null. */
export function nearestPackageVersion(fromUrl: string, name: string): string | null {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = readManifest(candidate);
      if (pkg?.name === name && typeof pkg.version === "string") return pkg.version;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readManifest(path: string): { name?: unknown; version?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
  } catch {
    return null;
  }
}

/**
 * `name`'s installed version as seen from `anchors` (module URLs). Node's own
 * resolver is no use here: the omgbase packages are ESM-only (`exports` with an
 * `import` condition alone), which a CJS `require.resolve` cannot see, and no
 * package exports its `package.json`. So this walks what the algorithm would
 * absent `exports`: the anchor's own package first (a package cannot name
 * itself), then `node_modules/<name>/package.json` at each ancestor directory —
 * pnpm's symlinked layout, npm's hoisted global install and a plain checkout all
 * put the manifest there. Anchors are tried in turn; null when none has it.
 */
function resolvePackageVersion(name: string, anchors: string[]): string | null {
  for (const anchor of anchors) {
    const own = nearestPackageVersion(anchor, name);
    if (own !== null) return own;
    let dir = dirname(fileURLToPath(anchor));
    for (;;) {
      const pkg = readManifest(join(dir, "node_modules", name, "package.json"));
      if (pkg?.name === name && typeof pkg.version === "string") return pkg.version;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** The MCP SDK's version: from the module core itself imports, walking up to its manifest (its `package.json` is not exported). */
function mcpSdkVersion(): string | null {
  try {
    return nearestPackageVersion(import.meta.resolve(`${MCP_SDK}/types.js`), MCP_SDK);
  } catch {
    return null;
  }
}

/** The engine's own package version (`@omgbase/core`), from the manifest above this module. */
export function coreVersion(): string {
  return nearestPackageVersion(import.meta.url, "@omgbase/core") ?? "0.0.0";
}

/**
 * The `version` result. `store` supplies `schema`; `host` the binary's own
 * version, build info and resolution anchor (see the module comment).
 */
export function versionInfo(store?: Store | null, host?: HostInfo): VersionInfo {
  const anchors = [...(host?.resolveFrom ? [host.resolveFrom] : []), import.meta.url];
  const components: Record<string, string> = {};
  for (const name of COMPONENT_PACKAGES) {
    // The host IS `omgbase`: its version is what it says it is (the resolver
    // would find the same manifest above `resolveFrom`, but the host is explicit).
    const v = name === "omgbase" && host ? host.version : resolvePackageVersion(name, anchors);
    if (v !== null) components[name] = v;
  }
  const sorted = Object.fromEntries(Object.entries(components).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const version = host?.version ?? components["omgbase"] ?? coreVersion();
  const schema = store ? (store.db.pragma("user_version", { simple: true }) as number) : null;
  return {
    engine: "typescript",
    version,
    components: sorted,
    specs: SPEC_VERSIONS,
    schema,
    mcp: { protocol: LATEST_PROTOCOL_VERSION, sdk: mcpSdkVersion() ?? "unknown" },
    runtime: `node ${process.versions.node}`,
    commit: host?.commit ?? null,
    built: host?.built ?? null,
  };
}
