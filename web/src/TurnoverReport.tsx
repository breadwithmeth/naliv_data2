import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Download } from "lucide-react";
import { api } from "./api";
import type {
  ReportDateRange, TurnoverOption, TurnoverOptions, TurnoverPreview, TurnoverPreviewRow, TurnoverRequest
} from "./api";
import { formatDecimal, formatNumber } from "./format";
import {
  completeTurnoverReport, hasKnownTurnoverUnit, includeTurnoverRow, turnoverCoefficientBand
} from "../../api/src/services/turnover-domain";
import {
  TURNOVER_IDLE_LABEL, turnoverStandardColumns, turnoverStandardDates, turnoverStandardTotalRows, turnoverStandardValue,
  turnoverUnitDisplayName, turnoverUnitLabels
} from "../../api/src/services/turnover-presentation";
import type { TurnoverStandardColumn } from "../../api/src/services/turnover-presentation";

const DAY_MS = 86_400_000;
type ReportFormat = "sample" | "stores";
type InclusiveDateRange = Required<Pick<ReportDateRange, "from" | "to">>;
const PERIOD_PRESETS = [
  { key: "previous-month", label: "Прошлый месяц" },
  { key: "current-month", label: "Текущий месяц" },
  { key: "last-30-days", label: "Последние 30 дней" },
  { key: "previous-quarter", label: "Прошлый квартал" }
] as const;
type PeriodPreset = typeof PERIOD_PRESETS[number]["key"];
const EMPTY_OPTIONS: TurnoverOption[] = [];
type Filters = {
  store: string[]; warehouse: string; category: string[]; brand: string; search: string;
  format: ReportFormat; includeNonRetail: boolean; excludeZero: boolean; includeIncomplete: boolean;
};
type PreparedRequest = { valid: true; request: TurnoverRequest } | { valid: false; error: string };
type DownloadState = {
  status: "idle" | "loading" | "success" | "error";
  requestKey?: string; message?: string;
};
type PreviewState =
  | { status: "loading" }
  | { status: "success"; report: TurnoverPreview }
  | { status: "error"; message: string };
const PREVIEW_PAGE_SIZE = 100;
const COEFFICIENT_LABELS = { red: "Плохо", orange: "Средне", green: "Хорошо" } as const;
type StandardMetrics = Pick<TurnoverPreviewRow,
  "daily" | "averageQty" | "averageCost" | "periodSales" | "idleStock" |
  "turnoverQty" | "turnoverQtyDays" | "turnoverCost" | "turnoverCostDays"
>;
type GridColumn = { column: TurnoverStandardColumn; label: string; key: string };

function dateNumber(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const number = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(number) && new Date(number).toISOString().slice(0, 10) === value ? number : null;
}
function presetRange(preset: PeriodPreset, now = new Date()): InclusiveDateRange {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const quarter = Math.floor(month / 3) * 3;
  let from: number;
  let to: number;
  switch (preset) {
    case "previous-month":
      from = Date.UTC(year, month - 1, 1);
      to = Date.UTC(year, month, 0);
      break;
    case "current-month":
      from = Date.UTC(year, month, 1);
      to = Date.UTC(year, month + 1, 0);
      break;
    case "last-30-days":
      from = Date.UTC(year, month, day - 30);
      to = Date.UTC(year, month, day - 1);
      break;
    case "previous-quarter":
      from = Date.UTC(year, quarter - 3, 1);
      to = Date.UTC(year, quarter, 0);
      break;
  }
  return { from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10) };
}

function selectedNames(values: string[], options: TurnoverOption[]): string {
  const names = new Map(options.map((option) => [option.key, option.name]));
  return values.map((key) => names.get(key) ?? "Выбранное значение отсутствует в справочнике").join(", ");
}


function prepareRequest(range: InclusiveDateRange, filters: Filters): PreparedRequest {
  const from = dateNumber(range.from);
  const to = dateNumber(range.to);
  if (from === null || to === null) {
    return { valid: false, error: "Укажите обе даты периода." };
  }
  if (to < from) {
    return { valid: false, error: "Дата «По» должна быть не раньше даты «С»." };
  }
  const days = (to - from) / DAY_MS + 1;
  const detail = filters.format === "stores";
  if (days < 2 || days > 366) {
    return { valid: false, error: "Выберите от 2 до 366 календарных дней." };
  }
  return {
    valid: true,
    request: {
      from: range.from,
      // Dashboard and all builder controls own inclusive dates. Only the API end is exclusive.
      to: new Date(to + DAY_MS).toISOString().slice(0, 10),
      mode: "quantity", profile: detail ? "summary" : "sample", groupBy: "sku", sort: "name",
      storeScope: filters.includeNonRetail ? "all" : "retail",
      ...(filters.excludeZero ? { excludeZero: true } : {}),
      includeIncomplete: filters.includeIncomplete,
      ...(filters.store.length ? { store: [...filters.store].sort() } : {}),
      ...(filters.warehouse ? { warehouse: filters.warehouse } : {}),
      ...(filters.category.length ? { category: [...filters.category].sort() } : {}),
      ...(filters.brand ? { brand: filters.brand } : {}),
      ...(filters.search.trim() ? { search: filters.search.trim() } : {})
    }
  };
}

function prepareViewerRequest(search: string): PreparedRequest {
  const params = new URLSearchParams(search);
  return prepareRequest({ from: params.get("from") ?? "", to: params.get("to") ?? "" }, {
    store: params.getAll("store"), warehouse: params.get("warehouse") ?? "",
    category: params.getAll("category"), brand: params.get("brand") ?? "", search: params.get("search") ?? "",
    format: params.get("profile") === "summary" ? "stores" : "sample",
    includeNonRetail: params.get("storeScope") === "all", excludeZero: params.get("excludeZero") === "true",
    includeIncomplete: params.get("includeIncomplete") === "true"
  });
}

function OptionSelect({ label, value, options, disabled, onChange, placeholder = "Все", hint }: {
  label: string; value: string; options: TurnoverOption[]; disabled?: boolean;
  onChange: (value: string) => void; placeholder?: string; hint?: string;
}) {
  const hintId = useId();
  return <label className="turnover-field"><span id={`${hintId}-label`}>{label}</span>
    <select value={value} disabled={disabled} aria-labelledby={`${hintId}-label`} aria-describedby={hint ? hintId : undefined} onChange={(event) => onChange(event.target.value)}>
      <option value="">{placeholder}</option>
      {value && !options.some((option) => option.key === value) ? <option value={value}>Выбранное значение отсутствует в справочнике</option> : null}
      {options.map((option) => <option value={option.key} key={option.key}>{option.name}</option>)}
    </select>
    {hint ? <span className="turnover-note" id={hintId}>{hint}</span> : null}
  </label>;
}

function CheckboxSelect({ label, values, options, allLabel, searchLabel, clearLabel, onChange, pending, unavailable }: {
  label: string; values: string[]; options: TurnoverOption[]; allLabel: string;
  searchLabel: string; clearLabel: string; onChange: (values: string[]) => void;
  pending: boolean; unavailable: boolean;
}) {
  const searchId = useId();
  const [search, setSearch] = useState("");
  const term = search.trim().toLocaleLowerCase("ru-RU");
  const visibleOptions = options.filter((option) => `${option.name} ${option.key}`.toLocaleLowerCase("ru-RU").includes(term));
  return <div className="turnover-multiselect">
    <details className="turnover-selector">
      <summary>{label}<span className="turnover-selection-count">{values.length ? `Выбрано: ${formatNumber(values.length)}` : allLabel}</span></summary>
      <div className="turnover-selector-body">
        <div className="turnover-selector-tools">
          <label className="turnover-field" htmlFor={searchId}><span>{searchLabel}</span>
            <input id={searchId} type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Введите название" disabled={pending || unavailable} />
          </label>
          <button type="button" className="turnover-button turnover-subtle" disabled={!values.length} onClick={() => onChange([])}>{clearLabel}</button>
        </div>
        <fieldset className="turnover-checkbox-fieldset">
          <legend className="turnover-visually-hidden">{label}; без выбора — {allLabel.toLocaleLowerCase("ru-RU")}</legend>
          <div className="turnover-checkbox-list">{visibleOptions.map((option) => <label key={option.key}>
            <input type="checkbox" checked={values.includes(option.key)} onChange={(event) => onChange(
              event.target.checked ? [...values, option.key] : values.filter((key) => key !== option.key)
            )} /><span>{option.name}</span>
          </label>)}</div>
        </fieldset>
        {pending ? <p className="turnover-note" role="status">Загружаем список…</p>
          : unavailable ? <p className="turnover-note">Список недоступен. Повторите загрузку справочников.</p>
          : !options.length ? <p className="turnover-note">Справочник пока пуст. Без выбора — {allLabel.toLocaleLowerCase("ru-RU")}.</p>
          : !visibleOptions.length ? <p className="turnover-note">Ничего не найдено. Измените поиск — выбранные значения сохранятся.</p> : null}
      </div>
    </details>
  </div>;
}
function PreviewNumber({ value }: { value: number | null }) {
  return value !== null && Number.isFinite(value)
    ? <>{formatDecimal(value, 2)}</>
    : <span aria-label="Показатель не рассчитан" title="Показатель не рассчитан"><span aria-hidden="true">—</span><span className="turnover-visually-hidden">Показатель не рассчитан</span></span>;
}

function previewDate(value: string, exclusive = false): string {
  const number = dateNumber(value);
  return number === null ? value : new Date(number - (exclusive ? DAY_MS : 0)).toISOString().slice(0, 10).split("-").reverse().join(".");
}

function CoefficientCell({ value }: { value: number | null }) {
  const band = turnoverCoefficientBand(value);
  return <td className={`turnover-numeric${band ? ` turnover-coefficient-${band}` : ""}`}>
    <PreviewNumber value={value} />{band ? <span className="turnover-visually-hidden"> — {COEFFICIENT_LABELS[band]}</span> : null}
  </td>;
}

function StandardMetricCells({ metrics, columns, periodDays }: {
  metrics: StandardMetrics; columns: readonly GridColumn[]; periodDays: number;
}) {
  return <>{columns.map(({ column, key }) => {
    const value = turnoverStandardValue(metrics, column, "quantity", periodDays);
    if (column.kind === "turnoverDays" && value === null && metrics.idleStock) {
      return <td key={key} className="turnover-idle-label" title="Есть остаток на конец периода, продаж и закупок не было">{TURNOVER_IDLE_LABEL}</td>;
    }
    return column.kind === "coefficient"
      ? <CoefficientCell key={key} value={value} />
      : <td key={key} className={`turnover-numeric${column.kind === "day" ? " turnover-preview-day" : ""}`}><PreviewNumber value={value} /></td>;
  })}</>;
}

type ContextBoundary = { kind: string; top: number; height: number; label: string };

function contextAt(boundaries: readonly ContextBoundary[], edge: number, kind: "store" | "group") {
  // The original is still the label until it starts passing below the pinned stack.
  let start = 0;
  let end = boundaries.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (boundaries[middle].top < edge) start = middle + 1;
    else end = middle;
  }
  const current = boundaries[start - 1];
  // Leave room for the next original boundary instead of covering it with a stale label.
  return current?.kind === kind && (boundaries[start]?.top ?? Infinity) >= edge + current.height ? current : undefined;
}

function PreviewScroll({ showDays, report, children }: {
  showDays: boolean; report: TurnoverPreview; children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState<{ store?: string; group?: string }>({});
  const lastContext = useRef(context);
  useLayoutEffect(() => {
    const scroll = viewport.current;
    const grid = scroll?.querySelector("table");
    const head = grid?.tHead;
    if (!scroll || !grid || !head) return;

    const markers = grid.querySelectorAll<HTMLElement>("[data-turnover-boundary]");
    let all: ContextBoundary[] = [];
    let stores: ContextBoundary[] = [];
    let headHeight = 0;
    let frame: number | null = null;
    let needsMeasure = true;

    const update = () => {
      frame = null;
      if (needsMeasure) {
        needsMeasure = false;
        const origin = scroll.getBoundingClientRect().top + scroll.clientTop - scroll.scrollTop;
        const height = head.getBoundingClientRect().height;
        if (height !== headHeight) {
          headHeight = height;
          scroll.style.setProperty("--turnover-head-height", `${height}px`);
        }
        all = Array.from(markers, (marker) => {
          const rect = marker.getBoundingClientRect();
          const kind = marker.dataset.turnoverBoundary!;
          return { kind, top: rect.top - origin, height: rect.height,
            label: marker.querySelector(".turnover-section-label")?.textContent ?? "" };
        });
        stores = all.filter(({ kind }) => kind === "store" || kind === "overall");
      }
      const edge = scroll.scrollTop + headHeight;
      const store = contextAt(stores, edge, "store");
      const group = contextAt(all, edge + (store?.height ?? 0), "group");
      if (store?.label !== lastContext.current.store || group?.label !== lastContext.current.group) {
        lastContext.current = { store: store?.label, group: group?.label };
        setContext(lastContext.current);
      }
    };

    function schedule() {
      frame ??= requestAnimationFrame(update);
    }
    const observer = new ResizeObserver(() => { needsMeasure = true; schedule(); });
    observer.observe(scroll);
    observer.observe(grid);
    observer.observe(head);
    for (const marker of markers) observer.observe(marker);
    scroll.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [showDays, report]);

  return <div ref={viewport} className="turnover-preview-scroll" role="region"
    aria-label="Таблица оборачиваемости" tabIndex={0}>
    <div className="turnover-preview-sticky" aria-hidden="true">
      {context.store ? <div className="turnover-preview-store"><span className="turnover-section-label">{context.store}</span></div> : null}
      {context.group ? <div className="turnover-preview-group"><span className="turnover-section-label">{context.group}</span></div> : null}
    </div>
    {children}
  </div>;
}

export function TurnoverPreviewTable({ report: source, page, onPageChange }: {
  report: TurnoverPreview; page: number; onPageChange: (page: number) => void;
}) {
  const report = useMemo(() => completeTurnoverReport(source), [source]);
  const [disclosure, setDisclosure] = useState({ source, showDays: false });
  if (disclosure.source !== source) setDisclosure({ source, showDays: false });
  const showDays = disclosure.source === source && disclosure.showDays;
  const tableId = useId();
  const includeIncomplete = Boolean(report.params.includeIncomplete);
  const excludedIncompleteRows = report.excludedIncompleteRows ?? 0;
  const headingId = useId();
  const days = useMemo(() => turnoverStandardDates(report.params.from, report.params.to), [report.params.from, report.params.to]);
  const columns = useMemo(() => turnoverStandardColumns(showDays ? days : []).map((column) => column.kind === "day"
    ? { column, label: column.half ? `${column.label} ½` : column.label, key: `${column.date}:${column.half}` }
    : { column, label: column.label, key: column.kind }
  ), [showDays, days]);
  const columnCount = columns.length + 1;
  const stores = report.params.profile !== "sample";
  const pageCount = Math.max(1, Math.ceil(report.rows.length / PREVIEW_PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const start = currentPage * PREVIEW_PAGE_SIZE;
  const rows = report.rows.slice(start, start + PREVIEW_PAGE_SIZE);
  const storeTotals = new Map(report.totals.byStore.map(total => [total.storeKey, total]));
  const unitLabels = turnoverUnitLabels(report.totals.byUnit);
  const hasUnlabelledQuantityTotal = report.rows.length > 0 && (
    (report.totals.overall.unit === null && !report.totals.byUnit.length) ||
    report.totals.byStore.some(({ total, byUnit }) => total.unit === null && !byUnit.length)
  );
  const period = `${previewDate(report.params.from)} — ${previewDate(report.params.to, true)}`;
  const notices = [
    ...(report.coverage.requestedTo
      ? [`Период сокращён: по ${previewDate(report.params.to, true)} вместо ${previewDate(report.coverage.requestedTo, true)}.`] : []),
    ...(!includeIncomplete && excludedIncompleteRows > 0
      ? [`Исключено строк без полного расчёта: ${formatNumber(excludedIncompleteRows)}.`] : []),
    ...(includeIncomplete && report.rows.some((row) => !includeTurnoverRow(row, report.params))
      ? ["Включены строки без полного расчёта."] : []),
    ...(report.coverage.missingStockDates.length ? [
      `Нет дневных снимков остатков: ${formatNumber(report.coverage.missingStockDates.length)} из ${formatNumber(report.coverage.expectedDays)}.`
    ] : []),
    ...(hasUnlabelledQuantityTotal ? ["Общий итог недоступен: разные или неизвестные единицы."] : [])
  ];
  // The analytical endpoint also describes monetary data, orders and comparisons absent from this view.
  const warnings = report.warnings.filter((warning) => /^(Нельзя подтвердить отсутствие|Фильтрам не соответствуют|Нет снимка точно|Не во все дни выбранного периода|В части дней есть проведённые чеки|У части SKU нет подтверждённой|Итоги исходной выборки не показаны)/.test(warning));
  const footer = (label: string, total: TurnoverPreview["totals"]["overall"], byUnit: TurnoverPreview["totals"]["byUnit"], subtotal = false) =>
    turnoverStandardTotalRows(label, total, byUnit, "quantity", unitLabels).map(({ key, label, row }, index) =>
      <tr key={key ?? label} className="turnover-overall-total" data-turnover-boundary={subtotal && index === 0 ? "subtotal" : undefined}>
        <th scope="row">{label}</th>
        <StandardMetricCells metrics={row} columns={columns} periodDays={days.length} />
      </tr>);
  return <section className="turnover-preview-results" aria-labelledby={headingId}>
    <header className="turnover-preview-toolbar">
      <div className="turnover-preview-heading">
        <h1 id={headingId}>Оборачиваемость</h1>
        <p>{period} · {stores ? "По магазинам" : "Вся сеть"} · строк: {formatNumber(report.rows.length)}</p>
      </div>
      {rows.length ? <button type="button" className="turnover-button" aria-expanded={showDays} aria-controls={tableId}
        onClick={() => setDisclosure({ source, showDays: !showDays })}>
        {showDays ? "Скрыть дни" : `Показать дни (${formatNumber(days.length)})`}
      </button> : null}
    </header>
    {notices.length || warnings.length ? <div className="turnover-preview-notices">
      {notices.length ? <p className="turnover-note" role="status">{notices.join(" ")}</p> : null}
      {warnings.length ? <details className="turnover-preview-warnings">
        <summary>Предупреждения ({formatNumber(warnings.length)})</summary>
        <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      </details> : null}
    </div> : null}
    <PreviewScroll key={currentPage} showDays={showDays} report={report}>
      <table id={tableId} className="turnover-preview-table">
        <caption className="turnover-visually-hidden">Оборачиваемость: количество в единицах товара</caption>
        <thead><tr>
          <th scope="col">Номенклатура</th>
          {columns.map(({ key, label, column }) => <th key={key} scope="col"
            className={column.kind === "day" ? "turnover-preview-date" : undefined}>{label}</th>)}
        </tr></thead>
        <tbody>
          {rows.length ? rows.map((row, index) => {
            const previous = rows[index - 1];
            const newStore = stores && (!previous || previous.storeKey !== row.storeKey);
            const newGroup = !previous || newStore || previous.rootGroupKey !== row.rootGroupKey;
            const next = report.rows[start + index + 1];
            const subtotal = stores && row.storeKey !== next?.storeKey ? storeTotals.get(row.storeKey) : undefined;
            return <Fragment key={row.key}>
              {newStore ? <tr className="turnover-preview-store" data-turnover-boundary="store"><th scope="rowgroup" colSpan={columnCount}>
                <span className="turnover-section-label">{row.storeKey === null ? "Магазин не определён" : row.storeName || "Магазин не определён"}</span>
              </th></tr> : null}
              {newGroup ? <tr className="turnover-preview-group" data-turnover-boundary="group"><th scope="rowgroup" colSpan={columnCount}>
                <span className="turnover-section-label">{row.rootGroupKey === null ? "Без группы" : row.rootGroupName || "Группа без названия"}</span>
              </th></tr> : null}
              <tr>
                <th scope="row" className="turnover-preview-product">{row.name}
                  {hasKnownTurnoverUnit(row.unit) ? <span className="turnover-preview-unit">{turnoverUnitDisplayName(row.unit)}</span> : null}
                </th>
                <StandardMetricCells metrics={row} columns={columns} periodDays={days.length} />
              </tr>
              {subtotal ? footer("ИТОГО по магазину", subtotal.total, subtotal.byUnit, true) : null}
            </Fragment>;
          }) : <tr><td colSpan={columnCount} className="turnover-preview-empty">
            {excludedIncompleteRows > 0 && !includeIncomplete
              ? "Все строки по выбранным условиям исключены: нет полного расчёта. На вкладке с параметрами включите строки без полного расчёта и откройте отчёт снова."
              : "По выбранным условиям товаров нет. Измените отбор на вкладке с параметрами и откройте отчёт снова."}
          </td></tr>}
        </tbody>
        {report.rows.length ? <tfoot aria-label="Итог по всему отбору" data-turnover-boundary="overall">
          {footer("ИТОГО", report.totals.overall, report.totals.byUnit)}
        </tfoot> : null}
      </table>
    </PreviewScroll>
    {pageCount > 1 ? <nav className="turnover-preview-pagination" aria-label="Страницы отчёта">
      <p className="turnover-note" role="status">Страница {currentPage + 1} из {pageCount}
        {` · ${formatNumber(start + 1)}–${formatNumber(Math.min(start + PREVIEW_PAGE_SIZE, report.rows.length))}`}
      </p>
      <div>
        <button type="button" className="turnover-button" disabled={currentPage === 0} onClick={() => onPageChange(currentPage - 1)}>Предыдущая</button>
        <button type="button" className="turnover-button" disabled={currentPage + 1 >= pageCount} onClick={() => onPageChange(currentPage + 1)}>Следующая</button>
      </div>
    </nav> : null}
  </section>;
}

export function TurnoverReportViewer({ search }: { search: string }) {
  const prepared = useMemo(() => prepareViewerRequest(search), [search]);
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const title = document.title;
    document.title = "Оборачиваемость";
    return () => { document.title = title; };
  }, []);

  useEffect(() => {
    if (!prepared.valid) return;
    const controller = new AbortController();
    api.turnoverReport(prepared.request, controller.signal).then((report) => {
      if (!controller.signal.aborted) setState({ status: "success", report });
    }).catch((caught) => {
      if (!controller.signal.aborted) setState({
        status: "error", message: caught instanceof Error ? caught.message : "Не удалось загрузить отчёт."
      });
    });
    return () => controller.abort();
  }, [prepared, attempt]);

  function retry() {
    setPage(0);
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  }

  return <main className="turnover-workspace turnover-viewer">
    {prepared.valid && state.status === "success"
      ? <TurnoverPreviewTable report={state.report} page={page} onPageChange={setPage} />
      : <div className="turnover-viewer-state">
        <h1>Оборачиваемость</h1>
        {!prepared.valid ? <p className="turnover-message turnover-error" role="alert">{prepared.error} Откройте отчёт снова с вкладки параметров.</p>
          : state.status === "error" ? <div className="turnover-message turnover-error" role="alert">
            <strong>Не удалось загрузить отчёт.</strong>
            <p>{state.message}</p>
            <button type="button" className="turnover-button" onClick={retry}>Повторить</button>
          </div>
            : <p className="turnover-note" role="status">Загружаем отчёт…</p>}
      </div>}
  </main>;
}

export function TurnoverReport({ dateRange, onDateRangeChange }: {
  dateRange: InclusiveDateRange; onDateRangeChange: (range: InclusiveDateRange) => void;
}) {
  const headingId = useId();
  const periodHintId = useId();
  const periodErrorId = useId();
  const categoryHintId = useId();
  const [filters, setFilters] = useState<Filters>({
    store: [], warehouse: "", category: [], brand: "", search: "",
    format: "sample", includeNonRetail: false, excludeZero: false, includeIncomplete: false
  });
  const [options, setOptions] = useState<TurnoverOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [state, setState] = useState<DownloadState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const prepared = useMemo(() => prepareRequest(dateRange, filters), [dateRange.from, dateRange.to, filters]);
  const requestKey = JSON.stringify(prepared.valid ? prepared.request : {
    ...filters, store: [...filters.store].sort(), category: [...filters.category].sort(),
    search: filters.search.trim(), from: dateRange.from, to: dateRange.to
  });
  const currentState: DownloadState = state.requestKey === requestKey ? state : { status: "idle" };
  const downloading = currentState.status === "loading";

  useEffect(() => () => {
    controller.current?.abort();
  }, []);

  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    setState((previous) => previous.status === "idle" ? previous : { status: "idle" });
  }, [requestKey]);

  useEffect(() => {
    const requestController = new AbortController();
    setOptionsError(null);
    api.turnoverOptions(requestController.signal).then((data) => {
      if (!requestController.signal.aborted) setOptions(data);
    }).catch((caught) => {
      if (!requestController.signal.aborted) setOptionsError(caught instanceof Error ? caught.message : "Не удалось загрузить справочники.");
    });
    return () => requestController.abort();
  }, [optionsAttempt]);


  const stores = options?.stores ?? EMPTY_OPTIONS;
  const categories = options?.categories ?? EMPTY_OPTIONS;
  const brands = options?.brands ?? EMPTY_OPTIONS;
  const warehouses = (options?.warehouses ?? []).filter((warehouse) => !filters.store.length || warehouse.storeKey === null || filters.store.includes(warehouse.storeKey));
  const optionsPending = !options && !optionsError;
  const optionsUnavailable = !options && !!optionsError;
  const from = dateNumber(dateRange.from);
  const to = dateNumber(dateRange.to);
  const days = from !== null && to !== null && to >= from ? (to - from) / DAY_MS + 1 : null;
  const advancedCount = Number(filters.category.length > 0) + Number(!!filters.warehouse) + Number(!!filters.brand)
    + Number(filters.includeNonRetail) + Number(filters.excludeZero) + Number(filters.includeIncomplete);
  const selectedFilters = [
    ...(filters.store.length ? [`Магазины: ${selectedNames(filters.store, stores)}`] : []),
    ...(filters.search.trim() ? [`Товар: ${filters.search.trim()}`] : []),
    ...(filters.category.length ? [`Категории: ${selectedNames(filters.category, categories)}`] : []),
    ...(filters.warehouse ? [`Склад: ${selectedNames([filters.warehouse], warehouses)}`] : []),
    ...(filters.brand ? [`Бренд: ${selectedNames([filters.brand], brands)}`] : []),
    ...(filters.format === "stores" ? ["По магазинам"] : []),
    ...(filters.includeNonRetail ? ["Включены офисы и отделы"] : []),
    ...(filters.excludeZero ? ["Нулевые товары исключены"] : []),
    ...(filters.includeIncomplete ? ["Включены строки без полного расчёта"] : [])
  ];

  function update<K extends keyof Filters>(key: K, value: Filters[K]) {
    if (!downloading) setFilters((previous) => ({ ...previous, [key]: value }));
  }

  function updateStores(store: string[]) {
    if (!downloading) setFilters((previous) => ({ ...previous, store, warehouse: "" }));
  }

  function updateDates(range: InclusiveDateRange) {
    if (!downloading && (range.from !== dateRange.from || range.to !== dateRange.to)) onDateRangeChange(range);
  }

  async function download() {
    if (downloading) return;
    if (!prepared.valid) { setState({ status: "error", requestKey, message: prepared.error }); return; }
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    setState({ status: "loading", requestKey });
    try {
      const result = await api.turnoverWorkbook(prepared.request, requestController.signal);
      if (requestController.signal.aborted || controller.current !== requestController) return;
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState({ status: "success", requestKey, message: `Файл ${result.filename} скачан.` });
    } catch (caught) {
      if (!requestController.signal.aborted) {
        setState({ status: "error", requestKey, message: caught instanceof Error ? caught.message : "Не удалось сформировать Excel. Повторите выгрузку." });
      }
    } finally {
      if (controller.current === requestController) controller.current = null;
    }
  }

  function cancel() {
    controller.current?.abort();
    controller.current = null;
    setState({ status: "idle" });
  }

  return <section className="reports-section turnover-workspace" aria-labelledby={headingId}>
    <div className="turnover-heading">
      <div><h2 id={headingId}>Оборачиваемость</h2>
      </div>
    </div>

    <form className="turnover-form" action="/reports/turnover" method="get" target="_blank" rel="noopener" noValidate
      onSubmit={(event) => { if (!prepared.valid || downloading) event.preventDefault(); }}>
      {prepared.valid ? Object.entries({ ...prepared.request, to: dateRange.to }).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((entry, index) =>
          <input type="hidden" name={name} value={String(entry)} key={`${name}:${index}`} />)) : null}
      <fieldset className="turnover-configuration" disabled={downloading}>
        <legend className="turnover-visually-hidden">Параметры отчёта</legend>
        <fieldset className="turnover-fieldset" aria-describedby={periodHintId}>
          <legend>Период</legend>
          <div className="turnover-period-inputs">
            <label className="turnover-field"><span>С</span><input type="date" value={dateRange.from} onChange={(event) => updateDates({ ...dateRange, from: event.target.value })} aria-invalid={!prepared.valid} aria-describedby={!prepared.valid ? periodErrorId : undefined} /></label>
            <label className="turnover-field"><span>По включительно</span><input type="date" value={dateRange.to} onChange={(event) => updateDates({ ...dateRange, to: event.target.value })} aria-invalid={!prepared.valid} aria-describedby={!prepared.valid ? periodErrorId : undefined} /></label>
          </div>
          <div className="turnover-presets" aria-label="Быстрый выбор периода">
            {PERIOD_PRESETS.map((preset) => {
              const range = presetRange(preset.key);
              return <button type="button" className="turnover-button turnover-preset" key={preset.key} aria-pressed={dateRange.from === range.from && dateRange.to === range.to} onClick={() => updateDates(presetRange(preset.key))}>{preset.label}</button>;
            })}
          </div>
          <p className="turnover-note" id={periodHintId}>
            Обе даты включены · {days !== null ? `${formatNumber(days)} дн. · ` : ""}от 2 до 366 дней.
          </p>
          {!prepared.valid ? <p className="turnover-validation" id={periodErrorId} role="status">{prepared.error}</p> : null}
        </fieldset>

        <div className="turnover-filter-grid">
          <div className="turnover-store-filter">
            <CheckboxSelect label="Магазины" values={filters.store} options={stores} allLabel="Вся сеть" searchLabel="Найти магазин" clearLabel="Вся сеть" onChange={updateStores} pending={optionsPending} unavailable={optionsUnavailable} />
          </div>
          <label className="turnover-field turnover-product-search"><span>Товар</span><input type="search" value={filters.search} onChange={(event) => update("search", event.target.value)} placeholder="Название, артикул, код или SKU" /></label>
        </div>
        <label className="turnover-check">
          <input type="checkbox" checked={filters.format === "stores"} onChange={(event) => update("format", event.target.checked ? "stores" : "sample")} />
          <span>Разбить по магазинам</span>
        </label>

        <details className="turnover-advanced">
          <summary>Дополнительные настройки{advancedCount ? ` (${advancedCount})` : ""}</summary>
          <div className="turnover-advanced-content">
            <fieldset className="turnover-fieldset" aria-describedby={categoryHintId}>
              <legend className="turnover-visually-hidden">Категории</legend>
              <CheckboxSelect label="Категории / группы товаров" values={filters.category} options={categories} allLabel="Все категории" searchLabel="Найти категорию" clearLabel="Очистить выбор" onChange={(value) => update("category", value)} pending={optionsPending} unavailable={optionsUnavailable} />
              <p className="turnover-note" id={categoryHintId}>Включая вложенные категории; пересечения не дублируют товары.</p>
            </fieldset>
            <div className="turnover-filter-grid">
              <OptionSelect label="Склад" value={filters.warehouse} options={warehouses} disabled={!options} onChange={(value) => update("warehouse", value)} placeholder="Все склады" />
              <OptionSelect label="Бренд" value={filters.brand} options={brands} disabled={!brands.length} onChange={(value) => update("brand", value)} placeholder="Все бренды" />
            </div>
            <label className="turnover-check turnover-scope-check">
              <input type="checkbox" checked={filters.includeNonRetail} onChange={(event) => update("includeNonRetail", event.target.checked)} />
              <span>Включать офисы и отделы</span>
            </label>
            <label className="turnover-check turnover-zero-check">
              <input type="checkbox" checked={filters.excludeZero} onChange={(event) => update("excludeZero", event.target.checked)} />
              <span>Исключить нулевые товары</span>
            </label>
            <label className="turnover-check">
              <input type="checkbox" checked={filters.includeIncomplete} onChange={(event) => update("includeIncomplete", event.target.checked)} />
              <span>Включить строки без полного расчёта</span>
            </label>
            <p className="turnover-note">Нулевой товар — остаток и продажи равны нулю каждый день периода.</p>
          </div>
        </details>

        {selectedFilters.length ? <ul className="turnover-selected" aria-label="Выбранные условия">
          {selectedFilters.map((condition) => <li key={condition}><span>{condition}</span></li>)}
        </ul> : null}
        {optionsError ? <div className="turnover-message turnover-error" role="alert">
          <strong>Не удалось загрузить список магазинов и товаров.</strong>
          <button type="button" className="turnover-button" onClick={() => setOptionsAttempt((attempt) => attempt + 1)}>Повторить</button>
          <details><summary>Подробности ошибки</summary><p>{optionsError}</p></details>
        </div> : null}
      </fieldset>

      <div className="turnover-download-actions" aria-busy={downloading}>
        <button type="submit" className="turnover-button turnover-primary" disabled={downloading || !prepared.valid}
          aria-describedby={!prepared.valid ? periodErrorId : undefined}>Открыть отчёт в новой вкладке</button>
        <button type="button" className="turnover-button" disabled={downloading || !prepared.valid}
          aria-describedby={!prepared.valid ? periodErrorId : undefined} onClick={() => void download()}>
          <Download size={17} aria-hidden="true" />{downloading ? "Формируем Excel…" : "Скачать Excel"}
        </button>
        {downloading ? <>
          <p className="turnover-note" role="status">Формируем файл… Параметры временно недоступны.</p>
          <button type="button" className="turnover-button" onClick={cancel}>Отменить</button>
        </> : null}
      </div>
      {currentState.status === "error" ? <div className="turnover-message turnover-error" role="alert">
        <strong>Не удалось сформировать Excel.</strong>
        <button type="button" className="turnover-button" disabled={!prepared.valid} onClick={() => void download()}>Повторить</button>
        <details><summary>Подробности ошибки</summary><p>{currentState.message}</p></details>
      </div> : null}
      {currentState.status === "success" ? <p className="turnover-message turnover-success" role="status">{currentState.message}</p> : null}
    </form>
  </section>;
}
