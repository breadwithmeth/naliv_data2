import ExcelJS from "exceljs";
import { once } from "node:events";
import type { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import type { TurnoverMode, TurnoverReport, TurnoverRow, TurnoverTotal, TurnoverUnitTotal } from "./turnover-types.js";
import type { TurnoverStandardGroup } from "./turnover-presentation.js";
import { formatTurnoverCoefficientRange, styleTurnoverCoefficient } from "./turnover-coefficient-workbook.js";
import { TURNOVER_IDLE_LABEL, turnoverStandardDates, turnoverStandardGrid, turnoverStandardTotalRows, turnoverStandardValue, turnoverUnitLabels } from "./turnover-presentation.js";
import { completeTurnoverReport, TURNOVER_COEFFICIENT_THRESHOLDS } from "./turnover-domain.js";

const MAIN_UNITS = "рассчет оборачиваемости";
const MAIN_MONEY = "рассчет оборачиваемости ";
const MAIN_BOTH = "Оборачиваемость";
const SALES_SINGLE = "Продажи за период ";
const SALES_BOTH = "Продажи за период";
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
type Leaf = TurnoverStandardGroup["leaves"][number];
type FormulaColumns = { fullFirst: string; halfFirst: string; halfLast: string; fullLast: string;
  weighted: string; average: string; coefficient: string; salesSource: string; sales: string };
type RowInput = { row: TurnoverRow | TurnoverTotal; quantity: boolean; money: boolean; context: ExcelJS.CellValue[] };
type CalculationLayout = {
  leaves: Leaf[]; positions: ReadonlyMap<Basis, FormulaColumns>; periodDays: number; periodColumn: string;
  salesSheet: string; unavailable: "n/a" | null; mode: TurnoverMode;
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
  const { row, context } = entry;
  const { leaves, positions, periodDays, periodColumn, unavailable, salesSheet, mode } = layout;
  const missing = unavailable ? '"n/a"' : '""';
  const values = context.slice();
  for (const { basis, column } of leaves) {
    if (basis === "shared") {
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
    const refs = positions.get(basis)!;
    const value = column.kind === "weighted" && !alignedDaily ? null : turnoverStandardValue(row, column, basis, periodDays);
    let formula: string | undefined;
    let arrayRef: string | undefined;
    if (column.kind === "day") {
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
      case "weighted":
      case "average": {
        // Single-cell array formulas prevent implicit intersection of IFERROR's range operands.
        // A masked-out error in the other basis must not contaminate this basis (0 * #N/A is an error).
        const start = `${refs.halfFirst}${rowNumber}`, end = `${refs.halfLast}${rowNumber}`;
        const range = `${start}:${end}`, sum = `${refs.weighted}${rowNumber}`;
        const select = mode === "both" ? `--(MOD(COLUMN(${range})-COLUMN(${start}),2)=0),` : "";
        const positive = `--ISNUMBER(${range}),--IFERROR(${range}>0,FALSE)`;
        if (!alignedDaily) break;
        arrayRef = `${column.kind === "weighted" ? refs.weighted : refs.average}${rowNumber}`;
        if (column.kind === "weighted") {
          formula = `IFERROR(IF(SUMPRODUCT(${select}--ISNUMBER(${range}))=${periodDays},SUMPRODUCT(${select}${positive},IFERROR(${range},0)),${missing}),${missing})`;
        } else {
          const half = (cell: string) => `IF(IFERROR(AND(ISNUMBER(${cell}),${cell}>0),FALSE),0.5,0)`;
          const weight = `SUMPRODUCT(${select}${positive})-${half(start)}-${half(end)}`;
          formula = `IFERROR(IF(ISNUMBER(${sum}),IF(${sum}=0,0,${sum}/(${weight})),${missing}),${missing})`;
        }
        break;
      }
      case "coefficient": {
        const sales = `${refs.sales}${rowNumber}`, average = `${refs.average}${rowNumber}`;
        formula = `IFERROR(IF(AND(ISNUMBER(${sales}),ISNUMBER(${average}),${sales}>=0,${average}>0),${sales}/${average},${missing}),${missing})`;
        break;
      }
      case "sales": {
        const source = `'${salesSheet}'!${refs.salesSource}${salesRow}`;
        formula = `IF(ISNUMBER(${source}),${source},${missing})`;
        break;
      }
      case "turnoverDays": {
        const coefficient = `${refs.coefficient}${rowNumber}`;
        formula = `IFERROR(IF(AND(ISNUMBER(${coefficient}),${coefficient}>0),${periodColumn}${rowNumber}/${coefficient},${missing}),${missing})`;
        break;
      }
    }
    if (formula) {
      // ExcelJS 4.4 supports these array properties in the serializer but its types omit them.
      const cell: ExcelJS.CellFormulaValue & { shareType?: "array"; ref?: string } = { formula, result: value ?? unavailable ?? "" };
      if (arrayRef) {
        cell.shareType = "array";
        cell.ref = arrayRef;
      }
      values.push(cell);
    } else {
      values.push(value ?? unavailable);
    }
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

function addHeaders(sheet: StreamingSheet, identity: string[], groups: { label: string; labels: string[] }[], contextHeading = "Идентификация") {
  const top = sheet.addRow([]);
  const bottom = sheet.addRow([...identity, ...groups.flatMap(group => group.labels)]);
  let col = 1;
  for (const { label, labels } of [{ label: contextHeading, labels: identity }, ...groups]) {
    // Do not merge across the vertical frozen pane; the unit column is scrollable.
    const end = col + labels.length - (col === 1 ? 2 : 1);
    if (end > col) sheet.mergeCells(1, col, 1, end);
    top.getCell(col).value = label;
    col += labels.length;
  }
  for (const row of [top, bottom]) {
    row.height = 30;
    row.eachCell(cell => {
      cell.font = { bold: true };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
    });
  }
  top.commit();
  bottom.commit();
}

async function createSheets(workbook: StreamingWorkbook, report: TurnoverReport, days: string[], mode: TurnoverMode, signal: AbortSignal) {
  const splitStores = report.params.profile !== "sample";
  const itemColumn = splitStores ? 3 : 2;
  const identity = [...(splitStores ? ["Магазин"] : []), "Группа", "Номенклатура", "Ед. учёта"];
  const identityColumns = [...(splitStores ? [{ width: 26 }] : []), { width: 28 }, { width: 44 }, { width: 13 }];
  const groups = turnoverStandardGrid(days, mode);
  const leaves = groups.flatMap(group => group.leaves);
  const dayColumns = groups.slice(0, days.length).reduce((count, group) => count + group.leaves.length, 0);
  const firstSummary = identity.length + dayColumns + 1;
  const positions = new Map<Basis, FormulaColumns>();
  const periodColumn = columnLetter(identity.length + 1 + leaves.findIndex(leaf => leaf.column.kind === "periodDays"));
  const salesName = mode === "both" ? SALES_BOTH : SALES_SINGLE;
  const unavailable = report.params.includeIncomplete ? "n/a" : null;
  const calculation: CalculationLayout = { leaves, positions, periodDays: days.length, periodColumn, salesSheet: salesName, unavailable, mode };
  const views: ExcelJS.AddWorksheetOptions["views"] = [{ state: "frozen", xSplit: itemColumn, ySplit: 2 }];
  const main = workbook.addWorksheet(mode === "both" ? MAIN_BOTH : mode === "money" ? MAIN_MONEY : MAIN_UNITS, {
    views, properties: { outlineLevelCol: 1, outlineProperties: { summaryBelow: true, summaryRight: true } }
  }) as StreamingSheet;
  const sales = workbook.addWorksheet(salesName, { views }) as StreamingSheet;
  main.columns = [...identityColumns, ...leaves.map(({ column, basis }, index) => {
    if (column.kind === "day") return { width: 16, hidden: true, outlineLevel: 1 };
    const numFmt = column.kind === "periodDays" ? "0" : column.kind === "coefficient" || column.kind === "turnoverDays"
      ? "0.00" : basis === "money" ? "#,##0.00" : "#,##0.###";
    // ExcelJS coalesces adjacent equal-width/style columns without comparing `collapsed`.
    return { width: index === dayColumns ? 24 : 19, style: { numFmt } };
  })];
  // Excel needs a single collapse flag on the visible summary column to the right of the hidden detail.
  // Override only these instances; ExcelJS derives the flag from outlineLevel on the detail columns.
  for (let index = identity.length + 1; index <= firstSummary; index++) {
    Object.defineProperty(main.getColumn(index), "collapsed", { get: index === firstSummary ? () => true : () => false });
  }
  const salesMeasures = ["Кол-во", ...(mode === "quantity" ? [] : ["₸ по себестоимости"])];
  sales.columns = [...identityColumns, { width: 16, style: { numFmt: "#,##0.###" } },
    ...(mode === "quantity" ? [] : [{ width: 22, style: { numFmt: "#,##0.00" } }])];
  setFullPageSetup(main);
  if (mode === "quantity") sales.pageSetup.margins = MARGINS;
  else setFullPageSetup(sales);
  const { poorStart, mediumStart, goodStart } = TURNOVER_COEFFICIENT_THRESHOLDS;
  const legend = `Коэффициент: Плохо [${poorStart}; ${mediumStart}) · Средне [${mediumStart}; ${goodStart}) · Хорошо ≥ ${goodStart}`;
  addHeaders(main, identity, groups.map(group => ({ label: group.label, labels: group.leaves.map(leaf => leaf.label) })), legend);
  addHeaders(sales, identity, [{ label: "Продажи за период", labels: salesMeasures }]);
  for (const basis of ["quantity", "money"] as const) {
    if (mode !== "both" && mode !== basis) continue;
    const basisDays = leaves.flatMap(({ column, basis: leafBasis }, index) =>
      leafBasis === basis && column.kind === "day" ? [columnLetter(identity.length + index + 1)] : []);
    const metric = (kind: "weighted" | "average" | "coefficient" | "sales") =>
      columnLetter(identity.length + 1 + leaves.findIndex(leaf => leaf.basis === basis && leaf.column.kind === kind));
    positions.set(basis, {
      fullFirst: basisDays[0]!, halfFirst: basisDays[1]!, halfLast: basisDays.at(-2)!, fullLast: basisDays.at(-1)!,
      weighted: metric("weighted"), average: metric("average"), coefficient: metric("coefficient"), sales: metric("sales"),
      salesSource: columnLetter(identity.length + (basis === "quantity" ? 1 : 2))
    });
  }
  const unitLabels = turnoverUnitLabels(report.totals.byUnit);
  let firstCoefficientRow: number | undefined;
  let lastCoefficientRow = 0;
  let beforeOverall = 2;
  const addProduct = (entry: RowInput, footer = false) => {
    const alignedDaily = entry.row.daily.length === days.length && entry.row.daily.every((day, index) => day.date === days[index]);
    if (!footer && !alignedDaily) throw new Error("Для сводного отчёта нужны дневные остатки за весь период");
    const { quantity, cost } = entry.row.periodSales;
    const salesValues = [...entry.context, entry.quantity ? (numeric(quantity) ? quantity : unavailable) : null];
    if (mode !== "quantity") salesValues.push(entry.money ? (numeric(cost) ? cost : unavailable) : null);
    const salesRow = sales.addRow(salesValues);
    const mainRow = main.addRow([]);
    mainRow.values = mainCellValues(entry, calculation, mainRow.number, salesRow.number, alignedDaily);
    if (footer) for (const row of [mainRow, salesRow]) {
      row.font = { name: "Calibri", size: 11, bold: true };
      row.eachCell(cell => { cell.border = { top: { style: "thin", color: { argb: "FF9CA3AF" } } }; });
      if (entry.row.unit === null) row.getCell(itemColumn).note = "Количество в итогах не складывается: разные или неизвестные единицы.";
    }
    for (const [basis, refs] of positions) {
      if (entry[basis]) styleTurnoverCoefficient(mainRow.getCell(refs.coefficient), basis === "quantity" ? entry.row.turnoverQty : entry.row.turnoverCost);
    }
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
      if (entry.store === null) beforeOverall = lastCoefficientRow || 2;
      for (const total of turnoverStandardTotalRows(entry.label, entry.row, entry.byUnit, mode, unitLabels)) {
        const context = [...(splitStores ? [entry.store] : []), null, total.label, total.row.unit];
        // Explicit money files have always included the quantity sales column as a reference.
        const quantity = mode === "money" ? total.row.unit !== null : total.quantity;
        addProduct({ ...total, quantity, context }, true);
      }
    } else {
      const row = entry.row;
      const context = [...(splitStores ? [storeLabel(row)] : []), groupLabel(row), row.name, row.unit];
      addProduct({ row, quantity: true, money: true, context });
    }
    if (++written % 1024 === 0) {
      await setImmediate();
      signal.throwIfAborted();
      if (workbook.stream.writableNeedDrain) await once(workbook.stream, "drain", { signal });
    }
  }
  if (mode !== "quantity") main.autoFilter = `A2:${columnLetter(identity.length + leaves.length)}${beforeOverall}`;
  if (firstCoefficientRow !== undefined) {
    for (const { coefficient } of positions.values()) formatTurnoverCoefficientRange(main, coefficient, firstCoefficientRow, lastCoefficientRow);
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
  const mode = report.params.mode ?? "both";
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: true }) as StreamingWorkbook;
  const canceled = new AbortController();
  const onError = (error: Error) => canceled.abort(error);
  const onClose = () => { if (!output.writableFinished) canceled.abort(new Error("Excel download was closed")); };
  output.once("error", onError);
  output.once("close", onClose);
  workbook.zip.once("error", onError);
  const interrupted = once(canceled.signal, "abort");
  try {
    await createSheets(workbook, report, days, mode, canceled.signal);
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
