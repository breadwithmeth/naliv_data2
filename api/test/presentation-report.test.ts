import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";

process.env.DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
process.env.PGSCHEMA = "pg_temp";
process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
const { getPresentationReport, presentationReportQuerySchema } = await import("../src/services/presentation-report.js");
const { writePresentationReportWorkbook } = await import("../src/services/presentation-report-workbook.js");

test("additional report period defaults stay inside the main window and custom boundaries are paired", () => {
  const annual = presentationReportQuerySchema.parse({ from: "2025-01-01", to: "2026-01-01" });
  assert.equal(annual.monthFrom, "2025-12-01");
  assert.equal(annual.monthTo, "2026-01-01");
  const short = presentationReportQuerySchema.parse({ from: "2026-09-20", to: "2026-09-24" });
  assert.equal(short.monthFrom, "2026-09-20");
  const custom = presentationReportQuerySchema.parse({
    from: "2026-02-01", to: "2026-10-01", monthFrom: "2026-05-01", monthTo: "2026-06-01", city: [" Павлодар ", "Павлодар"]
  });
  assert.equal(custom.monthFrom, "2026-05-01");
  assert.deepEqual(custom.city, ["Павлодар"]);
  for (const extra of [
    { monthFrom: "2026-09-01" },
    { monthTo: "2026-10-01" },
    { monthFrom: "2026-09-01", monthTo: "2026-09-01" },
    { monthFrom: "2025-01-01", monthTo: "2026-01-03" },
    { monthFrom: "2026-02-29", monthTo: "2026-03-01" }
  ]) assert.equal(presentationReportQuerySchema.safeParse({ from: "2026-02-01", to: "2026-10-01", ...extra }).success, false);
});

test("missing prior history, source-key supplier uniqueness, returns and unknown costs remain honest", {
  skip: !process.env.ANALYTICS_TEST_DATABASE_URL
}, async () => {
  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  config.PGSCHEMA = "pg_temp";
  try {
    await prisma.$transaction(async (tx) => {
      const tables = [
        `document_chek_kkm (ref_key text, date timestamp, deletion_mark boolean, posted boolean, summa_dokumenta numeric, vid_operatsii text, magazin_key text)`,
        `document_chek_kkm_tovary (_parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric)`,
        `catalog_magaziny (ref_key text, description text)`,
        `catalog_nomenklatura (ref_key text, parent_key text, is_folder boolean, description text)`,
        `catalog_sklady (ref_key text, magazin_key text)`,
        `catalog_kontragenty (ref_key text, description text, inn text)`,
        `catalog_organizatsii (ref_key text, description text, inn text)`,
        `information_register_sebestoimost_nomenklatury_record_type (period timestamp, active boolean, line_number integer, magazin_key text, nomenklatura_key text, tsena numeric)`,
        `document_ustanovka_sebestoimosti (ref_key text, magazin_key text, date timestamp, deletion_mark boolean, posted boolean)`,
        `document_ustanovka_sebestoimosti_tovary (_parent_ref_key text, _parent_line_index integer, nomenklatura_key text, tsena numeric)`,
        `document_postuplenie_tovarov (ref_key text, date timestamp, deletion_mark boolean, posted boolean, magazin_key text, sklad_key text, kontragent_key text, summa_dokumenta numeric)`,
        `document_postuplenie_tovarov_tovary (_parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric, summa_nds numeric)`,
        `document_vozvrat_tovarov_postavschiku (ref_key text, date timestamp, deletion_mark boolean, posted boolean, magazin_key text, sklad_key text, kontragent_key text, summa_dokumenta numeric)`
      ];
      for (const definition of tables) await tx.$executeRawUnsafe(`create temp table ${definition} on commit drop`);
      await tx.$executeRawUnsafe(`insert into catalog_magaziny values
        ('a', 'ИП Первая г.Павлодар ул.Тест 1'), ('a2', 'ИП Вторая Г.ПАВЛОДАР   УЛ.ТЕСТ 1')`);
      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values
        ('beer', null, true, 'Пиво'), ('bottle', 'beer', true, 'Пиво бут'), ('draft', 'beer', true, 'Пиво розлив'),
        ('alcohol', null, true, 'Алкоголь'), ('services', null, true, 'Услуги'), ('snacks', null, true, 'Снеки'),
        ('unique', 'bottle', false, 'Бутылка'), ('multiple', 'draft', false, 'Пиво розлив'),
        ('no-purchase', 'services', false, 'Услуга'), ('unknown-supplier', 'alcohol', false, 'Напиток'),
        ('unknown-cost', 'snacks', false, 'Товар без цены')`);
      await tx.$executeRawUnsafe(`insert into catalog_kontragenty values
        ('u', 'Поставщик U', '200'), ('v', 'Внутренний V', '100'), ('w', 'Поставщик W', '300'), ('r', 'Только возврат R', '400')`);
      await tx.$executeRawUnsafe(`insert into catalog_organizatsii values ('org', 'Наша организация', '100')`);
      await tx.$executeRawUnsafe(`insert into document_chek_kkm values
        ('sale', '2026-02-01', false, true, 240, 'Продажа', 'a'),
        ('sale-a2', '2026-02-01', false, true, 30, 'Продажа', 'a2'),
        ('return', '2026-02-02', false, true, 20, 'ВОЗВРАТ', 'a')`);
      await tx.$executeRawUnsafe(`insert into document_chek_kkm_tovary values
        ('sale', 'unique', 2, 100), ('sale', 'multiple', 1, 40), ('sale', 'no-purchase', 1, 50),
        ('sale', 'unknown-supplier', 1, 20), ('sale', 'unknown-cost', 1, 30),
        ('sale-a2', 'unique', 1, 30), ('return', 'unique', 1, 20)`);
      await tx.$executeRawUnsafe(`insert into information_register_sebestoimost_nomenklatury_record_type values
        ('2026-01-01', true, 1, 'a', 'unique', 10), ('2026-01-01', true, 1, 'a2', 'unique', 25),
        ('2026-01-01', true, 1, 'a', 'multiple', 8), ('2026-01-01', true, 1, 'a', 'no-purchase', 4),
        ('2026-01-01', true, 1, 'a', 'unknown-supplier', 20)`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov values
        ('p1', '2026-02-01', false, true, 'a', null, 'u', 100),
        ('p2', '2026-02-02', false, true, 'a', null, 'u', 0),
        ('p3', '2026-02-01', false, true, 'a', null, 'v', 40),
        ('p4', '2026-02-01', false, true, 'a', null, 'w', null),
        ('p5', '2026-02-01', false, true, 'a', null, '00000000-0000-0000-0000-000000000000', 20),
        ('p6', '2026-02-01', false, true, 'a', null, 'u', 10),
        ('p-a2', '2026-02-01', false, true, 'a2', null, 'w', 25),
        ('before', '2026-01-31', false, true, 'a', null, 'w', 10),
        ('after', '2026-02-03', false, true, 'a', null, 'w', 999)`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov_tovary values
        ('p1', 'unique', 10, 100, 0), ('p2', 'unique', 1, 0, 0),
        ('p3', 'multiple', 2, 40, 0), ('p4', 'multiple', 1, 8, 0),
        ('p5', 'unknown-supplier', 1, 20, 0), ('p6', 'unknown-cost', 1, null, 0),
        ('p-a2', 'unique', 1, 25, 0), ('before', 'unique', 1, 10, 0), ('after', 'unique', 1, 999, 0)`);
      await tx.$executeRawUnsafe(`insert into document_vozvrat_tovarov_postavschiku values
        ('supplier-return', '2026-02-02', false, true, 'a', null, 'u', 5),
        ('return-only', '2026-02-02', false, true, 'a', null, 'r', -7)`);
      const report = await getPresentationReport({ from: "2026-02-01", to: "2026-02-03" }, tx);
      const block = report.main;
      const currentQuality = block.sales.dataQuality.periods.find((row) => row.period === "current")!;
      assert.equal(currentQuality.lineRevenue, 250);
      assert.equal(currentQuality.estimatedGrossIncome, null);
      assert.equal(currentQuality.unvaluedRevenue, 30);
      assert.equal(block.sales.stores.length, 1);
      assert.deepEqual(block.sales.cohort.selectedStoreKeys, []);
      assert.equal(block.sales.coverage.find((row) => row.period === "previous")!.status, "empty");
      const aggregate = (key: string) => block.sales.aggregates.find((row) => row.period === "current"
        && row.scope === "all" && row.groupKind === "presentation" && row.groupKey === key)!;
      assert.equal(aggregate("total").revenue, 250);
      assert.equal(aggregate("total").receiptCount, 2);
      assert.equal(aggregate("packaged").revenue, 130);
      assert.equal(aggregate("packaged").receiptCount, 2);
      assert.equal(aggregate("draught").receiptCount, 1);
      const supplierU = block.suppliers.find((row) => row.supplierKey === "u" && row.period === "current")!;
      assert.equal(supplierU.purchases, 105);
      assert.equal(supplierU.salesRevenue, 110);
      assert.equal(supplierU.estimatedGrossIncome, null);
      assert.equal(supplierU.knownEstimatedGrossIncome, 70);
      assert.equal(supplierU.cohortPurchases, null);
      assert.equal(supplierU.cohortEstimatedGrossIncome, null);
      const supplierW = block.suppliers.find((row) => row.supplierKey === "w" && row.period === "current")!;
      assert.equal(supplierW.purchases, null);
      assert.equal(supplierW.estimatedGrossIncome, 5);
      assert.equal(block.suppliers.find((row) => row.supplierKey === "v")!.internalByTaxId, true);
      assert.equal(block.suppliers.find((row) => row.supplierKey === "r")!.purchases, -7);
      const sourceA = block.attribution.find((row) => row.sourceStoreKey === "a" && row.itemKey === "unique")!;
      assert.deepEqual(sourceA.supplierCandidates, ["u"]);
      assert.equal(sourceA.revenue, 80);
      assert.equal(sourceA.valuedCost, 10);
      const sourceA2 = block.attribution.find((row) => row.sourceStoreKey === "a2" && row.itemKey === "unique")!;
      assert.equal(sourceA2.supplierKey, "w");
      assert.equal(sourceA2.valuedCost, 25);
      assert.equal(block.attribution.find((row) => row.itemKey === "multiple")!.reason, "multiple-suppliers");
      assert.equal(block.attribution.find((row) => row.itemKey === "no-purchase")!.reason, "no-purchase");
      assert.equal(block.attribution.find((row) => row.itemKey === "unknown-supplier")!.reason, "unknown-supplier");
      const allocatedRevenue = block.suppliers.reduce((sum, row) => sum + row.salesRevenue, 0);
      const residualRevenue = block.residual.reduce((sum, row) => sum + row.salesRevenue, 0);
      assert.equal(allocatedRevenue, 140);
      assert.equal(residualRevenue, 110);
      assert.equal(allocatedRevenue + residualRevenue, currentQuality.lineRevenue);
      const knownIncome = block.suppliers.reduce((sum, row) => sum + row.knownEstimatedGrossIncome, 0)
        + block.residual.reduce((sum, row) => sum + row.knownEstimatedGrossIncome, 0);
      assert.equal(knownIncome, 153);
      assert.equal(knownIncome, currentQuality.lineRevenue! - currentQuality.unvaluedRevenue! - currentQuality.valuedCost!);
      assert.equal(block.purchasingQuality.find((row) => row.period === "current")!.missingReceiptAmounts, 1);
      assert.equal(block.purchasingQuality.find((row) => row.period === "previous")!.receiptAmount, null);
      assert.equal(block.purchasingQuality.find((row) => row.period === "previous")!.status, "empty");
      const output = new PassThrough();
      const bytes = buffer(output);
      await writePresentationReportWorkbook(report, output);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await bytes);
      const supplierSheet = workbook.getWorksheet("Поставщики — основной")!;
      let supplierURow: ExcelJS.Row | undefined;
      supplierSheet.eachRow((row) => { if (row.getCell(3).value === "u") supplierURow = row; });
      assert.equal(supplierURow!.getCell(12).value, "n/a");
      assert.equal(supplierURow!.getCell(9).value, "n/a");
      assert.equal(supplierURow!.getCell(10).result, "n/a");
      const visibleTotal = supplierSheet.getRow(supplierSheet.rowCount);
      assert.equal(visibleTotal.getCell(7).result, "n/a");
      assert.equal(visibleTotal.getCell(12).result, "n/a");
      assert.equal(visibleTotal.getCell(23).result, 75);
    }, { timeout: 60_000, isolationLevel: "RepeatableRead" });
  } finally {
    await prisma.$disconnect();
  }
});
