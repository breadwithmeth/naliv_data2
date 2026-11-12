import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  getIndexManifest, indexDefinitionMatches, planIndexReconciliation,
  assertCompactLayout, selectQueryIndexes, retirementCandidates, ingestIndexDefinitionMatches,
  type IndexSnapshot
} from "../src/scripts/optimize-db.js";

const script = fileURLToPath(new URL("../src/scripts/optimize-db.ts", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = getIndexManifest();
const spec = manifest.indexes.find((row) => row.name === "analytics_check_parent_idx")!;
const snapshot = (overrides: Partial<IndexSnapshot> = {}): IndexSnapshot => ({
  oid: "201", tableOid: "101", name: spec.name, table: spec.table,
  definition: 'CREATE INDEX analytics_check_parent_idx ON raw_1c.document_chek_kkm_tovary USING btree (_parent_ref_key)',
  keys: ["_parent_ref_key"], include: [], predicate: null, unique: false,
  nullsNotDistinct: false, valid: true, ready: true, primary: false,
  method: "btree", constraintOid: null, comment: null, owner: "test_owner",
  ...overrides
});

// Importing config or opening Prisma in JSON mode breaks this operator entry point.
test("JSON manifest runs without application environment or database connection", () => {
  const env = { ...process.env };
  for (const key of ["DATABASE_URL", "APP_ADMIN_EMAIL", "APP_ADMIN_PASSWORD", "APP_MARKETING_EMAIL", "APP_MARKETING_PASSWORD", "JWT_SECRET", "PGSCHEMA"]) delete env[key];
  env.DATABASE_URL = "postgresql://invalid:invalid@127.0.0.1:1/not_a_database";
  const result = spawnSync(process.execPath, ["--import", "tsx", script, "--json"], {
    cwd: root, env, encoding: "utf8", timeout: 20_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), manifest);
  assert.equal(result.stderr, "");
});

test("explicit contract path takes precedence over an unavailable runtime mount", () => {
  const contractPath = fileURLToPath(new URL("../../../naliv_data1/analytics_storage_contract.json", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", script, "--json", "--contract", contractPath], {
    cwd: root, env: { ...process.env, ANALYTICS_STORAGE_CONTRACT: "missing-canonical-contract.json" },
    encoding: "utf8", timeout: 20_000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), manifest);
});

// Dropping a contract identity from manifest would permit alias retirement without coverage.
test("all 59 canonical ingest identities derive from the shared contract with stable names", () => {
  const contract = JSON.parse(readFileSync(new URL("../../../naliv_data1/analytics_storage_contract.json", import.meta.url), "utf8"));
  assert.equal(manifest.requiredIngestIndexes.length, 59);
  assert.deepEqual(manifest.requiredIngestIndexes.map((row) => row.table).sort(), Object.keys(contract.tables).sort());
  for (const row of manifest.requiredIngestIndexes) {
    const identity = contract.tables[row.table].identity;
    assert.deepEqual(row.columns, identity.columns);
    assert.equal(row.identityKind, identity.kind);
    assert.equal(row.nullsNotDistinct, identity.kind === "dimensions");
    const hash = createHash("sha256").update(row.table).digest("hex").slice(0, 12);
    assert.equal(row.name, `ingest_${row.table.slice(0, 36)}_${hash}_uidx`);
    assert.ok(Buffer.byteLength(row.name) <= 63);
  }
  const stock = manifest.requiredIngestIndexes.find((row) => row.table === "accumulation_register_tovary_na_skladah_balance")!;
  assert.deepEqual(stock.columns, ["nomenklatura_key", "balance_period", "sklad_key", "harakteristika_key"]);
});

// Wide covers and the stock aliases must not return in either optimizer mode.
test("narrow query indexes retain predicates and both modes select the same stock index", () => {
  for (const name of ["analytics_check_parent_idx", "analytics_check_date_idx", "turnover_retail_item_parent_idx"]) {
    assert.deepEqual(manifest.indexes.find((row) => row.name === name)!.include, []);
  }
  assert.equal(manifest.indexes.find((row) => row.name === "analytics_check_date_idx")!.predicate, "deletion_mark IS NOT TRUE AND posted = TRUE");
  assert.equal(manifest.indexes.find((row) => row.name === "analytics_live_store_cost_idx")!.keys, "magazin_key, nomenklatura_key, period DESC, line_number DESC");
  assert.equal(manifest.indexes.find((row) => row.name === "turnover_cost_item_store_period_idx")!.predicate, "active IS NOT FALSE");
  const stock = (turnoverOnly: boolean) => selectQueryIndexes(manifest, turnoverOnly).filter((row) => row.table === "accumulation_register_tovary_na_skladah_balance").map((row) => row.name);
  assert.deepEqual(stock(false), ["turnover_stock_period_idx"]);
  assert.deepEqual(stock(true), ["turnover_stock_period_idx"]);
  for (const name of ["analytics_retail_parent_cover_idx", "analytics_balance_period_idx", "turnover_stock_item_period_idx", "turnover_stock_positive_idx", "analytics_retail_ref_idx", "analytics_purchase_ref_idx", "analytics_product_ref_idx", "analytics_store_ref_idx", "turnover_check_header_ref_idx"]) {
    assert.ok(manifest.retiredNames.includes(name));
    assert.ok(!manifest.indexes.some((row) => row.name === name));
  }
});

// Migration must receive the same exact reviewed predecessors, not retire by
// name alone or maintain a second copy of query-index SQL in Python.
test("retired index manifest supplies exact predecessor definitions for every retirement name", () => {
  assert.deepEqual(manifest.retiredIndexes.map((index) => index.name), manifest.retiredNames);
  assert.deepEqual(manifest.retiredIndexes.find((index) => index.name === "turnover_stock_positive_idx"), {
    name: "turnover_stock_positive_idx", table: "accumulation_register_tovary_na_skladah_balance",
    keys: "nomenklatura_key, balance_period", predicate: "kolichestvo_balance > 0",
    include: ["sklad_key", "harakteristika_key"], optional: false
  });
  assert.deepEqual(manifest.retiredIndexes.find((index) => index.name === "analytics_retail_parent_cover_idx"), {
    name: "analytics_retail_parent_cover_idx", table: "document_otchet_o_roznichnyh_prodazhah_tovary",
    keys: '"_parent_ref_key"', predicate: null,
    include: ["nomenklatura_key", "kolichestvo", "summa", "tsena", "summa_nds"], optional: false
  });
  const source = snapshot({
    name: "turnover_check_header_ref_idx", table: "document_chek_kkm", keys: ["ref_key"],
    include: ["date"], predicate: "posted = TRUE AND deletion_mark IS NOT TRUE"
  });
  const retired = manifest.retiredIndexes.find((index) => index.name === source.name)!;
  assert.equal(indexDefinitionMatches(source, retired), true);
  assert.equal(indexDefinitionMatches({ ...source, include: [] }, retired), false);
});

// pg_get_expr's harmless formatting is not a migration; changed meaning is.
test("definition matching compares ordered keys, includes, predicates and uniqueness", () => {
  assert.equal(indexDefinitionMatches(snapshot(), spec), true);
  assert.equal(indexDefinitionMatches(snapshot({ include: ["summa"] }), spec), false);
  assert.equal(indexDefinitionMatches(snapshot({ unique: true }), spec), false);
  assert.equal(indexDefinitionMatches(snapshot({ predicate: "posted = true" }), spec), false);
  assert.equal(indexDefinitionMatches(snapshot({ keys: ["_parent_ref_key DESC"] }), spec), false);
  const dated = manifest.indexes.find((row) => row.name === "analytics_check_date_idx")!;
  assert.equal(indexDefinitionMatches(snapshot({ table: dated.table, keys: ["date"], predicate: "((deletion_mark IS NOT TRUE) AND (posted = true))" }), dated), true);
  const barcode = manifest.indexes.find((row) => row.name === "turnover_barcode_item_parent_idx")!;
  assert.equal(indexDefinitionMatches(snapshot({ table: barcode.table, keys: ["nomenklatura_key", "_parent_ref_key"], include: ["shtrihkod"], predicate: "(NULLIF(TRIM(BOTH FROM shtrihkod), ''::text) IS NOT NULL)" }), barcode), true);
});

// PostgreSQL coerces integer constants to exact NUMERIC for these predicates.
// Normalization must not erase a value-changing cast or expression grouping.
test("numeric deparser literal casts match without hiding semantic casts or precedence", () => {
  const cost = manifest.indexes.find((row) => row.name === "analytics_live_store_cost_idx")!;
  const actual = snapshot({
    table: cost.table, keys: ["magazin_key", "nomenklatura_key", "period DESC", "line_number DESC"],
    include: ["tsena"],
    predicate: "((active IS NOT FALSE) AND (NULLIF(magazin_key, ''::text) IS NOT NULL) AND (nomenklatura_key IS NOT NULL) AND (tsena > (0)::numeric))"
  });
  assert.equal(indexDefinitionMatches(actual, cost), true);
  for (const [expectedPredicate, actualPredicate, matches] of [
    ["tsena > 0", "tsena > ((0))::numeric", true],
    ["tsena > 0", "tsena > 0::numeric", true],
    ["tsena > 1.25", "tsena > (1.25)::numeric", true],
    ["tsena > 0", "tsena::integer > (0)::numeric", false],
    ["tsena > 0", "tsena > (0)::numeric(12, 0)", false],
    ["tsena > 0", "tsena > (0)::double precision", false],
    ["tsena > 1 / 2", "tsena > (1 / 2)::numeric", false],
    ["tsena > 1 / 2", "tsena > 1::numeric / 2", false],
    ["posted = TRUE OR active = TRUE AND tsena > 0", "(posted = TRUE OR active = TRUE) AND tsena > (0)::numeric", false],
    ["tsena > 0 AND (posted = TRUE OR active = TRUE)", "(tsena > (0)::numeric AND posted = TRUE) OR active = TRUE", false],
    ["magazin_key = 'STORE'", "magazin_key = 'store'", false]
  ] as const) {
    assert.equal(indexDefinitionMatches({ ...actual, predicate: actualPredicate }, { ...cost, predicate: expectedPredicate }), matches, actualPredicate);
  }
  const stock = manifest.requiredIngestIndexes.find((row) => row.table === "accumulation_register_tovary_na_skladah_balance")!;
  const positive = snapshot({
    name: "turnover_stock_positive_idx", table: stock.table,
    keys: ["nomenklatura_key", "balance_period"], include: ["sklad_key", "harakteristika_key"],
    predicate: "(kolichestvo_balance > (0)::numeric)"
  });
  const identity = snapshot({
    name: stock.name, oid: "202", table: stock.table, keys: stock.columns,
    unique: true, nullsNotDistinct: true, comment: "naliv:ingest:compact-v1"
  });
  assert.equal(retirementCandidates(manifest, [positive, identity])[0].name, "turnover_stock_positive_idx");
});

// IF NOT EXISTS masks the old wide definition; replacing it must retain the old until validation.
test("reconciliation plans deterministic replacements and reruns become no-ops", () => {
  assert.deepEqual(planIndexReconciliation(spec, []), { kind: "create", buildName: spec.name });
  assert.deepEqual(planIndexReconciliation(spec, [snapshot()]), { kind: "keep" });
  const old = snapshot({ include: ["nomenklatura_key", "kolichestvo", "summa"] });
  const action = planIndexReconciliation(spec, [old]);
  assert.equal(action.kind, "replace");
  if (action.kind !== "replace") return;
  assert.notEqual(action.buildName, spec.name);
  assert.deepEqual(planIndexReconciliation(spec, [old]), action);
  assert.ok(Buffer.byteLength(action.buildName) <= 63);
  assert.equal(action.old.oid, "201");
  const orphan = snapshot({ name: action.buildName, oid: "301", comment: "naliv:query:compact-v1" });
  assert.deepEqual(planIndexReconciliation(spec, [orphan]), { kind: "rename", buildName: action.buildName });
  assert.equal(planIndexReconciliation(spec, [snapshot({ keys: ["nomenklatura_key"] })]).kind, "replace");
  assert.deepEqual(planIndexReconciliation(spec, [snapshot({ oid: "301" })]), { kind: "keep" });
});

// Failed builds or someone else's unique constraint must never be destroyed as cleanup.
test("invalid indexes and unrelated unique/name collisions refuse reconciliation", () => {
  assert.throws(() => planIndexReconciliation(spec, [snapshot({ valid: false })]), /invalid/i);
  assert.throws(() => planIndexReconciliation(spec, [snapshot({ unique: true })]), /unique|ownership/i);
  assert.throws(() => planIndexReconciliation(spec, [snapshot({ table: "other_table" })]), /collision|table/i);
  assert.throws(() => planIndexReconciliation(spec, [snapshot({ keys: ["nomenklatura_key"], comment: "owned-by-another-feature" })]), /ownership/i);
  const old = snapshot({ include: ["nomenklatura_key", "kolichestvo", "summa"] });
  const action = planIndexReconciliation(spec, [old]);
  assert.equal(action.kind, "replace");
  if (action.kind !== "replace") return;
  assert.throws(() => planIndexReconciliation(spec, [old, snapshot({ name: action.buildName, oid: "202" })]), /ownership|unrecorded|collision/i);
});

// Aliases can go only when the replacement is a full, valid, owned canonical identity.
test("retired reference indexes require canonical identities and ignore unrelated uniques", () => {
  for (const [table, name, include, predicate] of [
    ["document_chek_kkm", "turnover_check_header_ref_idx", ["date"], "posted = TRUE AND deletion_mark IS NOT TRUE"],
    ["catalog_sklady", "analytics_warehouse_ref_idx", [], null],
    ["document_zakaz_postavschiku", "analytics_supplier_order_ref_idx", [], null]
  ] as const) {
    const reference = manifest.requiredIngestIndexes.find((row) => row.table === table)!;
    const alias = snapshot({ name, table, keys: ["ref_key"], include: [...include], predicate });
    assert.throws(() => retirementCandidates(manifest, [alias]), /canonical|identity/i);
    const canonical = snapshot({ name: reference.name, oid: "202", table, keys: ["ref_key"], unique: true, comment: "naliv:ingest:compact-v1" });
    assert.equal(retirementCandidates(manifest, [alias, canonical])[0].oid, "201");
    assert.throws(() => retirementCandidates(manifest, [alias, { ...canonical, predicate: "ref_key IS NOT NULL" }]), /canonical|identity/i);
    assert.deepEqual(retirementCandidates(manifest, [{ ...alias, unique: true }, canonical]), []);
    assert.throws(() => retirementCandidates(manifest, [{ ...alias, comment: "owned-by-another-feature" }, canonical]), /ownership/i);
    assert.throws(() => retirementCandidates(manifest, [{ ...alias, keys: ["date"] }, canonical]), /definition/i);
    assert.equal(retirementCandidates(manifest, [{ ...alias, comment: "naliv:query:compact-v1" }, canonical])[0].oid, "201");
    assert.deepEqual(retirementCandidates(manifest, [canonical]), []);
  }
});

// Source column types, not a list of ignorable cast spellings, determine which
// widening PostgreSQL must render in the canonical child COALESCE expression.
test("canonical child identity accepts only its actual common-type widening", () => {
  const required = manifest.requiredIngestIndexes.find((index) => index.table === "document_chek_kkm_tovary")!;
  for (const [lineType, parentType, rendered] of [
    ["bigint", "integer", "COALESCE(line_number, (_parent_line_index)::bigint)"],
    ["integer", "bigint", "COALESCE((line_number)::bigint, _parent_line_index)"],
    ["numeric", "integer", "COALESCE(line_number, (_parent_line_index)::numeric)"],
    ["integer", "numeric", "COALESCE((line_number)::numeric, _parent_line_index)"],
    ["integer", "integer", "COALESCE(line_number, _parent_line_index)"]
  ]) {
    const actual = snapshot({
      name: required.name, table: required.table, unique: true, comment: "naliv:ingest:compact-v1",
      keys: ["COALESCE(ref_key, _parent_ref_key)", rendered],
      columnTypes: { ref_key: "text", _parent_ref_key: "text", line_number: lineType, _parent_line_index: parentType }
    });
    assert.equal(ingestIndexDefinitionMatches(actual, required), true, rendered);
    assert.equal(ingestIndexDefinitionMatches({ ...actual, columnTypes: undefined }, required), false);
    for (const wrong of [
      "COALESCE((line_number)::integer, (_parent_line_index)::integer)",
      "COALESCE(line_number, (_parent_line_index)::numeric(12, 0))",
      "COALESCE(line_number, (_parent_line_index)::double precision)",
      "COALESCE(_parent_line_index, line_number)",
      "COALESCE(line_number, _parent_line_index, 0)"
    ]) {
      if (wrong === rendered) continue;
      assert.equal(ingestIndexDefinitionMatches({ ...actual, keys: [actual.keys[0], wrong] }, required), false, wrong);
    }
    assert.equal(ingestIndexDefinitionMatches({ ...actual, keys: ["COALESCE(_parent_ref_key, ref_key)", rendered] }, required), false);
  }
});

// Legacy layout and a frozen migration marker must refuse before any DDL.
test("apply layout gate rejects missing, mismatched or frozen markers", () => {
  const hash = "a".repeat(64);
  assert.throws(() => assertCompactLayout(null, hash), /migration required/i);
  assert.throws(() => assertCompactLayout({ layoutVersion: 1, contractSha256: "b".repeat(64), ddlFrozen: false }, hash), /migration required/i);
  assert.throws(() => assertCompactLayout({ layoutVersion: 1, contractSha256: hash, ddlFrozen: true }, hash), /compaction active/i);
  assert.doesNotThrow(() => assertCompactLayout({ layoutVersion: 1, contractSha256: hash, ddlFrozen: false }, hash));
});
