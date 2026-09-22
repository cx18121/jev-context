import { isDeepStrictEqual } from 'node:util';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export const SELECTION_ENTRY = 'jev-context/selection';

export interface SelectionRecord {
  version: 1;
  policy: string;
  sourceLeafId: string | null;
  retiredIds: string[];
}

export interface Evidence {
  id: string;
  call: ToolCall;
  result: ToolResultMessage;
  protectedReason: 'non-text' | 'newest-exchange' | 'incomplete-exchange' | null;
}

export interface HistoryView {
  evidence: Evidence[];
  newestExchangeIds: string[];
  retiredIds: string[];
  historicalIds: string[];
  lastSelection: SelectionRecord | null;
}

function selectionRecord(data: unknown): SelectionRecord {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid selection record');
  const record = data as Record<string, unknown>;
  if (
    record.version !== 1 || typeof record.policy !== 'string' ||
    !(record.sourceLeafId === null || typeof record.sourceLeafId === 'string') ||
    !Array.isArray(record.retiredIds) ||
    !record.retiredIds.every((id): id is string => typeof id === 'string') ||
    new Set(record.retiredIds).size !== record.retiredIds.length
  ) throw new Error('Unsupported or invalid selection record');
  return {
    version: 1, policy: record.policy, sourceLeafId: record.sourceLeafId,
    retiredIds: [...record.retiredIds],
  };
}

/** Resolve only the active branch. Never infer evidence identity from timestamps. */
export function readHistory(branch: SessionEntry[], messages: AgentMessage[]): HistoryView {
  const results = new Map<string, { id: string; result: ToolResultMessage }>();
  const calls = new Map<string, ToolCall>();
  const historicalIds = new Set<string>();
  let lastSelection: SelectionRecord | null = null;
  const ancestors = new Set<string>();

  for (const entry of branch) {
    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      throw new Error('Summarized histories are not supported by this prototype');
    }
    if (entry.type === 'message' && entry.message.role === 'assistant' &&
        entry.message.stopReason !== 'error' && entry.message.stopReason !== 'aborted') {
      for (const block of entry.message.content) {
        if (block.type !== 'toolCall') continue;
        if (calls.has(block.id)) throw new Error(`Ambiguous tool call identity: ${block.id}`);
        calls.set(block.id, block);
      }
    }
    if (entry.type === 'message' && entry.message.role === 'toolResult') {
      const result = entry.message;
      if (results.has(result.toolCallId)) throw new Error(`Ambiguous tool result identity: ${result.toolCallId}`);
      results.set(result.toolCallId, { id: entry.id, result });
    }
    if (entry.type === 'custom' && entry.customType === SELECTION_ENTRY) {
      const record = selectionRecord(entry.data);
      if (record.sourceLeafId !== null && !ancestors.has(record.sourceLeafId)) {
        throw new Error('Selection refers to a different branch');
      }
      const knownIds = new Set([...results.values()].map((result) => result.id));
      if (record.retiredIds.some((id) => !knownIds.has(id))) throw new Error('Selection refers to missing evidence');
      for (const id of record.retiredIds) historicalIds.add(id);
      lastSelection = record;
    }
    ancestors.add(entry.id);
  }

  const evidence: Evidence[] = [];
  const pending = new Map<string, ToolCall>();
  let exchange: Evidence[] = [];
  let newestExchange: string[] = [];
  const seenResults = new Set<string>();
  function finishExchange() {
    if (pending.size) {
      for (const item of exchange) item.protectedReason ??= 'incomplete-exchange';
    } else if (exchange.length) {
      newestExchange = exchange.map((item) => item.id);
    }
    pending.clear();
    exchange = [];
  }
  for (const message of messages) {
    if (message.role === 'assistant') {
      finishExchange();
      // Pi omits interrupted/error assistant messages during provider conversion.
      if (message.stopReason === 'error' || message.stopReason === 'aborted') continue;
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue;
        if (pending.has(block.id) || !isDeepStrictEqual(calls.get(block.id), block)) {
          throw new Error(`Unrecognized or changed tool call: ${block.id}`);
        }
        pending.set(block.id, block);
      }
    } else if (message.role === 'toolResult') {
      const original = results.get(message.toolCallId);
      const call = pending.get(message.toolCallId);
      if (!original || !call || seenResults.has(message.toolCallId) || call.name !== message.toolName) {
        throw new Error(`Unpaired or ambiguous tool result: ${message.toolCallId}`);
      }
      if (!isDeepStrictEqual(original.result, message)) {
        throw new Error(`Tool result was changed before context selection: ${message.toolCallId}`);
      }
      seenResults.add(message.toolCallId);
      pending.delete(message.toolCallId);
      const item: Evidence = {
        id: original.id, call, result: message,
        protectedReason: message.content.every((block) => block.type === 'text') ? null : 'non-text',
      };
      evidence.push(item);
      exchange.push(item);
    } else {
      finishExchange();
    }
  }
  finishExchange();
  for (const item of evidence) {
    if (newestExchange.includes(item.id) && !item.protectedReason) item.protectedReason = 'newest-exchange';
  }
  if (evidence.length !== results.size) throw new Error('Working history is missing original tool results');
  return {
    evidence,
    newestExchangeIds: newestExchange,
    retiredIds: lastSelection?.retiredIds ?? [],
    historicalIds: [...historicalIds],
    lastSelection,
  };
}

export function validateSelection(history: HistoryView, retiredIds: readonly string[]): string[] {
  const unique = new Set(retiredIds);
  if (unique.size !== retiredIds.length) throw new Error('Selection contains duplicate evidence IDs');
  for (const id of unique) {
    const item = history.evidence.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Unknown evidence: ${id}`);
    if (item.protectedReason) throw new Error(`Cannot retire protected evidence: ${id} (${item.protectedReason})`);
  }
  return [...unique].sort();
}

function truncationStatus(result: ToolResultMessage): string {
  const details: unknown = result.details;
  if (typeof details !== 'object' || details === null || !('truncation' in details)) return 'unknown';
  const truncation = details.truncation;
  if (typeof truncation !== 'object' || truncation === null || !('truncated' in truncation)) return 'unknown';
  return truncation.truncated === true ? 'yes' : truncation.truncated === false ? 'no' : 'unknown';
}

export function retirementText(item: Evidence): string {
  return `[jev-context: retired observation ${item.id}; status=${item.result.isError ? 'error' : 'success'}; truncated=${truncationStatus(item.result)}. Original preserved in session history.]`;
}

export function buildView(messages: AgentMessage[], history: HistoryView, retiredIds: readonly string[]): AgentMessage[] {
  const retired = new Set(validateSelection(history, retiredIds));
  const historical = new Set(history.historicalIds);
  const byCall = new Map(history.evidence.map((item) => [item.result.toolCallId, item]));
  return messages.map((message) => {
    if (message.role !== 'toolResult') return message;
    const item = byCall.get(message.toolCallId);
    if (!item) throw new Error(`Missing evidence identity: ${message.toolCallId}`);
    if (retired.has(item.id)) {
      return {
        ...message,
        content: [{ type: 'text', text: retirementText(item) }],
      };
    }
    if (historical.has(item.id)) {
      return {
        ...message,
        content: [
          { type: 'text', text: `[jev-context: restored historical observation ${item.id}. This is the original result, not a new execution or a statement of current file contents.]` },
          ...message.content,
        ],
      };
    }
    return message;
  });
}
