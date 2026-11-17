import type ExcelJS from "exceljs";
import type { EventEmitter } from "node:events";
import type { TurnoverOption, TurnoverReport, TurnoverTotal } from "./turnover-types.js";
import { formatTurnoverCoefficientRange, styleTurnoverCoefficient } from "./turnover-coefficient-workbook.js";
import { completeTurnoverReport } from "./turnover-domain.js";

type StreamingSheet = ExcelJS.Worksheet & { commit(): void };
type StreamingWorkbook = ExcelJS.stream.xlsx.WorkbookWriter & { zip: EventEmitter; stream: EventEmitter };
const decimal = '#,##0.###;[Red](#,##0.###);0';
const money = '#,##0.00;[Red](#,##0.00);0.00';

function dateLabel(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

function inclusiveEnd(toExclusive: string): string {
  return dateLabel(new Date(Date.parse(`${toExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
}

function filterLabels(report: TurnoverReport): string[] {
  const { params, options } = report;
  const labels: string[] = [];
  const names = (keys: string[], choices: TurnoverOption[]) => keys.map(key =>
    choices.find(option => option.key === key)?.name ?? "Выбранное значение отсутствует в справочнике"
  ).join("; ");
  if (params.store?.length) labels.push(`Магазины: ${names(params.store, options.stores)}`);
  if (params.warehouse) labels.push(`Склад: ${names([params.warehouse], options.warehouses)}`);
  if (params.category?.length) labels.push(`Категории: ${names(params.category, options.categories)}`);
  if (params.brand) labels.push(`Бренд: ${names([params.brand], options.brands)}`);
  if (params.sku) labels.push(`Товар: ${names([params.sku], options.skus)}`);
  if (params.search?.trim()) labels.push(`Поиск: ${params.search.trim()}`);
  if (params.storeScope === "all") labels.push("Включены офисы и нерозничные подразделения");
  if (params.excludeZero) labels.push("Товары с достоверно нулевыми остатками и продажами исключены");
  if (params.risk && params.risk !== "all") {
    const risks = { "no-sales": "Нет продаж", overstock: "Излишек", deficit: "Риск дефицита", stagnant: "Без движения" };
    labels.push(`Отбор по риску: ${risks[params.risk]}`);
  }
  if (params.groupBy && params.groupBy !== "sku") {
    const groups = { store: "По магазинам", category: "По категориям", brand: "По брендам", day: "По дням" };
    labels.push(`Детализация: ${groups[params.groupBy]}`);
  }
  return labels;
}

/** Human-readable introduction only: all financial values come from the server totals. */
export async function writeTurnoverSummarySheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, report: TurnoverReport): Promise<void> {
  report = completeTurnoverReport(report);
  const sheet = workbook.addWorksheet("Кратко", {
    properties: { defaultRowHeight: 24 },
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ state: "normal", showGridLines: false }]
  }) as StreamingSheet;
  sheet.columns = [34, 18, 31, 35, 25, 24].map(width => ({
    width, style: { numFmt: decimal, font: { name: "Calibri", size: 11 } }
  }));

  function textRow(text: string, title = false) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, 6);
    row.getCell(1).alignment = { wrapText: true, vertical: "middle" };
    row.font = { name: "Calibri", size: title ? 16 : 11, bold: title };
    const lines = text.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 125)), 0);
    row.height = title ? 32 : Math.min(409, Math.max(24, lines * 16));
    row.commit();
  }

  function headers(costBasis: boolean) {
    const row = sheet.addRow([
      "Показатель", "Единица",
      costBasis ? "Продажи по себестоимости, ₸" : "Продажи за период",
      costBasis ? "Остаток на конец по себестоимости, ₸" : "Остаток на конец",
      "Оборотов за период", "Дней на оборот"
    ]);
    row.height = 48;
    row.eachCell(cell => {
      cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D2939" } };
      cell.alignment = { wrapText: true, vertical: "middle" };
    });
    row.commit();
  }

  function metrics(total: TurnoverTotal, costBasis: boolean) {
    const values = costBasis
      ? [total.periodSales.cost, total.closingCost, total.turnoverCost, total.turnoverCostDays]
      : [total.periodSales.quantity, total.closingQty, total.turnoverQty, total.turnoverQtyDays];
    const row = sheet.addRow([
      costBasis ? "Деньги по себестоимости" : "Количество",
      costBasis ? "₸" : total.unit || "Единица не указана",
      ...values.map(value => typeof value === "number" && Number.isFinite(value) ? value : report.params.includeIncomplete ? "Не рассчитано" : null)
    ]);
    row.height = 32;
    row.eachCell(cell => { cell.alignment = { wrapText: true, vertical: "middle" }; });
    if (costBasis) for (const column of [3, 4]) row.getCell(column).numFmt = money;
    const coefficient = row.getCell(5);
    styleTurnoverCoefficient(coefficient, typeof coefficient.value === "number" ? coefficient.value : null);
    formatTurnoverCoefficientRange(sheet, "E", row.number, row.number);
    row.commit();
  }

  textRow("Оборачиваемость · кратко", true);
  textRow(`Фактический период: ${dateLabel(report.params.from)}–${inclusiveEnd(report.params.to)} (включительно)`);
  const rowCount = report.params.groupBy === "day" ? report.daily.length : report.rows.length;
  textRow(`Строк в отчёте: ${rowCount}`);
  if (!report.params.includeIncomplete) {
    textRow("По строкам с полным расчётом. Итоги относятся только к включённым строкам, не ко всей исходной выборке.");
    textRow(`Исключено строк без полного расчёта: ${report.excludedIncompleteRows ?? 0}`);
    textRow("Пустые дополнительные расчёты и несовместимые итоги не показаны; это не нулевые значения.");
  } else {
    textRow("Включены строки без полного расчёта");
  }
  if (report.coverage.requestedTo) {
    textRow(`Период сокращён. Запрошено по ${inclusiveEnd(report.coverage.requestedTo)}; рассчитано по ${inclusiveEnd(report.params.to)} (включительно).`);
  }
  for (const label of filterLabels(report)) textRow(label);
  sheet.addRow([]).commit();

  if (rowCount === 0) {
    textRow((report.excludedIncompleteRows ?? 0) > 0
      ? "Все строки по выбранным условиям исключены: нет полного расчёта. Включите строки без полного расчёта для проверки."
      : "По выбранным условиям товаров нет");
  } else {
    const mode = report.params.mode ?? "both";
    if (mode !== "money") {
      if (report.totals.overall.unit?.trim()) {
        headers(false);
        metrics(report.totals.overall, false);
      } else {
        textRow("Общий итог количества не рассчитан");
        if (report.totals.byUnit.length > 0) {
          headers(false);
          for (const total of report.totals.byUnit) metrics(total, false);
        }
      }
    }
    if (mode !== "quantity") {
      if (mode === "both") sheet.addRow([]).commit();
      headers(true);
      metrics(report.totals.overall, true);
      sheet.addRow([]).commit();
      const revenue = report.totals.overall.periodSales.revenue;
      const row = sheet.addRow(["Розничная выручка, ₸", null, null, null, null,
        typeof revenue === "number" && Number.isFinite(revenue) ? revenue : report.params.includeIncomplete ? "Не рассчитано" : null]);
      sheet.mergeCells(row.number, 1, row.number, 5);
      row.height = 28;
      row.getCell(1).alignment = { wrapText: true, vertical: "middle" };
      row.getCell(6).numFmt = money;
      row.commit();
    }
  }

  sheet.addRow([]).commit();
  if (report.warnings.length > 0) {
    textRow(`Ограничения данных: ${report.warnings.length}`);
    for (const warning of report.warnings) textRow(warning);
  }
  textRow("Подробный расчёт — на следующих листах");

  // WorksheetWriter.commit() is synchronous. Wait for the archive entry, as the
  // detailed writer does, before allowing the next sheet to consume more rows.
  const { zip: archive, stream: output } = workbook as StreamingWorkbook;
  const entryName = `xl/worksheets/sheet${sheet.id}.xml`;
  let onEntry!: (entry: { name: string }) => void;
  let onError!: (error: Error) => void;
  let onClose!: () => void;
  const processed = new Promise<void>((resolve, reject) => {
    onEntry = entry => { if (entry.name.replace(/^\/+/, "") === entryName) resolve(); };
    onError = reject;
    onClose = () => reject(new Error("Excel download was closed"));
    archive.on("entry", onEntry);
    archive.once("error", onError);
    output.once("error", onError);
    output.once("close", onClose);
  });
  try {
    sheet.commit();
    await processed;
  } finally {
    archive.off("entry", onEntry);
    archive.off("error", onError);
    output.off("error", onError);
    output.off("close", onClose);
  }
}
