import type { Request, Response } from "express";
import { config } from "../config.js";
import { jsonSafe } from "./http.js";
import { ReportCache } from "./report-cache.js";

const cache = new ReportCache(config.REPORT_CACHE_TTL_SECONDS * 1000, config.REPORT_CACHE_MAX_MB * 1024 * 1024);

// Call only after authentication, role checks, and query validation. Use parsed
// parameters for the key so defaults and query-string order share one result.
export async function sendCachedJson(
  req: Request,
  res: Response,
  key: readonly unknown[],
  load: () => Promise<unknown>
) {
  if (!req.user) throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  const start = performance.now();
  const result = await cache.get(
    JSON.stringify([config.PGSCHEMA, req.user.role, ...key]),
    async () => JSON.stringify(jsonSafe(await load()))
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Report-Cache", result.status);
  res.setHeader("Server-Timing", `report;dur=${(performance.now() - start).toFixed(1)};desc="${result.status}"`);
  res.type("json").send(result.value);
}
