import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyReloadConsumer } from "./reload-consumer-fixture.js";

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
  const rollback = new Error("rollback management status fixtures");

  try {
    await prisma.$transaction(async (tx) => {
      const [target] = await tx.$queryRaw<Array<{ name: string }>>`select current_database() as name`;
      assert.equal(target.name, "nalivdata");
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
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov_etapy_oplat (
        _parent_ref_key text, summa numeric, data_platezha timestamp,
        otsrochka_platezha numeric) on commit drop`);
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
      // Handbook 5.5: deferral is weighted over deliveries, not orders.
      // The order path would report 10 days for p1; the delivery reports 3.
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov values
        ('rc1', '2026-08-05', false, true, 100, null)`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov_etapy_oplat values
        ('rc1', 100, '2026-08-08', 3)`);
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
      assert.equal(supplier.summary.weightedDeferralDays, 3);
      assert.equal(supplier.summary.receiptCount, 1);
      assert.equal(supplier.summary.stagedReceiptCount, 1);
      assert.equal(supplier.summary.receiptStageCoveragePct, 100);
      assert.equal(supplier.summary.deferralStatus, "ready");
      assert.equal(supplier.summary.status, "experimental");
      assert.equal(sourceHealth.payroll.timesheets, 0);
      assert.equal(sourceHealth.payroll.payrollDocuments, 0);
      assert.equal(sourceHealth.vat.salesLineCount, 2);
      assert.equal(sourceHealth.vat.populatedLineCount, 1);
      assert.equal(sourceHealth.vat.lineCoveragePct, 50);
      assert.equal(sourceHealth.issues.find((issue) => issue.key === "payroll")?.severity, "blocked");
      assert.equal(sourceHealth.issues.find((issue) => issue.key === "vat")?.severity, "blocked");
      throw rollback;
    }, { timeout: 30000 });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});

test("supplier deferral with nonpositive weights is unavailable, not a trusted zero", {
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
  // Intentional test module-loading boundary: config must parse the isolated
  // database/schema environment before the service is loaded.
  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  const { getSupplierTermsMetrics } = await import("../src/services/management.js");
  config.PGSCHEMA = "pg_temp";
  config.APP_SCHEMA = "pg_temp";
  const original = prisma.$queryRaw;
  const rollback = new Error("rollback supplier status fixtures");
  try {
    await prisma.$transaction(async (tx) => {
      const [target] = await tx.$queryRaw<Array<{ name: string }>>`select current_database() as name`;
      assert.equal(target.name, "nalivdata");
      await tx.$executeRawUnsafe(`create temp table document_zakaz_postavschiku (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        summa_dokumenta numeric, zakryt boolean, kontragent_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_zakaz_postavschiku_etapy_oplat (
        _parent_ref_key text, summa numeric, data_platezha timestamp) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov (
        ref_key text, date timestamp, deletion_mark boolean, posted boolean,
        summa_dokumenta numeric, zakaz_postavschiku_key text) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table document_postuplenie_tovarov_etapy_oplat (
        _parent_ref_key text, summa numeric, data_platezha timestamp,
        otsrochka_platezha numeric) on commit drop`);
      await tx.$executeRawUnsafe(`create temp table catalog_kontragenty (
        ref_key text, description text) on commit drop`);
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov values
        ('receipt', '2026-08-05', false, true, 100, null)`);
      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      const params = {
        from: new Date("2026-08-01T00:00:00Z"),
        to: new Date("2026-09-01T00:00:00Z"),
        limit: 20
      };
      const fixtures = [
        { name: "zero weight", stages: [{ amount: 0, days: 7 }], days: null },
        { name: "missing weight", stages: [{ amount: null, days: 7 }], days: null },
        { name: "cancelled weights", stages: [{ amount: 100, days: 7 }, { amount: -100, days: 20 }], days: null },
        { name: "negative weight", stages: [{ amount: -100, days: 7 }], days: null },
        { name: "real zero deferral", stages: [{ amount: 100, days: 0 }], days: 0 },
        { name: "positive weighted deferral", stages: [{ amount: 100, days: 5 }, { amount: 300, days: 1 }], days: 2 }
      ];
      for (const fixture of fixtures) {
        await tx.$executeRawUnsafe(`delete from document_postuplenie_tovarov_etapy_oplat`);
        for (const stage of fixture.stages) {
          await tx.$executeRaw`
            insert into document_postuplenie_tovarov_etapy_oplat
            values ('receipt', ${stage.amount}, ${new Date("2026-08-12T00:00:00Z")}, ${stage.days})
          `;
        }
        const result = await getSupplierTermsMetrics(params);
        assert.equal(result.summary.receiptCount, 1, fixture.name);
        assert.equal(result.summary.stagedReceiptCount, 1, fixture.name);
        assert.equal(result.summary.receiptStageCoveragePct, 100, fixture.name);
        assert.equal(result.summary.weightedDeferralDays, fixture.days, fixture.name);
        assert.equal(
          result.summary.deferralStatus,
          fixture.days === null ? "unavailable" : "ready",
          fixture.name
        );
      }
      // A calculable value remains withheld when receipt coverage is sparse.
      await tx.$executeRawUnsafe(`insert into document_postuplenie_tovarov values
        ('unstaged', '2026-08-06', false, true, 100, null)`);
      const partial = await getSupplierTermsMetrics(params);
      assert.equal(partial.summary.receiptStageCoveragePct, 50);
      assert.equal(partial.summary.weightedDeferralDays, null);
      assert.equal(partial.summary.deferralStatus, "experimental");
      throw rollback;
    }, { timeout: 30000 });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    prisma.$queryRaw = original;
    await prisma.$disconnect();
  }
});

test("reload readiness temporary source-health ledger fails closed", { skip: !process.env.ANALYTICS_TEST_DATABASE_URL }, async () => {
  await verifyReloadConsumer("/source-health", "all");
});

test("reload readiness temporary settings GET skips DDL for a complete existing catalogue", { skip: !process.env.ANALYTICS_TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.ANALYTICS_TEST_DATABASE_URL;
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";
  // Configuration must observe the guarded test environment before singleton loading.
  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  const { getManagementSettings } = await import("../src/services/management-settings.js");
  const previous = { schema: config.PGSCHEMA, app: config.APP_SCHEMA, query: prisma.$queryRaw, unsafe: prisma.$executeRawUnsafe };
  const rollback = new Error("rollback read-only settings fixtures");
  try {
    await prisma.$transaction(async tx => {
      const [target] = await tx.$queryRaw<Array<{ name: string }>>`select current_database() as name`;
      assert.equal(target.name, "nalivdata");
      for (const definition of [
        "naliv_store_settings (store_key text,active boolean,display_name text,updated_at timestamptz)",
        "naliv_metric_settings (metric_id text,normal_text text,critical_text text,cadence text,owner_name text,updated_at timestamptz)",
        "naliv_cash_article_settings (article_key text,flow_type text,approved boolean,updated_at timestamptz)",
        "naliv_obligations (id bigint,kind text,name text,amount numeric,due_date date,frequency text,active boolean,updated_at timestamptz)",
        "naliv_projects (id bigint,name text,budget numeric,actual numeric,start_date date,status text,updated_at timestamptz)",
        "catalog_magaziny (ref_key text,description text,deletion_mark boolean)",
        "document_otchet_o_roznichnyh_prodazhah (ref_key text,date timestamp,deletion_mark boolean,posted boolean,magazin_key text)",
        "catalog_stati_dvizheniya_denezhnyh_sredstv (ref_key text,description text)",
        "document_prihodnyy_kassovyy_order (ref_key text,deletion_mark boolean,posted boolean)",
        "document_prihodnyy_kassovyy_order_rasshifrovka_platezha (_parent_ref_key text,statya_dvizheniya_denezhnyh_sredstv_key text)",
        "document_rashodnyy_kassovyy_order (ref_key text,date timestamp,deletion_mark boolean,posted boolean)",
        "document_rashodnyy_kassovyy_order_rasshifrovka_platezha (_parent_ref_key text,statya_dvizheniya_denezhnyh_sredstv_key text,summa numeric)"
      ]) await tx.$executeRawUnsafe(`create temp table ${definition} on commit drop`);
      const [namespace] = await tx.$queryRaw<Array<{ name: string }>>`select nspname as name from pg_namespace where oid=pg_my_temp_schema()`;
      config.PGSCHEMA = namespace.name; config.APP_SCHEMA = namespace.name;
      const executeFixture = tx.$executeRawUnsafe.bind(tx);
      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      prisma.$executeRawUnsafe = (async () => { throw new Error("Persistent settings DDL is forbidden in this read test"); }) as typeof prisma.$executeRawUnsafe;
      await executeFixture(`insert into pg_temp.catalog_magaziny values ('s1','Store',false)`);
      await executeFixture(`insert into pg_temp.naliv_store_settings values ('s1',false,'Saved store',now())`);
      const settings = await getManagementSettings(new Date("2026-09-01"));
      assert.equal(settings.stores[0]?.displayName, "Saved store");
      assert.equal(settings.stores[0]?.active, false);
      assert.ok(settings.metrics.length > 0);
      await executeFixture(`alter table pg_temp.naliv_store_settings drop column display_name`);
      await assert.rejects(getManagementSettings(), /Persistent settings DDL is forbidden/);
      throw rollback;
    }, { timeout: 30_000 });
  } catch (error) { if (error !== rollback) throw error; }
  finally { config.PGSCHEMA = previous.schema; config.APP_SCHEMA = previous.app; prisma.$queryRaw = previous.query; prisma.$executeRawUnsafe = previous.unsafe; await prisma.$disconnect(); }
});
