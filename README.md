# Naliv web analytics

This is the API and React web UI for the data loaded by `naliv_data1` into
PostgreSQL. Sales, heatmaps, income, nomenclature, and marketing analytics use
the final 1C retail-report tables:

- `document_otchet_o_roznichnyh_prodazhah`
- `document_otchet_o_roznichnyh_prodazhah_tovary`

The runtime API does not query individual `document_chek_kkm` receipt tables.
Legacy receipt models remain in the Prisma schema only for compatibility with
existing databases.

## Development: API and web UI together

Requirements: Node.js 20 or newer and a PostgreSQL database populated by
`naliv_data1`.

```powershell
cd C:\projects\Work\naliv_data_project\naliv_data2
Copy-Item .env.example .env
npm ci
npm run prisma:generate
npm run dev
```

Before starting, edit `.env` and set `DATABASE_URL`, both account credentials,
and a random `JWT_SECRET` of at least 24 characters. The admin and marketing
accounts must have different email addresses and passwords. Keep
`PGSCHEMA=raw_1c` when using the default loader schema.

Open <http://localhost:5173> and sign in with `APP_ADMIN_EMAIL` and
`APP_ADMIN_PASSWORD`. Vite serves the web UI and proxies `/api` to the API port
configured by `PORT` in the same `.env` file.

Report endpoints (`/api/reports/sales`, `/api/reports/income`,
`/api/nomenclature`, `/api/marketing`, `/api/inventory`) build a half-open
window — `date >= from and date < to` — and default to the current calendar
month (UTC boundaries) when a request carries no `from`/`to`. An empty range
means "this month", never "every year"; pass an explicit range such as
`?from=2026-01-01&to=2027-01-01` to widen it. The web UI prefills the same month
and shows the end date inclusively, converting it to the exclusive bound before
sending. `period` (`day`, `week`, `month`) only selects the chart bucket.

The account configured by `APP_MARKETING_EMAIL` and `APP_MARKETING_PASSWORD`
can open only the marketing section. This restriction is enforced by the API:
the account may call `/api/marketing` and its own `/api/auth` session endpoints,
while analytics, sales reports, nomenclature, inventory, and raw table endpoints
return HTTP 403 before querying PostgreSQL.

## Production build

```powershell
npm ci
npm run build
npm start
```

The production API serves the built UI from `web/dist`; open
<http://localhost:4000>. Set `WEB_ORIGIN` to the public UI origin when the UI is
hosted separately.

## Loading data from 1C

Run the PostgreSQL exporter from `naliv_data1`. Its default and
`--all-documents` modes exclude individual receipts unless the explicit
compatibility flag is supplied. Detailed commands are in
`..\naliv_data1\EXPORT_1C_ODATA_INSTRUCTIONS.md`.

## Sync panel

The "База данных" page starts with a read-only "Синхронизация" panel fed by
`GET /api/sync/health` (admin only). It shows the newest run recorded by
`naliv_data1` in `ops.sync_runs` (status, exit code, coverage, deep re-read
month, failing chunk), where that run's log and metrics live on the export
server, the last lines of its log, how current each exported table is, and the
last ten runs. The log block is collapsed for a successful run and expanded for
a failed or interrupted one; it is the tail the scheduler stored in the row
(`log_tail`, bounded), not the file itself. `api/src/services/sync-health.ts`
reads the table with a raw query — it has no Prisma model, and `docs`/`ops` are
not part of the report path. The three log columns are read through `to_jsonb`
so the panel still works in the window before the scheduler's next run adds
them.

The panel is diagnostic, never a dependency: when the table does not exist yet,
or the site's role cannot read schema `ops`, the endpoint answers
`available: false` with a reason and the freshness part is still rendered. Table
freshness means "content changed" — `_loaded_at` is bumped only when a row
differs, so an old timestamp means 1C had no new data, not that the export
skipped the table. That mode is what `api/src/scripts/check-sync-freshness.ts`
prints, and it shares `SYNC_TABLE_GROUPS`, `SYNC_STALE_AFTER_HOURS`, and
`collectTableFreshness` with the service.

## Promotion analytics

The marketing page shows which promotions actually sold, per shop and per item.
A promotion is only in the data if it has a percent discount rule that is
effective for the shop, the sale date, and the item, and the discount baked into
the line matches that rule. The page reads:

- `document_marketingovaya_aktsiya` and its table parts
  `document_marketingovaya_aktsiya_skidki_natsenki` (rule schedule and shop) and
  `document_marketingovaya_aktsiya_magaziny` (promotion scope);
- `catalog_skidki_natsenki` for the rule percent and the segment it applies to;
- `catalog_segmenty_nomenklatury` for the item composition of that segment;
- `document_otchet_o_roznichnyh_prodazhah` and
  `document_otchet_o_roznichnyh_prodazhah_tovary` for the sales themselves.

Retail-report lines do not carry a promotion or discount reference and
`protsent_skidki_natsenki` is zero on every line, so the link is derived: a line
belongs to a promotion when the shop and the date fall inside an effective rule
window, the item is in the rule's segment, and the discount implied by the line
(`1 - summa / (kolichestvo * tsena)`) is within `0.25` percentage points of the
rule percent. The tolerance absorbs two-decimal rounding in `summa` while
staying below the gap between the closest distinct rule percents in the data.
Verification on 2026-09-21: the closest rule percents on one shop differ by
0.3 pp, and widening the tolerance from 0.25 to 1.0 pp produced identical totals
for September, so no line is attributed by rounding alone. A line that satisfies
several rules of one promotion is counted once, at its highest rule percent.

Item composition is parsed from the data-composition schema inside
`shema_komponovki_dannyh_base64_data`: the `ФормированиеСегмента` settings
variant holds the explicit item list, while `ВыводСегмента` only selects output
fields. The rule set is loaded and parsed once per `REPORT_CACHE_TTL_SECONDS`,
so a new export becomes visible no later than the report cache itself.

These inputs are part of the nightly export of `naliv_data1`:
`Document_МаркетинговаяАкция` is read in full on every run (no date window, so a
promotion edited after its document date still refreshes) and
`Catalog_СегментыНоменклатуры` is one of the default catalogs. The deployment
runs the incremental `SCHEDULER_EXPORT_ARGS=--with-catalogs`, which is enough for
this page, so the analytics follows the export without the heavyweight full set.

`npm run check:sync-freshness` prints per synced table the row count, how often
its content changed, and when it last changed, which is the quickest way to see
whether the export is still feeding the site (`_loaded_at` moves only when a row
changes, so an unchanged table looks old without being stale).

`npm run verify:promo-attribution -- --from=2026-09-01 --to=2026-10-01`
recomputes the whole attribution from a second implementation — PostgreSQL
parses the segments and picks the rule with a lateral join instead of a window
function, and the totals come from a plain `group by` — then diffs it against
the report endpoint. It writes `verify-out/attribution-lines.csv`,
`verify-out/attribution-summary.json`, and `verify-out/near-miss-lines.json`
(the lines that fall just outside the tolerance), and exits non-zero on any
mismatch. `..\naliv_data1\verify_promotions.py` is the 1C-side counterpart: it
dumps the promotion documents, segment membership, retail-report lines, and
cheque discounts from OData to compare against these numbers. That script has
not been run, because the 1C server is not reachable from the development
machine; run it where OData is available.

## Performance tuning

Install the analytics indexes once for each populated database:

```powershell
npm run db:optimize                  # print the SQL without changing the database
npm run db:optimize -- --apply       # build indexes concurrently, then ANALYZE
```

For a production installation with only compiled files, use
`node dist/api/scripts/optimize-db.js --apply`. The command uses `DATABASE_URL`
and `PGSCHEMA`, requires the table owner's database privileges, and can be rerun.
It uses a dedicated single-connection pool and builds one index at a time outside
a transaction. Normal reads and writes can continue during index creation.
An interrupted concurrent build may leave an invalid index; the script reports
that condition rather than silently treating the invalid index as installed.

The exporter creates partial unique indexes for upserts. Those do not cover
analytics joins on `_parent_ref_key`; full reference-key indexes also allow
joins without assuming every source key is nonempty. Date and balance-period
indexes support bounded reports. These indexes persist across normal exports.
Sales now filters reports before aggregating their lines, marketing derives its
summary from the store aggregate, and table profiles compute numeric and date
summaries in a single table scan.

Authenticated report responses have a bounded, per-process cache: by default
`REPORT_CACHE_TTL_SECONDS=60`, `REPORT_CACHE_MAX_MB=64`, and at most 128 entries.
Identical simultaneous requests share one load. Keys include the schema, role,
endpoint, and validated parameters. Authentication and role checks run before
every lookup; browser responses remain `Cache-Control: no-store`. Data can lag
an export by at most the TTL after a report finishes computing. Set the TTL to
`0` to disable retention while retaining concurrent-request sharing. Restarting
the API clears its cache. Errors and oversized responses are not retained.
`X-Report-Cache` (`miss`, `shared`, `hit`) and `Server-Timing` expose request
timings in browser developer tools without logging report contents.

Independent report queries use the database pool concurrently. The default
pool size is `DB_CONNECTION_LIMIT=5`; increase it only when PostgreSQL has spare
connection and CPU capacity. A `connection_limit` already present in
`DATABASE_URL` takes precedence.

Validation on 2026-09-07 for `from=2026-08-24&to=2026-09-01&period=day`:

| Request | Before | After (uncached service) |
| --- | ---: | ---: |
| Marketing | 110.84 s | 0.47 s |
| Sales | 1.49 s | 0.34 s |
| Income | — | 0.73 s |
| Inventory | — | 2.53 s |
| Nomenclature | — | 0.30 s |

These are individual measurements against the configured database, not load-test
percentiles. Marketing and sales responses matched their captured baselines
within floating-point rounding. After installing the indexes, the public
marketing URL also returned HTTP 200 in 0.51 s before deploying the API changes.
The API code and cache require a normal application rebuild/redeployment.

Each report now spends one scan per source line table. Sales and income compute
their period series and grand summary in one `GROUPING SETS` scan, and derive
per-store and per-item totals from the heatmap cells or store-item rows instead
of re-aggregating the same lines. Measured on 2026-09-15 against the same
database, one uncached service call per endpoint, so the before and after values
below are a same-day pair on the range above:

| Request | Queries per request | Before | After |
| --- | ---: | ---: | ---: |
| Sales | 4 → 2 | 0.88 s | 0.52 s |
| Income | 5 → 2 | 1.04 s | 0.50 s |

Inventory reads each of the two line tables once instead of twice (2.17 s →
2.03 s, four alternating raw-query runs per query on the range above; the service
call adds row mapping on top of both). The nomenclature exit query merges its
period metrics, period bounds, and per-item last-sale lookups into one pass
(3.7 s → 1.7 s for `from=2026-06-02&to=2026-09-16`, where stock balances exist —
the standard range has no balance snapshot, so that query returns no rows there
and reports nothing either way). All rewrites were verified row-for-row against
the previous implementations on the same database, except for floating-point
summation order; the report integration test pins the derived income totals and
the inventory key set.

Run `npm test` for cache and authorization regressions and `npm run build` for
the API and web build. Set `ANALYTICS_TEST_DATABASE_URL` to a PostgreSQL connection
URL to enable the additional report integration test. That test uses only
connection-local temporary tables, including discount, null, duplicate-catalog,
empty-period, and date-boundary fixtures; it does not modify source data.
