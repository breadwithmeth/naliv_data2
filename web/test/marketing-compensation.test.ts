import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompensationResults } from "../src/MarketingCompensation";
import type {
  CompensationActivity, CompensationBranch, CompensationRow, CompensationTotals, MarketingCompensationReport
} from "../src/api";

function totals(compensation: number | null, knownCompensation = compensation ?? 0, incompleteRows = 0): CompensationTotals {
  return { compensation, knownCompensation, incompleteRows };
}

function row(overrides: Partial<CompensationRow> = {}): CompensationRow {
  return {
    itemKey: "product-1", characteristicKey: "characteristic-1", name: "Товар с разными ценами",
    barcode: "0012345678901", price: 100, discountPct: 20, unitCompensation: 20,
    quantity: 10, compensation: 200, from: "2026-11-01", to: "2026-11-04", issues: [],
    ...overrides
  };
}

function branch(overrides: Partial<CompensationBranch> = {}): CompensationBranch {
  return {
    key: "store-1", name: "Магазин с продажами", rows: [row()], hasSales: true, hasReturns: false,
    totals: totals(200), issues: [], ...overrides
  };
}

function activity(key: string, name: string, overrides: Partial<CompensationActivity> = {}): CompensationActivity {
  return {
    key, name, number: "private-document-17", startsOn: "2026-10-01", endsOn: "2026-11-30",
    from: "2026-11-01", to: "2026-11-04", branches: [branch()], totals: totals(200), issues: [],
    ...overrides
  };
}

function inactiveActivity(): CompensationActivity {
  return activity("inactive", "Пустая акция", {
    branches: [branch({ key: "empty-store", name: "Пустой магазин", rows: [], hasSales: false, totals: totals(0) })],
    totals: totals(0)
  });
}

function report(activities: CompensationActivity[] = [activity("sales", "Акция с продажами"), inactiveActivity()]): MarketingCompensationReport {
  return {
    from: "2026-11-01", to: "2026-11-04", activityKey: null, activities,
    // Server totals deliberately differ from fixture rows: presentation must not aggregate money.
    totals: totals(987.65), issues: []
  };
}

function render(data: MarketingCompensationReport, showInactive = false): string {
  return renderToStaticMarkup(createElement(CompensationResults, { report: data, showInactive }));
}

function overall(html: string): string {
  const match = html.match(/<section[^>]*aria-label="Общий итог компенсаций"[^>]*>([\s\S]*?)<\/section>/);
  assert.ok(match, "overall compensation summary is available");
  return match[1];
}

test("inactive activities are omitted by default and returned by the local visibility option", () => {
  const data = report();
  const compact = render(data);
  assert.match(compact, /Акция с продажами/);
  assert.doesNotMatch(compact, /Пустая акция/);
  assert.match(render(data, true), /Пустая акция/);
  assert.match(overall(compact), /987,65\s*₸/);
  assert.doesNotMatch(overall(compact), /200,00/);
});

test("an explicitly selected inactive activity stays visible with an honest empty message", () => {
  const data = report([inactiveActivity()]);
  data.activityKey = "inactive";
  data.totals = totals(0);
  const html = render(data);
  assert.match(html, /Пустая акция/);
  assert.match(html, /За выбранный период продаж и возвратов не было/);
  assert.doesNotMatch(html, /Нужна проверка|role="alert"/);
});

test("all safely inactive activities yield an empty result rather than an error", () => {
  const data = report([inactiveActivity()]);
  data.totals = totals(0);
  const html = render(data);
  assert.match(html, /За выбранный период продаж и возвратов не было/);
  assert.doesNotMatch(html, /Пустая акция|role="alert"|Не удалось/);
  assert.match(overall(html), /0,00\s*₸/);
});

test("known compensation is never presented as the full total when calculation is incomplete", () => {
  const data = report([activity("unknown", "Акция без полного расчёта", {
    totals: totals(200, 73.25, 2)
  })]);
  data.totals = totals(987.65, 73.25, 2);
  const html = render(data);
  const summary = overall(html);
  assert.match(summary, /Расчёт неполный/);
  assert.match(summary, /Итого компенсация<\/dt><dd>Не рассчитано/);
  assert.match(summary, /Рассчитанная часть/);
  assert.match(summary, /73,25\s*₸/);
  assert.match(summary, /Строк без расчёта: 2/);
  assert.doesNotMatch(summary, /987,65/);
  assert.match(html, /Акция без полного расчёта/);
});

test("unknown scopes and unresolved quantity rows are retained despite false movement flags", () => {
  const data = report([
    activity("no-branches", "Неопределённые магазины", { branches: [], totals: totals(null) }),
    activity("null-quantity", "Неизвестное количество", {
      branches: [branch({ rows: [row({ quantity: null, compensation: null })], hasSales: false, totals: totals(null, 0, 1) })],
      totals: totals(null, 0, 1)
    }),
    activity("scope-issue", "Непроверенный охват", {
      branches: inactiveActivity().branches, totals: totals(0),
      issues: [{ code: "coverage", message: "Проверьте доступность отчёта источника." }]
    })
  ]);
  data.totals = totals(null, 0, 1);
  data.issues = [{ code: "report-check", message: "Общее ограничение источника сохраняется." }];
  const html = render(data);
  for (const name of ["Неопределённые магазины", "Неизвестное количество", "Непроверенный охват"]) {
    assert.ok(html.includes(name), `${name} remains available`);
  }
  assert.match(html, /Общее ограничение источника сохраняется/);
  assert.match(html, /Нужна проверка/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|>)/);
});

test("zero compensation sales, fully returned sales and return-only adjustments are not hidden", () => {
  const data = report([
    activity("zero-price", "Продажа с нулевой компенсацией", { totals: totals(0) }),
    activity("net-zero", "Продажа и полный возврат", {
      branches: [branch({ hasReturns: true, rows: [row({ quantity: 0, compensation: 0 })], totals: totals(0) })],
      totals: totals(0)
    }),
    activity("returns", "Возвратная акция", {
      branches: [branch({ hasSales: false, hasReturns: true, rows: [row({ quantity: -4, compensation: -80 })], totals: totals(-80) })],
      totals: totals(-80)
    })
  ]);
  const html = render(data);
  for (const name of ["Продажа с нулевой компенсацией", "Продажа и полный возврат", "Возвратная акция"]) {
    assert.ok(html.includes(name), `${name} remains available`);
  }
  assert.match(html, /Только возвраты \/ корректировки/);
  assert.match(html, /-80,00\s*₸/);
});

test("incomplete status takes priority over the return-only label", () => {
  const data = report([activity("returns", "Неполный возврат", {
    branches: [branch({ hasSales: false, hasReturns: true, totals: totals(null, -80, 1) })],
    totals: totals(null, -80, 1)
  })]);
  data.totals = totals(null, -80, 1);
  const html = render(data);
  assert.match(html, /Нужна проверка/);
  assert.match(html, /Рассчитанная часть/);
  assert.doesNotMatch(html, /Только возвраты \/ корректировки/);
});

test("activity stores and product calculation are closed initially and technical identifiers stay off the first screen", () => {
  const data = report([activity("sales", "Компактная акция", {
    branches: [branch({ rows: [row(), row({ price: 125, unitCompensation: 25, compensation: 250 })] })]
  })]);
  const html = render(data);
  assert.match(html, /aria-expanded="false"[^>]*>Магазины<\/button>/);
  assert.doesNotMatch(html, /<table|Товар с разными ценами|characteristic-1|0012345678901|private-document-17/);
  assert.match(html, /01\.11\.2026 — 03\.11\.2026/);
  assert.doesNotMatch(html, /04\.11\.2026/);
});

test("a missing-coverage branch is not mistaken for a safely inactive activity", () => {
  const data = report([activity("coverage", "Акция с неподтверждёнными данными", {
    branches: [branch({
      rows: [], hasSales: false, totals: totals(null),
      issues: [{ code: "missing_coverage", message: "В расчётном периоде нет отчёта источника." }]
    })],
    totals: totals(null)
  })]);
  data.totals = totals(null);
  const html = render(data);
  assert.match(html, /Акция с неподтверждёнными данными/);
  assert.match(html, /Нужна проверка/);
  assert.doesNotMatch(html, /За выбранный период продаж и возвратов не было/);
});

test("report-level limitations stay visible when all safely inactive activity blocks are hidden", () => {
  const data = report([inactiveActivity()]);
  data.totals = totals(null, 0);
  data.issues = [{ code: "missing_source", message: "Общий источник для расчёта недоступен." }];
  const html = render(data);
  assert.match(overall(html), /Не рассчитано/);
  assert.match(overall(html), /Рассчитанная часть/);
  assert.match(overall(html), /0,00\s*₸/);
  assert.match(html, /Подробности проверки отчёта \(1\)/);
  assert.match(html, /Общий источник для расчёта недоступен/);
  assert.doesNotMatch(html, /За выбранный период продаж и возвратов не было|<details[^>]*\sopen(?:=|>)/);
});
