export type CompensationIssue = { code: string; message: string };
export type CompensationTotals = {
  compensation: number | null;
  knownCompensation: number;
  incompleteRows: number;
};
export type CompensationActivityOption = {
  key: string; name: string; number: string | null;
  startsOn: string | null; endsOn: string | null;
};
export type CompensationRow = {
  itemKey: string; characteristicKey: string | null; name: string;
  barcode: string | null; price: number | null; discountPct: number | null;
  unitCompensation: number | null; quantity: number | null;
  compensation: number | null; priceDate: string | null;
  from: string; to: string; issues: CompensationIssue[];
};
export type CompensationBranch = {
  key: string | null; name: string; rows: CompensationRow[];
  totals: CompensationTotals; issues: CompensationIssue[];
};
export type CompensationActivity = CompensationActivityOption & {
  from: string; to: string; branches: CompensationBranch[];
  totals: CompensationTotals; issues: CompensationIssue[];
};
export type MarketingCompensationReport = {
  from: string; to: string; activityKey: string | null;
  activities: CompensationActivity[]; totals: CompensationTotals;
  issues: CompensationIssue[];
};
export type MarketingCompensationRequest = { from: string; to: string; activityKey?: string };
