# Harbor integration smoke v1

The benchmark integration passed. Harbor's unchanged verifier rejected a deliberately wrong answer and accepted a correct answer computed through Pi's tool loop.

| Trial | Verifier reward | Verifier tests passed | Scripted model requests |
|---|---:|---:|---:|
| Wrong answer, CSV header only | 0 | 1 of 2 | 2 |
| Correct answer, computed from logs | 1 | 2 of 2 | 2 |

Both trials ran inside Docker through Harbor 0.23.0, Node 22.22.3, Pi SDK 0.85.1, and the context extension's oldest-first policy. Native compaction was disabled. Neither trial required retirement. The model endpoint was scripted and local to the container. There were no paid model calls.

Both trials exported native Pi sessions, request and event logs, two extension usage records, the generated CSV, and verifier reports. Neither reported a Harbor exception, frontend failure, or extension error. All four outgoing requests passed the budget gate. Harbor's model token fields stayed null rather than inheriting synthetic usage; model cost was zero.

## Provenance

- Runner source was clean at `4e52619a14436d66f96787ecf2a3841617efa9e6`.
- Task was Terminal-Bench 2.1's `log-summary-date-ranges`, pinned to `7131e4375048a0e408a8fb404b5f499d726b695b`.
- Local artifacts are in `results/harbor-smoke-v1/`. They are Git-ignored and not automatically backed up.
- Manifest SHA-256 is `7cb03b7f165697df965d45037634483b871a93c89037364770aaad36505d67a7`.
- The manifest digest, downloaded task hashes, and both uploaded source manifests were checked after execution and matched.

The local typecheck, four frontend tests, and five adapter tests also passed. Frontend tests cover budget rejection before dispatch and a model HTTP failure. Review caught invalid Harbor dependency keys before the Docker run; a targeted regression test covers the fix.

## Limits

This proves that the integration executes and grades a task, not that a coding model can solve it or that context selection improves accuracy or cost. The task, solution, and verifier were inspected during development. Exclude this task from held-out quality evaluation.

The run does not exercise Jev, retirement under pressure, automatic restoration, live cache behavior, or billing. Installation requires network access. The task's upstream base image and verifier dependencies are not fully pinned transitively. The successful platform was macOS with Docker; other host permission models remain untested.
