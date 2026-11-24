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
async function workbookBytes(report: TurnoverReport, fixtureName?: string) {
  const stream = new PassThrough();
  const [, bytes] = await Promise.all([writeTurnoverWorkbook(report, stream), buffer(stream)]);
  if (fixtureName && process.env.TURNOVER_WORKBOOK_FIXTURE_DIR) {
    await mkdir(process.env.TURNOVER_WORKBOOK_FIXTURE_DIR, { recursive: true });
    await writeFile(join(process.env.TURNOVER_WORKBOOK_FIXTURE_DIR, fixtureName), bytes);
  }
  return bytes;
}

async function load(report: TurnoverReport, fixtureName?: string) {
  const bytes = await workbookBytes(report, fixtureName);
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
  const itemColumn = (sheet.getRow(2).values as ExcelJS.CellValue[]).indexOf("Номенклатура");
  assert.ok(itemColumn > 0);
  let found: ExcelJS.Row | undefined;
  sheet.eachRow(row => { if (row.getCell(itemColumn).value === label) found = row; });
  assert.ok(found, `missing standard row: ${label}`);
  return found;
}

test("paired outline hides exactly the daily group at 2, 3 and 366 days with a single visible collapse marker", async () => {
  for (const dayCount of [2, 3, 366]) {
    const report = fixture("both");
    const date = (offset: number) => new Date(Date.UTC(2024, 0, 1 + offset)).toISOString().slice(0, 10);
    Object.assign(report.params, { profile: "sample", sort: "name", from: date(0), to: date(dayCount) });
    const daily = Array.from({ length: dayCount }, (_, i) => ({
      ...row.daily[0], date: date(i), weight: i === 0 || i === dayCount - 1 ? 0.5 : 1, quantity: 10, stockCost: 200
    }));
    const metrics = { daily, openingQty: 10, closingQty: 10, averageQty: 10, openingCost: 200, closingCost: 200,
      averageCost: 200, turnoverQty: 1.2, turnoverCost: 0.6, turnoverQtyDays: dayCount / 1.2, turnoverCostDays: dayCount / 0.6 };
    report.rows = [{ ...row, ...metrics }];
    report.daily = daily;
    report.totals.overall = { ...report.totals.overall, ...metrics };
    const bytes = await workbookBytes(report, `turnover-paired-outline-${dayCount}.xlsx`);
    const zip = await JSZip.loadAsync(bytes);
    const main = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    const detailsEnd = 3 + (dayCount + 2) * 2;
    assert.match(main, /<outlinePr\b[^>]*summaryRight="1"/);
    assert.match(main, /<sheetFormatPr\b[^>]*outlineLevelCol="1"/);
    assert.match(main, /<pane\b[^>]*xSplit="2"[^>]*ySplit="2"[^>]*state="frozen"/);
    const columns = [...main.matchAll(/<col\b[^>]*\/>/g)].map(match => match[0]);
    const column = (i: number) => columns.find(col => col.includes(`min="${i}"`));
    const hidden = columns.filter(col => col.includes('hidden="1"'));
    assert.equal(hidden.length, 1);
    assert.match(hidden[0]!, new RegExp(`min="4" max="${detailsEnd}"[^>]*outlineLevel="1"`));
    assert.doesNotMatch(hidden[0]!, /collapsed=/);
    const collapsed = columns.filter(col => col.includes('collapsed="1"'));
    assert.deepEqual(collapsed, [column(detailsEnd + 1)]);
    assert.match(collapsed[0]!, new RegExp(`min="${detailsEnd + 1}" max="${detailsEnd + 1}"`));
    assert.doesNotMatch(collapsed[0]!, /hidden=|outlineLevel=/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const mainSheet = workbook.worksheets[0];
    const product = namedRow(mainSheet, row.name);
    assert.equal(product.getCell(detailsEnd + 1).result, 10 * (dayCount - 1));
    assert.equal(product.getCell(detailsEnd + 2).result, 200 * (dayCount - 1));
    assert.equal(product.getCell(detailsEnd + 3).result, 10);
    assert.equal(product.getCell(detailsEnd + 4).result, 200);
    for (const col of [detailsEnd + 1, detailsEnd + 2, detailsEnd + 3, detailsEnd + 4]) {
      const cell = product.getCell(col);
      const formula = cell.formula!;
      assert.match(formula, /SUMPRODUCT/);
      assert.match(formula, /MOD\(COLUMN\(/);
      assert.match(formula, /--IFERROR\([A-Z]+\d+:[A-Z]+\d+>0,FALSE\)/);
      assert.ok(main.includes(`<f t="array" ref="${cell.address}">`), "Excel must evaluate range guards as arrays");
      if (col <= detailsEnd + 2) {
        assert.match(formula, /,IFERROR\([A-Z]+\d+:[A-Z]+\d+,0\)\)/);
        assert.match(formula, /--ISNUMBER\([A-Z]+\d+:[A-Z]+\d+\)\)=/, "errors still count as missing in their own basis");
      }
      assert.ok(formula.length < 8192);
    }
    assert.equal(mainSheet.lastRow!.number, product.number + 1);
    assert.equal(mainSheet.autoFilter, `A2:${mainSheet.getColumn(mainSheet.columnCount).letter}${product.number}`);
  }
});

test("a missing middle cost hides only dependent monetary metrics, not quantity or known cost sales", async () => {
  const report = fixture("both");
  Object.assign(report.params, { profile: "sample", sort: "name" });
  const amounts = { ...sales, quantity: 40, cost: 900 };
  const daily = row.daily.map((day, i) => ({ ...day, quantity: [10, 20, 30][i], stockCost: [100, 300, 500][i] }));
  const complete = { ...row, daily, averageQty: 20, averageCost: 300, turnoverQty: 2, turnoverCost: 3,
    turnoverQtyDays: 1.5, turnoverCostDays: 1, periodSales: amounts };
  const partial = { ...complete, key: "partial", name: "Без оценки", averageCost: null, turnoverCost: null, turnoverCostDays: null,
    daily: daily.map((day, i) => i === 1 ? { ...day, stockCost: null } : day) };
  report.rows = [complete, partial];
  report.totals.overall = {
    ...report.totals.overall, daily: partial.daily, averageCost: null, turnoverCost: null, turnoverCostDays: null,
    periodSales: { ...amounts, quantity: 80, cost: 1800 }
  };
  const [main] = (await load(report, "turnover-paired-recalculate.xlsx")).worksheets;
  const full = namedRow(main, row.name);
  assert.deepEqual([14, 15, 16, 17, 18, 19, 21, 22, 23, 24].map(col => full.getCell(col).result), [40, 600, 20, 300, 2, 3, 40, 900, 1.5, 1]);
  const missing = namedRow(main, partial.name);
  assert.deepEqual([14, 16, 18, 21, 23].map(col => missing.getCell(col).result), [40, 20, 2, 40, 1.5]);
  for (const col of [15, 17, 19, 24]) {
    assert.equal(missing.getCell(col).result ?? "", "");
    assert.ok(missing.getCell(col).formula, "an aligned but missing cost can be supplied in Excel");
  }
  assert.equal(missing.getCell(22).result, 900);
  const footer = namedRow(main, "ИТОГО");
  assert.equal(footer.getCell(15).result ?? "", "", "partial valuation is not an authoritative stock sum");
  assert.equal(footer.getCell(22).result, 1800, "known server sales survive an unavailable stock sum");
});
test("standard workbook keeps confirmed idle stock without inventing turnover days or a missing valuation", async () => {
  const report = fixture("both");
  report.params.profile = "sample";
  const product = report.rows[0]!;
  Object.assign(product, { idleStock: true, averageCost: null, closingCost: null, turnoverQty: 0, turnoverCost: null,
    turnoverQtyDays: null, turnoverCostDays: null, periodSales: { quantity: 0, cost: 0, revenue: 0, averageDailyQty: 0, averageDailyCost: 0 } });
  product.daily = product.daily.map(day => ({ ...day, stockCost: null, salesQty: 0, salesCost: 0, revenue: 0 }));
  const book = await load(report);
  const data = namedRow(book.worksheets[0], product.name);
  assert.deepEqual([23, 24].map(col => data.getCell(col).value), ["Без движения", "Без движения"]);
  assert.equal(data.getCell(16).result, 15);
  assert.equal(data.getCell(17).result ?? "", "");
  assert.deepEqual([4, 5].map(col => namedRow(book.worksheets[1], product.name).getCell(col).value), [0, 0]);
});

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
    assert.equal(workbook.worksheets.length, 2);
    const [main] = workbook.worksheets;
    const footer = namedRow(main, "ИТОГО");
    const shift = profile === "summary" ? 1 : 0;
    const cell = (col: number) => footer.getCell(col + shift);
    if (mode === "both") {
      assert.deepEqual([16, 17, 18, 19, 21, 22, 23, 24].map(col => cell(col).result), [40, 400, 2.5, 3.125, 100, 1250, 1.2, 0.96]);
      assert.equal(cell(20).value, 3);
      assert.deepEqual([21, 22].map(col => namedRow(main, "=1+1").getCell(col + shift).result), [12, 120]);
    } else {
      assert.deepEqual([10, 11, 13, 14].map(col => cell(col).result), mode === "money" ? [400, 3.125, 1250, 0.96] : [40, 2.5, 100, 1.2]);
      assert.equal(cell(12).value, 3);
      assert.equal(namedRow(main, "=1+1").getCell(13 + shift).result, mode === "money" ? 120 : 12);
    }
    assert.equal(sheetValues(main).includes(1777), false, "retail revenue must not replace cost sales");
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
    const [main, salesSheet] = workbook.worksheets;
    const shift = profile === "summary" ? 1 : 0;
    const scopes = profile === "summary" ? ["ИТОГО по магазину", "ИТОГО"] : ["ИТОГО"];
    const labels = scopes.flatMap(label => [label, `${label} · л`, `${label} · шт`]);
    for (const sheet of [main, salesSheet]) {
      assert.deepEqual(sheetValues(sheet).filter(value => typeof value === "string" && value.startsWith("ИТОГО")), labels);
    }
    for (const label of scopes) {
      const total = namedRow(main, label);
      assert.equal(total.getCell(21 + shift).value, null);
      assert.equal(total.getCell(22 + shift).result, 0);
      assert.equal(total.getCell(19 + shift).result, "n/a");
      assert.equal(total.getCell(24 + shift).result, "n/a");
      assert.equal(total.getCell(20 + shift).value, 3);
      const salesTotal = namedRow(salesSheet, label);
      assert.equal(salesTotal.getCell(4 + shift).value, null);
      assert.equal(salesTotal.getCell(5 + shift).value, 0);
      for (const [unit, signedQty] of [["л", 0], ["шт", -3]] as const) {
        const byUnit = namedRow(main, `${label} · ${unit}`);
        assert.equal(byUnit.getCell(21 + shift).result, signedQty);
        assert.equal(byUnit.getCell(22 + shift).value, null);
        assert.equal(byUnit.getCell(5 + shift).value, null, "each unit total masks daily costs");
        assert.equal(byUnit.getCell(20 + shift).value, 3);
        const salesUnit = namedRow(salesSheet, `${label} · ${unit}`);
        assert.equal(salesUnit.getCell(4 + shift).value, signedQty);
        assert.equal(salesUnit.getCell(5 + shift).value, null);
      }
    }
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

test("explicit quantity and money sheets retain the original numeric sales bases with guarded half dates and row links", async () => {
  for (const mode of ["quantity", "money"] as const) {
    const report = fixture(mode);
    report.params.profile = "sample";
    const [main, source] = (await load(report)).worksheets;
    const money = mode === "money";
    assert.equal(main.name, money ? "рассчет оборачиваемости " : "рассчет оборачиваемости");
    assert.equal(source.name, "Продажи за период ");
    assert.equal(main.columnCount, 14);
    assert.equal(main.getCell("D1").value, "28.09.");
    assert.equal(main.getCell("E1").master.address, "D1");
    assert.equal(main.getCell("G1").value, "30.09.");
    assert.equal(main.getCell("H1").master.address, "G1");
    const basis = money ? "₸ по себестоимости" : "Кол-во";
    assert.deepEqual((main.getRow(2).values as ExcelJS.CellValue[]).slice(4, 9), [basis, `½ ${basis}`, basis, `½ ${basis}`, basis]);
    assert.equal(main.getCell("C4").value, "л");
    assert.equal(main.getCell("B4").value, "=1+1");
    assert.equal(main.getCell("B4").type, ExcelJS.ValueType.String);
    assert.equal(main.getCell("D4").value, money ? 100 : 10);
    assert.deepEqual(main.getCell("E4").value, { formula: 'IF(ISNUMBER(D4),D4/2,"")', result: money ? 50 : 5 });
    assert.deepEqual(main.getCell("G4").value, { formula: 'IF(ISNUMBER(H4),H4/2,"")', result: money ? 100 : 10 });
    assert.equal(main.getCell("I4").result, money ? 300 : 30);
    assert.equal(main.getCell("J4").result, money ? 150 : 15);
    assert.equal(main.getCell("K4").result, 0.8);
    assert.equal(main.getCell("L4").value, 3);
    assert.equal(main.getCell("M4").result, money ? 120 : 12);
    assert.equal(main.getCell("N4").result, 3.75);
    assert.match(main.getCell("M4").formula!, money ? /'Продажи за период '!E4/ : /'Продажи за период '!D4/);
    assert.equal(main.pageSetup.orientation, "landscape");
    assert.equal(main.pageSetup.paperSize, 9);
    assert.equal(main.views[0]?.state, "frozen");
    assert.equal(main.views[0]?.ySplit, 2);
    assert.equal(main.getColumn(4).hidden, true);
    assert.equal(main.autoFilter, money ? "A2:N4" : undefined);
    assert.equal(source.getCell("D4").value, 12);
    assert.equal(source.getCell("E4").value, money ? 120 : null);
    assert.equal(source.getCell("B5").value, "ИТОГО");
  }
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
  assert.equal(main.getCell("B4").value, row.name);
  assert.equal(main.getCell("B5").value, "Другой товар");
  const salesSheet = workbook.getWorksheet("Продажи за период ")!;
  assert.equal(salesSheet.lastRow!.getCell(2).value, "ИТОГО");
  assert.equal(salesSheet.lastRow!.getCell(4).value, null);
  assert.equal(salesSheet.lastRow!.getCell(5).value, 240);
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
  for (const [value, expected] of [[-1, null], [0, "red"], [0.999, "red"], [1, "red"], [1.999, "red"], [2, "orange"], [2.999, "orange"], [3, "green"], [3.01, "green"], [null, null], [NaN, null], [Infinity, null]] as const) {
    assert.equal(turnoverCoefficientBand(value), expected);
  }
});

test("every workbook profile and mode ends its main table with server totals outside the filter", async () => {
  for (const profile of ["sample", "summary", "full"] as const) for (const mode of ["quantity", "money", "both"] as const) {
    const report = fixture(mode);
    report.params.profile = profile;
    const workbook = await load(report);
    const main = workbook.worksheets[0];
    const footer = main.lastRow!;
    assert.equal(footer.getCell(profile === "sample" ? 2 : 7).value, "ИТОГО");
    if (profile === "sample") {
      assert.equal(footer.getCell(mode === "both" ? 20 : 12).value, 3);
      assert.equal(footer.getCell(mode === "both" ? 18 : 11).result, 0.8);
      assert.equal(footer.getCell(mode === "both" ? 23 : 14).result, 3.75);
      assert.equal(footer.getCell(mode === "both" ? 6 : 5).result, mode === "money" ? 50 : 5);
      assert.equal(workbook.worksheets[1].lastRow!.getCell(2).value, "ИТОГО");
      if (mode !== "quantity") assert.equal(main.autoFilter, `A2:${main.getColumn(main.columnCount).letter}${footer.number - 1}`);
    } else {
      assert.equal(main.autoFilter, `A4:${main.getColumn(main.columnCount).letter}${footer.number - 1}`);
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
  assert.equal(main.getCell("B4").value, "ИТОГО");
  assert.equal(main.getCell("B6").value, "ИТОГО");
  assert.equal(main.getCell("J6").result, 40);
  assert.equal(main.getCell("K6").result, 2.5);
  assert.equal(main.getCell("L6").value, 3);
  assert.equal(main.getCell("M6").result, 100);
  assert.equal(main.getCell("N6").result, 1.2);
  assert.match(main.getCell("M6").formula!, /'Продажи за период '!D6/);
  assert.match(main.getCell("M4").formula!, /'Продажи за период '!D4/);
});

test("coefficient fills and conditional rules cover data and totals, not turnover days", async () => {
  for (const profile of ["sample", "summary"] as const) {
    const report = fixture("both");
    report.params.profile = profile;
    report.params.includeIncomplete = true;
    const values = [-1, 0, 0.999, 1, 1.999, 2, 2.999, 3, 3.01, null, NaN, Infinity];
    report.rows = values.map((value, i) => ({
      ...row, key: `row${i}`, sku: `sku${i}`, name: `Item ${i}`, turnoverQty: value, turnoverCost: value,
      periodSales: { ...sales, quantity: value === null ? null : value * 15, cost: value === null ? null : value * 150 }
    }));
    report.totals.overall.turnoverQty = 2.5;
    report.totals.overall.turnoverCost = 2.5;
    report.totals.overall.periodSales = { ...sales, quantity: 37.5, cost: 375 };
    const bytes = await workbookBytes(report, profile === "sample" ? "turnover-coefficient-colors.xlsx" : undefined);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes);
    const main = workbook.getWorksheet("Оборачиваемость")!;
    const columns = profile === "sample" ? [[18, 23], [19, 24]] : [[14, 15], [21, 22]];
    const first = profile === "sample" ? 4 : 5;
    const colors = [undefined, "FFFEE2E2", "FFFEE2E2", "FFFEE2E2", "FFFEE2E2", "FFFFEDD5", "FFFFEDD5", "FFDCFCE7", "FFDCFCE7"];
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file(`xl/worksheets/sheet${main.id}.xml`)!.async("string");
    if (profile === "sample") assert.match(String(main.getCell("A1").value), /Плохо .* Средне .* Хорошо/);
    for (const [coefficient, days] of columns) {
      for (let i = 0; i < values.length; i++) {
        const cell = main.getRow(first + i).getCell(coefficient);
        assert.equal((cell.fill as ExcelJS.FillPattern)?.fgColor?.argb, colors[i]);
        assert.equal((main.getRow(first + i).getCell(days).fill as ExcelJS.FillPattern)?.fgColor?.argb, undefined);
      }
      assert.equal((main.lastRow!.getCell(coefficient).fill as ExcelJS.FillPattern).fgColor?.argb, "FFFFEDD5");
      const letter = main.getColumn(coefficient).letter;
      assert.match(xml, new RegExp(`sqref="${letter}${first}:${letter}${main.lastRow!.number}"`));
    }
    assert.match(xml, /AND\(ISNUMBER\(([A-Z]+\d+)\),\1&gt;=0,\1&lt;2\)/);
    assert.match(xml, /AND\(ISNUMBER\(([A-Z]+\d+)\),\1&gt;=2,\1&lt;3\)/);
    assert.match(xml, /AND\(ISNUMBER\(([A-Z]+\d+)\),\1&gt;=3\)/);
    assert.match(xml, /IFERROR\(OR\(NOT\(ISNUMBER\(([A-Z]+\d+)\)\),\1&lt;0\),TRUE\)/);
    const styles = await zip.file("xl/styles.xml")!.async("string");
    const differentialStyles = styles.match(/<dxfs\b[^>]*>(.*?)<\/dxfs>/)?.[1] ?? "";
    for (const color of ["FFFEE2E2", "FFFFEDD5", "FFDCFCE7", "FFFFFFFF"]) {
      assert.match(differentialStyles, new RegExp(`<bgColor rgb="${color}"`));
    }
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
    const report = fixture("both");
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
  assert.equal(namedRow(main, "ИТОГО").getCell(14).value, null);
  assert.equal(namedRow(main, "ИТОГО").getCell(11).value, null);
  report.params.includeIncomplete = true;
  const complete = (await load(report)).getWorksheet("рассчет оборачиваемости")!;
  assert.equal(namedRow(complete, "Не рассчитан").getCell(15).result, "n/a");
  assert.equal(namedRow(complete, "ИТОГО").getCell(14).result, 12);
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
      assert.equal(main.lastRow!.getCell(mode === "both" ? 21 : 13).value, null, "stale population totals must be withheld");
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
    const salesColumn = profile === "sample" ? 21 : profile === "summary" ? 12 : 13;
    assert.equal(profile === "sample" ? main.lastRow!.getCell(salesColumn).result : main.lastRow!.getCell(salesColumn).value, 99);
    report.rows = [{ ...row, turnoverQtyDays: null, turnoverCostDays: null }];
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
    const salesColumn = profile === "sample" ? 13 : profile === "summary" ? 12 : 13;
    if (profile === "sample") {
      assert.equal(main.lastRow!.getCell(2).value, "ИТОГО · л");
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
  const [sheet] = (await load(report)).worksheets;
  const unknown = namedRow(sheet, "Unavailable financial row");
  assert.equal(unknown.getCell(4).value, null);
  assert.equal(unknown.getCell(6).result ?? "", "", "a blank endpoint is not a numeric half-zero");
  assert.match(unknown.getCell(6).formula!, /ISNUMBER\(D5\)/);
  for (const col of [14, 15, 16, 17, 18, 19, 21, 22, 23, 24]) assert.equal(unknown.getCell(col).result, "n/a");
  const footer = sheet.lastRow!;
  assert.match(footer.getCell(18).formula!, /ISNUMBER\(U6\),ISNUMBER\(P6\),U6>=0,P6>0/);
  assert.match(footer.getCell(23).formula!, /ISNUMBER\(R6\),R6>0/);
  assert.equal(footer.getCell(18).result, 0.8);
  assert.equal(footer.getCell(23).result, 3.75);
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
  const [main, salesSheet] = (await load(report, "turnover-standard-homonyms.xlsx")).worksheets;
  const dataRows: number[] = [];
  main.eachRow(r => { if (r.getCell(3).value === "=Один товар") dataRows.push(r.number); });
  assert.deepEqual(dataRows, [5, 7, 11]);
  for (const [number, quantity] of [[5, 11], [7, 22], [11, 33]]) {
    assert.equal(main.getCell(`C${number}`).type, ExcelJS.ValueType.String);
    for (const sheet of [main, salesSheet]) {
      assert.deepEqual((sheet.getRow(number).values as ExcelJS.CellValue[]).slice(1, 5),
        ["Одинаковый магазин", "Пиво", "=Один товар", "л"]);
    }
    assert.equal(salesSheet.getCell(`E${number}`).value, quantity);
    assert.equal(salesSheet.getCell(`F${number}`).value, quantity * 10);
    assert.match(main.getCell(`V${number}`).formula!, new RegExp(`'Продажи за период'!E${number}\\b`));
    assert.match(main.getCell(`W${number}`).formula!, new RegExp(`'Продажи за период'!F${number}\\b`));
    assert.deepEqual([15, 16, 19, 20, 22, 23, 24, 25].map(col => main.getRow(number).getCell(col).result),
      [30, 300, quantity / 15, quantity / 15, quantity, quantity * 10, 45 / quantity, 45 / quantity]);
  }
  for (const [number, quantity] of [[8, 33], [12, 44]]) {
    assert.equal(main.getCell(`C${number}`).value, "ИТОГО по магазину");
    assert.equal(salesSheet.getCell(`C${number}`).value, "ИТОГО по магазину");
    assert.equal(main.getCell(`V${number}`).result, quantity);
    assert.equal(main.getCell(`W${number}`).result, quantity * 10);
  }
  assert.equal(main.lastRow!.number, 13);
  assert.equal(main.getCell("W13").result, 120);
  assert.match(main.getCell("W13").formula!, /'Продажи за период'!F13/);
  for (const [number, column, label] of [[3, 1, "Одинаковый магазин"], [4, 2, "Пиво"], [6, 2, "Пиво"],
    [9, 1, "Одинаковый магазин"], [10, 2, "Пиво"]] as const) {
    for (const sheet of [main, salesSheet]) {
      assert.equal(sheet.getRow(number).getCell(column).value, label);
      assert.equal(sheet.getRow(number).getCell(5).value, null, "section numeric cells are blank");
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
      const groupColumn = profile === "summary" ? 2 : 1;
      const groups: string[] = [], products: string[] = [];
      sheet.eachRow(r => {
        const group = r.getCell(groupColumn).value, product = r.getCell(groupColumn + 1).value;
        if (product === null && typeof group === "string") groups.push(group);
        else if (typeof product === "string" && !product.startsWith("ИТОГО") && r.number > 2) products.push(product);
      });
      assert.equal(groups.filter(value => value === "Без группы").length, 3);
      assert.ok(groups.includes("Группа без названия"));
      assert.equal(values.includes("Магазин"), profile === "summary");
      assert.equal(values.includes("Магазин не определён"), profile === "summary");
      assert.deepEqual(products, ["А", "Б", "В", "Я"]);
      assert.equal(values.includes("g1"), false);
    }
    const main = workbook.getWorksheet("рассчет оборачиваемости")!;
    const coefficient = namedRow(main, "В").getCell(profile === "summary" ? 12 : 11);
    assert.equal(coefficient.result, "n/a");
    assert.equal((coefficient.fill as ExcelJS.FillPattern)?.fgColor?.argb, undefined);
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
    const main = workbook.worksheets[0];
    assert.equal(main.name, "Оборачиваемость");
    assert.equal(workbook.getWorksheet("Продажи за период"), undefined);
    assert.equal(workbook.getWorksheet("Продажи за период "), undefined);
    assert.ok(workbook.getWorksheet("Параметры и методика"));
    assert.equal(main.getCell("G5").value, row.name);
    assert.equal(main.getColumn(5).hidden, false);
  }
});

test("standard shops freeze context on both sheets and hide only the calculation's contiguous daily columns", async () => {
  for (const mode of ["quantity", "money", "both"] as const) {
    const report = fixture(mode);
    Object.assign(report.params, { profile: "summary", groupBy: "sku", sort: "name" });
    const workbook = await load(report);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), mode === "both"
      ? ["Оборачиваемость", "Продажи за период"]
      : [mode === "money" ? "рассчет оборачиваемости " : "рассчет оборачиваемости", "Продажи за период "]);
    const [main, salesSheet] = workbook.worksheets;
    for (const sheet of [main, salesSheet]) {
      assert.deepEqual((sheet.getRow(2).values as ExcelJS.CellValue[]).slice(1, 5), ["Магазин", "Группа", "Номенклатура", "Ед. учёта"]);
      assert.deepEqual((sheet.getRow(5).values as ExcelJS.CellValue[]).slice(1, 5), ["Магазин", "Пиво", row.name, "л"]);
      assert.equal(sheet.views[0]?.state, "frozen");
      assert.equal(sheet.views[0]?.xSplit, 3);
      assert.equal(sheet.views[0]?.ySplit, 2);
    }
    const lastDaily = mode === "both" ? 14 : 9;
    for (let col = 1; col <= main.columnCount; col++) assert.equal(main.getColumn(col).hidden, col >= 5 && col <= lastDaily);
    assert.equal(salesSheet.getColumn(5).hidden, false);
    assert.deepEqual((salesSheet.getRow(2).values as ExcelJS.CellValue[]).slice(5),
      mode === "quantity" ? ["Кол-во"] : ["Кол-во", "₸ по себестоимости"]);
  }
});

test("standard sales sheets retain server group order rather than sorting product names independently", async () => {
  const report = fixture("quantity");
  Object.assign(report.params, { profile: "summary", sort: "name" });
  report.rows = [
    ...Array.from({ length: 101 }, (_, i) => ({ ...row, key: `item-${i}`, name: `Яблоко ${i}`,
      storeKey: "a", storeName: "А", rootGroupKey: "g1", rootGroupName: "Пиво", periodSales: { ...sales, quantity: i + 1 } })),
    { ...row, key: "two", name: "Абрикос", storeKey: "a", storeName: "А", rootGroupKey: "g2", rootGroupName: "Пиво",
      periodSales: { ...sales, quantity: 102 } },
    { ...row, key: "three", name: "Бакалея", storeKey: "a", storeName: "А", rootGroupKey: null,
      periodSales: { ...sales, quantity: 103 } },
    { ...row, key: "four", name: "Ананас", storeKey: "ya", storeName: "Я", rootGroupKey: "g1", rootGroupName: "Пиво",
      periodSales: { ...sales, quantity: 104 } }
  ];
  const [main, salesSheet] = (await load(report)).worksheets;
  const dataRows: number[] = [];
  main.eachRow(r => { if (r.number > 2 && r.getCell(14).formula && r.getCell(3).value !== "ИТОГО") dataRows.push(r.number); });
  assert.equal(dataRows.length, 104);
  assert.deepEqual(dataRows.map(n => main.getCell(`C${n}`).value), report.rows.map(product => product.name));
  assert.deepEqual(dataRows.map(n => salesSheet.getCell(`C${n}`).value), report.rows.map(product => product.name));
  for (const n of dataRows) assert.match(main.getCell(`N${n}`).formula!, new RegExp(`'Продажи за период '!E${n}\\b`));
  assert.deepEqual(dataRows.map(n => main.getCell(`N${n}`).result), Array.from({ length: 104 }, (_, i) => i + 1));
});

test("standard stock formulas retain signed endpoints and count only in-stock days", async () => {
  const report = fixture("both");
  report.params.profile = "sample";
  const daily = row.daily.map((day, index) => ({ ...day, quantity: [0, 20, -4][index]!, stockCost: [0, 200, -40][index]! }));
  report.rows = [{ ...row, daily, averageQty: 20, averageCost: 200,
    turnoverQty: 0.6, turnoverCost: 0.6, turnoverQtyDays: 5, turnoverCostDays: 5 }];
  const [sheet] = (await load(report, "turnover-availability-formulas.xlsx")).worksheets;
  assert.deepEqual([4, 5, 12, 13].map(col => sheet.getRow(4).getCell(col).value), [0, 0, -4, -40]);
  assert.deepEqual([14, 15, 16, 17, 23, 24].map(col => sheet.getRow(4).getCell(col).result), [20, 200, 20, 200, 5, 5]);
  assert.equal(sheet.getCell("T4").value, 3);
});

test("known zero stock and signed costs stay numeric while unavailable ratios remain recalculable", async () => {
  const report = fixture("both");
  Object.assign(report.params, { profile: "sample", includeIncomplete: true });
  report.rows = [{
    ...row, averageQty: 0, turnoverQty: null, turnoverQtyDays: null, turnoverCost: null, turnoverCostDays: null,
    periodSales: { ...sales, cost: -15 }, daily: row.daily.map(day => ({ ...day, quantity: 0, salesCost: -5 }))
  }];
  const [main, source] = (await load(report)).worksheets;
  const product = namedRow(main, row.name);
  assert.deepEqual([14, 16, 18, 19, 21, 22].map(col => product.getCell(col).result), [0, 0, "n/a", "n/a", 12, -15]);
  assert.equal(namedRow(source, row.name).getCell(5).value, -15);
  assert.match(product.getCell(18).formula!, /P4>0/);
  assert.match(product.getCell(19).formula!, /V4>=0/);
});
