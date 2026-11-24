import type {
  CompensationActivity, CompensationBranch, CompensationCalculationMode, CompensationExcludedDiagnostic, CompensationRow,
  MarketingCompensationReport
} from "./marketing-compensation-types.js";

export type CompensationBasis = {
  title: string;
  priceLabel: string;
  percentageLabel: string;
  priceSource: string;
  percentageSource: string;
};

export const compensationBases: Record<CompensationCalculationMode, CompensationBasis> = {
  "purchase-title": {
    title: "Закупочная цена и процент из названия акции",
    priceLabel: "Закупочная цена",
    percentageLabel: "Процент из названия акции",
    priceSource: "Закупочная цена на момент движения по виду закупа магазина из установок цен 1С («Маркетинг → Виды цен»).",
    percentageSource: "Однозначный процент из названия акции."
  },
  "retail-rule": {
    title: "Прежний расчёт: розничная цена и процент из правила",
    priceLabel: "Розничная цена до скидки",
    percentageLabel: "Процент из правила скидки",
    priceSource: "Цена до скидки из строки продажи/возврата 1С.",
    percentageSource: "Префикс названия правила скидки 1С."
  }
};

// Absence of movement flags alone is not proof: unknown quantities can leave rows.
export function isInactiveCompensationBranch(branch: CompensationBranch): boolean {
  return branch.hasSales === false && branch.hasReturns === false
    && branch.rows.length === 0 && branch.issues.length === 0
    && branch.totals.compensation === 0 && branch.totals.incompleteRows === 0;
}

export function isInactiveCompensationActivity(activity: CompensationActivity): boolean {
  return activity.branches.length > 0
    && activity.branches.every(isInactiveCompensationBranch)
    && activity.issues.length === 0
    && activity.totals.compensation === 0 && activity.totals.incompleteRows === 0;
}

export function isCompleteCompensationRow(row: CompensationRow): boolean {
  return Number.isFinite(row.price) && Number.isFinite(row.discountPct)
    && Number.isFinite(row.unitCompensation) && Number.isFinite(row.quantity)
    && Number.isFinite(row.compensation);
}

/** A presentation projection only: financial totals and source issues stay authoritative. */
export function projectCompensationReport(
  report: MarketingCompensationReport,
  includeIncomplete = report.includeIncomplete === true
): MarketingCompensationReport {
  if (includeIncomplete) return { ...report, includeIncomplete: true };
  let excludedIncompleteRows = report.excludedIncompleteRows ?? 0;
  let excludedIncompleteBlocks = report.excludedIncompleteBlocks ?? 0;
  const diagnostics: CompensationExcludedDiagnostic[] = [...(report.excludedIncompleteDiagnostics ?? [])];
  const activities: CompensationActivity[] = [];
  for (const activity of report.activities) {
    const rowsBefore = excludedIncompleteRows;
    const blocksBefore = excludedIncompleteBlocks;
    const context = {
      key: activity.key, name: activity.name, number: activity.number,
      startsOn: activity.startsOn, endsOn: activity.endsOn, from: activity.from, to: activity.to
    };
    const branches: CompensationBranch[] = [];
    for (const branch of activity.branches) {
      let excludedRows = branch.excludedIncompleteRows ?? 0;
      const rows: CompensationRow[] = [];
      for (const row of branch.rows) {
        if (isCompleteCompensationRow(row)) rows.push(row);
        else {
          excludedIncompleteRows++;
          excludedRows++;
          diagnostics.push({
            activity: context, branch: { key: branch.key, name: branch.name },
            row: { itemKey: row.itemKey, characteristicKey: row.characteristicKey, name: row.name, barcode: row.barcode, from: row.from, to: row.to },
            issues: [{ code: "incomplete_calculation", message: "Строка исключена из финансовых таблиц: нет полного расчёта." }, ...row.issues]
          });
        }
      }
      if (rows.length || (activity.issues.length === 0 && Number.isFinite(activity.totals.compensation)
        && activity.totals.incompleteRows === 0 && isInactiveCompensationBranch(branch))) {
        branches.push(rows.length === branch.rows.length ? branch : { ...branch, rows, excludedIncompleteRows: excludedRows });
      } else {
        excludedIncompleteBlocks++;
        diagnostics.push({
          activity: context, branch: { key: branch.key, name: branch.name },
          issues: [{ code: "incomplete_scope", message: "Блок магазина исключён из финансовых таблиц: нет строк с полным расчётом и подтверждённого отсутствия движений." }, ...branch.issues]
        });
      }
    }
    if (branches.length) {
      const changed = branches.length !== activity.branches.length
        || branches.some((branch, index) => branch !== activity.branches[index]);
      activities.push(changed ? {
        ...activity, branches,
        excludedIncompleteRows: (activity.excludedIncompleteRows ?? 0) + excludedIncompleteRows - rowsBefore,
        excludedIncompleteBlocks: (activity.excludedIncompleteBlocks ?? 0) + excludedIncompleteBlocks - blocksBefore
      } : activity);
    } else {
      if (!activity.branches.length) excludedIncompleteBlocks++;
      diagnostics.push({
        activity: context,
        issues: [{ code: "incomplete_scope", message: "Акция исключена из финансовых таблиц: нет доступных блоков с полным расчётом." }, ...activity.issues]
      });
    }
  }
  return {
    ...report, includeIncomplete: false, activities,
    excludedIncompleteRows, excludedIncompleteBlocks, excludedIncompleteDiagnostics: diagnostics
  };
}
