import assert from "node:assert/strict";
import test from "node:test";
import { turnoverStandardDates, turnoverStandardGrid, turnoverStandardValue } from "../src/services/turnover-presentation.js";

const row = {
  daily: [20, 50, 40].map((quantity, index) => ({ date: `2026-09-${28 + index}`, unit: "шт", quantity, stockCost: quantity * 10, salesQty: 0, salesCost: 0, revenue: 0, weight: index === 1 ? 1 : 0.5 })),
  averageQty: 40, averageCost: 400,
  periodSales: { quantity: 100, cost: 1000, revenue: 1700, averageDailyQty: 50, averageDailyCost: 500 },
  turnoverQty: 2.5, turnoverQtyDays: 1.2, turnoverCost: 2.5, turnoverCostDays: 1.2
};

test("standard grid pairs each date and metric by basis, with shared period length and half endpoints", () => {
  const days = turnoverStandardDates("2026-09-28", "2026-10-01");
  assert.deepEqual(days, ["2026-09-28", "2026-09-29", "2026-09-30"]);
  const grid = turnoverStandardGrid(days, "both");
  assert.deepEqual(grid.slice(0, 3).map(group => group.leaves.map(leaf => [
    leaf.basis, leaf.column.kind === "day" ? leaf.column.half : null
  ])), [
    [["quantity", false], ["money", false], ["quantity", true], ["money", true]],
    [["quantity", false], ["money", false]],
    [["quantity", true], ["money", true], ["quantity", false], ["money", false]]
  ]);
  const leaves = grid.flatMap(group => group.leaves);
  assert.deepEqual(leaves.map(leaf => leaf.basis), [
    "quantity", "money", "quantity", "money", "quantity", "money", "quantity", "money", "quantity", "money",
    "quantity", "money", "quantity", "money", "quantity", "money", "shared", "quantity", "money", "quantity", "money"
  ]);
  assert.deepEqual(leaves.map(({ column, basis }) => turnoverStandardValue(row, column, basis === "shared" ? "quantity" : basis, 3)),
    [20, 200, 10, 100, 50, 500, 20, 200, 40, 400, 80, 800, 40, 400, 2.5, 2.5, 3, 100, 1000, 1.2, 1.2]);
});

test("standard cells preserve zero and signed sales and never turn missing/nonfinite days into zero", () => {
  const columns = turnoverStandardGrid(turnoverStandardDates("2026-09-28", "2026-10-01"), "quantity").flatMap(group => group.leaves.map(leaf => leaf.column));
  const modified = { ...row, daily: [{ ...row.daily[0]!, quantity: 0 }, row.daily[1]!, { ...row.daily[2]!, quantity: null }],
    averageQty: null, turnoverQty: null, turnoverQtyDays: null, periodSales: { ...row.periodSales, quantity: -5 } };
  assert.deepEqual(columns.map(column => turnoverStandardValue(modified, column, "quantity", 3)), [0, 0, 50, null, null, null, null, null, 3, -5, null]);
  assert.equal(turnoverStandardValue({ ...row, daily: [] }, columns[0]!, "quantity", 3), null);
  assert.equal(turnoverStandardValue({ ...row, daily: [{ ...row.daily[0]!, quantity: Infinity }] }, columns[0]!, "quantity", 3), null);
  assert.equal(turnoverStandardValue({ ...row, turnoverQty: NaN }, columns[7]!, "quantity", 3), null);
});

test("the weighted total is not the in-stock average multiplied by the full period", () => {
  const columns = turnoverStandardGrid(turnoverStandardDates("2026-09-28", "2026-10-01"), "money").flatMap(group => group.leaves.map(leaf => leaf.column));
  const sparse = { ...row, daily: row.daily.map((day, index) => ({
    ...day, quantity: [0, 20, -4][index]!, stockCost: [0, 200, -40][index]!
  })), averageQty: 20, averageCost: 200 };
  assert.equal(turnoverStandardValue(sparse, columns[5]!, "quantity", 3), 20);
  assert.equal(turnoverStandardValue(sparse, columns[5]!, "money", 3), 200);
});
