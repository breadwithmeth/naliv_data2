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
const summaryName = "Сводка";
const diagnosticsName = "Диагностика";
const headings = ["Штрихкод", "Наименование", "Цена, ₸", "Скидка, %", "Скидка на единицу, ₸", "Нетто количество", "Компенсация, ₸"];
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

function worksheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\p{Cc}\p{Cs}\u2028\u2029\uFFFE\uFFFF\\/*?:[\]]/gu, " ")
    .trim().replace(/^'+|'+$/g, "").trim() || "Филиал";
  let suffix = "";
  let candidate: string;
  let index = 1;
  do {
    // Excel limits names to 31 UTF-16 units; never cut an astral character in half.
    const stem = base.slice(0, 31 - suffix.length).replace(/[\uD800-\uDBFF]$/, "").replace(/'+$/g, "").trimEnd();
    candidate = `${stem || "Филиал"}${suffix}`;
    suffix = ` (${++index})`;
  } while (used.has(candidate.toLowerCase()));
  used.add(candidate.toLowerCase());
  return candidate;
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
  row.getCell(3).note = `Дата установки закупочной цены филиала: ${item.priceDate ?? unavailable}\nПериод строки: ${period(item.from, item.to)}`;
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
  const usedNames = new Set([summaryName.toLowerCase(), diagnosticsName.toLowerCase(), "history"]);
  const summary = sheet(workbook, summaryName, [58, 30, 34, 20, 25, 25, 19], ["@", "@", "@", "0", moneyFormat, moneyFormat, "0"]);
  topRows(summary, "Маркетинговые компенсации · сводка", reportNote(report), [
    "Маркетинг", "Период расчёта [с, по)", "Период активности", "Филиалов",
    "Полная компенсация, ₸", "Известная часть, ₸", "Неполных строк"
  ]);
  const branches = new Map<string | null, { name: string; blocks: BranchBlock[] }>();
  for (const activity of report.activities) {
    const totals = activity.totals;
    const row = summary.addRow([
      activityLabel(activity), period(activity.from, activity.to), activityPeriod(activity),
      activity.branches.length, totals.compensation ?? unavailable, totals.knownCompensation, totals.incompleteRows
    ]);
    styleRow(row);
    row.commit();
    for (const branch of activity.branches) {
      const existing = branches.get(branch.key);
      const block = { activity, branch };
      if (existing) existing.blocks.push(block);
      else branches.set(branch.key, { name: branch.name, blocks: [block] });
    }
  }
  const grandTotal = summary.addRow([
    "Общий итог", null, null, branches.size,
    report.totals.compensation ?? unavailable, report.totals.knownCompensation, report.totals.incompleteRows
  ]);
  summary.mergeCells(grandTotal.number, 1, grandTotal.number, 3);
  styleRow(grandTotal, "total");
  grandTotal.commit();
  await finishSheet(workbook, summary, signal);

  for (const { name, blocks } of branches.values()) {
    // The example's wide identity columns, Calibri headings, pale fill and thin grid
    // are retained; numeric columns are widened to fit explicit units and no blanks are padded.
    const branchSheet = sheet(workbook, worksheetName(name, usedNames), [28.7109375, 66.140625, 16, 14, 22, 22, 25], [
      "@", "@", moneyFormat, percentFormat, moneyFormat, quantityFormat, moneyFormat
    ]);
    topRows(branchSheet, branchLabel(blocks[0].branch), reportNote(report), headings);
    for (const { activity, branch } of blocks) {
      mergedRow(branchSheet, activityLabel(activity), true);
      mergedRow(branchSheet, `Период активности: ${activityPeriod(activity)}; расчёт ${period(activity.from, activity.to)}.`);
      for (const item of branch.rows) {
        itemRow(branchSheet, item);
        if (++written % 256 === 0) await checkpoint();
      }
      totalRows(branchSheet, "Итого по маркетингу в филиале", branch.totals);
    }
    totalRows(branchSheet, "Итого по филиалу · все показанные маркетинги", branchTotals(blocks));
    await finishSheet(workbook, branchSheet, signal, blocks.some(block => block.branch.rows.length > 0));
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
      for (const item of branch.rows) {
        if (item.issues.length) {
          addIssues(item.issues, "Строка", label, branchIdentity,
            `${item.name} [${item.itemKey}]; характеристика: ${item.characteristicKey ?? unavailable}; штрихкод: ${item.barcode ?? unavailable}`,
            `Расчёт ${period(item.from, item.to)}; дата цены: ${item.priceDate ?? unavailable}`);
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
