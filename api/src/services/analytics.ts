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

export type DataGroupKey =
  | "documents"
  | "documentLines"
  | "catalogs"
  | "balances"
  | "other";

export type DataGroup = {
  key: DataGroupKey;
  tableCount: number;
  estimatedRows: number;
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
  "_source_entity",
  "_source_url",
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
  const tables = await getTables();
  const columns = await prisma.$queryRaw<SchemaColumn[]>`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = ${config.PGSCHEMA}
    `;

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
    group.estimatedRows += table.estimatedRows;
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
    estimatedRows: tables.reduce((sum, table) => sum + table.estimatedRows, 0),
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
    serviceFieldCoverage
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
