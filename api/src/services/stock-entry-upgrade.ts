import { createHash } from "node:crypto";
import { z } from "zod";
import { businessToday } from "../lib/business-day.js";
import {
  RETURN_PRICE_EFFECTIVE_CONTRACT_SHA256, returnPriceUpgradeSchema, validReturnPriceUpgrade
} from "./return-price-upgrade.js";

export const STOCK_ENTRY_EFFECTIVE_CONTRACT_SHA256 = "43c6ce8d697b88bb8782ac39cfa777cacefa95267c8af95c1d49501d228d8e54";
export const STOCK_ENTRY_PARENT = "document_oprihodovanie_tovarov";
export const STOCK_ENTRY_TABLE = `${STOCK_ENTRY_PARENT}_tovary`;
export const STOCK_ENTRY_SOURCE_ENTITY = "Document_ОприходованиеТоваров";
export const STOCK_ENTRY_COLUMNS = ["nomenklatura_key", "harakteristika_key", "kolichestvo", "tsena"] as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().datetime({ offset: true }).refine(value =>
  !value.startsWith("0000-") && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(`${value}T00:00:00Z`);
  return !value.startsWith("0000-") && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
const skuUuid = z.string().uuid().refine(value => value === value.toLowerCase() && value !== "00000000-0000-0000-0000-000000000000");

const stockEntryUpgradeSchema = z.object({
  version: z.literal(1),
  fromContractSha256: z.literal(RETURN_PRICE_EFFECTIVE_CONTRACT_SHA256),
  toContractSha256: z.literal(STOCK_ENTRY_EFFECTIVE_CONTRACT_SHA256),
  table: z.literal(STOCK_ENTRY_TABLE),
  columns: z.object({
    nomenklatura_key: z.literal("text"), harakteristika_key: z.literal("text"),
    kolichestvo: z.literal("numeric"), tsena: z.literal("numeric")
  }).strict(),
  previousWorkerSourceSha256: sha,
  workerSourceSha256: sha,
  appliedAt: timestamp
}).strict();
const stockEntryBackfillSchema = z.object({
  version: z.literal(1), verifiedAt: timestamp, throughId: count, documents: count, lines: count, orphanLines: count,
  nullCounts: z.object({ nomenklatura_key: count, harakteristika_key: count, kolichestvo: count, tsena: count }).strict(),
  valuesSha256: sha
}).strict().refine(proof => (proof.throughId === 0) === (proof.documents === 0)
  && proof.documents <= proof.throughId && (proof.documents > 0 || proof.lines === 0)
  && Object.values(proof.nullCounts).every(nulls => nulls <= proof.lines));
const receiptProofSchema = z.object({
  from: calendarDay, toExclusive: calendarDay, sourceSha256: sha, targetSha256: sha, verifiedAt: timestamp
}).strict();
const upgrades = z.object({
  reloadId: z.unknown(), returnPriceUpgrade: z.unknown(), stockEntryCostUpgrade: z.unknown(), stockEntryCostBackfill: z.unknown()
});
type ContractBinding = "native" | "return-price" | "stock-entry-prepared" | "stock-entry-verified";
export type StockEntryHistoricalReceiptCoverage = ReadonlyArray<{ sku: string; from: string; toExclusive: string }>;

/** Independent of ordinary supplier-source coverage: each proof is only for the
 * stock-entry valuation of one SKU on the accepted historical writer generation. */
export function parseStockEntryReceiptProofs(manifest: unknown, binding: ContractBinding, from: string):
  { coverage: StockEntryHistoricalReceiptCoverage; sha256: string } | null | undefined {
  if (!manifest || typeof manifest !== "object" || !("stockEntryReceiptProofs" in manifest) ||
      manifest.stockEntryReceiptProofs === undefined) return undefined;
  const value = manifest.stockEntryReceiptProofs;
  if (binding !== "stock-entry-verified" || !value || typeof value !== "object" || Array.isArray(value) ||
      !("stockEntryCostBackfill" in manifest)) return null;
  const backfill = stockEntryBackfillSchema.safeParse(manifest.stockEntryCostBackfill);
  const skus = Object.keys(value).sort();
  if (!backfill.success || skus.length > 256) return null;
  const today = businessToday();
  const digest = createHash("sha256");
  const coverage: Array<{ sku: string; from: string; toExclusive: string }> = [];
  for (const sku of skus) {
    if (!skuUuid.safeParse(sku).success) return null;
    const proof = receiptProofSchema.safeParse(Object.getOwnPropertyDescriptor(value, sku)?.value);
    if (!proof.success) return null;
    const { from: start, toExclusive, sourceSha256, targetSha256, verifiedAt } = proof.data;
    if (start < from || start >= toExclusive || Date.parse(toExclusive) - Date.parse(start) > 366 * 86_400_000 ||
        sourceSha256 !== targetSha256 || !atOrAfter(verifiedAt, backfill.data.verifiedAt) ||
        toExclusive > today || toExclusive > businessToday(new Date(verifiedAt))) return null;
    digest.update(JSON.stringify([sku, start, toExclusive, sourceSha256, targetSha256, verifiedAt])).update("\n");
    coverage.push({ sku, from: start, toExclusive });
  }
  return { coverage, sha256: digest.digest("hex") };
}

function atOrAfter(candidate: string, previous: string): boolean {
  const milliseconds = Date.parse(candidate) - Date.parse(previous);
  // Producer certificates use Python's microsecond resolution, not Date's millisecond resolution.
  const submillis = (value: string) => (/\.(\d+)/.exec(value)?.[1] ?? "").padEnd(6, "0").slice(3, 6);
  return milliseconds > 0 || (milliseconds === 0 && submillis(candidate) >= submillis(previous));
}

/** Mirrors naliv_data1's authorized additive edges, not a general contract override.
 * Both readers still validate parent identity; readiness also rechecks predecessor job evidence. */
export function reloadContractBinding(manifest: unknown, originalHash: string, effectiveHash: string, originalWorkerHash: string | undefined): ContractBinding | null {
  const parsed = upgrades.safeParse(manifest ?? {});
  if (!parsed.success) return null;
  const { returnPriceUpgrade, stockEntryCostUpgrade, stockEntryCostBackfill, reloadId } = parsed.data;
  if (stockEntryCostUpgrade === undefined) {
    if (stockEntryCostBackfill !== undefined) return null;
    if (returnPriceUpgrade === undefined) return originalHash === effectiveHash ? "native" : null;
    return validReturnPriceUpgrade(manifest, originalHash, effectiveHash) ? "return-price" : null;
  }
  if (effectiveHash !== STOCK_ENTRY_EFFECTIVE_CONTRACT_SHA256 || !validReturnPriceUpgrade(manifest, originalHash, RETURN_PRICE_EFFECTIVE_CONTRACT_SHA256)) return null;
  const stock = stockEntryUpgradeSchema.safeParse(stockEntryCostUpgrade);
  const predecessor = returnPriceUpgradeSchema.parse(returnPriceUpgrade);
  if (!stock.success || predecessor.state !== "verified" || !predecessor.verifiedAt ||
      !timestamp.safeParse(predecessor.verifiedAt).success || predecessor.cycleId === reloadId ||
      stock.data.previousWorkerSourceSha256 !== originalWorkerHash ||
      stock.data.previousWorkerSourceSha256 !== predecessor.workerSourceSha256 ||
      stock.data.workerSourceSha256 === stock.data.previousWorkerSourceSha256 ||
      !atOrAfter(stock.data.appliedAt, predecessor.verifiedAt)) return null;
  if (stockEntryCostBackfill === undefined) return "stock-entry-prepared";
  const proof = stockEntryBackfillSchema.safeParse(stockEntryCostBackfill);
  return proof.success && atOrAfter(proof.data.verifiedAt, stock.data.appliedAt) ? "stock-entry-verified" : null;
}
