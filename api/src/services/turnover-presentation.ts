import type { TurnoverRow } from "./turnover-types.js";

export type TurnoverCatalogNode = { key: string; name: string; parent: string | null; folder: boolean };
type RootGroup = { key: string; name: string };
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

/** Resolve only complete folder chains; cached depth keeps the 64-parent bound order-independent. */
export function buildTurnoverRootGroups(items: ReadonlyMap<string, TurnoverCatalogNode>): Map<string, RootGroup | null> {
  const resolved = new Map<string, { root: RootGroup | null; depth: number }>();
  for (const start of items.values()) {
    if (resolved.has(start.key)) continue;
    const path: string[] = [];
    const seen = new Set<string>();
    let current = start;
    let root: RootGroup | null = null;
    let depth = 0;
    while (true) {
      const cached = resolved.get(current.key);
      if (cached) { root = cached.root; depth = cached.depth; break; }
      if (seen.has(current.key)) break;
      seen.add(current.key);
      path.push(current.key);
      const parent = current.parent;
      if (!parent || parent === EMPTY_GUID) {
        if (current.folder) root = { key: current.key, name: current.name.trim() ? current.name : "Группа без названия" };
        depth = -1;
        break;
      }
      const next = items.get(parent);
      if (!next?.folder) break;
      current = next;
    }
    for (let index = path.length - 1; index >= 0; index--) {
      depth++;
      resolved.set(path[index]!, { root: depth <= 64 ? root : null, depth });
    }
  }
  return new Map([...resolved].map(([key, value]) => [key, value.root]));
}

const collator = new Intl.Collator("ru", { sensitivity: "base", numeric: true });
type PresentationRow = Pick<TurnoverRow, "key" | "name" | "storeKey" | "storeName" | "rootGroupKey" | "rootGroupName">;

/** Stable identities keep homonymous stores/groups contiguous without merging them. */
export function compareTurnoverPresentationRows(a: PresentationRow, b: PresentationRow, splitStores: boolean): number {
  if (splitStores) {
    if (a.storeKey === null && b.storeKey !== null) return 1;
    if (b.storeKey === null && a.storeKey !== null) return -1;
    const store = collator.compare(a.storeName, b.storeName)
      || ((a.storeKey ?? "") < (b.storeKey ?? "") ? -1 : (a.storeKey ?? "") > (b.storeKey ?? "") ? 1 : 0);
    if (store) return store;
  }
  if (a.rootGroupKey === null && b.rootGroupKey !== null) return 1;
  if (b.rootGroupKey === null && a.rootGroupKey !== null) return -1;
  return collator.compare(a.rootGroupName, b.rootGroupName)
    || ((a.rootGroupKey ?? "") < (b.rootGroupKey ?? "") ? -1 : (a.rootGroupKey ?? "") > (b.rootGroupKey ?? "") ? 1 : 0)
    || collator.compare(a.name, b.name)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export type TurnoverStandardColumn =
  | { kind: "day"; date: string; index: number; half: boolean; label: string }
  | { kind: "weighted" | "average" | "coefficient" | "periodDays" | "sales" | "turnoverDays"; label: string };

export function turnoverStandardDates(from: string, to: string): string[] {
  const days: string[] = [];
  for (let date = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); date < end; date += 86_400_000) {
    days.push(new Date(date).toISOString().slice(0, 10));
  }
  return days;
}

/** All columns after nomenclature in the supplied standard workbook. */
export function turnoverStandardColumns(days: readonly string[]): TurnoverStandardColumn[] {
  const columns: TurnoverStandardColumn[] = [];
  for (let index = 0; index < days.length; index++) {
    const date = days[index]!;
    const label = `${date.slice(8, 10)}.${date.slice(5, 7)}.`;
    if (index === days.length - 1) columns.push({ kind: "day", date, index, half: true, label: `${label} / 2` });
    columns.push({ kind: "day", date, index, half: false, label });
    if (index === 0) columns.push({ kind: "day", date, index, half: true, label: `${label} / 2` });
  }
  columns.push(
    { kind: "weighted", label: "сумма остатков за период " },
    { kind: "average", label: "средний товарный запас в шт " },
    { kind: "coefficient", label: "Коэффицент оборачиваемости" },
    { kind: "periodDays", label: "количество дней в периоде " },
    { kind: "sales", label: "продажи в шт за период " },
    { kind: "turnoverDays", label: "количесто дней оборота в шт " }
  );
  return columns;
}

type StandardMetrics = Pick<TurnoverRow, "daily" | "averageQty" | "averageCost" | "periodSales" |
  "turnoverQty" | "turnoverCost" | "turnoverQtyDays" | "turnoverCostDays">;

/** Display the existing sample calculation, never aggregate displayed products. */
export function turnoverStandardValue(
  row: StandardMetrics, column: TurnoverStandardColumn, mode: "quantity" | "money", periodDays: number
): number | null {
  let value: number | null;
  if (column.kind === "day") {
    const day = row.daily[column.index];
    value = day?.date === column.date ? mode === "quantity" ? day.quantity : day.stockCost : null;
    if (value !== null && column.half) value /= 2;
  } else {
    switch (column.kind) {
      case "weighted": {
        const average = mode === "quantity" ? row.averageQty : row.averageCost;
        value = average === null ? null : average * (periodDays - 1);
        break;
      }
      case "average": value = mode === "quantity" ? row.averageQty : row.averageCost; break;
      case "coefficient": value = mode === "quantity" ? row.turnoverQty : row.turnoverCost; break;
      case "periodDays": value = periodDays; break;
      case "sales": value = mode === "quantity" ? row.periodSales.quantity : row.periodSales.cost; break;
      case "turnoverDays": value = mode === "quantity" ? row.turnoverQtyDays : row.turnoverCostDays; break;
    }
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
