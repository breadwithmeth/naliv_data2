import ExcelJS from "exceljs";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import type { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import type { PresentationReport, PresentationReportBlock, PresentationSupplier, SupplierIncomeResidual } from "./presentation-report-types.js";
import type { ComparisonAggregate, ComparisonPeriod, DateWindow } from "./year-comparison.js";

const unavailable = "n/a";
const moneyFormat = '#,##0.00;[Red](#,##0.00);"–"';
const quantityFormat = '#,##0.###;[Red](#,##0.###);"–"';
const percentFormat = '0.0%;[Red](0.0%);"–"';
const integerFormat = '#,##0;[Red](#,##0);"–"';
const periodNames: Record<ComparisonPeriod, string> = { current: "Текущий", previous: "Предыдущий" };
const blockNames: Record<BlockKey, string> = { main: "Основной период", detail: "Дополнительный период" };
const presentationNames: Record<string, string> = {
  total: "Все товары и услуги — DISTINCT объединение",
  packaged: "Фасованные напитки",
  draught: "Разливные напитки",
  unclassified: "Напитки с неопределенным видом",
  other: "Прочие товары / услуги"
};
const reasonNames: Record<string, string> = {
  unique: "Единственный поставщик закупок того же окна",
  "multiple-suppliers": "Несколько поставщиков",
  "no-purchase": "Нет закупки в этом окне",
  "unknown-supplier": "Неизвестный поставщик закупки"
};
const costNames: Record<string, string> = {
  "live-store-register": "Регистр стоимости магазина",
  "store-cost-document": "Документ стоимости магазина",
  "global-cost-document": "Документ стоимости по сети",
  "purchase-90d": "Закупочная цена за 90 дней без записанного НДС",
  unavailable: "Цена отсутствует"
};

type BlockKey = "main" | "detail";
type StreamingWorksheet = ExcelJS.Worksheet & { commit(): void };
type Metrics = Pick<ComparisonAggregate,
  "quantity" | "revenue" | "estimatedGrossIncome" | "valuedCost" | "valuedRevenue" |
  "absoluteQuantity" | "unvaluedQuantity" | "receiptCount">;
type Group = { kind: ComparisonAggregate["groupKind"]; key: string; name: string };
type SalesContext = {
  block: PresentationReportBlock;
  sales: PresentationReportBlock["sales"];
  cities: Set<string>;
  metrics: (period: ComparisonPeriod, group: Group, cohort?: boolean) => Metrics | null;
  lookup: (period: ComparisonPeriod, scope: ComparisonAggregate["scope"], scopeKey: string,
    kind: ComparisonAggregate["groupKind"], key: string) => ComparisonAggregate | undefined;
  observed: (period: ComparisonPeriod) => boolean;
  rootGroups: Group[];
  categories: (kind: "packaged" | "draught") => Group[];
  cohortStores: PresentationReportBlock["sales"]["stores"];
};
type FormulaValue = number | null;

function windowLabel(window: DateWindow) {
  return `[${window.from}, ${window.to})`;
}

function worksheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, name: string, widths: number[], title: string, note: string) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", xSplit: 1, ySplit: 4 }],
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    // Do not set outlineProperties: ExcelJS emits outlinePr after pageSetUpPr,
    // which violates the sheetPr child order accepted by native Excel.
    properties: { defaultRowHeight: 21 }
  }) as StreamingWorksheet;
  sheet.columns = widths.map((width) => ({ width }));
  sheet.pageSetup.printTitlesRow = "1:4";
  sheet.headerFooter.oddFooter = "&LНалив — презентационный отчет&C&P / &N&R&D";
  sheet.mergeCells(1, 1, 1, widths.length);
  sheet.getCell("A1").value = title;
  sheet.getCell("A1").font = { name: "Calibri", size: 14, bold: true };
  sheet.getCell("A1").alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(1).height = 38;
  sheet.mergeCells(2, 1, 2, widths.length);
  sheet.getCell("A2").value = note;
  sheet.getCell("A2").alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(2).height = 48;
  return sheet;
}

function header(row: ExcelJS.Row) {
  row.height = 60;
  row.eachCell((cell) => {
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF24475B" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
}

function body(row: ExcelJS.Row, total = false) {
  row.eachCell((cell) => {
    cell.font = { name: "Calibri", size: 11, bold: total };
    cell.alignment = { vertical: "middle", wrapText: typeof cell.value === "string" };
    cell.border = { bottom: { style: "hair", color: { argb: "FFD9E2E8" } } };
    if (total) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE3EDF2" } };
  });
}

function formula(cell: ExcelJS.Cell, expression: string, result: FormulaValue) {
  cell.value = { formula: expression, result: result ?? unavailable };
}

function numeric(cell: ExcelJS.Cell): FormulaValue {
  const value = typeof cell.value === "number" ? cell.value : cell.result;
  return typeof value === "number" ? value : null;
}

function difference(row: ExcelJS.Row, destination: number, previous: number, current: number, relative = false) {
  const p = row.getCell(previous);
  const c = row.getCell(current);
  const old = numeric(p);
  const next = numeric(c);
  const result = old !== null && next !== null && (!relative || old !== 0)
    ? relative ? next / old - 1 : next - old : null;
  formula(row.getCell(destination),
    `IF(AND(ISNUMBER(${p.address}),ISNUMBER(${c.address})${relative ? `,${p.address}<>0` : ""}),${c.address}${relative ? "/" : "-"}${p.address}${relative ? "-1" : ""},"n/a")`, result);
}

function ratio(row: ExcelJS.Row, destination: number, numerator: number, denominator: number) {
  const n = row.getCell(numerator);
  const d = row.getCell(denominator);
  const value = numeric(n);
  const base = numeric(d);
  formula(row.getCell(destination), `IF(AND(ISNUMBER(${n.address}),ISNUMBER(${d.address}),${d.address}<>0),${n.address}/${d.address},"n/a")`,
    value !== null && base !== null && base !== 0 ? value / base : null);
}

function visibleSum(row: ExcelJS.Row, column: number, first: number, last: number, result: FormulaValue) {
  if (last < first) {
    row.getCell(column).value = unavailable;
    return;
  }
  const letter = row.getCell(column).address.replace(/\d+$/, "");
  const range = `${letter}${first}:${letter}${last}`;
  // COUNTA includes the explicit n/a text; COUNT does not. A visible unknown
  // must invalidate the total, rather than silently contributing zero to SUM.
  formula(row.getCell(column),
    `IF(AND(SUBTOTAL(103,${range})>0,SUBTOTAL(102,${range})=SUBTOTAL(103,${range})),SUBTOTAL(109,${range}),"n/a")`, result);
}

function nullableSum<T>(values: T[], value: (item: T) => number | null): FormulaValue {
  let sum = 0;
  for (const item of values) {
    const amount = value(item);
    if (amount === null) return null;
    sum += amount;
  }
  return values.length ? sum : null;
}

function zeroMetrics(): Metrics {
  return { quantity: 0, revenue: 0, estimatedGrossIncome: 0, valuedCost: 0, valuedRevenue: 0,
    absoluteQuantity: 0, unvaluedQuantity: 0, receiptCount: 0 };
}

function combineMetrics(values: Metrics[], disjointReceipts = true): Metrics {
  const result = zeroMetrics();
  for (const value of values) {
    result.quantity += value.quantity;
    result.revenue += value.revenue;
    result.valuedCost += value.valuedCost;
    result.valuedRevenue += value.valuedRevenue;
    result.absoluteQuantity += value.absoluteQuantity;
    result.unvaluedQuantity += value.unvaluedQuantity;
    if (disjointReceipts) result.receiptCount += value.receiptCount;
    if (result.estimatedGrossIncome !== null) {
      result.estimatedGrossIncome = value.estimatedGrossIncome === null ? null : result.estimatedGrossIncome + value.estimatedGrossIncome;
    }
  }
  if (result.unvaluedQuantity > 0.000000001) result.estimatedGrossIncome = null;
  return result;
}

function salesContext(block: PresentationReportBlock, cities: Set<string>): SalesContext {
  const sales = block.sales;
  const aggregates = new Map<string, ComparisonAggregate>();
  for (const value of sales.aggregates) {
    aggregates.set(JSON.stringify([value.period, value.scope, value.scopeKey, value.groupKind, value.groupKey]), value);
  }
  const lookup = (period: ComparisonPeriod, scope: ComparisonAggregate["scope"], scopeKey: string, kind: ComparisonAggregate["groupKind"], key: string) =>
    aggregates.get(JSON.stringify([period, scope, scopeKey, kind, key]));
  const selected = new Set(sales.cohort.selectedStoreKeys);
  const stores = sales.stores.filter((store) => (!cities.size || cities.has(store.city)) && selected.has(store.key));
  const observed = (period: ComparisonPeriod) => sales.coverage.some((value) => value.period === period && value.status !== "empty");
  const metrics = (period: ComparisonPeriod, group: Group, cohort = false): Metrics | null => {
    if (!observed(period) || (cohort && !stores.length)) return null;
    if (cohort) {
      // Physical stores are disjoint receipt sets; categories are not.
      return combineMetrics(stores.map((store) => lookup(period, "store", store.key, group.kind, group.key) ?? zeroMetrics()));
    }
    if (!cities.size) return lookup(period, "all", "all", group.kind, group.key) ?? zeroMetrics();
    return combineMetrics([...cities].map((city) => lookup(period, "city", city, group.kind, group.key) ?? zeroMetrics()));
  };
  const roots = new Map<string, string>();
  for (const item of sales.dataQuality.taxonomy) roots.set(item.rootKey, item.rootName);
  for (const value of sales.aggregates) if (value.groupKind === "root" && !roots.has(value.groupKey)) roots.set(value.groupKey, value.groupKey);
  const rootGroups: Group[] = [...roots].map<Group>(([key, name]) => ({ kind: "root", key, name })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const categories = (kind: "packaged" | "draught"): Group[] => {
    const names = new Map<string, string>();
    for (const item of sales.dataQuality.taxonomy) {
      if (item.presentationKind === kind && item.presentationCategoryKey) {
        names.set(`${kind}:category:${item.presentationCategoryKey}`, item.presentationCategoryName ?? item.rootName);
      }
    }
    for (const value of sales.aggregates) {
      if (value.groupKind === "presentation" && value.groupKey.startsWith(`${kind}:category:`) && !names.has(value.groupKey)) names.set(value.groupKey, value.groupKey);
    }
    return [...names].map<Group>(([key, name]) => ({ kind: "presentation", key, name })).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  };
  return { block, sales, cities, metrics, lookup, observed, rootGroups, categories, cohortStores: stores };
}

const salesHeaders = [
  "Подкатегория / корневая группа", "Количество текущее, учетные ед.", "Выручка текущая, KZT с НДС",
  "Δ количества, учетные ед.", "Δ выручки, KZT", "Сопоставимая сеть: количество, Δ %", "Сопоставимая сеть: выручка, Δ %",
  "ВД текущий, ОЦЕНКА KZT", "ВД / выручка, %", "Δ ВД, KZT", "Δ ВД, %", "Сопоставимая сеть: Δ чеков DISTINCT",
  "Количество предыдущее, учетные ед.", "Выручка предыдущая, KZT с НДС", "ВД предыдущий, ОЦЕНКА KZT", "Выручка всей выборки, Δ %",
  "Чеки текущие DISTINCT", "Чеки предыдущие DISTINCT", "Чеки всей выборки, Δ %",
  "Сеть: количество текущее", "Сеть: количество предыдущее", "Сеть: выручка текущая", "Сеть: выручка предыдущая",
  "Сеть: ВД текущий, ОЦЕНКА", "Сеть: ВД предыдущий, ОЦЕНКА", "Сеть: ВД, Δ %",
  "Сеть: чеки текущие DISTINCT", "Сеть: чеки предыдущие DISTINCT", "Сеть: чеки, Δ %",
  "Известная часть ВД текущего, не полный ВД", "Количество без стоимости, абсолютное", "Доля оцененного абсолютного количества"
];

function salesRow(sheet: StreamingWorksheet, label: string, previous: Metrics | null, current: Metrics | null,
  cohortPrevious: Metrics | null, cohortCurrent: Metrics | null, total = false) {
  const row = sheet.addRow([
    label, current?.quantity ?? unavailable, current?.revenue ?? unavailable, null, null, null, null,
    current?.estimatedGrossIncome ?? unavailable, null, null, null, null,
    previous?.quantity ?? unavailable, previous?.revenue ?? unavailable, previous?.estimatedGrossIncome ?? unavailable, null,
    current?.receiptCount ?? unavailable, previous?.receiptCount ?? unavailable, null,
    cohortCurrent?.quantity ?? unavailable, cohortPrevious?.quantity ?? unavailable,
    cohortCurrent?.revenue ?? unavailable, cohortPrevious?.revenue ?? unavailable,
    cohortCurrent?.estimatedGrossIncome ?? unavailable, cohortPrevious?.estimatedGrossIncome ?? unavailable, null,
    cohortCurrent?.receiptCount ?? unavailable, cohortPrevious?.receiptCount ?? unavailable, null,
    current ? current.valuedRevenue - current.valuedCost : unavailable, current?.unvaluedQuantity ?? unavailable,
    current && current.absoluteQuantity !== 0 ? 1 - current.unvaluedQuantity / current.absoluteQuantity : unavailable
  ]);
  salesFormulas(row);
  body(row, total);
  for (const column of [2, 4, 13, 20, 21, 31]) row.getCell(column).numFmt = quantityFormat;
  for (const column of [3, 5, 8, 10, 14, 15, 22, 23, 24, 25, 30]) row.getCell(column).numFmt = moneyFormat;
  for (const column of [6, 7, 9, 11, 16, 19, 26, 29, 32]) row.getCell(column).numFmt = percentFormat;
  for (const column of [12, 17, 18, 27, 28]) row.getCell(column).numFmt = integerFormat;
  return row;
}

function salesFormulas(row: ExcelJS.Row) {
  for (const [destination, previous, current, relative] of [
    [4, 13, 2, false], [5, 14, 3, false], [6, 21, 20, true], [7, 23, 22, true],
    [10, 15, 8, false], [11, 15, 8, true], [12, 28, 27, false], [16, 14, 3, true],
    [19, 18, 17, true], [26, 25, 24, true], [29, 28, 27, true]
  ] as const) difference(row, destination, previous, current, relative);
  ratio(row, 9, 8, 3);
}

function addSalesSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, name: string, context: SalesContext,
  groups: Group[], caption: string, cityCaption: string, fixedGroups: Group[]) {
  const { sales } = context;
  const sheet = worksheet(workbook, name, [49, ...Array<number>(31).fill(21)], caption,
    `Текущий ${windowLabel(sales.periods.current)}; предыдущий ${windowLabel(sales.periods.previous)}. Города: ${cityCaption}. Количество — смешанные учетные единицы, не штуки. ВД — оценка, не бухгалтерская прибыль.`);
  sheet.mergeCells("A3:AF3");
  sheet.getCell("A3").value = "Итог видимых строк пересчитывает финансовые величины при фильтре; чеки категорий НЕ складываются. Ниже отдельно — фиксированные DISTINCT объединения, не зависящие от фильтра категорий. Сопоставимая сеть определяется независимо для каждого периода отчета.";
  sheet.getCell("A3").alignment = { wrapText: true };
  sheet.getRow(3).height = 44;
  sheet.getRow(4).values = salesHeaders;
  header(sheet.getRow(4));
  const previous: Metrics[] = [];
  const current: Metrics[] = [];
  const cohortPrevious: Metrics[] = [];
  const cohortCurrent: Metrics[] = [];
  for (const group of groups) {
    const p = context.metrics("previous", group);
    const c = context.metrics("current", group);
    const cp = context.metrics("previous", group, true);
    const cc = context.metrics("current", group, true);
    if (p) previous.push(p);
    if (c) current.push(c);
    if (cp) cohortPrevious.push(cp);
    if (cc) cohortCurrent.push(cc);
    salesRow(sheet, group.name, p, c, cp, cc).commit();
  }
  const last = 4 + groups.length;
  sheet.autoFilter = { from: "A4", to: `AF${Math.max(4, last)}` };
  const total = salesRow(sheet, "ИТОГО ВИДИМЫХ СТРОК — без суммы чеков",
    previous.length ? combineMetrics(previous, false) : null, current.length ? combineMetrics(current, false) : null,
    cohortPrevious.length ? combineMetrics(cohortPrevious, false) : null, cohortCurrent.length ? combineMetrics(cohortCurrent, false) : null, true);
  for (const column of [2, 3, 8, 13, 14, 15, 20, 21, 22, 23, 24, 25, 30, 31]) {
    visibleSum(total, column, 5, last, numeric(total.getCell(column)));
  }
  for (const column of [12, 17, 18, 19, 27, 28, 29, 32]) total.getCell(column).value = unavailable;
  salesFormulas(total);
  total.commit();
  sheet.addRow([]).commit();
  for (const group of fixedGroups) {
    salesRow(sheet, `ФИКСИРОВАНО: ${group.name}`, context.metrics("previous", group), context.metrics("current", group),
      context.metrics("previous", group, true), context.metrics("current", group, true), true).commit();
  }
  sheet.commit();
}

function addShareSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, name: string, context: SalesContext, cityCaption: string) {
  const sheet = worksheet(workbook, name, [26, 49, 22, 24, 24, 20, 20, 20, 24, 24, 24, 24],
    `Доли всех корневых групп — ${windowLabel(context.sales.periods.current)}`,
    `Города: ${cityCaption}. Все корни, включая прочие и несопоставленные. Доли числовые, доступны числовые фильтры. Знаменатель фиксирован: все корни соответствующего города; фильтр строк его не меняет. ВД — оценка.`);
  sheet.mergeCells("A3:L3");
  sheet.getCell("A3").value = "Итог видимых долей — сумма долей выбранных строк с фиксированными городскими знаменателями; между городами это не единая доля сети. Неизвестный ВД любой видимой строки делает видимый итог ВД n/a. Чеки категорий не складываются.";
  sheet.getCell("A3").alignment = { wrapText: true };
  sheet.getRow(3).height = 42;
  sheet.getRow(4).values = ["Город", "Корневая группа", "Количество, учетные ед.", "Выручка, KZT с НДС", "ВД, ОЦЕНКА KZT", "Доля количества", "Доля выручки", "Доля ВД", "Известная часть ВД, не полный ВД", "Знаменатель количества города", "Знаменатель выручки города", "Знаменатель ВД города, ОЦЕНКА"];
  header(sheet.getRow(4));
  const cities = [...new Set(context.sales.stores.map((store) => store.city))].sort((a, b) => a.localeCompare(b, "ru"));
  const totals = { quantity: 0, revenue: 0, income: 0 as number | null, knownIncome: 0, quantityShare: 0 as number | null, revenueShare: 0 as number | null, incomeShare: 0 as number | null };
  let rows = 0;
  for (const city of cities) {
    if (context.cities.size && !context.cities.has(city)) continue;
    const cityValues = context.rootGroups.map((group) => context.lookup("current", "city", city, group.kind, group.key) ?? zeroMetrics());
    const cityTotal = context.observed("current") ? context.lookup("current", "city", city, "presentation", "total") ?? zeroMetrics() : null;
    for (const [index, group] of context.rootGroups.entries()) {
      const value = context.observed("current") ? cityValues[index] : null;
      const row = sheet.addRow([city, group.name, value?.quantity ?? unavailable, value?.revenue ?? unavailable,
        value?.estimatedGrossIncome ?? unavailable, null, null, null,
        value ? value.valuedRevenue - value.valuedCost : unavailable,
        cityTotal?.quantity ?? unavailable, cityTotal?.revenue ?? unavailable, cityTotal?.estimatedGrossIncome ?? unavailable]);
      for (const [destination, numerator, denominator] of [[6, 3, 10], [7, 4, 11], [8, 5, 12]] as const) ratio(row, destination, numerator, denominator);
      body(row);
      for (const column of [3, 10]) row.getCell(column).numFmt = quantityFormat;
      for (const column of [4, 5, 9, 11, 12]) row.getCell(column).numFmt = moneyFormat;
      for (const column of [6, 7, 8]) row.getCell(column).numFmt = percentFormat;
      totals.quantity += value?.quantity ?? 0;
      totals.revenue += value?.revenue ?? 0;
      totals.knownIncome += value ? value.valuedRevenue - value.valuedCost : 0;
      if (!value || value.estimatedGrossIncome === null) totals.income = null;
      else if (totals.income !== null) totals.income += value.estimatedGrossIncome;
      for (const [key, column] of [["quantityShare", 6], ["revenueShare", 7], ["incomeShare", 8]] as const) {
        const share = numeric(row.getCell(column));
        if (share === null) totals[key] = null;
        else if (totals[key] !== null) totals[key] += share;
      }
      row.commit();
      rows++;
    }
  }
  const last = 4 + rows;
  sheet.autoFilter = { from: "A4", to: `L${Math.max(4, last)}` };
  const total = sheet.addRow(["ИТОГО ВИДИМЫХ", "Доли = сумма городских долей, НЕ доля сети"]);
  for (const [column, result] of [[3, totals.quantity], [4, totals.revenue], [5, totals.income], [6, totals.quantityShare], [7, totals.revenueShare], [8, totals.incomeShare], [9, totals.knownIncome]] as const) {
    visibleSum(total, column, 5, last, context.observed("current") ? result : null);
    total.getCell(column).numFmt = column >= 6 && column <= 8 ? percentFormat : column === 3 ? quantityFormat : moneyFormat;
  }
  body(total, true);
  total.commit();
  sheet.commit();
}


function addSupplierSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, name: string, block: PresentationReportBlock, cities: Set<string>, cityCaption: string) {
  const sheet = worksheet(workbook, name, [26, 49, 42, 20, ...Array<number>(25).fill(23)],
    `Все поставщики — ${windowLabel(block.sales.periods.current)} против ${windowLabel(block.sales.periods.previous)}`,
    `Города: ${cityCaption}. Закупки фактические: суммы заголовков поступлений минус возвраты поставщику. Город закупок — приемный магазин/склад; город моделируемого ВД — магазин продажи. ВД — только распределенная часть модели, НЕ весь ВД поставщика.`);
  sheet.mergeCells("A3:AC3");
  sheet.getCell("A3").value = "Фильтруйте город и числовую долю закупок. Доля = нетто закупки поставщика / фиксированные нетто закупки ВСЕХ поставщиков того же города и окна (при возвратах возможны отрицательные доли). Итог ниже — только видимые строки. Неизвестный видимый ВД НЕ становится нулем. Внутренний ИНН только помечен, не исключен.";
  sheet.getCell("A3").alignment = { wrapText: true };
  sheet.getRow(3).height = 48;
  sheet.getRow(4).values = [
    "Город", "Поставщик", "Ключ поставщика", "Внутренний по ИНН: флаг", "Поступления текущие, KZT", "Возвраты текущие, KZT", "Закупки нетто текущие, KZT", "Доля закупок города, %",
    "Закупки нетто предыдущие, KZT", "Δ закупок, KZT", "Δ закупок, %", "Распределенный ВД текущий, ОЦЕНКА", "Распределенный ВД предыдущий, ОЦЕНКА", "Δ распределенного ВД, KZT", "Δ распределенного ВД, %",
    "Сеть: закупки текущие", "Сеть: закупки предыдущие", "Сеть: закупки, Δ %", "Сеть: распределенный ВД текущий", "Сеть: распределенный ВД предыдущий", "Сеть: распределенный ВД, Δ %",
    "Выручка продаж, отнесенная моделью", "Известная часть распределенного ВД, не полный ВД", "Неоцененное абсолютное количество продаж", "Поступлений документов", "Возвратов документов",
    "Фиксированный знаменатель закупок города", "Поступления предыдущие, KZT", "Возвраты предыдущие, KZT"
  ];
  header(sheet.getRow(4));
  const current = new Map<string, PresentationSupplier>();
  const previous = new Map<string, PresentationSupplier>();
  const pairs = new Map<string, PresentationSupplier>();
  const denominators = new Map<string, number | null>();
  for (const supplier of block.suppliers) {
    if (cities.size && !cities.has(supplier.city)) continue;
    const key = JSON.stringify([supplier.city, supplier.supplierKey]);
    (supplier.period === "current" ? current : previous).set(key, supplier);
    pairs.set(key, supplier);
    if (supplier.period === "current") {
      const existing = denominators.get(supplier.city);
      denominators.set(supplier.city, supplier.purchases === null || existing === null ? null : (existing ?? 0) + supplier.purchases);
    }
  }
  const purchaseCurrent = block.purchasingQuality.some((value) => value.period === "current" && value.status !== "empty");
  const purchasePrevious = block.purchasingQuality.some((value) => value.period === "previous" && value.status !== "empty");
  const salesCurrent = block.sales.coverage.some((value) => value.period === "current" && value.status !== "empty");
  const salesPrevious = block.sales.coverage.some((value) => value.period === "previous" && value.status !== "empty");
  const cohort = block.sales.stores.some((store) => block.sales.cohort.selectedStoreKeys.includes(store.key) && (!cities.size || cities.has(store.city)));
  const cache: (number | null)[] = Array<number | null>(30).fill(0);
  let rows = 0;
  for (const [key, supplier] of [...pairs].sort((a, b) => a[1].city.localeCompare(b[1].city, "ru") || a[1].supplierName.localeCompare(b[1].supplierName, "ru") || a[1].supplierKey.localeCompare(b[1].supplierKey))) {
    const c = current.get(key);
    const p = previous.get(key);
    const purchasing = (value: PresentationSupplier | undefined, period: ComparisonPeriod, field: "receiptAmount" | "returnAmount" | "purchases" | "receiptDocuments" | "returnDocuments") =>
      (period === "current" ? purchaseCurrent : purchasePrevious) ? value ? value[field] ?? unavailable : 0 : unavailable;
    const income = (value: PresentationSupplier | undefined, observed: boolean, field: "estimatedGrossIncome" | "salesRevenue" | "knownEstimatedGrossIncome" | "unvaluedQuantity") =>
      observed ? value ? value[field] ?? unavailable : 0 : unavailable;
    const cohortValue = (value: PresentationSupplier | undefined, observed: boolean, field: "cohortPurchases" | "cohortEstimatedGrossIncome") =>
      cohort && observed ? value ? value[field] ?? unavailable : 0 : unavailable;
    const row = sheet.addRow([
      supplier.city, supplier.supplierName, supplier.supplierKey, supplier.internalByTaxId ? "Да — не исключен" : "Нет",
      purchasing(c, "current", "receiptAmount"), purchasing(c, "current", "returnAmount"), purchasing(c, "current", "purchases"), null,
      purchasing(p, "previous", "purchases"), null, null,
      income(c, salesCurrent, "estimatedGrossIncome"), income(p, salesPrevious, "estimatedGrossIncome"), null, null,
      cohortValue(c, purchaseCurrent, "cohortPurchases"), cohortValue(p, purchasePrevious, "cohortPurchases"), null,
      cohortValue(c, salesCurrent, "cohortEstimatedGrossIncome"), cohortValue(p, salesPrevious, "cohortEstimatedGrossIncome"), null,
      income(c, salesCurrent, "salesRevenue"), income(c, salesCurrent, "knownEstimatedGrossIncome"), income(c, salesCurrent, "unvaluedQuantity"),
      purchasing(c, "current", "receiptDocuments"), purchasing(c, "current", "returnDocuments"),
      purchaseCurrent ? denominators.has(supplier.city) ? denominators.get(supplier.city) ?? unavailable : 0 : unavailable,
      purchasing(p, "previous", "receiptAmount"), purchasing(p, "previous", "returnAmount")
    ]);
    // Amounts remain factual snapshot values; ratio/change formulas retain cached results.
    ratio(row, 8, 7, 27);
    for (const [destination, old, next, relative] of [[10, 9, 7, false], [11, 9, 7, true], [14, 13, 12, false], [15, 13, 12, true], [18, 17, 16, true], [21, 20, 19, true]] as const) difference(row, destination, old, next, relative);
    body(row);
    for (let column = 5; column <= 29; column++) {
      row.getCell(column).numFmt = [8, 11, 15, 18, 21].includes(column) ? percentFormat : [25, 26].includes(column) ? integerFormat : column === 24 ? quantityFormat : moneyFormat;
      const value = numeric(row.getCell(column));
      const cached = cache[column];
      if (value === null) cache[column] = null;
      else if (cached !== null) cache[column] = cached + value;
    }
    row.commit();
    rows++;
  }
  const last = 4 + rows;
  sheet.autoFilter = { from: "A4", to: `AC${Math.max(4, last)}` };
  const total = sheet.addRow(["ИТОГО ВИДИМЫХ", "Доля: сумма долей с фиксированными городскими знаменателями, НЕ доля сети"]);
  for (const column of [5, 6, 7, 8, 9, 12, 13, 16, 17, 19, 20, 22, 23, 24, 25, 26, 28, 29]) visibleSum(total, column, 5, last, cache[column]);
  for (const [destination, old, next, relative] of [[10, 9, 7, false], [11, 9, 7, true], [14, 13, 12, false], [15, 13, 12, true], [18, 17, 16, true], [21, 20, 19, true]] as const) difference(total, destination, old, next, relative);
  for (let column = 5; column <= 29; column++) total.getCell(column).numFmt = [8, 11, 15, 18, 21].includes(column) ? percentFormat : [25, 26].includes(column) ? integerFormat : column === 24 ? quantityFormat : moneyFormat;
  body(total, true);
  total.commit();
  sheet.commit();
}

function addResidualSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, report: PresentationReport, cities: Set<string>, cityCaption: string) {
  const sheet = worksheet(workbook, "Нераспределенный доход", [26, 34, 31, 47, 24, 24, 26, 24, 24, 20], "Остаток дохода без поставщика — отдельный компонент модели",
    `Города: ${cityCaption}. Это НЕ закупочный поставщик и НЕ фиктивные закупки. Причина относится к паре исходный магазин × товар в том же окне. Неизвестная стоимость остается n/a; известная часть показана отдельно.`);
  sheet.mergeCells("A3:J3");
  sheet.getCell("A3").value = "Ниже четыре независимых видимых итога: основной/дополнительный × текущий/предыдущий. Пересекающиеся окна НЕ складываются. При наблюдаемых продажах отсутствие остатка означает настоящий ноль; отсутствие истории — n/a.";
  sheet.getCell("A3").alignment = { wrapText: true };
  sheet.getRow(3).height = 42;
  sheet.getRow(4).values = ["Период отчета", "Окно", "Город продажи", "Причина нераспределения", "Нетто выручка с НДС", "ВД, ОЦЕНКА KZT", "Известная часть ВД, не полный ВД", "Абсолютное количество", "Количество без стоимости", "Пар магазин × товар"];
  header(sheet.getRow(4));
  const totals: { blockKey: BlockKey; period: ComparisonPeriod; first: number; last: number; values: SupplierIncomeResidual[] }[] = [];
  let rowNumber = 4;
  for (const blockKey of ["main", "detail"] as const) {
    const block = report[blockKey];
    for (const period of ["current", "previous"] as const) {
      const values = block.residual.filter((value) => value.period === period && (!cities.size || cities.has(value.city)));
      const first = rowNumber + 1;
      for (const value of values) {
        const row = sheet.addRow([blockNames[blockKey], `${periodNames[period]} ${windowLabel(block.sales.periods[period])}`, value.city,
          reasonNames[value.reason], value.salesRevenue, value.estimatedGrossIncome ?? unavailable, value.knownEstimatedGrossIncome,
          value.absoluteQuantity, value.unvaluedQuantity, value.pairCount]);
        body(row);
        for (const column of [5, 6, 7]) row.getCell(column).numFmt = moneyFormat;
        for (const column of [8, 9]) row.getCell(column).numFmt = quantityFormat;
        row.getCell(10).numFmt = integerFormat;
        row.commit();
        rowNumber++;
      }
      totals.push({ blockKey, period, first, last: rowNumber, values });
    }
  }
  sheet.autoFilter = { from: "A4", to: `J${Math.max(4, rowNumber)}` };
  for (const value of totals) {
    const block = report[value.blockKey];
    const observed = block.sales.coverage.some((coverage) => coverage.period === value.period && coverage.status !== "empty");
    const total = sheet.addRow([`ВИДИМЫЙ ИТОГ: ${blockNames[value.blockKey]}`, `${periodNames[value.period]} ${windowLabel(block.sales.periods[value.period])}`]);
    for (const [column, getter] of [
      [5, (item: SupplierIncomeResidual) => item.salesRevenue], [6, (item: SupplierIncomeResidual) => item.estimatedGrossIncome],
      [7, (item: SupplierIncomeResidual) => item.knownEstimatedGrossIncome], [8, (item: SupplierIncomeResidual) => item.absoluteQuantity],
      [9, (item: SupplierIncomeResidual) => item.unvaluedQuantity], [10, (item: SupplierIncomeResidual) => item.pairCount]
    ] as const) {
      if (value.values.length) visibleSum(total, column, value.first, value.last, nullableSum(value.values, getter));
      else total.getCell(column).value = observed ? 0 : unavailable;
      total.getCell(column).numFmt = column === 10 ? integerFormat : column >= 8 ? quantityFormat : moneyFormat;
    }
    body(total, true);
    total.commit();
  }
  sheet.commit();
}

export async function writePresentationReportWorkbook(report: PresentationReport, output: Writable) {
  if (output.destroyed) throw new Error("Excel download was closed");
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: true, zip: { zlib: { level: 9 } } });
  const archive = (workbook as ExcelJS.stream.xlsx.WorkbookWriter & { zip: EventEmitter & { abort(): void } }).zip;
  const canceled = new AbortController();
  const onError = (error: Error) => canceled.abort(error);
  const onClose = () => { if (!output.writableFinished) canceled.abort(new Error("Excel download was closed")); };
  output.once("error", onError);
  output.once("close", onClose);
  archive.once("error", onError);
  const interrupted = once(canceled.signal, "abort");
  const checkpoint = async (row: number) => {
    if (row % 256 !== 0) return;
    await setImmediate();
    if (canceled.signal.aborted) throw canceled.signal.reason;
    if (output.writableNeedDrain) await Promise.race([once(output, "drain"), interrupted]);
    if (canceled.signal.aborted) throw canceled.signal.reason;
  };
  try {
    workbook.creator = "Налив — аналитика";
    workbook.created = new Date(report.generatedAt);
    workbook.modified = workbook.created;
    const cities = new Set(report.params.city);
    const cityCaption = cities.size ? [...cities].join(", ") : "Все города";
    const contexts: Record<BlockKey, SalesContext> = { main: salesContext(report.main, cities), detail: salesContext(report.detail, cities) };
    addOverview(workbook, report, contexts, cityCaption);
    const presentationTotal: Group = { kind: "presentation", key: "total", name: presentationNames.total };
    const packaged: Group = { kind: "presentation", key: "packaged", name: presentationNames.packaged };
    const draught: Group = { kind: "presentation", key: "draught", name: presentationNames.draught };
    const unclassified: Group = { kind: "presentation", key: "unclassified", name: presentationNames.unclassified };
    addSalesSheet(workbook, "Основной — все категории", contexts.main, contexts.main.rootGroups, "Основной период — все корневые категории", cityCaption, [presentationTotal, unclassified]);
    addSalesSheet(workbook, "Доп — фасованные", contexts.detail, contexts.detail.categories("packaged"), "Дополнительный период — фасованные напитки, все подкатегории", cityCaption, [packaged]);
    addSalesSheet(workbook, "Доп — разливные", contexts.detail, contexts.detail.categories("draught"), "Дополнительный период — разливные напитки, все подкатегории", cityCaption, [draught]);
    addSalesSheet(workbook, "Доп — итоги категорий", contexts.detail, contexts.detail.rootGroups, "Дополнительный период — все корни и DISTINCT итог презентации", cityCaption, [presentationTotal, packaged, draught, unclassified]);
    addShareSheet(workbook, "Доли — основной", contexts.main, cityCaption);
    addShareSheet(workbook, "Доли — дополнительный", contexts.detail, cityCaption);
    addSupplierSheet(workbook, "Поставщики — основной", report.main, cities, cityCaption);
    addSupplierSheet(workbook, "Поставщики — доп", report.detail, cities, cityCaption);
    addResidualSheet(workbook, report, cities, cityCaption);
    addDeclines(workbook, report, contexts, cities);
    addTasks(workbook, report);
    addMethodology(workbook, report, cityCaption);
    addQuality(workbook, report);
    await addAudits(workbook, report, checkpoint);
    await Promise.race([workbook.commit(), interrupted]);
    if (canceled.signal.aborted) throw canceled.signal.reason;
  } catch (error) {
    archive.abort();
    output.destroy();
    throw error;
  } finally {
    output.off("error", onError);
    output.off("close", onClose);
    archive.off("error", onError);
    canceled.abort();
  }
}

function addOverview(workbook: ExcelJS.stream.xlsx.WorkbookWriter, report: PresentationReport, contexts: Record<BlockKey, SalesContext>, cityCaption: string) {
  const sheet = worksheet(workbook, "Обзор и настройки", [28, 24, 27, 27, 18, 19, 21, 28, 28, 90],
    "Итоги выбранных периодов — отдельный презентационный отчет",
    `Основной ${windowLabel(report.main.sales.periods.current)} против ${windowLabel(report.main.sales.periods.previous)}; дополнительный ${windowLabel(report.detail.sales.periods.current)} против ${windowLabel(report.detail.sales.periods.previous)}. Города: ${cityCaption}. Правая дата исключена.`);
  sheet.mergeCells("A3:J3");
  sheet.getCell("A3").value = `Снимок UTC: ${report.generatedAt}. Параметры: from=${report.params.from}; to=${report.params.to}; monthFrom=${report.params.monthFrom}; monthTo=${report.params.monthTo}; city=${cityCaption}. Для изменения периодов/городов сформируйте новый экспорт; Excel-фильтры меняют только видимые строки.`;
  sheet.getCell("A3").alignment = { wrapText: true };
  sheet.getRow(3).height = 46;
  sheet.getRow(4).values = ["Период отчета", "Окно", "Начало включено", "Конец исключен", "Статус истории", "Дней с чеками", "Дней календаря", "Первая дата чеков", "Последняя дата чеков", "ЯВНОЕ ПРЕДУПРЕЖДЕНИЕ — покрытие всей сети, не доказательство полноты"];
  header(sheet.getRow(4));
  for (const blockKey of ["main", "detail"] as const) {
    const block = report[blockKey];
    for (const period of ["current", "previous"] as const) {
      const coverage = block.sales.coverage.find((value) => value.period === period);
      const window = block.sales.periods[period];
      const status = coverage?.status ?? "empty";
      const warning = status === "empty"
        ? "Истории подходящих чеков в этом окне нет. Выручка, количество, ВД и сравнения этого окна — n/a, НЕ ноль. Отчет текущего окна остается доступен."
        : status === "partial"
          ? `Покрытие неполное: ${coverage!.coveredDays}/${coverage!.expectedDays} календарных дней с чеками. Суммы относятся только к наблюдаемым документам; пропущенные даты перечислены в качестве данных.`
          : `Наблюдаются чеки в ${coverage!.coveredDays}/${coverage!.expectedDays} днях. Это НЕ доказательство полноты загрузки документов.`;
      const row = sheet.addRow([blockNames[blockKey], periodNames[period], window.from, window.to, status === "empty" ? "Нет истории" : status === "partial" ? "Неполное" : "Наблюдаемое",
        coverage?.coveredDays ?? 0, coverage?.expectedDays ?? (Date.parse(window.to) - Date.parse(window.from)) / 86_400_000,
        coverage?.dateFrom ?? unavailable, coverage?.dateTo ?? unavailable, warning]);
      row.height = 70;
      body(row);
      row.getCell(10).alignment = { wrapText: true, vertical: "middle" };
      if (status !== "observed") row.getCell(10).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE6B5" } };
      row.commit();
    }
  }
  sheet.addRow([]).commit();
  const headline = sheet.addRow(["Выборка продаж", "Окно", "Количество, учетные ед.", "Выручка, KZT с НДС", "ВД, ОЦЕНКА KZT", "Известная часть ВД", "Чеки DISTINCT", "Сопоставимых точек", "Неоцененное абсолютное количество", "Комментарий"]);
  header(headline);
  const totalGroup: Group = { kind: "presentation", key: "total", name: presentationNames.total };
  for (const blockKey of ["main", "detail"] as const) {
    const context = contexts[blockKey];
    for (const period of ["current", "previous"] as const) {
      const value = context.metrics(period, totalGroup);
      const row = sheet.addRow([blockNames[blockKey], `${periodNames[period]} ${windowLabel(context.sales.periods[period])}`,
        value?.quantity ?? unavailable, value?.revenue ?? unavailable, value?.estimatedGrossIncome ?? unavailable,
        value ? value.valuedRevenue - value.valuedCost : unavailable, value?.receiptCount ?? unavailable, context.cohortStores.length,
        value?.unvaluedQuantity ?? unavailable,
        context.cohortStores.length ? "Автоматическая сеть: положительные продажи в обоих окнах. ВД — оценочный, не историческая себестоимость." : "Сопоставимая сеть пуста: ее показатели и сравнения n/a. Нет оснований объявлять это нулевым ростом или падением."]);
      body(row, true);
      for (const column of [3, 9]) row.getCell(column).numFmt = quantityFormat;
      for (const column of [4, 5, 6]) row.getCell(column).numFmt = moneyFormat;
      row.height = 65;
      row.commit();
    }
  }
  sheet.addRow([]).commit();
  const allocationHeader = sheet.addRow(["Модель поставщиков", "Окно", "Закупки нетто, KZT", "Отнесенная выручка", "Отнесенный ВД, ОЦЕНКА", "Остаток выручки", "Остаток ВД, ОЦЕНКА", "Доля отнесенной выручки", "Известная часть ВД модели", "Ограничение"]);
  header(allocationHeader);
  for (const blockKey of ["main", "detail"] as const) {
    const block = report[blockKey];
    for (const period of ["current", "previous"] as const) {
      const suppliers = block.suppliers.filter((value) => value.period === period && (!contexts[blockKey].cities.size || contexts[blockKey].cities.has(value.city)));
      const residual = block.residual.filter((value) => value.period === period && (!contexts[blockKey].cities.size || contexts[blockKey].cities.has(value.city)));
      const salesAvailable = contexts[blockKey].observed(period);
      const purchasesAvailable = block.purchasingQuality.some((value) => value.period === period && value.status !== "empty");
      const assignedRevenue = salesAvailable ? suppliers.reduce((sum, value) => sum + value.salesRevenue, 0) : null;
      const assignedIncome = salesAvailable ? suppliers.length ? nullableSum(suppliers, (value) => value.estimatedGrossIncome) : 0 : null;
      const residualRevenue = salesAvailable ? residual.reduce((sum, value) => sum + value.salesRevenue, 0) : null;
      const residualIncome = salesAvailable ? residual.length ? nullableSum(residual, (value) => value.estimatedGrossIncome) : 0 : null;
      const total = contexts[blockKey].metrics(period, totalGroup);
      const row = sheet.addRow([blockNames[blockKey], `${periodNames[period]} ${windowLabel(block.sales.periods[period])}`,
        purchasesAvailable ? suppliers.length ? nullableSum(suppliers, (value) => value.purchases) ?? unavailable : 0 : unavailable,
        assignedRevenue ?? unavailable, assignedIncome ?? unavailable, residualRevenue ?? unavailable, residualIncome ?? unavailable,
        assignedRevenue !== null && total && total.revenue !== 0 ? assignedRevenue / total.revenue : unavailable,
        salesAvailable ? suppliers.reduce((sum, value) => sum + value.knownEstimatedGrossIncome, 0) + residual.reduce((sum, value) => sum + value.knownEstimatedGrossIncome, 0) : unavailable,
        "Сопоставление: исходный магазин × товар, единственный поставщик закупки в том же окне. Доля относится к нетто ВЫРУЧКЕ, не к покрытию ВД. Текущий основной поставщик каталога не используется."]);
      body(row);
      for (const column of [3, 4, 5, 6, 7, 9]) row.getCell(column).numFmt = moneyFormat;
      row.getCell(8).numFmt = percentFormat;
      row.height = 75;
      row.commit();
    }
  }
  const notes = [
    "n/a — отсутствующая история, неизвестная стоимость или недопустимый знаменатель. Тире в числовой ячейке — настоящий ноль. Не заменяйте n/a нулем.",
    "Неопределенный вид напитка не отбрасывается: он включен в общий DISTINCT итог всех товаров, общие корневые доли, отдельный фиксированный итог и аудит классификации.",
    "Полный ВД агрегата недоступен при неизвестной стоимости любого существенного исходного количества. Известная часть ВД показана отдельно и не является полным результатом.",
    "Основной и дополнительный периоды могут пересекаться: их суммы нельзя складывать. Закупки и ВД имеют разную городскую привязку; одинаковая строка города не доказывает поставку именно проданного товара.",
    "Все поставщики сохранены, без отсечения по доле или топ-10. Совпадение ИНН с внутренними организациями — только флаг, не исключение. Остаток дохода вынесен отдельно и не изображается поставщиком.",
    "Первичные сверки и аудиты содержат ВСЮ СЕТЬ независимо от city. Бизнес-листы ограничены выбранными городами; их суммы могут отличаться от полно-сетевых аудитов.",
    "Числа берутся из SQL-снимка 1С, не из презентации-шаблона. Причины снижения, ответственные и сроки не выдумываются: заполните их в редактируемой таблице задач."
  ];
  for (const text of notes) {
    const row = sheet.addRow([text]);
    sheet.mergeCells(row.number, 1, row.number, 10);
    row.getCell(1).alignment = { wrapText: true, vertical: "middle" };
    row.height = 52;
    row.commit();
  }
  sheet.commit();
}

function addDeclines(workbook: ExcelJS.stream.xlsx.WorkbookWriter, report: PresentationReport, contexts: Record<BlockKey, SalesContext>, cities: Set<string>) {
  const sheet = worksheet(workbook, "Наблюдаемые снижения", [27, 29, 50, 37, 24, 24, 24, 23, 78],
    "Только подтвержденные отрицательные изменения сопоставимой сети",
    "Строки появляются только при существующей ненулевой предыдущей базе и фактическом уменьшении. Причины, владельцы и сроки не назначаются автоматически. Пустая сопоставимая сеть означает n/a, не снижение.");
  sheet.getRow(4).values = ["Период отчета", "Город / выборка", "Группа / поставщик", "Показатель", "Предыдущая база", "Текущее значение", "Δ абсолютная", "Δ относительная", "Комментарий / причина — бизнес-ввод"];
  header(sheet.getRow(4));
  let count = 0;
  const add = (blockKey: BlockKey, city: string, name: string, metric: string, previous: FormulaValue, current: FormulaValue) => {
    if (previous === null || current === null || previous === 0 || current >= previous) return;
    const row = sheet.addRow([blockNames[blockKey], city, name, metric, previous, current, null, null, ""]);
    difference(row, 7, 5, 6);
    difference(row, 8, 5, 6, true);
    for (const column of [5, 6, 7]) row.getCell(column).numFmt = moneyFormat;
    row.getCell(8).numFmt = percentFormat;
    body(row);
    row.commit();
    count++;
  };
  for (const blockKey of ["main", "detail"] as const) {
    const context = contexts[blockKey];
    for (const group of context.rootGroups) {
      const previous = context.metrics("previous", group, true);
      const current = context.metrics("current", group, true);
      add(blockKey, "Выбранная сопоставимая сеть", group.name, "Выручка с НДС, KZT", previous?.revenue ?? null, current?.revenue ?? null);
      add(blockKey, "Выбранная сопоставимая сеть", group.name, "ВД, ОЦЕНКА KZT", previous?.estimatedGrossIncome ?? null, current?.estimatedGrossIncome ?? null);
    }
    if (!context.cohortStores.length) continue;
    const previous = new Map(report[blockKey].suppliers.filter((value) => value.period === "previous").map((value) => [JSON.stringify([value.city, value.supplierKey]), value]));
    for (const current of report[blockKey].suppliers) {
      if (current.period !== "current" || (cities.size && !cities.has(current.city))) continue;
      const old = previous.get(JSON.stringify([current.city, current.supplierKey]));
      add(blockKey, current.city, current.supplierName, "Сеть: закупки нетто, KZT", old?.cohortPurchases ?? null, current.cohortPurchases);
      add(blockKey, current.city, current.supplierName, "Сеть: распределенный ВД, ОЦЕНКА", old?.cohortEstimatedGrossIncome ?? null, current.cohortEstimatedGrossIncome);
    }
  }
  if (!count) {
    const row = sheet.addRow(["Нет подтвержденных снижений с ненулевой базой; это не утверждение о росте. При отсутствии истории/сопоставимой сети сравнение недоступно."]);
    sheet.mergeCells(row.number, 1, row.number, 9);
    row.getCell(1).alignment = { wrapText: true };
    row.height = 48;
    row.commit();
  } else sheet.autoFilter = { from: "A4", to: `I${count + 4}` };
  sheet.commit();
}

function addTasks(workbook: ExcelJS.stream.xlsx.WorkbookWriter, report: PresentationReport) {
  const sheet = worksheet(workbook, "Задачи и комментарии", [65, 105, 35, 25], "Редактируемые задачи и бизнес-комментарии",
    "Автоматически предложены только проверки подтвержденного качества данных всей сети. Причины, ответственный и срок — пустые бизнес-вводы. Дополните свободные строки; файл не назначает владельцев и не меняет 1С.");
  sheet.getRow(4).values = ["Задача", "Комментарий", "Ответственный", "Срок"];
  header(sheet.getRow(4));
  const tasks: [string, string][] = [];
  for (const blockKey of ["main", "detail"] as const) {
    const block = report[blockKey];
    for (const period of ["current", "previous"] as const) {
      const coverage = block.sales.coverage.find((value) => value.period === period);
      if (!coverage || coverage.status === "empty") tasks.push(["Проверить доступность истории чеков", `${blockNames[blockKey]}, ${periodNames[period].toLowerCase()} ${windowLabel(block.sales.periods[period])}: история не наблюдается; сравнения n/a.`]);
      else if (coverage.status === "partial") tasks.push(["Проверить пропущенные дни загрузки", `${blockNames[blockKey]}, ${periodNames[period].toLowerCase()}: ${coverage.coveredDays}/${coverage.expectedDays} дней; перечень дат на листе «Качество данных».`]);
      const quality = block.sales.dataQuality.periods.find((value) => value.period === period);
      if (quality && quality.unvaluedQuantity > 0.000000001) tasks.push(["Проверить стоимость неоцененных товаров", `${blockNames[blockKey]}, ${periodNames[period].toLowerCase()}: абсолютное количество без цены ${quality.unvaluedQuantity}; полный ВД n/a. Исходные пары на листе «Оценка стоимости».`]);
      if (quality && quality.difference !== null && quality.difference !== 0) tasks.push(["Проверить сверку заголовков и товарных строк", `${blockNames[blockKey]}, ${periodNames[period].toLowerCase()}: строки минус заголовки ${quality.difference} KZT; не распределять разницу по категориям без первичных оснований.`]);
      const purchases = block.purchasingQuality.find((value) => value.period === period);
      if (purchases && (purchases.missingReceiptAmounts || purchases.missingReturnAmounts || purchases.receiptsWithoutLines)) tasks.push(["Проверить первичные документы закупок", `${blockNames[blockKey]}, ${periodNames[period].toLowerCase()}: поступления без суммы ${purchases.missingReceiptAmounts}, возвраты без суммы ${purchases.missingReturnAmounts}, поступления без строк ${purchases.receiptsWithoutLines}.`]);
    }
    const uncertain = block.sales.dataQuality.taxonomy.filter((item) => item.presentationKind === "unclassified" || item.issue);
    if (uncertain.length) tasks.push(["Проверить текущую классификацию товаров", `${blockNames[blockKey]}: ${uncertain.length} товаров с неопределенным видом напитка или проблемой иерархии. Не назначать вид по выручке; смотрите причины в «Классификация».`]);
    if (block.residual.length) tasks.push(["Разобрать нераспределенный компонент модели", `${blockNames[blockKey]}: причины и пары на листах «Нераспределенный доход» и «Атрибуция поставщиков». Несколько поставщиков/нет закупки не дают фактическую партию; остаток не присваивать произвольно.`]);
  }
  for (const [task, comment] of tasks) {
    const row = sheet.addRow([task, comment, "", ""]);
    body(row);
    row.height = 66;
    row.commit();
  }
  for (let index = 0; index < 12; index++) {
    const row = sheet.addRow(["", "", "", ""]);
    body(row);
    row.commit();
  }
  sheet.autoFilter = { from: "A4", to: `D${4 + tasks.length + 12}` };
  sheet.commit();
}

function addMethodology(workbook: ExcelJS.stream.xlsx.WorkbookWriter, report: PresentationReport, cityCaption: string) {
  const sheet = worksheet(workbook, "Методология", [9, 47, 133], "Как читать показатели, формулы и ограничения",
    `Выбранные города бизнес-листов: ${cityCaption}. Аудиты — вся сеть. Снимок UTC ${report.generatedAt}. Полные исходные значения сохранены; форматы округляют только отображение.`);
  sheet.getRow(4).values = ["№", "Тема", "Метод и ограничения"];
  header(sheet.getRow(4));
  const guide: [string, string][] = [
    ["Периоды", `Основной текущий ${windowLabel(report.main.sales.periods.current)}, предыдущий ${windowLabel(report.main.sales.periods.previous)}. Дополнительный текущий ${windowLabel(report.detail.sales.periods.current)}, предыдущий ${windowLabel(report.detail.sales.periods.previous)}. Правая граница исключена; окна не обязаны совпадать с годом или месяцем.`],
    ["Шаблон продаж", "B/C — текущее количество/выручка; D/E — абсолютное изменение; F/G — процент изменения только автоматической сопоставимой сети; H — текущий оценочный ВД; I — ВД / выручка, НЕ изменение ВД; J/K — абсолютное/относительное изменение ВД; L — абсолютное изменение DISTINCT чеков сети. M:AF сохраняют предыдущую базу, полную выручку/чеки, исходные метрики сети и известную часть ВД."],
    ["Формулы и n/a", "Разность доступна только для двух чисел. Относительное изменение = текущее / предыдущее − 1, только при ненулевой числовой базе. Маржа = оценочный ВД / выручка, только при ненулевой числовой выручке. Формулы сохраняют кеш результата и пересчитываются Excel при изменении исходных ячеек/фильтра в автоматическом режиме расчета. n/a — текст, а не скрытый ноль."],
    ["Видимые итоги", "SUBTOTAL(109) суммирует только видимые строки. Перед суммой SUBTOTAL(102) (COUNT) сравнивается с SUBTOTAL(103) (COUNTA): наличие видимого n/a делает итог n/a. Все скрытые фильтром и вручную строки исключены. Производные показатели итогов рассчитываются из видимых исходных сумм, не суммой процентов."],
    ["Доли и фильтры", "Знаменатели долей — фиксированные суммы всех корневых групп/всех поставщиков города. Фильтр города или числовой доли скрывает строки, но не сокращает городской знаменатель. Сумма видимых долей нескольких городов не является долей сети и может превысить 100%. Нетто знаменатели допускают отрицательные доли после возвратов."],
    ["Чеки DISTINCT", "Итоги presentation:total, packaged, draught и unclassified получены прямым DISTINCT объединением исходных чеков. Total включает ВСЕ товары, услуги, прочие и несопоставленные. Ни чеки корней, ни чеки подкатегорий НЕ суммируются. Складывать разрешено один и тот же DISTINCT итог только между непересекающимися городами/физическими точками. Видимый итог категорий не заявляет число уникальных чеков; фиксированный DISTINCT итог подписан отдельно."],
    ["Количество", "Количество — нетто исходные учетные единицы 1С, включая услуги. Это не единые штуки/литры. Абсолютное количество — сумма модулей исходных количеств: возвраты не погашают пробел стоимости. Доля оцененного количества не равна покрытию выручки или ВД."],
    ["Оценочный ВД", "ВД = нетто розничная сумма строк с записанным НДС − оценочная стоимость нетто количества. НДС розничной выручки не вычитается. Закупочный fallback цены исключает записанный НДС закупочных строк. Это не исторический COGS, не бухгалтерская прибыль и не отчет P&L. При неизвестной цене существенного количества полный ВД агрегата n/a даже при нулевой выручке неоцененных строк."],
    ["Известная часть ВД", "Известная часть = выручка оцененных строк − их оценочная стоимость. Она сохраняется отдельно при неизвестном полном ВД. Нельзя выдавать ее за весь ВД или трактовать долю отнесенной выручки как доказанное покрытие ВД."],
    ["Уникальный поставщик — МОДЕЛЬ", "Для исходного магазина × товара ищутся поставщики проведенных/неудаленных поступлений ТОГО ЖЕ окна. Только единственный известный поставщик получает модельную выручку/ВД пары. Несколько поставщиков, нет закупки либо неизвестная ссылка дают отдельный остаток. В строках ККМ нет подтвержденной партии/поставщика. Основной поставщик текущего каталога не используется."],
    ["Закупки и возвраты", "Headline закупок = сумма заголовков поступлений − сумма заголовков возвратов поставщику. Строки закупок показаны в сверке, не подменяют документную сумму. Неизвестные суммы не обнуляются. Закупка без отнесенных продаж дает нулевой РАСПРЕДЕЛЕННЫЙ модельный ВД, не доказанный фактический доход поставщика."],
    ["Два города поставщика", "Закупки относятся к городу приемного магазина/склада. Модельный ВД — к городу исходной розничной продажи. Склад может не входить в наблюдаемую розничную сопоставимую сеть; закупки сети ограничены ее физическими точками. Совпадение ИНН с внутренней организацией — только флаг, все суммы сохранены."],
    ["Классификация", "Используется текущая иерархия каталога, не историческая. Подкатегория презентации — первая дочерняя папка под корнем, иначе корень. Вид напитка и основание сохранены в аудите; неизвестный вид не выдумывается и не отбрасывается. Все корни доступны в общих продажах/долях."],
    ["Сравнимая сеть", "Автоматическая сеть определяется отдельно в основном и дополнительном окнах: физическая точка должна иметь положительные продажи по всем товарам и в текущем, и в предыдущем окне. Нет положительных продаж предыдущего окна — точка исключена. Это не доказательство даты открытия. При пустой сети все ее метрики и изменения n/a."],
    ["Аудиты и редактирование", "Качество, магазины, классификация, стоимость и атрибуция содержат всю сеть независимо от city. Автофильтр аудит-листа не удаляет исходные ключи/периоды. Ручная правка ячеек не пересчитывает DISTINCT состав чеков, классификацию, стоимость или принадлежность сети: для новых исходных данных сформируйте файл заново."],
    ["Снижения и задачи", "Лист снижений содержит только наблюдаемое отрицательное абсолютное изменение сопоставимой сети с существующей ненулевой базой. Причины не выводятся из корреляций. Задачи предлагают проверку подтвержденных пробелов данных; комментарий, ответственный и срок — редактируемые бизнес-вводы."]
  ];
  let index = 0;
  for (const [topic, text] of guide) {
    const row = sheet.addRow([++index, topic, text]);
    body(row);
    row.height = 85;
    row.getCell(3).alignment = { wrapText: true, vertical: "middle" };
    row.commit();
  }
  const sourceMethods = new Set([...report.methodology, ...report.main.sales.methodology, ...report.detail.sales.methodology]);
  for (const text of sourceMethods) {
    const row = sheet.addRow([++index, "Метод SQL-снимка", text]);
    body(row);
    row.height = 85;
    row.getCell(3).alignment = { wrapText: true, vertical: "middle" };
    row.commit();
  }
  sheet.commit();
}

function addQuality(workbook: ExcelJS.stream.xlsx.WorkbookWriter, report: PresentationReport) {
  const sheet = worksheet(workbook, "Качество данных", [64, 41, 41, 41, 41], "Покрытие, сверки и пробелы — ВСЯ СЕТЬ",
    "НЕ ограничено выбранными городами: это аудит первоисточников. Наблюдение дней не доказывает полноту. Отсутствующие суммы и ВД — n/a; документные количества/дни могут быть настоящим нулем. Закупочные строки не подменяют суммы заголовков.");
  const windows = [
    { block: report.main, key: "main" as const, period: "current" as const },
    { block: report.main, key: "main" as const, period: "previous" as const },
    { block: report.detail, key: "detail" as const, period: "current" as const },
    { block: report.detail, key: "detail" as const, period: "previous" as const }
  ];
  sheet.getRow(4).values = ["Показатель", ...windows.map((value) => `${blockNames[value.key]}: ${periodNames[value.period].toLowerCase()} ${windowLabel(value.block.sales.periods[value.period])}`)];
  header(sheet.getRow(4));
  const add = (label: string, getter: (value: typeof windows[number]) => string | number | null | undefined, format?: string) => {
    const row = sheet.addRow([label, ...windows.map((value) => getter(value) ?? unavailable)]);
    body(row);
    if (format) for (let column = 2; column <= 5; column++) row.getCell(column).numFmt = format;
    row.commit();
  };
  add("Статус наблюдения чеков", ({ block, period }) => {
    const status = block.sales.coverage.find((value) => value.period === period)?.status;
    return status === "empty" ? "Нет истории — сравнение n/a" : status === "partial" ? "Неполное наблюдение" : status === "observed" ? "Наблюдаемое, не гарантия полноты" : unavailable;
  });
  add("Дней с подходящими чеками", ({ block, period }) => block.sales.coverage.find((value) => value.period === period)?.coveredDays, integerFormat);
  add("Ожидается календарных дней", ({ block, period }) => block.sales.coverage.find((value) => value.period === period)?.expectedDays, integerFormat);
  add("Первый наблюдаемый чек", ({ block, period }) => block.sales.coverage.find((value) => value.period === period)?.dateFrom);
  add("Последний наблюдаемый чек", ({ block, period }) => block.sales.coverage.find((value) => value.period === period)?.dateTo);
  add("Документов подходящих чеков", ({ block, period }) => block.sales.coverage.find((value) => value.period === period)?.receiptCount, integerFormat);
  const salesFields = [
    ["Нетто заголовки чеков с НДС, KZT", "headerRevenue", moneyFormat], ["Нетто строки чеков с НДС, KZT", "lineRevenue", moneyFormat],
    ["Строки минус заголовки, KZT", "difference", moneyFormat], ["Положительные продажные документы DISTINCT", "positiveSaleReceiptCount", integerFormat],
    ["Возвратные документы", "returnReceiptCount", integerFormat], ["Чеки без товарных строк", "receiptsWithoutLines", integerFormat],
    ["Строки чеков", "lineCount", integerFormat], ["Абсолютное количество, смешанные учетные ед.", "absoluteQuantity", quantityFormat],
    ["Количество без цены, абсолютное", "unvaluedQuantity", quantityFormat], ["Известная часть оценочной стоимости, KZT", "valuedCost", moneyFormat],
    ["Нетто выручка неоцененных строк, KZT", "unvaluedRevenue", moneyFormat], ["Полный ВД, ОЦЕНКА KZT", "estimatedGrossIncome", moneyFormat]
  ] as const;
  for (const [label, field, format] of salesFields) add(label, ({ block, period }) => block.sales.dataQuality.periods.find((value) => value.period === period)?.[field], format);
  add("Известная часть ВД — не полный ВД, KZT", ({ block, period }) => {
    const total = block.sales.aggregates.find((value) => value.period === period && value.scope === "all" && value.groupKind === "presentation" && value.groupKey === "total");
    return total ? total.valuedRevenue - total.valuedCost : null;
  }, moneyFormat);
  add("Доля оцененного абсолютного количества — НЕ покрытие ВД", ({ block, period }) => {
    const value = block.sales.dataQuality.periods.find((item) => item.period === period);
    return value && value.absoluteQuantity !== 0 ? 1 - value.unvaluedQuantity / value.absoluteQuantity : null;
  }, percentFormat);
  add("Физических точек в независимой сопоставимой сети", ({ block }) => block.sales.cohort.selectedStoreKeys.length, integerFormat);
  add("Глобальная история чеков: первая дата", ({ block }) => block.sales.dataQuality.global.dateFrom);
  add("Глобальная история чеков: последняя дата", ({ block }) => block.sales.dataQuality.global.dateTo);
  add("Глобальная история: дней с чеками", ({ block }) => block.sales.dataQuality.global.coveredDays, integerFormat);
  sheet.addRow([]).commit();
  const purchasingHeader = sheet.addRow(["Закупки: проведенные, неудаленные поступления / возвраты поставщику — ВСЯ СЕТЬ"]);
  sheet.mergeCells(purchasingHeader.number, 1, purchasingHeader.number, 5);
  header(purchasingHeader);
  for (const [label, field] of [
    ["Первая дата закупок окна", "dateFrom"], ["Последняя дата закупок окна", "dateTo"],
    ["Глобально первая дата поступления", "sourceDateFrom"], ["Глобально последняя дата поступления", "sourceDateTo"]
  ] as const) add(label, ({ block, period }) => block.purchasingQuality.find((value) => value.period === period)?.[field]);
  add("Статус наблюдения закупок", ({ block, period }) => {
    const status = block.purchasingQuality.find((value) => value.period === period)?.status;
    return status === "empty" ? "Нет истории — суммы n/a" : status === "partial" ? "Частичная история — вне наблюдения не восстановлено" : status === "observed" ? "Наблюдаемое, не гарантия полноты" : unavailable;
  });
  for (const [label, field, format] of [
    ["Поступлений документов", "receiptDocuments", integerFormat], ["Возвратов поставщику документов", "returnDocuments", integerFormat],
    ["Поставщиков в окне", "supplierCount", integerFormat], ["Поступлений с неизвестной суммой", "missingReceiptAmounts", integerFormat],
    ["Возвратов с неизвестной суммой", "missingReturnAmounts", integerFormat], ["Поступлений без строк", "receiptsWithoutLines", integerFormat],
    ["Суммы заголовков поступлений, KZT", "receiptAmount", moneyFormat], ["Суммы заголовков возвратов, KZT", "returnAmount", moneyFormat],
    ["Суммы строк поступлений, KZT", "purchaseLineAmount", moneyFormat], ["Заголовки поступлений минус строки, KZT", "documentLineDifference", moneyFormat]
  ] as const) add(label, ({ block, period }) => block.purchasingQuality.find((value) => value.period === period)?.[field], format);
  add("Закупки нетто по заголовкам, KZT", ({ block, period }) => {
    const value = block.purchasingQuality.find((item) => item.period === period);
    return value && value.receiptAmount !== null && value.returnAmount !== null ? value.receiptAmount - value.returnAmount : null;
  }, moneyFormat);
  sheet.addRow([]).commit();
  const missing = sheet.addRow(["Даты без подходящих чеков — по всем четырем окнам, ВСЯ СЕТЬ"]);
  sheet.mergeCells(missing.number, 1, missing.number, 5);
  header(missing);
  const dates = windows.map(({ block, period }) => block.sales.coverage.find((value) => value.period === period)?.missingDays ?? []);
  for (let index = 0; index < Math.max(...dates.map((value) => value.length)); index++) {
    sheet.addRow([index + 1, ...dates.map((value) => value[index] ?? "")]).commit();
  }
  sheet.commit();
}

async function addAudits(workbook: ExcelJS.stream.xlsx.WorkbookWriter, report: PresentationReport, checkpoint: (row: number) => Promise<void>) {
  const stores = worksheet(workbook, "Магазины и исходные ключи", [28, 43, 64, 29, 21, 23, 43, 66], "Физические магазины, исходные ключи и состав сети — ВСЯ СЕТЬ",
    "Независимый состав основного/дополнительного окон. Не ограничено city. Стоимость и поставщик выбираются по исходному магазину ДО физического объединения. Активность в обоих окнах не доказывает дату открытия.");
  stores.getRow(4).values = ["Период отчета", "Физический ключ", "Название / адрес", "Город", "Положительные продажи в обоих", "В сопоставимой сети", "Исходный ключ 1С", "Исходное название"];
  header(stores.getRow(4));
  for (const blockKey of ["main", "detail"] as const) {
    const sales = report[blockKey].sales;
    const selected = new Set(sales.cohort.selectedStoreKeys);
    const physical = new Map(sales.stores.map((value) => [value.key, value]));
    for (const source of sales.dataQuality.sourceStores) {
      const store = physical.get(source.physicalKey);
      const row = stores.addRow([blockNames[blockKey], source.physicalKey, store?.name ?? source.name, source.city,
        store?.comparableByActivity ? "Да" : "Нет", selected.has(source.physicalKey) ? "Да" : "Нет", source.key, source.name]);
      row.commit();
      await checkpoint(row.number);
    }
  }
  stores.autoFilter = { from: "A4", to: `H${4 + report.main.sales.dataQuality.sourceStores.length + report.detail.sales.dataQuality.sourceStores.length}` };
  stores.commit();
  const taxonomy = worksheet(workbook, "Классификация", [28, 43, 64, 43, 43, 29, 43, 64, 79, 44, 43, 86, 24, 24, 24, 24],
    "Текущая классификация товаров и причины — ВСЯ СЕТЬ",
    "Это текущий каталог, НЕ историческая классификация. Все товары сохранены: прочие, услуги, отсутствующие корни и неопределенные виды напитков. Подкатегория — первая дочерняя папка под корнем (fallback корень). Не ограничено city.");
  taxonomy.getRow(4).values = ["Период отчета", "Ключ товара", "Название", "Ключ корня", "Корневая группа", "Вид презентации", "Ключ подкатегории", "Подкатегория презентации", "Основание вида", "Член старой группы", "Проблема иерархии", "Путь ключей товар → корень", "Количество текущее", "Выручка текущая с НДС", "Количество предыдущее", "Выручка предыдущая с НДС"];
  header(taxonomy.getRow(4));
  for (const blockKey of ["main", "detail"] as const) {
    const block = report[blockKey];
    const currentObserved = block.sales.coverage.some((value) => value.period === "current" && value.status !== "empty");
    const previousObserved = block.sales.coverage.some((value) => value.period === "previous" && value.status !== "empty");
    for (const item of block.sales.dataQuality.taxonomy) {
      const row = taxonomy.addRow([blockNames[blockKey], item.itemKey, item.name, item.rootKey, item.rootName,
        item.presentationKind ? `${item.presentationKind}: ${presentationNames[item.presentationKind]}` : unavailable,
        item.presentationCategoryKey ?? unavailable, item.presentationCategoryName ?? unavailable, item.presentationReason ?? unavailable,
        item.member ?? unavailable, item.issue ?? "", item.path.join(" → "),
        currentObserved ? item.currentQuantity : unavailable, currentObserved ? item.currentRevenue : unavailable,
        previousObserved ? item.previousQuantity : unavailable, previousObserved ? item.previousRevenue : unavailable]);
      for (const column of [13, 15]) row.getCell(column).numFmt = quantityFormat;
      for (const column of [14, 16]) row.getCell(column).numFmt = moneyFormat;
      row.commit();
      await checkpoint(row.number);
    }
  }
  taxonomy.autoFilter = { from: "A4", to: `P${4 + report.main.sales.dataQuality.taxonomy.length + report.detail.sales.dataQuality.taxonomy.length}` };
  taxonomy.commit();
  const valuation = worksheet(workbook, "Оценка стоимости", [28, 25, 28, 43, 43, 25, 66, 24, 25, 25, 25, 25],
    "Каноническая оценка стоимости по исходным парам — ВСЯ СЕТЬ",
    "Не ограничено city. Цена строго до исключенной границы окна; выбирается существующей иерархией стоимости, не исторической партией. Неизвестная цена/стоимость/ВД — n/a, не ноль. Абсолютное количество сохраняет пробелы при возвратах.");
  valuation.getRow(4).values = ["Период отчета", "Окно", "Граница исключена", "Исходный магазин", "Ключ товара", "Цена, ОЦЕНКА", "Источник цены", "Количество нетто", "Выручка с НДС", "Количество абсолютное", "Оценочная стоимость", "ВД пары, ОЦЕНКА"];
  header(valuation.getRow(4));
  for (const blockKey of ["main", "detail"] as const) {
    const block = report[blockKey];
    for (const value of block.sales.dataQuality.valuation) {
      const row = valuation.addRow([blockNames[blockKey], periodNames[value.period], block.sales.periods[value.period].to, value.sourceStoreKey, value.itemKey,
        value.unitCost ?? unavailable, `${value.source}: ${costNames[value.source] ?? value.source}`, value.quantity, value.revenue,
        value.absoluteQuantity, value.valuedCost ?? unavailable, value.valuedCost !== null ? value.revenue - value.valuedCost : unavailable]);
      for (const column of [6, 9, 11, 12]) row.getCell(column).numFmt = moneyFormat;
      for (const column of [8, 10]) row.getCell(column).numFmt = quantityFormat;
      row.commit();
      await checkpoint(row.number);
    }
  }
  valuation.autoFilter = { from: "A4", to: `L${4 + report.main.sales.dataQuality.valuation.length + report.detail.sales.dataQuality.valuation.length}` };
  valuation.commit();
  const attribution = worksheet(workbook, "Атрибуция поставщиков", [28, 25, 28, 28, 43, 43, 29, 43, 24, 25, 25, 25, 40, 25, 43, 55, 75, 25, 48, 25],
    "Пары магазин × товар и уникальный поставщик — МОДЕЛЬ, ВСЯ СЕТЬ",
    "Не ограничено city. Список кандидатов — поставщики закупок того же окна по ИСХОДНОМУ магазину и товару. Это не подтверждение проданной партии. Все причины остатка сохранены. Основной поставщик текущего каталога не применяется.");
  attribution.getRow(4).values = ["Период отчета", "Окно", "Начало включено", "Конец исключен", "Исходный магазин", "Физический магазин", "Город продажи", "Ключ товара", "Количество нетто", "Выручка с НДС", "Количество абсолютное", "Цена, ОЦЕНКА", "Код источника цены", "Оценочная стоимость", "Отнесенный ключ поставщика", "Отнесенное имя поставщика", "Все ключи кандидатов", "Строки закупки с неизвестным поставщиком", "Причина атрибуции / остатка", "ВД пары, ОЦЕНКА"];
  header(attribution.getRow(4));
  for (const blockKey of ["main", "detail"] as const) {
    const block = report[blockKey];
    for (const value of block.attribution) {
      const row = attribution.addRow([blockNames[blockKey], periodNames[value.period], block.sales.periods[value.period].from, block.sales.periods[value.period].to,
        value.sourceStoreKey, value.physicalStoreKey, value.city, value.itemKey, value.quantity, value.revenue, value.absoluteQuantity,
        value.unitCost ?? unavailable, value.costSource, value.valuedCost ?? unavailable, value.supplierKey ?? unavailable, value.supplierName ?? unavailable,
        value.supplierCandidates.join("; "), value.unknownSupplierLines, `${value.reason}: ${reasonNames[value.reason]}`,
        value.valuedCost !== null ? value.revenue - value.valuedCost : unavailable]);
      for (const column of [9, 11]) row.getCell(column).numFmt = quantityFormat;
      for (const column of [10, 12, 14, 20]) row.getCell(column).numFmt = moneyFormat;
      row.getCell(18).numFmt = integerFormat;
      row.commit();
      await checkpoint(row.number);
    }
  }
  attribution.autoFilter = { from: "A4", to: `T${4 + report.main.attribution.length + report.detail.attribution.length}` };
  attribution.commit();
}
