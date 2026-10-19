import assert from "node:assert/strict";
import { test } from "node:test";
import { chronologicalAverage, evaluateTurnoverRisks, planTurnoverTransfers, salesChange, turnoverRatios } from "../src/services/turnover-domain.js";
import type { TurnoverNorms, TurnoverRow } from "../src/services/turnover-types.js";

const norms: TurnoverNorms = {
  minDays: 3, staleDays: 30, criticalStaleDays: 60, excessDays: 45,
  stopDays: 60, changePct: 20, targetDays: 30, highStockCost: null, leadTimeDays: null
};
const riskInput = {
  closingQty: 10, closingCost: 100, stockDays: null, periodQuantity: 0,
  recentQuantity: 0, sales14Quantity: 0, dailyQuantity: 0,
  change: { pct: null, status: "no-base" as const },
  availabilityComplete: true, daysWithoutMovement: 65, noSalesHistory: false,
  stockAgeDays: 100, openOrderQty: 0, nextDeliveryDate: null,
  minimumStock: null, asOf: "2026-10-19"
};

// Removing the positive-stock gate would incorrectly freeze empty assortment rows.
test("zero stock never becomes stagnant solely because its last sale was old", () => {
  const result = evaluateTurnoverRisks({ ...riskInput, closingQty: 0, closingCost: 0 }, norms);
  assert.equal(result.risks.includes("stagnant"), false);
  assert.deepEqual(result.stagnantCost, { d30: 0, d60: 0, d90: 0 });
  assert.equal(result.recommendations.some((row) => row.code === "critical-stale"), false);
});

// Ignoring availability would turn lost availability into an asserted demand fall.
test("demand decline and purchase stop are withheld when stock availability is incomplete", () => {
  const result = evaluateTurnoverRisks({
    ...riskInput, stockDays: 80, recentQuantity: 14, sales14Quantity: 14,
    periodQuantity: 14, dailyQuantity: 1, daysWithoutMovement: 1,
    availabilityComplete: false, change: { pct: -50, status: "comparable" }
  }, norms);
  assert.equal(result.recommendations.some((row) => row.code === "demand-decline" || row.code === "stop-purchase"), false);
  assert.equal(result.recommendations.some((row) => row.code === "availability"), true);
});

// Dropping net in-transit quantities would recommend a duplicate purchase.
test("order recommendations subtract net open orders and retain unknown monetary norms", () => {
  const result = evaluateTurnoverRisks({
    ...riskInput, closingQty: 2, stockDays: 2, recentQuantity: 14,
    sales14Quantity: 14, periodQuantity: 14, dailyQuantity: 1,
    daysWithoutMovement: 1, openOrderQty: 7, minimumStock: 5,
    change: { pct: 0, status: "comparable" }
  }, norms);
  assert.equal(result.deficitQty, 28);
  assert.equal(result.recommendedOrderQty, 21);
  assert.equal(result.recommendations.some((row) => row.code === "lead-time-unknown"), true);
  assert.equal(result.recommendations.some((row) => row.code === "frozen-money"), false);
});

// No sales over the store's whole history is not proof a newly stocked SKU is old.
test("new assortment without lifetime sales is not declared sixty-day stagnant", () => {
  const result = evaluateTurnoverRisks({
    ...riskInput, noSalesHistory: true, daysWithoutMovement: null, stockAgeDays: 2
  }, norms);
  assert.equal(result.risks.includes("stagnant"), false);
  assert.equal(result.stagnantCost.d30, 0);
});

test("measured zero demand keeps a finite zero target and movable excess", () => {
  const result = evaluateTurnoverRisks({ ...riskInput }, norms);
  assert.equal(result.excessQty, 10);
  assert.equal(result.recommendedOrderQty, 0);
});

test("late transit raises a supply gap even when it removes the need for another order", () => {
  const result = evaluateTurnoverRisks({
    ...riskInput, closingQty: 2, stockDays: 2, periodQuantity: 14, recentQuantity: 14,
    sales14Quantity: 14, dailyQuantity: 1, daysWithoutMovement: 1, openOrderQty: 100,
    nextDeliveryDate: "2026-10-25", change: { pct: 0, status: "comparable" }
  }, norms);
  assert.equal(result.recommendedOrderQty, 0);
  assert.equal(result.recommendations.some((row) => row.code === "delivery-gap"), true);
});

test("a mapped stock minimum is a target floor rather than simultaneous excess and shortage", () => {
  const result = evaluateTurnoverRisks({
    ...riskInput, closingQty: 50, stockDays: 50, periodQuantity: 14, recentQuantity: 14,
    sales14Quantity: 14, dailyQuantity: 1, daysWithoutMovement: 1, minimumStock: 100,
    change: { pct: 0, status: "comparable" }
  }, norms);
  assert.equal(result.excessQty, 0);
  assert.equal(result.deficitQty, 50);
  assert.equal(result.recommendedOrderQty, 50);
  assert.equal(result.risks.includes("overstock"), false);
  assert.equal(result.risks.includes("deficit"), true);
});

test("long lead time increases the target even when the default thirty-day target is covered", () => {
  const result = evaluateTurnoverRisks({
    ...riskInput, closingQty: 40, stockDays: 40, periodQuantity: 14, recentQuantity: 14,
    sales14Quantity: 14, dailyQuantity: 1, daysWithoutMovement: 1,
    change: { pct: 0, status: "comparable" }
  }, { ...norms, leadTimeDays: 60 });
  assert.equal(result.recommendedOrderQty, 20);
  assert.equal(result.excessQty, 0);
});

test("a real minimum without observed demand does not manufacture a purchase", () => {
  const result = evaluateTurnoverRisks({ ...riskInput, closingQty: 50, minimumStock: 100, daysWithoutMovement: 1 }, norms);
  assert.equal(result.recommendedOrderQty, 0);
  assert.equal(result.recommendations.some((row) => row.code === "order"), false);
});

test("arithmetic extremes retain finite means without infinite financial metrics", () => {
  assert.equal(chronologicalAverage([Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]), Number.MAX_VALUE);
  assert.deepEqual(turnoverRatios(Number.MAX_VALUE, Number.MIN_VALUE, 30), { coefficient: null, days: null });
  assert.deepEqual(salesChange(Number.MAX_VALUE, Number.MIN_VALUE), { pct: null, status: "missing" });
});

// Reusing a donor for every recipient would exceed actual movable stock.
test("transfers cap both ends and never cross stores or recorded units", () => {
  const row = (store: string, excess: number, deficit: number, unit = "шт"): TurnoverRow => ({
    sku: "item", name: "Item", storeKey: store, storeName: store, unit,
    closingQty: excess || 1, excessQty: excess, deficitQty: deficit,
    openOrderQty: 0, recommendedOrderQty: deficit
  } as TurnoverRow);
  const transfers = planTurnoverTransfers([
    row("a", 6, 0), row("b", 0, 4), row("c", 0, 5), row("a", 0, 9), row("d", 0, 9, "л")
  ]);
  assert.equal(transfers.reduce((sum, transfer) => sum + transfer.quantity, 0), 6);
  assert.equal(transfers.some((transfer) => transfer.fromStoreKey === transfer.toStoreKey), false);
  assert.equal(transfers.some((transfer) => transfer.toStoreKey === "d"), false);
  assert.ok(transfers.filter((transfer) => transfer.toStoreKey === "b").reduce((sum, transfer) => sum + transfer.quantity, 0) <= 4);
});

test("turnover source boundaries retain historical daily cost, returns, gaps, units and net transit", {
  skip: !process.env.ANALYTICS_TEST_DATABASE_URL
}, async (t) => {
  process.env.DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL;
  process.env.PGSCHEMA = "pg_temp";
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
  // These imports must follow isolated database configuration: the singleton
  // client captures DATABASE_URL on first module evaluation.
  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  const { getTurnoverOptions, getTurnoverReport, getTurnoverRow, turnoverQuerySchema } = await import("../src/services/turnover.js");
  const originalQuery = prisma.$queryRaw;
  const originalSchema = config.PGSCHEMA;
  config.PGSCHEMA = "pg_temp";
  try {
    await prisma.$transaction(async (tx) => {
      const definitions = [
        "catalog_magaziny (ref_key text, description text, deletion_mark boolean default false)",
        "catalog_sklady (ref_key text, description text, magazin_key text, deletion_mark boolean default false)",
        "catalog_marki (ref_key text, description text)",
        "catalog_tovarnye_gruppy (ref_key text, description text)",
        "catalog_bazovye_edinitsy_izmereniya (ref_key text, description text, naimenovanie_polnoe text)",
        "catalog_nomenklatura (ref_key text, description text, parent_key text, is_folder boolean, artikul text, code text, tovarnaya_gruppa_key text, marka_key text, edinitsa_izmereniya_key text)",
        "accumulation_register_tovary_na_skladah_balance (balance_period timestamp, sklad_key text, nomenklatura_key text, harakteristika_key text, kolichestvo_balance numeric)",
        "document_otchet_o_roznichnyh_prodazhah (ref_key text, date timestamp, magazin_key text, deletion_mark boolean, posted boolean)",
        "document_otchet_o_roznichnyh_prodazhah_tovary (\"_parent_ref_key\" text, nomenklatura_key text, harakteristika_key text, sklad_key text, kolichestvo numeric, summa numeric)",
        "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary (\"_parent_ref_key\" text, nomenklatura_key text, harakteristika_key text, sklad_key text, kolichestvo numeric, summa numeric)",
        "information_register_sebestoimost_nomenklatury_record_type (period timestamp, active boolean, magazin_key text, nomenklatura_key text, harakteristika_key text, tsena numeric, line_number bigint)",
        "document_ustanovka_sebestoimosti (ref_key text, date timestamp, magazin_key text, deletion_mark boolean, posted boolean)",
        "document_ustanovka_sebestoimosti_tovary (\"_parent_ref_key\" text, \"_parent_line_index\" bigint, nomenklatura_key text, harakteristika_key text, tsena numeric)",
        "document_zakaz_postavschiku (ref_key text, date timestamp, magazin_key text, sklad_key text, deletion_mark boolean, posted boolean, zakryt boolean, data_postupleniya timestamp)",
        "document_zakaz_postavschiku_tovary (\"_parent_ref_key\" text, nomenklatura_key text, kolichestvo numeric)",
        "document_postuplenie_tovarov (ref_key text, date timestamp, deletion_mark boolean, posted boolean, zakaz_postavschiku_key text)",
        "document_postuplenie_tovarov_tovary (\"_parent_ref_key\" text, nomenklatura_key text, kolichestvo numeric)",
        "document_chek_kkm (ref_key text, date timestamp, deletion_mark boolean, posted boolean)",
        "document_chek_kkm_tovary (\"_parent_ref_key\" text, nomenklatura_key text, shtrihkod text)"
      ];
      for (const definition of definitions) await tx.$executeRawUnsafe(`create temp table ${definition} on commit drop`);
      await tx.$executeRawUnsafe("insert into catalog_magaziny values ('s1','One'), ('s2','Two')");
      await tx.$executeRawUnsafe("insert into catalog_sklady values ('w1','Warehouse One','s1'), ('w2','Warehouse Two','s2')");
      await tx.$executeRawUnsafe("insert into catalog_bazovye_edinitsy_izmereniya values ('u1','шт','Штука'), ('u2','шт','Штука'), ('u3','л','Литр')");
      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values
        ('folder','Group',null,true,null,null,null,null,null),
        ('i1','Item One','folder',false,'A1','001',null,null,'u1'),
        ('i2','Missing Cost','folder',false,null,'002',null,null,'u2'),
        ('i3','Litres','folder',false,null,'003',null,null,'u3'),
        ('i4','Historic Assortment','folder',false,null,'004',null,null,'u1'),
        ('i5','Historic Returns Only','folder',false,null,'005',null,null,'u1')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah
        select 'rr-' || s || '-' || day::date, day, s, false, true
        from generate_series('2026-06-01'::timestamp,'2026-08-03'::timestamp,interval '1 day') day
        cross join (values ('s1'),('s2')) stores(s)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('rr-s1-2026-08-01','i1','','w1',2,200),
        ('rr-s1-2026-08-02','i1','','w1',4,400),
        ('rr-s2-2026-06-01','i1','','w2',1,100)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary values
        ('rr-s1-2026-08-02','i1','','w1',1,100),
        ('rr-s1-2026-08-03','i1','','w1',-2,-200),
        ('rr-s1-2026-06-03','i5','','w1',1,100)`);
      await tx.$executeRawUnsafe(`insert into accumulation_register_tovary_na_skladah_balance values
        ('2026-08-01','w1','i1','',10), ('2026-08-02','w1','i1','',12),
        ('2026-08-03','w1','i1','',8), ('2026-08-04','w1','i1','',16),
        ('2026-08-04','w1','i2','',5), ('2026-08-04','w1','i3','',7),
        ('2026-08-04','w2','i1','',20), ('2026-06-03','w1','i4','',1)`);
      await tx.$executeRawUnsafe(`insert into information_register_sebestoimost_nomenklatury_record_type values
        ('2026-07-01',true,'s1','i1','',10,1),
        ('2026-08-02 12:00',true,'s1','i1','',20,2),
        ('2026-08-05',true,'s1','i1','',900,3)`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_sebestoimosti values
        ('cost-other','2026-07-01','s2',false,true)`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_sebestoimosti_tovary values
        ('cost-other',1,'i2','',999)`);
      await tx.$executeRawUnsafe(`insert into document_zakaz_postavschiku values
        ('o1','2026-08-01','s1','w1',false,true,false,'2026-08-06'),
        ('future','2026-08-05','s1','w1',false,true,false,'2026-08-06'),
        ('closed','2026-08-01','s1','w1',false,true,true,'2026-08-06')`);
      await tx.$executeRawUnsafe(`insert into document_zakaz_postavschiku_tovary values
        ('o1','i1',10), ('future','i1',100), ('closed','i1',100)`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov values
        ('r1','2026-08-02',false,true,'o1'), ('future-receipt','2026-08-05',false,true,'o1')`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov_tovary values
        ('r1','i1',3), ('future-receipt','i1',7)`);
      await tx.$executeRawUnsafe("insert into document_chek_kkm values ('c1','2026-08-01',false,true)");
      await tx.$executeRawUnsafe("insert into document_chek_kkm_tovary values ('c1','i1','460123')");
      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      const params = { from: "2026-08-01", to: "2026-08-04", store: ["s1"] };
      const report = await getTurnoverReport(params);
      const item = report.rows.find((row) => row.sku === "i1")!;
      assert.equal(item.openingQty, 10);
      assert.equal(item.closingQty, 16);
      assert.equal(item.averageQty, 11);
      assert.equal(item.periodSales.quantity, 3);
      assert.equal(item.periodSales.cost, 10);
      assert.equal(item.averageCost, 190);
      assert.equal(item.closingCost, 320);
      assert.equal(item.lastSaleDate, "2026-08-02");
      assert.equal(item.daysWithoutMovement, 1);
      assert.equal(item.openOrderQty, 7);
      assert.equal(item.nextDeliveryDate, "2026-08-06");
      assert.deepEqual(item.barcodes, ["460123"]);
      assert.equal(report.rows.find((row) => row.sku === "i2")!.closingCost, null);
      assert.equal(report.rows.every((row) => row.daily.length === 0), true);
      const itemDetail = await getTurnoverRow({ ...params, auditGroup: item.key });
      assert.equal(itemDetail.row.key, item.key);
      assert.equal(itemDetail.row.periodSales.quantity, 3);
      assert.equal(itemDetail.row.periodSales.cost, 10);
      assert.equal(itemDetail.row.daily.length, 3);
      await assert.rejects(getTurnoverRow({ ...params, store: ["s2"], auditGroup: item.key }), /Строка/);
      const skuAudit = await getTurnoverReport({ ...params, sku: "i2" });
      assert.deepEqual(skuAudit.rows[0]!.daily.map((day) => day.quantity), [0, 0, 5]);
      const grouped = await getTurnoverReport({ ...params, groupBy: "store" });
      assert.equal(grouped.rows.length, 3);
      assert.equal(new Set(grouped.rows.map((row) => row.unit)).size, 3);
      const groupAudit = await getTurnoverReport({ ...params, groupBy: "store", auditGroup: grouped.rows[0]!.key });
      assert.equal(groupAudit.rows.filter((row) => row.daily.length > 0).length, 1);
      assert.equal(groupAudit.rows.find((row) => row.key === grouped.rows[0]!.key)!.daily.length, 3);
      const filtered = await getTurnoverReport({ ...params, risk: "no-sales" });
      assert.equal(filtered.summary.totalRowCount, 5);
      assert.equal(filtered.summary.noSalesCount, report.summary.noSalesCount);
      assert.equal(report.rows.find((row) => row.sku === "i4")!.closingQty, 0);
      assert.equal(report.rows.find((row) => row.sku === "i4")!.risks.includes("stagnant"), false);
      assert.equal(report.rows.find((row) => row.sku === "i5")!.noSalesHistory, true);
      const byDay = await getTurnoverReport({ ...params, groupBy: "day" });
      assert.equal(byDay.summary.totalRowCount, report.summary.totalRowCount);
      assert.equal(byDay.summary.noSalesCount, report.summary.noSalesCount);
      const beforeHistory = await getTurnoverReport({ from: "2026-05-20", to: "2026-05-23", sku: "i1", store: ["s1"] });
      assert.equal(beforeHistory.rows[0]!.periodSales.quantity, null);
      assert.equal(beforeHistory.rows[0]!.closingQty, null);
      assert.equal(turnoverQuerySchema.safeParse({ ...params, comparisonFrom: "2026-08-02", comparisonTo: "2026-08-05" }).success, false);
      assert.equal(turnoverQuerySchema.safeParse({ ...params, comparisonFrom: "2026-07-20", comparisonTo: "2026-07-22" }).success, false);
      assert.equal(turnoverQuerySchema.safeParse({ ...params, norms: "not-json" }).success, false);
      await t.test("sample reports consolidate each SKU across shops and warehouses and recompute turnover", async () => {
        await tx.$executeRawUnsafe("savepoint consolidated_sample");
        try {
          await tx.$executeRawUnsafe("insert into catalog_sklady values ('w1-extra','Second warehouse in One','s1')");
          await tx.$executeRawUnsafe(`insert into accumulation_register_tovary_na_skladah_balance values
            ('2026-08-01','w1-extra','i1','',1), ('2026-08-02','w1-extra','i1','',2),
            ('2026-08-03','w1-extra','i1','',4), ('2026-08-04','w1-extra','i1','',6),
            ('2026-08-01','w2','i1','',30), ('2026-08-02','w2','i1','',40),
            ('2026-08-03','w2','i1','',50)`);
          await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
            ('rr-s1-2026-08-01','i1','','w1-extra',1,100),
            ('rr-s1-2026-08-02','i1','','w1-extra',2,200),
            ('rr-s2-2026-08-01','i1','','w2',10,1000)`);
          await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary values
            ('rr-s2-2026-08-02','i1','','w2',2,200)`);
          await tx.$executeRawUnsafe(`insert into information_register_sebestoimost_nomenklatury_record_type values
            ('2026-07-01',true,'s2','i1','',3,1)`);
          const request = { from: params.from, to: params.to, profile: "sample" as const, sku: "i1" };
          const consolidated = await getTurnoverReport(request);
          assert.deepEqual(consolidated.rows.map((row) => row.sku), ["i1"]);
          const total = consolidated.rows[0]!;
          assert.equal(total.article, "A1");
          assert.equal(total.openingQty, 41);
          assert.equal(total.closingQty, 42);
          assert.deepEqual(total.daily.map((day) => day.quantity), [54, 62, 42]);
          // The first closing uses store One's old price 10; later closings use 20.
          assert.deepEqual(total.daily.map((day) => day.stockCost), [260, 390, 500]);
          assert.equal(total.averageQty, 55);
          assert.equal(total.averageCost, 385);
          assert.equal(total.periodSales.quantity, 14);
          assert.equal(total.periodSales.cost, 64);
          assert.equal(total.turnoverQty, 14 / 55);
          assert.equal(total.turnoverCost, 64 / 385);
          assert.equal(total.turnoverQtyDays, 3 / (14 / 55));
          const oneShop = await getTurnoverReport({ ...request, store: ["s1"] });
          assert.deepEqual(oneShop.rows[0]!.daily.map((day) => day.quantity), [14, 12, 22]);
          assert.equal(oneShop.rows[0]!.periodSales.quantity, 6);
          assert.equal(oneShop.rows[0]!.periodSales.cost, 40);
          const oneWarehouse = await getTurnoverReport({ ...request, warehouse: "w1" });
          assert.deepEqual(oneWarehouse.rows[0]!.daily.map((day) => day.quantity), [12, 8, 16]);
          assert.equal(oneWarehouse.rows[0]!.periodSales.quantity, 3);
          assert.equal(oneWarehouse.rows[0]!.periodSales.cost, 10);
          const detail = await getTurnoverRow({ ...request, auditGroup: total.key });
          assert.equal(detail.row.periodSales.quantity, 14);
          assert.deepEqual(detail.row.daily.map((day) => day.quantity), [54, 62, 42]);
          await assert.rejects(getTurnoverRow({ ...request, sku: "i2", auditGroup: total.key }), /Строка/);
          const otherProducts = await getTurnoverReport({ from: params.from, to: params.to, profile: "sample" });
          assert.equal(otherProducts.rows.filter((row) => row.sku === "i1").length, 1);
          assert.equal(otherProducts.rows.find((row) => row.sku === "i2")!.closingQty, 5);
          assert.equal(otherProducts.rows.find((row) => row.sku === "i3")!.closingQty, 7);
          assert.notEqual(otherProducts.rows.find((row) => row.sku === "i1")!.unit,
            otherProducts.rows.find((row) => row.sku === "i2")!.unit);
          await tx.$executeRawUnsafe(`insert into information_register_sebestoimost_nomenklatury_record_type values
            ('2026-08-02',true,'s2','i1','',0,2)`);
          const missingCost = (await getTurnoverReport(request)).rows[0]!;
          assert.equal(missingCost.periodSales.quantity, 14);
          assert.equal(missingCost.periodSales.cost, null);
          assert.equal(missingCost.averageCost, null);
          assert.equal(missingCost.turnoverCost, null);
          await tx.$executeRawUnsafe("delete from accumulation_register_tovary_na_skladah_balance where balance_period='2026-08-03'");
          const missingStock = (await getTurnoverReport(request)).rows[0]!;
          assert.deepEqual(missingStock.daily.map((day) => day.quantity), [54, null, 42]);
          assert.equal(missingStock.averageQty, null);
          assert.equal(missingStock.turnoverQty, null);
        } finally {
          await tx.$executeRawUnsafe("rollback to savepoint consolidated_sample");
          await tx.$executeRawUnsafe("release savepoint consolidated_sample");
        }
      });
      await t.test("consolidated SKU details do not add shops absent from the original population", async () => {
        await tx.$executeRawUnsafe("insert into catalog_magaziny values ('office','Office without retail history')");
        try {
          const request = { from: params.from, to: params.to, profile: "sample" as const, search: "Item One" };
          const sample = await getTurnoverReport(request);
          assert.deepEqual(sample.rows.map((row) => row.sku), ["i1"]);
          assert.equal(sample.rows[0]!.periodSales.quantity, 3);
          const detail = await getTurnoverRow({ ...request, auditGroup: sample.rows[0]!.key });
          assert.equal(detail.row.periodSales.quantity, 3);
          assert.deepEqual(detail.row.daily.map((day) => day.quantity), [12, 8, 36]);
        } finally {
          await tx.$executeRawUnsafe("delete from catalog_magaziny where ref_key='office'");
        }
      });
      await t.test("physical stores merge duplicate legal entities, exclude offices by default and keep SKU/search populations equal", async () => {
        await tx.$executeRawUnsafe("savepoint physical_scope");
        try {
          await tx.$executeRawUnsafe(`insert into catalog_magaziny values
            ('d1','ИП One г.Тест ул.Мира 1'), ('d2','ИП Two г.Тест ул.Мира 1'), ('office2','Офис Тест')`);
          await tx.$executeRawUnsafe(`insert into catalog_sklady values
            ('dw1','Склад d1','d1'), ('dw2','Склад d2','d2'), ('ow','Офисный склад','office2'),
            ('unused','Караганда Пивоварня - не использовать','d1')`);
          await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values
            ('office-item','Office Only','folder',false,null,'OFF','0ff1ce',null,'u1')`);
          await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
            ('rd1-2026-08-01','2026-08-01','d1',false,true),
            ('rd1-2026-08-02','2026-08-02','d1',false,true),
            ('rd1-2026-08-03','2026-08-03','d1',false,true)`);
          await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
            ('rd1-2026-08-01','i1','','dw1',2,200),
            ('rd1-2026-08-02','i1','','dw1',4,400),
            ('rd1-2026-08-03','i1','','dw1',3,300)`);
          await tx.$executeRawUnsafe(`insert into accumulation_register_tovary_na_skladah_balance values
            ('2026-08-01','dw1','i1','',10), ('2026-08-02','dw1','i1','',12),
            ('2026-08-03','dw1','i1','',8), ('2026-08-04','dw1','i1','',16),
            ('2026-08-01','dw2','i1','',20), ('2026-08-02','dw2','i1','',24),
            ('2026-08-03','dw2','i1','',16), ('2026-08-04','dw2','i1','',32),
            ('2026-08-01','ow','office-item','',5), ('2026-08-04','ow','office-item','',5)`);
          const options = await getTurnoverOptions();
          const physical = options.stores.find((store) => store.name === "г.Тест ул.Мира 1")!;
          assert.ok(physical);
          assert.equal(options.stores.filter((store) => store.name.includes("г.Тест")).length, 1);
          assert.equal(options.stores.some((store) => store.name === "Офис Тест"), false);
          assert.equal(options.warehouses.some((warehouse) => warehouse.key === "dw1" && warehouse.storeKey === physical.key), true);
          assert.equal(options.warehouses.some((warehouse) => warehouse.key === "unused"), false);
          const merged = await getTurnoverReport({ from: params.from, to: params.to, store: [physical.key], profile: "sample", mode: "quantity" });
          assert.deepEqual(merged.rows.map((row) => row.sku), ["i1"]);
          const row = merged.rows[0]!;
          assert.equal(row.storeName, "г.Тест ул.Мира 1");
          assert.equal(row.openingQty, 30);
          assert.equal(row.closingQty, 48);
          assert.deepEqual(row.daily.map((day) => day.quantity), [36, 24, 48]);
          assert.equal(row.periodSales.quantity, 9);
          assert.equal(row.averageQty, 33);
          assert.equal(row.turnoverQty, 9 / 33);
          assert.equal(row.turnoverQtyDays, 11);
          const retailOnly = await getTurnoverReport({ from: params.from, to: params.to, profile: "sample", search: "Office Only" });
          assert.equal(retailOnly.rows.length, 0);
          const withOffice = await getTurnoverReport({ from: params.from, to: params.to, profile: "sample", search: "Office Only", storeScope: "all" });
          assert.equal(withOffice.rows.length, 1);
          assert.equal(withOffice.rows[0]!.closingQty, 5);
          assert.equal(withOffice.rows[0]!.periodSales.quantity, null);
          const exactSku = await getTurnoverReport({ ...params, profile: "sample", mode: "quantity", sku: "i1" });
          const search = await getTurnoverReport({ ...params, profile: "sample", mode: "quantity", search: "Item One" });
          assert.equal(exactSku.rows.length, 1);
          assert.equal(search.rows.length, 1);
          assert.equal(exactSku.rows[0]!.periodSales.quantity, search.rows[0]!.periodSales.quantity);
          assert.deepEqual(exactSku.rows[0]!.daily, search.rows[0]!.daily);
        } finally {
          await tx.$executeRawUnsafe("rollback to savepoint physical_scope");
          await tx.$executeRawUnsafe("release savepoint physical_scope");
        }
      });
      await t.test("zero filter removes only rows zero every day, keeping null and stock-only rows", async () => {
        await tx.$executeRawUnsafe("savepoint zero_filter");
        try {
          await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values
            ('zero-item','Zero Item','folder',false,null,'Z','ZERO',null,'u1')`);
          await tx.$executeRawUnsafe("insert into document_otchet_o_roznichnyh_prodazhah_tovary values ('rr-s1-2026-08-01','zero-item','','w1',0,0)");
          const visible = await getTurnoverReport({ from: params.from, to: params.to, profile: "sample", mode: "quantity", search: "Zero Item" });
          assert.equal(visible.rows.length, 1);
          assert.equal(visible.rows[0]!.periodSales.quantity, 0);
          const hidden = await getTurnoverReport({ from: params.from, to: params.to, profile: "sample", mode: "quantity", search: "Zero Item", excludeZero: true });
          assert.equal(hidden.rows.length, 0);
          const hiddenMoney = await getTurnoverReport({ from: params.from, to: params.to, profile: "sample", mode: "money", search: "Zero Item", excludeZero: true });
          assert.equal(hiddenMoney.rows.length, 0);
          const stockOnly = await getTurnoverReport({ from: params.from, to: params.to, profile: "sample", mode: "quantity", search: "Litres", excludeZero: true });
          assert.equal(stockOnly.rows.length, 1);
          assert.equal(stockOnly.rows[0]!.closingQty, 7);
          const missing = await getTurnoverReport({ from: "2026-05-20", to: "2026-05-23", profile: "sample", mode: "quantity", sku: "i1", store: ["s1"], excludeZero: true });
          assert.equal(missing.rows.length, 1);
          assert.equal(missing.rows[0]!.daily.every((day) => day.quantity === null), true);
        } finally {
          await tx.$executeRawUnsafe("rollback to savepoint zero_filter");
          await tx.$executeRawUnsafe("release savepoint zero_filter");
        }
      });
      await t.test("an assortment Boolean is never interpreted as a numeric stock minimum", async () => {
        await tx.$executeRawUnsafe("alter table catalog_nomenklatura add column normativnyy_zapas boolean");
        await tx.$executeRawUnsafe("update catalog_nomenklatura set normativnyy_zapas=true where ref_key='i1'");
        const smallTarget = await getTurnoverReport({ ...params, norms: { defaults: { ...norms, targetDays: 0.1 }, categories: {} } });
        const excess = smallTarget.rows.find((row) => row.sku === "i1")!.excessQty!;
        assert.ok(Math.abs(excess - 15.978571428571428) < 1e-10, `Unexpected excess from a Boolean flag: ${excess}`);
      });
      await t.test("different unit references sharing a suffix never merge daily quantities", async () => {
        const firstUnit = "11111111-1111-1111-1111-18c04d810b1b";
        const secondUnit = "22222222-2222-2222-2222-18c04d810b1b";
        await tx.$executeRawUnsafe("update catalog_bazovye_edinitsy_izmereniya set ref_key=$1 where ref_key='u1'", firstUnit);
        await tx.$executeRawUnsafe("update catalog_bazovye_edinitsy_izmereniya set ref_key=$1 where ref_key='u2'", secondUnit);
        await tx.$executeRawUnsafe("update catalog_nomenklatura set edinitsa_izmereniya_key=$1 where edinitsa_izmereniya_key='u1'", firstUnit);
        await tx.$executeRawUnsafe("update catalog_nomenklatura set edinitsa_izmereniya_key=$1 where edinitsa_izmereniya_key='u2'", secondUnit);
        const units = await getTurnoverReport(params);
        assert.equal(units.daily.filter((day) => day.date === "2026-08-03").length, 3);
        assert.equal(new Set(units.daily.filter((day) => day.date === "2026-08-03").map((day) => day.unit)).size, 3);
      });
      await t.test("SKU filtering preserves warehouse-derived store day coverage", async () => {
        await tx.$executeRawUnsafe("insert into catalog_magaziny values ('s3','Warehouse-derived store')");
        await tx.$executeRawUnsafe("insert into catalog_sklady values ('w3','Third warehouse','s3')");
        await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah
          select 'blank-' || day::date, day, '', false, true
          from generate_series('2026-08-01'::timestamp,'2026-08-03'::timestamp,interval '1 day') day`);
        await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary
          select 'blank-' || day::date,'i1','','w3',1,100
          from generate_series('2026-08-01'::timestamp,'2026-08-03'::timestamp,interval '1 day') day`);
        await tx.$executeRawUnsafe("insert into accumulation_register_tovary_na_skladah_balance values ('2026-08-04','w3','i2','',5)");
        const broad = await getTurnoverReport({ ...params, store: ["s3"] });
        const selected = await getTurnoverReport({ ...params, store: ["s3"], sku: "i2" });
        assert.equal(broad.rows.find((row) => row.sku === "i2")!.periodSales.quantity, 0);
        assert.equal(selected.rows.find((row) => row.sku === "i2")!.periodSales.quantity, 0);
      });
      await t.test("summary profile skips costs, barcodes and unused daily transport", async () => {
        const summary = await getTurnoverReport({ ...params, profile: "summary", mode: "quantity" });
        assert.ok(summary.rows.length > 0);
        assert.equal(summary.rows.every((row) => row.barcodes.length === 0), true,
          JSON.stringify(summary.rows.filter((row) => row.barcodes.length > 0).map((row) => ({ sku: row.sku, barcodes: row.barcodes }))));
        assert.equal(summary.rows.every((row) => row.openingCost === null && row.closingCost === null), true,
          JSON.stringify(summary.rows.filter((row) => row.openingCost !== null || row.closingCost !== null)
            .map((row) => ({ sku: row.sku, openingCost: row.openingCost, closingCost: row.closingCost }))));
        assert.equal(summary.rows.every((row) => row.windows.length === 1 && row.windows[0]!.days === 14), true,
          JSON.stringify(summary.rows.map((row) => row.windows.map((window) => window.days))));
        assert.equal(summary.daily.length, 0);
        const searched = await getTurnoverReport({ ...params, profile: "summary", search: "Litres" });
        assert.deepEqual(searched.rows.map((row) => row.sku), ["i3"]);
        const fullSearch = await getTurnoverReport({ ...params, profile: "full", search: "Litres" });
        assert.deepEqual(fullSearch.rows.map((row) => row.sku), ["i3"]);
        const byDay = await getTurnoverReport({ ...params, profile: "summary", groupBy: "day" });
        assert.ok(byDay.daily.length > 0);
      });
      await t.test("sample profile retains daily rows and requires the example layout", async () => {
        const sample = await getTurnoverReport({ ...params, profile: "sample", mode: "quantity" });
        assert.ok(sample.rows.length > 0);
        assert.equal(sample.rows.every((row) => row.daily.length === 3), true);
        assert.equal(sample.rows.every((row) => row.barcodes.length === 0), true);
        assert.equal(sample.rows.every((row) => row.openingCost === null && row.closingCost === null), true);
        assert.equal(sample.daily.length, 0);
        assert.equal(turnoverQuerySchema.safeParse({ ...params, profile: "sample", groupBy: "store" }).success, false);
        assert.equal(turnoverQuerySchema.safeParse({ ...params, profile: "sample", to: "2026-08-02" }).success, false);
      });
      await t.test("fast options expose stores, warehouses and folder categories", async () => {
        const options = await getTurnoverOptions();
        const one = options.stores.find((store) => store.name === "One")!;
        assert.ok(one);
        assert.ok(options.warehouses.some((warehouse) => warehouse.key === "w1" && warehouse.storeKey === one.key));
        assert.ok(options.categories.some((category) => category.key === "folder"));
      });
      await tx.$executeRawUnsafe("insert into catalog_nomenklatura (ref_key,description,parent_key,is_folder) values ('child','Child Group','folder',true)");
      await tx.$executeRawUnsafe("update catalog_nomenklatura set parent_key='child' where ref_key='i1'");
      const inheritedPolicy = {
        defaults: norms,
        categories: { folder: { staleDays: 10, criticalStaleDays: 20 }, child: { criticalStaleDays: 25 } }
      };
      assert.equal(turnoverQuerySchema.safeParse({ ...params, norms: inheritedPolicy }).success, true);
      const inherited = await getTurnoverReport({ ...params, norms: inheritedPolicy });
      assert.equal(inherited.rows.find((row) => row.sku === "i1")!.periodSales.quantity, 3);
      assert.equal(inherited.rows.find((row) => row.sku === "i1")!.categoryKey, "child");
      await t.test("multiple categories union folder descendants and product groups without duplicating sales", async () => {
        await tx.$executeRawUnsafe("insert into catalog_tovarnye_gruppy values ('g2','Second product group')");
        await tx.$executeRawUnsafe("update catalog_nomenklatura set tovarnaya_gruppa_key='g2' where ref_key='i2'");
        try {
          const selection = { ...params, category: ["child", "g2"] };
          const selected = await getTurnoverReport(selection);
          assert.deepEqual(selected.rows.map((row) => row.sku).sort(), ["i1", "i2"]);
          assert.equal(selected.rows.find((row) => row.sku === "i1")!.periodSales.quantity, 3);
          assert.equal(selected.rows.find((row) => row.sku === "i1")!.periodSales.cost, 10);
          const overlap = await getTurnoverReport({ ...params, category: ["folder", "child", "folder"] });
          assert.deepEqual(overlap.rows.map((row) => row.sku).sort(), ["i1", "i2", "i3", "i4", "i5"]);
          assert.equal(overlap.rows.find((row) => row.sku === "i1")!.periodSales.quantity, 3);
          const unrestricted = await getTurnoverReport({ ...params, category: [] });
          assert.deepEqual(unrestricted.rows.map((row) => row.sku).sort(), ["i1", "i2", "i3", "i4", "i5"]);
          const single = await getTurnoverReport({ ...params, category: ["child"] });
          assert.deepEqual(single.rows.map((row) => row.sku), ["i1"]);
          const detail = await getTurnoverRow({ ...selection, auditGroup: item.key });
          assert.equal(detail.row.sku, "i1");
          await assert.rejects(getTurnoverRow({ ...params, category: ["g2"], auditGroup: item.key }), /Строка/);
          assert.deepEqual(turnoverQuerySchema.parse({ ...params, category: ["g2", "child", "g2"] }).category, ["child", "g2"]);
          assert.deepEqual(turnoverQuerySchema.parse({ ...params, category: "child" }).category, ["child"]);
          assert.deepEqual(turnoverQuerySchema.parse({ ...params, category: [" g2 ", "child", "g2"] }).category, ["child", "g2"]);
          assert.deepEqual(turnoverQuerySchema.parse({ ...params, category: [] }).category, []);
          assert.deepEqual(turnoverQuerySchema.parse(params).category, []);
        } finally {
          await tx.$executeRawUnsafe("update catalog_nomenklatura set tovarnaya_gruppa_key=null where ref_key='i2'");
          await tx.$executeRawUnsafe("delete from catalog_tovarnye_gruppy where ref_key='g2'");
        }
      });
      await t.test("unknown categories union with folder selections without widening exact SKU filters", async () => {
        await tx.$executeRawUnsafe("update catalog_nomenklatura set parent_key='00000000-0000-0000-0000-000000000000' where ref_key='i2'");
        try {
          const unknown = await getTurnoverReport({ ...params, category: ["__unknown__"] });
          assert.deepEqual(unknown.rows.map((row) => row.sku), ["i2"]);
          const selected = await getTurnoverReport({ ...params, category: ["child", "__unknown__"] });
          assert.deepEqual(selected.rows.map((row) => row.sku).sort(), ["i1", "i2"]);
          assert.equal(selected.rows.find((row) => row.sku === "i1")!.periodSales.quantity, 3);
          assert.equal((await getTurnoverReport({ ...params, category: ["__unknown__"], sku: "i1" })).rows.length, 0);
          await assert.rejects(getTurnoverRow({ ...params, category: ["__unknown__"], auditGroup: item.key }), /Строка/);
        } finally {
          await tx.$executeRawUnsafe("update catalog_nomenklatura set parent_key='folder' where ref_key='i2'");
        }
      });
      await t.test("SKU row details retain cross-store transfer counterparties", async () => {
        await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary
          select 'rr-' || store || '-' || day::date,'i2','',warehouse,1,100
          from generate_series('2026-07-07'::timestamp,'2026-08-03'::timestamp,interval '1 day') day
          cross join (values('s1','w1'),('s2','w2')) stores(store,warehouse)`);
        await tx.$executeRawUnsafe(`insert into accumulation_register_tovary_na_skladah_balance
          select day,warehouse,'i2','',quantity
          from generate_series('2026-07-08'::timestamp,'2026-08-04'::timestamp,interval '1 day') day
          cross join (values('w1',100),('w2',1)) stores(warehouse,quantity)`);
        const network = await getTurnoverReport({ ...params, store: [] });
        const donor = network.rows.find((row) => row.sku === "i2" && row.storeKey === "key:s1")!;
        assert.ok(donor, JSON.stringify(network.rows.map((row) => ({ sku: row.sku, storeKey: row.storeKey, storeName: row.storeName }))));
        assert.equal(network.transfers.find((transfer) => transfer.sku === "i2")!.quantity, 29);
        const detail = await getTurnoverRow({ ...params, store: [], auditGroup: donor.key });
        assert.equal(detail.row.recommendations.some((recommendation) => recommendation.code === "transfer"), true);
      });
      await tx.$executeRawUnsafe("delete from accumulation_register_tovary_na_skladah_balance where balance_period='2026-08-03'");
      const gap = await getTurnoverReport(params);
      assert.deepEqual(gap.coverage.missingStockDates, ["2026-08-02"]);
      assert.equal(gap.rows.find((row) => row.sku === "i1")!.averageQty, null);
      await tx.$executeRawUnsafe(`insert into information_register_sebestoimost_nomenklatury_record_type values
        ('2026-08-03',true,'s1','i1','',0,4)`);
      const noPrice = await getTurnoverReport(params);
      assert.equal(noPrice.rows.find((row) => row.sku === "i1")!.closingCost, null);
      await t.test("observed stock without a catalog card remains available in SKU details", async () => {
        await tx.$executeRawUnsafe("insert into accumulation_register_tovary_na_skladah_balance values ('2026-08-04','w1','orphan','',9)");
        const broad = await getTurnoverReport(params);
        const missingCard = broad.rows.find((row) => row.sku === "orphan")!;
        assert.equal(missingCard.closingQty, 9);
        const emptySelection = await getTurnoverReport({ ...params, category: [] });
        assert.equal(emptySelection.rows.find((row) => row.sku === "orphan")!.closingQty, 9);
        const detail = await getTurnoverRow({ ...params, auditGroup: missingCard.key });
        assert.equal(detail.row.key, missingCard.key);
        assert.equal(detail.row.closingQty, 9);
        assert.deepEqual(detail.row.daily.map((day) => day.quantity), [0, null, 9]);
        assert.equal((await getTurnoverReport({ ...params, sku: "orphan" })).rows[0]!.closingQty, 9);
        assert.equal((await getTurnoverReport({ ...params, category: [], sku: "orphan" })).rows[0]!.closingQty, 9);
        assert.equal((await getTurnoverRow({ ...params, category: [], auditGroup: missingCard.key })).row.closingQty, 9);
        assert.equal((await getTurnoverReport({ ...params, category: ["folder"], sku: "orphan" })).rows.length, 0);
        await assert.rejects(getTurnoverRow({ ...params, category: ["folder"], auditGroup: missingCard.key }), /Строка/);
        assert.equal((await getTurnoverReport({ ...params, sku: "folder" })).rows.length, 0);
      });
    }, { timeout: 30_000 });
  } finally {
    prisma.$queryRaw = originalQuery;
    config.PGSCHEMA = originalSchema;
    await prisma.$disconnect();
  }
});
