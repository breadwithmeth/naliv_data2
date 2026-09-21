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
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        _id integer primary key, ref_key text, date timestamp, deletion_mark boolean,
        posted boolean, summa_dokumenta numeric, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        summa numeric, protsent_skidki_natsenki numeric) on commit drop`);
      for (const table of ["catalog_magaziny", "catalog_nomenklatura"]) {
        await tx.$executeRawUnsafe(`create temp table ${table} (ref_key text, description text) on commit drop`);
      }
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        (1, 'a', '2026-08-24', null, true, 180, 's1'),
        (2, 'b', '2026-08-25', false, true, 100, 's1'),
        (3, 'c', '2026-08-26', false, true, 50, null),
        (4, 'deleted', '2026-08-26', true, true, 10000, 's1'),
        (5, 'unposted', '2026-08-26', false, false, 10000, 's1'),
        (6, 'nullposted', '2026-08-26', false, null, 10000, 's1'),
        (7, 'before', '2026-08-23', false, true, 10000, 's1'),
        (8, 'end', '2026-09-01', false, true, 10000, 's1'),
        (9, 'zero', '2026-08-26', false, true, 0, 's1'),
        (10, 'nullamount', '2026-08-26', false, true, null, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('a', 'i1', 1, 90, 10), ('a', 'i1', 1, 90, 10),
        ('a', 'i2', 1, 0, 100), ('a', 'i3', 0, 10, 50),
        ('b', 'i1', 2, 100, null), ('before', 'i1', 1000, 10000, 10),
        ('end', 'i1', 1000, 10000, 10), ('deleted', 'i1', 1000, 10000, 10)`);
      // Duplicate catalog references must not multiply aggregate metrics.
      await tx.$executeRawUnsafe(`insert into catalog_magaziny values ('s1', 'Store'), ('s1', 'Store')`);
      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values ('i1', 'Item'), ('i1', 'Item')`);
      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      const params = { period: "day" as const, from: new Date("2026-08-24"), to: new Date("2026-09-01"), storeLimit: 12 };
      const sales = await getSalesReport(params);
      assert.equal(sales.summary.revenue, 330);
      assert.equal(sales.summary.orderCount, 3);
      assert.equal(sales.summary.reportCount, 3);
      assert.equal(sales.summary.avgItemsPerCheck, 2.5); // No lines remains NULL, not zero.
      assert.equal(sales.revenueSeries.length, 3);
      assert.equal(sales.heatmap.cells.reduce((sum, cell) => sum + cell.revenue, 0), 330);
      const [namespace] = await tx.$queryRaw<Array<{ name: string }>>`
        select nspname::text as name from pg_namespace where oid = pg_my_temp_schema()
      `;
      config.PGSCHEMA = namespace.name;
      prisma.$queryRawUnsafe = tx.$queryRawUnsafe.bind(tx) as typeof prisma.$queryRawUnsafe;
      const table = "document_otchet_o_roznichnyh_prodazhah";
      const profile = await getColumnSummaries(table, await getColumns(table));
      assert.deepEqual(profile.numericSummaries.find((column) => column.column === "_id"), {
        column: "_id", min: "1", max: "10", avg: 5.5, filled: 10
      });
      assert.equal(profile.numericSummaries.find((column) => column.column === "summa_dokumenta")?.filled, 9);
      assert.deepEqual(profile.temporalSummaries.find((column) => column.column === "date"), {
        column: "date", min: "2026-08-23 00:00:00", max: "2026-09-01 00:00:00", filled: 10
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
  const original = prisma.$queryRaw;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        ref_key text, date timestamp, deletion_mark boolean,
        posted boolean, summa_dokumenta numeric, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov_tovary (
        _parent_ref_key text, nomenklatura_key text, tsena numeric) on commit drop`);
      for (const table of ["catalog_magaziny", "catalog_nomenklatura"]) {
        await tx.$executeRawUnsafe(`create temp table ${table} (ref_key text, description text) on commit drop`);
      }
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov values
        ('p1', '2026-08-20', false, true)`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov_tovary values
        ('p1', 'i1', 100), ('p1', 'i2', 50)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('r1', '2026-08-25', false, true, 1000, 's1'),
        ('r2', '2026-08-30', false, true, 500, 's1'),
        ('r3', '2026-08-26', false, true, 300, 's2')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('r1', 'i1', 2, 200), ('r2', 'i1', 1, 100), ('r2', 'i2', 3, 150), ('r3', 'i1', 4, 300)`);
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

      // Totals come from the rollup row; the series rows must add up to it.
      assert.equal(report.summary.revenue, 750);
      assert.equal(report.summary.cost, 850);
      assert.equal(report.summary.grossProfit, -100);
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
        report.stores.map((store) => [store.key, store.name, store.revenue, store.cost, store.grossProfit]),
        [
          ["s1", "Store One", 450, 450, 0],
          ["s2", "Магазин s2", 300, 400, -100]
        ]
      );
      assert.deepEqual(
        report.items.map((item) => [item.key, item.name, item.soldQty, item.revenue, item.cost]),
        [
          ["i1", "Item One", 7, 600, 700],
          ["i2", "i2", 3, 150, 150]
        ]
      );
      assert.deepEqual(
        report.storeItems.map((row) => [row.storeKey, row.storeName, row.itemKey, row.itemName, row.revenue, row.cost]),
        [
          ["s1", "Store One", "i1", "Item One", 300, 300],
          ["s1", "Store One", "i2", "i2", 150, 150],
          ["s2", "Магазин s2", "i1", "Item One", 300, 400]
        ]
      );
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});

// Inventory merges two sweeps per source table into one, so the resulting key set
// must still follow the old rule: a key appears only via a balance snapshot, a
// purchase line with a quantity, or a sales line with a quantity. Purchase lines
// without a quantity may still supply a price for keys another source added.
test("inventory keeps its key set and price enrichment after merging scans", {
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
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric, tsena numeric, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table accumulation_register_tovary_na_skladah_balance (
        nomenklatura_key text, sklad_key text, kolichestvo_balance numeric,
        rezerv_balance numeric, balance_period timestamp) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_nomenklatura (ref_key text, description text) on commit drop`);

      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values ('k1', 'Item One')`);
      // One valid retail report; the sales lines below all hang off it.
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('r1', '2026-08-25', false, true, 500, 's1')`);
      // k1 sells with a quantity; n1 only ever has quantity-less lines.
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('r1', 'k1', 4, 200), ('r1', 'n1', null, 50)`);

      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov values
        ('p1', '2026-08-20', false, true)`);
      // k1 and p1 are priced through quantity-less lines for p1 only.
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov_tovary values
        ('p1', 'k1', 10, 50, 500), ('p1', 'n1', null, 100, 100), ('p1', 'p1', null, 100, 100)`);

      await tx.$executeRawUnsafe(`insert into accumulation_register_tovary_na_skladah_balance values
        ('b1', 's1', 5, 1, '2026-08-31'), ('p1', 's1', 2, 0, '2026-08-31')`);
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

      // Quantity-less purchase line still supplies the price for a balance key.
      assert.deepEqual(
        [byKey.get("p1")!.stockQty, byKey.get("p1")!.stockCost],
        [2, 200]
      );

      // Lifetime and period figures survive the merge.
      const k1 = byKey.get("k1")!;
      assert.equal(k1.name, "Item One");
      assert.equal(k1.totalPurchased, 10);
      assert.equal(k1.totalSold, 4);
      assert.equal(k1.stockQty, 6);
      assert.equal(k1.stockCost, 300);
      assert.equal(k1.recentSoldQty, 4);
      assert.equal(k1.recentDaysActive, 1);
      assert.equal(k1.lastSaleDate, "2026-08-25T00:00:00.000Z");
      // Inventory measures against the exclusive `to` bound itself.
      assert.equal(k1.daysSinceLastSale, 7);
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});
