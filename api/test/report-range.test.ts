import assert from "node:assert/strict";
import { test } from "node:test";
import { currentMonthRange, resolveReportRange } from "../src/lib/report-range.js";

test("a range-less report request defaults to the current calendar month", () => {
  assert.deepEqual(currentMonthRange(new Date("2026-09-21T10:00:00Z")), {
    from: new Date("2026-09-01T00:00:00.000Z"),
    to: new Date("2026-10-01T00:00:00.000Z")
  });
  assert.deepEqual(currentMonthRange(new Date("2026-12-31T23:59:59Z")), {
    from: new Date("2026-12-01T00:00:00.000Z"),
    to: new Date("2027-01-01T00:00:00.000Z")
  });
  assert.deepEqual(resolveReportRange({ period: "day" }), {
    period: "day",
    ...currentMonthRange()
  });
});

test("explicit bounds are honoured as given, never widened or capped", () => {
  const from = new Date("2026-01-01T00:00:00.000Z");
  const to = new Date("2026-04-01T00:00:00.000Z");

  assert.deepEqual(resolveReportRange({ from, to }), { from, to });
  assert.deepEqual(resolveReportRange({ from }), { from });
  assert.deepEqual(resolveReportRange({ to }), { to });
});
