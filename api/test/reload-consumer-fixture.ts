import assert from "node:assert/strict";
import { once } from "node:events";
import { promisify } from "node:util";
import express from "express";
import ExcelJS from "exceljs";
import { installReloadFixture } from "./reload-fixture.js";

export async function verifyReloadConsumer(path: string, kind: "all" | "receipts" | "retail") {
  assert.ok(process.env.ANALYTICS_TEST_DATABASE_URL);
  assert.equal(new URL(process.env.ANALYTICS_TEST_DATABASE_URL).pathname, "/nalivdata");
  process.env.DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL;
  process.env.PGSCHEMA = "pg_temp";
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
  // Config must observe the guarded test DSN before loading database consumers.
  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  const { readReloadReadiness, createReloadReadinessReader, requireCoverage } = await import("../src/services/reload-readiness.js");
  const { createCachedReportLoader } = await import("../src/lib/cached-json.js");
  const { ReportCache } = await import("../src/lib/report-cache.js");
  const { sendReloadIncompleteError } = await import("../src/lib/http.js");
  const before = config.PGSCHEMA;
  const rollback = new Error("rollback reload consumer fixture");
  try {
    await prisma.$transaction(async tx => {
      const fixture = await installReloadFixture(tx);
      config.PGSCHEMA = fixture.namespace;
      const executor = { $queryRaw: tx.$queryRaw.bind(tx), $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx) };
      const pending = await readReloadReadiness(executor, fixture.namespace);
      assert.equal(pending.status, "reloading");
      assert.equal(pending.sources.find(source => source.table === "document_chek_kkm_tovary")?.status, "partial");
      const requirement = { kind, from: new Date("2026-06-01"), to: new Date("2026-06-02") };
      assert.throws(() => requireCoverage(pending, requirement), { statusCode: 503 });
      await fixture.verify();
      const ready = await readReloadReadiness(executor, fixture.namespace);
      assert.equal(ready.status, "ready");
      assert.equal(ready.sources.find(source => source.table === "document_chek_kkm_tovary")?.status, "empty");
      assert.doesNotThrow(() => requireCoverage(ready, requirement));
      let clock = 0, unreadable = false, computes = 0;
      const reader = createReloadReadinessReader(() => readReloadReadiness(unreadable ? { $queryRaw: executor.$queryRaw, $queryRawUnsafe: async () => { throw new Error("metadata read failed"); } } as never : executor, fixture.namespace), () => clock);
      const load = createCachedReportLoader(new ReportCache(60_000, 1_000_000), reader);
      const app = express();
      for (const format of ["json", "xlsx"]) app.get(`${path}.${format}`, async (req, res, next) => {
        req.user = { role: "admin", email: "admin@test.local" };
        try {
          const result = await load(req, [path, format], async () => {
            computes++;
            const [row] = await tx.$queryRaw<Array<{ total: number }>>`select sum(amount)::float8 as total from pg_temp.document_chek_kkm`;
            if (format === "json") return JSON.stringify(row);
            const workbook = new ExcelJS.Workbook(); workbook.addWorksheet("Проверка").addRow([row.total]);
            return Buffer.from(await workbook.xlsx.writeBuffer()).toString("base64");
          }, requirement);
          res.setHeader("X-Report-Cache", result.status);
          if (format === "xlsx") res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(Buffer.from(result.value, "base64"));
          else res.type("json").send(result.value);
        } catch (error) { next(error); }
      });
      app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { if (!sendReloadIncompleteError(error, res)) res.status(500).json({ error: "unexpected" }); });
      const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
      const get = (format: string) => fetch(`http://127.0.0.1:${address.port}${path}.${format}`);
      try {
        for (const format of ["json", "xlsx"]) {
          const cold = await get(format); assert.equal(cold.status, 200); assert.equal(cold.headers.get("x-report-cache"), "miss");
          if (format === "json") assert.deepEqual(await cold.json(), { total: 12 });
          else { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(await cold.arrayBuffer())); assert.equal(workbook.worksheets[0].getCell("A1").value, 12); }
          const warm = await get(format); assert.equal(warm.status, 200); assert.equal(warm.headers.get("x-report-cache"), "hit"); await warm.arrayBuffer();
        }
        await tx.$executeRawUnsafe(`update pg_temp.analytics_reload_jobs set status='pending' where range_start='2026-06-01'`);
        await tx.$executeRawUnsafe(`update pg_temp.analytics_reload_plans set status='reloading',revision=revision+1`);
        clock = 1000;
        for (const format of ["json", "xlsx"]) { const response = await get(format); assert.equal(response.status, 503); assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal((await response.json()).code, "ANALYTICS_RELOAD_INCOMPLETE"); }
        await fixture.verify(); clock = 2000; unreadable = true;
        for (const format of ["json", "xlsx"]) assert.equal((await get(format)).status, 503);
        assert.equal(computes, 2, "no affected report or workbook computation after readiness refusal");
      } finally { await promisify(server.close.bind(server))(); }
      throw rollback;
    }, { timeout: 60_000 });
  } catch (error) { if (error !== rollback) throw error; }
  finally { config.PGSCHEMA = before; await prisma.$disconnect(); }
}
