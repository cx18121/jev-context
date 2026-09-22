import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRetrieval, prepareRetrievalFixture, retrievalReport } from '../eval/retrieval.ts';
import { retrievalScenarios } from '../eval/retrieval-fixtures.ts';

function scenario(id: string) { return retrievalScenarios().find((item) => item.id === id)!; }

test('diagnostics preserve deliberate lexical and shortlist failures rather than counting them as success', () => {
  const report = retrievalReport();
  assert.equal(report.cases.length, 11);
  const byId = new Map(report.cases.map((item) => [item.id, item]));
  for (const id of ['return-to-old-task', 'unfinished-task-during-detour', 'metadata-only', 'buried-rule',
    'archive-size-8', 'archive-size-64', 'archive-size-256']) assert.equal(byId.get(id)!.recall, 1, id);
  assert.deepEqual(byId.get('semantic-gap')!.missed, [{ id: 'rule', cause: 'no-lexical-match' }]);
  assert.deepEqual(byId.get('correction-crowding')!.missed, [{ id: 'current', cause: 'shortlist-cutoff' }]);
  assert.deepEqual(byId.get('correction-crowding')!.irrelevantSelected, ['obsolete']);
  assert.deepEqual(byId.get('shared-path-noise')!.missed, [{ id: 'rule', cause: 'shortlist-cutoff' }]);
  assert.deepEqual(byId.get('shared-path-noise')!.irrelevantSelected, ['palette']);
  assert.equal(byId.get('shortlist-crowding')!.recall, 0.5);
  assert.deepEqual(byId.get('shortlist-crowding')!.missed, [{ id: 'tests', cause: 'shortlist-cutoff' }]);
  for (const item of report.cases) {
    assert.ok(item.candidates.length <= item.limit);
    assert.equal(item.found.length + item.missed.length, item.fullArchiveRelevant.length);
  }
  assert.deepEqual(retrievalReport(), report);
});

test('labels and rationale do not change the retrieval inputs or ranking', () => {
  const original = scenario('metadata-only');
  const relabeled = { ...original, relevant: ['palette'], reason: 'Alternative authored label, not retrieval evidence.' };
  assert.deepEqual(prepareRetrievalFixture(relabeled), prepareRetrievalFixture(original));
  assert.deepEqual(evaluateRetrieval(relabeled).candidates, evaluateRetrieval(original).candidates);
  assert.equal(evaluateRetrieval(relabeled).recall, 0);
});

test('archive-size cases scan the full pool while returning at most the requested shortlist', () => {
  for (const size of [8, 64, 256]) {
    const report = evaluateRetrieval(scenario(`archive-size-${size}`));
    assert.equal(report.poolSize, size);
    assert.equal(report.matchedCount, 1);
    assert.deepEqual(report.found, ['contract']);
  }
});

test('invalid authored labels fail and an empty relevance set has no recall denominator', () => {
  const original = scenario('metadata-only');
  assert.throws(() => evaluateRetrieval({ ...original, relevant: ['missing'] }), /unique members/);
  assert.throws(() => evaluateRetrieval({ ...original, relevant: ['contract', 'contract'] }), /unique members/);
  assert.throws(() => evaluateRetrieval({ ...original, observations: [original.observations[0]!, original.observations[0]!] }), /Duplicate/);
  assert.equal(evaluateRetrieval({ ...original, relevant: [] }).recall, null);
  assert.throws(() => prepareRetrievalFixture({ ...original, users: [] }), /user task/);
});
