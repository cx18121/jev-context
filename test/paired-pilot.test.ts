import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pilotPlan, runPilot, PILOT } from '../eval/pilot.ts';
import type { PilotFixture } from '../eval/fixtures.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';

const source = { head: 'test-only', dirty: true };

test('paired protocol freezes six task transitions with identical candidate questions and balanced positions', () => {
  const plan = pilotPlan('paired-v1');
  assert.equal(plan.fixtures.length, 12);
  assert.equal(plan.maxCalls, 24);
  assert.equal(plan.reservedUsd, 0.064512);
  assert.equal(plan.allowanceUsd, 0.1);
  let changed = 0, stable = 0, positiveFirst = 0, positiveSecond = 0;
  for (let i = 0; i < plan.fixtures.length; i += 2) {
    const before: PilotFixture = plan.fixtures[i]!;
    const after: PilotFixture = plan.fixtures[i + 1]!;
    assert.deepEqual(before.pair, { id: after.pair!.id, variant: 'before' });
    assert.equal(after.pair!.variant, 'after');
    assert.deepEqual(before.request.questions, after.request.questions);
    assert.notDeepEqual(before.request.state, after.request.state);
    for (const id of Object.keys(before.expectations)) {
      if (before.expectations[id]!.relevant === after.expectations[id]!.relevant) stable++; else changed++;
    }
    for (const fixture of [before, after]) {
      const labels = Object.values(fixture.expectations);
      if (labels.filter((label) => label.relevant).length === 1) {
        if (labels[0]!.relevant) positiveFirst++; else positiveSecond++;
      }
      const body = JSON.stringify(fixture.request);
      assert.doesNotMatch(body, /"expectations"|"relevant"|"reason"|"variant"/);
      for (const expected of labels) assert.ok(!body.includes(expected.reason));
    }
  }
  assert.deepEqual({ changed, stable, positiveFirst, positiveSecond }, { changed: 8, stable: 4, positiveFirst: 5, positiveSecond: 5 });
  assert.equal(plan.promptVersion, 'unfinished-task-v3');
  assert.deepEqual(pilotPlan().fixtures.map((fixture) => fixture.requestHash), [
    '84e6cf944f97d8760dab579e69018c50bcdb1563acda2166e689c7510f4f9796',
    '71f9a75280d033e964ca95e056332219083aba18347552bb333303043f72d856',
    '4c12b6cef746582db534d2b0e455da54949473457e3ea343a2de4dd7b6493eb1',
    'c1c2ff85d20e5cc6692f0d3ba8aa5922b3d51fc3d829506f7d2d58b858bee604',
    '674ae737ce1abc41d4869a383ba33543baa75d3daa634a71816d13cae8477597',
    'b1435ca2f1a370956137d52b15fb8ef7d487f5a989d1372cdecd26e7e7c637f7',
  ]);
});

test('paired CLI is dry unless explicitly live and rejects unknown or duplicate flags', () => {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'eval/cli.ts', ...args], { env, encoding: 'utf8' });
  const dry = cli(['--paired']);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.version, 'paired-v1');
  assert.equal(plan.maxCalls, 24);
  for (const args of [['--paired', '--paired'], ['--oops'], ['--live', '--live']]) {
    const result = cli(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  const live = cli(['--paired', '--live']);
  assert.equal(live.status, 1);
  assert.match(live.stderr, /No requests sent/);
});

test('paired campaign accounts for both-positive states, direction changes and stable controls', async () => {
  const server = await createJevFixture();
  const parent = mkdtempSync(join(tmpdir(), 'jev-paired-'));
  const directory = join(parent, 'paired-v1');
  const config = { ...server.config, timeoutMs: PILOT.timeoutMs };
  try {
    server.respond((request) => {
      const manifest: ReturnType<typeof pilotPlan> = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
      const fixture = manifest.fixtures.find((item) => JSON.stringify(item.request) === JSON.stringify(request))!;
      assert.ok(fixture);
      const response = jevResponse(request);
      for (const id of Object.keys(request.questions)) response.answers[id]!.noul = fixture.expectations[id]!.relevant ? 0.9 : 0.1;
      return { body: response };
    });
    const report = await runPilot(directory, config, new AbortController().signal, source, 'paired-v1');
    assert.equal(server.requests.length, 24);
    assert.deepEqual(server.requests.slice(0, 12), server.requests.slice(12));
    assert.equal(report.plannedCalls, 24);
    assert.equal(report.validCalls, 24);
    assert.equal(report.stopReason, null);
    assert.equal(report.pairWins, 20);
    assert.equal(report.pairsCompared, 20);
    assert.equal(report.rankingNotApplicable, 4);
    assert.deepEqual(report.cutoffs[1], { cutoff: 0.2, relevant: 28, irrelevant: 20, harmfulOmissions: 0, irrelevantRetentions: 0 });
    assert.equal(report.stateChanges.length, 12);
    assert.ok(report.stateChanges.every((pair) => pair.complete));
    const observations = report.stateChanges.flatMap((pair) => pair.observations);
    assert.equal(observations.filter((item) => item.directionMatched === true).length, 16);
    assert.equal(observations.filter((item) => item.expectedChange === 'stable' && item.directionMatched === null && item.delta === 0).length, 8);
    assert.equal(report.unknownCostCalls, 0);
    const journal = readFileSync(join(directory, 'attempts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(journal.filter((entry) => entry.type === 'start').length, 24);
    assert.equal(journal.filter((entry) => entry.type === 'result').length, 24);
    await assert.rejects(runPilot(directory, config, new AbortController().signal, source, 'paired-v1'), /EEXIST/);
    assert.equal(server.requests.length, 24);
  } finally { await server.close(); rmSync(parent, { recursive: true, force: true }); }
});

test('a missing paired state has unknown change, not zero change or a successful direction', async () => {
  const server = await createJevFixture();
  const parent = mkdtempSync(join(tmpdir(), 'jev-paired-failure-'));
  try {
    server.respond((request) => server.requests.length === 1 ? { body: jevResponse(request) } : { status: 529, body: {} });
    const report = await runPilot(join(parent, 'paired-v1'), { ...server.config, timeoutMs: PILOT.timeoutMs }, new AbortController().signal, source, 'paired-v1');
    assert.equal(report.plannedCalls, 24);
    assert.equal(report.completedCalls, 2);
    assert.equal(report.validCalls, 1);
    assert.equal(report.stopReason, 'http_error');
    assert.equal(report.totalEstimatedCostUsd, null);
    assert.ok(report.stateChanges.every((pair) => !pair.complete));
    assert.ok(report.stateChanges.flatMap((pair) => pair.observations).every((item) => item.delta === null && item.directionMatched === null && item.afterScore === null));
    assert.equal(report.stateChanges[0]!.observations[0]!.beforeScore, 0.1);
    assert.equal(server.requests.length, 2);
  } finally { await server.close(); rmSync(parent, { recursive: true, force: true }); }
});
