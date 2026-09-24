"""Exact local source inventory and stale-build rejection shared by every attempt."""

from hashlib import sha256
from pathlib import Path

from worker.orchestration.db import ROOT, content_hash
from .checker import strict_json


EXTRA_FILES = ("web/scripts/governance-fixture.ts", "web/scripts/build-governance-fixture.mjs",
               "web/package.json", "web/package-lock.json", "web/tsconfig.json", "requirements-workbench.txt",
               "scripts/migrate-workbench.mjs", "scripts/verification-source.mjs")
BUNDLE = "web/dist/governance-fixture.mjs"
SIDECAR = "web/dist/governance-fixture.manifest.json"


def _read(root, relative):
    path = root / relative
    component = root
    for name in Path(relative).parts:
        component = component / name
        if component.is_symlink():
            raise ValueError("VERIFICATION_SOURCE_SYMLINK")
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(root) or path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("VERIFICATION_SOURCE_INVALID")
    return path.read_bytes()


def source_manifest(root=ROOT):
    root = Path(root).resolve(strict=True)
    initializer = root / "worker/__init__.py"
    if initializer.exists() or initializer.is_symlink():
        raise ValueError("VERIFICATION_NAMESPACE_INITIALIZER_FORBIDDEN")
    names = []
    def scan(relative, extensions):
        path = root / relative
        if path.is_symlink():
            raise ValueError("VERIFICATION_SOURCE_SYMLINK")
        if not path.exists():
            raise ValueError("VERIFICATION_SOURCE_INVALID")
        if path.is_dir():
            for child in sorted(path.iterdir()):
                scan(relative + "/" + child.name, extensions)
        elif path.is_file() and path.suffix in extensions:
            names.append(relative)
        if len(names) > 4096:
            raise ValueError("VERIFICATION_SOURCE_LIMIT")
    for directory in ("accounting", "market", "orchestration", "performance", "research", "governance_verification"):
        scan("worker/" + directory, (".py",))
    scan("web/src/server", (".ts",))
    scan("contracts", (".json",))
    scan("migrations", (".sql", ".json"))
    names.extend(EXTRA_FILES)
    if len(names) > 4096:
        raise ValueError("VERIFICATION_SOURCE_LIMIT")
    files = {relative: sha256(_read(root, relative)).hexdigest() for relative in sorted(names)}
    sidecar_bytes, bundle_bytes = _read(root, SIDECAR), _read(root, BUNDLE)
    sidecar = strict_json(sidecar_bytes)
    if (not isinstance(sidecar, dict) or set(sidecar) != {"schema_version", "entrypoint", "bundle_sha256", "source_files"}
            or sidecar["schema_version"] != "verification-fixture-build-v2"
            or sidecar["entrypoint"] != "web/scripts/governance-fixture.ts"
            or sidecar["source_files"] != files or sidecar["bundle_sha256"] != sha256(bundle_bytes).hexdigest()):
        raise ValueError("VERIFICATION_STALE_FIXTURE_BUILD")
    files[BUNDLE], files[SIDECAR] = sha256(bundle_bytes).hexdigest(), sha256(sidecar_bytes).hexdigest()
    return {"schema_version": "verification-source-v2", "files": files}


def verify_context(context, portfolio_id, check_id, context_hash, *, verify_source=True):
    if (not isinstance(context, dict) or set(context) != {"schema_version", "portfolio_id", "check_id", "suite_version", "source_manifest", "source_manifest_hash"}
            or context["schema_version"] != "verification-context-v2" or context["portfolio_id"] != portfolio_id
            or context["check_id"] != check_id or check_id != "E-02.cash-contribution-neutrality.v1"
            or context["suite_version"] != "cash-contribution-neutrality-v1"
            or content_hash(context) != context_hash or content_hash(context["source_manifest"]) != context["source_manifest_hash"]):
        raise ValueError("VERIFICATION_CONTEXT_INVALID")
    if verify_source and context["source_manifest"] != source_manifest():
        raise ValueError("VERIFICATION_SOURCE_CONTEXT_CHANGED")
