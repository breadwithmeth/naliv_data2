import { Info } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { metricDefinitions } from "./metric-definitions";
import type { MetricId, MetricSource, MetricStatus } from "./metric-definitions";

const statusLabels: Record<MetricStatus, string> = {
  ready: "Данные готовы",
  partial: "Неполные данные",
  experimental: "Предварительно",
  unavailable: "Нет данных для расчёта"
};

const sourceLabels: Record<MetricSource["system"], string> = {
  "1C": "1С",
  Bank: "Банк",
  Manual: "Ручной ввод",
  Derived: "Расчёт"
};

export function MetricHint({
  metricId,
  status,
  coveragePct,
  asOf,
  reason
}: {
  metricId: MetricId;
  status?: MetricStatus;
  coveragePct?: number;
  asOf?: string | null;
  reason?: string;
}) {
  const definition = metricDefinitions[metricId];
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !popover.current) return;
      const gutter = 16;
      if (window.innerWidth <= 760) {
        setPosition({ top: gutter, left: gutter, right: gutter });
        return;
      }
      const anchor = trigger.current.getBoundingClientRect();
      const box = popover.current.getBoundingClientRect();
      const left = Math.max(gutter, Math.min(anchor.left, window.innerWidth - box.width - gutter));
      const below = anchor.bottom + 8;
      const top = below + box.height <= window.innerHeight - gutter
        ? below
        : Math.max(gutter, Math.min(anchor.top - box.height - 8, window.innerHeight - box.height - gutter));
      setPosition({ top, left, right: "auto" });
    };
    place();
    popover.current?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !trigger.current?.contains(target) && !popover.current?.contains(target)) {
        setOpen(false);
      }
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [open]);

  return (
    <span className="metric-help">
      <button
        ref={trigger}
        type="button"
        className="metric-help-trigger"
        aria-label={`Объяснение показателя «${definition.title}»`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        title="Объяснение показателя"
        onClick={() => setOpen((current) => !current)}
      >
        <Info size={15} aria-hidden="true" />
      </button>
      {open ? createPortal(
        <div
          ref={popover}
          id={id}
          className="metric-help-popover"
          style={position}
          role="dialog"
          aria-labelledby={`${id}-title`}
          tabIndex={-1}
        >
          <button type="button" className="metric-help-close" aria-label="Закрыть объяснение" onClick={close}>Закрыть</button>
          <strong id={`${id}-title`}>{definition.title}</strong>
          <p>{definition.short}</p>
          {status ? <span className={`metric-status ${status}`}>{statusLabels[status]}</span> : null}
          {coveragePct !== undefined ? <p>Покрытие данными: {coveragePct.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%</p> : null}
          {asOf ? <p>Данные на {new Date(asOf).toLocaleDateString("ru-RU")}</p> : null}
          <div className="metric-help-section">
            <b>Расчёт</b>
            <p className="metric-formula">{definition.formula}</p>
            {definition.howCalculated.length > 0 ? (
              <ul>{definition.howCalculated.map((step) => <li key={step}>{step}</li>)}</ul>
            ) : null}
          </div>
          {reason || definition.limitations.length > 0 || definition.exclusions.length > 0 ? (
            <div className="metric-help-section">
              <b>Важно учитывать</b>
              {reason ? <p className="metric-warning">{reason}</p> : null}
              {definition.limitations.length > 0 ? (
                <ul>{definition.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
              ) : null}
              {definition.exclusions.length > 0 ? (
                <>
                  <p>Не включено в показатель:</p>
                  <ul>{definition.exclusions.map((item) => <li key={item}>{item}</li>)}</ul>
                </>
              ) : null}
            </div>
          ) : null}
          {definition.interpretation ? (
            <div className="metric-help-section">
              <b>Ориентиры для оценки</b>
              <ul>
                {definition.interpretation.normal ? <li>Ориентир: {definition.interpretation.normal}</li> : null}
                {definition.interpretation.warning ? <li>Требует внимания: {definition.interpretation.warning}</li> : null}
                {definition.interpretation.critical ? <li>Критическое значение: {definition.interpretation.critical}</li> : null}
              </ul>
            </div>
          ) : null}
          <div className="metric-help-section">
            <b>Основа расчёта</b>
            {definition.sources.length > 0 ? (
              <ul>{definition.sources.map((source) => (
                <li key={`${source.system}:${source.entity}`}>{sourceLabels[source.system]}: {source.entity}</li>
              ))}</ul>
            ) : <p>Расчётный показатель.</p>}
            <dl>
              <div><dt>Что сравниваем</dt><dd>{definition.grain}</dd></div>
              <div><dt>Период</dt><dd>{definition.periodRule}</dd></div>
              {definition.owner ? <div><dt>Ответственный</dt><dd>{definition.owner}</dd></div> : null}
            </dl>
          </div>
        </div>,
        document.body
      ) : null}
    </span>
  );
}

export function MetricLabel({
  metricId,
  children,
  status,
  coveragePct,
  asOf,
  reason
}: {
  metricId: MetricId;
  children?: ReactNode;
  status?: MetricStatus;
  coveragePct?: number;
  asOf?: string | null;
  reason?: string;
}) {
  return (
    <span className="metric-label">
      {children ?? metricDefinitions[metricId].title}
      <MetricHint metricId={metricId} status={status} coveragePct={coveragePct} asOf={asOf} reason={reason} />
    </span>
  );
}
