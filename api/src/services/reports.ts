import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import { canonicalItemCostsCtes } from "../lib/cost-sql.js";

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
    Prisma.sql`r.deletion_mark is not true`,
    Prisma.sql`r.posted = true`,
    Prisma.sql`(
      coalesce(r.summa_dokumenta, 0) <> 0
      or coalesce(r.summa_vozvratov, 0) <> 0
    )`
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
  const returnItemsTable = qualifiedTable(
    "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary"
  );
  const whereSql = retailSalesFilters(params);
  const unknownStore = "Без магазина";
  const emptyRef = "00000000-0000-0000-0000-000000000000";

  return Prisma.sql`
    with selected_reports as materialized (
      select
        r.ref_key,
        r.date,
        coalesce(r.summa_dokumenta, 0)::float8 as gross_revenue,
        coalesce(r.summa_vozvratov, 0)::float8 as return_amount,
        r.magazin_key
      from ${reportsTable} r
      where ${whereSql}
    ),
    item_movements as (
      select
        t."_parent_ref_key" as parent_ref_key,
        coalesce(t.kolichestvo, 0)::float8 as item_quantity
      from ${itemsTable} t
      where exists (
        select 1 from selected_reports r where r.ref_key = t."_parent_ref_key"
      )
      union all
      select
        t."_parent_ref_key" as parent_ref_key,
        -coalesce(t.kolichestvo, 0)::float8 as item_quantity
      from ${returnItemsTable} t
      where exists (
        select 1 from selected_reports r where r.ref_key = t."_parent_ref_key"
      )
    ),
    item_totals as (
      select
        parent_ref_key,
        sum(item_quantity)::float8 as item_quantity
      from item_movements
      group by parent_ref_key
    ),
    checks as (
      select
        r.ref_key,
        r.date as sale_at,
        r.gross_revenue,
        r.return_amount,
        (r.gross_revenue - r.return_amount)::float8 as revenue,
        i.item_quantity,
        nullif(r.ref_key, ${emptyRef}) as retail_report_key,
        coalesce(nullif(r.magazin_key, ''), ${unknownStore}) as store_key
      from selected_reports r
      left join item_totals i on i.parent_ref_key = r.ref_key
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
  // One GROUPING SETS scan produces the period series (grouped rows) and the
  // grand summary (the null-bucket row); a second scan yields the heatmap and
  // per-store totals. Previously each of these re-ran the same CTEs in four
  // separate queries per request.
  const seriesQuery = prisma.$queryRaw<
    Array<{
      bucket: Date | null;
      gross_revenue: number | null;
      returns: number | null;
      revenue: number | null;
      order_count: bigint | number;
      avg_check: number | null;
      avg_items_per_check: number | null;
      date_from: Date | null;
      date_to: Date | null;
      report_count: bigint | number;
    }>
  >`
    ${retailReportsCte(params)}
    select
      date_trunc(${params.period}, sale_at) as bucket,
      coalesce(sum(gross_revenue), 0)::float8 as gross_revenue,
      coalesce(sum(return_amount), 0)::float8 as returns,
      coalesce(sum(revenue), 0)::float8 as revenue,
      count(*) as order_count,
      coalesce(avg(revenue), 0)::float8 as avg_check,
      coalesce(avg(item_quantity) filter (where item_quantity is not null), 0)::float8 as avg_items_per_check,
      min(sale_at) as date_from,
      max(sale_at) as date_to,
      count(distinct retail_report_key) filter (where retail_report_key is not null) as report_count
    from checks
    group by grouping sets ((1), ())
    order by 1 asc nulls last
  `;

  const heatmapQuery = prisma.$queryRaw<
    Array<{
      sale_day: Date;
      store_key: string;
      store_name: string | null;
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
    ),
    -- Catalog keys are not guaranteed unique; collapse them before the join so
    -- duplicate catalog rows cannot multiply the aggregated store cells.
    store_names as (
      select
        ref_key,
        max(description) as description
      from ${qualifiedTable("catalog_magaziny")}
      group by ref_key
    )
    select
      date_trunc('day', c.sale_at) as sale_day,
      c.store_key,
      coalesce(nullif(max(m.description), ''), c.store_key) as store_name,
      extract(hour from c.sale_at)::int as hour,
      coalesce(sum(c.revenue), 0)::float8 as revenue,
      count(*) as order_count
    from checks c
    join store_totals st on st.store_key = c.store_key
    left join store_names m on m.ref_key = c.store_key
    group by date_trunc('day', c.sale_at), c.store_key, extract(hour from c.sale_at)::int
    order by sale_day, c.store_key, hour
  `;

  const [seriesRows, heatmapRows] = await Promise.all([seriesQuery, heatmapQuery]);

  const summaryRow = seriesRows.find((row) => row.bucket === null);
  const periodRows = seriesRows.filter((row) => row.bucket !== null);

  const maxHeatRevenue = Math.max(
    ...heatmapRows.map((row) => Number(row.revenue ?? 0)),
    0
  );
  const heatmapDays = Array.from(
    new Set(heatmapRows.map((row) => row.sale_day.toISOString()))
  ).sort();

  // Per-store revenue and order counts are exact sums of that store's heatmap
  // cells, so the separate store_totals + catalog join scan adds nothing.
  const storeRows = new Map<string, { name: string; revenue: number; orderCount: number }>();
  for (const row of heatmapRows) {
    const store = storeRows.get(row.store_key) ?? {
      name: row.store_name ?? row.store_key,
      revenue: 0,
      orderCount: 0
    };
    store.revenue += Number(row.revenue ?? 0);
    store.orderCount += Number(row.order_count ?? 0);
    storeRows.set(row.store_key, store);
  }
  const stores = [...storeRows.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([storeKey, store]) => ({
      key: storeKey,
      name: displayStoreName(store.name, storeKey),
      revenue: store.revenue,
      orderCount: store.orderCount
    }));

  return {
    period: params.period,
    summary: {
      dateFrom: summaryRow?.date_from?.toISOString() ?? null,
      dateTo: summaryRow?.date_to?.toISOString() ?? null,
      grossRevenue: Number(summaryRow?.gross_revenue ?? 0),
      returns: Number(summaryRow?.returns ?? 0),
      revenue: Number(summaryRow?.revenue ?? 0),
      orderCount: Number(summaryRow?.order_count ?? 0),
      avgCheck: Number(summaryRow?.avg_check ?? 0),
      avgItemsPerCheck: Number(summaryRow?.avg_items_per_check ?? 0),
      reportCount: Number(summaryRow?.report_count ?? 0)
    },
    revenueSeries: periodRows.map((row) => ({
      bucket: row.bucket!.toISOString(),
      grossRevenue: Number(row.gross_revenue ?? 0),
      returns: Number(row.returns ?? 0),
      revenue: Number(row.revenue ?? 0),
      orderCount: Number(row.order_count ?? 0),
      avgCheck: Number(row.avg_check ?? 0),
      avgItemsPerCheck: Number(row.avg_items_per_check ?? 0)
    })),
    heatmap: {
      days: heatmapDays,
      hours: Array.from({ length: 24 }, (_value, hour) => hour),
      stores,
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
  const returnItemsTable = qualifiedTable(
    "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary"
  );
  const whereSql = retailSalesFilters(params);

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
      where ${whereSql}
        and ri.nomenklatura_key is not null
      union all
      select
        r.date as sale_at,
        ri.nomenklatura_key,
        nullif(r.magazin_key, '') as magazin_key,
        -coalesce(ri.kolichestvo, 0)::float8 as sold_qty,
        -coalesce(ri.summa, 0)::float8 as line_revenue
      from ${returnItemsTable} ri
      join ${reportsTable} r on r.ref_key = ri."_parent_ref_key"
      where ${whereSql}
        and ri.nomenklatura_key is not null
    )
  `;
}

export type IncomeReportParams = SalesReportParams;

export async function getIncomeReport(params: IncomeReportParams) {
  const nomenklaturaTable = qualifiedTable("catalog_nomenklatura");
  const magazinyTable = qualifiedTable("catalog_magaziny");

  // One GROUPING SETS scan produces the period series (grouped rows) and the
  // grand summary (the null-bucket row). Previously summary, series, stores,
  // items, and store items re-ran the same CTEs in five separate queries per
  // request.
  const seriesQuery = prisma.$queryRaw<
    Array<{
      bucket: Date | null;
      revenue: number | null;
      cost: number | null;
      gross_profit: number | null;
      margin_pct: number | null;
      cost_coverage_pct: number | null;
      unvalued_revenue: number | null;
      date_from: Date | null;
      date_to: Date | null;
    }>
  >`
    with
    ${retailReportCte(params)},
    ${canonicalItemCostsCtes(params.to)},
    item_profit as (
      select
        date_trunc(${params.period}, ri.sale_at) as bucket,
        coalesce(sum(ri.line_revenue), 0)::float8 as revenue,
        coalesce(sum(
          ri.sold_qty * coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost, 0)
        ), 0)::float8 as cost,
        coalesce(sum(abs(ri.line_revenue)), 0)::float8 as absolute_revenue,
        coalesce(sum(abs(ri.line_revenue)) filter (
          where coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost) is null
        ), 0)::float8 as unvalued_revenue,
        min(ri.sale_at) as date_from,
        max(ri.sale_at) as date_to
      from retail_items ri
      left join latest_store_costs sc
        on sc.magazin_key = ri.magazin_key and sc.nomenklatura_key = ri.nomenklatura_key
      left join latest_global_costs gc on gc.nomenklatura_key = ri.nomenklatura_key
      left join purchase_costs_90d pc on pc.nomenklatura_key = ri.nomenklatura_key
      group by grouping sets ((1), ())
    )
    select
      pp.bucket,
      pp.revenue,
      pp.cost,
      (pp.revenue - pp.cost)::float8 as gross_profit,
      case when pp.revenue > 0
        then ((pp.revenue - pp.cost) / pp.revenue * 100)::float8
        else 0
      end as margin_pct,
      case when pp.absolute_revenue > 0
        then ((pp.absolute_revenue - pp.unvalued_revenue) / pp.absolute_revenue * 100)::float8
        else 100
      end as cost_coverage_pct,
      pp.unvalued_revenue,
      pp.date_from,
      pp.date_to
    from item_profit pp
    order by pp.bucket asc nulls last
  `;

  const storeItemQuery = prisma.$queryRaw<
    Array<{
      magazin_key: string;
      store_description: string | null;
      nomenklatura_key: string;
      item_description: string | null;
      sold_qty: number | null;
      revenue: number | null;
      cost: number | null;
    }>
  >`
    with
    ${retailReportCte(params)},
    ${canonicalItemCostsCtes(params.to)},
    store_item_profit as (
      select
        coalesce(ri.magazin_key, 'Без магазина') as magazin_key,
        ri.nomenklatura_key,
        coalesce(sum(ri.sold_qty), 0)::float8 as sold_qty,
        coalesce(sum(ri.line_revenue), 0)::float8 as revenue,
        coalesce(sum(
          ri.sold_qty * coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost, 0)
        ), 0)::float8 as cost
      from retail_items ri
      left join latest_store_costs sc
        on sc.magazin_key = ri.magazin_key and sc.nomenklatura_key = ri.nomenklatura_key
      left join latest_global_costs gc on gc.nomenklatura_key = ri.nomenklatura_key
      left join purchase_costs_90d pc on pc.nomenklatura_key = ri.nomenklatura_key
      group by coalesce(ri.magazin_key, 'Без магазина'), ri.nomenklatura_key
    )
    select
      sip.magazin_key,
      max(m.description) as store_description,
      sip.nomenklatura_key,
      max(n.description) as item_description,
      sip.sold_qty,
      sip.revenue,
      sip.cost
    from store_item_profit sip
    left join ${magazinyTable} m on m.ref_key = sip.magazin_key
    left join ${nomenklaturaTable} n on n.ref_key = sip.nomenklatura_key
    group by sip.magazin_key, sip.nomenklatura_key, sip.sold_qty, sip.revenue, sip.cost
    order by sip.magazin_key, sip.revenue desc
  `;

  const [seriesRows, storeItemRows] = await Promise.all([seriesQuery, storeItemQuery]);

  const summaryRow = seriesRows.find((row) => row.bucket === null);
  const periodRows = seriesRows.filter((row) => row.bucket !== null);

  // Per-store totals are exact sums of that store's item rows, and overall item
  // totals are exact sums of an item's rows across stores, so the previous
  // separate store- and item-total scans add nothing. Catalog descriptions are
  // taken as the maximum across rows, matching the earlier per-store and
  // per-item aggregation.
  const storeRows = new Map<string, { description: string | null; soldQty: number; revenue: number; cost: number }>();
  const itemRows = new Map<string, { description: string | null; soldQty: number; revenue: number; cost: number }>();
  for (const row of storeItemRows) {
    const store = storeRows.get(row.magazin_key) ?? {
      description: null,
      soldQty: 0,
      revenue: 0,
      cost: 0
    };
    if (row.store_description && (!store.description || row.store_description > store.description)) {
      store.description = row.store_description;
    }
    store.soldQty += Number(row.sold_qty ?? 0);
    store.revenue += Number(row.revenue ?? 0);
    store.cost += Number(row.cost ?? 0);
    storeRows.set(row.magazin_key, store);

    const item = itemRows.get(row.nomenklatura_key) ?? {
      description: null,
      soldQty: 0,
      revenue: 0,
      cost: 0
    };
    if (row.item_description && (!item.description || row.item_description > item.description)) {
      item.description = row.item_description;
    }
    item.soldQty += Number(row.sold_qty ?? 0);
    item.revenue += Number(row.revenue ?? 0);
    item.cost += Number(row.cost ?? 0);
    itemRows.set(row.nomenklatura_key, item);
  }

  const stores = [...storeRows.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([key, store]) => {
      const marginPct = store.revenue > 0 ? ((store.revenue - store.cost) / store.revenue) * 100 : 0;
      return {
        key,
        name: displayStoreName(store.description === null ? key : store.description, key),
        revenue: store.revenue,
        cost: store.cost,
        grossProfit: store.revenue - store.cost,
        marginPct
      };
    });

  const items = [...itemRows.entries()]
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .map(([key, item]) => {
      const marginPct = item.revenue > 0 ? ((item.revenue - item.cost) / item.revenue) * 100 : 0;
      return {
        key,
        name: item.description ?? key,
        soldQty: item.soldQty,
        revenue: item.revenue,
        cost: item.cost,
        grossProfit: item.revenue - item.cost,
        marginPct
      };
    });

  return {
    period: params.period,
    summary: {
      dateFrom: summaryRow?.date_from?.toISOString() ?? null,
      dateTo: summaryRow?.date_to?.toISOString() ?? null,
      revenue: Number(summaryRow?.revenue ?? 0),
      cost: Number(summaryRow?.cost ?? 0),
      grossProfit: Number(summaryRow?.gross_profit ?? 0),
      marginPct: Number(summaryRow?.margin_pct ?? 0),
      costCoveragePct: Number(summaryRow?.cost_coverage_pct ?? 100),
      unvaluedRevenue: Number(summaryRow?.unvalued_revenue ?? 0)
    },
    incomeSeries: periodRows.map((row) => ({
      bucket: row.bucket!.toISOString(),
      revenue: Number(row.revenue ?? 0),
      cost: Number(row.cost ?? 0),
      grossProfit: Number(row.gross_profit ?? 0),
      marginPct: Number(row.margin_pct ?? 0),
      costCoveragePct: Number(row.cost_coverage_pct ?? 100)
    })),
    stores,
    items,
    storeItems: storeItemRows.map((row) => {
      const revenue = Number(row.revenue ?? 0);
      const cost = Number(row.cost ?? 0);
      return {
        storeKey: row.magazin_key,
        storeName: displayStoreName(
          row.store_description === null ? row.magazin_key : row.store_description,
          row.magazin_key
        ),
        itemKey: row.nomenklatura_key,
        itemName: row.item_description ?? row.nomenklatura_key,
        soldQty: Number(row.sold_qty ?? 0),
        revenue,
        cost,
        grossProfit: revenue - cost,
        marginPct: revenue > 0 ? ((revenue - cost) / revenue) * 100 : 0
      };
    })
  };
}