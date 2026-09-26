import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArgs, parseTask, readPath, sandboxReadTool } from '../eval/swebench/sandbox.ts';

const task = { instanceId: 'sympy__sympy-13551', repo: 'sympy/sympy', baseCommit: '9476425b9e34363c2d9ac38e9f04aa75ae54a775',
  image: 'swebench/sweb.eval.x86_64.sympy_1776_sympy-13551@sha256:fbedc1f2698e3d205eb1abcd43a4f1d2f38d6b8a40909a925eaa0a17342c56a7', problemStatement: 'Local fixture only.' };

test('agent task rejects evaluator data and unpinned images', () => {
  assert.deepEqual(parseTask(task), task);
  for (const invalid of [{ ...task, patch: 'gold' }, { ...task, image: 'image:latest' }, { ...task, baseCommit: 'HEAD; cmd' },
    { ...task, problemStatement: '' }, { ...task, repo: undefined }]) assert.throws(() => parseTask(invalid));
  const args = createArgs('jev-eval-abcd', task);
  assert.ok(args.includes('--network=none') && args.includes('--pull=never') && args.includes('--cap-drop=ALL'));
  assert.ok(!args.some((a) => a === '-v' || a.startsWith('--mount')));
  assert.throws(() => createArgs('unowned-container', task));
});

test('sandbox read paths do not resolve shorthand, host paths, or native Unicode variants', () => {
  assert.equal(readPath('sympy/core/basic.py'), '/testbed/sympy/core/basic.py');
  assert.equal(readPath('/testbed/sympy/core/basic.py'), '/testbed/sympy/core/basic.py');
  for (const path of ['~/.env', '@secret', '../secret', '/etc/passwd', '/testbed//x', 'x; echo secret', 'foo bar', 'café.py', '/testbed']) {
    assert.throws(() => readPath(path));
  }
});

test('native read uses container operations despite host context, preserving exact footers', async () => {
  const paths: string[] = [];
  const tool = sandboxReadTool({ root: '/testbed', async read(path, signal) {
    paths.push(path); signal?.throwIfAborted(); return Buffer.from('one\ntwo\nthree\n');
  } }, new AbortController().signal);
  const result = await tool.execute('call', { path: 'src/a.py', offset: 2, limit: 1 }, undefined, undefined,
    { cwd: '/HOST/SHOULD/NEVER/BE/READ' } as never);
  assert.deepEqual(paths, ['/testbed/src/a.py']);
  assert.deepEqual(result.content, [{ type: 'text', text: 'two\n\n[2 more lines in file. Use offset=3 to continue.]' }]);
  const aborted = AbortSignal.abort();
  await assert.rejects(tool.execute('aborted', { path: 'src/a.py' }, aborted, undefined, {} as never));
  assert.equal(paths.length, 1);
});
