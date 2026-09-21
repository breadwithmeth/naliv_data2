// Shows how current the synced 1C data behind the analytics is.
//
// `_loaded_at` is bumped only when a row's content changes (`ON CONFLICT ...
// DO UPDATE ... WHERE <column> IS DISTINCT FROM EXCLUDED`), so it marks the last
// change, not the last fetch. Read a timestamp as "this table last carried new
// information", never as proof of whether the scheduled export touched it: a
// table that is exported every night with identical content keeps its old
// timestamp. The companion exporter check is
// `python run_scheduled_export.py --lookback-days 3 -- --with-catalogs` (writes,
// 1C reachable) and `export_1c_odata_to_postgres.py --dry-run` (reads only).
//
// Usage: npx tsx api/src/scripts/check-sync-freshness.ts [--schema=raw_1c] [--json]

import { PrismaClient } from "@prisma/client";

type Args = { schema: string; json: boolean };

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (const entry of argv) {
    if (entry === "--json") {
      values.set("json", "true");
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(entry);
    if (!match) {
      throw new Error(`Аргумент «${entry}» не распознан; ожидается --ключ=значение.`);
    }
    values.set(match[1], match[2]);
  }
  return { schema: values.get("schema") ?? "raw_1c", json: values.has("json") };
}

// Grouped by how the scheduled export covers each entity set.
const GROUPS: Array<{ title: string; tables: string[] }> = [
  {
    title: "Документы периода — экспортируются каждую ночь в окне 04:00–06:00 Asia/Qyzylorda",
    tables: ["document_otchet_o_roznichnyh_prodazhah", "document_postuplenie_tovarov"]
  },
  {
    title: "Справочники периода — экспортируются в финальной порции каждого запуска",
    tables: [
      "catalog_nomenklatura",
      "catalog_informatsionnye_karty",
      "catalog_skidki_natsenki",
      "catalog_segmenty_nomenklatury",
      "catalog_magaziny",
      "catalog_sklady"
    ]
  },
  {
    title: "Данные акций — документ акций читается целиком, без окна дат",
    tables: [
      "document_marketingovaya_aktsiya",
      "document_marketingovaya_aktsiya_skidki_natsenki",
      "document_marketingovaya_aktsiya_magaziny"
    ]
  }
];

const STALE_AFTER_HOURS = 48;

type TableFreshness = {
  group: string;
  table: string;
  rows: number;
  changes: number;
  lastChangeUtc: string | null;
  ageHours: number | null;
  unchangedForOverTwoDays: boolean;
};

const args = parseArgs(process.argv.slice(2));
const prisma = new PrismaClient();
const schema = args.schema.replaceAll('"', '""');

const existing = new Set(
  (
    await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_type = 'BASE TABLE'`,
      args.schema
    )
  ).map((row) => row.table_name)
);

const tables: TableFreshness[] = [];
for (const group of GROUPS) {
  for (const table of group.tables) {
    if (!existing.has(table)) {
      continue;
    }
    const stats = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `select count(*) as rows,
              count(distinct "_loaded_at") as changes,
              max("_loaded_at") as last_change
       from "${schema}"."${table}"`
    );
    const row = stats[0] ?? {};
    const lastChange = row.last_change instanceof Date ? row.last_change : null;
    const ageHours = lastChange ? (Date.now() - lastChange.getTime()) / 3_600_000 : null;
    tables.push({
      group: group.title,
      table,
      rows: Number(row.rows ?? 0),
      changes: Number(row.changes ?? 0),
      lastChangeUtc: lastChange ? lastChange.toISOString().slice(0, 19).replace("T", " ") : null,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      unchangedForOverTwoDays: ageHours !== null && ageHours > STALE_AFTER_HOURS
    });
  }
}

if (args.json) {
  console.log(
    JSON.stringify(
      { schema: args.schema, generatedAt: new Date().toISOString(), staleAfterHours: STALE_AFTER_HOURS, tables },
      null,
      2
    )
  );
} else {
  console.log(`Схема ${args.schema}, время UTC. «Изменений» — сколько раз содержимое таблицы менялось.`);
  let currentGroup = "";
  for (const row of tables) {
    if (row.group !== currentGroup) {
      currentGroup = row.group;
      console.log(`\n${currentGroup}`);
    }
    console.log(
      `  ${row.table.padEnd(46)} строк ${String(row.rows).padStart(8)}  изменений ${String(row.changes).padStart(4)}` +
        `  последнее ${row.lastChangeUtc ?? "—"}  давность ${row.ageHours === null ? "—" : `${row.ageHours} ч`}` +
        (row.unchangedForOverTwoDays ? "  !" : "")
    );
  }

  const unchanged = tables.filter((row) => row.unchangedForOverTwoDays);
  if (unchanged.length > 0) {
    console.log(
      `\n! — больше ${STALE_AFTER_HOURS} ч без изменений: ${unchanged.map((row) => row.table).join(", ")}.` +
        "\n  Это либо отсутствие новых данных в 1C, либо таблица вне набора экспорта." +
        "\n  Проверяется экспортером: python run_scheduled_export.py --lookback-days 3 -- --with-catalogs"
    );
  }
}

await prisma.$disconnect();
