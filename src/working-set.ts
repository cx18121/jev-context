import type { CapacityMeasurement } from './budget.ts';

export interface WorkingSetTarget {
  highTokens: number;
  lowTokens: number;
}

/** Levels are ordinal. Expected score only breaks ties within a median level. */
export interface Priority {
  level: number;
  score: number;
}

export interface WorkingSetItem {
  id: string;
  capturedAt: number;
  resident: boolean;
}

type RankedItem = WorkingSetItem & { priority?: Priority };

export interface WorkingSetSelection {
  outcome: 'selected' | 'capacity-stop' | 'selection-incomplete';
  visibleIds: string[];
  displacedIds: string[];
  restoredIds: string[];
  skipped: Array<{ id: string; reason: 'whole-item-exceeds-target' | 'lower-priority-under-capacity' | 'swap-margin' }>;
  before: CapacityMeasurement;
  floor: CapacityMeasurement;
  after: CapacityMeasurement;
  targetTokens: number;
  targetMiss: boolean;
  floorDominated: boolean;
}

function compare(a: RankedItem, b: RankedItem) {
  return (b.priority?.level ?? -1) - (a.priority?.level ?? -1) || (b.priority?.score ?? -1) - (a.priority?.score ?? -1) ||
    Number(b.resident) - Number(a.resident) || b.capturedAt - a.capturedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function validateWorkingSetTarget(target: WorkingSetTarget, contextLimit: number) {
  if (!Number.isSafeInteger(target.lowTokens) || !Number.isSafeInteger(target.highTokens) ||
      target.lowTokens <= 0 || target.lowTokens >= target.highTokens || target.highTokens > contextLimit) {
    throw new Error('Working-set targets require 0 < lowTokens < highTokens <= provider token allowance');
  }
}

export function underPressure(measured: CapacityMeasurement, target: WorkingSetTarget) {
  validateWorkingSetTarget(target, measured.contextLimit);
  return !measured.admitted || measured.totalTokens > target.highTokens;
}

/**
 * One complete replacement, never a stream of edits. `measure` renders the listed items whole and
 * every other eligible item as its stub; pins are outside this list and always remain in the view.
 * It must use the same request, usage anchor and limits for every call. Scores must come from one
 * decision. Rebalancing requires every score; restore-only needs no scores for unchanged residents.
 */
export function packWorkingSet(
  items: readonly WorkingSetItem[], target: WorkingSetTarget,
  mode: 'rebalance' | 'restore-only', scores: Readonly<Record<string, Priority>>,
  measure: (visibleIds: readonly string[]) => CapacityMeasurement,
): WorkingSetSelection {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length || items.some((item) => !item.id || !Number.isSafeInteger(item.capturedAt) || item.capturedAt < 0) ||
      Object.entries(scores).some(([id, priority]) => !byId.has(id) ||
        !Number.isInteger(priority.level) || priority.level < 0 || priority.level > 4 ||
        !Number.isFinite(priority.score) || priority.score < 0 || priority.score > 4) ||
      items.some((item) => (mode === 'rebalance' || !item.resident) && !Object.hasOwn(scores, item.id))) {
    throw new Error('Invalid or incomplete working-set ranking');
  }
  const ordered: RankedItem[] = items.map((item) => ({ ...item, priority: scores[item.id] })).sort(compare);
  const residents = ordered.filter((item) => item.resident);
  const before = measure(residents.map((item) => item.id));
  const floor = measure([]);
  validateWorkingSetTarget(target, before.contextLimit);
  const targetTokens = Math.max(target.lowTokens, floor.totalTokens);
  const floorDominated = floor.totalTokens > target.lowTokens;
  const fits = (value: CapacityMeasurement) => value.admitted && value.totalTokens <= targetTokens;
  const finish = (outcome: WorkingSetSelection['outcome'], selected: Set<string>, after: CapacityMeasurement,
    skipped: WorkingSetSelection['skipped'] = []): WorkingSetSelection => ({
    outcome, visibleIds: ordered.filter((item) => selected.has(item.id)).map((item) => item.id),
    displacedIds: residents.filter((item) => !selected.has(item.id)).map((item) => item.id),
    restoredIds: ordered.filter((item) => !item.resident && selected.has(item.id)).map((item) => item.id),
    skipped, before, floor, after, targetTokens, targetMiss: after.totalTokens > target.lowTokens, floorDominated,
  });
  const original = new Set(residents.map((item) => item.id));
  if (!floor.admitted) return finish('capacity-stop', original, before);
  if (mode === 'restore-only' && !before.admitted) return finish('selection-incomplete', original, before);

  let selected = mode === 'restore-only' ? original : new Set<string>();
  let after = mode === 'restore-only' ? before : floor;
  const reasons = new Map<string, WorkingSetSelection['skipped'][number]['reason']>();
  const trial = (ids: Set<string>) => measure([...ids]);
  const addIfFits = (item: WorkingSetItem) => {
    const next = new Set(selected).add(item.id);
    const measured = trial(next);
    if (!fits(measured)) return false;
    selected = next;
    after = measured;
    reasons.delete(item.id);
    return true;
  };

  // Establish the best fitting resident set first. Archive entries must earn any displacement
  // by a full median level, rather than by a tiny change in an uncalibrated expected score.
  if (mode === 'rebalance') for (const item of residents) addIfFits(item);
  for (const item of ordered.filter((candidate) => !candidate.resident)) {
    if (addIfFits(item)) continue;
    if (!fits(measure([item.id]))) { reasons.set(item.id, 'whole-item-exceeds-target'); continue; }
    if (mode === 'restore-only') { reasons.set(item.id, 'lower-priority-under-capacity'); continue; }
    const victims = residents.filter((resident) => selected.has(resident.id) && resident.priority!.level < item.priority!.level).reverse();
    const next = new Set(selected).add(item.id);
    let accepted = false;
    for (const victim of victims) {
      next.delete(victim.id);
      const measured = trial(next);
      if (!fits(measured)) continue;
      selected = next;
      after = measured;
      accepted = true;
      break;
    }
    if (accepted) {
      // Removing a large victim may make earlier removals unnecessary. Refill before another
      // archive can take that room without earning its own strictly-higher-level swap.
      for (const resident of residents) if (!selected.has(resident.id)) addIfFits(resident);
    } else reasons.set(item.id, 'swap-margin');
  }
  const skipped = ordered.filter((item) => !selected.has(item.id)).map((item) => ({ id: item.id,
    reason: reasons.get(item.id) ?? (fits(measure([item.id])) ? 'lower-priority-under-capacity' : 'whole-item-exceeds-target'),
  }));
  return finish('selected', selected, after, skipped);
}
