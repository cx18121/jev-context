# First synthetic Jev pilot

The live Jev contract worked on all 12 requests. Jev ranked the authored relevant observation above the irrelevant observation in every pair. This is a successful integration check, not evidence of improved coding accuracy or net savings.

## Protocol and evidence

- Run began on 2026-09-21 at 20:22:44 UTC from clean commit `7cbc9d6dac2793b79306a6bd8a79194bb90431a9`.
- Six synthetic development histories, two candidates each, repeated twice with identical request bodies. Expectations were authored before any live call and excluded from model input.
- Model `jev-1.13.0`, prompt `unfinished-task-v1`, endpoint `https://api.typesafe.ai/v1/systemone`.
- Existing history, candidate selection, state builder, and HTTP client were used. No coding agent ran, no context was actually retired, and no real user session was sent.
- No retries, prompt changes, or additional calls. All 12 starts have matching successful results and reported usage.
- Local evidence is in `results/synthetic-v1/manifest.json`, `attempts.jsonl`, and `report.json`. These files are private and ignored by Git. They are not an automatically backed-up archive.
- SHA-256 of the exact manifest file is `cd8d829e9d2366ec7aff9b16b06cacba31846b051503b543f8564794a6f0ac59`.

## Scores

Each cell contains the first and second repeat. Scores are Jev's probability of relevance to the unfinished task, not a demonstrated probability that removal is safe.

| Case | Authored relevant observation | Authored irrelevant observation |
| --- | --- | --- |
| Basic relevance | 0.91, 0.91 | 0.05, 0.05 |
| Unfinished task during detour | 0.92, 0.92 | 0.04, 0.04 |
| Middle-turn correction | 0.90, 0.90 | 0.50, 0.48 |
| Buried dependency | 0.89, 0.89 | 0.03, 0.03 |
| Superseded file read | 0.87, 0.87 | 0.44, 0.40 |
| Instruction-like tool output | 0.91, 0.91 | 0.04, 0.05 |

The largest absolute change between repeats was 0.04. Two repeats are insufficient to characterize stability, and identical scores do not prove independent model executions or absence of provider caching.

## Hypothetical retirement

These are offline counts across 12 relevant and 12 irrelevant judgments. They apply the strict rule `score < cutoff`, not the full context-budget policy.

| Diagnostic cutoff | Relevant observations below cutoff | Irrelevant observations retained |
| --- | --- | --- |
| 0.1 | 0 of 12 | 4 of 12 |
| 0.2 | 0 of 12 | 4 of 12 |
| 0.5 | 0 of 12 | 1 of 12 |

The unresolved selection issue is supersession. In the correction case, the abandoned semicolon specification still scored 0.50 and 0.48. The obsolete retry configuration scored 0.44 and 0.40. Both rank below the useful evidence, but neither is removable under a 0.2 cutoff. A pressure-triggered policy could therefore stop instead of fitting the request. This pilot did not execute that budget outcome.

Raising the cutoff would remove more of this obsolete evidence, but these six cases cannot establish that doing so preserves necessary evidence elsewhere. No default cutoff or prompt change was selected from these results.

## Usage and latency

The service reported 20,190 input tokens and 600 output tokens. At the recorded price of $0.042 per million input tokens with free output, the total estimated API cost is **$0.00084798**. This is a calculation from reported usage, not a reconciled provider charge. All calls had known usage. No paid coding-model or provisioned infrastructure was used.

Measured HTTP-call latency ranged from 148 to 428 ms, with a median of 184 ms. This sample does not establish latency at larger state sizes, under concurrency, or during service load.

## Interpretation and next question

The live endpoint accepted the pinned model, structured state and questions, authentication, and expected response schema. It returned usable per-candidate scores and usage within the local limits for these small requests. The detour, buried detail, and one adversarial example behaved as intended.

The fixtures are deliberately small and easy. Four of six reuse a marketing document as an unrelated example, the relevant candidate comes first in only two cases, and there are no realistic coding trajectories. The positive rankings may partly reflect topic separation rather than reliable decisions about removal. One injection example does not establish injection resistance.

The next useful evidence would distinguish topical relevance from usefulness after a correction or file change. Use a broader set of independently authored examples where the same observation changes relevance across task states, including similar-topic negatives and dependencies between observations. Inspect the labels and state assembly before choosing a prompt or threshold change. Any further paid run needs a separate scope and spending approval.
