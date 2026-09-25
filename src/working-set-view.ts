import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { measureCapacity, type CapacityLimits } from './budget.ts';
import { buildView, retirementText, validateSelection, type HistoryView } from './history.ts';
import { isToolOutput, mapProviderEvidence, providerText, readProviderPayload, replaceProviderText } from './provider-view.ts';
import type { UsageAnchor } from './working-context.ts';
import { packWorkingSet, type Priority, type WorkingSetItem, type WorkingSetTarget } from './working-set.ts';

/** Bind the packer's item IDs to exact provider outputs; all other request fields are immutable. */
export function prepareWorkingSetView(
  payload: unknown, messages: AgentMessage[], history: HistoryView, model: Model<Api>, limits: CapacityLimits,
  archiveIds: readonly string[], anchor?: UsageAnchor,
) {
  const retired = new Set(validateSelection(history, history.retiredIds));
  if (new Set(archiveIds).size !== archiveIds.length || archiveIds.some((id) => !retired.has(id))) {
    throw new Error('Invalid working-set archive shortlist');
  }
  const source = structuredClone(payload);
  const mapped = mapProviderEvidence(source, messages, history.evidence, model);
  if (mapped.length !== readProviderPayload(source, model.api).items.filter((item) => isToolOutput(item, model.api)).length) {
    throw new Error('Provider has unaccounted tool outputs');
  }
  const archive = new Set(archiveIds);
  const restored = new Map(buildView(history.evidence.map((item) => item.result), history, [])
    .filter((message) => message.role === 'toolResult').map((message) => [message.toolCallId, providerText(message)]));
  const candidates = mapped.flatMap((item, capturedAt) => {
    if (item.evidence.protectedReason || (retired.has(item.evidence.id) && !archive.has(item.evidence.id))) return [];
    const text = retired.has(item.evidence.id) ? restored.get(item.evidence.result.toolCallId)! : item.text;
    const stub = retirementText(item.evidence);
    // Short outputs are fixed content: replacing them must not increase the supposed minimum floor.
    if (Buffer.byteLength(JSON.stringify(text)) <= Buffer.byteLength(JSON.stringify(stub))) return [];
    return [{ ...item, id: item.evidence.id, resident: !retired.has(item.evidence.id), capturedAt, text, stub }];
  });
  const ids = new Set(candidates.map((item) => item.id));
  const render = (visibleIds: readonly string[]) => {
    if (new Set(visibleIds).size !== visibleIds.length || visibleIds.some((id) => !ids.has(id))) throw new Error('Invalid working-set view IDs');
    const visible = new Set(visibleIds), proposal = structuredClone(source);
    for (const item of candidates) replaceProviderText(proposal, model.api, item.messageIndex, visible.has(item.id) ? item.text : item.stub);
    return proposal;
  };
  const measure = (visibleIds: readonly string[]) => measureCapacity(render(visibleIds), model, limits, { anchor, messages });
  const items: WorkingSetItem[] = candidates.map(({ id, resident, capturedAt }) => ({ id, resident, capturedAt }));
  return {
    candidates, before: measure(items.filter((item) => item.resident).map((item) => item.id)), floor: measure([]),
    select(target: WorkingSetTarget, mode: 'rebalance' | 'restore-only', scores: Readonly<Record<string, Priority>>) {
      const selection = packWorkingSet(items, target, mode, scores, measure);
      if (selection.outcome !== 'selected') return { payload: structuredClone(source), retiredIds: [...retired], selection };
      const visible = new Set(selection.visibleIds), proposedRetired = new Set(retired);
      for (const item of items) {
        if (visible.has(item.id)) proposedRetired.delete(item.id);
        else proposedRetired.add(item.id);
      }
      return { payload: render(selection.visibleIds), retiredIds: validateSelection(history, [...proposedRetired]), selection };
    },
  };
}
