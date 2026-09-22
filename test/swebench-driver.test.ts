import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKER, READ_FILE, runNativeSmoke } from '../eval/swebench/driver.ts';
import { runScriptedPi } from '../eval/scripted-pi.ts';
import { analyzeCaptures, type RequestCapture, type SourceSnapshot } from '../eval/contextbench.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'jev-native-'));
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts');
  mkdirSync(join(workspace, 'sympy'), { recursive: true });
  const source = Array.from({ length: 60 }, (_, i) => `# source line ${i + 1}`).join('\n') + '\n';
  writeFileSync(join(workspace, READ_FILE), source);
  return { root, workspace, artifacts, source };
}

test('native smoke captures actual read evidence before its harmless edit and preserves native artifacts', async () => {
  const f = fixture();
  try {
    await runNativeSmoke({ ...f, instruction: 'Synthetic task, no benchmark gold.', revision: 'base-fixture' });
    const captures = readFileSync(join(f.artifacts, 'captures.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as RequestCapture);
    const source = JSON.parse(readFileSync(join(f.artifacts, 'source.json'), 'utf8')) as SourceSnapshot;
    assert.equal(source.files[READ_FILE], f.source);
    assert.equal(captures.length, 3);
    assert.deepEqual(captures[0]!.evidence, []);
    const report = analyzeCaptures(captures, source, []);
    assert.deepEqual(report.requests[1]!.visibleSpans, [{ file: READ_FILE, start: 1, end: 40 }]);
    assert.deepEqual(report.requests[2]!.visibleSpans, report.requests[1]!.visibleSpans);
    assert.equal(report.requests[2]!.visible.unmappedObservations, 1); // Bash is deliberately not source-mapped.
    assert.equal(readFileSync(join(f.workspace, READ_FILE), 'utf8'), f.source + `\n${MARKER}\n`);
    const usage = JSON.parse(readFileSync(join(f.artifacts, 'usage.json'), 'utf8'));
    assert.equal(usage.failure, null);
    assert.equal(usage.modelCalls, 3);
    assert.equal(usage.actualModelCostUsd, 0);
    assert.equal(readdirSync(join(f.artifacts, 'sessions')).length, 1);
    await assert.rejects(runNativeSmoke({ ...f, instruction: 'Again', revision: 'base-fixture' }), /EEXIST/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('capture errors fail the run and leave usage and transport artifacts', async () => {
  const f = fixture();
  try {
    await assert.rejects(runScriptedPi({ ...f, instruction: 'Synthetic task', mode: 'test', toolTurns: [],
      source: { root: 'not-absolute', cwd: f.workspace, revision: 'bad', files: {} },
    }), /did not finish successfully/);
    const usage = JSON.parse(readFileSync(join(f.artifacts, 'usage.json'), 'utf8'));
    assert.equal(usage.modelCalls, 1);
    assert.match(usage.extensionErrors[0], /Capture failed/);
    assert.ok(usage.failure);
    assert.ok(readFileSync(join(f.artifacts, 'requests.jsonl'), 'utf8'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
