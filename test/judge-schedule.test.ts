import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { JudgeSchedule } from '../src/judge-schedule.ts';
import { readHistory } from '../src/history.ts';
import { prepareSelection, type SelectionPlan } from '../src/selection.ts';
import { providerText } from '../src/provider-view.ts';
import { appendExchange, result } from './history-fixture.ts';
import { createPiFixture } from './pi-fixture.ts';

async function fixture() {
  const f = await createPiFixture();
  const manager = SessionManager.inMemory();
  const [id] = appendExchange(manager, [result('old', 'Useful API contract. '.repeat(100))]);
  appendExchange(manager, [result('latest', 'Protected')]);
  const messages = manager.buildSessionContext().messages;
  const history = readHistory(manager.getBranch(), messages);
  const payload = { messages: messages.filter((m) => m.role === 'toolResult').map((m) =>
    ({ role: 'tool', tool_call_id: m.toolCallId, content: providerText(m) })), max_tokens: 100 };
  const plan = prepareSelection(payload, messages, history, f.model, { contextLimit: 1000, marginTokens: 0 }, []);
  assert.equal(plan.candidates.length, 1);
  plan.before.fits = true;
  plan.workingBefore = { method: 'provider-usage-plus-delta-v1', inputEstimate: 2000, contextLimit: 1000,
    outputReserve: 100, marginTokens: 0, fits: false, anchorRequestId: 'a' };
  await f.close();
  return { plan, id: id! };
}

function at(plan: SelectionPlan, input: number | null): SelectionPlan {
  return { ...plan, workingBefore: { ...plan.workingBefore, method: 'provider-usage-plus-delta-v1', inputEstimate: input,
    fits: input === null ? null : false, anchorRequestId: 'next' } };
}

test('keeps wait for quarter-target growth measured from the judgment, not skipped turns', async () => {
  const { plan, id } = await fixture(), schedule = new JudgeSchedule();
  assert.equal(schedule.select(plan, 'context').candidates.length, 1);
  schedule.record(plan, 'context', { [id]: 0.7 }, 0.2);
  for (const input of [2001, 2100, 2249]) {
    const next = at(plan, input);
    assert.deepEqual(schedule.select(next, 'context').skippedIds, [id]);
    schedule.record(next, 'context', {}, 0.2);
  }
  assert.equal(schedule.select(at(plan, 2250), 'context').candidates.length, 1);
  // No successful record after that attempt. The old keep cannot reappear.
  assert.equal(schedule.select(plan, 'context').candidates.length, 1);
});

test('new, archived, changed, unknown and hard-pressure evidence always gets a fresh judgment', async () => {
  const { plan, id } = await fixture();
  const cases: Array<[SelectionPlan, string]> = [
    [{ ...plan, candidates: plan.candidates.map((c) => ({ ...c, archived: true })) }, 'context'],
    [{ ...plan, candidates: plan.candidates.map((c) => ({ ...c, text: 'Changed' })) }, 'context'],
    [{ ...plan, candidates: plan.candidates.map((c) => ({ ...c, evidence: { ...c.evidence, id: 'new' } })) }, 'context'],
    [plan, 'changed-brief-or-config'],
    [at(plan, null), 'context'],
    [{ ...plan, workingBefore: { ...plan.workingBefore, contextLimit: 2000 } }, 'context'],
    [{ ...plan, before: { ...plan.before, fits: false } }, 'context'],
  ];
  for (const [next, context] of cases) {
    const schedule = new JudgeSchedule();
    schedule.record(plan, 'context', { [id]: 0.7 }, 0.2);
    assert.deepEqual(schedule.select(next, context).skippedIds, []);
    assert.equal(schedule.select(next, context).candidates.length, 1);
  }
});

test('low, missing, invalid and archived scores cannot seed keeps; clear and reopen force fresh judgments', async () => {
  const { plan, id } = await fixture();
  for (const scores of [{}, { [id]: 0.19 }, { [id]: NaN }, { [id]: 1.1 }]) {
    const schedule = new JudgeSchedule();
    schedule.record(plan, 'context', scores, 0.2);
    assert.equal(schedule.select(plan, 'context').candidates.length, 1);
  }
  const schedule = new JudgeSchedule();
  schedule.record({ ...plan, candidates: plan.candidates.map((c) => ({ ...c, archived: true })) }, 'context', { [id]: 0.9 }, 0.2);
  assert.equal(schedule.select(plan, 'context').candidates.length, 1);
  schedule.record(plan, 'context', { [id]: 0.2 }, 0.2);
  assert.deepEqual(schedule.select(plan, 'context').skippedIds, [id]);
  schedule.clear();
  assert.equal(schedule.select(plan, 'context').candidates.length, 1);
  assert.equal(new JudgeSchedule().select(plan, 'context').candidates.length, 1);
});
