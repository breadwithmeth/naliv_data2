export type TurnoverMode = "quantity" | "money" | "both";
export type TurnoverProfile = "summary" | "full" | "sample";
export type TurnoverGroup = "sku" | "store" | "category" | "brand" | "day";
export type TurnoverRisk = "all" | "no-sales" | "overstock" | "deficit" | "stagnant";
export type TurnoverSort = "turnover" | "stock-cost" | "no-movement" | "sales-decline" | "name";
export type TurnoverNorms = {
  minDays: number;
  staleDays: number;
  criticalStaleDays: number;
  excessDays: number;
  stopDays: number;
  changePct: number;
  targetDays: number;
  highStockCost: number | null;
  leadTimeDays: number | null;
};
export type TurnoverPolicy = { defaults: TurnoverNorms; categories: Record<string, Partial<TurnoverNorms>> };
export type TurnoverRequest = {
  from: string;
  to: string;
  comparisonFrom?: string;
  comparisonTo?: string;
  /** Physical store keys from /options; legacy catalog keys are resolved. */
  store?: string[];
  /** retail = physical shops with observed retail reports; all = include non-retail departments. */
  storeScope?: "retail" | "all";
  /** Hide only rows whose daily stock and sales are exactly zero for every day. */
  excludeZero?: boolean;
  /** Restore unavailable calculation rows; independent of the exact-zero filter. */
  includeIncomplete?: boolean;
  warehouse?: string;
  category?: string[];
  brand?: string;
  sku?: string;
  search?: string;
  mode?: TurnoverMode;
  groupBy?: TurnoverGroup;
  horizon?: 7 | 14 | 30;
  risk?: TurnoverRisk;
  sort?: TurnoverSort;
  /** summary = standard SKU/name shop layout or analytical main table; full = analytical details. */
  profile?: TurnoverProfile;
  norms?: TurnoverPolicy;
  /** Opaque returned row key for an exact, on-demand daily drilldown. */
  auditGroup?: string;
};
export type TurnoverChange = { pct: number | null; status: "comparable" | "new" | "no-base" | "missing" };
export type TurnoverSales = {
  quantity: number | null;
  cost: number | null;
  revenue: number | null;
  averageDailyQty: number | null;
  averageDailyCost: number | null;
};
export type TurnoverWindow = {
  days: 7 | 14 | 30;
  current: { from: string; to: string };
  previous: { from: string; to: string };
  sales: TurnoverSales;
  previousSales: TurnoverSales;
  quantityChange: TurnoverChange;
  costChange: TurnoverChange;
};
export type TurnoverRecommendation = { code: string; action: string; reason: string };
export type TurnoverDailyRow = {
  date: string;
  unit: string;
  unitKey?: string;
  quantity: number | null;
  stockCost: number | null;
  salesQty: number | null;
  salesCost: number | null;
  revenue: number | null;
  weight: number;
};
export type TurnoverRow = {
  key: string;
  name: string;
  sku: string | null;
  article: string | null;
  barcodes: string[];
  storeKey: string | null;
  storeName: string;
  warehouseKey: string | null;
  warehouseName: string;
  categoryKey: string | null;
  categoryName: string;
  rootGroupKey: string | null;
  rootGroupName: string;
  brandKey: string | null;
  brandName: string;
  unit: string;
  openingQty: number | null;
  closingQty: number | null;
  averageQty: number | null;
  openingCost: number | null;
  closingCost: number | null;
  averageCost: number | null;
  periodSales: TurnoverSales;
  comparisonSales: TurnoverSales;
  quantityChange: TurnoverChange;
  costChange: TurnoverChange;
  windows: TurnoverWindow[];
  turnoverQty: number | null;
  turnoverQtyDays: number | null;
  turnoverCost: number | null;
  turnoverCostDays: number | null;
  stockDays: number | null;
  lastSaleDate: string | null;
  daysWithoutMovement: number | null;
  /** Positive closing stock and no recorded sales, returns or purchases in the verified period. */
  idleStock?: true;
  noSalesHistory: boolean;
  observedDays: number;
  expectedDays: number;
  outOfStockDays: number | null;
  costCoveragePct: number | null;
  excessQty: number | null;
  deficitQty: number | null;
  recommendedOrderQty: number | null;
  openOrderQty: number | null;
  nextDeliveryDate: string | null;
  stagnantCost: { d30: number | null; d60: number | null; d90: number | null };
  risks: Exclude<TurnoverRisk, "all">[];
  recommendations: TurnoverRecommendation[];
  daily: TurnoverDailyRow[];
};
export type TurnoverTotalMetrics = Pick<TurnoverRow,
  "openingQty" | "closingQty" | "averageQty" | "openingCost" | "closingCost" | "averageCost" |
  "periodSales" | "comparisonSales" | "quantityChange" | "costChange" |
  "turnoverQty" | "turnoverQtyDays" | "turnoverCost" | "turnoverCostDays" |
  "stockDays" | "excessQty" | "deficitQty" | "recommendedOrderQty" | "openOrderQty" | "stagnantCost"
>;
export type TurnoverTotal = TurnoverTotalMetrics & { unit: string | null; daily: TurnoverDailyRow[] };
export type TurnoverUnitTotal = TurnoverTotal & { unitKey: string };
export type TurnoverTotals = {
  overall: TurnoverTotal;
  byUnit: TurnoverUnitTotal[];
  byStore: Array<{ storeKey: string | null; total: TurnoverTotal; byUnit: TurnoverUnitTotal[] }>;
};
export type TurnoverOption = { key: string; name: string };
export type TurnoverTransfer = {
  sku: string;
  name: string;
  unit: string;
  fromStoreKey: string;
  fromStoreName: string;
  toStoreKey: string;
  toStoreName: string;
  quantity: number;
};
export type TurnoverReport = {
  params: TurnoverRequest;
  comparison: { from: string; to: string; days: number };
  norms: TurnoverPolicy;
  rows: TurnoverRow[];
  /** Atomic rows excluded for unavailable selected-mode calculation fields. */
  excludedIncompleteRows?: number;
  /** Server already applied the default eligibility rule to atomic rows before aggregation. */
  populationFiltered?: true;
  daily: TurnoverDailyRow[];
  /** Actual table population after every filter, independent of display grouping. */
  totals: TurnoverTotals;
  transfers: TurnoverTransfer[];
  summary: {
    rowCount: number;
    totalRowCount: number;
    stagnantCount: number;
    skuCount: number;
    stockCost: number | null;
    noSalesCount: number;
    overstockCount: number;
    deficitCount: number;
    frozen30Cost: number | null;
    frozen60Cost: number | null;
    frozen90Cost: number | null;
    costCoveragePct: number | null;
    stockCoveragePct: number;
  };
  options: {
    stores: TurnoverOption[];
    warehouses: (TurnoverOption & { storeKey: string | null })[];
    categories: TurnoverOption[];
    brands: TurnoverOption[];
    skus: TurnoverOption[];
  };
  coverage: {
    firstStockDate: string | null;
    lastStockDate: string | null;
    firstSalesDate: string | null;
    lastSalesDate: string | null;
    missingStockDates: string[];
    /** Exclusive end the caller asked for when the analysed period was shortened to certified days. */
    requestedTo: string | null;
    observedDays: number;
    expectedDays: number;
  };
  methodology: string[];
  warnings: string[];
  generatedAt: string;
};

export type TurnoverPreviewRow = Pick<TurnoverRow,
  "key" | "name" | "sku" | "article" | "storeKey" | "storeName" | "categoryName" | "rootGroupKey" | "rootGroupName" | "unit" |
  "noSalesHistory" | "idleStock" | "openingQty" | "closingQty" | "averageQty" |
  "openingCost" | "closingCost" | "averageCost" | "periodSales" |
  "turnoverQty" | "turnoverQtyDays" | "turnoverCost" | "turnoverCostDays" |
  "stockDays" | "risks" | "daily"
> & { primaryAction: string | null };
export type TurnoverPreview = Omit<TurnoverReport, "rows"> & { rows: TurnoverPreviewRow[] };
export type TurnoverRowDetail = { row: TurnoverRow; generatedAt: string };
export type TurnoverOptions = {
  stores: TurnoverOption[];
  warehouses: (TurnoverOption & { storeKey: string | null })[];
  categories: TurnoverOption[];
  brands: TurnoverOption[];
};
