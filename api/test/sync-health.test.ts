import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import cookieParser from "cookie-parser";
import express from "express";

// The route reads `ops.sync_runs`, which only exists once the scheduler in
// naliv_data1 has recorded a run; both states are valid answers here.
const hasDatabase = Boolean(process.env.ANALYTICS_TEST_DATABASE_URL);
process.env.DATABASE_URL =
  process.env.ANALYTICS_TEST_DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
process.env.APP_ADMIN_EMAIL ??= "admin@test.local";
process.env.APP_ADMIN_PASSWORD ??= "admin-test-password";
process.env.APP_MARKETING_EMAIL ??= "marketing@test.local";
process.env.APP_MARKETING_PASSWORD ??= "marketing-test-password";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-24-characters";

const { sessionCookieName, signSession } = await import("../src/middleware/auth.js");
const { syncRouter } = await import("../src/routes/sync.js");
const { SYNC_STALE_AFTER_HOURS, SYNC_TABLE_GROUPS, getSyncHealth } = await import(
  "../src/services/sync-health.js"
);
const { prisma } = await import("../src/prisma.js");

const app = express();
app.use(cookieParser());
app.use("/api/sync", syncRouter);

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  server.close();
  await prisma.$disconnect();
});

function sessionCookie(role: "admin" | "marketing") {
  const email = role === "admin" ? "admin@test.local" : "marketing@test.local";
  return `${sessionCookieName}=${signSession({ email, role })}`;
}

test("sync health requires an admin session", async () => {
  const anonymous = await fetch(`${base}/api/sync/health`);
  assert.equal(anonymous.status, 401);

  const marketing = await fetch(`${base}/api/sync/health`, {
    headers: { cookie: sessionCookie("marketing") }
  });
  assert.equal(marketing.status, 403);
});

test("admin sees the run record and the per-table freshness", {
  skip: !hasDatabase
}, async () => {
  const response = await fetch(`${base}/api/sync/health`, {
    headers: { cookie: sessionCookie("admin") }
  });
  assert.equal(response.status, 200);

  const health = await response.json();
  assert.equal(typeof health.available, "boolean");
  assert.equal(health.staleAfterHours, SYNC_STALE_AFTER_HOURS);
  assert.deepEqual(
    health.groups.map((group: { title: string }) => group.title),
    SYNC_TABLE_GROUPS.map((group) => group.title)
  );

  for (const group of health.groups) {
    assert.ok(group.tables.length > 0, `нет таблиц в группе «${group.title}»`);
    for (const row of group.tables) {
      assert.equal(typeof row.rows, "number");
      assert.equal(typeof row.unchangedForOverTwoDays, "boolean");
    }
  }

  if (!health.available) {
    assert.deepEqual(health.runs, []);
    assert.equal(health.latest, null);
    return;
  }

  assert.ok(health.runs.length <= 10);
  if (health.runs.length === 0) {
    // The scheduler creates the table on its first run; an empty one is valid.
    assert.equal(health.latest, null);
    return;
  }

  assert.equal(health.latest.id, health.runs[0].id);
  for (const run of health.runs) {
    assert.ok(Array.isArray(run.per_chunk));
    assert.equal(typeof run.id, "number");
  }
});

test("freshness covers the exported tables of every group", {
  skip: !hasDatabase
}, async () => {
  const tables = (await getSyncHealth(1)).groups.flatMap((group) =>
    group.tables.map((row) => row.table)
  );

  for (const group of SYNC_TABLE_GROUPS) {
    for (const table of group.tables) {
      assert.ok(tables.includes(table), `таблица ${table} не попала в сводку`);
    }
  }
});
