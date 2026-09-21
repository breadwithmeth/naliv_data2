import { z } from "zod";

// Report windows are half-open (`from <= date < to`). 1C timestamps reach
// PostgreSQL as naive local time tagged UTC — retail receipts span
// 02:41Z..23:05Z and nothing spills across a month boundary — so UTC calendar
// months line up with the business month and with the `YYYY-MM-DD` dates the web
// client sends.
export const reportRangeFields = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
};

export type ReportRangeFields = { from?: Date; to?: Date };

export function currentMonthRange(now: Date = new Date()): { from: Date; to: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  return {
    from: new Date(Date.UTC(year, month, 1)),
    to: new Date(Date.UTC(year, month + 1, 1))
  };
}

// A request without a range means "the current month". Scanning every year used
// to be the default and is still reachable by passing an explicit range.
export function resolveReportRange<T extends ReportRangeFields>(query: T): T {
  if (query.from || query.to) {
    return query;
  }

  return { ...query, ...currentMonthRange() };
}
