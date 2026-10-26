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
  store: "17.3",
  properties: "1.2",
  graph: "3.0",
  search: "3.0",
  mutate: "4.1",
  sync: "4.3",
  surface: "6.3",
  cli: "5.3",
} as const;

export type SpecName = keyof typeof SPEC_VERSIONS;
