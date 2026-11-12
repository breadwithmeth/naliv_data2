import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../prisma.js";

const numericTypes = new Set([
  "smallint",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "real",
  "double precision",
  "money"
]);

const temporalTypes = new Set([
  "date",
  "timestamp without time zone",
  "timestamp with time zone",
  "time without time zone",
  "time with time zone"
]);

const textTypes = new Set([
  "text",
  "character varying",
  "character",
  "uuid",
  "USER-DEFINED"
]);

export type DbColumn = {
  name: string;
  dataType: string;
  nullable: boolean;
  isNumeric: boolean;
  isTemporal: boolean;
  isText: boolean;
};

export type DbTable = {
  name: string;
  kind: string;
  estimatedRows: number | null;
  totalBytes: number;
};

export type DataGroupKey =
  | "documents"
  | "documentLines"
  | "catalogs"
  | "balances"
  | "other";

export type DataGroup = {
  key: DataGroupKey;
  tableCount: number;
  estimatedRows: number | null;
  totalBytes: number;
  columnCount: number;
  numericColumnCount: number;
  temporalColumnCount: number;
  sampleTables: string[];
};

type SchemaColumn = {
  table_name: string;
  column_name: string;
  data_type: string;
};

const dataGroupOrder: DataGroupKey[] = [
  "documents",
  "documentLines",
  "catalogs",
  "balances",
  "other"
];

const serviceColumns = [
  "_id",
  "_loaded_at",
  "_parent_ref_key",
  "_parent_line_index"
];

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(tableName: string) {
  return `${quoteIdent(config.PGSCHEMA)}.${quoteIdent(tableName)}`;
}

async function assertTableExists(tableName: string) {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    select c.relname as table_name
    from pg_class c
    where c.relnamespace = to_regnamespace(${config.PGSCHEMA})
      and c.relname = ${tableName}
      and c.relkind in ('r', 'p', 'v', 'm')
    limit 1
  `;

  if (rows.length === 0) {
    throw Object.assign(new Error("Таблица не найдена"), { statusCode: 404 });
  }
}

export async function getTables(): Promise<DbTable[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      name: string;
      kind: string;
      estimated_rows: bigint | number | null;
      total_bytes: bigint | number | null;
    }>
  >`
    select
      c.relname as name,
      case c.relkind
        when 'r' then 'table'
        when 'p' then 'partitioned table'
        when 'v' then 'view'
        when 'm' then 'materialized view'
        else c.relkind::text
      end as kind,
      case
        when c.reltuples >= 0 then c.reltuples::float8
        when s.n_live_tup > 0 then s.n_live_tup::float8
        else null
      end as estimated_rows,
      pg_total_relation_size(c.oid) as total_bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where n.oid = to_regnamespace(${config.PGSCHEMA})
      and c.relkind in ('r', 'p', 'v', 'm')
    order by pg_total_relation_size(c.oid) desc, c.relname asc
  `;

  return rows.map((row) => ({
    name: row.name,
    kind: row.kind,
    estimatedRows: row.estimated_rows === null ? null : Number(row.estimated_rows),
    totalBytes: Number(row.total_bytes ?? 0)
  }));
}

// Bind bounded diagnostics caches to the live catalogue, so a compact-layout cutover
// cannot keep serving a removed table or stale date/metric controls until TTL expiry.
export async function getSchemaRevision() {
  const [row] = await prisma.$queryRaw<Array<{ revision: string }>>`
    select md5(coalesce(string_agg(
      concat_ws(':', c.oid, c.relname, c.relkind, a.attnum, a.attname,
        a.atttypid, a.atttypmod, a.attnotnull), '|' order by c.oid, a.attnum
    ), '')) as revision
    from pg_class c
    left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where c.relnamespace = to_regnamespace(${config.PGSCHEMA})
      and c.relkind in ('r', 'p', 'v', 'm')
  `;
  return row.revision;
}

export async function getColumns(tableName: string): Promise<DbColumn[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      column_name: string;
      data_type: string;
      is_nullable: "YES" | "NO";
    }>
  >`
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = (select nspname from pg_namespace where oid = to_regnamespace(${config.PGSCHEMA}))
      and table_name = ${tableName}
    order by ordinal_position
  `;

  return rows.map((row) => ({
    name: row.column_name,
    dataType: row.data_type,
    nullable: row.is_nullable === "YES",
    isNumeric: numericTypes.has(row.data_type),
    isTemporal: temporalTypes.has(row.data_type),
    isText: textTypes.has(row.data_type)
  }));
}

const TARGET_DATABASE_BYTES = 13_000_000_000;

function addEstimates(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

/** Uncached challenge response binds an authenticated HTTP report server to its real database. */
export async function getStorageIdentity(challenge: string) {
  const [identity] = await prisma.$queryRaw<Array<{
    challenge: string;
    database_name: string;
    database_oid: bigint;
    schema_name: string;
    schema_oid: bigint;
    has_layout: boolean;
  }>>`
    select ${challenge}::text as challenge, current_database() as database_name,
      d.oid::bigint as database_oid, n.nspname as schema_name, n.oid::bigint as schema_oid,
      to_regclass('ops.analytics_storage_layout') is not null as has_layout
    from pg_database d
    join pg_namespace n on n.oid = to_regnamespace(${config.PGSCHEMA})
    where d.datname = current_database()
  `;
  if (!identity) {
    throw Object.assign(new Error("Схема аналитики не найдена"), { statusCode: 404 });
  }
  const [layout] = identity.has_layout
    ? await prisma.$queryRaw<Array<{
        layoutVersion: number;
        contractSha256: string;
        migrationId: string;
        planSha256: string;
        compactionActive: boolean;
      }>>`
        select layout_version as "layoutVersion", contract_sha256 as "contractSha256",
          migration_id::text as "migrationId", plan_sha256 as "planSha256",
          ddl_frozen as "compactionActive"
        from ops.analytics_storage_layout where table_schema = ${identity.schema_name}
      `
    : [];
  return {
    proofVersion: 1 as const,
    challenge: identity.challenge,
    targetDatabase: { name: identity.database_name, oid: Number(identity.database_oid) },
    sourceSchema: { name: identity.schema_name, oid: Number(identity.schema_oid) },
    layout: layout ?? null
  };
}

async function getStorageDiagnostics() {
  const [measurement] = await prisma.$queryRaw<Array<{
    database_bytes: bigint;
    heap_bytes: bigint;
    index_bytes: bigint;
    toast_bytes: bigint;
    measured_at: Date;
    source_schema: string | null;
    has_layout: boolean;
    has_sources: boolean;
  }>>`
    with sizes as (
      select pg_table_size(c.oid) as table_bytes, pg_indexes_size(c.oid) as index_bytes,
        case when c.reltoastrelid = 0 then 0 else pg_total_relation_size(c.reltoastrelid) end as toast_bytes
      from pg_class c
      where c.relnamespace = to_regnamespace(${config.PGSCHEMA})
        and c.relkind in ('r', 'p', 'm')
    )
    select pg_database_size(current_database()) as database_bytes,
      coalesce(sum(table_bytes - toast_bytes), 0)::bigint as heap_bytes,
      coalesce(sum(index_bytes), 0)::bigint as index_bytes,
      coalesce(sum(toast_bytes), 0)::bigint as toast_bytes,
      clock_timestamp() as measured_at,
      (select nspname from pg_namespace where oid = to_regnamespace(${config.PGSCHEMA})) as source_schema,
      to_regclass('ops.analytics_storage_layout') is not null as has_layout,
      to_regclass('ops.analytics_sources') is not null as has_sources
    from sizes
  `;
  const schema = measurement.source_schema ?? config.PGSCHEMA;
  const [layout] = measurement.has_layout
    ? await prisma.$queryRaw<Array<{ layout_version: number; ddl_frozen: boolean }>>`
        select layout_version, ddl_frozen from ops.analytics_storage_layout where table_schema = ${schema}
      `
    : [];
  const [provenance] = measurement.has_sources
    ? await prisma.$queryRaw<Array<{ relation_count: bigint; resource_count: bigint }>>`
        select count(distinct s.table_name) as relation_count, count(*) as resource_count
        from ops.analytics_sources s
        join pg_class c on c.relname = s.table_name and c.relnamespace = to_regnamespace(${schema})
          and c.relkind in ('r', 'p', 'v', 'm')
        where s.table_schema = ${schema}
      `
    : [];
  const databaseBytes = Number(measurement.database_bytes);
  const sourceHeapBytes = Number(measurement.heap_bytes);
  const sourceIndexBytes = Number(measurement.index_bytes);
  const sourceToastBytes = Number(measurement.toast_bytes);
  return {
    storage: {
      databaseBytes,
      sourceHeapBytes,
      sourceIndexBytes,
      sourceToastBytes,
      // Concurrent catalogue size reads can briefly observe a source total above the database total.
      otherBytes: Math.max(0, databaseBytes - sourceHeapBytes - sourceIndexBytes - sourceToastBytes),
      targetBytes: TARGET_DATABASE_BYTES,
      withinTarget: databaseBytes <= TARGET_DATABASE_BYTES,
      layoutVersion: layout?.layout_version ?? null,
      compactionActive: layout?.ddl_frozen ?? false,
      measuredAtUtc: measurement.measured_at.toISOString()
    },
    provenance: {
      available: measurement.has_sources,
      relationCount: provenance ? Number(provenance.relation_count) : 0,
      resourceCount: provenance ? Number(provenance.resource_count) : 0
    }
  };
}

async function getRelationSources(tableName: string) {
  const [catalogue] = await prisma.$queryRaw<Array<{ available: boolean }>>`
    select to_regclass('ops.analytics_sources') is not null as available
  `;
  if (!catalogue.available) return [];
  return prisma.$queryRaw<Array<{ sourceEntity: string; resourceTemplate: string }>>`
    select source_entity as "sourceEntity", resource_template as "resourceTemplate"
    from ops.analytics_sources
    where table_schema = (select nspname from pg_namespace where oid = to_regnamespace(${config.PGSCHEMA}))
      and table_name = ${tableName}
    order by source_entity, resource_template
  `;
}

export async function getOverview() {
  const tables = await getTables();
  const columns = await prisma.$queryRaw<SchemaColumn[]>`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = (select nspname from pg_namespace where oid = to_regnamespace(${config.PGSCHEMA}))
    `;
  const diagnostics = await getStorageDiagnostics();

  const columnsByTable = new Map<string, SchemaColumn[]>();
  for (const column of columns) {
    const group = columnsByTable.get(column.table_name);
    if (group) {
      group.push(column);
    } else {
      columnsByTable.set(column.table_name, [column]);
    }
  }

  const groups = new Map<DataGroupKey, DataGroup>(
    dataGroupOrder.map((key) => [
      key,
      {
        key,
        tableCount: 0,
        estimatedRows: 0,
        totalBytes: 0,
        columnCount: 0,
        numericColumnCount: 0,
        temporalColumnCount: 0,
        sampleTables: []
      }
    ])
  );

  for (const table of tables) {
    const tableColumns = columnsByTable.get(table.name) ?? [];
    const columnNames = new Set(tableColumns.map((column) => column.column_name));
    const key = classifyDataGroup(table.name, columnNames);
    const group = groups.get(key);

    if (!group) {
      continue;
    }

    group.tableCount += 1;
    group.estimatedRows = addEstimates(group.estimatedRows, table.estimatedRows);
    group.totalBytes += table.totalBytes;
    group.columnCount += tableColumns.length;
    group.numericColumnCount += tableColumns.filter((column) =>
      numericTypes.has(column.data_type)
    ).length;
    group.temporalColumnCount += tableColumns.filter((column) =>
      temporalTypes.has(column.data_type)
    ).length;

    if (group.sampleTables.length < 6) {
      group.sampleTables.push(table.name);
    }
  }

  const serviceFieldCoverage = serviceColumns.map((name) => ({
    name,
    tableCount: columns.filter((column) => column.column_name === name).length
  }));

  return {
    schema: config.PGSCHEMA,
    tableCount: tables.length,
    estimatedRows: tables.reduce<number | null>((sum, table) => addEstimates(sum, table.estimatedRows), 0),
    totalBytes: tables.reduce((sum, table) => sum + table.totalBytes, 0),
    columnCount: columns.length,
    numericColumnCount: columns.filter((column) => numericTypes.has(column.data_type)).length,
    temporalColumnCount: columns.filter((column) =>
      temporalTypes.has(column.data_type)
    ).length,
    largestTables: tables.slice(0, 12),
    tables,
    dataGroups: dataGroupOrder
      .map((key) => groups.get(key))
      .filter((group): group is DataGroup => Boolean(group && group.tableCount > 0)),
    serviceFieldCoverage,
    ...diagnostics
  };
}

function classifyDataGroup(tableName: string, columnNames: Set<string>): DataGroupKey {
  if (tableName.endsWith("_balance") || tableName.includes("_balance_")) {
    return "balances";
  }

  if (columnNames.has("_parent_ref_key") || columnNames.has("_parent_line_index")) {
    return "documentLines";
  }

  if (tableName.startsWith("document_")) {
    return "documents";
  }

  if (tableName.startsWith("catalog_")) {
    return "catalogs";
  }

  return "other";
}

async function getSampleRows(tableName: string, columns: DbColumn[]) {
  return prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `select ${columns.map(column => quoteIdent(column.name)).join(", ")} from ${qualifiedTable(tableName)} limit 25`
  );
}

export async function getColumnSummaries(tableName: string, columns: DbColumn[]) {
  const numeric = columns.filter((column) => column.isNumeric).slice(0, 8);
  const temporal = columns.filter((column) => column.isTemporal).slice(0, 8);
  const targets = [...numeric, ...temporal];
  if (!targets.length) return { numericSummaries: [], temporalSummaries: [] };

  // All min/max/average/count metrics share one scan of the source table.
  const expressions = targets.flatMap((column, index) => {
    const name = quoteIdent(column.name);
    return [
      `min(${name})::text as "min_${index}"`,
      `max(${name})::text as "max_${index}"`,
      `count(${name}) as "filled_${index}"`,
      ...(index < numeric.length ? [`avg(${name})::float8 as "avg_${index}"`] : [])
    ];
  });
  const [row] = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `select ${expressions.join(", ")} from ${qualifiedTable(tableName)}`
  );
  const summary = (column: DbColumn, index: number) => ({
    column: column.name,
    min: row?.[`min_${index}`] ?? null,
    max: row?.[`max_${index}`] ?? null,
    filled: Number(row?.[`filled_${index}`] ?? 0)
  });
  return {
    numericSummaries: numeric.map((column, index) => ({
      ...summary(column, index),
      avg: row?.[`avg_${index}`] ?? null
    })),
    temporalSummaries: temporal.map((column, index) => summary(column, numeric.length + index))
  };
}

async function getTopValues(tableName: string, columns: DbColumn[]) {
  const targets = columns.filter((column) => column.isText).slice(0, 4);

  return Promise.all(
    targets.map(async (column) => {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ value: string | null; count: bigint | number }>
      >(
        `select ${quoteIdent(column.name)}::text as value, count(*) as count
         from ${qualifiedTable(tableName)}
         where ${quoteIdent(column.name)} is not null
         group by ${quoteIdent(column.name)}
         order by count(*) desc
         limit 8`
      );

      return {
        column: column.name,
        values: rows.map((row) => ({
          value: row.value,
          count: Number(row.count)
        }))
      };
    })
  );
}

export async function getTableProfile(tableName: string) {
  await assertTableExists(tableName);

  const [tables, columns] = await Promise.all([getTables(), getColumns(tableName)]);
  const meta = tables.find((table) => table.name === tableName);
  const [sampleRows, { numericSummaries, temporalSummaries }, topValues, sources] =
    await Promise.all([
      getSampleRows(tableName, columns),
      getColumnSummaries(tableName, columns),
      getTopValues(tableName, columns),
      getRelationSources(tableName)
    ]);

  return {
    table: meta,
    columns,
    sampleRows,
    numericSummaries,
    temporalSummaries,
    topValues,
    sources
  };
}

export async function getTimeSeries(
  tableName: string,
  dateColumn: string,
  metricColumn?: string
) {
  await assertTableExists(tableName);

  const columns = await getColumns(tableName);
  const date = columns.find((column) => column.name === dateColumn && column.isTemporal);
  const metric = metricColumn
    ? columns.find((column) => column.name === metricColumn && column.isNumeric)
    : undefined;

  if (!date || (metricColumn && !metric)) {
    throw Object.assign(new Error("Некорректные колонки для графика"), {
      statusCode: 400
    });
  }

  const metricSql = metric
    ? `sum(${quoteIdent(metric.name)})::float8 as metric`
    : `count(*)::float8 as metric`;

  const rows = await prisma.$queryRawUnsafe<
    Array<{ bucket: Date | string; metric: number }>
  >(
    `select date_trunc('day', ${quoteIdent(date.name)}) as bucket,
            ${metricSql}
     from ${qualifiedTable(tableName)}
     where ${quoteIdent(date.name)} is not null
     group by 1
     order by 1 desc
     limit 90`
  );

  return rows
    .reverse()
    .map((row) => ({
      bucket: row.bucket instanceof Date ? row.bucket.toISOString() : row.bucket,
      metric: Number(row.metric ?? 0)
    }));
}
