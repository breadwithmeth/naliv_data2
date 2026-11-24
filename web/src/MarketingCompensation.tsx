import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import { api } from "./api";
import type {
  CompensationActivity, CompensationActivityOption, CompensationBranch, CompensationCalculationMode,
  CompensationIssue, CompensationRow, CompensationTotals, MarketingCompensationReport,
  ReportDateRange
} from "./api";
import { formatDate, formatNumber } from "./format";
import {
  type CompensationBasis, compensationBases, isInactiveCompensationActivity, isInactiveCompensationBranch,
  projectCompensationReport
} from "../../api/src/services/marketing-compensation-presentation";

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

function Issues({ issues, label }: { issues: CompensationIssue[]; label: string }) {
  if (!issues.length) return null;
  return <details className="compensation-issues">
    <summary>{label} ({formatNumber(issues.length)})</summary>
    <ul>{issues.map((issue, index) => <li key={`${issue.code}-${index}`}>{issue.message}</li>)}</ul>
  </details>;
}

function isIncomplete(totals: CompensationTotals): boolean {
  return !Number.isFinite(totals.compensation) || totals.incompleteRows > 0;
}

function Totals({ totals, includeIncomplete, filtered }: { totals: CompensationTotals; includeIncomplete: boolean; filtered: boolean }) {
  const incomplete = isIncomplete(totals) || filtered;
  return <div className="compensation-total-block">
    <dl className="compensation-totals">
      {!incomplete || includeIncomplete ? <div><dt>Итого компенсация</dt><dd>{incomplete ? "Не рассчитано" : money(totals.compensation)}</dd></div> : null}
      {incomplete ? <div><dt>Рассчитанная часть, не полный итог</dt><dd>{money(totals.knownCompensation)}</dd></div> : null}
    </dl>
    {incomplete ? <p className="compensation-incomplete">Расчёт неполный. Строк без расчёта: {formatNumber(totals.incompleteRows)}. Причины — в подробностях проверки.</p> : null}
  </div>;
}

function ScopeTotal({ totals, status, filtered = false }: { totals: CompensationTotals; status: string; filtered?: boolean }) {
  return <div className="compensation-scope-total">
    {isIncomplete(totals) || filtered ? <>
      <p className="compensation-incomplete">Нужна проверка · Расчёт неполный</p>
      <p className="compensation-note">Рассчитанная часть, не полный итог: <strong>{money(totals.knownCompensation)}</strong></p>
      <p className="compensation-note">Строк без расчёта: {formatNumber(totals.incompleteRows)}</p>
    </> : <>
      <p className="compensation-line-total">{money(totals.compensation)}</p>
      <p className={status === "Нужна проверка" ? "compensation-incomplete" : "compensation-note"}>{status}</p>
    </>}
  </div>;
}

function branchStatus(branch: CompensationBranch): string {
  if (isIncomplete(branch.totals)) return "Нужна проверка";
  if (isInactiveCompensationBranch(branch)) return "Без движений";
  if (!branch.hasSales && !branch.hasReturns) return "Нужна проверка";
  return !branch.hasSales && branch.hasReturns ? "Только возвраты / корректировки" : "Рассчитано";
}

function activityStatus(activity: CompensationActivity): string {
  if (isIncomplete(activity.totals) || !activity.branches.length || activity.issues.length
    || activity.branches.some((branch) => branchStatus(branch) === "Нужна проверка")) return "Нужна проверка";
  if (isInactiveCompensationActivity(activity)) return "Без движений";
  return !activity.branches.some((branch) => branch.hasSales) && activity.branches.some((branch) => branch.hasReturns)
    ? "Только возвраты / корректировки" : "Рассчитано";
}

function ItemRow({ row, basis }: { row: CompensationRow; basis: CompensationBasis }) {
  const calculationId = useId();
  const [expanded, setExpanded] = useState(false);
  return <>
    <tr>
      <th scope="row" className="compensation-item">{row.name}</th>
      <td className="num">{row.quantity === null ? "Нет данных" : decimalFormatter.format(row.quantity)}</td>
      <td className="num compensation-line-total">{money(row.compensation)}</td>
      <td><button type="button" className="compensation-button" aria-label={`Расчёт: ${row.name}`} aria-expanded={expanded} aria-controls={calculationId} onClick={() => setExpanded((current) => !current)}>Расчёт</button></td>
    </tr>
    <tr id={calculationId} className="compensation-calculation" hidden={!expanded}>
      <td colSpan={4}>
        {expanded ? <div className="compensation-calculation-content">
          <dl className="compensation-periods">
            {row.barcode ? <div><dt>Штрихкод</dt><dd className="compensation-barcode">{row.barcode}</dd></div> : null}
            <div><dt>{basis.priceLabel}</dt><dd>{money(row.price)}</dd></div>
            <div><dt>{basis.percentageLabel}</dt><dd>{row.discountPct === null ? "Нет данных" : `${decimalFormatter.format(row.discountPct)} %`}</dd></div>
            <div><dt>Компенсация на единицу</dt><dd>{money(row.unitCompensation)}</dd></div>
            <div><dt>Период расчёта</dt><dd>{periodLabel(row.from, row.to)}</dd></div>
          </dl>
          <Issues issues={row.issues} label="Подробности проверки строки" />
          {row.characteristicKey !== null ? <details className="compensation-method">
            <summary>Технические сведения</summary>
            <div><p>Ключ характеристики: {row.characteristicKey}</p></div>
          </details> : null}
        </div> : null}
      </td>
    </tr>
  </>;
}

function Branch({ branch, activityName, basis }: { branch: CompensationBranch; activityName: string; basis: CompensationBasis }) {
  const headingId = useId();
  const detailId = useId();
  const [expanded, setExpanded] = useState(false);
  return <section className="compensation-branch" aria-labelledby={headingId}>
    <div className="compensation-heading">
      <h4 id={headingId}>{branch.name}</h4>
      <ScopeTotal totals={branch.totals} status={branchStatus(branch)} filtered={(branch.excludedIncompleteRows ?? 0) > 0} />
      {branch.rows.length ? <button type="button" className="compensation-button" aria-expanded={expanded} aria-controls={detailId} aria-describedby={headingId} onClick={() => setExpanded((current) => !current)}>{expanded ? "Скрыть товары" : "Товары"}</button> : null}
    </div>
    <Issues issues={branch.issues} label="Подробности проверки магазина" />
    {branch.rows.length ? <div id={detailId} hidden={!expanded}>{expanded ? <>
      <div className="compensation-table-scroll" role="region" tabIndex={0} aria-label={`Товары: ${branch.name}, ${activityName}. Таблица с горизонтальной прокруткой.`}>
        <table className="compensation-table compensation-table-compact">
          <caption>Товары · строк: {formatNumber(branch.rows.length)}</caption>
          <thead><tr>
            <th scope="col">Товар</th>
            <th scope="col" className="num">Количество с учётом возвратов</th>
            <th scope="col" className="num">Компенсация, ₸</th>
            <th scope="col">Расчёт</th>
          </tr></thead>
          <tbody>{branch.rows.map((row) => <ItemRow key={JSON.stringify([row.itemKey, row.characteristicKey, row.from, row.to, row.price])} row={row} basis={basis} />)}</tbody>
        </table>
      </div>
    </> : null}</div> : <p className="compensation-note">{isInactiveCompensationBranch(branch)
      ? "За выбранный период продаж и возвратов не было."
      : "Товарных строк нет. Отсутствие данных не означает ноль; проверьте подробности проверки."}</p>}
  </section>;
}

function Activity({ activity, showInactive, basis }: { activity: CompensationActivity; showInactive: boolean; basis: CompensationBasis }) {
  const headingId = useId();
  const detailId = useId();
  const [expanded, setExpanded] = useState(false);
  const inactive = isInactiveCompensationActivity(activity);
  const hiddenBranches = activity.issues.length ? 0 : activity.branches.filter(isInactiveCompensationBranch).length;
  return <article className="compensation-activity" aria-labelledby={headingId}>
    <header className="compensation-heading compensation-activity-row">
      <div><h3 id={headingId}>{activity.name}</h3><p className="compensation-note">{periodLabel(activity.from, activity.to)}</p></div>
      <ScopeTotal totals={activity.totals} status={activityStatus(activity)} filtered={(activity.excludedIncompleteRows ?? 0) > 0 || (activity.excludedIncompleteBlocks ?? 0) > 0} />
      <button type="button" className="compensation-button" aria-expanded={expanded} aria-controls={detailId} aria-describedby={headingId} onClick={() => setExpanded((current) => !current)}>{expanded ? "Скрыть магазины" : "Магазины"}</button>
    </header>
    {inactive ? <p className="compensation-note">За выбранный период продаж и возвратов не было.</p> : null}
    <div id={detailId} hidden={!expanded}>{expanded ? <>
      <Issues issues={activity.issues} label="Подробности проверки акции" />
      {activity.branches.map((branch, index) => showInactive || activity.issues.length > 0 || !isInactiveCompensationBranch(branch)
        ? <Branch key={JSON.stringify([branch.key, index])} branch={branch} activityName={activity.name} basis={basis} /> : null)}
      {!activity.branches.length ? <p className="compensation-incomplete">Нужна проверка: магазины для акции не определены. Отсутствие данных не означает нулевую компенсацию.</p> : null}
      {!showInactive && hiddenBranches > 0 ? <p className="compensation-note">Магазины без движений скрыты. Чтобы увидеть их, включите «Показать без движений» над списком.</p> : null}
    </> : null}</div>
  </article>;
}

export function CompensationResults({ report: source, showInactive, includeIncomplete = source.includeIncomplete === true }: {
  report: MarketingCompensationReport; showInactive: boolean; includeIncomplete?: boolean;
}) {
  const report = projectCompensationReport(source, includeIncomplete);
  const basis = compensationBases[report.calculationMode];
  const excludedRows = report.excludedIncompleteRows ?? 0;
  const excludedBlocks = report.excludedIncompleteBlocks ?? 0;
  const filtered = excludedRows > 0 || excludedBlocks > 0;
  const excludedIssues = (report.excludedIncompleteDiagnostics ?? []).flatMap(entry => entry.issues.map(issue => ({
    code: issue.code, message: `${entry.activity.name}${entry.branch ? ` · ${entry.branch.name}` : ""}${entry.row ? ` · ${entry.row.name}` : ""}: ${issue.message}`
  })));
  const activities = report.activities.filter((activity) => showInactive || activity.key === report.activityKey || !isInactiveCompensationActivity(activity));
  const noMovements = !filtered && report.activities.length > 0 && !isIncomplete(report.totals) && report.issues.length === 0
    && report.activities.every(isInactiveCompensationActivity);
  return <>
    <section className="panel compensation-summary" aria-label="Общий итог компенсаций">
      <h3>Общий итог</h3>
      <p className="compensation-note">{periodLabel(report.from, report.to)}</p>
      <p className="compensation-note">{basis.title}</p>
      <Totals totals={report.totals} includeIncomplete={includeIncomplete} filtered={!includeIncomplete && filtered} />
      {!includeIncomplete && filtered ? <p className="compensation-note">Исключено строк без полного расчёта: {formatNumber(excludedRows)}; блоков без расчёта: {formatNumber(excludedBlocks)}. Чтобы вернуть их на сайт и в Excel, включите «Включить строки без полного расчёта».</p> : null}
    </section>
    {!activities.length ? <div className="compensation-empty">
      <h3>{filtered ? "Нет строк с полным расчётом" : noMovements ? "За выбранный период продаж и возвратов не было" : "Акций по выбранным условиям нет"}</h3>
      <p>{filtered ? "Включите «Включить строки без полного расчёта», чтобы увидеть исключённые строки и области расчёта." : noMovements ? "Пустые акции можно вернуть переключателем «Показать без движений»." : "Выберите другой период или «Все акции». Если расчёт неполный, проверьте подробности."}</p>
    </div> : null}
    {activities.map((activity) => <Activity key={activity.key} activity={activity} showInactive={showInactive} basis={basis} />)}
    <Issues issues={report.issues} label="Подробности проверки отчёта" />
    <Issues issues={excludedIssues} label="Подробности исключённых строк и блоков" />
  </>;
}

export function MarketingCompensation({ dateRange }: { dateRange: InclusiveDateRange }) {
  const headingId = useId();
  const selectorId = useId();
  const selectorHintId = useId();
  const modeLabelId = useId();
  const modeBasisId = useId();
  const { from, to } = dateRange;
  const periodKey = JSON.stringify([from, to]);
  const [selection, setSelection] = useState({ periodKey, key: "" });
  // A new period starts with all activities, never an invisible selection from the old period.
  const activityKey = selection.periodKey === periodKey ? selection.key : "";
  const [includeIncomplete, setIncludeIncomplete] = useState(false);
  const [calculationMode, setCalculationMode] = useState<CompensationCalculationMode>("purchase-title");
  const filters = useMemo(() => ({ from, to, activityKey: activityKey || undefined, includeIncomplete, calculationMode }),
    [from, to, activityKey, includeIncomplete, calculationMode]);
  const requestKey = JSON.stringify(filters);
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [reportAttempt, setReportAttempt] = useState(0);
  const [optionsState, setOptionsState] = useState<LoadState<CompensationActivityOption[]>>({ key: periodKey, status: "loading" });
  const [reportState, setReportState] = useState<LoadState<MarketingCompensationReport>>({ key: requestKey, status: "loading" });
  const [showInactive, setShowInactive] = useState(false);
  const [downloadState, setDownloadState] = useState<DownloadState | null>(null);
  const reportController = useRef<AbortController | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const options = optionsState.key === periodKey ? optionsState : null;
  const state = reportState.key === requestKey ? reportState : null;
  const download = downloadState?.key === requestKey ? downloadState : null;
  const report = state?.status === "success" ? state.data : null;
  const mode = report?.calculationMode ?? calculationMode;
  const basis = compensationBases[mode];
  const activities = options?.status === "success" ? options.data : [];
  const optionsPending = !options || options.status === "loading";
  const reportPending = !state || state.status === "loading";
  const inactiveCount = report?.activities.reduce((count, activity) => {
    if (isInactiveCompensationActivity(activity)) return count + 1;
    return count + (activity.issues.length ? 0 : activity.branches.filter(isInactiveCompensationBranch).length);
  }, 0) ?? 0;

  useEffect(() => {
    setShowInactive(false);
  }, [requestKey]);

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
    reportController.current = controller;
    setReportState({ key: requestKey, status: "loading" });
    api.marketingCompensationReport(filters, controller.signal).then((data) => {
      if (!controller.signal.aborted) setReportState({ key: requestKey, status: "success", data });
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setReportState({ key: requestKey, status: "error", error: caught instanceof Error ? caught.message : "Не удалось загрузить расчёт компенсаций." });
    });
    return () => {
      controller.abort();
      reportController.current = null;
    };
  }, [filters, requestKey, reportAttempt]);

  useLayoutEffect(() => {
    setDownloadState(null);
    return () => {
      downloadController.current?.abort();
      downloadController.current = null;
    };
  }, [requestKey]);

  function changeCalculationMode(legacy: boolean) {
    // Invalidate in the event, before React commits the new filters.
    reportController.current?.abort();
    downloadController.current?.abort();
    setCalculationMode(legacy ? "retail-rule" : "purchase-title");
  }

  async function downloadExcel() {
    if (!report || downloadController.current) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloadState({ key: requestKey, status: "loading" });
    try {
      const result = await api.marketingCompensationWorkbook({ ...filters, calculationMode: report.calculationMode }, controller.signal);
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
      <div><h2 id={headingId}>Компенсации</h2><p className="compensation-note">Итоги по акциям. Магазины и расчёт товаров — по запросу.</p></div>
      <button type="button" className="compensation-button compensation-download" disabled={!report || download?.status === "loading"} onClick={downloadExcel}>
        <Download size={17} aria-hidden="true" />{download?.status === "loading" ? "Готовим Excel…" : "Скачать Excel"}
      </button>
    </div>
    <div className="compensation-toolbar">
      <label className="compensation-field" htmlFor={selectorId}><span>Акция</span>
        <select id={selectorId} value={activityKey} disabled={optionsPending || options?.status === "error"} aria-describedby={selectorHintId} onChange={(event) => setSelection({ periodKey, key: event.target.value })}>
          <option value="">Все акции</option>
          {activityKey && !activities.some((activity) => activity.key === activityKey) ? <option value={activityKey}>Выбранная акция</option> : null}
          {activities.map((activity) => <option key={activity.key} value={activity.key}>{activity.name}</option>)}
        </select>
      </label>
      <p className="compensation-note" id={selectorHintId}>{formatDate(dateRange.from)} — {formatDate(dateRange.to)}, включительно</p>
      {optionsPending ? <p className="compensation-note" role="status">Загружаем список акций…</p> : null}
      {options?.status === "error" ? <div className="compensation-error" role="alert">
        <p>Не удалось загрузить список акций. Сам отчёт загружается отдельно.</p>
        <button type="button" className="compensation-button" onClick={() => setOptionsAttempt((attempt) => attempt + 1)}>Повторить</button>
        <details className="compensation-method"><summary>Подробности ошибки</summary><div><p>{options.error}</p></div></details>
      </div> : null}
      {options?.status === "success" && !activities.length ? <p className="compensation-note">Акций за выбранный период нет. Выберите другой период или проверьте подробности отчёта.</p> : null}
    </div>
    <label className="compensation-inactive-toggle compensation-mode-toggle">
      <input type="checkbox" role="switch" checked={calculationMode === "retail-rule"} aria-labelledby={modeLabelId} aria-describedby={modeBasisId} onChange={(event) => changeCalculationMode(event.target.checked)} />
      <span id={modeLabelId}>{compensationBases["retail-rule"].title}</span>
      <span className="compensation-note" id={modeBasisId}>{basis.priceLabel} · {basis.percentageLabel}</span>
    </label>
    <label className="compensation-inactive-toggle">
      <input type="checkbox" checked={includeIncomplete} onChange={(event) => setIncludeIncomplete(event.target.checked)} />
      <span>Включить строки без полного расчёта</span>
      <span className="compensation-note">Отбор применяется к сайту и Excel; отсутствие штрихкода не исключает строку</span>
    </label>
    {download?.status === "loading" ? <p className="compensation-note" role="status">Формируем Excel по всему выбранному отбору…</p> : null}
    {download?.status === "success" ? <p className="compensation-note" role="status">{download.message}</p> : null}
    {download?.status === "error" ? <div className="compensation-error" role="alert">
      <p>Не удалось скачать Excel. Повторите попытку.</p>
      <button type="button" className="compensation-button" onClick={downloadExcel}>Повторить</button>
      <details className="compensation-method"><summary>Подробности ошибки</summary><div><p>{download.message}</p></div></details>
    </div> : null}
    <details className="compensation-method">
      <summary>Как считается</summary>
      <div>
        {mode === "purchase-title" ? <>
          <p>{basis.priceSource} Используем последнюю установку не позже движения для товара, характеристики и базовой упаковки — только при подтверждённой цене. Для возврата берём дату и магазин возврата, а не исходной продажи. Вид закупа берём из текущей карточки магазина; история изменения этой привязки не учитывается. Розничную цену вместо закупочной не подставляем.</p>
          <p>{basis.percentageSource} Например, «Иртыш Сауда ноябрь 2026 26%» означает 26%; 2026 не участвует в расчёте. Правило скидки задаёт товары, магазины и сроки, но не процент.</p>
        </> : <>
          <p>Розничная цена до скидки — поле «Цена» той же строки продажи или возврата в 1С. Цена другой продажи, выручка и установки цен не подставляются.</p>
          <p>Процент — только префикс названия правила скидки, например «18,57% в строке…». Название акции и числовое поле скидки не используются. Товары берутся из сегмента номенклатуры правила.</p>
        </>}
        <p>Количество — продажи со своим знаком минус абсолютное количество возвратов. Разные цены одного товара показаны отдельными строками. Компенсация на единицу = цена × процент ÷ 100. Компенсация строки = сумма на единицу × нетто количество по этой цене. Округление HALF_UP до двух знаков: сначала на единицу, затем по строке. Итоги — сумма округлённых строк, включая корректировки возвратов.</p>
        <p>«Нет данных» не означает ноль. При нехватке данных полный итог не рассчитывается; известная часть показана отдельно. Отсутствие штрихкода само по себе не мешает денежному расчёту. Штрихкод берётся только из карточки товара, без подмены данными чеков.</p>
        <p>Один товар может входить в несколько активностей: компенсация рассчитывается для каждой отдельно, без распределения продаж между активностями.</p>
      </div>
    </details>
    <div className="compensation-results" aria-busy={reportPending}>
      {reportPending ? <div className="compensation-loading" role="status"><p>Загружаем расчёт компенсаций…</p><span>Данные предыдущего периода, отбора или режима не показываются.</span></div> : null}
      {state?.status === "error" ? <div className="compensation-error" role="alert">
        <p>Не удалось загрузить компенсации. Повторите попытку.</p>
        <button type="button" className="compensation-button" onClick={() => setReportAttempt((attempt) => attempt + 1)}>Повторить</button>
        <details className="compensation-method"><summary>Подробности ошибки</summary><div><p>{state.error}</p></div></details>
      </div> : null}
      {report ? <>
        <label className="compensation-inactive-toggle">
          <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />
          <span>Показать без движений ({formatNumber(inactiveCount)})</span>
          <span className="compensation-note">Акции и магазины с подтверждённым отсутствием продаж и возвратов</span>
        </label>
        <CompensationResults key={requestKey} report={report} showInactive={showInactive} includeIncomplete={includeIncomplete} />
      </> : null}
    </div>
  </section>;
}
