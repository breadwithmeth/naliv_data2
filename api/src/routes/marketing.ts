import { sendCachedJson } from "../lib/cached-json.js";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { reportRangeFields, resolveReportRange } from "../lib/report-range.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getMarketingReport } from "../services/marketing.js";

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
