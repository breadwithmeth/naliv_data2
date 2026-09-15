import assert from "node:assert/strict";
import { test } from "node:test";
import { ReportCache } from "../src/lib/report-cache.js";

test("identical concurrent reports share a load, and expiry starts at completion", async () => {
  let now = 0;
  let calls = 0;
  const cache = new ReportCache(100, 1000, 10, () => now);
  let finish!: (value: string) => void;
  const load = () => { calls++; return new Promise<string>((resolve) => { finish = resolve; }); };
  const first = cache.get("a", load);
  const second = cache.get("a", load);
  await Promise.resolve();
  now = 1000;
  finish("report");
  assert.equal((await first).status, "miss");
  assert.equal((await second).status, "shared");
  assert.equal(calls, 1);
  now = 1099;
  assert.equal((await cache.get("a", load)).status, "hit");
  now = 1100;
  assert.deepEqual(await cache.get("a", async () => "updated"), { value: "updated", status: "miss" });
});

test("failed loads are evicted, including synchronous failures", async () => {
  const cache = new ReportCache(1000, 1000);
  await assert.rejects(cache.get("a", () => { throw new Error("database unavailable"); }));
  assert.deepEqual(await cache.get("a", async () => "retry"), { value: "retry", status: "miss" });
});

test("LRU respects UTF-8 byte and entry budgets; oversized reports are not retained", async () => {
  const cache = new ReportCache(1000, 8, 2);
  await cache.get("a", async () => "аб"); // four UTF-8 bytes
  await cache.get("b", async () => "вг");
  assert.equal((await cache.get("a", async () => "unused")).status, "hit");
  await cache.get("c", async () => "дe");
  assert.equal((await cache.get("b", async () => "new")).status, "miss");
  await cache.get("huge", async () => "0123456789");
  assert.equal((await cache.get("huge", async () => "0123456789")).status, "miss");
  const entries = new ReportCache(1000, 1000, 1);
  await entries.get("a", async () => "a");
  await entries.get("b", async () => "b");
  assert.equal((await entries.get("a", async () => "a")).status, "miss");
});

test("zero TTL disables retention and distinct filters do not share results", async () => {
  const cache = new ReportCache(0, 1000);
  assert.equal((await cache.get("a", async () => "one")).value, "one");
  assert.deepEqual(await cache.get("a", async () => "two"), { value: "two", status: "miss" });
  assert.equal((await cache.get("b", async () => "three")).value, "three");
});
