import assert from "node:assert/strict";
import { test } from "node:test";
import { isExcludedTurnoverItem } from "../src/services/turnover-exclusions.js";

test("turnover excludes standalone plastic bottles, branded cups and branded майка items", () => {
  for (const name of [
    "Пластиковая бутылка 0.5",
    "Пластиковая бутылка 1л",
    "  ПЛАСТИКОВАЯ  БУТЫЛКА 1,5\u00a0л с крышкой  ",
    "Пластиковая бутылка 3л + ручка",
    "Двухслойный бумажный стакан КРАФТ 250 мл Фирменный ",
    "Двухслойный бумажный стакан КРАФТ 450 мл Фирменный",
    "Стакан пластик 375 мл Фирменный",
    "Стакан фирменный (шейкер) 0.5",
    "Стакан фирменный одноразовый 0.5",
    "Стакан фирменный со льдом и крышкой 0.7",
    "Майка фирменная",
    "Майка черная Налив",
    "Майка чёрная Налив"
  ]) {
    assert.equal(isExcludedTurnoverItem(name), true, name);
  }
});

test("turnover keeps ordinary packaging and products sold in or with bottles or cups", () => {
  for (const name of [
    "Майка большая",
    "Майка черная (16тг)",
    "Крафт пакет с лого двойной",
    "Стакан одноразовый 0.2",
    "Бар Стакан со льдом и крышкой шт.",
    "Держатель для стаканов КРАФТ",
    "Крафт пакет винный двойной",
    "Мороженое Золотой стандарт Стакан Клубника 85гр.",
    "Виски Jameson Irish Whiskey 40% 0.7 + 2 стакана",
    "Напиток Фирменный, пластиковая бутылка 1л",
    "Пластиковая бутылка 1л с лимонадом",
    "Стакан фирменный со льдом и крышкой 0.7 + виски",
    "Пиво розлив Фирменное Налив светлое 1л 4%",
    "Фирменные крышки"
  ]) {
    assert.equal(isExcludedTurnoverItem(name), false, name);
  }
});

test("turnover does not exclude items without a recognizable catalog name", () => {
  assert.equal(isExcludedTurnoverItem(null), false);
  assert.equal(isExcludedTurnoverItem(undefined), false);
});
