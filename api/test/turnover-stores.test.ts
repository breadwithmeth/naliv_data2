import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPhysicalStoreIndex, isUsableWarehouse, physicalStoreIdentity } from "../src/services/turnover-stores.js";

test("legal entities at the same exact address become one physical store", () => {
  const index = buildPhysicalStoreIndex([
    { key: "baZZa", name: "ИП BaZZa Logistics г.Караганда ул.Гоголя 57" },
    { key: "ansatov", name: "ИП Ансатов А. Н. г.Караганда ул.Гоголя 57" },
    { key: "other", name: "ИП Ансатов А. Н. г.Караганда ул.Шахтеров 52" },
    { key: "office", name: "Офис КРГ" }
  ], new Set(["baZZa"]));

  assert.equal(index.stores.length, 3);
  const merged = index.stores.find((store) => store.key === physicalStoreIdentity("ИП One г.Караганда ул.Гоголя 57").key)!;
  assert.equal(merged.name, "г.Караганда ул.Гоголя 57");
  assert.deepEqual(merged.sourceKeys, ["ansatov", "baZZa"]);
  assert.equal(merged.retailActive, true);
  assert.equal(index.bySource.get("ansatov"), merged.key);
  assert.equal(index.bySource.get("baZZa"), merged.key);
  assert.equal(index.byKey.get(merged.key), merged);
  assert.equal(index.stores.find((store) => store.sourceKeys.includes("office"))!.retailActive, false);
});

test("stores without a recognized address remain separate and warehouses with an explicit disable name are excluded", () => {
  const first = physicalStoreIdentity("Офис КРГ", "office-krg");
  const second = physicalStoreIdentity("Отдел IT", "office-it");
  assert.equal(first.key, "key:office-krg");
  assert.equal(second.key, "key:office-it");
  assert.equal(isUsableWarehouse("Склад Российская 4 СТО"), true);
  assert.equal(isUsableWarehouse("Караганда Пивоварня - не использовать"), false);
  assert.equal(isUsableWarehouse("Караганда НЕ ИСПОЛЬЗОВАТЬ"), false);
  assert.equal(isUsableWarehouse("Основной склад"), true);
});
