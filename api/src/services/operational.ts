import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { canonicalItemCostsCtes } from "../lib/cost-sql.js";
import { prisma } from "../prisma.js";
import type { ManagementMetricParams } from "./management.js";

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(tableName: string) {
  return Prisma.raw(`${quoteIdent(config.PGSCHEMA)}.${quoteIdent(tableName)}`);
}

function displayStoreName(name: string | null, key: string) {
  return name?.trim() || (key === "Без магазина" ? key : `Магазин ${key}`);
}

export async function getMoneyPositionMetrics(params: ManagementMetricParams) {
  const cashBalances = qualifiedTable(
    "accumulation_register_denezhnye_sredstva_nalichnye_balance"
  );
  const kkmBalances = qualifiedTable(
    "accumulation_register_denezhnye_sredstva_kkm_balance"
  );
  const supplierBalances = qualifiedTable(
    "accumulation_register_raschety_s_postavschikami_balance"
  );
  const kkmCatalog = qualifiedTable("catalog_kassy_kkm");
  const stores = qualifiedTable("catalog_magaziny");
  const retailReports = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const asOf = params.to ?? new Date();

  const rows = await prisma.$queryRaw<
    Array<{
      store_key: string;
      store_name: string | null;
      cash_balance: number | null;
      kkm_balance: number | null;
      supplier_sum_raw: number | null;
      supplier_payable_raw: number | null;
      supplier_receivable_raw: number | null;
      cash_sales_28d: number | null;
      cash_sales_days: bigint | number;
      cash_snapshot_at: Date | null;
      kkm_snapshot_at: Date | null;
      supplier_snapshot_at: Date | null;
    }>
  >`
    with
    store_names as (
      select ref_key, max(description) as description
      from ${stores}
      group by ref_key
    ),
    cash_period as (
      select max(balance_period) as period
      from ${cashBalances}
      where balance_period <= ${asOf}
    ),
    cash as (
      select
        coalesce(nullif(b.magazin_key, ''), 'Без магазина') as store_key,
        sum(coalesce(b.summa_balance, 0))::float8 as amount,
        max(b.balance_period) as snapshot_at
      from ${cashBalances} b
      join cash_period p on p.period = b.balance_period
      group by 1
    ),
    kkm_period as (
      select max(balance_period) as period
      from ${kkmBalances}
      where balance_period <= ${asOf}
    ),
    kkm_map as (
      select ref_key, max(nullif(magazin_key, '')) as magazin_key
      from ${kkmCatalog}
      group by ref_key
    ),
    kkm as (
      select
        coalesce(m.magazin_key, 'Без магазина') as store_key,
        sum(coalesce(b.summa_balance, 0))::float8 as amount,
        max(b.balance_period) as snapshot_at
      from ${kkmBalances} b
      join kkm_period p on p.period = b.balance_period
      left join kkm_map m on m.ref_key = b.kassa_kkm_key
      group by 1
    ),
    cash_sales as (
      select
        coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
        sum(coalesce(d.summa_oplaty_nalichnyh, 0))::float8 as amount
      from ${retailReports} d
      cross join kkm_period p
      where p.period is not null
        and d.deletion_mark is not true
        and d.posted = true
        and d.date >= p.period - interval '28 days'
        and d.date < p.period
      group by 1
    ),
    cash_sales_coverage as (
      select count(distinct d.date::date) as covered_days
      from ${retailReports} d
      cross join kkm_period p
      where p.period is not null
        and d.deletion_mark is not true
        and d.posted = true
        and d.date >= p.period - interval '28 days'
        and d.date < p.period
    ),
    supplier_period as (
      select max(balance_period) as period
      from ${supplierBalances}
      where balance_period <= ${asOf}
    ),
    supplier as (
      select
        coalesce(nullif(b.magazin_key, ''), 'Без магазина') as store_key,
        sum(coalesce(b.summa_balance, 0))::float8 as sum_raw,
        sum(coalesce(b.k_oplate_balance, 0))::float8 as payable_raw,
        sum(coalesce(b.k_postupleniyu_balance, 0))::float8 as receivable_raw,
        max(b.balance_period) as snapshot_at
      from ${supplierBalances} b
      join supplier_period p on p.period = b.balance_period
      group by 1
    ),
    store_keys as (
      select store_key from cash
      union select store_key from kkm
      union select store_key from supplier
      union select store_key from cash_sales
    )
    select
      k.store_key,
      n.description as store_name,
      coalesce(c.amount, 0)::float8 as cash_balance,
      coalesce(x.amount, 0)::float8 as kkm_balance,
      coalesce(s.sum_raw, 0)::float8 as supplier_sum_raw,
      coalesce(s.payable_raw, 0)::float8 as supplier_payable_raw,
      coalesce(s.receivable_raw, 0)::float8 as supplier_receivable_raw,
      coalesce(cs.amount, 0)::float8 as cash_sales_28d,
      cov.covered_days as cash_sales_days,
      c.snapshot_at as cash_snapshot_at,
      x.snapshot_at as kkm_snapshot_at,
      s.snapshot_at as supplier_snapshot_at
    from store_keys k
    left join store_names n on n.ref_key = k.store_key
    left join cash c using (store_key)
    left join kkm x using (store_key)
    left join supplier s using (store_key)
    left join cash_sales cs using (store_key)
    cross join cash_sales_coverage cov
    order by coalesce(c.amount, 0) + coalesce(x.amount, 0) desc
  `;

  const allStoreRows = rows.map((row) => {
    const kkmBalance = Number(row.kkm_balance ?? 0);
    const cashSales28d = Number(row.cash_sales_28d ?? 0);
    const cashSalesCoveragePct = Math.min(
      100,
      (Number(row.cash_sales_days) / 28) * 100
    );
    const averageDailyCashSales = cashSales28d / 28;
    return {
      storeKey: row.store_key,
      storeName: displayStoreName(row.store_name, row.store_key),
      cashBalance: Number(row.cash_balance ?? 0),
      kkmBalance,
      totalCash: Number(row.cash_balance ?? 0) + kkmBalance,
      cashSales28d,
      averageDailyCashSales,
      uncollectedCashDays:
        cashSalesCoveragePct >= 90 && averageDailyCashSales > 0
          ? kkmBalance / averageDailyCashSales
          : null,
      supplierSumRaw: Number(row.supplier_sum_raw ?? 0),
      supplierPayableRaw: Number(row.supplier_payable_raw ?? 0),
      supplierReceivableRaw: Number(row.supplier_receivable_raw ?? 0),
      cashSnapshotAt: row.cash_snapshot_at?.toISOString() ?? null,
      kkmSnapshotAt: row.kkm_snapshot_at?.toISOString() ?? null,
      supplierSnapshotAt: row.supplier_snapshot_at?.toISOString() ?? null,
      cashSalesCoveragePct
    };
  });
  const summary = allStoreRows.reduce(
    (total, row) => {
      total.cashBalance += row.cashBalance;
      total.kkmBalance += row.kkmBalance;
      total.totalCash += row.totalCash;
      total.cashSales28d += row.cashSales28d;
      total.supplierSumRaw += row.supplierSumRaw;
      total.supplierPayableRaw += row.supplierPayableRaw;
      total.supplierReceivableRaw += row.supplierReceivableRaw;
      return total;
    },
    {
      cashBalance: 0,
      kkmBalance: 0,
      totalCash: 0,
      cashSales28d: 0,
      supplierSumRaw: 0,
      supplierPayableRaw: 0,
      supplierReceivableRaw: 0
    }
  );

  const cashSalesCoveragePct =
    allStoreRows.length > 0 ? allStoreRows[0].cashSalesCoveragePct : 0;
  const averageDailyCashSales = summary.cashSales28d / 28;
  return {
    summary: {
      ...summary,
      bankBalance: null,
      averageDailyCashSales,
      uncollectedCashDays:
        cashSalesCoveragePct >= 90 && averageDailyCashSales > 0
          ? summary.kkmBalance / averageDailyCashSales
          : null,
      cashSalesCoveragePct,
      cashDaysStatus:
        cashSalesCoveragePct >= 90 ? ("ready" as const) : ("partial" as const),
      supplierBalanceStatus: "experimental" as const
    },
    stores: allStoreRows.slice(0, params.limit),
    limitation:
      "Денежная позиция включает только кассы 1С и деньги в ККМ. Дни неинкассированных наличных = остаток ККМ ÷ средняя дневная наличная выручка за 28 дней. Банк отсутствует; знаки расчётов с поставщиками не интерпретируются."
  };
}

export async function getLostSalesMetrics(params: ManagementMetricParams) {
  const checks = qualifiedTable("document_chek_kkm");
  const checkLines = qualifiedTable("document_chek_kkm_tovary");
  const balances = qualifiedTable("accumulation_register_tovary_na_skladah_balance");
  const warehouses = qualifiedTable("catalog_sklady");
  const stores = qualifiedTable("catalog_magaziny");
  const items = qualifiedTable("catalog_nomenklatura");
  const requestedTo = params.to ?? new Date();
  const [boundaryRow] = await prisma.$queryRaw<Array<{ boundary: Date | null }>>`
    select max(balance_period) as boundary
    from ${balances}
    where balance_period <= ${requestedTo}
  `;
  const snapshotBoundary = boundaryRow?.boundary;
  const to =
    snapshotBoundary && snapshotBoundary < requestedTo
      ? snapshotBoundary
      : requestedTo;
  const from = params.from ?? new Date(to.getTime() - 28 * 86_400_000);
  const analysisDays = Math.max(1, (to.getTime() - from.getTime()) / 86_400_000);

  const rows = await prisma.$queryRaw<
    Array<{
      store_key: string;
      store_name: string | null;
      nomenklatura_key: string;
      item_name: string | null;
      abc_class: "A" | "B";
      revenue: number | null;
      average_daily_revenue: number | null;
      zero_stock_days: bigint | number;
      snapshot_days: bigint | number;
      lost_sales: number | null;
    }>
  >`
    with
    warehouse_map as (
      select ref_key, max(nullif(magazin_key, '')) as magazin_key
      from ${warehouses}
      group by ref_key
    ),
    store_names as (
      select ref_key, max(description) as description
      from ${stores}
      group by ref_key
    ),
    item_names as (
      select ref_key, max(description) as description
      from ${items}
      group by ref_key
    ),
    sales as (
      select
        coalesce(nullif(c.magazin_key, ''), 'Без магазина') as store_key,
        l.nomenklatura_key,
        sum(
          case when coalesce(c.vid_operatsii, '') like '%Возврат%'
              or coalesce(c.vid_operatsii, '') like '%возврат%'
            then -coalesce(l.summa, 0)
            else coalesce(l.summa, 0)
          end
        )::float8 as revenue
      from ${checks} c
      join ${checkLines} l on l."_parent_ref_key" = c.ref_key
      where c.deletion_mark is not true
        and c.posted = true
        and c.date >= ${from}
        and c.date < ${to}
        and l.nomenklatura_key is not null
      group by 1, 2
    ),
    positive_sales as (
      select *, sum(revenue) over (partition by store_key)::float8 as store_revenue
      from sales
      where revenue > 0
    ),
    ranked_sales as (
      select
        *,
        (
          sum(revenue) over (
            partition by store_key
            order by revenue desc, nomenklatura_key
            rows between unbounded preceding and current row
          ) - revenue
        ) / nullif(store_revenue, 0) as share_before
      from positive_sales
    ),
    ab_items as (
      select
        *,
        case when share_before < 0.80 then 'A' else 'B' end as abc_class
      from ranked_sales
      where share_before < 0.95
    ),
    snapshot_days as (
      select distinct balance_period, (balance_period::date - 1) as stock_day
      from ${balances}
      where balance_period >= (${from} + interval '1 day')
        and balance_period <= ${to}
    ),
    daily_stock as (
      select
        b.balance_period,
        coalesce(w.magazin_key, 'Без магазина') as store_key,
        b.nomenklatura_key,
        sum(coalesce(b.kolichestvo_balance, 0))::float8 as qty
      from ${balances} b
      join snapshot_days d on d.balance_period = b.balance_period
      join warehouse_map w on w.ref_key = b.sklad_key
      group by 1, 2, 3
    ),
    item_days as (
      select
        a.store_key,
        a.nomenklatura_key,
        a.abc_class,
        a.revenue,
        d.balance_period,
        coalesce(s.qty, 0)::float8 as qty
      from ab_items a
      cross join snapshot_days d
      left join daily_stock s
        on s.balance_period = d.balance_period
       and s.store_key = a.store_key
       and s.nomenklatura_key = a.nomenklatura_key
    )
    select
      d.store_key,
      sn.description as store_name,
      d.nomenklatura_key,
      i.description as item_name,
      d.abc_class,
      max(d.revenue)::float8 as revenue,
      (max(d.revenue) / ${analysisDays})::float8 as average_daily_revenue,
      count(*) filter (where d.qty <= 0) as zero_stock_days,
      count(*) as snapshot_days,
      (max(d.revenue) / ${analysisDays}
        * count(*) filter (where d.qty <= 0))::float8 as lost_sales
    from item_days d
    left join store_names sn on sn.ref_key = d.store_key
    left join item_names i on i.ref_key = d.nomenklatura_key
    group by d.store_key, sn.description, d.nomenklatura_key, i.description, d.abc_class
    having count(*) filter (where d.qty <= 0) > 0
    order by lost_sales desc
  `;
  const [coverageRow] = await prisma.$queryRaw<
    Array<{ snapshot_days: bigint | number; check_days: bigint | number }>
  >`
    select
      (
        select count(distinct b.balance_period)
        from ${balances} b
        where b.balance_period >= (${from} + interval '1 day')
          and b.balance_period <= ${to}
      ) as snapshot_days,
      (
        select count(distinct c.date::date)
        from ${checks} c
        where c.deletion_mark is not true
          and c.posted = true
          and c.date >= ${from}
          and c.date < ${to}
      ) as check_days
  `;


  const itemRows = rows.map((row) => ({
    storeKey: row.store_key,
    storeName: displayStoreName(row.store_name, row.store_key),
    itemKey: row.nomenklatura_key,
    itemName: row.item_name?.trim() || row.nomenklatura_key,
    abcClass: row.abc_class,
    revenue: Number(row.revenue ?? 0),
    averageDailyRevenue: Number(row.average_daily_revenue ?? 0),
    zeroStockDays: Number(row.zero_stock_days ?? 0),
    snapshotDays: Number(row.snapshot_days ?? 0),
    lostSales: Number(row.lost_sales ?? 0)
  }));
  const snapshotDays = Number(coverageRow?.snapshot_days ?? 0);
  const checkDays = Number(coverageRow?.check_days ?? 0);
  const snapshotCoveragePct = Math.min(
    100,
    (snapshotDays / analysisDays) * 100
  );
  const checkCoveragePct = Math.min(100, (checkDays / analysisDays) * 100);
  const coveragePct = Math.min(snapshotCoveragePct, checkCoveragePct);
  const observedLostSales = itemRows.reduce((sum, row) => sum + row.lostSales, 0);
  const byStore = new Map<
    string,
    { storeName: string; lostSales: number; zeroStockItemDays: number }
  >();
  for (const row of itemRows) {
    const current = byStore.get(row.storeKey) ?? {
      storeName: row.storeName,
      lostSales: 0,
      zeroStockItemDays: 0
    };
    current.lostSales += row.lostSales;
    current.zeroStockItemDays += row.zeroStockDays;
    byStore.set(row.storeKey, current);
  }

  return {
    summary: {
      lostSales: coveragePct >= 90 ? observedLostSales : null,
      observedLostSales,
      zeroStockItemDays: itemRows.reduce(
        (sum, row) => sum + row.zeroStockDays,
        0
      ),
      affectedItemCount: itemRows.length,
      snapshotDays,
      analysisDays,
      checkDays,
      snapshotCoveragePct,
      checkCoveragePct,
      coveragePct,
      status: coveragePct >= 90 ? ("ready" as const) : ("partial" as const)
    },
    stores: [...byStore.entries()]
      .map(([storeKey, row]) => ({ storeKey, ...row }))
      .sort((a, b) => b.lostSales - a.lostSales)
      .slice(0, params.limit),
    items: itemRows.slice(0, params.limit),
    methodology:
      "A/B-позиции — первые 95% положительной выручки точки. Lost Sales = средняя дневная выручка товара × дни с остатком ≤ 0 по ежедневным снимкам."
  };
}

export async function getPurchasingRecommendations(params: ManagementMetricParams) {
  const checks = qualifiedTable("document_chek_kkm");
  const checkLines = qualifiedTable("document_chek_kkm_tovary");
  const balances = qualifiedTable("accumulation_register_tovary_na_skladah_balance");
  const warehouses = qualifiedTable("catalog_sklady");
  const stores = qualifiedTable("catalog_magaziny");
  const items = qualifiedTable("catalog_nomenklatura");
  const suppliers = qualifiedTable("catalog_kontragenty");
  const orders = qualifiedTable("document_zakaz_postavschiku");
  const orderLines = qualifiedTable("document_zakaz_postavschiku_tovary");
  const receipts = qualifiedTable("document_postuplenie_tovarov");
  const receiptLines = qualifiedTable("document_postuplenie_tovarov_tovary");
  const requestedAsOf = params.to ?? new Date();

  const snapshotRows = await prisma.$queryRaw<Array<{ snapshot_at: Date | null }>>`
    select max(balance_period) as snapshot_at
    from ${balances}
    where balance_period <= ${requestedAsOf}
  `;
  const effectiveAsOf = snapshotRows[0]?.snapshot_at ?? requestedAsOf;
  const executionFrom = new Date(effectiveAsOf.getTime() - 7 * 86_400_000);

  type NeedRow = {
    store_key: string;
    store_name: string | null;
    nomenklatura_key: string;
    item_name: string | null;
    supplier_key: string | null;
    supplier_name: string | null;
    stock_qty: number | null;
    open_order_qty: number | null;
    target_stock: number | null;
    sales_qty_28d: number | null;
    daily_sales_qty: number | null;
    days_of_stock: number | null;
    unit_cost: number | null;
    recommended_qty: number | null;
    purchase_budget_qty: number | null;
    recommended_amount: number | null;
    purchase_budget_amount: number | null;
  };

  const loadNeeds = (snapshotAt: Date) => {
    const velocityFrom = new Date(snapshotAt.getTime() - 28 * 86_400_000);
    return prisma.$queryRaw<Array<NeedRow>>`
      with
      ${canonicalItemCostsCtes(snapshotAt)},
      warehouse_map as (
        select ref_key, max(nullif(magazin_key, '')) as magazin_key
        from ${warehouses}
        group by ref_key
      ),
      store_names as (
        select
          ref_key,
          max(description) as description,
          translate(
            max(coalesce(description, '')),
            'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ',
            'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'
          ) as normalized_description
        from ${stores}
        group by ref_key
      ),
      balance_snapshot as (
        select max(balance_period) as snapshot_at
        from ${balances}
        where balance_period <= ${snapshotAt}
      ),
      latest_balance_rows as (
        select
          b.nomenklatura_key,
          b.sklad_key,
          coalesce(b.kolichestvo_balance, 0)::float8 as qty
        from ${balances} b
        join balance_snapshot s on s.snapshot_at = b.balance_period
      ),
      stock as (
        select
          coalesce(w.magazin_key, 'Без магазина') as store_key,
          b.nomenklatura_key,
          sum(b.qty)::float8 as qty
        from latest_balance_rows b
        join warehouse_map w on w.ref_key = b.sklad_key
        group by 1, 2
      ),
      velocity as (
        select
          coalesce(nullif(c.magazin_key, ''), 'Без магазина') as store_key,
          l.nomenklatura_key,
          sum(
            case when lower(coalesce(c.vid_operatsii, '')) like '%возврат%'
              then -coalesce(l.kolichestvo, 0)
              else coalesce(l.kolichestvo, 0)
            end
          )::float8 as qty_28d
        from ${checks} c
        join ${checkLines} l on l."_parent_ref_key" = c.ref_key
        where c.deletion_mark is not true
          and c.posted = true
          and c.date >= ${velocityFrom}
          and c.date < ${snapshotAt}
          and l.nomenklatura_key is not null
        group by 1, 2
      ),
      ordered as (
        select
          d.ref_key as order_key,
          coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
          l.nomenklatura_key,
          sum(coalesce(l.kolichestvo, 0))::float8 as qty
        from ${orders} d
        join ${orderLines} l on l."_parent_ref_key" = d.ref_key
        where d.deletion_mark is not true
          and d.posted = true
          and d.zakryt is not true
          and d.date < ${snapshotAt}
        group by 1, 2, 3
      ),
      received as (
        select
          d.zakaz_postavschiku_key as order_key,
          l.nomenklatura_key,
          sum(coalesce(l.kolichestvo, 0))::float8 as qty
        from ${receipts} d
        join ${receiptLines} l on l."_parent_ref_key" = d.ref_key
        where d.deletion_mark is not true
          and d.posted = true
          and d.date < ${snapshotAt}
          and nullif(d.zakaz_postavschiku_key, '') is not null
        group by 1, 2
      ),
      open_orders as (
        select
          o.store_key,
          o.nomenklatura_key,
          sum(greatest(o.qty - coalesce(r.qty, 0), 0))::float8 as qty
        from ordered o
        left join received r
          on r.order_key = o.order_key
         and r.nomenklatura_key = o.nomenklatura_key
        group by 1, 2
      ),
      candidates as (
        select store_key, nomenklatura_key from stock
        union select store_key, nomenklatura_key from velocity
        union select store_key, nomenklatura_key from open_orders
      ),
      prepared as (
        select
          c.store_key,
          sn.description as store_name,
          c.nomenklatura_key,
          n.description as item_name,
          coalesce(s.qty, 0)::float8 as stock_qty,
          coalesce(o.qty, 0)::float8 as open_order_qty,
          coalesce(v.qty_28d, 0)::float8 as sales_qty_28d,
          case
            when sn.normalized_description like '%усол%' then n.normativnyy_zapas_usolka
            when sn.normalized_description like '%сатпа%' then n.normativnyy_zapas_satpaeva
            when sn.normalized_description like '%горьк%' then n.normativnyy_zapas_gorkogo
            when sn.normalized_description like '%шахт%' then n.normativnyy_zapas_karaganda_shahter
            when sn.normalized_description like '%пивзавод%' then n.normativnyy_zapas_karagandinskiy_pivzavod
            when sn.normalized_description like '%бухар%' then n.normativnyy_zapas_karaganda_buhar_zhyrau
            when sn.normalized_description like '%толст%' then n.normativnyy_zapas_tolstogo
            when sn.normalized_description like '%астан%' then n.normativnyy_zapas_astana
            when sn.normalized_description like '%мира 104%' then n.normativnyy_zapas_temirtau_mira104
            when sn.normalized_description like '%мира 86%' then n.normativnyy_zapas_temirtau_mira86
            else null
          end::float8 as target_stock,
          case
            when sn.normalized_description like '%астан%'
              then n.osnovnoy_postavschik_astana_key
            when sn.normalized_description like '%темиртау%'
              then n.osnovnoy_postavschik_temirtau_key
            when sn.normalized_description like '%караганд%'
              or sn.normalized_description like '%шахт%'
              or sn.normalized_description like '%бухар%'
              or sn.normalized_description like '%пивзавод%'
              then n.osnovnoy_postavschik_karaganda_key
            else n.osnovnoy_postavschik_pavlodar_key
          end as supplier_key
        from candidates c
        left join stock s using (store_key, nomenklatura_key)
        left join velocity v using (store_key, nomenklatura_key)
        left join open_orders o using (store_key, nomenklatura_key)
        left join store_names sn on sn.ref_key = c.store_key
        left join ${items} n on n.ref_key = c.nomenklatura_key
      ),
      supplier_names as (
        select ref_key, max(description) as description
        from ${suppliers}
        group by ref_key
      ),
      valued as (
        select
          p.*,
          sp.description as supplier_name,
          coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost) as unit_cost,
          greatest(
            p.target_stock - p.stock_qty - p.open_order_qty,
            0
          )::float8 as recommended_qty,
          greatest(
            p.target_stock + greatest(p.sales_qty_28d, 0) / 4.0
              - p.stock_qty - p.open_order_qty,
            0
          )::float8 as purchase_budget_qty
        from prepared p
        left join supplier_names sp on sp.ref_key = p.supplier_key
        left join latest_store_costs sc
          on sc.magazin_key = p.store_key and sc.nomenklatura_key = p.nomenklatura_key
        left join latest_global_costs gc on gc.nomenklatura_key = p.nomenklatura_key
        left join purchase_costs_90d pc on pc.nomenklatura_key = p.nomenklatura_key
        where coalesce(p.target_stock, 0) > 0
      )
      select
        store_key,
        store_name,
        nomenklatura_key,
        item_name,
        supplier_key,
        supplier_name,
        stock_qty,
        open_order_qty,
        target_stock,
        sales_qty_28d,
        (sales_qty_28d / 28.0)::float8 as daily_sales_qty,
        case when sales_qty_28d > 0
          then greatest(stock_qty, 0) / (sales_qty_28d / 28.0)
          else null
        end::float8 as days_of_stock,
        unit_cost::float8,
        recommended_qty,
        purchase_budget_qty,
        (recommended_qty * unit_cost)::float8 as recommended_amount,
        (purchase_budget_qty * unit_cost)::float8 as purchase_budget_amount
      from valued
      where purchase_budget_qty > 0
      order by
        case when sales_qty_28d > 0
          then greatest(stock_qty, 0) / (sales_qty_28d / 28.0)
          else 999999
        end,
        purchase_budget_qty desc
    `;
  };

  const actualOrderRowsPromise = prisma.$queryRaw<
    Array<{
      store_key: string;
      nomenklatura_key: string;
      ordered_qty: number | null;
      ordered_amount: number | null;
    }>
  >`
    select
      coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
      l.nomenklatura_key,
      sum(coalesce(l.kolichestvo, 0))::float8 as ordered_qty,
      sum(greatest(coalesce(l.summa, 0) - coalesce(l.summa_nds, 0), 0))::float8
        as ordered_amount
    from ${orders} d
    join ${orderLines} l on l."_parent_ref_key" = d.ref_key
    where d.deletion_mark is not true
      and d.posted = true
      and d.date >= ${executionFrom}
      and d.date < ${effectiveAsOf}
      and l.nomenklatura_key is not null
    group by 1, 2
  `;

  const [rows, executionNeeds, actualOrderRows] = await Promise.all([
    loadNeeds(effectiveAsOf),
    loadNeeds(executionFrom),
    actualOrderRowsPromise
  ]);

  const recommendations = rows.slice(0, params.limit).map((row) => ({
    storeKey: row.store_key,
    storeName: displayStoreName(row.store_name, row.store_key),
    itemKey: row.nomenklatura_key,
    itemName: row.item_name?.trim() || row.nomenklatura_key,
    supplierKey: row.supplier_key,
    supplierName: row.supplier_name,
    stockQty: Number(row.stock_qty ?? 0),
    openOrderQty: Number(row.open_order_qty ?? 0),
    targetStock: Number(row.target_stock ?? 0),
    salesQty28d: Number(row.sales_qty_28d ?? 0),
    dailySalesQty: Number(row.daily_sales_qty ?? 0),
    forecastQty7d: Math.max(Number(row.sales_qty_28d ?? 0), 0) / 4,
    daysOfStock:
      row.days_of_stock === null ? null : Number(row.days_of_stock),
    unitCost: row.unit_cost === null ? null : Number(row.unit_cost),
    recommendedQty: Number(row.recommended_qty ?? 0),
    recommendedAmount:
      row.recommended_amount === null ? null : Number(row.recommended_amount),
    purchaseBudgetQty: Number(row.purchase_budget_qty ?? 0),
    purchaseBudgetAmount:
      row.purchase_budget_amount === null
        ? null
        : Number(row.purchase_budget_amount)
  }));

  const budgetQty = rows.reduce(
    (sum, row) => sum + Number(row.purchase_budget_qty ?? 0),
    0
  );
  const budgetValuedQty = rows.reduce(
    (sum, row) =>
      sum + (row.unit_cost === null ? 0 : Number(row.purchase_budget_qty ?? 0)),
    0
  );
  const budgetCostCoveragePct =
    budgetQty > 0 ? (budgetValuedQty / budgetQty) * 100 : 100;
  const observedPurchaseBudgetAmount = rows.reduce(
    (sum, row) => sum + Number(row.purchase_budget_amount ?? 0),
    0
  );
  const executionBudgetQty = executionNeeds.reduce(
    (sum, row) => sum + Number(row.purchase_budget_qty ?? 0),
    0
  );
  const executionValuedQty = executionNeeds.reduce(
    (sum, row) =>
      sum + (row.unit_cost === null ? 0 : Number(row.purchase_budget_qty ?? 0)),
    0
  );
  const executionCostCoveragePct =
    executionBudgetQty > 0
      ? (executionValuedQty / executionBudgetQty) * 100
      : 100;
  const observedExecutionBudgetAmount = executionNeeds.reduce(
    (sum, row) => sum + Number(row.purchase_budget_amount ?? 0),
    0
  );
  const executionKeys = new Set(
    executionNeeds.map(
      (row) => `${row.store_key}\u0000${row.nomenklatura_key}`
    )
  );
  const orderedAmount = actualOrderRows.reduce(
    (sum, row) =>
      executionKeys.has(`${row.store_key}\u0000${row.nomenklatura_key}`)
        ? sum + Number(row.ordered_amount ?? 0)
        : sum,
    0
  );
  const executionReady =
    executionCostCoveragePct >= 90 && observedExecutionBudgetAmount > 0;
  const budgetReady = budgetCostCoveragePct >= 90;
  const recommendationRows = rows.filter(
    (row) => Number(row.recommended_qty ?? 0) > 0
  );

  return {
    summary: {
      recommendationCount: recommendationRows.length,
      recommendedQty: recommendationRows.reduce(
        (sum, row) => sum + Number(row.recommended_qty ?? 0),
        0
      ),
      recommendedAmount:
        budgetReady
          ? recommendationRows.reduce(
              (sum, row) => sum + Number(row.recommended_amount ?? 0),
              0
            )
          : null,
      recommendationsWithSupplier: recommendationRows.filter(
        (row) => row.supplier_key && row.supplier_name
      ).length,
      purchaseBudgetQty: budgetQty,
      purchaseBudgetAmount:
        budgetReady ? observedPurchaseBudgetAmount : null,
      observedPurchaseBudgetAmount,
      budgetCostCoveragePct,
      budgetStatus: budgetReady ? ("ready" as const) : ("partial" as const),
      executionBudgetAmount:
        executionReady ? observedExecutionBudgetAmount : null,
      orderedAmount,
      budgetExecutionPct:
        executionReady
          ? (orderedAmount / observedExecutionBudgetAmount) * 100
          : null,
      executionCostCoveragePct,
      executionStatus:
        executionReady ? ("ready" as const) : ("partial" as const),
      budgetSnapshotAt: effectiveAsOf.toISOString(),
      executionFrom: executionFrom.toISOString(),
      executionTo: effectiveAsOf.toISOString(),
      velocityWindowDays: 28,
      forecastDays: 7
    },
    recommendations,
    methodology:
      "Рекомендация = max(норматив − остаток − открытые заказы, 0). Недельный бюджет = max(норматив + прогноз продаж на 7 дней − остаток − открытые заказы, 0) × каноническая себестоимость. Исполнение сравнивает заказы последних 7 дней с бюджетом, рассчитанным по снимку на начало этого окна."
  };
}
