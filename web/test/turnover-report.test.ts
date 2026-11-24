import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnoverPreviewTable, TurnoverReport } from "../src/TurnoverReport";
import type { TurnoverPreview, TurnoverPreviewRow } from "../src/api";

function row(index = 0): TurnoverPreviewRow {
  return {
    key: `row-${index}`, name: `Товар ${index}`, sku: `sku-${index}`, article: `article-${index}`,
    storeKey: "store-a", storeName: "Магазин А", categoryName: "Категория", unit: "шт.",
    rootGroupKey: "root", rootGroupName: "Верхняя группа",
    noSalesHistory: false, openingQty: 8, closingQty: 12, averageQty: 10,
    openingCost: 80, closingCost: 120, averageCost: 100,
    periodSales: { quantity: 25, cost: 250, revenue: 400, averageDailyQty: 12.5, averageDailyCost: 125 },
    turnoverQty: 2.5, turnoverQtyDays: 1.2, turnoverCost: 2.5, turnoverCostDays: 1.2,
    daily: [8, 10, 12].map((quantity, day) => ({ date: `2026-11-0${day + 1}`, unit: "шт.", quantity, stockCost: quantity * 10, salesQty: 0, salesCost: 0, revenue: 0, weight: day === 1 ? 1 : 0.5 })),
    stockDays: 1, risks: [], primaryAction: null
  };
}

function report(): TurnoverPreview {
  const product = row();
  const total: TurnoverPreview["totals"]["overall"] = {
    unit: "шт.", openingQty: 8, closingQty: 12, averageQty: 10,
    openingCost: 80, closingCost: 120, averageCost: 100,
    periodSales: product.periodSales, comparisonSales: product.periodSales,
    quantityChange: { pct: 0, status: "comparable" }, costChange: { pct: 0, status: "comparable" },
    turnoverQty: 2.5, turnoverQtyDays: 1.2, turnoverCost: 2.5, turnoverCostDays: 1.2,
    stockDays: 1, excessQty: 0, deficitQty: 0, recommendedOrderQty: 0, openOrderQty: 0,
    stagnantCost: { d30: 0, d60: 0, d90: 0 }, daily: product.daily.map((day) => ({ ...day }))
  };
  return {
    params: { from: "2026-11-01", to: "2026-11-04", mode: "quantity", profile: "sample", groupBy: "sku" },
    comparison: { from: "2026-10-29", to: "2026-11-01", days: 3 },
    norms: { defaults: {
      minDays: 3, staleDays: 30, criticalStaleDays: 60, excessDays: 30, stopDays: 90,
      changePct: 20, targetDays: 14, highStockCost: null, leadTimeDays: null
    }, categories: {} },
    rows: [product], daily: [], transfers: [], totals: { overall: total, byUnit: [], byStore: [] },
    summary: { rowCount: 1, totalRowCount: 1, stagnantCount: 0, skuCount: 1, stockCost: 120,
      noSalesCount: 0, overstockCount: 0, deficitCount: 0, frozen30Cost: 0, frozen60Cost: 0,
      frozen90Cost: 0, costCoveragePct: 100, stockCoveragePct: 100 },
    options: { stores: [], warehouses: [], categories: [], brands: [], skus: [] },
    coverage: { firstStockDate: "2026-11-01", lastStockDate: "2026-11-03", firstSalesDate: "2026-11-01",
      lastSalesDate: "2026-11-03", missingStockDates: [], requestedTo: null, observedDays: 3, expectedDays: 3 },
    methodology: [], warnings: [], generatedAt: "2026-11-04T00:00:00.000Z"
  };
}

function render(data: TurnoverPreview, page = 0): string {
  return renderToStaticMarkup(createElement(TurnoverPreviewTable, { report: data, page, onPageChange: () => {} }));
}
function section(html: string, tag: string): string {
  const value = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  assert.ok(value, `missing ${tag}`);
  return value[1];
}
function tables(html: string): string[] {
  return [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g)].map((match) => match[0]);
}
function productCells(html: string): string[] {
  const product = section(html, "tbody").match(/<tr><th scope="row" class="turnover-preview-product">[\s\S]*?<\/tr>/);
  assert.ok(product, "missing product row");
  return values(product[0]);
}
function values(html: string): string[] {
  return [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
    .map((match) => match[1].replace(/<span class="turnover-visually-hidden">[\s\S]*?<\/span>/g, "").replace(/<[^>]*>/g, ""));
}
function builder(to = "2026-11-03", from = "2026-11-01"): string {
  return renderToStaticMarkup(createElement(TurnoverReport, {
    dateRange: { from, to }, onDateRangeChange: () => {}
  }));
}

test("confirmed idle stock is visible by default and is not presented as zero turnover days", () => {
  const data = report();
  const product = data.rows[0]!;
  Object.assign(product, { idleStock: true, turnoverQty: 0, turnoverQtyDays: null,
    periodSales: { quantity: 0, cost: 0, revenue: 0, averageDailyQty: 0, averageDailyCost: 0 } });
  const cells = productCells(render(data));
  assert.deepEqual(cells.slice(-5), ["10", "0", "3", "0", "Без движения"]);
});

test("a network SKU with active sales and unvalued idle stock keeps its quantity and does not claim network inactivity", () => {
  const data = report();
  data.params.mode = "both";
  const product = data.rows[0]!;
  product.averageCost = product.turnoverCost = product.turnoverCostDays = null;
  for (const day of product.daily) day.stockCost = null;
  const html = render(data);
  assert.deepEqual(productCells(html), ["20", "—", "10", "—", "2,5", "—", "3", "25", "250", "1,2", "—"]);
  assert.doesNotMatch(html, /Без движения/);
});

test("the preview initially mounts no daily cells and shows the product's real base unit", () => {
  const data = report();
  data.rows[0].unit = "кг";
  const html = render(data);
  const headers = section(html, "thead");
  for (const label of ["Номенклатура", "Сумма остатков за период", "Средний товарный запас",
    "Коэффициент оборачиваемости", "Дней в периоде", "Продажи за период", "Дни оборота"]) {
    assert.ok(headers.includes(`>${label}</th>`), `missing standard column ${label}`);
  }
  assert.equal((headers.match(/<tr>/g) ?? []).length, 2);
  assert.doesNotMatch(headers, /01\.11\.|02\.11\.|03\.11\.|Магазин|Деньги/);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*aria-controls="([^"]+)"[^>]*>Показать дни \(3\)<\/button>/);
  const controlledId = html.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controlledId && html.includes(`id="${controlledId}"`));
  assert.match(section(html, "tbody"), /Товар 0[\s\S]*>кг<\/span>/);
  assert.deepEqual(productCells(html), ["20", "10", "2,5", "3", "25", "1,2"]);
  assert.doesNotMatch(html, /turnover-result-summary|turnover-preview-identifiers|Подробные столбцы|Розничная выручка|SKU|Артикул|article-0|sku-0|Остаток на начало|Остаток на конец|Оборотов за период:|<dl|n\/a/);
});

test("a two-day period uses both endpoint halves even while the daily columns are hidden", () => {
  const data = report();
  data.params.from = "2026-10-31";
  data.params.to = "2026-11-02";
  const product = data.rows[0]!;
  product.daily = [100, 200].map((quantity, index) => ({
    ...product.daily[index], date: index ? "2026-11-01" : "2026-10-31", quantity, weight: 0.5
  }));
  Object.assign(product, { averageQty: 777, turnoverQty: 4, turnoverQtyDays: 0.5 });
  data.totals.overall.daily = product.daily.map((day) => ({ ...day }));
  const html = render(data);
  assert.match(html, /Показать дни \(2\)/);
  assert.deepEqual(productCells(html), ["150", "777", "4", "2", "25", "0,5"]);
});

test("standard preview pages 100 products and repeats sections with unchanged authoritative totals", () => {
  const data = report();
  data.params.profile = "summary";
  data.params.mode = "both";
  data.rows = Array.from({ length: 101 }, (_, index) => row(index));
  data.totals.overall.periodSales = { ...data.totals.overall.periodSales, quantity: 2525 };
  data.totals.overall.averageQty = 900;
  data.totals.byStore = [{ storeKey: "store-a", total: data.totals.overall, byUnit: [] }];
  const first = render(data);
  const second = render(data, 1);
  assert.equal((section(first, "tbody").match(/scope="row" class="turnover-preview-product"/g) ?? []).length, 100);
  assert.equal((section(second, "tbody").match(/scope="row" class="turnover-preview-product"/g) ?? []).length, 1);
  for (const html of [first, second]) {
    const body = section(html, "tbody");
    assert.match(body, /scope="rowgroup"[^>]*>[\s\S]*?>Магазин А</);
    assert.match(body, /scope="rowgroup"[^>]*>[\s\S]*?>Верхняя группа</);
    assert.ok(body.indexOf("Магазин А") < body.indexOf("Верхняя группа"));
    assert.match(section(html, "tfoot"), />900<\/td>/);
    assert.match(section(html, "tfoot"), /2[\u00a0\u202f ]525/);
  }
  assert.doesNotMatch(section(first, "tbody"), /Товар 100</);
  assert.match(section(second, "tbody"), /Товар 100</);
  assert.doesNotMatch(section(first, "tbody"), /ИТОГО по магазину/);
  assert.match(section(second, "tbody"), /Товар 100<[\s\S]*ИТОГО по магазину[\s\S]*2[\u00a0\u202f ]525/);
  assert.equal(section(first, "tfoot"), section(second, "tfoot"));
  assert.match(second, /Страница 2 из 2/);
  assert.match(second, /role="region"[^>]*aria-label="Таблица оборачиваемости[^"]*"[^>]*tabindex="0"/);
  assert.match(second, /<caption[^>]*>/);
});

test("preview combines shortening and exclusions in one short notice and keeps full warnings closed", () => {
  const data = report();
  data.coverage.requestedTo = "2026-11-06";
  data.excludedIncompleteRows = 7;
  data.warnings = ["Стоимость части товаров неизвестна.", "Часть остатков не загружена."];
  const html = render(data);
  assert.match(html, /01\.11\.2026 — 03\.11\.2026/);
  assert.match(html, /Период сокращён[^<]*05\.11\.2026/);
  assert.match(html, /Исключено строк без полного расчёта: 7/);
  assert.equal((html.match(/<p class="turnover-message"/g) ?? []).length, 1);
  const details = section(html, "details");
  assert.match(details, /Подробности проверки \(2\)/);
  for (const warning of data.warnings) assert.ok(details.includes(warning));
  assert.doesNotMatch(html, /<details[^>]*\bopen/);
  const visible = html.replace(/<details[^>]*>[\s\S]*?<\/details>/g, "");
  assert.doesNotMatch(visible, /Стоимость части|Часть остатков/);
});

test("money standard table uses supplied stock cost and sales cost with an explicit cost-basis caption", () => {
  const data = report();
  data.params.mode = "money";
  const product = data.rows[0]!;
  product.periodSales = { ...product.periodSales, cost: 150 };
  product.turnoverCost = 1.5;
  product.turnoverCostDays = 2;
  const html = render(data);
  assert.match(section(html, "caption"), /стоимость по себестоимости, ₸/);
  assert.deepEqual(productCells(html), ["200", "100", "1,5", "3", "150", "2"]);
  assert.doesNotMatch(section(html, "tbody"), />400<\/td>/);
  assert.doesNotMatch(html, /Розничная выручка|SKU|Артикул|>Единица<\/th>|>Магазин<\/th>/);
});

test("both bases share one paired table, one period column and one authoritative footer", () => {
  const data = report();
  data.params.mode = "both";
  data.totals.overall.periodSales = { ...data.totals.overall.periodSales, quantity: 99, cost: 990 };
  const html = render(data);
  assert.equal(tables(html).length, 1);
  const headers = section(html, "thead");
  assert.equal((headers.match(/>Дней в периоде<\/th>/g) ?? []).length, 1);
  assert.equal((headers.match(/>По количеству<\/th>/g) ?? []).length, 2);
  assert.equal((headers.match(/>По стоимости<\/th>/g) ?? []).length, 2);
  assert.equal((headers.match(/>₸ по себестоимости<\/th>/g) ?? []).length, 3);
  assert.deepEqual(productCells(html), ["20", "200", "10", "100", "2,5", "2,5", "3", "25", "250", "1,2", "1,2"]);
  assert.match(section(html, "tfoot"), />99<\/td><td[^>]*>990<\/td>/);
  assert.equal((html.match(/aria-label="Страницы отчёта"/g) ?? []).length, 1);
});

test("coefficient color uses raw thresholds and unknown numbers have a neutral accessible dash", () => {
  const data = report();
  data.params.includeIncomplete = true;
  data.rows = [-1, 0, 1, 1.999, 2, 2.999, 3, 3.01, null, NaN, Infinity].map((value, index) => ({ ...row(index), turnoverQty: value }));
  const html = render(data);
  const body = section(html, "tbody");
  assert.equal((body.match(/turnover-coefficient-red/g) ?? []).length, 3);
  assert.equal((body.match(/turnover-coefficient-orange/g) ?? []).length, 2);
  assert.equal((body.match(/turnover-coefficient-green/g) ?? []).length, 2);
  assert.match(body, /turnover-coefficient-red[^>]*>2</, "display rounding does not set the status");
  assert.match(body, /<td class="turnover-numeric">-1<\/td>/);
  for (const label of ["Плохо", "Средне", "Хорошо"]) assert.match(body, new RegExp(`turnover-visually-hidden">[^<]*${label}`));
  for (const range of ["0 ≤ x < 2", "2 ≤ x < 3", "x ≥ 3"]) assert.ok(html.includes(range.replace("<", "&lt;")));
  assert.equal((body.match(/aria-label="Показатель не рассчитан"/g) ?? []).length, 3);
  assert.equal((body.match(/>1,2<\/td>/g) ?? []).length, data.rows.length);
  assert.doesNotMatch(body, /n\/a/);
});

test("standard daily and calculated nulls stay accessible while known zero and signed returns stay numeric", () => {
  const data = report();
  data.params.includeIncomplete = true;
  data.rows[0].daily[0].quantity = null;
  Object.assign(data.rows[0], {
    averageQty: null, turnoverQty: null, turnoverQtyDays: null,
    periodSales: { ...data.rows[0].periodSales, quantity: 0 }
  });
  let html = render(data);
  assert.equal((section(html, "tbody").match(/aria-label="Показатель не рассчитан"/g) ?? []).length, 4);
  assert.match(section(html, "tbody"), />0<\/td>/);
  assert.match(html, /Включены строки без полного расчёта/);
  data.rows[0].periodSales.quantity = -3;
  data.rows[0].noSalesHistory = true;
  html = render(data);
  assert.match(section(html, "tbody"), />-3<\/td>/);
  assert.doesNotMatch(html, /нет продаж|продаж не было|истори|n\/a/);
});

test("missing identifiers and unknown stores do not add columns or identifier noise", () => {
  const data = report();
  data.params.includeIncomplete = true;
  data.params.profile = "summary";
  Object.assign(data.rows[0], { sku: "", article: null, storeKey: null, storeName: "Stale store name", unit: null });
  const html = render(data);
  assert.match(section(html, "tbody"), /Магазин не определён/);
  assert.doesNotMatch(section(html, "tbody"), /SKU:|Артикул:|n\/a|Stale store name/);
  assert.doesNotMatch(section(html, "thead"), />Магазин<\/th>|>Единица<\/th>/);
  assert.equal(productCells(html).length, 6);
});

test("mixed totals present money once and keep quantities in their own unit rows", () => {
  const data = report();
  data.params.mode = "both";
  data.totals.byUnit = [
    { ...data.totals.overall, unitKey: "unit:pieces", unit: "шт",
      periodSales: { ...data.totals.overall.periodSales, quantity: 109 } },
    { ...data.totals.overall, unitKey: "unit-kilograms", unit: "кг", averageQty: 6,
      daily: data.totals.overall.daily.map((day) => ({ ...day, quantity: 6 })),
      periodSales: { ...data.totals.overall.periodSales, quantity: 15 } }
  ];
  Object.assign(data.totals.overall, {
    unit: null, openingQty: null, closingQty: null, averageQty: null, turnoverQty: null, turnoverQtyDays: null,
    periodSales: { ...data.totals.overall.periodSales, quantity: null }
  });
  data.params.profile = "summary";
  data.totals.byStore = [{ storeKey: "store-a", total: data.totals.overall, byUnit: data.totals.byUnit }];
  const html = render(data);
  const footer = section(html, "tfoot");
  assert.deepEqual([...footer.matchAll(/<th scope="row">(.*?)<\/th>/g)].map(match => match[1]),
    ["ИТОГО", "ИТОГО · шт", "ИТОГО · кг"]);
  assert.deepEqual([...footer.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(match => values(match[1]).slice(-5)), [
    ["3", "", "250", "", "1,2"],
    ["3", "109", "", "1,2", ""],
    ["3", "15", "", "1,2", ""]
  ]);
  assert.doesNotMatch(html, /unit:pieces|unit-kilograms/);
  const body = section(html, "tbody");
  assert.ok(body.indexOf("ИТОГО по магазину · шт") > body.indexOf("Товар 0"));
  assert.match(body, /ИТОГО по магазину · кг/);
  assert.doesNotMatch(html.split("<table")[0], /turnover-total|<dl/);
});

test("unknown units are labelled neutrally rather than declared incompatible", () => {
  const data = report();
  data.params.includeIncomplete = true;
  data.rows[0].unit = null;
  data.totals.overall.unit = null;
  const html = render(data);
  assert.match(section(html, "tfoot"), />ИТОГО</);
  assert.match(html, /разные или неизвестные единицы/);
});

test("standard footer uses daily totals and ratios rather than rows or summary", () => {
  const data = report();
  data.totals.overall.daily = [0, 50, 100].map((quantity, index) => ({ ...data.totals.overall.daily[index], quantity }));
  data.totals.overall.averageQty = 50;
  data.totals.overall.turnoverQty = 7;
  data.totals.overall.turnoverQtyDays = 0.43;
  data.totals.overall.periodSales = { ...data.totals.overall.periodSales, quantity: 350 };
  const html = render(data);
  const footer = section(html, "tfoot");
  assert.deepEqual(values(footer), ["100", "50", "7", "3", "350", "0,43"]);
  assert.doesNotMatch(html.split("<table")[0], /350|turnover-result-summary|<dl/);
});

test("empty selection displays recovery guidance without sections or unavailable footer", () => {
  const data = report();
  data.rows = [];
  data.warnings = ["Ограничение источника"];
  const html = render(data);
  assert.match(section(html, "tbody"), /По выбранным условиям товаров нет/);
  assert.match(html, /Измените отбор/);
  assert.match(section(html, "details"), /Ограничение источника/);
  assert.doesNotMatch(html, /<tfoot|ИТОГО|scope="rowgroup"|aria-label="Показатель не рассчитан"/);
});

test("builder exposes essential controls with one primary submit and all secondary filters initially closed", () => {
  const html = builder();
  assert.match(html, /<button[^>]*type="submit"[^>]*turnover-primary[^>]*>Показать отчёт<\/button>/);
  assert.equal((html.match(/class="[^"]*turnover-primary/g) ?? []).length, 1);
  assert.match(html, /<button[^>]*type="button"[^>]*>[\s\S]*?Скачать Excel<\/button>/);
  assert.doesNotMatch(html, /<aside|Ваш Excel|Ответ из кэша|n\/a|Подробные столбцы|Как считается/);
  const advancedStart = html.indexOf('<details class="turnover-advanced">');
  assert.ok(advancedStart >= 0);
  const essential = html.slice(0, advancedStart);
  for (const label of ["Период", "Магазины", "Товар", "Разбить по магазинам"]) {
    assert.ok(essential.includes(label), `missing essential control ${label}`);
  }
  assert.doesNotMatch(essential, /type="radio"|<legend>Показатели<\/legend>/);
  assert.equal((essential.match(/type="date"/g) ?? []).length, 2);
  const advanced = html.slice(advancedStart, html.indexOf('<div class="turnover-download-actions"'));
  assert.doesNotMatch(advanced, /<details[^>]*\bopen/);
  for (const label of ["Категории / группы товаров", "Склад", "Бренд", "Включать офисы и отделы", "Исключить нулевые товары", "Включить строки без полного расчёта"]) {
    assert.ok(advanced.includes(label), `missing advanced setting ${label}`);
    assert.ok(!essential.includes(label), `secondary setting outside advanced: ${label}`);
  }
  assert.doesNotMatch(advanced, /type="checkbox"[^>]*checked/);
});

test("builder requires at least two dates for the standard half-endpoint layout", () => {
  const html = builder("2026-11-01");
  assert.match(html, /Выберите от 2 до 366 календарных дней/);
  assert.match(html, /type="submit"[^>]*disabled/);
});

test("builder accepts a 366-day period across calendar years but rejects 367 days", () => {
  const largest = builder("2026-11-01", "2025-11-01");
  assert.match(largest, /366 дн\./);
  assert.doesNotMatch(largest, /type="submit"[^>]*disabled/);
  const tooLong = builder("2026-11-02", "2025-11-01");
  assert.match(tooLong, /Выберите от 2 до 366 календарных дней/);
  assert.match(tooLong, /type="submit"[^>]*disabled/);
});

test("default preview keeps calculation exclusions and optional identities independent of presentation", () => {
  const data = report();
  data.excludedIncompleteRows = 2;
  data.rows = [
    { ...row(0), name: "Complete missing identity", sku: null, article: null },
    { ...row(1), name: "Unknown opening", openingQty: null },
    { ...row(2), name: "Unknown ratios", turnoverQtyDays: null },
    { ...row(3), name: "Nonfinite cost ignored in quantity", averageCost: Infinity }
  ];
  const html = render(data);
  const body = section(html, "tbody");
  assert.match(body, /Complete missing identity/);
  assert.match(body, /Nonfinite cost ignored in quantity/);
  assert.doesNotMatch(body, /Unknown opening|Unknown ratios|Показатель не рассчитан/);
  assert.match(html, /Исключено строк без полного расчёта: 4/);
  assert.doesNotMatch(section(html, "tfoot"), />2,5</, "filtered DTO cannot keep totals for another population");
  assert.match(section(html, "tfoot"), /aria-label="Показатель не рассчитан"/);
  data.params.includeIncomplete = true;
  const optedIn = render(data);
  assert.match(section(optedIn, "tbody"), /Unknown opening/);
  assert.match(section(optedIn, "tbody"), /Unknown ratios/);
  assert.match(section(optedIn, "tbody"), /Показатель не рассчитан/);
});

test("all-filtered results explain exclusions without unavailable financial cells", () => {
  const data = report();
  data.rows[0].turnoverQtyDays = null;
  const html = render(data);
  assert.match(html, /Все строки.*исключены/);
  assert.match(html, /Включить строки без полного расчёта/);
  assert.doesNotMatch(html, /<tfoot|aria-label="Показатель не рассчитан"/);
});

test("store splitting stays visibly unchecked and independent of selected stores", () => {
  const html = builder();
  const index = html.indexOf("Разбить по магазинам");
  assert.ok(index >= 0 && index < html.indexOf('<details class="turnover-advanced">'));
  const control = html.slice(html.lastIndexOf("<input", index), index);
  assert.match(control, /type="checkbox"/);
  assert.doesNotMatch(control, /checked/);
  assert.doesNotMatch(html, /type="radio"[^>]*value="(?:sample|stores)"/);
});

test("section boundaries use identities rather than labels and span every standard column in both modes", () => {
  const data = report();
  data.params.sort = "name";
  data.rows = [
    { ...row(0), storeKey: "s1", storeName: "Одинаковый", rootGroupKey: "g1", rootGroupName: "Без группы" },
    { ...row(1), storeKey: "s1", storeName: "Одинаковый", rootGroupKey: null, rootGroupName: "Без группы" },
    { ...row(2), storeKey: "s2", storeName: "Одинаковый", rootGroupKey: "g1", rootGroupName: "Без группы" },
    { ...row(3), storeKey: null, storeName: "", rootGroupKey: "g2", rootGroupName: "" }
  ];
  for (const mode of ["quantity", "money", "both"] as const) {
    data.params.mode = mode;
    data.params.profile = "summary";
    const blocks = tables(render(data));
    assert.equal(blocks.length, 1);
    for (const block of blocks) {
      const body = section(block, "tbody");
      assert.equal((body.match(/class="turnover-preview-store"/g) ?? []).length, 3);
      assert.equal((body.match(/class="turnover-preview-group"/g) ?? []).length, 4);
      assert.equal((body.match(/scope="row" class="turnover-preview-product"/g) ?? []).length, 4);
      assert.match(body, /Магазин не определён/);
      assert.match(body, /Группа без названия/);
      const headers = [...body.matchAll(/scope="rowgroup" colSpan="(\d+)"/gi)];
      assert.equal(headers.length, 7);
      for (const header of headers) assert.equal(Number(header[1]), mode === "both" ? 12 : 7);
    }
    data.params.profile = "sample";
    for (const block of tables(render(data))) {
      const body = section(block, "tbody");
      assert.doesNotMatch(body, /class="turnover-preview-store"/);
      assert.equal((body.match(/scope="row" class="turnover-preview-product"/g) ?? []).length, 4);
    }
  }
  data.rows = [];
  assert.doesNotMatch(section(render(data), "tbody"), /scope="rowgroup"/);
});
