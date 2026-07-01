import {
  BarChart3,
  Boxes,
  CalendarDays,
  Clock,
  Database,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Package,
  Receipt,
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
  type IncomeReport,
  type InventoryReport,
  type ItemAnalysis,
  type MarketingReport,
  type NomenclatureReport,
  type Overview,
  type SalesPeriod,
  type SalesReport,
  type TableProfile,
  type TimeSeriesPoint,
  type User
} from "./api";
import {
  formatBytes,
  formatCell,
  formatCompact,
  formatDate,
  formatDecimal,
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
  const [email, setEmail] = useState("admin@naliv.local");
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
  const [currentPage, setCurrentPage] = useState<AppPage>("reports");
  const [overviewState, setOverviewState] = useState<LoadState<Overview>>({
    status: "loading"
  });
  const [selectedTable, setSelectedTable] = useState<string>("");
  const [search, setSearch] = useState("");

  useEffect(() => {
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
  }, []);

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
            <span>{overview?.schema ?? "raw_1c"}</span>
          </div>
        </div>

        <nav className="page-nav" aria-label="Разделы">
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
          <button
            className={currentPage === "marketing" ? "active" : ""}
            onClick={() => setCurrentPage("marketing")}
            type="button"
          >
            <Megaphone size={16} />
            <span>Маркетинг</span>
          </button>
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
          <>
            <SalesReports />
            <IncomeReports />
          </>
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

const periodOptions: Array<{ value: SalesPeriod; label: string }> = [
  { value: "day", label: "Дни" },
  { value: "week", label: "Недели" },
  { value: "month", label: "Месяцы" }
];

function SalesReports() {
  const [period, setPeriod] = useState<SalesPeriod>("day");
  const [reportState, setReportState] = useState<LoadState<SalesReport>>({
    status: "loading"
  });

  useEffect(() => {
    setReportState({ status: "loading" });
    api
      .salesReport(period)
      .then((report) => setReportState({ status: "success", data: report }))
      .catch((caught) =>
        setReportState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить отчеты"
        })
      );
  }, [period]);

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Отчеты по продажам</h2>
          <span>document_chek_kkm · document_otchet_o_roznichnyh_prodazhah</span>
        </div>
        <div className="segmented-control" aria-label="Группировка выручки">
          {periodOptions.map((option) => (
            <button
              key={option.value}
              className={option.value === period ? "active" : ""}
              onClick={() => setPeriod(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
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
  const [heatmapView, setHeatmapView] = useState<HeatmapView>("dates");

  return (
    <>
      <section className="metric-grid report-metric-grid" aria-label="Метрики продаж">
        <MetricCard
          icon={<Receipt size={18} />}
          label="Выручка"
          value={formatMoney(report.summary.revenue)}
        />
        <MetricCard
          icon={<ShoppingCart size={18} />}
          label="Количество чеков"
          value={formatNumber(report.summary.orderCount)}
        />
        <MetricCard
          icon={<CalendarDays size={18} />}
          label="Средний чек"
          value={formatMoney(report.summary.avgCheck)}
        />
        <MetricCard
          icon={<Store size={18} />}
          label="Товаров в чеке"
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

      <div className="heatmap-toolbar">
        <div>
          <strong>Представление heatmap</strong>
          <span>
            {heatmapView === "dates"
              ? "каждая строка показывает конкретную дату и магазин"
              : "данные свернуты по дням недели и магазинам"}
          </span>
        </div>
        <div className="segmented-control" aria-label="Представление heatmap">
          {heatmapViewOptions.map((option) => (
            <button
              key={option.value}
              className={option.value === heatmapView ? "active" : ""}
              onClick={() => setHeatmapView(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h3>Тепловая карта чеков</h3>
          <span>{heatmapView === "dates" ? "строка = день и магазин" : "строка = день недели и магазин"}, колонка = час</span>
        </div>
        <SalesHeatmap report={report} metric="checks" view={heatmapView} />
      </section>

      <section className="panel">
        <div className="panel-title">
          <h3>Тепловая карта суммы продаж</h3>
          <span>{heatmapView === "dates" ? "строка = день и магазин" : "строка = день недели и магазин"}, колонка = час</span>
        </div>
        <SalesHeatmap report={report} metric="revenue" view={heatmapView} />
      </section>
    </>
  );
}

type HeatmapMetric = "checks" | "revenue";
type HeatmapView = "dates" | "weekdays";

const heatmapViewOptions: Array<{ value: HeatmapView; label: string }> = [
  { value: "dates", label: "По датам" },
  { value: "weekdays", label: "По дням недели" }
];

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

function SalesHeatmap({
  report,
  metric,
  view
}: {
  report: SalesReport;
  metric: HeatmapMetric;
  view: HeatmapView;
}) {
  const aggregatedCells = useMemo(() => {
    const cells = new Map<string, { revenue: number; orderCount: number }>();

    for (const cell of report.heatmap.cells) {
      const groupKey =
        view === "weekdays" ? `weekday-${getIsoWeekday(cell.day)}` : cell.day;
      const key = `${groupKey}-${cell.storeKey}-${cell.hour}`;
      const current = cells.get(key) ?? { revenue: 0, orderCount: 0 };
      current.revenue += cell.revenue;
      current.orderCount += cell.orderCount;
      cells.set(key, current);
    }

    return cells;
  }, [report.heatmap.cells, view]);
  const heatmapRows = useMemo(
    () => {
      const groups =
        view === "weekdays"
          ? Array.from(new Set(report.heatmap.days.map(getIsoWeekday)))
              .filter((weekday) => weekday > 0)
              .sort((left, right) => left - right)
              .map((weekday) => ({
                key: `weekday-${weekday}`,
                label: weekdayLabels[weekday]
              }))
          : report.heatmap.days.map((day) => ({
              key: day,
              label: formatHeatmapDay(day)
            }));

      return groups.flatMap((group) =>
        report.heatmap.stores.map((store) => ({ group, store }))
      );
    },
    [report.heatmap.days, report.heatmap.stores, view]
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
        <div className="heatmap-label heatmap-head">День / магазин</div>
        {report.heatmap.hours.map((hour) => (
          <div key={hour} className="heatmap-hour heatmap-head">
            {hour}
          </div>
        ))}

        {heatmapRows.map(({ group, store }) => (
          <Fragment key={`${group.key}-${store.key}`}>
            <div
              className="heatmap-label stacked"
              title={`${group.label} · ${store.name}`}
            >
              <Store size={14} />
              <div>
                <b>{group.label}</b>
                <span>{store.name}</span>
              </div>
            </div>
            {report.heatmap.hours.map((hour) => {
              const cell = aggregatedCells.get(`${group.key}-${store.key}-${hour}`);
              const metricValue =
                metric === "revenue" ? (cell?.revenue ?? 0) : (cell?.orderCount ?? 0);
              const intensity = maxMetricValue > 0 ? metricValue / maxMetricValue : 0;

              return (
                <div
                  key={`${group.key}-${store.key}-${hour}`}
                  className={metric === "revenue" ? "heatmap-cell money" : "heatmap-cell"}
                  title={
                    metric === "revenue"
                      ? `${group.label}, ${store.name}, ${hour}:00 · ${formatMoney(cell?.revenue ?? 0)}`
                      : `${group.label}, ${store.name}, ${hour}:00 · ${formatNumber(cell?.orderCount ?? 0)} чеков · ${formatMoney(cell?.revenue ?? 0)}`
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
            ? "Цвет и значение показывают сумму продаж в конкретный день и час по магазину."
            : "Цвет и значение показывают количество чеков в конкретный день и час по магазину."}
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

function IncomeReports() {
  const [period, setPeriod] = useState<SalesPeriod>("day");
  const [reportState, setReportState] = useState<LoadState<IncomeReport>>({
    status: "loading"
  });

  useEffect(() => {
    setReportState({ status: "loading" });
    api
      .incomeReport(period)
      .then((report) => setReportState({ status: "success", data: report }))
      .catch((caught) =>
        setReportState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить отчет о доходе"
        })
      );
  }, [period]);

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Доход</h2>
          <span>document_otchet_o_roznichnyh_prodazhah · document_postuplenie_tovarov</span>
        </div>
        <div className="segmented-control" aria-label="Группировка дохода">
          {periodOptions.map((option) => (
            <button
              key={option.value}
              className={option.value === period ? "active" : ""}
              onClick={() => setPeriod(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
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
          label="Выручка"
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
  const [state, setState] = useState<LoadState<MarketingReport>>({ status: "loading" });

  useEffect(() => {
    setState({ status: "loading" });
    api
      .marketingReport(period)
      .then((report) => setState({ status: "success", data: report }))
      .catch((caught) =>
        setState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить маркетинговый отчет"
        })
      );
  }, [period]);

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Маркетинг</h2>
          <span>document_chek_kkm · document_chek_kkm_skidki_natsenki</span>
        </div>
        <div className="segmented-control" aria-label="Группировка">
          {periodOptions.map((option) => (
            <button
              key={option.value}
              className={option.value === period ? "active" : ""}
              onClick={() => setPeriod(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {state.status === "loading" ? <div className="empty-state">Загружаем маркетинговый отчет</div> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}

      {state.status === "success" ? (
        <MarketingReportBody report={state.data} />
      ) : null}
    </section>
  );
}

function MarketingReportBody({ report }: { report: MarketingReport }) {
  const [showAllPromos, setShowAllPromos] = useState(false);
  const [showAllStores, setShowAllStores] = useState(false);
  const visiblePromos = showAllPromos ? report.promos : report.promos.slice(0, 10);
  const visibleStores = showAllStores ? report.stores : report.stores.slice(0, 10);

  const storePromoGroups = useMemo(() => {
    const map = new Map<string, typeof report.storePromos>();
    for (const sp of report.storePromos) {
      const group = map.get(sp.storeKey);
      if (group) {
        group.push(sp);
      } else {
        map.set(sp.storeKey, [sp]);
      }
    }
    const storeRevenue = new Map(report.stores.map((s) => [s.key, s.totalRevenue]));
    return [...map.entries()].sort(
      (a, b) => (storeRevenue.get(b[0]) ?? 0) - (storeRevenue.get(a[0]) ?? 0)
    );
  }, [report.storePromos, report.stores]);

  return (
    <>
      <section className="metric-grid report-metric-grid" aria-label="Метрики маркетинга">
        <MetricCard
          icon={<Receipt size={18} />}
          label="Общая выручка"
          value={formatMoney(report.summary.totalRevenue)}
        />
        <MetricCard
          icon={<ShoppingCart size={18} />}
          label="Чеков всего"
          value={formatNumber(report.summary.totalChecks)}
        />
        <MetricCard
          icon={<Megaphone size={18} />}
          label="Сумма скидок"
          value={formatMoney(report.summary.totalDiscountAmount)}
        />
        <MetricCard
          icon={<BarChart3 size={18} />}
          label="Средняя скидка"
          value={`${formatDecimal(report.summary.avgDiscountPct, 1)}%`}
        />
      </section>

      <div className="reports-grid">
        <section className="panel">
          <div className="panel-title">
            <h3>Продажи без скидок</h3>
          </div>
          <div className="stack-list">
            <div className="summary-row">
              <strong>Чеков</strong>
              <span>{formatNumber(report.salesWithoutDiscounts.checkCount)}</span>
            </div>
            <div className="summary-row">
              <strong>Выручка</strong>
              <span>{formatMoney(report.salesWithoutDiscounts.revenue)}</span>
            </div>
            <div className="summary-row">
              <strong>Средний чек</strong>
              <span>{formatMoney(report.salesWithoutDiscounts.avgCheck)}</span>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>Продажи со скидками</h3>
          </div>
          <div className="stack-list">
            <div className="summary-row">
              <strong>Чеков</strong>
              <span>{formatNumber(report.salesWithDiscounts.checkCount)}</span>
            </div>
            <div className="summary-row">
              <strong>Выручка</strong>
              <span>{formatMoney(report.salesWithDiscounts.revenue)}</span>
            </div>
            <div className="summary-row">
              <strong>Сумма скидок</strong>
              <span>{formatMoney(report.salesWithDiscounts.discountAmount)}</span>
            </div>
            <div className="summary-row">
              <strong>Средний чек</strong>
              <span>{formatMoney(report.salesWithDiscounts.avgCheck)}</span>
            </div>
          </div>
        </section>
      </div>

      {/* Продажи по акциям — сводно */}
      <section className="panel">
        <div className="panel-title">
          <div>
            <h3>Продажи по акциям — сводно</h3>
            <span>{formatNumber(report.promos.length)} акций</span>
          </div>
          {report.promos.length > 10 ? (
            <button
              onClick={() => setShowAllPromos((v) => !v)}
              type="button"
              style={{ border: "1px solid #e4e7ec", borderRadius: "6px", padding: "4px 12px", cursor: "pointer", background: "#fff", fontSize: "13px" }}
            >
              {showAllPromos ? "Свернуть" : `Показать все (${formatNumber(report.promos.length)})`}
            </button>
          ) : null}
        </div>
        {visiblePromos.length > 0 ? (
          <div className="heatmap-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Акция</th>
                  <th className="num">Чеков</th>
                  <th className="num">Выручка</th>
                  <th className="num">Скидка</th>
                  <th className="num">Средняя скидка</th>
                  <th className="num">ROI</th>
                </tr>
              </thead>
              <tbody>
                {visiblePromos.map((promo) => {
                  const roi =
                    promo.discountAmount > 0
                      ? ((promo.revenue - promo.discountAmount) / promo.discountAmount)
                      : 0;
                  return (
                    <tr key={promo.key}>
                      <td>{promo.name}</td>
                      <td className="num">{formatNumber(promo.checkCount)}</td>
                      <td className="num">{formatMoney(promo.revenue)}</td>
                      <td className="num">{formatMoney(promo.discountAmount)}</td>
                      <td className="num">{formatDecimal(promo.avgDiscountPct, 1)}%</td>
                      <td className="num">{formatDecimal(roi, 1)}x</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state inset">Нет данных по акциям</div>
        )}
      </section>

      {/* Скидки по магазинам */}
      <section className="panel">
        <div className="panel-title">
          <div>
            <h3>Скидки по магазинам</h3>
            <span>{formatNumber(report.stores.length)} магазинов</span>
          </div>
          {report.stores.length > 10 ? (
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
                  <th className="num">Чеков всего</th>
                  <th className="num">Со скидкой</th>
                  <th className="num">Выручка</th>
                  <th className="num">Скидка</th>
                  <th className="num">Средняя скидка</th>
                </tr>
              </thead>
              <tbody>
                {visibleStores.map((store) => (
                  <tr key={store.key}>
                    <td>{store.name}</td>
                    <td className="num">{formatNumber(store.totalChecks)}</td>
                    <td className="num">{formatNumber(store.discountChecks)}</td>
                    <td className="num">{formatMoney(store.totalRevenue)}</td>
                    <td className="num">{formatMoney(store.discountAmount)}</td>
                    <td className="num">{formatDecimal(store.avgDiscountPct, 1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state inset">Нет данных по магазинам</div>
        )}
      </section>

      {/* Акции по магазинам */}
      {storePromoGroups.map(([storeKey, spItems]) => {
        const storeName = spItems[0]?.storeName ?? storeKey;
        return (
          <section key={storeKey} className="panel">
            <div className="panel-title">
              <div>
                <h3>Акции — {storeName}</h3>
                <span>{formatNumber(spItems.length)} акций</span>
              </div>
            </div>
            <div className="heatmap-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Акция</th>
                    <th className="num">Чеков</th>
                    <th className="num">Выручка</th>
                    <th className="num">Скидка</th>
                    <th className="num">Средняя скидка</th>
                    <th className="num">ROI</th>
                  </tr>
                </thead>
                <tbody>
                  {spItems.map((sp) => {
                    const roi =
                      sp.discountAmount > 0
                        ? ((sp.revenue - sp.discountAmount) / sp.discountAmount)
                        : 0;
                    return (
                      <tr key={sp.promoKey}>
                        <td>{sp.promoName}</td>
                        <td className="num">{formatNumber(sp.checkCount)}</td>
                        <td className="num">{formatMoney(sp.revenue)}</td>
                        <td className="num">{formatMoney(sp.discountAmount)}</td>
                        <td className="num">{formatDecimal(sp.avgDiscountPct, 1)}%</td>
                        <td className="num">{formatDecimal(roi, 1)}x</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {/* ROI summary */}
      <section className="panel">
        <div className="panel-title">
          <h3>Эффективность и ROI акций</h3>
        </div>
        <div className="stack-list">
          <div className="summary-row">
            <strong>Доля чеков со скидкой</strong>
            <span>
              {report.summary.totalChecks > 0
                ? `${formatDecimal(
                    (report.summary.discountCheckCount / report.summary.totalChecks) * 100,
                    1
                  )}%`
                : "—"}
            </span>
          </div>
          <div className="summary-row">
            <strong>Доля выручки со скидкой</strong>
            <span>
              {report.summary.totalRevenue > 0
                ? `${formatDecimal(
                    (report.summary.revenueWithDiscounts / report.summary.totalRevenue) * 100,
                    1
                  )}%`
                : "—"}
            </span>
          </div>
          <div className="summary-row">
            <strong>Общий ROI скидок</strong>
            <span>
              {report.summary.totalDiscountAmount > 0
                ? `${formatDecimal(
                    (report.summary.revenueWithDiscounts - report.summary.totalDiscountAmount) /
                      report.summary.totalDiscountAmount,
                    1
                  )}x`
                : "—"}
            </span>
          </div>
          <div className="summary-row">
            <strong>Средняя скидка по всем чекам</strong>
            <span>{formatDecimal(report.summary.avgDiscountPct, 1)}%</span>
          </div>
        </div>
      </section>
    </>
  );
}

function InventoryReports() {
  const [period, setPeriod] = useState<SalesPeriod>("day");
  const [state, setState] = useState<LoadState<InventoryReport>>({ status: "loading" });
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setState({ status: "loading" });
    api
      .inventoryReport(period)
      .then((report) => {
        setState({ status: "success", data: report });
        setExpandedSections({});
      })
      .catch((caught) =>
        setState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить отчет по запасам"
        })
      );
  }, [period]);

  if (state.status === "loading") return <div className="empty-state">Загружаем отчет по запасам</div>;
  if (state.status === "error") return <div className="empty-state">{state.error}</div>;
  if (!state.data) return <div className="empty-state">Нет данных по запасам</div>;

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
    { key: "dailySalesRate", label: "Продаж/день", num: true, render: (r) => formatDecimal(r.dailySalesRate, 2) },
    { key: "daysOfStock", label: "Дней запаса", num: true, render: (r) => r.daysOfStock !== null ? formatDecimal(r.daysOfStock, 0) : "—" },
    { key: "depletionDays", label: "Прогноз оконч.", num: true, render: (r) => r.depletionDays !== null ? formatDecimal(r.depletionDays, 0) : "—" },
    { key: "stockCost", label: "Себест-ть запаса", num: true, render: (r) => formatMoney(r.stockCost) },
    { key: "daysSinceLastSale", label: "Дней с посл. продажи", num: true, render: (r) => r.daysSinceLastSale !== null ? formatNumber(r.daysSinceLastSale) : "—" }
  ];

  const shortColumns: ColumnDef<InventoryReport["items"][0]>[] = [
    { key: "name", label: "Товар", render: (r) => r.name },
    { key: "stockQty", label: "Остаток", num: true, render: (r) => formatDecimal(r.stockQty, 1) },
    { key: "stockCost", label: "Себест-ть", num: true, render: (r) => formatMoney(r.stockCost) },
    { key: "daysOfStock", label: "Дней запаса", num: true, render: (r) => r.daysOfStock !== null ? formatDecimal(r.daysOfStock, 0) : "—" },
    { key: "daysSinceLastSale", label: "Дней без продаж", num: true, render: (r) => r.daysSinceLastSale !== null ? formatNumber(r.daysSinceLastSale) : "—" }
  ];

  return (
    <section className="reports-section">
      <div className="section-heading row">
        <div>
          <h2>Запасы</h2>
          <span>document_postuplenie_tovarov · document_otchet_o_roznichnyh_prodazhah</span>
        </div>
        <div className="segmented-control" aria-label="Группировка">
          {periodOptions.map((option) => (
            <button
              key={option.value}
              className={option.value === period ? "active" : ""}
              onClick={() => setPeriod(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <section className="metric-grid report-metric-grid" aria-label="Метрики запасов">
        <MetricCard icon={<Boxes size={18} />} label="Товаров с остатком" value={formatNumber(report.summary.itemsWithStock)} />
        <MetricCard icon={<ShoppingCart size={18} />} label="Сумма запаса (себест.)" value={formatMoney(report.summary.totalStockCost)} />
        <MetricCard icon={<BarChart3 size={18} />} label="Out of Stock" value={formatNumber(report.summary.outOfStockCount)} />
        <MetricCard icon={<TrendingUp size={18} />} label="Overstock" value={formatNumber(report.summary.overstockCount)} />
      </section>

      {/* Остатки — основная таблица */}
      {renderSection("Остатки", "stock", report.items, stockColumns)}

      {/* Out of Stock */}
      {renderSection("Out of Stock", "outOfStock", report.outOfStock, shortColumns)}

      {/* Overstock */}
      {renderSection("Overstock", "overstock", report.overstock, shortColumns)}

      {/* Медленно оборачиваемые */}
      {renderSection("Медленно оборачиваемые товары", "slowMoving", report.slowMoving, shortColumns)}

      {/* Неликвид */}
      {renderSection("Неликвид", "dead", report.dead, shortColumns)}

      {/* Summary stats */}
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

function NomenclatureReports() {
  const [period, setPeriod] = useState<SalesPeriod>("day");
  const [state, setState] = useState<LoadState<NomenclatureReport>>({ status: "loading" });
  const [showAllTop, setShowAllTop] = useState(false);
  const [showAllAnti, setShowAllAnti] = useState(false);
  const [showAllVelocity, setShowAllVelocity] = useState(false);
  const [showAllProfit, setShowAllProfit] = useState(false);
  const [showAllLost, setShowAllLost] = useState(false);

  useEffect(() => {
    setState({ status: "loading" });
    api
      .nomenclatureReport(period)
      .then((report) => setState({ status: "success", data: report }))
      .catch((caught) =>
        setState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить анализ номенклатуры"
        })
      );
  }, [period]);

  const report = state.data;
  const items = report?.items ?? [];

  const topSellers = useMemo(() => items.slice(0, showAllTop ? items.length : 15), [items, showAllTop]);
  const antiLeaders = useMemo(() => [...items].sort((a, b) => a.revenue - b.revenue).slice(0, showAllAnti ? items.length : 15), [items, showAllAnti]);
  const byVelocity = useMemo(() => [...items].sort((a, b) => b.salesVelocity - a.salesVelocity).slice(0, showAllVelocity ? items.length : 15), [items, showAllVelocity]);
  const byProfit = useMemo(() => [...items].sort((a, b) => b.marginPct - a.marginPct).slice(0, showAllProfit ? items.length : 15), [items, showAllProfit]);
  const lostSales = useMemo(() => [...items].filter((i) => i.daysWithoutSales > 0).sort((a, b) => b.daysWithoutSales - a.daysWithoutSales).slice(0, showAllLost ? items.length : 15), [items, showAllLost]);

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
        <div className="segmented-control" aria-label="Группировка">
          {periodOptions.map((option) => (
            <button
              key={option.value}
              className={option.value === period ? "active" : ""}
              onClick={() => setPeriod(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
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
          </section>

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
  value
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="metric-card">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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
