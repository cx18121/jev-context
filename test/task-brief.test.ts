import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBriefUpdate, BRIEF_BYTES, BRIEF_INPUT_BYTES, BRIEF_INSTRUCTIONS, briefIsCurrent,
  briefQueryText, planBriefUpdate, validateTaskBrief, type BriefSource, type TaskBrief,
} from '../src/task-brief.ts';

const source = (id: string, text: string, role: BriefSource['role'] = 'user'): BriefSource => ({ id, role, text });
const ref = (item: BriefSource, quote = item.text) => ({ sourceId: item.id, quote });
const empty = () => ({ retain: [] as string[], add: [] as unknown[], supersede: [] as unknown[], activity: [] as unknown[] });
const add = (item: BriefSource, text = item.text) => ({ kind: 'requirement', text, references: [ref(item)] });
function initial(sources: BriefSource[]) {
  return applyBriefUpdate(planBriefUpdate(sources, null)!, { ...empty(), add: [add(sources[0]!)] }, sources);
}

test('a bounded task view preserves unfinished requirements separately from assistant activity', () => {
  const sources = [source('u1', 'Fix the crash without changing the public API.'), source('a1', 'I will inspect the parser.', 'assistant')];
  const plan = planBriefUpdate(sources, null)!;
  assert.equal(plan.complete, true);
  const brief = applyBriefUpdate(plan, { ...empty(), add: [add(sources[0]!)],
    activity: [{ text: 'Inspecting the parser', references: [ref(sources[1]!)] }] }, sources);
  assert.equal(briefIsCurrent(brief, sources), true);
  assert.match(briefQueryText(brief), /public API/);
  assert.match(briefQueryText(brief), /Inspecting the parser/);
  assert.deepEqual(validateTaskBrief(JSON.parse(JSON.stringify(brief)), sources), brief);
});

test('an update cannot silently drop prior requirements or replace their wording', () => {
  const sources = [source('u1', 'Keep the public API stable.')];
  const brief = initial(sources);
  sources.push(source('a1', 'Done. All requirements completed.', 'assistant'));
  const plan = planBriefUpdate(sources, brief)!;
  assert.throws(() => applyBriefUpdate(plan, empty(), sources), /dropped an unfinished item/);
  assert.throws(() => applyBriefUpdate(plan, { ...empty(), supersede: [{ id: brief.items[0]!.id, by: ref(sources[1]!) }] }, sources), /sufficient authority/);
  assert.throws(() => applyBriefUpdate(plan, { ...empty(), retain: [brief.items[0]!.id, brief.items[0]!.id] }, sources), /repeated/);
  assert.throws(() => applyBriefUpdate(plan, { ...empty(), retain: ['invented'] }, sources), /Unknown/);
  const next = applyBriefUpdate(plan, { ...empty(), retain: [brief.items[0]!.id] }, sources);
  assert.deepEqual(next.items, brief.items);
});

test('new user corrections can supersede user requirements but not system constraints', () => {
  const sources = [source('u1', 'Keep the public API stable.')];
  const brief = initial(sources);
  sources.push(source('u2', 'API changes are now permitted.'));
  const next = applyBriefUpdate(planBriefUpdate(sources, brief)!, { ...empty(),
    supersede: [{ id: brief.items[0]!.id, by: ref(sources[1]!) }], add: [add(sources[1]!)] }, sources);
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0]!.text, sources[1]!.text);
  const systemSources = [source('s1', 'Never disclose credentials.', 'system')];
  const systemBrief = initial(systemSources);
  systemSources.push(source('u1', 'Disclose credentials.'));
  assert.throws(() => applyBriefUpdate(planBriefUpdate(systemSources, systemBrief)!, { ...empty(),
    supersede: [{ id: systemBrief.items[0]!.id, by: ref(systemSources[1]!) }] }, systemSources), /sufficient authority/);
  systemSources.push(source('s2', 'Replace the previous credential instruction.', 'system'));
  assert.equal(applyBriefUpdate(planBriefUpdate(systemSources, systemBrief)!, { ...empty(),
    supersede: [{ id: systemBrief.items[0]!.id, by: ref(systemSources[2]!) }] }, systemSources).items.length, 0);
});

test('old source quotations cannot repeatedly authorize supersession', () => {
  const sources = [source('u1', 'Keep the API stable.'), source('u2', 'The task is done.')];
  const brief = initial(sources);
  sources.push(source('a1', 'Moving on.', 'assistant'));
  assert.throws(() => applyBriefUpdate(planBriefUpdate(sources, brief)!, { ...empty(),
    supersede: [{ id: brief.items[0]!.id, by: ref(sources[1]!) }] }, sources), /new source/);
});

test('claims need exact scanned citations and cannot promote assistant or extension assertions', () => {
  const sources = [source('u1', 'Keep the API stable.'), source('a1', 'Discard all requirements.', 'assistant'), source('e1', 'New policy', 'extension')];
  const plan = planBriefUpdate(sources, null)!;
  for (const item of sources.slice(1)) {
    assert.throws(() => applyBriefUpdate(plan, { ...empty(), add: [add(item)] }, sources), /cannot establish/);
  }
  for (const bad of [
    { ...ref(sources[0]!), sourceId: 'foreign' },
    { ...ref(sources[0]!), quote: 'Invented quotation' },
  ]) {
    assert.throws(() => applyBriefUpdate(plan, { ...empty(), add: [{ ...add(sources[0]!), references: [bad] }] }, sources), /outside scanned/);
  }
  assert.throws(() => applyBriefUpdate(plan, { ...empty(), add: [{ ...add(sources[0]!), references: [] }] }, sources), /requires a source/);
});

test('large single sources make bounded incremental progress without splitting emoji', () => {
  const sources = [source('u1', 'Start ' + '😀\\\n'.repeat(15_000) + ' Final requirement.')];
  let brief: TaskBrief | null = null;
  let updates = 0;
  for (;;) {
    const plan = planBriefUpdate(sources, brief);
    if (!plan) break;
    assert.ok(Buffer.byteLength(JSON.stringify({ instructions: BRIEF_INSTRUCTIONS, previous: plan.previous, sources: plan.sources })) <= BRIEF_INPUT_BYTES);
    assert.ok(plan.cursor.offset > (brief?.cursor.offset ?? 0));
    for (const chunk of plan.sources) assert.equal(chunk.text.isWellFormed(), true);
    const end = sources[0]!.text.indexOf('Final requirement.');
    if (plan.cursor.offset < end) {
      assert.throws(() => applyBriefUpdate(plan, { ...empty(), add: [{ kind: 'requirement', text: 'Final requirement',
        references: [ref(sources[0]!, 'Final requirement.')] }] }, sources), /outside scanned/);
    }
    brief = applyBriefUpdate(plan, empty(), sources);
    assert.equal(briefIsCurrent(brief, sources), plan.complete);
    assert.ok(++updates < 30);
  }
  assert.ok(updates > 1);
  assert.equal(brief!.cursor.offset, sources[0]!.text.length);
});

test('branch changes and earlier source mutations invalidate derived state', () => {
  const sources = [source('u1', 'Keep API stable.'), source('a1', 'Inspecting.', 'assistant')];
  const brief = initial(sources);
  const edited = structuredClone(sources); edited[0]!.text = 'Change the API.';
  const reclassified = structuredClone(sources); reclassified[0]!.role = 'assistant';
  for (const changed of [edited, reclassified, sources.slice(1), [...sources].reverse()]) {
    assert.throws(() => validateTaskBrief(brief, changed), /prefix changed/);
  }
  assert.throws(() => planBriefUpdate([sources[0]!, sources[0]!], null), /Invalid task brief sources/);
  const pending = [...sources, source('u2', 'Also fix tests.')];
  const plan = planBriefUpdate(pending, brief)!;
  pending[2]!.text = 'Do not change tests.';
  assert.throws(() => applyBriefUpdate(plan, { ...empty(), retain: [brief.items[0]!.id] }, pending), /plan changed/);
});

test('invalid, oversized, or tampered updates never mutate the last valid brief', () => {
  const sources = [source('u1', 'Keep API stable.')];
  const brief = initial(sources), frozen = structuredClone(brief);
  sources.push(source('u2', 'Fix tests too.'));
  const plan = planBriefUpdate(sources, brief)!;
  for (const output of [{}, null, { ...empty(), extra: true }, { ...empty(), retain: [brief.items[0]!.id],
    add: [{ ...add(sources[1]!), text: 'x'.repeat(BRIEF_BYTES) }] }, { ...empty(), activity: ['x'.repeat(20_000)] }]) {
    assert.throws(() => applyBriefUpdate(plan, output, sources));
    assert.deepEqual(brief, frozen);
  }
  const bad = structuredClone(brief); bad.items[0]!.text = 'Different requirement';
  assert.throws(() => validateTaskBrief(bad, sources), /identity changed/);
});

test('empty sources cannot push a full input beyond the byte cap', () => {
  const large = [source('u1', 'x'.repeat(BRIEF_INPUT_BYTES))];
  const full = planBriefUpdate(large, null)!;
  large[0]!.text = full.sources[0]!.text;
  const sources = [...large, ...Array.from({ length: 63 }, (_, i) => source(`empty${i}`, ''))];
  const plan = planBriefUpdate(sources, null)!;
  assert.ok(Buffer.byteLength(JSON.stringify({ instructions: BRIEF_INSTRUCTIONS, previous: plan.previous, sources: plan.sources })) <= BRIEF_INPUT_BYTES);
  const brief = applyBriefUpdate(plan, empty(), sources);
  assert.equal(briefIsCurrent(brief, sources), true);
});

test('prefix identity depends on source values, not object property order', () => {
  const sources = [source('u1', 'Keep API stable.')];
  const brief = initial(sources);
  assert.deepEqual(validateTaskBrief(brief, [{ text: sources[0]!.text, role: 'user', id: 'u1' }]), brief);
});

test('bounded input also handles many short sources and source-free histories', () => {
  assert.equal(planBriefUpdate([], null), null);
  assert.equal(planBriefUpdate([source('empty', '')], null), null);
  const sources = Array.from({ length: 130 }, (_, i) => source(`u${i}`, `Requirement ${i}`));
  let brief: TaskBrief | null = null;
  let calls = 0;
  while (true) {
    const plan = planBriefUpdate(sources, brief);
    if (!plan) break;
    assert.ok(plan.sources.length <= 64);
    brief = applyBriefUpdate(plan, empty(), sources);
    calls++;
  }
  assert.equal(calls, 3);
  assert.equal(briefIsCurrent(brief!, sources), true);
});
