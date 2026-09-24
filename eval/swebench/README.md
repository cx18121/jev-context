# Paired native task runner

`run.mjs` runs one task twice through Pi 0.87.1 and Sol medium. Control uses the logging/budget extension without selection. Selector uses `jev-select-v1`. Both have the same prompt, tools, model, and fresh offline container. Native patch grading and ContextBench source coverage use those same trajectories.

Task briefs use `openai-codex/gpt-6-luna` with low reasoning through the same Codex runtime as the coding model. Coding remains Sol 5.6 medium and relevance judgments remain Jev. Briefs have their own cache key, request ledger, guarded transport, catalog cost, and latency. They are requested only when selection needs them, not on every coding turn. They do not appear in coding evidence captures. Private run artifacts include each brief request and its returned text and stop reason, including rejected updates. The transport response-byte ceiling bounds this capture; private reasoning and response headers are not included.

`--live` makes paid inference requests and requires approval of the task and brief-inclusive spending limits before invocation. Local modes exercise the real coding and brief SDK serializers against a loopback HTTP server with scripted responses. No paid inference occurs in local modes. Their usage and resulting costs are synthetic fixtures, not live measurements. Existing artifacts describe their recorded code and protocol.

## Inputs and commands

The runner accepts only an agent-facing JSON object with exactly `instanceId`, `repo`, `baseCommit`, `image`, and `problemStatement`. The image must be a pulled `swebench/sweb.eval.x86_64.*@sha256:...` digest. Gold patches, tests, and annotations are rejected as extra fields. Start Docker first.

```sh
# Scripted inference, actual Docker tools and Pi SDK. No model calls or credentials.
node --import tsx eval/swebench/run.mjs --local agent-task.json results/NEW_LOCAL_RUN

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
- The evaluator snapshots dataset-base regular UTF-8 files through one Git batch process before the first prompt. It does not substitute the prepared image's source for that reference. Symlinks, binaries, files above 1 MiB, and files exceeding the total 32 MiB snapshot allowance are explicitly excluded. The agent and judge never receive the snapshot as extra context.
- Each dispatched coding request records its selected tool text against the current branch and immutable base snapshot. Shell output, modified files, truncated reads, and unavailable source remain unmapped. If a reference span needs unavailable base source, coverage is unknown rather than computed with a smaller denominator. Scores are local lower-bound diagnostics, not official ContextBench metrics.
- Full stateless Codex SSE requests only. Reasoning, IDs, assistant text, and tool-call structure cannot change. No automatic compaction, retries, cache warmup, or resource discovery. Every arm gets a fresh session key. That does not guarantee independent provider caches.
- At most 24 coding requests per arm, 24 brief requests total, and 24 judge calls total. Coding requests have a 90-second deadline, brief requests have 30 seconds, the pair has 40 minutes, and commands have at most 120 seconds. Coding request/response limits are 180,000/512,000 bytes. Brief request/response limits are 40,000/128,000 bytes. Judge requests are capped at 64,000 bytes and use the client's 15-second timeout, without a separate response-byte ceiling. Unknown usage stops subsequent inference. Judge calls reserve the price of the provider's documented 64,000-input-token maximum for the runner's cost stop. This reservation assumes the provider honors that maximum.
- The pair stops before the next call once known coding and brief catalog cost plus judge reservations reaches $3. This is not a hard dollar cap. One coding or brief response can cross it, and Codex has no enforced output limit here. The brief's requested 4,096 output tokens are not serialized as a provider cap by Pi 0.87.1. Catalog cost is not a subscription charge. Hard context accounting is 180,000 bytes plus configured reserve/margin; the soft working target is 24,576 estimated tokens including reserves. These settings are development parameters, not calibrated defaults.
- A passing patch does not make an interrupted trajectory complete. Missing or inconsistent native grader artifacts stay unknown. Empty patches are reported unresolved by the benchmark definition, explicitly not executed.

Local failure modes `--local-invalid-usage`, `--local-brief-invalid-usage`, `--local-judge-failure`, and `--local-request-cap` exercise accounting stops. Unknown brief usage blocks both the following coding dispatch and Jev calls. The normal local mode uses deliberately pressured synthetic usage and scripted scores to retire and restore a real read without rereading. It proves the wiring, not live relevance or savings.
