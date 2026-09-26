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
import { createWorkingContextExtension, INFERENCE_START_ENTRY, INFERENCE_RESULT_ENTRY, STOP_ENTRY, USAGE_ENTRY, DEFERRAL_ENTRY, WORKING_POLICY } from '../../src/working-extension.ts';
import { SELECTION_ENTRY } from '../../src/history.ts';
import { JEV_ENDPOINT, JEV_MODEL } from '../../src/jev.ts';
import { Sandbox, parseTask, sandboxReadTool, taskInstruction, taskRoot } from './sandbox.ts';
import { captureRequest } from '../contextbench.ts';
import { tapResponse } from './codex-accounting.mjs';
import { guardedSketch, SKETCH_REQUEST_BYTES } from './sketch.mjs';

process.umask(0o077);
const [mode, taskFile, output, ...extra] = process.argv.slice(2);
assert.ok(['--local', '--local-invalid-usage', '--local-judge-failure', '--local-request-cap', '--local-sketch-invalid-usage', '--local-judge-invalid', '--live'].includes(mode)
  && taskFile && output && extra.length <= 1 && extra.every((a) => a.startsWith('--arms=')), 'Usage: run.mjs MODE agent-task.json NEW_OUTPUT_DIRECTORY [--arms=a,b]');
const live = mode === '--live';
// default: unmodified Pi with native compaction. clearing: threshold clearing, no restoration, sketch, or Jev.
// control: capture order with earned restoration. selector: Jev ranking with earned restoration.
const ARM_ORDER = ['default', 'clearing', 'control', 'selector'];
const arms = extra.length ? extra[0].slice('--arms='.length).split(',') : live ? ARM_ORDER : ['control', 'selector'];
assert.ok(arms.length > 0 && new Set(arms).size === arms.length && arms.every((a) => ARM_ORDER.includes(a))
  && arms.every((a, i) => i === 0 || ARM_ORDER.indexOf(arms[i - 1]) < ARM_ORDER.indexOf(a)), 'Arms must be distinct and in canonical order');
const pairContract = arms.length === 2 && arms[0] === 'control' && arms[1] === 'selector';
assert.ok(live || mode === '--local' || pairContract, 'Failure fixtures exercise the control and selector arms');
const task = parseTask(JSON.parse(await readFile(taskFile, 'utf8')));
const lhtb = task.kind === 'lhtb';
const root = taskRoot(task);
// LHTB arms run as separate processes, so each gets its own deadline and they can run in parallel.
assert.ok(!lhtb || ((live || mode === '--local') && extra.length === 1 && arms.length === 1), 'LHTB runs are live or --local smoke, one explicit arm per process');
const moduleRoot = new URL('./', import.meta.url);
const run = pathToFileURL(resolve(output) + '/');
await mkdir(run, { mode: 0o700 });
const save = (name, data) => writeFile(new URL(name, run), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const sha = (data) => createHash('sha256').update(data).digest('hex');
const pkg = JSON.parse(await readFile(new URL('../../node_modules/@earendil-works/pi-coding-agent/package.json', moduleRoot)));
assert.equal(pkg.version, '0.87.1');
const catalog = JSON.parse(await readFile(new URL('../../node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json', moduleRoot)));
const CODING_MODEL = 'gpt-6-sol';
const pinned = catalog['openai-codex-responses'][CODING_MODEL];
const prices = pinned.cost;
const pinnedSketch = catalog['openai-codex-responses']['gpt-6-luna'];
// Live runs use the long-task profile: late, large evictions that leave short tasks untouched. Local
// fixtures keep the small profile their scripted usage is built around.
const bounds = { requestsPerArm: mode === '--local-request-cap' ? 2 : lhtb ? 400 : live ? 150 : 24, judgeRequests: live ? 240 : 24, requestMs: 90000,
  runMs: lhtb ? 5700000 : live ? 14400000 : 2400000, toolSeconds: 120, requestBytes: live ? 2000000 : 180000, responseBytes: lhtb ? 16000000 : 512000, catalogStopUsd: lhtb ? 22 : live ? 30 : 3,
  sketchRequests: live ? 150 : 24, sketchMs: 30000, sketchMaxTokens: 4096, sketchRequestBytes: SKETCH_REQUEST_BYTES, sketchResponseBytes: 128000 };
const capacity = { contextLimit: live ? 256000 : 180000, marginTokens: 1024, outputReserveTokens: 4096, maxRequestBytes: bounds.requestBytes };
const target = live ? { lowTokens: 32000, highTokens: 100000, restoreHeadroomTokens: 8000 }
  : { lowTokens: 20000, highTokens: 24576, restoreHeadroomTokens: 4000 };
// 120KB is about 53k tokens at the worst observed 2.27 bytes per Jev token, under Jev's 64k request limit.
const ranking = { maxPairBytes: 30000, maxRequestBytes: live ? 120000 : 60000, maxRequests: live ? 16 : 8, maxSegments: live ? 512 : 256,
  maxInputBytes: live ? 2000000 : 480000, maxCostUsd: live ? 0.2 : 0.1, requestTimeoutMs: 15000, maxDurationMs: live ? 240000 : 120000 };
const decision = { archiveLimit: live ? 8 : 4, decisionTimeoutMs: live ? 360000 : 180000, sketchMaxUpdates: 4 };
const systemPrompt = lhtb ? `Complete the task described by the user inside an offline container. Your workspace is ${root}. Use read to inspect text files, with offset/limit for focused reads. Use bash to run commands, edit files, and test. Commands execute in an isolated container with no network access. Keep each command output below 32000 bytes and 2000 lines, and each command below 120 seconds; run longer jobs in the background and poll them. The task instructions define when the work is complete, so keep working until they are satisfied. Finish with a concise summary.`
  : 'Fix the supplied Python repository issue in /testbed. Use read to inspect source files, with offset/limit for focused reads. Use bash to search, edit, and test. Commands execute in an isolated offline container. Do not commit. Keep each command output below 32000 bytes and 2000 lines, and each command below 120 seconds. Use the source and available tests, not network access. Finish with a concise summary of the fix and tests.';
const report = { version: 2, lifecycle: WORKING_POLICY, developmentOnly: true, mode, completed: false,
  accountingComplete: true, arms: [], requests: [], sketchRequests: [], judgeRequests: [], judgeDispatches: 0 };
const deadline = AbortSignal.timeout(bounds.runMs);
const nativeFetch = globalThis.fetch;
let runtime, server, model, sketchModel, baseUrl, judgeEndpoint, activeArm, fixtureTurn, sourceSnapshot, fixturePaths;
const spent = () => [...report.requests, ...report.sketchRequests].reduce((n, r) => n + (r.usage?.catalogCostUsd ?? 0), 0)
  + report.judgeDispatches * 64000 * 0.042 / 1e6;
let jevKey = 'local-fake-key';
const errorText = (e) => e instanceof assert.AssertionError ? e.message.split('\n')[0] : String(e.message);

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
          const level = fixtureTurn >= 4 ? 4 : 1;
          const answers = mode === '--local-judge-invalid' ? {} : Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, {
            type: 'score', score: level, confidence: 1,
            legend: Object.fromEntries(question.criteria.map((text, i) => [i, text])),
            probabilities: Object.fromEntries(question.criteria.map((_, i) => [i, Number(i === level)])),
          }]));
          res.end(JSON.stringify({ model: JEV_MODEL, answers, usage: { input_tokens: 5000, output_tokens: 5 } })); return;
        }
        assert.equal(req.url, '/codex/responses');
        const isSketch = body.model === 'gpt-6-luna';
        const output = isSketch ? [{ type: 'message', id: `msg_sketch_${randomUUID()}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Fix the supplied Python repository issue using source reads and tests.' }), annotations: [] }] }] : fixtureOutput(fixtureTurn);
        // Pressure first retires evidence; the third coding response establishes restoration headroom.
        const inputTokens = isSketch ? 2000 : fixtureTurn < 3 ? 30000 : 10000;
        const invalid = isSketch ? mode === '--local-sketch-invalid-usage' && activeArm === 'selector' : mode === '--local-invalid-usage';
        const usage = { input_tokens: inputTokens, output_tokens: 200, total_tokens: inputTokens + 200, input_tokens_details: { cached_tokens: invalid ? inputTokens + 1 : 1024 } };
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
    runtime.registerProvider('jev-pair-fixture', { baseUrl, api: 'openai-codex-responses', apiKey: fakeKey, models: [{ ...pinned, id: CODING_MODEL, baseUrl }, { ...pinnedSketch, id: 'gpt-6-luna', baseUrl }] });
    model = runtime.getModel('jev-pair-fixture', CODING_MODEL);
    sketchModel = runtime.getModel('jev-pair-fixture', 'gpt-6-luna');
  } else {
    // Read exactly the authorized judge key; never load the file into process.env or Docker.
    jevKey = parseEnv(await readFile(new URL('../../.env', moduleRoot), 'utf8')).TYPESAFE_API_KEY;
    assert.ok(jevKey?.trim(), 'Missing TYPESAFE_API_KEY');
    runtime = await ModelRuntime.create(options);
    model = runtime.getModel('openai-codex', CODING_MODEL);
    sketchModel = runtime.getModel('openai-codex', 'gpt-6-luna');
    assert.ok(model && model.baseUrl === 'https://chatgpt.com/backend-api');
    baseUrl = model.baseUrl; judgeEndpoint = JEV_ENDPOINT;
  }
  assert.ok(model && model.api === 'openai-codex-responses'); model = { ...model, cost: prices };
  assert.ok(sketchModel && sketchModel.api === 'openai-codex-responses' && sketchModel.baseUrl === baseUrl);
  sketchModel = { ...sketchModel, cost: pinnedSketch.cost };
  // Judge alone uses global fetch. Coding and sketch traffic have per-request guards.
  globalThis.fetch = async (url, init) => {
    if (String(url) !== judgeEndpoint) return nativeFetch(url, init); // Auth refresh remains owned by ModelRuntime.
    const record = { phase: activeArm, attempt: report.judgeRequests.length + 1, dispatched: false, requestHash: sha(init.body) };
    report.judgeRequests.push(record);
    try {
      const guard = () => {
        assert.equal(activeArm, 'selector');
        assert.ok(report.accountingComplete && !deadline.aborted && spent() < bounds.catalogStopUsd, 'Run stopped by accounting, cost, or deadline');
        assert.ok(report.judgeDispatches < bounds.judgeRequests, 'Judge request ceiling');
        init.signal.throwIfAborted();
      };
      guard();
      assert.equal(init.method, 'POST');
      assert.ok(Buffer.byteLength(init.body) <= ranking.maxRequestBytes, 'Judge request size ceiling');
      await save(`judge-${record.attempt}-request.json`, JSON.parse(init.body));
      guard();
      report.judgeDispatches++;
      record.dispatched = true;
      return await nativeFetch(url, { ...init, signal: AbortSignal.any([deadline, init.signal]), redirect: 'error' });
    } catch (error) {
      record.failure = errorText(error);
      record.stopClass = record.dispatched ? 'provider-transport' : 'dispatch-refused';
      throw error;
    }
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
    if (lhtb && !live && !fixturePaths) {
      const found = await sandbox.command("find . -name '*.py' -size +2k -not -path '*/.*' | sort | head -2", { seconds: 30 });
      fixturePaths = found.text.trim().split('\n').filter(Boolean).map((path) => path.replace(/^\.\//, ''));
      assert.equal(fixturePaths.length, 2, 'Local fixture needs two source files');
    }
    if (!lhtb && !sourceSnapshot) {
      const snapshot = await sandbox.snapshot();
      sourceSnapshot = snapshot.source;
      await save('source.json', snapshot);
      fixturePaths = Object.entries(sourceSnapshot.files).filter(([path, text]) => /^[a-zA-Z0-9_./-]+\.py$/.test(path)
        && Buffer.byteLength(text) >= 2000).slice(0, 2).map(([path]) => path);
      if (!live) assert.equal(fixturePaths.length, 2, 'Local fixture needs two source files');
    } // Each arm verifies the same prepared image; coverage retains the immutable dataset base.
    const bash = createBashToolDefinition(root, { exposeSessionEnvironment: false, operations: {
      async exec(command, _cwd, options) {
        // SDK context cwd is the isolated host session directory. Never execute there.
        try {
          const result = await sandbox.toolCommand(command, { seconds: Math.min(120, Math.max(1, Math.ceil(options.timeout ?? 120))),
            signal: AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]), onData: options.onData });
          return { exitCode: result.code };
        } catch (e) { fail(`Sandbox stopped: ${errorText(e)}`); throw e; }
      },
    } });
    bash.description = (lhtb ? `Execute bash in the offline container, starting in ${root}.` : 'Execute bash in the offline /testbed container.')
      + ' Returns a prefix of stdout and stderr, at most 32000 bytes and 2000 lines including a truncation notice. Discarded output is not saved. Narrow commands when output is truncated. Commands have a maximum timeout of 120 seconds.';
    bash.executionMode = 'sequential';
    const settings = SettingsManager.inMemory({ transport: 'sse', cacheWarming: 'off', compaction: { enabled: phase === 'default' }, retry: { enabled: false, provider: { maxRetries: 0 } } });
    const guard = () => assert.ok(!fatal && !deadline.aborted && report.accountingComplete && spent() < bounds.catalogStopUsd,
      'Run stopped by accounting, cost, or deadline');
    const sketch = guardedSketch({ runtime, model: sketchModel, sessionId: manager.getSessionId(), phase, bounds, deadline,
      records: report.sketchRequests, guard, save, fetch: nativeFetch,
      unknownCost(reason) { report.accountingComplete = false; fail(reason); } });
    const policy = { capacity, target, ranking, archiveLimit: decision.archiveLimit, decisionTimeoutMs: decision.decisionTimeoutMs,
      sketch: { ...sketch, maxUpdates: decision.sketchMaxUpdates },
      restoration: phase !== 'clearing',
      order: phase === 'selector' ? { kind: 'jev', connection: { timeoutMs: ranking.requestTimeoutMs, apiKey: jevKey, endpoint: judgeEndpoint } }
        : { kind: 'capture-order' } };
    const loader = new DefaultResourceLoader({ cwd, agentDir: `${cwd}/agent`, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: phase === 'default' ? [] : [createWorkingContextExtension(manager, policy)], systemPromptOverride: () => systemPrompt, appendSystemPromptOverride: () => [] });
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
      const signal = AbortSignal.any([deadline, controller.signal, options.signal]);
      let inspected;
      const requestStart = performance.now();
      return inner(requestModel, context, { ...options, signal, transport: 'sse', timeoutMs: bounds.requestMs, maxRetries: 0,
        async onPayload(body, m) {
          const before = structuredClone(body);
          const selectionStart = performance.now();
          const after = await options.onPayload?.(body, m) ?? body;
          record.decisionMs = Math.round(performance.now() - selectionStart);
          signal.throwIfAborted();
          assert.deepEqual(withoutToolText(after), withoutToolText(before), 'Selector changed non-tool text or structure');
          record.beforeBytes = Buffer.byteLength(JSON.stringify(before));
          record.afterBytes = Buffer.byteLength(JSON.stringify(after));
          record.changedOutputs = after.input.flatMap((item, i) => item.output !== before.input[i]?.output ? [item.call_id] : []);
          assert.equal(after.store, false); assert.equal(after.previous_response_id, undefined);
          // Native compaction in the default arm may send its summary request without session identity.
          if (phase !== 'default' || after.prompt_cache_key !== undefined) {
            assert.equal(after.reasoning?.effort, 'medium');
            assert.equal(after.prompt_cache_key, manager.getSessionId());
          }
          assert.ok(record.afterBytes <= bounds.requestBytes);
          inspected = structuredClone(after); return after;
        },
        async fetch(url, init) {
          assert.equal(String(url), `${baseUrl}/codex/responses`);
          signal.throwIfAborted(); guard();
          assert.ok(outcome.requests.filter((r) => r.dispatched).length < bounds.requestsPerArm);
          const headers = new Headers(init.headers);
          const bytes = Buffer.from(init.body);
          const wire = JSON.parse((headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString());
          assert.deepEqual(wire, inspected);
          if (phase !== 'default' || headers.get('session-id') !== null) assert.equal(headers.get('session-id'), manager.getSessionId());
          const capture = sourceSnapshot && captureRequest({ sessionId: manager.getSessionId(), requestId: `${phase}-${turn}`,
            branch: manager.getBranch(), payload: wire, model, source: sourceSnapshot });
          await save(`${phase}-${turn}-request.json`, wire);
          signal.throwIfAborted(); guard();
          record.dispatched = true; record.wireSha256 = sha(JSON.stringify(wire)); if (capture) captures.push(capture);
          const dispatchStart = performance.now();
          record.preDispatchMs = Math.round(dispatchStart - requestStart);
          const response = await nativeFetch(url, { ...init,
            signal: AbortSignal.any([signal, AbortSignal.timeout(bounds.requestMs)]), redirect: 'error' });
          record.httpStatus = response.status; record.requestToHeadersMs = Math.round(performance.now() - dispatchStart);
          record.dispatchedAt = performance.now();
          return tapResponse(response, record, controller, prices, bounds.responseBytes);
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
    outcome.stops = records(STOP_ENTRY); outcome.deferrals = records(DEFERRAL_ENTRY);
    outcome.selections = records(SELECTION_ENTRY); outcome.nativeEdits = entries.filter((e) => e.type === 'context_edit');
    outcome.compactions = entries.filter((e) => e.type === 'compaction').length;
    outcome.extensionUsage = records(USAGE_ENTRY);
    const starts = records(INFERENCE_START_ENTRY), results = records(INFERENCE_RESULT_ENTRY);
    outcome.sketchStarts = starts.filter((r) => r.kind === 'sketch');
    outcome.sketchResults = results.filter((r) => r.kind === 'sketch');
    outcome.rankingStarts = starts.filter((r) => r.kind === 'ranking');
    outcome.rankingResults = results.filter((r) => r.kind === 'ranking');
    const sketches = report.sketchRequests.filter((r) => r.phase === phase);
    const judges = report.judgeRequests.filter((r) => r.phase === phase);
    const accounted = (begun, ended) => begun.length === ended.length
      && new Set(begun.map((r) => r.operationId)).size === begun.length
      && begun.every((start) => ended.filter((r) => r.operationId === start.operationId).length === 1)
      && ended.every((r) => Number.isFinite(r.pricedCostUsd) && r.pricedCostUsd >= 0);
    outcome.sketchCatalogCostUsd = sketches.reduce((n, r) => n + (r.usage?.catalogCostUsd ?? 0), 0);
    outcome.sketchMs = sketches.reduce((n, r) => n + r.elapsedMs, 0);
    outcome.sketchAccountingComplete = accounted(outcome.sketchStarts, outcome.sketchResults)
      && outcome.sketchResults.filter((r) => r.completionInvoked).length === sketches.length
      && sketches.every((r) => r.accountingComplete)
      && Math.abs(outcome.sketchResults.reduce((n, r) => n + (r.pricedCostUsd ?? 0), 0) - outcome.sketchCatalogCostUsd) < 1e-9;
    outcome.rankingAccountingComplete = accounted(outcome.rankingStarts, outcome.rankingResults)
      && outcome.rankingResults.filter((r) => r.sent).length === judges.length;
    if (!outcome.sketchAccountingComplete || !outcome.rankingAccountingComplete) report.accountingComplete = false;
    outcome.dispatchRefusals = [...sketches, ...judges].filter((r) => r.stopClass === 'dispatch-refused');
    const last = session?.messages.findLast((m) => m.role === 'assistant');
    outcome.completed = !outcome.failure && !fatal && !outcome.stops.length && report.accountingComplete && last?.stopReason === 'stop';
    outcome.failure ??= fatal ?? outcome.stops.at(-1)?.reason ?? (outcome.completed ? null : 'No accounted final response');
    outcome.codingCatalogCostUsd = outcome.requests.reduce((n, r) => n + (r.usage?.catalogCostUsd ?? 0), 0);
    // Whether the arm ever crossed the eviction trigger decides whether it tested management at all.
    outcome.peakInputTokens = Math.max(0, ...outcome.requests.map((r) => r.usage?.input ?? 0));
    // Managed arms evict before sending, so their reported input stays low; count evictions instead.
    outcome.evictions = outcome.selections.filter((d) => d.reconsideration?.mode === 'rebalance' && d.reconsideration.selection?.displacedIds?.length).length;
    outcome.crossedHighMark = outcome.peakInputTokens > target.highTokens || outcome.evictions > 0;
    outcome.cachedInputShare = (() => { const u = outcome.requests.filter((r) => r.usage);
      const input = u.reduce((n, r) => n + r.usage.input, 0); return input ? u.reduce((n, r) => n + r.usage.cached, 0) / input : null; })();
    outcome.rankingKnownCostUsd = outcome.rankingResults.reduce((n, r) => n + (r.pricedCostUsd ?? 0), 0);
    outcome.rankingMs = outcome.rankingResults.reduce((n, r) => n + r.latencyMs, 0);
    await save(`${phase}-branch.json`, entries);
    await save(`${phase}-captures.json`, captures);
    session?.dispose(); deadline.removeEventListener('abort', abortRun);
    if (!sandbox.dead) {
      try {
        if (lhtb) {
          outcome.finalImage = `jev-lhtb-final:${sandbox.name.slice('jev-eval-'.length)}`;
          outcome.finalImageId = await sandbox.commitFinal(outcome.finalImage);
        } else {
          const patch = await sandbox.patch(); outcome.patch = `${phase}.patch`; outcome.patchBytes = Buffer.byteLength(patch);
          await writeFile(new URL(outcome.patch, run), patch, { flag: 'wx', mode: 0o600 });
        }
      } catch (e) { outcome.patchFailure = errorText(e); }
    }
    outcome.elapsedMs = Math.round(performance.now() - started);
    await save(`${phase}-outcome.json`, outcome);
    await sandbox.close();
  }
}
try {
  const sourceHashes = {};
  for (const file of ['run.mjs', 'sketch.mjs', 'codex-accounting.mjs', 'sandbox.ts', 'tool-output.ts', 'snapshot.py', '../contextbench.ts', 'grade.py', 'score.ts']) sourceHashes[file] = sha(await readFile(new URL(file, moduleRoot)));
  for (const file of await readdir(new URL('../../src/', moduleRoot))) if (file.endsWith('.ts')) sourceHashes[`src/${file}`] = sha(await readFile(new URL(`../../src/${file}`, moduleRoot)));
  for (const file of ['package-lock.json']) {
    sourceHashes[file] = sha(await readFile(new URL(`../../${file}`, moduleRoot)));
  }
  const instruction = taskInstruction(task);
  await save('agent-task.json', task);
  await save('manifest.json', { version: 2, lifecycle: WORKING_POLICY, mode, instanceId: task.instanceId, base: task.baseCommit, image: task.image, piVersion: pkg.version,
    model: `openai-codex/${CODING_MODEL}`, reasoning: 'medium', armOrder: arms, orders: { default: 'pi-native-compaction', clearing: 'capture-order-no-restoration', control: 'capture-order', selector: 'jev' }, bounds, capacity, target, ranking, decision,
    taskSha256: sha(JSON.stringify(task)), instructionSha256: sha(instruction), sourceHashes, prices, systemPrompt,
    sketch: { model: 'openai-codex/gpt-6-luna', reasoning: 'low', prices: pinnedSketch.cost,
      mode: live ? 'live' : 'scripted-http-real-sdk', outputTokenCapEnforced: false },
    limits: ['One development task, one fresh trajectory per arm. Not a causal quality/cost estimate.',
      'Default runs unmodified Pi with native compaction and no manager. Clearing, control and selector share the working-set packer and targets. Clearing never restores and makes no sketch or Jev calls. Control uses capture order with earned restoration. Selector uses Jev ranking. No arm loads normal Pi resources.',
      'Fixed order, different session/cache keys do not guarantee independent provider caches. Natural trajectories differ.',
      'Token-denominated estimates and a separate transport-byte ceiling. Ranking priority is not a safety judgment. No retuning/retry in this run.',
      'Shared sketch and run caps can interfere across arms. Natural trajectories and remaining decision time can change candidate pools.',
      'Pre-dispatch inference refusals are recorded separately but retain the conservative branch-persistent accounting stop.',
      'Catalog costs are estimates, not subscription charges. Between-request cost stop can overshoot by one response, not a hard dollar cap. Output reserve is not a generation cap.',
      'Private local ignored artifacts, including opaque reasoning. No automatic publication or backup.',
      'Native grading separately checks patches; incomplete trajectories remain incomplete even if their patches pass.'] });
  await setup();
  for (const phase of arms) {
    if (!report.accountingComplete || deadline.aborted || spent() >= bounds.catalogStopUsd) { report.arms.push({ phase, completed: false, skipped: 'Accounting or deadline stop' }); continue; }
    await arm(phase, instruction);
  }
  report.completed = report.arms.every((a) => a.completed);
  if (mode === '--local' && !pairContract) {
    // Smoke contract for baseline arms: complete, accounted, and only the managed arms edit history.
    assert.ok(report.completed, JSON.stringify(report.arms.map((a) => a.failure)));
    for (const outcome of report.arms) {
      assert.equal(outcome.nativeEdits.length > 0, outcome.phase !== 'default', `${outcome.phase} native edits`);
      assert.equal(outcome.compactions, 0);
      assert.equal(outcome.sketchStarts.length > 0, !['default', 'clearing'].includes(outcome.phase), `${outcome.phase} sketch use`);
      assert.equal(outcome.rankingStarts.length > 0, outcome.phase === 'selector', `${outcome.phase} ranking use`);
    }
  } else if (mode === '--local') {
    assert.ok(report.completed, JSON.stringify(report.arms.map((a) => a.failure)));
    assert.equal(report.requests.filter((r) => r.dispatched).length, 10);
    assert.ok(report.judgeDispatches > 0);
    assert.equal(report.sketchRequests.length, 2, 'Each arm shares one sketch across tool-only turns');
    assert.ok(report.sketchRequests.every((r) => r.dispatched && r.usage && r.stopReason === 'stop'));
    assert.equal(report.arms[0].rankingStarts.length, 0);
    assert.equal(report.arms[0].rankingResults.length, 0);
    assert.ok(report.judgeRequests.every((r) => r.phase === 'selector'));
    for (const outcome of report.arms) {
      assert.ok(outcome.sketchCatalogCostUsd > 0 && outcome.sketchAccountingComplete && outcome.rankingAccountingComplete);
      assert.ok(outcome.nativeEdits.length > 0);
      assert.ok(outcome.requests.some((r) => r.changedOutputs.length > 0));
      assert.ok(outcome.selections.every((s) => s.reconsideration.order === (outcome.phase === 'control' ? 'capture-order' : 'jev')));
      const selected = JSON.parse(await readFile(new URL(`${outcome.phase}-captures.json`, run)));
      assert.ok(selected.some((c) => c.evidence.some((e) => e.visible && e.mapping.span)), 'Real reads must map to source');
      const retired = selected.flatMap((c) => c.evidence.filter((e) => !e.visible && e.mapping.span).map((e) => e.id));
      assert.ok(retired.length > 0, 'Mapped read must retire');
      const restored = selected.at(-1).evidence.some((e) => e.visible && retired.includes(e.id));
      // Jev's scripted level rises from 1 to 4, so the read earns restoration without rereading. The
      // control cannot judge standing and must not restore what its only rebalance just retired.
      assert.equal(restored, outcome.phase === 'selector', 'Only earned restoration returns a retired read');
    }
    assert.equal(await readFile(new URL('control.patch', run), 'utf8'), await readFile(new URL('selector.patch', run), 'utf8'));
  } else if (mode === '--local-invalid-usage') {
    assert.equal(report.accountingComplete, false); assert.equal(report.requests.filter((r) => r.dispatched).length, 1);
  } else if (mode === '--local-sketch-invalid-usage') {
    assert.equal(report.accountingComplete, false);
    assert.equal(report.arms[0].completed, true);
    assert.equal(report.arms[1].completed, false);
    assert.equal(report.sketchRequests.filter((r) => r.phase === 'selector' && r.dispatched).length, 1);
    assert.equal(report.arms[1].requests.filter((r) => r.dispatched).length, 2, 'Two ordinary turns precede the first demanded sketch');
    assert.equal(report.judgeDispatches, 0);
  } else if (mode === '--local-judge-failure') {
    assert.equal(report.arms[0].completed, true); assert.equal(report.arms[1].completed, false);
    assert.equal(report.judgeDispatches, 1); assert.equal(report.arms[1].nativeEdits.length, 0);
    assert.match(report.arms[1].stops.at(-1)?.reason, /Ranking request has unknown cost/);
    assert.equal(report.accountingComplete, false);
  } else if (mode === '--local-judge-invalid') {
    assert.equal(report.accountingComplete, true);
    assert.ok(report.arms.every((a) => a.completed));
    assert.ok(report.arms[1].deferrals.length > 0);
    assert.ok(report.arms[1].rankingResults.some((r) => r.outcome === 'invalid_response' && r.pricedCostUsd > 0));
    assert.equal(report.arms[1].nativeEdits.length, 0);
    assert.ok(report.arms[1].requests.every((r) => r.changedOutputs.length === 0));
  } else if (mode === '--local-request-cap') {
    assert.ok(report.arms.every((a) => !a.completed && a.failure === 'Request ceiling'));
    assert.equal(report.requests.filter((r) => r.dispatched).length, 4);
    assert.equal(report.sketchRequests.length, 0); assert.equal(report.judgeDispatches, 0);
    assert.ok(report.requests.every((r) => r.stopReason === 'toolUse' && r.piUsage.input > 0));
  }
  report.contractsPassed = !live;
} catch (e) { report.failure = errorText(e); process.exitCode = 1; }
finally {
  if ([...report.requests, ...report.sketchRequests].some((r) => r.dispatched && !r.usage)) report.accountingComplete = false;
  globalThis.fetch = nativeFetch;
  await save('report.json', report);
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  console.log(JSON.stringify({ artifact: run.pathname, completed: report.completed, contractsPassed: report.contractsPassed, accountingComplete: report.accountingComplete, failure: report.failure }));
  if (live && !report.completed) process.exitCode = 1;
}
