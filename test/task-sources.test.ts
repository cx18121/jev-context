import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { INSTRUCTION_SOURCE_ENTRY, taskSources } from '../src/task-sources.ts';
import { applySketchUpdate, planSketchUpdate, sketchIsCurrent, validateTaskSketch } from '../src/task-sketch.ts';
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

test('tool-only activity leaves the sketch current; prose and instructions advance it', () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: 'user', content: 'Fix the parser.', timestamp: 1 });
  const original = taskSources(manager.getBranch());
  const sketch = applySketchUpdate(planSketchUpdate(original, null)!, { summary: 'Fix the parser.' }, original);
  const command = 'grep -n "restructuredtext.parse\\|doc_field\\|Variables" tests/test_domain_py.py | tail -60';
  for (let i = 0; i < 9; i++) {
    manager.appendMessage({ ...assistant(), content: [
      { type: 'text', text: ' \n ' },
      { type: 'thinking', thinking: 'private', thinkingSignature: 'opaque' },
      { type: 'toolCall', id: `grep${i}`, name: 'bash', arguments: { command } },
    ] });
    manager.appendMessage(result(`grep${i}`, 'Changing observations', { toolName: 'bash' }));
    assert.deepEqual(taskSources(manager.getBranch()), original);
    assert.equal(sketchIsCurrent(sketch, taskSources(manager.getBranch())), true);
  }
  manager.appendMessage({ role: 'bashExecution', command, output: 'Manual shell output', exitCode: 0,
    cancelled: false, truncated: false, timestamp: 2 });
  manager.appendCustomEntry('unrelated', { data: 'PRIVATE_METADATA' });
  assert.deepEqual(taskSources(manager.getBranch()), original);
  const text = `Inspecting the parser. Exact command: ${command}`;
  const proseId = manager.appendMessage({ ...assistant(), content: [{ type: 'text', text },
    { type: 'toolCall', id: 'mixed', name: 'bash', arguments: { command } }] });
  const systemId = manager.appendCustomEntry(INSTRUCTION_SOURCE_ENTRY, { version: 1, text: 'Do not edit tests.' });
  const userId = manager.appendMessage({ role: 'user', content: 'Fix only the Python domain.', timestamp: 3 });
  const changed = taskSources(manager.getBranch());
  assert.deepEqual(changed.slice(1), [
    { id: proseId, role: 'assistant', text },
    { id: systemId, role: 'system', text: 'Do not edit tests.' },
    { id: userId, role: 'user', text: 'Fix only the Python domain.' },
  ]);
  assert.deepEqual(validateTaskSketch(sketch, changed), sketch);
  assert.equal(sketchIsCurrent(sketch, changed), false);
  assert.deepEqual(planSketchUpdate(changed, sketch)!.sources.map((source) => source.id), [proseId, systemId, userId]);
});
