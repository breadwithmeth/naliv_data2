import assert from "node:assert/strict";
import { test } from "node:test";

test("management directories persist explicit store, threshold, cash-flow, obligation, and project decisions", {
  skip: !process.env.ANALYTICS_TEST_DATABASE_URL
}, async () => {
  process.env.DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL;
  process.env.PGSCHEMA = "pg_temp";
  process.env.APP_SCHEMA = "pg_temp";
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";

  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  const service = await import("../src/services/management-settings.js");
  config.PGSCHEMA = "pg_temp";
  config.APP_SCHEMA = "pg_temp";
  const originalQuery = prisma.$queryRaw;
  const originalExecute = prisma.$executeRaw;
  const originalUnsafe = prisma.$executeRawUnsafe;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table catalog_magaziny (
        ref_key text, description text, deletion_mark boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_stati_dvizheniya_denezhnyh_sredstv (
        ref_key text, description text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_prihodnyy_kassovyy_order (
        ref_key text, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_prihodnyy_kassovyy_order_rasshifrovka_platezha (
        _parent_ref_key text, statya_dvizheniya_denezhnyh_sredstv_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_rashodnyy_kassovyy_order (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_rashodnyy_kassovyy_order_rasshifrovka_platezha (
        _parent_ref_key text, statya_dvizheniya_denezhnyh_sredstv_key text,
        summa numeric) on commit drop`);

      await tx.$executeRawUnsafe(`insert into catalog_magaziny values ('s1', 'Old name', false)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('r1', '2026-08-01', false, true, 's1')`);
      await tx.$executeRawUnsafe(`insert into catalog_stati_dvizheniya_denezhnyh_sredstv values
        ('a1', 'Покупка оборудования'), ('a2', 'Инкассация')`);
      await tx.$executeRawUnsafe(`insert into document_rashodnyy_kassovyy_order values
        ('c1', '2026-07-10', false, true), ('c2', '2026-08-10', false, true)`);
      await tx.$executeRawUnsafe(`insert into document_rashodnyy_kassovyy_order_rasshifrovka_platezha values
        ('c1', 'a1', 100), ('c2', 'a1', 140), ('c2', 'a2', 5)`);
      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      prisma.$executeRaw = tx.$executeRaw.bind(tx) as typeof prisma.$executeRaw;
      prisma.$executeRawUnsafe = tx.$executeRawUnsafe.bind(tx) as typeof prisma.$executeRawUnsafe;

      await service.updateStoreSetting({ storeKey: "s1", active: false, displayName: "Closed store" });
      await service.updateMetricSetting({ metricId: "stock.days", normal: "≤ 25", critical: "> 40", cadence: "Еженедельно", owner: "Buyer" });
      await service.updateCashArticleSetting({ articleKey: "a1", flowType: "investing", approved: true });
      await service.updateCashArticleSetting({ articleKey: "a2", flowType: "internal", approved: true });
      const obligation = await service.updateObligation({ kind: "loan", name: "Loan A", amount: 1000, dueDate: "2026-09-10", frequency: "monthly", active: true });
      const project = await service.updateProject({ name: "Store opening", budget: 5000, actual: 1200, startDate: "2026-09-01", status: "active" });
      const result = await service.getManagementSettings(new Date("2026-09-01T00:00:00.000Z"));

      assert.equal(result.stores[0]?.active, false);
      assert.equal(result.stores[0]?.displayName, "Closed store");
      assert.equal(result.metrics.find((item) => item.metricId === "stock.days")?.critical, "> 40");
      assert.equal(result.cashArticles[0]?.flowType, "investing");
      assert.equal(result.cashArticles[0]?.approved, true);
      assert.equal(result.cashArticles.find((item) => item.articleKey === "a2")?.flowType, "internal");
      assert.equal(result.cashArticles.find((item) => item.articleKey === "a2")?.suggestedFlow, "internal");
      assert.equal(result.obligations[0]?.id, obligation.id);
      assert.equal(result.obligations[0]?.amount, 1000);
      assert.equal(result.projects[0]?.id, project.id);
      assert.equal(result.projects[0]?.actual, 1200);
      assert.equal(result.recurringExpenseSuggestions[0]?.averageMonthlyAmount, 120);
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = originalQuery;
    prisma.$executeRaw = originalExecute;
    prisma.$executeRawUnsafe = originalUnsafe;
    await prisma.$disconnect();
  }
});
