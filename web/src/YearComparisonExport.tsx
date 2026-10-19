import { useEffect, useId, useRef, useState } from "react";
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
  presentation: "Основной и дополнительный периоды — по презентации"
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
  const guideId = useId();
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
          Период отчёта: {window.valid ? `${calendarDate(dateRange.from)} — ${calendarDate(dateRange.to)}` : `${dateRange.from || "не выбран"} — ${dateRange.to || "не выбран"}`}. Обе даты включены; правила календарного сопоставления — в пояснении ниже.
        </p>
      </div>
      {children}
      <div className="date-range-control export-format-controls">
        <label>Формат Excel
          <select aria-label="Формат Excel" aria-describedby={`${guideId}-dates`} value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}>
            {Object.entries(exportFormats).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <details className="report-disclosure">
        <summary id={`${guideId}-dates`}>Формат Excel, даты и календарное сопоставление</summary>
        <p><strong>Что выбирается.</strong> «Подробное сравнение» — категории, города, все наблюдаемые физические точки и отдельно выбранная сопоставимая сеть. «По презентации» — два независимо заданных периода, все корневые группы, фасованные и разливные напитки, закупки и модельный доход поставщиков. Числа рассчитываются из загруженных данных 1С, а не копируются из образца книги или презентации.</p>
        <ul>
          <li><strong>Даты на экране включены.</strong> Нужны существующие даты и от 1 до 366 календарных дней; сервер принимает год от 0002, чтобы существовал предыдущий год. Для запроса интерфейс прибавляет один день к дате «по»: например, выбор 01.04.2026–30.06.2026 передаётся как <code>[2026-04-01, 2026-07-01)</code>. Сервер берёт документы с <code>date ≥ from</code> и <code>date &lt; to</code>; правая дата не входит. Дополнительный период переводится так же.</li>
          <li><strong>Предыдущий год — сдвиг границ, не подбор каждого дня.</strong> Серверная <code>previousCalendarYear</code> отдельно переносит <code>from</code> и уже исключённую <code>to</code> на год назад. Если такой границы нет, 29 февраля становится 28 февраля. Поэтому длительности окон около високосного дня могут отличаться: 28–29.02.2024 (два дня) сравниваются с 28.02.2023 (один день).</li>
          <li><strong>Возможен пустой предыдущий период.</strong> Выбор только 28.02.2024 даёт <code>[2024-02-28, 2024-02-29)</code>, а после сдвига — <code>[2023-02-28, 2023-02-28)</code>, без дней. Выбор только 29.02.2024, напротив, сопоставляется с 28.02.2023. При совпавших границах экран прямо сообщает, что дней нет; база сравнения и изменения в книге недоступны, а не равны нулю.</li>
          <li><strong>Какая дата используется.</strong> Поле <code>document_chek_kkm.date</code> сохраняет бизнес-календарь 1С (timestamp без часового пояса, синхронизация Asia/Qyzylorda). Время чеков не переносится в часовой пояс браузера. UTC в интерфейсе нужен для календарной арифметики и показа самой даты, не для изменения дня продажи. Таблица показывает включённую последнюю дату — API-границу <code>to</code> минус один день.</li>
          <li><strong>Даты в имени файла и книге.</strong> В имени файла границы записаны в API-формате: конечная дата исключена. Время «Снимок UTC» в Excel означает формирование расчётного снимка, не время последней загрузки из 1С; дата в колонтитуле — дата печати. Проверка на экране и последующее скачивание — отдельные запросы, поэтому при обновлении источника их числа могут различаться.</li>
        </ul>
        <p className="context-note">Для обеих книг цены и розничные суммы сохраняются с записанным НДС: он не вычитается и не начисляется повторно. Нетто означает «после возвратов», а не «без НДС». Оценочный ВД этих книг отличается от P&amp;L справочника с выручкой без НДС; это не бухгалтерская прибыль. Детальные формулы и оформление уже есть на листе «Методология» соответствующей книги.</p>
      </details>
      {exportFormat === "presentation" ? (
        <fieldset className="export-cohort" aria-describedby={`${guideId}-presentation`}>
          <legend>Дополнительный период и города</legend>
          <div className="date-range-control export-period-controls">
            <label>Дополнительный период, с
              <input type="date" aria-label="Дополнительный период, с" aria-describedby={`${guideId}-dates ${guideId}-presentation`} value={additionalRange.from} onChange={(event) => setMonthRange({ ...additionalRange, from: event.target.value })} />
            </label>
            <label>Дополнительный период, по
              <input type="date" aria-label="Дополнительный период, по" aria-describedby={`${guideId}-dates ${guideId}-presentation`} value={additionalRange.to} onChange={(event) => setMonthRange({ ...additionalRange, to: event.target.value })} />
            </label>
            <button type="button" className="date-reset-button" onClick={() => setMonthRange(null)}>Последний месяц в пределах основного периода</button>
          </div>
          {!additionalWindow.valid ? <div className="form-error" role="alert">{additionalWindow.error}</div> : null}
          <p className="context-note">Обе даты включены; календарные границы предыдущих окон сдвигаются на год назад по правилам выше. Покрытие всех четырёх окон показано на листе «Обзор и настройки»; отсутствие прошлого года не блокирует скачивание.</p>
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
          <p className="muted">Города экспорта: {cityKeys.length ? cityKeys.join(", ") : "все"}. Нет отмеченных городов — экспорт всех городов, а не пустой отчёт. Город и числовую долю также можно фильтровать в Excel.</p>
          <p className="metric-note">Ниже — проверка только основного периода и всей наблюдаемой сети: дополнительный период и выбранные города её не меняют. Сопоставимая сеть презентационной книги определяется автоматически и отдельно для каждого периода: точки с положительными продажными чеками в обоих годах. Это активность, не подтверждённая дата открытия.</p>
          <details className="report-disclosure">
            <summary id={`${guideId}-presentation`}>Дополнительный период, города и числа презентационного отчёта</summary>
            <ul>
              <li><strong>Дополнительные даты.</strong> По умолчанию начало — более поздняя из двух дат: начало основного периода или первый день месяца, содержащего его последний день; конец — последний день основного периода. Это часть последнего месяца в пределах выбранных дат, не обязательно полный месяц. После ручного ввода дополнительное окно не меняется автоматически с основным; кнопка сброса возвращает описанное правило. Можно задать любой отдельный период от 1 до 366 дней, в том числе вне основного; пересекающиеся окна нельзя складывать.</li>
              <li><strong>Выбор городов.</strong> Кнопка «Все города» снимает отметки: пустой параметр <code>city</code> означает отсутствие ограничения. Одна или несколько отметок ограничивают бизнес-листы этими городами. Экранный список — уникальные <code>stores.city</code> из чеков обоих годов основного периода, а не полный справочник городов; город только дополнительного периода может отсутствовать в этом списке, но попадёт в экспорт без ограничения. «Без города» означает, что город не удалось извлечь из исходного названия магазина, а не отдельный реальный город.</li>
              <li><strong>Охват проверки и количество точек.</strong> <code>getPresentationReport</code> отдельно вызывает <code>getYearComparison</code> для основного и дополнительного окон, всегда с автоматической сетью. Число сопоставимых точек в книге — количество физических ключей с положительными продажами в обоих годах соответствующего окна после фильтра городов; число может отличаться между окнами. Покрытие, стоимость и сверки на этом экране относятся лишь к основному окну без фильтра городов. В книге «Обзор и настройки», «Качество данных» и исходные аудиты проверяют всю сеть, включая невыбранные города.</li>
              <li><strong>Количество, выручка, чеки и ВД в книге.</strong> Это те же строки ККМ, исходные единицы и правила возврата/стоимости, которые объяснены ниже. Общий итог презентации включает все товары, услуги и несопоставленные строки, а не только шесть категорий подробного сравнения. Текущий вид и подкатегория берутся из <code>catalog_nomenklatura</code>, не из исторического состава продаж; неизвестный вид не угадывается. Чеки фиксированных общих групп считаются уникальными; чеки пересекающихся категорий не складываются. «ВД / выручка, %» — оценочный ВД, делённый на нетто выручку с НДС; это не процент изменения ВД.</li>
              <li><strong>Закупки поставщика, ₸.</strong> Сумма записанных <code>summa_dokumenta</code> проведённых, неудалённых <code>document_postuplenie_tovarov</code> за окно минус сумма модулей <code>summa_dokumenta</code> из <code>document_vozvrat_tovarov_postavschiku</code> по этому поставщику. Строки поступлений не подменяют заголовки, НДС автоматически не вычитается. Неизвестная сумма делает затронутый итог недоступным; настоящий ноль сохраняется. Город закупки определяется магазином документа, иначе магазином склада из <code>catalog_sklady</code>; город модельного дохода — магазином продажи. Совпадение этих городов не доказывает происхождение проданной партии.</li>
              <li><strong>Доход поставщика — модель, не факт партии.</strong> Для каждой исходной пары «магазин × товар» <code>presentation-suppliers.ts</code> ищет положительные по количеству строки поступлений в том же окне. Единственный известный поставщик при отсутствии строк с неизвестным поставщиком получает нетто выручку и оценочный ВД пары. Неизвестный поставщик, несколько поставщиков или отсутствие закупки дают отдельный нераспределённый остаток, без пропорционального разнесения. Текущий основной поставщик каталога не используется. Все распознанные поставщики сохранены без top-N; документы с пустой ссылкой остаются в качестве данных, не становятся вымышленным поставщиком и не входят в суммы распознанных поставщиков.</li>
              <li><strong>Известная часть ВД и покрытие модели.</strong> Известная часть ВД = <code>выручка − выручка без стоимости − известная оценочная стоимость</code>, а не полный ВД при пробелах цены. «Доля отнесённой выручки» = отнесённая поставщикам нетто выручка / вся нетто выручка выбранных городов; это не покрытие стоимости или ВД. Полный ВД модели недоступен при неоценённом существенном абсолютном количестве. Сопоставимые закупки и доход используют только исходные магазины выбранных физических точек соответствующей автоматической сети; при пустой сети — <code>n/a</code>, не ноль.</li>
              <li><strong>Доли и Excel-фильтры.</strong> Доля корневой группы = её текущее нетто количество, выручка или ВД / соответствующий итог всех корней этого города; доли поставщиков используют соответствующий итог поставщиков города. Знаменатели фиксированы: фильтр доли не превращает выбранные строки в 100%. Возвраты могут давать отрицательные доли или доли выше 100%; сумма городских долей не является долей сети. В презентационной книге финансовые «итоги видимых строк» пересчитываются через <code>SUBTOTAL</code>, но фиксированные DISTINCT-итоги не зависят от фильтра категорий. В подробной книге сравнения обычный фильтр строки не пересчитывает итоги.</li>
            </ul>
            <p className="context-note">Это пояснение выбора и области чисел, не замена инструкции книги. На листе «Методология» есть точные столбцы, формулы относительных изменений, условия <code>n/a</code>, источники, ограничения и особенности Excel-фильтров. В этих источниках нет доказанных дат открытия точек, исторической себестоимости продаж и подтверждённой связи проданной партии с поставщиком.</p>
          </details>
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
          <div className="export-coverage" aria-label="Наличие данных для сравнения" aria-describedby={`${guideId}-coverage`}>
            {preview.coverage.map((coverage) => (
              <dl key={coverage.period}>
                <dt>{coverage.period === "current" ? "Выбранный период" : "Сопоставленный период прошлого года"}</dt>
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
              <strong>Нет подходящих чеков за предыдущий период. Скачать отчёт можно; недоступная база, изменения и LFL будут n/a, а не нулями. </strong>
            ) : preview.coverage.some((coverage) => coverage.status !== "observed") ? (
              <strong>Есть дни без чеков. Скачать отчёт можно, но он не даёт полной картины продаж. </strong>
            ) : null}
            Наличие чеков не подтверждает полноту загрузки. День без подходящих чеков — не доказанная нулевая выручка.
          </div>
          <details className="report-disclosure">
            <summary id={`${guideId}-coverage`}>Как читать дни, чеки и даты в проверке покрытия</summary>
            <p>Карточки сверху и таблица «Периоды и наличие чеков» ниже показывают одни и те же поля <code>coverage</code> и <code>periods</code> ответа <code>/api/reports/year-comparison</code>. Это основное окно и его предыдущий год по всем товарам и всем наблюдаемым точкам: ручной состав сопоставимой сети, города презентации и дополнительное окно эти числа не меняют.</p>
            <ul>
              <li><strong>Период и выбранные даты.</strong> Начало — <code>periods[period].from</code>, включённый конец — <code>periods[period].to</code> минус один день. Это границы поиска, не первая и последняя продажи. Сопоставление предыдущих границ и пустое окно около 29 февраля объяснены в «Формат Excel, даты и календарное сопоставление».</li>
              <li><strong>«Дни с чеками: a из b» / «a / b».</strong> <code>a = coveredDays</code> — число разных календарных дат <code>document_chek_kkm.date::date</code> с хотя бы одним подходящим документом в окне. Даже день только с возвратом считается наблюдаемым. <code>b = expectedDays = to − from</code> в днях — длина календарного окна, включая выходные, без предположений о графике работы. Это счётчики дней, не доля выручки и не полнота каждого магазина. Если рассчитывать долю наблюдаемых дней, формула — <code>a / b</code> только при <code>b &gt; 0</code>; при пустом окне <code>0 / 0</code> не означает 0% или 100%.</li>
              <li><strong>«Чеки, включая возвраты».</strong> <code>receiptCount</code> — число записей заголовков ККМ (<code>ref_key</code>) за это окно: <code>posted = true</code>, <code>deletion_mark IS NOT TRUE</code>, <code>COALESCE(summa_dokumenta, 0) ≠ 0</code>. Удалённые, непроведённые, с нулевой или отсутствующей суммой исключены. Счётчик включает продажи, возвраты и другие подходящие документы, даже без товарных строк; это не количество товаров и не продажи минус число возвратов.</li>
              <li><strong>Не путать с чеками в Excel.</strong> На категорийных и презентационных листах <code>receiptCount</code> агрегата — уникальные положительные продажные документы (<code>summa_dokumenta &gt; 0</code>, операция не возврат), содержащие строки нужной группы. Возвратные чеки не входят в этот знаменатель. Поэтому число чеков группы может отличаться от экранного общего счётчика и его нельзя получать сложением пересекающихся категорий.</li>
              <li><strong>Первая и последняя даты с чеками.</strong> <code>dateFrom</code> / <code>dateTo</code> — календарные даты минимального и максимального времени подходящего чека в окне. Они могут быть внутри выбранного периода; не доказывают непрерывную историю между ними и не являются временем синхронизации. Если подходящих документов нет, обе даты отсутствуют и показано «нет дат с чеками», а не вымышленные граничные даты.</li>
              <li><strong>«Нет чеков», «не все дни», без предупреждения.</strong> Сервер задаёт <code>empty</code>, если <code>coveredDays = 0</code>; <code>observed</code>, если наблюдаются все ожидаемые дни; иначе <code>partial</code>. Наличие хотя бы одного документа каждый день не подтверждает загрузку всех чеков, полноту строк или активность каждой точки. Пропущенные дни перечислены в Excel; причины пропусков не устанавливаются автоматически. Настоящие нули счётчиков дней/документов сохраняются, но отсутствующая история сумм и база роста — <code>n/a</code>.</li>
            </ul>
            <p className="context-note">Источник — синхронизированные таблицы PostgreSQL в схеме из <code>PGSCHEMA</code>, не прямой запрос к 1С и не отчёты о розничных продажах. Проверка отражает доступный снимок; она не удостоверяет полноту загрузки первоисточника.</p>
          </details>
          {preview.quality.map((quality) => (
            quality.unvaluedQuantity > 1e-9 || (quality.difference !== null && Math.abs(quality.difference) > 0.01) ? (
              <div className="metric-note warning" role="note" aria-describedby={`${guideId}-quality`} key={quality.period}>
                <strong>{quality.period === "current" ? "Выбранный период" : "Предыдущий год"}. </strong>
                {quality.unvaluedQuantity > 1e-9 ? (
                  <span>Неизвестна себестоимость абсолютного количества {formatDecimal(quality.unvaluedQuantity, 3)} в учётных единицах товаров и услуг. Выручка этих строк после возвратов: {quality.unvaluedRevenue === null ? "нет данных" : `${formatDecimal(quality.unvaluedRevenue, 2)} ₸`}. Оценка валового дохода для итогов с такими позициями недоступна. </span>
                ) : null}
                {quality.difference !== null && Math.abs(quality.difference) > 0.01 ? (
                  <span>Расхождение «товарные строки − заголовки чеков»: {formatDecimal(quality.difference, 2)} ₸. В отчёте сохранены записанные суммы позиций; расхождение не распределяется между товарами.</span>
                ) : null}
              </div>
            ) : null
          ))}
          <details className="report-disclosure">
            <summary id={`${guideId}-quality`}>Себестоимость, возвраты и сверка сумм: что означают предупреждения</summary>
            <p>Поля <code>quality</code> относятся ко всем подходящим чекам и товарным строкам основного окна соответствующего года, а не только к выбранной категории, ручной сети или городам. Предупреждения показывают пробел стоимости и расхождение сумм отдельно: одно не объясняет автоматически другое.</p>
            <ul>
              <li><strong>Нетто и нормализация возврата.</strong> В <code>document_chek_kkm.vid_operatsii</code> сервер ищет «возврат» без учёта регистра. Для такого документа количество <code>kolichestvo</code>, сумма строки <code>summa</code> и сумма заголовка <code>summa_dokumenta</code> учитываются как <code>−ABS(исходное значение)</code>: уже отрицательный возврат не становится продажей. Для остальных документов сохраняется исходный знак. Нетто количество и выручка — суммы после этого преобразования; суммы продаж до возвратов и число возвратов не надо вычитать повторно.</li>
              <li><strong>«Абсолютное количество без себестоимости».</strong> <code>unvaluedQuantity = Σ |количество строки|</code> по парам «исходный магазин × товар», для которых не найдена цена соответствующего периода. Продажа 1 единицы и возврат 1 единицы дают 0 нетто, но 2 абсолютные единицы: пробел цены не погашается возвратом. Это смешанные учётные единицы товаров и услуг, не число одинаковых штук или литров; нормализации физических единиц нет.</li>
              <li><strong>«Выручка этих строк после возвратов», ₸.</strong> <code>unvaluedRevenue</code> — сумма нормализованных <code>document_chek_kkm_tovary.summa</code> строк с <code>|kolichestvo| &gt; 10⁻⁹</code> в парах без цены. Это нетто сумма с записанным НДС, не стоимость и не абсолютная сумма риска. Продажи и возвраты могут дать ноль или отрицательное значение даже при существенном количестве без стоимости; такой ноль не делает полный ВД известным. <code>null</code> отображается как «нет данных».</li>
              <li><strong>«Строки − заголовки», ₸.</strong> <code>difference = lineRevenue − headerRevenue</code>; строки связаны через <code>document_chek_kkm_tovary._parent_ref_key = document_chek_kkm.ref_key</code>. <code>lineRevenue</code> — нетто сумма всех записанных товарных строк, <code>headerRevenue</code> — нетто сумма заголовков подходящих чеков. Положительное число: строки больше заголовков; отрицательное: меньше. Это знаковая разница, не модуль и не процент. При отсутствии одной из сумм разница <code>null</code>; отсутствие показанного расхождения не означает успешную сверку. Разницу не распределяют по товарам и не исправляют за счёт НДС.</li>
              <li><strong>Когда показывается предупреждение.</strong> Неоценённое абсолютное количество должно быть больше <code>10⁻⁹</code>; модуль числового расхождения — больше <code>0,01 ₸</code>. Это пороги отображения, не разрешение считать неизвестную стоимость нулём. Количество на экране округлено до трёх знаков, суммы — до двух; округлённое значение может скрывать малый ненулевой остаток. В Excel сохраняются исходные расчётные значения.</li>
            </ul>
            <p><strong>Как определяется цена.</strong> <code>canonicalItemCostsCtes</code> в <code>cost-sql.ts</code> запускается отдельно для каждого окна на его исключённую границу <code>to</code>. Все источники строго раньше этой даты; найденная цена применяется к нетто количеству пары за весь период, а не выбирается на дату каждого чека. Это оценка по состоянию на конец периода, не историческая себестоимость проданных партий.</p>
            <ol>
              <li>Последняя подходящая цена <code>information_register_sebestoimost_nomenklatury_record_type.tsena</code> данного исходного магазина и товара: активность не <code>false</code>, цена положительная, <code>period &lt; to</code>.</li>
              <li>Последняя положительная <code>tsena</code> строк <code>document_ustanovka_sebestoimosti_tovary</code> проведённого, неудалённого документа <code>document_ustanovka_sebestoimosti</code> данного магазина.</li>
              <li>Последняя положительная цена этого товара из таких документов по всей сети. Это не обязательно документ с пустым магазином.</li>
              <li>Если предыдущих источников нет — <code>Σ(summa − COALESCE(summa_nds, 0)) / Σ(kolichestvo)</code> по положительным количествам и суммам строк проведённых, неудалённых поступлений за <code>[to − 90 дней, to)</code>. Это взвешенная закупочная цена без записанного НДС строк.</li>
            </ol>
            <p>Приоритет источников важнее их сравнительной свежести: используется первый доступный источник, не самая поздняя запись среди всех четырёх. Стоимость пары = нетто количество × цена; известная часть стоимости — сумма оценённых пар до объединения юридических ключей. Полная оценочная стоимость и <code>ВД = нетто выручка − стоимость</code> недоступны, если неоценённое абсолютное количество агрегата больше <code>10⁻⁹</code>. Цены регистров и установок сохраняются как записаны, а НДС розничной выручки не вычитается: результат не является P&amp;L без НДС.</p>
            <p><strong>Доля оценённого количества в Excel</strong> = <code>1 − unvaluedQuantity / absoluteQuantity</code>, где <code>absoluteQuantity = Σ |количество строки|</code>; при нулевом знаменателе — <code>n/a</code>. На экране показано количество без цены, а не эта доля. Это покрытие смешанных единиц, не доля выручки, не полнота загрузки и не подтверждение точности цены.</p>
            <p className="context-note">Ограничение SQL: отсутствующие <code>kolichestvo</code> и <code>summa</code> строк ККМ заменяются на 0 до расчёта (<code>COALESCE</code>), а заголовки с нулевой или отсутствующей суммой исключаются. Поэтому отсутствие предупреждений не доказывает заполнение всех исходных полей. После установки недостающей себестоимости в 1С нужны её синхронизация и новый расчёт; запись после конечной границы периода не меняет его оценку автоматически. Исходные пары и коды источников цены есть на листе «Оценка стоимости» обеих книг.</p>
          </details>
          {exportFormat === "comparison" ? (
          <fieldset className="export-cohort" aria-describedby={`${guideId}-stores`}>
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
            <details className="report-disclosure">
              <summary id={`${guideId}-stores`}>Магазины, ручной выбор и сопоставимая сеть</summary>
              <ul>
                <li><strong>Что здесь считается магазином.</strong> Одна строка и один выбранный ключ <code>stores.key</code> — физическая точка, не юридическое лицо. <code>sourceStoreKeys</code> объединяет исходные ссылки ККМ <code>magazin_key</code>. Из текущего <code>catalog_magaziny.description</code> берётся адресная часть от «г.»: регистр букв выравнивается, крайние пробелы удаляются, повторяющиеся пробелы заменяются одним. Совпавшие таким образом адреса объединяются; похожие адреса, разные сокращения и пунктуация не объединяются приблизительно. Без пригодного адреса используется исходный ключ. Стоимость и поставщик определяются по исходному магазину до этого объединения.</li>
                <li><strong>«Все магазины» — наблюдаемые, не весь справочник.</strong> Экранный список <code>preview.stores</code> содержит физические точки хотя бы с одним подходящим заголовком чека в любом из двух окон по всем товарам. В него могут попасть точки только с возвратами или чеками без строк; точки без таких документов обоих окон не включены. Итог всех точек в подробной книге не ограничивается ручным выбором. Сопоставимая сеть — его подмножество, а не дополнительная сумма: два итога нельзя складывать.</li>
                <li><strong>Число в «С продажами в обоих годах».</strong> <code>observedStoreCount</code> — количество строк <code>preview.stores</code>, где <code>comparableByActivity = true</code>. SQL требует хотя бы один невозвратный чек с <code>summa_dokumenta &gt; 0</code> в каждом окне по всем товарам. После объединения адресов это могут быть разные юридические ключи. Признак не зависит от категории товара, наличия цены или ручных отметок и не доказывает дату открытия, непрерывную работу либо полноту загрузки.</li>
                <li><strong>Число в «Выбрать вручную».</strong> <code>selectedKeys.length</code> — размер набора отмеченных физических ключей, без дубликатов. Он может отличаться от автоматического счётчика и сохраняется при переключении режимов; в автоматическом режиме этот ручной набор не определяет экспорт. При первой загрузке в него попадают точки с активностью в обоих годах. При смене основного периода сохраняются только ранее отмеченные ключи, оставшиеся в новом списке; новые точки сами не добавляются.</li>
                <li><strong>«Магазинов в сопоставимом сравнении».</strong> <code>comparableStoreCount</code> равен автоматическому счётчику при <code>cohort=observed</code>, иначе размеру ручного набора при <code>cohort=custom</code>. Это число физических точек, не число чеков, не процент покрытия и не количество магазинов справочника. Ноль — действительно пустой состав; показатели этой сети в книге недоступны (<code>n/a</code>), но общий итог наблюдаемых точек сохраняется.</li>
                <li><strong>Отметка и «Продажи в обоих периодах» — разные поля.</strong> Флажок «Выбор» меняет ручной набор для экспорта <code>comparableStore</code>. «Есть» / «Нет» — неизменённый признак <code>comparableByActivity</code>, описанный выше: «Нет» не означает, что точка никогда не работала. Вручную разрешено включить точку с «Нет», но такая выборка сама по себе не подтверждает сопоставимость и LFL.</li>
                <li><strong>Кнопки выбора.</strong> «Выбрать с продажами в обоих годах» заменяет весь ручной набор автоматическим составом. «Выбрать все» отмечает все физические точки экранного списка, включая точки только одного года и с возвратами. «Снять выбор» оставляет пустой ручной набор; это не удаление продаж из общего итога. Изменение выбора действует на скачиваемое сопоставимое сравнение, но не пересчитывает экранное покрытие и предупреждения.</li>
                <li><strong>Город, название и номер без названия.</strong> Город извлекается из первого слова после «г.» в текущем названии; если не найден, показано «Без города». Название — текущий адрес или запись справочника, не историческое название точки. «Магазин без названия №…» использует номер строки <code>index + 1</code> текущего списка: это ориентир интерфейса, не код 1С и не отдельный счётчик. Точные физические/исходные ключи и исходные названия сохранены на листе «Магазины»; в презентационной книге — «Магазины и исходные ключи».</li>
              </ul>
            </details>
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
                  <table className="data-table" aria-describedby={`${guideId}-stores`}>
                    <caption>Магазины для сопоставимого сравнения</caption>
                    <thead><tr><th scope="col">Выбор</th><th scope="col">Город</th><th scope="col">Магазин</th><th scope="col">Продажи в обоих периодах</th></tr></thead>
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
              <table className="data-table" aria-describedby={`${guideId}-coverage`}>
                <caption>Периоды и наличие чеков — вся наблюдаемая сеть основного окна</caption>
                <thead><tr><th scope="col">Период</th><th scope="col">Выбранные даты</th><th scope="col">Дни с чеками</th><th scope="col">Чеки, включая возвраты</th><th scope="col">Первая и последняя даты с чеками</th></tr></thead>
                <tbody>
                  {preview.coverage.map((coverage) => (
                    <tr key={coverage.period}>
                      <th scope="row">{coverage.period === "current" ? "Выбранный" : "Предыдущий год"}</th>
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
            <p className="context-note">Таблица повторяет экранную проверку основного окна без ограничений сети и городов. Каждое поле, включая даты активности и отношение дней, расшифровано в «Как читать дни, чеки и даты в проверке покрытия». Стоимость и сверка сумм — в отдельном пояснении предупреждений выше.</p>
            <ul>
              <li><strong>Абсолютное и относительное изменение.</strong> В книге абсолютная разница = текущее значение − предыдущее: количество в исходных единицах, деньги в тенге, чеки в документах. Относительное изменение = <code>текущее / предыдущее − 1</code>; дробь <code>0,20</code> показывается как <code>20%</code>. Переход со 100 до 120 означает рост 20%, не 120%. При нулевой базе или недоступной необходимой величине — <code>n/a</code>; отрицательную базу нужно читать вместе с исходными числами.</li>
              <li><strong>Проценты и процентные пункты не одно и то же.</strong> Рост суммы или ВД — относительный процент по формуле выше. Разность двух долей или марж в процентных пунктах = <code>(текущая доля − предыдущая доля) × 100</code>: с 20% до 25% — +5 п.п., но относительный рост самой доли +25%. На листах долей подробной книги показан только текущий период: изменение долей в п.п. там не рассчитывается. Столбец «ВД, %» подробного сравнения — рост ВД, а «ВД / выручка, %» презентационной книги — доля оценочного ВД в выручке, не рост.</li>
              <li><strong>Средние и возвраты.</strong> Количество на чек = нетто количество группы / уникальные положительные продажные чеки группы; сумма на чек = нетто выручка группы с НДС / те же чеки. Возвраты уменьшают числитель, но их документы не вычитаются из знаменателя. При нулевом знаменателе — <code>n/a</code>. На категорийном листе это сумма товаров категории, не всего многокатегорийного чека. Средние города/сети пересчитываются из общих сумм и чеков, не складываются из средних точек.</li>
              <li><strong>Где проверить состав.</strong> Категории берутся из текущей иерархии <code>catalog_nomenklatura</code>; это не подтверждённая историческая классификация. Объединённая категория подробного сравнения содержит шесть перечисленных на её листах членов, не все продажи и не «Мульти пак». Презентационный общий итог включает все товары/услуги. Состав и несопоставленные позиции доступны в «Классификация», исходные цены — в «Оценка стоимости».</li>
              <li><strong>Не дублировать инструкцию книги.</strong> На листе «Методология» уже есть разбор всех столбцов, долей, оформления, единиц, формул и источников. <code>n/a</code> означает недоступность, не ноль; тире в числовой ячейке означает настоящий ноль. Для подробного сравнения инструкция также находится в проекте: «Инструкция к аналитическому отчету год к году.md». Новый файл нужен после изменений и синхронизации 1С: открытие или ручная правка Excel не пересчитывают исходный состав чеков, классификацию, стоимость и выбранную сеть.</li>
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
