import assert from "node:assert/strict";
import { test } from "node:test";
import { chronologicalAverage, salesChange, turnoverRatios } from "../src/services/turnover-domain.js";

// These regressions catch doubled endpoint columns, invented gap balances,
// division by zero, and percentages against returns-only comparison bases.

test("chronological average halves each endpoint once and preserves missing daily balances", () => {
  assert.equal(chronologicalAverage([10, 30, 50]), 30);
  assert.equal(chronologicalAverage([0, 20, 20, 0]), 40 / 3);
  assert.equal(chronologicalAverage([0, 0]), 0);
  assert.equal(chronologicalAverage([12]), 12);
  assert.equal(chronologicalAverage([10, null, 50]), null);
  assert.equal(chronologicalAverage([]), null);
});

test("example workbook daily values follow the specification rather than duplicated endpoint SUM cells", () => {
  assert.equal(chronologicalAverage([
    91.5, 183, 150, 150, 150, 150, 150, 150, 150, 150,
    146, 143, 143, 143, 143, 143, 143, 143, 143, 143,
    84, 84, 84, 84, 84, 84, 84, 84, 84, 42
  ]), 125.47413793103448);
  assert.equal(chronologicalAverage([
    10, 20, 18, 18, 18, 18, 18, 16, 16, 16,
    15, 15, 15, 15, 15, 15, 15, 15, 13, 13,
    14, 14, 14, 14, 14, 14, 14, 14, 14, 7
  ]), 15.120689655172415);
  assert.equal(chronologicalAverage([
    15970.5, 14196, 14196, 12421.5, 23068.5, 18336.5, 18336.5, 14787.5, 14787.5, 11238.5,
    4732, 28392, 21885.5, 10055.5, 7689.5, 18336.5, 14787.5, 11830, 20111, 18928,
    18928, 17745, 28983.5, 21294, 18928, 17153.5, 8281, 1774.5, 591.5, 24251.5
  ]), 15582.965517241379);
});

test("turnover uses quantity or cost rather than revenue and never emits undefined ratios", () => {
  assert.deepEqual(turnoverRatios(12, 125.47413793103448, 30), {
    coefficient: 0.09563723806252147, days: 313.6853448275862
  });
  assert.deepEqual(turnoverRatios(0, 50, 30), { coefficient: 0, days: null });
  assert.deepEqual(turnoverRatios(10, 0, 30), { coefficient: null, days: null });
  assert.deepEqual(turnoverRatios(null, 10, 30), { coefficient: null, days: null });
  assert.deepEqual(turnoverRatios(-2, 10, 30), { coefficient: null, days: null });
});

test("sales changes distinguish new demand, absent baseline, and missing data", () => {
  assert.deepEqual(salesChange(12, 10), { pct: 20, status: "comparable" });
  assert.deepEqual(salesChange(0, 10), { pct: -100, status: "comparable" });
  assert.deepEqual(salesChange(5, 0), { pct: null, status: "new" });
  assert.deepEqual(salesChange(0, 0), { pct: null, status: "no-base" });
  assert.deepEqual(salesChange(5, -1), { pct: null, status: "no-base" });
  assert.deepEqual(salesChange(null, 10), { pct: null, status: "missing" });
});
