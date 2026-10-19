import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Download } from "lucide-react";
import { api } from "./api";
import type {
  ReportDateRange, TurnoverOption, TurnoverOptions, TurnoverRequest
} from "./api";
import { formatNumber } from "./format";

const DAY_MS = 86_400_000;
const MODE_LABELS: Record<"quantity" | "money", string> = {
  quantity: "Товараоборот в шт.",
  money: "Товараоборот в деньгах"
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
  requestKey?: string; message?: string; rows?: number | null; cache?: string | null; seconds?: number;
};

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
  return values.map((key) => names.get(key) ?? key).join(", ");
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
      {value && !options.some((option) => option.key === value) ? <option value={value}>{value}</option> : null}
      {options.map((option) => <option value={option.key} key={option.key}>{option.name}</option>)}
    </select>
    {hint ? <span className="turnover-note" id={hintId}>{hint}</span> : null}
  </label>;
}

function CheckboxSelect({ label, values, options, allLabel, searchLabel, clearLabel, onChange, pending, unavailable, showSelected = false }: {
  label: string; values: string[]; options: TurnoverOption[]; allLabel: string;
  searchLabel: string; clearLabel: string; onChange: (values: string[]) => void;
  pending: boolean; unavailable: boolean; showSelected?: boolean;
}) {
  const searchId = useId();
  const [search, setSearch] = useState("");
  const names = useMemo(() => new Map(options.map((option) => [option.key, option.name])), [options]);
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
    {showSelected && values.length ? <ul className="turnover-selected" aria-label={`Выбрано: ${label.toLocaleLowerCase("ru-RU")}`}>
      {values.map((key) => <li key={key}><span>{names.get(key) ?? key}</span>
        <button type="button" aria-label={`Убрать: ${names.get(key) ?? key}`} onClick={() => onChange(values.filter((value) => value !== key))}>×</button>
      </li>)}
    </ul> : null}
  </div>;
}

export function TurnoverReport({ dateRange, onDateRangeChange }: {
  dateRange: InclusiveDateRange; onDateRangeChange: (range: InclusiveDateRange) => void;
}) {
  const headingId = useId();
  const reportName = useId();
  const formatName = useId();
  const summaryId = useId();
  const periodHintId = useId();
  const periodErrorId = useId();
  const categoryHintId = useId();
  const [filters, setFilters] = useState<Filters>({
    store: [], warehouse: "", category: [], brand: "", search: "",
    mode: "quantity", format: "sample", includeNonRetail: false, excludeZero: false
  });
  const [options, setOptions] = useState<TurnoverOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [state, setState] = useState<DownloadState>({ status: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const prepared = useMemo(() => prepareRequest(dateRange, filters), [dateRange.from, dateRange.to, filters]);
  const requestKey = JSON.stringify(prepared.valid ? prepared.request : {
    ...filters, store: [...filters.store].sort(), category: [...filters.category].sort(),
    search: filters.search.trim(), from: dateRange.from, to: dateRange.to
  });
  const currentState: DownloadState = state.requestKey === requestKey ? state : { status: "idle" };
  const downloading = currentState.status === "loading";

  useEffect(() => () => controller.current?.abort(), []);

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

  useEffect(() => {
    if (!downloading) { setElapsed(0); return; }
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [downloading]);

  const stores = options?.stores ?? EMPTY_OPTIONS;
  const categories = options?.categories ?? EMPTY_OPTIONS;
  const brands = options?.brands ?? EMPTY_OPTIONS;
  const warehouses = (options?.warehouses ?? []).filter((warehouse) => !filters.store.length || warehouse.storeKey === null || filters.store.includes(warehouse.storeKey));
  const optionsPending = !options && !optionsError;
  const optionsUnavailable = !options && !!optionsError;
  const from = dateNumber(dateRange.from);
  const to = dateNumber(dateRange.to);
  const days = from !== null && to !== null && to >= from ? (to - from) / DAY_MS + 1 : null;
  const period = [
    from === null ? "Не выбрана" : dateRange.from.split("-").reverse().join("."),
    to === null ? "Не выбрана" : dateRange.to.split("-").reverse().join(".")
  ].join(" — ");

  function update<K extends keyof Filters>(key: K, value: Filters[K]) {
    if (!downloading) setFilters((previous) => ({ ...previous, [key]: value }));
  }

  function updateStores(store: string[]) {
    if (!downloading) setFilters((previous) => ({ ...previous, store, warehouse: "" }));
  }

  function updateDates(range: InclusiveDateRange) {
    if (!downloading && (range.from !== dateRange.from || range.to !== dateRange.to)) onDateRangeChange(range);
  }

  async function download(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (downloading) return;
    if (!prepared.valid) { setState({ status: "error", requestKey, message: prepared.error }); return; }
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    const started = performance.now();
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
      setState({
        status: "success", requestKey,
        message: `Файл ${result.filename} скачан.`,
        rows: result.rows,
        cache: result.cache,
        seconds: Math.max(1, Math.round((performance.now() - started) / 1000))
      });
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
        <p className="turnover-intro">Выберите отчёт, детализацию, период и отбор, затем скачайте Excel.</p>
      </div>
      <span className="turnover-excel-label">Excel</span>
    </div>

    <form className="turnover-form" noValidate onSubmit={download}>
      <fieldset className="turnover-fieldset turnover-report-types" disabled={downloading}>
        <legend>Отчёт</legend>
        <div className="turnover-report-options">
          {(Object.entries(MODE_LABELS) as [SampleMode, string][]).map(([mode, label]) => <label className="turnover-report-choice" key={mode}>
            <input type="radio" name={reportName} value={mode} checked={filters.mode === mode} aria-labelledby={`${reportName}-${mode}`} aria-describedby={`${reportName}-${mode}-description`} onChange={() => update("mode", mode)} />
            <span><strong id={`${reportName}-${mode}`}>{label}</strong><span id={`${reportName}-${mode}-description`}>{mode === "quantity" ? "Остатки и продажи в единицах товара" : "Остатки и продажи по себестоимости"}</span></span>
          </label>)}
        </div>
      </fieldset>

      <fieldset className="turnover-fieldset turnover-format-types" disabled={downloading}>
        <legend>Детализация</legend>
        <div className="turnover-report-options">
          {([
            ["sample", "Сводно по товарам", "Одна строка на товар. Остатки и продажи по всей сети."],
            ["stores", "По магазинам", "Одна строка на магазин и товар. Остатки, продажи и показатели по магазинам."]
          ] as [ReportFormat, string, string][]).map(([value, label, description]) => <label className="turnover-report-choice" key={value}>
            <input type="radio" name={formatName} value={value} checked={filters.format === value} aria-labelledby={`${formatName}-${value}`} aria-describedby={`${formatName}-${value}-description`} onChange={() => update("format", value)} />
            <span><strong id={`${formatName}-${value}`}>{label}</strong><span id={`${formatName}-${value}-description`}>{description}</span></span>
          </label>)}
        </div>
      </fieldset>

      <div className="turnover-builder-grid">
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
            <p className="turnover-period-caption">{period}{days !== null ? ` · ${formatNumber(days)} календ. дн.` : ""}</p>
            <p className="turnover-note" id={periodHintId}>
              {filters.format === "sample"
                ? "Обе даты включены. Для сводного отчёта — от 2 до 366 дней."
                : "Обе даты включены. Для отчёта по магазинам — от 1 до 366 дней."} «Последние 30 дней» — по вчерашний день; «Текущий месяц» — весь календарный месяц.
            </p>
            {!prepared.valid ? <p className="turnover-validation" id={periodErrorId} role="status">{prepared.error}</p> : null}
          </fieldset>

          <fieldset className="turnover-fieldset" aria-describedby={categoryHintId}>
            <legend>Категории</legend>
            <CheckboxSelect label="Категории / группы товаров" values={filters.category} options={categories} allLabel="Все категории" searchLabel="Найти категорию" clearLabel="Очистить выбор" onChange={(value) => update("category", value)} pending={optionsPending} unavailable={optionsUnavailable} showSelected />
            <p className="turnover-note turnover-field-hint" id={categoryHintId}>Можно выбрать несколько. Учитываются все выбранные группы и их вложенные категории; пересечения не дублируют товары. Без выбора — все категории.</p>
          </fieldset>

          <fieldset className="turnover-fieldset">
            <legend>Дополнительный отбор</legend>
            <div className="turnover-filter-grid">
              <div className="turnover-store-filter">
                <CheckboxSelect label="Магазины" values={filters.store} options={stores} allLabel="Вся сеть" searchLabel="Найти магазин" clearLabel="Вся сеть" onChange={updateStores} pending={optionsPending} unavailable={optionsUnavailable} />
              </div>
              <OptionSelect label="Склад" value={filters.warehouse} options={warehouses} disabled={!options} onChange={(value) => update("warehouse", value)} placeholder="Все склады" />
              <OptionSelect label="Бренд" value={filters.brand} options={brands} disabled={!brands.length} onChange={(value) => update("brand", value)} placeholder="Все бренды" hint={!brands.length ? optionsPending ? "Загружаем справочник брендов…" : optionsUnavailable ? "Справочник недоступен. Повторите загрузку ниже." : "Справочник брендов пока не заполнен. В отбор входят все бренды." : undefined} />
              <label className="turnover-field turnover-product-search"><span>Товар</span><input type="search" value={filters.search} onChange={(event) => update("search", event.target.value)} placeholder="Название, артикул, код или SKU" /></label>
            </div>
            <label className="turnover-check turnover-scope-check">
              <input type="checkbox" checked={filters.includeNonRetail} onChange={(event) => update("includeNonRetail", event.target.checked)} />
              <span>Включать офисы и отделы</span>
            </label>
            <p className="turnover-note">Их остатки войдут в отчёт; продажи будут <strong>n/a</strong>, потому что розничных отчётов нет.</p>
            <label className="turnover-check turnover-zero-check">
              <input type="checkbox" checked={filters.excludeZero} onChange={(event) => update("excludeZero", event.target.checked)} />
              <span>Исключить нулевые товары</span>
            </label>
            <p className="turnover-note">Только если остаток и продажи равны нулю каждый день периода. Товары с нулевой продажей, но ненулевым остатком остаются.</p>
          </fieldset>

          {optionsError ? <div className="turnover-message turnover-error" role="alert">
            <strong>Справочники не загрузились</strong><p>{optionsError}</p>
            <button type="button" className="turnover-button" onClick={() => setOptionsAttempt((attempt) => attempt + 1)}>Повторить загрузку</button>
          </div> : null}
        </fieldset>

        <aside className="turnover-file-summary" aria-labelledby={summaryId}>
          <div className="turnover-file-heading"><Download size={20} aria-hidden="true" /><h3 id={summaryId}>Ваш Excel</h3></div>
          <dl className="turnover-file-parameters">
            <div><dt>Отчёт</dt><dd className="turnover-summary-report">{MODE_LABELS[filters.mode]}</dd></div>
            <div><dt>Детализация</dt><dd>{filters.format === "sample" ? "Сводно по товарам" : "По магазинам"}</dd></div>
            <div><dt>Период</dt><dd className="turnover-summary-period">{period}{days !== null ? <span>{formatNumber(days)} календ. дн., обе даты включены</span> : null}</dd></div>
            <div><dt>Строки</dt><dd>{filters.format === "sample"
              ? "Одна строка на товар. Количество и суммы по всем выбранным магазинам и складам."
              : "Одна строка на магазин и товар."}</dd></div>
            <div><dt>Магазины{filters.store.length ? `: ${formatNumber(filters.store.length)}` : ""}</dt><dd>{filters.store.length ? selectedNames(filters.store, stores) : `Вся сеть${stores.length ? ` · ${formatNumber(stores.length)} магазинов` : ""}`}</dd></div>
            <div><dt>Категории{filters.category.length ? `: ${formatNumber(filters.category.length)}` : ""}</dt><dd>{filters.category.length ? selectedNames(filters.category, categories) : "Все категории"}</dd></div>
            <div><dt>Склады</dt><dd>{filters.warehouse ? selectedNames([filters.warehouse], warehouses) : "Все склады"}</dd></div>
            {filters.includeNonRetail ? <div><dt>Офисы и отделы</dt><dd>Включены в остатки; продажи — n/a</dd></div> : null}
            {filters.excludeZero ? <div><dt>Нулевые товары</dt><dd>Исключены</dd></div> : null}
            {filters.brand ? <div><dt>Бренд</dt><dd>{selectedNames([filters.brand], brands)}</dd></div> : null}
            {filters.search.trim() ? <div><dt>Товар</dt><dd>{filters.search.trim()}</dd></div> : null}
          </dl>

          <div className="turnover-file-description">
            <strong>{filters.format === "sample" ? "XLSX · 2 листа" : "XLSX · полный отчёт"}</strong>
            {filters.format === "sample" ? <>
              <p>«рассчет оборачиваемости» — дневные остатки и оборачиваемость.</p>
              <p>«Продажи за период» — {filters.mode === "quantity" ? "количество проданных товаров." : "количество и себестоимость продаж с итоговой строкой."}</p>
              <p>Формулы и оформление фиксированы. Все товары выбранного отбора, без ограничения страницей. Нет данных — «n/a», не ноль.</p>
            </> : <>
              <p>«Оборачиваемость» — магазин, SKU, остатки, продажи, коэффициенты и риски.</p>
              <p>Дополнительно: динамика 7/14/30, ежедневные остатки, перемещения и параметры расчёта.</p>
              <p>Полный отчёт по магазинам. Нет данных — «n/a», не ноль.</p>
            </>}
          </div>

          <div className="turnover-download-actions" aria-busy={downloading}>
            <button type="submit" className="turnover-button turnover-primary" disabled={downloading || !prepared.valid} aria-describedby={!prepared.valid ? periodErrorId : undefined}>
              <Download size={17} aria-hidden="true" />{downloading ? "Формируем Excel…" : "Скачать Excel"}
            </button>
            {downloading ? <>
              <p className="turnover-note" role="status">Формируем файл: {elapsed} с. Параметры временно недоступны.</p>
              <button type="button" className="turnover-button" onClick={cancel}>Отменить</button>
            </> : null}
          </div>
          {currentState.status === "error" ? <div className="turnover-message turnover-error" role="alert"><strong>Excel не сформирован</strong><p>{currentState.message}</p><p>Проверьте параметры и нажмите «Скачать Excel» ещё раз.</p></div> : null}
          {currentState.status === "success" ? <div className="turnover-message turnover-success" role="status">
            <strong>{currentState.message}</strong>
            <p>{currentState.rows !== null && currentState.rows !== undefined ? `Строк в файле: ${formatNumber(currentState.rows)}. ` : ""}{currentState.cache === "hit" || currentState.cache === "shared" ? "Ответ из кэша. " : ""}Время: {currentState.seconds} с.</p>
          </div> : null}
        </aside>
      </div>
    </form>
  </section>;
}
