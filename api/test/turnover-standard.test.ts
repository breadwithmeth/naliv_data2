import assert from "node:assert/strict";
import test from "node:test";
import { turnoverStandardColumns, turnoverStandardDates, turnoverStandardValue } from "../src/services/turnover-presentation.js";

const row = {
  daily: [20, 50, 40].map((quantity, index) => ({ date: `2026-09-${28 + index}`, unit: "шт", quantity, stockCost: quantity * 10, salesQty: 0, salesCost: 0, revenue: 0, weight: index === 1 ? 1 : 0.5 })),
  averageQty: 40, averageCost: 400,
  periodSales: { quantity: 100, cost: 1000, revenue: 1700, averageDailyQty: 50, averageDailyCost: 500 },
  turnoverQty: 2.5, turnoverQtyDays: 1.2, turnoverCost: 2.5, turnoverCostDays: 1.2
};

test("standard table follows the original daily endpoints and six calculation columns", () => {
  const days = turnoverStandardDates("2026-09-28", "2026-10-01");
  assert.deepEqual(days, ["2026-09-28", "2026-09-29", "2026-09-30"]);
  const columns = turnoverStandardColumns(days, "quantity");
  assert.deepEqual(columns.map(column => column.label.trim()), ["28.09.", "28.09. / 2", "29.09.", "30.09. / 2", "30.09.",
    "сумма остатков за период", "средний товарный запас в шт", "Коэффицент оборачиваемости", "количество дней в периоде", "продажи в шт за период", "количество дней оборота"]);
  assert.deepEqual(columns.map(column => turnoverStandardValue(row, column, "quantity", 3)), [20, 10, 50, 20, 40, 80, 40, 2.5, 3, 100, 1.2]);
  assert.deepEqual(turnoverStandardColumns(days, "money").map(column => turnoverStandardValue(row, column, "money", 3)), [200, 100, 500, 200, 400, 800, 400, 2.5, 3, 1000, 1.2]);
});

test("standard cells preserve zero and signed sales and never turn missing/nonfinite days into zero", () => {
  const columns = turnoverStandardColumns(turnoverStandardDates("2026-09-28", "2026-10-01"), "quantity");
  const modified = { ...row, daily: [{ ...row.daily[0]!, quantity: 0 }, row.daily[1]!, { ...row.daily[2]!, quantity: null }],
    averageQty: null, turnoverQty: null, turnoverQtyDays: null, periodSales: { ...row.periodSales, quantity: -5 } };
  assert.deepEqual(columns.map(column => turnoverStandardValue(modified, column, "quantity", 3)), [0, 0, 50, null, null, null, null, null, 3, -5, null]);
  assert.equal(turnoverStandardValue({ ...row, daily: [] }, columns[0]!, "quantity", 3), null);
  assert.equal(turnoverStandardValue({ ...row, daily: [{ ...row.daily[0]!, quantity: Infinity }] }, columns[0]!, "quantity", 3), null);
  assert.equal(turnoverStandardValue({ ...row, turnoverQty: NaN }, columns[7]!, "quantity", 3), null);
});

test("the weighted total is not the in-stock average multiplied by the full period", () => {
  const columns = turnoverStandardColumns(turnoverStandardDates("2026-09-28", "2026-10-01"), "quantity");
  const sparse = { ...row, daily: row.daily.map((day, index) => ({
    ...day, quantity: [0, 20, -4][index]!, stockCost: [0, 200, -40][index]!
  })), averageQty: 20, averageCost: 200 };
  assert.equal(turnoverStandardValue(sparse, columns[5]!, "quantity", 3), 20);
  assert.equal(turnoverStandardValue(sparse, columns[5]!, "money", 3), 200);
});
