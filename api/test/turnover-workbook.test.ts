import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { writeTurnoverWorkbook } from "../src/services/turnover-workbook.js";
import { turnoverCoefficientBand } from "../src/services/turnover-domain.js";
import JSZip from "jszip";
import type { TurnoverReport, TurnoverRow, TurnoverSales } from "../src/services/turnover-types.js";

const sales: TurnoverSales = { quantity: 12, cost: 120, revenue: 180, averageDailyQty: 6, averageDailyCost: 60 };
const row: TurnoverRow = {
  key: "store:item", name: "=1+1", sku: "item", article: "001", barcodes: ["000123"],
  storeKey: "store", storeName: "Магазин", warehouseKey: "wh", warehouseName: "Склад",
  categoryKey: "beer", categoryName: "Пиво", brandKey: null, brandName: "Не указан", unit: "л",
  rootGroupKey: "beer", rootGroupName: "Пиво",
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
    totals: { overall: {
      unit: "л", daily: row.daily, openingQty: 10, closingQty: 20, averageQty: 15,
      openingCost: 100, closingCost: 200, averageCost: 150,
      periodSales: sales, comparisonSales: { ...sales, quantity: 0, cost: 0, revenue: 0 },
      quantityChange: { pct: null, status: "new" }, costChange: { pct: null, status: "new" },
      turnoverQty: 0.8, turnoverQtyDays: 3.75, turnoverCost: 0.8, turnoverCostDays: 3.75,
      stockDays: 10, excessQty: 0, deficitQty: 0, recommendedOrderQty: 0, openOrderQty: 0,
      stagnantCost: { d30: 0, d60: 0, d90: 0 }
    }, byUnit: [], byStore: [] },
    summary: { rowCount: 1, totalRowCount: 1, stagnantCount: 0, skuCount: 1, stockCost: 200, noSalesCount: 0, overstockCount: 0, deficitCount: 0, frozen30Cost: 0, frozen60Cost: 0, frozen90Cost: 0, costCoveragePct: 100, stockCoveragePct: 100 },
    options: { stores: [{ key: "store", name: "Магазин" }], warehouses: [{ key: "wh", name: "Склад", storeKey: "store" }], categories: [{ key: "beer", name: "Пиво" }], brands: [], skus: [{ key: "item", name: "=1+1" }] },
    coverage: { firstStockDate: "2026-09-28", lastStockDate: "2026-09-30", firstSalesDate: "2026-06-01", lastSalesDate: "2026-09-30", missingStockDates: [], observedDays: 3, expectedDays: 3, requestedTo: null },
    methodology: ["Стоимость по себестоимости на дату; розничная выручка отдельно."], warnings: [], generatedAt: "2026-10-01T01:00:00Z"
  };
}
async function load(report: TurnoverReport, fixtureName?: string) {
  const stream = new PassThrough();
  const [, bytes] = await Promise.all([writeTurnoverWorkbook(report, stream), buffer(stream)]);
  if (fixtureName && process.env.TURNOVER_WORKBOOK_FIXTURE_DIR) {
    await mkdir(process.env.TURNOVER_WORKBOOK_FIXTURE_DIR, { recursive: true });
    await writeFile(join(process.env.TURNOVER_WORKBOOK_FIXTURE_DIR, fixtureName), bytes);
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}

function sheetValues(sheet: ExcelJS.Worksheet): ExcelJS.CellValue[] {
  const values: ExcelJS.CellValue[] = [];
  sheet.eachRow(row => row.eachCell(cell => values.push(cell.value)));
  return values;
}

function namedRow(sheet: ExcelJS.Worksheet, label: string): ExcelJS.Row {
  let found: ExcelJS.Row | undefined;
  sheet.eachRow(row => { if (row.getCell(1).value === label) found = row; });
  assert.ok(found, `missing summary row: ${label}`);
  return found;
}

function rowValues(row: ExcelJS.Row): ExcelJS.CellValue[] {
  return (row.values as ExcelJS.CellValue[]).slice(1);
}

test("standard calculation sheets use authoritative totals rather than summing the displayed products", async () => {
  for (const profile of ["sample", "summary"] as const) for (const mode of ["quantity", "money", "both"] as const) {
    const report = fixture(mode);
    Object.assign(report.params, { profile, sort: "name" });
    report.totals.overall = {
      ...report.totals.overall, openingQty: 20, closingQty: 40, averageQty: 40,
      openingCost: 200, closingCost: 500, averageCost: 400,
      periodSales: { ...sales, quantity: 100, cost: 1250, revenue: 1777 },
      turnoverQty: 2.5, turnoverQtyDays: 1.2, turnoverCost: 3.125, turnoverCostDays: 0.96,
      daily: row.daily.map((day, index) => ({
        ...day, quantity: [20, 50, 40][index], stockCost: [200, 450, 500][index]
      }))
    };
    report.summary.rowCount = 999;
    const workbook = await load(report, `turnover-standard-${profile}-${mode}.xlsx`);
    const mains = workbook.worksheets.filter(sheet => sheet.name.startsWith("рассчет"));
    assert.equal(mains.length, mode === "both" ? 2 : 1);
    for (const main of mains) {
      const money = mode === "money" || main.name.endsWith("деньги");
      const footer = namedRow(main, "ИТОГО");
      assert.equal(footer.getCell(8).value.result, money ? 400 : 40);
      assert.equal(footer.getCell(9).value.result, money ? 3.125 : 2.5);
      assert.equal(footer.getCell(10).value, 3);
      assert.equal(footer.getCell(11).value.result, money ? 1250 : 100);
      assert.equal(footer.getCell(12).value.result, money ? 0.96 : 1.2);
      assert.equal(namedRow(main, "=1+1").getCell(11).value.result, money ? 120 : 12);
      assert.equal(main.columnCount, 12);
      assert.equal(sheetValues(main).includes(1777), false, "retail revenue must not replace cost sales");
    }
    assert.equal(workbook.worksheets.length, mode === "both" ? 4 : 2);
  }
});

test("standard totals preserve mixed units, signed returns, numeric zero and unavailable values in both modes", async () => {
  for (const profile of ["sample", "summary"] as const) {
    const report = fixture("both");
    Object.assign(report.params, { profile, sort: "name", includeIncomplete: true });
    const overall = report.totals.overall;
    report.totals.byUnit = [
      { ...overall, unit: "л", unitKey: "litre", periodSales: { ...sales, quantity: 0, cost: 0 },
        turnoverQty: 0, turnoverQtyDays: null, turnoverCost: 0, turnoverCostDays: null },
      { ...overall, unit: "шт", unitKey: "unit:pieces", periodSales: { ...sales, quantity: -3, cost: -30 },
        turnoverQty: null, turnoverQtyDays: null }
    ];
    report.totals.overall = {
      ...overall, unit: null, openingQty: null, closingQty: null, averageQty: null,
      periodSales: { ...sales, quantity: null, cost: 0, revenue: 0 },
      turnoverQty: null, turnoverQtyDays: null, turnoverCost: Infinity, turnoverCostDays: NaN,
      daily: row.daily.map(day => ({ ...day, quantity: null }))
    };
    if (profile === "summary") report.totals.byStore = [
      { storeKey: row.storeKey, total: report.totals.overall, byUnit: report.totals.byUnit }
    ];
    const workbook = await load(report);
    const quantity = workbook.getWorksheet("рассчет оборачиваемости")!;
    const money = workbook.getWorksheet("рассчет оборачиваемости деньги")!;
    const unitLabels = ["ИТОГО · л", "ИТОГО · шт"];
    const storeLabels = ["ИТОГО по магазину · л", "ИТОГО по магазину · шт"];
    assert.deepEqual(sheetValues(quantity).filter(value => typeof value === "string" && value.startsWith("ИТОГО")),
      profile === "summary" ? [...storeLabels, ...unitLabels] : unitLabels);
    assert.deepEqual(unitLabels.map(label => namedRow(quantity, label).getCell(11).result), [0, -3]);
    const quantitySales = workbook.getWorksheet("Продажи за период ")!;
    assert.deepEqual(unitLabels.map(label => namedRow(quantitySales, label).getCell(2).value), [0, -3]);
    if (profile === "summary") assert.deepEqual(storeLabels.map(label => namedRow(quantity, label).getCell(11).result), [0, -3]);
    assert.deepEqual(sheetValues(money).filter(value => typeof value === "string" && value.startsWith("ИТОГО")),
      profile === "summary" ? ["ИТОГО по магазину", "ИТОГО"] : ["ИТОГО"]);
    assert.equal(namedRow(money, "ИТОГО").getCell(11).result, 0);
    assert.equal(namedRow(money, "ИТОГО").getCell(9).value, "n/a");
    assert.equal(namedRow(money, "ИТОГО").getCell(12).value, "n/a");
    const moneySales = workbook.getWorksheet("Продажи за период в деньгах")!;
    assert.equal(namedRow(moneySales, "ИТОГО").getCell(3).type, ExcelJS.ValueType.Number);
    assert.equal(namedRow(moneySales, "ИТОГО").getCell(3).value, 0);
    assert.equal(namedRow(moneySales, "ИТОГО").getCell(2).value, "n/a");
  }
});

test("output errors still reject standard and analytical downloads", async () => {
  for (const profile of ["sample", "summary", "full"] as const) {
    const report = fixture("both");
    Object.assign(report.params, { profile, sort: "name" });
    const output = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error("Excel download failed")); }
    });
    await assert.rejects(writeTurnoverWorkbook(report, output), /Excel download failed/);
    assert.equal(output.destroyed, true);
  }
});

test("turnover XLSX preserves numeric cost basis, leading-zero identity and safe text cells", async () => {
  const workbook = await load(fixture("both"));
  const sheet = workbook.getWorksheet("Оборачиваемость")!;
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
  const main = workbook.getWorksheet("Оборачиваемость")!;
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
  const main = workbook.getWorksheet("рассчет оборачиваемости")!;
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
  assert.deepEqual(main.getCell("G2").value, { formula: 'SUMIF(C2:E2,">0")', result: 30 });
  assert.deepEqual(main.getCell("H2").value, { formula: 'IF(G2=0,0,G2/(COUNTIF(C2:E2,">0")-IF(C2>0,0.5,0)-IF(E2>0,0.5,0)))', result: 15 });
  assert.deepEqual(main.getCell("I2").value, { formula: "K2/H2", result: 0.8 });
  assert.equal(main.getCell("J2").value, 3);
  assert.deepEqual(main.getCell("K2").value, { formula: "VLOOKUP(A2,'Продажи за период '!A2:B2,2,0)", result: 12 });
  assert.deepEqual(main.getCell("L2").value, { formula: "J2/I2", result: 3.75 });
  for (const address of ["H2", "I2", "J2", "L2"]) assert.equal(main.getCell(address).numFmt, "0.00");
  assert.equal(main.pageSetup.orientation, "landscape");
  assert.equal(main.pageSetup.paperSize, 9);
  assert.equal(main.views[0]?.state, "normal");
  assert.equal(main.views[0]?.ySplit, undefined);
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
  const main = workbook.getWorksheet("рассчет оборачиваемости ")!;
  assert.equal(main.getCell("B2").value, 100);
  assert.equal(main.getCell("D2").value, 150);
  assert.equal(main.getCell("F2").value, 200);
  assert.equal(main.getCell("H2").result, 150);
  assert.deepEqual(main.getCell("I2").value, { formula: "K2/H2", result: 0.8 });
  assert.deepEqual(main.getCell("K2").value, { formula: "VLOOKUP(A2,'Продажи за период '!A1:C1,3,0)", result: 120 });
  assert.deepEqual(main.getCell("L2").value, { formula: "J2/I2", result: 3.75 });
  assert.equal(main.views[0]?.state, "normal");
  assert.equal(main.views[0]?.ySplit, undefined);
  assert.equal(main.autoFilter, "A1:L1");
  const sales = workbook.getWorksheet("Продажи за период ")!;
  assert.equal(sales.getColumn(1).width, 66.85546875);
  assert.equal(sales.getColumn(2).width, 12.42578125);
  assert.equal(sales.getColumn(3).width, 19.140625);
  assert.equal(sales.getCell("A1").value, "=1+1");
  assert.equal(sales.getCell("B1").value, 12);
  assert.equal(sales.getCell("C1").value, 120);
  assert.equal(sales.getCell("A2").value, "ИТОГО");
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
  assert.equal(workbook.getWorksheet("рассчет оборачиваемости")!.getCell("K2").value.formula, "VLOOKUP(A2,'Продажи за период '!A2:B2,2,0)");
  assert.equal(workbook.getWorksheet("рассчет оборачиваемости деньги")!.getCell("K2").value.formula, "VLOOKUP(A2,'Продажи за период в деньгах'!A1:C1,3,0)");
});

test("sample exports keep product labels independent of shops and withhold mixed-unit quantity totals", async () => {
  const report = fixture("money");
  report.params.profile = "sample";
  report.params.includeIncomplete = true;
  report.params.store = [];
  report.rows.push({
    ...row, key: "other:item", sku: "other", name: "Другой товар", storeKey: "second", storeName: "Второй магазин",
    unit: "шт", daily: row.daily.map((day) => ({ ...day, unit: "шт" }))
  });
  const unitTotal = report.totals.overall;
  report.totals.byUnit = [{ ...unitTotal, unitKey: "litre" }, { ...unitTotal, unit: "шт", unitKey: "piece" }];
  report.totals.overall = { ...unitTotal, unit: null, openingQty: null, closingQty: null, averageQty: null,
    turnoverQty: null, turnoverQtyDays: null, stockDays: null, excessQty: null, deficitQty: null,
    recommendedOrderQty: null, openOrderQty: null, openingCost: 200, closingCost: 400, averageCost: 300,
    periodSales: { quantity: null, cost: 240, revenue: 360, averageDailyQty: null, averageDailyCost: 120 },
    daily: row.daily.map(d => ({ ...d, quantity: null, stockCost: d.stockCost! * 2 })) };
  const workbook = await load(report);
  const main = workbook.getWorksheet("рассчет оборачиваемости ")!;
  assert.equal(main.getCell("A2").value, row.name);
  assert.equal(main.getCell("A3").value, "Другой товар");
  const sales = workbook.getWorksheet("Продажи за период ")!;
  assert.equal(sales.lastRow!.getCell(1).value, "ИТОГО");
  assert.equal(sales.lastRow!.getCell(2).value, "n/a");
  assert.equal(sales.lastRow!.getCell(3).value, 240);
});

test("money-only export preserves unknown costs and the exact applied filter and category norms", async () => {
  const report = fixture("money");
  report.params.includeIncomplete = true;
  report.rows[0].averageCost = null;
  report.totals.overall.averageCost = null;
  report.totals.overall.turnoverCost = null;
  report.totals.overall.turnoverCostDays = null;
  const workbook = await load(report);
  const main = workbook.getWorksheet("Оборачиваемость")!;
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
  assert.equal(daily.getCell("D5").value, null, "an optional missing SKU is blank, not unavailable financial data");
  assert.equal(daily.getCell("G5").value, 0.5);
  assert.equal(daily.getCell("H5").value, 10);
  assert.equal(daily.getCell("I5").value, 100);
  assert.equal(daily.getCell("H7").value, 20);
});

test("turnover coefficients classify raw boundaries without colouring missing or nonfinite values", () => {
  for (const [value, expected] of [[0, "red"], [1, "red"], [1.999, "red"], [2, "orange"], [2.999, "orange"], [3, "green"], [4, "green"], [null, null], [NaN, null], [Infinity, null]] as const) {
    assert.equal(turnoverCoefficientBand(value), expected);
  }
});

test("every workbook profile and mode ends its main table with server totals outside the filter", async () => {
  for (const profile of ["sample", "summary", "full"] as const) for (const mode of ["quantity", "money", "both"] as const) {
    const report = fixture(mode);
    report.params.profile = profile;
    const workbook = await load(report);
    const mains = workbook.worksheets.filter(s => s.name.startsWith(profile === "sample" ? "рассчет" : "Оборачиваемость"));
    for (const main of mains) {
      const footer = main.lastRow!;
      assert.equal(footer.getCell(profile === "sample" ? 1 : 7).value, "ИТОГО");
      if (profile === "sample") {
        assert.equal(footer.getCell(10).value, 3);
        assert.equal(footer.getCell(9).value.result, 0.8);
        assert.equal(footer.getCell(12).value.result, 3.75);
        assert.doesNotMatch(footer.getCell(11).value.formula ?? "", /VLOOKUP/);
        assert.equal(footer.getCell(3).value.result, mode === "money" || main.name.endsWith("деньги") ? 50 : 5);
      } else {
        assert.equal(main.autoFilter, `A4:${main.getColumn(main.columnCount).letter}${footer.number - 1}`);
      }
    }
    if (profile === "sample") {
      for (const sales of workbook.worksheets.filter(s => s.name.startsWith("Продажи"))) assert.equal(sales.lastRow!.getCell(1).value, "ИТОГО");
    }
  }
});

test("sample footer recomputes coefficient 2.5 with N3 once and never looks up a product named ИТОГО", async () => {
  const report = fixture("quantity");
  report.params.profile = "sample";
  report.rows = [
    { ...row, name: "ИТОГО", key: "one", sku: "one", averageQty: 10, periodSales: { ...sales, quantity: 10 }, turnoverQty: 1 },
    { ...row, name: "Other", key: "two", sku: "two", averageQty: 30, periodSales: { ...sales, quantity: 90 }, turnoverQty: 3 }
  ];
  report.totals.overall = { ...report.totals.overall, openingQty: 20, closingQty: 40, averageQty: 40,
    periodSales: { ...sales, quantity: 100 }, turnoverQty: 2.5, turnoverQtyDays: 1.2,
    daily: row.daily.map((d, index) => ({ ...d, quantity: [20, 50, 40][index] })) };
  const main = (await load(report)).getWorksheet("рассчет оборачиваемости")!;
  assert.equal(main.getCell("A2").value, "ИТОГО");
  assert.equal(main.getCell("A4").value, "ИТОГО");
  assert.equal(main.getCell("H4").value.result, 40);
  assert.equal(main.getCell("I4").value.result, 2.5);
  assert.equal(main.getCell("J4").value, 3);
  assert.equal(main.getCell("K4").value.result, 100);
  assert.equal(main.getCell("L4").value.result, 1.2);
  assert.doesNotMatch(main.getCell("K4").value.formula ?? "", /VLOOKUP/);
  assert.equal(main.getCell("K2").value.formula, "VLOOKUP(A2,'Продажи за период '!A2:B2,2,0)");
});

test("coefficient fills and conditional rules cover data and totals, not turnover days", async () => {
  for (const profile of ["sample", "summary"] as const) {
    const report = fixture("both");
    report.params.profile = profile;
    report.params.includeIncomplete = true;
    const values = [0, 1.999, 2, 2.999, 3, null, NaN, Infinity];
    report.rows = values.map((value, i) => ({ ...row, key: `row${i}`, sku: `sku${i}`, name: `Item ${i}`, turnoverQty: value, turnoverCost: value }));
    report.totals.overall.turnoverQty = 2.5;
    report.totals.overall.turnoverCost = 2.5;
    const stream = new PassThrough();
    const [, bytes] = await Promise.all([writeTurnoverWorkbook(report, stream), buffer(stream)]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const main = workbook.getWorksheet(profile === "sample" ? "рассчет оборачиваемости" : "Оборачиваемость")!;
    const coefficient = profile === "sample" ? 9 : 14;
    const days = profile === "sample" ? 12 : 15;
    const first = profile === "sample" ? 2 : 5;
    const colors = ["FFFEE2E2", "FFFEE2E2", "FFFFEDD5", "FFFFEDD5", "FFDCFCE7"];
    for (let i = 0; i < values.length; i++) {
      const cell = main.getRow(first + i).getCell(coefficient);
      assert.equal((cell.fill as ExcelJS.FillPattern)?.fgColor?.argb, colors[i]);
      assert.equal((main.getRow(first + i).getCell(days).fill as ExcelJS.FillPattern)?.fgColor?.argb, undefined);
    }
    assert.equal((main.lastRow!.getCell(coefficient).fill as ExcelJS.FillPattern).fgColor?.argb, "FFFFEDD5");
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file(`xl/worksheets/sheet${main.id}.xml`)!.async("string");
    assert.match(xml, /conditionalFormatting/);
    assert.match(xml, /ISNUMBER/);
    assert.match(xml, /&lt;2/);
    assert.match(xml, /&gt;=2/);
    assert.match(xml, /&lt;3/);
    assert.match(xml, /&gt;=3/);
  }
});

test("analytical day footer exposes distinct opening closing average and sales in every mode", async () => {
  for (const mode of ["quantity", "money", "both"] as const) {
    const report = fixture(mode);
    report.params.groupBy = "day";
    const main = (await load(report)).getWorksheet("Оборачиваемость")!;
    const footer = main.lastRow!;
    assert.equal(footer.getCell(1).value, "ИТОГО");
    assert.equal(footer.getCell(2).value, "л");
    assert.equal(footer.getCell(3).value, null);
    const headers = main.getRow(4);
    const column = (label: string) => {
      let found = 0;
      headers.eachCell((cell, index) => { if (cell.value === label) found = index; });
      assert.ok(found > 0, `missing period metric: ${label}`);
      return found;
    };
    for (const [label, expected] of [
      ...(mode !== "money" ? [["Остаток, единица строки", 20], ["Начальный остаток периода", 10], ["Средний остаток периода", 15], ["Нетто продажи, единица строки", 12]] as const : []),
      ...(mode !== "quantity" ? [["Стоимость остатка, ₸", 200], ["Стоимость начального остатка периода, ₸", 100], ["Средняя стоимость запаса периода, ₸", 150], ["Себестоимость продаж, ₸", 120]] as const : [])
    ]) {
      const index = column(label);
      assert.equal(footer.getCell(index).value, expected);
      if (label.includes("периода")) assert.equal(main.getRow(5).getCell(index).value, null);
    }
  }
});

test("analytical splitting keeps one footer on the last part including an exactly full part", async () => {
  for (const count of [10000, 10001]) {
    const report = fixture("quantity");
    report.params.profile = "summary";
    report.rows = Array<TurnoverRow>(count).fill(row);
    const workbook = await load(report);
    const mains = workbook.worksheets.filter(s => s.name.startsWith("Оборачиваемость"));
    assert.equal(mains.length, count === 10000 ? 1 : 2);
    let footers = 0;
    for (const main of mains) main.eachRow(r => { if (r.getCell(7).value === "ИТОГО") footers++; });
    assert.equal(footers, 1);
    assert.equal(mains.at(-1)!.lastRow!.getCell(7).value, "ИТОГО");
  }
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

test("standard network and store downloads stop reading products on backpressure and reject a disconnect", async () => {
  for (const profile of ["sample", "summary"] as const) {
    const report = fixture("quantity");
    Object.assign(report.params, { profile, sort: "name" });
    let consumed = 0;
    report.rows = Array.from({ length: 30_000 }, (_, index) => ({
      ...row, key: String(index), windows: [],
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
    generation.catch(() => undefined);
    try {
      await firstChunk;
      for (let turn = 0; turn < 200; turn++) await setImmediate();
      assert.ok(consumed < report.rows.length, `${profile} consumed ${consumed} products while output was stalled`);
    } finally {
      stalled.destroy();
      release?.();
      await assert.rejects(generation, /closed|abort/i);
    }
  }
});

test("standard store projection preserves incomplete opt-in and never restores unavailable population totals", async () => {
  const report = fixture("quantity");
  Object.assign(report.params, { profile: "summary", sort: "name" });
  report.rows.push({ ...row, key: "missing", name: "Не рассчитан", turnoverQtyDays: null });
  const workbook = await load(report);
  const main = workbook.getWorksheet("рассчет оборачиваемости")!;
  assert.equal(sheetValues(main).includes("Не рассчитан"), false);
  assert.equal(namedRow(main, "ИТОГО").getCell(11).value, null);
  assert.equal(namedRow(main, "ИТОГО").getCell(8).value, null);
  report.params.includeIncomplete = true;
  const complete = (await load(report)).getWorksheet("рассчет оборачиваемости")!;
  assert.equal(namedRow(complete, "Не рассчитан").getCell(12).value, "n/a");
  assert.equal(namedRow(complete, "ИТОГО").getCell(11).value.result, 12);
});

test("every default workbook profile filters raw incomplete DTO rows and withholds stale population totals without optional identity rejection", async () => {
  for (const profile of ["sample", "summary", "full"] as const) for (const mode of ["quantity", "money", "both"] as const) {
    const report = fixture(mode);
    report.params.profile = profile;
    report.rows = [
      { ...row, name: "Complete without optional identity", sku: null, article: null, barcodes: [], nextDeliveryDate: null,
        daily: row.daily.map(day => ({ ...day, salesQty: day.salesQty === 2 ? -2 : day.salesQty })) },
      { ...row, key: "incomplete", name: "Hidden incomplete source", openingQty: null, openingCost: null },
      { ...row, key: "nonfinite", name: "Hidden nonfinite source", turnoverQty: Infinity, turnoverCostDays: NaN }
    ];
    report.warnings = ["Original source warning retained"];
    const workbook = await load(report);
    for (const sheet of workbook.worksheets) {
      const values = sheetValues(sheet);
      assert.equal(values.includes("Hidden incomplete source"), false);
      assert.equal(values.includes("Hidden nonfinite source"), false);
      assert.equal(values.includes("n/a"), false, `${profile}/${mode}/${sheet.name} must not leak unavailable cells`);
    }
    const main = profile === "sample" ? workbook.worksheets[0] : workbook.getWorksheet("Оборачиваемость")!;
    if (profile === "sample") {
      assert.equal(main.lastRow!.getCell(11).value, null, "stale population totals must be withheld");
    } else {
      const values = sheetValues(workbook.getWorksheet("Параметры и методика")!);
      assert.ok(values.includes("Original source warning retained"));
      assert.ok(values.includes(2), "excluded population count remains in the analytical parameters");
    }
    assert.ok(sheetValues(main).includes("Complete without optional identity"));
    if (profile !== "sample") {
      const headers = main.getRow(4).values as unknown[];
      for (const label of ["SKU (ключ 1С)", "Артикул"]) assert.equal(main.getRow(5).getCell(headers.indexOf(label)).value, null);
      const delivery = headers.indexOf("Ближайшая ожидаемая поставка");
      assert.equal(main.getRow(5).getCell(delivery).value, null);
    }
    report.params.includeIncomplete = true;
    const original = await load(report);
    const originalMain = profile === "sample" ? original.worksheets[0] : original.getWorksheet("Оборачиваемость")!;
    assert.ok(sheetValues(originalMain).includes("Hidden incomplete source"));
    assert.ok(sheetValues(originalMain).includes("Hidden nonfinite source"));
  }
});

test("already-filtered server totals survive writer projection and an all-filtered raw DTO never invents zero", async () => {
  for (const profile of ["sample", "summary", "full"] as const) {
    const report = fixture("both");
    report.params.profile = profile;
    report.excludedIncompleteRows = 4;
    report.totals.overall.periodSales = { ...sales, quantity: 99, cost: 990 };
    const book = await load(report);
    const main = profile === "sample" ? book.worksheets[0] : book.getWorksheet("Оборачиваемость")!;
    const salesColumn = profile === "sample" ? 11 : profile === "summary" ? 12 : 13;
    assert.equal(profile === "sample" ? main.lastRow!.getCell(salesColumn).value.result : main.lastRow!.getCell(salesColumn).value, 99);
    report.rows = [{ ...row, turnoverQtyDays: null }];
    const empty = await load(report);
    const emptyMain = profile === "sample" ? empty.worksheets[0] : empty.getWorksheet("Оборачиваемость")!;
    assert.equal(emptyMain.lastRow!.getCell(salesColumn).value, null);
    for (const sheet of empty.worksheets) assert.equal(sheetValues(sheet).includes("n/a"), false);
  }
});

test("default aggregate incompatibility leaves unavailable numeric cells blank rather than a zero or marker", async () => {
  for (const profile of ["sample", "summary", "full"] as const) {
    const report = fixture("quantity");
    report.params.profile = profile;
    report.totals.byUnit = [{ ...report.totals.overall, unit: "л", unitKey: "litre" }];
    report.totals.overall = { ...report.totals.overall, unit: null, openingQty: null, closingQty: null,
      averageQty: null, turnoverQty: null, turnoverQtyDays: null,
      periodSales: { ...sales, quantity: null, averageDailyQty: null }, daily: [] };
    const book = await load(report);
    for (const sheet of book.worksheets) assert.equal(sheetValues(sheet).includes("n/a"), false);
    const main = profile === "sample" ? book.worksheets[0] : book.getWorksheet("Оборачиваемость")!;
    const salesColumn = profile === "sample" ? 11 : profile === "summary" ? 12 : 13;
    if (profile === "sample") {
      assert.equal(main.lastRow!.getCell(1).value, "ИТОГО · л");
      assert.equal(main.lastRow!.getCell(salesColumn).result, 12);
    } else {
      assert.equal(main.lastRow!.getCell(salesColumn).value, null);
      assert.equal(main.getRow(main.lastRow!.number - 1).getCell(salesColumn).value, 12);
    }
  }
});

test("opt-in sample formulas retain original unavailable guards and cached financial results", async () => {
  const report = fixture("both");
  report.params.profile = "sample";
  report.params.includeIncomplete = true;
  report.rows.push({ ...row, key: "unknown", name: "Unavailable financial row", averageQty: null, averageCost: null,
    periodSales: { quantity: null, cost: null, revenue: null, averageDailyQty: null, averageDailyCost: null },
    turnoverQty: null, turnoverQtyDays: null, turnoverCost: null, turnoverCostDays: null,
    daily: row.daily.map(day => ({ ...day, quantity: null, stockCost: null })) });
  const book = await load(report);
  for (const sheetName of ["рассчет оборачиваемости", "рассчет оборачиваемости деньги"]) {
    const sheet = book.getWorksheet(sheetName)!;
    for (const address of ["G3", "H3", "I3", "K3", "L3"]) assert.equal(sheet.getCell(address).value, "n/a");
    assert.match(sheet.getCell("I4").value.formula, /IF\(AND\(ISNUMBER\(K4\),ISNUMBER\(H4\),K4>=0,H4>0\),K4\/H4,"n\/a"\)/);
    assert.match(sheet.getCell("L4").value.formula, /IF\(AND\(ISNUMBER\(I4\),I4>0\),J4\/I4,"n\/a"\)/);
    assert.equal(sheet.getCell("I4").value.result, 0.8);
    assert.equal(sheet.getCell("L4").value.result, 3.75);
  }
});

test("standard sections share actual calculation and sales row positions without renaming homonymous products", async () => {
  const report = fixture("both");
  Object.assign(report.params, { profile: "summary", sort: "name" });
  report.rows = [
    { ...row, key: "s1:a", storeKey: "s1", storeName: "Одинаковый магазин", name: "=Один товар",
      rootGroupKey: "g1", rootGroupName: "Пиво", periodSales: { ...sales, quantity: 11, cost: 110 },
      turnoverQty: 11 / 15, turnoverCost: 110 / 150, turnoverQtyDays: 45 / 11, turnoverCostDays: 450 / 110 },
    { ...row, key: "s1:b", storeKey: "s1", storeName: "Одинаковый магазин", name: "=Один товар",
      rootGroupKey: "g2", rootGroupName: "Пиво", periodSales: { ...sales, quantity: 22, cost: 220 },
      turnoverQty: 22 / 15, turnoverCost: 220 / 150, turnoverQtyDays: 45 / 22, turnoverCostDays: 450 / 220 },
    { ...row, key: "s2:a", storeKey: "s2", storeName: "Одинаковый магазин", name: "=Один товар",
      rootGroupKey: "g1", rootGroupName: "Пиво", periodSales: { ...sales, quantity: 33, cost: 330 },
      turnoverQty: 33 / 15, turnoverCost: 330 / 150, turnoverQtyDays: 45 / 33, turnoverCostDays: 450 / 330 }
  ];
  report.totals.byStore = [
    { storeKey: "s2", byUnit: [], total: { ...report.totals.overall, periodSales: { ...sales, quantity: 44, cost: 440 },
      turnoverQty: 44 / 15, turnoverCost: 440 / 150, turnoverQtyDays: 45 / 44, turnoverCostDays: 450 / 440 } },
    { storeKey: "s1", byUnit: [], total: { ...report.totals.overall, periodSales: { ...sales, quantity: 33, cost: 330 },
      turnoverQty: 33 / 15, turnoverCost: 330 / 150, turnoverQtyDays: 45 / 33, turnoverCostDays: 450 / 330 } }
  ];
  const workbook = await load(report, "turnover-standard-homonyms.xlsx");
  for (const [mainName, salesName, offset, salesColumn, expected] of [
    ["рассчет оборачиваемости", "Продажи за период ", 0, "B", [11, 22, 33]],
    ["рассчет оборачиваемости деньги", "Продажи за период в деньгах", -1, "C", [110, 220, 330]]
  ] as const) {
    const main = workbook.getWorksheet(mainName)!;
    const salesSheet = workbook.getWorksheet(salesName)!;
    const dataRows: number[] = [];
    main.eachRow(r => { if (r.getCell(1).value === "=Один товар") dataRows.push(r.number); });
    assert.deepEqual(dataRows, [4, 6, 10]);
    assert.equal(sheetValues(main).filter(value => value === "Одинаковый магазин").length, 2);
    assert.equal(sheetValues(main).filter(value => value === "Пиво").length, 3);
    for (let index = 0; index < dataRows.length; index++) {
      const number = dataRows[index];
      const source = number + offset;
      assert.equal(main.getCell(`A${number}`).type, ExcelJS.ValueType.String);
      assert.equal(salesSheet.getCell(`A${source}`).value, "=Один товар");
      assert.equal(salesSheet.getCell(`${salesColumn}${source}`).value, expected[index]);
      assert.deepEqual(main.getCell(`K${number}`).value, {
        formula: `VLOOKUP(A${number},'${salesName}'!A${source}:${salesColumn}${source},${salesColumn === "B" ? 2 : 3},0)`,
        result: expected[index]
      });
      assert.deepEqual(main.getCell(`G${number}`).value, {
        formula: `SUMIF(C${number}:E${number},">0")`, result: salesColumn === "B" ? 30 : 300
      });
      assert.deepEqual(main.getCell(`I${number}`).value, {
        formula: `K${number}/H${number}`, result: expected[index] / (salesColumn === "B" ? 15 : 150)
      });
      assert.deepEqual(main.getCell(`L${number}`).value, {
        formula: `J${number}/I${number}`, result: (salesColumn === "B" ? 45 : 450) / expected[index]
      });
    }
    for (const [number, quantity] of [[7, 33], [11, 44]]) {
      assert.equal(main.getCell(`A${number}`).value, "ИТОГО по магазину");
      assert.equal(main.getCell(`K${number}`).result, salesColumn === "B" ? quantity : quantity * 10);
      assert.equal(salesSheet.getCell(`A${number + offset}`).value, "ИТОГО по магазину");
    }
    assert.equal(main.lastRow!.number, 12);
    assert.equal(main.lastRow!.getCell(11).value.formula, `'${salesName}'!${salesColumn}${12 + offset}`);
    assert.equal(main.lastRow!.getCell(11).value.result, salesColumn === "B" ? 12 : 120);
    for (const number of [2, 3, 5, 8, 9]) {
      assert.equal(main.getRow(number).getCell(2).value, null, "section leaves the original numeric columns empty");
      assert.equal(salesSheet.getRow(number + offset).getCell(1).value, main.getRow(number).getCell(1).value);
    }
  }
});

test("standard section identities keep real and unknown groups separate without store sections in network exports", async () => {
  for (const profile of ["sample", "summary"] as const) {
    const report = fixture("quantity");
    Object.assign(report.params, { profile, sort: "name", includeIncomplete: true });
    report.rows = [
      { ...row, key: "a", name: "А", rootGroupKey: "g1", rootGroupName: "Без группы" },
      { ...row, key: "b", name: "Б", rootGroupKey: "g2", rootGroupName: "Без группы" },
      { ...row, key: "c", name: "В", rootGroupKey: null, rootGroupName: "Без группы", turnoverQty: null },
      { ...row, key: "d", name: "Я", storeKey: null, storeName: "", rootGroupKey: "g1", rootGroupName: "" }
    ];
    const workbook = await load(report);
    for (const sheet of workbook.worksheets) {
      const values = sheetValues(sheet);
      const labels: string[] = [];
      sheet.eachRow(r => { if (typeof r.getCell(1).value === "string") labels.push(r.getCell(1).value as string); });
      assert.equal(labels.filter(value => value === "Без группы").length, 3);
      assert.ok(labels.includes("Группа без названия"));
      assert.equal(labels.includes("Магазин"), profile === "summary");
      assert.equal(labels.includes("Магазин не определён"), profile === "summary");
      assert.deepEqual(labels.filter(value => ["А", "Б", "В", "Я"].includes(value)), ["А", "Б", "В", "Я"]);
      assert.equal(values.includes("g1"), false);
    }
    const main = workbook.getWorksheet("рассчет оборачиваемости")!;
    assert.equal(namedRow(main, "В").getCell(9).value, "n/a");
    assert.equal((namedRow(main, "В").getCell(9).fill as ExcelJS.FillPattern)?.fgColor?.argb, undefined);
    report.rows = [];
    const empty = await load(report);
    for (const sheet of empty.worksheets) assert.equal(sheetValues(sheet).includes("Без группы"), false);
  }
});

test("analytical requests retain original analytical sheets without added presentation worksheets", async () => {
  for (const overrides of [
    { profile: "full" as const, sort: "name" as const },
    { profile: "summary" as const, sort: "turnover" as const },
    { profile: "summary" as const, sort: "name" as const, groupBy: "store" as const }
  ]) {
    const report = fixture("quantity");
    Object.assign(report.params, overrides);
    const workbook = await load(report);
    assert.equal(workbook.worksheets[0].name, "Оборачиваемость");
    assert.equal(workbook.getWorksheet("Кратко"), undefined);
    assert.equal(workbook.getWorksheet("Товары"), undefined);
    assert.ok(workbook.getWorksheet("Параметры и методика"));
  }
});

test("standard shop export uses only the original calculation and sales sheets", async () => {
  for (const mode of ["quantity", "money", "both"] as const) {
    const report = fixture(mode);
    Object.assign(report.params, { profile: "summary", groupBy: "sku", sort: "name" });
    const workbook = await load(report);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), mode === "both"
      ? ["рассчет оборачиваемости", "Продажи за период ", "рассчет оборачиваемости деньги", "Продажи за период в деньгах"]
      : [mode === "money" ? "рассчет оборачиваемости " : "рассчет оборачиваемости", "Продажи за период "]);
    const main = workbook.worksheets[0];
    assert.deepEqual(rowValues(main.getRow(1)), [
      "Номенклатура ", "28.09.", "28.09. / 2", "29.09.", "30.09. / 2", "30.09.",
      "сумма остатков за период ", "средний товарный запас в шт ", "Коэффицент оборачиваемости",
      "количество дней в периоде ", "продажи в шт за период ", "количесто дней оборота в шт "
    ]);
    assert.equal(main.getColumn(1).width, 65.5703125);
    assert.equal(main.getColumn(2).width, 9.140625);
    assert.equal(main.getColumn(7).width, 26.7109375);
    assert.equal(main.getColumn(12).width, 29.28515625);
    assert.equal(main.columnCount, 12);
  }
});

test("standard sales sheets retain server group order rather than sorting product names independently", async () => {
  const report = fixture("quantity");
  Object.assign(report.params, { profile: "summary", sort: "name" });
  report.rows = [
    { ...row, key: "one", name: "Яблоко", rootGroupKey: "g1", rootGroupName: "Бакалея",
      periodSales: { ...sales, quantity: 11 } },
    { ...row, key: "two", name: "Абрикос", rootGroupKey: "g2", rootGroupName: "Пиво",
      periodSales: { ...sales, quantity: 22 } }
  ];
  const workbook = await load(report);
  const main = workbook.getWorksheet("рассчет оборачиваемости")!;
  const salesSheet = workbook.getWorksheet("Продажи за период ")!;
  for (const [number, name, quantity] of [[4, "Яблоко", 11], [6, "Абрикос", 22]] as const) {
    assert.equal(main.getCell(`A${number}`).value, name);
    assert.equal(salesSheet.getCell(`A${number}`).value, name);
    assert.equal(salesSheet.getCell(`B${number}`).value, quantity);
    assert.equal(main.getCell(`K${number}`).value.result, quantity);
    assert.equal(main.getCell(`K${number}`).value.formula, `VLOOKUP(A${number},'Продажи за период '!A${number}:B${number},2,0)`);
  }
});

test("standard Excel recalculates average from in-stock days without changing the daily columns or period length", async () => {
  const report = fixture("both");
  report.params.profile = "sample";
  const daily = row.daily.map((day, index) => ({ ...day, quantity: [0, 20, -4][index]!, stockCost: [0, 200, -40][index]! }));
  report.rows = [{ ...row, daily, averageQty: 20, averageCost: 200,
    turnoverQty: 0.6, turnoverCost: 0.6, turnoverQtyDays: 5, turnoverCostDays: 5 }];
  const book = await load(report, "turnover-availability-formulas.xlsx");
  for (const [sheet, scale] of [[book.worksheets[0]!, 1], [book.worksheets[2]!, 10]] as const) {
    assert.equal(sheet.getCell("B2").value, 0);
    assert.equal(sheet.getCell("F2").value, -4 * scale);
    assert.equal(sheet.getCell("G2").result, 20 * scale);
    assert.equal(sheet.getCell("H2").result, 20 * scale);
    assert.equal(sheet.getCell("J2").value, 3);
    assert.equal(sheet.getCell("L2").result, 5);
  }
});
