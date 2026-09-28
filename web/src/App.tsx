import {
  ArrowLeftRight,
  BarChart3,
  Boxes,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Package,
  Receipt,
  RotateCcw,
  Search,
  ShieldCheck,
  ShoppingCart,
  Store,
  Table2,
  TrendingUp
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  api,
  type AcquiringMetrics,
  type CashArticleMetrics,
  type DataGroup,
  type ExitProduct,
  type ExitProductReason,
  type IncomeReport,
  type InventoryReport,
  type ItemAnalysis,
  type LossMetrics,
  type LostSalesMetrics,
  type MarketingPromotion,
  type MarketingReport,
  type ManagementSettings,
  type MoneyPositionMetrics,
  type NomenclatureReport,
  type Overview,
  type PurchasingRecommendations,
  type ReportDateRange,
  type SalesPeriod,
  type SalesReport,
  type SourceHealth,
  type StorePerformanceMetrics,
  type StoreStockMetrics,
  type SupplierTermsMetrics,
  type SyncHealth,
  type SyncRun,
  type SyncSchedulerStatus,
  type SyncTableFreshness,
  type TableProfile,
  type TimeSeriesPoint,
  type User
} from "./api";
import { MetricLabel } from "./MetricHint";
import type { MetricId, MetricStatus } from "./metric-definitions";
import {
  formatBytes,
  formatCell,
  formatCompact,
  formatDate,
  formatDateTime,
  formatDecimal,
  formatDurationSeconds,
  formatMoney,
  formatMoneyCompact,
  formatNumber
} from "./format";

type LoadState<T> =
  | { status: "idle"; data?: undefined; error?: undefined }
  | { status: "loading"; data?: T; error?: undefined }
  | { status: "success"; data: T; error?: undefined }
  | { status: "error"; data?: T; error: string };

type AppPage =
  | "home"
  | "finance"
  | "stores"
  | "stock"
  | "pnl"
  | "reinvest"
  | "decisions"
  | "marketing"
  | "admin";

const pageMeta: Record<AppPage, { eyebrow: string; title: string }> = {
  home: { eyebrow: "Главная", title: "Панель собственника" },
  finance: { eyebrow: "Финансы", title: "Деньги и платежи" },
  stores: { eyebrow: "Точки", title: "Эффективность торговых точек" },
  stock: { eyebrow: "Запасы и закупки", title: "Товар и оборотный капитал" },
  pnl: { eyebrow: "P&L", title: "Прибыль и убыток" },
  reinvest: { eyebrow: "Реинвест", title: "Лимит развития" },
  decisions: { eyebrow: "Решения и тревоги", title: "Центр управленческих решений" },
  marketing: { eyebrow: "Маркетинг", title: "Маркетинговые акции" },
  admin: { eyebrow: "Администрирование", title: "Данные и синхронизация" }
};

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    api
      .me()
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => setCheckingSession(false));
  }, []);

  if (checkingSession) {
    return <FullScreenState title="Проверяем сессию" />;
  }

  if (!user) {
    return <LoginScreen onLogin={setUser} />;
  }

  return <Dashboard user={user} onLogout={() => setUser(null)} />;
}

function LoginScreen({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const result = await api.login(email, password);
      onLogin(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось войти");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-label="Авторизация">
        <div className="brand-mark">
          <ShieldCheck size={24} />
        </div>
        <h1>Naliv Analytics</h1>
        <p>Закрытая аналитическая панель по данным PostgreSQL.</p>

        <form onSubmit={submit} className="login-form">
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label>
            Пароль
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error ? <div className="form-error">{error}</div> : null}
          <button type="submit" disabled={submitting}>
            {submitting ? "Вход..." : "Войти"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const marketingOnly = user.role === "marketing";
  const [requestedPage, setCurrentPage] = useState<AppPage>(() =>
    marketingOnly ? "marketing" : "home"
  );
  const currentPage: AppPage = marketingOnly ? "marketing" : requestedPage;
  const [overviewState, setOverviewState] = useState<LoadState<Overview>>(() =>
    marketingOnly ? { status: "idle" } : { status: "loading" }
  );
  const [selectedTable, setSelectedTable] = useState<string>("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (marketingOnly) {
      return;
    }

    api
      .overview()
      .then((overview) => {
        setOverviewState({ status: "success", data: overview });
        setSelectedTable(overview.largestTables[0]?.name ?? overview.tables[0]?.name ?? "");
      })
      .catch((caught) =>
        setOverviewState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить аналитику"
        })
      );
  }, [marketingOnly]);

  async function logout() {
    await api.logout().catch(() => undefined);
    onLogout();
  }

  const overview = overviewState.data;
  const filteredTables = useMemo(() => {
    const tables = overview?.tables ?? [];
    const normalized = search.trim().toLowerCase();
    if (!normalized) {
      return tables;
    }
    return tables.filter((table) => table.name.toLowerCase().includes(normalized));
  }, [overview?.tables, search]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark small">
            <BarChart3 size={20} />
          </div>
          <div>
            <strong>Naliv Analytics</strong>
            <span>{marketingOnly ? "Маркетинг" : overview?.schema ?? "raw_1c"}</span>
          </div>
        </div>

        <nav className="page-nav" aria-label="Разделы">
          {!marketingOnly ? (
            <>
              <NavButton page="home" currentPage={currentPage} onSelect={setCurrentPage} icon={<LayoutDashboard size={16} />} label="Главная" />
              <NavButton page="finance" currentPage={currentPage} onSelect={setCurrentPage} icon={<Receipt size={16} />} label="Финансы" />
              <NavButton page="stores" currentPage={currentPage} onSelect={setCurrentPage} icon={<Store size={16} />} label="Точки" />
              <NavButton page="stock" currentPage={currentPage} onSelect={setCurrentPage} icon={<Boxes size={16} />} label="Запасы и закупки" />
              <NavButton page="pnl" currentPage={currentPage} onSelect={setCurrentPage} icon={<BarChart3 size={16} />} label="P&L" />
              <NavButton page="reinvest" currentPage={currentPage} onSelect={setCurrentPage} icon={<TrendingUp size={16} />} label="Реинвест" />
              <NavButton page="decisions" currentPage={currentPage} onSelect={setCurrentPage} icon={<ShieldCheck size={16} />} label="Решения и тревоги" />
            </>
          ) : null}
          <NavButton page="marketing" currentPage={currentPage} onSelect={setCurrentPage} icon={<Megaphone size={16} />} label="Маркетинг" />
          {!marketingOnly ? (
            <NavButton page="admin" currentPage={currentPage} onSelect={setCurrentPage} icon={<Database size={16} />} label="Администрирование" />
          ) : null}
        </nav>

        {currentPage === "admin" ? (
          <>
            <div className="search-box">
              <Search size={16} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Найти таблицу"
              />
            </div>

            <nav className="table-nav" aria-label="Таблицы">
              {filteredTables.map((table) => (
                <button
                  key={table.name}
                  className={table.name === selectedTable ? "active" : ""}
                  onClick={() => setSelectedTable(table.name)}
                  title={table.name}
                >
                  <Table2 size={15} />
                  <span>{table.name}</span>
                  <small>{formatBytes(table.totalBytes)}</small>
                </button>
              ))}
            </nav>
          </>
        ) : null}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">
              {currentPage === "home" ? <LayoutDashboard size={16} /> :
                currentPage === "finance" ? <Receipt size={16} /> :
                currentPage === "stores" ? <Store size={16} /> :
                currentPage === "stock" ? <Boxes size={16} /> :
                currentPage === "marketing" ? <Megaphone size={16} /> :
                currentPage === "admin" ? <Database size={16} /> :
                currentPage === "decisions" ? <ShieldCheck size={16} /> :
                <BarChart3 size={16} />}
              {pageMeta[currentPage].eyebrow}
            </span>
            <h1>{pageMeta[currentPage].title}</h1>
          </div>
          <div className="user-actions">
            <span>{user.email}</span>
            <button className="icon-button" onClick={logout} title="Выйти">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {currentPage === "home" ? (
          <OwnerHome />
        ) : currentPage === "finance" ? (
          <FinanceWorkspace />
        ) : currentPage === "stores" ? (
          <StoresWorkspace />
        ) : currentPage === "stock" ? (
          <StockWorkspace />
        ) : currentPage === "pnl" ? (
          <PnlWorkspace />
        ) : currentPage === "reinvest" ? (
          <ReinvestmentWorkspace />
        ) : currentPage === "decisions" ? (
          <DecisionCenter />
        ) : currentPage === "marketing" ? (
          <MarketingReports />
        ) : (
          <>
            <ManagementDashboard section="admin" />
            {overviewState.status === "loading" ? (
              <FullScreenState title="Загружаем метрики" compact />
            ) : null}
            {overviewState.status === "error" ? (
              <div className="empty-state">{overviewState.error}</div>
            ) : null}
            {overview ? (
              <>
                <section className="metric-grid" aria-label="Сводка">
                  <MetricCard icon={<Database size={18} />} metricId="admin.tables" label="Таблиц" value={formatNumber(overview.tableCount)} />
                  <MetricCard icon={<BarChart3 size={18} />} metricId="admin.rows" label="Строк, оценка" value={formatCompact(overview.estimatedRows)} />
                  <MetricCard icon={<Table2 size={18} />} metricId="admin.columns" label="Колонок" value={formatNumber(overview.columnCount)} />
                  <MetricCard icon={<Database size={18} />} metricId="admin.size" label="Размер" value={formatBytes(overview.totalBytes)} />
                </section>
                <SyncPanel />
                <DataCatalogOverview overview={overview} onSelectTable={setSelectedTable} />
                <section className="chart-band">
                  <div className="section-heading">
                    <h2>Крупнейшие таблицы</h2>
                    <span>по размеру хранения</span>
                  </div>
                  <div className="chart-wrap">
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={overview.largestTables}>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={82} />
                        <YAxis tickFormatter={formatBytes} width={72} />
                        <Tooltip formatter={(value) => formatBytes(Number(value))} labelStyle={{ color: "#172033" }} />
                        <Bar dataKey="totalBytes" fill="#2864d8" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </section>
                {selectedTable ? <TableDetail tableName={selectedTable} /> : null}
              </>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}

function NavButton({
  page,
  currentPage,
  onSelect,
  icon,
  label
}: {
  page: AppPage;
  currentPage: AppPage;
  onSelect: (page: AppPage) => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      className={currentPage === page ? "active" : ""}
      onClick={() => onSelect(page)}
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

const dataGroupCopy: Record<
  DataGroup["key"],
  { title: string; description: string; reportUse: string }
> = {
  documents: {
    title: "Документы 1С",
    description:
      "Заказы, поступления, списания, кассовые ордера, перемещения, установки цен и себестоимости, инвентаризация.",
    reportUse:
      "Операционные отчеты по движениям, суммам документов, активности магазинов и проведенным операциям."
  },
  documentLines: {
    title: "Табличные части",
    description:
      "Строки товаров, оплат, цен, инвентаризации и других документов, связанные через _parent_ref_key и _parent_line_index.",
    reportUse:
      "Детализация отчетов до товара, склада, характеристики, цены, количества и суммы строки."
  },
  catalogs: {
    title: "Справочники",
    description:
      "Номенклатура, магазины, склады, скидки, наценки, информационные и дисконтные карты.",
    reportUse:
      "Расшифровка ссылок 1С, группировки по товарам, магазинам, складам и маркетинговым признакам."
  },
  balances: {
    title: "Срезы остатков",
    description:
      "Остатки товаров по дням, складам, номенклатуре, характеристикам, количеству и резерву.",
    reportUse:
      "Отчеты по запасам, доступности товара, резервам, динамике остатков и стоимости склада."
  },
  other: {
    title: "Прочие таблицы",
    description: "Дополнительные сущности OData, которые не попали в основные группы raw_1c.",
    reportUse: "Профилирование, контроль полноты загрузки и дополнительные аналитические срезы."
  }
};

function DataCatalogOverview({
  overview,
  onSelectTable
}: {
  overview: Overview;
  onSelectTable: (tableName: string) => void;
}) {
  const visibleServiceFields = overview.serviceFieldCoverage.filter(
    (field) => field.tableCount > 0
  );

  return (
    <section className="data-catalog" aria-label="Описание данных raw_1c">
      <div className="section-heading">
        <div>
          <h2>Состав данных raw_1c</h2>
          <span>группы таблиц, доступные для построения отчетов</span>
        </div>
      </div>

      <div className="data-group-grid">
        {overview.dataGroups.map((group) => {
          const copy = dataGroupCopy[group.key];

          return (
            <article key={group.key} className="data-group-card">
              <div className="data-group-title">
                <div className="metric-icon">
                  <DataGroupIcon group={group.key} />
                </div>
                <div>
                  <h3>{copy.title}</h3>
                  <span>
                    {formatNumber(group.tableCount)} таблиц ·{" "}
                    {formatCompact(group.estimatedRows)} строк
                  </span>
                </div>
              </div>
              <p>{copy.description}</p>
              <p className="muted">{copy.reportUse}</p>
              <div className="data-group-stats">
                <span>{formatNumber(group.columnCount)} колонок</span>
                <span>{formatNumber(group.numericColumnCount)} числовых</span>
                <span>{formatNumber(group.temporalColumnCount)} дат</span>
              </div>
              {group.sampleTables.length > 0 ? (
                <div className="table-chip-list">
                  {group.sampleTables.map((table) => (
                    <button
                      key={table}
                      type="button"
                      onClick={() => onSelectTable(table)}
                      title={table}
                    >
                      {table}
                    </button>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {visibleServiceFields.length > 0 ? (
        <div className="service-field-strip">
          <strong>Служебные поля</strong>
          <div>
            {visibleServiceFields.map((field) => (
              <span key={field.name}>
                {field.name}: {formatNumber(field.tableCount)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function DataGroupIcon({ group }: { group: DataGroup["key"] }) {
  if (group === "documents") {
    return <Receipt size={18} />;
  }

  if (group === "documentLines") {
    return <Table2 size={18} />;
  }

  if (group === "catalogs") {
    return <Database size={18} />;
  }

  if (group === "balances") {
    return <Boxes size={18} />;
  }

  return <LayoutDashboard size={18} />;
}

const periodOptions: Array<{ value: SalesPeriod; label: string }> = [
  { value: "day", label: "Дни" },
  { value: "week", label: "Недели" },
  { value: "month", label: "Месяцы" }
];

type DateRangeValue = Required<Pick<ReportDateRange, "from" | "to">>;

// Mirrors `currentMonthRange` in `api/src/lib/report-range.ts`, which applies the
// same window when a request carries no range: the form always shows the month
// the report was built from, so a blank range can never read as "all years".
function currentMonthRange(): DateRangeValue {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));

  return {
    from: first.toISOString().slice(0, 10),
    to: last.toISOString().slice(0, 10)
  };
}

function ReportsPage() {
  const [dateRange, setDateRange] = useState<DateRangeValue>(currentMonthRange);

  return (
    <>
      <SalesReports dateRange={dateRange} onDateRangeChange={setDateRange} />
      <IncomeReports dateRange={dateRange} onDateRangeChange={setDateRange} />
    </>
  );
}

function UnavailableMetricPanel({
  title,
  metrics
}: {
  title: string;
  metrics: Array<{ metricId: MetricId; reason: string }>;
}) {
  return (
    <section className="reports-section">
      <div className="section-heading">
        <h2>{title}</h2>
        <span>недоступные источники не заменяются нулевыми значениями</span>
      </div>
      <section className="metric-grid report-metric-grid">
        {metrics.map((item) => (
          <MetricCard
            key={item.metricId}
            icon={<ShieldCheck size={18} />}
            metricId={item.metricId}
            value={null}
            status="unavailable"
            reason={item.reason}
          />
        ))}
      </section>
    </section>
  );
}

function ObligationDirectory() {
  const [rows, setRows] = useState<ManagementSettings["obligations"]>([]);
  const [suggestions, setSuggestions] = useState<ManagementSettings["recurringExpenseSuggestions"]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.managementSettings(controller.signal)
      .then((data) => {
        setRows(data.obligations);
        setSuggestions(data.recurringExpenseSuggestions);
        setStatus("ready");
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setMessage(caught instanceof Error ? caught.message : "Не удалось загрузить обязательства");
          setStatus("error");
        }
      });
    return () => controller.abort();
  }, []);

  const updateRow = <K extends keyof ManagementSettings["obligations"][number]>(
    index: number,
    field: K,
    value: ManagementSettings["obligations"][number][K]
  ) => setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));

  const save = async (row: ManagementSettings["obligations"][number], index: number) => {
    setMessage(null);
    try {
      const result = await api.updateObligation({
        id: row.id || undefined,
        kind: row.kind,
        name: row.name,
        amount: row.amount,
        dueDate: row.dueDate,
        frequency: row.frequency,
        active: row.active
      });
      updateRow(index, "id", result.id);
      setMessage("Обязательство сохранено.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Не удалось сохранить обязательство");
    }
  };

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Обязательства, ФОТ и займы</h2>
          <span>ручной источник для будущего платёжного календаря; суммы не включаются в свободные деньги без банка</span>
        </div>
        <button type="button" onClick={() => {
          setRows((current) => [...current, { id: 0, kind: "permanent", name: "", amount: 0, dueDate: null, frequency: "monthly", active: true }]);
          setStatus("ready");
        }}>Добавить</button>
      </div>
      {status === "loading" ? <FullScreenState title="Загружаем обязательства" compact /> : null}
      {status === "error" ? <div className="empty-state">{message}</div> : null}
      {status === "ready" ? (
        <>
          <section className="metric-grid report-metric-grid">
            <MetricCard
              icon={<Receipt size={18} />}
              metricId="money.registered-obligations"
              value={formatMoney(rows.filter((row) => row.active).reduce((sum, row) => sum + row.amount, 0))}
              status="partial"
              detail={`${formatNumber(rows.filter((row) => row.active).length)} активных записей`}
            />
          </section>
          {suggestions.length > 0 ? (
            <div className="suggestion-list">
              <strong>Повторяющиеся РКО — предложения для проверки</strong>
              {suggestions.map((suggestion) => (
                <button
                  type="button"
                  key={suggestion.articleKey}
                  onClick={() => {
                    setRows((current) => [...current, {
                      id: 0,
                      kind: "permanent",
                      name: suggestion.articleName,
                      amount: Math.round(suggestion.averageMonthlyAmount),
                      dueDate: null,
                      frequency: "monthly",
                      active: true
                    }]);
                    setSuggestions((current) => current.filter((item) => item.articleKey !== suggestion.articleKey));
                  }}
                >
                  {suggestion.articleName}: ≈ {formatMoney(suggestion.averageMonthlyAmount)} / мес.
                  <small>{suggestion.activeMonths} мес. с расходом · принять</small>
                </button>
              ))}
            </div>
          ) : null}
          <div className="data-table-wrap">
          <table className="data-table settings-table">
            <thead><tr><th>Тип</th><th>Название</th><th><MetricLabel metricId="money.registered-obligations">Сумма</MetricLabel></th><th>Дата</th><th>Периодичность</th><th>Активно</th><th /></tr></thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.id || `new-${index}`}>
                  <td>
                    <select value={row.kind} onChange={(event) => updateRow(index, "kind", event.target.value as typeof row.kind)}>
                      <option value="permanent">Постоянный платёж</option>
                      <option value="payroll">ФОТ</option>
                      <option value="loan">Займ / кредит</option>
                    </select>
                  </td>
                  <td><input value={row.name} onChange={(event) => updateRow(index, "name", event.target.value)} /></td>
                  <td><input type="number" min="0" value={row.amount} onChange={(event) => updateRow(index, "amount", Number(event.target.value))} /></td>
                  <td><input type="date" value={row.dueDate ?? ""} onChange={(event) => updateRow(index, "dueDate", event.target.value || null)} /></td>
                  <td><input value={row.frequency} onChange={(event) => updateRow(index, "frequency", event.target.value)} /></td>
                  <td><input type="checkbox" checked={row.active} onChange={(event) => updateRow(index, "active", event.target.checked)} /></td>
                  <td><button type="button" disabled={!row.name.trim()} onClick={() => save(row, index)}>Сохранить</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {message ? <div className="metric-note">{message}</div> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

function ProjectDirectory() {
  const [rows, setRows] = useState<ManagementSettings["projects"]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.managementSettings(controller.signal)
      .then((data) => {
        setRows(data.projects);
        setStatus("ready");
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setMessage(caught instanceof Error ? caught.message : "Не удалось загрузить проекты");
          setStatus("error");
        }
      });
    return () => controller.abort();
  }, []);

  const updateRow = <K extends keyof ManagementSettings["projects"][number]>(
    index: number,
    field: K,
    value: ManagementSettings["projects"][number][K]
  ) => setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));

  const save = async (row: ManagementSettings["projects"][number], index: number) => {
    setMessage(null);
    try {
      const result = await api.updateProject({
        id: row.id || undefined,
        name: row.name,
        budget: row.budget,
        actual: row.actual,
        startDate: row.startDate,
        status: row.status
      });
      updateRow(index, "id", result.id);
      setMessage("Проект сохранён.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Не удалось сохранить проект");
    }
  };

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Проекты развития</h2>
          <span>ручные бюджеты и факты; окупаемость появится после подключения P&L и денежных потоков</span>
        </div>
        <button type="button" onClick={() => {
          setRows((current) => [...current, { id: 0, name: "", budget: 0, actual: 0, startDate: null, status: "planned" }]);
          setStatus("ready");
        }}>Добавить проект</button>
      </div>
      {status === "loading" ? <FullScreenState title="Загружаем проекты" compact /> : null}
      {status === "error" ? <div className="empty-state">{message}</div> : null}
      {status === "ready" ? (
        <>
          <section className="metric-grid report-metric-grid">
            <MetricCard icon={<Receipt size={18} />} metricId="reinvest.budget" value={formatMoney(rows.reduce((sum, row) => sum + row.budget, 0))} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="reinvest.actual" value={formatMoney(rows.reduce((sum, row) => sum + row.actual, 0))} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="reinvest.deviation" value={formatMoney(rows.reduce((sum, row) => sum + row.actual - row.budget, 0))} />
          </section>
          <div className="data-table-wrap">
            <table className="data-table settings-table">
              <thead><tr><th>Проект</th><th><MetricLabel metricId="reinvest.budget">Бюджет</MetricLabel></th><th><MetricLabel metricId="reinvest.actual">Факт</MetricLabel></th><th><MetricLabel metricId="reinvest.deviation">Отклонение</MetricLabel></th><th>Старт</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.id || `new-${index}`}>
                  <td><input value={row.name} onChange={(event) => updateRow(index, "name", event.target.value)} /></td>
                  <td><input type="number" min="0" value={row.budget} onChange={(event) => updateRow(index, "budget", Number(event.target.value))} /></td>
                  <td><input type="number" min="0" value={row.actual} onChange={(event) => updateRow(index, "actual", Number(event.target.value))} /></td>
                  <td>{formatMoney(row.actual - row.budget)}</td>
                  <td><input type="date" value={row.startDate ?? ""} onChange={(event) => updateRow(index, "startDate", event.target.value || null)} /></td>
                  <td>
                    <select value={row.status} onChange={(event) => updateRow(index, "status", event.target.value as typeof row.status)}>
                      <option value="planned">План</option>
                      <option value="active">В работе</option>
                      <option value="completed">Завершён</option>
                      <option value="cancelled">Отменён</option>
                    </select>
                  </td>
                  <td><button type="button" disabled={!row.name.trim()} onClick={() => save(row, index)}>Сохранить</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {message ? <div className="metric-note">{message}</div> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

function OwnerHome() {
  return (
    <>
      <UnavailableMetricPanel
        title="Главные ответы собственника"
        metrics={[
          { metricId: "money.free", reason: "Нет банковских остатков, полного реестра обязательств и постоянных платежей." },
          { metricId: "money.position", reason: "Кассы и ККМ доступны ниже в разделе «Финансы», но банковские остатки и эквайринг в пути отсутствуют." },
          { metricId: "money.calendar", reason: "Нет банка, ФОТ, полного реестра постоянных платежей и графиков займов." }
        ]}
      />
      <StorePerformanceDashboard summaryOnly />
    </>
  );
}

function FinanceWorkspace() {
  return (
    <>
      <UnavailableMetricPanel
        title="Денежная позиция и платёжный календарь"
        metrics={[
          { metricId: "money.position", reason: "Кассы и ККМ загружены ниже; для полной позиции нужны выписки по счетам трёх ИП и эквайринг в пути." },
          { metricId: "money.free", reason: "Нет банка; обязательства и резерв можно вести ниже, но расчёт пока останется недоступным." },
          { metricId: "money.calendar", reason: "Нет банковских остатков и прогноза поступлений; ручные обязательства доступны ниже." },
          { metricId: "debt.payments-12m", reason: "Нет реестра займов и графиков платежей." },
          { metricId: "debt.dscr", reason: "Нет графиков долга и доверенного FCF." },
        ]}
      />
      <ManagementDashboard section="finance" />
      <ObligationDirectory />
    </>
  );
}

function StoresWorkspace() {
  return (
    <>
      <UnavailableMetricPanel
        title="Производительность площади и персонала"
        metrics={[
          { metricId: "store.revenue-m2", reason: "Площадь торгового зала в 1С не заполнена." },
          { metricId: "store.profit-m2", reason: "Площадь торгового зала в 1С не заполнена." },
          { metricId: "store.revenue-shift", reason: "Нет текущих табелей смен и численности по точкам." },
          { metricId: "store.payroll-share", reason: "Нет начисленного ФОТ по точкам." }
        ]}
      />
      <ReportsPage />
      <StorePerformanceDashboard />
      <ManagementDashboard section="stores" />
    </>
  );
}

function StockWorkspace() {
  return (
    <>
      <ManagementDashboard section="stock" />
      <NomenclatureReports />
      <InventoryReports />
    </>
  );
}

function PnlWorkspace() {
  const [dateRange, setDateRange] = useState<DateRangeValue>(currentMonthRange);
  return (
    <>
      <UnavailableMetricPanel
        title="Начисленный P&L"
        metrics={[
          { metricId: "pnl.ebitda", reason: "Нет ФОТ, аренды, постоянных расходов, налогов, банка и политики внутренних передач." }
        ]}
      />
      <IncomeReports dateRange={dateRange} onDateRangeChange={setDateRange} />
    </>
  );
}

function ReinvestmentWorkspace() {
  return (
    <>
      <UnavailableMetricPanel
        title="Реинвестирование"
        metrics={[
          { metricId: "reinvest.limit", reason: "Нет начисленного EBITDA, свободных денег и FCF; бюджеты и факты проектов можно вести ниже." }
        ]}
      />
      <ProjectDirectory />
    </>
  );
}

function DecisionThresholdTable() {
  const [state, setState] = useState<LoadState<ManagementSettings>>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    api.managementSettings(controller.signal)
      .then((data) => setState({ status: "success", data }))
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setState({ status: "error", error: caught instanceof Error ? caught.message : "Не удалось загрузить пороги" });
        }
      });
    return () => controller.abort();
  }, []);

  if (state.status === "loading") return <FullScreenState title="Загружаем пороги" compact />;
  if (state.status === "error") return <div className="empty-state">{state.error}</div>;
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead><tr><th>Метрика</th><th>Норма</th><th>Тревога</th><th>Частота</th><th>Ответственный</th></tr></thead>
        <tbody>
          {state.data?.metrics.map((row) => (
            <tr key={row.metricId}>
              <td><MetricLabel metricId={row.metricId as MetricId} /></td>
              <td>{row.normal}</td>
              <td>{row.critical}</td>
              <td>{row.cadence}</td>
              <td>{row.owner}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DecisionCenter() {
  return (
    <>
      <section className="reports-section">
        <div className="section-heading">
          <h2>Пороги и ответственные</h2>
          <span>настроенные правила; тревога создаётся только для доступной метрики</span>
        </div>
        <DecisionThresholdTable />
      </section>
      <UnavailableMetricPanel
        title="Автоматизация решений"
        metrics={[
          { metricId: "money.calendar", reason: "Реестр переноса платежей заблокирован неполным календарём." },
          { metricId: "reinvest.limit", reason: "Чек-лист открытия заблокирован отсутствующими проектами и P&L." }
        ]}
      />

    </>
  );
}

function StorePerformanceDashboard({ summaryOnly = false }: { summaryOnly?: boolean }) {
  const [dateRange, setDateRange] = useState<DateRangeValue>(currentMonthRange);
  const [state, setState] = useState<LoadState<StorePerformanceMetrics>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    api.storePerformanceMetrics({ ...dateRange, limit: 30 }, controller.signal)
      .then((data) => setState({ status: "success", data }))
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setState({ status: "error", error: caught instanceof Error ? caught.message : "Не удалось загрузить показатели точек" });
        }
      });
    return () => controller.abort();
  }, [dateRange.from, dateRange.to]);

  const report = state.data;
  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>{summaryOnly ? "Доступная операционная картина" : "Результат и запас по активным точкам"}</h2>
          <span>активная точка = есть продажи за последние 90 дней</span>
        </div>
        <ReportFilterBar dateRange={dateRange} onDateRangeChange={setDateRange} />
      </div>
      {state.status === "loading" ? <FullScreenState title="Считаем показатели точек" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {report ? (
        <>
          <section className="metric-grid report-metric-grid">
            <MetricCard icon={<Store size={18} />} metricId="store.active" value={formatNumber(report.summary.activeStoreCount)} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="store.profit-after-loss" value={formatMoney(report.summary.grossProfitAfterLoss)} status={report.summary.unvaluedRevenue > 0 ? "partial" : "ready"} coveragePct={report.summary.revenue !== 0 ? (Math.abs(report.summary.revenue) - report.summary.unvaluedRevenue) / Math.abs(report.summary.revenue) * 100 : 100} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="store.margin-after-loss" value={report.summary.marginAfterLossPct === null ? null : `${formatDecimal(report.summary.marginAfterLossPct, 1)}%`} />
            <MetricCard icon={<Boxes size={18} />} metricId="stock.cost" value={formatMoney(report.summary.closingStockCost)} status={report.summary.closingUnvaluedQty > 0 ? "partial" : "ready"} reason={report.summary.closingUnvaluedQty > 0 ? `${formatDecimal(report.summary.closingUnvaluedQty)} ед. без стоимости` : undefined} />
            <MetricCard icon={<Package size={18} />} metricId="stock.frozen" value={report.summary.frozenStockCost === null ? null : formatMoney(report.summary.frozenStockCost)} status={report.methodology.frozenStockStatus} coveragePct={report.summary.frozenSnapshotCoveragePct} detail={report.summary.frozenStockPct === null ? undefined : `${formatDecimal(report.summary.frozenStockPct, 1)}% запаса`} reason={report.methodology.frozenStockStatus === "partial" ? "Недостаточно ежедневных снимков для доверенной оценки." : undefined} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="stock.gmroi" value={report.summary.gmroi === null ? null : formatDecimal(report.summary.gmroi, 2)} status={report.summary.stockSnapshotCoveragePct >= 90 ? "ready" : "partial"} coveragePct={report.summary.stockSnapshotCoveragePct} reason={report.summary.gmroi === null ? "Средний запас публикуется при покрытии периода снимками не ниже 90%." : undefined} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="stock.movement" value={report.summary.stockMovement === null ? null : formatMoney(report.summary.stockMovement)} status={report.summary.stockMovement === null ? "unavailable" : "ready"} reason={report.summary.stockMovement === null ? "Нет снимка остатков на начало периода для каждой активной точки." : undefined} />
          </section>
          {!summaryOnly ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Точка</th>
                    <th className="num"><MetricLabel metricId="sales.net" /></th>
                    <th className="num"><MetricLabel metricId="store.profit-after-loss" /></th>
                    <th className="num"><MetricLabel metricId="store.margin-after-loss" /></th>
                    <th className="num"><MetricLabel metricId="stock.cost" /></th>
                    <th className="num"><MetricLabel metricId="stock.days" /></th>
                    <th className="num"><MetricLabel metricId="stock.average">Средний запас</MetricLabel></th>
                    <th className="num"><MetricLabel metricId="stock.frozen" /></th>
                    <th className="num"><MetricLabel metricId="stock.gmroi" /></th>
                  </tr>
                </thead>
                <tbody>
                  {report.stores.filter((store) => store.active).map((store) => (
                    <tr key={store.storeKey}>
                      <td>{store.storeName}</td>
                      <td className="num">{formatMoney(store.revenue)}</td>
                      <td className="num">{formatMoney(store.grossProfitAfterLoss)}</td>
                      <td className="num">{store.marginAfterLossPct === null ? "—" : `${formatDecimal(store.marginAfterLossPct, 1)}%`}</td>
                      <td className="num">{formatMoney(store.closingStockCost)}</td>
                      <td className="num">{store.daysOfStock === null ? "—" : formatDecimal(store.daysOfStock, 1)}</td>
                      <td className="num">{store.averageStockCost === null ? "—" : formatMoney(store.averageStockCost)}</td>
                      <td className="num">{store.frozenStockCost === null ? "—" : formatMoney(store.frozenStockCost)}</td>
                      <td className="num">{store.gmroi === null ? "—" : formatDecimal(store.gmroi, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="metric-note warning">
            {report.methodology.frozenStockLimitation} {report.methodology.lossSources}
          </div>
        </>
      ) : null}
    </section>
  );
}

type ManagementSection = "finance" | "stores" | "stock" | "admin";

function ManagementDashboard({ section }: { section: ManagementSection }) {
  const [dateRange, setDateRange] = useState<DateRangeValue>(currentMonthRange);
  const [losses, setLosses] = useState<LoadState<LossMetrics>>({ status: "idle" });
  const [acquiring, setAcquiring] = useState<LoadState<AcquiringMetrics>>({ status: "idle" });
  const [cash, setCash] = useState<LoadState<CashArticleMetrics>>({ status: "idle" });
  const [supplierTerms, setSupplierTerms] = useState<LoadState<SupplierTermsMetrics>>({ status: "idle" });
  const [storeStock, setStoreStock] = useState<LoadState<StoreStockMetrics>>({ status: "idle" });
  const [moneyPosition, setMoneyPosition] = useState<LoadState<MoneyPositionMetrics>>({ status: "idle" });
  const [lostSales, setLostSales] = useState<LoadState<LostSalesMetrics>>({ status: "idle" });
  const [purchasing, setPurchasing] = useState<LoadState<PurchasingRecommendations>>({ status: "idle" });
  const [sourceHealth, setSourceHealth] = useState<LoadState<SourceHealth>>({ status: "idle" });

  useEffect(() => {
    const controller = new AbortController();
    const filters = { ...dateRange, limit: 20 };
    const load = <T,>(
      request: Promise<T>,
      setter: React.Dispatch<React.SetStateAction<LoadState<T>>>,
      fallback: string
    ) => {
      setter({ status: "loading" });
      request
        .then((data) => setter({ status: "success", data }))
        .catch((caught) => {
          if (!controller.signal.aborted) {
            setter({ status: "error", error: caught instanceof Error ? caught.message : fallback });
          }
        });
    };

    if (section === "stores") {
      load(api.lossMetrics(filters, controller.signal), setLosses, "Не удалось загрузить потери");
      load(api.lostSalesMetrics(filters, controller.signal), setLostSales, "Не удалось рассчитать Lost Sales");
    }
    if (section === "finance") {
      load(api.acquiringMetrics(filters, controller.signal), setAcquiring, "Не удалось загрузить эквайринг");
      load(api.cashArticleMetrics(filters, controller.signal), setCash, "Не удалось загрузить кассовые движения");
      load(api.moneyPositionMetrics(filters, controller.signal), setMoneyPosition, "Не удалось загрузить остатки денег");
    }
    if (section === "stock") {
      load(api.supplierTermsMetrics(filters, controller.signal), setSupplierTerms, "Не удалось загрузить условия поставщиков");
      load(api.storeStockMetrics(filters, controller.signal), setStoreStock, "Не удалось загрузить остатки по точкам");
      load(api.purchasingRecommendations(filters, controller.signal), setPurchasing, "Не удалось сформировать рекомендации к заказу");
    }
    if (section === "admin") {
      load(api.sourceHealth(filters, controller.signal), setSourceHealth, "Не удалось проверить источники");
    }

    return () => controller.abort();
  }, [dateRange.from, dateRange.to, section]);

  return (
    <>
      <section className="reports-section management-intro">
        <div className="section-heading row">
          <div>
            <h2>{section === "admin" ? "Качество источников" : "Проверенные данные 1С"}</h2>
            <span>неполные источники показаны отдельно и никогда не заменяются достоверным нулём</span>
          </div>
          <ReportFilterBar dateRange={dateRange} onDateRangeChange={setDateRange} />
        </div>
      </section>
      {section === "admin" ? <SourceHealthPanel state={sourceHealth} /> : null}
      {section === "admin" ? <ManagementSettingsPanel /> : null}
      {section === "stores" ? <LossMetricsPanel state={losses} /> : null}
      {section === "stores" ? <LostSalesPanel state={lostSales} /> : null}
      {section === "finance" ? <AcquiringMetricsPanel state={acquiring} /> : null}
      {section === "finance" ? <CashArticleMetricsPanel state={cash} /> : null}
      {section === "finance" ? <MoneyPositionPanel state={moneyPosition} /> : null}
      {section === "stock" ? <SupplierTermsPanel state={supplierTerms} /> : null}
      {section === "stock" ? <StoreStockPanel state={storeStock} /> : null}
      {section === "stock" ? <PurchasingRecommendationsPanel state={purchasing} /> : null}
    </>
  );
}

function ManagementSettingsPanel() {
  const [settings, setSettings] = useState<ManagementSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.managementSettings(controller.signal)
      .then(setSettings)
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Не удалось загрузить справочники");
        }
      });
    return () => controller.abort();
  }, []);

  const saveStore = async (store: ManagementSettings["stores"][number]) => {
    const key = `store:${store.storeKey}`;
    setSavingKey(key);
    setError(null);
    try {
      await api.updateStoreSetting({
        storeKey: store.storeKey,
        active: store.active,
        displayName: store.displayName
      });
      setSettings((current) => current ? {
        ...current,
        stores: current.stores.map((item) =>
          item.storeKey === store.storeKey ? { ...item, configured: true } : item
        )
      } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось сохранить точку");
    } finally {
      setSavingKey(null);
    }
  };

  const saveMetric = async (metric: ManagementSettings["metrics"][number]) => {
    const key = `metric:${metric.metricId}`;
    setSavingKey(key);
    setError(null);
    try {
      await api.updateMetricSetting(metric);
      setSettings((current) => current ? {
        ...current,
        metrics: current.metrics.map((item) =>
          item.metricId === metric.metricId ? { ...item, configured: true } : item
        )
      } : current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось сохранить порог");
    } finally {
      setSavingKey(null);
    }
  };

  const saveCashArticle = async (article: ManagementSettings["cashArticles"][number]) => {
    const key = `article:${article.articleKey}`;
    setSavingKey(key);
    setError(null);
    try {
      await api.updateCashArticleSetting({
        articleKey: article.articleKey,
        flowType: article.flowType,
        approved: article.approved
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Не удалось сохранить статью");
    } finally {
      setSavingKey(null);
    }
  };

  if (!settings && !error) {
    return <FullScreenState title="Загружаем управленческие справочники" compact />;
  }

  return (
    <section className="reports-section">
      <div className="section-heading">
        <h2>Управленческие справочники</h2>
        <span>настройки хранятся отдельно от выгрузки 1С и не перезаписываются синхронизацией</span>
      </div>
      {error ? <div className="empty-state">{error}</div> : null}
      {settings ? (
        <>
          <section className="panel">
            <div className="panel-title">
              <div>
                <h3>Активные точки</h3>
                <span>по умолчанию — продажи за 90 дней; решение администратора имеет приоритет</span>
              </div>
            </div>
            <div className="data-table-wrap">
              <table className="data-table settings-table">
                <thead><tr><th>Активна</th><th>Название 1С</th><th>Название в отчётах</th><th>Последняя продажа</th><th /></tr></thead>
                <tbody>
                  {settings.stores.map((store) => (
                    <tr key={store.storeKey}>
                      <td>
                        <input
                          type="checkbox"
                          checked={store.active}
                          onChange={(event) => setSettings((current) => current ? {
                            ...current,
                            stores: current.stores.map((item) => item.storeKey === store.storeKey ? { ...item, active: event.target.checked } : item)
                          } : current)}
                        />
                      </td>
                      <td>{store.sourceName}</td>
                      <td>
                        <input
                          value={store.displayName ?? ""}
                          placeholder={store.sourceName}
                          onChange={(event) => setSettings((current) => current ? {
                            ...current,
                            stores: current.stores.map((item) => item.storeKey === store.storeKey ? { ...item, displayName: event.target.value || null } : item)
                          } : current)}
                        />
                      </td>
                      <td>{formatDate(store.lastSaleAt)}</td>
                      <td><button type="button" onClick={() => saveStore(store)} disabled={savingKey !== null}>{savingKey === `store:${store.storeKey}` ? "Сохраняем" : "Сохранить"}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <div>
                <h3>Пороги и ответственные</h3>
                <span>используются центром решений; заблокированные метрики не создают ложных тревог</span>
              </div>
            </div>
            <div className="data-table-wrap">
              <table className="data-table settings-table">
                <thead><tr><th>Метрика</th><th>Норма</th><th>Тревога</th><th>Частота</th><th>Ответственный</th><th /></tr></thead>
                <tbody>
                  {settings.metrics.map((metric) => (
                    <tr key={metric.metricId}>
                      <td><MetricLabel metricId={metric.metricId as MetricId} /></td>
                      {(["normal", "critical", "cadence", "owner"] as const).map((field) => (
                        <td key={field}>
                          <input
                            value={metric[field]}
                            onChange={(event) => setSettings((current) => current ? {
                              ...current,
                              metrics: current.metrics.map((item) => item.metricId === metric.metricId ? { ...item, [field]: event.target.value } : item)
                            } : current)}
                          />
                        </td>
                      ))}
                      <td><button type="button" onClick={() => saveMetric(metric)} disabled={savingKey !== null}>{savingKey === `metric:${metric.metricId}` ? "Сохраняем" : "Сохранить"}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <div>
                <h3>Классификация статей ДДС</h3>
                <span>предложение по названию не применяется, пока финансист его не подтвердит</span>
              </div>
            </div>
            <div className="data-table-wrap">
              <table className="data-table settings-table">
                <thead><tr><th>Статья</th><th>Строк</th><th>Предложение</th><th>Поток</th><th>Подтверждено</th><th /></tr></thead>
                <tbody>
                  {settings.cashArticles.map((article) => (
                    <tr key={article.articleKey}>
                      <td>{article.articleName}</td>
                      <td>{formatNumber(article.lineCount)}</td>
                      <td>{article.suggestedFlow ? flowTypeLabels[article.suggestedFlow] : "Нет"}</td>
                      <td>
                        <select
                          value={article.flowType ?? ""}
                          onChange={(event) => setSettings((current) => current ? {
                            ...current,
                            cashArticles: current.cashArticles.map((item) => item.articleKey === article.articleKey ? {
                              ...item,
                              flowType: (event.target.value || null) as ManagementSettings["cashArticles"][number]["flowType"],
                              approved: false
                            } : item)
                          } : current)}
                        >
                          <option value="">Не классифицировано</option>
                          <option value="operating">Операционный</option>
                          <option value="investing">Инвестиционный</option>
                          <option value="financing">Финансовый</option>
                          <option value="internal">Внутреннее перемещение</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={article.approved}
                          disabled={!article.flowType}
                          onChange={(event) => setSettings((current) => current ? {
                            ...current,
                            cashArticles: current.cashArticles.map((item) => item.articleKey === article.articleKey ? { ...item, approved: event.target.checked } : item)
                          } : current)}
                        />
                      </td>
                      <td>
                        <button type="button" onClick={() => saveCashArticle(article)} disabled={savingKey !== null}>
                          {savingKey === `article:${article.articleKey}` ? "Сохраняем" : "Сохранить"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}

const flowTypeLabels: Record<NonNullable<ManagementSettings["cashArticles"][number]["flowType"]>, string> = {
  operating: "Операционный",
  investing: "Инвестиционный",
  financing: "Финансовый",
  internal: "Внутреннее перемещение"
};

function SourceHealthPanel({ state }: { state: LoadState<SourceHealth> }) {
  return (
    <section className="reports-section">
      <div className="section-heading">
        <h2>Качество и полнота источников</h2>
        <span>нули не считаются достоверными, когда источник отсутствует</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Проверяем источники" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <div className="source-health-grid">
            {state.data.issues.map((issue) => (
              <article className={`source-health-card ${issue.severity}`} key={issue.key}>
                <strong>{issue.title}</strong>
                <span>{issue.detail}</span>
              </article>
            ))}
          </div>
          <div className="metric-note">
            {state.data.reconciliation.grossHeaderRevenue === 0 &&
            state.data.reconciliation.grossLineRevenue === 0 ? (
              <>Отчёты розницы за выбранный период не загружены — сверка шапок и строк недоступна.</>
            ) : (
              <>
                Сверка продаж: заголовки {formatMoney(state.data.reconciliation.grossHeaderRevenue)},
                строки {formatMoney(state.data.reconciliation.grossLineRevenue)}; возвраты в
                заголовках {formatMoney(state.data.reconciliation.headerReturns)}, в строках{" "}
                {formatMoney(state.data.reconciliation.lineReturns)}.
              </>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

function LossMetricsPanel({ state }: { state: LoadState<LossMetrics> }) {
  return (
    <section className="reports-section">
      <div className="section-heading">
        <h2>Потери по точкам</h2>
        <span>списания минус оприходованные излишки</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Считаем потери" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Метрики потерь">
            <MetricCard icon={<Receipt size={18} />} metricId="loss.writeoffs" label="Списания" value={formatMoney(state.data.summary.writeoffs)} />
            <MetricCard icon={<Package size={18} />} metricId="loss.surpluses" label="Излишки" value={formatMoney(state.data.summary.surpluses)} />
            <MetricCard
              icon={<TrendingUp size={18} />}
              metricId="loss.result"
              label="Результат ревизий"
              value={state.data.summary.netLosses < 0 ? `Излишек ${formatMoney(Math.abs(state.data.summary.netLosses))}` : formatMoney(state.data.summary.netLosses)}
            />
            <MetricCard icon={<BarChart3 size={18} />} metricId="loss.rate" label="Потери / выручка" value={`${formatDecimal(state.data.summary.lossPct, 2)}%`} />
          </section>
          <div className="metric-note">{state.data.definition}</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Точка</th>
                  <th><MetricLabel metricId="loss.writeoffs">Списания</MetricLabel></th>
                  <th><MetricLabel metricId="loss.surpluses">Излишки</MetricLabel></th>
                  <th><MetricLabel metricId="loss.result">Результат ревизий</MetricLabel></th>
                  <th><MetricLabel metricId="loss.rate">% выручки</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {state.data.stores.map((row) => (
                  <tr key={row.storeKey}>
                    <td>{row.storeName}</td>
                    <td>{formatMoney(row.writeoffs)}</td>
                    <td>{formatMoney(row.surpluses)}</td>
                    <td>{row.netLosses < 0 ? `Излишек ${formatMoney(Math.abs(row.netLosses))}` : formatMoney(row.netLosses)}</td>
                    <td>{row.lossPct === null ? "—" : `${formatDecimal(row.lossPct, 2)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function AcquiringMetricsPanel({ state }: { state: LoadState<AcquiringMetrics> }) {
  return (
    <section className="reports-section">
      <div className="section-heading">
        <h2>Эквайринг</h2>
        <span>продажи и возвраты из регистра платёжных карт 1С</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Считаем эквайринг" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Метрики эквайринга">
            <MetricCard icon={<TrendingUp size={18} />} metricId="acquiring.sales" label="Продажи картами" value={formatMoney(state.data.summary.sales)} />
            <MetricCard icon={<RotateCcw size={18} />} metricId="acquiring.returns" label="Возвраты на карты" value={formatMoney(state.data.summary.returns)} />
            <MetricCard icon={<Receipt size={18} />} metricId="acquiring.turnover" label="Чистый карточный оборот" value={formatMoney(state.data.summary.turnover)} />
            <MetricCard icon={<ShoppingCart size={18} />} metricId="acquiring.commission" label="Комиссия" value={state.data.summary.commission === null ? null : formatMoney(state.data.summary.commission)} status={state.data.summary.commissionStatus} reason={state.data.summary.commission === null ? state.data.limitation : undefined} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="acquiring.rate" label="Средняя ставка" value={state.data.summary.commissionPct === null ? null : `${formatDecimal(state.data.summary.commissionPct, 2)}%`} status={state.data.summary.commissionStatus} />
            <MetricCard icon={<Table2 size={18} />} metricId="acquiring.lines" label="Движений регистра" value={formatNumber(state.data.summary.recordCount)} />
          </section>
          <div className="metric-note warning">{state.data.limitation}</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Точка</th>
                  <th><MetricLabel metricId="acquiring.sales">Продажи</MetricLabel></th>
                  <th><MetricLabel metricId="acquiring.returns">Возвраты</MetricLabel></th>
                  <th><MetricLabel metricId="acquiring.turnover">Чистый оборот</MetricLabel></th>
                  <th><MetricLabel metricId="acquiring.commission">Комиссия</MetricLabel></th>
                  <th><MetricLabel metricId="acquiring.rate">Ставка</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {state.data.stores.map((row) => (
                  <tr key={row.storeKey}>
                    <td>{row.storeName}</td>
                    <td>{formatMoney(row.sales)}</td>
                    <td>{formatMoney(row.returns)}</td>
                    <td>{formatMoney(row.turnover)}</td>
                    <td>{row.commission === null ? "Нет данных" : formatMoney(row.commission)}</td>
                    <td>{row.commissionPct === null ? "Нет данных" : `${formatDecimal(row.commissionPct, 2)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function CashArticleMetricsPanel({ state }: { state: LoadState<CashArticleMetrics> }) {
  return (
    <section className="reports-section">
      <div className="section-heading">
        <h2>Кассовый ОДДС</h2>
        <span>Три потока по ПКО/РКО; классификация подтверждается финансистом; банк не подключён</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Собираем кассовые движения" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Кассовые движения">
            <MetricCard
              icon={<TrendingUp size={18} />}
              metricId="cash.inflow"
              label="Приход по строкам ОДДС"
              value={formatMoney(state.data.summary.externalInflow)}
              status="partial"
              reason={`Исключено по строкам: ${formatMoney(state.data.summary.internalInflow)}. Сумма включает структурные и подтверждённые финансистом исключения; неподтверждённые статьи-перемещения остаются в приходе.`}
            />
            <MetricCard
              icon={<Receipt size={18} />}
              metricId="cash.outflow"
              label="Расход по строкам ОДДС"
              value={formatMoney(state.data.summary.externalOutflow)}
              status="partial"
              reason={`Исключено по строкам: ${formatMoney(state.data.summary.internalOutflow)}. Сумма включает структурные и подтверждённые финансистом исключения; неподтверждённые статьи-перемещения остаются в расходе.`}
            />
            <MetricCard
              icon={<BarChart3 size={18} />}
              metricId="cash.net"
              label="Чистое движение строк"
              value={formatMoney(state.data.summary.net)}
              status="partial"
              reason="До подтверждения статей-перемещений это не полный внешний денежный поток."
            />
            <MetricCard icon={<Table2 size={18} />} metricId="cash.categorized" label="Строк со статьёй" value={`${formatDecimal(state.data.summary.categorizedPct, 1)}%`} />
          </section>
          <section className="metric-grid report-metric-grid" aria-label="Три потока кассового ОДДС">
            <MetricCard
              icon={<TrendingUp size={18} />}
              metricId="cash.operating"
              value={state.data.statement.status === "unavailable" ? null : formatMoney(state.data.statement.flows.operating.net ?? 0)}
              status={state.data.statement.status === "unavailable" ? "unavailable" : "partial"}
              reason={state.data.statement.status === "unavailable" ? "Финансист ещё не подтвердил статьи ни одного денежного потока." : "Кассовая часть потока; банковская часть не подключена."}
            />
            <MetricCard
              icon={<BarChart3 size={18} />}
              metricId="cash.investing"
              value={state.data.statement.status === "unavailable" ? null : formatMoney(state.data.statement.flows.investing.net ?? 0)}
              status={state.data.statement.status === "unavailable" ? "unavailable" : "partial"}
              reason={state.data.statement.status === "unavailable" ? "Финансист ещё не подтвердил статьи ни одного денежного потока." : "Кассовая часть потока; банковская часть не подключена."}
            />
            <MetricCard
              icon={<Receipt size={18} />}
              metricId="cash.financing"
              value={state.data.statement.status === "unavailable" ? null : formatMoney(state.data.statement.flows.financing.net ?? 0)}
              status={state.data.statement.status === "unavailable" ? "unavailable" : "partial"}
              reason={state.data.statement.status === "unavailable" ? "Финансист ещё не подтвердил статьи ни одного денежного потока." : "Кассовая часть потока; банковская часть не подключена."}
            />
            <MetricCard
              icon={<ShieldCheck size={18} />}
              metricId="cash.unclassified"
              value={formatMoney(state.data.statement.unclassifiedTurnover)}
              status={state.data.statement.unclassifiedTurnover > 0 ? "partial" : "ready"}
              reason={`Покрытие подтверждённой классификацией: ${formatDecimal(state.data.statement.classifiedCoveragePct, 1)}%. Неподтверждённые статьи-перемещения остаются здесь до решения финансиста.`}
            />
            <MetricCard
              icon={<ArrowLeftRight size={18} />}
              metricId="cash.internal"
              label="Внутренние перемещения"
              value={state.data.statement.internalTransferStatus === "unavailable" ? null : formatMoney(state.data.statement.internalTransferTurnover)}
              status={state.data.statement.internalTransferStatus}
              reason={state.data.statement.internalTransferStatus === "unavailable" ? "Финансист ещё не подтвердил статьи внутренних перемещений." : `Из трёх потоков исключено; ${formatNumber(state.data.statement.unallocatedInternalDocumentCount)} документов без строк учтены по суммам заголовков.`}
            />
          </section>
          <section className="metric-grid report-metric-grid" aria-label="Недоступные финансовые метрики">
            <MetricCard icon={<ShieldCheck size={18} />} metricId="cash.reconciliation" value={null} status="unavailable" reason="§4.4 требует банковских выписок и остатков по счетам." />
            <MetricCard icon={<ShieldCheck size={18} />} metricId="pnl.intercompany-markup" value={null} status="unavailable" reason="§7.5 требует утверждённой политики и связей внутренних поставок между ИП." />
          </section>
          <div className="metric-note warning">{state.data.limitation}</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Статья ДДС</th>
                  <th>Подтверждённый поток</th>
                  <th><MetricLabel metricId="cash.inflow">Приход после исключений</MetricLabel></th>
                  <th><MetricLabel metricId="cash.outflow">Расход после исключений</MetricLabel></th>
                  <th><MetricLabel metricId="cash.net">Чистое движение</MetricLabel></th>
                  <th><MetricLabel metricId="cash.internal">Внутри</MetricLabel></th>
                  <th>Операций</th>
                </tr>
              </thead>
              <tbody>
                {state.data.articles.map((row) => (
                  <tr key={row.articleKey}>
                    <td>{row.articleName}</td>
                    <td>{row.flowType ? flowTypeLabels[row.flowType] : "Не классифицировано"}</td>
                    <td>{formatMoney(row.inflow)}</td>
                    <td>{formatMoney(row.outflow)}</td>
                    <td>{formatMoney(row.net)}</td>
                    <td>{row.internalLineCount > 0 ? formatMoney(Math.abs(row.internalInflow) + Math.abs(row.internalOutflow)) : "—"}</td>
                    <td>{formatNumber(row.lineCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function SupplierTermsPanel({ state }: { state: LoadState<SupplierTermsMetrics> }) {
  return (
    <section className="reports-section">
      <div className="section-heading">
        <h2>Заказы и график оплаты поставщикам</h2>
        <span>плановые этапы заказов; исполнение — связанные поступления</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Считаем заказы поставщикам" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Условия поставщиков">
            <MetricCard
              icon={<Clock size={18} />}
              metricId="supplier.deferral"
              label="Средняя плановая отсрочка"
              value={state.data.summary.weightedDeferralDays === null ? null : `${formatDecimal(state.data.summary.weightedDeferralDays, 1)} дн.`}
              status={state.data.summary.status}
              coveragePct={state.data.summary.stageCoveragePct}
              reason={state.data.summary.weightedDeferralDays === null ? state.data.limitation : undefined}
            />
            <MetricCard icon={<Receipt size={18} />} metricId="supplier.orders" label="Заказов" value={formatNumber(state.data.summary.orderCount)} />
            <MetricCard icon={<CalendarDays size={18} />} metricId="supplier.staged-orders" label="С этапами оплаты" value={formatNumber(state.data.summary.stagedOrderCount)} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="supplier.coverage" label="Покрытие этапами" value={`${formatDecimal(state.data.summary.stageCoveragePct, 1)}%`} status={state.data.summary.status} />
            <MetricCard icon={<ShoppingCart size={18} />} metricId="supplier.ordered-amount" label="Заказано" value={formatMoney(state.data.summary.orderedAmount)} />
            <MetricCard icon={<Boxes size={18} />} metricId="supplier.received-amount" label="Поступило по заказам" value={formatMoney(state.data.summary.receivedAmount)} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="supplier.execution" label="Исполнение" value={state.data.summary.executionPct === null ? null : `${formatDecimal(state.data.summary.executionPct, 1)}%`} />
            <MetricCard icon={<CalendarDays size={18} />} metricId="supplier.next-30" value={formatMoney(state.data.summary.next30DayScheduledAmount)} status="partial" reason="Только этапы открытых заказов; факт оплаты банком неизвестен." />
            <MetricCard icon={<CalendarDays size={18} />} metricId="supplier.next-56" value={formatMoney(state.data.summary.next56DayScheduledAmount)} status="partial" />
          </section>
          <div className="metric-note warning">{state.data.limitation}</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Плановая дата</th>
                  <th>Контрагент</th>
                  <th><MetricLabel metricId="supplier.scheduled-amount">Сумма этапов</MetricLabel></th>
                  <th><MetricLabel metricId="supplier.staged-orders">Заказов</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {state.data.schedule.map((row) => (
                  <tr key={`${row.dueDay}-${row.counterpartyName}`}>
                    <td>{formatDate(row.dueDay)}</td>
                    <td>{row.counterpartyName}</td>
                    <td>{formatMoney(row.amount)}</td>
                    <td>{formatNumber(row.documentCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="section-heading">
            <h3>Плановые этапы открытых заказов · 8 недель</h3>
            <span>не вся кредиторская задолженность; оплаты банком не подтверждены</span>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Плановая дата</th>
                  <th>Контрагент</th>
                  <th><MetricLabel metricId="supplier.scheduled-amount">Сумма этапов</MetricLabel></th>
                  <th><MetricLabel metricId="supplier.staged-orders">Заказов</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {state.data.upcomingSchedule.map((row) => (
                  <tr key={`upcoming-${row.dueDay}-${row.counterpartyName}`}>
                    <td>{formatDate(row.dueDay)}</td>
                    <td>{row.counterpartyName}</td>
                    <td>{formatMoney(row.amount)}</td>
                    <td>{formatNumber(row.documentCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function MoneyPositionPanel({ state }: { state: LoadState<MoneyPositionMetrics> }) {
  return (
    <section className="reports-section">
      <div className="section-heading">
        <h2>Деньги в точках</h2>
        <span>срез касс и ККМ 1С; банковские счета не подключены</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Собираем остатки денег" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Остатки денег">
            <MetricCard icon={<Receipt size={18} />} metricId="money.cash" label="Кассы" value={formatMoney(state.data.summary.cashBalance)} />
            <MetricCard icon={<Store size={18} />} metricId="money.kkm" label="В ККМ" value={formatMoney(state.data.summary.kkmBalance)} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="money.cash-total" label="Наличные итого" value={formatMoney(state.data.summary.totalCash)} status="partial" reason="Банковские счета в сумму не входят." />
            <MetricCard icon={<Database size={18} />} metricId="money.bank" label="Банк" value={null} status="unavailable" reason="В публикации 1С нет движений и остатков банка." />
            <MetricCard icon={<ShieldCheck size={18} />} metricId="supplier.balance-raw" label="К оплате · знак 1С" value={formatMoney(state.data.summary.supplierPayableRaw)} status="experimental" reason="Знак регистра ещё не утверждён финансистом." />
            <MetricCard icon={<Clock size={18} />} metricId="money.cash-days" value={state.data.summary.uncollectedCashDays === null ? null : `${formatDecimal(state.data.summary.uncollectedCashDays, 1)} дн.`} status={state.data.summary.cashDaysStatus} coveragePct={state.data.summary.cashSalesCoveragePct} reason={state.data.summary.uncollectedCashDays === null ? "Недостаточно дней наличной выручки для расчёта." : undefined} />
          </section>
          <div className="metric-note warning">{state.data.limitation}</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Точка</th>
                  <th><MetricLabel metricId="money.cash">Касса</MetricLabel></th>
                  <th><MetricLabel metricId="money.kkm">ККМ</MetricLabel></th>
                  <th><MetricLabel metricId="money.cash-total">Итого без банка</MetricLabel></th>
                  <th><MetricLabel metricId="money.cash-days">Дней в ККМ</MetricLabel></th>
                  <th><MetricLabel metricId="supplier.balance-raw">К оплате · знак 1С</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {state.data.stores.map((row) => (
                  <tr key={row.storeKey}>
                    <td>{row.storeName}</td>
                    <td>{formatMoney(row.cashBalance)}</td>
                    <td>{formatMoney(row.kkmBalance)}</td>
                    <td>{formatMoney(row.totalCash)}</td>
                    <td>{row.uncollectedCashDays === null ? "—" : formatDecimal(row.uncollectedCashDays, 1)}</td>
                    <td>{formatMoney(row.supplierPayableRaw)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function LostSalesPanel({ state }: { state: LoadState<LostSalesMetrics> }) {
  return (
    <section className="reports-section">
      <div className="section-heading">
        <h2>Lost Sales</h2>
        <span>денежная оценка дефицита A/B-позиций по дневным остаткам</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Считаем Lost Sales" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Lost Sales">
            <MetricCard icon={<TrendingUp size={18} />} metricId="lost.sales" label="Lost Sales" value={state.data.summary.lostSales === null ? null : formatMoney(state.data.summary.lostSales)} status={state.data.summary.status} coveragePct={state.data.summary.coveragePct} reason={state.data.summary.lostSales === null ? "Недостаточно дней чеков или дневных снимков для доверенной денежной оценки." : undefined} />
            <MetricCard icon={<CalendarDays size={18} />} metricId="lost.zero-stock-days" label="Товаро-дней без остатка" value={formatNumber(state.data.summary.zeroStockItemDays)} status={state.data.summary.status} />
            <MetricCard icon={<Package size={18} />} metricId="lost.items" label="Затронуто A/B-позиций" value={formatNumber(state.data.summary.affectedItemCount)} />
            <MetricCard icon={<Database size={18} />} metricId="lost.snapshot-coverage" label="Покрытие источниками" value={`${formatDecimal(state.data.summary.coveragePct, 1)}%`} status={state.data.summary.status} detail={`остатки ${formatNumber(state.data.summary.snapshotDays)} дн. · чеки ${formatNumber(state.data.summary.checkDays)} дн.`} />
          </section>
          <div className="metric-note">{state.data.methodology}</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Точка</th>
                  <th>Товар</th>
                  <th>ABC</th>
                  <th>Дней без остатка</th>
                  <th><MetricLabel metricId="lost.sales">Lost Sales</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {state.data.items.map((row) => (
                  <tr key={`${row.storeKey}-${row.itemKey}`}>
                    <td>{row.storeName}</td>
                    <td>{row.itemName}</td>
                    <td>{row.abcClass}</td>
                    <td>{formatNumber(row.zeroStockDays)}</td>
                    <td>{formatMoney(row.lostSales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function PurchasingRecommendationsPanel({
  state
}: {
  state: LoadState<PurchasingRecommendations>;
}) {
  return (
    <section className="reports-section">
      <div className="section-heading">
        <h2>Закупочный бюджет и рекомендации</h2>
        <span>норматив, прогноз на 7 дней, остаток, открытые заказы и каноническая себестоимость</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Формируем рекомендации" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Рекомендации к закупке">
            <MetricCard icon={<ShoppingCart size={18} />} metricId="purchase.recommendations" label="Позиций к заказу" value={formatNumber(state.data.summary.recommendationCount)} />
            <MetricCard icon={<Boxes size={18} />} metricId="purchase.quantity" label="Рекомендовано единиц" value={formatDecimal(state.data.summary.recommendedQty)} />
            <MetricCard icon={<ShieldCheck size={18} />} metricId="purchase.supplier-coverage" label="С основным поставщиком" value={formatNumber(state.data.summary.recommendationsWithSupplier)} />
            <MetricCard icon={<Receipt size={18} />} metricId="purchase.budget" value={state.data.summary.purchaseBudgetAmount === null ? null : formatMoney(state.data.summary.purchaseBudgetAmount)} status={state.data.summary.budgetStatus} coveragePct={state.data.summary.budgetCostCoveragePct} reason={state.data.summary.purchaseBudgetAmount === null ? `Наблюдаемая оценённая часть: ${formatMoney(state.data.summary.observedPurchaseBudgetAmount)}` : undefined} />
            <MetricCard icon={<ShoppingCart size={18} />} metricId="purchase.ordered" value={formatMoney(state.data.summary.orderedAmount)} detail="последние 7 дней" />
            <MetricCard icon={<TrendingUp size={18} />} metricId="purchase.execution" value={state.data.summary.budgetExecutionPct === null ? null : `${formatDecimal(state.data.summary.budgetExecutionPct, 1)}%`} status={state.data.summary.executionStatus} coveragePct={state.data.summary.executionCostCoveragePct} />
          </section>
          <div className="metric-note">{state.data.methodology}</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Точка</th>
                  <th>Товар</th>
                  <th>Поставщик</th>
                  <th>Остаток</th>
                  <th>В заказах</th>
                  <th>Норматив</th>
                  <th><MetricLabel metricId="purchase.forecast">Прогноз 7 дн.</MetricLabel></th>
                  <th>Дней запаса</th>
                  <th><MetricLabel metricId="purchase.quantity">Заказать до норматива</MetricLabel></th>
                  <th><MetricLabel metricId="purchase.budget-quantity">Бюджет, ед.</MetricLabel></th>
                  <th><MetricLabel metricId="purchase.budget">Бюджет, ₸</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {state.data.recommendations.map((row) => (
                  <tr key={`${row.storeKey}-${row.itemKey}`}>
                    <td>{row.storeName}</td>
                    <td>{row.itemName}</td>
                    <td>{row.supplierName ?? "Не указан"}</td>
                    <td>{formatDecimal(row.stockQty)}</td>
                    <td>{formatDecimal(row.openOrderQty)}</td>
                    <td>{formatDecimal(row.targetStock)}</td>
                    <td>{formatDecimal(row.forecastQty7d)}</td>
                    <td>{row.daysOfStock === null ? "Нет продаж" : formatDecimal(row.daysOfStock, 1)}</td>
                    <td>{formatDecimal(row.recommendedQty)}</td>
                    <td>{formatDecimal(row.purchaseBudgetQty)}</td>
                    <td>{row.purchaseBudgetAmount === null ? "—" : formatMoney(row.purchaseBudgetAmount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function StoreStockPanel({ state }: { state: LoadState<StoreStockMetrics> }) {
  return (
    <section className="reports-section">
      <div className="section-heading">
        <h2>Остатки в деньгах по точкам</h2>
        <span>последний снимок каждого товарного остатка с контролем покрытия себестоимости</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Оцениваем остатки" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Остатки по точкам">
            <MetricCard icon={<ShoppingCart size={18} />} metricId="stock.cost" label="Оценённый запас, минимум" value={formatMoney(state.data.summary.stockCost)} status={state.data.summary.unvaluedQty > 0 ? "partial" : "ready"} coveragePct={state.data.summary.costCoveragePct} asOf={state.data.summary.snapshotAt} />
            <MetricCard icon={<Boxes size={18} />} metricId="stock.quantity" label="Количество" value={formatDecimal(state.data.summary.stockQty)} />
            <MetricCard icon={<Package size={18} />} metricId="stock.available" label="Доступно" value={formatDecimal(state.data.summary.availableQty)} />
            <MetricCard icon={<Receipt size={18} />} metricId="stock.reserved" label="В резерве" value={formatDecimal(state.data.summary.reservedQty)} />
            <MetricCard icon={<RotateCcw size={18} />} metricId="stock.negative" label="Отрицательный остаток" value={formatDecimal(state.data.summary.negativeStockQty)} />
            <MetricCard icon={<Package size={18} />} metricId="stock.unvalued" label="Без стоимости" value={formatDecimal(state.data.summary.unvaluedQty)} status={state.data.summary.unvaluedQty > 0 ? "partial" : "ready"} />
            <MetricCard icon={<ShieldCheck size={18} />} metricId="stock.coverage" label="Покрытие стоимости" value={`${formatDecimal(state.data.summary.costCoveragePct, 1)}%`} />
          </section>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Точка</th>
                  <th>Снимок</th>
                  <th><MetricLabel metricId="stock.positions">Позиций</MetricLabel></th>
                  <th><MetricLabel metricId="stock.quantity">Количество</MetricLabel></th>
                  <th><MetricLabel metricId="stock.reserved">Резерв</MetricLabel></th>
                  <th><MetricLabel metricId="stock.negative">Отриц. остаток</MetricLabel></th>
                  <th><MetricLabel metricId="stock.cost">Оценённая себестоимость</MetricLabel></th>
                  <th><MetricLabel metricId="stock.coverage">Покрытие цены</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {state.data.stores.map((row) => (
                  <tr key={row.storeKey}>
                    <td>{row.storeName}</td>
                    <td>{formatDate(row.snapshotAt)}</td>
                    <td>{formatNumber(row.itemCount)}</td>
                    <td>{formatDecimal(row.stockQty)}</td>
                    <td>{formatDecimal(row.reservedQty)}</td>
                    <td>{formatDecimal(row.negativeStockQty)}</td>
                    <td>{formatMoney(row.stockCost)}</td>
                    <td>{formatDecimal(row.costCoveragePct, 1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ReportFilterBar({
  period,
  onPeriodChange,
  dateRange,
  onDateRangeChange,
  periodLabel = "Группировка"
}: {
  period?: SalesPeriod;
  onPeriodChange?: (period: SalesPeriod) => void;
  dateRange: DateRangeValue;
  onDateRangeChange: (dateRange: DateRangeValue) => void;
  periodLabel?: string;
}) {
  const [draftRange, setDraftRange] = useState<DateRangeValue>(dateRange);

  useEffect(() => {
    setDraftRange(dateRange);
  }, [dateRange.from, dateRange.to]);

  const defaultRange = currentMonthRange();
  const isDefaultRange =
    draftRange.from === defaultRange.from && draftRange.to === defaultRange.to;
  const hasChanges =
    draftRange.from !== dateRange.from || draftRange.to !== dateRange.to;
  const invalidRange = Boolean(
    draftRange.from && draftRange.to && draftRange.from > draftRange.to
  );

  return (
    <div className="report-controls">
      {period && onPeriodChange ? (
        <div className="segmented-control" aria-label={periodLabel}>
          {periodOptions.map((option) => (
            <button
              key={option.value}
              className={option.value === period ? "active" : ""}
              onClick={() => onPeriodChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="date-range-control" aria-label="Диапазон дат отчета">
        <label>
          <span>С</span>
          <input
            type="date"
            value={draftRange.from}
            max={draftRange.to || undefined}
            onChange={(event) =>
              setDraftRange({ ...draftRange, from: event.target.value })
            }
          />
        </label>
        <label>
          <span>По</span>
          <input
            type="date"
            value={draftRange.to}
            min={draftRange.from || undefined}
            onChange={(event) =>
              setDraftRange({ ...draftRange, to: event.target.value })
            }
          />
        </label>
        {isDefaultRange ? null : (
          <button
            className="date-reset-button"
            type="button"
            onClick={() => {
              setDraftRange(defaultRange);
              onDateRangeChange(defaultRange);
            }}
            title="Вернуть текущий месяц"
          >
            <RotateCcw size={15} />
            <span>Текущий месяц</span>
          </button>
        )}
        <button
          className="date-apply-button"
          type="button"
          disabled={!hasChanges || invalidRange}
          onClick={() => {
            const next = draftRange.from || draftRange.to ? draftRange : defaultRange;
            setDraftRange(next);
            onDateRangeChange(next);
          }}
        >
          Применить
        </button>
      </div>
    </div>
  );
}

function SalesReports({
  dateRange,
  onDateRangeChange
}: {
  dateRange: DateRangeValue;
  onDateRangeChange: (dateRange: DateRangeValue) => void;
}) {
  const [period, setPeriod] = useState<SalesPeriod>("day");
  const [reportState, setReportState] = useState<LoadState<SalesReport>>({
    status: "loading"
  });

  useEffect(() => {
    const controller = new AbortController();
    setReportState({ status: "loading" });
    api
      .salesReport({ period, ...dateRange }, controller.signal)
      .then((report) => {
        if (!controller.signal.aborted) {
          setReportState({ status: "success", data: report });
        }
      })
      .catch((caught) => {
        if (controller.signal.aborted) {
          return;
        }

        setReportState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить отчеты"
        });
      });

    return () => controller.abort();
  }, [dateRange.from, dateRange.to, period]);

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Продажи по чекам ККМ</h2>
          <span>
            document_chek_kkm · document_chek_kkm_tovary · сверка с
            document_otchet_o_roznichnyh_prodazhah
          </span>
        </div>
        <ReportFilterBar
          period={period}
          onPeriodChange={setPeriod}
          dateRange={dateRange}
          onDateRangeChange={onDateRangeChange}
          periodLabel="Группировка выручки"
        />
      </div>

      {reportState.status === "loading" ? (
        <div className="empty-state">Загружаем отчеты</div>
      ) : null}

      {reportState.status === "error" ? (
        <div className="empty-state">{reportState.error}</div>
      ) : null}

      {reportState.status === "success" ? (
        <SalesReportBody report={reportState.data} period={period} />
      ) : null}
    </section>
  );
}

function SalesReportBody({
  report,
  period
}: {
  report: SalesReport;
  period: SalesPeriod;
}) {
  const [selectedWeekday, setSelectedWeekday] = useState(1);
  const heatmapWeekdays = useMemo(
    () => getHeatmapWeekdays(report.heatmap.days),
    [report.heatmap.days]
  );
  const activeWeekday =
    heatmapWeekdays.find((weekday) => weekday.value === selectedWeekday) ??
    heatmapWeekdays[0] ??
    null;

  return (
    <>
      <section className="metric-grid report-metric-grid" aria-label="Метрики продаж">
        <MetricCard
          icon={<Receipt size={18} />}
          metricId="sales.check-gross"
          label="Продажи до возвратов"
          value={formatMoney(report.summary.grossRevenue)}
          status={report.summary.checkStatus}
          coveragePct={report.summary.checkCoveragePct ?? undefined}
        />
        <MetricCard
          icon={<RotateCcw size={18} />}
          metricId="sales.check-returns"
          label="Возвраты"
          value={formatMoney(report.summary.returns)}
          status={report.summary.checkStatus}
          coveragePct={report.summary.checkCoveragePct ?? undefined}
          detail={`${formatNumber(report.summary.returnCount)} возвратных чеков`}
        />
        <MetricCard
          icon={<TrendingUp size={18} />}
          metricId="sales.check-net"
          label="Чистая выручка"
          value={formatMoney(report.summary.revenue)}
          status={report.summary.checkStatus}
          coveragePct={report.summary.checkCoveragePct ?? undefined}
        />
        <MetricCard
          icon={<ShoppingCart size={18} />}
          metricId="sales.checks"
          label="Чеков продаж"
          value={formatNumber(report.summary.orderCount)}
          status={report.summary.checkStatus}
          coveragePct={report.summary.checkCoveragePct ?? undefined}
        />
        <MetricCard
          icon={<CalendarDays size={18} />}
          metricId="sales.avg-check"
          label="Средний чек"
          value={formatMoney(report.summary.avgCheck)}
          status={report.summary.checkStatus}
          coveragePct={report.summary.checkCoveragePct ?? undefined}
        />
        <MetricCard
          icon={<Store size={18} />}
          metricId="sales.avg-items-per-check"
          label="Среднее количество единиц в чеке"
          value={formatDecimal(report.summary.avgItemsPerCheck, 2)}
          status={report.summary.checkStatus}
          coveragePct={report.summary.checkCoveragePct ?? undefined}
        />
      </section>
      {report.summary.checkStatus === "partial" ? (
        <div className="metric-note warning">
          Чеки загружены за {formatNumber(report.summary.coveredDays)} из{" "}
          {formatDecimal(report.summary.expectedDays ?? 0)} прошедших дней периода.
          Суммы и средний чек показаны только по загруженному подмножеству.
        </div>
      ) : null}

      <div className="reports-grid">
        <section className="panel report-chart-panel">
          <div className="panel-title">
            <h3><MetricLabel metricId="sales.check-net">Чистая выручка по чекам</MetricLabel></h3>
            <span>
              {formatDate(report.summary.dateFrom)} — {formatDate(report.summary.dateTo)}
            </span>
          </div>
          <div className="chart-wrap compact">
            {report.revenueSeries.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={report.revenueSeries}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={(value) => formatBucket(String(value), period)}
                    minTickGap={18}
                  />
                  <YAxis tickFormatter={formatMoneyCompact} width={78} />
                  <Tooltip
                    labelFormatter={(value) => formatBucket(String(value), period)}
                    formatter={(value, name) => [
                      name === "revenue"
                        ? formatMoney(Number(value))
                        : formatNumber(Number(value)),
                      name === "revenue" ? "Выручка" : "Чеки"
                    ]}
                    labelStyle={{ color: "#172033" }}
                  />
                  <Bar dataKey="revenue" fill="#2864d8" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state inset">Нет продаж за выбранный период</div>
            )}
          </div>
        </section>

        <section className="panel report-side-panel">
          <div className="panel-title">
            <h3>Сверка чеков и отчётов</h3>
          </div>
          <div className="stack-list">
            <div className="summary-row">
              <strong>Чеков загружено</strong>
              <span>{formatNumber(report.reconciliation.loadedCheckCount)}</span>
            </div>
            <div className="summary-row">
              <strong>Связано с отчётом розницы</strong>
              <span>{formatDecimal(report.reconciliation.linkedCheckPct, 1)}%</span>
            </div>
            <div className="summary-row">
              <strong>Отчётов розницы, связанных с чеками</strong>
              <span>{formatNumber(report.summary.reportCount)}</span>
            </div>
            <div className="summary-row">
              <strong>Разница выручки</strong>
              <span>
                {report.reconciliation.difference === null
                  ? "Не сравнимо — отчётов розницы за период нет"
                  : formatMoney(report.reconciliation.difference)}
              </span>
            </div>
            <div className="summary-row">
              <strong>Дней с отчётами розницы</strong>
              <span>{formatNumber(report.reconciliation.retailReportDays)}</span>
            </div>
            <div className="summary-row">
              <strong>Периодов на графике</strong>
              <span>{formatNumber(report.revenueSeries.length)}</span>
            </div>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3><MetricLabel metricId="sales.check-composition">Состав чеков · топ товаров</MetricLabel></h3>
          <span>доля чеков продажи, в которых встречался товар</span>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Товар</th>
                <th>Количество</th>
                <th>Чеков</th>
                <th>Доля чеков</th>
                <th>Чистая выручка</th>
              </tr>
            </thead>
            <tbody>
              {report.composition.map((row) => (
                <tr key={row.itemKey}>
                  <td>{row.itemName}</td>
                  <td>{formatDecimal(row.quantity, 2)}</td>
                  <td>{formatNumber(row.checkCount)}</td>
                  <td>{formatDecimal(row.checkSharePct, 1)}%</td>
                  <td>{formatMoney(row.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {heatmapWeekdays.length > 0 ? (
        <div className="heatmap-weekday-toolbar">
          <strong>День недели</strong>
          <div className="weekday-selector" aria-label="День недели для тепловой карты">
            {heatmapWeekdays.map((weekday) => (
              <button
                key={weekday.key}
                className={activeWeekday?.value === weekday.value ? "active" : ""}
                onClick={() => setSelectedWeekday(weekday.value)}
                title={`${weekday.label}\nДаты: ${weekday.title}`}
                type="button"
              >
                {weekday.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-title">
          <h3>Тепловая карта чеков по часам</h3>
          <span>чеки ККМ, строка = магазин, колонка = час</span>
        </div>
        {activeWeekday ? (
          <SalesHeatmap
            report={report}
            metric="checks"
            weekday={activeWeekday.value}
            weekdayLabel={activeWeekday.label}
          />
        ) : (
          <div className="empty-state inset">Нет данных для тепловой карты</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Тепловая карта выручки по часам</h3>
          <span>чеки ККМ, строка = магазин, колонка = час</span>
        </div>
        {activeWeekday ? (
          <SalesHeatmap
            report={report}
            metric="revenue"
            weekday={activeWeekday.value}
            weekdayLabel={activeWeekday.label}
          />
        ) : (
          <div className="empty-state inset">Нет данных для тепловой карты</div>
        )}
      </section>
    </>
  );
}

type HeatmapMetric = "checks" | "revenue";

const weekdayLabels = [
  "",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
  "Воскресенье"
];

function getHeatmapWeekdays(days: string[]) {
  return Array.from(new Set(days.map(getIsoWeekday)))
    .filter((weekday) => weekday > 0)
    .sort((left, right) => left - right)
    .map((weekday) => {
      const weekdayDays = days
        .filter((day) => getIsoWeekday(day) === weekday)
        .sort();

      return {
        key: `weekday-${weekday}`,
        value: weekday,
        label: weekdayLabels[weekday],
        title: formatHeatmapDateList(weekdayDays)
      };
    });
}

function SalesHeatmap({
  report,
  metric,
  weekday,
  weekdayLabel
}: {
  report: SalesReport;
  metric: HeatmapMetric;
  weekday: number;
  weekdayLabel: string;
}) {
  const aggregatedCells = useMemo(() => {
    const cells = new Map<string, { revenue: number; orderCount: number }>();

    for (const cell of report.heatmap.cells) {
      if (getIsoWeekday(cell.day) !== weekday) {
        continue;
      }

      const key = `${cell.storeKey}-${cell.hour}`;
      const current = cells.get(key) ?? { revenue: 0, orderCount: 0 };
      current.revenue += cell.revenue;
      current.orderCount += cell.orderCount;
      cells.set(key, current);
    }

    return cells;
  }, [report.heatmap.cells, weekday]);

  const heatmapRows = useMemo(
    () =>
      report.heatmap.stores.filter((store) =>
        report.heatmap.hours.some((hour) => {
          const cell = aggregatedCells.get(`${store.key}-${hour}`);
          return Boolean(cell && (cell.orderCount > 0 || cell.revenue > 0));
        })
      ),
    [aggregatedCells, report.heatmap.hours, report.heatmap.stores]
  );
  const maxMetricValue = useMemo(() => {
    return Math.max(
      ...Array.from(aggregatedCells.values()).map((cell) =>
        metric === "revenue" ? cell.revenue : cell.orderCount
      ),
      0
    );
  }, [aggregatedCells, metric]);

  if (report.heatmap.stores.length === 0 || report.heatmap.days.length === 0) {
    return <div className="empty-state inset">Нет данных для тепловой карты</div>;
  }

  if (heatmapRows.length === 0) {
    return <div className="empty-state inset">Нет данных за {weekdayLabel}</div>;
  }

  return (
    <div className="heatmap-scroll">
      <div
        className="heatmap-grid"
        style={
          {
            gridTemplateColumns: `minmax(340px, 1.6fr) repeat(${report.heatmap.hours.length}, minmax(${metric === "revenue" ? 58 : 36}px, 1fr))`
          } as CSSProperties
        }
      >
        <div className="heatmap-label heatmap-head">Магазин</div>
        {report.heatmap.hours.map((hour) => (
          <div key={hour} className="heatmap-hour heatmap-head">
            {hour}
          </div>
        ))}

        {heatmapRows.map((store) => (
          <Fragment key={store.key}>
            <div className="heatmap-label stacked" title={store.name}>
              <Store size={14} />
              <div>
                <b>{store.name}</b>
                <span>{weekdayLabel}</span>
              </div>
            </div>
            {report.heatmap.hours.map((hour) => {
              const cell = aggregatedCells.get(`${store.key}-${hour}`);
              const metricValue =
                metric === "revenue" ? (cell?.revenue ?? 0) : (cell?.orderCount ?? 0);
              const intensity = maxMetricValue > 0 ? metricValue / maxMetricValue : 0;

              return (
                <div
                  key={`${store.key}-${hour}`}
                  className={metric === "revenue" ? "heatmap-cell money" : "heatmap-cell"}
                  title={
                    metric === "revenue"
                      ? `${store.name}, ${weekdayLabel}, ${hour}:00 · ${formatMoney(cell?.revenue ?? 0)}`
                      : `${store.name}, ${weekdayLabel}, ${hour}:00 · ${formatNumber(cell?.orderCount ?? 0)} чеков · ${formatMoney(cell?.revenue ?? 0)}`
                  }
                  style={{ "--heat": intensity } as CSSProperties}
                >
                  {metricValue
                    ? metric === "revenue"
                      ? formatMoneyCompact(metricValue)
                      : formatCompact(metricValue)
                    : ""}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
      <div className="heatmap-legend">
        <Clock size={14} />
        <span>
          {metric === "revenue"
            ? `Цвет и значение показывают сумму продаж по магазинам за ${weekdayLabel.toLowerCase()} по часам.`
            : `Цвет и значение показывают количество отчетов розницы по магазинам за ${weekdayLabel.toLowerCase()} по часам.`}
        </span>
      </div>
    </div>
  );
}

function getIsoWeekday(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 0;
  }

  const weekday = date.getDay();
  return weekday === 0 ? 7 : weekday;
}

function formatHeatmapDay(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function formatHeatmapDateList(days: string[]) {
  if (days.length === 0) {
    return "нет дат";
  }

  const visibleDays = days.slice(0, 24).map(formatHeatmapDay);
  const hiddenCount = days.length - visibleDays.length;

  return hiddenCount > 0
    ? `${visibleDays.join(", ")} и еще ${formatNumber(hiddenCount)}`
    : visibleDays.join(", ");
}

function formatBucket(value: string, period: SalesPeriod) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  if (period === "month") {
    return new Intl.DateTimeFormat("ru-RU", {
      month: "short",
      year: "numeric"
    }).format(date);
  }

  if (period === "week") {
    return `с ${new Intl.DateTimeFormat("ru-RU", {
      day: "2-digit",
      month: "2-digit"
    }).format(date)}`;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit"
  }).format(date);
}

function IncomeReports({
  dateRange,
  onDateRangeChange
}: {
  dateRange: DateRangeValue;
  onDateRangeChange: (dateRange: DateRangeValue) => void;
}) {
  const [period, setPeriod] = useState<SalesPeriod>("day");
  const [reportState, setReportState] = useState<LoadState<IncomeReport>>({
    status: "loading"
  });

  useEffect(() => {
    const controller = new AbortController();
    setReportState({ status: "loading" });
    api
      .incomeReport({ period, ...dateRange }, controller.signal)
      .then((report) => {
        if (!controller.signal.aborted) {
          setReportState({ status: "success", data: report });
        }
      })
      .catch((caught) => {
        if (controller.signal.aborted) {
          return;
        }

        setReportState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить отчет о доходе"
        });
      });

    return () => controller.abort();
  }, [dateRange.from, dateRange.to, period]);

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Доход</h2>
          <span>document_otchet_o_roznichnyh_prodazhah · document_postuplenie_tovarov</span>
        </div>
        <ReportFilterBar
          period={period}
          onPeriodChange={setPeriod}
          dateRange={dateRange}
          onDateRangeChange={onDateRangeChange}
          periodLabel="Группировка дохода"
        />
      </div>

      {reportState.status === "loading" ? (
        <div className="empty-state">Загружаем отчет о доходе</div>
      ) : null}

      {reportState.status === "error" ? (
        <div className="empty-state">{reportState.error}</div>
      ) : null}

      {reportState.status === "success" ? (
        <IncomeReportBody report={reportState.data} period={period} />
      ) : null}
    </section>
  );
}

function IncomeReportBody({
  report,
  period
}: {
  report: IncomeReport;
  period: SalesPeriod;
}) {
  const storeItemGroups = useMemo(() => {
    const map = new Map<string, typeof report.storeItems>();
    for (const si of report.storeItems) {
      const group = map.get(si.storeKey);
      if (group) {
        group.push(si);
      } else {
        map.set(si.storeKey, [si]);
      }
    }
    // Sort groups by total store revenue (from stores array)
    const storeRevenue = new Map(report.stores.map((s) => [s.key, s.revenue]));
    return [...map.entries()].sort(
      (a, b) => (storeRevenue.get(b[0]) ?? 0) - (storeRevenue.get(a[0]) ?? 0)
    );
  }, [report.storeItems, report.stores]);

  const [showAllSummaryItems, setShowAllSummaryItems] = useState(false);
  const visibleSummaryItems = showAllSummaryItems ? report.items : report.items.slice(0, 15);
  const [showAllStores, setShowAllStores] = useState(false);
  const visibleStores = showAllStores ? report.stores : report.stores.slice(0, 15);
  // An empty retail-report window means the figures are unknown, not zero.
  const noReportRows = report.summary.dateFrom === null;

  return (
    <>
      {report.summary.dateFrom === null ? (
        <div className="metric-note warning">
          За выбранный период отчётов розницы нет: выручка, себестоимость и маржа
          не рассчитаны — это не нули.
        </div>
      ) : null}
      <section className="metric-grid report-metric-grid" aria-label="Метрики дохода">
        <MetricCard
          icon={<Receipt size={18} />}
          metricId="sales.net"
          label="Чистая выручка"
          value={noReportRows ? null : formatMoney(report.summary.revenue)}
        />
        <MetricCard
          icon={<ShoppingCart size={18} />}
          metricId="income.cost"
          label="Себестоимость"
          value={noReportRows ? null : formatMoney(report.summary.cost)}
        />
        <MetricCard
          icon={<TrendingUp size={18} />}
          metricId="income.gross-profit"
          status={noReportRows ? "unavailable" : report.summary.unvaluedRevenue > 0 ? "partial" : "ready"}
          coveragePct={report.summary.costCoveragePct}
          label="Валовая прибыль до потерь"
          value={noReportRows ? null : formatMoney(report.summary.grossProfit)}
        />
        <MetricCard
          icon={<BarChart3 size={18} />}
          metricId="income.margin"
          status={noReportRows ? "unavailable" : report.summary.unvaluedRevenue > 0 ? "partial" : "ready"}
          label="Маржинальность до потерь"
          value={noReportRows ? null : `${formatDecimal(report.summary.marginPct, 1)}%`}
        />
        <MetricCard
          icon={<ShieldCheck size={18} />}
          metricId="income.cost-coverage"
          label="Покрытие себестоимости"
          value={noReportRows ? null : `${formatDecimal(report.summary.costCoveragePct, 1)}%`}
        />
        <MetricCard
          icon={<Package size={18} />}
          metricId="income.unvalued"
          label="Выручка без оценки цены"
          value={noReportRows ? null : formatMoney(report.summary.unvaluedRevenue)}
        />
      </section>
      <div className="metric-note warning">
        Себестоимость: живой регистр по точке и товару → установка по точке →
        последняя по сети → закупка за 90 дней. Потери, НДС и внутренняя наценка
        здесь еще не вычтены.
      </div>

      <div className="reports-grid">
        <section className="panel report-chart-panel">
          <div className="panel-title">
            <h3><MetricLabel metricId="income.gross-profit">Валовая прибыль по периодам</MetricLabel></h3>
            <span>
              {formatDate(report.summary.dateFrom)} — {formatDate(report.summary.dateTo)}
            </span>
          </div>
          <div className="chart-wrap compact">
            {report.incomeSeries.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={report.incomeSeries}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={(value) => formatBucket(String(value), period)}
                    minTickGap={18}
                  />
                  <YAxis tickFormatter={formatMoneyCompact} width={78} />
                  <Tooltip
                    labelFormatter={(value) => formatBucket(String(value), period)}
                    formatter={(value, name) => [
                      formatMoney(Number(value)),
                      name === "grossProfit"
                        ? "Валовая прибыль"
                        : name === "revenue"
                          ? "Выручка"
                          : "Себестоимость"
                    ]}
                    labelStyle={{ color: "#172033" }}
                  />
                  <Bar dataKey="revenue" fill="#2864d8" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="cost" fill="#e07b5a" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="grossProfit" fill="#22815f" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state inset">Нет данных о доходе за выбранный период</div>
            )}
          </div>
        </section>

        <section className="panel report-side-panel">
          <div className="panel-title">
            <h3>Маржинальность по периодам</h3>
          </div>
          <div className="chart-wrap compact">
            {report.incomeSeries.length > 0 ? (
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={report.incomeSeries}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={(value) => formatBucket(String(value), period)}
                    minTickGap={18}
                  />
                  <YAxis
                    tickFormatter={(value) => `${formatDecimal(value, 0)}%`}
                    width={48}
                  />
                  <Tooltip
                    labelFormatter={(value) => formatBucket(String(value), period)}
                    formatter={(value) => `${formatDecimal(Number(value), 1)}%`}
                    labelStyle={{ color: "#172033" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="marginPct"
                    stroke="#2864d8"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state inset">Нет данных о маржинальности</div>
            )}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-title">
          <div>
            <h3>Доход по магазинам</h3>
            <span>{formatNumber(report.stores.length)} магазинов</span>
          </div>
          {report.stores.length > 15 ? (
            <button
              onClick={() => setShowAllStores((v) => !v)}
              type="button"
              style={{ border: "1px solid #e4e7ec", borderRadius: "6px", padding: "4px 12px", cursor: "pointer", background: "#fff", fontSize: "13px" }}
            >
              {showAllStores ? "Свернуть" : `Показать все (${formatNumber(report.stores.length)})`}
            </button>
          ) : null}
        </div>
        {visibleStores.length > 0 ? (
          <div className="heatmap-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Магазин</th>
                  <th className="num"><MetricLabel metricId="sales.net">Чистая выручка</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="income.cost">Себестоимость</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="income.gross-profit">Прибыль</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="income.margin">Маржа</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {visibleStores.map((store) => (
                  <tr key={store.key}>
                    <td>{store.name}</td>
                    <td className="num">{formatMoney(store.revenue)}</td>
                    <td className="num">{formatMoney(store.cost)}</td>
                    <td className="num">{formatMoney(store.grossProfit)}</td>
                    <td className="num">{formatDecimal(store.marginPct, 1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state inset">Нет данных по магазинам</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <h3>Доход по товарам — сводно</h3>
            <span>{formatNumber(report.items.length)} позиций</span>
          </div>
          {report.items.length > 15 ? (
            <button
              onClick={() => setShowAllSummaryItems((v) => !v)}
              type="button"
              style={{ border: "1px solid #e4e7ec", borderRadius: "6px", padding: "4px 12px", cursor: "pointer", background: "#fff", fontSize: "13px" }}
            >
              {showAllSummaryItems ? "Свернуть" : `Показать все (${formatNumber(report.items.length)})`}
            </button>
          ) : null}
        </div>
        {visibleSummaryItems.length > 0 ? (
          <div className="heatmap-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th className="num"><MetricLabel metricId="sales.net-units">Продано</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="sales.net">Чистая выручка</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="income.cost">Себестоимость</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="income.gross-profit">Прибыль</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="income.margin">Маржа</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {visibleSummaryItems.map((item) => (
                  <tr key={item.key}>
                    <td>{item.name}</td>
                    <td className="num">{formatDecimal(item.soldQty, 1)}</td>
                    <td className="num">{formatMoney(item.revenue)}</td>
                    <td className="num">{formatMoney(item.cost)}</td>
                    <td className="num">{formatMoney(item.grossProfit)}</td>
                    <td className="num">{formatDecimal(item.marginPct, 1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state inset">Нет данных по товарам</div>
        )}
      </section>

      {storeItemGroups.map(([storeKey, storeItems]) => {
        const storeTotal = storeItems.reduce((s, i) => s + i.revenue, 0);
        return (
          <section key={storeKey} className="panel">
            <div className="panel-title">
              <div>
                <h3>Доход по товарам — {storeItems[0]?.storeName ?? storeKey}</h3>
                <span>{formatNumber(storeItems.length)} позиций · {formatMoney(storeTotal)}</span>
              </div>
            </div>
            <div className="heatmap-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Товар</th>
                    <th className="num"><MetricLabel metricId="sales.net-units">Продано</MetricLabel></th>
                    <th className="num"><MetricLabel metricId="sales.net">Чистая выручка</MetricLabel></th>
                    <th className="num"><MetricLabel metricId="income.cost">Себестоимость</MetricLabel></th>
                    <th className="num"><MetricLabel metricId="income.gross-profit">Прибыль</MetricLabel></th>
                    <th className="num"><MetricLabel metricId="income.margin">Маржа</MetricLabel></th>
                  </tr>
                </thead>
                <tbody>
                  {storeItems.slice(0, 30).map((item) => (
                    <tr key={item.itemKey}>
                      <td>{item.itemName}</td>
                      <td className="num">{formatDecimal(item.soldQty, 1)}</td>
                      <td className="num">{formatMoney(item.revenue)}</td>
                      <td className="num">{formatMoney(item.cost)}</td>
                      <td className="num">{formatMoney(item.grossProfit)}</td>
                      <td className="num">{formatDecimal(item.marginPct, 1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}

function MarketingReports() {
  const [period, setPeriod] = useState<SalesPeriod>("day");
  const [dateRange, setDateRange] = useState<DateRangeValue>(currentMonthRange);
  const [state, setState] = useState<LoadState<MarketingReport>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    api
      .marketingReport({ period, ...dateRange }, controller.signal)
      .then((report) => {
        if (!controller.signal.aborted) {
          setState({ status: "success", data: report });
        }
      })
      .catch((caught) => {
        if (controller.signal.aborted) {
          return;
        }

        setState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить маркетинговый отчет"
        });
      });

    return () => controller.abort();
  }, [dateRange.from, dateRange.to, period]);

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Маркетинг</h2>
          <span>document_otchet_o_roznichnyh_prodazhah · document_otchet_o_roznichnyh_prodazhah_tovary</span>
        </div>
        <ReportFilterBar
          period={period}
          onPeriodChange={setPeriod}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
        />
      </div>

      {state.status === "loading" ? <div className="empty-state">Загружаем маркетинговый отчет</div> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}

      {state.status === "success" ? (
        <MarketingReportBody report={state.data} />
      ) : null}
    </section>
  );
}

type PromotionSortKey =
  | "name"
  | "startsOn"
  | "discountPctMax"
  | "storeCount"
  | "itemCount"
  | "reportCount"
  | "quantity"
  | "revenue"
  | "discountAmount"
  | "revenuePerDiscount";

const promotionStatusLabels: Record<MarketingPromotion["status"], string> = {
  active: "активна",
  finished: "завершена",
  upcoming: "предстоит"
};

const promotionStatusOptions: Array<{ value: "all" | MarketingPromotion["status"]; label: string }> = [
  { value: "all", label: "Все" },
  { value: "active", label: "Активные" },
  { value: "finished", label: "Завершенные" }
];

function formatDiscountPct(min: number, max: number) {
  if (min === 0 && max === 0) {
    return "—";
  }

  const formatted = (value: number) => `${formatDecimal(value, 2)}%`;
  return min === max ? formatted(min) : `${formatted(min)}–${formatted(max)}`;
}

function formatPromotionPeriod(startsOn: string | null, endsOn: string | null) {
  if (!startsOn && !endsOn) {
    return "—";
  }

  if (!startsOn || !endsOn) {
    return formatDate(startsOn ?? endsOn);
  }

  return `${formatDate(startsOn)} — ${formatDate(endsOn)}`;
}

function MarketingReportBody({ report }: { report: MarketingReport }) {
  const [showAllPromotions, setShowAllPromotions] = useState(false);
  const [showAllItems, setShowAllItems] = useState(false);
  const [showAllStores, setShowAllStores] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | MarketingPromotion["status"]>("all");
  const [sortKey, setSortKey] = useState<PromotionSortKey>("revenue");
  const [sortDescending, setSortDescending] = useState(true);
  const [expandedPromotions, setExpandedPromotions] = useState<Record<string, boolean>>({});
  const [expandedStores, setExpandedStores] = useState<Record<string, boolean>>({});

  const summary = report.summary;

  const sortedPromotions = useMemo(() => {
    const filtered =
      statusFilter === "all"
        ? report.promotions
        : report.promotions.filter((promotion) => promotion.status === statusFilter);
    const direction = sortDescending ? -1 : 1;

    return [...filtered].sort((left, right) => {
      if (sortKey === "name") {
        return left.name.localeCompare(right.name, "ru") * direction;
      }

      if (sortKey === "startsOn") {
        return (left.startsOn ?? "").localeCompare(right.startsOn ?? "") * direction;
      }

      return (left[sortKey] - right[sortKey]) * direction;
    });
  }, [report.promotions, sortDescending, sortKey, statusFilter]);

  const visiblePromotions = showAllPromotions ? sortedPromotions : sortedPromotions.slice(0, 12);

  const itemRows = useMemo(
    () =>
      report.promotions
        .flatMap((promotion) =>
          promotion.stores.flatMap((store) =>
            store.items.map((item) => ({
              key: `${promotion.key}:${store.key}:${item.key}`,
              promotionName: promotion.name,
              storeName: store.name,
              itemName: item.name,
              reportCount: item.reportCount,
              quantity: item.quantity,
              revenue: item.revenue,
              discountAmount: item.discountAmount,
              discountPct: item.discountPct,
              avgPrice: item.avgPrice
            }))
          )
        )
        .sort((left, right) => right.revenue - left.revenue),
    [report.promotions]
  );
  const visibleItemRows = showAllItems ? itemRows : itemRows.slice(0, 100);

  const storeRows = useMemo(
    () => [...report.stores].sort((left, right) => right.promoRevenue - left.promoRevenue),
    [report.stores]
  );
  const visibleStoreRows = showAllStores ? storeRows : storeRows.slice(0, 10);

  const toggleSort = (key: PromotionSortKey) => {
    if (key === sortKey) {
      setSortDescending((current) => !current);
      return;
    }

    setSortKey(key);
    setSortDescending(key !== "name");
  };

  const sortIndicator = (key: PromotionSortKey) =>
    key === sortKey ? (sortDescending ? " ↓" : " ↑") : "";

  const togglePromotion = (key: string) => {
    setExpandedPromotions((current) => ({ ...current, [key]: !current[key] }));
  };

  const toggleStore = (key: string) => {
    setExpandedStores((current) => ({ ...current, [key]: !current[key] }));
  };

  return (
    <>
      <section className="metric-grid report-metric-grid" aria-label="Метрики маркетинга">
        <MetricCard
          icon={<Megaphone size={18} />}
          metricId="marketing.revenue"
          status="experimental"
          label="Оценка продаж по акциям, до возвратов"
          value={formatMoney(summary.promoRevenue)}
          detail={`${formatDecimal(summary.promoSharePct, 2)}% выручки периода`}
        />
        <MetricCard
          icon={<BarChart3 size={18} />}
          metricId="marketing.discount"
          status="experimental"
          label="Скидки по акциям"
          value={formatMoney(summary.promoDiscountAmount)}
          detail={`средняя скидка ${formatDecimal(summary.avgDiscountPct, 2)}%`}
        />
        <MetricCard
          icon={<Package size={18} />}
          metricId="marketing.quantity"
          status="experimental"
          label="Продано единиц по акциям"
          value={formatDecimal(summary.promoQuantity, 0)}
          detail={`${formatNumber(summary.promoItemCount)} товаров · ${formatNumber(summary.promoLineCount)} строк`}
        />
        <MetricCard
          icon={<Receipt size={18} />}
          metricId="marketing.reports"
          label="Отчетов с акциями"
          value={formatNumber(summary.promoReportCount)}
          detail={`из ${formatNumber(summary.totalReports)} отчетов периода`}
        />
        <MetricCard
          icon={<TrendingUp size={18} />}
          metricId="marketing.return"
          status="experimental"
          label="Выручка на 1 ₸ скидки"
          value={formatDecimal(summary.revenuePerDiscount, 2)}
          detail={`средний отчет ${formatMoney(summary.avgCheck)}`}
        />
        <MetricCard
          icon={<Store size={18} />}
          metricId="marketing.stores"
          label="Магазинов в акциях"
          value={formatNumber(summary.promoStoreCount)}
          detail={`акций в периоде: ${formatNumber(summary.promotionCount)} · с продажами: ${formatNumber(summary.promotionWithSalesCount)}`}
        />
      </section>
      <div className="metric-note warning">
        Атрибуция восстановлена по магазину, дате, товару и скидке. Возврат нельзя
        надёжно связать с исходной акцией, поэтому показатели акций показаны до возвратов.
      </div>

      <section className="panel">
        <div className="panel-title">
          <div>
            <h3><MetricLabel metricId="marketing.revenue">Оценка продаж по акциям</MetricLabel></h3>
            <span>
              {formatNumber(sortedPromotions.length)} акций
              {statusFilter === "all" ? "" : ` (фильтр: ${promotionStatusLabels[statusFilter as MarketingPromotion["status"]]})`}
            </span>
          </div>
          <div className="panel-actions">
            {promotionStatusOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={option.value === statusFilter ? "chip chip-active" : "chip"}
                onClick={() => setStatusFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
            {sortedPromotions.length > 12 ? (
              <button
                type="button"
                className="chip"
                onClick={() => setShowAllPromotions((value) => !value)}
              >
                {showAllPromotions ? "Свернуть" : `Все (${formatNumber(sortedPromotions.length)})`}
              </button>
            ) : null}
          </div>
        </div>
        <span className="panel-note">
          Продажа отнесена к акции, когда магазин, дата, номенклатура и фактическая скидка строки
          совпали с условиями акции; скидка строки восстановлена как 1 − сумма / (количество × цена).
          Разверните акцию для детализации по магазинам и товарам.
        </span>

        {visiblePromotions.length > 0 ? (
          <div className="heatmap-scroll">
            <table className="data-table promo-table">
              <thead>
                <tr>
                  <th className="expand-cell" />
                  <th>
                    <button type="button" className="sort-button" onClick={() => toggleSort("name")}>
                      Акция{sortIndicator("name")}
                    </button>
                  </th>
                  <th>№ документа</th>
                  <th>
                    <button type="button" className="sort-button" onClick={() => toggleSort("startsOn")}>
                      Период{sortIndicator("startsOn")}
                    </button>
                  </th>
                  <th>Статус</th>
                  <th className="num">
                    <MetricLabel metricId="marketing.discount">
                    <button type="button" className="sort-button" onClick={() => toggleSort("discountPctMax")}>
                      Скидка{sortIndicator("discountPctMax")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th className="num">
                    <MetricLabel metricId="marketing.stores">
                    <button type="button" className="sort-button" onClick={() => toggleSort("storeCount")}>
                      Магазинов{sortIndicator("storeCount")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th className="num">
                    <MetricLabel metricId="catalog.items">
                    <button type="button" className="sort-button" onClick={() => toggleSort("itemCount")}>
                      Товаров{sortIndicator("itemCount")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th className="num">
                    <MetricLabel metricId="marketing.reports">
                    <button type="button" className="sort-button" onClick={() => toggleSort("reportCount")}>
                      Отчетов{sortIndicator("reportCount")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th className="num">
                    <MetricLabel metricId="marketing.quantity">
                    <button type="button" className="sort-button" onClick={() => toggleSort("quantity")}>
                      Кол-во{sortIndicator("quantity")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th className="num">
                    <MetricLabel metricId="marketing.revenue">
                    <button type="button" className="sort-button" onClick={() => toggleSort("revenue")}>
                      Выручка{sortIndicator("revenue")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th className="num">
                    <MetricLabel metricId="marketing.discount">
                    <button type="button" className="sort-button" onClick={() => toggleSort("discountAmount")}>
                      Скидка ₸{sortIndicator("discountAmount")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th className="num">
                    <MetricLabel metricId="marketing.return">
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => toggleSort("revenuePerDiscount")}
                    >
                      ₸ на 1 ₸ скидки{sortIndicator("revenuePerDiscount")}
                    </button>
                    </MetricLabel>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visiblePromotions.map((promotion) => {
                  const isExpanded = Boolean(expandedPromotions[promotion.key]);

                  return (
                    <Fragment key={promotion.key}>
                      <tr>
                        <td className="expand-cell">
                          <button
                            type="button"
                            className="row-toggle"
                            aria-expanded={isExpanded}
                            aria-label={`Товары и магазины акции «${promotion.name}»`}
                            onClick={() => togglePromotion(promotion.key)}
                          >
                            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                        </td>
                        <td className="promotion-name">{promotion.name}</td>
                        <td>{promotion.number ?? "—"}</td>
                        <td>{formatPromotionPeriod(promotion.startsOn, promotion.endsOn)}</td>
                        <td>
                          <span className={`status-chip ${promotion.status}`}>
                            {promotionStatusLabels[promotion.status]}
                          </span>
                        </td>
                        <td className="num">
                          {formatDiscountPct(promotion.discountPctMin, promotion.discountPctMax)}
                        </td>
                        <td className="num">{formatNumber(promotion.storeCount)}</td>
                        <td
                          className="num"
                          title={`продано ${formatNumber(promotion.itemCount)} из ${formatNumber(promotion.assortmentSize)} товаров акции`}
                        >
                          {formatNumber(promotion.itemCount)}
                          <span className="muted"> / {formatNumber(promotion.assortmentSize)}</span>
                        </td>
                        <td className="num">{formatNumber(promotion.reportCount)}</td>
                        <td className="num">{formatDecimal(promotion.quantity, 1)}</td>
                        <td className="num">{formatMoney(promotion.revenue)}</td>
                        <td className="num">{formatMoney(promotion.discountAmount)}</td>
                        <td className="num">{formatDecimal(promotion.revenuePerDiscount, 2)}</td>
                      </tr>

                      {isExpanded ? (
                        <tr className="promotion-detail-row">
                          <td colSpan={13}>
                            {promotion.stores.length > 0 ? (
                              <table className="data-table sub-table">
                                <thead>
                                  <tr>
                                    <th className="expand-cell" />
                                    <th>Магазин</th>
                                    <th className="num"><MetricLabel metricId="marketing.reports">Отчётов</MetricLabel></th>
                                    <th className="num"><MetricLabel metricId="catalog.items">Товаров</MetricLabel></th>
                                    <th className="num"><MetricLabel metricId="marketing.quantity">Кол-во</MetricLabel></th>
                                    <th className="num"><MetricLabel metricId="marketing.revenue">Выручка</MetricLabel></th>
                                    <th className="num"><MetricLabel metricId="marketing.discount">Скидка ₸</MetricLabel></th>
                                    <th className="num"><MetricLabel metricId="marketing.discount">Скидка</MetricLabel></th>
                                    <th className="num"><MetricLabel metricId="sales.avg-report">Средний отчет</MetricLabel></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {promotion.stores.map((store) => {
                                    const storeKey = `${promotion.key}:${store.key}`;
                                    const isStoreExpanded = Boolean(expandedStores[storeKey]);

                                    return (
                                      <Fragment key={store.key}>
                                        <tr>
                                          <td className="expand-cell">
                                            <button
                                              type="button"
                                              className="row-toggle"
                                              aria-expanded={isStoreExpanded}
                                              aria-label={`Товары магазина «${store.name}» в акции «${promotion.name}»`}
                                              onClick={() => toggleStore(storeKey)}
                                            >
                                              {isStoreExpanded ? (
                                                <ChevronDown size={14} />
                                              ) : (
                                                <ChevronRight size={14} />
                                              )}
                                            </button>
                                          </td>
                                          <td className="promotion-name">{store.name}</td>
                                          <td className="num">{formatNumber(store.reportCount)}</td>
                                          <td className="num">{formatNumber(store.itemCount)}</td>
                                          <td className="num">{formatDecimal(store.quantity, 1)}</td>
                                          <td className="num">{formatMoney(store.revenue)}</td>
                                          <td className="num">{formatMoney(store.discountAmount)}</td>
                                          <td className="num">{formatDiscountPct(store.discountPct, store.discountPct)}</td>
                                          <td className="num">{formatMoney(store.avgCheck)}</td>
                                        </tr>

                                        {isStoreExpanded ? (
                                          <tr>
                                            <td colSpan={9}>
                                              {store.items.length > 0 ? (
                                                <table className="data-table sub-table items-table">
                                                  <thead>
                                                    <tr>
                                                      <th>Номенклатура</th>
                                                      <th className="num"><MetricLabel metricId="marketing.reports">Отчётов</MetricLabel></th>
                                                      <th className="num"><MetricLabel metricId="marketing.quantity">Кол-во</MetricLabel></th>
                                                      <th className="num"><MetricLabel metricId="marketing.price">Цена</MetricLabel></th>
                                                      <th className="num"><MetricLabel metricId="marketing.revenue">Выручка</MetricLabel></th>
                                                      <th className="num"><MetricLabel metricId="marketing.discount">Скидка ₸</MetricLabel></th>
                                                      <th className="num"><MetricLabel metricId="marketing.discount">Скидка</MetricLabel></th>
                                                    </tr>
                                                  </thead>
                                                  <tbody>
                                                    {store.items.map((item) => (
                                                      <tr key={item.key}>
                                                        <td>{item.name}</td>
                                                        <td className="num">{formatNumber(item.reportCount)}</td>
                                                        <td className="num">{formatDecimal(item.quantity, 1)}</td>
                                                        <td className="num">{formatMoney(item.avgPrice)}</td>
                                                        <td className="num">{formatMoney(item.revenue)}</td>
                                                        <td className="num">{formatMoney(item.discountAmount)}</td>
                                                        <td className="num">{formatDecimal(item.discountPct, 2)}%</td>
                                                      </tr>
                                                    ))}
                                                  </tbody>
                                                </table>
                                              ) : (
                                                <div className="empty-state inset">Нет товарной детализации</div>
                                              )}
                                            </td>
                                          </tr>
                                        ) : null}
                                      </Fragment>
                                    );
                                  })}
                                </tbody>
                              </table>
                            ) : (
                              <div className="empty-state inset">Нет продаж по акции в периоде</div>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state inset">Нет акций с продажами в выбранном периоде</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <h3>Магазины</h3>
            <span>
              {formatNumber(summary.promoStoreCount)} магазинов с акциями · {formatNumber(storeRows.length)} всего
            </span>
          </div>
          {storeRows.length > 10 ? (
            <div className="panel-actions">
              <button type="button" className="chip" onClick={() => setShowAllStores((value) => !value)}>
                {showAllStores ? "Свернуть" : `Все (${formatNumber(storeRows.length)})`}
              </button>
            </div>
          ) : null}
        </div>
        <span className="panel-note">
          Выручка по акциям — сумма продаж, отнесенных к акциям, доля считается от всей выручки
          магазина за период. Кол-во и товары — проданные по акциям единицы и номенклатура.
        </span>
        {visibleStoreRows.length > 0 ? (
          <div className="heatmap-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Магазин</th>
                  <th className="num"><MetricLabel metricId="sales.reports">Отчётов</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="sales.gross">Выручка до возвратов</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="marketing.revenue">Выручка по акциям</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="marketing.share">Доля</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="marketing.discount">Скидка ₸</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="marketing.quantity">Кол-во по акциям</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="catalog.items">Товаров по акциям</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="marketing.stores">Акций</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {visibleStoreRows.map((store) => (
                  <tr key={store.key}>
                    <td className="promotion-name">{store.name}</td>
                    <td className="num">{formatNumber(store.totalReports)}</td>
                    <td className="num">{formatMoney(store.totalRevenue)}</td>
                    <td className="num">{formatMoney(store.promoRevenue)}</td>
                    <td className="num">{formatDecimal(store.promoSharePct, 2)}%</td>
                    <td className="num">{formatMoney(store.promoDiscountAmount)}</td>
                    <td className="num">{formatDecimal(store.promoQuantity, 1)}</td>
                    <td className="num">{formatNumber(store.promoItemCount)}</td>
                    <td className="num">{formatNumber(store.promotionCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state inset">Нет данных по магазинам</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <h3>Товары в акциях</h3>
            <span>{formatNumber(itemRows.length)} строк акция / магазин / товар</span>
          </div>
          {itemRows.length > 100 ? (
            <div className="panel-actions">
              <button type="button" className="chip" onClick={() => setShowAllItems((value) => !value)}>
                {showAllItems ? "Свернуть" : `Все (${formatNumber(itemRows.length)})`}
              </button>
            </div>
          ) : null}
        </div>
        <span className="panel-note">
          Построчная выручка по акциям. «Скидка» — фактический процент, примененный в строке продажи.
        </span>
        {visibleItemRows.length > 0 ? (
          <div className="heatmap-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Акция</th>
                  <th>Магазин</th>
                  <th>Номенклатура</th>
                  <th className="num"><MetricLabel metricId="marketing.reports">Отчётов</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="marketing.quantity">Кол-во</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="marketing.price">Цена</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="marketing.revenue">Выручка</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="marketing.discount">Скидка ₸</MetricLabel></th>
                  <th className="num"><MetricLabel metricId="marketing.discount">Скидка</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {visibleItemRows.map((row) => (
                  <tr key={row.key}>
                    <td title={row.promotionName}>{row.promotionName}</td>
                    <td title={row.storeName}>{row.storeName}</td>
                    <td title={row.itemName}>{row.itemName}</td>
                    <td className="num">{formatNumber(row.reportCount)}</td>
                    <td className="num">{formatDecimal(row.quantity, 1)}</td>
                    <td className="num">{formatMoney(row.avgPrice)}</td>
                    <td className="num">{formatMoney(row.revenue)}</td>
                    <td className="num">{formatMoney(row.discountAmount)}</td>
                    <td className="num">{formatDecimal(row.discountPct, 2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state inset">Нет данных по номенклатуре в акциях</div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Сводка по акциям</h3>
        </div>
        <div className="stack-list">
          <div className="summary-row">
            <strong>Акций в периоде</strong>
            <span>
              {formatNumber(summary.promotionCount)} · активных {formatNumber(summary.activePromotionCount)} · с
              продажами {formatNumber(summary.promotionWithSalesCount)}
            </span>
          </div>
          <div className="summary-row">
            <strong>Выручка по акциям</strong>
            <span>
              {formatMoney(summary.promoRevenue)} · доля {formatDecimal(summary.promoSharePct, 2)}%
            </span>
          </div>
          <div className="summary-row">
            <strong>Выручка без акций</strong>
            <span>{formatMoney(summary.totalRevenue - summary.promoRevenue)}</span>
          </div>
          <div className="summary-row">
            <strong>Сумма скидок по акциям</strong>
            <span>
              {formatMoney(summary.promoDiscountAmount)} · средняя скидка{" "}
              {formatDecimal(summary.avgDiscountPct, 2)}%
            </span>
          </div>
          <div className="summary-row">
            <strong>Выручка до скидки</strong>
            <span>{formatMoney(summary.promoListRevenue)}</span>
          </div>
          <div className="summary-row">
            <strong>Выручка на 1 ₸ скидки</strong>
            <span>{formatDecimal(summary.revenuePerDiscount, 2)}</span>
          </div>
          <div className="summary-row">
            <strong>Отчетов с акциями</strong>
            <span>
              {formatNumber(summary.promoReportCount)} из {formatNumber(summary.totalReports)}
              {summary.totalReports > 0
                ? ` · ${formatDecimal((summary.promoReportCount / summary.totalReports) * 100, 2)}%`
                : ""}
            </span>
          </div>
          <div className="summary-row">
            <strong>Средний отчет по акции</strong>
            <span>{formatMoney(summary.avgCheck)}</span>
          </div>
        </div>
      </section>
    </>
  );
}

function InventoryReports() {
  const [period, setPeriod] = useState<SalesPeriod>("day");
  const [dateRange, setDateRange] = useState<DateRangeValue>(currentMonthRange);
  const [state, setState] = useState<LoadState<InventoryReport>>({ status: "loading" });
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    api
      .inventoryReport({ period, ...dateRange }, controller.signal)
      .then((report) => {
        if (!controller.signal.aborted) {
          setState({ status: "success", data: report });
          setExpandedSections({});
        }
      })
      .catch((caught) => {
        if (controller.signal.aborted) {
          return;
        }

        setState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить отчет по запасам"
        });
      });

    return () => controller.abort();
  }, [dateRange.from, dateRange.to, period]);

  const report = state.data;

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const renderSection = (title: string, sectionKey: string, items: InventoryReport["items"], cols: ColumnDef<InventoryReport["items"][0]>[]) => {
    if (!items || items.length === 0) return null;
    const expanded = expandedSections[sectionKey] ?? false;
    const visible = expanded ? items : items.slice(0, 10);

    return (
      <section className="panel" key={sectionKey}>
        <div className="panel-title">
          <div>
            <h3>{title}</h3>
            <span>{formatNumber(items.length)} позиций</span>
          </div>
          {items.length > 10 ? (
            <button
              onClick={() => toggleSection(sectionKey)}
              type="button"
              style={{ border: "1px solid #e4e7ec", borderRadius: "6px", padding: "4px 12px", cursor: "pointer", background: "#fff", fontSize: "13px" }}
            >
              {expanded ? "Свернуть" : `Показать все (${formatNumber(items.length)})`}
            </button>
          ) : null}
        </div>
        <div className="heatmap-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {cols.map((col) => (
                  <th key={col.key} className={col.num ? "num" : ""}>
                    {col.metricId ? <MetricLabel metricId={col.metricId}>{col.label}</MetricLabel> : col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.key}>
                  {cols.map((col) => (
                    <td key={col.key} className={col.num ? "num" : ""}>{col.render(item)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  };

  const stockColumns: ColumnDef<InventoryReport["items"][0]>[] = [
    { key: "name", label: "Товар", render: (r) => r.name },
    { key: "stockQty", label: "Остаток", metricId: "stock.quantity", num: true, render: (r) => formatDecimal(r.stockQty, 1) },
    { key: "reservedQty", label: "Резерв", metricId: "stock.reserved", num: true, render: (r) => formatDecimal(r.reservedQty, 1) },
    { key: "availableQty", label: "Доступно", metricId: "stock.available", num: true, render: (r) => formatDecimal(r.availableQty, 1) },
    { key: "negativeStockQty", label: "Отриц. остаток", metricId: "stock.negative", num: true, render: (r) => formatDecimal(r.negativeStockQty, 1) },
    { key: "warehouseCount", label: "Складов", num: true, render: (r) => formatNumber(r.warehouseCount) },
    { key: "dailySalesRate", label: "Продаж/календ. день", num: true, render: (r) => formatDecimal(r.dailySalesRate, 2) },
    { key: "daysOfStock", label: "Дней запаса", metricId: "stock.days", num: true, render: (r) => r.daysOfStock !== null ? formatDecimal(r.daysOfStock, 0) : "—" },
    { key: "depletionDays", label: "Прогноз оконч.", num: true, render: (r) => r.depletionDays !== null ? formatDecimal(r.depletionDays, 0) : "—" },
    { key: "stockCost", label: "Оценённая себест-ть", metricId: "stock.cost", num: true, render: (r) => r.costAvailable ? formatMoney(r.stockCost) : "Нет стоимости" },
    { key: "daysSinceLastSale", label: "Дней с посл. продажи", num: true, render: (r) => r.daysSinceLastSale !== null ? formatNumber(r.daysSinceLastSale) : "—" }
  ];

  const shortColumns: ColumnDef<InventoryReport["items"][0]>[] = [
    { key: "name", label: "Товар", render: (r) => r.name },
    { key: "stockQty", label: "Остаток", num: true, render: (r) => formatDecimal(r.stockQty, 1) },
    { key: "reservedQty", label: "Резерв", num: true, render: (r) => formatDecimal(r.reservedQty, 1) },
    { key: "availableQty", label: "Доступно", num: true, render: (r) => formatDecimal(r.availableQty, 1) },
    { key: "stockCost", label: "Оценённая себест-ть", num: true, render: (r) => r.costAvailable ? formatMoney(r.stockCost) : "Нет стоимости" },
    { key: "daysOfStock", label: "Дней запаса", num: true, render: (r) => r.daysOfStock !== null ? formatDecimal(r.daysOfStock, 0) : "—" },
    { key: "daysSinceLastSale", label: "Дней без продаж", num: true, render: (r) => r.daysSinceLastSale !== null ? formatNumber(r.daysSinceLastSale) : "—" }
  ];

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Запасы сети</h2>
          <span>остатки на выбранную дату · скорость по календарным дням · возвраты учтены</span>
        </div>
        <ReportFilterBar
          period={period}
          onPeriodChange={setPeriod}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
        />
      </div>

      {state.status === "loading" ? <div className="empty-state">Загружаем отчет по запасам</div> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.status !== "loading" && state.status !== "error" && !report ? (
        <div className="empty-state">Нет данных по запасам</div>
      ) : null}

      {report ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Метрики запасов">
            <MetricCard icon={<Boxes size={18} />} metricId="inventory.items" label="Товаров с остатком" value={formatNumber(report.summary.itemsWithStock)} />
            <MetricCard icon={<ShoppingCart size={18} />} metricId="stock.cost" label="Оценённый запас, минимум" value={formatMoney(report.summary.totalStockCost)} status={report.summary.unvaluedQty > 0 ? "partial" : "ready"} coveragePct={report.summary.costCoveragePct} asOf={report.summary.stockPeriod} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="inventory.out-of-stock" label="Нет в наличии при спросе" value={formatNumber(report.summary.outOfStockCount)} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="inventory.overstock" label="Запас > 45 дней" value={formatNumber(report.summary.overstockCount)} />
            <MetricCard icon={<RotateCcw size={18} />} metricId="stock.negative" label="Отрицательный остаток" value={formatDecimal(report.summary.negativeStockQty, 1)} />
            <MetricCard icon={<Package size={18} />} metricId="stock.unvalued" label="Без стоимости" value={formatDecimal(report.summary.unvaluedQty, 1)} status={report.summary.unvaluedQty > 0 ? "partial" : "ready"} />
          </section>

          {renderSection("Остатки", "stock", report.items, stockColumns)}
          {renderSection("Нет в наличии при подтверждённом спросе", "outOfStock", report.outOfStock, shortColumns)}
          {renderSection("Запас более 45 дней", "overstock", report.overstock, shortColumns)}
          {renderSection("Запас 30–45 дней", "slowMoving", report.slowMoving, shortColumns)}
          {renderSection("Нет продаж более 30 дней", "dead", report.dead, shortColumns)}

          <section className="panel">
            <div className="panel-title"><h3>Сводка по запасам</h3></div>
            <div className="stack-list">
              <div className="summary-row">
                <strong>Всего товаров в анализе</strong>
                <span>{formatNumber(report.summary.totalItems)}</span>
              </div>
              <div className="summary-row">
                <strong>Товаров с остатком</strong>
                <span>{formatNumber(report.summary.itemsWithStock)}</span>
              </div>
              <div className="summary-row">
                <strong>Дата среза остатков</strong>
                <span>{formatDate(report.summary.stockPeriod)}</span>
              </div>
              <div className="summary-row">
                <strong>Зарезервировано</strong>
                <span>{formatDecimal(report.summary.reservedQty, 1)}</span>
              </div>
              <div className="summary-row">
                <strong>Оценённый запас, минимум</strong>
                <span>{formatMoney(report.summary.totalStockCost)}</span>
              </div>
              <div className="summary-row">
                <strong>Розничная оценка запаса</strong>
                <span>{formatMoney(report.summary.totalStockRetail)}</span>
              </div>
              <div className="summary-row">
                <strong>Нет в наличии при спросе</strong>
                <span>{formatNumber(report.summary.outOfStockCount)}</span>
              </div>
              <div className="summary-row">
                <strong>Избыточный запас (&gt; 45 дней)</strong>
                <span>{formatNumber(report.summary.overstockCount)}</span>
              </div>
              <div className="summary-row">
                <strong>Медленно оборачиваемые</strong>
                <span>{formatNumber(report.summary.slowMovingCount)}</span>
              </div>
              <div className="summary-row">
                <strong>Неликвид</strong>
                <span>{formatNumber(report.summary.deadCount)}</span>
              </div>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}

const abcColors: Record<string, string> = {
  A: "#22815f",
  B: "#e6a817",
  C: "#e07b5a"
};

const xyzLabels: Record<string, string> = {
  X: "X — стабильный спрос",
  Y: "Y — умеренные колебания",
  Z: "Z — нерегулярный спрос"
};

const ageLabels: Record<string, string> = {
  new: "Новинки (< 30 дн)",
  regular: "Регулярные",
  old: "Старые (> 180 дн)"
};

const exitReasonLabels: Record<ExitProductReason, string> = {
  no_sales: "Нет чистых продаж",
  dead_stock: "Нет продаж более 30 дней",
  slow_moving: "Запас 30–45 дней",
  overstock: "Запас более 45 дней"
};

function NomenclatureReports() {
  const [period, setPeriod] = useState<SalesPeriod>("day");
  const [dateRange, setDateRange] = useState<DateRangeValue>(currentMonthRange);
  const [state, setState] = useState<LoadState<NomenclatureReport>>({ status: "loading" });
  const [showAllTop, setShowAllTop] = useState(false);
  const [showAllAnti, setShowAllAnti] = useState(false);
  const [showAllVelocity, setShowAllVelocity] = useState(false);
  const [showAllProfit, setShowAllProfit] = useState(false);
  const [showAllLost, setShowAllLost] = useState(false);
  const [showAllExit, setShowAllExit] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    api
      .nomenclatureReport({ period, ...dateRange }, controller.signal)
      .then((report) => {
        if (!controller.signal.aborted) {
          setState({ status: "success", data: report });
        }
      })
      .catch((caught) => {
        if (controller.signal.aborted) {
          return;
        }

        setState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить анализ номенклатуры"
        });
      });

    return () => controller.abort();
  }, [dateRange.from, dateRange.to, period]);

  const report = state.data;
  const items = report?.items ?? [];
  const exitItems = report?.exitItems ?? [];

  const topSellers = useMemo(() => items.slice(0, showAllTop ? items.length : 15), [items, showAllTop]);
  const antiLeaders = useMemo(() => [...items].sort((a, b) => a.revenue - b.revenue).slice(0, showAllAnti ? items.length : 15), [items, showAllAnti]);
  const byVelocity = useMemo(() => [...items].sort((a, b) => b.salesVelocity - a.salesVelocity).slice(0, showAllVelocity ? items.length : 15), [items, showAllVelocity]);
  const byProfit = useMemo(() => [...items].sort((a, b) => (b.marginPct ?? Number.NEGATIVE_INFINITY) - (a.marginPct ?? Number.NEGATIVE_INFINITY)).slice(0, showAllProfit ? items.length : 15), [items, showAllProfit]);
  const lostSales = useMemo(() => [...items].filter((i) => i.daysWithoutSales > 0).sort((a, b) => b.daysWithoutSales - a.daysWithoutSales).slice(0, showAllLost ? items.length : 15), [items, showAllLost]);
  const exitProducts = useMemo(() => exitItems.slice(0, showAllExit ? exitItems.length : 15), [exitItems, showAllExit]);

  const abcGroups = useMemo(() => ({
    A: items.filter((i) => i.abcClass === "A"),
    B: items.filter((i) => i.abcClass === "B"),
    C: items.filter((i) => i.abcClass === "C")
  }), [items]);

  const xyzGroups = useMemo(() => ({
    X: items.filter((i) => i.xyzClass === "X"),
    Y: items.filter((i) => i.xyzClass === "Y"),
    Z: items.filter((i) => i.xyzClass === "Z")
  }), [items]);

  const abcXyzMatrix = useMemo(() => {
    const matrix: Record<string, ItemAnalysis[]> = {};
    for (const a of ["A", "B", "C"]) {
      for (const x of ["X", "Y", "Z"]) {
        matrix[`${a}${x}`] = items.filter((i) => i.abcClass === a && i.xyzClass === x);
      }
    }
    return matrix;
  }, [items]);

  const ageGroups = useMemo(() => ({
    new: items.filter((i) => i.ageCategory === "new"),
    regular: items.filter((i) => i.ageCategory === "regular"),
    old: items.filter((i) => i.ageCategory === "old")
  }), [items]);

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Номенклатура</h2>
          <span>чистые продажи · календарные дни · единая себестоимость</span>
        </div>
        <ReportFilterBar
          period={period}
          onPeriodChange={setPeriod}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
        />
      </div>

      {state.status === "loading" ? <div className="empty-state">Загружаем анализ номенклатуры</div> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}

      {report ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Сводка номенклатуры">
            <MetricCard icon={<Package size={18} />} metricId="catalog.items" label="Товаров" value={formatNumber(items.length)} />
            <MetricCard icon={<CalendarDays size={18} />} metricId="catalog.days" label="Календарных дней" value={formatNumber(report.totalDays)} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="catalog.abc" label="ABC: A-класс" value={formatNumber(abcGroups.A.length)} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="catalog.xyz" label="XYZ: X-класс" value={formatNumber(xyzGroups.X.length)} />
            <MetricCard icon={<Boxes size={18} />} metricId="catalog.candidates" label="Кандидаты на действие" value={formatNumber(report.exitSummary.totalItems)} />
            <MetricCard icon={<Package size={18} />} metricId="catalog.candidate-stock" label="Остаток кандидатов" value={formatDecimal(report.exitSummary.stockQty, 1)} />
            <MetricCard icon={<Clock size={18} />} metricId="catalog.no-sales" label="Без продаж" value={formatNumber(report.exitSummary.noSalesCount + report.exitSummary.deadStockCount)} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="catalog.candidate-cost" label="Оценённая стоимость" value={formatMoneyCompact(report.exitSummary.stockCost)} status={report.exitSummary.unvaluedQty > 0 ? "partial" : "ready"} coveragePct={report.exitSummary.costCoveragePct} />
          </section>
          <div className="metric-note warning">
            Кандидаты требуют решения закупщика; это не автоматический список вывода товаров.
            Неоценённый остаток: {formatDecimal(report.exitSummary.unvaluedQty, 1)} ед.
          </div>

          <ExpandableTable
            title="Кандидаты на действие"
            subtitle={`остаток на ${formatDate(report.exitSummary.stockPeriod)} · ${formatNumber(exitItems.length)} товаров`}
            items={exitProducts}
            expanded={showAllExit}
            onToggle={() => setShowAllExit((v) => !v)}
            totalCount={exitItems.length}
            columns={exitProductColumns}
          />

          {/* ТОП продаваемых */}
          <ExpandableTable
            title="ТОП продаваемых товаров"
            subtitle={`${formatNumber(topSellers.length)} из ${formatNumber(items.length)}`}
            items={topSellers}
            expanded={showAllTop}
            onToggle={() => setShowAllTop((v) => !v)}
            totalCount={items.length}
            columns={nomenclatureColumns}
          />

          {/* Антилидеры */}
          <ExpandableTable
            title="Антилидеры"
            subtitle={`${formatNumber(antiLeaders.length)} из ${formatNumber(items.length)}`}
            items={antiLeaders}
            expanded={showAllAnti}
            onToggle={() => setShowAllAnti((v) => !v)}
            totalCount={items.length}
            columns={nomenclatureColumns}
          />

          {/* ABC-анализ */}
          <section className="panel">
            <div className="panel-title"><h3><MetricLabel metricId="catalog.abc">ABC-анализ</MetricLabel></h3><span>по доле в чистой выручке</span></div>
            <div className="reports-grid three-col">
              {(["A", "B", "C"] as const).map((cls) => (
                <div key={cls} className="panel">
                  <div className="panel-title">
                    <h4 style={{ color: abcColors[cls] }}>
                      Класс {cls} — {cls === "A" ? "80%" : cls === "B" ? "15%" : "5%"} выручки
                    </h4>
                    <span>{formatNumber(abcGroups[cls].length)} товаров</span>
                  </div>
                  <div className="heatmap-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Товар</th>
                          <th className="num"><MetricLabel metricId="sales.net">Чистая выручка</MetricLabel></th>
                          <th className="num"><MetricLabel metricId="catalog.revenue-share">Доля</MetricLabel></th>
                        </tr>
                      </thead>
                      <tbody>
                        {abcGroups[cls].slice(0, 20).map((item) => (
                          <tr key={item.key}>
                            <td>{item.name}</td>
                            <td className="num">{formatMoney(item.revenue)}</td>
                            <td className="num">{formatDecimal(item.revenuePct, 1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* XYZ-анализ */}
          <section className="panel">
            <div className="panel-title"><h3><MetricLabel metricId="catalog.xyz">XYZ-анализ</MetricLabel></h3><span>по коэффициенту вариации календарного спроса</span></div>
            <div className="reports-grid three-col">
              {(["X", "Y", "Z"] as const).map((cls) => (
                <div key={cls} className="panel">
                  <div className="panel-title">
                    <h4>{xyzLabels[cls]}</h4>
                    <span>{formatNumber(xyzGroups[cls].length)} товаров</span>
                  </div>
                  <div className="heatmap-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Товар</th>
                          <th className="num"><MetricLabel metricId="catalog.xyz">CV, %</MetricLabel></th>
                          <th className="num"><MetricLabel metricId="catalog.velocity">Продаж/день</MetricLabel></th>
                        </tr>
                      </thead>
                      <tbody>
                        {xyzGroups[cls].slice(0, 20).map((item) => (
                          <tr key={item.key}>
                            <td>{item.name}</td>
                            <td className="num">{formatDecimal(item.cvPct, 1)}%</td>
                            <td className="num">{formatDecimal(item.salesVelocity, 2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ABC+XYZ матрица */}
          <section className="panel">
            <div className="panel-title"><h3><MetricLabel metricId="catalog.xyz">ABC+XYZ матрица</MetricLabel></h3><span>количество товаров в каждой ячейке</span></div>
            <div
              className="matrix-grid"
              style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px" }}
            >
              {["A", "B", "C"].map((a) =>
                ["X", "Y", "Z"].map((x) => {
                  const cell = abcXyzMatrix[`${a}${x}`] ?? [];
                  return (
                    <div
                      key={`${a}${x}`}
                      className="panel"
                      style={{ borderLeft: `3px solid ${abcColors[a]}`, padding: "12px" }}
                    >
                      <strong>{a}{x}</strong>
                      <span style={{ float: "right", color: "#475467" }}>
                        {formatNumber(cell.length)}
                      </span>
                      <div style={{ fontSize: "12px", color: "#98a2b3", marginTop: "4px" }}>
                        {a === "A" ? "Высокая выручка" : a === "B" ? "Средняя" : "Низкая"}
                        {" · "}
                        {x === "X" ? "Стабильный" : x === "Y" ? "Колеблющийся" : "Нерегулярный"}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Новинки vs старые */}
          <section className="panel">
            <div className="panel-title"><h3>Новинки vs старые товары</h3></div>
            <div className="reports-grid three-col">
              {(["new", "regular", "old"] as const).map((cat) => (
                <div key={cat} className="panel">
                  <div className="panel-title">
                    <h4>{ageLabels[cat]}</h4>
                    <span>{formatNumber(ageGroups[cat].length)} товаров</span>
                  </div>
                  <div className="heatmap-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Товар</th>
                          <th className="num"><MetricLabel metricId="sales.net">Чистая выручка</MetricLabel></th>
                          <th className="num"><MetricLabel metricId="catalog.velocity">Продаж/день</MetricLabel></th>
                        </tr>
                      </thead>
                      <tbody>
                        {ageGroups[cat].slice(0, 20).map((item) => (
                          <tr key={item.key}>
                            <td>{item.name}</td>
                            <td className="num">{formatMoney(item.revenue)}</td>
                            <td className="num">{formatDecimal(item.salesVelocity, 2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Скорость продаж */}
          <ExpandableTable
            title="Скорость продажи товара"
            subtitle="единиц в день"
            items={byVelocity}
            expanded={showAllVelocity}
            onToggle={() => setShowAllVelocity((v) => !v)}
            totalCount={items.length}
            columns={[
              { key: "name", label: "Товар", render: (r) => r.name },
              { key: "qty", label: "Продано", num: true, render: (r) => formatDecimal(r.qty, 1) },
              { key: "salesVelocity", label: "Ед/день", num: true, render: (r) => formatDecimal(r.salesVelocity, 2) },
              { key: "cvPct", label: "CV, %", num: true, render: (r) => `${formatDecimal(r.cvPct, 1)}%` },
              { key: "revenue", label: "Выручка", num: true, render: (r) => formatMoney(r.revenue) }
            ]}
          />

          {/* Доходность */}
          <ExpandableTable
            title="Доходность товара"
            subtitle="по маржинальности"
            items={byProfit}
            expanded={showAllProfit}
            onToggle={() => setShowAllProfit((v) => !v)}
            totalCount={items.length}
            columns={[
              { key: "name", label: "Товар", render: (r) => r.name },
              { key: "marginPct", label: "Маржа", num: true, render: (r) => r.marginPct === null ? "Нет стоимости" : `${formatDecimal(r.marginPct, 1)}%` },
              { key: "revenue", label: "Чистая выручка", num: true, render: (r) => formatMoney(r.revenue) },
              { key: "grossProfit", label: "Оценённая прибыль", num: true, render: (r) => r.grossProfit === null ? "Нет стоимости" : formatMoney(r.grossProfit) },
              { key: "cost", label: "Оценённая себест-ть", num: true, render: (r) => r.cost === null ? "Нет стоимости" : formatMoney(r.cost) }
            ]}
          />

          {/* Дни без продаж */}
          <ExpandableTable
            title="Дни без продаж"
            subtitle="не является денежной метрикой Lost Sales"
            items={lostSales}
            expanded={showAllLost}
            onToggle={() => setShowAllLost((v) => !v)}
            totalCount={items.filter((i) => i.daysWithoutSales > 0).length}
            columns={[
              { key: "name", label: "Товар", render: (r) => r.name },
              { key: "daysWithoutSales", label: "Дней без продаж", num: true, render: (r) => formatNumber(r.daysWithoutSales) },
              { key: "daysWithSales", label: "Дней с продажами", num: true, render: (r) => formatNumber(r.daysWithSales) },
              { key: "lastSaleDate", label: "Последняя продажа", num: true, render: (r) => formatDate(r.lastSaleDate) },
              { key: "salesVelocity", label: "Ед/день", num: true, render: (r) => formatDecimal(r.salesVelocity, 2) }
            ]}
          />
        </>
      ) : null}
    </section>
  );
}

const nomenclatureColumns = [
  { key: "name", label: "Товар", render: (r: ItemAnalysis) => r.name },
  { key: "qty", label: "Продано", num: true, render: (r: ItemAnalysis) => formatDecimal(r.qty, 1) },
  { key: "revenue", label: "Чистая выручка", metricId: "sales.net" as MetricId, num: true, render: (r: ItemAnalysis) => formatMoney(r.revenue) },
  { key: "grossProfit", label: "Оценённая прибыль", metricId: "income.gross-profit" as MetricId, num: true, render: (r: ItemAnalysis) => r.grossProfit === null ? "Нет стоимости" : formatMoney(r.grossProfit) },
  { key: "marginPct", label: "Маржа", metricId: "income.margin" as MetricId, num: true, render: (r: ItemAnalysis) => r.marginPct === null ? "Нет стоимости" : `${formatDecimal(r.marginPct, 1)}%` },
  { key: "abcClass", label: "ABC", metricId: "catalog.abc" as MetricId, num: true, render: (r: ItemAnalysis) => r.abcClass },
  { key: "xyzClass", label: "XYZ", metricId: "catalog.xyz" as MetricId, num: true, render: (r: ItemAnalysis) => r.xyzClass }
];

const exitProductColumns = [
  { key: "name", label: "Товар", render: (r: ExitProduct) => r.name },
  { key: "reason", label: "Причина", render: (r: ExitProduct) => exitReasonLabels[r.reason] },
  { key: "stockQty", label: "Остаток", num: true, render: (r: ExitProduct) => formatDecimal(r.stockQty, 1) },
  { key: "recentSoldQty", label: "Продано", num: true, render: (r: ExitProduct) => formatDecimal(r.recentSoldQty, 1) },
  { key: "dailySalesRate", label: "Ед/день", num: true, render: (r: ExitProduct) => formatDecimal(r.dailySalesRate, 3) },
  {
    key: "daysOfStock",
    label: "Дней запаса",
    num: true,
    render: (r: ExitProduct) => (r.daysOfStock === null ? "—" : formatNumber(Math.round(r.daysOfStock)))
  },
  {
    key: "daysSinceLastSale",
    label: "Дней без продаж",
    num: true,
    render: (r: ExitProduct) => (r.daysSinceLastSale === null ? "—" : formatNumber(r.daysSinceLastSale))
  },
  {
    key: "daysSinceLastPurchase",
    label: "Дней с поступления",
    num: true,
    render: (r: ExitProduct) => (r.daysSinceLastPurchase === null ? "—" : formatNumber(r.daysSinceLastPurchase))
  },
  { key: "stockCost", label: "Оценённая себест-ть", metricId: "stock.cost" as MetricId, num: true, render: (r: ExitProduct) => r.stockCost === null ? "Нет стоимости" : formatMoney(r.stockCost) },
  { key: "frozenStockCost", label: "Заморожено", metricId: "stock.frozen" as MetricId, num: true, render: (r: ExitProduct) => r.frozenStockCost === null ? "Нет стоимости" : formatMoney(r.frozenStockCost) },
  { key: "lastSaleDate", label: "Последняя продажа", num: true, render: (r: ExitProduct) => formatDate(r.lastSaleDate) }
];

type ColumnDef<T> = {
  key: string;
  label: string;
  num?: boolean;
  metricId?: MetricId;
  render: (row: T) => string;
};

function ExpandableTable<T extends { key: string }>({
  title,
  subtitle,
  items,
  expanded,
  onToggle,
  totalCount,
  columns
}: {
  title: string;
  subtitle: string;
  items: T[];
  expanded: boolean;
  onToggle: () => void;
  totalCount: number;
  columns: ColumnDef<T>[];
}) {
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h3>{title}</h3>
          <span>{subtitle}</span>
        </div>
        {totalCount > 15 ? (
          <button className="segmented-control" onClick={onToggle} type="button" style={{ border: "1px solid #e4e7ec", borderRadius: "6px", padding: "4px 12px", cursor: "pointer", background: "#fff", fontSize: "13px" }}>
            {expanded ? "Свернуть" : `Показать все (${formatNumber(totalCount)})`}
          </button>
        ) : null}
      </div>
      <div className="heatmap-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} className={col.num ? "num" : ""}>
                  {col.metricId ? <MetricLabel metricId={col.metricId}>{col.label}</MetricLabel> : col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}>
                {columns.map((col) => (
                  <td key={col.key} className={col.num ? "num" : ""}>
                    {col.render(item)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TableDetail({ tableName }: { tableName: string }) {
  const [profileState, setProfileState] = useState<LoadState<TableProfile>>({
    status: "loading"
  });
  const [dateColumn, setDateColumn] = useState("");
  const [metricColumn, setMetricColumn] = useState("");
  const [series, setSeries] = useState<LoadState<TimeSeriesPoint[]>>({
    status: "idle"
  });

  useEffect(() => {
    setProfileState({ status: "loading" });
    setSeries({ status: "idle" });
    api
      .table(tableName)
      .then((profile) => {
        const firstDate = profile.columns.find((column) => column.isTemporal)?.name ?? "";
        setProfileState({ status: "success", data: profile });
        setDateColumn(firstDate);
        setMetricColumn("");
      })
      .catch((caught) =>
        setProfileState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить таблицу"
        })
      );
  }, [tableName]);

  useEffect(() => {
    if (!dateColumn) {
      return;
    }

    setSeries({ status: "loading" });
    api
      .timeSeries(tableName, dateColumn, metricColumn || undefined)
      .then((points) => setSeries({ status: "success", data: points }))
      .catch((caught) =>
        setSeries({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось построить график"
        })
      );
  }, [dateColumn, metricColumn, tableName]);

  if (profileState.status === "loading") {
    return <div className="empty-state">Загружаем таблицу {tableName}</div>;
  }

  if (profileState.status === "error") {
    return <div className="empty-state">{profileState.error}</div>;
  }

  if (profileState.status !== "success") {
    return <div className="empty-state">Нет данных для таблицы {tableName}</div>;
  }

  const profile = profileState.data;
  const numericColumns = profile.columns.filter((column) => column.isNumeric);
  const dateColumns = profile.columns.filter((column) => column.isTemporal);
  const sampleColumns = profile.columns.slice(0, 8);

  return (
    <section className="table-detail">
      <div className="section-heading row">
        <div>
          <h2>{tableName}</h2>
          <span>
            {formatCompact(profile.table?.estimatedRows ?? 0)} строк ·{" "}
            {formatBytes(profile.table?.totalBytes ?? 0)}
          </span>
        </div>
        <div className="column-count">{profile.columns.length} колонок</div>
      </div>

      <div className="detail-grid">
        <div className="panel wide">
          <div className="panel-title">
            <h3>Динамика</h3>
            <div className="controls">
              <select
                value={dateColumn}
                onChange={(event) => setDateColumn(event.target.value)}
                disabled={dateColumns.length === 0}
              >
                {dateColumns.length === 0 ? (
                  <option>Нет дат</option>
                ) : (
                  dateColumns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.name}
                    </option>
                  ))
                )}
              </select>
              <select
                value={metricColumn}
                onChange={(event) => setMetricColumn(event.target.value)}
                disabled={numericColumns.length === 0}
              >
                <option value="">Количество строк</option>
                {numericColumns.map((column) => (
                  <option key={column.name} value={column.name}>
                    Σ {column.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="chart-wrap compact">
            {series.status === "success" && series.data.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={series.data}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={(value) => formatDate(String(value))}
                    minTickGap={24}
                  />
                  <YAxis tickFormatter={formatCompact} width={68} />
                  <Tooltip
                    labelFormatter={(value) => formatDate(String(value))}
                    formatter={(value) => formatNumber(Number(value))}
                    labelStyle={{ color: "#172033" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="metric"
                    stroke="#22815f"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state inset">
                {dateColumns.length === 0
                  ? "В таблице нет временных колонок"
                  : series.status === "error"
                    ? series.error
                    : "Нет точек для графика"}
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <h3>Диапазоны дат</h3>
          </div>
          <div className="stack-list">
            {profile.temporalSummaries.length === 0 ? (
              <span className="muted">Нет временных колонок</span>
            ) : (
              profile.temporalSummaries.map((item) => (
                <div key={item.column} className="summary-row">
                  <strong>{item.column}</strong>
                  <span>
                    {formatDate(item.min)} — {formatDate(item.max)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <h3>Числовые поля</h3>
          </div>
          <div className="stack-list">
            {profile.numericSummaries.length === 0 ? (
              <span className="muted">Нет числовых колонок</span>
            ) : (
              profile.numericSummaries.map((item) => (
                <div key={item.column} className="summary-row">
                  <strong>{item.column}</strong>
                  <span>avg {item.avg === null ? "NULL" : formatNumber(item.avg)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <h3>Колонки</h3>
        </div>
        <div className="column-grid">
          {profile.columns.map((column) => (
            <div key={column.name} className="column-chip" title={column.name}>
              <strong>{column.name}</strong>
              <span>{column.dataType}</span>
            </div>
          ))}
        </div>
      </div>

      {profile.topValues.length > 0 ? (
        <div className="panel">
          <div className="panel-title">
            <h3>Популярные значения</h3>
          </div>
          <div className="top-values">
            {profile.topValues.map((group) => (
              <div key={group.column} className="top-group">
                <strong>{group.column}</strong>
                {group.values.map((value) => (
                  <div key={`${group.column}-${value.value}`} className="top-row">
                    <span>{value.value ?? "NULL"}</span>
                    <b>{formatCompact(value.count)}</b>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-title">
          <h3>Пример строк</h3>
          <span>первые 25 записей</span>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {sampleColumns.map((column) => (
                  <th key={column.name}>{column.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {profile.sampleRows.map((row, index) => (
                <tr key={index}>
                  {sampleColumns.map((column) => (
                    <td key={column.name}>{formatCell(row[column.name])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function MetricCard({
  icon,
  metricId,
  label,
  value,
  detail,
  status,
  coveragePct,
  asOf,
  reason
}: {
  icon: React.ReactNode;
  metricId: MetricId;
  label?: string;
  value: string | null;
  detail?: string;
  status?: MetricStatus;
  coveragePct?: number;
  asOf?: string | null;
  reason?: string;
}) {
  const resolvedStatus = value === null ? "unavailable" : status;
  return (
    <div className={`metric-card${resolvedStatus ? ` metric-card-${resolvedStatus}` : ""}`}>
      <div className="metric-icon">{icon}</div>
      <MetricLabel
        metricId={metricId}
        status={resolvedStatus}
        coveragePct={coveragePct}
        asOf={asOf}
        reason={reason}
      >
        {label}
      </MetricLabel>
      <strong>{value ?? "Нет данных"}</strong>
      {detail || reason ? <small className="metric-detail">{detail ?? reason}</small> : null}
    </div>
  );
}

const syncStatusLabels: Record<string, string> = {
  success: "успех",
  failed: "ошибка",
  interrupted: "прерван",
  running: "выполняется"
};

const syncModeLabels: Record<string, string> = {
  scheduled: "расписание",
  explicit: "вручную"
};

function syncStatusClass(status: string | null | undefined) {
  if (status === "success") {
    return "active";
  }

  if (status === "failed") {
    return "failed";
  }

  return "upcoming";
}

function syncStatusLabel(status: string | null | undefined) {
  if (!status) {
    return "нет данных";
  }

  return syncStatusLabels[status] ?? status;
}

function formatAgeHours(ageHours: number | null) {
  if (ageHours === null) {
    return "—";
  }

  if (ageHours < 1) {
    return "меньше часа";
  }

  if (ageHours < 48) {
    return `${Math.round(ageHours)} ч`;
  }

  return `${Math.floor(ageHours / 24)} дн ${Math.round(ageHours % 24)} ч`;
}

function syncRangeLabel(run: SyncRun) {
  if (!run.range_start || !run.range_end_exclusive) {
    return "—";
  }

  return `${formatDate(run.range_start)} → ${formatDate(run.range_end_exclusive)}`;
}

// The scheduler is the only component that can answer "why did the sync not
// run?": a skip writes no run row, and its own output lives in the container.
function schedulerStatusLabel(status: string | null | undefined) {
  switch (status) {
    case "running":
      return "выполняет экспорт";
    case "starting":
      return "запускается";
    case "idle":
      return "ожидает по расписанию";
    case "failed":
      return "ошибка";
    case "stopped":
      return "остановлен";
    default:
      return "нет данных";
  }
}

function schedulerStatusClass(status: string | null | undefined) {
  if (status === "failed") {
    return "failed";
  }

  if (status === "running" || status === "idle") {
    return "active";
  }

  return "upcoming";
}

function schedulerReasonLabel(scheduler: SyncSchedulerStatus) {
  const cooldown = scheduler.nextBypassAllowedAt
    ? ` · обход окна доступен ${formatDateTime(scheduler.nextBypassAllowedAt)}`
    : "";

  switch (scheduler.lastReason) {
    case "startup_bypass":
      return "запуск при старте вне окна (SCHEDULE_STARTUP_IGNORE_WINDOW=true)";
    case "schedule_window":
      return "плановый запуск внутри окна обслуживания";
    case "outside_window":
      return `вне окна ${scheduler.windowStart ?? "—"}–${scheduler.windowEnd ?? "—"}`;
    case "bypass_cooldown":
      return `обход окна запрещён кулдауном${cooldown}`;
    case "already_succeeded":
      return `в этом окне уже был успешный запуск${cooldown}`;
    case "run_on_startup_disabled":
      return "запуск при старте выключен (SCHEDULE_RUN_ON_STARTUP=false)";
    case "probe_failed":
      return "1C недоступна: проверка сети не прошла, контейнер перезапускается";
    case "export_failed":
      return "экспорт завершился с ошибкой";
    case "window_expired":
      return "окно обслуживания истекло во время экспорта";
    case "success":
      return "экспорт завершён успешно";
    case "stopped":
      return "остановлен по сигналу";
    case "interrupted":
      return "прерван по сигналу";
    case null:
    case undefined:
      return "решений пока не было";
    default:
      return scheduler.lastReason;
  }
}

function schedulerDecisionLabel(decision: string | null | undefined) {
  switch (decision) {
    case "started":
      return "запуск";
    case "finished":
      return "завершён";
    case "skipped":
      return "пропуск";
    case "failed":
      return "ошибка";
    case "stopped":
    case "interrupted":
      return "остановлен";
    default:
      return decision ?? "—";
  }
}

function schedulerSilent(scheduler: SyncSchedulerStatus) {
  if (!scheduler.updatedAtUtc) {
    return true;
  }

  const ageSeconds = (Date.now() - new Date(scheduler.updatedAtUtc).getTime()) / 1000;
  // The scheduler publishes every heartbeat; a multiple of it means the
  // container is gone even though the table still holds its last state.
  return ageSeconds > Math.max(3 * (scheduler.heartbeatSeconds ?? 30), 180);
}

function SyncFreshnessTable({ rows }: { rows: SyncTableFreshness[] }) {
  if (rows.length === 0) {
    return <p className="muted">Таблиц этой группы в схеме нет.</p>;
  }

  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Таблица</th>
            <th className="num">Строк</th>
            <th className="num">Изменений</th>
            <th>Последнее изменение (UTC)</th>
            <th className="num">Давность</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.table}>
              <td title={row.table}>{row.table}</td>
              <td className="num">{formatNumber(row.rows)}</td>
              <td className="num">{formatNumber(row.changes)}</td>
              <td>{row.lastChangeUtc ?? "—"}</td>
              <td className="num">
                {formatAgeHours(row.ageHours)}
                {row.unchangedForOverTwoDays ? (
                  <span className="status-chip upcoming" style={{ marginLeft: 8 }}>
                    устарела
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SyncPanel() {
  const [state, setState] = useState<LoadState<SyncHealth>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    api
      .syncHealth(controller.signal)
      .then((health) => {
        if (!controller.signal.aborted) {
          setState({ status: "success", data: health });
        }
      })
      .catch((caught) => {
        if (controller.signal.aborted) {
          return;
        }

        setState({
          status: "error",
          error:
            caught instanceof Error
              ? caught.message
              : "Не удалось загрузить состояние синхронизации"
        });
      });

    return () => controller.abort();
  }, []);

  const health = state.data;
  const latest = health?.latest ?? null;
  const failedChunk = latest?.per_chunk.find((chunk) => chunk.exit_code !== 0) ?? null;
  const hoursSinceStart = latest?.started_at
    ? (Date.now() - new Date(latest.started_at).getTime()) / 3_600_000
    : null;
  const runOverdue =
    health !== undefined && hoursSinceStart !== null && hoursSinceStart > health.staleAfterHours;

  return (
    <section className="panel sync-panel">
      <div className="panel-title">
        <h3>Синхронизация 1C</h3>
        {health ? (
          <span>
            {latest
              ? `Последний запуск ${formatDateTime(latest.started_at)} · прошло ${formatAgeHours(hoursSinceStart)}`
              : "Записей о запусках нет"}
            {runOverdue ? " · запуск давно не выполнялся" : ""}
          </span>
        ) : null}
      </div>

      {state.status === "loading" ? (
        <FullScreenState title="Загружаем состояние синхронизации" compact />
      ) : null}

      {state.status === "error" ? (
        <div className="empty-state inset">{state.error}</div>
      ) : null}

      {health && !health.available ? (
        <p className="panel-note">
          Таблица <code>ops.sync_runs</code> недоступна: у базы нет этой таблицы либо у роли
          сайта нет прав на схему <code>ops</code>. Свежесть таблиц ниже считается независимо.
          {health.unavailableReason ? ` Ответ базы: ${health.unavailableReason}` : ""}
        </p>
      ) : null}

      {health && health.available && !latest ? (
        <p className="panel-note">
          Планировщик экспорта ещё не записал ни одного запуска в <code>ops.sync_runs</code>.
        </p>
      ) : null}

      {health?.schedulerUnavailableReason ? (
        <p className="panel-note">
          Состояние планировщика недоступно: {health.schedulerUnavailableReason}
        </p>
      ) : null}

      {health?.scheduler ? (
        <>
          <dl className="sync-facts">
            <div>
              <dt>Планировщик на сервере экспорта</dt>
              <dd>
                <span
                  className={`status-chip ${schedulerStatusClass(health.scheduler.status)}`}
                >
                  {schedulerStatusLabel(health.scheduler.status)}
                </span>
                <span className="muted">
                  {" "}
                  · на связи {formatDateTime(health.scheduler.updatedAtUtc)}
                  {schedulerSilent(health.scheduler)
                    ? " · сигналов нет, контейнер мог быть остановлен"
                    : ""}
                </span>
              </dd>
            </div>
            <div>
              <dt>Последнее решение</dt>
              <dd>
                <span className="muted">
                  {schedulerDecisionLabel(health.scheduler.lastDecision)}
                  {" · "}
                </span>
                {schedulerReasonLabel(health.scheduler)}
                <span className="muted">
                  {health.scheduler.lastDecisionAt
                    ? ` · ${formatDateTime(health.scheduler.lastDecisionAt)}`
                    : ""}
                </span>
              </dd>
            </div>
            <div>
              <dt>Следующий плановый запуск</dt>
              <dd>{formatDateTime(health.scheduler.nextRunAt)}</dd>
            </div>
            <div>
              <dt>Запуск при старте и обход окна</dt>
              <dd>
                <code>SCHEDULE_RUN_ON_STARTUP={health.scheduler.runOnStartup ? "true" : "false"}</code>{" "}
                <code>
                  SCHEDULE_STARTUP_IGNORE_WINDOW=
                  {health.scheduler.ignoreWindow ? "true" : "false"}
                </code>
                <span className="muted">
                  {health.scheduler.minIntervalHours !== null
                    ? ` · кулдаун обхода ${health.scheduler.minIntervalHours} ч`
                    : ""}
                </span>
              </dd>
            </div>
            <div>
              <dt>Окно обслуживания</dt>
              <dd>
                {health.scheduler.windowStart ?? "—"}–{health.scheduler.windowEnd ?? "—"}
                <span className="muted">
                  {health.scheduler.timezone ? ` ${health.scheduler.timezone}` : ""}
                </span>
              </dd>
            </div>
          </dl>

          {health.scheduler.logTail ? (
            <details
              className="sync-log"
              open={
                health.scheduler.status === "failed" ||
                health.scheduler.lastReason === "bypass_cooldown" ||
                health.scheduler.lastReason === "probe_failed"
              }
            >
              <summary>
                Последние строки лога планировщика
                <span className="muted">
                  {" "}
                  · {health.scheduler.logTail.split("\n").length} строк
                </span>
              </summary>
              <pre>{health.scheduler.logTail}</pre>
            </details>
          ) : null}
        </>
      ) : null}

      {health && latest ? (
        <>
          <dl className="sync-facts">
            <div>
              <dt>Состояние последнего запуска</dt>
              <dd>
                <span className={`status-chip ${syncStatusClass(latest.status)}`}>
                  {syncStatusLabel(latest.status)}
                </span>
                <span className="muted"> код выхода {latest.exit_code ?? "—"}</span>
              </dd>
            </div>
            <div>
              <dt>Завершён</dt>
              <dd>{formatDateTime(latest.finished_at)}</dd>
            </div>
            <div>
              <dt>Длительность</dt>
              <dd>{formatDurationSeconds(latest.duration_seconds)}</dd>
            </div>
            <div>
              <dt>Диапазон данных</dt>
              <dd>{syncRangeLabel(latest)}</dd>
            </div>
            <div>
              <dt>Строк прочитано / записано</dt>
              <dd>
                {formatNumber(latest.rows_read ?? 0)} / {formatNumber(latest.rows_written ?? 0)}
              </dd>
            </div>
            <div>
              <dt>Порции</dt>
              <dd>
                {latest.chunks_completed ?? 0} из {latest.chunks_planned ?? 0}
                {latest.mode ? ` · ${syncModeLabels[latest.mode] ?? latest.mode}` : ""}
              </dd>
            </div>
            <div>
              <dt>Данные покрыты до</dt>
              <dd>
                {formatDate(latest.checkpoint_after)}
                <span className="muted">
                  {latest.checkpoint_before
                    ? ` · было ${formatDate(latest.checkpoint_before)}`
                    : ""}
                </span>
              </dd>
            </div>
            <div>
              <dt>Глубокая перепроверка</dt>
              <dd>
                {formatDate(latest.deep_reread_month)}
                <span className="muted">
                  {latest.deep_reread_status ? ` · ${syncStatusLabel(latest.deep_reread_status)}` : ""}
                </span>
              </dd>
            </div>
            <div>
              <dt>Лог запуска на сервере экспорта</dt>
              <dd>
                {latest.log_file ? <code>{latest.log_file}</code> : <span className="muted">—</span>}
              </dd>
            </div>
            <div>
              <dt>Файл метрик</dt>
              <dd>
                {latest.metrics_file ? (
                  <code>{latest.metrics_file}</code>
                ) : (
                  <span className="muted">—</span>
                )}
              </dd>
            </div>
          </dl>

          {latest.error_class || failedChunk ? (
            <p className="panel-note">
              {failedChunk
                ? `Порция ${failedChunk.start} → ${failedChunk.end_exclusive} завершилась с кодом ${failedChunk.exit_code}. `
                : ""}
              {latest.error_class ? `Причина: ${latest.error_class}. ` : ""}
              Ниже — последние строки лога запуска; полный лог лежит на сервере
              экспорта по пути из «Лог запуска».
            </p>
          ) : null}

          {latest.log_tail ? (
            <details className="sync-log" open={latest.status !== "success"}>
              <summary>
                Последние строки лога запуска
                <span className="muted">
                  {" "}
                  · {latest.log_tail.split("\n").length} строк
                </span>
              </summary>
              <pre>{latest.log_tail}</pre>
            </details>
          ) : null}

          <p className="panel-note">
            «Изменений» — сколько раз содержимое таблицы менялось: <code>_loaded_at</code>
            {" "}обновляется только при изменении строк, поэтому давняя дата означает отсутствие
            новых данных в 1C, а не пропуск экспорта. Конец диапазона не включается.
            Сборка экспортёра: {latest.sync_source_sha256
              ? latest.sync_source_sha256.slice(0, 12)
              : "—"}
            {latest.skipped_entities ? ` · пропущено сущностей: ${latest.skipped_entities}` : ""}
            .
          </p>
        </>
      ) : null}

      {health ? (
        <>
          <h4 className="sync-subtitle">Свежесть таблиц</h4>
          {health.groups.map((group) => (
            <div key={group.title}>
              <p className="muted">{group.title}</p>
              <SyncFreshnessTable rows={group.tables} />
            </div>
          ))}
        </>
      ) : null}

      {health && health.runs.length > 0 ? (
        <>
          <h4 className="sync-subtitle">Последние запуски</h4>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Начало</th>
                  <th>Состояние</th>
                  <th>Режим</th>
                  <th>Диапазон</th>
                  <th className="num">Порции</th>
                  <th className="num">Строк (чтение → запись)</th>
                  <th className="num">Длительность</th>
                  <th>Причина</th>
                </tr>
              </thead>
              <tbody>
                {health.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{formatDateTime(run.started_at)}</td>
                    <td>
                      <span className={`status-chip ${syncStatusClass(run.status)}`}>
                        {syncStatusLabel(run.status)}
                      </span>
                    </td>
                    <td>{run.mode ? (syncModeLabels[run.mode] ?? run.mode) : "—"}</td>
                    <td>{syncRangeLabel(run)}</td>
                    <td className="num">
                      {run.chunks_completed ?? 0}/{run.chunks_planned ?? 0}
                    </td>
                    <td className="num">
                      {formatNumber(run.rows_read ?? 0)} → {formatNumber(run.rows_written ?? 0)}
                    </td>
                    <td className="num">{formatDurationSeconds(run.duration_seconds)}</td>
                    <td title={run.command ?? undefined}>
                      {run.error_class ?? (run.exit_code ? `код ${run.exit_code}` : "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function FullScreenState({ title, compact = false }: { title: string; compact?: boolean }) {
  return (
    <div className={compact ? "empty-state" : "boot-state"}>
      <div className="loader" />
      <span>{title}</span>
    </div>
  );
}
