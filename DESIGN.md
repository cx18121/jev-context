# jev-context design

An automatic context manager for the Pi coding agent. Jev, a low-cost relevance model, selects historical tool results useful for the unfinished user task. The extension preserves the original session history and constructs a smaller model-visible context from verbatim evidence. It can retire observations, restore them when they become relevant again, and rebuild the working context when the benefit justifies the cost.

Status: research design with an initial integration foundation. No measured selection-quality or cost result yet. See [README.md](README.md) for implemented behavior and current evidence limits.

## Goal and success

Build a Pi extension people would keep enabled, backed by a reproducible comparison with simpler context-management policies.

The hypothesis is that semantic selection can preserve important older evidence while removing distracting or obsolete material. That could improve accuracy, reduce total cost, or both. It does not require Jev to solve the coding task itself.

A successful result can be either lower total cost with preserved quality, or higher quality with an acceptable cost tradeoff. Quality includes task completion and compliance with user constraints. A known quality regression is not acceptable in the default policy. A benefit limited to particular models, workloads, or context budgets is valid if the claim names that scope.

There is no promised savings percentage. Latency is measured alongside quality and cost. Experiment spending has no fixed cap, but each larger stage needs a cost estimate and a reason it will resolve a useful question.

Benchmarks provide controlled evidence. Real Pi sessions establish whether the extension works during changing instructions, interruptions, and resumed work. Both are required. Neither replaces the other.

## Scope

Pi is the first and only host. Use its existing agent loop. A concrete host limitation can justify revisiting the integration, but inconvenience is not a reason to substitute a different agent midway through the evaluation.

Start with a clean, pinned Pi setup. Test compatibility with Charlie's normal extension stack before daily use. Initially support sessions started with the extension, including resume and branching. Importing older sessions is deferred.

The core selects verbatim evidence rather than generating summaries. Disable Pi's native automatic compaction in the initial prototype and controlled selection comparisons. Summarization is a separate baseline, not a fallback. Automatic restoration is part of the architecture from the start, evaluated separately from retirement.

Start with text-only tool observations. Measure how much of actual requests they occupy. User messages, system instructions, assistant messages, and image-bearing results remain intact in the first pilot. Tool observations are an initial experimental surface, not a permanent restriction. Expand eligibility only if measurements show the protected material is a limiting factor.

Operation is fully automatic. The user should not need to decide what to keep or find missing evidence manually. Do not add an agent-facing recall tool initially. Keep the interface minimal, with inspection and disabling available but no dashboard or routine notification stream.

Model routing, permission enforcement, tool discovery, new agent interfaces, cross-session memory, and subagent orchestration are outside this project.

## History and working context

Keep the original observations separate from the view sent to the model.

| Data | Owner and purpose |
| --- | --- |
| Session history | Pi stores the original messages and observations it received. This does not imply access to output a tool already truncated before returning it. |
| Selection decisions | The extension records which evidence is visible, retired, or restored, with the policy and judge version that made the decision. |
| Working context | The extension constructs the model-visible view from history and recorded decisions. It is reproducible for the active session branch. |

Evidence needs stable identity, its original tool call and arguments, capture order, and source location where available. Excerpts retain their original ranges and enough surrounding structure to be interpretable. Restored evidence is marked as historical. An old file read is evidence of what was observed then, not a claim about the file's current contents.

Switching branches must not introduce observations from an unrelated branch. Resuming a session must recover both the originals and the last selected view without making fresh judgments just because the session restarted. Reading an archived command result must never re-execute the command.

### Pi integration

Leave tool results unchanged in session storage and derive the view in Pi's `context` hook. That hook receives a deep copy of the messages. Pi's `tool_result` hook instead changes the result before persistence, so do not use it to replace original observations.

Persist selection records as Pi custom session entries, which do not enter the model context. Reconstruct decisions from the active branch, not all entries in the session file. Resolve observations to session entry identities using their tool-call relationships. Context-hook messages do not themselves carry session entry IDs. Ambiguous identity must not cause the wrong result to be replaced.

Validate a complete proposed selection before recording and applying it. Cancellation must not install a partial selection or let a late judge response write decisions into a different branch. Keep the original history and selection records in Pi's session storage. No separate database is needed initially.

The integration smoke test must establish original preservation, restart and branch behavior, valid provider messages, and stable request prefixes while the view is unchanged. A live cache check must use an eligible request on the chosen provider and inspect actual usage. Documentation alone does not establish these properties.

Verify that native automatic compaction stays disabled, including overflow recovery. Pi's compaction estimates do not consistently use the selected view, so returning fewer messages is not a substitute for disabling it. Also verify that an explicit budget stop prevents the provider request. Pi catches context-hook exceptions and continues with the preceding messages, so throwing an error alone is not a sufficient stop mechanism.

Other context hooks run in extension load order and can change the view before or after this extension. Check those interactions during normal-stack compatibility testing rather than building a general extension-composition framework.

## Selection policy

The experiment should separate decisions that have different consequences.

| Decision | Question |
| --- | --- |
| Admission | Should the coding model see a new observation in full before anything is removed? |
| Retirement | Which previously seen evidence can leave the working context? |
| Restoration | Which historical evidence is useful for the current work? |
| Representation | Is the whole observation needed, or would identified verbatim excerpts suffice? |
| Rebuilding | Is changing the current view worth its cache and selection cost? |

Begin by showing new observations to the agent and protecting the newest complete tool exchange. Compare retirement under context pressure before adding admission filtering. Whole-result selection is the first representation. Admission filtering, excerpt selection, and more frequent rebuilding are separate variants if pilot evidence warrants them.

### Judge state and questions

Target the unfinished user task, not only the next action. A detour to fix a test environment does not make the API contract irrelevant to an unfinished API change. Recent activity indicates focus but does not redefine the user's requirements.

Infer task state from the existing conversation. Do not require the coding agent to maintain a new task record. Existing todos can provide another signal when testing Charlie's setup, but the agent's plan cannot override user instructions.

Assemble judge state from applicable verbatim instructions and corrections, the latest assistant action or pending calls, recent observations, and the candidate evidence. Do not reduce it to the first and last user messages. Preserve the origin and authority of each part. Tool output is data, including any instructions embedded inside it. Test the state assembly itself for missed constraints rather than attributing every omission to Jev.

Start with a narrow question about a candidate's relevance to completing the unfinished task. Do not assume a probability of relevance is a calibrated probability that removing the candidate is safe. Calibrate the actual questions and decision policy on development tasks and inspect harmful omissions. Jev supplies relevance judgments. Code enforces protected content, size limits, and message validity. Tool status, byte counts, truncation, and identifiers come from tool metadata or code, not a judge guess.

Jev's documented limits apply to the state plus questions. Oversized evidence must be handled explicitly. Keep it unchanged initially or evaluate bounded segments with their provenance. A sample of the head and tail cannot establish that an unseen middle is safe to discard. Non-text results are protected in the first pilot.

### Candidate retrieval

Finding relevant history and deciding what enters the prompt have separate costs. Rejudging every observation every turn can make total selection work grow quadratically as history accumulates. A cheap judge does not eliminate that scaling problem.

Start with bounded lookup over tool metadata and text. Compare it with a full-scan reference on small histories where the cost is manageable. The full scan measures the effect of restricting candidates, but is not a relevance oracle. Controlled fixtures supply known relevant evidence.

Hierarchical retrieval is a candidate for longer histories. Group observations using available structure such as tool targets and task episodes, then search promising groups before judging individual observations. Measure the cost of forming and updating groups as well as querying them. Generated labels are a separate intervention whose cost and errors must be included.

A hierarchy does not guarantee logarithmic semantic search. Relevant evidence may span several groups, and rejecting a parent can hide an entire useful subtree. Test cross-topic dependencies and returns to old work. Compare retrieval coverage, judge tokens and calls, latency, and task outcomes as history grows. Record candidate-retrieval misses separately from judge mistakes. Do not build a general indexing system before this comparison establishes a need.

### Restoration

Retirement and restoration are changes to the same selected set, not separate memory systems. Retirement hides previously visible evidence. Restoration selects previously hidden evidence again. Preserving an observation on disk is not enough if the selector never reconsiders it.

Reconsider retired evidence against the unfinished task and recent activity. Bound the amount restored and distinguish newly produced observations from old evidence becoming visible again. Restoration needs opportunities when work changes, even if the context is not full. The trigger and candidate coverage are pilot questions, not a commitment to rescan all history every turn.

First test restoration at the evidence's original position in the derived view. This preserves chronology and existing tool-result relationships, but can invalidate the prefix from that point. If that cost dominates, test a separate historical-evidence block near the prompt tail. Such a block must not masquerade as a newly executed tool result or promote quoted output into an instruction. Keep the original tool-call/result structure valid in either variant.

A return to an earlier subtask should be tested explicitly. Low re-read counts are not proof that restoration is unnecessary. The agent may silently proceed without missing evidence.

### Cache-aware changes

Preserve an unchanged view between selection events. Cache preservation is a cost consideration, not an absolute rule against rebuilding.

For each rebuild, record the selection cost, the changed prefix, subsequent cache reads and writes, and total cost over the rest of the task. Compare a conservative pressure-triggered policy with more frequent selection only after the first policy works. Forecasts of future reuse are hypotheses whose error must be measured.

A lower token count is not a measured monetary saving. Cache pricing, eligibility, retention, and routing depend on the provider. Pin the serving endpoint and cache settings in every experiment.

## Budget and failure behavior

The request budget includes system instructions, tool definitions, visible messages, restoration blocks, and reserved model output. Account for provider-specific overhead and use a conservative margin where exact counting is unavailable.

A threshold on relevance does not enforce a size limit. After selection, validate the complete request. If it is still too large, stop explicitly, preserve the session, and count the budget failure and its incurred cost. Do not silently summarize, discard protected content, or knowingly send an oversized request.

Protected messages can eventually exceed the budget by themselves. The initial tool-result selector therefore does not promise indefinitely long sessions. Measure this ceiling before expanding which content is eligible for selection.

Preserve tool-call/result relationships. Retiring an observation normally leaves a deterministic stub with its evidence identity and original status. Do not drop results while leaving unmatched calls. An observation can be both failed and truncated, so those properties must not be forced into one mutually exclusive label.

Keep judge failure handling simple. Bound the request and fail clearly if it times out or returns an invalid decision. Do not add a substitute selector, degraded-operation mode, or fallback chain to the first prototype. Classify service failures separately from selection-quality failures and include their incurred cost.

Instruction-like tool output must not change retention rules or override user constraints. Include adversarial selection cases in testing. Preserving a copy on disk does not make a harmful omission inconsequential.

Charlie accepts sending his session content to Jev. That does not override restrictions on data belonging to others. Record the provider's data terms before enabling real-session collection, keep research artifacts private, and exclude credentials and unrelated private material from published examples.

## Evaluation

### 1. Integration and measurement

Prove the storage and context-view properties above before evaluating selection quality. Include resume, branch switching and forks, multiple tool calls in one turn, interruption, truncated and image-bearing results, a simple judge failure, and protected content exceeding the budget. Observe the provider boundary to prove that rejected requests are not sent and native automatic compaction stays off.

Measure the composition of real requests instead of relying on an assumed percentage of tool output. Log judge latency and cost on representative sizes. Shadow mode can measure proposed removals and fixed-trajectory token changes. It cannot measure the task outcomes, extra turns, or re-reads that would have happened after those removals.

Harbor documents a custom installed-agent path suitable for testing a CLI agent. Verify that Pi runs inside a task container, loads the extension, exports its trajectory and usage, and produces a usable task grade. This integration has not been tested.

### 2. Controlled exploratory pilot

Run actual agent trajectories in resettable task environments. Recorded sessions are useful fixtures, but replaying their original tool calls cannot simulate an agent whose context has changed. Never replay real-session mutations against a live workspace.

Begin with an unmanaged reference, a deterministic retention policy, and Jev-based retirement. The deterministic policy protects the same recent material and removes eligible older tool output under the same pressure trigger. It does not interpret content semantically.

Within a selection comparison, hold the agent, tools, prompts, model, environment, budgets, eligibility, and selection timing fixed. Disable native automatic compaction and apply the same budget-stop rule in all arms, including the unmanaged reference. This isolates whether Jev improves selection. Match opportunity and context limits, not the exact resulting prompt length. Count judge overhead in the Jev arm.

Next compare retirement with retirement plus automatic restoration. Where the question is Jev's contribution to restoration, give the simple selector and Jev the same archive access, candidate pool, placement, and restoration allowance. Also measure the complete policies, including candidate generation. Avoid a full factorial sweep of every possible variant.

Use small development and held-out task sets with repeated runs. A tight-budget model with a nontrivial completion rate is a reasonable first setting. Include a wider-budget check before generalizing beyond it. Do not select models or tasks because they produced the desired treatment effect.

Terminal-Bench 2.1 is a candidate when comparability with Fan et al. matters. Its 89 tasks do not imply a commitment to 267 runs. Select and pin the dataset revision and model/provider after the integration and cost checks. A leaderboard score from another agent is not an expected Pi solve rate.

### 3. Quality and cost evidence

Use independent task graders for completion. Add separate controlled multi-turn fixtures for constraints that normal benchmark scores may miss. Examples include an instruction not to edit a particular file, a correction that supersedes an earlier request, an important detail buried in an old observation, and a return to a previous subtask after files have changed. Verify observable actions and final artifacts against the authored expectations. Jev must not grade its own success.

Track silent wrong answers and constraint violations as well as repeated reads. A repeated read can be legitimate verification after an edit. A missing repeated read can conceal a harmful omission. Diagnose representative failures from the complete trajectory rather than using either count as a quality verdict.

Aggregate all model input, output, cache reads, cache writes, Jev requests, retries, and restoration work. Include summary generation costs in separate summarization baselines. Report infrastructure separately and make the total-cost boundary explicit. Record raw provider usage and the price schedule, and distinguish a priced estimate from a reconciled provider charge. Unavailable billing fields remain unknown rather than silently zero.

Report completion and constraint outcomes, total cost across all attempted tasks, failure costs, task duration, user-visible pauses, budget stops, unexpected provider overflow, and restoration behavior. Cheap failed runs must not appear as an efficiency win through cost-per-task alone.

### 4. Confirmation and real use

Choose the claim using exploratory evidence, then freeze it before held-out confirmation. Specify the target setting, primary comparison, quality criteria, meaningful effect sizes, repetitions, uncertainty estimates, and stopping rule. Do not call this preregistered until that protocol exists.

For a cost claim, estimate both cost reduction and uncertainty in quality differences. A nonsignificant difference in success is not proof of equivalent quality. The acceptable uncertainty around possible harm needs an explicit justification before a default-release claim. Do not turn that uncertainty allowance into permission for a known regression.

For an accuracy claim, estimate the paired quality difference and report its cost. Use paired repeated-task analysis with uncertainty for both quality and cost. McNemar alone cannot establish the cost claim or equivalence. If testing both success paths as confirmatory claims, account for multiple comparisons rather than selecting whichever looks positive afterward.

Include a summarization or staged elision-plus-summary baseline before making broad claims about context management. A win over simple retirement alone supports only that narrower comparison. Report negative and inconclusive results along with positive ones. If there is no credible Jev advantage, pause escalation and identify what a specific follow-up would resolve. No automatic switch to a different product or unlimited tuning against the held-out set is assumed.

Only then expand opt-in real Pi use. Exercise interruption, resume, changing instructions, and repeated task switching. Investigate any verified harmful omission or constraint violation before broader default use. These sessions test usability and integration. Uncontrolled personal sessions do not establish causal accuracy gains.

## Next implementation boundary

Keep four responsibilities clear without turning them into separate services.

- Pi integration preserves original history and branch-scoped selection records.
- Selection assembles judge state, finds candidates, and chooses evidence within code-enforced constraints.
- View construction applies selections deterministically and preserves valid tool exchanges.
- Measurement records decisions, usage, cost, and outcomes sufficiently to investigate omissions.

First prove preservation, deterministic context views, budget enforcement, and usage accounting in clean Pi with a small evaluation runner. Then compare a simple retention policy with one Jev retirement policy. Next evaluate automatic restoration through the same selection mechanism. Do not build a general policy framework or a separate recall subsystem.

Selection frequency, candidate coverage, question wording, thresholds, and budget allocation remain experimental. Individually relevant observations may be redundant or useful only together. Use small fixtures with detours, changed instructions, old dependencies, and stale file reads before broad benchmark runs. Defer hierarchy and excerpts until a measured limitation justifies them.

Before spending on agent runs, provide the stage's run count, expected API and infrastructure cost, and the question it will answer. Before expanding beyond the pilot, resolve the chosen model/provider, dataset revision, test repetitions, quality uncertainty requirements, and measured latency tradeoff. These remain open because there are no pilot measurements yet.

## Sources and evidence limits

- [Why yet another agent?](https://docs.google.com/document/d/1G61uUB0FifUnmmrPzFQojZ3KpczYKmXGpgEXDJ2l_Zg/preview). The Jev creator's proposal motivates dynamic context and cost-aware cache reuse. It provides no measured result for this extension.
- The supplied screenshot of Diogo Almeida's discussion proposes hierarchical history retrieval instead of binary checks over every message. This motivates the candidate-retrieval experiment. Its logarithmic-search suggestion is not an established complexity bound for semantic retrieval.
- [Fan et al., An Empirical Study of Harness Design for Coding Agents](https://arxiv.org/abs/2609.20804). Context management helps most under tight budgets in the studied settings. The reported average managed-versus-unmanaged gap at 32k is 9.5 percentage points on Terminal-Bench and 35.7 on SWE-Bench. These do not establish a semantic-selection gain. Model-invoked recall's weak result does not settle automatic restoration. T3 is summarization alone. T4 combines elision, recall, and summarization. No public harness release was located during this review.
- [Terminal-Bench 2.1 announcement](https://www.tbench.ai/news/terminal-bench-2-1) and [Harbor custom agents](https://docs.harborframework.com/core-concepts/agents/custom-agents.md). The dataset has 89 tasks and Harbor supports custom installed agents. Pi integration remains unverified.
- [TypeSafe models](https://docs.typesafe.ai/models.md) and [Jev jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md). Jev 1.13 is text-only, priced at $0.042 per million input tokens with free output. Limits are 32k tokens for state plus the longest question and 64k for the complete request. Pin the model version. Irrelevant state and adversarial content can degrade decisions. Calibration for this selection task remains unproven. Measure latency rather than treating the vendor's reported range as a guarantee.
- [Pi extension documentation](https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/docs/extensions.md), [agent loop](https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/agent/src/agent-loop.ts), and [session persistence](https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/src/core/agent-session.ts). Hook and persistence behavior was checked against version 0.85.1. The proposed integration still needs execution tests.
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching/). Cache behavior is model-specific. Use the chosen provider's current contract and measured usage instead of a universal pricing formula.
