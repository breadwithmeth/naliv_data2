import assert from "node:assert/strict";
import { test } from "node:test";

// Real PostgreSQL TEMP fixtures only: source records are never changed.
test("compensations preserve source rates, purchase-price cutoff, returns, independent activities and incomplete totals", {
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
  // Configuration reads environment at module initialization; these imports intentionally exercise that boundary after the TEMP-database setup.
  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  const { getMarketingCompensationReport, getMarketingCompensationActivities } = await import("../src/services/marketing-compensation.js");
  config.PGSCHEMA = "pg_temp";
  const original = prisma.$queryRaw;
  try {
    await prisma.$transaction(async tx => {
      for (const definition of [
        "document_marketingovaya_aktsiya (ref_key text, number text, naimenovanie_aktsii text, data_nachala_deystviya timestamp, data_okonchaniya_deystviya timestamp, dlya_vseh_magazinov boolean, posted boolean, deletion_mark boolean)",
        "document_marketingovaya_aktsiya_skidki_natsenki (_parent_ref_key text, ref_key text, skidka_natsenka_key text, magazin_key text, data_nachala timestamp, data_okonchaniya timestamp)",
        "document_marketingovaya_aktsiya_magaziny (_parent_ref_key text, ref_key text, magazin_key text)",
        "catalog_skidki_natsenki (ref_key text, sposob_predostavleniya text, znachenie_skidki_natsenki numeric, segment_nomenklatury_predostavleniya_key text, deletion_mark boolean)",
        "catalog_segmenty_nomenklatury (ref_key text, description text, deletion_mark boolean)",
        "information_register_nomenklatura_segmenta (segment_key text, nomenklatura_key text, harakteristika_key text)",
        "catalog_magaziny (ref_key text, description text, vid_tsen_zakupa_key text, deletion_mark boolean)",
        "catalog_nomenklatura (ref_key text, description text, naimenovanie_polnoe text, shtrihkod text, deletion_mark boolean)",
        "document_otchet_o_roznichnyh_prodazhah (ref_key text, date timestamp, magazin_key text, posted boolean, deletion_mark boolean)",
        "document_otchet_o_roznichnyh_prodazhah_tovary (_parent_ref_key text, ref_key text, nomenklatura_key text, harakteristika_key text, kolichestvo numeric)",
        "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary (_parent_ref_key text, ref_key text, nomenklatura_key text, harakteristika_key text, kolichestvo numeric)",
        "document_ustanovka_tsen_nomenklatury (ref_key text, date timestamp, posted boolean, deletion_mark boolean)",
        "document_ustanovka_tsen_nomenklatury_tovary (_parent_ref_key text, ref_key text, nomenklatura_key text, harakteristika_key text, vid_tseny_key text, tsena numeric)"
      ]) await tx.$executeRawUnsafe(`create temp table ${definition} on commit drop`);
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya values
        ('a','1','Название 20%','2026-09-02','2026-09-30',false,true,false),
        ('b','2','Вторая активность','2026-09-02','2026-09-30',false,true,false),
        ('broken','3','Нет сегмента','2026-09-01','2026-09-30',false,true,false),
        ('outside','4','Другой период','2026-10-01','2026-10-31',false,true,false)`);
      await tx.$executeRawUnsafe(`insert into catalog_magaziny values ('s1','Один','buy1',false),('s2','Два','buy2',false)`);
      await tx.$executeRawUnsafe(`insert into catalog_nomenklatura values
        ('i','Краткое','Полное имя','001234',false),('missing','Без цены','Без цены',null,false),('negative','Возврат','Возврат','009',false)`);
      await tx.$executeRawUnsafe(`insert into catalog_segmenty_nomenklatury values ('seg','Состав',false)`);
      await tx.$executeRawUnsafe(`insert into information_register_nomenklatura_segmenta values
        ('seg','i',null),('seg','i',null),('seg','missing',null),('seg','negative',null)`);
      await tx.$executeRawUnsafe(`insert into catalog_skidki_natsenki values ('d','Процент',11.11,'seg',false),('bad','Процент',null,'absent',false)`);
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya_skidki_natsenki values
        ('a',null,'d',null,'2026-09-02','2026-09-30'),('a',null,'d',null,'2026-09-02','2026-09-30'),
        ('b',null,'d','s1','2026-09-02','2026-09-30'),('broken',null,'bad','s1','2026-09-01','2026-09-30')`);
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya_magaziny values ('a',null,'s1'),('a',null,'s2')`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_tsen_nomenklatury values
        ('old','2026-09-01',true,false),('last','2026-09-30 23:59:59',true,false),
        ('future','2026-10-01',true,false),('unposted','2026-09-30 23:59:59.9',false,false),('deleted','2026-09-30 23:59:59.9',true,true)`);
      // Legacy price rows store the document key in ref_key; price-type and characteristic must match.
      await tx.$executeRawUnsafe(`insert into document_ustanovka_tsen_nomenklatury_tovary values
        (null,'old','i',null,'buy1',100),(null,'last','i',null,'buy1',631),
        (null,'last','i',null,'buy2',200),(null,'last','i',null,'retail',999),
        (null,'last','i','variant','buy1',900),(null,'future','i',null,'buy1',5000),
        (null,'unposted','i',null,'buy1',7000),(null,'deleted','i',null,'buy1',8000),
        (null,'last','negative',null,'buy1',10),(null,'last','negative',null,'buy2',10)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('before','2026-09-01','s1',true,false),('r','2026-09-30 23:59:59','s1',true,false),
        ('other','2026-09-10','s2',true,false),('end','2026-10-01','s1',true,false),
        ('deleted','2026-09-20','s1',true,true),('nullqty','2026-09-20','s1',true,false)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('before',null,'i',null,1000),('r',null,'i',null,3),('other',null,'i',null,2),
        ('end',null,'i',null,1000),('deleted',null,'i',null,1000),('nullqty',null,'missing',null,null)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary values
        ('r',null,'i',null,1),('r',null,'negative',null,2)`);
      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      const params = { from: new Date('2026-09-01'), to: new Date('2026-10-01') };
      const options = await getMarketingCompensationActivities(params);
      assert.deepEqual(options.activities.map(a => a.key).sort(), ['a','b','broken']);
      const result = await getMarketingCompensationReport(params);
      const a = result.activities.find(a => a.key === 'a')!;
      const s1 = a.branches.find(b => b.key === 's1')!;
      const row = s1.rows.find(r => r.itemKey === 'i')!;
      assert.equal(row.name, 'Полное имя');
      assert.equal(row.barcode, '001234');
      assert.equal(row.discountPct, 11.11);
      assert.equal(row.price, 631);
      assert.equal(row.unitCompensation, 70.1);
      assert.equal(row.quantity, 2);
      assert.equal(row.compensation, 140.2);
      assert.equal(s1.rows.filter(r => r.itemKey === 'i').length, 1);
      assert.equal(s1.rows.find(r => r.itemKey === 'negative')!.compensation, -2.22);
      assert.equal(a.branches.find(b => b.key === 's2')!.rows.find(r => r.itemKey === 'i')!.compensation, 44.44);
      assert.equal(result.activities.find(a => a.key === 'b')!.branches[0].rows.find(r => r.itemKey === 'i')!.compensation, 140.2);
      assert.equal(s1.totals.compensation, null);
      assert.equal(s1.totals.knownCompensation, 137.98);
      const missing = s1.rows.find(r => r.itemKey === 'missing')!;
      assert.equal(missing.quantity, null);
      assert.equal(missing.compensation, null);
      assert.ok(missing.issues.some(i => i.code === 'missing_price'));
      assert.ok(missing.issues.some(i => i.code === 'missing_barcode'));
      assert.ok(missing.issues.some(i => i.code === 'missing_quantity'));
      assert.equal(result.activities.find(a => a.key === 'broken')!.totals.compensation, null);
      assert.equal(result.totals.compensation, null);
      const selected = await getMarketingCompensationReport({ ...params, activityKey: 'b' });
      assert.deepEqual(selected.activities.map(a => a.key), ['b']);
      assert.equal(a.branches.find(b => b.key === 's2')!.rows.find(r => r.itemKey === 'negative')!.quantity, 0);
      await tx.$executeRawUnsafe(`delete from information_register_nomenklatura_segmenta where nomenklatura_key = 'missing'`);
      await tx.$executeRawUnsafe(`update catalog_nomenklatura set shtrihkod = null where ref_key = 'i'`);
      const barcodeOnly = await getMarketingCompensationReport({ ...params, activityKey: 'b' });
      assert.equal(barcodeOnly.totals.compensation, 137.98);
      assert.ok(barcodeOnly.activities[0].branches[0].rows.find(r => r.itemKey === 'i')!.issues.some(i => i.code === 'missing_barcode'));
      await tx.$executeRawUnsafe(`update document_otchet_o_roznichnyh_prodazhah_tovary set kolichestvo = 0.1 where _parent_ref_key = 'r' and nomenklatura_key = 'i'`);
      await tx.$executeRawUnsafe(`update document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary set kolichestvo = 0`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values ('r',null,'negative',null,0.2)`);
      const fractional = await getMarketingCompensationReport({ ...params, activityKey: 'b' });
      assert.equal(fractional.activities[0].branches[0].rows.find(r => r.itemKey === 'i')!.quantity, 0.1);
      assert.equal(fractional.activities[0].branches[0].rows.find(r => r.itemKey === 'negative')!.quantity, 0.2);
      assert.equal(fractional.totals.compensation, 7.23);
      await tx.$executeRawUnsafe(`update document_otchet_o_roznichnyh_prodazhah_tovary set kolichestvo = 3 where _parent_ref_key = 'r' and nomenklatura_key = 'i'`);
      await tx.$executeRawUnsafe(`delete from document_otchet_o_roznichnyh_prodazhah_tovary where nomenklatura_key = 'negative'`);
      await tx.$executeRawUnsafe(`update document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary set kolichestvo = case when nomenklatura_key = 'i' then 1 else 2 end`);
      await tx.$executeRawUnsafe(`insert into document_ustanovka_tsen_nomenklatury_tovary values (null,'last','i',null,'buy1',632)`);
      const priceConflict = await getMarketingCompensationReport({ ...params, activityKey: 'b' });
      assert.equal(priceConflict.activities[0].branches[0].rows.find(r => r.itemKey === 'i')!.price, null);
      assert.ok(priceConflict.activities[0].branches[0].rows.find(r => r.itemKey === 'i')!.issues.some(i => i.code === 'conflicting_price'));
      await tx.$executeRawUnsafe(`delete from document_ustanovka_tsen_nomenklatury_tovary where tsena = 632`);
      await tx.$executeRawUnsafe(`insert into catalog_skidki_natsenki values ('conflict','Процент',20,'seg',false)`);
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya_skidki_natsenki values ('a',null,'conflict','s1','2026-09-02','2026-09-30')`);
      const conflict = await getMarketingCompensationReport({ ...params, activityKey: 'a' });
      const conflictRow = conflict.activities[0].branches.find(b => b.key === 's1')!.rows.find(r => r.itemKey === 'i')!;
      assert.equal(conflictRow.quantity, 2);
      assert.equal(conflictRow.compensation, null);
      assert.ok(conflictRow.issues.some(i => i.code === 'conflicting_percentage'));
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya values ('short','5','Короткий период','2026-09-10','2026-09-20',false,true,false)`);
      await tx.$executeRawUnsafe(`insert into catalog_segmenty_nomenklatury values ('short-seg','Один товар',false)`);
      await tx.$executeRawUnsafe(`insert into information_register_nomenklatura_segmenta values ('short-seg','i',null)`);
      await tx.$executeRawUnsafe(`insert into catalog_skidki_natsenki values ('short-d','Процент',11.11,'short-seg',false)`);
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya_skidki_natsenki values ('short',null,'short-d','s1','2026-09-10','2026-09-20')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values ('unknown-outside','2026-09-25',null,true,false),('unknown-variant','2026-09-15',null,true,false)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values ('unknown-outside',null,'i',null,500),('unknown-variant',null,'i','different-variant',500)`);
      const unrelatedUnknown = await getMarketingCompensationReport({ ...params, activityKey: 'short' });
      assert.equal(unrelatedUnknown.totals.compensation, 0);
      assert.ok(!unrelatedUnknown.issues.some(i => i.code === 'missing_branch'));
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values ('unknown-variant',null,'i',null,1)`);
      const relevantUnknown = await getMarketingCompensationReport({ ...params, activityKey: 'short' });
      assert.equal(relevantUnknown.totals.compensation, null);
      assert.equal(relevantUnknown.activities[0].totals.compensation, null);
      assert.ok(relevantUnknown.activities[0].issues.some(i => i.code === 'missing_branch'));
      await tx.$executeRawUnsafe(`insert into document_marketingovaya_aktsiya values ('unset','6','Нет даты окончания','2026-09-01','0001-01-01',false,true,false)`);
      const unsetOptions = await getMarketingCompensationActivities(params);
      assert.ok(unsetOptions.activities.some(a => a.key === 'unset'));
      const unset = await getMarketingCompensationReport({ ...params, activityKey: 'unset' });
      assert.equal(unset.activities[0].totals.compensation, null);
      assert.ok(unset.activities[0].issues.some(i => i.code === 'missing_activity_dates'));
      await tx.$executeRawUnsafe('drop table information_register_nomenklatura_segmenta');
      const unsynced = await getMarketingCompensationReport(params);
      assert.equal(unsynced.totals.compensation, null);
      assert.ok(unsynced.issues.some(i => i.code === 'missing_source'));
    }, { timeout: 60000 });
  } finally { prisma.$queryRaw = original; await prisma.$disconnect(); }
});
