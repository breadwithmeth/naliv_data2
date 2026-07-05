import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";

function databaseUrlWithPoolLimit(url: string) {
  try {
    const parsed = new URL(url);

    if (!parsed.searchParams.has("connection_limit")) {
      parsed.searchParams.set("connection_limit", "1");
    }

    if (!parsed.searchParams.has("pool_timeout")) {
      parsed.searchParams.set("pool_timeout", "20");
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: databaseUrlWithPoolLimit(config.DATABASE_URL)
    }
  },
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
});
