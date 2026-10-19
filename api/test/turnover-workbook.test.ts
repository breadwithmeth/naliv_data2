import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";
import ExcelJS from "exceljs";
import { writeTurnoverWorkbook } from "../src/services/turnover-workbook.js";
import type { TurnoverReport, TurnoverRow, TurnoverSales } from "../src/services/turnover-types.js";

const sales: TurnoverSales = { quantity: 12, cost: 120, revenue: 180, averageDailyQty: 6, averageDailyCost: 60 };
const row: TurnoverRow = {
  key: "store:item", name: "=1+1", sku: "item", article: "001", barcodes: ["000123"],
  storeKey: "store", storeName: "Магазин", warehouseKey: "wh", warehouseName: "Склад",
  categoryKey: "beer", categoryName: "Пиво", brandKey: null, brandName: "Не указан", unit: "л",
  openingQty: 10, closingQty: 20, averageQty: 15, openingCost: 100, closingCost: 200, averageCost: 150,
  periodSales: sales, comparisonSales: { ...sales, quantity: 0, cost: 0, revenue: 0 },
  quantityChange: { pct: null, status: "new" }, costChange: { pct: null, status: "new" },
  windows: [{ days: 7, current: { from: "2026-09-24", to: "2026-10-01" }, previous: { from: "2026-09-17", to: "2026-09-24" }, sales, previousSales: { ...sales, quantity: 0, cost: null }, quantityChange: { pct: null, status: "new" }, costChange: { pct: null, status: "missing" } }],
  turnoverQty: 0.8, turnoverQtyDays: 3.75, turnoverCost: 0.8, turnoverCostDays: 3.75,
  stockDays: 10, lastSaleDate: "2026-09-30", daysWithoutMovement: 0, noSalesHistory: false,
  observedDays: 3, expectedDays: 3, outOfStockDays: 0, costCoveragePct: 100,
  excessQty: 0, deficitQty: 0, recommendedOrderQty: 0, openOrderQty: 0, nextDeliveryDate: null,
  stagnantCost: { d30: 0, d60: 0, d90: 0 }, risks: [], recommendations: [],
  daily: [
    { date: "2026-09-28", unit: "л", quantity: 10, stockCost: 100, salesQty: 2, salesCost: 20, revenue: 30, weight: 0.5 },
    { date: "2026-09-29", unit: "л", quantity: 15, stockCost: 150, salesQty: 4, salesCost: 40, revenue: 60, weight: 1 },
    { date: "2026-09-30", unit: "л", quantity: 20, stockCost: 200, salesQty: 6, salesCost: 60, revenue: 90, weight: 0.5 }
  ]
};
function fixture(mode: "quantity" | "money" | "both"): TurnoverReport {
  return {
    params: { from: "2026-09-28", to: "2026-10-01", mode, store: ["store"], category: ["beer"], horizon: 14, groupBy: "sku", risk: "all", sort: "turnover" },
    comparison: { from: "2026-09-25", to: "2026-09-28", days: 3 },
    norms: { defaults: { minDays: 3, staleDays: 30, criticalStaleDays: 60, excessDays: 45, stopDays: 60, changePct: 20, targetDays: 30, highStockCost: null, leadTimeDays: null }, categories: { beer: { targetDays: 14 } } },
    rows: [{ ...row }], daily: row.daily, transfers: [],
    summary: { rowCount: 1, totalRowCount: 1, stagnantCount: 0, skuCount: 1, stockCost: 200, noSalesCount: 0, overstockCount: 0, deficitCount: 0, frozen30Cost: 0, frozen60Cost: 0, frozen90Cost: 0, costCoveragePct: 100, stockCoveragePct: 100 },
    options: { stores: [{ key: "store", name: "Магазин" }], warehouses: [{ key: "wh", name: "Склад", storeKey: "store" }], categories: [{ key: "beer", name: "Пиво" }], brands: [], skus: [{ key: "item", name: "=1+1" }] },
    coverage: { firstStockDate: "2026-09-28", lastStockDate: "2026-09-30", firstSalesDate: "2026-06-01", lastSalesDate: "2026-09-30", missingStockDates: [], observedDays: 3, expectedDays: 3 },
    methodology: ["Стоимость по себестоимости на дату; розничная выручка отдельно."], warnings: [], generatedAt: "2026-10-01T01:00:00Z"
  };
}
async function load(report: TurnoverReport) {
  const stream = new PassThrough();
  const [, bytes] = await Promise.all([writeTurnoverWorkbook(report, stream), buffer(stream)]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}

test("turnover XLSX preserves numeric cost basis, leading-zero identity and safe text cells", async () => {
  const workbook = await load(fixture("both"));
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getCell("G5").type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell("G5").value, "=1+1");
  assert.equal(sheet.getCell("F5").value, "001");
  assert.equal(sheet.getCell("H5").value, "000123");
  assert.equal(sheet.getCell("L5").value, 15);
  assert.equal(sheet.getCell("T5").value, 120);
  assert.equal(sheet.getCell("X5").value, 180);
  assert.equal(sheet.getCell("V5").value, 0.8);
  assert.equal(sheet.getCell("W5").value, 3.75);
  assert.ok(sheet.autoFilter);
  const daily = workbook.getWorksheet("Ежедневные остатки")!;
  assert.equal(daily.getCell("G5").value, 0.5);
  assert.equal(daily.getCell("H5").value, 10);
  assert.equal(daily.getCell("I5").value, 100);
});

test("summary workbook contains only the main table and parameters without barcodes or cost columns", async () => {
  const report = fixture("quantity");
  report.params.profile = "summary";
  report.rows[0].barcodes = ["000123"];
  report.rows[0].daily = [];
  report.daily = [];
  const workbook = await load(report);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Оборачиваемость", "Параметры и методика"]);
  const main = workbook.worksheets[0]!;
  const headers = main.getRow(4).values as unknown[];
  assert.equal(headers.includes("Штрихкоды"), false);
  const opening = headers.indexOf("Начальный остаток");
  assert.ok(opening > 0);
  assert.equal(main.getRow(5).getCell(opening).value, 10);
  const parameters = workbook.getWorksheet("Параметры и методика")!;
  const values: unknown[] = [];
  parameters.eachRow((row) => row.eachCell((cell) => values.push(cell.value)));
  assert.ok(values.some((value) => typeof value === "string" && value.startsWith("Краткий: основной лист")));
});

test("sample quantity workbook reproduces the example sheets, widths, headers and formulas", async () => {
  const report = fixture("quantity");
  report.params.profile = "sample";
  report.params.groupBy = "sku";
  const workbook = await load(report);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["рассчет оборачиваемости", "Продажи за период "]);
  const main = workbook.worksheets[0]!;
  assert.equal(main.getColumn(1).width, 65.5703125);
  assert.equal(main.getColumn(2).width, 9.140625);
  assert.equal(main.getColumn(3).width, 9.140625);
  assert.equal(main.getColumn(7).width, 26.7109375);
  assert.equal(main.getColumn(8).width, 29.28515625);
  assert.equal(main.getColumn(12).width, 29.28515625);
  assert.equal(main.getCell("A1").value, "Номенклатура ");
  assert.equal(main.getCell("B1").value, "28.09.");
  assert.equal(main.getCell("C1").value, "28.09. / 2");
  assert.equal(main.getCell("D1").value, "29.09.");
  assert.equal(main.getCell("E1").value, "30.09. / 2");
  assert.equal(main.getCell("F1").value, "30.09.");
  assert.equal(main.getCell("G1").value, "сумма остатков за период ");
  assert.equal(main.getCell("H1").value, "средний товарный запас в шт ");
  assert.equal(main.getCell("I1").value, "Коэффицент оборачиваемости");
  assert.equal(main.getCell("J1").value, "количество дней в периоде ");
  assert.equal(main.getCell("K1").value, "продажи в шт за период ");
  assert.equal(main.getCell("L1").value, "количесто дней оборота в шт ");
  assert.equal(main.columnCount, 12);
  assert.equal(main.getCell("A2").value, "=1+1");
  assert.equal(main.getCell("B2").value, 10);
  assert.deepEqual(main.getCell("C2").value, { formula: "B2/2", result: 5 });
  assert.equal(main.getCell("D2").value, 15);
  assert.deepEqual(main.getCell("E2").value, { formula: "F2/2", result: 10 });
  assert.equal(main.getCell("F2").value, 20);
  assert.deepEqual(main.getCell("G2").value, { formula: "C2+D2+E2", result: 30 });
  assert.deepEqual(main.getCell("H2").value, { formula: "G2/(3-1)", result: 15 });
  assert.deepEqual(main.getCell("I2").value, { formula: "K2/H2", result: 0.8 });
  assert.equal(main.getCell("J2").value, 3);
  assert.deepEqual(main.getCell("K2").value, { formula: "VLOOKUP(A2,'Продажи за период '!A:B,2,0)", result: 12 });
  assert.deepEqual(main.getCell("L2").value, { formula: "J2/I2", result: 3.75 });
  for (const address of ["H2", "I2", "J2", "L2"]) assert.equal(main.getCell(address).numFmt, "0.00");
  assert.equal(main.pageSetup.orientation, "landscape");
  assert.equal(main.pageSetup.paperSize, 9);
  assert.equal(main.views[0]?.state, "frozen");
  assert.equal(main.views[0]?.ySplit, 1);
  assert.equal(main.autoFilter, undefined);
  const sales = workbook.getWorksheet("Продажи за период ")!;
  assert.equal(sales.getColumn(1).width, 64.140625);
  assert.equal(sales.getRow(1).getCell(1).value, null);
  assert.equal(sales.getRow(2).getCell(1).value, "=1+1");
  assert.equal(sales.getRow(2).getCell(2).value, 12);
});

test("sample money workbook reproduces the money sheets, VLOOKUP range and totals", async () => {
  const report = fixture("money");
  report.params.profile = "sample";
  report.params.groupBy = "sku";
  const workbook = await load(report);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["рассчет оборачиваемости ", "Продажи за период "]);
  const main = workbook.worksheets[0]!;
  assert.equal(main.getCell("B2").value, 100);
  assert.equal(main.getCell("D2").value, 150);
  assert.equal(main.getCell("F2").value, 200);
  assert.deepEqual(main.getCell("H2").value, { formula: "G2/(3-1)", result: 150 });
  assert.deepEqual(main.getCell("I2").value, { formula: "K2/H2", result: 0.8 });
  assert.deepEqual(main.getCell("K2").value, { formula: "VLOOKUP(A2,'Продажи за период '!A:C,3,0)", result: 120 });
  assert.deepEqual(main.getCell("L2").value, { formula: "J2/I2", result: 3.75 });
  assert.equal(main.views[0]?.state, "frozen");
  assert.equal(main.views[0]?.ySplit, 1);
  assert.equal(main.autoFilter, "A1:L1");
  const sales = workbook.getWorksheet("Продажи за период ")!;
  assert.equal(sales.getColumn(1).width, 66.85546875);
  assert.equal(sales.getColumn(2).width, 12.42578125);
  assert.equal(sales.getColumn(3).width, 19.140625);
  assert.equal(sales.getCell("A1").value, "=1+1");
  assert.equal(sales.getCell("B1").value, 12);
  assert.equal(sales.getCell("C1").value, 120);
  assert.equal(sales.getCell("A2").value, "Итого");
  assert.equal(sales.getCell("B2").value, 12);
  assert.equal(sales.getCell("C2").value, 120);
});

test("combined sample export keeps both examples separate with distinct lookup sheets", async () => {
  const report = fixture("both");
  report.params.profile = "sample";
  report.params.groupBy = "sku";
  const workbook = await load(report);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    "рассчет оборачиваемости", "Продажи за период ",
    "рассчет оборачиваемости деньги", "Продажи за период в деньгах"
  ]);
  assert.equal(workbook.worksheets[0]!.getCell("K2").value.formula, "VLOOKUP(A2,'Продажи за период '!A:B,2,0)");
  assert.equal(workbook.worksheets[2]!.getCell("K2").value.formula, "VLOOKUP(A2,'Продажи за период в деньгах'!A:C,3,0)");
});

test("sample exports keep product labels independent of shops and withhold mixed-unit quantity totals", async () => {
  const report = fixture("money");
  report.params.profile = "sample";
  report.params.store = [];
  report.rows.push({
    ...row, key: "other:item", sku: "other", name: "Другой товар", storeKey: "second", storeName: "Второй магазин",
    unit: "шт", daily: row.daily.map((day) => ({ ...day, unit: "шт" }))
  });
  const workbook = await load(report);
  const main = workbook.worksheets[0]!;
  assert.equal(main.getCell("A2").value, row.name);
  assert.equal(main.getCell("A3").value, "Другой товар");
  const sales = workbook.getWorksheet("Продажи за период ")!;
  assert.equal(sales.getCell("A3").value, "Итого");
  assert.equal(sales.getCell("B3").value, "n/a");
  assert.equal(sales.getCell("C3").value, 240);
});

test("money-only export preserves unknown costs and the exact applied filter and category norms", async () => {
  const report = fixture("money");
  report.rows[0].averageCost = null;
  const workbook = await load(report);
  const main = workbook.worksheets[0];
  assert.equal(main.getCell("L5").value, "n/a");
  assert.equal(main.getCell("M5").value, 120);
  assert.equal(main.getCell("Q5").value, 180);
  const parameters = workbook.getWorksheet("Параметры и методика")!;
  const values: unknown[] = [];
  parameters.eachRow((r) => r.eachCell((cell) => values.push(cell.value)));
  assert.ok(values.includes("Магазин [store]"));
  assert.ok(values.includes("Пиво [beer]"));
  const categoryNorms: unknown[] = [];
  parameters.eachRow((r) => {
    const key = r.getCell(1).value;
    if (typeof key === "string" && key.includes("[beer]") && key.endsWith("/ targetDays")) categoryNorms.push(r.getCell(2).value);
  });
  assert.deepEqual(categoryNorms, [14]);
  for (const sheet of workbook.worksheets) sheet.eachRow((r) => r.eachCell((cell) => {
    assert.notEqual(cell.type, ExcelJS.ValueType.Error);
  }));
});

test("analytical workbook records every selected category and treats an empty selection as all categories", async () => {
  for (const [category, expected] of [
    [["beer", "cider"], "Пиво [beer]; Сидр [cider]"],
    [[], "Все категории"]
  ] as [string[], string][]) {
    const report = fixture("money");
    report.params.category = category;
    report.options.categories.push({ key: "cider", name: "Сидр" });
    const workbook = await load(report);
    const parameters = workbook.getWorksheet("Параметры и методика")!;
    const values: unknown[] = [];
    parameters.eachRow((row) => {
      if (row.getCell(1).value === "Категория") values.push(row.getCell(2).value);
    });
    assert.deepEqual(values, [expected]);
  }
});

test("broad report export retains aggregate daily history when individual audits load on demand", async () => {
  const report = fixture("both");
  report.rows[0].daily = [];
  const workbook = await load(report);
  const daily = workbook.getWorksheet("Ежедневные остатки")!;
  assert.equal(daily.getCell("D5").value, "n/a");
  assert.equal(daily.getCell("G5").value, 0.5);
  assert.equal(daily.getCell("H5").value, 10);
  assert.equal(daily.getCell("I5").value, 100);
  assert.equal(daily.getCell("H7").value, 20);
});

test("a stalled Excel download stops consuming the full assortment and disconnect cancels it", async () => {
  const report = fixture("quantity");
  let consumed = 0;
  report.rows = Array.from({ length: 30_000 }, (_, index) => ({
    ...row, key: String(index), windows: [], daily: [],
    get name() { consumed++; return `SKU ${index}`; }
  }));
  let started!: () => void;
  const firstChunk = new Promise<void>(resolve => { started = resolve; });
  let release: (() => void) | undefined;
  const stalled = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) { release = callback; started(); }
  });
  const generation = writeTurnoverWorkbook(report, stalled);
  // The rejection is observed immediately as well as asserted after disconnect.
  generation.catch(() => undefined);
  try {
    await firstChunk;
    for (let turn = 0; turn < 200; turn++) await setImmediate();
    assert.ok(consumed < report.rows.length, `Consumed all ${consumed} rows while the client was stalled`);
  } finally {
    stalled.destroy();
    release?.();
    await assert.rejects(generation, /closed|abort/i);
  }
});
