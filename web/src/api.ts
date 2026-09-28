export type User = {
  email: string;
  role: "admin" | "marketing";
};

export type DbTable = {
  name: string;
  kind: string;
  estimatedRows: number;
  totalBytes: number;
};

export type DataGroupKey =
  | "documents"
  | "documentLines"
  | "catalogs"
  | "balances"
  | "other";

export type DataGroup = {
  key: DataGroupKey;
  tableCount: number;
  estimatedRows: number;
  totalBytes: number;
  columnCount: number;
  numericColumnCount: number;
  temporalColumnCount: number;
  sampleTables: string[];
};

export type DbColumn = {
  name: string;
  dataType: string;
  nullable: boolean;
  isNumeric: boolean;
  isTemporal: boolean;
  isText: boolean;
};

export type Overview = {
  schema: string;
  tableCount: number;
  estimatedRows: number;
  totalBytes: number;
  columnCount: number;
  numericColumnCount: number;
  temporalColumnCount: number;
  largestTables: DbTable[];
  tables: DbTable[];
  dataGroups: DataGroup[];
  serviceFieldCoverage: Array<{
    name: string;
    tableCount: number;
  }>;
};

export type TableProfile = {
  table?: DbTable;
  columns: DbColumn[];
  sampleRows: Record<string, unknown>[];
  numericSummaries: Array<{
    column: string;
    min: unknown;
    max: unknown;
    avg: number | null;
    filled: number;
  }>;
  temporalSummaries: Array<{
    column: string;
    min: string | null;
    max: string | null;
    filled: number;
  }>;
  topValues: Array<{
    column: string;
    values: Array<{ value: string | null; count: number }>;
  }>;
};

export type SyncRunChunk = {
  kind: string;
  start: string;
  end_exclusive: string;
  documents_only: boolean;
  exit_code: number;
  rows_read: number | null;
  rows_written: number | null;
  seconds: number | null;
};

export type SyncRun = {
  id: number;
  started_at: string | null;
  finished_at: string | null;
  status: string | null;
  exit_code: number | null;
  mode: string | null;
  error_class: string | null;
  range_start: string | null;
  range_end_exclusive: string | null;
  chunks_planned: number | null;
  chunks_completed: number | null;
  lookback_days: number | null;
  catchup_chunk_days: number | null;
  checkpoint_before: string | null;
  checkpoint_after: string | null;
  coverage_started_at: string | null;
  rows_read: number | null;
  rows_written: number | null;
  skipped_entities: number | null;
  restricted_optional_entities: number | null;
  deep_reread_status: string | null;
  deep_reread_month: string | null;
  duration_seconds: number | null;
  command: string | null;
  per_chunk: SyncRunChunk[];
  sync_source_sha256: string | null;
  log_file: string | null;
  metrics_file: string | null;
  log_tail: string | null;
};

export type SyncTableFreshness = {
  group: string;
  table: string;
  rows: number;
  changes: number;
  lastChangeUtc: string | null;
  ageHours: number | null;
  unchangedForOverTwoDays: boolean;
};

export type SyncSchedulerStatus = {
  status: string | null;
  updatedAtUtc: string | null;
  serviceStartedAt: string | null;
  lastDecision: string | null;
  lastReason: string | null;
  lastDecisionAt: string | null;
  lastDetail: string | null;
  nextBypassAllowedAt: string | null;
  nextRunAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  timezone: string | null;
  runOnStartup: boolean | null;
  ignoreWindow: boolean | null;
  minIntervalHours: number | null;
  heartbeatSeconds: number | null;
  syncSourceSha256: string | null;
  logTail: string | null;
};

export type SyncHealth = {
  available: boolean;
  unavailableReason: string | null;
  generatedAtUtc: string;
  staleAfterHours: number;
  schema: string;
  latest: SyncRun | null;
  runs: SyncRun[];
  scheduler: SyncSchedulerStatus | null;
  schedulerUnavailableReason: string | null;
  groups: Array<{ title: string; tables: SyncTableFreshness[] }>;
};

export type TimeSeriesPoint = {
  bucket: string;
  metric: number;
};

export type SalesPeriod = "day" | "week" | "month";

export type ReportDateRange = {
  from?: string;
  to?: string;
};

export type ReportRequest = ReportDateRange & {
  period: SalesPeriod;
  storeLimit?: number;
};

export type SalesReport = {
  period: SalesPeriod;
  summary: {
    dateFrom: string | null;
    dateTo: string | null;
    grossRevenue: number;
    returns: number;
    revenue: number;
    orderCount: number;
    returnCount: number;
    avgCheck: number;
    avgItemsPerCheck: number;
    reportCount: number;
    coveredDays: number;
    expectedDays: number | null;
    checkCoveragePct: number | null;
    checkStatus: "ready" | "partial";
  };
  revenueSeries: Array<{
    bucket: string;
    grossRevenue: number;
    returns: number;
    revenue: number;
    orderCount: number;
    returnCount: number;
    avgCheck: number;
    avgItemsPerCheck: number;
  }>;
  composition: Array<{
    itemKey: string;
    itemName: string;
    quantity: number;
    revenue: number;
    checkCount: number;
    checkSharePct: number;
  }>;
  heatmap: {
    days: string[];
    hours: number[];
    stores: Array<{
      key: string;
      name: string;
      revenue: number;
      orderCount: number;
    }>;
    cells: Array<{
      day: string;
      storeKey: string;
      hour: number;
      revenue: number;
      orderCount: number;
      intensity: number;
    }>;
  };
  reconciliation: {
    checkRevenue: number;
    retailReportRevenue: number;
    difference: number | null;
    comparable: boolean;
    retailReportDays: number;
    retailReportCoveragePct: number;
    linkedCheckCount: number;
    loadedCheckCount: number;
    linkedCheckPct: number;
  };
  source: "Document_ЧекККМ";
};

export type IncomeReport = {
  period: SalesPeriod;
  summary: {
    dateFrom: string | null;
    dateTo: string | null;
    revenue: number;
    cost: number;
    grossProfit: number;
    marginPct: number;
    costCoveragePct: number;
    unvaluedRevenue: number;
  };
  incomeSeries: Array<{
    bucket: string;
    revenue: number;
    cost: number;
    grossProfit: number;
    marginPct: number;
    costCoveragePct: number;
  }>;
  stores: Array<{
    key: string;
    name: string;
    revenue: number;
    cost: number;
    grossProfit: number;
    marginPct: number;
  }>;
  items: Array<{
    key: string;
    name: string;
    soldQty: number;
    revenue: number;
    cost: number;
    grossProfit: number;
    marginPct: number;
  }>;
  storeItems: Array<{
    storeKey: string;
    storeName: string;
    itemKey: string;
    itemName: string;
    soldQty: number;
    revenue: number;
    cost: number;
    grossProfit: number;
    marginPct: number;
  }>;
};

export type ItemAnalysis = {
  key: string;
  name: string;
  qty: number;
  revenue: number;
  cost: number | null;
  grossProfit: number | null;
  marginPct: number | null;
  costAvailable: boolean;
  unvaluedRevenue: number;
  abcClass: string;
  xyzClass: string;
  cvPct: number;
  salesVelocity: number;
  daysWithSales: number;
  daysWithoutSales: number;
  firstSaleDate: string | null;
  lastSaleDate: string | null;
  ageCategory: "new" | "regular" | "old";
  revenuePct: number;
};

export type ExitProductReason =
  | "no_sales"
  | "dead_stock"
  | "slow_moving"
  | "overstock";

export type ExitProduct = {
  key: string;
  name: string;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  warehouseCount: number;
  recentSoldQty: number;
  recentRevenue: number;
  dailySalesRate: number;
  daysOfStock: number | null;
  stockCost: number | null;
  frozenStockCost: number | null;
  costAvailable: boolean;
  lastSaleDate: string | null;
  lastPurchaseDate: string | null;
  stockPeriod: string | null;
  daysSinceLastSale: number | null;
  daysSinceLastPurchase: number | null;
  reason: ExitProductReason;
};

export type NomenclatureReport = {
  period: SalesPeriod;
  items: ItemAnalysis[];
  exitItems: ExitProduct[];
  exitSummary: {
    totalItems: number;
    stockQty: number;
    stockCost: number;
    frozenStockCost: number;
    unvaluedQty: number;
    costCoveragePct: number;
    noSalesCount: number;
    deadStockCount: number;
    slowMovingCount: number;
    overstockCount: number;
    stockPeriod: string | null;
  };
  totalDays: number;
  costCoveragePct: number;
  unvaluedRevenue: number;
  methodology: {
    returnsIncluded: boolean;
    calendarDaysIncluded: boolean;
    frozenStockTargetDays: number;
    costHierarchy: string;
  };
};

export type MarketingPromotionItem = {
  key: string;
  name: string;
  reportCount: number;
  lineCount: number;
  quantity: number;
  revenue: number;
  listRevenue: number;
  discountAmount: number;
  discountPct: number;
  avgPrice: number;
};

export type MarketingPromotionStore = {
  key: string;
  name: string;
  reportCount: number;
  lineCount: number;
  quantity: number;
  itemCount: number;
  revenue: number;
  listRevenue: number;
  discountAmount: number;
  discountPct: number;
  avgCheck: number;
  items: MarketingPromotionItem[];
};

export type MarketingPromotion = {
  key: string;
  name: string;
  number: string | null;
  status: "active" | "finished" | "upcoming";
  startsOn: string | null;
  endsOn: string | null;
  discountPctMin: number;
  discountPctMax: number;
  reportCount: number;
  lineCount: number;
  quantity: number;
  itemCount: number;
  assortmentSize: number;
  storeCount: number;
  revenue: number;
  listRevenue: number;
  discountAmount: number;
  avgCheck: number;
  revenuePerDiscount: number;
  stores: MarketingPromotionStore[];
};

export type MarketingStore = {
  key: string;
  name: string;
  totalReports: number;
  totalRevenue: number;
  promoReports: number;
  promoRevenue: number;
  promoDiscountAmount: number;
  promoQuantity: number;
  promoItemCount: number;
  promotionCount: number;
  promoSharePct: number;
};

export type MarketingReport = {
  period: SalesPeriod;
  summary: {
    totalRevenue: number;
    totalReports: number;
    promoRevenue: number;
    promoListRevenue: number;
    promoDiscountAmount: number;
    promoQuantity: number;
    promoReportCount: number;
    promoLineCount: number;
    promoItemCount: number;
    promoStoreCount: number;
    promotionCount: number;
    promotionWithSalesCount: number;
    activePromotionCount: number;
    promoSharePct: number;
    avgDiscountPct: number;
    avgCheck: number;
    revenuePerDiscount: number;
  };
  promotions: MarketingPromotion[];
  stores: MarketingStore[];
};

export type InventoryItem = {
  key: string;
  name: string;
  totalPurchased: number;
  totalSold: number;
  stockQty: number;
  negativeStockQty: number;
  reservedQty: number;
  availableQty: number;
  warehouseCount: number;
  recentSoldQty: number;
  recentDaysActive: number;
  dailySalesRate: number;
  daysOfStock: number | null;
  depletionDays: number | null;
  stockCost: number;
  costAvailable: boolean;
  stockRetailValue: number;
  lastSaleDate: string | null;
  lastPurchaseDate: string | null;
  stockPeriod: string | null;
  daysSinceLastSale: number | null;
  category: "out_of_stock" | "overstock" | "slow_moving" | "dead" | "normal";
};

export type InventoryReport = {
  period: SalesPeriod;
  summary: {
    totalItems: number;
    itemsWithStock: number;
    totalStockCost: number;
    totalStockRetail: number;
    outOfStockCount: number;
    overstockCount: number;
    slowMovingCount: number;
    deadCount: number;
    reservedQty: number;
    negativeStockQty: number;
    unvaluedQty: number;
    costCoveragePct: number;
    stockPeriod: string | null;
  };
  items: InventoryItem[];
  outOfStock: InventoryItem[];
  overstock: InventoryItem[];
  slowMoving: InventoryItem[];
  dead: InventoryItem[];
};

export type ManagementRequest = ReportDateRange & { limit?: number };

export type LossMetrics = {
  summary: {
    writeoffs: number;
    surpluses: number;
    netLosses: number;
    netRevenue: number;
    lossPct: number;
  };
  stores: Array<{
    storeKey: string;
    storeName: string;
    writeoffs: number;
    surpluses: number;
    netLosses: number;
    netRevenue: number;
    lossPct: number | null;
  }>;
  definition: string;
};

export type AcquiringMetrics = {
  summary: {
    sales: number;
    returns: number;
    turnover: number;
    commission: number | null;
    commissionPct: number | null;
    recordCount: number;
    commissionSourceLines: number;
    commissionStatus: "ready" | "unavailable";
  };
  stores: Array<{
    storeKey: string;
    storeName: string;
    sales: number;
    returns: number;
    turnover: number;
    commission: number | null;
    commissionPct: number | null;
    commissionSourceLines: number;
    recordCount: number;
  }>;
  limitation: string;
};

export type CashArticleMetrics = {
  summary: {
    inflow: number;
    outflow: number;
    net: number;
    lineCount: number;
    storeTagged: number;
    categorizedLines: number;
    categorizedPct: number;
    storeTaggedPct: number;
    internalInflow: number;
    internalOutflow: number;
    externalInflow: number;
    externalOutflow: number;
  };
  statement: {
    status: "ready" | "partial" | "unavailable";
    classifiedCoveragePct: number;
    classifiedTurnover: number;
    unclassifiedTurnover: number;
    internalTransferTurnover: number;
    internalTransferStatus: "partial" | "unavailable";
    unallocatedInternalInflow: number;
    unallocatedInternalOutflow: number;
    unallocatedInternalDocumentCount: number;
    classifiedArticleCount: number;
    unclassifiedArticleCount: number;
    approvedInternalArticleCount: number;
    flows: Record<"operating" | "investing" | "financing", {
      inflow: number | null;
      outflow: number | null;
      net: number | null;
    }>;
  };
  articles: Array<{
    articleKey: string;
    articleName: string;
    flowType: "operating" | "investing" | "financing" | "internal" | null;
    inflow: number;
    outflow: number;
    net: number;
    lineCount: number;
    storeTagged: number;
    internalLineCount: number;
    internalInflow: number;
    internalOutflow: number;
  }>;
  limitation: string;
};

export type SupplierTermsMetrics = {
  summary: {
    orderCount: number;
    stagedOrderCount: number;
    stageCoveragePct: number;
    weightedDeferralDays: number | null;
    status: "ready" | "experimental" | "unavailable";
    orderedAmount: number;
    stagedAmount: number;
    receivedAmount: number;
    executionPct: number | null;
    linkedReceiptCount: number;
    closedOrderCount: number;
    next30DayScheduledAmount: number;
    next56DayScheduledAmount: number;
    upcomingScheduleStatus: "partial";
    upcomingScheduleFrom: string;
    upcomingScheduleTo: string;
  };
  schedule: Array<{
    dueDay: string;
    counterpartyName: string;
    amount: number;
    documentCount: number;
  }>;
  upcomingSchedule: Array<{
    dueDay: string;
    counterpartyName: string;
    amount: number;
    documentCount: number;
  }>;
  limitation: string;
};

export type StoreStockMetrics = {
  summary: {
    stockQty: number;
    reservedQty: number;
    availableQty: number;
    stockCost: number;
    unvaluedQty: number;
    negativeStockQty: number;
    itemCount: number;
    valuedItemCount: number;
    snapshotAt: string | null;
    costCoveragePct: number;
  };
  stores: Array<{
    storeKey: string;
    storeName: string;
    snapshotAt: string | null;
    warehouseCount: number;
    itemCount: number;
    stockQty: number;
    reservedQty: number;
    availableQty: number;
    stockCost: number;
    unvaluedQty: number;
    negativeStockQty: number;
    costCoveragePct: number;
  }>;
};

export type StorePerformanceMetrics = {
  summary: {
    activeStoreCount: number;
    revenue: number;
    cost: number;
    losses: number;
    grossProfitAfterLoss: number;
    marginAfterLossPct: number | null;
    closingStockCost: number;
    stockMovement: number | null;
    frozenStockCost: number | null;
    frozenStockPct: number | null;
    frozenSnapshotCoveragePct: number;
    stockSnapshotCoveragePct: number;
    gmroi: number | null;
    unvaluedRevenue: number;
    closingUnvaluedQty: number;
    openingCoveragePct: number;
  };
  stores: Array<{
    storeKey: string;
    storeName: string;
    active: boolean;
    revenue: number;
    cost: number;
    unvaluedRevenue: number;
    costCoveragePct: number;
    writeoffs: number;
    surpluses: number;
    losses: number;
    grossProfitAfterLoss: number;
    marginAfterLossPct: number | null;
    closingStockCost: number;
    openingStockCost: number | null;
    stockMovement: number | null;
    closingUnvaluedQty: number;
    stockCostCoveragePct: number;
    daysOfStock: number | null;
    frozenStockCost: number | null;
    frozenStockPct: number | null;
    averageStockCost: number | null;
    stockSnapshotCoveragePct: number;
    frozenSnapshotCoveragePct: number;
    gmroi: number | null;
    closingSnapshotAt: string | null;
    openingSnapshotAt: string | null;
  }>;
  methodology: {
    analysisDays: number;
    stockDaysWindow: number;
    frozenStockTargetDays: number;
    activeStoreWindowDays: number;
    frozenStockStatus: "ready" | "partial";
    frozenStockLimitation: string;
    lossSources: string;
  };
};

export type SourceHealth = {
  checks: { count: number; selectedCount: number; selectedDays: number; dateFrom: string | null; dateTo: string | null };
  storeAreas: { total: number; filled: number };
  payroll: { timesheets: number; payrollDocuments: number };
  bankStatements: { tableCount: number };
  vat: { bazzaRevenue: number; recordedVat: number; salesLineCount: number; populatedLineCount: number; lineCoveragePct: number };
  reconciliation: {
    grossHeaderRevenue: number;
    grossLineRevenue: number;
    headerReturns: number;
    lineReturns: number;
  };
  issues: Array<{
    key: string;
    severity: "ready" | "partial" | "blocked";
    title: string;
    detail: string;
  }>;
};

export type MoneyPositionMetrics = {
  summary: {
    cashBalance: number;
    kkmBalance: number;
    totalCash: number;
    bankBalance: null;
    cashSales28d: number;
    averageDailyCashSales: number;
    uncollectedCashDays: number | null;
    cashSalesCoveragePct: number;
    cashDaysStatus: "ready" | "partial";
    supplierSumRaw: number;
    supplierPayableRaw: number;
    supplierReceivableRaw: number;
    supplierBalanceStatus: "experimental";
  };
  stores: Array<{
    storeKey: string;
    storeName: string;
    cashBalance: number;
    kkmBalance: number;
    totalCash: number;
    cashSales28d: number;
    averageDailyCashSales: number;
    uncollectedCashDays: number | null;
    cashSalesCoveragePct: number;
    supplierSumRaw: number;
    supplierPayableRaw: number;
    supplierReceivableRaw: number;
    cashSnapshotAt: string | null;
    kkmSnapshotAt: string | null;
    supplierSnapshotAt: string | null;
  }>;
  limitation: string;
};

export type LostSalesMetrics = {
  summary: {
    lostSales: number | null;
    observedLostSales: number;
    zeroStockItemDays: number;
    affectedItemCount: number;
    checkDays: number;
    snapshotCoveragePct: number;
    checkCoveragePct: number;
    snapshotDays: number;
    analysisDays: number;
    coveragePct: number;
    status: "ready" | "partial";
  };
  stores: Array<{
    storeKey: string;
    storeName: string;
    lostSales: number;
    zeroStockItemDays: number;
  }>;
  items: Array<{
    storeKey: string;
    storeName: string;
    itemKey: string;
    itemName: string;
    abcClass: "A" | "B";
    revenue: number;
    averageDailyRevenue: number;
    zeroStockDays: number;
    snapshotDays: number;
    lostSales: number;
  }>;
  methodology: string;
};

export type PurchasingRecommendations = {
  summary: {
    recommendationCount: number;
    recommendedQty: number;
    recommendedAmount: number | null;
    recommendationsWithSupplier: number;
    purchaseBudgetQty: number;
    purchaseBudgetAmount: number | null;
    observedPurchaseBudgetAmount: number;
    budgetCostCoveragePct: number;
    budgetStatus: "ready" | "partial";
    executionBudgetAmount: number | null;
    orderedAmount: number;
    budgetExecutionPct: number | null;
    executionCostCoveragePct: number;
    executionStatus: "ready" | "partial";
    budgetSnapshotAt: string;
    executionFrom: string;
    executionTo: string;
    velocityWindowDays: number;
    forecastDays: number;
  };
  recommendations: Array<{
    storeKey: string;
    storeName: string;
    itemKey: string;
    itemName: string;
    supplierKey: string | null;
    supplierName: string | null;
    stockQty: number;
    openOrderQty: number;
    targetStock: number;
    salesQty28d: number;
    dailySalesQty: number;
    forecastQty7d: number;
    daysOfStock: number | null;
    unitCost: number | null;
    recommendedQty: number;
    recommendedAmount: number | null;
    purchaseBudgetQty: number;
    purchaseBudgetAmount: number | null;
  }>;
  methodology: string;
};

function appendReportParams(params: URLSearchParams, filters: ReportDateRange) {
  if (filters.from) {
    params.set("from", filters.from);
  }

  if (filters.to) {
    params.set("to", nextDate(filters.to));
  }
}

export type ManagementSettings = {
  stores: Array<{
    storeKey: string;
    sourceName: string;
    displayName: string | null;
    active: boolean;
    configured: boolean;
    lastSaleAt: string | null;
  }>;
  metrics: Array<{
    metricId: string;
    normal: string;
    critical: string;
    cadence: string;
    owner: string;
    configured: boolean;
  }>;
  cashArticles: Array<{
    articleKey: string;
    articleName: string;
    lineCount: number;
    flowType: "operating" | "investing" | "financing" | "internal" | null;
    approved: boolean;
    suggestedFlow: "operating" | "investing" | "financing" | "internal" | null;
  }>;
  obligations: Array<{
    id: number;
    kind: "permanent" | "payroll" | "loan";
    name: string;
    amount: number;
    dueDate: string | null;
    frequency: string;
    active: boolean;
  }>;
  projects: Array<{
    id: number;
    name: string;
    budget: number;
    actual: number;
    startDate: string | null;
    status: "planned" | "active" | "completed" | "cancelled";
  }>;
  recurringExpenseSuggestions: Array<{
    articleKey: string;
    articleName: string;
    activeMonths: number;
    averageMonthlyAmount: number;
    lastMonth: string;
  }>;
};

function nextDate(value: string) {
  const parts = value.split("-").map((part) => Number(part));
  const [year, month, day] = parts;

  if (!year || !month || !day) {
    return value;
  }

  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return date.toISOString().slice(0, 10);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    },
    ...init
  });

  if (!response.ok) {
    let message = "Ошибка запроса";
    try {
      const body = (await response.json()) as { error?: string };
      message = body.error ?? message;
    } catch {
      message = response.statusText || message;
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function managementRequest<T>(
  endpoint: string,
  filters: ManagementRequest,
  signal?: AbortSignal
) {
  const params = new URLSearchParams({ limit: String(filters.limit ?? 20) });
  appendReportParams(params, filters);
  return request<T>(`/api/management/${endpoint}?${params}`, { signal });
}

export const api = {
  login(email: string, password: string) {
    return request<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
  },
  logout() {
    return request<void>("/api/auth/logout", { method: "POST" });
  },
  me() {
    return request<{ user: User }>("/api/auth/me");
  },
  overview() {
    return request<Overview>("/api/analytics/overview");
  },
  syncHealth(signal?: AbortSignal) {
    return request<SyncHealth>("/api/sync/health", { signal });
  },
  salesReport(filters: ReportRequest, signal?: AbortSignal) {
    const params = new URLSearchParams({
      period: filters.period,
      storeLimit: String(filters.storeLimit ?? 12)
    });
    appendReportParams(params, filters);
    return request<SalesReport>(`/api/reports/sales?${params}`, { signal });
  },
  incomeReport(filters: ReportRequest, signal?: AbortSignal) {
    const params = new URLSearchParams({
      period: filters.period,
      storeLimit: String(filters.storeLimit ?? 12)
    });
    appendReportParams(params, filters);
    return request<IncomeReport>(`/api/reports/income?${params}`, { signal });
  },
  nomenclatureReport(filters: ReportRequest, signal?: AbortSignal) {
    const params = new URLSearchParams({ period: filters.period });
    appendReportParams(params, filters);
    return request<NomenclatureReport>(`/api/nomenclature?${params}`, { signal });
  },
  marketingReport(filters: ReportRequest, signal?: AbortSignal) {
    const params = new URLSearchParams({ period: filters.period });
    appendReportParams(params, filters);
    return request<MarketingReport>(`/api/marketing?${params}`, { signal });
  },
  inventoryReport(filters: ReportRequest, signal?: AbortSignal) {
    const params = new URLSearchParams({ period: filters.period });
    appendReportParams(params, filters);
    return request<InventoryReport>(`/api/inventory?${params}`, { signal });
  },
  lossMetrics(filters: ManagementRequest, signal?: AbortSignal) {
    return managementRequest<LossMetrics>("losses", filters, signal);
  },
  acquiringMetrics(filters: ManagementRequest, signal?: AbortSignal) {
    return managementRequest<AcquiringMetrics>("acquiring", filters, signal);
  },
  cashArticleMetrics(filters: ManagementRequest, signal?: AbortSignal) {
    return managementRequest<CashArticleMetrics>("cash-articles", filters, signal);
  },
  supplierTermsMetrics(filters: ManagementRequest, signal?: AbortSignal) {
    return managementRequest<SupplierTermsMetrics>("supplier-terms", filters, signal);
  },
  storeStockMetrics(filters: ManagementRequest, signal?: AbortSignal) {
    return managementRequest<StoreStockMetrics>("store-stock", filters, signal);
  },
  moneyPositionMetrics(filters: ManagementRequest, signal?: AbortSignal) {
    return managementRequest<MoneyPositionMetrics>("money-position", filters, signal);
  },
  lostSalesMetrics(filters: ManagementRequest, signal?: AbortSignal) {
    return managementRequest<LostSalesMetrics>("lost-sales", filters, signal);
  },
  purchasingRecommendations(filters: ManagementRequest, signal?: AbortSignal) {
    return managementRequest<PurchasingRecommendations>("purchasing", filters, signal);
  },
  sourceHealth(filters: ManagementRequest, signal?: AbortSignal) {
    return managementRequest<SourceHealth>("source-health", filters, signal);
  },
  storePerformanceMetrics(filters: ManagementRequest, signal?: AbortSignal) {
    return managementRequest<StorePerformanceMetrics>("store-performance", filters, signal);
  },
  managementSettings(signal?: AbortSignal) {
    return request<ManagementSettings>("/api/management/settings", { signal });
  },
  updateStoreSetting(input: { storeKey: string; active: boolean; displayName?: string | null }) {
    return request<{ saved: true }>("/api/management/settings/store", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  updateMetricSetting(input: {
    metricId: string;
    normal: string;
    critical: string;
    cadence: string;
    owner: string;
  }) {
    return request<{ saved: true }>("/api/management/settings/metric", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  updateCashArticleSetting(input: {
    articleKey: string;
    flowType: "operating" | "investing" | "financing" | "internal" | null;
    approved: boolean;
  }) {
    return request<{ saved: true }>("/api/management/settings/cash-article", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  updateObligation(input: {
    id?: number;
    kind: "permanent" | "payroll" | "loan";
    name: string;
    amount: number;
    dueDate?: string | null;
    frequency: string;
    active: boolean;
  }) {
    return request<{ saved: true; id: number }>("/api/management/settings/obligation", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  updateProject(input: {
    id?: number;
    name: string;
    budget: number;
    actual: number;
    startDate?: string | null;
    status: "planned" | "active" | "completed" | "cancelled";
  }) {
    return request<{ saved: true; id: number }>("/api/management/settings/project", {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },
  table(tableName: string) {
    return request<TableProfile>(
      `/api/analytics/tables/${encodeURIComponent(tableName)}`
    );
  },
  timeSeries(tableName: string, dateColumn: string, metricColumn?: string) {
    const params = new URLSearchParams({ dateColumn });
    if (metricColumn) {
      params.set("metricColumn", metricColumn);
    }
    return request<TimeSeriesPoint[]>(
      `/api/analytics/tables/${encodeURIComponent(tableName)}/timeseries?${params}`
    );
  }
};
