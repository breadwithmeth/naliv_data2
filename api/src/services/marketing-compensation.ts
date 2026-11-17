import { Prisma } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import type { CompensationActivity, CompensationActivityOption, CompensationBranch, CompensationIssue, CompensationRow, CompensationTotals, MarketingCompensationReport } from "./marketing-compensation-types.js";
import { getReloadReadiness, type ReloadReadinessState } from "./reload-readiness.js";
import { projectCompensationReport } from "./marketing-compensation-presentation.js";

const ZERO = "00000000-0000-0000-0000-000000000000";
const DAY = 86_400_000;
const names = {
  activities: "document_marketingovaya_aktsiya",
  rules: "document_marketingovaya_aktsiya_skidki_natsenki",
  activityStores: "document_marketingovaya_aktsiya_magaziny",
  discounts: "catalog_skidki_natsenki",
  segments: "catalog_segmenty_nomenklatury",
  membership: "information_register_nomenklatura_segmenta",
  stores: "catalog_magaziny",
  items: "catalog_nomenklatura",
  reports: "document_otchet_o_roznichnyh_prodazhah",
  sales: "document_otchet_o_roznichnyh_prodazhah_tovary",
  returns: "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary"
} as const;
function table(name: string) {
  return Prisma.raw(`"${config.PGSCHEMA.replaceAll('"', '""')}"."${name}"`);
}
const dateField = z.coerce.date().refine(d => d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0, "Укажите календарную дату");
export const compensationQuerySchema = z.object({
  from: dateField, to: dateField, activityKey: z.string().trim().min(1).max(100).optional(),
  includeIncomplete: z.preprocess(value => value === "true" ? true : value === "false" ? false : value, z.boolean().default(false))
}).refine(q => q.from < q.to, "Конец периода должен быть позже начала")
  .refine(q => q.to.getTime() - q.from.getTime() <= 366 * DAY, "Период не должен превышать 366 дней");
type Params = { from: Date; to: Date; activityKey?: string; includeIncomplete?: boolean };
type Json = Record<string, unknown>;
const ref = (v: unknown): string | null => typeof v === "string" && v && v !== ZERO ? v : null;
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : null;
const issue = (code: string, message: string): CompensationIssue => ({ code, message });
const iso = (d: Date) => d.toISOString().slice(0, 10);
function boundary(v: unknown, end = false): number | null {
  if (typeof v !== "string" || v.slice(0, 10) <= "0001-01-01") return null;
  const n = Date.parse(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(n) ? n + (end ? DAY : 0) : null;
}
function decimal(v: unknown): Prisma.Decimal | null {
  if (v === null || v === undefined || v === "") return null;
  try { const d = new Prisma.Decimal(String(v)); return d.isFinite() ? d : null; } catch { return null; }
}
function parseCompensationPercentage(value: unknown): Prisma.Decimal | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+(?:[.,]\d+)?)\s*%/.exec(value.trimStart());
  if (!match) return null;
  const rate = decimal(match[1].replace(",", "."));
  return rate !== null && rate.gte(0) && rate.lte(100) ? rate : null;
}
const money = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
function totals(rows: CompensationRow[], blocking = false): CompensationTotals {
  const incompleteRows = rows.filter(r => r.compensation === null).length;
  const knownCompensation = money(rows.reduce((sum, r) => sum.plus(r.compensation ?? 0), new Prisma.Decimal(0)));
  return {
    compensation: blocking || incompleteRows > 0 ? null : knownCompensation,
    knownCompensation, incompleteRows
  };
}
async function availableSources() {
  const rows = await prisma.$queryRaw<Array<{ name: string; present: boolean }>>`
    select n as name, to_regclass(format('%I.%I', ${config.PGSCHEMA}, n)) is not null as present
    from unnest(${Object.values(names)}::text[]) n
  `;
  return new Set(rows.filter(r => r.present).map(r => r.name));
}
async function activityOptions(params: Params, available: Set<string>): Promise<CompensationActivityOption[]> {
  if (!available.has(names.activities)) return [];
  return prisma.$queryRaw<CompensationActivityOption[]>`
    select ref_key as key, coalesce(nullif(naimenovanie_aktsii,''), number, ref_key) as name,
      number,
      case when data_nachala_deystviya::date > date '0001-01-01' then data_nachala_deystviya::date::text end as "startsOn",
      case when data_okonchaniya_deystviya::date > date '0001-01-01' then data_okonchaniya_deystviya::date::text end as "endsOn"
    from ${table(names.activities)}
    where posted is true and deletion_mark is not true
      and (data_nachala_deystviya is null or data_nachala_deystviya < ${params.to})
      and (data_okonchaniya_deystviya is null or data_okonchaniya_deystviya::date <= date '0001-01-01' or data_okonchaniya_deystviya::date >= ${params.from}::date)
    order by naimenovanie_aktsii, ref_key
  `;
}
export async function getMarketingCompensationActivities(input: Params) {
  const params = compensationQuerySchema.parse(input);
  return { activities: await activityOptions(params, await availableSources()) };
}
type Candidate = {
  id: number; activityKey: string; branchKey: string | null; itemKey: string; characteristicKey: string | null;
  from: string; to: string; discountPct: string | null; conflict: boolean;
};
type CalculatedSource = {
  id: number; quantity: string | null; missing_quantity: boolean; report_count: bigint | number;
  price: string | null; has_movements: boolean; has_sales: boolean; has_returns: boolean;
  unverified_return: boolean; missing_price: boolean;
};

/** Segments come from the materialized 1C membership register, not guessed XML conditions. */
export async function getMarketingCompensationReport(
  input: Params,
  reloadReader: () => Promise<Pick<ReloadReadinessState, "returnPriceIntervals">> = getReloadReadiness
): Promise<MarketingCompensationReport> {
  const params = compensationQuerySchema.parse(input);
  const [available, readiness] = await Promise.all([availableSources(), reloadReader()]);
  const report: MarketingCompensationReport = {
    from: iso(params.from), to: iso(params.to), activityKey: params.activityKey ?? null, includeIncomplete: params.includeIncomplete,
    activities: [], totals: totals([]), issues: []
  };
  for (const name of Object.values(names)) if (!available.has(name)) {
    report.issues.push(issue("missing_source", `Не загружен источник 1С: ${name}. Выполните обновление данных.`));
  }
  const options = (await activityOptions(params, available)).filter(a => !params.activityKey || a.key === params.activityKey);
  if (params.activityKey && !options.length) report.issues.push(issue("activity_not_found", "Активность не найдена в выбранном периоде."));
  const required = [names.activities, names.rules, names.activityStores, names.discounts, names.segments, names.membership, names.stores, names.items];
  if (required.some(n => !available.has(n))) {
    report.activities = options.map(a => ({ ...a, from: report.from, to: report.to, branches: [], totals: totals([], true), issues: [issue("missing_source", "Расчёт недоступен: состав активности или сегмента не загружен.")] }));
    report.totals = totals([], true);
    return projectCompensationReport(report);
  }
  const load = async (name: string, columns: string) => (await prisma.$queryRaw<Array<{ data: Json }>>`
    select to_jsonb(t) as data from (select ${Prisma.raw(columns)} from ${table(name)}) t
  `).map(r => r.data);
  const [activityRows, rules, activityStores, discounts, segments, stores, items, members] = await Promise.all([
    load(names.activities, "ref_key, data_nachala_deystviya, data_okonchaniya_deystviya, dlya_vseh_magazinov"),
    load(names.rules, "_parent_ref_key, ref_key, skidka_natsenka_key, magazin_key, data_nachala, data_okonchaniya"),
    load(names.activityStores, "_parent_ref_key, ref_key, magazin_key"),
    load(names.discounts, "ref_key, description, segment_nomenklatury_predostavleniya_key, deletion_mark"),
    load(names.segments, "ref_key, description, deletion_mark"),
    load(names.stores, "ref_key, description, deletion_mark"),
    load(names.items, "ref_key, description, naimenovanie_polnoe, to_jsonb(catalog_nomenklatura)->>'shtrihkod' as shtrihkod, to_jsonb(catalog_nomenklatura)->>'barcode' as barcode"),
    load(names.membership, "segment_key, nomenklatura_key, harakteristika_key")
  ]);
  const activitiesByKey = new Map(activityRows.map(r => [ref(r.ref_key), r]));
  const storeByKey = new Map(stores.filter(r => r.deletion_mark !== true).map(r => [ref(r.ref_key), r]));
  const itemByKey = new Map(items.map(r => [ref(r.ref_key), r]));
  const discountByKey = new Map(discounts.map(r => [ref(r.ref_key), r]));
  const percentageByKey = new Map(discounts.map(r => [ref(r.ref_key), parseCompensationPercentage(r.description)]));
  const segmentByKey = new Map(segments.map(r => [ref(r.ref_key), r]));
  const parent = (r: Json) => ref(r._parent_ref_key) ?? ref(r.ref_key);
  const memberMap = new Map<string, Json[]>();
  for (const m of members) {
    const key = ref(m.segment_key);
    if (key) { const list = memberMap.get(key) ?? []; list.push(m); memberMap.set(key, list); }
  }
  const candidates: Candidate[] = [];
  const activityMap = new Map<string, CompensationActivity>();
  for (const option of options) {
    const raw = activitiesByKey.get(option.key)!;
    const start = boundary(raw.data_nachala_deystviya);
    const end = boundary(raw.data_okonchaniya_deystviya, true);
    const from = Math.max(params.from.getTime(), start ?? params.from.getTime());
    const to = Math.min(params.to.getTime(), end ?? params.to.getTime());
    const activity: CompensationActivity = { ...option, from: iso(new Date(from)), to: iso(new Date(to)), branches: [], totals: totals([]), issues: [] };
    report.activities.push(activity); activityMap.set(option.key, activity);
    if (start === null || end === null) activity.issues.push(issue("missing_activity_dates", "Не определён период действия активности."));
    if (from >= to) continue;
    const activityRules = rules.filter(r => parent(r) === option.key);
    if (!activityRules.length) activity.issues.push(issue("missing_rule", "У активности нет правил скидки."));
    const scopes = new Map<string, Array<Omit<Candidate, "id">>>();
    for (const rule of activityRules) {
      const discount = discountByKey.get(ref(rule.skidka_natsenka_key));
      if (!discount || discount.deletion_mark === true) { activity.issues.push(issue("missing_rule", "Не найдено действующее правило скидки.")); continue; }
      const rate = percentageByKey.get(ref(rule.skidka_natsenka_key)) ?? null;
      if (rate === null) activity.issues.push(issue("missing_percentage", "В начале названия правила 1С нет корректного процента компенсации."));
      const segmentKey = ref(discount.segment_nomenklatury_predostavleniya_key);
      const segment = segmentByKey.get(segmentKey);
      if (!segment || segment.deletion_mark === true) { activity.issues.push(issue("missing_segment", "Не найден сегмент номенклатуры правила скидки.")); continue; }
      const membership = memberMap.get(segmentKey!) ?? [];
      if (!membership.length) { activity.issues.push(issue("empty_segment", `В сегменте «${text(segment.description) ?? segmentKey}» нет загруженной номенклатуры.`)); continue; }
      const windowFrom = Math.max(from, boundary(rule.data_nachala) ?? from);
      const windowTo = Math.min(to, boundary(rule.data_okonchaniya, true) ?? to);
      if (windowFrom >= windowTo) continue;
      const explicitStore = ref(rule.magazin_key);
      const branchKeys = explicitStore ? [explicitStore] : raw.dlya_vseh_magazinov === true
        ? [...storeByKey.keys()].filter((k): k is string => k !== null)
        : [...new Set(activityStores.filter(r => parent(r) === option.key).map(r => ref(r.magazin_key)).filter((k): k is string => k !== null))];
      if (!branchKeys.length) activity.issues.push(issue("missing_branch", "Не определён филиал активности."));
      for (const branchKey of branchKeys.length ? branchKeys : [null]) for (const member of membership) {
        const itemKey = ref(member.nomenklatura_key);
        if (!itemKey) { activity.issues.push(issue("missing_item", "В составе сегмента отсутствует ссылка на номенклатуру.")); continue; }
        const characteristicKey = ref(member.harakteristika_key);
        const key = JSON.stringify([branchKey, itemKey, characteristicKey]);
        const list = scopes.get(key) ?? [];
        list.push({ activityKey: option.key, branchKey, itemKey, characteristicKey,
          from: iso(new Date(windowFrom)), to: iso(new Date(windowTo)),
          discountPct: rate?.toString() ?? null, conflict: false });
        scopes.set(key, list);
      }
    }
    // Partition overlapping schedules once. Duplicate membership/rules cannot multiply quantity.
    for (const scope of scopes.values()) {
      const boundaries = [...new Set(scope.flatMap(s => [s.from, s.to]))].sort();
      const slices: Array<Omit<Candidate, "id">> = [];
      for (let i = 0; i + 1 < boundaries.length; i++) {
        const active = scope.filter(s => s.from <= boundaries[i] && s.to >= boundaries[i + 1]);
        if (!active.length) continue;
        const rates = new Set(active.map(s => s.discountPct));
        const next = { ...active[0], from: boundaries[i], to: boundaries[i + 1], discountPct: rates.size === 1 ? active[0].discountPct : null, conflict: rates.size > 1 };
        const previous = slices.at(-1);
        if (previous && previous.to === next.from && previous.discountPct === next.discountPct && previous.conflict === next.conflict) previous.to = next.to;
        else slices.push(next);
      }
      for (const slice of slices) candidates.push({ ...slice, id: candidates.length });
    }
    activity.issues = [...new Map(activity.issues.map(i => [i.code + i.message, i])).values()];
  }
  const salesReady = [names.reports, names.sales, names.returns].every(n => available.has(n));
  let calculated: CalculatedSource[] = [];
  if (candidates.length) {
    const itemKeys = [...new Set(candidates.map(c => c.itemKey))];
    const salesCte = salesReady ? Prisma.sql`
      reports as materialized (
        select r.ref_key, r.magazin_key, r.date from ${table(names.reports)} r
        where r.posted is true and r.deletion_mark is not true and r.date >= ${params.from} and r.date < ${params.to}
      ),
      movements as materialized (
        select r.magazin_key, r.date, l.nomenklatura_key, nullif(l.harakteristika_key, ${ZERO}) as characteristic,
          l.kolichestvo as quantity, l.tsena as price, 'sale'::text as kind
        from ${table(names.sales)} l join reports r on coalesce(l._parent_ref_key, l.ref_key) = r.ref_key
        where l.nomenklatura_key = any(${itemKeys}::text[])
        union all
        select r.magazin_key, r.date, l.nomenklatura_key, nullif(l.harakteristika_key, ${ZERO}),
          -abs(l.kolichestvo), (to_jsonb(l)->>'tsena')::numeric, 'return'::text
        from ${table(names.returns)} l join reports r on coalesce(l._parent_ref_key, l.ref_key) = r.ref_key
        where l.nomenklatura_key = any(${itemKeys}::text[])
      )` : Prisma.sql`
      reports as (select null::text as ref_key, null::text as magazin_key, null::timestamp as date where false),
      movements as (select null::text as magazin_key, null::timestamp as date, null::text as nomenklatura_key,
        null::text as characteristic, null::numeric as quantity, null::numeric as price, null::text as kind where false)`;
    calculated = await prisma.$queryRaw<CalculatedSource[]>`
      with candidates as materialized (
        select * from jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb)
          as c(id int, "branchKey" text, "itemKey" text, "characteristicKey" text, "from" text, "to" text)
      ), ${salesCte},
      return_price_intervals as (
        select * from jsonb_to_recordset(${JSON.stringify(readiness.returnPriceIntervals)}::jsonb) as i("from" text, "to" text)
      ),
      coverage_scopes as (select distinct "branchKey", "from", "to" from candidates),
      coverage_results as (
        select c."branchKey", c."from", c."to", count(r.ref_key) as report_count
        from coverage_scopes c left join reports r on r.magazin_key = c."branchKey"
          and r.date >= c."from"::timestamp and r.date < c."to"::timestamp
        group by c."branchKey", c."from", c."to"
      ),
      matched as (
        select c.id, m.*,
          m.kind = 'return' and not exists (
            select 1 from return_price_intervals i where m.date >= i."from"::timestamp and m.date < i."to"::timestamp
          ) as unverified_return
        from candidates c join movements m on m.magazin_key = c."branchKey" and m.nomenklatura_key = c."itemKey"
          and coalesce(m.characteristic, '') = coalesce(c."characteristicKey", '')
          and m.date >= c."from"::timestamp and m.date < c."to"::timestamp
        where m.quantity <> 0 or m.quantity is null
      ),
      priced as (
        select *, case when not unverified_return and price >= 0 and price::text not in ('NaN','Infinity','-Infinity')
          then price else null end as known_price
        from matched
      ),
      movement_results as (
        select id, known_price::text as price, sum(quantity)::text as quantity,
          bool_or(quantity is null) as missing_quantity, true as has_movements,
          bool_or(kind = 'sale' and quantity > 0) as has_sales,
          bool_or((kind = 'return' and quantity <> 0) or (kind = 'sale' and quantity < 0)) as has_returns,
          bool_or(unverified_return) as unverified_return,
          bool_or(price is null or price < 0 or price::text in ('NaN','Infinity','-Infinity')) as missing_price
        from priced group by id, known_price
      )
      select c.id, q.quantity, coalesce(q.missing_quantity, false) as missing_quantity,
        coalesce(coverage.report_count, 0) as report_count, q.price,
        coalesce(q.has_movements, false) as has_movements, coalesce(q.has_sales, false) as has_sales,
        coalesce(q.has_returns, false) as has_returns, coalesce(q.unverified_return, false) as unverified_return,
        coalesce(q.missing_price, false) as missing_price
      from candidates c
      left join coverage_results coverage on coverage."branchKey" = c."branchKey" and coverage."from" = c."from" and coverage."to" = c."to"
      left join movement_results q on q.id = c.id
    `;
  }
  const byId = new Map<number, CalculatedSource[]>();
  for (const row of calculated) {
    const group = byId.get(row.id) ?? [];
    group.push(row);
    byId.set(row.id, group);
  }
  const branchMaps = new Map<string, Map<string | null, CompensationBranch>>();
  for (const c of candidates) {
    const activity = activityMap.get(c.activityKey)!;
    let branches = branchMaps.get(c.activityKey);
    if (!branches) { branches = new Map(); branchMaps.set(c.activityKey, branches); }
    let branch = branches.get(c.branchKey);
    const store = storeByKey.get(c.branchKey);
    if (!branch) {
      branch = { key: c.branchKey, name: text(store?.description) ?? "Не определён филиал", rows: [],
        hasSales: false, hasReturns: false, totals: totals([]), issues: [] };
      if (!store) branch.issues.push(issue("missing_branch", "Филиал отсутствует в справочнике магазинов."));
      branches.set(c.branchKey, branch); activity.branches.push(branch);
    }
    const sources = byId.get(c.id) ?? [];
    if (!salesReady || !sources.length || sources.some(s => Number(s.report_count) === 0)) {
      branch.issues.push(issue("missing_quantity", `Нет отчётов продаж филиала за интервал [${c.from}, ${c.to}); отсутствие движений не подтверждено.`));
    }
    for (const source of sources) {
      if (!source.has_movements) continue;
      branch.hasSales ||= source.has_sales;
      branch.hasReturns ||= source.has_returns;
      const item = itemByKey.get(c.itemKey);
      const issues: CompensationIssue[] = [];
      const barcode = text(item?.shtrihkod) ?? text(item?.barcode);
      if (!barcode) issues.push(issue("missing_barcode", "Нет штрихкода карточки номенклатуры в опубликованных данных 1С."));
      if (!item) issues.push(issue("missing_item", "Номенклатура отсутствует в справочнике."));
      const rate = decimal(c.discountPct);
      if (c.conflict) issues.push(issue("conflicting_percentage", "Для товара действуют пересекающиеся правила с разными процентами компенсации."));
      else if (rate === null) issues.push(issue("missing_percentage", "Нет корректного процентного префикса названия правила."));
      const price = decimal(source.price);
      if (source.missing_price) issues.push(issue("missing_price", "Нет корректной цены до скидки в строке продажи/возврата 1С."));
      if (source.unverified_return) issues.push(issue("return_price_unverified", "Цена возврата за этот день ещё не подтверждена сверкой источника и назначения."));
      const quantity = !store || source.missing_quantity ? null : decimal(source.quantity);
      if (quantity === null) issues.push(issue("missing_quantity", "Количество движения не определено."));
      const unit = price !== null && rate !== null ? price.mul(rate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP) : null;
      const compensation = unit !== null && quantity !== null && item && store ? money(quantity.mul(unit)) : null;
      branch.rows.push({ itemKey: c.itemKey, characteristicKey: c.characteristicKey,
        name: text(item?.naimenovanie_polnoe) ?? text(item?.description) ?? c.itemKey, barcode,
        price: price?.toNumber() ?? null, discountPct: rate?.toNumber() ?? null,
        unitCompensation: unit?.toNumber() ?? null, quantity: quantity?.toNumber() ?? null, compensation,
        from: c.from, to: c.to, issues });
    }
  }
  // Unassigned report movements cannot be silently excluded from an apparently complete total.
  if (salesReady && candidates.length) {
    const unknown = await prisma.$queryRaw<Array<{ activity_key: string }>>`
      with scope as (
        select * from jsonb_to_recordset(${JSON.stringify(candidates)}::jsonb)
          as c("activityKey" text, "itemKey" text, "characteristicKey" text, "from" text, "to" text)
      ), unassigned_reports as materialized (
        select r.ref_key, r.date from ${table(names.reports)} r
        where r.posted is true and r.deletion_mark is not true and r.date >= ${params.from} and r.date < ${params.to}
          and not exists (select 1 from ${table(names.stores)} s where s.ref_key = r.magazin_key and s.deletion_mark is not true)
      ), movements as (
        select r.date, l.nomenklatura_key, nullif(l.harakteristika_key, ${ZERO}) as characteristic
        from ${table(names.sales)} l join unassigned_reports r on coalesce(l._parent_ref_key, l.ref_key) = r.ref_key
        union all
        select r.date, l.nomenklatura_key, nullif(l.harakteristika_key, ${ZERO})
        from ${table(names.returns)} l join unassigned_reports r on coalesce(l._parent_ref_key, l.ref_key) = r.ref_key
      )
      select distinct c."activityKey" as activity_key from scope c join movements m
        on m.nomenklatura_key = c."itemKey" and coalesce(m.characteristic, '') = coalesce(c."characteristicKey", '')
        and m.date >= c."from"::timestamp and m.date < c."to"::timestamp
    `;
    for (const row of unknown) activityMap.get(row.activity_key)!.issues.push(issue("missing_branch", "Есть движения товаров активности с неопределённым филиалом за её расчётный интервал."));
    if (unknown.length) report.issues.push(issue("missing_branch", "Есть движения товаров отчёта с неопределённым филиалом; полный общий итог недоступен."));
  }
  for (const a of report.activities) {
    a.branches.sort((x, y) => x.name.localeCompare(y.name, "ru") || (x.key ?? "").localeCompare(y.key ?? ""));
    for (const b of a.branches) {
      b.rows.sort((x, y) => x.name.localeCompare(y.name, "ru") || x.itemKey.localeCompare(y.itemKey)
        || (x.characteristicKey ?? "").localeCompare(y.characteristicKey ?? "") || x.from.localeCompare(y.from) || x.to.localeCompare(y.to)
        || (x.price === null ? y.price === null ? 0 : 1 : y.price === null ? -1 : x.price - y.price));
      b.issues = [...new Map(b.issues.map(i => [i.code + i.message, i])).values()];
      b.totals = totals(b.rows, b.issues.length > 0);
    }
    a.totals = totals(a.branches.flatMap(b => b.rows), a.issues.some(i => i.code !== "missing_percentage") || a.branches.some(b => b.totals.compensation === null));
  }
  report.totals = totals(report.activities.flatMap(a => a.branches.flatMap(b => b.rows)), report.issues.length > 0 || report.activities.some(a => a.totals.compensation === null));
  return projectCompensationReport(report);
}
