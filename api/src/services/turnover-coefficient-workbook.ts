import type ExcelJS from "exceljs";
import { turnoverCoefficientBand } from "./turnover-domain.js";

const colors = { red: "FFFEE2E2", orange: "FFFFEDD5", green: "FFDCFCE7" };

export function styleTurnoverCoefficient(cell: ExcelJS.Cell, value: number | null): void {
  const band = turnoverCoefficientBand(value);
  if (band === null) return;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors[band] } };
  cell.font = { ...cell.font, color: { argb: "FF1F2937" } };
}

export function formatTurnoverCoefficientRange(sheet: ExcelJS.Worksheet, column: string, first: number, last: number): void {
  if (last < first) return;
  const cell = `${column}${first}`;
  sheet.addConditionalFormatting({
    ref: `${cell}:${column}${last}`,
    rules: [
      { type: "expression", priority: 1, formulae: [`AND(ISNUMBER(${cell}),${cell}<2)`], style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: colors.red } }, font: { color: { argb: "FF1F2937" } } } },
      { type: "expression", priority: 2, formulae: [`AND(ISNUMBER(${cell}),${cell}>=2,${cell}<3)`], style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: colors.orange } }, font: { color: { argb: "FF1F2937" } } } },
      { type: "expression", priority: 3, formulae: [`AND(ISNUMBER(${cell}),${cell}>=3)`], style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: colors.green } }, font: { color: { argb: "FF1F2937" } } } }
    ]
  });
}
