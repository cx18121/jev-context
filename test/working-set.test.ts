import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapacityMeasurement } from '../src/budget.ts';
import { packWorkingSet, underPressure, type Priority, type WorkingSetItem } from '../src/working-set.ts';

const target = { highTokens: 100, lowTokens: 80, restoreHeadroomTokens: 0 };
function fixture(spec: Array<[string, boolean, number, number, number?]>, floorTokens = 20, floorBytes = 40, wireLimit = 10000) {
  const items: WorkingSetItem[] = spec.map(([id, resident], capturedAt) => ({ id, resident, capturedAt }));
  const scores: Record<string, Priority> = Object.fromEntries(spec.map(([id, , , level, score]) => [id, { level, score: score ?? level }]));
  const sizes = new Map(spec.map(([id, , size]) => [id, size]));
  const measure = (ids: readonly string[]): CapacityMeasurement => {
    const size = ids.reduce((sum, id) => sum + sizes.get(id)!, 0);
    const totalTokens = floorTokens + size, wireBytes = floorBytes + size * 4;
    const tokenFits = totalTokens <= 200, wireFits = wireBytes <= wireLimit;
    return { input: { method: 'cold-visible-bytes-plus-output-v1', tokens: totalTokens - 10, anchorRequestId: null, opaqueOutputTokens: 0 },
      totalTokens, outputReserve: 8, outputReserveSource: 'configured-headroom', marginTokens: 2, contextLimit: 200,
      wireBytes, maxRequestBytes: wireLimit, tokenFits, wireFits, admitted: tokenFits && wireFits };
  };
  const pack = (mode: 'rebalance' | 'restore-only' = 'rebalance') => packWorkingSet(items, target, mode, { kind: 'jev', priorities: scores }, measure);
  const capture = (mode: 'rebalance' | 'restore-only' = 'rebalance') => packWorkingSet(items, target, mode, { kind: 'capture-order' }, measure);
  return { items, scores, measure, pack, capture };
}

test('all-useful evidence is ranked into capacity instead of requiring an irrelevant tail', () => {
  const f = fixture([['most', true, 35, 4], ['less', true, 30, 3], ['least', true, 25, 2]]);
  const result = f.pack();
  assert.equal(underPressure(result.before, target), true);
  assert.equal(result.outcome, 'selected');
  assert.deepEqual(result.visibleIds, ['most', 'least']);
  assert.deepEqual(result.displacedIds, ['less']);
  assert.equal(result.after.totalTokens, 80);
  assert.deepEqual(result.skipped, [{ id: 'less', reason: 'lower-priority-under-capacity' }]);
  assert.equal(result.targetMiss, false);
});

test('whole first-fit packing skips an oversized item and continues to smaller items', () => {
  const result = fixture([['large', true, 90, 4], ['small', true, 50, 2]]).pack();
  assert.deepEqual(result.visibleIds, ['small']);
  assert.deepEqual(result.skipped, [{ id: 'large', reason: 'whole-item-exceeds-target' }]);
});

test('priority ties favor incumbents, then newer capture, then stable ID', () => {
  const f = fixture([['old', true, 30, 3], ['new', true, 30, 3], ['archive', false, 30, 3, 3.99]]);
  assert.deepEqual(f.pack().visibleIds, ['new', 'old']);
  f.items[0]!.capturedAt = f.items[1]!.capturedAt;
  const expected = f.pack().visibleIds;
  assert.deepEqual(expected, ['new', 'old']); // lexical ID tie, independent of input order
  assert.deepEqual(packWorkingSet([...f.items].reverse(), target, 'rebalance', { kind: 'jev', priorities: f.scores }, f.measure).visibleIds, expected);
});

test('a restore must beat every victim by a median level, not a fraction of expected score', () => {
  const f = fixture([['resident', true, 60, 3, 3.1], ['archive', false, 50, 3, 3.9]]);
  assert.deepEqual(f.pack().visibleIds, ['resident']);
  assert.equal(f.pack().skipped[0]!.reason, 'swap-margin');
  f.scores.archive = { level: 4, score: 3.9 };
  const result = f.pack();
  assert.deepEqual(result.visibleIds, ['archive']);
  assert.deepEqual(result.displacedIds, ['resident']);
  assert.deepEqual(result.restoredIds, ['archive']);
});

test('swaps cannot launder a same-level victim through a lower-ranked victim', () => {
  const f = fixture([['low', true, 20, 1], ['same', true, 40, 3, 3.1], ['archive', false, 50, 3, 3.9]]);
  const result = f.pack();
  assert.deepEqual(result.visibleIds, ['same', 'low']);
  assert.deepEqual(result.restoredIds, []);
  assert.equal(result.skipped[0]!.reason, 'swap-margin');
});

test('failed restores roll back trial displacements; successful swaps refill freed whole-item room', () => {
  const f = fixture([['large', true, 60, 1], ['extra', true, 20, 0], ['best', false, 30, 4]]);
  const result = f.pack();
  assert.deepEqual(result.visibleIds, ['best', 'extra']);
  assert.deepEqual(result.displacedIds, ['large']);
  assert.equal(result.after.totalTokens, 70);
});

test('each swap refills residents before a later lower-ranked archive can take their room', () => {
  const first = fixture([['X', true, 50, 2], ['Y', true, 10, 1], ['A', false, 40, 3], ['B', false, 20, 0]]).pack();
  assert.deepEqual(first.visibleIds, ['A', 'Y']);
  assert.deepEqual(first.displacedIds, ['X']);
  const second = fixture([['X', true, 50, 2], ['Z', true, 25, 2, 1.9], ['A', false, 30, 3], ['B', false, 30, 1]]).pack();
  assert.deepEqual(second.visibleIds, ['A', 'Z']);
  assert.deepEqual(second.displacedIds, ['X']);
});

test('restore-only requires no resident scores, never displaces, and fills only to the low mark', () => {
  const f = fixture([['resident', true, 40, 0], ['small', false, 20, 2], ['big', false, 30, 4]]);
  delete f.scores.resident;
  const result = f.pack('restore-only');
  assert.deepEqual(new Set(result.visibleIds), new Set(['resident', 'small']));
  assert.deepEqual(result.displacedIds, []);
  assert.equal(result.after.totalTokens, target.lowTokens);
  const busy = fixture([['resident', true, 70, 0], ['small', false, 5, 4]]).pack('restore-only');
  assert.deepEqual(busy.visibleIds, ['resident']);
  assert.equal(busy.targetMiss, true);
});

test('rebalancing leaves restoration headroom that a later restore-only decision can use', () => {
  const withHeadroom = { ...target, restoreHeadroomTokens: 20 };
  const residents: Array<[string, boolean, number, number]> = [['a', true, 30, 4], ['b', true, 25, 3], ['c', true, 20, 1]];
  const f = fixture(residents);
  const tight = packWorkingSet(f.items, target, 'rebalance', { kind: 'jev', priorities: f.scores }, f.measure);
  const roomy = packWorkingSet(f.items, withHeadroom, 'rebalance', { kind: 'jev', priorities: f.scores }, f.measure);
  assert.deepEqual([tight.visibleIds, tight.after.totalTokens], [['a', 'b'], 75]);
  assert.deepEqual([roomy.visibleIds, roomy.after.totalTokens, roomy.targetTokens, roomy.targetMiss], [['a'], 50, 60, false]);
  // Restoration still fills to the low mark. Only the headroom state has room, and the better retired item returns first.
  const restore = (visible: string[]) => {
    const next = fixture([...residents.map(([id, , size, level]): [string, boolean, number, number] => [id, visible.includes(id), size, level]),
      ['x', false, 20, 2]]);
    return packWorkingSet(next.items, withHeadroom, 'restore-only', { kind: 'jev', priorities: next.scores }, next.measure).restoredIds;
  };
  assert.deepEqual(restore(tight.visibleIds), []);
  assert.deepEqual(restore(roomy.visibleIds), ['b']);
  assert.throws(() => packWorkingSet(f.items, { ...target, restoreHeadroomTokens: 80 }, 'rebalance', { kind: 'jev', priorities: f.scores }, f.measure));
});

test('a floor above the working target is a target miss, not a hard capacity stop', () => {
  const result = fixture([['old', true, 20, 4]], 110).pack();
  assert.equal(result.outcome, 'selected');
  assert.equal(result.floorDominated, true);
  assert.equal(result.targetTokens, 110);
  assert.equal(result.after.totalTokens, 110);
  assert.equal(result.targetMiss, true);
  assert.deepEqual(result.visibleIds, []);
});

test('only an inadmissible pinned floor is a capacity stop, including independent wire overflow', () => {
  for (const f of [fixture([['old', true, 10, 4]], 201), fixture([['old', true, 10, 4]], 20, 101, 100)]) {
    const result = f.pack();
    assert.equal(result.outcome, 'capacity-stop');
    assert.deepEqual(result.visibleIds, ['old']);
    assert.deepEqual(result.displacedIds, []);
    assert.deepEqual(result.after, result.before);
  }
  const f = fixture([['old', true, 190, 4]]);
  const incomplete = f.pack('restore-only');
  assert.equal(incomplete.floor.admitted, true);
  assert.equal(incomplete.outcome, 'selection-incomplete');
});

test('the packer remeasures actual proposals against both token and transport limits', () => {
  const f = fixture([['first', true, 30, 4], ['second', true, 30, 3]], 20, 40, 200);
  const result = f.pack();
  assert.deepEqual(result.visibleIds, ['first']);
  assert.equal(result.after.wireBytes, 160);
  assert.equal(result.after.admitted, true);
  assert.equal(result.after.totalTokens, 50);
});

test('incomplete, foreign, duplicate and invalid rankings fail rather than treating missing scores as low', () => {
  const f = fixture([['a', true, 20, 3], ['b', false, 20, 4]]);
  const invalid: Record<string, Priority>[] = [{ a: f.scores.a! }, { ...f.scores, c: f.scores.a! },
    { ...f.scores, a: { level: 1.5, score: 2 } }, { ...f.scores, a: { level: 4, score: NaN } }];
  for (const scores of invalid) {
    assert.throws(() => packWorkingSet(f.items, target, 'rebalance', { kind: 'jev', priorities: scores }, f.measure), /Invalid or incomplete/);
  }
  assert.throws(() => packWorkingSet([...f.items, f.items[0]!], target, 'rebalance', { kind: 'jev', priorities: f.scores }, f.measure), /Invalid or incomplete/);
  for (const bad of [{ highTokens: 100, lowTokens: 100, restoreHeadroomTokens: 0 }, { highTokens: 201, lowTokens: 80, restoreHeadroomTokens: 0 }, { highTokens: 100, lowTokens: 0, restoreHeadroomTokens: 0 }]) {
    assert.throws(() => packWorkingSet(f.items, bad, 'rebalance', { kind: 'jev', priorities: f.scores }, f.measure), /Working-set targets/);
  }
});

test('capture order keeps newer residents and permits only strictly newer archive swaps', () => {
  const f = fixture([['old', true, 60, 4], ['new', false, 50, 0]]);
  assert.deepEqual(f.capture().visibleIds, ['new']);
  assert.deepEqual(f.pack().visibleIds, ['old'], 'Jev still uses its own level rule');
  for (const key of Object.keys(f.scores)) delete f.scores[key];
  assert.deepEqual(f.capture().visibleIds, ['new'], 'capture order has no score dependency');
  const older = fixture([['archive', false, 50, 4], ['resident', true, 60, 0]]).capture();
  assert.deepEqual(older.visibleIds, ['resident']);
  assert.equal(older.skipped[0]!.reason, 'swap-margin');
  assert.deepEqual(fixture([['old', true, 40, 4], ['new', true, 40, 0]]).capture().visibleIds, ['new']);
});

test('capture-order swaps refill residents before an older archive can use the freed room', () => {
  const f = fixture([['B', false, 20, 4], ['Y', true, 10, 0], ['X', true, 50, 0], ['A', false, 40, 0]]);
  assert.deepEqual(f.capture().visibleIds, ['A', 'Y']);
  assert.deepEqual(f.capture().displacedIds, ['X']);
  const skipped = fixture([['B', false, 30, 4], ['Z', true, 25, 0], ['X', true, 50, 0], ['A', false, 30, 0]]);
  assert.deepEqual(skipped.capture().visibleIds, ['A', 'Z']);
});

test('capture order rejects ambiguous chronology without changing Jev tie handling', () => {
  const f = fixture([['a', true, 20, 3], ['b', false, 20, 4]]);
  f.items[1]!.capturedAt = f.items[0]!.capturedAt;
  assert.throws(() => f.capture(), /unique chronological positions/);
  assert.equal(f.pack().outcome, 'selected');
});

test('capture-order enumeration preserves capacity, recency margins and restore-only residents', () => {
  for (let archivePosition = 0; archivePosition < 3; archivePosition++) {
    for (const a of [10, 30, 60, 100]) for (const b of [10, 30, 60, 100]) for (const c of [10, 30, 60, 100]) {
      const f = fixture([a, b, c].map((size, index) => [String(index), index !== archivePosition, size, 0]));
      const result = f.capture();
      assert.equal(result.after.admitted, true);
      assert.ok(result.after.totalTokens <= target.lowTokens);
      assert.deepEqual(result.after, f.measure(result.visibleIds));
      assert.deepEqual(packWorkingSet([...f.items].reverse(), target, 'rebalance', { kind: 'capture-order' }, f.measure), result);
      const initial = packWorkingSet(f.items.filter((item) => item.resident), target, 'rebalance', { kind: 'capture-order' }, f.measure);
      if (result.restoredIds.length) {
        for (const id of initial.visibleIds.filter((id) => !result.visibleIds.includes(id))) {
          assert.ok(archivePosition > Number(id), 'the archive must be newer than every swap victim');
        }
      }
      const restore = f.capture('restore-only');
      assert.deepEqual(restore.displacedIds, []);
      if (restore.restoredIds.length) assert.ok(restore.after.totalTokens <= target.lowTokens);
    }
  }
});

test('bounded enumeration preserves pins, capacity, determinism and strict swap margins', () => {
  for (const residentSize of [10, 30, 60, 100]) for (const archiveSize of [10, 30, 60, 100]) {
    for (const residentLevel of [0, 2, 4]) for (const archiveLevel of [0, 2, 4]) {
      const f = fixture([['resident', true, residentSize, residentLevel], ['archive', false, archiveSize, archiveLevel]]);
      const result = f.pack();
      assert.equal(result.after.admitted, true);
      assert.ok(result.after.totalTokens <= target.lowTokens);
      assert.deepEqual(result.after, f.measure(result.visibleIds));
      assert.deepEqual(f.pack(), result);
      if (result.restoredIds.length && result.displacedIds.length && residentSize <= 60) {
        assert.ok(archiveLevel > residentLevel);
      }
    }
  }
});
