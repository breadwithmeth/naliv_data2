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

function dateFilters(params: MarketingParams) {
  const filters: Prisma.Sql[] = [
    Prisma.sql`c.date is not null`,
    Prisma.sql`coalesce(c.deletion_mark, false) = false`,
    Prisma.sql`coalesce(c.posted, false) = true`,
    Prisma.sql`coalesce(c.vid_operatsii, 'Продажа') = 'Продажа'`,
    Prisma.sql`coalesce(c.summa_dokumenta, 0) > 0`
  ];

  if (params.from) {
    filters.push(Prisma.sql`c.date >= ${params.from}`);
  }

  if (params.to) {
    filters.push(Prisma.sql`c.date < ${params.to}`);
  }

  return Prisma.join(filters, " and ");
}

export async function getMarketingReport(params: MarketingParams) {
  const checksTable = qualifiedTable("document_chek_kkm");
  const discountsTable = qualifiedTable("document_chek_kkm_skidki_natsenki");
  const discountCatalogTable = qualifiedTable("catalog_skidki_natsenki");
  const magazinyTable = qualifiedTable("catalog_magaziny");

  const whereSql = dateFilters(params);

  // Summary: overall discount metrics
  const summaryRows = await prisma.$queryRaw<
    Array<{
      total_revenue: number | null;
      total_discount_amount: number | null;
      total_discount_checks: bigint | number;
      total_checks: bigint | number;
    }>
  >`
    with
    all_checks as (
      select
        c.ref_key,
        coalesce(c.summa_dokumenta, 0)::float8 as revenue
      from ${checksTable} c
      where ${whereSql}
    ),
    discount_data as (
      select
        d."_parent_ref_key" as check_key,
        coalesce(sum(d.summa), 0)::float8 as discount_amount
      from ${discountsTable} d
      where d."_parent_ref_key" is not null
      group by d."_parent_ref_key"
    )
    select
      coalesce(sum(ac.revenue), 0)::float8 as total_revenue,
      coalesce(sum(dd.discount_amount), 0)::float8 as total_discount_amount,
      count(dd.check_key) as total_discount_checks,
      count(*) as total_checks
    from all_checks ac
    left join discount_data dd on dd.check_key = ac.ref_key
  `;

  // Promotions breakdown
  const promoRows = await prisma.$queryRaw<
    Array<{
      skidka_key: string;
      promo_name: string | null;
      check_count: bigint | number;
      revenue: number | null;
      discount_amount: number | null;
      avg_discount_pct: number | null;
    }>
  >`
    with
    all_checks as (
      select
        c.ref_key,
        coalesce(c.summa_dokumenta, 0)::float8 as revenue
      from ${checksTable} c
      where ${whereSql}
    ),
    discount_detail as (
      select
        d."_parent_ref_key" as check_key,
        d.skidka_natsenka_key,
        coalesce(d.summa, 0)::float8 as discount_amount
      from ${discountsTable} d
      where d."_parent_ref_key" is not null
        and d.skidka_natsenka_key is not null
    )
    select
      dd.skidka_natsenka_key as skidka_key,
      coalesce(nullif(max(dc.description), ''), dd.skidka_natsenka_key) as promo_name,
      count(distinct dd.check_key) as check_count,
      coalesce(sum(ac.revenue), 0)::float8 as revenue,
      coalesce(sum(dd.discount_amount), 0)::float8 as discount_amount,
      case when coalesce(sum(ac.revenue), 0) > 0
        then (coalesce(sum(dd.discount_amount), 0) / coalesce(sum(ac.revenue), 0) * 100)::float8
        else 0
      end as avg_discount_pct
    from discount_detail dd
    join all_checks ac on ac.ref_key = dd.check_key
    left join ${discountCatalogTable} dc on dc.ref_key = dd.skidka_natsenka_key
    group by dd.skidka_natsenka_key
    order by revenue desc
  `;

  // Sales without discounts
  const noDiscountRows = await prisma.$queryRaw<
    Array<{
      check_count: bigint | number;
      revenue: number | null;
      avg_check: number | null;
    }>
  >`
    with
    all_checks as (
      select
        c.ref_key,
        coalesce(c.summa_dokumenta, 0)::float8 as revenue
      from ${checksTable} c
      where ${whereSql}
    ),
    discount_checks as (
      select distinct "_parent_ref_key" as check_key
      from ${discountsTable}
      where "_parent_ref_key" is not null
    )
    select
      count(*) as check_count,
      coalesce(sum(ac.revenue), 0)::float8 as revenue,
      coalesce(avg(ac.revenue), 0)::float8 as avg_check
    from all_checks ac
    left join discount_checks dc on dc.check_key = ac.ref_key
    where dc.check_key is null
  `;

  // Revenue with discounts applied
  const withDiscountRows = await prisma.$queryRaw<
    Array<{
      check_count: bigint | number;
      revenue: number | null;
      discount_amount: number | null;
      avg_check: number | null;
    }>
  >`
    with
    all_checks as (
      select
        c.ref_key,
        coalesce(c.summa_dokumenta, 0)::float8 as revenue
      from ${checksTable} c
      where ${whereSql}
    ),
    discount_data as (
      select
        d."_parent_ref_key" as check_key,
        coalesce(sum(d.summa), 0)::float8 as discount_amount
      from ${discountsTable} d
      where d."_parent_ref_key" is not null
      group by d."_parent_ref_key"
    )
    select
      count(*) as check_count,
      coalesce(sum(ac.revenue), 0)::float8 as revenue,
      coalesce(sum(dd.discount_amount), 0)::float8 as discount_amount,
      coalesce(avg(ac.revenue), 0)::float8 as avg_check
    from all_checks ac
    join discount_data dd on dd.check_key = ac.ref_key
  `;

  // Store-level discount summary
  const storeSummaryRows = await prisma.$queryRaw<
    Array<{
      magazin_key: string;
      store_name: string | null;
      total_checks: bigint | number;
      total_revenue: number | null;
      discount_checks: bigint | number;
      discount_amount: number | null;
      avg_discount_pct: number | null;
    }>
  >`
    with
    all_checks as (
      select
        c.ref_key,
        coalesce(nullif(c.magazin_key, ''), 'Без магазина') as magazin_key,
        coalesce(c.summa_dokumenta, 0)::float8 as revenue
      from ${checksTable} c
      where ${whereSql}
    ),
    discount_data as (
      select
        d."_parent_ref_key" as check_key,
        coalesce(sum(d.summa), 0)::float8 as discount_amount
      from ${discountsTable} d
      where d."_parent_ref_key" is not null
      group by d."_parent_ref_key"
    ),
    store_stats as (
      select
        ac.magazin_key,
        count(*) as total_checks,
        coalesce(sum(ac.revenue), 0)::float8 as total_revenue,
        count(dd.check_key) as discount_checks,
        coalesce(sum(dd.discount_amount), 0)::float8 as discount_amount
      from all_checks ac
      left join discount_data dd on dd.check_key = ac.ref_key
      group by ac.magazin_key
    )
    select
      ss.magazin_key,
      coalesce(nullif(max(m.description), ''), ss.magazin_key) as store_name,
      ss.total_checks,
      ss.total_revenue,
      ss.discount_checks,
      ss.discount_amount,
      case when ss.total_revenue > 0
        then (ss.discount_amount / ss.total_revenue * 100)::float8
        else 0
      end as avg_discount_pct
    from store_stats ss
    left join ${magazinyTable} m on m.ref_key = ss.magazin_key
    group by ss.magazin_key, ss.total_checks, ss.total_revenue, ss.discount_checks, ss.discount_amount
    order by ss.total_revenue desc
  `;

  // Store × Promo breakdown
  const storePromoRows = await prisma.$queryRaw<
    Array<{
      magazin_key: string;
      store_name: string | null;
      skidka_key: string;
      promo_name: string | null;
      check_count: bigint | number;
      revenue: number | null;
      discount_amount: number | null;
      avg_discount_pct: number | null;
    }>
  >`
    with
    all_checks as (
      select
        c.ref_key,
        coalesce(nullif(c.magazin_key, ''), 'Без магазина') as magazin_key,
        coalesce(c.summa_dokumenta, 0)::float8 as revenue
      from ${checksTable} c
      where ${whereSql}
    ),
    discount_detail as (
      select
        d."_parent_ref_key" as check_key,
        d.skidka_natsenka_key,
        coalesce(d.summa, 0)::float8 as discount_amount
      from ${discountsTable} d
      where d."_parent_ref_key" is not null
        and d.skidka_natsenka_key is not null
    )
    select
      ac.magazin_key,
      coalesce(nullif(max(m.description), ''), ac.magazin_key) as store_name,
      dd.skidka_natsenka_key as skidka_key,
      coalesce(nullif(max(dc.description), ''), dd.skidka_natsenka_key) as promo_name,
      count(distinct dd.check_key) as check_count,
      coalesce(sum(ac.revenue), 0)::float8 as revenue,
      coalesce(sum(dd.discount_amount), 0)::float8 as discount_amount,
      case when coalesce(sum(ac.revenue), 0) > 0
        then (coalesce(sum(dd.discount_amount), 0) / coalesce(sum(ac.revenue), 0) * 100)::float8
        else 0
      end as avg_discount_pct
    from discount_detail dd
    join all_checks ac on ac.ref_key = dd.check_key
    left join ${magazinyTable} m on m.ref_key = ac.magazin_key
    left join ${discountCatalogTable} dc on dc.ref_key = dd.skidka_natsenka_key
    group by ac.magazin_key, dd.skidka_natsenka_key
    order by ac.magazin_key, revenue desc
  `;

  const summary = summaryRows[0];
  const noDiscount = noDiscountRows[0];
  const withDiscount = withDiscountRows[0];
  const totalRevenue = Number(summary?.total_revenue ?? 0);
  const totalDiscount = Number(summary?.total_discount_amount ?? 0);
  const totalChecks = Number(summary?.total_checks ?? 0);

  return {
    period: params.period,
    summary: {
      totalRevenue,
      totalChecks,
      revenueWithDiscounts: Number(withDiscount?.revenue ?? 0),
      revenueWithoutDiscounts: Number(noDiscount?.revenue ?? 0),
      discountCheckCount: Number(withDiscount?.check_count ?? 0),
      noDiscountCheckCount: Number(noDiscount?.check_count ?? 0),
      totalDiscountAmount: totalDiscount,
      avgDiscountPct: totalRevenue > 0 ? (totalDiscount / totalRevenue * 100) : 0
    },
    promos: promoRows.map((row) => ({
      key: row.skidka_key,
      name: row.promo_name ?? row.skidka_key,
      checkCount: Number(row.check_count ?? 0),
      revenue: Number(row.revenue ?? 0),
      discountAmount: Number(row.discount_amount ?? 0),
      avgDiscountPct: Number(row.avg_discount_pct ?? 0)
    })),
    salesWithoutDiscounts: {
      checkCount: Number(noDiscount?.check_count ?? 0),
      revenue: Number(noDiscount?.revenue ?? 0),
      avgCheck: Number(noDiscount?.avg_check ?? 0)
    },
    salesWithDiscounts: {
      checkCount: Number(withDiscount?.check_count ?? 0),
      revenue: Number(withDiscount?.revenue ?? 0),
      discountAmount: Number(withDiscount?.discount_amount ?? 0),
      avgCheck: Number(withDiscount?.avg_check ?? 0)
    },
    stores: storeSummaryRows.map((row) => ({
      key: row.magazin_key,
      name: row.store_name ?? row.magazin_key,
      totalChecks: Number(row.total_checks ?? 0),
      totalRevenue: Number(row.total_revenue ?? 0),
      discountChecks: Number(row.discount_checks ?? 0),
      discountAmount: Number(row.discount_amount ?? 0),
      avgDiscountPct: Number(row.avg_discount_pct ?? 0)
    })),
    storePromos: storePromoRows.map((row) => ({
      storeKey: row.magazin_key,
      storeName: row.store_name ?? row.magazin_key,
      promoKey: row.skidka_key,
      promoName: row.promo_name ?? row.skidka_key,
      checkCount: Number(row.check_count ?? 0),
      revenue: Number(row.revenue ?? 0),
      discountAmount: Number(row.discount_amount ?? 0),
      avgDiscountPct: Number(row.avg_discount_pct ?? 0)
    }))
  };
}
