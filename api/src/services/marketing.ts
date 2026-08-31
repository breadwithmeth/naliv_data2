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

export type MarketingParams = {
  period: SalesPeriod;
  from?: Date;
  to?: Date;
};

type PromoAnalyticsRow = {
  promo_key: string;
  promo_name: string | null;
  promo_check_count: bigint | number;
  promo_store_count: bigint | number;
  promo_item_count: bigint | number;
  promo_quantity: number | null;
  promo_check_revenue: number | null;
  promo_item_revenue: number | null;
  promo_discount_amount: number | null;
  store_key: string;
  store_name: string | null;
  store_check_count: bigint | number;
  store_item_count: bigint | number;
  store_quantity: number | null;
  store_check_revenue: number | null;
  store_item_revenue: number | null;
  store_discount_amount: number | null;
  item_key: string | null;
  item_name: string | null;
  item_check_count: bigint | number | null;
  item_quantity: number | null;
  item_revenue: number | null;
  item_discount_amount: number | null;
  item_last_sale_at: Date | null;
};

function retailReportFilters(params: MarketingParams) {
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

/**
 * Marketing analytics based only on final 1C retail reports.
 *
 * The retail-report item table does not contain a promotion reference or the
 * original discount value. We therefore group discounted lines by their final
 * discount percentage and estimate the discount value from the net line sum:
 * net * rate / (100 - rate). The API contract retains its historic `check*`
 * property names so existing web clients remain compatible; those counts now
 * represent retail reports, not individual receipts.
 */
export async function getMarketingReport(params: MarketingParams) {
  const reportsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const itemsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_tovary");
  const storesTable = qualifiedTable("catalog_magaziny");
  const nomenclatureTable = qualifiedTable("catalog_nomenklatura");
  const whereSql = retailReportFilters(params);
  const unknownStore = "Без магазина";

  const summaryQuery = prisma.$queryRaw<
    Array<{
      total_report_count: bigint | number;
      discounted_report_count: bigint | number;
      total_revenue: number | null;
      revenue_with_discounts: number | null;
      revenue_without_discounts: number | null;
      total_discount_amount: number | null;
    }>
  >`
    with report_discounts as (
      select
        r."_id" as report_id,
        coalesce(r.summa_dokumenta, 0)::float8 as revenue,
        coalesce(bool_or(coalesce(t.protsent_skidki_natsenki, 0) > 0), false) as has_discount,
        coalesce(sum(
          case
            when coalesce(t.protsent_skidki_natsenki, 0) > 0
              and coalesce(t.protsent_skidki_natsenki, 0) < 100
            then coalesce(t.summa, 0)::numeric
              * t.protsent_skidki_natsenki::numeric
              / (100 - t.protsent_skidki_natsenki)::numeric
            else 0
          end
        ), 0)::float8 as discount_amount
      from ${reportsTable} r
      left join ${itemsTable} t on t."_parent_ref_key" = r.ref_key
      where ${whereSql}
      group by r."_id", r.summa_dokumenta
    )
    select
      count(*) as total_report_count,
      count(*) filter (where has_discount) as discounted_report_count,
      coalesce(sum(revenue), 0)::float8 as total_revenue,
      coalesce(sum(revenue) filter (where has_discount), 0)::float8 as revenue_with_discounts,
      coalesce(sum(revenue) filter (where not has_discount), 0)::float8 as revenue_without_discounts,
      coalesce(sum(discount_amount), 0)::float8 as total_discount_amount
    from report_discounts
  `;

  const storeQuery = prisma.$queryRaw<
    Array<{
      magazin_key: string;
      store_name: string | null;
      total_reports: bigint | number;
      total_revenue: number | null;
      discounted_reports: bigint | number;
      discount_amount: number | null;
    }>
  >`
    with report_discounts as (
      select
        r."_id" as report_id,
        coalesce(nullif(r.magazin_key, ''), ${unknownStore}) as store_key,
        coalesce(r.summa_dokumenta, 0)::float8 as revenue,
        coalesce(bool_or(coalesce(t.protsent_skidki_natsenki, 0) > 0), false) as has_discount,
        coalesce(sum(
          case
            when coalesce(t.protsent_skidki_natsenki, 0) > 0
              and coalesce(t.protsent_skidki_natsenki, 0) < 100
            then coalesce(t.summa, 0)::numeric
              * t.protsent_skidki_natsenki::numeric
              / (100 - t.protsent_skidki_natsenki)::numeric
            else 0
          end
        ), 0)::float8 as discount_amount
      from ${reportsTable} r
      left join ${itemsTable} t on t."_parent_ref_key" = r.ref_key
      where ${whereSql}
      group by r."_id", coalesce(nullif(r.magazin_key, ''), ${unknownStore}), r.summa_dokumenta
    ),
    store_totals as (
      select
        store_key,
        count(*) as total_reports,
        coalesce(sum(revenue), 0)::float8 as total_revenue,
        count(*) filter (where has_discount) as discounted_reports,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from report_discounts
      group by store_key
    )
    select
      st.store_key as magazin_key,
      coalesce(nullif(max(m.description), ''), st.store_key) as store_name,
      st.total_reports,
      st.total_revenue,
      st.discounted_reports,
      st.discount_amount
    from store_totals st
    left join ${storesTable} m on m.ref_key = st.store_key
    group by
      st.store_key,
      st.total_reports,
      st.total_revenue,
      st.discounted_reports,
      st.discount_amount
    order by st.total_revenue desc
  `;

  const promoQuery = prisma.$queryRaw<PromoAnalyticsRow[]>`
    with retail_reports as (
      select
        r."_id"::text as report_key,
        r.ref_key,
        r.date as sale_at,
        coalesce(nullif(r.magazin_key, ''), ${unknownStore}) as store_key,
        coalesce(r.summa_dokumenta, 0)::float8 as report_revenue
      from ${reportsTable} r
      where ${whereSql}
    ),
    discounted_items as (
      select
        round(t.protsent_skidki_natsenki::numeric, 2) as discount_rate,
        rr.report_key,
        rr.sale_at,
        rr.store_key,
        rr.report_revenue,
        t.nomenklatura_key as item_key,
        coalesce(t.kolichestvo, 0)::float8 as quantity,
        coalesce(t.summa, 0)::float8 as item_revenue,
        case
          when t.protsent_skidki_natsenki < 100
          then (
            coalesce(t.summa, 0)::numeric
            * t.protsent_skidki_natsenki::numeric
            / (100 - t.protsent_skidki_natsenki)::numeric
          )::float8
          else 0::float8
        end as discount_amount
      from retail_reports rr
      join ${itemsTable} t on t."_parent_ref_key" = rr.ref_key
      where t.nomenklatura_key is not null
        and coalesce(t.kolichestvo, 0) > 0
        and coalesce(t.protsent_skidki_natsenki, 0) > 0
    ),
    promo_item_lines as (
      select
        discount_rate,
        report_key,
        max(sale_at) as sale_at,
        store_key,
        max(report_revenue)::float8 as report_revenue,
        item_key,
        coalesce(sum(quantity), 0)::float8 as quantity,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from discounted_items
      group by discount_rate, report_key, store_key, item_key
    ),
    promo_reports as (
      select
        discount_rate,
        report_key,
        store_key,
        max(report_revenue)::float8 as report_revenue,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from promo_item_lines
      group by discount_rate, report_key, store_key
    ),
    promo_totals as (
      select
        discount_rate,
        count(*) as report_count,
        count(distinct store_key) as store_count,
        coalesce(sum(report_revenue), 0)::float8 as report_revenue,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from promo_reports
      group by discount_rate
    ),
    promo_item_totals as (
      select
        discount_rate,
        count(distinct item_key) as item_count,
        coalesce(sum(quantity), 0)::float8 as quantity
      from promo_item_lines
      group by discount_rate
    ),
    store_report_totals as (
      select
        discount_rate,
        store_key,
        count(*) as report_count,
        coalesce(sum(report_revenue), 0)::float8 as report_revenue,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from promo_reports
      group by discount_rate, store_key
    ),
    store_item_totals as (
      select
        discount_rate,
        store_key,
        count(distinct item_key) as item_count,
        coalesce(sum(quantity), 0)::float8 as quantity
      from promo_item_lines
      group by discount_rate, store_key
    ),
    item_totals as (
      select
        discount_rate,
        store_key,
        item_key,
        count(distinct report_key) as report_count,
        coalesce(sum(quantity), 0)::float8 as quantity,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount,
        max(sale_at) as last_sale_at
      from promo_item_lines
      group by discount_rate, store_key, item_key
    )
    select
      concat('discount:', trim(to_char(pt.discount_rate, 'FM999990.##'))) as promo_key,
      concat('Скидка ', trim(to_char(pt.discount_rate, 'FM999990.##')), '%') as promo_name,
      pt.report_count as promo_check_count,
      pt.store_count as promo_store_count,
      pit.item_count as promo_item_count,
      pit.quantity as promo_quantity,
      pt.report_revenue as promo_check_revenue,
      pt.item_revenue as promo_item_revenue,
      pt.discount_amount as promo_discount_amount,
      srt.store_key,
      coalesce(nullif(max(m.description), ''), srt.store_key) as store_name,
      srt.report_count as store_check_count,
      sit.item_count as store_item_count,
      sit.quantity as store_quantity,
      srt.report_revenue as store_check_revenue,
      srt.item_revenue as store_item_revenue,
      srt.discount_amount as store_discount_amount,
      it.item_key,
      coalesce(nullif(max(n.description), ''), it.item_key) as item_name,
      it.report_count as item_check_count,
      it.quantity as item_quantity,
      it.item_revenue,
      it.discount_amount as item_discount_amount,
      it.last_sale_at as item_last_sale_at
    from promo_totals pt
    join promo_item_totals pit on pit.discount_rate = pt.discount_rate
    join store_report_totals srt on srt.discount_rate = pt.discount_rate
    join store_item_totals sit
      on sit.discount_rate = srt.discount_rate
      and sit.store_key = srt.store_key
    join item_totals it
      on it.discount_rate = srt.discount_rate
      and it.store_key = srt.store_key
    left join ${storesTable} m on m.ref_key = srt.store_key
    left join ${nomenclatureTable} n on n.ref_key = it.item_key
    group by
      pt.discount_rate,
      pt.report_count,
      pt.store_count,
      pit.item_count,
      pit.quantity,
      pt.report_revenue,
      pt.item_revenue,
      pt.discount_amount,
      srt.store_key,
      srt.report_count,
      sit.item_count,
      sit.quantity,
      srt.report_revenue,
      srt.item_revenue,
      srt.discount_amount,
      it.item_key,
      it.report_count,
      it.quantity,
      it.item_revenue,
      it.discount_amount,
      it.last_sale_at
    order by pt.item_revenue desc, srt.item_revenue desc, it.item_revenue desc
  `;

  // These independent aggregates are intentionally concurrent. Marketing used
  // to execute many receipt-level queries serially, which made this page slow.
  const [summaryRows, storeRows, promoRows] = await Promise.all([
    summaryQuery,
    storeQuery,
    promoQuery
  ]);

  const summary = summaryRows[0];
  const totalRevenue = Number(summary?.total_revenue ?? 0);
  const totalReports = Number(summary?.total_report_count ?? 0);
  const discountedReports = Number(summary?.discounted_report_count ?? 0);
  const noDiscountReports = Math.max(totalReports - discountedReports, 0);
  const revenueWithDiscounts = Number(summary?.revenue_with_discounts ?? 0);
  const revenueWithoutDiscounts = Number(summary?.revenue_without_discounts ?? 0);
  const totalDiscountAmount = Number(summary?.total_discount_amount ?? 0);
  const promoAnalytics = buildPromoAnalytics(promoRows);

  const promos = promoAnalytics.map((promo) => ({
    key: promo.key,
    name: promo.name,
    checkCount: promo.checkCount,
    revenue: promo.itemRevenue,
    discountAmount: promo.discountAmount,
    avgDiscountPct:
      promo.itemRevenue > 0 ? (promo.discountAmount / promo.itemRevenue) * 100 : 0
  }));

  const stores = storeRows.map((row) => {
    const revenue = Number(row.total_revenue ?? 0);
    const discountAmount = Number(row.discount_amount ?? 0);

    return {
      key: row.magazin_key,
      name: row.store_name ?? row.magazin_key,
      totalChecks: Number(row.total_reports ?? 0),
      totalRevenue: revenue,
      discountChecks: Number(row.discounted_reports ?? 0),
      discountAmount,
      avgDiscountPct: revenue > 0 ? (discountAmount / revenue) * 100 : 0
    };
  });

  const storePromos = promoAnalytics.flatMap((promo) =>
    promo.stores.map((store) => ({
      storeKey: store.key,
      storeName: store.name,
      promoKey: promo.key,
      promoName: promo.name,
      checkCount: store.checkCount,
      revenue: store.itemRevenue,
      discountAmount: store.discountAmount,
      avgDiscountPct: store.avgDiscountPct
    }))
  );

  return {
    period: params.period,
    summary: {
      totalRevenue,
      totalChecks: totalReports,
      revenueWithDiscounts,
      revenueWithoutDiscounts,
      discountCheckCount: discountedReports,
      noDiscountCheckCount: noDiscountReports,
      totalDiscountAmount,
      avgDiscountPct:
        totalRevenue > 0 ? (totalDiscountAmount / totalRevenue) * 100 : 0
    },
    promos,
    salesWithoutDiscounts: {
      checkCount: noDiscountReports,
      revenue: revenueWithoutDiscounts,
      avgCheck:
        noDiscountReports > 0 ? revenueWithoutDiscounts / noDiscountReports : 0
    },
    salesWithDiscounts: {
      checkCount: discountedReports,
      revenue: revenueWithDiscounts,
      discountAmount: totalDiscountAmount,
      avgCheck:
        discountedReports > 0 ? revenueWithDiscounts / discountedReports : 0
    },
    stores,
    storePromos,
    promoAnalytics
  };
}

function analyticsMetrics(revenue: number, discountAmount: number, reportCount: number) {
  return {
    avgCheck: reportCount > 0 ? revenue / reportCount : 0,
    avgDiscountPct: revenue > 0 ? (discountAmount / revenue) * 100 : 0,
    roi: discountAmount > 0 ? (revenue - discountAmount) / discountAmount : 0
  };
}

function buildPromoAnalytics(rows: PromoAnalyticsRow[]) {
  type PromoAnalyticsItem = {
    key: string;
    name: string;
    checkCount: number;
    quantity: number;
    revenue: number;
    discountAmount: number;
    avgPrice: number;
    avgDiscountPct: number;
    roi: number;
    lastSaleDate: string | null;
  };

  type PromoAnalyticsStore = {
    key: string;
    name: string;
    checkCount: number;
    itemCount: number;
    quantity: number;
    checkRevenue: number;
    itemRevenue: number;
    discountAmount: number;
    avgCheck: number;
    avgDiscountPct: number;
    roi: number;
    items: PromoAnalyticsItem[];
  };

  type PromoAnalytics = {
    key: string;
    name: string;
    checkCount: number;
    storeCount: number;
    itemCount: number;
    quantity: number;
    checkRevenue: number;
    itemRevenue: number;
    discountAmount: number;
    avgCheck: number;
    avgDiscountPct: number;
    roi: number;
    stores: PromoAnalyticsStore[];
  };

  const promos = new Map<string, PromoAnalytics>();
  const storeMaps = new Map<string, Map<string, PromoAnalyticsStore>>();

  for (const row of rows) {
    const promoKey = row.promo_key;
    const promoRevenue = Number(row.promo_item_revenue ?? 0);
    const promoDiscount = Number(row.promo_discount_amount ?? 0);
    const promoReportCount = Number(row.promo_check_count ?? 0);

    let promo = promos.get(promoKey);
    if (!promo) {
      promo = {
        key: promoKey,
        name: row.promo_name ?? promoKey,
        checkCount: promoReportCount,
        storeCount: Number(row.promo_store_count ?? 0),
        itemCount: Number(row.promo_item_count ?? 0),
        quantity: Number(row.promo_quantity ?? 0),
        checkRevenue: Number(row.promo_check_revenue ?? 0),
        itemRevenue: promoRevenue,
        discountAmount: promoDiscount,
        ...analyticsMetrics(promoRevenue, promoDiscount, promoReportCount),
        stores: []
      };
      promos.set(promoKey, promo);
      storeMaps.set(promoKey, new Map());
    }

    const stores = storeMaps.get(promoKey)!;
    const storeKey = row.store_key;
    let store = stores.get(storeKey);
    if (!store) {
      const storeRevenue = Number(row.store_item_revenue ?? 0);
      const storeDiscount = Number(row.store_discount_amount ?? 0);
      const storeReportCount = Number(row.store_check_count ?? 0);
      store = {
        key: storeKey,
        name: row.store_name ?? storeKey,
        checkCount: storeReportCount,
        itemCount: Number(row.store_item_count ?? 0),
        quantity: Number(row.store_quantity ?? 0),
        checkRevenue: Number(row.store_check_revenue ?? 0),
        itemRevenue: storeRevenue,
        discountAmount: storeDiscount,
        ...analyticsMetrics(storeRevenue, storeDiscount, storeReportCount),
        items: []
      };
      stores.set(storeKey, store);
      promo.stores.push(store);
    }

    if (row.item_key) {
      const itemRevenue = Number(row.item_revenue ?? 0);
      const itemDiscount = Number(row.item_discount_amount ?? 0);
      const itemReportCount = Number(row.item_check_count ?? 0);
      const itemQuantity = Number(row.item_quantity ?? 0);
      const itemMetrics = analyticsMetrics(itemRevenue, itemDiscount, itemReportCount);

      store.items.push({
        key: row.item_key,
        name: row.item_name ?? row.item_key,
        checkCount: itemReportCount,
        quantity: itemQuantity,
        revenue: itemRevenue,
        discountAmount: itemDiscount,
        avgPrice: itemQuantity > 0 ? itemRevenue / itemQuantity : 0,
        avgDiscountPct: itemMetrics.avgDiscountPct,
        roi: itemMetrics.roi,
        lastSaleDate: row.item_last_sale_at?.toISOString() ?? null
      });
    }
  }

  return [...promos.values()].map((promo) => ({
    ...promo,
    stores: promo.stores
      .sort((a, b) => b.itemRevenue - a.itemRevenue)
      .map((store) => ({
        ...store,
        items: store.items.sort((a, b) => b.revenue - a.revenue)
      }))
  }));
}
