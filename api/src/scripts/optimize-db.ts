import { PrismaClient } from "@prisma/client";
import { config } from "../config.js";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const schema = quote(config.PGSCHEMA);
// Full reference/parent indexes are intentional: the exporter's partial unique
// indexes exclude empty keys and index ref_key, not _parent_ref_key on table parts.
// Analytics joins cannot in general prove those partial-index predicates.
const indexes: Array<[name: string, table: string, columns: string, predicate?: string, include?: string]> = [
  // Cover the exact analytic fields so selective receipt reads need not fetch
  // multi-gigabyte wide raw heaps. Every receipt consumer uses this eligibility.
  ["analytics_check_date_idx", "document_chek_kkm", "date",
    "deletion_mark IS NOT TRUE AND posted = TRUE",
    "ref_key, magazin_key, vid_operatsii, summa_dokumenta, otchet_o_roznichnyh_prodazhah_key"],
  ["analytics_check_parent_idx", "document_chek_kkm_tovary", '"_parent_ref_key"', undefined,
    "nomenklatura_key, kolichestvo, summa"],
  ["analytics_retail_parent_idx", "document_otchet_o_roznichnyh_prodazhah_tovary", '"_parent_ref_key"'],
  // Keep the existing plain parent index: this separate covering capability
  // avoids wide raw-line heap reads for income, prices and VAT reconciliation.
  ["analytics_retail_parent_cover_idx", "document_otchet_o_roznichnyh_prodazhah_tovary", '"_parent_ref_key"', undefined,
    "nomenklatura_key, kolichestvo, summa, tsena, summa_nds"],
  ["analytics_purchase_parent_idx", "document_postuplenie_tovarov_tovary", '"_parent_ref_key"'],
  ["analytics_retail_ref_idx", "document_otchet_o_roznichnyh_prodazhah", "ref_key"],
  ["analytics_purchase_ref_idx", "document_postuplenie_tovarov", "ref_key"],
  ["analytics_product_ref_idx", "catalog_nomenklatura", "ref_key"],
  ["analytics_store_ref_idx", "catalog_magaziny", "ref_key"],
  ["analytics_retail_date_idx", "document_otchet_o_roznichnyh_prodazhah", "date"],
  ["analytics_balance_period_idx", "accumulation_register_tovary_na_skladah_balance", "balance_period"],
  ["analytics_warehouse_ref_idx", "catalog_sklady", "ref_key"],
  // Net sales and canonical costs use these date-bounded header/parent joins.
  ["analytics_retail_return_parent_idx", "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary", '"_parent_ref_key"'],
  ["analytics_purchase_date_idx", "document_postuplenie_tovarov", "date",
    "deletion_mark IS NOT TRUE AND posted = TRUE", "ref_key"],
  ["analytics_cost_date_idx", "document_ustanovka_sebestoimosti", "date",
    "deletion_mark IS NOT TRUE AND posted = TRUE", "ref_key, magazin_key"],
  ["analytics_cost_parent_idx", "document_ustanovka_sebestoimosti_tovary", '"_parent_ref_key"', undefined,
    "nomenklatura_key, tsena, _parent_line_index"],
  // Unlike partial reference indexes, this predicate is identical to the live
  // cost CTE's eligibility filter; key order supports its latest-record DISTINCT.
  ["analytics_live_store_cost_idx", "information_register_sebestoimost_nomenklatury_record_type",
    "magazin_key, nomenklatura_key, period DESC, line_number DESC",
    "active IS NOT FALSE AND nullif(magazin_key, '') IS NOT NULL AND nomenklatura_key IS NOT NULL AND tsena > 0", "tsena"],
  // Supplier periods, dated payment schedules and linked receipts.
  ["analytics_supplier_order_date_idx", "document_zakaz_postavschiku", "date"],
  ["analytics_supplier_order_ref_idx", "document_zakaz_postavschiku", "ref_key"],
  ["analytics_supplier_stage_parent_idx", "document_zakaz_postavschiku_etapy_oplat", '"_parent_ref_key"'],
  ["analytics_supplier_stage_due_idx", "document_zakaz_postavschiku_etapy_oplat", "data_platezha"],
  ["analytics_purchase_order_date_idx", "document_postuplenie_tovarov", "zakaz_postavschiku_key, date",
    "deletion_mark IS NOT TRUE AND posted = TRUE", "summa_dokumenta"],
  // Loss reports select headers by date before joining their imported lines.
  ["analytics_writeoff_date_idx", "document_spisanie_tovarov", "date"],
  ["analytics_writeoff_parent_idx", "document_spisanie_tovarov_tovary", '"_parent_ref_key"'],
  ["analytics_surplus_date_idx", "document_oprihodovanie_tovarov", "date"],
  ["analytics_surplus_parent_idx", "document_oprihodovanie_tovarov_tovary", '"_parent_ref_key"'],
  ["analytics_revision_date_idx", "document_pereschet_tovarov", "date"],
  ["analytics_revision_parent_idx", "document_pereschet_tovarov_tovary", '"_parent_ref_key"']
];

// These auxiliary table parts are created only when the exporter encounters
// the corresponding nested fields. Core report/cost/header tables remain required.
const optionalTables: Partial<Record<string, true>> = {
  document_zakaz_postavschiku_etapy_oplat: true,
  document_spisanie_tovarov_tovary: true,
  document_oprihodovanie_tovarov_tovary: true,
  document_pereschet_tovarov_tovary: true
};

const apply = process.argv.includes("--apply");
const url = new URL(config.DATABASE_URL);
url.searchParams.set("connection_limit", "1");
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
try {
  if (apply) {
    await db.$executeRawUnsafe("SET lock_timeout = '5s'");
    await db.$executeRawUnsafe("SET statement_timeout = '10min'");
  }
  const availableTables = apply
    ? new Set((await db.$queryRaw<Array<{ table_name: string }>>`
        select c.relname::text as table_name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${config.PGSCHEMA} and c.relkind in ('r', 'p', 'm')
      `).map((row) => row.table_name))
    : null;
  const analyzedTables = new Set<string>();
  for (const [name, table, columns, predicate, include] of indexes) {
    if (availableTables && !availableTables.has(table) && optionalTables[table] === true) {
      console.log(`Skipping ${name}: optional source ${config.PGSCHEMA}.${table} is absent.`);
      continue;
    }
    const sql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quote(name)} ON ${schema}.${quote(table)} (${columns})${include ? ` INCLUDE (${include})` : ""}${predicate ? ` WHERE ${predicate}` : ""}`;
    console.log(sql + ";");
    if (apply) {
      const existing = await db.$queryRaw<Array<{ indisvalid: boolean }>>`
        select i.indisvalid from pg_index i
        join pg_class c on c.oid = i.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${config.PGSCHEMA} and c.relname = ${name}
      `;
      if (existing.some((index) => !index.indisvalid)) {
        throw new Error(`Index ${name} is invalid from an interrupted build; remove that invalid index before retrying.`);
      }
      const start = performance.now();
      await db.$executeRawUnsafe(sql);
      console.log(`Completed in ${Math.round(performance.now() - start)} ms`);
    }
    analyzedTables.add(table);
  }
  for (const table of analyzedTables) {
    const sql = `ANALYZE ${schema}.${quote(table)}`;
    console.log(sql + ";");
    if (apply) await db.$executeRawUnsafe(sql);
  }
} finally {
  await db.$disconnect();
}
