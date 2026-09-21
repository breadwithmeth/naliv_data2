// Read-only view of the nightly 1C sync for the "База данных" page: the run
// record written to `ops.sync_runs` by naliv_data1/run_scheduled_export.py,
// plus how current each exported table is.
//
// The sync process creates that table itself, so a database whose scheduler
// never ran has none: the read degrades to `available: false` rather than
// failing, and the page keeps working for everything else.
//
// Neither the run table nor the freshness numbers are part of the report path:
// reports must never wait on telemetry.

import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../prisma.js";

// Grouped by how the scheduled export covers each entity set. Shared with
// api/src/scripts/check-sync-freshness.ts, which prints the same numbers.
export const SYNC_TABLE_GROUPS: Array<{ title: string; tables: string[] }> = [
  {
    title: "Документы периода — экспортируются каждую ночь в окне 04:00–06:00 Asia/Qyzylorda",
    tables: ["document_otchet_o_roznichnyh_prodazhah", "document_postuplenie_tovarov"]
  },
  {
    title: "Справочники периода — экспортируются в финальной порции каждого запуска",
    tables: [
      "catalog_nomenklatura",
      "catalog_informatsionnye_karty",
      "catalog_skidki_natsenki",
      "catalog_segmenty_nomenklatury",
      "catalog_magaziny",
      "catalog_sklady"
    ]
  },
  {
    title: "Данные акций — документ акций читается целиком, без окна дат",
    tables: [
      "document_marketingovaya_aktsiya",
      "document_marketingovaya_aktsiya_skidki_natsenki",
      "document_marketingovaya_aktsiya_magaziny"
    ]
  }
];

export const SYNC_STALE_AFTER_HOURS = 48;

const SYNC_RUNS_SCHEMA = "ops";
const SYNC_RUNS_TABLE = "sync_runs";
const SYNC_SCHEDULER_TABLE = "sync_scheduler";

export type SyncTableFreshness = {
  group: string;
  table: string;
  rows: number;
  changes: number;
  lastChangeUtc: string | null;
  ageHours: number | null;
  unchangedForOverTwoDays: boolean;
};

export type SyncRunChunk = {
  kind: string;
  start: string;
  end_exclusive: string;
  documents_only: boolean;
  exit_code: number;
  rows_read: number | null;
  rows_written: number | null;
  seconds: number | null;
};

// Raw driver shapes: `jsonSafe` in the route turns bigint into number and Date
// into an ISO string on the way out, so the browser sees strings and numbers.
export type SyncRun = {
  id: number | bigint;
  started_at: Date | null;
  finished_at: Date | null;
  status: string | null;
  exit_code: number | null;
  mode: string | null;
  error_class: string | null;
  range_start: Date | null;
  range_end_exclusive: Date | null;
  chunks_planned: number | null;
  chunks_completed: number | null;
  lookback_days: number | null;
  catchup_chunk_days: number | null;
  checkpoint_before: Date | null;
  checkpoint_after: Date | null;
  coverage_started_at: Date | null;
  rows_read: number | bigint | null;
  rows_written: number | bigint | null;
  skipped_entities: number | null;
  restricted_optional_entities: number | null;
  deep_reread_status: string | null;
  deep_reread_month: Date | null;
  duration_seconds: number | null;
  command: string | null;
  per_chunk: SyncRunChunk[];
  sync_source_sha256: string | null;
  // Where the run's full log and metrics live on the export server, plus a
  // bounded tail of that log. Null until a run written by the updated
  // scheduler records them; the read below tolerates the older table.
  log_file: string | null;
  metrics_file: string | null;
  log_tail: string | null;
};

export type SyncHealth = {
  available: boolean;
  unavailableReason: string | null;
  generatedAtUtc: string;
  staleAfterHours: number;
  schema: string;
  latest: SyncRun | null;
  runs: SyncRun[];
  scheduler: SyncSchedulerStatus | null;
  schedulerUnavailableReason: string | null;
  groups: Array<{ title: string; tables: SyncTableFreshness[] }>;
};

// The scheduler's own state: what it last decided, why, and the flags the
// container actually received. Written by naliv_data1/container_service.py. A
// skip writes no run row, so this is the only place the page can answer "why
// did the sync not run?" — including "the cooldown is holding your restart
// back" and "the container never received SCHEDULE_STARTUP_IGNORE_WINDOW".
export type SyncSchedulerStatus = {
  status: string | null;
  updatedAtUtc: string | null;
  serviceStartedAt: string | null;
  lastDecision: string | null;
  lastReason: string | null;
  lastDecisionAt: string | null;
  lastDetail: string | null;
  nextBypassAllowedAt: string | null;
  nextRunAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  timezone: string | null;
  runOnStartup: boolean | null;
  ignoreWindow: boolean | null;
  minIntervalHours: number | null;
  heartbeatSeconds: number | null;
  syncSourceSha256: string | null;
  logTail: string | null;
};

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// `"` doubling keeps the identifier usable inside the quoted table name; the
// names come from the constants above, never from a request.
function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function collectTableFreshness(
  schema: string,
  groups: Array<{ title: string; tables: string[] }> = SYNC_TABLE_GROUPS,
  staleAfterHours: number = SYNC_STALE_AFTER_HOURS
): Promise<SyncTableFreshness[]> {
  const quotedSchema = quoteIdentifier(schema);
  const existing = new Set(
    (
      await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
        `select table_name from information_schema.tables
         where table_schema = $1 and table_type = 'BASE TABLE'`,
        schema
      )
    ).map((row) => row.table_name)
  );

  const tables: SyncTableFreshness[] = [];
  for (const group of groups) {
    for (const table of group.tables) {
      if (!existing.has(table)) {
        continue;
      }
      const stats = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `select count(*) as rows,
                count(distinct "_loaded_at") as changes,
                max("_loaded_at") as last_change
         from ${quotedSchema}.${quoteIdentifier(table)}`
      );
      const row = stats[0] ?? {};
      const lastChange = row.last_change instanceof Date ? row.last_change : null;
      const ageHours = lastChange ? (Date.now() - lastChange.getTime()) / 3_600_000 : null;
      tables.push({
        group: group.title,
        table,
        rows: Number(row.rows ?? 0),
        changes: Number(row.changes ?? 0),
        lastChangeUtc: lastChange ? lastChange.toISOString().slice(0, 19).replace("T", " ") : null,
        ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
        unchangedForOverTwoDays: ageHours !== null && ageHours > staleAfterHours
      });
    }
  }

  return tables;
}

async function syncRunsTableExists() {
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`
    select exists (
      select 1 from information_schema.tables
      where table_schema = ${SYNC_RUNS_SCHEMA} and table_name = ${SYNC_RUNS_TABLE}
    ) as present
  `;

  return rows[0]?.present === true;
}

async function syncSchedulerTableExists() {
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`
    select exists (
      select 1 from information_schema.tables
      where table_schema = ${SYNC_RUNS_SCHEMA} and table_name = ${SYNC_SCHEDULER_TABLE}
    ) as present
  `;

  return rows[0]?.present === true;
}

async function readSchedulerStatus(): Promise<SyncSchedulerStatus | null> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    select status, service_started_at, last_decision, last_reason, last_decision_at,
           last_detail, next_bypass_allowed_at, next_run_at, window_start, window_end,
           timezone, run_on_startup, ignore_window, min_interval_hours,
           heartbeat_seconds, sync_source_sha256, updated_at, log_tail
    from ops.sync_scheduler
    where id = 1
  `);
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    status: asText(row.status),
    updatedAtUtc: asIso(row.updated_at),
    serviceStartedAt: asIso(row.service_started_at),
    lastDecision: asText(row.last_decision),
    lastReason: asText(row.last_reason),
    lastDecisionAt: asIso(row.last_decision_at),
    lastDetail: asText(row.last_detail),
    nextBypassAllowedAt: asIso(row.next_bypass_allowed_at),
    nextRunAt: asIso(row.next_run_at),
    windowStart: asText(row.window_start),
    windowEnd: asText(row.window_end),
    timezone: asText(row.timezone),
    runOnStartup: asBoolean(row.run_on_startup),
    ignoreWindow: asBoolean(row.ignore_window),
    minIntervalHours: asNumber(row.min_interval_hours),
    heartbeatSeconds: asNumber(row.heartbeat_seconds),
    syncSourceSha256: asText(row.sync_source_sha256),
    logTail: asText(row.log_tail)
  };
}

async function readSyncRuns(limit: number): Promise<SyncRun[]> {
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    select id, started_at, finished_at, status, exit_code, mode, error_class,
           range_start, range_end_exclusive, chunks_planned, chunks_completed,
           lookback_days, catchup_chunk_days, checkpoint_before, checkpoint_after,
           coverage_started_at, rows_read, rows_written, skipped_entities,
           restricted_optional_entities, deep_reread_status, deep_reread_month,
           duration_seconds, command, coalesce(per_chunk, '[]'::jsonb) as per_chunk,
           metrics ->> 'build.sync_source_sha256' as sync_source_sha256,
           -- Extracted from the row instead of selected by name: the scheduler
           -- adds these columns on its next run, and the panel must keep working
           -- until then rather than reporting the whole table as unreadable.
           to_jsonb(r) ->> 'log_file' as log_file,
           to_jsonb(r) ->> 'metrics_file' as metrics_file,
           to_jsonb(r) ->> 'log_tail' as log_tail
    from ops.sync_runs r
    order by started_at desc nulls last, id desc
    limit ${limit}
  `);

  return rows.map((row) => ({
    ...(row as unknown as Omit<SyncRun, "per_chunk">),
    per_chunk: Array.isArray(row.per_chunk) ? (row.per_chunk as SyncRunChunk[]) : []
  }));
}

export async function getSyncHealth(limit = 10): Promise<SyncHealth> {
  const base = {
    generatedAtUtc: new Date().toISOString(),
    staleAfterHours: SYNC_STALE_AFTER_HOURS,
    schema: config.PGSCHEMA
  };

  const [tables, runs, scheduler] = await Promise.all([
    collectTableFreshness(config.PGSCHEMA),
    (async () => {
      if (!(await syncRunsTableExists())) {
        return { available: false, unavailableReason: null, runs: [] as SyncRun[] };
      }
      try {
        return { available: true, unavailableReason: null, runs: await readSyncRuns(limit) };
      } catch (error) {
        // A missing grant on schema `ops` is the realistic failure here; show it
        // instead of an empty page that looks like "the sync never ran".
        return {
          available: false,
          unavailableReason: error instanceof Error ? error.message : String(error),
          runs: [] as SyncRun[]
        };
      }
    })(),
    (async () => {
      // Independent of the run table: a scheduler that only ever skips has a
      // status row and no runs, which is exactly the case worth showing.
      if (!(await syncSchedulerTableExists())) {
        return { status: null, unavailableReason: null };
      }
      try {
        return { status: await readSchedulerStatus(), unavailableReason: null };
      } catch (error) {
        return {
          status: null,
          unavailableReason: error instanceof Error ? error.message : String(error)
        };
      }
    })()
  ]);

  return {
    ...base,
    available: runs.available,
    unavailableReason: runs.unavailableReason,
    latest: runs.runs[0] ?? null,
    runs: runs.runs,
    scheduler: scheduler.status,
    schedulerUnavailableReason: scheduler.unavailableReason,
    groups: SYNC_TABLE_GROUPS.map((group) => ({
      title: group.title,
      tables: tables.filter((row) => row.group === group.title)
    }))
  };
}
