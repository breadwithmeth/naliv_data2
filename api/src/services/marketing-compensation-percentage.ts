import { Prisma } from "@prisma/client";

type TitlePercentage =
  | { rate: Prisma.Decimal; issue: null }
  | { rate: null; issue: "missing_percentage" | "conflicting_percentage" };

export function parseCompensationTitlePercentage(value: unknown): TitlePercentage {
  const missing = { rate: null, issue: "missing_percentage" } as const;
  const conflicting = { rate: null, issue: "conflicting_percentage" } as const;
  if (typeof value !== "string") return missing;
  let rate: Prisma.Decimal | null = null;
  for (const { index } of value.matchAll(/%/g)) {
    const number = /(\d+(?:[.,]\d+)?)\s*$/u.exec(value.slice(0, index));
    if (!number) return missing;
    const before = value.slice(0, number.index);
    const after = value.slice(index + 1);
    // Reject ranges even if only one endpoint has a percent sign.
    const rangeBefore = /\d\s*%?\s*(?:[\p{Pd}−]|до|по)\s*$/iu;
    const rangeAfter = /^\s*(?:[\p{Pd}−]|до|по)\s*\d/iu;
    if (rangeBefore.test(before) || rangeAfter.test(after)) return conflicting;
    // A three-digit group after a thousands separator is not an independent rate.
    if (/^\d{3}(?:[.,]|$)/u.test(number[1]) && /(?:^|\D)\d{1,3}[\u0020\u00a0\u202f]+$/u.test(before)) return missing;
    if (/[\p{L}\p{N}\p{M}\p{Pd}_.,]$/u.test(before) || /[+−±∓＋－-]\s*$/u.test(before)
      || /^\s*\p{Pd}\s*$/u.test(before) || /^[\p{L}\p{N}\p{M}_]/u.test(after)) return missing;
    const next = new Prisma.Decimal(number[1].replace(",", "."));
    if (!next.isFinite() || next.gt(100)) return missing;
    if (rate !== null && !rate.eq(next)) return conflicting;
    rate = next;
  }
  return rate === null ? missing : { rate, issue: null };
}
