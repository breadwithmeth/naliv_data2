# Naliv web analytics

This is the API and React web UI for the data loaded by `naliv_data1` into
PostgreSQL. Checks, check composition, and the hourly heatmap use the KKM check
tables:

- `document_chek_kkm`
- `document_chek_kkm_tovary`

The nightly receipt sync requests only the receipt header and `Товары` fields
these queries read. The `Оплата` part is fetched only by one-off diagnostics
(`--full-fields`) and is not refreshed by the schedule.

Income, nomenclature, and marketing attribution use the final 1C retail-report
tables:

- `document_otchet_o_roznichnyh_prodazhah`
- `document_otchet_o_roznichnyh_prodazhah_tovary`
- `document_otchet_o_roznichnyh_prodazhah_vozvraschennye_tovary`

Retail-report revenue is net of the explicit return table. Income reverses both
revenue and cost for returned items. Income's cost hierarchy is the latest
store/item `СебестоимостьНоменклатуры` record with `active IS NOT FALSE`, the
latest store-specific cost-setting line, the latest item cost-setting line among
stores, then quantity-weighted purchase cost less recorded VAT over 90 days.
Every source is bounded strictly before the selected period end. Missing
valuation stays visible through coverage and unvalued revenue, not trusted zero.
Equal source timestamps and line numbers are resolved deterministically: document
key, then price for cost documents; price for live cost-register rows. Latest
retail-price ties use document key, then price. Index choice and insertion order
must not change a valuation.

The sales report uses KKM checks (`document_chek_kkm` with its `Товары` part) for
check counts, items per check, the timestamp-based hourly heatmap, and top-item
composition. The average check instead divides official retail-report header
net revenue by sale checks minus return checks. Retail reports remain the
official basis for income/P&L and promotion attribution, and
the report shows a checks-versus-reports reconciliation — loaded checks, the
share linked to a retail report, and the revenue difference — instead of hiding
the gap. Check export stays behind the `--include-check-kkm` gate, which the
scheduled management profile supplies explicitly.

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
`PGSCHEMA=raw_1c` when using the default loader schema. `APP_SCHEMA=public`
selects the separate schema used by app-owned directories; it defaults to
`public` and the API creates its five `naliv_*` tables on first use.

Open <http://localhost:5173> and sign in with `APP_ADMIN_EMAIL` and
`APP_ADMIN_PASSWORD`. Vite serves the web UI and proxies `/api` to the API port
configured by `PORT` in the same `.env` file.

Report endpoints (`/api/reports/sales`, `/api/reports/income`,
`/api/nomenclature`, `/api/marketing`, `/api/inventory`, and
`/api/management/*`) build a half-open window — `date >= from and date < to` —
and default to the current calendar month (UTC boundaries) when a request
carries no `from`/`to`. An empty range means "this month", never "every year";
pass an explicit range such as `?from=2026-01-01&to=2027-01-01` to widen it. The
web UI prefills the same month and shows the end date inclusively, converting it
to the exclusive bound before sending. `period` (`day`, `week`, `month`) only
selects the chart bucket.

## Year-over-year Excel

Admins open `Продажи` → `Сравнение годов` and apply the shared inclusive dates.
The coverage preview loads automatically. Review coverage/valuation warnings,
choose the comparable outlets, then use `Скачать отчёт Excel`. The export has
no dashboard top-store limit. A manual physical-outlet checklist supports both
one outlet and an explicitly empty comparable network; all-outlet rows remain
in either case. Leaving the analysis or changing dates cancels obsolete browser
requests; changing the selection cancels an outdated download. Preview and
download also have explicit cancel buttons. A shared in-flight server report can
still finish for other subscribers.

Russian reader instructions are embedded on `Методология` under
`Как читать отчет: оформление, показатели и источники`, including the colour
legend, `*`, zero versus `n/a`, B–U formulas, receipt/average semantics, share
denominators, source tables, valuation priorities, and audit checks. These
instructions are included in future exports without adding another worksheet.
The delivered [printable Russian guide](<../Инструкция к аналитическому отчету год к году.pdf>)
contains the workbook's compact instructions. The
[detailed Russian instructions](<../Инструкция к аналитическому отчету год к году.md>)
add a real-number example from the delivered quarter and a step-by-step audit.

Admin-only endpoints:

- `GET /api/reports/year-comparison` — lightweight `periods`, `stores`,
  `coverage`, and `quality` preview;
- `GET /api/reports/year-comparison.xlsx` — streamed XLSX from the same cached
  report snapshot when parameters match.
  Shared strings and level-9 ZIP compression reduce repeated audit keys/names
  without dropping detailed rows or reducing numeric precision.

Example: `?from=2026-04-01&to=2026-07-01&cohort=observed`. Both bounds are required
real `YYYY-MM-DD` dates, years start at `0002`, and the current half-open window
contains 1–366 days. The previous window shifts both calendar bounds back one
year, clamping February 29 to February 28. A collapsed previous window stays
empty. Source receipt timestamps use the stored 1C business calendar; they are
not timezone-shifted. UTC is used for boundary arithmetic and file snapshot time.

`cohort=observed` selects outlets with positive sale activity in both windows,
not a proven opening date. For `cohort=custom`, repeat
`comparableStore=<physical key>` from the preview; no keys means an empty network.
Unknown keys return 400. Observed mode rejects a supplied custom list. Anonymous
requests return 401; the marketing account cannot access either endpoint (403).

The supplied human workbook is a layout/business-category reference, not a data
source: its filename and date headers disagree. Generated headers use the
requested windows. The seven comparison sheets cover the combined category and
its six members; `Доли продажи общие` and `Доли продаж внутри группы` complete
the business sheets. `Методология`, `Качество данных`, `Магазины`,
`Классификация`, and `Оценка стоимости` retain the audit trail.

Calculation rules:

- Eligible posted, nondeleted, nonzero KKM receipts supply recorded goods-line
  revenue and quantities. Returns reduce values once, including source lines
  already recorded negative. Header/line differences are shown, never allocated.
- Recorded revenue includes the VAT embedded in 1C retail amounts; it is not
  VAT-exclusive revenue. Quantities retain raw 1C units, including services;
  mixed totals are not normalized pieces or liters.
- Physical outlets merge legal-entity keys only by the exact normalized address
  beginning at `г.`. Costs are calculated by original store key before merging.
- Categories use the current `catalog_nomenklatura` folder tree and nearest
  matching ancestor. The combined group contains `Пивной напиток`, `Пиво бут`,
  `Пиво жб`, `Пиво розлив`, `Разливные напитки`, and `Энергетический напиток`.
  `Мульти пак` is excluded from the combined group but included in within-group
  shares. Missing references, orphans, cycles, depth limits, and other items
  remain auditable rather than disappearing.
- Counts are distinct positive sale receipts per group, not sums of overlapping
  category counts. Subtotal averages divide net totals by those distinct counts;
  they do not sum outlet averages. Missing data and zero-base growth are `n/a`.
- Gross income is an estimate using the canonical cost hierarchy separately at
  each exclusive period end, not historical COGS, accounting profit, or P&L.
  Unknown material costs make the affected aggregate unavailable. Known cost,
  unvalued quantity/revenue, and selected valuation sources remain visible.
- One SQL statement reads both windows, taxonomy, and valuations from one
  database snapshot. Days with receipts prove observed activity, not complete
  source ingestion; the workbook lists missing days and global source coverage.

Validation on 2026-10-03 for April–June 2025/2026: 91 observed days in each window,
15 source store keys merged into 11 physical outlets, 10 automatically comparable.
All-item line revenue was 977,023,929 ₸ (2025) and 1,168,049,165 ₸ (2026);
lines minus headers were −67,890.23 ₸ and −47,174.05 ₸ respectively.
After historical valuation recovery, unvalued net revenue remained 2,915 ₸ and
790,280 ₸; unavailable costs must not be presented as zero. Receipt history starts
on 2025-01-24; retail-report history still starts on 2026-06-01, so the existing
retail-based income/P&L cannot supply a complete April–June comparison.

## Configurable presentation Excel

The presentation and `year_report_notes.txt` define an additional report, not a
replacement for the existing quarterly workbook. In `Продажи` → `Сравнение годов`,
choose `Итоги периода и месяца — по презентации` in `Формат Excel`. Shared dates
set the main window; separate inclusive dates set the additional window. By
default the latter is the final calendar month intersected with the main window.
Select cities, or leave the selection empty for the whole network. Both windows
compare their calendar bounds with the preceding year; neither year nor month is
hardcoded. Each current window accepts 1–366 days.

`GET /api/reports/presentation.xlsx` is admin-only. API/CLI dates are half-open:
`from`/`to` are required; `monthFrom`/`monthTo` must be supplied together or omitted
together. Repeat `city` for several cities; omitted/empty selection means all.
The endpoint uses the existing authenticated report cache and streaming XLSX
download conventions. The first sheet records all parameters and the coverage
of all four sales windows. Missing previous-year history does **not** block the
download: unavailable values, changes and comparable-network indicators are
`n/a`, not fabricated zeros. The browser also warns when the main previous window
is empty. Partial history remains explicitly marked as observed, incomplete data.

CLI export uses the same calculation and writer, and refuses to overwrite an
existing output file:

```powershell
npm run export:presentation-report -- --from=2025-01-01 --to=2026-01-01 --month-from=2025-12-01 --month-to=2026-01-01 --output="../Итоги года и декабря 2025 — аналитика.xlsx"
```

The 18 sheets include all main-window root groups, additional-window packaged
and draught subcategories, all-goods totals, all-group city shares, every supplier
in each window, unassigned income, observed declines, editable actions, and
methodology/source audits. A direct DISTINCT union supplies all-goods/beverage
receipt counts; overlapping category counts are never summed. Beverage
classification uses the current catalog, with its rule and uncertainties
recorded per item. Nonbeverage and unmapped items stay in all-goods totals/shares.

Supplier rules:

- Purchases are posted, nondeleted receipt-header amounts less the normalized
  magnitudes of supplier-return-header amounts. Recorded VAT semantics are
  retained; missing document amounts make affected totals unavailable.
- Income is an explicitly labelled **unique-supplier model**, not proven sale-lot
  provenance, historical COGS, supplier accounting profit, or P&L. Only one valid
  supplier in positive-quantity purchase lines of the same original store/item
  and window permits attribution. Unknown suppliers, multiple suppliers and
  absent purchases stay in reason-specific residuals; the current catalog's
  main-supplier fields are not used.
- Costs use the existing period-end hierarchy before physical-outlet merging.
  Unknown material costs keep full gross income unavailable; the known portion
  is separate. Assigned plus residual revenue/known income reconcile to sales.
- Receiving city governs purchases; selling-store city governs modeled income.
  Internal-tax-ID matches are flagged, not automatically excluded. Comparable
  indicators use only outlets with positive sales in both windows, not claimed
  opening dates.
- City/numeric-share AutoFilters have `SUBTOTAL` visible financial totals.
  Unknown visible amounts/income remain `n/a` rather than partial numeric sums.
  Share denominators remain fixed city totals; sums of shares across cities are
  not a network share. Category-filtered receipt totals are deliberately absent.
- Export-city selection limits business sheets only. Quality, valuation,
  classification and attribution audits remain explicitly labelled full-network
  evidence. Overlapping main/additional windows must not be added together.

Delivered FY2025/December2025 evidence: no 2024 sales/purchases; sales begin
2025-01-24 (342/365 annual days), December has 31/31 observed days. Net line revenue
is 3,566,587,300 ₸ and 385,816,562 ₸; purchases are 2,836,936,290.24 ₸ and
397,077,850.64 ₸, covering 235/150 distinct suppliers. The model assigns 82.82%/
86.13% of net sales revenue, not a proven percentage of gross income. Full-period
gross income remains unavailable because absolute unvalued quantities are 6.608/
4 in mixed 1C accounting units.

Verification: API/web compilation, 34/34 PostgreSQL-enabled tests, actual
city/independent-period browser download reconciled against SQL, and CLI export
with both current and previous histories absent. Microsoft Excel 16.0 opened the
delivered workbook normally, fully recalculated and saved all 18 sheets with
zero formula errors. Native city/share filtering recalculated visible supplier
totals; the recalculated package passed Open XML validation without errors.

## Оборачиваемость товарных запасов

Раздел **Товары → Оборачиваемость** (`#stock/turnover`) формирует Excel в двух вариантах:
«Сводно по товарам» и «По магазинам».
В форме выбираются **«Товараоборот в шт.»** или **«Товараоборот в деньгах»**, детализация,
период, магазины, склад, несколько категорий, бренд и товар, затем нажимается
**Скачать Excel**. Настройки находятся слева, состав выбранной выгрузки и скачивание —
справа; на телефоне блоки располагаются друг под другом. Предпросмотр и повторный расчёт
в браузере не нужны: файл формируется одним запросом.

- **«Сводно по товарам»** — две таблицы: остатки и продажи; одна строка на SKU.
  **«По магазинам»** — строки магазин × SKU, листы динамики 7/14/30, ежедневных
  остатков, перемещений и параметров. По умолчанию выбран сводный отчёт.
- **Вся сеть** — 11 физических магазинов с проведёнными розничными отчётами, а не 24
  записи `catalog_magaziny`. Юридические лица с одинаковым точным адресом от «г.»
  объединены: их остатки и продажи суммируются, себестоимость берётся по исходному
  ключу до объединения. Офисы и отделы по умолчанию исключены; их остатки можно
  включить отдельным флажком (`storeScope=all`), при этом продажи останутся `n/a`.
  Магазин с остатком, но без проведённого розничного отчёта за доступную историю,
  по умолчанию не входит в сеть: его нужно выбрать явно. Склад по умолчанию — склад
  выбранного магазина; удалённые и помеченные «не использовать» склады исключены.
- Период задаётся непосредственно в отчёте; обе даты включены, изменения действуют сразу.
  Быстрые кнопки: **Прошлый месяц**, **Текущий месяц**, **Последние 30 дней**,
  **Прошлый квартал**. Месяц и квартал — календарные; последние 30 дней заканчиваются
  вчера, без незавершённого сегодня. Текущий месяц охватывает весь календарный месяц.
- Категории выбираются флажками с поиском. Выбор сохраняется при поиске; выбранные
  категории можно убрать по одной или очистить все. В отчёт входит объединение
  выбранных групп и их вложенных категорий, без повторного учёта пересечений.
  Пустой выбор означает все категории. API передаёт ключи повторяющимся параметром
  `category=key1&category=key2`; `TurnoverRequest.category` — массив ключей.
- Флажок **«Исключить нулевые товары»** удаляет строку только тогда, когда все
  дневные остатки и продажи равны точному нулю за весь период. Пропуски, `null` и
  нулевая продажа при ненулевом остатке остаются в отчёте.
- При смене магазинов склад сбрасывается, чтобы не сохранять несовместимый отбор.
  Пустой справочник брендов явно обозначен; выбор бренда в этом случае недоступен.

Сводный формат файла:

- Лист **«рассчет оборачиваемости»** (в денежном варианте — с завершающим пробелом):
  строка заголовков закреплена; `Номенклатура`, дневные остатки, колонки `01.09.` и `01.09. / 2`,
  последняя дата с половинной колонкой, `сумма остатков за период`,
  `средний товарный запас в шт`, `Коэффицент оборачиваемости`,
  `количество дней в периоде`, `продажи в шт за период`, `количесто дней оборота в шт`.
- Лист **«Продажи за период »**: номенклатура и продажи; в денежном варианте добавляется
  себестоимость и итоговая строка `Итого`.
- Совпадают ширины колонок (A = 65.5703125; даты = 9.140625; последние шесть колонок —
  26.7109375 / 29.28515625 / 29.28515625 / 27.28515625 / 24.5703125 / 29.28515625),
  шрифт и числовой формат `0.00` у среднего, коэффициента, дней и оборота, границы и
  заливка по умолчанию, альбомная ориентация A4, поля и автофильтр денежного листа
  `A1:AM1` для 30-дневного периода. Закреплённых строк, объединённых ячеек и цветных
  заголовков нет.
- Формулы: `B/2`, `AG/2`, сумма взвешенных дневных остатков,
  `AH/(N−1)`, `AL/AI`, `AK/AJ`, `VLOOKUP` на лист продаж. Сумма строится по колонкам
  `C…AF` (половины крайних дней), поэтому не воспроизводит ошибочный `SUM(B:AG)` из
  части исходных строк; отображение и формат при этом те же.
- Сводный отчёт требует не менее двух календарных дней; одна строка соответствует одному SKU. Пропущенные
  остатки и цены выводятся как `n/a`, а не как нули. В денежном отчёте используется
  учётная себестоимость; розничная выручка не подменяет её.
- В сводном формате количество и денежные значения каждого товара суммируются по
  всем выбранным физическим магазинам и складам. Выбор магазинов или конкретного
  склада ограничивает эту же сводную строку, а не создаёт отдельные строки.
- Дневные остатки и продажи объединяются после применения исторических цен своего
  исходного юридического лица. Средний запас, коэффициент и дни оборота
  пересчитываются по сводным значениям; коэффициенты отдельных магазинов не
  складываются. Пропуск стоимости или остатка не заменяется нулём и делает
  соответствующий итог неизвестным.
- Точный SKU и текстовый поиск используют одну и ту же совокупность фактических
  магазинов; отсутствующая строка не создаётся для офиса или магазина без данных.
- Разные SKU и учётные единицы не смешиваются. В денежном листе продаж общий
  количественный `Итого` доступен только при единой учётной единице; иначе — `n/a`.
- К названиям не добавляются магазины. Если разные SKU имеют одинаковые названия,
  в обоих листах добавляется ключ SKU, чтобы `VLOOKUP` находил правильный товар.

Поиск товара заранее сужает источник по названию, артикулу, коду или ключу SKU.
Справочники формы загружаются отдельным запросом `GET /api/reports/turnover/options`.
Готовый XLSX кэшируется; заголовки `X-Report-Cache`, `X-Report-Rows` и `Server-Timing`
показывают источник и объём результата.

Admin API: `GET /api/reports/turnover/options` — физические магазины и склады;
`GET /api/reports/turnover.xlsx` — сводный отчёт при `profile=sample` или
отчёт по магазинам при `profile=full`; `GET /api/reports/turnover` — компактный JSON для
интеграций; `GET /api/reports/turnover/row` — подробности строки по `auditGroup`.
`storeScope=retail` (по умолчанию) — розничные физические магазины; `storeScope=all` —
включая офисы и отделы. `excludeZero=true` скрывает только строки, где все дневные
остатки и продажи равны нулю за весь период. Границы API — `[from,to)`, максимум 366 дней;
UI показывает включительную конечную дату. Все маршруты требуют admin.

Для новой установки подготовьте покрывающие индексы без изменения исходных записей:
`npm run db:optimize -- --turnover-only` показывает DDL,
`npm run db:optimize -- --turnover-only --apply` применяет только индексы отчёта через
`CREATE INDEX CONCURRENTLY` и обновляет статистику. При отсутствии данных отчёт
показывает ошибку; при недоступности PostgreSQL — сообщение и действие повторной загрузки.

### Измерения на полном ассортименте

Замеры после объединения магазинов: сентябрь 2026, **5 152 строки** SKU × физический
магазин, 11 магазинов. Замеры на реальном PostgreSQL и собранном сервере:

| Сценарий | Время |
|---|---:|
| Полная сеть, штуки, первый запрос | **32,1 с**, файл **1,69 МБ** |
| Полная сеть, деньги, первый запрос | **42,3 с**, файл **1,56 МБ** |
| Повторная выгрузка того же файла | **0,012 с** из кэша |
| Поиск «Трубочка чёрная», 7 строк | **~2–3 с** |
| Справочники формы | **~0,1–0,3 с** |

Ранее полный внутренний отчёт занимал 130 МБ и не сохранялся в кэше 64 МБ, поэтому
каждая выгрузка пересчитывалась; теперь готовый файл помещается в кэш. Первичное
формирование широкой выборки остаётся тяжёлой операцией; это не SLA. Контрольный SKU
с SQL-сверкой дневного среднего для одного магазина: 4443,241379; нетто-продажи 4, оценка по себестоимости
17,2 ₸, розничная выручка 40 ₸.

## Management workspaces and source-ready metrics

Primary navigation follows business tasks rather than database entities:

`Обзор` · `Продажи` · `Магазины` · `Товары` · `Финансы` · `Маркетинг`.

Each workspace shows one selected analysis instead of stacking unrelated
reports. Inventory and assortment use a task selector for their detailed
tables; income analysis separates the result, stores, items, and a chosen
store's items. Existing sorting, drill-downs, and full-list controls remain.
`Финансы` includes income analysis and development projects; control rules live
under `Обзор`. The overview leads with available results and links to the next
analysis; longer explanations and source-blocked strategic metrics use
disclosures.

Reports share one applied period while the dashboard is open. Draft date
changes do not alter the figures until `Применить`; both dates are required and
reversed ranges cannot be applied. Switching analyses preserves the applied
dates. Day/week/month grouping belongs to sales and income charts, separately
from the reporting window. Hash navigation (`#page/view`) restores the selected
analysis on browser back. Date-independent settings, control rules, payments,
and project forms keep their own business controls.

`Настройки` is separate from business navigation. Technical source health,
table profiles, and raw samples load only after explicitly opening
`Настройки` → `Диагностика`; synchronization has its own settings view.
Marketing users only see `Маркетинг`; the API still enforces the same role
restrictions. Account details and logout are inside `Профиль`.

A source-blocked business metric renders `Нет данных` with the missing
prerequisite; absence is never formatted as a valid zero. Partial coverage,
unknown costs, and estimates remain visible beside the affected analysis.
Income estimates are not presented as accounting profit. Ordinary server-error
states do not expose backend/database diagnostics.

Metric cards, analytical table headers, and charts use the
`web/src/metric-definitions.ts` glossary and native collapsible guides.
Each explanation pairs Russian business meaning with the exact formula, unit,
source entities/fields, window, denominator, missing-data rules, and handbook
differences. The help panel stays within the viewport, supports explicit close
and Escape, and returns keyboard focus to its trigger. Live status, coverage,
and snapshot dates come from the response, separately from static definitions.

Admin-only management endpoints:

- `GET /api/management/losses` — write-offs plus revision shortages, less
  capitalized surpluses and revision gains, with store revenue and loss rate;
- `GET /api/management/acquiring` — card sales and returns from the payment-card
  accumulation register; commission remains `null` with `unavailable` status
  because every available commission field is zero;
- `GET /api/management/cash-articles` — cash-only ОДДС from PKO/RKO: operating,
  investing, and financing flows from financier-approved DDS mappings;
  unambiguous own-desk/KKM-extraction documents and approved internal-transfer
  articles are excluded. Internal documents without payment lines are reported
  from header amounts instead of disappearing from the excluded total. The
  available PKO/RKO bank-account fields contain only zero-key placeholders,
  so cash↔bank and other ambiguous articles require financier approval.
  Unclassified turnover
  and amount coverage remain explicit;
- `GET /api/management/money-position` — current ordinary cash and KKM cash by
  store, days of uncollected KKM cash against 28-day cash revenue, plus the raw
  supplier-settlement register values; bank remains `null`;
- `GET /api/management/supplier-terms` — amount-weighted deferral from delivery
  payment stages, plus order amount, linked receipts, execution, and partial
  open-order calendars. Their UTC-midnight start is the earlier of the requested
  end and today; stages cover the following 30/56 days, not bank payments;
- `GET /api/management/purchasing` — target-stock replenishment recommendations,
  a monetary seven-day purchase budget, and prior-seven-day budget execution
  using store norms, current stock, open orders, 28-day check velocity, canonical
  cost, and primary regional suppliers;
- `GET /api/management/lost-sales` — monetary Lost Sales for A/B items from
  daily zero-stock snapshots, with explicit snapshot coverage;
- `GET /api/management/store-stock` — positive stock valuation by store as of
  the selected end date, with cost coverage, unvalued quantity, and negative
  balances kept separate;
- `GET /api/management/store-performance` — net revenue, profit after document
  and revision losses, 28-day stock days, in-stock-day frozen stock, stock
  movement, and annualized GMROI over average daily stock by active store;
- `GET /api/management/source-health` — KKM coverage in the selected window,
  store areas, payroll, bank-table availability, VAT availability, and
  sales/return reconciliation. Check-day coverage is measured only against
  completed UTC days, so the remaining future days of the selected month do
  not create a false gap.
- `GET /api/management/settings` and `PUT /api/management/settings/*` — active
  store master, metric thresholds/owners, approved DDS classification, manual
  obligations/payroll/loans, and reinvestment projects.

App-owned configuration is stored outside the `raw_1c` export in
`naliv_store_settings`, `naliv_metric_settings`,
`naliv_cash_article_settings`, `naliv_obligations`, and `naliv_projects`.
`APP_SCHEMA` chooses their schema. Export synchronization does not overwrite
them. Repeated RKO articles seen in at least two of the previous six months are
offered as permanent-payment candidates; no suggestion is saved until a user
accepts and saves it. DDS keyword suggestions likewise remain unapproved until
the financier confirms them. A confirmed `internal` DDS mapping excludes the
article from all three flows; this is how the financier marks collection,
bank-deposit, change-replenishment, and other own-money transfer articles.

Nomenclature uses net retail-report sales and full calendar days, including days
without a sale row. Nomenclature **and Inventory item valuation** use only:

1. the latest cost-setting item line among all stores before the window end;
2. quantity-weighted purchase lines less recorded VAT over the preceding 90 days.

They do not consume store/item register or store-specific cost-setting priority.
Nomenclature lifetime first/last sale and candidate last-purchase dates are not
bounded by a historical end: later loaded dates can appear in historical views.
Its days-since calculation floors UTC dates and clamps negative differences to
zero. ABC includes the current item in cumulative positive revenue
(A ≤80%, B ≤95%); XYZ uses sample deviation over the zero-filled daily calendar.
Nonpositive mean yields technical class Z, while the UI says CV is undefined.

Missing item cost produces `null` profit/margin and explicit unvalued revenue.
`Дни без продаж` remains a separate observed behavior. Monetary Lost Sales is
published only when both the daily stock-snapshot coverage and the KKM-check
coverage of the window reach 90%; below that the observed amount is shown with a
`partial` state instead of a trusted figure.

Balance-function imports are complete non-zero snapshots. Stock consumers select
one global `balance_period` at each boundary; they never carry a dimension's
older non-zero row into a newer snapshot where that dimension is absent.
Store-performance frozen-stock velocity uses only positive-stock days and
requires 90% daily-snapshot coverage; its GMROI uses average valued daily stock.
Nomenclature candidate frozen stock instead uses nonnegative calendar-day
velocity for the selected window and a 30-day target, without that daily-stock
coverage gate. These are different estimates, not interchangeable totals.
The purchase budget is
`max(norm + forecast_7d - stock - open_orders, 0) × canonical_cost`; execution
compares the prior seven days' orders with the budget reconstructed at that
window's opening snapshot.

The UI deliberately does **not** call cash balances a complete cash position,
open-order payment stages complete obligations, raw supplier-register signs
confirmed payables, card turnover acquiring in transit, or promotion
attribution ROI. Bank statements are not loaded, so §4.4 cash/bank
reconciliation remains unavailable even when cash-only flow classification is
complete. Supplier balance signs still need financier approval, store areas are
empty, current payroll/timesheets and loan schedules are absent. Separate VAT
fields are sparse; this does not make recorded prices VAT-free. The owner
confirmed the VAT-inclusive price basis, which is retained without deduction.
Promotion returns cannot be linked reliably to the original sale. §7.5 markup
remains unavailable until the ownership/policy and internal-supply links are
approved. Those limitations stay next to the affected numbers; absent sources
are never rendered as zero.
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

The `Администрирование` page includes a read-only `Синхронизация` panel fed by
`GET /api/sync/health` (admin only). It shows the scheduler's own state read from
`ops.sync_scheduler` (is the container alive, what it last decided and why, the
cooldown holding a startup sync back, the flags it actually received, the last
lines of its log), then the newest run recorded by `naliv_data1` in
`ops.sync_runs` (status, exit code, coverage, deep re-read month, failing chunk),
where that run's log and metrics live on the export server, the last lines of its
log, how current each exported table is, and the last ten runs. Both log blocks
are collapsed for a normal state and expanded when something needs attention —
a failed run, a probe failure, or a bypass cooldown. The run block shows the
stored tail (`log_tail`, bounded), not the file itself.
`api/src/services/sync-health.ts` reads both tables with raw queries — neither has
a Prisma model, and `docs`/`ops` are not part of the report path. Each read
degrades on its own: a missing `ops.sync_scheduler` leaves the run section
intact, and the three log columns of a run are read through `to_jsonb` so the
panel still works in the window before the scheduler's next run adds them.

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
Promotion cards are therefore labelled as an estimate before returns; they do
not claim ROI, incremental revenue, or contribution profit.

Item composition is parsed from the data-composition schema inside
`shema_komponovki_dannyh_base64_data`: the `ФормированиеСегмента` settings
variant holds the explicit item list, while `ВыводСегмента` only selects output
fields. The rule set is loaded and parsed once per `REPORT_CACHE_TTL_SECONDS`,
so a new export becomes visible no later than the report cache itself.

These inputs are part of the nightly export of `naliv_data1`:
`Document_МаркетинговаяАкция` is read in full on every run (no date window, so a
promotion edited after its document date still refreshes) and
`Catalog_СегментыНоменклатуры` is one of the default catalogs. The incremental
`--with-catalogs` profile is enough for marketing. Sales and Excel additionally
require `--include-check-kkm`; verify the deployed scheduler environment, because
a local `.env` update does not change a running export container.

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
Sales filters receipts before sharing their lines across series, heatmap, and
composition in one query; income shares selected retail-report lines in one
query. Source health aggregates only selected parents' goods lines. Marketing
derives its summary from the store aggregate, and table profiles compute numeric
and date summaries in a single scan. The Excel query aggregates numeric facts
and distinct receipt counts at source-store grain before address/scope expansion;
JIT is disabled locally in that report transaction, not globally.

Authenticated report responses have a bounded, per-process cache: by default
`REPORT_CACHE_TTL_SECONDS=60`, `REPORT_CACHE_MAX_MB=64`, and at most 128 entries.
Identical simultaneous requests share one load. Keys include source/application
schemas, authenticated role, report generation, endpoint, and validated parameters.
Authentication and role checks run before every lookup; browser responses remain
`Cache-Control: no-store`. TTL starts when computation completes and remains the
retention bound. Set it to `0` to disable retention while retaining request
sharing. Restarting the API clears its cache. Errors and oversized responses are
not retained; an invalidated in-flight load cannot repopulate the new generation.
`X-Report-Cache` (`miss`, `shared`, `hit`) and `Server-Timing` expose request
timings in browser developer tools without logging report contents.

`REPORT_CACHE_SYNC_POLL_SECONDS=2` checks completed `ops.sync_runs` in the
background on report traffic; `0` disables this optional signal. Every completed
run, including a failed run that may have committed batches, invalidates reports.
Missing/unreadable telemetry falls back to TTL. Sync telemetry is not an atomic
cross-entity publication boundary. Management-setting writes invalidate the
current API process immediately; other replicas retain the TTL bound.

The login/session shell does not load the chart-heavy Dashboard until successful
authentication. Administration overview loads only on administration navigation.
Concurrent settings subscribers share a request with independent cancellation,
not a completed-result browser cache. API/static responses use compression;
content-hashed assets are immutable for one year, while HTML revalidates.

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
and reports nothing either way). Those performance rewrites were verified
row-for-row against their previous implementations except for floating-point
summation order. Current fixtures additionally pin unavailable commission,
low-coverage supplier terms, canonical nomenclature returns/cost/as-of behavior,
store profit-after-loss/stock-days/GMROI, and app-owned management directories.

The 2026-09-25 source-led pass verified the live result end to end for
`2026-09-01..2026-09-26`: 11 active stores, net revenue ≈285.90m ₸,
profit after losses ≈94.46m ₸, closing stock ≈287.71m ₸, frozen stock
≈166.30m ₸ (58%), GMROI ≈5.09 with 100% daily-snapshot coverage, uncollected
KKM cash ≈22.3 days at 100% cash-report coverage, a seven-day purchase budget
of ≈6.47m ₸ at ≈99.95% cost coverage with ≈37.3% execution, and ≈9.60m ₸ of
open-order payment stages over the next 56 days (explicitly partial; most
staged orders in that window are already closed).

Validation on 2026-10-03 for `from=2026-09-01&to=2026-09-25&period=day`:

| Request | Captured before | Final cache miss | Final cache hit |
| --- | ---: | ---: | ---: |
| Sales | 24.497 s | 5.648 s | 0.017 s |
| Income | 16.243 s | 4.636 s | 0.091 s |
| Marketing | 8.501 s | 8.670 s | 0.007 s |
| Inventory | 7.069 s | 4.840 s | 0.102 s |
| Nomenclature | 5.941 s | 2.843 s | 0.055 s |
| Store performance | 16.525 s | 10.677 s | 0.004 s |
| Money position | 0.236 s | 0.217 s | 0.003 s |
| Lost sales | 33.683 s | 4.866 s | 0.003 s |
| Purchasing | 33.287 s | 9.045 s | 0.003 s |
| Source health | 25.869 s | 1.075 s | 0.003 s |

These are sequential individual localhost HTTP measurements against PostgreSQL
17.11, not percentiles or guaranteed cold-disk timings. Marketing did not improve
in this monthly run. Sales and marketing matched every captured response field
and identity-aligned row within floating-point tolerance; recorded income and
nomenclature quantities/revenues also matched. Historical purchase/cost recovery
and deterministic tie selection legitimately changed valuation, purchase-history,
and coverage fields, so those are not claimed unchanged.

Default current-month cache misses: sales 0.371 s, income 1.619 s, money position
0.124 s, source health 0.539 s. The actual anonymous compiled browser load
transferred about 65 KB of JavaScript without Dashboard/admin requests;
administration overview was first requested after navigation. All 28 analytics
indexes were valid and occupied 1,347.5 MiB in this database, including the eight
original indexes retained by the optimizer; unrelated indexes were not removed.

The quarterly Excel preview took 27.495 s on a cache miss; its matching download
uses the same cached snapshot. The initial query exceeded 300 s. The first
streaming file passed tolerant reader checks but had invalid worksheet-property
ordering: ExcelJS emitted explicit `outlinePr` after `pageSetUpPr`. The writer
now uses the correct default outline placement; a regression checks OOXML
`sheetPr` ordering rather than trusting the same library's reader.

The repaired full-quarter HTTP XLSX is about 2.01 MB instead of 3.12 MB (35.6%
smaller), with all 14 sheets and all taxonomy/valuation audit rows retained.
Shared strings and level-9 compression preserve quantities, amounts, receipt
counts, and formula results. A same-data 256 MiB-heap render took 2.35 s at about
205 MiB peak process RSS, versus 574 MiB for the old in-memory writer.
Worksheet schema checks passed. Microsoft Excel 16.0 opened the actual HTTP
download in its documented normal-load mode, without a repair/extraction option,
and fully recalculated all sheets with zero formula errors; combined revenue and
distinct receipt totals matched the report.

Actual browser custom/empty selection and cancellation, an interrupted HTTP
stream, and anonymous/marketing denial were exercised. Canceling output stops
the writer; a shared database computation may still complete. Rebuild/redeploy
the API and web assets to enable these changes.

Run `npm test` for cache, authorization, metric-state, canonical-calculation,
and management-directory regressions; run `npm run build` for the API and web
build. Set `ANALYTICS_TEST_DATABASE_URL` to a PostgreSQL connection URL to
enable database integration tests. They use connection-local temporary source
and application tables and roll back their transactions; they do not modify
source data.

## Current status against `Справочник метрик Naliv 1.docx`

The dashboard's `ⓘ` explanations give each displayed value's unit, formula,
source fields, period, denominator, zero/`Нет данных` behavior, owner, and known
limitations. Chart disclosures describe axes, aggregation, and interpretation.
Use those explanations before comparing values across pages: sales receipts,
retail-report lines, retail-report headers, and balance snapshots are distinct
source populations. A missing/partial value is not a measured zero.

| Area | Formula or source currently used | Difference / status against the handbook |
| --- | --- | --- |
| Sales, composition, and hourly heatmap | Posted KKM receipt headers/lines, with return receipts subtracted. The heatmap bins receipt timestamps by store, weekday, and hour. | Revenue remains at the recorded price basis. The heatmap sums the selected weekday across the chosen range; §6.3 asks for a four-week average, not currently shown. Coverage and links to retail reports do not prove complete ingestion. |
| Income report revenue | Sum of retail-report sale-item `summa` minus returned-item `summa`; this is line revenue. | The owner confirms that 1C prices correctly include VAT. The dashboard does not remove the VAT component. The handbook's P&L requires revenue without VAT, so current income and margins are explicitly VAT-inclusive and do **not** yet match that P&L line. No VAT rate or subtraction is inferred. |
| Cost | Income/store performance/purchasing use store cost register → store-specific cost-setting → latest cost-setting item among stores → quantity-weighted 90-day purchases. Inventory/nomenclature use only the last two sources. | All prices are before the window end, not each sale date. The “global” installation can belong to another store; purchases are not proven external-only. Missing себестоимость will be filled in 1C: recheck coverage after synchronization, not by inserting application zeros. |
| Losses and after-loss gross profit | Posted, nondeleted write-offs and capitalization plus signed inventory-recount differences; net losses = write-offs + shortages − capitalization − surpluses. After-loss gross profit = line revenue − estimated cost − net losses. | Recount differences are not causally linked to generated adjustment documents. A recount variance may therefore overlap a later write-off/capitalization; no duplicate-event reconciliation is proven. Product-level profit remains before losses because no evidenced allocation exists. |
| Average check | Retail-report header revenue (`summa_dokumenta − summa_vozvratov`) ÷ (sale checks − return checks). | Below 90% calendar-day coverage for either source, or a nonpositive denominator, the application returns `Нет данных`. This 90% publication gate is an application safeguard, not a handbook threshold. Receipt-header revenue on the Sales page is a separate reconciliation value. |
| Supplier payment deferral | Amount-weighted days from delivery stages (`summa × otsrochka_platezha` ÷ stage amount). Order stages serve only order statistics/calendars. | Below 80% of receipts with usable stages, or with nonpositive/missing total weight, deferral is unavailable. A genuine zero-day term with positive weight remains valid. The 80% gate is an application safeguard. Future order calendars start at UTC midnight of `min(requested end, now)` and are not complete obligations. |
| Stock and purchasing | Store performance computes monetary stock-days using 28-day cost of goods sold. Purchasing uses mapped 1C target-stock quantities, balances, open-order quantities, and a seven-day demand forecast. | Item inventory tables show quantity-based days over a fixed 28-day demand window; the store-level figure is monetary. Purchasing has no fallback group-day norms for unmapped product/store pairs. Adding себестоимость enables money valuation but does not supply a missing target-stock norm or confirm a store/group mapping. |
| Frozen inventory / GMROI / lost sales | Store frozen stock uses positive-stock-day velocity; nomenclature candidates use calendar-day velocity. Both currently use a 30-day target. GMROI annualizes after-loss profit over average valued daily stock. Lost sales estimates calendar-day check revenue × zero-stock snapshot-days for local A/B items. | These populations/denominators differ. No group-specific frozen target or dynamic 10%/20% alert bands are applied. Lost-sales A/B includes a threshold-crossing item in the previous class, unlike nomenclature ABC. Lost-sales dates end no later than the latest available balance; missing daily snapshots are not zero-stock observations. Publication gates are application safeguards, not handbook norms. |
| Cash, bank, and full P&L | Cash and KKM are the latest available 1C balance snapshots; cash-days uses KKM balance ÷ average reported cash sales over 28 calendar days. | Bank statements are not available yet; bank balances, acquiring in transit, payment coverage, and a complete bank/cash-flow statement are unavailable, not zero. The legacy KKM/store-key relationship and opening-balance treatment have not been approved, so the dashboard does not merge or discard balances. Full store contribution, EBITDA, and net profit also require the handbook's rent, payroll, expense, tax, and internal-transfer inputs; they are not represented by gross profit. |
| Owner-set policies and unprovided dimensions | Handbook proposals for reserve weeks and owner payout share remain parameters requiring owner approval; current source data has no completed store-area values or payroll-by-point source. | Free cash, payout limit, rent/payroll ratios, per-square-metre output, shift contribution, and metrics depending on these inputs remain unavailable. They are never filled with zero or silently seeded from handbook examples. |
| Expense and margin controls | Gross profit subtracts estimated product costs and additive inventory losses only. A static directory exposes unavailable handbook formulas without fake numeric cards. | Consumables and internal markup are not eliminated, and payroll/rent/tax/other expenses are not fully supplied. The handbook's store-margin comparison to network median (−2/−5 percentage points) is documented but not calculated dynamically. Full contribution, break-even, safety margin, EBITDA and net profit remain unavailable. |

Inventory demand, last-sale lookup, and quantity-based stock days use the fixed
28 days ending at the exclusive end, independent of `from`. The rate retains
signed returns; stock days are `null` unless both stock and net demand are
positive. Latest retail price, purchases, and cumulative sales use loaded
history, not that 28-day window; a historical snapshot is therefore not a fully
historical reconstruction. “Локаций” counts distinct stored `sklad_key` values,
not a proven physical warehouse count.

Display rounding: `formatMoney`/`formatNumber` show whole ₸/integers;
decimal columns choose their own precision; compact numbers retain at most one
decimal. Calculations and API values are not rounded to those displayed digits,
so a sum of visible rounded cells can differ from the displayed rounded total.
Storage sizes use powers of 1024, not 1000; PostgreSQL estimated row counts are
estimates, not exact `COUNT(*)`.

Read-only inventory-event investigation for `[2026-06-01,2026-10-09)` found 50
posted recounts with bases; 45 share an inventory-order base with an adjustment.
The adjustment basis type is
`StandardODATA.Document_ПриказНаПроведениеИнвентаризацииТоваров`.
For those 45 shared bases:

| Comparison | Recount amount, ₸ | Adjustment amount, ₸ | Bases equal within 0.01 ₸ |
| --- | ---: | ---: | ---: |
| Shortage vs write-off | 34,857,076.47 | 34,846,611.16 | 30 |
| Surplus vs capitalization | 20,624,449.93 | 21,000,517.00 | 18 |

This is evidence of overlap risk, not a universal deduplication rule. No event
is removed merely because amounts match. The dashboard retains additive loss
semantics and discloses the unresolved reconciliation of base, item, and date.

Application coverage gates and classification cut-offs are documented separately
from handbook targets in the metric explanations. The metric registry contains
defaults for decision thresholds; stored owner overrides are not replaced by
those defaults.

Verification of this handbook/explanation pass:

- API and web TypeScript checks and the full `npm run build` completed.
  The final wording-only web rebuild also completed. Vite still reports the
  dashboard chunk-size warning; it is not a failed build.
- The full isolated suite passed **35/35**, **0 failures**, **0 skipped**,
  with fixture-only accounts and `APP_SCHEMA=pg_temp`.
- Actual authenticated local API requests checked Income summary/period/store
  reconciliation, the official-header/net-check average, signed fixed-28-day
  Inventory rates and independence from `from`, supplier coverage/horizon rules,
  purchase recommendations and execution, and marketing/catalogue denominators.
  Six positive brewery recommendations matched the actual 1C
  `normativnyy_zapas_karagandinskiy_pivzavod` field.
- The built web application was exercised in Chromium at 1440×960 and 390×844:
  metric and numeric-column help, source fields after scrolling, Enter/Escape
  and restored focus, native chart/table guides, Income legends, matrix counts,
  undefined margins/CV, comparison accessibility, source/freshness diagnostics,
  and manual obligation/project guides. Unavailable handbook formulas expose
  explanations rather than fabricated values.
- Verification used read-only exported data and connection-local temporary
  application tables. No production deployment, backfill, source correction,
  remote `.env` mutation, or accounting-policy cutover was performed.
