import type { AssistantMessage, ToolCall, ToolResultMessage, Usage } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';

export function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function assistant(calls: ToolCall[] = [], timestamp = 2): AssistantMessage {
  return {
    role: 'assistant', content: calls.length ? calls : [{ type: 'text', text: 'Done.' }],
    api: 'openai-completions', provider: 'jev-fixture', model: 'fixture',
    usage: zeroUsage(), stopReason: calls.length ? 'toolUse' : 'stop', timestamp,
  };
}

export function result(id: string, text: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
  return {
    role: 'toolResult', toolCallId: id, toolName: 'read',
    content: [{ type: 'text', text }], isError: false, timestamp: 3, ...overrides,
  };
}

export function appendExchange(manager: SessionManager, results: ToolResultMessage[]): string[] {
  manager.appendMessage(assistant(results.map((result) => ({
    type: 'toolCall', id: result.toolCallId, name: result.toolName, arguments: { path: `${result.toolCallId}.txt` },
  }))));
  return results.map((result) => manager.appendMessage(result));
}

export function seedHistory(manager: SessionManager) {
  manager.appendMessage({ role: 'user', content: 'Change the API and update its tests.', timestamp: 1 });
  const [oldId] = appendExchange(manager, [result('old', 'API contract\n'.repeat(150))]);
  const [recentId] = appendExchange(manager, [result('recent', 'Test environment ready.')]);
  manager.appendMessage(assistant());
  if (!oldId || !recentId) throw new Error('Missing fixture entry');
  return { oldId, recentId };
}
