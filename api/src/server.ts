import { existsSync } from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import compression from "compression";
import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import { config } from "./config.js";
import { analyticsRouter } from "./routes/analytics.js";
import { authRouter } from "./routes/auth.js";
import { inventoryRouter } from "./routes/inventory.js";
import { marketingRouter } from "./routes/marketing.js";
import { managementRouter } from "./routes/management.js";
import { requireAuth, restrictMarketingApiSurface } from "./middleware/auth.js";
import { nomenclatureRouter } from "./routes/nomenclature.js";
import { reportsRouter } from "./routes/reports.js";
import { syncRouter } from "./routes/sync.js";

const app = express();
app.use(compression({ threshold: 1024 }));

app.use(
  cors({
    origin: config.WEB_ORIGIN,
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);
app.use("/api", requireAuth, restrictMarketingApiSurface);
app.use("/api/analytics", analyticsRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/nomenclature", nomenclatureRouter);
app.use("/api/marketing", marketingRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/management", managementRouter);
app.use("/api/sync", syncRouter);

const clientDistPath = path.resolve(process.cwd(), "web/dist");

if (existsSync(clientDistPath)) {
  app.use("/assets", express.static(path.join(clientDistPath, "assets"), {
    maxAge: "1y",
    immutable: true
  }));
  app.use(express.static(clientDistPath, {
    maxAge: 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    }
  }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }

    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (res.headersSent || res.destroyed) {
      next(error);
      return;
    }
    if (error instanceof ZodError) {
      res.status(400).json({ error: "Некорректный запрос", details: error.flatten() });
      return;
    }

    const knownError = error as Error & { statusCode?: number };
    const statusCode = knownError.statusCode ?? 500;

    res.status(statusCode).json({
      error: knownError.message || "Внутренняя ошибка сервера"
    });
  }
);

app.listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}`);
});
