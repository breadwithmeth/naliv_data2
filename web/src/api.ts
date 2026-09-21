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

export type SyncHealth = {
  available: boolean;
  unavailableReason: string | null;
  generatedAtUtc: string;
  staleAfterHours: number;
  schema: string;
  latest: SyncRun | null;
  runs: SyncRun[];
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
    revenue: number;
    orderCount: number;
    avgCheck: number;
    avgItemsPerCheck: number;
    reportCount: number;
  };
  revenueSeries: Array<{
    bucket: string;
    revenue: number;
    orderCount: number;
    avgCheck: number;
    avgItemsPerCheck: number;
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
  };
  incomeSeries: Array<{
    bucket: string;
    revenue: number;
    cost: number;
    grossProfit: number;
    marginPct: number;
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
  cost: number;
  grossProfit: number;
  marginPct: number;
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
  | "overstock"
  | "old_stock";

export type ExitProduct = {
  key: string;
  name: string;
  stockQty: number;
  reservedQty: number;
  availableQty: number;
  warehouseCount: number;
  recentSoldQty: number;
  recentRevenue: number;
  recentDaysActive: number;
  dailySalesRate: number;
  daysOfStock: number | null;
  stockCost: number;
  lastSaleDate: string | null;
  lastSaleInPeriod: string | null;
  lastPurchaseDate: string | null;
  stockPeriod: string | null;
  daysSinceLastSale: number | null;
  daysSinceLastPurchase: number | null;
  reason: ExitProductReason;
  riskScore: number;
};

export type NomenclatureReport = {
  period: SalesPeriod;
  items: ItemAnalysis[];
  exitItems: ExitProduct[];
  exitSummary: {
    totalItems: number;
    stockQty: number;
    stockCost: number;
    noSalesCount: number;
    deadStockCount: number;
    slowMovingCount: number;
    overstockCount: number;
    oldStockCount: number;
    stockPeriod: string | null;
  };
  totalDays: number;
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
  reservedQty: number;
  availableQty: number;
  warehouseCount: number;
  recentSoldQty: number;
  recentDaysActive: number;
  dailySalesRate: number;
  daysOfStock: number | null;
  depletionDays: number | null;
  stockCost: number;
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
    stockPeriod: string | null;
  };
  items: InventoryItem[];
  outOfStock: InventoryItem[];
  overstock: InventoryItem[];
  slowMoving: InventoryItem[];
  dead: InventoryItem[];
};

function appendReportParams(params: URLSearchParams, filters: ReportDateRange) {
  if (filters.from) {
    params.set("from", filters.from);
  }

  if (filters.to) {
    params.set("to", nextDate(filters.to));
  }
}

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
