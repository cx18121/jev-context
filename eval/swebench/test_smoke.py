import copy
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from eval.bundle import make_bundle, runtime_files
from eval.swebench.smoke import ROOT, INSTANCE, BASE, agent_input, member, validate_grade, verify_agent_artifacts


def grade_fixture(resolved):
    tests = {"FAIL_TO_PASS": {"success": ["fixed"] if resolved else [], "failure": [] if resolved else ["fixed"]},
             "PASS_TO_PASS": {"success": ["stable"], "failure": []}}
    report = {INSTANCE: {"resolved": resolved, "infra_failure": False, "patch_exists": True,
                         "patch_successfully_applied": True, "tests_status": tests}}
    summary = {"error_ids": [], "empty_patch_ids": [], "incomplete_ids": [], "infra_failure_ids": [],
               "ambiguous_failure_ids": [], "completed_ids": [INSTANCE], "resolved_ids": [INSTANCE] if resolved else []}
    return report, summary


class SmokeTests(unittest.TestCase):
    def test_only_problem_statement_reaches_agent(self):
        row = {"instance_id": INSTANCE, "base_commit": BASE, "repo": "sympy/sympy", "problem_statement": "Problem",
               "patch": "secret solution", "test_patch": "hidden tests", "eval_script": "grader"}
        self.assertEqual(agent_input(row), "Problem")
        with self.assertRaises(ValueError):
            agent_input({**row, "base_commit": "wrong"})

    def test_membership_uses_native_original_id(self):
        csv = f"bench,instance_id,original_inst_id\nVerified,renamed,{INSTANCE}\n".encode()
        self.assertEqual(member(csv)["instance_id"], "renamed")
        for invalid in [csv.replace(b"Verified", b"Pro"), csv.replace(b"renamed", INSTANCE.encode()).replace(INSTANCE.encode() + b"\n", b"other\n")]:
            with self.assertRaises(ValueError):
                member(invalid)

    def test_grade_requires_tests_not_exit_success_or_unresolved_alone(self):
        for resolved in (True, False):
            report, summary = grade_fixture(resolved)
            self.assertEqual(validate_grade(report, summary, resolved)["resolved"], resolved)
            for field, value in [("infra_failure", True), ("patch_successfully_applied", False), ("patch_exists", False)]:
                bad = copy.deepcopy(report)
                bad[INSTANCE][field] = value
                with self.assertRaises(ValueError):
                    validate_grade(bad, summary, resolved)
            for group in ("FAIL_TO_PASS", "PASS_TO_PASS"):
                bad = copy.deepcopy(report)
                bad[INSTANCE]["tests_status"][group] = {"success": [], "failure": []}
                with self.assertRaises(ValueError):
                    validate_grade(bad, summary, resolved)
            for key in ("error_ids", "empty_patch_ids", "incomplete_ids", "infra_failure_ids", "ambiguous_failure_ids"):
                with self.assertRaises(ValueError):
                    validate_grade(report, {**summary, key: [INSTANCE]}, resolved)

    def test_bundle_has_no_evaluator_data_or_other_benchmark_solution(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / "agent.tar.gz"
            hashes = make_bundle(ROOT, bundle, runtime_files(ROOT) + ["eval/swebench/driver.ts"])
            with tarfile.open(bundle) as archive:
                self.assertEqual(set(archive.getnames()), set(hashes))
            self.assertIn("eval/swebench/driver.ts", hashes)
            self.assertIn("eval/scripted-pi.ts", hashes)
            self.assertFalse(any(name.startswith((".env", "results/", "test/", "eval/harbor/")) or name.endswith(".py") for name in hashes))

    def test_artifact_verifier_rejects_missing_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sessions").mkdir()
            (root / "sessions/session.jsonl").write_text("{}\n")
            (root / "usage.json").write_text(json.dumps({"failure": None, "modelCalls": 3, "actualModelCostUsd": 0}))
            (root / "requests.jsonl").write_text("{}\n" * 3)
            span = {"file": "sympy/__init__.py", "start": 1, "end": 40}
            captures = [{"evidence": []}, *[{"evidence": [{"visible": True, "mapping": {"span": span}}]} for _ in range(2)]]
            (root / "captures.jsonl").write_text("\n".join(map(json.dumps, captures)))
            self.assertEqual(verify_agent_artifacts(root)["mappedReadLines"], 40)
            captures[2]["evidence"] = []
            (root / "captures.jsonl").write_text("\n".join(map(json.dumps, captures)))
            with self.assertRaises(ValueError):
                verify_agent_artifacts(root)


if __name__ == "__main__":
    unittest.main()
