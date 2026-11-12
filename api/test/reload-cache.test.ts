import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import type { Request } from "express";
import { ReportCache } from "../src/lib/report-cache.js";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/nalivdata";
process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
// Configuration must observe the test environment before module evaluation.
const { createCachedReportLoader } = await import("../src/lib/cached-json.js");
const { sendReloadIncompleteError } = await import("../src/lib/http.js");
const { readReloadReadiness } = await import("../src/services/reload-readiness.js");
test("positive-TTL JSON and workbook hits are refused before computation after incomplete or failed readiness", async () => {
  let status: "ready" | "reloading" | "blocked" = "ready", calls = 0;
  const blocked = await readReloadReadiness({ $queryRaw: async () => [], $queryRawUnsafe: async () => { throw new Error("denied"); } } as never);
  const reader = async () => Object.defineProperties({ ...blocked, status }, { binding: { value: status }, coverageSources: { value: [] } });
  const load = createCachedReportLoader(new ReportCache(60_000, 1_000_000), reader);
  const app = express();
  for (const kind of ["json", "xlsx"]) app.get(`/${kind}`, async (req, res, next) => {
    req.user = { email: "admin@test.local", role: "admin" };
    try {
      const snapshot = await load(req as Request, [kind], async () => { calls++; return kind === "json" ? '{"total":12}' : "workbook"; }, { kind: "all" });
      res.setHeader("X-Report-Cache", snapshot.status); res.send(snapshot.value);
    } catch (error) { next(error); }
  });
  app.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => { if (!sendReloadIncompleteError(error, res)) res.status(500).json({ error: "unexpected" }); });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    for (const kind of ["json", "xlsx"]) {
      assert.equal((await fetch(`http://127.0.0.1:${address.port}/${kind}`)).headers.get("x-report-cache"), "miss");
      assert.equal((await fetch(`http://127.0.0.1:${address.port}/${kind}`)).headers.get("x-report-cache"), "hit");
    }
    assert.equal(calls, 2);
    for (const failure of ["reloading", "blocked"] as const) {
      status = failure;
      for (const kind of ["json", "xlsx"]) {
        const response = await fetch(`http://127.0.0.1:${address.port}/${kind}`);
        assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store");
        const body = await response.json(); assert.equal(body.code, "ANALYTICS_RELOAD_INCOMPLETE"); assert.match(body.error, /источники/);
      }
    }
    assert.equal(calls, 2);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
