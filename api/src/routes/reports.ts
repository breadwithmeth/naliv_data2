import { loadCachedJson, sendCachedJson } from "../lib/cached-json.js";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { reportRangeFields, resolveReportRange } from "../lib/report-range.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getSalesReport, getIncomeReport } from "../services/reports.js";
import { getYearComparison, yearComparisonQuerySchema } from "../services/year-comparison.js";
import type { YearComparisonReport } from "../services/year-comparison.js";
import { writeYearComparisonWorkbook } from "../services/year-comparison-workbook.js";
import { getPresentationReport, presentationReportQuerySchema } from "../services/presentation-report.js";
import type { PresentationReport } from "../services/presentation-report-types.js";
import { writePresentationReportWorkbook } from "../services/presentation-report-workbook.js";

const querySchema = z.object({
  period: z.enum(["day", "week", "month"]).default("day"),
  ...reportRangeFields,
  storeLimit: z.coerce.number().int().min(1).max(20).default(12)
});

export const reportsRouter = Router();

reportsRouter.use(requireAuth, requireRole("admin"));

reportsRouter.get(
  "/sales",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getSalesReport", query], () => getSalesReport(query));
  })
);

reportsRouter.get(
  "/income",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getIncomeReport", query], () => getIncomeReport(query));
  })
);

reportsRouter.get(
  "/year-comparison",
  asyncHandler(async (req, res) => {
    const start = performance.now();
    const query = yearComparisonQuerySchema.parse(req.query);
    const snapshot = await loadCachedJson(req, ["getYearComparison", query], () => getYearComparison(query));
    const report = JSON.parse(snapshot.value) as YearComparisonReport;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Report-Cache", snapshot.status);
    res.setHeader("Server-Timing", `report;dur=${(performance.now() - start).toFixed(1)}`);
    // The browser needs selection/coverage, not tens of thousands of audit rows.
    res.json({ periods: report.periods, stores: report.stores, coverage: report.coverage, quality: report.dataQuality.periods });
  })
);

reportsRouter.get(
  "/year-comparison.xlsx",
  asyncHandler(async (req, res) => {
    const query = yearComparisonQuerySchema.parse(req.query);
    const snapshot = await loadCachedJson(req, ["getYearComparison", query], () => getYearComparison(query));
    const report = JSON.parse(snapshot.value) as YearComparisonReport;
    const filename = `year-comparison_${query.from}_${query.to}.xlsx`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Report-Cache", snapshot.status);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    await writeYearComparisonWorkbook(report, res);
  })
);

reportsRouter.get(
  "/presentation.xlsx",
  asyncHandler(async (req, res) => {
    const query = presentationReportQuerySchema.parse(req.query);
    const snapshot = await loadCachedJson(req, ["getPresentationReport", query], () => getPresentationReport(query));
    const report = JSON.parse(snapshot.value) as PresentationReport;
    const filename = `presentation-report_${query.from}_${query.to}_${query.monthFrom}_${query.monthTo}.xlsx`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Report-Cache", snapshot.status);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    await writePresentationReportWorkbook(report, res);
  })
);
