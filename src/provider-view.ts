import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { sanitizeSurrogates } from '@earendil-works/pi-ai/utils/sanitize-unicode';
import type { Evidence } from './history.ts';

export function providerText(result: ToolResultMessage): string {
  return sanitizeSurrogates(result.content.filter((block) => block.type === 'text')
    .map((block) => block.text).join('\n') || '(no tool output)');
}

/** Caller first validates the text-only OpenAI payload with measureRequest. */
export function mapProviderEvidence(payload: unknown, messages: AgentMessage[], evidence: Evidence[]) {
  const request = payload as { messages: Array<Record<string, unknown>> };
  const wireResults = new Map<unknown, number[]>();
  request.messages.forEach((message, index) => {
    if (message.role !== 'tool') return;
    const matches = wireResults.get(message.tool_call_id) ?? [];
    matches.push(index);
    wireResults.set(message.tool_call_id, matches);
  });
  const visibleResults = new Map(messages.filter((message) => message.role === 'toolResult')
    .map((message) => [message.toolCallId, message]));
  return evidence.map((item) => {
    const visible = visibleResults.get(item.result.toolCallId);
    const matches = wireResults.get(item.result.toolCallId);
    if (!visible || matches?.length !== 1) throw new Error(`Cannot map evidence to a unique provider tool result: ${item.id}`);
    const messageIndex = matches[0]!;
    const text = providerText(visible);
    if (request.messages[messageIndex]!.content !== text) throw new Error(`Provider tool result differs from the selected view: ${item.id}`);
    return { evidence: item, text, messageIndex };
  });
}
