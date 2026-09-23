import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext, ExtensionFactory, SessionManager } from '@earendil-works/pi-coding-agent';
import { measureRequest, type BudgetMeasurement, type RequestBudget } from './budget.ts';
import { applyRetirement, prepareRetirement } from './retirement.ts';
import { retrieveArchive, RETRIEVAL_VERSION } from './retrieval.ts';
import { applySelection, prepareSelection, selectionEvents, validateSelectionConfig, type SelectionConfig } from './selection.ts';
import { prepareJevRequest } from './judge-state.ts';
import { evaluateJev, JevError, JEV_ENDPOINT, JEV_MODEL, JEV_PRICE, JEV_PROMPT_VERSION, validateJevConfig, type JevConfig } from './jev.ts';
import {
  buildView, commitSelection, readHistory, validateSelection,
  type HistoryView,
} from './history.ts';

export const STOP_ENTRY = 'jev-context/stop';
export const USAGE_ENTRY = 'jev-context/usage';
export const JUDGE_START_ENTRY = 'jev-context/judge-start';
export const JUDGE_RESULT_ENTRY = 'jev-context/judge-result';

export type ContextOptions = { budget: RequestBudget } & (
  | { policy: 'oldest-first-v1'; select?: never }
  | { policy: 'jev-v1'; jev: JevConfig; select?: never }
  | { policy: 'jev-select-v1'; jev: JevConfig; selection: SelectionConfig; select?: never }
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
  selection?: string[];
  view?: { history: HistoryView; messages: AgentMessage[]; originals: AgentMessage[] };
  reconsideration?: {
    events: ReturnType<typeof selectionEvents>;
    retrieval: { version: string; limit: number; poolSize: number; matchedCount: number; candidateIds: string[] } | null;
    restoreAtOrAbove: number;
    restoredIds?: string[];
    proposedRetiredIds?: string[];
  };
  budget?: BudgetMeasurement;
  stopped: boolean;
  cancelled: boolean;
  responseReceived: boolean;
}

/** Explicitly loaded by the isolated SDK harness, not installed in the user's Pi. */
export function createContextExtension(manager: SessionManager, options: ContextOptions): ExtensionFactory {
  if (options.policy !== 'oldest-first-v1' && options.policy !== 'scripted-v1' && options.policy !== 'jev-v1' && options.policy !== 'jev-select-v1') {
    throw new Error('Unsupported selection policy');
  }
  if (options.policy !== 'scripted-v1' && options.select !== undefined) {
    throw new Error('Automatic retirement cannot use a scripted selector');
  }
  if (options.policy === 'jev-v1' || options.policy === 'jev-select-v1') validateJevConfig(options.jev);
  if (options.policy === 'jev-select-v1') validateSelectionConfig(options.selection, options.jev.retireBelow);
  return (pi) => {
    let attempt: Attempt | undefined;
    let writeFailed = false;

    function sameBranch(ctx: ExtensionContext, current: Attempt): boolean {
      return ctx.sessionManager === manager && manager.getSessionId() === current.sessionId &&
        manager.getLeafId() === current.leafId;
    }

    function stop(ctx: ExtensionContext, current: Attempt, reason: string, kind?: 'judge') {
      current.stopped = true;
      current.cancelled = ctx.signal?.aborted ?? false;
      ctx.abort();
      if (!writeFailed && sameBranch(ctx, current)) {
        pi.appendEntry(STOP_ENTRY, {
          version: 1, requestId: current.id, reason,
          kind: current.cancelled ? 'cancelled' : kind ?? (current.budget?.fits === false ? 'budget' : 'invalid'),
          budget: current.budget ?? null,
          ...(current.reconsideration && { reconsideration: current.reconsideration }),
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
        if (writeFailed) throw new Error('Session writes failed; reopen a complete session branch before continuing');
        if (!sameBranch(ctx, current)) throw new Error('Context extension is bound to a different session manager');
        signal.throwIfAborted();
        const history = readHistory(structuredClone(ctx.sessionManager.getBranch()), event.messages);
        const proposed = options.policy === 'scripted-v1' && options.select
          ? await options.select(structuredClone(history), signal) : null;
        signal.throwIfAborted();
        if (!sameBranch(ctx, current)) throw new Error('Session branch changed during selection');
        const retiredIds = validateSelection(history, proposed ?? history.retiredIds);
        if (proposed !== null && (history.lastSelection?.policy !== options.policy ||
            JSON.stringify(retiredIds) !== JSON.stringify([...history.retiredIds].sort()))) {
          current.selection = retiredIds;
        }
        const messages = current.selection ? buildView(event.messages, history, retiredIds) : event.messages;
        current.view = { history, messages, originals: event.messages };
        return { messages };
      } catch (error) {
        stop(ctx, current, error instanceof Error ? error.message : String(error));
        return { messages: event.messages };
      }
    });

    pi.on('before_provider_request', async (event, ctx) => {
      const current = attempt;
      if (!current) {
        ctx.abort();
        throw new Error('Missing context-selection attempt');
      }
      if (current.stopped) { ctx.abort(); return; }
      try {
        const signal = ctx.signal;
        if (!signal) throw new Error('Provider request requires an active run');
        signal.throwIfAborted();
        if (!sameBranch(ctx, current)) throw new Error('Session branch changed before provider request');
        if (!ctx.model) throw new Error('Missing model');
        let payload = event.payload;
        if (options.policy !== 'scripted-v1') {
          if (!current.view) throw new Error('Missing context view');
          const { history, messages, originals } = current.view;
          let selectionPlan;
          let checkpoint = false;
          if (options.policy === 'jev-select-v1') {
            const events = selectionEvents(ctx.sessionManager.getBranch(), history);
            const due = history.retiredIds.length > 0 && (events.userIds.length > 0 || events.exchangeIds.length > 0);
            const lookup = due ? retrieveArchive(history, originals, options.selection.archiveLimit) : null;
            selectionPlan = prepareSelection(payload, messages, history, ctx.model, options.budget,
              lookup?.candidates.map((item) => item.evidence.id) ?? []);
            checkpoint = due || !selectionPlan.before.fits;
            if (checkpoint) current.reconsideration = {
              events, restoreAtOrAbove: options.selection.restoreAtOrAbove,
              retrieval: lookup ? { version: RETRIEVAL_VERSION, limit: options.selection.archiveLimit,
                poolSize: lookup.poolSize, matchedCount: lookup.matchedCount,
                candidateIds: lookup.candidates.map((item) => item.evidence.id) } : null,
            };
          }
          const plan = selectionPlan ?? prepareRetirement(payload, messages, history, ctx.model, options.budget);
          current.budget = plan.before;
          let order = plan.candidates.map((candidate) => candidate.evidence.id);
          let relevance: Record<string, number> = {};
          if ((options.policy === 'jev-v1' || options.policy === 'jev-select-v1') && order.length) {
            const prepared = prepareJevRequest(plan, messages);
            pi.appendEntry(JUDGE_START_ENTRY, {
              version: 1, requestId: current.id, sourceLeafId: current.leafId,
              policy: options.policy, model: JEV_MODEL, promptVersion: JEV_PROMPT_VERSION,
              endpoint: options.jev.endpoint ?? JEV_ENDPOINT,
              candidateIds: order, retireBelow: options.jev.retireBelow, timeoutMs: options.jev.timeoutMs,
              requestBytes: prepared.requestBytes, maxPairBytes: prepared.maxPairBytes,
              requestHash: prepared.requestHash, priceSchedule: JEV_PRICE,
              ...(current.reconsideration && { reconsideration: current.reconsideration }),
            });
            current.leafId = ctx.sessionManager.getLeafId();
            const judged = await evaluateJev(prepared.request, options.jev, signal);
            if (!sameBranch(ctx, current)) throw new Error('Session branch changed during Jev evaluation');
            pi.appendEntry(JUDGE_RESULT_ENTRY, { version: 1, requestId: current.id, ...judged });
            current.leafId = ctx.sessionManager.getLeafId();
            signal.throwIfAborted();
            if (judged.outcome !== 'ok' || !judged.relevance) {
              throw new JevError(`Jev evaluation failed (${judged.outcome})`);
            }
            relevance = judged.relevance;
            order = order.filter((id) => relevance[id]! < options.jev.retireBelow)
              .sort((a, b) => relevance[a]! - relevance[b]!);
          }
          const proposal = selectionPlan && options.policy === 'jev-select-v1'
            ? applySelection(selectionPlan, relevance, options.jev.retireBelow, options.selection.restoreAtOrAbove, ctx.model, options.budget)
            : { ...applyRetirement(plan, order, ctx.model, options.budget), restoredIds: [] };
          payload = proposal.payload;
          current.budget = proposal.budget;
          if (current.reconsideration) {
            current.reconsideration = { ...current.reconsideration,
              restoredIds: proposal.restoredIds, proposedRetiredIds: proposal.retiredIds,
            };
          }
          if (checkpoint || JSON.stringify([...proposal.retiredIds].sort()) !== JSON.stringify([...history.retiredIds].sort())) {
            current.selection = proposal.retiredIds;
          }
        } else {
          current.budget = measureRequest(payload, ctx.model, options.budget);
        }
        if (!current.budget.fits) throw new Error('Selected request exceeds the context budget');
        if (current.selection) {
          try {
            commitSelection(manager, current.selection, options.policy, current.reconsideration);
          } catch (error) {
            writeFailed = true;
            throw error;
          }
          current.leafId = manager.getLeafId();
        }
        return payload;
      } catch (error) {
        stop(ctx, current, error instanceof Error ? error.message : String(error), error instanceof JevError ? 'judge' : undefined);
      }
    });

    pi.on('after_provider_response', () => {
      if (attempt) attempt.responseReceived = true;
    });

    pi.on('message_end', (event, ctx) => {
      if (event.message.role !== 'assistant' || !attempt) return;
      const current = attempt;
      attempt = undefined;
      if (writeFailed || !sameBranch(ctx, current)) return;
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
