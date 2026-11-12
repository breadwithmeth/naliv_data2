import { sendCachedJson } from "../lib/cached-json.js";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  getOverview,
  getSchemaRevision,
  getStorageIdentity,
  getTableProfile,
  getTables,
  getTimeSeries
} from "../services/analytics.js";

export const analyticsRouter = Router();

analyticsRouter.use(requireAuth, requireRole("admin"));

analyticsRouter.get(
  "/storage-identity",
  asyncHandler(async (req, res) => {
    const { challenge } = z.object({ challenge: z.string().uuid() }).parse(req.query);
    res.setHeader("Cache-Control", "no-store");
    res.json(await getStorageIdentity(challenge));
  })
);

analyticsRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    await sendCachedJson(req, res, ["getOverview", await getSchemaRevision()], () => getOverview());
  })
);

analyticsRouter.get(
  "/tables",
  asyncHandler(async (req, res) => {
    await sendCachedJson(req, res, ["getTables", await getSchemaRevision()], () => getTables());
  })
);

analyticsRouter.get(
  "/tables/:tableName",
  asyncHandler(async (req, res) => {
    await sendCachedJson(req, res, ["getTableProfile", req.params.tableName, await getSchemaRevision()], () => getTableProfile(req.params.tableName));
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

    await sendCachedJson(req, res, ["getTimeSeries", req.params.tableName, query, await getSchemaRevision()], () =>
      getTimeSeries(req.params.tableName, query.dateColumn, query.metricColumn)
    );
  })
);
