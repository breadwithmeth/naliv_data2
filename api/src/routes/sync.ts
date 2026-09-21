import { Router } from "express";
import { asyncHandler } from "../lib/http.js";
import { sendCachedJson } from "../lib/cached-json.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getSyncHealth } from "../services/sync-health.js";

const RUNS_SHOWN = 10;

export const syncRouter = Router();

syncRouter.use(requireAuth, requireRole("admin"));

syncRouter.get(
  "/health",
  asyncHandler(async (req, res) => {
    await sendCachedJson(req, res, ["getSyncHealth", RUNS_SHOWN], () =>
      getSyncHealth(RUNS_SHOWN)
    );
  })
);
