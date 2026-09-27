import { pinClock, sequentialMinter, setIdMinter } from "@omgbase/core";
import { CliUsageError } from "./output.js";

// The two conformance seams of spec/surface §7.1 (and spec/cli §2.6), read
// from the environment at process start — BEFORE any workspace opens, so no id
// is minted and no timestamp read without them. Every verb honors them (the
// CLI fixtures of spec/cli run each verb under them); `omg mcp` additionally
// announces them on stderr. For conformance runs only — never set in production:
//
//   OMGBASE_SPEC_MINTER=sequential   the fixture minter of spec/store §2.2 for
//                                    the whole process (`d_0, d_1, …`, each
//                                    prefix from 0); any other value is a
//                                    usage error (exit 2)
//   OMGBASE_SPEC_CLOCK=<RFC 3339>    "now" is that instant for the whole
//                                    process: every commit a verb stamps, every
//                                    `ts` reported as current; not an instant →
//                                    usage error (exit 2)

export interface SpecSeams {
  /** the sequential minter is installed */
  minter: boolean;
  /** the pinned instant (canonical ISO form), when the clock is pinned */
  clock: string | null;
}

let installed: SpecSeams | null = null;

/**
 * Read + install the seams (idempotent: a second call returns what the first
 * installed). Throws `CliUsageError` on an invalid value; the caller renders it.
 */
export function installSpecSeams(env: NodeJS.ProcessEnv = process.env): SpecSeams {
  if (installed) return installed;
  const seams: SpecSeams = { minter: false, clock: null };
  const minter = env.OMGBASE_SPEC_MINTER;
  if (minter !== undefined && minter !== "") {
    if (minter !== "sequential") {
      throw new CliUsageError(`OMGBASE_SPEC_MINTER=${JSON.stringify(minter)}: the only value is "sequential" (spec/surface §7.1)`, "unset it, or set OMGBASE_SPEC_MINTER=sequential for a conformance run");
    }
    setIdMinter(sequentialMinter());
    seams.minter = true;
  }
  const clock = env.OMGBASE_SPEC_CLOCK;
  if (clock !== undefined && clock !== "") {
    try {
      pinClock(clock);
    } catch {
      throw new CliUsageError(`OMGBASE_SPEC_CLOCK=${JSON.stringify(clock)}: not an RFC 3339 instant (spec/surface §7.1)`, "e.g. OMGBASE_SPEC_CLOCK=2026-09-27T00:00:00.000Z");
    }
    seams.clock = new Date().toISOString();
  }
  installed = seams;
  return seams;
}

/** The seams installed by `installSpecSeams` (none when it has not run). */
export function activeSpecSeams(): SpecSeams {
  return installed ?? { minter: false, clock: null };
}
