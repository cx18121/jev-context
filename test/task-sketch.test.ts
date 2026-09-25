import assert from 'node:assert/strict';
import test from 'node:test';
import { applySketchUpdate, planSketchUpdate, sketchIsCurrent, validateTaskSketch,
  SKETCH_BYTES, SKETCH_INPUT_BYTES, SKETCH_INSTRUCTIONS, SKETCH_TEXT_BYTES, type SketchSource, type TaskSketch } from '../src/task-sketch.ts';

const source = (id: string, text = 'Fix the parser.'): SketchSource => ({ id, role: 'user', text });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test('rewriting a full sketch preserves bounded progress without a grow-only claim inventory', () => {
  const sources = [source('u1')];
  let sketch = applySketchUpdate(planSketchUpdate(sources, null)!, { summary: 'x'.repeat(SKETCH_TEXT_BYTES - 2) }, sources);
  for (let i = 2; i < 102; i++) {
    sources.push(source(`u${i}`, `Also consider requirement ${i}.`));
    const plan = planSketchUpdate(sources, sketch)!;
    assert.equal(plan.sources.length, 1);
    assert.equal(plan.sources[0]!.id, `u${i}`);
    const previous = structuredClone(sketch);
    sketch = applySketchUpdate(plan, { summary: `Compact advisory task summary ${i}.` }, sources);
    assert.deepEqual(plan.previous, previous);
    assert.ok(bytes(sketch) <= SKETCH_BYTES);
    assert.equal(sketchIsCurrent(sketch, sources), true);
  }
});

test('large sources advance through complete contiguous Unicode-safe chunks under the input cap', () => {
  const sources = [source('u1', ('😀 漢字 \\ quote "\r\n').repeat(8000)), source('u2', 'Final correction.')];
  let sketch: TaskSketch | null = null;
  const captured = new Map<string, string>();
  let count = 0;
  while (true) {
    const plan = planSketchUpdate(sources, sketch);
    if (!plan) break;
    assert.ok(bytes({ instructions: SKETCH_INSTRUCTIONS, previous: plan.previous, sources: plan.sources }) <= SKETCH_INPUT_BYTES);
    for (const chunk of plan.sources) {
      const earlier = captured.get(chunk.id) ?? '';
      assert.equal(chunk.start, earlier.length);
      assert.equal(chunk.text.isWellFormed(), true);
      captured.set(chunk.id, earlier + chunk.text);
    }
    sketch = applySketchUpdate(plan, { summary: 'Rewritten compact summary.' }, sources);
    assert.equal(sketchIsCurrent(sketch, sources), plan.complete);
    assert.ok(++count < 50, 'each bounded update must make progress');
  }
  assert.ok(count > 1);
  assert.deepEqual([...captured.values()], sources.map((s) => s.text));
  assert.equal(sketchIsCurrent(sketch!, sources), true);
});

test('new source appended during inference leaves valid progress but never a current sketch', () => {
  const captured = [source('u1')];
  const plan = planSketchUpdate(captured, null)!;
  const sketch = applySketchUpdate(plan, { summary: 'Fix the parser.' }, captured);
  const fresh = [...captured, source('u2', 'Keep the public API unchanged.')];
  assert.deepEqual(validateTaskSketch(sketch, fresh), sketch);
  assert.equal(sketchIsCurrent(sketch, fresh), false);
  assert.equal(planSketchUpdate(fresh, sketch)!.sources[0]!.id, 'u2');
  for (const changed of [[source('u1', 'Different task')], [{ ...captured[0]!, role: 'assistant' as const }], [source('foreign')]]) {
    assert.throws(() => validateTaskSketch(sketch, changed), /source prefix changed/);
  }
  assert.throws(() => applySketchUpdate({ ...plan, complete: false }, { summary: 'bad' }, captured), /plan changed/);
});

test('partial-entry cursor authenticates the scanned prefix but not an unseen suffix', () => {
  const sources = [source('u1', 'a'.repeat(40_000))];
  const sketch = applySketchUpdate(planSketchUpdate(sources, null)!, { summary: 'partial' }, sources);
  assert.equal(sketchIsCurrent(sketch, sources), false);
  const changedTail = [source('u1', sources[0]!.text.slice(0, sketch.cursor.offset) + 'new tail')];
  assert.deepEqual(validateTaskSketch(sketch, changedTail), sketch);
  const next = planSketchUpdate(changedTail, sketch)!;
  assert.equal(next.sources[0]!.text, 'new tail');
  assert.throws(() => validateTaskSketch(sketch, [source('u1', 'b' + sources[0]!.text.slice(1))]), /prefix changed/);
});

test('empty sources and chunk-count limits cannot silently skip source identities', () => {
  assert.equal(planSketchUpdate([], null), null);
  const sources = Array.from({ length: 130 }, (_, i) => source(`empty${i}`, ''));
  let sketch: TaskSketch | null = null;
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const plan = planSketchUpdate(sources, sketch)!;
    assert.ok(plan.sources.length <= 64);
    seen.push(...plan.sources.map((s) => s.id));
    sketch = applySketchUpdate(plan, { summary: 'No textual task information yet.' }, sources);
  }
  assert.deepEqual(seen, sources.map((s) => s.id));
  assert.equal(sketchIsCurrent(sketch!, sources), true);
});

test('summary validation rejects empty, ill-formed, oversized and extra-key output without changing progress', () => {
  const sources = [source('u1')], plan = planSketchUpdate(sources, null)!;
  for (const output of [{}, { summary: '' }, { summary: '  ' }, { summary: '\ud800' },
    { summary: '😀'.repeat(3000) }, { summary: 'x'.repeat(SKETCH_TEXT_BYTES) }, { summary: 'ok', trusted: true }]) {
    assert.throws(() => applySketchUpdate(plan, output, sources));
  }
  assert.deepEqual(plan, planSketchUpdate(sources, null));
  assert.throws(() => planSketchUpdate([source('x', '\ud800')], null), /sources/);
  assert.throws(() => planSketchUpdate([source('x'), source('x')], null), /sources/);
});

test('maximum previous snapshot leaves room for progress; pathological metadata stops explicitly', () => {
  const sources = [source('u'.repeat(1500))];
  const sketch = applySketchUpdate(planSketchUpdate(sources, null)!, { summary: 'x'.repeat(SKETCH_TEXT_BYTES - 2) }, sources);
  assert.ok(bytes(sketch) <= SKETCH_BYTES);
  sources.push(source('v'.repeat(1500), '😀'));
  const next = planSketchUpdate(sources, sketch)!;
  assert.equal(next.complete, true);
  assert.ok(bytes({ instructions: SKETCH_INSTRUCTIONS, previous: next.previous, sources: next.sources }) <= SKETCH_INPUT_BYTES);
  assert.throws(() => planSketchUpdate([source('x'.repeat(SKETCH_INPUT_BYTES))], null), /no room for source progress/);
});
