import { Router } from "express";
import { z } from "zod";
import { asyncHandler, jsonSafe } from "../lib/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getNomenclatureReport } from "../services/nomenclature.js";

const querySchema = z.object({
  period: z.enum(["day", "week", "month"]).default("day"),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
});

export const nomenclatureRouter = Router();

nomenclatureRouter.use(requireAuth, requireRole("admin"));

nomenclatureRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    res.json(jsonSafe(await getNomenclatureReport(query)));
  })
);
