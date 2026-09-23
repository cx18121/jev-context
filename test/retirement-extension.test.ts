import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { measureRequest } from '../src/budget.ts';
import { createContextExtension, STOP_ENTRY, USAGE_ENTRY, type UsageRecord } from '../src/extension.ts';
import { SELECTION_ENTRY, readHistory, type SelectionRecord } from '../src/history.ts';
import { seedHistory } from './history-fixture.ts';
import { createPiFixture, type FixtureRequest } from './pi-fixture.ts';

const roomy = { contextLimit: 32768, marginTokens: 1024 };
function records(manager: SessionManager, type: string) {
  return manager.getBranch().filter((entry) => entry.type === 'custom' && entry.customType === type);
}
function tool(request: FixtureRequest, callId: string) {
  const found = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === callId);
  assert.ok(found);
  return found;
}
function required(fixture: Awaited<ReturnType<typeof createPiFixture>>, request: FixtureRequest) {
  const size = measureRequest(request, fixture.model, roomy);
  return size.inputEstimate + size.outputReserve + size.marginTokens;
}

test('pressure retirement changes only selected wire text, persists before dispatch, and replays on resume', async () => {
  const fixture = await createPiFixture();
  try {
    const controlManager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seedHistory(controlManager);
    const control = await fixture.session((manager) => [createContextExtension(manager, { policy: 'oldest-first-v1', budget: roomy })], controlManager, ['read']);
    await control.session.prompt('Continue.');
    assert.equal(fixture.requests.length, 1);
    assert.equal(records(controlManager, SELECTION_ENTRY).length, 0);
    const fullRequest = structuredClone(fixture.requests[0]!);
    assert.ok(Array.isArray(fullRequest.tools) && fullRequest.tools.length > 0);
    const budget = { ...roomy, contextLimit: required(fixture, fullRequest) - 1 };

    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const { oldId } = seedHistory(manager);
    const file = manager.getSessionFile()!;
    const originalLines = (await readFile(file, 'utf8')).trim().split('\n');
    let recordedAtDispatch = false;
    const selected = await fixture.session((manager) => [
      createContextExtension(manager, { policy: 'oldest-first-v1', budget }),
      (pi) => { pi.on('before_provider_request', () => {
        recordedAtDispatch = records(manager, SELECTION_ENTRY).length === 1;
      }); },
    ], manager, ['read']);
    await selected.session.prompt('Continue.');
    assert.equal(fixture.requests.length, 2);
    assert.equal(recordedAtDispatch, true);
    const request = fixture.requests[1]!;
    const expected = structuredClone(fullRequest);
    tool(expected, 'old').content = tool(request, 'old').content;
    assert.deepEqual(request, expected);
    assert.match(String(tool(request, 'old').content), /retired observation/);
    assert.equal(measureRequest(request, fixture.model, budget).fits, true);
    const selection = records(manager, SELECTION_ENTRY)[0];
    assert.ok(selection?.type === 'custom');
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, [oldId]);
    assert.equal((selection.data as SelectionRecord).policy, 'oldest-first-v1');
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    for (const line of originalLines) assert.ok(lines.includes(line));
    const usage = records(manager, USAGE_ENTRY)[0];
    assert.ok(usage?.type === 'custom');
    assert.deepEqual((usage.data as UsageRecord).budget, measureRequest(request, fixture.model, budget));
    selected.session.dispose();

    const reopened = SessionManager.open(file);
    const resumed = await fixture.session((manager) => [createContextExtension(manager, { policy: 'oldest-first-v1', budget })], reopened, ['read']);
    await resumed.session.prompt('Continue again.');
    assert.equal(fixture.requests.length, 3);
    assert.deepEqual(fixture.requests[2]!.messages.slice(0, request.messages.length), request.messages);
    assert.equal(records(reopened, SELECTION_ENTRY).length, 1);
    assert.deepEqual([...control.errors, ...selected.errors, ...resumed.errors], []);
  } finally { await fixture.close(); }
});

test('pressure from actual tool execution retires only previously observed exchanges', async () => {
  const fixture = await createPiFixture();
  try {
    await writeFile(join(fixture.directory, 'a.txt'), 'A'.repeat(2000));
    await writeFile(join(fixture.directory, 'b.txt'), 'B'.repeat(2000));
    function queueCalls() {
      fixture.respondWithTools([{ id: 'a', name: 'read', arguments: { path: 'a.txt' } }]);
      fixture.respondWithTools([{ id: 'b', name: 'read', arguments: { path: 'b.txt' } }]);
    }
    queueCalls();
    const control = await fixture.session((manager) => [createContextExtension(manager, { policy: 'scripted-v1', budget: roomy })], undefined, ['read']);
    await control.session.prompt('Read a.txt then b.txt.');
    assert.equal(fixture.requests.length, 3);
    const budget = { ...roomy, contextLimit: required(fixture, fixture.requests[2]!) - 1 };
    assert.ok(required(fixture, fixture.requests[1]!) < budget.contextLimit);
    queueCalls();
    const selected = await fixture.session((manager) => [createContextExtension(manager, { policy: 'oldest-first-v1', budget })], undefined, ['read']);
    await selected.session.prompt('Read a.txt then b.txt.');
    assert.equal(fixture.requests.length, 6);
    assert.deepEqual(fixture.requests[3], fixture.requests[0]);
    assert.deepEqual(fixture.requests[4], fixture.requests[1]);
    assert.equal(tool(fixture.requests[4]!, 'a').content, 'A'.repeat(2000));
    assert.match(String(tool(fixture.requests[5]!, 'a').content), /retired observation/);
    assert.equal(tool(fixture.requests[5]!, 'b').content, 'B'.repeat(2000));
    assert.equal(records(selected.manager, SELECTION_ENTRY).length, 1);
    assert.equal(records(selected.manager, STOP_ENTRY).length, 0);
    assert.deepEqual([...control.errors, ...selected.errors], []);
  } finally { await fixture.close(); }
});

test('cannot-fit retirement aborts without dispatch or any partial selection', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seedHistory(manager);
    const originals = structuredClone(manager.getBranch().filter((entry) => entry.type === 'message'));
    const { session, errors } = await fixture.session((manager) => [createContextExtension(manager, {
      policy: 'oldest-first-v1', budget: { contextLimit: 100, marginTokens: 0 },
    })], manager);
    await session.prompt('Protected material cannot fit.');
    assert.equal(fixture.requests.length, 0);
    assert.equal(records(manager, SELECTION_ENTRY).length, 0);
    assert.deepEqual(manager.getBranch().filter((entry) => entry.type === 'message').slice(0, originals.length), originals);
    const stopped = records(manager, STOP_ENTRY)[0];
    assert.ok(stopped?.type === 'custom');
    assert.equal((stopped.data as { kind: string }).kind, 'budget');
    const usage = records(manager, USAGE_ENTRY)[0];
    assert.ok(usage?.type === 'custom');
    const data = usage.data as UsageRecord;
    assert.equal(data.budget?.fits, false);
    assert.equal(data.managerStopped, true);
    assert.equal(data.responseReceived, false);
    assert.equal(data.usageAvailable, false);
    assert.deepEqual(errors, []);
  } finally { await fixture.close(); }
});

test('a provider mapping mismatch stops explicitly instead of being swallowed and dispatched', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seedHistory(manager);
    const { session, errors } = await fixture.session((manager) => [
      (pi) => { pi.on('before_provider_request', (event) => {
        const payload = structuredClone(event.payload) as FixtureRequest;
        tool(payload, 'old').tool_call_id = 'rewritten-id';
        return payload;
      }); },
      createContextExtension(manager, { policy: 'oldest-first-v1', budget: { contextLimit: 100, marginTokens: 0 } }),
    ], manager);
    await session.prompt('Reject the mismatched mapping.');
    assert.equal(fixture.requests.length, 0);
    assert.equal(records(manager, SELECTION_ENTRY).length, 0);
    const stopped = records(manager, STOP_ENTRY)[0];
    assert.ok(stopped?.type === 'custom');
    assert.equal((stopped.data as { kind: string }).kind, 'invalid');
    assert.match((stopped.data as { reason: string }).reason, /unique provider tool result/);
    assert.deepEqual(errors, []);
  } finally { await fixture.close(); }
});
