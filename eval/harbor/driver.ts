import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runScriptedPi } from '../scripted-pi.ts';
import { smokeCommand } from './script.ts';

export type SmokeMode = 'correct' | 'wrong' | 'budget-stop' | 'http-error';

export async function runSmoke(options: { workspace: string; artifacts: string; instruction: string; mode: SmokeMode }) {
  if (!['correct', 'wrong', 'budget-stop', 'http-error'].includes(options.mode)) throw new Error('Unknown smoke mode');
  await runScriptedPi({ ...options, toolTurns: [[{ name: 'bash', arguments: {
    command: smokeCommand(options.mode === 'wrong' ? 'wrong' : 'correct'),
  } }]] });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [workspace, artifacts, instructionFile, mode] = process.argv.slice(2);
  if (!workspace || !artifacts || !instructionFile || !mode || process.argv.length !== 6) throw new Error('Expected workspace artifacts instruction-file smoke-mode');
  await runSmoke({ workspace, artifacts, instruction: readFileSync(instructionFile, 'utf8'), mode: mode as SmokeMode });
}
