import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSmoke, type SmokeMode } from '../eval/harbor/driver.ts';

for (const mode of ['correct', 'wrong', 'budget-stop', 'http-error'] as SmokeMode[]) {
  test(`Harbor frontend exports labeled evidence for ${mode}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'jev-harbor-'));
    const workspace = join(directory, 'workspace'), artifacts = join(directory, 'artifacts');
    mkdirSync(join(workspace, 'logs'), { recursive: true });
    writeFileSync(join(workspace, 'logs/2025-08-12_app.log'), '[INFO] Fine\n[WARNING] Next failure will ERROR\n[ERROR] Failed\n');
    writeFileSync(join(workspace, 'logs/2025-08-01_app.log'), '[ERROR] Earlier\n');
    try {
      const run = runSmoke({ workspace, artifacts, mode, instruction: 'Write summary.csv from logs. Reference date 2025-08-12.' });
      if (mode === 'budget-stop' || mode === 'http-error') await assert.rejects(run, /Pi smoke did not finish/);
      else await run;
      const usage = JSON.parse(readFileSync(join(artifacts, 'usage.json'), 'utf8'));
      assert.equal(usage.measurementKind, 'scripted-fixture');
      assert.equal(usage.version, 2);
      assert.equal(usage.lifecycle, 'working-set-v1');
      assert.equal(usage.sketchCalls, 0);
      assert.equal(usage.actualModelCostUsd, 0);
      assert.equal(usage.piVersion, '0.87.1');
      assert.equal(usage.modelCalls, mode === 'budget-stop' ? 0 : mode === 'http-error' ? 1 : 2);
      const requests = readFileSync(join(artifacts, 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(requests.length, usage.modelCalls);
      const native = readdirSync(join(artifacts, 'sessions')).filter((name) => name.endsWith('.jsonl'));
      assert.equal(native.length, 1);
      const entries = readFileSync(join(artifacts, 'sessions', native[0]!), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(entries.some((entry) => entry.customType === 'jev-context/usage'));
      if (mode === 'correct' || mode === 'wrong') {
        assert.equal(usage.failure, null);
        assert.equal(usage.records.length, 2);
        assert.ok(usage.records.every((record: { policy: string; capacity: { admitted: boolean } }) =>
          record.policy === 'working-set-v1' && record.capacity.admitted));
        const csv = readFileSync(join(workspace, 'summary.csv'), 'utf8');
        if (mode === 'wrong') assert.equal(csv, 'period,severity,count\n');
        else {
          assert.match(csv, /today,ERROR,1/);
          assert.match(csv, /month_to_date,ERROR,2/);
          assert.match(csv, /total,WARNING,1/);
          assert.equal(csv.trim().split('\n').length, 16);
        }
      } else {
        assert.ok(usage.failure);
        if (mode === 'budget-stop') {
          const stop = entries.find((entry) => entry.customType === 'jev-context/stop');
          assert.equal(stop.data.kind, 'capacity-stop');
          assert.equal(stop.data.capacity.tokenFits, false);
        }
      }
      assert.ok(readFileSync(join(artifacts, 'events.jsonl'), 'utf8').includes('agent_end'));
      await assert.rejects(runSmoke({ workspace, artifacts, mode, instruction: 'Do not rerun' }), /EEXIST/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
