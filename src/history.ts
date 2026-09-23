import { isDeepStrictEqual } from 'node:util';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { buildSessionProjection, type SessionEntry, type SessionManager } from '@earendil-works/pi-coding-agent';

export const SELECTION_ENTRY = 'jev-context/selection';

export interface SelectionRecord {
  version: 2;
  policy: string;
  sourceLeafId: string | null;
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
    record.version !== 2 || typeof record.policy !== 'string' ||
    !(record.sourceLeafId === null || typeof record.sourceLeafId === 'string') ||
    'retiredIds' in record
  ) throw new Error('Unsupported or invalid selection record');
  return {
    version: 2, policy: record.policy, sourceLeafId: record.sourceLeafId,
  };
}

/** Resolve only the active branch. Never infer evidence identity from timestamps. */
export function readHistory(branch: SessionEntry[], messages: AgentMessage[]): HistoryView {
  const results = new Map<string, { id: string; result: ToolResultMessage }>();
  const resultsById = new Map<string, { id: string; result: ToolResultMessage }>();
  const calls = new Map<string, ToolCall>();
  const historicalIds = new Set<string>();
  const retiredIds = new Set<string>();
  let lastSelection: SelectionRecord | null = null;
  const ancestors = new Set<string>();
  let previousId: string | null = null;
  let pending: { sourceLeafId: string | null } | undefined;

  for (const entry of branch) {
    if (ancestors.has(entry.id) || entry.parentId !== previousId) throw new Error('History is not a complete ordered branch');
    const checkpoint = entry.type === 'custom' && entry.customType === SELECTION_ENTRY;
    if (pending && entry.type !== 'context_edit' && !checkpoint) throw new Error('Incomplete native selection edit group');
    if (entry.type === 'context_edit') {
      pending ??= { sourceLeafId: previousId };
      const original = resultsById.get(entry.targetId);
      const call = original && calls.get(original.result.toolCallId);
      if (!original || !call || !original.result.content.every((block) => block.type === 'text')) {
        throw new Error('Unsupported native context edit target');
      }
      const item: Evidence = { ...original, call, protectedReason: null };
      if (isDeepStrictEqual(entry.replacement, { content: [{ type: 'text', text: retirementText(item) }] })) {
        retiredIds.add(item.id);
        historicalIds.add(item.id);
      } else if (historicalIds.has(item.id) && isDeepStrictEqual(entry.replacement, { content: restoredContent(item) })) {
        retiredIds.delete(item.id);
      } else throw new Error('Unsupported native context edit content');
    }
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
      const original = { id: entry.id, result };
      results.set(result.toolCallId, original);
      resultsById.set(entry.id, original);
    }
    if (entry.type === 'custom' && entry.customType === SELECTION_ENTRY) {
      const record = selectionRecord(entry.data);
      if (record.sourceLeafId !== null && !ancestors.has(record.sourceLeafId)) {
        throw new Error('Selection refers to a different branch');
      }
      if (record.sourceLeafId !== (pending ? pending.sourceLeafId : entry.parentId)) {
        throw new Error('Selection checkpoint does not follow its native edit group');
      }
      pending = undefined;
      lastSelection = record;
    }
    ancestors.add(entry.id);
    previousId = entry.id;
  }
  if (pending) throw new Error('Incomplete native selection edit group');
  const projectedResults = new Map(buildSessionProjection(branch).messages.flatMap((message) =>
    message.role === 'toolResult' ? [[message.toolCallId, message] as const] : []));

  const evidence: Evidence[] = [];
  const pendingCalls = new Map<string, ToolCall>();
  let exchange: Evidence[] = [];
  let newestExchange: string[] = [];
  const seenResults = new Set<string>();
  function finishExchange() {
    if (pendingCalls.size) {
      for (const item of exchange) item.protectedReason ??= 'incomplete-exchange';
    } else if (exchange.length) {
      newestExchange = exchange.map((item) => item.id);
    }
    pendingCalls.clear();
    exchange = [];
  }
  for (const message of messages) {
    if (message.role === 'assistant') {
      finishExchange();
      // Pi omits interrupted/error assistant messages during provider conversion.
      if (message.stopReason === 'error' || message.stopReason === 'aborted') continue;
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue;
        if (pendingCalls.has(block.id) || !isDeepStrictEqual(calls.get(block.id), block)) {
          throw new Error(`Unrecognized or changed tool call: ${block.id}`);
        }
        pendingCalls.set(block.id, block);
      }
    } else if (message.role === 'toolResult') {
      const original = results.get(message.toolCallId);
      const call = pendingCalls.get(message.toolCallId);
      if (!original || !call || seenResults.has(message.toolCallId) || call.name !== message.toolName) {
        throw new Error(`Unpaired or ambiguous tool result: ${message.toolCallId}`);
      }
      if (!isDeepStrictEqual(projectedResults.get(message.toolCallId), message)) {
        throw new Error(`Tool result was changed before context selection: ${message.toolCallId}`);
      }
      seenResults.add(message.toolCallId);
      pendingCalls.delete(message.toolCallId);
      const item: Evidence = {
        id: original.id, call, result: original.result,
        protectedReason: original.result.content.every((block) => block.type === 'text') ? null : 'non-text',
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
  const history = {
    evidence,
    newestExchangeIds: newestExchange,
    retiredIds: [...retiredIds].sort(),
    historicalIds: [...historicalIds],
    lastSelection,
  };
  validateSelection(history, history.retiredIds);
  return history;
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

function restoredContent(item: Evidence): ToolResultMessage['content'] {
  return [
    { type: 'text', text: `[jev-context: restored historical observation ${item.id}. This is the original result, not a new execution or a statement of current file contents.]` },
    ...item.result.content,
  ];
}

/** Render a transient proposal from originals. Durable views come from Pi's projection. */
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
        content: restoredContent(item),
      };
    }
    return { ...message, content: item.result.content };
  });
}

/** Synchronous completion marker, not a disk transaction. Callers must stop writing on failure. */
export function commitSelection(manager: SessionManager, retiredIds: readonly string[], policy: string, reconsideration?: unknown): string {
  const messages = manager.buildSessionProjection().messages;
  const history = readHistory(manager.getBranch(), messages);
  const proposed = buildView(messages, history, retiredIds);
  const byCall = new Map(history.evidence.map((item) => [item.result.toolCallId, item.id]));
  const edits = proposed.flatMap((message, index) => message.role === 'toolResult' &&
    !isDeepStrictEqual(message, messages[index]) ? [{ id: byCall.get(message.toolCallId)!, content: message.content }] : []);
  const sourceLeafId = manager.getLeafId();
  for (const edit of edits) manager.appendContextEdit(edit.id, { content: edit.content });
  return manager.appendCustomEntry(SELECTION_ENTRY, {
    version: 2, policy, sourceLeafId,
    ...(reconsideration !== undefined && { reconsideration }),
  } satisfies SelectionRecord & { reconsideration?: unknown });
}
