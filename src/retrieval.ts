import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { validateSelection, type Evidence, type HistoryView } from './history.ts';

export const RETRIEVAL_VERSION = 'token-overlap-v1';

export interface ArchiveLookup {
  version: typeof RETRIEVAL_VERSION;
  queryTerms: string[];
  poolSize: number;
  matchedCount: number;
  candidates: Array<{ evidence: Evidence; score: number; matchedTerms: string[] }>;
}

/** Sets prevent repeated words from increasing a document's score. No stemming or semantic matching. */
function terms(text: string): Set<string> {
  return new Set((text.replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2').toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => term.length > 1));
}

function argumentText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(argumentText).join(' ');
  if (typeof value === 'object' && value !== null) return Object.values(value).map(argumentText).join(' ');
  return '';
}

function queryText(history: HistoryView, messages: AgentMessage[]): string {
  const parts: string[] = [];
  // Keep earlier requirements in retrieval scope. Jev, not lexical matching, resolves supersession.
  for (const message of messages) {
    if (message.role === 'user') parts.push(typeof message.content === 'string' ? message.content :
      message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'));
  }
  const latest = messages.findLast((message) => message.role === 'assistant' &&
    message.stopReason !== 'error' && message.stopReason !== 'aborted');
  if (latest?.role === 'assistant') {
    for (const block of latest.content) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'toolCall') parts.push(argumentText(block.arguments));
    }
  }
  for (const item of history.evidence) {
    if (item.protectedReason === 'newest-exchange') parts.push(argumentText(item.call.arguments));
  }
  return parts.join('\n');
}

/** Shortlist archived evidence only. This neither judges relevance nor changes the working view. */
export function retrieveArchive(history: HistoryView, messages: AgentMessage[], maxCandidates: number): ArchiveLookup {
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) throw new Error('maxCandidates must be a positive safe integer');
  const retired = new Set(validateSelection(history, history.retiredIds));
  const queryTerms = [...terms(queryText(history, messages))].sort();
  const pool = history.evidence.filter((item) => retired.has(item.id)).map((evidence) => ({
    evidence,
    terms: terms([evidence.call.name, argumentText(evidence.call.arguments),
      ...evidence.result.content.filter((block) => block.type === 'text').map((block) => block.text)].join('\n')),
  }));
  const frequencies = new Map<string, number>();
  for (const item of pool) {
    for (const term of queryTerms) {
      if (item.terms.has(term)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  const ranked = pool.map((item) => {
    const matchedTerms = queryTerms.filter((term) => item.terms.has(term));
    return { evidence: item.evidence, matchedTerms,
      score: matchedTerms.reduce((sum, term) => sum + Math.log(1 + pool.length / frequencies.get(term)!), 0) };
  }).filter((item) => item.matchedTerms.length > 0);
  // Stable sorting preserves capture order on ties, not randomly generated session-entry IDs.
  ranked.sort((a, b) => b.score - a.score);
  return { version: RETRIEVAL_VERSION, queryTerms, poolSize: pool.length,
    matchedCount: ranked.length, candidates: ranked.slice(0, maxCandidates) };
}
