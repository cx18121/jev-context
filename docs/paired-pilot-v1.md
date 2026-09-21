# Paired task-state Jev pilot

Jev changed its scores in the expected direction for all 16 tested relevance changes. It ranked relevant evidence above irrelevant evidence in all 20 applicable comparisons. However, an explicitly excluded webhook document scored 0.57 to 0.67. This supports task-sensitive ranking on these examples, not reliable removal decisions or improved coding outcomes.

## Protocol and evidence

- Run began on 2026-09-21 at 20:52:22 UTC from clean commit `4d09a89ea920254bf415defb744740594ac05338`.
- Six paired synthetic histories, each evaluated before and after a user instruction, repeated twice. All 24 starts have matching successful results and reported usage. No retries or additional calls occurred.
- Candidate questions, including observation text and identity, were identical within each pair. The task state gained a user instruction. The protected latest observation's capture timestamp also shifted with that insertion.
- Three pairs switched the requested target. Two added a requirement while preserving the original requirement. A temporary-detour pair retained its original labels. Expectations were reviewed before inference and excluded from model input.
- Model `jev-1.13.0`, prompt `unfinished-task-v1`, endpoint `https://api.typesafe.ai/v1/systemone`. Neither model nor prompt changed from the first pilot.
- The existing history, candidate selection, state builder, and HTTP client were used. No coding agent ran, no observations were actually retired or restored, and no real user session was sent.
- Local evidence is in `results/paired-v1/manifest.json`, `attempts.jsonl`, and `report.json`. These are private, Git-ignored artifacts, not an automatically backed-up archive.
- SHA-256 of the exact manifest is `89c157cc582535aa5e55eaa247890167a32d9cf438c057d3cb6668e0c9f8d04b`. Its hash and all 24 request/result identities were checked against the journal.

## Scores across task changes

Each score cell contains the first and second repeat. The arrow separates the before and after task states. Relevance expectations refer to the authored task, not a measured effect on agent success.

| Pair and observation | Expected relevance | Before → after scores |
| --- | --- | --- |
| CSV, Atlas contract | Relevant → irrelevant | 0.95, 0.95 → 0.09, 0.09 |
| CSV, Boreal contract | Irrelevant → relevant | 0.11, 0.12 → 0.95, 0.95 |
| API decoder, command-line contract | Irrelevant → relevant | 0.42, 0.43 → 0.94, 0.94 |
| API decoder, mobile contract | Relevant → irrelevant | 0.95, 0.95 → 0.09, 0.10 |
| Rollback fixture, prior retry configuration | Irrelevant → relevant | 0.30, 0.28 → 0.89, 0.91 |
| Rollback fixture, current retry configuration | Relevant → irrelevant | 0.89, 0.88 → 0.26, 0.25 |
| Historical comparison, current upload policy | Stays relevant | 0.91, 0.91 → 0.92, 0.92 |
| Historical comparison, prior upload policy | Irrelevant → relevant | 0.11, 0.10 → 0.92, 0.92 |
| Added consumer, audit contract | Stays relevant | 0.94, 0.94 → 0.94, 0.94 |
| Added consumer, analytics contract | Irrelevant → relevant | 0.18, 0.17 → 0.94, 0.93 |
| Temporary detour, outbound webhook contract | Stays irrelevant | 0.67, 0.66 → 0.61, 0.57 |
| Temporary detour, inbound verification contract | Stays relevant | 0.93, 0.93 → 0.93, 0.94 |

All 16 expected score changes had the correct sign, with absolute changes of at least 0.51. These are eight candidate transitions evaluated twice, not 16 independent tasks. The eight unchanged-label comparisons are controls and are not counted as direction successes.

All 20 relevant-versus-irrelevant comparisons ranked correctly, with no ties. Four calls had two relevant candidates and therefore no ranking comparison. The relevant candidate occupied each position equally across the ten rankable states before repetition.

The largest absolute difference between repeats was 0.04. Two repeats do not establish stability or independent model execution, and they do not rule out provider caching.

## Hypothetical retirement

These offline counts cover 28 relevant and 20 irrelevant judgments. They apply only the strict rule `score < cutoff`, not the full budget policy.

| Diagnostic cutoff | Relevant observations below cutoff | Irrelevant observations retained |
| --- | --- | --- |
| 0.1 | 0 of 28 | 17 of 20 |
| 0.2 | 0 of 28 | 10 of 20 |
| 0.5 | 0 of 28 | 4 of 20 |

At 0.2, half the irrelevant judgments would remain visible. At 0.5, the four outbound-webhook judgments would still remain visible. That document describes a related signing protocol, but the user explicitly excludes the outbound sender from the inbound-verification task. The model's high scores may reflect topical overlap or perceived reference value; this run does not establish the cause.

A retirement policy might retain too much evidence to fit the budget even when its ranking is correct. This pilot did not execute that outcome. Raising the cutoff to remove these examples would be tuning on development data, not evidence of a safe default. No cutoff was selected.

## Usage and latency

The service reported 35,462 input tokens and 1,200 output tokens. At the recorded price of $0.042 per million input tokens with free output, the estimated API cost was **$0.001489404**, below the $0.064512 reservation and $0.10 approved estimated allowance. This is not a reconciled provider charge. No calls had unknown usage or cost.

Measured HTTP-call latency ranged from 137 to 541 ms, with a median of 169 ms. These small sequential requests do not establish latency for long histories or concurrent sessions.

## Interpretation and next step

The same evidence received substantially different scores when the task changed. Historical evidence also became highly rated when a comparison newly required it. That supports further work on automatic reconsideration of retired evidence, but does not prove the manager can find and restore it. Both states here supplied every candidate directly to Jev.

The fixtures remain small, synthetic, and unusually explicit about exclusions and corrections. They are not held-out evaluation data. This pilot does not test dependency search, large-history state construction, adversarial robustness, cache behavior, coding accuracy, or net cost savings.

The next useful implementation is a locally tested reconsideration path, with a fixed candidate scope and explicit budget behavior. Its design must address how retired evidence becomes eligible again without repeatedly judging the entire history. The webhook false positives should remain a regression case for later prompt or policy work. Further paid runs need their own approved protocol; this campaign is complete and must not be expanded or overwritten.
