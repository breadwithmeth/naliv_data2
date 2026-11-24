import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { buffer } from "node:stream/consumers";
import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { verifyReloadConsumer } from "./reload-consumer-fixture.js";
import type * as CompensationEngine from "../src/services/marketing-compensation.js";
import { decodePurchasePriceEvidence } from "../src/services/marketing-compensation-purchase-price.js";
import type { MarketingCompensationReport } from "../src/services/marketing-compensation-types.js";
import { writeMarketingCompensationWorkbook } from "../src/services/marketing-compensation-workbook.js";

// Real PostgreSQL TEMP fixtures only: source records are never changed.
async function withCompensationSources(run: (
  tx: Prisma.TransactionClient, engine: typeof CompensationEngine
) => Promise<void>) {
  process.env.DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL;
  process.env.PGSCHEMA = "pg_temp";
  process.env.REPORT_CACHE_TTL_SECONDS = "0";
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
  // Exercise configuration's module-loading boundary after selecting the connection-local TEMP schema.
  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  const engine = await import("../src/services/marketing-compensation.js");
  config.PGSCHEMA = "pg_temp";
  const original = prisma.$queryRaw;
  try {
    await prisma.$transaction(async tx => {
      for (const definition of [
        "document_marketingovaya_aktsiya (ref_key text, number text, naimenovanie_aktsii text, data_nachala_deystviya timestamp, data_okonchaniya_deystviya timestamp, dlya_vseh_magazinov boolean, posted boolean, deletion_mark boolean)",
        "document_marketingovaya_aktsiya_skidki_natsenki (_parent_ref_key text, ref_key text, skidka_natsenka_key text, magazin_key text, data_nachala timestamp, data_okonchaniya timestamp)",
        "document_marketingovaya_aktsiya_magaziny (_parent_ref_key text, ref_key text, magazin_key text)",
        "catalog_skidki_natsenki (ref_key text, description text, sposob_predostavleniya text, znachenie_skidki_natsenki numeric, segment_nomenklatury_predostavleniya_key text, deletion_mark boolean)",
        "catalog_segmenty_nomenklatury (ref_key text, description text, deletion_mark boolean)",
        "information_register_nomenklatura_segmenta (segment_key text, nomenklatura_key text, harakteristika_key text)",
        "catalog_magaziny (ref_key text, description text, deletion_mark boolean)",
        "catalog_nomenklatura (ref_key text, description text, naimenovanie_polnoe text, shtrihkod text, deletion_mark boolean)",
        "document_otchet_o_roznichnyh_prodazhah (ref_key text, date timestamp, magazin_key text, posted boolean, deletion_mark boolean)",
        "document_otchet_o_roznichnyh_prodazhah_tovary (_parent_ref_key text, ref_key text, nomenklatura_key text, harakteristika_key text, kolichestvo numeric, tsena numeric, summa numeric)",
        "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary (_parent_ref_key text, ref_key text, nomenklatura_key text, harakteristika_key text, kolichestvo numeric, tsena numeric)"
      ]) await tx.$executeRawUnsafe(`create temp table ${definition} on commit drop`);
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya values
        ('a','26','Акция 26%','2026-09-02','2026-09-30',false,true,false),
        ('b','2','Вторая активность','2026-09-02','2026-09-30',false,true,false),
        ('outside','4','Другой период','2026-10-01','2026-10-31',false,true,false)`);
      await tx.$executeRawUnsafe(`insert into catalog_magaziny values ('s1','Один',false),('s2','Два',false)`);
      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values ('i','Краткое','Полное имя','001234',false)`);
      await tx.$executeRawUnsafe(`insert into catalog_segmenty_nomenklatury values ('seg','Состав',false)`);
      await tx.$executeRawUnsafe(`insert into information_register_nomenklatura_segmenta values ('seg','i',null),('seg','i',null)`);
      await tx.$executeRawUnsafe(`insert into catalog_skidki_natsenki values ('d','10% в строке','Подарок',99,'seg',false)`);
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya_skidki_natsenki values
        ('a',null,'d',null,'2026-09-02','2026-09-30'),('a',null,'d',null,'2026-09-02','2026-09-30'),
        ('b',null,'d','s1','2026-09-02','2026-09-30')`);
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya_magaziny values ('a',null,'s1'),('a',null,'s2')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('before','2026-09-01','s1',true,false),('r','2026-09-30 23:59:59','s1',true,false),
        ('other','2026-09-10','s2',true,false),('end','2026-10-01','s1',true,false),('deleted','2026-09-20','s1',true,true)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('before',null,'i',null,1000,1,1000),('r',null,'i',null,2,1000,1800),('other',null,'i',null,3,500,1500),
        ('end',null,'i',null,1000,1,1000),('deleted',null,'i',null,1000,1,1000),('r',null,'i','other',1000,1,1000)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary values ('r',null,'i',null,1,800)`);
      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      await run(tx, engine);
    }, { timeout: 60000 });
  } finally { prisma.$queryRaw = original; await prisma.$disconnect(); }
}

test("retail-rule compensation uses rule prefixes and exact movement prices with certified returns", {
  skip: !process.env.ANALYTICS_TEST_DATABASE_URL
}, async () => {
  await withCompensationSources(async (tx, { getMarketingCompensationReport, getMarketingCompensationActivities }) => {
      const certified = async () => ({ returnPriceIntervals: [{ from: "2026-09-01", to: "2026-10-01" }] });
      const unverified = async () => ({ returnPriceIntervals: [] });
      const params = { from: new Date("2026-09-01"), to: new Date("2026-10-01"), calculationMode: "retail-rule" as const };
      const selected = { ...params, activityKey: "b", includeIncomplete: true };
      const read = () => getMarketingCompensationReport(selected, certified);
      assert.deepEqual((await getMarketingCompensationActivities(params)).activities.map(a => a.key).sort(), ["a", "b"]);
      const result = await getMarketingCompensationReport(params, certified);
      assert.equal(result.calculationMode, "retail-rule");
      const s1 = result.activities.find(a => a.key === "a")!.branches.find(b => b.key === "s1")!;
      assert.deepEqual(s1.rows.map(r => [r.price, r.quantity, r.unitCompensation, r.compensation]), [[800, -1, 80, -80], [1000, 2, 100, 200]]);
      assert.equal(s1.hasSales, true);
      assert.equal(s1.hasReturns, true);
      assert.equal(s1.rows[0].name, "Полное имя");
      assert.equal(s1.rows[0].barcode, "001234");
      assert.equal(s1.totals.compensation, 120);
      assert.equal(result.totals.compensation, 390);
      for (const [description, rate] of [[" 18,57% в строке", 18.57], ["10,5% правило", 10.5], ["10.5%", 10.5], ["0%", 0], ["100%", 100]] as const) {
        await tx.$executeRawUnsafe("update catalog_skidki_natsenki set description=$1", description);
        assert.equal((await read()).activities[0].branches[0].rows[0].discountPct, rate);
      }
      for (const description of ["процент 10%", "-5%", "+5%", "101%", "100.01%", "26", "NaN%", "Infinity%", null]) {
        await tx.$executeRawUnsafe("update catalog_skidki_natsenki set description=$1", description);
        const unknown = await read();
        assert.equal(unknown.totals.compensation, null);
        assert.ok(unknown.activities[0].branches[0].rows.every(r => r.discountPct === null && r.issues.some(i => i.code === "missing_percentage")));
      }
      await tx.$executeRawUnsafe("update catalog_skidki_natsenki set description='10% правило'");
      const notCertified = await getMarketingCompensationReport(selected, unverified);
      assert.equal(notCertified.totals.compensation, null);
      assert.equal(notCertified.totals.knownCompensation, 200);
      assert.ok(notCertified.activities[0].branches[0].rows.some(r => r.issues.some(i => i.code === "return_price_unverified")));
      const defaultNotCertified = await getMarketingCompensationReport({ ...selected, includeIncomplete: false }, unverified);
      assert.equal(defaultNotCertified.excludedIncompleteRows, 1);
      assert.deepEqual(defaultNotCertified.activities[0].branches[0].rows.map(row => row.price), [1000]);
      // Negative and positive source return quantities both mean a return.
      await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary set kolichestvo=-1");
      assert.equal((await read()).totals.compensation, 120);
      // Same-price full return still belongs to the sales block, not return-only.
      await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary set kolichestvo=2,tsena=1000");
      const netZero = (await read()).activities[0].branches[0];
      assert.deepEqual(netZero.rows.map(r => [r.quantity, r.compensation]), [[0, 0]]);
      assert.equal(netZero.hasSales, true);
      assert.equal(netZero.hasReturns, true);
      await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah_tovary set kolichestvo=0 where _parent_ref_key='r' and harakteristika_key is null");
      const onlyReturn = (await read()).activities[0].branches[0];
      assert.equal(onlyReturn.hasSales, false);
      assert.equal(onlyReturn.hasReturns, true);
      assert.equal(onlyReturn.totals.compensation, -200);
      // Negative sale-table movements are adjustments with their original sign.
      await tx.$executeRawUnsafe("delete from document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary");
      await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah_tovary set kolichestvo=-0.15,tsena=1 where _parent_ref_key='r' and harakteristika_key is null");
      const fractional = (await read()).activities[0].branches[0];
      assert.equal(fractional.hasReturns, true);
      assert.equal(fractional.hasSales, false);
      assert.equal(fractional.rows[0].compensation, -0.02);
      await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah_tovary set kolichestvo=2,tsena=0 where _parent_ref_key='r' and harakteristika_key is null");
      assert.equal((await read()).totals.compensation, 0);
      for (const price of [null, -1, "NaN", "Infinity"]) {
        await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah_tovary set tsena=$1::numeric where _parent_ref_key='r' and harakteristika_key is null", price);
        const missing = (await read()).activities[0].branches[0].rows[0];
        assert.equal(missing.price, null);
        assert.equal(missing.compensation, null);
        assert.ok(missing.issues.some(i => i.code === "missing_price"));
      }
      await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah_tovary set tsena=1000,kolichestvo=null where _parent_ref_key='r' and harakteristika_key is null");
      assert.equal((await read()).totals.compensation, null);
      await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah_tovary set kolichestvo=2 where _parent_ref_key='r' and harakteristika_key is null");
      await tx.$executeRawUnsafe("update catalog_nomenklatura set shtrihkod=null");
      const noBarcode = await read();
      assert.equal(noBarcode.totals.compensation, 200);
      assert.ok(noBarcode.activities[0].branches[0].rows[0].issues.some(i => i.code === "missing_barcode"));
      // A later price must become another row, not overwrite the first group.
      await tx.$executeRawUnsafe("insert into document_otchet_o_roznichnyh_prodazhah_tovary values ('r',null,'i',null,1,800,720)");
      assert.deepEqual((await read()).activities[0].branches[0].rows.map(r => r.compensation), [80, 200]);
      await tx.$executeRawUnsafe("insert into catalog_skidki_natsenki values ('conflict','20%','Процент',10,'seg',false)");
      await tx.$executeRawUnsafe("insert into document_marketingovaya_aktsiya_skidki_natsenki values ('b',null,'conflict','s1','2026-09-02','2026-09-30')");
      const conflict = await read();
      assert.equal(conflict.totals.compensation, null);
      assert.equal(conflict.activities[0].branches[0].rows[0].quantity, 1);
      assert.ok(conflict.activities[0].branches[0].rows[0].issues.some(i => i.code === "conflicting_percentage"));
      await tx.$executeRawUnsafe("delete from document_marketingovaya_aktsiya_skidki_natsenki where skidka_natsenka_key='conflict'");
      // No matching movements is known zero even with a malformed prefix.
      await tx.$executeRawUnsafe("update catalog_skidki_natsenki set description='нет процента' where ref_key='d'");
      await tx.$executeRawUnsafe("delete from document_otchet_o_roznichnyh_prodazhah_tovary where _parent_ref_key='r' and harakteristika_key is null");
      const absent = await read();
      assert.equal(absent.totals.compensation, 0);
      assert.equal(absent.activities[0].branches[0].rows.length, 0);
      assert.ok(absent.activities[0].issues.some(i => i.code === "missing_percentage"));
      // Before deployment DDL, missing return column is safe and unknown.
      await tx.$executeRawUnsafe("alter table document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary drop column tsena");
      await tx.$executeRawUnsafe("insert into document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary values ('r',null,'i',null,1)");
      assert.equal((await getMarketingCompensationReport(selected, unverified)).totals.compensation, null);
      // Unknown store of a relevant SKU blocks even an otherwise empty scope.
      await tx.$executeRawUnsafe("insert into document_otchet_o_roznichnyh_prodazhah values ('unknown','2026-09-15',null,true,false)");
      await tx.$executeRawUnsafe("insert into document_otchet_o_roznichnyh_prodazhah_tovary values ('unknown',null,'i',null,1,1000,900)");
      const unknownStore = await read();
      assert.equal(unknownStore.totals.compensation, null);
      assert.ok(unknownStore.issues.some(i => i.code === "missing_branch"));
      await tx.$executeRawUnsafe("drop table information_register_nomenklatura_segmenta");
      const unsynced = await read();
      assert.equal(unsynced.totals.compensation, null);
      assert.ok(unsynced.issues.some(i => i.code === "missing_source"));
  });
});

test("purchase-title prices exact movements by store, dimensions and timestamp and fails closed without proof", {
  skip: !process.env.ANALYTICS_TEST_DATABASE_URL
}, async () => {
  await withCompensationSources(async (tx, { getMarketingCompensationReport }) => {
    const returnPriceIntervals = [{ from: "2026-09-01", to: "2026-10-01" }];
    let retailCoverage = returnPriceIntervals;
    const retailSource = {
      key: "retail", entity: "Document_ОтчетОРозничныхПродажах", kind: "dated" as const, floor: "2026-09-01", required: true,
      tables: ["document_otchet_o_roznichnyh_prodazhah", "document_otchet_o_roznichnyh_prodazhah_tovary", "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary"]
    };
    const priceSource = {
      key: "prices", entity: "Document_УстановкаЦенНоменклатуры", kind: "dated" as const, floor: "2026-08-01", required: true,
      tables: ["document_ustanovka_tsen_nomenklatury", "document_ustanovka_tsen_nomenklatury_tovary"]
    };
    const selected = { from: new Date("2026-09-01"), to: new Date("2026-10-01"), activityKey: "b", includeIncomplete: true };
    const readRetail = () => getMarketingCompensationReport({ ...selected, calculationMode: "retail-rule" }, async () => ({ returnPriceIntervals }));
    const first = {
      priceTypeKey: "purchase-1", itemKey: "i", characteristicKey: null, packagingKey: null,
      documentKeys: ["first"], effectiveAt: "2026-08-30T13:00:00", price: "600", currency: "KZT",
      verifiedThroughExclusive: "2026-09-30T12:00:00"
    };
    const second = { ...first, documentKeys: ["second"], effectiveAt: "2026-09-30T12:00:00", price: "500", verifiedThroughExclusive: "2026-10-01T00:00:00" };
    const valid = { version: 2, scopes: [first, second] };
    let evidence: unknown = valid;
    let priceCoverage = [{ from: "2026-08-01", to: "2026-09-01" }, { from: "2026-09-01", to: "2026-10-01" }];
    const read = (params = selected) => getMarketingCompensationReport(params, async () => ({
      coverageSources: [{ source: priceSource, intervals: priceCoverage }, { source: retailSource, intervals: retailCoverage }],
      returnPriceIntervals: []
    }), decodePurchasePriceEvidence(JSON.stringify(evidence) ?? ""));
    const zero = "00000000-0000-0000-0000-000000000000";
    const summarize = async () => {
      const report = await read();
      return report.activities[0].branches[0];
    };
    const hasIssue = (row: { issues: Array<{ code: string }> }, code: string) => row.issues.some(i => i.code === code);
    const openWorkbook = async (report: MarketingCompensationReport) => {
      const output = new PassThrough();
      const [, bytes] = await Promise.all([writeMarketingCompensationWorkbook(report, output), buffer(output)]);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes);
      return workbook;
    };

    await tx.$executeRawUnsafe("update document_marketingovaya_aktsiya set naimenovanie_aktsii='Акция ноябрь 2026 25%' where ref_key='b'");
    await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah set date='2026-09-30 00:30' where ref_key='r'");
    await tx.$executeRawUnsafe("insert into document_otchet_o_roznichnyh_prodazhah values ('return','2026-09-30 12:00','s1',true,false)");
    await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary set _parent_ref_key='return', harakteristika_key=''");
    await tx.$executeRawUnsafe("alter table catalog_magaziny add column vid_tsen_zakupa_key text");
    await tx.$executeRawUnsafe("update catalog_magaziny set vid_tsen_zakupa_key = case ref_key when 's1' then 'purchase-1' else 'purchase-2' end");
    for (const definition of [
      "catalog_vidy_tsen (ref_key text, description text, is_folder boolean, deletion_mark boolean)",
      "document_ustanovka_tsen_nomenklatury (ref_key text, date timestamp, posted boolean, deletion_mark boolean)",
      "document_ustanovka_tsen_nomenklatury_tovary (_parent_ref_key text, ref_key text, vid_tseny_key text, nomenklatura_key text, harakteristika_key text, upakovka_key text, tsena numeric)"
    ]) await tx.$executeRawUnsafe(`create temp table ${definition} on commit drop`);
    await tx.$executeRawUnsafe(`insert into catalog_vidy_tsen values
      ('purchase-1','Не искать по названию',null,false), ('purchase-2','закуп',null,false)`);
    await tx.$executeRawUnsafe(`insert into document_ustanovka_tsen_nomenklatury values
      ('first','2026-08-30 13:00',true,false), ('second','2026-09-30 12:00',true,false),
      ('unposted','2026-09-30 11:59',false,false), ('deleted','2026-09-30 11:59',true,true),
      ('future','2026-09-30 13:00',true,false), ('different','2026-09-30 11:59',true,false)`);
    await tx.$executeRawUnsafe(`insert into document_ustanovka_tsen_nomenklatury_tovary values
      (null,'first','purchase-1','i','${zero}',null,600), ('first',null,'purchase-1','i',null,'${zero}',600.00),
      ('second',null,'purchase-1','i','','',500), ('future',null,'purchase-1','i',null,null,99),
      ('unposted',null,'purchase-1','i',null,null,75), ('deleted',null,'purchase-1','i',null,null,76),
      ('different',null,'purchase-2','i',null,null,77), ('different',null,'purchase-1','i','other',null,78),
      ('different',null,'purchase-1','i',null,'case',79), ('different',null,'purchase-1','other',null,null,80)`);
    const purchased = await read();
    assert.equal(purchased.calculationMode, "purchase-title");
    const branch = purchased.activities[0].branches[0];
    assert.deepEqual(branch.rows.map(r => [r.price, r.discountPct, r.quantity, r.unitCompensation, r.compensation]),
      [[500, 25, -1, 125, -125], [600, 25, 2, 150, 300]]);
    assert.equal(purchased.totals.compensation, 175);
    assert.equal((await read({ ...selected, from: new Date("2026-09-30") })).totals.compensation, 175);
    assert.equal(branch.hasSales, true);
    assert.equal(branch.hasReturns, true);
    const retail = await readRetail();
    assert.equal(retail.totals.compensation, 120);
    for (const [report, total, mode, detail] of [
      [purchased, 175, /Закупочная цена и процент из названия акции/, [[500, 0.25, -1, -125], [600, 0.25, 2, 300]]],
      [retail, 120, /Прежний расчёт: розничная цена и процент из правила/, [[800, 0.1, -1, -80], [1000, 0.1, 2, 200]]]
    ] as const) {
      const workbook = await openWorkbook(report);
      const summary = workbook.getWorksheet("Компенсации")!;
      assert.match(summary.getCell("A2").text, mode);
      const totals: ExcelJS.CellValue[] = [];
      summary.eachRow(row => { if (row.getCell(1).text === "ОБЩИЙ ИТОГ") totals.push(row.getCell(5).value); });
      assert.deepEqual(totals, [total]);
      const items: ExcelJS.CellValue[][] = [];
      workbook.getWorksheet("Детализация")!.eachRow(row => {
        if (row.getCell(2).text === "Полное имя") items.push([3, 4, 6, 7].map(i => row.getCell(i).value));
      });
      assert.deepEqual(items, detail);
    }

    await tx.$executeRawUnsafe("insert into document_ustanovka_tsen_nomenklatury values ('second-duplicate','2026-09-30 12:00',true,false)");
    await tx.$executeRawUnsafe("insert into document_ustanovka_tsen_nomenklatury_tovary values ('second-duplicate',null,'purchase-1','i',null,null,500)");
    const uncoveredRegistrar = await summarize();
    assert.equal(uncoveredRegistrar.totals.knownCompensation, 300);
    assert.ok(uncoveredRegistrar.rows.some(r => r.quantity === -1 && r.price === null && hasIssue(r, "purchase_price_unverified")));
    evidence = { version: 2, scopes: [first, { ...second, documentKeys: ["second", "second-duplicate"] }] };
    assert.equal((await summarize()).totals.compensation, 175);
    await tx.$executeRawUnsafe("delete from document_ustanovka_tsen_nomenklatury_tovary where _parent_ref_key='second-duplicate'");
    evidence = valid;

    await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah set date='2026-09-29 12:00' where ref_key='r'");
    retailCoverage = [{ from: "2026-09-01", to: "2026-09-30" }];
    const uncoveredMovement = await summarize();
    assert.deepEqual(uncoveredMovement.totals, { compensation: null, knownCompensation: 300, incompleteRows: 1 });
    assert.equal(uncoveredMovement.hasSales && uncoveredMovement.hasReturns, true);
    assert.ok(hasIssue(uncoveredMovement, "retail_movement_unverified"));
    assert.ok(uncoveredMovement.rows.some(r => r.quantity === -1 && r.price === 500 && r.compensation === null
      && hasIssue(r, "retail_movement_unverified") && !hasIssue(r, "return_price_unverified")));
    assert.equal((await readRetail()).totals.compensation, 120);
    retailCoverage = returnPriceIntervals;
    await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah set date='2026-09-30 00:30' where ref_key='r'");

    for (const altered of [
      { ...second, price: "501" }, { ...second, currency: "USD" }, { ...second, documentKeys: ["other"] },
      { ...second, verifiedThroughExclusive: "2026-09-30T12:00:00" }, { ...second, characteristicKey: "other" },
      { ...second, packagingKey: "case" }, { ...second, effectiveAt: "2026-09-30T11:59:59" }
    ]) {
      evidence = { version: 2, scopes: [first, altered] };
      const unverified = await summarize();
      assert.deepEqual(unverified.totals, { compensation: null, knownCompensation: 300, incompleteRows: 1 }, JSON.stringify(altered));
      assert.ok(unverified.rows.some(r => r.quantity === -1 && r.price === null && hasIssue(r, "purchase_price_unverified")), JSON.stringify(altered));
    }
    evidence = { version: 2, scopes: [first] };
    const partialWorkbook = await openWorkbook(await read());
    const partialTotals: ExcelJS.CellValue[][] = [];
    partialWorkbook.getWorksheet("Компенсации")!.eachRow(row => {
      if (row.getCell(1).text === "ОБЩИЙ ИТОГ") partialTotals.push([row.getCell(5).value, row.getCell(6).value]);
    });
    assert.deepEqual(partialTotals, [["Не рассчитано", 300]]);
    const issueRows: string[] = [];
    partialWorkbook.getWorksheet("Диагностика")!.eachRow(row => {
      if (row.getCell(6).text === "purchase_price_unverified") issueRows.push(row.getCell(7).text);
    });
    assert.equal(issueRows.length, 1);
    assert.match(issueRows[0], /Закупочная цена не подтверждена/);
    evidence = undefined;
    const noEvidence = await summarize();
    assert.deepEqual(noEvidence.rows.map(r => [r.price, r.quantity]), [[null, 1]]);
    assert.equal(noEvidence.hasSales && noEvidence.hasReturns, true);
    assert.equal(noEvidence.totals.knownCompensation, 0);
    const projected = await read({ ...selected, includeIncomplete: false });
    assert.equal(projected.excludedIncompleteRows, 1);
    assert.ok(projected.excludedIncompleteDiagnostics?.some(d => hasIssue(d, "purchase_price_unverified")));
    evidence = valid;

    priceCoverage = [{ from: "2026-08-01", to: "2026-09-10" }, { from: "2026-09-11", to: "2026-10-01" }];
    const gap = await summarize();
    assert.deepEqual(gap.totals, { compensation: null, knownCompensation: -125, incompleteRows: 1 });
    assert.ok(gap.rows.some(r => r.quantity === 2 && r.price === null && hasIssue(r, "purchase_price_unverified")));
    priceCoverage = [{ from: "2026-08-01", to: "2026-10-01" }];

    await tx.$executeRawUnsafe("update document_ustanovka_tsen_nomenklatury_tovary set _parent_ref_key='future' where _parent_ref_key='second'");
    evidence = { version: 2, scopes: [{ ...first, verifiedThroughExclusive: "2026-10-01T00:00:00" }] };
    // An absent change must not invalidate another store's key or reset to retail price.
    await tx.$executeRawUnsafe("delete from document_ustanovka_tsen_nomenklatury_tovary where vid_tseny_key='purchase-2'");
    await tx.$executeRawUnsafe("delete from document_otchet_o_roznichnyh_prodazhah_tovary where _parent_ref_key='other'");
    await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah set magazin_key='s2' where ref_key='return'");
    await tx.$executeRawUnsafe("update document_marketingovaya_aktsiya set dlya_vseh_magazinov=true where ref_key='b'");
    await tx.$executeRawUnsafe("update document_marketingovaya_aktsiya_skidki_natsenki set magazin_key=null where _parent_ref_key='b'");
    const otherStore = (await read()).activities[0].branches.find(b => b.key === "s2")!;
    assert.ok(otherStore.rows.some(r => r.quantity === -1 && r.price === null && hasIssue(r, "missing_purchase_price")));
    assert.equal(otherStore.hasReturns, true);
    assert.equal((await readRetail()).activities[0].branches.find(b => b.key === "s2")!.rows.find(r => r.quantity === -1)?.compensation, -80);
    await tx.$executeRawUnsafe("update document_marketingovaya_aktsiya_skidki_natsenki set magazin_key='s1' where _parent_ref_key='b'");
    await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah set magazin_key='s1' where ref_key='return'");
    await tx.$executeRawUnsafe("update document_ustanovka_tsen_nomenklatury_tovary set _parent_ref_key='second' where _parent_ref_key='future' and tsena=500");
    evidence = valid;

    await tx.$executeRawUnsafe("insert into document_ustanovka_tsen_nomenklatury_tovary values ('second',null,'purchase-1','i',null,null,510)");
    const conflict = await summarize();
    assert.equal(conflict.totals.knownCompensation, 300);
    assert.ok(conflict.rows.some(r => r.quantity === -1 && r.price === null && hasIssue(r, "ambiguous_purchase_price")));
    await tx.$executeRawUnsafe("delete from document_ustanovka_tsen_nomenklatury_tovary where tsena=510");
    for (const price of [null, "0", "-1", "NaN", "Infinity"]) {
      await tx.$executeRawUnsafe("update document_ustanovka_tsen_nomenklatury_tovary set tsena=$1::numeric where _parent_ref_key='second'", price);
      const malformed = await summarize();
      assert.equal(malformed.totals.knownCompensation, 300);
      assert.ok(malformed.rows.some(r => r.quantity === -1 && r.price === null && hasIssue(r, "missing_purchase_price")));
    }
    await tx.$executeRawUnsafe("update document_ustanovka_tsen_nomenklatury_tovary set tsena=500 where _parent_ref_key='second'");
    await tx.$executeRawUnsafe("update catalog_vidy_tsen set is_folder=true where ref_key='purchase-1'");
    assert.ok((await summarize()).rows.every(r => r.price === null && hasIssue(r, "missing_purchase_price_type")));
    await tx.$executeRawUnsafe("update catalog_vidy_tsen set is_folder=false where ref_key='purchase-1'");
    await tx.$executeRawUnsafe("update catalog_vidy_tsen set deletion_mark=true where ref_key='purchase-1'");
    assert.ok((await summarize()).rows.every(r => r.price === null && hasIssue(r, "missing_purchase_price_type")));
    await tx.$executeRawUnsafe("update catalog_vidy_tsen set deletion_mark=false where ref_key='purchase-1'");
    await tx.$executeRawUnsafe("update catalog_magaziny set vid_tsen_zakupa_key=null where ref_key='s1'");
    assert.ok((await summarize()).rows.every(r => r.price === null && hasIssue(r, "missing_purchase_price_type")));
    await tx.$executeRawUnsafe("update catalog_magaziny set vid_tsen_zakupa_key='purchase-1' where ref_key='s1'");

    await tx.$executeRawUnsafe("alter table document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary drop column tsena");
    assert.equal((await summarize()).totals.compensation, 175);
    assert.equal((await readRetail()).totals.knownCompensation, 200);

    for (const [title, expected] of [["0%", 0], ["Акция 100%", 700], ["Акция 12,5% и повтор 12.50%", 87.5]] as const) {
      await tx.$executeRawUnsafe("update document_marketingovaya_aktsiya set naimenovanie_aktsii=$1 where ref_key='b'", title);
      assert.equal((await summarize()).totals.compensation, expected);
    }
    for (const [title, code] of [[null, "missing_percentage"], ["25% и 30%", "conflicting_percentage"]] as const) {
      await tx.$executeRawUnsafe("update document_marketingovaya_aktsiya set naimenovanie_aktsii=$1, number='25%' where ref_key='b'", title);
      const unknown = await read();
      assert.equal(unknown.totals.compensation, null);
      assert.ok(unknown.activities[0].branches[0].rows.every(r => r.discountPct === null && hasIssue(r, code)));
      assert.ok(hasIssue(unknown.activities[0], code));
    }

    await tx.$executeRawUnsafe("update document_marketingovaya_aktsiya set naimenovanie_aktsii='10%' where ref_key='b'");
    await tx.$executeRawUnsafe("update document_ustanovka_tsen_nomenklatury_tovary set tsena=1.251 where _parent_ref_key='second'");
    evidence = { version: 2, scopes: [first, { ...second, price: "1.251" }] };
    await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary set kolichestvo=0.5");
    const rounded = (await summarize()).rows.find(r => r.quantity === -0.5)!;
    assert.deepEqual([rounded.unitCompensation, rounded.compensation], [0.13, -0.07]);

    await tx.$executeRawUnsafe("update document_ustanovka_tsen_nomenklatury_tovary set tsena=600 where _parent_ref_key='second'");
    evidence = { version: 2, scopes: [first, { ...second, price: "600" }] };
    await tx.$executeRawUnsafe("update document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary set kolichestvo=2");
    const netZero = await summarize();
    assert.deepEqual(netZero.rows.map(r => [r.price, r.quantity, r.compensation]), [[600, 0, 0]]);
    assert.equal(netZero.hasSales, true);
    assert.equal(netZero.hasReturns, true);

    await tx.$executeRawUnsafe("drop table document_ustanovka_tsen_nomenklatury_tovary");
    const unsynced = await summarize();
    assert.ok(unsynced.rows.some(r => r.price === null && hasIssue(r, "purchase_price_unverified")));
    await tx.$executeRawUnsafe("delete from document_otchet_o_roznichnyh_prodazhah_tovary where _parent_ref_key='r' and harakteristika_key is null");
    await tx.$executeRawUnsafe("delete from document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary");
    await tx.$executeRawUnsafe("update document_marketingovaya_aktsiya set naimenovanie_aktsii='Недействительный диапазон 25–30%' where ref_key='b'");
    const noMovements = await summarize();
    retailCoverage = [{ from: "2026-09-02", to: "2026-09-30" }];
    const unverifiedInactivity = await summarize();
    assert.deepEqual(unverifiedInactivity.rows, []);
    assert.equal(unverifiedInactivity.totals.compensation, null);
    assert.ok(hasIssue(unverifiedInactivity, "retail_movement_unverified"));
    retailCoverage = returnPriceIntervals;
    assert.deepEqual(noMovements.rows, []);
    assert.equal(noMovements.hasSales || noMovements.hasReturns, false);
    assert.equal((await read()).totals.compensation, 0);
  });
});

test("reload readiness temporary global gate refuses cached compensation workbook", { skip: !process.env.ANALYTICS_TEST_DATABASE_URL }, async () => {
  await verifyReloadConsumer("/compensations", "all");
});
