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
    }, byUnit: [] },
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

test("Кратко is first in every profile and mode and uses server totals rather than displayed rows", async () => {
  for (const profile of ["sample", "summary", "full"] as const) for (const mode of ["quantity", "money", "both"] as const) {
    const report = fixture(mode);
    report.params.profile = profile;
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
    const workbook = await load(report, `turnover-${profile}-${mode}.xlsx`);
    assert.equal(workbook.worksheets[0]?.name, "Кратко");
    const summary = workbook.getWorksheet("Кратко")!;
    const values = sheetValues(summary);
    assert.ok(values.includes("Строк в отчёте: 1"));
    assert.equal(values.includes("n/a"), false);
    assert.equal(values.includes(12), false, "must not sum the displayed fixture row");
    if (mode !== "money") {
      const quantity = namedRow(summary, "Количество");
      assert.deepEqual(rowValues(quantity), ["Количество", "л", 100, 40, 2.5, 1.2]);
      assert.equal((quantity.getCell(5).fill as ExcelJS.FillPattern).fgColor?.argb, "FFFFEDD5");
      assert.equal((quantity.getCell(6).fill as ExcelJS.FillPattern)?.fgColor?.argb, undefined);
    } else {
      assert.equal(values.includes("Количество"), false);
    }
    if (mode !== "quantity") {
      const cost = namedRow(summary, "Деньги по себестоимости");
      assert.deepEqual(rowValues(cost), ["Деньги по себестоимости", "₸", 1250, 500, 3.125, 0.96]);
      assert.ok(values.includes("Продажи по себестоимости, ₸"));
      assert.ok(values.includes("Остаток на конец по себестоимости, ₸"));
      const revenue = namedRow(summary, "Розничная выручка, ₸");
      assert.equal(revenue.getCell(6).value, 1777);
      assert.equal((cost.getCell(5).fill as ExcelJS.FillPattern).fgColor?.argb, "FFDCFCE7");
    } else {
      assert.equal(values.includes("Деньги по себестоимости"), false);
      assert.equal(values.includes("Розничная выручка, ₸"), false);
    }
    assert.equal(summary.columnCount, 6);
  }
});

test("Кратко preserves known zeros and signed returns and never turns missing or nonfinite metrics into numbers", async () => {
  for (const profile of ["sample", "summary", "full"] as const) {
    const report = fixture("both");
    report.params.profile = profile;
    report.params.includeIncomplete = true;
    report.totals.overall = {
      ...report.totals.overall, closingQty: 0, closingCost: null,
      periodSales: { ...sales, quantity: -5, cost: 0, revenue: 0 },
      turnoverQty: -0.5, turnoverQtyDays: null, turnoverCost: Infinity, turnoverCostDays: NaN
    };
    const summary = (await load(report, `turnover-${profile}-incomplete.xlsx`)).getWorksheet("Кратко")!;
    assert.deepEqual(rowValues(namedRow(summary, "Количество")),
      ["Количество", "л", -5, 0, -0.5, "Не рассчитано"]);
    const cost = namedRow(summary, "Деньги по себестоимости");
    assert.deepEqual(rowValues(cost),
      ["Деньги по себестоимости", "₸", 0, "Не рассчитано", "Не рассчитано", "Не рассчитано"]);
    assert.equal(cost.getCell(3).type, ExcelJS.ValueType.Number);
    assert.equal(cost.getCell(4).type, ExcelJS.ValueType.String);
    assert.equal((cost.getCell(5).fill as ExcelJS.FillPattern)?.fgColor?.argb, undefined);
    assert.equal(namedRow(summary, "Розничная выручка, ₸").getCell(6).value, 0);
    assert.equal(sheetValues(summary).includes("n/a"), false);
  }
});

test("Кратко lists incompatible quantities by unit without inventing an overall or an unknown unit", async () => {
  const report = fixture("both");
  report.params.profile = "summary";
  report.params.includeIncomplete = true;
  const overall = report.totals.overall;
  report.totals.byUnit = [
    { ...overall, unit: "л", unitKey: "litre", closingQty: 40, periodSales: { ...sales, quantity: 100 }, turnoverQty: 2.5, turnoverQtyDays: 1.2 },
    { ...overall, unit: "шт", unitKey: "piece", closingQty: 0, periodSales: { ...sales, quantity: -3 }, turnoverQty: -1, turnoverQtyDays: null }
  ];
  report.totals.overall = {
    ...overall, unit: null, closingQty: null, periodSales: { ...sales, quantity: null },
    turnoverQty: null, turnoverQtyDays: null
  };
  const summary = (await load(report, "turnover-summary-mixed-units.xlsx")).getWorksheet("Кратко")!;
  const quantities: ExcelJS.CellValue[][] = [];
  summary.eachRow(row => { if (row.getCell(1).value === "Количество") quantities.push(rowValues(row)); });
  assert.deepEqual(quantities, [
    ["Количество", "л", 100, 40, 2.5, 1.2],
    ["Количество", "шт", -3, 0, -1, "Не рассчитано"]
  ]);
  assert.ok(sheetValues(summary).includes("Общий итог количества не рассчитан"));
  assert.equal(namedRow(summary, "Деньги по себестоимости").getCell(3).value, 120);

  report.totals.byUnit = [];
  const unknown = (await load(report, "turnover-summary-missing-unit.xlsx")).getWorksheet("Кратко")!;
  assert.ok(sheetValues(unknown).includes("Общий итог количества не рассчитан"));
  assert.equal(sheetValues(unknown).includes("Разные единицы"), false);
  assert.equal(sheetValues(unknown).includes("Количество"), false);
});

test("Кратко shows inclusive actual and shortened dates, labelled filters and every warning without raw keys", async () => {
  const report = fixture("money");
  report.params.profile = "summary";
  report.params.warehouse = "wh";
  report.params.category = ["beer", "missing-category-private-key"];
  report.params.brand = "missing-brand-private-key";
  report.params.sku = "item";
  report.params.search = "=поиск";
  report.params.storeScope = "all";
  report.params.excludeZero = true;
  report.coverage.requestedTo = "2026-10-04";
  report.warnings = ["Ограничение стоимости\nНужна проверка", "Возвраты включены"];
  const summary = (await load(report, "turnover-summary-shortened.xlsx")).getWorksheet("Кратко")!;
  const text = sheetValues(summary).filter(value => typeof value === "string").join("\n");
  assert.match(text, /Фактический период: 28\.09\.2026–30\.09\.2026/);
  assert.match(text, /Запрошено по 03\.10\.2026/);
  assert.match(text, /рассчитано по 30\.09\.2026/);
  for (const label of ["Магазины: Магазин", "Склад: Склад", "Категории: Пиво", "Товар: =1+1", "Поиск: =поиск"]) assert.ok(text.includes(label));
  assert.ok(text.includes("Выбранное значение отсутствует в справочнике"));
  assert.doesNotMatch(text, /missing-category-private-key|missing-brand-private-key|\[store\]|\[wh\]/);
  for (const warning of report.warnings) {
    assert.ok(text.includes(warning));
    const warningRow = namedRow(summary, warning);
    assert.equal(warningRow.getCell(1).alignment.wrapText, true);
  }
  assert.ok(text.includes("Подробный расчёт — на следующих листах"));
});

test("empty Кратко keeps the period and limitations but omits unknown totals tables", async () => {
  for (const profile of ["sample", "summary", "full"] as const) {
    const report = fixture("both");
    report.params.profile = profile;
    report.rows = [];
    report.coverage.requestedTo = "2026-10-04";
    report.warnings = ["Ограничение данных остаётся доступным"];
    const summary = (await load(report, `turnover-${profile}-empty.xlsx`)).getWorksheet("Кратко")!;
    const values = sheetValues(summary);
    assert.ok(values.includes("По выбранным условиям товаров нет"));
    assert.ok(values.includes("Строк в отчёте: 0"));
    assert.ok(values.includes(report.warnings[0]));
    assert.equal(values.includes("Не рассчитано"), false);
    assert.equal(values.includes("Продажи за период"), false);
    assert.equal(values.includes("Деньги по себестоимости"), false);
    assert.equal(values.includes("n/a"), false);
  }
});

test("summary-sheet output errors still reject sample and analytical downloads", async () => {
  for (const profile of ["sample", "summary", "full"] as const) {
    const report = fixture("both");
    report.params.profile = profile;
    const output = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error("Summary download failed")); }
    });
    await assert.rejects(writeTurnoverWorkbook(report, output), /Summary download failed/);
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
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Кратко", "Оборачиваемость", "Параметры и методика"]);
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
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Кратко", "рассчет оборачиваемости", "Продажи за период "]);
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
  assert.deepEqual(main.getCell("G2").value, { formula: "C2+D2+E2", result: 30 });
  assert.deepEqual(main.getCell("H2").value, { formula: "G2/(3-1)", result: 15 });
  assert.deepEqual(main.getCell("I2").value, { formula: "K2/H2", result: 0.8 });
  assert.equal(main.getCell("J2").value, 3);
  assert.deepEqual(main.getCell("K2").value, { formula: "VLOOKUP(A2,'Продажи за период '!A2:B2,2,0)", result: 12 });
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
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ["Кратко", "рассчет оборачиваемости ", "Продажи за период "]);
  const main = workbook.getWorksheet("рассчет оборачиваемости ")!;
  assert.equal(main.getCell("B2").value, 100);
  assert.equal(main.getCell("D2").value, 150);
  assert.equal(main.getCell("F2").value, 200);
  assert.deepEqual(main.getCell("H2").value, { formula: "G2/(3-1)", result: 150 });
  assert.deepEqual(main.getCell("I2").value, { formula: "K2/H2", result: 0.8 });
  assert.deepEqual(main.getCell("K2").value, { formula: "VLOOKUP(A2,'Продажи за период '!A1:C1,3,0)", result: 120 });
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
    "Кратко", "рассчет оборачиваемости", "Продажи за период ",
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
  assert.match(main.getCell("K2").value.formula, /A2:B3/);
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
    report.params.sort = "name";
    report.rows = Array<TurnoverRow>(count).fill(row);
    const workbook = await load(report);
    const mains = workbook.worksheets.filter(s => s.name.startsWith("Оборачиваемость"));
    assert.equal(mains.length, count === 10000 ? 1 : 2);
    let footers = 0;
    for (const main of mains) main.eachRow(r => { if (r.getCell(7).value === "ИТОГО") footers++; });
    assert.equal(footers, 1);
    assert.equal(mains.at(-1)!.lastRow!.getCell(7).value, "ИТОГО");
    const products = workbook.worksheets.filter(s => s.name === "Товары" || s.name.startsWith("Товары "));
    assert.equal(products.length, count === 10000 ? 1 : 2);
    let productCount = 0, productFooters = 0;
    for (const part of products) {
      assert.equal(namedRow(part, "Магазин").number, 4);
      assert.equal(namedRow(part, "Пиво").number, 5);
      part.eachRow(r => {
        if (r.getCell(1).value === "=1+1") productCount++;
        if (r.getCell(1).value === "ИТОГО") productFooters++;
      });
    }
    assert.equal(productCount, count);
    assert.equal(productFooters, 1);
    assert.equal(products.at(-1)!.lastRow!.getCell(1).value, "ИТОГО");
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
    const intro = sheetValues(workbook.getWorksheet("Кратко")!);
    assert.ok(intro.includes("Строк в отчёте: 1"));
    assert.ok(intro.some(value => typeof value === "string" && /Исключено строк без полного расчёта: 2/.test(value)));
    assert.ok(intro.includes("Original source warning retained"));
    assert.ok(intro.some(value => typeof value === "string" && /Итоги.*не показаны/.test(value)));
    const main = profile === "sample" ? workbook.worksheets[1] : workbook.getWorksheet("Оборачиваемость")!;
    assert.ok(sheetValues(main).includes("Complete without optional identity"));
    if (profile !== "sample") {
      const headers = main.getRow(4).values as unknown[];
      for (const label of ["SKU (ключ 1С)", "Артикул"]) assert.equal(main.getRow(5).getCell(headers.indexOf(label)).value, null);
      const delivery = headers.indexOf("Ближайшая ожидаемая поставка");
      assert.equal(main.getRow(5).getCell(delivery).value, null);
    }
    report.params.includeIncomplete = true;
    const original = await load(report);
    const originalMain = profile === "sample" ? original.worksheets[1] : original.getWorksheet("Оборачиваемость")!;
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
    assert.equal(namedRow(book.getWorksheet("Кратко")!, "Количество").getCell(3).value, 99);
    assert.ok(sheetValues(book.getWorksheet("Кратко")!).some(value => typeof value === "string" && /По строкам с полным расчётом/.test(value)));
    report.rows = [{ ...row, turnoverQtyDays: null }];
    const empty = await load(report);
    const values = sheetValues(empty.getWorksheet("Кратко")!);
    assert.ok(values.some(value => typeof value === "string" && /Все строки.*исключены/.test(value)));
    assert.equal(values.includes("Количество"), false);
    assert.equal(values.includes("Деньги по себестоимости"), false);
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
    const intro = sheetValues(book.getWorksheet("Кратко")!);
    assert.ok(intro.includes("Общий итог количества не рассчитан"));
    assert.equal(namedRow(book.getWorksheet("Кратко")!, "Количество").getCell(3).value, 12);
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

test("name-sorted SKU exports add a products sheet after Кратко with server metrics in every mode and profile", async () => {
  for (const profile of ["sample", "summary", "full"] as const) for (const mode of ["quantity", "money", "both"] as const) {
    const report = fixture(mode);
    Object.assign(report.params, { profile, sort: "name" });
    report.rows = [
      { ...row, key: "a", sku: "a", name: "=А", periodSales: { ...sales, quantity: -3, cost: -30 }, closingQty: 0, turnoverQty: -0.3 },
      { ...row, key: "b", sku: "b", name: "Я", rootGroupKey: null, rootGroupName: "Без группы" }
    ];
    report.totals.overall.periodSales = { ...sales, quantity: 999, cost: 12345 };
    const workbook = await load(report, `turnover-grouped-${profile}-${mode}.xlsx`);
    assert.deepEqual(workbook.worksheets.slice(0, 2).map(sheet => sheet.name), ["Кратко", "Товары"]);
    const sheet = workbook.getWorksheet("Товары")!;
    assert.equal(sheet.columnCount, 2 + (mode === "both" ? 8 : 4));
    const product = namedRow(sheet, "=А");
    assert.equal(product.getCell(1).type, ExcelJS.ValueType.String);
    assert.equal(product.getCell(3).value, mode === "money" ? -30 : -3);
    assert.equal(product.getCell(4).value, mode === "money" ? 200 : 0);
    assert.equal(namedRow(sheet, "ИТОГО").getCell(3).value, mode === "money" ? 12345 : 999);
    assert.equal(namedRow(sheet, "ИТОГО").number, sheet.lastRow!.number);
    const labels: string[] = [];
    sheet.eachRow(r => { if (typeof r.getCell(1).value === "string") labels.push(r.getCell(1).value as string); });
    assert.deepEqual(labels.filter(label => ["Магазин", "Пиво", "=А", "Без группы", "Я"].includes(label)),
      profile === "sample" ? ["Пиво", "=А", "Без группы", "Я"] : ["Магазин", "Пиво", "=А", "Без группы", "Я"]);
    assert.ok(sheetValues(workbook.getWorksheet("Кратко")!).includes("Товары — по группам А–Я"));
    assert.ok(sheetValues(workbook.getWorksheet("Кратко")!).includes(profile === "sample" ? "Без разбивки по магазинам" : "Разбивка по магазинам"));
    if (profile === "sample") {
      const main = workbook.getWorksheet(mode === "money" ? "рассчет оборачиваемости " : "рассчет оборачиваемости")!;
      assert.ok(main);
      assert.equal(main.getCell("A2").value, "=А");
      assert.equal(main.getCell("A3").value, "Я");
      const coefficient = main.getCell("I2").value as { formula: string; result: number };
      assert.ok(coefficient.formula);
      assert.equal(coefficient.result, mode === "money" ? row.turnoverCost : -0.3);
    }
  }
  for (const overrides of [{ sort: "turnover" as const }, { sort: "name" as const, groupBy: "store" as const }]) {
    const report = fixture("quantity");
    Object.assign(report.params, overrides);
    const workbook = await load(report);
    assert.equal(workbook.getWorksheet("Товары"), undefined);
    assert.equal(sheetValues(workbook.getWorksheet("Кратко")!).includes("Товары — по группам А–Я"), false);
  }
});

test("products sections keep homonymous store and group keys separate, including known and null Без группы", async () => {
  const report = fixture("both");
  Object.assign(report.params, { profile: "summary", sort: "name", includeIncomplete: true });
  report.rows = [
    { ...row, name: "А", storeKey: "s1", rootGroupKey: "g1", rootGroupName: "Без группы" },
    { ...row, name: "Б", storeKey: "s1", rootGroupKey: "g2", rootGroupName: "Без группы" },
    { ...row, name: "В", storeKey: "s1", rootGroupKey: null, rootGroupName: "Без группы", closingCost: null, turnoverQty: null },
    { ...row, name: "Я", storeKey: "s2", rootGroupKey: "g1", rootGroupName: "Без группы" }
  ];
  const sheet = (await load(report)).getWorksheet("Товары")!;
  const labels: string[] = [];
  sheet.eachRow(r => { labels.push(String(r.getCell(1).value)); });
  assert.equal(labels.filter(value => value === "Магазин").length, 2);
  assert.equal(labels.filter(value => value === "Без группы").length, 4);
  assert.deepEqual(labels.filter(value => ["А", "Б", "В", "Я"].includes(value)), ["А", "Б", "В", "Я"]);
  assert.equal(namedRow(sheet, "В").getCell(8).value, "Не рассчитано");
  assert.equal(namedRow(sheet, "В").getCell(5).value, "Не рассчитано");
  assert.equal((namedRow(sheet, "В").getCell(5).fill as ExcelJS.FillPattern)?.fgColor?.argb, undefined);
  report.rows = [];
  const empty = (await load(report)).getWorksheet("Товары")!;
  assert.ok(sheetValues(empty).includes("По выбранным условиям товаров нет"));
  assert.equal(sheetValues(empty).includes("ИТОГО"), false);
});

test("presentation sheets leave room for wrapped unit identities instead of clipping adjacent rows", async () => {
  const report = fixture("quantity");
  Object.assign(report.params, { profile: "sample", sort: "name" });
  const unit = "шт [fd33bbe6-8cd3-11e8-840d-3085a9455e10]";
  report.rows = [{ ...row, unit }];
  report.totals.overall.unit = unit;
  const workbook = await load(report, "turnover-long-labels.xlsx");
  assert.ok(namedRow(workbook.getWorksheet("Кратко")!, "Количество").height! >= 48,
    "the observed three-line unit label needs at least 48 points including padding");
  assert.ok(namedRow(workbook.getWorksheet("Товары")!, "=1+1").height! >= 48);
  const product = namedRow(workbook.getWorksheet("Товары")!, "=1+1");
  assert.equal(product.getCell(3).alignment?.vertical, product.getCell(1).alignment.vertical,
    "sales and product label must share the same vertical alignment in a wrapped row");
});
