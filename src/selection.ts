import { Buffer } from 'node:buffer';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { measureRequest, type RequestBudget } from './budget.ts';
import { buildView, retirementText, SELECTION_ENTRY, validateSelection, type HistoryView } from './history.ts';
import { mapProviderEvidence, providerText, replaceProviderText } from './provider-view.ts';
import { applyRetirement, type RetirementCandidate, type RetirementPlan } from './retirement.ts';

export const SELECTION_POLICY = 'jev-select-v1';
export interface SelectionConfig {
  archiveLimit: number;
  restoreAtOrAbove: number;
  /** Soft whole-request target, including output reserve and margin. Omission uses the hard limit. */
  workingContextLimit?: number;
}

export function validateSelectionConfig(config: SelectionConfig, retireBelow: number, budget: RequestBudget) {
  if (config.workingContextLimit !== undefined && (!Number.isSafeInteger(config.workingContextLimit) ||
      config.workingContextLimit <= 0 || config.workingContextLimit > budget.contextLimit)) {
    throw new Error('workingContextLimit must be a positive safe integer at most the hard context limit');
  }
  if (!Number.isSafeInteger(config.archiveLimit) || config.archiveLimit < 1) throw new Error('archiveLimit must be a positive safe integer');
  if (!Number.isFinite(config.restoreAtOrAbove) || config.restoreAtOrAbove <= retireBelow || config.restoreAtOrAbove > 1) {
    throw new Error('restoreAtOrAbove must exceed retireBelow and be at most 1');
  }
}

/** A successful no-op selection is also a branch-owned event checkpoint. */
export function selectionEvents(branch: SessionEntry[], history: HistoryView) {
  const checkpoint = history.lastSelection?.policy === SELECTION_POLICY
    ? branch.findLastIndex((entry) => entry.type === 'custom' && entry.customType === SELECTION_ENTRY) : -1;
  const newest = new Set(history.newestExchangeIds);
  const fresh = branch.slice(checkpoint + 1);
  return {
    userIds: fresh.filter((entry) => entry.type === 'message' && entry.message.role === 'user').map((entry) => entry.id),
    exchangeIds: fresh.filter((entry) => newest.has(entry.id)).map((entry) => entry.id),
  };
}

interface SelectionCandidate extends RetirementCandidate { archived: boolean }
export interface SelectionPlan extends RetirementPlan {
  candidates: SelectionCandidate[];
  workingBefore: RetirementPlan['before'];
}

/** One batch includes the archive shortlist and all shrinkable visible evidence that could make room. */
export function prepareSelection(
  payload: unknown, messages: AgentMessage[], history: HistoryView,
  model: Model<Api>, budget: RequestBudget, archiveIds: string[],
  options: Pick<SelectionConfig, 'workingContextLimit'> & { reconsider?: boolean } = {},
): SelectionPlan {
  const before = measureRequest(payload, model, budget);
  const workingContextLimit = options.workingContextLimit ?? before.contextLimit;
  if (!Number.isSafeInteger(workingContextLimit) || workingContextLimit <= 0 || workingContextLimit > before.contextLimit) {
    throw new Error('workingContextLimit must be a positive safe integer at most the effective hard context limit');
  }
  const workingBefore = measureRequest(payload, model, { ...budget, contextLimit: workingContextLimit });
  const retired = new Set(validateSelection(history, history.retiredIds));
  if (new Set(archiveIds).size !== archiveIds.length || archiveIds.some((id) => !retired.has(id))) {
    throw new Error('Invalid archive candidate selection');
  }
  if (before.fits && !archiveIds.length && (workingBefore.fits || options.reconsider === false)) {
    return { payload, history, before, workingBefore, candidates: [] };
  }
  const archive = new Set(archiveIds);
  const eligible = history.evidence.filter((item) => !item.protectedReason && (!retired.has(item.id) || archive.has(item.id)));
  // Render from preserved originals, never from the currently stubbed view.
  const restored = new Map(buildView(history.evidence.map((item) => item.result), history, [])
    .filter((message) => message.role === 'toolResult').map((message) => [message.toolCallId, message]));
  const candidates: SelectionCandidate[] = [];
  for (const mapped of mapProviderEvidence(payload, messages, eligible, model)) {
    const archived = archive.has(mapped.evidence.id);
    const text = archived ? providerText(restored.get(mapped.evidence.result.toolCallId)!) : mapped.text;
    const stub = retirementText(mapped.evidence);
    const saving = Buffer.byteLength(JSON.stringify(text)) - Buffer.byteLength(JSON.stringify(stub));
    if (archived || saving > 0) candidates.push({ ...mapped, text, stub, saving, archived });
  }
  return { payload, history, before, workingBefore, candidates };
}

/** Restore selected archive evidence, then retire low-rated visible evidence toward the soft target. */
export function applySelection(
  plan: SelectionPlan, relevance: Record<string, number>, retireBelow: number, restoreAtOrAbove: number,
  model: Model<Api>, budget: RequestBudget,
) {
  const keys = Object.keys(relevance);
  if (keys.length !== plan.candidates.length || plan.candidates.some((item) => {
    const score = relevance[item.evidence.id];
    return score === undefined || !Number.isFinite(score) || score < 0 || score > 1;
  })) throw new Error('Invalid selection scores');
  const restoredIds = plan.candidates.filter((item) => item.archived && relevance[item.evidence.id]! >= restoreAtOrAbove)
    .map((item) => item.evidence.id);
  const restored = new Set(restoredIds);
  const retiredIds = plan.history.retiredIds.filter((id) => !restored.has(id));
  const payload = structuredClone(plan.payload);
  for (const item of plan.candidates) {
    if (restored.has(item.evidence.id)) replaceProviderText(payload, model.api, item.messageIndex, item.text);
  }
  const visible = plan.candidates.filter((item) => !item.archived);
  const order = visible.filter((item) => relevance[item.evidence.id]! < retireBelow)
    .sort((a, b) => relevance[a.evidence.id]! - relevance[b.evidence.id]!).map((item) => item.evidence.id);
  const workingBudget = { ...budget, contextLimit: plan.workingBefore.contextLimit };
  const result = applyRetirement({ payload, history: { ...plan.history, retiredIds },
    before: measureRequest(payload, model, workingBudget), candidates: visible }, order, model, workingBudget);
  return { ...result, restoredIds, workingBudget: result.budget,
    budget: measureRequest(result.payload, model, budget) };
}
