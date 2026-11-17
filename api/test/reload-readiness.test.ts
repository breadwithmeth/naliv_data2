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
  const identity = { database_name: "nalivdata", database_oid: 1208710n, schema_name: "raw_1c", schema_oid: 55n, database_bytes: 5269000000n, has_layout: true, has_plans: true, has_jobs: true, tables: ["document_chek_kkm", "document_chek_kkm_tovary"] };
  const layout = { table_schema: "raw_1c", layout_version: 1, contract_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), migration_id: id, ddl_frozen: false };
  const plan = { reload_id: id, table_schema: "raw_1c", plan_sha256: layout.plan_sha256, contract_sha256: layout.contract_sha256, index_manifest_sha256: "d".repeat(64), source_sha256: "e".repeat(64), from_date: "2026-06-01", to_exclusive: "2026-06-03", canary_status: "verified", status: "ready", manifest, revision: 3n, updated_at: new Date() };
  const jobs = descriptors.map(d => ({ reload_id: id, job_key: d.jobKey, cycle_id: id, phase: d.phase, source_entity: d.sourceEntity, range_start: d.rangeStart, range_end_exclusive: d.rangeEndExclusive, status: "verified", required: true, source_rows: 0n, written_rows: 0n, business_sha256: "f".repeat(64), verified_at: new Date(), source_sha256: plan.source_sha256, verified_manifest: { manifestVersion: 1, jobKey: d.jobKey, scope: { kind: "dated", rangeStart: d.rangeStart, rangeEndExclusive: d.rangeEndExclusive, balancePeriod: null }, sourceSha256: plan.source_sha256, tables: { document_chek_kkm: { rows: 0, nullCounts: {}, resourceTotals: {}, sha256: "f".repeat(64), targetOnlyRows: 0 }, document_chek_kkm_tovary: { rows: 0, nullCounts: {}, resourceTotals: {}, sha256: "f".repeat(64), targetOnlyRows: 0 } } } }));
  const executor = { $queryRaw: async () => [], $queryRawUnsafe: async (sql: string) => sql.includes("pg_database_size") ? [identity] : sql.includes("analytics_storage_layout\"") ? [layout] : sql.includes("analytics_reload_plans\"") ? [plan] : jobs };
  return { identity, layout, plan, jobs, executor };
}

const oldContract = "a6f5f51899a2d2c14508b0203eb3cf0f3a0368f506fb9a0449ad100933a81871";
const newContract = "64f140bdcfbb1d5944677d96f9842804199ca8931ffb6fd2b34ea41016c85c54";
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
