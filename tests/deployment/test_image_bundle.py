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

    def make(self, provider=False, mutate_tar=None, ai=False):
        names = bundle.names(SHA, provider, ai=ai) if ai else bundle.names(SHA, provider)
        entries = [{"Config": "config-%d.json" % index, "RepoTags": [name], "Layers": ["layer-%d.tar" % index]}
                   for index, name in enumerate(names)]
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
        for index, name in enumerate(names):
            row = self.rows[index % 2]
            value = bundle.identity(row, SHA)
            records.append({"name": name, "origin_image_id": row["Id"], "identity": value,
                "fingerprint": hashlib.sha256(bundle.canonical(value).encode()).hexdigest()})
        manifest = {"schema_version": bundle.VERSION, "release_sha": SHA, "platform": "linux/amd64", "market_provider": provider,
                    "archive_bytes": len(raw), "archive_sha256": hashlib.sha256(raw).hexdigest(), "images": records}
        if ai:
            manifest.update(schema_version=bundle.AI_VERSION, ai_explanation=True)
        self.manifest(manifest)
        return manifest

    def manifest(self, value):
        self.write(self.directory / bundle.MANIFEST, (bundle.canonical(value) + "\n").encode())

    def test_nested_compressed_layer_budget_counts_expansion_without_extraction(self):
        path = self.directory / 'nested.tar.gz'
        raw = gzip.compress(b'x' * 200000, mtime=0)
        with tarfile.open(path, 'w:gz') as archive:
            for name, value in [('blobs/layer', raw), ('config.json', b'{}')]:
                member = tarfile.TarInfo(name); member.size = len(value)
                archive.addfile(member, io.BytesIO(value))
        result = bundle.archive_budget(path)
        self.assertEqual(result, {'outer_payload_bytes': len(raw) + 2, 'expanded_payload_bytes': 200002})
        self.assertFalse((self.directory / 'blobs').exists())
        with self.assertRaises(ValueError): bundle.archive_budget(path, maximum=100000)

    def test_invalid_nested_compression_and_links_cannot_create_an_upload_budget(self):
        path = self.directory / 'invalid.tar.gz'
        for raw in (b'\x1f\x8bbroken', b'\x28\xb5\x2f\xfdunsupported', gzip.compress(b'payload')[:-4], gzip.compress(b'a') + gzip.compress(b'b')):
            with tarfile.open(path, 'w:gz') as archive:
                member = tarfile.TarInfo('layer'); member.size = len(raw)
                archive.addfile(member, io.BytesIO(raw))
            with self.assertRaises((ValueError, bundle.zlib.error)): bundle.archive_budget(path)
        with tarfile.open(path, 'w:gz') as archive:
            member = tarfile.TarInfo('link'); member.type = tarfile.SYMTYPE; member.linkname = '/never-read'
            archive.addfile(member)
        with self.assertRaises(ValueError): bundle.archive_budget(path)

    def test_upload_budget_binds_both_archives_without_daemon_or_filesystem_mutation(self):
        manifest = self.make()
        source = self.directory / 'source.tar.gz'
        with tarfile.open(source, 'w:gz') as archive:
            member = tarfile.TarInfo('source.txt'); member.size = 3
            archive.addfile(member, io.BytesIO(b'abc'))
        source.chmod(0o600)
        before = {p.name: bundle.file_hash(p) for p in self.directory.iterdir()}
        with patch.object(bundle, 'docker') as daemon:
            report = bundle.upload_budget(self.directory, SHA, False, source)
        daemon.assert_not_called()
        value = report['budget']
        self.assertEqual(value['image_archive_sha256'], manifest['archive_sha256'])
        self.assertEqual(value['source_archive_sha256'], bundle.file_hash(source))
        self.assertEqual(value['source_expanded_bytes'], 3)
        self.assertEqual(json.loads(bundle.base64.b64decode(report['budget_base64'])), value)
        self.assertEqual(before, {p.name: bundle.file_hash(p) for p in self.directory.iterdir()})
        source.chmod(0o644)
        with self.assertRaises(ValueError): bundle.upload_budget(self.directory, SHA, False, source)

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

    def test_ai_inventory_is_explicit_and_keeps_disabled_v1_bundles_unchanged(self):
        for provider in (False, True):
            for ai in (False, True):
                value = self.make(provider, ai=ai)
                self.assertEqual(bundle.read_bundle(self.directory, SHA, provider, ai=ai), value)
                self.assertEqual(value["schema_version"], bundle.AI_VERSION if ai else bundle.VERSION)
                self.assertEqual("ai_explanation" in value, ai)
                self.assertEqual(len(value["images"]), 2 + provider + ai)
                with patch.object(bundle, "docker") as daemon, self.assertRaises(ValueError):
                    bundle.load_or_verify(self.directory, SHA, provider, True, ai=not ai)
                daemon.assert_not_called()

    def test_ai_build_pairs_do_not_substitute_the_provider_dockerfile_and_reject_non_boolean_flags(self):
        expected = [("etf-workbench-web:" + SHA, "Dockerfile.web"), ("etf-workbench-worker:" + SHA, "Dockerfile")]
        self.assertEqual(bundle.image_specs(SHA, False, True), [*expected, ("etf-workbench-ai-explanation:" + SHA, "Dockerfile.ai-explanation")])
        for provider in (False, True):
            specs = bundle.image_specs(SHA, provider, True)
            self.assertEqual([name for name, unused in specs], bundle.names(SHA, provider, True))
            self.assertEqual(len(specs), 3 + provider)
        for value in (0, 1, None, "true"):
            with self.assertRaises(ValueError): bundle.names(SHA, False, value)
            with self.assertRaises(ValueError): bundle.names(SHA, value, True)

    def test_ai_v2_flag_schema_and_resealed_secret_or_platform_changes_fail_before_docker(self):
        for change in (lambda value: value.update(ai_explanation=False), lambda value: value.update(ai_explanation=1),
                       lambda value: value.pop("ai_explanation"), lambda value: value.update(schema_version=bundle.VERSION),
                       lambda value: value.update(extra=True)):
            value = self.make(ai=True); change(value); self.manifest(value)
            with patch.object(bundle, "docker") as daemon, self.assertRaises(ValueError):
                bundle.load_or_verify(self.directory, SHA, False, True, ai=True)
            daemon.assert_not_called()
        for change in (lambda row: row["identity"].update(platform="linux/arm64"),
                       lambda row: row["identity"]["runtime_config"]["Env"].append("AI_API_KEY=FICTIONAL-NOT-A-CREDENTIAL")):
            value = self.make(ai=True); target = value["images"][-1]; change(target)
            target["fingerprint"] = hashlib.sha256(bundle.canonical(target["identity"]).encode()).hexdigest(); self.manifest(value)
            with patch.object(bundle, "docker") as daemon, self.assertRaises(ValueError):
                bundle.load_or_verify(self.directory, SHA, False, True, ai=True)
            daemon.assert_not_called()

    def test_ai_load_verifies_all_three_or_four_portable_runtime_identities(self):
        for provider in (False, True):
            value = self.make(provider, ai=True)
            rows = [deepcopy(self.rows[index % 2]) for index in range(3 + provider)]
            for row in rows: row["Id"] = "sha256:" + "e" * 64
            calls = []
            def daemon(arguments):
                calls.append(arguments)
                if arguments[0] == "version": return b"linux/amd64\n"
                if arguments[:2] == ["image", "load"]: return b"Loaded image\n"
                return json.dumps(rows).encode()
            with patch.object(bundle, "docker", side_effect=daemon):
                result = bundle.load_or_verify(self.directory, SHA, provider, True, ai=True)
            self.assertEqual(result["image_count"], 3 + provider)
            self.assertEqual(calls[-1][2:], bundle.names(SHA, provider, True))
            self.assertEqual(result["runtime_fingerprints"], [row["fingerprint"] for row in value["images"]])

    def test_ai_package_retains_private_bounded_archives_and_exact_opt_in_names(self):
        self.make(ai=True)
        with gzip.open(self.directory / bundle.ARCHIVE, "rb") as source: tar = source.read()
        output = self.directory / "ai-packed"
        class Process:
            def __init__(self): self.stdout = io.BytesIO(tar)
            def poll(self): return 0
            def wait(self, timeout=None): return 0
            def kill(self): raise AssertionError("completed fixture should not be killed")
        rows = [self.rows[index % 2] for index in range(3)]
        def daemon(arguments): return b"linux/amd64\n" if arguments[0] == "version" else json.dumps(rows).encode()
        old = os.umask(0o077)
        try:
            with patch.object(bundle, "docker", side_effect=daemon), patch.object(bundle.subprocess, "Popen", return_value=Process()) as save:
                result = bundle.package(output, SHA, False, ai=True)
            self.assertEqual(result["image_count"], 3)
            self.assertEqual(save.call_args.args[0][-3:], bundle.names(SHA, False, True))
            self.assertEqual(bundle.read_bundle(output, SHA, False, ai=True)["schema_version"], bundle.AI_VERSION)
        finally: os.umask(old)


if __name__ == "__main__": unittest.main()
