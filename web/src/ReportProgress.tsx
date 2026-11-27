import { useEffect, useState } from "react";
import type { ReportTransfer } from "./api";

const sizeFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
function dataSize(bytes: number) {
  if (bytes < 1000) return `${bytes} Б`;
  if (bytes < 1_000_000) return `${sizeFormat.format(bytes / 1000)} КБ`;
  return `${sizeFormat.format(bytes / 1_000_000)} МБ`;
}

export function ReportProgress({ transfer, excel = false }: { transfer: ReportTransfer; excel?: boolean }) {
  // Sample the active request, not the report tree, and don't render once per network chunk.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick(n => n + 1), 500);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.floor((performance.now() - transfer.startedAt) / 1000);
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const receiving = transfer.receivedBytes > 0;
  return <div className="report-progress">
    <div className="report-progress-line">
      <strong role="status">{receiving ? (excel ? "Получаем файл Excel" : "Получаем данные отчёта")
        : (excel ? "Ожидаем файл Excel" : "Ожидаем отчёт от сервера")}</strong>
      <span role="timer" aria-label="Прошло времени">{elapsed}</span>
    </div>
    <div className="report-progress-track" role="progressbar" aria-label={excel ? "Загрузка Excel" : "Загрузка отчёта"} />
    {receiving && <span className="report-progress-size">Получено: {dataSize(transfer.receivedBytes)}</span>}
  </div>;
}
