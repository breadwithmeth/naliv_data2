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
const { readReloadReadiness, createReloadReadinessReader, evaluateCoverage, requireCoverage, ReloadIncompleteError } = await import("../src/services/reload-readiness.js");
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
