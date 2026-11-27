import type { Request, Response } from "express";
import { config } from "../config.js";
import { stringifyJson } from "./http.js";
import { ReportCache } from "./report-cache.js";
import { refreshReportGeneration, reportGeneration } from "./report-generation.js";
import { businessToday, evaluateCoverage, getReloadReadiness, requireCoverage } from "../services/reload-readiness.js";
import type { ReloadReadinessState, ReloadRequirement } from "../services/reload-readiness.js";

type ReloadGuard = ReloadRequirement | (() => Promise<void>);

/** Certification precedes every cache hit. */
export function createCachedReportLoader(
  reportCache: ReportCache,
  reader: () => Promise<ReloadReadinessState> = getReloadReadiness
) {
  return async (req: Request, key: readonly unknown[], load: (readiness?: ReloadReadinessState) => Promise<string>, requirement?: ReloadGuard) => {
    if (!req.user) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
    const readiness = requirement ? await reader() : undefined;
    if (typeof requirement === "function") await requirement();
    else if (requirement && readiness) requireCoverage(readiness, requirement);
    return reportCache.get(
      JSON.stringify([config.PGSCHEMA, config.APP_SCHEMA, req.user.role, reportGeneration.value, readiness?.binding, requirement ? businessToday() : null, ...key]),
      () => load(readiness)
    );
  };
}

const cache = new ReportCache(config.REPORT_CACHE_TTL_SECONDS * 1000, config.REPORT_CACHE_MAX_MB * 1024 * 1024);
const loadReport = createCachedReportLoader(cache);

export function invalidateReports() {
  reportGeneration.value++;
  cache.clear();
}

// Both JSON previews and downloadable reports share the same bounded snapshot.
export async function loadCachedJson(
  req: Request,
  key: readonly unknown[],
  load: () => Promise<unknown>,
  requirement?: ReloadGuard
) {
  if (!req.user) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  refreshReportGeneration(invalidateReports);
  return loadReport(req, key, async readiness => {
    const value = await load();
    if (readiness && requirement && typeof requirement !== "function" && requirement.kind !== "all") {
      const today = businessToday();
      const reloadCoverage = evaluateCoverage(readiness, requirement.kind, {
        from: requirement.from ?? new Date(readiness.from ?? "2026-06-01"),
        to: requirement.to ?? new Date(Date.parse(today) + 86_400_000)
      }, today);
      return stringifyJson({ ...value as Record<string, unknown>, reloadCoverage });
    }
    return stringifyJson(value);
  }, requirement);
}
// Call only after authentication, role checks, and query validation. Use parsed
// parameters for the key so defaults and query-string order share one result.
export async function sendCachedJson(
  req: Request,
  res: Response,
  key: readonly unknown[],
  load: () => Promise<unknown>,
  requirement?: ReloadGuard
) {
  const start = performance.now();
  const result = await loadCachedJson(req, key, load, requirement);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Report-Cache", result.status);
  res.setHeader("Server-Timing", `report;dur=${(performance.now() - start).toFixed(1)};desc="${result.status}"`);
  res.type("json").send(result.value);
}
