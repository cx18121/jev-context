import { Buffer } from 'node:buffer';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { mapProviderEvidence } from './provider-view.ts';
import { measureRequest, type BudgetMeasurement, type RequestBudget } from './budget.ts';
import { retirementText, validateSelection, type Evidence, type HistoryView } from './history.ts';

export interface RetirementCandidate {
  evidence: Evidence;
  text: string;
  stub: string;
  saving: number;
  messageIndex: number;
}

export interface RetirementPlan {
  payload: unknown;
  history: HistoryView;
  before: BudgetMeasurement;
  candidates: RetirementCandidate[];
}

/** Both policies use the same pressure trigger and verified, shrinkable candidate pool. */
export function prepareRetirement(
  payload: unknown,
  messages: AgentMessage[],
  history: HistoryView,
  model: Model<Api>,
  budget: RequestBudget,
): RetirementPlan {
  const before = measureRequest(payload, model, budget);
  const retired = new Set(validateSelection(history, history.retiredIds));
  const candidates: RetirementCandidate[] = [];
  if (before.fits) return { payload, history, before, candidates };

  const eligible = history.evidence.filter((item) => !item.protectedReason && !retired.has(item.id));
  for (const mapped of mapProviderEvidence(payload, messages, eligible)) {
    const stub = retirementText(mapped.evidence);
    const saving = Buffer.byteLength(JSON.stringify(mapped.text), 'utf8') - Buffer.byteLength(JSON.stringify(stub), 'utf8');
    if (saving > 0) candidates.push({ ...mapped, stub, saving });
  }
  return { payload, history, before, candidates };
}

/** Apply only this ordering, without falling back to additional candidates. */
export function applyRetirement(plan: RetirementPlan, order: readonly string[], model: Model<Api>, budget: RequestBudget) {
  const retired = new Set(plan.history.retiredIds);
  if (plan.before.fits) return { payload: plan.payload, retiredIds: [...retired], budget: plan.before };
  const byId = new Map(plan.candidates.map((candidate) => [candidate.evidence.id, candidate]));
  if (new Set(order).size !== order.length || order.some((id) => !byId.has(id))) {
    throw new Error('Invalid retirement candidate ordering');
  }
  const proposed = structuredClone(plan.payload) as { messages: Array<Record<string, unknown>> };
  let remaining = plan.before.inputEstimate + plan.before.outputReserve + plan.before.marginTokens - plan.before.contextLimit;
  for (const id of order) {
    const candidate = byId.get(id)!;
    proposed.messages[candidate.messageIndex]!.content = candidate.stub;
    retired.add(id);
    remaining -= candidate.saving;
    if (remaining <= 0) break;
  }
  return { payload: proposed, retiredIds: validateSelection(plan.history, [...retired]), budget: measureRequest(proposed, model, budget) };
}

export function retireOldest(payload: unknown, messages: AgentMessage[], history: HistoryView, model: Model<Api>, budget: RequestBudget) {
  const plan = prepareRetirement(payload, messages, history, model, budget);
  return applyRetirement(plan, plan.candidates.map((candidate) => candidate.evidence.id), model, budget);
}
