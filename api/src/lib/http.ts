import type { NextFunction, Request, Response } from "express";

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (
    value &&
    typeof value === "object" &&
    "toJSON" in value &&
    typeof value.toJSON === "function"
  ) {
    return jsonSafe(value.toJSON());
  }

  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, jsonSafe(child)])
    );
  }

  return value;
}
