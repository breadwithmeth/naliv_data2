import assert from "node:assert/strict";
import { test } from "node:test";

test("store performance uses daily snapshots, revisions, and canonical costs", {
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
  const { getStorePerformanceMetrics } = await import("../src/services/store-performance.js");
  config.PGSCHEMA = "pg_temp";
  config.APP_SCHEMA = "pg_temp";
  const originalQuery = prisma.$queryRaw;
  const originalExecute = prisma.$executeRaw;
  const originalUnsafe = prisma.$executeRawUnsafe;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table accumulation_register_tovary_na_skladah_balance (
        nomenklatura_key text, sklad_key text, balance_period timestamp, kolichestvo_balance numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_sklady (
        ref_key text, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_magaziny (
        ref_key text, description text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_spisanie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_spisanie_tovarov_tovary (
        _parent_ref_key text, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_oprihodovanie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_oprihodovanie_tovarov_tovary (
        _parent_ref_key text, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table information_register_sebestoimost_nomenklatury_record_type (
        period timestamp, active boolean, line_number integer, magazin_key text,
        nomenklatura_key text, tsena numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti_tovary (
        _parent_ref_key text, nomenklatura_key text, tsena numeric, _parent_line_index integer) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        summa numeric, summa_nds numeric, _parent_line_index integer) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_pereschet_tovarov (
        ref_key text, date timestamp, magazin_key text, deletion_mark boolean,
        posted boolean, uchetnye_dannye_zapolneny boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_pereschet_tovarov_tovary (
        _parent_ref_key text, nomenklatura_key text, summa numeric,
        summa_fakt numeric, line_number bigint) on commit drop`);

      await tx.$executeRawUnsafe(`insert into catalog_magaziny values ('s1', 'Store One')`);
      await tx.$executeRawUnsafe(`insert into catalog_sklady values ('w1', 's1')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('r1', '2026-08-10', false, true, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('r1', 'i1', 10, 100)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary values
        ('r1', 'i1', 2, 20)`);
      await tx.$executeRawUnsafe(`insert into accumulation_register_tovary_na_skladah_balance
        values ('i1', 'w1', '2026-08-01', 50)`);
      await tx.$executeRawUnsafe(`insert into accumulation_register_tovary_na_skladah_balance
        select 'i1', 'w1', day, 40
        from generate_series(
          '2026-08-02'::timestamp,
          '2026-09-01'::timestamp,
          interval '1 day'
        ) day`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_sebestoimosti values
        ('c1', '2026-07-31', false, true, '')`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_sebestoimosti_tovary values
        ('c1', 'i1', 5, 1)`);
      await tx.$executeRawUnsafe(`insert into document_spisanie_tovarov values
        ('w1', '2026-08-15', false, true, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_spisanie_tovarov_tovary values ('w1', 10)`);
      await tx.$executeRawUnsafe(`insert into document_oprihodovanie_tovarov values
        ('o1', '2026-08-16', false, true, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_oprihodovanie_tovarov_tovary values ('o1', 2)`);
      await tx.$executeRawUnsafe(`insert into document_pereschet_tovarov values
        ('rev1', '2026-08-22', 's1', false, true, true),
        ('rev-invalid', '2026-08-23', 's1', false, true, false)`);
      await tx.$executeRawUnsafe(`insert into document_pereschet_tovarov_tovary values
        ('rev1', 'i1', 20, 15, 1),
        ('rev-invalid', 'i1', 100, null, 1)`);

      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      prisma.$executeRaw = tx.$executeRaw.bind(tx) as typeof prisma.$executeRaw;
      prisma.$executeRawUnsafe = tx.$executeRawUnsafe.bind(tx) as typeof prisma.$executeRawUnsafe;
      const result = await getStorePerformanceMetrics({
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-09-01T00:00:00.000Z"),
        limit: 20
      });

      const store = result.stores[0];
      const expectedAverageStockCost = (250 + 30 * 200) / 31;
      assert.equal(result.summary.activeStoreCount, 1);
      assert.equal(store?.revenue, 80);
      assert.equal(store?.cost, 40);
      assert.equal(store?.losses, 13);
      assert.equal(store?.grossProfitAfterLoss, 27);
      assert.equal(store?.closingStockCost, 200);
      assert.equal(store?.openingStockCost, 250);
      assert.equal(store?.stockMovement, -50);
      assert.equal(store?.daysOfStock, 140);
      assert.ok(Math.abs((store?.averageStockCost ?? 0) - expectedAverageStockCost) < 0.001);
      assert.equal(store?.stockSnapshotCoveragePct, 100);
      assert.equal(store?.frozenSnapshotCoveragePct, 100);
      assert.ok(
        Math.abs((store?.frozenStockCost ?? 0) - (40 - 8 / 28 * 30) * 5) < 0.001
      );
      assert.ok(
        Math.abs((store?.gmroi ?? 0) - (27 * (365 / 31)) / expectedAverageStockCost) < 0.001
      );
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = originalQuery;
    prisma.$executeRaw = originalExecute;
    prisma.$executeRawUnsafe = originalUnsafe;
    await prisma.$disconnect();
  }
});
