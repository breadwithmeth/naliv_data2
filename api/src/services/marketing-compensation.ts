import { Prisma } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../prisma.js";
import type { CompensationActivity, CompensationActivityOption, CompensationBranch, CompensationIssue, CompensationRow, CompensationTotals, MarketingCompensationReport, MarketingCompensationRequest } from "./marketing-compensation-types.js";
import { getReloadReadiness, readReloadReadiness, type ReloadReadinessState } from "./reload-readiness.js";
import { projectCompensationReport } from "./marketing-compensation-presentation.js";
import { parseCompensationTitlePercentage } from "./marketing-compensation-percentage.js";
import { loadPurchasePriceEvidence, purchasePriceCte, PURCHASE_PRICE_SOURCES, verifiedCompensationCoverage, type PurchasePriceEvidenceSnapshot } from "./marketing-compensation-purchase-price.js";

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
export const compensationPeriodSchema = z.object({ from: dateField, to: dateField })
  .refine(q => q.from < q.to, "Конец периода должен быть позже начала")
  .refine(q => q.to.getTime() - q.from.getTime() <= 366 * DAY, "Период не должен превышать 366 дней");
export const compensationQuerySchema = compensationPeriodSchema.and(z.object({
  activityKey: z.string().trim().min(1).max(100).optional(),
  calculationMode: z.enum(["purchase-title", "retail-rule"]).default("purchase-title"),
  includeIncomplete: z.preprocess(value => value === "true" ? true : value === "false" ? false : value, z.boolean().default(false))
}));
type Period = { from: Date; to: Date };
type Params = Period & Omit<MarketingCompensationRequest, "from" | "to">;
type Readiness = Pick<ReloadReadinessState, "returnPriceIntervals"> & Partial<Pick<ReloadReadinessState, "coverageSources" | "binding">>;
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
const titlePercentageMessages = {
  missing_percentage: "В названии акции 1С нет корректного процента компенсации.",
  conflicting_percentage: "В названии акции 1С указаны разные проценты или диапазон."
} as const;
const purchasePriceMessages = {
  missing_purchase_price_type: "Для магазина не найден действующий закупочный вид цен 1С.",
  missing_purchase_price: "В загруженной истории нет применимой корректной закупочной цены 1С.",
  ambiguous_purchase_price: "На момент последней применимой установки обнаружены разные закупочные цены 1С.",
  purchase_price_unverified: "Закупочная цена не подтверждена: недоступны данные установок, проверенный период или сверка с регистром 1С в ₸."
} as const;
const money = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
function totals(rows: Iterable<CompensationRow>, blocking = false): CompensationTotals {
  let incompleteRows = 0;
  let sum = new Prisma.Decimal(0);
  for (const row of rows) {
    if (row.compensation === null) incompleteRows++;
    else sum = sum.plus(row.compensation);
  }
  const knownCompensation = money(sum);
  return {
    compensation: blocking || incompleteRows > 0 ? null : knownCompensation,
    knownCompensation, incompleteRows
  };
}
function* financialRows(activities: Iterable<CompensationActivity>) {
  for (const a of activities) for (const b of a.branches) yield* b.rows;
}
function addIssue(issues: CompensationIssue[], code: string, message: string) {
  if (!issues.some(i => i.code === code && i.message === message)) issues.push(issue(code, message));
}
async function availableSources(purchaseTitle = false) {
  const sources = purchaseTitle ? [...Object.values(names), ...Object.values(PURCHASE_PRICE_SOURCES)] : Object.values(names);
  const rows = await prisma.$queryRaw<Array<{ name: string; present: boolean }>>`
    select n as name, to_regclass(format('%I.%I', ${config.PGSCHEMA}, n)) is not null as present
    from unnest(${sources}::text[]) n
  `;
  return new Set(rows.filter(r => r.present).map(r => r.name));
}
async function activityOptions(params: Period, available: Set<string>, activityKey?: string): Promise<CompensationActivityOption[]> {
  if (!available.has(names.activities)) return [];
  return prisma.$queryRaw<CompensationActivityOption[]>`
    select ref_key as key, coalesce(nullif(naimenovanie_aktsii,''), number, ref_key) as name,
      number,
      case when data_nachala_deystviya::date > date '0001-01-01' then data_nachala_deystviya::date::text end as "startsOn",
      case when data_okonchaniya_deystviya::date > date '0001-01-01' then data_okonchaniya_deystviya::date::text end as "endsOn"
    from ${table(names.activities)}
    where posted is true and deletion_mark is not true
      ${activityKey ? Prisma.sql`and ref_key = ${activityKey}` : Prisma.empty}
      and (data_nachala_deystviya is null or data_nachala_deystviya < ${iso(params.to)}::timestamp)
      and (data_okonchaniya_deystviya is null or data_okonchaniya_deystviya::date <= date '0001-01-01' or data_okonchaniya_deystviya::date >= ${iso(params.from)}::date)
    order by naimenovanie_aktsii, ref_key
  `;
}
export async function getMarketingCompensationActivities(input: Params) {
  const params = compensationPeriodSchema.parse(input);
  return { activities: await activityOptions(params, await availableSources()) };
}
const CANDIDATE_BATCH_SIZE = 4096;
type Window = { from: string; to: string };
type RateWindow = Window & { discountPct: string | null; conflict: boolean };
type Schedule = RateWindow & { branchKeys: (string | null)[] };
type Candidate = RateWindow & { id: number; branchKey: string | null; itemKey: string; characteristicKey: string | null };
type DiagnosticWindow = Window & { activityKey: string; segmentKey: string };
// Only SQL fragments owned by this module are identifiers; every scope value is bound.
function loadRows(name: string, columns: Prisma.Sql, predicate: Prisma.Sql) {
  return prisma.$queryRaw<Json[]>`select ${columns} from ${table(name)} where ${predicate}`;
}
function loadByKeys(name: string, columns: Prisma.Sql, key: Prisma.Sql, keys: Set<string | null>) {
  if (!keys.size) return Promise.resolve<Json[]>([]);
  const values: string[] = [];
  for (const value of keys) if (value !== null) values.push(value);
  // ref() groups the empty and zero 1C references with NULL. Keep that lookup semantics.
  if (keys.has(null)) values.push("", ZERO);
  return loadRows(name, columns, Prisma.sql`(${key} = any(${values}::text[]) ${keys.has(null) ? Prisma.sql`or ${key} is null` : Prisma.empty})`);
}
function keysOf(rows: Json[], column: string) {
  const keys = new Set<string | null>();
  for (const row of rows) keys.add(ref(row[column]));
  return keys;
}
function indexRows(rows: Json[]) {
  const index = new Map<string | null, Json>();
  for (const row of rows) index.set(ref(row.ref_key), row);
  return index;
}
async function loadComposition(activityKey: string) {
  const activityKeys = new Set([activityKey]);
  const key = Prisma.sql`ref_key`;
  const parent = Prisma.sql`coalesce(nullif(nullif(_parent_ref_key, ''), ${ZERO}), ref_key)`;
  const [activityRows, rules, activityStores] = await Promise.all([
    loadByKeys(names.activities, Prisma.sql`ref_key, naimenovanie_aktsii, dlya_vseh_magazinov`, key, activityKeys),
    loadByKeys(names.rules, Prisma.sql`${parent} as activity_key, skidka_natsenka_key, magazin_key,
      to_jsonb(data_nachala) as data_nachala, to_jsonb(data_okonchaniya) as data_okonchaniya`, parent, activityKeys),
    loadByKeys(names.activityStores, Prisma.sql`${parent} as activity_key, magazin_key`, parent, activityKeys)
  ]);
  const allStores = activityRows[0]?.dlya_vseh_magazinov === true && rules.some(r => !ref(r.magazin_key));
  const storeKeys = keysOf(activityStores, "magazin_key");
  for (const r of rules) storeKeys.add(ref(r.magazin_key));
  const [discounts, stores] = await Promise.all([
    loadByKeys(names.discounts, Prisma.sql`ref_key, description, segment_nomenklatury_predostavleniya_key, deletion_mark`, key, keysOf(rules, "skidka_natsenka_key")),
    allStores ? loadRows(names.stores, Prisma.sql`ref_key, description`, Prisma.sql`deletion_mark is not true`)
      : loadByKeys(names.stores, Prisma.sql`ref_key, description, deletion_mark`, key, storeKeys)
  ]);
  const segmentKeys = keysOf(discounts.filter(r => r.deletion_mark !== true), "segment_nomenklatury_predostavleniya_key");
  const segments = await loadByKeys(names.segments, Prisma.sql`ref_key, description, deletion_mark`, key, segmentKeys);
  const liveSegments = keysOf(segments.filter(r => r.deletion_mark !== true), "ref_key");
  liveSegments.delete(null); // Membership with no segment reference is never assigned to a rule.
  const membershipStats = liveSegments.size ? await prisma.$queryRaw<Array<{ segment_key: string; invalid_item: boolean }>>`
    select segment_key, bool_or(nomenklatura_key is null or nomenklatura_key in ('', ${ZERO})) as invalid_item
    from ${table(names.membership)} where segment_key = any(${[...liveSegments]}::text[]) group by segment_key
  ` : [];
  return {
    activity: activityRows[0], rules, activityStores,
    storeByKey: indexRows(stores.filter(r => r.deletion_mark !== true)), discountByKey: indexRows(discounts),
    segmentByKey: indexRows(segments), membershipStats: new Map(membershipStats.map(r => [r.segment_key, r.invalid_item]))
  };
}
/** Page whole item+characteristic keys, including every applicable segment before resolving a scope. */
async function* memberPages(segmentKeys: string[]) {
  type Member = { item: string; characteristic: string; segments: string[] };
  let last: Member | undefined;
  const characteristic = Prisma.sql`coalesce(nullif(harakteristika_key, ${ZERO}), '')`;
  while (segmentKeys.length) {
    const rows: Member[] = await prisma.$queryRaw`
      select nomenklatura_key as item, ${characteristic} as characteristic, array_agg(distinct segment_key) as segments
      from ${table(names.membership)} where segment_key = any(${segmentKeys}::text[]) and nomenklatura_key not in ('', ${ZERO})
        ${last ? Prisma.sql`and (nomenklatura_key, ${characteristic}) > (${last.item}, ${last.characteristic})` : Prisma.empty}
      group by 1, 2 order by 1, 2 limit ${CANDIDATE_BATCH_SIZE}
    `;
    yield rows;
    if (rows.length < CANDIDATE_BATCH_SIZE) return;
    last = rows[rows.length - 1];
  }
}

/** Equivalent duplicate rules never multiply movement quantities; contiguous equal-rate slices stay together. */
function* rateWindows(scope: RateWindow[]): Generator<RateWindow> {
  if (scope.length === 1) { yield scope[0]; return; }
  const boundaries = [...new Set(scope.flatMap(s => [s.from, s.to]))].sort();
  let pending: RateWindow | undefined;
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const from = boundaries[i], to = boundaries[i + 1];
    let first: RateWindow | undefined, conflict = false;
    for (const s of scope) if (s.from <= from && s.to >= to) {
      first ??= s;
      conflict ||= s.conflict || first.discountPct !== s.discountPct;
    }
    if (!first) continue;
    const discountPct = conflict ? null : first.discountPct;
    if (pending && pending.to === from && pending.discountPct === discountPct && pending.conflict === conflict) pending.to = to;
    else {
      if (pending) yield pending;
      pending = { from, to, discountPct, conflict };
    }
  }
  if (pending) yield pending;
}

async function* candidateBatches(schedules: Map<string, Schedule[]>) {
  let batch: Candidate[] = [];
  for await (const page of memberPages([...schedules.keys()])) for (const member of page) {
    const byBranch = new Map<string | null, RateWindow[]>();
    for (const segment of member.segments) for (const schedule of schedules.get(segment)!) {
      for (const branch of schedule.branchKeys) {
        const windows = byBranch.get(branch);
        if (windows) windows.push(schedule);
        else byBranch.set(branch, [schedule]);
      }
    }
    for (const [branchKey, schedules] of byBranch) for (const { from, to, discountPct, conflict } of rateWindows(schedules)) {
      batch.push({ id: batch.length, branchKey, itemKey: member.item, characteristicKey: member.characteristic || null,
        from, to, discountPct, conflict });
      if (batch.length === CANDIDATE_BATCH_SIZE) { yield batch; batch = []; }
    }
  }
  if (batch.length) yield batch;
}

/** One period-wide orphan check on compact rule windows, independent of batch boundaries, quantity and assigned store. */
async function unassignedActivities(windows: DiagnosticWindow[], period: Window) {
  if (!windows.length) return new Set<string>();
  const rows = await prisma.$queryRaw<Array<{ key: string }>>`
    with orphan_reports as materialized (
      select r.ref_key, r.date from ${table(names.reports)} r where r.posted is true and r.deletion_mark is not true
        and r.date >= ${period.from}::timestamp and r.date < ${period.to}::timestamp
        and not exists (select 1 from ${table(names.stores)} s where s.ref_key = r.magazin_key and s.deletion_mark is not true)
    ), orphan_movements as (
      select r.date, l.nomenklatura_key as item, coalesce(nullif(l.harakteristika_key, ${ZERO}), '') as characteristic
      from orphan_reports r join ${table(names.sales)} l on coalesce(l._parent_ref_key, l.ref_key) = r.ref_key
      union all
      select r.date, l.nomenklatura_key, coalesce(nullif(l.harakteristika_key, ${ZERO}), '')
      from orphan_reports r join ${table(names.returns)} l on coalesce(l._parent_ref_key, l.ref_key) = r.ref_key
    ), windows as (
      select distinct * from jsonb_to_recordset(${JSON.stringify(windows)}::jsonb)
        as w("activityKey" text, "segmentKey" text, "from" timestamp, "to" timestamp)
    )
    select distinct w."activityKey" as key from windows w join ${table(names.membership)} m on m.segment_key = w."segmentKey"
      join orphan_movements o on o.item = m.nomenklatura_key and o.characteristic = coalesce(nullif(m.harakteristika_key, ${ZERO}), '')
      and o.date >= w."from" and o.date < w."to" where m.nomenklatura_key not in ('', ${ZERO})
      and exists (select 1 from orphan_reports)
  `;
  return new Set(rows.map(r => r.key));
}

/** A window needs a posted report, not an item movement. Reuse this compact branch/day calendar across all batches. */
async function reportDays(period: Window) {
  const rows = await prisma.$queryRaw<Array<{ branch: string; days: string[] }>>`
    select branch, array_agg(day order by day) as days from (
      select distinct magazin_key as branch, date::date::text as day from ${table(names.reports)}
      where posted is true and deletion_mark is not true and ref_key is not null and magazin_key is not null
        and date >= ${period.from}::timestamp and date < ${period.to}::timestamp
    ) calendar group by branch
  `;
  return new Map(rows.map(r => [r.branch, r.days]));
}

function hasReport(days: string[] | undefined, window: Window) {
  if (!days) return false;
  let low = 0, high = days.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (days[mid] < window.from) low = mid + 1;
    else high = mid;
  }
  return low < days.length && days[low] < window.to;
}

type CalculatedSource = {
  id: number; quantity: string | null; missing_quantity: boolean;
  price: string | null; has_sales: boolean; has_returns: boolean;
  unverified_movement: boolean; unverified_return: boolean; missing_price: boolean;
  purchase_price_issue: keyof typeof purchasePriceMessages | null;
};
type BatchContext = {
  activity: CompensationActivity; branches: Map<string | null, CompensationBranch>; storeByKey: Map<string | null, Json>;
  purchaseTitle: boolean; salesReady: boolean; available: Set<string>; readiness: Readiness;
  retailCoverage: Window[] | null; daysByBranch: Map<string, string[]>; purchaseEvidence?: PurchasePriceEvidenceSnapshot;
};

/** Segments come from the materialized 1C membership register, not guessed XML conditions. */
export async function getMarketingCompensationReport(
  input: Params,
  reloadReader: () => Promise<Readiness> = getReloadReadiness,
  purchaseEvidence?: PurchasePriceEvidenceSnapshot
): Promise<MarketingCompensationReport> {
  const params = compensationQuerySchema.parse(input);
  const purchaseTitle = params.calculationMode === "purchase-title";
  const readiness = await reloadReader();
  const available = await availableSources(purchaseTitle);
  const report: MarketingCompensationReport = {
    from: iso(params.from), to: iso(params.to), activityKey: params.activityKey ?? null, includeIncomplete: params.includeIncomplete,
    calculationMode: params.calculationMode,
    activities: [], totals: totals([]), issues: []
  };
  const finish = async () => {
    if (readiness.binding !== undefined) {
      // Bypass the short-lived metadata cache: a reload during the last batch must invalidate the result.
      const latest = await (reloadReader === getReloadReadiness ? readReloadReadiness() : reloadReader());
      if (latest.binding !== readiness.binding) throw Object.assign(new Error("Данные изменились во время расчёта. Обновите отчёт."), { statusCode: 503 });
    }
    return projectCompensationReport(report);
  };
  for (const name of Object.values(names)) if (!available.has(name)) {
    report.issues.push(issue("missing_source", `Не загружен источник 1С: ${name}. Выполните обновление данных.`));
  }
  const options = await activityOptions(params, available, params.activityKey);
  if (params.activityKey && !options.length) report.issues.push(issue("activity_not_found", "Активность не найдена в выбранном периоде."));
  const required = [names.activities, names.rules, names.activityStores, names.discounts, names.segments, names.membership, names.stores, names.items];
  if (required.some(n => !available.has(n))) {
    report.activities = options.map(a => ({ ...a, from: report.from, to: report.to, branches: [], totals: totals([], true), issues: [issue("missing_source", "Расчёт недоступен: состав активности или сегмента не загружен.")] }));
    report.totals = totals([], true);
    return finish();
  }
  if (!options.length) {
    report.totals = totals([], report.issues.length > 0);
    return finish();
  }
  const retailSources = [names.reports, names.sales, names.returns];
  const salesReady = retailSources.every(n => available.has(n));
  const retailCoverage = purchaseTitle ? verifiedCompensationCoverage(readiness.coverageSources, "retail", retailSources) : null;
  const orphanWindows: DiagnosticWindow[] = [];
  let daysByBranch: Map<string, string[]> | undefined;
  for (const option of options) {
    const { activity: raw, rules: activityRules, activityStores, storeByKey, discountByKey, segmentByKey, membershipStats } = await loadComposition(option.key);
    const allStoreKeys = [...storeByKey.keys()].filter((k): k is string => k !== null);
    const start = boundary(option.startsOn);
    const end = boundary(option.endsOn, true);
    const from = Math.max(params.from.getTime(), start ?? params.from.getTime());
    const to = Math.min(params.to.getTime(), end ?? params.to.getTime());
    const activity: CompensationActivity = { ...option, from: iso(new Date(from)), to: iso(new Date(to)), branches: [], totals: totals([]), issues: [] };
    report.activities.push(activity);
    if (start === null || end === null) activity.issues.push(issue("missing_activity_dates", "Не определён период действия активности."));
    if (from >= to) continue;
    const titlePercentage = purchaseTitle ? parseCompensationTitlePercentage(raw.naimenovanie_aktsii) : null;
    if (titlePercentage?.issue) activity.issues.push(issue(titlePercentage.issue, titlePercentageMessages[titlePercentage.issue]));
    const listedStores = [...new Set(activityStores.map(r => ref(r.magazin_key)).filter((k): k is string => k !== null))];
    if (!activityRules.length) activity.issues.push(issue("missing_rule", "У активности нет правил скидки."));
    const schedules = new Map<string, Schedule[]>();
    for (const rule of activityRules) {
      const discount = discountByKey.get(ref(rule.skidka_natsenka_key));
      if (!discount || discount.deletion_mark === true) { activity.issues.push(issue("missing_rule", "Не найдено действующее правило скидки.")); continue; }
      const rate = titlePercentage ? titlePercentage.rate : parseCompensationPercentage(discount.description);
      if (!purchaseTitle && rate === null) activity.issues.push(issue("missing_percentage", "В начале названия правила 1С нет корректного процента компенсации."));
      const segmentKey = ref(discount.segment_nomenklatury_predostavleniya_key);
      const segment = segmentByKey.get(segmentKey);
      if (!segment || segment.deletion_mark === true) { activity.issues.push(issue("missing_segment", "Не найден сегмент номенклатуры правила скидки.")); continue; }
      if (!segmentKey || !membershipStats.has(segmentKey)) { activity.issues.push(issue("empty_segment", `В сегменте «${text(segment.description) ?? segmentKey}» нет загруженной номенклатуры.`)); continue; }
      const windowFrom = Math.max(from, boundary(rule.data_nachala) ?? from);
      const windowTo = Math.min(to, boundary(rule.data_okonchaniya, true) ?? to);
      if (windowFrom >= windowTo) continue;
      const explicitStore = ref(rule.magazin_key);
      const branchKeys = explicitStore ? [explicitStore] : raw.dlya_vseh_magazinov === true
        ? allStoreKeys : listedStores;
      if (!branchKeys.length) activity.issues.push(issue("missing_branch", "Не определён филиал активности."));
      const fromDay = iso(new Date(windowFrom)), toDay = iso(new Date(windowTo));
      const discountPct = rate?.toString() ?? null;
      if (membershipStats.get(segmentKey)) addIssue(activity.issues, "missing_item", "В составе сегмента отсутствует ссылка на номенклатуру.");
      const schedule = { branchKeys: branchKeys.length ? branchKeys : [null], from: fromDay, to: toDay, discountPct,
        conflict: titlePercentage?.issue === "conflicting_percentage" };
      const existing = schedules.get(segmentKey);
      if (existing) existing.push(schedule);
      else schedules.set(segmentKey, [schedule]);
      if (salesReady) orphanWindows.push({ activityKey: option.key, segmentKey, from: fromDay, to: toDay });
    }
    const branches = new Map<string | null, CompensationBranch>();
    for await (const batch of candidateBatches(schedules)) {
      daysByBranch ??= salesReady ? await reportDays(report) : new Map();
      if (purchaseTitle && salesReady) purchaseEvidence ??= await loadPurchasePriceEvidence();
      await appendBatch(batch, { activity, branches, storeByKey, salesReady, readiness, purchaseTitle, retailCoverage, daysByBranch, available, purchaseEvidence });
    }
    activity.issues = [...new Map(activity.issues.map(i => [i.code + i.message, i])).values()];
  }
  const unassigned = await unassignedActivities(orphanWindows, report);
  for (const activity of report.activities) if (unassigned.has(activity.key)) {
    activity.issues.push(issue("missing_branch", "Есть движения товаров активности с неопределённым филиалом за её расчётный интервал."));
  }
  if (unassigned.size) report.issues.push(issue("missing_branch", "Есть движения товаров отчёта с неопределённым филиалом; полный общий итог недоступен."));
  for (const a of report.activities) {
    a.branches.sort((x, y) => x.name.localeCompare(y.name, "ru") || (x.key ?? "").localeCompare(y.key ?? ""));
    for (const b of a.branches) {
      b.rows.sort((x, y) => x.name.localeCompare(y.name, "ru") || x.itemKey.localeCompare(y.itemKey)
        || (x.characteristicKey ?? "").localeCompare(y.characteristicKey ?? "") || x.from.localeCompare(y.from) || x.to.localeCompare(y.to)
        || (x.price === null ? y.price === null ? 0 : 1 : y.price === null ? -1 : x.price - y.price));
      b.totals = totals(b.rows, b.issues.length > 0);
    }
    const blockingIssue = a.issues.some(i => i.code !== "missing_percentage" && (!purchaseTitle || i.code !== "conflicting_percentage"));
    a.totals = totals(financialRows([a]), blockingIssue || a.branches.some(b => b.totals.compensation === null));
  }
  report.totals = totals(financialRows(report.activities), report.issues.length > 0 || report.activities.some(a => a.totals.compensation === null));
  return finish();
}

function valueBatch(candidates: Candidate[], { purchaseTitle, available, readiness, retailCoverage, purchaseEvidence }: BatchContext) {
  const itemKeys = new Set<string>(), branchKeys = new Set<string>();
  let from = candidates[0].from, to = candidates[0].to;
  for (const c of candidates) {
    itemKeys.add(c.itemKey);
    if (c.branchKey !== null) branchKeys.add(c.branchKey);
    if (c.from < from) from = c.from;
    if (c.to > to) to = c.to;
  }
  const itemKeyList = [...itemKeys];
  const salesCte = Prisma.sql`
      reports as materialized (
        select r.ref_key, r.magazin_key, r.date from ${table(names.reports)} r
        where r.posted is true and r.deletion_mark is not true and r.date >= ${from}::timestamp and r.date < ${to}::timestamp
          and r.magazin_key = any(${[...branchKeys]}::text[])
      ),
      movements as (
        select r.magazin_key, r.date, l.nomenklatura_key, nullif(l.harakteristika_key, ${ZERO}) as characteristic,
          l.kolichestvo as quantity, ${purchaseTitle ? Prisma.sql`null::numeric` : Prisma.sql`l.tsena`} as price, 'sale'::text as kind
        from ${table(names.sales)} l join reports r on coalesce(l._parent_ref_key, l.ref_key) = r.ref_key
        where l.nomenklatura_key = any(${itemKeyList}::text[])
        union all
        select r.magazin_key, r.date, l.nomenklatura_key, nullif(l.harakteristika_key, ${ZERO}),
          -abs(l.kolichestvo), ${purchaseTitle ? Prisma.sql`null::numeric` : Prisma.sql`(to_jsonb(l)->>'tsena')::numeric`}, 'return'::text
        from ${table(names.returns)} l join reports r on coalesce(l._parent_ref_key, l.ref_key) = r.ref_key
        where l.nomenklatura_key = any(${itemKeyList}::text[])
      )`;
  const pricedCte = purchaseTitle
      ? purchasePriceCte({ table, stores: names.stores, available, zero: ZERO, itemKeys, from, to,
        coverageSources: readiness.coverageSources, evidence: purchaseEvidence! })
      : Prisma.sql`
        priced as (
          select *, case when not unverified_return and price >= 0 and price::text not in ('NaN','Infinity','-Infinity')
            then price else null end as known_price,
            (price is null or price < 0 or price::text in ('NaN','Infinity','-Infinity')) as missing_price,
            null::text as purchase_price_issue
          from matched
        )`;
  const verifyMovement = retailCoverage ? Prisma.sql`,
        not exists (
          select 1 from jsonb_to_recordset(${JSON.stringify(retailCoverage)}::jsonb) as i("from" date, "to" date)
          where m.date::date >= i."from" and m.date::date < i."to"
        ) as unverified_movement`
      : Prisma.sql`, false as unverified_movement,
        m.kind = 'return' and not exists (
          select 1 from jsonb_to_recordset(${JSON.stringify(readiness.returnPriceIntervals)}::jsonb) as i("from" text, "to" text)
          where m.date >= i."from"::timestamp and m.date < i."to"::timestamp
        ) as unverified_return`;
  return prisma.$queryRaw<CalculatedSource[]>`
      with candidates as materialized (
        select * from jsonb_to_recordset(${JSON.stringify(candidates, ["id", "branchKey", "itemKey", "characteristicKey", "from", "to"])}::jsonb)
          as c(id int, "branchKey" text, "itemKey" text, "characteristicKey" text, "from" text, "to" text)
      ), ${salesCte},
      matched as materialized (
        select c.id, m.* ${verifyMovement}
        from candidates c join movements m on m.magazin_key = c."branchKey" and m.nomenklatura_key = c."itemKey"
          and coalesce(m.characteristic, '') = coalesce(c."characteristicKey", '')
          and m.date >= c."from"::timestamp and m.date < c."to"::timestamp
        where m.quantity <> 0 or m.quantity is null
      ), ${pricedCte}
      select id, known_price::text as price, sum(quantity)::text as quantity, bool_or(quantity is null) as missing_quantity,
        coalesce(bool_or(kind = 'sale' and quantity > 0), false) as has_sales,
        coalesce(bool_or((kind = 'return' and quantity <> 0) or (kind = 'sale' and quantity < 0)), false) as has_returns,
        bool_or(unverified_return) as unverified_return, bool_or(missing_price) as missing_price,
        unverified_movement, purchase_price_issue
      from priced group by id, known_price, unverified_movement, purchase_price_issue
  `;
}

async function appendBatch(candidates: Candidate[], context: BatchContext) {
  const { activity, branches, storeByKey, daysByBranch, purchaseTitle, retailCoverage } = context;
  const calculated = context.salesReady ? await valueBatch(candidates, context) : [];
  // Keep source arrival order within each candidate; avoid allocating an array/map entry for
  // every store × item window (including all the windows with no movements).
  calculated.sort((a, b) => a.id - b.id);
  const movedItems = new Set<string | null>();
  for (const source of calculated) movedItems.add(candidates[source.id].itemKey);
  const itemByKey = indexRows(await loadByKeys(names.items, Prisma.sql`ref_key, description, naimenovanie_polnoe,
    to_jsonb(catalog_nomenklatura)->>'shtrihkod' as shtrihkod, to_jsonb(catalog_nomenklatura)->>'barcode' as barcode`, Prisma.sql`ref_key`, movedItems));
  let sourceIndex = 0;
  for (const c of candidates) {
    let branch = branches.get(c.branchKey);
    const store = storeByKey.get(c.branchKey);
    if (!branch) {
      branch = { key: c.branchKey, name: text(store?.description) ?? "Не определён филиал", rows: [],
        hasSales: false, hasReturns: false, totals: totals([]), issues: [] };
      if (!store) branch.issues.push(issue("missing_branch", "Филиал отсутствует в справочнике магазинов."));
      branches.set(c.branchKey, branch); activity.branches.push(branch);
    }
    if (!hasReport(c.branchKey === null ? undefined : daysByBranch.get(c.branchKey), c)) {
      addIssue(branch.issues, "missing_quantity", `Нет отчётов продаж филиала за интервал [${c.from}, ${c.to}); отсутствие движений не подтверждено.`);
    }
    if (retailCoverage && !retailCoverage.some(interval => interval.from <= c.from && c.to <= interval.to)) {
      addIssue(branch.issues, "retail_movement_unverified", `Полнота движений продаж и возвратов филиала за интервал [${c.from}, ${c.to}) не подтверждена.`);
    }
    while (calculated[sourceIndex]?.id === c.id) {
      const source = calculated[sourceIndex++];
      branch.hasSales ||= source.has_sales;
      branch.hasReturns ||= source.has_returns;
      const item = itemByKey.get(c.itemKey);
      const issues: CompensationIssue[] = [];
      const barcode = text(item?.shtrihkod) ?? text(item?.barcode);
      if (!barcode) issues.push(issue("missing_barcode", "Нет штрихкода карточки номенклатуры в опубликованных данных 1С."));
      if (!item) issues.push(issue("missing_item", "Номенклатура отсутствует в справочнике."));
      const rate = decimal(c.discountPct);
      if (purchaseTitle) {
        const code = c.conflict ? "conflicting_percentage" : rate === null ? "missing_percentage" : null;
        if (code) issues.push(issue(code, titlePercentageMessages[code]));
      } else if (c.conflict) issues.push(issue("conflicting_percentage", "Для товара действуют пересекающиеся правила с разными процентами компенсации."));
      else if (rate === null) issues.push(issue("missing_percentage", "Нет корректного процентного префикса названия правила."));
      const price = decimal(source.price);
      if (source.missing_price) issues.push(issue("missing_price", "Нет корректной цены до скидки в строке продажи/возврата 1С."));
      if (source.unverified_return) issues.push(issue("return_price_unverified", "Цена возврата за этот день ещё не подтверждена сверкой источника и назначения."));
      if (source.purchase_price_issue) issues.push(issue(source.purchase_price_issue, purchasePriceMessages[source.purchase_price_issue]));
      if (source.unverified_movement) issues.push(issue("retail_movement_unverified", "Движение продажи или возврата за этот день не подтверждено сверкой источника и назначения."));
      const quantity = !store || source.missing_quantity ? null : decimal(source.quantity);
      if (quantity === null) issues.push(issue("missing_quantity", "Количество движения не определено."));
      const unit = price !== null && rate !== null ? price.mul(rate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP) : null;
      const compensation = unit !== null && quantity !== null && item && store && !source.unverified_movement ? money(quantity.mul(unit)) : null;
      branch.rows.push({ itemKey: c.itemKey, characteristicKey: c.characteristicKey,
        name: text(item?.naimenovanie_polnoe) ?? text(item?.description) ?? c.itemKey, barcode,
        price: price?.toNumber() ?? null, discountPct: rate?.toNumber() ?? null,
        unitCompensation: unit?.toNumber() ?? null, quantity: quantity?.toNumber() ?? null, compensation,
        from: c.from, to: c.to, issues });
    }
  }
}
