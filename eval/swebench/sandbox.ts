import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent';
import type { SourceSnapshot } from '../contextbench.ts';
import { ToolOutput } from './tool-output.ts';

export interface SweTask {
  kind?: undefined;
  instanceId: string;
  repo: string;
  baseCommit: string;
  image: string;
  problemStatement: string;
}

/** A Long-Horizon Terminal-Bench task. Graded later from a committed image of the final container. */
export interface LhtbTask {
  kind: 'lhtb';
  instanceId: string;
  image: string;
  instruction: string;
  workdir: string;
  cpus: number;
  memoryMb: number;
}
export type AgentTask = SweTask | LhtbTask;

export const taskRoot = (task: AgentTask) => task.kind === 'lhtb' ? task.workdir : '/testbed';
export const taskInstruction = (task: AgentTask) => task.kind === 'lhtb' ? task.instruction : task.problemStatement;

/** Reject evaluator fields instead of silently carrying them into agent artifacts. */
export function parseTask(value: unknown): AgentTask {
  assert.ok(value && typeof value === 'object');
  if ((value as { kind?: unknown }).kind === 'lhtb') {
    assert.deepEqual(Object.keys(value).sort(), ['cpus', 'image', 'instanceId', 'instruction', 'kind', 'memoryMb', 'workdir']);
    const task = value as LhtbTask;
    assert.match(task.instanceId, /^lhtb__[a-z0-9_-]+$/);
    assert.match(task.image, /^[a-z0-9]+\/lhtb-[a-z0-9_-]+@sha256:[a-f0-9]{64}$/);
    assert.match(task.workdir, /^\/[a-z0-9_/-]+$/);
    assert.ok(Number.isInteger(task.cpus) && task.cpus >= 1 && task.cpus <= 8);
    assert.ok(Number.isInteger(task.memoryMb) && task.memoryMb >= 512 && task.memoryMb <= 16384);
    assert.ok(typeof task.instruction === 'string' && task.instruction.trim().length > 0 && Buffer.byteLength(task.instruction) <= 100000);
    return { ...task };
  }
  assert.deepEqual(Object.keys(value).sort(), ['baseCommit', 'image', 'instanceId', 'problemStatement', 'repo']);
  const task = value as SweTask;
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
  const lhtb = task.kind === 'lhtb';
  return ['create', '--name', name, '--pull=never', '--platform=linux/amd64', '--network=none',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', `--pids-limit=${lhtb ? 512 : 128}`,
    `--memory=${lhtb ? `${task.memoryMb}m` : '4g'}`, `--cpus=${lhtb ? task.cpus : 2}`,
    '--label=jev.eval=swebench', `--workdir=${taskRoot(task)}`, '--user=root',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=128m', '--env=PYTHONDONTWRITEBYTECODE=1',
    '--entrypoint=/bin/sleep', task.image, 'infinity'];
}

async function docker(args: string[], { signal, maxBytes = 1000000, output }: { signal?: AbortSignal; maxBytes?: number; output?: ToolOutput } = {}) {
  signal?.throwIfAborted();
  return new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', (chunk: Buffer) => {
      if (output) { output.append(chunk); return; }
      size += chunk.length;
      if (size > maxBytes) { failure = new Error('Docker output ceiling'); child.kill('SIGKILL'); return; }
      chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => failure ? reject(failure) : resolve({ code, text: output ? output.text() : Buffer.concat(chunks).toString() }));
  });
}

export function readPath(path: string, root = '/testbed'): string {
  // Native Pi probes host path variants before invoking operations. Keep resolution invariant.
  assert.ok(typeof path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(path), 'Use a plain repository path');
  assert.ok(!path.split('/').includes('..') && !path.includes('//'), 'Parent traversal is unsupported');
  const absolute = posix.resolve(root, path);
  assert.ok(absolute.startsWith(`${root}/`), `Read must stay under ${root}`);
  return absolute;
}

export class Sandbox {
  readonly name = `jev-eval-${randomUUID()}`;
  dead = false;
  configuration: unknown;
  private imageHead?: string;
  readonly root: string;
  constructor(readonly task: AgentTask) { parseTask(task); this.root = taskRoot(task); }

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
      if (this.task.kind === 'lhtb') {
        this.configuration = { image: state.Image, network: 'none', mounts: state.Mounts, workdir: this.root };
        return this;
      }
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

  private async exec(argv: string[], { signal, seconds = 120, maxBytes = 32000, output }: { signal?: AbortSignal; seconds?: number; maxBytes?: number; output?: ToolOutput } = {}) {
    assert.ok(!this.dead, 'Task container is stopped');
    assert.ok(Number.isInteger(seconds) && seconds > 0 && seconds <= 120);
    const combined = AbortSignal.any([AbortSignal.timeout(seconds * 1000 + 5000), ...(signal ? [signal] : [])]);
    // Long LHTB runs keep their container through command timeouts and run deadlines, so the agent
    // sees exit 124 and the final state can still be committed. SWE-bench runs keep the strict policy.
    const lenient = this.task.kind === 'lhtb';
    try {
      const result = await docker(['exec', `--workdir=${this.root}`, this.name, '/usr/bin/timeout', '--signal=KILL', `${seconds}s`, ...argv], { signal: combined, maxBytes, output });
      if (lenient && output && [124, 137].includes(result.code!)) return result;
      if ([124, 137, null].includes(result.code)) throw new Error('Container command timed out or was killed');
      return result;
    } catch (error) {
      if (!(lenient && signal?.aborted)) await this.close();
      throw error;
    }
  }

  async command(command: string, options: { signal?: AbortSignal; seconds?: number; maxBytes?: number } = {}) {
    assert.ok(typeof command === 'string' && command.length <= 20000);
    return this.exec(['/bin/bash', '--noprofile', '--norc', '-c', command], options);
  }

  async toolCommand(command: string, options: { signal?: AbortSignal; seconds?: number; onData: (data: Buffer) => void }) {
    assert.ok(typeof command === 'string' && command.length <= 20000);
    const result = await this.exec(['/bin/bash', '--noprofile', '--norc', '-c', command], { ...options, output: new ToolOutput() });
    options.onData(Buffer.from(result.text));
    return result;
  }

  async read(path: string, signal?: AbortSignal): Promise<Buffer> {
    assert.equal(path, readPath(path, this.root));
    // argv, not shell interpolation. Read the complete file or fail, never pre-truncate native reads.
    const program = 'import sys,base64,os,stat\np=sys.argv[1]\nassert stat.S_ISREG(os.stat(p).st_mode), "Not a regular file"\nwith open(p,"rb") as f: b=f.read(1048577)\nassert len(b)<=1048576, "Read exceeds 1 MiB"\nsys.stdout.write(base64.b64encode(b).decode())';
    const result = await this.exec(['python', '-c', program, path], { signal, seconds: 15, maxBytes: 1500000 });
    assert.equal(result.code, 0, `Container read failed: ${result.text.slice(0, 1000)}`);
    return Buffer.from(result.text, 'base64');
  }

  async snapshot(): Promise<{ source: SourceSnapshot; excluded: Record<string, string> }> {
    assert.ok(this.task.kind !== 'lhtb', 'Source snapshots are SWE-bench only');
    const program = await readFile(new URL('./snapshot.py', import.meta.url), 'utf8');
    const result = await this.exec(['python', '-c', program, this.task.baseCommit], { seconds: 120, maxBytes: 200000000 });
    assert.equal(result.code, 0, 'Base source snapshot failed');
    const { files, excluded } = JSON.parse(result.text);
    return { source: { root: '/testbed', cwd: '/testbed', revision: this.task.baseCommit, files }, excluded };
  }

  /** Preserve the final container, including listed artifacts, for grading outside the runner. */
  async commitFinal(tag: string) {
    assert.ok(this.task.kind === 'lhtb' && !this.dead);
    assert.match(tag, /^jev-lhtb-final:[a-z0-9-]+$/);
    const committed = await docker(['commit', this.name, tag], { signal: AbortSignal.timeout(600000) });
    assert.equal(committed.code, 0, 'Final container commit failed');
    return committed.text.trim();
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

export function sandboxReadTool(sandbox: Pick<Sandbox, 'read' | 'root'>, deadline: AbortSignal) {
  const root = sandbox.root;
  const tool = createReadToolDefinition(root);
  return { ...tool, description: tool.description + ` Text-only sandbox reads under ${root}, plain paths, maximum file size 1 MiB.`,
    executionMode: 'sequential' as const,
    async execute(...args: Parameters<typeof tool.execute>) {
      const [id, input, signal, update, context] = args;
      const absolute = readPath(input.path, root);
      const combined = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
      const native = createReadToolDefinition(root, { operations: {
        async access(path) { assert.equal(path, absolute); combined.throwIfAborted(); },
        async readFile(path) { assert.equal(path, absolute); return sandbox.read(path, combined); },
      } });
      return native.execute(id, { ...input, path: absolute }, combined, update, { ...context, cwd: root });
    },
  };
}
