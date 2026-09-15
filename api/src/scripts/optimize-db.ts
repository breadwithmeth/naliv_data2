import { PrismaClient } from "@prisma/client";
import { config } from "../config.js";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const schema = quote(config.PGSCHEMA);
// Full indexes are intentional: the exporter's partial unique indexes exclude
// empty keys (and index ref_key, not _parent_ref_key on imported table parts).
// Analytics joins cannot in general prove those partial-index predicates.
const indexes = [
  ["analytics_retail_parent_idx", "document_otchet_o_roznichnyh_prodazhah_tovary", '"_parent_ref_key"'],
  ["analytics_purchase_parent_idx", "document_postuplenie_tovarov_tovary", '"_parent_ref_key"'],
  ["analytics_retail_ref_idx", "document_otchet_o_roznichnyh_prodazhah", "ref_key"],
  ["analytics_purchase_ref_idx", "document_postuplenie_tovarov", "ref_key"],
  ["analytics_product_ref_idx", "catalog_nomenklatura", "ref_key"],
  ["analytics_store_ref_idx", "catalog_magaziny", "ref_key"],
  ["analytics_retail_date_idx", "document_otchet_o_roznichnyh_prodazhah", "date"],
  ["analytics_balance_period_idx", "accumulation_register_tovary_na_skladah_balance", "balance_period"]
] as const;

const apply = process.argv.includes("--apply");
const url = new URL(config.DATABASE_URL);
url.searchParams.set("connection_limit", "1");
const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
try {
  if (apply) {
    await db.$executeRawUnsafe("SET lock_timeout = '5s'");
    await db.$executeRawUnsafe("SET statement_timeout = '10min'");
  }
  for (const [name, table, columns] of indexes) {
    const sql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quote(name)} ON ${schema}.${quote(table)} (${columns})`;
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
  }
  for (const table of new Set(indexes.map(([, table]) => table))) {
    const sql = `ANALYZE ${schema}.${quote(table)}`;
    console.log(sql + ";");
    if (apply) await db.$executeRawUnsafe(sql);
  }
} finally {
  await db.$disconnect();
}
