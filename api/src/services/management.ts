import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { canonicalItemCostsCtes } from "../lib/cost-sql.js";
import { prisma } from "../prisma.js";

export type ManagementMetricParams = {
  from?: Date;
  to?: Date;
  limit: number;
};

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(tableName: string) {
  return Prisma.raw(`${quoteIdent(config.PGSCHEMA)}.${quoteIdent(tableName)}`);
}

function dateFilters(alias: string, params: ManagementMetricParams) {
  const ref = Prisma.raw(alias);
  const filters: Prisma.Sql[] = [
    Prisma.sql`${ref}.date is not null`,
    Prisma.sql`${ref}.deletion_mark is not true`,
    Prisma.sql`${ref}.posted = true`
  ];
  if (params.from) {
    filters.push(Prisma.sql`${ref}.date >= ${params.from}`);
  }
  if (params.to) {
    filters.push(Prisma.sql`${ref}.date < ${params.to}`);
  }
  return Prisma.join(filters, " and ");
}

function storeName(description: string | null, key: string) {
  if (description?.trim()) {
    return description;
  }
  return key === "Без магазина" ? key : `Магазин ${key}`;
}

export async function getLossMetrics(params: ManagementMetricParams) {
  const writeoffDocuments = qualifiedTable("document_spisanie_tovarov");
  const writeoffLines = qualifiedTable("document_spisanie_tovarov_tovary");
  const surplusDocuments = qualifiedTable("document_oprihodovanie_tovarov");
  const surplusLines = qualifiedTable("document_oprihodovanie_tovarov_tovary");
  const salesDocuments = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const stores = qualifiedTable("catalog_magaziny");

  const rows = await prisma.$queryRaw<
    Array<{
      store_key: string;
      store_name: string | null;
      writeoffs: number | null;
      surpluses: number | null;
      net_losses: number | null;
      net_revenue: number | null;
      loss_pct: number | null;
    }>
  >`
    with writeoffs as (
      select
        coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
        sum(coalesce(l.summa, 0))::float8 as amount
      from ${writeoffDocuments} d
      join ${writeoffLines} l on l."_parent_ref_key" = d.ref_key
      where ${dateFilters("d", params)}
      group by 1
    ),
    surpluses as (
      select
        coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
        sum(coalesce(l.summa, 0))::float8 as amount
      from ${surplusDocuments} d
      join ${surplusLines} l on l."_parent_ref_key" = d.ref_key
      where ${dateFilters("d", params)}
      group by 1
    ),
    revenue as (
      select
        coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
        sum(coalesce(d.summa_dokumenta, 0) - coalesce(d.summa_vozvratov, 0))::float8 as amount
      from ${salesDocuments} d
      where ${dateFilters("d", params)}
      group by 1
    ),
    store_keys as (
      select store_key from writeoffs
      union select store_key from surpluses
      union select store_key from revenue
    ),
    store_names as (
      select ref_key, max(description) as description
      from ${stores}
      group by ref_key
    )
    select
      k.store_key,
      n.description as store_name,
      coalesce(w.amount, 0)::float8 as writeoffs,
      coalesce(s.amount, 0)::float8 as surpluses,
      (coalesce(w.amount, 0) - coalesce(s.amount, 0))::float8 as net_losses,
      coalesce(r.amount, 0)::float8 as net_revenue,
      case when r.amount <> 0 then
        ((coalesce(w.amount, 0) - coalesce(s.amount, 0)) / r.amount * 100)::float8
      else null end as loss_pct
    from store_keys k
    left join writeoffs w using (store_key)
    left join surpluses s using (store_key)
    left join revenue r using (store_key)
    left join store_names n on n.ref_key = k.store_key
    order by abs(coalesce(w.amount, 0) - coalesce(s.amount, 0)) desc
  `;

  const storesResult = rows.map((row) => ({
    storeKey: row.store_key,
    storeName: storeName(row.store_name, row.store_key),
    writeoffs: Number(row.writeoffs ?? 0),
    surpluses: Number(row.surpluses ?? 0),
    netLosses: Number(row.net_losses ?? 0),
    netRevenue: Number(row.net_revenue ?? 0),
    lossPct: row.loss_pct === null ? null : Number(row.loss_pct)
  }));
  const summary = storesResult.reduce(
    (acc, row) => {
      acc.writeoffs += row.writeoffs;
      acc.surpluses += row.surpluses;
      acc.netLosses += row.netLosses;
      acc.netRevenue += row.netRevenue;
      return acc;
    },
    { writeoffs: 0, surpluses: 0, netLosses: 0, netRevenue: 0 }
  );

  return {
    summary: {
      ...summary,
      lossPct: summary.netRevenue !== 0 ? (summary.netLosses / summary.netRevenue) * 100 : 0
    },
    stores: storesResult.slice(0, params.limit),
    definition: "Списания − оприходование излишков; выручка — после явных возвратов."
  };
}

export async function getAcquiringMetrics(params: ManagementMetricParams) {
  const salesDocuments = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const cardPayments = qualifiedTable(
    "document_otchet_o_roznichnyh_prodazhah_oplata_platezhn_5ea33aad"
  );
  const stores = qualifiedTable("catalog_magaziny");

  const rows = await prisma.$queryRaw<
    Array<{
      store_key: string;
      store_name: string | null;
      turnover: number | null;
      commission: number | null;
      payment_lines: bigint | number;
    }>
  >`
    with store_names as (
      select ref_key, max(description) as description
      from ${stores}
      group by ref_key
    )
    select
      coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
      n.description as store_name,
      sum(coalesce(p.summa, 0))::float8 as turnover,
      sum(coalesce(
        nullif(p.summa_komissii, 0),
        coalesce(p.summa, 0) * coalesce(p.protsent_komissii, 0) / 100,
        0
      ))::float8 as commission,
      count(*) as payment_lines
    from ${salesDocuments} d
    join ${cardPayments} p on p."_parent_ref_key" = d.ref_key
    left join store_names n on n.ref_key = d.magazin_key
    where ${dateFilters("d", params)}
    group by 1, 2
    order by turnover desc
  `;

  const storesResult = rows.map((row) => ({
    storeKey: row.store_key,
    storeName: storeName(row.store_name, row.store_key),
    turnover: Number(row.turnover ?? 0),
    commission: Number(row.commission ?? 0),
    commissionPct:
      Number(row.turnover ?? 0) > 0
        ? (Number(row.commission ?? 0) / Number(row.turnover ?? 0)) * 100
        : 0,
    paymentLines: Number(row.payment_lines ?? 0)
  }));
  const summary = storesResult.reduce(
    (acc, row) => {
      acc.turnover += row.turnover;
      acc.commission += row.commission;
      acc.paymentLines += row.paymentLines;
      return acc;
    },
    { turnover: 0, commission: 0, paymentLines: 0 }
  );

  return {
    summary: {
      ...summary,
      commissionPct: summary.turnover > 0 ? (summary.commission / summary.turnover) * 100 : 0,
      commissionAvailable: summary.commission > 0
    },
    stores: storesResult.slice(0, params.limit),
    limitation: summary.turnover > 0 && summary.commission === 0
      ? "Карточный оборот заполнен, но сумма и ставка комиссии во всех строках равны нулю; комиссия эквайринга в 1С не ведется. Банковские зачисления также не загружены."
      : "Показывает оборот и комиссию по 1С; банковские зачисления для расчета «в пути» не загружены."
  };
}

export async function getCashArticleMetrics(params: ManagementMetricParams) {
  const incomingDocuments = qualifiedTable("document_prihodnyy_kassovyy_order");
  const incomingLines = qualifiedTable(
    "document_prihodnyy_kassovyy_order_rasshifrovka_platezha"
  );
  const outgoingDocuments = qualifiedTable("document_rashodnyy_kassovyy_order");
  const outgoingLines = qualifiedTable(
    "document_rashodnyy_kassovyy_order_rasshifrovka_platezha"
  );
  const articles = qualifiedTable("catalog_stati_dvizheniya_denezhnyh_sredstv");

  const rows = await prisma.$queryRaw<
    Array<{
      article_key: string;
      article_name: string | null;
      inflow: number | null;
      outflow: number | null;
      line_count: bigint | number;
      store_tagged: bigint | number;
    }>
  >`
    with movements as (
      select
        l.statya_dvizheniya_denezhnyh_sredstv_key as article_key,
        coalesce(l.summa, 0)::float8 as inflow,
        0::float8 as outflow,
        false as has_store
      from ${incomingDocuments} d
      join ${incomingLines} l on l."_parent_ref_key" = d.ref_key
      where ${dateFilters("d", params)}
      union all
      select
        l.statya_dvizheniya_denezhnyh_sredstv_key as article_key,
        0::float8 as inflow,
        coalesce(l.summa, 0)::float8 as outflow,
        nullif(l.magazin_key, '') is not null as has_store
      from ${outgoingDocuments} d
      join ${outgoingLines} l on l."_parent_ref_key" = d.ref_key
      where ${dateFilters("d", params)}
    ),
    article_names as (
      select ref_key, max(description) as description
      from ${articles}
      group by ref_key
    )
    select
      coalesce(nullif(m.article_key, ''), 'Без статьи') as article_key,
      coalesce(n.description, 'Без статьи') as article_name,
      sum(m.inflow)::float8 as inflow,
      sum(m.outflow)::float8 as outflow,
      count(*) as line_count,
      count(*) filter (where m.has_store) as store_tagged
    from movements m
    left join article_names n on n.ref_key = m.article_key
    group by 1, 2
    order by sum(m.inflow) + sum(m.outflow) desc
  `;

  const articlesResult = rows.map((row) => ({
    articleKey: row.article_key,
    articleName: row.article_name ?? "Без статьи",
    inflow: Number(row.inflow ?? 0),
    outflow: Number(row.outflow ?? 0),
    net: Number(row.inflow ?? 0) - Number(row.outflow ?? 0),
    lineCount: Number(row.line_count ?? 0),
    storeTagged: Number(row.store_tagged ?? 0)
  }));
  const summary = articlesResult.reduce(
    (acc, row) => {
      acc.inflow += row.inflow;
      acc.outflow += row.outflow;
      acc.lineCount += row.lineCount;
      acc.storeTagged += row.storeTagged;
      if (row.articleKey !== "Без статьи") {
        acc.categorizedLines += row.lineCount;
      }
      return acc;
    },
    { inflow: 0, outflow: 0, lineCount: 0, storeTagged: 0, categorizedLines: 0 }
  );

  return {
    summary: {
      ...summary,
      net: summary.inflow - summary.outflow,
      categorizedPct: summary.lineCount > 0 ? (summary.categorizedLines / summary.lineCount) * 100 : 100,
      storeTaggedPct: summary.lineCount > 0 ? (summary.storeTagged / summary.lineCount) * 100 : 100
    },
    articles: articlesResult.slice(0, params.limit),
    limitation: "Только кассовые ордера 1С; банковские движения и внутригрупповые исключения отсутствуют."
  };
}

export async function getSupplierTermsMetrics(params: ManagementMetricParams) {
  const receipts = qualifiedTable("document_postuplenie_tovarov");
  const paymentStages = qualifiedTable("document_postuplenie_tovarov_etapy_oplat");
  const counterparties = qualifiedTable("catalog_kontragenty");

  const [summaryRows, scheduleRows] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        receipt_count: bigint | number;
        staged_receipt_count: bigint | number;
        weighted_deferral_days: number | null;
        staged_amount: number | null;
        paid_flag_count: bigint | number;
      }>
    >`
      with selected_receipts as (
        select d.ref_key, d.date, d.naliv_oplachen
        from ${receipts} d
        where ${dateFilters("d", params)}
      ),
      stage_totals as (
        select
          s."_parent_ref_key" as parent_ref_key,
          sum(coalesce(s.summa, 0))::float8 as amount,
          sum(
            coalesce(s.summa, 0)
            * greatest(coalesce(s.otsrochka_platezha, 0), 0)
          )::float8 as weighted_days
        from ${paymentStages} s
        join selected_receipts d on d.ref_key = s."_parent_ref_key"
        group by 1
      )
      select
        count(*) as receipt_count,
        count(st.parent_ref_key) as staged_receipt_count,
        case when sum(st.amount) > 0 then sum(st.weighted_days) / sum(st.amount) else 0 end::float8 as weighted_deferral_days,
        coalesce(sum(st.amount), 0)::float8 as staged_amount,
        count(*) filter (where d.naliv_oplachen is true) as paid_flag_count
      from selected_receipts d
      left join stage_totals st on st.parent_ref_key = d.ref_key
    `,
    prisma.$queryRaw<
      Array<{
        due_day: Date;
        counterparty_name: string | null;
        amount: number | null;
        document_count: bigint | number;
      }>
    >`
      with counterparty_names as (
        select ref_key, max(description) as description
        from ${counterparties}
        group by ref_key
      )
      select
        date_trunc('day', s.data_platezha) as due_day,
        coalesce(n.description, 'Без контрагента') as counterparty_name,
        sum(coalesce(s.summa, 0))::float8 as amount,
        count(distinct d.ref_key) as document_count
      from ${paymentStages} s
      join ${receipts} d on d.ref_key = s."_parent_ref_key"
      left join counterparty_names n on n.ref_key = d.kontragent_key
      where d.deletion_mark is not true
        and d.posted = true
        and s.data_platezha is not null
        ${params.from ? Prisma.sql`and s.data_platezha >= ${params.from}` : Prisma.empty}
        ${params.to ? Prisma.sql`and s.data_platezha < ${params.to}` : Prisma.empty}
      group by 1, 2
      order by due_day, amount desc
    `
  ]);

  const summaryRow = summaryRows[0];
  const receiptCount = Number(summaryRow?.receipt_count ?? 0);
  const stagedReceiptCount = Number(summaryRow?.staged_receipt_count ?? 0);
  return {
    summary: {
      receiptCount,
      stagedReceiptCount,
      stageCoveragePct: receiptCount > 0 ? (stagedReceiptCount / receiptCount) * 100 : 0,
      weightedDeferralDays: Number(summaryRow?.weighted_deferral_days ?? 0),
      stagedAmount: Number(summaryRow?.staged_amount ?? 0),
      paidFlagCount: Number(summaryRow?.paid_flag_count ?? 0)
    },
    schedule: scheduleRows.slice(0, params.limit).map((row) => ({
      dueDay: row.due_day.toISOString(),
      counterpartyName: row.counterparty_name ?? "Без контрагента",
      amount: Number(row.amount ?? 0),
      documentCount: Number(row.document_count ?? 0)
    })),
    limitation: "Этапы оплаты покрывают только часть поступлений; это плановые сроки, не подтвержденная кредиторская задолженность."
  };
}

export async function getStoreStockMetrics(params: ManagementMetricParams) {
  const balances = qualifiedTable("accumulation_register_tovary_na_skladah_balance");
  const warehouses = qualifiedTable("catalog_sklady");
  const stores = qualifiedTable("catalog_magaziny");

  const rows = await prisma.$queryRaw<
    Array<{
      store_key: string;
      store_name: string | null;
      snapshot_at: Date | null;
      warehouse_count: bigint | number;
      item_count: bigint | number;
      stock_qty: number | null;
      reserved_qty: number | null;
      available_qty: number | null;
      stock_cost: number | null;
      unvalued_qty: number | null;
      negative_stock_qty: number | null;
      valued_item_count: bigint | number;
    }>
  >`
    with
    ${canonicalItemCostsCtes(params.to)},
    latest_balances as (
      select distinct on (b.nomenklatura_key, b.sklad_key)
        b.nomenklatura_key,
        b.sklad_key,
        b.balance_period,
        coalesce(b.kolichestvo_balance, 0)::float8 as stock_qty,
        coalesce(b.rezerv_balance, 0)::float8 as reserved_qty
      from ${balances} b
      where b.balance_period is not null
      order by b.nomenklatura_key, b.sklad_key, b.balance_period desc
    ),
    store_names as (
      select ref_key, max(description) as description
      from ${stores}
      group by ref_key
    )
    select
      coalesce(nullif(w.magazin_key, ''), 'Без магазина') as store_key,
      n.description as store_name,
      max(b.balance_period) as snapshot_at,
      count(distinct b.sklad_key) as warehouse_count,
      count(distinct b.nomenklatura_key) as item_count,
      sum(greatest(b.stock_qty, 0))::float8 as stock_qty,
      sum(greatest(b.reserved_qty, 0))::float8 as reserved_qty,
      sum(greatest(b.stock_qty, 0) - greatest(b.reserved_qty, 0))::float8 as available_qty,
      sum(
        greatest(b.stock_qty, 0) * coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost, 0)
      )::float8 as stock_cost,
      sum(abs(b.stock_qty)) filter (
        where b.stock_qty > 0
          and coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost) is null
      )::float8 as unvalued_qty,
      sum(-least(b.stock_qty, 0))::float8 as negative_stock_qty,
      count(distinct b.nomenklatura_key) filter (
        where coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost) is not null
      ) as valued_item_count
    from latest_balances b
    join ${warehouses} w on w.ref_key = b.sklad_key
    left join store_names n on n.ref_key = w.magazin_key
    left join latest_store_costs sc
      on sc.magazin_key = w.magazin_key and sc.nomenklatura_key = b.nomenklatura_key
    left join latest_global_costs gc on gc.nomenklatura_key = b.nomenklatura_key
    left join purchase_costs_90d pc on pc.nomenklatura_key = b.nomenklatura_key
    where b.stock_qty <> 0 or b.reserved_qty <> 0
    group by 1, 2
    order by stock_cost desc
  `;

  const storesResult = rows.map((row) => {
    const itemCount = Number(row.item_count ?? 0);
    const valuedItemCount = Number(row.valued_item_count ?? 0);
    return {
      storeKey: row.store_key,
      storeName: storeName(row.store_name, row.store_key),
      snapshotAt: row.snapshot_at?.toISOString() ?? null,
      warehouseCount: Number(row.warehouse_count ?? 0),
      itemCount,
      stockQty: Number(row.stock_qty ?? 0),
      reservedQty: Number(row.reserved_qty ?? 0),
      availableQty: Number(row.available_qty ?? 0),
      stockCost: Number(row.stock_cost ?? 0),
      unvaluedQty: Number(row.unvalued_qty ?? 0),
      negativeStockQty: Number(row.negative_stock_qty ?? 0),
      costCoveragePct: itemCount > 0 ? (valuedItemCount / itemCount) * 100 : 100
    };
  });
  const summary = storesResult.reduce(
    (acc, row) => {
      acc.stockQty += row.stockQty;
      acc.reservedQty += row.reservedQty;
      acc.availableQty += row.availableQty;
      acc.stockCost += row.stockCost;
      acc.unvaluedQty += row.unvaluedQty;
      acc.negativeStockQty += row.negativeStockQty;
      return acc;
    },
    {
      stockQty: 0,
      reservedQty: 0,
      availableQty: 0,
      stockCost: 0,
      unvaluedQty: 0,
      negativeStockQty: 0
    }
  );

  return { summary, stores: storesResult.slice(0, params.limit) };
}

export async function getSourceHealth(params: ManagementMetricParams) {
  const checks = qualifiedTable("document_chek_kkm");
  const stores = qualifiedTable("catalog_magaziny");
  const timesheets = qualifiedTable("document_tabel_ucheta_rabochego_vremeni");
  const payroll = qualifiedTable("document_zarplata_k_vyplate_organizatsiy");
  const salesDocuments = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const salesLines = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_tovary");
  const returnLines = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary");
  const organizations = qualifiedTable("catalog_organizatsii");

  const [row] = await prisma.$queryRaw<
    Array<{
      check_count: bigint | number;
      check_from: Date | null;
      check_to: Date | null;
      store_count: bigint | number;
      stores_with_area: bigint | number;
      timesheet_count: bigint | number;
      payroll_count: bigint | number;
      bank_table_count: bigint | number;
      bazza_revenue: number | null;
      sales_vat: number | null;
      gross_header_revenue: number | null;
      gross_line_revenue: number | null;
      header_returns: number | null;
      line_returns: number | null;
    }>
  >`
    select
      (select count(*) from ${checks} c where c.deletion_mark is not true and c.posted = true) as check_count,
      (select min(c.date) from ${checks} c where c.deletion_mark is not true and c.posted = true) as check_from,
      (select max(c.date) from ${checks} c where c.deletion_mark is not true and c.posted = true) as check_to,
      (select count(*) from ${stores} s where s.deletion_mark is not true) as store_count,
      (select count(*) from ${stores} s where s.deletion_mark is not true and s.ploschad_torgovogo_zala > 0) as stores_with_area,
      (select count(*) from ${timesheets} t where t.deletion_mark is not true and t.posted = true) as timesheet_count,
      (select count(*) from ${payroll} p where p.deletion_mark is not true and p.posted = true) as payroll_count,
      (select count(*) from information_schema.tables t
        where t.table_schema = ${config.PGSCHEMA}
          and (t.table_name ilike '%raschetnogo_scheta%' or t.table_name ilike '%bankovskaya_vypiska%')) as bank_table_count,
      (select coalesce(sum(d.summa_dokumenta), 0)::float8
        from ${salesDocuments} d left join ${organizations} o on o.ref_key = d.organizatsiya_key
        where ${dateFilters("d", params)} and o.description ilike '%BaZZa%') as bazza_revenue,
      (select coalesce(sum(l.summa_nds), 0)::float8
        from ${salesLines} l join ${salesDocuments} d on d.ref_key = l."_parent_ref_key"
        where ${dateFilters("d", params)}) as sales_vat,
      (select coalesce(sum(d.summa_dokumenta), 0)::float8 from ${salesDocuments} d where ${dateFilters("d", params)}) as gross_header_revenue,
      (select coalesce(sum(l.summa), 0)::float8 from ${salesLines} l join ${salesDocuments} d on d.ref_key = l."_parent_ref_key" where ${dateFilters("d", params)}) as gross_line_revenue,
      (select coalesce(sum(d.summa_vozvratov), 0)::float8 from ${salesDocuments} d where ${dateFilters("d", params)}) as header_returns,
      (select coalesce(sum(l.summa), 0)::float8 from ${returnLines} l join ${salesDocuments} d on d.ref_key = l."_parent_ref_key" where ${dateFilters("d", params)}) as line_returns
  `;

  const data = {
    checks: {
      count: Number(row?.check_count ?? 0),
      dateFrom: row?.check_from?.toISOString() ?? null,
      dateTo: row?.check_to?.toISOString() ?? null
    },
    storeAreas: {
      total: Number(row?.store_count ?? 0),
      filled: Number(row?.stores_with_area ?? 0)
    },
    payroll: {
      timesheets: Number(row?.timesheet_count ?? 0),
      payrollDocuments: Number(row?.payroll_count ?? 0)
    },
    bankStatements: { tableCount: Number(row?.bank_table_count ?? 0) },
    vat: {
      bazzaRevenue: Number(row?.bazza_revenue ?? 0),
      recordedVat: Number(row?.sales_vat ?? 0)
    },
    reconciliation: {
      grossHeaderRevenue: Number(row?.gross_header_revenue ?? 0),
      grossLineRevenue: Number(row?.gross_line_revenue ?? 0),
      headerReturns: Number(row?.header_returns ?? 0),
      lineReturns: Number(row?.line_returns ?? 0)
    }
  };

  return {
    ...data,
    issues: [
      {
        key: "checks",
        severity: "partial",
        title: "Чеки ККМ загружены не за весь период",
        detail: data.checks.dateFrom && data.checks.dateTo
          ? `Покрытие ${data.checks.dateFrom.slice(0, 10)} — ${data.checks.dateTo.slice(0, 10)}; средний чек и трафик пока строятся по отчетам розницы.`
          : "Чеки ККМ не загружены."
      },
      {
        key: "store-area",
        severity: data.storeAreas.filled === data.storeAreas.total && data.storeAreas.total > 0 ? "ready" : "blocked",
        title: "Площадь торговых залов",
        detail: `Заполнено ${data.storeAreas.filled} из ${data.storeAreas.total}; метрики на м² заблокированы.`
      },
      {
        key: "payroll",
        severity: data.payroll.timesheets > 0 && data.payroll.payrollDocuments > 0 ? "ready" : "blocked",
        title: "Табели и зарплата",
        detail: `Табелей: ${data.payroll.timesheets}; зарплатных документов: ${data.payroll.payrollDocuments}.`
      },
      {
        key: "bank",
        severity: data.bankStatements.tableCount > 0 ? "ready" : "blocked",
        title: "Банковские выписки",
        detail: data.bankStatements.tableCount > 0
          ? "Таблицы банковских движений найдены."
          : "Банковские движения не загружены; свободные деньги и платежный календарь считать нельзя."
      },
      {
        key: "vat",
        severity: data.vat.bazzaRevenue > 0 && data.vat.recordedVat === 0 ? "blocked" : "ready",
        title: "НДС в продажах",
        detail: data.vat.bazzaRevenue > 0 && data.vat.recordedVat === 0
          ? "Продажи BaZZa есть, но сумма НДС в строках продаж равна нулю; P&L без НДС пока недостоверен."
          : "Суммы НДС присутствуют в источнике."
      }
    ]
  };
}
