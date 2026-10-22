"""Build public source off-host; verify bounded image bundles before cutover."""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile


VERSION = "workbench-image-bundle-v1"
ARCHIVE = "release-images.tar.gz"
MANIFEST = "release-images.json"
MAX_ARCHIVE = 4 * 1024 ** 3
MAX_EXPANDED = 8 * 1024 ** 3
MAX_JSON = 1024 ** 2
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
CONFIG_FIELDS = ("User", "Env", "Entrypoint", "Cmd", "WorkingDir", "Labels", "ExposedPorts", "Volumes", "Healthcheck", "StopSignal", "OnBuild", "Shell")


def require(condition):
    if not condition:
        raise ValueError("IMAGE_BUNDLE_INVALID")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda unused: require(False))


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for part in iter(lambda: source.read(1024 ** 2), b""):
            digest.update(part)
    return digest.hexdigest()


def private_file(path, limit):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) & 0o077 == 0)
    require(0 < info.st_size <= limit)
    return info.st_size


def names(release, provider):
    require(re.fullmatch(r"[a-f0-9]{40}", release) is not None and type(provider) is bool)
    return ["etf-workbench-" + service + ":" + release for service in ("web", "worker", *(("market-provider",) if provider else ()))]


def docker(arguments):
    return subprocess.check_output(["docker", *arguments], stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)


def daemon_platform():
    require(docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]).decode().strip() == "linux/amd64")


def identity(row, release):
    require(row["Os"] == "linux" and row["Architecture"] == "amd64" and row.get("Variant", "") in ("", "v1"))
    config = row["Config"]
    require(config["User"] == "10001:10001" and config["Labels"]["org.opencontainers.image.revision"] == release)
    require(all(isinstance(value, str) and "=" in value and not re.search(r"PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APP_KEY", value.split("=", 1)[0], re.I)
                for value in config.get("Env") or []))
    require(row["RootFS"]["Type"] == "layers" and all(DIGEST.fullmatch(value) for value in row["RootFS"]["Layers"]))
    normalized = {}
    for key in CONFIG_FIELDS:
        value = config.get(key)
        normalized[key] = value or ({} if key in ("Labels", "ExposedPorts", "Volumes", "Healthcheck")
                                    else "" if key in ("User", "WorkingDir", "StopSignal") else [])
    if normalized["Healthcheck"]:
        health = normalized["Healthcheck"]
        normalized["Healthcheck"] = {key: health.get(key, 0) for key in ("Interval", "Timeout", "StartPeriod", "StartInterval", "Retries")}
        normalized["Healthcheck"]["Test"] = health.get("Test") or []
    return {"platform": "linux/amd64", "rootfs_layers": row["RootFS"]["Layers"], "runtime_config": normalized}


def inspect(image_names, release):
    rows = strict_json(docker(["image", "inspect", *image_names]))
    require(type(rows) is list and len(rows) == len(image_names))
    result = []
    for name, row in zip(image_names, rows):
        value = identity(row, release)
        require(DIGEST.fullmatch(row["Id"]) is not None)
        result.append({"name": name, "origin_image_id": row["Id"], "identity": value,
                       "fingerprint": hashlib.sha256(canonical(value).encode()).hexdigest()})
    return result


def safe_member(name):
    path = PurePosixPath(name)
    require(name and not path.is_absolute() and ".." not in path.parts and "\\" not in name)
    return str(path)


def archive_tags(path):
    seen, total, manifest = set(), 0, None
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            name = safe_member(member.name)
            require(name not in seen and len(seen) < 10000 and (member.isfile() or member.isdir()))
            seen.add(name)
            total += member.size
            require(0 <= member.size <= MAX_EXPANDED and total <= MAX_EXPANDED)
            if name == "manifest.json":
                require(member.isfile() and 0 < member.size <= MAX_JSON)
                manifest = strict_json(archive.extractfile(member).read(MAX_JSON + 1))
    require(type(manifest) is list and 1 <= len(manifest) <= 3)
    tags = []
    for row in manifest:
        require(type(row) is dict and type(row.get("RepoTags")) is list and len(row["RepoTags"]) == 1)
        require(type(row.get("Config")) is str and safe_member(row["Config"]) in seen)
        require(type(row.get("Layers")) is list and all(safe_member(value) in seen for value in row["Layers"]))
        tags.extend(row["RepoTags"])
    require(all(type(value) is str for value in tags) and len(set(tags)) == len(tags))
    return tags


def read_bundle(directory, release, provider):
    path = directory / MANIFEST
    private_file(path, MAX_JSON)
    manifest = strict_json(path.read_bytes())
    require(set(manifest) == {"schema_version", "release_sha", "platform", "market_provider", "archive_bytes", "archive_sha256", "images"})
    require(manifest["schema_version"] == VERSION and manifest["release_sha"] == release
            and manifest["platform"] == "linux/amd64" and manifest["market_provider"] is provider)
    expected = names(release, provider)
    require(type(manifest["images"]) is list and [row["name"] for row in manifest["images"]] == expected)
    for row in manifest["images"]:
        require(set(row) == {"name", "origin_image_id", "identity", "fingerprint"})
        require(DIGEST.fullmatch(row["origin_image_id"]) is not None)
        require(row["fingerprint"] == hashlib.sha256(canonical(row["identity"]).encode()).hexdigest())
        value = row["identity"]
        require(set(value) == {"platform", "rootfs_layers", "runtime_config"} and value["platform"] == "linux/amd64")
        require(identity({"Os": "linux", "Architecture": "amd64", "Config": value["runtime_config"],
                          "RootFS": {"Type": "layers", "Layers": value["rootfs_layers"]}}, release) == value)
    archive = directory / ARCHIVE
    require(type(manifest["archive_bytes"]) is int and private_file(archive, MAX_ARCHIVE) == manifest["archive_bytes"])
    require(re.fullmatch(r"[a-f0-9]{64}", manifest["archive_sha256"]) is not None and file_hash(archive) == manifest["archive_sha256"])
    require(sorted(archive_tags(archive)) == sorted(expected))
    return manifest


def package(directory, release, provider):
    daemon_platform()
    directory.mkdir(mode=0o700, parents=False)
    rows = inspect(names(release, provider), release)
    archive = directory / ARCHIVE
    with archive.open("xb") as target:
        with gzip.GzipFile(fileobj=target, mode="wb", compresslevel=1, mtime=0) as compressed:
            process = subprocess.Popen(["docker", "image", "save", "--platform", "linux/amd64", *names(release, provider)],
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
            try:
                size = 0
                for part in iter(lambda: process.stdout.read(1024 ** 2), b""):
                    size += len(part)
                    require(size <= MAX_EXPANDED)
                    compressed.write(part)
                require(process.wait(timeout=300) == 0)
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
                process.stdout.close()
    private_file(archive, MAX_ARCHIVE)
    manifest = {"schema_version": VERSION, "release_sha": release, "platform": "linux/amd64", "market_provider": provider,
                "archive_bytes": archive.stat().st_size, "archive_sha256": file_hash(archive), "images": rows}
    with (directory / MANIFEST).open("x") as target:
        target.write(canonical(manifest) + "\n")
    read_bundle(directory, release, provider)
    return {"status": "image_bundle_packaged", "release_sha": release, "archive_bytes": manifest["archive_bytes"],
            "archive_sha256": manifest["archive_sha256"], "image_count": len(rows)}


def load_or_verify(directory, release, provider, load):
    manifest = read_bundle(directory, release, provider)
    daemon_platform()
    if load:
        docker(["image", "load", "--quiet", "--platform", "linux/amd64", "--input", str(directory / ARCHIVE)])
    actual = inspect(names(release, provider), release)
    require(all(row["identity"] == expected["identity"] and row["fingerprint"] == expected["fingerprint"]
                for row, expected in zip(actual, manifest["images"])))
    return {"status": "loaded_images_verified" if load else "images_verified", "release_sha": release,
            "archive_sha256": manifest["archive_sha256"], "runtime_image_ids": [row["origin_image_id"] for row in actual],
            "runtime_fingerprints": [row["fingerprint"] for row in actual], "image_count": len(actual),
            "identity_basis": "uncompressed_layer_diff_ids_and_runtime_configuration_not_backend_specific_image_ids"}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("build", "pack", "load", "verify", "check"))
    parser.add_argument("--release", required=True)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--market-provider", choices=(0, 1), type=int, default=0)
    args = parser.parse_args()
    provider = bool(args.market_provider)
    names(args.release, provider)
    require(args.directory.is_absolute() and not args.directory.is_symlink())
    if args.operation == "build":
        root = Path(__file__).resolve().parent.parent
        require(not args.directory.resolve().is_relative_to(root))
        require(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root).decode().strip() == args.release)
        subprocess.run(["git", "diff", "--exit-code", "HEAD", "--"], cwd=root, check=True, stdout=subprocess.DEVNULL)
        daemon_platform()
        for name, dockerfile in zip(names(args.release, provider), ("Dockerfile.web", "Dockerfile", "Dockerfile.market-provider")):
            subprocess.run(["docker", "build", "--pull", "--platform", "linux/amd64", "--build-arg", "RELEASE_SHA=" + args.release,
                            "--file", dockerfile, "--tag", name, "."], cwd=root, check=True, timeout=1800)
    if args.operation in ("build", "pack"):
        result = package(args.directory, args.release, provider)
    elif args.operation == "check":
        manifest = read_bundle(args.directory, args.release, provider)
        result = {"status": "image_bundle_checked_without_docker", "release_sha": args.release, "archive_sha256": manifest["archive_sha256"]}
    else:
        result = load_or_verify(args.directory, args.release, provider, args.operation == "load")
    print(canonical(result))


if __name__ == "__main__":
    try:
        main()
    except (OSError, EOFError, RecursionError, ValueError, KeyError, TypeError, tarfile.TarError, subprocess.SubprocessError):
        print("RELEASE_IMAGE_BUNDLE_FAILED", file=sys.stderr)
        raise SystemExit(1)
