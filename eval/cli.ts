import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pilotPlan, runPilot, PILOT } from './pilot.ts';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--live')) {
  console.error('Usage: npm run pilot [-- --live]. Live requests require TYPESAFE_API_KEY.');
  process.exitCode = 1;
} else if (!args.length) {
  console.log(JSON.stringify({ mode: 'dry-run', ...pilotPlan() }, null, 2));
} else if (!process.env.TYPESAFE_API_KEY?.trim()) {
  console.error('Live pilot needs TYPESAFE_API_KEY. Use npm run pilot:live to load the ignored .env file. No requests sent.');
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const parent = fileURLToPath(new URL('../results/', import.meta.url));
  const directory = fileURLToPath(new URL('../results/synthetic-v1/', import.meta.url));
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
    }, controller.signal, source);
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
