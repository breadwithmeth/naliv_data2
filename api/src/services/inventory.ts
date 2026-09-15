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

export type InventoryParams = {
  period: SalesPeriod;
  from?: Date;
  to?: Date;
};

export async function getInventoryReport(params: InventoryParams) {
  const postuplenieTable = qualifiedTable("document_postuplenie_tovarov");
  const postuplenieItemsTable = qualifiedTable("document_postuplenie_tovarov_tovary");
  const reportsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const reportItemsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_tovary");
  const nomenklaturaTable = qualifiedTable("catalog_nomenklatura");
  const balanceTable = qualifiedTable("accumulation_register_tovary_na_skladah_balance");

  // Recent sales filter
  const recentFilters: Prisma.Sql[] = [
    Prisma.sql`r.date is not null`,
    Prisma.sql`r.deletion_mark is not true`,
    Prisma.sql`r.posted = true`
  ];

  if (params.from) {
    recentFilters.push(Prisma.sql`r.date >= ${params.from}`);
  }

  if (params.to) {
    recentFilters.push(Prisma.sql`r.date < ${params.to}`);
  }

  const recentWhere = Prisma.join(recentFilters, " and ");
  const balanceFilters: Prisma.Sql[] = [Prisma.sql`b.balance_period is not null`];

  if (params.from) {
    balanceFilters.push(Prisma.sql`b.balance_period >= ${params.from}`);
  }

  if (params.to) {
    balanceFilters.push(Prisma.sql`b.balance_period < ${params.to}`);
  }

  const balanceWhere = Prisma.join(balanceFilters, " and ");
  const referenceDate = params.to ?? new Date();

  const rows = await prisma.$queryRaw<
    Array<{
      nomenklatura_key: string;
      item_name: string | null;
      total_purchased: number;
      total_sold: number;
      stock_qty: number;
      reserved_qty: number;
      warehouse_count: number;
      recent_sold_qty: number;
      recent_days_active: number;
      daily_sales_rate: number;
      days_of_stock: number | null;
      stock_cost: number;
      stock_retail_value: number;
      last_sale_date: Date | null;
      last_purchase_date: Date | null;
      days_since_last_sale: number | null;
      stock_period: Date | null;
    }>
  >`
    with
    latest_balance_period as (
      select max(b.balance_period) as balance_period
      from ${balanceTable} b
      where ${balanceWhere}
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
    -- Each source line table is read once: lifetime totals and period- or
    -- price-filtered aggregates are conditional aggregates over the same rows,
    -- so they no longer need separate CTE scans.
    purchase_stats as (
      select
        pt.nomenklatura_key,
        coalesce(sum(pt.kolichestvo), 0)::float8 as total_purchased,
        max(p.date) filter (where pt.kolichestvo is not null) as last_purchase_date,
        coalesce(avg(pt.tsena) filter (where pt.tsena > 0), 0)::float8 as avg_purchase_price,
        coalesce(max(pt.summa / nullif(pt.kolichestvo, 0)) filter (where pt.tsena > 0), 0)::float8 as last_purchase_price,
        -- A key whose purchase lines all lack a quantity produced no row in the
        -- former all_purchases scan; keep that so the outer joins below cannot
        -- surface extra zeroed items.
        bool_or(pt.kolichestvo is not null) as has_quantity_line
      from ${postuplenieItemsTable} pt
      join ${postuplenieTable} p on p.ref_key = pt."_parent_ref_key"
      where p.deletion_mark is not true
        and p.posted = true
        and pt.nomenklatura_key is not null
      group by pt.nomenklatura_key
    ),
    sales_stats as (
      select
        ri.nomenklatura_key,
        coalesce(sum(ri.kolichestvo), 0)::float8 as total_sold,
        coalesce(sum(ri.kolichestvo) filter (where ${recentWhere} and ri.kolichestvo is not null), 0)::float8 as recent_sold_qty,
        count(distinct date_trunc('day', r.date)) filter (where ${recentWhere} and ri.kolichestvo is not null)::int as recent_days_active,
        max(r.date) filter (where ${recentWhere} and ri.kolichestvo is not null) as last_sale_date,
        bool_or(ri.kolichestvo is not null) as has_quantity_line
      from ${reportItemsTable} ri
      join ${reportsTable} r on r.ref_key = ri."_parent_ref_key"
      where r.deletion_mark is not true
        and r.posted = true
        and ri.nomenklatura_key is not null
      group by ri.nomenklatura_key
    ),
    stock_calc as (
      select
        coalesce(bs.nomenklatura_key, ps.nomenklatura_key, ss.nomenklatura_key) as nomenklatura_key,
        coalesce(ps.total_purchased, 0) as total_purchased,
        coalesce(ss.total_sold, 0) as total_sold,
        coalesce(bs.stock_qty, coalesce(ps.total_purchased, 0) - coalesce(ss.total_sold, 0)) as stock_qty,
        coalesce(bs.reserved_qty, 0) as reserved_qty,
        coalesce(bs.warehouse_count, 0) as warehouse_count,
        coalesce(ss.recent_sold_qty, 0) as recent_sold_qty,
        coalesce(ss.recent_days_active, 0) as recent_days_active,
        coalesce(ps.avg_purchase_price, 0) as avg_purchase_price,
        ss.last_sale_date,
        ps.last_purchase_date,
        bs.stock_period
      from balance_stock bs
      full outer join purchase_stats ps on ps.nomenklatura_key = bs.nomenklatura_key
      full outer join sales_stats ss
        on ss.nomenklatura_key = coalesce(bs.nomenklatura_key, ps.nomenklatura_key)
      -- Reproduce the former key set exactly: a key entered the result only via a
      -- balance snapshot, a purchase line with a quantity, or a sales line with a
      -- quantity. Purchase rows without any quantity still enrich prices for keys
      -- that another source contributed.
      where bs.nomenklatura_key is not null
        or ps.has_quantity_line
        or ss.has_quantity_line
    )
    select
      sc.nomenklatura_key,
      max(n.description) as item_name,
      sc.total_purchased,
      sc.total_sold,
      greatest(sc.stock_qty, 0)::float8 as stock_qty,
      greatest(sc.reserved_qty, 0)::float8 as reserved_qty,
      sc.warehouse_count,
      sc.recent_sold_qty,
      sc.recent_days_active,
      case when sc.recent_days_active > 0
        then (sc.recent_sold_qty / sc.recent_days_active)::float8
        else 0
      end as daily_sales_rate,
      case when sc.recent_days_active > 0 and sc.recent_sold_qty > 0 and sc.stock_qty > 0
        then (sc.stock_qty / (sc.recent_sold_qty / sc.recent_days_active))::float8
        else null
      end as days_of_stock,
      (greatest(sc.stock_qty, 0) * sc.avg_purchase_price)::float8 as stock_cost,
      (greatest(sc.stock_qty, 0) * sc.avg_purchase_price * 1.5)::float8 as stock_retail_value,
      sc.last_sale_date,
      sc.last_purchase_date,
      case when sc.last_sale_date is not null
        then (${referenceDate}::date - sc.last_sale_date::date)::int
        else null
      end as days_since_last_sale,
      sc.stock_period
    from stock_calc sc
    left join ${nomenklaturaTable} n on n.ref_key = sc.nomenklatura_key
    group by
      sc.nomenklatura_key, sc.total_purchased, sc.total_sold, sc.stock_qty,
      sc.reserved_qty, sc.warehouse_count, sc.recent_sold_qty, sc.recent_days_active,
      sc.avg_purchase_price, sc.last_sale_date, sc.last_purchase_date, sc.stock_period
    order by stock_cost desc
  `;

  const items = rows.map((row) => {
    const stockQty = Number(row.stock_qty);
    const reservedQty = Number(row.reserved_qty);
    const dailyRate = Number(row.daily_sales_rate);
    const daysOfStock = row.days_of_stock !== null ? Number(row.days_of_stock) : null;
    const daysSinceLastSale = row.days_since_last_sale !== null ? Number(row.days_since_last_sale) : null;
    const stockCost = Number(row.stock_cost);
    const recentSold = Number(row.recent_sold_qty);

    // Classification
    let category: "out_of_stock" | "overstock" | "slow_moving" | "dead" | "normal" = "normal";

    if (stockQty <= 0 && recentSold <= 0) {
      category = "out_of_stock";
    } else if (stockQty <= 0) {
      category = "out_of_stock";
    } else if (stockQty > 0 && recentSold === 0 && daysSinceLastSale !== null && daysSinceLastSale > 60) {
      category = "dead";
    } else if (dailyRate > 0 && dailyRate < 0.1 && stockQty > 0) {
      category = "slow_moving";
    } else if (daysOfStock !== null && daysOfStock > 90 && stockQty > 10) {
      category = "overstock";
    }

    // Forecast: days until stock depletes
    const depletionDays = dailyRate > 0 && stockQty > 0
      ? stockQty / dailyRate
      : null;

    return {
      key: row.nomenklatura_key,
      name: row.item_name ?? row.nomenklatura_key,
      totalPurchased: Number(row.total_purchased),
      totalSold: Number(row.total_sold),
      stockQty,
      reservedQty,
      availableQty: Math.max(stockQty - reservedQty, 0),
      warehouseCount: Number(row.warehouse_count),
      recentSoldQty: recentSold,
      recentDaysActive: Number(row.recent_days_active),
      dailySalesRate: dailyRate,
      daysOfStock,
      depletionDays,
      stockCost,
      stockRetailValue: Number(row.stock_retail_value),
      lastSaleDate: row.last_sale_date?.toISOString() ?? null,
      lastPurchaseDate: row.last_purchase_date?.toISOString() ?? null,
      stockPeriod: row.stock_period?.toISOString() ?? null,
      daysSinceLastSale,
      category
    };
  });

  const outOfStock = items.filter((i) => i.category === "out_of_stock");
  const overstock = items.filter((i) => i.category === "overstock");
  const slowMoving = items.filter((i) => i.category === "slow_moving");
  const dead = items.filter((i) => i.category === "dead");
  const withStock = items.filter((i) => i.stockQty > 0);

  return {
    period: params.period,
    summary: {
      totalItems: items.length,
      itemsWithStock: withStock.length,
      totalStockCost: withStock.reduce((s, i) => s + i.stockCost, 0),
      totalStockRetail: withStock.reduce((s, i) => s + i.stockRetailValue, 0),
      outOfStockCount: outOfStock.length,
      overstockCount: overstock.length,
      slowMovingCount: slowMoving.length,
      deadCount: dead.length,
      reservedQty: withStock.reduce((s, i) => s + i.reservedQty, 0),
      stockPeriod: items.find((item) => item.stockPeriod)?.stockPeriod ?? null
    },
    items,
    outOfStock,
    overstock,
    slowMoving,
    dead
  };
}
