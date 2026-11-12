import { Router } from "express";
import { asyncHandler } from "../lib/http.js";
import { loadCachedJson } from "../lib/cached-json.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getSyncHealth } from "../services/sync-health.js";
import { getReloadReadiness } from "../services/reload-readiness.js";

const RUNS_SHOWN = 10;

export const syncRouter = Router();

syncRouter.use(requireAuth, requireRole("admin"));

syncRouter.get(
  "/health",
  asyncHandler(async (req, res) => {
    const snapshot = await loadCachedJson(req, ["getSyncHealth", RUNS_SHOWN], () => getSyncHealth(RUNS_SHOWN));
    const reloadReadiness = await getReloadReadiness();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Report-Cache", snapshot.status);
    res.json({ ...JSON.parse(snapshot.value), reloadReadiness });
  })
);
