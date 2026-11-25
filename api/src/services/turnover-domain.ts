import type {
  TurnoverChange, TurnoverDailyRow, TurnoverMode, TurnoverNorms, TurnoverPreview, TurnoverRecommendation,
  TurnoverReport, TurnoverRequest, TurnoverRisk, TurnoverRow, TurnoverSales, TurnoverTotal, TurnoverTransfer
} from "./turnover-types.js";

export const TURNOVER_COEFFICIENT_THRESHOLDS = { poorStart: 0, mediumStart: 2, goodStart: 3 } as const;

export function turnoverCoefficientBand(value: number | null): "red" | "orange" | "green" | null {
  const { poorStart, mediumStart, goodStart } = TURNOVER_COEFFICIENT_THRESHOLDS;
  if (value === null || !Number.isFinite(value) || value < poorStart) return null;
  if (value < mediumStart) return "red";
  return value < goodStart ? "orange" : "green";
}

type CalculationRow = Pick<TurnoverRow,
  "unit" | "openingQty" | "closingQty" | "averageQty" | "openingCost" | "closingCost" | "averageCost" |
  "periodSales" | "turnoverQty" | "turnoverQtyDays" | "turnoverCost" | "turnoverCostDays"
> & { daily?: TurnoverDailyRow[] };

export function hasKnownTurnoverUnit(unit: string | null | undefined): unit is string {
  return Boolean(unit?.trim() && !/^(?:Единица не указана|n\/a|н\/д|__unknown__)/i.test(unit.trim()));
}

function finite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Display detail and optional catalogue identifiers never change calculability. */
export function isCompleteTurnoverRow(row: CalculationRow, mode: TurnoverMode = "both"): boolean {
  return (mode === "money" || (hasKnownTurnoverUnit(row.unit)
    && finite(row.openingQty) && finite(row.closingQty) && finite(row.averageQty)
    && finite(row.periodSales.quantity) && finite(row.periodSales.averageDailyQty)
    && finite(row.turnoverQty) && finite(row.turnoverQtyDays)))
    && (mode === "quantity" || (finite(row.openingCost) && finite(row.closingCost) && finite(row.averageCost)
      && finite(row.periodSales.cost) && finite(row.periodSales.revenue) && finite(row.periodSales.averageDailyCost)
      && finite(row.turnoverCost) && finite(row.turnoverCostDays)))
    && (!row.daily || row.daily.every(day => isCompleteTurnoverDailyRow(day, mode)));
}

type Layout = Pick<TurnoverRequest, "profile" | "groupBy" | "sort" | "mode">;

export function isStandardTurnoverLayout(params: Layout): boolean {
  return params.profile === "sample" || (params.profile === "summary" && (params.groupBy ?? "sku") === "sku" && params.sort === "name");
}

function populationMode(params: Layout): TurnoverMode {
  const mode = params.mode ?? "both";
  return mode === "both" && isStandardTurnoverLayout(params) ? "quantity" : mode;
}

export function includeTurnoverRow(row: CalculationRow & Pick<TurnoverRow, "idleStock">, params: Layout): boolean {
  return row.idleStock === true || isCompleteTurnoverRow(row, populationMode(params));
}

export function isCompleteTurnoverDailyRow(day: TurnoverDailyRow, mode: TurnoverMode = "both"): boolean {
  return (mode === "money" || (hasKnownTurnoverUnit(day.unit) && finite(day.quantity) && finite(day.salesQty)))
    && (mode === "quantity" || (finite(day.stockCost) && finite(day.salesCost) && finite(day.revenue)));
}

function unavailableTurnoverTotal(): TurnoverTotal {
  const sales: TurnoverSales = { quantity: null, cost: null, revenue: null, averageDailyQty: null, averageDailyCost: null };
  return {
    unit: null, daily: [], openingQty: null, closingQty: null, averageQty: null,
    openingCost: null, closingCost: null, averageCost: null, periodSales: sales, comparisonSales: sales,
    quantityChange: { pct: null, status: "missing" }, costChange: { pct: null, status: "missing" },
    turnoverQty: null, turnoverQtyDays: null, turnoverCost: null, turnoverCostDays: null, stockDays: null,
    excessQty: null, deficitQty: null, recommendedOrderQty: null, openOrderQty: null,
    stagnantCost: { d30: null, d60: null, d90: null }
  };
}

/**
 * Direct DTO consumers may not have the source atoms needed to recalculate totals.
 * Preserve authoritative totals when nothing is removed; otherwise withhold them,
 * never sum display rows or retain aggregates for the discarded population.
 */
export function completeTurnoverReport<T extends TurnoverReport | TurnoverPreview>(report: T): T {
  if (report.params.includeIncomplete || report.populationFiltered) return report;
  const mode = populationMode(report.params);
  const included = (row: CalculationRow & Pick<TurnoverRow, "idleStock">) => includeTurnoverRow(row, report.params);
  const rows = report.rows.every(included) ? report.rows : report.rows.filter(included);
  const daily = report.daily.every(day => isCompleteTurnoverDailyRow(day, mode))
    ? report.daily : report.daily.filter(day => isCompleteTurnoverDailyRow(day, mode));
  const excluded = report.rows.length - rows.length;
  if (!excluded && daily.length === report.daily.length) return report;
  const excludedIncompleteRows = (report.excludedIncompleteRows ?? 0) + excluded;
  return {
    ...report, rows, excludedIncompleteRows,
    // Aggregate daily and transfers cannot be attributed to the kept DTO rows.
    daily: excluded ? [] : daily, transfers: [], totals: { overall: unavailableTurnoverTotal(), byUnit: [], byStore: [] },
    summary: {
      ...report.summary, rowCount: report.params.groupBy === "day" ? daily.length : rows.length,
      totalRowCount: rows.length, skuCount: new Set(rows.map(row => row.sku).filter(Boolean)).size,
      stockCost: null, stockCostFromEntry: undefined, frozen30Cost: null, frozen60Cost: null, frozen90Cost: null, costCoveragePct: null
    },
    warnings: [...report.warnings,
      "Итоги исходной выборки не показаны: состав строк изменён, а атомарные данные для пересчёта отсутствуют.",
      "Пустые ячейки дополнительных расчётов означают, что показатель недоступен; неизвестные значения не заменены нулями."]
  } as T;
}

/** Half-weight endpoint samples; only positive stock represents time in stock. */
export function chronologicalStock<T>(values: readonly T[], amount: (value: T) => number | null) {
  let weighted = 0, time = 0;
  for (let index = 0; index < values.length; index++) {
    const stock = amount(values[index]!);
    if (!finite(stock)) return { weighted: null, average: null };
    if (stock <= 0) continue;
    const weight = values.length > 1 && (index === 0 || index === values.length - 1) ? 0.5 : 1;
    weighted += stock * weight;
    time += weight;
  }
  if (!values.length) return { weighted: null, average: null };
  if (Number.isFinite(weighted)) return { weighted, average: time ? weighted / time : 0 };
  // Divide first on overflow so a finite average remains usable.
  let average = 0;
  for (let index = 0; index < values.length; index++) {
    const stock = amount(values[index]!)!;
    if (stock > 0) average += stock * ((index === 0 || index === values.length - 1 ? 0.5 : 1) / time);
  }
  if (!Number.isFinite(average) && values.every(value => amount(value) === amount(values[0]!))) {
    average = amount(values[0]!)!;
  }
  return { weighted: null, average: Number.isFinite(average) ? average : null };
}

export function chronologicalAverage(values: readonly (number | null)[]): number | null {
  return chronologicalStock(values, value => value).average;
}

export function salesChange(current: number | null, previous: number | null): TurnoverChange {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) {
    return { pct: null, status: "missing" };
  }
  if (previous < 0) return { pct: null, status: "no-base" };
  if (previous === 0) return { pct: null, status: current > 0 ? "new" : "no-base" };
  let pct = (current - previous) / previous * 100;
  if (!Number.isFinite(pct)) pct = (current / previous - 1) * 100;
  return Number.isFinite(pct) ? { pct, status: "comparable" } : { pct: null, status: "missing" };
}

export function turnoverRatios(sales: number | null, average: number | null, days: number): {
  coefficient: number | null; days: number | null;
} {
  if (sales === null || average === null || !Number.isFinite(sales) || !Number.isFinite(average)
    || sales < 0 || average <= 0 || !Number.isFinite(days) || days <= 0) {
    return { coefficient: null, days: null };
  }
  const coefficient = sales / average;
  if (!Number.isFinite(coefficient) || (sales > 0 && coefficient === 0)) return { coefficient: null, days: null };
  const turnoverDays = coefficient > 0 ? days / coefficient : null;
  return { coefficient, days: turnoverDays !== null && Number.isFinite(turnoverDays) ? turnoverDays : null };
}

export function sumNullable(values: (number | null)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}

export function turnoverSales(quantity: number | null, cost: number | null, revenue: number | null, denominator: number): TurnoverSales {
  quantity = quantity !== null && Number.isFinite(quantity) ? quantity : null;
  cost = cost !== null && Number.isFinite(cost) ? cost : null;
  revenue = revenue !== null && Number.isFinite(revenue) ? revenue : null;
  return {
    quantity, cost, revenue,
    averageDailyQty: quantity === null ? null : quantity / Math.max(1, denominator),
    averageDailyCost: cost === null ? null : cost / Math.max(1, denominator)
  };
}

export type TurnoverRiskInput = {
  closingQty: number | null;
  closingCost: number | null;
  stockDays: number | null;
  periodQuantity: number | null;
  recentQuantity: number | null;
  sales14Quantity: number | null;
  dailyQuantity: number | null;
  change: TurnoverChange;
  availabilityComplete: boolean;
  daysWithoutMovement: number | null;
  noSalesHistory: boolean;
  stockAgeDays: number | null;
  openOrderQty: number | null;
  nextDeliveryDate: string | null;
  minimumStock: number | null;
  asOf: string;
};

export function evaluateTurnoverRisks(input: TurnoverRiskInput, norms: TurnoverNorms) {
  const risks: Exclude<TurnoverRisk, "all">[] = [];
  const recommendations: TurnoverRecommendation[] = [];
  const add = (code: string, action: string, reason: string) => recommendations.push({ code, action, reason });
  const stock = input.closingQty;
  const hasStock = stock !== null && stock > 0;
  // In the absence of any recorded sale, age is limited by actual observed
  // availability; the age of the store itself cannot age a newly introduced SKU.
  const idleDays = input.daysWithoutMovement ?? (input.noSalesHistory ? input.stockAgeDays : null);
  const stable = input.availabilityComplete && input.change.pct !== null && Math.abs(input.change.pct) <= norms.changePct;
  const falling = input.availabilityComplete && input.change.pct !== null && input.change.pct < -norms.changePct;
  const daily = input.dailyQuantity !== null && input.dailyQuantity >= 0 ? input.dailyQuantity : null;
  const target = daily === null ? null : Math.max(daily * Math.max(norms.targetDays, norms.leadTimeDays ?? 0), input.minimumStock ?? 0);
  const excessQty = stock === null || target === null || (daily === 0 && !input.availabilityComplete && input.minimumStock === null)
    ? null : Math.max(0, stock - target);
  const deficitQty = stock === null || target === null ? null : Math.max(0, target - stock);
  let recommendedOrderQty: number | null = stock === null || target === null || input.openOrderQty === null
    ? null : Math.max(0, target - stock - Math.max(0, input.openOrderQty));
  // A measured zero velocity can identify excess, but never creates a purchase
  // instruction solely to replenish a minimum without any observed demand.
  if (daily === 0 && recommendedOrderQty !== null) recommendedOrderQty = 0;

  if (input.periodQuantity === 0 || input.recentQuantity === 0) risks.push("no-sales");
  if (hasStock && idleDays !== null && idleDays >= norms.staleDays) {
    risks.push("stagnant");
    add("stale", "Проверить на неликвидность; приостановить автозаказ до проверки", `Остаток ${stock}; нет положительной продажи ${idleDays} дн. (норма ${norms.staleDays}).`);
  }
  if (hasStock && idleDays !== null && idleDays >= norms.criticalStaleDays) {
    add("critical-stale", "Рассмотреть перемещение, возврат поставщику или вывод из матрицы", `Нет положительной продажи ${idleDays} дн., порог ${norms.criticalStaleDays}.`);
  }
  if (stock !== null && daily !== null && excessQty !== null && excessQty > 0 && input.stockDays !== null && input.stockDays > norms.excessDays) {
    risks.push("overstock");
    if (stable) add("reduce-order", "Сократить объём следующего заказа", `Запас на ${input.stockDays.toFixed(1)} дн. превышает ${norms.excessDays}; продажи стабильны в пределах ±${norms.changePct}%.`);
  }
  if (input.stockDays !== null && input.stockDays > norms.stopDays && falling) {
    add("stop-purchase", "Приостановить закупку до анализа", `Запас ${input.stockDays.toFixed(1)} дн. > ${norms.stopDays}; продажи снизились на ${Math.abs(input.change.pct!).toFixed(1)}%.`);
    recommendedOrderQty = 0;
  }
  if (stock !== null && daily !== null && input.stockDays !== null && input.stockDays < norms.minDays) {
    risks.push("deficit");
    if (stable) add("urgent-order", "Проверить необходимость срочного заказа", `Запас ${input.stockDays.toFixed(1)} дн. ниже ${norms.minDays}; устойчивый спрос.`);
  }
  if (input.change.pct !== null && input.change.pct > norms.changePct) {
    add("demand-growth", "Проверить риск дефицита и возможность увеличить целевой запас", `Рост нетто-продаж ${input.change.pct.toFixed(1)}% > ${norms.changePct}%.`);
  }
  if (falling) add("demand-decline", "Проверить причины снижения спроса и пересмотреть закупку", `Продажи снизились на ${Math.abs(input.change.pct!).toFixed(1)}%; наличие в обоих окнах проверено.`);
  if (!input.availabilityComplete) {
    add("availability", "Проверить доступность товара до вывода о снижении спроса", "В сравниваемых окнах были нулевые остатки или отсутствуют обязательные снимки; падение продаж не доказывает падение спроса.");
  }
  if (hasStock && input.sales14Quantity === 0) {
    add("no-sales-14", "Проверить товар без продаж за 14 дней", "Нетто-продажи за последние 14 календарных дней равны нулю; срок запаса не рассчитывается.");
    if ((input.minimumStock !== null && stock > input.minimumStock) || (target !== null && stock > target)) {
      add("disable-auto-order", "Исключить из автозаказа до проверки", "За 14 дней нет продаж, остаток выше заданного норматива или целевого запаса.");
      recommendedOrderQty = 0;
    }
  }
  if (hasStock && idleDays !== null && idleDays >= norms.staleDays) recommendedOrderQty = 0;
  if (norms.highStockCost !== null && input.closingCost !== null && input.closingCost >= norms.highStockCost
    && ((input.stockDays !== null && input.stockDays > norms.excessDays) || (idleDays !== null && idleDays >= norms.staleDays)) && hasStock) {
    add("frozen-money", "Приоритетно проверить замораживание оборотных средств", `Стоимость ${input.closingCost.toFixed(2)} ≥ ${norms.highStockCost}; низкая скорость продаж или отсутствие движения.`);
  }
  if (stable && stock !== null && daily !== null && input.minimumStock !== null && stock < input.minimumStock) {
    if (!risks.includes("deficit")) risks.push("deficit");
    add("below-minimum", "Рассчитать заказ с учётом поставки и товара в пути", `Остаток ${stock} ниже норматива карточки ${input.minimumStock}; открытый заказ ${input.openOrderQty ?? "неизвестен"}.`);
  }
  if (recommendedOrderQty !== null && recommendedOrderQty > 0) {
    const lead = norms.leadTimeDays;
    const required = Math.max(daily! * Math.max(norms.targetDays, lead ?? 0), input.minimumStock ?? 0);
    recommendedOrderQty = Math.max(0, required - stock! - input.openOrderQty!);
    add("order", "Рекомендовать заказ (не автоматическое поручение)", `Цель max(${Math.max(norms.targetDays, lead ?? 0)} дн. × спрос ${daily!.toFixed(3)}/дн., минимум ${input.minimumStock ?? "не задан"}) − остаток ${stock} − открытые заказы ${input.openOrderQty} = ${recommendedOrderQty.toFixed(3)}.`);
    if (lead === null) add("lead-time-unknown", "Уточнить срок и график поставки", "Срок поставки не задан; количество рассчитано по редактируемому целевому запасу, срочность не подтверждена.");
  }
  if (input.openOrderQty !== null && input.openOrderQty > 0 && input.nextDeliveryDate !== null) {
    add("delivery", "Проверить ожидаемую поставку", `Ближайшая дата в открытых заказах: ${input.nextDeliveryDate}${input.nextDeliveryDate < input.asOf ? "; дата просрочена" : ""}.`);
    const waitDays = (Date.parse(`${input.nextDeliveryDate}T00:00:00Z`) - Date.parse(`${input.asOf}T00:00:00Z`)) / 86_400_000;
    if (waitDays < 0) add("delivery-overdue", "Уточнить просроченную поставку до нового заказа", `Открыто ${input.openOrderQty}; ожидаемая дата ${input.nextDeliveryDate} уже прошла.`);
    else if (input.stockDays !== null && input.stockDays < waitDays) {
      add("delivery-gap", "Ускорить поставку или проверить временное межфилиальное перемещение", `Запас на ${input.stockDays.toFixed(1)} дн., ближайшая поставка через ${waitDays} дн.; открытый заказ не устраняет промежуточный дефицит.`);
    }
  } else if (norms.leadTimeDays !== null && input.stockDays !== null && input.stockDays < norms.leadTimeDays) {
    add("delivery-gap", "Проверить поставку раньше обычного срока", `Запас ${input.stockDays.toFixed(1)} дн. меньше заданного срока поставки ${norms.leadTimeDays} дн.; подтверждённой даты открытой поставки нет.`);
  }
  if (input.noSalesHistory) add("no-history", "Проверить историю и дату ввода товара в ассортимент", "За всю доступную историю этого магазина положительных продаж SKU не найдено; возвраты не считаются продажей.");
  if (input.recentQuantity !== null && input.recentQuantity < 0) add("net-returns", "Проверить превышение возвратов над продажами", "Нетто-количество отрицательно; скорость спроса, срок запаса и заказ по нему не рассчитываются.");
  const frozen = (threshold: number): number | null => {
    if (stock === null) return null;
    if (!hasStock || (idleDays !== null && idleDays < threshold)) return 0;
    if (idleDays === null) return null;
    return input.closingCost;
  };
  return { risks, recommendations, excessQty, deficitQty, recommendedOrderQty,
    stagnantCost: { d30: frozen(30), d60: frozen(60), d90: frozen(90) } };
}

export function planTurnoverTransfers(rows: TurnoverRow[]): TurnoverTransfer[] {
  const groups = new Map<string, TurnoverRow[]>();
  for (const row of rows) {
    if (!row.sku || !row.storeKey || row.unit.startsWith("Единица не указана")) continue;
    const key = `${row.sku}\u0000${row.unit}`;
    const group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  const transfers: TurnoverTransfer[] = [];
  for (const group of groups.values()) {
    const donors = group.filter((row) => row.excessQty !== null && row.excessQty > 0 && row.closingQty !== null && row.closingQty > 0)
      .map((row) => ({ row, remaining: Math.min(row.excessQty!, row.closingQty!) }))
      .sort((a, b) => b.remaining - a.remaining || a.row.storeKey!.localeCompare(b.row.storeKey!));
    const recipients = group.filter((row) => row.deficitQty !== null && row.deficitQty > 0 && row.openOrderQty !== null)
      .map((row) => ({ row, remaining: Math.max(0, row.deficitQty! - Math.max(0, row.openOrderQty!)) }))
      .sort((a, b) => b.remaining - a.remaining || a.row.storeKey!.localeCompare(b.row.storeKey!));
    for (const recipient of recipients) {
      for (const donor of donors) {
        if (recipient.remaining <= 0) break;
        if (donor.remaining <= 0 || donor.row.storeKey === recipient.row.storeKey) continue;
        const quantity = Math.min(recipient.remaining, donor.remaining);
        recipient.remaining -= quantity;
        donor.remaining -= quantity;
        transfers.push({ sku: donor.row.sku!, name: donor.row.name, unit: donor.row.unit,
          fromStoreKey: donor.row.storeKey!, fromStoreName: donor.row.storeName,
          toStoreKey: recipient.row.storeKey!, toStoreName: recipient.row.storeName, quantity });
      }
    }
  }
  return transfers;
}
