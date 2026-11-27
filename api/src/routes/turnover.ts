import { Router } from "express";
import { sendCachedJson } from "../lib/cached-json.js";
import { sendHeavyReport } from "../lib/heavy-reports.js";
import { asyncHandler } from "../lib/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getTurnoverOptions, turnoverQuerySchema } from "../services/turnover.js";

export const turnoverRouter = Router();
turnoverRouter.use(requireAuth, requireRole("admin"));

turnoverRouter.get("/turnover", asyncHandler(async (req, res) => {
  const query = turnoverQuerySchema.parse(req.query);
  await sendHeavyReport(res, { kind: "turnover-preview", query });
}));

turnoverRouter.get("/turnover/options", asyncHandler(async (req, res) => {
  await sendCachedJson(req, res, ["getTurnoverOptions"], () => getTurnoverOptions(), { kind: "all" });
}));

turnoverRouter.get("/turnover/row", asyncHandler(async (req, res) => {
  const query = turnoverQuerySchema.parse(req.query);
  await sendHeavyReport(res, { kind: "turnover-row", query });
}));

turnoverRouter.get("/turnover.xlsx", asyncHandler(async (req, res) => {
  const query = turnoverQuerySchema.parse(req.query);
  await sendHeavyReport(res, { kind: "turnover-xlsx", query });
}));
