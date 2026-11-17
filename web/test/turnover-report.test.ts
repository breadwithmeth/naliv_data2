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
    noSalesHistory: false, openingQty: 8, closingQty: 12, averageQty: 10,
    openingCost: 80, closingCost: 120, averageCost: 100,
    periodSales: { quantity: 25, cost: 250, revenue: 400, averageDailyQty: 12.5, averageDailyCost: 125 },
    turnoverQty: 2.5, turnoverQtyDays: 1.2, turnoverCost: 2.5, turnoverCostDays: 1.2,
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
    stagnantCost: { d30: 0, d60: 0, d90: 0 }, daily: []
  };
  return {
    params: { from: "2026-11-01", to: "2026-11-04", mode: "quantity", profile: "sample", groupBy: "sku" },
    comparison: { from: "2026-10-29", to: "2026-11-01", days: 3 },
    norms: { defaults: {
      minDays: 3, staleDays: 30, criticalStaleDays: 60, excessDays: 30, stopDays: 90,
      changePct: 20, targetDays: 14, highStockCost: null, leadTimeDays: null
    }, categories: {} },
    rows: [product], daily: [], transfers: [], totals: { overall: total, byUnit: [] },
    summary: { rowCount: 1, totalRowCount: 1, stagnantCount: 0, skuCount: 1, stockCost: 120,
      noSalesCount: 0, overstockCount: 0, deficitCount: 0, frozen30Cost: 0, frozen60Cost: 0,
      frozen90Cost: 0, costCoveragePct: 100, stockCoveragePct: 100 },
    options: { stores: [], warehouses: [], categories: [], brands: [], skus: [] },
    coverage: { firstStockDate: "2026-11-01", lastStockDate: "2026-11-03", firstSalesDate: "2026-11-01",
      lastSalesDate: "2026-11-03", missingStockDates: [], requestedTo: null, observedDays: 3, expectedDays: 3 },
    methodology: [], warnings: [], generatedAt: "2026-11-04T00:00:00.000Z"
  };
}

function render(data: TurnoverPreview, page = 0, detailed = false): string {
  return renderToStaticMarkup(createElement(TurnoverPreviewTable, { report: data, page, detailed, onPageChange: () => {} }));
}
function section(html: string, tag: string): string {
  const value = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  assert.ok(value, `missing ${tag}`);
  return value[1];
}

test("compact preview pages 100 product rows and retains server-wide totals on each page", () => {
  const data = report();
  data.rows = Array.from({ length: 101 }, (_, index) => row(index));
  data.totals.overall.periodSales = { ...data.totals.overall.periodSales, quantity: 2525 };
  const first = render(data);
  const second = render(data, 1);
  assert.equal((section(first, "tbody").match(/<tr[ >]/g) ?? []).length, 100);
  assert.equal((section(second, "tbody").match(/<tr[ >]/g) ?? []).length, 1);
  assert.doesNotMatch(section(first, "tbody"), /Товар 100</);
  assert.match(section(second, "tbody"), /Товар 100</);
  assert.equal(section(first, "tfoot"), section(second, "tfoot"));
  assert.match(section(second, "tfoot"), /2[\u00a0\u202f ]525/);
  assert.match(second, /По всему отбору, не только этой странице/);
  assert.match(second, /Страница 2 из 2/);
  assert.match(second, /role="region"[^>]*aria-label="Таблица оборачиваемости"[^>]*tabindex="0"/);
  assert.match(second, /<caption[^>]*>/);
  assert.match(second, /<th scope="col"/);
  const detailedFirst = render(data, 0, true);
  const detailedSecond = render(data, 1, true);
  assert.equal((section(detailedFirst, "tbody").match(/<tr[ >]/g) ?? []).length, 100);
  assert.equal((section(detailedSecond, "tbody").match(/<tr[ >]/g) ?? []).length, 1);
  assert.equal(section(detailedFirst, "tfoot"), section(detailedSecond, "tfoot"));
  assert.match(section(detailedSecond, "tfoot"), /2[\u00a0\u202f ]525/);
});

test("preview keeps shortening visible and all warnings in closed verification details", () => {
  const data = report();
  data.params.profile = "summary";
  data.coverage.requestedTo = "2026-11-06";
  data.warnings = ["Стоимость части товаров неизвестна.", "Часть остатков не загружена."];
  const html = render(data);
  assert.match(html, /01\.11\.2026 — 03\.11\.2026/);
  assert.match(html, /05\.11\.2026/);
  assert.match(html, /Период сокращён/);
  const details = html.match(/<details[^>]*>[\s\S]*?<\/details>/)?.[0];
  assert.ok(details);
  assert.doesNotMatch(details, /<details[^>]*\bopen/);
  assert.match(details, /Подробности проверки \(2\)/);
  assert.match(details, /Стоимость части товаров неизвестна/);
  assert.match(details, /Часть остатков не загружена/);
  assert.match(html, /Магазин А/);
  assert.match(html, />Магазин<\/th>/);
  assert.doesNotMatch(render(report()), />Магазин<\/th>/);
});

test("compact quantity preview shows primary metrics without identifiers or extra stock columns", () => {
  const html = render(report());
  assert.match(html, /Продажи с учётом возвратов/);
  assert.match(html, /Остаток на конец/);
  assert.match(html, /Оборотов за период/);
  assert.match(html, /Дней на оборот/);
  assert.doesNotMatch(html, /SKU|Артикул|article-0|sku-0|Средний запас|Остаток на начало/);
  assert.doesNotMatch(html, /n\/a/);
  const detailed = render(report(), 0, true);
  assert.match(detailed, /SKU: sku-0/);
  assert.match(detailed, /Артикул: article-0/);
  assert.match(detailed, /Средний запас/);
  assert.match(detailed, /Остаток на начало/);
  assert.equal((section(html, "tbody").match(/<td[ >]/g) ?? []).length, 5);
  assert.equal((section(detailed, "tbody").match(/<td[ >]/g) ?? []).length, 8);
});

test("money preview uses sales cost and keeps retail revenue only in detailed columns", () => {
  const data = report();
  data.params.mode = "money";
  const html = render(data);
  assert.match(html, /Продажи по себестоимости, ₸/);
  assert.doesNotMatch(html, /Розничная выручка|>Единица<\/th>/);
  assert.match(section(html, "tbody"), />250<\/td>/);
  assert.doesNotMatch(section(html, "tbody"), />400<\/td>/);
  const detailed = render(data, 0, true);
  assert.match(detailed, /Розничная выручка, ₸/);
  assert.match(section(detailed, "tbody"), />400<\/td>/);
  assert.equal((section(html, "tbody").match(/turnover-coefficient-orange/g) ?? []).length, 1);
});

test("both mode renders separate quantity and cost metrics with detailed additions to each", () => {
  const data = report();
  data.params.mode = "both";
  const compact = render(data);
  assert.match(compact, /Количество, в единицах товара/);
  assert.match(compact, /По себестоимости, ₸/);
  assert.match(section(compact, "tbody"), />25<\/td>/);
  assert.match(section(compact, "tbody"), />250<\/td>/);
  assert.match(section(compact, "tbody"), />12<\/td>/);
  assert.match(section(compact, "tbody"), />120<\/td>/);
  assert.equal((section(compact, "tbody").match(/turnover-coefficient-orange/g) ?? []).length, 2);
  assert.doesNotMatch(compact, /Розничная выручка|SKU/);
  const detailed = render(data, 0, true);
  assert.equal((section(detailed, "thead").match(/Средний запас/g) ?? []).length, 2);
  assert.match(detailed, /Розничная выручка, ₸/);
  assert.match(detailed, /SKU: sku-0/);
  assert.equal((section(detailed, "tbody").match(/<td[ >]/g) ?? []).length, 15);
});

test("coefficient color uses raw thresholds and unknown numbers have a neutral accessible dash", () => {
  const data = report();
  data.rows = [1.999, 2, 3, null, NaN, Infinity].map((value, index) => ({ ...row(index), turnoverQty: value }));
  const body = section(render(data), "tbody");
  assert.equal((body.match(/turnover-coefficient-red/g) ?? []).length, 1);
  assert.equal((body.match(/turnover-coefficient-orange/g) ?? []).length, 1);
  assert.equal((body.match(/turnover-coefficient-green/g) ?? []).length, 1);
  assert.match(body, /turnover-coefficient-red[^>]*>2</);
  assert.match(body, /turnover-visually-hidden">[^<]*Плохо/);
  assert.match(body, /turnover-visually-hidden">[^<]*Средне/);
  assert.match(body, /turnover-visually-hidden">[^<]*Хорошо/);
  assert.equal((body.match(/aria-label="Показатель не рассчитан"/g) ?? []).length, 3);
  assert.equal((body.match(/>1,2<\/td>/g) ?? []).length, 6);
  assert.doesNotMatch(body, /n\/a/);
});

test("missing identity values are omitted and returns are not explained as absent sales history", () => {
  const data = report();
  data.params.profile = "summary";
  Object.assign(data.rows[0], {
    sku: "", article: null, storeName: null, unit: null, noSalesHistory: true,
    turnoverQty: null, turnoverQtyDays: null,
    periodSales: { ...data.rows[0].periodSales, quantity: -3 }
  });
  const html = render(data, 0, true);
  assert.match(section(html, "tbody"), /Магазин не определён/);
  assert.match(section(html, "tbody"), /Единица не указана/);
  assert.doesNotMatch(section(html, "tbody"), /SKU:|Артикул:|n\/a|нет продаж|продаж не было|истори/);
  assert.match(section(html, "tbody"), />-3<\/td>/);
  assert.match(section(html, "tbody"), /aria-label="Показатель не рассчитан"/);
});

test("incompatible quantity totals retain per-unit subtotals without inventing an overall quantity", () => {
  const data = report();
  data.totals.byUnit = [
    { ...data.totals.overall, unitKey: "unit-pieces", unit: "шт." },
    { ...data.totals.overall, unitKey: "unit-kilograms", unit: "кг", openingQty: 6 }
  ];
  Object.assign(data.totals.overall, {
    unit: null, openingQty: null, closingQty: null, averageQty: null, turnoverQty: null, turnoverQtyDays: null,
    periodSales: { ...data.totals.overall.periodSales, quantity: null }
  });
  const html = render(data);
  const beforeTable = html.slice(0, html.indexOf("<table"));
  assert.match(beforeTable, /Общий итог количества не рассчитан/);
  assert.match(beforeTable, /шт\./);
  assert.match(beforeTable, /кг/);
  const footer = section(html, "tfoot");
  assert.equal((footer.match(/<tr[ >]/g) ?? []).length, 3);
  assert.match(footer, /Итого · шт\./);
  assert.match(footer, /Итого · кг/);
  assert.ok(footer.indexOf("Итого · кг") < footer.indexOf("ИТОГО"));
  assert.match(footer.slice(footer.indexOf("ИТОГО")), /aria-label="Показатель не рассчитан"/);
});

test("an unknown unit is not presented as proof of mixed units", () => {
  const data = report();
  data.rows[0].unit = null;
  Object.assign(data.totals.overall, {
    unit: null, openingQty: null, closingQty: null, averageQty: null, turnoverQty: null, turnoverQtyDays: null,
    periodSales: { ...data.totals.overall.periodSales, quantity: null }
  });
  const html = render(data);
  assert.match(html, /Единица не указана/);
  assert.match(html, /Общий итог количества не рассчитан/);
  assert.doesNotMatch(html, /[Рр]азные единицы|[Нн]есовместим/);
});

test("topline uses server totals rather than page rows or summary and preserves a known zero", () => {
  const data = report();
  data.totals.overall.periodSales = { ...data.totals.overall.periodSales, quantity: 2525 };
  data.totals.overall.closingQty = 0;
  const beforeTable = render(data).split("<table")[0];
  assert.match(beforeTable, /2[\u00a0\u202f ]525/);
  assert.match(beforeTable, /Остаток на конец[^<]*[\s\S]*?>0</);
  assert.doesNotMatch(beforeTable, />120</);
});

test("an empty selection displays recovery guidance without unknown summary or footer", () => {
  const data = report();
  data.rows = [];
  Object.assign(data.totals.overall, {
    unit: null, openingQty: null, closingQty: null, averageQty: null, turnoverQty: null, turnoverQtyDays: null,
    periodSales: { quantity: null, cost: null, revenue: null, averageDailyQty: null, averageDailyCost: null }
  });
  data.warnings = ["Ограничение источника"];
  const html = render(data);
  assert.match(section(html, "tbody"), /По выбранным условиям товаров нет/);
  assert.match(html, /Измените отбор/);
  assert.match(html, /Ограничение источника/);
  assert.doesNotMatch(html, /<tfoot|ИТОГО|aria-label="Показатель не рассчитан"/);
});

test("builder has one primary show submit and secondary Excel with advanced settings initially closed", () => {
  const html = renderToStaticMarkup(createElement(TurnoverReport, {
    dateRange: { from: "2026-11-01", to: "2026-11-03" }, onDateRangeChange: () => {}
  }));
  assert.match(html, /<button[^>]*type="submit"[^>]*turnover-primary[^>]*>Показать отчёт<\/button>/);
  assert.equal((html.match(/class="[^"]*turnover-primary/g) ?? []).length, 1);
  assert.match(html, /<button[^>]*type="button"[^>]*>[\s\S]*?Скачать Excel<\/button>/);
  assert.doesNotMatch(html, /<aside|Ваш Excel|Ответ из кэша|n\/a/);
  assert.match(html, />Количество</);
  assert.match(html, />Деньги</);
  const advancedStart = html.indexOf('<details class="turnover-advanced">');
  assert.ok(advancedStart >= 0);
  const advanced = html.slice(advancedStart, html.indexOf('<div class="turnover-download-actions"'));
  assert.doesNotMatch(advanced, /<details[^>]*\bopen/);
  assert.match(advanced, /Дополнительные настройки/);
  for (const label of ["Категории / группы товаров", "Склад", "Бренд", "По магазинам", "Включать офисы и отделы", "Исключить нулевые товары"]) {
    assert.ok(advanced.includes(label), `missing advanced setting ${label}`);
  }
  assert.doesNotMatch(advanced, /type="checkbox"[^>]*checked/);
});
