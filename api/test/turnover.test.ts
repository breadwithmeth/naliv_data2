import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";
import ExcelJS from "exceljs";
import {
  chronologicalAverage, completeTurnoverReport, isCompleteTurnoverDailyRow, isCompleteTurnoverRow,
  salesChange, sumNullable, turnoverRatios, turnoverSales
} from "../src/services/turnover-domain.js";
import type { TurnoverPreviewRow } from "../src/services/turnover-types.js";

// These regressions catch doubled endpoint columns, invented gap balances,
// division by zero, and percentages against returns-only comparison bases.

test("chronological average uses only positive closing balances and preserves half-weight endpoints", () => {
  assert.equal(chronologicalAverage([10, 30, 50]), 30);
  assert.equal(chronologicalAverage([0, 20, 20, 0]), 20);
  assert.equal(chronologicalAverage([10, 20, 0, -2]), 25 / 1.5);
  assert.equal(chronologicalAverage([0, 0, 30]), 30);
  assert.equal(chronologicalAverage([-3, 0]), 0);
  assert.equal(chronologicalAverage([0, 0]), 0);
  assert.equal(chronologicalAverage([12]), 12);
  assert.equal(chronologicalAverage([10, null, 50]), null);
  assert.equal(chronologicalAverage([]), null);
});

test("example workbook daily values follow the specification rather than duplicated endpoint SUM cells", () => {
  assert.equal(chronologicalAverage([
    91.5, 183, 150, 150, 150, 150, 150, 150, 150, 150,
    146, 143, 143, 143, 143, 143, 143, 143, 143, 143,
    84, 84, 84, 84, 84, 84, 84, 84, 84, 42
  ]), 125.47413793103448);
  assert.equal(chronologicalAverage([
    10, 20, 18, 18, 18, 18, 18, 16, 16, 16,
    15, 15, 15, 15, 15, 15, 15, 15, 13, 13,
    14, 14, 14, 14, 14, 14, 14, 14, 14, 7
  ]), 15.120689655172415);
  assert.equal(chronologicalAverage([
    15970.5, 14196, 14196, 12421.5, 23068.5, 18336.5, 18336.5, 14787.5, 14787.5, 11238.5,
    4732, 28392, 21885.5, 10055.5, 7689.5, 18336.5, 14787.5, 11830, 20111, 18928,
    18928, 17745, 28983.5, 21294, 18928, 17153.5, 8281, 1774.5, 591.5, 24251.5
  ]), 15582.965517241379);
});

test("turnover uses quantity or cost rather than revenue and never emits undefined ratios", () => {
  assert.deepEqual(turnoverRatios(12, 125.47413793103448, 30), {
    coefficient: 0.09563723806252147, days: 313.6853448275862
  });
  assert.deepEqual(turnoverRatios(0, 50, 30), { coefficient: 0, days: null });
  assert.deepEqual(turnoverRatios(10, 0, 30), { coefficient: null, days: null });
  assert.deepEqual(turnoverRatios(null, 10, 30), { coefficient: null, days: null });
  assert.deepEqual(turnoverRatios(-2, 10, 30), { coefficient: null, days: null });
});

test("sales changes distinguish new demand, absent baseline, and missing data", () => {
  assert.deepEqual(salesChange(12, 10), { pct: 20, status: "comparable" });
  assert.deepEqual(salesChange(0, 10), { pct: -100, status: "comparable" });
  assert.deepEqual(salesChange(5, 0), { pct: null, status: "new" });
  assert.deepEqual(salesChange(0, 0), { pct: null, status: "no-base" });
  assert.deepEqual(salesChange(5, -1), { pct: null, status: "no-base" });
  assert.deepEqual(salesChange(null, 10), { pct: null, status: "missing" });
});

test("nullable totals never discard an unknown or non-finite contributing value", () => {
  assert.equal(sumNullable([10, null, 30]), null);
  assert.equal(sumNullable([10, Number.NaN]), null);
  assert.equal(sumNullable([10, Number.POSITIVE_INFINITY]), null);
  assert.equal(sumNullable([Number.MAX_VALUE, Number.MAX_VALUE]), null);
  assert.equal(sumNullable([10, -3, 0]), 7);
});

test("period sales preserve independent unknown money and use the chronological denominator", () => {
  assert.deepEqual(turnoverSales(100, null, 1800, 2), {
    quantity: 100, cost: null, revenue: 1800, averageDailyQty: 50, averageDailyCost: null
  });
  assert.deepEqual(turnoverSales(null, 1000, 1800, 2), {
    quantity: null, cost: 1000, revenue: 1800, averageDailyQty: null, averageDailyCost: 500
  });
  assert.deepEqual(turnoverSales(3, 30, 45, 0), {
    quantity: 3, cost: 30, revenue: 45, averageDailyQty: 3, averageDailyCost: 30
  });
});

test("calculation completeness is mode-aware, ignores optional identities and accepts finite zero and signed values", () => {
  const row = {
    unit: "л", openingQty: 0, closingQty: -2, averageQty: 10,
    openingCost: 0, closingCost: -20, averageCost: 100,
    periodSales: { quantity: 5, cost: 50, revenue: -2, averageDailyQty: 2.5, averageDailyCost: 25 },
    turnoverQty: 0.5, turnoverQtyDays: 6, turnoverCost: 0.5, turnoverCostDays: 6
  } satisfies Pick<TurnoverPreviewRow, "unit" | "openingQty" | "closingQty" | "averageQty" |
    "openingCost" | "closingCost" | "averageCost" | "periodSales" | "turnoverQty" | "turnoverQtyDays" |
    "turnoverCost" | "turnoverCostDays">;
  assert.equal(isCompleteTurnoverRow(row, "both"), true);
  for (const field of ["openingQty", "closingQty", "averageQty", "turnoverQty", "turnoverQtyDays"] as const) {
    assert.equal(isCompleteTurnoverRow({ ...row, [field]: null }, "quantity"), false, field);
    assert.equal(isCompleteTurnoverRow({ ...row, [field]: null }, "money"), true, field);
  }
  for (const field of ["openingCost", "closingCost", "averageCost", "turnoverCost", "turnoverCostDays"] as const) {
    assert.equal(isCompleteTurnoverRow({ ...row, [field]: null }, "money"), false, field);
    assert.equal(isCompleteTurnoverRow({ ...row, [field]: null }, "quantity"), true, field);
  }
  for (const field of ["quantity", "averageDailyQty"] as const) {
    assert.equal(isCompleteTurnoverRow({ ...row, periodSales: { ...row.periodSales, [field]: null } }, "quantity"), false, field);
  }
  for (const field of ["cost", "revenue", "averageDailyCost"] as const) {
    assert.equal(isCompleteTurnoverRow({ ...row, periodSales: { ...row.periodSales, [field]: null } }, "money"), false, field);
  }
  for (const invalid of [null, NaN, Infinity, -Infinity]) {
    assert.equal(isCompleteTurnoverRow({ ...row, openingQty: invalid }, "quantity"), false);
    assert.equal(isCompleteTurnoverRow({ ...row, openingQty: invalid }, "money"), true);
    assert.equal(isCompleteTurnoverRow({ ...row, averageCost: invalid }, "money"), false);
    assert.equal(isCompleteTurnoverRow({ ...row, averageCost: invalid }, "quantity"), true);
    assert.equal(isCompleteTurnoverRow({ ...row, periodSales: { ...row.periodSales, revenue: invalid } }, "both"), false);
  }
  for (const unit of ["", "Единица не указана (SKU missing)", "n/a"]) {
    assert.equal(isCompleteTurnoverRow({ ...row, unit }, "quantity"), false);
    assert.equal(isCompleteTurnoverRow({ ...row, unit }, "money"), true);
  }
  assert.equal(isCompleteTurnoverRow({ ...row, turnoverQty: 0, turnoverQtyDays: null }, "quantity"), false);
  assert.equal(isCompleteTurnoverRow({ ...row, periodSales: { ...row.periodSales, quantity: -3 } }, "quantity"), true,
    "the classifier must not add a positive-sales rule; existing ratios decide calculability");
  const daily = { date: "2026-11-01", unit: "л", quantity: 0, stockCost: 0, salesQty: -2, salesCost: -20, revenue: -30, weight: 0.5 };
  assert.equal(isCompleteTurnoverDailyRow(daily, "both"), true);
  assert.equal(isCompleteTurnoverDailyRow({ ...daily, salesCost: null }, "quantity"), true);
  assert.equal(isCompleteTurnoverDailyRow({ ...daily, salesCost: null }, "money"), false);
});

test("default turnover population is filtered before daily, grouping and totals, with a distinct normalized opt-in cache identity", async (t) => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
  // This test exercises the module-loading boundary: configuration must exist
  // before Prisma/config singletons are loaded, and all SQL is replaced below.
  const { prisma } = await import("../src/prisma.js");
  const { getTurnoverPreview, getTurnoverReport, turnoverQuerySchema } = await import("../src/services/turnover.js");
  const { deliverTurnover } = await import("../src/services/turnover-delivery.js");
  const request = { from: "2026-11-01", to: "2026-11-04", mode: "both" as const };
  assert.equal(turnoverQuerySchema.parse(request).sort, "turnover");
  assert.equal(turnoverQuerySchema.parse({ ...request, sort: "name" }).sort, "name");
  assert.equal(turnoverQuerySchema.parse({ ...request, profile: "sample", sort: "stock-cost" }).sort, "name");
  assert.equal(turnoverQuerySchema.parse(request).includeIncomplete, false);
  assert.equal(turnoverQuerySchema.parse({ ...request, includeIncomplete: "false" }).includeIncomplete, false);
  assert.equal(turnoverQuerySchema.parse({ ...request, includeIncomplete: "true" }).includeIncomplete, true);
  assert.equal(turnoverQuerySchema.parse({ ...request, includeIncomplete: true }).includeIncomplete, true);
  assert.equal(turnoverQuerySchema.safeParse({ ...request, includeIncomplete: "yes" }).success, false);
  assert.notEqual(JSON.stringify(turnoverQuerySchema.parse(request)),
    JSON.stringify(turnoverQuerySchema.parse({ ...request, includeIncomplete: true })));
  const dates = ["2026-11-01", "2026-11-02", "2026-11-03"];
  let unavailableOpening = false;
  let unknownUnit = false;
  let mixedUnits = false;
  let duplicateLitres = false;
  let alternatePrice: number | null = null;
  let pieceLabel = "шт";
  let firstItemName = "complete";
  const source = () => ({
    items: ["complete", "missing-cost", "zero-sales", "returns"].map(key => ({
      key, name: key === "complete" ? firstItemName : key, parent: null, folder: false, article: null, code: null, group: "group", brand: null,
      unit: unknownUnit ? null : mixedUnits && key === "missing-cost" ? "piece" : "litre", minimums: {}
    })),
    stores: [{ key: "s", name: "Shop" }], warehouses: [], brands: [], groups: [{ key: "group", name: "Group" }],
    units: [{ key: "litre", name: "л" }, { key: "piece", name: pieceLabel }, { key: "fd33bbe6-8cd3-11e8-840d-3085a9455e10", name: "шт" },
      ...(duplicateLitres ? [{ key: "other-litre", name: "л" }] : [])],
    snapshots: unavailableOpening ? dates.slice(1).concat("2026-11-04") : [...dates, "2026-11-04"], selectedSkus: [],
    stock: ["complete", "missing-cost", "zero-sales", "returns"].map(sku => ["s", sku, "", [...dates, "2026-11-04"].map(date => [date, 10])]),
    sales: ["complete", "missing-cost", "zero-sales", "returns"].map(sku => ["s", sku, "", dates.map(date =>
      [date, sku === "zero-sales" ? 0 : sku === "returns" ? -1 : 2, sku === "zero-sales" ? 0 : sku === "returns" ? -15 : 30, sku !== "returns" && sku !== "zero-sales"])]),
    costs: ["complete", "zero-sales", "returns"].map(sku => [0, "s", sku, "", "2026-10-01T00:00:00", 10]),
    stockEntryEvidence: [],
    orders: [], receipts: [], idleStockActivity: [], lastSales: [], firstStock: [], salesDays: dates.map(date => ["s", date]),
    receiptDays: [], barcodes: [], bounds: { firstStock: dates[0], lastStock: "2026-11-04", firstSales: dates[0], lastSales: dates[2] }
  });
  const originalQuery = prisma.$queryRaw;
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = (async (run: (client: typeof prisma) => Promise<unknown>) => run(prisma)) as typeof originalTransaction;
  const originalUnsafeQuery = prisma.$queryRawUnsafe;
  prisma.$queryRawUnsafe = (async () => []) as typeof prisma.$queryRawUnsafe;
  let directoryRead = 0;
  let extraSkus: string[] = [];
  let previousFactRead = true;
  const pageSizes: number[] = [];
  let transferScenario = false;
  prisma.$queryRaw = (async (query: TemplateStringsArray | { sql: string; values: unknown[] }) => {
    if (!("sql" in query)) {
      const stage = directoryRead++ % 2;
      return transferScenario ? [{ key: "s", name: "Donor" }, { key: "r", name: "Receiver" }]
        : stage === 0 ? [{ key: "s", name: "Shop" }] : [{ key: "s" }];
    }
    const data = source();
    if (alternatePrice !== null) data.costs.push([0, "s", "missing-cost", "", "2026-10-01T00:00:00", alternatePrice]);
    if (transferScenario) {
      const history = Array.from({ length: 60 }, (_, index) =>
        new Date(Date.parse("2026-09-05T00:00:00Z") + index * 86_400_000).toISOString().slice(0, 10));
      const snapshots = [...history, "2026-11-04"];
      data.items = data.items.filter(item => item.key === "complete");
      data.snapshots = snapshots;
      data.stock = [["s", "complete", "", snapshots.map(date => [date, 100])],
        ["r", "complete", "", snapshots.map(date => [date, 1])]];
      data.sales = ["s", "r"].map(store => [store, "complete", "", history.map(date => [date, 1, 15, true])]);
      data.salesDays = ["s", "r"].flatMap(store => history.map(date => [store, date]));
      data.costs = [[0, "r", "complete", "", "2026-09-01T00:00:00", 10]];
    }
    const { stock, sales, costs, stockEntryEvidence, orders, receipts, lastSales, firstStock, barcodes, ...context } = data;
    if (query.sql.includes("'batchSkus'")) {
      return [{ data: { ...context, batchSkus: [...data.items.map(item => item.key), ...extraSkus] } }];
    }
    const keys = query.values.find(Array.isArray) as string[];
    assert.ok(keys?.length, "fact reads must bind a nonempty SKU partition");
    assert.ok(previousFactRead, "process the previous fact packet before fetching another");
    for (const key of keys) if (extraSkus.includes(key)) stock.push(["s", key, "", [["2026-11-04", 1]]]);
    const page = {
      stock: stock.filter(row => keys.includes(String(row[1]))), sales: sales.filter(row => keys.includes(String(row[1]))),
      costs: costs.filter(row => keys.includes(String(row[2]))), stockEntryEvidence, orders, receipts, lastSales, firstStock, barcodes
    };
    if (extraSkus.length) {
      pageSizes.push(keys.length);
      previousFactRead = false;
      const values = page.stock;
      Object.defineProperty(page, "stock", { get() { previousFactRead = true; return values; } });
    }
    return [{ data: page }];
  }) as typeof prisma.$queryRaw;
  const reloadReader = async () => ({
    status: "needs_preparation" as const, from: "2026-06-01", toExclusive: null, completedJobs: 0, totalJobs: 0,
    sources: [], databaseBytes: 0, pauseAtBytes: 9_000_000_000, binding: "test-unverified", returnPriceIntervals: [], coverageSources: []
  });
  try {
    await t.test("each all-store SKU partition is consumed before the next read; unknown units still veto totals", async () => {
      extraSkus = Array.from({ length: 65 }, (_, n) => `source-only-${n}`);
      try {
        const report = await getTurnoverReport({ ...request, includeIncomplete: true }, reloadReader);
        assert.ok(pageSizes.length > 1);
        assert.equal(report.rows.length, 69);
        assert.equal(report.rows.filter(row => row.sku?.startsWith("source-only-")).length, 65);
        assert.equal(report.totals.overall.closingQty, null);
        assert.equal(report.totals.overall.periodSales.quantity, null);
        assert.equal(report.totals.overall.periodSales.revenue, 135);
      } finally { extraSkus = []; }
    });
    await t.test("worker delivers preview, row and raw XLSX with the same selected turnover values", async () => {
      const download = async (kind: Parameters<typeof deliverTurnover>[0], query: unknown) => {
        const output = new PassThrough();
        let metadata: Record<string, string> | undefined;
        const [bytes] = await Promise.all([
          buffer(output),
          deliverTurnover(kind, query, output, values => { metadata = values; })
        ]);
        assert.ok(metadata);
        return { bytes, metadata };
      };
      const preview = JSON.parse((await download("turnover-preview", request)).bytes.toString());
      assert.equal(preview.summary.rowCount, 1);
      assert.equal(preview.rows[0].periodSales.cost, 60);
      const detail = JSON.parse((await download("turnover-row", { ...request, auditGroup: preview.rows[0].key })).bytes.toString());
      assert.equal(detail.row.sku, "complete");
      assert.equal(detail.row.periodSales.cost, 60);

      const { bytes, metadata } = await download("turnover-xlsx", request);
      assert.equal(metadata["X-Report-Rows"], "1");
      assert.equal(metadata["Content-Type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      assert.match(metadata["Content-Disposition"], /filename="turnover_2026-11-01_2026-11-04\.xlsx"/);
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(bytes);
      const parameters = book.getWorksheet("Параметры и методика")!;
      let generatedAt: ExcelJS.CellValue = null;
      parameters.eachRow(row => { if (row.getCell(1).value === "Сформировано UTC") generatedAt = row.getCell(2).value; });
      assert.ok(metadata["X-Report-Generated-At"]);
      assert.equal(generatedAt, metadata["X-Report-Generated-At"]);
      assert.equal(book.getWorksheet("Оборачиваемость")!.getCell("T5").value, 60);
    });
    for (const profile of ["summary", "full"] as const) for (const groupBy of ["sku", "store", "category", "brand", "day"] as const) {
      const report = await getTurnoverReport({ ...request, profile, groupBy }, reloadReader);
      assert.equal(report.excludedIncompleteRows, 3);
      assert.equal(report.totals.overall.periodSales.quantity, 6);
      assert.equal(report.totals.overall.periodSales.cost, 60);
      assert.equal(report.totals.overall.closingCost, 100);
      assert.equal(report.totals.overall.turnoverCost, 0.6);
      assert.equal(report.summary.totalRowCount, 1);
      assert.equal(report.summary.rowCount, groupBy === "day" ? 3 : 1);
      assert.ok(report.warnings.some(warning => /денежных показателей недоступна/.test(warning)),
        "filtering must retain source warnings about excluded rows");
      if (profile === "full" || groupBy === "day") assert.deepEqual(report.daily.map(day => day.salesQty), [2, 2, 2]);
      assert.equal(report.transfers.length, 0);
    }
    const standard = await getTurnoverReport({ ...request, profile: "summary", sort: "name" }, reloadReader);
    const network = await getTurnoverReport({ ...request, profile: "sample" }, reloadReader);
    const analytical = await getTurnoverReport({ ...request, profile: "summary" }, reloadReader);
    assert.deepEqual(standard.rows[0]!.daily.map(day => day.salesQty), [2, 2, 2]);
    for (const combined of [standard, network]) {
      assert.deepEqual(combined.rows.map(row => row.sku), ["complete", "missing-cost"]);
      assert.deepEqual(combined.totals.overall.daily.map(day => day.quantity), [20, 20, 20]);
      assert.deepEqual(combined.totals.overall.daily.map(day => day.stockCost), [null, null, null]);
      assert.equal(combined.totals.overall.periodSales.quantity, 12);
      assert.equal(combined.totals.overall.periodSales.cost, null);
      assert.equal(combined.excludedIncompleteRows, 2);
    }
    assert.deepEqual(analytical.rows.map(row => row.sku), ["complete"]);
    assert.equal(turnoverQuerySchema.safeParse({ ...request, to: "2026-11-02", profile: "summary", sort: "name" }).success, false);
    const quantity = await getTurnoverReport({ ...request, mode: "quantity" }, reloadReader);
    assert.equal(quantity.rows.length, 2, "quantity mode must not require optional cost data");
    const rawDayGap = { ...quantity, populationFiltered: undefined, params: { ...quantity.params, profile: "sample" as const },
      daily: [{ ...standard.rows[0]!.daily[0]!, quantity: null }] };
    const guarded = completeTurnoverReport(rawDayGap);
    assert.deepEqual(guarded.daily, []);
    assert.equal(guarded.totals.overall.periodSales.quantity, null);
    mixedUnits = true;
    const mixed = await getTurnoverReport({ ...request, mode: "quantity", profile: "sample" }, reloadReader);
    assert.equal(mixed.rows.find(row => row.sku === "complete")!.periodSales.cost, 60);
    assert.equal(mixed.rows.find(row => row.sku === "complete")!.turnoverCost, null);
    assert.equal(mixed.rows.find(row => row.sku === "missing-cost")!.unit, "шт");
    assert.equal(mixed.rows.find(row => row.sku === "missing-cost")!.periodSales.cost, null);
    assert.equal(mixed.totals.overall.periodSales.quantity, null);
    assert.equal(mixed.excludedIncompleteRows, 2);
    assert.deepEqual(mixed.totals.byUnit.map(total => [total.unit, total.periodSales.quantity]).sort(), [["л", 6], ["шт", 6]]);
    await t.test("standard quantity previews value SKU and mixed-unit totals without changing the physical population", async () => {
      const previewRequest = { ...request, mode: "quantity" as const, sort: "name" as const };
      alternatePrice = 25;
      try {
        for (const profile of ["sample", "summary"] as const) {
          const selection = { ...previewRequest, profile };
          const preview = await getTurnoverPreview(selection, reloadReader);
          const workbook = await getTurnoverReport(selection, reloadReader);
          assert.equal(preview.params.mode, "quantity");
          assert.deepEqual(preview.rows.map(row => [row.key, row.averageQty, row.turnoverQtyDays]),
            workbook.rows.map(row => [row.key, row.averageQty, row.turnoverQtyDays]));
          assert.deepEqual(preview.rows.map(row => row.sku), ["complete", "missing-cost"]);
          const item = preview.rows[0]!;
          assert.deepEqual(item.daily.map(day => day.stockCost), [100, 100, 100]);
          assert.equal(item.averageCost, 100);
          assert.equal(item.periodSales.cost, 60);
          assert.equal(item.turnoverCostDays, 5);
          assert.equal(workbook.rows[0]!.averageCost, null);
          assert.equal(workbook.rows[0]!.periodSales.cost, 60);
          const scopes = [preview.totals.overall];
          if (profile === "summary") scopes.push(preview.totals.byStore.find(({ storeKey }) => storeKey === "key:s")!.total);
          for (const total of scopes) {
            assert.equal(total.unit, null);
            assert.equal(total.averageQty, null);
            assert.equal(total.periodSales.quantity, null);
            assert.equal(total.averageCost, 350);
            assert.equal(total.periodSales.cost, 210);
            assert.equal(total.periodSales.revenue, 180);
            assert.equal(total.turnoverCostDays, 5);
          }
        }
        const returns = (await getTurnoverPreview({
          ...previewRequest, profile: "sample", includeIncomplete: true
        }, reloadReader)).rows.find(row => row.sku === "returns")!;
        assert.equal(returns.periodSales.cost, -30);
        assert.equal(returns.turnoverCostDays, null);
        const analyticalPreview = await getTurnoverPreview({ ...request, mode: "quantity" }, reloadReader);
        assert.equal(analyticalPreview.rows[0]!.averageCost, null);
      } finally {
        alternatePrice = null;
      }
      const incomplete = await getTurnoverPreview({ ...previewRequest, profile: "summary" }, reloadReader);
      assert.deepEqual(incomplete.rows.map(row => row.sku), ["complete", "missing-cost"]);
      assert.equal(incomplete.rows[1]!.averageQty, 10);
      assert.equal(incomplete.rows[1]!.averageCost, null);
      assert.equal(incomplete.totals.overall.averageCost, null);
      assert.equal(incomplete.totals.overall.periodSales.cost, null);
      assert.equal(incomplete.totals.overall.turnoverCostDays, null);
      assert.ok(incomplete.warnings.some(warning => /денежных показателей недоступна/.test(warning)));
    });
    duplicateLitres = true;
    pieceLabel = "   ";
    const disambiguated = await getTurnoverReport({ ...request, profile: "sample" }, reloadReader);
    assert.deepEqual(disambiguated.rows.map(row => [row.sku, row.unit]), [["complete", "л (1)"]]);
    assert.equal(disambiguated.totals.overall.unit, "л (1)");
    duplicateLitres = false;
    pieceLabel = "шт";
    mixedUnits = false;
    const money = await getTurnoverReport({ ...request, mode: "money" }, reloadReader);
    assert.equal(money.rows.length, 1);
    unknownUnit = true;
    const noUnits = await getTurnoverReport({ ...request, mode: "quantity" }, reloadReader);
    assert.equal(noUnits.rows.length, 0);
    assert.equal(noUnits.excludedIncompleteRows, 4);
    assert.equal(noUnits.totals.overall.openingQty, null);
    assert.equal((await getTurnoverReport({ ...request, profile: "sample" }, reloadReader)).rows.length, 0,
      "a money-only SKU cannot enter the standard quantity workbook or its sales total");
    assert.equal((await getTurnoverReport({ ...request, mode: "money" }, reloadReader)).rows.length, 1);
    unknownUnit = false;
    unavailableOpening = true;
    const empty = await getTurnoverReport(request, reloadReader);
    assert.equal(empty.rows.length, 0);
    assert.equal(empty.excludedIncompleteRows, 4);
    assert.equal(empty.summary.stockCost, null);
    assert.equal(empty.totals.overall.periodSales.cost, null);
    assert.equal(empty.daily.length, 0);
    assert.equal(empty.transfers.length, 0);
    assert.ok(empty.warnings.some(warning => /начало периода/.test(warning)));
    unavailableOpening = false;
    const raw = await getTurnoverReport({ ...request, includeIncomplete: true }, reloadReader);
    assert.equal(raw.rows.length, 4);
    assert.equal(raw.excludedIncompleteRows, 0);
    assert.equal(raw.totals.overall.periodSales.cost, null);
    assert.equal(raw.rows.find(row => row.sku === "zero-sales")!.turnoverQtyDays, null);
    firstItemName = "Пластиковая бутылка 1л";
    const withoutBottle = await getTurnoverReport({ ...request, includeIncomplete: true }, reloadReader);
    assert.equal(withoutBottle.rows.some(row => row.sku === "complete"), false);
    assert.equal(withoutBottle.options.skus.some(option => option.key === "complete"), false);
    assert.equal(withoutBottle.totals.overall.closingQty, 30);
    assert.equal(withoutBottle.totals.overall.periodSales.quantity, 3);
    firstItemName = "complete";
    transferScenario = true;
    const filteredTransfers = await getTurnoverReport(request, reloadReader);
    assert.equal(filteredTransfers.excludedIncompleteRows, 1);
    assert.equal(filteredTransfers.rows.length, 1);
    assert.equal(filteredTransfers.rows[0].storeKey, "key:r");
    assert.equal(filteredTransfers.transfers.length, 0, "an excluded donor cannot remain in transfer recommendations");
    const originalTransfers = await getTurnoverReport({ ...request, includeIncomplete: true }, reloadReader);
    assert.equal(originalTransfers.transfers[0].quantity, 29);
    assert.equal(originalTransfers.transfers[0].fromStoreKey, "key:s");
    assert.equal(originalTransfers.transfers[0].toStoreKey, "key:r");
  } finally {
    prisma.$queryRaw = originalQuery;
    prisma.$transaction = originalTransaction;
    prisma.$queryRawUnsafe = originalUnsafeQuery;
  }
});
