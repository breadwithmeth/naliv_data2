import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PGSCHEMA: z.string().min(1).default("raw_1c"),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  APP_ADMIN_EMAIL: z.string().email(),
  APP_ADMIN_PASSWORD: z.string().min(8),
  JWT_SECRET: z.string().min(24)
});

export const config = configSchema.parse(process.env);
