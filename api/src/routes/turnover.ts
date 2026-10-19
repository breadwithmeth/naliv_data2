import { Router } from "express";
import { Writable } from "node:stream";
import { loadCachedText, sendCachedJson } from "../lib/cached-json.js";
import { asyncHandler } from "../lib/http.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { getTurnoverOptions, getTurnoverReport, getTurnoverRow, turnoverQuerySchema } from "../services/turnover.js";
import { writeTurnoverWorkbook } from "../services/turnover-workbook.js";

export const turnoverRouter = Router();
turnoverRouter.use(requireAuth, requireRole("admin"));

turnoverRouter.get("/turnover", asyncHandler(async (req, res) => {
  const query = turnoverQuerySchema.parse(req.query);
  await sendCachedJson(req, res, ["getTurnoverPreview", query], async () => {
    const report = await getTurnoverReport(query);
    return {
      ...report,
      rows: report.rows.map(row => ({
        key: row.key, name: row.name, sku: row.sku, article: row.article,
        storeKey: row.storeKey, storeName: row.storeName, categoryName: row.categoryName, unit: row.unit,
        noSalesHistory: row.noSalesHistory, openingQty: row.openingQty, closingQty: row.closingQty,
        averageQty: row.averageQty, openingCost: row.openingCost, closingCost: row.closingCost,
        averageCost: row.averageCost, periodSales: row.periodSales, turnoverQty: row.turnoverQty,
        turnoverQtyDays: row.turnoverQtyDays, turnoverCost: row.turnoverCost,
        turnoverCostDays: row.turnoverCostDays, stockDays: row.stockDays, risks: row.risks,
        primaryAction: row.recommendations[0]?.action ?? null
      }))
    };
  });
}));

turnoverRouter.get("/turnover/options", asyncHandler(async (req, res) => {
  await sendCachedJson(req, res, ["getTurnoverOptions"], () => getTurnoverOptions());
}));

turnoverRouter.get("/turnover/row", asyncHandler(async (req, res) => {
  const query = turnoverQuerySchema.parse(req.query);
  await sendCachedJson(req, res, ["getTurnoverRow", query], () => getTurnoverRow(query));
}));

turnoverRouter.get("/turnover.xlsx", asyncHandler(async (req, res) => {
  const query = turnoverQuerySchema.parse(req.query);
  const started = performance.now();
  // The workbook is buffered once so a repeat download can be served without
  // rebuilding either the report or the XLSX archive. The LRU cap still applies.
  const snapshot = await loadCachedText(req, ["getTurnoverWorkbook", query], async () => {
    const report = await getTurnoverReport(query);
    const chunks: Buffer[] = [];
    const collector = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      }
    });
    const onClose = () => {
      if (!res.writableEnded) collector.destroy(new Error("Excel download was closed"));
    };
    res.once("close", onClose);
    try {
      await writeTurnoverWorkbook(report, collector);
    } finally {
      res.off("close", onClose);
    }
    return JSON.stringify({
      base64: Buffer.concat(chunks).toString("base64"),
      rows: report.summary.rowCount,
      generatedAt: report.generatedAt
    });
  });
  const payload = JSON.parse(snapshot.value) as { base64: string; rows: number; generatedAt: string };
  const buffer = Buffer.from(payload.base64, "base64");
  const filename = `turnover_${query.from}_${query.to}.xlsx`;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Report-Cache", snapshot.status);
  res.setHeader("X-Report-Rows", String(payload.rows));
  res.setHeader("X-Report-Generated-At", payload.generatedAt);
  res.setHeader("Server-Timing", `report;dur=${(performance.now() - started).toFixed(1)};desc="${snapshot.status}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Content-Length", String(buffer.length));
  res.end(buffer);
}));
