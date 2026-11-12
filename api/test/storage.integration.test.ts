import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { verifyReloadConsumer } from "./reload-consumer-fixture.js";
import { promisify } from "node:util";
import cookieParser from "cookie-parser";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { getIndexManifest, indexDefinitionMatches, readIndexSnapshots } from "../src/scripts/optimize-db.js";
import { api as browserApi } from "../../web/src/api.js";
import { formatStorageBytes } from "../../web/src/format.js";

const databaseUrl = process.env.STORAGE_TEST_DATABASE_URL ?? process.env.ANALYTICS_TEST_DATABASE_URL;

// Only connection-local temporary relations are used on the ordinary service-test DSN.
// Normalized ops metadata is exercised only on the separately provisioned storage sandbox.
test("storage diagnostics measure physical bytes, preserve unknown estimates, and read normalized provenance", {
  skip: !databaseUrl
}, async (t) => {
  if (process.env.STORAGE_TEST_DATABASE_URL) {
    const name = decodeURIComponent(new URL(process.env.STORAGE_TEST_DATABASE_URL).pathname.slice(1));
    assert.match(name, /_storage_test$/, "Storage metadata tests require an isolated _storage_test database");
  }
  process.env.DATABASE_URL = databaseUrl;
  process.env.PGSCHEMA = "pg_temp";
  process.env.DB_CONNECTION_LIMIT = "2";
  process.env.REPORT_CACHE_SYNC_POLL_SECONDS = "0";
  process.env.REPORT_CACHE_TTL_SECONDS = "60";
  process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
  process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
  process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
  process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
  process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";

  // Configuration validates environment at module evaluation; load only after the isolated DSN is installed.
  const { prisma } = await import("../src/prisma.js");
  const { config } = await import("../src/config.js");
  const { getOverview, getStorageIdentity, getTables, getTableProfile, getTimeSeries } = await import("../src/services/analytics.js");
  const originalQuery = prisma.$queryRaw;
  const originalUnsafe = prisma.$queryRawUnsafe;
  const originalSchema = config.PGSCHEMA;
  const rollback = new Error("rollback storage diagnostics fixtures");
  try {
    await prisma.$transaction(async (tx) => {
      const [target] = await tx.$queryRaw<Array<{ name: string }>>`select current_database() as name`;
      assert.equal(target.name, "nalivdata");
      prisma.$queryRaw = tx.$queryRaw.bind(tx) as typeof prisma.$queryRaw;
      prisma.$queryRawUnsafe = tx.$queryRawUnsafe.bind(tx) as typeof prisma.$queryRawUnsafe;
      await tx.$executeRawUnsafe(`create temp table document_storage_fixture (
        _id bigserial primary key, ref_key text unique, date timestamp,
        _loaded_at timestamptz, amount numeric, payload text) on commit drop`);
      await tx.$executeRawUnsafe(`insert into document_storage_fixture (ref_key, date, amount, payload)
        select 'r' || n, '2025-09-01'::timestamp, n,
          (select string_agg(md5((n * 10000 + part)::text), '') from generate_series(1, 300) part)
        from generate_series(1, 40) n`);
      await tx.$executeRawUnsafe(`analyze pg_temp.document_storage_fixture`);
      await tx.$executeRawUnsafe(`create temp table catalog_informatsionnye_karty (ref_key text, _loaded_at timestamptz) on commit drop`);
      await tx.$executeRawUnsafe(`insert into catalog_informatsionnye_karty values ('001', '2025-09-01T00:00:00Z')`);
      const [namespace] = await tx.$queryRaw<Array<{ name: string }>>`
        select nspname as name from pg_namespace where oid = pg_my_temp_schema()`;
      config.PGSCHEMA = namespace.name;

      await t.test("reltuples wins over reset counters and one unknown member makes the aggregate unknown", async () => {
        const tables = await getTables();
        assert.equal(tables.find((table) => table.name === "document_storage_fixture")?.estimatedRows, 40);
        assert.equal(tables.find((table) => table.name === "catalog_informatsionnye_karty")?.estimatedRows, null);
        const overview = await getOverview();
        assert.equal(overview.estimatedRows, null);
        assert.equal(overview.dataGroups.find((group) => group.key === "documents")?.estimatedRows, 40);
        assert.equal(overview.dataGroups.find((group) => group.key === "catalogs")?.estimatedRows, null);
        assert.ok(overview.tables.some((table) => table.name === "catalog_informatsionnye_karty"));
        assert.equal(overview.storage.layoutVersion, null);
        assert.equal(overview.storage.compactionActive, false);
        const identity = await getStorageIdentity("00000000-0000-4000-8000-000000000001");
        const [expected] = await tx.$queryRaw<Array<{ database_name: string; database_oid: bigint; schema_oid: bigint }>>`
          select current_database() as database_name,
            (select oid::bigint from pg_database where datname = current_database()) as database_oid,
            pg_my_temp_schema()::bigint as schema_oid`;
        assert.deepEqual(identity, {
          proofVersion: 1,
          challenge: "00000000-0000-4000-8000-000000000001",
          targetDatabase: { name: expected.database_name, oid: Number(expected.database_oid) },
          sourceSchema: { name: namespace.name, oid: Number(expected.schema_oid) },
          layout: null
        });
      });

      await t.test("whole database and heap/index/TOAST accounting agree without counting TOAST indexes twice", async () => {
        const overview = await getOverview();
        const [expected] = await tx.$queryRaw<Array<{ heap: bigint; indexes: bigint; toast: bigint; total: bigint }>>`
          select sum(pg_table_size(c.oid) - case when c.reltoastrelid = 0 then 0 else pg_total_relation_size(c.reltoastrelid) end)::bigint as heap,
            sum(pg_indexes_size(c.oid))::bigint as indexes,
            sum(case when c.reltoastrelid = 0 then 0 else pg_total_relation_size(c.reltoastrelid) end)::bigint as toast,
            sum(pg_total_relation_size(c.oid))::bigint as total
          from pg_class c where c.relnamespace = pg_my_temp_schema() and c.relkind in ('r', 'p', 'm')`;
        const storage = overview.storage;
        assert.equal(storage.sourceHeapBytes, Number(expected.heap));
        assert.equal(storage.sourceIndexBytes, Number(expected.indexes));
        assert.equal(storage.sourceToastBytes, Number(expected.toast));
        assert.ok(storage.sourceToastBytes > 0);
        assert.equal(storage.sourceHeapBytes + storage.sourceIndexBytes + storage.sourceToastBytes, Number(expected.total));
        assert.equal(overview.totalBytes, Number(expected.total));
        assert.equal(storage.databaseBytes, storage.sourceHeapBytes + storage.sourceIndexBytes + storage.sourceToastBytes + storage.otherBytes);
        assert.equal(storage.targetBytes, 10_000_000_000);
        assert.equal(storage.withinTarget, storage.databaseBytes <= 10_000_000_000);
        assert.ok(Number.isFinite(Date.parse(storage.measuredAtUtc)));
      });

      await t.test("removed tables and stale chart columns carry actionable HTTP status", async () => {
        await assert.rejects(getTableProfile("removed_storage_table"), { statusCode: 404 });
        await assert.rejects(getTimeSeries("document_storage_fixture", "removed_date"), { statusCode: 400 });
        assert.deepEqual(await getTimeSeries("document_storage_fixture", "date"), [
          { bucket: "2025-09-01T00:00:00.000Z", metric: 40 }
        ]);
      });

      await t.test("layout and provenance come from relation metadata, not repeated fact URLs", {
        skip: !process.env.STORAGE_TEST_DATABASE_URL
      }, async () => {
        await tx.$executeRawUnsafe(`create schema if not exists ops`);
        await tx.$executeRawUnsafe(`create table if not exists ops.analytics_storage_layout (
          table_schema text primary key, layout_version integer not null, contract_sha256 text not null,
          activated_at timestamptz not null, migration_id uuid not null, plan_sha256 text not null,
          ddl_frozen boolean not null default false)`);
        await tx.$executeRawUnsafe(`create table if not exists ops.analytics_sources (
          table_schema text, table_name text, source_entity text, resource_template text,
          primary key (table_schema, table_name, source_entity, resource_template))`);
        await tx.$executeRaw`insert into ops.analytics_storage_layout values (${namespace.name}, 1, 'contract', now(),
          '00000000-0000-0000-0000-000000000001'::uuid, 'plan', true)`;
        await tx.$executeRaw`insert into ops.analytics_sources values (${namespace.name}, 'document_storage_fixture',
          'Document_StorageFixture', 'Document_StorageFixture')`;
        const overview = await getOverview();
        assert.equal(overview.storage.layoutVersion, 1);
        assert.equal(overview.storage.compactionActive, true);
        assert.equal(overview.provenance.available, true);
        assert.equal(overview.provenance.relationCount, 1);
        assert.equal(overview.provenance.resourceCount, 1);
        assert.ok(!overview.serviceFieldCoverage.some((field) => field.name === "_source_url" || field.name === "_source_entity"));
        const profile = await getTableProfile("document_storage_fixture");
        assert.deepEqual(profile.sources, [{ sourceEntity: "Document_StorageFixture", resourceTemplate: "Document_StorageFixture" }]);
        assert.ok(!profile.columns.some((column) => column.name === "_source_url"));
        const identity = await getStorageIdentity("00000000-0000-4000-8000-000000000002");
        assert.deepEqual(identity.layout, {
          layoutVersion: 1,
          contractSha256: "contract",
          migrationId: "00000000-0000-0000-0000-000000000001",
          planSha256: "plan",
          compactionActive: true
        });
      });

      await t.test("query manifest executes on PostgreSQL and agrees with the one canonical stock identity", async () => {
        const manifest = getIndexManifest();
        const table = "accumulation_register_tovary_na_skladah_balance";
        await tx.$executeRawUnsafe(`create temp table accumulation_register_tovary_na_skladah_balance (
          _id bigserial primary key, nomenklatura_key text, balance_period timestamp, sklad_key text,
          harakteristika_key text, kolichestvo_balance numeric, rezerv_balance numeric) on commit drop`);
        const required = manifest.requiredIngestIndexes.find((index) => index.table === table);
        assert.ok(required);
        assert.deepEqual(required.columns, ["nomenklatura_key", "balance_period", "sklad_key", "harakteristika_key"]);
        assert.equal(required.nullsNotDistinct, true);
        const stockQueries = manifest.indexes.filter((index) => index.table === table);
        assert.deepEqual(stockQueries.map((index) => index.name), ["turnover_stock_period_idx"]);
        await tx.$executeRawUnsafe(`create unique index "${required.name}" on pg_temp.${table}
          (${required.columns.map((column) => `"${column}"`).join(", ")}) nulls not distinct`);
        for (const spec of stockQueries) {
          await tx.$executeRawUnsafe(`create index "${spec.name}" on pg_temp.${table} (${spec.keys})
            ${spec.include.length ? `include (${spec.include.map((column) => `"${column}"`).join(", ")})` : ""}
            ${spec.predicate ? `where ${spec.predicate}` : ""}`);
        }
        const snapshots = await readIndexSnapshots(prisma, namespace.name);
        for (const spec of stockQueries) {
          const actual = snapshots.find((index) => index.name === spec.name);
          assert.ok(actual);
          assert.equal(indexDefinitionMatches(actual, spec), true, spec.name);
        }
        const identity = snapshots.find((index) => index.name === required.name);
        assert.ok(identity);
        assert.deepEqual(identity.keys, ["nomenklatura_key", "balance_period", "sklad_key", "harakteristika_key"]);
        assert.equal(identity.unique, true);
        assert.equal(identity.nullsNotDistinct, true);
        assert.equal(identity.valid, true);
        assert.equal(snapshots.filter((index) => index.table === table && index.unique && !index.primary).length, 1);
        assert.ok(!snapshots.some((index) => ["analytics_balance_period_idx", "turnover_stock_item_period_idx", "turnover_stock_positive_idx"].includes(index.name)));
      });

      await t.test("authenticated bounded HTTP caches refresh after column/table removal", async () => {
        // Router/session modules read validated configuration at evaluation time, after the isolated DSN above.
        const { analyticsRouter } = await import("../src/routes/analytics.js");
        const { sessionCookieName, signSession } = await import("../src/middleware/auth.js");
        await tx.$executeRawUnsafe(`create temp table document_schema_change_fixture (date timestamp, amount numeric) on commit drop`);
        await tx.$executeRawUnsafe(`insert into document_schema_change_fixture values ('2025-09-01', 12)`);
        const app = express();
        app.use(cookieParser());
        app.use("/api/analytics", analyticsRouter);
        const errors: ErrorRequestHandler = (error, _request, response, _next) => {
          response.status(error.statusCode ?? 500).json({ error: error.message });
        };
        app.use(errors);
        const server = app.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const baseUrl = `http://127.0.0.1:${address.port}`;
        const cookie = `${sessionCookieName}=${signSession({ email: config.APP_ADMIN_EMAIL, role: "admin" })}`;
        const get = (path: string) => fetch(`${baseUrl}/api/analytics${path}`, { headers: { cookie } });
        try {
          assert.equal((await fetch(`${baseUrl}/api/analytics/overview`)).status, 401);
          const marketing = `${sessionCookieName}=${signSession({ email: config.APP_MARKETING_EMAIL, role: "marketing" })}`;
          assert.equal((await fetch(`${baseUrl}/api/analytics/overview`, { headers: { cookie: marketing } })).status, 403);
          const identityPath = "/storage-identity?challenge=00000000-0000-4000-8000-000000000003";
          assert.equal((await fetch(`${baseUrl}/api/analytics${identityPath}`)).status, 401);
          assert.equal((await fetch(`${baseUrl}/api/analytics${identityPath}`, { headers: { cookie: marketing } })).status, 403);
          assert.ok(!(await get("/storage-identity")).ok);
          assert.ok(!(await get("/storage-identity?challenge=not-a-uuid")).ok);
          const identityResponse = await get(identityPath);
          assert.equal(identityResponse.status, 200);
          assert.equal(identityResponse.headers.get("cache-control"), "no-store");
          assert.equal(identityResponse.headers.get("x-report-cache"), null);
          const identityBody = await identityResponse.json();
          assert.deepEqual(identityBody, await getStorageIdentity("00000000-0000-4000-8000-000000000003"));
          const nextIdentity = await (await get("/storage-identity?challenge=00000000-0000-4000-8000-000000000004")).json() as { challenge: string };
          assert.equal(nextIdentity.challenge, "00000000-0000-4000-8000-000000000004");
          const profilePath = "/tables/document_schema_change_fixture";
          const first = await get(profilePath);
          assert.equal(first.status, 200);
          assert.equal(first.headers.get("x-report-cache"), "miss");
          await first.json();
          const warm = await get(profilePath);
          assert.equal(warm.headers.get("x-report-cache"), "hit");
          await warm.json();
          const seriesPath = `${profilePath}/timeseries?dateColumn=date&metricColumn=amount`;
          assert.equal((await get(seriesPath)).status, 200);
          await tx.$executeRawUnsafe(`alter table pg_temp.document_schema_change_fixture rename column date to business_date`);
          await tx.$executeRawUnsafe(`alter table pg_temp.document_schema_change_fixture drop column amount`);
          assert.equal((await get(seriesPath)).status, 400);
          const refreshed = await get(profilePath);
          assert.equal(refreshed.headers.get("x-report-cache"), "miss");
          const body = await refreshed.json() as { columns: Array<{ name: string }> };
          assert.deepEqual(body.columns.map((column) => column.name), ["business_date"]);
          await (await get("/tables")).json();
          await (await get("/overview")).json();
          await tx.$executeRawUnsafe(`drop table pg_temp.document_schema_change_fixture`);
          assert.equal((await get(profilePath)).status, 404);
          const tables = await (await get("/tables")).json() as Array<{ name: string }>;
          assert.ok(!tables.some((table) => table.name === "document_schema_change_fixture"));
          const overview = await (await get("/overview")).json() as { tables: Array<{ name: string }> };
          assert.ok(!overview.tables.some((table) => table.name === "document_schema_change_fixture"));
        } finally {
          await promisify(server.close.bind(server))();
        }
      });
      // Roll back every fixture, including ops DDL on the explicitly isolated sandbox.
      throw rollback;
    }, { timeout: 60000 });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    config.PGSCHEMA = originalSchema;
    prisma.$queryRaw = originalQuery;
    prisma.$queryRawUnsafe = originalUnsafe;
    await prisma.$disconnect();
  }
});

test("browser HTTP errors retain status codes and existing Error messages in both response branches", async () => {
  let status = 400;
  let json = true;
  const app = express();
  app.get("/api/analytics/overview", (_request, response) => {
    if (json) response.status(status).json({ error: "Колонка больше недоступна" });
    else response.status(status).type("text").send("Invalid request");
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const nativeFetch = globalThis.fetch;
  // Resolve the browser's relative URLs against a real local HTTP server; no response is mocked.
  globalThis.fetch = (input, init) => nativeFetch(new URL(String(input), `http://127.0.0.1:${address.port}`), init);
  try {
    for (const code of [400, 404, 500]) {
      status = code;
      await assert.rejects(browserApi.overview(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { statusCode: number }).statusCode, code);
        assert.equal(error.message, code >= 500 ? "Не удалось получить данные. Повторите попытку позже." : "Колонка больше недоступна");
        return true;
      });
    }
    status = 400;
    json = false;
    await assert.rejects(browserApi.overview(), { message: "Не удалось выполнить запрос", statusCode: 400 });
  } finally {
    globalThis.fetch = nativeFetch;
    await promisify(server.close.bind(server))();
  }
});

test("storage diagnostic sizes use the same decimal units as the 10 GB target", () => {
  for (const [bytes, expected] of [
    [0, "0 Б"], [999, "999 Б"], [1000, "1 КБ"], [1_000_000, "1 МБ"],
    [1_000_000_000, "1 ГБ"], [10_000_000_000, "10 ГБ"], [32_240_645_811, "32,2 ГБ"]
  ] as const) {
    assert.equal(formatStorageBytes(bytes), expected);
  }
});

test("reload readiness temporary storage ledger refuses warm JSON and XLSX", { skip: !process.env.ANALYTICS_TEST_DATABASE_URL }, async () => {
  await verifyReloadConsumer("/storage", "all");
});
