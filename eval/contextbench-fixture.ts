import { pathToFileURL } from 'node:url';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { buildView, readHistory, SELECTION_ENTRY } from '../src/history.ts';
import { providerText } from '../src/provider-view.ts';
import { analyzeCaptures, captureRequest, exportDiscovery, type RequestCapture, type SourceSnapshot } from './contextbench.ts';

export const fixtureModel: Model<'openai-completions'> = {
  id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://127.0.0.1',
  reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export const fixtureSource: SourceSnapshot = {
  root: '/fixture/repo', cwd: '/fixture/repo', revision: 'authored-base-v1',
  files: { 'answer.ts': 'export const answer = 42;\n', 'other.ts': 'export const other = 0;\n' },
};

/** Authored development data, not a ContextBench task or live agent trajectory. */
export function contextFixture(source = fixtureSource) {
  const branch: SessionEntry[] = [];
  const captures: RequestCapture[] = [];
  function append(message: AgentMessage) {
    const id = `entry-${branch.length}`;
    branch.push({ type: 'message', id, parentId: branch.at(-1)?.id ?? null, timestamp: '2026-01-01T00:00:00Z', message });
    return id;
  }
  function read(path: string, text: string, args: Record<string, unknown> = {}, tool = 'read', isError = false) {
    const id = `tool-${branch.length}`;
    append({ role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: 0,
      content: [{ type: 'toolCall', id, name: tool, arguments: { path, ...args } }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    return append({ role: 'toolResult', toolCallId: id, toolName: tool, content: [{ type: 'text', text }], isError, timestamp: 0 });
  }
  function select(retiredIds: string[]) {
    const leaf = branch.at(-1)?.id ?? null;
    branch.push({ type: 'custom', id: `entry-${branch.length}`, parentId: leaf, timestamp: '2026-01-01T00:00:00Z', customType: SELECTION_ENTRY,
      data: { version: 1, policy: 'scripted-v1', sourceLeafId: leaf, retiredIds } });
  }
  function payload() {
    const messages = branch.flatMap((entry) => entry.type === 'message' ? [entry.message] : []);
    const history = readHistory(branch, messages);
    return { max_tokens: 1024, messages: buildView(messages, history, history.retiredIds)
      .filter((message) => message.role === 'toolResult')
      .map((message) => ({ role: 'tool', tool_call_id: message.toolCallId, content: providerText(message) })) };
  }
  function capture() {
    const result = captureRequest({ branch, source, payload: payload(), model: fixtureModel, sessionId: 'fixture', requestId: `capture-${captures.length}` });
    captures.push(result);
    return result;
  }
  append({ role: 'user', content: 'Read the source.', timestamp: 0 });
  return { branch, captures, read, select, payload, capture };
}

export function contextbenchDiagnostic() {
  const fixture = contextFixture();
  fixture.capture();
  const answer = fixture.read('answer.ts', fixtureSource.files['answer.ts']!);
  fixture.capture();
  fixture.read('other.ts', fixtureSource.files['other.ts']!);
  fixture.capture();
  fixture.select([answer]);
  fixture.capture();
  fixture.select([]);
  fixture.capture();
  const report = analyzeCaptures(fixture.captures, fixtureSource, [{ file: 'answer.ts', start: 1, end: 1 }]);
  return {
    evidenceLimit: 'Authored offline fixture. Synthetic payloads, no agent task, no official ContextBench score, no cost or quality measurement.',
    report,
    discoveryExport: exportDiscovery('authored-context-fixture', report),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(contextbenchDiagnostic(), null, 2));
}
