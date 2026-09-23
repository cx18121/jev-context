import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { analyzeCaptures, captureRequest, exportDiscovery, mergeSpans, type RequestCapture, type SourceSnapshot } from '../eval/contextbench.ts';
import { contextFixture, contextbenchDiagnostic, fixtureModel, fixtureSource } from '../eval/contextbench-fixture.ts';
import { createContextExtension, STOP_ENTRY } from '../src/extension.ts';
import { createPiFixture } from './pi-fixture.ts';

const reference = [{ file: 'answer.ts', start: 1, end: 1 }];

test('diagnostic separates cumulative discovery from retirement and restoration', () => {
  const { report, discoveryExport } = contextbenchDiagnostic();
  assert.deepEqual(report.requests.map((row) => row.discovered.mappedCoverage), [0, 1, 1, 1, 1]);
  assert.deepEqual(report.requests.map((row) => row.visible.mappedCoverage), [0, 1, 1, 0, 1]);
  assert.equal(report.requests[0]!.retiredIds, null);
  assert.equal(report.requests[3]!.retiredIds?.length, 1);
  assert.deepEqual(report.requests[4]!.restoredIds, report.requests[3]!.retiredIds);
  assert.deepEqual(report.requests[4]!.newSpans, []);
  assert.equal(report.taskGrade, 'not-run');
  assert.equal(discoveryExport.traj_data.pred_steps.length, 5);
  assert.deepEqual(discoveryExport.traj_data.pred_steps[1]!.spans, { 'answer.ts': [{ type: 'line', start: 1, end: 1 }] });
  assert.ok(!('pred_files' in discoveryExport.traj_data));
  assert.ok(!('model_patch' in discoveryExport));
});

test('range reads match Pi footers exactly, clamp trailing pseudo-lines, and merge duplicate coverage', () => {
  const source = { ...fixtureSource, files: { 'answer.ts': 'one\ntwo\nthree\n' } };
  const fixture = contextFixture(source);
  fixture.read('answer.ts', 'two\n\n[2 more lines in file. Use offset=3 to continue.]', { offset: 2, limit: 1 });
  fixture.read('/fixture/repo/answer.ts', 'two\nthree\n', { offset: 2 });
  fixture.read('answer.ts', 'two\nthree\n', { offset: 2 });
  const capture = fixture.capture();
  assert.deepEqual(capture.evidence.map((item) => item.mapping.span), [
    { file: 'answer.ts', start: 2, end: 2 }, { file: 'answer.ts', start: 2, end: 3 }, { file: 'answer.ts', start: 2, end: 3 },
  ]);
  const report = analyzeCaptures([capture], source, [{ file: 'answer.ts', start: 2, end: 3 }, { file: 'answer.ts', start: 2, end: 2 }]);
  assert.deepEqual(report.requests[0]!.discovered, { matchedLines: 2, referenceLines: 2, mappedCoverage: 1, unmappedObservations: 0 });
  assert.deepEqual(mergeSpans([{ file: 'a', start: 1, end: 1 }, { file: 'a', start: 2, end: 2 }]), [{ file: 'a', start: 1, end: 2 }]);
});

test('unmappable observations retain explicit reasons and cannot masquerade as full coverage', () => {
  const source = { ...fixtureSource, files: { ...fixtureSource.files, 'empty': '', 'huge': 'x'.repeat(60_000) } };
  const fixture = contextFixture(source);
  fixture.read('answer.ts', 'changed code');
  fixture.read('answer.ts', 'failed', {}, 'read', true);
  fixture.read('../answer.ts', fixtureSource.files['answer.ts']!);
  fixture.read('absent', 'unknown');
  fixture.read('answer.ts', 'shell result', {}, 'bash');
  fixture.read('answer.ts', 'invalid', { offset: 1.5 });
  fixture.read('answer.ts', 'invalid', { offset: 50 });
  fixture.read('empty', '');
  fixture.read('huge', 'truncated');
  const capture = fixture.capture();
  assert.deepEqual(capture.evidence.map((item) => item.mapping.reason), [
    'base-source-mismatch', 'tool-error', 'outside-source-root', 'source-unavailable', 'unsupported-tool',
    'invalid-read-arguments', 'range-outside-base-source', 'no-source-lines', 'truncated-read',
  ]);
  const report = analyzeCaptures([capture], source, reference);
  assert.equal(report.requests[0]!.visible.unmappedObservations, 9);
  assert.equal(report.requests[0]!.visible.mappedCoverage, 0);
  assert.equal(report.requests[0]!.unmapped.length, 9);
  assert.equal(analyzeCaptures([capture], source, []).requests[0]!.visible.mappedCoverage, null);
  assert.equal(analyzeCaptures([], source, reference).status, 'no-captures');
  assert.throws(() => exportDiscovery('fixture', analyzeCaptures([], source, [])), /needs an instance and captures/);
});

test('wire evidence must exactly match the selected view, including historical labels', () => {
  const fixture = contextFixture();
  const id = fixture.read('answer.ts', fixtureSource.files['answer.ts']!);
  fixture.read('other.ts', fixtureSource.files['other.ts']!);
  fixture.select([id]);
  fixture.select([]);
  const payload = fixture.payload();
  assert.match(payload.messages[0]!.content, /restored historical/);
  const input = { branch: fixture.branch, source: fixtureSource, payload, model: fixtureModel, sessionId: 'fixture', requestId: 'a' };
  assert.equal(captureRequest(input).evidence[0]!.mapping.span?.end, 1);
  payload.messages[0]!.content = fixtureSource.files['answer.ts']!;
  assert.throws(() => captureRequest(input), /differs from the selected view/);
  assert.throws(() => captureRequest({ ...input, payload: { ...payload, messages: [] } }), /unique provider tool result/);
  const extra = fixture.payload();
  extra.messages.push({ role: 'tool', tool_call_id: 'foreign', content: 'unknown' });
  assert.throws(() => captureRequest({ ...input, payload: extra }), /unaccounted/);
});

test('capture and analysis reject false provenance instead of joining unrelated trajectories', () => {
  const fixture = contextFixture();
  fixture.read('answer.ts', fixtureSource.files['answer.ts']!);
  const first = fixture.capture();
  fixture.read('other.ts', fixtureSource.files['other.ts']!);
  const second = fixture.capture();
  assert.throws(() => analyzeCaptures([first, first], fixtureSource, reference), /Duplicate/);
  assert.throws(() => analyzeCaptures([first, { ...second, sessionId: 'another' }], fixtureSource, reference), /switched/);
  assert.throws(() => analyzeCaptures([second, { ...first, requestId: 'third' }], fixtureSource, reference), /switched/);
  assert.throws(() => analyzeCaptures([first], { ...fixtureSource, revision: 'different' }, reference), /snapshot changed/);
  assert.throws(() => analyzeCaptures([first], fixtureSource, [{ file: 'answer.ts', start: 1, end: 2 }]), /outside base/);
  assert.throws(() => mergeSpans([{ file: 'a', start: 0, end: 1 }]), /Invalid/);
  assert.throws(() => captureRequest({ sessionId: 'a', requestId: 'b', branch: [...fixture.branch].reverse(), payload: fixture.payload(), model: fixtureModel, source: fixtureSource }), /ordered active branch/);
  for (const path of ['../outside', '..', '/absolute', 'a/../b']) {
    assert.throws(() => analyzeCaptures([], { ...fixtureSource, files: { [path]: 'x' } }, []), /repository-relative/);
  }
});

test('a budget stop is not a captured request or a scored zero', async () => {
  let received = 0;
  const fixture = await createPiFixture(() => { received++; });
  try {
    const { session, manager, errors } = await fixture.session((manager) => [createContextExtension(manager, {
      policy: 'scripted-v1', budget: { contextLimit: 1, marginTokens: 0 },
    })]);
    await session.prompt('Cannot dispatch within this budget.');
    assert.equal(received, 0);
    assert.equal(manager.getBranch().filter((entry) => entry.type === 'custom' && entry.customType === STOP_ENTRY).length, 1);
    assert.deepEqual(errors, []);
    const report = analyzeCaptures([], fixtureSource, reference);
    assert.equal(report.status, 'no-captures');
    assert.deepEqual(report.requests, []);
  } finally { await fixture.close(); }
});

test('real SDK transport captures reads, retirement and restoration without another execution or gold in the prompt', async () => {
  const captures: RequestCapture[] = [];
  const captureErrors: unknown[] = [];
  let manager: SessionManager;
  let source: SourceSnapshot;
  const fixture = await createPiFixture((payload) => {
    try {
      captures.push(captureRequest({ sessionId: 'sdk-fixture', requestId: `http-${captures.length}`, branch: manager.getBranch(), payload, model: fixture.model, source }));
    } catch (error) { captureErrors.push(error); }
  });
  try {
    const root = join(fixture.directory, 'repo');
    await mkdir(root);
    source = { ...fixtureSource, root, cwd: fixture.directory };
    for (const [file, text] of Object.entries(source.files)) await writeFile(join(root, file), text);
    manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    let selection: string[] | null = null;
    const { session, errors } = await fixture.session((manager) => [createContextExtension(manager, {
      policy: 'scripted-v1', budget: { contextLimit: 32768, marginTokens: 1024 }, select: () => selection,
    })], manager, ['read']);
    const executed: string[] = [];
    session.subscribe((event) => { if (event.type === 'tool_execution_start') executed.push(event.toolCallId); });
    fixture.respondWithTools([{ id: 'read_answer', name: 'read', arguments: { path: 'repo/answer.ts', offset: 1, limit: 1 } }]);
    await session.prompt('Read repo/answer.ts.');
    fixture.respondWithTools([{ id: 'read_other', name: 'read', arguments: { path: 'repo/other.ts' } }]);
    await session.prompt('Read repo/other.ts.');
    const original = manager.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'read_answer');
    assert.ok(original);
    const before = structuredClone(original);
    selection = [original.id];
    await session.prompt('Take a detour.');
    selection = [];
    await session.prompt('Return to the answer.');
    assert.deepEqual(captureErrors, []);
    assert.deepEqual(errors, []);
    assert.equal(captures.length, fixture.requests.length);
    assert.equal(captures.length, 6);
    assert.deepEqual(executed, ['read_answer', 'read_other']);
    assert.deepEqual(manager.getBranch().find((entry) => entry.id === original.id), before);
    const goldSentinel = 'evaluator-only-gold-annotation';
    const gold = { annotation: goldSentinel, spans: reference };
    const report = analyzeCaptures(captures, source, gold.spans);
    assert.deepEqual(report.requests.map((row) => row.visible.mappedCoverage), [0, 1, 1, 1, 0, 1]);
    assert.equal(report.requests.at(-1)!.discovered.matchedLines, 1);
    assert.deepEqual(report.requests.at(-1)!.restoredIds, [original.id]);
    assert.deepEqual(report.requests.at(-1)!.newEvidenceIds, []);
    assert.deepEqual(report.requests.at(-1)!.unmapped, []);
    assert.ok(!JSON.stringify(fixture.requests).includes(goldSentinel));
    assert.match(String(fixture.requests.at(-1)!.messages.find((message) => message.tool_call_id === 'read_answer')?.content), /restored historical observation/);
  } finally { await fixture.close(); }
});
