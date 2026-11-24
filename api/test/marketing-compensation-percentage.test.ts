import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCompensationTitlePercentage } from "../src/services/marketing-compensation-percentage.js";

test("activity title extracts one standalone exact percentage, not the year or a rule prefix", () => {
  for (const [title, expected] of [
    ["иртыш сауда пвл ноябрь 2026 26%", "26"],
    ["Программа 2026 100%", "100"],
    ["Возмещение 18,57\u00a0% за ноябрь 2026", "18.57"],
    ["Акция (10.5%); повтор 10,50%", "10.5"],
    ["Акция — 0%", "0"],
    ["100%: вся сумма", "100"],
    ["2.000000000000000001%", "2.000000000000000001"]
  ] as const) {
    const result = parseCompensationTitlePercentage(title);
    assert.equal(result.rate?.toString(), expected, title);
    assert.equal(result.issue, null, title);
  }
});

test("activity title cannot turn invalid or signed percentages into valid tails", () => {
  for (const title of [null, "", "Акция 2026", "101%", "100.01%", "-5%", "+5%", "−5%", "+ 5%", "± 5%", "∓5%", "＋5%", "－5%", "— 5%",
    "1.2.3%", ".5%", "1e2%", "SKU5%", "5%без пробела", "NaN%", "Акция 25% / 101%",
    "Акция 1\u202f050%", "Акция 1 000,1%", "1\u00a0000 025%"]) {
    const result = parseCompensationTitlePercentage(title);
    assert.equal(result.rate, null, String(title));
    assert.equal(result.issue, "missing_percentage", String(title));
  }
});

test("activity title with different percentages or a range cannot set a rate", () => {
  for (const title of ["Акция 10% и 20%", "10,5% и 10.51%", "10–20%", "10 - 20%", "10% – 20%", "10%—20", "10–10%",
    "Акция от 10 до 20%", "ОТ 10,5 % ДО 20", "10 по 20%"]) {
    const result = parseCompensationTitlePercentage(title);
    assert.equal(result.rate, null, title);
    assert.equal(result.issue, "conflicting_percentage", title);
  }
});
