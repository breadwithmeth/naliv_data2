import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import { once } from "node:events";
import type { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import type {
  CompensationActivity, CompensationBranch, CompensationIssue, CompensationRow,
  CompensationTotals, MarketingCompensationReport
} from "./marketing-compensation-types.js";

const unavailable = "n/a";
const moneyFormat = '#,##0.00;[Red](#,##0.00);0.00';
const quantityFormat = '#,##0.###;[Red](#,##0.###);0';
const percentFormat = '0.##%;[Red](0.##%);0%';
const mainName = "Компенсации";
const diagnosticsName = "Диагностика";
const headings = ["Штрихкод", "Наименование", "Розничная цена до скидки, ₸", "Компенсация, %", "Компенсация на единицу, ₸", "Нетто количество", "Компенсация, ₸"];
const border: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFD9D9D9" } },
  bottom: { style: "thin", color: { argb: "FFD9D9D9" } },
  left: { style: "thin", color: { argb: "FFD9D9D9" } },
  right: { style: "thin", color: { argb: "FFD9D9D9" } }
};
type BranchBlock = { activity: CompensationActivity; branch: CompensationBranch };
type StreamingSheet = ExcelJS.Worksheet & { commit(): void };
type StreamingWorkbook = ExcelJS.stream.xlsx.WorkbookWriter & { zip: EventEmitter & { abort(): void } };

function period(from: string, to: string): string {
  return `[${from}, ${to})`;
}
function activityLabel(activity: CompensationActivity): string {
  return `${activity.name}${activity.number === null ? "" : ` · № ${activity.number}`} [${activity.key}]`;
}
function activityPeriod(activity: CompensationActivity): string {
  return `${activity.startsOn ?? unavailable} — ${activity.endsOn ?? unavailable} (включительно)`;
}
function branchLabel(branch: CompensationBranch): string {
  return `${branch.name} [${branch.key ?? unavailable}]`;
}

function sheet(workbook: StreamingWorkbook, name: string, widths: number[], formats: string[]): StreamingSheet {
  const result = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 3 }],
    properties: { defaultRowHeight: 21 },
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  }) as StreamingSheet;
  result.columns = widths.map((width, index) => ({
    width, style: { font: { name: "Calibri", size: 11 }, numFmt: formats[index] ?? "@" }
  }));
  result.pageSetup.printTitlesRow = "1:3";
  return result;
}
function styleRow(row: ExcelJS.Row, kind: "body" | "heading" | "total" = "body"): void {
  for (let column = 1; column <= 7; column++) {
    const cell = row.getCell(column);
    cell.font = { name: "Calibri", size: 11, bold: kind !== "body" };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = border;
    if (kind !== "body") cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2EFDA" } };
  }
  if (kind === "heading") {
    row.height = 45;
    row.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  }
}
function mergedRow(worksheet: ExcelJS.Worksheet, text: string, title = false): void {
  const row = worksheet.addRow([text]);
  worksheet.mergeCells(row.number, 1, row.number, 7);
  row.getCell(1).font = { name: title ? "Arial" : "Calibri", size: title ? 13 : 11, bold: title };
  row.getCell(1).alignment = { vertical: "middle", wrapText: true };
  row.height = title ? 30 : 36;
  row.commit();
}
function topRows(worksheet: ExcelJS.Worksheet, title: string, note: string, labels: string[]): void {
  mergedRow(worksheet, title, true);
  mergedRow(worksheet, note);
  const heading = worksheet.addRow(labels);
  styleRow(heading, "heading");
  heading.commit();
}
function reportNote(report: MarketingCompensationReport): string {
  return `Период расчёта ${period(report.from, report.to)}; правая граница исключена. n/a — данных нет или полный итог недоступен; 0 — известный ноль. Известная часть не заменяет полный итог.`;
}
function totalRows(worksheet: ExcelJS.Worksheet, label: string, totals: CompensationTotals): void {
  const row = worksheet.addRow([
    `${label}${totals.incompleteRows ? ` · неполных строк: ${totals.incompleteRows}` : ""}`,
    null, null, null, null, null, totals.compensation ?? unavailable
  ]);
  worksheet.mergeCells(row.number, 1, row.number, 5);
  styleRow(row, "total");
  row.commit();
  if (totals.compensation === null) {
    const known = worksheet.addRow(["Известная часть компенсации (не полный итог)", null, null, null, null, null, totals.knownCompensation]);
    worksheet.mergeCells(known.number, 1, known.number, 5);
    styleRow(known, "total");
    known.commit();
  }
}
function branchTotals(blocks: BranchBlock[]): CompensationTotals {
  let compensation = new Prisma.Decimal(0);
  let knownCompensation = new Prisma.Decimal(0);
  let compensationComplete = true;
  let incompleteRows = 0;
  for (const { branch: { totals } } of blocks) {
    if (totals.compensation === null) compensationComplete = false;
    else compensation = compensation.plus(totals.compensation);
    knownCompensation = knownCompensation.plus(totals.knownCompensation);
    incompleteRows += totals.incompleteRows;
  }
  return {
    compensation: compensationComplete ? compensation.toNumber() : null,
    knownCompensation: knownCompensation.toNumber(), incompleteRows
  };
}
function itemRow(worksheet: ExcelJS.Worksheet, item: CompensationRow): void {
  // Assign source strings directly: leading '=' is text, never an Excel formula.
  const row = worksheet.addRow([
    item.barcode ?? unavailable, item.name, item.price ?? unavailable,
    item.discountPct === null ? unavailable : item.discountPct / 100,
    item.unitCompensation ?? unavailable, item.quantity ?? unavailable, item.compensation ?? unavailable
  ]);
  styleRow(row);
  row.getCell(1).numFmt = "@";
  row.getCell(2).note = `Товар: ${item.itemKey}\nХарактеристика: ${item.characteristicKey ?? unavailable}\nПериод строки: ${period(item.from, item.to)}${item.issues.length ? `\n${item.issues.map(issue => `${issue.code}: ${issue.message}`).join("\n")}` : ""}`;
  row.getCell(3).note = `Цена до скидки из строки продажи/возврата 1С\nПериод строки: ${period(item.from, item.to)}`;
  row.commit();
}

async function finishSheet(workbook: StreamingWorkbook, worksheet: StreamingSheet, signal: AbortSignal, hasNotes = false): Promise<void> {
  signal.throwIfAborted();
  // Wait for the last sheet entry, including notes/VML, before producing another
  // sheet. Row commits alone do not impose backpressure on ExcelJS's ZIP buffers.
  const entryName = hasNotes ? `xl/worksheets/_rels/sheet${worksheet.id}.xml.rels` : `xl/worksheets/sheet${worksheet.id}.xml`;
  let onEntry!: (entry: { name: string }) => void;
  let onAbort!: () => void;
  const processed = new Promise<void>((resolve, reject) => {
    onEntry = entry => { if (entry.name.replace(/^\/+/, "") === entryName) resolve(); };
    onAbort = () => reject(signal.reason);
    workbook.zip.on("entry", onEntry);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    worksheet.commit();
    await processed;
  } finally {
    workbook.zip.off("entry", onEntry);
    signal.removeEventListener("abort", onAbort);
  }
}

async function writeSheets(workbook: StreamingWorkbook, report: MarketingCompensationReport, signal: AbortSignal): Promise<void> {
  let written = 0;
  const checkpoint = async () => { await setImmediate(); signal.throwIfAborted(); };
  workbook.creator = "Налив — аналитика";
  const mainBlocks: BranchBlock[] = [];
  const correctionBlocks: BranchBlock[] = [];
  for (const activity of report.activities) for (const branch of activity.branches) {
    if (branch.hasSales) mainBlocks.push({ activity, branch });
    else if (branch.hasReturns) correctionBlocks.push({ activity, branch });
  }
  const createDetailSheet = (name: string, note = "") => {
    const detail = sheet(workbook, name, [28.7109375, 66.140625, 24, 18, 24, 22, 25], [
      "@", "@", moneyFormat, percentFormat, moneyFormat, quantityFormat, moneyFormat
    ]);
    topRows(detail, `Маркетинговые компенсации${name === mainName ? "" : " · корректировки"}`, `${reportNote(report)}${note ? ` ${note}` : ""}`, headings);
    return detail;
  };
  const writeStoreBlocks = async (detail: StreamingSheet, blocks: BranchBlock[]) => {
    const stores = new Map<string | null, BranchBlock[]>();
    for (const block of blocks) {
      const list = stores.get(block.branch.key) ?? [];
      list.push(block);
      stores.set(block.branch.key, list);
    }
    const ordered = [...stores.values()].sort((a, b) => a[0].branch.name.localeCompare(b[0].branch.name, "ru")
      || (a[0].branch.key ?? "").localeCompare(b[0].branch.key ?? ""));
    for (const storeBlocks of ordered) {
      mergedRow(detail, branchLabel(storeBlocks[0].branch), true);
      storeBlocks.sort((a, b) => a.activity.name.localeCompare(b.activity.name, "ru") || a.activity.key.localeCompare(b.activity.key));
      for (const { activity, branch } of storeBlocks) {
        mergedRow(detail, activityLabel(activity), true);
        mergedRow(detail, `Период акции: ${activityPeriod(activity)}; расчёт ${period(activity.from, activity.to)}.`);
        for (const item of branch.rows) {
          itemRow(detail, item);
          if (++written % 256 === 0) await checkpoint();
        }
        totalRows(detail, "Итого по акции в магазине", branch.totals);
      }
      totalRows(detail, "Итого по магазину · показанные акции", branchTotals(storeBlocks));
    }
  };
  const main = createDetailSheet(mainName);
  await writeStoreBlocks(main, mainBlocks);
  if (!mainBlocks.length) mergedRow(main, report.totals.compensation === null
    ? "Данные неполны; проверьте лист «Диагностика». Отсутствие продаж не подтверждено."
    : correctionBlocks.length ? "Нет акций с продажами; возвраты показаны на листе «Корректировки»."
      : "Нет продаж за выбранный период");
  totalRows(main, "ИТОГО по акциям с продажами", branchTotals(mainBlocks));
  if (correctionBlocks.length) totalRows(main, "Корректировки по возвратам", branchTotals(correctionBlocks));
  totalRows(main, "ОБЩИЙ ИТОГ с корректировками", report.totals);
  await finishSheet(workbook, main, signal, mainBlocks.some(b => b.branch.rows.length > 0));
  if (correctionBlocks.length) {
    const corrections = createDetailSheet("Корректировки", "Акции только с возвратами; суммы включены в общий итог.");
    await writeStoreBlocks(corrections, correctionBlocks);
    totalRows(corrections, "ИТОГО корректировок по возвратам", branchTotals(correctionBlocks));
    await finishSheet(workbook, corrections, signal, correctionBlocks.some(b => b.branch.rows.length > 0));
  }

  const diagnostics = sheet(workbook, diagnosticsName, [18, 52, 45, 60, 64, 32, 85], []);
  topRows(diagnostics, "Диагностика исходных данных", reportNote(report), [
    "Уровень", "Маркетинг", "Филиал", "Номенклатура / характеристика", "Контекст дат [с, по)", "Код", "Сообщение"
  ]);
  let diagnosticsLastRow = 3;
  const addIssues = (issues: CompensationIssue[], level: string, activity: string | null, branch: string | null, item: string | null, dates: string) => {
    for (const issue of issues) {
      signal.throwIfAborted();
      const row = diagnostics.addRow([level, activity, branch, item, dates, issue.code, issue.message]);
      styleRow(row);
      diagnosticsLastRow = row.number;
      row.commit();
    }
  };
  addIssues(report.issues, "Отчёт", null, null, null, period(report.from, report.to));
  for (const activity of report.activities) {
    const label = activityLabel(activity);
    const dates = `Расчёт ${period(activity.from, activity.to)}; активность ${activityPeriod(activity)}`;
    addIssues(activity.issues, "Маркетинг", label, null, null, dates);
    for (const branch of activity.branches) {
      const branchIdentity = branchLabel(branch);
      addIssues(branch.issues, "Филиал", label, branchIdentity, null, dates);
      if (!branch.hasSales && !branch.hasReturns) addIssues([{
        code: branch.totals.compensation === null ? "unresolved_movements" : "no_movements",
        message: branch.totals.compensation === null
          ? "Блок не включён в таблицы: наличие движений не определено. Полный итог недоступен."
          : "Блок не включён в таблицы: нет положительных продаж или корректировок."
      }], "Филиал", label, branchIdentity, null, dates);
      for (const item of branch.rows) {
        if (item.issues.length) {
          addIssues(item.issues, "Строка", label, branchIdentity,
            `${item.name} [${item.itemKey}]; характеристика: ${item.characteristicKey ?? unavailable}; штрихкод: ${item.barcode ?? unavailable}`,
            `Расчёт ${period(item.from, item.to)}; цена до скидки из строки движения 1С`);
        }
        if (++written % 256 === 0) await checkpoint();
      }
    }
  }
  diagnostics.autoFilter = { from: { row: 3, column: 1 }, to: { row: diagnosticsLastRow, column: 7 } };
  await finishSheet(workbook, diagnostics, signal);
}

export async function writeMarketingCompensationWorkbook(report: MarketingCompensationReport, output: Writable): Promise<void> {
  if (output.destroyed) throw new Error("Excel download was closed");
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output, useStyles: true, useSharedStrings: false
  }) as StreamingWorkbook;
  const archive = workbook.zip;
  const canceled = new AbortController();
  const onError = (error: Error) => canceled.abort(error);
  const onClose = () => { if (!output.writableFinished) canceled.abort(new Error("Excel download was closed")); };
  output.once("error", onError);
  output.once("close", onClose);
  archive.once("error", onError);
  const interrupted = once(canceled.signal, "abort");
  try {
    await writeSheets(workbook, report, canceled.signal);
    canceled.signal.throwIfAborted();
    await Promise.race([
      workbook.commit(),
      interrupted.then(() => { throw canceled.signal.reason; })
    ]);
  } catch (error) {
    archive.abort();
    output.destroy();
    throw error;
  } finally {
    output.removeListener("error", onError);
    output.removeListener("close", onClose);
    archive.removeListener("error", onError);
    canceled.abort();
  }
}
