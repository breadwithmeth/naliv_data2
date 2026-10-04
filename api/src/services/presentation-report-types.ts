import type { ComparisonPeriod, YearComparisonReport } from "./year-comparison.js";

export type PresentationReportParams = {
  from: string;
  to: string;
  monthFrom: string;
  monthTo: string;
  city: string[];
};

export type SupplierIncomeReason = "unique" | "multiple-suppliers" | "no-purchase" | "unknown-supplier";

export type SupplierIncomeMetrics = {
  salesRevenue: number;
  estimatedGrossIncome: number | null;
  knownEstimatedGrossIncome: number;
  absoluteQuantity: number;
  unvaluedQuantity: number;
};

export type PresentationSupplier = SupplierIncomeMetrics & {
  period: ComparisonPeriod;
  city: string;
  supplierKey: string;
  supplierName: string;
  internalByTaxId: boolean;
  receiptDocuments: number;
  returnDocuments: number;
  receiptAmount: number | null;
  returnAmount: number | null;
  purchases: number | null;
  cohortPurchases: number | null;
  cohortEstimatedGrossIncome: number | null;
};

export type SupplierIncomeResidual = SupplierIncomeMetrics & {
  period: ComparisonPeriod;
  city: string;
  reason: Exclude<SupplierIncomeReason, "unique">;
  pairCount: number;
};

export type SupplierAttributionAudit = {
  period: ComparisonPeriod;
  sourceStoreKey: string;
  physicalStoreKey: string;
  city: string;
  itemKey: string;
  quantity: number;
  revenue: number;
  absoluteQuantity: number;
  unitCost: number | null;
  costSource: string;
  valuedCost: number | null;
  supplierKey: string | null;
  supplierName: string | null;
  supplierCandidates: string[];
  unknownSupplierLines: number;
  reason: SupplierIncomeReason;
};

export type PurchasingQuality = {
  period: ComparisonPeriod;
  status: "observed" | "partial" | "empty";
  dateFrom: string | null;
  dateTo: string | null;
  sourceDateFrom: string | null;
  sourceDateTo: string | null;
  receiptDocuments: number;
  returnDocuments: number;
  supplierCount: number;
  missingReceiptAmounts: number;
  missingReturnAmounts: number;
  receiptsWithoutLines: number;
  receiptAmount: number | null;
  returnAmount: number | null;
  purchaseLineAmount: number | null;
  documentLineDifference: number | null;
};

export type PresentationReportBlock = {
  sales: YearComparisonReport;
  suppliers: PresentationSupplier[];
  residual: SupplierIncomeResidual[];
  attribution: SupplierAttributionAudit[];
  purchasingQuality: PurchasingQuality[];
};

export type PresentationReport = {
  generatedAt: string;
  params: PresentationReportParams;
  main: PresentationReportBlock;
  detail: PresentationReportBlock;
  methodology: string[];
};
