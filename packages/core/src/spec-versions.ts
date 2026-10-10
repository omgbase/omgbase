import { LANGUAGE_VERSION } from "@omgbase/oqx";

// The spec versions this reference implements (spec/surface §4, the `version`
// tool's `specs`): one compile-time constant per `spec/<x>/VERSION`, NOT a file
// read — a published package has no `spec/` next to it. Hand-maintained; the
// test beside this module (`spec-versions.test.ts`) asserts every entry equals
// the corresponding `spec/<x>/VERSION` file and that no spec is missing, so a
// spec bump that forgets this map fails the build. `oqx` is the one entry with
// a constant of its own: `@omgbase/oqx`'s `LANGUAGE_VERSION`.
//
// Key order is the order spec/surface §4 lists them (the CLI prints `specs` in
// this order).
export const SPEC_VERSIONS = {
  oqx: LANGUAGE_VERSION,
  format: "0.2",
  reconcile: "2.3",
  store: "13.5",
  properties: "1.1",
  graph: "1.1",
  search: "1.2",
  mutate: "1.3",
  sync: "1.3",
  surface: "1.5",
  cli: "1.2",
} as const;

export type SpecName = keyof typeof SPEC_VERSIONS;
