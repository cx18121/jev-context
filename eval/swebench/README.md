# Paired native task runner

`run.mjs` runs one task twice through Pi 0.87.1 and Sol medium. Control uses the logging/budget extension without selection. Selector uses `jev-select-v1`. Both have the same prompt, tools, model, and fresh offline container. Native patch grading and ContextBench source coverage use those same trajectories.

## Inputs and commands

The runner accepts only an agent-facing JSON object with exactly `instanceId`, `repo`, `baseCommit`, `image`, and `problemStatement`. The image must be a pulled `swebench/sweb.eval.x86_64.*@sha256:...` digest. Gold patches, tests, and annotations are rejected as extra fields. Start Docker first.

```sh
# Scripted inference, actual Docker tools and Pi SDK. No model calls or credentials.
node --import tsx eval/swebench/run.mjs --local agent-task.json results/NEW_LOCAL_RUN

# Real inference. Uses stored Codex credentials and TYPESAFE_API_KEY from the root .env.
node --import tsx eval/swebench/run.mjs --live agent-task.json results/NEW_LIVE_RUN

# Evaluator-only inputs enter after the run.
node --import tsx eval/swebench/score.ts results/NEW_LIVE_RUN evaluator-reference.json
PYTHON_DOTENV_DISABLED=1 uv run --no-project --python 3.13 --with swebench==5.0.2 \
  python -I eval/swebench/grade.py results/NEW_LIVE_RUN evaluator-native.json
```

Output directories are exclusive. Never overwrite an interrupted paid run to retry it. Artifacts include opaque reasoning and source and belong under ignored `results/`, not Git. Neither command installs this extension in your daily Pi setup.

`evaluator-reference.json` contains `instanceId`, `baseCommit`, `contextbenchId`, `datasetRevision`, and `spans` with `{file,start,end}`. `evaluator-native.json` is a one-row SWE-bench dataset with the exact executed repository, base, problem statement, and pinned image. Freeze dataset revisions and input hashes with the task-set protocol before live runs. Five development tasks are not statistical or publication evidence.

## Boundaries

- Each arm independently verifies its clean tracked tree against the base commit. Image HEAD may differ if the tracked tree is identical. There are no host mounts or container networking. Cleanup targets only owned containers.
- `read` uses native Pi range selection and footers with container-only content operations. It accepts plain ASCII paths under `/testbed`, caps the complete file at 1 MiB, and treats content as text. Native path resolution performs a metadata-only host existence probe, but may not alter the absolute path. It cannot fall back to host file reads. Bash runs only in the container and is the fallback for unusual paths.
- The evaluator snapshots base-commit regular UTF-8 files before the first prompt. Symlinks, binaries, files above 1 MiB, and files exceeding the total 32 MiB snapshot allowance are explicitly excluded. The agent and judge never receive the snapshot as extra context.
- Each dispatched request records its selected tool text against the current branch and immutable base snapshot. Shell output, modified files, truncated reads, and unavailable source remain unmapped. If a reference span needs unavailable base source, coverage is unknown rather than computed with a smaller denominator. Scores are local lower-bound diagnostics, not official ContextBench metrics.
- Full stateless Codex SSE requests only. Reasoning, IDs, assistant text, and tool-call structure cannot change. No automatic compaction, retries, cache warmup, or resource discovery. Every arm gets a fresh session key. That does not guarantee independent provider caches.
- At most 24 coding requests per arm and 24 judge calls total. Requests have a 90-second deadline, the pair has 40 minutes, and commands have at most 120 seconds. Coding request/response limits are 180,000/512,000 bytes. Judge requests are capped at 64,000 bytes and use the client's 15-second timeout, without a separate response-byte ceiling. Unknown usage stops subsequent inference. Judge calls reserve the price of the provider's documented 64,000-input-token maximum for the runner's cost stop. This reservation assumes the provider honors that maximum.
- The pair stops before the next call once known coding catalog cost plus judge reservations reaches $3. This is not a hard dollar cap. One coding response can cross it, and Codex has no enforced output limit here. Catalog cost is not a subscription charge. Hard context accounting is 180,000 bytes plus configured reserve/margin; the soft working target is 24,576 estimated tokens including reserves. These settings are development parameters, not calibrated defaults.
- A passing patch does not make an interrupted trajectory complete. Missing or inconsistent native grader artifacts stay unknown. Empty patches are reported unresolved by the benchmark definition, explicitly not executed.

Local failure modes `--local-invalid-usage`, `--local-judge-failure`, and `--local-request-cap` exercise accounting stops. The normal local mode uses deliberately pressured synthetic usage and scripted scores to retire and restore a real read without rereading. It proves the wiring, not live relevance or savings.
