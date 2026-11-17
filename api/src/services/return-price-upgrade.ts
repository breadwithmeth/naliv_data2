import { z } from "zod";

export const RETURN_PRICE_ORIGINAL_CONTRACT_SHA256 = "a6f5f51899a2d2c14508b0203eb3cf0f3a0368f506fb9a0449ad100933a81871";
export const RETURN_PRICE_EFFECTIVE_CONTRACT_SHA256 = "64f140bdcfbb1d5944677d96f9842804199ca8931ffb6fd2b34ea41016c85c54";
export const RETURN_PRICE_TABLE = "document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary";
export const RETURN_PRICE_SOURCE_ENTITY = "Document_ОтчетОРозничныхПродажах";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(`${value}T00:00:00Z`);
  return !value.startsWith("0000-") && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
const timestamp = z.string().datetime({ offset: true }).refine(value => !value.startsWith("0000-") && Number.isFinite(Date.parse(value)));
export const returnPriceUpgradeSchema = z.object({
  version: z.literal(1),
  fromContractSha256: z.literal(RETURN_PRICE_ORIGINAL_CONTRACT_SHA256),
  toContractSha256: z.literal(RETURN_PRICE_EFFECTIVE_CONTRACT_SHA256),
  table: z.literal(RETURN_PRICE_TABLE), column: z.literal("tsena"), workerSourceSha256: sha,
  rangeStart: day, rangeEndExclusive: day, cycleId: uuid, canaryDay: day,
  canaryPasses: z.array(z.object({ sourceSha256: sha, targetSha256: sha }).strict()),
  state: z.enum(["backfilling", "verified"]), appliedAt: timestamp, verifiedAt: timestamp.nullable()
}).strict().refine(upgrade => {
  if (upgrade.rangeStart >= upgrade.rangeEndExclusive || upgrade.canaryDay < upgrade.rangeStart || upgrade.canaryDay >= upgrade.rangeEndExclusive) return false;
  const passes = upgrade.canaryPasses;
  if (passes.length !== 0 && (passes.length !== 2 || passes[0]!.sourceSha256 !== passes[1]!.sourceSha256 || passes[0]!.targetSha256 !== passes[1]!.targetSha256)) return false;
  return upgrade.state === "backfilling" ? upgrade.verifiedAt === null
    : passes.length === 2 && upgrade.verifiedAt !== null && Date.parse(upgrade.verifiedAt) >= Date.parse(upgrade.appliedAt);
});
export type ReturnPriceUpgrade = z.infer<typeof returnPriceUpgradeSchema>;
const upgradeManifestSchema = z.object({
  manifestVersion: z.literal(1), reloadId: uuid, planSha256: sha,
  targetDatabase: z.object({ name: z.literal("nalivdata"), oid: z.literal(1208710) }),
  sourceSchema: z.object({ name: z.literal("raw_1c"), oid: z.literal(1247771) }),
  returnPriceUpgrade: returnPriceUpgradeSchema
});

/** This one additive transition never reinterprets the immutable original plan or its certificates.
 * Verified state additionally requires the consumer to validate the cycle's ledger jobs/evidence. */
export function validReturnPriceUpgrade(manifest: unknown, originalHash: string, effectiveHash: string): boolean {
  return originalHash === RETURN_PRICE_ORIGINAL_CONTRACT_SHA256 && effectiveHash === RETURN_PRICE_EFFECTIVE_CONTRACT_SHA256
    && upgradeManifestSchema.safeParse(manifest).success;
}
