import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { prisma } from "../prisma.js";

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sourceTable(tableName: string) {
  return Prisma.raw(`${quoteIdent(config.PGSCHEMA)}.${quoteIdent(tableName)}`);
}

export function applicationTable(tableName: string) {
  return Prisma.raw(`${quoteIdent(config.APP_SCHEMA)}.${quoteIdent(tableName)}`);
}

function applicationTableName(tableName: string) {
  return `${quoteIdent(config.APP_SCHEMA)}.${quoteIdent(tableName)}`;
}

const defaultMetrics = [
  { metricId: "money.free", normal: "≥ 0", critical: "< −недельные расходы", cadence: "Ежедневно", owner: "Собственник, финансист" },
  { metricId: "cash.categorized", normal: "≥ 98%", critical: "< 95%", cadence: "Ежедневно", owner: "Финансист" },
  { metricId: "loss.rate", normal: "≤ 1%", critical: "> 2,5%", cadence: "Еженедельно", owner: "Управляющий" },
  { metricId: "stock.days", normal: "≤ 30 дней", critical: "> 45 дней", cadence: "Еженедельно", owner: "Закупки" },
  { metricId: "stock.frozen", normal: "≤ 10%", critical: "> 20%", cadence: "Еженедельно", owner: "Закупки" },
  { metricId: "store.margin-after-loss", normal: "≥ медиана − 2 п. п.", critical: "< медиана − 5 п. п.", cadence: "Еженедельно", owner: "Операционный директор" }
];

let tablesReady: Promise<void> | null = null;

export function ensureManagementSettingsTables() {
  tablesReady ??= (async () => {
    await prisma.$executeRawUnsafe(`
      create table if not exists ${applicationTableName("naliv_store_settings")} (
        store_key text primary key,
        active boolean not null,
        display_name text,
        updated_at timestamptz not null default now()
      )
    `);
    await prisma.$executeRawUnsafe(`
      create table if not exists ${applicationTableName("naliv_metric_settings")} (
        metric_id text primary key,
        normal_text text not null,
        critical_text text not null,
        cadence text not null,
        owner_name text not null,
        updated_at timestamptz not null default now()
      )
    `);
    await prisma.$executeRawUnsafe(`
      create table if not exists ${applicationTableName("naliv_cash_article_settings")} (
        article_key text primary key,
        flow_type text check (flow_type in ('operating', 'investing', 'financing', 'internal')),
        approved boolean not null default false,
        updated_at timestamptz not null default now()
      )
    `);
    await prisma.$executeRawUnsafe(`
      do $$
      declare
        flow_check text;
      begin
        select pg_get_constraintdef(oid)
        into flow_check
        from pg_constraint
        where conrelid = '${applicationTableName("naliv_cash_article_settings")}'::regclass
          and conname = 'naliv_cash_article_settings_flow_type_check';

        if flow_check is null or position('internal' in flow_check) = 0 then
          alter table ${applicationTableName("naliv_cash_article_settings")}
            drop constraint if exists naliv_cash_article_settings_flow_type_check;
          alter table ${applicationTableName("naliv_cash_article_settings")}
            add constraint naliv_cash_article_settings_flow_type_check
            check (flow_type in ('operating', 'investing', 'financing', 'internal'));
        end if;
      end
      $$
    `);
    await prisma.$executeRawUnsafe(`
      create table if not exists ${applicationTableName("naliv_obligations")} (
        id bigserial primary key,
        kind text not null check (kind in ('permanent', 'payroll', 'loan')),
        name text not null,
        amount numeric not null,
        due_date date,
        frequency text not null default 'once',
        active boolean not null default true,
        updated_at timestamptz not null default now()
      )
    `);
    await prisma.$executeRawUnsafe(`
      create table if not exists ${applicationTableName("naliv_projects")} (
        id bigserial primary key,
        name text not null,
        budget numeric not null default 0,
        actual numeric not null default 0,
        start_date date,
        status text not null check (status in ('planned', 'active', 'completed', 'cancelled')),
        updated_at timestamptz not null default now()
      )
    `);
  })().catch((error) => {
    tablesReady = null;
    throw error;
  });
  return tablesReady;
}

function suggestFlow(name: string): "operating" | "investing" | "financing" | "internal" | null {
  const normalized = name.toLocaleLowerCase("ru-RU");
  if (/(инкас|пополнен.*счет|пополнен.*мелоч|расход мелоч|сдач.*в банк|из кассы в кассу)/u.test(normalized)) return "internal";
  if (/(кредит|за[её]м|дивиденд|взнос.*собствен|финансирован)/u.test(normalized)) return "financing";
  if (/(оборудован|ремонт|строител|открыти|инвест|основн.*средств)/u.test(normalized)) return "investing";
  if (/(товар|поставщик|аренд|зарплат|налог|коммун|выруч|услуг|хоз|реклам)/u.test(normalized)) return "operating";
  return null;
}

export async function getManagementSettings(asOf = new Date()) {
  await ensureManagementSettingsTables();
  const stores = sourceTable("catalog_magaziny");
  const reports = sourceTable("document_otchet_o_roznichnyh_prodazhah");
  const articles = sourceTable("catalog_stati_dvizheniya_denezhnyh_sredstv");
  const incomingDocuments = sourceTable("document_prihodnyy_kassovyy_order");
  const incomingLines = sourceTable("document_prihodnyy_kassovyy_order_rasshifrovka_platezha");
  const outgoingDocuments = sourceTable("document_rashodnyy_kassovyy_order");
  const outgoingLines = sourceTable("document_rashodnyy_kassovyy_order_rasshifrovka_platezha");

  const [storeRows, metricRows, articleRows, obligationRows, projectRows, recurringRows] = await Promise.all([
    prisma.$queryRaw<Array<{
      store_key: string;
      source_name: string | null;
      display_name: string | null;
      configured_active: boolean | null;
      last_sale_at: Date | null;
    }>>`
      with source_stores as (
        select ref_key as store_key, max(description) as source_name
        from ${stores}
        where deletion_mark is not true
        group by ref_key
      ), recent_sales as (
        select nullif(magazin_key, '') as store_key, max(date) as last_sale_at
        from ${reports}
        where deletion_mark is not true and posted = true and date < ${asOf}
        group by nullif(magazin_key, '')
      )
      select s.store_key, s.source_name, c.display_name, c.active as configured_active, r.last_sale_at
      from source_stores s
      left join ${applicationTable("naliv_store_settings")} c on c.store_key = s.store_key
      left join recent_sales r on r.store_key = s.store_key
      order by coalesce(c.active, r.last_sale_at >= (${asOf} - interval '90 days')) desc,
        coalesce(c.display_name, s.source_name), s.store_key
    `,
    prisma.$queryRaw<Array<{
      metric_id: string;
      normal_text: string;
      critical_text: string;
      cadence: string;
      owner_name: string;
    }>>`
      select metric_id, normal_text, critical_text, cadence, owner_name
      from ${applicationTable("naliv_metric_settings")}
    `,
    prisma.$queryRaw<Array<{
      article_key: string;
      article_name: string | null;
      flow_type: "operating" | "investing" | "financing" | "internal" | null;
      approved: boolean | null;
      line_count: bigint | number;
    }>>`
      with source_articles as (
        select ref_key as article_key, max(description) as article_name
        from ${articles}
        group by ref_key
      ), used_articles as (
        select article_key, count(*) as line_count
        from (
          select l.statya_dvizheniya_denezhnyh_sredstv_key as article_key
          from ${incomingDocuments} d
          join ${incomingLines} l on l."_parent_ref_key" = d.ref_key
          where d.deletion_mark is not true and d.posted = true
          union all
          select l.statya_dvizheniya_denezhnyh_sredstv_key as article_key
          from ${outgoingDocuments} d
          join ${outgoingLines} l on l."_parent_ref_key" = d.ref_key
          where d.deletion_mark is not true and d.posted = true
        ) movements
        where article_key is not null and article_key <> ''
        group by article_key
      )
      select a.article_key, a.article_name, c.flow_type, c.approved,
        coalesce(u.line_count, 0) as line_count
      from source_articles a
      left join ${applicationTable("naliv_cash_article_settings")} c on c.article_key = a.article_key
      left join used_articles u on u.article_key = a.article_key
      where coalesce(u.line_count, 0) > 0
      order by coalesce(u.line_count, 0) desc, a.article_name
    `,
    prisma.$queryRaw<Array<{
      id: bigint | number;
      kind: "permanent" | "payroll" | "loan";
      name: string;
      amount: number;
      due_date: Date | null;
      frequency: string;
      active: boolean;
    }>>`
      select id, kind, name, amount::float8 as amount, due_date, frequency, active
      from ${applicationTable("naliv_obligations")}
      order by active desc, due_date nulls last, id
    `,
    prisma.$queryRaw<Array<{
      id: bigint | number;
      name: string;
      budget: number;
      actual: number;
      start_date: Date | null;
      status: "planned" | "active" | "completed" | "cancelled";
    }>>`
      select id, name, budget::float8 as budget, actual::float8 as actual, start_date, status
      from ${applicationTable("naliv_projects")}
      order by case status when 'active' then 0 when 'planned' then 1 else 2 end, id
    `,
    prisma.$queryRaw<Array<{
      article_key: string;
      article_name: string | null;
      active_months: bigint | number;
      average_monthly_amount: number;
      last_month: Date;
    }>>`
      with monthly as (
        select
          l.statya_dvizheniya_denezhnyh_sredstv_key as article_key,
          date_trunc('month', d.date) as expense_month,
          sum(coalesce(l.summa, 0))::float8 as amount
        from ${outgoingDocuments} d
        join ${outgoingLines} l on l."_parent_ref_key" = d.ref_key
        where d.deletion_mark is not true and d.posted = true
          and d.date >= (${asOf} - interval '6 months') and d.date < ${asOf}
          and nullif(l.statya_dvizheniya_denezhnyh_sredstv_key, '') is not null
        group by 1, 2
      ), article_names as (
        select ref_key, max(description) as description
        from ${articles}
        group by ref_key
      )
      select m.article_key, n.description as article_name,
        count(*) as active_months,
        avg(m.amount)::float8 as average_monthly_amount,
        max(m.expense_month) as last_month
      from monthly m
      left join article_names n on n.ref_key = m.article_key
      group by m.article_key, n.description
      having count(*) >= 2
      order by avg(m.amount) desc
    `
  ]);

  const overrides = new Map(metricRows.map((row) => [row.metric_id, row]));
  return {
    stores: storeRows.map((row) => {
      const inferredActive = Boolean(
        row.last_sale_at && row.last_sale_at >= new Date(asOf.getTime() - 90 * 86_400_000)
      );
      return {
        storeKey: row.store_key,
        sourceName: row.source_name ?? row.store_key,
        displayName: row.display_name,
        active: row.configured_active ?? inferredActive,
        configured: row.configured_active !== null,
        lastSaleAt: row.last_sale_at?.toISOString() ?? null
      };
    }),
    metrics: defaultMetrics.map((item) => {
      const override = overrides.get(item.metricId);
      return override
        ? {
            metricId: item.metricId,
            normal: override.normal_text,
            critical: override.critical_text,
            cadence: override.cadence,
            owner: override.owner_name,
            configured: true
          }
        : { ...item, configured: false };
    }),
    cashArticles: articleRows.map((row) => ({
      articleKey: row.article_key,
      articleName: row.article_name ?? row.article_key,
      lineCount: Number(row.line_count),
      flowType: row.flow_type,
      approved: Boolean(row.approved),
      suggestedFlow: suggestFlow(row.article_name ?? "")
    })),
    obligations: obligationRows.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      name: row.name,
      amount: Number(row.amount),
      dueDate: row.due_date?.toISOString().slice(0, 10) ?? null,
      frequency: row.frequency,
      active: row.active
    })),
    projects: projectRows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      budget: Number(row.budget),
      actual: Number(row.actual),
      startDate: row.start_date?.toISOString().slice(0, 10) ?? null,
      status: row.status
    })),
    recurringExpenseSuggestions: recurringRows.map((row) => ({
      articleKey: row.article_key,
      articleName: row.article_name ?? row.article_key,
      activeMonths: Number(row.active_months),
      averageMonthlyAmount: Number(row.average_monthly_amount),
      lastMonth: row.last_month.toISOString()
    }))
  };
}

export async function updateStoreSetting(input: {
  storeKey: string;
  active: boolean;
  displayName?: string | null;
}) {
  await ensureManagementSettingsTables();
  await prisma.$executeRaw`
    insert into ${applicationTable("naliv_store_settings")} (store_key, active, display_name, updated_at)
    values (${input.storeKey}, ${input.active}, ${input.displayName?.trim() || null}, now())
    on conflict (store_key) do update set
      active = excluded.active,
      display_name = excluded.display_name,
      updated_at = now()
  `;
  return { saved: true };
}

export async function updateMetricSetting(input: {
  metricId: string;
  normal: string;
  critical: string;
  cadence: string;
  owner: string;
}) {
  if (!defaultMetrics.some((item) => item.metricId === input.metricId)) {
    throw new Error(`Unsupported metric: ${input.metricId}`);
  }
  await ensureManagementSettingsTables();
  await prisma.$executeRaw`
    insert into ${applicationTable("naliv_metric_settings")}
      (metric_id, normal_text, critical_text, cadence, owner_name, updated_at)
    values (${input.metricId}, ${input.normal}, ${input.critical}, ${input.cadence}, ${input.owner}, now())
    on conflict (metric_id) do update set
      normal_text = excluded.normal_text,
      critical_text = excluded.critical_text,
      cadence = excluded.cadence,
      owner_name = excluded.owner_name,
      updated_at = now()
  `;
  return { saved: true };
}

export async function updateCashArticleSetting(input: {
  articleKey: string;
  flowType: "operating" | "investing" | "financing" | "internal" | null;
  approved: boolean;
}) {
  await ensureManagementSettingsTables();
  await prisma.$executeRaw`
    insert into ${applicationTable("naliv_cash_article_settings")} (article_key, flow_type, approved, updated_at)
    values (${input.articleKey}, ${input.flowType}, ${input.approved}, now())
    on conflict (article_key) do update set
      flow_type = excluded.flow_type,
      approved = excluded.approved,
      updated_at = now()
  `;
  return { saved: true };
}

export async function updateObligation(input: {
  id?: number;
  kind: "permanent" | "payroll" | "loan";
  name: string;
  amount: number;
  dueDate?: string | null;
  frequency: string;
  active: boolean;
}) {
  await ensureManagementSettingsTables();
  if (input.id) {
    await prisma.$executeRaw`
      update ${applicationTable("naliv_obligations")} set
        kind = ${input.kind},
        name = ${input.name},
        amount = ${input.amount},
        due_date = ${input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null},
        frequency = ${input.frequency},
        active = ${input.active},
        updated_at = now()
      where id = ${input.id}
    `;
    return { saved: true, id: input.id };
  }
  const rows = await prisma.$queryRaw<Array<{ id: bigint | number }>>`
    insert into ${applicationTable("naliv_obligations")}
      (kind, name, amount, due_date, frequency, active, updated_at)
    values (
      ${input.kind},
      ${input.name},
      ${input.amount},
      ${input.dueDate ? new Date(`${input.dueDate}T00:00:00.000Z`) : null},
      ${input.frequency},
      ${input.active},
      now()
    )
    returning id
  `;
  return { saved: true, id: Number(rows[0]?.id) };
}

export async function updateProject(input: {
  id?: number;
  name: string;
  budget: number;
  actual: number;
  startDate?: string | null;
  status: "planned" | "active" | "completed" | "cancelled";
}) {
  await ensureManagementSettingsTables();
  if (input.id) {
    await prisma.$executeRaw`
      update ${applicationTable("naliv_projects")} set
        name = ${input.name},
        budget = ${input.budget},
        actual = ${input.actual},
        start_date = ${input.startDate ? new Date(`${input.startDate}T00:00:00.000Z`) : null},
        status = ${input.status},
        updated_at = now()
      where id = ${input.id}
    `;
    return { saved: true, id: input.id };
  }
  const rows = await prisma.$queryRaw<Array<{ id: bigint | number }>>`
    insert into ${applicationTable("naliv_projects")}
      (name, budget, actual, start_date, status, updated_at)
    values (
      ${input.name},
      ${input.budget},
      ${input.actual},
      ${input.startDate ? new Date(`${input.startDate}T00:00:00.000Z`) : null},
      ${input.status},
      now()
    )
    returning id
  `;
  return { saved: true, id: Number(rows[0]?.id) };
}
