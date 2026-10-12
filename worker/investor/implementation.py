"""Reproduction identity, not a source/data licensing attestation."""

from hashlib import sha256

from worker.orchestration.db import ROOT, content_hash
from worker.research.registry import implementation_manifest as research_manifest


def implementation_hash():
    files = [*sorted((ROOT / "worker/investor").glob("*.py")), *sorted((ROOT / "contracts/v1").glob("investor-*.schema.json"))]
    return content_hash({"research": research_manifest(), "investor_sources": {
        str(path.relative_to(ROOT)): sha256(path.read_bytes()).hexdigest() for path in files}})
