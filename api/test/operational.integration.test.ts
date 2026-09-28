import assert from "node:assert/strict";
import { test } from "node:test";

test("operational metrics use snapshots, monetary stockouts, and open orders", {
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
  const {
    getLostSalesMetrics,
    getMoneyPositionMetrics,
    getPurchasingRecommendations
  } = await import("../src/services/operational.js");
  config.PGSCHEMA = "pg_temp";
  const original = prisma.$queryRaw;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table catalog_magaziny (
        ref_key text, description text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_sklady (
        ref_key text, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_kassy_kkm (
        ref_key text, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_kontragenty (
        ref_key text, description text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_nomenklatura (
        ref_key text, description text,
        normativnyy_zapas_usolka numeric, normativnyy_zapas_satpaeva numeric,
        normativnyy_zapas_gorkogo numeric, normativnyy_zapas_karaganda numeric,
        normativnyy_zapas_karaganda_shahter numeric,
        normativnyy_zapas_karagandinskiy_pivzavod numeric,
        normativnyy_zapas_karaganda_buhar_zhyrau numeric,
        normativnyy_zapas_tolstogo numeric, normativnyy_zapas_astana numeric,
        normativnyy_zapas_temirtau_mira104 numeric,
        normativnyy_zapas_temirtau_mira86 numeric, normativnyy_zapas numeric,
        osnovnoy_postavschik_astana_key text,
        osnovnoy_postavschik_temirtau_key text,
        osnovnoy_postavschik_karaganda_key text,
        osnovnoy_postavschik_pavlodar_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_chek_kkm (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        vid_operatsii text, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_chek_kkm_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        magazin_key text, summa_oplaty_nalichnyh numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table accumulation_register_tovary_na_skladah_balance (
        balance_period timestamp, sklad_key text, nomenklatura_key text,
        kolichestvo_balance numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_zakaz_postavschiku (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        zakryt boolean, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_zakaz_postavschiku_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        summa numeric, summa_nds numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        zakaz_postavschiku_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        summa numeric, summa_nds numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table information_register_sebestoimost_nomenklatury_record_type (
        period timestamp, active boolean, magazin_key text, nomenklatura_key text,
        tsena numeric, line_number bigint) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti_tovary (
        _parent_ref_key text, _parent_line_index integer,
        nomenklatura_key text, tsena numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table accumulation_register_denezhnye_sredstva_nalichnye_balance (
        balance_period timestamp, magazin_key text, summa_balance numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table accumulation_register_denezhnye_sredstva_kkm_balance (
        balance_period timestamp, kassa_kkm_key text, summa_balance numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table accumulation_register_raschety_s_postavschikami_balance (
        balance_period timestamp, magazin_key text, summa_balance numeric,
        k_oplate_balance numeric, k_postupleniyu_balance numeric) on commit drop`);

      await tx.$executeRawUnsafe(`insert into catalog_magaziny values ('s1', 'Усолка')`);
      await tx.$executeRawUnsafe(`insert into catalog_sklady values ('w1', 's1')`);
      await tx.$executeRawUnsafe(`insert into catalog_kassy_kkm values ('k1', 's1')`);
      await tx.$executeRawUnsafe(`insert into catalog_kontragenty values ('sup1', 'Supplier One')`);
      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura (
        ref_key, description, normativnyy_zapas_usolka,
        osnovnoy_postavschik_pavlodar_key
      ) values ('i1', 'Item One', 10, 'sup1'), ('x', 'Snapshot marker', 0, null)`);
      await tx.$executeRawUnsafe(`insert into document_chek_kkm values
        ('c1', '2026-08-01 10:00', false, true, 'Продажа', 's1'),
        ('c2', '2026-08-02 10:00', false, true, 'Продажа', 's1')`);
      await tx.$executeRawUnsafe(`insert into document_chek_kkm_tovary values
        ('c1', 'i1', 2, 200), ('c2', 'i1', 2, 200)`);
      // A missing i1 row on the first snapshot is a physical zero. The second
      // snapshot contains five units.
      await tx.$executeRawUnsafe(`insert into accumulation_register_tovary_na_skladah_balance values
        ('2026-08-02', 'w1', 'x', 1),
        ('2026-08-03', 'w1', 'i1', 5)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah
        select 'rr-' || day::date, day, false, true, 's1', 10
        from generate_series(
          '2026-07-06'::timestamp,
          '2026-08-02'::timestamp,
          interval '1 day'
        ) day`);
      await tx.$executeRawUnsafe(`insert into document_zakaz_postavschiku values
        ('o1', '2026-08-01', false, true, false, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_zakaz_postavschiku_tovary values
        ('o1', 'i1', 3, 30, 0)`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov values
        ('r1', '2026-08-02', false, true, 'o1')`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov_tovary values
        ('r1', 'i1', 1, 10, 0)`);
      await tx.$executeRawUnsafe(`insert into information_register_sebestoimost_nomenklatury_record_type
        values ('2026-08-02', true, 's1', 'i1', 10, 1)`);
      await tx.$executeRawUnsafe(`insert into accumulation_register_denezhnye_sredstva_nalichnye_balance values
        ('2026-08-02', 's1', 999), ('2026-08-03', 's1', 10)`);
      await tx.$executeRawUnsafe(`insert into accumulation_register_denezhnye_sredstva_kkm_balance values
        ('2026-08-03', 'k1', 20)`);
      await tx.$executeRawUnsafe(`insert into accumulation_register_raschety_s_postavschikami_balance values
        ('2026-08-03', 's1', -30, -40, 10)`);

      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      const params = {
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-08-03T00:00:00Z"),
        limit: 20
      };

      const money = await getMoneyPositionMetrics({
        ...params,
        to: new Date("2026-08-04T00:00:00Z")
      });
      assert.equal(money.summary.cashBalance, 10);
      assert.equal(money.summary.kkmBalance, 20);
      assert.equal(money.summary.totalCash, 30);
      assert.equal(money.summary.bankBalance, null);
      assert.equal(money.summary.supplierPayableRaw, -40);
      assert.equal(money.summary.supplierBalanceStatus, "experimental");
      assert.equal(money.summary.uncollectedCashDays, 2);
      assert.equal(money.summary.cashSalesCoveragePct, 100);
      assert.equal(money.summary.cashDaysStatus, "ready");

      // A snapshot stored exactly at the window end is still the latest known
      // position for that window; excluding it silently reported zeros.
      const boundaryMoney = await getMoneyPositionMetrics({
        ...params,
        to: new Date("2026-08-03T00:00:00Z")
      });
      assert.equal(boundaryMoney.summary.cashBalance, 10);
      assert.equal(boundaryMoney.summary.kkmBalance, 20);

      const lostSales = await getLostSalesMetrics(params);
      assert.equal(lostSales.summary.status, "ready");
      assert.equal(lostSales.summary.snapshotDays, 2);
      assert.equal(lostSales.summary.coveragePct, 100);
      assert.equal(lostSales.summary.checkDays, 2);
      assert.equal(lostSales.summary.lostSales, 200);
      assert.equal(lostSales.items[0]?.zeroStockDays, 1);

      const purchasing = await getPurchasingRecommendations({
        ...params,
        to: new Date("2026-08-04T00:00:00Z")
      });
      assert.equal(purchasing.summary.recommendationCount, 1);
      assert.equal(purchasing.recommendations[0]?.stockQty, 5);
      assert.equal(purchasing.recommendations[0]?.openOrderQty, 2);
      assert.equal(purchasing.recommendations[0]?.targetStock, 10);
      assert.equal(purchasing.recommendations[0]?.recommendedQty, 3);
      assert.equal(purchasing.recommendations[0]?.supplierName, "Supplier One");
      assert.equal(purchasing.recommendations[0]?.salesQty28d, 4);
      assert.equal(purchasing.recommendations[0]?.purchaseBudgetQty, 4);
      assert.equal(purchasing.recommendations[0]?.purchaseBudgetAmount, 40);
      assert.equal(purchasing.summary.purchaseBudgetAmount, 40);
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});
