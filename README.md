# jev-context

An experimental context manager for [Pi](https://github.com/earendil-works/pi). It selects which tool results remain visible to the coding model while preserving the original session history. Retired results can be restored verbatim without rerunning tools.

The goal is to reduce context cost without losing evidence needed to finish the task. The automatic policy uses a bounded task brief, a lexical archive lookup, and Jev relevance judgments to choose what to retire or restore.

## Status

This is research code, not a drop-in extension for everyday Pi use. It runs through an isolated SDK harness with native compaction disabled. The SDK is pinned to 0.87.1. General improvements in task accuracy, cost, or latency have not been established.

Tests cover session persistence, provider payloads, retirement and restoration, and failure handling. The evaluation tools support paired coding runs with native SWE-bench patch grading and ContextBench source-coverage diagnostics. Synthetic fixture results are separate from live task results.

## Run the checks

Requires Node.js 22.19.0 or newer.

```sh
npm ci
npm run typecheck
npm test
```

Tests need no credentials, Docker, or paid model calls. They use local HTTP fixtures, temporary sessions, and isolated Pi settings without loading your normal extensions or agent history.

## SDK usage

Load the factory into an isolated Pi SDK session. Pass the same `SessionManager` to both the extension factory and `createAgentSession`, and disable native automatic compaction.

```ts
import { createContextExtension } from './src/extension.ts';

const extension = createContextExtension(sessionManager, {
  policy: 'oldest-first-v1',
  budget: { contextLimit: 32768, marginTokens: 1024 },
});
```

This deterministic policy retires eligible tool results in capture order when the request exceeds its budget. It makes no relevance-model calls and does not restore results automatically. The budget is illustrative, not a calibrated default. See [`test/extension.test.ts`](test/extension.test.ts) for the complete isolated SDK setup.

Automatic retirement and restoration use `jev-select-v1`, which requires explicit Jev, selection, and brief-model configuration. Brief generation and relevance judgments incur separate inference costs. Configuration and failure behavior are documented in [Architecture and behavior](docs/architecture.md).

## Important limits

- Only whole text tool results can be retired. User and assistant messages, incomplete exchanges, and the newest complete tool exchange remain protected.
- Provider support is limited to text Completions and full, stateless Codex SSE requests. Codex requires explicit output-reserve headroom, which is not an enforced output-token cap. Other transports and normal extension stacks remain unverified.
- Relevance scores and archive lookup can miss dependencies. No threshold is recommended as safe by default.
- Budget checks use conservative byte counts and a separate heuristic working-context estimate. They are not a tokenizer or a hard spending cap.
- Unknown inference cost, invalid history, and requests that cannot fit stop dispatch. There is no automatic summary fallback.

## Documentation

- [Architecture and behavior](docs/architecture.md) covers policies, task briefs, persistence, provider mapping, and safety limits.
- [Evaluation](eval/README.md) covers offline diagnostics, integration controls, and paid-run boundaries.
- [Paired native task runner](eval/swebench/README.md) covers sandboxed coding runs, patch grading, and source coverage.
- [Historical experiments](docs/experiments/README.md) contains earlier pilot reports with their original scope and limitations.

Generated run artifacts and credentials are excluded from Git. Do not commit session dumps, raw model payloads, evaluator datasets, or `.env` files.
