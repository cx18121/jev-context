import { validateSelection, type Evidence, type HistoryView } from './history.ts';

export const EXPLORATION_VERSION = 'capture-page-overlap-v1';

export interface ArchiveCursor {
  version: 1;
  /** Capture frontier, including evidence that has since been restored. */
  afterId: string | null;
}

export interface ArchiveLookup {
  version: typeof EXPLORATION_VERSION;
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

/** Shortlist archived evidence only. This neither judges relevance nor changes the working view. */
function matchingArchive(history: HistoryView, query: string): ArchiveLookup {
  const retired = new Set(validateSelection(history, history.retiredIds));
  const queryTerms = [...terms(query)].sort();
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
  return { version: EXPLORATION_VERSION, queryTerms, poolSize: pool.length, matchedCount: ranked.length, candidates: ranked };
}

function checkLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('maxCandidates must be a positive safe integer');
}

/** Advance through capture-order pages of matches, then rank within the page. Query changes never reset progress. */
export function exploreArchive(history: HistoryView, query: string, maxCandidates: number, cursor?: ArchiveCursor) {
  checkLimit(maxCandidates);
  if (cursor && (cursor.version !== 1 || (cursor.afterId !== null &&
      (typeof cursor.afterId !== 'string' || cursor.afterId.length === 0)))) throw new Error('Invalid archive exploration cursor');
  const lookup = matchingArchive(history, query);
  const positions = new Map(history.evidence.map((item, index) => [item.id, index]));
  const resetReason = cursor?.afterId && !positions.has(cursor.afterId) ? 'missing-frontier' as const : null;
  const after = cursor?.afterId && !resetReason ? positions.get(cursor.afterId)! : -1;
  let remaining = lookup.candidates.filter((item) => positions.get(item.evidence.id)! > after);
  const wrapped = lookup.candidates.length > 0 && remaining.length === 0 && after >= 0;
  if (wrapped) remaining = lookup.candidates;
  // A short final page does not fill from the beginning. The next decision wraps.
  const page = remaining.slice(0, maxCandidates);
  const pageIds = page.map((item) => item.evidence.id);
  const nextCursor: ArchiveCursor = { version: 1, afterId: pageIds.at(-1) ?? (resetReason ? null : cursor?.afterId ?? null) };
  // The frontier advances over the entire page, including items omitted by later planning.
  page.sort((a, b) => b.score - a.score);
  return { ...lookup, candidates: page, pageIds, nextCursor, wrapped, resetReason };
}
