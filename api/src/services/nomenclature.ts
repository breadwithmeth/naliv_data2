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

// --------------- Public API ---------------

export async function getNomenclatureReport(
  params: NomenclatureParams
): Promise<{
  period: SalesPeriod;
  items: ItemAnalysis[];
  totalDays: number;
}> {
  const nomenklaturaTable = qualifiedTable("catalog_nomenklatura");

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
      coalesce(nullif(max(n.description), ''), r.nomenklatura_key) as item_name,
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

  return {
    period: params.period,
    items,
    totalDays
  };
}
