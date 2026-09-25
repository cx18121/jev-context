import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { INSTRUCTION_SOURCE_ENTRY, taskSources } from '../src/task-sources.ts';
import { applySketchUpdate, planSketchUpdate, sketchIsCurrent } from '../src/task-sketch.ts';
import { assistant, result } from './history-fixture.ts';

test('derived task sources normalize Unicode before hashing without changing the original history', () => {
  const manager = SessionManager.inMemory();
  const systemId = manager.appendCustomEntry(INSTRUCTION_SOURCE_ENTRY, { version: 1, text: 'System\ud800 rule' });
  const userId = manager.appendMessage({ role: 'user', content: 'Fix\udfff parser 😀', timestamp: 1 });
  manager.appendMessage({ ...assistant(), content: [
    { type: 'thinking', thinking: 'PRIVATE_REASONING', thinkingSignature: 'OPAQUE_SIGNATURE' },
    { type: 'text', text: 'Inspect\ud800 source' },
    { type: 'toolCall', id: 'read1', name: 'read', arguments: { path: 'PRIVATE_PATH' } },
  ] });
  manager.appendMessage(result('read1', 'PRIVATE_TOOL_BODY'));
  const original = structuredClone(manager.getBranch());
  const sources = taskSources(manager.getBranch());
  assert.deepEqual(sources.slice(0, 2), [
    { id: systemId, role: 'system', text: 'System� rule' },
    { id: userId, role: 'user', text: 'Fix� parser 😀' },
  ]);
  assert.equal(sources[2]!.text, 'Inspect� source');
  assert.doesNotMatch(JSON.stringify(sources), /PRIVATE_|OPAQUE_/);
  const sketch = applySketchUpdate(planSketchUpdate(sources, null)!, { summary: 'Fix the parser.' }, sources);
  assert.equal(sketchIsCurrent(sketch, taskSources(manager.getBranch())), true);
  assert.deepEqual(manager.getBranch(), original);
});
