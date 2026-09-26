# jev-context

An experimental context manager for [Pi](https://github.com/earendil-works/pi). It keeps a bounded working set of tool results visible to the coding model while preserving the original session history. Retired results can return at their original positions without rerunning tools.

The experiment asks whether Jev can choose more useful evidence than a newest-first baseline under the same capacity constraints. Task quality, total cost, and latency improvements have not been established.

## How it works

When context exceeds a configured high-water mark, the manager packs whole tool results below a lower target, leaving room for retired results to return. The newest complete tool exchange, incomplete exchanges, and conversation messages stay protected. A bounded task sketch and archive lookup help it reconsider older evidence as the task changes.

Two modes share the same packer and lifecycle:

- `jev` ranks complete candidate evidence, splitting large inputs only for judging. Higher-ranked archives can displace lower-ranked residents.
- `capture-order` favors newer evidence and makes no Jev calls. It still maintains the task sketch, which can incur inference costs.

Neither mode summarizes or deletes the stored tool results. The sketch is advisory input to selection, not a replacement for the coding conversation.

## Status

This is research code for an isolated SDK harness, not an installable everyday Pi extension. The SDK is pinned to 0.87.1. Native compaction, automatic retries, and cache warming are disabled in the harness. Normal extension stacks remain unverified.

Tests exercise actual SDK requests, branch persistence, whole-result retirement and restoration, and failure handling with local model fixtures. The evaluation runner supports native SWE-bench patch grading and ContextBench source-coverage diagnostics. Synthetic integration results do not establish live task performance.

## Run the checks

Requires Node.js 22.19.0 or newer.

```sh
npm ci
npm run typecheck
npm test
```

The default tests need no credentials, Docker, or paid model calls. Optional Docker tests are skipped unless their task environment is configured. Local SDK fixtures use temporary sessions and isolated Pi settings without loading your normal extensions or agent history.

## SDK integration

The entry point is `createWorkingContextExtension` in [`src/working-extension.ts`](src/working-extension.ts). Pass the same `SessionManager` to the factory and `createAgentSession`. Configuration is explicit. There are no calibrated default targets or automatic credential lookup.

[`test/working-extension.test.ts`](test/working-extension.test.ts) contains runnable local examples of both modes. [`eval/swebench/run.mjs`](eval/swebench/run.mjs) supplies the guarded transports and accounting for paired task runs. Do not use an unguarded sketch callback in a budgeted harness.

## Important limits

- Selection changes only whole text tool results. Protected content can grow beyond capacity, at which point dispatch stops. Unlimited sessions and automatic compaction fallback are not supported.
- Token admission uses reported usage plus heuristic deltas, or a cold estimate. A separate byte ceiling limits the serialized request. Neither estimate is a tokenizer or a hard spending cap.
- Archive lookup is lexical and can miss dependencies. Jev's ordering and the rewritable sketch can also be wrong. Eviction means lower priority under capacity, not proven irrelevance.
- Unknown inference cost stops further requests on the affected branch, even after reopening. There is no acknowledgement or automatic recovery path.
- Provider support is limited to text Completions and full, stateless Codex SSE requests. Model switches and other transports can stop explicitly rather than produce a valid mapping.

## Documentation

- [Architecture and behavior](docs/architecture.md) describes capacity, selection, persistence, and failure contracts.
- [Evaluation](eval/README.md) covers diagnostics, integration controls, and paid-run boundaries.
- [Paired native task runner](eval/swebench/README.md) covers sandboxed runs, grading, and source coverage.
- [Historical experiments](docs/experiments/README.md) retains earlier reports with their original scope and limitations.

Generated run artifacts and credentials are excluded from Git. Do not commit session dumps, raw model payloads, evaluator datasets, or `.env` files.
