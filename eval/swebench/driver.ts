import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runScriptedPi } from '../scripted-pi.ts';

export const READ_FILE = 'sympy/__init__.py';
export const MARKER = '# jev scripted smoke: deliberately no functional fix';

/** A read followed by a harmless edit. This is a negative grading control, not a solver. */
export async function runNativeSmoke(options: { workspace: string; artifacts: string; instruction: string; revision: string }) {
  const { workspace, revision } = options;
  await runScriptedPi({
    ...options, mode: 'native-negative-control',
    source: { root: workspace, cwd: workspace, revision, files: { [READ_FILE]: readFileSync(join(workspace, READ_FILE), 'utf8') } },
    toolTurns: [
      [{ name: 'read', arguments: { path: READ_FILE, limit: 40 } }],
      [{ name: 'bash', arguments: { command: `printf '\\n${MARKER}\\n' >> ${READ_FILE}` } }],
    ],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [workspace, artifacts, instructionFile, revision] = process.argv.slice(2);
  if (!workspace || !artifacts || !instructionFile || !revision || process.argv.length !== 6) throw new Error('Expected workspace artifacts instruction-file base-revision');
  await runNativeSmoke({ workspace, artifacts, instruction: readFileSync(instructionFile, 'utf8'), revision });
}
