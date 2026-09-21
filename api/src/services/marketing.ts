import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import type { SalesPeriod } from "./reports.js";

function qualifiedTable(tableName: string) {
  const schema = `"${config.PGSCHEMA.replaceAll('"', '""')}"`;
  const table = `"${tableName.replaceAll('"', '""')}"`;
  return Prisma.raw(`${schema}.${table}`);
}

export type MarketingParams = {
  period: SalesPeriod;
  from?: Date;
  to?: Date;
};

const EMPTY_REF = "00000000-0000-0000-0000-000000000000";
const UNKNOWN_STORE = "Без магазина";

/**
 * Retail-report lines do not carry the discount reference, so a sale is
 * attributed to a promotion when the store, the sale date, the item and the
 * discount that is visibly baked into the line all agree with one of the
 * promotion's discount rules.
 *
 * The line discount is derived as 1 - summa / (kolichestvo * tsena), where
 * `tsena` is the price before the promotion discount. `summa` is stored with
 * two decimals, so the derived percentage is off by up to ~0.05 pp on a
 * 100-tenge line. A 0.25 pp window absorbs that rounding while staying well
 * inside the 0.3 pp gap between the closest distinct rule percentages on the
 * same store (for example 10.4 and 10.7).
 */
const DISCOUNT_TOLERANCE_PCT = 0.25;

export type MarketingPromotionItem = {
  key: string;
  name: string;
  reportCount: number;
  lineCount: number;
  quantity: number;
  revenue: number;
  listRevenue: number;
  discountAmount: number;
  discountPct: number;
  avgPrice: number;
};

export type MarketingPromotionStore = {
  key: string;
  name: string;
  reportCount: number;
  lineCount: number;
  quantity: number;
  itemCount: number;
  revenue: number;
  listRevenue: number;
  discountAmount: number;
  discountPct: number;
  avgCheck: number;
  items: MarketingPromotionItem[];
};

export type MarketingPromotion = {
  key: string;
  name: string;
  number: string | null;
  status: "active" | "finished" | "upcoming";
  startsOn: string | null;
  endsOn: string | null;
  discountPctMin: number;
  discountPctMax: number;
  reportCount: number;
  lineCount: number;
  quantity: number;
  itemCount: number;
  assortmentSize: number;
  storeCount: number;
  revenue: number;
  listRevenue: number;
  discountAmount: number;
  avgCheck: number;
  revenuePerDiscount: number;
  stores: MarketingPromotionStore[];
};

export type MarketingStore = {
  key: string;
  name: string;
  totalReports: number;
  totalRevenue: number;
  promoReports: number;
  promoRevenue: number;
  promoDiscountAmount: number;
  promoQuantity: number;
  promoItemCount: number;
  promotionCount: number;
  promoSharePct: number;
};

type PromotionRule = {
  ruleKey: string;
  promoKey: string;
  discountPct: number;
  windowStart: string;
  windowEnd: string;
  storeKeys: string[];
  itemKeys: string[];
};

type PromotionMeta = {
  key: string;
  name: string;
  number: string | null;
  startsOn: string | null;
  endsOn: string | null;
};

type PromotionRuleSet = {
  rules: PromotionRule[];
  promotions: PromotionMeta[];
};

type AttributionRow = {
  promo_key: string | null;
  store_key: string | null;
  item_key: string | null;
  report_count: bigint | number;
  line_count: bigint | number;
  item_count: bigint | number;
  quantity: number | null;
  revenue: number | null;
  list_revenue: number | null;
  discount_pct: number | null;
};

export type MarketingReport = {
  period: SalesPeriod;
  summary: {
    totalRevenue: number;
    totalReports: number;
    promoRevenue: number;
    promoListRevenue: number;
    promoDiscountAmount: number;
    promoQuantity: number;
    promoReportCount: number;
    promoLineCount: number;
    promoItemCount: number;
    promoStoreCount: number;
    promotionCount: number;
    promotionWithSalesCount: number;
    activePromotionCount: number;
    promoSharePct: number;
    avgDiscountPct: number;
    avgCheck: number;
    revenuePerDiscount: number;
  };
  promotions: MarketingPromotion[];
  stores: MarketingStore[];
};

function retailReportFilters(params: MarketingParams) {
  const filters: Prisma.Sql[] = [
    Prisma.sql`r.date is not null`,
    Prisma.sql`r.deletion_mark is not true`,
    Prisma.sql`r.posted = true`,
    Prisma.sql`r.summa_dokumenta > 0`
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
 * Item composition of a 1C nomenclature segment. 1C keeps the composition of a
 * segment inside the catalog's data-composition schema; the
 * "ФормированиеСегмента" settings variant holds the explicit item list that the
 * promotion discount rule applies to, while the "ВыводСегмента" variant only
 * selects output fields.
 */
function parseSegmentItems(schema: string | null | undefined) {
  if (!schema) {
    return [];
  }

  let xml: string;
  try {
    xml = Buffer.from(schema.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return [];
  }

  const variant = xml.match(
    /<settingsVariant>\s*<dcsset:name[^>]*>\s*ФормированиеСегмента\s*<\/dcsset:name>[\s\S]*?<\/settingsVariant>/
  );
  const scope = variant ? variant[0] : xml;
  const keys = [
    ...scope.matchAll(/d6p1:CatalogRef\.Номенклатура[^>]*>\s*([0-9a-fA-F-]{36})\s*</g)
  ].map((match) => match[1].toLowerCase());

  return [...new Set(keys)];
}

let cachedRuleSet: { expiresAt: number; rules: PromotionRuleSet } | null = null;

/**
 * Promotion documents, the stores they cover, and the discount rules they
 * apply. The rule set is reused for `REPORT_CACHE_TTL_SECONDS`, so a 1C export
 * becomes visible no later than the report cache itself and segment
 * compositions are parsed once per rule set instead of once per request.
 */
async function loadPromotionRules(): Promise<PromotionRuleSet> {
  const ttlMs = config.REPORT_CACHE_TTL_SECONDS * 1000;
  if (ttlMs > 0 && cachedRuleSet && cachedRuleSet.expiresAt > Date.now()) {
    return cachedRuleSet.rules;
  }

  const promotionsTable = qualifiedTable("document_marketingovaya_aktsiya");
  const promotionDiscountsTable = qualifiedTable("document_marketingovaya_aktsiya_skidki_natsenki");
  const promotionStoresTable = qualifiedTable("document_marketingovaya_aktsiya_magaziny");
  const discountsTable = qualifiedTable("catalog_skidki_natsenki");
  const segmentsTable = qualifiedTable("catalog_segmenty_nomenklatury");
  const storesTable = qualifiedTable("catalog_magaziny");

  const [ruleRows, storeRows, catalogStoreRows] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        promo_key: string;
        promo_number: string | null;
        promo_name: string | null;
        promo_starts_on: string | null;
        promo_ends_on: string | null;
        dlya_vseh_magazinov: boolean | null;
        rule_starts_on: string | null;
        rule_ends_on: string | null;
        rule_store_key: string | null;
        discount_key: string;
        discount_pct: number;
        segment_schema: string | null;
      }>
    >`
      select
        a.ref_key as promo_key,
        a.number as promo_number,
        nullif(a.naimenovanie_aktsii, '') as promo_name,
        a.data_nachala_deystviya::text as promo_starts_on,
        a.data_okonchaniya_deystviya::text as promo_ends_on,
        a.dlya_vseh_magazinov,
        d.data_nachala::text as rule_starts_on,
        d.data_okonchaniya::text as rule_ends_on,
        nullif(d.magazin_key, ${EMPTY_REF}) as rule_store_key,
        s.ref_key as discount_key,
        round(coalesce(s.znachenie_skidki_natsenki, 0)::numeric, 2)::float8 as discount_pct,
        segment.shema_komponovki_dannyh_base64_data as segment_schema
      from ${promotionsTable} a
      join ${promotionDiscountsTable} d on d."_parent_ref_key" = a.ref_key
      join ${discountsTable} s on s.ref_key = d.skidka_natsenka_key
      left join ${segmentsTable} segment
        on segment.ref_key = s.segment_nomenklatury_predostavleniya_key
      where a.deletion_mark is not true
        and a.posted = true
        and s.sposob_predostavleniya = 'Процент'
        and coalesce(s.znachenie_skidki_natsenki, 0) > 0
      order by a.date desc, a.ref_key, s.ref_key
    `,
    prisma.$queryRaw<Array<{ promo_key: string; store_key: string }>>`
      select distinct
        m."_parent_ref_key" as promo_key,
        m.magazin_key as store_key
      from ${promotionStoresTable} m
      where m.magazin_key is not null and m.magazin_key <> ${EMPTY_REF}
    `,
    prisma.$queryRaw<Array<{ store_key: string }>>`
      select distinct m.ref_key as store_key
      from ${storesTable} m
      where m.deletion_mark is not true and m.ref_key <> ${EMPTY_REF}
    `
  ]);

  const promoStores = new Map<string, string[]>();
  for (const row of storeRows) {
    const stores = promoStores.get(row.promo_key);
    if (stores) {
      stores.push(row.store_key);
    } else {
      promoStores.set(row.promo_key, [row.store_key]);
    }
  }
  const everyStore = catalogStoreRows.map((row) => row.store_key);

  const promotions: PromotionMeta[] = [];
  const seenPromotions = new Set<string>();
  const rules: PromotionRule[] = [];

  for (const row of ruleRows) {
    if (!seenPromotions.has(row.promo_key)) {
      seenPromotions.add(row.promo_key);
      promotions.push({
        key: row.promo_key,
        name: row.promo_name ?? row.promo_number ?? row.promo_key,
        number: row.promo_number,
        startsOn: row.promo_starts_on?.slice(0, 10) ?? null,
        endsOn: row.promo_ends_on?.slice(0, 10) ?? null
      });
    }

    // A rule is only effective while both the rule schedule and the promotion
    // itself are running, and the two windows are stored separately.
    const startsOn = [row.rule_starts_on, row.promo_starts_on].filter(
      (value): value is string => Boolean(value)
    );
    const endsOn = [row.rule_ends_on, row.promo_ends_on].filter(
      (value): value is string => Boolean(value)
    );
    const windowStart = startsOn.length > 0 ? startsOn.reduce((a, b) => (a > b ? a : b)) : null;
    const windowEnd = endsOn.length > 0 ? endsOn.reduce((a, b) => (a < b ? a : b)) : null;
    if (!windowStart || !windowEnd || windowStart >= windowEnd) {
      continue;
    }

    const storeKeys = row.rule_store_key
      ? [row.rule_store_key]
      : row.dlya_vseh_magazinov === true
        ? everyStore
        : (promoStores.get(row.promo_key) ?? []);

    rules.push({
      ruleKey: `${row.promo_key}:${row.discount_key}`,
      promoKey: row.promo_key,
      discountPct: Number(row.discount_pct ?? 0),
      windowStart,
      windowEnd,
      storeKeys,
      itemKeys: parseSegmentItems(row.segment_schema)
    });
  }

  const ruleSet: PromotionRuleSet = { rules, promotions };
  cachedRuleSet = ttlMs > 0 ? { expiresAt: Date.now() + ttlMs, rules: ruleSet } : null;
  return ruleSet;
}

export async function getMarketingReport(params: MarketingParams) {
  const reportsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const itemsTable = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_tovary");
  const storesTable = qualifiedTable("catalog_magaziny");
  const nomenclatureTable = qualifiedTable("catalog_nomenklatura");
  const whereSql = retailReportFilters(params);
  const { rules, promotions } = await loadPromotionRules();

  const storeQuery = prisma.$queryRaw<
    Array<{ store_key: string; report_count: bigint | number; revenue: number | null }>
  >`
    select
      coalesce(nullif(r.magazin_key, ''), ${UNKNOWN_STORE}) as store_key,
      count(*) as report_count,
      coalesce(sum(coalesce(r.summa_dokumenta, 0)), 0)::float8 as revenue
    from ${reportsTable} r
    where ${whereSql}
    group by 1
    order by 3 desc
  `;

  const [storeRows, attributedRows] = await Promise.all([
    storeQuery,
    rules.length > 0
      ? prisma.$queryRaw<AttributionRow[]>`
      with rule_def as (
        select rule_key, promo_key, discount_pct, window_start::timestamp, window_end::timestamp
        from unnest(
          ${rules.map((rule) => rule.ruleKey)}::text[],
          ${rules.map((rule) => rule.promoKey)}::text[],
          ${rules.map((rule) => rule.discountPct)}::float8[],
          ${rules.map((rule) => rule.windowStart)}::text[],
          ${rules.map((rule) => rule.windowEnd)}::text[]
        ) as t(rule_key, promo_key, discount_pct, window_start, window_end)
      ),
      rule_store as (
        select rule_key, store_key
        from unnest(
          ${rules.flatMap((rule) => rule.storeKeys.map(() => rule.ruleKey))}::text[],
          ${rules.flatMap((rule) => rule.storeKeys)}::text[]
        ) as t(rule_key, store_key)
      ),
      rule_item as (
        select rule_key, item_key
        from unnest(
          ${rules.flatMap((rule) => rule.itemKeys.map(() => rule.ruleKey))}::text[],
          ${rules.flatMap((rule) => rule.itemKeys)}::text[]
        ) as t(rule_key, item_key)
      ),
      -- Scanning the report lines once and materialising them keeps the join
      -- against the rule sets from re-reading every report per matching rule.
      lines as materialized (
        select
          t."_id" as line_id,
          t."_parent_ref_key" as report_key,
          r.date,
          coalesce(nullif(r.magazin_key, ''), ${UNKNOWN_STORE}) as store_key,
          t.nomenklatura_key as item_key,
          coalesce(t.kolichestvo, 0)::float8 as quantity,
          coalesce(t.summa, 0)::float8 as revenue,
          (t.kolichestvo * t.tsena)::float8 as list_revenue
        from ${reportsTable} r
        join ${itemsTable} t on t."_parent_ref_key" = r.ref_key
        where ${whereSql}
          and coalesce(t.kolichestvo, 0) > 0
          and coalesce(t.tsena, 0) > 0
          and t.nomenklatura_key is not null
          and t.summa < t.kolichestvo * t.tsena
      ),
      matched as (
        select
          l.line_id,
          rd.promo_key,
          l.report_key,
          l.store_key,
          l.item_key,
          rd.discount_pct,
          l.quantity,
          l.revenue,
          l.list_revenue
        from lines l
        join rule_item ri on ri.item_key = l.item_key
        join rule_def rd
          on rd.rule_key = ri.rule_key
          and l.date >= rd.window_start
          and l.date < rd.window_end
          and abs((1 - l.revenue / l.list_revenue) * 100 - rd.discount_pct)
            <= ${DISCOUNT_TOLERANCE_PCT}
        join rule_store rs
          on rs.rule_key = rd.rule_key
          and rs.store_key = l.store_key
      ),
      -- A line can satisfy several of a promotion's rules; keep exactly one so
      -- that revenue is never counted twice.
      attributed as (
        select * from (
          select
            matched.*,
            row_number() over (
              partition by line_id order by discount_pct desc, promo_key
            ) as rule_rank
          from matched
        ) ranked
        where rule_rank = 1
      )
      select
        case when grouping(promo_key) = 1 then null else promo_key end as promo_key,
        case when grouping(store_key) = 1 then null else store_key end as store_key,
        case when grouping(item_key) = 1 then null else item_key end as item_key,
        count(distinct report_key) as report_count,
        count(*) as line_count,
        count(distinct item_key) as item_count,
        coalesce(sum(quantity), 0)::float8 as quantity,
        coalesce(sum(revenue), 0)::float8 as revenue,
        coalesce(sum(list_revenue), 0)::float8 as list_revenue,
        max(discount_pct)::float8 as discount_pct
      from attributed
      group by grouping sets ((promo_key, store_key, item_key), (promo_key, store_key), ())
    `
      : Promise.resolve<AttributionRow[]>([])
  ]);

  const itemKeys = new Set<string>();
  const storeKeys = new Set<string>();
  for (const row of attributedRows) {
    if (row.item_key) {
      itemKeys.add(row.item_key);
    }

    if (row.store_key) {
      storeKeys.add(row.store_key);
    }
  }
  for (const row of storeRows) {
    storeKeys.add(row.store_key);
  }

  const [itemNameRows, storeNameRows] = await Promise.all([
    itemKeys.size > 0
      ? prisma.$queryRaw<Array<{ ref_key: string; description: string | null }>>`
          select n.ref_key, max(n.description) as description
          from ${nomenclatureTable} n
          where n.ref_key = any(${[...itemKeys]}::text[])
          group by n.ref_key
        `
      : Promise.resolve([]),
    storeKeys.size > 0
      ? prisma.$queryRaw<Array<{ ref_key: string; description: string | null }>>`
          select m.ref_key, max(m.description) as description
          from ${storesTable} m
          where m.ref_key = any(${[...storeKeys]}::text[])
          group by m.ref_key
        `
      : Promise.resolve([])
  ]);

  const itemNames = new Map(itemNameRows.map((row) => [row.ref_key, row.description]));
  const storeNames = new Map(storeNameRows.map((row) => [row.ref_key, row.description]));
  const nameOf = (names: Map<string, string | null>, key: string) => {
    const name = names.get(key);
    return name && name !== key ? name : key;
  };

  type StoreAggregate = {
    reportCount: number;
    lineCount: number;
    quantity: number;
    revenue: number;
    listRevenue: number;
    discountPct: number;
    items: Map<
      string,
      {
        reportCount: number;
        lineCount: number;
        quantity: number;
        revenue: number;
        listRevenue: number;
        discountPct: number;
      }
    >;
  };

  const promotionAggregates = new Map<string, { stores: Map<string, StoreAggregate> }>();
  let matchedSummary: AttributionRow | null = null;

  for (const row of attributedRows) {
    if (!row.promo_key || !row.store_key) {
      matchedSummary = row;
      continue;
    }

    let promotion = promotionAggregates.get(row.promo_key);
    if (!promotion) {
      promotion = { stores: new Map() };
      promotionAggregates.set(row.promo_key, promotion);
    }

    let store = promotion.stores.get(row.store_key);
    if (!store) {
      store = {
        reportCount: 0,
        lineCount: 0,
        quantity: 0,
        revenue: 0,
        listRevenue: 0,
        discountPct: 0,
        items: new Map()
      };
      promotion.stores.set(row.store_key, store);
    }

    const quantity = Number(row.quantity ?? 0);
    const revenue = Number(row.revenue ?? 0);
    const listRevenue = Number(row.list_revenue ?? 0);
    const reportCount = Number(row.report_count ?? 0);
    const lineCount = Number(row.line_count ?? 0);
    const discountPct = Number(row.discount_pct ?? 0);

    if (row.item_key) {
      let item = store.items.get(row.item_key);
      if (!item) {
        item = {
          reportCount: 0,
          lineCount: 0,
          quantity: 0,
          revenue: 0,
          listRevenue: 0,
          discountPct: 0
        };
        store.items.set(row.item_key, item);
      }
      item.reportCount += reportCount;
      item.lineCount += lineCount;
      item.quantity += quantity;
      item.revenue += revenue;
      item.listRevenue += listRevenue;
      item.discountPct = Math.max(item.discountPct, discountPct);
      continue;
    }

    store.reportCount += reportCount;
    store.lineCount += lineCount;
    store.quantity += quantity;
    store.revenue += revenue;
    store.listRevenue += listRevenue;
    store.discountPct = Math.max(store.discountPct, discountPct);
  }

  const promotionsResult: MarketingPromotion[] = [];
  for (const [promoKey, aggregate] of promotionAggregates) {
    const meta = promotions.find((promotion) => promotion.key === promoKey);
    const stores: MarketingPromotionStore[] = [...aggregate.stores.entries()]
      .map(([storeKey, store]) => {
        const storeDiscount = Math.max(store.listRevenue - store.revenue, 0);
        const items = [...store.items.entries()]
          .map(([itemKey, item]) => {
            const itemDiscount = Math.max(item.listRevenue - item.revenue, 0);
            return {
              key: itemKey,
              name: nameOf(itemNames, itemKey),
              reportCount: item.reportCount,
              lineCount: item.lineCount,
              quantity: item.quantity,
              revenue: item.revenue,
              listRevenue: item.listRevenue,
              discountAmount: itemDiscount,
              discountPct: item.discountPct,
              avgPrice: item.quantity > 0 ? item.revenue / item.quantity : 0
            };
          })
          .sort((left, right) => right.revenue - left.revenue);

        return {
          key: storeKey,
          name: nameOf(storeNames, storeKey),
          reportCount: store.reportCount,
          lineCount: store.lineCount,
          quantity: store.quantity,
          itemCount: store.items.size,
          revenue: store.revenue,
          listRevenue: store.listRevenue,
          discountAmount: storeDiscount,
          discountPct: store.discountPct,
          avgCheck: store.reportCount > 0 ? store.revenue / store.reportCount : 0,
          items
        };
      })
      .sort((left, right) => right.revenue - left.revenue);

    // A retail report belongs to a single store, so promotion-level report
    // counts are the sum over its stores.
    const reportCount = stores.reduce((total, store) => total + store.reportCount, 0);
    const lineCount = stores.reduce((total, store) => total + store.lineCount, 0);
    const revenue = stores.reduce((total, store) => total + store.revenue, 0);
    const listRevenue = stores.reduce((total, store) => total + store.listRevenue, 0);
    const discountAmount = Math.max(listRevenue - revenue, 0);
    const discountPercents = stores.map((store) => store.discountPct).filter((pct) => pct > 0);
    // Rules of one promotion may repeat a segment, so the assortment is the set
    // of distinct items the promotion can apply to, not the sum over its rules.
    const assortmentSize = new Set(
      rules.filter((rule) => rule.promoKey === promoKey).flatMap((rule) => rule.itemKeys)
    ).size;

    promotionsResult.push({
      key: promoKey,
      name: meta?.name ?? promoKey,
      number: meta?.number ?? null,
      status: promotionStatus(meta?.startsOn ?? null, meta?.endsOn ?? null),
      startsOn: meta?.startsOn ?? null,
      endsOn: meta?.endsOn ?? null,
      discountPctMin: discountPercents.length > 0 ? Math.min(...discountPercents) : 0,
      discountPctMax: discountPercents.length > 0 ? Math.max(...discountPercents) : 0,
      reportCount,
      lineCount,
      quantity: stores.reduce((total, store) => total + store.quantity, 0),
      itemCount: new Set(stores.flatMap((store) => store.items.map((item) => item.key))).size,
      assortmentSize,
      storeCount: stores.length,
      revenue,
      listRevenue,
      discountAmount,
      avgCheck: reportCount > 0 ? revenue / reportCount : 0,
      revenuePerDiscount: discountAmount > 0 ? revenue / discountAmount : 0,
      stores
    });
  }

  promotionsResult.sort((left, right) => right.revenue - left.revenue);

  const storeIndex = new Map<string, MarketingStore>();
  const storesResult: MarketingStore[] = storeRows.map((row) => {
    const store: MarketingStore = {
      key: row.store_key,
      name: nameOf(storeNames, row.store_key),
      totalReports: Number(row.report_count ?? 0),
      totalRevenue: Number(row.revenue ?? 0),
      promoReports: 0,
      promoRevenue: 0,
      promoDiscountAmount: 0,
      promoQuantity: 0,
      promoItemCount: 0,
      promotionCount: 0,
      promoSharePct: 0
    };
    storeIndex.set(store.key, store);
    return store;
  });

  const storePromotionKeys = new Map<string, Set<string>>();
  const storeItemKeys = new Map<string, Set<string>>();
  for (const promotion of promotionsResult) {
    for (const store of promotion.stores) {
      const target = storeIndex.get(store.key);
      if (!target) {
        continue;
      }

      target.promoRevenue += store.revenue;
      target.promoDiscountAmount += store.discountAmount;
      target.promoQuantity += store.quantity;
      target.promoReports += store.reportCount;

      const promotionKeys = storePromotionKeys.get(store.key) ?? new Set<string>();
      promotionKeys.add(promotion.key);
      storePromotionKeys.set(store.key, promotionKeys);

      const items = storeItemKeys.get(store.key) ?? new Set<string>();
      for (const item of store.items) {
        items.add(item.key);
      }
      storeItemKeys.set(store.key, items);
    }
  }

  for (const store of storesResult) {
    store.promotionCount = storePromotionKeys.get(store.key)?.size ?? 0;
    store.promoItemCount = storeItemKeys.get(store.key)?.size ?? 0;
    store.promoSharePct =
      store.totalRevenue > 0 ? (store.promoRevenue / store.totalRevenue) * 100 : 0;
  }

  const totalRevenue = storesResult.reduce((total, store) => total + store.totalRevenue, 0);
  const totalReports = storesResult.reduce((total, store) => total + store.totalReports, 0);
  const promoRevenue = promotionsResult.reduce((total, promotion) => total + promotion.revenue, 0);
  const promoListRevenue = promotionsResult.reduce(
    (total, promotion) => total + promotion.listRevenue,
    0
  );
  const promoDiscountAmount = promotionsResult.reduce(
    (total, promotion) => total + promotion.discountAmount,
    0
  );
  const promoReportCount = Number(matchedSummary?.report_count ?? 0);
  const promoLineCount = Number(matchedSummary?.line_count ?? 0);
  const promoItemCount = Number(matchedSummary?.item_count ?? 0);
  const promoStoreCount = storesResult.filter((store) => store.promoRevenue > 0).length;
  const periodPromotions = promotions.filter((promotion) => promotionOverlaps(promotion, params));

  return {
    period: params.period,
    summary: {
      totalRevenue,
      totalReports,
      promoRevenue,
      promoListRevenue,
      promoDiscountAmount,
      promoQuantity: promotionsResult.reduce((total, promotion) => total + promotion.quantity, 0),
      promoReportCount,
      promoLineCount,
      promoItemCount,
      promoStoreCount: storesResult.filter((store) => store.promoRevenue > 0).length,
      promotionCount: periodPromotions.length,
      promotionWithSalesCount: promotionsResult.length,
      activePromotionCount: periodPromotions.filter(
        (promotion) => promotionStatus(promotion.startsOn, promotion.endsOn) === "active"
      ).length,
      promoSharePct: totalRevenue > 0 ? (promoRevenue / totalRevenue) * 100 : 0,
      avgDiscountPct: promoListRevenue > 0 ? (promoDiscountAmount / promoListRevenue) * 100 : 0,
      avgCheck: promoReportCount > 0 ? promoRevenue / promoReportCount : 0,
      revenuePerDiscount: promoDiscountAmount > 0 ? promoRevenue / promoDiscountAmount : 0
    },
    promotions: promotionsResult,
    stores: storesResult
  };
}

function promotionStatus(
  startsOn: string | null,
  endsOn: string | null
): "active" | "finished" | "upcoming" {
  const today = new Date().toISOString().slice(0, 10);

  if (startsOn && today < startsOn) {
    return "upcoming";
  }

  if (endsOn && today >= endsOn) {
    return "finished";
  }

  return "active";
}

function promotionOverlaps(promotion: PromotionMeta, params: MarketingParams) {
  const from = params.from?.toISOString().slice(0, 10);
  const to = params.to?.toISOString().slice(0, 10);

  if (promotion.startsOn && to && promotion.startsOn >= to) {
    return false;
  }

  if (promotion.endsOn && from && promotion.endsOn <= from) {
    return false;
  }

  return true;
}
