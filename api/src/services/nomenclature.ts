import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { canonicalItemCostsCtes } from "../lib/cost-sql.js";
import { prisma } from "../prisma.js";
import type { SalesPeriod } from "./reports.js";

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(tableName: string) {
  return Prisma.raw(`${quoteIdent(config.PGSCHEMA)}.${quoteIdent(tableName)}`);
}

export type NomenclatureParams = {
  period: SalesPeriod;
  from?: Date;
  to?: Date;
};

const DEAD_STOCK_DAYS = 30;
const OVERSTOCK_DAYS = 45;
const FROZEN_TARGET_DAYS = 30;

function dayStart(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function diffDays(from: Date, to: Date) {
  return Math.max(0, Math.floor((dayStart(to).getTime() - dayStart(from).getTime()) / 86_400_000));
}

function getReferenceDate(to: Date) {
  const result = new Date(to);
  result.setUTCDate(result.getUTCDate() - 1);
  return result;
}

function daysSince(reference: Date, date: Date | null) {
  return date ? diffDays(date, reference) : null;
}

export type ItemAnalysis = {
  key: string;
  name: string;
  qty: number;
  revenue: number;
  cost: number | null;
  grossProfit: number | null;
  marginPct: number | null;
  costAvailable: boolean;
  unvaluedRevenue: number;
  abcClass: string;
  xyzClass: string;
  cvPct: number;
  salesVelocity: number;
  daysWithSales: number;
  daysWithoutSales: number;
  firstSaleDate: string | null;
  lastSaleDate: string | null;
  ageCategory: "new" | "regular" | "old";
  revenuePct: number;
};

export type ExitProductReason = "no_sales" | "dead_stock" | "slow_moving" | "overstock";

export type ExitProduct = {
  key: string;
  name: string;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  warehouseCount: number;
  recentSoldQty: number;
  recentRevenue: number;
  dailySalesRate: number;
  daysOfStock: number | null;
  stockCost: number | null;
  frozenStockCost: number | null;
  costAvailable: boolean;
  lastSaleDate: string | null;
  lastPurchaseDate: string | null;
  stockPeriod: string | null;
  daysSinceLastSale: number | null;
  daysSinceLastPurchase: number | null;
  reason: ExitProductReason;
};

type NomenclatureRow = {
  nomenklatura_key: string;
  item_name: string | null;
  total_qty: number;
  total_revenue: number;
  unit_cost: number | null;
  days_with_sales: number;
  first_sale_date: Date | null;
  last_sale_date: Date | null;
  avg_daily_qty: number;
  stddev_daily_qty: number;
  cv_pct: number;
  revenue_pct: number;
  abc_class: string;
  xyz_class: string;
};

type ExitProductRow = {
  nomenklatura_key: string;
  item_name: string | null;
  stock_qty: number;
  reserved_qty: number;
  warehouse_count: number;
  recent_sold_qty: number;
  recent_revenue: number;
  last_sale_date: Date | null;
  last_purchase_date: Date | null;
  unit_cost: number | null;
  stock_period: Date | null;
};

function exitReason(
  soldQty: number,
  daysOfStock: number | null,
  daysSinceLastSale: number | null
): ExitProductReason | null {
  if (soldQty <= 0 && (daysSinceLastSale === null || daysSinceLastSale > DEAD_STOCK_DAYS)) {
    return "dead_stock";
  }
  if (soldQty <= 0) {
    return "no_sales";
  }
  if (daysOfStock !== null && daysOfStock > OVERSTOCK_DAYS) {
    return "overstock";
  }
  if (daysOfStock !== null && daysOfStock > FROZEN_TARGET_DAYS) {
    return "slow_moving";
  }
  return null;
}

export async function getNomenclatureReport(params: NomenclatureParams) {
  const reports = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const saleLines = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_tovary");
  const returnLines = qualifiedTable(
    "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary"
  );
  const nomenclature = qualifiedTable("catalog_nomenklatura");
  const balances = qualifiedTable("accumulation_register_tovary_na_skladah_balance");
  const receipts = qualifiedTable("document_postuplenie_tovarov");
  const receiptLines = qualifiedTable("document_postuplenie_tovarov_tovary");

  const to = params.to ?? new Date();
  const from = params.from ?? new Date(to.getTime() - 28 * 86_400_000);
  const totalDays = Math.max(1, diffDays(from, to));

  const rowsQuery = prisma.$queryRaw<NomenclatureRow[]>`
    with
    ${canonicalItemCostsCtes(to)},
    movements as (
      select date_trunc('day', r.date) as sale_day, l.nomenklatura_key,
        coalesce(l.kolichestvo, 0)::float8 as qty,
        coalesce(l.summa, 0)::float8 as revenue
      from ${reports} r
      join ${saleLines} l on l."_parent_ref_key" = r.ref_key
      where r.date >= ${from} and r.date < ${to}
        and r.deletion_mark is not true and r.posted = true
        and l.nomenklatura_key is not null
      union all
      select date_trunc('day', r.date) as sale_day, l.nomenklatura_key,
        -coalesce(l.kolichestvo, 0)::float8 as qty,
        -coalesce(l.summa, 0)::float8 as revenue
      from ${reports} r
      join ${returnLines} l on l."_parent_ref_key" = r.ref_key
      where r.date >= ${from} and r.date < ${to}
        and r.deletion_mark is not true and r.posted = true
        and l.nomenklatura_key is not null
    ),
    daily_sales as (
      select sale_day, nomenklatura_key, sum(qty)::float8 as qty, sum(revenue)::float8 as revenue
      from movements
      group by sale_day, nomenklatura_key
    ),
    item_keys as (
      select distinct nomenklatura_key from daily_sales
    ),
    calendar_days as (
      select generate_series(${from}::date, (${to}::date - 1), interval '1 day') as sale_day
    ),
    daily_grid as (
      select k.nomenklatura_key, d.sale_day,
        coalesce(s.qty, 0)::float8 as qty,
        coalesce(s.revenue, 0)::float8 as revenue
      from item_keys k
      cross join calendar_days d
      left join daily_sales s
        on s.nomenklatura_key = k.nomenklatura_key and s.sale_day = d.sale_day
    ),
    lifetime_sales as (
      select l.nomenklatura_key, min(r.date) as first_sale_date, max(r.date) as last_sale_date
      from ${reports} r
      join ${saleLines} l on l."_parent_ref_key" = r.ref_key
      where r.deletion_mark is not true and r.posted = true
        and l.nomenklatura_key is not null and coalesce(l.kolichestvo, 0) > 0
      group by l.nomenklatura_key
    ),
    item_stats as (
      select
        g.nomenklatura_key,
        sum(g.qty)::float8 as total_qty,
        sum(g.revenue)::float8 as total_revenue,
        count(*) filter (where g.qty > 0)::int as days_with_sales,
        avg(g.qty)::float8 as avg_daily_qty,
        coalesce(stddev_samp(g.qty), 0)::float8 as stddev_daily_qty
      from daily_grid g
      group by g.nomenklatura_key
    ),
    valued as (
      select s.*, coalesce(gc.unit_cost, pc.unit_cost) as unit_cost,
        greatest(s.total_revenue, 0)::float8 as abc_revenue,
        case when s.avg_daily_qty > 0
          then (s.stddev_daily_qty / s.avg_daily_qty * 100)::float8
          else 999::float8
        end as cv_pct
      from item_stats s
      left join latest_global_costs gc on gc.nomenklatura_key = s.nomenklatura_key
      left join purchase_costs_90d pc on pc.nomenklatura_key = s.nomenklatura_key
    ),
    ranked as (
      select v.*,
        case when sum(v.abc_revenue) over () > 0
          then v.abc_revenue / sum(v.abc_revenue) over () * 100
          else 0
        end::float8 as revenue_pct,
        case when sum(v.abc_revenue) over () > 0
          then sum(v.abc_revenue) over (
            order by v.abc_revenue desc, v.nomenklatura_key
            rows between unbounded preceding and current row
          ) / sum(v.abc_revenue) over () * 100
          else 100
        end::float8 as cumulative_pct
      from valued v
    ),
    catalog_names as (
      select ref_key, max(description) as description from ${nomenclature} group by ref_key
    )
    select
      r.nomenklatura_key,
      n.description as item_name,
      r.total_qty,
      r.total_revenue,
      r.unit_cost,
      r.days_with_sales,
      l.first_sale_date,
      l.last_sale_date,
      r.avg_daily_qty,
      r.stddev_daily_qty,
      r.cv_pct,
      r.revenue_pct,
      case
        when r.cumulative_pct <= 80 then 'A'
        when r.cumulative_pct <= 95 then 'B'
        else 'C'
      end as abc_class,
      case
        when r.cv_pct <= 10 then 'X'
        when r.cv_pct <= 25 then 'Y'
        else 'Z'
      end as xyz_class
    from ranked r
    left join lifetime_sales l on l.nomenklatura_key = r.nomenklatura_key
    left join catalog_names n on n.ref_key = r.nomenklatura_key
    order by r.abc_revenue desc, r.nomenklatura_key
  `;

  const exitRowsQuery = prisma.$queryRaw<ExitProductRow[]>`
    with
    ${canonicalItemCostsCtes(to)},
    balance_snapshot as (
      select max(balance_period) as snapshot_at
      from ${balances}
      where balance_period is not null and balance_period < ${to}
    ),
    latest_balance_rows as (
      select
        b.nomenklatura_key, b.sklad_key, b.balance_period,
        coalesce(b.kolichestvo_balance, 0)::float8 as stock_qty,
        coalesce(b.rezerv_balance, 0)::float8 as reserved_qty
      from ${balances} b
      join balance_snapshot s on s.snapshot_at = b.balance_period
    ),
    balance_stock as (
      select nomenklatura_key,
        sum(greatest(stock_qty, 0))::float8 as stock_qty,
        sum(greatest(reserved_qty, 0))::float8 as reserved_qty,
        count(distinct sklad_key)::int as warehouse_count,
        max(balance_period) as stock_period
      from latest_balance_rows
      where nomenklatura_key is not null
      group by nomenklatura_key
    ),
    period_movements as (
      select l.nomenklatura_key,
        coalesce(l.kolichestvo, 0)::float8 as qty,
        coalesce(l.summa, 0)::float8 as revenue
      from ${reports} r join ${saleLines} l on l."_parent_ref_key" = r.ref_key
      where r.date >= ${from} and r.date < ${to}
        and r.deletion_mark is not true and r.posted = true
        and l.nomenklatura_key is not null
      union all
      select l.nomenklatura_key,
        -coalesce(l.kolichestvo, 0)::float8 as qty,
        -coalesce(l.summa, 0)::float8 as revenue
      from ${reports} r join ${returnLines} l on l."_parent_ref_key" = r.ref_key
      where r.date >= ${from} and r.date < ${to}
        and r.deletion_mark is not true and r.posted = true
        and l.nomenklatura_key is not null
    ),
    period_sales as (
      select nomenklatura_key, sum(qty)::float8 as qty, sum(revenue)::float8 as revenue
      from period_movements group by nomenklatura_key
    ),
    lifetime_sales as (
      select l.nomenklatura_key, max(r.date) as last_sale_date
      from ${reports} r join ${saleLines} l on l."_parent_ref_key" = r.ref_key
      where r.deletion_mark is not true and r.posted = true
        and l.nomenklatura_key is not null and coalesce(l.kolichestvo, 0) > 0
      group by l.nomenklatura_key
    ),
    purchases as (
      select l.nomenklatura_key, max(d.date) as last_purchase_date
      from ${receipts} d join ${receiptLines} l on l."_parent_ref_key" = d.ref_key
      where d.deletion_mark is not true and d.posted = true
        and l.nomenklatura_key is not null and coalesce(l.kolichestvo, 0) > 0
      group by l.nomenklatura_key
    ),
    catalog_names as (
      select ref_key, max(description) as description from ${nomenclature} group by ref_key
    )
    select
      b.nomenklatura_key,
      n.description as item_name,
      b.stock_qty,
      b.reserved_qty,
      b.warehouse_count,
      coalesce(s.qty, 0)::float8 as recent_sold_qty,
      coalesce(s.revenue, 0)::float8 as recent_revenue,
      l.last_sale_date,
      p.last_purchase_date,
      coalesce(gc.unit_cost, pc.unit_cost) as unit_cost,
      b.stock_period
    from balance_stock b
    left join period_sales s on s.nomenklatura_key = b.nomenklatura_key
    left join lifetime_sales l on l.nomenklatura_key = b.nomenklatura_key
    left join purchases p on p.nomenklatura_key = b.nomenklatura_key
    left join latest_global_costs gc on gc.nomenklatura_key = b.nomenklatura_key
    left join purchase_costs_90d pc on pc.nomenklatura_key = b.nomenklatura_key
    left join catalog_names n on n.ref_key = b.nomenklatura_key
    where b.stock_qty > 0
  `;

  const [rows, exitRows] = await Promise.all([rowsQuery, exitRowsQuery]);
  const referenceDate = getReferenceDate(to);

  const items: ItemAnalysis[] = rows.map((row) => {
    const qty = Number(row.total_qty);
    const revenue = Number(row.total_revenue);
    const unitCost = row.unit_cost === null ? null : Number(row.unit_cost);
    const cost = unitCost === null ? null : qty * unitCost;
    const grossProfit = cost === null ? null : revenue - cost;
    const firstSaleDate = row.first_sale_date;
    const ageDays = firstSaleDate ? daysSince(referenceDate, firstSaleDate) : null;
    const ageCategory = ageDays === null || ageDays < 30 ? "new" : ageDays > 180 ? "old" : "regular";

    return {
      key: row.nomenklatura_key,
      name: row.item_name ?? row.nomenklatura_key,
      qty,
      revenue,
      cost,
      grossProfit,
      marginPct: grossProfit !== null && revenue > 0 ? (grossProfit / revenue) * 100 : null,
      costAvailable: unitCost !== null,
      unvaluedRevenue: unitCost === null ? Math.abs(revenue) : 0,
      abcClass: row.abc_class,
      xyzClass: row.xyz_class,
      cvPct: Number(row.cv_pct),
      salesVelocity: qty / totalDays,
      daysWithSales: Number(row.days_with_sales),
      daysWithoutSales: Math.max(0, totalDays - Number(row.days_with_sales)),
      firstSaleDate: firstSaleDate?.toISOString() ?? null,
      lastSaleDate: row.last_sale_date?.toISOString() ?? null,
      ageCategory,
      revenuePct: Number(row.revenue_pct)
    };
  });

  const exitItems: ExitProduct[] = exitRows
    .map((row) => {
      const stockQty = Number(row.stock_qty);
      const reservedQty = Number(row.reserved_qty);
      const recentSoldQty = Number(row.recent_sold_qty);
      const dailySalesRate = Math.max(recentSoldQty, 0) / totalDays;
      const daysOfStock = dailySalesRate > 0 ? stockQty / dailySalesRate : null;
      const daysSinceLastSale = daysSince(referenceDate, row.last_sale_date);
      const reason = exitReason(recentSoldQty, daysOfStock, daysSinceLastSale);
      if (!reason) {
        return null;
      }
      const unitCost = row.unit_cost === null ? null : Number(row.unit_cost);
      const frozenQty = Math.max(stockQty - dailySalesRate * FROZEN_TARGET_DAYS, 0);
      return {
        key: row.nomenklatura_key,
        name: row.item_name ?? row.nomenklatura_key,
        stockQty,
        reservedQty,
        availableQty: Math.max(stockQty - reservedQty, 0),
        warehouseCount: Number(row.warehouse_count),
        recentSoldQty,
        recentRevenue: Number(row.recent_revenue),
        dailySalesRate,
        daysOfStock,
        stockCost: unitCost === null ? null : stockQty * unitCost,
        frozenStockCost: unitCost === null ? null : frozenQty * unitCost,
        costAvailable: unitCost !== null,
        lastSaleDate: row.last_sale_date?.toISOString() ?? null,
        lastPurchaseDate: row.last_purchase_date?.toISOString() ?? null,
        stockPeriod: row.stock_period?.toISOString() ?? null,
        daysSinceLastSale,
        daysSinceLastPurchase: daysSince(referenceDate, row.last_purchase_date),
        reason
      };
    })
    .filter((item): item is ExitProduct => item !== null)
    .sort(
      (left, right) =>
        (right.frozenStockCost ?? -1) - (left.frozenStockCost ?? -1) ||
        (right.daysOfStock ?? Number.POSITIVE_INFINITY) -
          (left.daysOfStock ?? Number.POSITIVE_INFINITY)
    );

  const valuedItems = items.filter((item) => item.costAvailable);
  const valuedExitItems = exitItems.filter((item) => item.costAvailable);

  return {
    period: params.period,
    items,
    exitItems,
    exitSummary: {
      totalItems: exitItems.length,
      stockQty: exitItems.reduce((sum, item) => sum + item.stockQty, 0),
      stockCost: valuedExitItems.reduce((sum, item) => sum + (item.stockCost ?? 0), 0),
      frozenStockCost: valuedExitItems.reduce(
        (sum, item) => sum + (item.frozenStockCost ?? 0),
        0
      ),
      unvaluedQty: exitItems
        .filter((item) => !item.costAvailable)
        .reduce((sum, item) => sum + item.stockQty, 0),
      costCoveragePct:
        exitItems.length > 0 ? (valuedExitItems.length / exitItems.length) * 100 : 100,
      noSalesCount: exitItems.filter((item) => item.reason === "no_sales").length,
      deadStockCount: exitItems.filter((item) => item.reason === "dead_stock").length,
      slowMovingCount: exitItems.filter((item) => item.reason === "slow_moving").length,
      overstockCount: exitItems.filter((item) => item.reason === "overstock").length,
      stockPeriod: exitItems.reduce<string | null>(
        (latest, item) => (!latest || (item.stockPeriod && item.stockPeriod > latest) ? item.stockPeriod : latest),
        null
      )
    },
    totalDays,
    costCoveragePct: items.length > 0 ? (valuedItems.length / items.length) * 100 : 100,
    unvaluedRevenue: items.reduce((sum, item) => sum + item.unvaluedRevenue, 0),
    methodology: {
      returnsIncluded: true,
      calendarDaysIncluded: true,
      frozenStockTargetDays: FROZEN_TARGET_DAYS,
      costHierarchy: "Себестоимость магазина → установка себестоимости → закупка за 90 дней"
    }
  };
}
