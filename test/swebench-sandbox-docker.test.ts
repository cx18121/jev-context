import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { Sandbox, parseTask } from '../eval/swebench/sandbox.ts';

// Explicit opt-in. Uses a pulled pinned image, never credentials or inference.
const taskPath = process.env.JEV_SANDBOX_TASK;
const task = taskPath ? parseTask(JSON.parse(await readFile(taskPath, 'utf8'))) : undefined;
const options = { skip: !task, timeout: 60000 };

function removed(sandbox: Sandbox) {
  assert.equal(sandbox.dead, true);
  const result = spawnSync('docker', ['inspect', sandbox.name], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No such (object|container)/i);
}

const oversized = "python -c 'import sys; sys.stdout.write(\"x\"*100000); sys.stderr.write(\"y\"*100000)'";

test('Docker tool output is bounded and recoverable through the native bash tool', options, async () => {
  const sandbox = await new Sandbox(task!).start();
  try {
    const tool = createBashToolDefinition('/testbed', { exposeSessionEnvironment: false, operations: {
      async exec(command, _cwd, { onData, signal }) {
        const result = await sandbox.toolCommand(command, { onData, signal, seconds: 10 });
        return { exitCode: result.code };
      },
    } });
    const commands = [oversized, "python -c 'print(\"line\\n\"*5000)'", "python -c 'import sys; sys.stdout.buffer.write(bytes([255])*32000)'" ];
    if (task!.instanceId === 'sphinx-doc__sphinx-8638') {
      // Exact first-turn commands that previously killed both live arms, despite head -200.
      commands.push('grep -R "class.*Attribute\\|add_target_and_index\\|Py.*Variable\\|ObjectDescription" -n sphinx tests 2>/dev/null | head -200');
      commands.push('git status --short && grep -R "class.*Attribute\\|PyAttribute\\|add_target_and_index\\|autolink" -n sphinx tests 2>/dev/null | head -200');
    }
    for (const command of commands) {
      const result = await tool.execute('large', { command }, undefined, undefined, { cwd: '/HOST/NOT/USED' } as never);
      const text = result.content.map((block) => block.type === 'text' ? block.text : '').join('');
      assert.match(text, /Output truncated/);
      assert.ok(Buffer.byteLength(text) <= 32000 && text.split('\n').length <= 2000);
      assert.equal(result.details, undefined, 'Native accumulator must not truncate again or create a host output file');
      assert.equal(sandbox.dead, false);
    }
    await assert.rejects(tool.execute('nonzero', { command: `${oversized}; exit 7` }, undefined, undefined, {} as never),
      /Output truncated[\s\S]*Command exited with code 7/);
    const next = await sandbox.command('printf recovered');
    assert.equal(next.text, 'recovered');
    await sandbox.command('printf sentinel > jev-output-recovery.txt');
    assert.match(await sandbox.patch(), /\+sentinel/);
    await assert.rejects(sandbox.command('printf too-long', { maxBytes: 3 }), /Docker output ceiling/);
    removed(sandbox);
  } finally { await sandbox.close(); }
});

test('Docker infinite output still times out and removes the owned container', options, async () => {
  const sandbox = await new Sandbox(task!).start();
  try {
    await assert.rejects(sandbox.toolCommand('yes output & wait', { seconds: 1, onData() { assert.fail('No completed output expected'); } }),
      /timed out or was killed/);
    removed(sandbox);
  } finally { await sandbox.close(); }
});

test('Docker cancellation after starting a writer still removes the owned container', options, async () => {
  const sandbox = await new Sandbox(task!).start();
  try {
    await assert.rejects(sandbox.toolCommand('yes output & wait', { signal: AbortSignal.timeout(500), seconds: 10,
      onData() { assert.fail('No completed output expected'); } }));
    removed(sandbox);
  } finally { await sandbox.close(); }
});

test('Docker patch capture rejects oversized machine data rather than returning a partial patch', options, async () => {
  const sandbox = await new Sandbox(task!).start();
  try {
    await sandbox.command("python -c 'open(\"jev-large-patch.txt\",\"w\").write(\"x\"*600000)'");
    await assert.rejects(sandbox.patch(), /Docker output ceiling/);
    removed(sandbox);
  } finally { await sandbox.close(); }
});
