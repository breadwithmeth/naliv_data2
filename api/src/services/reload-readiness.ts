import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { businessToday } from "../lib/business-day.js";
import { prisma } from "../prisma.js";
import { RETURN_PRICE_EFFECTIVE_CONTRACT_SHA256, RETURN_PRICE_SOURCE_ENTITY, RETURN_PRICE_TABLE, returnPriceUpgradeSchema } from "./return-price-upgrade.js";
import {
  STOCK_ENTRY_COLUMNS, STOCK_ENTRY_EFFECTIVE_CONTRACT_SHA256, STOCK_ENTRY_PARENT, STOCK_ENTRY_SOURCE_ENTITY, STOCK_ENTRY_TABLE,
  parseStockEntryReceiptProofs, reloadContractBinding, stockEntryEvidenceBinding, type StockEntryHistoricalReceiptCoverage
} from "./stock-entry-upgrade.js";
export { validReturnPriceUpgrade } from "./return-price-upgrade.js";
export { businessToday } from "../lib/business-day.js";

type Executor = Pick<Prisma.TransactionClient, "$queryRaw" | "$queryRawUnsafe">;
/** Mirrors naliv_data1 analytics_reload.PAUSE_AT_BYTES (writer capacity pause). */
export const RELOAD_PAUSE_AT_BYTES = 12_000_000_000;
export type ReloadCoverage = { status: "verified" | "partial" | "unavailable"; requestedFrom: string; requestedToExclusive: string; verifiedThrough: string | null; reason: "reloading" | "before_horizon" | "open_period" | null };
export type ReloadRequirement = { kind: "receipts" | "retail" | "all"; from?: Date; to?: Date };
export type ReloadReadiness = {
  status: "needs_preparation" | "reloading" | "paused_capacity" | "blocked" | "ready";
  from: string | null; toExclusive: string | null; completedJobs: number; totalJobs: number;
  sources: Array<{ table: string; status: "missing" | "empty" | "partial" | "verified" | "unavailable"; verifiedThrough: string | null }>;
  databaseBytes: number; pauseAtBytes: number;
};
const identifier = z.string().regex(/^[a-z_][a-z0-9_]*$/i);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const kinds = z.enum(["dated", "records", "balance", "snapshot", "reference", "membership"]);
const sourceSchema = z.object({ key: z.string().min(1), entity: z.string().min(1), kind: kinds, tables: z.array(identifier).min(1), floor: day.nullish(), required: z.boolean(), recovery: z.boolean().optional(), unavailable: z.boolean().optional() });
const descriptorSchema = z.object({ jobKey: sha, cycleId: z.string().uuid(), phase: z.enum(["recovery", "incremental", "reference", "price_audit", "deep_reread"]), source: z.string(), sourceEntity: z.string(), rangeStart: day.nullable(), rangeEndExclusive: day.nullable(), balancePeriod: z.string().nullable(), required: z.boolean(), parentTable: identifier, childTables: z.array(identifier) });
const manifestSchema = z.object({ manifestVersion: z.literal(1), reloadId: z.string().uuid(), targetDatabase: z.object({ name: z.literal("nalivdata"), oid: z.number().int().positive() }), sourceSchema: z.object({ name: identifier, oid: z.number().int().positive() }), planSha256: sha, preDdlSummarySha256: sha, from: day, toExclusive: day, canaryDay: day, sources: z.array(sourceSchema).min(1), requiredRecoveryJobCount: z.number().int().nonnegative(), recoveryJobs: z.array(descriptorSchema).min(1), recoveryJobsSha256: sha, routineCycles: z.record(z.object({ createdAt: z.string(), window: z.object({ from: day, toExclusive: day }), jobs: z.array(descriptorSchema) })).default({}), returnPriceUpgrade: returnPriceUpgradeSchema.optional() });
const evidenceSchema = z.object({ manifestVersion: z.literal(1), jobKey: sha, scope: z.object({ kind: kinds, rangeStart: day.nullable(), rangeEndExclusive: day.nullable(), balancePeriod: z.string().nullable() }).strict(), tables: z.record(z.object({ rows: z.number().int().nonnegative(), nullCounts: z.record(z.number().int().nonnegative()), resourceTotals: z.record(z.string().regex(/^-?\d+(\.\d+)?$/)), sha256: sha, targetOnlyRows: z.number().int().nonnegative() }).strict()), sourceSha256: sha }).strict();
type Source = z.infer<typeof sourceSchema>;
type Descriptor = z.infer<typeof descriptorSchema>;
type Job = { reload_id: string; job_key: string; cycle_id: string; phase: string; source_entity: string; range_start: string | Date | null; range_end_exclusive: string | Date | null; status: string; required: boolean; source_rows: bigint | number | null; written_rows: bigint | number | null; business_sha256: string | null; verified_at: Date | string | null; source_sha256: string | null; verified_manifest: unknown };
type Plan = { reload_id: string; table_schema: string; plan_sha256: string; contract_sha256: string; index_manifest_sha256: string; source_sha256: string; from_date: string | Date; to_exclusive: string | Date; canary_status: string; status: string; manifest: unknown; revision: bigint | number; updated_at: Date };
type Identity = { database_name: string; database_oid: bigint | number; schema_name: string; schema_oid: bigint | number; database_bytes: bigint | number; has_layout: boolean; has_plans: boolean; has_jobs: boolean; tables: string[]; stock_entry_columns: boolean };
type Layout = { table_schema: string; layout_version: number; contract_sha256: string; plan_sha256: string; migration_id: string; ddl_frozen: boolean };
export type ReloadReadinessState = ReloadReadiness & {
  readonly binding: string;
  readonly coverageSources: Array<{ source: Source; intervals: Array<{ from: string; to: string }> }>;
  readonly returnPriceIntervals: Array<{ from: string; to: string }>;
  readonly stockEntryCostAvailable?: boolean;
  readonly stockEntryCostBackfillVerified?: boolean;
  /** Half-open movement dates, independent of ordinary supplier receipt coverage. */
  readonly stockEntryCostCoverage?: { from: string; toExclusive: string };
  readonly stockEntryHistoricalReceiptCoverage?: StockEntryHistoricalReceiptCoverage;
};
const fallbackTables = ["document_ustanovka_tsen_nomenklatury_tovary", "document_otchet_o_roznichnyh_prodazhah_tovary", "document_chek_kkm", "document_chek_kkm_tovary", "accumulation_register_tovary_na_skladah_balance"];
const normalizeDay = (value: Date | string | null) => value instanceof Date ? value.toISOString().slice(0, 10) : value;
const nextDay = (value: string) => new Date(Date.parse(value) + 86_400_000).toISOString().slice(0, 10);
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function state(value: ReloadReadiness, binding: string, coverageSources: ReloadReadinessState["coverageSources"] = [], returnPriceIntervals: ReloadReadinessState["returnPriceIntervals"] = [], stockEntry?: {
  verified: boolean; coverage?: ReloadReadinessState["stockEntryCostCoverage"]; historicalReceiptCoverage?: StockEntryHistoricalReceiptCoverage;
}): ReloadReadinessState {
  return Object.defineProperties(value, {
    binding: { value: binding }, coverageSources: { value: coverageSources }, returnPriceIntervals: { value: returnPriceIntervals },
    stockEntryCostAvailable: { value: stockEntry?.verified ?? false },
    stockEntryCostBackfillVerified: { value: stockEntry?.verified ?? false },
    stockEntryCostCoverage: { value: stockEntry?.coverage },
    stockEntryHistoricalReceiptCoverage: { value: stockEntry?.historicalReceiptCoverage }
  }) as ReloadReadinessState;
}
/** Only application-owned schema identifiers reach this read-only seam. No fact scans. */
export async function readReloadReadiness(executor: Executor = prisma, metadataSchema = "ops"): Promise<ReloadReadinessState> {
  identifier.parse(metadataSchema);
  identifier.parse(config.PGSCHEMA);
  let identity: Identity | undefined;
  let current: ReloadReadiness = { status: "blocked", from: null, toExclusive: null, completedJobs: 0, totalJobs: 0, sources: [], databaseBytes: 0, pauseAtBytes: RELOAD_PAUSE_AT_BYTES };
  try {
    [identity] = await executor.$queryRawUnsafe<Identity[]>(`select current_database() as database_name, d.oid::bigint as database_oid,
      n.nspname as schema_name, n.oid::bigint as schema_oid, pg_database_size(current_database()) as database_bytes,
      to_regclass($1) is not null as has_layout, to_regclass($2) is not null as has_plans, to_regclass($3) is not null as has_jobs,
      array(select c.relname::text from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p')) as tables,
      (select count(*) = 4 from pg_class c join pg_attribute a on a.attrelid = c.oid
        where c.relnamespace = n.oid and c.relname = '${STOCK_ENTRY_TABLE}' and c.relkind = 'r'
          and a.attnum > 0 and not a.attisdropped and not a.attnotnull and not a.atthasdef
          and a.attidentity = '' and a.attgenerated = '' and
          ((a.attname in ('nomenklatura_key', 'harakteristika_key') and format_type(a.atttypid, a.atttypmod) = 'text') or
           (a.attname in ('kolichestvo', 'tsena') and format_type(a.atttypid, a.atttypmod) = 'numeric'))) as stock_entry_columns
      from pg_database d left join pg_namespace n on n.oid = to_regnamespace($4) where d.datname = current_database()`, `${metadataSchema}.analytics_storage_layout`, `${metadataSchema}.analytics_reload_plans`, `${metadataSchema}.analytics_reload_jobs`, config.PGSCHEMA);
    if (!identity) return state(current, "blocked:identity");
    current.databaseBytes = Number(identity.database_bytes);
    current.sources = fallbackTables.map(table => ({ table, status: identity!.tables.includes(table) ? "partial" : "missing", verifiedThrough: null }));
    if (identity.database_name !== "nalivdata") return state(current, "blocked:target");
    if (!identity.has_layout) return state({ ...current, status: "needs_preparation" }, "needs_preparation:layout");
    const layouts = await executor.$queryRawUnsafe<Layout[]>(`select table_schema, layout_version, contract_sha256, plan_sha256, migration_id::text, ddl_frozen from "${metadataSchema}"."analytics_storage_layout" where table_schema = $1`, identity.schema_name);
    const layout = layouts[0];
    if (layouts.length !== 1 || !layout || layout.layout_version !== 1 || layout.ddl_frozen || !sha.safeParse(layout.contract_sha256).success || !sha.safeParse(layout.plan_sha256).success) return state({ ...current, status: "needs_preparation" }, "needs_preparation:layout");
    if (!identity.has_plans || !identity.has_jobs) return state({ ...current, status: "needs_preparation" }, "needs_preparation:ledger");
    const plans = await executor.$queryRawUnsafe<Plan[]>(`select reload_id::text, table_schema, plan_sha256, contract_sha256, index_manifest_sha256, source_sha256, from_date, to_exclusive, canary_status, status, manifest, revision, updated_at from "${metadataSchema}"."analytics_reload_plans" where table_schema = $1 order by updated_at desc`, identity.schema_name);
    const unfinished = plans.filter(plan => ["preparing", "reloading", "paused_capacity", "blocked"].includes(plan.status));
    if (unfinished.length > 1 || plans.some(plan => !["preparing", "reloading", "paused_capacity", "blocked", "ready"].includes(plan.status))) return state(current, "blocked:plans");
    const boundPlans = plans.filter(plan => plan.table_schema === identity!.schema_name && plan.plan_sha256 === layout.plan_sha256 && plan.reload_id === layout.migration_id);
    const plan = boundPlans.length === 1 ? boundPlans[0] : undefined;
    if (!plan || (unfinished.length && unfinished[0] !== plan)) return state({ ...current, status: plans.length ? "blocked" : "needs_preparation" }, "blocked:no-bound-plan");
    const binding = `${plan.reload_id}:${plan.revision}:${plan.status}:${plan.canary_status}:${layout.plan_sha256}:${layout.contract_sha256}`;
    current.from = normalizeDay(plan.from_date); current.toExclusive = normalizeDay(plan.to_exclusive);
    const manifest = manifestSchema.parse(plan.manifest);
    const upgrade = manifest.returnPriceUpgrade;
    const stockEntryLayout = layout.contract_sha256 === STOCK_ENTRY_EFFECTIVE_CONTRACT_SHA256;
    const contractBound = reloadContractBinding(plan.manifest, plan.contract_sha256, layout.contract_sha256, plan.source_sha256);
    const stockEntryTransition = contractBound?.kind === "stock-entry-prepared" || contractBound?.kind === "stock-entry-verified";
    if (!contractBound || plan.plan_sha256 !== layout.plan_sha256 || plan.table_schema !== identity.schema_name || layout.table_schema !== identity.schema_name || layout.migration_id !== plan.reload_id || manifest.reloadId !== plan.reload_id || manifest.planSha256 !== plan.plan_sha256 || manifest.targetDatabase.name !== identity.database_name || manifest.targetDatabase.oid !== Number(identity.database_oid) || manifest.sourceSchema.name !== identity.schema_name || manifest.sourceSchema.oid !== Number(identity.schema_oid) || manifest.from !== current.from || manifest.toExclusive !== current.toExclusive || manifest.from >= manifest.toExclusive || !sha.safeParse(plan.source_sha256).success || !sha.safeParse(plan.index_manifest_sha256).success || !["pending", "running", "verified"].includes(plan.canary_status) || !Number.isSafeInteger(Number(plan.revision)) || Number(plan.revision) < 0 || (upgrade?.canaryPasses.length === 2 && plan.source_sha256 !== upgrade.workerSourceSha256)) return state(current, `blocked:${binding}`);
    if (stockEntryTransition && (!identity.stock_entry_columns || plan.status !== "ready" || plan.canary_status !== "verified")) return state(current, `blocked:${binding}`);
    const receiptProofs = parseStockEntryReceiptProofs(plan.manifest, contractBound, manifest.from);
    if (receiptProofs === null) return state(current, `blocked:${binding}`);
    const recovery = manifest.recoveryJobs;
    if (manifest.sources.some(source => source.required && !recovery.some(job => job.source === source.key && job.required))) throw new Error("Required source has no recovery jobs");
    // Hash the writer's complete descriptors: schema parsing strips fields the API does not use.
    const rawRecovery = plan.manifest && typeof plan.manifest === "object" && "recoveryJobs" in plan.manifest ? plan.manifest.recoveryJobs : undefined;
    if (manifest.requiredRecoveryJobCount !== recovery.filter(job => job.required).length || createHash("sha256").update(canonicalJson(rawRecovery)).digest("hex") !== manifest.recoveryJobsSha256) return state(current, `blocked:${binding}`);
    const expected = [...recovery, ...Object.entries(manifest.routineCycles).flatMap(([cycleId, cycle]) => { if (cycle.jobs.some(job => job.cycleId !== cycleId)) throw new Error("Invalid cycle"); return cycle.jobs; })];
    const jobs = await executor.$queryRawUnsafe<Job[]>(`select reload_id::text, job_key, cycle_id::text, phase, source_entity, range_start, range_end_exclusive, status, required, source_rows, written_rows, business_sha256, verified_at, source_sha256, verified_manifest from "${metadataSchema}"."analytics_reload_jobs" where reload_id = $1::uuid`, plan.reload_id);
    const byKey = new Map(jobs.map(job => [job.job_key, job]));
    const descriptors = new Map(expected.map(job => [job.jobKey, job]));
    const sources = new Map(manifest.sources.map(source => [source.key, source]));
    if (byKey.size !== jobs.length || descriptors.size !== expected.length || jobs.length !== expected.length || sources.size !== manifest.sources.length) throw new Error("Job set mismatch");
    const evidenceByKey = new Map<string, z.infer<typeof evidenceSchema>>();
    for (const descriptor of expected) {
      const job = byKey.get(descriptor.jobKey), source = sources.get(descriptor.source);
      if (source && (descriptor.required !== source.required || new Set(source.tables).size !== source.tables.length || canonicalJson([...source.tables].sort()) !== canonicalJson([descriptor.parentTable, ...descriptor.childTables].sort()))) throw new Error("Incomplete retained source mapping");
      if (!job || !source || source.entity !== descriptor.sourceEntity || job.reload_id !== plan.reload_id || job.cycle_id !== descriptor.cycleId || job.phase !== descriptor.phase || job.source_entity !== descriptor.sourceEntity || normalizeDay(job.range_start) !== descriptor.rangeStart || normalizeDay(job.range_end_exclusive) !== descriptor.rangeEndExclusive || job.required !== descriptor.required || !["pending", "running", "verified", "failed", "paused_capacity", "unavailable"].includes(job.status) || (descriptor.rangeStart !== null && (descriptor.rangeEndExclusive === null || descriptor.rangeStart >= descriptor.rangeEndExclusive)) || !source.tables.includes(descriptor.parentTable) || descriptor.childTables.some(table => !source.tables.includes(table))) throw new Error("Job descriptor mismatch");
      if (job.status === "verified") {
        const evidence = evidenceSchema.parse(job.verified_manifest);
        evidenceByKey.set(job.job_key, evidence);
        const tables = [descriptor.parentTable, ...descriptor.childTables];
        // job.source_sha256 is the complete-source data digest, not the worker code hash.
        // Only non-replacing reference scopes may report retained target-only rows.
        if (!job.verified_at || job.source_rows === null || job.written_rows === null || !sha.safeParse(job.business_sha256).success || !sha.safeParse(job.source_sha256).success || evidence.sourceSha256 !== job.source_sha256 || evidence.jobKey !== job.job_key || evidence.scope.kind !== source.kind || evidence.scope.rangeStart !== descriptor.rangeStart || evidence.scope.rangeEndExclusive !== descriptor.rangeEndExclusive || evidence.scope.balancePeriod !== descriptor.balancePeriod || Object.keys(evidence.tables).length !== tables.length || tables.some(table => !evidence.tables[table] || (source.kind !== "reference" && evidence.tables[table].targetOnlyRows !== 0))) throw new Error("Incomplete verification evidence");
      }
    }
    if (upgrade) {
      const cycle = manifest.routineCycles[upgrade.cycleId];
      if (!cycle && (upgrade.state === "verified" || upgrade.canaryPasses.length)) throw new Error("Missing return price cycle");
      if (cycle) {
        const retail = sources.get("retail");
        if (retail?.kind !== "dated" || retail.entity !== RETURN_PRICE_SOURCE_ENTITY || !retail.tables.includes(RETURN_PRICE_TABLE)) throw new Error("Invalid return price source");
        const dayCount = (Date.parse(upgrade.rangeEndExclusive) - Date.parse(upgrade.rangeStart)) / 86_400_000;
        if (cycle.window.from !== upgrade.rangeStart || cycle.window.toExclusive !== upgrade.rangeEndExclusive || cycle.jobs.length !== dayCount) throw new Error("Incomplete return price cycle");
        const days = new Set<string>();
        for (const descriptor of cycle.jobs) {
          const job = byKey.get(descriptor.jobKey), evidence = evidenceByKey.get(descriptor.jobKey);
          if (descriptor.source !== "retail" || descriptor.sourceEntity !== RETURN_PRICE_SOURCE_ENTITY || descriptor.phase !== "deep_reread" || descriptor.parentTable !== "document_otchet_o_roznichnyh_prodazhah" || descriptor.balancePeriod !== null || descriptor.rangeStart === null || descriptor.rangeStart < upgrade.rangeStart || descriptor.rangeStart >= upgrade.rangeEndExclusive || descriptor.rangeEndExclusive !== nextDay(descriptor.rangeStart) || days.has(descriptor.rangeStart)) throw new Error("Invalid return price day");
          if (upgrade.state === "verified" && (job?.status !== "verified" || !Object.hasOwn(evidence?.tables[RETURN_PRICE_TABLE]?.nullCounts ?? {}, "tsena"))) throw new Error("Unverified return price day");
          if (stockEntryTransition && evidence) {
            const price = evidence.tables[RETURN_PRICE_TABLE];
            if (!Object.hasOwn(price?.resourceTotals ?? {}, "tsena") ||
                createHash("sha256").update(canonicalJson(evidence.tables)).digest("hex") !== job?.business_sha256 ||
                Object.values(evidence.tables).some(table => Object.values(table.nullCounts).some(count => count > table.rows))) {
              throw new Error("Invalid predecessor return price proof");
            }
          }
          days.add(descriptor.rangeStart);
        }
        if (upgrade.canaryPasses.length === 2) {
          const descriptor = cycle.jobs.find(job => job.rangeStart === upgrade.canaryDay)!;
          const job = byKey.get(descriptor.jobKey), evidence = evidenceByKey.get(descriptor.jobKey);
          if (job?.status !== "verified" || !evidence || !Object.hasOwn(evidence.tables[RETURN_PRICE_TABLE]?.nullCounts ?? {}, "tsena")) throw new Error("Unverified return price canary");
          const target = { tables: Object.fromEntries(Object.entries(evidence.tables).map(([table, { targetOnlyRows: _targetOnlyRows, ...summary }]) => [table, summary])) };
          const targetSha256 = createHash("sha256").update(canonicalJson(target)).digest("hex");
          if (upgrade.canaryPasses[0]!.sourceSha256 !== job.source_sha256 || upgrade.canaryPasses[0]!.targetSha256 !== targetSha256) throw new Error("Return price canary evidence mismatch");
        }
      }
    }
    const required = recovery.filter(descriptor => descriptor.required);
    current.totalJobs = required.length; current.completedJobs = required.filter(descriptor => byKey.get(descriptor.jobKey)?.status === "verified").length;
    const coverageSources = manifest.sources.map(source => ({ source, intervals: jobs.filter(job => job.source_entity === source.entity && job.status === "verified" && job.range_start && job.range_end_exclusive).map(job => ({ from: normalizeDay(job.range_start)!, to: normalizeDay(job.range_end_exclusive)! })).sort((a, b) => a.from.localeCompare(b.from)) }));
    const returnPriceIntervals = (layout.contract_sha256 === RETURN_PRICE_EFFECTIVE_CONTRACT_SHA256 || stockEntryLayout) && sources.get("retail")?.kind === "dated"
      ? jobs.filter(job => job.source_entity === RETURN_PRICE_SOURCE_ENTITY && job.status === "verified" && job.range_start && job.range_end_exclusive && descriptors.get(job.job_key)?.source === "retail" && Object.hasOwn(evidenceByKey.get(job.job_key)?.tables[RETURN_PRICE_TABLE]?.nullCounts ?? {}, "tsena"))
        .map(job => ({ from: normalizeDay(job.range_start)!, to: normalizeDay(job.range_end_exclusive)! })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
      : [];
    current.sources = coverageSources.flatMap(({ source, intervals }) => {
      let through = source.floor ?? null;
      if (through) for (const interval of intervals) { if (interval.from > through) break; if (interval.to > through) through = interval.to; }
      const sourceJobs = recovery.filter(job => job.sourceEntity === source.entity).map(job => byKey.get(job.jobKey)!);
      const complete = sourceJobs.length > 0 && sourceJobs.every(job => job.status === "verified");
      const verifiedSourceJobs = jobs.filter(job => job.source_entity === source.entity && job.status === "verified");
      return source.tables.map(table => ({
        table, verifiedThrough: through,
        status: source.unavailable || (!source.required && sourceJobs.some(job => job.status === "unavailable"))
          ? "unavailable" as const : !identity!.tables.includes(table) ? "missing" as const
          : !complete ? "partial" as const
          : verifiedSourceJobs.every(job => evidenceByKey.get(job.job_key)!.tables[table]?.rows === 0) ? "empty" as const : "verified" as const
      }));
    });
    const failed = required.some(job => ["failed", "unavailable"].includes(byKey.get(job.jobKey)!.status));
    const missingRequired = manifest.sources.some(source => source.required && source.tables.some(table => !identity!.tables.includes(table)));
    current.status = plan.status === "blocked" || failed || missingRequired ? "blocked" : plan.status === "paused_capacity" || required.some(job => byKey.get(job.jobKey)!.status === "paused_capacity") ? "paused_capacity" : plan.status !== "ready" || plan.canary_status !== "verified" || current.completedJobs !== current.totalJobs ? "reloading" : "ready";
    let stockEntryCoverage: ReloadReadinessState["stockEntryCostCoverage"];
    if (stockEntryLayout && contractBound.kind === "native" && identity.stock_entry_columns && current.status === "ready") {
      const source = sources.get(STOCK_ENTRY_PARENT);
      // Native compact plans certify the immutable dated replay and then only its
      // contiguous, verified routine continuation, never data before the source floor.
      if (source?.entity === STOCK_ENTRY_SOURCE_ENTITY && source.kind === "dated" && !source.unavailable &&
          source.floor && source.tables.length === 2 && source.tables.includes(STOCK_ENTRY_TABLE)) {
        const replay = recovery.filter(job => job.source === STOCK_ENTRY_PARENT).sort((a, b) =>
          (a.rangeStart ?? "").localeCompare(b.rangeStart ?? ""));
        let cursor = source.floor;
        const hasStockEntryEvidence = (descriptor: Descriptor) => {
          const job = byKey.get(descriptor.jobKey), evidence = evidenceByKey.get(descriptor.jobKey);
          const lines = evidence?.tables[STOCK_ENTRY_TABLE];
          return descriptor.phase === "incremental" && descriptor.parentTable === STOCK_ENTRY_PARENT && descriptor.balancePeriod === null &&
            job?.status === "verified" && evidence && lines &&
            STOCK_ENTRY_COLUMNS.every(column => Object.hasOwn(lines.nullCounts, column) && lines.nullCounts[column]! <= lines.rows) &&
            Object.hasOwn(lines.resourceTotals, "kolichestvo") && Object.hasOwn(lines.resourceTotals, "tsena") &&
            createHash("sha256").update(canonicalJson(evidence.tables)).digest("hex") === job.business_sha256;
        };
        if (replay.length > 0 && replay.every(descriptor => {
          if (descriptor.cycleId !== plan.reload_id || descriptor.rangeStart !== cursor ||
              descriptor.rangeEndExclusive !== nextDay(cursor) || !hasStockEntryEvidence(descriptor)) return false;
          cursor = descriptor.rangeEndExclusive;
          return true;
        }) && cursor === manifest.toExclusive) {
          const continuation = expected.filter(descriptor =>
            descriptor.cycleId !== plan.reload_id && descriptor.source === STOCK_ENTRY_PARENT &&
            descriptor.rangeStart !== null && descriptor.rangeStart >= manifest.toExclusive)
            .sort((a, b) => a.rangeStart!.localeCompare(b.rangeStart!));
          for (const descriptor of continuation) {
            const { cycleId, phase, sourceEntity, rangeStart, rangeEndExclusive, balancePeriod } = descriptor;
            if (rangeStart! > cursor) break;
            if (rangeStart !== cursor || rangeEndExclusive !== nextDay(cursor)) continue;
            const { window } = manifest.routineCycles[cycleId]!;
            if (rangeStart < window.from || rangeEndExclusive > window.toExclusive) continue;
            const jobKey = createHash("sha256").update(canonicalJson({
              reloadId: plan.reload_id, cycleId, phase, sourceEntity, rangeStart, rangeEndExclusive, balancePeriod
            })).digest("hex");
            if (descriptor.jobKey === jobKey && hasStockEntryEvidence(descriptor)) cursor = rangeEndExclusive;
          }
          stockEntryCoverage = { from: source.floor, toExclusive: cursor };
        }
      }
    }
    if (current.status === "ready" && contractBound.kind === "stock-entry-verified" && contractBound.backfill.version === 2) {
      const { from, toExclusive } = contractBound.backfill;
      stockEntryCoverage = { from, toExclusive };
    }
    const stockEntryVerified = current.status === "ready" && (contractBound.kind === "stock-entry-verified" || stockEntryCoverage !== undefined);
    return state(current, `${binding}:${current.status}${stockEntryEvidenceBinding(contractBound, receiptProofs)}`, coverageSources, returnPriceIntervals, {
      verified: stockEntryVerified, coverage: stockEntryCoverage,
      historicalReceiptCoverage: stockEntryVerified ? receiptProofs?.coverage : undefined
    });
  } catch {
    return state({ ...current, status: "blocked" }, "blocked:unreadable");
  }
}
/** A fresh factory owns each test cache; no process-global reset endpoint. */
export function createReloadReadinessReader(load: () => Promise<ReloadReadinessState> = readReloadReadiness, now: () => number = Date.now) {
  let cached: ReloadReadinessState | undefined, expires = 0, pending: Promise<ReloadReadinessState> | undefined;
  return async () => {
    if (cached && now() < expires) return cached;
    if (!pending) pending = load().then(value => { cached = value; expires = now() + 1000; return value; }).finally(() => { pending = undefined; });
    return pending;
  };
}
export const getReloadReadiness = createReloadReadinessReader();
export function evaluateCoverage(readiness: ReloadReadinessState, kind: "receipts" | "retail" | "document_postuplenie_tovarov", window: { from: Date; to: Date }, today = businessToday()): ReloadCoverage {
  if (!Number.isFinite(window.from.getTime()) || !Number.isFinite(window.to.getTime()) || window.from >= window.to) throw Object.assign(new Error("Некорректный период отчёта"), { statusCode: 400 });
  const from = window.from.toISOString().slice(0, 10), to = window.to.toISOString().slice(0, 10);
  const end = window.to.getTime() === Date.parse(to) ? to : nextDay(to);
  const source = readiness.coverageSources.find(value => value.source.key === kind);
  const verifiedThrough = readiness.sources.find(value => source?.source.tables.includes(value.table))?.verifiedThrough ?? null;
  const result: ReloadCoverage = { status: "unavailable", requestedFrom: from, requestedToExclusive: to, verifiedThrough, reason: "reloading" };
  if (!source || ["blocked", "needs_preparation"].includes(readiness.status)) return result;
  if (!source.source.floor || from < source.source.floor) return { ...result, reason: "before_horizon" };
  const historicalEnd = end < today ? end : today;
  if (from >= historicalEnd) return { ...result, reason: "open_period" };
  let cursor = from;
  for (const interval of source.intervals) {
    if (interval.from > cursor) break;
    if (interval.to > cursor) cursor = interval.to;
    if (cursor >= historicalEnd) break;
  }
  if (cursor < historicalEnd) return result;
  return { ...result, status: end > today ? "partial" : "verified", reason: end > today ? "open_period" : null };
}
export class ReloadIncompleteError extends Error {
  readonly statusCode = 503;
  readonly code = "ANALYTICS_RELOAD_INCOMPLETE";
  constructor(readiness: ReloadReadiness, kind: ReloadRequirement["kind"]) {
    const pending = kind === "all" ? [...new Set(readiness.sources
      .filter(source => ["missing", "partial"].includes(source.status))
      .map(({ table }) => table.startsWith("document_chek_kkm") ? "чеки ККМ"
        : table.startsWith("document_otchet_o_roznichnyh_prodazhah") ? "розничные продажи"
        : table.startsWith("document_ustanovka_tsen_nomenklatury") ? "цены номенклатуры"
        : table === "accumulation_register_tovary_na_skladah_balance" ? "остатки на складах" : table))] : [];
    super(`Восстановление данных не завершено. Ожидаются источники: ${pending.length ? pending.join(", ") : kind === "receipts" ? "чеки ККМ за выбранный период" : kind === "retail" ? "розничные продажи за выбранный период" : "источники аналитики"}.`);
    this.name = "ReloadIncompleteError";
  }
}
export function requireCoverage(readiness: ReloadReadinessState, requirement: ReloadRequirement, today = businessToday()): void {
  if (requirement.from && !Number.isFinite(requirement.from.getTime()) || requirement.to && !Number.isFinite(requirement.to.getTime()) || requirement.from && requirement.to && requirement.from >= requirement.to) throw Object.assign(new Error("Некорректный период отчёта"), { statusCode: 400 });
  if (requirement.kind === "all") { if (readiness.status !== "ready") throw new ReloadIncompleteError(readiness, "all"); return; }
  const coverage = evaluateCoverage(readiness, requirement.kind, { from: requirement.from ?? new Date(readiness.from ?? "2026-06-01"), to: requirement.to ?? new Date(nextDay(today)) }, today);
  if (coverage.status === "unavailable" || coverage.reason === "reloading" || coverage.reason === "before_horizon") throw new ReloadIncompleteError(readiness, requirement.kind);
}
export async function evaluateReloadCoverage(kind: "receipts" | "retail", window: { from: Date; to: Date }): Promise<ReloadCoverage> {
  return evaluateCoverage(await getReloadReadiness(), kind, window);
}
export async function assertReloadReady(requirement: ReloadRequirement): Promise<void> {
  requireCoverage(await getReloadReadiness(), requirement);
}
