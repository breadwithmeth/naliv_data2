import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { buffer } from "node:stream/consumers";
import ExcelJS from "exceljs";
import { writeMarketingCompensationWorkbook } from "../src/services/marketing-compensation-workbook.js";
import { projectCompensationReport } from "../src/services/marketing-compensation-presentation.js";
import type {
  CompensationRow, CompensationTotals, MarketingCompensationReport
} from "../src/services/marketing-compensation-types.js";

const complete = (compensation: number): CompensationTotals => ({
  compensation, knownCompensation: compensation, incompleteRows: 0
});
function item(overrides: Partial<CompensationRow> = {}): CompensationRow {
  return {
    itemKey: "same-item", characteristicKey: "characteristic", name: "=1+1", barcode: "000123",
    price: 631, discountPct: 20, unitCompensation: 126.2, quantity: 2, compensation: 252.4,
    from: "2026-09-01", to: "2026-09-16", issues: [], ...overrides
  };
}
function fixture(): MarketingCompensationReport {
  return {
    from: "2026-09-01", to: "2026-10-01", activityKey: null, calculationMode: "retail-rule", issues: [], totals: complete(366.2),
    activities: [
      {
        key: "activity-a", name: "Маркетинг А", number: "001", startsOn: "2026-08-25", endsOn: "2026-09-15",
        from: "2026-09-01", to: "2026-09-16", issues: [], totals: complete(126.2), branches: [
          { key: "branch-a", name: "Филиал А", hasSales: true, hasReturns: false, rows: [item()], totals: complete(252.4), issues: [] },
          { key: "branch-b", name: "Филиал Б", hasSales: false, hasReturns: true, rows: [item({ quantity: -1, compensation: -126.2 })], totals: complete(-126.2), issues: [] }
        ]
      },
      {
        key: "activity-b", name: "Маркетинг Б", number: null, startsOn: "2026-09-15", endsOn: "2026-10-05",
        from: "2026-09-15", to: "2026-10-01", issues: [], totals: complete(240), branches: [
          {
            key: "branch-a", name: "Филиал А", hasSales: true, hasReturns: false, rows: [item({
              price: 800, discountPct: 10, unitCompensation: 80, quantity: 3, compensation: 240,
              from: "2026-09-15", to: "2026-10-01"
            })], totals: complete(240), issues: []
          }
        ]
      }
    ]
  };
}
async function load(report: MarketingCompensationReport): Promise<ExcelJS.Workbook> {
  const output = new PassThrough();
  const [, bytes] = await Promise.all([writeMarketingCompensationWorkbook(report, output), buffer(output)]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return workbook;
}
function rows(sheet: ExcelJS.Worksheet): ExcelJS.Row[] {
  const result: ExcelJS.Row[] = [];
  sheet.eachRow(row => result.push(row));
  return result;
}
function values(row: ExcelJS.Row): ExcelJS.CellValue[] {
  return Array.from({ length: 7 }, (_, index) => row.getCell(index + 1).value);
}
function unavailable(cell: ExcelJS.Cell) {
  assert.equal(cell.type, ExcelJS.ValueType.String);
  assert.equal(cell.value, "Нет данных");
}
function noteText(cell: ExcelJS.Cell): string {
  const note = cell.note;
  return typeof note === "string" ? note : note?.texts?.map(part => part.text ?? "").join("") ?? "";
}

test("compensation XLSX starts with a compact store-first summary and preserves price-group details", async () => {
  const workbook = await load(fixture());
  assert.deepEqual(workbook.worksheets.map(s => s.name), ["Компенсации", "Детализация", "Корректировки", "Диагностика"]);
  const summary = workbook.getWorksheet("Компенсации")!;
  const detail = workbook.getWorksheet("Детализация")!;
  const corrections = workbook.getWorksheet("Корректировки")!;
  assert.deepEqual(values(summary.getRow(3)), [
    "Магазин", "Акция", "Период расчёта", "Статус", "Компенсация, ₸", "Рассчитанная часть, ₸", "Подробности"
  ]);
  const blocks = rows(summary).filter(row => ["Маркетинг А", "Маркетинг Б"].includes(row.getCell(2).text));
  assert.deepEqual(blocks.map(values), [
    ["Филиал А", "Маркетинг А", "01.09.2026–15.09.2026", "Рассчитано", 252.4, null, "Детализация"],
    ["Филиал А", "Маркетинг Б", "15.09.2026–30.09.2026", "Рассчитано", 240, null, "Детализация"],
    ["Филиал Б", "Маркетинг А", "01.09.2026–15.09.2026", "Возвраты / корректировки", -126.2, null, "Корректировки"]
  ]);
  assert.ok(!rows(summary).some(row => row.getCell(2).value === "=1+1"));
  const visibleSummary = rows(summary).flatMap(values).join(" ");
  assert.doesNotMatch(visibleSummary, /activity-a|branch-a|№ 001|\[2026-|n\/a/);
  assert.match(summary.getRow(2).getCell(1).text, /01\.09\.2026–30\.09\.2026/);
  const items = rows(detail).filter(row => row.getCell(2).value === "=1+1");
  const returned = rows(corrections).filter(row => row.getCell(2).value === "=1+1");
  assert.equal(detail.columnCount, 7);
  assert.equal(items.length, 2);
  assert.equal(returned.length, 1);
  assert.deepEqual(values(items[0]), ["000123", "=1+1", 631, 0.2, 126.2, 2, 252.4]);
  assert.deepEqual(values(items[1]), ["000123", "=1+1", 800, 0.1, 80, 3, 240]);
  assert.deepEqual(values(returned[0]), ["000123", "=1+1", 631, 0.2, 126.2, -1, -126.2]);
  assert.equal(items[0].getCell(1).type, ExcelJS.ValueType.String);
  assert.equal(items[0].getCell(2).type, ExcelJS.ValueType.String);
  assert.ok(noteText(items[0].getCell(2)).includes("characteristic"));
  assert.ok(noteText(items[1].getCell(3)).includes("Цена до скидки из строки продажи/возврата 1С"));
  const headings = rows(detail).map(row => row.getCell(1).text);
  assert.ok(headings.indexOf("Филиал А") < headings.indexOf("Маркетинг А"));
  assert.ok(headings.indexOf("Маркетинг А") < headings.indexOf("Маркетинг Б"));
  assert.ok(!headings.includes("Филиал Б"));
  assert.equal(rows(summary).find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!.getCell(5).value, 366.2);
});

test("detail and correction sheets label both sources from the returned mode, without changing totals", async () => {
  const report = fixture();
  report.activities = [report.activities[0]];
  const [sale, returned] = report.activities[0].branches;
  sale.rows = [item({ price: 600, discountPct: 25, unitCompensation: 150, compensation: 300 })];
  returned.rows = [item({ price: 500, discountPct: 25, unitCompensation: 125, quantity: -1, compensation: -125 })];
  sale.totals = complete(300);
  returned.totals = complete(-125);
  report.activities[0].totals = report.totals = complete(175);
  report.calculationMode = "purchase-title";
  const purchased = await load(report);
  for (const sheet of purchased.worksheets) {
    assert.match(sheet.getCell("A2").text, /Закупочная цена и процент из названия акции/);
    assert.doesNotMatch(sheet.getCell("A2").text, /розничная цена|процент из правила/i);
  }
  for (const [name, expected] of [
    ["Детализация", [600, 0.25, 150, 2, 300]],
    ["Корректировки", [500, 0.25, 125, -1, -125]]
  ] as const) {
    const sheet = purchased.getWorksheet(name)!;
    assert.deepEqual(values(sheet.getRow(3)).slice(2, 4), ["Закупочная цена, ₸", "Процент из названия акции, %"]);
    const line = rows(sheet).find(row => row.getCell(2).text === "=1+1")!;
    assert.deepEqual(values(line).slice(2), expected);
    assert.match(noteText(line.getCell(3)), /Маркетинг → Виды цен/);
    assert.match(noteText(line.getCell(4)), /из названия акции/);
  }
  const purchasedDiagnostics = purchased.getWorksheet("Диагностика")!;
  const rowContexts = rows(purchasedDiagnostics).filter(row => row.getCell(6).text === "row_context");
  assert.equal(rowContexts.length, 2);
  for (const row of rowContexts) {
    assert.match(row.getCell(7).text, /закупочн.*названия акции/i);
    assert.doesNotMatch(row.getCell(7).text, /цена до скидки/i);
  }
  assert.equal(rows(purchased.getWorksheet("Компенсации")!).find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!.getCell(5).value, 175);

  const legacy = await load(fixture());
  assert.match(legacy.getWorksheet("Компенсации")!.getCell("A2").text, /Прежний расчёт: розничная цена и процент из правила/);
  const legacyDetail = legacy.getWorksheet("Детализация")!;
  assert.deepEqual(values(legacyDetail.getRow(3)).slice(2, 4), ["Розничная цена до скидки, ₸", "Процент из правила скидки, %"]);
  const line = rows(legacyDetail).find(row => row.getCell(2).text === "=1+1")!;
  assert.match(noteText(line.getCell(3)), /из строки продажи\/возврата/);
  assert.match(noteText(line.getCell(4)), /префикс названия правила/i);
});

test("compensation XLSX counts sales 200 and return-only -80 once and uses report totals verbatim", async () => {
  const report = fixture();
  report.activities = [report.activities[0]];
  const [sale, returned] = report.activities[0].branches;
  sale.rows = [item({ name: "Продажа", compensation: 200 })];
  returned.rows = [item({ name: "Возврат", quantity: -1, compensation: -80 })];
  sale.totals = complete(200);
  returned.totals = complete(-80);
  report.activities[0].totals = complete(120);
  report.totals = complete(120);
  const workbook = await load(report);
  const summary = workbook.getWorksheet("Компенсации")!;
  const blocks = rows(summary).filter(row => row.getCell(2).text === "Маркетинг А");
  assert.deepEqual(blocks.map(row => row.getCell(5).value), [200, -80]);
  assert.equal(rows(summary).find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!.getCell(5).value, 120);
  assert.equal(rows(workbook.getWorksheet("Детализация")!).filter(row => row.getCell(2).text === "Возврат").length, 0);
  assert.equal(rows(workbook.getWorksheet("Корректировки")!).filter(row => row.getCell(2).text === "Возврат").length, 1);
  report.totals = complete(777);
  const independent = (await load(report)).getWorksheet("Компенсации")!;
  assert.equal(rows(independent).find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!.getCell(5).value, 777);
});

test("compensation XLSX preserves unknown totals and real zeros without partial-sum substitution", async () => {
  const report = fixture();
  report.includeIncomplete = true;
  const branch = report.activities[0].branches[0];
  branch.rows.push(item({
    itemKey: "missing", name: "Недостающие данные", barcode: null, price: null, discountPct: null,
    unitCompensation: null, quantity: null, compensation: null,
    issues: [{ code: "missing_sources", message: "Недостаточно исходных данных" }]
  }), item({ itemKey: "zero", name: "Нулевые данные", barcode: "000000", price: 0, discountPct: 0, unitCompensation: 0, quantity: 0, compensation: 0 }));
  branch.totals = { compensation: null, knownCompensation: 252.4, incompleteRows: 1 };
  report.activities[0].totals = { compensation: null, knownCompensation: 126.2, incompleteRows: 1 };
  report.totals = { compensation: null, knownCompensation: 366.2, incompleteRows: 1 };
  const workbook = await load(report);
  const sheet = workbook.getWorksheet("Детализация")!;
  const missing = rows(sheet).find(row => row.getCell(2).value === "Недостающие данные")!;
  assert.equal(missing.getCell(1).value, null);
  for (const column of [3, 4, 5, 6, 7]) unavailable(missing.getCell(column));
  const zero = rows(sheet).find(row => row.getCell(2).value === "Нулевые данные")!;
  assert.deepEqual(values(zero).slice(2), [0, 0, 0, 0, 0]);
  const summary = workbook.getWorksheet("Компенсации")!;
  const incomplete = rows(summary).find(row => row.getCell(1).text === "Филиал А" && row.getCell(2).text === "Маркетинг А")!;
  assert.deepEqual(values(incomplete).slice(3, 6), ["Нужна проверка", "Не рассчитано", 252.4]);
  const total = rows(summary).find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!;
  assert.deepEqual(values(total).slice(3, 6), ["Нужна проверка", "Не рассчитано", 366.2]);
});

test("compensation XLSX keeps known store subtotals separate from an unknown report-wide total", async () => {
  const report = fixture();
  report.includeIncomplete = true;
  report.issues = [{ code: "missing_branch", message: "Есть движения с неопределённым филиалом" }];
  report.totals = { compensation: null, knownCompensation: 366.2, incompleteRows: 0 };
  const summary = rows((await load(report)).getWorksheet("Компенсации")!);
  assert.deepEqual(summary.filter(row => row.getCell(1).text.startsWith("Итого по магазину"))
    .map(row => row.getCell(5).value), [492.4, -126.2]);
  const total = summary.find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!;
  assert.deepEqual(values(total).slice(3, 6), ["Нужна проверка", "Не рассчитано", 366.2]);
});

test("compensation XLSX includes every diagnostic level with keys, dates and formula-safe messages", async () => {
  const report = fixture();
  report.activities[0].name = "=SUM(1,2)";
  report.issues.push({ code: "source_missing", message: "=HYPERLINK(\"https://example.test\")" });
  report.activities[0].issues.push({ code: "duplicate", message: "Activity issue" });
  const branch = report.activities[0].branches[0];
  branch.name = "=HYPERLINK(\"https://example.test\")";
  branch.issues.push({ code: "duplicate", message: "Branch issue" });
  branch.rows[0].issues.push({ code: "duplicate", message: "Row issue" }, { code: "missing_barcode", message: "Barcode issue" });
  const workbook = await load(report);
  const summary = rows(workbook.getWorksheet("Компенсации")!);
  const hostile = summary.find(row => row.getCell(2).text === "=SUM(1,2)" && row.getCell(1).text === branch.name)!;
  assert.equal(hostile.getCell(1).type, ExcelJS.ValueType.String);
  assert.equal(hostile.getCell(2).type, ExcelJS.ValueType.String);
  const diagnostics = workbook.worksheets.at(-1)!;
  const details = rows(diagnostics).filter(row => ["source_missing", "duplicate", "missing_barcode"].includes(String(row.getCell(6).value)));
  assert.equal(details.length, 5);
  assert.deepEqual(details.map(row => row.getCell(6).value).sort(), ["duplicate", "duplicate", "duplicate", "missing_barcode", "source_missing"]);
  assert.equal(new Set(details.map(row => row.getCell(1).value)).size, 4);
  const source = details.find(row => row.getCell(6).value === "source_missing")!;
  assert.equal(source.getCell(7).value, "=HYPERLINK(\"https://example.test\")");
  assert.equal(source.getCell(7).type, ExcelJS.ValueType.String);
  const rowIssue = details.find(row => row.getCell(7).value === "Row issue")!;
  assert.ok(rowIssue.getCell(2).text.includes("activity-a"));
  assert.ok(rowIssue.getCell(3).text.includes("branch-a"));
  assert.ok(rowIssue.getCell(4).text.includes("same-item"));
  assert.ok(rowIssue.getCell(4).text.includes("characteristic"));
  for (const date of ["01.09.2026", "15.09.2026"]) assert.ok(rowIssue.getCell(5).text.includes(date));
  for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
    assert.notEqual(cell.type, ExcelJS.ValueType.Formula);
    assert.notEqual(cell.type, ExcelJS.ValueType.Error);
  }));
});

test("compensation XLSX keeps equal store names and an unknown store in separate subtotal groups", async () => {
  const report = fixture();
  report.activities[0].branches[1].name = "Филиал А";
  report.activities[0].branches[1].hasSales = true;
  report.activities[0].branches.push({
    ...report.activities[0].branches[0], key: null, name: "Филиал А", rows: [item({ compensation: 0.1 })], totals: complete(0.1)
  });
  report.activities[1].branches[0].totals = complete(0.2);
  const workbook = await load(report);
  assert.deepEqual(workbook.worksheets.map(s => s.name), ["Компенсации", "Детализация", "Диагностика"]);
  const summary = workbook.getWorksheet("Компенсации")!;
  const subtotals = rows(summary).filter(row => row.getCell(1).text.startsWith("Итого по магазину"));
  assert.equal(subtotals.length, 3);
  assert.deepEqual(subtotals.map(row => row.getCell(5).value), [0.1, 252.6, -126.2]);
  const detail = workbook.getWorksheet("Детализация")!;
  assert.equal(rows(detail).filter(row => row.getCell(1).text === "Филиал А").length, 3);
  assert.equal(rows(detail).filter(row => row.getCell(2).text === "=1+1").length, 4);
  const diagnostics = rows(workbook.getWorksheet("Диагностика")!);
  for (const key of ["branch-a", "branch-b"]) assert.ok(diagnostics.some(row => row.getCell(3).text.includes(key)));
});

test("compensation XLSX omits proven inactive blocks but keeps zero-net sales and unknown diagnostics", async () => {
  const report = fixture();
  const inactive = { ...report.activities[0].branches[0], key: "inactive", name: "Нет движений", hasSales: false, hasReturns: false, rows: [], totals: complete(0) };
  report.activities[0].branches.push(inactive);
  report.activities[0].branches[0].rows[0].quantity = 0;
  report.activities[0].branches[0].rows[0].compensation = 0;
  report.activities[0].branches[0].hasReturns = true;
  report.activities[0].branches[0].totals = complete(0);
  report.totals = complete(113.8);
  const workbook = await load(report);
  const summary = workbook.getWorksheet("Компенсации")!;
  assert.ok(!rows(summary).some(row => row.getCell(1).text === "Нет движений"));
  assert.equal(rows(workbook.getWorksheet("Детализация")!).find(row => row.getCell(2).text === "=1+1")!.getCell(6).value, 0);
  const excluded = rows(workbook.getWorksheet("Диагностика")!).find(row => row.getCell(6).text === "no_movements")!;
  assert.ok(excluded.getCell(3).text.includes("inactive"));
  report.activities = [];
  report.includeIncomplete = true;
  report.issues = [{ code: "missing_source", message: "Нет источника" }];
  report.totals = { compensation: null, knownCompensation: 0, incompleteRows: 0 };
  const unknown = (await load(report)).getWorksheet("Компенсации")!;
  const total = rows(unknown).find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!;
  assert.deepEqual(values(total).slice(3, 6), ["Нужна проверка", "Не рассчитано", 0]);
  assert.ok(rows(unknown).some(row => row.getCell(1).text === "Не удалось полностью рассчитать"));
  assert.ok(!rows(unknown).some(row => row.getCell(1).text === "За выбранный период продаж и возвратов не было"));
});

test("compensation XLSX exports an empty report with known zero totals and a diagnostic sheet", async () => {
  const report = fixture();
  report.activities = [];
  report.totals = complete(0);
  const workbook = await load(report);
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ["Компенсации", "Детализация", "Диагностика"]);
  const summary = workbook.getWorksheet("Компенсации")!;
  const total = rows(summary).find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!;
  assert.equal(total.getCell(5).value, 0);
  assert.equal(total.getCell(6).value, null);
  assert.ok(rows(summary).some(row => row.getCell(1).text === "За выбранный период продаж и возвратов не было"));
  assert.equal(workbook.getWorksheet("Диагностика")!.columnCount, 7);
});

test("compensation XLSX keeps known money available when only the barcode is missing", async () => {
  const report = fixture();
  const branch = report.activities[0].branches[1];
  branch.rows[0].barcode = null;
  branch.rows[0].issues = [{ code: "missing_barcode", message: "Штрихкод отсутствует" }];
  const workbook = await load(report);
  const sheet = workbook.getWorksheet("Корректировки")!;
  const detail = rows(sheet).find(row => row.getCell(2).value === "=1+1")!;
  assert.equal(detail.getCell(1).value, null);
  assert.equal(detail.getCell(7).value, -126.2);
  assert.equal(sheet.lastRow!.getCell(7).value, -126.2);
  const summary = workbook.getWorksheet("Компенсации")!;
  assert.equal(rows(summary).find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!.getCell(5).value, 366.2);
});

test("compensation XLSX retains false movement flags with unknown quantity in review details", async () => {
  const report = fixture();
  report.includeIncomplete = true;
  const branch = report.activities[0].branches[0];
  branch.hasSales = false;
  branch.hasReturns = false;
  branch.rows = [item({
    name: "Количество неизвестно", quantity: null, price: null, compensation: null,
    issues: [{ code: "missing_quantity", message: "Количество движения не определено" }]
  })];
  branch.totals = { compensation: null, knownCompensation: 0, incompleteRows: 1 };
  report.activities[0].totals = { compensation: null, knownCompensation: -126.2, incompleteRows: 1 };
  report.totals = { compensation: null, knownCompensation: 113.8, incompleteRows: 1 };
  const workbook = await load(report);
  const summary = rows(workbook.getWorksheet("Компенсации")!);
  const block = summary.find(row => row.getCell(1).text === "Филиал А" && row.getCell(2).text === "Маркетинг А")!;
  assert.deepEqual(values(block).slice(3, 6), ["Нужна проверка", "Не рассчитано", 0]);
  assert.match(block.getCell(7).text, /Детализация/);
  const detail = rows(workbook.getWorksheet("Детализация")!);
  assert.ok(detail.some(row => row.getCell(1).text === "Требует проверки"));
  const source = detail.find(row => row.getCell(2).text === "Количество неизвестно")!;
  unavailable(source.getCell(3));
  unavailable(source.getCell(6));
  const unresolved = rows(workbook.getWorksheet("Диагностика")!).find(row => row.getCell(6).text === "unresolved_movements")!;
  assert.match(unresolved.getCell(7).text, /включён.*сводку.*детализац/i);
  assert.doesNotMatch(unresolved.getCell(7).text, /не включён/i);
});

test("compensation XLSX shows activity-only and report blockers without inventing a store", async () => {
  const report = fixture();
  report.includeIncomplete = true;
  report.activities = [{
    ...report.activities[0], branches: [],
    issues: [{ code: "missing_branch", message: "Не определён филиал активности" }],
    totals: { compensation: null, knownCompensation: 0, incompleteRows: 0 }
  }];
  report.issues = [{ code: "missing_source", message: "Нет источника" }];
  report.totals = { compensation: null, knownCompensation: 0, incompleteRows: 0 };
  const workbook = await load(report);
  const summary = rows(workbook.getWorksheet("Компенсации")!);
  assert.ok(summary.some(row => row.getCell(1).text === "Не удалось полностью рассчитать"));
  const scope = summary.find(row => row.getCell(2).text === "Маркетинг А")!;
  assert.equal(scope.getCell(1).value, null);
  assert.equal(scope.getCell(4).value, "Нужна проверка");
  assert.match(scope.getCell(7).text, /Диагностика/);
  const total = summary.find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!;
  assert.deepEqual(values(total).slice(4, 6), ["Не рассчитано", 0]);
  const diagnostics = rows(workbook.getWorksheet("Диагностика")!);
  assert.ok(diagnostics.some(row => row.getCell(6).text === "missing_branch"));
  assert.ok(diagnostics.some(row => row.getCell(6).text === "missing_source"));
});

test("compensation XLSX does not hide an inactive-looking branch under unresolved activity scope", async () => {
  const report = fixture();
  report.includeIncomplete = true;
  const activity = report.activities[0];
  activity.branches = [{
    ...activity.branches[0], name: "Проверяемый магазин", hasSales: false, hasReturns: false,
    rows: [], issues: [], totals: complete(0)
  }];
  activity.issues = [{ code: "missing_rule", message: "Нет правила" }];
  activity.totals = { compensation: null, knownCompensation: 0, incompleteRows: 0 };
  report.activities = [activity];
  report.totals = { compensation: null, knownCompensation: 0, incompleteRows: 0 };
  const workbook = await load(report);
  const block = rows(workbook.getWorksheet("Компенсации")!).find(row => row.getCell(1).text === "Проверяемый магазин")!;
  assert.equal(block.getCell(4).value, "Нужна проверка");
  assert.ok(!rows(workbook.getWorksheet("Диагностика")!).some(row => row.getCell(6).text === "no_movements"));
});

test("compensation XLSX retains a coverage issue even when movement flags and totals look empty", async () => {
  const report = fixture();
  report.includeIncomplete = true;
  const activity = report.activities[0];
  activity.branches = [{
    ...activity.branches[0], hasSales: false, hasReturns: false, rows: [], totals: complete(0),
    issues: [{ code: "missing_quantity", message: "Нет отчётов продаж; отсутствие движений не подтверждено" }]
  }];
  activity.totals = complete(0);
  report.activities = [activity];
  report.totals = complete(0);
  const workbook = await load(report);
  const block = rows(workbook.getWorksheet("Компенсации")!).find(row => row.getCell(2).text === "Маркетинг А")!;
  assert.equal(block.getCell(4).value, "Нужна проверка");
  const diagnostics = rows(workbook.getWorksheet("Диагностика")!);
  assert.ok(diagnostics.some(row => row.getCell(6).text === "missing_quantity"));
  assert.ok(diagnostics.some(row => row.getCell(6).text === "unresolved_movements"));
  const total = rows(workbook.getWorksheet("Компенсации")!).find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!;
  assert.equal(total.getCell(4).value, "Нужна проверка");
  assert.ok(!diagnostics.some(row => row.getCell(6).text === "no_movements"));
});

test("compensation XLSX keeps fallback identifiers and document numbers out of readable names", async () => {
  for (const fallback of ["key", "number"] as const) {
    const report = fixture();
    const activity = report.activities[0];
    activity.name = fallback === "key" ? activity.key : activity.number!;
    activity.branches = [activity.branches[0]];
    activity.branches[0].rows = [item({ name: "same-item" })];
    activity.totals = complete(252.4);
    report.activities = [activity];
    report.totals = complete(252.4);
    const workbook = await load(report);
    const summary = rows(workbook.getWorksheet("Компенсации")!);
    assert.ok(summary.some(row => row.getCell(2).text === "Акция без названия"));
    assert.ok(!summary.some(row => row.getCell(2).text === activity.name));
    const detail = rows(workbook.getWorksheet("Детализация")!);
    assert.ok(detail.some(row => row.getCell(2).text === "Товар не определён"));
    const diagnostics = rows(workbook.getWorksheet("Диагностика")!);
    assert.ok(diagnostics.some(row => row.getCell(2).text.includes("activity-a") && row.getCell(2).text.includes("001")));
    assert.ok(diagnostics.some(row => row.getCell(4).text.includes("same-item")));
  }
});

test("compensation XLSX gives incomplete return-only totals review priority and keeps known zero numeric", async () => {
  const report = fixture();
  report.includeIncomplete = true;
  const returned = report.activities[0].branches[1];
  returned.totals = { compensation: -80, knownCompensation: 0, incompleteRows: 1 };
  report.activities[0].totals = { compensation: null, knownCompensation: 252.4, incompleteRows: 1 };
  report.totals = { compensation: null, knownCompensation: 492.4, incompleteRows: 1 };
  const summary = rows((await load(report)).getWorksheet("Компенсации")!);
  const block = summary.find(row => row.getCell(1).text === "Филиал Б" && row.getCell(2).text === "Маркетинг А")!;
  assert.deepEqual(values(block).slice(3, 6), ["Нужна проверка", "Не рассчитано", 0]);
  assert.match(block.getCell(7).text, /Корректировки.*возврат/i);
});

test("compensation XLSX preserves numeric-zero sales and an all-inactive report remains a known empty result", async () => {
  const report = fixture();
  const activity = report.activities[0];
  activity.branches = [{ ...activity.branches[0], rows: [item({ compensation: 0 })], totals: complete(0) }];
  activity.totals = complete(0);
  report.activities = [activity];
  report.totals = complete(0);
  const sales = rows((await load(report)).getWorksheet("Компенсации")!);
  assert.ok(sales.some(row => row.getCell(2).text === "Маркетинг А" && row.getCell(5).value === 0));
  activity.branches[0].hasSales = false;
  activity.branches[0].rows = [];
  const empty = rows((await load(report)).getWorksheet("Компенсации")!);
  assert.ok(!empty.some(row => row.getCell(2).text === "Маркетинг А"));
  assert.ok(empty.some(row => row.getCell(1).text === "За выбранный период продаж и возвратов не было"));
});

test("default compensation XLSX removes incomplete price groups from every financial sheet but retains diagnostics and partial totals", async () => {
  const report = fixture();
  const sale = report.activities[0].branches[0];
  const returned = report.activities[0].branches[1];
  sale.rows.push(item({ name: "Скрытая цена", price: null, compensation: null, issues: [{ code: "missing_price", message: "Не определена цена" }] }));
  returned.rows.push(item({ name: "Скрытый возврат", quantity: null, compensation: null }));
  sale.totals = { compensation: null, knownCompensation: 252.4, incompleteRows: 1 };
  returned.totals = { compensation: null, knownCompensation: -126.2, incompleteRows: 1 };
  report.activities[0].totals = { compensation: null, knownCompensation: 126.2, incompleteRows: 2 };
  report.totals = { compensation: null, knownCompensation: 366.2, incompleteRows: 2 };
  const workbook = await load(projectCompensationReport(report));
  for (const name of ["Компенсации", "Детализация", "Корректировки"]) {
    const visible = rows(workbook.getWorksheet(name)!).flatMap(values).join(" ");
    assert.doesNotMatch(visible, /Скрытая цена|Скрытый возврат|Не рассчитано|Нет данных/);
  }
  const total = rows(workbook.getWorksheet("Компенсации")!).find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!;
  assert.equal(total.getCell(5).value, null, "known part must not become a complete total");
  assert.equal(total.getCell(6).value, 366.2);
  assert.match(total.getCell(4).text, /неполный/i);
  const diagnostics = rows(workbook.getWorksheet("Диагностика")!);
  assert.ok(diagnostics.some(row => row.getCell(6).text === "missing_price"));
  assert.ok(diagnostics.some(row => row.getCell(4).text.includes("Скрытый возврат")));
  assert.match(workbook.getWorksheet("Компенсации")!.getRow(2).getCell(1).text, /Исключено.*2/);
});

test("default compensation XLSX all-filtered scopes are not no-movement or fabricated zero totals", async () => {
  const report = fixture();
  report.activities = [report.activities[0]];
  const activity = report.activities[0];
  activity.branches = [activity.branches[0]];
  activity.branches[0].rows = [item({ name: "Без процента", discountPct: null, unitCompensation: null, compensation: null })];
  activity.branches[0].totals = { compensation: null, knownCompensation: 0, incompleteRows: 1 };
  activity.totals = report.totals = { compensation: null, knownCompensation: 0, incompleteRows: 1 };
  const workbook = await load(report);
  const summary = rows(workbook.getWorksheet("Компенсации")!);
  assert.ok(!summary.some(row => row.getCell(2).text === "Маркетинг А"));
  assert.match(summary.flatMap(values).join(" "), /Нет строк с полным расчётом/);
  assert.doesNotMatch(summary.flatMap(values).join(" "), /продаж и возвратов не было|Не рассчитано/);
  const total = summary.find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!;
  assert.equal(total.getCell(5).value, null);
  assert.equal(total.getCell(6).value, 0);
  report.includeIncomplete = true;
  const restored = await load(report);
  assert.ok(rows(restored.getWorksheet("Детализация")!).some(row => row.getCell(2).text === "Без процента"));
});

test("default compensation XLSX never relabels a filtered source total as a complete visible total", async () => {
  const report = fixture();
  report.activities[0].branches[0].rows.push(item({ price: Infinity, name: "Невычислимая строка" }));
  report.totals = complete(777);
  const summary = rows((await load(report)).getWorksheet("Компенсации")!);
  const total = summary.find(row => row.getCell(1).text === "ОБЩИЙ ИТОГ")!;
  assert.equal(total.getCell(5).value, null);
  assert.equal(total.getCell(6).value, 777);
  assert.match(total.getCell(4).text, /неполный/i);
  const branch = summary.find(row => row.getCell(1).text === "Филиал А" && row.getCell(2).text === "Маркетинг А")!;
  assert.equal(branch.getCell(5).value, null);
  assert.equal(branch.getCell(6).value, 252.4);
});

test("default compensation XLSX keeps activity-only blockers exclusively in diagnostics", async () => {
  const report = fixture();
  report.activities = [{
    ...report.activities[0], branches: [], totals: { compensation: null, knownCompensation: 0, incompleteRows: 0 },
    issues: [{ code: "missing_branch", message: "Не определён филиал активности" }]
  }];
  report.totals = { compensation: null, knownCompensation: 0, incompleteRows: 0 };
  const workbook = await load(report);
  const summary = rows(workbook.getWorksheet("Компенсации")!);
  assert.ok(!summary.some(row => row.getCell(2).text === "Маркетинг А"));
  assert.doesNotMatch(summary.flatMap(values).join(" "), /Не рассчитано|продаж и возвратов не было/);
  assert.match(summary.flatMap(values).join(" "), /Нет строк с полным расчётом/);
  assert.ok(rows(workbook.getWorksheet("Диагностика")!).some(row => row.getCell(6).text === "missing_branch"));
});

test("compensation XLSX rejects an already closed download", async () => {
  const output = new PassThrough();
  output.destroy();
  await assert.rejects(writeMarketingCompensationWorkbook(fixture(), output), Error);
});

test("compensation XLSX stops reading detail rows when the download closes during generation", { timeout: 10_000 }, async () => {
  const report = fixture();
  let visited = 0;
  const tracked = item();
  Object.defineProperty(tracked, "barcode", {
    get() { visited++; return "000123"; }
  });
  const branch = report.activities[0].branches[0];
  branch.rows = Array<CompensationRow>(4096).fill(tracked);
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
      if (visited > 0) this.destroy();
    }
  });
  await assert.rejects(writeMarketingCompensationWorkbook(report, output), Error);
  assert.ok(visited > 0, "the download must close after detail generation starts");
  assert.ok(visited < branch.rows.length, "closed downloads must stop further detail generation");
});

test("compensation XLSX propagates download write failures", { timeout: 10_000 }, async () => {
  const failure = new Error("Download write failed");
  const output = new Writable({
    write(_chunk, _encoding, callback) { callback(failure); }
  });
  await assert.rejects(writeMarketingCompensationWorkbook(fixture(), output), error => error === failure);
});
