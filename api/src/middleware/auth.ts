import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export const sessionCookieName = "naliv_session";

export type SessionUser = {
  email: string;
};

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser;
  }
}

export function signSession(user: SessionUser) {
  return jwt.sign(user, config.JWT_SECRET, {
    expiresIn: "12h",
    issuer: "naliv-analytics"
  });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[sessionCookieName];

  if (!token) {
    res.status(401).json({ error: "Требуется авторизация" });
    return;
  }

  try {
    const payload = jwt.verify(token, config.JWT_SECRET, {
      issuer: "naliv-analytics"
    }) as SessionUser;
    req.user = { email: payload.email };
    next();
  } catch {
    res.clearCookie(sessionCookieName);
    res.status(401).json({ error: "Сессия истекла" });
  }
}
