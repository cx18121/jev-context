import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { truncateHead, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { measureRequest } from '../src/budget.ts';
import { buildView, readHistory, type Evidence } from '../src/history.ts';
import { mapProviderEvidence } from '../src/provider-view.ts';

export const CONTEXTBENCH_REVISION = '1436c28a8eb95496da4ea69ad458b9f8a8eb7d61';

export interface SourceSnapshot {
  /** Absolute source root and the cwd used by Pi's read tool. */
  root: string;
  cwd: string;
  revision: string;
  /** Immutable, evaluator-side base source. No gold annotations or patches. */
  files: Record<string, string>;
}
export interface LineSpan { file: string; start: number; end: number }
export type SourceMapping = { span: LineSpan; reason?: never } | { span?: never; reason: string };
export interface CapturedEvidence {
  id: string;
  toolCallId: string;
  visible: boolean;
  historical: boolean;
  mapping: SourceMapping;
}
export interface RequestCapture {
  sessionId: string;
  /** Assigned by the transport observer, not the extension's usage request ID. */
  requestId: string;
  sourceHash: string;
  payloadHash: string;
  branchIds: string[];
  evidence: CapturedEvidence[];
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function lineCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length - Number(text.endsWith('\n'));
}
function sourceHash(source: SourceSnapshot): string {
  if (!isAbsolute(source.root) || !isAbsolute(source.cwd) || !source.revision) throw new Error('Invalid source identity');
  for (const file of Object.keys(source.files)) {
    if (!file || isAbsolute(file) || relative(source.root, resolve(source.root, file)).split(sep).join('/') !== file || file === '..' || file.startsWith('../')) {
      throw new Error(`Source path must be normalized and repository-relative: ${file}`);
    }
  }
  return hash([source.root, source.cwd, source.revision, Object.entries(source.files).sort(([a], [b]) => a.localeCompare(b))]);
}

/** Maps original results only. The selected wire view is independently checked before calling this. */
function mapRead(item: Evidence, source: SourceSnapshot): SourceMapping {
  const unknown = (reason: string): SourceMapping => ({ reason });
  if (item.call.name !== 'read') return unknown('unsupported-tool');
  if (item.result.isError) return unknown('tool-error');
  if (item.result.content.length !== 1 || item.result.content[0]?.type !== 'text') return unknown('unsupported-content');
  const { path, offset = 1, limit } = item.call.arguments;
  if (typeof path !== 'string' || !Number.isSafeInteger(offset) || typeof offset !== 'number' || offset < 1 ||
      (limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1))) return unknown('invalid-read-arguments');
  const file = relative(source.root, resolve(source.cwd, path)).split(sep).join('/');
  if (!file || file === '..' || file.startsWith('../') || isAbsolute(file)) return unknown('outside-source-root');
  if (!Object.hasOwn(source.files, file)) return unknown('source-unavailable');
  const text = source.files[file]!;
  const lines = text.split('\n');
  const start = offset - 1;
  if (start >= lines.length) return unknown('range-outside-base-source');
  const end = limit === undefined ? lines.length : Math.min(start + (limit as number), lines.length);
  const truncated = truncateHead(lines.slice(start, end).join('\n'));
  if (truncated.truncated || truncated.firstLineExceedsLimit) return unknown('truncated-read');
  const footer = end < lines.length ? `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]` : '';
  if (item.result.content[0].text !== truncated.content + footer) return unknown('base-source-mismatch');
  const realEnd = Math.min(end, lineCount(text));
  if (offset > realEnd) return unknown('no-source-lines');
  return { span: { file, start: offset, end: realEnd } };
}

/** Call at transport receipt with that request's active branch, never a later session snapshot. */
export function captureRequest(input: {
  sessionId: string; requestId: string; branch: SessionEntry[]; payload: unknown;
  model: Model<Api>; source: SourceSnapshot;
}): RequestCapture {
  const { branch, source, payload, model } = input;
  if (!input.sessionId || !input.requestId) throw new Error('Missing capture identity');
  const sourceIdentity = sourceHash(source);
  const branchIds = branch.map((entry) => entry.id);
  if (new Set(branchIds).size !== branchIds.length || branch.some((entry, index) => entry.parentId !== (branch[index - 1]?.id ?? null))) {
    throw new Error('Capture requires a complete, ordered active branch');
  }
  const messages = branch.flatMap((entry) => entry.type === 'message' ? [entry.message] : []);
  const history = readHistory(branch, messages);
  const view = buildView(messages, history, history.retiredIds);
  measureRequest(payload, model, { contextLimit: model.contextWindow, marginTokens: 0 });
  const mapped = mapProviderEvidence(payload, view, history.evidence);
  const wire = payload as { messages: Array<Record<string, unknown>> };
  if (wire.messages.filter((message) => message.role === 'tool').length !== mapped.length) {
    throw new Error('Provider contains unaccounted tool results');
  }
  return {
    sessionId: input.sessionId, requestId: input.requestId, sourceHash: sourceIdentity,
    payloadHash: hash(payload), branchIds,
    evidence: mapped.map(({ evidence: item }) => ({
      id: item.id, toolCallId: item.result.toolCallId,
      visible: !history.retiredIds.includes(item.id), historical: history.historicalIds.includes(item.id),
      mapping: mapRead(item, source),
    })),
  };
}

export function mergeSpans(spans: LineSpan[]): LineSpan[] {
  const merged: LineSpan[] = [];
  for (const span of [...spans].sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start)) {
    if (!span.file || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 1 || span.end < span.start) {
      throw new Error('Invalid line span');
    }
    const previous = merged.at(-1);
    if (previous?.file === span.file && span.start <= previous.end + 1) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}
function mappedSpans(evidence: CapturedEvidence[]): LineSpan[] {
  return mergeSpans(evidence.flatMap((item) => item.mapping.span ? [item.mapping.span] : []));
}
function count(spans: LineSpan[]): number {
  return spans.reduce((total, span) => total + span.end - span.start + 1, 0);
}
function coverage(predicted: LineSpan[], reference: LineSpan[]) {
  const matchedLines = predicted.reduce((total, pred) => total + reference.reduce((hits, gold) =>
    hits + (pred.file === gold.file ? Math.max(0, Math.min(pred.end, gold.end) - Math.max(pred.start, gold.start) + 1) : 0), 0), 0);
  const referenceLines = count(reference);
  return { matchedLines, referenceLines, mappedCoverage: referenceLines ? matchedLines / referenceLines : null };
}

/** Gold enters only here, after capture. Coverage is a mapped lower bound, not a usefulness judgment. */
export function analyzeCaptures(captures: RequestCapture[], source: SourceSnapshot, referenceSpans: LineSpan[]) {
  const expectedHash = sourceHash(source);
  const reference = mergeSpans(referenceSpans);
  for (const span of reference) {
    if (!Object.hasOwn(source.files, span.file) || span.end > lineCount(source.files[span.file]!)) throw new Error('Reference outside base source');
  }
  const requestIds = new Set<string>();
  const discovered = new Map<string, CapturedEvidence>();
  let previous: RequestCapture | undefined;
  const requests = captures.map((capture) => {
    if (capture.sourceHash !== expectedHash) throw new Error('Source snapshot changed');
    if (requestIds.has(capture.requestId)) throw new Error('Duplicate captured request');
    requestIds.add(capture.requestId);
    if (previous && (capture.sessionId !== previous.sessionId || previous.branchIds.some((id, index) => capture.branchIds[index] !== id))) {
      throw new Error('Capture sequence switched session or branch');
    }
    const newEvidence = capture.evidence.filter((item) => !discovered.has(item.id));
    for (const item of capture.evidence) {
      const old = discovered.get(item.id);
      if (old && (old.toolCallId !== item.toolCallId || JSON.stringify(old.mapping) !== JSON.stringify(item.mapping))) throw new Error('Evidence identity changed');
      discovered.set(item.id, item);
    }
    const visible = capture.evidence.filter((item) => item.visible);
    const previousVisibility = new Map(previous?.evidence.map((item) => [item.id, item.visible]));
    const discoveredEvidence = [...discovered.values()];
    const discoveredSpans = mappedSpans(discoveredEvidence);
    const visibleSpans = mappedSpans(visible);
    const row = {
      requestId: capture.requestId, payloadHash: capture.payloadHash,
      newEvidenceIds: newEvidence.map((item) => item.id), newSpans: mappedSpans(newEvidence),
      discoveredSpans, visibleSpans,
      retiredIds: previous ? capture.evidence.filter((item) => !item.visible && previousVisibility.get(item.id) === true).map((item) => item.id) : null,
      restoredIds: previous ? visible.filter((item) => previousVisibility.get(item.id) === false).map((item) => item.id) : null,
      discovered: { ...coverage(discoveredSpans, reference), unmappedObservations: discoveredEvidence.filter((item) => !item.mapping.span).length },
      visible: { ...coverage(visibleSpans, reference), unmappedObservations: visible.filter((item) => !item.mapping.span).length },
      unmapped: capture.evidence.filter((item) => !item.mapping.span).map((item) => ({ id: item.id, visible: item.visible, reason: item.mapping.reason })),
    };
    previous = capture;
    return row;
  });
  return {
    version: 'contextbench-diagnostic-v1' as const,
    upstreamRevision: CONTEXTBENCH_REVISION,
    sourceRevision: source.revision, sourceHash: expectedHash,
    status: captures.length ? 'captured' as const : 'no-captures' as const,
    taskGrade: 'not-run' as const,
    requests,
  };
}

/** Parser-shaped discovery export only. Final selected-context and patch fields are deliberately absent. */
export function exportDiscovery(instanceId: string, report: ReturnType<typeof analyzeCaptures>) {
  if (!instanceId || !report.requests.length) throw new Error('Discovery export needs an instance and captures');
  return {
    instance_id: instanceId,
    bridge: {
      version: report.version, upstreamRevision: report.upstreamRevision, sourceRevision: report.sourceRevision,
      semantics: 'new-recorded-observations-per-captured-request',
      compatibility: 'parser-shape-only-not-an-official-evaluation',
    },
    traj_data: {
      pred_steps: report.requests.map((request) => {
        const spans: Record<string, Array<{ type: 'line'; start: number; end: number }>> = {};
        for (const span of request.newSpans) (spans[span.file] ??= []).push({ type: 'line', start: span.start, end: span.end });
        return { files: Object.keys(spans), spans, symbols: {} };
      }),
    },
  };
}
