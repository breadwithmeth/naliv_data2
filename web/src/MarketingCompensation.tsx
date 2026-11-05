import { useEffect, useId, useRef, useState } from "react";
import { Download } from "lucide-react";
import { api } from "./api";
import type {
  CompensationActivity, CompensationActivityOption, CompensationBranch,
  CompensationIssue, CompensationRow, CompensationTotals, MarketingCompensationReport,
  ReportDateRange
} from "./api";
import { formatDate, formatNumber } from "./format";

type InclusiveDateRange = Required<Pick<ReportDateRange, "from" | "to">>;
type LoadState<T> =
  | { key: string; status: "loading" }
  | { key: string; status: "success"; data: T }
  | { key: string; status: "error"; error: string };
type DownloadState = { key: string; status: "loading" | "success" | "error"; message?: string };
const moneyFormatter = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const decimalFormatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 6 });

function money(value: number | null): string {
  return value === null ? "Нет данных" : `${moneyFormatter.format(value)} ₸`;
}

// API response ends are exclusive; display the last included calendar day.
function periodLabel(from: string, to: string): string {
  const lastDay = new Date(Date.parse(to) - 86_400_000).toISOString().slice(0, 10);
  return `${formatDate(from)} — ${formatDate(lastDay)}`;
}

function Issues({ issues, label, expanded = false }: {
  issues: CompensationIssue[]; label: string; expanded?: boolean;
}) {
  if (!issues.length) return null;
  return <details className="compensation-issues" open={expanded || undefined}>
    <summary>{label} ({formatNumber(issues.length)})</summary>
    <ul>{issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul>
  </details>;
}

function Totals({ totals }: { totals: CompensationTotals }) {
  const incomplete = totals.compensation === null || totals.incompleteRows > 0;
  return <div className="compensation-total-block">
    <dl className="compensation-totals">
      <div><dt>Итого компенсация</dt><dd>{totals.compensation === null ? "Не рассчитана" : money(totals.compensation)}</dd></div>
      {incomplete ? <div><dt>Известная часть компенсации, не полный итог</dt><dd>{money(totals.knownCompensation)}</dd></div> : null}
    </dl>
    {incomplete ? <p className="compensation-incomplete">Расчёт неполный. Строк без полного расчёта: {formatNumber(totals.incompleteRows)}. Причины указаны в замечаниях.</p> : null}
  </div>;
}

function ItemRow({ row }: { row: CompensationRow }) {
  return <tr>
    <td className="compensation-barcode">{row.barcode ?? <span className="compensation-missing">Нет данных</span>}</td>
    <th scope="row" className="compensation-item">
      <span>{row.name}</span>
      {row.characteristicKey !== null ? <span className="compensation-row-note">Характеристика: {row.characteristicKey}</span> : null}
      <span className="compensation-row-note">Расчёт: {periodLabel(row.from, row.to)}</span>
      <Issues issues={row.issues} label="Замечания к строке" />
    </th>
    <td className="num">{money(row.price)}<span className="compensation-row-note">{row.priceDate ? `Установка: ${formatDate(row.priceDate)}` : "Дата установки неизвестна"}</span></td>
    <td className="num">{row.discountPct === null ? "Нет данных" : `${decimalFormatter.format(row.discountPct)} %`}</td>
    <td className="num">{money(row.unitCompensation)}</td>
    <td className="num">{row.quantity === null ? "Нет данных" : decimalFormatter.format(row.quantity)}</td>
    <td className="num compensation-line-total">{money(row.compensation)}</td>
  </tr>;
}

function Branch({ branch, activityName, expandSmallBranches }: {
  branch: CompensationBranch; activityName: string; expandSmallBranches: boolean;
}) {
  const headingId = useId();
  const detailId = useId();
  const [expanded, setExpanded] = useState(expandSmallBranches && branch.rows.length <= 200);
  return <section className="compensation-branch" aria-labelledby={headingId}>
    <div className="compensation-heading">
      <div><h4 id={headingId}>{branch.name}</h4><p className="compensation-note">Товарных строк: {formatNumber(branch.rows.length)}</p></div>
      {branch.rows.length ? <button type="button" className="compensation-button" aria-expanded={expanded} aria-controls={detailId} aria-describedby={headingId} onClick={() => setExpanded((current) => !current)}>{expanded ? "Скрыть товары" : "Показать товары"}</button> : null}
    </div>
    <Issues issues={branch.issues} label="Замечания к филиалу" />
    {branch.rows.length ? <div id={detailId} hidden={!expanded}>{expanded ? <>
      <p className="compensation-scroll-hint">На узком экране прокрутите таблицу по горизонтали.</p>
      <div className="compensation-table-scroll" role="region" tabIndex={0} aria-label={`Товары: ${branch.name}, ${activityName}. Таблица с горизонтальной прокруткой.`}>
        <table className="compensation-table">
          <caption>Детализация по товарам · строк: {formatNumber(branch.rows.length)}</caption>
          <thead><tr>
            <th scope="col">Штрихкод</th>
            <th scope="col">Полное наименование товара</th>
            <th scope="col" className="num">Закупочная цена, ₸</th>
            <th scope="col" className="num">Процент, %</th>
            <th scope="col" className="num">Компенсация на единицу, ₸</th>
            <th scope="col" className="num">Количество за вычетом возвратов</th>
            <th scope="col" className="num">Компенсация, ₸</th>
          </tr></thead>
          <tbody>{branch.rows.map((row, index) => <ItemRow key={`${row.itemKey}-${row.characteristicKey ?? ""}-${row.from}-${row.to}-${index}`} row={row} />)}</tbody>
        </table>
      </div>
    </> : null}</div> : <p className="compensation-note">За расчётный период в филиале нет строк для отображения. Проверьте замечания к отчёту и активности.</p>}
    <div className="compensation-branch-total"><h5>Итого по филиалу</h5><Totals totals={branch.totals} /></div>
  </section>;
}

function Activity({ activity, expandSmallBranches }: { activity: CompensationActivity; expandSmallBranches: boolean }) {
  const headingId = useId();
  return <article className="panel compensation-activity" aria-labelledby={headingId}>
    <header className="compensation-activity-heading">
      <h3 id={headingId}>{activity.name}{activity.number ? ` · № ${activity.number}` : ""}</h3>
      <dl className="compensation-periods">
        <div><dt>Срок активности</dt><dd>{formatDate(activity.startsOn)} — {formatDate(activity.endsOn)}</dd></div>
        <div><dt>Расчётный период</dt><dd>{periodLabel(activity.from, activity.to)}</dd></div>
      </dl>
      <Issues issues={activity.issues} label="Замечания к активности" />
    </header>
    {activity.branches.length ? activity.branches.map((branch, index) => <Branch key={`${branch.key ?? "unknown"}-${index}`} branch={branch} activityName={activity.name} expandSmallBranches={expandSmallBranches} />)
      : <p className="compensation-note">Для активности нет детализации по филиалам. Проверьте замечания: отсутствие данных не означает нулевую компенсацию.</p>}
    <footer className="compensation-activity-total"><h4>Итого по активности</h4><Totals totals={activity.totals} /></footer>
  </article>;
}

export function MarketingCompensation({ dateRange }: { dateRange: InclusiveDateRange }) {
  const headingId = useId();
  const selectorId = useId();
  const selectorHintId = useId();
  const periodKey = JSON.stringify([dateRange.from, dateRange.to]);
  const [selection, setSelection] = useState({ periodKey, key: "" });
  // A new period starts with all activities, never an invisible selection from the old period.
  const activityKey = selection.periodKey === periodKey ? selection.key : "";
  const requestKey = JSON.stringify([periodKey, activityKey]);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [reportAttempt, setReportAttempt] = useState(0);
  const [optionsState, setOptionsState] = useState<LoadState<CompensationActivityOption[]>>({ key: periodKey, status: "loading" });
  const [reportState, setReportState] = useState<LoadState<MarketingCompensationReport>>({ key: requestKey, status: "loading" });
  const [downloadState, setDownloadState] = useState<DownloadState | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const options = optionsState.key === periodKey ? optionsState : null;
  const state = reportState.key === requestKey ? reportState : null;
  const download = downloadState?.key === requestKey ? downloadState : null;
  const report = state?.status === "success" ? state.data : null;
  const activities = options?.status === "success" ? options.data : [];
  const optionsPending = !options || options.status === "loading";
  const reportPending = !state || state.status === "loading";

  useEffect(() => {
    const controller = new AbortController();
    setSelection((current) => current.periodKey === periodKey ? current : { periodKey, key: "" });
    setOptionsState({ key: periodKey, status: "loading" });
    api.marketingCompensationActivities(dateRange, controller.signal).then((data) => {
      if (!controller.signal.aborted) setOptionsState({ key: periodKey, status: "success", data: data.activities });
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setOptionsState({ key: periodKey, status: "error", error: caught instanceof Error ? caught.message : "Не удалось загрузить список активностей." });
    });
    return () => controller.abort();
  }, [dateRange.from, dateRange.to, periodKey, optionsAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    setReportState({ key: requestKey, status: "loading" });
    api.marketingCompensationReport({ ...dateRange, ...(activityKey ? { activityKey } : {}) }, controller.signal).then((data) => {
      if (!controller.signal.aborted) setReportState({ key: requestKey, status: "success", data });
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setReportState({ key: requestKey, status: "error", error: caught instanceof Error ? caught.message : "Не удалось загрузить расчёт компенсаций." });
    });
    return () => controller.abort();
  }, [dateRange.from, dateRange.to, activityKey, requestKey, reportAttempt]);

  useEffect(() => {
    setDownloadState(null);
    return () => {
      downloadController.current?.abort();
      downloadController.current = null;
    };
  }, [requestKey]);

  async function downloadExcel() {
    if (!report || downloadController.current) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloadState({ key: requestKey, status: "loading" });
    try {
      const result = await api.marketingCompensationWorkbook({ ...dateRange, ...(activityKey ? { activityKey } : {}) }, controller.signal);
      if (controller.signal.aborted || downloadController.current !== controller) return;
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadState({ key: requestKey, status: "success", message: `Файл «${result.filename}» подготовлен для скачивания.` });
    } catch (caught: unknown) {
      if (!controller.signal.aborted) setDownloadState({ key: requestKey, status: "error", message: caught instanceof Error ? caught.message : "Не удалось скачать Excel. Повторите выгрузку." });
    } finally {
      if (downloadController.current === controller) downloadController.current = null;
    }
  }

  return <section className="reports-section compensation-workspace" aria-labelledby={headingId}>
    <div className="compensation-heading">
      <div><h2 id={headingId}>Компенсации</h2><p className="compensation-note">Расчёт компенсаций от поставщиков по активностям и филиалам.</p></div>
      <button type="button" className="compensation-button compensation-download" disabled={!report || download?.status === "loading"} onClick={downloadExcel}>
        <Download size={17} aria-hidden="true" />{download?.status === "loading" ? "Готовим Excel…" : "Скачать Excel"}
      </button>
    </div>
    <div className="compensation-toolbar">
      <label className="compensation-field" htmlFor={selectorId}><span>Маркетинговая активность</span>
        <select id={selectorId} value={activityKey} disabled={optionsPending || options?.status === "error"} aria-describedby={selectorHintId} onChange={(event) => setSelection({ periodKey, key: event.target.value })}>
          <option value="">Все активности</option>
          {activityKey && !activities.some((activity) => activity.key === activityKey) ? <option value={activityKey}>Выбранная активность</option> : null}
          {activities.map((activity) => <option key={activity.key} value={activity.key}>{activity.name}{activity.number ? ` · № ${activity.number}` : ""}</option>)}
        </select>
      </label>
      <p className="compensation-note" id={selectorHintId}>Период: {formatDate(dateRange.from)} — {formatDate(dateRange.to)}, включительно. При смене периода показываются все активности.</p>
      {optionsPending ? <p className="compensation-note" role="status">Загружаем список активностей…</p> : null}
      {options?.status === "error" ? <div className="compensation-error" role="alert"><p>Список активностей недоступен: {options.error} Отчёт загружается отдельно.</p><button type="button" className="compensation-button" onClick={() => setOptionsAttempt((attempt) => attempt + 1)}>Повторить загрузку списка</button></div> : null}
      {options?.status === "success" && !activities.length ? <p className="compensation-note">В списке нет активностей за выбранный период. Проверьте замечания к отчёту или выберите другой период выше.</p> : null}
    </div>
    {download?.status === "loading" ? <p className="compensation-note" role="status">Формируем Excel за выбранный период и по выбранным активностям…</p> : null}
    {download?.status === "success" ? <p className="compensation-note" role="status">{download.message}</p> : null}
    {download?.status === "error" ? <div className="compensation-error" role="alert"><p>Не удалось выгрузить Excel: {download.message}</p><button type="button" className="compensation-button" onClick={downloadExcel}>Повторить выгрузку</button></div> : null}
    <details className="compensation-method">
      <summary>Как рассчитывается компенсация</summary>
      <div>
        <p>Закупочная цена — последняя действующая установка цены для товара и филиала на конец пересечения выбранного периода со сроком активности. Более узкие интервалы правил ограничивают количество в строках, но не меняют дату, на которую определяется цена. Фактическая дата установки цены указана в строке.</p>
        <p>Процент берётся из сохранённых условий активности в 1С. Он не рассчитывается по разнице розничной цены и цены продажи. Товары берутся из сегмента номенклатуры активности.</p>
        <p>Количество — продажи минус возвраты за расчётный период. Компенсация на единицу = закупочная цена × процент ÷ 100. Компенсация по строке = сумма на единицу × количество. Денежные значения округляются до двух знаков: сначала на единицу, затем по строке. Итоги складываются из округлённых строк.</p>
        <p>«Нет данных» не означает ноль. При нехватке данных полный итог не рассчитывается; известная часть показана отдельно. Отсутствие штрихкода само по себе не мешает денежному расчёту. Штрихкод берётся только из карточки товара, без подмены данными чеков.</p>
        <p>Один товар может входить в несколько активностей: компенсация рассчитывается для каждой отдельно, без распределения продаж между активностями.</p>
      </div>
    </details>
    <div className="compensation-results" aria-busy={reportPending}>
      {reportPending ? <div className="compensation-loading" role="status"><p>Загружаем расчёт компенсаций…</p><span>Данные предыдущего периода или отбора не показываются.</span></div> : null}
      {state?.status === "error" ? <div className="compensation-error" role="alert"><p>Не удалось загрузить компенсации: {state.error}</p><button type="button" className="compensation-button" onClick={() => setReportAttempt((attempt) => attempt + 1)}>Повторить загрузку отчёта</button></div> : null}
      {report ? <>
        <Issues issues={report.issues} label="Замечания к отчёту" expanded />
        <section className="panel compensation-summary" aria-label="Общий итог компенсаций">
          <h3>Общий итог</h3>
          <p className="compensation-note">{periodLabel(report.from, report.to)} · активностей: {formatNumber(report.activities.length)}</p>
          <Totals totals={report.totals} />
        </section>
        {!report.activities.length ? <div className="compensation-empty"><h3>Нет активностей для отображения</h3><p>Выберите другой период или «Все активности». Если есть замечания к отчёту, сначала проверьте их: отсутствие данных не означает нулевую компенсацию.</p></div> : null}
        {report.activities.map((activity) => <Activity key={activity.key} activity={activity} expandSmallBranches={report.activityKey !== null} />)}
      </> : null}
    </div>
  </section>;
}
