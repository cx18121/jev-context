// One paired development task. Gold data is deliberately not an input to this runner.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAgentSession, createBashToolDefinition, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createContextExtension, JUDGE_START_ENTRY, JUDGE_RESULT_ENTRY, STOP_ENTRY, USAGE_ENTRY } from '../../src/extension.ts';
import { SELECTION_ENTRY } from '../../src/history.ts';
import { JEV_ENDPOINT, JEV_MODEL } from '../../src/jev.ts';
import { Sandbox, parseTask, sandboxReadTool } from './sandbox.ts';
import { captureRequest } from '../contextbench.ts';
import { BRIEF_START_ENTRY, BRIEF_RESULT_ENTRY } from '../../src/brief-session.ts';
import { scriptedBrief } from '../../test/brief-fixture.ts';

process.umask(0o077);
const [mode, taskFile, output, ...extra] = process.argv.slice(2);
assert.ok(['--local', '--local-invalid-usage', '--local-judge-failure', '--local-request-cap', '--live'].includes(mode)
  && taskFile && output && extra.length === 0, 'Usage: run.mjs MODE agent-task.json NEW_OUTPUT_DIRECTORY');
const live = mode === '--live';
assert.ok(!live, 'Live selector runs require an explicitly approved brief model and separately guarded brief transport. Local modes remain available.');
const task = parseTask(JSON.parse(await readFile(taskFile, 'utf8')));
const root = new URL('./', import.meta.url);
const run = pathToFileURL(resolve(output) + '/');
await mkdir(run, { mode: 0o700 });
const save = (name, data) => writeFile(new URL(name, run), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const sha = (data) => createHash('sha256').update(data).digest('hex');
const pkg = JSON.parse(await readFile(new URL('../../node_modules/@earendil-works/pi-coding-agent/package.json', root)));
assert.equal(pkg.version, '0.87.1');
const catalog = JSON.parse(await readFile(new URL('../../node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json', root)));
const pinned = catalog['openai-codex-responses']['gpt-5.6-sol'];
const prices = pinned.cost;
const bounds = { requestsPerArm: mode === '--local-request-cap' ? 2 : 24, judgeRequests: 24, requestMs: 90000,
  runMs: 2400000, toolSeconds: 120, requestBytes: 180000, responseBytes: 512000, catalogStopUsd: 3 };
const budget = { contextLimit: 180000, marginTokens: 1024, outputReserveTokens: 4096 };
const selection = { archiveLimit: 4, restoreAtOrAbove: 0.8, workingContextLimit: 24576 };
const judgePolicy = { retireBelow: 0.2, timeoutMs: 15000 };
const systemPrompt = 'Fix the supplied Python repository issue in /testbed. Use read to inspect source files, with offset/limit for focused reads. Use bash to search, edit, and test. Commands execute in an isolated offline container. Do not commit. Keep each command output below 32000 bytes and 2000 lines, and each command below 120 seconds. Use the source and available tests, not network access. Finish with a concise summary of the fix and tests.';
const report = { developmentOnly: true, mode, completed: false, accountingComplete: true, arms: [], requests: [], judgeDispatches: 0 };
const deadline = AbortSignal.timeout(bounds.runMs);
const nativeFetch = globalThis.fetch;
let runtime, server, model, baseUrl, judgeEndpoint, activeArm, fixtureTurn, sourceSnapshot, fixturePaths;
const spent = () => report.requests.reduce((n, r) => n + (r.usage?.catalogCostUsd ?? 0), 0)
  + report.judgeDispatches * 64000 * 0.042 / 1e6;
let jevKey = 'local-fake-key';
const errorText = (e) => e instanceof assert.AssertionError ? e.message.split('\n')[0] : String(e.message);

function validatedUsage(raw) {
  const integer = (n) => Number.isSafeInteger(n) && n >= 0;
  assert.ok(raw && [raw.input_tokens, raw.output_tokens, raw.total_tokens, raw.input_tokens_details?.cached_tokens].every(integer), 'Missing/invalid provider usage');
  const cached = raw.input_tokens_details.cached_tokens;
  const write = raw.input_tokens_details.cache_write_tokens ?? 0;
  assert.ok(integer(write) && cached + write <= raw.input_tokens, 'Invalid provider cache counts');
  assert.equal(raw.total_tokens, raw.input_tokens + raw.output_tokens, 'Invalid provider total');
  assert.ok(raw.input_tokens > 0 && raw.input_tokens < 272000, 'Unsupported pricing tier or empty usage');
  const uncached = raw.input_tokens - cached - write;
  const cost = (uncached * prices.input + cached * prices.cacheRead + write * prices.cacheWrite + raw.output_tokens * prices.output) / 1e6;
  return { input: raw.input_tokens, output: raw.output_tokens, cached, write, uncached, catalogCostUsd: cost };
}
function tapResponse(response, record, controller) {
  if (!response.ok || !response.body) return response;
  let partial = '', bytes = 0, terminal = false;
  const decoder = new TextDecoder();
  function frames(text, eof = false) {
    partial += text;
    if (eof && partial.trim()) partial += '\n\n';
    let end;
    while ((end = partial.indexOf('\n\n')) !== -1) {
      const frame = partial.slice(0, end); partial = partial.slice(end + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n').trim();
      if (!data || data === '[DONE]' || terminal) continue;
      const event = JSON.parse(data);
      if (['response.completed', 'response.done', 'response.incomplete'].includes(event.type)) {
        terminal = true; record.rawUsage = event.response?.usage ?? null;
        record.usage = validatedUsage(record.rawUsage);
        record.providerStatus = event.response?.status;
      }
    }
  }
  return new Response(response.body.pipeThrough(new TransformStream({
    transform(chunk, out) {
      bytes += chunk.byteLength;
      if (bytes > bounds.responseBytes) { controller.abort(); throw new Error('Response size ceiling'); }
      frames(decoder.decode(chunk, { stream: true })); out.enqueue(chunk);
    }, flush() { frames(decoder.decode(), true); },
  })), { status: response.status, headers: response.headers });
}
function withoutToolText(body) {
  return { ...body, input: body.input.map((i) => i.type === 'function_call_output' || i.type === 'custom_tool_call_output' ? { ...i, output: '<text>' } : i) };
}
function fixtureOutput(turn) {
  const id = `${activeArm}_${turn}`;
  const calls = [
    { name: 'read', args: { path: fixturePaths[0], limit: 100 } },
    { name: 'read', args: { path: fixturePaths[1], limit: 100 } },
    { name: 'bash', args: { command: 'git rev-parse HEAD' } },
    { name: 'bash', args: { command: "printf 'local negative control\\n' > jev-local-negative.txt" } },
  ];
  const output = [{ type: 'reasoning', id: `rs_${id}`, encrypted_content: `FAKE_${id}`, summary: [] }];
  if (turn <= calls.length) output.push({ type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: calls[turn - 1].name, arguments: JSON.stringify(calls[turn - 1].args), status: 'completed' });
  else output.push({ type: 'message', id: `msg_${id}`, role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: 'Local negative control finished.', annotations: [] }] });
  return output;
}
async function setup() {
  const options = { modelsPath: null, modelsStorePath: fileURLToPath(new URL('models-store.json', run)), allowModelNetwork: false, refreshOnCreate: false };
  if (!live) {
    server = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const c of req) chunks.push(c);
        const bytes = Buffer.concat(chunks);
        const body = JSON.parse((req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString());
        assert.equal(req.method, 'POST');
        if (req.url === '/judge') {
          if (mode === '--local-judge-failure') { res.writeHead(503); res.end('{}'); return; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ model: JEV_MODEL, answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: fixtureTurn >= 4 ? 0.95 : 0.1 }])), usage: { input_tokens: 5000, output_tokens: 5 } })); return;
        }
        assert.equal(req.url, '/codex/responses');
        const output = fixtureOutput(fixtureTurn);
        // Pressure first retires evidence; the third response establishes restoration headroom.
        const inputTokens = fixtureTurn < 3 ? 30000 : 10000;
        const usage = { input_tokens: inputTokens, output_tokens: 200, total_tokens: inputTokens + 200, input_tokens_details: { cached_tokens: mode === '--local-invalid-usage' ? inputTokens + 1 : 1024 } };
        const events = output.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item }));
        events.push({ type: fixtureTurn % 2 ? 'response.done' : 'response.completed', response: { id: randomUUID(), status: 'completed', output, usage } });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(events.map((e) => JSON.stringify(e, null, 2).split('\n').map((l) => `data: ${l}`).join('\n')).join('\n\n'));
      } catch { res.writeHead(500); res.end('Local fixture failure'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`; judgeEndpoint = `${baseUrl}/judge`;
    runtime = await ModelRuntime.create({ ...options, credentials: new InMemoryCredentialStore() });
    const fakeKey = `fake.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-only' } })).toString('base64')}.fake`;
    runtime.registerProvider('jev-pair-fixture', { baseUrl, api: 'openai-codex-responses', apiKey: fakeKey, models: [{ ...pinned, id: 'gpt-5.6-sol', baseUrl }] });
    model = runtime.getModel('jev-pair-fixture', 'gpt-5.6-sol');
  } else {
    // Read exactly the authorized judge key; never load the file into process.env or Docker.
    jevKey = parseEnv(await readFile(new URL('../../.env', root), 'utf8')).TYPESAFE_API_KEY;
    assert.ok(jevKey?.trim(), 'Missing TYPESAFE_API_KEY');
    runtime = await ModelRuntime.create(options);
    model = runtime.getModel('openai-codex', 'gpt-5.6-sol');
    assert.ok(model && model.baseUrl === 'https://chatgpt.com/backend-api');
    baseUrl = model.baseUrl; judgeEndpoint = JEV_ENDPOINT;
  }
  assert.ok(model && model.api === 'openai-codex-responses'); model = { ...model, cost: prices };
  // Judge alone uses global fetch. Coding traffic uses the per-request guard below.
  globalThis.fetch = async (url, init) => {
    if (String(url) !== judgeEndpoint) return nativeFetch(url, init); // Auth refresh remains owned by ModelRuntime.
    assert.equal(activeArm, 'selector');
    assert.ok(report.judgeDispatches < bounds.judgeRequests && !deadline.aborted && spent() < bounds.catalogStopUsd);
    assert.equal(init.method, 'POST');
    assert.ok(Buffer.byteLength(init.body) <= 64000, 'Judge request ceiling');
    const body = JSON.parse(init.body);
    const n = ++report.judgeDispatches;
    await save(`judge-${n}-request.json`, body);
    return nativeFetch(url, { ...init, signal: AbortSignal.any([deadline, init.signal]), redirect: 'error' });
  };
}
async function arm(phase, instruction) {
  activeArm = phase;
  const outcome = { phase, completed: false, patch: null, requests: [], errors: [] };
  report.arms.push(outcome);
  const directory = new URL(`${phase}/`, run); await mkdir(directory);
  const cwd = fileURLToPath(directory);
  const manager = SessionManager.create(cwd, fileURLToPath(new URL('sessions/', directory)));
  const sandbox = new Sandbox(task);
  const captures = [];
  outcome.sessionId = manager.getSessionId();
  let session, fatal;
  const fail = (reason) => { fatal ??= reason; if (session) void session.abort(); };
  const abortRun = () => fail('Experiment deadline');
  deadline.addEventListener('abort', abortRun, { once: true });
  const started = performance.now();
  try {
    await sandbox.start();
    outcome.configuration = sandbox.configuration;
    if (!sourceSnapshot) {
      const snapshot = await sandbox.snapshot();
      sourceSnapshot = snapshot.source;
      await save('source.json', snapshot);
      fixturePaths = Object.entries(sourceSnapshot.files).filter(([path, text]) => /^[a-zA-Z0-9_./-]+\.py$/.test(path)
        && Buffer.byteLength(text) >= 2000).slice(0, 2).map(([path]) => path);
      if (!live) assert.equal(fixturePaths.length, 2, 'Local fixture needs two source files');
    } // Each arm verifies the same prepared image; coverage retains the immutable dataset base.
    const bash = createBashToolDefinition('/testbed', { exposeSessionEnvironment: false, operations: {
      async exec(command, _cwd, options) {
        // SDK context cwd is the isolated host session directory. Never execute there.
        try {
          const result = await sandbox.command(command, { seconds: Math.min(120, Math.max(1, Math.ceil(options.timeout ?? 120))),
            signal: AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]), onData: options.onData });
          return { exitCode: result.code };
        } catch (e) { fail(`Sandbox stopped: ${errorText(e)}`); throw e; }
      },
    } });
    bash.executionMode = 'sequential';
    const settings = SettingsManager.inMemory({ transport: 'sse', cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } });
    // Local updater responses are scripted, never an implicit extra call to the coding model.
    const brief = scriptedBrief(model);
    const policy = phase === 'control' ? { policy: 'scripted-v1', budget } : { policy: 'jev-select-v1', budget, selection, brief, jev: { ...judgePolicy, apiKey: jevKey, endpoint: judgeEndpoint } };
    const loader = new DefaultResourceLoader({ cwd, agentDir: `${cwd}/agent`, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [createContextExtension(manager, policy)], systemPromptOverride: () => systemPrompt, appendSystemPromptOverride: () => [] });
    await loader.reload();
    const created = await createAgentSession({ cwd, agentDir: `${cwd}/agent`, modelRuntime: runtime, model, sessionManager: manager,
      settingsManager: settings, resourceLoader: loader, tools: ['bash', 'read'], customTools: [bash, sandboxReadTool(sandbox, deadline)], thinkingLevel: 'medium' });
    session = created.session;
    assert.deepEqual(created.extensionsResult.errors, []);
    assert.deepEqual(session.getActiveToolNames().sort(), ['bash', 'read']);
    await session.bindExtensions({ onError: (e) => { outcome.errors.push(e.error); fail('Extension handler error'); } });
    const inner = session.agent.streamFunction;
    session.agent.streamFunction = async (requestModel, context, options) => {
      if (outcome.requests.filter((r) => r.dispatched).length >= bounds.requestsPerArm) { fail('Request ceiling'); throw new Error(fatal); }
      assert.ok(!fatal && !deadline.aborted && report.accountingComplete && spent() < bounds.catalogStopUsd, 'Run stopped by accounting, cost, or deadline');
      const turn = outcome.requests.length + 1;
      fixtureTurn = turn;
      const record = { phase, turn, dispatched: false, httpStatus: null, rawUsage: null, usage: null };
      outcome.requests.push(record); report.requests.push(record);
      const controller = new AbortController();
      const signal = AbortSignal.any([deadline, controller.signal, options.signal, AbortSignal.timeout(bounds.requestMs)]);
      let inspected;
      const requestStart = performance.now();
      return inner(requestModel, context, { ...options, signal, transport: 'sse', timeoutMs: bounds.requestMs, maxRetries: 0,
        async onPayload(body, m) {
          const before = structuredClone(body);
          const after = await options.onPayload?.(body, m) ?? body;
          signal.throwIfAborted();
          assert.deepEqual(withoutToolText(after), withoutToolText(before), 'Selector changed non-tool text or structure');
          record.beforeBytes = Buffer.byteLength(JSON.stringify(before));
          record.afterBytes = Buffer.byteLength(JSON.stringify(after));
          record.changedOutputs = after.input.flatMap((item, i) => item.output !== before.input[i]?.output ? [item.call_id] : []);
          assert.equal(after.store, false); assert.equal(after.previous_response_id, undefined);
          assert.equal(after.reasoning?.effort, 'medium');
          assert.equal(after.prompt_cache_key, manager.getSessionId());
          assert.ok(record.afterBytes <= bounds.requestBytes);
          inspected = structuredClone(after); return after;
        },
        async fetch(url, init) {
          assert.equal(String(url), `${baseUrl}/codex/responses`);
          signal.throwIfAborted(); assert.ok(!fatal && spent() < bounds.catalogStopUsd);
          assert.ok(outcome.requests.filter((r) => r.dispatched).length < bounds.requestsPerArm);
          const headers = new Headers(init.headers);
          const bytes = Buffer.from(init.body);
          const wire = JSON.parse((headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString());
          assert.deepEqual(wire, inspected);
          assert.equal(headers.get('session-id'), manager.getSessionId());
          const capture = captureRequest({ sessionId: manager.getSessionId(), requestId: `${phase}-${turn}`,
            branch: manager.getBranch(), payload: wire, model, source: sourceSnapshot });
          await save(`${phase}-${turn}-request.json`, wire);
          record.dispatched = true; record.wireSha256 = sha(JSON.stringify(wire)); captures.push(capture);
          const response = await nativeFetch(url, { ...init, signal, redirect: 'error' });
          record.httpStatus = response.status; record.requestToHeadersMs = Math.round(performance.now() - requestStart);
          record.dispatchedAt = performance.now();
          return tapResponse(response, record, controller);
        },
      });
    };
    session.subscribe((event) => {
      if (event.type !== 'message_end' || event.message.role !== 'assistant') return;
      const last = outcome.requests.at(-1);
      if (last && !last.messageEnded) {
        last.messageEnded = true;
        last.stopReason = event.message.stopReason; last.piUsage = event.message.usage;
        last.elapsedAfterHeadersMs = last.dispatchedAt ? Math.round(performance.now() - last.dispatchedAt) : null;
        delete last.dispatchedAt;
        if (last.dispatched && !last.usage) { report.accountingComplete = false; fail('Missing or invalid usage'); }
        if (!['toolUse', 'stop'].includes(event.message.stopReason)) fatal ??= event.message.errorMessage ?? `Model stopped: ${event.message.stopReason}`;
        console.log(JSON.stringify({ phase, turn: last.turn, dispatched: last.dispatched, stopReason: last.stopReason, usage: last.usage, changedOutputs: last.changedOutputs }));
      }
    });
    await session.prompt(instruction);
  } catch (e) { outcome.failure = errorText(e); }
  finally {
    if (outcome.requests.some((r) => r.dispatched && !r.usage)) report.accountingComplete = false;
    const entries = manager.getBranch();
    const records = (kind) => entries.filter((e) => e.type === 'custom' && e.customType === kind).map((e) => e.data);
    outcome.stops = records(STOP_ENTRY); outcome.judgeStarts = records(JUDGE_START_ENTRY); outcome.judgeResults = records(JUDGE_RESULT_ENTRY);
    outcome.selections = records(SELECTION_ENTRY); outcome.nativeEdits = entries.filter((e) => e.type === 'context_edit');
    outcome.extensionUsage = records(USAGE_ENTRY);
    outcome.briefStarts = records(BRIEF_START_ENTRY); outcome.briefResults = records(BRIEF_RESULT_ENTRY);
    outcome.briefAccountingComplete = outcome.briefStarts.length === outcome.briefResults.length
      && outcome.briefResults.every((r) => r.pricedCostUsd !== null);
    outcome.briefScriptedCostUsd = outcome.briefResults.reduce((n, r) => n + (r.pricedCostUsd ?? 0), 0);
    if (!outcome.briefAccountingComplete) report.accountingComplete = false;
    const last = session?.messages.findLast((m) => m.role === 'assistant');
    outcome.completed = !outcome.failure && !fatal && !outcome.stops.length && last?.stopReason === 'stop';
    outcome.failure ??= fatal ?? outcome.stops.at(-1)?.reason ?? (outcome.completed ? null : 'No final response');
    outcome.judgeAccountingComplete = outcome.judgeStarts.length === outcome.judgeResults.length && outcome.judgeResults.every((r) => r.pricedCostUsd !== null);
    if (!outcome.judgeAccountingComplete) report.accountingComplete = false;
    outcome.codingCatalogCostUsd = outcome.requests.reduce((n, r) => n + (r.usage?.catalogCostUsd ?? 0), 0);
    outcome.judgeKnownCostUsd = outcome.judgeResults.reduce((n, r) => n + (r.pricedCostUsd ?? 0), 0);
    outcome.judgeMs = outcome.judgeResults.reduce((n, r) => n + r.latencyMs, 0);
    await save(`${phase}-branch.json`, entries);
    await save(`${phase}-captures.json`, captures);
    session?.dispose(); deadline.removeEventListener('abort', abortRun);
    if (!sandbox.dead) {
      try {
        const patch = await sandbox.patch(); outcome.patch = `${phase}.patch`; outcome.patchBytes = Buffer.byteLength(patch);
        await writeFile(new URL(outcome.patch, run), patch, { flag: 'wx', mode: 0o600 });
      } catch (e) { outcome.patchFailure = errorText(e); }
    }
    outcome.elapsedMs = Math.round(performance.now() - started);
    await save(`${phase}-outcome.json`, outcome);
    await sandbox.close();
  }
}
try {
  const sourceHashes = {};
  for (const file of ['run.mjs', 'sandbox.ts', 'snapshot.py', '../contextbench.ts', 'grade.py', 'score.ts']) sourceHashes[file] = sha(await readFile(new URL(file, root)));
  for (const file of await readdir(new URL('../../src/', root))) if (file.endsWith('.ts')) sourceHashes[`src/${file}`] = sha(await readFile(new URL(`../../src/${file}`, root)));
  for (const file of ['test/brief-fixture.ts', 'test/history-fixture.ts', 'package-lock.json']) {
    sourceHashes[file] = sha(await readFile(new URL(`../../${file}`, root)));
  }
  const instruction = task.problemStatement;
  await save('agent-task.json', task);
  await save('manifest.json', { mode, instanceId: task.instanceId, base: task.baseCommit, image: task.image, piVersion: pkg.version,
    model: 'openai-codex/gpt-5.6-sol', reasoning: 'medium', armOrder: ['control', 'selector'], bounds, budget, selection, judgePolicy,
    taskSha256: sha(JSON.stringify(task)), instructionSha256: sha(instruction), sourceHashes, prices, systemPrompt,
    briefMode: 'local-scripted-no-inference',
    limits: ['One development task, one fresh trajectory per arm. Not a causal quality/cost estimate.',
      'Control uses the same budget/logging extension in no-selection mode; neither arm uses normal Pi resources or compaction.',
      'Fixed order, different session/cache keys do not guarantee independent provider caches. Natural trajectories differ.',
      'Usage-anchored soft pressure with conservative byte fallback; relevance cutoffs are uncalibrated. No retuning/retry in this run.',
      'Catalog costs are estimates, not subscription charges. Between-request cost stop can overshoot by one response, not a hard dollar cap. Output reserve is not a generation cap.',
      'Private local ignored artifacts, including opaque reasoning. No automatic publication or backup.',
      'Native grading separately checks patches; incomplete trajectories remain incomplete even if their patches pass.'] });
  await setup();
  for (const phase of ['control', 'selector']) {
    if (!report.accountingComplete || deadline.aborted || spent() >= bounds.catalogStopUsd) { report.arms.push({ phase, completed: false, skipped: 'Accounting or deadline stop' }); continue; }
    await arm(phase, instruction);
  }
  report.completed = report.arms.every((a) => a.completed);
  if (mode === '--local') {
    assert.ok(report.completed, JSON.stringify(report.arms.map((a) => a.failure)));
    assert.equal(report.requests.filter((r) => r.dispatched).length, 10);
    assert.ok(report.judgeDispatches > 0);
    assert.equal(report.arms[0].nativeEdits.length, 0);
    assert.ok(report.arms[1].nativeEdits.length > 0);
    assert.ok(report.arms[1].requests.some((r) => r.changedOutputs.length > 0));
    const selected = JSON.parse(await readFile(new URL('selector-captures.json', run)));
    assert.ok(selected.some((c) => c.evidence.some((e) => e.visible && e.mapping.span)), 'Real reads must map to source');
    const retired = selected.flatMap((c) => c.evidence.filter((e) => !e.visible && e.mapping.span).map((e) => e.id));
    assert.ok(retired.length > 0 && selected.at(-1).evidence.some((e) => e.visible && retired.includes(e.id)), 'Mapped read must retire and restore without rereading');
    assert.equal(await readFile(new URL('control.patch', run), 'utf8'), await readFile(new URL('selector.patch', run), 'utf8'));
  } else if (mode === '--local-invalid-usage') {
    assert.equal(report.accountingComplete, false); assert.equal(report.requests.filter((r) => r.dispatched).length, 1);
  } else if (mode === '--local-judge-failure') {
    assert.equal(report.arms[0].completed, true); assert.equal(report.arms[1].completed, false);
    assert.equal(report.judgeDispatches, 1); assert.equal(report.arms[1].nativeEdits.length, 0);
    assert.match(report.arms[1].stops.at(-1)?.reason, /Jev evaluation failed/);
  } else if (mode === '--local-request-cap') {
    assert.ok(report.arms.every((a) => !a.completed && a.failure === 'Request ceiling'));
    assert.equal(report.requests.filter((r) => r.dispatched).length, 4);
    assert.ok(report.requests.every((r) => r.stopReason === 'toolUse' && r.piUsage.input > 0));
  }
  report.contractsPassed = !live;
} catch (e) { report.failure = errorText(e); process.exitCode = 1; }
finally {
  if (report.requests.some((r) => r.dispatched && !r.usage)) report.accountingComplete = false;
  globalThis.fetch = nativeFetch;
  await save('report.json', report);
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  console.log(JSON.stringify({ artifact: run.pathname, completed: report.completed, contractsPassed: report.contractsPassed, accountingComplete: report.accountingComplete, failure: report.failure }));
  if (live && !report.completed) process.exitCode = 1;
}
