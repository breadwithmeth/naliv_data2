import assert from "node:assert/strict";
import { test } from "node:test";

test("nomenclature uses net movements, calendar days, canonical cost, and visible cost gaps", {
  skip: !process.env.ANALYTICS_TEST_DATABASE_URL
}, async () => {
  process.env.DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL;
  process.env.PGSCHEMA = "pg_temp";
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";

  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  const { getNomenclatureReport } = await import("../src/services/nomenclature.js");
  config.PGSCHEMA = "pg_temp";
  const original = prisma.$queryRaw;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_nomenklatura (
        ref_key text, description text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table accumulation_register_tovary_na_skladah_balance (
        nomenklatura_key text, sklad_key text, balance_period timestamp,
        kolichestvo_balance numeric, rezerv_balance numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        tsena numeric, summa numeric, summa_nds numeric, _parent_line_index integer) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table information_register_sebestoimost_nomenklatury_record_type (
        period timestamp, active boolean, line_number integer, magazin_key text,
        nomenklatura_key text, tsena numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti_tovary (
        _parent_ref_key text, nomenklatura_key text, tsena numeric, _parent_line_index integer) on commit drop`);

      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values
        ('i1', 'Valued item'), ('i2', 'Missing-cost item')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('r1', '2026-08-01', false, true, 's1'),
        ('r2', '2026-08-02', false, true, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('r1', 'i1', 10, 100), ('r2', 'i1', 10, 100), ('r2', 'i2', 1, 50)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary values
        ('r2', 'i1', 2, 20)`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_sebestoimosti values
        ('c1', '2026-07-31', false, true, ''),
        ('future', '2026-10-01', false, true, '')`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_sebestoimosti_tovary values
        ('c1', 'i1', 5, 1), ('future', 'i1', 99, 1)`);
      await tx.$executeRawUnsafe(`insert into accumulation_register_tovary_na_skladah_balance values
        ('i1', 'w1', '2026-08-20', 100, 5),
        ('i2', 'w1', '2026-08-20', 10, 0)`);

      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      const result = await getNomenclatureReport({
        period: "day",
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-09-01T00:00:00.000Z")
      });

      const valued = result.items.find((item) => item.key === "i1");
      const missing = result.items.find((item) => item.key === "i2");
      assert.equal(result.totalDays, 31);
      assert.equal(valued?.qty, 18);
      assert.equal(valued?.revenue, 180);
      assert.equal(valued?.cost, 90);
      assert.equal(valued?.grossProfit, 90);
      assert.equal(valued?.daysWithSales, 2);
      assert.equal(valued?.daysWithoutSales, 29);
      assert.equal(missing?.cost, null);
      assert.equal(missing?.grossProfit, null);
      assert.equal(missing?.unvaluedRevenue, 50);
      assert.ok(result.costCoveragePct < 100);

      const exitValued = result.exitItems.find((item) => item.key === "i1");
      const exitMissing = result.exitItems.find((item) => item.key === "i2");
      assert.equal(exitValued?.stockCost, 500);
      assert.equal(exitValued?.reason, "overstock");
      assert.equal(exitMissing?.stockCost, null);
      assert.equal(result.exitSummary.unvaluedQty, 10);
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});
