import { Console } from 'node:console';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { prisma } from '../prisma.js';
import { compensationQuerySchema, getMarketingCompensationReport } from '../services/marketing-compensation.js';
import { writeMarketingCompensationWorkbook } from '../services/marketing-compensation-workbook.js';
import { assertReloadReady } from '../services/reload-readiness.js';
import { deliverTurnover } from '../services/turnover-delivery.js';
import { stringifyJson } from './http.js';
import type { HeavyReport, WorkerMessage } from './heavy-reports.js';

// stdout is exclusively the response body; application and Prisma diagnostics go to stderr.
globalThis.console = new Console(process.stderr, process.stderr);
const parentLost = () => process.exit(1);
process.once('disconnect', parentLost);
const send = (message: WorkerMessage) => process.send!(message);
process.once('message', async (job: HeavyReport) => {
  // ExcelJS owns its destination's finish event; process.stdout itself is not an endable file stream.
  const body = new PassThrough();
  body.pipe(process.stdout, {end: false});
  const headers = (values: Record<string, string>) => { send({headers: values}); };
  try {
    await assertReloadReady({kind: 'all'});
    if (job.kind === 'compensation-preview' || job.kind === 'compensation-xlsx') {
      const report = await getMarketingCompensationReport(compensationQuerySchema.parse(job.query));
      if (job.kind === 'compensation-xlsx') {
        headers({'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="marketing-compensations_${report.from}_${report.to}_${report.calculationMode}.xlsx"`});
        await writeMarketingCompensationWorkbook(report, body);
      } else {
        const json = stringifyJson(report);
        headers({'Content-Type': 'application/json; charset=utf-8'});
        body.end(json);
      }
    } else {
      await deliverTurnover(job.kind, job.query, body, headers);
    }
    if (!body.writableEnded) body.end();
    await finished(body);
    await new Promise<void>((resolve, reject) => process.stdout.write('', err => err ? reject(err) : resolve()));
  } catch (cause) {
    body.destroy();
    const err = cause as Error & {statusCode?: number; code?: string};
    // Only public application errors cross IPC; native/SQL diagnostics must not become response bodies.
    const statusCode = err.statusCode ?? 500;
    if (statusCode === 500) console.error(cause);
    send({error: statusCode === 500 ? 'Не удалось сформировать отчёт.' : err.message, statusCode,
      ...(err.code === 'ANALYTICS_RELOAD_INCOMPLETE' ? {code: err.code} : {})});
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    console.info(JSON.stringify({event:'report_worker_exit', kind:job.kind, peakRssBytes:process.resourceUsage().maxRSS * 1024}));
    process.off('disconnect', parentLost);
    if (process.connected) process.disconnect();
  }
});
