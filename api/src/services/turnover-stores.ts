export type StoreDirectoryEntry = { key: string; name: string };
export type PhysicalStore = {
  key: string;
  name: string;
  sourceKeys: string[];
  retailActive: boolean;
};
export type PhysicalStoreIndex = {
  stores: PhysicalStore[];
  bySource: Map<string, string>;
  byKey: Map<string, PhysicalStore>;
};

const ADDRESS = /[гГ]\.\s*(.+)$/u;

/** Legal-entity keys with the same exact address are one physical shop. */
export function physicalStoreIdentity(name: string, sourceKey = name): { key: string; name: string } {
  const match = name.match(ADDRESS);
  if (!match?.[1]?.trim()) return { key: `key:${sourceKey}`, name };
  const address = `г.${match[1].trim().replace(/\s+/g, " ")}`;
  return {
    key: `address:${address.toLocaleLowerCase("ru").replace(/\s+/g, " ").trim()}`,
    name: address
  };
}

export function buildPhysicalStoreIndex(
  entries: StoreDirectoryEntry[],
  activeSourceKeys: ReadonlySet<string>
): PhysicalStoreIndex {
  const groups = new Map<string, { name: string; sourceKeys: Set<string> }>();
  for (const entry of entries) {
    const identity = physicalStoreIdentity(entry.name, entry.key);
    const group = groups.get(identity.key);
    if (group) group.sourceKeys.add(entry.key);
    else groups.set(identity.key, { name: identity.name, sourceKeys: new Set([entry.key]) });
  }
  const stores = [...groups].map(([key, group]) => {
    const sourceKeys = [...group.sourceKeys].sort();
    return {
      key, name: group.name, sourceKeys,
      retailActive: sourceKeys.some((sourceKey) => activeSourceKeys.has(sourceKey))
    };
  }).sort((left, right) => left.name.localeCompare(right.name, "ru") || left.key.localeCompare(right.key));
  const bySource = new Map<string, string>();
  for (const store of stores) for (const sourceKey of store.sourceKeys) bySource.set(sourceKey, store.key);
  return { stores, bySource, byKey: new Map(stores.map((store) => [store.key, store])) };
}

export function isUsableWarehouse(name: string): boolean {
  return !/не\s*использовать/i.test(name);
}
