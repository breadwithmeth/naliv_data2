import ExcelJS from "exceljs";
import { once } from "node:events";
import type { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import type {
  TurnoverChange, TurnoverDailyRow, TurnoverReport, TurnoverRow,
  TurnoverTransfer, TurnoverWindow
} from "./turnover-types.js";
import { writeTurnoverSampleWorkbook } from "./turnover-sample-workbook.js";

type Value = string | number | null;
type Column<T> = { label: string; block: string; value: (row: T) => Value; width?: number; format?: string };
type StreamingSheet = ExcelJS.Worksheet & { commit(): void };
type StreamingWorkbook = ExcelJS.stream.xlsx.WorkbookWriter & { zip: EventEmitter & { abort(): void } };
const decimal = '#,##0.###;[Red](#,##0.###);0';
const money = '#,##0.00;[Red](#,##0.00);0.00';
const percent = '0.0%;[Red](0.0%);0.0%';
const changeNames = { new: "Продажи появились", "no-base": "Нет базы для сравнения", missing: "Нет данных", comparable: "Нет данных" };
const riskNames = { "no-sales": "Нет продаж", overstock: "Излишек", deficit: "Риск дефицита", stagnant: "Без движения" };

function changeValue(change: TurnoverChange): Value {
  return change.pct === null ? changeNames[change.status] : change.pct / 100;
}

function identityColumns(includeBarcodes = true): Column<TurnoverRow>[] {
  const columns: Column<TurnoverRow>[] = [
    { label: "Магазин", block: "Идентификация", value: r => r.storeName, width: 34 },
    { label: "Склад", block: "Идентификация", value: r => r.warehouseName, width: 25 },
    { label: "Категория", block: "Идентификация", value: r => r.categoryName, width: 25 },
    { label: "Бренд", block: "Идентификация", value: r => r.brandName, width: 24 },
    { label: "SKU (ключ 1С)", block: "Идентификация", value: r => r.sku, width: 38 },
    { label: "Артикул", block: "Идентификация", value: r => r.article, width: 18 },
    { label: "Наименование", block: "Идентификация", value: r => r.name, width: 45 }
  ];
  if (includeBarcodes) columns.push({ label: "Штрихкоды", block: "Идентификация", value: r => r.barcodes.join(", "), width: 24 });
  columns.push({ label: "Единица учёта 1С", block: "Идентификация", value: r => r.unit, width: 19 });
  return columns;
}

function reportColumns(report: TurnoverReport): Column<TurnoverRow>[] {
  const columns = identityColumns(report.params.profile !== "summary");
  if (report.params.mode !== "money") columns.push(
    { label: "Начальный остаток", block: "Количество · в единице строки", value: r => r.openingQty },
    { label: "Конечный остаток", block: "Количество · в единице строки", value: r => r.closingQty },
    { label: "Средний остаток", block: "Количество · в единице строки", value: r => r.averageQty },
    { label: "Нетто продажи за период", block: "Количество · в единице строки", value: r => r.periodSales.quantity },
    { label: "Среднедневные продажи периода", block: "Количество · в единице строки", value: r => r.periodSales.averageDailyQty },
    { label: "Оборачиваемость, раз", block: "Количество · в единице строки", value: r => r.turnoverQty },
    { label: "Оборачиваемость, дни", block: "Количество · в единице строки", value: r => r.turnoverQtyDays }
  );
  if (report.params.mode !== "quantity") columns.push(
    { label: "Стоимость начального остатка, ₸", block: "Себестоимость · ₸", value: r => r.openingCost, format: money },
    { label: "Стоимость конечного остатка, ₸", block: "Себестоимость · ₸", value: r => r.closingCost, format: money },
    { label: "Средняя стоимость запаса, ₸", block: "Себестоимость · ₸", value: r => r.averageCost, format: money },
    { label: "Нетто продажи по себестоимости, ₸", block: "Себестоимость · ₸", value: r => r.periodSales.cost, format: money },
    { label: "Среднедневная себестоимость продаж периода, ₸", block: "Себестоимость · ₸", value: r => r.periodSales.averageDailyCost, format: money },
    { label: "Оборачиваемость по себестоимости, раз", block: "Себестоимость · ₸", value: r => r.turnoverCost },
    { label: "Оборачиваемость по себестоимости, дни", block: "Себестоимость · ₸", value: r => r.turnoverCostDays },
    { label: "Розничная выручка, ₸ · не числитель оборачиваемости", block: "Выручка отдельно", value: r => r.periodSales.revenue, format: money }
  );
  if (report.params.mode !== "money") columns.push(
    { label: "Нетто количество периода сравнения", block: "Сравнение периодов", value: r => r.comparisonSales.quantity },
    { label: "Изменение количества, % / статус", block: "Сравнение периодов", value: r => changeValue(r.quantityChange), format: percent }
  );
  if (report.params.mode !== "quantity") columns.push(
    { label: "Себестоимость продаж периода сравнения, ₸", block: "Сравнение периодов", value: r => r.comparisonSales.cost, format: money },
    { label: "Изменение себестоимости продаж, % / статус", block: "Сравнение периодов", value: r => changeValue(r.costChange), format: percent }
  );
  columns.push(
    { label: `Дни запаса · спрос за ${report.params.horizon ?? 14} дней`, block: "Риски и решения", value: r => r.stockDays },
    { label: "Последняя продажа в магазине", block: "Риски и решения", value: r => r.lastSaleDate, width: 22 },
    { label: "Дни без движения / история", block: "Риски и решения", value: r => r.noSalesHistory ? "Нет продаж за историю учёта" : r.daysWithoutMovement, width: 26 },
    { label: "Дни без наличия (наблюдаемые)", block: "Риски и решения", value: r => r.outOfStockDays },
    { label: "Излишек, единица строки", block: "Риски и решения", value: r => r.excessQty },
    { label: "Дефицит, единица строки", block: "Риски и решения", value: r => r.deficitQty },
    { label: "Открытые заказы за вычетом поступлений", block: "Риски и решения", value: r => r.openOrderQty },
    { label: "Ближайшая ожидаемая поставка", block: "Риски и решения", value: r => r.nextDeliveryDate, width: 24 },
    { label: "Рекомендовано к заказу, единица строки", block: "Риски и решения", value: r => r.recommendedOrderQty },
    { label: "Статусы", block: "Риски и решения", value: r => r.risks.map(risk => riskNames[risk]).join("; "), width: 28 },
    { label: "Рекомендации и причины", block: "Риски и решения", value: r => r.recommendations.map(rec => `${rec.action}: ${rec.reason}`).join("\n"), width: 65 },
    { label: "Наблюдаемые дни остатков", block: "Качество данных", value: r => r.observedDays },
    { label: "Ожидаемые дни остатков", block: "Качество данных", value: r => r.expectedDays },
    { label: "Покрытие себестоимости, %", block: "Качество данных", value: r => r.costCoveragePct === null ? null : r.costCoveragePct / 100, format: percent }
  );
  if (report.params.mode !== "quantity") columns.push(
    { label: "Стоимость без движения ≥30 дней, ₸", block: "Замороженные средства · накопительные группы", value: r => r.stagnantCost.d30, format: money },
    { label: "Стоимость без движения ≥60 дней, ₸", block: "Замороженные средства · накопительные группы", value: r => r.stagnantCost.d60, format: money },
    { label: "Стоимость без движения ≥90 дней, ₸", block: "Замороженные средства · накопительные группы", value: r => r.stagnantCost.d90, format: money }
  );
  return columns;
}

// Await each bounded worksheet's archive entry before producing the next part.
// ExcelJS commits rows without backpressure, so yielding alone is not a bound.
function table<T>(workbook: StreamingWorkbook, name: string, columns: Column<T>[], title: string, note: string, signal: AbortSignal) {
  let sheet: StreamingSheet;
  let part = 0;
  let rowCount = 4;
  function open() {
    part++;
    rowCount = 4;
    sheet = workbook.addWorksheet(part === 1 ? name : `${name} ${part}`, {
      views: [{ state: "frozen", xSplit: 1, ySplit: 4 }],
      properties: { defaultRowHeight: 21 },
      pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    }) as StreamingSheet;
    sheet.columns = columns.map(column => ({ width: column.width ?? 21, style: { numFmt: column.format ?? decimal, font: { name: "Calibri", size: 11 } } }));
    for (const [number, text] of [[1, title], [2, note]] as const) {
      sheet.mergeCells(number, 1, number, columns.length);
      const row = sheet.getRow(number);
      row.getCell(1).value = text;
      row.getCell(1).alignment = { wrapText: true, vertical: "middle" };
      row.font = { name: "Calibri", size: number === 1 ? 14 : 10, bold: number === 1 };
      row.height = number === 1 ? 30 : 42;
      row.commit();
    }
    let groupStart = 1;
    while (groupStart <= columns.length) {
      let groupEnd = groupStart;
      while (groupEnd < columns.length && columns[groupEnd].block === columns[groupStart - 1].block) groupEnd++;
      if (groupEnd > groupStart) sheet.mergeCells(3, groupStart, 3, groupEnd);
      sheet.getRow(3).getCell(groupStart).value = columns[groupStart - 1].block;
      groupStart = groupEnd + 1;
    }
    sheet.getRow(4).values = columns.map(column => column.label);
    for (const number of [3, 4]) {
      const row = sheet.getRow(number);
      row.height = number === 3 ? 24 : 58;
      row.eachCell({ includeEmpty: true }, cell => {
        cell.font = { name: "Calibri", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: number === 3 ? "FF1D2939" : "FF2864D8" } };
        cell.alignment = { wrapText: true, vertical: "middle" };
      });
      row.commit();
    }
    sheet.pageSetup.printTitlesRow = "1:4";
  }
  async function finish() {
    signal.throwIfAborted();
    sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: rowCount, column: columns.length } };
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
  open();
  return {
    add(record: T) {
      if (rowCount >= 10_004) return false;
      // A string cell is always text, including leading '=' and leading zeros.
      sheet.addRow(columns.map(column => {
        const value = column.value(record);
        return value === null || (typeof value === "number" && !Number.isFinite(value)) ? "n/a" : typeof value === "string" ? value.slice(0, 32_767) : value;
      })).commit();
      rowCount++;
      return true;
    },
    finish,
    async nextPart() { await finish(); open(); }
  };
}

function dailyColumns(report: TurnoverReport): Column<TurnoverDailyRow>[] {
  const columns: Column<TurnoverDailyRow>[] = [
    { label: "Дата", block: "Ежедневно", value: r => r.date, width: 16 },
    { label: "Единица учёта 1С", block: "Ежедневно", value: r => r.unit },
    { label: "Вес даты в среднем", block: "Среднее хронологическое", value: r => r.weight }
  ];
  if (report.params.mode !== "money") columns.push({ label: "Остаток, единица строки", block: "Остаток", value: r => r.quantity });
  if (report.params.mode !== "quantity") columns.push({ label: "Стоимость остатка, ₸", block: "Остаток", value: r => r.stockCost, format: money });
  if (report.params.mode !== "money") columns.push({ label: "Нетто продажи, единица строки", block: "Продажи", value: r => r.salesQty });
  if (report.params.mode !== "quantity") columns.push(
    { label: "Себестоимость продаж, ₸", block: "Продажи", value: r => r.salesCost, format: money },
    { label: "Розничная выручка отдельно, ₸", block: "Выручка", value: r => r.revenue, format: money }
  );
  return columns;
}

async function writeAnalyticalTurnoverWorkbook(report: TurnoverReport, output: Writable): Promise<void> {
  if (output.destroyed) throw new Error("Excel download was closed");
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: true }) as StreamingWorkbook;
  const archive = workbook.zip;
  const canceled = new AbortController();
  const onError = (error: Error) => canceled.abort(error);
  const onClose = () => { if (!output.writableFinished) canceled.abort(new Error("Excel download was closed")); };
  output.once("error", onError);
  output.once("close", onClose);
  archive.once("error", onError);
  const interrupted = once(canceled.signal, "abort");
  const checkpoint = async () => { await setImmediate(); canceled.signal.throwIfAborted(); };
  let written = 0;
  try {
    workbook.creator = "Naliv Аналитика";
    workbook.created = new Date(report.generatedAt);
    const note = `Период [${report.params.from}, ${report.params.to}); сравнение [${report.comparison.from}, ${report.comparison.to}). n/a — данных нет или расчёт невозможен; 0 — известный ноль. Стоимость по себестоимости, выручка отдельно.`;
    if (report.params.groupBy === "day") {
      const main = table(workbook, "Оборачиваемость", dailyColumns(report), "Оборачиваемость запасов · по дням", note, canceled.signal);
      for (const row of report.daily) {
        if (!main.add(row)) { await main.nextPart(); main.add(row); }
        if (++written % 1024 === 0) await checkpoint();
      }
      await main.finish();
    } else {
      const main = table(workbook, "Оборачиваемость", reportColumns(report), "Оборачиваемость товарных запасов", note, canceled.signal);
      for (const row of report.rows) {
        if (!main.add(row)) { await main.nextPart(); main.add(row); }
        if (++written % 1024 === 0) await checkpoint();
      }
      await main.finish();
    }

    if (report.params.profile !== "summary") {
    type WindowRow = { row: TurnoverRow; window: TurnoverWindow };
    const windows: Column<WindowRow>[] = identityColumns(true).map(column => ({ ...column, value: r => column.value(r.row) }));
    windows.push(
      { label: "Длина окна, календарных дней", block: "Сопоставимые окна", value: r => r.window.days },
      { label: "Текущий интервал [с, по)", block: "Сопоставимые окна", value: r => `[${r.window.current.from}, ${r.window.current.to})`, width: 29 },
      { label: "Предыдущий интервал [с, по)", block: "Сопоставимые окна", value: r => `[${r.window.previous.from}, ${r.window.previous.to})`, width: 29 }
    );
    if (report.params.mode !== "money") windows.push(
      { label: "Нетто продажи сейчас", block: "Количество", value: r => r.window.sales.quantity },
      { label: "Нетто продажи раньше", block: "Количество", value: r => r.window.previousSales.quantity },
      { label: "Среднедневные продажи сейчас", block: "Количество", value: r => r.window.sales.averageDailyQty },
      { label: "Среднедневные продажи раньше", block: "Количество", value: r => r.window.previousSales.averageDailyQty },
      { label: "Изменение количества, % / статус", block: "Количество", value: r => changeValue(r.window.quantityChange), format: percent }
    );
    if (report.params.mode !== "quantity") windows.push(
      { label: "Себестоимость продаж сейчас, ₸", block: "Себестоимость", value: r => r.window.sales.cost, format: money },
      { label: "Себестоимость продаж раньше, ₸", block: "Себестоимость", value: r => r.window.previousSales.cost, format: money },
      { label: "Среднедневная себестоимость сейчас, ₸", block: "Себестоимость", value: r => r.window.sales.averageDailyCost, format: money },
      { label: "Среднедневная себестоимость раньше, ₸", block: "Себестоимость", value: r => r.window.previousSales.averageDailyCost, format: money },
      { label: "Изменение себестоимости, % / статус", block: "Себестоимость", value: r => changeValue(r.window.costChange), format: percent },
      { label: "Розничная выручка сейчас, ₸", block: "Выручка отдельно", value: r => r.window.sales.revenue, format: money },
      { label: "Розничная выручка раньше, ₸", block: "Выручка отдельно", value: r => r.window.previousSales.revenue, format: money }
    );
    const demand = table(workbook, "Продажи 7 14 30 дней", windows, "Динамика спроса · соседние равные интервалы", note, canceled.signal);
    for (const row of report.rows) for (const window of row.windows) {
      const value = { row, window };
      if (!demand.add(value)) { await demand.nextPart(); demand.add(value); }
      if (++written % 1024 === 0) await checkpoint();
    }
    await demand.finish();

    type DailyAudit = { row: TurnoverRow | null; day: TurnoverDailyRow };
    const audit: Column<DailyAudit>[] = [
      { label: "Магазин", block: "Товар", value: r => r.row?.storeName ?? "Вся отфильтрованная выборка", width: 32 },
      { label: "Склад", block: "Товар", value: r => r.row?.warehouseName ?? "По применённым фильтрам", width: 24 },
      { label: "Наименование", block: "Товар", value: r => r.row?.name ?? "Итого в одной единице учёта", width: 42 },
      { label: "SKU", block: "Товар", value: r => r.row?.sku ?? null, width: 38 },
      ...dailyColumns(report).map(column => ({ ...column, value: (r: DailyAudit) => column.value(r.day) }))
    ];
    const daily = table(workbook, "Ежедневные остатки", audit, "Ежедневные остатки · аудит среднего запаса", "Широкая выборка: итоги по единице учёта; для аудита SKU выберите конкретный товар. Вес краёв ½; среднее = взвешенная сумма / (N − 1). Один день — единственный остаток. Пропуск снимка не ноль. " + note, canceled.signal);
    if (report.rows.some(row => row.daily.length > 0)) {
      for (const row of report.rows) for (const day of row.daily) {
        const value = { row, day };
        if (!daily.add(value)) { await daily.nextPart(); daily.add(value); }
        if (++written % 1024 === 0) await checkpoint();
      }
    } else {
      for (const day of report.daily) {
        const value = { row: null, day };
        if (!daily.add(value)) { await daily.nextPart(); daily.add(value); }
        if (++written % 1024 === 0) await checkpoint();
      }
    }
    await daily.finish();

    const transfers = table<TurnoverTransfer>(workbook, "Перемещения", [
      { label: "SKU", block: "Товар", value: r => r.sku, width: 38 },
      { label: "Наименование", block: "Товар", value: r => r.name, width: 42 },
      { label: "Единица 1С", block: "Товар", value: r => r.unit },
      { label: "Из магазина", block: "Перемещение", value: r => r.fromStoreName, width: 35 },
      { label: "В магазин", block: "Перемещение", value: r => r.toStoreName, width: 35 },
      { label: "Рекомендуемое количество", block: "Перемещение", value: r => r.quantity }
    ], "Рекомендации межфилиальных перемещений", "Проверить доступность и логистику перед исполнением. Перемещения не включены в продажи. " + note, canceled.signal);
    for (const row of report.transfers) {
      if (!transfers.add(row)) { await transfers.nextPart(); transfers.add(row); }
      if (++written % 1024 === 0) await checkpoint();
    }
    await transfers.finish();
    }

    const parameters = table<[string, Value]>(workbook, "Параметры и методика", [
      { label: "Параметр", block: "Сохранённый запрос", value: r => r[0], width: 48 },
      { label: "Значение", block: "Сохранённый запрос", value: r => r[1], width: 110 }
    ], "Параметры, нормативы и ограничения расчёта", "Файл отражает сформированный отчёт, а не ещё не применённые изменения формы. Нормативы браузера включены в этот файл; первичные данные не изменяются. Большие таблицы продолжаются на листах с номером части.", canceled.signal);
    const optionName = (options: { key: string; name: string }[], key: string) => `${options.find(option => option.key === key)?.name ?? key} [${key}]`;
    const entries: [string, Value][] = [
      ["Период [с, по)", `[${report.params.from}, ${report.params.to})`],
      ["Сравнение [с, по)", `[${report.comparison.from}, ${report.comparison.to})`],
      ["Сформировано UTC", report.generatedAt],
      ["Профиль файла", report.params.profile === "summary"
        ? "Краткий: основной лист и параметры. Дополнительные листы не формировались."
        : "Полный: динамика 7/14/30, ежедневные остатки, перемещения и параметры."],
      ["Режим", report.params.mode ?? "both"], ["Детализация", report.params.groupBy ?? "sku"],
      ["Горизонт спроса, дней", report.params.horizon ?? 14], ["Риск", report.params.risk ?? "all"],
      ["Сортировка", report.params.sort ?? "turnover"],
      ["Магазины", report.params.store?.length ? report.params.store.map(key => optionName(report.options.stores, key)).join("; ") : "Вся сеть"],
      ["Охват магазинов", report.params.storeScope === "all"
        ? "Все физические подразделения, включая офисы и отделы"
        : "Розничная сеть: физические магазины с проведёнными розничными отчётами"],
      ["Исключать нулевые товары", report.params.excludeZero ? "Да" : "Нет"],
      ["Склад", report.params.warehouse ? optionName(report.options.warehouses, report.params.warehouse) : "Все склады"],
      ["Категория", report.params.category?.length ? report.params.category.map(key => optionName(report.options.categories, key)).join("; ") : "Все категории"],
      ["Бренд", report.params.brand ? optionName(report.options.brands, report.params.brand) : "Все бренды"],
      ["SKU", report.params.sku ? optionName(report.options.skus, report.params.sku) : "Все товары"],
      ["Поиск", report.params.search ?? ""],
      ["Строк в таблице", report.summary.rowCount], ["Покрытие снимками, %", report.summary.stockCoveragePct],
      ["Покрытие стоимости, %", report.summary.costCoveragePct],
      ["Пропущенные даты снимков", report.coverage.missingStockDates.join(", ")],
      ["История остатков с", report.coverage.firstStockDate], ["История остатков по", report.coverage.lastStockDate],
      ["История продаж с", report.coverage.firstSalesDate], ["История продаж по", report.coverage.lastSalesDate],
      ["Сравнение с примерами", "Применено ТЗ: каждый крайний остаток учитывается ровно с весом ½. Ошибочные SUM исходных Excel, дублирующие крайние остатки, и смешение выручки с себестоимостью не воспроизводятся."],
      ["Единицы", "Количество разных единиц учёта не суммируется. Отсутствующая единица не считается штуками."],
      ["Группы 30/60/90 дней", "Накопительные: товар ≥90 дней входит также в ≥60 и ≥30; суммы нельзя складывать."]
    ];
    for (const [key, value] of Object.entries(report.norms.defaults)) entries.push([`Норматив по умолчанию / ${key}`, value]);
    for (const [category, norms] of Object.entries(report.norms.categories)) {
      for (const [key, value] of Object.entries(norms)) entries.push([`${optionName(report.options.categories, category)} / ${key}`, value ?? null]);
    }
    for (const warning of report.warnings) entries.push(["Ограничение данных", warning]);
    for (const method of report.methodology) entries.push(["Методика", method]);
    for (const entry of entries) {
      if (!parameters.add(entry)) { await parameters.nextPart(); parameters.add(entry); }
    }
    await parameters.finish();
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

export async function writeTurnoverWorkbook(report: TurnoverReport, output: Writable): Promise<void> {
  if (report.params.profile === "sample") {
    await writeTurnoverSampleWorkbook(report, output);
    return;
  }
  await writeAnalyticalTurnoverWorkbook(report, output);
}
