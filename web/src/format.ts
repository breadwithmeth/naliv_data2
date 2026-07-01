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
