import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { Download } from "lucide-react";
import { api, ReportTransfer } from "./api";
import { ReportProgress } from "./ReportProgress";
import type {
  ReportDateRange, TurnoverOption, TurnoverOptions, TurnoverPreview, TurnoverRequest
} from "./api";
import { formatNumber } from "./format";
import { TurnoverPreviewTable } from "./TurnoverPreviewTable";

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
type DownloadState = { status: "idle" } | { status: "loading"; transfer: ReportTransfer } | { status: "success" | "error"; message: string };
type ReportState =
  | { status: "idle" }
  | { status: "loading"; requestKey: string; transfer: ReportTransfer }
  | { status: "error"; requestKey: string; message: string }
  | { status: "ready"; requestKey: string; request: TurnoverRequest; report: TurnoverPreview };

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
function previewDate(value: string, exclusive = false): string {
  const number = dateNumber(value);
  return number === null ? value : new Date(number - (exclusive ? DAY_MS : 0)).toISOString().slice(0, 10).split("-").reverse().join(".");
}

function ReportDialog({ report, period, open, onClose, opener }: {
  report: TurnoverPreview; period: string; open: boolean;
  onClose: () => void; opener: RefObject<HTMLButtonElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const position = useRef({ top: 0, left: 0 });
  const heading = useId();

  useLayoutEffect(() => {
    const surface = dialog.current;
    if (!open || !surface) return;
    const { scrollX, scrollY } = window;
    const trigger = opener.current;
    surface.showModal();
    closeButton.current?.focus({ preventScroll: true });
    const viewport = surface.querySelector<HTMLElement>(".turnover-preview-scroll");
    viewport?.scrollTo(position.current);
    return () => {
      if (viewport) position.current = { top: viewport.scrollTop, left: viewport.scrollLeft };
      surface.close();
      trigger?.focus({ preventScroll: true });
      window.scrollTo(scrollX, scrollY);
    };
  }, [open, opener]);

  return <dialog ref={dialog} className="turnover-dialog" aria-labelledby={heading}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClose={(event) => { if (open && !event.currentTarget.open) onClose(); }}>
    <header className="turnover-dialog-header">
      <div><h2 id={heading}>Оборачиваемость</h2>
        <p>{period}</p>
      </div>
      <button ref={closeButton} type="button" className="turnover-button" onClick={onClose}>Закрыть</button>
    </header>
    <TurnoverPreviewTable report={report} open={open} />
  </dialog>;
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
  const [state, setState] = useState<ReportState>({ status: "idle" });
  const [excel, setExcel] = useState<DownloadState>({ status: "idle" });
  const [view, setView] = useState<"unopened" | "open" | "closed">("unopened");
  const jsonController = useRef<AbortController | null>(null);
  const excelController = useRef<AbortController | null>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const prepared = useMemo(() => prepareRequest(dateRange, filters), [dateRange.from, dateRange.to, filters]);
  const requestKey = JSON.stringify(prepared.valid ? prepared.request : {
    ...filters, store: [...filters.store].sort(), category: [...filters.category].sort(),
    search: filters.search.trim(), from: dateRange.from, to: dateRange.to
  });
  const activeKey = useRef(requestKey);
  const current = state.status !== "idle" && state.requestKey === requestKey ? state : null;
  const ready = current?.status === "ready" ? current : null;
  const downloading = excel.status === "loading";

  useLayoutEffect(() => {
    if (activeKey.current !== requestKey) {
      activeKey.current = requestKey;
      setState({ status: "idle" });
      setExcel({ status: "idle" });
      setView("unopened");
    }
    return () => {
      jsonController.current?.abort();
      excelController.current?.abort();
      jsonController.current = excelController.current = null;
    };
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
    setFilters((previous) => ({ ...previous, [key]: value }));
  }

  function updateStores(store: string[]) {
    setFilters((previous) => ({ ...previous, store, warehouse: "" }));
  }

  function updateDates(range: InclusiveDateRange) {
    if (range.from !== dateRange.from || range.to !== dateRange.to) onDateRangeChange(range);
  }

  async function load() {
    if (!prepared.valid || jsonController.current || ready) return;
    const controller = new AbortController();
    jsonController.current = controller;
    const isCurrent = () => jsonController.current === controller && activeKey.current === requestKey;
    const transfer = new ReportTransfer();
    setState({ status: "loading", requestKey, transfer });
    try {
      const report = await api.turnoverReport(prepared.request, controller.signal, transfer);
      if (isCurrent()) setState({ status: "ready", requestKey, request: prepared.request, report });
    } catch (error) {
      if (isCurrent()) setState({ status: "error", requestKey,
        message: error instanceof Error ? error.message : "Не удалось загрузить отчёт." });
    } finally {
      if (isCurrent()) jsonController.current = null;
    }
  }

  async function download() {
    if (!ready || excelController.current) return;
    const requestController = new AbortController();
    excelController.current = requestController;
    const isCurrent = () => excelController.current === requestController && activeKey.current === ready.requestKey;
    const transfer = new ReportTransfer();
    setExcel({ status: "loading", transfer });
    try {
      const result = await api.turnoverWorkbook(ready.request, requestController.signal, transfer);
      if (!isCurrent()) return;
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExcel({ status: "success", message: `Файл ${result.filename} скачан.` });
    } catch (caught) {
      if (isCurrent()) {
        setExcel({ status: "error", message: caught instanceof Error ? caught.message : "Не удалось сформировать Excel. Повторите выгрузку." });
      }
    } finally {
      if (isCurrent()) excelController.current = null;
    }
  }

  function cancelLoad() {
    jsonController.current?.abort();
    jsonController.current = null;
    setState({ status: "idle" });
  }

  function cancelExcel() {
    excelController.current?.abort();
    excelController.current = null;
    setExcel({ status: "idle" });
  }

  const period = ready ? `${previewDate(ready.report.params.from)} — ${previewDate(ready.report.params.to, true)}` : "";

  return <section className="reports-section turnover-workspace" aria-labelledby={headingId}>
    <div className="turnover-heading">
      <div><h2 id={headingId}>Оборачиваемость</h2>
      </div>
    </div>

    <form className="turnover-form" noValidate onSubmit={(event) => { event.preventDefault(); void load(); }}>
      <fieldset className="turnover-configuration">
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

      <div className="turnover-download-actions">
        {ready ? <>
          <button type="button" ref={openButton} className="turnover-button turnover-primary"
            onClick={() => setView("open")}>Открыть отчёт</button>
          <button type="button" className="turnover-button" disabled={downloading} onClick={() => void download()}>
            <Download size={17} aria-hidden="true" />{downloading ? "Формируем Excel…" : "Скачать Excel"}
          </button>
          {downloading && <button type="button" className="turnover-button" onClick={cancelExcel}>Отменить</button>}
          <p className="turnover-note" role="status">{period} · строк: {formatNumber(ready.report.rows.length)}</p>
          {excel.status === "loading" && <ReportProgress transfer={excel.transfer} excel />}
        </> : current?.status === "loading" ? <>
          <ReportProgress transfer={current.transfer} />
          <button type="button" className="turnover-button" onClick={cancelLoad}>Отменить</button>
        </> : <button type="submit" className="turnover-button turnover-primary" disabled={!prepared.valid}
          aria-describedby={!prepared.valid ? periodErrorId : undefined}>Загрузить отчёт</button>}
      </div>
      {current?.status === "error" && <p className="turnover-message turnover-error" role="alert">{current.message}</p>}
      {ready && excel.status === "error" && <p className="turnover-message turnover-error" role="alert">{excel.message}</p>}
      {ready && excel.status === "success" && <p className="turnover-message turnover-success" role="status">{excel.message}</p>}
    </form>
    {ready && view !== "unopened" && <ReportDialog report={ready.report} period={period}
      open={view === "open"} onClose={() => setView("closed")} opener={openButton} />}
  </section>;
}
