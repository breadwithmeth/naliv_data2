import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const configSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    PGSCHEMA: z.string().min(1).default("raw_1c"),
    DB_CONNECTION_LIMIT: z.coerce.number().int().positive().max(50).default(5),
    PORT: z.coerce.number().int().positive().default(4000),
    WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
    APP_ADMIN_EMAIL: z.string().email(),
    APP_ADMIN_PASSWORD: z.string().min(8),
    APP_MARKETING_EMAIL: z.string().email(),
    APP_MARKETING_PASSWORD: z.string().min(12),
    JWT_SECRET: z.string().min(24)
  })
  .superRefine((value, context) => {
    if (value.APP_ADMIN_EMAIL.toLowerCase() === value.APP_MARKETING_EMAIL.toLowerCase()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_MARKETING_EMAIL"],
        message: "Marketing and admin accounts must use different email addresses"
      });
    }

    if (value.APP_ADMIN_PASSWORD === value.APP_MARKETING_PASSWORD) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_MARKETING_PASSWORD"],
        message: "Marketing and admin accounts must use different passwords"
      });
    }
  });

export const config = configSchema.parse(process.env);
