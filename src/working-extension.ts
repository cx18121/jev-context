import { createHash, randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model, Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext, ExtensionFactory, SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import type { CapacityLimits, CapacityMeasurement } from './budget.ts';
import { commitSelection, readHistory, SELECTION_ENTRY, type HistoryView } from './history.ts';
import { rankJev, validateJevConnection, type JevConnection } from './jev.ts';
import { collectRanking, planRanking, type RankingCandidate, type RankingLimits } from './ranking.ts';
import { exploreArchive, type ArchiveCursor } from './retrieval.ts';
import { providerInstructions } from './provider-view.ts';
import { updateSketch, type SketchResult } from './sketch-session.ts';
import { planSketchUpdate, sketchIsCurrent, validateTaskSketch, SKETCH_INSTRUCTIONS, type TaskSketch } from './task-sketch.ts';
import { INSTRUCTION_SOURCE_ENTRY, taskSources } from './task-sources.ts';
import { validateTextCompletionConfig, type TextCompletionConfig } from './text-completion.ts';
import { createUsageAnchor, type UsageAnchor } from './working-context.ts';
import { prepareWorkingSetView } from './working-set-view.ts';
import { underPressure, validateWorkingSetTarget, type WorkingSetOrder, type WorkingSetTarget } from './working-set.ts';

export const WORKING_POLICY = 'working-set-v1';
export const SKETCH_ENTRY = 'jev-context/sketch';
export const STOP_ENTRY = 'jev-context/stop';
export const USAGE_ENTRY = 'jev-context/usage';
export const DEFERRAL_ENTRY = 'jev-context/deferral';

export interface UsageRecord {
  version: 1;
  policy: typeof WORKING_POLICY;
  requestId: string;
  provider: string;
  model: string;
  stopReason: AssistantMessage['stopReason'];
  managerStopped: boolean;
  cancelled: boolean;
  responseReceived: boolean;
  capacity: CapacityMeasurement | null;
  usageAvailable: boolean;
  usageSource: 'pi-normalized';
  usage: Usage;
}
export const INFERENCE_START_ENTRY = 'jev-context/inference-start';
export const INFERENCE_RESULT_ENTRY = 'jev-context/inference-result';

export interface WorkingContextOptions {
  capacity: CapacityLimits;
  target: WorkingSetTarget;
  ranking: RankingLimits;
  sketch: TextCompletionConfig & { maxUpdates: number };
  order: { kind: 'jev'; connection: JevConnection } | { kind: 'capture-order' };
  archiveLimit: number;
  decisionTimeoutMs: number;
}

interface DecisionEvents { userId: string | null; focusHash: string }
interface Checkpoint extends DecisionEvents { archiveCursor?: ArchiveCursor }
interface Attempt {
  id: string;
  sessionId: string;
  leafId: string | null;
  view?: { history: HistoryView; messages: AgentMessage[] };
  measured?: CapacityMeasurement;
  sent?: { payload: unknown; model: Model<Api> };
  stopped: boolean;
  cancelled: boolean;
  responseReceived: boolean;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
class IncompleteSelection extends Error {}

/** Inference journals are branch-owned, including the pre-migration brief and judge journals. */
function assertAccounted(branch: SessionEntry[]) {
  const pending = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== 'custom') continue;
    const kind = entry.customType;
    if (![INFERENCE_START_ENTRY, INFERENCE_RESULT_ENTRY, 'jev-context/brief-start', 'jev-context/brief-result',
      'jev-context/judge-start', 'jev-context/judge-result'].includes(kind)) continue;
    const data = entry.data as Record<string, unknown>;
    const key = kind.startsWith('jev-context/inference-') ? `inference:${data.operationId}`
      : kind.startsWith('jev-context/brief-') ? `brief:${data.updateId}` : `judge:${data.requestId}:${data.batchIndex ?? 0}`;
    if (kind.endsWith('-start')) {
      if (pending.has(key)) throw new Error('Duplicate inference start');
      pending.add(key);
    } else {
      if (!pending.delete(key) || typeof data.pricedCostUsd !== 'number' || !Number.isFinite(data.pricedCostUsd) || data.pricedCostUsd < 0) {
        throw new Error('Previous inference has unknown cost; further inference is stopped');
      }
    }
  }
  if (pending.size) throw new Error('Previous inference has unknown cost; further inference is stopped');
}

function checkpoint(branch: SessionEntry[]): Checkpoint | undefined {
  const entry = branch.findLast((item) => item.type === 'custom' && item.customType === SELECTION_ENTRY &&
    (item.data as { policy?: unknown })?.policy === WORKING_POLICY);
  if (entry?.type !== 'custom') return;
  const value = (entry.data as { reconsideration?: { events?: Checkpoint } }).reconsideration?.events;
  if (!value || !(value.userId === null || typeof value.userId === 'string') || typeof value.focusHash !== 'string') {
    throw new Error('Invalid working-set checkpoint');
  }
  return value;
}

/**
 * Restoration must be earned. Jev archives return only above their level when last displaced by a
 * rebalance. The capture-order control cannot judge standing, so it holds back the latest rebalance's
 * displacements instead.
 */
function retirements(branch: SessionEntry[]) {
  const levels = new Map<string, number>();
  let latest: string[] = [];
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== SELECTION_ENTRY || (entry.data as { policy?: unknown })?.policy !== WORKING_POLICY) continue;
    const decision = (entry.data as { reconsideration?: { mode?: unknown; selection?: { displacedIds?: unknown }; retiredLevels?: unknown } }).reconsideration;
    if (decision?.mode !== 'rebalance' || !decision.selection) continue;
    const displaced = decision.selection.displacedIds, recorded = decision.retiredLevels ?? {};
    if (!Array.isArray(displaced) || displaced.some((id) => typeof id !== 'string') || typeof recorded !== 'object' || recorded === null) {
      throw new Error('Invalid working-set retirement record');
    }
    latest = displaced;
    for (const id of displaced) {
      const level = (recorded as Record<string, unknown>)[id];
      if (level === undefined) { levels.delete(id); continue; }
      if (!Number.isInteger(level) || (level as number) < 0 || (level as number) > 4) throw new Error('Invalid working-set retirement record');
      levels.set(id, level as number);
    }
  }
  return { levels, latest: new Set(latest) };
}

function activity(history: HistoryView) {
  const latest = new Set(history.newestExchangeIds);
  const full = JSON.stringify(history.evidence.filter((item) => latest.has(item.id)).map((item) => ({
    tool: item.call.name, arguments: item.call.arguments, error: item.result.isError,
    ...(item.result.isError && { errorText: item.result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') }),
  }))).toWellFormed();
  // This is an explicitly partial retrieval hint, never an authority source or coding view.
  const bytes = Buffer.from(full);
  const text = bytes.length <= 3800 ? full : bytes.subarray(0, 3797).toString('utf8').toWellFormed();
  return { focusHash: hash(full), recent: { text, truncated: bytes.length > 3800, originalBytes: bytes.length } };
}

export function createWorkingContextExtension(manager: SessionManager, options: WorkingContextOptions): ExtensionFactory {
  validateTextCompletionConfig(options.sketch);
  if (options.order.kind === 'jev') {
    validateJevConnection(options.order.connection);
    if (options.ranking.requestTimeoutMs !== options.order.connection.timeoutMs) throw new Error('Ranking reservation must use the actual Jev timeout');
  }
  validateWorkingSetTarget(options.target, options.capacity.contextLimit);
  for (const value of [options.archiveLimit, options.decisionTimeoutMs, options.sketch.maxUpdates]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid working-set decision bounds');
  }
  planRanking({ taskSketch: '', recentActivity: null }, [], [], options.ranking);
  return (pi) => {
    let attempt: Attempt | undefined;
    let writeFailed = false;
    let anchor: { usage: UsageAnchor; sessionId: string; leafId: string | null; assistantHash: string } | undefined;
    const sameBranch = (ctx: ExtensionContext, current: Attempt) => ctx.sessionManager === manager &&
      manager.getSessionId() === current.sessionId && manager.getLeafId() === current.leafId;
    function append(ctx: ExtensionContext, current: Attempt, kind: string, data: unknown) {
      if (writeFailed || !sameBranch(ctx, current)) throw new Error('Session branch changed or writes failed');
      try { pi.appendEntry(kind, data); }
      catch (error) { writeFailed = true; throw error; }
      current.leafId = manager.getLeafId();
    }
    function stop(ctx: ExtensionContext, current: Attempt, error: unknown, kind = 'invalid') {
      current.stopped = true;
      current.cancelled = ctx.signal?.aborted ?? false;
      ctx.abort();
      const reason = error instanceof Error ? error.message : String(error);
      if (!writeFailed && sameBranch(ctx, current)) append(ctx, current, STOP_ENTRY, {
        version: 1, policy: WORKING_POLICY, requestId: current.id, kind: current.cancelled ? 'cancelled' : kind, reason, capacity: current.measured ?? null,
      });
      if (!current.cancelled) ctx.ui.notify(`jev-context stopped: ${reason}`, 'error');
    }
    function commit(ctx: ExtensionContext, current: Attempt, retiredIds: string[], data: Record<string, unknown>) {
      if (!sameBranch(ctx, current)) throw new Error('Session branch changed before selection commit');
      try { commitSelection(manager, retiredIds, WORKING_POLICY, { ...data, order: options.order.kind }); }
      catch (error) { writeFailed = true; throw error; }
      current.leafId = manager.getLeafId();
    }

    async function refreshSketch(ctx: ExtensionContext, current: Attempt, payload: unknown, check: () => void, deadline: number): Promise<TaskSketch> {
      const instructions = JSON.stringify(providerInstructions(payload, ctx.model!.api));
      const instruction = manager.getBranch().findLast((entry) => entry.type === 'custom' && entry.customType === INSTRUCTION_SOURCE_ENTRY);
      if (instruction?.type !== 'custom' || (instruction.data as { text?: unknown })?.text !== instructions) {
        append(ctx, current, INSTRUCTION_SOURCE_ENTRY, { version: 1, text: instructions });
      }
      for (let step = 0; step <= options.sketch.maxUpdates; step++) {
        check();
        const branch = manager.getBranch(), sources = taskSources(branch);
        const entry = branch.findLast((item) => item.type === 'custom' && item.customType === SKETCH_ENTRY);
        let previous: TaskSketch | null;
        let plan;
        try {
          previous = entry?.type === 'custom' ? validateTaskSketch(entry.data, sources) : null;
          plan = planSketchUpdate(sources, previous);
        } catch { throw new Error('Invalid persisted task sketch'); }
        if (!plan && previous) return previous;
        if (!plan || step === options.sketch.maxUpdates) break;
        const inputHash = hash({ instructions: SKETCH_INSTRUCTIONS, plan, model: options.sketch.model, maxTokens: options.sketch.maxTokens });
        const rejected = branch.some((item) => item.type === 'custom' && item.customType === INFERENCE_RESULT_ENTRY &&
          (item.data as { inputHash?: string }).inputHash === inputHash &&
          (item.data as SketchResult).outcome === 'invalid' && (item.data as SketchResult).completionInvoked !== false);
        if (rejected) throw new IncompleteSelection('Identical task sketch update was already rejected');
        const timeoutMs = Math.min(options.sketch.timeoutMs, Math.floor(deadline - performance.now()));
        if (timeoutMs < 1) throw new IncompleteSelection('Working-set decision deadline exceeded');
        const operationId = randomUUID();
        append(ctx, current, INFERENCE_START_ENTRY, { version: 1, operationId, requestId: current.id, kind: 'sketch', inputHash });
        const result = await updateSketch(plan, sources, { ...options.sketch, timeoutMs },
          options.sketch.complete ?? ((model, context, config) => ctx.modelRegistry.streamSimple(model, context, config).result()), ctx.signal!);
        append(ctx, current, INFERENCE_RESULT_ENTRY, { version: 1, operationId, requestId: current.id, kind: 'sketch', inputHash, ...result });
        if (result.pricedCostUsd === null) throw new Error('Task sketch has unknown cost');
        check();
        if (result.outcome !== 'ok' || !result.sketch) throw new IncompleteSelection('Task sketch update failed');
        const fresh = taskSources(manager.getBranch());
        const sketch = validateTaskSketch(result.sketch, fresh);
        append(ctx, current, SKETCH_ENTRY, sketch);
        if (sketchIsCurrent(sketch, fresh)) return sketch;
      }
      throw new IncompleteSelection('Task sketch catch-up limit reached');
    }

    pi.on('session_before_compact', () => ({ cancel: true }));
    pi.on('context', (event, ctx) => {
      const current: Attempt = { id: randomUUID(), sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId(), stopped: false, cancelled: false, responseReceived: false };
      attempt = current;
      try {
        if (writeFailed) throw new Error('Session writes failed; reopen a complete branch');
        if (!sameBranch(ctx, current) || !ctx.signal) throw new Error('Invalid working-set session');
        ctx.signal.throwIfAborted();
        const branch = manager.getBranch();
        if (anchor) {
          const index = branch.findIndex((item) => item.id === anchor!.leafId);
          const responses = branch.slice(index + 1).flatMap((item) => item.type === 'message' && item.message.role === 'assistant' ? [item.message] : []);
          if (anchor.sessionId !== current.sessionId || index < 0 || responses.length !== 1 || hash(responses[0]) !== anchor.assistantHash) anchor = undefined;
        }
        current.view = { history: readHistory(structuredClone(branch), event.messages), messages: event.messages };
      } catch (error) { stop(ctx, current, error); }
      return { messages: event.messages };
    });

    pi.on('before_provider_request', async (event, ctx) => {
      const current = attempt;
      if (!current || current.stopped) { ctx.abort(); return; }
      const deadline = performance.now() + options.decisionTimeoutMs;
      const check = () => {
        ctx.signal!.throwIfAborted();
        if (!sameBranch(ctx, current)) throw new Error('Session branch changed during working-set decision');
        if (performance.now() >= deadline) throw new IncompleteSelection('Working-set decision deadline exceeded');
      };
      const send = (payload: unknown) => { current.sent = { payload: structuredClone(payload), model: ctx.model! }; return payload; };
      try {
        if (!ctx.model || !ctx.signal || !current.view) throw new Error('Missing working-set request context');
        check();
        assertAccounted(manager.getBranch());
        const { history, messages } = current.view;
        const prepare = (archiveIds: string[]) => prepareWorkingSetView(event.payload, messages, history, ctx.model!, options.capacity, archiveIds, anchor?.usage, check);
        let view = prepare([]);
        current.measured = view.before;
        validateWorkingSetTarget(options.target, view.before.contextLimit);
        if (!view.floor.admitted) {
          stop(ctx, current, 'Pinned floor exceeds admission allowance', view.floor.tokenFits ? 'transport-stop' : 'capacity-stop');
          return;
        }
        const prior = checkpoint(manager.getBranch());
        const user = manager.getBranch().findLast((item) => item.type === 'custom_message' || (item.type === 'message' && item.message.role === 'user'));
        const { focusHash, recent } = activity(history);
        const events: Checkpoint = { userId: user?.id ?? null, focusHash, ...(prior?.archiveCursor && { archiveCursor: prior.archiveCursor }) };
        const pressure = underPressure(view.before, options.target);
        const correction = history.retiredIds.length > 0 && events.userId !== prior?.userId;
        const toolChange = history.retiredIds.length > 0 && history.newestExchangeIds.length > 0 && focusHash !== prior?.focusHash;
        if (!pressure && !correction && !toolChange) return send(event.payload);
        const mode = pressure || correction ? 'rebalance' : 'restore-only';
        if (mode === 'restore-only' && view.before.totalTokens >= Math.max(options.target.lowTokens, view.floor.totalTokens)) {
          commit(ctx, current, history.retiredIds, { events, reason: 'no-restoration-room' });
          return send(event.payload);
        }
        if (!view.candidates.length && !history.retiredIds.length) {
          const selected = view.select(options.target, mode, options.order.kind === 'jev' ? { kind: 'jev', priorities: {} } : { kind: 'capture-order' });
          commit(ctx, current, history.retiredIds, { events, mode, reason: 'no-eligible-evidence', selection: selected.selection });
          return send(event.payload);
        }
        // Restore-only preflight uses existing advisory text and fresh tool focus. It must not
        // pay to refresh the sketch just to discover that none of this page's whole items fit.
        const existing = manager.getBranch().findLast((item) => item.type === 'custom' && item.customType === SKETCH_ENTRY);
        const oldSummary = existing?.type === 'custom'
          ? validateTaskSketch(existing.data, taskSources(manager.getBranch())).summary : '';
        let sketch: TaskSketch | undefined;
        if (mode === 'rebalance') sketch = await refreshSketch(ctx, current, event.payload, check, deadline);
        const query = `${sketch?.summary ?? oldSummary}\n${recent.text}`;
        const lookup = exploreArchive(history, query, options.archiveLimit, prior?.archiveCursor);
        view = prepare(lookup.candidates.map((item) => item.evidence.id));
        const retired = retirements(manager.getBranch());
        // Level 4 cannot be exceeded, so those archives are held back without paying for a judgment.
        const unearned = (id: string) => options.order.kind === 'jev' ? retired.levels.get(id) === 4 : retired.latest.has(id);
        const fitting = mode === 'restore-only' ? new Set(view.restorableIds(options.target).filter((id) => !unearned(id))) : null;
        const filteredIds = lookup.pageIds.filter((id) => fitting && !fitting.has(id));
        const retrieval = { version: lookup.version, queryTerms: lookup.queryTerms, poolSize: lookup.poolSize, matchedCount: lookup.matchedCount,
          pageIds: lookup.pageIds, wrapped: lookup.wrapped, resetReason: lookup.resetReason, filteredIds };
        if (fitting && !fitting.size) {
          commit(ctx, current, history.retiredIds, { events: { ...events, archiveCursor: lookup.nextCursor }, mode,
            reason: 'no-fitting-archive', retrieval });
          return send(event.payload);
        }
        if (fitting) view = prepare(lookup.candidates.filter((item) => fitting.has(item.evidence.id)).map((item) => item.evidence.id));
        sketch ??= await refreshSketch(ctx, current, event.payload, check, deadline);
        const candidate = (item: typeof view.candidates[number]): RankingCandidate => ({ id: item.id,
          toolCall: item.evidence.call, capturedAt: item.capturedAt, isError: item.evidence.result.isError, text: item.text });
        const residents = mode === 'rebalance' ? view.candidates.filter((item) => item.resident).map(candidate) : [];
        const byId = new Map(view.candidates.map((item) => [item.id, item]));
        const archives = lookup.candidates.flatMap((item) => { const found = byId.get(item.evidence.id); return found && !found.resident ? [candidate(found)] : []; });
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) throw new IncompleteSelection('Working-set decision deadline exceeded');
        const plan = planRanking({ taskSketch: sketch.summary, recentActivity: recent }, residents, archives,
          { ...options.ranking, maxDurationMs: Math.min(options.ranking.maxDurationMs, remaining) });
        check();
        if (plan.outcome !== 'ready') throw new IncompleteSelection('Mandatory ranking exceeds decision limits');
        let order: WorkingSetOrder = { kind: 'capture-order' };
        let heldBackIds: string[] = [];
        if (options.order.kind === 'jev') {
          const connection = options.order.connection;
          const rejectedHashes = new Set(manager.getBranch().flatMap((entry) => {
            if (entry.type !== 'custom' || entry.customType !== INFERENCE_RESULT_ENTRY) return [];
            const result = entry.data as { kind?: string; outcome?: string; requestHash?: string };
            return result.kind === 'ranking' && result.outcome === 'invalid_response' ? [result.requestHash] : [];
          }));
          if (plan.batches.some((batch) => rejectedHashes.has(batch.requestHash))) {
            throw new IncompleteSelection('Identical ranking request was already rejected');
          }
          const completed: Parameters<typeof collectRanking>[1][number][] = [];
          for (const batch of plan.batches) {
            check();
            if (deadline - performance.now() < connection.timeoutMs) throw new IncompleteSelection('Insufficient time for reserved judge request');
            const operationId = randomUUID();
            append(ctx, current, INFERENCE_START_ENTRY, { version: 1, operationId, requestId: current.id, kind: 'ranking',
              requestHash: batch.requestHash, requestBytes: batch.requestBytes, candidateIds: plan.candidateIds });
            const result = await rankJev(batch.request, connection, ctx.signal);
            append(ctx, current, INFERENCE_RESULT_ENTRY, { version: 1, operationId, requestId: current.id, kind: 'ranking', requestHash: batch.requestHash, ...result });
            if (result.pricedCostUsd === null) throw new Error('Ranking request has unknown cost');
            check();
            if (result.outcome !== 'ok') throw new IncompleteSelection(`Ranking failed (${result.outcome})`);
            completed.push({ requestHash: batch.requestHash, result });
          }
          const scores = collectRanking(plan, completed);
          if (!scores) throw new IncompleteSelection('Ranking is incomplete');
          if (mode === 'restore-only') {
            heldBackIds = archives.filter((item) => scores[item.id] && retired.levels.has(item.id) &&
              scores[item.id]!.level <= retired.levels.get(item.id)!).map((item) => item.id);
            for (const id of heldBackIds) delete scores[id];
          }
          order = { kind: 'jev', priorities: scores };
        }
        view = prepare(archives.filter((item) => plan.candidateIds.includes(item.id) && !heldBackIds.includes(item.id)).map((item) => item.id));
        const selected = view.select(options.target, mode, order);
        check();
        if (selected.selection.outcome !== 'selected') throw new IncompleteSelection('Working-set packing is incomplete');
        current.measured = selected.selection.after;
        const levels = order.kind === 'jev' ? order.priorities : null;
        commit(ctx, current, selected.retiredIds, { events: { ...events, archiveCursor: lookup.nextCursor }, mode,
          ...(mode === 'rebalance' && levels && { retiredLevels: Object.fromEntries(selected.selection.displacedIds.map((id) => [id, levels[id]!.level])) }),
          retrieval: { ...retrieval, omittedIds: plan.omittedArchiveIds, heldBackIds },
          ranking: { candidateIds: plan.candidateIds, inputByteReservation: plan.inputByteReservation, costReservationUsd: plan.costReservationUsd },
          selection: selected.selection });
        return send(selected.payload);
      } catch (error) {
        if (error instanceof IncompleteSelection && current.measured?.admitted && !ctx.signal?.aborted && sameBranch(ctx, current) && !writeFailed) {
          append(ctx, current, DEFERRAL_ENTRY, { version: 1, policy: WORKING_POLICY, requestId: current.id,
            reason: error.message, capacity: current.measured });
          return send(event.payload);
        }
        stop(ctx, current, error, error instanceof IncompleteSelection ? 'selection-incomplete' : 'invalid');
      }
    });
    pi.on('after_provider_response', () => { if (attempt) attempt.responseReceived = true; });
    pi.on('message_end', (event, ctx) => {
      if (event.message.role !== 'assistant' || !attempt) return;
      const current = attempt, message: AssistantMessage = event.message;
      attempt = undefined;
      anchor = undefined;
      if (writeFailed || !sameBranch(ctx, current)) return;
      append(ctx, current, USAGE_ENTRY, { version: 1, policy: WORKING_POLICY, requestId: current.id,
        provider: message.provider, model: message.model, stopReason: message.stopReason,
        managerStopped: current.stopped && !current.cancelled,
        cancelled: current.cancelled || (ctx.signal?.aborted === true && !current.stopped),
        responseReceived: current.responseReceived, capacity: current.measured ?? null,
        usageAvailable: [message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite].some((value) => value > 0),
        usageSource: 'pi-normalized', usage: structuredClone(message.usage) } satisfies UsageRecord);
      if (current.sent && !current.stopped && !ctx.signal?.aborted && current.responseReceived &&
          (message.stopReason === 'stop' || message.stopReason === 'toolUse') &&
          message.provider === current.sent.model.provider && message.model === current.sent.model.id && message.api === current.sent.model.api) {
        const usage = createUsageAnchor(current.sent.payload, current.sent.model, message.usage, current.id);
        if (usage) anchor = { usage, sessionId: current.sessionId, leafId: manager.getLeafId(), assistantHash: hash(message) };
      }
    });
  };
}
