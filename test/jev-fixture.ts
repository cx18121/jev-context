import { createServer } from 'node:http';
import { once } from 'node:events';
import { JEV_MODEL, type JevConfig, type JevRequest } from '../src/jev.ts';

export function jevResponse(request: JevRequest, probability = 0.1) {
  return {
    model: JEV_MODEL,
    answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: probability }])),
    usage: { input_tokens: 1000, output_tokens: 20 },
  };
}

export async function createJevFixture() {
  const requests: JevRequest[] = [];
  const headers: Array<string | undefined> = [];
  let respond: (request: JevRequest) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }> =
    (request) => ({ body: jevResponse(request) });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as JevRequest;
    requests.push(parsed);
    headers.push(request.headers.authorization);
    const reply = await respond(parsed);
    response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply.body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing judge fixture address');
  const config: JevConfig = {
    apiKey: 'local-fixture-only', retireBelow: 0.2, timeoutMs: 2000,
    endpoint: `http://127.0.0.1:${address.port}/v1/systemone`,
  };
  return {
    config, requests, headers,
    respond(handler: typeof respond) { respond = handler; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
