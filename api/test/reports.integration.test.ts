import assert from "node:assert/strict";
import { test } from "node:test";

// Opt-in: fixtures exist only in connection-local TEMP tables and roll away at
// disconnect. No source tables, records, or persistent schemas are modified.
test("sales preserve report totals, discount amounts, and date boundaries", {
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
  const { getSalesReport } = await import("../src/services/reports.js");
  const { getColumnSummaries, getColumns } = await import("../src/services/analytics.js");
  const { config } = await import("../src/config.js");
  const original = prisma.$queryRaw;
  const originalUnsafe = prisma.$queryRawUnsafe;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table document_chek_kkm (
        _id integer primary key, ref_key text, date timestamp, deletion_mark boolean,
        posted boolean, summa_dokumenta numeric, vid_operatsii text,
        otchet_o_roznichnyh_prodazhah_key text, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_chek_kkm_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        _id integer primary key, ref_key text, date timestamp, deletion_mark boolean,
        posted boolean, summa_dokumenta numeric, summa_vozvratov numeric,
        magazin_key text) on commit drop`);
      for (const table of ["catalog_magaziny", "catalog_nomenklatura"]) {
        await tx.$executeRawUnsafe(`create temp table ${table} (ref_key text, description text) on commit drop`);
      }
      await tx.$executeRawUnsafe(`insert into document_chek_kkm values
        (1, 'a', '2026-08-24 10:00', false, true, 180, 'Продажа', 'ra', 's1'),
        (2, 'b', '2026-08-25 11:00', false, true, 100, 'Продажа', 'rb', 's1'),
        (3, 'c', '2026-08-26 12:00', false, true, 50, 'Продажа', 'rc', null),
        (4, 'ret', '2026-08-26 13:00', false, true, 20, 'Возврат', 'ra', 's1'),
        (5, 'deleted', '2026-08-26', true, true, 10000, 'Продажа', 'rx', 's1'),
        (6, 'unposted', '2026-08-26', false, false, 10000, 'Продажа', 'rx', 's1'),
        (7, 'before', '2026-08-23', false, true, 10000, 'Продажа', 'rx', 's1'),
        (8, 'end', '2026-09-01', false, true, 10000, 'Продажа', 'rx', 's1'),
        (9, 'zero', '2026-08-26', false, true, 0, 'Продажа', 'rx', 's1'),
        (10, 'no-report', '2026-08-21 12:00', false, true, 50, 'Продажа', 'rnr', 's1')`);
      await tx.$executeRawUnsafe(`insert into document_chek_kkm_tovary values
        ('a', 'i1', 2, 120), ('a', 'i2', 1, 60),
        ('b', 'i1', 2, 100), ('ret', 'i1', 1, 20),
        ('before', 'i1', 1000, 10000), ('end', 'i1', 1000, 10000),
        ('no-report', 'i1', 1, 50)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        (1, 'ra', '2026-08-24', false, true, 180, 20, 's1'),
        (2, 'rb', '2026-08-25', false, true, 100, 0, 's1'),
        (3, 'rc', '2026-08-26', false, true, 50, 0, null),
        (4, 'before', '2026-08-23', false, true, 10000, 0, 's1'),
        (5, 'end', '2026-09-01', false, true, 10000, 0, 's1')`);
      // Duplicate catalog references must not multiply aggregate metrics.
      await tx.$executeRawUnsafe(`insert into catalog_magaziny values ('s1', 'Store'), ('s1', 'Store')`);
      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values ('i1', 'Item'), ('i1', 'Item')`);
      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      const params = { period: "day" as const, from: new Date("2026-08-24"), to: new Date("2026-09-01"), storeLimit: 12 };
      const sales = await getSalesReport(params);
      assert.equal(sales.summary.grossRevenue, 330);
      assert.equal(sales.summary.returns, 20);
      assert.equal(sales.summary.revenue, 310);
      assert.equal(sales.summary.orderCount, 3);
      assert.equal(sales.summary.reportCount, 3);
      assert.equal(sales.summary.returnCount, 1);
      assert.equal(sales.summary.avgItemsPerCheck, 4 / 3);
      assert.equal(sales.reconciliation.checkRevenue, 310);
      assert.equal(sales.reconciliation.retailReportRevenue, 310);
      assert.equal(sales.reconciliation.difference, 0);
      assert.equal(sales.reconciliation.comparable, true);
      assert.equal(sales.reconciliation.retailReportDays, 3);
      assert.equal(sales.reconciliation.retailReportCoveragePct, 100);
      assert.equal(sales.reconciliation.linkedCheckPct, 100);

      // Checks without any retail-report day must never imply "report revenue
      // 0" and a fabricated difference.
      const uncomparable = await getSalesReport({
        period: "day",
        storeLimit: 12,
        from: new Date("2026-08-21T00:00:00Z"),
        to: new Date("2026-08-22T00:00:00Z")
      });
      assert.equal(uncomparable.reconciliation.checkRevenue, 50);
      assert.equal(uncomparable.reconciliation.retailReportDays, 0);
      assert.equal(uncomparable.reconciliation.comparable, false);
      assert.equal(uncomparable.reconciliation.difference, null);
      assert.equal(sales.revenueSeries.length, 3);
      // Handbook 6.2: average check is withheld while either source is partial.
      assert.equal(sales.summary.avgCheck, null);
      const fullCoverageWindow = await getSalesReport({
        period: "day",
        storeLimit: 12,
        from: new Date("2026-08-24T00:00:00Z"),
        to: new Date("2026-08-27T00:00:00Z")
      });
      // Official net revenue 310 ÷ (3 sale checks − 1 return check) = 155.
      assert.equal(fullCoverageWindow.summary.avgCheck, 155);
      assert.equal(fullCoverageWindow.summary.checkCoveragePct, 100);
      assert.equal(sales.summary.coveredDays, 3);
      assert.equal(sales.summary.expectedDays, 8);
      assert.equal(sales.summary.checkCoveragePct, 37.5);
      assert.equal(sales.summary.checkStatus, "partial");
      assert.deepEqual(
        sales.composition.map((item) => [
          item.itemKey,
          item.quantity,
          item.revenue,
          item.checkCount
        ]),
        [
          ["i1", 3, 200, 2],
          ["i2", 1, 60, 1]
        ]
      );
      assert.equal(sales.heatmap.cells.reduce((sum, cell) => sum + cell.revenue, 0), 310);
      const [namespace] = await tx.$queryRaw<Array<{ name: string }>>`
        select nspname::text as name from pg_namespace where oid = pg_my_temp_schema()
      `;
      config.PGSCHEMA = namespace.name;
      prisma.$queryRawUnsafe = tx.$queryRawUnsafe.bind(tx) as typeof prisma.$queryRawUnsafe;
      const table = "document_otchet_o_roznichnyh_prodazhah";
      const profile = await getColumnSummaries(table, await getColumns(table));
      assert.deepEqual(profile.numericSummaries.find((column) => column.column === "_id"), {
        column: "_id", min: "1", max: "5", avg: 3, filled: 5
      });
      assert.equal(profile.numericSummaries.find((column) => column.column === "summa_dokumenta")?.filled, 5);
      assert.deepEqual(profile.temporalSummaries.find((column) => column.column === "date"), {
        column: "date", min: "2026-08-23 00:00:00", max: "2026-09-01 00:00:00", filled: 5
      });
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = original;
    prisma.$queryRawUnsafe = originalUnsafe;
    await prisma.$disconnect();
  }
});

// Income derives per-store and per-item totals from its store-item rows, and
// keeps the historic name fallbacks for catalog keys that have no description.
test("income report derives store and item totals with catalog name fallbacks", {
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
  // Imported after the environment above so config parses the test database.
  const { prisma } = await import("../src/prisma.js");
  const { getIncomeReport } = await import("../src/services/reports.js");
  const { config } = await import("../src/config.js");
  // A previous test may have pinned the schema to its own temp namespace.
  config.PGSCHEMA = "pg_temp";
  config.APP_SCHEMA = "pg_temp";
  const original = prisma.$queryRaw;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        ref_key text, date timestamp, deletion_mark boolean,
        posted boolean, summa_dokumenta numeric, summa_vozvratov numeric,
        magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        tsena numeric, summa numeric, summa_nds numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table information_register_sebestoimost_nomenklatury_record_type (
        period timestamp, active boolean, line_number integer, magazin_key text,
        nomenklatura_key text, tsena numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti (
        ref_key text, magazin_key text, date timestamp, deletion_mark boolean,
        posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti_tovary (
        _parent_ref_key text, _parent_line_index integer, nomenklatura_key text,
        tsena numeric) on commit drop`);
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
      await tx.$executeRawUnsafe(`create temp table document_pereschet_tovarov (
        ref_key text, date timestamp, magazin_key text, deletion_mark boolean,
        posted boolean, uchetnye_dannye_zapolneny boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_pereschet_tovarov_tovary (
        _parent_ref_key text, nomenklatura_key text, summa numeric,
        summa_fakt numeric, line_number bigint) on commit drop`);
      for (const table of ["catalog_magaziny", "catalog_nomenklatura"]) {
        await tx.$executeRawUnsafe(`create temp table ${table} (ref_key text, description text) on commit drop`);
      }
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov values
        ('p1', '2026-08-20', false, true)`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov_tovary values
        ('p1', 'i1', 10, 100, 1000, 0), ('p1', 'i2', 10, 50, 500, 0)`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_sebestoimosti values
        ('c1', 's1', '2026-08-23', false, true)`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_sebestoimosti_tovary values
        ('c1', 0, 'i1', 100)`);
      await tx.$executeRawUnsafe(`insert into information_register_sebestoimost_nomenklatury_record_type values
        ('2026-08-24', true, 1, 's1', 'i1', 90)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('r1', '2026-08-25', false, true, 200, 100, 's1'),
        ('r2', '2026-08-30', false, true, 250, 0, 's1'),
        ('r3', '2026-08-26', false, true, 300, 0, 's2')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('r1', 'i1', 2, 200), ('r2', 'i1', 1, 100),
        ('r2', 'i2', 3, 150), ('r3', 'i1', 4, 300)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary values
        ('r1', 'i1', 1, 100)`);
      await tx.$executeRawUnsafe(`insert into document_spisanie_tovarov values
        ('w1', '2026-08-26', false, true, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_spisanie_tovarov_tovary values
        ('w1', 50)`);
      await tx.$executeRawUnsafe(`insert into document_oprihodovanie_tovarov values
        ('o1', '2026-08-26', false, true, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_oprihodovanie_tovarov_tovary values
        ('o1', 20)`);
      // s2 and i2 stay out of the catalogs to exercise the name fallbacks.
      await tx.$executeRawUnsafe(`insert into catalog_magaziny values ('s1', 'Store One')`);
      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values ('i1', 'Item One')`);
      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;

      const report = await getIncomeReport({
        period: "day",
        from: new Date("2026-08-24"),
        to: new Date("2026-09-01"),
        storeLimit: 12
      });

      // Explicit return rows reduce both revenue and cost. The live store/item
      // register wins for s1/i1; i2 and s2/i1 use weighted purchase fallback.
      assert.equal(report.summary.revenue, 650);
      assert.equal(report.summary.cost, 730);
      assert.equal(report.summary.grossProfit, -80);
      assert.equal(report.summary.costCoveragePct, 100);
      assert.equal(report.summary.unvaluedRevenue, 0);
      // Handbook 7: gross profit after losses = revenue − cost − (write-offs − surpluses).
      assert.equal(report.summary.losses, 30);
      assert.equal(report.summary.grossProfitAfterLoss, -110);
      assert.equal(report.summary.marginAfterLossPct, (-110 / 650) * 100);
      assert.equal(
        report.incomeSeries.reduce((sum, point) => sum + point.losses, 0),
        30
      );
      assert.equal(
        report.incomeSeries.reduce(
          (sum, point) => sum + point.grossProfitAfterLoss,
          0
        ),
        report.summary.grossProfitAfterLoss
      );
      assert.equal(report.incomeSeries.length, 3);
      assert.equal(
        report.incomeSeries.reduce((sum, point) => sum + point.revenue, 0),
        report.summary.revenue
      );
      assert.equal(
        report.incomeSeries.reduce((sum, point) => sum + point.cost, 0),
        report.summary.cost
      );
      assert.deepEqual(
        report.incomeSeries.map((point) => point.bucket),
        ["2026-08-25T00:00:00.000Z", "2026-08-26T00:00:00.000Z", "2026-08-30T00:00:00.000Z"]
      );

      // Store and item totals are sums of the store-item rows, not repeats.
      assert.deepEqual(
        report.stores.map((store) => [store.key, store.name, store.revenue, store.cost, store.grossProfit, store.losses, store.grossProfitAfterLoss]),
        [
          ["s1", "Store One", 350, 330, 20, 30, -10],
          ["s2", "Магазин s2", 300, 400, -100, 0, -100]
        ]
      );
      assert.deepEqual(
        report.items.map((item) => [item.key, item.name, item.soldQty, item.revenue, item.cost]),
        [
          ["i1", "Item One", 6, 500, 580],
          ["i2", "i2", 3, 150, 150]
        ]
      );
      assert.deepEqual(
        report.storeItems.map((row) => [row.storeKey, row.storeName, row.itemKey, row.itemName, row.revenue, row.cost]),
        [
          ["s1", "Store One", "i1", "Item One", 200, 180],
          ["s1", "Store One", "i2", "i2", 150, 150],
          ["s2", "Магазин s2", "i1", "Item One", 300, 400]
        ]
      );

      // Sales-only aggregates must not hide documents on dates/stores with no
      // sales. Catalog duplicates and absent/null names cannot change money.
      await tx.$executeRawUnsafe(`insert into catalog_magaziny values
        ('s3', 'Store Three'), ('s3', 'Store Three'), ('s-zero', null)`);
      await tx.$executeRawUnsafe(`insert into document_spisanie_tovarov values
        ('w-before-sales', '2026-08-24', false, true, 's3'),
        ('w-after-sales', '2026-08-29', false, true, 's4'),
        ('w-no-store', '2026-08-28', false, true, null),
        ('w-empty-store', '2026-08-28', false, true, ''),
        ('w-zero', '2026-08-28', false, true, 's-zero'),
        ('w-before-window', '2026-08-23', false, true, 'outside'),
        ('w-end-window', '2026-09-01', false, true, 'outside'),
        ('w-deleted', '2026-08-28', true, true, 'outside'),
        ('w-unposted', '2026-08-28', false, false, 'outside')`);
      await tx.$executeRawUnsafe(`insert into document_spisanie_tovarov_tovary values
        ('w-before-sales', 40), ('w-after-sales', 25), ('w-no-store', 10),
        ('w-empty-store', 6), ('w-zero', 5), ('w-before-window', 10000),
        ('w-end-window', 10000), ('w-deleted', 10000), ('w-unposted', 10000)`);
      await tx.$executeRawUnsafe(`insert into document_oprihodovanie_tovarov values
        ('o-no-sales', '2026-08-27', false, true, 's3'),
        ('o-zero', '2026-08-28', false, true, 's-zero')`);
      await tx.$executeRawUnsafe(`insert into document_oprihodovanie_tovarov_tovary values
        ('o-no-sales', 12), ('o-zero', 5)`);
      await tx.$executeRawUnsafe(`insert into document_pereschet_tovarov values
        ('revision', '2026-08-31', 's5', false, true, true)`);
      // The existing last-line-per-document/item rule and additive recount
      // policy remain intact; only the output's key set changes.
      await tx.$executeRawUnsafe(`insert into document_pereschet_tovarov_tovary values
        ('revision', 'shortage', 100, 0, 1),
        ('revision', 'shortage', 100, 80, 2),
        ('revision', 'excess', 10, 17, 3)`);
      const mixed = await getIncomeReport({
        period: "day",
        from: new Date("2026-08-24T00:00:00Z"),
        to: new Date("2026-09-01T00:00:00Z"),
        storeLimit: 12
      });
      assert.equal(mixed.summary.soldQty, 9);
      assert.equal(mixed.summary.revenue, report.summary.revenue);
      assert.equal(mixed.summary.cost, report.summary.cost);
      assert.equal(mixed.summary.losses, 112);
      assert.equal(mixed.summary.grossProfitAfterLoss, -192);
      assert.equal(mixed.summary.dateFrom, report.summary.dateFrom);
      assert.equal(mixed.summary.dateTo, report.summary.dateTo);
      assert.deepEqual(mixed.items, report.items);
      assert.deepEqual(mixed.storeItems, report.storeItems);
      for (const field of ["soldQty", "revenue", "cost", "grossProfit", "losses", "grossProfitAfterLoss"] as const) {
        assert.equal(
          mixed.incomeSeries.reduce((sum, point) => sum + point[field], 0),
          mixed.summary[field],
          `income series reconciles ${field}`
        );
        assert.equal(
          mixed.stores.reduce((sum, store) => sum + store[field], 0),
          mixed.summary[field],
          `income stores reconcile ${field}`
        );
      }
      assert.deepEqual(
        mixed.incomeSeries.map((point) => [point.bucket, point.losses]),
        [
          ["2026-08-24T00:00:00.000Z", 40],
          ["2026-08-25T00:00:00.000Z", 0],
          ["2026-08-26T00:00:00.000Z", 30],
          ["2026-08-27T00:00:00.000Z", -12],
          ["2026-08-28T00:00:00.000Z", 16],
          ["2026-08-29T00:00:00.000Z", 25],
          ["2026-08-30T00:00:00.000Z", 0],
          ["2026-08-31T00:00:00.000Z", 13]
        ]
      );
      const lossOnlyStoreExpectations: Record<string, { name: string; losses: number }> = {
        s3: { name: "Store Three", losses: 28 },
        s4: { name: "Магазин s4", losses: 25 },
        s5: { name: "Магазин s5", losses: 13 },
        "Без магазина": { name: "Без магазина", losses: 16 },
        "s-zero": { name: "Магазин s-zero", losses: 0 }
      };
      assert.deepEqual(
        mixed.stores.map((store) => store.key).sort(),
        ["s1", "s2", ...Object.keys(lossOnlyStoreExpectations)].sort()
      );
      for (const [key, expected] of Object.entries(lossOnlyStoreExpectations)) {
        const store = mixed.stores.find((candidate) => candidate.key === key)!;
        assert.equal(store.name, expected.name);
        assert.equal(store.losses, expected.losses);
        assert.equal(store.grossProfitAfterLoss, 0 - expected.losses);
        assert.equal(store.revenue, 0);
        assert.equal(store.cost, 0);
        assert.equal(store.soldQty, 0);
        assert.equal(store.grossProfit, 0);
        assert.equal(store.marginPct, null);
        assert.equal(store.marginAfterLossPct, null);
      }
      for (const point of mixed.incomeSeries.filter((point) => point.revenue === 0)) {
        assert.equal(point.cost, 0);
        assert.equal(point.soldQty, 0);
        assert.equal(point.grossProfit, 0);
        assert.equal(point.grossProfitAfterLoss, 0 - point.losses);
        assert.equal(point.marginPct, null);
        assert.equal(point.marginAfterLossPct, null);
      }

      // An entirely loss-only window is still a report, not empty detail.
      const onlyLosses = await getIncomeReport({
        period: "day",
        from: new Date("2026-08-27T00:00:00Z"),
        to: new Date("2026-08-29T00:00:00Z"),
        storeLimit: 12
      });
      assert.equal(onlyLosses.summary.revenue, 0);
      assert.equal(onlyLosses.summary.cost, 0);
      assert.equal(onlyLosses.summary.soldQty, 0);
      assert.equal(onlyLosses.summary.losses, 4);
      assert.equal(onlyLosses.summary.grossProfitAfterLoss, -4);
      assert.equal(onlyLosses.summary.marginPct, null);
      assert.equal(onlyLosses.summary.marginAfterLossPct, null);
      assert.equal(onlyLosses.summary.dateFrom, null);
      assert.equal(onlyLosses.summary.dateTo, null);
      assert.deepEqual(onlyLosses.items, []);
      assert.deepEqual(onlyLosses.storeItems, []);
      assert.deepEqual(
        onlyLosses.incomeSeries.map((point) => point.bucket),
        ["2026-08-27T00:00:00.000Z", "2026-08-28T00:00:00.000Z"]
      );
      assert.equal(onlyLosses.incomeSeries.reduce((sum, point) => sum + point.losses, 0), 4);
      assert.equal(onlyLosses.stores.reduce((sum, store) => sum + store.losses, 0), 4);

      // Zero and negative sales denominators are undefined percentages at
      // every level; return quantities/costs retain their original signs.
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('zero-sales', '2026-09-02', false, true, 100, 100, 's-zero-sales'),
        ('negative-sales', '2026-09-03', false, true, 0, 200, 's-negative-sales')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('zero-sales', 'i1', 1, 100)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary values
        ('zero-sales', 'i1', 1, 100), ('negative-sales', 'i1', 2, 200)`);
      for (const fixture of [
        { from: "2026-09-02", to: "2026-09-03", revenue: 0, cost: 0, soldQty: 0 },
        { from: "2026-09-03", to: "2026-09-04", revenue: -200, cost: -200, soldQty: -2 }
      ]) {
        const nonpositive = await getIncomeReport({
          period: "day",
          from: new Date(`${fixture.from}T00:00:00Z`),
          to: new Date(`${fixture.to}T00:00:00Z`),
          storeLimit: 12
        });
        assert.equal(nonpositive.summary.revenue, fixture.revenue);
        assert.equal(nonpositive.summary.cost, fixture.cost);
        assert.equal(nonpositive.summary.soldQty, fixture.soldQty);
        assert.equal(nonpositive.summary.marginPct, null);
        assert.equal(nonpositive.summary.marginAfterLossPct, null);
        for (const details of [nonpositive.incomeSeries, nonpositive.stores, nonpositive.items, nonpositive.storeItems]) {
          assert.equal(details.length, 1);
          assert.equal(details[0].revenue, fixture.revenue);
          assert.equal(details[0].cost, fixture.cost);
          assert.equal(details[0].soldQty, fixture.soldQty);
          assert.equal(details[0].grossProfit, fixture.revenue - fixture.cost);
          assert.equal(details[0].marginPct, null);
        }
        assert.equal(nonpositive.incomeSeries[0].marginAfterLossPct, null);
        assert.equal(nonpositive.stores[0].marginAfterLossPct, null);
      }
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});

// Inventory keeps its historic key-set rule while valuing stock only from
// configured cost or quantity-bearing purchases. Quantity-less purchase rows
// cannot define a weighted unit cost.
test("inventory preserves its key set and uses auditable cost sources", {
  skip: !process.env.ANALYTICS_TEST_DATABASE_URL
}, async () => {
  process.env.DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL;
  process.env.PGSCHEMA = "pg_temp";
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
  // Imported after the environment above so config parses the test database.
  const { prisma } = await import("../src/prisma.js");
  const { getInventoryReport } = await import("../src/services/inventory.js");
  const { config } = await import("../src/config.js");
  // A previous test may have pinned the schema to its own temp namespace.
  config.PGSCHEMA = "pg_temp";
  const original = prisma.$queryRaw;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        ref_key text, date timestamp, deletion_mark boolean,
        posted boolean, summa_dokumenta numeric, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        summa numeric, tsena numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        tsena numeric, summa numeric, summa_nds numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table information_register_sebestoimost_nomenklatury_record_type (
        period timestamp, active boolean, line_number integer, magazin_key text,
        nomenklatura_key text, tsena numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti (
        ref_key text, magazin_key text, date timestamp, deletion_mark boolean,
        posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti_tovary (
        _parent_ref_key text, _parent_line_index integer, nomenklatura_key text,
        tsena numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table accumulation_register_tovary_na_skladah_balance (
        nomenklatura_key text, sklad_key text, kolichestvo_balance numeric,
        rezerv_balance numeric, balance_period timestamp) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_nomenklatura (ref_key text, description text) on commit drop`);
      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values ('k1', 'Item One')`);
      // Inventory stock-days must use the handbook's fixed 28-day demand window,
      // even when the selected reporting range starts later.
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('r0', '2026-08-10', false, true, 100, 's1'),
        ('r1', '2026-08-25', false, true, 500, 's1')`);
      // The 10 August sale falls outside the selected range but inside its last 28 days.
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('r0', 'k1', 2, 100, 50), ('r1', 'k1', 4, 200, 50), ('r1', 'n1', null, 50, 50)`);

      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov values
        ('p1', '2026-08-20', false, true)`);
      // n1 and p1 have no quantity, so they cannot establish a weighted cost.
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov_tovary values
        ('p1', 'k1', 10, 50, 500, 0),
        ('p1', 'n1', null, 100, 100, 0),
        ('p1', 'p1', null, 100, 100, 0)`);

      await tx.$executeRawUnsafe(`insert into accumulation_register_tovary_na_skladah_balance values
        ('b1', 's1', 5, 1, '2026-08-31'),
        ('p1', 's1', 2, 0, '2026-08-31'),
        ('k1', 's1', 6, 1, '2026-08-31')`);
      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;

      const report = await getInventoryReport({
        period: "day",
        from: new Date("2026-08-24"),
        to: new Date("2026-09-01")
      });
      const byKey = new Map(report.items.map((item) => [item.key, item]));

      // n1 has neither a quantity nor a balance snapshot, so it never appears.
      assert.deepEqual([...byKey.keys()].sort(), ["b1", "k1", "p1"]);

      // Balance-only key: appears with its snapshot, no purchase cost.
      assert.deepEqual(
        [byKey.get("b1")!.stockQty, byKey.get("b1")!.stockCost, byKey.get("b1")!.name],
        [5, 0, "b1"]
      );

      // Quantity-less purchase lines no longer invent an unauditable unit cost.
      assert.deepEqual(
        [byKey.get("p1")!.stockQty, byKey.get("p1")!.stockCost],
        [2, 0]
      );

      // Lifetime quantities and the fixed handbook sales window use different
      // boundaries: the 10 August sale is outside `from` but inside the last 28 days.
      const k1 = byKey.get("k1")!;
      assert.equal(k1.name, "Item One");
      assert.equal(k1.totalPurchased, 10);
      assert.equal(k1.totalSold, 6);
      assert.equal(k1.stockQty, 6);
      assert.equal(k1.stockCost, 300);
      assert.equal(k1.recentSoldQty, 6);
      assert.equal(k1.recentDaysActive, 2);
      assert.equal(k1.dailySalesRate, 6 / 28);
      assert.equal(k1.daysOfStock, 28);
      assert.equal(k1.lastSaleDate, "2026-08-25T00:00:00.000Z");
      // Inventory age is measured against the exclusive `to` bound itself.
      assert.equal(k1.daysSinceLastSale, 7);

      const narrower = await getInventoryReport({
        period: "day",
        from: new Date("2026-08-26"),
        to: new Date("2026-09-01")
      });
      const narrowerK1 = narrower.items.find((item) => item.key === "k1")!;
      assert.deepEqual(
        [narrowerK1.recentSoldQty, narrowerK1.dailySalesRate, narrowerK1.daysOfStock],
        [6, 6 / 28, 28]
      );

      // Equal business timestamps must not let physical row/index order change
      // inventory money. Both costs/prices remain real source candidates.
      await tx.$executeRawUnsafe(`insert into document_ustanovka_sebestoimosti values
        ('cost-a', null, '2026-08-30', false, true), ('cost-z', null, '2026-08-30', false, true)`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_sebestoimosti_tovary values
        ('cost-a', 0, 'k1', 40), ('cost-z', 0, 'k1', 60)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('sale-a', '2026-08-26', false, true, 45, 's1'), ('sale-z', '2026-08-26', false, true, 75, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('sale-a', 'k1', 1, 45, 45), ('sale-z', 'k1', 1, 75, 75)`);
      const tied = await getInventoryReport({ period: "day", from: new Date("2026-08-24"), to: new Date("2026-09-01") });
      const tiedItem = tied.items.find((item) => item.key === "k1")!;
      assert.equal(tiedItem.stockQty, 6);
      assert.equal(tiedItem.stockCost, 360);
      assert.equal(tiedItem.stockRetailValue, 450);

      await tx.$executeRawUnsafe(`delete from document_ustanovka_sebestoimosti_tovary where _parent_ref_key in ('cost-a', 'cost-z')`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_sebestoimosti_tovary values
        ('cost-z', 0, 'k1', 60), ('cost-a', 0, 'k1', 40)`);
      await tx.$executeRawUnsafe(`delete from document_otchet_o_roznichnyh_prodazhah_tovary where _parent_ref_key in ('sale-a', 'sale-z')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('sale-z', 'k1', 1, 75, 75), ('sale-a', 'k1', 1, 45, 45)`);
      const reordered = await getInventoryReport({ period: "day", from: new Date("2026-08-24"), to: new Date("2026-09-01") });
      const reorderedItem = reordered.items.find((item) => item.key === "k1")!;
      assert.deepEqual([reorderedItem.stockCost, reorderedItem.stockRetailValue], [tiedItem.stockCost, tiedItem.stockRetailValue]);
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});
