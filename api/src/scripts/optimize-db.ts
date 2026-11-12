import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import type { PrismaClient } from "@prisma/client";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const QUERY_COMMENT = "naliv:query:compact-v1";
const INGEST_COMMENT = "naliv:ingest:compact-v1";

type IdentityKind = "reference" | "child-expression" | "dimensions";
interface StorageContract {
  layoutVersion: number;
  targetDatabaseBytes: number;
  tables: Record<string, { columns: string[]; identity: { kind: IdentityKind; columns: string[] } }>;
}
export interface IndexSpec {
  name: string;
  table: string;
  keys: string;
  predicate: string | null;
  include: string[];
  optional: boolean;
}
export interface RequiredIngestIndex {
  table: string;
  name: string;
  identityKind: IdentityKind;
  columns: string[];
  nullsNotDistinct: boolean;
}
export interface IndexManifest {
  manifestVersion: 1;
  indexes: IndexSpec[];
  retiredNames: string[];
  retiredIndexes: IndexSpec[];
  requiredIngestIndexes: RequiredIngestIndex[];
}
export interface IndexSnapshot {
  oid: string;
  tableOid: string;
  name: string;
  table: string;
  definition: string;
  keys: string[];
  include: string[];
  predicate: string | null;
  unique: boolean;
  nullsNotDistinct: boolean;
  valid: boolean;
  ready: boolean;
  primary: boolean;
  method: string;
  constraintOid: string | null;
  comment: string | null;
  owner: string;
  columnTypes?: Record<string, string>;
}

// Query indexes belong here; natural identities belong to the canonical ingestion
// contract. Do not restore broad covering indexes over the compact heaps.
const queryDefinitions: Array<[string, string, string, string?, string?]> = [
  ["analytics_check_date_idx", "document_chek_kkm", "date", "deletion_mark IS NOT TRUE AND posted = TRUE"],
  ["analytics_check_parent_idx", "document_chek_kkm_tovary", '"_parent_ref_key"'],
  ["analytics_retail_parent_idx", "document_otchet_o_roznichnyh_prodazhah_tovary", '"_parent_ref_key"'],
  ["analytics_purchase_parent_idx", "document_postuplenie_tovarov_tovary", '"_parent_ref_key"'],
  ["analytics_retail_date_idx", "document_otchet_o_roznichnyh_prodazhah", "date"],
  ["analytics_retail_return_parent_idx", "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary", '"_parent_ref_key"'],
  ["analytics_purchase_date_idx", "document_postuplenie_tovarov", "date", "deletion_mark IS NOT TRUE AND posted = TRUE", "ref_key"],
  ["analytics_cost_date_idx", "document_ustanovka_sebestoimosti", "date", "deletion_mark IS NOT TRUE AND posted = TRUE", "ref_key, magazin_key"],
  ["analytics_cost_parent_idx", "document_ustanovka_sebestoimosti_tovary", '"_parent_ref_key"', undefined, "nomenklatura_key, tsena, _parent_line_index"],
  ["analytics_live_store_cost_idx", "information_register_sebestoimost_nomenklatury_record_type", "magazin_key, nomenklatura_key, period DESC, line_number DESC", "active IS NOT FALSE AND nullif(magazin_key, '') IS NOT NULL AND nomenklatura_key IS NOT NULL AND tsena > 0", "tsena"],
  ["analytics_supplier_order_date_idx", "document_zakaz_postavschiku", "date"],
  ["analytics_supplier_stage_parent_idx", "document_zakaz_postavschiku_etapy_oplat", '"_parent_ref_key"'],
  ["analytics_supplier_stage_due_idx", "document_zakaz_postavschiku_etapy_oplat", "data_platezha"],
  ["analytics_purchase_order_date_idx", "document_postuplenie_tovarov", "zakaz_postavschiku_key, date", "deletion_mark IS NOT TRUE AND posted = TRUE", "summa_dokumenta"],
  ["turnover_retail_item_parent_idx", "document_otchet_o_roznichnyh_prodazhah_tovary", 'nomenklatura_key, "_parent_ref_key"'],
  ["turnover_return_item_parent_idx", "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary", 'nomenklatura_key, "_parent_ref_key"', undefined, "sklad_key, harakteristika_key, kolichestvo, summa"],
  ["turnover_retail_header_date_idx", "document_otchet_o_roznichnyh_prodazhah", "date", "posted = TRUE AND deletion_mark IS NOT TRUE", "ref_key, magazin_key"],
  ["turnover_stock_period_idx", "accumulation_register_tovary_na_skladah_balance", "balance_period"],
  ["turnover_cost_item_store_period_idx", "information_register_sebestoimost_nomenklatury_record_type", "nomenklatura_key, magazin_key, period DESC, line_number DESC", "active IS NOT FALSE", "harakteristika_key, tsena"],
  ["turnover_cost_item_parent_idx", "document_ustanovka_sebestoimosti_tovary", 'nomenklatura_key, "_parent_ref_key"', undefined, "harakteristika_key, tsena, _parent_line_index"],
  ["turnover_barcode_item_parent_idx", "document_chek_kkm_tovary", 'nomenklatura_key, "_parent_ref_key"', "nullif(trim(shtrihkod), '') IS NOT NULL", "shtrihkod"],
  ["turnover_order_item_parent_idx", "document_zakaz_postavschiku_tovary", 'nomenklatura_key, "_parent_ref_key"', undefined, "kolichestvo"],
  ["turnover_open_order_ref_idx", "document_zakaz_postavschiku", "ref_key", "posted = TRUE AND deletion_mark IS NOT TRUE AND zakryt IS NOT TRUE", "date, magazin_key, sklad_key, data_postupleniya"],
  ["analytics_writeoff_date_idx", "document_spisanie_tovarov", "date"],
  ["analytics_writeoff_parent_idx", "document_spisanie_tovarov_tovary", '"_parent_ref_key"'],
  ["analytics_surplus_date_idx", "document_oprihodovanie_tovarov", "date"],
  ["analytics_surplus_parent_idx", "document_oprihodovanie_tovarov_tovary", '"_parent_ref_key"'],
  ["analytics_revision_date_idx", "document_pereschet_tovarov", "date"],
  ["analytics_revision_parent_idx", "document_pereschet_tovarov_tovary", '"_parent_ref_key"']
];
const optionalTables: Record<string, true> = {
  document_zakaz_postavschiku_etapy_oplat: true,
  document_spisanie_tovarov_tovary: true,
  document_oprihodovanie_tovarov_tovary: true,
  document_pereschet_tovarov_tovary: true
};
// Only these captured predecessor definitions may be retired. A known name on
// an unrelated relation, a constraint or an unrelated UNIQUE index is not ours.
const retiredDefinitions: Array<[string, string, string, string?, string?]> = [
  ["analytics_warehouse_ref_idx", "catalog_sklady", "ref_key"],
  ["analytics_supplier_order_ref_idx", "document_zakaz_postavschiku", "ref_key"],
  ["analytics_retail_parent_cover_idx", "document_otchet_o_roznichnyh_prodazhah_tovary", '"_parent_ref_key"', undefined, "nomenklatura_key, kolichestvo, summa, tsena, summa_nds"],
  ["analytics_balance_period_idx", "accumulation_register_tovary_na_skladah_balance", "balance_period"],
  ["turnover_stock_item_period_idx", "accumulation_register_tovary_na_skladah_balance", "nomenklatura_key, balance_period, sklad_key", undefined, "harakteristika_key, kolichestvo_balance"],
  ["turnover_stock_positive_idx", "accumulation_register_tovary_na_skladah_balance", "nomenklatura_key, balance_period", "kolichestvo_balance > 0", "sklad_key, harakteristika_key"],
  ["analytics_retail_ref_idx", "document_otchet_o_roznichnyh_prodazhah", "ref_key"],
  ["analytics_purchase_ref_idx", "document_postuplenie_tovarov", "ref_key"],
  ["analytics_product_ref_idx", "catalog_nomenklatura", "ref_key"],
  ["analytics_store_ref_idx", "catalog_magaziny", "ref_key"],
  ["turnover_check_header_ref_idx", "document_chek_kkm", "ref_key", "posted = TRUE AND deletion_mark IS NOT TRUE", "date"]
];

function toSpec([name, table, keys, predicate, include]: typeof queryDefinitions[number]): IndexSpec {
  return { name, table, keys, predicate: predicate ?? null, include: include?.split(",").map((column) => column.trim()) ?? [], optional: optionalTables[table] === true };
}

function readContract(contractPath?: string): StorageContract {
  // Source and dist scripts have the same depth relative to the sibling repo.
  // Standalone deployments mount the SAME canonical file at this explicit path.
  const configuredPath = contractPath ?? process.env.ANALYTICS_STORAGE_CONTRACT;
  const path = configuredPath
    ? resolve(configuredPath)
    : fileURLToPath(new URL("../../../../naliv_data1/analytics_storage_contract.json", import.meta.url));
  const contract = JSON.parse(readFileSync(path, "utf8")) as StorageContract;
  if (contract.layoutVersion !== 1 || contract.targetDatabaseBytes !== 10_000_000_000 || !contract.tables || Array.isArray(contract.tables)) {
    throw new Error("Unsupported analytics storage contract");
  }
  for (const [table, value] of Object.entries(contract.tables)) {
    const identity = value.identity;
    if (!/^[a-z_][a-z0-9_]*$/.test(table) || !Array.isArray(value.columns) || new Set(value.columns).size !== value.columns.length ||
        !identity || !["reference", "child-expression", "dimensions"].includes(identity.kind) ||
        !Array.isArray(identity.columns) || !identity.columns.length || new Set(identity.columns).size !== identity.columns.length ||
        identity.columns.some((column) => !value.columns.includes(column))) {
      throw new Error(`Invalid analytics storage identity: ${table}`);
    }
  }
  return contract;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function getIndexManifest(contractPath?: string): IndexManifest {
  const contract = readContract(contractPath);
  const indexes = queryDefinitions.map(toSpec);
  for (const index of indexes) {
    if (!contract.tables[index.table]) throw new Error(`Query index is outside storage contract: ${index.name}`);
  }
  return {
    manifestVersion: 1,
    indexes,
    retiredNames: retiredDefinitions.map(([name]) => name),
    retiredIndexes: retiredDefinitions.map(toSpec),
    requiredIngestIndexes: Object.entries(contract.tables).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([table, value]) => ({
      table,
      name: `ingest_${table.slice(0, 36)}_${createHash("sha256").update(table).digest("hex").slice(0, 12)}_uidx`,
      identityKind: value.identity.kind,
      columns: [...value.identity.columns],
      nullsNotDistinct: value.identity.kind === "dimensions"
    }))
  };
}

export function selectQueryIndexes(manifest: IndexManifest, turnoverOnly: boolean): IndexSpec[] {
  return manifest.indexes.filter((index) => !turnoverOnly || index.name.startsWith("turnover_"));
}

// Compare PostgreSQL's deparser output, not just names or column sets. Literal
// contents, ordered keys, DESC, opclasses and grouping remain significant.
function normalizedSql(sql: string): string {
  const tokens = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|::|>=|<=|<>|!=|[a-z_][a-z0-9_]*|\d+(?:\.\d+)?|[^\s]/gi) ?? [];
  const normalized = tokens.map((token) => {
    if (token.startsWith("'")) return token;
    if (token.startsWith('"')) {
      const identifier = token.slice(1, -1).replaceAll('""', '"');
      return /^[a-z_][a-z0-9_]*$/.test(identifier) ? identifier : token;
    }
    return token.toLowerCase();
  }).filter((token, i, all) => !((token === "::" && all[i - 1]?.startsWith("'") && all[i + 1] === "text") ||
    (token === "text" && all[i - 1] === "::" && all[i - 2]?.startsWith("'"))));
  const render = (parts: string[]): string => {
    while (parts[0] === "(" && parts.at(-1) === ")") {
      let depth = 0;
      const wrapsAll = parts.every((token, i) => {
        if (token === "(") depth++;
        if (token === ")") depth--;
        return depth !== 0 || i === parts.length - 1;
      });
      if (!wrapsAll) break;
      parts = parts.slice(1, -1);
    }
    // OR binds less tightly than AND. Split it first so flattening harmless
    // parentheses cannot equate `a OR b AND c` with `(a OR b) AND c`.
    let depth = 0;
    let booleanOperator = "and";
    for (const token of parts) {
      if (token === "(") depth++;
      if (token === ")") depth--;
      if (depth === 0 && token === "or") { booleanOperator = "or"; break; }
    }
    const terms: string[][] = [[]];
    depth = 0;
    for (const token of parts) {
      if (token === "(") depth++;
      if (token === ")") depth--;
      if (depth === 0 && token === booleanOperator) terms.push([]);
      else terms.at(-1)!.push(token);
    }
    if (terms.length > 1) return terms.map((term) => `(${render(term)})`).join(` ${booleanOperator} `);
    // pg_get_expr coerces a comparison's integer literal to NUMERIC when the
    // column is NUMERIC (e.g. > (0)::numeric). Erase only this bare exact-type
    // coercion on the entire right literal, never casts on columns, arithmetic
    // operands, quoted strings, precision-qualified types or chained casts.
    depth = 0;
    let comparison = -1;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "(") depth++;
      else if (parts[i] === ")") depth--;
      else if (depth === 0 && [">", ">=", "<", "<=", "=", "<>", "!="].includes(parts[i])) {
        if (comparison !== -1) { comparison = -1; break; }
        comparison = i;
      } else if (depth === 0 && parts[i] === "or") {
        comparison = -1;
        break;
      }
    }
    if (comparison !== -1 && parts.at(-2) === "::" && parts.at(-1) === "numeric") {
      let literal = parts.slice(comparison + 1, -2);
      while (literal[0] === "(" && literal.at(-1) === ")") literal = literal.slice(1, -1);
      const digits = literal.length === 1 ? literal[0] : literal.length === 2 && ["+", "-"].includes(literal[0]) ? literal[1] : null;
      if (digits !== null && /^\d+(?:\.\d+)?$/.test(digits)) parts = [...parts.slice(0, comparison + 1), ...literal];
    }
    const result: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== "(") { result.push(parts[i]); continue; }
      let end = i + 1;
      let nested = 1;
      for (; end < parts.length; end++) {
        if (parts[end] === "(") nested++;
        if (parts[end] === ")" && --nested === 0) break;
      }
      let inner = parts.slice(i + 1, end);
      if (result.at(-1) === "trim" && inner[0] === "both" && inner[1] === "from") inner = inner.slice(2);
      result.push(`(${render(inner)})`);
      i = end;
    }
    return result.join(" ");
  };
  return render(normalized);
}

function splitKeys(sql: string): string[] {
  const keys: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    if (sql[i] === ")") depth--;
    if (sql[i] === "," && depth === 0) { keys.push(sql.slice(start, i).trim()); start = i + 1; }
  }
  keys.push(sql.slice(start).trim());
  return keys;
}

function keysFromDefinition(definition: string): string[] {
  // The column-number pg_get_indexdef overload deliberately omits DESC, NULLS,
  // opclasses and collations. Extract the first unquoted, balanced key list from
  // the full server-generated definition instead of silently ignoring those.
  let quoted: "'" | '"' | null = null;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < definition.length; i++) {
    const char = definition[i];
    if (quoted) {
      if (char === quoted) {
        if (definition[i + 1] === quoted) i++;
        else quoted = null;
      }
      continue;
    }
    if (char === "'" || char === '"') { quoted = char; continue; }
    if (char === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (char === ")" && --depth === 0 && start !== -1) {
      return splitKeys(definition.slice(start, i));
    }
  }
  throw new Error("Unable to inspect full PostgreSQL index definition");
}

export function indexDefinitionMatches(actual: IndexSnapshot, expected: IndexSpec, unique = false, nullsNotDistinct = false): boolean {
  return actual.table === expected.table && actual.valid && actual.ready && !actual.primary &&
    actual.method === "btree" && actual.constraintOid === null && actual.unique === unique && actual.nullsNotDistinct === nullsNotDistinct &&
    JSON.stringify(actual.keys.map(normalizedSql)) === JSON.stringify(splitKeys(expected.keys).map(normalizedSql)) &&
    JSON.stringify(actual.include.map(normalizedSql)) === JSON.stringify(expected.include.map(normalizedSql)) &&
    (actual.predicate === null ? expected.predicate === null : expected.predicate !== null && normalizedSql(actual.predicate) === normalizedSql(expected.predicate));
}

function ingestSpec(index: RequiredIngestIndex): IndexSpec {
  return {
    name: index.name, table: index.table,
    keys: index.identityKind === "child-expression"
      ? "COALESCE(ref_key, _parent_ref_key), COALESCE(line_number, _parent_line_index)"
      : index.columns.map(quote).join(", "),
    predicate: null, include: [], optional: false
  };
}

export function ingestIndexDefinitionMatches(actual: IndexSnapshot, required: RequiredIngestIndex): boolean {
  const expected = ingestSpec(required);
  if (required.identityKind === "child-expression") {
    // These are the actual pg_attribute base types, not guessed payload types.
    // PostgreSQL's numeric category chooses the widest common type. Render only
    // its required widening casts; never strip arbitrary casts from live keys.
    const types = actual.columnTypes;
    const rank: Record<string, number> = { smallint: 0, integer: 1, bigint: 2, numeric: 3 };
    const lineType = types?.line_number;
    const parentType = types?._parent_line_index;
    if (!types || types.ref_key !== "text" || types._parent_ref_key !== "text" ||
        !lineType || !parentType || !Object.hasOwn(rank, lineType) || !Object.hasOwn(rank, parentType)) return false;
    const commonType = rank[lineType] >= rank[parentType] ? lineType : parentType;
    const line = lineType === commonType ? "line_number" : `(line_number)::${commonType}`;
    const parentLine = parentType === commonType ? "_parent_line_index" : `(_parent_line_index)::${commonType}`;
    expected.keys = `COALESCE(ref_key, _parent_ref_key), COALESCE(${line}, ${parentLine})`;
  }
  return actual.comment === INGEST_COMMENT && indexDefinitionMatches(actual, expected, true, required.nullsNotDistinct);
}

function assertIngestIndex(required: RequiredIngestIndex, snapshots: IndexSnapshot[]): void {
  const actual = snapshots.find((index) => index.name === required.name);
  if (!actual || !ingestIndexDefinitionMatches(actual, required)) {
    throw new Error(`Valid full canonical ingest identity required: ${required.table}.${required.name}; run the storage migration`);
  }
}

type Reconciliation = { kind: "keep" } | { kind: "create"; buildName: string } |
  { kind: "rename"; buildName: string } | { kind: "replace"; buildName: string; old: IndexSnapshot };

export function planIndexReconciliation(spec: IndexSpec, snapshots: IndexSnapshot[]): Reconciliation {
  const existing = snapshots.find((index) => index.name === spec.name);
  if (existing && (!existing.valid || !existing.ready)) throw new Error(`Index ${spec.name} is invalid; administrator repair is required before retrying`);
  if (existing && indexDefinitionMatches(existing, spec)) return { kind: "keep" };
  if (existing && (existing.table !== spec.table || existing.unique || existing.primary || existing.constraintOid !== null)) {
    throw new Error(`Index ownership/table/unique collision: ${spec.name}`);
  }
  if (existing?.comment && existing.comment !== QUERY_COMMENT) {
    throw new Error(`Index ownership collision: ${spec.name}`);
  }
  const hash = createHash("sha256").update(canonicalJson(spec)).digest("hex").slice(0, 12);
  const buildName = `${spec.name.slice(0, 43)}_v1_${hash}`;
  const replacement = snapshots.find((index) => index.name === buildName);
  if (replacement && (!replacement.valid || !replacement.ready)) throw new Error(`Replacement index ${buildName} is invalid; administrator repair is required`);
  if (replacement && (replacement.comment !== QUERY_COMMENT || !indexDefinitionMatches(replacement, spec))) {
    throw new Error(`Unrecorded replacement ownership/name collision: ${buildName}`);
  }
  if (!existing) return replacement ? { kind: "rename", buildName } : { kind: "create", buildName: spec.name };
  return { kind: "replace", buildName, old: existing };
}

export function retirementCandidates(manifest: IndexManifest, snapshots: IndexSnapshot[], turnoverOnly = false): IndexSnapshot[] {
  const selected = new Set(selectQueryIndexes(manifest, turnoverOnly).map((index) => index.table));
  const candidates: IndexSnapshot[] = [];
  for (const spec of manifest.retiredIndexes) {
    if (!manifest.retiredNames.includes(spec.name) || (turnoverOnly && !selected.has(spec.table))) continue;
    const actual = snapshots.find((index) => index.name === spec.name);
    if (!actual || actual.unique || actual.primary || actual.constraintOid !== null) continue;
    if (actual.comment && actual.comment !== QUERY_COMMENT) throw new Error(`Retired index ownership collision: ${spec.name}`);
    if (!actual.valid || !actual.ready) throw new Error(`Retired index ${spec.name} is invalid; administrator repair is required`);
    if (!indexDefinitionMatches(actual, spec)) throw new Error(`Unrecorded retired index definition: ${spec.name}`);
    const required = manifest.requiredIngestIndexes.find((index) => index.table === spec.table);
    if (!required) throw new Error(`Canonical identity specification missing: ${spec.table}`);
    assertIngestIndex(required, snapshots);
    candidates.push(actual);
  }
  return candidates;
}

export function assertCompactLayout(marker: { layoutVersion: number; contractSha256: string; ddlFrozen: boolean } | null, contractHash: string): void {
  if (!marker || marker.layoutVersion !== 1 || marker.contractSha256 !== contractHash) {
    throw new Error("Analytics storage migration required: compact layout v1; use compact_analytics_db.py");
  }
  if (marker.ddlFrozen) throw new Error("Storage compaction active; retry optimizer after maintenance");
}

export async function readIndexSnapshots(db: PrismaClient, schema: string): Promise<IndexSnapshot[]> {
  const snapshots = await db.$queryRawUnsafe<Array<Omit<IndexSnapshot, "keys">>>(`
    SELECT i.indexrelid::text AS oid, i.indrelid::text AS "tableOid", c.relname::text AS name,
      t.relname::text AS table, pg_get_indexdef(i.indexrelid) AS definition,
      ARRAY(SELECT pg_get_indexdef(i.indexrelid, p, true) FROM generate_series(i.indnkeyatts + 1, i.indnatts) p) AS include,
      pg_get_expr(i.indpred, i.indrelid) AS predicate, i.indisunique AS unique,
      i.indnullsnotdistinct AS "nullsNotDistinct", i.indisvalid AS valid, i.indisready AS ready,
      i.indisprimary AS primary, am.amname::text AS method, con.oid::text AS "constraintOid",
      obj_description(c.oid, 'pg_class') AS comment, pg_get_userbyid(c.relowner)::text AS owner,
      COALESCE((SELECT jsonb_object_agg(a.attname, format_type(a.atttypid, NULL))
        FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attname IN ('ref_key', '_parent_ref_key', 'line_number', '_parent_line_index')), '{}'::jsonb) AS "columnTypes"
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_am am ON am.oid = c.relam LEFT JOIN pg_constraint con
      ON con.conindid = c.oid AND con.conrelid = i.indrelid AND con.contype IN ('p', 'u', 'x')
    WHERE n.nspname = $1 ORDER BY c.relname`, schema);
  return snapshots.map((index) => ({ ...index, keys: keysFromDefinition(index.definition) }));
}

function createSql(schema: string, spec: IndexSpec, name = spec.name): string {
  return `CREATE INDEX CONCURRENTLY ${quote(name)} ON ${quote(schema)}.${quote(spec.table)} (${spec.keys})${spec.include.length ? ` INCLUDE (${spec.include.map(quote).join(", ")})` : ""}${spec.predicate ? ` WHERE ${spec.predicate}` : ""}`;
}

async function assertCapturedIndex(db: PrismaClient, schema: string, captured: IndexSnapshot): Promise<void> {
  const live = (await readIndexSnapshots(db, schema)).find((index) => index.name === captured.name);
  if (!live || canonicalJson(live) !== canonicalJson(captured)) throw new Error(`Index changed since inventory: ${captured.name}; no object was retired`);
}

async function dropCapturedIndex(db: PrismaClient, schema: string, captured: IndexSnapshot, log: (message: string) => void): Promise<void> {
  await assertCapturedIndex(db, schema, captured);
  const sql = `DROP INDEX CONCURRENTLY ${quote(schema)}.${quote(captured.name)}`;
  log(sql + ";");
  await db.$executeRawUnsafe(sql);
}

// All concurrent DDL is autocommit on the caller's one-connection client. Only
// COMMENT/RENAME metadata is transactional; never wrap this function in BEGIN.
export async function reconcileQueryIndex(db: PrismaClient, schema: string, spec: IndexSpec, log: (message: string) => void = console.log): Promise<boolean> {
  let snapshots = await readIndexSnapshots(db, schema);
  const action = planIndexReconciliation(spec, snapshots);
  if (action.kind === "keep") return false;
  let built = snapshots.find((index) => index.name === action.buildName);
  if (!built) {
    const sql = createSql(schema, spec, action.buildName);
    log(sql + ";");
    await db.$executeRawUnsafe(sql);
    snapshots = await readIndexSnapshots(db, schema);
    built = snapshots.find((index) => index.name === action.buildName);
    if (!built || !indexDefinitionMatches(built, spec)) throw new Error(`Built index failed exact validation: ${action.buildName}`);
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
      await tx.$executeRawUnsafe(`COMMENT ON INDEX ${quote(schema)}.${quote(action.buildName)} IS '${QUERY_COMMENT}'`);
    });
    built = (await readIndexSnapshots(db, schema)).find((index) => index.name === action.buildName)!;
  }
  if (!indexDefinitionMatches(built, spec)) throw new Error(`Replacement is not valid: ${action.buildName}`);
  if (action.kind === "replace") await dropCapturedIndex(db, schema, action.old, log);
  if (action.kind === "replace" || action.kind === "rename") {
    await assertCapturedIndex(db, schema, built);
    // A marked valid replacement survives a crash between retirement and rename.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`);
      await tx.$executeRawUnsafe(`ALTER INDEX ${quote(schema)}.${quote(action.buildName)} RENAME TO ${quote(spec.name)}`);
    });
  }
  const final = (await readIndexSnapshots(db, schema)).find((index) => index.name === spec.name);
  if (!final || !indexDefinitionMatches(final, spec)) throw new Error(`Final index failed exact validation: ${spec.name}`);
  return true;
}

export async function applyIndexManifest(db: PrismaClient, schema: string, turnoverOnly = false, log: (message: string) => void = console.log, contractPath?: string): Promise<void> {
  const manifest = getIndexManifest(contractPath);
  const contractHash = createHash("sha256").update(canonicalJson(readContract(contractPath))).digest("hex");
  const maintenanceKey = `naliv-analytics-maintenance:${schema}`;
  const storageKey = `naliv-analytics-storage:${schema}`;
  let maintenanceLocked = false;
  let storageLocked = false;
  try {
    await db.$executeRawUnsafe("SET lock_timeout = '5s'");
    await db.$executeRawUnsafe("SET statement_timeout = '10min'");
    const maintenance = await db.$queryRawUnsafe<Array<{ acquired: boolean }>>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", maintenanceKey);
    if (!maintenance[0]?.acquired) throw new Error("Storage maintenance is already running");
    maintenanceLocked = true;
    const storage = await db.$queryRawUnsafe<Array<{ acquired: boolean }>>("SELECT pg_try_advisory_lock_shared(hashtextextended($1, 0)) AS acquired", storageKey);
    if (!storage[0]?.acquired) throw new Error("Storage activation/index preparation is active");
    storageLocked = true;
    const markerTable = await db.$queryRawUnsafe<Array<{ exists: boolean }>>("SELECT to_regclass('ops.analytics_storage_layout') IS NOT NULL AS exists");
    const markers = markerTable[0]?.exists ? await db.$queryRawUnsafe<Array<{ layoutVersion: number; contractSha256: string; ddlFrozen: boolean }>>(`
      SELECT layout_version AS "layoutVersion", contract_sha256 AS "contractSha256", ddl_frozen AS "ddlFrozen"
      FROM ops.analytics_storage_layout WHERE table_schema = $1`, schema) : [];
    assertCompactLayout(markers[0] ?? null, contractHash);
    const tables = new Set((await db.$queryRawUnsafe<Array<{ name: string }>>(`
      SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'm')`, schema)).map((table) => table.name));
    let snapshots = await readIndexSnapshots(db, schema);
    const invalid = snapshots.find((index) => !index.valid || !index.ready);
    if (invalid) throw new Error(`Index ${invalid.name} is invalid; administrator repair is required before optimizer apply`);
    for (const required of manifest.requiredIngestIndexes) {
      if (tables.has(required.table)) assertIngestIndex(required, snapshots);
    }
    const selected = selectQueryIndexes(manifest, turnoverOnly).filter((spec) => {
      if (tables.has(spec.table)) return true;
      if (!spec.optional) throw new Error(`Required analytical source is absent: ${schema}.${spec.table}`);
      log(`Skipping ${spec.name}: optional source ${schema}.${spec.table} is absent.`);
      return false;
    });
    // Complete preflight before building anything, including name collisions.
    for (const spec of selected) planIndexReconciliation(spec, snapshots);
    const capturedRetirements = retirementCandidates(manifest, snapshots, turnoverOnly);
    const analyzed = new Set<string>();
    for (const spec of selected) {
      if (await reconcileQueryIndex(db, schema, spec, log)) analyzed.add(spec.table);
    }
    for (const captured of capturedRetirements) await dropCapturedIndex(db, schema, captured, log);
    for (const table of analyzed) {
      const sql = `ANALYZE ${quote(schema)}.${quote(table)}`;
      log(sql + ";");
      await db.$executeRawUnsafe(sql);
    }
    snapshots = await readIndexSnapshots(db, schema);
    for (const spec of selected) {
      const actual = snapshots.find((index) => index.name === spec.name);
      if (!actual || !indexDefinitionMatches(actual, spec)) throw new Error(`Final manifest disagreement: ${spec.name}`);
    }
  } finally {
    if (storageLocked) await db.$queryRawUnsafe("SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))::text", storageKey);
    if (maintenanceLocked) await db.$queryRawUnsafe("SELECT pg_advisory_unlock(hashtextextended($1, 0))::text", maintenanceKey);
  }
}

export async function runOptimizer(args = process.argv.slice(2)): Promise<void> {
  let contractPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--contract") {
      if (contractPath || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--contract requires one canonical JSON file path");
      contractPath = args[++i];
    } else if (!["--json", "--apply", "--turnover-only"].includes(args[i])) {
      throw new Error(`Unknown argument: ${args[i]}`);
    }
  }
  if (!args.includes("--json")) dotenv.config();
  const manifest = getIndexManifest(contractPath);
  if (args.includes("--json")) {
    if (args.includes("--apply")) throw new Error("--json cannot be combined with --apply");
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  const schema = process.env.PGSCHEMA || "raw_1c";
  if (!args.includes("--apply")) {
    console.log("-- Dry run only. Apply requires compact layout v1, no DDL freeze, valid canonical ingest identities and exact catalogue reconciliation.");
    for (const spec of selectQueryIndexes(manifest, args.includes("--turnover-only"))) console.log(createSql(schema, spec) + ";");
    console.log(`-- Retire only captured matching predecessor indexes after canonical identity validation: ${manifest.retiredNames.join(", ")}`);
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for --apply");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("connection_limit", "1");
  // JSON must also work before `prisma generate`; loading the generated client
  // statically would make that database-independent artifact depend on it.
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    await applyIndexManifest(db, schema, args.includes("--turnover-only"), console.log, contractPath);
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOptimizer().catch((error: unknown) => {
    // Never print connection strings or Prisma's verbose query/connection errors.
    console.error(error instanceof Error && !error.constructor.name.startsWith("Prisma") ? error.message : "Index optimization failed; inspect the protected database logs");
    process.exitCode = 1;
  });
}
