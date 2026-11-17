import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnoverPreviewTable } from "../src/TurnoverReport";
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

function render(data: TurnoverPreview, page = 0): string {
  return renderToStaticMarkup(createElement(TurnoverPreviewTable, { report: data, page, onPageChange: () => {} }));
}
function section(html: string, tag: string): string {
  const value = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  assert.ok(value, `missing ${tag}`);
  return value[1];
}

test("preview pages only product rows and retains server-wide totals on each page", () => {
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
});

test("preview describes actual response period, truncation and warnings", () => {
  const data = report();
  data.params.profile = "summary";
  data.coverage.requestedTo = "2026-11-06";
  data.warnings = ["Стоимость части товаров неизвестна."];
  const html = render(data);
  assert.match(html, /01\.11\.2026 — 03\.11\.2026/);
  assert.match(html, /05\.11\.2026/);
  assert.match(html, /Стоимость части товаров неизвестна/);
  assert.match(html, /Магазин А/);
  assert.match(html, />Магазин<\/th>/);
  assert.doesNotMatch(render(report()), />Магазин<\/th>/);
});

test("money preview separates cost of net sales from retail revenue", () => {
  const data = report();
  data.params.mode = "money";
  const html = render(data);
  assert.match(html, /Нетто продажи по себестоимости/);
  assert.match(html, /Розничная выручка, ₸/);
  assert.match(html, /не числитель оборачиваемости/);
  assert.match(section(html, "tbody"), />250<\/td>/);
  assert.match(section(html, "tbody"), />400<\/td>/);
  assert.equal((section(html, "tbody").match(/turnover-coefficient-orange/g) ?? []).length, 1);
});

test("coefficient color uses raw thresholds and never colors turnover days or unknown values", () => {
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
  assert.equal((body.match(/>n\/a<\/td>/g) ?? []).length, 3);
  assert.equal((body.match(/>1,2<\/td>/g) ?? []).length, 6);
});

test("unit subtotals precede an unknown overall quantity without summing incompatible units", () => {
  const data = report();
  data.totals.byUnit = [
    { ...data.totals.overall, unitKey: "unit-pieces", unit: "шт." },
    { ...data.totals.overall, unitKey: "unit-kilograms", unit: "кг", openingQty: 6 }
  ];
  Object.assign(data.totals.overall, {
    unit: null, openingQty: null, closingQty: null, averageQty: null, turnoverQty: null, turnoverQtyDays: null,
    periodSales: { ...data.totals.overall.periodSales, quantity: null }
  });
  const footer = section(render(data), "tfoot");
  assert.equal((footer.match(/<tr[ >]/g) ?? []).length, 3);
  assert.match(footer, /Итого · шт\./);
  assert.match(footer, /Итого · кг/);
  assert.match(footer, /ИТОГО/);
  assert.ok(footer.indexOf("Итого · кг") < footer.indexOf("ИТОГО"));
  assert.match(footer.slice(footer.indexOf("ИТОГО")), />n\/a<\/td>/);
});

test("an empty selection displays explicit empty state and unknown totals", () => {
  const data = report();
  data.rows = [];
  Object.assign(data.totals.overall, {
    unit: null, openingQty: null, closingQty: null, averageQty: null, turnoverQty: null, turnoverQtyDays: null,
    periodSales: { quantity: null, cost: null, revenue: null, averageDailyQty: null, averageDailyCost: null }
  });
  const html = render(data);
  assert.match(section(html, "tbody"), /По выбранным условиям товаров нет/);
  assert.match(section(html, "tfoot"), /ИТОГО/);
  assert.doesNotMatch(section(html, "tfoot"), />0<\/td>/);
});
