import { sendCachedJson } from "../lib/cached-json.js";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { reportRangeFields, resolveReportRange } from "../lib/report-range.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getMarketingReport } from "../services/marketing.js";
import { compensationQuerySchema, getMarketingCompensationActivities, getMarketingCompensationReport } from "../services/marketing-compensation.js";
import { writeMarketingCompensationWorkbook } from "../services/marketing-compensation-workbook.js";

const querySchema = z.object({
  period: z.enum(["day", "week", "month"]).default("day"),
  ...reportRangeFields
});

export const marketingRouter = Router();

marketingRouter.use(requireAuth, requireRole("admin", "marketing"));

marketingRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getMarketingReport", query], () => getMarketingReport(query));
  })
);

marketingRouter.get("/compensations/activities", asyncHandler(async (req, res) => {
  const query = compensationQuerySchema.parse(req.query);
  await sendCachedJson(req, res, ["getMarketingCompensationActivities", query], () => getMarketingCompensationActivities(query));
}));

marketingRouter.get("/compensations", asyncHandler(async (req, res) => {
  const query = compensationQuerySchema.parse(req.query);
  await sendCachedJson(req, res, ["getMarketingCompensationReport", query], () => getMarketingCompensationReport(query));
}));

marketingRouter.get("/compensations.xlsx", asyncHandler(async (req, res) => {
  const query = compensationQuerySchema.parse(req.query);
  const report = await getMarketingCompensationReport(query);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="marketing-compensations_${report.from}_${report.to}.xlsx"`);
  await writeMarketingCompensationWorkbook(report, res);
  if (!res.writableEnded) res.end();
}));
