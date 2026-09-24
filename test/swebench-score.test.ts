import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreCaptures } from '../eval/swebench/score.ts';

const source = { root: '/testbed', cwd: '/testbed', revision: 'base', files: { 'a.py': 'one\ntwo\n' } };
const reference = { instanceId: 'repo__repo-1', baseCommit: 'base', contextbenchId: 'context', datasetRevision: 'revision', spans: [{ file: 'a.py', start: 1, end: 2 }] };

test('scoring missing base annotations remains unknown rather than shrinking the denominator', () => {
  const report = scoreCaptures([], source, { ...reference, spans: [...reference.spans, { file: 'excluded.py', start: 1, end: 3 }] });
  assert.equal(report.coverageStatus, 'reference-source-unavailable');
  assert.deepEqual(report.unavailable, [{ file: 'excluded.py', start: 1, end: 3 }]);
  assert.equal(report.status, 'no-captures');
});

test('scoring rejects a foreign revision or malformed reference', () => {
  assert.throws(() => scoreCaptures([], source, { ...reference, baseCommit: 'different' }));
  assert.throws(() => scoreCaptures([], source, { ...reference, spans: [{ file: 'a.py', start: 0, end: 2 }] }));
  assert.equal(scoreCaptures([], source, reference).coverageStatus, 'scored-lower-bound');
});
