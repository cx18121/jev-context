# Long-Horizon Terminal-Bench runs

These scripts run [Long-Horizon Terminal-Bench](https://github.com/zli12321/LHTB) (LHTB) tasks through the same Pi runner as the SWE-bench tasks, one arm per process, so arms can run in parallel.

```sh
# Freeze tasks from a pinned LHTB checkout. Offline, CPU-only tasks only.
uv run --no-project --python 3.13 python eval/lhtb/prepare.py LHTB_CHECKOUT results/NEW_ROUND/tasks TASK...

# Check grading with the reference solution, then run one arm.
uv run --no-project --python 3.13 python eval/lhtb/oracle.py results/NEW_ROUND/tasks/TASK results/NEW_ROUND/oracle/TASK
node --import tsx eval/swebench/run.mjs --live results/NEW_ROUND/tasks/TASK/agent.json results/NEW_ROUND/TASK/ARM --arms=ARM

# Grade each arm's committed final container with the task's verifier.
uv run --no-project --python 3.13 python eval/lhtb/grade.py results/NEW_ROUND/tasks/TASK results/NEW_ROUND/TASK/ARM...
```

`--local --arms=ARM` smoke-tests an LHTB task with scripted responses.

## Differences from SWE-bench runs

- The agent starts in the image's `WORKDIR` (for example `/app` or `/workspace`) with the task's CPU and memory limits and no network.
- A command that exceeds 120 seconds returns exit 124 or 137 to the agent instead of ending the arm. The run deadline aborts the agent but keeps the container, so partial work can still be graded.
- Each arm has 95 minutes and 400 coding requests, with a $22 soft catalog stop. Responses may stream up to 16 MB, because a single file-writing tool call can exceed the SWE-bench 512 KB ceiling once SSE framing is included. The official LHTB harness uses a 90-minute budget per task.
- The runner commits the final container as `jev-lhtb-final:*`. The grader clears any `/logs/verifier` left in that image, copies the verifier into a fresh container, and accepts only a finite reward from 0 to 1 written by that run. Final images are kept as evidence unless `--remove-images` is passed. Verifier inputs never enter the agent's run.
- When the agent stops early, it receives a neutral reminder to keep working until its time budget ends, up to 60 times. LHTB's own harness does this with verifier feedback; this runner never exposes the verifier, so scores are not comparable with the official leaderboard. Without the reminder, even tasks designed to be long ended after 5 to 7 minutes in a canary.
- Requests may take up to 5 minutes. New requests stop about 5.5 minutes before the deadline, so an arm ends on its budget with complete accounting rather than an aborted request. Each arm records `endReason`: `model-stop`, `budget`, `hard-deadline` or `error`.
