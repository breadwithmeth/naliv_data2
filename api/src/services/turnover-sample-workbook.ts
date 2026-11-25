import ExcelJS from "exceljs";
import { once } from "node:events";
import type { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import type { TurnoverMode, TurnoverReport, TurnoverRow, TurnoverTotal, TurnoverUnitTotal } from "./turnover-types.js";
import type { TurnoverStandardColumn } from "./turnover-presentation.js";
import { formatTurnoverCoefficientRange, styleTurnoverCoefficient } from "./turnover-coefficient-workbook.js";
import {
  TURNOVER_IDLE_LABEL, turnoverStandardColumns, turnoverStandardDates, turnoverStandardTotalRows,
  turnoverStandardValue, turnoverUnitDisplayName, turnoverUnitLabels
} from "./turnover-presentation.js";
import { completeTurnoverReport, TURNOVER_COEFFICIENT_THRESHOLDS } from "./turnover-domain.js";

const MAIN_UNITS = "рассчет оборачиваемости";
const MAIN_MONEY = "рассчет оборачиваемости ";
const SALES_SHEET = "Продажи за период ";
const QUANTITY_FORMAT = "#,##0.###";
const MONEY_FORMAT = "#,##0.00";
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

type LayoutEntry = { kind: "section"; label: string; column: number } | { kind: "product"; row: TurnoverRow }
  | { kind: "total"; label: string; store: string | null; row: TurnoverTotal; byUnit: readonly TurnoverUnitTotal[] };
type Basis = Exclude<TurnoverMode, "both">;
type FormulaColumns = { fullFirst: string; halfFirst: string; halfLast: string; fullLast: string;
  weighted: string; average: string; coefficient: string; periodDays: string; sales: string };
type RowInput = { row: TurnoverRow | TurnoverTotal; quantity: boolean; money: boolean; context: ExcelJS.CellValue[] };
type CalculationLayout = {
  columns: readonly TurnoverStandardColumn[]; refs: FormulaColumns; basis: Basis; periodDays: number;
  salesReference: string; unavailable: "n/a" | null;
  stockCostSource: boolean;
};
type StreamingSheet = ExcelJS.Worksheet & { commit(): void };
type StreamingWorkbook = ExcelJS.stream.xlsx.WorkbookWriter & { zip: EventEmitter & { abort(): void }; stream: Writable };

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

function storeLabel(row: TurnoverRow) {
  return row.storeKey === null ? "Магазин не определён" : row.storeName || "Магазин без названия";
}

function groupLabel(row: TurnoverRow) {
  return row.rootGroupKey === null ? "Без группы" : row.rootGroupName || "Группа без названия";
}

function* reportLayout(report: TurnoverReport, splitStores: boolean): Generator<LayoutEntry> {
  const storeTotals = new Map(report.totals.byStore.map(total => [total.storeKey, total]));
  let previousStore: string | null | undefined;
  let previousGroup: string | null | undefined;
  for (let index = 0; index < report.rows.length; index++) {
    const row = report.rows[index]!;
    const storeChanged = splitStores && row.storeKey !== previousStore;
    if (storeChanged) yield { kind: "section", label: storeLabel(row), column: 1 };
    if (storeChanged || row.rootGroupKey !== previousGroup) {
      yield { kind: "section", label: groupLabel(row), column: splitStores ? 2 : 1 };
    }
    previousStore = row.storeKey;
    previousGroup = row.rootGroupKey;
    yield { kind: "product", row };
    if (splitStores && row.storeKey !== report.rows[index + 1]?.storeKey) {
      const total = storeTotals.get(row.storeKey);
      if (total) yield { kind: "total", label: "ИТОГО по магазину", store: storeLabel(row), row: total.total, byUnit: total.byUnit };
    }
  }
  yield { kind: "total", label: "ИТОГО", store: null, row: report.totals.overall, byUnit: report.totals.byUnit };
}

function numeric(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function mainCellValues(
  entry: RowInput, layout: CalculationLayout, rowNumber: number, salesRow: number, alignedDaily: boolean
): ExcelJS.CellValue[] {
  const { row, context: values } = entry;
  const { columns, refs, basis, periodDays, unavailable, salesReference } = layout;
  const showProvenance = layout.stockCostSource && entry.money;
  let entryDates: string[] | undefined;
  let hasSourcedAverage = false;
  let hasSourcedWeightedStock = false;
  const missing = unavailable ? '"n/a"' : '""';
  for (const column of columns) {
    if (column.kind === "periodDays") {
      values.push(periodDays);
      continue;
    }
    if (!entry[basis]) {
      values.push(null);
      continue;
    }
    if (column.kind === "turnoverDays" && "idleStock" in row && row.idleStock) {
      values.push(TURNOVER_IDLE_LABEL);
      continue;
    }
    const value = column.kind === "weighted" && !alignedDaily ? null : turnoverStandardValue(row, column, basis, periodDays);
    let formula: string | undefined;
    if (column.kind === "day") {
      if (showProvenance && !column.half && numeric(value) && row.daily[column.index]?.stockCostFromEntry) {
        (entryDates ??= []).push(column.date);
      }
      if (column.half && alignedDaily) {
        const full = `${column.index === 0 ? refs.fullFirst : refs.fullLast}${rowNumber}`;
        values.push({ formula: `IF(ISNUMBER(${full}),${full}/2,"")`, result: value ?? "" });
      } else {
        values.push(value);
      }
      continue;
    }
    if (!alignedDaily && value === null) {
      values.push(unavailable);
      continue;
    }
    switch (column.kind) {
      case "weighted": {
        if (!alignedDaily) break;
        // Start and end at the half-days, excluding the duplicate full endpoints.
        // COUNT rejects blank, text and error cells without treating them as numeric zero.
        const range = `${refs.halfFirst}${rowNumber}:${refs.halfLast}${rowNumber}`;
        formula = `IFERROR(IF(COUNT(${range})=${periodDays},SUMIF(${range},">0"),${missing}),${missing})`;
        break;
      }
      case "average": {
        if (!alignedDaily) break;
        const start = `${refs.halfFirst}${rowNumber}`, end = `${refs.halfLast}${rowNumber}`;
        const sum = `${refs.weighted}${rowNumber}`;
        const weight = `COUNTIF(${start}:${end},">0")-IF(${start}>0,0.5,0)-IF(${end}>0,0.5,0)`;
        formula = `IFERROR(IF(ISNUMBER(${sum}),IF(${sum}=0,0,${sum}/(${weight})),${missing}),${missing})`;
        break;
      }
      case "coefficient": {
        const sales = `${refs.sales}${rowNumber}`, average = `${refs.average}${rowNumber}`;
        formula = `IFERROR(IF(AND(ISNUMBER(${sales}),ISNUMBER(${average}),${sales}>=0,${average}>0),${sales}/${average},${missing}),${missing})`;
        break;
      }
      case "sales": {
        const source = `${salesReference}${salesRow}`;
        formula = `IF(ISNUMBER(${source}),${source},${missing})`;
        break;
      }
      case "turnoverDays": {
        const coefficient = `${refs.coefficient}${rowNumber}`;
        formula = `IFERROR(IF(AND(ISNUMBER(${coefficient}),${coefficient}>0),${refs.periodDays}${rowNumber}/${coefficient},${missing}),${missing})`;
        break;
      }
    }
    if (showProvenance && row.stockCostFromEntry && numeric(value)) {
      if (column.kind === "average") hasSourcedAverage = true;
      if (column.kind === "weighted") hasSourcedWeightedStock = true;
    }
    values.push(formula ? { formula, result: value ?? unavailable ?? "" } : value ?? unavailable);
  }
  if (entryDates || hasSourcedAverage || hasSourcedWeightedStock) {
    const metrics = [];
    if (hasSourcedWeightedStock) metrics.push("сумма остатков");
    if (hasSourcedAverage) metrics.push("средний запас");
    if (entryDates) metrics.push(`дневные остатки: ${entryDates.length === periodDays ? "все даты" : entryDates.join(", ")}`);
    values.push(`В т. ч. по оприходованию · ${metrics.join("; ")}`);
  }
  return values;
}

function sectionRow(sheet: StreamingSheet, label: string, column: number) {
  const row = sheet.addRow([]);
  row.font = { name: "Calibri", size: 11, bold: true };
  row.getCell(column).value = label;
  row.getCell(column).alignment = { wrapText: true, vertical: "middle" };
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

function addHeader(sheet: StreamingSheet, labels: string[]) {
  const row = sheet.addRow(labels);
  row.height = 30;
  row.eachCell(cell => {
    cell.font = { bold: true };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
  });
  return row;
}

function calculationHeader(column: TurnoverStandardColumn, basis: Basis): string {
  if (column.kind === "day") return column.half ? `${column.label} / 2` : column.label;
  if (basis === "money") {
    if (column.kind === "weighted" || column.kind === "average") return `${column.label}, ₸`;
    if (column.kind === "sales") return "Себестоимость продаж, ₸";
  }
  return column.label;
}

async function createSheets(workbook: StreamingWorkbook, report: TurnoverReport, days: string[], basis: Basis, signal: AbortSignal) {
  const splitStores = report.params.profile !== "sample";
  const itemColumn = splitStores ? 3 : 2;
  const identity = [...(splitStores ? ["Магазин"] : []), "Группа", "Номенклатура", "Ед. учёта"];
  const identityColumns = [...(splitStores ? [{ width: 26 }] : []), { width: 28 }, { width: 44 }, { width: 13 }];
  const columns = turnoverStandardColumns(days);
  const firstDay = identity.length + 1;
  const firstSummary = firstDay + days.length + 2;
  const metric = (kind: TurnoverStandardColumn["kind"]) => firstDay + columns.findIndex(column => column.kind === kind);
  const refs: FormulaColumns = {
    fullFirst: columnLetter(firstDay), halfFirst: columnLetter(firstDay + 1),
    halfLast: columnLetter(firstSummary - 2), fullLast: columnLetter(firstSummary - 1),
    weighted: columnLetter(metric("weighted")), average: columnLetter(metric("average")),
    coefficient: columnLetter(metric("coefficient")), periodDays: columnLetter(metric("periodDays")), sales: columnLetter(metric("sales"))
  };
  const money = basis === "money";
  const hasVisibleStockSource = (row: TurnoverTotal) =>
    (row.stockCostFromEntry && numeric(row.averageCost)) ||
    row.daily.some(day => day.stockCostFromEntry && numeric(day.stockCost));
  const stockCostSource = money && (
    hasVisibleStockSource(report.totals.overall) ||
    (splitStores && report.totals.byStore.some(({ total }) => hasVisibleStockSource(total))) ||
    report.rows.some(hasVisibleStockSource)
  );
  const unavailable = report.params.includeIncomplete ? "n/a" : null;
  const salesReference = `'${SALES_SHEET}'!${columnLetter(identity.length + (money ? 2 : 1))}`;
  const calculation: CalculationLayout = { columns, refs, basis, periodDays: days.length, salesReference, unavailable, stockCostSource };
  const views: ExcelJS.AddWorksheetOptions["views"] = [{ state: "frozen", xSplit: itemColumn, ySplit: 1 }];
  const main = workbook.addWorksheet(money ? MAIN_MONEY : MAIN_UNITS, {
    views, properties: { outlineLevelCol: 1, outlineProperties: { summaryBelow: true, summaryRight: true } }
  }) as StreamingSheet;
  const sales = workbook.addWorksheet(SALES_SHEET, { views }) as StreamingSheet;
  const measureFormat = money ? MONEY_FORMAT : QUANTITY_FORMAT;
  main.columns = [...identityColumns, ...columns.map((column, index) => {
    if (column.kind === "day") return { width: 11, hidden: true, outlineLevel: 1, style: { numFmt: measureFormat } };
    const numFmt = column.kind === "periodDays" ? "0" : column.kind === "coefficient" || column.kind === "turnoverDays"
      ? "0.00" : measureFormat;
    // ExcelJS coalesces adjacent equal-width/style columns without comparing `collapsed`.
    return { width: firstDay + index === firstSummary ? 24 : 19, style: { numFmt } };
  })];
  if (stockCostSource) main.getColumn(identity.length + columns.length + 1).width = 38;
  // Excel needs a single collapse flag on the visible summary column to the right of the hidden detail.
  // Override only these instances; ExcelJS derives the flag from outlineLevel on the detail columns.
  const detail = { get: () => false };
  for (let index = firstDay; index < firstSummary; index++) {
    Object.defineProperty(main.getColumn(index), "collapsed", detail);
  }
  Object.defineProperty(main.getColumn(firstSummary), "collapsed", { get: () => true });
  sales.columns = [...identityColumns, { width: 16, style: { numFmt: QUANTITY_FORMAT } }, { width: 25, style: { numFmt: MONEY_FORMAT } }];
  setFullPageSetup(main);
  if (money) setFullPageSetup(sales);
  else sales.pageSetup.margins = MARGINS;
  const { poorStart, mediumStart, goodStart } = TURNOVER_COEFFICIENT_THRESHOLDS;
  const mainLabels = [...identity, ...columns.map(column => calculationHeader(column, basis))];
  if (stockCostSource) mainLabels.push("Оценка запасов");
  const mainHeader = addHeader(main, mainLabels);
  mainHeader.getCell(refs.coefficient).note = `Коэффициент: Плохо [${poorStart}; ${mediumStart}) · Средне [${mediumStart}; ${goodStart}) · Хорошо ≥ ${goodStart}`;
  mainHeader.commit();
  addHeader(sales, [...identity, "Кол-во", "Продажи за период по себестоимости, ₸"]).commit();
  const unitLabels = turnoverUnitLabels(report.totals.byUnit);
  let firstCoefficientRow: number | undefined;
  let lastCoefficientRow = 0;
  let beforeOverall = 1;
  const addProduct = (entry: RowInput, footer = false) => {
    const alignedDaily = entry.row.daily.length === days.length && entry.row.daily.every((day, index) => day.date === days[index]);
    if (!footer && !alignedDaily) throw new Error("Для сводного отчёта нужны дневные остатки за весь период");
    const { quantity, cost } = entry.row.periodSales;
    const salesRow = sales.addRow([
      ...entry.context,
      entry.quantity ? (numeric(quantity) ? quantity : unavailable) : null,
      entry.money ? (numeric(cost) ? cost : unavailable) : null
    ]);
    const mainRow = main.addRow([]);
    mainRow.values = mainCellValues(entry, calculation, mainRow.number, salesRow.number, alignedDaily);
    if (footer) for (const row of [mainRow, salesRow]) {
      row.font = { name: "Calibri", size: 11, bold: true };
      row.eachCell(cell => { cell.border = { top: { style: "thin", color: { argb: "FF9CA3AF" } } }; });
      if (entry.row.unit === null) row.getCell(itemColumn).note = "Количество в итогах не складывается: разные или неизвестные единицы.";
    }
    if (entry[basis]) styleTurnoverCoefficient(mainRow.getCell(refs.coefficient), money ? entry.row.turnoverCost : entry.row.turnoverQty);
    firstCoefficientRow ??= mainRow.number;
    lastCoefficientRow = mainRow.number;
    mainRow.commit();
    salesRow.commit();
  };
  let written = 0;
  for (const entry of reportLayout(report, splitStores)) {
    signal.throwIfAborted();
    if (entry.kind === "section") {
      sectionRow(main, entry.label, entry.column);
      sectionRow(sales, entry.label, entry.column);
    } else if (entry.kind === "total") {
      if (entry.store === null) beforeOverall = lastCoefficientRow || 1;
      // The standard quantity sheet still needs the monetary scope row on its sales sheet.
      for (const total of turnoverStandardTotalRows(entry.label, entry.row, entry.byUnit, money ? "money" : "both", unitLabels)) {
        const unit = total.row.unit === null ? null : turnoverUnitDisplayName(total.row.unit, total.key);
        const context = [...(splitStores ? [entry.store] : []), null, total.label, unit];
        // Explicit money files have always included the quantity sales column as a reference.
        const quantity = money ? total.row.unit !== null : total.quantity;
        addProduct({ row: total.row, quantity, money: total.money, context }, true);
      }
    } else {
      const row = entry.row;
      const context = [...(splitStores ? [storeLabel(row)] : []), groupLabel(row), row.name, turnoverUnitDisplayName(row.unit)];
      addProduct({ row, quantity: true, money: true, context });
    }
    if (++written % 1024 === 0) {
      await setImmediate();
      signal.throwIfAborted();
      if (workbook.stream.writableNeedDrain) await once(workbook.stream, "drain", { signal });
    }
  }
  if (money) main.autoFilter = `A1:${columnLetter(identity.length + columns.length + Number(stockCostSource))}${beforeOverall}`;
  if (firstCoefficientRow !== undefined) {
    formatTurnoverCoefficientRange(main, refs.coefficient, firstCoefficientRow, lastCoefficientRow);
  }
  await finishSheet(workbook, main, signal);
  await finishSheet(workbook, sales, signal);
}

export async function writeTurnoverSampleWorkbook(report: TurnoverReport, output: Writable): Promise<void> {
  report = completeTurnoverReport(report);
  if (output.destroyed) throw new Error("Excel download was closed");
  if (report.params.groupBy !== "sku") throw new Error("Сводный отчёт формируется по товарам (SKU)");
  const days = turnoverStandardDates(report.params.from, report.params.to);
  if (days.length < 2) throw new Error("Сводный отчёт требует период не менее 2 календарных дней");
  const basis = report.params.mode === "money" ? "money" : "quantity";
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: true }) as StreamingWorkbook;
  const canceled = new AbortController();
  const onError = (error: Error) => canceled.abort(error);
  const onClose = () => { if (!output.writableFinished) canceled.abort(new Error("Excel download was closed")); };
  output.once("error", onError);
  output.once("close", onClose);
  workbook.zip.once("error", onError);
  const interrupted = once(canceled.signal, "abort");
  try {
    await createSheets(workbook, report, days, basis, canceled.signal);
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
