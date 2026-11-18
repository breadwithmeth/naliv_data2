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
