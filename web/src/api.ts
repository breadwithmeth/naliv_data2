export type User = {
  email: string;
};

export type DbTable = {
  name: string;
  kind: string;
  estimatedRows: number;
  totalBytes: number;
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

export type TimeSeriesPoint = {
  bucket: string;
  metric: number;
};

export type SalesPeriod = "day" | "week" | "month";

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

export type NomenclatureReport = {
  period: SalesPeriod;
  items: ItemAnalysis[];
  totalDays: number;
};

export type MarketingReport = {
  period: SalesPeriod;
  summary: {
    totalRevenue: number;
    totalChecks: number;
    revenueWithDiscounts: number;
    revenueWithoutDiscounts: number;
    discountCheckCount: number;
    noDiscountCheckCount: number;
    totalDiscountAmount: number;
    avgDiscountPct: number;
  };
  promos: Array<{
    key: string;
    name: string;
    checkCount: number;
    revenue: number;
    discountAmount: number;
    avgDiscountPct: number;
  }>;
  salesWithoutDiscounts: {
    checkCount: number;
    revenue: number;
    avgCheck: number;
  };
  salesWithDiscounts: {
    checkCount: number;
    revenue: number;
    discountAmount: number;
    avgCheck: number;
  };
  stores: Array<{
    key: string;
    name: string;
    totalChecks: number;
    totalRevenue: number;
    discountChecks: number;
    discountAmount: number;
    avgDiscountPct: number;
  }>;
  storePromos: Array<{
    storeKey: string;
    storeName: string;
    promoKey: string;
    promoName: string;
    checkCount: number;
    revenue: number;
    discountAmount: number;
    avgDiscountPct: number;
  }>;
};

export type InventoryItem = {
  key: string;
  name: string;
  totalPurchased: number;
  totalSold: number;
  stockQty: number;
  recentSoldQty: number;
  recentDaysActive: number;
  dailySalesRate: number;
  daysOfStock: number | null;
  depletionDays: number | null;
  stockCost: number;
  stockRetailValue: number;
  lastSaleDate: string | null;
  lastPurchaseDate: string | null;
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
  };
  items: InventoryItem[];
  outOfStock: InventoryItem[];
  overstock: InventoryItem[];
  slowMoving: InventoryItem[];
  dead: InventoryItem[];
};

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
  salesReport(period: SalesPeriod) {
    const params = new URLSearchParams({ period, storeLimit: "12" });
    return request<SalesReport>(`/api/reports/sales?${params}`);
  },
  incomeReport(period: SalesPeriod) {
    const params = new URLSearchParams({ period, storeLimit: "12" });
    return request<IncomeReport>(`/api/reports/income?${params}`);
  },
  nomenclatureReport(period: SalesPeriod) {
    const params = new URLSearchParams({ period });
    return request<NomenclatureReport>(`/api/nomenclature?${params}`);
  },
  marketingReport(period: SalesPeriod) {
    const params = new URLSearchParams({ period });
    return request<MarketingReport>(`/api/marketing?${params}`);
  },
  inventoryReport(period: SalesPeriod) {
    const params = new URLSearchParams({ period });
    return request<InventoryReport>(`/api/inventory?${params}`);
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
