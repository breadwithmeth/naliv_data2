import { Prisma } from "@prisma/client";
import { config } from "../config.js";

function quoteIdent(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedTable(tableName: string) {
  return Prisma.raw(`${quoteIdent(config.PGSCHEMA)}.${quoteIdent(tableName)}`);
}

/**
 * Single source of truth for the handbook loss definition:
 * «Потери = Списания + недостачи ревизий − оприходования − излишки ревизий»
 * (Справочник метрик Naliv 1, раздел 1 «Потери», карточки 6.5 и 7 строка 3).
 *
 * Emits one row per source family/store/exact movement timestamp, not per document:
 *   store_key, movement_date, writeoffs, surpluses
 * Consumers aggregate by store and/or by period bucket.
 */
export function lossMovementsCtes(params: { from?: Date; to?: Date }) {
  const writeoffDocuments = qualifiedTable("document_spisanie_tovarov");
  const writeoffLines = qualifiedTable("document_spisanie_tovarov_tovary");
  const surplusDocuments = qualifiedTable("document_oprihodovanie_tovarov");
  const surplusLines = qualifiedTable("document_oprihodovanie_tovarov_tovary");
  const revisionDocuments = qualifiedTable("document_pereschet_tovarov");
  const revisionLines = qualifiedTable("document_pereschet_tovarov_tovary");

  const filters: Prisma.Sql[] = [
    Prisma.sql`d.date is not null`,
    Prisma.sql`d.deletion_mark is not true`,
    Prisma.sql`d.posted = true`
  ];
  if (params.from) {
    filters.push(Prisma.sql`d.date >= ${params.from}`);
  }
  if (params.to) {
    filters.push(Prisma.sql`d.date < ${params.to}`);
  }
  const whereSql = Prisma.join(filters, " and ");

  return Prisma.sql`
    writeoff_documents as (
      select
        coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
        d.date as movement_date,
        sum(coalesce(l.summa, 0))::float8 as amount
      from ${writeoffDocuments} d
      join ${writeoffLines} l on l."_parent_ref_key" = d.ref_key
      where ${whereSql}
      group by 1, 2
    ),
    surplus_documents as (
      select
        coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
        d.date as movement_date,
        sum(coalesce(l.summa, 0))::float8 as amount
      from ${surplusDocuments} d
      join ${surplusLines} l on l."_parent_ref_key" = d.ref_key
      where ${whereSql}
      group by 1, 2
    ),
    revision_item_differences as (
      select distinct on (d.ref_key, l.nomenklatura_key)
        coalesce(nullif(d.magazin_key, ''), 'Без магазина') as store_key,
        d.date as movement_date,
        (l.summa_fakt - coalesce(l.summa, 0))::float8 as difference
      from ${revisionDocuments} d
      join ${revisionLines} l on l."_parent_ref_key" = d.ref_key
      where ${whereSql}
        and d.uchetnye_dannye_zapolneny is true
        and l.summa_fakt is not null
      order by d.ref_key, l.nomenklatura_key, l.line_number desc
    ),
    revision_documents as (
      select
        store_key,
        movement_date,
        coalesce(sum(-difference) filter (where difference < 0), 0)::float8 as shortages,
        coalesce(sum(difference) filter (where difference > 0), 0)::float8 as excess
      from revision_item_differences
      group by 1, 2
    ),
    loss_movements as (
      select store_key, movement_date, amount as writeoffs, 0::float8 as surpluses
      from writeoff_documents
      union all
      select store_key, movement_date, 0::float8 as writeoffs, amount as surpluses
      from surplus_documents
      union all
      select store_key, movement_date, shortages as writeoffs, excess as surpluses
      from revision_documents
    )
  `;
}
