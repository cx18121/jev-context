import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pilotPlan, runPilot, PILOT } from './pilot.ts';

const args = process.argv.slice(2);
const suite = args.includes('--paired') ? 'paired-v1' : 'synthetic-v1';
if (new Set(args).size !== args.length || args.some((arg) => arg !== '--live' && arg !== '--paired')) {
  console.error('Usage: npm run pilot [-- --paired --live]. Live requests require TYPESAFE_API_KEY.');
  process.exitCode = 1;
} else if (!args.includes('--live')) {
  console.log(JSON.stringify({ mode: 'dry-run', ...pilotPlan(suite) }, null, 2));
} else if (!process.env.TYPESAFE_API_KEY?.trim()) {
  console.error('Live pilot needs TYPESAFE_API_KEY. Use npm run pilot:live or pilot:paired:live to load the ignored .env file. No requests sent.');
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const parent = fileURLToPath(new URL('../results/', import.meta.url));
  const directory = fileURLToPath(new URL(`../results/${suite}/`, import.meta.url));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const source = {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
    };
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const report = await runPilot(directory, {
      apiKey: process.env.TYPESAFE_API_KEY, retireBelow: 0.2, timeoutMs: PILOT.timeoutMs,
    }, controller.signal, source, suite);
    console.log(JSON.stringify({ directory, ...report }, null, 2));
    if (report.stopReason) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Pilot failed. Inspect the campaign journal before any further run.');
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
