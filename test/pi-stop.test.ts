import assert from 'node:assert/strict';
import test from 'node:test';
import { createPiFixture } from './pi-fixture.ts';

test('context abort prevents HTTP dispatch and leaves the session usable', async () => {
  const fixture = await createPiFixture();
  try {
    let shouldStop = true;
    let intercepted = 0;
    const { session, errors } = await fixture.session([(pi) => {
      pi.on('context', (_event, ctx) => {
        intercepted++;
        if (shouldStop) ctx.abort();
      });
    }]);
    await session.prompt('Must not reach the provider.');
    assert.equal(intercepted, 1);
    assert.equal(fixture.requests.length, 0);
    const stopped = session.messages.at(-1);
    assert.equal(stopped?.role, 'assistant');
    if (stopped?.role === 'assistant') {
      assert.equal(stopped.stopReason, 'error');
      assert.equal(stopped.errorMessage, 'This operation was aborted');
    }

    shouldStop = false;
    await session.prompt('Now send a normal request.');
    assert.equal(fixture.requests.length, 1);
    const completed = session.messages.at(-1);
    assert.equal(completed?.role, 'assistant');
    if (completed?.role === 'assistant') {
      assert.equal(completed.stopReason, 'stop');
      assert.equal(completed.usage.cacheRead, 20);
      assert.equal(completed.usage.output, 4);
    }
    assert.deepEqual(errors, []);
  } finally {
    await fixture.close();
  }
});

test('disabled native compaction does not summarize or retry provider overflow', async () => {
  const fixture = await createPiFixture();
  try {
    fixture.overflow();
    const { session, manager } = await fixture.session();
    const events: string[] = [];
    session.subscribe((event) => { events.push(event.type); });
    await session.prompt('Exercise provider overflow.');
    assert.equal(session.autoCompactionEnabled, false);
    assert.equal(fixture.requests.length, 1);
    assert.ok(!events.includes('compaction_start'));
    assert.ok(!manager.getEntries().some((entry) => entry.type === 'compaction'));
    const message = session.messages.at(-1);
    assert.equal(message?.role, 'assistant');
    if (message?.role === 'assistant') assert.equal(message.stopReason, 'error');
  } finally {
    await fixture.close();
  }
});
