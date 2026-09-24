import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { zstdDecompressSync } from 'node:zlib';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';

export interface CodexRequest {
  instructions: string;
  input: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** Real SDK/serializer, fake credentials and inference, loopback transport only. */
export async function createCodexFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jev-codex-'));
  const requests: CodexRequest[] = [];
  let inputTokens = 80;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const body = request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes;
    requests.push(JSON.parse(body.toString()) as CodexRequest);
    const id = requests.length;
    const output = [
      { type: 'reasoning', id: `rs_reply_${id}`, encrypted_content: `opaque_reply_${id}`, summary: [] },
      { type: 'message', id: `msg_reply_${id}`, role: 'assistant', phase: 'final_answer', status: 'completed',
        content: [{ type: 'output_text', text: 'fixture response', annotations: [] }] },
    ];
    const events: unknown[] = output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item }));
    events.push({ type: 'response.completed', response: { id: `response_${id}`, status: 'completed', output,
      usage: { input_tokens: inputTokens, output_tokens: 4, total_tokens: inputTokens + 4, input_tokens_details: { cached_tokens: Math.min(20, inputTokens) } } } });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
  });
  const fakeKey = `fake.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-only' } })).toString('base64')}.fake`;
  modelRuntime.registerProvider('jev-codex-fixture', {
    baseUrl: `http://127.0.0.1:${address.port}`, api: 'openai-codex-responses', apiKey: fakeKey,
    models: [{ id: 'fixture', name: 'Local Codex fixture', reasoning: true, input: ['text', 'image'],
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 32768, maxTokens: 1024,
      compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true,
        supportsToolSearch: true, supportsMidConvoSystemMessages: true },
    }],
  });
  const model = modelRuntime.getModel('jev-codex-fixture', 'fixture');
  if (!model) throw new Error('Missing Codex fixture model');
  const sessions: AgentSession[] = [];
  return {
    directory, requests, model,
    reportInputTokens(value: number) { inputTokens = value; },
    async session(factories: (manager: SessionManager) => ExtensionFactory[] = () => [],
      manager = SessionManager.create(directory, join(directory, 'sessions')), tools: string[] = []) {
      const settings = SettingsManager.inMemory({ transport: 'sse', cacheWarming: 'off', compaction: { enabled: false },
        retry: { enabled: false, provider: { maxRetries: 0 } } });
      const loader = new DefaultResourceLoader({
        cwd: directory, agentDir: join(directory, 'agent'), settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: factories(manager), systemPromptOverride: () => 'Local Codex integration fixture.',
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();
      const { session, extensionsResult } = await createAgentSession({
        cwd: directory, agentDir: join(directory, 'agent'), model, modelRuntime, sessionManager: manager,
        settingsManager: settings, resourceLoader: loader, tools, thinkingLevel: 'medium',
      });
      sessions.push(session);
      if (extensionsResult.errors.length) throw new Error(JSON.stringify(extensionsResult.errors));
      const errors: string[] = [];
      await session.bindExtensions({ onError: (error) => errors.push(error.error) });
      return { session, manager, errors };
    },
    async close() {
      for (const session of sessions) session.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
