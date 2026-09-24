"""Bounded fixed child execution with no inherited credential environment."""

import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import time


def clean_environment(home):
    node = shutil.which("node")
    if node is None:
        raise ValueError("VERIFICATION_NODE_UNAVAILABLE")
    return {"PATH": str(Path(node).parent) + os.pathsep + "/usr/bin:/bin", "HOME": str(home),
            "TMPDIR": str(home), "TMP": str(home), "TEMP": str(home),
            "LANG": "C.UTF-8", "TZ": "UTC", "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"}


def bounded_process(argv, *, environment, cwd, health=None, timeout=60, output_limit=1024 * 1024, new_session=True):
    started = time.monotonic()
    process = subprocess.Popen(argv, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False, start_new_session=new_session)
    selector = selectors.DefaultSelector()
    streams = {"stdout": bytearray(), "stderr": bytearray()}
    for pipe, name in ((process.stdout, "stdout"), (process.stderr, "stderr")):
        os.set_blocking(pipe.fileno(), False)
        selector.register(pipe, selectors.EVENT_READ, name)
    try:
        while selector.get_map() or process.poll() is None:
            if health is not None:
                health()
            if time.monotonic() - started >= timeout:
                raise ValueError("VERIFICATION_PROCESS_TIMEOUT")
            for key, _ in selector.select(0.05):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    streams[key.data].extend(chunk)
                    if sum(len(value) for value in streams.values()) > output_limit:
                        raise ValueError("VERIFICATION_PROCESS_OUTPUT_LIMIT")
        if health is not None:
            health()
        if process.returncode != 0:
            raise ValueError("VERIFICATION_PROCESS_FAILED:" + str(process.returncode))
        return bytes(streams["stdout"]), bytes(streams["stderr"])
    finally:
        selector.close()
        if new_session:
            # Also stop descendants after the direct child exits or loses its lease.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        elif process.poll() is None:
            process.kill()
        process.wait()
        process.stdout.close()
        process.stderr.close()
