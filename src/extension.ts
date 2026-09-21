import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { measureRequest, type BudgetMeasurement, type RequestBudget } from './budget.ts';
import { retireOldest } from './retirement.ts';
import {
  buildView, readHistory, SELECTION_ENTRY, validateSelection,
  type HistoryView, type SelectionRecord,
} from './history.ts';

export const STOP_ENTRY = 'jev-context/stop';
export const USAGE_ENTRY = 'jev-context/usage';

export type ContextOptions = { budget: RequestBudget } & (
  | { policy: 'oldest-first-v1'; select?: never }
  | {
    policy: 'scripted-v1';
    /** Integration seam. Omitted or null reuses the recorded view without a fresh decision. */
    select?: (history: HistoryView, signal: AbortSignal) => Promise<string[] | null> | string[] | null;
  }
);

export interface UsageRecord {
  version: 1;
  requestId: string;
  provider: string;
  model: string;
  stopReason: AssistantMessage['stopReason'];
  managerStopped: boolean;
  cancelled: boolean;
  responseReceived: boolean;
  budget: BudgetMeasurement | null;
  usageSource: 'pi-normalized';
  usageAvailable: boolean;
  usage: Usage;
}

interface Attempt {
  id: string;
  sessionId: string;
  leafId: string | null;
  selection?: SelectionRecord;
  view?: { history: HistoryView; messages: AgentMessage[] };
  budget?: BudgetMeasurement;
  stopped: boolean;
  cancelled: boolean;
  responseReceived: boolean;
}

/** Explicitly loaded by the isolated SDK harness, not installed in the user's Pi. */
export function createContextExtension(options: ContextOptions): ExtensionFactory {
  if (options.policy !== 'oldest-first-v1' && options.policy !== 'scripted-v1') {
    throw new Error('Unsupported selection policy');
  }
  if (options.policy === 'oldest-first-v1' && options.select !== undefined) {
    throw new Error('Oldest-first retirement cannot use a scripted selector');
  }
  return (pi) => {
    let attempt: Attempt | undefined;

    function sameBranch(ctx: ExtensionContext, current: Attempt): boolean {
      return ctx.sessionManager.getSessionId() === current.sessionId &&
        ctx.sessionManager.getLeafId() === current.leafId;
    }

    function stop(ctx: ExtensionContext, current: Attempt, reason: string) {
      current.stopped = true;
      current.cancelled = ctx.signal?.aborted ?? false;
      ctx.abort();
      if (sameBranch(ctx, current)) {
        pi.appendEntry(STOP_ENTRY, {
          version: 1, requestId: current.id, reason,
          kind: current.cancelled ? 'cancelled' : current.budget?.fits === false ? 'budget' : 'invalid',
          budget: current.budget ?? null,
        });
        current.leafId = ctx.sessionManager.getLeafId();
      }
      if (!current.cancelled) ctx.ui.notify(`jev-context stopped: ${reason}`, 'error');
    }

    pi.on('session_before_compact', () => ({ cancel: true }));

    pi.on('context', async (event, ctx) => {
      const current: Attempt = {
        id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId(), stopped: false, cancelled: false, responseReceived: false,
      };
      attempt = current;
      try {
        const signal = ctx.signal;
        if (!signal) throw new Error('Context selection requires an active run');
        signal.throwIfAborted();
        const history = readHistory(structuredClone(ctx.sessionManager.getBranch()), event.messages);
        const proposed = options.policy === 'scripted-v1' && options.select
          ? await options.select(structuredClone(history), signal) : null;
        signal.throwIfAborted();
        if (!sameBranch(ctx, current)) throw new Error('Session branch changed during selection');
        const retiredIds = validateSelection(history, proposed ?? history.retiredIds);
        if (proposed !== null && (history.lastSelection?.policy !== options.policy ||
            JSON.stringify(retiredIds) !== JSON.stringify([...history.retiredIds].sort()))) {
          current.selection = { version: 1, policy: options.policy, sourceLeafId: current.leafId, retiredIds };
        }
        const messages = buildView(event.messages, history, retiredIds);
        current.view = { history, messages };
        return { messages };
      } catch (error) {
        stop(ctx, current, error instanceof Error ? error.message : String(error));
        return { messages: event.messages };
      }
    });

    pi.on('before_provider_request', (event, ctx) => {
      const current = attempt;
      if (!current) {
        ctx.abort();
        throw new Error('Missing context-selection attempt');
      }
      if (current.stopped) { ctx.abort(); return; }
      try {
        if (ctx.signal?.aborted) throw new Error('Request cancelled');
        if (!sameBranch(ctx, current)) throw new Error('Session branch changed before provider request');
        if (!ctx.model) throw new Error('Missing model');
        let payload = event.payload;
        if (options.policy === 'oldest-first-v1') {
          if (!current.view) throw new Error('Missing context view');
          const { history, messages } = current.view;
          const proposal = retireOldest(payload, messages, history, ctx.model, options.budget);
          payload = proposal.payload;
          current.budget = proposal.budget;
          if (proposal.retiredIds.length > history.retiredIds.length) {
            current.selection = {
              version: 1, policy: options.policy, sourceLeafId: current.leafId,
              retiredIds: proposal.retiredIds,
            };
          }
        } else {
          current.budget = measureRequest(payload, ctx.model, options.budget);
        }
        if (!current.budget.fits) throw new Error('Selected request exceeds the context budget');
        if (current.selection) {
          pi.appendEntry(SELECTION_ENTRY, current.selection);
          current.leafId = ctx.sessionManager.getLeafId();
        }
        return payload;
      } catch (error) {
        stop(ctx, current, error instanceof Error ? error.message : String(error));
      }
    });

    pi.on('after_provider_response', () => {
      if (attempt) attempt.responseReceived = true;
    });

    pi.on('message_end', (event, ctx) => {
      if (event.message.role !== 'assistant' || !attempt) return;
      const current = attempt;
      attempt = undefined;
      if (!sameBranch(ctx, current)) return;
      const message = event.message;
      pi.appendEntry(USAGE_ENTRY, {
        version: 1, requestId: current.id,
        provider: message.provider, model: message.model,
        stopReason: message.stopReason, managerStopped: current.stopped && !current.cancelled,
        cancelled: current.cancelled || (ctx.signal?.aborted === true && !current.stopped),
        responseReceived: current.responseReceived,
        budget: current.budget ?? null,
        usageSource: 'pi-normalized',
        usageAvailable: Object.values({
          input: message.usage.input, output: message.usage.output,
          cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite,
        }).some((value) => value > 0),
        usage: structuredClone(message.usage),
      } satisfies UsageRecord);
    });
  };
}
