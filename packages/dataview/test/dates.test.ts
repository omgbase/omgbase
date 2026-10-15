// The bare-literal grammars (dates.ts) and the function table's consistency.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FUNCTIONS, isDateLiteral, isDurationLiteral, NAMED_DATES, translate } from "../src/index.ts";

test("date literals: the named points and ISO dates, not field names", () => {
  for (const n of NAMED_DATES) assert.ok(isDateLiteral(n), n);
  assert.ok(isDateLiteral("Today"));
  assert.ok(isDateLiteral("2026-10-15"));
  assert.ok(isDateLiteral("2026-10"));
  assert.ok(isDateLiteral("2026"));
  assert.ok(isDateLiteral("2026-10-15T09:30"));
  assert.ok(isDateLiteral("2026-10-15T09:30:00.123+02:00"));
  assert.ok(!isDateLiteral("due"));
  assert.ok(!isDateLiteral("file.mtime"));
  assert.ok(!isDateLiteral("15/10/2026"));
  assert.ok(!isDateLiteral("2026-1-5"));
});

test("duration literals: number-unit groups, the compact form, ISO 8601; not field names", () => {
  for (const d of ["1 hour", "1 hour 30 minutes", "1h30m", "2 weeks, 3 days", "3d", "1.5 hours", "PT1H30M", "P2W", "-1 day", "1 yr 2 mos"]) {
    assert.ok(isDurationLiteral(d), d);
  }
  for (const d of ["day", "elapsed", "1", "hour 1", "P", "1 fortnight"]) assert.ok(!isDurationLiteral(d), d);
});

test("every documented Dataview function has a status, and every supported one a handler", () => {
  const names = Object.keys(FUNCTIONS);
  assert.ok(names.length >= 60, `${names.length} functions`);
  for (const name of names) {
    const f = FUNCTIONS[name]!;
    if (f.status === "unsupported") continue;
    // A supported or group-only function never fails with "no handler".
    try {
      translate(`TABLE ${name}(rows.x, rows.y, rows.z) GROUP BY k`);
    } catch (e) {
      assert.ok(e instanceof Error && !/no handler/.test(e.message), `${name}: ${(e as Error).message}`);
    }
  }
});
