"""Synthetic archive/daemon contracts; native save/load remains a separate CI check."""

from copy import deepcopy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("image_bundle", ROOT / "scripts/release-image-bundle.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)
SHA = "a" * 40


def image(seed="b"):
    return {"Id": "sha256:" + seed * 64, "Os": "linux", "Architecture": "amd64",
        "Config": {"User": "10001:10001", "Labels": {"org.opencontainers.image.revision": SHA}, "Env": ["NODE_ENV=production"],
            "Cmd": ["node", "server.js"], "WorkingDir": "/app", "Healthcheck": {"Test": ["CMD", "true"], "Interval": 30000000000}},
        "RootFS": {"Type": "layers", "Layers": ["sha256:" + "c" * 64]}}


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.rows = [image(), image("d")]

    def write(self, path, raw):
        path.write_bytes(raw)
        path.chmod(0o600)

    def make(self, provider=False, mutate_tar=None):
        entries = [{"Config": "config-%d.json" % index, "RepoTags": [name], "Layers": ["layer-%d.tar" % index]}
                   for index, name in enumerate(bundle.names(SHA, provider))]
        records = []
        with io.BytesIO() as buffer:
            with tarfile.open(fileobj=buffer, mode="w") as archive:
                for entry in entries:
                    for name in (entry["Config"], entry["Layers"][0]):
                        raw = b"{}"
                        member = tarfile.TarInfo(name); member.size = len(raw)
                        archive.addfile(member, io.BytesIO(raw))
                raw = json.dumps(entries).encode()
                member = tarfile.TarInfo("manifest.json"); member.size = len(raw)
                archive.addfile(member, io.BytesIO(raw))
                if mutate_tar:
                    mutate_tar(archive)
            raw = gzip.compress(buffer.getvalue(), mtime=0)
        self.write(self.directory / bundle.ARCHIVE, raw)
        for index, name in enumerate(bundle.names(SHA, provider)):
            row = self.rows[index % 2]
            value = bundle.identity(row, SHA)
            records.append({"name": name, "origin_image_id": row["Id"], "identity": value,
                "fingerprint": hashlib.sha256(bundle.canonical(value).encode()).hexdigest()})
        manifest = {"schema_version": bundle.VERSION, "release_sha": SHA, "platform": "linux/amd64", "market_provider": provider,
                    "archive_bytes": len(raw), "archive_sha256": hashlib.sha256(raw).hexdigest(), "images": records}
        self.manifest(manifest)
        return manifest

    def manifest(self, value):
        self.write(self.directory / bundle.MANIFEST, (bundle.canonical(value) + "\n").encode())

    def test_strict_inventory_hash_and_optional_provider(self):
        for provider in (False, True):
            value = self.make(provider)
            self.assertEqual(bundle.read_bundle(self.directory, SHA, provider), value)
            with self.assertRaises(ValueError):
                bundle.read_bundle(self.directory, SHA, not provider)
            with self.assertRaises(ValueError):
                bundle.read_bundle(self.directory, "f" * 40, provider)

    def test_bad_archive_fails_before_any_docker_operation(self):
        self.make()
        self.write(self.directory / bundle.ARCHIVE, b"corrupted")
        with patch.object(bundle, "docker") as daemon, self.assertRaises(ValueError):
            bundle.load_or_verify(self.directory, SHA, False, True)
        daemon.assert_not_called()

    def test_unexpected_tags_duplicate_json_keys_and_mutated_fingerprints_fail_closed(self):
        value = self.make()
        value["images"][0]["name"] = "unrelated:latest"
        self.manifest(value)
        with self.assertRaises(ValueError): bundle.read_bundle(self.directory, SHA, False)
        value = self.make(); value["images"][0]["fingerprint"] = "0" * 64; self.manifest(value)
        with self.assertRaises(ValueError): bundle.read_bundle(self.directory, SHA, False)
        value = self.make(); value["extra"] = True; self.manifest(value)
        with self.assertRaises(ValueError): bundle.read_bundle(self.directory, SHA, False)
        self.write(self.directory / bundle.MANIFEST, b'{"release_sha":"a","release_sha":"b"}')
        with self.assertRaises(ValueError): bundle.read_bundle(self.directory, SHA, False)

    def test_duplicate_traversal_link_and_oversized_archive_members_are_rejected_without_extraction(self):
        def member(name, kind=tarfile.REGTYPE, size=0):
            def add(archive):
                value = tarfile.TarInfo(name); value.type = kind; value.size = size
                if kind == tarfile.SYMTYPE: value.linkname = "/private/never-read"
                archive.addfile(value)
            return add
        for change in (member("../outside"), member("/absolute"), member("manifest.json"),
                       member("link", tarfile.SYMTYPE), member("oversized", size=bundle.MAX_EXPANDED + 1)):
            self.make(mutate_tar=change)
            with self.assertRaises((ValueError, tarfile.TarError)):
                bundle.read_bundle(self.directory, SHA, False)
        self.assertFalse((self.directory.parent / "outside").exists())

    def test_private_file_and_nonlinked_file_requirements(self):
        self.make(); (self.directory / bundle.MANIFEST).chmod(0o644)
        with self.assertRaises(ValueError): bundle.read_bundle(self.directory, SHA, False)
        self.make(); os.link(self.directory / bundle.ARCHIVE, self.directory / "alias")
        with self.assertRaises(ValueError): bundle.read_bundle(self.directory, SHA, False)

    def test_runtime_configuration_and_layer_identity_not_backend_image_id_are_bound(self):
        self.make()
        calls = []
        rows = deepcopy(self.rows)
        for row in rows:
            row["Id"] = "sha256:" + "e" * 64
            row["Config"]["Healthcheck"]["StartInterval"] = 0
        def daemon(arguments):
            calls.append(arguments)
            if arguments[0] == "version": return b"linux/amd64\n"
            if arguments[:2] == ["image", "load"]: return b"Loaded image\n"
            return json.dumps(rows).encode()
        with patch.object(bundle, "docker", side_effect=daemon):
            result = bundle.load_or_verify(self.directory, SHA, False, True)
        self.assertEqual(result["status"], "loaded_images_verified")
        self.assertEqual(calls[1][:5], ["image", "load", "--quiet", "--platform", "linux/amd64"])
        for alter in (lambda row: row["RootFS"]["Layers"].append("sha256:" + "f" * 64),
                      lambda row: row["Config"].update(Cmd=["unexpected"]),
                      lambda row: row["Config"].update(User="0"),
                      lambda row: row.update(Architecture="arm64"),
                      lambda row: row["Config"]["Env"].append("ACCESS_TOKEN=SYNTHETIC-NEVER-EXPORTED")):
            rows = deepcopy(self.rows); alter(rows[0])
            with patch.object(bundle, "docker", side_effect=daemon), self.assertRaises(ValueError):
                bundle.load_or_verify(self.directory, SHA, False, False)

    def test_package_produces_a_private_archive_from_only_the_exact_fixed_image_names(self):
        self.make()
        with gzip.open(self.directory / bundle.ARCHIVE, "rb") as source: tar = source.read()
        output = self.directory / "packed"
        class Process:
            def __init__(self): self.stdout = io.BytesIO(tar)
            def poll(self): return 0
            def wait(self, timeout=None): return 0
            def kill(self): raise AssertionError("completed fixture should not be killed")
        old = os.umask(0o077)
        try:
            def daemon(arguments):
                return b"linux/amd64\n" if arguments[0] == "version" else json.dumps(self.rows).encode()
            with patch.object(bundle, "docker", side_effect=daemon), patch.object(bundle.subprocess, "Popen", return_value=Process()) as save:
                result = bundle.package(output, SHA, False)
            self.assertEqual(result["image_count"], 2)
            self.assertEqual(save.call_args.args[0], ["docker", "image", "save", "--platform", "linux/amd64", *bundle.names(SHA, False)])
            self.assertEqual(bundle.read_bundle(output, SHA, False)["archive_sha256"], result["archive_sha256"])
        finally: os.umask(old)


if __name__ == "__main__": unittest.main()
