import assert from "node:assert/strict";
import { after, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";

process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";

const {
  requireAuth,
  requireRole,
  restrictMarketingApiSurface,
  sessionCookieName,
  signSession
} = await import("../src/middleware/auth.js");
const [
  { analyticsRouter },
  { inventoryRouter },
  { nomenclatureRouter },
  { reportsRouter }
] = await Promise.all([
  import("../src/routes/analytics.js"),
  import("../src/routes/inventory.js"),
  import("../src/routes/nomenclature.js"),
  import("../src/routes/reports.js")
]);

const app = express();
app.use(cookieParser());

app.get(
  ["/analytics/overview", "/reports/sales", "/nomenclature", "/inventory"],
  requireAuth,
  requireRole("admin"),
  (_req, res) => res.json({ sensitive: true })
);
app.get(
  "/marketing",
  requireAuth,
  restrictMarketingApiSurface,
  requireRole("admin", "marketing"),
  (_req, res) => res.json({ marketing: true })
);
app.get(
  "/future-unprotected-api",
  requireAuth,
  restrictMarketingApiSurface,
  (_req, res) => res.json({ accidentallyExposed: true })
);
app.use("/api/analytics", analyticsRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/nomenclature", nomenclatureRouter);
app.use("/api/inventory", inventoryRouter);

const server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Test server did not bind to a TCP port");
}

const baseUrl = `http://127.0.0.1:${address.port}`;

after(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
);

function sessionCookie(email: string, role: "admin" | "marketing") {
  const token = signSession({ email, role });
  return `${sessionCookieName}=${token}`;
}

test("marketing account can access the marketing API", async () => {
  const response = await fetch(`${baseUrl}/marketing`, {
    headers: {
      cookie: sessionCookie(process.env.APP_MARKETING_EMAIL!, "marketing")
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { marketing: true });
});

test("marketing account is denied every non-marketing data API", async () => {
  const cookie = sessionCookie(process.env.APP_MARKETING_EMAIL!, "marketing");
  const paths = [
    "/analytics/overview",
    "/reports/sales",
    "/nomenclature",
    "/inventory"
  ];

  for (const path of paths) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { error: "Недостаточно прав" }, path);
  }
});

test("real API routers deny direct and guessed non-marketing endpoints", async () => {
  const cookie = sessionCookie(process.env.APP_MARKETING_EMAIL!, "marketing");
  const paths = [
    "/api/analytics/overview",
    "/api/analytics/tables",
    "/api/analytics/tables/guessed_table",
    "/api/analytics/tables/guessed_table/timeseries?dateColumn=date",
    "/api/reports/sales",
    "/api/reports/income",
    "/api/nomenclature",
    "/api/inventory"
  ];

  for (const path of paths) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { error: "Недостаточно прав" }, path);
  }
});

test("deny-by-default API guard blocks a future unprotected scope", async () => {
  const response = await fetch(`${baseUrl}/future-unprotected-api`, {
    headers: {
      cookie: sessionCookie(process.env.APP_MARKETING_EMAIL!, "marketing")
    }
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Недостаточно прав" });
});

test("session role must match its configured account", async () => {
  const response = await fetch(`${baseUrl}/marketing`, {
    headers: {
      cookie: sessionCookie(process.env.APP_ADMIN_EMAIL!, "marketing")
    }
  });

  assert.equal(response.status, 401);
});

test("admin account retains access to all API groups", async () => {
  const cookie = sessionCookie(process.env.APP_ADMIN_EMAIL!, "admin");
  const paths = [
    "/analytics/overview",
    "/reports/sales",
    "/nomenclature",
    "/inventory",
    "/marketing"
  ];

  for (const path of paths) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
    assert.equal(response.status, 200, path);
  }
});
