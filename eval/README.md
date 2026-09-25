# Evaluation

Run commands from the repository root. Local fixtures establish integration behavior, not coding quality or savings. Paid runs require a separately chosen task set and spending limits. Keep generated requests, sessions, source snapshots, and evaluator data under Git-ignored `results/`.

## Paired coding tasks

The [native task runner](swebench/README.md) runs control and selector trajectories, grades their patches with SWE-bench, and measures mapped ContextBench source coverage. It is the main path for live development comparisons.

## Offline diagnostics

```sh
npm run eval:retrieval
npm run eval:contextbench
```

These use authored fixtures without credentials, Docker, or paid calls. Retrieval diagnostic v2 measures the first capture-order page. It distinguishes matches outside that page from observations with no lexical match. It does not measure eventual exploration recall or task-sketch quality. The ContextBench fixture demonstrates a source read being retired and restored in the visible view. Neither command reports an official benchmark score.

## Historical experiments

The [experiment reports](../docs/experiments/README.md) retain their original results and limitations. The synthetic pilot belongs to commit `7cbc9d6dac2793b79306a6bd8a79194bb90431a9`; the paired task-state pilot belongs to `4d09a89ea920254bf415defb744740594ac05338`. Their executable protocols remain in Git history and are no longer current npm commands.

Local artifacts under `results/` remain private and ignored. Keep the manifest and journal with any report derived from a campaign. Do not remove artifacts to rerun or resume an interrupted paid experiment. Historical approvals and cost estimates do not authorize new spending.

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
