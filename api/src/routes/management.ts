import { Router } from "express";
import { z } from "zod";
import { sendCachedJson } from "../lib/cached-json.js";
import { asyncHandler } from "../lib/http.js";
import { reportRangeFields, resolveReportRange } from "../lib/report-range.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  getAcquiringMetrics,
  getCashArticleMetrics,
  getLossMetrics,
  getSourceHealth,
  getStoreStockMetrics,
  getSupplierTermsMetrics
} from "../services/management.js";

const querySchema = z.object({
  ...reportRangeFields,
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export const managementRouter = Router();
managementRouter.use(requireAuth, requireRole("admin"));

managementRouter.get(
  "/losses",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getLossMetrics", query], () => getLossMetrics(query));
  })
);

managementRouter.get(
  "/acquiring",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getAcquiringMetrics", query], () =>
      getAcquiringMetrics(query)
    );
  })
);

managementRouter.get(
  "/cash-articles",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getCashArticleMetrics", query], () =>
      getCashArticleMetrics(query)
    );
  })
);

managementRouter.get(
  "/supplier-terms",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getSupplierTermsMetrics", query], () =>
      getSupplierTermsMetrics(query)
    );
  })
);

managementRouter.get(
  "/store-stock",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getStoreStockMetrics", query], () =>
      getStoreStockMetrics(query)
    );
  })
);

managementRouter.get(
  "/source-health",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getSourceHealth", query], () => getSourceHealth(query));
  })
);
