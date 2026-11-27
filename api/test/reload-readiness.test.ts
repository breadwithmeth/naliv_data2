import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/nalivdata";
process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
// Config intentionally reads the test environment at module evaluation.
const { readReloadReadiness, createReloadReadinessReader, evaluateCoverage, requireCoverage, ReloadIncompleteError, validReturnPriceUpgrade } = await import("../src/services/reload-readiness.js");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const id = "00000000-0000-4000-8000-000000000001";
function fixture() {
  const descriptors = ["2026-06-01", "2026-06-02"].map((day, i) => ({ jobKey: String(i + 1).repeat(64), cycleId: id, phase: "recovery", source: "receipts", sourceEntity: "Document_ЧекККМ", rangeStart: day, rangeEndExclusive: i === 0 ? "2026-06-02" : "2026-06-03", balancePeriod: null, required: true, parentTable: "document_chek_kkm", childTables: ["document_chek_kkm_tovary"] }));
  const manifest = { manifestVersion: 1, reloadId: id, targetDatabase: { name: "nalivdata", oid: 1208710 }, sourceSchema: { name: "raw_1c", oid: 55 }, planSha256: "b".repeat(64), preDdlSummarySha256: "c".repeat(64), from: "2026-06-01", toExclusive: "2026-06-03", canaryDay: "2026-06-01", sources: [{ key: "receipts", entity: "Document_ЧекККМ", kind: "dated", tables: ["document_chek_kkm", "document_chek_kkm_tovary"], floor: "2026-06-01", required: true, recovery: true }], requiredRecoveryJobCount: 2, recoveryJobs: descriptors, recoveryJobsSha256: digest(descriptors), routineCycles: {} };
  const identity = { database_name: "nalivdata", database_oid: 1208710n, schema_name: "raw_1c", schema_oid: 55n, database_bytes: 5269000000n, has_layout: true, has_plans: true, has_jobs: true, tables: ["document_chek_kkm", "document_chek_kkm_tovary"], stock_entry_columns: false };
  const layout = { table_schema: "raw_1c", layout_version: 1, contract_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), migration_id: id, ddl_frozen: false };
  const plan = { reload_id: id, table_schema: "raw_1c", plan_sha256: layout.plan_sha256, contract_sha256: layout.contract_sha256, index_manifest_sha256: "d".repeat(64), source_sha256: "e".repeat(64), from_date: "2026-06-01", to_exclusive: "2026-06-03", canary_status: "verified", status: "ready", manifest, revision: 3n, updated_at: new Date() };
  const jobs = descriptors.map(d => ({ reload_id: id, job_key: d.jobKey, cycle_id: id, phase: d.phase, source_entity: d.sourceEntity, range_start: d.rangeStart, range_end_exclusive: d.rangeEndExclusive, status: "verified", required: true, source_rows: 0n, written_rows: 0n, business_sha256: "f".repeat(64), verified_at: new Date(), source_sha256: plan.source_sha256, verified_manifest: { manifestVersion: 1, jobKey: d.jobKey, scope: { kind: "dated", rangeStart: d.rangeStart, rangeEndExclusive: d.rangeEndExclusive, balancePeriod: null }, sourceSha256: plan.source_sha256, tables: { document_chek_kkm: { rows: 0, nullCounts: {}, resourceTotals: {}, sha256: "f".repeat(64), targetOnlyRows: 0 }, document_chek_kkm_tovary: { rows: 0, nullCounts: {}, resourceTotals: {}, sha256: "f".repeat(64), targetOnlyRows: 0 } } } }));
  const executor = { $queryRaw: async () => [], $queryRawUnsafe: async (sql: string) => sql.includes("pg_database_size") ? [identity] : sql.includes("analytics_storage_layout\"") ? [layout] : sql.includes("analytics_reload_plans\"") ? [plan] : jobs };
  return { identity, layout, plan, jobs, executor };
}

const oldContract = "a6f5f51899a2d2c14508b0203eb3cf0f3a0368f506fb9a0449ad100933a81871";
const newContract = "64f140bdcfbb1d5944677d96f9842804199ca8931ffb6fd2b34ea41016c85c54";
const stockEntryContract = "43c6ce8d697b88bb8782ac39cfa777cacefa95267c8af95c1d49501d228d8e54";
const stockEntryUpgrade = () => ({
  version: 1, fromContractSha256: newContract, toContractSha256: stockEntryContract,
  table: "document_oprihodovanie_tovarov_tovary",
  columns: { nomenklatura_key: "text", harakteristika_key: "text", kolichestvo: "numeric", tsena: "numeric" },
  previousWorkerSourceSha256: "e".repeat(64), workerSourceSha256: "d".repeat(64),
  appliedAt: "2026-06-04T02:00:00Z"
});
const stockEntryProof = () => ({
  version: 1, verifiedAt: "2026-06-05T00:00:00Z", throughId: 9, documents: 2, lines: 3, orphanLines: 7,
  nullCounts: { nomenklatura_key: 0, harakteristika_key: 3, kolichestvo: 0, tsena: 1 },
  valuesSha256: "c".repeat(64)
});
const receiptSku = "1469aa80-276b-4a76-90d6-72319e47cc92";
const historicalReceiptProof = () => ({
  from: "2026-06-01", toExclusive: "2026-06-03", sourceSha256: "a".repeat(64), targetSha256: "a".repeat(64),
  verifiedAt: "2026-06-06T00:00:00Z"
});
const retailEntity = "Document_ОтчетОРозничныхПродажах";
const retailTable = "document_otchet_o_roznichnyh_prodazhah";
const returnTable = `${retailTable}_vozvraschennye_tovary`;
const upgradeCycle = "00000000-0000-4000-8000-000000000003";
function returnUpgrade() {
  return {
    version: 1, fromContractSha256: oldContract, toContractSha256: newContract, table: returnTable, column: "tsena",
    workerSourceSha256: "e".repeat(64), rangeStart: "2026-06-01", rangeEndExclusive: "2026-06-03",
    cycleId: upgradeCycle, canaryDay: "2026-06-02", canaryPasses: [] as Array<{ sourceSha256: string; targetSha256: string }>,
    state: "backfilling", appliedAt: "2026-06-04T00:00:00Z", verifiedAt: null as string | null
  };
}
function retailFixture(withUpgrade = true) {
  const f = fixture();
  f.identity.schema_oid = 1247771n;
  f.identity.tables = [retailTable, `${retailTable}_tovary`, returnTable];
  f.layout.contract_sha256 = newContract;
  const descriptors = f.plan.manifest.recoveryJobs.map(d => ({
    ...d, source: "retail", sourceEntity: retailEntity, parentTable: retailTable, childTables: [`${retailTable}_tovary`, returnTable]
  }));
  const manifest = {
    ...f.plan.manifest, sourceSchema: { name: "raw_1c", oid: 1247771 },
    sources: [{ key: "retail", entity: retailEntity, kind: "dated", tables: [...f.identity.tables], floor: "2026-06-01", required: true }],
    recoveryJobs: descriptors, recoveryJobsSha256: digest(descriptors), returnPriceUpgrade: withUpgrade ? returnUpgrade() : undefined,
    routineCycles: {} as Record<string, { createdAt: string; window: { from: string; toExclusive: string }; jobs: typeof descriptors }>
  };
  const plan = { ...f.plan, contract_sha256: withUpgrade ? oldContract : newContract, manifest };
  const jobs = f.jobs.map((job, i) => ({
    ...job, source_entity: retailEntity,
    verified_manifest: { ...job.verified_manifest, tables: Object.fromEntries(f.identity.tables.map(table => [table, { rows: 0, nullCounts: {} as Record<string, number>, resourceTotals: {}, sha256: "f".repeat(64), targetOnlyRows: 0 }])) }
  }));
  const executor = { $queryRaw: async () => [], $queryRawUnsafe: async (sql: string) => sql.includes("pg_database_size") ? [f.identity] : sql.includes("analytics_storage_layout\"") ? [f.layout] : sql.includes("analytics_reload_plans\"") ? [plan] : jobs };
  return { ...f, plan, jobs, executor };
}
function publishUpgradeCycle(f: ReturnType<typeof retailFixture>) {
  const descriptors = f.plan.manifest.recoveryJobs.map((job, i) => ({ ...job, jobKey: String(i + 7).repeat(64), cycleId: upgradeCycle, phase: "deep_reread" }));
  f.plan.manifest.routineCycles[upgradeCycle] = { createdAt: "2026-06-04T00:00:00Z", window: { from: "2026-06-01", toExclusive: "2026-06-03" }, jobs: descriptors };
  f.jobs.push(...f.jobs.slice(0, 2).map((job, i) => ({
    ...structuredClone(job), job_key: descriptors[i].jobKey, cycle_id: upgradeCycle, phase: "deep_reread",
    verified_manifest: { ...structuredClone(job.verified_manifest), jobKey: descriptors[i].jobKey, tables: {
      ...structuredClone(job.verified_manifest.tables), [returnTable]: { ...job.verified_manifest.tables[returnTable], nullCounts: { tsena: 0 } }
    } }
  })));
  const upgrade = f.plan.manifest.returnPriceUpgrade!;
  const canary = f.jobs.find(job => job.cycle_id === upgradeCycle && job.range_start === upgrade.canaryDay)!;
  const target = { tables: Object.fromEntries(Object.entries(canary.verified_manifest.tables).map(([table, { targetOnlyRows: _targetOnlyRows, ...summary }]) => [table, summary])) };
  upgrade.canaryPasses = [{ sourceSha256: canary.source_sha256, targetSha256: digest(target) }, { sourceSha256: canary.source_sha256, targetSha256: digest(target) }];
  return upgrade;
}

function stockEntryFixture() {
  const f = retailFixture(), predecessor = publishUpgradeCycle(f);
  predecessor.state = "verified"; predecessor.verifiedAt = "2026-06-04T01:00:00Z";
  for (const job of f.jobs.filter(job => job.cycle_id === upgradeCycle)) {
    job.verified_manifest.tables[returnTable].resourceTotals = { tsena: "0" };
    job.business_sha256 = digest(job.verified_manifest.tables);
  }
  const canary = f.jobs.find(job => job.cycle_id === upgradeCycle && job.range_start === predecessor.canaryDay)!;
  const target = { tables: Object.fromEntries(Object.entries(canary.verified_manifest.tables).map(([table, { targetOnlyRows: _, ...summary }]) => [table, summary])) };
  predecessor.canaryPasses.forEach(pass => { pass.targetSha256 = digest(target); });
  f.layout.contract_sha256 = stockEntryContract;
  f.identity.stock_entry_columns = true;
  return { ...f, manifest: Object.assign(f.plan.manifest, { stockEntryCostUpgrade: stockEntryUpgrade(), stockEntryCostBackfill: stockEntryProof() }) };
}

function lowLoadFixture() {
  const f = stockEntryFixture();
  const prior = "0996f642aeccf2c19c6c1c3ee6ad888b98b42a2c5275eaa97a1c0a752adeef6a";
  const next = "a".repeat(64);
  f.manifest.stockEntryCostUpgrade.workerSourceSha256 = prior;
  const manifest = Object.assign(f.manifest, {
    lowLoadWorkerUpgrade: { version: 1, fromSha256: prior, toSha256: next, appliedAt: "2026-06-05T10:00:00Z" },
    stockEntryCostBackfill: {
      ...stockEntryProof(), version: 2, verifiedAt: "2026-11-26T01:00:00Z", workerSourceSha256: next,
      from: "2026-05-20", toExclusive: "2026-11-26", sourceInventorySha256: "b".repeat(64)
    }
  });
  return { ...f, manifest };
}

test("a low-load worker edge leaves predecessor evidence intact and authorizes only the v2 stock inventory bounds", async () => {
  const f = lowLoadFixture();
  const proof = f.manifest.stockEntryCostBackfill;
  const edge = f.manifest.lowLoadWorkerUpgrade;
  Reflect.deleteProperty(f.manifest, "stockEntryCostBackfill");
  Reflect.deleteProperty(f.manifest, "lowLoadWorkerUpgrade");
  const predecessor = await readReloadReadiness(f.executor as never);
  Object.assign(f.manifest, { lowLoadWorkerUpgrade: edge });
  const adopted = await readReloadReadiness(f.executor as never);
  assert.equal(adopted.status, "ready");
  assert.equal(adopted.stockEntryCostAvailable, false);
  assert.equal(adopted.stockEntryCostCoverage, undefined);
  assert.deepEqual(adopted.returnPriceIntervals, predecessor.returnPriceIntervals);
  assert.notEqual(adopted.binding, predecessor.binding);

  Object.assign(f.manifest, { stockEntryCostBackfill: proof });
  const verified = await readReloadReadiness(f.executor as never);
  assert.equal(verified.status, "ready");
  assert.equal(verified.stockEntryCostAvailable, true);
  assert.deepEqual(verified.stockEntryCostCoverage, { from: "2026-05-20", toExclusive: "2026-11-26" });
  assert.equal(Object.keys(verified).includes("stockEntryCostCoverage"), false);
  assert.deepEqual(verified.returnPriceIntervals, predecessor.returnPriceIntervals);
  assert.notEqual(verified.binding, adopted.binding);
  proof.sourceInventorySha256 = "c".repeat(64);
  assert.notEqual((await readReloadReadiness(f.executor as never)).binding, verified.binding);
});

test("unapproved worker edges and v1/v2 stock certificate mixtures cannot authorize valuation", async () => {
  type Fixture = ReturnType<typeof lowLoadFixture>;
  const cases: Array<[string, (f: Fixture) => void]> = [
    ["v2 without edge", f => { Reflect.deleteProperty(f.manifest, "lowLoadWorkerUpgrade"); }],
    ["v1 with edge", f => { Object.assign(f.manifest, { stockEntryCostBackfill: stockEntryProof() }); }],
    ["unreviewed predecessor", f => {
      f.manifest.lowLoadWorkerUpgrade.fromSha256 = f.manifest.stockEntryCostUpgrade.workerSourceSha256 = "d".repeat(64);
    }],
    ["same worker", f => { f.manifest.lowLoadWorkerUpgrade.toSha256 = f.manifest.lowLoadWorkerUpgrade.fromSha256; }],
    ["noncanonical successor", f => { f.manifest.lowLoadWorkerUpgrade.toSha256 = "A".repeat(64); }],
    ["edge before stock activation", f => { f.manifest.lowLoadWorkerUpgrade.appliedAt = "2026-06-04T01:59:59Z"; }],
    ["extra edge field", f => { Object.assign(f.manifest.lowLoadWorkerUpgrade, { reason: "upgrade" }); }],
    ["unbound original return worker", f => { f.plan.source_sha256 = f.manifest.lowLoadWorkerUpgrade.toSha256; }],
    ["proof before edge", f => { f.manifest.stockEntryCostBackfill.verifiedAt = "2026-06-05T09:59:59Z"; }],
    ["proof from predecessor worker", f => { f.manifest.stockEntryCostBackfill.workerSourceSha256 = f.manifest.lowLoadWorkerUpgrade.fromSha256; }],
    ["wrong history cutoff", f => { f.manifest.stockEntryCostBackfill.toExclusive = "2026-11-27"; }],
    ["empty inventory interval", f => { f.manifest.stockEntryCostBackfill.from = "2026-11-26"; }],
    ["invalid inventory date", f => { f.manifest.stockEntryCostBackfill.from = "2026-02-29"; }],
    ["absent inventory fingerprint", f => { Reflect.deleteProperty(f.manifest.stockEntryCostBackfill, "sourceInventorySha256"); }],
    ["extra inventory field", f => { Object.assign(f.manifest.stockEntryCostBackfill, { partial: false }); }],
    ["invalid null count", f => { f.manifest.stockEntryCostBackfill.nullCounts.tsena = 4; }]
  ];
  for (const [why, mutate] of cases) {
    const f = lowLoadFixture();
    mutate(f);
    const result = await readReloadReadiness(f.executor as never);
    assert.equal(result.status, "blocked", why);
    assert.equal(result.stockEntryCostCoverage, undefined, why);
  }
  const native = nativeStockEntryFixture();
  Object.assign(native.plan.manifest, { lowLoadWorkerUpgrade: lowLoadFixture().manifest.lowLoadWorkerUpgrade });
  assert.equal((await readReloadReadiness(native.executor as never)).status, "blocked");
});

test("v2 historical supplier proofs require the same generation inside stage coverage without certifying the routine source", async t => {
  // Keep the out-of-stage case in the past so the open-day guard cannot hide a missing stage check.
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-30T00:00:00Z") });
  const f = lowLoadFixture();
  // Narrow the stage to distinguish both proof bounds from the ordinary reload floor.
  f.manifest.stockEntryCostBackfill.from = "2026-06-02";
  const receipts = "document_postuplenie_tovarov";
  f.manifest.sources.push({
    key: receipts, entity: "Document_ПоступлениеТоваров", kind: "dated", tables: [receipts, `${receipts}_tovary`],
    floor: "2026-06-03", required: false
  });
  const proof = {
    ...historicalReceiptProof(), version: 2, workerSourceSha256: f.manifest.lowLoadWorkerUpgrade.toSha256,
    from: "2026-06-02", verifiedAt: "2026-11-26T02:00:00Z"
  };
  const before = await readReloadReadiness(f.executor as never);
  Object.assign(f.manifest, { stockEntryReceiptProofs: { [receiptSku]: proof } });
  const after = await readReloadReadiness(f.executor as never);
  assert.equal(after.status, "ready");
  assert.deepEqual(after.stockEntryHistoricalReceiptCoverage, [{ sku: receiptSku, from: "2026-06-02", toExclusive: "2026-06-03" }]);
  assert.notEqual(after.binding, before.binding);
  const window = { from: new Date("2026-06-02"), to: new Date("2026-06-03") };
  assert.equal(evaluateCoverage(after, receipts, window, "2026-11-26").reason, "before_horizon");
  for (const [why, entry] of [
    ["unversioned proof", historicalReceiptProof()],
    ["other worker", { ...proof, workerSourceSha256: f.plan.source_sha256 }],
    ["before stage", { ...proof, from: "2026-06-01" }],
    ["past stage", { ...proof, toExclusive: "2026-11-27", verifiedAt: "2026-11-28T02:00:00Z" }],
    ["before stage verification", { ...proof, verifiedAt: "2026-11-26T00:59:59Z" }],
    ["extra key", { ...proof, extra: true }]
  ] as const) {
    Object.assign(f.manifest, { stockEntryReceiptProofs: { [receiptSku]: entry } });
    const result = await readReloadReadiness(f.executor as never);
    assert.equal(result.status, "blocked", why);
    assert.equal(result.stockEntryHistoricalReceiptCoverage, undefined, why);
  }
});

test("stock entry activation preserves the verified return generation and its price intervals", async () => {
  const f = stockEntryFixture();
  const result = await readReloadReadiness(f.executor as never);
  assert.equal(result.status, "ready");
  assert.equal(result.stockEntryCostAvailable, true);
  assert.equal(result.stockEntryCostBackfillVerified, true);
  assert.equal(result.stockEntryCostCoverage, undefined);
  assert.equal(Object.keys(result).includes("stockEntryCostAvailable"), false);
  assert.match(result.binding, new RegExp(`^${id}:3:ready:verified:.+:${stockEntryContract}:ready$`));
  assert.deepEqual(result.returnPriceIntervals, [{ from: "2026-06-01", to: "2026-06-02" }, { from: "2026-06-02", to: "2026-06-03" }]);
});

test("prepared stock entry layout preserves ordinary readiness but cannot authorize valuation until hydration is verified", async () => {
  const f = stockEntryFixture();
  Reflect.deleteProperty(f.manifest, "stockEntryCostBackfill");
  const prepared = await readReloadReadiness(f.executor as never);
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.stockEntryCostAvailable, false);
  assert.equal(prepared.stockEntryCostBackfillVerified, false);
  assert.equal(prepared.returnPriceIntervals.length, 2);
  Object.assign(f.manifest, { stockEntryCostBackfill: stockEntryProof() });
  f.plan.revision++;
  const completed = await readReloadReadiness(f.executor as never);
  assert.equal(completed.stockEntryCostAvailable, true);
  assert.equal(completed.stockEntryCostBackfillVerified, true);
  assert.notEqual(completed.binding, prepared.binding);
});

test("historical receipt proof authorizes only its private SKU interval and changes the cache identity, not receipt source coverage", async () => {
  const f = stockEntryFixture();
  const receipts = "document_postuplenie_tovarov";
  f.manifest.sources.push({
    key: receipts, entity: "Document_ПоступлениеТоваров", kind: "dated", tables: [receipts, `${receipts}_tovary`],
    floor: "2026-06-03", required: false
  });
  const window = { from: new Date("2026-06-01"), to: new Date("2026-06-03") };
  const before = await readReloadReadiness(f.executor as never);
  assert.equal(before.stockEntryHistoricalReceiptCoverage, undefined);
  Object.assign(f.manifest, { stockEntryReceiptProofs: { [receiptSku]: historicalReceiptProof() } });
  const after = await readReloadReadiness(f.executor as never);
  assert.equal(after.status, "ready");
  assert.deepEqual(after.stockEntryHistoricalReceiptCoverage, [{ sku: receiptSku, from: "2026-06-01", toExclusive: "2026-06-03" }]);
  assert.equal(Object.keys(after).includes("stockEntryHistoricalReceiptCoverage"), false);
  assert.notEqual(after.binding, before.binding);
  assert.equal(evaluateCoverage(after, receipts, window, "2026-06-06").reason, "before_horizon");
  assert.deepEqual(evaluateCoverage(after, receipts, window, "2026-06-06"), evaluateCoverage(before, receipts, window, "2026-06-06"));
  const changedDigests = { ...historicalReceiptProof(), sourceSha256: "e".repeat(64), targetSha256: "e".repeat(64) };
  Object.assign(f.manifest, { stockEntryReceiptProofs: { [receiptSku]: changedDigests } });
  const replacement = await readReloadReadiness(f.executor as never);
  assert.deepEqual(replacement.stockEntryHistoricalReceiptCoverage, after.stockEntryHistoricalReceiptCoverage);
  assert.notEqual(replacement.binding, after.binding, "same scope with newer proof bytes must invalidate cached valuation");
});

test("historical receipt proof fails closed for an unapproved layout, invalid range, or altered parity", async () => {
  const good = historicalReceiptProof();
  for (const [why, sku, patch] of [
    ["uppercase SKU", receiptSku.toUpperCase(), {}], ["blank SKU", "00000000-0000-0000-0000-000000000000", {}],
    ["invalid leap day", receiptSku, { from: "2026-02-29" }],
    ["before immutable floor", receiptSku, { from: "2026-05-31" }],
    ["empty range", receiptSku, { toExclusive: good.from }],
    ["range over 366 days", receiptSku, { toExclusive: "2027-06-03", verifiedAt: "2027-06-06T00:00:00Z" }],
    ["after last completed day at verification", receiptSku, { toExclusive: "2026-06-07" }],
    ["proof before verified hydration", receiptSku, { verifiedAt: "2026-06-04T23:59:59Z" }],
    ["digest mismatch", receiptSku, { targetSha256: "0".repeat(64) }],
    ["unexpected field", receiptSku, { workerSourceSha256: "d".repeat(64) }]
  ] as const) {
    const f = stockEntryFixture();
    Object.assign(f.manifest, { stockEntryReceiptProofs: { [sku]: { ...good, ...patch } } });
    const result = await readReloadReadiness(f.executor as never);
    assert.equal(result.status, "blocked", why);
    assert.equal(result.stockEntryHistoricalReceiptCoverage, undefined, why);
  }
  const empty = stockEntryFixture();
  Object.assign(empty.manifest, { stockEntryReceiptProofs: {} });
  assert.equal((await readReloadReadiness(empty.executor as never)).status, "blocked");
  const oversized = stockEntryFixture();
  Object.assign(oversized.manifest, {
    stockEntryReceiptProofs: Object.fromEntries(Array.from({ length: 257 }, (_, index) =>
      [`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, good]))
  });
  assert.equal((await readReloadReadiness(oversized.executor as never)).status, "blocked");
  const prepared = stockEntryFixture();
  Reflect.deleteProperty(prepared.manifest, "stockEntryCostBackfill");
  const native = retailFixture(false);
  native.layout.contract_sha256 = native.plan.contract_sha256 = stockEntryContract;
  const old = retailFixture();
  for (const f of [prepared, native, old]) {
    Object.assign(f.plan.manifest, { stockEntryReceiptProofs: { [receiptSku]: good } });
    const result = await readReloadReadiness(f.executor as never);
    assert.equal(result.status, "blocked");
    assert.equal(result.stockEntryHistoricalReceiptCoverage, undefined);
  }
});

test("old compact layouts remain readable without stock entry capability; native stock layouts do not need upgrades", async () => {
  const old = retailFixture();
  const prior = await readReloadReadiness(old.executor as never);
  assert.equal(prior.status, "ready");
  assert.equal(prior.stockEntryCostAvailable, false);
  const fresh = retailFixture(false);
  fresh.layout.contract_sha256 = fresh.plan.contract_sha256 = stockEntryContract;
  fresh.identity.stock_entry_columns = true;
  fresh.jobs[0].verified_manifest.tables[returnTable].nullCounts.tsena = 0;
  const ready = await readReloadReadiness(fresh.executor as never);
  assert.equal(ready.status, "ready");
  assert.equal(ready.stockEntryCostAvailable, false, "native DDL is not historical hydration evidence");
  assert.deepEqual(ready.returnPriceIntervals, [{ from: "2026-06-01", to: "2026-06-02" }]);
  fresh.identity.stock_entry_columns = false;
  const missingOptionalTable = await readReloadReadiness(fresh.executor as never);
  assert.equal(missingOptionalTable.status, "ready");
  assert.equal(missingOptionalTable.stockEntryCostAvailable, false);
  const stale = stockEntryFixture();
  stale.layout.contract_sha256 = newContract;
  assert.equal((await readReloadReadiness(stale.executor as never)).status, "blocked");
});

function nativeStockEntryFixture() {
  const f = retailFixture(false);
  f.layout.contract_sha256 = f.plan.contract_sha256 = stockEntryContract;
  f.identity.stock_entry_columns = true;
  const table = "document_oprihodovanie_tovarov", child = `${table}_tovary`, entity = "Document_ОприходованиеТоваров";
  f.identity.tables.push(table, child);
  f.plan.manifest.sources.push({ key: table, entity, kind: "dated", tables: [table, child], floor: "2026-06-01", required: true });
  const jobs = f.plan.manifest.recoveryJobs.map((job, index) => ({
    ...job, jobKey: String(index + 4).repeat(64), source: table, sourceEntity: entity, phase: "incremental", parentTable: table, childTables: [child]
  }));
  f.plan.manifest.recoveryJobs.push(...jobs);
  f.plan.manifest.requiredRecoveryJobCount += jobs.length;
  f.plan.manifest.recoveryJobsSha256 = digest(f.plan.manifest.recoveryJobs);
  f.jobs.push(...jobs.map((job, index) => {
    const original = f.jobs[index];
    const tables = {
      [table]: { ...original.verified_manifest.tables[retailTable] },
      [child]: { ...original.verified_manifest.tables[returnTable], nullCounts: { nomenklatura_key: 0, harakteristika_key: 0, kolichestvo: 0, tsena: 0 }, resourceTotals: { kolichestvo: "0", tsena: "0" } }
    };
    return { ...original, phase: job.phase, job_key: job.jobKey, source_entity: entity, business_sha256: digest(tables),
      verified_manifest: { ...original.verified_manifest, jobKey: job.jobKey, tables } };
  }));
  return { ...f, stockEntryChild: child, stockEntryEntity: entity };
}

test("native stock-entry authorization is limited to the completely verified original replay window", async () => {
  const f = nativeStockEntryFixture(), child = f.stockEntryChild;
  let result = await readReloadReadiness(f.executor as never);
  assert.equal(result.stockEntryCostBackfillVerified, true);
  assert.deepEqual(result.stockEntryCostCoverage, { from: "2026-06-01", toExclusive: "2026-06-03" });
  const last = f.jobs.at(-1)!;
  delete last.verified_manifest.tables[child].nullCounts.tsena;
  last.business_sha256 = digest(last.verified_manifest.tables);
  result = await readReloadReadiness(f.executor as never);
  assert.equal(result.status, "ready");
  assert.equal(result.stockEntryCostAvailable, false);
  assert.equal(result.stockEntryCostCoverage, undefined);
});

test("native stock-entry coverage extends through contiguous bound routine days, but not through gaps or incomplete evidence", async () => {
  const f = nativeStockEntryFixture();
  const cycleId = "00000000-0000-4000-8000-000000000006";
  const cycle: (typeof f.plan.manifest.routineCycles)[string] = {
    createdAt: "2026-06-06T00:00:00Z", window: { from: "2026-06-03", toExclusive: "2026-06-06" }, jobs: []
  };
  f.plan.manifest.routineCycles[cycleId] = cycle;
  const addDay = (rangeStart: string, rangeEndExclusive: string) => {
    const original = f.jobs[2];
    const identity = { reloadId: id, cycleId, phase: "incremental", sourceEntity: f.stockEntryEntity, rangeStart, rangeEndExclusive, balancePeriod: null };
    const jobKey = digest(identity);
    const descriptor = { ...f.plan.manifest.recoveryJobs[2], ...identity, jobKey };
    const job = {
      ...structuredClone(original), cycle_id: cycleId, range_start: rangeStart, range_end_exclusive: rangeEndExclusive, job_key: jobKey,
      verified_manifest: { ...structuredClone(original.verified_manifest), jobKey, scope: { kind: "dated", rangeStart, rangeEndExclusive, balancePeriod: null } }
    };
    cycle.jobs.push(descriptor);
    f.jobs.push(job);
    f.plan.revision++;
    return job;
  };
  const initial = await readReloadReadiness(f.executor as never);
  addDay("2026-06-03", "2026-06-04");
  addDay("2026-06-05", "2026-06-06");
  const gap = await readReloadReadiness(f.executor as never);
  assert.deepEqual(gap.stockEntryCostCoverage, { from: "2026-06-01", toExclusive: "2026-06-04" });
  assert.notEqual(gap.binding, initial.binding);
  const middle = addDay("2026-06-04", "2026-06-05");
  const lines = middle.verified_manifest.tables[f.stockEntryChild];
  lines.resourceTotals = { kolichestvo: "0" };
  middle.business_sha256 = digest(middle.verified_manifest.tables);
  assert.deepEqual((await readReloadReadiness(f.executor as never)).stockEntryCostCoverage, gap.stockEntryCostCoverage);
  lines.resourceTotals = { kolichestvo: "0", tsena: "0" };
  middle.business_sha256 = digest(middle.verified_manifest.tables);
  cycle.window.from = "2026-06-05";
  assert.deepEqual((await readReloadReadiness(f.executor as never)).stockEntryCostCoverage, initial.stockEntryCostCoverage);
  cycle.window.from = "2026-06-03";
  assert.deepEqual((await readReloadReadiness(f.executor as never)).stockEntryCostCoverage, { from: "2026-06-01", toExclusive: "2026-06-06" });
});

test("stock entry layout fails closed without the exact reviewed edge, historical worker and verified predecessor", async () => {
  type Fixture = ReturnType<typeof stockEntryFixture>;
  const cases: Array<[string, (f: Fixture) => void]> = [
    ["missing explicit binding", f => { Reflect.deleteProperty(f.manifest, "stockEntryCostUpgrade"); }],
    ["missing physical columns", f => { f.identity.stock_entry_columns = false; }],
    ["plan not ready", f => { f.plan.status = "reloading"; }],
    ["missing predecessor", f => { f.manifest.returnPriceUpgrade = undefined; }],
    ["direct from predecessor contract without verified upgrade", f => { f.plan.contract_sha256 = newContract; f.manifest.returnPriceUpgrade = undefined; }],
    ["native plan with stale upgrade fields", f => { f.plan.contract_sha256 = stockEntryContract; }],
    ["unverified predecessor", f => { f.manifest.returnPriceUpgrade!.state = "backfilling"; f.manifest.returnPriceUpgrade!.verifiedAt = null; }],
    ["wrong worker", f => { f.manifest.stockEntryCostUpgrade.previousWorkerSourceSha256 = "0".repeat(64); }],
    ["same worker", f => { f.manifest.stockEntryCostUpgrade.workerSourceSha256 = f.plan.source_sha256; }],
    ["earlier activation", f => { f.manifest.stockEntryCostUpgrade.appliedAt = "2026-06-04T00:00:00Z"; }],
    ["activation predates verification within one millisecond", f => {
      f.manifest.returnPriceUpgrade!.verifiedAt = "2026-06-04T01:00:00.000002Z";
      f.manifest.stockEntryCostUpgrade.appliedAt = "2026-06-04T01:00:00.000001Z";
    }],
    ["hydration predates activation", f => { f.manifest.stockEntryCostBackfill.verifiedAt = "2026-06-04T01:30:00Z"; }],
    ["hydration null count exceeds rows", f => { f.manifest.stockEntryCostBackfill.nullCounts.tsena = 4; }],
    ["hydration has no linked document", f => { f.manifest.stockEntryCostBackfill.documents = 0; }],
    ["hydration has no value fingerprint", f => { Reflect.deleteProperty(f.manifest.stockEntryCostBackfill, "valuesSha256"); }],
    ["changed column type", f => { f.manifest.stockEntryCostUpgrade.columns.tsena = "double precision"; }],
    ["unexpected column", f => { Object.assign(f.manifest.stockEntryCostUpgrade.columns, { summa: "numeric" }); }],
    ["missing predecessor cycle", f => { delete f.manifest.routineCycles[upgradeCycle]; }],
    ["predecessor day not verified", f => { f.jobs[2].status = "failed"; }],
    ["predecessor table proof changed", f => { f.jobs[2].business_sha256 = "b".repeat(64); }],
    ["missing retained price total", f => {
      const job = f.jobs[2];
      job.verified_manifest.tables[returnTable].resourceTotals = {};
      job.business_sha256 = digest(job.verified_manifest.tables);
    }],
    ["predecessor canary not bound", f => { f.manifest.returnPriceUpgrade!.canaryPasses.forEach(pass => { pass.targetSha256 = "0".repeat(64); }); }]
  ];
  for (const [why, mutate] of cases) {
    const f = stockEntryFixture();
    mutate(f);
    const result = await readReloadReadiness(f.executor as never);
    assert.equal(result.status, "blocked", why);
    assert.equal(result.stockEntryCostAvailable, false, why);
    assert.deepEqual(result.returnPriceIntervals, [], why);
  }
});

test("return price upgrade accepts only the exact transition and authenticated parent shape", () => {
  const f = retailFixture();
  assert.equal(validReturnPriceUpgrade(f.plan.manifest, oldContract, newContract), true);
  assert.equal(validReturnPriceUpgrade(f.plan.manifest, newContract, newContract), false);
  assert.equal(validReturnPriceUpgrade(f.plan.manifest, oldContract, "0".repeat(64)), false);
  for (const patch of [
    { version: 2 }, { column: "summa" }, { table: retailTable }, { fromContractSha256: "0".repeat(64) },
    { rangeStart: "2026-02-30" }, { rangeEndExclusive: "2026-06-01" }, { canaryDay: "2026-06-03" },
    { cycleId: "not-a-uuid" }, { workerSourceSha256: "not-a-hash" }, { appliedAt: "2026-06-04" },
    { state: "verified", verifiedAt: "2026-06-04T01:00:00Z" },
    { canaryPasses: [{ sourceSha256: "a".repeat(64), targetSha256: "b".repeat(64) }] }
  ]) assert.equal(validReturnPriceUpgrade({ ...f.plan.manifest, returnPriceUpgrade: { ...returnUpgrade(), ...patch } }, oldContract, newContract), false, JSON.stringify(patch));
  for (const patch of [{ reloadId: "bad" }, { planSha256: "bad" }, { targetDatabase: { name: "nalivdata", oid: 1 } }, { sourceSchema: { name: "raw_1c", oid: 1 } }]) {
    assert.equal(validReturnPriceUpgrade({ ...f.plan.manifest, ...patch }, oldContract, newContract), false);
  }
  const upgrade = publishUpgradeCycle(f);
  upgrade.state = "verified"; upgrade.verifiedAt = "2026-06-04T01:00:00Z";
  assert.equal(validReturnPriceUpgrade(f.plan.manifest, oldContract, newContract), true);
  upgrade.canaryPasses[1].targetSha256 = "c".repeat(64);
  assert.equal(validReturnPriceUpgrade(f.plan.manifest, oldContract, newContract), false);
});

test("old ready plan remains bound to the upgraded layout without certifying old return prices", async () => {
  const f = retailFixture(), original = structuredClone(f.jobs);
  const result = await readReloadReadiness(f.executor as never);
  assert.equal(result.status, "ready");
  assert.equal(result.completedJobs, 2);
  assert.deepEqual(result.returnPriceIntervals, []);
  assert.deepEqual(f.jobs, original);
  assert.equal(Object.keys(result).includes("returnPriceIntervals"), false);
  assert.equal(JSON.stringify(result).includes("returnPriceIntervals"), false);
  assert.equal(evaluateCoverage(result, "retail", { from: new Date("2026-06-01"), to: new Date("2026-06-03") }, "2026-06-04").status, "verified");
  f.plan.manifest.targetDatabase.oid = 1;
  assert.equal((await readReloadReadiness(f.executor as never)).status, "blocked");
});

test("arbitrary hash transitions, wrong plan identity and missing retained children remain blocked", async () => {
  for (const mutate of [
    (f: ReturnType<typeof retailFixture>) => { f.layout.contract_sha256 = "0".repeat(64); },
    (f: ReturnType<typeof retailFixture>) => { f.layout.migration_id = upgradeCycle; },
    (f: ReturnType<typeof retailFixture>) => { f.plan.table_schema = "other"; },
    (f: ReturnType<typeof retailFixture>) => { f.plan.manifest.reloadId = upgradeCycle; },
    (f: ReturnType<typeof retailFixture>) => { delete f.jobs[0].verified_manifest.tables[returnTable]; }
  ]) {
    const f = retailFixture(); mutate(f);
    assert.equal((await readReloadReadiness(f.executor as never)).status, "blocked");
  }
});

test("verified upgrade requires its complete daily cycle and retained price evidence", async () => {
  const f = retailFixture(), upgrade = publishUpgradeCycle(f);
  upgrade.state = "verified"; upgrade.verifiedAt = "2026-06-04T01:00:00Z";
  let result = await readReloadReadiness(f.executor as never);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.returnPriceIntervals, [{ from: "2026-06-01", to: "2026-06-02" }, { from: "2026-06-02", to: "2026-06-03" }]);
  for (const status of ["pending", "failed", "running", "paused_capacity"]) {
    f.jobs[3].status = status;
    result = await readReloadReadiness(f.executor as never);
    assert.equal(result.status, "blocked", status);
    assert.deepEqual(result.returnPriceIntervals, []);
  }
  f.jobs[3].status = "verified";
  delete f.jobs[3].verified_manifest.tables[returnTable].nullCounts.tsena;
  assert.equal((await readReloadReadiness(f.executor as never)).status, "blocked");
});

test("a verified upgrade cannot substitute cycle scopes, worker adoption or a different canary result", async () => {
  for (const mutate of [
    (f: ReturnType<typeof retailFixture>) => { f.plan.source_sha256 = "0".repeat(64); },
    (f: ReturnType<typeof retailFixture>) => { f.plan.manifest.routineCycles[upgradeCycle].window.toExclusive = "2026-06-04"; },
    (f: ReturnType<typeof retailFixture>) => { f.plan.manifest.routineCycles[upgradeCycle].jobs = []; },
    (f: ReturnType<typeof retailFixture>) => { f.plan.manifest.returnPriceUpgrade!.canaryPasses.forEach(pass => { pass.sourceSha256 = "0".repeat(64); }); },
    (f: ReturnType<typeof retailFixture>) => { f.plan.manifest.returnPriceUpgrade!.canaryPasses.forEach(pass => { pass.targetSha256 = "0".repeat(64); }); }
  ]) {
    const f = retailFixture(), upgrade = publishUpgradeCycle(f);
    upgrade.state = "verified"; upgrade.verifiedAt = "2026-06-04T01:00:00Z";
    mutate(f);
    assert.equal((await readReloadReadiness(f.executor as never)).status, "blocked");
  }
});

test("price intervals are field-specific verified evidence on fresh layouts and partial backfills", async () => {
  const f = retailFixture(false);
  f.jobs[0].verified_manifest.tables[returnTable].nullCounts.tsena = 2;
  f.jobs[0].verified_manifest.tables[retailTable].rows = 1;
  f.jobs[0].verified_manifest.tables[returnTable].rows = 2;
  f.jobs[0].source_rows = 3n; f.jobs[0].written_rows = 3n;
  let result = await readReloadReadiness(f.executor as never);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.returnPriceIntervals, [{ from: "2026-06-01", to: "2026-06-02" }], "explicit source NULL prices certify the field, not a fabricated zero");
  const g = retailFixture();
  publishUpgradeCycle(g);
  g.jobs[2].status = "failed";
  result = await readReloadReadiness(g.executor as never);
  assert.equal(result.status, "ready", "a failed additive price backfill does not revoke old certified fields");
  assert.deepEqual(result.returnPriceIntervals, [{ from: "2026-06-02", to: "2026-06-03" }]);
});

test("new ordinary retail cycles extend return price certification only after verified field evidence", async () => {
  const f = retailFixture(false);
  const cycleId = "00000000-0000-4000-8000-000000000004";
  const descriptor = { ...f.plan.manifest.recoveryJobs[0], jobKey: "9".repeat(64), cycleId, phase: "incremental", rangeStart: "2026-06-03", rangeEndExclusive: "2026-06-04" };
  f.plan.manifest.routineCycles[cycleId] = { createdAt: "2026-06-04T00:00:00Z", window: { from: "2026-06-03", toExclusive: "2026-06-04" }, jobs: [descriptor] };
  const routine = {
    ...structuredClone(f.jobs[0]), job_key: descriptor.jobKey, cycle_id: cycleId, phase: "incremental",
    range_start: descriptor.rangeStart, range_end_exclusive: descriptor.rangeEndExclusive, status: "pending",
    verified_manifest: { ...structuredClone(f.jobs[0].verified_manifest), jobKey: descriptor.jobKey, scope: {
      kind: "dated", rangeStart: descriptor.rangeStart, rangeEndExclusive: descriptor.rangeEndExclusive, balancePeriod: null
    } }
  };
  routine.verified_manifest.tables[returnTable].nullCounts.tsena = 0;
  f.jobs.push(routine);
  assert.deepEqual((await readReloadReadiness(f.executor as never)).returnPriceIntervals, []);
  routine.status = "failed";
  assert.deepEqual((await readReloadReadiness(f.executor as never)).returnPriceIntervals, []);
  routine.status = "verified";
  const result = await readReloadReadiness(f.executor as never);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.returnPriceIntervals, [{ from: "2026-06-03", to: "2026-06-04" }]);
});

test("return price evidence must belong to the dated retail source, not an entity-name lookalike", async () => {
  const f = retailFixture(false);
  f.jobs[0].verified_manifest.tables[returnTable].nullCounts.tsena = 0;
  f.plan.manifest.sources[0].kind = "snapshot";
  for (const job of f.jobs) job.verified_manifest.scope.kind = "snapshot";
  assert.deepEqual((await readReloadReadiness(f.executor as never)).returnPriceIntervals, []);
  const g = retailFixture(), upgrade = publishUpgradeCycle(g);
  upgrade.state = "verified"; upgrade.verifiedAt = "2026-06-04T01:00:00Z";
  g.plan.manifest.sources[0].kind = "snapshot";
  for (const job of g.jobs) job.verified_manifest.scope.kind = "snapshot";
  assert.equal((await readReloadReadiness(g.executor as never)).status, "blocked");
});

test("upgrade dates reject year zero and timestamps cannot predate application or omit their timezone", () => {
  const f = retailFixture(), upgrade = publishUpgradeCycle(f);
  upgrade.state = "verified"; upgrade.verifiedAt = "2026-06-04T01:00:00Z";
  for (const patch of [
    { rangeStart: "0000-01-01" }, { appliedAt: "0000-01-01T00:00:00Z" },
    { verifiedAt: "2026-06-03T23:59:59Z" }, { verifiedAt: "2026-06-04T01:00:00" },
    { canaryPasses: [upgrade.canaryPasses[0], { ...upgrade.canaryPasses[1], sourceSha256: "0".repeat(64) }] }
  ]) assert.equal(validReturnPriceUpgrade({ ...f.plan.manifest, returnPriceUpgrade: { ...upgrade, ...patch } }, oldContract, newContract), false);
});
test("missing marker wins over failed ledger and unreadable metadata fails closed", async () => {
  const f = fixture(); f.identity.has_layout = false;
  assert.equal((await readReloadReadiness(f.executor as never)).status, "needs_preparation");
  assert.equal((await readReloadReadiness({ $queryRaw: async () => [], $queryRawUnsafe: async () => { throw new Error("denied"); } } as never)).status, "blocked");
});
test("exact expected jobs and checked zero-row evidence certify an empty source", async () => {
  const f = fixture(); const result = await readReloadReadiness(f.executor as never);
  assert.equal(result.status, "ready"); assert.equal(result.completedJobs, 2);
  assert.deepEqual(result.sources, [{ table: "document_chek_kkm", status: "empty", verifiedThrough: "2026-06-03" }, { table: "document_chek_kkm_tovary", status: "empty", verifiedThrough: "2026-06-03" }]);
});
test("missing jobs, mismatched descriptors and a second unfinished plan cannot inherit ready", async () => {
  const f = fixture(); f.jobs.pop(); assert.equal((await readReloadReadiness(f.executor as never)).status, "blocked");
  const g = fixture(); g.jobs[0].range_end_exclusive = "2026-06-03"; assert.equal((await readReloadReadiness(g.executor as never)).status, "blocked");
  const h = fixture(); h.plan.status = "reloading"; const query = h.executor.$queryRawUnsafe; h.executor.$queryRawUnsafe = async sql => sql.includes("analytics_reload_plans\"") ? [h.plan, { ...h.plan, reload_id: "other" }] : query(sql); assert.equal((await readReloadReadiness(h.executor as never)).status, "blocked");
});
test("failure precedes capacity pause; a gap stops verifiedThrough before later successes", async () => {
  const f = fixture(); f.plan.status = "paused_capacity"; f.jobs[0].status = "pending";
  let result = await readReloadReadiness(f.executor as never); assert.equal(result.status, "paused_capacity"); assert.equal(result.sources[0].verifiedThrough, "2026-06-01"); assert.equal(result.sources[0].status, "partial");
  f.jobs[1].status = "failed"; result = await readReloadReadiness(f.executor as never); assert.equal(result.status, "blocked");
});
test("unverified canary and unknown zero rows remain reloading", async () => {
  const f = fixture(); f.plan.status = "reloading"; f.plan.canary_status = "pending"; f.jobs[0].status = "pending";
  const result = await readReloadReadiness(f.executor as never); assert.equal(result.status, "reloading"); assert.equal(result.sources[0].status, "partial");
});
test("one-second reader shares concurrent loads and never caches failures as complete", async () => {
  let now = 0, calls = 0; const f = fixture();
  const reader = createReloadReadinessReader(async () => { calls++; return readReloadReadiness(f.executor as never); }, () => now);
  await Promise.all([reader(), reader()]); assert.equal(calls, 1); await reader(); assert.equal(calls, 1);
  now = 1000; f.jobs.pop(); assert.equal((await reader()).status, "blocked"); assert.equal(calls, 2);
});
test("coverage never skips historical gaps and distinguishes open and pre-horizon periods", async () => {
  const f = fixture(); const state = await readReloadReadiness(f.executor as never); const today = "2026-06-03";
  const coverage = (from: string, to: string) => evaluateCoverage(state, "receipts", { from: new Date(from), to: new Date(to) }, today);
  assert.equal(coverage("2026-06-01", "2026-06-03").status, "verified");
  assert.deepEqual([coverage("2026-06-01", "2026-06-04").status, coverage("2026-06-01", "2026-06-04").reason], ["partial", "open_period"]);
  assert.equal(coverage("2025-06-01", "2025-06-02").status, "unavailable");
  assert.throws(() => requireCoverage(state, { kind: "receipts", from: new Date("2025-06-01"), to: new Date("2025-06-02") }, today), ReloadIncompleteError);
  assert.throws(() => requireCoverage(state, { kind: "receipts", from: new Date("2026-06-04"), to: new Date("2026-06-05") }, today), ReloadIncompleteError);
  assert.doesNotThrow(() => requireCoverage(state, { kind: "all" }, today));
});

test("a verified job cannot omit a declared child collection or change its evidence binding", async () => {
  const f = fixture();
  for (const descriptor of f.plan.manifest.recoveryJobs) descriptor.childTables = [];
  f.plan.manifest.recoveryJobsSha256 = digest(f.plan.manifest.recoveryJobs);
  for (const job of f.jobs) delete job.verified_manifest.tables.document_chek_kkm_tovary;
  assert.equal((await readReloadReadiness(f.executor as never)).status, "blocked");
  const g = fixture(); g.jobs[0].verified_manifest.jobKey = "0".repeat(64);
  assert.equal((await readReloadReadiness(g.executor as never)).status, "blocked");
});

test("routine cycles extend certified days without lowering global readiness or trusting future gaps", async () => {
  const f = fixture();
  const cycle = "00000000-0000-4000-8000-000000000002";
  const descriptor = { ...f.plan.manifest.recoveryJobs[0], jobKey: "9".repeat(64), cycleId: cycle, phase: "incremental", rangeStart: "2026-06-03", rangeEndExclusive: "2026-06-04" };
  Object.assign(f.plan.manifest.routineCycles, { [cycle]: { createdAt: "2026-06-04T00:00:00Z", window: { from: "2026-06-03", toExclusive: "2026-06-04" }, jobs: [descriptor] } });
  const routine = { ...f.jobs[0], job_key: descriptor.jobKey, cycle_id: cycle, phase: "incremental", range_start: descriptor.rangeStart, range_end_exclusive: descriptor.rangeEndExclusive, status: "pending", verified_manifest: { ...f.jobs[0].verified_manifest, jobKey: descriptor.jobKey, scope: { ...f.jobs[0].verified_manifest.scope, rangeStart: descriptor.rangeStart, rangeEndExclusive: descriptor.rangeEndExclusive }, tables: { ...f.jobs[0].verified_manifest.tables, document_chek_kkm: { ...f.jobs[0].verified_manifest.tables.document_chek_kkm, rows: 1 } } } };
  f.jobs.push(routine);
  let result = await readReloadReadiness(f.executor as never);
  assert.equal(result.status, "ready");
  assert.equal(evaluateCoverage(result, "receipts", { from: new Date("2026-06-03"), to: new Date("2026-06-04") }, "2026-06-05").status, "unavailable");
  routine.status = "verified"; result = await readReloadReadiness(f.executor as never);
  assert.equal(result.status, "ready"); assert.equal(result.sources[0].verifiedThrough, "2026-06-04");
  assert.equal(result.sources[0].status, "verified");
  assert.equal(evaluateCoverage(result, "receipts", { from: new Date("2026-06-03"), to: new Date("2026-06-04") }, "2026-06-05").status, "verified");
  assert.equal(evaluateCoverage(result, "receipts", { from: new Date("2026-06-04"), to: new Date("2026-06-05") }, "2026-06-06").status, "unavailable");
});

test("a required source omitted from the declared recovery universe cannot be ready", async () => {
  const f = fixture();
  f.plan.manifest.sources.push({ ...f.plan.manifest.sources[0], key: "retail", entity: "Document_ОтчетОРозничныхПродажах" });
  assert.equal((await readReloadReadiness(f.executor as never)).status, "blocked");
});

test("pending-source errors name the requested business source in Russian", async () => {
  const f = fixture(); f.jobs[0].status = "pending"; f.plan.status = "reloading";
  const result = await readReloadReadiness(f.executor as never);
  assert.throws(() => requireCoverage(result, { kind: "receipts", from: new Date("2026-06-01"), to: new Date("2026-06-02") }), (error: unknown) => {
    assert.ok(error instanceof ReloadIncompleteError); assert.match(error.message, /чеки ККМ/); assert.doesNotMatch(error.message, /document_/); return true;
  });
});
