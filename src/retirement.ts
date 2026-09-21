import { Buffer } from 'node:buffer';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { sanitizeSurrogates } from '@earendil-works/pi-ai/utils/sanitize-unicode';
import { measureRequest, type RequestBudget } from './budget.ts';
import { retirementText, validateSelection, type HistoryView } from './history.ts';

/** Oldest-first retirement at the text-only OpenAI Completions payload boundary. */
export function retireOldest(
  payload: unknown,
  messages: AgentMessage[],
  history: HistoryView,
  model: Model<Api>,
  budget: RequestBudget,
) {
  const before = measureRequest(payload, model, budget);
  const retired = new Set(validateSelection(history, history.retiredIds));
  if (before.fits) return { payload, retiredIds: [...retired], budget: before };

  // measureRequest validated the shape. Keep failed proposals out of the original payload.
  const proposed = structuredClone(payload) as { messages: Array<Record<string, unknown>> };
  const wireResults = new Map<unknown, Array<Record<string, unknown>>>();
  for (const message of proposed.messages) {
    if (message.role !== 'tool') continue;
    const matches = wireResults.get(message.tool_call_id) ?? [];
    matches.push(message);
    wireResults.set(message.tool_call_id, matches);
  }
  const visibleResults = new Map(messages
    .filter((message) => message.role === 'toolResult')
    .map((message) => [message.toolCallId, message]));
  let remaining = before.inputEstimate + before.outputReserve + before.marginTokens - before.contextLimit;
  for (const item of history.evidence) {
    if (item.protectedReason || retired.has(item.id)) continue;
    const visible = visibleResults.get(item.result.toolCallId);
    const matches = wireResults.get(item.result.toolCallId);
    if (!visible || matches?.length !== 1) {
      throw new Error(`Cannot map evidence to a unique provider tool result: ${item.id}`);
    }
    const wire = matches[0]!;
    const text = visible.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const expected = sanitizeSurrogates(text || '(no tool output)');
    if (wire.content !== expected) throw new Error(`Provider tool result differs from the selected view: ${item.id}`);
    const stub = retirementText(item);
    const saving = Buffer.byteLength(JSON.stringify(expected), 'utf8') - Buffer.byteLength(JSON.stringify(stub), 'utf8');
    if (saving <= 0) continue;
    wire.content = stub;
    retired.add(item.id);
    remaining -= saving;
    if (remaining <= 0) break;
  }
  const measurement = measureRequest(proposed, model, budget);
  return { payload: proposed, retiredIds: validateSelection(history, [...retired]), budget: measurement };
}
