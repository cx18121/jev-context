# Architecture and behavior

The manager selects a bounded working set of whole tool observations. Original messages remain in Pi's append-only session history. Native context edits determine which observations the coding model sees, and restoration returns preserved text without executing the tool again.

The current policy is `working-set-v1`, with either Jev ranking or a newest-first capture-order control. The experiment is whether ranking improves task outcomes and total cost under capacity constraints. Local contracts do not establish that benefit.

## Implementation map

| Owner | Responsibility |
| --- | --- |
| [`history.ts`](../src/history.ts) | Validate branch history, derive visibility from native edits, and commit complete selections. |
| [`working-extension.ts`](../src/working-extension.ts) | Connect Pi's context, provider, and usage events to one bounded decision. |
| [`provider-view.ts`](../src/provider-view.ts) | Validate provider shapes and map exact tool-result text. |
| [`working-set-view.ts`](../src/working-set-view.ts) | Render and measure candidate views without changing fixed request content. |
| [`working-context.ts`](../src/working-context.ts), [`budget.ts`](../src/budget.ts) | Estimate input tokens and enforce separate token and transport allowances. |
| [`working-set.ts`](../src/working-set.ts) | Pack whole observations using the chosen order and swap rule. |
| [`ranking.ts`](../src/ranking.ts), [`jev.ts`](../src/jev.ts) | Plan complete segmented judgments, call Jev, and validate the returned priorities. |
| [`task-sources.ts`](../src/task-sources.ts), [`task-sketch.ts`](../src/task-sketch.ts), [`sketch-session.ts`](../src/sketch-session.ts) | Extract narrative sources and advance a bounded advisory sketch with verified source cursors. |
| [`text-completion.ts`](../src/text-completion.ts) | Run bounded, tool-free text inference with cancellation and usage accounting. |
| [`retrieval.ts`](../src/retrieval.ts) | Explore capture-order pages of lexically matching archived observations. |

## Integration and configuration

`createWorkingContextExtension(manager, options)` returns a Pi extension factory. It must use the same `SessionManager` as the SDK session. The runnable setup is in [`test/working-extension.test.ts`](../test/working-extension.test.ts). The paired runner in [`eval/swebench/run.mjs`](../eval/swebench/run.mjs) adds dispatch limits and separate inference ledgers.

`WorkingContextOptions` requires:

- `capacity` with a token context limit, token margin, and serialized request-byte ceiling. Codex also needs an explicit output-token reserve.
- `target` with `0 <= restoreHeadroomTokens < lowTokens < highTokens <= effective context limit`. Rebalancing packs to `lowTokens - restoreHeadroomTokens`, and restoration may fill up to `lowTokens`. The headroom is the room left for evidence to return between rebalances. All targets include output reserve and margin.
- `order` as `{ kind: 'jev', connection }` or `{ kind: 'capture-order' }`.
- `ranking` limits for a state/question pair, serialized request, batch count, segment count, aggregate input, estimated cost, per-request timeout, and total duration.
- `sketch` with an explicit priced model, output limit, timeout, and maximum catch-up updates. An optional `complete` callback provides the transport.
- `archiveLimit` and `decisionTimeoutMs`.

No target or ranking bound is a calibrated recommendation. Capture order uses the same pure ranking planner to bound its candidate pool, even though it sends no Jev requests. Both modes maintain the sketch. Different inference durations can still produce different candidate pools in real paired runs because planning uses the remaining decision time.

The isolated harness pins Pi 0.87.1, disables native automatic compaction, automatic retries, and cache warming, and explicitly selects SSE for Codex. The extension cancels compaction hooks but does not enforce all those SDK settings. Loading it into a normal Pi stack is not supported by the current evidence.

## What can change

Only eligible whole text tool results enter selection. Conversation messages, reasoning, tool calls, the newest complete tool exchange, results from incomplete exchanges, and non-text results stay fixed. A result whose retirement stub would not shrink its serialized text also stays fixed.

Retirement replaces only a result's text with a deterministic stub. Restoration uses the original text at the same position with a historical label. Call identity, result status, and details remain separate from visibility. Historical content is not a claim about the current filesystem.

Pi may synthesize `No result provided` on the wire for an interrupted call with no stored result. The mapper accepts only a unique matching call and that exact placeholder. The placeholder remains fixed and contributes to the capacity floor. It never becomes stored evidence or an archive candidate. Foreign, missing, duplicate, or changed outputs stop the request.

## Capacity measurement

Every trial has one token estimate and an independent transport measurement:

```
totalTokens = estimated input + output reserve + margin
admitted = totalTokens <= effective context limit
           AND serialized wire bytes <= maxRequestBytes
```

The effective context limit is the smaller of the configured limit and the model's context window. Completions reserves its actual request output limit. Codex requires configured headroom because the pinned serializer does not put an output cap on the request. Codex's reserve therefore does not limit generation or spending.

### Usage-anchored requests

A successful response can establish an in-memory anchor tied to the exact selected request, model, and branch. Method `provider-usage-plus-delta-v2` starts with reported input including cache counts, adds the preceding response's reported output once, and measures subsequent changes. Added input costs one estimated token per three serialized bytes. Removed tool text receives only one token of credit per five bytes. This deliberately gives less credit for retirement than it charges for restoration.

Changed request settings, incompatible prefixes, invalid usage, failed responses, model changes, or incompatible branch history invalidate the anchor. Reopening starts without an anchor.

### Cold requests

Method `cold-visible-bytes-plus-output-v1` estimates visible serialized input at three bytes per token. Opaque reasoning ciphertext is excluded. Each transmitted encrypted reasoning item must map unambiguously to a same-model successful assistant message with valid recorded usage. Its owner's whole reported output is added once as a proxy. Missing or ambiguous ownership stops measurement.

Both methods are heuristics. They can overestimate or underestimate actual token use. In particular, replaying many recorded outputs on cold resume can cause a conservative stop even when a provider might accept the request. Serialized wire bytes always include the actual ciphertext and are checked separately.

### Floor and outcomes

The floor is the request with every eligible resident replaced by its stub and all fixed content preserved. Archives outside the current candidate set remain stubbed.

| Condition | Outcome |
| --- | --- |
| Floor exceeds token allowance | `capacity-stop`, no coding dispatch. |
| Floor fits tokens but exceeds transport ceiling | `transport-stop`, no coding dispatch. |
| Floor fits admission but exceeds the low target | Pack toward the floor and record a target miss. |
| Selection is incomplete but the unchanged request is admitted | Record a deferral and send the unchanged request. |
| Selection is incomplete and the unchanged request is not admitted | `selection-incomplete`, no coding dispatch. |

An incomplete ranking is not evidence that the protected floor is too large. Unknown cost, corruption, mapping failures, branch changes, and persistence failures cannot use the safe-deferral path.

## Decision lifecycle

The context hook validates the projected branch. The provider hook sees the final instructions, tool schemas, and output allowance before choosing a view.

1. Check all branch inference journals for unresolved cost, including historical brief and judge journals.
2. Measure the current request and floor before paying for selection.
3. Decide whether there is pressure, a correction, or changed tool focus.
4. Obtain a current sketch when the decision requires one and retrieve one archive page.
5. Plan complete resident ranking and whole optional archive admission before dispatching Jev batches.
6. Pack and remeasure the result. Recheck the branch and deadline, commit synchronously, and return the selected payload.

Pressure means exceeding the high target or failing admission. Pressure and a new user/custom message with an archive trigger rebalancing toward the low target minus the restoration headroom. A changed newest-exchange tool focus with an archive triggers restoration only, up to the low target. With zero headroom, rebalancing usually leaves no room for restoration. Restoration-only decisions never evict residents and skip inference when there is no room or no fitting item on the retrieved page. Fitting turns without those triggers send the recorded view without sketch or Jev calls.

Custom extension messages currently count as corrections. An extension that injects one every turn can therefore cause repeated decisions. This remains a normal-stack compatibility limitation.

A successful decision records consumed event identities and the archive cursor, including no-op decisions. A deferral records neither a new event checkpoint nor cursor progress. The next eligible request can try again, subject to rejected-input deduplication and accounting checks.

## Packing and ranking

Rebalancing first packs residents in priority order. It then considers archives, admits those that fit, and tries allowed swaps for those that need room. After a successful swap, residents are refilled in priority order before another archive can use the freed room. Failed trials leave the prior set unchanged. This is deterministic first-fit packing, not an optimal knapsack solver.

Jev mode uses five ordinal levels. The client derives a median level from the returned probability distribution and uses expected score to break ties. Resident status, newer capture position, and identity provide further deterministic ties. An archive must outrank each selected resident it removes by at least one whole level. High-rated evidence can still be evicted under capacity. There is no relevance cutoff that exempts it from packing.

Capture order uses unique chronological positions, newest first. An archive may remove only strictly older selected residents. It requires no scores. Diagnostic `swap-margin` means the archive did not satisfy the displacement rule; `lower-priority-under-capacity` also covers older evidence excluded by the control.

### Complete bounded judgments

All eligible residents are mandatory candidates during rebalancing. Archives are optional and enter in retrieval order. The planner splits observation text into exact, contiguous Unicode-safe ranges, preferring line boundaries. Each observation range carries the tool call's serialized arguments as context, up to 2,000 bytes. Longer arguments show that prefix and are also judged in their own ranges, so no argument text goes unjudged. Splits affect judge input only. The coding model always receives a whole observation or its stub.

Every segment of an admitted candidate must fit the configured pair, request, aggregate byte, batch, segment, estimated cost, and duration limits. If mandatory evidence cannot be planned completely, selection is incomplete before any Jev call. Optional archives that cannot be included completely are omitted and recorded. The highest segment priority becomes the observation's priority.

All planned batches share the same advisory state and run sequentially. Every batch must succeed before scores can authorize selection. Replies must identify the pinned `jev-1.13.0` model, account for usage, and supply the exact question set, score type, legend, valid probabilities, consistent expected score, and confidence. There are no automatic HTTP retries or partial-score edits. Ranking scores are not reused from an earlier decision.

The client defaults to `https://api.typesafe.ai/v1/systemone`, takes explicit credentials, refuses redirects, and permits local HTTP fixtures. Price calculations in `JEV_PRICE` and byte-based reservations are catalog estimates, not reconciled charges or a guaranteed bill ceiling.

## Advisory task sketch

The sketch rewrites a bounded narrative summary. It does not retain an ever-growing list of requirements or grant authority to retire evidence. Its sources preserve distinct roles for provider instructions, user text, assistant prose, and custom messages. Tool bodies, tool-call arguments, shell-execution messages, and private reasoning are excluded. Tool-only turns do not advance the sketch sources. Retrieval and ranking receive a separate bounded tool-focus hint containing names, arguments, and error information.

The updater has a 24,000-byte serialized input limit, a 6,000-byte serialized summary limit, an 8,000-byte snapshot limit, and a 16,000-byte raw response limit. A cursor records source identity, UTF-16 offset, and prefix hash. Long sources can span updates. An appended source leaves a valid partial sketch, but the sketch is current only after the whole available source stream has been scanned. Changed scanned prefixes invalidate it.

A decision performs at most `sketch.maxUpdates` catch-up steps within its deadline. Whitespace-only progress can advance an existing sketch locally without inference. Other updates use bounded tool-free completion with no automatic retries. A rejected content update is not paid for again with the identical input, model, and output limit. Known-cost transient failures and cancellations may retry. A permanently rejected full input can therefore keep selection incomplete.

Provider instructions are snapshotted only on demand. Instruction versions that appear and disappear entirely between demanded updates are not retained as sketch sources. The summary is lossy advisory text, not a complete or provenance-strict representation of requirements. Full instructions and conversation messages remain in the coding request.

## Archive exploration

`exploreArchive` scans currently retired eligible observations on the active branch. Documents contain tool names, argument values, and original text. It splits camelCase and punctuation, ignores single-character terms, and requires at least one query-term match. There is no stemming, synonym expansion, or stopword list.

The query combines sketch text with fresh tool focus. Restoration-only preflight may use a validated but outdated sketch before deciding whether an update is worth requesting.

Version `capture-page-overlap-v1` takes the next bounded page of matches in capture order, then sorts within that page by distinct-term inverse-frequency score. Repeated words do not add weight. Common terms can make most of the archive match, so exploration can resemble a round-robin scan. The limit bounds returned candidates, not local scan work or ranking bytes.

The cursor survives query changes. It advances over the entire retrieved page only on a committed decision, including filtered and omitted candidates. A short final page does not fill from the beginning; the next decision wraps. Empty matches preserve the frontier. A frontier absent from the branch resets with a recorded reason. A malformed cursor is invalid state.

A stable pool and query can be explored over successive committed decisions. This does not guarantee relevant recall as the task changes. Synonym misses, pages not yet reached, and ranking omissions are distinct from wrong Jev judgments. [`eval:retrieval`](../eval/README.md#offline-diagnostics) measures authored first-page coverage, not eventual recall or sketch quality.

## Persistence and accounting

Pi native context edits own visibility. Version 2 `jev-context/selection` checkpoints record the policy, pre-edit leaf, and decision diagnostics, not another retired-ID state store. Resume and extracted forks use only their active branch's validated edits. Original message entries remain unchanged.

Commit writes changed result edits followed by a completion checkpoint. These are sequential writes, not a disk transaction. The reader rejects incomplete or interleaved groups. An edit or checkpoint write failure prevents dispatch and further writes from that extension instance. There is no rollback or automatic repair. Reopen an intact branch to continue.

Inference starts and results use `jev-context/inference-start` and `jev-context/inference-result`, with separate `sketch` and `ranking` kinds. Accepted snapshots use `jev-context/task-sketch`. Coding usage is recorded separately in `jev-context/usage` with Pi-normalized counts and capacity measurement. All-zero coding usage is marked unavailable, not treated as proof of a free request.

An unmatched start or a result with unknown priced cost stops later requests on that branch, including ordinary fitting turns and the capture-order control. The check also honors literal historical `brief-start/result` and `judge-start/result` entries. There is no acknowledgement path. A pre-invocation cancellation has known zero cost. After invocation, cancellation or failure without usage remains unknown even if a transport may not have sent anything.

Branch changes prevent results or edits from being attached to the new branch. An off-branch unmatched start remains on its original branch. Accounting is branch-scoped, not a global process ledger. Harnesses must separately own campaign spending and dispatch refusals.

Known-cost rejected ranking requests are deduplicated by exact hash before any batch is sent. Changed inputs can incur new cost, so this does not bound session-wide spending. User cancellation records a cancelled stop without an error notification. Sketch, ranking, and coding costs remain separate from each other and from task correctness.

## Provider and history limits

Supported request forms are text `openai-completions` and full-input, stateless `openai-codex-responses`. Selection changes only verified result text. Instructions, reasoning items, assistant messages, tool definitions, and call identities remain untouched.

Codex requires same-model assistant history and follows Pi's call-ID suffix stripping. Function and grammar-tool outputs are covered by local serializer tests. Missing or ambiguous mappings, changed text, media, delta requests, and unsupported tool-search shapes stop explicitly. Completions also requires stable unique tool-call IDs. Some model switches rewrite IDs and cannot map safely.

WebSocket and automatic Codex transport are unverified. A delta can be constructed after the hook sees the full payload. Cache-warm replay also reuses hooks without the ordinary decision lifecycle, so cache warming must remain off. SDK auto-retry and normal-stack model-switch behavior are not established by the current fixture evidence.

Compacted histories, branch summaries, arbitrary native edits, and legacy version 1 retired-set checkpoints are unsupported. There is no compaction fallback. Protected messages and call arguments can eventually dominate the request, regardless of how well Jev ranks tool results.

## Evaluation and evidence

Local tests cover whole-result selection on actual SDK wire payloads, original-history preservation, resume and fork behavior, complete ranking, restoration without rereading, and capture-order control behavior. They also exercise cancellation, unresolved costs, invalid mappings, interrupted calls, and persistence failures. Fixtures use synthetic responses and prices.

The [paired runner](../eval/swebench/README.md) reuses each sandboxed coding trajectory for patch grading and ContextBench source-coverage diagnostics. A dispatched request, a completed trajectory, a passing patch, and a useful context choice are separate outcomes.

The ContextBench bridge in [`eval/contextbench.ts`](../eval/contextbench.ts) verifies captured tool text against branch evidence. Only exact successful untruncated `read` results map to immutable base-source lines. Other observations remain explicitly unmapped. Restored evidence maps from its preserved original after its historical label is checked.

Discovery records that an observation existed, not that the model used it. Currently visible coverage differs from cumulative discovered coverage. Reference spans are evaluator-only inputs, never selection inputs. The export uses request boundaries rather than upstream retrieval steps and omits final patch-context fields, so it is not an official ContextBench evaluation or leaderboard-comparable AUC. See [Evaluation](../eval/README.md) for commands and historical integration results.

Live ranking quality, sketch fidelity, lexical recall, cache economics, and total cost or latency benefit remain unproven for this working-set design. Earlier pilot reports retain their original protocols and cannot establish those claims.
