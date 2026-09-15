import { sendCachedJson } from "../lib/cached-json.js";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  getOverview,
  getTableProfile,
  getTables,
  getTimeSeries
} from "../services/analytics.js";

export const analyticsRouter = Router();

analyticsRouter.use(requireAuth, requireRole("admin"));

analyticsRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    await sendCachedJson(req, res, ["getOverview"], () => getOverview());
  })
);

analyticsRouter.get(
  "/tables",
  asyncHandler(async (req, res) => {
    await sendCachedJson(req, res, ["getTables"], () => getTables());
  })
);

analyticsRouter.get(
  "/tables/:tableName",
  asyncHandler(async (req, res) => {
    await sendCachedJson(req, res, ["getTableProfile", req.params.tableName], () => getTableProfile(req.params.tableName));
  })
);

analyticsRouter.get(
  "/tables/:tableName/timeseries",
  asyncHandler(async (req, res) => {
    const query = z
      .object({
        dateColumn: z.string().min(1),
        metricColumn: z.string().min(1).optional()
      })
      .parse(req.query);

    await sendCachedJson(req, res, ["getTimeSeries", req.params.tableName, query], () =>
      getTimeSeries(req.params.tableName, query.dateColumn, query.metricColumn)
    );
  })
);
