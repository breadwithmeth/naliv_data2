import assert from "node:assert/strict";
import { once } from "node:events";
import { promisify } from "node:util";
import { test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";
import { ZodError } from "zod";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/nalivdata";
process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
process.env.REPORT_CACHE_SYNC_POLL_SECONDS = "0";
// The config singleton intentionally loads only after the test environment.
const { prisma } = await import("../src/prisma.js");
const { inventoryRouter } = await import("../src/routes/inventory.js");
const { nomenclatureRouter } = await import("../src/routes/nomenclature.js");
const { marketingRouter } = await import("../src/routes/marketing.js");
const { managementRouter } = await import("../src/routes/management.js");
const { reportsRouter } = await import("../src/routes/reports.js");
const { turnoverRouter } = await import("../src/routes/turnover.js");
const { sendReloadIncompleteError } = await import("../src/lib/http.js");
const { sessionCookieName, signSession } = await import("../src/middleware/auth.js");
test("real affected routes authorize and validate before refusing missing reload certification", async () => {
  const unsafe = prisma.$queryRawUnsafe, query = prisma.$queryRaw;
  let financialReads = 0;
  prisma.$queryRawUnsafe = (async (sql: string) => {
    assert.ok(sql.includes("pg_database_size"), "Only reload catalogue reads may run before refusal");
    return [{ database_name: "nalivdata", database_oid: 1208710n, schema_name: "raw_1c", schema_oid: 55n, database_bytes: 5269000000n, has_layout: false, has_plans: false, has_jobs: false, tables: [] }];
  }) as typeof prisma.$queryRawUnsafe;
  prisma.$queryRaw = (async () => { financialReads++; throw new Error("Financial SQL must not run"); }) as typeof prisma.$queryRaw;
  const app = express(); app.use(cookieParser());
  app.use("/api/inventory", inventoryRouter); app.use("/api/nomenclature", nomenclatureRouter);
  app.use("/api/marketing", marketingRouter); app.use("/api/management", managementRouter);
  app.use("/api/reports", reportsRouter); app.use("/api/reports", turnoverRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (sendReloadIncompleteError(error, res)) return;
    if (error instanceof ZodError) { res.status(400).json({ error: "Некорректный запрос" }); return; }
    const known = error as Error & { statusCode?: number }; res.status(known.statusCode ?? 500).json({ error: known.message });
  });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
  const admin = `${sessionCookieName}=${signSession({ email: "admin@test.local", role: "admin" })}`;
  const marketing = `${sessionCookieName}=${signSession({ email: "marketing@test.local", role: "marketing" })}`;
  const get = (path: string, cookie = admin) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: cookie ? { cookie } : {} });
  const dates = "from=2026-06-01&to=2026-06-02";
  const paths = ["/api/inventory", "/api/nomenclature", "/api/reports/sales", "/api/reports/income", "/api/marketing", "/api/marketing/compensations/activities", "/api/marketing/compensations", "/api/marketing/compensations.xlsx", "/api/reports/presentation.xlsx", "/api/reports/turnover", "/api/reports/turnover/row", "/api/reports/turnover.xlsx", "/api/reports/year-comparison", "/api/reports/year-comparison.xlsx", "/api/management/store-stock", "/api/management/store-performance", "/api/management/lost-sales", "/api/management/purchasing"];
  try {
    assert.equal((await get("/api/inventory?from=not-a-date", "")).status, 401);
    assert.equal((await get("/api/inventory?from=not-a-date", marketing)).status, 403);
    assert.equal((await get("/api/inventory?from=not-a-date")).status, 400);
    assert.equal((await get("/api/inventory?from=2026-06-03&to=2026-06-01")).status, 400);
    for (const path of paths) {
      const response = await get(`${path}?${dates}`); assert.equal(response.status, 503, path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
      assert.equal((await response.json()).code, "ANALYTICS_RELOAD_INCOMPLETE", path);
    }
    assert.equal((await get("/api/reports/turnover/options")).status, 503);
    assert.equal(financialReads, 0);
  } finally { await promisify(server.close.bind(server))(); prisma.$queryRaw = query; prisma.$queryRawUnsafe = unsafe; await prisma.$disconnect(); }
});
