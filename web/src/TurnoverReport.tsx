import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Download } from "lucide-react";
import { api } from "./api";
import type {
  ReportDateRange, TurnoverOption, TurnoverOptions, TurnoverPreview, TurnoverPreviewRow, TurnoverRequest
} from "./api";
import { formatDecimal, formatNumber } from "./format";
import { turnoverCoefficientBand } from "../../api/src/services/turnover-domain";

const DAY_MS = 86_400_000;
const MODE_LABELS: Record<"quantity" | "money", string> = {
  quantity: "Количество",
  money: "Деньги"
};
type SampleMode = keyof typeof MODE_LABELS;
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
  mode: SampleMode; format: ReportFormat; includeNonRetail: boolean; excludeZero: boolean;
};
type PreparedRequest = { valid: true; request: TurnoverRequest } | { valid: false; error: string };
type DownloadState = {
  status: "idle" | "loading" | "success" | "error";
  requestKey?: string; message?: string;
};
type PreviewState =
  | { requestKey: string; status: "loading" }
  | { requestKey: string; status: "success"; report: TurnoverPreview }
  | { requestKey: string; status: "error"; message: string };
const PREVIEW_PAGE_SIZE = 100;
const COEFFICIENT_LABELS = { red: "Плохо", orange: "Средне", green: "Хорошо" } as const;
type PreviewMetrics = Pick<TurnoverPreviewRow,
  "openingQty" | "closingQty" | "averageQty" | "openingCost" | "closingCost" | "averageCost" |
  "periodSales" | "turnoverQty" | "turnoverQtyDays" | "turnoverCost" | "turnoverCostDays"
>;

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
  // The summary format needs distinct first and last weighted columns.
  if (days < (detail ? 1 : 2) || days > 366) {
    return {
      valid: false,
      error: detail
        ? "Выберите от 1 до 366 календарных дней."
        : "Выберите от 2 до 366 календарных дней."
    };
  }
  return {
    valid: true,
    request: {
      from: range.from,
      // Dashboard and all builder controls own inclusive dates. Only the API end is exclusive.
      to: new Date(to + DAY_MS).toISOString().slice(0, 10),
      mode: filters.mode, profile: detail ? "full" : "sample", groupBy: "sku",
      storeScope: filters.includeNonRetail ? "all" : "retail",
      ...(filters.excludeZero ? { excludeZero: true } : {}),
      ...(filters.store.length ? { store: [...filters.store].sort() } : {}),
      ...(filters.warehouse ? { warehouse: filters.warehouse } : {}),
      ...(filters.category.length ? { category: [...filters.category].sort() } : {}),
      ...(filters.brand ? { brand: filters.brand } : {}),
      ...(filters.search.trim() ? { search: filters.search.trim() } : {})
    }
  };
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

function PreviewMetricCells({ metrics, quantity, money, detailed }: {
  metrics: PreviewMetrics; quantity: boolean; money: boolean; detailed: boolean;
}) {
  return <>
    {quantity ? <>
      <td className="turnover-numeric"><PreviewNumber value={metrics.periodSales.quantity} /></td>
      <td className="turnover-numeric"><PreviewNumber value={metrics.closingQty} /></td>
      <CoefficientCell value={metrics.turnoverQty} />
      <td className="turnover-numeric"><PreviewNumber value={metrics.turnoverQtyDays} /></td>
      {detailed ? <>
        <td className="turnover-numeric"><PreviewNumber value={metrics.openingQty} /></td>
        <td className="turnover-numeric"><PreviewNumber value={metrics.averageQty} /></td>
      </> : null}
    </> : null}
    {money ? <>
      <td className="turnover-numeric"><PreviewNumber value={metrics.periodSales.cost} /></td>
      <td className="turnover-numeric"><PreviewNumber value={metrics.closingCost} /></td>
      <CoefficientCell value={metrics.turnoverCost} />
      <td className="turnover-numeric"><PreviewNumber value={metrics.turnoverCostDays} /></td>
      {detailed ? <>
        <td className="turnover-numeric"><PreviewNumber value={metrics.openingCost} /></td>
        <td className="turnover-numeric"><PreviewNumber value={metrics.averageCost} /></td>
        <td className="turnover-numeric"><PreviewNumber value={metrics.periodSales.revenue} /></td>
      </> : null}
    </> : null}
  </>;
}

function PreviewTotal({ total, money = false }: { total: TurnoverPreview["totals"]["overall"]; money?: boolean }) {
  const coefficient = money ? total.turnoverCost : total.turnoverQty;
  const band = turnoverCoefficientBand(coefficient);
  return <div className="turnover-total-block">
    <h4>{money ? "По себестоимости, ₸" : `Количество · ${total.unit ?? "Единица не указана"}`}</h4>
    <dl className="turnover-total-metrics">
      <div><dt>{money ? "Продажи по себестоимости, ₸" : "Продажи с учётом возвратов"}</dt><dd><PreviewNumber value={money ? total.periodSales.cost : total.periodSales.quantity} /></dd></div>
      <div><dt>{money ? "Остаток на конец, ₸" : "Остаток на конец"}</dt><dd><PreviewNumber value={money ? total.closingCost : total.closingQty} /></dd></div>
      <div><dt>Оборотов за период</dt><dd className={band ? `turnover-coefficient-${band}` : undefined}>
        <PreviewNumber value={coefficient} />{band ? <span className="turnover-visually-hidden"> — {COEFFICIENT_LABELS[band]}</span> : null}
      </dd></div>
      <div><dt>Дней на оборот</dt><dd><PreviewNumber value={money ? total.turnoverCostDays : total.turnoverQtyDays} /></dd></div>
    </dl>
  </div>;
}

export function TurnoverPreviewTable({ report, page, onPageChange, detailed = false }: {
  report: TurnoverPreview; page: number; onPageChange: (page: number) => void; detailed?: boolean;
}) {
  const headingId = useId();
  const noteId = useId();
  const quantity = report.params.mode !== "money";
  const money = report.params.mode === "money" || report.params.mode === "both";
  const stores = report.params.profile !== "sample";
  const identityColumns = 1 + Number(stores) + Number(quantity) + Number(detailed);
  const columnCount = identityColumns + (quantity ? detailed ? 6 : 4 : 0) + (money ? detailed ? 7 : 4 : 0);
  const pageCount = Math.max(1, Math.ceil(report.rows.length / PREVIEW_PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const start = currentPage * PREVIEW_PAGE_SIZE;
  const rows = report.rows.slice(start, start + PREVIEW_PAGE_SIZE);
  const period = `${previewDate(report.params.from)} — ${previewDate(report.params.to, true)}`;
  const footer = (label: string, total: TurnoverPreview["totals"]["overall"], key: string, overall = false) =>
    <tr key={key} className={overall ? "turnover-overall-total" : "turnover-unit-total"}>
      <th scope="row" colSpan={identityColumns - Number(quantity)}>{label}</th>
      {quantity ? <td>{total.unit ?? "Единица не указана"}</td> : null}
      <PreviewMetricCells metrics={total} quantity={quantity} money={money} detailed={detailed} />
    </tr>;
  return <section className="turnover-preview-results" aria-labelledby={headingId}>
    <div className="turnover-preview-heading">
      <h3 id={headingId}>Результат</h3>
      <p>{period} · строк: {formatNumber(report.rows.length)} · {stores ? "По магазинам" : "Сводно по товарам"}</p>
    </div>
    {report.coverage.requestedTo ? <p className="turnover-message">
      Период сокращён до последнего проверенного дня. Запрошено по {previewDate(report.coverage.requestedTo, true)} включительно; фактический период: {period}.
    </p> : null}
    {report.rows.length ? <div className="turnover-result-summary" aria-label="Итог по всему отбору">
      <p className="turnover-note">По всему отбору, не только этой странице.</p>
      {quantity ? report.totals.overall.unit !== null
        ? <PreviewTotal total={report.totals.overall} />
        : <>
          <p className="turnover-note">Общий итог количества не рассчитан.{!report.totals.byUnit.length ? " Единица не указана." : " Подытоги по известным единицам:"}</p>
          {report.totals.byUnit.map((total) => <PreviewTotal key={total.unitKey} total={total} />)}
        </> : null}
      {money ? <PreviewTotal total={report.totals.overall} money /> : null}
    </div> : null}
    {report.warnings.length ? <details className="turnover-message turnover-preview-warnings">
      <summary>Подробности проверки ({formatNumber(report.warnings.length)})</summary>
      <ul>{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </details> : null}
    <p className="turnover-note" id={noteId}>—: показатель не рассчитан. Ограничения данных — в подробностях.</p>
    <div className="turnover-preview-scroll" role="region" aria-label="Таблица оборачиваемости" tabIndex={0} aria-describedby={noteId}>
      <table className={`turnover-preview-table${detailed ? " turnover-preview-detailed" : " turnover-preview-compact"}`}>
        <caption>Оборачиваемость за {period} · строк: {formatNumber(report.rows.length)}</caption>
        <thead>
          <tr>
            <th scope="col" rowSpan={2}>Товар</th>
            {detailed ? <th scope="col" rowSpan={2}>SKU / артикул</th> : null}
            {stores ? <th scope="col" rowSpan={2}>Магазин</th> : null}
            {quantity ? <th scope="col" rowSpan={2}>Единица</th> : null}
            {quantity ? <th scope="colgroup" colSpan={detailed ? 6 : 4}>Количество, в единицах товара</th> : null}
            {money ? <><th scope="colgroup" colSpan={detailed ? 6 : 4}>По себестоимости, ₸</th>
              {detailed ? <th scope="col" rowSpan={2}>Розничная выручка, ₸</th> : null}</> : null}
          </tr>
          <tr>
            {quantity ? <>
              <th scope="col">Продажи с учётом возвратов</th><th scope="col">Остаток на конец</th>
              <th scope="col">Оборотов за период</th><th scope="col">Дней на оборот</th>
              {detailed ? <><th scope="col">Остаток на начало</th><th scope="col">Средний запас</th></> : null}
            </> : null}
            {money ? <>
              <th scope="col">Продажи по себестоимости, ₸</th><th scope="col">Остаток на конец, ₸</th>
              <th scope="col">Оборотов за период</th><th scope="col">Дней на оборот</th>
              {detailed ? <><th scope="col">Остаток на начало, ₸</th><th scope="col">Средний запас, ₸</th></> : null}
            </> : null}
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row) => <tr key={row.key}>
            <th scope="row" className="turnover-preview-product">{row.name}</th>
            {detailed ? <td className="turnover-preview-identifiers">
              {row.sku ? <span>SKU: {row.sku}</span> : null}{row.article ? <span>Артикул: {row.article}</span> : null}
            </td> : null}
            {stores ? <td>{row.storeName || "Магазин не определён"}</td> : null}
            {quantity ? <td>{row.unit || "Единица не указана"}</td> : null}
            <PreviewMetricCells metrics={row} quantity={quantity} money={money} detailed={detailed} />
          </tr>) : <tr><td colSpan={columnCount} className="turnover-preview-empty">
            По выбранным условиям товаров нет. Измените отбор и нажмите «Показать отчёт».
          </td></tr>}
        </tbody>
        {report.rows.length ? <tfoot>
          {quantity ? report.totals.byUnit.map((total) => footer(`Итого · ${total.unit ?? "Единица не указана"}`, total, total.unitKey)) : null}
          {footer("ИТОГО", report.totals.overall, "overall", true)}
        </tfoot> : null}
      </table>
    </div>
    {report.rows.length ? <>
      <p className="turnover-note turnover-coefficient-legend">
        Оборотов за период: <span className="turnover-coefficient-red">Плохо — меньше 2</span>;
        {" "}<span className="turnover-coefficient-orange">Средне — от 2 до 3 (не включая 3)</span>;
        {" "}<span className="turnover-coefficient-green">Хорошо — от 3</span>. —: без оценки.
      </p>
      <nav className="turnover-preview-pagination" aria-label="Страницы отчёта">
        <p className="turnover-note" role="status">Страница {currentPage + 1} из {pageCount} · Всего строк: {formatNumber(report.rows.length)}
          {` · ${formatNumber(start + 1)}–${formatNumber(Math.min(start + PREVIEW_PAGE_SIZE, report.rows.length))}`}
        </p>
        <div>
          <button type="button" className="turnover-button" disabled={currentPage === 0} onClick={() => onPageChange(currentPage - 1)}>Предыдущая</button>
          <button type="button" className="turnover-button" disabled={currentPage + 1 >= pageCount} onClick={() => onPageChange(currentPage + 1)}>Следующая</button>
        </div>
      </nav>
    </> : null}
  </section>;
}

export function TurnoverReport({ dateRange, onDateRangeChange }: {
  dateRange: InclusiveDateRange; onDateRangeChange: (range: InclusiveDateRange) => void;
}) {
  const headingId = useId();
  const reportName = useId();
  const formatName = useId();
  const periodHintId = useId();
  const periodErrorId = useId();
  const categoryHintId = useId();
  const previewId = useId();
  const [filters, setFilters] = useState<Filters>({
    store: [], warehouse: "", category: [], brand: "", search: "",
    mode: "quantity", format: "sample", includeNonRetail: false, excludeZero: false
  });
  const [options, setOptions] = useState<TurnoverOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [state, setState] = useState<DownloadState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [previewPage, setPreviewPage] = useState(0);
  const [detailed, setDetailed] = useState(false);
  const previewController = useRef<AbortController | null>(null);
  const prepared = useMemo(() => prepareRequest(dateRange, filters), [dateRange.from, dateRange.to, filters]);
  const requestKey = JSON.stringify(prepared.valid ? prepared.request : {
    ...filters, store: [...filters.store].sort(), category: [...filters.category].sort(),
    search: filters.search.trim(), from: dateRange.from, to: dateRange.to
  });
  const currentState: DownloadState = state.requestKey === requestKey ? state : { status: "idle" };
  const downloading = currentState.status === "loading";
  const currentPreview = previewState?.requestKey === requestKey ? previewState : null;
  const previewing = currentPreview?.status === "loading";

  useEffect(() => () => {
    controller.current?.abort();
    previewController.current?.abort();
  }, []);

  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    setState((previous) => previous.status === "idle" ? previous : { status: "idle" });
    previewController.current?.abort();
    previewController.current = null;
    setPreviewState(null);
    setPreviewPage(0);
    setDetailed(false);
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
    + Number(filters.format === "stores") + Number(filters.includeNonRetail) + Number(filters.excludeZero);
  const selectedFilters = [
    ...(filters.store.length ? [`Магазины: ${selectedNames(filters.store, stores)}`] : []),
    ...(filters.search.trim() ? [`Товар: ${filters.search.trim()}`] : []),
    ...(filters.category.length ? [`Категории: ${selectedNames(filters.category, categories)}`] : []),
    ...(filters.warehouse ? [`Склад: ${selectedNames([filters.warehouse], warehouses)}`] : []),
    ...(filters.brand ? [`Бренд: ${selectedNames([filters.brand], brands)}`] : []),
    ...(filters.format === "stores" ? ["По магазинам"] : []),
    ...(filters.includeNonRetail ? ["Включены офисы и отделы"] : []),
    ...(filters.excludeZero ? ["Нулевые товары исключены"] : [])
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
  async function showReport(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (previewing) return;
    if (!prepared.valid) {
      setPreviewState({ status: "error", requestKey, message: prepared.error });
      return;
    }
    previewController.current?.abort();
    const requestController = new AbortController();
    previewController.current = requestController;
    setPreviewPage(0);
    setPreviewState({ status: "loading", requestKey });
    try {
      const report = await api.turnoverReport({
        ...prepared.request, profile: filters.format === "sample" ? "sample" : "summary"
      }, requestController.signal);
      if (requestController.signal.aborted || previewController.current !== requestController) return;
      setPreviewState({ status: "success", requestKey, report });
    } catch (caught) {
      if (requestController.signal.aborted || previewController.current !== requestController) return;
      setPreviewState({
        status: "error", requestKey,
        message: caught instanceof Error ? caught.message : "Не удалось загрузить отчёт."
      });
    } finally {
      if (previewController.current === requestController) previewController.current = null;
    }
  }

  function cancelPreview() {
    previewController.current?.abort();
    previewController.current = null;
    setPreviewState(null);
  }

  return <section className="reports-section turnover-workspace" aria-labelledby={headingId}>
    <div className="turnover-heading">
      <div><h2 id={headingId}>Оборачиваемость</h2>
        <p className="turnover-intro">Выберите период и товары, чтобы увидеть продажи, остатки и скорость оборота.</p>
      </div>
    </div>

    <form className="turnover-form" noValidate onSubmit={showReport}>
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
            Обе даты включены · {days !== null ? `${formatNumber(days)} дн. · ` : ""}{filters.format === "sample" ? "от 2 до 366 дней" : "от 1 до 366 дней"}.
          </p>
          {!prepared.valid ? <p className="turnover-validation" id={periodErrorId} role="status">{prepared.error}</p> : null}
        </fieldset>

        <fieldset className="turnover-fieldset">
          <legend>Показатели</legend>
          <div className="turnover-report-options">
            {(Object.entries(MODE_LABELS) as [SampleMode, string][]).map(([mode, label]) => <label className="turnover-report-choice" key={mode}>
              <input type="radio" name={reportName} value={mode} checked={filters.mode === mode} aria-labelledby={`${reportName}-${mode}`} onChange={() => update("mode", mode)} />
              <span><strong id={`${reportName}-${mode}`}>{label}</strong></span>
            </label>)}
          </div>
        </fieldset>

        <div className="turnover-filter-grid">
          <div className="turnover-store-filter">
            <CheckboxSelect label="Магазины" values={filters.store} options={stores} allLabel="Вся сеть" searchLabel="Найти магазин" clearLabel="Вся сеть" onChange={updateStores} pending={optionsPending} unavailable={optionsUnavailable} />
          </div>
          <label className="turnover-field turnover-product-search"><span>Товар</span><input type="search" value={filters.search} onChange={(event) => update("search", event.target.value)} placeholder="Название, артикул, код или SKU" /></label>
        </div>

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
            <fieldset className="turnover-fieldset">
              <legend>Детализация</legend>
              <div className="turnover-report-options">
                {([["sample", "Сводно по товарам"], ["stores", "По магазинам"]] as [ReportFormat, string][]).map(([value, label]) => <label className="turnover-report-choice" key={value}>
                  <input type="radio" name={formatName} value={value} checked={filters.format === value} onChange={() => update("format", value)} />
                  <span>{label}</span>
                </label>)}
              </div>
            </fieldset>
            <label className="turnover-check turnover-scope-check">
              <input type="checkbox" checked={filters.includeNonRetail} onChange={(event) => update("includeNonRetail", event.target.checked)} />
              <span>Включать офисы и отделы</span>
            </label>
            <label className="turnover-check turnover-zero-check">
              <input type="checkbox" checked={filters.excludeZero} onChange={(event) => update("excludeZero", event.target.checked)} />
              <span>Исключить нулевые товары</span>
            </label>
            <p className="turnover-note">Только если остаток и продажи равны нулю каждый день периода. Запас без продаж остаётся в отчёте.</p>
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

      <div className="turnover-download-actions" aria-busy={downloading || previewing}>
        <button type="submit" className="turnover-button turnover-primary" disabled={downloading || previewing || !prepared.valid}
          aria-describedby={!prepared.valid ? periodErrorId : undefined} aria-controls={currentPreview ? previewId : undefined}>Показать отчёт</button>
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
    <details className="turnover-methodology">
      <summary>Как считается</summary>
      <p className="turnover-note">Оборотов за период = продажи с учётом возвратов / средний запас. Дней на оборот = календарные дни периода / число оборотов. Денежные показатели рассчитываются по себестоимости; розничная выручка доступна только в подробных столбцах и не используется как числитель.</p>
      <p className="turnover-note">Если выбранный период выходит за пределы доступных данных, фактические даты будут указаны в результате. «Последние 30 дней» — по вчерашний день.</p>
    </details>
    {currentPreview ? <div className="turnover-preview" id={previewId} aria-busy={previewing}>
      {currentPreview.status === "loading" ? <div className="turnover-message">
        <p role="status">Загружаем отчёт… При смене параметров предыдущий запрос отменится.</p>
        <button type="button" className="turnover-button" onClick={cancelPreview}>Отменить загрузку</button>
      </div>
        : currentPreview.status === "error" ? <div className="turnover-message turnover-error" role="alert">
          <strong>Не удалось загрузить отчёт.</strong>
          <button type="button" className="turnover-button" disabled={!prepared.valid} onClick={() => void showReport()}>Повторить</button>
          <details><summary>Подробности ошибки</summary><p>{currentPreview.message}</p></details>
        </div>
          : <>
            <label className="turnover-check turnover-detail-toggle">
              <input type="checkbox" checked={detailed} onChange={(event) => setDetailed(event.target.checked)} />
              <span>Подробные столбцы</span>
            </label>
            <TurnoverPreviewTable report={currentPreview.report} page={previewPage} onPageChange={setPreviewPage} detailed={detailed} />
          </>}
    </div> : null}
  </section>;
}
