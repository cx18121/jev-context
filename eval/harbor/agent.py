"""Harbor owns the sandbox and verifier; this adapter installs our isolated Pi frontend."""
import hashlib
import json
import shlex
import tarfile
import tempfile
from pathlib import Path
from typing import Literal

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

ROOT = Path(__file__).resolve().parents[2]
REMOTE = "/installed-agent/jev"
NODE = "22.22.3"


def bundle_files(root: Path) -> list[Path]:
    files = [root / "package.json", root / "package-lock.json", *sorted((root / "src").glob("*.ts")),
             root / "eval/harbor/driver.ts", root / "eval/harbor/script.ts"]
    for path in files:
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Invalid bundle file: {path}")
    return files


def make_bundle(root: Path, destination: Path) -> dict[str, str]:
    hashes = {}
    with tarfile.open(destination, "w:gz") as archive:
        for path in bundle_files(root):
            name = path.relative_to(root).as_posix()
            archive.add(path, arcname=name, recursive=False)
            hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


class SmokeOptions(InstalledAgentOptions):
    mode: Literal["correct", "wrong", "budget-stop", "http-error"] = "correct"


class JevSmoke(BaseInstalledAgent):
    options_model = SmokeOptions
    options: SmokeOptions

    @staticmethod
    def name() -> str:
        return "jev-pi-scripted-smoke"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl", "ca_certificates", "tar", "xz"))
        await self.exec_as_agent(environment, command=(
            "set -euo pipefail; "
            "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | env -u NODE_VERSION bash; "
            '. "$HOME/.nvm/nvm.sh"; '
            f"nvm install {NODE}; nvm alias default {NODE}"
        ))
        with tempfile.TemporaryDirectory(prefix="jev-harbor-bundle-") as temporary:
            bundle = Path(temporary) / "agent.tar.gz"
            hashes = make_bundle(ROOT, bundle)
            (self.logs_dir / "bundle.json").write_text(json.dumps(hashes, indent=2) + "\n")
            await environment.upload_file(bundle, "/installed-agent/jev.tar.gz")
        await self.exec_as_root(environment, command=f"mkdir -p {REMOTE}; tar -xzf /installed-agent/jev.tar.gz -C {REMOTE}")
        if environment.default_user is not None:
            await self.exec_as_root(environment, command=f"chown -R {shlex.quote(str(environment.default_user))} {REMOTE}")
        await self.exec_as_agent(environment, command=(
            f'set -euo pipefail; . "$HOME/.nvm/nvm.sh"; cd {REMOTE}; '
            "npm ci --ignore-scripts --no-audit --no-fund"
        ))

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        await self._upload_config_text(environment, content=instruction, remote_path=f"{REMOTE}/instruction.txt", filename="instruction.txt")
        await self.exec_as_agent(environment, command=(
            f'set -euo pipefail; . "$HOME/.nvm/nvm.sh"; '
            f'node --import {REMOTE}/node_modules/tsx/dist/loader.mjs {REMOTE}/eval/harbor/driver.ts '
            f'/app /logs/agent/jev {REMOTE}/instruction.txt {shlex.quote(self.options.mode)}'
        ))

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Scripted usage belongs in its explicitly labeled artifact, not benchmark model metrics.
        path = self.logs_dir / "jev/usage.json"
        if path.exists():
            usage = json.loads(path.read_text())
            if usage["measurementKind"] != "scripted-fixture":
                raise ValueError("Unexpected smoke usage source")
            context.cost_usd = 0.0
