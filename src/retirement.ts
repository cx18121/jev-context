import { Buffer } from 'node:buffer';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { sanitizeSurrogates } from '@earendil-works/pi-ai/utils/sanitize-unicode';
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

  // measureRequest validated this text-only provider shape.
  const request = payload as { messages: Array<Record<string, unknown>> };
  const wireResults = new Map<unknown, number[]>();
  request.messages.forEach((message, index) => {
    if (message.role !== 'tool') return;
    const matches = wireResults.get(message.tool_call_id) ?? [];
    matches.push(index);
    wireResults.set(message.tool_call_id, matches);
  });
  const visibleResults = new Map(messages
    .filter((message) => message.role === 'toolResult')
    .map((message) => [message.toolCallId, message]));
  for (const item of history.evidence) {
    if (item.protectedReason || retired.has(item.id)) continue;
    const visible = visibleResults.get(item.result.toolCallId);
    const matches = wireResults.get(item.result.toolCallId);
    if (!visible || matches?.length !== 1) {
      throw new Error(`Cannot map evidence to a unique provider tool result: ${item.id}`);
    }
    const messageIndex = matches[0]!;
    const wire = request.messages[messageIndex]!;
    const text = visible.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const expected = sanitizeSurrogates(text || '(no tool output)');
    if (wire.content !== expected) throw new Error(`Provider tool result differs from the selected view: ${item.id}`);
    const stub = retirementText(item);
    const saving = Buffer.byteLength(JSON.stringify(expected), 'utf8') - Buffer.byteLength(JSON.stringify(stub), 'utf8');
    if (saving > 0) candidates.push({ evidence: item, text: expected, stub, saving, messageIndex });
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
