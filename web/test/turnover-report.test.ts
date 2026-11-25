import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test, type TestContext } from "node:test";
import ExcelJS from "exceljs";
import type { Locator, Page, Route } from "playwright";
import { turnoverCoefficientBand } from "../../api/src/services/turnover-domain";
import type { TurnoverPreview, TurnoverPreviewRow } from "../src/api";
import {
  previewPath, startTurnoverBrowser, workbookMime, workbookPath, type TurnoverBrowser, type TurnoverBrowserSession
} from "./turnover-browser";

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

// Setup: npm ci; npx playwright install chromium; npm run test:web:turnover.
// Alternatively set TURNOVER_CHROMIUM_EXECUTABLE to a local Chromium binary.
let browser: TurnoverBrowser;
before(async () => { browser = await startTurnoverBrowser(); });
after(async () => { await browser?.close(); });

const loadButton = (page: Page) => page.getByRole("button", { name: "Загрузить отчёт", exact: true });
const openButton = (page: Page) => page.getByRole("button", { name: "Открыть отчёт", exact: true });
const excelButton = (page: Page) => page.getByRole("button", { name: "Скачать Excel", exact: true });
const closeButton = (dialog: Locator) => dialog.getByRole("button", { name: "Закрыть", exact: true });
const expandAll = (dialog: Locator) => dialog.getByRole("button", { name: "Раскрыть всё", exact: true });
const collapseAll = (dialog: Locator) => dialog.getByRole("button", { name: "Свернуть всё", exact: true });
const products = (dialog: Locator) => dialog.locator("tbody .turnover-preview-product");
const groups = (dialog: Locator) => dialog.locator("tr[data-turnover-boundary=group] button");
const viewport = (dialog: Locator) => dialog.getByRole("region", { name: "Таблица оборачиваемости" });
const sticky = (dialog: Locator) => dialog.locator(".turnover-preview-sticky");
const pinnedGroup = (dialog: Locator) => sticky(dialog).locator(".turnover-group-toggle");
const overallTotals = (dialog: Locator) => dialog.getByRole("rowgroup", { name: "Итог по всему отбору", exact: true });
const storeTotals = (dialog: Locator) => dialog.locator('tbody:has(> tr[data-turnover-boundary="subtotal"])');
const quantityTotals = (scope: Locator) => scope.locator("tr.turnover-quantity-total");
const financialTotal = (scope: Locator) => scope.locator("tr.turnover-money-total");
const query = (route: Route) => new URL(route.request().url()).searchParams;
const frame = (page: Page) => page.evaluate(() => {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  return promise;
});

async function setDates(page: Page, from = "2026-11-01", to = "2026-11-03") {
  await page.locator('input[type="date"]').nth(0).fill(from);
  await page.locator('input[type="date"]').nth(1).fill(to);
}

async function session(t: TestContext, dates?: [string, string]) {
  const app = await browser.session(t);
  await app.goto();
  await loadButton(app.page).waitFor();
  await setDates(app.page, ...(dates ?? []));
  return app;
}

async function ready(app: TurnoverBrowserSession, data: TurnoverPreview) {
  const index = app.previews.count;
  await loadButton(app.page).click();
  const req = await app.previews.at(index);
  await req.fulfill({ json: data });
  await openButton(app.page).waitFor();
  return req;
}

async function open(page: Page) {
  await openButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Оборачиваемость" });
  await dialog.waitFor();
  return dialog;
}

async function view(t: TestContext, data: TurnoverPreview) {
  const to = new Date(Date.parse(data.params.to) - 86_400_000).toISOString().slice(0, 10);
  const app = await session(t, [data.params.from, to]);
  if (data.params.profile === "summary") await app.page.getByLabel("Разбить по магазинам").check();
  if (data.params.includeIncomplete) {
    await app.page.getByText("Дополнительные настройки", { exact: true }).click();
    await app.page.getByLabel("Включить строки без полного расчёта").check();
  }
  await ready(app, data);
  return { ...app, dialog: await open(app.page) };
}

function productRow(dialog: Locator, index: number) {
  return products(dialog).nth(index).locator("..");
}

function cellText(cells: Locator): Promise<string[]> {
  return cells.evaluateAll(cells => cells.map(cell => {
    const copy = cell.cloneNode(true) as HTMLElement;
    copy.querySelectorAll(".turnover-visually-hidden").forEach(label => label.remove());
    return (copy.textContent ?? "").trim().replace(/\s+/g, " ");
  }));
}

const cells = (row: Locator) => cellText(row.locator("td"));
const moneyCells = (row: Locator) => cellText(row.locator("td.turnover-money"));
const quantityCells = (row: Locator) => cellText(row.locator("td:not([colspan])"));

function names(dialog: Locator): Promise<string[]> {
  return products(dialog).evaluateAll(headers => headers.map(header => {
    const name = header.cloneNode(true) as HTMLElement;
    name.querySelector(".turnover-preview-unit")?.remove();
    return (name.textContent ?? "").trim();
  }));
}

function setRows(data: TurnoverPreview, rows: TurnoverPreviewRow[]) {
  data.rows = rows;
  data.summary.rowCount = data.summary.totalRowCount = rows.length;
  data.summary.skuCount = new Set(rows.map(item => item.sku).filter(Boolean)).size;
}

test("builder keeps advanced filters closed, applies inclusive dates and does not calculate on input", async t => {
  const app = await session(t);
  const { page } = app;
  const form = page.locator("form.turnover-form");
  const advanced = form.locator("details.turnover-advanced");
  assert.equal(await form.locator('button[type="submit"]').count(), 1);
  assert.equal(await form.locator('input[type="hidden"], input[type="radio"]').count(), 0);
  assert.equal(await form.locator("input[type=date]").count(), 2);
  assert.match(await form.textContent() ?? "", /Период.*Магазины.*Товар.*Разбить по магазинам/s);
  assert.equal(await advanced.evaluate(el => (el as HTMLDetailsElement).open), false);
  for (const label of ["Категории / группы товаров", "Склад", "Бренд", "Включать офисы и отделы",
    "Исключить нулевые товары", "Включить строки без полного расчёта"]) {
    assert.equal(await advanced.getByText(label, { exact: true }).first().isVisible(), false, label);
  }
  assert.equal(await advanced.locator("input:checked").count(), 0);
  assert.equal(await form.getByLabel("Разбить по магазинам").isChecked(), false);
  await form.locator("summary").filter({ hasText: /^Магазины/ }).click();
  await form.getByLabel("Магазин А", { exact: true }).check();
  assert.equal(await form.getByLabel("Разбить по магазинам").isChecked(), false);
  await form.locator("summary").filter({ hasText: /^Магазины/ }).click();
  await form.getByRole("searchbox", { name: "Товар", exact: true }).fill("  Coca  ");
  assert.equal(await openButton(page).count(), 0);
  assert.equal(await excelButton(page).count(), 0);
  assert.equal(await page.locator("dialog, .turnover-preview-table").count(), 0);
  assert.doesNotMatch(await form.textContent() ?? "", /Ваш Excel|Ответ из кэша|n\/a|Подробные столбцы|Как считается/);
  assert.equal(app.previews.count, 0);
  const request = await ready(app, report());
  assert.deepEqual(Object.fromEntries(query(request)), {
    from: "2026-11-01", to: "2026-11-04", storeScope: "retail", includeIncomplete: "false", search: "Coca",
    mode: "quantity", groupBy: "sku", sort: "name", profile: "sample", store: "store-a"
  });
  assert.equal(app.workbooks.count, 0);
  assert.equal(await page.locator("dialog[open], .turnover-preview-table").count(), 0);
  assert.equal(await excelButton(page).isEnabled(), true);
  await form.getByRole("searchbox", { name: "Товар", exact: true }).fill("Coca");
  assert.equal(await openButton(page).isEnabled(), true, "equivalent trimmed filters keep the ready report");
  await form.getByRole("searchbox", { name: "Товар", exact: true }).fill("other");
  assert.equal(await loadButton(page).isEnabled(), true);
  assert.equal(await openButton(page).count(), 0);
  assert.equal(await excelButton(page).count(), 0);
  assert.equal(app.previews.count, 1);
});

test("builder accepts 366 inclusive days but rejects one day and 367 days", async t => {
  const { page, previews } = await session(t);
  for (const [from, to, valid] of [
    ["2026-11-01", "2026-11-01", false],
    ["2025-11-01", "2026-11-01", true],
    ["2025-11-01", "2026-11-02", false]
  ] as const) {
    await setDates(page, from, to);
    assert.equal(await loadButton(page).isEnabled(), valid);
    await page.getByText(valid ? /обе даты включены.*366 дн\./i : "Выберите от 2 до 366 календарных дней.").waitFor();
  }
  assert.equal(previews.count, 0);
});

test("one category starts closed; original quantities precede the three stored cost metrics", async t => {
  const data = report();
  const item = data.rows[0];
  item.unit = "кг [fd33bbe6-8cd3-11e8-840d-3085a9455e10]";
  item.averageCost = 123.45;
  item.periodSales = { ...item.periodSales, cost: 150 };
  item.turnoverCost = 1.5;
  item.turnoverCostDays = 2.75;
  const { dialog } = await view(t, data);
  const table = dialog.getByRole("table", { name: /количество в единицах товара/ });
  assert.equal(await dialog.locator("table").count(), 1);
  assert.equal(await table.locator('tr[data-turnover-boundary="store"]').count(), 0);
  assert.equal(await dialog.getByRole("combobox").count(), 0);
  assert.equal(await viewport(dialog).getAttribute("tabindex"), "0");
  assert.deepEqual(await table.getByRole("columnheader").allTextContents(), [
    "Номенклатура", "Сумма остатков за период", "Средний товарный запас", "Коэффициент оборачиваемости",
    "Дней в периоде", "Продажи за период", "Дни оборота",
    "Средний запас, ₸", "Себестоимость продаж, ₸", "Дни оборота по себестоимости"
  ]);
  assert.equal(await products(dialog).count(), 0);
  assert.equal(await groups(dialog).count(), 1);
  assert.match(await groups(dialog).textContent() ?? "", /Верхняя группа.*1/s);
  assert.equal(await groups(dialog).getAttribute("aria-expanded"), "false");
  const days = dialog.getByRole("button", { name: "Показать дни (3)", exact: true });
  assert.equal(await days.getAttribute("aria-expanded"), "false");
  assert.equal(await days.getAttribute("aria-controls"), await table.getAttribute("id"));
  assert.equal(await dialog.locator(".turnover-preview-day").count(), 0);
  await groups(dialog).press("Enter");
  assert.equal(await groups(dialog).getAttribute("aria-expanded"), "true");
  assert.equal(await products(dialog).locator(".turnover-preview-unit").textContent(), "кг");
  const product = productRow(dialog, 0);
  assert.deepEqual(await cells(product), ["20", "10", "2,5", "3", "25", "1,2", "123,45", "150", "2,75"]);
  assert.deepEqual(await moneyCells(product), ["123,45", "150", "2,75"]);
  const footer = overallTotals(dialog);
  assert.equal(await footer.getByRole("row").count(), 2);
  assert.equal(await quantityTotals(footer).getByRole("rowheader").textContent(), "ИТОГО по всему отбору, шт.");
  assert.equal(await financialTotal(footer).getByRole("rowheader").textContent(), "ИТОГО по всему отбору, ₸");
  assert.deepEqual(await quantityCells(quantityTotals(footer)), ["20", "10", "2,5", "3", "25", "1,2"]);
  assert.deepEqual(await moneyCells(financialTotal(footer)), ["100", "250", "1,2"]);
  assert.doesNotMatch(await dialog.textContent() ?? "", /fd33bbe6|По стоимости|Розничная выручка|SKU|Артикул|sku-0|article-0|Подробные столбцы|Остаток на начало|Остаток на конец|Оборотов за период:|n\/a|Шкала коэффициента|\b400\b/);
  await days.click();
  assert.equal(await dialog.getByRole("button", { name: "Скрыть дни" }).getAttribute("aria-expanded"), "true");
  assert.deepEqual(await table.locator("thead .turnover-preview-date").allTextContents(), ["01.11.", "01.11. ½", "02.11.", "03.11. ½", "03.11."]);
  assert.deepEqual(await productRow(dialog, 0).locator(".turnover-preview-day").allTextContents(), ["8", "4", "10", "6", "12"]);
  await groups(dialog).press("Space");
  assert.equal(await products(dialog).count(), 0);
  assert.equal(await table.locator("thead .turnover-preview-date").count(), 5);
});

test("default quantity selection keeps confirmed idle stock and active rows with unvalued stock", async t => {
  const data = report();
  const idle = row(0);
  Object.assign(idle, { idleStock: true, turnoverQty: 0, turnoverQtyDays: null, turnoverCost: 0, turnoverCostDays: null,
    periodSales: { quantity: 0, cost: 0, revenue: 0, averageDailyQty: 0, averageDailyCost: 0 } });
  const active = row(1);
  active.averageCost = active.turnoverCost = active.turnoverCostDays = null;
  for (const day of active.daily) day.stockCost = null;
  setRows(data, [idle, active]);
  const { dialog } = await view(t, data);
  assert.match(await groups(dialog).innerText(), /без движения: 1/i);
  await expandAll(dialog).click();
  const item = products(dialog).nth(0);
  assert.match(await item.innerText(), /Без движения · остаток 12 шт/);
  assert.doesNotMatch(await products(dialog).nth(1).innerText(), /Без движения/);
  assert.deepEqual(await cells(productRow(dialog, 0)), ["20", "10", "0", "3", "0", "Без движения", "100", "0", "—"]);
  assert.deepEqual(await cells(productRow(dialog, 1)), ["20", "10", "2,5", "3", "25", "1,2", "—", "250", "—"]);
  assert.doesNotMatch(await productRow(dialog, 1).textContent() ?? "", /Без движения/);
});

test("inventory-entry provenance is visible on the estimated stock and its monetary total, never on sales", async t => {
  const data = report();
  const stock = { ...row(0), averageCost: 4411, stockCostFromEntry: true };
  setRows(data, [stock, row(1)]);
  Object.assign(data.totals.overall, { averageCost: 4511, stockCostFromEntry: true });
  const { dialog } = await view(t, data);
  await expandAll(dialog).click();
  const financial = productRow(dialog, 0).locator("td.turnover-money");
  assert.match(await financial.nth(0).innerText(), /4\s411\s+по оприходованию/i);
  assert.doesNotMatch(await financial.nth(1).innerText(), /оприходованию/i);
  assert.doesNotMatch(await productRow(dialog, 1).innerText(), /оприходованию/i);
  assert.match(await dialog.locator("tfoot .turnover-money-total").innerText(), /4\s511\s+по оприходованию/i);
});

test("known zero and signed returns stay numeric; missing quantity and cost use accessible dashes", async t => {
  const data = report();
  data.params.includeIncomplete = true;
  const missing = row(2);
  missing.daily[0].quantity = null;
  Object.assign(missing, {
    averageQty: null, turnoverQty: null, turnoverQtyDays: null, averageCost: 0, turnoverCostDays: null,
    periodSales: { ...missing.periodSales, quantity: 0, cost: 0 }
  });
  const returned = {
    ...row(3), noSalesHistory: true, turnoverCost: null, turnoverCostDays: null,
    periodSales: { ...row().periodSales, quantity: -3, cost: -15, revenue: -50 }
  };
  setRows(data, [missing, returned]);
  const { dialog } = await view(t, data);
  await expandAll(dialog).click();
  assert.equal(await productRow(dialog, 0).locator('[aria-label="Показатель не рассчитан"]').count(), 5);
  assert.equal((await cells(productRow(dialog, 0)))[4], "0");
  assert.equal((await cells(productRow(dialog, 1)))[4], "-3");
  assert.deepEqual(await moneyCells(productRow(dialog, 0)), ["0", "0", "—"]);
  assert.deepEqual(await moneyCells(productRow(dialog, 1)), ["100", "-15", "—"]);
  assert.equal(await productRow(dialog, 1).locator('.turnover-money [aria-label="Показатель не рассчитан"]').count(), 1);
  assert.match(await dialog.textContent() ?? "", /Включены строки без полного расчёта/);
  assert.doesNotMatch(await productRow(dialog, 1).textContent() ?? "", /нет продаж|продаж не было|истори|n\/a/);
  await dialog.getByRole("button", { name: "Показать дни (3)" }).click();
  assert.equal(await productRow(dialog, 0).locator('.turnover-preview-day [aria-label="Показатель не рассчитан"]').count(), 2);
});

test("coefficient bands depend on raw thresholds, never the rounded display", async t => {
  assert.equal(turnoverCoefficientBand(NaN), null);
  assert.equal(turnoverCoefficientBand(Infinity), null);
  const data = report();
  data.params.includeIncomplete = true;
  setRows(data, [-1, 0, 1, 1.999, 2, 2.999, 3, 3.01, null, NaN, Infinity]
    .map((value, index) => ({ ...row(index), turnoverQty: value })));
  const { dialog } = await view(t, data);
  await expandAll(dialog).click();
  const body = dialog.locator("tbody");
  for (const [band, label, count] of [["red", "Плохо", 3], ["orange", "Средне", 2], ["green", "Хорошо", 2]] as const) {
    const selected = body.locator(`.turnover-coefficient-${band}`);
    assert.equal(await selected.count(), count);
    assert.match(await selected.locator(".turnover-visually-hidden").first().textContent() ?? "", new RegExp(label));
  }
  assert.equal(await productRow(dialog, 3).locator(".turnover-coefficient-red").count(), 1);
  assert.equal((await cells(productRow(dialog, 3)))[2], "2");
  assert.equal((await cells(productRow(dialog, 0)))[2], "-1");
  assert.equal(await body.locator('[aria-label="Показатель не рассчитан"]').count(), 3);
  for (const index of [8, 9, 10]) assert.equal((await cells(productRow(dialog, index)))[2], "—");
  assert.equal((await cellText(body.locator("td:not(.turnover-money)"))).filter(value => value === "1,2").length, data.rows.length);
  assert.doesNotMatch((await body.allTextContents()).join(" "), /n\/a/);
});

test("two-day selection keeps both half-endpoints and uses authoritative overall totals", async t => {
  const data = report();
  data.params.from = "2026-10-31";
  data.params.to = "2026-11-02";
  const item = data.rows[0];
  item.daily = [100, 200].map((quantity, index) => ({
    ...item.daily[index], date: index ? "2026-11-01" : "2026-10-31", quantity, weight: 0.5
  }));
  Object.assign(item, { averageQty: 777, turnoverQty: 4, turnoverQtyDays: 0.5 });
  Object.assign(data.totals.overall, {
    daily: item.daily.map((day, index) => ({ ...day, quantity: index * 200 })),
    averageQty: 50, turnoverQty: 7, turnoverQtyDays: 0.43,
    periodSales: { ...data.totals.overall.periodSales, quantity: 350 }
  });
  const { dialog } = await view(t, data);
  await dialog.getByRole("button", { name: "Показать дни (2)" }).waitFor();
  await expandAll(dialog).click();
  assert.deepEqual(await cells(productRow(dialog, 0)), ["150", "777", "4", "2", "25", "0,5", "100", "250", "1,2"]);
  const footer = overallTotals(dialog);
  assert.deepEqual(await quantityCells(quantityTotals(footer)), ["100", "50", "7", "2", "350", "0,43"]);
  assert.deepEqual(await moneyCells(financialTotal(footer)), ["100", "250", "1,2"]);
  assert.doesNotMatch(await dialog.locator("header").allTextContents().then(value => value.join(" ")) ?? "", /350/);
});

test("shortened coverage and exclusions have one short notice; detailed warnings stay closed", async t => {
  const data = report();
  data.coverage.requestedTo = "2026-11-06";
  data.excludedIncompleteRows = 7;
  data.coverage.missingStockDates = ["2026-11-02"];
  data.warnings = [
    "Часть денежных показателей недоступна из-за пропусков снимков или учётных цен.",
    "Не во все дни выбранного периода есть проведённый розничный отчёт магазина."
  ];
  const app = await session(t, ["2026-11-01", "2026-11-05"]);
  await ready(app, data);
  const dialog = await open(app.page);
  assert.match(await dialog.textContent() ?? "", /01\.11\.2026 — 03\.11\.2026/);
  const notice = dialog.getByRole("status");
  assert.equal(await notice.count(), 1);
  assert.match(await notice.textContent() ?? "", /Период сокращён.*05\.11\.2026.*Исключено строк без полного расчёта: 7.*Нет дневных снимков остатков: 1 из 3/s);
  const summary = dialog.getByText("Предупреждения (2)", { exact: true });
  const details = data.warnings.map(warning => dialog.getByText(warning, { exact: true }));
  for (const detail of details) assert.equal(await detail.isVisible(), false);
  await summary.click();
  for (const detail of details) assert.equal(await detail.isVisible(), true);
});

test("incomplete selection hides ineligible quantity rows and withholds totals for a different population", async t => {
  const data = report();
  data.excludedIncompleteRows = 2;
  setRows(data, [
    { ...row(0), name: "Complete missing identity", sku: null, article: null },
    { ...row(1), name: "Unknown opening", openingQty: null },
    { ...row(2), name: "Unknown ratios", turnoverQtyDays: null },
    { ...row(3), name: "Nonfinite cost ignored in quantity", averageCost: Infinity }
  ]);
  const { page, dialog, ...app } = await view(t, data);
  await expandAll(dialog).click();
  assert.deepEqual(await names(dialog), ["Complete missing identity", "Nonfinite cost ignored in quantity"]);
  assert.equal(await dialog.locator('tbody td:not(.turnover-money) [aria-label="Показатель не рассчитан"]').count(), 0);
  assert.deepEqual(await moneyCells(productRow(dialog, 1)), ["—", "250", "1,2"]);
  assert.match(await dialog.textContent() ?? "", /Исключено строк без полного расчёта: 4/);
  const footer = overallTotals(dialog);
  assert.equal(await quantityTotals(footer).count(), 0);
  assert.equal(await financialTotal(footer).locator('[aria-label="Показатель не рассчитан"]').count(), 3);
  assert.deepEqual(await moneyCells(financialTotal(footer)), ["—", "—", "—"]);
  assert.match(await dialog.getByRole("status").textContent() ?? "", /Количественный итог недоступен/);
  await closeButton(dialog).click();
  await page.getByText("Дополнительные настройки", { exact: true }).click();
  await page.getByLabel("Включить строки без полного расчёта").check();
  data.params.includeIncomplete = true;
  await ready({ page, ...app }, data);
  const optedIn = await open(page);
  assert.equal(await products(optedIn).count(), 0);
  assert.equal(await optedIn.getByRole("button", { name: "Показать дни (3)" }).getAttribute("aria-expanded"), "false");
  await expandAll(optedIn).click();
  assert.deepEqual(await names(optedIn), data.rows.map(item => item.name));
  assert.ok(await optedIn.locator('tbody [aria-label="Показатель не рассчитан"]').count() > 0);
});

test("missing identifiers and units stay neutral and do not add quantitative columns", async t => {
  const data = report();
  data.params.includeIncomplete = true;
  data.params.profile = "summary";
  Object.assign(data.rows[0], { sku: "", article: null, storeKey: null, storeName: "Stale store name", unit: null,
    rootGroupKey: "unnamed", rootGroupName: "" });
  data.totals.overall.unit = null;
  data.totals.byStore = [{ storeKey: null, total: data.totals.overall, byUnit: [] }];
  const { dialog } = await view(t, data);
  await expandAll(dialog).click();
  assert.match(await dialog.textContent() ?? "", /Магазин не определён.*Группа без названия/s);
  assert.doesNotMatch(await dialog.textContent() ?? "", /SKU:|Артикул:|n\/a|Stale store name/);
  assert.equal(await dialog.getByRole("columnheader", { name: /^(Магазин|Единица)$/ }).count(), 0);
  assert.equal((await cells(productRow(dialog, 0))).length, 9);
  for (const [scope, label] of [
    [overallTotals(dialog), "ИТОГО по всему отбору, ₸"],
    [storeTotals(dialog), "ИТОГО по магазину, ₸"]
  ] as const) {
    assert.equal(await scope.getByRole("row").count(), 1);
    assert.equal(await quantityTotals(scope).count(), 0);
    assert.equal(await financialTotal(scope).getByRole("rowheader").textContent(), label);
    assert.deepEqual(await moneyCells(financialTotal(scope)), ["100", "250", "1,2"]);
  }
  assert.equal(await dialog.getByRole("combobox").count(), 0);
  assert.match(await dialog.getByRole("status").textContent() ?? "", /Количественный итог недоступен/);
  for (const span of await dialog.locator('th[scope="rowgroup"]').evaluateAll(headers => headers.map(header => (header as HTMLTableCellElement).colSpan))) {
    assert.equal(span, 10);
  }
});

test("an opted-in homogeneous server unit named N/A² still has scoped quantity totals", async t => {
  const data = report();
  Object.assign(data.params, { profile: "summary", includeIncomplete: true });
  const item = data.rows[0];
  item.unit = "N/A²";
  item.daily = item.daily.map(day => ({ ...day, unit: "N/A²", unitKey: "unit-n-a-squared" }));
  const total = { ...data.totals.overall, unit: item.unit, daily: item.daily };
  data.totals.overall = total;
  data.totals.byStore = [{ storeKey: item.storeKey, total, byUnit: [] }];
  const { dialog } = await view(t, data);
  for (const [scope, label] of [
    [overallTotals(dialog), "ИТОГО по всему отбору"],
    [storeTotals(dialog), "ИТОГО по магазину"]
  ] as const) {
    assert.equal(await quantityTotals(scope).getByRole("rowheader").textContent(), `${label}, N/A²`);
    assert.deepEqual(await quantityCells(quantityTotals(scope)), ["20", "10", "2,5", "3", "25", "1,2"]);
    assert.equal(await financialTotal(scope).getByRole("rowheader").textContent(), `${label}, ₸`);
  }
});

test("every keyed unit has its own quantity total and every scope has one independent financial total", async t => {
  const data = report();
  data.params.profile = "summary";
  const units = [
    { unitKey: "unit:pieces", unit: "шт", averageQty: 10, quantity: 109 },
    { unitKey: "unit-kilograms", unit: "кг", averageQty: 6, quantity: 15 },
    { unitKey: "unit-kilograms-other", unit: "кг", averageQty: null, quantity: null },
    { unitKey: "unit-litres", unit: "л", averageQty: 4, quantity: -9 },
    { unitKey: "unit-packs", unit: "упак", averageQty: 0, quantity: 0 },
    { unitKey: "unit-boxes", unit: "короб", averageQty: 12, quantity: 36 }
  ];
  const base = data.totals.overall;
  setRows(data, [
    ...units.map(({ unit }, index) => ({ ...row(index), unit })),
    { ...row(units.length), storeKey: "store-b", storeName: "Магазин Б" }
  ]);
  data.totals.byUnit = units.map(({ unitKey, unit, averageQty, quantity }, index) => ({
    ...base, unitKey, unit, averageQty, averageCost: 20 + index,
    daily: base.daily.map(day => ({ ...day, unit, quantity: averageQty })),
    periodSales: { ...base.periodSales, quantity, cost: 900 + index },
    turnoverQty: quantity === null || quantity < 0 ? null : quantity ? 2.5 : 0,
    turnoverQtyDays: quantity !== null && quantity > 0 ? 1.2 : null, turnoverCostDays: 33 + index
  }));
  data.totals.overall = {
    ...base, unit: null, daily: [], openingQty: null, closingQty: null, averageQty: null,
    turnoverQty: null, turnoverQtyDays: null, averageCost: 1234.5, turnoverCostDays: 4.75,
    periodSales: { ...base.periodSales, quantity: null, cost: 267.5, revenue: 9999 }
  };
  data.totals.byStore = [
    { storeKey: "store-a",
      total: { ...data.totals.overall, averageCost: 976.75, turnoverCostDays: null,
        periodSales: { ...data.totals.overall.periodSales, cost: -5.5 } },
      byUnit: data.totals.byUnit.map((unit, index) => ({
        ...unit, averageQty: unit.averageQty === null ? null : unit.averageQty / 2,
        daily: unit.daily.map(day => ({ ...day, quantity: day.quantity === null ? null : day.quantity / 2 })),
        periodSales: { ...unit.periodSales, quantity: [108, 14, null, -10, 0, 35][index] }
      })) },
    { storeKey: "store-b", byUnit: [],
      total: { ...base, averageCost: 0, turnoverCostDays: null,
        periodSales: { ...base.periodSales, cost: null, revenue: 8888, quantity: 12 } } }
  ];

  const { dialog } = await view(t, data);
  const overall = overallTotals(dialog);
  const subtotals = storeTotals(dialog);
  const firstStore = subtotals.nth(0);
  const secondStore = subtotals.nth(1);
  assert.equal(await products(dialog).count(), 0);
  assert.equal(await subtotals.count(), 2);
  assert.equal(await dialog.getByRole("combobox").count(), 1);
  assert.equal(await dialog.getByRole("combobox", { name: "Перейти к магазину", exact: true }).count(), 1);
  await dialog.getByRole("button", { name: "Показать дни (3)" }).click();

  const expected = [
    ["шт", ["10", "5", "10", "5", "10", "20", "10", "2,5", "3", "109", "1,2"],
      ["5", "2,5", "5", "2,5", "5", "10", "5", "2,5", "3", "108", "1,2"]],
    ["кг (1)", ["6", "3", "6", "3", "6", "12", "6", "2,5", "3", "15", "1,2"],
      ["3", "1,5", "3", "1,5", "3", "6", "3", "2,5", "3", "14", "1,2"]],
    ["кг (2)", ["—", "—", "—", "—", "—", "—", "—", "—", "3", "—", "—"],
      ["—", "—", "—", "—", "—", "—", "—", "—", "3", "—", "—"]],
    ["л", ["4", "2", "4", "2", "4", "8", "4", "—", "3", "-9", "—"],
      ["2", "1", "2", "1", "2", "4", "2", "—", "3", "-10", "—"]],
    ["упак", ["0", "0", "0", "0", "0", "0", "0", "0", "3", "0", "—"],
      ["0", "0", "0", "0", "0", "0", "0", "0", "3", "0", "—"]],
    ["короб", ["12", "6", "12", "6", "12", "24", "12", "2,5", "3", "36", "1,2"],
      ["6", "3", "6", "3", "6", "12", "6", "2,5", "3", "35", "1,2"]]
  ] as const;

  for (const [scope, label, money, units] of [
    [overall, "ИТОГО по всему отбору", ["1 234,5", "267,5", "4,75"],
      expected.map(([unit, values]) => [unit, values] as const)],
    [firstStore, "ИТОГО по магазину", ["976,75", "-5,5", "—"],
      expected.map(([unit, , values]) => [unit, values] as const)],
    [secondStore, "ИТОГО по магазину", ["0", "—", "—"],
      [["шт.", ["8", "4", "10", "6", "12", "20", "10", "2,5", "3", "12", "1,2"]]]]
  ] as const) {
    assert.equal(await scope.getByRole("row").count(), units.length + 1);
    assert.equal(await quantityTotals(scope).count(), units.length);
    assert.equal(await financialTotal(scope).count(), 1);
    for (const [unit, values] of units) {
      const total = scope.getByRole("rowheader", { name: `${label}, ${unit}`, exact: true }).locator("..");
      assert.equal(await total.count(), 1);
      assert.deepEqual(await quantityCells(total), values);
      assert.deepEqual(await cellText(total.locator('td[colspan="3"]')), [""]);
      assert.equal(await total.locator('[aria-label="Показатель не рассчитан"]').count(), values.filter(value => value === "—").length);
    }
    const financial = financialTotal(scope);
    assert.equal(await financial.getByRole("rowheader").textContent(), `${label}, ₸`);
    assert.deepEqual(await moneyCells(financial), money);
    assert.deepEqual(await cellText(financial.locator('td[colspan="11"]')), [""]);
  }
  await expandAll(dialog).click();
  const body = (await dialog.locator("tbody").allTextContents()).join(" ");
  assert.ok(body.indexOf("ИТОГО по магазину") > body.indexOf("Товар 5"));
  assert.ok(body.indexOf("ИТОГО по магазину") < body.indexOf("Товар 6"));
  assert.doesNotMatch(await dialog.textContent() ?? "", /unit:pieces|unit-kilograms|\b9 999\b|\b8 888\b/);
});

async function pairedReport(): Promise<TurnoverPreview> {
  try {
    return JSON.parse(await readFile(new URL("../../verify-out-paired/turnover-preview.json", import.meta.url), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const data = report();
  Object.assign(data.params, { profile: "summary", sort: "name" });
  setRows(data, Array.from({ length: 148 }, (_, index) => {
    const inStore = index % 74;
    const group = inStore < 30 ? "g1" : inStore < 60 ? "g2" : inStore < 73 ? "g3" : null;
    return { ...row(index), name: `Товар ${String(index).padStart(3, "0")}`, unit: inStore % 4 ? "шт" : "кг",
      storeKey: index < 74 ? "store-a" : "store-b", storeName: index < 74 ? "Магазин А" : "Магазин Б",
      rootGroupKey: group, rootGroupName: group === "g3" ? "Другая категория" : group === null ? "" : "Категория-тёзка" };
  }));
  data.totals.byUnit = [
    { ...data.totals.overall, unitKey: "unit:kg", unit: "кг" },
    { ...data.totals.overall, unitKey: "unit:pieces", unit: "шт" }
  ];
  data.totals.byStore = ["store-a", "store-b"].map(storeKey => ({
    storeKey, total: data.totals.overall, byUnit: data.totals.byUnit
  }));
  return data;
}

async function scrollToRow(dialog: Locator, row: Locator, fraction: number) {
  const scroll = await viewport(dialog).boundingBox();
  const target = await row.boundingBox();
  assert.ok(scroll && target);
  await viewport(dialog).evaluate((element, dy) => { element.scrollTop += dy; },
    target.y - scroll.y - scroll.height * fraction);
}

function scrollPosition(dialog: Locator) {
  return viewport(dialog).evaluate(element => [element.scrollTop, element.scrollLeft]);
}

function backgroundPosition(page: Page) {
  return page.evaluate(() => [window.scrollX, window.scrollY, document.body.getAttribute("style"),
    document.documentElement.getAttribute("style")]);
}

test("148 paired rows stay in server order, independently disclose keyed groups, and keep both axes on reopen", async t => {
  const data = await pairedReport();
  const app = await session(t);
  const { page, context } = app;
  await page.getByLabel("Разбить по магазинам").check();
  await page.getByText("Дополнительные настройки", { exact: true }).click();
  const initialUrl = page.url();
  const initialHistory = await page.evaluate(() => history.length);
  await ready(app, data);
  await openButton(page).scrollIntoViewIfNeeded();
  const background = await backgroundPosition(page);
  const dialog = await open(page);
  assert.equal(await dialog.evaluate(element => element.matches(":modal") && !element.closest("form")), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY), "hidden");
  assert.equal(await closeButton(dialog).evaluate(el => el === document.activeElement), true);
  assert.equal(await dialog.getByRole("heading", { name: "Оборачиваемость" }).count(), 1);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate(el => el.contains(document.activeElement)), true);
  }
  assert.equal(await context.pages().length, 1);
  assert.equal(page.url(), initialUrl);
  assert.equal(await page.evaluate(() => history.length), initialHistory);
  assert.match(await dialog.textContent() ?? "", /строк: 148/);
  assert.equal(await products(dialog).count(), 0);
  assert.equal(await expandAll(dialog).isEnabled(), true);
  assert.equal(await collapseAll(dialog).isEnabled(), false);
  assert.equal(await dialog.locator('tr[data-turnover-boundary="store"]').count(), 2);
  assert.equal(await groups(dialog).count(), 8);
  assert.equal(await groups(dialog).filter({ hasText: "Без группы" }).count(), 2);
  assert.equal(data.rows[0].rootGroupName, data.rows[30].rootGroupName);
  assert.notEqual(data.rows[0].rootGroupKey, data.rows[30].rootGroupKey);
  assert.equal(data.rows[0].rootGroupKey, data.rows[74].rootGroupKey);
  assert.equal(await financialTotal(dialog).count(), 3);
  const totalRows = dialog.locator("tr.turnover-quantity-total, tr.turnover-money-total");
  const collapsedTotals = await Promise.all((await totalRows.all()).map(cells));
  await groups(dialog).nth(0).click();
  assert.deepEqual(await names(dialog), data.rows.slice(0, 30).map(item => item.name));
  assert.equal(await groups(dialog).nth(1).getAttribute("aria-expanded"), "false");
  assert.equal(await groups(dialog).nth(4).getAttribute("aria-expanded"), "false");
  await groups(dialog).nth(4).click();
  assert.deepEqual(await names(dialog), [...data.rows.slice(0, 30), ...data.rows.slice(74, 104)].map(item => item.name));
  await groups(dialog).nth(3).click();
  assert.deepEqual(await names(dialog), [...data.rows.slice(0, 30), ...data.rows.slice(73, 104)].map(item => item.name));
  await expandAll(dialog).click();
  assert.equal(await expandAll(dialog).isEnabled(), false);
  assert.equal(await collapseAll(dialog).isEnabled(), true);
  assert.deepEqual(await names(dialog), data.rows.map(item => item.name));
  assert.equal(await dialog.getByRole("navigation", { name: /Страницы отчёта/ }).count(), 0);
  assert.deepEqual(await Promise.all((await totalRows.all()).map(cells)), collapsedTotals);
  const scroll = await viewport(dialog).boundingBox();
  assert.ok(scroll);
  for (const index of [0, 147, 100]) {
    const target = productRow(dialog, index);
    await scrollToRow(dialog, target, 0.55);
    const box = await target.boundingBox();
    assert.ok(box && box.y >= scroll.y && box.y + box.height <= scroll.y + scroll.height, `row ${index + 1} is reachable`);
  }
  await productRow(dialog, 100).locator("th").click();
  assert.equal(await dialog.isVisible(), true, "clicking inside does not dismiss the report");
  await dialog.getByRole("button", { name: "Показать дни (3)" }).click();
  await scrollToRow(dialog, productRow(dialog, 100), 0.55);
  await viewport(dialog).evaluate(element => { element.scrollLeft = 85; });
  const offsets = await scrollPosition(dialog);
  assert.ok(offsets[0] > 0 && offsets[1] > 0);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await openButton(page).evaluate(el => el === document.activeElement), true);
  assert.deepEqual(await backgroundPosition(page), background);
  const reopened = await open(page);
  assert.equal(await groups(reopened).nth(4).getAttribute("aria-expanded"), "true");
  assert.equal(await reopened.getByRole("button", { name: "Скрыть дни" }).isEnabled(), true);
  await frame(page);
  assert.deepEqual(await scrollPosition(reopened), offsets);
  assert.equal(app.previews.count, 1);
  await collapseAll(reopened).click();
  assert.equal(await products(reopened).count(), 0);
  assert.equal((await scrollPosition(reopened))[0], 0);
  await closeButton(reopened).click();
  await reopened.waitFor({ state: "hidden" });
  assert.deepEqual(await backgroundPosition(page), background);
});

test("same-named stores retain independent subtotals and accessible cell headers", async t => {
  const data = report();
  data.params.profile = "summary";
  const keys = ["store-a", "store-b"];
  setRows(data, keys.map((storeKey, i) => ({ ...row(i), storeKey, storeName: "Магазин" })));
  data.totals.byStore = keys.map((storeKey, i) => ({
    storeKey, byUnit: [], total: { ...data.totals.overall,
      periodSales: { ...data.totals.overall.periodSales, quantity: 12 + i, cost: 100 + i } }
  }));
  const { dialog } = await view(t, data);
  const sectionSequence = () => dialog.locator("tbody tr").evaluateAll(rows => rows.map(row => {
    if (row.matches(".turnover-quantity-total")) return row.querySelectorAll("td")[4].textContent;
    if (row.matches(".turnover-money-total")) return `₸ ${row.querySelectorAll("td.turnover-money")[1].textContent}`;
    return row.getAttribute("data-turnover-boundary") ?? row.querySelector("th")?.firstChild?.textContent;
  }));
  assert.deepEqual(await sectionSequence(), ["store", "group", "12", "₸ 100", "store", "group", "13", "₸ 101"]);
  await groups(dialog).nth(1).click();
  assert.deepEqual(await names(dialog), ["Товар 1"]);
  assert.deepEqual(await sectionSequence(), ["store", "group", "12", "₸ 100", "store", "group", "Товар 1", "13", "₸ 101"]);
  const item = data.rows[1];
  const product = productRow(dialog, 0);
  for (const [metric, label] of [
    [product.locator("td").nth(4), "Продажи за период"],
    [product.locator("td.turnover-money").nth(1), "Себестоимость продаж, ₸"]
  ] as const) {
    const headerText = await metric.evaluate(cell => (cell.getAttribute("headers") ?? "").split(/\s+/).map(id => {
      const header = document.getElementById(id);
      return header?.getAttribute("abbr") || header?.textContent?.trim();
    }));
    assert.deepEqual(headerText, [item.storeName, item.rootGroupName, `${item.name}${item.unit}`, label]);
  }
});

test("split-view store jump reaches keyed homonymous headings without recalculating or changing filters", async t => {
  const data = report();
  data.params.profile = "summary";
  const keys = ["store-a", "store-b", "store-c"];
  setRows(data, Array.from({ length: 150 }, (_, index) => ({
    ...row(index), storeKey: keys[Math.floor(index / 50)], storeName: index < 100 ? "Магазин-тёзка" : "Другой магазин"
  })));
  data.totals.byStore = keys.map(storeKey => ({ storeKey, total: data.totals.overall, byUnit: [] }));

  const app = await session(t);
  const { page, previews, workbooks } = app;
  const storeFilter = page.getByLabel("Разбить по магазинам");
  const searchFilter = page.getByRole("searchbox", { name: "Товар", exact: true });
  const builderDates = page.locator("form").filter({ has: searchFilter }).locator('input[type="date"]');
  await storeFilter.check();
  await searchFilter.fill("Товар");
  await ready(app, data);
  const dialog = await open(page);
  const storeHeadings = dialog.locator('tr[data-turnover-boundary="store"] th');
  assert.deepEqual(await storeHeadings.allTextContents(), ["Магазин-тёзка", "Магазин-тёзка", "Другой магазин"]);
  const ids = await storeHeadings.evaluateAll(headings => headings.map(heading => heading.id));
  assert.ok(ids.every(Boolean) && new Set(ids).size === 3);
  const jump = dialog.getByRole("combobox", { name: "Перейти к магазину", exact: true });
  assert.equal(await jump.evaluate(element => element.tagName), "SELECT");
  assert.deepEqual(await jump.locator("option").evaluateAll(options =>
    options.map(option => (option as HTMLOptionElement).value).filter(Boolean)
  ), ids);
  await jump.focus();
  await jump.press("ArrowDown");
  await jump.press("ArrowDown");
  assert.equal(await jump.inputValue(), ids[1], "keyboard selection can reach stores beyond the first");
  assert.ok(await jump.evaluate(element => element === document.activeElement));
  await groups(dialog).nth(0).click();
  await groups(dialog).nth(1).click();
  const expectedProducts = data.rows.slice(0, 100).map(item => item.name);
  const url = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const requests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url());
  });

  for (const index of [1, 0, 1]) {
    await jump.selectOption(ids[index]);
    await frame(page);
    const [target, head, scroll] = await Promise.all([
      storeHeadings.nth(index).boundingBox(), dialog.locator("thead").boundingBox(), viewport(dialog).boundingBox()
    ]);
    assert.ok(target && head && scroll);
    assert.ok(target.y >= head.y + head.height - 2 && target.y + target.height <= scroll.y + scroll.height,
      `store ${ids[index]} is visible below the pinned headings`);
    assert.deepEqual(await groups(dialog).evaluateAll(buttons =>
      buttons.map(button => button.getAttribute("aria-expanded"))), ["true", "true", "false"]);
  }
  assert.deepEqual(await names(dialog), expectedProducts);
  assert.equal(await dialog.getByRole("button", { name: "Показать дни (3)" }).getAttribute("aria-expanded"), "false");
  await closeButton(dialog).click();
  assert.equal(await openButton(page).isEnabled(), true);
  assert.equal(await storeFilter.isChecked(), true);
  assert.equal(await searchFilter.inputValue(), "Товар");
  assert.deepEqual(await builderDates.evaluateAll(inputs =>
    inputs.map(input => (input as HTMLInputElement).value)), ["2026-11-01", "2026-11-03"]);
  assert.equal(page.url(), url);
  assert.equal(await page.evaluate(() => history.length), historyLength);
  assert.deepEqual(requests, []);
  assert.equal(previews.count, 1);
  assert.equal(workbooks.count, 0);
});

test("sticky context follows store and subtotal boundaries; the final financial total is reachable", async t => {
  const data = report();
  Object.assign(data.params, { profile: "summary", sort: "name" });
  setRows(data, Array.from({ length: 150 }, (_, index) => ({
    ...row(index), storeKey: index < 75 ? "store-a" : "store-b",
    storeName: index < 75 ? "Магазин А" : "Магазин Б",
    rootGroupKey: index < 75 ? "root-a" : "root-b", rootGroupName: index < 75 ? "Первая группа" : "Вторая группа"
  })));
  data.totals.byStore = ["store-a", "store-b"].map(storeKey => ({ storeKey, total: data.totals.overall, byUnit: [] }));
  data.totals.overall = { ...data.totals.overall, unit: null };
  data.totals.byUnit = Array.from({ length: 4 }, (_, index) => ({
    ...data.totals.overall, unitKey: `unit-${index}`, unit: `Единица ${index}`
  }));
  const { page, dialog } = await view(t, data);
  const head = dialog.locator("thead");
  const scroll = viewport(dialog);
  await expandAll(dialog).click();
  await scrollToRow(dialog, productRow(dialog, 35), 0.3);
  await sticky(dialog).getByText("Магазин А", { exact: true }).waitFor();
  await sticky(dialog).getByRole("button", { name: /Первая группа/ }).waitFor();
  const [headBox, scrollBox, storeBox] = await Promise.all([
    head.boundingBox(), scroll.boundingBox(), sticky(dialog).locator(".turnover-preview-store").boundingBox()
  ]);
  assert.ok(headBox && scrollBox && storeBox && Math.abs(headBox.y - scrollBox.y) < 3,
    "column headers stay at the top of the scroller");
  const firstSubtotal = storeTotals(dialog).first();
  await scrollToRow(dialog, firstSubtotal, (headBox.height + storeBox.height) / scrollBox.height);
  await pinnedGroup(dialog).waitFor({ state: "hidden" });
  assert.equal(await sticky(dialog).getByText("Магазин А", { exact: true }).isVisible(), true);
  await scrollToRow(dialog, productRow(dialog, 110), 0.3);
  await sticky(dialog).getByText("Магазин Б", { exact: true }).waitFor();
  await sticky(dialog).getByRole("button", { name: /Вторая группа/ }).waitFor();
  assert.equal(await sticky(dialog).getByText("Магазин А", { exact: true }).isVisible(), false);
  assert.equal(await sticky(dialog).getByText("Первая группа", { exact: true }).isVisible(), false);
  const footer = overallTotals(dialog);
  assert.equal(await quantityTotals(footer).count(), 4);
  assert.equal(await financialTotal(footer).count(), 1);
  assert.equal(await footer.evaluate(element => element.previousElementSibling?.firstElementChild
    ?.getAttribute("data-turnover-boundary")), "subtotal");
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await frame(page);
  const [moneyBox, pinnedHead] = await Promise.all([financialTotal(footer).boundingBox(), head.boundingBox()]);
  assert.ok(moneyBox && pinnedHead && moneyBox.y >= pinnedHead.y + pinnedHead.height
    && moneyBox.y + moneyBox.height <= scrollBox.y + scrollBox.height + 1);
});

test("source and pinned categories respond across both scroll axes and return keyboard focus", async t => {
  const data = report();
  data.params.profile = "summary";
  setRows(data, Array.from({ length: 224 }, (_, index) => ({
    ...row(index), storeKey: index < 40 ? "store-a" : "store-b", storeName: "Магазин-тёзка",
    rootGroupKey: index < 120 ? "shared-root" : "other-root", rootGroupName: "Категория-тёзка"
  })));
  data.totals.byStore = ["store-a", "store-b"].map(storeKey => ({ storeKey, total: data.totals.overall, byUnit: [] }));
  const { page, dialog } = await view(t, data);
  const scroll = viewport(dialog);
  const source = groups(dialog).nth(1);
  const pinned = pinnedGroup(dialog);
  const expandedStates = () => groups(dialog).evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-expanded")));
  await groups(dialog).nth(0).press("Enter");
  await groups(dialog).nth(2).press("Space");
  await dialog.getByRole("button", { name: "Показать дни (3)" }).click();
  await scroll.evaluate(element => { element.scrollLeft = element.scrollWidth; });
  const [, horizontal] = await scrollPosition(dialog);
  assert.ok(horizontal > 0);
  const right = await scroll.evaluate(element =>
    element.getBoundingClientRect().left + element.clientLeft + element.clientWidth - 16);

  async function blankRightEdge(button: Locator) {
    const box = await button.boundingBox();
    assert.ok(box);
    const point = { x: right, y: box.y + box.height / 2 };
    assert.ok(await button.evaluate((expected, { x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && hit.closest("button") === expected && !hit.closest(".turnover-section-label, .turnover-group-count, svg");
    }, point), "the visible row's blank right edge hits its actual button");
    return point;
  }

  for (const activation of ["pointer", "Enter", "Space"] as const) {
    await scrollToRow(dialog, source, 0.5);
    await frame(page);
    const original = await blankRightEdge(source);
    await page.mouse.click(original.x, original.y);
    assert.deepEqual(await expandedStates(), ["true", "true", "true"]);
    await scrollToRow(dialog, productRow(dialog, 100), 0.5);
    await pinned.waitFor();
    await frame(page);
    const [deepTop, left] = await scrollPosition(dialog);
    assert.equal(left, horizontal);
    const [pinnedBox, storeBox, sourceBefore] = await Promise.all([
      pinned.boundingBox(), sticky(dialog).locator(".turnover-preview-store").boundingBox(), source.boundingBox()
    ]);
    assert.ok(pinnedBox && storeBox && sourceBefore && sourceBefore.y + sourceBefore.height < storeBox.y);
    assert.ok(pinnedBox.y >= storeBox.y + storeBox.height - 1);
    if (activation === "pointer") {
      const point = await blankRightEdge(pinned);
      await page.mouse.click(point.x, point.y);
    } else {
      await scroll.focus();
      await page.keyboard.press("Tab");
      assert.ok(await pinned.evaluate(button => button === document.activeElement));
      await page.keyboard.press(activation);
      assert.ok(await source.evaluate(button => button === document.activeElement));
    }
    await frame(page);
    assert.deepEqual(await expandedStates(), ["true", "false", "true"]);
    assert.deepEqual(await names(dialog), [...data.rows.slice(0, 40), ...data.rows.slice(120)].map(item => item.name));
    const sourceAfter = await source.boundingBox();
    assert.ok(sourceAfter && Math.abs(sourceAfter.y - pinnedBox.y) <= 2,
      "the original heading replaces its pinned copy immediately below the pinned stack");
    await blankRightEdge(source);
    const [anchoredTop, anchoredLeft] = await scrollPosition(dialog);
    assert.equal(anchoredLeft, horizontal);
    const maxTop = await scroll.evaluate(element => element.scrollHeight - element.clientHeight);
    assert.ok(anchoredTop > 0 && anchoredTop + 300 < deepTop && deepTop < maxTop,
      "collapse anchors the original heading even when the old offset would still be valid");

    if (activation === "pointer") {
      await page.mouse.move(original.x, original.y);
      await page.mouse.wheel(0, 160);
      await page.waitForFunction(top => document.querySelector(".turnover-preview-scroll")!.scrollTop >= top + 100, anchoredTop);
      const screen = page.viewportSize();
      assert.ok(screen);
      // A geometry change must not reapply the collapse anchor after the wheel moved it.
      await page.setViewportSize({ ...screen, height: screen.height - 40 });
      await frame(page);
      const [manualTop, manualLeft] = await scrollPosition(dialog);
      assert.ok(manualTop >= anchoredTop + 100, "manual scrolling is not pulled back to the collapsed heading");
      assert.equal(manualLeft, horizontal);
    }
  }
});

test("focus follows a pinned category across a scroll and returns to the viewport when none remains", async t => {
  const data = report();
  setRows(data, Array.from({ length: 180 }, (_, i) => ({
    ...row(i), rootGroupKey: `g${Math.floor(i / 60)}`, rootGroupName: `Раздел ${Math.floor(i / 60)}`
  })));
  const { dialog, page } = await view(t, data);
  await expandAll(dialog).click();
  const scroll = viewport(dialog), pinned = pinnedGroup(dialog);
  await scrollToRow(dialog, productRow(dialog, 30), 0.4);
  await pinned.focus();
  await scrollToRow(dialog, productRow(dialog, 90), 0.4);
  await frame(page);
  assert.match(await pinned.innerText(), /Раздел 1/);
  assert.ok(await pinned.evaluate(el => el === document.activeElement));
  await scroll.evaluate(el => { el.scrollTop = 0; });
  await pinned.waitFor({ state: "hidden" });
  assert.ok(await scroll.evaluate(el => el === document.activeElement));

  // Enter activates the still-focused original even after scrolling away from it.
  const source = groups(dialog).nth(1);
  await source.focus();
  await scrollToRow(dialog, productRow(dialog, 10), 0.5);
  await page.keyboard.press("Enter");
  await frame(page);
  assert.equal(await source.getAttribute("aria-expanded"), "false");
  const [button, region, head] = await Promise.all([source.boundingBox(), scroll.boundingBox(), dialog.locator("thead").boundingBox()]);
  assert.ok(button && region && head && button.y >= head.y + head.height - 2 && button.y + button.height <= region.y + region.height + 1);

  // A scroll with no wheel/pointer/key event (e.g. browser Find) also releases that anchor.
  await scrollToRow(dialog, productRow(dialog, 100), 0.4);
  await frame(page);
  const top = (await scrollPosition(dialog))[0];
  await page.setViewportSize({ width: 1365, height: 720 });
  await frame(page);
  assert.ok(Math.abs((await scrollPosition(dialog))[0] - top) < 3);
});

test("375 px mobile dialog scrolls both axes independently from the dashboard and wraps category names", async t => {
  const app = await browser.session(t, { width: 375 });
  const { page } = app;
  await app.goto();
  await loadButton(page).waitFor();
  await setDates(page);
  const data = report();
  const longName = "Длинное название категории для проверки переносов и доступности на небольшом экране ".repeat(4);
  setRows(data, Array.from({ length: 120 }, (_, index) => ({ ...row(index), rootGroupName: longName })));
  await ready(app, data);
  const dialog = await open(page);
  const viewportSize = page.viewportSize()!;
  const box = await dialog.boundingBox();
  assert.ok(box && box.x === 0 && box.width === viewportSize.width && Math.abs(box.height - viewportSize.height) <= 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  const heading = groups(dialog).locator(".turnover-section-label");
  const wrapped = await heading.evaluate(element => ({
    height: element.getBoundingClientRect().height, line: Number.parseFloat(getComputedStyle(element).lineHeight),
    overflow: element.scrollWidth > element.clientWidth + 1
  }));
  assert.ok(wrapped.height > wrapped.line * 2 && !wrapped.overflow);
  await expandAll(dialog).click();
  await dialog.getByRole("button", { name: "Показать дни (3)" }).click();
  await viewport(dialog).hover();
  await page.mouse.wheel(320, 440);
  await page.waitForFunction(() => {
    const scroll = document.querySelector(".turnover-preview-scroll");
    return scroll && scroll.scrollTop > 0 && scroll.scrollLeft > 0;
  });
  const offsets = await scrollPosition(dialog);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  await closeButton(dialog).click();
  await dialog.waitFor({ state: "hidden" });
  await open(page);
  await frame(page);
  assert.deepEqual(await scrollPosition(dialog), offsets);
});

test("5,000 unique SKUs × 31 days have contiguous data in a bounded DOM from start to end and back", async t => {
  const data = report();
  data.params.from = "2026-01-01";
  data.params.to = "2026-02-01";
  const salesAt = (index: number) => 25 + index % 17;
  const expected = Array.from({ length: 5_000 }, (_, index) => {
    const item = row(index);
    const group = Math.floor(index / 1_000);
    const quantity = 10 + index % 7;
    item.name = `Массовый SKU ${String(index).padStart(4, "0")}`;
    item.rootGroupKey = `group-${group}`;
    item.rootGroupName = `Категория ${group}`;
    item.averageQty = 20 + index % 5;
    item.periodSales.quantity = salesAt(index);
    item.averageCost = 200 + index % 11;
    item.periodSales.cost = 250 + index % 13;
    item.turnoverCostDays = 4.15;
    item.daily = Array.from({ length: 31 }, (_, day) => ({
      date: `2026-01-${String(day + 1).padStart(2, "0")}`,
      unit: "шт.", quantity: quantity + day, stockCost: 10 * (quantity + day),
      salesQty: 0, salesCost: 0, revenue: 0, weight: day === 0 || day === 30 ? 0.5 : 1
    }));
    return item;
  });
  setRows(data, expected);
  data.coverage.expectedDays = data.coverage.observedDays = 31;
  data.totals.overall.daily = expected[0].daily;
  data.totals.overall.periodSales.quantity = 125_030;
  data.totals.overall.periodSales.cost = 280_123.25;
  const { dialog, page, previews } = await view(t, data);
  assert.match(await dialog.textContent() ?? "", /строк: 5[\s\u00a0\u202f]000/);
  assert.equal(await products(dialog).count(), 0);
  await expandAll(dialog).click();
  await dialog.getByRole("button", { name: "Показать дни (31)" }).click();
  assert.equal(await dialog.locator("thead .turnover-preview-date").count(), 33);
  const blocks = dialog.locator("tbody[data-turnover-block]");
  const footer = overallTotals(dialog);
  const quantity = quantityTotals(footer);
  const money = financialTotal(footer);
  const total = await quantityCells(quantity);
  const financial = await moneyCells(money);
  assert.deepEqual(total.slice(-3, -1), ["31", "125 030"]);
  assert.deepEqual(financial, ["100", "280 123,25", "1,2"]);
  const counted = new Set<string>();
  for (const block of await blocks.all()) {
    const blockStart = Number(await block.getAttribute("data-turnover-block"));
    const blockEnd = Math.min(blockStart + 32, (Math.floor(blockStart / 1_000) + 1) * 1_000);
    await scrollToRow(dialog, block, 0.35);
    const heads = block.locator(".turnover-preview-product");
    await heads.last().waitFor({ state: "attached" });
    const visibleNames = await heads.evaluateAll(headers => headers.map(header => header.firstChild?.textContent));
    assert.deepEqual(visibleNames, expected.slice(blockStart, blockEnd).map(item => item.name));
    for (const name of visibleNames) {
      assert.ok(name && !counted.has(name), `duplicate SKU: ${name}`);
      counted.add(name);
    }
    assert.ok(await products(dialog).count() < 512, "only blocks near the viewport may mount product rows");
  }
  assert.equal(counted.size, 5_000);
  const distant = dialog.locator('tbody[data-turnover-block][aria-hidden="true"]');
  assert.ok(await distant.count() > 0);
  assert.ok(await distant.evaluateAll(blocks => blocks.every(block => block.children.length === 1)));
  assert.ok(await dialog.locator("tr").count() < 750, "spacers cannot mount a row per distant SKU");
  assert.equal(await groups(dialog).count(), 5);
  for (const index of [4_999, 2_501, 0]) {
    const groupStart = Math.floor(index / 1_000) * 1_000;
    const start = groupStart + Math.floor((index - groupStart) / 32) * 32;
    const block = blocks.and(dialog.locator(`[data-turnover-block="${start}"]`));
    await scrollToRow(dialog, block, 0.35);
    const item = block.locator(".turnover-preview-product").nth(index - start).locator("..");
    await item.waitFor({ state: "attached" });
    await scrollToRow(dialog, item, 0.6);
    const observed = await cells(item);
    assert.equal(observed[0], String(10 + index % 7));
    assert.equal(observed[32], String(40 + index % 7));
    assert.deepEqual(observed.slice(-9), [
      String(30 * (25 + index % 7)), String(20 + index % 5), "2,5", "31", String(salesAt(index)), "1,2",
      String(200 + index % 11), String(250 + index % 13), "4,15"
    ]);
    assert.equal(await dialog.locator(".turnover-preview-product").filter({ hasText: expected[index].name }).count(), 1);
  }
  await page.setViewportSize({ width: 1_050, height: 700 });
  await dialog.getByRole("button", { name: "Скрыть дни" }).click();
  assert.equal(await dialog.locator("thead .turnover-preview-date").count(), 0);
  const firstProduct = blocks.first().locator(".turnover-preview-product").first();
  await firstProduct.waitFor({ state: "attached" });
  assert.deepEqual(await cells(firstProduct.locator("..")), ["750", "20", "2,5", "31", "25", "1,2", "200", "250", "4,15"]);
  assert.deepEqual(await quantityCells(quantity), total.slice(-6));
  assert.deepEqual(await moneyCells(money), financial);
  assert.equal(previews.count, 1);
});

interface TransportTrace {
  aborted: string[];
  consumed: string[];
}

type TracedWindow = Window & { turnoverTransport: TransportTrace };

async function traceTransport(page: Page, surviveAbort = false) {
  await page.addInitScript(({ previewPath, workbookPath, surviveAbort }) => {
    const trace = (window as TracedWindow).turnoverTransport = { aborted: [], consumed: [] };
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const isPreview = url.pathname === previewPath;
      if (!isPreview && url.pathname !== workbookPath) return fetch(input, init);
      init?.signal?.addEventListener("abort", () => trace.aborted.push(url.href), { once: true });
      // Model a response whose transport already crossed the abort boundary.
      const response = await fetch(input, isPreview && surviveAbort ? { ...init, signal: undefined } : init);
      if (isPreview && surviveAbort) {
        const json = response.json.bind(response);
        response.json = async () => {
          const body = await json();
          trace.consumed.push(body.generatedAt);
          return body;
        };
      }
      return response;
    };
  }, { previewPath, workbookPath, surviveAbort });
}

async function assertAborted(page: Page, route: Route) {
  await page.waitForFunction(url => (window as TracedWindow).turnoverTransport.aborted.includes(url), route.request().url());
}

test("A → B → A ignores late results even when older transports still deliver their bodies", async t => {
  const app = await browser.session(t);
  const { page, previews, workbooks } = app;
  await traceTransport(page, true);
  await app.goto();
  await loadButton(page).waitFor();
  await setDates(page);
  const search = page.getByRole("searchbox", { name: "Товар", exact: true });
  const loading = page.getByText("Загружаем отчёт…", { exact: true });
  const captured: Route[] = [];
  for (const [index, value] of ["A", "B", "A"].entries()) {
    await search.fill(value);
    await loadButton(page).click();
    const request = await previews.at(index);
    assert.equal(query(request).get("search"), value);
    await loading.waitFor();
    captured.push(request);
  }
  await search.press("Enter");
  await search.press("Enter");
  assert.equal(previews.count, 3);
  assert.equal(await openButton(page).count(), 0);
  assert.equal(await excelButton(page).count(), 0);
  await assertAborted(page, captured[0]);
  await assertAborted(page, captured[1]);
  for (const index of [1, 0, 2]) {
    const data = report();
    data.generatedAt = `2026-11-04T0${index}:00:00.000Z`;
    data.rows[0].name = index === 2 ? "Current A" : `Stale ${index}`;
    await captured[index].fulfill({ json: data });
    await page.waitForFunction(tag => (window as TracedWindow).turnoverTransport.consumed.includes(tag), data.generatedAt);
    if (index !== 2) {
      await frame(page);
      assert.equal(await loading.isVisible(), true);
      assert.equal(await openButton(page).count(), 0);
    }
  }
  const dialog = await open(page);
  await expandAll(dialog).click();
  assert.deepEqual(await names(dialog), ["Current A"]);
  assert.equal(workbooks.count, 0);
});

test("JSON cancellation and failure never enable Excel; retry can load an empty selection", async t => {
  const app = await browser.session(t);
  const { page, previews } = app;
  await traceTransport(page);
  await app.goto();
  await loadButton(page).waitFor();
  await setDates(page);
  await loadButton(page).click();
  const cancelled = await previews.at(0);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await assertAborted(page, cancelled);
  assert.equal(await loadButton(page).isEnabled(), true);
  assert.equal(await excelButton(page).count(), 0);
  assert.equal(await page.getByRole("alert").count(), 0);
  await loadButton(page).click();
  await (await previews.at(1)).fulfill({ status: 422, json: { error: "Тестовая ошибка JSON" } });
  await page.getByRole("alert").filter({ hasText: "Тестовая ошибка JSON" }).waitFor();
  assert.equal(await openButton(page).count(), 0);
  assert.equal(await excelButton(page).count(), 0);
  const empty = report();
  setRows(empty, []);
  empty.warnings = ["Фильтрам не соответствуют наблюдаемые остатки."];
  await ready(app, empty);
  assert.equal(await excelButton(page).isEnabled(), true);
  const dialog = await open(page);
  await dialog.getByText(/По выбранным условиям товаров нет\. Закройте отчёт и измените параметры\./).waitFor();
  assert.equal(await dialog.locator('tfoot, th[scope="rowgroup"], [aria-label="Показатель не рассчитан"]').count(), 0);
  await dialog.getByText(/Предупреждения/).click();
  assert.equal(await dialog.getByText(empty.warnings[0]).isVisible(), true);
  await closeButton(dialog).click();
  const download = page.waitForEvent("download");
  await excelButton(page).click();
  const emptyBook = new ExcelJS.Workbook();
  emptyBook.addWorksheet("Кратко");
  await (await app.workbooks.at(0)).fulfill({
    contentType: workbookMime, headers: { "content-disposition": 'attachment; filename="empty.xlsx"' },
    body: Buffer.from(await emptyBook.xlsx.writeBuffer())
  });
  assert.equal((await download).suggestedFilename(), "empty.xlsx");
});

test("all-filtered results explain the calculation filter without an unavailable footer", async t => {
  const data = report();
  data.rows[0].turnoverQtyDays = null;
  const { dialog } = await view(t, data);
  assert.match(await dialog.textContent() ?? "", /Все строки.*исключены.*Закройте отчёт и измените параметры.*включить/s);
  assert.equal(await dialog.locator('tfoot, [aria-label="Показатель не рассчитан"]').count(), 0);
});

test("Excel cancel and error preserve the JSON; a collapsed report still downloads the full book once", async t => {
  const app = await browser.session(t);
  const { page, workbooks, previews } = app;
  await traceTransport(page);
  await app.goto();
  await loadButton(page).waitFor();
  await setDates(page);
  await page.getByRole("searchbox", { name: "Товар", exact: true }).fill("  Товар 0  ");
  await page.getByLabel("Разбить по магазинам").check();
  const data = report();
  data.params.profile = "summary";
  const preview = await ready(app, data);
  const dialog = await open(page);
  await expandAll(dialog).click();
  await collapseAll(dialog).click();
  assert.equal(await products(dialog).count(), 0);
  await closeButton(dialog).click();
  const downloads: string[] = [];
  page.on("download", event => downloads.push(event.suggestedFilename()));
  await excelButton(page).dblclick();
  const cancelled = await workbooks.at(0);
  assert.equal(await page.getByRole("button", { name: "Формируем Excel…" }).isEnabled(), false);
  assert.equal(workbooks.count, 1);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  await assertAborted(page, cancelled);
  assert.equal(await openButton(page).isEnabled(), true);
  await excelButton(page).click();
  const failed = await workbooks.at(1);
  await failed.fulfill({ status: 422, json: { error: "Тестовая ошибка Excel" } });
  await page.getByRole("alert").filter({ hasText: "Тестовая ошибка Excel" }).waitFor();
  await open(page);
  assert.equal(await products(dialog).count(), 0);
  await closeButton(dialog).click();
  const downloadEvent = page.waitForEvent("download");
  await excelButton(page).click();
  const request = await workbooks.at(2);
  for (const workbook of [cancelled, failed, request]) {
    assert.equal(query(workbook).toString(), query(preview).toString());
    assert.equal(workbook.request().headers().accept, workbookMime);
  }
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Кратко");
  workbook.addWorksheet("Товары").addRow([data.rows[0].name, 25]);
  const filename = "Оборачиваемость.xlsx";
  await request.fulfill({
    contentType: workbookMime,
    headers: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` },
    body: Buffer.from(await workbook.xlsx.writeBuffer())
  });
  const downloaded = await downloadEvent;
  assert.equal(downloaded.suggestedFilename(), filename);
  const result = new ExcelJS.Workbook();
  await result.xlsx.readFile(await downloaded.path());
  assert.deepEqual(result.getWorksheet("Товары")?.getRow(1).values, [, "Товар 0", 25]);
  assert.deepEqual(downloads, [filename]);
  assert.equal(previews.count, 1);
  assert.equal(workbooks.count, 3);
});

test("a legacy bookmark replaces the old query and cannot open a report without a signed-in session", async t => {
  const app = await browser.session(t, { signedIn: false, path: "/reports/turnover?from=2026-11-01&to=2026-11-03&search=Legacy" });
  const { page } = app;
  await page.addInitScript(() => {
    if (location.pathname === "/reports/turnover") sessionStorage.setItem("bookmarkHistory", String(history.length));
  });
  await app.goto();
  await page.getByRole("region", { name: "Авторизация" }).waitFor();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search + new URL(page.url()).hash, "/#stock/turnover");
  assert.equal(await page.evaluate(() => String(history.length) === sessionStorage.getItem("bookmarkHistory")), true);
  assert.equal(await loadButton(page).count(), 0);
  assert.equal(app.previews.count, 0);
  await page.getByLabel("Электронная почта").fill("turnover@example.test");
  await page.getByLabel("Пароль").fill("fixture-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await loadButton(page).waitFor();
  assert.equal(await page.getByRole("searchbox", { name: "Товар", exact: true }).inputValue(), "");
  assert.equal(await page.locator("dialog").count(), 0);
  assert.equal(app.previews.count, 0);
});

test("logout in another tab destroys an open dialog, aborts its Excel and resets the next session", async t => {
  const app = await browser.session(t);
  const { page, context, workbooks } = app;
  await traceTransport(page);
  await app.goto();
  await loadButton(page).waitFor();
  await setDates(page);
  await ready(app, report());
  await excelButton(page).click();
  const pending = await workbooks.at(0);
  const background = await backgroundPosition(page);
  const dialog = await open(page);
  await expandAll(dialog).click();
  const secondTab = await context.newPage();
  await traceTransport(secondTab);
  await secondTab.goto("/#stock/turnover");
  await loadButton(secondTab).waitFor();
  await setDates(secondTab);
  await loadButton(secondTab).click();
  const pendingPreview = await app.previews.at(1);
  await secondTab.locator(".account-menu summary").click();
  await secondTab.getByRole("button", { name: "Выйти", exact: true }).click();
  await page.getByRole("region", { name: "Авторизация" }).waitFor();
  await assertAborted(page, pending);
  await assertAborted(secondTab, pendingPreview);
  assert.equal(app.logoutCount, 1);
  assert.equal(await page.locator("dialog, .turnover-preview-table").count(), 0);
  assert.deepEqual((await backgroundPosition(page)).slice(2), background.slice(2));
  await page.getByLabel("Электронная почта").fill("turnover@example.test");
  await page.getByLabel("Пароль").fill("fixture-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await loadButton(page).waitFor();
  assert.equal(await openButton(page).count(), 0);
  assert.equal(await excelButton(page).count(), 0);
  assert.equal(app.previews.count, 2);
});
