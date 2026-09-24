import { Prisma } from "@prisma/client";
import { config } from "../config.js";

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(tableName: string) {
  return Prisma.raw(`${quoteIdent(config.PGSCHEMA)}.${quoteIdent(tableName)}`);
}

/**
 * Cost hierarchy from the management metric specification:
 * 1. latest store-specific "Установка себестоимости";
 * 2. latest network-level cost-setting value for the item;
 * 3. weighted purchase cost excluding recorded VAT over the preceding 90 days.
 *
 * The caller joins these CTEs in that order. Missing costs remain NULL; callers
 * must expose coverage instead of silently treating missing valuation as zero.
 */
export function canonicalItemCostsCtes(asOf?: Date) {
  const costDocuments = qualifiedTable("document_ustanovka_sebestoimosti");
  const costLines = qualifiedTable("document_ustanovka_sebestoimosti_tovary");
  const receiptDocuments = qualifiedTable("document_postuplenie_tovarov");
  const receiptLines = qualifiedTable("document_postuplenie_tovarov_tovary");
  const boundary = asOf ? Prisma.sql`${asOf}` : Prisma.sql`current_timestamp`;

  return Prisma.sql`
    latest_store_costs as (
      select distinct on (d.magazin_key, l.nomenklatura_key)
        d.magazin_key,
        l.nomenklatura_key,
        l.tsena::float8 as unit_cost
      from ${costDocuments} d
      join ${costLines} l on l."_parent_ref_key" = d.ref_key
      where d.deletion_mark is not true
        and d.posted = true
        and nullif(d.magazin_key, '') is not null
        and l.nomenklatura_key is not null
        and l.tsena > 0
      order by d.magazin_key, l.nomenklatura_key, d.date desc, l."_parent_line_index" desc
    ),
    latest_global_costs as (
      select distinct on (l.nomenklatura_key)
        l.nomenklatura_key,
        l.tsena::float8 as unit_cost
      from ${costDocuments} d
      join ${costLines} l on l."_parent_ref_key" = d.ref_key
      where d.deletion_mark is not true
        and d.posted = true
        and l.nomenklatura_key is not null
        and l.tsena > 0
      order by l.nomenklatura_key, d.date desc, l."_parent_line_index" desc
    ),
    purchase_costs_90d as (
      select
        l.nomenklatura_key,
        (
          sum(coalesce(l.summa, 0) - coalesce(l.summa_nds, 0))
          / nullif(sum(l.kolichestvo), 0)
        )::float8 as unit_cost
      from ${receiptDocuments} d
      join ${receiptLines} l on l."_parent_ref_key" = d.ref_key
      where d.deletion_mark is not true
        and d.posted = true
        and d.date >= (${boundary} - interval '90 days')
        and d.date < ${boundary}
        and l.nomenklatura_key is not null
        and l.kolichestvo > 0
        and l.summa > 0
      group by l.nomenklatura_key
    )
  `;
}
