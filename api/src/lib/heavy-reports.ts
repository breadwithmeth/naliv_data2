import { fork } from 'node:child_process';
import { assertReloadReady } from '../services/reload-readiness.js';
import type { Response } from 'express';
import { checkReportMemory } from './report-memory.js';

export type HeavyReport = {
  kind: 'turnover-preview' | 'turnover-row' | 'turnover-xlsx' | 'compensation-preview' | 'compensation-xlsx';
  query: unknown;
};
export type WorkerMessage = { headers: Record<string, string> } | { error: string; statusCode: number; code?: string };

async function streamWorker(worker: URL, res: Response, report: HeavyReport, checkMemory?: (reserve: number) => void) {
  const start = performance.now();
  const child = fork(worker, [], {
    execArgv: ['--max-old-space-size=256', ...(worker.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [])],
    stdio: ['ignore', 'pipe', 'inherit', 'ipc']
  });
  const output = child.stdout!;
  let failure: Error | undefined;
  let ready = false;
  const stop = () => { child.kill('SIGKILL'); };
  const fail = (error: Error) => { failure ??= error; stop(); };
  const onMessage = (message: WorkerMessage) => {
    if (res.destroyed) return;
    if ('error' in message) {
      failure = Object.assign(new Error(message.error), {statusCode: message.statusCode, code: message.code});
      return;
    }
    ready = true;
    res.type('json');
    res.set(message.headers);
    res.setHeader('X-Report-Cache', 'bypass');
    res.setHeader('Server-Timing', `report;dur=${(performance.now() - start).toFixed(1)};desc="compute"`);
    // Let HTTP apply backpressure directly to the child. Do not label a truncated file successful.
    output.pipe(res, {end: false});
  };
  res.once('close', stop);
  output.on('error', fail);
  child.on('message', onMessage);
  child.on('error', fail);
  const monitor = checkMemory && setInterval(() => {
    try { checkMemory(0); } catch (err) { fail(err as Error); }
  }, 100).unref();
  try {
    // The queue slot belongs to the child until close (exit AND exhausted pipes), even on cancellation.
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    child.send(report, error => { if (error) fail(error); });
    const code = await closed;
    if (res.destroyed) return;
    if (failure || code !== 0 || !ready) {
      if (res.headersSent) { res.destroy(); return; }
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Type');
      throw failure ?? Object.assign(new Error('Процесс формирования отчёта завершился без результата.'), {statusCode: 503});
    }
    res.end();
  } finally {
    clearInterval(monitor);
    res.off('close', stop);
    output.unpipe(res);
    output.off('error', fail);
    child.off('error', fail);
    child.off('message', onMessage);
  }
}

/** Per API instance: one live report process and one cancellable waiting request. No report body is cached. */
export function createHeavyReportSender(worker: URL, guard: () => Promise<void>, checkMemory?: (reserve: number) => void) {
  let busy = false;
  let wake: (() => void) | undefined;
  return async (res: Response, report: HeavyReport) => {
    res.setHeader('Cache-Control', 'no-store');
    if (res.destroyed) return;
    if (busy) {
      if (wake) {
        res.setHeader('Retry-After', '5');
        throw Object.assign(new Error('Два отчёта уже запрошены. Повторите запрос позже.'), {statusCode: 503});
      }
      const granted = await new Promise<boolean>(resolve => {
        const closed = () => { wake = undefined; resolve(false); };
        wake = () => { res.off('close', closed); resolve(true); };
        res.once('close', closed);
      });
      if (!granted) return;
    } else busy = true;
    try {
      if (res.destroyed) return;
      checkMemory?.(100_000_000);
      await guard();
      if (!res.destroyed) {
        checkMemory?.(100_000_000);
        await streamWorker(worker, res, report, checkMemory);
      }
    } finally {
      const next = wake;
      wake = undefined;
      if (next) next(); else busy = false;
    }
  };
}

const worker = new URL(import.meta.url.endsWith('.ts') ? './heavy-report-worker.ts' : './heavy-report-worker.js', import.meta.url);
const deployed = process.env.NODE_ENV === 'production' || (process.platform === 'linux' && worker.pathname.endsWith('.js'));
export const sendHeavyReport = createHeavyReportSender(worker, () => assertReloadReady({kind: 'all'}), deployed ? checkReportMemory : undefined);
