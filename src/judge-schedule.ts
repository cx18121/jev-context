import { createHash } from 'node:crypto';
import type { SelectionPlan } from './selection.ts';

export const judgmentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type Candidate = SelectionPlan['candidates'][number];
function identity(candidate: Candidate, plan: SelectionPlan, context: string) {
  const { method, contextLimit, outputReserve, marginTokens } = plan.workingBefore;
  return judgmentHash({ context, method, contextLimit, outputReserve, marginTokens,
    call: candidate.evidence.call, result: candidate.evidence.result, text: candidate.text });
}

/** Scheduling only. Old scores never authorize a context edit. Reopening starts empty. */
export class JudgeSchedule {
  private keeps = new Map<string, { identity: string; input: number }>();

  clear() { this.keeps.clear(); }

  select(plan: SelectionPlan, context: string) {
    const input = plan.workingBefore.inputEstimate;
    const measurable = input !== null && Number.isFinite(input) && input >= 0;
    const interval = Math.ceil(plan.workingBefore.contextLimit / 4);
    const skippedIds: string[] = [];
    const candidates = plan.candidates.filter((candidate) => {
      const id = candidate.evidence.id, previous = this.keeps.get(id);
      if (!candidate.archived && plan.before.fits && measurable && previous &&
          previous.identity === identity(candidate, plan, context) && input - previous.input < interval) {
        skippedIds.push(id);
        return false;
      }
      // An attempted rejudgment cannot fall back to its earlier keep after failure or omission.
      this.keeps.delete(id);
      return true;
    });
    return { candidates, skippedIds };
  }

  /** Called only after the complete, non-deferred selection has committed. */
  record(plan: SelectionPlan, context: string, scores: Record<string, number>, retireBelow: number) {
    const input = plan.workingBefore.inputEstimate;
    if (input === null || !Number.isFinite(input) || input < 0) return;
    for (const candidate of plan.candidates) {
      const score = scores[candidate.evidence.id];
      if (!candidate.archived && score !== undefined && Number.isFinite(score) && score >= retireBelow && score <= 1) {
        this.keeps.set(candidate.evidence.id, { identity: identity(candidate, plan, context), input });
      }
    }
  }
}
