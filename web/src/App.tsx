import {
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
  type DataGroup,
  type ExitProduct,
  type ExitProductReason,
  type IncomeReport,
  type InventoryReport,
  type ItemAnalysis,
  type MarketingPromotion,
  type MarketingReport,
  type NomenclatureReport,
  type Overview,
  type ReportDateRange,
  type SalesPeriod,
  type SalesReport,
  type SyncHealth,
  type SyncRun,
  type SyncTableFreshness,
  type TableProfile,
  type TimeSeriesPoint,
  type User
} from "./api";
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

type AppPage = "overview" | "reports" | "nomenclature" | "marketing" | "inventory";

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
    marketingOnly ? "marketing" : "reports"
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
              <button
                className={currentPage === "reports" ? "active" : ""}
                onClick={() => setCurrentPage("reports")}
                type="button"
              >
                <Receipt size={16} />
                <span>Отчеты</span>
              </button>
              <button
                className={currentPage === "nomenclature" ? "active" : ""}
                onClick={() => setCurrentPage("nomenclature")}
                type="button"
              >
                <Package size={16} />
                <span>Номенклатура</span>
              </button>
            </>
          ) : null}
          <button
            className={currentPage === "marketing" ? "active" : ""}
            onClick={() => setCurrentPage("marketing")}
            type="button"
          >
            <Megaphone size={16} />
            <span>Маркетинг</span>
          </button>
          {!marketingOnly ? (
            <>
              <button
                className={currentPage === "inventory" ? "active" : ""}
                onClick={() => setCurrentPage("inventory")}
                type="button"
              >
                <Boxes size={16} />
                <span>Запасы</span>
              </button>
              <button
                className={currentPage === "overview" ? "active" : ""}
                onClick={() => setCurrentPage("overview")}
                type="button"
              >
                <Database size={16} />
                <span>База данных</span>
              </button>
            </>
          ) : null}
        </nav>

        {currentPage === "overview" ? (
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
              {currentPage === "reports" ? <Receipt size={16} /> : currentPage === "nomenclature" ? <Package size={16} /> : currentPage === "marketing" ? <Megaphone size={16} /> : currentPage === "inventory" ? <Boxes size={16} /> : <LayoutDashboard size={16} />}
              {currentPage === "reports" ? "Отчеты" : currentPage === "nomenclature" ? "Номенклатура" : currentPage === "marketing" ? "Маркетинг" : currentPage === "inventory" ? "Запасы" : "Панель данных"}
            </span>
            <h1>{currentPage === "reports" ? "Отчеты по продажам" : currentPage === "nomenclature" ? "Анализ номенклатуры" : currentPage === "marketing" ? "Маркетинговые акции" : currentPage === "inventory" ? "Управление запасами" : "Аналитика PostgreSQL"}</h1>
          </div>
          <div className="user-actions">
            <span>{user.email}</span>
            <button className="icon-button" onClick={logout} title="Выйти">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {currentPage === "reports" ? (
          <ReportsPage />
        ) : currentPage === "nomenclature" ? (
          <NomenclatureReports />
        ) : currentPage === "marketing" ? (
          <MarketingReports />
        ) : currentPage === "inventory" ? (
          <InventoryReports />
        ) : (
          <>
            {overviewState.status === "loading" ? (
              <FullScreenState title="Загружаем метрики" compact />
            ) : null}

            {overviewState.status === "error" ? (
              <div className="empty-state">{overviewState.error}</div>
            ) : null}

            {overview ? (
              <>
                <section className="metric-grid" aria-label="Сводка">
                  <MetricCard
                    icon={<Database size={18} />}
                    label="Таблиц"
                    value={formatNumber(overview.tableCount)}
                  />
                  <MetricCard
                    icon={<BarChart3 size={18} />}
                    label="Строк, оценка"
                    value={formatCompact(overview.estimatedRows)}
                  />
                  <MetricCard
                    icon={<Table2 size={18} />}
                    label="Колонок"
                    value={formatNumber(overview.columnCount)}
                  />
                  <MetricCard
                    icon={<Database size={18} />}
                    label="Размер"
                    value={formatBytes(overview.totalBytes)}
                  />
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
                        <XAxis
                          dataKey="name"
                          tick={{ fontSize: 11 }}
                          interval={0}
                          angle={-20}
                          textAnchor="end"
                          height={82}
                        />
                        <YAxis tickFormatter={formatBytes} width={72} />
                        <Tooltip
                          formatter={(value) => formatBytes(Number(value))}
                          labelStyle={{ color: "#172033" }}
                        />
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

function ReportFilterBar({
  period,
  onPeriodChange,
  dateRange,
  onDateRangeChange,
  periodLabel = "Группировка"
}: {
  period: SalesPeriod;
  onPeriodChange: (period: SalesPeriod) => void;
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
          <h2>Отчеты по розничным продажам</h2>
          <span>
            document_marketingovaya_aktsiya · document_otchet_o_roznichnyh_prodazhah ·
            document_otchet_o_roznichnyh_prodazhah_tovary · catalog_segmenty_nomenklatury
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
          label="Выручка за выбранный период"
          value={formatMoney(report.summary.revenue)}
        />
        <MetricCard
          icon={<ShoppingCart size={18} />}
          label="Отчетов розницы"
          value={formatNumber(report.summary.orderCount)}
        />
        <MetricCard
          icon={<CalendarDays size={18} />}
          label="Средняя сумма"
          value={formatMoney(report.summary.avgCheck)}
        />
        <MetricCard
          icon={<Store size={18} />}
          label="Товаров в отчете"
          value={formatDecimal(report.summary.avgItemsPerCheck, 2)}
        />
      </section>

      <div className="reports-grid">
        <section className="panel report-chart-panel">
          <div className="panel-title">
            <h3>Выручка по периодам</h3>
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
                      name === "revenue" ? "Выручка" : "Отчеты"
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
            <h3>Основа отчета</h3>
          </div>
          <div className="stack-list">
            <div className="summary-row">
              <strong>Отчетов розницы</strong>
              <span>{formatNumber(report.summary.reportCount)}</span>
            </div>
            <div className="summary-row">
              <strong>Периодов на графике</strong>
              <span>{formatNumber(report.revenueSeries.length)}</span>
            </div>
            <div className="summary-row">
              <strong>Магазинов в heatmap</strong>
              <span>{formatNumber(report.heatmap.stores.length)}</span>
            </div>
            <div className="summary-row">
              <strong>Дней в heatmap</strong>
              <span>{formatNumber(report.heatmap.days.length)}</span>
            </div>
          </div>
        </section>
      </div>

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
          <h3>Тепловая карта отчетов розницы</h3>
          <span>источник: document_otchet_o_roznichnyh_prodazhah, строка = магазин, колонка = час</span>
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
          <h3>Тепловая карта суммы продаж</h3>
          <span>источник: document_otchet_o_roznichnyh_prodazhah, строка = магазин, колонка = час</span>
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
                      : `${store.name}, ${weekdayLabel}, ${hour}:00 · ${formatNumber(cell?.orderCount ?? 0)} отчетов · ${formatMoney(cell?.revenue ?? 0)}`
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

  return (
    <>
      <section className="metric-grid report-metric-grid" aria-label="Метрики дохода">
        <MetricCard
          icon={<Receipt size={18} />}
          label="Выручка за выбранный период"
          value={formatMoney(report.summary.revenue)}
        />
        <MetricCard
          icon={<ShoppingCart size={18} />}
          label="Себестоимость"
          value={formatMoney(report.summary.cost)}
        />
        <MetricCard
          icon={<TrendingUp size={18} />}
          label="Валовая прибыль"
          value={formatMoney(report.summary.grossProfit)}
        />
        <MetricCard
          icon={<BarChart3 size={18} />}
          label="Маржинальность"
          value={`${formatDecimal(report.summary.marginPct, 1)}%`}
        />
      </section>

      <div className="reports-grid">
        <section className="panel report-chart-panel">
          <div className="panel-title">
            <h3>Валовая прибыль по периодам</h3>
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
                  <th className="num">Выручка</th>
                  <th className="num">Себест-ть</th>
                  <th className="num">Прибыль</th>
                  <th className="num">Маржа</th>
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
                  <th className="num">Продано</th>
                  <th className="num">Выручка</th>
                  <th className="num">Себест-ть</th>
                  <th className="num">Прибыль</th>
                  <th className="num">Маржа</th>
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
                    <th className="num">Продано</th>
                    <th className="num">Выручка</th>
                    <th className="num">Себест-ть</th>
                    <th className="num">Прибыль</th>
                    <th className="num">Маржа</th>
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
          label="Выручка по акциям"
          value={formatMoney(summary.promoRevenue)}
          detail={`${formatDecimal(summary.promoSharePct, 2)}% выручки периода`}
        />
        <MetricCard
          icon={<BarChart3 size={18} />}
          label="Скидки по акциям"
          value={formatMoney(summary.promoDiscountAmount)}
          detail={`средняя скидка ${formatDecimal(summary.avgDiscountPct, 2)}%`}
        />
        <MetricCard
          icon={<Package size={18} />}
          label="Продано единиц по акциям"
          value={formatDecimal(summary.promoQuantity, 0)}
          detail={`${formatNumber(summary.promoItemCount)} товаров · ${formatNumber(summary.promoLineCount)} строк`}
        />
        <MetricCard
          icon={<Receipt size={18} />}
          label="Отчетов с акциями"
          value={formatNumber(summary.promoReportCount)}
          detail={`из ${formatNumber(summary.totalReports)} отчетов периода`}
        />
        <MetricCard
          icon={<TrendingUp size={18} />}
          label="Выручка на 1 ₸ скидки"
          value={formatDecimal(summary.revenuePerDiscount, 2)}
          detail={`средний отчет ${formatMoney(summary.avgCheck)}`}
        />
        <MetricCard
          icon={<Store size={18} />}
          label="Магазинов в акциях"
          value={formatNumber(summary.promoStoreCount)}
          detail={`акций в периоде: ${formatNumber(summary.promotionCount)} · с продажами: ${formatNumber(summary.promotionWithSalesCount)}`}
        />
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <h3>Продажи по акциям</h3>
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
                    <button type="button" className="sort-button" onClick={() => toggleSort("discountPctMax")}>
                      Скидка{sortIndicator("discountPctMax")}
                    </button>
                  </th>
                  <th className="num">
                    <button type="button" className="sort-button" onClick={() => toggleSort("storeCount")}>
                      Магазинов{sortIndicator("storeCount")}
                    </button>
                  </th>
                  <th className="num">
                    <button type="button" className="sort-button" onClick={() => toggleSort("itemCount")}>
                      Товаров{sortIndicator("itemCount")}
                    </button>
                  </th>
                  <th className="num">
                    <button type="button" className="sort-button" onClick={() => toggleSort("reportCount")}>
                      Отчетов{sortIndicator("reportCount")}
                    </button>
                  </th>
                  <th className="num">
                    <button type="button" className="sort-button" onClick={() => toggleSort("quantity")}>
                      Кол-во{sortIndicator("quantity")}
                    </button>
                  </th>
                  <th className="num">
                    <button type="button" className="sort-button" onClick={() => toggleSort("revenue")}>
                      Выручка{sortIndicator("revenue")}
                    </button>
                  </th>
                  <th className="num">
                    <button type="button" className="sort-button" onClick={() => toggleSort("discountAmount")}>
                      Скидка ₸{sortIndicator("discountAmount")}
                    </button>
                  </th>
                  <th className="num">
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => toggleSort("revenuePerDiscount")}
                    >
                      ₸ на 1 ₸ скидки{sortIndicator("revenuePerDiscount")}
                    </button>
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
                                    <th className="num">Отчетов</th>
                                    <th className="num">Товаров</th>
                                    <th className="num">Кол-во</th>
                                    <th className="num">Выручка</th>
                                    <th className="num">Скидка ₸</th>
                                    <th className="num">Скидка</th>
                                    <th className="num">Средний отчет</th>
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
                                                      <th className="num">Отчетов</th>
                                                      <th className="num">Кол-во</th>
                                                      <th className="num">Цена</th>
                                                      <th className="num">Выручка</th>
                                                      <th className="num">Скидка ₸</th>
                                                      <th className="num">Скидка</th>
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
                  <th className="num">Отчетов</th>
                  <th className="num">Выручка</th>
                  <th className="num">Выручка по акциям</th>
                  <th className="num">Доля</th>
                  <th className="num">Скидка ₸</th>
                  <th className="num">Кол-во по акциям</th>
                  <th className="num">Товаров по акциям</th>
                  <th className="num">Акций</th>
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
                  <th className="num">Отчетов</th>
                  <th className="num">Кол-во</th>
                  <th className="num">Цена</th>
                  <th className="num">Выручка</th>
                  <th className="num">Скидка ₸</th>
                  <th className="num">Скидка</th>
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
                  <th key={col.key} className={col.num ? "num" : ""}>{col.label}</th>
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
    { key: "stockQty", label: "Остаток", num: true, render: (r) => formatDecimal(r.stockQty, 1) },
    { key: "reservedQty", label: "Резерв", num: true, render: (r) => formatDecimal(r.reservedQty, 1) },
    { key: "availableQty", label: "Доступно", num: true, render: (r) => formatDecimal(r.availableQty, 1) },
    { key: "warehouseCount", label: "Складов", num: true, render: (r) => formatNumber(r.warehouseCount) },
    { key: "dailySalesRate", label: "Продаж/день", num: true, render: (r) => formatDecimal(r.dailySalesRate, 2) },
    { key: "daysOfStock", label: "Дней запаса", num: true, render: (r) => r.daysOfStock !== null ? formatDecimal(r.daysOfStock, 0) : "—" },
    { key: "depletionDays", label: "Прогноз оконч.", num: true, render: (r) => r.depletionDays !== null ? formatDecimal(r.depletionDays, 0) : "—" },
    { key: "stockCost", label: "Себест-ть запаса", num: true, render: (r) => formatMoney(r.stockCost) },
    { key: "daysSinceLastSale", label: "Дней с посл. продажи", num: true, render: (r) => r.daysSinceLastSale !== null ? formatNumber(r.daysSinceLastSale) : "—" }
  ];

  const shortColumns: ColumnDef<InventoryReport["items"][0]>[] = [
    { key: "name", label: "Товар", render: (r) => r.name },
    { key: "stockQty", label: "Остаток", num: true, render: (r) => formatDecimal(r.stockQty, 1) },
    { key: "reservedQty", label: "Резерв", num: true, render: (r) => formatDecimal(r.reservedQty, 1) },
    { key: "availableQty", label: "Доступно", num: true, render: (r) => formatDecimal(r.availableQty, 1) },
    { key: "stockCost", label: "Себест-ть", num: true, render: (r) => formatMoney(r.stockCost) },
    { key: "daysOfStock", label: "Дней запаса", num: true, render: (r) => r.daysOfStock !== null ? formatDecimal(r.daysOfStock, 0) : "—" },
    { key: "daysSinceLastSale", label: "Дней без продаж", num: true, render: (r) => r.daysSinceLastSale !== null ? formatNumber(r.daysSinceLastSale) : "—" }
  ];

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Запасы</h2>
          <span>accumulation_register_tovary_na_skladah_balance · document_otchet_o_roznichnyh_prodazhah</span>
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
            <MetricCard icon={<Boxes size={18} />} label="Товаров с остатком" value={formatNumber(report.summary.itemsWithStock)} />
            <MetricCard icon={<ShoppingCart size={18} />} label="Сумма запаса (себест.)" value={formatMoney(report.summary.totalStockCost)} />
            <MetricCard icon={<BarChart3 size={18} />} label="Out of Stock" value={formatNumber(report.summary.outOfStockCount)} />
            <MetricCard icon={<TrendingUp size={18} />} label="Overstock" value={formatNumber(report.summary.overstockCount)} />
          </section>

          {renderSection("Остатки", "stock", report.items, stockColumns)}
          {renderSection("Out of Stock", "outOfStock", report.outOfStock, shortColumns)}
          {renderSection("Overstock", "overstock", report.overstock, shortColumns)}
          {renderSection("Медленно оборачиваемые товары", "slowMoving", report.slowMoving, shortColumns)}
          {renderSection("Неликвид", "dead", report.dead, shortColumns)}

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
                <strong>Общая себестоимость запаса</strong>
                <span>{formatMoney(report.summary.totalStockCost)}</span>
              </div>
              <div className="summary-row">
                <strong>Розничная стоимость запаса</strong>
                <span>{formatMoney(report.summary.totalStockRetail)}</span>
              </div>
              <div className="summary-row">
                <strong>Out of Stock</strong>
                <span>{formatNumber(report.summary.outOfStockCount)}</span>
              </div>
              <div className="summary-row">
                <strong>Overstock (&gt; 90 дн)</strong>
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
  no_sales: "Нет продаж",
  dead_stock: "Старая последняя продажа",
  slow_moving: "Редко продается",
  overstock: "Запас > 90 дн",
  old_stock: "Долго на складе"
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
  const byProfit = useMemo(() => [...items].sort((a, b) => b.marginPct - a.marginPct).slice(0, showAllProfit ? items.length : 15), [items, showAllProfit]);
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
          <span>catalog_nomenklatura · document_otchet_o_roznichnyh_prodazhah</span>
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
            <MetricCard icon={<Package size={18} />} label="Товаров" value={formatNumber(items.length)} />
            <MetricCard icon={<CalendarDays size={18} />} label="Дней в анализе" value={formatNumber(report.totalDays)} />
            <MetricCard icon={<TrendingUp size={18} />} label="ABC: A-класс" value={formatNumber(abcGroups.A.length)} />
            <MetricCard icon={<BarChart3 size={18} />} label="XYZ: X-класс" value={formatNumber(xyzGroups.X.length)} />
            <MetricCard icon={<Boxes size={18} />} label="Товары на выход" value={formatNumber(report.exitSummary.totalItems)} />
            <MetricCard icon={<Package size={18} />} label="Остаток на выход" value={formatDecimal(report.exitSummary.stockQty, 1)} />
            <MetricCard icon={<Clock size={18} />} label="Без продаж" value={formatNumber(report.exitSummary.noSalesCount + report.exitSummary.deadStockCount)} />
            <MetricCard icon={<TrendingUp size={18} />} label="Стоимость остатка" value={formatMoneyCompact(report.exitSummary.stockCost)} />
          </section>

          <ExpandableTable
            title="Товары на выход"
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
            <div className="panel-title"><h3>ABC-анализ</h3><span>по доле в выручке</span></div>
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
                          <th className="num">Выручка</th>
                          <th className="num">Доля</th>
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
            <div className="panel-title"><h3>XYZ-анализ</h3><span>по коэффициенту вариации спроса</span></div>
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
                          <th className="num">CV, %</th>
                          <th className="num">Продаж/день</th>
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
            <div className="panel-title"><h3>ABC+XYZ матрица</h3><span>количество товаров в каждой ячейке</span></div>
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
                          <th className="num">Выручка</th>
                          <th className="num">Продаж/день</th>
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
              { key: "marginPct", label: "Маржа", num: true, render: (r) => `${formatDecimal(r.marginPct, 1)}%` },
              { key: "revenue", label: "Выручка", num: true, render: (r) => formatMoney(r.revenue) },
              { key: "grossProfit", label: "Прибыль", num: true, render: (r) => formatMoney(r.grossProfit) },
              { key: "cost", label: "Себест-ть", num: true, render: (r) => formatMoney(r.cost) }
            ]}
          />

          {/* Lost Sales */}
          <ExpandableTable
            title="Lost Sales — потерянные продажи"
            subtitle="дни без продаж в периоде"
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
  { key: "revenue", label: "Выручка", num: true, render: (r: ItemAnalysis) => formatMoney(r.revenue) },
  { key: "grossProfit", label: "Прибыль", num: true, render: (r: ItemAnalysis) => formatMoney(r.grossProfit) },
  { key: "marginPct", label: "Маржа", num: true, render: (r: ItemAnalysis) => `${formatDecimal(r.marginPct, 1)}%` },
  { key: "abcClass", label: "ABC", num: true, render: (r: ItemAnalysis) => r.abcClass },
  { key: "xyzClass", label: "XYZ", num: true, render: (r: ItemAnalysis) => r.xyzClass }
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
  { key: "stockCost", label: "Себест-ть остатка", num: true, render: (r: ExitProduct) => formatMoney(r.stockCost) },
  { key: "lastSaleDate", label: "Последняя продажа", num: true, render: (r: ExitProduct) => formatDate(r.lastSaleDate) }
];

type ColumnDef<T> = {
  key: string;
  label: string;
  num?: boolean;
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
                  {col.label}
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
  label,
  value,
  detail
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small className="metric-detail">{detail}</small> : null}
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
          </dl>

          {latest.error_class || failedChunk ? (
            <p className="panel-note">
              {failedChunk
                ? `Порция ${failedChunk.start} → ${failedChunk.end_exclusive} завершилась с кодом ${failedChunk.exit_code}. `
                : ""}
              {latest.error_class ? `Причина: ${latest.error_class}. ` : ""}
              Подробности — в логе запуска на сервере экспорта, метрики — в файле
              {" "}
              <code>metrics/…</code>.
            </p>
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
