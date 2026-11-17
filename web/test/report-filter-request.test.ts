import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../src/api";

// Preview and Excel must receive the same opt-in; otherwise exported rows differ from the screen.
test("incomplete-row selection reaches compensation and turnover preview and Excel", async () => {
  const originalFetch = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://fixture.invalid");
    urls.push(url);
    return new Response(url.pathname.endsWith(".xlsx") ? "fixture workbook transport" : "{}", {
      headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="fixture.xlsx"' }
    });
  }) as typeof fetch;
  try {
    for (const includeIncomplete of [undefined, false, true]) {
      const from = "2026-09-01";
      const to = "2026-09-03";
      const compensation = { from, to, activityKey: "activity-a", includeIncomplete };
      const turnover = { from, to, mode: "quantity" as const, store: ["store-a"], includeIncomplete };
      const start = urls.length;
      await api.marketingCompensationReport(compensation);
      await api.marketingCompensationWorkbook(compensation);
      await api.turnoverReport(turnover);
      await api.turnoverWorkbook(turnover);
      for (const url of urls.slice(start)) {
        assert.equal(url.searchParams.get("includeIncomplete"), includeIncomplete === undefined ? null : String(includeIncomplete));
      }
      assert.equal(urls[start].searchParams.get("activityKey"), "activity-a");
      assert.equal(urls[start + 1].searchParams.get("activityKey"), "activity-a");
      assert.deepEqual(urls[start + 2].searchParams.getAll("store"), ["store-a"]);
      assert.deepEqual(urls[start + 3].searchParams.getAll("store"), ["store-a"]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
