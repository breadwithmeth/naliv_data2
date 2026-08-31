import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../prisma.js";

export type SalesPeriod = "day" | "week" | "month";

export type SalesReportParams = {
  period: SalesPeriod;
  from?: Date;
  to?: Date;
  storeLimit: number;
};

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(tableName: string) {
  return Prisma.raw(`${quoteIdent(config.PGSCHEMA)}.${quoteIdent(tableName)}`);
}

function retailSalesFilters(params: SalesReportParams) {
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

  return Prisma.join(filters, " and ");
}

function retailReportsCte(params: SalesReportParams) {
  const reportsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const itemsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_tovary");
  const whereSql = retailSalesFilters(params);
  const unknownStore = "Без магазина";
  const emptyRef = "00000000-0000-0000-0000-000000000000";

  return Prisma.sql`
    with item_totals as (
      select
        "_parent_ref_key" as parent_ref_key,
        sum(coalesce(kolichestvo, 0))::float8 as item_quantity
      from ${itemsTable}
      where "_parent_ref_key" is not null
      group by "_parent_ref_key"
    ),
    checks as (
      select
        r.ref_key,
        r.date as sale_at,
        coalesce(r.summa_dokumenta, 0)::float8 as revenue,
        coalesce(i.item_quantity, null) as item_quantity,
        nullif(r.ref_key, ${emptyRef}) as retail_report_key,
        coalesce(nullif(r.magazin_key, ''), ${unknownStore}) as store_key
      from ${reportsTable} r
      left join item_totals i on i.parent_ref_key = r.ref_key
      where ${whereSql}
    )
  `;
}

function displayStoreName(name: string | null, key: string) {
  if (name && name !== key) {
    return name;
  }

  if (key === "Без магазина") {
    return key;
  }

  return `Магазин ${key}`;
}

export async function getSalesReport(params: SalesReportParams) {
  const summaryQuery = prisma.$queryRaw<
    Array<{
      date_from: Date | null;
      date_to: Date | null;
      revenue: number | null;
      order_count: bigint | number;
      avg_check: number | null;
      avg_items_per_check: number | null;
      report_count: bigint | number;
    }>
  >`
    ${retailReportsCte(params)}
    select
      min(sale_at) as date_from,
      max(sale_at) as date_to,
      coalesce(sum(revenue), 0)::float8 as revenue,
      count(*) as order_count,
      coalesce(avg(revenue), 0)::float8 as avg_check,
      coalesce(avg(item_quantity) filter (where item_quantity is not null), 0)::float8 as avg_items_per_check,
      count(distinct retail_report_key) filter (where retail_report_key is not null) as report_count
    from checks
  `;

  const seriesQuery = prisma.$queryRaw<
    Array<{
      bucket: Date;
      revenue: number | null;
      order_count: bigint | number;
      avg_check: number | null;
      avg_items_per_check: number | null;
    }>
  >`
    ${retailReportsCte(params)}
    select
      date_trunc(${params.period}, sale_at) as bucket,
      coalesce(sum(revenue), 0)::float8 as revenue,
      count(*) as order_count,
      coalesce(avg(revenue), 0)::float8 as avg_check,
      coalesce(avg(item_quantity) filter (where item_quantity is not null), 0)::float8 as avg_items_per_check
    from checks
    group by 1
    order by 1 asc
  `;

  const storeQuery = prisma.$queryRaw<
    Array<{
      store_key: string;
      store_name: string | null;
      revenue: number | null;
      order_count: bigint | number;
    }>
  >`
    ${retailReportsCte(params)},
    store_totals as (
      select
        store_key,
        sum(revenue)::float8 as revenue,
        count(*) as order_count
      from checks
      group by store_key
      order by revenue desc
      limit ${params.storeLimit}
    )
    select
      st.store_key,
      coalesce(nullif(max(m.description), ''), st.store_key) as store_name,
      st.revenue,
      st.order_count
    from store_totals st
    left join ${qualifiedTable("catalog_magaziny")} m on m.ref_key = st.store_key
    group by st.store_key, st.revenue, st.order_count
    order by st.revenue desc
  `;

  const heatmapQuery = prisma.$queryRaw<
    Array<{
      sale_day: Date;
      store_key: string;
      hour: number;
      revenue: number | null;
      order_count: bigint | number;
    }>
  >`
    ${retailReportsCte(params)},
    store_totals as (
      select
        store_key,
        sum(revenue)::float8 as revenue
      from checks
      group by store_key
      order by revenue desc
      limit ${params.storeLimit}
    )
    select
      date_trunc('day', c.sale_at) as sale_day,
      c.store_key,
      extract(hour from c.sale_at)::int as hour,
      coalesce(sum(c.revenue), 0)::float8 as revenue,
      count(*) as order_count
    from checks c
    join store_totals st on st.store_key = c.store_key
    group by date_trunc('day', c.sale_at), c.store_key, extract(hour from c.sale_at)::int
    order by sale_day, c.store_key, hour
  `;

  const [summaryRows, seriesRows, storeRows, heatmapRows] = await Promise.all([
    summaryQuery,
    seriesQuery,
    storeQuery,
    heatmapQuery
  ]);

  const maxHeatRevenue = Math.max(
    ...heatmapRows.map((row) => Number(row.revenue ?? 0)),
    0
  );
  const heatmapDays = Array.from(
    new Set(heatmapRows.map((row) => row.sale_day.toISOString()))
  ).sort();

  const summary = summaryRows[0];

  return {
    period: params.period,
    summary: {
      dateFrom: summary?.date_from?.toISOString() ?? null,
      dateTo: summary?.date_to?.toISOString() ?? null,
      revenue: Number(summary?.revenue ?? 0),
      orderCount: Number(summary?.order_count ?? 0),
      avgCheck: Number(summary?.avg_check ?? 0),
      avgItemsPerCheck: Number(summary?.avg_items_per_check ?? 0),
      reportCount: Number(summary?.report_count ?? 0)
    },
    revenueSeries: seriesRows.map((row) => ({
      bucket: row.bucket.toISOString(),
      revenue: Number(row.revenue ?? 0),
      orderCount: Number(row.order_count ?? 0),
      avgCheck: Number(row.avg_check ?? 0),
      avgItemsPerCheck: Number(row.avg_items_per_check ?? 0)
    })),
    heatmap: {
      days: heatmapDays,
      hours: Array.from({ length: 24 }, (_value, hour) => hour),
      stores: storeRows.map((row) => ({
        key: row.store_key,
        name: displayStoreName(row.store_name, row.store_key),
        revenue: Number(row.revenue ?? 0),
        orderCount: Number(row.order_count ?? 0)
      })),
      cells: heatmapRows.map((row) => ({
        day: row.sale_day.toISOString(),
        storeKey: row.store_key,
        hour: row.hour,
        revenue: Number(row.revenue ?? 0),
        orderCount: Number(row.order_count ?? 0),
        intensity:
          maxHeatRevenue > 0 ? Number(row.revenue ?? 0) / maxHeatRevenue : 0
      }))
    }
  };
}

// --------------- Income (Gross Profit & Margin) ---------------

function retailReportCte(params: SalesReportParams) {
  const reportsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const reportItemsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_tovary");

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
    retail_items as (
      select
        r.date as sale_at,
        ri.nomenklatura_key,
        nullif(r.magazin_key, '') as magazin_key,
        coalesce(ri.kolichestvo, 0)::float8 as sold_qty,
        coalesce(ri.summa, 0)::float8 as line_revenue
      from ${reportItemsTable} ri
      join ${reportsTable} r on r.ref_key = ri."_parent_ref_key"
      where ${Prisma.join(filters, " and ")}
        and ri.nomenklatura_key is not null
        and coalesce(ri.kolichestvo, 0) > 0
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

export type IncomeReportParams = SalesReportParams;

export async function getIncomeReport(params: IncomeReportParams) {
  const nomenklaturaTable = qualifiedTable("catalog_nomenklatura");
  const magazinyTable = qualifiedTable("catalog_magaziny");

  const summaryQuery = prisma.$queryRaw<
    Array<{
      date_from: Date | null;
      date_to: Date | null;
      revenue: number | null;
      cost: number | null;
      gross_profit: number | null;
      margin_pct: number | null;
    }>
  >`
    with
    ${retailReportCte(params)},
    ${itemCostsCte()},
    item_profit as (
      select
        coalesce(sum(ri.line_revenue), 0)::float8 as revenue,
        coalesce(sum(ri.sold_qty * coalesce(ic.avg_purchase_price, 0)), 0)::float8 as cost
      from retail_items ri
      left join item_costs ic on ic.nomenklatura_key = ri.nomenklatura_key
    )
    select
      (select min(sale_at) from retail_items) as date_from,
      (select max(sale_at) from retail_items) as date_to,
      ip.revenue,
      ip.cost,
      (ip.revenue - ip.cost)::float8 as gross_profit,
      case when ip.revenue > 0
        then ((ip.revenue - ip.cost) / ip.revenue * 100)::float8
        else 0
      end as margin_pct
    from item_profit ip
  `;

  const seriesQuery = prisma.$queryRaw<
    Array<{
      bucket: Date;
      revenue: number | null;
      cost: number | null;
      gross_profit: number | null;
      margin_pct: number | null;
    }>
  >`
    with
    ${retailReportCte(params)},
    ${itemCostsCte()},
    period_profit as (
      select
        date_trunc(${params.period}, ri.sale_at) as bucket,
        coalesce(sum(ri.line_revenue), 0)::float8 as revenue,
        coalesce(sum(ri.sold_qty * coalesce(ic.avg_purchase_price, 0)), 0)::float8 as cost
      from retail_items ri
      left join item_costs ic on ic.nomenklatura_key = ri.nomenklatura_key
      group by 1
    )
    select
      pp.bucket,
      pp.revenue,
      pp.cost,
      (pp.revenue - pp.cost)::float8 as gross_profit,
      case when pp.revenue > 0
        then ((pp.revenue - pp.cost) / pp.revenue * 100)::float8
        else 0
      end as margin_pct
    from period_profit pp
    order by pp.bucket asc
  `;

  const storeQuery = prisma.$queryRaw<
    Array<{
      magazin_key: string;
      store_name: string | null;
      revenue: number | null;
      cost: number | null;
      gross_profit: number | null;
      margin_pct: number | null;
    }>
  >`
    with
    ${retailReportCte(params)},
    ${itemCostsCte()},
    store_profit as (
      select
        coalesce(ri.magazin_key, 'Без магазина') as magazin_key,
        coalesce(sum(ri.line_revenue), 0)::float8 as revenue,
        coalesce(sum(ri.sold_qty * coalesce(ic.avg_purchase_price, 0)), 0)::float8 as cost
      from retail_items ri
      left join item_costs ic on ic.nomenklatura_key = ri.nomenklatura_key
      group by coalesce(ri.magazin_key, 'Без магазина')
    )
    select
      sp.magazin_key,
      coalesce(nullif(max(m.description), ''), sp.magazin_key) as store_name,
      sp.revenue,
      sp.cost,
      (sp.revenue - sp.cost)::float8 as gross_profit,
      case when sp.revenue > 0
        then ((sp.revenue - sp.cost) / sp.revenue * 100)::float8
        else 0
      end as margin_pct
    from store_profit sp
    left join ${magazinyTable} m on m.ref_key = sp.magazin_key
    group by sp.magazin_key, sp.revenue, sp.cost
    order by sp.revenue desc
  `;

  const itemQuery = prisma.$queryRaw<
    Array<{
      nomenklatura_key: string;
      item_name: string | null;
      sold_qty: number | null;
      revenue: number | null;
      cost: number | null;
      gross_profit: number | null;
      margin_pct: number | null;
    }>
  >`
    with
    ${retailReportCte(params)},
    ${itemCostsCte()},
    item_profit_detail as (
      select
        ri.nomenklatura_key,
        coalesce(sum(ri.sold_qty), 0)::float8 as sold_qty,
        coalesce(sum(ri.line_revenue), 0)::float8 as revenue,
        coalesce(sum(ri.sold_qty * coalesce(ic.avg_purchase_price, 0)), 0)::float8 as cost
      from retail_items ri
      left join item_costs ic on ic.nomenklatura_key = ri.nomenklatura_key
      group by ri.nomenklatura_key
    )
    select
      ipd.nomenklatura_key,
      max(n.description) as item_name,
      ipd.sold_qty,
      ipd.revenue,
      ipd.cost,
      (ipd.revenue - ipd.cost)::float8 as gross_profit,
      case when ipd.revenue > 0
        then ((ipd.revenue - ipd.cost) / ipd.revenue * 100)::float8
        else 0
      end as margin_pct
    from item_profit_detail ipd
    left join ${nomenklaturaTable} n on n.ref_key = ipd.nomenklatura_key
    group by ipd.nomenklatura_key, ipd.sold_qty, ipd.revenue, ipd.cost
    order by ipd.revenue desc
  `;

  const storeItemQuery = prisma.$queryRaw<
    Array<{
      magazin_key: string;
      store_name: string | null;
      nomenklatura_key: string;
      item_name: string | null;
      sold_qty: number | null;
      revenue: number | null;
      cost: number | null;
      gross_profit: number | null;
      margin_pct: number | null;
    }>
  >`
    with
    ${retailReportCte(params)},
    ${itemCostsCte()},
    store_item_profit as (
      select
        coalesce(ri.magazin_key, 'Без магазина') as magazin_key,
        ri.nomenklatura_key,
        coalesce(sum(ri.sold_qty), 0)::float8 as sold_qty,
        coalesce(sum(ri.line_revenue), 0)::float8 as revenue,
        coalesce(sum(ri.sold_qty * coalesce(ic.avg_purchase_price, 0)), 0)::float8 as cost
      from retail_items ri
      left join item_costs ic on ic.nomenklatura_key = ri.nomenklatura_key
      group by coalesce(ri.magazin_key, 'Без магазина'), ri.nomenklatura_key
    )
    select
      sip.magazin_key,
      coalesce(nullif(max(m.description), ''), sip.magazin_key) as store_name,
      sip.nomenklatura_key,
      max(n.description) as item_name,
      sip.sold_qty,
      sip.revenue,
      sip.cost,
      (sip.revenue - sip.cost)::float8 as gross_profit,
      case when sip.revenue > 0
        then ((sip.revenue - sip.cost) / sip.revenue * 100)::float8
        else 0
      end as margin_pct
    from store_item_profit sip
    left join ${magazinyTable} m on m.ref_key = sip.magazin_key
    left join ${nomenklaturaTable} n on n.ref_key = sip.nomenklatura_key
    group by sip.magazin_key, sip.nomenklatura_key, sip.sold_qty, sip.revenue, sip.cost
    order by sip.magazin_key, sip.revenue desc
  `;

  const [summaryRows, seriesRows, storeRows, itemRows, storeItemRows] =
    await Promise.all([
      summaryQuery,
      seriesQuery,
      storeQuery,
      itemQuery,
      storeItemQuery
    ]);

  const summary = summaryRows[0];

  return {
    period: params.period,
    summary: {
      dateFrom: summary?.date_from?.toISOString() ?? null,
      dateTo: summary?.date_to?.toISOString() ?? null,
      revenue: Number(summary?.revenue ?? 0),
      cost: Number(summary?.cost ?? 0),
      grossProfit: Number(summary?.gross_profit ?? 0),
      marginPct: Number(summary?.margin_pct ?? 0)
    },
    incomeSeries: seriesRows.map((row) => ({
      bucket: row.bucket.toISOString(),
      revenue: Number(row.revenue ?? 0),
      cost: Number(row.cost ?? 0),
      grossProfit: Number(row.gross_profit ?? 0),
      marginPct: Number(row.margin_pct ?? 0)
    })),
    stores: storeRows.map((row) => ({
      key: row.magazin_key,
      name: displayStoreName(row.store_name, row.magazin_key),
      revenue: Number(row.revenue ?? 0),
      cost: Number(row.cost ?? 0),
      grossProfit: Number(row.gross_profit ?? 0),
      marginPct: Number(row.margin_pct ?? 0)
    })),
    items: itemRows.map((row) => ({
      key: row.nomenklatura_key,
      name: row.item_name ?? row.nomenklatura_key,
      soldQty: Number(row.sold_qty ?? 0),
      revenue: Number(row.revenue ?? 0),
      cost: Number(row.cost ?? 0),
      grossProfit: Number(row.gross_profit ?? 0),
      marginPct: Number(row.margin_pct ?? 0)
    })),
    storeItems: storeItemRows.map((row) => ({
      storeKey: row.magazin_key,
      storeName: displayStoreName(row.store_name, row.magazin_key),
      itemKey: row.nomenklatura_key,
      itemName: row.item_name ?? row.nomenklatura_key,
      soldQty: Number(row.sold_qty ?? 0),
      revenue: Number(row.revenue ?? 0),
      cost: Number(row.cost ?? 0),
      grossProfit: Number(row.gross_profit ?? 0),
      marginPct: Number(row.margin_pct ?? 0)
    }))
  };
}
