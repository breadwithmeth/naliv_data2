import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../lib/http.js";
import { requireAuth, sessionCookieName, signSession } from "../middleware/auth.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export const authRouter = Router();

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);

    if (
      body.email.toLowerCase() !== config.APP_ADMIN_EMAIL.toLowerCase() ||
      body.password !== config.APP_ADMIN_PASSWORD
    ) {
      res.status(401).json({ error: "Неверный логин или пароль" });
      return;
    }

    const token = signSession({ email: config.APP_ADMIN_EMAIL });

    res.cookie(sessionCookieName, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 60 * 60 * 1000
    });

    res.json({ user: { email: config.APP_ADMIN_EMAIL } });
  })
);

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(sessionCookieName);
  res.status(204).send();
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});
