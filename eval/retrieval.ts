import { pathToFileURL } from 'node:url';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { buildSessionProjection, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { readHistory, retirementText, SELECTION_ENTRY } from '../src/history.ts';
import { exploreArchive, EXPLORATION_VERSION } from '../src/retrieval.ts';
import { retrievalScenarios, type RetrievalScenario } from './retrieval-fixtures.ts';

export function prepareRetrievalFixture(scenario: RetrievalScenario) {
  const branch: SessionEntry[] = [];
  const messages: AgentMessage[] = [];
  const labels = new Map<string, string>();
  function append(message: AgentMessage) {
    const id = (branch.length + 1).toString(16).padStart(8, '0');
    branch.push({ type: 'message', id, parentId: branch.at(-1)?.id ?? null, timestamp: '2026-01-01T00:00:00.000Z', message });
    messages.push(message);
    return id;
  }
  function assistant(content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse') {
    append({ role: 'assistant', content, stopReason, api: 'openai-completions', provider: 'synthetic', model: 'synthetic',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: messages.length });
  }
  function exchange(path: string, text: string) {
    const id = `call-${messages.length}`;
    assistant([{ type: 'toolCall', id, name: 'read', arguments: { path } }], 'toolUse');
    return append({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }], isError: false, timestamp: messages.length });
  }
  if (!scenario.users.length) throw new Error('Fixture needs a user task');
  if (new Set(scenario.observations.map((item) => item.id)).size !== scenario.observations.length) throw new Error('Duplicate observation label');
  append({ role: 'user', content: scenario.users[0]!, timestamp: 0 });
  for (const item of scenario.observations) labels.set(exchange(item.path, item.text), item.id);
  for (const content of scenario.users.slice(1)) append({ role: 'user', content, timestamp: messages.length });
  exchange(scenario.latestPath, 'Current observation.');
  assistant([{ type: 'text', text: scenario.action }], 'stop');
  const sourceLeafId = branch.at(-1)!.id;
  const original = readHistory(branch, messages);
  for (const item of original.evidence.filter((item) => labels.has(item.id))) {
    branch.push({ type: 'context_edit', id: (branch.length + 1).toString(16).padStart(8, '0'), parentId: branch.at(-1)!.id,
      timestamp: '2026-01-01T00:00:00.000Z', targetId: item.id, replacement: { content: [{ type: 'text', text: retirementText(item) }] } });
  }
  branch.push({ type: 'custom', id: (branch.length + 1).toString(16).padStart(8, '0'), parentId: branch.at(-1)!.id,
    timestamp: '2026-01-01T00:00:00.000Z', customType: SELECTION_ENTRY,
    data: { version: 2, policy: 'scripted-v1', sourceLeafId } });
  return { history: readHistory(branch, buildSessionProjection(branch).messages), messages, labels };
}

export function evaluateRetrieval(scenario: RetrievalScenario) {
  const { history, labels } = prepareRetrievalFixture(scenario);
  // Authored query diagnostic, not a test of automatic sketch quality.
  const query = [...scenario.users, scenario.action, scenario.latestPath].join('\n');
  const known = new Set(labels.values());
  if (new Set(scenario.relevant).size !== scenario.relevant.length || scenario.relevant.some((id) => !known.has(id))) {
    throw new Error('Relevant labels must be unique members of the archive');
  }
  const shortlist = exploreArchive(history, query, scenario.limit);
  // A full page distinguishes lexical misses from matches beyond the first page.
  const uncapped = exploreArchive(history, query, Math.max(1, history.retiredIds.length));
  const selected = new Set(shortlist.candidates.map((item) => labels.get(item.evidence.id)!));
  const matches = new Set(uncapped.candidates.map((item) => labels.get(item.evidence.id)!));
  const relevant = new Set(scenario.relevant);
  const found = scenario.relevant.filter((id) => selected.has(id));
  return {
    id: scenario.id, reason: scenario.reason, limit: scenario.limit, poolSize: shortlist.poolSize,
    queryTerms: shortlist.queryTerms, matchedCount: shortlist.matchedCount,
    pageIds: shortlist.pageIds.map((id) => labels.get(id)!),
    candidates: shortlist.candidates.map((item) => ({ id: labels.get(item.evidence.id)!, score: item.score, matchedTerms: item.matchedTerms })),
    fullArchiveRelevant: scenario.relevant, found,
    missed: scenario.relevant.filter((id) => !selected.has(id)).map((id) => ({ id, cause: matches.has(id) ? 'outside-page' : 'no-lexical-match' })),
    irrelevantSelected: [...selected].filter((id) => !relevant.has(id)),
    recall: relevant.size ? found.length / relevant.size : null,
  };
}

export function retrievalReport() {
  return { version: 'retrieval-diagnostic-v2', lookupVersion: EXPLORATION_VERSION,
    evidenceLimit: 'Authored development fixtures measuring the first capture-order page, not eventual exploration recall or sketch quality. Full archive is a coverage reference, not a model oracle. No Jev, agent actions, quality, latency or cost measurements.',
    cases: retrievalScenarios().map(evaluateRetrieval) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(retrievalReport(), null, 2));
}
