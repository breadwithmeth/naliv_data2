import { Prisma } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import {
  chronologicalAverage, evaluateTurnoverRisks, planTurnoverTransfers, salesChange,
  sumNullable, turnoverRatios, turnoverSales
} from "./turnover-domain.js";
import {
  buildPhysicalStoreIndex, isUsableWarehouse, type PhysicalStore, type PhysicalStoreIndex, type StoreDirectoryEntry
} from "./turnover-stores.js";
import type {
  TurnoverDailyRow, TurnoverNorms, TurnoverOption, TurnoverPolicy, TurnoverReport,
  TurnoverOptions, TurnoverRequest, TurnoverRow, TurnoverRowDetail, TurnoverSales, TurnoverWindow
} from "./turnover-types.js";

const DAY = 86_400_000;
const UNKNOWN = "__unknown__";
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const DEFAULT_NORMS: TurnoverNorms = {
  minDays: 3, staleDays: 30, criticalStaleDays: 60, excessDays: 45, stopDays: 60,
  changePct: 20, targetDays: 30, highStockCost: null, leadTimeDays: null
};
const daysField = z.number().finite().min(0).max(3650);
const normShape = {
  minDays: daysField, staleDays: daysField, criticalStaleDays: daysField,
  excessDays: daysField, stopDays: daysField, changePct: z.number().finite().min(0).max(1000),
  targetDays: daysField.positive(), highStockCost: z.number().finite().min(0).max(1e15).nullable(),
  leadTimeDays: daysField.nullable()
};
const normsSchema = z.object(normShape).strict();
const policySchema = z.object({
  defaults: normsSchema,
  categories: z.record(z.object(normShape).partial().strict())
}).strict().superRefine((policy, context) => {
  if (Object.keys(policy.categories).length > 2000) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["categories"], message: "Слишком много нормативов категорий" });
  }
  for (const [key, norms] of [["defaults", policy.defaults], ...Object.entries(policy.categories)] as [string, Partial<TurnoverNorms>][]) {
    if ((norms.staleDays !== undefined && norms.criticalStaleDays !== undefined && norms.staleDays > norms.criticalStaleDays)
      || (norms.excessDays !== undefined && norms.stopDays !== undefined && norms.excessDays > norms.stopDays)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: key === "defaults" ? ["defaults"] : ["categories", key],
        message: "Порог критического отсутствия движения и остановки закупок не может быть ниже обычного порога" });
    }
  }
});
const jsonPolicySchema = z.string().max(250_000).transform((value, context) => {
  try { return JSON.parse(value) as unknown; }
  catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Нормативы должны быть корректным JSON" });
    return z.NEVER;
  }
}).pipe(policySchema);
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 2) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function dayNumber(value: string) { return Date.parse(`${value}T00:00:00Z`); }
function shiftDate(value: string, days: number) { return new Date(dayNumber(value) + days * DAY).toISOString().slice(0, 10); }
function dayCount(from: string, to: string) { return (dayNumber(to) - dayNumber(from)) / DAY; }
function datesBetween(from: string, to: string) {
  const dates: string[] = [];
  for (let at = dayNumber(from), end = dayNumber(to); at < end; at += DAY) dates.push(new Date(at).toISOString().slice(0, 10));
  return dates;
}
const dateField = z.string().refine(validDate, "Ожидается существующая дата YYYY-MM-DD (год от 0002)");
const keyField = z.string().trim().min(1).max(256);
export const turnoverQuerySchema = z.object({
  from: dateField, to: dateField, comparisonFrom: dateField.optional(), comparisonTo: dateField.optional(),
  store: z.union([keyField, z.array(keyField).max(1000)]).optional()
    .transform((value) => [...new Set(typeof value === "string" ? [value] : value ?? [])].sort()),
  storeScope: z.enum(["retail", "all"]).default("retail"),
  excludeZero: z.union([z.boolean(), z.enum(["true", "false"])]).default(false)
    .transform((value) => value === true || value === "true"),
  category: z.union([keyField, z.array(keyField).max(1000)]).optional()
    .transform((value) => [...new Set(typeof value === "string" ? [value] : value ?? [])].sort()),
  warehouse: keyField.optional(), brand: keyField.optional(), sku: keyField.optional(),
  search: z.string().trim().max(200).optional(), mode: z.enum(["quantity", "money", "both"]).default("both"),
  groupBy: z.enum(["sku", "store", "category", "brand", "day"]).default("sku"),
  horizon: z.coerce.number().pipe(z.union([z.literal(7), z.literal(14), z.literal(30)])).default(14),
  risk: z.enum(["all", "no-sales", "overstock", "deficit", "stagnant"]).default("all"),
  sort: z.enum(["turnover", "stock-cost", "no-movement", "sales-decline"]).default("turnover"),
  profile: z.enum(["summary", "full", "sample"]).default("full"),
  auditGroup: z.string().min(1).max(1000).optional(),
  norms: z.union([jsonPolicySchema, policySchema]).optional()
}).superRefine((value, context) => {
  if (value.profile === "sample" && value.groupBy !== "sku") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["groupBy"], message: "Сводный отчёт формируется по товарам (SKU)" });
  }
  if (value.profile === "sample" && dayCount(value.from, value.to) < 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "Сводный отчёт требует период не менее 2 календарных дней" });
  }
  const days = dayCount(value.from, value.to);
  if (!(days >= 1 && days <= 366)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "Период [from,to) должен содержать от 1 до 366 дней" });
  if (Boolean(value.comparisonFrom) !== Boolean(value.comparisonTo)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["comparisonFrom"], message: "Укажите обе границы периода сравнения" });
  }
  if (value.comparisonFrom && value.comparisonTo) {
    if (dayCount(value.comparisonFrom, value.comparisonTo) !== days) context.addIssue({ code: z.ZodIssueCode.custom, path: ["comparisonTo"], message: "Продолжительность сравниваемых периодов должна совпадать" });
    if (value.from < value.comparisonTo && value.comparisonFrom < value.to) context.addIssue({ code: z.ZodIssueCode.custom, path: ["comparisonFrom"], message: "Периоды сравнения не должны пересекаться" });
  }
}).transform((value) => ({
  ...value,
  comparisonFrom: value.comparisonFrom ?? shiftDate(value.from, -dayCount(value.from, value.to)),
  comparisonTo: value.comparisonTo ?? value.from,
  norms: value.norms ? {
    defaults: value.norms.defaults,
    categories: Object.fromEntries(Object.entries(value.norms.categories).sort(([a], [b]) => a.localeCompare(b)))
  } : { defaults: { ...DEFAULT_NORMS }, categories: {} }
}));

type Item = {
  key: string; name: string; parent: string | null; folder: boolean; article: string | null;
  code: string | null; group: string | null; brand: string | null; unit: string | null;
  minimums: Record<string, number | null>;
};
type Warehouse = TurnoverOption & { storeKey: string | null };
type StockFact = [store: string, sku: string, characteristic: string, days: [date: string, quantity: number | null][]];
type SaleFact = [store: string, sku: string, characteristic: string, days: [date: string, quantity: number | null, revenue: number | null, positive: boolean][]];
type CostFact = [priority: number, store: string, sku: string, characteristic: string, at: string, price: number | null];
type OrderFact = [store: string, sku: string, at: string, key: string, quantity: number | null, delivery: string | null];
type ReceiptFact = [order: string, sku: string, at: string, quantity: number | null];
type Sources = {
  items: Item[]; stores: TurnoverOption[]; warehouses: Warehouse[]; brands: TurnoverOption[];
  units: TurnoverOption[]; groups: TurnoverOption[]; snapshots: string[];
  selectedSkus: string[];
  stock: StockFact[]; sales: SaleFact[]; costs: CostFact[]; orders: OrderFact[]; receipts: ReceiptFact[];
  lastSales: [store: string, sku: string, date: string | null][];
  firstStock: [store: string, sku: string, date: string][];
  salesDays: [store: string, date: string][]; barcodes: [sku: string, codes: string[]][];
  bounds: { firstStock: string | null; lastStock: string | null; firstSales: string | null; lastSales: string | null };
};
function table(name: string) { return Prisma.raw(`"${config.PGSCHEMA.replaceAll('"', '""')}"."${name}"`); }
function cleanKey(value: string | null | undefined) { return value && value !== EMPTY_GUID && value !== UNKNOWN ? value : null; }
function pairKey(store: string, sku: string) { return `${store}\u0000${sku}`; }
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// PostgreSQL in this deployment uses the C collation, so ILIKE does not fold
// Cyrillic case. Resolve name/article/code/SKU against the small catalog once
// in Node, then let source queries use an exact key set. Observed barcodes are
// not part of this pre-filter; the UI labels the search fields accordingly.
async function searchItemKeys(search: string): Promise<string[]> {
  const needle = search.toLocaleLowerCase("ru");
  const rows = await prisma.$queryRaw<{ ref_key: string; description: string | null; artikul: string | null; code: string | null }[]>`
    select ref_key, description, artikul, code
    from ${table("catalog_nomenklatura")}
    where is_folder is not true
  `;
  return rows.filter((row) => [row.description, row.artikul, row.code, row.ref_key]
    .some((value) => value?.toLocaleLowerCase("ru").includes(needle))).map((row) => row.ref_key);
}

type StoreDirectory = { stores: StoreDirectoryEntry[]; active: Set<string> };

// The retail network is a physical-outlet view of catalog_magaziny, not a
// legal-entity view. Activity is the only reliable retail signal in this source.
async function loadStoreDirectory(to?: string): Promise<StoreDirectory> {
  const [stores, active] = await Promise.all([
    prisma.$queryRaw<{ key: string; name: string | null }[]>`
      select ref_key as key, max(description) as name
      from ${table("catalog_magaziny")}
      where deletion_mark is not true
      group by ref_key
    `,
    prisma.$queryRaw<{ key: string }[]>`
      select distinct magazin_key as key
      from ${table("document_otchet_o_roznichnyh_prodazhah")}
      where posted = true and deletion_mark is not true
        and nullif(nullif(magazin_key, ''), ${EMPTY_GUID}) is not null
        ${to ? Prisma.sql`and date < ${to}::timestamp` : Prisma.empty}
    `
  ]);
  return {
    stores: stores.map((store) => ({ key: store.key, name: store.name ?? store.key })),
    active: new Set(active.map((store) => store.key))
  };
}

// One statement gives catalog, balances, sales and prices the same PostgreSQL
// MVCC snapshot. SQL groups sparse facts first; it never builds a SKU×day grid.
async function loadSources(params: NormalizedTurnoverRequest, searchKeys: string[] | undefined, sourceStoreKeys: string[]): Promise<Sources> {
  const balances = table("accumulation_register_tovary_na_skladah_balance");
  const reports = table("document_otchet_o_roznichnyh_prodazhah");
  const saleLines = table("document_otchet_o_roznichnyh_prodazhah_tovary");
  const returnLines = table("document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary");
  const itemTable = table("catalog_nomenklatura");
  const storeTable = table("catalog_magaziny");
  const warehouseTable = table("catalog_sklady");
  const registry = table("information_register_sebestoimost_nomenklatury_record_type");
  const costDocuments = table("document_ustanovka_sebestoimosti");
  const costLines = table("document_ustanovka_sebestoimosti_tovary");
  const orders = table("document_zakaz_postavschiku");
  const orderLines = table("document_zakaz_postavschiku_tovary");
  const receipts = table("document_postuplenie_tovarov");
  const receiptLines = table("document_postuplenie_tovarov_tovary");
  const earliestOperational = shiftDate(params.groupBy === "day" ? params.from : params.to, -60);
  const stockFrom = params.from < earliestOperational ? params.from : earliestOperational;
  const salesFrom = [stockFrom, params.comparisonFrom].sort()[0]!;
  const sourceTo = params.to > params.comparisonTo ? params.to : params.comparisonTo;
  const storeCondition = (expression: Prisma.Sql) => sourceStoreKeys.length
    ? Prisma.sql`${expression} in (${Prisma.join(sourceStoreKeys)})` : Prisma.sql`false`;
  const storeOf = (header: Prisma.Sql, warehouse: Prisma.Sql) => Prisma.sql`coalesce(nullif(nullif(${header}, ''), ${EMPTY_GUID}), nullif(nullif(${warehouse}, ''), ${EMPTY_GUID}), ${UNKNOWN})`;
  const movementStore = storeOf(Prisma.sql`r.magazin_key`, Prisma.sql`w.store_key`);
  const stockStore = storeOf(Prisma.sql`w.store_key`, Prisma.sql`null::text`);
  const orderStore = storeOf(Prisma.sql`d.magazin_key`, Prisma.sql`w.store_key`);
  const scopeWarehouse = (expression: Prisma.Sql) => params.warehouse ? Prisma.sql`${expression} = ${params.warehouse}` : Prisma.sql`true`;
  const categoryKeys = params.category.length ? Prisma.join(params.category) : null;
  const itemCondition = (expression: Prisma.Sql) => {
    if (params.sku) {
      // Exact keys may have source facts before their catalog card arrives.
      // Category/brand filters still require their original catalog eligibility.
      const eligible = params.category.length > 0 || params.brand
        ? Prisma.sql`exists (select 1 from selected_items)`
        : Prisma.sql`not exists (select 1 from catalog where ref_key = ${params.sku} and is_folder is true)`;
      return Prisma.sql`${expression} = ${params.sku} and ${eligible}`;
    }
    return params.category.length > 0 || params.brand || searchKeys !== undefined
      ? Prisma.sql`${expression} in (select ref_key from selected_items)` : Prisma.sql`${expression} is not null`;
  };
  const includeCosts = params.mode !== "quantity";
  const includeBarcodes = params.profile === "full";
  // Full reports keep SKUs whose only recorded movement is a prior return.
  // Summary files do not need that historic seed and avoid the extra scan.
  const priorReturnSeed = params.profile === "full" ? Prisma.sql`
      union all
      select ${movementStore}, l.nomenklatura_key, null::date
      from report_headers r join ${returnLines} l on l."_parent_ref_key" = r.ref_key
      left join warehouse_map w on w.ref_key = l.sklad_key
      where r.date < ${salesFrom}::timestamp and ${itemCondition(Prisma.sql`l.nomenklatura_key`)}
        and ${storeCondition(movementStore)} and ${scopeWarehouse(Prisma.sql`l.sklad_key`)}
      group by 1, 2` : Prisma.empty;
  // Summary export skips the historical KKM scan; quantity mode needs no cost
  // history at all. Both CTEs keep their output columns for the single query.
  const costCtes = includeCosts ? Prisma.sql`
    cost_events as (
      select 0 as priority, coalesce(nullif(nullif(c.magazin_key, ''), ${EMPTY_GUID}), ${UNKNOWN}) as store_key,
        c.nomenklatura_key as sku, coalesce(nullif(nullif(c.harakteristika_key, ''), ${EMPTY_GUID}), '') as characteristic,
        c.period as at, c.tsena::float8 as price, coalesce(c.line_number, 0) as line, '' as doc
      from ${registry} c where c.active is not false and c.period < ${sourceTo}::timestamp
        and ${itemCondition(Prisma.sql`c.nomenklatura_key`)}
        and ${storeCondition(Prisma.sql`coalesce(nullif(nullif(c.magazin_key, ''), ${EMPTY_GUID}), ${UNKNOWN})`)}
      union all
      select case when nullif(nullif(d.magazin_key, ''), ${EMPTY_GUID}) is null then 2 else 1 end,
        coalesce(nullif(nullif(d.magazin_key, ''), ${EMPTY_GUID}), ${UNKNOWN}), l.nomenklatura_key,
        coalesce(nullif(nullif(l.harakteristika_key, ''), ${EMPTY_GUID}), ''), d.date, l.tsena::float8,
        coalesce(l."_parent_line_index", 0), d.ref_key
      from ${costDocuments} d join ${costLines} l on l."_parent_ref_key" = d.ref_key
      where d.posted = true and d.deletion_mark is not true and d.date < ${sourceTo}::timestamp
        and ${itemCondition(Prisma.sql`l.nomenklatura_key`)}
        and (${storeCondition(Prisma.sql`d.magazin_key`)} or nullif(nullif(d.magazin_key, ''), ${EMPTY_GUID}) is null)
    ),
    costs as (
      select distinct on (priority, store_key, sku, characteristic, at) * from cost_events
      order by priority, store_key, sku, characteristic, at, line desc, doc desc, price desc
    ),` : Prisma.sql`
    costs as (
      select 0::int as priority, null::text as store_key, null::text as sku, null::text as characteristic,
        null::timestamp as at, null::float8 as price where false
    ),`;
  const barcodeCte = includeBarcodes ? Prisma.sql`
    recorded_barcodes as (
      select sku, array_agg(code order by code) as codes from (
        select l.nomenklatura_key as sku, trim(l.shtrihkod) as code
        from ${table("document_chek_kkm")} d join ${table("document_chek_kkm_tovary")} l on l."_parent_ref_key" = d.ref_key
        where d.posted = true and d.deletion_mark is not true and d.date < ${params.to}::timestamp
          and nullif(trim(l.shtrihkod), '') is not null and ${itemCondition(Prisma.sql`l.nomenklatura_key`)}
        group by l.nomenklatura_key, trim(l.shtrihkod)
      ) distinct_codes group by sku
    )` : Prisma.sql`
    recorded_barcodes as (select null::text as sku, '{}'::text[] as codes where false)`;
  const rows = await prisma.$queryRaw<{ data: Sources }[]>`
    with recursive
    catalog_source as materialized (
      select distinct on (n.ref_key) n.ref_key, n.description, n.parent_key, n.is_folder,
        n.artikul, n.code, n.tovarnaya_gruppa_key, n.marka_key, n.edinitsa_izmereniya_key,
        to_jsonb(n) as fields
      from ${itemTable} n where n.ref_key is not null
      order by n.ref_key, n.description desc nulls last, n.code desc nulls last
    ),
    catalog as materialized (
      select n.ref_key, n.description, n.parent_key, n.is_folder,
        n.artikul, n.code, n.tovarnaya_gruppa_key, n.marka_key, n.edinitsa_izmereniya_key,
        jsonb_build_object(
          'usolka', n.fields->'normativnyy_zapas_usolka', 'satpaeva', n.fields->'normativnyy_zapas_satpaeva',
          'gorkogo', n.fields->'normativnyy_zapas_gorkogo', 'karaganda', n.fields->'normativnyy_zapas_karaganda',
          'shahter', n.fields->'normativnyy_zapas_karaganda_shahter', 'pivzavod', n.fields->'normativnyy_zapas_karagandinskiy_pivzavod',
          'buhar', n.fields->'normativnyy_zapas_karaganda_buhar_zhyrau', 'tolstogo', n.fields->'normativnyy_zapas_tolstogo',
          'astana', n.fields->'normativnyy_zapas_astana', 'mira104', n.fields->'normativnyy_zapas_temirtau_mira104',
          'mira86', n.fields->'normativnyy_zapas_temirtau_mira86'
        ) as minimums
      from catalog_source n
    ),
    category_scope(ref_key) as (
      select ref_key from catalog where ${categoryKeys ? Prisma.sql`ref_key in (${categoryKeys})` : Prisma.sql`false`}
      union select n.ref_key from catalog n join category_scope s on s.ref_key = n.parent_key
    ),
    selected_items as materialized (
      select c.ref_key from catalog c where c.is_folder is not true
        and ${params.sku ? Prisma.sql`c.ref_key = ${params.sku}` : Prisma.sql`true`}
        and (${params.brand ?? null}::text is null or coalesce(nullif(nullif(c.marka_key, ''), ${EMPTY_GUID}), ${UNKNOWN}) = ${params.brand ?? ""})
        and (${params.category.length === 0} or ${categoryKeys ? Prisma.sql`c.tovarnaya_gruppa_key in (${categoryKeys})` : Prisma.sql`false`}
          or c.ref_key in (select ref_key from category_scope)
          or (${params.category.includes(UNKNOWN)} and coalesce(nullif(nullif(c.tovarnaya_gruppa_key, ''), ${EMPTY_GUID}), nullif(nullif(c.parent_key, ''), ${EMPTY_GUID})) is null))
        and (${searchKeys === undefined ? Prisma.sql`true`
          : searchKeys.length ? Prisma.sql`c.ref_key in (${Prisma.join(searchKeys)})` : Prisma.sql`false`})
    ),
    warehouse_map as materialized (
      select ref_key, max(nullif(nullif(magazin_key, ''), ${EMPTY_GUID})) as store_key,
        max(description) as description from ${warehouseTable} group by ref_key
    ),
    report_headers as materialized (
      select r.ref_key, r.date, r.magazin_key from ${reports} r
      where r.posted = true and r.deletion_mark is not true and r.date < ${sourceTo}::timestamp
    ),
    sales_coverage as (
      select coalesce(nullif(nullif(r.magazin_key, ''), ${EMPTY_GUID}), ${UNKNOWN}) as store_key,
        r.date::date as day from report_headers r
      union
      select ${movementStore}, r.date::date
      from report_headers r join ${saleLines} l on l."_parent_ref_key" = r.ref_key
      left join warehouse_map w on w.ref_key = l.sklad_key
      where nullif(nullif(r.magazin_key, ''), ${EMPTY_GUID}) is null
        and ${scopeWarehouse(Prisma.sql`l.sklad_key`)} and ${storeCondition(movementStore)}
      union
      select ${movementStore}, r.date::date
      from report_headers r join ${returnLines} l on l."_parent_ref_key" = r.ref_key
      left join warehouse_map w on w.ref_key = l.sklad_key
      where nullif(nullif(r.magazin_key, ''), ${EMPTY_GUID}) is null
        and ${scopeWarehouse(Prisma.sql`l.sklad_key`)} and ${storeCondition(movementStore)}
    ),
    movements as materialized (
      select r.date::date as day, ${movementStore} as store_key, l.nomenklatura_key as sku,
        coalesce(nullif(nullif(l.harakteristika_key, ''), ${EMPTY_GUID}), '') as characteristic,
        l.kolichestvo::float8 as qty, l.summa::float8 as revenue, coalesce(l.kolichestvo, 0) > 0 as positive
      from report_headers r join ${saleLines} l on l."_parent_ref_key" = r.ref_key
      left join warehouse_map w on w.ref_key = l.sklad_key
      where r.date >= ${salesFrom}::timestamp and ${itemCondition(Prisma.sql`l.nomenklatura_key`)}
        and ${storeCondition(movementStore)} and ${scopeWarehouse(Prisma.sql`l.sklad_key`)}
      union all
      select r.date::date, ${movementStore}, l.nomenklatura_key,
        coalesce(nullif(nullif(l.harakteristika_key, ''), ${EMPTY_GUID}), ''),
        -abs(l.kolichestvo)::float8, -abs(l.summa)::float8, false
      from report_headers r join ${returnLines} l on l."_parent_ref_key" = r.ref_key
      left join warehouse_map w on w.ref_key = l.sklad_key
      where r.date >= ${salesFrom}::timestamp and ${itemCondition(Prisma.sql`l.nomenklatura_key`)}
        and ${storeCondition(movementStore)} and ${scopeWarehouse(Prisma.sql`l.sklad_key`)}
    ),
    daily_sales as (
      select day, store_key, sku, characteristic,
        case when bool_or(qty is null) then null else sum(qty) end::float8 as qty,
        case when bool_or(revenue is null) then null else sum(revenue) end::float8 as revenue,
        bool_or(positive) as positive
      from movements group by day, store_key, sku, characteristic
    ),
    sales_series as (
      select store_key, sku, characteristic,
        jsonb_agg(jsonb_build_array(to_char(day, 'YYYY-MM-DD'), qty, revenue, positive) order by day) as days
      from daily_sales group by store_key, sku, characteristic
    ),
    stock as (
      select b.balance_period::date as day, ${stockStore} as store_key, b.nomenklatura_key as sku,
        coalesce(nullif(nullif(b.harakteristika_key, ''), ${EMPTY_GUID}), '') as characteristic,
        case when bool_or(b.kolichestvo_balance is null) then null else sum(b.kolichestvo_balance) end::float8 as qty
      from ${balances} b left join warehouse_map w on w.ref_key = b.sklad_key
      where b.balance_period >= ${stockFrom}::timestamp and b.balance_period <= ${params.to}::timestamp
        and b.balance_period = date_trunc('day', b.balance_period)
        and ${itemCondition(Prisma.sql`b.nomenklatura_key`)}
        and ${storeCondition(stockStore)} and ${scopeWarehouse(Prisma.sql`b.sklad_key`)}
      group by 1, 2, 3, 4
      having sum(b.kolichestvo_balance) <> 0 or bool_or(b.kolichestvo_balance is null)
    ),
    stock_series as (
      select store_key, sku, characteristic,
        jsonb_agg(jsonb_build_array(to_char(day, 'YYYY-MM-DD'), qty) order by day) as days
      from stock group by store_key, sku, characteristic
    ),
    prior_movements as (
      select ${movementStore} as store_key, l.nomenklatura_key as sku,
        max(r.date::date) filter (where l.kolichestvo > 0) as day
      from report_headers r join ${saleLines} l on l."_parent_ref_key" = r.ref_key
      left join warehouse_map w on w.ref_key = l.sklad_key
      where r.date < ${salesFrom}::timestamp and ${itemCondition(Prisma.sql`l.nomenklatura_key`)}
        and ${storeCondition(movementStore)} and ${scopeWarehouse(Prisma.sql`l.sklad_key`)}
      group by 1, 2
      ${priorReturnSeed}
    ),
    last_sales as (
      select store_key, sku, max(day) as day from prior_movements group by store_key, sku
    ),
    first_stock as (
      select ${stockStore} as store_key, b.nomenklatura_key as sku, min(b.balance_period)::date as day
      from ${balances} b left join warehouse_map w on w.ref_key = b.sklad_key
      where b.balance_period <= ${params.to}::timestamp and b.kolichestvo_balance > 0
        and ${itemCondition(Prisma.sql`b.nomenklatura_key`)}
        and ${storeCondition(stockStore)} and ${scopeWarehouse(Prisma.sql`b.sklad_key`)}
      group by 1, 2
    ),
    ${costCtes}
    ordered as (
      select ${orderStore} as store_key, l.nomenklatura_key as sku, d.date as at, d.ref_key,
        case when bool_or(l.kolichestvo is null) then null else sum(l.kolichestvo) end::float8 as qty,
        d.data_postupleniya::date as delivery
      from ${orders} d join ${orderLines} l on l."_parent_ref_key" = d.ref_key
      left join warehouse_map w on w.ref_key = d.sklad_key
      where d.posted = true and d.deletion_mark is not true and d.zakryt is not true
        and d.date < ${params.to}::timestamp and ${itemCondition(Prisma.sql`l.nomenklatura_key`)}
        and ${storeCondition(orderStore)} and ${scopeWarehouse(Prisma.sql`d.sklad_key`)}
      group by 1, 2, 3, 4, 6
    ),
    received as (
      select d.zakaz_postavschiku_key as order_key, l.nomenklatura_key as sku, d.date as at,
        case when bool_or(l.kolichestvo is null) then null else sum(l.kolichestvo) end::float8 as qty
      from ${receipts} d join ${receiptLines} l on l."_parent_ref_key" = d.ref_key
      where d.posted = true and d.deletion_mark is not true and d.date < ${params.to}::timestamp
        and d.zakaz_postavschiku_key in (select ref_key from ordered)
      group by 1, 2, 3
    ),
    ${barcodeCte}
    select jsonb_build_object(
      'selectedSkus', coalesce((select jsonb_agg(ref_key) from selected_items), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(jsonb_build_object('key', ref_key, 'name', coalesce(description, ref_key),
        'parent', parent_key, 'folder', coalesce(is_folder, false), 'article', artikul, 'code', code,
        'group', tovarnaya_gruppa_key, 'brand', marka_key, 'unit', edinitsa_izmereniya_key, 'minimums', minimums)) from catalog), '[]'::jsonb),
      'stores', coalesce((select jsonb_agg(jsonb_build_object('key', ref_key, 'name', coalesce(description, ref_key))) from (select ref_key, max(description) as description from ${storeTable} group by ref_key) s), '[]'::jsonb),
      'warehouses', coalesce((select jsonb_agg(jsonb_build_object('key', ref_key, 'name', coalesce(description, ref_key), 'storeKey', store_key)) from warehouse_map), '[]'::jsonb),
      'brands', coalesce((select jsonb_agg(jsonb_build_object('key', ref_key, 'name', coalesce(description, ref_key))) from (select ref_key, max(description) as description from ${table("catalog_marki")} group by ref_key) b), '[]'::jsonb),
      'units', coalesce((select jsonb_agg(jsonb_build_object('key', ref_key, 'name', coalesce(description, naimenovanie_polnoe, ref_key))) from (select ref_key, max(nullif(description, '')) as description, max(nullif(naimenovanie_polnoe, '')) as naimenovanie_polnoe from ${table("catalog_bazovye_edinitsy_izmereniya")} group by ref_key) u), '[]'::jsonb),
      'groups', coalesce((select jsonb_agg(jsonb_build_object('key', ref_key, 'name', coalesce(description, ref_key))) from (select ref_key, max(description) as description from ${table("catalog_tovarnye_gruppy")} group by ref_key) g), '[]'::jsonb),
      'snapshots', coalesce((select jsonb_agg(to_char(day, 'YYYY-MM-DD') order by day)
        from generate_series(${stockFrom}::timestamp, ${params.to}::timestamp, interval '1 day') day
        where exists (select 1 from ${balances} b where b.balance_period = day)), '[]'::jsonb),
      'stock', coalesce((select jsonb_agg(jsonb_build_array(store_key, sku, characteristic, days)) from stock_series), '[]'::jsonb),
      'sales', coalesce((select jsonb_agg(jsonb_build_array(store_key, sku, characteristic, days)) from sales_series), '[]'::jsonb),
      'costs', coalesce((select jsonb_agg(jsonb_build_array(priority, store_key, sku, characteristic, to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.US'), price) order by priority, store_key, sku, characteristic, at) from costs), '[]'::jsonb),
      'orders', coalesce((select jsonb_agg(jsonb_build_array(store_key, sku, to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.US'), ref_key, qty, to_char(delivery, 'YYYY-MM-DD'))) from ordered), '[]'::jsonb),
      'receipts', coalesce((select jsonb_agg(jsonb_build_array(order_key, sku, to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.US'), qty)) from received), '[]'::jsonb),
      'lastSales', coalesce((select jsonb_agg(jsonb_build_array(store_key, sku, to_char(day, 'YYYY-MM-DD'))) from last_sales), '[]'::jsonb),
      'firstStock', coalesce((select jsonb_agg(jsonb_build_array(store_key, sku, to_char(day, 'YYYY-MM-DD'))) from first_stock), '[]'::jsonb),
      'salesDays', coalesce((select jsonb_agg(jsonb_build_array(store_key, to_char(day, 'YYYY-MM-DD'))) from sales_coverage), '[]'::jsonb),
      'barcodes', coalesce((select jsonb_agg(jsonb_build_array(sku, codes)) from recorded_barcodes), '[]'::jsonb),
      'bounds', jsonb_build_object(
        'firstStock', (select to_char(min(balance_period)::date - 1, 'YYYY-MM-DD') from ${balances}),
        'lastStock', (select to_char(max(balance_period)::date - 1, 'YYYY-MM-DD') from ${balances}),
        'firstSales', (select to_char(min(date), 'YYYY-MM-DD') from ${reports} where posted = true and deletion_mark is not true),
        'lastSales', (select to_char(max(date), 'YYYY-MM-DD') from ${reports} where posted = true and deletion_mark is not true)
      )
    ) as data
  `;
  if (!rows[0]?.data) throw new Error("Источник отчёта оборачиваемости не вернул данные");
  return rows[0].data;
}

type NormalizedTurnoverRequest = TurnoverRequest & {
  comparisonFrom: string; comparisonTo: string; store: string[]; storeScope: "retail" | "all"; excludeZero: boolean; category: string[]; mode: "quantity" | "money" | "both";
  groupBy: "sku" | "store" | "category" | "brand" | "day"; horizon: 7 | 14 | 30;
  risk: "all" | "no-sales" | "overstock" | "deficit" | "stagnant";
  sort: "turnover" | "stock-cost" | "no-movement" | "sales-decline";
  profile: "summary" | "full" | "sample"; norms: TurnoverPolicy;
};
type DailyFact = { quantity: number | null; cost: number | null; revenue: number | null; positive: boolean };
type StockValue = { quantity: number | null; cost: number | null };
type CostPoint = { at: number; price: number | null };
type Pair = {
  key: string; store: string; sku: string; item: Item; unit: string; unitToken: string;
  category: string | null; categoryName: string; brand: string | null; brandName: string;
  storeName: string; norms: TurnoverNorms; minimum: number | null;
  stock: Map<string, StockValue>; sales: Map<string, DailyFact>; positiveDates: string[];
  firstStock: string | null; orders: OrderFact[]; barcodes: string[];
};

function categoryAncestors(item: Item, items: Map<string, Item>) {
  const ancestors: string[] = [];
  const seen = new Set<string>([item.key]);
  let parent = cleanKey(item.parent);
  while (parent && !seen.has(parent) && ancestors.length < 64) {
    ancestors.push(parent);
    seen.add(parent);
    parent = cleanKey(items.get(parent)?.parent);
  }
  return ancestors;
}

function minimumForStore(item: Item, storeName: string): number | null {
  const name = storeName.toLocaleLowerCase("ru");
  let key: string | null = null;
  if (name.includes("усол")) key = "usolka";
  else if (name.includes("сатпа")) key = "satpaeva";
  else if (name.includes("горьк")) key = "gorkogo";
  else if (name.includes("шахт")) key = "shahter";
  else if (name.includes("пивовар") || name.includes("пивзавод")) key = "pivzavod";
  else if (name.includes("бухар")) key = "buhar";
  else if (name.includes("толст")) key = "tolstogo";
  else if (name.includes("астан")) key = "astana";
  else if (/мира\s*104/.test(name)) key = "mira104";
  else if (/мира\s*86/.test(name)) key = "mira86";
  // Only a confirmed numeric norm for a mapped store is a quantity.
  const value = numberOrNull(key ? item.minimums[key] : null);
  return value !== null && value >= 0 ? value : null;
}

function mergeDaily(target: Map<string, TurnoverDailyRow>, days: TurnoverDailyRow[]) {
  for (const day of days) {
    const key = `${day.date}\u0000${day.unitKey ?? day.unit}`;
    const existing = target.get(key);
    if (!existing) { target.set(key, { ...day }); continue; }
    existing.quantity = existing.quantity === null || day.quantity === null ? null : existing.quantity + day.quantity;
    existing.stockCost = existing.stockCost === null || day.stockCost === null ? null : existing.stockCost + day.stockCost;
    existing.salesQty = existing.salesQty === null || day.salesQty === null ? null : existing.salesQty + day.salesQty;
    existing.salesCost = existing.salesCost === null || day.salesCost === null ? null : existing.salesCost + day.salesCost;
    existing.revenue = existing.revenue === null || day.revenue === null ? null : existing.revenue + day.revenue;
  }
}

function aggregateDaily(rows: TurnoverRow[]): TurnoverDailyRow[] {
  const days = new Map<string, TurnoverDailyRow>();
  for (const row of rows) mergeDaily(days, row.daily);
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date) || a.unit.localeCompare(b.unit, "ru"));
}

function isZeroTurnoverRow(row: TurnoverRow, mode: "quantity" | "money" | "both"): boolean {
  if (!row.daily.length) return false;
  const checkQuantity = mode !== "money";
  const checkMoney = mode !== "quantity";
  return row.daily.every((day) =>
    (!checkQuantity || (day.quantity === 0 && day.salesQty === 0))
    && (!checkMoney || (day.stockCost === 0 && day.salesCost === 0 && day.revenue === 0)));
}

function aggregateRows(rows: TurnoverRow[], key: string, name: string, days: number, params: NormalizedTurnoverRequest, dailyOverride?: TurnoverDailyRow[], retainAudit = false): TurnoverRow {
  const first = rows[0]!;
  const same = <K extends keyof TurnoverRow>(property: K) => rows.every((row) => row[property] === first[property]);
  const sum = (property: "openingQty" | "closingQty" | "openingCost" | "closingCost" | "excessQty" | "deficitQty" | "recommendedOrderQty" | "openOrderQty") =>
    sumNullable(rows.map((row) => row[property]));
  const sales = (values: TurnoverSales[], denominator: number) => turnoverSales(
    sumNullable(values.map((value) => value.quantity)), sumNullable(values.map((value) => value.cost)),
    sumNullable(values.map((value) => value.revenue)), denominator
  );
  const daily = dailyOverride ?? aggregateDaily(rows);
  const averageQty = chronologicalAverage(daily.map((day) => day.quantity));
  const averageCost = chronologicalAverage(daily.map((day) => day.stockCost));
  const periodSales = sales(rows.map((row) => row.periodSales), Math.max(1, days - 1));
  const comparisonSales = sales(rows.map((row) => row.comparisonSales), Math.max(1, days - 1));
  const qtyRatio = turnoverRatios(periodSales.quantity, averageQty, days);
  const costRatio = turnoverRatios(periodSales.cost, averageCost, days);
  const windows = first.windows.map((window, index): TurnoverWindow => {
    const current = sales(rows.map((row) => row.windows[index]!.sales), window.days);
    const previous = sales(rows.map((row) => row.windows[index]!.previousSales), window.days);
    return { ...window, sales: current, previousSales: previous,
      quantityChange: salesChange(current.quantity, previous.quantity), costChange: salesChange(current.cost, previous.cost) };
  });
  const closingQty = sum("closingQty");
  const velocity = windows.find((window) => window.days === params.horizon)!.sales.averageDailyQty;
  const recommendationGroups = new Map<string, { count: number; action: string }>();
  for (const row of rows) for (const recommendation of row.recommendations) {
    const group = recommendationGroups.get(recommendation.code);
    if (group) group.count++; else recommendationGroups.set(recommendation.code, { count: 1, action: recommendation.action });
  }
  const lastDates = rows.map((row) => row.lastSaleDate).filter((date): date is string => date !== null).sort();
  const costs = rows.map((row) => row.costCoveragePct);
  const deliveries = rows.map((row) => row.nextDeliveryDate).filter((date): date is string => date !== null).sort();
  return {
    key, name, sku: same("sku") ? first.sku : null, article: same("article") ? first.article : null,
    barcodes: rows.length === 1 ? first.barcodes : [],
    storeKey: same("storeKey") ? first.storeKey : null, storeName: same("storeName") ? first.storeName : "Все выбранные магазины",
    warehouseKey: same("warehouseKey") ? first.warehouseKey : null, warehouseName: same("warehouseName") ? first.warehouseName : "Все выбранные склады",
    categoryKey: same("categoryKey") ? first.categoryKey : null, categoryName: same("categoryName") ? first.categoryName : "Несколько категорий",
    brandKey: same("brandKey") ? first.brandKey : null, brandName: same("brandName") ? first.brandName : "Несколько брендов", unit: first.unit,
    openingQty: sum("openingQty"), closingQty, averageQty, openingCost: sum("openingCost"), closingCost: sum("closingCost"), averageCost,
    periodSales, comparisonSales, quantityChange: salesChange(periodSales.quantity, comparisonSales.quantity),
    costChange: salesChange(periodSales.cost, comparisonSales.cost), windows,
    turnoverQty: qtyRatio.coefficient, turnoverQtyDays: qtyRatio.days,
    turnoverCost: costRatio.coefficient, turnoverCostDays: costRatio.days,
    stockDays: closingQty !== null && velocity !== null && velocity > 0 ? closingQty / velocity : null,
    lastSaleDate: lastDates.at(-1) ?? null, daysWithoutMovement: rows.length === 1 ? first.daysWithoutMovement : null,
    noSalesHistory: rows.every((row) => row.noSalesHistory), observedDays: daily.filter((day) => day.quantity !== null).length,
    expectedDays: days, outOfStockDays: daily.every((day) => day.quantity !== null) ? daily.filter((day) => day.quantity! <= 0).length : null,
    costCoveragePct: costs.some((cost) => cost === null) ? null : costs.reduce<number>((total, cost) => total + cost!, 0) / rows.length,
    excessQty: sum("excessQty"), deficitQty: sum("deficitQty"), recommendedOrderQty: sum("recommendedOrderQty"), openOrderQty: sum("openOrderQty"),
    nextDeliveryDate: deliveries[0] ?? null,
    stagnantCost: {
      d30: sumNullable(rows.map((row) => row.stagnantCost.d30)),
      d60: sumNullable(rows.map((row) => row.stagnantCost.d60)),
      d90: sumNullable(rows.map((row) => row.stagnantCost.d90))
    },
    risks: [...new Set(rows.flatMap((row) => row.risks))],
    recommendations: [
      { code: "aggregate-advisory", action: "Рассматривать решения по отдельным SKU и магазинам",
        reason: `${rows.length} строк SKU/магазин. Риски — объединение признаков, количества заказа и излишка — суммы в одной учётной единице; нормативы не применяются повторно к общему запасу.` },
      ...[...recommendationGroups].map(([code, value]) => ({ code, action: value.action, reason: `Правило сработало у ${value.count} из ${rows.length} строк SKU/магазин; причины доступны в детализации по SKU.` }))
    ], daily: retainAudit ? daily : []
  };
}

export async function getTurnoverReport(request: TurnoverRequest): Promise<TurnoverReport> {
  const params: NormalizedTurnoverRequest = turnoverQuerySchema.parse(request);
  const sourceTo = params.to > params.comparisonTo ? params.to : params.comparisonTo;
  let source: Sources;
  let storeIndex!: PhysicalStoreIndex;
  let selectedPhysical!: PhysicalStore[];
  let sourceStoreKeys!: string[];
  try {
    const directory = await loadStoreDirectory(sourceTo);
    storeIndex = buildPhysicalStoreIndex(directory.stores, directory.active);
    const requested = new Set(params.store.map((key) => storeIndex.bySource.get(key) ?? key));
    selectedPhysical = params.store.length
      ? storeIndex.stores.filter((store) => requested.has(store.key))
      : params.storeScope === "all" ? storeIndex.stores : storeIndex.stores.filter((store) => store.retailActive);
    // A physical shop includes every source legal entity at its address, so
    // stock recorded under a non-selling duplicate is still counted.
    sourceStoreKeys = selectedPhysical.flatMap((store) => store.sourceKeys);
    const searchKeys = params.search ? await searchItemKeys(params.search) : undefined;
    source = await loadSources(params, searchKeys, sourceStoreKeys);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010"
      && ["42P01", "42703", "3F000"].includes(String(error.meta?.code))) {
      const detail = String(error.meta?.message ?? "Отсутствует обязательная таблица или колонка источника").slice(0, 500);
      throw Object.assign(new Error(`Источник отчёта оборачиваемости недоступен: ${detail}`, { cause: error }), { statusCode: 503 });
    }
    throw error;
  }
  const items = new Map(source.items.map((item) => [item.key, item]));
  const physicalWarehouses = source.warehouses
    .filter((warehouse) => warehouse.storeKey && sourceStoreKeys.includes(warehouse.storeKey)
      && isUsableWarehouse(warehouse.name))
    .map((warehouse) => ({ ...warehouse, storeKey: storeIndex.bySource.get(warehouse.storeKey!) ?? warehouse.storeKey }))
    .sort((left, right) => left.name.localeCompare(right.name, "ru") || left.key.localeCompare(right.key));
  const groups = new Map(source.groups.map((group) => [group.key, group.name]));
  const brands = new Map(source.brands.map((brand) => [brand.key, brand.name]));
  const units = new Map(source.units.map((unit) => [unit.key, unit.name]));
  const repeatedUnitNames = new Set(source.units.filter((unit, index, values) => values.findIndex((other) => other.name === unit.name) !== index).map((unit) => unit.name));
  const snapshots = new Set(source.snapshots);
  const salesDays = new Map<string, Set<string>>();
  for (const [sourceStore, date] of source.salesDays) {
    const store = storeIndex.bySource.get(sourceStore) ?? sourceStore;
    const days = salesDays.get(store);
    if (days) days.add(date); else salesDays.set(store, new Set([date]));
  }
  const costIndex = new Map<string, CostPoint[]>();
  for (const [priority, store, sku, characteristic, at, price] of source.costs) {
    const key = `${priority}\u0000${store}\u0000${sku}\u0000${characteristic}`;
    const parsedPrice = numberOrNull(price);
    const point = { at: Date.parse(`${at}Z`), price: parsedPrice !== null && parsedPrice > 0 ? parsedPrice : null };
    const history = costIndex.get(key);
    if (history) history.push(point); else costIndex.set(key, [point]);
  }
  source.costs.length = 0;
  const costAt = (store: string, sku: string, characteristic: string, at: number, inclusive: boolean): number | null => {
    if (params.mode === "quantity") return null;
    for (let priority = 0; priority < 3; priority++) {
      const history = costIndex.get(`${priority}\u0000${priority === 2 ? UNKNOWN : store}\u0000${sku}\u0000${characteristic}`);
      if (!history) continue;
      let low = 0, high = history.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (history[middle]!.at < at || (inclusive && history[middle]!.at === at)) low = middle + 1;
        else high = middle;
      }
      // A newer unknown/zero price blocks reuse of an older positive price.
      if (low > 0) return history[low - 1]!.price;
    }
    return null;
  };
  const barcodeIndex = new Map(source.barcodes);
  const pairs = new Map<string, Pair>();
  const getPair = (store: string, sku: string): Pair => {
    const physicalKey = storeIndex.bySource.get(store) ?? store;
    const physical = storeIndex.byKey.get(physicalKey);
    const key = pairKey(physicalKey, sku);
    const existing = pairs.get(key);
    if (existing) return existing;
    const item = items.get(sku) ?? { key: sku, name: `Номенклатура ${sku}`, parent: null, folder: false,
      article: null, code: null, group: null, brand: null, unit: null, minimums: {} };
    const ancestors = categoryAncestors(item, items);
    const category = cleanKey(item.group) ?? ancestors[0] ?? null;
    const brand = cleanKey(item.brand);
    const unitKey = cleanKey(item.unit);
    const unitName = unitKey ? units.get(unitKey) : null;
    const unit = unitName ? `${unitName}${repeatedUnitNames.has(unitName) ? ` [${unitKey}]` : ""}`
      : `Единица не указана (SKU ${sku}${unitKey ? `; ключ ${unitKey}` : ""})`;
    let norms = { ...params.norms.defaults };
    for (const ancestor of [...ancestors].reverse()) norms = { ...norms, ...params.norms.categories[ancestor] };
    if (category) norms = { ...norms, ...params.norms.categories[category] };
    else norms = { ...norms, ...params.norms.categories[UNKNOWN] };
    if (norms.staleDays > norms.criticalStaleDays || norms.excessDays > norms.stopDays) {
      throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["norms", "categories", category ?? UNKNOWN],
        message: "Унаследованные нормативы противоречат друг другу: критический порог ниже обычного" }]);
    }
    const storeName = physical?.name ?? (physicalKey === UNKNOWN ? "Магазин не указан" : `Магазин ${physicalKey}`);
    const pair: Pair = { key, store: physicalKey, sku, item, unit, unitToken: unitName ? unitKey! : `unknown:${sku}`,
      category, categoryName: category ? groups.get(category) ?? items.get(category)?.name ?? `Категория ${category}` : "Категория не указана",
      brand, brandName: brand ? brands.get(brand) ?? `Бренд не найден (${brand})` : "Бренд не указан",
      storeName, norms, minimum: minimumForStore(item, storeName), stock: new Map(), sales: new Map(),
      positiveDates: [], firstStock: null, orders: [], barcodes: barcodeIndex.get(sku) ?? [] };
    pairs.set(key, pair);
    return pair;
  };
  // An explicitly selected SKU still has a meaningful unknown row before the
  // first source day. Seed only when facts are absent, so an exact SKU and a
  // text search over the same retail network use the same population.
  if (params.sku && source.selectedSkus.includes(params.sku) && !items.get(params.sku)?.folder && pairs.size === 0) {
    const selectedWarehouse = params.warehouse ? source.warehouses.find((warehouse) => warehouse.key === params.warehouse) : undefined;
    const warehousePhysical = selectedWarehouse
      ? storeIndex.byKey.get(storeIndex.bySource.get(selectedWarehouse.storeKey ?? UNKNOWN) ?? selectedWarehouse.storeKey ?? UNKNOWN)
      : undefined;
    const seedStores = params.store.length ? selectedPhysical : warehousePhysical ? [warehousePhysical] : selectedPhysical;
    for (const physical of seedStores) getPair(physical.sourceKeys[0] ?? UNKNOWN, params.sku);
    if (!seedStores.length) getPair(UNKNOWN, params.sku);
  }
  const dateInstants = new Map<string, number>();
  for (const [store, sku, characteristic, facts] of source.stock) {
    const pair = getPair(store, sku);
    for (const [date, rawQuantity] of facts) {
      let at = dateInstants.get(date);
      if (at === undefined) { at = dayNumber(date); dateInstants.set(date, at); }
      const quantity = numberOrNull(rawQuantity);
      const unitCost = params.mode === "quantity" ? null : quantity === 0 ? 0 : costAt(store, sku, characteristic, at, false);
      const amount = quantity === null || unitCost === null ? null : quantity * unitCost;
      const cost = amount !== null && Number.isFinite(amount) ? amount : null;
      const existing = pair.stock.get(date);
      pair.stock.set(date, existing ? { quantity: sumNullable([existing.quantity, quantity]), cost: sumNullable([existing.cost, cost]) } : { quantity, cost });
    }
  }
  source.stock.length = 0;
  for (const [store, sku, characteristic, facts] of source.sales) {
    const pair = getPair(store, sku);
    let days = salesDays.get(store);
    if (!days) { days = new Set(); salesDays.set(store, days); }
    for (const [date, rawQuantity, rawRevenue, positive] of facts) {
      let at = dateInstants.get(date);
      if (at === undefined) { at = dayNumber(date); dateInstants.set(date, at); }
      const quantity = numberOrNull(rawQuantity);
      const revenue = numberOrNull(rawRevenue);
      const unitCost = params.mode === "quantity" ? null : quantity === 0 ? 0 : costAt(store, sku, characteristic, at, true);
      const amount = quantity === null || unitCost === null ? null : quantity * unitCost;
      const cost = amount !== null && Number.isFinite(amount) ? amount : null;
      const existing = pair.sales.get(date);
      pair.sales.set(date, existing ? { quantity: sumNullable([existing.quantity, quantity]), cost: sumNullable([existing.cost, cost]),
        revenue: sumNullable([existing.revenue, revenue]), positive: existing.positive || positive } : { quantity, cost, revenue, positive });
      days.add(date);
    }
  }
  source.sales.length = 0;
  costIndex.clear();
  for (const order of source.orders) getPair(order[0], order[1]).orders.push(order);
  source.orders.length = 0;
  // Full prior history seeds the observed assortment, even when a SKU is now
  // absent from every sparse snapshot. Grouping never changes this population.
  for (const [store, sku, date] of source.lastSales) {
    const pair = getPair(store, sku);
    if (date) pair.positiveDates.push(date);
  }
  for (const [store, sku, date] of source.firstStock) getPair(store, sku).firstStock = shiftDate(date, -1);
  source.lastSales.length = 0;
  source.firstStock.length = 0;
  for (const pair of pairs.values()) {
    for (const [date, sale] of pair.sales) if (sale.positive) pair.positiveDates.push(date);
    pair.positiveDates.sort();
  }
  const received = new Map<string, ReceiptFact[]>();
  for (const receipt of source.receipts) {
    const key = pairKey(receipt[0], receipt[1]);
    const group = received.get(key);
    if (group) group.push(receipt); else received.set(key, [receipt]);
  }
  const calendarCache = new Map<string, string[]>();
  const followingDates = new Map<string, string>();
  const calendar = (from: string, to: string) => {
    const key = `${from}/${to}`;
    const cached = calendarCache.get(key);
    if (cached) return cached;
    const days = datesBetween(from, to);
    calendarCache.set(key, days);
    for (let index = 0; index < days.length; index++) followingDates.set(days[index]!, days[index + 1] ?? to);
    return days;
  };
  const stockAt = (pair: Pair, date: string): StockValue => snapshots.has(date)
    ? pair.stock.get(date) ?? { quantity: 0, cost: params.mode === "quantity" ? null : 0 }
    : { quantity: null, cost: null };
  const salesAt = (pair: Pair, date: string): DailyFact => salesDays.get(pair.store)?.has(date)
    ? pair.sales.get(date) ?? { quantity: 0, cost: 0, revenue: 0, positive: false }
    : { quantity: null, cost: null, revenue: null, positive: false };
  const rangeSales = (pair: Pair, from: string, to: string, denominator: number): TurnoverSales => {
    let quantity: number | null = 0, cost: number | null = 0, revenue: number | null = 0;
    for (const date of calendar(from, to)) {
      const day = salesAt(pair, date);
      quantity = quantity === null || day.quantity === null ? null : quantity + day.quantity;
      cost = cost === null || day.cost === null ? null : cost + day.cost;
      revenue = revenue === null || day.revenue === null ? null : revenue + day.revenue;
      if (quantity === null && cost === null && revenue === null) break;
    }
    return turnoverSales(quantity, cost, revenue, denominator);
  };
  const makeRow = (pair: Pair, from: string, to: string, comparisonFrom: string, comparisonTo: string): TurnoverRow => {
    const dates = calendar(from, to);
    const days = dates.length;
    const opening = stockAt(pair, from);
    const closing = stockAt(pair, to);
    const daily: TurnoverDailyRow[] = [];
    let exposure = 0, valued = 0, unknownExposure = false;
    for (let index = 0; index < dates.length; index++) {
      const date = dates[index]!;
      const stock = stockAt(pair, followingDates.get(date)!);
      const sale = salesAt(pair, date);
      daily.push({ date, unit: pair.unit, unitKey: pair.unitToken, quantity: stock.quantity, stockCost: stock.cost,
        salesQty: sale.quantity, salesCost: sale.cost, revenue: sale.revenue,
        weight: days === 1 ? 1 : index === 0 || index === days - 1 ? 0.5 : 1 });
      for (const [quantity, cost] of [[stock.quantity, stock.cost], [sale.quantity, sale.cost]]) {
        if (quantity === null) unknownExposure = true;
        else { exposure += Math.abs(quantity!); if (cost !== null) valued += Math.abs(quantity!); }
      }
    }
    const averageQty = chronologicalAverage(daily.map((day) => day.quantity));
    const averageCost = chronologicalAverage(daily.map((day) => day.stockCost));
    const periodSales = rangeSales(pair, from, to, Math.max(1, days - 1));
    const comparisonSales = rangeSales(pair, comparisonFrom, comparisonTo, Math.max(1, days - 1));
    // A summary file has no 7/14/30 sheet; risks still need 14 days and the
    // selected horizon. Full exports retain all three comparable windows.
    const windowLengths = params.profile === "summary" || params.profile === "sample"
      ? [...new Set<7 | 14 | 30>([14, params.horizon])].sort((a, b) => a - b)
      : [7, 14, 30] as const;
    const windows = windowLengths.map((length): TurnoverWindow => {
      const current = { from: shiftDate(to, -length), to };
      const previous = { from: shiftDate(to, -2 * length), to: current.from };
      const sales = rangeSales(pair, current.from, current.to, length);
      const previousSales = rangeSales(pair, previous.from, previous.to, length);
      return { days: length, current, previous, sales, previousSales,
        quantityChange: salesChange(sales.quantity, previousSales.quantity), costChange: salesChange(sales.cost, previousSales.cost) };
    });
    const horizon = windows.find((window) => window.days === params.horizon)!;
    const dailyQuantity = horizon.sales.averageDailyQty;
    const stockDays = closing.quantity !== null && dailyQuantity !== null && dailyQuantity > 0 ? closing.quantity / dailyQuantity : null;
    const positiveDates = pair.positiveDates;
    let lastSaleDate: string | null = null;
    for (let index = positiveDates.length - 1; index >= 0; index--) if (positiveDates[index]! < to) { lastSaleDate = positiveDates[index]!; break; }
    const daysWithoutMovement = lastSaleDate ? Math.max(0, dayCount(lastSaleDate, shiftDate(to, -1))) : null;
    const stockAgeDays = pair.firstStock && pair.firstStock < to ? Math.max(0, dayCount(pair.firstStock, shiftDate(to, -1))) : null;
    let openOrderQty: number | null = 0;
    let nextDeliveryDate: string | null = null;
    for (const order of pair.orders) {
      if (order[2].slice(0, 10) >= to) continue;
      const receiptValues = (received.get(pairKey(order[3], pair.sku)) ?? []).filter((receipt) => receipt[2].slice(0, 10) < to).map((receipt) => numberOrNull(receipt[3]));
      const receiptQty = sumNullable(receiptValues);
      const orderedQty = numberOrNull(order[4]);
      const remaining = orderedQty === null || receiptQty === null ? null : Math.max(0, orderedQty - receiptQty);
      openOrderQty = sumNullable([openOrderQty, remaining]);
      const delivery = order[5] && order[5] >= "0002-01-01" ? order[5] : null;
      if (remaining !== null && remaining > 0 && delivery && (!nextDeliveryDate || delivery < nextDeliveryDate)) nextDeliveryDate = delivery;
    }
    const availabilityComplete = calendar(horizon.previous.from, horizon.current.to)
      .every((date) => { const stock = stockAt(pair, shiftDate(date, 1)); return stock.quantity !== null && stock.quantity > 0; });
    const risk = evaluateTurnoverRisks({
      closingQty: closing.quantity, closingCost: closing.cost, stockDays, periodQuantity: periodSales.quantity,
      recentQuantity: horizon.sales.quantity,
      sales14Quantity: windows.find((window) => window.days === 14)?.sales.quantity ?? null, dailyQuantity,
      change: horizon.quantityChange, availabilityComplete, daysWithoutMovement, noSalesHistory: lastSaleDate === null,
      stockAgeDays, openOrderQty, nextDeliveryDate, minimumStock: pair.minimum, asOf: shiftDate(to, -1)
    }, pair.norms);
    const quantityRatio = turnoverRatios(periodSales.quantity, averageQty, days);
    const costRatio = turnoverRatios(periodSales.cost, averageCost, days);
    const observedDays = daily.filter((day) => day.quantity !== null).length;
    const warehouse = params.warehouse ? source.warehouses.find((value) => value.key === params.warehouse) : null;
    return {
      key: `${pair.key}/${from}/${to}`, name: pair.item.name, sku: pair.sku, article: pair.item.article,
      barcodes: pair.barcodes, storeKey: pair.store === UNKNOWN ? null : pair.store, storeName: pair.storeName,
      warehouseKey: params.warehouse ?? null, warehouseName: warehouse?.name ?? (params.warehouse ? `Склад ${params.warehouse}` : "Все склады"),
      categoryKey: pair.category, categoryName: pair.categoryName, brandKey: pair.brand, brandName: pair.brandName, unit: pair.unit,
      openingQty: opening.quantity, closingQty: closing.quantity, averageQty, openingCost: opening.cost, closingCost: closing.cost, averageCost,
      periodSales, comparisonSales, quantityChange: salesChange(periodSales.quantity, comparisonSales.quantity),
      costChange: salesChange(periodSales.cost, comparisonSales.cost), windows,
      turnoverQty: quantityRatio.coefficient, turnoverQtyDays: quantityRatio.days,
      turnoverCost: costRatio.coefficient, turnoverCostDays: costRatio.days, stockDays, lastSaleDate, daysWithoutMovement,
      noSalesHistory: lastSaleDate === null, observedDays, expectedDays: days,
      outOfStockDays: observedDays === days ? daily.filter((day) => day.quantity! <= 0).length : null,
      costCoveragePct: unknownExposure ? null : exposure > 0 ? Math.min(100, valued / exposure * 100) : 100,
      openOrderQty, nextDeliveryDate, ...risk, daily
    };
  };
  const search = params.search?.toLocaleLowerCase("ru");
  const selectedPairs = [...pairs.values()].filter((pair) => !search || [pair.item.name, pair.item.article ?? "", pair.item.code ?? "", pair.sku, ...pair.barcodes]
    .some((value) => value.toLocaleLowerCase("ru").includes(search)));
  const consolidateStores = params.profile === "sample";
  const retainSkuAudit = Boolean(params.sku && items.get(params.sku)?.folder !== true);
  const retainReportDaily = params.profile === "full" || params.groupBy === "day";
  const reportDaily = new Map<string, TurnoverDailyRow>();
  const groupedDaily = new Map<string, Map<string, TurnoverDailyRow>>();
  const atomicRows: TurnoverRow[] = [];
  const pairByKey = new Map(selectedPairs.map((pair) => [`${pair.key}/${params.from}/${params.to}`, pair]));
  for (const pair of selectedPairs) {
    const row = makeRow(pair, params.from, params.to, params.comparisonFrom, params.comparisonTo);
    if (params.excludeZero && isZeroTurnoverRow(row, params.mode)) continue;
    if (params.risk === "all" || row.risks.includes(params.risk)) {
      if (retainReportDaily) mergeDaily(reportDaily, row.daily);
      if (consolidateStores || params.groupBy === "store" || params.groupBy === "category" || params.groupBy === "brand") {
        const groupKey = params.groupBy === "store" ? pair.store : params.groupBy === "category" ? pair.category ?? UNKNOWN : pair.brand ?? UNKNOWN;
        const key = consolidateStores ? pair.sku : `${params.groupBy}/${groupKey}/${pair.unitToken}`;
        let days = groupedDaily.get(key);
        if (!days) { days = new Map(); groupedDaily.set(key, days); }
        mergeDaily(days, row.daily);
      }
    }
    const keepDaily = !consolidateStores && (params.auditGroup === row.key
      || (params.profile === "full" && retainSkuAudit));
    if (!keepDaily) row.daily = [];
    atomicRows.push(row);
  }
  const transfers = params.profile === "sample" ? [] : planTurnoverTransfers(atomicRows);
  const transferRows = new Map(atomicRows.map((row) => [`${row.storeKey}\u0000${row.sku}\u0000${row.unit}`, row]));
  for (const transfer of transfers) {
    for (const store of [transfer.fromStoreKey, transfer.toStoreKey]) {
      const row = transferRows.get(`${store}\u0000${transfer.sku}\u0000${transfer.unit}`);
      if (row) row.recommendations.push({ code: "transfer", action: "Рассмотреть межфилиальное перемещение",
        reason: `${transfer.fromStoreName} → ${transfer.toStoreName}: ${transfer.quantity.toFixed(3)} ${transfer.unit}; альтернатива закупке, ограничена излишком отправителя и потребностью получателя с учётом открытых заказов.` });
    }
  }
  const visibleAtomic = params.risk === "all" ? atomicRows : atomicRows.filter((row) => row.risks.includes(params.risk as Exclude<typeof params.risk, "all">));
  let rows: TurnoverRow[];
  if (params.groupBy === "sku" && !consolidateStores) rows = visibleAtomic;
  else if (params.groupBy === "day") {
    rows = [];
  } else {
    const byAtomicKey = new Map(atomicRows.map((row) => [row.key, pairByKey.get(row.key)!]));
    const grouped = new Map<string, { name: string; rows: TurnoverRow[] }>();
    for (const row of visibleAtomic) {
      const pair = byAtomicKey.get(row.key)!;
      const groupKey = params.groupBy === "store" ? pair.store : params.groupBy === "category" ? pair.category ?? UNKNOWN : pair.brand ?? UNKNOWN;
      const name = consolidateStores ? row.name : params.groupBy === "store" ? pair.storeName : params.groupBy === "category" ? pair.categoryName : pair.brandName;
      const key = consolidateStores ? pair.sku : `${params.groupBy}/${groupKey}/${pair.unitToken}`;
      const group = grouped.get(key);
      if (group) group.rows.push(row); else grouped.set(key, { name, rows: [row] });
    }
    rows = [...grouped].map(([key, group]) => {
      const row = aggregateRows(group.rows, consolidateStores ? `sample\u0000${key}/${params.from}/${params.to}` : key,
        group.name, dayCount(params.from, params.to), params,
        [...groupedDaily.get(key)!.values()].sort((a, b) => a.date.localeCompare(b.date)),
        consolidateStores || retainSkuAudit || params.auditGroup === key);
      if (consolidateStores && !params.warehouse) row.warehouseName = "Все склады";
      return row;
    });
  }
  const sortValue = (row: TurnoverRow): number | null => params.sort === "stock-cost" ? row.closingCost
    : params.sort === "no-movement" ? row.daysWithoutMovement
    : params.sort === "sales-decline" ? row.quantityChange.pct
    : params.mode === "money" ? row.turnoverCost : row.turnoverQty;
  rows.sort((a, b) => {
    const left = sortValue(a), right = sortValue(b);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    if (left !== null && right !== null && left !== right) return (params.sort === "stock-cost" || params.sort === "no-movement") ? right - left : left - right;
    return a.name.localeCompare(b.name, "ru") || a.key.localeCompare(b.key);
  });
  const expectedDates = calendar(params.from, params.to);
  const missingStockDates = expectedDates.filter((date) => !snapshots.has(shiftDate(date, 1)));
  const observedDays = expectedDates.length - missingStockDates.length;
  const warningSet = new Set<string>();
  if (!atomicRows.length) warningSet.add("Фильтрам не соответствуют наблюдаемые остатки, продажи или открытые заказы; отсутствие строк не доказывает нулевые продажи до начала доступной истории.");
  if (params.auditGroup && !rows.some((row) => row.key === params.auditGroup)) warningSet.add("Строка запрошенного дневного аудита не найдена в текущем составе отчёта; сформируйте отчёт заново.");
  if (missingStockDates.length) warningSet.add(`Нет обязательных дневных снимков: ${missingStockDates.length} из ${expectedDates.length}. Средние остатки и зависимые коэффициенты недоступны, снимки не переносятся вперёд.`);
  if (!snapshots.has(params.from)) warningSet.add("Нет снимка точно на начало периода; начальные остатки неизвестны.");
  if (atomicRows.some((row) => row.periodSales.quantity === null)) warningSet.add("Не во все дни выбранного периода есть проведённый розничный отчёт магазина; продажи соответствующих строк — н/д, а не ноль.");
  if (atomicRows.some((row) => row.windows.some((window) => window.sales.quantity === null || window.previousSales.quantity === null))) warningSet.add("Часть окон 7/14/30 дней не покрыта историей розничных отчётов; сравнение этих окон недоступно.");
  if (atomicRows.some((row) => row.periodSales.cost === null || row.averageCost === null)) warningSet.add("Часть денежных показателей недоступна из-за пропусков снимков или учётных цен. Нулевая, отрицательная или пустая цена не считается бесплатным товаром и не заменяется более старой ценой.");
  if (!source.brands.length || selectedPairs.some((pair) => !pair.brand)) warningSet.add("Справочник брендов не заполнен или привязки отсутствуют. Бренд по названию товара не угадывается.");
  if (selectedPairs.some((pair) => pair.unit.startsWith("Единица не указана"))) warningSet.add("У части SKU нет подтверждённой базовой единицы. Такие SKU не суммируются между собой и не участвуют в перемещениях.");
  if (params.norms.defaults.highStockCost === null) warningSet.add("Денежный порог высокого запаса по умолчанию не задан; правило замораживания средств применимо только к категориям с явно заданным порогом.");
  warningSet.add("Себестоимость продаж — оценка количества по учётной цене на начало дня, а не подтверждённый бухгалтерский COGS; розничная выручка не участвует в коэффициенте.");
  warningSet.add("Исторические статусы заказов не версионируются: учтены текущие незакрытые проведённые заказы, созданные до даты отчёта, за вычетом проведённых к той дате поступлений.");
  warningSet.add("Штрихкоды получены из проведённых чеков до конца периода; это наблюдаемые значения, не полный справочник карточек товара.");
  const optionSort = (values: TurnoverOption[]) => values.sort((a, b) => a.name.localeCompare(b.name, "ru") || a.key.localeCompare(b.key));
  const categoryOptions = new Map<string, string>(source.items.filter((item) => item.folder).map((item) => [item.key, item.name]));
  for (const group of source.groups) categoryOptions.set(group.key, group.name);
  for (const pair of selectedPairs) if (pair.category) categoryOptions.set(pair.category, pair.categoryName);
  categoryOptions.set(UNKNOWN, "Категория не указана");
  const brandOptions = new Map(source.brands.map((brand) => [brand.key, brand.name]));
  for (const pair of selectedPairs) if (pair.brand) brandOptions.set(pair.brand, pair.brandName);
  brandOptions.set(UNKNOWN, "Бренд не указан");
  const stockCosts = atomicRows.map((row) => row.closingCost);
  const costCoverages = atomicRows.map((row) => row.costCoveragePct);
  const sumFrozen = (threshold: "d30" | "d60" | "d90") => atomicRows.length
    ? sumNullable(atomicRows.map((row) => row.stagnantCost[threshold])) : snapshots.has(params.to) ? 0 : null;
  return {
    params, comparison: { from: params.comparisonFrom, to: params.comparisonTo, days: expectedDates.length }, norms: params.norms,
    rows, daily: [...reportDaily.values()].sort((a, b) => a.date.localeCompare(b.date) || a.unit.localeCompare(b.unit, "ru")), transfers,
    summary: {
      rowCount: params.groupBy === "day" ? reportDaily.size : rows.length,
      totalRowCount: atomicRows.length, skuCount: new Set(atomicRows.map((row) => row.sku)).size,
      stockCost: stockCosts.length ? sumNullable(stockCosts) : snapshots.has(params.to) ? 0 : null,
      noSalesCount: atomicRows.filter((row) => row.risks.includes("no-sales")).length,
      overstockCount: atomicRows.filter((row) => row.risks.includes("overstock")).length,
      deficitCount: atomicRows.filter((row) => row.risks.includes("deficit")).length,
      stagnantCount: atomicRows.filter((row) => row.risks.includes("stagnant")).length,
      frozen30Cost: sumFrozen("d30"), frozen60Cost: sumFrozen("d60"), frozen90Cost: sumFrozen("d90"),
      costCoveragePct: !costCoverages.length ? null : costCoverages.some((value) => value === null) ? null
        : costCoverages.reduce<number>((total, value) => total + value!, 0) / costCoverages.length,
      stockCoveragePct: observedDays / expectedDates.length * 100
    },
    options: {
      stores: optionSort([
        ...storeIndex.stores.filter((store) => params.storeScope === "all" || store.retailActive
          || selectedPhysical.some((selected) => selected.key === store.key)).map(({ key, name }) => ({ key, name })),
        ...(selectedPairs.some((pair) => pair.store === UNKNOWN) ? [{ key: UNKNOWN, name: "Магазин не указан" }] : [])
      ]),
      warehouses: physicalWarehouses,
      categories: optionSort([...categoryOptions].map(([key, name]) => ({ key, name }))),
      brands: optionSort([...brandOptions].map(([key, name]) => ({ key, name }))),
      skus: optionSort(source.items.filter((item) => !item.folder).map((item) => ({ key: item.key, name: `${item.name}${item.article ? ` · ${item.article}` : ""}` })))
    },
    coverage: {
      firstStockDate: source.bounds.firstStock, lastStockDate: source.bounds.lastStock,
      firstSalesDate: source.bounds.firstSales, lastSalesDate: source.bounds.lastSales,
      missingStockDates, observedDays, expectedDays: expectedDates.length
    },
    methodology: [
      "Период API [from,to), правая граница исключена; даты — сохранённые календарные даты 1С без пересчёта часового пояса. Текущий остаток означает конец выбранного периода, не сегодняшний остаток.",
      "Снимок на следующую полночь — конец предыдущего рабочего дня. Начало периода — точный снимок from; конец — точный снимок to. Средняя хронологическая берётся по N дневным закрытиям: (первое/2 + внутренние + последнее/2)/(N−1); при N=1 используется единственное закрытие. Один пропуск делает среднее неизвестным. SKU, отсутствующий в существующем сетевом снимке, имеет нулевой остаток.",
      "Продажи и возвраты — строки проведённых неудалённых отчётов о розничных продажах. Возвраты уменьшают количество и розничную сумму один раз, независимо от записанного знака. Перемещения, списания и корректировки не считаются продажами, но уже отражены в остатках.",
      "Среднедневные продажи за произвольный период делятся на max(1,N−1). Оперативные окна делятся на настоящие 7/14/30 календарных дней; предыдущее окно той же длины непосредственно предшествует текущему. Процент при нулевой/отрицательной базе не рассчитывается.",
      "Учётная стоимость: исторический активный регистр точного магазина/SKU/характеристики → документ установки этого магазина → явно общий документ без магазина. Цена выбирается отдельно для каждой даты; другие магазины, будущие цены и закупочные оценки не используются. Последняя неположительная/пустая цена означает отсутствие стоимости, а не возврат к более старой цене.",
      "Для дневных продаж применяется последняя цена не позже начала дня; внутридневная более поздняя цена не попадает в ранние продажи. Для закрытия применяется последняя цена строго до следующей полуночи. Количество × цена — сопоставимая оценка по учётной цене, не фактическая стоимость партий. Выручка показана отдельно в исходных суммах 1С, с содержащимся в них НДС.",
      "Единица — ссылка базовой единицы карточки 1С. Разные ссылки, включая одинаковые подписи, разделены и различимы по суффиксу; неизвестная единица изолирована по SKU. Литры, килограммы и штуки не суммируются.",
      "Магазин — физическая точка: ключи catalog_magaziny с одинаковым точным адресом от «г.» объединяются, остатки и продажи юридических лиц суммируются, а себестоимость каждого исходного ключа применяется до объединения. По умолчанию retail-охват включает только физические магазины с проведёнными розничными отчётами; офисы и отделы доступны явно через storeScope=all. Склад по умолчанию — склад выбранного магазина; удалённые и помеченные «не использовать» склады исключены.",
      "excludeZero удаляет строку только тогда, когда все дневные остатки и продажи равны точному нулю за весь период в выбранном режиме. Пропуски, null и нулевая продажа при ненулевом остатке не считаются нулевой строкой.",
      "Классификация — текущая товарная группа карточки, иначе ближайшая папка номенклатуры; фильтр категории-папки включает потомков, конкретный SKU отбирается по точной ссылке. Нормативы наследуются от родительских папок к ближайшей категории. Историческая классификация и бренды из названий не восстанавливаются.",
      "Дни без движения считаются до последнего дня выбранного периода по последней положительной продаже SKU в конкретном магазине за всю доступную историю; возвраты её не обновляют. При полном отсутствии продаж возраст без движения ограничен первой наблюдаемой положительной доступностью SKU.",
      "Дни запаса = конечный остаток / среднедневные нетто-продажи выбранного горизонта. Цель 30 дней — редактируемое прикладное значение, не норма 1С. Целевое количество = max(спрос × max(целевые дни, известный срок поставки), известный минимум карточки); открытые заказы вычитаются из заказа. Нулевой наблюдаемый спрос не создаёт заказ только ради минимума. Денежный порог и срок поставки неизвестны, пока явно не заданы; минимум карточки используется лишь при подтверждённом сопоставлении магазина с нормативным полем 1С.",
      "Риски и решения консультативны. Падение спроса и стабильность требуют положительных остатков на всех дневных закрытиях обоих окон. Открытые заказы уменьшают рекомендуемый заказ; срок поставки расширяет целевой горизонт, если задан. Дата ожидаемой поставки берётся из документа заказа и может быть просрочена.",
      "Перемещения — тот же SKU и подтверждённая единица между разными магазинами; общий объём ограничен излишком донора и потребностью получателя после открытых заказов. Заказы и остатки не изменяются.",
      "Итоговые денежные значения неизвестны, если неизвестен любой материальный компонент; отсутствующие данные не заменены нулями. Покрытие стоимости строки — доля абсолютного количества известных дневных остатков/продаж с ценой; сводное покрытие — среднее процентов строк, без сложения разных физических единиц.",
      "Счётчики рисков и суммы сводки относятся к SKU/магазинам после фильтров измерений и поиска, до фильтра риска и группировки. Количество видимых строк — после группировки. Групповые коэффициенты пересчитаны из сумм; риски и рекомендации групп — сводка атомарных правил, не новая классификация суммы.",
      "В профиле sample каждая строка — один SKU: дневные количества, денежные остатки и продажи объединены по всем выбранным магазинам и складам; средние и коэффициенты пересчитаны из объединённых значений. Разные SKU и их учётные единицы не смешиваются. rows.daily сохраняется для всех товаров, а общий daily не дублируется.",
      "В аналитических профилях общий daily передаёт дневные значения выбранной совокупности и фильтра риска раздельно по единицам. В группировке по дням основной лист Excel использует только daily; rows пуст, окна 7/14/30 по каждой отдельной дате не формируются. В остальных аналитических группировках подробный rows.daily передаётся при выборе конкретного SKU либо только для строки с точным ключом auditGroup при неизменных применённых фильтрах и группировке."
    ],
    warnings: [...warningSet], generatedAt: new Date().toISOString()
  };
}

export async function getTurnoverOptions(): Promise<TurnoverOptions> {
  const directory = await loadStoreDirectory();
  const index = buildPhysicalStoreIndex(directory.stores, directory.active);
  const retailStores = index.stores.filter((store) => store.retailActive);
  const retailSources = new Set(retailStores.flatMap((store) => store.sourceKeys));
  const rows = await prisma.$queryRaw<{ data: Pick<TurnoverOptions, "warehouses" | "categories" | "brands"> }[]>`
    select jsonb_build_object(
      'warehouses', coalesce((
        select jsonb_agg(jsonb_build_object('key', ref_key, 'name', coalesce(description, ref_key),
          'storeKey', nullif(nullif(max_key, ''), ${EMPTY_GUID})) order by coalesce(description, ref_key))
        from (
          select ref_key, max(description) as description, max(nullif(magazin_key, '')) as max_key
          from ${table("catalog_sklady")} where deletion_mark is not true group by ref_key
        ) w
      ), '[]'::jsonb),
      'categories', coalesce((
        select jsonb_agg(jsonb_build_object('key', ref_key, 'name', coalesce(name, ref_key)) order by coalesce(name, ref_key))
        from (
          select ref_key, max(name) as name from (
            select ref_key, max(description) as name from ${table("catalog_tovarnye_gruppy")} group by ref_key
            union all
            select ref_key, max(description) as name from ${table("catalog_nomenklatura")}
            where is_folder = true group by ref_key
          ) c group by ref_key
        ) c
      ), '[]'::jsonb),
      'brands', coalesce((
        select jsonb_agg(jsonb_build_object('key', ref_key, 'name', coalesce(description, ref_key)) order by coalesce(description, ref_key))
        from (select ref_key, max(description) as description from ${table("catalog_marki")} group by ref_key) b
      ), '[]'::jsonb)
    ) as data
  `;
  if (!rows[0]?.data) throw new Error("Справочники оборачиваемости недоступны");
  const warehouses = rows[0].data.warehouses
    .filter((warehouse) => warehouse.storeKey && retailSources.has(warehouse.storeKey) && isUsableWarehouse(warehouse.name))
    .map((warehouse) => ({ ...warehouse, storeKey: index.bySource.get(warehouse.storeKey!) ?? warehouse.storeKey }))
    .sort((left, right) => left.name.localeCompare(right.name, "ru") || left.key.localeCompare(right.key));
  return {
    stores: retailStores.map(({ key, name }) => ({ key, name })),
    warehouses,
    categories: rows[0].data.categories,
    brands: rows[0].data.brands
  };
}

export async function getTurnoverRow(request: TurnoverRequest): Promise<TurnoverRowDetail> {
  const params = turnoverQuerySchema.parse(request);
  if (!params.auditGroup) throw Object.assign(new Error("Укажите строку отчёта"), { statusCode: 400 });
  let requestedStores = new Set(params.store);
  if (params.groupBy === "sku" && params.profile !== "sample" && params.store.length) {
    const directory = await loadStoreDirectory(params.to);
    const index = buildPhysicalStoreIndex(directory.stores, directory.active);
    requestedStores = new Set(params.store.map((key) => index.bySource.get(key) ?? key));
  }
  let scoped = params;
  if (params.groupBy === "sku") {
    const suffix = `/${params.from}/${params.to}`;
    const [store, sku, extra] = params.auditGroup.endsWith(suffix)
      ? params.auditGroup.slice(0, -suffix.length).split("\u0000") : [];
    if (!store || !sku || extra !== undefined || (params.sku && params.sku !== sku)
      || (params.profile === "sample" ? store !== "sample" : requestedStores.size > 0 && !requestedStores.has(store))) {
      throw Object.assign(new Error("Строка не входит в выбранный отчёт"), { statusCode: 404 });
    }
    // Keep selected stores for transfer counterparts. An explicit SKU also
    // seeds unobserved shops, so consolidated details retain the original scope.
    if (params.profile !== "sample") scoped = { ...params, sku };
  }
  const report = await getTurnoverReport(scoped);
  const row = report.rows.find(candidate => candidate.key === params.auditGroup);
  if (!row) throw Object.assign(new Error("Строка не найдена. Сформируйте отчёт заново."), { statusCode: 404 });
  return { row, generatedAt: report.generatedAt };
}
