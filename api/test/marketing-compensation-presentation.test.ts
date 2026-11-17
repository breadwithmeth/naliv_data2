import assert from "node:assert/strict";
import test from "node:test";
import type { CompensationActivity, CompensationBranch, CompensationRow } from "../src/services/marketing-compensation-types.js";
import { isInactiveCompensationActivity, isInactiveCompensationBranch } from "../src/services/marketing-compensation-presentation.js";

const totals = { compensation: 0, knownCompensation: 0, incompleteRows: 0 };
function branch(overrides: Partial<CompensationBranch> = {}): CompensationBranch {
  return { key: "store", name: "Магазин", rows: [], hasSales: false, hasReturns: false, totals: { ...totals }, issues: [], ...overrides };
}
function activity(overrides: Partial<CompensationActivity> = {}): CompensationActivity {
  return { key: "activity", name: "Акция", number: null, startsOn: null, endsOn: null, from: "2026-06-01", to: "2026-06-02", branches: [branch()], totals: { ...totals }, issues: [], ...overrides };
}
const unknownRow: CompensationRow = { itemKey: "item", characteristicKey: null, name: "Товар", barcode: null, price: 100, discountPct: 10, unitCompensation: 10, quantity: null, compensation: null, from: "2026-06-01", to: "2026-06-02", issues: [] };

test("known empty branch and activity are inactive", () => {
  assert.equal(isInactiveCompensationBranch(branch()), true);
  assert.equal(isInactiveCompensationActivity(activity()), true);
});
test("false movement flags cannot hide NULL quantity rows", () => {
  assert.equal(isInactiveCompensationBranch(branch({ rows: [unknownRow] })), false);
});
test("missing coverage and incomplete totals remain visible", () => {
  assert.equal(isInactiveCompensationBranch(branch({ issues: [{ code: "missing_coverage", message: "Нет данных" }] })), false);
  assert.equal(isInactiveCompensationBranch(branch({ totals: { ...totals, compensation: null } })), false);
  assert.equal(isInactiveCompensationBranch(branch({ totals: { ...totals, incompleteRows: 1 } })), false);
});
test("activities without branches or with unresolved scope remain visible", () => {
  assert.equal(isInactiveCompensationActivity(activity({ branches: [] })), false);
  assert.equal(isInactiveCompensationActivity(activity({ issues: [{ code: "scope", message: "Нужна проверка" }] })), false);
  assert.equal(isInactiveCompensationActivity(activity({ totals: { ...totals, compensation: null } })), false);
  assert.equal(isInactiveCompensationActivity(activity({ totals: { ...totals, incompleteRows: 1 } })), false);
});
test("positive sales with zero compensation remain visible", () => {
  assert.equal(isInactiveCompensationBranch(branch({ hasSales: true })), false);
});
test("sale and full return with net zero remain visible", () => {
  assert.equal(isInactiveCompensationBranch(branch({ hasSales: true, hasReturns: true })), false);
});
test("return-only corrections remain visible", () => {
  assert.equal(isInactiveCompensationBranch(branch({ hasReturns: true, totals: { ...totals, compensation: -80, knownCompensation: -80 } })), false);
});
