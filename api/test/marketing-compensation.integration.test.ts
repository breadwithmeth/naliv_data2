import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyReloadConsumer } from "./reload-consumer-fixture.js";

// Real PostgreSQL TEMP fixtures only: source records are never changed.
test("compensations use rule prefixes and exact movement prices with certified returns", {
  skip: !process.env.ANALYTICS_TEST_DATABASE_URL
}, async () => {
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
  const { getMarketingCompensationReport, getMarketingCompensationActivities } = await import("../src/services/marketing-compensation.js");
  config.PGSCHEMA = "pg_temp";
  const original = prisma.$queryRaw;
  const certified = async () => ({ returnPriceIntervals: [{ from: "2026-09-01", to: "2026-10-01" }] });
  const unverified = async () => ({ returnPriceIntervals: [] });
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
      const params = { from: new Date("2026-09-01"), to: new Date("2026-10-01") };
      const selected = { ...params, activityKey: "b" };
      const read = () => getMarketingCompensationReport(selected, certified);
      assert.deepEqual((await getMarketingCompensationActivities(params)).activities.map(a => a.key).sort(), ["a", "b"]);
      const result = await getMarketingCompensationReport(params, certified);
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
    }, { timeout: 60000 });
  } finally { prisma.$queryRaw = original; await prisma.$disconnect(); }
});

test("reload readiness temporary global gate refuses cached compensation workbook", { skip: !process.env.ANALYTICS_TEST_DATABASE_URL }, async () => {
  await verifyReloadConsumer("/compensations", "all");
});
