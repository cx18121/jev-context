import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent';
import type { SourceSnapshot } from '../contextbench.ts';

export interface AgentTask {
  instanceId: string;
  repo: string;
  baseCommit: string;
  image: string;
  problemStatement: string;
}

/** Reject evaluator fields instead of silently carrying them into agent artifacts. */
export function parseTask(value: unknown): AgentTask {
  assert.ok(value && typeof value === 'object');
  assert.deepEqual(Object.keys(value).sort(), ['baseCommit', 'image', 'instanceId', 'problemStatement', 'repo']);
  const task = value as AgentTask;
  assert.match(task.instanceId, /^[a-zA-Z0-9_.-]+__[a-zA-Z0-9_.-]+-\d+$/);
  assert.match(task.repo, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
  assert.match(task.baseCommit, /^[a-f0-9]{40}$/);
  assert.match(task.image, /^swebench\/sweb\.eval\.x86_64\.[a-zA-Z0-9_.-]+@sha256:[a-f0-9]{64}$/);
  assert.ok(typeof task.problemStatement === 'string' && task.problemStatement.trim().length > 0
    && Buffer.byteLength(task.problemStatement) <= 100000);
  return { ...task };
}

export function createArgs(name: string, task: AgentTask): string[] {
  assert.match(name, /^jev-eval-[a-f0-9-]+$/);
  parseTask(task);
  return ['create', '--name', name, '--pull=never', '--platform=linux/amd64', '--network=none',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=4g', '--cpus=2',
    '--label=jev.eval=swebench', '--workdir=/testbed', '--user=root',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=128m', '--env=PYTHONDONTWRITEBYTECODE=1',
    '--entrypoint=/bin/sleep', task.image, 'infinity'];
}

async function docker(args: string[], { signal, maxBytes = 1000000 }: { signal?: AbortSignal; maxBytes?: number } = {}) {
  signal?.throwIfAborted();
  return new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { failure = new Error('Docker output ceiling'); child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => failure ? reject(failure) : resolve({ code, text: Buffer.concat(chunks).toString() }));
  });
}

export function readPath(path: string): string {
  // Native Pi probes host path variants before invoking operations. Keep resolution invariant.
  assert.ok(typeof path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(path), 'Use a plain repository path');
  assert.ok(!path.split('/').includes('..') && !path.includes('//'), 'Parent traversal is unsupported');
  const absolute = posix.resolve('/testbed', path);
  assert.ok(absolute.startsWith('/testbed/'), 'Read must stay under /testbed');
  return absolute;
}

export class Sandbox {
  readonly name = `jev-eval-${randomUUID()}`;
  dead = false;
  configuration: unknown;
  private imageHead?: string;
  constructor(readonly task: AgentTask) { parseTask(task); }

  async start() {
    try {
      const created = await docker(createArgs(this.name, this.task), { signal: AbortSignal.timeout(30000) });
      assert.equal(created.code, 0, 'Docker create failed. Start Docker and pull the pinned image first.');
      assert.equal((await docker(['start', this.name], { signal: AbortSignal.timeout(30000) })).code, 0);
      const inspected = await docker(['inspect', this.name], { signal: AbortSignal.timeout(10000) });
      assert.equal(inspected.code, 0);
      const state = JSON.parse(inspected.text)[0];
      assert.equal(state.HostConfig.NetworkMode, 'none');
      assert.ok(!state.Mounts.some((m: { Type: string }) => m.Type === 'bind' || m.Type === 'volume'));
      // Native grading applies the agent patch to this prepared image, not a reset dataset tree.
      const base = await this.command(`git cat-file -e ${this.task.baseCommit}^{commit} && git diff --quiet HEAD -- && test -z "$(git status --porcelain)" && git rev-parse HEAD`, { seconds: 10 });
      assert.equal(base.code, 0, 'Task image must have a clean checkout and contain the source base');
      assert.match(base.text.trim(), /^[a-f0-9]{40}$/);
      this.imageHead = base.text.trim();
      this.configuration = { image: state.Image, network: 'none', mounts: state.Mounts,
        imageHead: this.imageHead, verifiedTreeBase: this.imageHead, sourceBase: this.task.baseCommit };
      return this;
    } catch (error) { await this.close(); throw error; }
  }

  private async exec(argv: string[], { signal, seconds = 120, maxBytes = 32000 }: { signal?: AbortSignal; seconds?: number; maxBytes?: number } = {}) {
    assert.ok(!this.dead, 'Task container is stopped');
    assert.ok(Number.isInteger(seconds) && seconds > 0 && seconds <= 120);
    const combined = AbortSignal.any([AbortSignal.timeout(seconds * 1000 + 5000), ...(signal ? [signal] : [])]);
    try {
      const result = await docker(['exec', '--workdir=/testbed', this.name, '/usr/bin/timeout', '--signal=KILL', `${seconds}s`, ...argv], { signal: combined, maxBytes });
      if ([124, 137, null].includes(result.code)) throw new Error('Container command timed out or was killed');
      return result;
    } catch (error) { await this.close(); throw error; }
  }

  async command(command: string, options: { signal?: AbortSignal; seconds?: number; maxBytes?: number; onData?: (data: Buffer) => void } = {}) {
    assert.ok(typeof command === 'string' && command.length <= 20000);
    const result = await this.exec(['/bin/bash', '--noprofile', '--norc', '-c', command], options);
    if (options.onData) {
      if (Buffer.byteLength(result.text) > 32000 || result.text.split('\n').length > 2000) {
        await this.close(); throw new Error('Tool output byte/line ceiling');
      }
      options.onData(Buffer.from(result.text));
    }
    return result;
  }

  async read(path: string, signal?: AbortSignal): Promise<Buffer> {
    assert.equal(path, readPath(path));
    // argv, not shell interpolation. Read the complete file or fail, never pre-truncate native reads.
    const program = 'import sys,base64,os,stat\np=sys.argv[1]\nassert stat.S_ISREG(os.stat(p).st_mode), "Not a regular file"\nwith open(p,"rb") as f: b=f.read(1048577)\nassert len(b)<=1048576, "Read exceeds 1 MiB"\nsys.stdout.write(base64.b64encode(b).decode())';
    const result = await this.exec(['python', '-c', program, path], { signal, seconds: 15, maxBytes: 1500000 });
    assert.equal(result.code, 0, `Container read failed: ${result.text.slice(0, 1000)}`);
    return Buffer.from(result.text, 'base64');
  }

  async snapshot(): Promise<{ source: SourceSnapshot; excluded: Record<string, string> }> {
    const program = await readFile(new URL('./snapshot.py', import.meta.url), 'utf8');
    const result = await this.exec(['python', '-c', program, this.task.baseCommit], { seconds: 120, maxBytes: 200000000 });
    assert.equal(result.code, 0, 'Base source snapshot failed');
    const { files, excluded } = JSON.parse(result.text);
    return { source: { root: '/testbed', cwd: '/testbed', revision: this.task.baseCommit, files }, excluded };
  }

  async patch() {
    assert.ok(this.imageHead, 'Task image has not been verified');
    const result = await this.command(`git add -N -- . && git diff --binary ${this.imageHead} --`, { seconds: 20, maxBytes: 500000 });
    assert.equal(result.code, 0, 'Patch capture failed');
    return result.text;
  }

  async close() {
    if (this.dead) return;
    this.dead = true;
    const removed = await docker(['rm', '-f', this.name], { signal: AbortSignal.timeout(30000) });
    assert.ok(removed.code === 0 || removed.text.includes('No such container'), 'Owned container cleanup failed');
  }
}

export function sandboxReadTool(sandbox: Pick<Sandbox, 'read'>, deadline: AbortSignal) {
  const tool = createReadToolDefinition('/testbed');
  return { ...tool, description: tool.description + ' Text-only sandbox reads under /testbed, plain paths, maximum file size 1 MiB.',
    executionMode: 'sequential' as const,
    async execute(...args: Parameters<typeof tool.execute>) {
      const [id, input, signal, update, context] = args;
      const absolute = readPath(input.path);
      const combined = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
      const native = createReadToolDefinition('/testbed', { operations: {
        async access(path) { assert.equal(path, absolute); combined.throwIfAborted(); },
        async readFile(path) { assert.equal(path, absolute); return sandbox.read(path, combined); },
      } });
      return native.execute(id, { ...input, path: absolute }, combined, update, { ...context, cwd: '/testbed' });
    },
  };
}
