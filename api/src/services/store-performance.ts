import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { canonicalItemCostsCtes } from "../lib/cost-sql.js";
import {
  applicationTable,
  ensureManagementSettingsTables
} from "./management-settings.js";
import { prisma } from "../prisma.js";
import type { ManagementMetricParams } from "./management.js";

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(tableName: string) {
  return Prisma.raw(`${quoteIdent(config.PGSCHEMA)}.${quoteIdent(tableName)}`);
}

function displayStoreName(name: string | null, key: string) {
  if (name?.trim()) {
    return name;
  }
  return key === "Без магазина" ? key : `Магазин ${key}`;
}

/**
 * Store metrics that can be calculated from the sources already present in 1C.
 * All windows are half-open. Stock is valued at the same as-of cost at both
 * boundaries, so movement reflects quantity changes rather than cost revaluation.
 */
export async function getStorePerformanceMetrics(params: ManagementMetricParams) {
  const reports = qualifiedTable("document_otchet_o_roznichnyh_prodazhah");
  const saleLines = qualifiedTable("document_otchet_o_roznichnyh_prodazhah_tovary");
  const returnLines = qualifiedTable(
    "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary"
  );
  const balances = qualifiedTable("accumulation_register_tovary_na_skladah_balance");
  const warehouses = qualifiedTable("catalog_sklady");
  const stores = qualifiedTable("catalog_magaziny");
  const writeoffDocuments = qualifiedTable("document_spisanie_tovarov");
  const writeoffLines = qualifiedTable("document_spisanie_tovarov_tovary");
  const surplusDocuments = qualifiedTable("document_oprihodovanie_tovarov");
  const surplusLines = qualifiedTable("document_oprihodovanie_tovarov_tovary");
  const revisionDocuments = qualifiedTable("document_pereschet_tovarov");
  const revisionLines = qualifiedTable("document_pereschet_tovarov_tovary");

  const asOf = params.to ?? new Date();
  const from = params.from ?? new Date(asOf.getTime() - 28 * 86_400_000);
  await ensureManagementSettingsTables();
  const analysisDays = Math.max(
    1,
    Math.ceil((asOf.getTime() - from.getTime()) / 86_400_000)
  );

  const rows = await prisma.$queryRaw<
    Array<{
      store_key: string;
      store_name: string | null;
      active: boolean;
      revenue: number | null;
      cost: number | null;
      unvalued_revenue: number | null;
      writeoffs: number | null;
      surpluses: number | null;
      closing_stock_cost: number | null;
      opening_stock_cost: number | null;
      closing_unvalued_qty: number | null;
      frozen_stock_cost: number | null;
      stock_cost_coverage_pct: number | null;
      cogs_28d: number | null;
      average_stock_cost: number | null;
      stock_snapshot_days: bigint | number;
      frozen_snapshot_days: bigint | number;
      closing_snapshot_at: Date | null;
      opening_snapshot_at: Date | null;
    }>
  >`
    with
    ${canonicalItemCostsCtes(asOf)},
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
    period_movements as (
      select
        coalesce(nullif(r.magazin_key, ''), 'Без магазина') as store_key,
        l.nomenklatura_key,
        coalesce(l.kolichestvo, 0)::float8 as qty,
        coalesce(l.summa, 0)::float8 as revenue
      from ${reports} r
      join ${saleLines} l on l."_parent_ref_key" = r.ref_key
      where r.deletion_mark is not true and r.posted = true
        and r.date >= ${from} and r.date < ${asOf}
        and l.nomenklatura_key is not null
      union all
      select
        coalesce(nullif(r.magazin_key, ''), 'Без магазина') as store_key,
        l.nomenklatura_key,
        -coalesce(l.kolichestvo, 0)::float8 as qty,
        -coalesce(l.summa, 0)::float8 as revenue
      from ${reports} r
      join ${returnLines} l on l."_parent_ref_key" = r.ref_key
      where r.deletion_mark is not true and r.posted = true
        and r.date >= ${from} and r.date < ${asOf}
        and l.nomenklatura_key is not null
    ),
    period_profit as (
      select
        m.store_key,
        sum(m.revenue)::float8 as revenue,
        sum(m.qty * coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost, 0))::float8 as cost,
        sum(abs(m.revenue)) filter (
          where coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost) is null
        )::float8 as unvalued_revenue
      from period_movements m
      left join latest_store_costs sc
        on sc.magazin_key = m.store_key and sc.nomenklatura_key = m.nomenklatura_key
      left join latest_global_costs gc on gc.nomenklatura_key = m.nomenklatura_key
      left join purchase_costs_90d pc on pc.nomenklatura_key = m.nomenklatura_key
      group by m.store_key
    ),
    recent_movements as (
      select
        coalesce(nullif(r.magazin_key, ''), 'Без магазина') as store_key,
        l.nomenklatura_key,
        r.date::date as sale_day,
        coalesce(l.kolichestvo, 0)::float8 as qty
      from ${reports} r
      join ${saleLines} l on l."_parent_ref_key" = r.ref_key
      where r.deletion_mark is not true and r.posted = true
        and r.date >= (${asOf} - interval '28 days') and r.date < ${asOf}
        and l.nomenklatura_key is not null
      union all
      select
        coalesce(nullif(r.magazin_key, ''), 'Без магазина') as store_key,
        l.nomenklatura_key,
        r.date::date as sale_day,
        -coalesce(l.kolichestvo, 0)::float8 as qty
      from ${reports} r
      join ${returnLines} l on l."_parent_ref_key" = r.ref_key
      where r.deletion_mark is not true and r.posted = true
        and r.date >= (${asOf} - interval '28 days') and r.date < ${asOf}
        and l.nomenklatura_key is not null
    ),
    sales_28d as (
      select store_key, nomenklatura_key, sale_day, sum(qty)::float8 as qty
      from recent_movements
      group by store_key, nomenklatura_key, sale_day
    ),
    daily_stock as (
      select
        coalesce(w.magazin_key, 'Без магазина') as store_key,
        b.nomenklatura_key,
        b.balance_period as snapshot_at,
        sum(greatest(coalesce(b.kolichestvo_balance, 0), 0))::float8 as qty
      from ${balances} b
      join warehouse_map w on w.ref_key = b.sklad_key
      where b.balance_period >= least(${from}, ${asOf} - interval '28 days')
        and b.balance_period < ${asOf}
      group by 1, 2, 3
    ),
    stock_velocity as (
      select
        s.store_key,
        s.nomenklatura_key,
        count(*) filter (where s.qty > 0)::float8 as in_stock_days,
        coalesce(
          sum(greatest(coalesce(v.qty, 0), 0)) filter (where s.qty > 0),
          0
        )::float8 as sold_in_stock_qty
      from daily_stock s
      left join sales_28d v
        on v.store_key = s.store_key
       and v.nomenklatura_key = s.nomenklatura_key
       and v.sale_day = s.snapshot_at::date
      where s.snapshot_at >= (${asOf} - interval '28 days')
        and s.snapshot_at < ${asOf}
      group by s.store_key, s.nomenklatura_key
    ),
    daily_valued_stock as (
      select
        s.store_key,
        s.snapshot_at,
        sum(
          s.qty * coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost, 0)
        )::float8 as stock_cost
      from daily_stock s
      left join latest_store_costs sc
        on sc.magazin_key = s.store_key and sc.nomenklatura_key = s.nomenklatura_key
      left join latest_global_costs gc on gc.nomenklatura_key = s.nomenklatura_key
      left join purchase_costs_90d pc on pc.nomenklatura_key = s.nomenklatura_key
      where s.snapshot_at >= ${from}
        and s.snapshot_at < ${asOf}
        and s.qty > 0
      group by s.store_key, s.snapshot_at
    ),
    average_stock as (
      select
        store_key,
        avg(stock_cost)::float8 as average_stock_cost,
        count(distinct snapshot_at) as stock_snapshot_days
      from daily_valued_stock
      group by store_key
    ),
    snapshot_coverage as (
      select
        store_key,
        count(distinct snapshot_at) filter (
          where snapshot_at >= (${asOf} - interval '28 days')
            and snapshot_at < ${asOf}
        ) as frozen_snapshot_days
      from daily_stock
      group by store_key
    ),
    closing_snapshot as (
      select max(balance_period) as snapshot_at
      from ${balances}
      where balance_period is not null and balance_period <= ${asOf}
    ),
    closing_balance_rows as (
      select
        b.nomenklatura_key,
        b.sklad_key,
        b.balance_period,
        coalesce(b.kolichestvo_balance, 0)::float8 as qty
      from ${balances} b
      join closing_snapshot s on s.snapshot_at = b.balance_period
    ),
    opening_snapshot as (
      select max(balance_period) as snapshot_at
      from ${balances}
      where balance_period is not null and balance_period <= ${from}
    ),
    opening_balance_rows as (
      select
        b.nomenklatura_key,
        b.sklad_key,
        b.balance_period,
        coalesce(b.kolichestvo_balance, 0)::float8 as qty
      from ${balances} b
      join opening_snapshot s on s.snapshot_at = b.balance_period
    ),
    closing_stock as (
      select
        coalesce(w.magazin_key, 'Без магазина') as store_key,
        b.nomenklatura_key,
        sum(greatest(b.qty, 0))::float8 as qty,
        max(b.balance_period) as snapshot_at
      from closing_balance_rows b
      join warehouse_map w on w.ref_key = b.sklad_key
      group by 1, 2
    ),
    opening_stock as (
      select
        coalesce(w.magazin_key, 'Без магазина') as store_key,
        b.nomenklatura_key,
        sum(greatest(b.qty, 0))::float8 as qty,
        max(b.balance_period) as snapshot_at
      from opening_balance_rows b
      join warehouse_map w on w.ref_key = b.sklad_key
      group by 1, 2
    ),
    closing_valued as (
      select
        s.store_key,
        s.nomenklatura_key,
        s.qty,
        s.snapshot_at,
        coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost) as unit_cost,
        case when coalesce(v.in_stock_days, 0) > 0 then
          greatest(
            s.qty - greatest(coalesce(v.sold_in_stock_qty, 0), 0)
              / v.in_stock_days * 30.0,
            0
          )
        end::float8 as frozen_qty,
        (
          greatest(coalesce(s28.qty, 0), 0)
          * coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost, 0)
        )::float8 as cogs_28d
      from closing_stock s
      left join stock_velocity v
        on v.store_key = s.store_key and v.nomenklatura_key = s.nomenklatura_key
      left join (
        select store_key, nomenklatura_key, sum(qty)::float8 as qty
        from sales_28d
        group by store_key, nomenklatura_key
      ) s28 on s28.store_key = s.store_key
        and s28.nomenklatura_key = s.nomenklatura_key
      left join latest_store_costs sc
        on sc.magazin_key = s.store_key and sc.nomenklatura_key = s.nomenklatura_key
      left join latest_global_costs gc on gc.nomenklatura_key = s.nomenklatura_key
      left join purchase_costs_90d pc on pc.nomenklatura_key = s.nomenklatura_key
      where s.qty > 0
    ),
    closing_totals as (
      select
        store_key,
        sum(qty * coalesce(unit_cost, 0))::float8 as stock_cost,
        sum(qty) filter (where unit_cost is null)::float8 as unvalued_qty,
        sum(frozen_qty * coalesce(unit_cost, 0))::float8 as frozen_stock_cost,
        sum(cogs_28d)::float8 as cogs_28d,
        count(*) filter (where unit_cost is not null)::float8
          / nullif(count(*), 0) * 100 as cost_coverage_pct,
        max(snapshot_at) as snapshot_at
      from closing_valued
      group by store_key
    ),
    opening_totals as (
      select
        s.store_key,
        sum(s.qty * coalesce(sc.unit_cost, gc.unit_cost, pc.unit_cost, 0))::float8 as stock_cost,
        max(s.snapshot_at) as snapshot_at
      from opening_stock s
      left join latest_store_costs sc
        on sc.magazin_key = s.store_key and sc.nomenklatura_key = s.nomenklatura_key
      left join latest_global_costs gc on gc.nomenklatura_key = s.nomenklatura_key
      left join purchase_costs_90d pc on pc.nomenklatura_key = s.nomenklatura_key
      where s.qty > 0
      group by s.store_key
    ),
    latest_revision_lines as (
      select distinct on (d.ref_key, l.nomenklatura_key)
        coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
        d.ref_key,
        l.nomenklatura_key,
        (
          l.summa_fakt
          - coalesce(l.summa, 0)
        )::float8 as difference
      from ${revisionDocuments} d
      join ${revisionLines} l on l."_parent_ref_key" = d.ref_key
      where d.deletion_mark is not true and d.posted = true
        and d.date >= ${from} and d.date < ${asOf}
        and d.uchetnye_dannye_zapolneny is true
        and l.summa_fakt is not null
      order by d.ref_key, l.nomenklatura_key, l.line_number desc
    ),
    loss_totals as (
      select
        store_key,
        sum(writeoffs)::float8 as writeoffs,
        sum(surpluses)::float8 as surpluses
      from (
        select coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
          sum(coalesce(l.summa, 0))::float8 as writeoffs, 0::float8 as surpluses
        from ${writeoffDocuments} d
        join ${writeoffLines} l on l."_parent_ref_key" = d.ref_key
        where d.deletion_mark is not true and d.posted = true
          and d.date >= ${from} and d.date < ${asOf}
        group by 1
        union all
        select coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
          0::float8 as writeoffs, sum(coalesce(l.summa, 0))::float8 as surpluses
        from ${surplusDocuments} d
        join ${surplusLines} l on l."_parent_ref_key" = d.ref_key
        where d.deletion_mark is not true and d.posted = true
          and d.date >= ${from} and d.date < ${asOf}
        group by 1
        union all
        select store_key,
          sum(-difference) filter (where difference < 0)::float8 as writeoffs,
          sum(difference) filter (where difference > 0)::float8 as surpluses
        from latest_revision_lines
        group by store_key
      ) movements
      group by store_key
    ),
    active_stores as (
      select distinct coalesce(nullif(r.magazin_key, ''), 'Без магазина') as store_key
      from ${reports} r
      where r.deletion_mark is not true and r.posted = true
        and r.date >= (${asOf} - interval '90 days') and r.date < ${asOf}
    ),
    store_keys as (
      select store_key from period_profit
      union select store_key from closing_totals
      union select store_key from opening_totals
      union select store_key from loss_totals
    )
    select
      k.store_key,
      coalesce(cfg.display_name, n.description) as store_name,
      coalesce(cfg.active, a.store_key is not null) as active,
      coalesce(p.revenue, 0)::float8 as revenue,
      coalesce(p.cost, 0)::float8 as cost,
      coalesce(p.unvalued_revenue, 0)::float8 as unvalued_revenue,
      coalesce(l.writeoffs, 0)::float8 as writeoffs,
      coalesce(l.surpluses, 0)::float8 as surpluses,
      coalesce(c.stock_cost, 0)::float8 as closing_stock_cost,
      o.stock_cost::float8 as opening_stock_cost,
      coalesce(c.unvalued_qty, 0)::float8 as closing_unvalued_qty,
      c.frozen_stock_cost::float8 as frozen_stock_cost,
      coalesce(c.cost_coverage_pct, 100)::float8 as stock_cost_coverage_pct,
      coalesce(c.cogs_28d, 0)::float8 as cogs_28d,
      av.average_stock_cost::float8 as average_stock_cost,
      coalesce(av.stock_snapshot_days, 0) as stock_snapshot_days,
      coalesce(cv.frozen_snapshot_days, 0) as frozen_snapshot_days,
      c.snapshot_at as closing_snapshot_at,
      o.snapshot_at as opening_snapshot_at
    from store_keys k
    left join store_names n on n.ref_key = k.store_key
    left join active_stores a on a.store_key = k.store_key
    left join ${applicationTable("naliv_store_settings")} cfg on cfg.store_key = k.store_key
    left join period_profit p on p.store_key = k.store_key
    left join loss_totals l on l.store_key = k.store_key
    left join closing_totals c on c.store_key = k.store_key
    left join opening_totals o on o.store_key = k.store_key
    left join average_stock av on av.store_key = k.store_key
    left join snapshot_coverage cv on cv.store_key = k.store_key
    order by active desc, revenue desc
  `;

  const storesResult = rows.map((row) => {
    const revenue = Number(row.revenue ?? 0);
    const cost = Number(row.cost ?? 0);
    const writeoffs = Number(row.writeoffs ?? 0);
    const surpluses = Number(row.surpluses ?? 0);
    const losses = writeoffs - surpluses;
    const grossProfitAfterLoss = revenue - cost - losses;
    const closingStockCost = Number(row.closing_stock_cost ?? 0);
    const openingStockCost =
      row.opening_stock_cost === null ? null : Number(row.opening_stock_cost);
    const averageStockCost =
      row.average_stock_cost === null ? null : Number(row.average_stock_cost);
    const stockSnapshotCoveragePct = Math.min(
      100,
      (Number(row.stock_snapshot_days) / analysisDays) * 100
    );
    const frozenSnapshotCoveragePct = Math.min(
      100,
      (Number(row.frozen_snapshot_days) / 28) * 100
    );
    const cogs28d = Number(row.cogs_28d ?? 0);
    const frozenStockCost =
      row.frozen_stock_cost === null ? null : Number(row.frozen_stock_cost);

    return {
      storeKey: row.store_key,
      storeName: displayStoreName(row.store_name, row.store_key),
      active: row.active,
      revenue,
      cost,
      unvaluedRevenue: Number(row.unvalued_revenue ?? 0),
      costCoveragePct:
        revenue !== 0
          ? Math.max(0, ((Math.abs(revenue) - Number(row.unvalued_revenue ?? 0)) / Math.abs(revenue)) * 100)
          : 100,
      writeoffs,
      surpluses,
      losses,
      grossProfitAfterLoss,
      marginAfterLossPct: revenue > 0 ? (grossProfitAfterLoss / revenue) * 100 : null,
      closingStockCost,
      openingStockCost,
      stockMovement: openingStockCost === null ? null : closingStockCost - openingStockCost,
      closingUnvaluedQty: Number(row.closing_unvalued_qty ?? 0),
      stockCostCoveragePct: Number(row.stock_cost_coverage_pct ?? 100),
      daysOfStock: cogs28d > 0 ? (closingStockCost / cogs28d) * 28 : null,
      frozenStockCost,
      frozenStockPct:
        frozenStockCost !== null && closingStockCost > 0
          ? (frozenStockCost / closingStockCost) * 100
          : null,
      averageStockCost,
      stockSnapshotCoveragePct,
      frozenSnapshotCoveragePct,
      gmroi:
        stockSnapshotCoveragePct >= 90
          && averageStockCost !== null
          && averageStockCost > 0
          ? (grossProfitAfterLoss * (365 / analysisDays)) / averageStockCost
          : null,
      closingSnapshotAt: row.closing_snapshot_at?.toISOString() ?? null,
      openingSnapshotAt: row.opening_snapshot_at?.toISOString() ?? null
    };
  });

  const activeStores = storesResult.filter((store) => store.active);
  const summaryBase = activeStores.reduce(
    (acc, store) => {
      acc.revenue += store.revenue;
      acc.cost += store.cost;
      acc.losses += store.losses;
      acc.grossProfitAfterLoss += store.grossProfitAfterLoss;
      acc.closingStockCost += store.closingStockCost;
      if (store.frozenStockCost !== null) {
        acc.frozenStockCost += store.frozenStockCost;
      }
      if (store.averageStockCost !== null) {
        acc.averageStockCost += store.averageStockCost;
      }
      acc.unvaluedRevenue += store.unvaluedRevenue;
      acc.closingUnvaluedQty += store.closingUnvaluedQty;
      if (store.openingStockCost !== null) {
        acc.openingStockCost += store.openingStockCost;
        acc.storesWithOpening += 1;
      }
      return acc;
    },
    {
      revenue: 0,
      cost: 0,
      losses: 0,
      grossProfitAfterLoss: 0,
      closingStockCost: 0,
      openingStockCost: 0,
      frozenStockCost: 0,
      averageStockCost: 0,
      unvaluedRevenue: 0,
      closingUnvaluedQty: 0,
      storesWithOpening: 0
    }
  );
  const stockMetricStores = activeStores.filter(
    (store) =>
      Math.abs(store.revenue) > 0
      || store.closingStockCost > 0
      || store.averageStockCost !== null
  );
  const frozenMetricStores = activeStores.filter(
    (store) => store.closingStockCost > 0
  );
  const stockSnapshotCoveragePct =
    stockMetricStores.length > 0
      ? Math.min(
          ...stockMetricStores.map((store) => store.stockSnapshotCoveragePct)
        )
      : 100;
  const frozenSnapshotCoveragePct =
    frozenMetricStores.length > 0
      ? Math.min(
          ...frozenMetricStores.map((store) => store.frozenSnapshotCoveragePct)
        )
      : 100;
  const averageNetworkStock =
    stockSnapshotCoveragePct >= 90
      && stockMetricStores.length > 0
      && stockMetricStores.every((store) => store.averageStockCost !== null)
      ? stockMetricStores.reduce(
          (sum, store) => sum + Number(store.averageStockCost),
          0
        )
      : null;
  const gmroiProfit = stockMetricStores.reduce(
    (sum, store) => sum + store.grossProfitAfterLoss,
    0
  );
  const frozenStockCost =
    frozenSnapshotCoveragePct >= 90
      && frozenMetricStores.every((store) => store.frozenStockCost !== null)
      ? frozenMetricStores.reduce(
          (sum, store) => sum + Number(store.frozenStockCost),
          0
        )
      : null;

  return {
    summary: {
      activeStoreCount: activeStores.length,
      revenue: summaryBase.revenue,
      cost: summaryBase.cost,
      losses: summaryBase.losses,
      grossProfitAfterLoss: summaryBase.grossProfitAfterLoss,
      marginAfterLossPct:
        summaryBase.revenue > 0
          ? (summaryBase.grossProfitAfterLoss / summaryBase.revenue) * 100
          : null,
      closingStockCost: summaryBase.closingStockCost,
      stockMovement:
        summaryBase.storesWithOpening === activeStores.length && activeStores.length > 0
          ? summaryBase.closingStockCost - summaryBase.openingStockCost
          : null,
      frozenStockCost,
      frozenStockPct:
        frozenStockCost !== null && summaryBase.closingStockCost > 0
          ? (frozenStockCost / summaryBase.closingStockCost) * 100
          : null,
      frozenSnapshotCoveragePct,
      stockSnapshotCoveragePct,
      gmroi:
        averageNetworkStock !== null && averageNetworkStock > 0
          ? (gmroiProfit * (365 / analysisDays)) / averageNetworkStock
          : null,
      unvaluedRevenue: summaryBase.unvaluedRevenue,
      closingUnvaluedQty: summaryBase.closingUnvaluedQty,
      openingCoveragePct:
        activeStores.length > 0 ? (summaryBase.storesWithOpening / activeStores.length) * 100 : 100
    },
    stores: storesResult.slice(0, params.limit),
    methodology: {
      analysisDays,
      stockDaysWindow: 28,
      frozenStockTargetDays: 30,
      activeStoreWindowDays: 90,
      frozenStockStatus:
        frozenSnapshotCoveragePct >= 90 ? ("ready" as const) : ("partial" as const),
      frozenStockLimitation:
        "Скорость учитывает только дни с положительным дневным остатком. Значение публикуется при покрытии окна снимками не ниже 90%.",
      lossSources:
        "Списания и недостачи ревизий минус оприходования и излишки ревизий."
    }
  };
}
