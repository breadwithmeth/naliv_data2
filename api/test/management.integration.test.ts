import assert from "node:assert/strict";
import { test } from "node:test";

// Opt-in: fixtures are connection-local TEMP tables inside a rolled-back
// transaction. No production source table is modified.
test("loss metrics combine documents and valid revision differences per store", {
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
      await tx.$executeRawUnsafe(`create temp table document_pereschet_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        magazin_key text, uchetnye_dannye_zapolneny boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_pereschet_tovarov_tovary (
        _parent_ref_key text, nomenklatura_key text, summa numeric,
        summa_fakt numeric, line_number bigint) on commit drop`);

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
      await tx.$executeRawUnsafe(`insert into document_pereschet_tovarov values
        ('rev-short', '2026-08-25', false, true, 's1', true),
        ('rev-plus', '2026-08-25', false, true, 's1', true),
        ('rev-invalid', '2026-08-25', false, true, 's1', false)`);
      await tx.$executeRawUnsafe(`insert into document_pereschet_tovarov_tovary values
        ('rev-short', 'i1', 100, 90, 1),
        ('rev-plus', 'i2', 100, 105, 1),
        ('rev-invalid', 'i3', 100, null, 1)`);

      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      const result = await getLossMetrics({
        from: new Date("2026-08-01"),
        to: new Date("2026-09-01"),
        limit: 20
      });

      assert.equal(result.summary.writeoffs, 90);
      assert.equal(result.summary.surpluses, 25);
      assert.equal(result.summary.netLosses, 65);
      assert.equal(result.summary.netRevenue, 1400);
      assert.equal(result.stores.find((store) => store.storeKey === "s1")?.netRevenue, 900);
      assert.ok(
        Math.abs(
          (result.stores.find((store) => store.storeKey === "s1")?.lossPct ?? 0)
          - 65 / 9
        ) < 1e-12
      );
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});

test("cash flow statement excludes own transfers and reports mapping coverage", {
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
  const { getCashArticleMetrics } = await import("../src/services/management.js");
  const { ensureManagementSettingsTables } = await import("../src/services/management-settings.js");
  config.PGSCHEMA = "pg_temp";
  config.APP_SCHEMA = "pg_temp";
  const originalQuery = prisma.$queryRaw;
  const originalUnsafe = prisma.$executeRawUnsafe;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table catalog_stati_dvizheniya_denezhnyh_sredstv (
        ref_key text, description text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_prihodnyy_kassovyy_order (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        dokument_osnovanie text, dokument_osnovanie_type text, bankovskiy_schet_key text,
        summa_dokumenta numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_prihodnyy_kassovyy_order_rasshifrovka_platezha (
        _parent_ref_key text, statya_dvizheniya_denezhnyh_sredstv_key text,
        summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_rashodnyy_kassovyy_order (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        kassa_poluchatel_key text, kassa_kkm_key text, bankovskiy_schet_key text,
        summa_dokumenta numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_rashodnyy_kassovyy_order_rasshifrovka_platezha (
        _parent_ref_key text, statya_dvizheniya_denezhnyh_sredstv_key text,
        summa numeric, magazin_key text) on commit drop`);

      await tx.$executeRawUnsafe(`insert into catalog_stati_dvizheniya_denezhnyh_sredstv values
        ('a-op', 'Операционная статья'),
        ('a-invest', 'Инвестиционная статья'),
        ('a-internal', 'Инкассация'),
        ('a-other', 'Не классифицировано')`);
      await tx.$executeRawUnsafe(`insert into document_prihodnyy_kassovyy_order values
        ('p-op', '2026-08-10', false, true, null, 'StandardODATA.Undefined', null, 100),
        ('p-transfer', '2026-08-11', false, true, 'r-transfer', 'StandardODATA.Document_РасходныйКассовыйОрдер', null, 30),
        ('p-other', '2026-08-12', false, true, null, 'StandardODATA.Undefined', null, 20),
        ('p-extract', '2026-08-17', false, true, 'extract-1', 'StandardODATA.Document_ВыемкаДенежныхСредствИзКассыККМ', null, 25),
        ('p-bank', '2026-08-18', false, true, null, 'StandardODATA.Undefined', 'own-bank', 15)`);
      await tx.$executeRawUnsafe(`insert into document_prihodnyy_kassovyy_order_rasshifrovka_platezha values
        ('p-op', 'a-op', 100),
        ('p-transfer', 'a-op', 30),
        ('p-other', 'a-other', 20),
        ('p-bank', 'a-op', 15)`);
      await tx.$executeRawUnsafe(`insert into document_rashodnyy_kassovyy_order values
        ('r-transfer', '2026-08-11', false, true, 'own-desk', null, null, 30),
        ('r-op', '2026-08-13', false, true, null, null, null, 40),
        ('r-invest', '2026-08-14', false, true, null, null, null, 50),
        ('r-internal', '2026-08-15', false, true, null, null, null, 70),
        ('r-other', '2026-08-16', false, true, null, null, null, 10),
        ('r-cash', '2026-08-17', false, true, 'own-desk', null, null, 25),
        ('r-bank', '2026-08-18', false, true, null, null, 'own-bank', 12)`);
      await tx.$executeRawUnsafe(`insert into document_rashodnyy_kassovyy_order_rasshifrovka_platezha values
        ('r-transfer', 'a-op', 30, ''),
        ('r-op', 'a-op', 40, ''),
        ('r-invest', 'a-invest', 50, ''),
        ('r-internal', 'a-internal', 70, ''),
        ('r-other', 'a-other', 10, ''),
        ('r-bank', 'a-op', 12, '')`);

      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      prisma.$executeRawUnsafe = tx.$executeRawUnsafe.bind(tx) as typeof prisma.$executeRawUnsafe;
      await ensureManagementSettingsTables();
      const params = {
        from: new Date("2026-08-01"),
        to: new Date("2026-09-01"),
        limit: 20
      };
      const unavailable = await getCashArticleMetrics(params);
      assert.equal(unavailable.statement.status, "unavailable");
      assert.equal(unavailable.statement.flows.operating.net, null);
      assert.equal(unavailable.statement.flows.investing.net, null);
      assert.equal(unavailable.statement.flows.financing.net, null);
      assert.equal(unavailable.statement.internalTransferStatus, "partial");
      assert.equal(unavailable.statement.unallocatedInternalInflow, 25);
      assert.equal(unavailable.statement.unallocatedInternalOutflow, 25);

      await tx.$executeRawUnsafe(`insert into naliv_cash_article_settings
        (article_key, flow_type, approved) values
        ('a-op', 'operating', true),
        ('a-invest', 'investing', true),
        ('a-internal', 'internal', true)`);

      const result = await getCashArticleMetrics(params);

      assert.equal(result.summary.externalInflow, 135);
      assert.equal(result.summary.externalOutflow, 112);
      assert.equal(result.summary.net, 23);
      assert.equal(result.statement.flows.operating.net, 63);
      assert.equal(result.statement.flows.investing.net, -50);
      assert.equal(result.statement.flows.financing.net, 0);
      assert.equal(result.statement.internalTransferTurnover, 180);
      assert.equal(result.statement.internalTransferStatus, "partial");
      assert.equal(result.statement.unallocatedInternalDocumentCount, 2);
      assert.equal(result.statement.classifiedTurnover, 217);
      assert.equal(result.statement.unclassifiedTurnover, 30);
      assert.ok(Math.abs(result.statement.classifiedCoveragePct - (217 / 247) * 100) < 1e-10);
      assert.equal(result.statement.status, "partial");
      assert.equal(result.statement.approvedInternalArticleCount, 1);
      assert.equal(result.articles.find((row) => row.articleKey === "a-op")?.net, 63);
      assert.equal(result.articles.find((row) => row.articleKey === "a-internal")?.outflow, 0);
      assert.equal(result.articles.find((row) => row.articleKey === "a-internal")?.internalOutflow, 70);
      const limited = await getCashArticleMetrics({ ...params, limit: 1 });
      assert.equal(limited.articles.length, 1);
      assert.deepEqual(limited.statement.flows, result.statement.flows);
      assert.equal(limited.statement.unclassifiedTurnover, result.statement.unclassifiedTurnover);
      assert.equal(limited.statement.internalTransferTurnover, result.statement.internalTransferTurnover);
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = originalQuery;
    prisma.$executeRawUnsafe = originalUnsafe;
    await prisma.$disconnect();
  }
});
