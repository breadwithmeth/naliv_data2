import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { canonicalItemCostsCtes } from "../lib/cost-sql.js";
import { prisma } from "../prisma.js";
import { applicationTable, ensureManagementSettingsTables } from "./management-settings.js";

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
  const revisionDocuments = qualifiedTable("document_pereschet_tovarov");
  const revisionLines = qualifiedTable("document_pereschet_tovarov_tovary");
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
    latest_revision_lines as (
      select distinct on (d.ref_key, l.nomenklatura_key)
        coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
        d.ref_key,
        l.nomenklatura_key,
        (l.summa_fakt - coalesce(l.summa, 0))::float8 as difference
      from ${revisionDocuments} d
      join ${revisionLines} l on l."_parent_ref_key" = d.ref_key
      where ${dateFilters("d", params)}
        and d.uchetnye_dannye_zapolneny is true
        and l.summa_fakt is not null
      order by d.ref_key, l.nomenklatura_key, l.line_number desc
    ),
    revision_movements as (
      select
        store_key,
        coalesce(sum(-difference) filter (where difference < 0), 0)::float8
          as writeoffs,
        coalesce(sum(difference) filter (where difference > 0), 0)::float8
          as surpluses
      from latest_revision_lines
      group by store_key
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
      union select store_key from revision_movements
    ),
    store_names as (
      select ref_key, max(description) as description
      from ${stores}
      group by ref_key
    )
    select
      k.store_key,
      n.description as store_name,
      (coalesce(w.amount, 0) + coalesce(rv.writeoffs, 0))::float8 as writeoffs,
      (coalesce(s.amount, 0) + coalesce(rv.surpluses, 0))::float8 as surpluses,
      (
        coalesce(w.amount, 0) + coalesce(rv.writeoffs, 0)
        - coalesce(s.amount, 0) - coalesce(rv.surpluses, 0)
      )::float8 as net_losses,
      coalesce(r.amount, 0)::float8 as net_revenue,
      case when r.amount <> 0 then
        (
          (
            coalesce(w.amount, 0) + coalesce(rv.writeoffs, 0)
            - coalesce(s.amount, 0) - coalesce(rv.surpluses, 0)
          ) / r.amount * 100
        )::float8
      else null end as loss_pct
    from store_keys k
    left join writeoffs w using (store_key)
    left join surpluses s using (store_key)
    left join revision_movements rv using (store_key)
    left join revenue r using (store_key)
    left join store_names n on n.ref_key = k.store_key
    order by abs(
      coalesce(w.amount, 0) + coalesce(rv.writeoffs, 0)
      - coalesce(s.amount, 0) - coalesce(rv.surpluses, 0)
    ) desc
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
    definition: "Списания + недостачи ревизий − оприходования − излишки ревизий; выручка — после явных возвратов."
  };
}

export async function getAcquiringMetrics(params: ManagementMetricParams) {
  const cardRegister = qualifiedTable(
    "accumulation_register_prodazhi_po_platezhnym_kartam_record_type"
  );
  const stores = qualifiedTable("catalog_magaziny");
  const periodFilters: Prisma.Sql[] = [
    Prisma.sql`r.period is not null`,
    Prisma.sql`r.active is not false`
  ];
  if (params.from) {
    periodFilters.push(Prisma.sql`r.period >= ${params.from}`);
  }
  if (params.to) {
    periodFilters.push(Prisma.sql`r.period < ${params.to}`);
  }

  const rows = await prisma.$queryRaw<
    Array<{
      store_key: string;
      store_name: string | null;
      sales: number | null;
      returns: number | null;
      turnover: number | null;
      commission: number | null;
      commission_source_lines: bigint | number;
      record_count: bigint | number;
    }>
  >`
    with store_names as (
      select ref_key, max(description) as description
      from ${stores}
      group by ref_key
    )
    select
      coalesce(nullif(r.magazin_key, ''), 'Без магазина') as store_key,
      n.description as store_name,
      sum(coalesce(r.summa_operatsiy_prodazhi, 0))::float8 as sales,
      sum(coalesce(r.summa_operatsiy_vozvrata, 0))::float8 as returns,
      sum(
        coalesce(r.summa_operatsiy_prodazhi, 0)
        - coalesce(r.summa_operatsiy_vozvrata, 0)
      )::float8 as turnover,
      sum(
        coalesce(r.nachislennaya_summa_komissii, 0)
        - coalesce(r.otmenennaya_summa_komissii, 0)
        - coalesce(r.vozvraschaemaya_summa_komissii, 0)
      )::float8 as commission,
      count(*) filter (
        where coalesce(r.nachislennaya_summa_komissii, 0) <> 0
          or coalesce(r.otmenennaya_summa_komissii, 0) <> 0
          or coalesce(r.vozvraschaemaya_summa_komissii, 0) <> 0
      ) as commission_source_lines,
      count(*) as record_count
    from ${cardRegister} r
    left join store_names n on n.ref_key = r.magazin_key
    where ${Prisma.join(periodFilters, " and ")}
    group by 1, 2
    order by turnover desc
  `;

  const storesResult = rows.map((row) => {
    const sales = Number(row.sales ?? 0);
    const returns = Number(row.returns ?? 0);
    const turnover = Number(row.turnover ?? 0);
    const commission = Number(row.commission ?? 0);
    const commissionSourceLines = Number(row.commission_source_lines ?? 0);
    return {
      storeKey: row.store_key,
      storeName: storeName(row.store_name, row.store_key),
      sales,
      returns,
      turnover,
      commission: commissionSourceLines > 0 ? commission : null,
      commissionPct:
        commissionSourceLines > 0 && sales > 0
          ? (commission / sales) * 100
          : null,
      commissionSourceLines,
      recordCount: Number(row.record_count ?? 0)
    };
  });
  const summary = storesResult.reduce(
    (acc, row) => {
      acc.sales += row.sales;
      acc.returns += row.returns;
      acc.turnover += row.turnover;
      acc.recordCount += row.recordCount;
      acc.commissionSourceLines += row.commissionSourceLines;
      acc.recordedCommission += row.commission ?? 0;
      return acc;
    },
    {
      sales: 0,
      returns: 0,
      turnover: 0,
      recordedCommission: 0,
      commissionSourceLines: 0,
      recordCount: 0
    }
  );

  return {
    summary: {
      sales: summary.sales,
      returns: summary.returns,
      turnover: summary.turnover,
      commission:
        summary.commissionSourceLines > 0
          ? summary.recordedCommission
          : null,
      commissionPct:
        summary.commissionSourceLines > 0 && summary.sales > 0
          ? (summary.recordedCommission / summary.sales) * 100
          : null,
      recordCount: summary.recordCount,
      commissionSourceLines: summary.commissionSourceLines,
      commissionStatus:
        summary.commissionSourceLines > 0 ? "ready" : "unavailable"
    },
    stores: storesResult.slice(0, params.limit),
    limitation:
      summary.commissionSourceLines === 0
        ? "Карточные продажи и возвраты взяты из регистра 1С; комиссия в регистре равна нулю, банковские зачисления отсутствуют."
        : "Карточные продажи, возвраты и комиссия взяты из регистра 1С; банковские зачисления для расчёта «в пути» отсутствуют."
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
  const outgoingTransfers = qualifiedTable("document_rashodnyy_kassovyy_order");
  const incomingTransfers = qualifiedTable("document_prihodnyy_kassovyy_order");
  await ensureManagementSettingsTables();

  const outgoingTransferKeysQuery = Prisma.sql`
    select d.ref_key
    from ${outgoingTransfers} d
    where ${dateFilters("d", params)}
      and (
        (
          d.kassa_poluchatel_key is not null
          and d.kassa_poluchatel_key <> ''
          and d.kassa_poluchatel_key <> '00000000-0000-0000-0000-000000000000'
        )
        or exists (
          select 1
          from ${incomingTransfers} p
          where p.dokument_osnovanie = d.ref_key
            and p.dokument_osnovanie_type = 'StandardODATA.Document_РасходныйКассовыйОрдер'
            and p.deletion_mark is not true
        )
      )
  `;
  const incomingInternalQuery = Prisma.sql`
    select d.ref_key
    from ${incomingTransfers} d
    where ${dateFilters("d", params)}
      and (
        d.dokument_osnovanie_type = 'StandardODATA.Document_ВыемкаДенежныхСредствИзКассыККМ'
        or (
          d.dokument_osnovanie_type = 'StandardODATA.Document_РасходныйКассовыйОрдер'
          and d.dokument_osnovanie in (select ref_key from outgoing_transfer_keys)
        )
      )
  `;

  const rows = await prisma.$queryRaw<
    Array<{
      article_key: string;
      article_name: string | null;
      inflow: number | null;
      outflow: number | null;
      line_count: bigint | number;
      store_tagged: bigint | number;
      internal_line_count: bigint | number;
      internal_inflow: number | null;
      internal_outflow: number | null;
    }>
  >`
    with outgoing_transfer_keys as (
      -- Structurally unambiguous own-cash movements: another own cash desk or
      -- an RKO explicitly paired with a receiving PKO.
      ${outgoingTransferKeysQuery}
    ),
    incoming_internal as (
      -- KKM extraction and the receiving side of an own-RKO transfer.
      ${incomingInternalQuery}
    ),
    movements as (
      select
        l.statya_dvizheniya_denezhnyh_sredstv_key as article_key,
        coalesce(l.summa, 0)::float8 as inflow,
        0::float8 as outflow,
        false as has_store,
        d.ref_key in (select ref_key from incoming_internal) as is_internal
      from ${incomingDocuments} d
      join ${incomingLines} l on l."_parent_ref_key" = d.ref_key
      where ${dateFilters("d", params)}
      union all
      select
        l.statya_dvizheniya_denezhnyh_sredstv_key as article_key,
        0::float8 as inflow,
        coalesce(l.summa, 0)::float8 as outflow,
        nullif(l.magazin_key, '') is not null as has_store,
        true as is_internal
      from ${outgoingDocuments} d
      join ${outgoingLines} l on l."_parent_ref_key" = d.ref_key
      where ${dateFilters("d", params)}
        and d.ref_key in (select ref_key from outgoing_transfer_keys)
      union all
      select
        l.statya_dvizheniya_denezhnyh_sredstv_key as article_key,
        0::float8 as inflow,
        coalesce(l.summa, 0)::float8 as outflow,
        nullif(l.magazin_key, '') is not null as has_store,
        false as is_internal
      from ${outgoingDocuments} d
      join ${outgoingLines} l on l."_parent_ref_key" = d.ref_key
      where ${dateFilters("d", params)}
        and d.ref_key not in (select ref_key from outgoing_transfer_keys)
    ),
    article_names as (
      select ref_key, max(description) as description
      from ${articles}
      group by ref_key
    ),
    classified as (
      select
        coalesce(nullif(m.article_key, ''), 'Без статьи') as article_key,
        coalesce(n.description, 'Без статьи') as article_name,
        m.inflow,
        m.outflow,
        m.has_store,
        m.is_internal
      from movements m
      left join article_names n on n.ref_key = m.article_key
    )
    select
      article_key,
      article_name,
      sum(inflow)::float8 as inflow,
      sum(outflow)::float8 as outflow,
      count(*) as line_count,
      count(*) filter (where has_store) as store_tagged,
      count(*) filter (where is_internal) as internal_line_count,
      sum(inflow) filter (where is_internal)::float8 as internal_inflow,
      sum(outflow) filter (where is_internal)::float8 as internal_outflow
    from classified
    group by 1, 2
    order by sum(inflow) + sum(outflow) desc
  `;
  const [unallocatedInternalDocuments] = await prisma.$queryRaw<Array<{
    inflow: number | null;
    outflow: number | null;
    incoming_document_count: bigint | number;
    outgoing_document_count: bigint | number;
  }>>`
    with outgoing_transfer_keys as (
      ${outgoingTransferKeysQuery}
    ),
    incoming_internal as (
      ${incomingInternalQuery}
    ),
    incoming_totals as (
      select
        coalesce(sum(coalesce(d.summa_dokumenta, 0)), 0)::float8 as amount,
        count(*) as document_count
      from ${incomingDocuments} d
      where d.ref_key in (select ref_key from incoming_internal)
        and not exists (
          select 1
          from ${incomingLines} l
          where l."_parent_ref_key" = d.ref_key
        )
    ),
    outgoing_totals as (
      select
        coalesce(sum(coalesce(d.summa_dokumenta, 0)), 0)::float8 as amount,
        count(*) as document_count
      from ${outgoingDocuments} d
      where d.ref_key in (select ref_key from outgoing_transfer_keys)
        and not exists (
          select 1
          from ${outgoingLines} l
          where l."_parent_ref_key" = d.ref_key
        )
    )
    select
      incoming_totals.amount as inflow,
      outgoing_totals.amount as outflow,
      incoming_totals.document_count as incoming_document_count,
      outgoing_totals.document_count as outgoing_document_count
    from incoming_totals
    cross join outgoing_totals
  `;

  type FlowType = "operating" | "investing" | "financing" | "internal";
  type StatementFlow = Exclude<FlowType, "internal">;
  const articleSettings = await prisma.$queryRaw<Array<{
    article_key: string;
    flow_type: FlowType;
  }>>`
    select article_key, flow_type
    from ${applicationTable("naliv_cash_article_settings")}
    where approved = true and flow_type is not null
  `;
  const flowByArticle = new Map(
    articleSettings.map((row) => [row.article_key, row.flow_type] as const)
  );
  const flows: Record<StatementFlow, { inflow: number; outflow: number; net: number }> = {
    operating: { inflow: 0, outflow: 0, net: 0 },
    investing: { inflow: 0, outflow: 0, net: 0 },
    financing: { inflow: 0, outflow: 0, net: 0 }
  };
  const summary = {
    inflow: 0,
    outflow: 0,
    lineCount: 0,
    storeTagged: 0,
    categorizedLines: 0,
    internalInflow: 0,
    internalOutflow: 0
  };
  let classifiedTurnover = 0;
  let unclassifiedTurnover = 0;
  let classifiedArticleCount = 0;
  let unclassifiedArticleCount = 0;

  const articlesResult = rows.map((row) => {
    const sourceInflow = Number(row.inflow ?? 0);
    const sourceOutflow = Number(row.outflow ?? 0);
    const structuralInternalInflow = Number(row.internal_inflow ?? 0);
    const structuralInternalOutflow = Number(row.internal_outflow ?? 0);
    const baseExternalInflow = sourceInflow - structuralInternalInflow;
    const baseExternalOutflow = sourceOutflow - structuralInternalOutflow;
    const lineCount = Number(row.line_count ?? 0);
    const structuralInternalLineCount = Number(row.internal_line_count ?? 0);
    const flowType = flowByArticle.get(row.article_key) ?? null;
    const articleIsInternal = flowType === "internal";
    const inflow = articleIsInternal ? 0 : baseExternalInflow;
    const outflow = articleIsInternal ? 0 : baseExternalOutflow;
    const internalInflow =
      structuralInternalInflow + (articleIsInternal ? baseExternalInflow : 0);
    const internalOutflow =
      structuralInternalOutflow + (articleIsInternal ? baseExternalOutflow : 0);
    const turnover = Math.abs(inflow) + Math.abs(outflow);

    summary.inflow += sourceInflow;
    summary.outflow += sourceOutflow;
    summary.lineCount += lineCount;
    summary.storeTagged += Number(row.store_tagged ?? 0);
    summary.internalInflow += internalInflow;
    summary.internalOutflow += internalOutflow;
    if (row.article_key !== "Без статьи") {
      summary.categorizedLines += lineCount;
    }

    if (flowType && flowType !== "internal") {
      flows[flowType].inflow += inflow;
      flows[flowType].outflow += outflow;
      classifiedTurnover += turnover;
      if (turnover > 0) classifiedArticleCount += 1;
    } else if (!articleIsInternal) {
      unclassifiedTurnover += turnover;
      if (turnover > 0) unclassifiedArticleCount += 1;
    }

    return {
      articleKey: row.article_key,
      articleName: row.article_name ?? "Без статьи",
      flowType,
      inflow,
      outflow,
      net: inflow - outflow,
      lineCount,
      storeTagged: Number(row.store_tagged ?? 0),
      internalLineCount: articleIsInternal ? lineCount : structuralInternalLineCount,
      internalInflow,
      internalOutflow
    };
  });
  const approvedInternalArticleCount = articleSettings.filter(
    (row) => row.flow_type === "internal"
  ).length;
  const unallocatedInternalInflow = Number(unallocatedInternalDocuments?.inflow ?? 0);
  const unallocatedInternalOutflow = Number(unallocatedInternalDocuments?.outflow ?? 0);
  const unallocatedInternalDocumentCount =
    Number(unallocatedInternalDocuments?.incoming_document_count ?? 0) +
    Number(unallocatedInternalDocuments?.outgoing_document_count ?? 0);
  const internalTransferTurnover =
    summary.internalInflow +
    summary.internalOutflow +
    unallocatedInternalInflow +
    unallocatedInternalOutflow;
  const internalTransferStatus =
    approvedInternalArticleCount === 0 && internalTransferTurnover === 0
      ? "unavailable"
      : "partial";

  for (const flow of Object.values(flows)) {
    flow.net = flow.inflow - flow.outflow;
  }
  // Header-only transfer totals are reporting-only: they were never part of
  // the line-based summary and therefore must not enter this subtraction.
  const externalInflow = summary.inflow - summary.internalInflow;
  const externalOutflow = summary.outflow - summary.internalOutflow;
  const externalTurnover = classifiedTurnover + unclassifiedTurnover;
  const classifiedCoveragePct =
    externalTurnover > 0 ? (classifiedTurnover / externalTurnover) * 100 : 100;
  const flowStatus = classifiedArticleCount === 0 ? "unavailable" : "partial";
  const statementFlows =
    flowStatus === "unavailable"
      ? {
          operating: { inflow: null, outflow: null, net: null },
          investing: { inflow: null, outflow: null, net: null },
          financing: { inflow: null, outflow: null, net: null }
        }
      : flows;

  return {
    summary: {
      ...summary,
      net: externalInflow - externalOutflow,
      externalInflow,
      externalOutflow,
      categorizedPct: summary.lineCount > 0 ? (summary.categorizedLines / summary.lineCount) * 100 : 100,
      storeTaggedPct: summary.lineCount > 0 ? (summary.storeTagged / summary.lineCount) * 100 : 100
    },
    statement: {
      status: flowStatus,
      classifiedCoveragePct,
      classifiedTurnover,
      unclassifiedTurnover,
      internalTransferTurnover,
      internalTransferStatus,
      unallocatedInternalInflow,
      unallocatedInternalOutflow,
      unallocatedInternalDocumentCount,
      classifiedArticleCount,
      unclassifiedArticleCount,
      approvedInternalArticleCount,
      flows: statementFlows
    },
    articles: articlesResult.slice(0, params.limit),
    limitation: "Кассовый ОДДС по ПКО/РКО 1С. Выемки из ККМ и переводы между своими кассами автоматически исключаются по реквизитам документов; суммы внутренних документов без расшифровки учитываются отдельно по заголовкам. Реквизит банковского счёта содержит только нулевой ключ во всех доступных ПКО/РКО, поэтому инкассация, перемещения касса↔банк, мелочь и другие неоднозначные статьи исключаются только после подтверждения финансистом как «Внутреннее перемещение». Банковские движения отсутствуют, поэтому потоки остаются частичными, а сверка изменения денег (§4.4) недоступна."
  };
}

export async function getSupplierTermsMetrics(params: ManagementMetricParams) {
  const orders = qualifiedTable("document_zakaz_postavschiku");
  const paymentStages = qualifiedTable("document_zakaz_postavschiku_etapy_oplat");
  const receipts = qualifiedTable("document_postuplenie_tovarov");
  const counterparties = qualifiedTable("catalog_kontragenty");
  const requestedScheduleFrom = params.to ?? new Date();
  const scheduleFrom = new Date(
    Math.min(requestedScheduleFrom.getTime(), Date.now())
  );
  scheduleFrom.setUTCHours(0, 0, 0, 0);
  const schedule30To = new Date(scheduleFrom.getTime() + 30 * 86_400_000);
  const schedule56To = new Date(scheduleFrom.getTime() + 56 * 86_400_000);

  const [summaryRows, scheduleRows, upcomingScheduleRows] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        order_count: bigint | number;
        staged_order_count: bigint | number;
        weighted_deferral_days: number | null;
        ordered_amount: number | null;
        staged_amount: number | null;
        received_amount: number | null;
        linked_receipt_count: bigint | number;
        closed_order_count: bigint | number;
      }>
    >`
      with selected_orders as (
        select
          d.ref_key,
          d.date,
          coalesce(d.summa_dokumenta, 0)::float8 as ordered_amount,
          d.zakryt
        from ${orders} d
        where ${dateFilters("d", params)}
      ),
      stage_totals as (
        select
          s."_parent_ref_key" as parent_ref_key,
          sum(coalesce(s.summa, 0))::float8 as amount,
          sum(
            coalesce(s.summa, 0)
            * greatest(
                extract(epoch from (s.data_platezha - d.date)) / 86400.0,
                0
              )
          )::float8 as weighted_days
        from ${paymentStages} s
        join selected_orders d on d.ref_key = s."_parent_ref_key"
        where s.data_platezha is not null
        group by 1
      ),
      receipt_totals as (
        select
          r.zakaz_postavschiku_key as order_key,
          sum(coalesce(r.summa_dokumenta, 0))::float8 as amount,
          count(*) as receipt_count
        from ${receipts} r
        join selected_orders d on d.ref_key = r.zakaz_postavschiku_key
        where r.deletion_mark is not true
          and r.posted = true
          ${params.to ? Prisma.sql`and r.date < ${params.to}` : Prisma.empty}
        group by 1
      )
      select
        count(*) as order_count,
        count(st.parent_ref_key) as staged_order_count,
        case
          when sum(st.amount) > 0
          then sum(st.weighted_days) / sum(st.amount)
          else null
        end::float8 as weighted_deferral_days,
        coalesce(sum(d.ordered_amount), 0)::float8 as ordered_amount,
        coalesce(sum(st.amount), 0)::float8 as staged_amount,
        coalesce(sum(rt.amount), 0)::float8 as received_amount,
        coalesce(sum(rt.receipt_count), 0) as linked_receipt_count,
        count(*) filter (where d.zakryt is true) as closed_order_count
      from selected_orders d
      left join stage_totals st on st.parent_ref_key = d.ref_key
      left join receipt_totals rt on rt.order_key = d.ref_key
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
      join ${orders} d on d.ref_key = s."_parent_ref_key"
      left join counterparty_names n on n.ref_key = d.kontragent_key
      where d.deletion_mark is not true
        and d.posted = true
        and s.data_platezha is not null
        ${params.from ? Prisma.sql`and s.data_platezha >= ${params.from}` : Prisma.empty}
        ${params.to ? Prisma.sql`and s.data_platezha < ${params.to}` : Prisma.empty}
      group by 1, 2
      order by due_day, amount desc
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
      join ${orders} d on d.ref_key = s."_parent_ref_key"
      left join counterparty_names n on n.ref_key = d.kontragent_key
      where d.deletion_mark is not true
        and d.posted = true
        and d.zakryt is not true
        and s.data_platezha >= ${scheduleFrom}
        and s.data_platezha < ${schedule56To}
      group by 1, 2
      order by due_day, amount desc
    `
  ]);

  const summaryRow = summaryRows[0];
  const orderCount = Number(summaryRow?.order_count ?? 0);
  const stagedOrderCount = Number(summaryRow?.staged_order_count ?? 0);
  const stageCoveragePct =
    orderCount > 0 ? (stagedOrderCount / orderCount) * 100 : 0;
  const orderedAmount = Number(summaryRow?.ordered_amount ?? 0);
  const receivedAmount = Number(summaryRow?.received_amount ?? 0);
  const status =
    stagedOrderCount === 0
      ? "unavailable"
      : stageCoveragePct >= 80
        ? "ready"
        : "experimental";
  const next30DayScheduledAmount = upcomingScheduleRows.reduce(
    (sum, row) =>
      row.due_day < schedule30To ? sum + Number(row.amount ?? 0) : sum,
    0
  );
  const next56DayScheduledAmount = upcomingScheduleRows.reduce(
    (sum, row) => sum + Number(row.amount ?? 0),
    0
  );

  return {
    summary: {
      orderCount,
      stagedOrderCount,
      stageCoveragePct,
      weightedDeferralDays:
        summaryRow?.weighted_deferral_days === null
          ? null
          : Number(summaryRow?.weighted_deferral_days ?? 0),
      status,
      orderedAmount,
      stagedAmount: Number(summaryRow?.staged_amount ?? 0),
      receivedAmount,
      executionPct:
        orderedAmount > 0 ? (receivedAmount / orderedAmount) * 100 : null,
      linkedReceiptCount: Number(summaryRow?.linked_receipt_count ?? 0),
      closedOrderCount: Number(summaryRow?.closed_order_count ?? 0),
      next30DayScheduledAmount,
      next56DayScheduledAmount,
      upcomingScheduleStatus: "partial" as const,
      upcomingScheduleFrom: scheduleFrom.toISOString(),
      upcomingScheduleTo: schedule56To.toISOString()
    },
    schedule: scheduleRows.slice(0, params.limit).map((row) => ({
      dueDay: row.due_day.toISOString(),
      counterpartyName: row.counterparty_name ?? "Без контрагента",
      amount: Number(row.amount ?? 0),
      documentCount: Number(row.document_count ?? 0)
    })),
    upcomingSchedule: upcomingScheduleRows.slice(0, params.limit).map((row) => ({
      dueDay: row.due_day.toISOString(),
      counterpartyName: row.counterparty_name ?? "Без контрагента",
      amount: Number(row.amount ?? 0),
      documentCount: Number(row.document_count ?? 0)
    })),
    limitation:
      status === "ready"
        ? "Плановые даты и суммы взяты из этапов оплаты заказов. Календарь на 8 недель включает только открытые заказы и не подтверждает факт оплаты банком."
        : "Часть заказов не имеет этапов оплаты. Календарь на 8 недель отражает только заполненные этапы открытых заказов, не всю кредиторскую задолженность."
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
    balance_snapshot as (
      select max(balance_period) as snapshot_at
      from ${balances}
      where balance_period is not null
        ${params.to ? Prisma.sql`and balance_period < ${params.to}` : Prisma.empty}
    ),
    latest_balances as (
      select
        b.nomenklatura_key,
        b.sklad_key,
        b.balance_period,
        coalesce(b.kolichestvo_balance, 0)::float8 as stock_qty,
        coalesce(b.rezerv_balance, 0)::float8 as reserved_qty
      from ${balances} b
      join balance_snapshot s on s.snapshot_at = b.balance_period
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
      sum(greatest(greatest(b.stock_qty, 0) - greatest(b.reserved_qty, 0), 0))::float8 as available_qty,
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
      acc.itemCount += row.itemCount;
      acc.valuedItemCount += row.itemCount * row.costCoveragePct / 100;
      if (row.snapshotAt && (!acc.snapshotAt || row.snapshotAt > acc.snapshotAt)) {
        acc.snapshotAt = row.snapshotAt;
      }
      return acc;
    },
    {
      stockQty: 0,
      reservedQty: 0,
      availableQty: 0,
      stockCost: 0,
      unvaluedQty: 0,
      negativeStockQty: 0,
      itemCount: 0,
      valuedItemCount: 0,
      snapshotAt: null as string | null
    }
  );

  return {
    summary: {
      ...summary,
      costCoveragePct:
        summary.itemCount > 0 ? (summary.valuedItemCount / summary.itemCount) * 100 : 100
    },
    stores: storesResult.slice(0, params.limit)
  };
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
  // Eligibility is applied once below; these aggregate filters need only the
  // date window, allowing the partial covering receipt index to serve them.
  const checkDateFilters: Prisma.Sql[] = [Prisma.sql`c.date is not null`];
  if (params.from) checkDateFilters.push(Prisma.sql`c.date >= ${params.from}`);
  if (params.to) checkDateFilters.push(Prisma.sql`c.date < ${params.to}`);
  const checkWindow = Prisma.join(checkDateFilters, " and ");

  const [row] = await prisma.$queryRaw<
    Array<{
      check_count: bigint | number;
      check_from: Date | null;
      check_to: Date | null;
      selected_check_count: bigint | number;
      selected_check_days: bigint | number;
      store_count: bigint | number;
      stores_with_area: bigint | number;
      timesheet_count: bigint | number;
      payroll_count: bigint | number;
      bank_table_count: bigint | number;
      bazza_revenue: number | null;
      sales_vat: number | null;
      sales_line_count: bigint | number;
      vat_line_count: bigint | number;
      gross_header_revenue: number | null;
      gross_line_revenue: number | null;
      header_returns: number | null;
      line_returns: number | null;
    }>
  >`
    with check_totals as (
      select
        count(*) as check_count,
        min(c.date) as check_from,
        max(c.date) as check_to,
        count(*) filter (where ${checkWindow}) as selected_check_count,
        count(distinct c.date::date) filter (where ${checkWindow}) as selected_check_days
      from ${checks} c
      where c.deletion_mark is not true and c.posted = true
    ),
    store_totals as (
      select
        count(*) as store_count,
        count(*) filter (where s.ploschad_torgovogo_zala > 0) as stores_with_area
      from ${stores} s
      where s.deletion_mark is not true
    ),
    selected_sales_documents as materialized (
      select d.ref_key, d.organizatsiya_key, d.summa_dokumenta, d.summa_vozvratov
      from ${salesDocuments} d
      where ${dateFilters("d", params)}
    ),
    sales_header_totals as (
      select
        coalesce(sum(d.summa_dokumenta), 0)::float8 as gross_header_revenue,
        coalesce(sum(d.summa_vozvratov), 0)::float8 as header_returns
      from selected_sales_documents d
    ),
    bazza_totals as (
      select coalesce(sum(d.summa_dokumenta), 0)::float8 as bazza_revenue
      from selected_sales_documents d
      join ${organizations} o on o.ref_key = d.organizatsiya_key
      where o.description ilike '%BaZZa%'
    ),
    sales_line_totals as (
      select
        coalesce(sum(l.sales_vat), 0)::float8 as sales_vat,
        coalesce(sum(l.sales_line_count), 0)::bigint as sales_line_count,
        coalesce(sum(l.vat_line_count), 0)::bigint as vat_line_count,
        coalesce(sum(l.gross_line_revenue), 0)::float8 as gross_line_revenue
      from selected_sales_documents d
      -- Aggregate only each selected parent's lines. A broad merge join can
      -- otherwise read most of the randomly ordered raw-line heap for a month.
      cross join lateral (
        select
          sum(l.summa_nds) as sales_vat,
          count(*) as sales_line_count,
          count(*) filter (where abs(coalesce(l.summa_nds, 0)) > 0.000001) as vat_line_count,
          sum(l.summa) as gross_line_revenue
        from ${salesLines} l
        where l."_parent_ref_key" = d.ref_key
      ) l
    ),
    return_line_totals as (
      select coalesce(sum(l.summa), 0)::float8 as line_returns
      from ${returnLines} l
      join selected_sales_documents d on d.ref_key = l."_parent_ref_key"
    )
    select
      c.check_count,
      c.check_from,
      c.check_to,
      c.selected_check_count,
      c.selected_check_days,
      s.store_count,
      s.stores_with_area,
      (select count(*) from ${timesheets} t where ${dateFilters("t", params)}) as timesheet_count,
      (select count(*) from ${payroll} p where ${dateFilters("p", params)}) as payroll_count,
      (select count(*) from information_schema.tables t
        where t.table_schema = ${config.PGSCHEMA}
          and (t.table_name ilike '%raschetnogo_scheta%' or t.table_name ilike '%bankovskaya_vypiska%')) as bank_table_count,
      b.bazza_revenue,
      l.sales_vat,
      l.sales_line_count,
      l.vat_line_count,
      h.gross_header_revenue,
      l.gross_line_revenue,
      h.header_returns,
      r.line_returns
    from check_totals c
    cross join store_totals s
    cross join sales_header_totals h
    cross join bazza_totals b
    cross join sales_line_totals l
    cross join return_line_totals r
  `;

  const data = {
    checks: {
      count: Number(row?.check_count ?? 0),
      selectedCount: Number(row?.selected_check_count ?? 0),
      selectedDays: Number(row?.selected_check_days ?? 0),
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
      recordedVat: Number(row?.sales_vat ?? 0),
      salesLineCount: Number(row?.sales_line_count ?? 0),
      populatedLineCount: Number(row?.vat_line_count ?? 0),
      lineCoveragePct:
        Number(row?.sales_line_count ?? 0) > 0
          ? (Number(row?.vat_line_count ?? 0) / Number(row?.sales_line_count ?? 0)) * 100
          : 0
    },
    reconciliation: {
      grossHeaderRevenue: Number(row?.gross_header_revenue ?? 0),
      grossLineRevenue: Number(row?.gross_line_revenue ?? 0),
      headerReturns: Number(row?.header_returns ?? 0),
      lineReturns: Number(row?.line_returns ?? 0)
    }
  };
  const completedThrough = new Date();
  completedThrough.setUTCHours(0, 0, 0, 0);
  const requestedDays =
    params.from && params.to
      ? Math.max(
          1,
          (Math.min(params.to.getTime(), completedThrough.getTime()) - params.from.getTime())
            / 86_400_000
        )
      : null;
  const checkDayCoveragePct =
    requestedDays === null
      ? null
      : Math.min(100, (data.checks.selectedDays / requestedDays) * 100);
  const checkStatus =
    data.checks.selectedCount > 0 &&
    (checkDayCoveragePct === null || checkDayCoveragePct >= 90)
      ? "ready"
      : "partial";
  const vatStatus =
    data.vat.salesLineCount > 0 && data.vat.lineCoveragePct >= 90
      ? "ready"
      : "blocked";

  return {
    ...data,
    issues: [
      {
        key: "checks",
        severity: checkStatus,
        title: checkStatus === "ready" ? "Чеки ККМ" : "Чеки ККМ загружены не за весь период",
        detail: data.checks.dateFrom && data.checks.dateTo
          ? `Покрытие источника ${data.checks.dateFrom.slice(0, 10)} — ${data.checks.dateTo.slice(0, 10)}; в выбранном периоде ${data.checks.selectedCount} чеков за ${data.checks.selectedDays} дней${checkDayCoveragePct === null ? "" : ` (${checkDayCoveragePct.toFixed(1)}%)`}.`
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
        severity: vatStatus,
        title: "НДС в продажах",
        detail:
          vatStatus === "ready"
            ? `Сумма НДС заполнена в ${data.vat.populatedLineCount} из ${data.vat.salesLineCount} строк продаж (${data.vat.lineCoveragePct.toFixed(1)}%).`
            : `Сумма НДС заполнена только в ${data.vat.populatedLineCount} из ${data.vat.salesLineCount} строк продаж (${data.vat.lineCoveragePct.toFixed(1)}%); P&L после НДС недоступен.`
      }
    ]
  };
}
