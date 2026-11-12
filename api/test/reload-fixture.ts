import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

/** Test-only fixture: a pinned nalivdata transaction, always rolled back by caller. */
export async function installReloadFixture(tx: Prisma.TransactionClient) {
  const [target] = await tx.$queryRaw<Array<{ name: string; oid: bigint }>>`select current_database() as name, oid::bigint from pg_database where datname=current_database()`;
  assert.equal(target.name, "nalivdata", "No fixture DDL is authorized outside nalivdata");
  await tx.$executeRawUnsafe(`create temp table document_chek_kkm (ref_key text, date timestamp, amount numeric) on commit drop`);
  await tx.$executeRawUnsafe(`create temp table document_chek_kkm_tovary (_parent_ref_key text, amount numeric) on commit drop`);
  await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (ref_key text, date timestamp) on commit drop`);
  await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_tovary (_parent_ref_key text) on commit drop`);
  await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary (_parent_ref_key text) on commit drop`);
  await tx.$executeRawUnsafe(`create temp table document_ustanovka_tsen_nomenklatury (ref_key text, date timestamp) on commit drop`);
  await tx.$executeRawUnsafe(`create temp table document_ustanovka_tsen_nomenklatury_tovary (_parent_ref_key text) on commit drop`);
  await tx.$executeRawUnsafe(`create temp table accumulation_register_tovary_na_skladah_balance (balance_period timestamp) on commit drop`);
  await tx.$executeRawUnsafe(`insert into pg_temp.document_chek_kkm values ('retained','2026-06-01',12)`);
  const [namespace] = await tx.$queryRaw<Array<{ name: string; oid: bigint }>>`select nspname as name, oid::bigint from pg_namespace where oid=pg_my_temp_schema()`;
  await tx.$executeRawUnsafe(`create temp table analytics_storage_layout(table_schema text primary key, layout_version int, contract_sha256 text, plan_sha256 text, migration_id uuid, ddl_frozen boolean) on commit drop`);
  await tx.$executeRawUnsafe(`create temp table analytics_reload_plans(reload_id uuid primary key, table_schema text, plan_sha256 text, contract_sha256 text, index_manifest_sha256 text, source_sha256 text, from_date date, to_exclusive date, canary_status text, status text, manifest jsonb, revision bigint, updated_at timestamptz) on commit drop`);
  await tx.$executeRawUnsafe(`create temp table analytics_reload_jobs(reload_id uuid, job_key text, cycle_id uuid, phase text, source_entity text, range_start date, range_end_exclusive date, status text, required boolean, source_rows bigint, written_rows bigint, business_sha256 text, verified_at timestamptz, source_sha256 text, verified_manifest jsonb, primary key(reload_id,job_key)) on commit drop`);
  const id = randomUUID(), planSha = "a".repeat(64), contractSha = "b".repeat(64), sourceSha = "c".repeat(64);
  const sources = [
    { key: "receipts", entity: "Document_ЧекККМ", kind: "dated", tables: ["document_chek_kkm", "document_chek_kkm_tovary"] },
    { key: "retail", entity: "Document_ОтчетОРозничныхПродажах", kind: "dated", tables: ["document_otchet_o_roznichnyh_prodazhah", "document_otchet_o_roznichnyh_prodazhah_tovary", "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary"] },
    { key: "prices", entity: "Document_УстановкаЦенНоменклатуры", kind: "dated", tables: ["document_ustanovka_tsen_nomenklatury", "document_ustanovka_tsen_nomenklatury_tovary"] },
    { key: "stock", entity: "AccumulationRegister_ТоварыНаСкладах", kind: "balance", tables: ["accumulation_register_tovary_na_skladah_balance"] }
  ].map(source => ({ ...source, floor: "2026-06-01", required: true, recovery: true }));
  const jobs = sources.flatMap(source => ["2026-06-01", "2026-06-02"].map((from, index) => ({ jobKey: createHash("sha256").update(`${source.key}:${from}`).digest("hex"), cycleId: id, phase: "recovery", source: source.key, sourceEntity: source.entity, rangeStart: from, rangeEndExclusive: index ? "2026-06-03" : "2026-06-02", balancePeriod: source.kind === "balance" ? `${index ? "2026-06-03" : "2026-06-02"}T00:00:00` : null, required: true, parentTable: source.tables[0], childTables: source.tables.slice(1) })));
  const canonical = JSON.stringify(jobs, (_key, value) => value && !Array.isArray(value) && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const manifest = { manifestVersion: 1, reloadId: id, targetDatabase: { name: target.name, oid: Number(target.oid) }, sourceSchema: { name: namespace.name, oid: Number(namespace.oid) }, planSha256: planSha, preDdlSummarySha256: "d".repeat(64), from: "2026-06-01", toExclusive: "2026-06-03", canaryDay: "2026-06-01", sources, requiredRecoveryJobCount: jobs.length, recoveryJobs: jobs, recoveryJobsSha256: createHash("sha256").update(canonical).digest("hex"), routineCycles: {} };
  await tx.$executeRaw`insert into pg_temp.analytics_storage_layout values (${namespace.name},1,${contractSha},${planSha},${id}::uuid,false)`;
  await tx.$executeRaw`insert into pg_temp.analytics_reload_plans values (${id}::uuid,${namespace.name},${planSha},${contractSha},${"e".repeat(64)},${sourceSha},'2026-06-01','2026-06-03','pending','reloading',${JSON.stringify(manifest)}::jsonb,0,now())`;
  for (const job of jobs) await tx.$executeRaw`insert into pg_temp.analytics_reload_jobs(reload_id,job_key,cycle_id,phase,source_entity,range_start,range_end_exclusive,status,required) values (${id}::uuid,${job.jobKey},${id}::uuid,'recovery',${job.sourceEntity},${new Date(job.rangeStart)},${new Date(job.rangeEndExclusive)},'pending',true)`;
  return { namespace: namespace.name, id, jobs, async verify(firstDayOnly = false) {
    for (const job of jobs.filter(job => !firstDayOnly || job.rangeStart === "2026-06-01")) {
      const source = sources.find(source => source.key === job.source)!;
      const evidence = { manifestVersion: 1, jobKey: job.jobKey, scope: { kind: source.kind, rangeStart: job.rangeStart, rangeEndExclusive: job.rangeEndExclusive, balancePeriod: job.balancePeriod }, sourceSha256: sourceSha, tables: Object.fromEntries(source.tables.map(table => [table, { rows: table === "document_chek_kkm" && job.rangeStart === "2026-06-01" ? 1 : 0, nullCounts: {}, resourceTotals: {}, sha256: "f".repeat(64), targetOnlyRows: 0 }])) };
      await tx.$executeRaw`update pg_temp.analytics_reload_jobs set status='verified',source_rows=0,written_rows=0,business_sha256=${"f".repeat(64)},verified_at=now(),source_sha256=${sourceSha},verified_manifest=${JSON.stringify(evidence)}::jsonb where job_key=${job.jobKey}`;
    }
    await tx.$executeRaw`update pg_temp.analytics_reload_plans set canary_status='verified',status=${firstDayOnly ? "reloading" : "ready"},revision=revision+1`;
  } };
}
