import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { buffer } from "node:stream/consumers";
import ExcelJS from "exceljs";
import { writeMarketingCompensationWorkbook } from "../src/services/marketing-compensation-workbook.js";
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
    from: "2026-09-01", to: "2026-10-01", activityKey: null, issues: [], totals: complete(366.2),
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
  assert.ok(cell.text.length > 0, "unavailable data must be visible, not blank or zero");
}
function noteText(cell: ExcelJS.Cell): string {
  const note = cell.note;
  return typeof note === "string" ? note : note?.texts?.map(part => part.text ?? "").join("") ?? "";
}

test("compensation XLSX groups stores before activities and separates return-only adjustments", async () => {
  const workbook = await load(fixture());
  assert.deepEqual(workbook.worksheets.map(s => s.name), ["Компенсации", "Корректировки", "Диагностика"]);
  const main = workbook.worksheets[0];
  const corrections = workbook.worksheets[1];
  const items = rows(main).filter(row => row.getCell(2).value === "=1+1");
  const returned = rows(corrections).filter(row => row.getCell(2).value === "=1+1");
  assert.equal(main.columnCount, 7);
  assert.equal(items.length, 2);
  assert.equal(returned.length, 1);
  assert.deepEqual(values(items[0]), ["000123", "=1+1", 631, 0.2, 126.2, 2, 252.4]);
  assert.deepEqual(values(items[1]), ["000123", "=1+1", 800, 0.1, 80, 3, 240]);
  assert.deepEqual(values(returned[0]), ["000123", "=1+1", 631, 0.2, 126.2, -1, -126.2]);
  assert.equal(items[0].getCell(1).type, ExcelJS.ValueType.String);
  assert.equal(items[0].getCell(2).type, ExcelJS.ValueType.String);
  assert.ok(noteText(items[0].getCell(2)).includes("2026-09-16"));
  assert.ok(noteText(items[1].getCell(3)).includes("Цена до скидки из строки продажи/возврата 1С"));
  const find = (label: string) => rows(main).find(r => r.getCell(1).text.startsWith(label))!;
  assert.equal(find("ИТОГО по акциям с продажами").getCell(7).value, 492.4);
  assert.equal(find("Корректировки по возвратам").getCell(7).value, -126.2);
  assert.equal(find("ОБЩИЙ ИТОГ с корректировками").getCell(7).value, 366.2);
  const headings = rows(main).map(r => r.getCell(1).text);
  assert.ok(headings.findIndex(v => v.includes("branch-a")) < headings.findIndex(v => v.includes("activity-a")));
  assert.ok(headings.findIndex(v => v.includes("activity-a")) < headings.findIndex(v => v.includes("activity-b")));
  assert.ok(!headings.some(v => v.includes("branch-b")));
});

test("compensation XLSX preserves unknown totals and real zeros without partial-sum substitution", async () => {
  const report = fixture();
  const branch = report.activities[0].branches[0];
  branch.rows.push(item({
    itemKey: "missing", name: "Недостающие данные", barcode: null, price: null, discountPct: null,
    unitCompensation: null, quantity: null, compensation: null,
    issues: [{ code: "missing_sources", message: "Недостаточно исходных данных" }]
  }), item({ itemKey: "zero", name: "Нулевые данные", barcode: "000000", price: 0, discountPct: 0, unitCompensation: 0, quantity: 0, compensation: 0 }));
  branch.totals = { compensation: null, knownCompensation: 252.4, incompleteRows: 1 };
  report.activities[0].totals = { compensation: null, knownCompensation: 126.2, incompleteRows: 1 };
  report.totals = { compensation: null, knownCompensation: 366.2, incompleteRows: 1 };
  const sheet = (await load(report)).worksheets[0];
  const missing = rows(sheet).find(row => row.getCell(2).value === "Недостающие данные")!;
  for (const column of [1, 3, 4, 5, 6, 7]) unavailable(missing.getCell(column));
  const zero = rows(sheet).find(row => row.getCell(2).value === "Нулевые данные")!;
  assert.deepEqual(values(zero).slice(2), [0, 0, 0, 0, 0]);
  const total = rows(sheet).find(r => r.getCell(1).text.startsWith("ОБЩИЙ ИТОГ с корректировками"))!;
  unavailable(total.getCell(7));
  assert.equal(sheet.lastRow!.getCell(7).value, 366.2);
  assert.match(sheet.lastRow!.getCell(1).text, /Известная часть/);
});

test("compensation XLSX includes every diagnostic level with keys, dates and formula-safe messages", async () => {
  const report = fixture();
  report.issues.push({ code: "source_missing", message: "=HYPERLINK(\"https://example.test\")" });
  report.activities[0].issues.push({ code: "duplicate", message: "Activity issue" });
  const branch = report.activities[0].branches[0];
  branch.issues.push({ code: "duplicate", message: "Branch issue" });
  branch.rows[0].issues.push({ code: "duplicate", message: "Row issue" }, { code: "missing_barcode", message: "Barcode issue" });
  const workbook = await load(report);
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
  for (const date of ["2026-09-01", "2026-09-16"]) assert.ok(rowIssue.getCell(5).text.includes(date));
  for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => {
    assert.notEqual(cell.type, ExcelJS.ValueType.Formula);
    assert.notEqual(cell.type, ExcelJS.ValueType.Error);
  }));
});

test("compensation XLSX never merges different store keys with the same display name", async () => {
  const report = fixture();
  report.activities[0].branches[1].name = "Филиал А";
  report.activities[0].branches[1].hasSales = true;
  const workbook = await load(report);
  assert.deepEqual(workbook.worksheets.map(s => s.name), ["Компенсации", "Диагностика"]);
  const main = workbook.worksheets[0];
  const headings = rows(main).filter(r => /^Филиал А \[branch-/.test(r.getCell(1).text));
  assert.deepEqual(headings.map(r => r.getCell(1).text), ["Филиал А [branch-a]", "Филиал А [branch-b]"]);
  assert.equal(rows(main).filter(r => r.getCell(1).text.startsWith("Итого по магазину")).length, 2);
  assert.equal(rows(main).filter(r => r.getCell(2).text === "=1+1").length, 3);
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
  assert.ok(!rows(workbook.worksheets[0]).some(r => r.getCell(1).text.includes("inactive")));
  assert.equal(rows(workbook.worksheets[0]).find(r => r.getCell(2).text === "=1+1")!.getCell(6).value, 0);
  assert.ok(rows(workbook.getWorksheet("Диагностика")!).some(r => r.getCell(3).text.includes("inactive")));
  report.activities = [];
  report.issues = [{ code: "missing_source", message: "Нет источника" }];
  report.totals = { compensation: null, knownCompensation: 0, incompleteRows: 0 };
  const unknown = (await load(report)).worksheets[0];
  unavailable(rows(unknown).find(r => r.getCell(1).text === "ОБЩИЙ ИТОГ с корректировками")!.getCell(7));
  assert.ok(!rows(unknown).some(r => r.getCell(1).text === "Нет продаж за выбранный период"));
});

test("compensation XLSX exports an empty report with known zero totals and a diagnostic sheet", async () => {
  const report = fixture();
  report.activities = [];
  report.totals = complete(0);
  const workbook = await load(report);
  assert.equal(workbook.worksheets.length, 2);
  assert.equal(workbook.worksheets[0].lastRow!.getCell(7).value, 0);
  assert.ok(rows(workbook.worksheets[0]).some(r => r.getCell(1).text === "Нет продаж за выбранный период"));
  assert.equal(workbook.worksheets[1].columnCount, 7);
});

test("compensation XLSX keeps known money available when only the barcode is missing", async () => {
  const report = fixture();
  const branch = report.activities[0].branches[1];
  branch.rows[0].barcode = null;
  branch.rows[0].issues = [{ code: "missing_barcode", message: "Штрихкод отсутствует" }];
  const workbook = await load(report);
  const sheet = workbook.getWorksheet("Корректировки")!;
  const detail = rows(sheet).find(row => row.getCell(2).value === "=1+1")!;
  unavailable(detail.getCell(1));
  assert.equal(detail.getCell(7).value, -126.2);
  assert.equal(sheet.lastRow!.getCell(7).value, -126.2);
  assert.equal(workbook.worksheets[0].lastRow!.getCell(7).value, 366.2);
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
