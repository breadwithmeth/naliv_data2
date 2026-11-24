import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { ReloadReadinessState } from "./reload-readiness.js";

export const PURCHASE_PRICE_SOURCES = {
  types: "catalog_vidy_tsen",
  documents: "document_ustanovka_tsen_nomenklatury",
  lines: "document_ustanovka_tsen_nomenklatury_tovary"
} as const;

const localTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/).refine(s => {
  const parsed = new Date(`${s}Z`);
  return s.slice(0, 4) !== "0000" && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === s.slice(0, 10);
});
const key = z.string().min(1).max(100);
const scopeSchema = z.object({
  priceTypeKey: key, itemKey: key, characteristicKey: key.nullable(), packagingKey: z.null(),
  documentKeys: z.array(key).nonempty().refine(keys => keys.every((value, i) => i === 0 || keys[i - 1] < value)).readonly(),
  effectiveAt: localTimestamp, verifiedThroughExclusive: localTimestamp, currency: z.literal("KZT"),
  price: z.string().max(100).regex(/^\d+(?:\.\d+)?$/)
});
const evidenceSchema = z.object({ version: z.literal(2), scopes: z.array(z.unknown()) });
export type PurchasePriceEvidenceSnapshot = {
  readonly binding: string;
  readonly scopes: readonly Readonly<z.infer<typeof scopeSchema>>[];
};
const unavailable: PurchasePriceEvidenceSnapshot = { binding: "unavailable", scopes: [] };

/** Offline reconciliation confirms active base-package register history and KZT for the exact scope. */
export function decodePurchasePriceEvidence(bytes: Buffer | string): PurchasePriceEvidenceSnapshot {
  try {
    const evidence = evidenceSchema.safeParse(JSON.parse(bytes.toString()));
    if (!evidence.success) return unavailable;
    const scopes = evidence.data.scopes.flatMap(value => {
      const scope = scopeSchema.safeParse(value);
      return scope.success ? [scope.data] : [];
    });
    return scopes.length ? { binding: createHash("sha256").update(bytes).digest("hex"), scopes } : unavailable;
  } catch {
    return unavailable;
  }
}

export async function loadPurchasePriceEvidence(): Promise<PurchasePriceEvidenceSnapshot> {
  try {
    return decodePurchasePriceEvidence(await readFile(process.env.COMPENSATION_PURCHASE_PRICE_EVIDENCE_PATH ?? "var/compensation-purchase-price-evidence.json"));
  } catch {
    return unavailable;
  }
}

export function verifiedCompensationCoverage(
  sources: ReloadReadinessState["coverageSources"] | undefined, kind: "prices" | "retail", tables: readonly string[]
) {
  const entry = sources?.find(s => s.source.key === kind && s.source.kind === "dated" && !s.source.unavailable
    && tables.every(table => s.source.tables.includes(table)));
  const floor = entry?.source.floor;
  const merged: Array<{ from: string; to: string }> = [];
  if (!entry || !floor) return merged;
  // Jobs are sorted by start in reload readiness. Combine neighboring verified days, never bridge gaps.
  for (const interval of entry.intervals) {
    const from = interval.from < floor ? floor : interval.from;
    if (interval.to <= from) continue;
    const previous = merged.at(-1);
    if (!previous || previous.to < from) merged.push({ from, to: interval.to });
    else if (previous.to < interval.to) previous.to = interval.to;
  }
  return merged;
}

type PurchasePriceContext = {
  table: (name: string) => Prisma.Sql;
  stores: string;
  available: Set<string>;
  zero: string;
  itemKeys: Set<string>;
  from: string;
  to: string;
  coverageSources: ReloadReadinessState["coverageSources"] | undefined;
  evidence: PurchasePriceEvidenceSnapshot;
};

/** The matched CTE already enforces activity and movement scopes; resolve each exact temporal key once. */
export function purchasePriceCte({ table, stores, available, zero, itemKeys, from, to, coverageSources, evidence }: PurchasePriceContext) {
  const { types, documents, lines } = PURCHASE_PRICE_SOURCES;
  if (!available.has(types) || !available.has(documents) || !available.has(lines)) return Prisma.sql`
    priced as (
      select matched.*, null::numeric as known_price, false as unverified_return, false as missing_price,
        'purchase_price_unverified'::text as purchase_price_issue
      from matched
    )`;
  const coverage = verifiedCompensationCoverage(coverageSources, "prices", [documents, lines]);
  const scopes = evidence.scopes.filter(s => itemKeys.has(s.itemKey) && s.effectiveAt.slice(0, 10) < to && s.verifiedThroughExclusive.slice(0, 10) >= from);
  return Prisma.sql`
    purchase_store_types as materialized (
      select s.ref_key, t.ref_key as price_type
      from (select distinct magazin_key from matched) m
      join ${table(stores)} s on s.ref_key = m.magazin_key and s.deletion_mark is not true
      join ${table(types)} t on t.ref_key = (to_jsonb(s)->>'vid_tsen_zakupa_key')
        -- 1C's non-hierarchical price-type catalog omits IsFolder; NULL is normal in the replica.
        and t.ref_key not in ('', ${zero}) and t.deletion_mark is false and t.is_folder is not true
    ),
    purchase_movement_keys as materialized (
      select distinct m.magazin_key, m.nomenklatura_key, coalesce(m.characteristic, '') as characteristic,
        m.date, s.price_type
      from matched m left join purchase_store_types s on s.ref_key = m.magazin_key
    ),
    purchase_price_keys as materialized (
      select distinct price_type, nomenklatura_key, characteristic
      from purchase_movement_keys where price_type is not null
    ),
    purchase_price_lines as materialized (
      select l.vid_tseny_key as price_type, l.nomenklatura_key,
        coalesce(nullif(l.harakteristika_key, ${zero}), '') as characteristic,
        coalesce(l._parent_ref_key, l.ref_key) as document_key, l.tsena
      from ${table(lines)} l
      where exists (select 1 from purchase_price_keys)
        and coalesce(nullif(l.upakovka_key, ''), ${zero}) = ${zero}
        -- A hashed membership filter keeps the unindexed history scan outside the per-key join.
        and ((l.vid_tseny_key, l.nomenklatura_key, coalesce(nullif(l.harakteristika_key, ${zero}), ''))
          in (select price_type, nomenklatura_key, characteristic from purchase_price_keys)) is true
    ),
    purchase_price_changes as (
      select l.price_type, l.nomenklatura_key, l.characteristic, d.date as effective_at,
        array_agg(distinct d.ref_key) as document_keys,
        count(distinct l.tsena) > 1 as conflicting,
        case when count(distinct l.tsena) = 1 and bool_and(l.tsena is not null and l.tsena > 0 and l.tsena::text not in ('NaN','Infinity','-Infinity'))
          then min(l.tsena) end as candidate_price
      from purchase_price_lines l
      join ${table(documents)} d on d.ref_key = l.document_key
        and d.posted is true and d.deletion_mark is not true
        and d.date <= (select max(date) from purchase_movement_keys where price_type is not null)
      group by l.price_type, l.nomenklatura_key, l.characteristic, d.date
    ),
    purchase_price_intervals as materialized (
      select p.*, lead(effective_at) over (partition by price_type, nomenklatura_key, characteristic order by effective_at) as next_at
      from purchase_price_changes p
    ),
    purchase_price_coverage as (
      select * from jsonb_to_recordset(${JSON.stringify(coverage)}::jsonb) as c("from" date, "to" date)
    ),
    purchase_price_evidence as (
      select * from jsonb_to_recordset(${JSON.stringify(scopes)}::jsonb) as e(
        "priceTypeKey" text, "itemKey" text, "characteristicKey" text, "documentKeys" text[],
        "effectiveAt" timestamp, price numeric, "verifiedThroughExclusive" timestamp
      )
    ),
    purchase_resolution as materialized (
      select k.*, p.candidate_price,
        case when k.price_type is null then 'missing_purchase_price_type'
          when p.conflicting then 'ambiguous_purchase_price'
          when p.effective_at is not null and p.candidate_price is null then 'missing_purchase_price'
          when not exists (select 1 from purchase_price_coverage c
            where c."from" <= coalesce(p.effective_at::date, k.date::date) and k.date::date < c."to") then 'purchase_price_unverified'
          when p.effective_at is null then 'missing_purchase_price'
          when not exists (select 1 from purchase_price_evidence e
            where e."priceTypeKey" = k.price_type and e."itemKey" = k.nomenklatura_key
              and coalesce(nullif(e."characteristicKey", ${zero}), '') = k.characteristic
              and e."effectiveAt" = p.effective_at and e."documentKeys" @> p.document_keys and p.document_keys @> e."documentKeys"
              and e.price = p.candidate_price and k.date < e."verifiedThroughExclusive") then 'purchase_price_unverified'
        end as purchase_price_issue
      from purchase_movement_keys k left join purchase_price_intervals p
        on p.price_type = k.price_type and p.nomenklatura_key = k.nomenklatura_key and p.characteristic = k.characteristic
        and p.effective_at <= k.date and (p.next_at is null or k.date < p.next_at)
    ),
    priced as (
      select m.*, case when p.purchase_price_issue is null then p.candidate_price end as known_price,
        false as unverified_return, false as missing_price, p.purchase_price_issue
      from matched m join purchase_resolution p on p.magazin_key = m.magazin_key and p.nomenklatura_key = m.nomenklatura_key
        and p.characteristic = coalesce(m.characteristic, '') and p.date = m.date
    )`;
}
