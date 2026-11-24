import assert from "node:assert/strict";
import test from "node:test";
import { buildTurnoverRootGroups, compareTurnoverPresentationRows, turnoverStandardGrid, turnoverStandardValue, type TurnoverCatalogNode } from "../src/services/turnover-presentation.js";

const node = (key: string, name: string, parent: string | null, folder = true): TurnoverCatalogNode => ({ key, name, parent, folder });
const catalog = (...nodes: TurnoverCatalogNode[]) => new Map(nodes.map(item => [item.key, item]));

test("root folders rather than immediate subgroups or item.group define product sections", () => {
  const items = catalog(node("alcohol", "Алкоголь", null), node("vodka", "Водка", "alcohol"),
    node("wine", "Вино", "alcohol"), node("beer", "Пиво", "00000000-0000-0000-0000-000000000000"),
    { ...node("a", "Товар А", "vodka", false), group: "snacks" } as TurnoverCatalogNode,
    node("b", "Товар Б", "wine", false), node("c", "Товар В", "beer", false));
  const roots = buildTurnoverRootGroups(items);
  assert.deepEqual(roots.get("a"), { key: "alcohol", name: "Алкоголь" });
  assert.deepEqual(roots.get("b"), { key: "alcohol", name: "Алкоголь" });
  assert.deepEqual(roots.get("c"), { key: "beer", name: "Пиво" });
});

test("unresolved, non-folder and cyclic parent chains never become a guessed group", () => {
  const roots = buildTurnoverRootGroups(catalog(node("root", "Корень", ""),
    node("loose", "Без родителя", null, false), node("orphan", "Сирота", "absent", false),
    node("not-folder", "Товар", "root", false), node("child", "Ребёнок", "not-folder", false),
    node("cycle-a", "A", "cycle-b"), node("cycle-b", "Б", "cycle-a"), node("cyclic-sku", "SKU", "cycle-a", false)));
  for (const key of ["loose", "orphan", "child", "cycle-a", "cycle-b", "cyclic-sku"]) assert.equal(roots.get(key), null, key);
});

test("a chain deeper than 64 is unresolved regardless of catalog order or cached ancestors", () => {
  const nodes = [node("0", "Корень", null)];
  for (let depth = 1; depth <= 65; depth++) nodes.push(node(String(depth), `Узел ${depth}`, String(depth - 1)));
  for (const ordered of [nodes, [...nodes].reverse()]) {
    const roots = buildTurnoverRootGroups(catalog(...ordered));
    assert.deepEqual(roots.get("64"), { key: "0", name: "Корень" });
    assert.equal(roots.get("65"), null);
    assert.deepEqual(roots.get("1"), { key: "0", name: "Корень" });
  }
});

test("equal folder labels keep separate identities and an unnamed real folder remains known", () => {
  const roots = buildTurnoverRootGroups(catalog(node("one", "Без группы", null), node("two", "Без группы", null),
    node("empty", "  ", null), node("a", "A", "one", false), node("b", "Б", "two", false), node("c", "В", "empty", false)));
  assert.deepEqual(roots.get("a"), { key: "one", name: "Без группы" });
  assert.deepEqual(roots.get("b"), { key: "two", name: "Без группы" });
  assert.deepEqual(roots.get("c"), { key: "empty", name: "Группа без названия" });
});

test("presentation order is root then product А–Я, not the turnover coefficient", () => {
  const rows = [
    { key: "я", name: "Я", rootGroupKey: "alcohol", rootGroupName: "Алкоголь", storeKey: "s", storeName: "Магазин", turnoverQty: 1 },
    { key: "б", name: "Б", rootGroupKey: "alcohol", rootGroupName: "Алкоголь", storeKey: "s", storeName: "Магазин", turnoverQty: 0 },
    { key: "а", name: "А", rootGroupKey: "alcohol", rootGroupName: "Алкоголь", storeKey: "s", storeName: "Магазин", turnoverQty: 9 },
    { key: "unknown", name: "А", rootGroupKey: null, rootGroupName: "Без группы", storeKey: "s", storeName: "Магазин", turnoverQty: 2 },
    { key: "beer", name: "А", rootGroupKey: "beer", rootGroupName: "Пиво", storeKey: "s", storeName: "Магазин", turnoverQty: 3 }
  ];
  assert.deepEqual([...rows].sort((a, b) => compareTurnoverPresentationRows(a, b, false)).map(row => row.key), ["а", "б", "я", "beer", "unknown"]);
  assert.deepEqual([...rows].reverse().sort((a, b) => compareTurnoverPresentationRows(a, b, false)).map(row => row.key), ["а", "б", "я", "beer", "unknown"]);
});

test("store and group identities break equal labels deterministically and null scopes are last", () => {
  const rows = [
    { key: "b", name: "Товар 2", rootGroupKey: "g2", rootGroupName: "Без группы", storeKey: "s2", storeName: "А" },
    { key: "a", name: "Товар 10", rootGroupKey: "g1", rootGroupName: "Без группы", storeKey: "s1", storeName: "А" },
    { key: "c", name: "Товар 2", rootGroupKey: "g1", rootGroupName: "Без группы", storeKey: "s1", storeName: "А" },
    { key: "d", name: "А", rootGroupKey: null, rootGroupName: "Без группы", storeKey: "s1", storeName: "А" },
    { key: "e", name: "А", rootGroupKey: "g1", rootGroupName: "Без группы", storeKey: null, storeName: "А" },
    { key: "f", name: "А", rootGroupKey: "g1", rootGroupName: "Без группы", storeKey: "last", storeName: "Я" }
  ];
  const ordered = [...rows].sort((a, b) => compareTurnoverPresentationRows(a, b, true));
  assert.deepEqual(ordered.map(row => row.key), ["c", "a", "d", "b", "f", "e"]);
  assert.equal(ordered.length, rows.length);
  assert.deepEqual(new Set(ordered.map(row => row.key)), new Set(["a", "b", "c", "d", "e", "f"]));
  const ties = [rows[0]!, { ...rows[0]!, key: "B" }];
  assert.deepEqual(ties.sort((a, b) => compareTurnoverPresentationRows(a, b, true)).map(row => row.key), ["B", "b"]);
});

test("paired grid keeps endpoints, days and turnover calculations on their own bases", () => {
  const dates = ["2026-11-01", "2026-11-02", "2026-11-03"];
  const daily = dates.map((date, index) => ({ date, unit: "кг", quantity: [10, 20, 30][index]!,
    stockCost: [100, 300, 500][index]!, salesQty: 0, salesCost: 0, revenue: 0, weight: index === 1 ? 1 : .5 }));
  const row = { daily, averageQty: 20, averageCost: 300, turnoverQty: 2, turnoverCost: 3,
    turnoverQtyDays: 1.5, turnoverCostDays: 1,
    periodSales: { quantity: 40, cost: 900, revenue: 1800, averageDailyQty: 20, averageDailyCost: 450 } };
  const groups = turnoverStandardGrid(dates, "both");
  assert.deepEqual(groups.map(group => group.leaves.length), [4, 2, 4, 2, 2, 2, 1, 2, 2]);
  assert.deepEqual(groups.map(group => group.leaves.map(({ column, basis }) =>
    turnoverStandardValue(row, column, basis, dates.length))), [
    [10, 100, 5, 50], [20, 300], [15, 250, 30, 500], [40, 600], [20, 300], [2, 3], [3], [40, 900], [1.5, 1]
  ]);
  const partial = { ...row, daily: daily.map((d, i) => i === 1 ? { ...d, stockCost: null } : d) };
  assert.deepEqual(groups[3]!.leaves.map(({ column, basis }) => turnoverStandardValue(partial, column, basis, 3)), [40, null]);
});
