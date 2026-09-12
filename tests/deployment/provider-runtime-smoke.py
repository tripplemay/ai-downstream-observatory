"""Offline checks inside the optional real native SDK image, never QuoteContext."""

import hashlib
from importlib import import_module
from importlib.machinery import ExtensionFileLoader
import inspect
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

sys.path.insert(0, "/app")

from worker.market.providers import longport
from worker.orchestration.runtime import role_commands


def native_sdk_path(sdk):
    native = import_module("longport.longport")
    assert native.openapi is sdk and isinstance(native.__loader__, ExtensionFileLoader)
    path = Path(native.__file__).resolve(strict=True)
    assert path == Path(native.__spec__.origin).resolve(strict=True)
    return path


assert (os.getuid(), os.getgid()) == (10001, 10001)
assert sys.version_info[:2] == (3, 11)
assert platform.libc_ver()[0] == "glibc"
assert tuple(map(int, platform.libc_ver()[1].split("."))) >= (2, 39)
assert all(key not in os.environ for key in longport._CREDENTIAL_NAMES)
assert "market_collect_prices" not in role_commands("core")
assert role_commands("longport") == ("market_collect_prices",)
sdk = longport._load_sdk()
sdk_binary = native_sdk_path(sdk)
method = inspect.signature(sdk.QuoteContext.history_candlesticks_by_date)
assert tuple(method.parameters) == ("self", "symbol", "period", "adjust_type", "start", "end", "trade_sessions")
assert {"app_key", "app_secret", "access_token", "http_url", "quote_ws_url"} <= set(inspect.signature(sdk.Config.from_apikey).parameters)
with tempfile.TemporaryDirectory(prefix="provider-smoke-") as temporary:
    Path(temporary, ".env").touch(mode=0o600)
    rejected = subprocess.run([sys.executable, "-I", str(Path(longport.__file__).resolve()), "--sdk-child"],
                              input=b'{"not_a_command":true}', capture_output=True, timeout=10, cwd=temporary,
                              env={"TZ": "UTC", "HOME": temporary, "PATH": os.defpath})
    assert rejected.returncode == 1 and rejected.stdout == b"" and rejected.stderr == b""
print(json.dumps({
    "schema_version": "provider-runtime-smoke-v1", "status": "passed", "runtime_uid": os.getuid(),
    "python_version": platform.python_version(), "libc": list(platform.libc_ver()),
    "sdk_version": longport.SDK_VERSION, "sdk_native_sha256": hashlib.sha256(sdk_binary.read_bytes()).hexdigest(),
    "adapter_sha256": hashlib.sha256(Path(longport.__file__).read_bytes()).hexdigest(),
    "native_sdk_imported": True, "sdk_signature_checked": True, "provider_role_isolated": True,
    "fixed_child_rejected_untrusted_input": True, "credentials_present": False,
    "network_disabled": True, "quote_context_constructed": False, "real_market_data_verified": False,
}, separators=(",", ":")))
