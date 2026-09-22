"""One pinned ContextBench member, native SWE-bench grading, no paid inference."""
import argparse
import csv
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import urllib.request
import uuid

from eval.bundle import make_bundle, runtime_files

ROOT = Path(__file__).resolve().parents[2]
SWE_VERSION = "5.0.2"
DATASET = "SWE-bench/SWE-bench_Verified"
DATASET_REVISION = "78f471bf655a3137b2e8a75af1501690ec009ec3"
CONTEXTBENCH_REVISION = "1436c28a8eb95496da4ea69ad458b9f8a8eb7d61"
INSTANCE = "sympy__sympy-13551"
BASE = "9476425b9e34363c2d9ac38e9f04aa75ae54a775"
IMAGE = "swebench/sweb.eval.x86_64.sympy_1776_sympy-13551@sha256:fbedc1f2698e3d205eb1abcd43a4f1d2f38d6b8a40909a925eaa0a17342c56a7"
NODE = "22.22.3"
REMOTE = "/installed-agent/jev"
MEMBERSHIP_URL = f"https://raw.githubusercontent.com/EuniAI/ContextBench/{CONTEXTBENCH_REVISION}/data/selected_500_instances.csv"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save(path: Path, value) -> None:
    with path.open("x") as file:
        json.dump(value, file, indent=2)
        file.write("\n")


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def member(csv_bytes: bytes) -> dict:
    matches = [r for r in csv.DictReader(io.StringIO(csv_bytes.decode()))
               if r["original_inst_id"] == INSTANCE and r["bench"] == "Verified"]
    if len(matches) != 1:
        raise ValueError("Pinned ContextBench membership missing or ambiguous")
    return matches[0]


def agent_input(row: dict) -> str:
    if row["instance_id"] != INSTANCE or row["base_commit"] != BASE or row["repo"] != "sympy/sympy":
        raise ValueError("Unexpected native task identity")
    return row["problem_statement"]


def validate_grade(report: dict, summary: dict, expected: bool) -> dict:
    result = report[INSTANCE]
    if (result.get("resolved") is not expected or result.get("infra_failure") is not False
            or result.get("patch_exists") is not True or result.get("patch_successfully_applied") is not True):
        raise ValueError("Native control has wrong outcome or failed before testing")
    for key in ("error_ids", "empty_patch_ids", "incomplete_ids", "infra_failure_ids", "ambiguous_failure_ids"):
        if summary.get(key) != []:
            raise ValueError(f"Native grading is incomplete or ambiguous: {key}")
    if summary.get("completed_ids") != [INSTANCE] or summary.get("resolved_ids") != ([INSTANCE] if expected else []):
        raise ValueError("Native summary disagrees with control")
    tests = result["tests_status"]
    for group in ("FAIL_TO_PASS", "PASS_TO_PASS"):
        if not tests[group]["success"] and not tests[group]["failure"]:
            raise ValueError(f"Native grader did not observe {group} tests")
    if tests["PASS_TO_PASS"]["failure"] or bool(tests["FAIL_TO_PASS"]["failure"]) == expected:
        raise ValueError("Control did not have the expected F2P/P2P behavior")
    return {"resolved": expected, "tests": tests}


class Commands:
    def __init__(self, root: Path):
        self.root, self.count = root, 0

    def run(self, args: list[str], *, timeout=300, check=True) -> subprocess.CompletedProcess:
        self.count += 1
        prefix = self.root / f"command-{self.count:02}"
        save(prefix.with_suffix(".json"), {"argv": args, "cwd": str(self.root), "timeoutSeconds": timeout})
        env = {**os.environ, "PYTHON_DOTENV_DISABLED": "1"}
        with prefix.with_suffix(".stdout").open("xb") as out, prefix.with_suffix(".stderr").open("xb") as err:
            process = subprocess.Popen(args, cwd=self.root, env=env, stdout=out, stderr=err, start_new_session=True)
            try:
                code = process.wait(timeout=timeout)
            except BaseException:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise
        result = subprocess.CompletedProcess(args, code, prefix.with_suffix(".stdout").read_bytes(), prefix.with_suffix(".stderr").read_bytes())
        if check and code:
            raise RuntimeError(f"Command failed ({code}); inspect {prefix}.stderr")
        return result


def grade(commands: Commands, dataset: Path, predictions: str, model: str, run_id: str, expected: bool) -> dict:
    name = f"sweb.eval.{INSTANCE}.{run_id}"
    try:
        commands.run([sys.executable, "-I", "-m", "swebench.harness.run_evaluation",
                      "--dataset_name", str(dataset), "--predictions_path", predictions,
                      "--instance_ids", INSTANCE, "--run_id", run_id, "--max_workers", "1",
                      "--timeout", "1800", "--report_dir", str(commands.root)], timeout=2100)
        logs = commands.root / "logs/run_evaluation" / run_id / model / INSTANCE
        for filename in ("report.json", "test_output.txt", "run_instance.log", "patch.diff", "eval.sh"):
            if not (logs / filename).is_file():
                raise ValueError(f"Missing native grader artifact: {filename}")
        return validate_grade(json.loads((logs / "report.json").read_text()),
                              json.loads((commands.root / f"{model}.{run_id}.json").read_text()), expected)
    finally:
        commands.run(["docker", "rm", "-f", name], check=False)


def verify_agent_artifacts(path: Path) -> dict:
    usage = json.loads((path / "usage.json").read_text())
    captures = [json.loads(line) for line in (path / "captures.jsonl").read_text().splitlines()]
    requests = (path / "requests.jsonl").read_text().splitlines()
    if usage["failure"] is not None or usage["modelCalls"] != 3 or usage["actualModelCostUsd"] != 0:
        raise ValueError("Scripted Pi did not finish cleanly")
    if len(captures) != 3 or len(requests) != 3 or not list((path / "sessions").glob("*.jsonl")):
        raise ValueError("Pi native session or transport captures missing")
    if captures[0]["evidence"]:
        raise ValueError("Unexpected evidence before the scripted read")
    for capture in captures[1:]:
        if not any(item["visible"] and item["mapping"].get("span") == {"file": "sympy/__init__.py", "start": 1, "end": 40}
                   for item in capture["evidence"]):
            raise ValueError("Native read did not map to the actual visible request")
    return {"modelCalls": 3, "mappedReadLines": 40, "actualModelCostUsd": 0}


def smoke(output: Path) -> None:
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    os.umask(0o077)
    output.mkdir(parents=True, exist_ok=False)
    commands = Commands(output)
    manifest = {"kind": "scripted-native-grader-controls", "swebenchVersion": SWE_VERSION,
                "dataset": DATASET, "datasetRevision": DATASET_REVISION, "contextbenchRevision": CONTEXTBENCH_REVISION,
                "instanceId": INSTANCE, "excludedFromHeldOut": [INSTANCE], "image": IMAGE, "nodeVersion": NODE,
                "actualModelCostUsd": 0, "goldContextScoring": "not-run"}
    save(output / "manifest.json", manifest)
    try:
        if importlib.metadata.version("swebench") != SWE_VERSION:
            raise ValueError("Use the pinned SWE-bench runtime")
        # SWE-bench imports dotenv. This must be set before importing its modules.
        from dotenv.main import _load_dotenv_disabled
        if not _load_dotenv_disabled():
            raise ValueError("dotenv suppression is required")
        from datasets import load_dataset
        membership = fetch(MEMBERSHIP_URL)
        membership_row = member(membership)
        (output / "membership.csv").write_bytes(membership)
        rows = load_dataset(DATASET, split="test", revision=DATASET_REVISION)
        row = next(r for r in rows if r["instance_id"] == INSTANCE)
        instruction = agent_input(row)
        row["image"] = IMAGE
        dataset = output / "evaluator-only-dataset.json"
        save(dataset, [row])
        save(output / "sources.json", {"membershipSha256": digest(membership), "membership": membership_row,
                                      "datasetSha256": digest(dataset.read_bytes())})
        commands.run(["docker", "pull", "--platform", "linux/amd64", IMAGE], timeout=900)
        run = uuid.uuid4().hex[:12]
        gold = grade(commands, dataset, "gold", "gold", f"jev-{run}-gold", True)
        print("Verified native gold resolved=true", flush=True)

        bundle = output / "agent.tar.gz"
        hashes = make_bundle(ROOT, bundle, runtime_files(ROOT) + ["eval/swebench/driver.ts"])
        save(output / "bundle.json", hashes)
        instruction_path = output / "instruction.txt"
        instruction_path.write_text(instruction)
        node_name = f"node-v{NODE}-linux-x64.tar.xz"
        node_url = f"https://nodejs.org/dist/v{NODE}/"
        checksums = fetch(node_url + "SHASUMS256.txt").decode().splitlines()
        expected = next(line.split()[0] for line in checksums if line.split()[-1] == node_name)
        node = fetch(node_url + node_name)
        if digest(node) != expected:
            raise ValueError("Node archive checksum mismatch")
        (output / node_name).write_bytes(node)
        save(output / "node.json", {"url": node_url + node_name, "sha256": expected})
        container = f"jev-native-{run}"
        created = False
        try:
            commands.run(["docker", "run", "--platform", "linux/amd64", "-d", "--name", container,
                          "--user", "root", "--workdir", "/testbed", IMAGE, "tail", "-f", "/dev/null"])
            created = True
            def shell(command, timeout=300):
                return commands.run(["docker", "exec", container, "bash", "-lc", command], timeout=timeout)
            shell(f"set -e; git diff --exit-code {BASE} --; mkdir -p {REMOTE} /opt/jev-node")
            for local, remote in [(bundle, "/tmp/jev-agent.tar.gz"), (output / node_name, "/tmp/jev-node.tar.xz"),
                                  (instruction_path, f"{REMOTE}/instruction.txt")]:
                commands.run(["docker", "cp", str(local), f"{container}:{remote}"])
            shell(f"set -e; tar -xzf /tmp/jev-agent.tar.gz -C {REMOTE}; tar -xJf /tmp/jev-node.tar.xz -C /opt/jev-node --strip-components=1; "
                  f"export PATH=/opt/jev-node/bin:$PATH; cd {REMOTE}; node --version; npm ci --ignore-scripts --no-audit --no-fund", timeout=600)
            try:
                shell(f"export PATH=/opt/jev-node/bin:$PATH; node --import {REMOTE}/node_modules/tsx/dist/loader.mjs "
                      f"{REMOTE}/eval/swebench/driver.ts /testbed /tmp/jev-artifacts {REMOTE}/instruction.txt {BASE}", timeout=300)
            finally:
                commands.run(["docker", "cp", f"{container}:/tmp/jev-artifacts", str(output / "agent")], check=False)
            agent = verify_agent_artifacts(output / "agent")
            patch = shell("git diff --binary HEAD --").stdout.decode()
            if not patch.strip():
                raise ValueError("Pi produced no patch; this cannot be a negative grading control")
            (output / "pi.patch").write_text(patch)
        finally:
            if created:
                commands.run(["docker", "rm", "-f", container], check=False)
        predictions = output / "predictions.jsonl"
        predictions.write_text(json.dumps({"instance_id": INSTANCE, "model_name_or_path": "pi-scripted", "model_patch": patch}) + "\n")
        negative = grade(commands, dataset, str(predictions), "pi-scripted", f"jev-{run}-pi", False)
        print("Verified native Pi negative resolved=false", flush=True)
        save(output / "result.json", {"status": "verified", "gold": gold, "piNegative": negative, "agent": agent,
                                      "claim": "native integration controls only, not agent accuracy or context-policy benefit"})
    except BaseException as error:
        save(output / "failure.json", {"type": type(error).__name__, "message": str(error)})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "results/contextbench-native-smoke-v1")
    smoke(parser.parse_args().output.resolve())
