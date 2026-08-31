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

## Performance tuning

Independent report queries use the database pool concurrently. The default
pool size is `DB_CONNECTION_LIMIT=5`; increase it only when PostgreSQL has spare
connection and CPU capacity. A `connection_limit` already present in
`DATABASE_URL` takes precedence.
