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
import { getStorePerformanceMetrics } from "../services/store-performance.js";
import {
  getLostSalesMetrics,
  getMoneyPositionMetrics,
  getPurchasingRecommendations
} from "../services/operational.js";
import {
  getManagementSettings,
  updateCashArticleSetting,
  updateObligation,
  updateProject,
  updateMetricSetting,
  updateStoreSetting
} from "../services/management-settings.js";

const querySchema = z.object({
  ...reportRangeFields,
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const storeSettingSchema = z.object({
  storeKey: z.string().min(1).max(160),
  active: z.boolean(),
  displayName: z.string().trim().max(160).nullable().optional()
});

const metricSettingSchema = z.object({
  metricId: z.string().min(1).max(120),
  normal: z.string().trim().min(1).max(160),
  critical: z.string().trim().min(1).max(160),
  cadence: z.string().trim().min(1).max(80),
  owner: z.string().trim().min(1).max(160)
});

const cashArticleSettingSchema = z.object({
  articleKey: z.string().min(1).max(160),
  flowType: z.enum(["operating", "investing", "financing", "internal"]).nullable(),
  approved: z.boolean()
});

const obligationSchema = z.object({
  id: z.number().int().positive().optional(),
  kind: z.enum(["permanent", "payroll", "loan"]),
  name: z.string().trim().min(1).max(200),
  amount: z.number().finite().nonnegative(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  frequency: z.string().trim().min(1).max(80),
  active: z.boolean()
});

const projectSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(200),
  budget: z.number().finite().nonnegative(),
  actual: z.number().finite().nonnegative(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  status: z.enum(["planned", "active", "completed", "cancelled"])
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
  "/store-performance",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getStorePerformanceMetrics", query], () =>
      getStorePerformanceMetrics(query)
    );
  })
);

managementRouter.get(
  "/money-position",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getMoneyPositionMetrics", query], () =>
      getMoneyPositionMetrics(query)
    );
  })
);

managementRouter.get(
  "/lost-sales",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getLostSalesMetrics", query], () =>
      getLostSalesMetrics(query)
    );
  })
);

managementRouter.get(
  "/purchasing",
  asyncHandler(async (req, res) => {
    const query = resolveReportRange(querySchema.parse(req.query));
    await sendCachedJson(req, res, ["getPurchasingRecommendations", query], () =>
      getPurchasingRecommendations(query)
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

managementRouter.get(
  "/settings",
  asyncHandler(async (_req, res) => {
    res.json(await getManagementSettings());
  })
);

managementRouter.put(
  "/settings/store",
  asyncHandler(async (req, res) => {
    res.json(await updateStoreSetting(storeSettingSchema.parse(req.body)));
  })
);

managementRouter.put(
  "/settings/metric",
  asyncHandler(async (req, res) => {
    res.json(await updateMetricSetting(metricSettingSchema.parse(req.body)));
  })
);

managementRouter.put(
  "/settings/cash-article",
  asyncHandler(async (req, res) => {
    res.json(await updateCashArticleSetting(cashArticleSettingSchema.parse(req.body)));
  })
);

managementRouter.put(
  "/settings/obligation",
  asyncHandler(async (req, res) => {
    res.json(await updateObligation(obligationSchema.parse(req.body)));
  })
);

managementRouter.put(
  "/settings/project",
  asyncHandler(async (req, res) => {
    res.json(await updateProject(projectSchema.parse(req.body)));
  })
);
