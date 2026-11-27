import { sendCachedJson } from "../lib/cached-json.js";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { reportRangeFields, resolveReportRange } from "../lib/report-range.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getMarketingReport } from "../services/marketing.js";
import { compensationPeriodSchema, compensationQuerySchema, getMarketingCompensationActivities } from "../services/marketing-compensation.js";
import { sendHeavyReport } from "../lib/heavy-reports.js";

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
    await sendCachedJson(req, res, ["getMarketingReport", query], () => getMarketingReport(query), { kind: "retail", from: query.from, to: query.to });
  })
);

marketingRouter.get("/compensations/activities", asyncHandler(async (req, res) => {
  const query = compensationPeriodSchema.parse(req.query);
  await sendCachedJson(req, res, ["getMarketingCompensationActivities", query], () => getMarketingCompensationActivities(query), { kind: "all" });
}));

marketingRouter.get("/compensations", asyncHandler(async (req, res) => {
  const query = compensationQuerySchema.parse(req.query);
  await sendHeavyReport(res, {kind: "compensation-preview", query});
}));

marketingRouter.get("/compensations.xlsx", asyncHandler(async (req, res) => {
  const query = compensationQuerySchema.parse(req.query);
  await sendHeavyReport(res, {kind: "compensation-xlsx", query});
}));
