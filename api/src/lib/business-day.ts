const businessCalendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Qyzylorda", year: "numeric", month: "2-digit", day: "2-digit"
});

export function businessToday(now = new Date()): string {
  return businessCalendar.format(now);
}
