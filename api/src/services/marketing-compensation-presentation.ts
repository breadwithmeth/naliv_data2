import type { CompensationActivity, CompensationBranch } from "./marketing-compensation-types.js";

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
