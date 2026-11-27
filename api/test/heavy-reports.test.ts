import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
// Config is evaluated at import time. The lifecycle fixture uses no database.
Object.assign(process.env, {DATABASE_URL:'postgresql://unused@127.0.0.1:1/unused',
  APP_ADMIN_EMAIL:'admin@test.invalid', APP_ADMIN_PASSWORD:'offline-test',
  APP_MARKETING_EMAIL:'marketing@test.invalid', APP_MARKETING_PASSWORD:'offline-marketing-test',
  JWT_SECRET:'offline-secret-for-report-lifecycle'});
const {createHeavyReportSender} = await import('../src/lib/heavy-reports.js');

// HTTP client cancellation must also stop CPU-bound work, not just hide its result.
test('one worker runs, one waits; disconnect and successful completion both reap the worker', async () => {
  let pressure = false;
  const send = createHeavyReportSender(new URL('./fixtures/heavy-report-worker.mjs', import.meta.url), async () => {}, () => {
    if (pressure) throw Object.assign(new Error('report memory budget'), {statusCode:503});
  });
  const app = express();
  app.get('/:mode', (req, res, next) => { void send(res, {kind: 'turnover-preview', query: {mode: req.params.mode}}).catch(next); });
  app.use((error: Error & {statusCode?: number}, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({error: error.message});
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;
  const ctrl = new AbortController();
  try {
    const running = await fetch(base + '/hold', {signal: ctrl.signal});
    const reader = running.body!.getReader();
    const {value} = await reader.read();
    const firstPid = Number(new TextDecoder().decode(value).trim()); assert.ok(firstPid > 0);
    // Order arrivals deterministically: sending headers starts only after admission.
    const abandoned = new AbortController();
    let arrived = once(server, 'request');
    const left = fetch(base + '/normal', {signal: abandoned.signal});
    const [, waitingResponse] = await arrived;
    const disconnected = once(waitingResponse, 'close');
    assert.equal((await fetch(base + '/normal')).status, 503);
    abandoned.abort();
    await assert.rejects(left, {name:'AbortError'});
    await disconnected;
    // The waiting client must not consume a slot or start a report after leaving.
    arrived = once(server, 'request'); const waiting = fetch(base + '/normal'); await arrived;
    const overflow = await fetch(base + '/normal'); assert.equal(overflow.status, 503);
    assert.equal(overflow.headers.get('retry-after'), '5');
    ctrl.abort();
    const result = await waiting; assert.equal(result.status, 200);
    const nextPid = Number((await result.text()).trim()); assert.ok(nextPid > 0 && nextPid !== firstPid);
    for (const pid of [firstPid, nextPid]) assert.throws(() => process.kill(pid, 0), {code:'ESRCH'});
    const failed = await fetch(base + '/error'); assert.equal(failed.status, 409);
    assert.deepEqual(await failed.json(), {error:'changed generation'});
    const limited = await fetch(base + '/hold');
    const stream = limited.body!.getReader();
    const heldPid = Number(new TextDecoder().decode((await stream.read()).value).trim());
    assert.ok(heldPid > 0);
    pressure = true;
    await assert.rejects(stream.read());
    assert.throws(() => process.kill(heldPid, 0), {code:'ESRCH'});
    const denied = await fetch(base + '/normal'); assert.equal(denied.status, 503);
    pressure = false;
    assert.equal((await fetch(base + '/normal')).status, 200);
  } finally { ctrl.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
