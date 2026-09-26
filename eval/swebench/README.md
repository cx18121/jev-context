# Paired native task runner

`run.mjs` runs one task through Pi 0.87.1 and `gpt-6-sol` with medium reasoning, once per arm. Rounds before 2026-09-25 evening used `gpt-5.6-sol`; each manifest records its model. Live runs use four arms by default; `--arms=a,b` selects a subset in this order:

- `default` runs unmodified Pi with native compaction and no manager.
- `clearing` uses the `working-set-v1` packer and targets, clears the oldest evidence under pressure, and never restores. It makes no sketch or Jev calls.
- `control` orders evidence by capture time, newest first, with earned restoration and the sketch. It makes no Jev calls.
- `selector` uses Jev ranking with earned restoration and the sketch.

Each arm gets the same prompt, tools and model, with a fresh offline container. Native patch grading and ContextBench source coverage use those same trajectories. Local failure fixtures use the control and selector pair; `--local --arms=...` smoke-tests other arms with scripted responses.

Both arms maintain a rewritable task sketch using `openai-codex/gpt-6-luna` with low reasoning. Sketches have separate cache keys and guarded transports. Their request records include the arm, catalog cost and latency. Selection requests them on demand. They never appear in coding evidence captures. Private artifacts include each sketch request and its returned text and stop reason, including rejected updates. The response-byte ceiling bounds this capture. Sketch captures exclude private reasoning and response headers.

`--live` makes paid inference requests and requires approval of the task and sketch-inclusive spending limits before invocation. Local modes exercise the real coding and sketch SDK serializers against a loopback HTTP server with scripted responses. No paid inference occurs in local modes. Their usage and costs are synthetic fixtures. New manifests and reports have version 2 and lifecycle `working-set-v1`. Existing artifacts retain their recorded code and protocol.

## Inputs and commands

The runner accepts only an agent-facing JSON object with exactly `instanceId`, `repo`, `baseCommit`, `image`, and `problemStatement`. The image must be a pulled `swebench/sweb.eval.x86_64.*@sha256:...` digest. Gold patches, tests, and annotations are rejected as extra fields. Start Docker first.

```sh
# Scripted inference, actual Docker tools and Pi SDK. No model calls or credentials.
node --import tsx eval/swebench/run.mjs --local agent-task.json results/NEW_LOCAL_RUN

# Container-only output and cleanup contracts. No model calls or credentials.
JEV_SANDBOX_TASK=agent-task.json node --import tsx --test test/swebench-sandbox-docker.test.ts

# Evaluator-only inputs enter after the run.
node --import tsx eval/swebench/score.ts results/NEW_LOCAL_RUN evaluator-reference.json
PYTHON_DOTENV_DISABLED=1 uv run --no-project --python 3.13 --with swebench==5.0.2 \
  python -I eval/swebench/grade.py results/NEW_LOCAL_RUN evaluator-native.json
```

Output directories are exclusive. Never overwrite an interrupted paid run to retry it. Artifacts include opaque reasoning and source and belong under ignored `results/`, not Git. Neither command installs this extension in your daily Pi setup.

`evaluator-reference.json` contains `instanceId`, `baseCommit`, `contextbenchId`, `datasetRevision`, and `spans` with `{file,start,end}`. `evaluator-native.json` is a one-row SWE-bench dataset with the exact executed repository, base, problem statement, and pinned image. Freeze dataset revisions and input hashes with the task-set protocol before live runs. Five development tasks are not statistical or publication evidence.

## Boundaries

- Each arm independently verifies a clean checkout of the pinned image's HEAD and records that commit separately from the dataset source base. Native images may contain committed dependency/setup adjustments. As in the native grader, those stay in place. The captured agent patch is relative to the verified image HEAD, even if the agent later moves HEAD, so it excludes pre-existing setup changes. There are no host mounts or container networking. Cleanup targets only owned containers.
- `read` uses native Pi range selection and footers with container-only content operations. It accepts plain ASCII paths under `/testbed`, caps the complete file at 1 MiB, and treats content as text. Native path resolution performs a metadata-only host existence probe, but may not alter the absolute path. It cannot fall back to host file reads. Bash runs only in the container and is the fallback for unusual paths.
- Bash display output keeps a prefix within 32,000 bytes and 2,000 lines, including an explicit truncation notice. Excess output is drained and discarded until the command exits, not saved to a host file. The command's exit code is preserved, so the agent can narrow a search and continue in the same container. Infinite writers remain subject to the command timeout. Timeout, cancellation, and execution transport failures still remove the owned container. Exit codes 124 and 137 retain the timeout/killed interpretation. Full-file reads, patch capture, source snapshots, and container metadata never use display truncation.
- The evaluator snapshots dataset-base regular UTF-8 files through one Git batch process before the first prompt. It does not substitute the prepared image's source for that reference. Symlinks, binaries, files above 1 MiB, and files exceeding the total 32 MiB snapshot allowance are explicitly excluded. The agent and judge never receive the snapshot as extra context.
- Each dispatched coding request records its selected tool text against the current branch and immutable base snapshot. Shell output, modified files, truncated reads, and unavailable source remain unmapped. If a reference span needs unavailable base source, coverage is unknown rather than computed with a smaller denominator. Scores are local lower-bound diagnostics, not official ContextBench metrics.
- Full stateless Codex SSE requests only. Reasoning, IDs, assistant text, and tool-call structure cannot change. No automatic compaction, retries, cache warmup, or resource discovery. Every arm gets a fresh session key. That does not guarantee independent provider caches.
- Live runs allow at most 150 coding requests per arm, 150 sketch requests total and 240 judge calls total. Local fixtures keep 24. The shared sketch and run caps can let the first arm exhaust the second arm's allowance. Different trajectories and remaining decision time can also produce different candidate pools. This is a development comparison, not a controlled estimate of ranking's benefit.
- A decision has 180 seconds, including up to four sketch updates of at most 30 seconds each. Ranking reserves up to eight 15-second requests within a 120-second allowance and the remaining decision time. Coding's 90-second deadline starts at dispatch, after selection. Request records separate `decisionMs`, `preDispatchMs` and `requestToHeadersMs`. A live run has 240 minutes across its arms and commands have at most 120 seconds.
- Coding request/response limits are 2,000,000/512,000 bytes live, so the default arm can grow unmanaged, and 180,000/512,000 bytes in local fixtures. The sketch request ceiling is derived from twice the 24,000-byte input allowance, the sketch instructions and 4,096 bytes of envelope allowance to cover JSON escaping. Its response ceiling is 128,000 bytes. Judge requests are capped at 60,000 bytes, without a separate response-byte ceiling.
- Unknown usage stops subsequent inference and remains a branch-persistent stop. Refused sketch and judge attempts are recorded with their arm and `dispatch-refused`, distinct from missing provider accounting. They retain the conservative accounting stop even when nothing was sent. Per-arm sketch costs reconcile the transport records with the extension journal.
- A live run stops before the next call once known coding and sketch catalog cost plus judge reservations reaches $30 across its arms. Local fixtures use $3. Judge calls reserve the price of the provider's documented 64,000-input-token maximum, assuming the provider honors that maximum. This is not a hard dollar cap. One coding or sketch response can cross it. Pi 0.87.1 does not serialize the sketch's requested 4,096 output tokens as a provider cap. Catalog cost is not a subscription charge.
- Live runs use a long-task profile: late, large evictions that leave short tasks untouched. Capacity is 256,000 estimated tokens, matching where default Pi compacts on Sol's 272,000-token window, with a 4,096-token output reserve and 1,024-token margin. The high mark is 100,000 tokens and the low mark is 32,000. Rebalancing packs to 24,000, leaving 8,000 tokens of headroom for restoration. Ranking allows 16 Jev requests of up to 120,000 bytes per decision. Round 1 showed why: on short tasks, each eviction's cache miss cost more than the cached input it saved.
- Local fixtures keep the short profile: a 180,000-token limit and transport ceiling, a 24,576-token high mark, a 20,000-token low mark and 4,000 tokens of headroom. These settings are development parameters, not calibrated defaults.
- A passing patch does not make an interrupted trajectory complete. Missing or inconsistent native grader artifacts stay unknown. Empty patches are reported unresolved by the benchmark definition, explicitly not executed.

Local modes `--local-invalid-usage`, `--local-sketch-invalid-usage`, `--local-judge-failure` and `--local-request-cap` exercise usage, provider and request-limit stops. Invalid sketch usage targets the selector after control completes and blocks subsequent coding and Jev dispatch. `--local-judge-invalid` returns a malformed answer with valid usage to exercise a known-cost deferral without changing the coding request. The normal local mode uses deliberately pressured synthetic usage and scripted scores to retire and restore a real read in both arms without rereading. These fixtures verify integration, not live relevance or savings.
