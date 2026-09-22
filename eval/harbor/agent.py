"""Harbor owns the sandbox and verifier; this adapter installs our isolated Pi frontend."""
import json
import shlex
import tempfile
from pathlib import Path
from typing import Literal

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from eval.bundle import make_bundle as pack_bundle, runtime_files

ROOT = Path(__file__).resolve().parents[2]
REMOTE = "/installed-agent/jev"
NODE = "22.22.3"


def make_bundle(root: Path, destination: Path) -> dict[str, str]:
    return pack_bundle(root, destination, runtime_files(root) + ["eval/harbor/driver.ts", "eval/harbor/script.ts"])


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
