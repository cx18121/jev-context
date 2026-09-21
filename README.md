# jev-context

An experimental context manager for Pi. The goal is to select useful verbatim evidence from preserved session history, reducing total cost without hurting quality or improving quality at an acceptable cost. See [DESIGN.md](DESIGN.md) for the research plan.

This repository currently contains the integration foundation and a deterministic retirement baseline, not a working Jev selector. It is not installed in your normal Pi setup. No paid model calls are needed to run it.

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
- `src/retirement.ts` retires eligible observations oldest-first when the outgoing request exceeds that budget.
- `test/` contains unit fixtures and actual SDK lifecycle tests. `test/extension.test.ts` shows how the extension factory is loaded in isolation.

Load the factory explicitly in an isolated Pi SDK setup, with native automatic compaction disabled.

```ts
createContextExtension({
  policy: 'oldest-first-v1',
  budget: { contextLimit: 32768, marginTokens: 1024 },
});
```

These budget values are examples, not calibrated defaults. The policy preserves the recorded view until the full serialized request exceeds the budget. It then retires visible, eligible observations in capture order until the request fits. It skips any observation whose stub would not shrink the request. If retirement cannot make the request fit, dispatch stops and no proposed selection is recorded. This policy does not restore evidence automatically.

For integration tests, `policy: 'scripted-v1'` accepts an optional `select` callback. Omitting it or returning `null` reuses the recorded view. The two policies cannot run together in one extension instance. Both honor existing branch-owned selections on resume, regardless of which policy recorded them.

## Behavior proved locally

Tests demonstrate the following properties against Pi 0.85.1 and the local fixture.

- Original session message entries remain unchanged on disk while the model receives a selected view.
- Repeated requests preserve the existing serialized message prefix when the view is unchanged.
- Resume, tree navigation, and extracted forks use only selections on their active branch.
- Actual tool-loop results are persisted before the next selection. Every result in the newest complete tool exchange is protected, including multiple calls in one assistant response.
- Scripted restoration returns original text at its original position with a historical label. It does not rerun tools.
- Unknown evidence, ambiguous tool identities, and modified incoming tool results fail explicitly. Interrupted exchanges stay protected, and the session can continue using Pi's existing provider-side protocol repair without changing stored evidence.
- Cancellation and rejected selections do not install partial decisions. A final-payload budget rejection does not commit the proposed selection or send an HTTP request.
- Under pressure, oldest-first retirement changes only the selected tool-result text in the actual provider request. Newly produced observations stay visible for the next model response. Resume reproduces the selected prefix without another decision when the request still fits.
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

## Next stage

Implement one Jev retirement policy under the same pressure trigger, eligibility, and budget rules as the deterministic baseline. Then compare retirement with automatic reconsideration of old evidence. The current restoration tests prove the mechanism, not the ability to find relevant history.

Before paid agent runs, choose the model/provider and propose the run count and expected cost. Live cache verification, provider-specific token calibration, Harbor integration, and compatibility with the normal extension stack remain untested.
