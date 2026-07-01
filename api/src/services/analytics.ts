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
  estimatedRows: number;
  totalBytes: number;
};

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(tableName: string) {
  return `${quoteIdent(config.PGSCHEMA)}.${quoteIdent(tableName)}`;
}

async function assertTableExists(tableName: string) {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    select table_name
    from information_schema.tables
    where table_schema = ${config.PGSCHEMA}
      and table_name = ${tableName}
      and table_type in ('BASE TABLE', 'VIEW')
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
      coalesce(s.n_live_tup, 0) as estimated_rows,
      pg_total_relation_size(c.oid) as total_bytes
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where n.nspname = ${config.PGSCHEMA}
      and c.relkind in ('r', 'p', 'v', 'm')
    order by pg_total_relation_size(c.oid) desc, c.relname asc
  `;

  return rows.map((row) => ({
    name: row.name,
    kind: row.kind,
    estimatedRows: Number(row.estimated_rows ?? 0),
    totalBytes: Number(row.total_bytes ?? 0)
  }));
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
    where table_schema = ${config.PGSCHEMA}
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

export async function getOverview() {
  const [tables, columnStats] = await Promise.all([
    getTables(),
    prisma.$queryRaw<
      Array<{
        total_columns: bigint | number;
        numeric_columns: bigint | number;
        temporal_columns: bigint | number;
      }>
    >`
      select
        count(*) as total_columns,
        count(*) filter (where data_type in (${Prisma.join([...numericTypes])})) as numeric_columns,
        count(*) filter (where data_type in (${Prisma.join([...temporalTypes])})) as temporal_columns
      from information_schema.columns
      where table_schema = ${config.PGSCHEMA}
    `
  ]);

  return {
    schema: config.PGSCHEMA,
    tableCount: tables.length,
    estimatedRows: tables.reduce((sum, table) => sum + table.estimatedRows, 0),
    totalBytes: tables.reduce((sum, table) => sum + table.totalBytes, 0),
    columnCount: Number(columnStats[0]?.total_columns ?? 0),
    numericColumnCount: Number(columnStats[0]?.numeric_columns ?? 0),
    temporalColumnCount: Number(columnStats[0]?.temporal_columns ?? 0),
    largestTables: tables.slice(0, 12),
    tables
  };
}

async function getSampleRows(tableName: string) {
  return prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `select * from ${qualifiedTable(tableName)} limit 25`
  );
}

async function getNumericSummaries(tableName: string, columns: DbColumn[]) {
  const targets = columns.filter((column) => column.isNumeric).slice(0, 8);

  return Promise.all(
    targets.map(async (column) => {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ min: unknown; max: unknown; avg: number | null; filled: bigint | number }>
      >(
        `select min(${quoteIdent(column.name)})::text as min,
                max(${quoteIdent(column.name)})::text as max,
                avg(${quoteIdent(column.name)})::float8 as avg,
                count(${quoteIdent(column.name)}) as filled
         from ${qualifiedTable(tableName)}`
      );

      return {
        column: column.name,
        min: rows[0]?.min ?? null,
        max: rows[0]?.max ?? null,
        avg: rows[0]?.avg ?? null,
        filled: Number(rows[0]?.filled ?? 0)
      };
    })
  );
}

async function getTemporalSummaries(tableName: string, columns: DbColumn[]) {
  const targets = columns.filter((column) => column.isTemporal).slice(0, 8);

  return Promise.all(
    targets.map(async (column) => {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ min: string | null; max: string | null; filled: bigint | number }>
      >(
        `select min(${quoteIdent(column.name)})::text as min,
                max(${quoteIdent(column.name)})::text as max,
                count(${quoteIdent(column.name)}) as filled
         from ${qualifiedTable(tableName)}`
      );

      return {
        column: column.name,
        min: rows[0]?.min ?? null,
        max: rows[0]?.max ?? null,
        filled: Number(rows[0]?.filled ?? 0)
      };
    })
  );
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
  const [sampleRows, numericSummaries, temporalSummaries, topValues] =
    await Promise.all([
      getSampleRows(tableName),
      getNumericSummaries(tableName, columns),
      getTemporalSummaries(tableName, columns),
      getTopValues(tableName, columns)
    ]);

  return {
    table: meta,
    columns,
    sampleRows,
    numericSummaries,
    temporalSummaries,
    topValues
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
