import ExcelJS from "exceljs";
import type { Writable } from "node:stream";
import type { TurnoverMode, TurnoverReport, TurnoverRow, TurnoverTotal, TurnoverTotals } from "./turnover-types.js";
import { formatTurnoverCoefficientRange, styleTurnoverCoefficient } from "./turnover-coefficient-workbook.js";
import { writeTurnoverSummarySheet } from "./turnover-summary-workbook.js";

const MAIN_UNITS = "рассчет оборачиваемости";
const MAIN_MONEY = "рассчет оборачиваемости ";
const SALES_UNITS = "Продажи за период ";
const SALES_MONEY = "Продажи за период ";
const MAIN_BOTH_MONEY = "рассчет оборачиваемости деньги";
const SALES_BOTH_MONEY = "Продажи за период в деньгах";
const MARGINS = { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };
const DAY_MS = 86_400_000;
type PageSetupWithCopies = ExcelJS.PageSetup & { copies?: number };

function setFullPageSetup(sheet: ExcelJS.Worksheet) {
  const setup = sheet.pageSetup;
  setup.paperSize = 9;
  setup.orientation = "landscape";
  setup.fitToPage = false;
  setup.fitToWidth = 1;
  setup.fitToHeight = 1;
  setup.scale = 100;
  setup.pageOrder = "downThenOver";
  setup.horizontalDpi = 0;
  setup.verticalDpi = 0;
  setup.blackAndWhite = false;
  setup.draft = false;
  setup.cellComments = "None";
  setup.errors = "displayed";
  setup.margins = MARGINS;
  // ExcelJS reads/writes this print field but omits it from PageSetup's type.
  const printable = setup as PageSetupWithCopies;
  printable.copies = 4;
}

type RowLabel = { row: TurnoverRow; label: string };
type SampleMode = Exclude<TurnoverMode, "both">;
type SampleOptions = { mode: SampleMode; salesSheet: string; mainSheet: string; activeCell: string; autoFilter: boolean };
type CellFormula = { formula: string; result?: unknown };
type StreamingSheet = ExcelJS.Worksheet & { commit(): void };

function isCellFormula(value: unknown): value is CellFormula {
  return typeof value === "object" && value !== null && "formula" in value
    && typeof value.formula === "string";
}

function dateRange(from: string, toExclusive: string): string[] {
  const dates: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${toExclusive}T00:00:00Z`);
  for (let at = start; at < end; at += DAY_MS) dates.push(new Date(at).toISOString().slice(0, 10));
  return dates;
}

function dayLabel(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
}

function columnLetter(index: number): string {
  let value = index;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function labelRows(report: TurnoverReport): RowLabel[] {
  const base = report.rows.map((row) => ({ row, label: row.name }));
  const counts = new Map<string, number>();
  for (const entry of base) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
  const used = new Map<string, number>();
  return base.map(({ row, label }) => {
    let value = label;
    if ((counts.get(label) ?? 0) > 1) value = `${label} [${row.sku ?? row.storeKey ?? ""}]`;
    const seen = (used.get(value) ?? 0) + 1;
    used.set(value, seen);
    return { row, label: seen > 1 ? `${value} #${seen}` : value };
  });
}

function numeric(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeSum(values: Array<number | null | undefined>): number | null {
  let total = 0;
  for (const value of values) {
    if (!numeric(value)) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}

function mainHeaders(days: string[]): string[] {
  const headers = ["Номенклатура ", dayLabel(days[0]!), `${dayLabel(days[0]!)} / 2`];
  for (let index = 1; index < days.length - 1; index++) headers.push(dayLabel(days[index]!));
  headers.push(`${dayLabel(days[days.length - 1]!)} / 2`, dayLabel(days[days.length - 1]!));
  headers.push("сумма остатков за период ", "средний товарный запас в шт ",
    "Коэффицент оборачиваемости", "количество дней в периоде ",
    "продажи в шт за период ", "количесто дней оборота в шт ");
  return headers;
}

function mainCellValues(entry: { label: string; row: Pick<TurnoverRow, "daily" | "averageQty" | "averageCost" | "periodSales" | "turnoverQty" | "turnoverCost" | "turnoverQtyDays" | "turnoverCostDays"> }, days: string[], options: SampleOptions, salesRows: number, footerSalesRow?: number): unknown[] {
  const row = entry.row;
  const values: unknown[] = [entry.label];
  const daily = row.daily;
  const dailyValue = (index: number) => {
    const day = daily[index];
    return day ? (options.mode === "quantity" ? day.quantity : day.stockCost) : null;
  };
  const average = options.mode === "quantity" ? row.averageQty : row.averageCost;
  const sales = options.mode === "quantity" ? row.periodSales.quantity : row.periodSales.cost;
  const turnover = options.mode === "quantity" ? row.turnoverQty : row.turnoverCost;
  const turnoverDays = options.mode === "quantity" ? row.turnoverQtyDays : row.turnoverCostDays;
  const first = dailyValue(0);
  const last = dailyValue(days.length - 1);
  const halfFirst = columnLetter(3);
  const lastFullColumn = columnLetter(days.length + 3);
  const lastHalfColumn = columnLetter(days.length + 2);
  const sumColumn = columnLetter(days.length + 4);
  const averageColumn = columnLetter(days.length + 5);
  const coefficientColumn = columnLetter(days.length + 6);
  const daysColumn = columnLetter(days.length + 7);
  const salesColumn = columnLetter(days.length + 8);
  const turnoverDaysColumn = columnLetter(days.length + 9);
  values.push(first ?? null);
  values.push(numeric(first) ? { formula: `B{r}/2`, result: first / 2 } : null);
  for (let index = 1; index < days.length - 1; index++) values.push(dailyValue(index) ?? null);
  values.push(numeric(last) ? { formula: `${lastFullColumn}{r}/2`, result: last / 2 } : null);
  values.push(last ?? null);
  const weighted = daily.map((_, index) => {
    if (index === 0 || index === days.length - 1) {
      const value = dailyValue(index);
      return numeric(value) ? value / 2 : null;
    }
    return dailyValue(index);
  });
  const sum = safeSum(weighted);
  if (numeric(average) && sum !== null) {
    const terms = [halfFirst, ...Array.from({ length: days.length - 2 }, (_, index) => columnLetter(4 + index)), lastHalfColumn];
    values.push({ formula: `${terms.map((column) => `${column}{r}`).join("+")}`, result: average * (days.length - 1) });
    values.push({ formula: `${sumColumn}{r}/(${days.length}-1)`, result: average });
  } else {
    values.push("n/a", "n/a");
  }
  if (numeric(turnover)) values.push({ formula: footerSalesRow === undefined
    ? `${salesColumn}{r}/${averageColumn}{r}`
    : `IF(AND(ISNUMBER(${salesColumn}{r}),ISNUMBER(${averageColumn}{r}),${salesColumn}{r}>=0,${averageColumn}{r}>0),${salesColumn}{r}/${averageColumn}{r},"n/a")`, result: turnover });
  else values.push("n/a");
  values.push(days.length);
  if (numeric(sales)) {
    const column = options.mode === "quantity" ? "B" : "C";
    const first = options.mode === "quantity" ? 2 : 1;
    values.push({
      formula: footerSalesRow === undefined
        ? `VLOOKUP(A{r},'${options.salesSheet}'!A${first}:${column}${first + salesRows - 1},${options.mode === "quantity" ? 2 : 3},0)`
        : `'${options.salesSheet}'!${column}${footerSalesRow}`,
      result: sales
    });
  } else values.push("n/a");
  if (numeric(turnoverDays)) values.push({ formula: footerSalesRow === undefined
    ? `${daysColumn}{r}/${coefficientColumn}{r}`
    : `IF(AND(ISNUMBER(${coefficientColumn}{r}),${coefficientColumn}{r}>0),${daysColumn}{r}/${coefficientColumn}{r},"n/a")`, result: turnoverDays });
  else values.push("n/a");
  return values;
}

function replaceRowReference(value: unknown, rowNumber: number): unknown {
  if (isCellFormula(value)) {
    return { formula: value.formula.replaceAll("{r}", String(rowNumber)), result: value.result };
  }
  return value;
}

function createMainSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, entries: RowLabel[], days: string[], options: SampleOptions, totals: TurnoverTotals) {
  const sheet = workbook.addWorksheet(options.mainSheet, {
    views: [{
      state: "frozen", ySplit: 1, showGridLines: true, zoomScale: 100, zoomScaleNormal: 100,
      activeCell: options.activeCell
    }]
  }) as StreamingSheet;
  const totalColumns = days.length + 9;
  const dateEnd = days.length + 3;
  const summaryWidths = [26.7109375, 29.28515625, 29.28515625, 27.28515625, 24.5703125, 29.28515625];
  sheet.columns = Array.from({ length: totalColumns }, (_, index) => {
    if (index === 0) return { width: 65.5703125 };
    if (index + 1 <= dateEnd) return { width: 9.140625 };
    return { width: summaryWidths[index - dateEnd] };
  });
  setFullPageSetup(sheet);
  if (options.autoFilter) sheet.autoFilter = `A1:${columnLetter(totalColumns)}1`;
  sheet.addRow(mainHeaders(days)).commit();
  const averageColumn = days.length + 5;
  const coefficientColumn = days.length + 6;
  const daysColumn = days.length + 7;
  const turnoverDaysColumn = days.length + 9;
  for (let index = 0; index < entries.length; index++) {
    const rowNumber = index + 2;
    const values = mainCellValues(entries[index]!, days, options, entries.length).map((value) => replaceRowReference(value, rowNumber));
    const row = sheet.addRow(values);
    for (const column of [averageColumn, coefficientColumn, daysColumn, turnoverDaysColumn]) {
      row.getCell(column).numFmt = "0.00";
    }
    styleTurnoverCoefficient(row.getCell(coefficientColumn), options.mode === "quantity" ? entries[index].row.turnoverQty : entries[index].row.turnoverCost);
    row.commit();
  }
  const footerTotals: Array<{ label: string; total: TurnoverTotal }> = [
    ...totals.byUnit.map(total => ({ label: `ИТОГО · ${total.unit ?? total.unitKey}`, total })),
    { label: "ИТОГО", total: totals.overall }
  ];
  for (let index = 0; index < footerTotals.length; index++) {
    const { label, total } = footerTotals[index];
    const rowNumber = entries.length + 2 + index;
    const salesRow = entries.length + (options.mode === "quantity" ? 2 : 1) + index;
    const values = mainCellValues({ label, row: total }, days, options, entries.length, salesRow)
      .map(value => value === null ? "n/a" : replaceRowReference(value, rowNumber));
    const row = sheet.addRow(values);
    row.eachCell(cell => {
      cell.font = { name: "Calibri", size: 11, bold: true };
      cell.border = { top: { style: "thin", color: { argb: "FF9CA3AF" } } };
    });
    for (const column of [averageColumn, coefficientColumn, daysColumn, turnoverDaysColumn]) row.getCell(column).numFmt = "0.00";
    styleTurnoverCoefficient(row.getCell(coefficientColumn), options.mode === "quantity" ? total.turnoverQty : total.turnoverCost);
    row.commit();
  }
  formatTurnoverCoefficientRange(sheet, columnLetter(coefficientColumn), 2, entries.length + 1 + footerTotals.length);
  sheet.commit();
  return sheet;
}

function createSalesSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, entries: RowLabel[], options: SampleOptions, totals: TurnoverTotals) {
  const sheet = workbook.addWorksheet(options.salesSheet, {
    views: [{ state: "normal", showGridLines: true, zoomScale: 100, zoomScaleNormal: 100, activeCell: options.mode === "quantity" ? "A2" : "A1" }]
  }) as StreamingSheet;
  sheet.columns = options.mode === "quantity"
    ? [{ width: 64.140625 }, {}]
    : [{ width: 66.85546875 }, { width: 12.42578125 }, { width: 19.140625 }];
  if (options.mode === "money") setFullPageSetup(sheet);
  else {
    sheet.pageSetup.fitToPage = false;
    sheet.pageSetup.margins = MARGINS;
  }
  if (options.mode === "quantity") sheet.addRow([]).commit();
  const salesEntries = [...entries].sort((left, right) => left.label.localeCompare(right.label, "ru"));
  for (const { row, label } of salesEntries) {
    const quantity = row.periodSales.quantity;
    const cost = row.periodSales.cost;
    if (options.mode === "quantity") {
      sheet.addRow([label, numeric(quantity) ? quantity : "n/a"]).commit();
    } else {
      sheet.addRow([label, numeric(quantity) ? quantity : "n/a", numeric(cost) ? cost : "n/a"]).commit();
    }
  }
  for (const { label, total } of [
    ...totals.byUnit.map(total => ({ label: `ИТОГО · ${total.unit ?? total.unitKey}`, total })),
    { label: "ИТОГО", total: totals.overall }
  ]) {
    const values: Array<string | number> = [label, total.periodSales.quantity ?? "n/a"];
    if (options.mode === "money") values.push(total.periodSales.cost ?? "n/a");
    const row = sheet.addRow(values);
    row.font = { name: "Calibri", size: 11, bold: true };
    row.eachCell(cell => { cell.border = { top: { style: "thin", color: { argb: "FF9CA3AF" } } }; });
    row.commit();
  }
  sheet.commit();
  return sheet;
}

export async function writeTurnoverSampleWorkbook(report: TurnoverReport, output: Writable): Promise<void> {
  if (output.destroyed) throw new Error("Excel download was closed");
  if (report.params.groupBy !== "sku") throw new Error("Сводный отчёт формируется по товарам (SKU)");
  const days = dateRange(report.params.from, report.params.to);
  if (days.length < 2) throw new Error("Сводный отчёт требует период не менее 2 календарных дней");
  for (const row of report.rows) {
    if (row.daily.length !== days.length || row.daily.some((day, index) => day.date !== days[index])) {
      throw new Error("Для сводного отчёта нужны дневные остатки за весь период");
    }
  }
  const entries = labelRows(report);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: true });
  try {
    await writeTurnoverSummarySheet(workbook, report);
    const mode = report.params.mode ?? "both";
    if (mode === "quantity" || mode === "both") {
      createMainSheet(workbook, entries, days, {
        mode: "quantity", mainSheet: MAIN_UNITS, salesSheet: SALES_UNITS, activeCell: "AI2", autoFilter: false
      }, report.totals);
      createSalesSheet(workbook, entries, {
        mode: "quantity", mainSheet: MAIN_UNITS, salesSheet: SALES_UNITS, activeCell: "AI2", autoFilter: false
      }, report.totals);
    }
    if (mode === "money" || mode === "both") {
      createMainSheet(workbook, entries, days, {
        mode: "money", mainSheet: mode === "both" ? MAIN_BOTH_MONEY : MAIN_MONEY,
        salesSheet: mode === "both" ? SALES_BOTH_MONEY : SALES_MONEY, activeCell: "AK13", autoFilter: true
      }, report.totals);
      createSalesSheet(workbook, entries, {
        mode: "money", mainSheet: mode === "both" ? MAIN_BOTH_MONEY : MAIN_MONEY,
        salesSheet: mode === "both" ? SALES_BOTH_MONEY : SALES_MONEY, activeCell: "AK13", autoFilter: true
      }, report.totals);
    }
    await workbook.commit();
  } catch (error) {
    output.destroy();
    throw error;
  }
}
