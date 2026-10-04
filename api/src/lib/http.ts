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
