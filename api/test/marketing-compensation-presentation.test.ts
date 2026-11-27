import { Prisma } from "@prisma/client";
import assert from "node:assert/strict";
import test from "node:test";
import type { CompensationActivity, CompensationBranch, CompensationRow, MarketingCompensationReport } from "../src/services/marketing-compensation-types.js";
import {
  isCompleteCompensationRow, isInactiveCompensationActivity, isInactiveCompensationBranch,
  projectCompensationReport
} from "../src/services/marketing-compensation-presentation.js";

const totals = { compensation: 0, knownCompensation: 0, incompleteRows: 0 };
function branch(overrides: Partial<CompensationBranch> = {}): CompensationBranch {
  return { key: "store", name: "Магазин", rows: [], hasSales: false, hasReturns: false, totals: { ...totals }, issues: [], ...overrides };
}
function activity(overrides: Partial<CompensationActivity> = {}): CompensationActivity {
  return { key: "activity", name: "Акция", number: null, startsOn: null, endsOn: null, from: "2026-06-01", to: "2026-06-02", branches: [branch()], totals: { ...totals }, issues: [], ...overrides };
}
const unknownRow: CompensationRow = { itemKey: "item", characteristicKey: null, name: "Товар", barcode: null, price: 100, discountPct: 10, unitCompensation: 10, quantity: null, compensation: null, from: "2026-06-01", to: "2026-06-02", issues: [] };

test("known empty branch and activity are inactive", () => {
  assert.equal(isInactiveCompensationBranch(branch()), true);
  assert.equal(isInactiveCompensationActivity(activity()), true);
});
test("false movement flags cannot hide NULL quantity rows", () => {
  assert.equal(isInactiveCompensationBranch(branch({ rows: [unknownRow] })), false);
});
test("missing coverage and incomplete totals remain visible", () => {
  assert.equal(isInactiveCompensationBranch(branch({ issues: [{ code: "missing_coverage", message: "Нет данных" }] })), false);
  assert.equal(isInactiveCompensationBranch(branch({ totals: { ...totals, compensation: null } })), false);
  assert.equal(isInactiveCompensationBranch(branch({ totals: { ...totals, incompleteRows: 1 } })), false);
});
test("activities without branches or with unresolved scope remain visible", () => {
  assert.equal(isInactiveCompensationActivity(activity({ branches: [] })), false);
  assert.equal(isInactiveCompensationActivity(activity({ issues: [{ code: "scope", message: "Нужна проверка" }] })), false);
  assert.equal(isInactiveCompensationActivity(activity({ totals: { ...totals, compensation: null } })), false);
  assert.equal(isInactiveCompensationActivity(activity({ totals: { ...totals, incompleteRows: 1 } })), false);
});
test("positive sales with zero compensation remain visible", () => {
  assert.equal(isInactiveCompensationBranch(branch({ hasSales: true })), false);
});
test("sale and full return with net zero remain visible", () => {
  assert.equal(isInactiveCompensationBranch(branch({ hasSales: true, hasReturns: true })), false);
});
test("return-only corrections remain visible", () => {
  assert.equal(isInactiveCompensationBranch(branch({ hasReturns: true, totals: { ...totals, compensation: -80, knownCompensation: -80 } })), false);
});

test("complete calculation requires every finite financial field but not an optional barcode", () => {
  const complete: CompensationRow = { ...unknownRow, quantity: -2, compensation: -20 };
  assert.equal(isCompleteCompensationRow(complete), true);
  assert.equal(isCompleteCompensationRow({ ...complete, barcode: null, characteristicKey: null }), true);
  assert.equal(isCompleteCompensationRow({ ...complete, price: 0, discountPct: 0, unitCompensation: 0, quantity: 0, compensation: 0 }), true);
  assert.equal(isCompleteCompensationRow({ ...complete, price: -100, discountPct: -10, unitCompensation: -10, quantity: -1, compensation: -10 }), true);
  for (const field of ["price", "discountPct", "unitCompensation", "quantity", "compensation"] as const) {
    for (const value of [null, Number.NaN, Infinity, -Infinity]) {
      assert.equal(isCompleteCompensationRow({ ...complete, [field]: value }), false, `${field}=${value}`);
    }
  }
});

test("default projection removes incomplete rows without recalculating authoritative partial totals", () => {
  const known = { ...unknownRow, name: "Расчёт", quantity: -2, compensation: -20 };
  const source: MarketingCompensationReport = {
    from: "2026-06-01", to: "2026-06-02", activityKey: null, calculationMode: "retail-rule",
    issues: [{ code: "source", message: "Ограничение отчёта" }],
    totals: { compensation: null, knownCompensation: 73.25, incompleteRows: 1 },
    activities: [activity({
      totals: { compensation: null, knownCompensation: 73.25, incompleteRows: 1 },
      branches: [branch({ hasSales: true, rows: [known, { ...unknownRow, issues: [{ code: "quantity", message: "Нет количества" }] }], totals: { compensation: null, knownCompensation: 73.25, incompleteRows: 1 } })]
    })]
  };
  const projected = projectCompensationReport(source);
  assert.deepEqual(projected.activities[0].branches[0].rows, [known]);
  assert.equal(projected.calculationMode, "retail-rule");
  assert.equal(projected.totals, source.totals);
  assert.equal(projected.activities[0].totals, source.activities[0].totals);
  assert.equal(projected.excludedIncompleteRows, 1);
  assert.equal(projected.excludedIncompleteBlocks, 0);
  assert.ok(projected.excludedIncompleteDiagnostics?.some(entry => entry.issues.some(issue => issue.code === "quantity")));
  assert.deepEqual(projectCompensationReport(projected), projected, "repeated writer/web projections must not lose or double-count metadata");
  assert.equal(source.activities[0].branches[0].rows.length, 2, "projection does not mutate raw results");
  assert.deepEqual(projectCompensationReport({ ...source, includeIncomplete: true }).activities, source.activities);
});

test("all-unknown rows and activity-only blockers become diagnostic scopes, not financial zero blocks", () => {
  const source: MarketingCompensationReport = {
    from: "2026-06-01", to: "2026-06-02", activityKey: "activity", calculationMode: "purchase-title", issues: [],
    totals: { compensation: null, knownCompensation: 0, incompleteRows: 1 },
    activities: [
      activity({ branches: [branch({ rows: [{
        ...unknownRow, price: null, issues: [{ code: "ambiguous_purchase_price", message: "Противоречивые закупочные цены" }]
      }], totals: { compensation: null, knownCompensation: 0, incompleteRows: 1 } })] }),
      activity({ key: "scope-only", branches: [], issues: [{ code: "missing_rule", message: "Нет правила" }] })
    ]
  };
  const projected = projectCompensationReport(source);
  assert.deepEqual(projected.activities, []);
  assert.equal(projected.excludedIncompleteRows, 1);
  assert.equal(projected.excludedIncompleteBlocks, 2);
  assert.equal(projected.totals.compensation, null);
  assert.equal(projected.calculationMode, "purchase-title");
  assert.ok(projected.excludedIncompleteDiagnostics?.some(entry => entry.issues.some(issue => issue.code === "ambiguous_purchase_price")));
  assert.ok(projected.excludedIncompleteDiagnostics?.some(entry => entry.issues.some(issue => issue.code === "missing_rule")));
  assert.equal(projectCompensationReport({ ...source, includeIncomplete: true }).activities.length, 2);
});

test("exclusions stay explicit even if a direct DTO declares its source total complete", () => {
  const source: MarketingCompensationReport = {
    from: "2026-06-01", to: "2026-06-02", activityKey: null, calculationMode: "purchase-title", issues: [],
    totals: { compensation: 777, knownCompensation: 777, incompleteRows: 0 },
    activities: [activity({ branches: [branch({ hasSales: true, rows: [
      { ...unknownRow, quantity: 1, compensation: 10 },
      { ...unknownRow, price: Infinity, quantity: 1, compensation: 10 }
    ] })] })]
  };
  const projected = projectCompensationReport(source);
  assert.equal(projected.totals.compensation, 777, "authoritative total is not overwritten with a visible-row sum");
  assert.equal(projected.activities[0].branches[0].excludedIncompleteRows, 1);
  assert.equal(projected.activities[0].excludedIncompleteRows, 1);
  assert.equal(projected.excludedIncompleteRows, 1);
});

async function compensationModules() {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
  // Config reads required env at module load; initialize the isolated test values first.
  const { prisma } = await import("../src/prisma.js");
  return { prisma, ...await import("../src/services/marketing-compensation.js") };
}

test("compensation queries normalize filters into cache identity and early reports retain calculation mode", async () => {
  const { prisma, compensationQuerySchema, getMarketingCompensationReport } = await compensationModules();
  const request = { from: new Date("2026-06-01"), to: new Date("2026-06-02") };
  assert.equal(compensationQuerySchema.parse(request).calculationMode, "purchase-title");
  assert.equal(compensationQuerySchema.parse({ ...request, calculationMode: "retail-rule" }).calculationMode, "retail-rule");
  assert.equal(compensationQuerySchema.safeParse({ ...request, calculationMode: "invalid" }).success, false);
  assert.deepEqual(compensationQuerySchema.parse(request), compensationQuerySchema.parse({ ...request, calculationMode: "purchase-title" }));
  assert.notEqual(JSON.stringify(compensationQuerySchema.parse(request)),
    JSON.stringify(compensationQuerySchema.parse({ ...request, calculationMode: "retail-rule" })));
  assert.equal(compensationQuerySchema.parse(request).includeIncomplete, false);
  assert.equal(compensationQuerySchema.parse({ ...request, includeIncomplete: "false" }).includeIncomplete, false);
  assert.equal(compensationQuerySchema.parse({ ...request, includeIncomplete: "true" }).includeIncomplete, true);
  assert.equal(compensationQuerySchema.parse({ ...request, includeIncomplete: true }).includeIncomplete, true);
  assert.equal(compensationQuerySchema.safeParse({ ...request, includeIncomplete: "yes" }).success, false);
  assert.notEqual(JSON.stringify(compensationQuerySchema.parse(request)),
    JSON.stringify(compensationQuerySchema.parse({ ...request, includeIncomplete: true })));
  const original = prisma.$queryRaw;
  let calls = 0;
  prisma.$queryRaw = (async () => ++calls % 2
    ? [{ name: "document_marketingovaya_aktsiya", present: true }]
    : [{ key: "unresolved", name: "Нет состава", number: null, startsOn: "2026-06-01", endsOn: "2026-06-01" }]) as typeof original;
  try {
    const readiness = async () => ({ returnPriceIntervals: [], coverageSources: [] });
    const filtered = await getMarketingCompensationReport(request, readiness);
    assert.equal(filtered.includeIncomplete, false);
    assert.equal(filtered.calculationMode, "purchase-title");
    assert.equal(filtered.activities.length, 0);
    assert.equal(filtered.excludedIncompleteBlocks, 1);
    assert.equal(filtered.totals.compensation, null);
    assert.ok(filtered.excludedIncompleteDiagnostics?.some(entry => entry.issues.some(issue => issue.code === "missing_source")));
    const restored = await getMarketingCompensationReport({ ...request, includeIncomplete: true, calculationMode: "retail-rule" }, readiness);
    assert.equal(restored.includeIncomplete, true);
    assert.equal(restored.calculationMode, "retail-rule");
    assert.equal(restored.activities.length, 1);
    assert.equal(restored.activities[0].totals.compensation, null);
    // No activity in scope: preserve the distinction between a known-empty period
    // and an unresolved selection, without reading any composition or sales data.
    prisma.$queryRaw = (async (sql: TemplateStringsArray, ...values: unknown[]) => {
      const query = sql.join("?");
      if (query.includes("to_regclass")) {
        return (values.find(Array.isArray) as string[]).map(name => ({ name, present: true }));
      }
      if (query.includes("posted is true")) return [];
      throw new Error("Empty activity scope must not load report sources");
    }) as typeof original;
    const empty = await getMarketingCompensationReport(request, readiness);
    assert.deepEqual(empty.totals, { compensation: 0, knownCompensation: 0, incompleteRows: 0 });
    const absent = await getMarketingCompensationReport({ ...request, activityKey: "absent" }, readiness);
    assert.deepEqual(absent.issues.map(i => i.code), ["activity_not_found"]);
    assert.deepEqual(absent.totals, { compensation: null, knownCompensation: 0, incompleteRows: 0 });
  } finally {
    prisma.$queryRaw = original;
  }
});

test("retail calculation scopes catalog reads and keeps unassigned diagnostics separate from known money", async () => {
  const { prisma, getMarketingCompensationReport } = await compensationModules();
  const request = { from: new Date("2026-06-01"), to: new Date("2026-06-02"), activityKey: "a", calculationMode: "retail-rule" as const, includeIncomplete: true };
  // The DB boundary supplies rows, not calculations. Exercise real candidate expansion, projection and totals.
  const catalog: Record<string, { keys: string[]; rows: Record<string, unknown>[] }> = {
    document_marketingovaya_aktsiya: { keys: ["a"], rows: [{ ref_key: "a", naimenovanie_aktsii: "Акция", dlya_vseh_magazinov: false }] },
    document_marketingovaya_aktsiya_skidki_natsenki: { keys: ["a"], rows: [{ activity_key: "a", skidka_natsenka_key: "discount", magazin_key: "shop", data_nachala: null, data_okonchaniya: null }] },
    document_marketingovaya_aktsiya_magaziny: { keys: ["a"], rows: [] },
    catalog_magaziny: { keys: ["shop"], rows: [{ ref_key: "shop", description: "Магазин", deletion_mark: false }] },
    catalog_skidki_natsenki: { keys: ["discount"], rows: [{ ref_key: "discount", description: "10%", segment_nomenklatury_predostavleniya_key: "segment", deletion_mark: false }] },
    catalog_segmenty_nomenklatury: { keys: ["segment"], rows: [{ ref_key: "segment", description: "Состав", deletion_mark: false }] },
    information_register_nomenklatura_segmenta: { keys: ["segment"], rows: [
      { item: "idle", characteristic: "", segments: ["segment"] },
      { item: "sold", characteristic: "", segments: ["segment"] }
    ] },
    catalog_nomenklatura: { keys: ["sold"], rows: [{ ref_key: "sold", description: "Товар", naimenovanie_polnoe: null, shtrihkod: null, barcode: "001" }] }
  };
  const original = prisma.$queryRaw;
  let movementReads = 0;
  prisma.$queryRaw = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = Prisma.sql(strings, ...values);
    if (query.text.includes("to_regclass")) return (query.values.find(Array.isArray) as string[]).map(name => ({ name, present: true }));
    if (query.text.includes("as invalid_item")) return [{ segment_key: "segment", invalid_item: false }];
    if (query.text.includes("as days")) return [{ branch: "shop", days: ["2026-06-01"] }];
    if (query.text.includes("orphan_reports")) return [{ key: "a" }];
    if (query.text.includes("with candidates")) {
      movementReads++;
      return [{ id: 1, price: "100", quantity: "2", has_sales: true, has_returns: false,
        missing_quantity: false, missing_price: false, unverified_movement: false,
        unverified_return: false, purchase_price_issue: null }];
    }
    if (query.text.includes("posted is true")) {
      assert.ok(query.values.includes("a"), "selection must be bound at the activity query");
      return [{ key: "a", name: "Акция", number: null, startsOn: "2026-06-01", endsOn: "2026-06-01" }];
    }
    const table = /from "[^"]+"\."([^"]+)"/.exec(query.text)?.[1];
    assert.ok(table && catalog[table], `unexpected SQL: ${query.text}`);
    assert.deepEqual(query.values.find(Array.isArray), catalog[table].keys, `unbounded or unrelated ${table} lookup`);
    return catalog[table].rows;
  }) as typeof original;
  try {
    const report = await getMarketingCompensationReport(request, async () => ({ returnPriceIntervals: [] }));
    assert.equal(movementReads, 1);
    const [branch] = report.activities[0].branches;
    assert.deepEqual(branch.rows.map(r => [r.itemKey, r.barcode, r.compensation]), [["sold", "001", 20]]);
    assert.deepEqual(branch.totals, { compensation: 20, knownCompensation: 20, incompleteRows: 0 });
    assert.deepEqual(report.totals, { compensation: null, knownCompensation: 20, incompleteRows: 0 });
    assert.deepEqual(report.issues.map(i => i.code), ["missing_branch"]);
    assert.deepEqual(report.activities[0].issues.map(i => i.code), ["missing_branch"]);
  } finally {
    prisma.$queryRaw = original;
  }
});
