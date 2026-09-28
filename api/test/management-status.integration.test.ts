import assert from "node:assert/strict";
import { test } from "node:test";

test("missing commission and sparse supplier, payroll, and VAT sources are not trusted", {
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
  const { getAcquiringMetrics, getSourceHealth, getSupplierTermsMetrics } = await import("../src/services/management.js");
  config.PGSCHEMA = "pg_temp";
  const original = prisma.$queryRaw;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`create temp table accumulation_register_prodazhi_po_platezhnym_kartam_record_type (
        period timestamp, active boolean, magazin_key text,
        summa_operatsiy_prodazhi numeric, summa_operatsiy_vozvrata numeric,
        nachislennaya_summa_komissii numeric, otmenennaya_summa_komissii numeric,
        vozvraschaemaya_summa_komissii numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_magaziny (
        ref_key text, description text, deletion_mark boolean, ploschad_torgovogo_zala numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_zakaz_postavschiku (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        summa_dokumenta numeric, zakryt boolean, kontragent_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_zakaz_postavschiku_etapy_oplat (
        _parent_ref_key text, summa numeric, data_platezha timestamp) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        summa_dokumenta numeric, zakaz_postavschiku_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_kontragenty (
        ref_key text, description text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_chek_kkm (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_tabel_ucheta_rabochego_vremeni (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_zarplata_k_vyplate_organizatsiy (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        magazin_key text, organizatsiya_key text, summa_dokumenta numeric,
        summa_vozvratov numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_tovary (
        _parent_ref_key text, summa numeric, summa_nds numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary (
        _parent_ref_key text, summa numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_organizatsii (
        ref_key text, description text) on commit drop`);

      await tx.$executeRawUnsafe(`insert into catalog_magaziny values ('s1', 'Store One', false, null)`);
      await tx.$executeRawUnsafe(`insert into accumulation_register_prodazhi_po_platezhnym_kartam_record_type values
        ('2026-08-10', true, 's1', 1000, 0, 0, 0, 0)`);
      await tx.$executeRawUnsafe(`insert into catalog_kontragenty values ('v1', 'Vendor')`);
      await tx.$executeRawUnsafe(`insert into document_zakaz_postavschiku values
        ('p1', '2026-08-01', false, true, 100, false, 'v1'),
        ('p2', '2026-08-02', false, true, 100, false, 'v1'),
        ('p3', '2026-08-03', false, true, 100, false, 'v1'),
        ('p4', '2026-08-04', false, true, 100, false, 'v1')`);
      await tx.$executeRawUnsafe(`insert into document_zakaz_postavschiku_etapy_oplat values
        ('p1', 100, '2026-08-11')`);
      await tx.$executeRawUnsafe(`insert into document_chek_kkm values
        ('c1', '2026-08-10', false, true)`);
      await tx.$executeRawUnsafe(`insert into document_tabel_ucheta_rabochego_vremeni values
        ('t-old', '2023-08-10', false, true)`);
      await tx.$executeRawUnsafe(`insert into document_zarplata_k_vyplate_organizatsiy values
        ('p-old', '2023-08-10', false, true)`);
      await tx.$executeRawUnsafe(`insert into catalog_organizatsii values ('o1', 'BaZZa')`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah values
        ('r1', '2026-08-10', false, true, 's1', 'o1', 200, 0)`);
      await tx.$executeRawUnsafe(`insert into document_otchet_o_roznichnyh_prodazhah_tovary values
        ('r1', 100, 12), ('r1', 100, 0)`);

      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      const params = { from: new Date("2026-08-01"), to: new Date("2026-09-01"), limit: 20 };
      const acquiring = await getAcquiringMetrics(params);
      const supplier = await getSupplierTermsMetrics(params);
      const sourceHealth = await getSourceHealth(params);

      assert.equal(acquiring.summary.turnover, 1000);
      assert.equal(acquiring.summary.commission, null);
      assert.equal(acquiring.summary.commissionPct, null);
      assert.equal(acquiring.summary.commissionStatus, "unavailable");
      assert.equal(supplier.summary.stageCoveragePct, 25);
      assert.equal(supplier.summary.weightedDeferralDays, 10);
      assert.equal(supplier.summary.status, "experimental");
      assert.equal(sourceHealth.payroll.timesheets, 0);
      assert.equal(sourceHealth.payroll.payrollDocuments, 0);
      assert.equal(sourceHealth.vat.salesLineCount, 2);
      assert.equal(sourceHealth.vat.populatedLineCount, 1);
      assert.equal(sourceHealth.vat.lineCoveragePct, 50);
      assert.equal(sourceHealth.issues.find((issue) => issue.key === "payroll")?.severity, "blocked");
      assert.equal(sourceHealth.issues.find((issue) => issue.key === "vat")?.severity, "blocked");
    }, { timeout: 30000 });
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});
