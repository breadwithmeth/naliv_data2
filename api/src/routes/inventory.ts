import { Router } from "express";
import { z } from "zod";
import { asyncHandler, jsonSafe } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import { getInventoryReport } from "../services/inventory.js";

const querySchema = z.object({
  period: z.enum(["day", "week", "month"]).default("day"),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional()
});

export const inventoryRouter = Router();

inventoryRouter.use(requireAuth);

inventoryRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = querySchema.parse(req.query);
    res.json(jsonSafe(await getInventoryReport(query)));
  })
);
