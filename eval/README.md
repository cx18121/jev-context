# Evaluation

Run commands from the repository root. Local fixtures establish integration behavior, not coding quality or savings. Paid runs require a separately chosen task set and spending limits. Keep generated requests, sessions, source snapshots, and evaluator data under Git-ignored `results/`.

## Paired coding tasks

The [native task runner](swebench/README.md) runs control and selector trajectories, grades their patches with SWE-bench, and measures mapped ContextBench source coverage. It is the main path for live development comparisons.

## Offline diagnostics

```sh
npm run eval:retrieval
npm run eval:contextbench
```

These use authored fixtures without credentials, Docker, or paid calls. Retrieval reports shortlist coverage and known misses. The ContextBench fixture demonstrates a source read being retired and restored in the visible view. Neither command reports an official benchmark score.

## Historical experiments and integration controls

The commands below support the [historical experiment reports](../docs/experiments/README.md) and integration controls. Their fixed output directories are exclusive. Do not remove existing artifacts to silently rerun a paid campaign. Recorded approvals and cost estimates describe those experiments, not authorization for new spending.

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

## Harbor integration smoke

The first benchmark integration uses Terminal-Bench 2.1's `log-summary-date-ranges` task at revision `7131e4375048a0e408a8fb404b5f499d726b695b`. Harbor owns the Docker environment and runs the task's unchanged verifier. An isolated Pi SDK frontend loads our extension and calls a scripted model endpoint on loopback. One trial deliberately writes a wrong answer; another computes the correct answer from the task's logs. The runner requires verifier rewards of 0 and 1 respectively, plus exported native Pi sessions and usage records.

Requires Docker and `uv`. This downloads the pinned task, installs Harbor 0.23.0, and builds the task container. It installs Node 22.22.3 and the npm lockfile dependencies inside the container. It makes no paid model calls and does not load `.env`.

```sh
uv run --no-project --python 3.13 --with harbor==0.23.0 python -m unittest eval.harbor.test_adapter
uv run --no-project --python 3.13 --with harbor==0.23.0 python -m eval.harbor.smoke
```

Artifacts go into the exclusive, Git-ignored `results/harbor-smoke-v1/` directory. Existing campaigns are never overwritten or resumed. The manifest records source revision, task hashes and protocol limits. Each trial exports the upload manifest, requests, events, native sessions, labeled synthetic usage, verifier results, and `summary.csv`. Failed runs leave their logs for inspection.

The adapter uploads only the package manifests, `src/*.ts`, its two frontend files, and the shared scripted Pi runner and evidence mapper. It does not upload local credentials, sessions, tests, or verifier files. Harbor injects the task verifier separately after the agent runs. The adapter reports zero model cost but does not put scripted token counts into Harbor's model metrics. The task's upstream base image and verifier dependencies are not fully pinned transitively, and installation requires network access.

**Evidence boundary.** This is integration plumbing, not a quality evaluation. The task and solution have been inspected and must not enter a held-out set. Neither real coding-model ability, Jev selection, retirement under pressure, restoration, nor savings is tested by this two-turn smoke. Its result does not qualify a benchmark campaign for publication. The frontend's local tests also exercise budget rejection and HTTP failure, requiring failure artifacts and zero or one model requests respectively.

## Native ContextBench task smoke

`eval/swebench/smoke.py` runs two integration controls on `sympy__sympy-13551`, a member of ContextBench's pinned Verified subset. It uses SWE-bench 5.0.2's native grader, not the ContextBench context-metrics evaluator. The reference fix must resolve the task. Separately, Pi reads 40 lines of base source and appends a harmless comment. That nonempty patch must apply, leave the existing passing tests intact, and fail the task's repair tests. Empty patches, grader errors, infrastructure failures and missing reports cannot count as a successful negative control.

```sh
python3 -m unittest eval.swebench.test_smoke
PYTHON_DOTENV_DISABLED=1 uv run --no-project --python 3.13 --with swebench==5.0.2 python -m eval.swebench.smoke
```

The native command requires Docker and `uv`, downloads a roughly 1 GB compressed Linux amd64 image, and installs Node 22.22.3 plus lockfile dependencies inside a separate agent container. On ARM hosts this requires working amd64 emulation. No Docker settings are changed. The dataset revision, ContextBench membership revision, image digest and Node archive checksum are recorded. This does not freeze every dependency fetched by the upstream grader.

The exclusive, Git-ignored `results/contextbench-native-smoke-v1/` contains the manifest, command logs, evaluator-only dataset, native grade reports and test output, Pi patch, session, usage, actual HTTP payloads, immutable base source and line mappings. Use `--output` with a new directory for another intentional attempt. Failure artifacts are kept. Commands have timeouts and the runner removes only its own containers. Images remain cached.

**Observed result.** Both native controls passed on the local ARM Docker host using amd64 emulation. The reference fix passed the one repair test and all 17 existing passing tests. Pi's comment-only patch failed the repair test and preserved all 17 passing tests. Three actual HTTP requests, one native Pi session and the 40-line source mapping were exported. No paid inference was used.

The full task row, reference fix, test patch and grading script stay on the host evaluator side and are never uploaded to Pi. Pi receives only the problem statement, an allowlisted runtime bundle, and the official base environment. Inference is scripted over loopback with isolated credentials and resource loading. Neither `.env` nor host agent configuration is loaded. The mapped read proves capture against real repository source, not useful retrieval. This task is excluded from future held-out evaluation. Neither control tests Jev selection, agent accuracy, savings, or official ContextBench context scores.
