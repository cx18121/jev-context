import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { sanitizeSurrogates } from '@earendil-works/pi-ai/utils/sanitize-unicode';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { buildView, readHistory, retirementText, SELECTION_ENTRY } from '../src/history.ts';
import { retireOldest } from '../src/retirement.ts';
import { appendExchange, result } from './history-fixture.ts';

const model: Model<'openai-completions'> = {
  id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://127.0.0.1',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function prepared(manager: SessionManager) {
  const original = manager.buildSessionContext().messages;
  const history = readHistory(manager.getBranch(), original);
  const messages = buildView(original, history, history.retiredIds);
  const payload = {
    messages: [
      { role: 'system', content: 'Protected instructions.' },
      ...messages.filter((message) => message.role === 'toolResult').map((message) => ({
        role: 'tool', tool_call_id: message.toolCallId,
        content: sanitizeSurrogates(message.content.filter((block) => block.type === 'text')
          .map((block) => block.text).join('\n') || '(no tool output)'),
      })),
    ],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    max_tokens: 100,
  };
  const size = Buffer.byteLength(JSON.stringify(payload)) + payload.max_tokens + 32;
  return {
    history, messages, payload, size,
    run(contextLimit = size - 1) {
      return retireOldest(payload, messages, history, model, { contextLimit, marginTokens: 32 });
    },
  };
}

function record(manager: SessionManager, retiredIds: string[]) {
  manager.appendCustomEntry(SELECTION_ENTRY, {
    version: 1, policy: 'scripted-v1', sourceLeafId: manager.getLeafId(), retiredIds,
  });
}

test('a request at the exact budget preserves the payload and makes no selection', () => {
  const manager = SessionManager.inMemory();
  appendExchange(manager, [result('old', 'old'.repeat(200))]);
  appendExchange(manager, [result('new', 'new')]);
  const fixture = prepared(manager);
  const selected = fixture.run(fixture.size);
  assert.equal(selected.payload, fixture.payload);
  assert.deepEqual(selected.retiredIds, []);
  assert.equal(selected.budget.fits, true);
});

test('oldest-first stops when the request fits rather than choosing the largest result', () => {
  const manager = SessionManager.inMemory();
  const [first] = appendExchange(manager, [result('first', 'first'.repeat(200))]);
  appendExchange(manager, [result('second', 'second'.repeat(500))]);
  appendExchange(manager, [result('latest', 'protected')]);
  const fixture = prepared(manager);
  const original = structuredClone(fixture.payload);
  const selected = fixture.run();
  assert.deepEqual(selected.retiredIds, [first]);
  assert.equal(selected.budget.fits, true);
  assert.deepEqual(fixture.payload, original);
  const expected = structuredClone(original);
  expected.messages[1]!.content = retirementText(fixture.history.evidence[0]!);
  assert.deepEqual(selected.payload, expected);
});

test('short and empty observations stay visible when replacing them would grow the request', () => {
  const manager = SessionManager.inMemory();
  appendExchange(manager, [result('empty', ''), result('short', 'small')]);
  const [large] = appendExchange(manager, [result('large', 'large'.repeat(200))]);
  appendExchange(manager, [result('new', 'new')]);
  const fixture = prepared(manager);
  assert.deepEqual(fixture.run().retiredIds, [large]);
});

test('multiple retirements use serialized Unicode and escape savings including independent error/truncation status', () => {
  const manager = SessionManager.inMemory();
  appendExchange(manager, [result('a', ('你好🦊\n"\\\ud800').repeat(100), {
    isError: true, details: { truncation: { truncated: true } },
  })]);
  appendExchange(manager, [result('b', 'B'.repeat(500))]);
  appendExchange(manager, [result('new', 'protected')]);
  const fixture = prepared(manager);
  const fullySelected = structuredClone(fixture.payload);
  for (let i = 0; i < 2; i++) fullySelected.messages[i + 1]!.content = retirementText(fixture.history.evidence[i]!);
  const limit = Buffer.byteLength(JSON.stringify(fullySelected)) + 100 + 32;
  const selected = fixture.run(limit);
  assert.deepEqual(selected.payload, fullySelected);
  assert.deepEqual(selected.retiredIds, fixture.history.evidence.slice(0, 2).map((item) => item.id).sort());
  assert.equal(selected.budget.inputEstimate + 100 + 32, limit);
  assert.equal(selected.budget.fits, true);
  assert.match(fullySelected.messages[1]!.content, /status=error; truncated=yes/);
});

test('retirement preserves recorded removals and can retire restored historical evidence again', () => {
  const manager = SessionManager.inMemory();
  const [a, b] = appendExchange(manager, [result('a', 'A'.repeat(500)), result('b', 'B'.repeat(500))]);
  appendExchange(manager, [result('new', 'protected')]);
  record(manager, [a!, b!]);
  record(manager, [a!]);
  const fixture = prepared(manager);
  assert.match(fixture.payload.messages[2]!.content, /restored historical observation/);
  const selected = fixture.run();
  assert.deepEqual(selected.retiredIds, [a!, b!].sort());
  assert.deepEqual(fixture.history.retiredIds, [a]);
  assert.equal(selected.budget.fits, true);
});

test('exhausting candidates reports cannot-fit without mutating the payload or recorded decisions', () => {
  const manager = SessionManager.inMemory();
  appendExchange(manager, [result('old', 'old'.repeat(200))]);
  appendExchange(manager, [result('new', 'protected'.repeat(200))]);
  const fixture = prepared(manager);
  const original = structuredClone({ payload: fixture.payload, history: fixture.history });
  const selected = fixture.run(100);
  assert.equal(selected.budget.fits, false);
  assert.deepEqual(selected.retiredIds, [fixture.history.evidence[0]!.id]);
  assert.deepEqual({ payload: fixture.payload, history: fixture.history }, original);
  assert.equal((selected.payload as typeof fixture.payload).messages[2]!.content, fixture.payload.messages[2]!.content);
});

test('changed, missing, and duplicate provider mappings fail rather than guessing evidence identity', () => {
  for (const change of ['changed', 'missing', 'duplicate']) {
    const manager = SessionManager.inMemory();
    appendExchange(manager, [result('old', 'old'.repeat(200))]);
    appendExchange(manager, [result('new', 'protected')]);
    const fixture = prepared(manager);
    if (change === 'changed') fixture.payload.messages[1]!.content += 'different';
    if (change === 'missing') Object.assign(fixture.payload.messages[1]!, { tool_call_id: 'normalized' });
    if (change === 'duplicate') fixture.payload.messages.push({ ...fixture.payload.messages[1]! });
    assert.throws(() => fixture.run(100), /unique provider tool result|differs from the selected view/);
  }
});
