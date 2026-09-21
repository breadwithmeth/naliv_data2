import assert from "node:assert/strict";
import { test } from "node:test";

const ZERO_REF = "00000000-0000-0000-0000-000000000000";

// 1C keeps the composition of a nomenclature segment inside the catalog's
// data-composition schema. Only the "ФормированиеСегмента" settings variant
// holds the item list; the "ВыводСегмента" variant selects output fields only.
// References are upper-cased here on purpose: the sync stores keys lower-cased.
function segmentSchema(refs: string[]) {
  const list = refs
    .map(
      (ref) =>
        `<d6p1:CatalogRef.Номенклатура xsi:type="dcscor:DesignTimeValue">${ref.toUpperCase()}</d6p1:CatalogRef.Номенклатура>`
    )
    .join("");
  const xml = `<DataCompositionSchema xmlns="http://v8.1c.ru/8.1/data-composition-system/schema" xmlns:d6p1="http://v8.1c.ru/8.1/data/core" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><settingsVariant><dcsset:name xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings">ФормированиеСегмента</dcsset:name><dcsset:filter><dcsset:item><dcsset:comparisonType>InList</dcsset:comparisonType><dcsset:right><d6p1:Value>${list}</d6p1:Value></dcsset:right></dcsset:item></dcsset:filter></settingsVariant><settingsVariant><dcsset:name xmlns:dcsset="http://v8.1c.ru/8.1/data-composition-system/settings">ВыводСегмента</dcsset:name></settingsVariant></DataCompositionSchema>`;
  return Buffer.from(xml, "utf8").toString("base64");
}

const round2 = (value: number) => Math.round(value * 100) / 100;

// A retail line belongs to a promotion only when its store, sale date, item and
// the discount actually visible on the line all agree with one of the
// promotion's discount rules.
test("marketing attributes retail lines to promotions by store, period, item and applied discount", {
  skip: !process.env.ANALYTICS_TEST_DATABASE_URL
}, async () => {
  process.env.DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL;
  process.env.PGSCHEMA = "pg_temp";
  // The rule set memoises for the cache TTL; tests need a fixture-fresh load.
  process.env.REPORT_CACHE_TTL_SECONDS = "0";
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
  const { prisma } = await import("../src/prisma.js");
  // Imported after the environment above so config parses the test database and
  // the disabled rule-set cache; a static import would freeze both at module load.
  const { getMarketingReport } = await import("../src/services/marketing.js");
  const { config } = await import("../src/config.js");
  config.PGSCHEMA = "pg_temp";
  const original = prisma.$queryRaw;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table document_marketingovaya_aktsiya (
        ref_key text, number text, naimenovanie_aktsii text, date timestamp,
        data_nachala_deystviya timestamp, data_okonchaniya_deystviya timestamp,
        dlya_vseh_magazinov boolean, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_marketingovaya_aktsiya_skidki_natsenki (
        _parent_ref_key text, magazin_key text, skidka_natsenka_key text,
        data_nachala timestamp, data_okonchaniya timestamp) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_marketingovaya_aktsiya_magaziny (
        _parent_ref_key text, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_skidki_natsenki (
        ref_key text, opisanie text, sposob_predostavleniya text,
        znachenie_skidki_natsenki numeric, segment_nomenklatury_predostavleniya_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_segmenty_nomenklatury (
        ref_key text, shema_komponovki_dannyh_base64_data text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        _id integer, ref_key text, date timestamp, deletion_mark boolean,
        posted boolean, summa_dokumenta numeric, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_tovary (
        _id integer, _parent_ref_key text, nomenklatura_key text, kolichestvo numeric,
        tsena numeric, summa numeric, protsent_skidki_natsenki numeric) on commit drop`);
      for (const table of ["catalog_magaziny", "catalog_nomenklatura"]) {
        await tx.$executeRawUnsafe(
          `create temp table ${table} (ref_key text, description text, deletion_mark boolean) on commit drop`
        );
      }

      // p1 covers s1 with an 11.11% rule over two items; p2 covers s2 with two
      // identical 25% rules (a line matching both must still count once); p3 has
      // no sales at all.
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya values
        ('p1', 'АК-001', 'Сегмент 11,11% сентябрь', '2026-09-01', '2026-09-01', '2026-10-01', false, false, true),
        ('p2', 'АК-002', 'Двойное правило 25%', '2026-09-01', '2026-09-01', '2026-10-01', false, false, true),
        ('p3', 'АК-003', 'Без продаж 30%', '2026-09-01', '2026-09-01', '2026-10-01', false, false, true),
        ('p4', 'АК-004', 'Удаленная акция', '2026-09-01', '2026-09-01', '2026-10-01', false, true, true)`);
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya_magaziny values
        ('p1', 's1'), ('p2', 's2'), ('p3', 's3'), ('p4', 's1')`);
      await tx.$executeRawUnsafe(`insert into catalog_skidki_natsenki values
        ('d1', 'Сегмент 11,11%', 'Процент', 11.11, 'seg1'),
        ('d2', 'Сегмент 25%', 'Процент', 25, 'seg2'),
        ('d3', 'Сегмент 25% (второе правило)', 'Процент', 25, 'seg3'),
        ('d4', 'Сегмент 30%', 'Процент', 30, 'seg4'),
        ('d5', 'Подарок', 'Подарок', 0, 'seg1')`);
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya_skidki_natsenki values
        ('p1', '${ZERO_REF}', 'd1', '2026-09-01', '2026-10-01'),
        ('p2', '${ZERO_REF}', 'd2', '2026-09-01', '2026-10-01'),
        ('p2', '${ZERO_REF}', 'd3', '2026-09-01', '2026-10-01'),
        ('p3', '${ZERO_REF}', 'd4', '2026-09-01', '2026-10-01'),
        ('p4', '${ZERO_REF}', 'd1', '2026-09-01', '2026-10-01')`);
      await tx.$executeRawUnsafe(`insert into catalog_segmenty_nomenklatury values
        ('seg1', '${segmentSchema(["aaaaaaaa-1111-1111-1111-111111111111", "aaaaaaaa-2222-2222-2222-222222222222"])}'),
        ('seg2', '${segmentSchema(["aaaaaaaa-4444-4444-4444-444444444444"])}'),
        ('seg3', '${segmentSchema(["aaaaaaaa-4444-4444-4444-444444444444"])}'),
        ('seg4', '${segmentSchema(["aaaaaaaa-9999-9999-9999-999999999999"])}')`);

      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        (1, 'r1', '2026-09-05', false, true, 400, 's1'),
        (2, 'r2', '2026-09-10', false, true, 100, 's2'),
        (3, 'r4', '2026-09-20', false, true, 100, 's1'),
        (4, 'r5', '2026-09-12', false, true, 100, 's2'),
        (5, 'r6', '2026-09-13', false, true, 100, 's1'),
        (6, 'r8', '2026-09-22', false, true, 100, 's1'),
        (7, 'r7', '2026-08-20', false, true, 100, 's2'),
        (8, 'r3', '2026-10-05', false, true, 100, 's1'),
        (9, 'r0', '2026-09-06', true, true, 5000, 's1')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        (101, 'r1', 'aaaaaaaa-1111-1111-1111-111111111111', 1, 100, 88.89, 0),
        (102, 'r1', 'aaaaaaaa-2222-2222-2222-222222222222', 2, 100, 177.78, 0),
        (103, 'r1', 'aaaaaaaa-3333-3333-3333-333333333333', 1, 100, 88.89, 0),
        (104, 'r1', 'aaaaaaaa-1111-1111-1111-111111111111', 1, 100, 100.00, 0),
        (105, 'r1', 'aaaaaaaa-1111-1111-1111-111111111111', 1, 100, 75.00, 0),
        (106, 'r2', 'aaaaaaaa-1111-1111-1111-111111111111', 1, 100, 88.89, 0),
        (107, 'r4', 'aaaaaaaa-2222-2222-2222-222222222222', 1, 100, 88.89, 0),
        (108, 'r5', 'aaaaaaaa-4444-4444-4444-444444444444', 1, 100, 75.00, 0),
        (109, 'r5', 'aaaaaaaa-5555-5555-5555-555555555555', 1, 100, 75.00, 0),
        (110, 'r5', 'aaaaaaaa-5555-5555-5555-555555555555', 1, 100, 88.88, 0),
        (111, 'r6', 'aaaaaaaa-4444-4444-4444-444444444444', 1, 100, 75.00, 0),
        (112, 'r7', 'aaaaaaaa-4444-4444-4444-444444444444', 1, 100, 75.00, 0),
        (113, 'r3', 'aaaaaaaa-1111-1111-1111-111111111111', 1, 100, 88.89, 0),
        (114, 'r8', 'aaaaaaaa-1111-1111-1111-111111111111', 1, 100, 88.60, 0),
        (115, 'r8', 'aaaaaaaa-2222-2222-2222-222222222222', 3, 100, 266.67, 0),
        (116, 'r0', 'aaaaaaaa-1111-1111-1111-111111111111', 1, 100, 88.89, 0)`);
      await tx.$executeRawUnsafe(`insert into catalog_magaziny values
        ('s1', 'Магазин Один'), ('s2', 'Магазин Два'), ('s3', 'Магазин Три')`);
      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values
        ('aaaaaaaa-1111-1111-1111-111111111111', 'Товар Один'),
        ('aaaaaaaa-2222-2222-2222-222222222222', 'Товар Два'),
        ('aaaaaaaa-4444-4444-4444-444444444444', 'Товар Четыре')`);

      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;

      const report = await getMarketingReport({
        period: "custom",
        from: new Date("2026-09-01T00:00:00.000Z"),
        to: new Date("2026-10-01T00:00:00.000Z")
      });

      // Reported document totals are untouched by the attribution.
      assert.equal(report.summary.totalRevenue, 900);
      assert.equal(report.summary.totalReports, 6);
      assert.equal(report.summary.promotionCount, 3);
      assert.equal(report.summary.promotionWithSalesCount, 2);
      assert.equal(round2(report.summary.promoRevenue), round2(622.23 + 75));
      assert.equal(round2(report.summary.promoDiscountAmount), round2(77.77 + 25));
      assert.equal(round2(report.summary.promoListRevenue), 700 + 100);
      assert.equal(report.summary.promoQuantity, 8);
      // One report holds lines of only one store, so report counts add up, while
      // the summary counts every report that carries any promotional line once.
      assert.equal(report.summary.promoReportCount, 4);
      assert.equal(report.summary.promoItemCount, 3);
      assert.equal(report.summary.promoStoreCount, 2);

      assert.deepEqual(
        report.promotions.map((promotion) => promotion.name),
        ["Сегмент 11,11% сентябрь", "Двойное правило 25%"]
      );

      const [segmentPromotion, doubleRulePromotion] = report.promotions;
      assert.equal(segmentPromotion.number, "АК-001");
      assert.equal(segmentPromotion.startsOn, "2026-09-01");
      assert.equal(segmentPromotion.endsOn, "2026-10-01");
      assert.equal(segmentPromotion.assortmentSize, 2);
      assert.equal(segmentPromotion.itemCount, 2);
      assert.equal(segmentPromotion.lineCount, 4);
      assert.equal(segmentPromotion.reportCount, 3);
      assert.equal(segmentPromotion.storeCount, 1);
      assert.equal(segmentPromotion.quantity, 7);
      assert.equal(round2(segmentPromotion.revenue), 622.23);
      assert.equal(round2(segmentPromotion.listRevenue), 700);
      assert.equal(round2(segmentPromotion.discountAmount), 77.77);
      assert.equal(segmentPromotion.discountPctMin, 11.11);
      assert.equal(segmentPromotion.discountPctMax, 11.11);

      // A line matching two rules of one promotion is revenue-counted once.
      assert.equal(round2(doubleRulePromotion.revenue), 75);
      assert.equal(round2(doubleRulePromotion.discountAmount), 25);
      assert.equal(doubleRulePromotion.lineCount, 1);
      assert.equal(doubleRulePromotion.quantity, 1);
      assert.equal(doubleRulePromotion.reportCount, 1);
      assert.equal(doubleRulePromotion.itemCount, 1);
      assert.equal(doubleRulePromotion.assortmentSize, 1);

      assert.deepEqual(
        segmentPromotion.stores.map((store) => [
          store.name,
          store.reportCount,
          store.itemCount,
          store.quantity,
          round2(store.revenue)
        ]),
        [["Магазин Один", 3, 2, 7, 622.23]]
      );
      assert.deepEqual(
        segmentPromotion.stores[0].items.map((item) => [
          item.name,
          item.reportCount,
          item.quantity,
          round2(item.revenue)
        ]),
        [
          ["Товар Два", 3, 6, 533.34],
          ["Товар Один", 1, 1, 88.89]
        ]
      );

      assert.deepEqual(
        report.stores.map((store) => [
          store.name,
          store.totalRevenue,
          round2(store.promoRevenue),
          store.promotionCount,
          store.promoItemCount
        ]),
        [
          ["Магазин Один", 700, 622.23, 1, 2],
          ["Магазин Два", 200, 75, 1, 1]
        ]
      );

      const empty = await getMarketingReport({
        period: "custom",
        from: new Date("2030-01-01T00:00:00.000Z"),
        to: new Date("2030-01-02T00:00:00.000Z")
      });
      assert.equal(empty.summary.totalRevenue, 0);
      assert.equal(empty.summary.promoRevenue, 0);
      assert.deepEqual(empty.promotions, []);
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});
