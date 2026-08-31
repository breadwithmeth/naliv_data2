import type { NextFunction, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export const sessionCookieName = "naliv_session";
export type UserRole = "admin" | "marketing";

export type SessionUser = {
  email: string;
  role: UserRole;
};

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser;
  }
}

export function signSession(user: SessionUser) {
  return jwt.sign(user, config.JWT_SECRET, {
    algorithm: "HS256",
    audience: "naliv-web",
    expiresIn: "12h",
    issuer: "naliv-analytics"
  });
}

export function credentialsMatch(provided: string, expected: string) {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function readSessionUser(payload: string | jwt.JwtPayload): SessionUser | null {
  if (typeof payload === "string") {
    return null;
  }

  const { email, role } = payload;
  if (typeof email !== "string" || (role !== "admin" && role !== "marketing")) {
    return null;
  }

  const configuredEmail =
    role === "admin" ? config.APP_ADMIN_EMAIL : config.APP_MARKETING_EMAIL;

  if (email.toLowerCase() !== configuredEmail.toLowerCase()) {
    return null;
  }

  return { email: configuredEmail, role };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[sessionCookieName];

  if (!token) {
    res.status(401).json({ error: "Требуется авторизация" });
    return;
  }

  try {
    const payload = jwt.verify(token, config.JWT_SECRET, {
      algorithms: ["HS256"],
      audience: "naliv-web",
      issuer: "naliv-analytics"
    });
    const user = readSessionUser(payload);

    if (!user) {
      throw new Error("Invalid session payload");
    }

    req.user = user;
    next();
  } catch {
    res.clearCookie(sessionCookieName, { path: "/" });
    res.status(401).json({ error: "Сессия истекла" });
  }
}

export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Требуется авторизация" });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({ error: "Недостаточно прав" });
      return;
    }

    next();
  };
}

export function restrictMarketingApiSurface(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (!req.user) {
    res.status(401).json({ error: "Требуется авторизация" });
    return;
  }

  const isMarketingPath =
    req.path === "/marketing" || req.path.startsWith("/marketing/");

  if (req.user.role === "marketing" && !isMarketingPath) {
    res.status(403).json({ error: "Недостаточно прав" });
    return;
  }

  next();
}
