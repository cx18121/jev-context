import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';

export interface FixtureRequest {
  messages: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export async function createPiFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jev-context-'));
  const requests: FixtureRequest[] = [];
  const toolResponses: Array<Array<{ id: string; name: string; arguments: Record<string, unknown> }>> = [];
  let overflow = false;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body) as FixtureRequest);
    if (overflow) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'maximum context length exceeded', type: 'invalid_request_error', code: 'context_length_exceeded' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const calls = toolResponses.shift();
    const delta = calls ? {
      role: 'assistant',
      tool_calls: calls.map((call, index) => ({
        index, id: call.id, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    } : { role: 'assistant', content: 'fixture response' };
    for (const chunk of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 4, total_tokens: 84, prompt_tokens_details: { cached_tokens: 20 } } },
    ]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', ...chunk })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');

  const sessions: AgentSession[] = [];
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(directory, 'models-store.json'),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('jev-fixture', {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    api: 'openai-completions',
    apiKey: 'fixture-only-not-a-secret',
    models: [{
      id: 'fixture', name: 'Local fixture', reasoning: false, input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: 32768, maxTokens: 1024,
    }],
  });
  const model = modelRuntime.getModel('jev-fixture', 'fixture');
  if (!model) throw new Error('Missing fixture model');

  return {
    directory, requests, model,
    overflow() { overflow = true; },
    respondWithTools(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>) {
      toolResponses.push(calls);
    },
    async session(factories: ExtensionFactory[] = [], manager = SessionManager.create(directory, join(directory, 'sessions')), tools: string[] = []) {
      const settings = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false, provider: { maxRetries: 0 } },
      });
      const loader = new DefaultResourceLoader({
        cwd: directory, agentDir: join(directory, 'agent'), settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: factories,
        systemPromptOverride: () => 'Local integration fixture.',
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();
      const { session, extensionsResult } = await createAgentSession({
        cwd: directory, agentDir: join(directory, 'agent'), model, modelRuntime,
        sessionManager: manager, settingsManager: settings, resourceLoader: loader,
        tools, thinkingLevel: 'off',
      });
      sessions.push(session);
      if (extensionsResult.errors.length) throw new Error(JSON.stringify(extensionsResult.errors));
      const errors: string[] = [];
      await session.bindExtensions({ onError: (error) => errors.push(error.error) });
      return { session, manager, settings, errors };
    },
    async close() {
      for (const session of sessions) session.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
