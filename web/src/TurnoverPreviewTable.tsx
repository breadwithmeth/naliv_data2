import { Fragment, memo, useId, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ChevronRight } from "lucide-react";
import type { TurnoverPreview, TurnoverPreviewRow } from "./api";
import { formatNumber } from "./format";
import {
  completeTurnoverReport, hasKnownTurnoverUnit, includeTurnoverRow, turnoverCoefficientBand
} from "../../api/src/services/turnover-domain";
import {
  TURNOVER_IDLE_LABEL, turnoverStandardColumns, turnoverStandardDates, turnoverStandardTotalRows, turnoverStandardValue,
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
type GridColumn = { column: TurnoverStandardColumn; label: string; key: string; id: string };
type CategoryRange = { key: string; label: string; start: number; end: number; countLabel: string };
type StoreSection = { key: string | null; label: string; categories: CategoryRange[] };

type TableView = { report: TurnoverPreview; expanded: ReadonlySet<string>; showDays: boolean };

function categoryIndex(rows: readonly TurnoverPreviewRow[], splitStores: boolean) {
  const stores: StoreSection[] = [];
  let categoryCount = 0;
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
    store.categories.push({ key: JSON.stringify([storeKey, groupKey]), start, end, countLabel: formatNumber(end - start),
      label: groupKey === null ? "Без группы" : first.rootGroupName || "Группа без названия" });
    categoryCount++;
    start = end;
  }
  return { stores, categoryCount };
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

function StandardMetricCells({ metrics, columns, periodDays, rowHeaders }: {
  metrics: StandardMetrics; columns: readonly GridColumn[]; periodDays: number; rowHeaders?: string;
}) {
  return <>{columns.map(({ column, key, id }) => {
    const headers = rowHeaders && `${rowHeaders} ${id}`;
    const value = turnoverStandardValue(metrics, column, "quantity", periodDays);
    if (column.kind === "turnoverDays" && value === null && metrics.idleStock) {
      return <td key={key} headers={headers} className="turnover-idle-label" title="Есть остаток на конец периода, продаж и закупок не было">{TURNOVER_IDLE_LABEL}</td>;
    }
    return column.kind === "coefficient"
      ? <CoefficientCell key={key} value={value} headers={headers} />
      : <td key={key} headers={headers} className={`turnover-numeric${column.kind === "day" ? " turnover-preview-day" : ""}`}><PreviewNumber value={value} /></td>;
  })}</>;
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

const TotalRows = memo(function TotalRows({ label, total, byUnit, columns, periodDays, unitLabels, subtotal }: {
  label: string; total: TurnoverPreview["totals"]["overall"]; byUnit: TurnoverPreview["totals"]["byUnit"];
  columns: readonly GridColumn[]; periodDays: number; unitLabels: ReadonlyMap<string, string>; subtotal?: boolean;
}) {
  return <>{turnoverStandardTotalRows(label, total, byUnit, "quantity", unitLabels).map(({ key, label, row }, index) =>
    <tr key={key ?? label} className="turnover-overall-total" data-turnover-boundary={subtotal && index === 0 ? "subtotal" : undefined}>
      <th scope="row">{label}</th>
      <StandardMetricCells metrics={row} columns={columns} periodDays={periodDays} />
    </tr>)}</>;
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
    ...(hasUnlabelledQuantityTotal ? ["Общий итог недоступен: разные или неизвестные единицы."] : [])
  ];
  // The analytical endpoint also describes monetary data, orders and comparisons absent from this view.
  const warnings = report.warnings.filter((warning) => /^(Нельзя подтвердить отсутствие|Фильтрам не соответствуют|Нет снимка точно|Не во все дни выбранного периода|В части дней есть проведённые чеки|У части SKU нет подтверждённой|Итоги исходной выборки не показаны)/.test(warning));
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
  const columns = useMemo(() => turnoverStandardColumns(showDays ? days : []).map((column, i) => ({
    column, id: `${tableId}-c${i}`,
    label: column.kind === "day" && column.half ? `${column.label} ½` : column.label,
    key: column.kind === "day" ? `${column.date}:${column.half}` : column.kind
  })), [showDays, days, tableId]);
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
  const { viewport, table, context, afterCollapse, visibleBlocks, blockHeights } = useTurnoverPreviewViewport({
    open, report, expanded, showDays, virtualized
  });

  function toggleCategory(category: CategoryRange, button: HTMLButtonElement) {
    const next = new Set(expanded);
    if (next.delete(category.key)) afterCollapse.current = button;
    else next.add(category.key);
    setView({ ...view, expanded: next });
  }

  function expandAll() {
    const next = new Set<string>();
    for (const { categories } of index.stores) for (const { key } of categories) next.add(key);
    setView({ ...view, expanded: next });
  }

  function collapseAll() {
    afterCollapse.current = "start";
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
      <p className="turnover-note">{splitStores ? "По магазинам" : "Вся сеть"} · строк: {formatNumber(report.rows.length)}</p>
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
    <div ref={viewport} className="turnover-preview-scroll" role="region" aria-label="Таблица оборачиваемости" tabIndex={0}>
      <div className="turnover-preview-sticky" aria-hidden="true">
        {context.store ? <div className="turnover-preview-store"><span className="turnover-section-label">{context.store}</span></div> : null}
        {context.group ? <div className="turnover-preview-group"><span className="turnover-section-label">{context.group}</span></div> : null}
      </div>
      <table ref={table} id={tableId} className="turnover-preview-table"
        style={{ "--turnover-day-column-count": columns.length - 6 } as CSSProperties}>
        <caption className="turnover-visually-hidden">Оборачиваемость: количество в единицах товара</caption>
        <colgroup>
          <col className="turnover-preview-product-column" />
          {columns.map(({ key, column }) => <col key={key} className={column.kind === "day" ? "turnover-preview-day-column" : "turnover-preview-metric-column"} />)}
        </colgroup>
        <thead><tr>
          <th scope="col">Номенклатура</th>
          {columns.map(({ key, label, column, id }) => <th key={key} id={id} scope="col"
            className={column.kind === "day" ? "turnover-preview-date" : undefined}>{label}</th>)}
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
                <tbody><tr className="turnover-preview-group" data-turnover-boundary="group"><th id={groupId} abbr={category.label} scope="rowgroup" colSpan={columnCount}>
                  <button type="button" className="turnover-group-toggle" aria-expanded={isExpanded}
                    onClick={(event) => toggleCategory(category, event.currentTarget)}>
                    <ChevronRight size={16} aria-hidden="true" />
                    <span className="turnover-section-label">{category.label}</span>
                    <span className="turnover-group-count">{category.countLabel}</span>
                  </button>
                </th></tr></tbody>
                {isExpanded ? renderProducts(category, splitStores ? `${storeId} ${groupId}` : groupId) : null}
              </Fragment>;
            })}
            {subtotal ? <tbody><TotalRows label="ИТОГО по магазину" total={subtotal.total} byUnit={subtotal.byUnit}
              columns={columns} periodDays={days.length} unitLabels={unitLabels} subtotal /></tbody> : null}
          </Fragment>;
        })}
        {!report.rows.length ? <tbody><tr><td colSpan={columnCount} className="turnover-preview-empty"><span>{empty}</span></td></tr></tbody> : null}
        {report.rows.length ? <tfoot aria-label="Итог по всему отбору" data-turnover-boundary="overall">
          <TotalRows label="ИТОГО" total={report.totals.overall} byUnit={report.totals.byUnit}
            columns={columns} periodDays={days.length} unitLabels={unitLabels} />
        </tfoot> : null}
      </table>
    </div>
  </section>;
}
