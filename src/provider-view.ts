import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model, ToolResultMessage } from '@earendil-works/pi-ai';
import { sanitizeSurrogates } from '@earendil-works/pi-ai/utils/sanitize-unicode';
import type { Evidence } from './history.ts';

export function providerText(result: ToolResultMessage): string {
  return sanitizeSurrogates(result.content.filter((block) => block.type === 'text')
    .map((block) => block.text).join('\n') || '(no tool output)');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The two supported full-request formats. Unknown and non-text input fails closed. */
export function readProviderPayload(payload: unknown, api: Api) {
  if (api !== 'openai-completions' && api !== 'openai-codex-responses') {
    throw new Error('Budget measurement currently supports only openai-completions and openai-codex-responses');
  }
  if (!record(payload)) throw new Error('Unrecognized provider payload');
  const items = api === 'openai-completions' ? payload.messages : payload.input;
  if (!Array.isArray(items) || !items.every(record)) throw new Error('Unrecognized provider messages');
  if (api === 'openai-completions') {
    for (const { content } of items) {
      if (content === null || content === undefined || typeof content === 'string') continue;
      if (!Array.isArray(content) || !content.every((block) => record(block) && block.type === 'text' && typeof block.text === 'string')) {
        throw new Error('Non-text provider content needs a supported budget estimator');
      }
    }
  } else {
    if (payload.store !== false || 'previous_response_id' in payload || typeof payload.instructions !== 'string') {
      throw new Error('Codex requires a full, stateless input body with instructions');
    }
    for (const item of items) {
      let valid = false;
      switch (item.type) {
        case 'reasoning':
          // Opaque provider-owned data. Preserve it verbatim and count its serialized bytes.
          valid = true;
          break;
        case 'function_call':
          valid = typeof item.call_id === 'string' && typeof item.name === 'string' && typeof item.arguments === 'string';
          break;
        case 'custom_tool_call':
          valid = typeof item.call_id === 'string' && typeof item.name === 'string' && typeof item.input === 'string';
          break;
        case 'function_call_output':
        case 'custom_tool_call_output':
          valid = typeof item.call_id === 'string' && typeof item.output === 'string';
          break;
        case undefined:
        case 'message':
          valid = ['system', 'developer', 'user', 'assistant'].includes(String(item.role)) &&
            (typeof item.content === 'string' || (Array.isArray(item.content) && item.content.every((block) =>
              record(block) && block.type === (item.role === 'assistant' ? 'output_text' : 'input_text') && typeof block.text === 'string')));
          break;
      }
      if (!valid) throw new Error('Unsupported or non-text Codex input item');
    }
  }
  return { request: payload, items };
}

export function providerInstructions(payload: unknown, api: Api) {
  const { request, items } = readProviderPayload(payload, api);
  return [
    ...(api === 'openai-codex-responses' ? [{ role: 'system', content: request.instructions }] : []),
    ...items.filter((item) => item.role === 'system' || item.role === 'developer')
      .map((item) => ({ role: item.role, content: item.content })),
  ];
}

function isToolOutput(item: Record<string, unknown>, api: Api) {
  return api === 'openai-completions' ? item.role === 'tool'
    : item.type === 'function_call_output' || item.type === 'custom_tool_call_output';
}

export function mapProviderEvidence(payload: unknown, messages: AgentMessage[], evidence: Evidence[], model: Model<Api>) {
  const { items } = readProviderPayload(payload, model.api);
  const codex = model.api === 'openai-codex-responses';
  if (codex && messages.some((message) => message.role === 'assistant' &&
      (message.provider !== model.provider || message.api !== model.api || message.model !== model.id))) {
    throw new Error('Codex selection requires same-model history; model switches are not supported');
  }
  const wireResults = new Map<unknown, number[]>();
  items.forEach((item, index) => {
    if (!isToolOutput(item, model.api)) return;
    const id = codex ? item.call_id : item.tool_call_id;
    const matches = wireResults.get(id) ?? [];
    matches.push(index);
    wireResults.set(id, matches);
  });
  const visibleResults = new Map(messages.filter((message) => message.role === 'toolResult')
    .map((message) => [message.toolCallId, message]));
  // Same-model Pi serialization strips only the Responses item-id suffix.
  const wireId = (id: string) => codex ? id.split('|')[0]! : id;
  if (codex && new Set([...visibleResults.keys()].map(wireId)).size !== visibleResults.size) {
    throw new Error('Ambiguous Codex tool call identity');
  }
  return evidence.map((item) => {
    const visible = visibleResults.get(item.result.toolCallId);
    const matches = wireResults.get(wireId(item.result.toolCallId));
    if (!visible || matches?.length !== 1) throw new Error(`Cannot map evidence to a unique provider tool result: ${item.id}`);
    const messageIndex = matches[0]!;
    const text = providerText(visible);
    if (items[messageIndex]![codex ? 'output' : 'content'] !== text) throw new Error(`Provider tool result differs from the selected view: ${item.id}`);
    return { evidence: item, text, messageIndex };
  });
}

/** Mutate only a mapped tool output in a caller-owned proposal. */
export function replaceProviderText(payload: unknown, api: Api, index: number, text: string) {
  const { items } = readProviderPayload(payload, api);
  const item = items[index];
  if (!item || !isToolOutput(item, api)) throw new Error('Replacement does not target a provider tool output');
  item[api === 'openai-completions' ? 'content' : 'output'] = text;
}
