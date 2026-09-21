// Shows how current the synced 1C data behind the analytics is.
//
// `_loaded_at` is bumped only when a row's content changes (`ON CONFLICT ...
// DO UPDATE ... WHERE <column> IS DISTINCT FROM EXCLUDED`), so it marks the last
// change, not the last fetch. Read a timestamp as "this table last carried new
// information", never as proof of whether the scheduled export touched it: a
// table that is exported every night with identical content keeps its old
// timestamp. The companion exporter check is
// `python run_scheduled_export.py --lookback-days 7 -- --with-catalogs` (writes,
// 1C reachable) and `export_1c_odata_to_postgres.py --dry-run` (reads only).
//
// Usage: npx tsx api/src/scripts/check-sync-freshness.ts [--schema=raw_1c] [--json]

import { prisma } from "../prisma.js";
import {
  SYNC_STALE_AFTER_HOURS as STALE_AFTER_HOURS,
  collectTableFreshness,
  type SyncTableFreshness as TableFreshness
} from "../services/sync-health.js";

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

const args = parseArgs(process.argv.slice(2));
const tables: TableFreshness[] = await collectTableFreshness(args.schema);

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
        "\n  Проверяется экспортером: python run_scheduled_export.py --lookback-days 7 -- --with-catalogs"
    );
  }
}

await prisma.$disconnect();
