import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  applyIndexManifest, getIndexManifest, indexDefinitionMatches,
  planIndexReconciliation, readIndexSnapshots, reconcileQueryIndex, retirementCandidates, ingestIndexDefinitionMatches
} from "../src/scripts/optimize-db.js";

// Concurrent index DDL needs real, non-temporary relations. Use only the
// independently provisioned destructive sandbox, never the app/analytics DSN.
test("PostgreSQL optimizer narrows a captured cover, resumes rename, and never removes unique or invalid indexes", {
  skip: !process.env.STORAGE_TEST_DATABASE_URL
}, async () => {
  const url = new URL(process.env.STORAGE_TEST_DATABASE_URL!);
  assert.match(decodeURIComponent(url.pathname.slice(1)), /_storage_test$/, "Refusing index DDL outside the isolated storage test database");
  url.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const schema = `storage_indexes_${randomUUID().replaceAll("-", "")}`;
  const qualified = `"${schema}"."document_chek_kkm_tovary"`;
  const spec = getIndexManifest().indexes.find((row) => row.name === "analytics_check_parent_idx")!;
  const log = () => {};
  let schemaCreated = false;
  try {
    const identity = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    assert.match(identity[0].name, /_storage_test$/);
    await db.$executeRawUnsafe("SET lock_timeout = '5s'");
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await db.$executeRawUnsafe(`CREATE TABLE ${qualified} (_parent_ref_key text, nomenklatura_key text, kolichestvo numeric, summa numeric, shtrihkod text)`);
    await db.$executeRawUnsafe(`INSERT INTO ${qualified} VALUES ('a', 'x', 1, 2, 'same'), ('b', 'y', 3, 4, 'same')`);
    await db.$executeRawUnsafe(`CREATE INDEX "analytics_check_parent_idx" ON ${qualified} (_parent_ref_key) INCLUDE (nomenklatura_key, kolichestvo, summa)`);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX "feature_unique_idx" ON ${qualified} (nomenklatura_key)`);
    const before = await readIndexSnapshots(db, schema);
    const old = before.find((index) => index.name === spec.name)!;
    const unrelated = before.find((index) => index.name === "feature_unique_idx")!;
    const action = planIndexReconciliation(spec, before);
    assert.equal(action.kind, "replace");
    if (action.kind !== "replace") throw new Error("Expected a covering predecessor replacement");

    assert.equal(await reconcileQueryIndex(db, schema, spec, log), true);
    const after = await readIndexSnapshots(db, schema);
    const compact = after.find((index) => index.name === spec.name)!;
    assert.notEqual(compact.oid, old.oid);
    assert.deepEqual(compact.include, []);
    assert.equal(indexDefinitionMatches(compact, spec), true);
    assert.equal(after.find((index) => index.name === unrelated.name)!.oid, unrelated.oid);
    assert.equal(await reconcileQueryIndex(db, schema, spec, log), false);
    assert.deepEqual(await readIndexSnapshots(db, schema), after);

    // Reproduce lost acknowledgement after old retirement, before final rename.
    await db.$executeRawUnsafe(`ALTER INDEX "${schema}"."${spec.name}" RENAME TO "${action.buildName}"`);
    assert.equal(await reconcileQueryIndex(db, schema, spec, log), true);
    assert.equal((await readIndexSnapshots(db, schema)).find((index) => index.name === spec.name)!.oid, compact.oid);

    // Per-column deparser output omits sort direction. This exercises the full
    // catalogue reader, so a regression there cannot hide behind fake snapshots.
    const descending = { ...spec, name: "fixture_desc_idx", keys: "kolichestvo DESC, summa" };
    assert.equal(await reconcileQueryIndex(db, schema, descending, log), true);
    const ordered = (await readIndexSnapshots(db, schema)).find((index) => index.name === descending.name)!;
    assert.deepEqual(ordered.keys, ["kolichestvo DESC", "summa"]);
    assert.equal(indexDefinitionMatches(ordered, descending), true);
    assert.equal(indexDefinitionMatches(ordered, { ...descending, keys: "kolichestvo, summa" }), false);

    // Real NUMERIC predicates deparse with an implicit literal ::numeric cast.
    // Both a canonical cost build and a positive-stock predecessor must match.
    const manifest = getIndexManifest();
    const cost = manifest.indexes.find((index) => index.name === "analytics_live_store_cost_idx")!;
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."${cost.table}" (
      magazin_key text, nomenklatura_key text, period timestamp, line_number numeric, active boolean, tsena numeric
    )`);
    assert.equal(await reconcileQueryIndex(db, schema, cost, log), true);
    const costIndex = (await readIndexSnapshots(db, schema)).find((index) => index.name === cost.name)!;
    assert.equal(indexDefinitionMatches(costIndex, cost), true);
    assert.equal(await reconcileQueryIndex(db, schema, cost, log), false);

    // Preserved child layouts mix parent ordinals (integer) with source line
    // numbers (bigint/NUMERIC). Check the real canonical server expressions.
    const receiptChild = manifest.requiredIngestIndexes.find((index) => index.table === spec.table)!;
    await db.$executeRawUnsafe(`ALTER TABLE ${qualified} ADD COLUMN ref_key text, ADD COLUMN line_number bigint, ADD COLUMN _parent_line_index integer`);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX "${receiptChild.name}" ON ${qualified}
      (COALESCE(ref_key, _parent_ref_key), COALESCE(line_number, _parent_line_index))`);
    await db.$executeRawUnsafe(`COMMENT ON INDEX "${schema}"."${receiptChild.name}" IS 'naliv:ingest:compact-v1'`);
    const receiptIdentity = (await readIndexSnapshots(db, schema)).find((index) => index.name === receiptChild.name)!;
    assert.equal(receiptIdentity.columnTypes?.line_number, "bigint");
    assert.equal(receiptIdentity.columnTypes?._parent_line_index, "integer");
    assert.equal(ingestIndexDefinitionMatches(receiptIdentity, receiptChild), true);
    assert.equal(ingestIndexDefinitionMatches({ ...receiptIdentity, columnTypes: { ...receiptIdentity.columnTypes, line_number: "integer" } }, receiptChild), false);

    const numericChild = manifest.requiredIngestIndexes.find((index) => index.table === "document_otchet_o_roznichnyh_prodazhah_tovary")!;
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."${numericChild.table}" (
      ref_key text, _parent_ref_key text, line_number numeric, _parent_line_index integer
    )`);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX "${numericChild.name}" ON "${schema}"."${numericChild.table}"
      (COALESCE(ref_key, _parent_ref_key), COALESCE(line_number, _parent_line_index))`);
    await db.$executeRawUnsafe(`COMMENT ON INDEX "${schema}"."${numericChild.name}" IS 'naliv:ingest:compact-v1'`);
    const numericIdentity = (await readIndexSnapshots(db, schema)).find((index) => index.name === numericChild.name)!;
    assert.equal(numericIdentity.columnTypes?.line_number, "numeric");
    assert.equal(numericIdentity.columnTypes?._parent_line_index, "integer");
    assert.equal(ingestIndexDefinitionMatches(numericIdentity, numericChild), true);

    const stock = manifest.requiredIngestIndexes.find((index) => index.table === "accumulation_register_tovary_na_skladah_balance")!;
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."${stock.table}" (
      nomenklatura_key text, balance_period timestamp, sklad_key text, harakteristika_key text, kolichestvo_balance numeric
    )`);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX "${stock.name}" ON "${schema}"."${stock.table}"
      (nomenklatura_key, balance_period, sklad_key, harakteristika_key) NULLS NOT DISTINCT`);
    await db.$executeRawUnsafe(`COMMENT ON INDEX "${schema}"."${stock.name}" IS 'naliv:ingest:compact-v1'`);
    await db.$executeRawUnsafe(`CREATE INDEX "turnover_stock_positive_idx" ON "${schema}"."${stock.table}"
      (nomenklatura_key, balance_period) INCLUDE (sklad_key, harakteristika_key) WHERE kolichestvo_balance > 0`);
    const withStock = await readIndexSnapshots(db, schema);
    assert.equal(retirementCandidates(manifest, withStock)[0].name, "turnover_stock_positive_idx");

    // Exact expected alias SQL is not permission to retire another feature's
    // explicitly marked index, even with a valid canonical ingest replacement.
    const receipt = manifest.requiredIngestIndexes.find((index) => index.table === "document_chek_kkm")!;
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."${receipt.table}" (
      ref_key text, date timestamp, posted boolean, deletion_mark boolean
    )`);
    await db.$executeRawUnsafe(`CREATE UNIQUE INDEX "${receipt.name}" ON "${schema}"."${receipt.table}" (ref_key)`);
    await db.$executeRawUnsafe(`COMMENT ON INDEX "${schema}"."${receipt.name}" IS 'naliv:ingest:compact-v1'`);
    await db.$executeRawUnsafe(`CREATE INDEX "turnover_check_header_ref_idx" ON "${schema}"."${receipt.table}"
      (ref_key) INCLUDE (date) WHERE posted = TRUE AND deletion_mark IS NOT TRUE`);
    await db.$executeRawUnsafe(`COMMENT ON INDEX "${schema}"."turnover_check_header_ref_idx" IS 'owned-by-another-feature'`);
    const foreignOwned = await readIndexSnapshots(db, schema);
    assert.throws(() => retirementCandidates(manifest, foreignOwned), /ownership/i);
    assert.deepEqual(await readIndexSnapshots(db, schema), foreignOwned);

    // A duplicate-key failed concurrent build leaves a real invalid artefact.
    await assert.rejects(db.$executeRawUnsafe(`CREATE UNIQUE INDEX CONCURRENTLY "failed_build_idx" ON ${qualified} (shtrihkod)`));
    const failed = (await readIndexSnapshots(db, schema)).find((index) => index.name === "failed_build_idx")!;
    assert.equal(failed.valid, false);
    await assert.rejects(reconcileQueryIndex(db, schema, { ...spec, name: failed.name, keys: "shtrihkod" }, log), /invalid/i);
    await assert.rejects(reconcileQueryIndex(db, schema, { ...spec, name: unrelated.name, keys: "nomenklatura_key" }, log), /unique|ownership/i);
    const preserved = await readIndexSnapshots(db, schema);
    assert.equal(preserved.find((index) => index.name === failed.name)!.oid, failed.oid);
    assert.equal(preserved.find((index) => index.name === unrelated.name)!.oid, unrelated.oid);

    // A real missing layout marker is rejected before changing catalog objects.
    await assert.rejects(applyIndexManifest(db, schema, false, log), /migration required/i);
    assert.deepEqual(await readIndexSnapshots(db, schema), preserved);
  } finally {
    // Drop only the random schema created above, in the suffix-guarded sandbox.
    if (schemaCreated) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
  }
});

test("manifest retires warehouse and supplier lookup aliases only after full canonical identities", {
  skip: !process.env.STORAGE_TEST_DATABASE_URL
}, async () => {
  const url = new URL(process.env.STORAGE_TEST_DATABASE_URL!);
  assert.match(decodeURIComponent(url.pathname.slice(1)), /_storage_test$/);
  url.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  const schema = `storage_lookup_${randomUUID().replaceAll("-", "")}`;
  const manifest = getIndexManifest();
  const contract = JSON.parse(readFileSync(new URL("../../../naliv_data1/analytics_storage_contract.json", import.meta.url), "utf8"));
  const hash = createHash("sha256").update(JSON.stringify(contract, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value
  )).digest("hex");
  const tables: string[] = [];
  let markerInserted = false;
  let schemaCreated = false;
  try {
    const identity = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    assert.match(identity[0].name, /_storage_test$/);
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    for (const required of manifest.requiredIngestIndexes) {
      const columns: string[] = contract.tables[required.table].columns;
      const type = (column: string) => {
        if (["posted", "deletion_mark", "active", "zakryt"].includes(column)) return "boolean";
        if (["date", "period", "balance_period", "data_platezha", "data_postupleniya"].includes(column)) return "timestamp";
        if (["line_number", "_parent_line_index"].includes(column)) return "bigint";
        if (/^(kolichestvo|summa|tsena|rezerv)/.test(column)) return "numeric";
        return "text";
      };
      const table = `"${schema}"."${required.table}"`;
      await db.$executeRawUnsafe(`CREATE TABLE ${table} (${columns.map((column) => `"${column}" ${type(column)}`).join(",")})`);
      tables.push(required.table);
      const keys = required.identityKind === "child-expression"
        ? "COALESCE(ref_key,_parent_ref_key), COALESCE(line_number,_parent_line_index)"
        : required.columns.map((column) => `"${column}"`).join(",");
      await db.$executeRawUnsafe(`CREATE UNIQUE INDEX "${required.name}" ON ${table} (${keys})${required.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""}`);
      await db.$executeRawUnsafe(`COMMENT ON INDEX "${schema}"."${required.name}" IS 'naliv:ingest:compact-v1'`);
    }
    await db.$executeRawUnsafe("CREATE SCHEMA IF NOT EXISTS ops");
    await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS ops.analytics_storage_layout (
      table_schema text PRIMARY KEY, layout_version integer NOT NULL, contract_sha256 text NOT NULL,
      activated_at timestamptz NOT NULL, migration_id uuid NOT NULL, plan_sha256 text NOT NULL,
      ddl_frozen boolean NOT NULL DEFAULT false)`);
    await db.$executeRawUnsafe(`INSERT INTO ops.analytics_storage_layout VALUES ($1,1,$2,now(),$3::uuid,'fixture',false)`, schema, hash, randomUUID());
    markerInserted = true;
    await db.$executeRawUnsafe(`INSERT INTO "${schema}".catalog_sklady (ref_key,magazin_key) VALUES ('w1','s1')`);
    await db.$executeRawUnsafe(`INSERT INTO "${schema}".document_zakaz_postavschiku (ref_key,magazin_key) VALUES ('o1','s1')`);
    const lookups = [
      ["catalog_sklady", "analytics_warehouse_ref_idx", "w1"],
      ["document_zakaz_postavschiku", "analytics_supplier_order_ref_idx", "o1"]
    ] as const;
    for (const [table, alias] of lookups) {
      await db.$executeRawUnsafe(`CREATE INDEX "${alias}" ON "${schema}"."${table}" (ref_key)`);
    }
    await db.$executeRawUnsafe(`CREATE INDEX feature_warehouse_lookup ON "${schema}".catalog_sklady (magazin_key)`);
    await db.$executeRawUnsafe(`COMMENT ON INDEX "${schema}".feature_warehouse_lookup IS 'feature:warehouse'`);
    const before = await readIndexSnapshots(db, schema);
    await applyIndexManifest(db, schema, false, () => {});
    const after = await readIndexSnapshots(db, schema);
    for (const [table, alias, key] of lookups) {
      assert.equal(after.some((index) => index.name === alias), false);
      const required = manifest.requiredIngestIndexes.find((index) => index.table === table)!;
      const canonical = after.find((index) => index.name === required.name)!;
      assert.equal(ingestIndexDefinitionMatches(canonical, required), true);
      assert.equal(canonical.oid, before.find((index) => index.name === required.name)!.oid);
      assert.deepEqual(await db.$queryRawUnsafe(`SELECT magazin_key FROM "${schema}"."${table}" WHERE ref_key=$1`, key), [{ magazin_key: "s1" }]);
      await db.$executeRawUnsafe(`CREATE INDEX "${alias}" ON "${schema}"."${table}" (magazin_key)`);
      await assert.rejects(applyIndexManifest(db, schema, false, () => {}), /definition/i);
      await db.$executeRawUnsafe(`DROP INDEX "${schema}"."${alias}"`);
      await db.$executeRawUnsafe(`CREATE INDEX "${alias}" ON "${schema}"."${table}" (ref_key)`);
      await db.$executeRawUnsafe(`COMMENT ON INDEX "${schema}"."${alias}" IS 'feature:foreign'`);
      await assert.rejects(applyIndexManifest(db, schema, false, () => {}), /ownership/i);
      await db.$executeRawUnsafe(`DROP INDEX "${schema}"."${alias}"`);
    }
    assert.equal(after.find((index) => index.name === "feature_warehouse_lookup")!.oid, before.find((index) => index.name === "feature_warehouse_lookup")!.oid);
    await applyIndexManifest(db, schema, false, () => {});
    assert.deepEqual(await readIndexSnapshots(db, schema), after);
  } finally {
    if (markerInserted) await db.$executeRawUnsafe("DELETE FROM ops.analytics_storage_layout WHERE table_schema=$1", schema);
    for (const table of tables.reverse()) await db.$executeRawUnsafe(`DROP TABLE "${schema}"."${table}" RESTRICT`);
    if (schemaCreated) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" RESTRICT`);
    await db.$disconnect();
  }
});
