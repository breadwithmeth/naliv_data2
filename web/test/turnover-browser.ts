import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { chromium, type BrowserContext, type Page, type Route } from "playwright";
import { createServer } from "vite";
import type { TurnoverOptions, User } from "../src/api";

export const previewPath = "/api/reports/turnover";
export const workbookPath = "/api/reports/turnover.xlsx";
export const workbookMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const appPath = "/#stock/turnover";
const user = { email: "turnover@example.test", role: "admin" } satisfies User;
const options = {
  stores: [{ key: "store-a", name: "Магазин А" }, { key: "store-b", name: "Магазин Б" }],
  warehouses: [{ key: "warehouse-a", name: "Склад А", storeKey: "store-a" }],
  categories: [{ key: "root", name: "Верхняя группа" }],
  brands: [{ key: "brand-a", name: "Бренд А" }]
} satisfies TurnoverOptions;

interface RequestCapture {
  readonly count: number;
  at(index: number): Promise<Route>;
}

export interface TurnoverBrowserSession {
  page: Page;
  context: BrowserContext;
  previews: RequestCapture;
  workbooks: RequestCapture;
  goto(): Promise<unknown>;
  readonly logoutCount: number;
}

export interface TurnoverBrowser {
  close(): Promise<void>;
  session(t: TestContext, settings?: { width?: number; path?: string; signedIn?: boolean }): Promise<TurnoverBrowserSession>;
}

function requests() {
  const entries: Route[] = [];
  const arrivals = new EventEmitter();
  return {
    get count() { return entries.length; },
    push(route: Route) {
      const index = entries.push(route) - 1;
      arrivals.emit(String(index), route);
    },
    async at(index: number): Promise<Route> {
      return entries[index] ?? (await once(arrivals, String(index), { signal: AbortSignal.timeout(10_000) }))[0];
    }
  };
}

export async function startTurnoverBrowser(): Promise<TurnoverBrowser> {
  const cache = await mkdtemp(join(tmpdir(), "naliv-turnover-vite-"));
  const vite = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    cacheDir: cache,
    configFile: false,
    envDir: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, hmr: false }
  }).catch(async error => {
    await rm(cache, { recursive: true, force: true });
    throw error;
  });
  const stopServer = async () => {
    await vite.close();
    await rm(cache, { recursive: true, force: true });
  };
  try {
    await vite.listen();
    const origin = vite.resolvedUrls!.local[0].replace(/\/$/, "");
    const browser = await chromium.launch({ executablePath: process.env.TURNOVER_CHROMIUM_EXECUTABLE || undefined });
    return {
      async close() {
        try { await browser.close(); }
        finally { await stopServer(); }
      },
      async session(t: TestContext, settings: { width?: number; path?: string; signedIn?: boolean } = {}) {
        const context = await browser.newContext({
          baseURL: origin, viewport: { width: settings.width ?? 1365, height: 768 }, serviceWorkers: "block"
        });
        const errors: string[] = [];
        t.after(async () => {
          await context.close();
          assert.deepEqual(errors, [], "unexpected app errors or unhandled fixture endpoints");
        });
        let signedIn = settings.signedIn ?? true;
        let logoutCount = 0;
        const previews = requests();
        const workbooks = requests();
        await context.route("**/*", async route => {
          const request = route.request();
          const { origin: requestOrigin, pathname } = new URL(request.url());
          if (requestOrigin !== origin) {
            errors.push(`external request: ${request.url()}`);
            return route.abort();
          }
          if (!pathname.startsWith("/api/")) return route.continue();
          const method = request.method();
          if (method === "GET" && pathname === "/api/auth/me") {
            return signedIn ? route.fulfill({ json: { user } }) : route.fulfill({ status: 401, json: { error: "Нет сессии" } });
          }
          if (method === "POST" && pathname === "/api/auth/login") {
            signedIn = true;
            return route.fulfill({ json: { user } });
          }
          if (method === "POST" && pathname === "/api/auth/logout") {
            logoutCount++;
            signedIn = false;
            return route.fulfill({ status: 204 });
          }
          if (signedIn && method === "GET") {
            if (pathname === `${previewPath}/options`) return route.fulfill({ json: options });
            if (pathname === previewPath) return previews.push(route);
            if (pathname === workbookPath) return workbooks.push(route);
          }
          errors.push(`${method} ${pathname}`);
          return route.fulfill({ status: 404, json: { error: "Unexpected fixture request" } });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(8_000);
        page.on("pageerror", error => { errors.push(error.message); });
        return {
          page, context, previews, workbooks,
          goto: () => page.goto(settings.path ?? appPath),
          get logoutCount() { return logoutCount; }
        };
      }
    };
  } catch (error) {
    await stopServer();
    throw error;
  }
}
