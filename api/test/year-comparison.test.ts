import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import type { Row } from "exceljs";
import JSZip from "jszip";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";

process.env.DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
process.env.PGSCHEMA = "pg_temp";
process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
// Dynamic imports are required here: config/Prisma read process.env at module
// evaluation, after the isolated pg_temp/test database environment above.
const { yearComparisonQuerySchema, previousCalendarYear, getYearComparison, comparisonMethodology } = await import("../src/services/year-comparison.js");
const { writeYearComparisonWorkbook } = await import("../src/services/year-comparison-workbook.js");

// Boundary behavior is a domain rule, independent of the database clock/timezone.
test("calendar-year windows preserve exclusive leap boundaries and reject invalid dates", () => {
  assert.equal(previousCalendarYear("2024-02-29"), "2023-02-28");
  assert.equal(previousCalendarYear("2024-03-01"), "2023-03-01");
  assert.equal(previousCalendarYear("2025-03-01"), "2024-03-01");
  assert.equal(previousCalendarYear("2026-04-01"), "2025-04-01");
  for (const query of [
    { from: "0000-01-01", to: "0000-01-02" },
    { from: "0001-01-01", to: "0001-01-02" },
    { from: "2026-02-29", to: "2026-03-01" },
    { from: "2026-2-01", to: "2026-03-01" },
    { from: "2026-04-01T00:00:00Z", to: "2026-04-02" },
    { from: "2026-04-02", to: "2026-04-02" },
    { from: "2026-04-03", to: "2026-04-02" },
    { from: "2024-01-01", to: "2025-01-02" }
  ]) assert.equal(yearComparisonQuerySchema.safeParse(query).success, false);
  assert.deepEqual(yearComparisonQuerySchema.parse({ from: "2026-04-01", to: "2026-04-03", cohort: "custom" }).comparableStore, []);
});

test("Excel zero-base changes and absent periods are n/a with numeric formulas cached", async () => {
  const report = {
    periods: { current: { from: "2026-04-01", to: "2026-04-02" }, previous: { from: "2025-04-01", to: "2025-04-02" } },
    stores: [{ key: "key:s1", name: "=1+1", city: "Город", sourceStoreKeys: ["s1"], comparableByActivity: true }],
    coverage: (["current", "previous"] as const).map((period) => ({ period, coveredDays: 1, expectedDays: 1, receiptCount: 1, status: "observed" as const, dateFrom: period === "current" ? "2026-04-01" : "2025-04-01", dateTo: period === "current" ? "2026-04-01" : "2025-04-01", missingDays: [] })),
    cohort: { mode: "observed" as const, selectedStoreKeys: ["key:s1"] },
    aggregates: (["current", "previous"] as const).flatMap((period) => (["store", "city", "all", "cohort"] as const).map((scope) => ({
      period, scope, scopeKey: scope === "store" ? "key:s1" : scope === "city" ? "Город" : scope,
      groupKind: "comparison" as const, groupKey: "combined", quantity: period === "current" ? 2 : 0,
      revenue: period === "current" ? 100 : 0, estimatedCost: 0, estimatedGrossIncome: period === "current" ? 100 : 0,
      valuedCost: 0, valuedRevenue: period === "current" ? 100 : 0, unvaluedRevenue: 0,
      absoluteQuantity: period === "current" ? 2 : 0, unvaluedQuantity: 0, lineCount: 1, receiptCount: 1,
      avgQuantityPerReceipt: period === "current" ? 2 : 0, avgAmountPerReceipt: period === "current" ? 100 : 0
    }))),
    dataQuality: {
      periods: (["current", "previous"] as const).map((period) => ({ period, headerRevenue: 0, lineRevenue: 0, difference: 0, headerCount: 1, positiveSaleReceiptCount: 1, returnReceiptCount: 0, receiptsWithoutLines: 0, lineCount: 1, absoluteQuantity: 0, unvaluedQuantity: 0, valuedCost: 0, unvaluedRevenue: 0, estimatedGrossIncome: 0 })),
      global: { dateFrom: "2025-04-01", dateTo: "2026-04-01", coveredDays: 2 },
      sourceStores: [{ key: "s1", name: "=1+1", physicalKey: "key:s1", city: "Город" }], taxonomy: [], valuation: []
    }, generatedAt: "2026-10-03T00:00:00Z", methodology: [...comparisonMethodology]
  };
  const output = new PassThrough();
  const bytes = buffer(output);
  await writeYearComparisonWorkbook(report, output);
  const workbookBytes = await bytes;
  const archive = await JSZip.loadAsync(workbookBytes);
  // OOXML CT_SheetPr is ordered; Excel repairs worksheets with outlinePr
  // after pageSetUpPr even though tolerant workbook readers accept them.
  const sheetPropertyOrder: Record<string, number> = { tabColor: 0, outlinePr: 1, pageSetUpPr: 2 };
  for (const part of archive.filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))) {
    const xml = await part.async("string");
    const properties = /<sheetPr(?:\s[^>]*)?>([\s\S]*?)<\/sheetPr>/.exec(xml)?.[1] ?? "";
    const children = [...properties.matchAll(/<(\w+)(?:\s|\/|>)/g)].map((match) => match[1]);
    for (let index = 1; index < children.length; index++) {
      assert.ok(sheetPropertyOrder[children[index - 1]] < sheetPropertyOrder[children[index]],
        `${part.name}: invalid sheetPr child order: ${children.join(", ")}`);
    }
  }
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(workbookBytes);
  const combined = loaded.getWorksheet("Категория пиво-энергетик")!;
  assert.equal(combined.getCell("A4").value, "* =1+1");
  assert.equal(combined.getCell("A4").type, ExcelJS.ValueType.String);
  assert.equal(combined.getCell("B4").type, ExcelJS.ValueType.Number);
  assert.equal(combined.getCell("F4").result, 2);
  assert.equal(combined.getCell("H4").result, "n/a");
  assert.equal(combined.getCell("I4").result, "n/a");
  assert.equal(combined.getCell("P4").result, 0);
  assert.equal(combined.getCell("Q4").result, 2);
  assert.equal(combined.getCell("R4").result, "n/a");
  assert.equal(loaded.getWorksheet("пиво бут")!.getCell("B4").value, "n/a");
  assert.equal(loaded.getWorksheet("пиво бут")!.getCell("F4").result, "n/a");
  assert.deepEqual(loaded.worksheets.slice(0, 9).map((sheet) => sheet.name), [
    "Категория пиво-энергетик", "Пивной напиток", "пиво бут", "пиво жб", "пиво розлив", "Разливные напитки", "Энергетический напиток", "Доли продажи общие", "Доли продаж внутри группы"
  ]);
  for (const sheet of loaded.worksheets) sheet.eachRow((row) => row.eachCell((cell) => assert.notEqual(cell.type, ExcelJS.ValueType.Error)));
});

// Opt-in fixtures are connection-local pg_temp tables inside a transaction.
// No source records, persistent schema, or live export history are modified.
test("receipt comparison nets returns, classifies nested folders, merges legal keys and values each period separately", {
  skip: !process.env.ANALYTICS_TEST_DATABASE_URL
}, async () => {
  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  config.PGSCHEMA = "pg_temp";
  const original = prisma.$transaction;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table document_chek_kkm (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        summa_dokumenta numeric, vid_operatsii text, magazin_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_chek_kkm_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_magaziny (ref_key text, description text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_nomenklatura (
        ref_key text, parent_key text, is_folder boolean, description text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table information_register_sebestoimost_nomenklatury_record_type (
        period timestamp, active boolean, line_number integer, magazin_key text,
        nomenklatura_key text, tsena numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti (
        ref_key text, magazin_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_ustanovka_sebestoimosti_tovary (
        _parent_ref_key text, _parent_line_index integer, nomenklatura_key text, tsena numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov_tovary (
        _parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric, summa_nds numeric) on commit drop`);
      await tx.$executeRawUnsafe(`insert into catalog_magaziny values
        ('a', 'ИП Первая г.Павлодар ул.Толстого 90'),
        ('a', 'ИП Первая г.Павлодар ул.Толстого 90'),
        ('a2', 'ИП Вторая Г.ПАВЛОДАР   УЛ.ТОЛСТОГО 90'),
        ('b', 'ИП Третья г.Павлодар ул.Толстого 91'),
        ('c', '=1+1'), ('d', 'г.Астана ул.Тест 1')`);
      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values
        ('beer', null, true, 'Пиво'), ('beer', null, true, 'Пиво'),
        ('drink', null, true, 'Напитки'), ('energy', null, true, 'Энергетические напитки'),
        ('beerdrink', 'beer', true, 'Пивной напиток'), ('bottle', 'beer', true, 'Пиво бут'),
        ('can', 'beer', true, 'Пиво жб'), ('mix', 'beerdrink', true, 'Разливные напитки'),
        ('mix2', 'drink', true, 'Разливные напитки'), ('pack', 'beer', true, 'Мульти пак'),
        ('i-bottle', 'bottle', false, 'Бутылка'), ('i-can', 'can', false, '=1+1'),
        ('i-can', 'can', false, '=1+1'), ('i-draft', 'mix', false, 'Разлив'),
        ('i-pack', 'pack', false, 'Набор'), ('i-energy', 'energy', false, 'Энергия'),
        ('i-draft-drink', 'mix2', false, 'Разлив из напитков'),
        ('i-root', 'beer', false, 'Прямо в корне'), ('i-bad', 'missing', false, 'Сирота'),
        ('cycle1', 'cycle2', true, 'Цикл'), ('cycle2', 'cycle1', true, 'Цикл'),
        ('i-cycle', 'cycle1', false, 'Товар цикла')`);
      await tx.$executeRawUnsafe(`insert into document_chek_kkm values
        ('pa1', '2025-04-01', false, true, 100, 'Продажа', 'a'),
        ('pa2', '2025-04-02 23:59:59', false, true, 40, 'Продажа', 'a2'),
        ('pb1', '2025-04-01', false, true, 5, 'Продажа', 'b'),
        ('ca1', '2026-04-01', false, true, 250, 'Продажа', 'a'),
        ('ca2', '2026-04-02 23:59:59', false, true, 100, 'Продажа', 'a2'),
        ('ra', '2026-04-02', false, true, 20, 'Возврат', 'a'),
        ('cb1', '2026-04-01', false, true, 50, 'Продажа', 'b'),
        ('rb', '2026-04-02', false, true, -5, 'возврат', 'b'),
        ('cc1', '2026-04-02', false, true, 212, 'Продажа', 'c'),
        ('rc', '2026-04-02', false, true, 120, 'Возврат', 'c'),
        ('no-lines', '2026-04-02', false, true, 7, 'Продажа', 'd'),
        ('deleted', '2026-04-01', true, true, 9999, 'Продажа', 'a'),
        ('unposted', '2026-04-01', false, false, 9999, 'Продажа', 'a'),
        ('before', '2026-03-31 23:59:59', false, true, 9999, 'Продажа', 'a'),
        ('end', '2026-04-03', false, true, 9999, 'Продажа', 'a'),
        ('previous-end', '2025-04-03', false, true, 9999, 'Продажа', 'a'),
        ('zero', '2026-04-01', false, true, 0, 'Продажа', 'a')`);
      await tx.$executeRawUnsafe(`insert into document_chek_kkm_tovary values
        ('pa1', 'i-bottle', 1, 70), ('pa1', 'i-can', 1, 30), ('pa2', 'i-draft', 1, 40),
        ('pb1', 'i-bottle', 1, 5),
        ('ca1', 'i-bottle', 2, 120), ('ca1', 'i-can', 1, 60),
        ('ca1', 'i-draft', 0.5, 20), ('ca1', 'i-draft-drink', 0.5, 20), ('ca1', 'i-pack', 1, 30),
        ('ca2', 'i-bottle', 3, 90), ('ca2', 'i-energy', 1, 10), ('ra', 'i-bottle', 1, 20),
        ('cb1', 'i-bottle', 10, 50), ('rb', 'i-bottle', -1, -5),
        ('cc1', 'i-can', 4, 80), ('cc1', 'i-bad', 2, 100), ('cc1', 'i-cycle', 1, 20), ('cc1', 'i-root', 1, 12),
        ('rc', 'i-bad', 2, 100), ('rc', 'i-cycle', 1, 20),
        ('deleted', 'i-bottle', 1000, 9999), ('unposted', 'i-bottle', 1000, 9999),
        ('before', 'i-bottle', 1000, 9999), ('end', 'i-bottle', 1000, 9999),
        ('previous-end', 'i-bottle', 1000, 9999), ('zero', 'i-bottle', 1000, 9999)`);
      await tx.$executeRawUnsafe(`insert into information_register_sebestoimost_nomenklatury_record_type values
        ('2025-03-01', true, 1, 'a', 'i-bottle', 10), ('2025-03-01', true, 1, 'a', 'i-can', 5),
        ('2025-03-01', true, 1, 'a2', 'i-draft', 9),
        ('2025-04-03', true, 1, 'a', 'i-bottle', 888),
        ('2026-04-02', true, 1, 'a', 'i-bottle', 12), ('2026-04-02', true, 1, 'a', 'i-can', 6),
        ('2026-04-02', true, 1, 'a', 'i-draft', 10), ('2026-04-02', true, 1, 'a', 'i-pack', 4),
        ('2026-04-02', true, 1, 'a', 'i-draft-drink', 10),
        ('2026-04-02', true, 1, 'a2', 'i-bottle', 30), ('2026-04-02', true, 1, 'a2', 'i-energy', 2),
        ('2026-04-03', true, 1, 'a', 'i-bottle', 999)`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov values
        ('purchase-old', '2025-03-01', false, true), ('purchase-new', '2026-03-01', false, true)`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov_tovary values
        ('purchase-old', 'i-bottle', 10, 40, 10), ('purchase-new', 'i-bottle', 10, 100, 30)`);
      prisma.$transaction = (async (work: (client: typeof tx) => Promise<unknown>) => work(tx)) as typeof prisma.$transaction;
      const params = yearComparisonQuerySchema.parse({ from: "2026-04-01", to: "2026-04-03" });
      const report = await getYearComparison(params);
      const merged = report.stores.find((store) => store.sourceStoreKeys.includes("a"))!;
      assert.deepEqual(merged.sourceStoreKeys, ["a", "a2"]);
      assert.equal(merged.comparableByActivity, true);
      assert.equal(report.stores.length, 4);
      const separate = report.stores.find((store) => store.sourceStoreKeys.includes("b"))!;
      assert.notEqual(separate.key, merged.key);
      assert.deepEqual(new Set(report.cohort.selectedStoreKeys), new Set([merged.key, separate.key]));
      const current = report.aggregates.find((value) => value.period === "current" && value.scope === "store" && value.scopeKey === merged.key && value.groupKind === "comparison" && value.groupKey === "combined")!;
      assert.equal(current.quantity, 7);
      assert.equal(current.revenue, 300);
      assert.equal(current.receiptCount, 2);
      assert.equal(current.estimatedCost, 120);
      assert.equal(current.estimatedGrossIncome, 180);
      assert.equal(current.avgAmountPerReceipt, 150);
      const previous = report.aggregates.find((value) => value.period === "previous" && value.scope === "store" && value.scopeKey === merged.key && value.groupKind === "comparison" && value.groupKey === "combined")!;
      assert.equal(previous.revenue, 140);
      assert.equal(previous.estimatedCost, 24);
      assert.equal(previous.estimatedGrossIncome, 116);
      const nested = report.aggregates.find((value) => value.period === "current" && value.scope === "store" && value.scopeKey === merged.key && value.groupKind === "comparison" && value.groupKey === "Разливные напитки")!;
      assert.equal(nested.revenue, 40);
      assert.equal(report.aggregates.some((value) => value.scopeKey === merged.key && value.groupKey === "Пивной напиток"), false);
      assert.equal(report.aggregates.find((value) => value.period === "current" && value.scope === "city" && value.scopeKey === "Павлодар" && value.groupKind === "within" && value.groupKey === "Мульти пак")!.revenue, 30);
      const city = report.aggregates.find((value) => value.period === "current" && value.scope === "city" && value.scopeKey === "Павлодар" && value.groupKind === "comparison" && value.groupKey === "combined")!;
      assert.equal(city.quantity, 16);
      assert.equal(city.revenue, 345);
      assert.equal(city.receiptCount, 3);
      assert.equal(city.avgQuantityPerReceipt, 16 / 3);
      assert.equal(city.avgAmountPerReceipt, 115);
      const all = report.aggregates.find((value) => value.period === "current" && value.scope === "all" && value.groupKind === "comparison" && value.groupKey === "combined")!;
      assert.equal(all.revenue, 425);
      assert.equal(all.receiptCount, 4);
      assert.equal(all.estimatedGrossIncome, null);
      assert.equal(all.unvaluedQuantity, 4);
      assert.equal(all.valuedCost, 183);
      assert.equal(report.dataQuality.taxonomy.find((item) => item.itemKey === "i-bad")!.rootKey, "unmapped");
      assert.equal(report.dataQuality.taxonomy.find((item) => item.itemKey === "i-cycle")!.rootKey, "unmapped");
      assert.equal(report.dataQuality.taxonomy.find((item) => item.itemKey === "i-root")!.member, null);
      assert.equal(report.dataQuality.taxonomy.find((item) => item.itemKey === "i-draft-drink")!.rootName, "Напитки");
      assert.equal(report.dataQuality.taxonomy.find((item) => item.itemKey === "i-draft-drink")!.member, "Разливные напитки");
      const unvaluedRoundTrip = report.aggregates.find((value) => value.period === "current" && value.scope === "store" && value.scopeKey === "key:c" && value.groupKind === "root" && value.groupKey === "unmapped")!;
      assert.equal(unvaluedRoundTrip.quantity, 0);
      assert.equal(unvaluedRoundTrip.revenue, 0);
      assert.equal(unvaluedRoundTrip.unvaluedQuantity, 6);
      assert.equal(unvaluedRoundTrip.estimatedGrossIncome, null);
      const quality = report.dataQuality.periods.find((value) => value.period === "current")!;
      assert.equal(quality.headerRevenue, 474);
      assert.equal(quality.lineRevenue, 467);
      assert.equal(quality.difference, -7);
      assert.equal(quality.receiptsWithoutLines, 1);
      assert.equal(report.coverage.find((value) => value.period === "current")!.receiptCount, 8);
      assert.equal(report.coverage.find((value) => value.period === "previous")!.coveredDays, 2);
      assert.equal(report.dataQuality.valuation.find((value) => value.period === "current" && value.sourceStoreKey === "a" && value.itemKey === "i-bottle")!.unitCost, 12);
      assert.equal(report.dataQuality.valuation.find((value) => value.period === "previous" && value.sourceStoreKey === "a" && value.itemKey === "i-bottle")!.unitCost, 10);
      assert.equal(report.dataQuality.valuation.find((value) => value.period === "current" && value.sourceStoreKey === "b" && value.itemKey === "i-bottle")!.source, "purchase-90d");
      const custom = await getYearComparison({ ...params, cohort: "custom", comparableStore: [separate.key] });
      assert.deepEqual(custom.cohort.selectedStoreKeys, [separate.key]);
      const customTotal = custom.aggregates.find((value) => value.period === "current" && value.scope === "cohort" && value.groupKind === "comparison" && value.groupKey === "combined")!;
      assert.equal(customTotal.revenue, 45);
      assert.equal(customTotal.estimatedCost, 63);
      const empty = await getYearComparison({ ...params, cohort: "custom", comparableStore: [] });
      assert.equal(empty.aggregates.some((value) => value.scope === "cohort"), false);
      await assert.rejects(getYearComparison({ ...params, cohort: "custom", comparableStore: ["key:not-found"] }), (error: unknown) =>
        typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400);
      const noHistory = await getYearComparison({ ...params, from: "2024-02-29", to: "2024-03-01" });
      assert.deepEqual(noHistory.periods.previous, { from: "2023-02-28", to: "2023-03-01" });
      assert.deepEqual(noHistory.coverage.map((value) => [value.coveredDays, value.expectedDays, value.status, value.missingDays]), [
        [0, 1, "empty", ["2024-02-29"]], [0, 1, "empty", ["2023-02-28"]]
      ]);
      assert.equal(noHistory.dataQuality.periods.every((value) => value.lineRevenue === null && value.estimatedGrossIncome === null), true);
      const collapsedPrevious = await getYearComparison({ ...params, from: "2024-02-28", to: "2024-02-29" });
      assert.deepEqual(collapsedPrevious.periods.previous, { from: "2023-02-28", to: "2023-02-28" });
      assert.equal(collapsedPrevious.coverage.find((value) => value.period === "previous")!.expectedDays, 0);
      assert.deepEqual(collapsedPrevious.coverage.find((value) => value.period === "previous")!.missingDays, []);
      const output = new PassThrough();
      const bytes = buffer(output);
      await writeYearComparisonWorkbook(report, output);
      const loaded = new ExcelJS.Workbook();
      await loaded.xlsx.load(await bytes);
      const combined = loaded.getWorksheet("Категория пиво-энергетик")!;
      let cityRow: Row | undefined;
      combined.eachRow((row) => { if (row.getCell(1).value === "Итого Павлодар") cityRow = row; });
      assert.equal(cityRow!.getCell(14).value, 3);
      assert.equal(cityRow!.getCell(17).result, 16 / 3);
      assert.equal(cityRow!.getCell(20).result, 115);
      assert.equal(combined.getRow(combined.rowCount).getCell(11).value, "n/a");
      assert.equal(loaded.getWorksheet("Классификация")!.getColumn(2).values.includes("=1+1"), true);
      const within = loaded.getWorksheet("Доли продаж внутри группы")!;
      let multipack: Row | undefined;
      within.eachRow((row) => { if (row.getCell(1).value === "Мульти пак" && row.getCell(3).value === 30) multipack = row; });
      assert.equal(multipack!.getCell(5).result, 1 / 17);
      assert.equal(multipack!.getCell(6).result, 30 / 375);
      assert.equal(multipack!.getCell(7).result, 26 / 188);
      await tx.$executeRawUnsafe(`insert into document_chek_kkm values
        ('missing-previous', '2025-04-01', false, true, 12, 'Продажа', 'd'),
        ('missing-sale', '2026-04-01', false, true, 30, 'Продажа', 'd'),
        ('missing-return', '2026-04-02', false, true, 10, 'Возврат', 'd')`);
      await tx.$executeRawUnsafe(`insert into document_chek_kkm_tovary values
        ('missing-previous', null, 1, 7), ('missing-previous', '', 1, 5),
        ('missing-sale', null, 2, 20), ('missing-sale', '', 1, 10),
        ('missing-return', null, 1, 10)`);
      const missingItems = await getYearComparison(params);
      const missingTaxonomy = missingItems.dataQuality.taxonomy.filter((item) => item.itemKey === "");
      assert.equal(missingTaxonomy.length, 1);
      assert.equal(missingTaxonomy[0].name, "Без номенклатуры");
      assert.equal(missingTaxonomy[0].rootKey, "unmapped");
      assert.equal(missingTaxonomy[0].member, null);
      assert.equal(missingTaxonomy[0].issue, "Нет ссылки в каталоге");
      assert.equal(missingTaxonomy[0].currentQuantity, 2);
      assert.equal(missingTaxonomy[0].currentRevenue, 20);
      assert.equal(missingTaxonomy[0].previousQuantity, 2);
      assert.equal(missingTaxonomy[0].previousRevenue, 12);
      const missingStore = missingItems.stores.find((store) => store.sourceStoreKeys.includes("d"))!;
      const missingTotal = missingItems.aggregates.find((value) => value.period === "current"
        && value.scope === "store" && value.scopeKey === missingStore.key
        && value.groupKind === "root" && value.groupKey === "unmapped")!;
      assert.equal(missingTotal.quantity, 2);
      assert.equal(missingTotal.revenue, 20);
      assert.equal(missingTotal.lineCount, 3);
      assert.equal(missingTotal.receiptCount, 1);
      assert.equal(missingTotal.avgQuantityPerReceipt, 2);
      assert.equal(missingTotal.avgAmountPerReceipt, 20);
      assert.equal(missingTotal.unvaluedQuantity, 4);
      assert.equal(missingTotal.estimatedCost, null);
      assert.equal(missingTotal.estimatedGrossIncome, null);
      const missingValuation = missingItems.dataQuality.valuation.filter((value) => value.itemKey === "");
      assert.equal(missingValuation.length, 2);
      for (const value of missingValuation) {
        assert.equal(value.sourceStoreKey, "d");
        assert.equal(value.unitCost, null);
        assert.equal(value.source, "unavailable");
        assert.equal(value.quantity, 2);
        assert.equal(value.revenue, value.period === "current" ? 20 : 12);
        assert.equal(value.absoluteQuantity, value.period === "current" ? 4 : 2);
        assert.equal(value.valuedCost, null);
      }
      const missingQuality = missingItems.dataQuality.periods.find((value) => value.period === "current")!;
      assert.equal(missingQuality.headerRevenue, quality.headerRevenue! + 20);
      assert.equal(missingQuality.lineRevenue, quality.lineRevenue! + 20);
      assert.equal(missingQuality.difference, quality.difference);
      assert.equal(missingQuality.lineCount, quality.lineCount + 3);
      assert.equal(missingQuality.receiptsWithoutLines, 1);
      assert.equal(missingItems.coverage.find((value) => value.period === "current")!.receiptCount, 10);
    }, { timeout: 60000 });
  } finally {
    prisma.$transaction = original;
    await prisma.$disconnect();
  }
});
