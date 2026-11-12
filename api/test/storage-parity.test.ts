import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import {
  compareSemanticValues, workbookSemantics, performanceGate, validateParityCoverage,
  validateApiIdentity, requiredParityCases, argumentsFor, parseReloadPlan,
  requiredReadinessCases, sampleReadiness, compareReadinessWorkbook, discoverReadinessSelection,
  validateReadinessIdentity, readinessWorkbookOracle, readinessBusinessFixtures,
  pendingReadinessCases, compareReadinessFields
} from "../src/scripts/verify-storage-parity.js";

test("parity detects unavailable, integer count, ordering, and coverage changes", () => {
  assert.deepEqual(compareSemanticValues({ cost: null, count: 2, rows: ["00123", "return"], coverage: "partial" }, { cost: 0, count: 2, rows: ["00123", "return"], coverage: "partial" }), ["$.cost"]);
  assert.deepEqual(compareSemanticValues({ count: 2 }, { count: 2.00000001 }), ["$.count"]);
  assert.deepEqual(compareSemanticValues(["a", "b"], ["b", "a"]), ["$[0]", "$[1]"]);
  assert.deepEqual(compareSemanticValues({ coverage: null }, {}), ["$.coverage"]);
});

test("parity allows only fractional serialization tolerance and generated timestamps", () => {
  assert.deepEqual(compareSemanticValues({ amount: 1.25, generatedAt: "old", quality: null }, { quality: null, generatedAt: "new", amount: 1.2500001 }), []);
  assert.deepEqual(compareSemanticValues({ measuredAt: "old" }, { measuredAt: "new" }), ["$.measuredAt"]);
  assert.deepEqual(compareSemanticValues({ amount: 1.25 }, { amount: 1.25001 }), ["$.amount"]);
});

test("workbook semantics preserve barcodes, returns, nulls and formula results", async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Facts");
  sheet.addRow(["00123", -2.5, null, { formula: "B1*2", result: -5 }]);
  sheet.addRow(["Снимок UTC", "2026-01-01T00:00:00Z"]);
  const value = await workbookSemantics(Buffer.from(await book.xlsx.writeBuffer()));
  assert.deepEqual(value, [{ name: "Facts", rows: [
    { number: 1, cells: [{ column: 1, value: "00123" }, { column: 2, value: -2.5 }, { column: 4, value: { formula: "B1*2", result: -5 } }] },
    { number: 2, cells: [{ column: 1, value: "Снимок UTC" }, { column: 2, value: { generatedAt: true } }] }
  ] }]);
});

test("timing gate allows the specified relative or absolute regression, not their sum", () => {
  assert.equal(performanceGate(100, 600), true);
  assert.equal(performanceGate(100, 601), false);
  assert.equal(performanceGate(4000, 5000), true);
  assert.equal(performanceGate(4000, 5001), false);
});

test("a shortened baseline cannot certify missing business routes or empty leap fixtures", () => {
  const selections = [
    { from: "2025-09-01", to: "2025-10-01", sku: null, storeKey: null, activityKey: null, rowKeys: {} },
    { from: "2026-09-01", to: "2026-10-01", sku: null, storeKey: null, activityKey: null, rowKeys: {} },
    { from: "2024-02-28", to: "2024-03-02", sku: null, storeKey: null, activityKey: null, rowKeys: {} }
  ];
  assert.throws(() => validateParityCoverage([{ path: "/api/management/settings", kind: "json" }], selections), /populated leap/i);
  const rowKeys: Record<string, string> = {};
  for (const mode of ["quantity", "money"]) for (const profile of ["summary", "full"]) for (const store of ["all", "store1"]) rowKeys[`${mode}|${profile}|${store}`] = "item1/store1";
  const populated = [...selections.slice(0, 2), { ...selections[2], sku: "item1", storeKey: "store1", activityKey: "activity1", rowKeys }];
  assert.throws(() => validateParityCoverage([{ path: "/api/management/settings", kind: "json" }], populated), /coverage/i);
  assert.throws(() => validateParityCoverage([], populated), /coverage/i);
  const complete = requiredParityCases(populated);
  assert.equal(complete.length, 96);
  assert.ok(complete.some((entry) => entry.kind === "xlsx" && entry.path === "/api/marketing/compensations.xlsx?from=2024-02-28&to=2024-03-02&activityKey=activity1"));
  assert.equal(validateParityCoverage(complete, populated).caseCount, 96);
  const missingWorkbook = complete.filter((entry) => !entry.path.startsWith("/api/reports/presentation.xlsx?from=2024"));
  assert.throws(() => validateParityCoverage(missingWorkbook, populated), /coverage/i);
  assert.throws(() => validateParityCoverage([...complete, complete[0]], populated), /coverage/i);
});

test("HTTP database/schema and activated layout must match the independently verified plan", () => {
  const binding = { targetDatabase: { name: "clone_storage_rehearsal", oid: 23 }, sourceSchema: { name: "raw_1c", oid: 24 }, migrationId: "00000000-0000-4000-8000-000000000001", contractSha256: "a".repeat(64), planSha256: "b".repeat(64) };
  const identity = { proofVersion: 1, challenge: "00000000-0000-4000-8000-000000000002", targetDatabase: { name: "other_storage_rehearsal", oid: 23 }, sourceSchema: binding.sourceSchema, layout: null };
  assert.throws(() => validateApiIdentity(identity, binding, identity.challenge, false), /database|target/i);
  identity.targetDatabase.name = binding.targetDatabase.name;
  assert.throws(() => validateApiIdentity(identity, binding, identity.challenge, true), /layout|activat/i);
  assert.throws(() => validateApiIdentity({ ...identity, challenge: "wrong" }, binding, identity.challenge, false), /challenge/i);
});

const reloadPlan = {
  planVersion: 1, operation: "post-cleanup-reload-v1",
  migrationId: "00000000-0000-4000-8000-000000000001",
  targetDatabase: { name: "nalivdata", oid: 1208710 }, sourceSchema: { name: "raw_1c", oid: 1247771 },
  contractSha256: "a".repeat(64), indexManifestSha256: "b".repeat(64),
  from: "2026-06-01", toExclusive: "2026-06-04"
};

test("readiness is a separate production command and cannot consume a physical storage plan", () => {
  const args = argumentsFor(["readiness", "--base-url", "http://localhost:4317", "--reload-plan", "reload.json", "--output", "proof.json"]);
  assert.equal(args.command, "readiness");
  assert.equal(args.plan, "reload.json");
  assert.throws(() => argumentsFor(["readiness", "--base-url", "http://localhost:4317", "--storage-plan", "old.json", "--output", "proof.json"]));
  assert.throws(() => argumentsFor(["capture", "--base-url", "http://localhost:4317", "--reload-plan", "reload.json", "--output", "proof.json"]));
  assert.equal(parseReloadPlan(reloadPlan).targetDatabase.name, "nalivdata");
  assert.throws(() => parseReloadPlan({ ...reloadPlan, targetDatabase: { name: "other", oid: 1208710 } }));
  assert.throws(() => parseReloadPlan({ ...reloadPlan, from: "2026-06-04" }));
  assert.throws(() => parseReloadPlan({ ...reloadPlan, from: "2026-02-30" }));
  assert.throws(() => parseReloadPlan({ ...reloadPlan, operation: "physical-rehearsal" }));
});

test("readiness binds the challenged activated plan and independent ledger manifest", () => {
  const binding = { ...reloadPlan, planSha256: "c".repeat(64) };
  const identity = { proofVersion: 1, challenge: "challenge", targetDatabase: reloadPlan.targetDatabase, sourceSchema: reloadPlan.sourceSchema, layout: { layoutVersion: 1, migrationId: reloadPlan.migrationId, contractSha256: reloadPlan.contractSha256, planSha256: binding.planSha256, compactionActive: false } };
  const ledger = { planSha256: binding.planSha256, contractSha256: reloadPlan.contractSha256, indexManifestSha256: reloadPlan.indexManifestSha256 };
  assert.equal(validateReadinessIdentity(identity, binding, "challenge", ledger).challenge, "challenge");
  assert.throws(() => validateReadinessIdentity(identity, binding, "stale", ledger), /challenge/);
  assert.throws(() => validateReadinessIdentity(identity, binding, "challenge", { ...ledger, indexManifestSha256: "d".repeat(64) }), /manifest/i);
  assert.throws(() => validateReadinessIdentity({ ...identity, layout: { ...identity.layout, compactionActive: true } }, binding, "challenge", ledger), /frozen|active/i);
});

test("readiness exercises actual audit groups across eight turnover variants and every business export", () => {
  const selection = { from: "2026-06-01", to: "2026-06-02", sku: "sku001", storeKey: "shop", activityKey: "activity", rowKeys: {} as Record<string, string> };
  for (const mode of ["quantity", "money"]) for (const profile of ["summary", "full"]) for (const store of ["all", "shop"]) selection.rowKeys[`${mode}|${profile}|${store}`] = `actual ${mode} ${profile} ${store}`;
  const matrix = requiredReadinessCases(selection);
  assert.deepEqual(matrix.skipped, []);
  assert.equal(matrix.cases.filter((entry) => entry.path.startsWith("/api/reports/turnover/row?")).length, 8);
  assert.equal(matrix.cases.filter((entry) => entry.path.startsWith("/api/reports/turnover.xlsx?")).length, 8);
  assert.ok(matrix.cases.some((entry) => entry.path.includes("auditGroup=actual+money+full+shop")));
  for (const path of ["/api/reports/sales", "/api/reports/income", "/api/reports/year-comparison", "/api/inventory", "/api/nomenclature", "/api/marketing", "/api/management/losses", "/api/management/acquiring", "/api/management/cash-articles", "/api/management/supplier-terms", "/api/management/store-stock", "/api/management/store-performance", "/api/management/money-position", "/api/management/lost-sales", "/api/management/purchasing", "/api/management/source-health", "/api/management/settings", "/api/reports/year-comparison.xlsx", "/api/reports/presentation.xlsx", "/api/marketing/compensations", "/api/marketing/compensations/activities", "/api/marketing/compensations.xlsx"]) {
    assert.ok(matrix.cases.some((entry) => entry.path.split("?")[0] === path), path);
  }
  const missing = requiredReadinessCases({ ...selection, sku: null, storeKey: null, activityKey: null, rowKeys: {} });
  assert.ok(missing.skipped.some((entry) => entry.reason.includes("activity")));
  assert.ok(missing.skipped.some((entry) => entry.reason.includes("SKU")));
  assert.ok(missing.cases.some((entry) => entry.path.startsWith("/api/reports/turnover?")));
});

test("pending readiness is exercised incomplete with three warmed timings, never a successful workbook", async () => {
  let calls = 0;
  const result = await sampleReadiness(async () => ({ status: 503, value: { error: "Ожидается загрузка чеков", code: "ANALYTICS_RELOAD_INCOMPLETE" }, ms: [99, 30, 10, 20][calls++], uncached: true }), { path: "/api/inventory?from=2026-06-01&to=2026-06-02", kind: "json" });
  assert.equal(calls, 4);
  assert.equal(result.status, "incomplete");
  assert.equal(result.exercised, true);
  assert.equal(result.httpStatus, 503);
  assert.equal(result.code, "ANALYTICS_RELOAD_INCOMPLETE");
  assert.equal(result.medianMs, 20);
  assert.deepEqual(result.samplesMs, [30, 10, 20]);
});

test("readiness refuses cache hits, unstable payloads and missing semantic export oracles", async () => {
  const cached = await sampleReadiness(async () => ({ status: 200, value: {}, ms: 1, uncached: false }), { path: "/api/reports/sales", kind: "json" });
  assert.notEqual(cached.status, "passed");
  let value = 0;
  const changing = await sampleReadiness(async () => ({ status: 200, value: { count: value++ }, ms: 1, uncached: true }), { path: "/api/reports/sales", kind: "json" });
  assert.notEqual(changing.status, "passed");
  assert.equal(compareReadinessWorkbook([], null).status, "incomplete");
  const expected = [{ name: "Facts", rows: [{ number: 1, cells: [{ column: 1, value: "00123" }, { column: 2, value: { formula: "1+1", result: 2 } }] }] }];
  assert.equal(compareReadinessWorkbook(expected, expected).status, "passed");
  const changedFormula = [{ name: "Facts", rows: [{ number: 1, cells: [{ column: 1, value: "00123" }, { column: 2, value: { formula: "2", result: 2 } }] }] }];
  const changedResult = [{ name: "Facts", rows: [{ number: 1, cells: [{ column: 1, value: "00123" }, { column: 2, value: { formula: "1+1", result: 3 } }] }] }];
  assert.equal(compareReadinessWorkbook(changedFormula, expected).status, "failed");
  assert.equal(compareReadinessWorkbook(changedResult, expected).status, "failed");
});

test("readiness discovers populated one-day HTTP fixtures within the immutable horizon", async () => {
  const paths: string[] = [];
  const http = async (entry: { path: string; kind: "json" | "xlsx" }) => {
    paths.push(entry.path);
    const url = new URL(entry.path, "http://localhost");
    let value: unknown = {};
    if (url.pathname === "/api/reports/sales") value = url.searchParams.get("from") === "2026-06-01"
      ? { summary: { orderCount: 0, reportCount: 0 }, composition: [], heatmap: { cells: [] } }
      : { summary: { orderCount: 2, reportCount: 1 }, composition: [{ itemKey: "sku-real" }], heatmap: { cells: [{ storeKey: "shop-real", orderCount: 2 }] } };
    if (url.pathname === "/api/marketing/compensations/activities") value = { activities: [{ key: "activity-real" }] };
    if (url.pathname === "/api/reports/turnover") value = { rows: [{ sku: "sku-real", storeKey: "shop-real", key: "returned/opaque-group", periodSales: { quantity: 2 } }] };
    return { status: 200, value: value as never, ms: 1, uncached: true };
  };
  const found = await discoverReadinessSelection(http, parseReloadPlan(reloadPlan));
  assert.equal(found.selection.from, "2026-06-02");
  assert.equal(found.selection.to, "2026-06-03");
  assert.equal(found.selection.sku, "sku-real");
  assert.equal(found.selection.storeKey, "shop-real");
  assert.equal(found.selection.activityKey, "activity-real");
  assert.equal(found.selection.rowKeys["money|full|shop-real"], "returned/opaque-group");
  assert.equal(found.populated, true);
  assert.ok(paths.every((path) => !path.includes("2025-")));
  for (const path of paths.filter((path) => path.includes("?"))) {
    const params = new URL(path, "http://localhost").searchParams;
    assert.equal(Date.parse(params.get("to")!) - Date.parse(params.get("from")!), 86_400_000);
  }
});

test("compensation workbook oracle comes from same-parameter JSON including barcodes, returns and unknown prices", async () => {
  const totals = { compensation: null, knownCompensation: -3, incompleteRows: 1 };
  const report = {
    from: "2026-06-01", to: "2026-06-02", activityKey: "activity", totals, issues: [],
    activities: [{
      key: "activity", name: "Реальная акция", number: "001", startsOn: "2026-06-01", endsOn: "2026-06-02",
      from: "2026-06-01", to: "2026-06-02", totals, issues: [],
      branches: [{ key: "store", name: "Филиал", totals, issues: [], rows: [{
        itemKey: "sku", characteristicKey: null, name: "Возврат", barcode: "00123", price: null,
        discountPct: 10, unitCompensation: null, quantity: -2, compensation: null, priceDate: null,
        from: "2026-06-01", to: "2026-06-02", issues: []
      }] }]
    }]
  };
  const paths: string[] = [];
  const oracle = await readinessWorkbookOracle({ path: "/api/marketing/compensations.xlsx?from=2026-06-01&to=2026-06-02&activityKey=activity", kind: "xlsx" }, async (path) => { paths.push(path); return report; });
  assert.deepEqual(paths, ["/api/marketing/compensations?from=2026-06-01&to=2026-06-02&activityKey=activity"]);
  assert.ok(oracle);
  const sheets = oracle.value as Array<{ name: string; rows: Array<{ cells: Array<{ column: number; value: unknown }> }> }>;
  const item = sheets.flatMap((sheet) => sheet.rows).find((row) => row.cells.some((cell) => cell.column === 1 && cell.value === "00123"));
  assert.ok(item);
  assert.deepEqual(item.cells.map((cell) => cell.value), ["00123", "Возврат", "n/a", 0.1, "n/a", -2, "n/a"]);
  const absent = await readinessWorkbookOracle({ path: "/api/marketing/compensations.xlsx?from=2026-06-01&to=2026-06-02", kind: "xlsx" }, async () => null);
  assert.equal(absent, null);
});

test("missing turnover row oracle cannot certify an extracted XLSX", async () => {
  const oracle = await readinessWorkbookOracle({ path: "/api/reports/turnover.xlsx?from=2026-06-01&to=2026-06-02&mode=money&profile=full&sku=sku", kind: "xlsx" }, async (path) => path.startsWith("/api/reports/turnover/row")
    ? null : { rows: [{ key: "opaque", sku: "sku", closingQty: null }] });
  assert.equal(oracle, null);
});

test("readiness does not treat a failed connection as an exercised HTTP response", async () => {
  const result = await sampleReadiness(async () => { throw new Error("socket failed"); }, { path: "/api/inventory", kind: "json" });
  assert.equal(result.exercised, false);
  assert.equal(result.status, "failed");
  assert.equal(result.medianMs, null);
});

test("a pending warmup cannot disappear from the recorded readiness evidence", async () => {
  let calls = 0;
  const result = await sampleReadiness(async () => ++calls === 1
    ? { status: 503, value: { code: "ANALYTICS_RELOAD_INCOMPLETE" }, ms: 10, uncached: true }
    : { status: 200, value: {}, ms: 20, uncached: true }, { path: "/api/inventory", kind: "json" });
  assert.equal(result.warmupHttpStatus, 503);
  assert.equal(result.warmupCode, "ANALYTICS_RELOAD_INCOMPLETE");
  assert.equal(result.status, "incomplete");
});

test("turnover preview disagreement is a failed oracle, not workbook extraction success", async () => {
  await assert.rejects(() => readinessWorkbookOracle({ path: "/api/reports/turnover.xlsx?from=2026-06-01&to=2026-06-02&sku=sku", kind: "xlsx" }, async (path) => path.startsWith("/api/reports/turnover/row")
    ? { row: { key: "opaque", sku: "sku", closingQty: 0 } }
    : { rows: [{ key: "opaque", sku: "sku", closingQty: null }] }), /preview\/drilldown mismatch/);
});

test("readiness labels absent activity rows, return and price fixtures incomplete instead of inventing them", () => {
  const missing = readinessBusinessFixtures([]);
  assert.equal(missing.length, 3);
  const populated = [{
    path: "/api/marketing/compensations?activityKey=real", kind: "json" as const, value: {
      activities: [{ branches: [{ rows: [{ barcode: "00123", quantity: -2, price: 150 }] }] }]
    }
  }];
  assert.deepEqual(readinessBusinessFixtures(populated), []);
});

test("discovery continues past a populated day without an activity to find a real activity fixture", async () => {
  const found = await discoverReadinessSelection(async ({ path }) => {
    const url = new URL(path, "http://localhost");
    const value = url.pathname === "/api/reports/sales"
      ? { summary: { orderCount: 1 }, composition: [{ itemKey: "sku" }], heatmap: { cells: [{ storeKey: "store", orderCount: 1 }] } }
      : url.pathname === "/api/marketing/compensations/activities"
        ? { activities: url.searchParams.get("from") === "2026-06-02" ? [{ key: "real-activity" }] : [] }
        : { rows: [{ sku: "sku", storeKey: "store", key: "opaque", periodSales: { quantity: 1 } }] };
    return { status: 200, value, ms: 1, uncached: true };
  }, parseReloadPlan(reloadPlan));
  assert.equal(found.selection.from, "2026-06-02");
  assert.equal(found.selection.activityKey, "real-activity");
});

test("canary probes use an actual uncertified source boundary, never an out-of-horizon annual window", () => {
  const cases = pendingReadinessCases(parseReloadPlan(reloadPlan), {
    status: "reloading", sources: [
      { table: "document_chek_kkm", status: "partial", verifiedThrough: "2026-06-02" },
      { table: "document_otchet_o_roznichnyh_prodazhah_tovary", status: "partial", verifiedThrough: "2026-06-03" }
    ]
  });
  assert.deepEqual(cases, [
    { path: "/api/reports/year-comparison?from=2026-06-02&to=2026-06-03", kind: "json" },
    { path: "/api/reports/income?from=2026-06-03&to=2026-06-04", kind: "json" }
  ]);
  assert.deepEqual(pendingReadinessCases(parseReloadPlan(reloadPlan), { status: "ready", sources: [] }), []);
});

test("independent compensation fields catch a writer changing null prices, return signs or barcode strings", () => {
  const input = { activities: [{ branches: [{ key: "shop", rows: [{ barcode: "00123", name: "Возврат", price: null, discountPct: 10, unitCompensation: null, quantity: -2, compensation: null }] }] }] };
  const workbook = [{ name: "Филиал", rows: [{ number: 6, cells: [
    { column: 1, value: "00123" }, { column: 2, value: "Возврат" }, { column: 3, value: "n/a" },
    { column: 4, value: 0.1 }, { column: 5, value: "n/a" }, { column: 6, value: -2 }, { column: 7, value: "n/a" }
  ] }] }];
  assert.deepEqual(compareReadinessFields("/api/marketing/compensations.xlsx", workbook, input), []);
  workbook[0].rows[0].cells[0].value = "123";
  assert.ok(compareReadinessFields("/api/marketing/compensations.xlsx", workbook, input).length);
  workbook[0].rows[0].cells[0].value = "00123";
  workbook[0].rows[0].cells[5].value = 2;
  assert.ok(compareReadinessFields("/api/marketing/compensations.xlsx", workbook, input).length);
});

test("independent turnover fields preserve missing values, mode metrics and exact row membership", () => {
  const input = { rows: [{ sku: "sku", openingQty: null, closingQty: -2, periodSales: { quantity: -1 } }] };
  const workbook = [{ name: "Оборачиваемость", rows: [
    { number: 4, cells: [{ column: 1, value: "SKU (ключ 1С)" }, { column: 2, value: "Начальный остаток" }, { column: 3, value: "Конечный остаток" }, { column: 4, value: "Нетто продажи за период" }] },
    { number: 5, cells: [{ column: 1, value: "sku" }, { column: 2, value: "n/a" }, { column: 3, value: -2 }, { column: 4, value: -1 }] }
  ] }];
  assert.deepEqual(compareReadinessFields("/api/reports/turnover.xlsx", workbook, input), []);
  workbook[0].rows[1].cells[1].value = 0;
  assert.ok(compareReadinessFields("/api/reports/turnover.xlsx", workbook, input).length);
});

test("independent comparison and presentation audit oracles catch omitted-HTTP valuation differences", () => {
  const sales = { periods: { current: { to: "2026-06-02" } }, dataQuality: { valuation: [{ period: "current", sourceStoreKey: "shop", itemKey: "sku", unitCost: null, quantity: -2, revenue: -4, absoluteQuantity: 2, valuedCost: null }] } };
  const comparison = [{ name: "Оценка стоимости", rows: [{ number: 3, cells: [
    { column: 1, value: "current" }, { column: 2, value: "2026-06-02" }, { column: 3, value: "shop" }, { column: 4, value: "sku" },
    { column: 5, value: "n/a" }, { column: 7, value: -2 }, { column: 8, value: -4 }, { column: 9, value: 2 }, { column: 10, value: "n/a" }
  ] }] }];
  assert.deepEqual(compareReadinessFields("/api/reports/year-comparison.xlsx", comparison, sales), []);
  comparison[0].rows[0].cells[4].value = 0;
  assert.ok(compareReadinessFields("/api/reports/year-comparison.xlsx", comparison, sales).length);
  const presentation = [{ name: "Оценка стоимости", rows: [{ number: 5, cells: [
    { column: 1, value: "Основной период" }, { column: 2, value: "Текущий" }, { column: 3, value: "2026-06-02" },
    { column: 4, value: "shop" }, { column: 5, value: "sku" }, { column: 6, value: "n/a" },
    { column: 8, value: -2 }, { column: 9, value: -4 }, { column: 10, value: 2 }, { column: 11, value: "n/a" }
  ] }] }];
  assert.deepEqual(compareReadinessFields("/api/reports/presentation.xlsx", presentation, { main: { sales }, detail: { sales: { periods: {}, dataQuality: { valuation: [] } } } }), []);
});
