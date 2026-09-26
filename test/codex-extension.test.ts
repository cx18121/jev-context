import assert from 'node:assert/strict';
import test from 'node:test';
import { Type, type Model, type Api } from '@earendil-works/pi-ai';
import { SessionManager, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createWorkingContextExtension, DEFERRAL_ENTRY, INFERENCE_START_ENTRY, STOP_ENTRY, USAGE_ENTRY, type UsageRecord } from '../src/working-extension.ts';
import { commitSelection, readHistory, SELECTION_ENTRY } from '../src/history.ts';
import { createCodexFixture, type CodexRequest } from './codex-fixture.ts';
import { createJevFixture } from './jev-fixture.ts';
import { assistant, result } from './history-fixture.ts';
import { captureOptions } from './working-fixture.ts';
import { JEV_MODEL } from '../src/jev.ts';

const seedReasoning = { type: 'reasoning', id: 'rs_seed', encrypted_content: 'opaque_seed_keep_exact', summary: [] };
function exchange(manager: SessionManager, model: Model<Api>, id: string, text: string, toolName = 'read') {
  const call = { type: 'toolCall' as const, id: `${id}|fc_${id}`, name: toolName, arguments: { path: `${id}.txt` } };
  const message = assistant([call]);
  manager.appendMessage({ ...message, api: model.api, provider: model.provider, model: model.id,
    usage: { ...message.usage, input: 80, output: 4, totalTokens: 84 },
    content: [{ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify({ ...seedReasoning, id: `rs_${id}` }) }, call] });
  return manager.appendMessage(result(call.id, text, { toolName }));
}
function seed(manager: SessionManager, model: Model<Api>, toolName = 'read') {
  manager.appendMessage({ role: 'user', content: 'Implement the API contract.', timestamp: 1 });
  const a = exchange(manager, model, 'a', 'API contract evidence. '.repeat(170), toolName);
  const b = exchange(manager, model, 'b', 'Old environment evidence. '.repeat(240), toolName);
  exchange(manager, model, 'new', 'Protected current result.', toolName);
  return { a, b };
}
function output(request: CodexRequest, id: string) {
  return request.input.find((item) => item.call_id === id && String(item.type).endsWith('_output'))!;
}
function records<T>(manager: SessionManager, kind: string) {
  return manager.getBranch().flatMap((entry) => entry.type === 'custom' && entry.customType === kind ? [entry.data as T] : []);
}
function stableItems(request: CodexRequest) {
  return request.input.filter((item) => item.type === 'reasoning' || item.type === 'function_call' || item.type === 'custom_tool_call');
}

test('manual native Codex retirement, restoration and resume preserve reasoning and call identity', async () => {
  const f = await createCodexFixture();
  try {
    const manager = SessionManager.create(f.directory);
    const { a, b } = seed(manager, f.model);
    manager.appendMessage({ role: 'system', content: [{ type: 'text', text: 'Keep the existing public API.' }], timestamp: 5 });
    const originals = structuredClone(manager.getBranch().filter((entry) => entry.type === 'message'));
    const { session, errors } = await f.session(() => [], manager);
    await session.prompt('Establish the original view.');
    commitSelection(manager, [a], 'fixture');
    session.refreshContext();
    await session.prompt('Continue with environment setup.');
    assert.equal(f.requests.length, 2);
    assert.match(String(output(f.requests[1]!, 'a').output), /retired observation/);
    assert.match(String(output(f.requests[1]!, 'b').output), /Old environment evidence/);
    const originalWireItems = stableItems(f.requests[0]!);
    assert.deepEqual(originalWireItems.filter((item) => item.type === 'reasoning'), ['a', 'b', 'new'].map((id) => ({ ...seedReasoning, id: `rs_${id}` })));
    assert.deepEqual(originalWireItems.filter((item) => item.type === 'function_call').map((item) => [item.call_id, item.id]),
      [['a', 'fc_a'], ['b', 'fc_b'], ['new', 'fc_new']]);
    assert.equal((f.requests[0]!.reasoning as { effort: string }).effort, 'medium');
    assert.equal('max_output_tokens' in f.requests[0]!, false);
    assert.ok(f.requests[0]!.input.some((item) => item.role === 'developer' && String(item.content).includes('Keep the existing public API')));
    commitSelection(manager, [b], 'fixture');
    session.refreshContext();
    await session.prompt('Return to the API contract evidence.');
    assert.match(String(output(f.requests[2]!, 'a').output), /restored historical observation/);
    assert.match(String(output(f.requests[2]!, 'a').output), /API contract evidence/);
    assert.match(String(output(f.requests[2]!, 'b').output), /retired observation/);
    assert.deepEqual(stableItems(f.requests[2]!).slice(0, originalWireItems.length), originalWireItems);
    assert.deepEqual(manager.getBranch().filter((entry) => entry.type === 'message').slice(0, originals.length), originals);
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionContext().messages).retiredIds, [b]);
    assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 3);
    assert.deepEqual(errors, []);
    session.dispose();
    const checkpoint = manager.getBranch().findLast((entry) => entry.type === 'custom' && entry.customType === SELECTION_ENTRY)!;
    const reopened = SessionManager.open(manager.createBranchedSession(checkpoint.id)!);
    const resumed = await f.session(() => [], reopened);
    await resumed.session.prompt('Continue after reopening.');
    assert.equal(f.requests.length, 4);
    assert.deepEqual(stableItems(f.requests[3]!), stableItems(f.requests[2]!));
    for (const id of ['a', 'b', 'new']) assert.deepEqual(output(f.requests[3]!, id), output(f.requests[2]!, id));
    assert.deepEqual(resumed.errors, []);
  } finally { await f.close(); }
});

test('Codex pressure ranks complete eligible evidence, preserves pins and defers accounted rejection with original wire', async () => {
  for (const failedJudge of [false, true]) {
    const f = await createCodexFixture();
    const judge = await createJevFixture();
    try {
      const manager = SessionManager.create(f.directory);
      manager.appendMessage({ role: 'user', content: 'Fix the product implementation and preserve the API.', timestamp: 1 });
      const sourceId = exchange(manager, f.model, 'source', 's'.repeat(16927));
      exchange(manager, f.model, 'tests', 't'.repeat(11413));
      judge.respond((request) => ({ body: { model: JEV_MODEL, usage: { input_tokens: 1000, output_tokens: 20 }, answers: failedJudge ? {} :
        Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, {
          type: 'score', score: 0, legend: { ...question.criteria }, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0 }, confidence: 1,
        }])) } }));
      let originalPayload: unknown;
      const options = captureOptions(f.model);
      options.target = { lowTokens: 4000, highTokens: 6000, restoreHeadroomTokens: 0 };
      options.order = { kind: 'jev', connection: judge.config };
      options.ranking.requestTimeoutMs = judge.config.timeoutMs;
      const run = await f.session((m) => [
        (pi) => { pi.on('before_provider_request', (event) => { originalPayload = structuredClone(event.payload); }); },
        createWorkingContextExtension(m, options),
      ], manager);
      f.reportInputTokens(7100);
      await run.session.prompt('Continue.');
      assert.equal(f.requests.length, 1, JSON.stringify(records(manager, STOP_ENTRY)));
      assert.ok(judge.requests.length > 0);
      for (const start of records<{ kind: string; candidateIds: string[] }>(manager, INFERENCE_START_ENTRY).filter((entry) => entry.kind === 'ranking')) {
        assert.deepEqual(start.candidateIds, [sourceId]);
      }
      assert.doesNotMatch(JSON.stringify(judge.requests), /opaque_seed_keep_exact/);
      assert.deepEqual(stableItems(f.requests[0]!), stableItems(originalPayload as CodexRequest));
      assert.equal(output(f.requests[0]!, 'tests').output, 't'.repeat(11413));
      if (failedJudge) {
        assert.deepEqual(f.requests[0], originalPayload);
        assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 0);
        assert.equal(records(manager, DEFERRAL_ENTRY).length, 1);
      } else {
        assert.match(String(output(f.requests[0]!, 'source').output), /retired observation/);
        assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 1);
      }
      const usage = records<UsageRecord>(manager, USAGE_ENTRY)[0]!;
      assert.equal(usage.capacity?.outputReserveSource, 'configured-headroom');
      assert.equal(usage.capacity?.outputReserve, 1024);
      assert.equal(usage.usageAvailable, true);
      assert.equal(usage.usage.input, 7080);
      assert.equal(usage.usage.cacheRead, 20);
      assert.equal(usage.usage.output, 4);
      assert.equal(records(manager, STOP_ENTRY).length, 0);
      assert.deepEqual(run.errors, []);
    } finally { await judge.close(); await f.close(); }
  }
});

test('Codex grammar output uses exact native retirement mapping through the real serializer', async () => {
  const f = await createCodexFixture();
  try {
    const manager = SessionManager.create(f.directory);
    const { a } = seed(manager, f.model, 'fixture_grammar');
    commitSelection(manager, [a], 'fixture');
    const grammar: ExtensionFactory = (pi) => pi.registerTool({
      name: 'fixture_grammar', label: 'Grammar fixture', description: 'Fixture only.', parameters: Type.Object({ path: Type.String() }),
      constrainedSampling: { type: 'grammar', variants: { openai_regex: '.*' } },
      async execute() { throw new Error('No tool should execute'); },
    });
    const { session, errors } = await f.session(() => [grammar], manager, ['fixture_grammar']);
    await session.prompt('Continue.');
    assert.equal(f.requests.length, 1);
    assert.equal(output(f.requests[0]!, 'a').type, 'custom_tool_call_output');
    assert.match(String(output(f.requests[0]!, 'a').output), /retired observation/);
    assert.equal(f.requests[0]!.input.find((item) => item.type === 'custom_tool_call')?.input, 'a.txt');
    assert.deepEqual(errors, []);
  } finally { await f.close(); }
});

test('Codex capacity, provenance and provider-map failures stop before HTTP dispatch or native edits', async () => {
  for (const failure of ['budget', 'missing-reserve', 'foreign', 'missing', 'duplicate', 'changed', 'image', 'delta', 'tool-search'] as const) {
    const f = await createCodexFixture();
    try {
      const manager = SessionManager.create(f.directory);
      seed(manager, failure === 'foreign' ? { ...f.model, id: 'another-model' } : f.model);
      const corrupt: ExtensionFactory = (pi) => { pi.on('before_provider_request', (event) => {
        const payload = event.payload as CodexRequest;
        const index = payload.input.findIndex((item) => item.type === 'function_call_output');
        if (failure === 'missing') payload.input.splice(index, 1);
        if (failure === 'duplicate') payload.input.push(structuredClone(payload.input[index]!));
        if (failure === 'changed') payload.input[index]!.output = 'changed';
        if (failure === 'image') payload.input[index]!.output = [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }];
        if (failure === 'delta') payload.previous_response_id = 'previous';
        if (failure === 'tool-search') payload.input.push({ type: 'tool_search_output', tools: [] });
        return payload;
      }); };
      const options = captureOptions(f.model);
      if (failure === 'missing-reserve') delete options.capacity.outputReserveTokens;
      if (failure === 'budget') {
        options.capacity.contextLimit = 1024;
        options.target = { lowTokens: 512, highTokens: 768, restoreHeadroomTokens: 0 };
      }
      const { session } = await f.session((m) => [corrupt, createWorkingContextExtension(m, options)], manager);
      await session.prompt('Continue.');
      assert.equal(f.requests.length, 0, failure);
      assert.equal(records(manager, STOP_ENTRY).length, 1, failure);
      assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 0, failure);
    } finally { await f.close(); }
  }
});
