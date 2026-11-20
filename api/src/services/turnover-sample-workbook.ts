import ExcelJS from "exceljs";
import { once } from "node:events";
import type { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import type { TurnoverMode, TurnoverReport, TurnoverRow, TurnoverTotal, TurnoverUnitTotal } from "./turnover-types.js";
import { formatTurnoverCoefficientRange, styleTurnoverCoefficient } from "./turnover-coefficient-workbook.js";
import { turnoverStandardColumns, turnoverStandardDates, turnoverStandardTotalRows, turnoverUnitLabels } from "./turnover-presentation.js";
import { chronologicalStock, completeTurnoverReport } from "./turnover-domain.js";

const MAIN_UNITS = "рассчет оборачиваемости";
const MAIN_MONEY = "рассчет оборачиваемости ";
const SALES_UNITS = "Продажи за период ";
const SALES_MONEY = "Продажи за период ";
const MAIN_BOTH_MONEY = "рассчет оборачиваемости деньги";
const SALES_BOTH_MONEY = "Продажи за период в деньгах";
const MARGINS = { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };
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

type LayoutEntry = { kind: "section"; label: string } | { kind: "product"; row: TurnoverRow }
  | { kind: "total"; label: string; row: TurnoverTotal; byUnit: readonly TurnoverUnitTotal[] };
type SampleMode = Exclude<TurnoverMode, "both">;
type SampleOptions = { mode: SampleMode; salesSheet: string; mainSheet: string; activeCell: string; autoFilter: boolean; includeIncomplete?: boolean };
type CellFormula = { formula: string; result?: unknown };
type StreamingSheet = ExcelJS.Worksheet & { commit(): void };
type StreamingWorkbook = ExcelJS.stream.xlsx.WorkbookWriter & { zip: EventEmitter & { abort(): void }; stream: Writable };

function isCellFormula(value: unknown): value is CellFormula {
  return typeof value === "object" && value !== null && "formula" in value
    && typeof value.formula === "string";
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

function* reportLayout(report: TurnoverReport, cache?: LayoutEntry[]): Generator<LayoutEntry> {
  const sections = report.params.groupBy === "sku" && report.params.sort === "name";
  const splitStores = report.params.profile !== "sample";
  const storeTotals = new Map(report.totals.byStore.map(total => [total.storeKey, total]));
  let previousStore: string | null | undefined;
  let previousGroup: string | null | undefined;
  for (let index = 0; index < report.rows.length; index++) {
    const row = report.rows[index]!;
    if (sections) {
      const storeChanged = splitStores && row.storeKey !== previousStore;
      if (storeChanged) {
        const entry: LayoutEntry = { kind: "section", label: row.storeKey === null ? "Магазин не определён" : row.storeName || "Магазин без названия" };
        cache?.push(entry);
        yield entry;
      }
      if (storeChanged || row.rootGroupKey !== previousGroup) {
        const entry: LayoutEntry = { kind: "section", label: row.rootGroupKey === null ? "Без группы" : row.rootGroupName || "Группа без названия" };
        cache?.push(entry);
        yield entry;
      }
      previousStore = row.storeKey;
      previousGroup = row.rootGroupKey;
    }
    const entry: LayoutEntry = { kind: "product", row };
    cache?.push(entry);
    yield entry;
    if (splitStores && row.storeKey !== report.rows[index + 1]?.storeKey) {
      const total = storeTotals.get(row.storeKey);
      if (total) {
        const subtotal: LayoutEntry = { kind: "total", label: "ИТОГО по магазину", row: total.total, byUnit: total.byUnit };
        cache?.push(subtotal);
        yield subtotal;
      }
    }
  }
  const overall: LayoutEntry = { kind: "total", label: "ИТОГО", row: report.totals.overall, byUnit: report.totals.byUnit };
  cache?.push(overall);
  yield overall;
}

function numeric(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function mainCellValues(entry: { label: string; row: Pick<TurnoverRow, "daily" | "averageQty" | "averageCost" | "periodSales" | "turnoverQty" | "turnoverCost" | "turnoverQtyDays" | "turnoverCostDays"> }, days: string[], options: SampleOptions, salesRow: number, footer = false): unknown[] {
  const row = entry.row;
  const unavailable = options.includeIncomplete ? "n/a" : null;
  const unavailableFormula = options.includeIncomplete ? '"n/a"' : '""';
  const values: unknown[] = [entry.label];
  const daily = row.daily;
  const dailyValue = (index: number) => {
    const day = daily[index];
    return day?.date === days[index] ? (options.mode === "quantity" ? day.quantity : day.stockCost) : null;
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
  values.push(numeric(first) ? first : null);
  values.push(numeric(first) ? { formula: `B{r}/2`, result: first / 2 } : null);
  for (let index = 1; index < days.length - 1; index++) {
    const value = dailyValue(index);
    values.push(numeric(value) ? value : null);
  }
  values.push(numeric(last) ? { formula: `${lastFullColumn}{r}/2`, result: last / 2 } : null);
  values.push(numeric(last) ? last : null);
  const stock = (!footer || (daily.length === days.length && daily.every((day, index) => day.date === days[index])))
    ? chronologicalStock(daily, options.mode === "quantity" ? day => day.quantity : day => day.stockCost).weighted
    : null;
  if (numeric(average) && numeric(stock)) {
    const firstWeighted = `${halfFirst}{r}`, lastWeighted = `${lastHalfColumn}{r}`;
    const range = `${firstWeighted}:${lastWeighted}`;
    const count = `COUNTIF(${range},">0")-IF(${firstWeighted}>0,0.5,0)-IF(${lastWeighted}>0,0.5,0)`;
    values.push({ formula: `SUMIF(${range},">0")`, result: stock });
    values.push({ formula: `IF(${sumColumn}{r}=0,0,${sumColumn}{r}/(${count}))`, result: average });
  } else {
    values.push(unavailable, unavailable);
  }
  if (numeric(turnover)) values.push({ formula: !footer
    ? `${salesColumn}{r}/${averageColumn}{r}`
    : `IF(AND(ISNUMBER(${salesColumn}{r}),ISNUMBER(${averageColumn}{r}),${salesColumn}{r}>=0,${averageColumn}{r}>0),${salesColumn}{r}/${averageColumn}{r},${unavailableFormula})`, result: turnover });
  else values.push(unavailable);
  values.push(days.length);
  if (numeric(sales)) {
    const column = options.mode === "quantity" ? "B" : "C";
    values.push({
      formula: !footer
        ? `VLOOKUP(A{r},'${options.salesSheet}'!A${salesRow}:${column}${salesRow},${options.mode === "quantity" ? 2 : 3},0)`
        : `'${options.salesSheet}'!${column}${salesRow}`,
      result: sales
    });
  } else values.push(unavailable);
  if (numeric(turnoverDays)) values.push({ formula: !footer
    ? `${daysColumn}{r}/${coefficientColumn}{r}`
    : `IF(AND(ISNUMBER(${coefficientColumn}{r}),${coefficientColumn}{r}>0),${daysColumn}{r}/${coefficientColumn}{r},${unavailableFormula})`, result: turnoverDays });
  else values.push(unavailable);
  return values;
}

function replaceRowReference(value: unknown, rowNumber: number): unknown {
  if (isCellFormula(value)) {
    return { formula: value.formula.replaceAll("{r}", String(rowNumber)), result: value.result };
  }
  return value;
}

function sectionRow(sheet: StreamingSheet, label: string) {
  const row = sheet.addRow([label]);
  row.font = { name: "Calibri", size: 11, bold: true };
  row.getCell(1).alignment = { wrapText: true, vertical: "middle" };
  row.commit();
}

async function finishSheet(workbook: StreamingWorkbook, sheet: StreamingSheet, signal: AbortSignal) {
  signal.throwIfAborted();
  const entryName = `xl/worksheets/sheet${sheet.id}.xml`;
  let onEntry!: (entry: { name: string }) => void;
  let onAbort!: () => void;
  const processed = new Promise<void>((resolve, reject) => {
    onEntry = entry => { if (entry.name.replace(/^\/+/, "") === entryName) resolve(); };
    onAbort = () => reject(signal.reason);
    workbook.zip.on("entry", onEntry);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    sheet.commit();
    await processed;
  } finally {
    workbook.zip.off("entry", onEntry);
    signal.removeEventListener("abort", onAbort);
  }
}

async function createSheets(workbook: StreamingWorkbook, entries: Iterable<LayoutEntry>, days: string[], options: SampleOptions,
  unitLabels: ReadonlyMap<string, string>, signal: AbortSignal) {
  const main = workbook.addWorksheet(options.mainSheet, {
    views: [{
      state: "normal", showGridLines: true, zoomScale: 100, zoomScaleNormal: 100,
      activeCell: options.activeCell
    }]
  }) as StreamingSheet;
  const totalColumns = days.length + 9;
  const dateEnd = days.length + 3;
  const summaryWidths = [26.7109375, 29.28515625, 29.28515625, 27.28515625, 24.5703125, 29.28515625];
  main.columns = Array.from({ length: totalColumns }, (_, index) => {
    if (index === 0) return { width: 65.5703125 };
    if (index + 1 <= dateEnd) return { width: 9.140625 };
    return { width: summaryWidths[index - dateEnd] };
  });
  setFullPageSetup(main);
  if (options.autoFilter) main.autoFilter = `A1:${columnLetter(totalColumns)}1`;
  const header = main.addRow(["Номенклатура ", ...turnoverStandardColumns(days).map(column => column.label)]);
  if (options.mode === "money") header.getCell(1).note = "Денежные показатели — по себестоимости, ₸.";
  header.commit();

  const sales = workbook.addWorksheet(options.salesSheet, {
    views: [{ state: "normal", showGridLines: true, zoomScale: 100, zoomScaleNormal: 100, activeCell: options.mode === "quantity" ? "A2" : "A1" }]
  }) as StreamingSheet;
  sales.columns = options.mode === "quantity"
    ? [{ width: 64.140625 }, {}]
    : [{ width: 66.85546875 }, { width: 12.42578125 }, { width: 19.140625 }];
  if (options.mode === "money") setFullPageSetup(sales);
  else {
    sales.pageSetup.fitToPage = false;
    sales.pageSetup.margins = MARGINS;
    sales.addRow([]).commit();
  }

  const averageColumn = days.length + 5;
  const coefficientColumn = days.length + 6;
  const daysColumn = days.length + 7;
  const turnoverDaysColumn = days.length + 9;
  const unavailable = options.includeIncomplete ? "n/a" : null;
  let firstCoefficientRow: number | undefined;
  let lastCoefficientRow = 0;
  const addProduct = (entry: { label: string; row: TurnoverRow | TurnoverTotal }, footer = false) => {
    const quantity = entry.row.periodSales.quantity;
    const cost = entry.row.periodSales.cost;
    const salesValues: Array<string | number | null> = [entry.label, numeric(quantity) ? quantity : unavailable];
    if (options.mode === "money") salesValues.push(numeric(cost) ? cost : unavailable);
    const salesRow = sales.addRow(salesValues);
    const mainRow = main.addRow([]);
    mainRow.values = mainCellValues(entry, days, options, salesRow.number, footer)
      .map(value => value === null && footer && options.includeIncomplete ? "n/a" : replaceRowReference(value, mainRow.number)) as ExcelJS.CellValue[];
    if (footer) for (const row of [mainRow, salesRow]) {
      row.font = { name: "Calibri", size: 11, bold: true };
      row.eachCell(cell => { cell.border = { top: { style: "thin", color: { argb: "FF9CA3AF" } } }; });
    }
    if (footer && entry.row.unit === null) {
      const note = "Количество в итогах не складывается: разные или неизвестные единицы.";
      if (options.mode === "quantity") mainRow.getCell(1).note = note;
      salesRow.getCell(1).note = note;
    }
    for (const column of [averageColumn, coefficientColumn, daysColumn, turnoverDaysColumn]) mainRow.getCell(column).numFmt = "0.00";
    styleTurnoverCoefficient(mainRow.getCell(coefficientColumn), options.mode === "quantity" ? entry.row.turnoverQty : entry.row.turnoverCost);
    firstCoefficientRow ??= mainRow.number;
    lastCoefficientRow = mainRow.number;
    mainRow.commit();
    salesRow.commit();
  };
  let written = 0;
  for (const entry of entries) {
    signal.throwIfAborted();
    if (entry.kind === "section") {
      sectionRow(main, entry.label);
      sectionRow(sales, entry.label);
    } else if (entry.kind === "total") {
      for (const total of turnoverStandardTotalRows(entry.label, entry.row, entry.byUnit, options.mode, unitLabels)) addProduct(total, true);
    } else {
      if (entry.row.daily.length !== days.length || entry.row.daily.some((day, index) => day.date !== days[index])) {
        throw new Error("Для сводного отчёта нужны дневные остатки за весь период");
      }
      addProduct({ label: entry.row.name, row: entry.row });
    }
    if (++written % 1024 === 0) {
      await setImmediate();
      signal.throwIfAborted();
      if (workbook.stream.writableNeedDrain) await once(workbook.stream, "drain", { signal });
    }
  }
  if (firstCoefficientRow !== undefined) formatTurnoverCoefficientRange(main, columnLetter(coefficientColumn), firstCoefficientRow, lastCoefficientRow);
  await finishSheet(workbook, main, signal);
  await finishSheet(workbook, sales, signal);
}

export async function writeTurnoverSampleWorkbook(report: TurnoverReport, output: Writable): Promise<void> {
  report = completeTurnoverReport(report);
  if (output.destroyed) throw new Error("Excel download was closed");
  if (report.params.groupBy !== "sku") throw new Error("Сводный отчёт формируется по товарам (SKU)");
  const days = turnoverStandardDates(report.params.from, report.params.to);
  if (days.length < 2) throw new Error("Сводный отчёт требует период не менее 2 календарных дней");
  const mode = report.params.mode ?? "both";
  const cachedLayout: LayoutEntry[] | undefined = mode === "both" ? [] : undefined;
  const unitLabels = turnoverUnitLabels(report.totals.byUnit);
  const entries = reportLayout(report, cachedLayout);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: true }) as StreamingWorkbook;
  const canceled = new AbortController();
  const onError = (error: Error) => canceled.abort(error);
  const onClose = () => { if (!output.writableFinished) canceled.abort(new Error("Excel download was closed")); };
  output.once("error", onError);
  output.once("close", onClose);
  workbook.zip.once("error", onError);
  const interrupted = once(canceled.signal, "abort");
  try {
    if (mode === "quantity" || mode === "both") {
      await createSheets(workbook, entries, days, {
        mode: "quantity", mainSheet: MAIN_UNITS, salesSheet: SALES_UNITS, activeCell: "AI2", autoFilter: false, includeIncomplete: report.params.includeIncomplete
      }, unitLabels, canceled.signal);
    }
    if (mode === "money" || mode === "both") {
      await createSheets(workbook, cachedLayout ?? entries, days, {
        mode: "money", mainSheet: mode === "both" ? MAIN_BOTH_MONEY : MAIN_MONEY,
        salesSheet: mode === "both" ? SALES_BOTH_MONEY : SALES_MONEY, activeCell: "AK13", autoFilter: true, includeIncomplete: report.params.includeIncomplete
      }, unitLabels, canceled.signal);
    }
    canceled.signal.throwIfAborted();
    await Promise.race([
      workbook.commit(),
      interrupted.then(() => { throw canceled.signal.reason; })
    ]);
  } catch (error) {
    workbook.zip.abort();
    output.destroy();
    throw error;
  } finally {
    output.removeListener("error", onError);
    output.removeListener("close", onClose);
    workbook.zip.removeListener("error", onError);
    canceled.abort();
  }
}
