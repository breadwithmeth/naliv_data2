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

type ActiveMarketingActionRow = {
  promo_key: string;
  promo_name: string | null;
  start_at: Date | null;
  end_at: Date | null;
  all_stores: boolean | null;
  rule_count: bigint | number;
  discount_key_count: bigint | number;
  store_key: string | null;
  store_name: string | null;
};

type MarketingPromoSummary = {
  key: string;
  name: string;
  checkCount: number;
  revenue: number;
  discountAmount: number;
  avgDiscountPct: number;
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

function activeActionFilters(params: MarketingParams) {
  const filters: Prisma.Sql[] = [
    Prisma.sql`coalesce(ma.deletion_mark, false) = false`,
    Prisma.sql`coalesce(ma.posted, false) = true`
  ];

  if (params.from) {
    filters.push(Prisma.sql`coalesce(ma.data_okonchaniya_deystviya, 'infinity'::timestamp) >= ${params.from}`);
  }

  if (params.to) {
    filters.push(Prisma.sql`coalesce(ma.data_nachala_deystviya, ma.date, '-infinity'::timestamp) < ${params.to}`);
  }

  return Prisma.join(filters, " and ");
}

function activeActionRuleFilters(params: MarketingParams) {
  const filters: Prisma.Sql[] = [
    Prisma.sql`coalesce(ma.deletion_mark, false) = false`,
    Prisma.sql`coalesce(ma.posted, false) = true`,
    Prisma.sql`masn."_parent_ref_key" is not null`,
    Prisma.sql`masn.skidka_natsenka_key is not null`
  ];

  if (params.from) {
    filters.push(Prisma.sql`coalesce(masn.data_okonchaniya, ma.data_okonchaniya_deystviya, 'infinity'::timestamp) >= ${params.from}`);
  }

  if (params.to) {
    filters.push(Prisma.sql`coalesce(masn.data_nachala, ma.data_nachala_deystviya, ma.date, '-infinity'::timestamp) < ${params.to}`);
  }

  return Prisma.join(filters, " and ");
}

export async function getMarketingReport(params: MarketingParams) {
  const checksTable = qualifiedTable("document_chek_kkm");
  const checkItemsTable = qualifiedTable("document_chek_kkm_tovary");
  const retailReportsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const retailReportItemsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_tovary");
  const discountsTable = qualifiedTable("document_chek_kkm_skidki_natsenki");
  const discountCatalogTable = qualifiedTable("catalog_skidki_natsenki");
  const magazinyTable = qualifiedTable("catalog_magaziny");
  const nomenklaturaTable = qualifiedTable("catalog_nomenklatura");
  const marketingActionsTable = qualifiedTable("document_marketingovaya_aktsiya");
  const marketingActionDiscountsTable = qualifiedTable("document_marketingovaya_aktsiya_skidki_natsenki");
  const marketingActionStoresTable = qualifiedTable("document_marketingovaya_aktsiya_magaziny");
  const emptyRef = "00000000-0000-0000-0000-000000000000";

  const whereSql = dateFilters(params);
  const retailWhereSql = retailReportFilters(params);
  const activeActionsWhereSql = activeActionFilters(params);
  const activeActionRuleWhereSql = activeActionRuleFilters(params);

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
      case when dd.skidka_natsenka_key = ${emptyRef}
        then 'Без указанной акции'
        else coalesce(nullif(max(dc.description), ''), dd.skidka_natsenka_key)
      end as promo_name,
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
      case when dd.skidka_natsenka_key = ${emptyRef}
        then 'Без указанной акции'
        else coalesce(nullif(max(dc.description), ''), dd.skidka_natsenka_key)
      end as promo_name,
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

  const retailSummaryRows = await prisma.$queryRaw<
    Array<{
      report_count: bigint | number;
      revenue: number | null;
    }>
  >`
    select
      count(*) as report_count,
      coalesce(sum(r.summa_dokumenta), 0)::float8 as revenue
    from ${retailReportsTable} r
    where ${retailWhereSql}
  `;

  const retailStoreRows = await prisma.$queryRaw<
    Array<{
      magazin_key: string;
      store_name: string | null;
      report_count: bigint | number;
      revenue: number | null;
    }>
  >`
    select
      coalesce(nullif(r.magazin_key, ''), 'Без магазина') as magazin_key,
      coalesce(nullif(max(m.description), ''), coalesce(nullif(r.magazin_key, ''), 'Без магазина')) as store_name,
      count(*) as report_count,
      coalesce(sum(r.summa_dokumenta), 0)::float8 as revenue
    from ${retailReportsTable} r
    left join ${magazinyTable} m on m.ref_key = r.magazin_key
    where ${retailWhereSql}
    group by coalesce(nullif(r.magazin_key, ''), 'Без магазина')
    order by revenue desc
  `;

  const activeActionRows = await prisma.$queryRaw<ActiveMarketingActionRow[]>`
    with
    active_actions as (
      select
        ma.ref_key,
        coalesce(nullif(ma.naimenovanie_aktsii, ''), ma.ref_key) as promo_name,
        coalesce(ma.data_nachala_deystviya, ma.date) as start_at,
        ma.data_okonchaniya_deystviya as end_at,
        coalesce(ma.dlya_vseh_magazinov, false) as all_stores
      from ${marketingActionsTable} ma
      where ${activeActionsWhereSql}
    ),
    action_rules as (
      select
        masn."_parent_ref_key" as promo_key,
        count(*) as rule_count,
        count(distinct masn.skidka_natsenka_key) filter (where masn.skidka_natsenka_key is not null) as discount_key_count
      from ${marketingActionDiscountsTable} masn
      join ${marketingActionsTable} ma on ma.ref_key = masn."_parent_ref_key"
      where ${activeActionRuleWhereSql}
      group by masn."_parent_ref_key"
    ),
    action_stores as (
      select distinct
        am."_parent_ref_key" as promo_key,
        nullif(am.magazin_key, '') as store_key
      from ${marketingActionStoresTable} am
      where am."_parent_ref_key" is not null
    )
    select
      aa.ref_key as promo_key,
      aa.promo_name,
      aa.start_at,
      aa.end_at,
      aa.all_stores,
      coalesce(ar.rule_count, 0) as rule_count,
      coalesce(ar.discount_key_count, 0) as discount_key_count,
      ast.store_key,
      coalesce(nullif(max(m.description), ''), ast.store_key) as store_name
    from active_actions aa
    left join action_rules ar on ar.promo_key = aa.ref_key
    left join action_stores ast on ast.promo_key = aa.ref_key
    left join ${magazinyTable} m on m.ref_key = ast.store_key
    group by
      aa.ref_key, aa.promo_name, aa.start_at, aa.end_at, aa.all_stores,
      ar.rule_count, ar.discount_key_count, ast.store_key
    order by aa.start_at desc nulls last, aa.promo_name
  `;

  const promoAnalyticsRows = await prisma.$queryRaw<PromoAnalyticsRow[]>`
    with
    all_checks as (
      select
        c.ref_key,
        c.date as sale_at,
        coalesce(nullif(c.magazin_key, ''), 'Без магазина') as store_key,
        coalesce(c.summa_dokumenta, 0)::float8 as revenue
      from ${checksTable} c
      where ${whereSql}
    ),
    action_rules as (
      select distinct on (masn.skidka_natsenka_key)
        masn.skidka_natsenka_key,
        coalesce(nullif(ma.ref_key, ''), nullif(masn."_parent_ref_key", ''), masn.skidka_natsenka_key) as action_key,
        coalesce(nullif(ma.naimenovanie_aktsii, ''), nullif(dc.description, ''), masn.skidka_natsenka_key) as action_name
      from ${marketingActionDiscountsTable} masn
      left join ${marketingActionsTable} ma
        on ma.ref_key = masn."_parent_ref_key"
        and coalesce(ma.deletion_mark, false) = false
      left join ${discountCatalogTable} dc on dc.ref_key = masn.skidka_natsenka_key
      where masn.skidka_natsenka_key is not null
      order by masn.skidka_natsenka_key, ma.date desc nulls last
    ),
    discount_lines as (
      select
        d."_parent_ref_key" as check_key,
        nullif(d.klyuch_svyazi, '') as klyuch_svyazi,
        case when d.skidka_natsenka_key = ${emptyRef}
          then d.skidka_natsenka_key
          else coalesce(ar.action_key, d.skidka_natsenka_key)
        end as promo_key,
        case when d.skidka_natsenka_key = ${emptyRef}
          then 'Без указанной акции'
          else coalesce(ar.action_name, nullif(dc.description, ''), d.skidka_natsenka_key)
        end as promo_name,
        coalesce(sum(d.summa), 0)::float8 as discount_amount
      from ${discountsTable} d
      left join action_rules ar on ar.skidka_natsenka_key = d.skidka_natsenka_key
      left join ${discountCatalogTable} dc on dc.ref_key = d.skidka_natsenka_key
      where d."_parent_ref_key" is not null
        and d.skidka_natsenka_key is not null
      group by
        d."_parent_ref_key",
        nullif(d.klyuch_svyazi, ''),
        d.skidka_natsenka_key,
        ar.action_key,
        ar.action_name,
        dc.description
    ),
    promo_checks as (
      select
        dl.promo_key,
        dl.promo_name,
        ac.ref_key as check_key,
        ac.store_key,
        max(ac.revenue)::float8 as check_revenue,
        coalesce(sum(dl.discount_amount), 0)::float8 as discount_amount
      from discount_lines dl
      join all_checks ac on ac.ref_key = dl.check_key
      group by dl.promo_key, dl.promo_name, ac.ref_key, ac.store_key
    ),
    check_items as (
      select
        t."_parent_ref_key" as check_key,
        nullif(t.klyuch_svyazi, '') as klyuch_svyazi,
        t.nomenklatura_key,
        coalesce(sum(t.kolichestvo), 0)::float8 as quantity,
        coalesce(sum(t.summa), 0)::float8 as item_revenue
      from ${checkItemsTable} t
      where t."_parent_ref_key" is not null
        and t.nomenklatura_key is not null
        and coalesce(t.kolichestvo, 0) > 0
      group by t."_parent_ref_key", nullif(t.klyuch_svyazi, ''), t.nomenklatura_key
    ),
    check_item_totals as (
      select
        check_key,
        coalesce(sum(item_revenue), 0)::float8 as items_revenue
      from check_items
      group by check_key
    ),
    promo_item_lines_raw as (
      select
        dl.promo_key,
        dl.promo_name,
        ac.ref_key as check_key,
        ac.store_key,
        ac.sale_at,
        ci.nomenklatura_key,
        ci.quantity,
        ci.item_revenue,
        dl.discount_amount
      from discount_lines dl
      join all_checks ac on ac.ref_key = dl.check_key
      join check_items ci
        on ci.check_key = dl.check_key
        and ci.klyuch_svyazi = dl.klyuch_svyazi
      where dl.klyuch_svyazi is not null

      union all

      select
        dl.promo_key,
        dl.promo_name,
        ac.ref_key as check_key,
        ac.store_key,
        ac.sale_at,
        ci.nomenklatura_key,
        ci.quantity,
        ci.item_revenue,
        case when coalesce(cit.items_revenue, 0) > 0
          then (dl.discount_amount * ci.item_revenue / cit.items_revenue)::float8
          else 0
        end as discount_amount
      from discount_lines dl
      join all_checks ac on ac.ref_key = dl.check_key
      join check_items ci on ci.check_key = dl.check_key
      left join check_item_totals cit on cit.check_key = dl.check_key
      where dl.klyuch_svyazi is null
    ),
    promo_item_lines as (
      select
        promo_key,
        promo_name,
        check_key,
        store_key,
        nomenklatura_key,
        max(sale_at) as sale_at,
        max(quantity)::float8 as quantity,
        max(item_revenue)::float8 as item_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from promo_item_lines_raw
      group by promo_key, promo_name, check_key, store_key, nomenklatura_key
    ),
    promo_check_rollup as (
      select
        promo_key,
        promo_name,
        count(distinct check_key) as check_count,
        count(distinct store_key) as store_count,
        coalesce(sum(check_revenue), 0)::float8 as check_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from promo_checks
      group by promo_key, promo_name
    ),
    promo_item_rollup as (
      select
        promo_key,
        coalesce(sum(quantity), 0)::float8 as quantity,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        count(distinct nomenklatura_key) as item_count
      from promo_item_lines
      group by promo_key
    ),
    promo_totals as (
      select
        pcr.promo_key,
        pcr.promo_name,
        pcr.check_count,
        pcr.store_count,
        coalesce(pir.item_count, 0) as item_count,
        coalesce(pir.quantity, 0)::float8 as quantity,
        pcr.check_revenue,
        coalesce(pir.item_revenue, 0)::float8 as item_revenue,
        pcr.discount_amount
      from promo_check_rollup pcr
      left join promo_item_rollup pir on pir.promo_key = pcr.promo_key
    ),
    store_check_rollup as (
      select
        promo_key,
        promo_name,
        store_key,
        count(distinct check_key) as check_count,
        coalesce(sum(check_revenue), 0)::float8 as check_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from promo_checks
      group by promo_key, promo_name, store_key
    ),
    store_item_rollup as (
      select
        promo_key,
        store_key,
        coalesce(sum(quantity), 0)::float8 as quantity,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        count(distinct nomenklatura_key) as item_count
      from promo_item_lines
      group by promo_key, store_key
    ),
    store_totals as (
      select
        scr.promo_key,
        scr.promo_name,
        scr.store_key,
        scr.check_count,
        coalesce(sir.item_count, 0) as item_count,
        coalesce(sir.quantity, 0)::float8 as quantity,
        scr.check_revenue,
        coalesce(sir.item_revenue, 0)::float8 as item_revenue,
        scr.discount_amount
      from store_check_rollup scr
      left join store_item_rollup sir
        on sir.promo_key = scr.promo_key
        and sir.store_key = scr.store_key
    ),
    item_rollup as (
      select
        promo_key,
        promo_name,
        store_key,
        nomenklatura_key,
        count(distinct check_key) as check_count,
        coalesce(sum(quantity), 0)::float8 as quantity,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount,
        max(sale_at) as last_sale_at
      from promo_item_lines
      group by promo_key, promo_name, store_key, nomenklatura_key
    )
    select
      pt.promo_key,
      pt.promo_name,
      pt.check_count as promo_check_count,
      pt.store_count as promo_store_count,
      pt.item_count as promo_item_count,
      pt.quantity as promo_quantity,
      pt.check_revenue as promo_check_revenue,
      pt.item_revenue as promo_item_revenue,
      pt.discount_amount as promo_discount_amount,
      st.store_key,
      coalesce(nullif(max(m.description), ''), st.store_key) as store_name,
      st.check_count as store_check_count,
      st.item_count as store_item_count,
      st.quantity as store_quantity,
      st.check_revenue as store_check_revenue,
      st.item_revenue as store_item_revenue,
      st.discount_amount as store_discount_amount,
      ir.nomenklatura_key as item_key,
      coalesce(nullif(max(n.naimenovanie_polnoe), ''), nullif(max(n.description), ''), ir.nomenklatura_key) as item_name,
      ir.check_count as item_check_count,
      ir.quantity as item_quantity,
      ir.item_revenue,
      ir.discount_amount as item_discount_amount,
      ir.last_sale_at as item_last_sale_at
    from store_totals st
    join promo_totals pt on pt.promo_key = st.promo_key
    left join item_rollup ir
      on ir.promo_key = st.promo_key
      and ir.store_key = st.store_key
    left join ${magazinyTable} m on m.ref_key = st.store_key
    left join ${nomenklaturaTable} n on n.ref_key = ir.nomenklatura_key
    group by
      pt.promo_key, pt.promo_name, pt.check_count, pt.store_count, pt.item_count,
      pt.quantity, pt.check_revenue, pt.item_revenue, pt.discount_amount,
      st.store_key, st.check_count, st.item_count, st.quantity, st.check_revenue,
      st.item_revenue, st.discount_amount, ir.nomenklatura_key, ir.check_count,
      ir.quantity, ir.item_revenue, ir.discount_amount, ir.last_sale_at
    order by pt.item_revenue desc, st.item_revenue desc, ir.item_revenue desc nulls last
  `;

  const promoAnalyticsByItemRows = await prisma.$queryRaw<PromoAnalyticsRow[]>`
    with
    active_rules as (
      select
        ma.ref_key as promo_key,
        coalesce(nullif(ma.naimenovanie_aktsii, ''), ma.ref_key) as promo_name,
        nullif(masn.magazin_key, '') as rule_store_key,
        coalesce(dc.znachenie_skidki_natsenki, 0)::float8 as discount_pct,
        coalesce(masn.data_nachala, ma.data_nachala_deystviya, ma.date) as rule_start,
        coalesce(masn.data_okonchaniya, ma.data_okonchaniya_deystviya) as rule_end,
        coalesce(ma.dlya_vseh_magazinov, false) as all_stores
      from ${marketingActionDiscountsTable} masn
      join ${marketingActionsTable} ma on ma.ref_key = masn."_parent_ref_key"
      left join ${discountCatalogTable} dc on dc.ref_key = masn.skidka_natsenka_key
      where ${activeActionRuleWhereSql}
        and coalesce(dc.znachenie_skidki_natsenki, 0) <> 0
    ),
    action_stores as (
      select distinct
        am."_parent_ref_key" as promo_key,
        nullif(am.magazin_key, '') as store_key
      from ${marketingActionStoresTable} am
      where am."_parent_ref_key" is not null
        and nullif(am.magazin_key, '') is not null
    ),
    action_store_counts as (
      select
        promo_key,
        count(*) as store_count
      from action_stores
      group by promo_key
    ),
    all_checks as (
      select
        c.ref_key,
        c.date as sale_at,
        coalesce(nullif(c.magazin_key, ''), 'Без магазина') as store_key
      from ${checksTable} c
      where ${whereSql}
    ),
    check_item_source as (
      select
        'check' as source_type,
        ac.ref_key as check_key,
        ac.sale_at,
        ac.store_key,
        coalesce(t."_parent_line_index"::text, t.line_number::text, t.nomenklatura_key) as line_key,
        t.nomenklatura_key,
        coalesce(t.kolichestvo, 0)::float8 as quantity,
        coalesce(t.summa, 0)::float8 as item_revenue,
        (
          coalesce(t.summa_avtomaticheskoy_skidki, 0)
          + coalesce(t.summa_ruchnoy_skidki, 0)
          + coalesce(t.summa_skidki_oplaty_bonusom, 0)
        )::float8 as discount_amount,
        nullif(coalesce(t.protsent_avtomaticheskoy_skidki, 0), 0)::float8 as auto_discount_pct,
        nullif(coalesce(t.protsent_ruchnoy_skidki, 0), 0)::float8 as manual_discount_pct
      from all_checks ac
      join ${checkItemsTable} t on t."_parent_ref_key" = ac.ref_key
      where t.nomenklatura_key is not null
        and coalesce(t.kolichestvo, 0) > 0
    ),
    check_item_rows as (
      select
        source_type,
        check_key,
        sale_at,
        store_key,
        line_key,
        nomenklatura_key,
        quantity,
        item_revenue,
        discount_amount,
        coalesce(
          auto_discount_pct,
          manual_discount_pct,
          case
            when discount_amount > 0 and item_revenue + discount_amount > 0
              then (discount_amount / (item_revenue + discount_amount) * 100)::float8
            else 0
          end
        ) as discount_pct
      from check_item_source
      where discount_amount > 0
        or auto_discount_pct is not null
        or manual_discount_pct is not null
    ),
    retail_reports as (
      select
        r.ref_key,
        r.date as sale_at,
        coalesce(nullif(r.magazin_key, ''), 'Без магазина') as store_key
      from ${retailReportsTable} r
      where ${retailWhereSql}
    ),
    retail_item_rows as (
      select
        'retail_report' as source_type,
        rr.ref_key as check_key,
        rr.sale_at,
        rr.store_key,
        coalesce(t."_parent_line_index"::text, t.line_number::text, t.nomenklatura_key) as line_key,
        t.nomenklatura_key,
        coalesce(t.kolichestvo, 0)::float8 as quantity,
        coalesce(t.summa, 0)::float8 as item_revenue,
        case
          when coalesce(t.protsent_skidki_natsenki, 0) > 0
            and coalesce(t.protsent_skidki_natsenki, 0) < 100
            then (coalesce(t.summa, 0) * coalesce(t.protsent_skidki_natsenki, 0) / (100 - coalesce(t.protsent_skidki_natsenki, 0)))::float8
          else 0
        end as discount_amount,
        coalesce(t.protsent_skidki_natsenki, 0)::float8 as discount_pct
      from retail_reports rr
      join ${retailReportItemsTable} t on t."_parent_ref_key" = rr.ref_key
      where t.nomenklatura_key is not null
        and coalesce(t.kolichestvo, 0) > 0
        and coalesce(t.protsent_skidki_natsenki, 0) > 0
    ),
    item_rows as (
      select * from check_item_rows

      union all

      select * from retail_item_rows
      where not exists (select 1 from check_item_rows)
    ),
    matched_item_rows as (
      select *
      from (
        select
          ar.promo_key,
          ar.promo_name,
          ir.check_key,
          ir.sale_at,
          ir.store_key,
          ir.line_key,
          ir.nomenklatura_key,
          ir.quantity,
          ir.item_revenue,
          ir.discount_amount,
          row_number() over (
            partition by ir.source_type, ir.check_key, ir.line_key, ir.nomenklatura_key
            order by
              case when ar.rule_store_key = ir.store_key then 0 else 1 end,
              ar.rule_start desc nulls last,
              ar.promo_key
          ) as match_rank
        from item_rows ir
        join active_rules ar
          on round(ir.discount_pct::numeric, 2) = round(ar.discount_pct::numeric, 2)
          and ir.sale_at >= coalesce(ar.rule_start, ir.sale_at)
          and (ar.rule_end is null or ir.sale_at <= ar.rule_end)
        left join action_store_counts ascnt on ascnt.promo_key = ar.promo_key
        left join action_stores ast
          on ast.promo_key = ar.promo_key
          and ast.store_key = ir.store_key
        where (ar.rule_store_key is null or ar.rule_store_key = ir.store_key)
          and (ar.all_stores or coalesce(ascnt.store_count, 0) = 0 or ast.store_key is not null)
      ) ranked
      where match_rank = 1
    ),
    promo_item_lines as (
      select
        promo_key,
        promo_name,
        check_key,
        store_key,
        nomenklatura_key,
        max(sale_at) as sale_at,
        coalesce(sum(quantity), 0)::float8 as quantity,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from matched_item_rows
      group by promo_key, promo_name, check_key, store_key, nomenklatura_key
    ),
    promo_docs as (
      select
        promo_key,
        promo_name,
        check_key,
        store_key,
        coalesce(sum(item_revenue), 0)::float8 as check_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from promo_item_lines
      group by promo_key, promo_name, check_key, store_key
    ),
    promo_check_rollup as (
      select
        promo_key,
        promo_name,
        count(distinct check_key) as check_count,
        count(distinct store_key) as store_count,
        coalesce(sum(check_revenue), 0)::float8 as check_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from promo_docs
      group by promo_key, promo_name
    ),
    promo_item_rollup as (
      select
        promo_key,
        coalesce(sum(quantity), 0)::float8 as quantity,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        count(distinct nomenklatura_key) as item_count
      from promo_item_lines
      group by promo_key
    ),
    promo_totals as (
      select
        pcr.promo_key,
        pcr.promo_name,
        pcr.check_count,
        pcr.store_count,
        coalesce(pir.item_count, 0) as item_count,
        coalesce(pir.quantity, 0)::float8 as quantity,
        pcr.check_revenue,
        coalesce(pir.item_revenue, 0)::float8 as item_revenue,
        pcr.discount_amount
      from promo_check_rollup pcr
      left join promo_item_rollup pir on pir.promo_key = pcr.promo_key
    ),
    store_check_rollup as (
      select
        promo_key,
        promo_name,
        store_key,
        count(distinct check_key) as check_count,
        coalesce(sum(check_revenue), 0)::float8 as check_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount
      from promo_docs
      group by promo_key, promo_name, store_key
    ),
    store_item_rollup as (
      select
        promo_key,
        store_key,
        coalesce(sum(quantity), 0)::float8 as quantity,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        count(distinct nomenklatura_key) as item_count
      from promo_item_lines
      group by promo_key, store_key
    ),
    store_totals as (
      select
        scr.promo_key,
        scr.promo_name,
        scr.store_key,
        scr.check_count,
        coalesce(sir.item_count, 0) as item_count,
        coalesce(sir.quantity, 0)::float8 as quantity,
        scr.check_revenue,
        coalesce(sir.item_revenue, 0)::float8 as item_revenue,
        scr.discount_amount
      from store_check_rollup scr
      left join store_item_rollup sir
        on sir.promo_key = scr.promo_key
        and sir.store_key = scr.store_key
    ),
    item_rollup as (
      select
        promo_key,
        promo_name,
        store_key,
        nomenklatura_key,
        count(distinct check_key) as check_count,
        coalesce(sum(quantity), 0)::float8 as quantity,
        coalesce(sum(item_revenue), 0)::float8 as item_revenue,
        coalesce(sum(discount_amount), 0)::float8 as discount_amount,
        max(sale_at) as last_sale_at
      from promo_item_lines
      group by promo_key, promo_name, store_key, nomenklatura_key
    )
    select
      pt.promo_key,
      pt.promo_name,
      pt.check_count as promo_check_count,
      pt.store_count as promo_store_count,
      pt.item_count as promo_item_count,
      pt.quantity as promo_quantity,
      pt.check_revenue as promo_check_revenue,
      pt.item_revenue as promo_item_revenue,
      pt.discount_amount as promo_discount_amount,
      st.store_key,
      coalesce(nullif(max(m.description), ''), st.store_key) as store_name,
      st.check_count as store_check_count,
      st.item_count as store_item_count,
      st.quantity as store_quantity,
      st.check_revenue as store_check_revenue,
      st.item_revenue as store_item_revenue,
      st.discount_amount as store_discount_amount,
      ir.nomenklatura_key as item_key,
      coalesce(nullif(max(n.naimenovanie_polnoe), ''), nullif(max(n.description), ''), ir.nomenklatura_key) as item_name,
      ir.check_count as item_check_count,
      ir.quantity as item_quantity,
      ir.item_revenue,
      ir.discount_amount as item_discount_amount,
      ir.last_sale_at as item_last_sale_at
    from store_totals st
    join promo_totals pt on pt.promo_key = st.promo_key
    left join item_rollup ir
      on ir.promo_key = st.promo_key
      and ir.store_key = st.store_key
    left join ${magazinyTable} m on m.ref_key = st.store_key
    left join ${nomenklaturaTable} n on n.ref_key = ir.nomenklatura_key
    group by
      pt.promo_key, pt.promo_name, pt.check_count, pt.store_count, pt.item_count,
      pt.quantity, pt.check_revenue, pt.item_revenue, pt.discount_amount,
      st.store_key, st.check_count, st.item_count, st.quantity, st.check_revenue,
      st.item_revenue, st.discount_amount, ir.nomenklatura_key, ir.check_count,
      ir.quantity, ir.item_revenue, ir.discount_amount, ir.last_sale_at
    order by pt.item_revenue desc, st.item_revenue desc, ir.item_revenue desc nulls last
  `;

  const summary = summaryRows[0];
  const noDiscount = noDiscountRows[0];
  const withDiscount = withDiscountRows[0];
  const totalRevenue = Number(summary?.total_revenue ?? 0);
  const totalDiscount = Number(summary?.total_discount_amount ?? 0);
  const totalChecks = Number(summary?.total_checks ?? 0);
  const retailSummary = retailSummaryRows[0];
  const retailRevenue = Number(retailSummary?.revenue ?? 0);
  const retailReportCount = Number(retailSummary?.report_count ?? 0);
  const hasCheckSales = totalChecks > 0;
  const effectiveTotalRevenue = hasCheckSales ? totalRevenue : retailRevenue;
  const effectiveTotalChecks = hasCheckSales ? totalChecks : retailReportCount;
  const exactPromoKeys = new Set(promoAnalyticsRows.map((row) => row.promo_key));
  const combinedPromoAnalyticsRows = [
    ...promoAnalyticsRows,
    ...promoAnalyticsByItemRows.filter((row) => !exactPromoKeys.has(row.promo_key))
  ];
  const promoAnalytics = mergeActivePromoAnalytics(
    buildPromoAnalytics(combinedPromoAnalyticsRows),
    activeActionRows
  );
  const promoRowsSummaries = promoRows.map((row) => ({
    key: row.skidka_key,
    name: row.promo_name ?? row.skidka_key,
    checkCount: Number(row.check_count ?? 0),
    revenue: Number(row.revenue ?? 0),
    discountAmount: Number(row.discount_amount ?? 0),
    avgDiscountPct: Number(row.avg_discount_pct ?? 0)
  }));
  const analyticsPromoSummaries = promoSummariesFromAnalytics(promoAnalytics).filter(
    (promo) => promo.checkCount > 0 || promo.revenue > 0 || promo.discountAmount > 0
  );
  const promoSummaries = mergeActivePromoSummaries(
    promoRowsSummaries.length > 0 ? promoRowsSummaries : analyticsPromoSummaries,
    activeActionRows
  );
  const exactDiscountCheckCount = Number(withDiscount?.check_count ?? 0);
  const itemDerivedDiscountAmount = promoAnalytics.reduce((sum, promo) => sum + promo.discountAmount, 0);
  const itemDerivedDiscountRevenue = promoAnalytics.reduce(
    (sum, promo) => sum + (promo.itemRevenue > 0 ? promo.itemRevenue : promo.checkRevenue),
    0
  );
  const itemDerivedDiscountChecks = promoAnalytics.reduce((sum, promo) => sum + promo.checkCount, 0);
  const effectiveTotalDiscount = totalDiscount > 0 ? totalDiscount : itemDerivedDiscountAmount;
  const effectiveRevenueWithDiscounts = exactDiscountCheckCount > 0
    ? Number(withDiscount?.revenue ?? 0)
    : itemDerivedDiscountRevenue;
  const effectiveDiscountCheckCount = exactDiscountCheckCount > 0
    ? exactDiscountCheckCount
    : itemDerivedDiscountChecks;
  const effectiveRevenueWithoutDiscounts = exactDiscountCheckCount > 0
    ? Number(noDiscount?.revenue ?? 0)
    : Math.max(effectiveTotalRevenue - effectiveRevenueWithDiscounts, 0);
  const effectiveNoDiscountCheckCount = exactDiscountCheckCount > 0
    ? Number(noDiscount?.check_count ?? 0)
    : Math.max(effectiveTotalChecks - effectiveDiscountCheckCount, 0);
  const stores = storeSummaryRows.length > 0
    ? storeSummaryRows.map((row) => ({
        key: row.magazin_key,
        name: row.store_name ?? row.magazin_key,
        totalChecks: Number(row.total_checks ?? 0),
        totalRevenue: Number(row.total_revenue ?? 0),
        discountChecks: Number(row.discount_checks ?? 0),
        discountAmount: Number(row.discount_amount ?? 0),
        avgDiscountPct: Number(row.avg_discount_pct ?? 0)
      }))
    : retailStoreRows.map((row) => ({
        key: row.magazin_key,
        name: row.store_name ?? row.magazin_key,
        totalChecks: Number(row.report_count ?? 0),
        totalRevenue: Number(row.revenue ?? 0),
        discountChecks: 0,
        discountAmount: 0,
        avgDiscountPct: 0
      }));
  const exactStorePromos = storePromoRows.map((row) => ({
    storeKey: row.magazin_key,
    storeName: row.store_name ?? row.magazin_key,
    promoKey: row.skidka_key,
    promoName: row.promo_name ?? row.skidka_key,
    checkCount: Number(row.check_count ?? 0),
    revenue: Number(row.revenue ?? 0),
    discountAmount: Number(row.discount_amount ?? 0),
    avgDiscountPct: Number(row.avg_discount_pct ?? 0)
  }));
  const analyticsStorePromos = promoAnalytics.flatMap((promo) =>
    promo.stores
      .filter((store) => store.checkCount > 0 || store.itemRevenue > 0 || store.discountAmount > 0)
      .map((store) => ({
        storeKey: store.key,
        storeName: store.name,
        promoKey: promo.key,
        promoName: promo.name,
        checkCount: store.checkCount,
        revenue: store.itemRevenue > 0 ? store.itemRevenue : store.checkRevenue,
        discountAmount: store.discountAmount,
        avgDiscountPct: store.avgDiscountPct
      }))
  );

  return {
    period: params.period,
    summary: {
      totalRevenue: effectiveTotalRevenue,
      totalChecks: effectiveTotalChecks,
      revenueWithDiscounts: effectiveRevenueWithDiscounts,
      revenueWithoutDiscounts: effectiveRevenueWithoutDiscounts,
      discountCheckCount: effectiveDiscountCheckCount,
      noDiscountCheckCount: effectiveNoDiscountCheckCount,
      totalDiscountAmount: effectiveTotalDiscount,
      avgDiscountPct: effectiveTotalRevenue > 0 ? (effectiveTotalDiscount / effectiveTotalRevenue * 100) : 0
    },
    promos: promoSummaries,
    salesWithoutDiscounts: {
      checkCount: effectiveNoDiscountCheckCount,
      revenue: effectiveRevenueWithoutDiscounts,
      avgCheck: effectiveNoDiscountCheckCount > 0 ? effectiveRevenueWithoutDiscounts / effectiveNoDiscountCheckCount : 0
    },
    salesWithDiscounts: {
      checkCount: effectiveDiscountCheckCount,
      revenue: effectiveRevenueWithDiscounts,
      discountAmount: effectiveTotalDiscount,
      avgCheck: effectiveDiscountCheckCount > 0 ? effectiveRevenueWithDiscounts / effectiveDiscountCheckCount : 0
    },
    stores,
    storePromos: exactStorePromos.length > 0 ? exactStorePromos : analyticsStorePromos,
    promoAnalytics
  };
}

function analyticsMetrics(revenue: number, discountAmount: number, checkCount: number) {
  return {
    avgCheck: checkCount > 0 ? revenue / checkCount : 0,
    avgDiscountPct: revenue > 0 ? (discountAmount / revenue) * 100 : 0,
    roi: discountAmount > 0 ? (revenue - discountAmount) / discountAmount : 0
  };
}

function promoSummariesFromAnalytics(
  analytics: ReturnType<typeof buildPromoAnalytics>
): MarketingPromoSummary[] {
  return analytics.map((promo) => {
    const revenue = promo.itemRevenue > 0 ? promo.itemRevenue : promo.checkRevenue;

    return {
      key: promo.key,
      name: promo.name,
      checkCount: promo.checkCount,
      revenue,
      discountAmount: promo.discountAmount,
      avgDiscountPct: revenue > 0 ? (promo.discountAmount / revenue) * 100 : 0
    };
  });
}

function mergeActivePromoSummaries(
  existing: MarketingPromoSummary[],
  activeRows: ActiveMarketingActionRow[]
) {
  if (existing.length > 0) {
    return existing;
  }

  const activePromos = new Map<string, MarketingPromoSummary>();

  for (const row of activeRows) {
    if (!activePromos.has(row.promo_key)) {
      activePromos.set(row.promo_key, {
        key: row.promo_key,
        name: row.promo_name ?? row.promo_key,
        checkCount: 0,
        revenue: 0,
        discountAmount: 0,
        avgDiscountPct: 0
      });
    }
  }

  return [...activePromos.values()];
}

function mergeActivePromoAnalytics(
  existing: ReturnType<typeof buildPromoAnalytics>,
  activeRows: ActiveMarketingActionRow[]
) {
  if (existing.length > 0) {
    return existing;
  }

  const activePromos = new Map<string, ReturnType<typeof buildPromoAnalytics>[number]>();
  const allStoresKey = "all_stores";

  for (const row of activeRows) {
    let promo = activePromos.get(row.promo_key);

    if (!promo) {
      promo = {
        key: row.promo_key,
        name: row.promo_name ?? row.promo_key,
        checkCount: 0,
        storeCount: 0,
        itemCount: 0,
        quantity: 0,
        checkRevenue: 0,
        itemRevenue: 0,
        discountAmount: 0,
        avgCheck: 0,
        avgDiscountPct: 0,
        roi: 0,
        stores: []
      };
      activePromos.set(row.promo_key, promo);
    }

    if (row.store_key && !promo.stores.some((store) => store.key === row.store_key)) {
      promo.stores.push({
        key: row.store_key,
        name: row.store_name ?? row.store_key,
        checkCount: 0,
        itemCount: 0,
        quantity: 0,
        checkRevenue: 0,
        itemRevenue: 0,
        discountAmount: 0,
        avgCheck: 0,
        avgDiscountPct: 0,
        roi: 0,
        items: []
      });
    }

    if (row.all_stores && promo.stores.length === 0) {
      promo.stores.push({
        key: allStoresKey,
        name: "Все магазины",
        checkCount: 0,
        itemCount: 0,
        quantity: 0,
        checkRevenue: 0,
        itemRevenue: 0,
        discountAmount: 0,
        avgCheck: 0,
        avgDiscountPct: 0,
        roi: 0,
        items: []
      });
    }
  }

  return [...activePromos.values()].map((promo) => ({
    ...promo,
    storeCount: promo.stores.length
  }));
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
    const promoCheckCount = Number(row.promo_check_count ?? 0);

    let promo = promos.get(promoKey);
    if (!promo) {
      const metrics = analyticsMetrics(promoRevenue, promoDiscount, promoCheckCount);
      promo = {
        key: promoKey,
        name: row.promo_name ?? promoKey,
        checkCount: promoCheckCount,
        storeCount: Number(row.promo_store_count ?? 0),
        itemCount: Number(row.promo_item_count ?? 0),
        quantity: Number(row.promo_quantity ?? 0),
        checkRevenue: Number(row.promo_check_revenue ?? 0),
        itemRevenue: promoRevenue,
        discountAmount: promoDiscount,
        ...metrics,
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
      const storeCheckCount = Number(row.store_check_count ?? 0);
      const metrics = analyticsMetrics(storeRevenue, storeDiscount, storeCheckCount);
      store = {
        key: storeKey,
        name: row.store_name ?? storeKey,
        checkCount: storeCheckCount,
        itemCount: Number(row.store_item_count ?? 0),
        quantity: Number(row.store_quantity ?? 0),
        checkRevenue: Number(row.store_check_revenue ?? 0),
        itemRevenue: storeRevenue,
        discountAmount: storeDiscount,
        ...metrics,
        items: []
      };
      stores.set(storeKey, store);
      promo.stores.push(store);
    }

    if (row.item_key) {
      const itemRevenue = Number(row.item_revenue ?? 0);
      const itemDiscount = Number(row.item_discount_amount ?? 0);
      const itemCheckCount = Number(row.item_check_count ?? 0);
      store.items.push({
        key: row.item_key,
        name: row.item_name ?? row.item_key,
        checkCount: itemCheckCount,
        quantity: Number(row.item_quantity ?? 0),
        revenue: itemRevenue,
        discountAmount: itemDiscount,
        avgPrice: Number(row.item_quantity ?? 0) > 0 ? itemRevenue / Number(row.item_quantity ?? 0) : 0,
        ...analyticsMetrics(itemRevenue, itemDiscount, itemCheckCount),
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
