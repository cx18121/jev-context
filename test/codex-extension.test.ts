import assert from 'node:assert/strict';
import test from 'node:test';
import { Type, type Model, type Api } from '@earendil-works/pi-ai';
import { SessionManager, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { createContextExtension, JUDGE_START_ENTRY, STOP_ENTRY, USAGE_ENTRY, type UsageRecord } from '../src/extension.ts';
import { readHistory, SELECTION_ENTRY } from '../src/history.ts';
import { createCodexFixture, type CodexRequest } from './codex-fixture.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';
import { assistant, result } from './history-fixture.ts';

const budget = { contextLimit: 32768, marginTokens: 256, outputReserveTokens: 1024 };
const selection = { archiveLimit: 2, restoreAtOrAbove: 0.8, workingContextLimit: 8000 };
const seedReasoning = { type: 'reasoning', id: 'rs_seed', encrypted_content: 'opaque_seed_keep_exact', summary: [] };
function seed(manager: SessionManager, model: Model<Api>, toolName = 'read') {
  manager.appendMessage({ role: 'user', content: 'Implement the API contract.', timestamp: 1 });
  function exchange(id: string, text: string) {
    const call = { type: 'toolCall' as const, id: `${id}|fc_${id}`, name: toolName, arguments: { path: `${id}.txt` } };
    manager.appendMessage({ ...assistant([call]), api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify({ ...seedReasoning, id: `rs_${id}` }) }, call] });
    return manager.appendMessage(result(call.id, text, { toolName }));
  }
  const a = exchange('a', 'API contract evidence. '.repeat(170));
  const b = exchange('b', 'Old environment evidence. '.repeat(240));
  exchange('new', 'Protected current result.');
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

test('real Codex selector retires, restores, resumes, preserves reasoning and exports honest usage', async () => {
  const f = await createCodexFixture();
  const judge = await createJevFixture();
  try {
    const manager = SessionManager.create(f.directory);
    const { a, b } = seed(manager, f.model);
    manager.appendMessage({ role: 'system', content: [{ type: 'text', text: 'Keep the existing public API.' }], timestamp: 5 });
    const originals = structuredClone(manager.getBranch().filter((entry) => entry.type === 'message'));
    let restore = false;
    judge.respond((request) => {
      const body = jevResponse(request, 0.9);
      for (const id of Object.keys(body.answers)) body.answers[id]!.noul = restore ? (id === a ? 0.99 : 0.1) : (id === a ? 0.1 : 0.9);
      return { body };
    });
    const factories = (m: SessionManager) => [createContextExtension(m, { policy: 'jev-select-v1', budget, selection, jev: judge.config })];
    const { session, errors } = await f.session(factories, manager);
    f.reportInputTokens(8000);
    await session.prompt('Establish usage.');
    assert.equal(judge.requests.length, 0);
    f.reportInputTokens(7100);
    await session.prompt('Continue with environment setup.');
    assert.equal(f.requests.length, 2, JSON.stringify(records(manager, STOP_ENTRY)));
    assert.equal(judge.requests.length, 1);
    assert.match(String(output(f.requests[1]!, 'a').output), /retired observation/);
    assert.match(String(output(f.requests[1]!, 'b').output), /Old environment evidence/);
    const originalWireItems = stableItems(f.requests[0]!);
    assert.deepEqual(originalWireItems.filter((item) => item.type === 'reasoning'), ['a', 'b', 'new'].map((id) => ({ ...seedReasoning, id: `rs_${id}` })));
    assert.deepEqual(originalWireItems.filter((item) => item.type === 'function_call').map((item) => [item.call_id, item.id]),
      [['a', 'fc_a'], ['b', 'fc_b'], ['new', 'fc_new']]);
    assert.equal(f.requests[0]!.reasoning && (f.requests[0]!.reasoning as { effort: string }).effort, 'medium');
    assert.equal('max_output_tokens' in f.requests[0]!, false);
    const usage = records<UsageRecord>(manager, USAGE_ENTRY)[1]!;
    assert.equal(usage.budget?.outputReserveSource, 'configured-headroom');
    assert.equal(usage.budget?.outputReserve, 1024);
    assert.equal(usage.usageAvailable, true);
    assert.equal(usage.usage.input, 7080);
    assert.equal(usage.usage.cacheRead, 20);
    assert.equal(usage.usage.output, 4);
    assert.equal(records<{ stateProviderApi: string }>(manager, JUDGE_START_ENTRY)[0]!.stateProviderApi, f.model.api);
    assert.match(JSON.stringify(judge.requests[0]!.state), /Local Codex integration fixture/);
    assert.match(JSON.stringify(judge.requests[0]!.state), /Keep the existing public API/);
    assert.ok(f.requests[0]!.input.some((item) => item.role === 'developer' && String(item.content).includes('Keep the existing public API')));
    assert.doesNotMatch(JSON.stringify(judge.requests[0]!.state), /opaque_seed_keep_exact/);

    restore = true;
    await session.prompt('Return to the API contract evidence.');
    assert.equal(f.requests.length, 3, JSON.stringify(records(manager, STOP_ENTRY)));
    assert.match(String(output(f.requests[2]!, 'a').output), /restored historical observation/);
    assert.match(String(output(f.requests[2]!, 'a').output), /API contract evidence/);
    assert.match(String(output(f.requests[2]!, 'b').output), /retired observation/);
    assert.equal(records<UsageRecord>(manager, USAGE_ENTRY)[2]!.workingContext?.fits, true);
    assert.deepEqual(stableItems(f.requests[2]!).slice(0, originalWireItems.length), originalWireItems);
    assert.deepEqual(manager.getBranch().filter((entry) => entry.type === 'message').slice(0, originals.length), originals);
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionContext().messages).retiredIds, [b]);
    assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 3);
    assert.deepEqual(errors, []);

    session.dispose();
    const checkpoint = manager.getBranch().findLast((entry) => entry.type === 'custom' && entry.customType === SELECTION_ENTRY)!;
    const reopened = SessionManager.open(manager.createBranchedSession(checkpoint.id)!);
    const resumed = await f.session(factories, reopened);
    const judgedBefore = judge.requests.length;
    await resumed.session.agent.continue();
    assert.equal(f.requests.length, 4, JSON.stringify(records(reopened, STOP_ENTRY)));
    assert.equal(judge.requests.length, judgedBefore, 'unchanged branch is not rejudged');
    assert.deepEqual(f.requests[3]!.input.slice(0, f.requests[2]!.input.length), f.requests[2]!.input);
    assert.deepEqual(resumed.errors, []);
  } finally { await judge.close(); await f.close(); }
});

test('Codex two-read regression bounds judge context and defers an accounted failure without changing the wire', async () => {
  for (const failedJudge of [false, true]) {
    const f = await createCodexFixture();
    const judge = await createJevFixture();
    try {
      const manager = SessionManager.create(f.directory);
      manager.appendMessage({ role: 'user', content: 'Fix the product implementation and preserve the API.', timestamp: 1 });
      const ids = ['source', 'tests'].map((id, index) => {
        const call = { type: 'toolCall' as const, id: `${id}|fc_${id}`, name: 'read', arguments: { path: `${id}.py` } };
        manager.appendMessage({ ...assistant([call]), api: f.model.api, provider: f.model.provider, model: f.model.id,
          content: [{ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify({ ...seedReasoning, id: `rs_${id}` }) }, call] });
        return manager.appendMessage(result(call.id, (index === 0 ? 's' : 't').repeat(index === 0 ? 16927 : 11413)));
      });
      judge.respond((request) => ({ body: failedJudge ? { ...jevResponse(request), answers: {} } : jevResponse(request) }));
      let originalPayload: unknown;
      const run = await f.session((m) => [
        (pi) => { pi.on('before_provider_request', (event) => { originalPayload = structuredClone(event.payload); }); },
        createContextExtension(m, { policy: 'jev-select-v1', budget, selection, jev: judge.config }),
      ], manager);
      f.reportInputTokens(8000);
      await run.session.prompt('Establish usage.');
      await run.session.prompt('Continue.');
      assert.equal(f.requests.length, 2, JSON.stringify(records(manager, STOP_ENTRY)));
      assert.equal(judge.requests.length, 1);
      assert.deepEqual(Object.keys(judge.requests[0]!.questions), [ids[0]]);
      assert.deepEqual(records<{ omittedObservations: Array<{ evidenceId: string }> }>(manager, JUDGE_START_ENTRY)[0]!
        .omittedObservations.map((item) => item.evidenceId), [ids[1]]);
      assert.deepEqual(stableItems(f.requests[1]!), stableItems(originalPayload as CodexRequest));
      assert.equal(output(f.requests[1]!, 'tests').output, 't'.repeat(11413));
      if (failedJudge) {
        assert.deepEqual(f.requests[1], originalPayload);
        assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 0);
        const checkpoint = records<{ reconsideration: { deferral: { reason: string } } }>(manager, SELECTION_ENTRY)[0]!;
        assert.equal(checkpoint.reconsideration.deferral.reason, 'accounted-judge-failure');
      } else {
        assert.match(String(output(f.requests[1]!, 'source').output), /retired observation/);
        assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 1);
      }
      assert.equal(records(manager, STOP_ENTRY).length, 0);
      assert.deepEqual(run.errors, []);
    } finally { await judge.close(); await f.close(); }
  }
});

test('Codex grammar output uses the same exact retirement mapping through the real serializer', async () => {
  const f = await createCodexFixture();
  try {
    const manager = SessionManager.create(f.directory);
    const { a } = seed(manager, f.model, 'fixture_grammar');
    const grammar: ExtensionFactory = (pi) => pi.registerTool({
      name: 'fixture_grammar', label: 'Grammar fixture', description: 'Fixture only.', parameters: Type.Object({ path: Type.String() }),
      constrainedSampling: { type: 'grammar', variants: { openai_regex: '.*' } },
      async execute() { throw new Error('No tool should execute'); },
    });
    const { session, errors } = await f.session((m) => [grammar, createContextExtension(m, {
      policy: 'scripted-v1', budget, select: () => [a],
    })], manager, ['fixture_grammar']);
    await session.prompt('Continue.');
    assert.equal(f.requests.length, 1, JSON.stringify(records(manager, STOP_ENTRY)));
    assert.equal(output(f.requests[0]!, 'a').type, 'custom_tool_call_output');
    assert.match(String(output(f.requests[0]!, 'a').output), /retired observation/);
    assert.equal(f.requests[0]!.input.find((item) => item.type === 'custom_tool_call')?.input, 'a.txt');
    assert.deepEqual(errors, []);
  } finally { await f.close(); }
});

test('Codex budget, provenance and provider-map failures stop before HTTP dispatch or native edits', async () => {
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
      const { session } = await f.session((m) => [corrupt, createContextExtension(m, {
        policy: 'scripted-v1', budget: failure === 'missing-reserve' ? { contextLimit: 32768, marginTokens: 0 }
          : { ...budget, contextLimit: failure === 'budget' ? 100 : 32768 },
      })], manager);
      await session.prompt('Continue.');
      assert.equal(f.requests.length, 0, failure);
      assert.equal(records(manager, STOP_ENTRY).length, 1, failure);
      assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 0, failure);
    } finally { await f.close(); }
  }
});
