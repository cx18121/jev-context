import { createHash, randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model, Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext, ExtensionFactory, SessionManager } from '@earendil-works/pi-coding-agent';
import { measureRequest, type BudgetMeasurement, type RequestBudget } from './budget.ts';
import { applyRetirement, prepareRetirement } from './retirement.ts';
import { retrieveArchive, RETRIEVAL_VERSION } from './retrieval.ts';
import { applySelection, prepareSelection, selectionEvents, validateSelectionConfig, type SelectionConfig } from './selection.ts';
import { JevInputLimitError, prepareJevRequest } from './judge-state.ts';
import { mapProviderEvidence } from './provider-view.ts';
import { createUsageAnchor, type UsageAnchor, type WorkingMeasurement } from './working-context.ts';
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
  workingContext?: (BudgetMeasurement | WorkingMeasurement) & { configuredLimit: number | null };
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
    workingContext?: UsageRecord['workingContext'];
    deferral?: {
      reason: 'pair-cap' | 'batch-cap' | 'accounted-judge-failure';
      unjudgedCandidateIds: string[];
      input?: JevInputLimitError['input'];
    };
  };
  budget?: BudgetMeasurement;
  workingContext?: UsageRecord['workingContext'];
  sent?: { payload: unknown; model: Model<Api> };
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
  if (options.policy === 'jev-select-v1') validateSelectionConfig(options.selection, options.jev.retireBelow, options.budget);
  return (pi) => {
    let attempt: Attempt | undefined;
    let writeFailed = false;
    let anchor: { usage: UsageAnchor; sessionId: string; leafId: string | null; assistantHash: string } | undefined;
    const assistantHash = (message: AssistantMessage) => createHash('sha256').update(JSON.stringify(message)).digest('hex');

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
          ...(current.workingContext && { workingContext: current.workingContext }),
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
        const branch = ctx.sessionManager.getBranch();
        if (anchor) {
          const index = branch.findIndex((entry) => entry.id === anchor!.leafId);
          const responses = branch.slice(index + 1).flatMap((entry) =>
            entry.type === 'message' && entry.message.role === 'assistant' ? [entry.message] : []);
          if (anchor.sessionId !== current.sessionId || index < 0 || responses.length !== 1 ||
              assistantHash(responses[0]!) !== anchor.assistantHash) anchor = undefined;
        }
        const history = readHistory(structuredClone(branch), event.messages);
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
        if (ctx.model.api === 'openai-codex-responses') {
          if (!current.view) throw new Error('Missing context view');
          mapProviderEvidence(payload, current.view.messages, current.view.history.evidence, ctx.model);
        }
        if (options.policy !== 'scripted-v1') {
          if (!current.view) throw new Error('Missing context view');
          const { history, messages, originals } = current.view;
          let selectionPlan;
          let checkpoint = false;
          if (options.policy === 'jev-select-v1') {
            const events = selectionEvents(ctx.sessionManager.getBranch(), history);
            const fresh = events.userIds.length > 0 || events.exchangeIds.length > 0;
            const due = history.retiredIds.length > 0 && fresh;
            const lookup = due ? retrieveArchive(history, originals, options.selection.archiveLimit) : null;
            selectionPlan = prepareSelection(payload, messages, history, ctx.model, options.budget,
              lookup?.candidates.map((item) => item.evidence.id) ?? [],
              { ...options.selection, reconsider: fresh, anchor: anchor?.usage });
            current.workingContext = { ...selectionPlan.workingBefore,
              configuredLimit: options.selection.workingContextLimit ?? null };
            checkpoint = due || !selectionPlan.before.fits || (fresh && selectionPlan.workingBefore.fits === false);
            if (checkpoint) current.reconsideration = {
              events, restoreAtOrAbove: options.selection.restoreAtOrAbove,
              workingContext: current.workingContext,
              retrieval: lookup ? { version: RETRIEVAL_VERSION, limit: options.selection.archiveLimit,
                poolSize: lookup.poolSize, matchedCount: lookup.matchedCount,
                candidateIds: lookup.candidates.map((item) => item.evidence.id) } : null,
            };
          }
          const plan = selectionPlan ?? prepareRetirement(payload, messages, history, ctx.model, options.budget);
          current.budget = plan.before;
          let order = plan.candidates.map((candidate) => candidate.evidence.id);
          let relevance: Record<string, number> = {};
          let deferral: NonNullable<Attempt['reconsideration']>['deferral'];
          if ((options.policy === 'jev-v1' || options.policy === 'jev-select-v1') && order.length) {
            let prepared: ReturnType<typeof prepareJevRequest> | undefined;
            try {
              prepared = prepareJevRequest(plan, messages, ctx.model.api);
            } catch (error) {
              if (!(error instanceof JevInputLimitError) || options.policy !== 'jev-select-v1' || !plan.before.fits) throw error;
              deferral = { reason: error.reason, input: error.input, unjudgedCandidateIds: order };
            }
            if (prepared) {
              pi.appendEntry(JUDGE_START_ENTRY, {
                version: 1, requestId: current.id, sourceLeafId: current.leafId,
                policy: options.policy, model: JEV_MODEL, promptVersion: JEV_PROMPT_VERSION, stateProviderApi: ctx.model.api,
                endpoint: options.jev.endpoint ?? JEV_ENDPOINT,
                candidateIds: order, retireBelow: options.jev.retireBelow, timeoutMs: options.jev.timeoutMs,
                requestBytes: prepared.requestBytes, maxPairBytes: prepared.maxPairBytes, stateBytes: prepared.stateBytes,
                omittedObservations: prepared.omittedObservations,
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
                if (options.policy !== 'jev-select-v1' || !plan.before.fits || judged.pricedCostUsd === null || judged.outcome === 'cancelled') {
                  throw new JevError(`Jev evaluation failed (${judged.outcome})`);
                }
                deferral = { reason: 'accounted-judge-failure', unjudgedCandidateIds: order };
              } else {
                relevance = judged.relevance;
                order = order.filter((id) => relevance[id]! < options.jev.retireBelow)
                  .sort((a, b) => relevance[a]! - relevance[b]!);
              }
            }
          }
          const proposal = deferral
            ? { payload, budget: plan.before, retiredIds: history.retiredIds, restoredIds: [], workingBudget: selectionPlan?.workingBefore }
            : selectionPlan && options.policy === 'jev-select-v1'
              ? applySelection(selectionPlan, relevance, options.jev.retireBelow, options.selection.restoreAtOrAbove, ctx.model, options.budget)
              : { ...applyRetirement(plan, order, ctx.model, options.budget), restoredIds: [], workingBudget: undefined };
          if (proposal.workingBudget && options.policy === 'jev-select-v1') {
            current.workingContext = { ...proposal.workingBudget, configuredLimit: options.selection.workingContextLimit ?? null };
          }
          payload = proposal.payload;
          current.budget = proposal.budget;
          if (current.reconsideration) {
            current.reconsideration = { ...current.reconsideration,
              restoredIds: proposal.restoredIds, proposedRetiredIds: proposal.retiredIds,
              workingContext: current.workingContext,
              ...(deferral && { deferral }),
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
        if (options.policy === 'jev-select-v1' && options.selection.workingContextLimit !== undefined) {
          current.sent = { payload: structuredClone(payload), model: ctx.model };
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
      anchor = undefined;
      if (writeFailed || !sameBranch(ctx, current)) return;
      const message = event.message;
      pi.appendEntry(USAGE_ENTRY, {
        version: 1, requestId: current.id,
        provider: message.provider, model: message.model,
        stopReason: message.stopReason, managerStopped: current.stopped && !current.cancelled,
        cancelled: current.cancelled || (ctx.signal?.aborted === true && !current.stopped),
        responseReceived: current.responseReceived,
        budget: current.budget ?? null,
        ...(current.workingContext && { workingContext: current.workingContext }),
        usageSource: 'pi-normalized',
        usageAvailable: Object.values({
          input: message.usage.input, output: message.usage.output,
          cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite,
        }).some((value) => value > 0),
        usage: structuredClone(message.usage),
      } satisfies UsageRecord);
      if (current.sent && !current.stopped && !ctx.signal?.aborted && current.responseReceived &&
          (message.stopReason === 'stop' || message.stopReason === 'toolUse') &&
          message.provider === current.sent.model.provider && message.model === current.sent.model.id && message.api === current.sent.model.api) {
        const usage = createUsageAnchor(current.sent.payload, current.sent.model, message.usage, current.id);
        if (usage) anchor = { usage, sessionId: current.sessionId, leafId: manager.getLeafId(), assistantHash: assistantHash(message) };
      }
    });
  };
}
