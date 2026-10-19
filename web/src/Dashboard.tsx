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
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { api } from "./api";
import type {
  AcquiringMetrics,
  CashArticleMetrics,
  DataGroup,
  ExitProduct,
  ExitProductReason,
  IncomeReport,
  InventoryReport,
  ItemAnalysis,
  LossMetrics,
  LostSalesMetrics,
  MarketingPromotion,
  MarketingReport,
  ManagementSettings,
  MoneyPositionMetrics,
  NomenclatureReport,
  Overview,
  PurchasingRecommendations,
  ReportDateRange,
  SalesPeriod,
  SalesReport,
  SourceHealth,
  StorePerformanceMetrics,
  StoreStockMetrics,
  SupplierTermsMetrics,
  SyncHealth,
  SyncRun,
  SyncSchedulerStatus,
  SyncTableFreshness,
  TableProfile,
  TimeSeriesPoint,
  User
} from "./api";
import { MetricLabel } from "./MetricHint";
import { metricDefinitions, type MetricId, type MetricStatus } from "./metric-definitions";
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
import { YearComparisonExport } from "./YearComparisonExport";
import { TurnoverReport } from "./TurnoverReport";

type LoadState<T> =
  | { status: "idle"; data?: undefined; error?: undefined }
  | { status: "loading"; data?: T; error?: undefined }
  | { status: "success"; data: T; error?: undefined }
  | { status: "error"; data?: T; error: string };

type AppPage = "home" | "sales" | "stores" | "stock" | "finance" | "marketing" | "admin";
type WorkspaceLocation = { page: AppPage; view: string };
type WorkspaceView = { key: string; label: string };

const pageMeta: Record<AppPage, { label: string; title: string; description: string }> = {
  home: { label: "Обзор", title: "Результаты сети", description: "Основные показатели за период и направления для проверки." },
  sales: { label: "Продажи", title: "Продажи", description: "Выручка, покупательская активность и сравнение с прошлым годом." },
  stores: { label: "Магазины", title: "Магазины", description: "Сравните результаты точек и найдите потери, требующие внимания." },
  stock: { label: "Товары", title: "Товары и запасы", description: "Проверьте остатки, потребность в закупке и ассортимент." },
  finance: { label: "Финансы", title: "Финансы", description: "Деньги, доходность продаж и плановые платежи — отдельно, без смешения показателей." },
  marketing: { label: "Маркетинг", title: "Результаты акций", description: "Сравните продажи, скидки, магазины и товары в акциях." },
  admin: { label: "Настройки", title: "Настройки", description: "Параметры расчетов и обновление данных. Диагностика открывается отдельно." }
};

const workspaceViews: Record<AppPage, readonly WorkspaceView[]> = {
  home: [{ key: "summary", label: "Сводка" }, { key: "rules", label: "Правила контроля" }],
  sales: [{ key: "summary", label: "Динамика" }, { key: "products", label: "Товары" }, { key: "activity", label: "Время покупок" }, { key: "comparison", label: "Сравнение годов" }],
  stores: [{ key: "performance", label: "Результаты магазинов" }, { key: "losses", label: "Списания и недостачи" }, { key: "lost-sales", label: "Упущенные продажи" }, { key: "productivity", label: "Дополнительные показатели" }],
  stock: [{ key: "inventory", label: "Остатки" }, { key: "turnover", label: "Оборачиваемость" }, { key: "purchasing", label: "К закупке" }, { key: "assortment", label: "Ассортимент" }, { key: "store-stock", label: "По магазинам" }],
  finance: [{ key: "money", label: "Деньги" }, { key: "cash", label: "Кассовые операции" }, { key: "cards", label: "Оплата картой" }, { key: "profit", label: "Доходность" }, { key: "payments", label: "Плановые платежи" }, { key: "suppliers", label: "Поставщики" }, { key: "projects", label: "Развитие" }],
  marketing: [{ key: "summary", label: "Сводка" }, { key: "promotions", label: "Акции" }, { key: "stores", label: "Магазины" }, { key: "items", label: "Товары" }],
  admin: [{ key: "settings", label: "Параметры расчетов" }, { key: "sync", label: "Обновление данных" }, { key: "diagnostics", label: "Диагностика" }]
};

const dateIndependentViews: Record<string, true> = {
  "home:rules": true, "stores:productivity": true,
  "finance:payments": true, "finance:projects": true,
  "admin:settings": true, "admin:sync": true
};

const unavailableHandbookMetrics: Record<string, readonly MetricId[]> = {
  "Деньги и полный денежный поток (§§3–5)": [
    "money.bank", "money.acquiring-transit", "money.obligations-30", "money.reserve",
    "money.free", "money.payment-coverage", "money.calendar-gap", "cash.profit-quality"
  ],
  "Полный результат точки и P&L (§§6–7)": [
    "store.revenue-m2", "store.payroll-share", "store.rent-share", "store.profit-shift",
    "store.contribution", "store.contribution-margin", "pnl.breakeven-revenue",
    "pnl.safety-margin", "pnl.store-status", "pnl.loss-months", "pnl.net-profit"
  ],
  "Долг, развитие и выплаты (§8)": [
    "pnl.ebitda-12m", "debt.balance", "debt.leverage", "reinvest.fcf-6m",
    "reinvest.limit", "reinvest.opening-cost", "reinvest.payback", "reinvest.openings",
    "reinvest.owner-payout"
  ]
};

function readWorkspaceLocation(): WorkspaceLocation {
  const [pageKey, viewKey] = window.location.hash.slice(1).split("/");
  const page: AppPage = Object.hasOwn(pageMeta, pageKey) ? pageKey as AppPage : "home";
  const view = workspaceViews[page].find((candidate) => candidate.key === viewKey)?.key ?? workspaceViews[page][0].key;
  return { page, view };
}

function WorkspaceNavigation({ views, selected, onSelect, label, className = "workspace-tabs" }: {
  views: readonly WorkspaceView[];
  selected: string;
  onSelect: (view: string) => void;
  label: string;
  className?: string;
}) {
  return <nav className={className} aria-label={label}>
    {views.map((view) => <button key={view.key} type="button" aria-current={selected === view.key ? "page" : undefined} onClick={() => onSelect(view.key)}>{view.label}</button>)}
  </nav>;
}


export default function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [location, setLocation] = useState<WorkspaceLocation>(readWorkspaceLocation);
  const [selectedViews, setSelectedViews] = useState<Record<AppPage, string>>(() => ({
    home: "summary", sales: "summary", stores: "performance", stock: "inventory",
    finance: "money", marketing: "summary", admin: "settings", [location.page]: location.view
  }));
  const [dateRange, setDateRange] = useState<DateRangeValue>(currentMonthRange);
  const [overviewState, setOverviewState] = useState<LoadState<Overview>>({ status: "idle" });
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const currentPage: AppPage = user.role === "marketing" ? "marketing" : location.page;
  const currentView = currentPage === location.page ? location.view : selectedViews[currentPage];
  const showPeriod = !dateIndependentViews[`${currentPage}:${currentView}`] && !(currentPage === "stock" && currentView === "turnover");
  const overview = overviewState.data;
  const filteredTables = useMemo(() => {
    const tables = overview?.tables ?? [];
    const term = search.trim().toLowerCase();
    return term ? tables.filter((table) => table.name.toLowerCase().includes(term)) : tables;
  }, [overview?.tables, search]);

  const navigate = (page: AppPage, view = selectedViews[page]) => {
    if (user.role === "marketing" && page !== "marketing") return;
    setLocation({ page, view });
    setSelectedViews((previous) => ({ ...previous, [page]: view }));
    const hash = `#${page}/${view}`;
    if (window.location.hash !== hash) window.location.hash = hash;
  };

  useEffect(() => {
    const restoreLocation = () => {
      const next = readWorkspaceLocation();
      if (user.role === "marketing" && next.page !== "marketing") return;
      setLocation(next);
      setSelectedViews((previous) => ({ ...previous, [next.page]: next.view }));
    };
    window.addEventListener("hashchange", restoreLocation);
    return () => window.removeEventListener("hashchange", restoreLocation);
  }, [user.role]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
    pageHeading.current?.focus({ preventScroll: true });
  }, [currentPage, currentView]);

  useEffect(() => {
    if (user.role !== "admin" || currentPage !== "admin" || currentView !== "diagnostics") return;
    const controller = new AbortController();
    setOverviewState((previous) => ({ status: "loading", data: previous.data }));
    api.overview(controller.signal).then((data) => {
      if (!controller.signal.aborted) setOverviewState({ status: "success", data });
    }).catch((caught) => {
      if (!controller.signal.aborted) setOverviewState((previous) => ({
        status: "error", data: previous.data,
        error: caught instanceof Error ? caught.message : "Не удалось загрузить диагностику"
      }));
    });
    return () => controller.abort();
  }, [currentPage, currentView, user.role]);

  async function logout() {
    await api.logout().catch(() => undefined);
    onLogout();
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark small"><BarChart3 size={20} /></div>
          <div><strong>Naliv</strong><span>Аналитика сети</span></div>
        </div>
        <nav className="page-nav" aria-label="Основные разделы">
          {user.role === "admin" ? <>
            <NavButton page="home" currentPage={currentPage} icon={<LayoutDashboard size={18} />} onSelect={navigate} />
            <NavButton page="sales" currentPage={currentPage} icon={<Receipt size={18} />} onSelect={navigate} />
            <NavButton page="stores" currentPage={currentPage} icon={<Store size={18} />} onSelect={navigate} />
            <NavButton page="stock" currentPage={currentPage} icon={<Boxes size={18} />} onSelect={navigate} />
            <NavButton page="finance" currentPage={currentPage} icon={<ArrowLeftRight size={18} />} onSelect={navigate} />
          </> : null}
          <NavButton page="marketing" currentPage={currentPage} icon={<Megaphone size={18} />} onSelect={navigate} />
        </nav>
        {user.role === "admin" ? <div className="sidebar-footer">
          <NavButton page="admin" currentPage={currentPage} icon={<ShieldCheck size={18} />} onSelect={navigate} />
        </div> : null}
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1 ref={pageHeading} tabIndex={-1}>{pageMeta[currentPage].title}</h1>
            <p className="page-description">{pageMeta[currentPage].description}</p>
          </div>
          <details className="account-menu">
            <summary><ShieldCheck size={16} /><span>Профиль</span><ChevronDown size={15} /></summary>
            <div className="account-menu-panel">
              <strong>{user.role === "admin" ? "Администратор" : "Маркетолог"}</strong>
              <span>{user.email}</span>
              <button type="button" onClick={logout}><LogOut size={16} />Выйти</button>
            </div>
          </details>
        </header>
        <WorkspaceNavigation views={workspaceViews[currentPage]} selected={currentView} onSelect={(view) => navigate(currentPage, view)} label={`Анализы: ${pageMeta[currentPage].label}`} />
        {showPeriod ? <div className="workspace-filter">
          <ReportFilterBar dateRange={dateRange} onDateRangeChange={setDateRange} />
        </div> : null}
        <HandbookDifferences />

        <div className="workspace-body">
          {currentPage === "home" ? (
            currentView === "rules" ? <DecisionCenter /> : <OwnerHome dateRange={dateRange} onNavigate={navigate} />
          ) : currentPage === "sales" ? (
            <SalesWorkspace dateRange={dateRange} view={currentView} />
          ) : currentPage === "stores" ? (
            <StoresWorkspace dateRange={dateRange} view={currentView} />
          ) : currentPage === "stock" ? (
            <StockWorkspace dateRange={dateRange} onDateRangeChange={setDateRange} view={currentView} />
          ) : currentPage === "finance" ? (
            <FinanceWorkspace dateRange={dateRange} view={currentView} />
          ) : currentPage === "marketing" ? (
            <MarketingReports dateRange={dateRange} view={currentView} />
          ) : currentView === "settings" ? <ManagementSettingsPanel /> : currentView === "sync" ? <SyncPanel /> : (
            <>
              <p className="context-note">Служебная диагностика для администратора. Эти сведения не входят в бизнес-отчеты.</p>
              <ManagementDashboard dateRange={dateRange} panel="sources" />
              {overviewState.status === "loading" ? <FullScreenState title="Загружаем диагностику" compact /> : null}
              {overviewState.status === "error" ? <div className="empty-state" role="alert">{overviewState.error}</div> : null}
              {overview ? <>
                <section className="metric-grid" aria-label="Диагностика хранилища">
                  <MetricCard icon={<Database size={18} />} metricId="admin.tables" label="Таблиц" value={formatNumber(overview.tableCount)} />
                  <MetricCard icon={<BarChart3 size={18} />} metricId="admin.rows" label="Строк, оценка" value={formatCompact(overview.estimatedRows)} />
                  <MetricCard icon={<Table2 size={18} />} metricId="admin.columns" label="Колонок" value={formatNumber(overview.columnCount)} />
                  <MetricCard icon={<Database size={18} />} metricId="admin.size" label="Размер" value={formatBytes(overview.totalBytes)} />
                </section>
                <DataCatalogOverview overview={overview} onSelectTable={setSelectedTable} />
                <details className="report-disclosure">
                  <summary>Выбрать таблицу для проверки</summary>
                  <div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти таблицу" aria-label="Найти таблицу" /></div>
                  <nav className="table-nav" aria-label="Диагностические таблицы">
                    {filteredTables.map((table) => <button type="button" key={table.name} className={selectedTable === table.name ? "active" : ""} onClick={() => setSelectedTable(table.name)}><Table2 size={15} /><span>{table.name}</span><small>{formatBytes(table.totalBytes)}</small></button>)}
                  </nav>
                </details>
                <details className="report-disclosure">
                  <summary>Объем хранения</summary>
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
                  <p className="context-note">Ось X — 12 крупнейших таблиц/представлений схемы raw_1c, отсортированных по занятому объёму. Ось Y — pg_total_relation_size в байтах: сама таблица, индексы и дополнительное хранилище TOAST. Подписи округлены в КБ/МБ/ГБ для чтения; наведите курсор для значения. Это размер хранения, не выручка или число строк. Оценка строк рядом берётся из PostgreSQL n_live_tup, а не из точного COUNT(*) и может отставать до обновления статистики.</p>
                </details>
                {selectedTable ? <TableDetail key={selectedTable} tableName={selectedTable} /> : null}
              </> : null}
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function HandbookDifferences() {
  return (
    <details className="report-disclosure handbook-differences">
      <summary>Как читать цифры: формулы, статус данных и отличия от справочника Naliv</summary>
      <p className="context-note">У каждой карточки и расчётной колонки есть «ⓘ»: смысл, точная формула, единицы, источники/поля, даты, трактовка нуля и ограничения. У графиков — отдельные раскрытия про оси, серии и агрегацию. «Нет данных» не означает 0. «Частично» — рассчитана только доступная часть. Даты «с/по» включаются обе; на сервере правая граница сдвигается на следующий день. Недостающая себестоимость будет добавлена в 1С владельцем и изменит покрытие после синхронизации.</p>
      <p className="context-note">Отображение не меняет исходные расчёты: денежные суммы обычно округлены до целого ₸, «тыс.»/«млн» и K/M на графиках — сокращения масштаба, количества и проценты показаны с указанной в колонке точностью. Коэффициент «раз» не является процентом. Итоги и отношения считаются по неокруглённым значениям, поэтому сумма видимых округлённых строк может отличаться от итога. «—», «Нет стоимости» и «Не определена» не подменяют отсутствующий знаменатель или цену нулём.</p>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead><tr><th scope="col">Область</th><th scope="col">Что отличается или ещё недоступно</th><th scope="col">Что не подменяем предположением</th></tr></thead>
          <tbody>
            <tr><th scope="row">Выручка и прибыль, §§1, 6.4, 7</th><td>Цены 1С корректно включают НДС по подтверждению владельца; отображённые суммы сохраняют его. Справочник требует P&amp;L без НДС. Внутренняя наценка ИП не выделена.</td><td>Не выбираем ставку НДС, налоговые периоды или цену внешнего поставщика без подтверждения.</td></tr>
            <tr><th scope="row">Себестоимость, §6.4</th><td>Доходность и эффективность точки используют четыре источника цены с приоритетом регистра точки → установки точки → общесетевой установки → средневзвешенного поступления за 90 дней. Товарная номенклатура и Inventory используют только общесетевую установку/поступления. Цена выбирается на конец окна для всего расчёта, не отдельно для каждой продажи; «общесетевая» установка может принадлежать другой точке. Внешние поступления и расходники отдельно не классифицированы.</td><td>Не превращаем отсутствующую цену в доказанную нулевую стоимость; не меняем временную политику оценки и не угадываем расходники.</td></tr>
            <tr><th scope="row">Потери, §6.5</th><td>Списания/оприходования и различия пересчётов складываются. В данных обнаружены общие ссылки на приказ инвентаризации; суммы по событию/товару/дате не согласованы и повторный учёт не исключён.</td><td>Не объявляем эти источники независимыми, не удаляем движения по одному совпадению суммы и не распределяем потери по товарам без правила.</td></tr>
            <tr><th scope="row">Чеки и тепловая карта, §§6.2–6.3</th><td>Средний чек = выручка заголовков розничных отчётов после возвратов ÷ (продажные чеки − возвратные). Теплокарта показывает суммы выбранного периода; в справочнике — среднее за четыре недели.</td><td>Не считаем незагруженные даты нулевой торговлей. Суммы заголовков, товарных строк и чеков могут различаться.</td></tr>
            <tr><th scope="row">Закупки и запас, §§5.3–5.4, 6.6–6.9</th><td>Для закупок используются распознанные количественные нормативы 1С; групповой fallback по дням не реализован. Замороженный запас точки использует норму 30 дней для всех товаров; товарные кандидаты усредняют продажи по календарным дням, а не только дням наличия.</td><td>Не угадываем товарные группы, единицы нормативных полей и соответствия адресов. Не запрещаем автоматически закупку по непроверенной классификации.</td></tr>
            <tr><th scope="row">Деньги и поток, §§3–4</th><td>Есть снимки касс и ККМ; банковских выписок пока нет. Дни инкассации = только баланс ККМ ÷ среднюю наличную выручку за 28 дней. Исторические юридические ключи точки не объединены для денег.</td><td>Не показываем банк/эквайринг в пути/свободные деньги как 0; не удаляем старые остатки и не придумываем стартовый баланс.</td></tr>
            <tr><th scope="row">Полный P&amp;L и отдача, §§6.10–6.13, 7–8</th><td>Не рассчитаны достоверные расходы/ФОТ точки, торговые площади, смены, вклад точки, чистая прибыль, EBITDA, долг/EBITDA и доступные выплаты владельцу. Реестр проектов показывает ручной бюджет/факт, не разрешение инвестировать.</td><td>Не подставляем предложенные 3 недели резерва и 30% выплат как утверждённые настройки владельца.</td></tr>
            <tr><th scope="row">Покрытие, статусы и ориентиры</th><td>Публикационные 80%/90% — защитные правила приложения, а не требования справочника. ABC/XYZ и товарные категории — прикладная аналитика; их границы не заданы отдельной формулой в документе.</td><td>Не смешиваем процент покрытия источника с бизнес-нормативом. Сохранённые владельцем пороги не заменяются дефолтами реестра.</td></tr>
          </tbody>
        </table>
      </div>
      <h3>Формулы справочника для пока недоступных показателей</h3>
      <p className="context-note">Ниже — объяснения и недостающие входные данные, не рассчитанные значения и не нули. Доступный валовый результат, кассовые операции и реестр обязательств не подменяют полный P&amp;L или банк.</p>
      <div className="data-group-grid">
        {Object.entries(unavailableHandbookMetrics).map(([group, ids]) => (
          <section key={group}>
            <h4>{group}</h4>
            <ul>{ids.map((id) => (
              <li key={id}><MetricLabel metricId={id} status="unavailable">{metricDefinitions[id].title}</MetricLabel></li>
            ))}</ul>
          </section>
        ))}
      </div>
    </details>
  );
}

function NavButton({ page, currentPage, onSelect, icon }: {
  page: AppPage;
  currentPage: AppPage;
  onSelect: (page: AppPage) => void;
  icon: ReactNode;
}) {
  return <button className={currentPage === page ? "active" : ""} type="button" aria-current={currentPage === page ? "page" : undefined} onClick={() => onSelect(page)}>
    {icon}<span>{pageMeta[page].label}</span>
  </button>;
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
      <details className="report-disclosure">
        <summary>Что означают числовые сведения о составе базы</summary>
        <p className="context-note">Группы формируются по имени и структуре таблиц схемы raw_1c. «Таблиц» — число объектов группы; «Строк» — сумма PostgreSQL n_live_tup по объектам, оценка статистики, а не точный COUNT. «Колонок» — сумма столбцов; «числовых» и «дат» — столбцы с соответствующим SQL-типом, не заполненные записи. Число рядом со служебным полем (_loaded_at, ref_key, _parent_ref_key и др.) — количество таблиц, где найдена такая колонка, не число строк с заполненным значением. Карточка показывает состав хранилища, а не готовность бизнес-метрики или число реальных операций.</p>
      </details>

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


function UnavailableMetricPanel({ title, metrics, initiallyOpen = false }: {
  title: string;
  metrics: Array<{ metricId: MetricId; reason: string }>;
  initiallyOpen?: boolean;
}) {
  return <details className="report-disclosure" open={initiallyOpen}>
    <summary>{title}</summary>
    <p className="availability-summary">Для этих показателей пока недостаточно данных. Они не заменяются нулем.</p>
    <div className="metric-grid report-metric-grid">
      {metrics.map((item) => <MetricCard key={item.metricId} icon={<ShieldCheck size={18} />} metricId={item.metricId} value={null} status="unavailable" reason={item.reason} />)}
    </div>
  </details>;
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
        if (controller.signal.aborted) return;
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
          <details className="report-disclosure">
            <summary>Как рассчитаны обязательства и предложения из РКО</summary>
            <p className="context-note">Введённая сумма, дата и периодичность — ручные записи, не результат банковской сверки. Итог = сумма amount всех активных строк; частота и дата не разворачиваются в будущие платежи, суммы разных периодичностей не нормализуются. Счётчик рядом — число активных строк; даже пустой реестр не означает отсутствие реальных обязательств. Предложения РКО: за последние шесть месяцев суммы расходных кассовых ордеров группируются по статье и месяцу; среднее = сумма месячных значений ÷ число месяцев, где статья встречалась (месяцы без строк не входят). Предлагаются статьи минимум с двумя такими месяцами; «N мес.» — число наблюдаемых месяцев, не срок обязательства. Принятие предложения копирует округлённую сумму в редактируемую строку; сохранение выполняется отдельно. Без банка/правил резерва этот реестр не рассчитывает свободные деньги.</p>
          </details>
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
            <thead><tr><th scope="col">Тип</th><th scope="col">Название</th><th scope="col"><MetricLabel metricId="money.registered-obligations">Сумма</MetricLabel></th><th scope="col">Дата</th><th scope="col">Периодичность</th><th scope="col">Активно</th><th scope="col" /></tr></thead>
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
        if (controller.signal.aborted) return;
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
          <span>Бюджеты и фактические расходы. Для окупаемости нужны подтвержденные доходы, затраты и денежные потоки.</span>
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
          <details className="report-disclosure">
            <summary>Как рассчитаны бюджет, факт и отклонение проекта</summary>
            <p className="context-note">Бюджет и факт вводятся вручную в ₸. Отклонение = факт − бюджет: положительное означает расход выше бюджета, отрицательное — пока ниже. Сводные карточки складывают все строки, в том числе запланированные, завершённые и отменённые; они не фильтруются общим периодом продаж и не являются банковскими платежами. Дата старта — ручная дата проекта. Без подтверждённого денежного потока, прибыли новой точки и полной цены открытия срок окупаемости и лимит новых открытий по §§8.5–8.8 не рассчитаны.</p>
          </details>
          <div className="data-table-wrap">
            <table className="data-table settings-table">
              <thead><tr><th scope="col">Проект</th><th scope="col"><MetricLabel metricId="reinvest.budget">Бюджет</MetricLabel></th><th scope="col"><MetricLabel metricId="reinvest.actual">Факт</MetricLabel></th><th scope="col"><MetricLabel metricId="reinvest.deviation">Отклонение</MetricLabel></th><th scope="col">Старт</th><th scope="col">Статус</th><th scope="col" /></tr></thead>
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

function OwnerHome({ dateRange, onNavigate }: { dateRange: DateRangeValue; onNavigate: (page: AppPage, view?: string) => void }) {
  return <>
    <StorePerformanceDashboard dateRange={dateRange} summaryOnly />
    <nav className="overview-actions" aria-label="Перейти к анализу">
      <button type="button" className="overview-action" onClick={() => onNavigate("sales")}><strong>Разобрать продажи</strong><span>Динамика, товары и время покупок</span><ChevronRight size={18} /></button>
      <button type="button" className="overview-action" onClick={() => onNavigate("stores")}><strong>Сравнить магазины</strong><span>Доходность и потери по точкам</span><ChevronRight size={18} /></button>
      <button type="button" className="overview-action" onClick={() => onNavigate("stock", "purchasing")}><strong>Проверить закупку</strong><span>Остатки и рекомендации к заказу</span><ChevronRight size={18} /></button>
      <button type="button" className="overview-action" onClick={() => onNavigate("finance")}><strong>Посмотреть деньги</strong><span>Кассы, платежи и доходность</span><ChevronRight size={18} /></button>
    </nav>
    <UnavailableMetricPanel title="Что пока нельзя рассчитать для всей сети" metrics={[
      { metricId: "money.free", reason: "Для полной оценки нужны банковские остатки и полный список предстоящих платежей." },
      { metricId: "money.position", reason: "Деньги в кассах доступны в «Финансы». Остатки на банковских счетах и незачисленные оплаты картой пока не учтены." },
      { metricId: "money.calendar", reason: "Для прогноза платежей нужны банковские остатки, зарплата, регулярные платежи и графики кредитов." }
    ]} />
  </>;
}

function SalesWorkspace({ dateRange, view }: { dateRange: DateRangeValue; view: string }) {
  return view === "comparison" ? <YearComparisonExport dateRange={dateRange} /> : <SalesReports dateRange={dateRange} view={view} />;
}

function FinanceWorkspace({ dateRange, view }: { dateRange: DateRangeValue; view: string }) {
  if (view === "profit") return <PnlWorkspace dateRange={dateRange} />;
  if (view === "projects") return <ReinvestmentWorkspace />;
  if (view === "payments") return <ObligationDirectory />;
  if (view === "suppliers") return <ManagementDashboard dateRange={dateRange} panel="suppliers" />;
  if (view === "cards") return <ManagementDashboard dateRange={dateRange} panel="cards" />;
  if (view === "cash") return <ManagementDashboard dateRange={dateRange} panel="cash" />;
  return <>
    <ManagementDashboard dateRange={dateRange} panel="money" />
    <UnavailableMetricPanel title="Ограничения полной денежной картины" metrics={[
      { metricId: "money.position", reason: "Показаны кассы и кассовые аппараты. Для полной суммы нужны банковские остатки и еще не зачисленные оплаты картой." },
      { metricId: "money.free", reason: "Для доступных к расходованию денег нужно учесть банк, все обязательства и резерв." },
      { metricId: "money.calendar", reason: "Плановые платежи можно вести отдельно. Прогноз поступлений и банковские остатки пока не загружены." },
      { metricId: "debt.payments-12m", reason: "Нужны список кредитов и графики платежей." },
      { metricId: "debt.dscr", reason: "Для оценки покрытия долга нужны графики платежей и подтвержденный денежный поток." }
    ]} />
  </>;
}

function StoresWorkspace({ dateRange, view }: { dateRange: DateRangeValue; view: string }) {
  if (view === "losses") return <ManagementDashboard dateRange={dateRange} panel="losses" />;
  if (view === "lost-sales") return <ManagementDashboard dateRange={dateRange} panel="lost-sales" />;
  if (view === "productivity") return <UnavailableMetricPanel title="Показатели площади и персонала" initiallyOpen metrics={[
    { metricId: "store.revenue-m2", reason: "Не заполнена площадь торгового зала магазинов." },
    { metricId: "store.profit-m2", reason: "Не заполнена площадь торгового зала магазинов." },
    { metricId: "store.revenue-shift", reason: "Нужны табели смен и численность сотрудников по магазинам." },
    { metricId: "store.payroll-share", reason: "Нужны начисления зарплаты по магазинам." }
  ]} />;
  return <StorePerformanceDashboard dateRange={dateRange} />;
}

function StockWorkspace({ dateRange, onDateRangeChange, view }: {
  dateRange: DateRangeValue; onDateRangeChange: (range: DateRangeValue) => void; view: string;
}) {
  if (view === "turnover") return <TurnoverReport dateRange={dateRange} onDateRangeChange={onDateRangeChange} />;
  if (view === "purchasing") return <ManagementDashboard dateRange={dateRange} panel="purchasing" />;
  if (view === "store-stock") return <ManagementDashboard dateRange={dateRange} panel="store-stock" />;
  if (view === "assortment") return <NomenclatureReports dateRange={dateRange} />;
  return <InventoryReports dateRange={dateRange} />;
}

function PnlWorkspace({ dateRange }: { dateRange: DateRangeValue }) {
  return <>
    <IncomeReports dateRange={dateRange} />
    <UnavailableMetricPanel title="Что не входит в оценку доходности продаж" metrics={[
      { metricId: "pnl.ebitda", reason: "Операционная прибыль сети пока не рассчитана: нужны зарплата, аренда, другие постоянные расходы, налоги и правила учета внутренних передач." }
    ]} />
  </>;
}

function ReinvestmentWorkspace() {
  return <>
    <ProjectDirectory />
    <UnavailableMetricPanel title="Лимит вложений пока не рассчитан" metrics={[
      { metricId: "reinvest.limit", reason: "Для безопасного лимита вложений нужны операционная прибыль, свободные деньги и подтвержденный денежный поток. Бюджеты и фактические расходы проектов можно вести уже сейчас." }
    ]} />
  </>;
}

function DecisionThresholdTable() {
  const [state, setState] = useState<LoadState<ManagementSettings>>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    api.managementSettings(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "success", data });
      })
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
        <thead><tr><th scope="col">Метрика</th><th scope="col">Норма</th><th scope="col">Тревога</th><th scope="col">Частота</th><th scope="col">Ответственный</th></tr></thead>
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
          { metricId: "reinvest.limit", reason: "Для проверки открытия магазина нужны данные проектов и подтвержденная прибыль сети." }
        ]}
      />

    </>
  );
}

function StorePerformanceDashboard({ dateRange, summaryOnly = false }: { dateRange: DateRangeValue; summaryOnly?: boolean }) {
  const [state, setState] = useState<LoadState<StorePerformanceMetrics>>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    api.storePerformanceMetrics({ ...dateRange, limit: 30 }, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "success", data });
      })
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
      <p className="context-note">По загруженным розничным отчетам магазинов, активных за 90 дней. Покрытие периода может быть неполным; доходность и запас — оценочные.</p>
      {state.status === "loading" ? <FullScreenState title="Считаем показатели точек" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {report?.summary.activeStoreCount === 0 ? <div className="empty-state">Нет магазинов с розничными продажами за последние 90 дней к концу выбранного периода. Выберите другой период; отсутствие отчётов не считается нулевой выручкой.</div> : null}
      {report && report.summary.activeStoreCount > 0 ? (
        <>
          <section className="metric-grid report-metric-grid six-metrics">
            <MetricCard icon={<Receipt size={18} />} metricId="store.revenue" label="Выручка активных точек по строкам" value={formatMoney(report.summary.revenue)} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="store.profit-after-loss" value={formatMoney(report.summary.grossProfitAfterLoss)} status={report.summary.unvaluedRevenue > 0 ? "partial" : "ready"} coveragePct={report.summary.revenue !== 0 ? (Math.abs(report.summary.revenue) - report.summary.unvaluedRevenue) / Math.abs(report.summary.revenue) * 100 : 100} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="store.margin-after-loss" value={report.summary.marginAfterLossPct === null ? null : `${formatDecimal(report.summary.marginAfterLossPct, 1)}%`} />
            <MetricCard icon={<Store size={18} />} metricId="store.active" value={formatNumber(report.summary.activeStoreCount)} />
            <MetricCard icon={<Boxes size={18} />} metricId="stock.closing-cost" value={formatMoney(report.summary.closingStockCost)} status={report.summary.closingUnvaluedQty > 0 ? "partial" : "ready"} reason={report.summary.closingUnvaluedQty > 0 ? `${formatDecimal(report.summary.closingUnvaluedQty)} ед. без стоимости` : undefined} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="stock.movement" value={report.summary.stockMovement === null ? null : formatMoney(report.summary.stockMovement)} status={report.summary.stockMovement === null ? "unavailable" : "ready"} reason={report.summary.stockMovement === null ? "Нет снимка остатков на начало периода для каждой активной точки." : undefined} />
          </section>
          {!summaryOnly ? (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Точка</th>
                    <th scope="col" className="num"><MetricLabel metricId="store.revenue" /></th>
                    <th scope="col" className="num"><MetricLabel metricId="store.profit-after-loss" /></th>
                    <th scope="col" className="num"><MetricLabel metricId="store.margin-after-loss" /></th>
                    <th scope="col" className="num"><MetricLabel metricId="stock.closing-cost" /></th>
                    <th scope="col" className="num"><MetricLabel metricId="stock.days" /></th>
                    <th scope="col" className="num"><MetricLabel metricId="stock.average">Средний запас</MetricLabel></th>
                    <th scope="col" className="num"><MetricLabel metricId="stock.frozen" /></th>
                    <th scope="col" className="num"><MetricLabel metricId="stock.gmroi" /></th>
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
          <details className="report-disclosure">
            <summary>Оборачиваемость, замороженный запас и ограничения расчета</summary>
            <div className="metric-grid report-metric-grid">
            <MetricCard icon={<Package size={18} />} metricId="stock.frozen" value={report.summary.frozenStockCost === null ? null : formatMoney(report.summary.frozenStockCost)} status={report.methodology.frozenStockStatus} coveragePct={report.summary.frozenSnapshotCoveragePct} detail={report.summary.frozenStockPct === null ? undefined : <MetricLabel metricId="stock.frozen-share">{formatDecimal(report.summary.frozenStockPct, 1)}% запаса</MetricLabel>} reason={report.methodology.frozenStockStatus === "partial" ? "Недостаточно ежедневных снимков для доверенной оценки." : undefined} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="stock.gmroi" value={report.summary.gmroi === null ? null : formatDecimal(report.summary.gmroi, 2)} status={report.summary.stockSnapshotCoveragePct >= 90 ? "ready" : "partial"} coveragePct={report.summary.stockSnapshotCoveragePct} reason={report.summary.gmroi === null ? "Средний запас публикуется при покрытии периода снимками не ниже 90%." : undefined} />
            </div>
            <div className="stack-list">
              <p>Выручка и валовая прибыль используют строки проведённых розничных отчётов, а не суммы чеков: валовая прибыль после потерь = продажа − возвращённая строка − оценочная себестоимость − чистые потери. Сумма остаётся с включённым в 1С НДС и без устранения внутренней наценки; обе разницы с §6.4/§7.5 справочника остаются. Точки в рейтинге отсортированы по выручке; активность определяется продажами за 90 дней либо ручной настройкой.</p>
              <p><MetricLabel metricId="store.summary-cost-coverage">Покрытие стоимости в сетевой карточке прибыли</MetricLabel> = (abs(чистой выручки активных точек) − неоценённая абсолютная выручка) ÷ abs(чистой выручки) × 100. При нулевой чистой выручке интерфейс подставляет технические 100%; это не подтверждение полной оценки. Возвраты уменьшают знаменатель, поэтому без обрезки снизу показатель может быть отрицательным. Он не равен доле оценённых товарных ключей или денежной базе Income, где используются абсолютные суммы строк.</p>
              <p>Запас в днях точки = стоимость закрывающего остатка ÷ (себестоимость продаж за фиксированные 28 дней ÷ 28). Себестоимость 28-дневных проданных количеств оценивается тем же доступным ценовым приоритетом. Это денежный показатель по точке; товарная таблица выше показывает отношение количеств по отдельному товару.</p>
              <p>Средний запас точки = AVG оценённой стоимости наблюдаемых моментов снимка, где найден положительный товар; пропущенные и полностью нулевые моменты не дополняются нулями. GMROI точки = (прибыль после потерь × 365 ÷ календарные дни интервала) ÷ этот средний запас. Цены на конец окна применяются ко всем его снимкам. <MetricLabel metricId="stock.snapshot-coverage">Покрытие среднего запаса</MetricLabel> = разные моменты snapshot_at ÷ календарные дни, максимум 100%; несколько моментов в один день не доказывают охват разных дней. Сетевое покрытие взвешено закрывающей стоимостью, не является минимумом по точкам. В сетевую GMROI входят только активные точки с опубликованным средним запасом &gt; 0: суммируются их прибыль и средние запасы. Порог публикации 90% — правило приложения.</p>
              <p>Замороженный запас товара = max(остаток − скорость при наличии × 30, 0) × себестоимость. Скорость здесь = сумма max(чистого количества продаж за дату, 0), присоединённого к положительным наблюдениям остатка за фиксированные 28 дней, ÷ число этих наблюдений. Группировка — по моменту снимка, не уникальному календарному дню: при нескольких снимках в день его продажи могут учитываться повторно. <MetricLabel metricId="stock.frozen-snapshot-coverage">Покрытие этого окна</MetricLabel> также считает разные моменты снимка ÷ 28, максимум 100%. Товар без найденной положительной скорости целиком попадает в замороженный; это не доказанное отсутствие спроса. Доля = замороженная стоимость ÷ закрывающий запас по себестоимости × 100. §6.8 требует дни наличия, но не задаёт числовой норматив; 30 дней — настройка приложения. Пороги справочника ≤10% / &gt;20% не превращены в статус этой карточки.</p>
              <p>Движение запаса = закрывающий остаток по себестоимости − открывающий остаток по себестоимости; не покупки минус продажи, прибыль или денежный поток. Открывающий снимок — последний не позже начала «с», закрывающий — последний не позже момента конца отчёта. Покрытие открытия — доля активных точек с открывающей оценкой; ценовое покрытие закрытия — доля положительных пар «точка/товар» с ценой, не доля штук. Неполная оценка цены не становится доказанным нулём.</p>
            </div>
          </details>
        </>
      ) : null}
    </section>
  );
}

type ManagementPanel = "losses" | "lost-sales" | "cards" | "cash" | "money" | "suppliers" | "store-stock" | "purchasing" | "sources";

function ManagementDashboard({ dateRange, panel }: { dateRange: DateRangeValue; panel: ManagementPanel }) {
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
        .then((data) => {
          if (!controller.signal.aborted) setter({ status: "success", data });
        })
        .catch((caught) => {
          if (!controller.signal.aborted) {
            setter({ status: "error", error: caught instanceof Error ? caught.message : fallback });
          }
        });
    };

    if (panel === "losses") load(api.lossMetrics(filters, controller.signal), setLosses, "Не удалось загрузить потери");
    if (panel === "lost-sales") load(api.lostSalesMetrics(filters, controller.signal), setLostSales, "Не удалось оценить упущенные продажи");
    if (panel === "cards") load(api.acquiringMetrics(filters, controller.signal), setAcquiring, "Не удалось загрузить оплаты картой");
    if (panel === "cash") load(api.cashArticleMetrics(filters, controller.signal), setCash, "Не удалось загрузить кассовые операции");
    if (panel === "money") load(api.moneyPositionMetrics(filters, controller.signal), setMoneyPosition, "Не удалось загрузить деньги в кассах");
    if (panel === "suppliers") load(api.supplierTermsMetrics(filters, controller.signal), setSupplierTerms, "Не удалось загрузить платежи поставщикам");
    if (panel === "store-stock") load(api.storeStockMetrics(filters, controller.signal), setStoreStock, "Не удалось загрузить запасы магазинов");
    if (panel === "purchasing") load(api.purchasingRecommendations(filters, controller.signal), setPurchasing, "Не удалось сформировать рекомендации к заказу");
    if (panel === "sources") load(api.sourceHealth(filters, controller.signal), setSourceHealth, "Не удалось проверить обновление данных");

    return () => controller.abort();
  }, [dateRange.from, dateRange.to, panel]);

  if (panel === "losses") return <LossMetricsPanel state={losses} />;
  if (panel === "lost-sales") return <LostSalesPanel state={lostSales} />;
  if (panel === "cards") return <AcquiringMetricsPanel state={acquiring} />;
  if (panel === "cash") return <CashArticleMetricsPanel state={cash} />;
  if (panel === "money") return <MoneyPositionPanel state={moneyPosition} />;
  if (panel === "suppliers") return <SupplierTermsPanel state={supplierTerms} />;
  if (panel === "store-stock") return <StoreStockPanel state={storeStock} />;
  if (panel === "purchasing") return <PurchasingRecommendationsPanel state={purchasing} />;
  return <SourceHealthPanel state={sourceHealth} />;
}

function ManagementSettingsPanel() {
  const [settings, setSettings] = useState<ManagementSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.managementSettings(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setSettings(data);
      })
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
          <details className="report-disclosure">
            <summary>Что означают даты, пороги и счётчики настроек</summary>
            <p className="context-note">Активность по умолчанию означает наличие проведённого неудалённого розничного отчёта за 90 дней; ручной флаг имеет приоритет. Дата последнего отчёта — максимальная дата такого документа до момента загрузки настроек, не дата последнего чека или положительной товарной продажи. Порог, период проверки и ответственный вводятся вручную; их единицы и смысл раскрыты у соответствующей метрики. Они не превращают недоступную финансовую величину в рассчитанную. Счётчики кассовых статей здесь охватывают всю загруженную историю расшифровок, а не выбранное окно кассового отчёта; предложения по названию ещё не являются подтверждённым типом потока.</p>
          </details>
          <section className="panel">
            <div className="panel-title">
              <div>
                <h3>Активные точки</h3>
                <span>по умолчанию — продажи за 90 дней; решение администратора имеет приоритет</span>
              </div>
            </div>
            <div className="data-table-wrap">
              <table className="data-table settings-table">
                <thead><tr><th scope="col">Активна</th><th scope="col">Название 1С</th><th scope="col">Название в отчётах</th><th scope="col">Последний розничный отчёт</th><th scope="col" /></tr></thead>
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
                <thead><tr><th scope="col">Метрика</th><th scope="col">Норма</th><th scope="col">Тревога</th><th scope="col">Частота</th><th scope="col">Ответственный</th><th scope="col" /></tr></thead>
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
                <thead><tr><th scope="col">Статья</th><th scope="col"><MetricLabel metricId="cash.settings-lines">Строк · вся история</MetricLabel></th><th scope="col">Предложение</th><th scope="col">Поток</th><th scope="col">Подтверждено</th><th scope="col" /></tr></thead>
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
          <details className="report-disclosure">
            <summary>Формулы покрытия и сверки исходных данных</summary>
            <div className="stack-list">
              <p>Границы наличия чеков — самая ранняя/поздняя дата проведённых, неудалённых документов во всей загруженной таблице. Счётчик периода — все такие чеки внутри выбранного окна, включая возвраты; «дни» — число уникальных календарных дат. Покрытие = эти даты ÷ календарные дни от начала окна до меньшего из его конца и начала сегодняшнего дня × 100, максимум 100%. Статус готовности начинается от 90% (правило приложения). Один чек в дате делает её присутствующей, но не доказывает загрузку всех чеков.</p>
              <p>Площади: заполнено = карточки магазинов с ploschad_torgovogo_zala &gt; 0; всего = карточки без пометки удаления (не только активные точки). Табели/зарплата — число проведённых документов за окно; их наличие само по себе не подтверждает распределение ФОТ по точкам. Банк — число таблиц со словами «raschetnogo_scheta» или «bankovskaya_vypiska» в имени; это обнаружение источника, не баланс и не проверка полноты выписок.</p>
              <p>Покрытие отдельного поля НДС = количество продажных строк, где abs(summa_nds) &gt; 0,000001, ÷ все продажные строки × 100. Строка с нулевым полем не доказывает, что цена без НДС: владелец подтвердил включённый НДС; цены сохраняются, вычет не выполнен. Порог 90% здесь только технический сигнал заполнения поля, не налоговое правило.</p>
              <p>Сверка (₸) относится к проведённым отчётам розницы внутри окна: заголовки = Σ summa_dokumenta; товарные строки = Σ summa; возвраты заголовков = Σ summa_vozvratov; возвратные строки = Σ summa отдельной возвращённой табличной части. Для чистых сумм вычитайте возвраты из соответствующего источника, не перекрёстно. Расхождение уровней не является потерей, прибылью или доказанным налогом.</p>
            </div>
          </details>
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
                  <th scope="col">Точка</th>
                  <th scope="col"><MetricLabel metricId="loss.writeoffs">Списания</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="loss.surpluses">Излишки</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="loss.result">Результат ревизий</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="loss.rate">% выручки</MetricLabel></th>
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
        <h2>Оплата картой</h2>
        <span>Продажи, возвраты и доступные сведения о комиссии.</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Считаем эквайринг" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid six-metrics" aria-label="Метрики эквайринга">
            <MetricCard icon={<TrendingUp size={18} />} metricId="acquiring.sales" label="Продажи картами" value={formatMoney(state.data.summary.sales)} />
            <MetricCard icon={<RotateCcw size={18} />} metricId="acquiring.returns" label="Возвраты на карты" value={formatMoney(state.data.summary.returns)} />
            <MetricCard icon={<Receipt size={18} />} metricId="acquiring.turnover" label="Чистый карточный оборот" value={formatMoney(state.data.summary.turnover)} />
            <MetricCard icon={<ShoppingCart size={18} />} metricId="acquiring.commission" label="Комиссия" value={state.data.summary.commission === null ? null : formatMoney(state.data.summary.commission)} status={state.data.summary.commissionStatus} reason={state.data.summary.commission === null ? "Суммы комиссии не заполнены. Это не означает, что банк работает без комиссии." : undefined} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="acquiring.rate" label="Средняя ставка" value={state.data.summary.commissionPct === null ? null : `${formatDecimal(state.data.summary.commissionPct, 2)}%`} status={state.data.summary.commissionStatus} />
            <MetricCard icon={<Table2 size={18} />} metricId="acquiring.lines" label="Строк операций по картам" value={formatNumber(state.data.summary.recordCount)} />
          </section>
          <div className="metric-note warning">Банковские зачисления пока не загружены, поэтому деньги в пути не рассчитаны. Незаполненная комиссия не считается нулевой.</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Точка</th>
                  <th scope="col"><MetricLabel metricId="acquiring.sales">Продажи</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="acquiring.returns">Возвраты</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="acquiring.turnover">Чистый оборот</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="acquiring.commission">Комиссия</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="acquiring.rate">Ставка</MetricLabel></th>
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
        <h2>Движение наличных</h2>
        <span>Поступления и расходы по кассовым документам. Банковские операции не включены.</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Собираем кассовые движения" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Кассовые движения">
            <MetricCard
              icon={<TrendingUp size={18} />}
              metricId="cash.inflow"
              label="Поступления после исключений"
              value={formatMoney(state.data.summary.externalInflow)}
              status="partial"
              reason={`Внутренние перемещения исключены на ${formatMoney(state.data.summary.internalInflow)}. Неподтвержденные финансистом статьи перемещений пока остаются в поступлениях.`}
            />
            <MetricCard
              icon={<Receipt size={18} />}
              metricId="cash.outflow"
              label="Расходы после исключений"
              value={formatMoney(state.data.summary.externalOutflow)}
              status="partial"
              reason={`Внутренние перемещения исключены на ${formatMoney(state.data.summary.internalOutflow)}. Неподтвержденные финансистом статьи перемещений пока остаются в расходах.`}
            />
            <MetricCard
              icon={<BarChart3 size={18} />}
              metricId="cash.net"
              label="Разница поступлений и расходов"
              value={formatMoney(state.data.summary.net)}
              status="partial"
              reason="До подтверждения статей-перемещений это не полный внешний денежный поток."
            />
            <MetricCard icon={<Table2 size={18} />} metricId="cash.categorized" label="Строк со статьёй" value={`${formatDecimal(state.data.summary.categorizedPct, 1)}%`} />
          </section>
          <details className="report-disclosure">
            <summary>Денежные потоки и внутренние перемещения</summary>
          <section className="metric-grid report-metric-grid" aria-label="Три потока кассового ОДДС">
            <MetricCard
              icon={<TrendingUp size={18} />}
              metricId="cash.operating-inflow"
              label="Поступления операционного потока"
              value={state.data.statement.flows.operating.inflow === null ? null : formatMoney(state.data.statement.flows.operating.inflow)}
              status={state.data.statement.flows.operating.inflow === null ? "unavailable" : "partial"}
              reason={state.data.statement.flows.operating.inflow === null ? "Нет подтверждённых внешних статей в выбранной кассовой выборке." : "Только кассовые строки с подтверждённым операционным типом; банк не подключён."}
            />
            <MetricCard
              icon={<Receipt size={18} />}
              metricId="cash.operating-outflow"
              label="Расходы операционного потока"
              value={state.data.statement.flows.operating.outflow === null ? null : formatMoney(state.data.statement.flows.operating.outflow)}
              status={state.data.statement.flows.operating.outflow === null ? "unavailable" : "partial"}
              reason={state.data.statement.flows.operating.outflow === null ? "Нет подтверждённых внешних статей в выбранной кассовой выборке." : "Только кассовые строки с подтверждённым операционным типом; банк не подключён."}
            />
            <MetricCard
              icon={<TrendingUp size={18} />}
              metricId="cash.operating"
              value={state.data.statement.flows.operating.net === null ? null : formatMoney(state.data.statement.flows.operating.net)}
              status={state.data.statement.flows.operating.net === null ? "unavailable" : "partial"}
              reason={state.data.statement.flows.operating.net === null ? "Нет подтверждённых внешних статей в выбранной кассовой выборке." : "Кассовая часть потока; банковская часть не подключена."}
            />
            <MetricCard
              icon={<BarChart3 size={18} />}
              metricId="cash.investing"
              value={state.data.statement.flows.investing.net === null ? null : formatMoney(state.data.statement.flows.investing.net)}
              status={state.data.statement.flows.investing.net === null ? "unavailable" : "partial"}
              reason={state.data.statement.flows.investing.net === null ? "Нет подтверждённых внешних статей в выбранной кассовой выборке." : "Кассовая часть потока; банковская часть не подключена."}
            />
            <MetricCard
              icon={<Receipt size={18} />}
              metricId="cash.financing"
              value={state.data.statement.flows.financing.net === null ? null : formatMoney(state.data.statement.flows.financing.net)}
              status={state.data.statement.flows.financing.net === null ? "unavailable" : "partial"}
              reason={state.data.statement.flows.financing.net === null ? "Нет подтверждённых внешних статей в выбранной кассовой выборке." : "Кассовая часть потока; банковская часть не подключена."}
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
          <p className="context-note">Операционные поступления и расходы — разные суммы подтверждённых операционных строк; чистый поток = поступления − расходы. Инвестиционный и финансовый поток рассчитаны так же. Если во всей выбранной внешней выборке нет ни одной подтверждённой статьи, все три потока недоступны. Если подтверждён хотя бы один внешний тип, другой поток без отнесённых строк может показывать технический 0: это не доказательство отсутствия реальных операций, особенно без банка. Поле статьи и её подтверждённый тип — разные виды покрытия. Внутренние суммы исключаются из внешних потоков, ордера без расшифровки учитываются отдельно по заголовку.</p>
          </details>
          <div className="metric-note warning"><MetricLabel metricId="cash.classified-coverage">Подтверждённая классификация: {formatDecimal(state.data.statement.classifiedCoveragePct, 1)}% оборота.</MetricLabel> Переводы между своими кассами и выемки из кассовых аппаратов исключаются; неподтверждённые статьи перемещений остаются в расчётах до решения финансиста. Это не полный денежный поток сети.</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Статья ДДС</th>
                  <th scope="col">Подтверждённый поток</th>
                  <th scope="col"><MetricLabel metricId="cash.inflow">Приход после исключений</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="cash.outflow">Расход после исключений</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="cash.net">Чистое движение</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="cash.internal">Внутри</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="cash.lines">Строк расшифровки</MetricLabel></th>
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
          <UnavailableMetricPanel title="Что нужно для полной финансовой картины" metrics={[
            { metricId: "cash.reconciliation", reason: "Для сверки нужны банковские выписки и остатки по счетам." },
            { metricId: "pnl.intercompany-markup", reason: "Для устранения внутренней наценки нужны правила учета и связи поставок между собственными организациями." }
          ]} />
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
              label="Средняя отсрочка поставщиков"
              value={state.data.summary.weightedDeferralDays === null ? null : `${formatDecimal(state.data.summary.weightedDeferralDays, 1)} дн.`}
              status={state.data.summary.deferralStatus}
              coveragePct={state.data.summary.receiptStageCoveragePct}
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
          <details className="report-disclosure">
            <summary>Какие даты и документы входят в этапы оплаты</summary>
            <p className="context-note">Карточки заказов и их исполнение выбирают документы по дате заказа; связанные поступления ограничены концом окна, но не его началом. Отсрочка использует отдельно даты и этапы поступлений, а не заказы. Историческая таблица ниже выбирает дату платежа этапа внутри выбранного окна независимо от даты заказа и включает также закрытые проведённые заказы. Сумма — плановые суммы этапов, не подтверждённая оплата; число заказов — уникальные ссылки в конкретной дате/поставщике. Один заказ с несколькими датами повторяется в нескольких строках, поэтому счётчики строк нельзя складывать как число заказов периода.</p>
            <p className="context-note">Горизонт открытых заказов начинается с UTC-полуночи более раннего из переданного конца отчёта и текущего момента: min(toExclusive, сейчас), затем начало календарного дня. Конец — через 30/56 дней, не включается. Выбор будущей даты не переносит начало горизонта в будущее. В этой таблице только проведённые незакрытые заказы; старый заказ может входить по будущей дате этапа. Итоги 30/56 дней считаются по всем подходящим этапам до ограничения выдачи таблицы. Это только часть обязательств: не весь платёжный календарь и не прогноз остатка денег.</p>
          </details>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Плановая дата</th>
                  <th scope="col">Контрагент</th>
                  <th scope="col"><MetricLabel metricId="supplier.scheduled-amount">Сумма этапов</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="supplier.scheduled-documents">Заказов на дату</MetricLabel></th>
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
                  <th scope="col">Плановая дата</th>
                  <th scope="col">Контрагент</th>
                  <th scope="col"><MetricLabel metricId="supplier.upcoming-amount">Сумма открытых этапов</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="supplier.upcoming-documents">Открытых заказов на дату</MetricLabel></th>
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
        <span>Наличные в кассах и кассовых аппаратах; банковские счета пока не включены.</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Собираем остатки денег" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data?.stores.length === 0 ? <div className="empty-state">На выбранную дату нет данных об остатках наличных. Это не означает, что денег нет.</div> : null}
      {state.data && state.data.stores.length > 0 ? (
        <>
          <section className="metric-grid report-metric-grid six-metrics" aria-label="Остатки денег">
            <MetricCard icon={<Receipt size={18} />} metricId="money.cash" label="Кассы" value={formatMoney(state.data.summary.cashBalance)} />
            <MetricCard icon={<Store size={18} />} metricId="money.kkm" label="В ККМ" value={formatMoney(state.data.summary.kkmBalance)} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="money.cash-total" label="Наличные итого" value={formatMoney(state.data.summary.totalCash)} status="partial" reason="Банковские счета в сумму не входят." />
            <MetricCard icon={<Database size={18} />} metricId="money.bank" label="Банк" value={null} status="unavailable" reason="Остатки на банковских счетах пока не загружены." />
            <MetricCard icon={<ShieldCheck size={18} />} metricId="supplier.balance-raw" label="Расчеты с поставщиками — до проверки" value={formatMoney(state.data.summary.supplierPayableRaw)} status="experimental" reason="Финансист еще не подтвердил, как различать долг поставщику и переплату. Эта сумма не считается подтвержденным долгом." />
            <MetricCard icon={<Clock size={18} />} metricId="money.cash-days" value={state.data.summary.uncollectedCashDays === null ? null : `${formatDecimal(state.data.summary.uncollectedCashDays, 1)} дн.`} status={state.data.summary.cashDaysStatus} coveragePct={state.data.summary.cashSalesCoveragePct} reason={state.data.summary.uncollectedCashDays === null ? "Недостаточно дней наличной выручки для расчёта." : undefined} />
          </section>
          <div className="metric-note warning">Показаны только наличные. Дни до инкассации оцениваются по наличной выручке за 28 дней. Расчеты с поставщиками требуют проверки: долг и переплата пока не разделены.</div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Точка</th>
                  <th scope="col"><MetricLabel metricId="money.cash">Касса</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="money.kkm">ККМ</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="money.cash-total">Итого без банка</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="money.cash-days">Дней в ККМ</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="supplier.balance-raw">Расчеты до проверки</MetricLabel></th>
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
        <h2>Упущенные продажи</h2>
        <span>Оценка выручки, потерянной из-за отсутствия востребованных товаров.</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Оцениваем упущенные продажи" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid" aria-label="Упущенные продажи">
            <MetricCard icon={<TrendingUp size={18} />} metricId="lost.sales" label="Упущенные продажи" value={state.data.summary.lostSales === null ? null : formatMoney(state.data.summary.lostSales)} status={state.data.summary.status} coveragePct={state.data.summary.coveragePct} reason={state.data.summary.lostSales === null ? "Недостаточно дней с чеками и остатками для надежной денежной оценки." : undefined} />
            <MetricCard icon={<CalendarDays size={18} />} metricId="lost.zero-stock-days" label="Товаро-дней без остатка" value={formatNumber(state.data.summary.zeroStockItemDays)} status={state.data.summary.status} />
            <MetricCard icon={<Package size={18} />} metricId="lost.items" label="Затронуто A/B-позиций" value={formatNumber(state.data.summary.affectedItemCount)} />
            <MetricCard icon={<Database size={18} />} metricId="lost.snapshot-coverage" label="Покрытие источниками" value={`${formatDecimal(state.data.summary.coveragePct, 1)}%`} status={state.data.summary.status} detail={`остатки ${formatNumber(state.data.summary.snapshotDays)} дн. · чеки ${formatNumber(state.data.summary.checkDays)} дн.`} />
          </section>
          <details className="report-disclosure">
            <summary>Как оценена упущенная выручка и где её пределы</summary>
            <div className="stack-list">
              <p>Товар рассматривается отдельно в каждой точке. <MetricLabel metricId="lost.abc-class">ABC точки</MetricLabel> здесь не является A/B из номенклатуры: товары ранжируются по положительной чистой выручке чековых строк магазина, доля считается ДО добавления текущего товара. A — доля предыдущих товаров &lt; 80%; B — от 80% включительно до 95% исключительно; остальная часть исключена. Поэтому товар, пересекающий границу, остаётся в предыдущем классе. <MetricLabel metricId="lost.item-revenue">Выручка товара</MetricLabel> — сумма продажных строк чеков минус возвратные строки. <MetricLabel metricId="lost.average-revenue">Средняя дневная выручка</MetricLabel> = положительная чистая выручка товара за выбранный интервал ÷ все календарные дни этого интервала.</p>
              <p>Упущенная оценка = средняя дневная выручка × <MetricLabel metricId="lost.stock-days">число дат без остатка</MetricLabel>. Снимок остатков сопоставляется с точкой через склад 1С; в наблюдаемую дату снимка отсутствие строки товара считается нулём, равно как сумма остатков ≤ 0. Поэтому сумма — экстраполяция продажного темпа, не наблюдавшаяся продажа и не прибыль.</p>
              <p>Товаро-дни без остатка суммируются по товарам и точкам; количество A/B-позиций — число таких пар, для которых найден хотя бы один день без остатка. Детальная таблица отсортирована по оценке потери; она не означает, что найдено ровно столько реальных несостоявшихся покупок.</p>
              <p>Покрытие = меньшее из дней снимков остатков и дней чеков ÷ календарные дни интервала, максимум 100%. Общая денежная оценка скрывается ниже 90% для любого из двух источников (правило приложения, не норматив справочника). Справочник §6.9 описывает ту же базовую идею «продажи в день × дни без запаса», но здесь спрос берётся из чековых товарных строк и усредняется по календарным дням, а не по доказанным дням наличия товара. Группировка складов в точки и неполные снимки могут менять результат.</p>
            </div>
          </details>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Точка</th>
                  <th scope="col">Товар</th>
                  <th scope="col"><MetricLabel metricId="lost.abc-class">ABC точки</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="lost.stock-days">Дней без остатка</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="lost.sales">Упущенная выручка</MetricLabel></th>
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
        <span>Что заказать с учетом спроса, остатков, открытых заказов и доступной стоимости.</span>
      </div>
      {state.status === "loading" ? <FullScreenState title="Формируем рекомендации" compact /> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.data ? (
        <>
          <section className="metric-grid report-metric-grid six-metrics" aria-label="Рекомендации к закупке">
            <MetricCard icon={<ShoppingCart size={18} />} metricId="purchase.recommendations" label="Позиций к заказу" value={formatNumber(state.data.summary.recommendationCount)} />
            <MetricCard icon={<Boxes size={18} />} metricId="purchase.quantity" label="Рекомендовано единиц" value={formatDecimal(state.data.summary.recommendedQty)} />
            <MetricCard icon={<ShieldCheck size={18} />} metricId="purchase.supplier-coverage" label="С основным поставщиком" value={formatNumber(state.data.summary.recommendationsWithSupplier)} />
            <MetricCard icon={<Receipt size={18} />} metricId="purchase.budget" value={state.data.summary.purchaseBudgetAmount === null ? null : formatMoney(state.data.summary.purchaseBudgetAmount)} status={state.data.summary.budgetStatus} coveragePct={state.data.summary.budgetCostCoveragePct} reason={state.data.summary.purchaseBudgetAmount === null ? `Наблюдаемая оценённая часть: ${formatMoney(state.data.summary.observedPurchaseBudgetAmount)}` : undefined} />
            <MetricCard icon={<ShoppingCart size={18} />} metricId="purchase.ordered" value={formatMoney(state.data.summary.orderedAmount)} detail="последние 7 дней" />
            <MetricCard icon={<TrendingUp size={18} />} metricId="purchase.execution" value={state.data.summary.budgetExecutionPct === null ? null : `${formatDecimal(state.data.summary.budgetExecutionPct, 1)}%`} status={state.data.summary.executionStatus} coveragePct={state.data.summary.executionCostCoveragePct} />
          </section>
          <details className="report-disclosure">
            <summary>Как понимать рекомендацию и бюджет</summary>
            <div className="stack-list">
              <p>Норматив здесь — целевое количество в единицах товара из соответствующего поля карточки 1С, не число дней запаса. Обычная рекомендация = max(норматив − остаток − количество в открытых заказах, 0); прогноз в неё не добавляется.</p>
              <p>Для недельного бюджета прогноз = max(чисто проданное количество за 28 дней, 0) ÷ 4. Количество бюджета = max(норматив + прогноз − остаток − открытые заказы, 0); деньги = это количество × каноническая стоимость единицы. Открытый заказ — проведённый, не закрытый документ поставщику минус связанные поступления. Результат относится к последнему снимку запасов на/до даты отчёта, не к фактической оплате.</p>
              <p><MetricLabel metricId="purchase.daily-rate">Дневной темп</MetricLabel> = знаковое чистое количество чековых строк за 28 дней ÷ 28. При чистых возвратах он может быть отрицательным; только прогноз обрезается на нуле. <MetricLabel metricId="purchase.days-of-stock">Дней запаса</MetricLabel> = max(остаток, 0) ÷ положительный дневной темп; при неположительном темпе — «—». Это количественная оценка, не денежные дни запаса по себестоимости из сводки точки.</p>
              <p>Покрытие стоимости = бюджетное количество с найденной себестоимостью ÷ всё положительное бюджетное количество. Полный денежный итог показывается только при покрытии не менее 90%; это защитное правило приложения, не порог справочника. Таблица содержит только позиции с положительным бюджетным количеством; шапочные итоги считаются до ограничения строк.</p>
              <p>Отличия и пробелы: используются только распознанные магазинные поля нормативного количества; автоматическая подстановка групповых норм 7/14/30/14/14 дней из §5.3 не реализована. Заполнение «Себестоимости» добавит оценку денег, но не создаст норматив для товара/магазина без целевого запаса. Сопоставления магазина с полем 1С для всех точек не подтверждены. Фактическое исполнение сопоставляет заказы за семь дней до снимка с бюджетом, рассчитанным на начало этого окна.</p>
            </div>
          </details>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Точка</th>
                  <th scope="col">Товар</th>
                  <th scope="col">Поставщик</th>
                  <th scope="col"><MetricLabel metricId="purchase.stock-quantity">Остаток</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="purchase.open-order-quantity">В заказах</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="purchase.target-stock">Норматив</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="purchase.forecast">Прогноз 7 дн.</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="purchase.days-of-stock">Дней запаса</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="purchase.quantity">Заказать до норматива</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="purchase.budget-quantity">Бюджет, ед.</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="purchase.budget">Бюджет, ₸</MetricLabel></th>
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
        <span>Последние доступные остатки на выбранную дату; товары без стоимости отмечены отдельно.</span>
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
                  <th scope="col">Точка</th>
                  <th scope="col">Снимок</th>
                  <th scope="col"><MetricLabel metricId="stock.positions">Позиций</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="stock.quantity">Количество</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="stock.reserved">Резерв</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="stock.negative">Отриц. остаток</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="stock.cost">Оценённая себестоимость</MetricLabel></th>
                  <th scope="col"><MetricLabel metricId="stock.coverage">Покрытие цены</MetricLabel></th>
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

function SeriesGrouping({ period, onChange, label }: { period: SalesPeriod; onChange: (period: SalesPeriod) => void; label: string }) {
  return <div className="segmented-control" role="group" aria-label={label}>
    {periodOptions.map((option) => <button key={option.value} className={period === option.value ? "active" : ""} type="button" aria-pressed={period === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

function ReportFilterBar({ dateRange, onDateRangeChange }: {
  dateRange: DateRangeValue;
  onDateRangeChange: (dateRange: DateRangeValue) => void;
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
  const invalidRange = !draftRange.from || !draftRange.to || draftRange.from > draftRange.to;

  return (
    <div className="report-controls">
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
          onClick={() => onDateRangeChange(draftRange)}
        >
          Применить
        </button>
      </div>
      {hasChanges ? <span className="context-note date-range-state" role="status">{invalidRange ? "Укажите обе даты: начало периода не должно быть позже окончания." : `Данные пока за ${formatDate(dateRange.from)} — ${formatDate(dateRange.to)}. Примените новый период, чтобы обновить показатели.`}</span> : null}
    </div>
  );
}

function SalesReports({ dateRange, view }: { dateRange: DateRangeValue; view: string }) {
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
      {view === "summary" ? <div className="report-toolbar">
        <SeriesGrouping period={period} onChange={setPeriod} label="Динамика продаж" />
      </div> : null}

      {reportState.status === "loading" ? (
        <div className="empty-state">Загружаем отчеты</div>
      ) : null}

      {reportState.status === "error" ? (
        <div className="empty-state">{reportState.error}</div>
      ) : null}

      {reportState.status === "success" ? (
        <SalesReportBody report={reportState.data} period={period} view={view} />
      ) : null}
    </section>
  );
}

function SalesReportBody({ report, period, view }: { report: SalesReport; period: SalesPeriod; view: string }) {
  const [selectedWeekday, setSelectedWeekday] = useState(1);
  const [heatmapMetric, setHeatmapMetric] = useState<HeatmapMetric>("checks");
  const heatmapWeekdays = useMemo(() => getHeatmapWeekdays(report.heatmap.days), [report.heatmap.days]);
  const activeWeekday = heatmapWeekdays.find((weekday) => weekday.value === selectedWeekday) ?? heatmapWeekdays[0] ?? null;
  const unavailable = report.summary.dateFrom === null;

  return <>
    {view === "summary" ? <section className="metric-grid report-metric-grid six-metrics" aria-label="Основные показатели продаж">
      <MetricCard icon={<TrendingUp size={18} />} metricId="sales.check-net" label="Выручка после возвратов" value={unavailable ? null : formatMoney(report.summary.revenue)} status={report.summary.checkStatus} coveragePct={report.summary.checkCoveragePct ?? undefined} />
      <MetricCard icon={<Receipt size={18} />} metricId="sales.check-gross" label="Продажи до возвратов" value={unavailable ? null : formatMoney(report.summary.grossRevenue)} status={report.summary.checkStatus} coveragePct={report.summary.checkCoveragePct ?? undefined} />
      <MetricCard icon={<RotateCcw size={18} />} metricId="sales.check-returns" label="Возвраты" value={unavailable ? null : formatMoney(report.summary.returns)} status={report.summary.checkStatus} detail={`${formatNumber(report.summary.returnCount)} возвратных чеков`} />
      <MetricCard icon={<ShoppingCart size={18} />} metricId="sales.net-checks" label="Чистое число чеков" value={unavailable ? null : formatNumber(report.summary.orderCount - report.summary.returnCount)} status={report.summary.checkStatus} coveragePct={report.summary.checkCoveragePct ?? undefined} detail={`${formatNumber(report.summary.orderCount)} продаж · ${formatNumber(report.summary.returnCount)} возвратов`} />
      <MetricCard icon={<CalendarDays size={18} />} metricId="sales.avg-check" value={unavailable || report.summary.avgCheck === null ? null : formatMoney(report.summary.avgCheck)} status={report.summary.checkStatus} coveragePct={report.summary.checkCoveragePct ?? undefined} />
      <MetricCard icon={<Package size={18} />} metricId="sales.avg-items-per-check" label="Количество на чек" value={unavailable ? null : formatDecimal(report.summary.avgItemsPerCheck, 2)} status={report.summary.checkStatus} />
    </section> : null}
    {unavailable ? <p className="availability-summary">За выбранный период нет загруженных чеков. Это не означает нулевые продажи.</p> : report.summary.checkStatus === "partial" ? <p className="metric-note warning">
      Есть чеки за {formatNumber(report.summary.coveredDays)} из {formatDecimal(report.summary.expectedDays ?? 0)} прошедших дней периода. Показатели рассчитаны по доступным данным и могут быть неполными.
    </p> : null}

    {view === "summary" ? <>
      <section className="panel report-chart-panel">
        <div className="panel-title"><h2><MetricLabel metricId="sales.check-net">Как менялся чековый оборот</MetricLabel></h2></div>
        <div className="chart-wrap compact">
          {report.revenueSeries.length ? <ResponsiveContainer width="100%" height={260}>
            <BarChart data={report.revenueSeries}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="bucket" tickFormatter={(value) => formatBucket(String(value), period)} minTickGap={18} />
              <YAxis tickFormatter={formatMoneyCompact} width={78} />
              <Tooltip labelFormatter={(value) => formatBucket(String(value), period)} formatter={(value) => [formatMoney(Number(value)), "Выручка по чекам"]} labelStyle={{ color: "#172033" }} />
              <Bar dataKey="revenue" fill="#2864d8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer> : <div className="empty-state inset">Нет данных для графика за выбранный период</div>}
        </div>
      </section>
      <details className="report-disclosure">
        <summary>Как читать график выручки</summary>
        <p className="context-note">Чековый оборот: сумма проведённых чеков минус сумма возвратных чеков. Это заголовочные суммы чеков, а не строки товаров. Средний чек по справочнику считается иначе: чистая выручка проведённых отчётов розницы минус возвраты, делённая на чеки продажи минус чеки возврата. Расчёт среднего чека подавляется, если чеки ИЛИ отчёты розницы покрывают менее 90% календарных дней в выбранном периоде (это правило публикации приложения, не порог справочника), либо чистое число чеков неположительное. Даты на экране включительны, а API фильтрует от даты «с» до полуночи после даты «по»: <code>date &gt;= from AND date &lt; toExclusive</code>. Отсутствие загруженных чеков в дате нельзя считать нулём продаж.</p>
        <p className="context-note">Ось X — дата начала корзины дня, недели или месяца по дате чека; ось Y и подсказка — чистая сумма заголовков в ₸. Столбец — сумма всей корзины, не среднее на день и не официальный средний чек; K/«тыс.» и «млн» сокращают только масштаб подписи. Даты без загруженных чеков не создают доказанные нулевые столбцы, возвратная корзина может иметь отрицательный оборот.</p>
      </details>
      <details className="report-disclosure">
        <summary>Почему продажи и доходность могут отличаться</summary>
        <p className="context-note">Разница = чистая сумма заголовков чеков − чистая сумма заголовков розничных отчётов (в том числе поля возвратов отчёта). Это сверка источников, не прибыль. Она доступна, если найден хотя бы один подходящий чек, включая возвратный, и число дней с отчётами составляет не менее 80% числа дней с такими чеками. Сравниваются количества дней, не доказанное пересечение дат (технический порог приложения, не норматив справочника). «Загружено чеков» — проведённые неудалённые документы с ненулевой заголовочной суммой, включая возвратные. «Связаны» — их доля с заполненной непустой ссылкой на розничный отчёт; это ещё не подтверждение существования связанного документа в загрузке. Счётчик розничных отчётов — число разных непустых ссылок в этих чеках, не число всех отчётов базы. Дни с отчётами и периоды графика — наблюдаемые календарные даты и группы соответственно; полноту загрузки они не доказывают.</p>
        <div className="stack-list">
          <div className="summary-row"><strong>Загружено чеков</strong><span>{formatNumber(report.reconciliation.loadedCheckCount)}</span></div>
          <div className="summary-row"><strong>Связаны с розничными отчетами</strong><span>{formatDecimal(report.reconciliation.linkedCheckPct, 1)}%</span></div>
          <div className="summary-row"><strong>Розничных отчётов, указанных в чеках</strong><span>{formatNumber(report.summary.reportCount)}</span></div>
          <div className="summary-row"><strong>Разница выручки</strong><span>{report.reconciliation.difference === null ? "Нет данных для сравнения" : formatMoney(report.reconciliation.difference)}</span></div>
          <div className="summary-row"><strong>Дней с розничными отчетами</strong><span>{formatNumber(report.reconciliation.retailReportDays)}</span></div>
          <div className="summary-row"><strong>Периодов на графике</strong><span>{formatNumber(report.revenueSeries.length)}</span></div>
        </div>
      </details>
    </> : null}

    {view === "products" ? <section className="panel">
      <details className="report-disclosure">
        <summary>Как читать состав чеков</summary>
        <p className="context-note">Показаны до 30 товаров, отсортированных по сумме строк после возвратов. Количество и сумма берутся из строк «Товары» чека; возвратные строки и количество записываются со знаком минус. «Чеки» — число уникальных чеков продажи с этим товаром; один чек с несколькими товарами входит в несколько строк. «Доля чеков» делит этот счётчик товара на все чеки продажи, поэтому доли товаров могут складываться более чем в 100 %. Сумма строк товара может не совпадать с суммой заголовков чека; сверка показана отдельно.</p>
      </details>
      <div className="panel-title"><h2>Какие товары покупают</h2><span>Доля продажных чеков с товаром; доли могут пересекаться.</span></div>
      <div className="data-table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Товар</th><th scope="col" className="num"><MetricLabel metricId="sales.item-quantity">Количество</MetricLabel></th><th scope="col" className="num"><MetricLabel metricId="sales.item-checks">Чеки</MetricLabel></th><th scope="col" className="num"><MetricLabel metricId="sales.item-check-share">Доля чеков</MetricLabel></th><th scope="col" className="num"><MetricLabel metricId="sales.item-revenue">Выручка после возвратов</MetricLabel></th></tr></thead>
        <tbody>{report.composition.map((row) => <tr key={row.itemKey}>
          <td>{row.itemName}</td><td className="num">{formatDecimal(row.quantity, 2)}</td><td className="num">{formatNumber(row.checkCount)}</td><td className="num">{formatDecimal(row.checkSharePct, 1)}%</td><td className="num">{formatMoney(row.revenue)}</td>
        </tr>)}</tbody>
      </table></div>
    </section> : null}

    {view === "activity" ? <section className="panel">
      <div className="panel-title"><h2>Когда покупают</h2><span>Сравните магазины по часам выбранного дня недели.</span></div>
      <div className="view-switcher">
        <div className="segmented-control" role="group" aria-label="Показатель активности">
          <button type="button" className={heatmapMetric === "checks" ? "active" : ""} aria-pressed={heatmapMetric === "checks"} onClick={() => setHeatmapMetric("checks")}>Чеки</button>
          <button type="button" className={heatmapMetric === "revenue" ? "active" : ""} aria-pressed={heatmapMetric === "revenue"} onClick={() => setHeatmapMetric("revenue")}>Выручка</button>
        </div>
        <div className="weekday-selector" role="group" aria-label="День недели">
          {heatmapWeekdays.map((weekday) => <button key={weekday.key} className={activeWeekday?.value === weekday.value ? "active" : ""} aria-pressed={activeWeekday?.value === weekday.value} type="button" onClick={() => setSelectedWeekday(weekday.value)} title={weekday.title}>{weekday.label}</button>)}
        </div>
      </div>
      {activeWeekday ? <SalesHeatmap report={report} metric={heatmapMetric} weekday={activeWeekday.value} weekdayLabel={activeWeekday.label} /> : <div className="empty-state inset">Нет данных для выбранного времени</div>}
      <details className="report-disclosure">
        <summary>Как читать тепловую карту активности</summary>
        <p className="context-note">Строка — торговая точка, столбец — час по времени чека; фильтры выбирают день недели и число продажных чеков либо деньги. Ячейка суммирует значения за выбранные дни недели внутри всего выбранного интервала, а не среднее за четыре недели. Число чеков исключает возвраты; деньги учитывают суммы продаж минус возвраты. Интенсивность цвета равна значению ячейки, делённому на максимум по всем показанным точкам и часам (максимум = 100%). Это внутриграфиковое сравнение; справочник §6.3 требует среднее по четырём неделям, которого здесь пока нет.</p>
      </details>
    </section> : null}
  </>;
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
            ? `Чистый чековый оборот за выбранные даты недели ${weekdayLabel.toLowerCase()} по часам: продажные суммы минус возвратные.`
            : `Количество продажных чеков за выбранные даты недели ${weekdayLabel.toLowerCase()} по часам; возвратные чеки в счётчик не входят.`}
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

function IncomeReports({ dateRange }: { dateRange: DateRangeValue }) {
  const [period, setPeriod] = useState<SalesPeriod>("day");
  const [view, setView] = useState("summary");
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
      {view === "summary" ? <div className="report-toolbar">
        <SeriesGrouping period={period} onChange={setPeriod} label="Динамика доходности" />
      </div> : null}

      {reportState.status === "loading" ? (
        <div className="empty-state">Загружаем отчет о доходе</div>
      ) : null}

      {reportState.status === "error" ? (
        <div className="empty-state">{reportState.error}</div>
      ) : null}

      {reportState.status === "success" ? (
        <IncomeReportBody report={reportState.data} period={period} view={view} onViewChange={setView} />
      ) : null}
    </section>
  );
}

function IncomeReportBody({
  report,
  period,
  view,
  onViewChange
}: {
  report: IncomeReport;
  period: SalesPeriod;
  view: string;
  onViewChange: (view: string) => void;
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
  const [selectedStore, setSelectedStore] = useState("");
  const [showAllStoreItems, setShowAllStoreItems] = useState(false);
  const selectedStoreGroup = storeItemGroups.find(([key]) => key === selectedStore) ?? storeItemGroups[0];
  // An empty retail-report window means the figures are unknown, not zero.
  const noSalesRows = report.summary.dateFrom === null;

  return (
    <>
      <div className="report-toolbar">
        <label>Показать
          <select value={view} onChange={(event) => onViewChange(event.target.value)}>
            <option value="summary">Результат и динамика</option>
            <option value="stores">Сравнение магазинов</option>
            <option value="items">Доходность товаров</option>
            <option value="store-items">Товары в выбранном магазине</option>
          </select>
        </label>
      </div>
      {noSalesRows ? (
        <div className="metric-note warning">
          В выбранном интервале нет строк отчётов розницы: выручка, стоимость проданного и прибыльность неизвестны, а не равны нулю. Потери из отдельных документов показываются независимо. Периоды дат в ответе относятся только к найденным строкам продаж; отсутствие строк не доказывает отсутствие фактических продаж при неполной загрузке отчётов.
        </div>
      ) : null}
      {!noSalesRows ? <p className="context-note">Даты начала и конца относятся к найденным строкам розничных продаж, а не к диапазону документов потерь. Даты без строк не считаются нулевыми продажами.</p> : null}
      {view === "summary" ? (
      <section className="metric-grid report-metric-grid six-metrics" aria-label="Метрики дохода">
        <MetricCard
          icon={<Receipt size={18} />}
          metricId="income.revenue"
          label="Чистая выручка"
          value={noSalesRows ? null : formatMoney(report.summary.revenue)}
        />
        <MetricCard
          icon={<ShoppingCart size={18} />}
          metricId="income.cost"
          label="Оценочная стоимость проданного"
          value={noSalesRows ? null : formatMoney(report.summary.cost)}
        />
        <MetricCard
          icon={<Package size={18} />}
          metricId="income.losses"
          label="Потери: списания и недостачи − излишки"
          value={formatMoney(report.summary.losses)}
        />
        <MetricCard
          icon={<TrendingUp size={18} />}
          metricId="income.profit-after-loss"
          status={noSalesRows ? "partial" : report.summary.unvaluedRevenue > 0 ? "partial" : "ready"}
          coveragePct={report.summary.costCoveragePct}
          label="Валовая прибыль после потерь"
          value={noSalesRows ? null : formatMoney(report.summary.grossProfitAfterLoss)}
        />
        <MetricCard
          icon={<BarChart3 size={18} />}
          metricId="income.margin-after-loss"
          status={noSalesRows ? "unavailable" : report.summary.unvaluedRevenue > 0 ? "partial" : "ready"}
          label="Маржа после потерь"
          value={noSalesRows || report.summary.marginAfterLossPct === null ? null : `${formatDecimal(report.summary.marginAfterLossPct, 1)}%`}
        />
        <MetricCard
          icon={<ShieldCheck size={18} />}
          metricId="income.cost-coverage"
          label="Покрытие себестоимости"
          value={noSalesRows ? null : `${formatDecimal(report.summary.costCoveragePct, 1)}%`}
          detail={noSalesRows ? undefined : `Без оценки цены: ${formatMoney(report.summary.unvaluedRevenue)}`}
        />
      </section>
      ) : null}
      <div className="metric-note warning">
        Потери вычтены (списания и недостачи ревизий минус оприходования и излишки). Отчётные суммы сохранены с НДС, который уже включён в цену; НДС не вычитался. Справочник требует выручку P&amp;L без НДС — это известное отличие, а не подтверждение соответствия. Внутренняя наценка между ИП также не устранена. Результаты остаются оценочными при неполном покрытии себестоимости.
      </div>
      <details className="report-disclosure">
        <summary>Полная формула, источники и отличия от справочника</summary>
        <div className="stack-list">
          <p>Период фильтруется полуоткрыто: дата документа ≥ начала выбранного интервала и &lt; полуночи после включительной даты «по». Продажи и возвраты берутся из строк проведённых отчётов розничных продаж: сумма строк продажи − сумма возвращённых товарных строк. Это построчная чистая выручка; она может отличаться от заголовочных сумм документов, используемых сверкой и средним чеком в разделе «Продажи». Записанные суммы включают НДС в цене по подтверждению владельца; вычет НДС не рассчитан, хотя справочник требует P&amp;L без НДС.</p>
          <p>Оценочная стоимость проданного = сумма количества строки × доступная цена единицы. Приоритет: активный регистр точки → проведённая установка себестоимости этой точки → последняя установка товара, найденная среди точек → средневзвешенная сумма поступлений за 90 дней (с вычетом записанного НДС строк). Все источники ограничены датой строго до конца выбранного интервала: period &lt; to для регистра, date &lt; to для документов; активность регистра — active IS NOT FALSE. Полученная цена применяется ко всем продажам окна, а не на каждую дату продажи. «Глобальная» установка может быть записью другой точки. Расходники (стаканы/крышки/лента/CO₂) автоматически не исключаются: §6.4 требует исключение, но подтверждённой классификации нет. Неизвестная цена не является доверенной нулевой стоимостью; сумма таких строк показана покрытием. Недостающие значения 1С попадут в отчёт после синхронизации.</p>
          <p>Прибыль до потерь = построчная выручка − оценочная себестоимость. Потери = списания + недостачи − оприходования − излишки. Для пересчёта используется денежная разница summa_fakt − coalesce(summa, 0), не разница количеств; отрицательная разница — недостача, положительная — излишек. Для пары документ/товар выбирается последняя строка line_number; при других измерениях повторные строки не суммируются. Документы должны быть проведены и без пометки удаления. Прибыль после потерь = прибыль до потерь − потери. Маржа после потерь = прибыль после потерь ÷ выручка × 100, только если выручка &gt; 0; при нуле или отрицательной выручке маржа не определена. Итоговую прибыль по товарам и точкам нельзя получить сложением процентных марж.</p>
          <p>Потери не распределяются по товарам: прибыль/маржа товарной таблицы остаются до потерь. Поля dokument_osnovanie / dokument_osnovanie_type документов корректировки и dokument_osnovanie_key пересчёта могут указывать на общий приказ инвентаризации; такие связи в базе обнаружены, но расчёт потерь их не использует. Равенство суммы само по себе не доказывает, какую строку и дату нужно исключить: повторный учёт остаётся риском, а сумма потерь — непроверенным учётным результатом. Это валовой результат, не чистая прибыль: ФОТ, аренда, налоги, банковские расходы и внутренняя наценка не вычитаются.</p>
          <p>Справочник требует исключить НДС, внутреннюю наценку и расходники из товарной себестоимости; эти исключения не выполнены. Календарный момент для исторической цены не установлен однозначно: сейчас используется последняя цена до конца окна для всех его продаж. Норма маржи точки относительно медианы сети −2/−5 процентных пунктов пока не рассчитана как статус. До подтверждённой политики цены/классификация не менялись; покрытие и эти различия нужно читать вместе с суммой прибыли.</p>
        </div>
      </details>

      {view === "summary" ? (
      <div className="reports-grid">
        <section className="panel report-chart-panel">
          <div className="panel-title">
            <h3><MetricLabel metricId="income.profit-after-loss">Валовая прибыль после потерь по периодам</MetricLabel></h3>
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
                    formatter={(value, name) => [formatMoney(Number(value)), String(name)]}
                    labelStyle={{ color: "#172033" }}
                  />
                  <Legend />
                  <Bar dataKey="revenue" name="Выручка" fill="#2864d8" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="cost" name="Себестоимость" fill="#e07b5a" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="losses" name="Потери" fill="#b54708" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="grossProfitAfterLoss" name="Прибыль после потерь" fill="#22815f" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state inset">Нет данных о доходе за выбранный период</div>
            )}
          </div>
          <details className="report-disclosure">
            <summary>Как рассчитаны столбцы прибыли по периодам</summary>
            <p className="context-note">Ось X — день, неделя или месяц по дате документа розничного отчёта. Ось Y — сумма в ₸: синее = построчная выручка; оранжевое = оценочная себестоимость найденных строк; коричневое = чистые потери (может быть отрицательным, когда излишки превышают списания); зелёное = выручка − стоимость − потери. Столбцы — суммы за корзину периода, не среднее на день и не денежный поток. Неизвестная себестоимость не является доказанным нулём; покрытие и оценочный статус вынесены выше.</p>
            <p className="context-note">Дата корзины потерь определяется отдельно по дате документа списания, оприходования или пересчёта. Корзина только с потерями тоже попадает на график: её технические 0 выручки/стоимости не доказывают отсутствие торговли. Начало недельной/месячной корзины может находиться раньше выбранной даты «с», но суммы включают только документы внутри окна.</p>
          </details>
        </section>

        <section className="panel report-side-panel">
          <div className="panel-title">
            <h3><MetricLabel metricId="income.margin-after-loss">Маржа после потерь по периодам</MetricLabel></h3>
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
                  <Legend />
                  <Line
                    name="Маржа после потерь"
                    type="monotone"
                    dataKey="marginAfterLossPct"
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
          <details className="report-disclosure">
            <summary>Как рассчитана линия маржи</summary>
            <p className="context-note">Точка периода = (выручка за период − оценочная себестоимость − чистые потери) ÷ выручка за период × 100. Это отношение сумм периода, а не среднее процентов товаров/точек. При нулевой или отрицательной выручке маржа не определена и линия должна иметь разрыв; пропуск не означает 0%. НДС в цене и внутренняя наценка остаются, стоимость берётся на конец выбранного интервала.</p>
          </details>
        </section>
      </div>
      ) : null}

      {view === "stores" ? (
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
        <details className="report-disclosure">
          <summary>Как читать сравнение магазинов</summary>
          <p className="context-note">Строки отсортированы по построчной выручке из отчётов розницы, от большей к меньшей; по умолчанию показаны первые 15, кнопка раскрывает остальные. Потери берутся отдельно по точке, а прибыль = выручка − известная оценочная стоимость − чистые потери. Магазин, где в загруженных строках нет продаж, может всё равно показывать потери, нулевую строковую выручку/себестоимость и прибыль после потерь ниже нуля; отсутствие строк продаж не доказывает нулевую фактическую торговлю при неполной загрузке. Маржа отсутствует, если выручка ≤ 0. Неоценённая себестоимость строк включается в общий процент покрытия, но на уровне отдельной точки своего процента покрытия здесь нет.</p>
        </details>
        {visibleStores.length > 0 ? (
          <div className="heatmap-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Магазин</th>
                  <th scope="col" className="num"><MetricLabel metricId="income.revenue">Выручка по строкам</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="income.cost">Себестоимость</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="income.losses">Потери</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="income.store-profit-after-loss">Прибыль после потерь</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="income.store-margin-after-loss">Маржа после потерь</MetricLabel></th>
                </tr>
              </thead>
              <tbody>
                {visibleStores.map((store) => (
                  <tr key={store.key}>
                    <td>{store.name}</td>
                    <td className="num">{formatMoney(store.revenue)}</td>
                    <td className="num">{formatMoney(store.cost)}</td>
                    <td className="num">{formatMoney(store.losses)}</td>
                    <td className="num">{formatMoney(store.grossProfitAfterLoss)}</td>
                    <td className="num">{store.marginAfterLossPct === null ? "—" : `${formatDecimal(store.marginAfterLossPct, 1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state inset">Нет данных по магазинам</div>
        )}
      </section>
      ) : null}

      {view === "items" ? (
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
        <details className="report-disclosure">
          <summary>Как читать сводную доходность товаров</summary>
          <p className="context-note">Одна строка объединяет товар по всем точкам; сортировка по чистой построчной выручке по убыванию. Сначала показаны 15 позиций, остальные доступны кнопкой. Количество и сумма учитывают строки возврата со знаком минус; суммарные проценты по товарам не складываются в общую маржу. Прибыль и маржа — до потерь: общие потери не распределяются по товарам. Себестоимость суммирует только известные цены, а в SQL неизвестная цена участвует как ноль; поэтому прибыль/маржа товара могут быть завышены. Для отдельных товарных строк процент покрытия стоимости не возвращается — сверяйте с общим покрытием выше и перечнем «без оценки».</p>
        </details>
        {visibleSummaryItems.length > 0 ? (
          <div className="heatmap-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Товар</th>
                  <th scope="col" className="num"><MetricLabel metricId="income.sold-quantity">Продано</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="income.item-revenue">Выручка по строкам</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="income.item-cost">Известная себестоимость</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="income.item-profit-before-loss">Прибыль до потерь</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="income.item-margin-before-loss">Маржа до потерь</MetricLabel></th>
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
                    <td className="num">{item.marginPct === null ? "—" : `${formatDecimal(item.marginPct, 1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state inset">Нет данных по товарам</div>
        )}
      </section>
      ) : null}

      {view === "store-items" ? <>
        <div className="report-toolbar">
          <label>Магазин
            <select value={selectedStoreGroup?.[0] ?? ""} onChange={(event) => { setSelectedStore(event.target.value); setShowAllStoreItems(false); }}>
              {storeItemGroups.map(([key, rows]) => <option key={key} value={key}>{rows[0]?.storeName ?? "Магазин без названия"}</option>)}
            </select>
          </label>
        </div>
        {(selectedStoreGroup ? [selectedStoreGroup] : []).map(([storeKey, storeItems]) => {
        const storeTotal = storeItems.reduce((s, i) => s + i.revenue, 0);
        return (
          <section key={storeKey} className="panel">
            <div className="panel-title">
              <div>
                <h3>Доходность товаров — {storeItems[0]?.storeName ?? "Магазин без названия"}</h3>
                <span>{formatNumber(storeItems.length)} позиций · {formatMoney(storeTotal)}</span>
              </div>
              {storeItems.length > 30 ? <button type="button" className="chip" onClick={() => setShowAllStoreItems((value) => !value)}>{showAllStoreItems ? "Свернуть" : `Показать все (${formatNumber(storeItems.length)})`}</button> : null}
            </div>
            <details className="report-disclosure">
              <summary>Как читать доходность товара в выбранной точке</summary>
              <p className="context-note">Товарные строки этой точки отсортированы по чистой построчной выручке; по умолчанию видны 30 самых крупных. Выручка, известная себестоимость и прибыль относятся к этой точке и периоду, но потери на товар не распределены: прибыль/маржа до потерь. В строках с отсутствующей ценой себестоимость подставляется как 0 только для арифметики, а не как доказанная нулевая цена; отдельное покрытие для точки/товара не показано. Неоценённые строки могут завышать прибыль и маржу до загрузки себестоимости из 1С.</p>
            </details>
            <div className="heatmap-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Товар</th>
                    <th scope="col" className="num"><MetricLabel metricId="income.sold-quantity">Продано</MetricLabel></th>
                    <th scope="col" className="num"><MetricLabel metricId="income.item-revenue">Выручка по строкам</MetricLabel></th>
                    <th scope="col" className="num"><MetricLabel metricId="income.item-cost">Известная себестоимость</MetricLabel></th>
                    <th scope="col" className="num"><MetricLabel metricId="income.item-profit-before-loss">Прибыль до потерь</MetricLabel></th>
                    <th scope="col" className="num"><MetricLabel metricId="income.item-margin-before-loss">Маржа до потерь</MetricLabel></th>
                  </tr>
                </thead>
                <tbody>
                  {(showAllStoreItems ? storeItems : storeItems.slice(0, 30)).map((item) => (
                    <tr key={item.itemKey}>
                      <td>{item.itemName}</td>
                      <td className="num">{formatDecimal(item.soldQty, 1)}</td>
                      <td className="num">{formatMoney(item.revenue)}</td>
                      <td className="num">{formatMoney(item.cost)}</td>
                      <td className="num">{formatMoney(item.grossProfit)}</td>
                      <td className="num">{item.marginPct === null ? "—" : `${formatDecimal(item.marginPct, 1)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
        {storeItemGroups.length === 0 ? <div className="empty-state">Нет данных о товарах по магазинам</div> : null}
      </> : null}
    </>
  );
}

function MarketingReports({ dateRange, view }: { dateRange: DateRangeValue; view: string }) {
  const period: SalesPeriod = "day";
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

      {state.status === "loading" ? <div className="empty-state">Загружаем маркетинговый отчет</div> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}

      {state.status === "success" ? (
        <MarketingReportBody report={state.data} view={view} />
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

function MarketingReportBody({ report, view }: { report: MarketingReport; view: string }) {
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
      {view === "summary" ? <>
      <section className="metric-grid report-metric-grid six-metrics" aria-label="Метрики маркетинга">
        <MetricCard
          icon={<Megaphone size={18} />}
          metricId="marketing.revenue"
          status="experimental"
          label="Оценка продаж по акциям, до возвратов"
          value={formatMoney(summary.promoRevenue)}
          detail={<MetricLabel metricId="marketing.share">{formatDecimal(summary.promoSharePct, 2)}% положительного заголовочного оборота</MetricLabel>}
        />
        <MetricCard
          icon={<BarChart3 size={18} />}
          metricId="marketing.discount"
          status="experimental"
          label="Скидки по акциям"
          value={formatMoney(summary.promoDiscountAmount)}
          detail={<MetricLabel metricId="marketing.discount-percent">средняя эффективная скидка {formatDecimal(summary.avgDiscountPct, 2)}%</MetricLabel>}
        />
        <MetricCard
          icon={<Package size={18} />}
          metricId="marketing.quantity"
          status="experimental"
          label="Продано единиц по акциям"
          value={formatDecimal(summary.promoQuantity, 0)}
          detail={<><MetricLabel metricId="marketing.items">{formatNumber(summary.promoItemCount)} товаров</MetricLabel>{" · "}<MetricLabel metricId="marketing.lines">{formatNumber(summary.promoLineCount)} строк</MetricLabel></>}
        />
        <MetricCard
          icon={<Receipt size={18} />}
          metricId="marketing.reports"
          label="Отчетов с акциями"
          value={formatNumber(summary.promoReportCount)}
          detail={<MetricLabel metricId="marketing.total-reports">из {formatNumber(summary.totalReports)} положительных отчётов периода</MetricLabel>}
        />
        <MetricCard
          icon={<TrendingUp size={18} />}
          metricId="marketing.return"
          status="experimental"
          label="Выручка на 1 ₸ скидки"
          value={formatDecimal(summary.revenuePerDiscount, 2)}
          detail={<MetricLabel metricId="marketing.avg-report">средний отнесённый отчёт {formatMoney(summary.avgCheck)}</MetricLabel>}
        />
        <MetricCard
          icon={<Store size={18} />}
          metricId="marketing.positive-stores"
          label="Магазинов с положительными продажами акций"
          value={formatNumber(summary.promoStoreCount)}
          detail={<><MetricLabel metricId="marketing.promotions-in-period">акций в периоде: {formatNumber(summary.promotionCount)}</MetricLabel>{" · "}<MetricLabel metricId="marketing.promotion-count">с продажами: {formatNumber(summary.promotionWithSalesCount)}</MetricLabel></>}
        />
      </section>
      </> : null}
      <div className="metric-note warning">
        Продажи по акциям — оценка по магазину, дате, товару и скидке. Возвраты не удалось надежно связать с акциями, поэтому они не вычтены из этих показателей.
      </div>
      <details className="report-disclosure">
        <summary>Точные формулы акций, скидок и счётчиков</summary>
        <div className="stack-list">
          <p>Это атрибуция, не подтверждённый документом факт применения акции и не её прирост продаж. Продажная строка с положительными количеством и базовой ценой сопоставляется с правилом по точке, товару, датам и скидке: (1 − сумма строки ÷ (количество × базовая цена)) × 100 отличается от процента правила не более чем на 0,25 процентного пункта. Отдельного отбора суммы строки &gt; 0 нет; заголовок отчёта должен быть положительным. Возвраты не атрибутируются. Если подходят несколько правил, берётся одно — с большей скидкой, затем по ключу акции; строка не дублируется. Окончание правила сравнивается строго как date &lt; window_end.</p>
          <p>Продажи акции = сумма отнесённых строк; базовая выручка = количество × базовая цена; сумма скидки = max(базовая выручка − продажи акции, 0). Средняя скидка (%) = общая сумма скидки ÷ базовую выручку × 100, не среднее процентов правил. Доля акции (%) = отнесённая выручка ÷ общая выручка подходящих положительных заголовков отчётов × 100. «Без акций» = общая выручка − отнесённая, но сюда входят несопоставленные строки, а не доказанное отсутствие скидки.</p>
          <p>В колонках товара/точки «Макс. скидка, %» — максимальный процент совпавшего правила, не эффективная средняя скидка. Диапазон процентов акции — минимум/максимум этих магазинных максимумов, не минимум/максимум всех товарных процентов. Проценты настроек из экспортируемых условий — отдельная информация, не наблюдавшаяся средняя скидка. Не смешивайте проценты с суммой скидки в ₸.</p>
          <p>Отчёты акции/товара и сетевой счётчик — уникальные документы отчёта розницы, не чеки ККМ. «Средний отнесённый отчёт» = отнесённая выручка ÷ уникальные отчёты соответствующего набора, не официальный средний чек и не клиентская средняя покупка. Один документ с несколькими акциями/товарами повторяется в детальных счётчиках; поле магазинного promoReports также складывает счётчики акций и может повторять документ. Проданные товары — уникальные ключи совпавших строк. Магазины в строке акции — все её совпавшие магазинные ключи, а сетевая карточка считает только магазины с суммарной акционной выручкой &gt; 0. Количество — сумма положительных единиц 1С без физической нормализации; «строк» — отнесённые товарные строки.</p>
          <p>«Выручка на 1 ₸ скидки» = выручка акции ÷ сумма скидки. Это коэффициент оборота, не ROI и не дополнительная прибыль: себестоимость, эффект без акции и возвраты неизвестны. Для нулевого знаменателя эти маркетинговые формулы технически возвращают 0; он не означает доказанную нулевую эффективность. Записанные цены и суммы сохраняют НДС; P&amp;L без НДС здесь не рассчитан.</p>
          <p>«Период» в таблице и отбор акций по пересечению с окном используют даты самого документа document_marketingovaya_aktsiya, не объединённые сроки правил. Акция не пересекается, если её начало ≥ исключённого конца окна или её конец ≤ начала окна; отсутствующая граница не исключает запись. Для сопоставления продажной строки используется другое окно: наибольшее заполненное начало и наименьший заполненный конец правила и документа, обе границы должны быть пригодны. «С продажами» — акции с найденными совпадениями; таблица показывает только их и учитывает фильтр статуса. «Активные сейчас» проверяются на текущую UTC-календарную дату среди акций выбранного периода, не на конец исторического окна. Общие метрики не меняются от фильтра/сортировки таблицы. Первоначально видны 12 акций, 100 строк «акция/точка/товар» или 10 магазинов; кнопка раскрывает весь полученный набор. Общее число магазинов в таблице — магазинные ключи с положительным заголовком розничного отчёта, не все магазины сети. Ассортимент акции — объединение уникальных товаров её условий, не только проданные товары.</p>
        </div>
      </details>

      {view === "promotions" ? (
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
                  <th scope="col" className="expand-cell" />
                  <th scope="col">
                    <button type="button" className="sort-button" onClick={() => toggleSort("name")}>
                      Акция{sortIndicator("name")}
                    </button>
                  </th>
                  <th scope="col">№ документа</th>
                  <th scope="col">
                    <button type="button" className="sort-button" onClick={() => toggleSort("startsOn")}>
                      Период{sortIndicator("startsOn")}
                    </button>
                  </th>
                  <th scope="col">Статус</th>
                  <th scope="col" className="num">
                    <MetricLabel metricId="marketing.rule-discount-percent">
                    <button type="button" className="sort-button" onClick={() => toggleSort("discountPctMax")}>
                      Скидка, %{sortIndicator("discountPctMax")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th scope="col" className="num">
                    <MetricLabel metricId="marketing.stores">
                    <button type="button" className="sort-button" onClick={() => toggleSort("storeCount")}>
                      Магазинов{sortIndicator("storeCount")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th scope="col" className="num">
                    <MetricLabel metricId="marketing.items">
                    <button type="button" className="sort-button" onClick={() => toggleSort("itemCount")}>
                      Продано товаров{sortIndicator("itemCount")}
                    </button>
                    </MetricLabel>
                    {" / "}<MetricLabel metricId="marketing.assortment">В условиях</MetricLabel>
                  </th>
                  <th scope="col" className="num">
                    <MetricLabel metricId="marketing.reports">
                    <button type="button" className="sort-button" onClick={() => toggleSort("reportCount")}>
                      Отчетов{sortIndicator("reportCount")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th scope="col" className="num">
                    <MetricLabel metricId="marketing.quantity">
                    <button type="button" className="sort-button" onClick={() => toggleSort("quantity")}>
                      Кол-во{sortIndicator("quantity")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th scope="col" className="num">
                    <MetricLabel metricId="marketing.revenue">
                    <button type="button" className="sort-button" onClick={() => toggleSort("revenue")}>
                      Выручка{sortIndicator("revenue")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th scope="col" className="num">
                    <MetricLabel metricId="marketing.discount">
                    <button type="button" className="sort-button" onClick={() => toggleSort("discountAmount")}>
                      Скидка ₸{sortIndicator("discountAmount")}
                    </button>
                    </MetricLabel>
                  </th>
                  <th scope="col" className="num">
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
                                    <th scope="col" className="expand-cell" />
                                    <th scope="col">Магазин</th>
                                    <th scope="col" className="num"><MetricLabel metricId="marketing.reports">Отчётов</MetricLabel></th>
                                    <th scope="col" className="num"><MetricLabel metricId="marketing.items">Продано товаров</MetricLabel></th>
                                    <th scope="col" className="num"><MetricLabel metricId="marketing.quantity">Кол-во</MetricLabel></th>
                                    <th scope="col" className="num"><MetricLabel metricId="marketing.revenue">Выручка</MetricLabel></th>
                                    <th scope="col" className="num"><MetricLabel metricId="marketing.discount">Скидка ₸</MetricLabel></th>
                                    <th scope="col" className="num"><MetricLabel metricId="marketing.matched-discount-percent">Макс. скидка, %</MetricLabel></th>
                                    <th scope="col" className="num"><MetricLabel metricId="marketing.avg-report">Средний отнесённый отчёт</MetricLabel></th>
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
                                                      <th scope="col">Номенклатура</th>
                                                      <th scope="col" className="num"><MetricLabel metricId="marketing.reports">Отчётов</MetricLabel></th>
                                                      <th scope="col" className="num"><MetricLabel metricId="marketing.quantity">Кол-во</MetricLabel></th>
                                                      <th scope="col" className="num"><MetricLabel metricId="marketing.price">Цена</MetricLabel></th>
                                                      <th scope="col" className="num"><MetricLabel metricId="marketing.revenue">Выручка</MetricLabel></th>
                                                      <th scope="col" className="num"><MetricLabel metricId="marketing.discount">Скидка ₸</MetricLabel></th>
                                                      <th scope="col" className="num"><MetricLabel metricId="marketing.matched-discount-percent">Макс. скидка, %</MetricLabel></th>
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
      ) : null}

      {view === "stores" ? (
      <section className="panel">
        <div className="panel-title">
          <div>
            <h3>Магазины</h3>
            <span>
              <MetricLabel metricId="marketing.positive-stores">{formatNumber(summary.promoStoreCount)} с положительными продажами акций</MetricLabel>{" · "}{formatNumber(storeRows.length)} с положительными отчётами
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
          Выручка по акциям — сумма отнесённых товарных строк, доля — относительно суммы положительных
          заголовков отчётов магазина до возвратов. Количество и товары относятся только к совпавшим продажам.
        </span>
        {visibleStoreRows.length > 0 ? (
          <div className="heatmap-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Магазин</th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.total-reports">Положительных отчётов</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.total-revenue">Выручка положительных заголовков</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.revenue">Выручка по акциям</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.share">Доля</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.discount">Скидка ₸</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.quantity">Кол-во по акциям</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.items">Товаров по акциям</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.promotion-count">Акций с продажами</MetricLabel></th>
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
      ) : null}

      {view === "items" ? (
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
          Построчная выручка по акциям. «Макс. скидка, %» — максимум совпавших процентов правил, не средняя фактическая скидка и не сумма в ₸.
        </span>
        {visibleItemRows.length > 0 ? (
          <div className="heatmap-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Акция</th>
                  <th scope="col">Магазин</th>
                  <th scope="col">Номенклатура</th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.reports">Отчётов</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.quantity">Кол-во</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.price">Цена</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.revenue">Выручка</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.discount">Скидка ₸</MetricLabel></th>
                  <th scope="col" className="num"><MetricLabel metricId="marketing.matched-discount-percent">Макс. скидка, %</MetricLabel></th>
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
      ) : null}

      {view === "summary" ? <details className="report-disclosure">
        <summary>Другие показатели акций</summary>
        <div className="stack-list">
          <div className="summary-row">
            <strong><MetricLabel metricId="marketing.promotions-in-period">Акций в периоде</MetricLabel></strong>
            <span>
              {formatNumber(summary.promotionCount)}{" · "}<MetricLabel metricId="marketing.active-promotions">активных сейчас {formatNumber(summary.activePromotionCount)}</MetricLabel>{" · "}
              <MetricLabel metricId="marketing.promotion-count">с продажами {formatNumber(summary.promotionWithSalesCount)}</MetricLabel>
            </span>
          </div>
          <div className="summary-row">
            <strong><MetricLabel metricId="marketing.revenue">Выручка по акциям</MetricLabel></strong>
            <span>
              {formatMoney(summary.promoRevenue)}{" · "}<MetricLabel metricId="marketing.share">доля {formatDecimal(summary.promoSharePct, 2)}%</MetricLabel>
            </span>
          </div>
          <div className="summary-row">
            <strong><MetricLabel metricId="marketing.nonpromo-revenue">Выручка без атрибуции акции</MetricLabel></strong>
            <span>{formatMoney(summary.totalRevenue - summary.promoRevenue)}</span>
          </div>
          <div className="summary-row">
            <strong><MetricLabel metricId="marketing.discount">Сумма скидок по акциям</MetricLabel></strong>
            <span>
              {formatMoney(summary.promoDiscountAmount)}{" · "}
              <MetricLabel metricId="marketing.discount-percent">средняя эффективная скидка {formatDecimal(summary.avgDiscountPct, 2)}%</MetricLabel>
            </span>
          </div>
          <div className="summary-row">
            <strong><MetricLabel metricId="marketing.list-revenue">Выручка до скидки</MetricLabel></strong>
            <span>{formatMoney(summary.promoListRevenue)}</span>
          </div>
          <div className="summary-row">
            <strong><MetricLabel metricId="marketing.return">Выручка на 1 ₸ скидки</MetricLabel></strong>
            <span>{formatDecimal(summary.revenuePerDiscount, 2)}</span>
          </div>
          <div className="summary-row">
            <strong><MetricLabel metricId="marketing.reports">Отчётов с акциями</MetricLabel></strong>
            <span>
              {formatNumber(summary.promoReportCount)}{" "}
              <MetricLabel metricId="marketing.total-reports">из {formatNumber(summary.totalReports)}</MetricLabel>
              {summary.totalReports > 0 ? <>
                {" · "}<MetricLabel metricId="marketing.report-share">{formatDecimal((summary.promoReportCount / summary.totalReports) * 100, 2)}%</MetricLabel>
              </> : null}
            </span>
          </div>
          <div className="summary-row">
            <strong><MetricLabel metricId="marketing.avg-report">Средний отнесённый отчёт по акции</MetricLabel></strong>
            <span>{formatMoney(summary.avgCheck)}</span>
          </div>
        </div>
      </details> : null}
    </>
  );
}

function InventoryReports({ dateRange }: { dateRange: DateRangeValue }) {
  const period: SalesPeriod = "day";
  const [state, setState] = useState<LoadState<InventoryReport>>({ status: "loading" });
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [view, setView] = useState("stock");

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
    if (items.length === 0) return <div className="empty-state">В выбранной группе товаров нет</div>;
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
                  <th key={col.key} scope="col" className={col.num ? "num" : ""}>
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
    { key: "stockQty", label: "Остаток", metricId: "inventory.stock-qty", num: true, render: (r) => formatDecimal(r.stockQty, 1) },
    { key: "reservedQty", label: "Резерв", metricId: "inventory.reserved", num: true, render: (r) => formatDecimal(r.reservedQty, 1) },
    { key: "availableQty", label: "Доступно", metricId: "inventory.available", num: true, render: (r) => formatDecimal(r.availableQty, 1) },
    { key: "negativeStockQty", label: "Отриц. остаток", metricId: "inventory.negative", num: true, render: (r) => formatDecimal(r.negativeStockQty, 1) },
    { key: "warehouseCount", label: "Локаций", metricId: "inventory.locations", num: true, render: (r) => formatNumber(r.warehouseCount) },
    { key: "dailySalesRate", label: "Ед./день · 28 дней", metricId: "inventory.quantity-rate", num: true, render: (r) => formatDecimal(r.dailySalesRate, 2) },
    { key: "daysOfStock", label: "Дней запаса", metricId: "inventory.quantity-days", num: true, render: (r) => r.daysOfStock !== null ? formatDecimal(r.daysOfStock, 0) : "—" },
    { key: "depletionDays", label: "Дней до исчерпания", metricId: "inventory.depletion-days", num: true, render: (r) => r.depletionDays !== null ? formatDecimal(r.depletionDays, 0) : "—" },
    { key: "stockCost", label: "Оценённая себест-ть", metricId: "inventory.cost", num: true, render: (r) => r.costAvailable ? formatMoney(r.stockCost) : "Нет стоимости" },
    { key: "daysSinceLastSale", label: "Дней с посл. продажи · 28 дней", metricId: "inventory.days-last-sale", num: true, render: (r) => r.daysSinceLastSale !== null ? formatNumber(r.daysSinceLastSale) : "—" }
  ];

  const shortColumns: ColumnDef<InventoryReport["items"][0]>[] = [
    { key: "name", label: "Товар", render: (r) => r.name },
    { key: "stockQty", label: "Остаток", metricId: "inventory.stock-qty", num: true, render: (r) => formatDecimal(r.stockQty, 1) },
    { key: "reservedQty", label: "Резерв", metricId: "inventory.reserved", num: true, render: (r) => formatDecimal(r.reservedQty, 1) },
    { key: "availableQty", label: "Доступно", metricId: "inventory.available", num: true, render: (r) => formatDecimal(r.availableQty, 1) },
    { key: "stockCost", label: "Оценённая себест-ть", metricId: "inventory.cost", num: true, render: (r) => r.costAvailable ? formatMoney(r.stockCost) : "Нет стоимости" },
    { key: "daysOfStock", label: "Дней запаса", metricId: "inventory.quantity-days", num: true, render: (r) => r.daysOfStock !== null ? formatDecimal(r.daysOfStock, 0) : "—" },
    { key: "daysSinceLastSale", label: "Дней с посл. продажи · 28 дней", metricId: "inventory.days-last-sale", num: true, render: (r) => r.daysSinceLastSale !== null ? formatNumber(r.daysSinceLastSale) : "—" }
  ];

  return (
    <section className="reports-section">
      <p className="context-note">Остатки на конец выбранного периода. Скорость продаж учитывает календарные дни и возвраты.</p>

      {state.status === "loading" ? <div className="empty-state">Загружаем отчет по запасам</div> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}
      {state.status !== "loading" && state.status !== "error" && !report ? (
        <div className="empty-state">Нет данных по запасам</div>
      ) : null}

      {report ? (
        <>
          <div className="report-toolbar">
            <label>Показать товары
              <select value={view} onChange={(event) => setView(event.target.value)}>
                <option value="stock">Все остатки ({formatNumber(report.items.length)})</option>
                <option value="outOfStock">Нет в наличии при спросе ({formatNumber(report.outOfStock.length)})</option>
                <option value="overstock">Запас более 45 дней ({formatNumber(report.overstock.length)})</option>
                <option value="slowMoving">Запас 30–45 дней ({formatNumber(report.slowMoving.length)})</option>
                <option value="dead">Неликвид · окно 28 дней ({formatNumber(report.dead.length)})</option>
              </select>
            </label>
          </div>
          <section className="metric-grid report-metric-grid six-metrics" aria-label="Метрики запасов">
            <MetricCard icon={<Boxes size={18} />} metricId="inventory.items" label="Товаров с остатком" value={formatNumber(report.summary.itemsWithStock)} />
            <MetricCard icon={<ShoppingCart size={18} />} metricId="inventory.cost" label="Оценённый запас, минимум" value={formatMoney(report.summary.totalStockCost)} status={report.summary.unvaluedQty > 0 ? "partial" : "ready"} coveragePct={report.summary.costCoveragePct} asOf={report.summary.stockPeriod} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="inventory.out-of-stock" label="Нет в наличии при спросе" value={formatNumber(report.summary.outOfStockCount)} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="inventory.overstock" label="Запас > 45 дней" value={formatNumber(report.summary.overstockCount)} />
            <MetricCard icon={<RotateCcw size={18} />} metricId="inventory.negative" label="Отрицательный остаток" value={formatDecimal(report.summary.negativeStockQty, 1)} />
            <MetricCard icon={<Package size={18} />} metricId="inventory.unvalued" label="Без стоимости" value={formatDecimal(report.summary.unvaluedQty, 1)} status={report.summary.unvaluedQty > 0 ? "partial" : "ready"} />
          </section>
          <details className="report-disclosure">
            <summary>Как рассчитаны остатки, скорость и категории</summary>
            <div className="stack-list">
              <p>Количество берётся из последнего снимка 1С не позже момента конца отчёта. Суммы по локациям сначала складываются для товара; положительный остаток и резерв ограничиваются нулём после такого сложения. <MetricLabel metricId="inventory.locations">«Локаций»</MetricLabel> = число различных исходных ключей sklad_key в строках этого товара, не количество физических складов или точек. Для позиции, которой нет в снимке, код подставляет поступления минус продажи за всю загруженную историю; у такого расчётного остатка нет отдельной строки снимка и счётчик локаций равен 0. Историчность этого fallback не гарантирована.</p>
              <p>Скорость = чистое количество продажных товарных строк минус возвраты за фиксированные 28 календарных дней перед концом отчёта ÷ 28. Чистые возвраты могут дать отрицательную скорость; дата «с» не меняет это окно. Запас в днях = положительный остаток ÷ положительная дневная скорость; иначе «—». Это количественные дни, не денежные дни сводки точки. Дней до исчерпания использует тот же темп и полный остаток без вычета резерва; это оценка, не подтверждённая дата дефицита.</p>
              <p>Категории применяются в порядке: «нет в наличии при спросе» — остаток ≤ 0 и чистые продажи положительны; «неликвид» — остаток положительный, чистые продажи неположительны и последняя продажа старше 30 дней либо не найдена; иначе «избыточный» — запас строго больше 45 дней, «медленно оборачиваемый» — строго больше 30 и до 45 дней. Это правила приложения; дата последней продажи ищется только в том же 28-дневном окне, поэтому «не найдена» означает «не найдена в окне», а не доказанное отсутствие продаж за всю историю.</p>
              <p>Стоимость = положительный остаток × общесетевая установка себестоимости либо средневзвешенная цена поступлений за 90 дней до конца отчёта; магазинные источники цены Inventory не применяет. Без цены позиция не включается в денежную сумму и показана количеством отдельно. <MetricLabel metricId="inventory.coverage">Покрытие стоимости</MetricLabel> — доля оценённых товарных ключей среди всех ключей с положительным остатком, не доля ₸ или штук. <MetricLabel metricId="inventory.retail-value">Розничная оценка</MetricLabel> использует последнюю ненулевую записанную цену продажной табличной части за всю загруженную историю, не только 28 дней; отдельного отбора цены &gt; 0 нет. Без цены подставляется технический 0. Это не себестоимость и не обязательно исторический прайс выбранного окна.</p>
              <p>Таблица с порогами 30/45 дней и карта «Замороженный запас» — разные показатели. §6.8 требует скорость товара только в дни наличия и указывает процентные границы замороженного запаса, но не конкретное число нормативных дней. В сводке точки используются наблюдения положительного остатка, сгруппированные по моментам снимка; при нескольких снимках за день это не число уникальных дней наличия. Норматив фиксирован на 30 дней для всех товаров. Установка отсутствующей себестоимости улучшит денежную оценку после синхронизации, не меняя количества, скорости или категории товара.</p>
            </div>
          </details>

          {view === "stock" ? renderSection("Остатки", "stock", report.items, stockColumns) : null}
          {view === "outOfStock" ? renderSection("Нет в наличии при подтверждённом спросе", "outOfStock", report.outOfStock, shortColumns) : null}
          {view === "overstock" ? renderSection("Запас более 45 дней", "overstock", report.overstock, shortColumns) : null}
          {view === "slowMoving" ? renderSection("Запас 30–45 дней", "slowMoving", report.slowMoving, shortColumns) : null}
          {view === "dead" ? renderSection("Неликвид по 28-дневной проверке", "dead", report.dead, shortColumns) : null}

          <details className="report-disclosure">
            <summary>Другие показатели запасов</summary>
            <div className="stack-list">
              <div className="summary-row">
                <strong><MetricLabel metricId="inventory.total-items">Всего товаров в анализе</MetricLabel></strong>
                <span>{formatNumber(report.summary.totalItems)}</span>
              </div>
              <div className="summary-row">
                <strong><MetricLabel metricId="inventory.items">Товаров с остатком</MetricLabel></strong>
                <span>{formatNumber(report.summary.itemsWithStock)}</span>
              </div>
              <div className="summary-row">
                <strong>Дата среза остатков</strong>
                <span>{formatDate(report.summary.stockPeriod)}</span>
              </div>
              <div className="summary-row">
                <strong><MetricLabel metricId="inventory.reserved">Зарезервировано</MetricLabel></strong>
                <span>{formatDecimal(report.summary.reservedQty, 1)}</span>
              </div>
              <div className="summary-row">
                <strong><MetricLabel metricId="inventory.cost">Оценённый запас, минимум</MetricLabel></strong>
                <span>{formatMoney(report.summary.totalStockCost)}</span>
              </div>
              <div className="summary-row">
                <strong><MetricLabel metricId="inventory.retail-value">Розничная оценка запаса</MetricLabel></strong>
                <span>{formatMoney(report.summary.totalStockRetail)}</span>
              </div>
              <div className="summary-row">
                <strong><MetricLabel metricId="inventory.out-of-stock">Нет в наличии при спросе</MetricLabel></strong>
                <span>{formatNumber(report.summary.outOfStockCount)}</span>
              </div>
              <div className="summary-row">
                <strong><MetricLabel metricId="inventory.overstock">Избыточный запас (&gt; 45 дней)</MetricLabel></strong>
                <span>{formatNumber(report.summary.overstockCount)}</span>
              </div>
              <div className="summary-row">
                <strong><MetricLabel metricId="inventory.slow">Медленно оборачиваемые</MetricLabel></strong>
                <span>{formatNumber(report.summary.slowMovingCount)}</span>
              </div>
              <div className="summary-row">
                <strong><MetricLabel metricId="inventory.dead">Неликвид</MetricLabel></strong>
                <span>{formatNumber(report.summary.deadCount)}</span>
              </div>
            </div>
          </details>
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
  dead_stock: "Неликвид по данным продаж",
  slow_moving: "Запас 30–45 дней",
  overstock: "Запас более 45 дней"
};

function NomenclatureReports({ dateRange }: { dateRange: DateRangeValue }) {
  const period: SalesPeriod = "day";
  const [state, setState] = useState<LoadState<NomenclatureReport>>({ status: "loading" });
  const [showAllTop, setShowAllTop] = useState(false);
  const [showAllAnti, setShowAllAnti] = useState(false);
  const [showAllVelocity, setShowAllVelocity] = useState(false);
  const [showAllProfit, setShowAllProfit] = useState(false);
  const [showAllLost, setShowAllLost] = useState(false);
  const [showAllExit, setShowAllExit] = useState(false);
  const [view, setView] = useState("actions");

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
      <p className="context-note">Сравнивайте продажи и запас товаров; рекомендации не являются автоматическим решением о выводе из ассортимента.</p>

      {state.status === "loading" ? <div className="empty-state">Загружаем анализ номенклатуры</div> : null}
      {state.status === "error" ? <div className="empty-state">{state.error}</div> : null}

      {report ? (
        <>
          <div className="report-toolbar">
            <label>Задача анализа
              <select value={view} onChange={(event) => setView(event.target.value)}>
                <option value="actions">Товары, требующие решения</option>
                <option value="ranking">Лидеры и антилидеры продаж</option>
                <option value="abc">ABC: вклад в выручку</option>
                <option value="xyz">XYZ: стабильность спроса</option>
                <option value="matrix">Матрица ABC + XYZ</option>
                <option value="age">Новые и давно продаваемые товары</option>
                <option value="velocity">Скорость продажи</option>
                <option value="profit">Доходность товаров</option>
                <option value="no-sales">Дни без продаж</option>
              </select>
            </label>
          </div>
          <section className="metric-grid report-metric-grid" aria-label="Сводка номенклатуры">
            {view !== "actions" ? <>
            <MetricCard icon={<Package size={18} />} metricId="catalog.items" label="Товаров со строками продаж/возвратов" value={formatNumber(items.length)} />
            <MetricCard icon={<CalendarDays size={18} />} metricId="catalog.days" label="Календарных дней" value={formatNumber(report.totalDays)} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="catalog.abc" label="ABC: A-класс" value={formatNumber(abcGroups.A.length)} />
            <MetricCard icon={<BarChart3 size={18} />} metricId="catalog.xyz" label="XYZ: X-класс" value={formatNumber(xyzGroups.X.length)} />
            </> : null}
            {view === "actions" ? <>
            <MetricCard icon={<Boxes size={18} />} metricId="catalog.candidates" label="Кандидаты на действие" value={formatNumber(report.exitSummary.totalItems)} />
            <MetricCard icon={<Package size={18} />} metricId="catalog.candidate-stock" label="Остаток кандидатов" value={formatDecimal(report.exitSummary.stockQty, 1)} />
            <MetricCard icon={<Clock size={18} />} metricId="catalog.no-sales-or-dead" label="Без продаж или неликвид" value={formatNumber(report.exitSummary.noSalesCount + report.exitSummary.deadStockCount)} />
            <MetricCard icon={<TrendingUp size={18} />} metricId="catalog.candidate-cost" label="Оценённая стоимость" value={formatMoneyCompact(report.exitSummary.stockCost)} status={report.exitSummary.unvaluedQty > 0 ? "partial" : "ready"} coveragePct={report.exitSummary.costCoveragePct} />
            </> : null}
          </section>
          <details className="report-disclosure">
            <summary>Формулы номенклатуры, ранжирования и матрицы</summary>
            <div className="stack-list">
              <p>Ранжирование, ABC/XYZ и доходность: товарные строки проведённых отчётов розницы, продажа − возврат за выбранные даты. Каждому товару создаётся строка на каждый календарный день окна; день без загруженной строки подставляется как 0. Поэтому нулевая дневная строка не доказывает отсутствие реального спроса при неполной загрузке. Скорость = чистое количество ÷ календарные дни. «Дни с продажами» = дни с чистым количеством &gt; 0; «без продаж» = все дни − такие дни, в том числе чисто возвратные.</p>
              <p>ABC: для веса отрицательная чистая выручка заменяется на 0, товары сортируются по этому весу, равные — по ключу. Доля = вес товара ÷ сумму весов × 100; накопленная доля считается ПОСЛЕ добавления товара. A: накопленная доля ≤ 80%, B: &gt;80% и ≤95%, C: &gt;95%. Поэтому крупный товар, который пересёк границу, может попасть в следующий класс; надписи 80/15/5 — границы алгоритма, не обещание точной суммы классов. В справочнике §6.9 A/B используются для упущенных продаж, но границы ABC/XYZ в документе не установлены.</p>
              <p>XYZ: CV = выборочное стандартное отклонение дневных чистых количеств (stddev_samp, знаменатель N−1) ÷ среднее количество в день × 100. Для одной даты SQL подставляет техническое 0 отклонения — это не доказанная стабильность. Если среднее ≤ 0, приложение записывает техническое 999 и относит товар к Z; в процентах показывается «Не определён», не наблюдавшиеся «999% колебаний». X: CV ≤10%, Y: &gt;10% и ≤25%, Z: &gt;25%. Матрица ABC+XYZ считает товары в пересечении классов, не выручку: строки A/B/C, столбцы X/Y/Z; сумма ячеек равна числу товаров со строками продаж/возвратов.</p>
              <p>Лидеры отсортированы по неотрицательному ABC-весу; антилидеры — по знаковой чистой выручке по возрастанию. Скорость — по единицам в день по убыванию; доходность — по процентной марже по убыванию, без стоимости идут последними; дни без продаж — по числу таких дней по убыванию. Обычно показаны первые 15 товаров; кнопка раскрывает все. Таблицы классов показывают первые 20 строк класса, а счётчик заголовка — весь класс.</p>
              <p><MetricLabel metricId="catalog.age">Возраст товара</MetricLabel> считается от первой найденной продажи за всю загруженную историю до последнего включённого дня отчёта, а не от создания карточки. Новый: меньше 30 дней либо дата не найдена; обычный: 30–180 включительно; давно продаваемый: больше 180. <MetricLabel metricId="catalog.last-sale">Последняя продажа</MetricLabel> тоже ищется за всю историю и может быть позже исторического конца окна. Разности календарных UTC-дат ограничены нулём: 0 дней при будущей дате не является доказанной продажей на дату отчёта. Цены и прибыль оценены на конец выбранного окна: чистое количество × доступная общесетевая установка/90-дневная цена поступлений. Без цены стоимость, прибыль и маржа = «Нет стоимости»; при выручке ≤0 процент также не определён. Потери не распределяются по товару, НДС и внутренняя наценка не исключаются из результата.</p>
              <p>Кандидаты на действие анализируются отдельно по последнему снимку положительного запаса и календарной скорости выбранного периода. Доступно = max(остаток − резерв, 0); запас в днях = остаток ÷ положительную скорость, иначе «—»; замороженная стоимость = max(остаток − скорость × 30, 0) × цена. Здесь скорость учитывает все календарные дни, не только дни наличия — отличие от §6.8; она ограничена нулём, в отличие от знаковой скорости общей номенклатуры. Последняя положительная продажа/поставка ищется за всю историю и может быть позже выбранного окна. Категории назначаются по порядку: чистое количество ≤ 0 и последняя продажа не найдена/старше 30 дней → неликвид; иначе чистое количество ≤ 0 → без чистых продаж; иначе запас &gt; 45 дней → избыточный; иначе запас &gt; 30 дней → медленно оборачиваемый. Отбор по низкой марже не применяется. «Без продаж или неликвид» — сумма двух непересекающихся категорий; <MetricLabel metricId="catalog.candidate-cost-coverage">ценовое покрытие кандидатов</MetricLabel> — доля товарных ключей с ценой, не доля штук. Таблицы возраста показывают первые 15 товаров категории, счётчик — полную категорию.</p>
            </div>
          </details>
          {view === "actions" ? <>
          <div className="metric-note warning">
            Кандидаты требуют решения закупщика; это не автоматический список вывода товаров.
            <MetricLabel metricId="catalog.candidate-unvalued">Неоценённый остаток: {formatDecimal(report.exitSummary.unvaluedQty, 1)} ед.</MetricLabel>
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
          </> : null}

          {view === "ranking" ? <>
          <ExpandableTable
            title="ТОП продаваемых товаров"
            subtitle={`${formatNumber(topSellers.length)} из ${formatNumber(items.length)}`}
            items={topSellers}
            expanded={showAllTop}
            onToggle={() => setShowAllTop((v) => !v)}
            totalCount={items.length}
            columns={nomenclatureColumns}
          />

          <p className="context-note">Антилидеры — товары с наименьшей чистой выручкой; возвраты могут сделать ее отрицательной.</p>
          <ExpandableTable
            title="Антилидеры"
            subtitle={`${formatNumber(antiLeaders.length)} из ${formatNumber(items.length)}`}
            items={antiLeaders}
            expanded={showAllAnti}
            onToggle={() => setShowAllAnti((v) => !v)}
            totalCount={items.length}
            columns={nomenclatureColumns}
          />
          </> : null}

          {view === "abc" ? (
          <section className="analysis-group">
            <div className="panel-title"><h2><MetricLabel metricId="catalog.abc">ABC: вклад товаров в выручку</MetricLabel></h2><span>по доле в чистой выручке</span></div>
            <div className="reports-grid three-col">
              {(["A", "B", "C"] as const).map((cls) => (
                <div key={cls} className="panel">
                  <div className="panel-title">
                    <strong style={{ color: abcColors[cls] }}>
                      Класс {cls} — {cls === "A" ? "80%" : cls === "B" ? "15%" : "5%"} выручки
                    </strong>
                    <span>{formatNumber(abcGroups[cls].length)} товаров</span>
                  </div>
                  <div className="heatmap-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">Товар</th>
                          <th scope="col" className="num"><MetricLabel metricId="catalog.revenue">Выручка по строкам</MetricLabel></th>
                          <th scope="col" className="num"><MetricLabel metricId="catalog.revenue-share">Доля</MetricLabel></th>
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
          ) : null}

          {view === "xyz" ? (
          <section className="analysis-group">
            <div className="panel-title"><h2><MetricLabel metricId="catalog.xyz">XYZ: стабильность спроса</MetricLabel></h2><span>по колебаниям календарного спроса</span></div>
            <div className="reports-grid three-col">
              {(["X", "Y", "Z"] as const).map((cls) => (
                <div key={cls} className="panel">
                  <div className="panel-title">
                    <strong>{xyzLabels[cls]}</strong>
                    <span>{formatNumber(xyzGroups[cls].length)} товаров</span>
                  </div>
                  <div className="heatmap-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">Товар</th>
                          <th scope="col" className="num"><MetricLabel metricId="catalog.cv">CV, %</MetricLabel></th>
                          <th scope="col" className="num"><MetricLabel metricId="catalog.velocity">Продаж/день</MetricLabel></th>
                        </tr>
                      </thead>
                      <tbody>
                        {xyzGroups[cls].slice(0, 20).map((item) => (
                          <tr key={item.key}>
                            <td>{item.name}</td>
                            <td className="num">{item.qty > 0 ? `${formatDecimal(item.cvPct, 1)}%` : "Не определён"}</td>
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
          ) : null}

          {view === "matrix" ? (
          <section className="panel">
            <div className="panel-title"><h3><MetricLabel metricId="catalog.matrix-cell">ABC+XYZ матрица</MetricLabel></h3><span>количество товаров в каждой ячейке</span></div>
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
          ) : null}

          {view === "age" ? (
          <section className="analysis-group">
            <div className="panel-title"><h2><MetricLabel metricId="catalog.age">Новые и давно продаваемые товары</MetricLabel></h2></div>
            <div className="reports-grid three-col">
              {(["new", "regular", "old"] as const).map((cat) => (
                <div key={cat} className="panel">
                  <div className="panel-title">
                    <strong>{ageLabels[cat]}</strong>
                    <span>{formatNumber(ageGroups[cat].length)} товаров</span>
                  </div>
                  <div className="heatmap-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">Товар</th>
                          <th scope="col" className="num"><MetricLabel metricId="catalog.revenue">Выручка по строкам</MetricLabel></th>
                          <th scope="col" className="num"><MetricLabel metricId="catalog.velocity">Продаж/день</MetricLabel></th>
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
          ) : null}

          {view === "velocity" ? (
          <ExpandableTable
            title="Скорость продажи товара"
            subtitle="единиц в день"
            items={byVelocity}
            expanded={showAllVelocity}
            onToggle={() => setShowAllVelocity((v) => !v)}
            totalCount={items.length}
            columns={[
              { key: "name", label: "Товар", render: (r) => r.name },
              { key: "qty", label: "Продано", metricId: "catalog.quantity", num: true, render: (r) => formatDecimal(r.qty, 1) },
              { key: "salesVelocity", label: "Ед/день", metricId: "catalog.velocity", num: true, render: (r) => formatDecimal(r.salesVelocity, 2) },
              { key: "cvPct", label: "CV, %", metricId: "catalog.cv", num: true, render: (r) => r.qty > 0 ? `${formatDecimal(r.cvPct, 1)}%` : "Не определён" },
              { key: "revenue", label: "Выручка", metricId: "catalog.revenue", num: true, render: (r) => formatMoney(r.revenue) }
            ]}
          />
          ) : null}

          {view === "profit" ? (
          <ExpandableTable
            title="Доходность товара"
            subtitle="по маржинальности"
            items={byProfit}
            expanded={showAllProfit}
            onToggle={() => setShowAllProfit((v) => !v)}
            totalCount={items.length}
            columns={[
              { key: "name", label: "Товар", render: (r) => r.name },
              { key: "marginPct", label: "Маржа", metricId: "catalog.margin", num: true, render: (r) => r.marginPct === null ? (r.cost === null ? "Нет стоимости" : "Не определена") : `${formatDecimal(r.marginPct, 1)}%` },
              { key: "revenue", label: "Чистая выручка", metricId: "catalog.revenue", num: true, render: (r) => formatMoney(r.revenue) },
              { key: "grossProfit", label: "Оценённая прибыль", metricId: "catalog.gross-profit", num: true, render: (r) => r.grossProfit === null ? "Нет стоимости" : formatMoney(r.grossProfit) },
              { key: "cost", label: "Оценённая себест-ть", metricId: "catalog.cost", num: true, render: (r) => r.cost === null ? "Нет стоимости" : formatMoney(r.cost) }
            ]}
          />
          ) : null}

          {view === "no-sales" ? (
          <ExpandableTable
            title="Дни без продаж"
            subtitle="Дни без продаж не показывают сумму упущенной выручки."
            items={lostSales}
            expanded={showAllLost}
            onToggle={() => setShowAllLost((v) => !v)}
            totalCount={items.filter((i) => i.daysWithoutSales > 0).length}
            columns={[
              { key: "name", label: "Товар", render: (r) => r.name },
              { key: "daysWithoutSales", label: "Дней без чистых продаж", metricId: "catalog.days-without-sales", num: true, render: (r) => formatNumber(r.daysWithoutSales) },
              { key: "daysWithSales", label: "Дней с чистыми продажами", metricId: "catalog.days-with-sales", num: true, render: (r) => formatNumber(r.daysWithSales) },
              { key: "lastSaleDate", label: "Последняя продажа · история", metricId: "catalog.last-sale", num: true, render: (r) => formatDate(r.lastSaleDate) },
              { key: "salesVelocity", label: "Ед/день", metricId: "catalog.velocity", num: true, render: (r) => formatDecimal(r.salesVelocity, 2) }
            ]}
          />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

const nomenclatureColumns: ColumnDef<ItemAnalysis>[] = [
  { key: "name", label: "Товар", render: (r: ItemAnalysis) => r.name },
  { key: "qty", label: "Продано", metricId: "catalog.quantity", num: true, render: (r) => formatDecimal(r.qty, 1) },
  { key: "revenue", label: "Чистая выручка", metricId: "catalog.revenue", num: true, render: (r) => formatMoney(r.revenue) },
  { key: "grossProfit", label: "Оценённая прибыль", metricId: "catalog.gross-profit", num: true, render: (r) => r.grossProfit === null ? "Нет стоимости" : formatMoney(r.grossProfit) },
  { key: "marginPct", label: "Маржа", metricId: "catalog.margin", num: true, render: (r) => r.marginPct === null ? (r.cost === null ? "Нет стоимости" : "Не определена") : `${formatDecimal(r.marginPct, 1)}%` },
  { key: "abcClass", label: "ABC", metricId: "catalog.abc", num: true, render: (r) => r.abcClass },
  { key: "xyzClass", label: "XYZ", metricId: "catalog.xyz", num: true, render: (r) => r.xyzClass }
];

const exitProductColumns: ColumnDef<ExitProduct>[] = [
  { key: "name", label: "Товар", render: (r: ExitProduct) => r.name },
  { key: "reason", label: "Причина", render: (r: ExitProduct) => exitReasonLabels[r.reason] },
  { key: "stockQty", label: "Остаток", metricId: "catalog.stock-qty", num: true, render: (r) => formatDecimal(r.stockQty, 1) },
  { key: "recentSoldQty", label: "Продано", metricId: "catalog.candidate-quantity", num: true, render: (r) => formatDecimal(r.recentSoldQty, 1) },
  { key: "dailySalesRate", label: "Ед/день", metricId: "catalog.candidate-daily-rate", num: true, render: (r) => formatDecimal(r.dailySalesRate, 3) },
  {
    key: "daysOfStock",
    label: "Дней запаса",
    metricId: "catalog.days-of-stock",
    num: true,
    render: (r: ExitProduct) => (r.daysOfStock === null ? "—" : formatNumber(Math.round(r.daysOfStock)))
  },
  {
    key: "daysSinceLastSale",
    label: "Дней с последней продажи",
    metricId: "catalog.days-last-sale",
    num: true,
    render: (r: ExitProduct) => (r.daysSinceLastSale === null ? "—" : formatNumber(r.daysSinceLastSale))
  },
  {
    key: "daysSinceLastPurchase",
    label: "Дней с поступления",
    metricId: "catalog.days-last-purchase",
    num: true,
    render: (r: ExitProduct) => (r.daysSinceLastPurchase === null ? "—" : formatNumber(r.daysSinceLastPurchase))
  },
  { key: "stockCost", label: "Оценённая себест-ть", metricId: "catalog.candidate-cost", num: true, render: (r) => r.stockCost === null ? "Нет стоимости" : formatMoney(r.stockCost) },
  { key: "frozenStockCost", label: "Заморожено", metricId: "catalog.candidate-frozen", num: true, render: (r) => r.frozenStockCost === null ? "Нет стоимости" : formatMoney(r.frozenStockCost) },
  { key: "lastSaleDate", label: "Последняя продажа · история", metricId: "catalog.last-sale", num: true, render: (r) => formatDate(r.lastSaleDate) }
];

type ColumnDef<T> = {
  key: string;
  label: string;
  render: (row: T) => string;
} & (
  | { num: true; metricId: MetricId }
  | { num?: false; metricId?: MetricId }
);

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
                <th key={col.key} scope="col" className={col.num ? "num" : ""}>
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
    const controller = new AbortController();
    setProfileState({ status: "loading" });
    setSeries({ status: "idle" });
    api
      .table(tableName, controller.signal)
      .then((profile) => {
        if (controller.signal.aborted) return;
        const firstDate = profile.columns.find((column) => column.isTemporal)?.name ?? "";
        setProfileState({ status: "success", data: profile });
        setDateColumn(firstDate);
        setMetricColumn("");
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setProfileState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось загрузить таблицу"
        });
      });
    return () => controller.abort();
  }, [tableName]);

  useEffect(() => {
    if (!dateColumn) {
      return;
    }

    const controller = new AbortController();
    setSeries({ status: "loading" });
    api
      .timeSeries(tableName, dateColumn, metricColumn || undefined, controller.signal)
      .then((points) => {
        if (!controller.signal.aborted) setSeries({ status: "success", data: points });
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setSeries({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось построить график"
        });
      });
    return () => controller.abort();
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
      <details className="report-disclosure">
        <summary>Как читать диагностический график и числа таблицы</summary>
        <div className="stack-list">
          <p>График — техническая агрегация сырой таблицы без бизнес-фильтров проведения, возвратов, ИП или выбранного общего периода. Ось X = date_trunc('day', выбранное поле даты); записи без даты исключены. Ось Y = COUNT(*) строк в дате либо SUM выбранной числовой колонки. SUM пропускает SQL NULL; пустой результат суммы API превращает в 0. Показаны последние 90 дат, для которых есть строки, в хронологическом порядке — это не обязательно 90 календарных дней и не дневная выручка.</p>
          <p>«Строк, оценка» = статистика PostgreSQL n_live_tup, не точный COUNT. «Размер» = таблица + индексы + TOAST в байтах, отформатированных в КБ/МБ/ГБ. Колонки/числовые/даты — число найденных столбцов соответствующего типа в information_schema. Минимальная/максимальная дата — MIN/MAX непустых значений по всей сырой таблице. avg числовой колонки = сумма всех ненулевых по NULL значений ÷ количество таких значений (нулевые числа включаются); без заполненных значений показывается NULL. Разные колонки могут иметь разные знаменатели.</p>
          <p>Популярное значение = GROUP BY выбранной текстовой/логической колонки и COUNT(*), без строк SQL NULL; выводятся восемь самых частых значений в каждой из доступных целевых колонок. «Пример строк» — LIMIT 25 без сортировки, только первые восемь отображаемых колонок: это произвольная диагностическая выборка, не последние или наиболее важные операции. Поля заголовков/товарных строк не суммируйте между таблицами — это разные уровни детализации.</p>
        </div>
      </details>

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
                  <th key={column.name} scope="col">{column.name}</th>
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
  icon: ReactNode;
  metricId: MetricId;
  label?: string;
  value: string | null;
  detail?: ReactNode;
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
            <th scope="col">Таблица</th>
            <th scope="col" className="num">Строк</th>
            <th scope="col" className="num">Изменений</th>
            <th scope="col">Последнее изменение (UTC)</th>
            <th scope="col" className="num">Давность</th>
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
      <details className="report-disclosure">
        <summary>Как читать даты, порции и свежесть синхронизации</summary>
        <div className="stack-list">
          <p>Запуски/порции — записи ops.sync_runs, а решения и heartbeat — ops.sync_scheduler; они независимы от дат продажи в 1С. Длительность взята из duration_seconds и отображается в секундах/минутах/часах. «Прочитано/записано» — счётчики операции экспорта, не уникальные документы или продажи; повторная загрузка может снова записать существующие строки. Порции — завершённые части / плановые части; код выхода 0 означает успешное завершение процесса, не полную готовность всех финансовых источников.</p>
          <p>Диапазон загрузки и границы порций полуоткрытые [начало, конец): дата конца не включается. Checkpoint до/после — контрольные границы продвижения планировщика, не последняя реальная продажа и не доказательство загрузки чеков/балансов, которые могли не входить в профиль запуска. Месяц глубокой перепроверки — дополнительная повторно прочитанная история, а не отдельная новая выручка.</p>
          <p>В таблице свежести «Строк» = точный COUNT(*) всей таблицы; «Изменений» = COUNT(DISTINCT _loaded_at), число разных меток загрузки, не число обновлённых товаров. Последнее изменение = MAX(_loaded_at), время записанной загрузки UTC; давность = (текущее время − эта метка) ÷ 3600 секунд, округлённая до десятых часа. Отметка «без изменений больше двух суток» включается строго после 48 часов; она не доказывает, что документы 1С в это время менялись.</p>
          <p>Давность последнего запуска считается от started_at, а не от завершения. Heartbeat считают пропавшим, когда с updatedAtUtc прошло больше max(3 × heartbeatSeconds, 180 секунд). Окно обслуживания и следующий запуск читаются из настроек планировщика с указанной часовой зоной; кулдаун — часы запрета повторного обхода окна. Число строк лога — строки текста, не ошибки; детали статуса и команды помогают выяснить, какие источники действительно входили в конкретный запуск.</p>
        </div>
      </details>

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
                  <th scope="col">Начало</th>
                  <th scope="col">Состояние</th>
                  <th scope="col">Режим</th>
                  <th scope="col">Диапазон</th>
                  <th scope="col" className="num">Порции</th>
                  <th scope="col" className="num">Строк (чтение → запись)</th>
                  <th scope="col" className="num">Длительность</th>
                  <th scope="col">Причина</th>
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
