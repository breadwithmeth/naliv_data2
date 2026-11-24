import type ExcelJS from "exceljs";
import { TURNOVER_COEFFICIENT_THRESHOLDS, turnoverCoefficientBand } from "./turnover-domain.js";

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
  const { poorStart, mediumStart, goodStart } = TURNOVER_COEFFICIENT_THRESHOLDS;
  // Excel reads the background color of conditional fills, unlike static cell fills.
  sheet.addConditionalFormatting({
    ref: `${cell}:${column}${last}`,
    rules: [
      { type: "expression", priority: 1, formulae: [`AND(ISNUMBER(${cell}),${cell}>=${poorStart},${cell}<${mediumStart})`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: colors.red } }, font: { color: { argb: "FF1F2937" } } } },
      { type: "expression", priority: 2, formulae: [`AND(ISNUMBER(${cell}),${cell}>=${mediumStart},${cell}<${goodStart})`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: colors.orange } }, font: { color: { argb: "FF1F2937" } } } },
      { type: "expression", priority: 3, formulae: [`AND(ISNUMBER(${cell}),${cell}>=${goodStart})`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: colors.green } }, font: { color: { argb: "FF1F2937" } } } },
      // Neutral cells must also override an earlier static fill after recalculation.
      { type: "expression", priority: 4, formulae: [`IFERROR(OR(NOT(ISNUMBER(${cell})),${cell}<${poorStart}),TRUE)`], style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFFFFF" } } } }
    ]
  });
}
