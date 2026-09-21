export function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0
  }).format(value);
}

export function formatCompact(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

export function formatDecimal(value: number, maximumFractionDigits = 1) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits
  }).format(value);
}

export function formatMoney(value: number) {
  return `${formatNumber(value)} ₸`;
}

export function formatMoneyCompact(value: number) {
  return `${formatCompact(value)} ₸`;
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 Б";
  }

  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;

  return `${new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: scaled >= 10 ? 0 : 1
  }).format(scaled)} ${units[index]}`;
}

export function formatDate(value: string | null | undefined) {
  if (!value) {
    return "нет данных";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "нет данных";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function formatDurationSeconds(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "—";
  }

  if (value < 60) {
    return `${Math.round(value)} с`;
  }

  const minutes = Math.floor(value / 60);
  if (minutes < 60) {
    return `${minutes} мин ${String(Math.round(value - minutes * 60)).padStart(2, "0")} с`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${String(minutes - hours * 60).padStart(2, "0")} мин`;
}

export function formatCell(value: unknown) {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "number") {
    return formatNumber(value);
  }

  if (typeof value === "boolean") {
    return value ? "Да" : "Нет";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}
