import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pilotFixtures } from '../eval/fixtures.ts';
import { pilotPlan, runPilot, PILOT, reservedUsd } from '../eval/pilot.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';

const source = { head: 'test-only', dirty: true };
function output() {
  const parent = mkdtempSync(join(tmpdir(), 'jev-pilot-'));
  return { directory: join(parent, 'campaign'), clean: () => rmSync(parent, { recursive: true, force: true }) };
}

test('six fixed fixtures cover exactly their authored candidates without leaking expected answers', () => {
  const plan = pilotPlan();
  assert.equal(plan.fixtures.length, 6);
  assert.equal(plan.maxCalls, 12);
  assert.equal(reservedUsd, 0.032256);
  assert.deepEqual(pilotFixtures(), plan.fixtures);
  for (const fixture of plan.fixtures) {
    const body = JSON.stringify(fixture.request);
    assert.equal(Object.keys(fixture.request.questions).length, 2);
    assert.deepEqual(Object.keys(fixture.request.questions), Object.keys(fixture.expectations));
    assert.equal(Object.values(fixture.expectations).filter((expected) => expected.relevant).length, 1);
    assert.equal(createHash('sha256').update(body).digest('hex'), fixture.requestHash);
    for (const expected of Object.values(fixture.expectations)) assert.ok(!body.includes(expected.reason));
    assert.doesNotMatch(body, /"expectations"|"relevant"|"reason"/);
  }
});

test('dry CLI needs no credentials or network and live CLI rejects a missing key before requests', () => {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const dry = spawnSync(process.execPath, ['--import', 'tsx', 'eval/cli.ts'], { env, encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).mode, 'dry-run');
  const live = spawnSync(process.execPath, ['--import', 'tsx', 'eval/cli.ts', '--live'], { env, encoding: 'utf8' });
  assert.equal(live.status, 1);
  assert.match(live.stderr, /No requests sent/);
});

test('campaign freezes requests before sending, repeats identical bodies, and refuses any rerun', async () => {
  const fixture = await createJevFixture();
  const out = output();
  const config = { ...fixture.config, timeoutMs: PILOT.timeoutMs };
  try {
    fixture.respond((request) => {
      const manifest = JSON.parse(readFileSync(join(out.directory, 'manifest.json'), 'utf8'));
      const expectedFixture = manifest.fixtures.find((item: { request: unknown }) => JSON.stringify(item.request) === JSON.stringify(request));
      assert.ok(expectedFixture);
      const response = jevResponse(request);
      for (const id of Object.keys(request.questions)) response.answers[id]!.noul = expectedFixture.expectations[id].relevant ? 0.9 : 0.1;
      return { body: response };
    });
    const report = await runPilot(out.directory, config, new AbortController().signal, source);
    assert.equal(fixture.requests.length, 12);
    assert.deepEqual(fixture.requests.slice(0, 6), fixture.requests.slice(6));
    assert.equal(report.stopReason, null);
    assert.equal(report.pairWins, 12);
    assert.equal(report.unknownCostCalls, 0);
    assert.ok(Math.abs(report.totalEstimatedCostUsd! - 0.000504) < 1e-12);
    assert.deepEqual(report.cutoffs.find((row) => row.cutoff === 0.2), { cutoff: 0.2, relevant: 12, irrelevant: 12, harmfulOmissions: 0, irrelevantRetentions: 0 });
    assert.equal(report.cutoffs[0]!.irrelevantRetentions, 12); // strict <, not <=
    assert.ok(report.repeatDifferences.every((item) => Object.values(item.absoluteScoreDifferences!).every((value) => value === 0)));
    const manifest = readFileSync(join(out.directory, 'manifest.json'), 'utf8');
    const journal = readFileSync(join(out.directory, 'attempts.jsonl'), 'utf8');
    assert.equal(journal.trim().split('\n').length, 24);
    assert.ok(!manifest.includes(config.apiKey) && !journal.includes(config.apiKey));
    assert.equal(statSync(join(out.directory, 'manifest.json')).mode & 0o777, 0o600);
    await assert.rejects(runPilot(out.directory, config, new AbortController().signal, source), /EEXIST/);
    assert.equal(fixture.requests.length, 12);
    assert.equal(readFileSync(join(out.directory, 'manifest.json'), 'utf8'), manifest);
  } finally { await fixture.close(); out.clean(); }
});

test('service failure stops the campaign without retry and does not zero unknown incurred cost', async () => {
  const fixture = await createJevFixture();
  const out = output();
  try {
    fixture.respond((request) => fixture.requests.length === 1 ? { body: jevResponse(request) } : { status: 529, body: {} });
    const report = await runPilot(out.directory, { ...fixture.config, timeoutMs: PILOT.timeoutMs }, new AbortController().signal, source);
    assert.equal(report.completedCalls, 2);
    assert.equal(report.validCalls, 1);
    assert.equal(report.stopReason, 'http_error');
    assert.equal(report.totalEstimatedCostUsd, null);
    assert.equal(report.unknownCostCalls, 1);
    assert.equal(report.knownCostSubtotalUsd, 0.000042);
    assert.equal(report.cutoffs[1]!.harmfulOmissions, 1); // Judge fixture returns 0.1 for both.
    assert.equal(report.cutoffs[1]!.relevant, 1); // Failed judgments aren't added to the denominator.
    assert.ok(report.repeatDifferences.every((item) => item.absoluteScoreDifferences === null));
    assert.equal(fixture.requests.length, 2);
  } finally { await fixture.close(); out.clean(); }
});

test('reported usage beyond the per-call reservation stops further spending', async () => {
  const fixture = await createJevFixture();
  const out = output();
  try {
    fixture.respond((request) => ({ body: { ...jevResponse(request), usage: { input_tokens: 64_001, output_tokens: 1 } } }));
    const report = await runPilot(out.directory, { ...fixture.config, timeoutMs: PILOT.timeoutMs }, new AbortController().signal, source);
    assert.equal(report.stopReason, 'usage_exceeded_reservation');
    assert.equal(fixture.requests.length, 1);
  } finally { await fixture.close(); out.clean(); }
});

test('cancellation records the in-flight result and never starts the next request', async () => {
  const fixture = await createJevFixture();
  const out = output();
  const controller = new AbortController();
  try {
    fixture.respond(async () => { controller.abort(); return { body: {} }; });
    const report = await runPilot(out.directory, { ...fixture.config, timeoutMs: PILOT.timeoutMs }, controller.signal, source);
    assert.equal(report.stopReason, 'cancelled');
    assert.equal(fixture.requests.length, 1);
    const entries = readFileSync(join(out.directory, 'attempts.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(entries.map((entry) => entry.type), ['start', 'result']);
    assert.equal(entries[1].result.outcome, 'cancelled');
  } finally { await fixture.close(); out.clean(); }
});
