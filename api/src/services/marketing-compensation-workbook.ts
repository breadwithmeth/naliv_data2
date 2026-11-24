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
import {
  type CompensationBasis, compensationBases, isInactiveCompensationActivity, isInactiveCompensationBranch,
  projectCompensationReport
} from "./marketing-compensation-presentation.js";

const unavailable = "Нет данных";
const moneyFormat = '#,##0.00;[Red](#,##0.00);0.00';
const quantityFormat = '#,##0.###;[Red](#,##0.###);0';
const percentFormat = '0.##%;[Red](0.##%);0%';
const mainName = "Компенсации";
const detailName = "Детализация";
const diagnosticsName = "Диагностика";
const border: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFD9D9D9" } },
  bottom: { style: "thin", color: { argb: "FFD9D9D9" } },
  left: { style: "thin", color: { argb: "FFD9D9D9" } },
  right: { style: "thin", color: { argb: "FFD9D9D9" } }
};
type BranchBlock = { activity: CompensationActivity; branch: CompensationBranch };
type StreamingSheet = ExcelJS.Worksheet & { commit(): void };
type StreamingWorkbook = ExcelJS.stream.xlsx.WorkbookWriter & { zip: EventEmitter & { abort(): void } };

function date(value: string): string {
  return `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}`;
}
function period(from: string, to: string): string {
  const lastDay = new Date(`${to}T00:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  return `${date(from)}–${date(lastDay.toISOString().slice(0, 10))}`;
}
function activityLabel(activity: CompensationActivity): string {
  return activity.name === activity.key || activity.name === activity.number ? "Акция без названия" : activity.name;
}
function activityPeriod(activity: Pick<CompensationActivity, "startsOn" | "endsOn">): string {
  return `${activity.startsOn === null ? unavailable : date(activity.startsOn)}–${activity.endsOn === null ? unavailable : date(activity.endsOn)}`;
}
function incomplete(totals: CompensationTotals): boolean {
  return !Number.isFinite(totals.compensation) || totals.incompleteRows > 0;
}
function storeGroups(blocks: BranchBlock[]): BranchBlock[][] {
  const stores = new Map<string | null, BranchBlock[]>();
  for (const block of blocks) {
    const list = stores.get(block.branch.key);
    if (list) list.push(block);
    else stores.set(block.branch.key, [block]);
  }
  const ordered = [...stores.values()].sort((a, b) => a[0].branch.name.localeCompare(b[0].branch.name, "ru")
    || (a[0].branch.key ?? "").localeCompare(b[0].branch.key ?? ""));
  for (const group of ordered) group.sort((a, b) => a.activity.name.localeCompare(b.activity.name, "ru")
    || a.activity.key.localeCompare(b.activity.key));
  return ordered;
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
function mergedRow(worksheet: ExcelJS.Worksheet, text: string, title = false, height = title ? 30 : 36): void {
  const row = worksheet.addRow([text]);
  worksheet.mergeCells(row.number, 1, row.number, 7);
  row.getCell(1).font = { name: title ? "Arial" : "Calibri", size: title ? 13 : 11, bold: title };
  row.getCell(1).alignment = { vertical: "middle", wrapText: true };
  row.height = height;
  row.commit();
}
function topRows(worksheet: ExcelJS.Worksheet, title: string, note: string, labels: string[]): void {
  mergedRow(worksheet, title, true);
  mergedRow(worksheet, note, false, 60);
  const heading = worksheet.addRow(labels);
  styleRow(heading, "heading");
  heading.commit();
}
function reportNote(report: MarketingCompensationReport, basis: CompensationBasis): string {
  const exclusions = report.includeIncomplete ? "" : ` Исключено строк без полного расчёта: ${report.excludedIncompleteRows ?? 0}; блоков без расчёта: ${report.excludedIncompleteBlocks ?? 0}.`;
  const priceCaveat = report.calculationMode === "purchase-title"
    ? " Привязка вида закупа — по текущей карточке магазина; возврат — на дату и в магазине движения." : "";
  return `Период расчёта ${period(report.from, report.to)} (включительно). Режим: ${basis.title}.${priceCaveat} Для другого расчёта переключите режим на сайте и повторите выгрузку. ${report.includeIncomplete ? "Нет данных — показатель неизвестен; " : ""}0 — известный ноль. Рассчитанная часть не заменяет полный итог.${exclusions}`;
}
function totalRows(worksheet: ExcelJS.Worksheet, label: string, totals: CompensationTotals, includeIncomplete = false, filtered = false): void {
  if ((incomplete(totals) || filtered) && !includeIncomplete) {
    const row = worksheet.addRow([`${label} · рассчитанная часть, не полный итог`, null, null, null, null, null,
      Number.isFinite(totals.knownCompensation) ? totals.knownCompensation : null]);
    worksheet.mergeCells(row.number, 1, row.number, 5);
    styleRow(row, "total");
    row.commit();
    return;
  }
  const row = worksheet.addRow([
    `${label}${totals.incompleteRows ? ` · неполных строк: ${totals.incompleteRows}` : ""}`,
    null, null, null, null, null, incomplete(totals) ? "Не рассчитано" : totals.compensation
  ]);
  worksheet.mergeCells(row.number, 1, row.number, 5);
  styleRow(row, "total");
  row.commit();
  if (incomplete(totals)) {
    const known = worksheet.addRow(["Рассчитанная часть компенсации (не полный итог)", null, null, null, null, null, totals.knownCompensation]);
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
  for (const { branch: { totals, excludedIncompleteRows } } of blocks) {
    if (totals.compensation === null || !Number.isFinite(totals.compensation) || (excludedIncompleteRows ?? 0) > 0) compensationComplete = false;
    else compensation = compensation.plus(totals.compensation);
    knownCompensation = knownCompensation.plus(totals.knownCompensation);
    incompleteRows += totals.incompleteRows;
  }
  return {
    compensation: compensationComplete ? compensation.toNumber() : null,
    knownCompensation: knownCompensation.toNumber(), incompleteRows
  };
}
function itemRow(worksheet: ExcelJS.Worksheet, item: CompensationRow, basis: CompensationBasis): void {
  // Assign source strings directly: leading '=' is text, never an Excel formula.
  const row = worksheet.addRow([
    item.barcode, item.name === item.itemKey ? "Товар не определён" : item.name, item.price ?? unavailable,
    item.discountPct === null ? unavailable : item.discountPct / 100,
    item.unitCompensation ?? unavailable, item.quantity ?? unavailable, item.compensation ?? unavailable
  ]);
  styleRow(row);
  row.getCell(1).numFmt = "@";
  row.getCell(2).note = `Товар: ${item.itemKey}\nХарактеристика: ${item.characteristicKey ?? unavailable}\nПериод строки: ${period(item.from, item.to)}${item.issues.length ? `\n${item.issues.map(issue => `${issue.code}: ${issue.message}`).join("\n")}` : ""}`;
  row.getCell(3).note = `${basis.priceSource}\nПериод строки: ${period(item.from, item.to)}`;
  row.getCell(4).note = basis.percentageSource;
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
  const includeIncomplete = report.includeIncomplete === true;
  const basis = compensationBases[report.calculationMode];
  const note = reportNote(report, basis);
  const rowContext = { code: "row_context", message: `${basis.priceSource} ${basis.percentageSource}` };
  const hasExclusions = (report.excludedIncompleteRows ?? 0) > 0 || (report.excludedIncompleteBlocks ?? 0) > 0;
  const checkpoint = async () => { await setImmediate(); signal.throwIfAborted(); };
  workbook.creator = "Налив — аналитика";
  const includedBlocks: BranchBlock[] = [];
  const mainBlocks: BranchBlock[] = [];
  const correctionBlocks: BranchBlock[] = [];
  const reviewBlocks: BranchBlock[] = [];
  const excluded = new Set<CompensationBranch>();
  const unresolvedActivities = new Set<CompensationActivity>();
  for (const activity of report.activities) {
    const allBranchesInactive = activity.branches.every(isInactiveCompensationBranch);
    const unresolved = activity.issues.length > 0 || incomplete(activity.totals)
      || (allBranchesInactive && !isInactiveCompensationActivity(activity));
    if (unresolved) unresolvedActivities.add(activity);
    for (const branch of activity.branches) {
      signal.throwIfAborted();
      if (!unresolved && isInactiveCompensationBranch(branch)) {
        excluded.add(branch);
        continue;
      }
      const block = { activity, branch };
      includedBlocks.push(block);
      if (branch.hasSales) mainBlocks.push(block);
      else if (branch.hasReturns) correctionBlocks.push(block);
      else reviewBlocks.push(block);
    }
  }
  const needsReview = ({ activity, branch }: BranchBlock) => unresolvedActivities.has(activity)
    || incomplete(branch.totals) || (!branch.hasSales && !branch.hasReturns);
  const summary = sheet(workbook, mainName, [34, 46, 29, 28, 24, 27, 46], [
    "@", "@", "@", "@", moneyFormat, moneyFormat, "@"
  ]);
  topRows(summary, "Маркетинговые компенсации", note, [
    "Магазин", "Акция", "Период расчёта", "Статус", "Компенсация, ₸", "Рассчитанная часть, ₸", "Подробности"
  ]);
  const summaryTotal = (label: string, totals: CompensationTotals, review = false, filtered = false) => {
    const unknown = incomplete(totals) || (!includeIncomplete && filtered);
    const row = summary.addRow([
      label, null, null, unknown || review ? !includeIncomplete && unknown ? "Расчёт неполный · рассчитанная часть" : "Нужна проверка" : "Рассчитано",
      unknown ? includeIncomplete ? "Не рассчитано" : null : totals.compensation,
      unknown && Number.isFinite(totals.knownCompensation) ? totals.knownCompensation : null,
      totals.incompleteRows ? `Строк без расчёта: ${totals.incompleteRows}` : null
    ]);
    styleRow(row, "total");
    row.commit();
  };
  for (const storeBlocks of storeGroups(includedBlocks)) {
    for (const block of storeBlocks) {
      const { activity, branch } = block;
      const unknown = incomplete(branch.totals) || (!includeIncomplete && (branch.excludedIncompleteRows ?? 0) > 0);
      const review = needsReview(block) || unknown;
      const status = review ? !includeIncomplete && unknown ? "Расчёт неполный · рассчитанная часть" : "Нужна проверка" : branch.hasSales ? "Рассчитано" : "Возвраты / корректировки";
      const detail = branch.hasSales ? detailName : branch.hasReturns ? "Корректировки" : `${detailName} · Требует проверки`;
      const notes = [
        detail,
        ...(review && branch.hasReturns && !branch.hasSales ? ["возвраты / корректировки"] : []),
        ...(unknown ? [`строк без расчёта: ${branch.totals.incompleteRows}`] : []),
        ...(review ? [diagnosticsName] : [])
      ];
      const row = summary.addRow([
        branch.name, activityLabel(activity), period(activity.from, activity.to), status,
        unknown ? includeIncomplete ? "Не рассчитано" : null : branch.totals.compensation,
        unknown && Number.isFinite(branch.totals.knownCompensation) ? branch.totals.knownCompensation : null,
        notes.join(" · ")
      ]);
      styleRow(row);
      row.commit();
      if (++written % 256 === 0) await checkpoint();
    }
    summaryTotal(`Итого по магазину: ${storeBlocks[0].branch.name} · показанные акции`,
      branchTotals(storeBlocks), storeBlocks.some(needsReview));
  }
  const reportNeedsReview = incomplete(report.totals) || report.issues.length > 0
    || (includedBlocks.length === 0 && report.totals.compensation !== 0);
  if (includeIncomplete && (unresolvedActivities.size || reportNeedsReview)) {
    mergedRow(summary, "Не удалось полностью рассчитать", true);
    for (const activity of unresolvedActivities) {
      const row = summary.addRow([
        null, activityLabel(activity), period(activity.from, activity.to), "Нужна проверка", null, null,
        `${diagnosticsName} · ${activity.branches.length ? "есть ограничения расчёта активности" : "магазины не определены"}`
      ]);
      styleRow(row);
      row.commit();
    }
    if (reportNeedsReview) {
      const row = summary.addRow([null, "Весь отчёт", period(report.from, report.to), "Нужна проверка", null, null, diagnosticsName]);
      styleRow(row);
      row.commit();
    }
  } else if (includedBlocks.length === 0 && hasExclusions) {
    mergedRow(summary, "Нет строк с полным расчётом. Включите строки без полного расчёта, чтобы вернуть исключённые блоки.");
  } else if (includedBlocks.length === 0 && !reportNeedsReview) {
    mergedRow(summary, "За выбранный период продаж и возвратов не было");
  }
  summaryTotal("ОБЩИЙ ИТОГ", report.totals, reportNeedsReview || unresolvedActivities.size > 0 || reviewBlocks.length > 0, hasExclusions);
  await finishSheet(workbook, summary, signal);

  const createDetailSheet = (name: string, sheetNote = "") => {
    const detail = sheet(workbook, name, [28.7109375, 66.140625, 24, 18, 24, 22, 25], [
      "@", "@", moneyFormat, percentFormat, moneyFormat, quantityFormat, moneyFormat
    ]);
    topRows(detail, `Маркетинговые компенсации · ${name.toLocaleLowerCase("ru")}`, sheetNote ? `${note} ${sheetNote}` : note, [
      "Штрихкод", "Наименование", `${basis.priceLabel}, ₸`, `${basis.percentageLabel}, %`,
      "Компенсация на единицу, ₸", "Нетто количество", "Компенсация, ₸"
    ]);
    return detail;
  };
  const writeStoreBlocks = async (detail: StreamingSheet, blocks: BranchBlock[]) => {
    for (const storeBlocks of storeGroups(blocks)) {
      mergedRow(detail, storeBlocks[0].branch.name, true);
      for (const { activity, branch } of storeBlocks) {
        mergedRow(detail, activityLabel(activity), true);
        mergedRow(detail, `Период акции: ${activityPeriod(activity)}; расчёт ${period(activity.from, activity.to)} (включительно).`);
        for (const item of branch.rows) {
          itemRow(detail, item, basis);
          if (++written % 256 === 0) await checkpoint();
        }
        totalRows(detail, "Итого по акции в магазине", branch.totals, includeIncomplete, (branch.excludedIncompleteRows ?? 0) > 0);
      }
      totalRows(detail, "Итого по магазину · показанные акции", branchTotals(storeBlocks), includeIncomplete);
    }
  };
  const main = createDetailSheet(detailName);
  await writeStoreBlocks(main, mainBlocks);
  if (mainBlocks.length) totalRows(main, "ИТОГО по акциям с продажами", branchTotals(mainBlocks), includeIncomplete);
  if (reviewBlocks.length) {
    mergedRow(main, "Требует проверки", true);
    mergedRow(main, "Наличие продаж и возвратов не определено. Исходные строки сохранены; причины — на листе «Диагностика».");
    await writeStoreBlocks(main, reviewBlocks);
    totalRows(main, "ИТОГО по блокам, требующим проверки", branchTotals(reviewBlocks), includeIncomplete);
  }
  if (!mainBlocks.length && !reviewBlocks.length) mergedRow(main, hasExclusions && !correctionBlocks.length
    ? "Нет строк с полным расчётом. Исключённые строки и причины — на листе «Диагностика»."
    : reportNeedsReview || unresolvedActivities.size
      ? "Расчёт неполный. Ограничения расчёта — на листе «Диагностика»."
      : correctionBlocks.length ? "Возвраты показаны на листе «Корректировки»."
        : "За выбранный период продаж и возвратов не было");
  await finishSheet(workbook, main, signal, mainBlocks.some(block => block.branch.rows.length > 0)
    || reviewBlocks.some(block => block.branch.rows.length > 0));
  if (correctionBlocks.length) {
    const corrections = createDetailSheet("Корректировки", "Акции только с возвратами; суммы включены в общий итог сводки.");
    await writeStoreBlocks(corrections, correctionBlocks);
    totalRows(corrections, "ИТОГО корректировок по возвратам", branchTotals(correctionBlocks), includeIncomplete);
    await finishSheet(workbook, corrections, signal, correctionBlocks.some(block => block.branch.rows.length > 0));
  }

  const diagnostics = sheet(workbook, diagnosticsName, [18, 52, 45, 60, 64, 32, 85], []);
  topRows(diagnostics, "Диагностика исходных данных", note, [
    "Уровень", "Маркетинг", "Филиал", "Номенклатура / характеристика", "Контекст дат", "Код", "Сообщение"
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
    const label = `${activity.name} [${activity.key}]; номер документа: ${activity.number ?? unavailable}`;
    const dates = `Расчёт ${period(activity.from, activity.to)}; активность ${activityPeriod(activity)}; исходный интервал [${activity.from}, ${activity.to})`;
    addIssues(activity.issues.length ? activity.issues : [{
      code: "activity_context", message: "Идентификатор и период активности."
    }], "Маркетинг", label, null, null, dates);
    for (const branch of activity.branches) {
      const branchIdentity = `${branch.name} [${branch.key ?? unavailable}]`;
      addIssues(branch.issues, "Филиал", label, branchIdentity, null, dates);
      if (!branch.hasSales && !branch.hasReturns) addIssues([{
        code: excluded.has(branch) ? "no_movements" : "unresolved_movements",
        message: excluded.has(branch)
          ? "Блок исключён из сводки и детализации: за выбранный период продаж и возвратов не было."
          : "Блок включён в сводку и детализацию в раздел «Требует проверки»: отсутствие движений не подтверждено или не разрешены ограничения активности."
      }], "Филиал", label, branchIdentity, null, dates);
      else if (!branch.issues.length) addIssues([{
        code: "branch_context", message: `Продажи: ${branch.hasSales ? "есть" : "не отмечены"}; возвраты: ${branch.hasReturns ? "есть" : "не отмечены"}.`
      }], "Филиал", label, branchIdentity, null, dates);
      for (const item of branch.rows) {
        addIssues(item.issues.length ? item.issues : [rowContext], "Строка", label, branchIdentity,
        `${item.name} [${item.itemKey}]; характеристика: ${item.characteristicKey ?? unavailable}; штрихкод: ${item.barcode ?? unavailable}`,
        `Расчёт ${period(item.from, item.to)}; исходный интервал [${item.from}, ${item.to})`);
        if (++written % 256 === 0) await checkpoint();
      }
    }
  }
  for (const entry of report.excludedIncompleteDiagnostics ?? []) {
    const activity = entry.activity;
    const dates = entry.row ? `Расчёт ${period(entry.row.from, entry.row.to)}; исходный интервал [${entry.row.from}, ${entry.row.to})`
      : `Расчёт ${period(activity.from, activity.to)}; активность ${activityPeriod(activity)}`;
    addIssues(entry.issues, entry.row ? "Строка" : entry.branch ? "Филиал" : "Маркетинг",
      `${activity.name} [${activity.key}]; номер документа: ${activity.number ?? unavailable}`,
      entry.branch ? `${entry.branch.name} [${entry.branch.key ?? unavailable}]` : null,
      entry.row ? `${entry.row.name} [${entry.row.itemKey}]; характеристика: ${entry.row.characteristicKey ?? unavailable}; штрихкод: ${entry.row.barcode ?? unavailable}` : null,
      dates);
    if (++written % 256 === 0) await checkpoint();
  }
  diagnostics.autoFilter = { from: { row: 3, column: 1 }, to: { row: diagnosticsLastRow, column: 7 } };
  await finishSheet(workbook, diagnostics, signal);
}

export async function writeMarketingCompensationWorkbook(report: MarketingCompensationReport, output: Writable): Promise<void> {
  if (output.destroyed) throw new Error("Excel download was closed");
  report = projectCompensationReport(report);
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
