import asyncio
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from eval.harbor.agent import ROOT, JevSmoke, SmokeOptions, make_bundle


class AdapterTests(unittest.TestCase):
    def test_install_uses_harbor_dependency_keys(self):
        class ReachedInstaller(Exception):
            pass

        async def check_dependencies(environment, dependencies):
            self.assertTrue(set(dependencies) <= JevSmoke.SYSTEM_PACKAGES.keys())

        async def stop_before_network(*args, **kwargs):
            raise ReachedInstaller()

        adapter = SimpleNamespace(ensure_system_dependencies=check_dependencies, exec_as_agent=stop_before_network)
        with self.assertRaises(ReachedInstaller):
            asyncio.run(JevSmoke.install(adapter, None))

    def test_allowlist_excludes_secrets_and_benchmark_answers(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / "bundle.tar.gz"
            hashes = make_bundle(ROOT, bundle)
            with tarfile.open(bundle) as archive:
                names = archive.getnames()
            self.assertEqual(set(names), set(hashes))
            self.assertIn("src/working-extension.ts", names)
            self.assertIn("eval/harbor/driver.ts", names)
            self.assertTrue(all(name in {"package.json", "package-lock.json", "eval/harbor/driver.ts", "eval/harbor/script.ts", "eval/scripted-pi.ts", "eval/contextbench.ts"} or (name.startswith("src/") and name.endswith(".ts")) for name in names))
            self.assertFalse(any(name.startswith((".env", "results/", "test/", "node_modules/")) for name in names))

    def test_symlink_cannot_expand_upload_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").symlink_to(ROOT / "package.json")
            with self.assertRaisesRegex(ValueError, "Invalid bundle file"):
                make_bundle(root, root / "bundle.tar.gz")

    def test_scripted_tokens_are_not_reported_as_benchmark_model_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            logs = Path(directory)
            (logs / "jev").mkdir()
            (logs / "jev/usage.json").write_text(json.dumps({"measurementKind": "scripted-fixture", "syntheticUsage": {"input": 160}}))
            context = SimpleNamespace(n_input_tokens=None, cost_usd=None)
            JevSmoke.populate_context_post_run(SimpleNamespace(logs_dir=logs), context)
            self.assertIsNone(context.n_input_tokens)
            self.assertEqual(context.cost_usd, 0)

    def test_mode_is_explicit_and_bounded(self):
        with self.assertRaises(ValueError):
            SmokeOptions(mode="live")


if __name__ == "__main__":
    unittest.main()
