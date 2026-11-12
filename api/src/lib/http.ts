import type { NextFunction, Request, Response } from "express";

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

/** Native JSON encoding avoids recursively copying large analytics payloads. */
export function stringifyJson(value: unknown) {
  return JSON.stringify(value, (_key, child) => typeof child === "bigint" ? Number(child) : child);
}

/** Readiness is the only known error adding a machine-readable code. */
export function sendReloadIncompleteError(error: unknown, res: Response): boolean {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ANALYTICS_RELOAD_INCOMPLETE" || !("statusCode" in error) || error.statusCode !== 503) return false;
  res.setHeader("Cache-Control", "no-store");
  res.status(503).json({ error: error.message, code: "ANALYTICS_RELOAD_INCOMPLETE" });
  return true;
}
