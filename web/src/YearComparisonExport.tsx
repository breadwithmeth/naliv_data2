import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import type { ReportDateRange, YearComparisonPreview, YearComparisonRequest } from "./api";
import { formatDecimal, formatNumber } from "./format";

type InclusiveRange = Required<Pick<ReportDateRange, "from" | "to">>;
type PreviewState =
  | { status: "idle" }
  | { status: "loading"; rangeKey: string }
  | { status: "error"; rangeKey: string; error: string }
  | { status: "success"; rangeKey: string; data: YearComparisonPreview };
type DownloadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; filename: string }
  | { status: "error"; error: string };
type ExportFormat = "comparison" | "presentation";
const exportFormats: Record<ExportFormat, string> = {
  comparison: "Подробное сравнение по категориям",
  presentation: "Итоги периода и месяца — по презентации"
};

function excelWindow(range: InclusiveRange):
  | { valid: true; from: string; to: string }
  | { valid: false; error: string } {
  const from = new Date(`${range.from}T00:00:00.000Z`);
  const inclusiveTo = new Date(`${range.to}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(range.from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(range.to) ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(inclusiveTo.getTime()) ||
    from.toISOString().slice(0, 10) !== range.from ||
    inclusiveTo.toISOString().slice(0, 10) !== range.to
  ) {
    return { valid: false, error: "Выберите обе даты в общем фильтре периода." };
  }
  const days = (inclusiveTo.getTime() - from.getTime()) / 86_400_000 + 1;
  if (days < 1 || days > 366) {
    return { valid: false, error: "Для Excel нужен период от 1 до 366 дней включительно." };
  }
  inclusiveTo.setUTCDate(inclusiveTo.getUTCDate() + 1);
  const to = inclusiveTo.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return { valid: false, error: "Конец периода выходит за допустимый календарный диапазон." };
  }
  return { valid: true, from: range.from, to };
}

function defaultAdditionalRange(range: InclusiveRange): InclusiveRange {
  const monthStart = `${range.to.slice(0, 7)}-01`;
  return { from: range.from > monthStart ? range.from : monthStart, to: range.to };
}

function calendarDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString("ru-RU", { timeZone: "UTC" });
}

function comparisonPeriodLabel(period: YearComparisonPreview["periods"]["current"]) {
  if (period.from === period.to) return "Нет дней после сопоставления календарных дат";
  const lastDay = new Date(`${period.to}T00:00:00.000Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  return `${calendarDate(period.from)} — ${calendarDate(lastDay.toISOString().slice(0, 10))}`;
}

function storeLabel(store: YearComparisonPreview["stores"][number], index: number) {
  return store.sourceStoreKeys.includes(store.name) || store.name === store.key
    ? `Магазин без названия №${index + 1}`
    : store.name;
}

export function YearComparisonExport({ dateRange, children }: { dateRange: InclusiveRange; children?: ReactNode }) {
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "idle" });
  const [reload, setReload] = useState(0);
  const [cohort, setCohort] = useState<YearComparisonRequest["cohort"]>("observed");
  const [selectedStores, setSelectedStores] = useState<Set<string> | null>(null);
  const [downloadState, setDownloadState] = useState<DownloadState>({ status: "idle" });
  const [exportFormat, setExportFormat] = useState<ExportFormat>("comparison");
  const [monthRange, setMonthRange] = useState<InclusiveRange | null>(null);
  const [selectedCities, setSelectedCities] = useState<Set<string>>(new Set());
  const previewController = useRef<AbortController | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const window = excelWindow(dateRange);
  const additionalRange = exportFormat === "presentation" ? monthRange ?? defaultAdditionalRange(dateRange) : dateRange;
  const additionalWindow = exportFormat === "presentation" ? excelWindow(additionalRange) : window;
  const cityKeys = exportFormat === "presentation" ? Array.from(selectedCities).sort() : [];
  const rangeKey = `${dateRange.from}|${dateRange.to}`;
  const selectedKeys = Array.from(selectedStores ?? []).sort();
  const requestKey = JSON.stringify(exportFormat === "presentation"
    ? [rangeKey, exportFormat, additionalRange.from, additionalRange.to, cityKeys]
    : [rangeKey, exportFormat, cohort, cohort === "custom" ? selectedKeys : []]);
  const currentDownloadKey = useRef<string | null>(null);
  currentDownloadKey.current = requestKey;
  const preview = previewState.status === "success" && previewState.rangeKey === rangeKey
    ? previewState.data
    : null;
  const loadingPreview = previewState.status === "loading" && previewState.rangeKey === rangeKey;
  const observedStoreCount = preview?.stores.filter((store) => store.comparableByActivity).length ?? 0;
  const comparableStoreCount = cohort === "observed" ? observedStoreCount : selectedKeys.length;
  const availableCities = preview ? Array.from(new Set(preview.stores.map((store) => store.city))).sort((a, b) => a.localeCompare(b, "ru")) : [];

  useEffect(() => {
    if (!window.valid) return;
    const controller = new AbortController();
    previewController.current = controller;
    setPreviewState({ status: "loading", rangeKey });
    // Coverage and the full physical-outlet list are independent of manual selection.
    api.yearComparison({ from: window.from, to: window.to, cohort: "observed" }, controller.signal)
      .then((data) => {
        if (controller.signal.aborted || previewController.current !== controller) return;
        setPreviewState({ status: "success", rangeKey, data });
        setSelectedStores((current) => new Set(
          data.stores
            .filter((store) => current ? current.has(store.key) : store.comparableByActivity)
            .map((store) => store.key)
        ));
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || previewController.current !== controller) return;
        setPreviewState({
          status: "error",
          rangeKey,
          error: caught instanceof Error ? caught.message : "Не удалось загрузить предпросмотр Excel"
        });
      });
    return () => {
      controller.abort();
      if (previewController.current === controller) previewController.current = null;
    };
  }, [dateRange.from, dateRange.to, reload]);

  useEffect(() => {
    setDownloadState({ status: "idle" });
    return () => {
      downloadController.current?.abort();
      downloadController.current = null;
    };
  }, [requestKey]);

  async function download() {
    if (!window.valid || !additionalWindow.valid || !preview || downloadController.current) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloadState({ status: "loading" });
    try {
      const result = exportFormat === "presentation"
        ? await api.presentationReportWorkbook({
          from: window.from, to: window.to,
          monthFrom: additionalWindow.from, monthTo: additionalWindow.to, city: cityKeys
        }, controller.signal)
        : await api.yearComparisonWorkbook({
          from: window.from, to: window.to, cohort,
          ...(cohort === "custom" ? { comparableStore: selectedKeys } : {})
        }, controller.signal);
      if (
        controller.signal.aborted ||
        downloadController.current !== controller ||
        currentDownloadKey.current !== requestKey
      ) return;
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setDownloadState({ status: "success", filename: result.filename });
    } catch (caught) {
      if (
        !controller.signal.aborted &&
        downloadController.current === controller &&
        currentDownloadKey.current === requestKey
      ) {
        setDownloadState({
          status: "error",
          error: caught instanceof Error ? caught.message : "Не удалось скачать Excel"
        });
      }
    } finally {
      if (downloadController.current === controller) downloadController.current = null;
    }
  }

  return (
    <section className="reports-section" aria-label="Скачать сравнение продаж по годам" aria-busy={loadingPreview || downloadState.status === "loading"}>
      <div className="export-summary">
        <p>{exportFormat === "presentation"
          ? "Отдельная книга по структуре презентации: все товарные группы, фасовка, розлив и все поставщики. Закупки — по документам; ВД поставщиков — модель единственного поставщика с нераспределённым остатком."
          : "Скачайте сравнение продаж с прошлым годом: по категориям товаров, городам и магазинам. В Excel войдут все магазины с данными, выбранная сопоставимая сеть и проверка качества данных."}</p>
        <p className="muted">
          Период отчёта: {window.valid ? `${calendarDate(dateRange.from)} — ${calendarDate(dateRange.to)}` : `${dateRange.from || "не выбран"} — ${dateRange.to || "не выбран"}`}. Обе даты включены.
        </p>
      </div>
      {children}
      <div className="date-range-control export-format-controls">
        <label>Формат Excel
          <select aria-label="Формат Excel" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}>
            {Object.entries(exportFormats).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      {exportFormat === "presentation" ? (
        <fieldset className="export-cohort">
          <legend>Дополнительный период и города</legend>
          <div className="date-range-control export-period-controls">
            <label>Дополнительный период, с
              <input type="date" aria-label="Дополнительный период, с" value={additionalRange.from} onChange={(event) => setMonthRange({ ...additionalRange, from: event.target.value })} />
            </label>
            <label>Дополнительный период, по
              <input type="date" aria-label="Дополнительный период, по" value={additionalRange.to} onChange={(event) => setMonthRange({ ...additionalRange, to: event.target.value })} />
            </label>
            <button type="button" className="date-reset-button" onClick={() => setMonthRange(null)}>Последний месяц основного периода</button>
          </div>
          {!additionalWindow.valid ? <div className="form-error" role="alert">{additionalWindow.error}</div> : null}
          <p className="context-note">Обе даты включены. Предыдущие окна — те же даты годом ранее. Покрытие всех четырёх окон показано на первом листе книги; отсутствие прошлого года не блокирует скачивание.</p>
          <div className="report-controls">
            <button type="button" className="date-reset-button" onClick={() => setSelectedCities(new Set())}>Все города</button>
            {availableCities.map((city) => (
              <label key={city}>
                <input type="checkbox" checked={selectedCities.has(city)} onChange={(event) => {
                  const checked = event.target.checked;
                  setSelectedCities((current) => {
                    const next = new Set(current);
                    if (checked) next.add(city); else next.delete(city);
                    return next;
                  });
                }} />{" "}{city}
              </label>
            ))}
          </div>
          <p className="muted">Города экспорта: {cityKeys.length ? cityKeys.join(", ") : "все"}. Город и числовую долю также можно фильтровать в Excel.</p>
          <p className="metric-note">Ниже — проверка основного периода. Сопоставимая сеть новой книги формируется автоматически: только точки с положительными продажными чеками в обоих окнах. Это признак активности, не подтверждение даты открытия.</p>
        </fieldset>
      ) : null}
      {!window.valid ? <div className="form-error" role="alert">{window.error}</div> : null}
      {loadingPreview ? (
        <div className="metric-note" role="status">
          Проверяем наличие чеков и список магазинов…{" "}
          <button type="button" className="date-reset-button" onClick={() => {
            previewController.current?.abort();
            previewController.current = null;
            setPreviewState({ status: "idle" });
          }}>Отменить загрузку</button>
        </div>
      ) : null}
      {previewState.status === "error" && previewState.rangeKey === rangeKey ? (
        <div className="form-error" role="alert">{previewState.error}</div>
      ) : null}
      {preview ? (
        <>
          <div className="export-coverage" aria-label="Наличие данных для сравнения">
            {preview.coverage.map((coverage) => (
              <dl key={coverage.period}>
                <dt>{coverage.period === "current" ? "Выбранный период" : "Те же даты годом ранее"}</dt>
                <dd>{comparisonPeriodLabel(preview.periods[coverage.period])}</dd>
                <dt>Дни с чеками</dt>
                <dd>{formatNumber(coverage.coveredDays)} из {formatNumber(coverage.expectedDays)}</dd>
                <dt>Чеки, включая возвраты</dt>
                <dd>{formatNumber(coverage.receiptCount)}</dd>
              </dl>
            ))}
          </div>
          <div className={`metric-note${preview.coverage.some((coverage) => coverage.status !== "observed") ? " warning" : ""}`} role="note">
            {preview.coverage.some((coverage) => coverage.period === "previous" && coverage.status === "empty") ? (
              <strong>Нет данных за предыдущий год. Скачать отчёт можно; недоступная база, изменения и LFL будут n/a, а не нулями. </strong>
            ) : preview.coverage.some((coverage) => coverage.status !== "observed") ? (
              <strong>Есть дни без чеков. Скачать отчёт можно, но он не даёт полной картины продаж. </strong>
            ) : null}
            Наличие чеков не подтверждает полноту данных. Дни без данных не считаются нулевыми продажами.
          </div>
          {preview.quality.map((quality) => (
            quality.unvaluedQuantity > 1e-9 || (quality.difference !== null && Math.abs(quality.difference) > 0.01) ? (
              <div className="metric-note warning" role="note" key={quality.period}>
                <strong>{quality.period === "current" ? "Выбранный период" : "Предыдущий год"}. </strong>
                {quality.unvaluedQuantity > 1e-9 ? (
                  <span>Неизвестна себестоимость {formatDecimal(quality.unvaluedQuantity, 3)} единиц в учётных единицах товаров и услуг. Выручка по этим позициям после возвратов: {quality.unvaluedRevenue === null ? "нет данных" : `${formatDecimal(quality.unvaluedRevenue, 2)} ₸`}. Оценка валового дохода для итогов с такими позициями недоступна. </span>
                ) : null}
                {quality.difference !== null && Math.abs(quality.difference) > 0.01 ? (
                  <span>Сумма товарных позиций отличается от общих сумм чеков на {formatDecimal(quality.difference, 2)} ₸. В отчёте сохранены записанные суммы позиций; расхождение не распределяется между товарами.</span>
                ) : null}
              </div>
            ) : null
          ))}
          {exportFormat === "comparison" ? (
          <fieldset className="export-cohort">
            <legend>Какие магазины сравнивать</legend>
            <div className="report-controls">
              <label>
                <input type="radio" name="year-comparison-cohort" checked={cohort === "observed"} onChange={() => setCohort("observed")} />{" "}
                С продажами в обоих годах ({formatNumber(observedStoreCount)})
              </label>
              <label>
                <input type="radio" name="year-comparison-cohort" checked={cohort === "custom"} onChange={() => setCohort("custom")} />{" "}
                Выбрать вручную ({formatNumber(selectedKeys.length)})
              </label>
            </div>
            <p className="context-note">Автоматический выбор — магазины с положительными чеками продаж в обоих периодах по всем товарам. Это признак активности, а не подтверждение даты открытия.</p>
            <p>Магазинов в сопоставимом сравнении: {formatNumber(comparableStoreCount)}. Данные по всем магазинам также сохраняются в книге.</p>
            {cohort === "observed" && observedStoreCount === 0 ? (
              <div className="metric-note warning">Нет магазинов с продажами в обоих периодах. Сопоставимое сравнение будет пустым; данные по всем магазинам останутся в книге.</div>
            ) : null}
            {cohort === "custom" ? (
              <>
                <div className="export-actions">
                  <button type="button" className="date-reset-button" onClick={() => setSelectedStores(new Set(preview.stores.filter((store) => store.comparableByActivity).map((store) => store.key)))}>Выбрать с продажами в обоих годах</button>
                  <button type="button" className="date-reset-button" onClick={() => setSelectedStores(new Set(preview.stores.map((store) => store.key)))}>Выбрать все</button>
                  <button type="button" className="date-reset-button" onClick={() => setSelectedStores(new Set())}>Снять выбор</button>
                </div>
                <p className="muted">Можно включить или исключить любой магазин. При смене периода сохраняется выбор магазинов, которые остаются в списке; новые не выбираются автоматически.</p>
                {selectedKeys.length === 0 ? <div className="metric-note warning">Список пуст: сопоставимых магазинов не будет. Данные по всем магазинам останутся в книге.</div> : null}
                <div className="data-table-wrap export-store-list">
                  <table className="data-table">
                    <caption>Магазины для сопоставимого сравнения</caption>
                    <thead><tr><th>Выбор</th><th>Город</th><th>Магазин</th><th>Продажи в обоих периодах</th></tr></thead>
                    <tbody>
                      {preview.stores.map((store, index) => (
                        <tr key={store.key}>
                          <td><input type="checkbox" aria-label={`Включить в сравнение: ${store.city}, ${storeLabel(store, index)}`} checked={selectedStores?.has(store.key) ?? false} onChange={(event) => {
                            const checked = event.target.checked;
                            setSelectedStores((current) => {
                              const next = new Set(current ?? []);
                              if (checked) next.add(store.key);
                              else next.delete(store.key);
                              return next;
                            });
                          }} /></td>
                          <td>{store.city}</td>
                          <td>{storeLabel(store, index)}</td>
                          <td>{store.comparableByActivity ? "Есть" : "Нет"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.stores.length === 0 ? <p className="muted">В выбранных периодах нет магазинов с чеками.</p> : null}
              </>
            ) : null}
          </fieldset>
          ) : null}
          <details className="report-disclosure">
            <summary>Качество данных и правила сравнения</summary>
            <div className="data-table-wrap">
              <table className="data-table">
                <caption>Периоды и наличие чеков</caption>
                <thead><tr><th>Период</th><th>Выбранные даты</th><th>Дни с чеками</th><th>Чеки, включая возвраты</th><th>Первая и последняя даты с чеками</th></tr></thead>
                <tbody>
                  {preview.coverage.map((coverage) => (
                    <tr key={coverage.period}>
                      <td>{coverage.period === "current" ? "Выбранный" : "Предыдущий год"}</td>
                      <td>{comparisonPeriodLabel(preview.periods[coverage.period])}</td>
                      <td>
                        {formatNumber(coverage.coveredDays)} / {formatNumber(coverage.expectedDays)}
                        {coverage.status !== "observed" ? <span className="metric-warning"> · {coverage.status === "empty" ? "нет чеков" : "не все дни"}</span> : null}
                      </td>
                      <td>{formatNumber(coverage.receiptCount)}</td>
                      <td>{coverage.dateFrom && coverage.dateTo ? `${calendarDate(coverage.dateFrom)} — ${calendarDate(coverage.dateTo)}` : "нет дат с чеками"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul>
              <li>Сравниваются выбранные календарные даты и те же даты годом ранее. При необходимости 29 февраля сопоставляется с 28 февраля. Используется календарь чеков в учётной системе, без пересчёта времени продаж.</li>
              <li>Продажи и количество взяты из проведённых, неудалённых чеков с ненулевой суммой. Возвраты уменьшают количество, выручку и оценённую стоимость. Отчёты розницы не являются источником этого сравнения.</li>
              <li>Количество сохраняет учётные единицы товаров и услуг. Общую сумму нельзя понимать как число одинаковых штук или литров: пересчёт единиц не выполняется.</li>
              <li>Выручка включает НДС, записанный в розничных суммах. НДС отдельно не выделен; это не выручка без НДС.</li>
              <li>Валовой доход — оценка выручки за вычетом себестоимости, найденной на конец каждого периода. Это не фактическая историческая себестоимость продаж и не бухгалтерская прибыль. Для каждого периода сначала используется актуальная стоимость магазина, затем установленная стоимость магазина, затем последняя общая стоимость, затем средневзвешенная закупочная цена без НДС за 90 дней. Данные для оценки берутся до конца соответствующего периода.</li>
              <li>Если себестоимость части товара неизвестна, валовой доход для итога с этим товаром недоступен. Известная часть стоимости и покрытие остаются в файле. Нет данных — не ноль; рост от нулевой базы не рассчитывается.</li>
              <li>Категории определены по текущему справочнику товаров, а не по исторической классификации. Товары, которые не удалось отнести к категории, сохранены в проверочных листах книги.</li>
              <li>Разные юрлица одного адреса объединены в один магазин. Адреса не объединяются по приблизительному сходству; магазины без распознаваемого адреса остаются отдельными. Себестоимость оценивается до объединения. Названия и точные ссылки учётной системы доступны в Excel.</li>
              <li>Средние рассчитаны из общих сумм и уникальных чеков продаж без возвратных чеков, а не сложением средних по магазинам или категориям. Итоги количества и выручки учитывают возвраты.</li>
              <li>Дни с чеками показывают наблюдаемую активность, а не подтверждённую полноту данных. Пропущенные дни, сверка сумм, источники стоимости и подробные ограничения сохранены на листах качества данных в Excel. Число магазинов в книге не ограничено размером экранного списка.</li>
            </ul>
          </details>
        </>
      ) : null}
      <div className="export-actions">
        {window.valid && !loadingPreview ? (
          <button type="button" className="date-reset-button" onClick={() => setReload((current) => current + 1)}>
            {preview ? "Обновить проверку данных" : "Загрузить проверку данных"}
          </button>
        ) : null}
        <button type="button" className="date-apply-button" disabled={!window.valid || !additionalWindow.valid || !preview || loadingPreview || downloadState.status === "loading"} onClick={download}>
          {downloadState.status === "loading" ? "Готовим отчёт…" : "Скачать отчёт Excel"}
        </button>
        {downloadState.status === "loading" ? (
          <button type="button" className="date-reset-button" onClick={() => {
            downloadController.current?.abort();
            downloadController.current = null;
            setDownloadState({ status: "idle" });
          }}>Отменить скачивание</button>
        ) : null}
      </div>
      {downloadState.status === "error" ? <div className="form-error" role="alert">{downloadState.error}</div> : null}
      {downloadState.status === "success" ? <p className="muted" role="status">Файл {downloadState.filename} передан браузеру для скачивания.</p> : null}
    </section>
  );
}
