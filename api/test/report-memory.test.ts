import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReportMemory } from '../src/lib/report-memory.js';

test('refuses unbounded deployments and distinguishes admission reserve from in-flight usage', t => {
  const path = mkdtempSync(join(tmpdir(), 'naliv-cgroup-'));
  t.after(() => rmSync(path, {recursive:true, force:true}));
  const max = join(path,'memory.max'), now = join(path,'memory.current');
  writeFileSync(now,'620000000\n');
  for (const limit of ['max','1000000001','']) {
    writeFileSync(max, limit); assert.throws(() => checkReportMemory(0,path), {statusCode:503});
  }
  writeFileSync(max,'996147200\n');
  assert.throws(() => checkReportMemory(100000000,path), {statusCode:503});
  checkReportMemory(0,path);
  writeFileSync(now,'700000000'); assert.throws(() => checkReportMemory(0,path), {statusCode:503});
  writeFileSync(max,'400000000'); writeFileSync(now,'340000000');
  assert.throws(() => checkReportMemory(0,path), {statusCode:503});
});
