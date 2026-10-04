import { open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { finished } from "node:stream/promises";
import { parseArgs } from "node:util";
import { prisma } from "../prisma.js";
import { getPresentationReport, presentationReportQuerySchema } from "../services/presentation-report.js";
import { writePresentationReportWorkbook } from "../services/presentation-report-workbook.js";

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    "month-from": { type: "string" },
    "month-to": { type: "string" },
    city: { type: "string", multiple: true },
    output: { type: "string" }
  }
});

try {
  if (!values.output) throw new Error("Укажите --output. Даты --from/--to используют интервал [from,to), правая граница исключена.");
  const params = presentationReportQuerySchema.parse({
    from: values.from,
    to: values.to,
    monthFrom: values["month-from"],
    monthTo: values["month-to"],
    city: values.city
  });
  const report = await getPresentationReport(params);
  const destination = resolve(values.output);
  const file = await open(destination, "wx");
  const stream = file.createWriteStream({ autoClose: false });
  let complete = false;
  try {
    await writePresentationReportWorkbook(report, stream);
    await finished(stream);
    complete = true;
  } finally {
    stream.destroy();
    await file.close();
    if (!complete) await unlink(destination);
  }
  console.log(JSON.stringify({
    file: destination,
    generatedAt: report.generatedAt,
    periods: { main: report.main.sales.periods, detail: report.detail.sales.periods },
    city: params.city,
    coverage: {
      main: report.main.sales.coverage.map(({ missingDays, ...coverage }) => ({ ...coverage, missingDayCount: missingDays.length })),
      detail: report.detail.sales.coverage.map(({ missingDays, ...coverage }) => ({ ...coverage, missingDayCount: missingDays.length }))
    },
    supplierCount: new Set(report.main.suppliers.map((supplier) => supplier.supplierKey)).size
  }));
} catch (error) {
  const details = error as { name?: string; code?: string; issues?: { path: (string | number)[]; message: string }[] };
  console.error(details.issues
    ? details.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n")
    : `Отчёт не сформирован: ${details.code ?? details.name ?? "Ошибка"}. Проверьте параметры и путь; существующие файлы не перезаписываются.`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
