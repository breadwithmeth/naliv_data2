import { Router } from "express";
import { z } from "zod";
import { asyncHandler, jsonSafe } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getOverview,
  getTableProfile,
  getTables,
  getTimeSeries
} from "../services/analytics.js";

export const analyticsRouter = Router();

analyticsRouter.use(requireAuth);

analyticsRouter.get(
  "/overview",
  asyncHandler(async (_req, res) => {
    res.json(jsonSafe(await getOverview()));
  })
);

analyticsRouter.get(
  "/tables",
  asyncHandler(async (_req, res) => {
    res.json(jsonSafe(await getTables()));
  })
);

analyticsRouter.get(
  "/tables/:tableName",
  asyncHandler(async (req, res) => {
    res.json(jsonSafe(await getTableProfile(req.params.tableName)));
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

    res.json(
      jsonSafe(
        await getTimeSeries(req.params.tableName, query.dateColumn, query.metricColumn)
      )
    );
  })
);
