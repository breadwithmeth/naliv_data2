import assert from "node:assert/strict";
import { test } from "node:test";

// Opt-in: fixtures are connection-local TEMP tables inside a rolled-back
// transaction. No production source table is modified.
test("loss metrics subtract surpluses and explicit returns per store", {
  skip: !process.env.ANALYTICS_TEST_DATABASE_URL
}, async () => {
  process.env.DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL;
  process.env.PGSCHEMA = "pg_temp";
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";

  // Runtime imports are required because config parses DATABASE_URL/PGSCHEMA at
  // module load and must see the opt-in fixture database set above.

  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  const { getLossMetrics } = await import("../src/services/management.js");
  config.PGSCHEMA = "pg_temp";
  const original = prisma.$queryRaw;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table document_spisanie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_spisanie_tovarov_tovary (
        _parent_ref_key text, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_oprihodovanie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_oprihodovanie_tovarov_tovary (
        _parent_ref_key text, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        magazin_key text, summa_dokumenta numeric, summa_vozvratov numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_magaziny (
        ref_key text, description text) on commit drop`);

      await tx.$executeRawUnsafe(`insert into catalog_magaziny values
        ('s1', 'Store One'), ('s2', 'Store Two')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('r1', '2026-08-25', false, true, 's1', 1000, 100),
        ('r2', '2026-08-25', false, true, 's2', 500, 0)`);
      await tx.$executeRawUnsafe(`insert into document_spisanie_tovarov values
        ('w1', '2026-08-25', false, true, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_spisanie_tovarov_tovary values
        ('w1', 50), ('w1', 30)`);
      await tx.$executeRawUnsafe(`insert into document_oprihodovanie_tovarov values
        ('s1', '2026-08-25', false, true, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_oprihodovanie_tovarov_tovary values
        ('s1', 20)`);

      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      const result = await getLossMetrics({
        from: new Date("2026-08-01"),
        to: new Date("2026-09-01"),
        limit: 20
      });

      assert.equal(result.summary.writeoffs, 80);
      assert.equal(result.summary.surpluses, 20);
      assert.equal(result.summary.netLosses, 60);
      assert.equal(result.summary.netRevenue, 1400);
      assert.equal(result.stores.find((store) => store.storeKey === "s1")?.netRevenue, 900);
      assert.equal(result.stores.find((store) => store.storeKey === "s1")?.lossPct, 60 / 9);
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});
