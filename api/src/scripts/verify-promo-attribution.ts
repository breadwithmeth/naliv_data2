// Independent audit of the promotion attribution behind the marketing report.
//
// The service attributes a retail line to a promotion in one scan using a
// row_number() dedupe plus `group by grouping sets`. This script recomputes the
// same decision with a different mechanism — the segment composition is parsed
// by PostgreSQL instead of JavaScript, the per-line match is a lateral
// `order by ... limit 1` instead of a window function, and the promotion totals
// come from a plain `group by` — then diffs both sides. A mistake in either
// implementation shows up as a named mismatch instead of a plausible number.
//
// Usage:
//   npx tsx api/src/scripts/verify-promo-attribution.ts \
//     [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--out=verify-out] \
//     [--tolerance=0.25] [--lines=2000]
//
// Outputs: <out>/attribution-lines.csv (per-line decision),
//          <out>/attribution-summary.json (both sides, mismatches, verdict),
//          <out>/near-miss-lines.json (lines just outside the tolerance).
// Exit code is non-zero when the two sides disagree.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const EMPTY_REF = "00000000-0000-0000-0000-000000000000";
const UNKNOWN_STORE = "Без магазина";

type Args = {
  from: Date;
  to: Date;
  out: string;
  tolerance: number;
  lineLimit: number;
};

function parseDate(value: string, flag: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${flag} должен быть датой вида YYYY-MM-DD, получено «${value}»`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (const entry of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(entry);
    if (!match) {
      throw new Error(`Аргумент «${entry}» не распознан; ожидается --ключ=значение.`);
    }
    values.set(match[1], match[2]);
  }

  const today = new Date();
  const defaultTo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  const defaultFrom = new Date(defaultTo.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from = values.has("from") ? parseDate(values.get("from")!, "--from") : defaultFrom;
  const to = values.has("to") ? parseDate(values.get("to")!, "--to") : defaultTo;
  if (from >= to) {
    throw new Error("--from должен быть раньше --to.");
  }

  return {
    from,
    to,
    out: values.get("out") ?? "verify-out",
    tolerance: Number(values.get("tolerance") ?? "0.25"),
    lineLimit: Number(values.get("lines") ?? "2000")
  };
}

const args = parseArgs(process.argv.slice(2));

// The service memoises its rule set for REPORT_CACHE_TTL_SECONDS and config
// parses the environment when it is imported, so the cache must be disabled
// before the modules below load — a static import would freeze both.
process.env.REPORT_CACHE_TTL_SECONDS = "0";

const { config } = await import("../config.js");
const { prisma } = await import("../prisma.js");
const { getMarketingReport } = await import("../services/marketing.js");

const schema = `"${config.PGSCHEMA.replaceAll('"', '""')}"`;

// Segment composition mirrors the 1C data-composition schema: each item of the
// "ФормированиеСегмента" variant is an element whose xsi:type attribute is
// d6p1:CatalogRef.Номенклатура and whose text is the item UUID. Only the
// segments used by the selected promotions are parsed, and the promotion
// windows come from the same tables the service reads.
const ruleSql = `
  promo as (
    select a.ref_key, a.number, a.naimenovanie_aktsii, a.dlya_vseh_magazinov,
           a.data_nachala_deystviya, a.data_okonchaniya_deystviya
    from ${schema}.document_marketingovaya_aktsiya a
    where a.deletion_mark is not true and a.posted = true
  ),
  promo_store as (
    select distinct m."_parent_ref_key" as promo_key, m.magazin_key as store_key
    from ${schema}.document_marketingovaya_aktsiya_magaziny m
    where m.magazin_key is not null and m.magazin_key <> '${EMPTY_REF}'
  ),
  all_store as (
    select distinct m.ref_key as store_key
    from ${schema}.catalog_magaziny m
    where m.deletion_mark is not true and m.ref_key <> '${EMPTY_REF}'
  ),
  rule as (
    select
      p.ref_key as promo_key,
      s.ref_key as discount_key,
      round(coalesce(s.znachenie_skidki_natsenki, 0)::numeric, 2)::float8 as pct,
      greatest(coalesce(d.data_nachala, p.data_nachala_deystviya),
               coalesce(p.data_nachala_deystviya, d.data_nachala)) as window_start,
      least(coalesce(d.data_okonchaniya, p.data_okonchaniya_deystviya),
            coalesce(p.data_okonchaniya_deystviya, d.data_okonchaniya)) as window_end,
      nullif(d.magazin_key, '${EMPTY_REF}') as rule_store_key,
      p.dlya_vseh_magazinov,
      seg.shema_komponovki_dannyh_base64_data as segment_schema
    from promo p
    join ${schema}.document_marketingovaya_aktsiya_skidki_natsenki d
      on d."_parent_ref_key" = p.ref_key
    join ${schema}.catalog_skidki_natsenki s on s.ref_key = d.skidka_natsenka_key
    left join ${schema}.catalog_segmenty_nomenklatury seg
      on seg.ref_key = s.segment_nomenklatury_predostavleniya_key
    where s.sposob_predostavleniya = 'Процент'
      and coalesce(s.znachenie_skidki_natsenki, 0) > 0
      and greatest(coalesce(d.data_nachala, p.data_nachala_deystviya),
                   coalesce(p.data_nachala_deystviya, d.data_nachala))
        < least(coalesce(d.data_okonchaniya, p.data_okonchaniya_deystviya),
                coalesce(p.data_okonchaniya_deystviya, d.data_okonchaniya))
  ),
  rule_store as (
    select r.promo_key, r.discount_key, store.store_key
    from rule r
    cross join lateral (
      select coalesce(
        case when r.rule_store_key is not null then array[r.rule_store_key] end,
        case when r.dlya_vseh_magazinov then (select array_agg(store_key) from all_store) end,
        (select array_agg(store_key) from promo_store ps where ps.promo_key = r.promo_key)
      ) as store_keys
    ) chosen
    cross join lateral unnest(coalesce(chosen.store_keys, array[]::text[])) as store(store_key)
  ),
  rule_item as (
    select r.promo_key, r.discount_key, matches.match[1]::text as item_key
    from rule r
    cross join lateral regexp_matches(
      convert_from(decode(r.segment_schema, 'base64'), 'UTF8'),
      'd6p1:CatalogRef\\.Номенклатура[^>]*>\\s*([0-9a-fA-F-]{36})\\s*<',
      'g'
    ) as matches(match)
    where r.segment_schema is not null
  ),
  line as materialized (
    select
      t."_id" as line_id,
      t."_parent_ref_key" as report_key,
      r.date as document_date,
      coalesce(nullif(r.magazin_key, ''), '${UNKNOWN_STORE}') as store_key,
      t.nomenklatura_key as item_key,
      coalesce(t.kolichestvo, 0)::float8 as quantity,
      coalesce(t.summa, 0)::float8 as revenue,
      (t.kolichestvo * t.tsena)::float8 as list_revenue
    from ${schema}.document_otchet_o_roznichnyh_prodazhah r
    join ${schema}.document_otchet_o_roznichnyh_prodazhah_tovary t
      on t."_parent_ref_key" = r.ref_key
    where r.date is not null
      and r.deletion_mark is not true
      and r.posted = true
      and r.summa_dokumenta > 0
      and r.date >= $1
      and r.date < $2
      and coalesce(t.kolichestvo, 0) > 0
      and coalesce(t.tsena, 0) > 0
      and t.nomenklatura_key is not null
      and t.summa < t.kolichestvo * t.tsena
  ),
  matched as (
    select
      l.line_id, l.report_key, l.document_date, l.store_key, l.item_key,
      l.quantity, l.revenue, l.list_revenue,
      pick.promo_key, pick.pct
    from line l
    cross join lateral (
      select r.promo_key, r.pct
      from rule r
      join rule_store rs
        on rs.promo_key = r.promo_key and rs.discount_key = r.discount_key
       and rs.store_key = l.store_key
      join rule_item ri
        on ri.promo_key = r.promo_key and ri.discount_key = r.discount_key
       and ri.item_key = l.item_key
      where l.document_date >= r.window_start
        and l.document_date < r.window_end
        and abs((1 - l.revenue / l.list_revenue) * 100 - r.pct) <= $3
      order by r.pct desc, r.promo_key
      limit 1
    ) pick
  )`;

type PerPromotionRow = {
  promo_key: string;
  promo_name: string | null;
  promo_number: string | null;
  report_count: bigint;
  line_count: bigint;
  item_count: bigint;
  quantity: number;
  revenue: number;
  list_revenue: number;
  discount_pct: number;
};

type TotalsRow = {
  report_count: bigint;
  line_count: bigint;
  item_count: bigint;
  store_count: bigint;
  promotion_count: bigint;
  quantity: number;
  revenue: number;
  list_revenue: number;
};

type LineRow = {
  line_id: bigint;
  document_date: Date;
  report_key: string;
  store_key: string;
  item_key: string;
  quantity: number;
  revenue: number;
  list_revenue: number;
  implied_pct: number;
  promo_key: string;
  rule_pct: number;
};

type NearMissRow = {
  line_id: bigint;
  document_date: Date;
  store_key: string;
  item_key: string;
  promo_key: string;
  rule_pct: number;
  implied_pct: number;
  deviation: number;
  near_miss_count: bigint;
};

const round = (value: number, digits = 4) => Number(value.toFixed(digits));

async function loadPerPromotion(): Promise<PerPromotionRow[]> {
  return prisma.$queryRawUnsafe<PerPromotionRow[]>(
    `with ${ruleSql}
     select
       m.promo_key,
       max(p.naimenovanie_aktsii) as promo_name,
       max(p.number) as promo_number,
       count(distinct m.report_key) as report_count,
       count(*) as line_count,
       count(distinct m.item_key) as item_count,
       coalesce(sum(m.quantity), 0)::float8 as quantity,
       coalesce(sum(m.revenue), 0)::float8 as revenue,
       coalesce(sum(m.list_revenue), 0)::float8 as list_revenue,
       max(m.pct)::float8 as discount_pct
     from matched m
     join promo p on p.ref_key = m.promo_key
     group by m.promo_key
     order by revenue desc`,
    args.from,
    args.to,
    args.tolerance
  );
}

async function loadTotals(): Promise<TotalsRow> {
  const rows = await prisma.$queryRawUnsafe<TotalsRow[]>(
    `with ${ruleSql}
     select
       count(distinct m.report_key) as report_count,
       count(*) as line_count,
       count(distinct m.item_key) as item_count,
       count(distinct m.store_key) as store_count,
       count(distinct m.promo_key) as promotion_count,
       coalesce(sum(m.quantity), 0)::float8 as quantity,
       coalesce(sum(m.revenue), 0)::float8 as revenue,
       coalesce(sum(m.list_revenue), 0)::float8 as list_revenue
     from matched m`,
    args.from,
    args.to,
    args.tolerance
  );
  const first = rows[0];
  if (!first) {
    throw new Error("Агрегат по строкам не вернул ни одной строки.");
  }
  return first;
}

async function loadLines(): Promise<LineRow[]> {
  return prisma.$queryRawUnsafe<LineRow[]>(
    `with ${ruleSql}
     select
       m.line_id,
       m.document_date,
       m.report_key,
       m.store_key,
       m.item_key,
       m.quantity,
       m.revenue,
       m.list_revenue,
       (1 - m.revenue / m.list_revenue) * 100 as implied_pct,
       m.promo_key,
       m.pct as rule_pct
     from matched m
     order by m.document_date, m.line_id
     limit $4`,
    args.from,
    args.to,
    args.tolerance,
    args.lineLimit
  );
}

// Lines that almost matched: their closest rule percentage sits just outside
// the tolerance. They are the population the tolerance choice can silently drop.
// The report counts the promotions whose own document period overlaps the
// requested range, not the ones that produced sales; a promotion without
// start or end date overlaps everything.
async function loadPeriodPromotionCount(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `with ${ruleSql}
     select count(distinct r.promo_key) as n
     from rule r
     join promo p on p.ref_key = r.promo_key
     where coalesce(not (p.data_nachala_deystviya::date >= $2::date), true)
       and coalesce(not (p.data_okonchaniya_deystviya::date <= $1::date), true)`,
    args.from,
    args.to,
    args.tolerance
  );
  return Number(rows[0]?.n ?? 0);
}

async function loadNearMisses(limit = 50): Promise<NearMissRow[]> {
  return prisma.$queryRawUnsafe<NearMissRow[]>(
    `with ${ruleSql},
     candidate as (
       select
         l.line_id, l.document_date, l.store_key, l.item_key,
         (1 - l.revenue / l.list_revenue) * 100 as implied_pct,
         picked.promo_key, picked.pct as rule_pct, picked.deviation
       from line l
       cross join lateral (
         select r.promo_key, r.pct, abs((1 - l.revenue / l.list_revenue) * 100 - r.pct) as deviation
         from rule r
         join rule_store rs
           on rs.promo_key = r.promo_key and rs.discount_key = r.discount_key
          and rs.store_key = l.store_key
         join rule_item ri
           on ri.promo_key = r.promo_key and ri.discount_key = r.discount_key
          and ri.item_key = l.item_key
         where l.document_date >= r.window_start
           and l.document_date < r.window_end
           and abs((1 - l.revenue / l.list_revenue) * 100 - r.pct) <= $3 + 0.5
         order by deviation, r.pct desc, r.promo_key
         limit 1
       ) picked
     )
     select *, count(*) over () as near_miss_count
     from candidate
     where deviation > $3 and deviation <= $3 + 0.5
     order by deviation desc
     limit $4`,
    args.from,
    args.to,
    args.tolerance,
    limit
  );
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",;\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

type Mismatch = { scope: string; field: string; service: number; crossCheck: number };

function compareNumber(
  mismatches: Mismatch[],
  scope: string,
  field: string,
  service: number,
  crossCheck: number
): void {
  if (Math.abs(service - crossCheck) > 0.01) {
    mismatches.push({ scope, field, service: round(service, 2), crossCheck: round(crossCheck, 2) });
  }
}

const outDir = resolve(args.out);
mkdirSync(outDir, { recursive: true });

const [perPromotion, totals, lines, nearMisses, periodPromotionCount, report] = await Promise.all([
  loadPerPromotion(),
  loadTotals(),
  loadLines(),
  loadNearMisses(),
  loadPeriodPromotionCount(),
  getMarketingReport({ period: "day", from: args.from, to: args.to })
]);

const mismatches: Mismatch[] = [];
const serviceByKey = new Map(report.promotions.map((promotion) => [promotion.key, promotion]));

for (const row of perPromotion) {
  const promotion = serviceByKey.get(row.promo_key);
  if (!promotion) {
    mismatches.push({
      scope: row.promo_key,
      field: "отсутствует в отчёте сервиса",
      service: 0,
      crossCheck: Number(row.line_count)
    });
    continue;
  }

  const scope = `${promotion.name} (${row.promo_key})`;
  compareNumber(mismatches, scope, "выручка", Number(promotion.revenue), row.revenue);
  compareNumber(mismatches, scope, "выручка по прайсу", Number(promotion.listRevenue), row.list_revenue);
  compareNumber(mismatches, scope, "количество", Number(promotion.quantity), row.quantity);
  compareNumber(mismatches, scope, "отчетов", Number(promotion.reportCount), Number(row.report_count));
  compareNumber(mismatches, scope, "строк", Number(promotion.lineCount), Number(row.line_count));
  compareNumber(mismatches, scope, "товаров", Number(promotion.itemCount), Number(row.item_count));
  compareNumber(
    mismatches,
    scope,
    "скидка",
    Number(promotion.discountAmount),
    Math.max(row.list_revenue - row.revenue, 0)
  );
}

for (const [key, promotion] of serviceByKey) {
  if (!perPromotion.some((row) => row.promo_key === key)) {
    if (promotion.lineCount > 0) {
      mismatches.push({ scope: promotion.name, field: "лишняя акция в отчёте", service: promotion.lineCount, crossCheck: 0 });
    }
  }
}

const summary = report.summary;
compareNumber(mismatches, "сводка", "выручка по акциям", Number(summary.promoRevenue), totals.revenue);
compareNumber(
  mismatches,
  "сводка",
  "скидка по акциям",
  Number(summary.promoDiscountAmount),
  Math.max(totals.list_revenue - totals.revenue, 0)
);
compareNumber(mismatches, "сводка", "строк", Number(summary.promoLineCount), Number(totals.line_count));
compareNumber(mismatches, "сводка", "отчетов", Number(summary.promoReportCount), Number(totals.report_count));
compareNumber(mismatches, "сводка", "товаров", Number(summary.promoItemCount), Number(totals.item_count));
compareNumber(mismatches, "сводка", "магазинов", Number(summary.promoStoreCount), Number(totals.store_count));
compareNumber(mismatches, "сводка", "акций", Number(summary.promotionCount), periodPromotionCount);
compareNumber(
  mismatches,
  "сводка",
  "акций с продажами",
  Number(summary.promotionWithSalesCount),
  perPromotion.length
);
compareNumber(mismatches, "сводка", "количество", Number(summary.promoQuantity), totals.quantity);

const summaryPayload = {
  period: { from: args.from.toISOString(), to: args.to.toISOString() },
  tolerance: args.tolerance,
  generatedAt: new Date().toISOString(),
  consistent: mismatches.length === 0,
  service: {
    promoRevenue: summary.promoRevenue,
    promoDiscountAmount: summary.promoDiscountAmount,
    promoReportCount: summary.promoReportCount,
    promoLineCount: summary.promoLineCount,
    promoItemCount: summary.promoItemCount,
    promoStoreCount: summary.promoStoreCount,
    promotionCount: summary.promotionCount,
    promotionWithSalesCount: summary.promotionWithSalesCount,
    promoQuantity: summary.promoQuantity
  },
  crossCheck: {
    revenue: totals.revenue,
    discountAmount: Math.max(totals.list_revenue - totals.revenue, 0),
    lineCount: Number(totals.line_count),
    reportCount: Number(totals.report_count),
    itemCount: Number(totals.item_count),
    storeCount: Number(totals.store_count),
    promotionCount: periodPromotionCount,
    quantity: totals.quantity
  },
  promotions: perPromotion.map((row) => ({
    promoKey: row.promo_key,
    name: row.promo_name,
    number: row.promo_number,
    reportCount: Number(row.report_count),
    lineCount: Number(row.line_count),
    itemCount: Number(row.item_count),
    quantity: row.quantity,
    revenue: row.revenue,
    listRevenue: row.list_revenue,
    discountAmount: round(Math.max(row.list_revenue - row.revenue, 0), 2),
    discountPct: row.discount_pct
  })),
  mismatches
};

const header = [
  "line_id", "document_date", "report_key", "store_key", "item_key", "quantity",
  "price", "revenue", "list_revenue", "implied_discount_pct", "promo_key", "rule_discount_pct"
].join(";");
const csv = [
  header,
  ...lines.map((row) =>
    [
      row.line_id,
      row.document_date.toISOString().slice(0, 10),
      row.report_key,
      row.store_key,
      row.item_key,
      row.quantity,
      row.list_revenue / row.quantity,
      row.revenue,
      row.list_revenue,
      round(row.implied_pct, 4),
      row.promo_key,
      row.rule_pct
    ]
      .map(csvValue)
      .join(";")
  )
].join("\n");

writeFileSync(resolve(outDir, "attribution-lines.csv"), `${csv}\n`, "utf8");
writeFileSync(resolve(outDir, "attribution-summary.json"), `${JSON.stringify(summaryPayload, null, 2)}\n`, "utf8");
writeFileSync(
  resolve(outDir, "near-miss-lines.json"),
  `${JSON.stringify(
    {
      tolerance: args.tolerance,
      note: "Строки, чья ближайшая скидка акции отличается от фактической больше допуска, но не больше чем на 0.5 п.п.",
      total: nearMisses.length > 0 ? Number(nearMisses[0].near_miss_count) : 0,
      lines: nearMisses.map((row) => ({
        lineId: Number(row.line_id),
        date: row.document_date.toISOString().slice(0, 10),
        storeKey: row.store_key,
        itemKey: row.item_key,
        promoKey: row.promo_key,
        rulePct: row.rule_pct,
        impliedPct: round(row.implied_pct, 4),
        deviation: round(row.deviation, 4)
      }))
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(`Период: ${args.from.toISOString().slice(0, 10)} — ${args.to.toISOString().slice(0, 10)}`);
console.log(
  `Акций в периоде: сервис ${summary.promotionCount}, пересчёт ${periodPromotionCount}; ` +
    `с продажами: сервис ${summary.promotionWithSalesCount}, пересчёт ${perPromotion.length}`
);
console.log(
  `Выручка по акциям: сервис ${round(summary.promoRevenue, 2)}, пересчёт ${round(totals.revenue, 2)}`
);
console.log(
  `Скидка по акциям: сервис ${round(summary.promoDiscountAmount, 2)}, пересчёт ${round(Math.max(totals.list_revenue - totals.revenue, 0), 2)}`
);
console.log(
  `Строк: сервис ${summary.promoLineCount}, пересчёт ${Number(totals.line_count)}; ` +
    `отчетов: ${summary.promoReportCount} / ${Number(totals.report_count)}; ` +
    `товаров: ${summary.promoItemCount} / ${Number(totals.item_count)}; ` +
    `магазинов: ${summary.promoStoreCount} / ${Number(totals.store_count)}`
);
console.log(`Строк в CSV: ${lines.length} (лимит ${args.lineLimit}); около-допусковых строк: ${nearMisses.length > 0 ? Number(nearMisses[0].near_miss_count) : 0}`);

if (mismatches.length === 0) {
  console.log("Расхождений нет: независимый пересчёт совпал с отчётом сервиса.");
} else {
  console.error(`Расхождения (${mismatches.length}):`);
  for (const mismatch of mismatches) {
    console.error(`  ${mismatch.scope}: ${mismatch.field} — сервис ${mismatch.service}, пересчёт ${mismatch.crossCheck}`);
  }
}

await prisma.$disconnect();
process.exitCode = mismatches.length === 0 ? 0 : 1;
