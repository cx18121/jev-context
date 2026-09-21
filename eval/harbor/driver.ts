import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { createContextExtension, STOP_ENTRY, USAGE_ENTRY, type UsageRecord } from '../../src/extension.ts';
import { smokeCommand } from './script.ts';

export type SmokeMode = 'correct' | 'wrong' | 'budget-stop' | 'http-error';

/** Isolated Pi frontend. All inference is scripted on loopback; Harbor grades separately. */
export async function runSmoke(options: { workspace: string; artifacts: string; instruction: string; mode: SmokeMode }) {
  if (!['correct', 'wrong', 'budget-stop', 'http-error'].includes(options.mode)) throw new Error('Unknown smoke mode');
  const { workspace, artifacts, instruction, mode } = options;
  mkdirSync(artifacts, { mode: 0o700 });
  const eventsPath = join(artifacts, 'events.jsonl'), requestsPath = join(artifacts, 'requests.jsonl');
  for (const path of [eventsPath, requestsPath]) writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  let calls = 0;
  const errors: string[] = [];
  let session: AgentSession | undefined;
  let manager: SessionManager | undefined;
  let failure: string | null = null;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    appendFileSync(requestsPath, body + '\n');
    calls++;
    if (mode === 'http-error' || calls > 2) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Scripted smoke failure' } }));
      return;
    }
    const first = calls === 1;
    const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'smoke-call', type: 'function', function: {
      name: 'bash', arguments: JSON.stringify({ command: smokeCommand(mode === 'wrong' ? 'wrong' : 'correct') }),
    } }] } : { role: 'assistant', content: 'Scripted smoke task finished.' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 4, total_tokens: 84 } },
    ]) response.write(`data: ${JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 0, model: 'scripted-smoke', ...chunk })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing smoke endpoint');
    const agentDir = join(artifacts, 'pi');
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(agentDir, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
    });
    runtime.registerProvider('jev-smoke', {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'synthetic-no-credential',
      models: [{ id: 'scripted-smoke', name: 'Scripted smoke', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    });
    const model = runtime.getModel('jev-smoke', 'scripted-smoke');
    if (!model) throw new Error('Missing scripted model');
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } });
    const budget = { contextLimit: mode === 'budget-stop' ? 1 : 32768, marginTokens: 1024 };
    const loader = new DefaultResourceLoader({
      cwd: workspace, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [createContextExtension({ policy: 'oldest-first-v1', budget })],
    });
    await loader.reload();
    manager = SessionManager.create(workspace, join(artifacts, 'sessions'));
    const created = await createAgentSession({
      cwd: workspace, agentDir, model, modelRuntime: runtime, settingsManager: settings,
      sessionManager: manager, resourceLoader: loader, tools: ['read', 'bash', 'edit', 'write'], thinkingLevel: 'off',
    });
    session = created.session;
    if (created.extensionsResult.errors.length) throw new Error(JSON.stringify(created.extensionsResult.errors));
    await session.bindExtensions({ onError: (error) => errors.push(error.error) });
    session.subscribe((event) => {
      if (event.type !== 'message_update' && event.type !== 'tool_execution_update') appendFileSync(eventsPath, JSON.stringify(event) + '\n');
    });
    await session.prompt(instruction, { expandPromptTemplates: false });
    const last = session.messages.at(-1);
    const stopped = manager.getBranch().some((entry) => entry.type === 'custom' && entry.customType === STOP_ENTRY);
    const toolFailed = session.messages.some((message) => message.role === 'toolResult' && message.isError);
    if (errors.length || stopped || toolFailed || last?.role !== 'assistant' || last.stopReason !== 'stop') {
      throw new Error(`Pi smoke did not finish successfully (stop=${stopped}, toolError=${toolFailed}, extensionErrors=${errors.length})`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    session?.dispose();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    const records = (manager?.getBranch() ?? []).flatMap((entry) => entry.type === 'custom' && entry.customType === USAGE_ENTRY ? [entry.data as UsageRecord] : []);
    const totals = records.reduce((sum, record) => ({ input: sum.input + record.usage.input, output: sum.output + record.usage.output,
      cacheRead: sum.cacheRead + record.usage.cacheRead, cacheWrite: sum.cacheWrite + record.usage.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    writeFileSync(join(artifacts, 'usage.json'), JSON.stringify({
      measurementKind: 'scripted-fixture', mode, nodeVersion: process.version, piVersion: '0.85.1',
      modelCalls: calls, actualModelCostUsd: 0, syntheticUsage: totals,
      failure, extensionErrors: errors, records,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (failure) throw new Error(failure);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [workspace, artifacts, instructionFile, mode] = process.argv.slice(2);
  if (!workspace || !artifacts || !instructionFile || !mode || process.argv.length !== 6) throw new Error('Expected workspace artifacts instruction-file smoke-mode');
  await runSmoke({ workspace, artifacts, instruction: readFileSync(instructionFile, 'utf8'), mode: mode as SmokeMode });
}
