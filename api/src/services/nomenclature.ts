import { Prisma } from "@prisma/client";
import { config } from "../config.js";
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

const DEAD_STOCK_DAYS = 60;
const OLD_STOCK_DAYS = 90;
const OVERSTOCK_DAYS = 90;
const SLOW_DAILY_RATE = 0.1;
const WEAK_DAILY_RATE = 0.2;

// --------------- Shared CTEs ---------------

function dailySalesCte(params: NomenclatureParams) {
  const reportsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const itemsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_tovary");

  const filters: Prisma.Sql[] = [
    Prisma.sql`r.date is not null`,
    Prisma.sql`coalesce(r.deletion_mark, false) = false`,
    Prisma.sql`coalesce(r.posted, false) = true`,
    Prisma.sql`coalesce(r.summa_dokumenta, 0) > 0`
  ];

  if (params.from) {
    filters.push(Prisma.sql`r.date >= ${params.from}`);
  }

  if (params.to) {
    filters.push(Prisma.sql`r.date < ${params.to}`);
  }

  return Prisma.sql`
    daily_sales as (
      select
        date_trunc('day', r.date) as sale_day,
        ri.nomenklatura_key,
        coalesce(sum(ri.kolichestvo), 0)::float8 as day_qty,
        coalesce(sum(ri.summa), 0)::float8 as day_revenue
      from ${itemsTable} ri
      join ${reportsTable} r on r.ref_key = ri."_parent_ref_key"
      where ${Prisma.join(filters, " and ")}
        and ri.nomenklatura_key is not null
        and coalesce(ri.kolichestvo, 0) > 0
      group by date_trunc('day', r.date), ri.nomenklatura_key
    )
  `;
}

function itemCostsCte() {
  const postuplenieTable = qualifiedTable("document_postuplenie_tovarov");
  const postuplenieTovaryTable = qualifiedTable("document_postuplenie_tovarov_tovary");

  return Prisma.sql`
    item_costs as (
      select
        pt.nomenklatura_key,
        avg(pt.tsena)::float8 as avg_purchase_price
      from ${postuplenieTovaryTable} pt
      join ${postuplenieTable} p on p.ref_key = pt."_parent_ref_key"
      where coalesce(p.deletion_mark, false) = false
        and coalesce(p.posted, false) = true
        and pt.nomenklatura_key is not null
        and pt.tsena is not null
        and pt.tsena > 0
      group by pt.nomenklatura_key
    )
  `;
}

// --------------- Main query result row ---------------

type NomenclatureRow = {
  nomenklatura_key: string;
  item_name: string | null;
  total_qty: number;
  total_revenue: number;
  total_cost: number;
  gross_profit: number;
  margin_pct: number;
  days_with_sales: number;
  days_without_sales: number;
  first_sale_date: Date | null;
  last_sale_date: Date | null;
  avg_daily_qty: number;
  stddev_daily_qty: number;
  cv_pct: number;
  revenue_pct: number;
  cumulative_pct: number;
  abc_class: string;
  xyz_class: string;
  total_days_in_period: number;
};

type ExitProductRow = {
  nomenklatura_key: string;
  item_name: string | null;
  stock_qty: number;
  reserved_qty: number;
  warehouse_count: number;
  recent_sold_qty: number;
  recent_revenue: number;
  recent_days_active: number;
  last_sale_in_period: Date | null;
  last_sale_date: Date | null;
  last_purchase_date: Date | null;
  avg_purchase_price: number;
  stock_period: Date | null;
  period_start: Date | null;
  period_end: Date | null;
};

export type ItemAnalysis = {
  key: string;
  name: string;
  qty: number;
  revenue: number;
  cost: number;
  grossProfit: number;
  marginPct: number;
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

export type ExitProductReason =
  | "no_sales"
  | "dead_stock"
  | "slow_moving"
  | "overstock"
  | "old_stock";

export type ExitProduct = {
  key: string;
  name: string;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  warehouseCount: number;
  recentSoldQty: number;
  recentRevenue: number;
  recentDaysActive: number;
  dailySalesRate: number;
  daysOfStock: number | null;
  stockCost: number;
  lastSaleDate: string | null;
  lastSaleInPeriod: string | null;
  lastPurchaseDate: string | null;
  stockPeriod: string | null;
  daysSinceLastSale: number | null;
  daysSinceLastPurchase: number | null;
  reason: ExitProductReason;
  riskScore: number;
};

function dayStart(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function diffDays(from: Date, to: Date) {
  const fromStart = dayStart(from).getTime();
  const toStart = dayStart(to).getTime();
  return Math.max(0, Math.floor((toStart - fromStart) / (1000 * 60 * 60 * 24)));
}

function getReferenceDate(params: NomenclatureParams) {
  if (!params.to) {
    return new Date();
  }

  const date = new Date(params.to);
  date.setUTCDate(date.getUTCDate() - 1);
  return date;
}

function getAnalysisDays(
  params: NomenclatureParams,
  periodStart: Date | null,
  periodEnd: Date | null
) {
  if (params.from && params.to) {
    return Math.max(1, diffDays(params.from, params.to));
  }

  if (params.from) {
    return Math.max(1, diffDays(params.from, getReferenceDate(params)) + 1);
  }

  if (params.to && periodStart) {
    return Math.max(1, diffDays(periodStart, params.to));
  }

  if (periodStart && periodEnd) {
    return Math.max(1, diffDays(periodStart, periodEnd) + 1);
  }

  return 1;
}

function getDaysSince(referenceDate: Date, date: Date | null) {
  return date ? diffDays(date, referenceDate) : null;
}

function pickExitReason({
  recentSoldQty,
  dailySalesRate,
  daysOfStock,
  daysSinceLastSale,
  daysSinceLastPurchase
}: {
  recentSoldQty: number;
  dailySalesRate: number;
  daysOfStock: number | null;
  daysSinceLastSale: number | null;
  daysSinceLastPurchase: number | null;
}): ExitProductReason | null {
  if (recentSoldQty <= 0 && daysSinceLastSale !== null && daysSinceLastSale > DEAD_STOCK_DAYS) {
    return "dead_stock";
  }

  if (recentSoldQty <= 0) {
    return "no_sales";
  }

  if (daysOfStock !== null && daysOfStock > OVERSTOCK_DAYS) {
    return "overstock";
  }

  if (dailySalesRate > 0 && dailySalesRate < SLOW_DAILY_RATE) {
    return "slow_moving";
  }

  if (
    daysSinceLastPurchase !== null &&
    daysSinceLastPurchase > OLD_STOCK_DAYS &&
    dailySalesRate < WEAK_DAILY_RATE
  ) {
    return "old_stock";
  }

  return null;
}

function getRiskScore({
  reason,
  stockCost,
  recentSoldQty,
  daysOfStock,
  daysSinceLastSale,
  daysSinceLastPurchase
}: {
  reason: ExitProductReason;
  stockCost: number;
  recentSoldQty: number;
  daysOfStock: number | null;
  daysSinceLastSale: number | null;
  daysSinceLastPurchase: number | null;
}) {
  const reasonScore: Record<ExitProductReason, number> = {
    dead_stock: 100,
    no_sales: 85,
    overstock: 70,
    slow_moving: 55,
    old_stock: 45
  };

  return (
    reasonScore[reason] +
    Math.min(daysSinceLastSale ?? 0, 180) / 6 +
    Math.min(daysSinceLastPurchase ?? 0, 180) / 12 +
    Math.min(daysOfStock ?? 0, 180) / 9 +
    Math.min(stockCost / 100000, 20) +
    (recentSoldQty <= 0 ? 10 : 0)
  );
}

// --------------- Public API ---------------

export async function getNomenclatureReport(
  params: NomenclatureParams
): Promise<{
  period: SalesPeriod;
  items: ItemAnalysis[];
  exitItems: ExitProduct[];
  exitSummary: {
    totalItems: number;
    stockQty: number;
    stockCost: number;
    noSalesCount: number;
    deadStockCount: number;
    slowMovingCount: number;
    overstockCount: number;
    oldStockCount: number;
    stockPeriod: string | null;
  };
  totalDays: number;
}> {
  const nomenklaturaTable = qualifiedTable("catalog_nomenklatura");
  const balanceTable = qualifiedTable("accumulation_register_tovary_na_skladah_balance");
  const reportsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const reportItemsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_tovary");
  const postuplenieTable = qualifiedTable("document_postuplenie_tovarov");
  const postuplenieItemsTable = qualifiedTable("document_postuplenie_tovarov_tovary");

  const reportFilters: Prisma.Sql[] = [
    Prisma.sql`r.date is not null`,
    Prisma.sql`coalesce(r.deletion_mark, false) = false`,
    Prisma.sql`coalesce(r.posted, false) = true`,
    Prisma.sql`coalesce(r.summa_dokumenta, 0) > 0`
  ];

  if (params.from) {
    reportFilters.push(Prisma.sql`r.date >= ${params.from}`);
  }

  if (params.to) {
    reportFilters.push(Prisma.sql`r.date < ${params.to}`);
  }

  const balanceFilters: Prisma.Sql[] = [Prisma.sql`b.balance_period is not null`];

  if (params.from) {
    balanceFilters.push(Prisma.sql`b.balance_period >= ${params.from}`);
  }

  if (params.to) {
    balanceFilters.push(Prisma.sql`b.balance_period < ${params.to}`);
  }

  const rows = await prisma.$queryRaw<NomenclatureRow[]>`
    with
    ${dailySalesCte(params)},
    ${itemCostsCte()},
    item_stats as (
      select
        ds.nomenklatura_key,
        coalesce(sum(ds.day_qty), 0)::float8 as total_qty,
        coalesce(sum(ds.day_revenue), 0)::float8 as total_revenue,
        count(*)::int as days_with_sales,
        min(ds.sale_day) as first_sale_date,
        max(ds.sale_day) as last_sale_date,
        avg(ds.day_qty)::float8 as avg_daily_qty,
        coalesce(stddev_samp(ds.day_qty), 0)::float8 as stddev_daily_qty
      from daily_sales ds
      group by ds.nomenklatura_key
    ),
    period_meta as (
      select
        (select count(distinct sale_day) from daily_sales) as total_days
    ),
    item_with_cost as (
      select
        ist.nomenklatura_key,
        ist.total_qty,
        ist.total_revenue,
        coalesce(ist.total_qty * coalesce(ic.avg_purchase_price, 0), 0)::float8 as total_cost,
        ist.days_with_sales,
        (select total_days from period_meta) - ist.days_with_sales as days_without_sales,
        ist.first_sale_date,
        ist.last_sale_date,
        ist.avg_daily_qty,
        ist.stddev_daily_qty,
        case when ist.avg_daily_qty > 0
          then (ist.stddev_daily_qty / ist.avg_daily_qty * 100)::float8
          else 999
        end as cv_pct
      from item_stats ist
      left join item_costs ic on ic.nomenklatura_key = ist.nomenklatura_key
    ),
    total_revenue_sum as (
      select coalesce(sum(total_revenue), 0)::float8 as grand_revenue
      from item_with_cost
    ),
    ranked as (
      select
        iwc.*,
        (iwc.total_revenue - iwc.total_cost)::float8 as gross_profit,
        case when iwc.total_revenue > 0
          then ((iwc.total_revenue - iwc.total_cost) / iwc.total_revenue * 100)::float8
          else 0
        end as margin_pct,
        case when (select grand_revenue from total_revenue_sum) > 0
          then (iwc.total_revenue / (select grand_revenue from total_revenue_sum) * 100)::float8
          else 0
        end as revenue_pct,
        sum(iwc.total_revenue) over (
          order by iwc.total_revenue desc
          rows between unbounded preceding and current row
        )::float8 / nullif((select grand_revenue from total_revenue_sum), 0) * 100 as cumulative_pct,
        (select total_days from period_meta) as total_days_in_period
      from item_with_cost iwc
    )
    select
      r.nomenklatura_key,
      max(n.description) as item_name,
      r.total_qty,
      r.total_revenue,
      r.total_cost,
      r.gross_profit,
      r.margin_pct,
      r.days_with_sales,
      r.days_without_sales,
      r.first_sale_date,
      r.last_sale_date,
      r.avg_daily_qty,
      r.stddev_daily_qty,
      r.cv_pct,
      r.revenue_pct,
      r.cumulative_pct,
      case
        when r.cumulative_pct <= 80 then 'A'
        when r.cumulative_pct <= 95 then 'B'
        else 'C'
      end as abc_class,
      case
        when r.cv_pct <= 10 then 'X'
        when r.cv_pct <= 25 then 'Y'
        else 'Z'
      end as xyz_class,
      r.total_days_in_period
    from ranked r
    left join ${nomenklaturaTable} n on n.ref_key = r.nomenklatura_key
    group by
      r.nomenklatura_key, r.total_qty, r.total_revenue, r.total_cost,
      r.gross_profit, r.margin_pct, r.days_with_sales, r.days_without_sales,
      r.first_sale_date, r.last_sale_date, r.avg_daily_qty, r.stddev_daily_qty,
      r.cv_pct, r.revenue_pct, r.cumulative_pct, r.total_days_in_period
    order by r.total_revenue desc
  `;

  const exitRows = await prisma.$queryRaw<ExitProductRow[]>`
    with
    latest_balance_period as (
      select max(b.balance_period) as balance_period
      from ${balanceTable} b
      where ${Prisma.join(balanceFilters, " and ")}
    ),
    balance_stock as (
      select
        b.nomenklatura_key,
        coalesce(sum(b.kolichestvo_balance), 0)::float8 as stock_qty,
        coalesce(sum(b.rezerv_balance), 0)::float8 as reserved_qty,
        count(distinct b.sklad_key)::int as warehouse_count,
        max(b.balance_period) as stock_period
      from ${balanceTable} b
      join latest_balance_period lbp on lbp.balance_period = b.balance_period
      where b.nomenklatura_key is not null
      group by b.nomenklatura_key
    ),
    sales_in_period as (
      select
        ri.nomenklatura_key,
        coalesce(sum(ri.kolichestvo), 0)::float8 as recent_sold_qty,
        coalesce(sum(ri.summa), 0)::float8 as recent_revenue,
        count(distinct date_trunc('day', r.date))::int as recent_days_active,
        max(r.date) as last_sale_in_period
      from ${reportItemsTable} ri
      join ${reportsTable} r on r.ref_key = ri."_parent_ref_key"
      where ${Prisma.join(reportFilters, " and ")}
        and ri.nomenklatura_key is not null
        and coalesce(ri.kolichestvo, 0) > 0
      group by ri.nomenklatura_key
    ),
    sales_bounds as (
      select min(r.date) as period_start, max(r.date) as period_end
      from ${reportItemsTable} ri
      join ${reportsTable} r on r.ref_key = ri."_parent_ref_key"
      where ${Prisma.join(reportFilters, " and ")}
        and ri.nomenklatura_key is not null
        and coalesce(ri.kolichestvo, 0) > 0
    ),
    last_sales as (
      select
        ri.nomenklatura_key,
        max(r.date) as last_sale_date
      from ${reportItemsTable} ri
      join ${reportsTable} r on r.ref_key = ri."_parent_ref_key"
      where r.date is not null
        and coalesce(r.deletion_mark, false) = false
        and coalesce(r.posted, false) = true
        and ri.nomenklatura_key is not null
        and coalesce(ri.kolichestvo, 0) > 0
      group by ri.nomenklatura_key
    ),
    purchases as (
      select
        pt.nomenklatura_key,
        max(p.date) as last_purchase_date,
        avg(pt.tsena)::float8 as avg_purchase_price
      from ${postuplenieItemsTable} pt
      join ${postuplenieTable} p on p.ref_key = pt."_parent_ref_key"
      where p.date is not null
        and coalesce(p.deletion_mark, false) = false
        and coalesce(p.posted, false) = true
        and pt.nomenklatura_key is not null
        and pt.tsena is not null
        and pt.tsena > 0
      group by pt.nomenklatura_key
    )
    select
      bs.nomenklatura_key,
      max(n.description) as item_name,
      greatest(bs.stock_qty, 0)::float8 as stock_qty,
      greatest(bs.reserved_qty, 0)::float8 as reserved_qty,
      bs.warehouse_count,
      coalesce(sp.recent_sold_qty, 0)::float8 as recent_sold_qty,
      coalesce(sp.recent_revenue, 0)::float8 as recent_revenue,
      coalesce(sp.recent_days_active, 0)::int as recent_days_active,
      sp.last_sale_in_period,
      ls.last_sale_date,
      p.last_purchase_date,
      coalesce(p.avg_purchase_price, 0)::float8 as avg_purchase_price,
      bs.stock_period,
      sb.period_start,
      sb.period_end
    from balance_stock bs
    cross join sales_bounds sb
    left join sales_in_period sp on sp.nomenklatura_key = bs.nomenklatura_key
    left join last_sales ls on ls.nomenklatura_key = bs.nomenklatura_key
    left join purchases p on p.nomenklatura_key = bs.nomenklatura_key
    left join ${nomenklaturaTable} n on n.ref_key = bs.nomenklatura_key
    where bs.stock_qty > 0
    group by
      bs.nomenklatura_key, bs.stock_qty, bs.reserved_qty, bs.warehouse_count,
      sp.recent_sold_qty, sp.recent_revenue, sp.recent_days_active, sp.last_sale_in_period,
      ls.last_sale_date, p.last_purchase_date, p.avg_purchase_price,
      bs.stock_period, sb.period_start, sb.period_end
  `;

  const totalDays = rows.length > 0 ? Number(rows[0].total_days_in_period) : 0;

  const items: ItemAnalysis[] = rows.map((row) => {
    const velocity =
      totalDays > 0 ? Number(row.total_qty) / totalDays : 0;

    // Age category: new (< 30 days since first sale), old (> 180 days), regular
    let ageCategory: "new" | "regular" | "old" = "regular";
    if (row.first_sale_date) {
      const daysSinceFirstSale =
        (Date.now() - new Date(row.first_sale_date).getTime()) /
        (1000 * 60 * 60 * 24);
      if (daysSinceFirstSale < 30) {
        ageCategory = "new";
      } else if (daysSinceFirstSale > 180) {
        ageCategory = "old";
      }
    }

    return {
      key: row.nomenklatura_key,
      name: row.item_name ?? row.nomenklatura_key,
      qty: Number(row.total_qty),
      revenue: Number(row.total_revenue),
      cost: Number(row.total_cost),
      grossProfit: Number(row.gross_profit),
      marginPct: Number(row.margin_pct),
      abcClass: row.abc_class,
      xyzClass: row.xyz_class,
      cvPct: Number(row.cv_pct),
      salesVelocity: velocity,
      daysWithSales: Number(row.days_with_sales),
      daysWithoutSales: Number(row.days_without_sales),
      firstSaleDate: row.first_sale_date?.toISOString() ?? null,
      lastSaleDate: row.last_sale_date?.toISOString() ?? null,
      ageCategory,
      revenuePct: Number(row.revenue_pct)
    };
  });

  const referenceDate = getReferenceDate(params);
  const exitItems: ExitProduct[] = exitRows
    .map((row) => {
      const stockQty = Number(row.stock_qty);
      const reservedQty = Number(row.reserved_qty);
      const recentSoldQty = Number(row.recent_sold_qty);
      const analysisDays = getAnalysisDays(params, row.period_start, row.period_end);
      const dailySalesRate = analysisDays > 0 ? recentSoldQty / analysisDays : 0;
      const daysOfStock = dailySalesRate > 0 ? stockQty / dailySalesRate : null;
      const daysSinceLastSale = getDaysSince(referenceDate, row.last_sale_date);
      const daysSinceLastPurchase = getDaysSince(referenceDate, row.last_purchase_date);
      const stockCost = stockQty * Number(row.avg_purchase_price);
      const reason = pickExitReason({
        recentSoldQty,
        dailySalesRate,
        daysOfStock,
        daysSinceLastSale,
        daysSinceLastPurchase
      });

      if (!reason) {
        return null;
      }

      return {
        key: row.nomenklatura_key,
        name: row.item_name ?? row.nomenklatura_key,
        stockQty,
        reservedQty,
        availableQty: Math.max(stockQty - reservedQty, 0),
        warehouseCount: Number(row.warehouse_count),
        recentSoldQty,
        recentRevenue: Number(row.recent_revenue),
        recentDaysActive: Number(row.recent_days_active),
        dailySalesRate,
        daysOfStock,
        stockCost,
        lastSaleDate: row.last_sale_date?.toISOString() ?? null,
        lastSaleInPeriod: row.last_sale_in_period?.toISOString() ?? null,
        lastPurchaseDate: row.last_purchase_date?.toISOString() ?? null,
        stockPeriod: row.stock_period?.toISOString() ?? null,
        daysSinceLastSale,
        daysSinceLastPurchase,
        reason,
        riskScore: getRiskScore({
          reason,
          stockCost,
          recentSoldQty,
          daysOfStock,
          daysSinceLastSale,
          daysSinceLastPurchase
        })
      };
    })
    .filter((item): item is ExitProduct => item !== null)
    .sort((a, b) => b.riskScore - a.riskScore || b.stockCost - a.stockCost);

  return {
    period: params.period,
    items,
    exitItems,
    exitSummary: {
      totalItems: exitItems.length,
      stockQty: exitItems.reduce((sum, item) => sum + item.stockQty, 0),
      stockCost: exitItems.reduce((sum, item) => sum + item.stockCost, 0),
      noSalesCount: exitItems.filter((item) => item.reason === "no_sales").length,
      deadStockCount: exitItems.filter((item) => item.reason === "dead_stock").length,
      slowMovingCount: exitItems.filter((item) => item.reason === "slow_moving").length,
      overstockCount: exitItems.filter((item) => item.reason === "overstock").length,
      oldStockCount: exitItems.filter((item) => item.reason === "old_stock").length,
      stockPeriod: exitItems.find((item) => item.stockPeriod)?.stockPeriod ?? null
    },
    totalDays
  };
}
