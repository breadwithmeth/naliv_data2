import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../lib/http.js";
import {
  credentialsMatch,
  requireAuth,
  sessionCookieName,
  signSession,
  type SessionUser
} from "../middleware/auth.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export const authRouter = Router();

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);

    const normalizedEmail = body.email.toLowerCase();
    const accounts: Array<SessionUser & { password: string }> = [
      {
        email: config.APP_ADMIN_EMAIL,
        password: config.APP_ADMIN_PASSWORD,
        role: "admin"
      },
      {
        email: config.APP_MARKETING_EMAIL,
        password: config.APP_MARKETING_PASSWORD,
        role: "marketing"
      }
    ];
    const account = accounts.find(
      (candidate) => candidate.email.toLowerCase() === normalizedEmail
    );
    const passwordMatches = credentialsMatch(
      body.password,
      account?.password ?? "invalid-account-password"
    );

    if (!account || !passwordMatches) {
      res.status(401).json({ error: "Неверный логин или пароль" });
      return;
    }

    const user: SessionUser = { email: account.email, role: account.role };
    const token = signSession(user);

    res.cookie(sessionCookieName, token, {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 60 * 60 * 1000
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({ user });
  })
);

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(sessionCookieName, { path: "/" });
  res.status(204).send();
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ user: req.user });
});
