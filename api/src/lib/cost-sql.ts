import { Prisma } from "@prisma/client";
import { config } from "../config.js";

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(tableName: string) {
  return Prisma.raw(`${quoteIdent(config.PGSCHEMA)}.${quoteIdent(tableName)}`);
}

/**
 * Canonical cost hierarchy:
 * 1. latest live store/item record from ``СебестоимостьНоменклатуры``;
 * 2. latest store-specific ``Установка себестоимости`` line;
 * 3. latest network-level cost-setting line;
 * 4. weighted external purchase cost over the preceding 90 days.
 *
 * Missing costs remain NULL. Callers expose coverage instead of replacing an
 * unknown cost with a trusted zero.
 */
export function canonicalItemCostsCtes(asOf?: Date) {
  const liveCosts = qualifiedTable(
    "information_register_sebestoimost_nomenklatury_record_type"
  );
  const costDocuments = qualifiedTable("document_ustanovka_sebestoimosti");
  const costLines = qualifiedTable("document_ustanovka_sebestoimosti_tovary");
  const receiptDocuments = qualifiedTable("document_postuplenie_tovarov");
  const receiptLines = qualifiedTable("document_postuplenie_tovarov_tovary");
  const boundary = asOf ? Prisma.sql`${asOf}` : Prisma.sql`current_timestamp`;

  return Prisma.sql`
    live_store_costs as (
      select distinct on (c.magazin_key, c.nomenklatura_key)
        c.magazin_key,
        c.nomenklatura_key,
        c.tsena::float8 as unit_cost
      from ${liveCosts} c
      where c.active is not false
        and c.period < ${boundary}
        and nullif(c.magazin_key, '') is not null
        and c.nomenklatura_key is not null
        and c.tsena > 0
      order by c.magazin_key, c.nomenklatura_key, c.period desc, c.line_number desc
    ),
    document_store_costs as (
      select distinct on (d.magazin_key, l.nomenklatura_key)
        d.magazin_key,
        l.nomenklatura_key,
        l.tsena::float8 as unit_cost
      from ${costDocuments} d
      join ${costLines} l on l."_parent_ref_key" = d.ref_key
      where d.deletion_mark is not true
        and d.posted = true
        and d.date < ${boundary}
        and nullif(d.magazin_key, '') is not null
        and l.nomenklatura_key is not null
        and l.tsena > 0
      order by d.magazin_key, l.nomenklatura_key, d.date desc, l."_parent_line_index" desc
    ),
    latest_store_costs as (
      select
        coalesce(l.magazin_key, d.magazin_key) as magazin_key,
        coalesce(l.nomenklatura_key, d.nomenklatura_key) as nomenklatura_key,
        coalesce(l.unit_cost, d.unit_cost)::float8 as unit_cost
      from live_store_costs l
      full join document_store_costs d
        on d.magazin_key = l.magazin_key
       and d.nomenklatura_key = l.nomenklatura_key
    ),
    latest_global_costs as (
      select distinct on (l.nomenklatura_key)
        l.nomenklatura_key,
        l.tsena::float8 as unit_cost
      from ${costDocuments} d
      join ${costLines} l on l."_parent_ref_key" = d.ref_key
      where d.deletion_mark is not true
        and d.posted = true
        and d.date < ${boundary}
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
