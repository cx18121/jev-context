"""Fetch one pinned task and prove its unchanged verifier rejects/accepts scripted Pi output."""
import hashlib
import importlib.metadata
import json
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
REVISION = "7131e4375048a0e408a8fb404b5f499d726b695b"
TASK = "log-summary-date-ranges"
FILES = ["instruction.md", "task.toml", "environment/Dockerfile", "environment/log_generator_deterministic.py", "tests/test.sh", "tests/test_outputs.py"]


def main() -> None:
    if importlib.metadata.version("harbor") != "0.23.0":
        raise RuntimeError("This protocol requires Harbor 0.23.0")
    (ROOT / "results").mkdir(exist_ok=True)
    directory = ROOT / "results/harbor-smoke-v1"
    directory.mkdir(mode=0o700)  # Never overwrite or resume a campaign.
    task = directory / "task" / TASK
    hashes = {}
    for name in FILES:
        url = f"https://raw.githubusercontent.com/harbor-framework/terminal-bench-2-1/{REVISION}/tasks/{TASK}/{name}"
        with urlopen(url, timeout=30) as response:
            content = response.read()
        path = task / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        hashes[name] = hashlib.sha256(content).hexdigest()
    with urlopen(f"https://raw.githubusercontent.com/harbor-framework/terminal-bench-2-1/{REVISION}/LICENSE", timeout=30) as response:
        (directory / "TASK-LICENSE").write_bytes(response.read())
    manifest = {
        "kind": "scripted-integration-smoke-not-model-evaluation", "harbor": "0.23.0",
        "python": sys.version, "pi": "0.85.1", "node": "22.22.3", "task": TASK,
        "taskRevision": REVISION, "taskFiles": hashes,
        "source": {"head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                   "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip())},
        "paidModelCalls": 0, "modes": ["wrong", "correct"],
        "limits": "Known task and scripted solution. Not held-out, not agent quality, not selection benefit. Network used for installation. Base image and verifier dependencies are upstream-defined, not fully hermetic.",
    }
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    results = []
    for mode, expected in [("wrong", 0), ("correct", 1)]:
        command = [sys.executable, "-c", "from harbor.cli.main import app; app()", "run",
                   "--path", str(task), "--agent", "eval.harbor.agent:JevSmoke", "--agent-kwarg", f"mode={mode}",
                   "--jobs-dir", str(directory / "jobs"), "--job-name", mode,
                   "--n-concurrent", "1", "--n-attempts", "1", "--max-retries", "0", "--force-build", "--delete",
                   "--artifact", "/app/summary.csv"]
        print(f"Running {mode} scripted trial", flush=True)
        with (directory / f"{mode}.log").open("w") as log:
            subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
        paths = list((directory / "jobs" / mode).glob("*/result.json"))
        if len(paths) != 1:
            raise RuntimeError(f"Expected one trial result, found {len(paths)}")
        result = json.loads(paths[0].read_text())
        if result["exception_info"] is not None:
            raise RuntimeError(f"Harbor trial failed: {result['exception_info']}")
        reward = result["verifier_result"]["rewards"]["reward"]
        if reward != expected:
            raise RuntimeError(f"{mode} reward {reward} differs from {expected}")
        artifacts = paths[0].parent / "agent/jev"
        usage = json.loads((artifacts / "usage.json").read_text())
        if usage["failure"] is not None or usage["modelCalls"] != 2 or len(usage["records"]) != 2:
            raise RuntimeError("Missing successful Pi integration evidence")
        if not list((artifacts / "sessions").glob("*.jsonl")):
            raise RuntimeError("Missing native Pi session")
        results.append({"mode": mode, "reward": reward, "trial": str(paths[0].relative_to(directory)),
                        "modelCalls": usage["modelCalls"], "usageKind": usage["measurementKind"]})
        print(f"Verified {mode} reward={reward}, native session and usage exported", flush=True)
    (directory / "report.json").write_text(json.dumps({"manifestHash": hashlib.sha256((directory / "manifest.json").read_bytes()).hexdigest(), "trials": results}, indent=2) + "\n")
    print(f"Smoke complete: {directory}")


if __name__ == "__main__":
    main()
