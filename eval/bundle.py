"""Explicit source bundles shared by isolated benchmark frontends."""
import hashlib
import tarfile
from pathlib import Path


def bundle_files(root: Path, names: list[str]) -> list[Path]:
    files = [root / name for name in names]
    for path in files:
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Invalid bundle file: {path}")
    return files


def make_bundle(root: Path, destination: Path, names: list[str]) -> dict[str, str]:
    hashes = {}
    with tarfile.open(destination, "w:gz") as archive:
        for path in bundle_files(root, names):
            name = path.relative_to(root).as_posix()
            archive.add(path, arcname=name, recursive=False)
            hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def runtime_files(root: Path) -> list[str]:
    return ["package.json", "package-lock.json", "eval/scripted-pi.ts", "eval/contextbench.ts",
            *[p.relative_to(root).as_posix() for p in sorted((root / "src").glob("*.ts"))]]
