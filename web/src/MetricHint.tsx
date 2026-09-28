import { Info } from "lucide-react";
import { metricDefinitions, type MetricId, type MetricStatus } from "./metric-definitions";

const statusLabels: Record<MetricStatus, string> = {
  ready: "Данные готовы",
  partial: "Неполные данные",
  experimental: "Предварительно",
  unavailable: "Источник недоступен"
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

  return (
    <details className="metric-help">
      <summary aria-label={`Как считается «${definition.title}»`} title="Как считается">
        <Info size={15} aria-hidden="true" />
      </summary>
      <div className="metric-help-popover" role="note">
        <strong>{definition.title}</strong>
        <p>{definition.short}</p>
        <div className="metric-formula">{definition.formula}</div>
        {status ? <span className={`metric-status ${status}`}>{statusLabels[status]}</span> : null}
        {coveragePct !== undefined ? <p>Покрытие: {coveragePct.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%</p> : null}
        {asOf ? <p>Данные на: {new Date(asOf).toLocaleDateString("ru-RU")}</p> : null}
        {reason ? <p className="metric-warning">{reason}</p> : null}
        <details className="metric-help-details">
          <summary>Подробнее</summary>
          {definition.howCalculated.length > 0 ? (
            <section>
              <b>Как считается</b>
              <ul>{definition.howCalculated.map((step) => <li key={step}>{step}</li>)}</ul>
            </section>
          ) : null}
          <section>
            <b>Источники</b>
            {definition.sources.length > 0 ? (
              <ul>
                {definition.sources.map((source) => (
                  <li key={`${source.system}:${source.entity}`}>
                    {source.system}: {source.entity}
                    {source.fields?.length ? ` — ${source.fields.join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            ) : <p>Расчётная метрика.</p>}
          </section>
          <dl>
            <div><dt>Детализация</dt><dd>{definition.grain}</dd></div>
            <div><dt>Период</dt><dd>{definition.periodRule}</dd></div>
            {definition.owner ? <div><dt>Ответственный</dt><dd>{definition.owner}</dd></div> : null}
          </dl>
          {definition.exclusions.length > 0 ? (
            <section><b>Исключения</b><ul>{definition.exclusions.map((item) => <li key={item}>{item}</li>)}</ul></section>
          ) : null}
          {definition.limitations.length > 0 ? (
            <section><b>Ограничения</b><ul>{definition.limitations.map((item) => <li key={item}>{item}</li>)}</ul></section>
          ) : null}
          {definition.interpretation ? (
            <section>
              <b>Как понимать</b>
              <ul>
                {definition.interpretation.normal ? <li>Норма: {definition.interpretation.normal}</li> : null}
                {definition.interpretation.warning ? <li>Внимание: {definition.interpretation.warning}</li> : null}
                {definition.interpretation.critical ? <li>Тревога: {definition.interpretation.critical}</li> : null}
              </ul>
            </section>
          ) : null}
        </details>
      </div>
    </details>
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
  children?: React.ReactNode;
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
