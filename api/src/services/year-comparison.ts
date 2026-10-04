import { Prisma } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { canonicalItemCostsCtes } from "../lib/cost-sql.js";
import { prisma } from "../prisma.js";

export const comparisonMembers = [
  "Пивной напиток", "Пиво бут", "Пиво жб", "Пиво розлив", "Разливные напитки", "Энергетический напиток"
] as const;

export type ComparisonPeriod = "current" | "previous";
export type DateWindow = { from: string; to: string };
const dayMilliseconds = 86_400_000;

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 2) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const dateField = z.string().refine(validDate, "Ожидается существующая дата YYYY-MM-DD (год от 0002)");
export const yearComparisonQuerySchema = z.object({
  from: dateField,
  to: dateField,
  cohort: z.enum(["observed", "custom"]).default("observed"),
  comparableStore: z.union([z.string(), z.array(z.string())]).optional()
    .transform((value) => [...new Set(typeof value === "string" ? [value] : value ?? [])].sort())
}).superRefine((value, context) => {
  const days = (Date.parse(value.to) - Date.parse(value.from)) / dayMilliseconds;
  if (!(days > 0 && days <= 366)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "Период [from,to) должен содержать от 1 до 366 дней" });
  }
  if (value.cohort === "observed" && value.comparableStore.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["comparableStore"], message: "Ручной список магазинов требует cohort=custom" });
  }
});
export type YearComparisonParams = z.infer<typeof yearComparisonQuerySchema>;

export function previousCalendarYear(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  date.setUTCMonth(month + 1, 0);
  date.setUTCDate(Math.min(day, date.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

export type ComparisonStore = {
  key: string; name: string; city: string; sourceStoreKeys: string[]; comparableByActivity: boolean;
};
export type ComparisonCoverage = {
  period: ComparisonPeriod; coveredDays: number; expectedDays: number; receiptCount: number;
  status: "observed" | "partial" | "empty"; dateFrom: string | null; dateTo: string | null;
  missingDays: string[];
};
export type ComparisonAggregate = {
  period: ComparisonPeriod; scope: "store" | "city" | "all" | "cohort"; scopeKey: string;
  groupKind: "comparison" | "root" | "within" | "presentation"; groupKey: string;
  quantity: number; revenue: number; estimatedCost: number | null; estimatedGrossIncome: number | null;
  valuedCost: number; valuedRevenue: number; unvaluedRevenue: number;
  absoluteQuantity: number; unvaluedQuantity: number; lineCount: number; receiptCount: number;
  avgQuantityPerReceipt: number | null; avgAmountPerReceipt: number | null;
};
export type PeriodQuality = {
  period: ComparisonPeriod; headerRevenue: number | null; lineRevenue: number | null;
  difference: number | null; headerCount: number; positiveSaleReceiptCount: number;
  returnReceiptCount: number; receiptsWithoutLines: number; lineCount: number;
  absoluteQuantity: number; unvaluedQuantity: number; valuedCost: number | null;
  unvaluedRevenue: number | null; estimatedGrossIncome: number | null;
};
export type TaxonomyAudit = {
  itemKey: string; name: string; rootKey: string; rootName: string; member: string | null;
  issue: string | null; path: string[]; currentQuantity: number; currentRevenue: number;
  previousQuantity: number; previousRevenue: number;
  presentationKind?: "packaged" | "draught" | "unclassified" | "other";
  presentationCategoryKey?: string;
  presentationCategoryName?: string;
  presentationReason?: string;
};
export type YearComparisonReport = {
  periods: { current: DateWindow; previous: DateWindow };
  stores: ComparisonStore[];
  coverage: ComparisonCoverage[];
  cohort: { mode: "observed" | "custom"; selectedStoreKeys: string[] };
  aggregates: ComparisonAggregate[];
  dataQuality: {
    periods: PeriodQuality[];
    global: { dateFrom: string | null; dateTo: string | null; coveredDays: number };
    sourceStores: { key: string; name: string; physicalKey: string; city: string }[];
    taxonomy: TaxonomyAudit[];
    valuation: {
      period: ComparisonPeriod; sourceStoreKey: string; itemKey: string; unitCost: number | null;
      source: string; quantity: number; revenue: number; absoluteQuantity: number; valuedCost: number | null;
      unvaluedRevenue?: number;
    }[];
  };
  generatedAt: string;
  methodology: string[];
};
export type YearComparisonOptions = {
  presentationGroups?: boolean;
  client?: Prisma.TransactionClient;
};
type YearComparisonPayload = Omit<YearComparisonReport, "periods" | "cohort" | "methodology">;

export const comparisonMethodology = [
  "Даты из запроса: [from,to), правая граница исключена. Это сохраненный бизнес-календарь 1С (timestamp без часового пояса; синхронизация Asia/Qyzylorda), без пересчета времени чеков в UTC. UTC используется только для календарной арифметики/кодирования границ и времени создания файла. Предыдущий период — те же календарные границы годом ранее; 29 февраля ограничено 28 февраля при необходимости.",
  "Источник количества и выручки — строки проведенных, неудаленных Чеков ККМ с ненулевой суммой документа; не отчеты о розничных продажах. Возвраты уменьшают количество, выручку и оценочную стоимость; знак возврата нормализуется один раз.",
  "Количество сохраняет исходные единицы 1С, включая услуги. Смешанные количества не являются нормализованными физическими штуками или литрами; пересчет единиц не выполняется.",
  "Выручка содержит НДС, записанный в розничных суммах 1С. НДС из чеков отдельно не выделен. Эти суммы нельзя интерпретировать как выручку без НДС.",
  "ВД — оценочный валовой доход, не исторический COGS, прибыль или P&L. Каждое окно оценивается отдельно на его исключенную конечную границу. Иерархия цены: последний активный регистр магазина; последний документ стоимости магазина; последний общий документ стоимости; взвешенная закупочная цена за 90 дней (сумма минус НДС). Все источники строго до границы окна.",
  "Равные моменты и номера записей разрешаются детерминированно: для документов — по ключу документа, затем цене; для регистра — по цене. Порядок чтения строк или выбор индекса не меняет оценку.",
  "При неизвестной стоимости материального количества ВД всего агрегата недоступен; известная часть стоимости и покрытие показаны отдельно. Отсутствующие данные — n/a, не реальный ноль; нулевой знаменатель — n/a, не выдуманный рост.",
  "Используется текущая иерархия catalog_nomenklatura, а не историческая классификация. Дубли ссылок каталогов устранены. Ближайшая подходящая папка определяет член группы; корневая папка определяет общую долю. Циклы, отсутствующие предки и глубина свыше 64 отмечены как несопоставленные.",
  "Объединенная категория содержит шесть листовых категорий сравнения. Мульти пак исключен из нее, как в исходной книге, но включен в доли внутри группы. Прочие позиции корней группы и несопоставленные товары доступны в аудите/долях, не отбрасываются.",
  "Физическая точка — часть адреса от г., с нормализацией регистра и пробелов, без нечеткого объединения адресов. При отсутствии распознаваемого адреса используется исходный ключ. Стоимость рассчитывается по исходному ключу магазина до объединения юридических лиц.",
  "Автоматическая сопоставимая сеть — точки с положительными продажными чеками в обоих окнах по всем товарам. Это признак активности, не доказательство даты открытия. Ручная сеть — явно выбранные ключи; разрешен пустой список. Разрешенный состав зафиксирован на листе Магазины.",
  "Чеки — DISTINCT положительные продажные документы, без возвратов. Объединенные категории/итоги считают уникальные чеки напрямую, а не складывают чеки категорий. Средние = нетто количество или сумма / положительные продажные чеки; городские и сетевые средние пересчитаны, не суммируются.",
  "Покрытие — дни с наблюдаемыми подходящими чеками, а не доказательство полноты загрузки. Пропущенные дни, глобальная история, сверка заголовков со строками и стоимость показаны в Качество данных. Все агрегаты и метаданные прочитаны одним SQL-снимком."
];

function table(name: string) {
  return Prisma.raw(`"${config.PGSCHEMA.replaceAll('"', '""')}"."${name}"`);
}

function costsForWindow(period: ComparisonPeriod, to: string) {
  return Prisma.sql`
    with ${canonicalItemCostsCtes(new Date(`${to}T00:00:00Z`))}
    select p.period, p.store_key, p.item_key,
      coalesce(l.unit_cost, d.unit_cost, g.unit_cost, b.unit_cost)::numeric as unit_cost,
      case when l.unit_cost is not null then 'live-store-register'
        when d.unit_cost is not null then 'store-cost-document'
        when g.unit_cost is not null then 'global-cost-document'
        when b.unit_cost is not null then 'purchase-90d' else 'unavailable' end as source
    from item_pair_facts p
    left join live_store_costs l on l.magazin_key = p.store_key and l.nomenklatura_key = p.item_key and p.item_key <> ''
    left join document_store_costs d on d.magazin_key = p.store_key and d.nomenklatura_key = p.item_key and p.item_key <> ''
    left join latest_global_costs g on g.nomenklatura_key = p.item_key and p.item_key <> ''
    left join purchase_costs_90d b on b.nomenklatura_key = p.item_key and p.item_key <> ''
    where p.period = ${period}
  `;
}

// Some source databases use C collation, whose case folding is ASCII-only.
// Keep outlet/category/operation normalization independent of server locale.
function russianLower(expression: Prisma.Sql) {
  return Prisma.sql`translate(lower(${expression}),
    'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
    'абвгдеёжзийклмнопрстуфхцчшщъыьэюя')`;
}

/** One statement keeps dates, receipts, catalogs, costing and both windows on the same snapshot. */
export async function getYearComparison(input: YearComparisonParams, options: YearComparisonOptions = {}): Promise<YearComparisonReport> {
  const params = yearComparisonQuerySchema.parse(input);
  const periods = {
    current: { from: params.from, to: params.to },
    previous: { from: previousCalendarYear(params.from), to: previousCalendarYear(params.to) }
  };
  const presentationGroups = options.presentationGroups === true;
  const taxonomySource = Prisma.raw(presentationGroups ? "presentation_taxonomy" : "item_taxonomy");
  const presentationTaxonomyCtes = presentationGroups ? Prisma.sql`
    , presentation_category_ancestors as (
      select distinct on (a.item_key) a.item_key, a.ref_key, a.description
      from ancestors a join root_ancestors root on root.item_key = a.item_key and a.parent_key = root.ref_key
      where a.is_folder = true
      order by a.item_key, a.depth desc, a.ref_key
    ), presentation_categories as (
      select t.*, ${russianLower(Prisma.sql`trim(t.root_name)`)} as normalized_root_name,
        ${russianLower(Prisma.sql`t.name`)} as normalized_name,
        coalesce(child.ref_key, t.root_key) as presentation_category_key,
        case when child.ref_key is null or child.description = t.root_name then t.root_name
          else t.root_name || ' / ' || coalesce(nullif(child.description, ''), child.ref_key) end as presentation_category_name
      from item_taxonomy t
      left join presentation_category_ancestors child on child.item_key = t.item_key and t.issue is null
    ), presentation_signals as (
      select p.*,
        coalesce(p.member in ('Пиво розлив', 'Разливные напитки'), false)
          or (p.normalized_root_name in ('пиво', 'напитки', 'алкоголь', 'энергетические напитки', 'бар')
            and (p.normalized_name like '%розлив%' or p.normalized_name like '%разлив%')) as is_draught,
        coalesce(p.member in ('Пиво бут', 'Пиво жб', 'Пивной напиток', 'Мульти пак'), false) as has_packaged_member
      from presentation_categories p
    ), presentation_classification as (
      select p.*,
        case when p.issue is not null then 'other'
          when p.is_draught then 'draught'
          when p.normalized_root_name = 'бар' then 'other'
          when p.has_packaged_member or p.normalized_root_name in ('алкоголь', 'напитки', 'энергетические напитки') then 'packaged'
          when p.normalized_root_name = 'пиво' then 'unclassified'
          else 'other' end as presentation_kind
      from presentation_signals p
    ), presentation_taxonomy as (
      select p.*,
        case when p.issue is not null then 'Не классифицировано: ' || p.issue
          when p.presentation_kind = 'draught' and p.member in ('Пиво розлив', 'Разливные напитки')
            then 'Ближайшая типовая папка: ' || p.member
          when p.presentation_kind = 'draught'
            then 'Явное «розлив/разлив» в наименовании в корне ' || p.root_name
          when p.normalized_root_name = 'бар' then 'Бар без признака розлива — прочее'
          when p.member in ('Пиво бут', 'Пиво жб', 'Пивной напиток', 'Мульти пак')
            then 'Ближайшая типовая папка: ' || p.member
          when p.presentation_kind = 'packaged' then 'Фасованные напитки по корневой папке: ' || p.root_name
          when p.presentation_kind = 'unclassified' then 'Пиво без распознанного фасованного/розливного типа'
          else 'Корень вне групп напитков: ' || p.root_name end as presentation_reason
      from presentation_classification p
    )
  ` : Prisma.empty;
  const presentationUnions = presentationGroups ? Prisma.sql`
    union all select 'presentation', 'total'
    union all select 'presentation', t.presentation_kind
      where t.presentation_kind in ('packaged', 'draught', 'unclassified')
    union all select 'presentation', t.presentation_kind || ':category:' || t.presentation_category_key
      where t.presentation_kind in ('packaged', 'draught', 'unclassified')
  ` : Prisma.empty;
  const presentationAudit = presentationGroups ? Prisma.sql`
    || jsonb_build_object('presentationKind', t.presentation_kind,
      'presentationCategoryKey', t.presentation_category_key, 'presentationCategoryName', t.presentation_category_name,
      'presentationReason', t.presentation_reason)
  ` : Prisma.empty;
  const presentationValuation = presentationGroups ? Prisma.sql`
    || jsonb_build_object('unvaluedRevenue', case when c.unit_cost is null then f.material_revenue else 0 end)
  ` : Prisma.empty;
  const payloadQuery = Prisma.sql`
    with recursive windows(period, date_from, date_to) as (
      values ('current'::text, ${periods.current.from}::timestamp, ${periods.current.to}::timestamp),
             ('previous'::text, ${periods.previous.from}::timestamp, ${periods.previous.to}::timestamp)
    ), selected_checks as materialized (
      select w.period, c.ref_key, c.date, coalesce(nullif(c.magazin_key, ''), 'Без магазина') as store_key,
        coalesce(c.summa_dokumenta, 0)::numeric as document_amount,
        ${russianLower(Prisma.sql`coalesce(c.vid_operatsii, '')`)} like '%возврат%' as is_return
      from windows w join ${table("document_chek_kkm")} c on c.date >= w.date_from and c.date < w.date_to
      where c.deletion_mark is not true and c.posted = true and coalesce(c.summa_dokumenta, 0) <> 0
    ), store_names as (
      select ref_key, max(nullif(description, '')) as name from ${table("catalog_magaziny")} group by ref_key
    ), source_names as (
      select c.store_key as key, coalesce(n.name, c.store_key) as name
      from (select distinct store_key from selected_checks) c
      left join store_names n on n.ref_key = c.store_key
    ), addresses as (
      select *, substring(name from '[гГ][.].*$') as address,
        substring(${russianLower(Prisma.sql`name`)} from 'г[.].*$') as canonical_address
      from source_names
    ), locations as (
      select *, substring(canonical_address from '^г[.]\\s*([^[:space:],;]+)') as canonical_city from addresses
    ), source_stores as (
      select key, name,
        case when canonical_address ~ '^г[.]\\s*[^[:space:]]+\\s+.+$'
          then 'address:' || regexp_replace(trim(canonical_address), '\\s+', ' ', 'g')
          else 'key:' || key end as physical_key,
        coalesce(translate(left(canonical_city, 1),
          'абвгдеёжзийклмнопрстуфхцчшщъыьэюя', 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ')
          || substring(canonical_city from 2), 'Без города') as city,
        case when canonical_address ~ '^г[.]\\s*[^[:space:]]+\\s+.+$' then trim(address) else name end as display_name
      from locations
    ), activity as (
      select s.physical_key,
        count(distinct c.period) filter (where not c.is_return and c.document_amount > 0) = 2 as comparable
      from selected_checks c join source_stores s on s.key = c.store_key group by s.physical_key
    ), physical_stores as (
      select s.physical_key as key, min(s.display_name) as name, min(s.city) as city,
        array_agg(s.key order by s.key) as source_keys, bool_or(a.comparable) as comparable,
        case when ${params.cohort} = 'observed' then bool_or(a.comparable)
          else s.physical_key = any(${params.comparableStore}::text[]) end as selected
      from source_stores s join activity a on a.physical_key = s.physical_key group by s.physical_key
    ), raw_lines as materialized (
      -- Empty text is reserved for absent references, so every later item join is hashable.
      select c.period, c.ref_key, c.store_key, coalesce(t.nomenklatura_key, '') as item_key,
        not c.is_return and c.document_amount > 0 as positive_sale,
        case when c.is_return then -abs(coalesce(t.kolichestvo, 0)) else coalesce(t.kolichestvo, 0) end::numeric as quantity,
        case when c.is_return then -abs(coalesce(t.summa, 0)) else coalesce(t.summa, 0) end::numeric as revenue
      from selected_checks c join ${table("document_chek_kkm_tovary")} t on t."_parent_ref_key" = c.ref_key
    ), receipt_line_presence as (
      select period, ref_key, count(*) as line_count from raw_lines group by period, ref_key
    ), item_pair_facts as materialized (
      select period, store_key, item_key, sum(quantity) as quantity, sum(revenue) as revenue,
        sum(abs(quantity)) as absolute_quantity, count(*) as line_count,
        coalesce(sum(revenue) filter (where abs(quantity) > 0.000000001), 0) as material_revenue
      from raw_lines group by period, store_key, item_key
    ), items as materialized (
      select distinct item_key from item_pair_facts
    ), item_facts as (
      select item_key,
        coalesce(sum(quantity) filter (where period = 'current'), 0) as current_quantity,
        coalesce(sum(revenue) filter (where period = 'current'), 0) as current_revenue,
        coalesce(sum(quantity) filter (where period = 'previous'), 0) as previous_quantity,
        coalesce(sum(revenue) filter (where period = 'previous'), 0) as previous_revenue
      from item_pair_facts group by item_key
    ), catalog as materialized (
      select distinct on (ref_key) ref_key, parent_key, is_folder, description
      from ${table("catalog_nomenklatura")}
      order by ref_key, coalesce(is_folder, false) desc, coalesce(description, ''), coalesce(parent_key, '')
    ), ancestors as (
      select i.item_key, n.ref_key, n.parent_key, n.is_folder, n.description, 0 as depth,
        array[n.ref_key]::text[] as path, false as cycle
      from items i left join catalog n on n.ref_key = i.item_key and i.item_key <> ''
      union all
      select a.item_key, n.ref_key, n.parent_key, n.is_folder, n.description, a.depth + 1,
        a.path || n.ref_key, n.ref_key = any(a.path)
      from ancestors a join catalog n on n.ref_key = a.parent_key
      where a.depth < 64 and not a.cycle and a.parent_key not in ('', '00000000-0000-0000-0000-000000000000')
    ), terminal_ancestors as (
      select distinct on (item_key) item_key, path,
        case when ref_key is null then 'Нет ссылки в каталоге'
          when cycle then 'Цикл иерархии'
          when depth = 64 and nullif(parent_key, '') is not null
            and parent_key <> '00000000-0000-0000-0000-000000000000' then 'Глубина более 64'
          when nullif(parent_key, '') is not null and parent_key <> '00000000-0000-0000-0000-000000000000'
            then 'Отсутствующий родитель' end as issue
      from ancestors order by item_key, depth desc
    ), root_ancestors as (
      select distinct on (item_key) item_key, ref_key, description from ancestors
      where is_folder = true and (parent_key is null or parent_key in ('', '00000000-0000-0000-0000-000000000000'))
      order by item_key, depth desc
    ), member_ancestors as (
      select distinct on (item_key) item_key, description from ancestors
      where is_folder = true
        and ${russianLower(Prisma.sql`trim(description)`)} in ('пивной напиток', 'пиво бут', 'пиво жб', 'пиво розлив', 'разливные напитки', 'мульти пак', 'энергетический напиток')
      order by item_key, depth asc
    ), item_taxonomy as (
      select i.item_key, coalesce(n.description, nullif(i.item_key, ''), 'Без номенклатуры') as name,
        case when terminal.issue is null then coalesce(root.ref_key, 'unmapped') else 'unmapped' end as root_key,
        case when terminal.issue is null then coalesce(root.description, 'Без корневой папки') else 'Несопоставлено' end as root_name,
        case when terminal.issue is not null then null
          when member.description is not null then case ${russianLower(Prisma.sql`trim(member.description)`)}
            when 'пивной напиток' then 'Пивной напиток' when 'пиво бут' then 'Пиво бут'
            when 'пиво жб' then 'Пиво жб' when 'пиво розлив' then 'Пиво розлив'
            when 'разливные напитки' then 'Разливные напитки' when 'мульти пак' then 'Мульти пак'
            when 'энергетический напиток' then 'Энергетический напиток' end
          when ${russianLower(Prisma.sql`trim(root.description)`)} = 'энергетические напитки' then 'Энергетический напиток'
          else null end as member,
        coalesce(terminal.issue, case when root.ref_key is null then 'Нет корневой папки' end) as issue,
        coalesce(terminal.path, array[]::text[]) as path
      from items i
      left join catalog n on n.ref_key = i.item_key and i.item_key <> ''
      left join terminal_ancestors terminal on terminal.item_key = i.item_key
      left join root_ancestors root on root.item_key = i.item_key
      left join member_ancestors member on member.item_key = i.item_key
    ) ${presentationTaxonomyCtes}, item_groups as materialized (
      select t.item_key, g.kind, g.key from ${taxonomySource} t
      cross join lateral (
        select 'root'::text as kind, t.root_key as key
        union all select 'comparison', t.member where t.member = any(${[...comparisonMembers]}::text[])
        union all select 'comparison', 'combined' where t.member = any(${[...comparisonMembers]}::text[])
        union all select 'within', coalesce(t.member, 'Прочие в группе')
          where t.member is not null or ${russianLower(Prisma.sql`trim(t.root_name)`)} in ('пиво', 'напитки', 'энергетические напитки')
        ${presentationUnions}
      ) g
    ), previous_costs as (${costsForWindow("previous", periods.previous.to)}),
    current_costs as (${costsForWindow("current", periods.current.to)}),
    costs as (select * from previous_costs union all select * from current_costs),
    valued_facts as materialized (
      select f.*, s.physical_key, p.city, p.selected,
        f.quantity * c.unit_cost as cost,
        case when c.unit_cost is null then f.absolute_quantity else 0 end as unvalued_quantity,
        case when c.unit_cost is null then f.material_revenue else 0 end as unvalued_revenue
      from item_pair_facts f join source_stores s on s.key = f.store_key
      join physical_stores p on p.key = s.physical_key
      left join costs c on c.period = f.period and c.store_key = f.store_key and c.item_key = f.item_key
    ), store_metrics as materialized (
      select f.period, f.physical_key, f.city, f.selected, g.kind, g.key,
        sum(f.quantity) as quantity, sum(f.revenue) as revenue,
        coalesce(sum(f.cost), 0) as valued_cost,
        sum(f.unvalued_quantity) as unvalued_quantity, sum(f.absolute_quantity) as absolute_quantity,
        sum(f.unvalued_revenue) as unvalued_revenue, sum(f.line_count) as line_count
      from valued_facts f join item_groups g on g.item_key = f.item_key
      group by f.period, f.physical_key, f.city, f.selected, g.kind, g.key
    ), source_receipt_counts as materialized (
      -- Deduplicate on narrow source keys before joining physical addresses.
      select l.period, l.store_key, g.kind, g.key, count(distinct l.ref_key) as receipt_count
      from raw_lines l join item_groups g on g.item_key = l.item_key
      where l.positive_sale
      group by l.period, l.store_key, g.kind, g.key
    ), store_receipt_counts as materialized (
      select r.period, s.physical_key, r.kind, r.key, sum(r.receipt_count)::bigint as receipt_count
      from source_receipt_counts r join source_stores s on s.key = r.store_key
      group by r.period, s.physical_key, r.kind, r.key
    ), totals as (
      -- A Ref_Key identifies one source receipt/store (enforced by the raw
      -- receipt unique index). Outlet counts are disjoint; category counts are
      -- not. Deduplicate categories above, then sum across outlets only.
      select m.period, s.scope, s.scope_key, m.kind, m.key,
        sum(m.quantity) as quantity, sum(m.revenue) as revenue, sum(m.valued_cost) as valued_cost,
        sum(m.unvalued_quantity) as unvalued_quantity, sum(m.absolute_quantity) as absolute_quantity,
        sum(m.unvalued_revenue) as unvalued_revenue, sum(m.line_count)::bigint as line_count,
        sum(coalesce(r.receipt_count, 0))::bigint as receipt_count
      from store_metrics m left join store_receipt_counts r
        on r.period = m.period and r.physical_key = m.physical_key and r.kind = m.kind and r.key = m.key
      cross join lateral (
        select 'store'::text as scope, m.physical_key as scope_key
        union all select 'city', m.city union all select 'all', 'all'
        union all select 'cohort', 'cohort' where m.selected
      ) s group by m.period, s.scope, s.scope_key, m.kind, m.key
    ), observed_days as (
      select period, date::date as day, count(ref_key) as receipt_count, min(date) as date_from, max(date) as date_to
      from selected_checks group by period, date::date
    ), calendar_days as (
      select w.period, d.day::date as day from windows w
      cross join lateral generate_series(w.date_from, w.date_to - interval '1 day', interval '1 day') d(day)
    ), coverage as (
      select w.period, (w.date_to::date - w.date_from::date) as expected_days,
        count(o.day) as covered_days, coalesce(sum(o.receipt_count), 0) as receipt_count,
        to_char(min(o.date_from), 'YYYY-MM-DD') as date_from, to_char(max(o.date_to), 'YYYY-MM-DD') as date_to,
        coalesce(jsonb_agg(to_char(d.day, 'YYYY-MM-DD') order by d.day)
          filter (where d.day is not null and o.day is null), '[]'::jsonb) as missing_days
      from windows w left join calendar_days d on d.period = w.period
      left join observed_days o on o.period = d.period and o.day = d.day
      group by w.period, w.date_from, w.date_to
    ), header_quality as (
      select w.period,
        sum(case when c.is_return then -abs(c.document_amount) else c.document_amount end) as header_revenue,
        count(c.ref_key) as header_count,
        count(c.ref_key) filter (where not c.is_return and c.document_amount > 0) as positive_sale_receipt_count,
        count(c.ref_key) filter (where c.is_return) as return_receipt_count,
        count(c.ref_key) filter (where l.line_count is null) as receipts_without_lines
      from windows w left join selected_checks c on c.period = w.period
      left join receipt_line_presence l on l.period = c.period and l.ref_key = c.ref_key
      group by w.period
    ), line_quality as (
      select period, sum(revenue) as revenue, sum(line_count)::bigint as line_count,
        sum(absolute_quantity) as absolute_quantity, sum(unvalued_quantity) as unvalued_quantity,
        sum(unvalued_revenue) as unvalued_revenue, coalesce(sum(cost), 0) as valued_cost
      from valued_facts group by period
    ), global_coverage as (
      select to_char(min(date), 'YYYY-MM-DD') as date_from, to_char(max(date), 'YYYY-MM-DD') as date_to,
        count(distinct date::date) as covered_days from ${table("document_chek_kkm")}
      where posted = true and deletion_mark is not true and coalesce(summa_dokumenta, 0) <> 0
    )
    select jsonb_build_object(
      'generatedAt', to_char(current_timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'stores', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'city', city,
        'sourceStoreKeys', source_keys, 'comparableByActivity', comparable) order by city, name, key) from physical_stores), '[]'::jsonb),
      'coverage', (select jsonb_agg(jsonb_build_object('period', period, 'coveredDays', covered_days,
        'expectedDays', expected_days, 'receiptCount', receipt_count, 'dateFrom', date_from, 'dateTo', date_to,
        'missingDays', missing_days, 'status', case when covered_days = 0 then 'empty' when covered_days = expected_days then 'observed' else 'partial' end) order by period) from coverage),
      'aggregates', coalesce((select jsonb_agg(jsonb_build_object('period', period, 'scope', scope, 'scopeKey', scope_key,
        'groupKind', kind, 'groupKey', key, 'quantity', quantity, 'revenue', revenue,
        'estimatedCost', case when unvalued_quantity <= 0.000000001 then valued_cost end,
        'estimatedGrossIncome', case when unvalued_quantity <= 0.000000001 then revenue - valued_cost end,
        'valuedCost', valued_cost, 'valuedRevenue', revenue - unvalued_revenue, 'unvaluedRevenue', unvalued_revenue,
        'absoluteQuantity', absolute_quantity, 'unvaluedQuantity', unvalued_quantity,
        'lineCount', line_count, 'receiptCount', receipt_count,
        'avgQuantityPerReceipt', quantity / nullif(receipt_count, 0), 'avgAmountPerReceipt', revenue / nullif(receipt_count, 0))
        order by kind, key, scope, scope_key, period) from totals), '[]'::jsonb),
      'dataQuality', jsonb_build_object(
        'global', (select jsonb_build_object('dateFrom', date_from, 'dateTo', date_to, 'coveredDays', covered_days) from global_coverage),
        'periods', (select jsonb_agg(jsonb_build_object('period', h.period, 'headerRevenue', h.header_revenue,
          'lineRevenue', l.revenue, 'difference', l.revenue - h.header_revenue, 'headerCount', h.header_count,
          'positiveSaleReceiptCount', h.positive_sale_receipt_count, 'returnReceiptCount', h.return_receipt_count,
          'receiptsWithoutLines', h.receipts_without_lines, 'lineCount', coalesce(l.line_count, 0),
          'absoluteQuantity', coalesce(l.absolute_quantity, 0), 'unvaluedQuantity', coalesce(l.unvalued_quantity, 0),
          'valuedCost', l.valued_cost, 'unvaluedRevenue', l.unvalued_revenue,
          'estimatedGrossIncome', case when l.unvalued_quantity <= 0.000000001 then l.revenue - l.valued_cost end)
          order by h.period) from header_quality h left join line_quality l on l.period = h.period),
        'sourceStores', coalesce((select jsonb_agg(jsonb_build_object('key', key, 'name', name, 'physicalKey', physical_key, 'city', city) order by key) from source_stores), '[]'::jsonb),
        'valuation', coalesce((select jsonb_agg(jsonb_build_object(
          'period', c.period, 'sourceStoreKey', c.store_key, 'itemKey', c.item_key,
          'unitCost', c.unit_cost, 'source', c.source, 'quantity', f.quantity,
          'revenue', f.revenue, 'absoluteQuantity', f.absolute_quantity,
          'valuedCost', f.quantity * c.unit_cost) ${presentationValuation} order by c.period, c.store_key, c.item_key)
          from costs c join item_pair_facts f on f.period = c.period and f.store_key = c.store_key
            and f.item_key = c.item_key), '[]'::jsonb),
        'taxonomy', coalesce((select jsonb_agg(jsonb_build_object(
          'itemKey', t.item_key, 'name', t.name, 'rootKey', t.root_key,
          'rootName', t.root_name, 'member', t.member, 'issue', t.issue, 'path', t.path,
          'currentQuantity', f.current_quantity, 'currentRevenue', f.current_revenue,
          'previousQuantity', f.previous_quantity, 'previousRevenue', f.previous_revenue) ${presentationAudit} order by t.item_key)
          from ${taxonomySource} t join item_facts f on f.item_key = t.item_key), '[]'::jsonb)
      )
    ) as payload
  `;
  const [result] = options.client ? await options.client.$queryRaw<Array<{ payload: YearComparisonPayload }>>(payloadQuery)
    : await prisma.$transaction(async (tx) => {
    // This report's many CTEs cause inflated estimates and seconds of LLVM
    // compilation; measured execution is faster without per-query JIT.
    await tx.$executeRaw`set local jit = off`;
    return tx.$queryRaw<Array<{ payload: YearComparisonPayload }>>(payloadQuery);
  }, { maxWait: 30_000, timeout: 180_000 });
  const report = result.payload;
  const knownKeys = new Set(report.stores.map((store) => store.key));
  if (params.cohort === "custom") {
    const unknown = params.comparableStore.filter((key) => !knownKeys.has(key));
    if (unknown.length) {
      throw Object.assign(new Error(`Неизвестные физические магазины: ${unknown.join(", ")}`), { statusCode: 400 });
    }
  }
  return {
    ...report, periods,
    cohort: {
      mode: params.cohort,
      selectedStoreKeys: params.cohort === "custom" ? params.comparableStore : report.stores.filter((store) => store.comparableByActivity).map((store) => store.key)
    },
    methodology: presentationGroups ? [
      ...comparisonMethodology,
      "Презентационные группы используют текущий каталог, не историческую классификацию продаж. Общий итог включает все товары, услуги и несопоставленные строки. Подкатегория — первая дочерняя папка под корнем, при ее отсутствии сам корень; имя — корень / подкатегория, если они различаются.",
      "Розлив — ближайшая распознанная папка Пиво розлив/Разливные напитки либо явное розлив/разлив в имени внутри корней Пиво, Напитки, Алкоголь, Энергетические напитки, Бар. Фасованные — ближайшая распознанная папка Пиво бут/Пиво жб/Пивной напиток/Мульти пак либо корни Алкоголь, Напитки, Энергетические напитки, если это не розлив; фасованный тип по имени товара не угадывается. Пиво без распознанной папки типа остается неклассифицированным; Бар без розлива и остальные корни — прочее. Причина и подкатегория каждой позиции доступны в аудите."
    ] : [...comparisonMethodology]
  };
}
