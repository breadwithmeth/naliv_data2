import { Fragment, memo, useId, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ChevronRight } from "lucide-react";
import type { TurnoverPreview, TurnoverPreviewRow } from "./api";
import { formatNumber } from "./format";
import {
  completeTurnoverReport, hasKnownTurnoverUnit, includeTurnoverRow, turnoverCoefficientBand
} from "../../api/src/services/turnover-domain";
import {
  TURNOVER_IDLE_LABEL, turnoverStandardColumns, turnoverStandardDates, turnoverStandardValue,
  turnoverUnitDisplayName, turnoverUnitLabels
} from "../../api/src/services/turnover-presentation";
import type { TurnoverStandardColumn } from "../../api/src/services/turnover-presentation";
import { useTurnoverPreviewViewport } from "./useTurnoverPreviewViewport";

const COEFFICIENT_LABELS = { red: "Плохо", orange: "Средне", green: "Хорошо" } as const;
const METRIC_FORMAT = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const VIRTUAL_CELL_LIMIT = 20_000;
const PRODUCT_BLOCK_SIZE = 32;
const EMPTY_EXPANSION: ReadonlySet<string> = new Set();
type StandardMetrics = Pick<TurnoverPreviewRow,
  "daily" | "averageQty" | "averageCost" | "periodSales" | "idleStock" |
  "turnoverQty" | "turnoverQtyDays" | "turnoverCost" | "turnoverCostDays"
>;
const COST_COLUMNS = [
  { kind: "average", label: "Средний запас, ₸", title: "Средняя стоимость товарного запаса за период" },
  { kind: "sales", label: "Себестоимость продаж, ₸", title: "Проданное количество по учётным ценам, не розничная выручка" },
  { kind: "turnoverDays", label: "Дни оборота по себестоимости", title: "Длительность периода × средняя стоимость запаса / себестоимость продаж" }
] as const;
const FIXED_COLUMNS = turnoverStandardColumns([]).length + COST_COLUMNS.length;
type GridColumn = { column: TurnoverStandardColumn; basis: "money" | "quantity"; label: string; key: string; id: string; title?: string };
type CategoryRange = { key: string; label: string; start: number; end: number; countLabel: string };
type StoreSection = { key: string | null; label: string; categories: CategoryRange[] };

type TableView = { report: TurnoverPreview; expanded: ReadonlySet<string>; showDays: boolean };

function categoryIndex(rows: readonly TurnoverPreviewRow[], splitStores: boolean) {
  const stores: StoreSection[] = [];
  const byStart = new Map<number, CategoryRange>();
  let store: StoreSection | undefined;
  for (let start = 0; start < rows.length;) {
    const first = rows[start];
    const storeKey = splitStores ? first.storeKey : null;
    if (!store || store.key !== storeKey) {
      store = { key: storeKey, label: storeKey === null ? "Магазин не определён" : first.storeName || "Магазин не определён", categories: [] };
      stores.push(store);
    }
    const groupKey = first.rootGroupKey;
    let end = start + 1;
    while (end < rows.length && (!splitStores || rows[end].storeKey === storeKey) && rows[end].rootGroupKey === groupKey) end++;
    const category = { key: JSON.stringify([storeKey, groupKey]), start, end, countLabel: formatNumber(end - start),
      label: groupKey === null ? "Без группы" : first.rootGroupName || "Группа без названия" };
    store.categories.push(category);
    byStart.set(start, category);
    start = end;
  }
  return { stores, byStart, categoryCount: byStart.size };
}

function previewDate(value: string): string {
  const number = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : NaN;
  return Number.isFinite(number) && new Date(number).toISOString().slice(0, 10) === value
    ? new Date(number - 86_400_000).toISOString().slice(0, 10).split("-").reverse().join(".") : value;
}

function PreviewNumber({ value }: { value: number | null }) {
  return value !== null && Number.isFinite(value)
    ? <>{METRIC_FORMAT.format(value)}</>
    : <span aria-label="Показатель не рассчитан" title="Показатель не рассчитан"><span aria-hidden="true">—</span><span className="turnover-visually-hidden">Показатель не рассчитан</span></span>;
}

function CoefficientCell({ value, headers }: { value: number | null; headers?: string }) {
  const band = turnoverCoefficientBand(value);
  return <td headers={headers} className={`turnover-numeric${band ? ` turnover-coefficient-${band}` : ""}`}>
    <PreviewNumber value={value} />{band ? <span className="turnover-visually-hidden"> — {COEFFICIENT_LABELS[band]}</span> : null}
  </td>;
}

function StandardMetricCells({ metrics, columns, periodDays, rowHeaders, only }: {
  metrics: StandardMetrics; columns: readonly GridColumn[]; periodDays: number; rowHeaders: string; only?: GridColumn["basis"];
}) {
  const moneyStart = columns.length - COST_COLUMNS.length;
  const start = only === "money" ? moneyStart : 0;
  const end = only === "quantity" ? moneyStart : columns.length;
  const cells = [];
  for (let index = start; index < end; index++) {
    const { column, basis, key, id } = columns[index];
    const headers = `${rowHeaders} ${id}`;
    const isMoney = basis === "money";
    const value = turnoverStandardValue(metrics, column, basis, periodDays);
    if (!isMoney && column.kind === "turnoverDays" && value === null && metrics.idleStock) {
      cells.push(<td key={key} headers={headers} className="turnover-idle-label" title="Есть остаток на конец периода, продаж и закупок не было">{TURNOVER_IDLE_LABEL}</td>);
    } else {
      cells.push(column.kind === "coefficient"
        ? <CoefficientCell key={key} value={value} headers={headers} />
        : <td key={key} headers={headers} className={`turnover-numeric${isMoney ? " turnover-money" : column.kind === "day" ? " turnover-preview-day" : ""}`}><PreviewNumber value={value} /></td>);
    }
  }
  return <>
    {only === "money" && <td colSpan={start} />}
    {cells}
    {only === "quantity" && <td colSpan={COST_COLUMNS.length} className="turnover-money" />}
  </>;
}

const ProductRows = memo(function ProductRows({ rows, start, end, columns, periodDays, tableId, sectionHeaders }: {
  rows: readonly TurnoverPreviewRow[]; start: number; end: number; columns: readonly GridColumn[]; periodDays: number;
  tableId: string; sectionHeaders: string;
}) {
  const products = [];
  for (let index = start; index < end; index++) {
    const row = rows[index];
    const rowId = `${tableId}-r${index}`;
    products.push(<tr key={row.key}>
      <th id={rowId} headers={sectionHeaders} scope="row" className="turnover-preview-product">{row.name}
        {hasKnownTurnoverUnit(row.unit) ? <span className="turnover-preview-unit">{turnoverUnitDisplayName(row.unit)}</span> : null}
      </th>
      <StandardMetricCells metrics={row} columns={columns} periodDays={periodDays} rowHeaders={`${sectionHeaders} ${rowId}`} />
    </tr>);
  }
  return <>{products}</>;
});

const TotalRows = memo(function TotalRows({ id, label, total, byUnit, columns, periodDays, unitLabels, storeId }: {
  id: string; label: string; total: TurnoverPreview["totals"]["overall"]; byUnit: TurnoverPreview["totals"]["byUnit"];
  columns: readonly GridColumn[]; periodDays: number; unitLabels: ReadonlyMap<string, string>; storeId?: string;
}) {
  // A homogeneous scope sends its sole quantity total in total, not in byUnit.
  const singleUnit = byUnit.length ? null : total.unit;
  const singleUnitKey = total.daily[0]?.unitKey;

  function renderRow(basis: GridColumn["basis"], key: string, unit: string, metrics: StandardMetrics, index: number) {
    const rowId = `${id}-${index}`;
    const rowHeaders = storeId ? `${storeId} ${rowId}` : rowId;
    return <tr key={key} className={`turnover-overall-total turnover-${basis}-total`}
      data-turnover-boundary={storeId && index === 0 ? "subtotal" : undefined}>
      <th id={rowId} headers={storeId} scope="row">{label}, {unit}</th>
      <StandardMetricCells metrics={metrics} columns={columns} periodDays={periodDays} rowHeaders={rowHeaders} only={basis} />
    </tr>;
  }

  return <>
    {byUnit.length ? byUnit.map((unit, index) => renderRow("quantity", `unit:${unit.unitKey}`,
      unitLabels.get(unit.unitKey) ?? turnoverUnitDisplayName(unit.unit, unit.unitKey), unit, index))
      : singleUnit !== null && renderRow("quantity", `unit:${singleUnitKey ?? singleUnit}`,
        (singleUnitKey ? unitLabels.get(singleUnitKey) : undefined) ?? turnoverUnitDisplayName(singleUnit, singleUnitKey), total, 0)}
    {renderRow("money", "money", "₸", total, byUnit.length || Number(singleUnit !== null))}
  </>;
});

function previewNotices(report: TurnoverPreview) {
  const includeIncomplete = Boolean(report.params.includeIncomplete);
  const excludedIncompleteRows = report.excludedIncompleteRows ?? 0;
  const hasUnlabelledQuantityTotal = report.rows.length > 0 && (
    (report.totals.overall.unit === null && !report.totals.byUnit.length) ||
    report.totals.byStore.some(({ total, byUnit }) => total.unit === null && !byUnit.length)
  );
  const notices = [
    ...(report.coverage.requestedTo
      ? [`Период сокращён: по ${previewDate(report.params.to)} вместо ${previewDate(report.coverage.requestedTo)}.`] : []),
    ...(!includeIncomplete && excludedIncompleteRows > 0
      ? [`Исключено строк без полного расчёта: ${formatNumber(excludedIncompleteRows)}.`] : []),
    ...(includeIncomplete && report.rows.some((row) => !includeTurnoverRow(row, report.params))
      ? ["Включены строки без полного расчёта."] : []),
    ...(report.coverage.missingStockDates.length ? [
      `Нет дневных снимков остатков: ${formatNumber(report.coverage.missingStockDates.length)} из ${formatNumber(report.coverage.expectedDays)}.`
    ] : []),
    ...(hasUnlabelledQuantityTotal ? ["Количественный итог недоступен: разные или неизвестные единицы."] : [])
  ];
  // Keep warnings about visible figures; the analytical endpoint also describes orders and comparisons.
  const warnings = report.warnings.filter((warning) => /^(Нельзя подтвердить отсутствие|Фильтрам не соответствуют|Нет снимка точно|Не во все дни выбранного периода|В части дней есть проведённые чеки|У части SKU нет подтверждённой|Часть денежных показателей недоступна|Итоги исходной выборки не показаны)/.test(warning));
  const empty = excludedIncompleteRows > 0 && !includeIncomplete
    ? "Все строки по выбранным условиям исключены: нет полного расчёта. Закройте отчёт и измените параметры, чтобы включить такие строки."
    : "По выбранным условиям товаров нет. Закройте отчёт и измените параметры.";
  return { notices, warnings, empty };
}

export function TurnoverPreviewTable({ report: source, open = true }: { report: TurnoverPreview; open?: boolean }) {
  const report = useMemo(() => completeTurnoverReport(source), [source]);
  const [view, setView] = useState<TableView>({ report, expanded: EMPTY_EXPANSION, showDays: false });
  if (view.report !== report) setView({ report, expanded: EMPTY_EXPANSION, showDays: false });
  const { expanded, showDays } = view;
  const tableId = useId();
  const days = useMemo(() => turnoverStandardDates(report.params.from, report.params.to), [report.params.from, report.params.to]);
  const columns = useMemo<GridColumn[]>(() => [
    ...turnoverStandardColumns(showDays ? days : []).map((column, i) => ({
      column, basis: "quantity" as const, id: `${tableId}-c${i}`,
      label: column.kind === "day" && column.half ? `${column.label} ½` : column.label,
      key: column.kind === "day" ? `${column.date}:${column.half}` : column.kind
    })),
    ...COST_COLUMNS.map(column => ({
      column, basis: "money" as const, id: `${tableId}-cost-${column.kind}`, key: `cost-${column.kind}`,
      label: column.label, title: column.title
    }))
  ], [showDays, days, tableId]);
  const columnCount = columns.length + 1;
  const splitStores = report.params.profile !== "sample";
  const index = useMemo(() => categoryIndex(report.rows, splitStores), [report.rows, splitStores]);
  const storeTotals = useMemo(() => new Map(report.totals.byStore.map(total => [total.storeKey, total])), [report.totals.byStore]);
  const unitLabels = useMemo(() => turnoverUnitLabels(report.totals.byUnit), [report.totals.byUnit]);
  const { notices, warnings, empty } = useMemo(() => previewNotices(report), [report]);
  const openedRows = useMemo(() => {
    let count = 0;
    for (const { categories } of index.stores) {
      for (const { key, start, end } of categories) if (expanded.has(key)) count += end - start;
    }
    return count;
  }, [index, expanded]);
  const virtualized = openedRows * columnCount > VIRTUAL_CELL_LIMIT;
  const { viewport, table, context, visibleBlocks, blockHeights, jumpToStore, anchorCategory, releaseAnchor, scrollToStart } = useTurnoverPreviewViewport({
    open, report, expanded, showDays, virtualized
  });

  const pinned = context.groupStart === undefined ? undefined : index.byStart.get(context.groupStart);

  function categoryToggle(category: CategoryRange, sticky = false) {
    const isExpanded = expanded.has(category.key);
    const sourceId = `${tableId}-toggle${category.start}`;
    return <button type="button" className="turnover-group-toggle" id={sticky ? undefined : sourceId}
      aria-expanded={isExpanded} onClick={event => {
        const trigger = event.currentTarget;
        const source = sticky ? document.getElementById(sourceId) : trigger;
        if (!(source instanceof HTMLButtonElement)) return;
        anchorCategory(source, trigger);
        const next = new Set(expanded);
        if (isExpanded) next.delete(category.key); else next.add(category.key);
        setView({ ...view, expanded: next });
      }}>
      <span className="turnover-toggle-content"><ChevronRight size={16} aria-hidden="true" />
        <span className="turnover-section-label">{category.label}</span>
        <span className="turnover-group-count">{category.countLabel}</span>
      </span>
    </button>;
  }

  function expandAll() {
    releaseAnchor();
    const next = new Set<string>();
    for (const { categories } of index.stores) for (const { key } of categories) next.add(key);
    setView({ ...view, expanded: next });
  }

  function collapseAll() {
    scrollToStart();
    setView({ ...view, expanded: EMPTY_EXPANSION });
  }

  function renderProducts({ start, end }: CategoryRange, sectionHeaders: string) {
    const props = { rows: report.rows, columns, periodDays: days.length, tableId, sectionHeaders };
    if (!virtualized) return <tbody><ProductRows {...props} start={start} end={end} /></tbody>;
    const blocks = [];
    for (let blockStart = start; blockStart < end; blockStart += PRODUCT_BLOCK_SIZE) {
      const blockEnd = Math.min(end, blockStart + PRODUCT_BLOCK_SIZE);
      const visible = visibleBlocks.has(blockStart);
      blocks.push(<tbody key={blockStart} data-turnover-block={blockStart} data-turnover-live={visible ? "" : undefined}
        aria-hidden={visible ? undefined : true}>
        {visible ? <ProductRows {...props} start={blockStart} end={blockEnd} />
          : <tr className="turnover-preview-placeholder"><td colSpan={columnCount}
            style={{ height: blockHeights?.get(blockStart) ?? `calc(${blockEnd - blockStart} * var(--turnover-row-height))` }} /></tr>}
      </tbody>);
    }
    return blocks;
  }

  return <section className="turnover-preview-results" aria-label="Результаты отчёта">
    <header className="turnover-preview-toolbar">
      <p className="turnover-note">{splitStores ? "По магазинам" : "Вся сеть"} · строк: {formatNumber(report.rows.length)}
        {report.totals.byUnit.length > 0 && " · Суммы в ₸ — по всем единицам"}</p>
      {splitStores && index.stores.length > 1 && <select className="turnover-store-jump" aria-label="Перейти к магазину"
        aria-controls={tableId} defaultValue="" onChange={event => jumpToStore(event.target.value)}
        onBlur={event => { event.currentTarget.value = ""; }}>
        <option disabled value="">Перейти к магазину</option>
        {index.stores.map(({ label, categories }, i) => {
          const id = `${tableId}-s${categories[0].start}`;
          return <option key={id} value={id}>{i + 1}. {label}</option>;
        })}
      </select>}
      <div className="turnover-preview-controls">
        <button type="button" className="turnover-button" disabled={expanded.size === index.categoryCount} onClick={expandAll}>Раскрыть всё</button>
        <button type="button" className="turnover-button" disabled={expanded.size === 0} onClick={collapseAll}>Свернуть всё</button>
        {report.rows.length ? <button type="button" className="turnover-button" aria-expanded={showDays} aria-controls={tableId}
          onClick={() => setView({ ...view, showDays: !showDays })}>
          {showDays ? "Скрыть дни" : `Показать дни (${formatNumber(days.length)})`}
        </button> : null}
      </div>
    </header>
    {notices.length || warnings.length ? <div className="turnover-preview-notices">
      {notices.length ? <p className="turnover-note" role="status">{notices.join(" ")}</p> : null}
      {warnings.length ? <details className="turnover-preview-warnings">
        <summary>Предупреждения ({formatNumber(warnings.length)})</summary>
        <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      </details> : null}
    </div> : null}
    <div ref={viewport} className="turnover-preview-scroll" role="region" aria-label="Таблица оборачиваемости" tabIndex={0}
      onWheelCapture={releaseAnchor} onPointerDownCapture={releaseAnchor} onKeyDownCapture={releaseAnchor}>
      <div className="turnover-preview-sticky">
        {context.store ? <div className="turnover-preview-store" aria-hidden="true"><span className="turnover-section-label">{context.store}</span></div> : null}
        {pinned ? <div className="turnover-preview-group">{categoryToggle(pinned, true)}</div> : null}
      </div>
      <table ref={table} id={tableId} className={`turnover-preview-table${splitStores ? " turnover-by-store" : ""}`}
        style={{ "--turnover-metric-count": FIXED_COLUMNS, "--turnover-day-column-count": columns.length - FIXED_COLUMNS } as CSSProperties}>
        <caption className="turnover-visually-hidden">Оборачиваемость: количество в единицах товара и стоимость в тенге</caption>
        <colgroup>
          <col className="turnover-preview-product-column" />
          {columns.map(({ key, column }) => <col key={key} className={column.kind === "day" ? "turnover-preview-day-column" : "turnover-preview-metric-column"} />)}
        </colgroup>
        <thead><tr>
          <th scope="col">Номенклатура</th>
          {columns.map(({ key, label, column, id, basis, title }) => <th key={key} id={id} scope="col" title={title}
            className={basis === "money" ? "turnover-money" : column.kind === "day" ? "turnover-preview-date" : undefined}>{label}</th>)}
        </tr></thead>
        {index.stores.map(({ key, label, categories }) => {
          const subtotal = splitStores ? storeTotals.get(key) : undefined;
          const storeId = `${tableId}-s${categories[0].start}`;
          return <Fragment key={key === null ? "null" : `store:${key}`}>
            {splitStores ? <tbody><tr className="turnover-preview-store" data-turnover-boundary="store"><th id={storeId} scope="rowgroup" colSpan={columnCount}>
              <span className="turnover-section-label">{label}</span>
            </th></tr></tbody> : null}
            {categories.map((category) => {
              const isExpanded = expanded.has(category.key);
              const groupId = `${tableId}-g${category.start}`;
              return <Fragment key={category.key}>
                <tbody><tr className="turnover-preview-group" data-turnover-boundary="group" data-group-start={category.start}><th id={groupId} abbr={category.label} scope="rowgroup" colSpan={columnCount}>
                  {categoryToggle(category)}
                </th></tr></tbody>
                {isExpanded ? renderProducts(category, splitStores ? `${storeId} ${groupId}` : groupId) : null}
              </Fragment>;
            })}
            {subtotal ? <tbody><TotalRows id={`${storeId}-total`} label="ИТОГО по магазину" total={subtotal.total} byUnit={subtotal.byUnit}
              columns={columns} periodDays={days.length} unitLabels={unitLabels} storeId={storeId} /></tbody> : null}
          </Fragment>;
        })}
        {!report.rows.length ? <tbody><tr><td colSpan={columnCount} className="turnover-preview-empty"><span>{empty}</span></td></tr></tbody> : null}
        {report.rows.length ? <tfoot aria-label="Итог по всему отбору" data-turnover-boundary="overall">
          <TotalRows id={`${tableId}-total`} label="ИТОГО по всему отбору" total={report.totals.overall} byUnit={report.totals.byUnit}
            columns={columns} periodDays={days.length} unitLabels={unitLabels} />
        </tfoot> : null}
      </table>
    </div>
  </section>;
}
