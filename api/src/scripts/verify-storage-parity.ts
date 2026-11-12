#!/usr/bin/env node
/** Frozen-clone HTTP/XLSX parity proof. Credentials/cookies never enter artifacts. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Writable } from "node:stream";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import { z } from "zod";
import ExcelJS from "exceljs";
import { writeMarketingCompensationWorkbook } from "../services/marketing-compensation-workbook.js";
import { writeTurnoverWorkbook } from "../services/turnover-workbook.js";
import type { MarketingCompensationReport } from "../services/marketing-compensation-types.js";
import type { TurnoverReport } from "../services/turnover-types.js";
/** Mirrors naliv_data1 analytics_reload.PAUSE_AT_BYTES; kept local to avoid service side effects. */
const RELOAD_PAUSE_AT_BYTES = 12_000_000_000;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Target = { name: string; oid: number };
type RequestCase = { path: string; kind: "json" | "xlsx" };
type Sample = RequestCase & { value: Json; medianMs: number; samplesMs: number[]; uncached: boolean };
type Selection = { from: string; to: string; sku: string | null; storeKey: string | null; activityKey: string | null; rowKeys: Record<string, string> };
type Baseline = {
  proofVersion: 1; kind: string; success: boolean; targetDatabase: Target;
  planSha256: string; contractSha256: string; indexManifestSha256: string;
  sourceSnapshot: Json; capturedAtUtc: string; clockDayUtc: string;
  selections: Selection[]; samples: Sample[]; apiIdentity: z.infer<typeof apiIdentitySchema>;
};
const WINDOWS = [
  { from: "2025-09-01", to: "2025-10-01" },
  { from: "2026-09-01", to: "2026-10-01" },
  { from: "2024-02-28", to: "2024-03-02" }
];
const ignoredKeys: Record<string, true | undefined> = { generatedAt: true, generatedAtUtc: true };
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const planSchema = z.object({
  planVersion: z.literal(1), migrationId: z.string().uuid(), environment: z.literal("rehearsal"),
  targetDatabase: z.object({ name: z.string(), oid: z.number().int().positive() }),
  sourceSchema: z.object({ name: z.string(), oid: z.number().int().positive() }),
  contractSha256: z.string().regex(/^[a-f0-9]{64}$/),
  indexManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  retainedTables: z.array(z.string()).min(1)
}).passthrough();

const jsonValue: z.ZodType<Json> = z.lazy(() => z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValue), z.record(jsonValue)]));
const baselineSchema: z.ZodType<Baseline> = z.object({
  proofVersion: z.literal(1), kind: z.literal("storage-http-baseline"), success: z.literal(true),
  targetDatabase: z.object({ name: z.string(), oid: z.number().int().positive() }),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/), contractSha256: z.string().regex(/^[a-f0-9]{64}$/),
  indexManifestSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceSnapshot: jsonValue,
  capturedAtUtc: z.string(), clockDayUtc: z.string(),
  selections: z.array(z.object({ from: z.string(), to: z.string(), sku: z.string().nullable(), storeKey: z.string().nullable(), activityKey: z.string().nullable(), rowKeys: z.record(z.string()) })),
  samples: z.array(z.object({
    path: z.string().refine((value) => value.startsWith("/api/") && !value.includes("\\"), "Only relative API paths are permitted"),
    kind: z.enum(["json", "xlsx"]), value: jsonValue,
    medianMs: z.number().finite().nonnegative(), samplesMs: z.array(z.number().finite().nonnegative()).length(3),
    uncached: z.literal(true)
  })).min(1),
  apiIdentity: z.lazy(() => apiIdentitySchema)
});

const apiIdentitySchema = z.object({
  proofVersion: z.literal(1), challenge: z.string(),
  targetDatabase: z.object({ name: z.string(), oid: z.number().int().positive() }),
  sourceSchema: z.object({ name: z.string(), oid: z.number().int().positive() }),
  layout: z.object({
    layoutVersion: z.number().int(), contractSha256: z.string(),
    migrationId: z.string(), planSha256: z.string(), compactionActive: z.boolean()
  }).nullable()
});

export function validateApiIdentity(value: unknown, binding: {
  targetDatabase: Target; sourceSchema: Target; migrationId: string; contractSha256: string; planSha256: string;
}, challenge: string, activated: boolean) {
  const identity = apiIdentitySchema.parse(value);
  if (identity.challenge !== challenge) throw new Error("API identity challenge mismatch");
  if (identity.targetDatabase.name !== binding.targetDatabase.name || identity.targetDatabase.oid !== binding.targetDatabase.oid) throw new Error("HTTP API database target does not match the rehearsal plan");
  if (identity.sourceSchema.name !== binding.sourceSchema.name || identity.sourceSchema.oid !== binding.sourceSchema.oid) throw new Error("HTTP API source schema does not match the rehearsal plan");
  if (activated && (!identity.layout || identity.layout.layoutVersion !== 1 || identity.layout.contractSha256 !== binding.contractSha256 || identity.layout.migrationId !== binding.migrationId || identity.layout.planSha256 !== binding.planSha256)) throw new Error("HTTP API layout is not activated for this migration/plan");
  if (!activated && identity.layout?.migrationId === binding.migrationId) throw new Error("Capture must precede activation of this migration");
  return identity;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((name) => `${JSON.stringify(name)}:${canonicalJson(row[name])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Arrays, missing keys, NULLs, integer counts and diagnostics remain exact. */
export function compareSemanticValues(before: unknown, after: unknown, path = "$", differences: string[] = []): string[] {
  if (before === after) return differences;
  if (typeof before === "number" && typeof after === "number" && Number.isFinite(before) && Number.isFinite(after)) {
    if (!Number.isInteger(before) && !Number.isInteger(after) && Math.abs(before - after) <= 1e-6) return differences;
  } else if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) differences.push(`${path}.length`);
    for (let index = 0; index < Math.min(before.length, after.length); index++) compareSemanticValues(before[index], after[index], `${path}[${index}]`, differences);
    return differences;
  } else if (before !== null && after !== null && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
    const left = before as Record<string, unknown>, right = after as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      if (ignoredKeys[key]) continue;
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) differences.push(`${path}.${key}`);
      else compareSemanticValues(left[key], right[key], `${path}.${key}`, differences);
    }
    return differences;
  }
  differences.push(path);
  return differences;
}

function cellValue(value: ExcelJS.CellValue): Json {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return { date: value.toISOString() };
  if (typeof value !== "object") return value;
  // Preserve formula/results, hyperlinks, rich text and errors, not ZIP metadata.
  return JSON.parse(JSON.stringify(value)) as Json;
}

export async function workbookSemantics(buffer: Buffer): Promise<Json> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook.worksheets.map((sheet) => {
    const rows: Json[] = [];
    sheet.eachRow((row, number) => {
      const cells: Json[] = [];
      row.eachCell((cell, column) => {
        // These are exactly the exported generatedAt fields, not business dates.
        const previous = column > 1 ? row.getCell(column - 1).value : null;
        let value = cellValue(cell.value);
        if ((previous === "Снимок UTC" || previous === "Сформировано UTC") && typeof value === "string") value = { generatedAt: true };
        if (typeof value === "string") value = value.replace(/(Снимок UTC:? )\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, "$1<generatedAt>");
        if (value !== null) cells.push({ column, value });
      });
      if (cells.length) rows.push({ number, cells });
    });
    return { name: sheet.name, rows };
  });
}

export function performanceGate(beforeMedianMs: number, afterMedianMs: number): boolean {
  return Number.isFinite(beforeMedianMs) && beforeMedianMs >= 0 && Number.isFinite(afterMedianMs) && afterMedianMs <= beforeMedianMs + Math.max(beforeMedianMs * 0.25, 500);
}

async function atomicJson(path: string, value: unknown) {
  if (!isAbsolute(path)) throw new Error("Proof artifacts require absolute paths outside the source repositories");
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const normalized = resolve(path).toLowerCase();
  for (const checkout of [root, resolve(root, "../naliv_data1")]) {
    const prefix = resolve(checkout).toLowerCase();
    if (normalized === prefix || normalized.startsWith(prefix + "/") || normalized.startsWith(prefix + "\\")) throw new Error("Proof artifacts must be stored outside both source checkouts");
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

type ParityArguments = { command: "capture" | "compare" | "readiness"; plan: string; base: URL; baseline: string | undefined; output: string };
/** Physical capture/compare and post-cleanup readiness deliberately use different plans. */
export function argumentsFor(argv: string[]): ParityArguments {
  const command = argv[0];
  if (command !== "capture" && command !== "compare" && command !== "readiness") throw new Error("Usage: verify-storage-parity.ts capture|compare --storage-plan PATH --base-url URL [--baseline PATH] --output PATH; readiness --reload-plan PATH --base-url URL --output PATH");
  const args = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) {
    const allowed = command === "readiness" ? ["--reload-plan", "--base-url", "--output"] : ["--storage-plan", "--base-url", "--baseline", "--output"];
    if (!allowed.includes(argv[i]) || !argv[i + 1] || args.has(argv[i])) throw new Error("Invalid or duplicate parity argument");
    args.set(argv[i], argv[i + 1]);
  }
  const planArgument = command === "readiness" ? "--reload-plan" : "--storage-plan";
  for (const name of [planArgument, "--base-url", "--output", ...(command === "compare" ? ["--baseline"] : [])]) if (!args.get(name)) throw new Error(`Missing ${name}`);
  const base = new URL(args.get("--base-url")!);
  if (base.username || base.password || base.search || base.hash || !["http:", "https:"].includes(base.protocol)) throw new Error("Base URL must not contain credentials or query parameters");
  return { command, plan: args.get(planArgument)!, base, baseline: args.get("--baseline"), output: args.get("--output")! };
}

function query(path: string, params: Record<string, string | null | undefined>) {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined) values.set(key, value);
  return path + (values.size ? `?${values}` : "");
}

type Http = (entry: RequestCase, timed?: boolean) => Promise<{ value: Json; ms: number; uncached: boolean }>;
async function login(base: URL): Promise<Http> {
  const email = process.env.APP_ADMIN_EMAIL, password = process.env.APP_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("Environment-held admin credentials are required");
  const response = await fetch(new URL("/api/auth/login", base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }), redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Admin login failed: HTTP ${response.status}`);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  if (!cookie) throw new Error("Admin login did not issue a session cookie");
  return async (entry) => {
    if (!entry.path.startsWith("/api/") || entry.path.includes("\\")) throw new Error("Refusing a parity route outside the authenticated API");
    const start = performance.now();
    const result = await fetch(new URL(entry.path, base), { headers: { Cookie: cookie, "Cache-Control": "no-cache" }, redirect: "error", signal: AbortSignal.timeout(900_000) });
    if (!result.ok) throw new Error(`${entry.path}: HTTP ${result.status}`);
    const bytes = Buffer.from(await result.arrayBuffer());
    const ms = performance.now() - start;
    const cache = result.headers.get("X-Report-Cache");
    if (cache && cache.toUpperCase() === "HIT") throw new Error("Parity timings require REPORT_CACHE_TTL_SECONDS=0 on the API; cached response refused");
    return { value: entry.kind === "xlsx" ? await workbookSemantics(bytes) : jsonValue.parse(JSON.parse(bytes.toString("utf-8"))), ms, uncached: cache?.toUpperCase() !== "HIT" };
  };
}

async function sample(http: Http, entry: RequestCase): Promise<Sample> {
  await http(entry); // Warm JIT, server and filesystem; not the bounded response cache.
  const calls = [];
  for (let i = 0; i < 3; i++) calls.push(await http(entry));
  for (let i = 1; i < calls.length; i++) if (compareSemanticValues(calls[0].value, calls[i].value).length) throw new Error(`Unstable frozen baseline: ${entry.path}`);
  const samplesMs = calls.map((value) => value.ms);
  return { ...entry, value: calls[0].value, samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[1], uncached: calls.every((value) => value.uncached) };
}

const object = (value: Json) => value && !Array.isArray(value) && typeof value === "object" ? value : {};
const array = (value: Json | undefined) => Array.isArray(value) ? value : [];
const key = (value: Json | undefined): string | null => typeof value === "string" && value.length > 0 ? value : null;

export function requiredParityCases(selections: Selection[]): RequestCase[] {
  if (selections.length !== WINDOWS.length || WINDOWS.some((window, index) => selections[index]?.from !== window.from || selections[index]?.to !== window.to)) throw new Error("Parity coverage must contain the exact three fixed windows");
  const leap = selections[2];
  if (!leap.sku || !leap.storeKey || !leap.activityKey) throw new Error("A populated leap-boundary fixture with item, store and activity is required");
  const entries = new Map<string, RequestCase>();
  const add = (path: string, kind: "json" | "xlsx" = "json") => entries.set(`${kind}:${path}`, { path, kind });
  add("/api/reports/turnover/options");
  add("/api/management/settings");
  for (const selection of selections) {
    const window = { from: selection.from, to: selection.to };
    for (const path of ["/api/reports/sales", "/api/reports/income", "/api/reports/year-comparison", "/api/inventory", "/api/nomenclature", "/api/marketing", "/api/marketing/compensations/activities", "/api/marketing/compensations", ...["losses", "acquiring", "cash-articles", "supplier-terms", "store-stock", "store-performance", "money-position", "lost-sales", "purchasing", "source-health"].map((suffix) => `/api/management/${suffix}`)]) add(query(path, window));
    if (selection.activityKey) {
      add(query("/api/marketing/compensations", { ...window, activityKey: selection.activityKey }));
      add(query("/api/marketing/compensations.xlsx", { ...window, activityKey: selection.activityKey }), "xlsx");
    }
    for (const mode of ["quantity", "money"]) for (const profile of ["summary", "full"]) for (const store of [null, ...(selection.storeKey ? [selection.storeKey] : [])]) {
      const params = { ...window, mode, profile, store };
      add(query("/api/reports/turnover", params));
      if (selection.sku) {
        add(query("/api/reports/turnover.xlsx", { ...params, sku: selection.sku }), "xlsx");
        const auditGroup = selection.rowKeys[`${mode}|${profile}|${store ?? "all"}`];
        if (selection === leap && !auditGroup) throw new Error("Populated leap fixture requires every turnover drill-down");
        if (auditGroup) add(query("/api/reports/turnover/row", { ...params, sku: selection.sku, auditGroup }));
      }
    }
    add(query("/api/reports/year-comparison.xlsx", window), "xlsx");
    add(query("/api/reports/presentation.xlsx", { ...window, monthFrom: window.from, monthTo: window.to }), "xlsx");
  }
  return [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1);
}

export function validateParityCoverage(samples: RequestCase[], selections: Selection[]) {
  const required = requiredParityCases(selections);
  const actual = samples.map(({ path, kind }) => ({ path, kind })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : 1);
  if (compareSemanticValues(required, actual).length) throw new Error("Incomplete or duplicate parity coverage matrix");
  return { success: true, caseCount: required.length, requiredCasesSha256: hash(canonicalJson(required)) };
}

async function captureSamples(http: Http): Promise<{ samples: Sample[]; selections: Selection[]; coverage: { success: boolean; caseCount: number; requiredCasesSha256: string }; populatedLeapFixture: true }> {
  const options = object((await http({ path: "/api/reports/turnover/options", kind: "json" })).value);
  const selections: Selection[] = [];
  for (const window of WINDOWS) {
    const activities = object((await http({ path: query("/api/marketing/compensations/activities", window), kind: "json" })).value);
    const activityKey = key(object(array(activities.activities)[0] ?? null).key);
    const preview = object((await http({ path: query("/api/reports/turnover", { ...window, mode: "quantity", profile: "summary" }), kind: "json" })).value);
    const first = array(preview.rows).map(object).find((row) => key(row.sku));
    const sku = key(first?.sku);
    const storeKey = key(first?.storeKey) ?? key(object(array(options.stores)[0] ?? null).key);
    const selection: Selection = { ...window, sku, storeKey, activityKey, rowKeys: {} };
    for (const mode of ["quantity", "money"]) for (const profile of ["summary", "full"]) for (const store of [null, ...(storeKey ? [storeKey] : [])]) {
      if (!sku) continue;
      const detail = object((await http({ path: query("/api/reports/turnover", { ...window, mode, profile, store, sku }), kind: "json" })).value);
      const row = array(detail.rows).map(object).find((value) => key(value.key));
      if (row && key(row.key)) selection.rowKeys[`${mode}|${profile}|${store ?? "all"}`] = String(row.key);
    }
    selections.push(selection);
  }
  const entries = requiredParityCases(selections);
  const samples: Sample[] = [];
  for (const entry of entries) samples.push(await sample(http, entry));
  return { samples, selections, coverage: validateParityCoverage(samples, selections), populatedLeapFixture: true };
}

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, "An existing calendar date is required");
const reloadPlanSchema = z.object({
  planVersion: z.literal(1), operation: z.literal("post-cleanup-reload-v1"), migrationId: z.string().uuid(),
  targetDatabase: z.object({ name: z.literal("nalivdata"), oid: z.number().int().positive() }),
  sourceSchema: z.object({ name: z.literal("raw_1c"), oid: z.number().int().positive() }),
  contractSha256: z.string().regex(/^[a-f0-9]{64}$/), indexManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  from: isoDay, toExclusive: isoDay
}).passthrough().refine((plan) => plan.from < plan.toExclusive, "Reload horizon must be nonempty");
type ReloadPlan = z.infer<typeof reloadPlanSchema>;
type ReadinessBinding = ReloadPlan & { planSha256: string };
type LedgerBinding = { planSha256: string; contractSha256: string; indexManifestSha256: string };
type ReadinessResponse = { status: number; value: Json; ms: number; uncached: boolean };
type ReadinessHttp = (entry: RequestCase) => Promise<ReadinessResponse>;
type ReadinessStatus = "passed" | "incomplete" | "failed";
type ReadinessRoute = RequestCase & {
  exercised: boolean; status: ReadinessStatus; httpStatus: number | null; code: string | null;
  warmupHttpStatus: number | null; warmupCode: string | null;
  reason: string | null; value: Json; samplesMs: number[]; medianMs: number | null; uncached: boolean;
};
type SkippedCase = { path: string; reason: string };
type WorkbookOracle = { value: Json; source: string; input: Json };
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export function parseReloadPlan(value: unknown): ReloadPlan { return reloadPlanSchema.parse(value); }

/** The challenged layout binds the plan SHA; its immutable plan binds the manifest SHA.
 * The independently read ledger must repeat both hashes; no new HTTP identity fields are assumed. */
export function validateReadinessIdentity(value: unknown, binding: ReadinessBinding, challenge: string, ledger: LedgerBinding | null) {
  const identity = validateApiIdentity(value, binding, challenge, true);
  if (identity.layout?.compactionActive) throw new Error("HTTP API layout is frozen/compaction active");
  if (!ledger || ledger.planSha256 !== binding.planSha256 || ledger.contractSha256 !== binding.contractSha256 || ledger.indexManifestSha256 !== binding.indexManifestSha256) throw new Error("Reload ledger plan/contract/index manifest binding mismatch");
  return identity;
}

/** Warm once, then measure three complete bodies, including explicit pending 503s. */
export async function sampleReadiness(http: ReadinessHttp, entry: RequestCase): Promise<ReadinessRoute> {
  const calls: ReadinessResponse[] = [];
  let warmup: ReadinessResponse | null = null;
  try {
    warmup = await http(entry);
    for (let index = 0; index < 3; index++) calls.push(await http(entry));
  } catch {
    return { ...entry, exercised: warmup !== null, status: "failed", httpStatus: calls.at(-1)?.status ?? warmup?.status ?? null, code: null, warmupHttpStatus: warmup?.status ?? null, warmupCode: warmup ? key(object(warmup.value).code) : null, reason: "HTTP request or response decoding failed", value: null, samplesMs: calls.map((call) => call.ms), medianMs: null, uncached: false };
  }
  const first = calls[0], samplesMs = calls.map((call) => call.ms);
  const uncached = warmup.uncached && calls.every((call) => call.uncached);
  const stable = warmup.status === first.status && calls.every((call) => call.status === first.status && !compareSemanticValues(first.value, call.value).length);
  const body = object(first.value), code = key(body.code);
  const pending = first.status === 503 && code === "ANALYTICS_RELOAD_INCOMPLETE";
  return {
    ...entry, exercised: true, status: !uncached || !stable ? "incomplete" : pending ? "incomplete" : first.status === 200 ? "passed" : "failed",
    httpStatus: first.status, code, value: first.value, samplesMs,
    warmupHttpStatus: warmup.status, warmupCode: key(object(warmup.value).code),
    medianMs: [...samplesMs].sort((a, b) => a - b)[1], uncached,
    reason: !uncached ? "Cached response refused; API REPORT_CACHE_TTL_SECONDS must be 0" : !stable ? "Response changed during warmed measurements" : pending ? key(body.error) ?? "Reload certification is pending" : first.status === 200 ? null : `HTTP ${first.status}`
  };
}

export function compareReadinessWorkbook(actual: Json, expected: Json | null) {
  if (expected === null) return { status: "incomplete" as ReadinessStatus, reason: "No same-parameter JSON/internal report oracle is available", differences: [] as string[], formulaDifferences: [] as string[], cachedResultDifferences: [] as string[] };
  const differences = compareSemanticValues(expected, actual);
  return {
    status: (differences.length ? "failed" : "passed") as ReadinessStatus,
    reason: differences.length ? "Workbook differs from the same-parameter report oracle" : null,
    differences, formulaDifferences: differences.filter((path) => path.endsWith(".formula")),
    cachedResultDifferences: differences.filter((path) => path.endsWith(".result"))
  };
}

/** Independent field projections catch shared-writer mistakes as well as wrong HTTP inputs.
 * Full workbook semantics additionally cover text, diagnostics, formulas and all other sheets. */
export function compareReadinessFields(path: string, workbook: Json, input: Json): string[] {
  const sheets = array(workbook).map(object), report = object(input);
  const cell = (row: Record<string, Json>, column: number): Json => object(array(row.cells).find((value) => object(value).column === column) ?? null).value ?? null;
  const rowsFor = (name: string, firstRow: number, columns: number[]) => sheets.filter((sheet) => sheet.name === name)
    .flatMap((sheet) => array(sheet.rows).map(object).filter((row) => Number(row.number) >= firstRow))
    .map((row) => columns.map((column) => cell(row, column)));
  if (path.startsWith("/api/marketing/compensations.xlsx")) {
    const groups = new Map<string | null, Json[][]>();
    for (const activity of array(report.activities).map(object)) for (const branch of array(activity.branches).map(object)) {
      const rows = groups.get(key(branch.key)) ?? [];
      for (const row of array(branch.rows).map(object)) rows.push([
        row.barcode ?? "n/a", row.name, row.price ?? "n/a",
        typeof row.discountPct === "number" ? row.discountPct / 100 : "n/a",
        row.unitCompensation ?? "n/a", row.quantity ?? "n/a", row.compensation ?? "n/a"
      ]);
      groups.set(key(branch.key), rows);
    }
    const actual = sheets.filter((sheet) => sheet.name !== "Сводка" && sheet.name !== "Диагностика")
      .flatMap((sheet) => array(sheet.rows).map(object))
      .filter((row) => [3, 4, 6].every((column) => typeof cell(row, column) === "number" || cell(row, column) === "n/a"))
      .map((row) => [1, 2, 3, 4, 5, 6, 7].map((column) => cell(row, column)));
    return compareSemanticValues([...groups.values()].flat(), actual, "$.compensation.items");
  }
  if (path.startsWith("/api/reports/turnover.xlsx")) {
    const fields: Record<string, string> = {
      "Магазин": "storeName", "Склад": "warehouseName", "Категория": "categoryName", "Бренд": "brandName",
      "SKU (ключ 1С)": "sku", "Артикул": "article", "Наименование": "name", "Единица учёта 1С": "unit",
      "Начальный остаток": "openingQty", "Конечный остаток": "closingQty", "Средний остаток": "averageQty",
      "Нетто продажи за период": "periodSales.quantity", "Среднедневные продажи периода": "periodSales.averageDailyQty",
      "Оборачиваемость, раз": "turnoverQty", "Оборачиваемость, дни": "turnoverQtyDays",
      "Стоимость начального остатка, ₸": "openingCost", "Стоимость конечного остатка, ₸": "closingCost", "Средняя стоимость запаса, ₸": "averageCost",
      "Нетто продажи по себестоимости, ₸": "periodSales.cost", "Среднедневная себестоимость продаж периода, ₸": "periodSales.averageDailyCost",
      "Оборачиваемость по себестоимости, раз": "turnoverCost", "Оборачиваемость по себестоимости, дни": "turnoverCostDays",
      "Розничная выручка, ₸ · не числитель оборачиваемости": "periodSales.revenue",
      "Нетто количество периода сравнения": "comparisonSales.quantity", "Себестоимость продаж периода сравнения, ₸": "comparisonSales.cost",
      "Последняя продажа в магазине": "lastSaleDate", "Дни без наличия (наблюдаемые)": "outOfStockDays",
      "Излишек, единица строки": "excessQty", "Дефицит, единица строки": "deficitQty",
      "Открытые заказы за вычетом поступлений": "openOrderQty", "Ближайшая ожидаемая поставка": "nextDeliveryDate",
      "Рекомендовано к заказу, единица строки": "recommendedOrderQty", "Наблюдаемые дни остатков": "observedDays", "Ожидаемые дни остатков": "expectedDays",
      "Стоимость без движения ≥30 дней, ₸": "stagnantCost.d30", "Стоимость без движения ≥60 дней, ₸": "stagnantCost.d60", "Стоимость без движения ≥90 дней, ₸": "stagnantCost.d90"
    };
    const main = sheets.find((sheet) => sheet.name === "Оборачиваемость");
    if (!main) return ["$.turnover.mainSheet"];
    const rows = array(main.rows).map(object), heading = rows.find((row) => row.number === 4);
    const columns = heading ? array(heading.cells).map(object).filter((value) => typeof value.value === "string" && fields[value.value]) : [];
    if (!columns.length) return ["$.turnover.fields"];
    const expected = array(report.rows).map(object).map((row) => columns.map((column) => {
      let value: Json = row;
      for (const part of fields[String(column.value)].split(".")) value = object(value)[part] ?? null;
      return typeof value === "string" ? value.slice(0, 32_767) : value ?? "n/a";
    }));
    const actual = sheets.filter((sheet) => typeof sheet.name === "string" && /^Оборачиваемость(?: \d+)?$/.test(sheet.name))
      .flatMap((sheet) => array(sheet.rows).map(object).filter((row) => Number(row.number) >= 5))
      .map((row) => columns.map((column) => cell(row, Number(column.column))));
    return compareSemanticValues(expected, actual, "$.turnover.rows");
  }
  if (path.startsWith("/api/reports/year-comparison.xlsx") || path.startsWith("/api/reports/presentation.xlsx")) {
    const presentation = path.startsWith("/api/reports/presentation.xlsx"), expected: Json[][] = [];
    const blocks: Array<[string | null, Record<string, Json>]> = presentation
      ? [["Основной период", object(object(report.main ?? null).sales ?? null)], ["Дополнительный период", object(object(report.detail ?? null).sales ?? null)]]
      : [[null, report]];
    for (const [label, sales] of blocks) for (const row of array(object(sales.dataQuality ?? null).valuation).map(object)) {
      const period = String(row.period), to = object(object(sales.periods ?? null)[period] ?? null).to ?? null;
      const identity: Json[] = presentation ? [label, period === "current" ? "Текущий" : "Предыдущий", to] : [period, to];
      expected.push([...identity, row.sourceStoreKey, row.itemKey, row.unitCost ?? "n/a", row.quantity, row.revenue, row.absoluteQuantity, row.valuedCost ?? "n/a"]);
    }
    const actual = rowsFor("Оценка стоимости", presentation ? 5 : 3, presentation ? [1, 2, 3, 4, 5, 6, 8, 9, 10, 11] : [1, 2, 3, 4, 5, 7, 8, 9, 10]);
    return compareSemanticValues(expected, actual, "$.valuation.rows");
  }
  return ["$.oracle.unsupportedExport"];
}

/** Real observed fixtures only: no synthetic return or zero-price substitute. */
export function readinessBusinessFixtures(samples: Array<RequestCase & { value: Json }>): SkippedCase[] {
  const compensationRows = samples.filter((sample) => sample.kind === "json" && sample.path.startsWith("/api/marketing/compensations?"))
    .flatMap((sample) => array(object(sample.value).activities).map(object))
    .flatMap((activity) => array(activity.branches).map(object))
    .flatMap((branch) => array(branch.rows).map(object));
  const skipped: SkippedCase[] = [];
  if (!compensationRows.length) skipped.push({ path: "activity-row-fixture", reason: "No populated compensation activity rows were observed" });
  if (!compensationRows.some((row) => typeof row.quantity === "number" && row.quantity < 0)) skipped.push({ path: "return-fixture", reason: "No negative compensation quantity/return fixture was observed; return semantics remain unexercised" });
  if (!compensationRows.some((row) => typeof row.price === "number" && row.price > 0)) skipped.push({ path: "price-fixture", reason: "No known positive compensation price fixture was observed; price semantics remain unexercised" });
  return skipped;
}

export function pendingReadinessCases(plan: ReloadPlan, readiness: Json): RequestCase[] {
  const state = object(readiness);
  if (state.status === "ready") return [];
  const sources = array(state.sources).map(object), cases: RequestCase[] = [];
  for (const [tablePrefix, path] of [["document_chek_kkm", "/api/reports/year-comparison"], ["document_otchet_o_roznichnyh_prodazhah", "/api/reports/income"]]) {
    const source = sources.find((source) => typeof source.table === "string" && source.table.startsWith(tablePrefix) && source.status !== "verified");
    if (!source) continue;
    const boundary = typeof source.verifiedThrough === "string" && isoDay.safeParse(source.verifiedThrough).success ? source.verifiedThrough : plan.from;
    const from = boundary < plan.from ? plan.from : boundary;
    if (from < plan.toExclusive) cases.push({ path: query(path, { from, to: dayAfter(from) }), kind: "json" });
  }
  return cases;
}

export function requiredReadinessCases(selection: Selection): { cases: RequestCase[]; skipped: SkippedCase[] } {
  const cases: RequestCase[] = [], skipped: SkippedCase[] = [];
  const add = (path: string, kind: RequestCase["kind"] = "json") => cases.push({ path, kind });
  const window = { from: selection.from, to: selection.to };
  for (const path of ["/api/reports/sales", "/api/reports/income", "/api/reports/year-comparison", "/api/inventory", "/api/nomenclature", "/api/marketing", "/api/marketing/compensations/activities", "/api/marketing/compensations", ...["losses", "acquiring", "cash-articles", "supplier-terms", "store-stock", "store-performance", "money-position", "lost-sales", "purchasing", "source-health"].map((suffix) => `/api/management/${suffix}`)]) add(query(path, window));
  add("/api/management/settings");
  add("/api/reports/turnover/options");
  if (selection.activityKey) {
    add(query("/api/marketing/compensations", { ...window, activityKey: selection.activityKey }));
    add(query("/api/marketing/compensations.xlsx", { ...window, activityKey: selection.activityKey }), "xlsx");
  } else {
    for (const path of ["/api/marketing/compensations", "/api/marketing/compensations.xlsx"]) skipped.push({ path, reason: "No populated activity fixture was discovered in the selected window" });
  }
  for (const mode of ["quantity", "money"]) for (const profile of ["summary", "full"]) for (const store of [null, ...(selection.storeKey ? [selection.storeKey] : [])]) {
    const params = { ...window, mode, profile, store, sku: selection.sku };
    add(query("/api/reports/turnover", params));
    const auditGroup = selection.rowKeys[`${mode}|${profile}|${store ?? "all"}`];
    if (selection.sku) add(query("/api/reports/turnover.xlsx", params), "xlsx");
    else skipped.push({ path: query("/api/reports/turnover.xlsx", params), reason: "No populated SKU fixture was discovered" });
    if (selection.sku && auditGroup) add(query("/api/reports/turnover/row", { ...params, auditGroup }));
    else skipped.push({ path: query("/api/reports/turnover/row", params), reason: "No actual returned auditGroup for the selected SKU" });
  }
  if (!selection.storeKey) skipped.push({ path: "/api/reports/turnover", reason: "No real store fixture; one-store preview/row/XLSX variants were not exercised" });
  add(query("/api/reports/year-comparison.xlsx", window), "xlsx");
  add(query("/api/reports/presentation.xlsx", { ...window, monthFrom: window.from, monthTo: window.to }), "xlsx");
  return { cases, skipped };
}

/** Only single-day requests are used, never a speculative annual fixture query. */
export async function discoverReadinessSelection(http: ReadinessHttp, plan: ReloadPlan) {
  const discovery: ReadinessRoute[] = [];
  const read = async (path: string) => {
    const result = await sampleReadiness(http, { path, kind: "json" });
    discovery.push(result);
    return result.status === "passed" ? object(result.value) : {};
  };
  let selection: Selection = { from: plan.from, to: dayAfter(plan.from), sku: null, storeKey: null, activityKey: null, rowKeys: {} };
  let populated = false;
  let firstPopulated: Selection | null = null;
  for (let day = plan.from; day < plan.toExclusive; day = dayAfter(day)) {
    const window = { from: day, to: dayAfter(day) };
    const sales = await read(query("/api/reports/sales", window));
    const summary = object(sales.summary ?? null);
    if (!(Number(summary.orderCount) > 0 || Number(summary.reportCount) > 0)) continue;
    const activities = await read(query("/api/marketing/compensations/activities", window));
    selection = {
      ...window, sku: key(object(array(sales.composition)[0] ?? null).itemKey),
      storeKey: key(array(object(sales.heatmap ?? null).cells).map(object).find((cell) => Number(cell.orderCount) > 0)?.storeKey),
      activityKey: key(object(array(activities.activities)[0] ?? null).key), rowKeys: {}
    };
    populated = true;
    firstPopulated ??= selection;
    if (selection.activityKey) break;
  }
  if (!selection.activityKey && firstPopulated) selection = firstPopulated;
  const window = { from: selection.from, to: selection.to };
  const preview = await read(query("/api/reports/turnover", { ...window, mode: "quantity", profile: "summary", sku: selection.sku }));
  const rows = array(preview.rows).map(object);
  const first = rows.find((row) => key(row.sku) && [object(row.periodSales ?? null).quantity, object(row.periodSales ?? null).revenue].some((value) => typeof value === "number" && value !== 0)) ?? rows.find((row) => key(row.sku));
  selection.sku = key(first?.sku) ?? selection.sku;
  selection.storeKey = key(first?.storeKey) ?? selection.storeKey;
  if (!populated) {
    const activities = await read(query("/api/marketing/compensations/activities", window));
    selection.activityKey = key(object(array(activities.activities)[0] ?? null).key);
  }
  for (const mode of ["quantity", "money"]) for (const profile of ["summary", "full"]) for (const store of [null, ...(selection.storeKey ? [selection.storeKey] : [])]) {
    if (!selection.sku) continue;
    const report = await read(query("/api/reports/turnover", { ...window, mode, profile, store, sku: selection.sku }));
    const row = array(report.rows).map(object).find((row) => row.sku === selection.sku && key(row.key));
    if (row) selection.rowKeys[`${mode}|${profile}|${store ?? "all"}`] = String(row.key);
  }
  return { selection, populated, discovery };
}

async function readinessLogin(base: URL): Promise<ReadinessHttp> {
  const email = process.env.APP_ADMIN_EMAIL, password = process.env.APP_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("Environment-held admin credentials are required");
  const response = await fetch(new URL("/api/auth/login", base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }), redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Admin login failed: HTTP ${response.status}`);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  if (!cookie) throw new Error("Admin login did not issue a session cookie");
  return async (entry) => {
    if (!entry.path.startsWith("/api/") || entry.path.includes("\\")) throw new Error("Refusing a readiness route outside the authenticated API");
    const start = performance.now();
    const result = await fetch(new URL(entry.path, base), { headers: { Cookie: cookie, "Cache-Control": "no-cache" }, redirect: "error", signal: AbortSignal.timeout(120_000) });
    const bytes = Buffer.from(await result.arrayBuffer());
    const ms = performance.now() - start;
    return {
      status: result.status, ms, uncached: result.headers.get("X-Report-Cache")?.toUpperCase() !== "HIT",
      value: result.ok && entry.kind === "xlsx" ? await workbookSemantics(bytes) : jsonValue.parse(JSON.parse(bytes.toString("utf8")))
    };
  };
}

/** Full semantic oracle from independently fetched JSON/service inputs, not from the download.
 * Shared writers retain exact formula expressions and their stored results; no recalculation claim. */
export async function readinessWorkbookOracle(entry: RequestCase, read: (path: string) => Promise<Json | null>, db: PrismaClient | null = null): Promise<WorkbookOracle | null> {
  const url = new URL(entry.path, "http://readiness.invalid");
  const params = Object.fromEntries(url.searchParams);
  let input: Json = null;
  const chunks: Buffer[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  let source: string;
  if (url.pathname === "/api/marketing/compensations.xlsx") {
    const report = await read(query("/api/marketing/compensations", params));
    if (report === null || !Array.isArray(object(report).activities)) return null;
    input = report;
    await writeMarketingCompensationWorkbook(report as unknown as MarketingCompensationReport, output);
    source = "same-parameter compensation JSON: all rows, strings, NULL/n/a, totals and diagnostics";
  } else if (url.pathname === "/api/reports/turnover.xlsx") {
    const preview = await read(query("/api/reports/turnover", params));
    if (preview === null || !Array.isArray(object(preview).rows) || !array(object(preview).rows).length) return null;
    const rows: Json[] = [];
    for (const previewRow of array(object(preview).rows).map(object)) {
      const auditGroup = key(previewRow.key);
      if (!auditGroup) return null;
      const detail = await read(query("/api/reports/turnover/row", { ...params, auditGroup }));
      const row = detail === null ? null : object(detail).row;
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      // Preview and row must agree on every field exposed in both endpoints.
      const projected: Record<string, Json> = { ...row, primaryAction: key(object(array(row.recommendations)[0] ?? null).action) };
      for (const name of Object.keys(previewRow)) if (!Object.hasOwn(projected, name) || compareSemanticValues(previewRow[name], projected[name]).length) throw Object.assign(new Error("Turnover preview/drilldown mismatch"), { readinessMismatch: true });
      rows.push(row);
    }
    await writeTurnoverWorkbook({ ...object(preview), rows } as unknown as TurnoverReport, output);
    input = { ...object(preview), rows };
    source = "same-parameter turnover preview plus actual auditGroup row JSON for every exported row";
  } else if (url.pathname === "/api/reports/year-comparison.xlsx") {
    if (!db) return null;
    // These modules capture environment-bound config/the shared client transitively.
    // Static imports would run before readiness validates and installs its read-only target.
    const { getYearComparison, yearComparisonQuerySchema } = await import("../services/year-comparison.js");
    const { writeYearComparisonWorkbook } = await import("../services/year-comparison-workbook.js");
    const report = await db.$transaction((client) => getYearComparison(yearComparisonQuerySchema.parse(params), { client }), { isolationLevel: "RepeatableRead", timeout: 120_000 });
    const json = await read(query("/api/reports/year-comparison", params));
    if (json === null) return null;
    const visible = { periods: report.periods, stores: report.stores, coverage: report.coverage, quality: report.dataQuality.periods };
    if (compareSemanticValues(visible, json).length) throw Object.assign(new Error("Year-comparison HTTP/internal oracle mismatch"), { readinessMismatch: true });
    await writeYearComparisonWorkbook(report, output);
    input = jsonValue.parse(JSON.parse(JSON.stringify(report)));
    source = "same-parameter getYearComparison on the independently bound read-only target, cross-checked with HTTP JSON";
  } else if (url.pathname === "/api/reports/presentation.xlsx") {
    if (!db) return null;
    // Same guarded environment-initialization boundary as the year-comparison oracle.
    const { getPresentationReport } = await import("../services/presentation-report.js");
    const { writePresentationReportWorkbook } = await import("../services/presentation-report-workbook.js");
    const report = await db.$transaction((client) => getPresentationReport({ from: params.from, to: params.to, monthFrom: params.monthFrom, monthTo: params.monthTo }, client), { isolationLevel: "RepeatableRead", timeout: 120_000 });
    await writePresentationReportWorkbook(report, output);
    input = jsonValue.parse(JSON.parse(JSON.stringify(report)));
    source = "same-parameter getPresentationReport on the independently bound read-only target (no presentation JSON route)";
  } else return null;
  return { value: await workbookSemantics(Buffer.concat(chunks)), source, input };
}

async function readiness(args: ParityArguments) {
  const rawPlan: unknown = JSON.parse(await readFile(args.plan, "utf8"));
  const plan = parseReloadPlan(rawPlan), binding = { ...plan, planSha256: hash(canonicalJson(rawPlan)) };
  const dsn = process.env.VERIFY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!dsn) throw new Error("VERIFY_DATABASE_URL is required for read-only readiness verification");
  const url = new URL(dsn);
  if (decodeURIComponent(url.pathname.slice(1)) !== "nalivdata") throw new Error("Readiness is authorized only for nalivdata");
  if (process.env.PGSCHEMA && process.env.PGSCHEMA !== plan.sourceSchema.name) throw new Error("PGSCHEMA does not match reload plan");
  url.searchParams.set("connection_limit", "2");
  url.searchParams.set("options", `${url.searchParams.get("options") ?? ""} -c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000`.trim());
  // Dynamically imported internal report oracles must use the same read-only target.
  process.env.DATABASE_URL = url.toString();
  process.env.PGSCHEMA = plan.sourceSchema.name;
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  let internalReportsLoaded = false;
  try {
    const measurement = async () => {
      const [row] = await db.$queryRawUnsafe<Array<{ name: string; oid: number; schemaName: string; schemaOid: number; databaseBytes: bigint; readOnly: string; hasLedger: boolean }>>(
        `SELECT current_database() AS name, d.oid::integer AS oid, n.nspname AS "schemaName", n.oid::integer AS "schemaOid",
          pg_database_size(current_database()) AS "databaseBytes", current_setting('transaction_read_only') AS "readOnly",
          to_regclass('ops.analytics_reload_plans') IS NOT NULL AS "hasLedger"
         FROM pg_database d JOIN pg_namespace n ON n.nspname=$1 WHERE d.datname=current_database()`, plan.sourceSchema.name);
      if (!row || row.name !== plan.targetDatabase.name || row.oid !== plan.targetDatabase.oid || row.schemaName !== plan.sourceSchema.name || row.schemaOid !== plan.sourceSchema.oid) throw new Error("Readiness DSN database/schema does not match the reload plan");
      if (row.readOnly !== "on") throw new Error("Readiness connection must be transaction_read_only");
      return { ...row, databaseBytes: Number(row.databaseBytes) };
    };
    const before = await measurement();
    const ledgerSql = `SELECT plan_sha256 AS "planSha256", contract_sha256 AS "contractSha256", index_manifest_sha256 AS "indexManifestSha256"
       FROM ops.analytics_reload_plans WHERE reload_id=$1::uuid AND table_schema=$2`;
    const ledgerRows = before.hasLedger ? await db.$queryRawUnsafe<LedgerBinding[]>(ledgerSql, plan.migrationId, plan.sourceSchema.name) : [];
    const http = await readinessLogin(args.base);
    const challenge = randomUUID();
    const identityResponse = await http({ path: query("/api/analytics/storage-identity", { challenge }), kind: "json" });
    let identityFailure: string | null = null;
    try { validateReadinessIdentity(identityResponse.value, binding, challenge, ledgerRows.length === 1 ? ledgerRows[0] : null); }
    catch (error) { identityFailure = error instanceof Error ? error.message : "API identity validation failed"; }
    // Never issue business requests to an API whose challenged database/schema is wrong.
    const actualIdentity = apiIdentitySchema.parse(identityResponse.value);
    if (identityResponse.status !== 200 || actualIdentity.challenge !== challenge || compareSemanticValues(plan.targetDatabase, actualIdentity.targetDatabase).length || compareSemanticValues(plan.sourceSchema, actualIdentity.sourceSchema).length) throw new Error("Challenged API identity does not match the reload target");
    const discovered = await discoverReadinessSelection(http, plan);
    const matrix = requiredReadinessCases(discovered.selection);
    const routes: ReadinessRoute[] = [];
    const read = async (path: string) => {
      const existing = routes.find((entry) => entry.path === path && entry.kind === "json" && entry.status === "passed")
        ?? discovered.discovery.find((entry) => entry.path === path && entry.kind === "json" && entry.status === "passed");
      if (existing) return existing.value;
      const result = await sampleReadiness(http, { path, kind: "json" });
      routes.push(result);
      return result.status === "passed" ? result.value : null;
    };
    const exports: Array<{ path: string; status: ReadinessStatus; source: string | null; reason: string | null; differences: string[]; formulaDifferences: string[]; cachedResultDifferences: string[] }> = [];
    for (const entry of matrix.cases) {
      const result = await sampleReadiness(http, entry);
      routes.push(result);
      if (entry.kind !== "xlsx") continue;
      if (result.status !== "passed") {
        exports.push({ path: entry.path, status: result.status, source: null, reason: result.reason, differences: [], formulaDifferences: [], cachedResultDifferences: [] });
        continue;
      }
      let oracle: WorkbookOracle | null = null;
      try {
        internalReportsLoaded = true;
        oracle = await readinessWorkbookOracle(entry, read, db);
        const comparison = compareReadinessWorkbook(result.value, oracle?.value ?? null);
        const fields = oracle ? compareReadinessFields(entry.path, result.value, oracle.input) : [];
        exports.push({ path: entry.path, source: oracle?.source ?? null, ...comparison, status: fields.length ? "failed" : comparison.status, reason: fields.length ? "Independent JSON-to-XLSX field projection differs" : comparison.reason, differences: [...comparison.differences, ...fields] });
      } catch (error) {
        const mismatch = error instanceof Error && "readinessMismatch" in error;
        exports.push({ path: entry.path, status: mismatch ? "failed" : "incomplete", source: null, reason: mismatch ? error.message : "Same-parameter JSON/internal oracle could not be established", differences: [], formulaDifferences: [], cachedResultDifferences: [] });
      }
    }
    const health = await sampleReadiness(http, { path: "/api/sync/health", kind: "json" });
    routes.push(health);
    const reloadReadiness = object(health.value).reloadReadiness ?? null;
    const coverageProbes = [];
    for (const entry of pendingReadinessCases(plan, reloadReadiness)) {
      const result = await sampleReadiness(http, entry);
      routes.push(result);
      coverageProbes.push({ path: entry.path, expectedCode: "ANALYTICS_RELOAD_INCOMPLETE", success: result.httpStatus === 503 && result.code === "ANALYTICS_RELOAD_INCOMPLETE" });
    }
    const after = await measurement();
    const afterLedgerRows = after.hasLedger ? await db.$queryRawUnsafe<LedgerBinding[]>(ledgerSql, plan.migrationId, plan.sourceSchema.name) : [];
    const afterChallenge = randomUUID();
    const afterIdentity = await http({ path: query("/api/analytics/storage-identity", { challenge: afterChallenge }), kind: "json" });
    try {
      if (afterIdentity.status !== 200) throw new Error("API identity HTTP request failed");
      validateReadinessIdentity(afterIdentity.value, binding, afterChallenge, afterLedgerRows.length === 1 ? afterLedgerRows[0] : null);
    }
    catch { identityFailure ??= "API identity/layout changed during verification"; }
    const incomplete = [...matrix.skipped, ...readinessBusinessFixtures(routes.filter((route) => route.status === "passed"))];
    if (!discovered.populated) incomplete.push({ path: "/api/reports/sales", reason: "No populated one-day sales window was found inside the plan horizon" });
    if (object(reloadReadiness).status !== "ready") incomplete.push({ path: "/api/sync/health", reason: "Full reload horizon is not certified ready" });
    const success = !identityFailure && discovered.populated && !incomplete.length && object(reloadReadiness).status === "ready" && after.databaseBytes < RELOAD_PAUSE_AT_BYTES && routes.every((route) => route.status === "passed") && exports.every((entry) => entry.status === "passed");
    await atomicJson(args.output, {
      proofVersion: 1, kind: "post-cleanup-readiness", success, capturedAtUtc: new Date().toISOString(),
      targetDatabase: plan.targetDatabase, sourceSchema: plan.sourceSchema, migrationId: plan.migrationId,
      planSha256: binding.planSha256, contractSha256: plan.contractSha256, indexManifestSha256: plan.indexManifestSha256,
      databaseBytes: after.databaseBytes, beforeDatabaseBytes: before.databaseBytes, pauseAtBytes: RELOAD_PAUSE_AT_BYTES,
      apiIdentity: actualIdentity, afterApiIdentity: afterIdentity.value, identityBinding: { success: identityFailure === null, reason: identityFailure },
      reloadReadiness, selection: discovered.selection, populated: discovered.populated,
      discovery: discovered.discovery, routes, exports, coverageProbes, skippedCases: incomplete,
      timing: { warmupCalls: 1, measuredCalls: 3, statistic: "median", cache: "uncached", baselineComparison: false },
      limitations: ["Independent JSON field checks cover compensation items, turnover identities/metrics and comparison/presentation valuation audits; other fields/formulas use full semantic comparison with shared writers", "Formula expressions and cached results are compared separately; no Excel recalculation engine is run", "Positive-TTL warm-cache invalidation needs transactional integration fixtures; this verifier requires TTL zero", "Writer quiescence, automatic scheduler restart, browser verification and physical/catalogue index health are not certified by this HTTP readiness artifact"]
    });
    if (!success) throw new Error("Post-cleanup readiness is incomplete; inspect the external report");
    console.log("Post-cleanup readiness: proof written");
  } finally {
    await db.$disconnect();
    if (internalReportsLoaded) {
      // Internal report modules own this environment-bound singleton; see the oracle loading boundary.
      const { prisma } = await import("../prisma.js");
      await prisma.$disconnect();
    }
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = argumentsFor(argv);
  dotenv.config();
  if (process.env.REPORT_CACHE_TTL_SECONDS !== "0") throw new Error("Set REPORT_CACHE_TTL_SECONDS=0 for both API and parity process");
  if (args.command === "readiness") { await readiness(args); return; }
  const planBytes = await readFile(args.plan);
  const rawPlan: unknown = JSON.parse(planBytes.toString());
  const plan = planSchema.parse(rawPlan);
  const planSha256 = hash(canonicalJson(rawPlan));
  const target = plan.targetDatabase;
  if (!target.name.endsWith("_storage_rehearsal")) throw new Error("HTTP parity must target the planned isolated _storage_rehearsal clone");
  const dsn = process.env.VERIFY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!dsn) throw new Error("VERIFY_DATABASE_URL is required for clone identity verification");
  const url = new URL(dsn); url.searchParams.set("connection_limit", "1");
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try {
    const snapshot = async (): Promise<Json> => db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const [live] = await tx.$queryRawUnsafe<Array<{ name: string; oid: number }>>("SELECT current_database() AS name, oid::integer AS oid FROM pg_database WHERE datname=current_database()");
      if (live.name !== target.name || live.oid !== target.oid) throw new Error("Verification DSN does not match the planned rehearsal target");
      const schemaName = plan.sourceSchema.name;
      const names = (await tx.$queryRawUnsafe<Array<{ name: string }>>("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p') ORDER BY c.relname", schemaName)).map((row) => row.name);
      if (plan.retainedTables.some((name) => !names.includes(name))) throw new Error("A planned retained source is missing");
      const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
      const relations: Json[] = [];
      for (const name of plan.retainedTables) {
        const [row] = await tx.$queryRawUnsafe<Array<{ count: string; latest: string | null }>>(`SELECT count(*)::text AS count, max(_loaded_at)::text AS latest FROM ${quote(schemaName)}.${quote(name)}`);
        relations.push({ name, count: row.count, latest: row.latest });
      }
      return { targetDatabase: live, sourceSchema: schemaName, relations } as Json;
    }, { timeout: 900_000 });
    const before = await snapshot();
    const http = await login(args.base);
    const binding = { proofVersion: 1 as const, targetDatabase: target, planSha256, contractSha256: plan.contractSha256, indexManifestSha256: plan.indexManifestSha256 };
    const identityBinding = { ...binding, sourceSchema: plan.sourceSchema, migrationId: plan.migrationId };
    const readApiIdentity = async (activated: boolean) => {
      const challenge = randomUUID();
      const response = await http({ path: query("/api/analytics/storage-identity", { challenge }), kind: "json" });
      return validateApiIdentity(response.value, identityBinding, challenge, activated);
    };
    const apiIdentity = await readApiIdentity(args.command === "compare");
    const now = new Date().toISOString();
    if (args.command === "capture") {
      const values = await captureSamples(http);
      const after = await snapshot();
      if (compareSemanticValues(before, after).length) throw new Error("Source changed during capture; stop every writer before parity baseline");
      await readApiIdentity(false);
      await atomicJson(args.output, { ...binding, kind: "storage-http-baseline", success: true, sourceSnapshot: before, apiIdentity, capturedAtUtc: now, clockDayUtc: now.slice(0, 10), fixedWindows: WINDOWS, clockAssumption: "API host UTC day unchanged; all report windows explicit", ignoredFields: ["generatedAt", "generatedAtUtc", "XLSX generatedAt cells"], ...values });
    } else {
      const baselineBytes = await readFile(args.baseline!);
      const baseline = baselineSchema.parse(JSON.parse(baselineBytes.toString()));
      for (const field of ["planSha256", "contractSha256", "indexManifestSha256"] as const) if (baseline[field] !== binding[field]) throw new Error(`Baseline ${field} mismatch`);
      if (!baseline.success || baseline.kind !== "storage-http-baseline" || baseline.targetDatabase.name !== target.name || baseline.targetDatabase.oid !== target.oid || !baseline.samples.length) throw new Error("Invalid baseline proof");
      if (baseline.clockDayUtc !== now.slice(0, 10)) throw new Error("Clock-sensitive rehearsal crossed a UTC day; capture before migration and compare on a same-day/frozen-clock clone");
      if (compareSemanticValues(baseline.sourceSnapshot, before).length) throw new Error("Retained source counts/content-change boundaries changed on the frozen clone");
      validateApiIdentity(baseline.apiIdentity, identityBinding, baseline.apiIdentity.challenge, false);
      const coverage = validateParityCoverage(baseline.samples, baseline.selections);
      const routes = [];
      for (const previous of baseline.samples) {
        const current = await sample(http, previous);
        const differences = compareSemanticValues(previous.value, current.value);
        const performanceSuccess = performanceGate(previous.medianMs, current.medianMs);
        routes.push({ path: previous.path, kind: previous.kind, success: !differences.length && performanceSuccess, differences, beforeMedianMs: previous.medianMs, afterMedianMs: current.medianMs, beforeSamplesMs: previous.samplesMs, afterSamplesMs: current.samplesMs, performanceSuccess });
      }
      const after = await snapshot();
      const unchanged = compareSemanticValues(before, after).length === 0;
      const success = unchanged && routes.every((entry) => entry.success);
      const afterApiIdentity = await readApiIdentity(true);
      await atomicJson(args.output, { ...binding, sourceSchema: plan.sourceSchema, migrationId: plan.migrationId, kind: "storage-http-parity", success, sourceSnapshot: before, capturedAtUtc: now, baselinePath: args.baseline, baselineSha256: hash(baselineBytes), beforeApiIdentity: baseline.apiIdentity, afterApiIdentity, coverage, populatedLeapFixture: true, routes, selections: baseline.selections, comparisonsSha256: hash(JSON.stringify(routes)), performance: { success: routes.every((entry) => entry.performanceSuccess), allowedRegression: { fraction: 0.25, floorMs: 500 } }, frozenThroughout: unchanged });
      if (!success) throw new Error("HTTP/XLSX semantic or performance parity failed; inspect the external report");
    }
    console.log(`Storage parity ${args.command}: proof written`);
  } finally { await db.$disconnect(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Storage parity failed"); process.exitCode = 1; });
}
