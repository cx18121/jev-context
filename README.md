# jev-context

An experimental context manager for Pi. The goal is to select useful verbatim evidence from preserved session history, reducing total cost without hurting quality or improving quality at an acceptable cost. See [DESIGN.md](DESIGN.md) for the research plan.

This repository contains deterministic and Jev retirement policies. Local fixtures test the Pi integration. A [12-request synthetic pilot](docs/synthetic-pilot-v1.md) also verified the live Jev contract and basic relevance rankings, but not coding-task accuracy or savings. It is not installed in your normal Pi setup. Tests need no credentials or paid model calls.

## Run the checks

Requires Node.js 22.19.0 or newer. The Pi SDK is pinned to 0.85.1.

```sh
npm ci
npm run typecheck
npm test
```

Tests start a local OpenAI-compatible HTTP fixture on `127.0.0.1` and run the actual Pi SDK against it. They use temporary session files, an isolated resource loader, in-memory credentials and settings, and scripted responses. They do not load your extensions, skills, credentials, or session history. Model catalog network refresh is disabled.

## What exists

- `src/history.ts` resolves tool observations to active-branch session entries, validates selections, and constructs deterministic views.
- `src/extension.ts` connects the view to Pi's context and provider hooks. It records selections, explicit stops, and Pi-normalized usage as custom session entries.
- `src/budget.ts` checks the outgoing text request against a conservative size estimate and its explicit output allowance.
- `src/retirement.ts` prepares the shared candidate pool and applies a retirement ordering to the outgoing payload.
- `src/judge-state.ts` assembles the task state and per-candidate relevance questions without truncating them.
- `src/jev.ts` calls the pinned Jev API once, validates its answers, and captures usage and failure outcomes.
- `test/` contains unit fixtures and actual SDK lifecycle tests. `test/extension.test.ts` shows how the extension factory is loaded in isolation.

Load the factory explicitly in an isolated Pi SDK setup, with native automatic compaction disabled.

```ts
createContextExtension({
  policy: 'oldest-first-v1',
  budget: { contextLimit: 32768, marginTokens: 1024 },
});
```

These budget values are examples, not calibrated defaults. The policy preserves the recorded view until the full serialized request exceeds the budget. It then retires visible, eligible observations in capture order until the request fits. It skips any observation whose stub would not shrink the request. If retirement cannot make the request fit, dispatch stops and no proposed selection is recorded. This policy does not restore evidence automatically.

For integration tests, `policy: 'scripted-v1'` accepts an optional `select` callback. Omitting it or returning `null` reuses the recorded view. Each extension instance uses one policy. All policies honor existing branch-owned selections on resume, regardless of which policy recorded them.

## Jev retirement

`policy: 'jev-v1'` adds a required `jev` configuration. The caller supplies `apiKey`, `retireBelow`, and `timeoutMs`. There is no default relevance cutoff and no automatic credential lookup. `timeoutMs` must be between 1 and 60,000. An optional `endpoint` supports the local fixture. The default is `https://api.typesafe.ai/v1/systemone`, and redirects are refused.

The policy sends one batch of Noul relevance questions to `jev-1.13.0`, only under the same context pressure as oldest-first. Both policies use the same eligible, visible observations whose stubs shrink the serialized request. An unchanged view that fits does not call Jev. A request with no eligible candidates also skips Jev.

Jev candidates are ordered by increasing relevance, with capture order breaking ties. Only scores strictly below `retireBelow` can be retired. If those candidates cannot make the request fit, the coding-model request stops. There is no fallback to higher-rated evidence or oldest-first. A low score is not a calibrated probability that removal is safe. The tests use a cutoff of 0.2 only to exercise the code, not as a recommended setting.

**Judge state.** Version `unfinished-task-v1` includes system/developer text from the outgoing payload, all user messages and corrections, and assistant narrative and tool calls in conversation order. Extension messages and command output retain distinct origins. Assistant thinking and provider signatures are omitted. Visible tool observations outside the candidate pool remain contextual evidence; already-retired results are omitted. Each candidate appears in its own structured question, with its tool call, capture time, status, and verified model-visible text. Images are represented only as omitted-image markers and remain ineligible for retirement. Questions target the unfinished task, not only the latest action. This representation and the prompt's instruction/data separation have fixture coverage, not demonstrated resistance to live prompt injection or missed cross-candidate dependencies.

**Bounds.** One full batch must fit local caps of 30,000 UTF-8 JSON bytes for state plus any one question and 60,000 bytes for the complete request. These are conservative proxies for Jev's documented 32k/64k token limits, not a tokenizer. If the state or whole candidate pool exceeds a cap, the attempt stops before network access. No instructions, observations, or candidate subset are silently clipped. This deliberately limits the first policy to small-history experiments. There are no retries, including for HTTP 429/529, no substitute judge, and no summary fallback.

**Judge records.** A branch-owned `jev-context/judge-start` entry precedes the HTTP call. It records the request ID, model and prompt versions, endpoint, cutoff, candidate IDs, byte counts, request hash, and price schedule, but not the API key or a second copy of the prompt. A matching `jev-context/judge-result` records the outcome, latency, response model, raw usage, relevance scores, and nullable priced cost estimate. Malformed answers, missing usage, or a model-version mismatch reject the entire decision. Available usage is retained even when a decision fails or the coding request still cannot fit.

Cancellation never installs a partial selection. If the branch moves during the HTTP call, no result or selection is written onto the new branch. The original branch retains an unmatched start entry whose outcome and incurred cost remain unknown. Even a matched result with unavailable usage has unknown cost, not zero. Costs computed from reported usage use the documented $0.042 per million input tokens and free output, checked on 2026-09-21. They are estimates, not reconciled charges.

## Behavior proved locally

Tests demonstrate the following properties against Pi 0.85.1 and the local fixture.

- Original session message entries remain unchanged on disk while the model receives a selected view.
- Repeated requests preserve the existing serialized message prefix when the view is unchanged.
- Resume, tree navigation, and extracted forks use only selections on their active branch.
- Actual tool-loop results are persisted before the next selection. Every result in the newest complete tool exchange is protected, including multiple calls in one assistant response.
- Scripted restoration returns original text at its original position with a historical label. It does not rerun tools.
- Unknown evidence, ambiguous tool identities, and modified incoming tool results fail explicitly. Interrupted exchanges stay protected, and the session can continue using Pi's existing provider-side protocol repair without changing stored evidence.
- Cancellation and rejected selections do not install partial decisions. A final-payload budget rejection does not commit the proposed selection or send an HTTP request.
- Under pressure, retirement changes only the selected tool-result text in the actual provider request. Newly produced observations stay visible for the next model response. Resume reproduces the selected prefix without another decision when the request still fits.
- Fixture Jev scores can preserve older evidence while retiring a newer eligible result. Scores at the cutoff, invalid responses, cancellation, and oversized judge inputs cannot force a retirement. Judge failures are recorded separately from coding-request budget stops.
- Disabling native automatic compaction prevents summarization and retry after a simulated provider overflow.
- Input, output, cache, and cost fields exposed by Pi are captured with the request's budget measurement.

These checks do not establish live cache hits, Jev selection quality, or monetary savings.

## Deliberate boundaries

**Protected content.** Only whole text tool results can be retired. The newest complete tool exchange, results from incomplete exchanges, non-text results, user messages, and assistant messages stay intact. Retired results keep their original call relationship, status, and details. Their text is replaced by a deterministic stub. Error and truncation status remain separate.

**Selection records.** Version 1 records contain the policy identifier, source leaf, and full set of retired session-entry IDs. Restored evidence is identified from previous retirements on that branch. No separate database is used. Unsupported record versions and histories containing summaries are rejected rather than silently reinterpreted. Reused tool-call IDs across valid assistant turns are also rejected. Providers that reuse IDs need an expanded identity mapping before they are supported.

**Commit boundary.** The context hook reconstructs the recorded view and applies any scripted selection. Automatic retirement runs at the provider-request hook, where the payload includes system text, tool schemas, and the output allowance. Both paths validate selections and record them only after the final payload passes the budget check, before dispatch. A recorded selection does not imply the provider accepted the request or the task succeeded.

**Provider mapping.** Automatic retirement supports text-only OpenAI Completions payloads with unchanged, unique tool-call IDs. Before replacing text, it verifies that the outgoing result matches the selected view, including historical labels and Pi's Unicode sanitation. If Pi has normalized a candidate's ID, or the result mapping is missing, ambiguous, or changed, selection stops rather than guessing. Other extension stacks and provider APIs remain unverified.

**Budget estimate.** The initial estimator supports text-only `openai-completions` payloads. It counts UTF-8 bytes of the serialized payload as an input-token estimate, adds an explicit margin, and reserves the request's actual maximum output tokens. This includes system text and tool definitions, but it is not an exact tokenizer or a universal upper-bound proof. It can stop a request that would actually fit. The test fixture uses a 1,024-token margin, not a calibrated product default. Multimodal payloads and other provider APIs stop explicitly until supported accounting exists. Images are preserved by the view builder, but are not yet supported end to end by the budget gate.

**Compaction and failures.** The SDK harness disables native automatic compaction in isolated settings. The extension also cancels compaction hooks. There is no summary fallback or substitute selector. Stop records distinguish budget rejection, invalid state, and cancellation because Pi can label an early cancellation as an error. User cancellation is not counted as a manager rejection or shown as a manager error notification. No global Pi settings are changed.

**Usage.** Records preserve Pi-normalized usage and its calculated cost fields, not raw provider billing. All-zero usage is marked unavailable rather than treated as evidence of a free request. Individual zero fields may be provider defaults rather than measured quantities. The fixture's usage numbers are synthetic and cannot establish actual cache behavior or prices.

## Synthetic Jev pilot

`npm run pilot` prints a dry-run manifest without loading credentials or making network requests. Six authored histories cover basic relevance, a task detour, a corrected requirement, a buried dependency, a superseded read, and instruction-like tool output. Each contains two eligible candidates and a protected latest exchange. Expected answers and their reasons are kept outside the requests. The pilot uses the existing history, candidate, state-builder, and HTTP-client code without a separate prompt.

`npm run pilot:live` loads `TYPESAFE_API_KEY` from the ignored `.env` file and sends those six requests twice, sequentially. Both repeats use identical frozen bodies. This command spends money. The approved campaign is at most 12 requests to `jev-1.13.0`, with no retries, coding-model calls, or automatic expansion. Each request reserves the price of 64,000 input tokens. The full reservation is $0.032256 against a $0.05 estimated allowance at the recorded price. This is not a provider-enforced billing cap. An unexpected usage report stops further requests, but cannot undo charges already incurred.

The runner creates `results/synthetic-v1/` exclusively and refuses to overwrite or resume it. The manifest, including exact synthetic requests, labels, hashes, versions, and price schedule, is written before network access. The journal records a start before each call and the result afterward, with raw usage, scores, and latency. The first service/contract failure or cancellation stops the campaign. Wrong relevance judgments do not cause tuning or retries. An unmatched start after a process crash has unknown outcome and cost. Do not delete the directory to retry an interrupted campaign without reconciling its attempted calls and obtaining approval for further spending.

`report.json` separates unknown costs from the known subtotal, reports relevant-versus-irrelevant pair order, and measures repeat score differences. Strict cutoffs of 0.1, 0.2, and 0.5 are offline diagnostics only. A hypothetical harmful omission means an authored relevant candidate scores below that cutoff; an irrelevant retention is counted separately. No selected context or agent action is executed. These six development cases cannot establish a safe default threshold, calibrated probabilities, injection resistance, real task accuracy, or savings. The client config's required `retireBelow` value is unused by the direct evaluation calls.

Artifacts are private, local, and Git-ignored, not an automatically backed-up research archive. Keep the exact manifest and journal with any report derived from this campaign. A later confirmation study needs a separate frozen dataset and approved protocol.

### Paired task-state pilot

`npm run pilot -- --paired` prints the second protocol without network access. It holds candidate evidence fixed across six before/after task pairs. Three corrections swap the required target. A historical comparison and a newly enabled consumer each make a second observation relevant without displacing the first. A temporary detour leaves both relevance labels unchanged. Similar-topic negatives replace the first pilot's repeated marketing example. Relevant candidates occupy each position equally across the ten rankable states.

`npm run pilot:paired:live` loads the ignored `.env` and sends the 12 states twice to the same model and prompt. The approved campaign is at most 24 requests, no retries, with a $0.064512 input reservation against a $0.10 estimated allowance. It writes exclusively to `results/paired-v1/`, separate from the first campaign, with the same journaling and stop rules. Both-positive states have no relevant-versus-irrelevant ranking comparison and are counted as not applicable. Paired results report signed score changes; unchanged labels are controls, not a requirement for identical scores. Missing states produce unknown changes, never zeroes or successes.

These are authored development fixtures, not a held-out benchmark. A correct direction alone does not establish useful separation or safe removal. No cutoff is selected and no prompt is changed by the run.

## Next stage

The first live contract check passed. Next, test state-dependent relevance on broader development fixtures, especially superseded evidence and similar-topic negatives, before choosing a cutoff or changing the prompt. Then compare retirement with automatic reconsideration of old evidence. The current restoration tests prove the mechanism, not the ability to find relevant history.

Before paid agent runs, choose the model/provider and propose the run count and expected cost. Live cache verification, provider-specific token calibration, Harbor integration, and compatibility with the normal extension stack remain untested.
