import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HARD_BYTES = 1_000_000_000;
const TARGET_BYTES = 700_000_000;

/** In Coolify's private cgroup v2 namespace the root counters cover the API and its children. */
export function checkReportMemory(reserveBytes: number, directory = '/sys/fs/cgroup') {
  let limit: number, current: number;
  try {
    limit = Number(readFileSync(join(directory, 'memory.max'), 'utf8').trim());
    current = Number(readFileSync(join(directory, 'memory.current'), 'utf8').trim());
  } catch {
    throw Object.assign(new Error('Нельзя проверить лимит памяти контейнера отчётов (cgroup v2).'), {statusCode: 503});
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > HARD_BYTES || !Number.isSafeInteger(current) || current <= 0) {
    throw Object.assign(new Error('Для контейнера аналитики нужен проверяемый лимит памяти не более 1 ГБ.'), {statusCode: 503});
  }
  // Soft stop: sample the whole container, not just V8. The kernel enforces memory.max between samples.
  if (current + reserveBytes >= Math.min(TARGET_BYTES, limit * 0.85)) {
    throw Object.assign(new Error('Недостаточно памяти для этого отчёта. Уменьшите период или уточните фильтры.'), {statusCode: 503});
  }
}
