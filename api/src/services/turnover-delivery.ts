import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { stringifyJson } from "../lib/http.js";
import { getTurnoverPreview, getTurnoverReport, getTurnoverRow, turnoverQuerySchema } from "./turnover.js";
import { writeTurnoverWorkbook } from "./turnover-workbook.js";

export async function deliverTurnover(
  kind: "turnover-preview" | "turnover-row" | "turnover-xlsx",
  query: unknown,
  output: Writable,
  headers: (values: Record<string, string>) => void
): Promise<void> {
  const params = turnoverQuerySchema.parse(query);
  if (kind === "turnover-xlsx") {
    const report = await getTurnoverReport(params);
    const filename = `turnover_${params.from}_${report.params.to}.xlsx`;
    headers({
      "X-Report-Rows": String(report.summary.rowCount),
      "X-Report-Generated-At": report.generatedAt,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    });
    await writeTurnoverWorkbook(report, output);
    return;
  }

  const json = stringifyJson(kind === "turnover-preview" ? await getTurnoverPreview(params) : await getTurnoverRow(params));
  headers({});
  const flushed = finished(output, { readable: false, cleanup: true });
  output.end(json);
  await flushed;
}
