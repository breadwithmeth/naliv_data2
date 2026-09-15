import { sendCachedJson } from "../lib/cached-json.js";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getSalesReport, getIncomeReport } from "../services/reports.js";

const querySchema = z.object({
  period: z.enum(["day", "week", "month"]).default("day"),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  storeLimit: z.coerce.number().int().min(1).max(20).default(12)
});

export const reportsRouter = Router();

reportsRouter.use(requireAuth, requireRole("admin"));

reportsRouter.get(
  "/sales",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    await sendCachedJson(req, res, ["getSalesReport", query], () => getSalesReport(query));
  })
);

reportsRouter.get(
  "/income",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    await sendCachedJson(req, res, ["getIncomeReport", query], () => getIncomeReport(query));
  })
);
