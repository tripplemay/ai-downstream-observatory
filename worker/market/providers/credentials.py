"""Traditional API credentials; no shell evaluation or implicit file lookup."""

import os
from pathlib import Path
import stat

from worker.orchestration.db import WorkbenchError


_FIELDS = ("APP_KEY", "APP_SECRET", "ACCESS_TOKEN")
_NAMESPACES = tuple(tuple(prefix + field for field in _FIELDS)
                    for prefix in ("LONGPORT_", "LONGBRIDGE_"))
CREDENTIAL_ENV_NAMES = tuple(name for names in _NAMESPACES for name in names)
MAX_CREDENTIAL_FILE_BYTES = 32 * 1024
MAX_CREDENTIAL_BYTES = 8192


def credentials_from_environment(environment):
    """Exactly one complete namespace, without combining or modifying env."""
    present = [names for names in _NAMESPACES if any(name in environment for name in names)]
    if len(present) > 1:
        raise WorkbenchError("LONGPORT_CREDENTIALS_NAMESPACE_CONFLICT")
    if not present or any(name not in environment for name in present[0]):
        raise WorkbenchError("LONGPORT_CREDENTIALS_REQUIRED")
    values = [environment[name] for name in present[0]]
    if any(not isinstance(value, str) or not value or len(value) > MAX_CREDENTIAL_BYTES
           or any(not 33 <= ord(char) <= 126 for char in value) for value in values):
        raise WorkbenchError("LONGPORT_CREDENTIALS_INVALID")
    return dict(zip(("app_key", "app_secret", "access_token"), values))


def read_private_credentials_file(value):
    """Absolute owner-only regular file. Values stay in memory, never argv."""
    descriptor = None
    try:
        path = Path(value)
        if not path.is_absolute():
            raise WorkbenchError("LONGPORT_PRIVATE_CREDENTIALS_FILE_REQUIRED")
        # Reject symlinks before opening; O_NOFOLLOW also closes the leaf race.
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode):
            raise WorkbenchError("LONGPORT_PRIVATE_CREDENTIALS_FILE_REQUIRED")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or stat.S_IMODE(info.st_mode) & 0o077 or info.st_nlink != 1
                or (info.st_dev, info.st_ino) != (before.st_dev, before.st_ino)):
            raise WorkbenchError("LONGPORT_PRIVATE_CREDENTIALS_FILE_REQUIRED")
        if not 1 <= info.st_size <= MAX_CREDENTIAL_FILE_BYTES:
            raise WorkbenchError("LONGPORT_CREDENTIALS_FILE_SIZE_INVALID")
        chunks, size = [], 0
        while size <= MAX_CREDENTIAL_FILE_BYTES:
            chunk = os.read(descriptor, min(8192, MAX_CREDENTIAL_FILE_BYTES + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        if size > MAX_CREDENTIAL_FILE_BYTES:
            raise WorkbenchError("LONGPORT_CREDENTIALS_FILE_SIZE_INVALID")
        environment = {}
        for line in b"".join(chunks).decode("utf-8").split("\n"):
            if line.endswith("\r"):
                line = line[:-1]
            if not line or line.startswith("#"):
                continue
            name, separator, secret = line.partition("=")
            if not separator or name not in CREDENTIAL_ENV_NAMES or name in environment:
                raise WorkbenchError("LONGPORT_CREDENTIALS_FILE_FORMAT_INVALID")
            environment[name] = secret
        return credentials_from_environment(environment)
    except WorkbenchError:
        raise
    except (OSError, TypeError, ValueError, UnicodeError):
        raise WorkbenchError("LONGPORT_PRIVATE_CREDENTIALS_FILE_REQUIRED") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
