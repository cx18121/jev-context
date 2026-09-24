import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyzeCaptures, mergeSpans, type LineSpan, type RequestCapture, type SourceSnapshot } from '../contextbench.ts';

export interface Reference {
  instanceId: string;
  baseCommit: string;
  contextbenchId: string;
  datasetRevision: string;
  spans: LineSpan[];
}

/** Missing base files invalidate the reference denominator, not the recorded visibility. */
export function scoreCaptures(captures: RequestCapture[], source: SourceSnapshot, reference: Reference) {
  assert.equal(reference.baseCommit, source.revision);
  const spans = mergeSpans(reference.spans);
  const unavailable = spans.filter((span) => !Object.hasOwn(source.files, span.file)
    || span.end > source.files[span.file]!.split('\n').length - Number(source.files[span.file]!.endsWith('\n')));
  return {
    reference,
    coverageStatus: unavailable.length ? 'reference-source-unavailable' : spans.length ? 'scored-lower-bound' : 'empty-reference',
    unavailable,
    ...analyzeCaptures(captures, source, unavailable.length ? [] : spans),
  };
}

async function main(runPath: string, referencePath: string) {
  const run = pathToFileURL(resolve(runPath) + '/');
  const read = async (name: string) => JSON.parse(await readFile(new URL(name, run), 'utf8'));
  const referenceBytes = await readFile(referencePath);
  const reference: Reference = JSON.parse(referenceBytes.toString());
  const manifest = await read('manifest.json');
  assert.equal(reference.instanceId, manifest.instanceId);
  assert.equal(reference.baseCommit, manifest.base);
  assert.match(reference.datasetRevision, /^[a-f0-9]{40}$/);
  assert.ok(reference.contextbenchId);
  const { source, excluded } = await read('source.json');
  const trajectory = await read('report.json');
  assert.deepEqual(trajectory.arms.map((a: { phase: string }) => a.phase), ['control', 'selector']);
  const arms = [];
  for (const arm of trajectory.arms) {
    if (arm.skipped) { arms.push({ phase: arm.phase, status: 'skipped', reason: arm.skipped }); continue; }
    const captures: RequestCapture[] = await read(`${arm.phase}-captures.json`);
    const dispatched = arm.requests.filter((r: { dispatched: boolean }) => r.dispatched);
    assert.equal(captures.length, dispatched.length, 'Each dispatched request must have one capture');
    for (const [i, capture] of captures.entries()) {
      assert.equal(capture.requestId, `${arm.phase}-${dispatched[i].turn}`);
      assert.equal(capture.payloadHash, dispatched[i].wireSha256);
    }
    arms.push({ phase: arm.phase, trajectoryCompleted: arm.completed, ...scoreCaptures(captures, source, reference) });
  }
  await writeFile(new URL('context-report.json', run), JSON.stringify({
    semantics: 'Mapped read coverage is a lower bound. Shell output and changed/truncated files stay explicitly unmapped. Not official ContextBench scores.',
    referenceSha256: createHash('sha256').update(referenceBytes).digest('hex'), excludedSourceFiles: excluded, arms,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [run, reference, ...extra] = process.argv.slice(2);
  assert.ok(run && reference && !extra.length, 'Usage: score.ts RUN_DIRECTORY evaluator-reference.json');
  await main(run, reference);
}
