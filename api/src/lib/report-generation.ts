import { config } from "../config.js";
import { prisma } from "../prisma.js";

export const reportGeneration = { value: 0 };
let observedSync: string | undefined;
let pending: Promise<void> | null = null;
let nextCheckAt = 0;
let reportedFailure = false;


async function readCompletedSync(): Promise<string> {
  const [table] = await prisma.$queryRaw<Array<{ readable: boolean }>>`
    select has_table_privilege(c.oid, 'SELECT') as readable
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'ops' and c.relname = 'sync_runs'
  `;
  if (!table?.readable) return "unavailable";

  // A failed run can have committed batches too. Invalidate on every completed
  // run, not only successes; telemetry is not a cross-entity snapshot boundary.
  const [run] = await prisma.$queryRaw<Array<{ id: bigint; finished_at: Date }>>`
    select id, finished_at
    from ops.sync_runs
    where finished_at is not null
    order by id desc
    limit 1
  `;
  return run ? `${run.id}:${run.finished_at.toISOString()}` : "no-completed-runs";
}

/** Refresh in the background: a warm report never waits for sync telemetry. */
export function refreshReportGeneration(invalidate: () => void) {
  const pollMs = config.REPORT_CACHE_SYNC_POLL_SECONDS * 1000;
  if (pollMs === 0 || pending || Date.now() < nextCheckAt) return;

  pending = readCompletedSync()
    .then((epoch) => {
      if (observedSync !== undefined && observedSync !== epoch) invalidate();
      observedSync = epoch;
      reportedFailure = false;
    })
    .catch(() => {
      // This is an optional early-invalidation signal. TTL remains the hard
      // freshness bound when telemetry is absent or the connection is down.
      if (!reportedFailure) {
        console.warn("Report cache sync-version check failed; TTL freshness remains in effect.");
        reportedFailure = true;
      }
    })
    .finally(() => {
      nextCheckAt = Date.now() + pollMs;
      pending = null;
    });
}
